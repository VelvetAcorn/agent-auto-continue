'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function appHarness(initialJobs = [], { ownsInstance = true, rawJobs, extraHarnesses, env = { T3_TOKEN: 'test-secret' } } = {}) {
  const handlers = {}, files = new Map(), events = [], windows = [];
  let trayMenu, failWrite = false;
  let ready, response = () => new Response('<!doctype html><html>test-secret</html>', { headers: { 'content-type': 'text/html' } });
  files.set('/fixture/jobs.json', rawJobs ?? JSON.stringify(initialJobs));
  class Window {
    static getAllWindows() { return windows; }
    constructor(options) {
      this.options = options; this.listeners = {}; this.loaded = false; windows.push(this);
      this.webContents = { send: (...args) => events.push(args), once: (name, callback) => { this.listeners[name] = callback; } };
    }
    finishLoad() { this.loaded = true; this.listeners['did-finish-load']?.(); }
    removeMenu() {} loadFile(file) { this.file = file; } on() {} focus() {} isDestroyed() { return false; }
  }
  const electron = {
    app: { requestSingleInstanceLock: () => ownsInstance, quit() {}, on() {}, whenReady: () => ({ then: fn => { ready = fn; } }), getPath: () => '/fixture', getLoginItemSettings: () => ({ openAtLogin: false }) },
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, BrowserWindow: Window,
    Menu: { buildFromTemplate: value => value }, Notification: { isSupported: () => false },
    Tray: class { setToolTip() {} on() {} setContextMenu(menu) { trayMenu = menu; } },
    nativeImage: { createFromDataURL: () => ({ setTemplateImage() {} }) }, powerMonitor: { on() {} }
  };
  const fakeFs = { readFileSync: name => { if (!files.has(name)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(name); }, mkdirSync() {}, writeFileSync: (name, value) => { if (failWrite) throw new Error('Disk full'); files.set(name, value); }, renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); } };
  const apiModule = require('../lib/api-client');
  const harnessModule = require('../lib/harnesses');
  const context = { require: name => name === 'electron' ? electron : name === 'node:fs' ? fakeFs : name === 'node-schedule' ? { scheduleJob: () => ({ cancel() {} }) } : name === './lib/api-client' ? { ...apiModule, createApiClient: options => apiModule.createApiClient({ ...options, fetchImpl: (...args) => response(...args) }) } : name === './lib/harnesses' && extraHarnesses ? { ...harnessModule, createHarnesses: options => harnessModule.createHarnessRegistry([require('../lib/harnesses/t3').createT3Harness({ api: options.api }), ...extraHarnesses(options)]) } : name.startsWith('./lib/') ? require(path.join(__dirname, '..', name)) : require(name), __dirname: path.join(__dirname, '..'), process: { env, pid: 123 }, console, Buffer };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), context);
  ready();
  return { invoke: (name, ...args) => handlers[name]({}, ...args), setResponse: fn => { response = fn; }, files, events, windows, setWriteFailure: value => { failWrite = value; }, get trayMenu() { return trayMenu; } };
}

test('dashboard IPC shows friendly HTML error and acknowledgment clears historical alert after restart', async () => {
  const job = { id: 'job', commandId: 'command', messageId: 'message', threadId: 'thread', message: 'Continue', scheduleAt: '2026-01-01T00:00:00Z', status: 'failed', note: 'Unexpected token \'<\', "<!doctype "... is not valid JSON' };
  const app = appHarness([job]);
  const state = await app.invoke('dashboard:threads');
  assert.equal(state.online, false);
  assert.match(state.error, /webpage/);
  assert.doesNotMatch(state.failedJobs[0].note, /Unexpected token|doctype/);
  assert.doesNotMatch(JSON.stringify(state), /test-secret/);
  const checked = await app.invoke('connection:check');
  assert.equal(checked.error.code, 'unexpected_response_format');
  app.invoke('jobs:acknowledge', 'job');
  assert.equal((await app.invoke('dashboard:threads')).failedJobs.length, 0);
  const restarted = appHarness(JSON.parse(app.files.get('/fixture/jobs.json')));
  assert.equal((await restarted.invoke('dashboard:threads')).failedJobs.length, 0);
  assert.equal(restarted.invoke('jobs:list', { view: 'history' }).jobs.length, 1);
});

test('IPC create/edit/cancel and settings preserve per-job buffer with no live server', async () => {
  const app = appHarness();
  app.setResponse(async url => new Response(JSON.stringify(url.includes('/threads/') ? { thread: { id: 'thread', title: 'Test', messages: [], projectId: 'p' } } : { threads: [], projects: [] }), { headers: { 'content-type': 'application/json' } }));
  const input = { threadId: 'thread', message: 'Continue', whenISO: new Date(Date.now() + 120_000).toISOString(), timeZone: 'UTC' };
  const job = await app.invoke('schedule:create', input);
  app.invoke('settings:save', { httpPort: 3773, bufferSeconds: 60 });
  const edited = app.invoke('jobs:edit', job.id, { ...input, message: 'Proceed' });
  assert.equal(edited.bufferSeconds, 5);
  assert.equal(app.invoke('jobs:list', { view: 'upcoming' }).total, 1);
  app.invoke('jobs:cancel', job.id);
  assert.equal(app.invoke('jobs:list', { view: 'upcoming' }).total, 0);
  assert.equal(app.invoke('jobs:list', { view: 'history' }).jobs[0].status, 'canceled');
});

test('preload exposes narrow job events with working listener cleanup', () => {
  let bridge;
  const listeners = new Map();
  const ipcRenderer = { invoke: (...args) => args, on: (name, fn) => listeners.set(name, fn), removeListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../preload.js'), 'utf8'), { require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } } }) });
  let calls = 0;
  const unsubscribe = bridge.onJobsChanged(() => calls++);
  listeners.get('jobs:changed')();
  unsubscribe();
  assert.equal(calls, 1);
  assert.equal(listeners.size, 0);
  assert.equal(bridge.listJobs({ view: 'history' })[0], 'jobs:list');
});


test('all application entrypoints reuse the dashboard and defer navigation until loaded', async () => {
  const app = appHarness();
  assert.equal(app.windows.length, 1);
  assert.match(app.windows[0].file, /dashboard\.html$/);
  assert.equal(app.windows[0].options.webPreferences.sandbox, true);
  assert.equal(app.windows[0].options.webPreferences.contextIsolation, true);
  app.invoke('dashboard:open-settings');
  assert.equal(app.events.some(([name]) => name === 'app:navigate'), false);
  app.windows[0].finishLoad();
  assert.equal(app.events.at(-1)[1].view, 'settings');
  app.setResponse(async () => new Response(JSON.stringify({ threads: [{ id: 'thread', title: 'Test', settledOverride: null }], projects: [] }), { headers: { 'content-type': 'application/json' } }));
  await app.invoke('dashboard:schedule-thread', 'thread');
  assert.equal(app.windows.length, 1);
  assert.equal(app.events.at(-1)[1].view, 'composer');
  assert.equal(app.events.at(-1)[1].threadId, 'thread');
  app.invoke('dashboard:open-settings');
  assert.equal(app.windows.length, 1);
  assert.equal(app.events.at(-1)[1].view, 'settings');
});

test('settings changes broadcast public config and job mutations broadcast live updates', async () => {
  const app = appHarness();
  app.windows[0].finishLoad();
  app.invoke('settings:save', { httpPort: 3773, bufferSeconds: 12, t3Token: 'private-stored-token' });
  const event = app.events.find(([name]) => name === 'settings:changed');
  assert.equal(event[1].bufferSeconds, 12);
  assert.equal(event[1].hasStoredToken, true);
  assert.doesNotMatch(JSON.stringify(event), /private-stored-token/);
  app.setResponse(async url => new Response(JSON.stringify(url.includes('/threads/') ? { thread: { id: 'thread', messages: [], title: 'Test' } } : { projects: [], threads: [] }), { headers: { 'content-type': 'application/json' } }));
  const job = await app.invoke('schedule:create', { threadId: 'thread', message: 'Continue', whenISO: '2099-01-01T12:00:00Z', timeZone: 'UTC' });
  assert.ok(app.events.some(([name]) => name === 'jobs:changed'));
  app.invoke('jobs:cancel', job.id);
  assert.ok(app.events.filter(([name]) => name === 'jobs:changed').length >= 2);
});


test('a second instance never starts another scheduler or window', () => {
  const app = appHarness([], { ownsInstance: false });
  assert.equal(app.windows.length, 0);
  assert.deepEqual(JSON.parse(app.files.get('/fixture/jobs.json')), []);
});

test('settings persistence failure leaves active configuration unchanged', () => {
  const app = appHarness();
  const original = app.invoke('settings:get');
  app.setWriteFailure(true);
  assert.throws(() => app.invoke('settings:save', { httpPort: 9999, bufferSeconds: 90 }), /Disk full/);
  assert.deepEqual(app.invoke('settings:get'), original);
  assert.equal(app.events.some(([name]) => name === 'settings:changed'), false);
});


test('corrupt and future-version schedule files are preserved and block scheduling visibly', () => {
  for (const rawJobs of ['{"jobs":', JSON.stringify({ version: 4, jobs: [] }), JSON.stringify([{ id: 'invalid-record' }])]) {
    const app = appHarness([], { rawJobs });
    assert.equal(app.files.get('/fixture/jobs.json'), rawJobs);
    const state = app.invoke('jobs:list');
    assert.equal(state.storageError.code, 'storage_unavailable');
    assert.match(state.storageError.message, /Existing data has not been changed/);
    assert.throws(() => app.invoke('schedule:create', { threadId: 'thread', message: 'Continue', whenISO: '2099-01-01T12:00:00Z' }));
    assert.equal(app.files.get('/fixture/jobs.json'), rawJobs);
    assert.equal(app.windows.length, 1, 'The recovery message remains accessible in the app');
  }
});

test('the production registry is described over IPC without touching any harness', () => {
  const app = appHarness();
  const { harnesses, defaultHarness } = app.invoke('harnesses:list');
  assert.equal(defaultHarness, 't3');
  assert.equal(harnesses.map((item) => item.id).join(), 't3,opencode,claude-code,codex');
  for (const item of harnesses) {
    assert.equal(item.capabilities.requiresUnlockedScreen, false, item.id);
    assert.equal(typeof item.capabilities.canDetectCompletion, 'boolean');
  }
  assert.equal(harnesses.find((item) => item.id === 'opencode').settings.map((setting) => setting.key).join(), 'port,password');
});

test('conversations, schedules and connection checks are routed to the chosen harness', async () => {
  const { createFakeHarness } = require('../tools/fake-harness.cjs');
  const fake = createFakeHarness({ conversations: [{ id: 'conv-1', title: 'Fake conversation', projectName: 'Repo' }] });
  const app = appHarness([], { extraHarnesses: () => [fake.adapter] });
  const listed = await app.invoke('dashboard:threads', { harness: 'fake', showSettled: true });
  assert.equal(listed.online, true);
  assert.equal(JSON.stringify(listed.threads.map((thread) => [thread.harness, thread.id])), JSON.stringify([['fake', 'conv-1']]));
  assert.equal((await app.invoke('connection:check', 'fake')).online, true);
  fake.state.connectionError = new (require('../lib/harnesses/errors').HarnessError)('connection_refused', 'Fake is not running.');
  assert.equal((await app.invoke('connection:check', 'fake')).error.code, 'connection_refused');
  const unknown = await app.invoke('dashboard:threads', { harness: 'nope' });
  assert.equal(unknown.online, false);
  assert.equal(unknown.errorInfo.code, 'unknown_harness');
  const job = await app.invoke('schedule:create', { harness: 'fake', threadId: 'conv-1', message: 'Continue', whenISO: '2099-01-01T12:00:00Z', timeZone: 'UTC' });
  assert.equal(job.harness, 'fake');
  assert.equal(job.harnessLabel, 'Fake Agent');
  assert.equal(JSON.parse(app.files.get('/fixture/jobs.json')).version, 3);
  assert.equal(JSON.parse(app.files.get('/fixture/jobs.json')).jobs[0].harness, 'fake');
  assert.equal((await app.invoke('harnesses:availability', 'fake')).availability.state, 'available');
  assert.equal((await app.invoke('harnesses:availability', 't3')).availability.state, 'unknown');
  app.windows[0].finishLoad();
  await app.invoke('dashboard:schedule-thread', 'conv-1', 'fake');
  assert.equal(JSON.stringify(app.events.at(-1)[1]), JSON.stringify({ view: 'composer', threadId: 'conv-1', threadLabel: 'Fake conversation', harness: 'fake' }));
  assert.equal(fake.state.submitted.length, 0);
});

test('harness settings are validated, persisted and never returned in clear text', () => {
  const app = appHarness([], { env: { T3_TOKEN: 'test-secret', OPENCODE_SERVER_PASSWORD: '' } });
  app.invoke('settings:save', { httpPort: 3773, bufferSeconds: 5, harnesses: { opencode: { port: 4555, password: 'oc-secret' }, 'claude-code': { executable: '/opt/claude' } } });
  const saved = JSON.parse(app.files.get('/fixture/config.json'));
  assert.equal(JSON.stringify(saved.harnesses), JSON.stringify({ opencode: { port: 4555, password: 'oc-secret' }, 'claude-code': { executable: '/opt/claude' } }));
  const shown = app.invoke('settings:get');
  assert.equal(JSON.stringify(shown.harnesses.opencode.password), JSON.stringify({ hasStoredValue: true, usingEnvironment: false }));
  assert.equal(shown.harnesses.opencode.port.value, 4555);
  assert.doesNotMatch(JSON.stringify(shown), /oc-secret/);
  assert.throws(() => app.invoke('settings:save', { httpPort: 3773, bufferSeconds: 5, harnesses: { opencode: { port: 70000 } } }), /port/);
  assert.throws(() => app.invoke('settings:save', { httpPort: 3773, bufferSeconds: 5, harnesses: { unknown: {} } }), /Unknown/);
  app.invoke('settings:save', { httpPort: 3773, bufferSeconds: 5, harnesses: { opencode: { password: '' } } });
  assert.equal(JSON.parse(app.files.get('/fixture/config.json')).harnesses.opencode.password, 'oc-secret', 'A blank secret keeps the stored value');
});

