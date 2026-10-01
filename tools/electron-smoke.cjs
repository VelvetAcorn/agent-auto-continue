'use strict';
// Executes the production main process, preload and renderer against in-memory
// storage and an injected API. No network request or scheduled POST can occur.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const electron = require('electron');
const { app, BrowserWindow } = electron;
// Chromium storage is isolated too; even theme/localStorage cannot touch user state.
const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 't3-scheduler-smoke-'));
app.setPath('userData', profile);
const root = path.resolve(__dirname, '..');
const files = new Map();
const windows = [];
const failures = [];
let offline = false;
let fakeOffline = false;
let t3Reads = 0;
let dispatches = 0;
const externalUrls = [];
const copied = [];
let menu;
let trayImage;
const evidenceDirectory = process.env.T3_SMOKE_EVIDENCE_DIR;
async function capture(name) {
  if (!evidenceDirectory) return;
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  // Give Chromium a frame to paint the latest state before capturing pixels.
  await new Promise(resolve => setTimeout(resolve, 150));
  const screenshot = await windows[0].webContents.capturePage();
  assert.equal(screenshot.isEmpty(), false, 'Rendered evidence must contain pixels');
  fs.writeFileSync(path.join(evidenceDirectory, `${name}.png`), screenshot.toPNG());
}
const fixtureThread = { id: 'thread-active', title: 'Production renderer test', projectId: 'project-fixture', updatedAt: '2026-09-30T12:34:56.789Z', settledOverride: null, messages: [], modelSelection: { model: 'fixture', instanceId: 'fixture' }, runtimeMode: 'full-access', interactionMode: 'default' };
const jobs = [{ id: 'failure-fixture', commandId: 'command-fixture', messageId: 'message-fixture', threadId: fixtureThread.id, threadTitle: fixtureThread.title, message: 'Previous failed delivery', scheduleAt: '2026-01-01T10:00:00Z', createdAt: '2026-01-01T09:00:00Z', updatedAt: '2026-01-01T10:00:00Z', status: 'failed', note: 'Unexpected token <', bufferSeconds: 5, timeZone: 'UTC' }];
jobs.push({ ...jobs[0], id: 'uncertain-fixture', messageId: 'uncertain-message', status: 'unconfirmed', message: 'Unconfirmed fixture delivery' });
files.set('/fixture/jobs.json', JSON.stringify(jobs));
const fakeFs = {
  readFileSync(name) { if (!files.has(name)) throw Object.assign(new Error('Missing fixture'), { code: 'ENOENT' }); return files.get(name); },
  mkdirSync() {}, writeFileSync(name, value) { files.set(name, value); },
  renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); }
};
async function fixtureFetch(url, options = {}) {
  if (options.method === 'POST') { dispatches++; throw new Error('Dispatch is prohibited in the smoke fixture.'); }
  t3Reads++;
  if (offline) return new Response('<!doctype html><html>Fixture outage</html>', { headers: { 'content-type': 'text/html' } });
  const payload = url.includes('/threads/') ? { snapshotSequence: 1, thread: fixtureThread } : {
    snapshotSequence: 1,
    projects: [{ id: 'project-fixture', title: 'Fixture project' }],
    threads: [fixtureThread, { ...fixtureThread, id: 'thread-settled', title: 'Settled fixture', settledOverride: 'settled' }]
  };
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
}
const apiModule = require('../lib/api-client');
const harnessModule = require('../lib/harnesses');
const { createT3Harness } = require('../lib/harnesses/t3');
const { createFakeHarness } = require('./fake-harness.cjs');
// A second, in-memory harness exercises the picker without touching real agents.
const fake = createFakeHarness({ label: 'Fake Agent', conversations: [{ id: 'conv-fake', title: 'Fake conversation', projectName: 'Fake repo', updatedAt: '2026-09-30T10:00:00Z' }, { id: 'conv-chain', title: 'Chain fixture session', projectName: 'fake-repo', updatedAt: '2026-09-30T09:00:00Z' }], settings: [{ key: 'port', type: 'port', label: 'Fake agent port', default: 4096, help: 'Fixture setting.' }] });
// An in-memory desktop app whose installed version can drift, for the compatibility notice.
const supported = { appVersion: '2.16120.0', verifiedVersion: '2.16120.0', problems: [], checked: ['app_path', 'deep_link', 'content_match', 'composer_label', 'send_label'], unchecked: [] };
const desk = createFakeHarness({ id: 'desk', label: 'Claude Desktop', kind: 'desktop-app', compatibility: supported,
  capabilities: { requiresRunningApp: true, requiresUnlockedScreen: true, requiresAccessibilityPermission: true },
  conversations: [{ id: 'local_fixture', title: 'Refactor the scheduler', projectName: 'agent-auto-continue', updatedAt: '2026-09-30T11:00:00Z' }] });
// Automatic continuations run end to end against the fake harness; each turn
// completes on its own after 300 ms, or when the journey releases it.
let completionMode = 'auto';
const pendingCompletions = [];
fake.state.completion = () => new Promise((resolve) => {
  const finish = () => resolve({ state: 'completed', completedAt: new Date().toISOString() });
  if (completionMode === 'auto') setTimeout(finish, 300); else pendingCompletions.push(finish);
});
// Real timers for near-term work only; far-future schedules (such as 2099 fixtures) never fire.
const nearTimers = { scheduleJob(when, callback) {
  const delay = when.valueOf() - Date.now();
  if (delay > 60 * 60_000) return { cancel() {} };
  const handle = setTimeout(callback, Math.max(0, delay));
  return { cancel() { clearTimeout(handle); } };
} };
const appProxy = new Proxy(app, { get(target, property) {
  if (property === 'requestSingleInstanceLock') return () => true;
  if (property === 'getPath') return name => name === 'userData' ? '/fixture' : target.getPath(name);
  const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
} });
class FixtureWindow extends electron.BrowserWindow {
  constructor(options) {
    super({ ...options, show: false });
    windows.push(this);
    this.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    this.webContents.on('render-process-gone', (_event, detail) => failures.push(`Renderer stopped: ${detail.reason}`));
    this.webContents.on('did-fail-load', (_event, code, description) => failures.push(`Load failed ${code}: ${description}`));
  }
  // Electron's getAllWindows() filters by constructor name and does not list subclassed windows,
  // which silently dropped main-process broadcasts (jobs:changed, settings:changed, keep-awake:changed).
  static getAllWindows() { return windows.filter(window => !window.isDestroyed()); }
  show() { /* Keep executable tests out of the user's foreground. */ }
  focus() { /* Keep executable tests out of the user's foreground. */ }
}
const injectedElectron = {
  ...electron, app: appProxy, BrowserWindow: FixtureWindow,
  Tray: class { constructor(image) { trayImage = image; } setImage(image) { trayImage = image; } setToolTip() {} on() {} setContextMenu(value) { menu = value; } },
  Menu: { buildFromTemplate: value => value }, Notification: { isSupported: () => false },
  shell: { openExternal: async url => { externalUrls.push(url); } },
  clipboard: { writeText: text => { copied.push(text); } },
  // Real power save blockers; power events stay inert so the fixture never reacts to the host's sleep.
  powerMonitor: { on() {}, isOnBatteryPower: () => electron.powerMonitor.isOnBatteryPower() }
};
let mainContext;
function loadProductionMain() {
  mainContext = vm.createContext({
    require(name) {
      if (name === 'electron') return injectedElectron;
      if (name === 'node:fs') return fakeFs;
      if (name === 'node-schedule') return nearTimers;
      if (name === './lib/api-client') return { ...apiModule, createApiClient: options => apiModule.createApiClient({ ...options, fetchImpl: fixtureFetch }) };
      if (name === './lib/harnesses') return { ...harnessModule, createHarnesses: options => harnessModule.createHarnessRegistry([createT3Harness({ api: options.api }), { ...fake.adapter, async listConversations(options) { if (fakeOffline) throw new Error('Fake Agent unavailable'); return fake.adapter.listConversations(options); } }, desk.adapter]) };
      return name.startsWith('./lib/') ? require(path.join(root, name)) : require(name);
    }, __dirname: root, process: { env: { T3_TOKEN: 'fixture-only' }, pid: process.pid }, console, Buffer
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), mainContext, { filename: 'main.js' });
}
// The assertions this process holds, as macOS reports them.
function ownAssertions() {
  return execFileSync('/usr/bin/pmset', ['-g', 'assertions'], { encoding: 'utf8' }).split('\n')
    .filter(line => line.includes(`pid ${process.pid}(`)).map(line => line.trim().replace(/\[0x[0-9a-f]+\] /, '').replace(/ \d\d:\d\d:\d\d /, ' '));
}
function nativeImageFor(file) { return electron.nativeImage.createFromPath(path.join(root, 'assets', file)); }
async function waitFor(check, label) {
  const deadline = Date.now() + 10_000;
  do { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 40)); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}
async function run() {
  await app.whenReady();
  app.dock?.hide();
  loadProductionMain();
  await waitFor(() => windows.length === 1 && !windows[0].webContents.isLoading(), 'production window loaded');
  const window = windows[0];
  window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  // CI runners may have Reduce motion switched on; pin the OS preference so motion checks are deterministic.
  const reducedMotion = value => window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value }] });
  await reducedMotion('no-preference');
  const js = code => window.webContents.executeJavaScript(code, true);
  await waitFor(() => js('Boolean(window.autoContinue && document.querySelector("main"))'), 'production renderer initialized');
  await js(`(() => { if (document.body.classList.contains('dark')) document.querySelector('[data-action="theme"]').click(); })()`);
  assert.equal(windows.length, 1);
  assert.equal((await js('window.autoContinue.listJobs({view:"history"})')).total, 2);
  await js('window.autoContinue.openSettings()');
  await waitFor(() => js('document.body.innerText.includes("Settings")'), 'settings route');
  await js('window.autoContinue.scheduleThread("thread-active")');
  assert.equal(windows.length, 1);
  // DOM journey assertions are maintained below with the production selectors.
  await rendererJourney(js, reducedMotion);
  await keepAwakeJourney(js);
  await harnessJourney(js);
  await continuationJourney(js);
  await compatibilityJourney(js);
  offline = true;
  const history = await js('window.autoContinue.listJobs({view:"history"})');
  assert.ok(history.total >= 1, 'History survives offline API');
  const connection = await js('window.autoContinue.checkConnection()');
  assert.equal(connection.error.code, 'unexpected_response_format');
  await js(`document.querySelector('[data-nav="threads"]').click()`);
  await waitFor(() => js(`document.querySelector('#connection-state').textContent.includes('Offline')`), 'visible offline state');
  await js(`document.querySelector('[data-nav="history"]').click()`);
  await capture('history-offline');
  offline = false;
  await js(`document.querySelector('[data-nav="threads"]').click()`);
  await waitFor(() => js(`document.querySelector('#connection-state').textContent.includes('connected')`), 'connection recovery clears current failure');
  assert.equal(await js(`document.querySelector('#notices').textContent.includes('unexpected')`), false);
  if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, 'persisted-fixture-jobs.json'), files.get('/fixture/jobs.json'));
  assert.equal(dispatches, 0, 'The fixture must never send a message');
  assert.equal(fake.state.submitted.filter(item => item.conversationId !== 'conv-chain').length, 0, 'Only the continuation journey sends, and only to its fake session');
  assert.equal(desk.state.submitted.length, 0, 'The fake desktop app must never send a message');
  assert.deepEqual(failures, []);
  assert.ok(menu.find(item => item.label === 'Open scheduler'));
  // The real nativeImage decodes the tray glyph, so an unreadable or undecodable asset fails here.
  assert.equal(trayImage.isEmpty(), false, 'The menu-bar icon must contain pixels');
  assert.deepEqual(trayImage.getSize(), { width: 18, height: 18 });
  assert.equal(trayImage.isTemplateImage(), true, 'The menu-bar icon must adapt to light and dark menu bars');
  assert.ok(trayImage.getScaleFactors().includes(2), 'The menu-bar icon needs a Retina representation');
  assert.equal(trayImage.toPNG().equals(nativeImageFor('trayTemplate.png').toPNG()), true, 'The idle glyph returns once keep-awake lets the Mac sleep');
  console.log('Electron production workflow smoke passed: one window, real preload/IPC/renderer, local history, sanitized offline error, keep-awake assertions released, zero T3 sends, and fake-harness continuations (auto-start, turn limit, continuous, stop, tray stop all) and a desktop app compatibility notice.');
}
// Turns on remote control from Settings, then drives the real listener over HTTP and MCP.
async function remoteJourney(js, click, fill) {
  const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
  const server = require('node:net').createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  await waitFor(() => js(`Boolean(document.querySelector('#remote-form'))`), 'remote settings loaded');
  assert.equal(await js(`document.querySelector('#remote-enabled').checked`), false, 'remote control is off by default');
  assert.equal(await js(`document.querySelector('#remote-bind').value`), '', 'loopback only by default');
  await js(`(() => { const box=document.querySelector('#remote-enabled'); box.checked=true; box.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await fill('#remote-port', String(port));
  await js(`document.querySelector('#remote-form').requestSubmit()`);
  await waitFor(() => js(`Boolean(document.querySelector('.remote-listeners .pill.sent'))`), 'remote listener running');
  await js(`document.querySelector('#remote-form').scrollIntoView({block:'start'})`);
  await capture('settings-remote-listening');
  assert.match(await js(`document.querySelector('.remote-endpoints').textContent`), new RegExp(`http://127\\.0\\.0\\.1:${port}/mcp`));
  await fill('#remote-token-label', 'Smoke phone');
  await js(`document.querySelector('#remote-token-form').requestSubmit()`);
  await waitFor(() => js(`Boolean(document.querySelector('.token-reveal img'))`), 'token revealed once');
  await waitFor(() => js(`document.querySelector('.token-reveal img').complete && document.querySelector('.token-reveal img').naturalWidth > 0`), 'QR code rendered');
  const token = await js(`document.querySelector('#remote-new-token').textContent`);
  assert.match(token, /^aac_[A-Za-z0-9_-]{43}$/);
  const previousClipboard = electron.clipboard.readText();
  await click('[data-action="remote-copy"]');
  await waitFor(() => electron.clipboard.readText() === token, 'token copied to the clipboard');
  electron.clipboard.writeText(previousClipboard);
  await js(`document.querySelector('#toast-dismiss')?.click(); document.querySelector('.token-reveal').scrollIntoView({block:'center'})`);
  await capture('settings-remote-token');
  const call = (method, route, body) => fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await call('GET', '/v1/status')).status, 200);
  const created = await call('POST', '/v1/jobs', { threadId: fixtureThread.id, message: 'Scheduled from the smoke phone', delayMinutes: 90 });
  assert.equal(created.status, 201);
  const job = (await created.json()).job;
  await waitFor(() => js(`document.querySelector('[data-count="upcoming"]').textContent === '1'`), 'desktop queue count updates live from a remote change');
  assert.equal((await js(`window.autoContinue.getJob(${JSON.stringify(job.id)})`)).message, 'Scheduled from the smoke phone', 'remote schedules land in the desktop queue');
  const mcp = new Client({ name: 'electron-smoke', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const listed = await mcp.callTool({ name: 'list_jobs', arguments: { view: 'upcoming' } });
  assert.ok(listed.structuredContent.jobs.some(item => item.id === job.id));
  assert.equal((await mcp.callTool({ name: 'cancel_job', arguments: { id: job.id } })).structuredContent.job.status, 'canceled');
  // The production harness registry, continuation runs and keep-awake status are wired into remote control.
  assert.deepEqual((await (await call('GET', '/v1/harnesses')).json()).harnesses.map(item => item.id), ['t3', 'fake', 'desk']);
  assert.deepEqual((await (await call('GET', '/v1/status')).json()).capabilities, { keepAwake: true, continuousRuns: true });
  const started = await call('POST', '/v1/jobs', { harness: 'fake', threadId: 'conv-fake', message: 'Remote continuation', delayMinutes: 120, continuous: true });
  assert.equal(started.status, 201);
  const run = (await started.json()).job;
  assert.ok((await mcp.callTool({ name: 'list_runs', arguments: {} })).structuredContent.runs.some(item => item.id === run.id));
  await waitFor(() => js(`window.autoContinue.getJob(${JSON.stringify(run.id)}).then(item => item.automation?.unlimited === true)`), 'remote continuation visible on the desktop');
  const stoppedRun = await call('POST', `/v1/runs/${run.id}/stop`);
  assert.equal(stoppedRun.status, 200);
  await waitFor(() => js(`window.autoContinue.getJob(${JSON.stringify(run.id)}).then(item => item.automation.state === 'stopped')`), 'remote stop reaches the desktop');
  assert.equal((await call('POST', `/v1/runs/${run.id}/stop`)).status, 409, 'a stopped run cannot be stopped again');
  await mcp.close();
  await click('[data-action="remote-dismiss"]');
  assert.equal(await js(`document.body.innerText.includes(${JSON.stringify(token)})`), false, 'the token is not shown again');
  await waitFor(() => js(`(() => { const text = [...document.querySelectorAll('.remote-audit')].map(row => row.textContent).join('|'); return text.includes('Canceled a schedule') && text.includes('Stopped a continuation'); })()`), 'remote activity visible');
  await js(`document.querySelectorAll('.card')[3].scrollIntoView({block:'start'})`);
  await js(`document.querySelector('#toast-dismiss')?.click()`);
  await capture('settings-remote-activity');
  await click('[data-action="remote-revoke"]');
  await click('[data-action="remote-revoke-confirm"]');
  await waitFor(() => js(`!document.querySelector('[data-action="remote-revoke"]')`), 'token revoked');
  assert.equal((await call('GET', '/v1/status')).status, 401, 'revocation is immediate');
  await js(`(() => { const box=document.querySelector('#remote-enabled'); box.checked=false; box.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await js(`document.querySelector('#remote-form').requestSubmit()`);
  await waitFor(() => js(`document.body.innerText.includes('Nothing is listening')`), 'remote control turned off');
  await assert.rejects(fetch(`http://127.0.0.1:${port}/v1/status`));
  assert.doesNotMatch(files.get('/fixture/remote-control.json'), new RegExp(token.slice(4)), 'only token digests are stored');
}
async function rendererJourney(js, reducedMotion) {
  const click = async selector => {
    await waitFor(() => js(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), `control ${selector}`);
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };
  const fill = async (selector, value) => js(`(() => { const input=document.querySelector(${JSON.stringify(selector)}); input.value=${JSON.stringify(value)}; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const heading = expected => waitFor(() => js(`document.querySelector('h1')?.textContent === ${JSON.stringify(expected)}`), `view ${expected}`);
  await heading('New schedule');
  await js('window.__jobsChanged = 0; window.autoContinue.onJobsChanged(() => window.__jobsChanged++); 0');
  await fill('#message', 'Fixture message from the production composer');
  await fill('#date', '2099-02-30');
  await fill('#time', '12:00');
  await fill('#timezone', 'UTC');
  await js(`document.querySelector('#schedule-form').requestSubmit()`);
  assert.match(await js(`document.querySelector('#schedule-error').textContent`), /real calendar/);
  await fill('#date', '2099-12-15');
  await click('[data-action="calendar"]');
  await capture('composer-calendar');
  await click('[data-action="calendar"]');
  await js(`document.querySelector('#schedule-form').requestSubmit()`);
  await heading('Upcoming');
  const created = await js(`window.autoContinue.listJobs({view:'upcoming'}).then(result=>result.jobs.find(job=>job.message==='Fixture message from the production composer'))`);
  assert.ok(created);
  assert.equal(created.timeZone, 'UTC');
  assert.equal(created.scheduleAt, '2099-12-15T12:00:00.000Z');
  assert.equal(created.effectiveAt, '2099-12-15T12:00:05.000Z');
  assert.ok(await js('window.__jobsChanged') > 0, 'Main-process jobs:changed broadcasts reach the renderer');
  await capture('upcoming-scheduled');
  await click(`[data-job="${created.id}"]`);
  await click('[data-action="edit"]');
  await heading('Edit schedule');
  await fill('#message', 'Fixture message edited');
  await fill('#time', '14:00');
  await js(`document.querySelector('#schedule-form').requestSubmit()`);
  await heading('Upcoming');
  assert.equal((await js(`window.autoContinue.getJob(${JSON.stringify(created.id)})`)).message, 'Fixture message edited');
  await click(`[data-job="${created.id}"]`);
  await click('[data-action="cancel"]');
  await click('[data-action="confirm-cancel"]');
  await waitFor(() => js(`window.autoContinue.getJob(${JSON.stringify(created.id)}).then(job=>job.status==='canceled')`), 'canceled schedule persisted');
  await waitFor(() => js(`Boolean(document.querySelector('[data-action="again"]'))`), 'canceled detail refreshed');
  await click('[data-nav="history"]');
  await heading('History');
  await click('[data-job="failure-fixture"]');
  assert.equal(await js(`Boolean(document.querySelector('[data-action="again"]'))`), false);
  assert.equal(await js(`document.querySelector('.detail-header .pill').textContent`), 'Delivery unconfirmed');
  await click('[data-action="reconcile"]');
  await waitFor(() => js(`window.autoContinue.getJob('failure-fixture').then(job=>Boolean(job.lastReconciledAt))`), 'legacy reconciliation recorded');
  await waitFor(() => js(`!document.querySelector('[data-action="reconcile"]').disabled`), 'legacy reconciliation completed');
  assert.equal(await js(`Boolean(document.querySelector('[data-action="again"]'))`), false);
  await click('[data-action="ack"]');
  await waitFor(() => js(`window.autoContinue.getJob('failure-fixture').then(job=>Boolean(job.acknowledgedAt))`), 'acknowledgment persisted');
  await waitFor(() => js(`document.querySelector('[data-action="ack"]')?.textContent.includes('Acknowledged')`), 'acknowledged UI');
  await capture('history-acknowledged');
  assert.equal((await js(`window.autoContinue.listJobs({view:'history'})`)).unacknowledgedFailures, 1);
  await click('[data-nav="history"]');
  await click('[data-job="uncertain-fixture"]');
  await click('[data-action="reconcile"]');
  await waitFor(() => js(`window.autoContinue.getJob('uncertain-fixture').then(job=>Boolean(job.lastReconciledAt))`), 'first reconciliation recorded');
  await waitFor(() => js(`!document.querySelector('[data-action="reconcile"]').disabled`), 'first reconciliation completed');
  assert.equal((await js(`window.autoContinue.getJob('uncertain-fixture')`)).status, 'unconfirmed');
  fixtureThread.messages.push({ id: 'uncertain-message', role: 'user', createdAt: '2026-01-01T10:00:00Z' });
  await click('[data-action="reconcile"]');
  await waitFor(() => js(`window.autoContinue.getJob('uncertain-fixture').then(job=>job.status==='sent')`), 'existing message confirmed without resend');
  await waitFor(() => js(`Boolean(document.querySelector('[data-action="again"]'))`), 'confirmed detail refreshed');
  assert.equal((await js(`window.autoContinue.listJobs({view:'history'})`)).unacknowledgedFailures, 0);
  await click('[data-nav="threads"]');
  await heading('Threads');
  await waitFor(() => js(`Boolean(document.querySelector('[data-thread="thread-active"]'))`), 'thread data loaded');
  assert.equal(await js(`Boolean(document.querySelector('[data-thread="thread-settled"]'))`), false);
  await js(`document.querySelector('[data-thread="thread-active"]').focus()`);
  const exactTime = await js(`(() => {
    const row = document.activeElement;
    const exact = row.querySelector('time');
    const short = row.querySelector('.thread-time-short');
    return { thread: row.dataset.thread, text: exact.textContent, datetime: exact.dateTime,
      visible: exact.getBoundingClientRect().width > 1 && getComputedStyle(exact).clipPath === 'none',
      shortHidden: getComputedStyle(short).display === 'none', relative: row.querySelector('[data-relative]').textContent };
  })()`);
  assert.equal(exactTime.thread, 'thread-active');
  assert.equal(exactTime.text, fixtureThread.updatedAt);
  assert.equal(exactTime.datetime, fixtureThread.updatedAt);
  assert.equal(exactTime.visible, true, JSON.stringify(exactTime));
  assert.equal(exactTime.shortHidden, true);
  assert.ok(exactTime.relative.length > 0);
  await capture('threads-exact-time');
  await click('#show-settled');
  assert.equal(await js(`Boolean(document.querySelector('[data-thread="thread-settled"]'))`), true);
  await click('[data-nav="settings"]');
  await waitFor(() => js(`Boolean(document.querySelector('#settings-form'))`), 'settings loaded');
  await supportStarJourney(js, click, reducedMotion);
  await click('[data-action="support"]');
  await waitFor(() => externalUrls.length === 1, 'support page opened in browser');
  assert.deepEqual(externalUrls, ['https://ko-fi.com/velvetacorn']);
  await waitFor(() => js(`!document.querySelector('[data-action="support"]').disabled`), 'support operation finished');
  assert.ok(windows[0].webContents.getURL().startsWith('file:'), 'Support must leave the app on its local page');
  await fill('#buffer', '12');
  await js(`document.querySelector('#settings-form').requestSubmit()`);
  await waitFor(() => js(`window.autoContinue.getSettings().then(settings=>settings.bufferSeconds===12)`), 'settings saved');
  await waitFor(() => js(`!document.querySelector('#buffer').disabled`), 'settings operation finished');
  await js(`(() => { const select=document.querySelector('#theme'); select.value='dark'; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  assert.equal(await js(`document.body.classList.contains('dark')`), true);
  assert.equal(await js(`document.querySelector('[data-action="support"]').disabled`), false);
  assert.equal(await js(`Boolean(document.querySelector('.star svg'))`), true);
  await capture('settings-bone-outline');
  await js(`document.querySelector('.support').scrollIntoView({block:'center'})`);
  await capture('settings-support');
  await remoteJourney(js, click, fill);
  // A settings change must be reflected in the next draft's send preview.
  await click('[data-nav="upcoming"]');
  await click('[data-action="new"]');
  assert.match(await js(`document.querySelector('#schedule-preview').textContent`), /12-second/);
  assert.equal(windows.length, 1, 'Every journey stayed in the same window');
}
async function supportStarJourney(js, click, reducedMotion) {
  const phrase = () => js(`document.querySelector('#star-phrase').textContent`);
  const phrases = await js('window.SupportStar.STICKER_PHRASES');
  const star = await js(`(() => { const star=document.querySelector('#support-star'); return { tag: star.tagName, name: star.getAttribute('aria-label'), described: star.getAttribute('aria-describedby'), lines: star.querySelectorAll('.star-text span').length, fit: star.querySelector('.star-text').style.getPropertyValue('--fit') }; })()`);
  assert.deepEqual({ ...star, fit: Number(star.fit) > 0 }, { tag: 'BUTTON', name: 'Shuffle sticker phrase', described: 'star-phrase', lines: star.lines, fit: true });
  assert.ok(star.lines >= 1 && phrases.includes(await phrase()));
  // Re-renders keep the phrase; leaving and re-entering Settings picks a different one.
  const entered = await phrase();
  await js(`document.querySelector('[data-action="theme"]').click()`);
  await js(`document.querySelector('[data-action="theme"]').click()`);
  assert.equal(await phrase(), entered);
  await click('[data-nav="upcoming"]');
  await click('[data-nav="settings"]');
  await waitFor(() => js(`Boolean(document.querySelector('#support-star'))`), 'settings re-entered');
  assert.notEqual(await phrase(), entered);
  // Every phrase's glyphs stay inside the outline's inner edge (0.361 of the width) and the text never rotates.
  const fit = await js(`(async () => {
    const star = document.querySelector('#support-star'), seen = new Map();
    for (let attempt = 0; attempt < 500 && seen.size < window.SupportStar.STICKER_PHRASES.length; attempt++) {
      star.click();
      const text = star.querySelector('.star-text'), style = getComputedStyle(text), size = parseFloat(style.fontSize), lineHeight = parseFloat(style.lineHeight);
      const context = document.createElement('canvas').getContext('2d'); context.font = '900 ' + size + 'px Georgia, serif';
      const box = star.getBoundingClientRect(), cx = box.left + box.width / 2, cy = box.top + box.height / 2;
      let worst = 0;
      for (const line of text.querySelectorAll('span')) {
        const rect = line.getBoundingClientRect(), metrics = context.measureText(line.textContent);
        const baseline = rect.top + (lineHeight - metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent) / 2 + metrics.fontBoundingBoxAscent;
        for (const x of [rect.left - metrics.actualBoundingBoxLeft, rect.left + metrics.actualBoundingBoxRight]) for (const y of [baseline - metrics.actualBoundingBoxAscent, baseline + metrics.actualBoundingBoxDescent]) worst = Math.max(worst, Math.hypot(x - cx, y - cy) / box.width);
      }
      seen.set(star.querySelector('#star-phrase').textContent, { worst, size, rotated: style.transform !== 'none' });
    }
    return Object.fromEntries(seen);
  })()`);
  assert.deepEqual(Object.keys(fit).sort(), [...phrases].sort());
  for (const [text, result] of Object.entries(fit)) assert.ok(result.worst < 0.355 && result.size >= 10 && !result.rotated, `${text}: ${JSON.stringify(result)}`);
  // A click bursts and eases back without the angle ever jumping or reversing, even across a re-render.
  const motion = await js(`new Promise(resolve => {
    const angle = () => parseFloat(document.querySelector('#support-star polygon').style.transform.slice(7));
    const samples = [], start = performance.now(), before = document.querySelector('#star-phrase').textContent;
    document.querySelector('#support-star').click();
    setTimeout(() => document.querySelector('[data-action="theme"]').click(), 300);
    (function frame(now) { samples.push([now, angle()]); if (now - start < 1400) requestAnimationFrame(frame); else resolve({ samples, changed: document.querySelector('#star-phrase').textContent !== before, status: document.querySelector('#star-status').textContent }); })(start);
  })`);
  await js(`document.querySelector('[data-action="theme"]').click()`);
  assert.equal(motion.changed, true);
  const steps = motion.samples.slice(1).map(([time, angle], index) => ({ elapsed: time - motion.samples[index][0], turned: (angle - motion.samples[index][1] + 360) % 360 }));
  const total = steps.reduce((sum, step) => sum + step.turned, 0), evidence = JSON.stringify({ frames: steps.length, total, span: motion.samples.at(-1)[0] - motion.samples[0][0] });
  assert.ok(steps.length > 20, `the star animates frame by frame ${evidence}`);
  for (const step of steps) assert.ok(step.turned <= 480 * Math.max(step.elapsed, 17) / 1000 + 0.5, `angle jumped ${JSON.stringify(step)}`);
  // Idle alone turns about 56 degrees in 1.4 s; the burst adds roughly 190 more.
  assert.ok(total > 150, `the click produced a fast burst ${evidence}`);
  // Reduced motion (app toggle or OS): no spin or burst, but a click still changes the phrase.
  const still = () => js(`new Promise(resolve => { const angle = () => document.querySelector('#support-star polygon').style.transform, before = document.querySelector('#star-phrase').textContent; document.querySelector('#support-star').click(); const first = angle(); setTimeout(() => resolve({ moved: angle() !== first, changed: document.querySelector('#star-phrase').textContent !== before }), 400); })`);
  await click('#motion');
  assert.deepEqual(await still(), { moved: false, changed: true });
  await click('#motion');
  await reducedMotion('reduce');
  assert.deepEqual(await still(), { moved: false, changed: true });
  await reducedMotion('no-preference');
  await js(`document.querySelector('[data-action="theme"]').click()`);
  await js(`document.querySelector('[data-action="theme"]').click()`);
  const first = await js(`document.querySelector('#support-star polygon').style.transform`);
  await waitFor(async () => (await js(`document.querySelector('#support-star polygon').style.transform`)) !== first, 'spin resumes when reduced motion ends');
}
async function harnessJourney(js) {
  const click = async selector => {
    await waitFor(() => js(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), `control ${selector}`);
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };
  const fill = async (selector, value) => js(`(() => { const input=document.querySelector(${JSON.stringify(selector)}); input.value=${JSON.stringify(value)}; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const choose = async (selector, value) => js(`(() => { const select=document.querySelector(${JSON.stringify(selector)}); select.value=${JSON.stringify(value)}; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  const heading = expected => waitFor(() => js(`document.querySelector('h1')?.textContent === ${JSON.stringify(expected)}`), `view ${expected}`);
  await click('[data-nav="threads"]');
  await heading('Threads');
  await waitFor(() => js(`Boolean(document.querySelector('#threads-harness option[value="fake"]'))`), 'harness catalogue loaded');
  await choose('#threads-harness', 'fake');
  await waitFor(() => js(`Boolean(document.querySelector('[data-thread="conv-fake"]'))`), 'fake conversations listed');
  await waitFor(() => js(`document.querySelector('#connection-state').textContent === 'Fake Agent connected'`), 'harness connection label');
  assert.equal(await js(`document.querySelector('#search').placeholder`), 'Find a session…');
  await capture('threads-harness');
  await click('[data-thread="conv-fake"]');
  await heading('New schedule');
  assert.equal(await js(`document.querySelector('#harness').value`), 'fake');
  assert.match(await js(`document.querySelector('.thread-picker').textContent`), /Fake conversation/);
  assert.match(await js(`document.querySelector('#schedule-form').textContent`), /Send to session/);
  await fill('#date', '2099-11-01');
  await fill('#time', '10:00');
  await fill('#timezone', 'UTC');
  await capture('composer-harness');
  await js(`document.querySelector('#schedule-form').requestSubmit()`);
  await heading('Upcoming');
  const job = await js(`window.autoContinue.listJobs({view:'upcoming'}).then(result=>result.jobs.find(item=>item.harness==='fake'))`);
  assert.ok(job, 'The schedule records its harness');
  assert.equal(job.threadTitle, 'Fake conversation');
  await waitFor(() => js(`document.querySelector(${JSON.stringify(`[data-job="${job.id}"] .overline`)})?.textContent === 'Fake Agent · Fake repo'`), 'harness shown in the row');
  await capture('upcoming-harness');
  await click(`[data-job="${job.id}"]`);
  await waitFor(() => js(`document.querySelector('.key-values')?.textContent.includes('Agent harnessFake Agent')`), 'harness shown in the detail');
  await click('[data-action="cancel"]');
  await click('[data-action="confirm-cancel"]');
  await waitFor(() => js(`window.autoContinue.getJob(${JSON.stringify(job.id)}).then(item=>item.status==='canceled')`), 'fake schedule canceled');
  // In-place status refreshes must keep naming the current harness.
  await click('[data-nav="history"]');
  await heading('History');
  await js('window.autoContinue.listJobs({view:"history"})');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(await js(`document.querySelector('#connection-state').textContent`), 'Fake Agent connected');
  await click('[data-nav="settings"]');
  await waitFor(() => js(`Boolean(document.querySelector('#harness-form'))`), 'agent settings card');
  const fakeChecks = fake.state.calls.filter(([name]) => name === 'checkConnection').length;
  const readsBefore = t3Reads;
  await click('#settings-form [data-action="check-t3"]');
  await waitFor(() => js(`document.querySelector('#toast').textContent.includes('Connected to T3 Code.')`), 'T3 settings connection toast');
  assert.ok(t3Reads > readsBefore, 'The T3 settings button checks the T3 API');
  assert.equal(fake.state.calls.filter(([name]) => name === 'checkConnection').length, fakeChecks);
  assert.equal(await js(`document.querySelector('#connection-state').textContent`), 'Fake Agent connected');
  offline = true;
  await waitFor(() => js(`!document.querySelector('[data-action="check-t3"]').disabled`), 'T3 connection check completed');
  await click('#settings-form [data-action="check-t3"]');
  await waitFor(() => js(`Boolean(document.querySelector('#settings-error').textContent)`), 'T3 settings connection failure');
  assert.equal(await js(`document.querySelector('#connection-state').textContent`), 'Fake Agent connected');
  offline = false;
  fakeOffline = true;
  await click('[data-nav="threads"]');
  await waitFor(() => js(`Boolean(document.querySelector('#notices [data-action="check"]'))`), 'selected harness offline banner');
  fakeOffline = false;
  await click('#notices [data-action="check"]');
  await waitFor(() => js(`document.querySelector('#toast').textContent.includes('Connected to Fake Agent.')`), 'selected harness connection toast');
  assert.equal(fake.state.calls.filter(([name]) => name === 'checkConnection').length, fakeChecks + 1);
  await waitFor(() => js(`document.querySelector('#connection-state').textContent === 'Fake Agent connected'`), 'selected harness connection restored');
  await click('[data-nav="settings"]');

  assert.match(await js(`document.querySelector('#harness-form').textContent`), /Works while locked/);
  await fill('#harness-fake-port', '4555');
  await js(`document.querySelector('#harness-form').requestSubmit()`);
  await waitFor(() => js(`window.autoContinue.getSettings().then(settings=>settings.harnesses.fake.port.value===4555)`), 'harness setting saved');
  await js(`document.querySelector('#harness-form').scrollIntoView({block:'center'})`);
  await capture('settings-harnesses');
  // Later checks use T3 Code's connection state.
  await click('[data-nav="threads"]');
  await waitFor(() => js(`Boolean(document.querySelector('#threads-harness'))`), 'threads view');
  await choose('#threads-harness', 't3');
  await waitFor(() => js(`Boolean(document.querySelector('[data-thread="thread-active"]'))`), 'T3 threads again');
  assert.equal(fake.state.submitted.length, 0);
}
async function continuationJourney(js) {
  const click = async selector => {
    await waitFor(() => js(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), `control ${selector}`);
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };
  const fill = async (selector, value) => js(`(() => { const input=document.querySelector(${JSON.stringify(selector)}); input.value=${JSON.stringify(value)}; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const heading = expected => waitFor(() => js(`document.querySelector('h1')?.textContent === ${JSON.stringify(expected)}`), `view ${expected}`);
  const chains = () => js(`window.autoContinue.listJobs({view:'all'}).then(result=>result.jobs.filter(job=>job.harness==='fake'&&job.automation))`);
  await js(`window.autoContinue.saveSettings({httpPort:3773,bufferSeconds:0})`);
  await waitFor(() => js(`window.autoContinue.getSettings().then(settings=>settings.bufferSeconds===0)`), 'zero buffer for fast turns');

  // T3 Code reports completion but not usage limits: turn limits are offered, auto-start is disabled with the reason.
  await click('[data-nav="upcoming"]');
  await click('[data-action="new"]');
  await heading('New schedule');
  await waitFor(() => js(`document.querySelector('#turn-help').textContent.includes('T3 Code reports when each turn finishes')`), 'T3 automation support loaded');
  assert.equal(await js(`document.querySelector('[data-trigger="available"]').disabled`), true);
  assert.equal(await js(`document.querySelector('#wait-if-limited').disabled`), true);
  assert.equal(await js(`document.querySelector('#turn-limit').disabled || document.querySelector('#continuous').disabled`), false);
  assert.match(await js(`document.querySelector('#trigger-help').textContent`), /T3 Code does not report usage limits/);
  await capture('composer-t3-automation');

  // Auto-start with a turn limit of 3 while the fake agent is at a usage limit.
  fake.state.availability = { state: 'limited', resetsAt: new Date(Date.now() + 3000).toISOString(), reason: 'Five-hour limit', source: 'reported' };
  await js('window.autoContinue.scheduleThread("conv-chain", "fake")');
  await waitFor(() => js(`document.querySelector('.thread-picker')?.textContent.includes('Chain fixture session')`), 'fake conversation in composer');
  await click('[data-trigger="available"]');
  await waitFor(() => js(`document.querySelector('[data-trigger="available"]').getAttribute('aria-pressed')==='true'`), 'when available chosen');
  assert.equal(await js(`Boolean(document.querySelector('#date'))`), false, 'No time is asked for');
  await fill('#turn-limit', '3');
  await waitFor(() => js(`document.querySelector('#schedule-preview').textContent.includes('At a usage limit until')`), 'availability shown with its source');
  assert.match(await js(`document.querySelector('#schedule-preview').textContent`), /reported by the agent/);
  assert.match(await js(`document.querySelector('#schedule-preview').textContent`), /Sends up to 3 messages/);
  await capture('composer-auto-start');
  await js(`document.querySelector('#schedule-form').requestSubmit()`);
  await heading('Upcoming');
  await waitFor(() => js(`document.querySelector('.row .pill.waiting')?.textContent === 'Waiting for availability'`), 'waiting row');
  assert.match(await js(`document.querySelector('.row .progress').textContent`), /Turn 1 of 3/);
  assert.equal(fake.state.submitted.length, 0, 'Nothing is sent before the limit resets');
  await capture('upcoming-waiting-for-availability');
  await waitFor(async () => (await chains())[0]?.automation.state === 'finished', 'three turns sent and finished');
  const [finished] = await chains();
  assert.equal(fake.state.submitted.length, 3);
  assert.equal(new Set(fake.state.submitted.map(item => item.deliveryKey)).size, 3);
  assert.equal(finished.automation.sentTurns, 3);
  await click('[data-nav="history"]');
  await click(`[data-job="${finished.id}"]`);
  await waitFor(() => js(`document.querySelectorAll('.turn-list li').length === 3`), 'turn history in detail');
  assert.match(await js(`document.querySelector('.chain-reason').textContent`), /Sent 3 turns, the turn limit/);
  await capture('detail-finished-turn-history');

  // Continuous mode keeps going until stopped from the detail view.
  completionMode = 'manual';
  fake.state.availability = { state: 'available', source: 'reported' };
  await js('window.autoContinue.scheduleThread("conv-chain", "fake")');
  await heading('New schedule');
  await click('[data-trigger="available"]');
  await click('#continuous');
  await waitFor(() => js(`document.querySelector('#turn-limit').disabled && document.querySelector('#schedule-preview').textContent.includes('until you stop it')`), 'continuous mode chosen');
  await js(`document.querySelector('#schedule-form').requestSubmit()`);
  await heading('Upcoming');
  await waitFor(() => fake.state.submitted.length === 4 && pendingCompletions.length === 1, 'first continuous turn sent');
  pendingCompletions.shift()();
  await waitFor(() => fake.state.submitted.length === 5, 'second continuous turn sent');
  await waitFor(() => js(`document.querySelector('.row .progress')?.textContent.includes('Turn 2 · continuous')`), 'continuous progress row');
  assert.equal(await js(`document.querySelector('.notice.continuing strong').textContent`), '1 automatic continuation is running');
  await capture('upcoming-continuous-running');
  const continuous = (await chains()).find(job => job.automation.unlimited);
  await click(`[data-job="${continuous.id}"]`);
  await waitFor(() => js(`Boolean(document.querySelector('[data-action="stop"]'))`), 'stop control');
  await capture('detail-continuous-running');
  await click('[data-action="stop"]');
  await waitFor(() => js(`window.autoContinue.getJob(${JSON.stringify(continuous.id)}).then(job=>job.automation.state==='stopped')`), 'stopped from the detail view');
  pendingCompletions.shift()();
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(fake.state.submitted.length, 5, 'Nothing is sent after Stop');
  await waitFor(() => js(`document.querySelector('.chain-reason')?.textContent.includes('Stopped by you')`), 'stopped detail');
  await capture('detail-continuous-stopped');

  // Stop all from the menu-bar tray.
  await js(`window.autoContinue.createSchedule({harness:'fake',threadId:'conv-chain',message:'Continue',timeZone:'UTC',trigger:'available',continuous:true})`);
  await waitFor(() => fake.state.submitted.length === 6, 'tray fixture turn sent');
  await waitFor(() => Boolean(menu?.find(item => String(item.label).startsWith('Stop all continuations (1)'))), 'tray stop-all item');
  menu.find(item => String(item.label).startsWith('Stop all continuations')).click();
  await waitFor(async () => (await chains()).every(job => job.automation.state !== 'active'), 'tray stopped every continuation');
  pendingCompletions.shift()();
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(fake.state.submitted.length, 6);
  assert.equal(menu.some(item => String(item.label).startsWith('Stop all continuations')), false);
  // Later checks use T3 Code's connection state.
  const choose = async (selector, value) => js(`(() => { const select=document.querySelector(${JSON.stringify(selector)}); select.value=${JSON.stringify(value)}; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await click('[data-nav="threads"]');
  await waitFor(() => js(`Boolean(document.querySelector('#threads-harness'))`), 'threads view');
  await choose('#threads-harness', 't3');
  await waitFor(() => js(`Boolean(document.querySelector('[data-thread="thread-active"]'))`), 'T3 threads again');
}
async function keepAwakeJourney(js) {
  const click = async selector => {
    await waitFor(() => js(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), `control ${selector}`);
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };
  const submit = async () => {
    await js(`document.querySelector('#keep-awake-form').requestSubmit()`);
    await waitFor(() => js(`Boolean(document.querySelector('#keep-awake-form')) && !document.querySelector('#keep-awake-form button[type="submit"]').disabled`), 'keep-awake settings saved');
  };
  const held = expected => waitFor(() => JSON.stringify(ownAssertions().map(line => line.split(' ')[2])) === JSON.stringify(expected), `assertions ${JSON.stringify(expected)}; saw ${JSON.stringify(ownAssertions())}`);
  await js(`window.scrollTo(0,0)`);
  await click('[data-nav="settings"]');
  await waitFor(() => js(`Boolean(document.querySelector('#keep-awake-form'))`), 'keep-awake settings card');
  assert.match(await js(`document.querySelector('#ka-status').textContent`), /Off/);
  await held([]);
  // The renderer journey confirmed a delivery, whose agent turn keep-awake follows until the job service's
  // next turn poll (every 30 seconds in the app) settles it; poll now so this journey starts with nothing to track.
  await vm.runInContext('service.pollTurns()', mainContext);
  assert.equal(vm.runInContext('service.activeWork().length', mainContext), 0);
  await click('#ka-enabled');
  await submit();
  await waitFor(() => js(`window.autoContinue.getKeepAwake().then(state => state.enabled && state.state === 'off')`), 'enabled with nothing to track');
  await held([]);
  const job = await js(`window.autoContinue.createSchedule({ threadId: 'thread-active', message: 'Keep-awake fixture', whenISO: new Date(Date.now() + 7200000).toISOString(), timeZone: 'UTC' })`);
  await waitFor(() => js(`window.autoContinue.getKeepAwake().then(state => state.state === 'armed')`), 'armed for the pending schedule');
  await held(['NoIdleSleepAssertion']);
  const evidence = { armed: ownAssertions() };
  await waitFor(() => js(`document.querySelector('#notices .notice.awake')?.textContent.includes('Keeping your Mac awake')`), 'keep-awake notice');
  assert.match(await js(`document.querySelector('#ka-status').textContent`), /Waiting for 1 scheduled task/);
  assert.ok(menu.find(item => item.label === 'Keeping Mac awake · 1 task'), 'Tray shows the keep-awake state');
  // The keep-awake glyph is a real decodable template image, like the idle one checked at the end.
  assert.equal(trayImage.isEmpty(), false, 'The keep-awake menu-bar icon must contain pixels');
  assert.equal(trayImage.isTemplateImage(), true);
  assert.ok(trayImage.getScaleFactors().includes(2), 'The keep-awake menu-bar icon needs a Retina representation');
  assert.equal(trayImage.toPNG().equals(nativeImageFor('trayAwakeTemplate.png').toPNG()), true, 'The tray shows the keep-awake glyph while holding');
  await click('[data-nav="upcoming"]');
  await click('#notices .notice.awake summary');
  await capture('keep-awake-notice');
  await click('[data-nav="settings"]');
  await click('#ka-display');
  await submit();
  await held(['NoDisplaySleepAssertion']);
  await js(`document.querySelector('#keep-awake-form').closest('.card').scrollIntoView({block:'center'})`);
  await capture('keep-awake-settings');
  evidence.display = ownAssertions();
  await click('#notices [data-action="keep-awake-stop"]');
  await held([]);
  await waitFor(() => js(`document.querySelector('#notices .notice.awake')?.textContent.includes('Your Mac can sleep')`), 'stopped notice');
  await capture('keep-awake-stopped');
  await click('#notices [data-action="keep-awake-resume"]');
  await held(['NoDisplaySleepAssertion']);
  // The production controller reaches its time limit: its clock moves past the deadline.
  const controller = vm.runInContext('keepAwake', mainContext);
  const hours = (await js('window.autoContinue.getKeepAwake()')).settings.maxHours;
  controller.now = () => Date.now() + (hours + 1) * 3_600_000;
  controller.evaluate();
  await held([]);
  await click('[data-nav="upcoming"]');
  await waitFor(() => js(`document.querySelector('#notices .notice.awake')?.textContent.includes('reached the time limit')`), 'capped notice');
  const capped = await js(`(() => { const notice = document.querySelector('#notices .notice.awake'); notice.querySelector('details').open = true; return { title: notice.querySelector('strong').textContent, summary: notice.querySelector('summary').textContent, items: [...notice.querySelectorAll('li')].map(item => item.textContent), button: notice.querySelector('button')?.textContent }; })()`);
  assert.equal(capped.title, 'Your Mac can sleep');
  assert.equal(capped.summary, '1 task reached the time limit');
  assert.equal(capped.items.length, 1);
  assert.match(capped.items[0], /^Production renderer test · Scheduled message waiting to send · starts .* · reached the time limit$/);
  assert.equal(capped.button, 'Keep awake again');
  assert.ok(menu.find(item => item.label === 'Keep Mac awake again'), 'Tray offers to override the limit');
  await js(`document.querySelector('#toast-dismiss')?.click()`);
  await capture('keep-awake-capped');
  await click('#notices [data-action="keep-awake-resume"]');
  await held(['NoDisplaySleepAssertion']);
  controller.now = () => Date.now();
  await click('[data-nav="settings"]');
  await click('#ka-enabled');
  await submit();
  await held([]);
  assert.equal(await js(`Boolean(document.querySelector('#notices .notice.awake'))`), false);
  await js(`window.autoContinue.cancelJob(${JSON.stringify(job.id)})`);
  if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, 'keep-awake-assertions.json'), JSON.stringify(evidence, null, 2));
}
// A desktop app update is noticed before the schedule fires: the dashboard names
// the app and version, marks the schedule at risk, copies diagnostics and clears
// the notice once the app checks out again. Captured in both themes.
async function compatibilityJourney(js) {
  const click = async selector => {
    await waitFor(() => js(`Boolean(document.querySelector(${JSON.stringify(selector)})) && !document.querySelector(${JSON.stringify(selector)}).disabled`), `control ${selector}`);
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };
  const heading = expected => waitFor(() => js(`document.querySelector('h1')?.textContent === ${JSON.stringify(expected)}`), `view ${expected}`);
  desk.state.compatibility = ({ depth }) => depth === 'quick' ? supported : { ...supported, appVersion: '2.17.0', checked: ['app_path', 'deep_link', 'content_match'], unchecked: [{ contactPoint: 'send_label', reason: 'no_composer' }],
    problems: [{ contactPoint: 'composer_label', message: 'Claude Desktop 2.17.0 changed how its message box is labelled. Scheduled messages for it may fail until Agent Auto-Continue supports this version.', hint: 'A conversation was shown, but no text area labelled "Prompt" or "Write your prompt to Claude" was found in it. Interface language: en-US.' }] };
  await click('[data-nav="upcoming"]');
  await heading('Upcoming');
  const job = await js(`window.autoContinue.createSchedule({ harness: 'desk', threadId: 'local_fixture', message: 'Continue with the next step', whenISO: '2099-10-02T09:30:00Z', timeZone: 'UTC' })`);
  await waitFor(() => js(`document.querySelector('#notices').textContent.includes('Claude Desktop 2.17.0 isn’t supported yet')`), 'compatibility notice');
  await waitFor(() => js(`Boolean(document.querySelector(${JSON.stringify(`[data-job="${job.id}"] .pill.risk`)}))`), 'schedule marked at risk');
  assert.match(await js(`document.querySelector('#notices').textContent`), /changed how its message box is labelled[\s\S]*One scheduled message is at risk/);
  assert.equal((await js(`window.autoContinue.getJob(${JSON.stringify(job.id)})`)).status, 'pending', 'A risk never cancels a schedule');
  await js(`document.querySelector('#notices details').open = true; document.querySelector('#toast').hidden = true`);
  await capture('compatibility-notice-dark');
  await click('[data-action="theme"]');
  await waitFor(() => js(`!document.body.classList.contains('dark')`), 'light theme');
  await js(`document.querySelector('#notices details').open = true`);
  await capture('compatibility-notice-light');
  await click(`[data-job="${job.id}"]`);
  await waitFor(() => js(`Boolean(document.querySelector('.risk-detail'))`), 'risk shown in the detail');
  assert.equal(await js(`document.querySelector('.detail-header .pill.risk')?.textContent`), 'At risk');
  await js(`document.querySelector('.risk-detail').scrollIntoView({block:'center'})`);
  await capture('compatibility-detail-light');
  await click('[data-action="theme"]');
  await waitFor(() => js(`document.body.classList.contains('dark')`), 'dark theme');
  await js(`document.querySelector('.risk-detail').scrollIntoView({block:'center'})`);
  await capture('compatibility-detail-dark');
  await click('#notices [data-action="copy-diagnostics"]');
  await waitFor(() => copied.length === 1, 'diagnostics copied');
  assert.match(copied[0], /- desk: Claude Desktop 2\.17\.0, verified 2\.16120\.0[\s\S]*composer_label/);
  assert.doesNotMatch(copied[0], /Continue with the next step|Refactor the scheduler/, 'Diagnostics never contain message text or titles');
  await waitFor(() => js(`document.querySelector('#toast').textContent.includes('Diagnostics copied')`), 'copy toast');
  desk.state.compatibility = supported;
  await click('#notices [data-action="recheck-compatibility"]');
  await waitFor(() => js(`!document.querySelector('#notices').textContent.includes('supported yet')`), 'notice cleared after a passing check');
  await waitFor(() => js(`!document.querySelector('.risk-detail')`), 'risk cleared in the detail');
  await click('[data-action="cancel"]');
  await click('[data-action="confirm-cancel"]');
  await waitFor(() => js(`window.autoContinue.getJob(${JSON.stringify(job.id)}).then(item=>item.status==='canceled')`), 'desktop schedule canceled');
}
// A hung window must fail the run rather than block CI or a shell indefinitely.
// Before the app is ready (for example while macOS is locked) app.exit() is ignored, so force the exit.
const HARD_TIMEOUT_MS = Number(process.env.T3_SMOKE_TIMEOUT_MS) || 180_000;
const hardTimeout = setTimeout(() => { console.error(`Electron smoke timed out after ${HARD_TIMEOUT_MS / 1000} seconds. Is the screen locked?`); app.exit(1); setTimeout(() => process.exit(1), 2000); }, HARD_TIMEOUT_MS);
run().then(() => { clearTimeout(hardTimeout); app.exit(0); }, error => { clearTimeout(hardTimeout); console.error(error.stack); app.exit(1); });
