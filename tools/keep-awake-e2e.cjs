'use strict';
// Verifies with `pmset -g assertions` that the production app never leaves a stale power
// assertion: after a normal quit, a crash, or SIGKILL.
// Run with Node: `node tools/keep-awake-e2e.cjs`. It launches Electron with this same file as
// a fixture that loads the production main process against in-memory storage and a fake API.
// Nothing is sent, and no system setting is changed.
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

async function settle(read, done) {
  let value = read();
  for (let attempt = 0; !done(value) && attempt < 50; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    value = read();
  }
  return value;
}

function assertionsFor(pid) {
  return execFileSync('/usr/bin/pmset', ['-g', 'assertions'], { encoding: 'utf8' }).split('\n')
    .filter((line) => line.includes(`pid ${pid}(`)).map((line) => line.trim().replace(/\[0x[0-9a-f]+\] /, '').replace(/ \d\d:\d\d:\d\d /, ' '));
}

async function driver() {
  if (process.platform !== 'darwin') { console.log('Keep-awake E2E skipped: macOS only.'); return; }
  const electronBinary = require('electron');
  const results = [];
  for (const ending of ['quit', 'crash', 'sigkill']) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronBinary, [__filename, '--keep-awake-fixture'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
    try {
      results.push(await exercise(child, ending));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
  console.log(`Keep-awake E2E passed.\n  ${results.join('\n  ')}`);
}

async function exercise(child, ending) {
  let output = '';
  const holding = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Fixture did not take an assertion. Output: ${output}`)), 30_000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = /HOLDING (\d+)/.exec(output);
      if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
    });
    child.on('exit', (code) => reject(new Error(`Fixture exited early (${code}). Output: ${output}`)));
  });
  // powerd can take a moment to list a new assertion.
  const whileRunning = await settle(() => assertionsFor(holding), (lines) => lines.length > 0);
  assert.deepEqual(whileRunning.map((line) => line.split(' ')[2]), ['NoIdleSleepAssertion'], `Expected one idle-sleep assertion, saw ${JSON.stringify(whileRunning)}`);
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve(signal || String(code))));
  if (ending === 'sigkill') child.kill('SIGKILL');
  else child.stdin.write(`${ending}\n`);
  const how = await exited;
  const after = await settle(() => assertionsFor(holding), (lines) => lines.length === 0);
  assert.deepEqual(after, [], `Stale assertion after ${ending}: ${JSON.stringify(after)}`);
  const releasedBeforeExit = /WILL-QUIT (\{.*\})/.exec(output)?.[1];
  if (ending === 'quit') assert.equal(releasedBeforeExit, '{"holding":null,"released":"app-quit"}', 'The app releases its assertion itself before quitting');
  return `${ending}: held ${JSON.stringify(whileRunning)}, exit ${how}, afterwards []${ending === 'quit' ? ', released in will-quit' : ''}`;
}

function fixture() {
  const electron = require('electron');
  const { app } = electron;
  app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 't3-keep-awake-e2e-')));
  const thread = { id: 'thread-e2e', title: 'Keep-awake E2E', projectId: 'project', updatedAt: '2026-09-30T12:00:00.000Z', settledOverride: null, messages: [], session: null };
  const files = new Map([
    ['/fixture/config.json', JSON.stringify({ httpPort: 3773, bufferSeconds: 5, keepAwake: { enabled: true, keepDisplayOn: false, powerSource: 'any', batteryFloorPercent: 0, maxHours: 2, includeRunningAgents: false } })],
    ['/fixture/jobs.json', JSON.stringify({ version: 2, jobs: [{ id: 'e2e', commandId: 'command', messageId: 'message', threadId: thread.id, threadTitle: thread.title, message: 'Continue', scheduleAt: new Date(Date.now() + 3_600_000).toISOString(), status: 'pending', bufferSeconds: 5, createdAt: new Date().toISOString() }] })]
  ]);
  const fakeFs = {
    readFileSync(name) { if (!files.has(name)) throw Object.assign(new Error('Missing fixture'), { code: 'ENOENT' }); return files.get(name); },
    mkdirSync() {}, writeFileSync(name, value) { files.set(name, value); }, renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); }
  };
  const apiModule = require(path.join(root, 'lib/api-client'));
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST') throw new Error('Dispatch is prohibited in the keep-awake fixture.');
    return new Response(JSON.stringify(url.includes('/threads/') ? { thread } : { threads: [thread], projects: [] }), { headers: { 'content-type': 'application/json' } });
  };
  const handlers = {};
  const appProxy = new Proxy(app, { get(target, property) {
    if (property === 'requestSingleInstanceLock') return () => true;
    if (property === 'getPath') return (name) => name === 'userData' ? '/fixture' : target.getPath(name);
    const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const HiddenWindow = class BrowserWindow extends electron.BrowserWindow {
    constructor(options) { super({ ...options, show: false }); }
    show() {} focus() {}
  };
  const injected = {
    ...electron, app: appProxy, BrowserWindow: HiddenWindow,
    ipcMain: { handle: (name, handler) => { handlers[name] = handler; electron.ipcMain.handle(name, handler); } },
    Tray: class { setToolTip() {} setImage() {} on() {} setContextMenu() {} },
    Menu: { buildFromTemplate: (value) => value }, Notification: { isSupported: () => false }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), {
    require(name) {
      if (name === 'electron') return injected;
      if (name === 'node:fs') return fakeFs;
      if (name === 'node-schedule') return { scheduleJob: () => ({ cancel() {} }) };
      if (name === './lib/api-client') return { ...apiModule, createApiClient: (options) => apiModule.createApiClient({ ...options, fetchImpl }) };
      return name.startsWith('./lib/') ? require(path.join(root, name)) : require(name);
    }, __dirname: root, process: { env: { T3_TOKEN: 'fixture-only' }, pid: process.pid }, console, Buffer
  }, { filename: 'main.js' });
  // Registered after main.js, so it runs after the app's own will-quit handler.
  app.on('will-quit', () => {
    const { holding, lastRelease } = handlers['keep-awake:get']();
    process.stdout.write(`WILL-QUIT ${JSON.stringify({ holding, released: lastRelease?.reason })}\n`);
  });
  app.whenReady().then(async () => {
    app.dock?.hide();
    const deadline = Date.now() + 20_000;
    while (!handlers['keep-awake:get'] || !handlers['keep-awake:get']().holding) {
      if (Date.now() > deadline) throw new Error(`Keep-awake never held an assertion: ${JSON.stringify(handlers['keep-awake:get']?.())}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    process.stdout.write(`HOLDING ${process.pid}\n`);
    process.stdin.on('data', (chunk) => {
      const command = String(chunk).trim();
      if (command === 'quit') app.quit();
      if (command === 'crash') process.crash();
    });
  }).catch((error) => { console.error(error.stack); app.exit(1); });
}

if (process.argv.includes('--keep-awake-fixture')) fixture();
else driver().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
