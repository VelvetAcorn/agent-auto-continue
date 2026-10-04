'use strict';
// Executes the production main process, preload and renderer against in-memory
// storage and an injected API. No network request or scheduled POST can occur.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const electron = require('electron');
const { app } = electron;
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
const updaterModule = require('../lib/updater');
// The production updater is off here because the fixture is not a packaged app. To exercise the
// update notice, the tray item and the restart prompt, the fixture forces it on with this
// in-memory stand-in for electron-updater, so nothing is downloaded and nothing quits.
const fakeAutoUpdater = Object.assign(new (require('node:events').EventEmitter)(), {
  installs: 0, checks: 0,
  result: 'none',
  async checkForUpdates() { this.checks++; this.emit('checking-for-update'); if (this.result === 'none') this.emit('update-not-available', {}); else this.emit('update-available', { version: this.result }); },
  quitAndInstall() { this.installs++; }
});
const dialogs = [];
const harnessModule = require('../lib/harnesses');
const { createT3Harness } = require('../lib/harnesses/t3');
const { createFakeHarness } = require('./fake-harness.cjs');
const { HarnessError } = require('../lib/harnesses/errors');
// A second, in-memory harness exercises the picker without touching real agents.
const fake = createFakeHarness({ label: 'Fake Agent', conversations: [{ id: 'conv-fake', title: 'Fake conversation', projectName: 'Fake repo', updatedAt: '2026-09-30T10:00:00Z' }, { id: 'conv-chain', title: 'Chain fixture session', projectName: 'fake-repo', updatedAt: '2026-09-30T09:00:00Z' }], settings: [{ key: 'port', type: 'port', label: 'Fake agent port', default: 4096, help: 'Fixture setting.' }] });
// An in-memory desktop app whose installed version can drift, for the compatibility notice.
const supported = { appVersion: '2.16120.0', verifiedVersion: '2.16120.0', problems: [], checked: ['app_path', 'deep_link', 'content_match', 'composer_label', 'send_label'], unchecked: [] };
const desk = createFakeHarness({ id: 'desk', label: 'Claude Desktop', kind: 'desktop-app', compatibility: supported,
  capabilities: { requiresRunningApp: true, requiresUnlockedScreen: true, requiresAccessibilityPermission: true },
  conversations: [{ id: 'local_fixture', title: 'Refactor the scheduler', projectName: 'agent-auto-continue', updatedAt: '2026-09-30T11:00:00Z' }] });
// Automatic continuations run end to end against the fake harness; each turn
// completes on its own after 300 ms, or when the journey releases it with an outcome.
let completionMode = 'auto';
const pendingCompletions = [];
fake.state.completion = () => new Promise((resolve) => {
  const finish = (outcome = { state: 'completed' }) => resolve({ ...outcome, completedAt: new Date().toISOString() });
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
    // A renderer error is a failed run, not a silent blank screen.
    this.webContents.on('console-message', (event) => { if (event.level === 'error') { failures.push(`Renderer console: ${event.message} (${event.sourceId}:${event.lineNumber})`); console.error(failures.at(-1)); } });
  }
  // Electron's getAllWindows() filters by constructor name and does not list subclassed windows,
  // which silently dropped main-process broadcasts (jobs:changed, settings:changed, keep-awake:changed).
  static getAllWindows() { return windows.filter(window => !window.isDestroyed()); }
  show() { /* Keep executable tests out of the user's foreground. */ }
  focus() { /* Keep executable tests out of the user's foreground. */ }
}
const injectedElectron = {
  ...electron, app: appProxy, BrowserWindow: FixtureWindow,
  Tray: class { constructor(image) { trayImage = image; } setImage(image) { trayImage = image; } setToolTip() {} on() {} popUpContextMenu() {} },
  Menu: { buildFromTemplate: value => { menu = value; return value; } }, Notification: { isSupported: () => false },
  shell: { openExternal: async url => { externalUrls.push(url); } },
  clipboard: { writeText: text => { copied.push(text); } },
  // Native message boxes would block the run; the fixture records them and answers with the first button.
  dialog: { showMessageBox: async options => { dialogs.push(options); return { response: 0 }; } },
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
      if (name === './lib/updater') return { ...updaterModule, createUpdater: options => updaterModule.createUpdater({ ...options, enabled: true, startupDelayMs: 3_600_000, loadAutoUpdater: () => fakeAutoUpdater }) };
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
  assert.equal(window.isResizable(), false, 'The rail is a fixed-width popover');
  window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  // CI runners may have Reduce motion switched on; pin the OS preference so motion checks are deterministic.
  const reducedMotion = value => window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value }] });
  await reducedMotion('no-preference');
  const js = code => window.webContents.executeJavaScript(code, true);
  await waitFor(() => js('Boolean(window.autoContinue && document.querySelector("#main") && document.querySelector(".head"))'), 'production renderer initialized');
  // No config.json means a first run, which opens Settings so the agents can be set up.
  assert.equal(await js('document.body.classList.contains("view-settings")'), true, 'A first run opens Settings');
  await waitFor(() => js('document.body.classList.contains("layout-rail")'), 'rail layout reported to the renderer');
  await setTheme(js, 'light');
  assert.equal(windows.length, 1);
  assert.equal((await js('window.autoContinue.listJobs({view:"history"})')).total, 2);
  await js('window.autoContinue.openSettings()');
  await waitFor(() => js('document.body.classList.contains("view-settings")'), 'settings route');
  await js('window.autoContinue.scheduleThread("thread-active")');
  await waitFor(() => js(`document.querySelector('#pick')?.textContent.includes('Production renderer test')`), 'tray route chooses the conversation');
  assert.equal(windows.length, 1);
  await rendererJourney(js, reducedMotion);
  await keepAwakeJourney(js);
  await harnessJourney(js);
  await continuationJourney(js);
  await compatibilityJourney(js);
  await permissionJourney(js);
  offline = true;
  const history = await js('window.autoContinue.listJobs({view:"history"})');
  assert.ok(history.total >= 1, 'History survives offline API');
  const connection = await js('window.autoContinue.checkConnection()');
  assert.equal(connection.error.code, 'unexpected_response_format');
  // The picker re-reads every shown agent; T3 Code's dot and note show the outage without exposing the raw HTML.
  await click(js, '[data-action="back"]', { optional: true });
  await click(js, '#pick');
  await waitFor(() => js(`Boolean(document.querySelector('.picker [data-agent-badge="t3"] .dot.off')) || Boolean(document.querySelector('.head [data-agent-badge="t3"] .dot.off'))`), 'visible offline state');
  assert.match(await js(`document.querySelector('.picker .note')?.textContent || ''`), /T3 Code/);
  assert.equal(await js(`document.body.innerText.includes('Fixture outage')`), false, 'raw HTML from the API never reaches the screen');
  await capture('picker-offline');
  offline = false;
  await click(js, '.picker .note [data-action="check"]');
  await waitFor(() => js(`document.querySelector('#toast').textContent.includes('Connected to T3 Code.')`), 'connection recovery');
  await waitFor(() => js(`Boolean(document.querySelector('.picker [data-agent-badge="t3"] .dot.ok')) && !document.querySelector('.picker .note')`), 'connection recovery clears current failure');
  await click(js, '[data-action="back"]');
  await waitFor(() => js(`Boolean(document.querySelector('.head [data-agent-badge="t3"] .dot.ok'))`), 'header mark recovered');
  assert.equal(await js(`document.querySelector('#notices').textContent.includes('unexpected')`), false);
  if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, 'persisted-fixture-jobs.json'), files.get('/fixture/jobs.json'));
  assert.equal(dispatches, 0, 'The fixture must never send a message');
  assert.equal(fake.state.submitted.filter(item => item.conversationId !== 'conv-chain').length, 0, 'Only the continuation journey sends, and only to its fake session');
  assert.equal(desk.state.submitted.length, 0, 'The fake desktop app must never send a message');
  assert.deepEqual(failures, []);
  assert.ok(menu.find(item => item.label === 'Open'));
  assert.ok(menu.find(item => item.label === 'Open as a window'));
  // The real nativeImage decodes the tray glyph, so an unreadable or undecodable asset fails here.
  assert.equal(trayImage.isEmpty(), false, 'The menu-bar icon must contain pixels');
  assert.deepEqual(trayImage.getSize(), { width: 18, height: 18 });
  assert.equal(trayImage.isTemplateImage(), true, 'The menu-bar icon must adapt to light and dark menu bars');
  assert.ok(trayImage.getScaleFactors().includes(2), 'The menu-bar icon needs a Retina representation');
  assert.equal(trayImage.toPNG().equals(nativeImageFor('trayTemplate.png').toPNG()), true, 'The idle glyph returns once keep-awake lets the Mac sleep');
  assert.equal(windows.length, 1, 'Every journey stayed in the same window');
  await layoutJourney(js);
  await updateJourney();
  console.log('Electron production workflow smoke passed: rail and window layouts, update notice and restart prompt, real preload/IPC/renderer, local history, sanitized offline error, keep-awake assertions released, zero T3 sends, and fake-harness continuations (auto-start, turn limit, continuous, stop phrase edits while running and paused, stop, tray stop all), agent arrangement, a desktop app compatibility notice and Open System Settings for a missing Accessibility permission.');
}
// Shared DOM helpers. `click` waits for the control; `fill` types through the input event the renderer listens to.
async function click(js, selector, { optional = false } = {}) {
  if (optional && !(await js(`Boolean(document.querySelector(${JSON.stringify(selector)}))`))) return;
  await waitFor(() => js(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); return Boolean(node) && !node.disabled; })()`), `control ${selector}`);
  await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
}
const fill = (js, selector, value) => js(`(() => { const input=document.querySelector(${JSON.stringify(selector)}); input.value=${JSON.stringify(value)}; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
const view = (js, name) => waitFor(() => js(`document.body.classList.contains(${JSON.stringify('view-' + name)})`), `view ${name}`);
// Opens Settings, makes sure a section is open, and leaves the view where the caller wants it.
async function openSection(js, section) {
  if (!(await js(`document.body.classList.contains('view-settings')`))) { await click(js, '[data-action="back"]', { optional: true }); await click(js, '[data-action="settings"]'); await view(js, 'settings'); }
  if (!(await js(`document.querySelector(${JSON.stringify(`[data-section="${section}"]`)}).getAttribute('aria-expanded') === 'true'`))) await click(js, `[data-section="${section}"]`);
  await waitFor(() => js(`Boolean(document.querySelector(${JSON.stringify(`#section-${section}`)}))`), `section ${section}`);
}
async function goHome(js) {
  if (await js(`document.body.classList.contains('view-home')`)) return;
  await click(js, '[data-action="back"]');
  if (!(await js(`document.body.classList.contains('view-home')`))) await click(js, '[data-action="back"]', { optional: true });
  await view(js, 'home');
}
async function setTheme(js, value) {
  const wasHome = await js(`document.body.classList.contains('view-home')`);
  await openSection(js, 'appearance');
  await click(js, `[data-theme="${value}"]`);
  await waitFor(() => js(`document.body.classList.contains('dark') === ${JSON.stringify(value === 'dark')}`), `${value} theme`);
  if (wasHome) await goHome(js);
}
async function rendererJourney(js, reducedMotion) {
  await js('window.__jobsChanged = 0; window.autoContinue.onJobsChanged(() => window.__jobsChanged++); 0');
  assert.equal(await js('document.title'), 'Agent Auto-Continue', 'The window title uses the app name');
  // The message line opens into a text area only when asked.
  assert.equal(await js(`Boolean(document.querySelector('#message'))`), false);
  await click(js, '[data-action="edit-message"]');
  await fill(js, '#message', 'Fixture message from the production composer');
  await click(js, '[data-when="custom"]');
  await fill(js, '#date', '2099-02-30');
  await fill(js, '#time', '12:00');
  await fill(js, '#timezone', 'UTC');
  await js(`document.querySelector('#continue-form').requestSubmit()`);
  assert.match(await js(`document.querySelector('#plan-error').textContent`), /real calendar/);
  await fill(js, '#date', '2099-12-15');
  await waitFor(() => js(`document.querySelector('#plan').textContent.includes('2099-12-15 12:00 UTC+00:00 · once')`), 'plan sentence follows the custom time');
  await capture('home-custom-time');
  await js(`document.querySelector('#continue-form').requestSubmit()`);
  await waitFor(() => js(`document.querySelector('#toast').textContent.includes('Queued.')`), 'queued toast');
  const created = await js(`window.autoContinue.listJobs({view:'upcoming'}).then(result=>result.jobs.find(job=>job.message==='Fixture message from the production composer'))`);
  assert.ok(created);
  assert.equal(created.timeZone, 'UTC');
  assert.equal(created.scheduleAt, '2099-12-15T12:00:00.000Z');
  assert.equal(created.effectiveAt, '2099-12-15T12:00:05.000Z');
  assert.ok(await js('window.__jobsChanged') > 0, 'Main-process jobs:changed broadcasts reach the renderer');
  await waitFor(() => js(`Boolean(document.querySelector(${JSON.stringify(`[data-job="${created.id}"]`)}))`), 'queued row');
  assert.match(await js(`document.querySelector('.qhead .overline').textContent`), /Queued · 1/);
  assert.equal(await js(`document.querySelector('#pick').textContent.includes('Choose a')`), true, 'the draft resets after queuing');
  await capture('home-queued');
  // Edit from the row's hover actions, then cancel from the detail with confirmation.
  await click(js, `[data-job="${created.id}"] [data-action="edit"]`);
  await waitFor(() => js(`document.querySelector('.editing') && document.querySelector('#continue').textContent === 'Save changes'`), 'editing state');
  assert.equal(await js(`document.querySelector('#pick').disabled`), true, 'the conversation cannot change while editing');
  assert.equal(await js(`document.querySelector('[data-when="custom"]').getAttribute('aria-pressed')`), 'true');
  await click(js, '[data-action="edit-message"]');
  await fill(js, '#message', 'Fixture message edited');
  await fill(js, '#time', '14:00');
  await capture('home-editing');
  await js(`document.querySelector('#continue-form').requestSubmit()`);
  await waitFor(() => js(`window.autoContinue.getJob(${JSON.stringify(created.id)}).then(job => job.message === 'Fixture message edited' && job.scheduleAt === '2099-12-15T14:00:00.000Z')`), 'edited schedule persisted');
  await click(js, `[data-open="${created.id}"]`);
  await view(js, 'detail');
  await click(js, '[data-action="cancel"]');
  await click(js, '[data-action="confirm-cancel"]');
  await waitFor(() => js(`window.autoContinue.getJob(${JSON.stringify(created.id)}).then(job=>job.status==='canceled')`), 'canceled schedule persisted');
  await waitFor(() => js(`Boolean(document.querySelector('[data-action="again"]'))`), 'canceled detail refreshed');
  await capture('detail-canceled');
  await click(js, '[data-action="back"]');
  await view(js, 'home');
  await waitFor(() => js(`document.querySelectorAll('.recent [data-job]').length >= 1`), 'recent rows');
  await click(js, '[data-action="history"]');
  await view(js, 'history');
  await click(js, '[data-open="failure-fixture"]');
  await view(js, 'detail');
  assert.equal(await js(`Boolean(document.querySelector('[data-action="again"]'))`), false);
  assert.equal(await js(`document.querySelector('.detail-header .pill').textContent`), 'Delivery unconfirmed');
  await click(js, '[data-action="reconcile"]');
  await waitFor(() => js(`window.autoContinue.getJob('failure-fixture').then(job=>Boolean(job.lastReconciledAt))`), 'legacy reconciliation recorded');
  await waitFor(() => js(`!document.querySelector('[data-action="reconcile"]').disabled`), 'legacy reconciliation completed');
  assert.equal(await js(`Boolean(document.querySelector('[data-action="again"]'))`), false);
  await click(js, '[data-action="ack"]');
  await waitFor(() => js(`window.autoContinue.getJob('failure-fixture').then(job=>Boolean(job.acknowledgedAt))`), 'acknowledgment persisted');
  await waitFor(() => js(`document.querySelector('[data-action="ack"]')?.textContent.includes('Acknowledged')`), 'acknowledged UI');
  await capture('detail-acknowledged');
  assert.equal((await js(`window.autoContinue.listJobs({view:'history'})`)).unacknowledgedFailures, 1);
  // The user looked in the thread and the message is not there: marking it asks first, then frees Continue again.
  assert.equal(await js(`Boolean(document.querySelector('[data-action="again"]'))`), false, 'An unconfirmed delivery cannot be scheduled again');
  await click(js, '[data-action="mark-not-delivered"]');
  await waitFor(() => js(`Boolean(document.querySelector('[data-action="confirm-mark"]'))`), 'confirmation before marking');
  await capture('detail-mark-not-delivered');
  await click(js, '[data-action="confirm-mark"]');
  await waitFor(() => js(`window.autoContinue.getJob('failure-fixture').then(job => job.deliveryCertainty === 'not-delivered' && job.notDeliveredMarks?.length === 1)`), 'not-delivered assertion recorded');
  await waitFor(() => js(`Boolean(document.querySelector('[data-action="again"]')) && !document.querySelector('[data-action="mark-not-delivered"]')`), 'marked delivery can be continued again');
  await click(js, '[data-action="back"]');
  await view(js, 'history');
  await click(js, '[data-open="uncertain-fixture"]');
  await click(js, '[data-action="reconcile"]');
  await waitFor(() => js(`window.autoContinue.getJob('uncertain-fixture').then(job=>Boolean(job.lastReconciledAt))`), 'first reconciliation recorded');
  await waitFor(() => js(`!document.querySelector('[data-action="reconcile"]').disabled`), 'first reconciliation completed');
  assert.equal((await js(`window.autoContinue.getJob('uncertain-fixture')`)).status, 'unconfirmed');
  fixtureThread.messages.push({ id: 'uncertain-message', role: 'user', createdAt: '2026-01-01T10:00:00Z' });
  await click(js, '[data-action="reconcile"]');
  await waitFor(() => js(`window.autoContinue.getJob('uncertain-fixture').then(job=>job.status==='sent')`), 'existing message confirmed without resend');
  await waitFor(() => js(`Boolean(document.querySelector('[data-action="again"]'))`), 'confirmed detail refreshed');
  assert.equal((await js(`window.autoContinue.listJobs({view:'history'})`)).unacknowledgedFailures, 0);
  await click(js, '[data-action="back"]');
  await click(js, '[data-action="back"]');
  await view(js, 'home');
  // The picker merges every shown agent and hides settled conversations until asked.
  await click(js, '#pick');
  await view(js, 'picker');
  await waitFor(() => js(`Boolean(document.querySelector('[data-thread="thread-active"]'))`), 'thread data loaded');
  assert.equal(await js(`Boolean(document.querySelector('[data-thread="thread-settled"]'))`), false);
  assert.match(await js(`document.querySelector('[data-thread="thread-active"] small').textContent`), /T3 Code · Fixture project · .*ago/);
  await capture('picker');
  await click(js, '[data-action="toggle-settled"]');
  assert.equal(await js(`Boolean(document.querySelector('[data-thread="thread-settled"]'))`), true);
  await click(js, '[data-thread="thread-active"]');
  await view(js, 'home');
  assert.match(await js(`document.querySelector('#pick').textContent`), /Production renderer test/);
  // Settings: support sticker, Ko-fi, the safety buffer and the theme.
  await openSection(js, 'support');
  await openSection(js, 'appearance');
  await supportStarJourney(js, reducedMotion);
  await click(js, '[data-action="support"]');
  await waitFor(() => externalUrls.length === 1, 'support page opened in browser');
  assert.deepEqual(externalUrls, ['https://ko-fi.com/velvetacorn']);
  await waitFor(() => js(`!document.querySelector('[data-action="support"]').disabled`), 'support operation finished');
  assert.ok(windows[0].webContents.getURL().startsWith('file:'), 'Support must leave the app on its local page');
  await openSection(js, 'advanced');
  await fill(js, '#buffer', '12');
  await js(`document.querySelector('#advanced-form').requestSubmit()`);
  await waitFor(() => js(`window.autoContinue.getSettings().then(settings=>settings.bufferSeconds===12)`), 'settings saved');
  await waitFor(() => js(`!document.querySelector('#buffer').disabled`), 'settings operation finished');
  assert.equal(await js(`document.body.classList.contains('dark')`), false, 'Day is the default appearance');
  await click(js, '[data-theme="dark"]');
  assert.equal(await js(`document.body.classList.contains('dark')`), true);
  assert.equal(await js(`document.querySelector('.themes').textContent.trim()`), '', 'The appearance switch is pictures only');
  await fill(js, '#painting', '45');
  assert.equal(await js(`getComputedStyle(document.documentElement).getPropertyValue('--art').trim()`), '0.45', 'The painting slider sets how strongly the painting shows');
  await fill(js, '#painting', '30');
  assert.equal(await js(`Boolean(document.querySelector('.star svg'))`), true);
  await capture('settings-bone-outline');
  await js(`document.querySelector('.support').scrollIntoView({block:'center'})`);
  await capture('settings-support');
  await remoteJourney(js);
  assert.equal(windows.length, 1, 'Every journey stayed in the same window');
}
async function supportStarJourney(js, reducedMotion) {
  const phrase = () => js(`document.querySelector('#star-phrase').textContent`);
  const phrases = await js('window.SupportStar.STICKER_PHRASES');
  const star = await js(`(() => { const star=document.querySelector('#support-star'); return { tag: star.tagName, name: star.getAttribute('aria-label'), described: star.getAttribute('aria-describedby'), lines: star.querySelectorAll('.star-text span').length, fit: star.querySelector('.star-text').style.getPropertyValue('--fit') }; })()`);
  assert.deepEqual({ ...star, fit: Number(star.fit) > 0 }, { tag: 'BUTTON', name: 'Shuffle sticker phrase', described: 'star-phrase', lines: star.lines, fit: true });
  assert.ok(star.lines >= 1 && phrases.includes(await phrase()));
  // Re-renders keep the phrase; leaving and re-entering Settings picks a different one.
  const entered = await phrase();
  await click(js, '#motion');
  await click(js, '#motion');
  assert.equal(await phrase(), entered);
  await goHome(js);
  await openSection(js, 'support');
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
  await openSection(js, 'appearance');
  const motion = await js(`new Promise(resolve => {
    const angle = () => parseFloat(document.querySelector('#support-star polygon').style.transform.slice(7));
    const samples = [], start = performance.now(), before = document.querySelector('#star-phrase').textContent;
    document.querySelector('#support-star').click();
    // Opening another Settings section re-renders the whole screen while the star keeps spinning.
    setTimeout(() => document.querySelector('[data-section="advanced"]').click(), 300);
    (function frame(now) { samples.push([now, angle()]); if (now - start < 1400) requestAnimationFrame(frame); else resolve({ samples, changed: document.querySelector('#star-phrase').textContent !== before, status: document.querySelector('#star-status').textContent }); })(start);
  })`);
  assert.equal(motion.changed, true);
  const steps = motion.samples.slice(1).map(([time, angle], index) => ({ elapsed: time - motion.samples[index][0], turned: (angle - motion.samples[index][1] + 360) % 360 }));
  const total = steps.reduce((sum, step) => sum + step.turned, 0), evidence = JSON.stringify({ frames: steps.length, total, span: motion.samples.at(-1)[0] - motion.samples[0][0] });
  // Frame-by-frame motion, not one jump: the per-step check below bounds every step by its elapsed time.
  // The count only rules out a handful of jumps; CI runners paint as few as about 14 frames a second.
  assert.ok(steps.length >= 10, `the star animates frame by frame ${evidence}`);
  for (const step of steps) assert.ok(step.turned <= 480 * Math.max(step.elapsed, 17) / 1000 + 0.5, `angle jumped ${JSON.stringify(step)}`);
  // Idle alone turns about 56 degrees in 1.4 s; the burst adds roughly 190 more.
  assert.ok(total > 150, `the click produced a fast burst ${evidence}`);
  // Reduced motion (app toggle or OS): no spin or burst, but a click still changes the phrase.
  const still = () => js(`new Promise(resolve => { const angle = () => document.querySelector('#support-star polygon').style.transform, before = document.querySelector('#star-phrase').textContent; document.querySelector('#support-star').click(); const first = angle(); setTimeout(() => resolve({ moved: angle() !== first, changed: document.querySelector('#star-phrase').textContent !== before }), 400); })`);
  await click(js, '#motion');
  assert.equal(await js(`document.querySelector('#motion').checked`), true);
  assert.deepEqual(await still(), { moved: false, changed: true });
  await click(js, '#motion');
  await reducedMotion('reduce');
  assert.deepEqual(await still(), { moved: false, changed: true });
  await reducedMotion('no-preference');
  const first = await js(`document.querySelector('#support-star polygon').style.transform`);
  await waitFor(async () => (await js(`document.querySelector('#support-star polygon').style.transform`)) !== first, 'spin resumes when reduced motion ends');
}
// Turns on remote control from Settings, then drives the real listener over HTTP and MCP.
async function remoteJourney(js) {
  const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
  const server = require('node:net').createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  await openSection(js, 'remote');
  await waitFor(() => js(`Boolean(document.querySelector('#remote-form'))`), 'remote settings loaded');
  assert.equal(await js(`document.querySelector('#remote-enabled').checked`), false, 'remote control is off by default');
  assert.equal(await js(`document.querySelector('#remote-bind').value`), '', 'loopback only by default');
  await js(`(() => { const box=document.querySelector('#remote-enabled'); box.checked=true; box.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await fill(js, '#remote-port', String(port));
  await js(`document.querySelector('#remote-form').requestSubmit()`);
  await waitFor(() => js(`Boolean(document.querySelector('.remote-listeners .pill.sent'))`), 'remote listener running');
  await js(`document.querySelector('#remote-form').scrollIntoView({block:'start'})`);
  await capture('settings-remote-listening');
  assert.match(await js(`document.querySelector('.remote-endpoints').textContent`), new RegExp(`http://127\\.0\\.0\\.1:${port}/mcp`));
  await fill(js, '#remote-token-label', 'Smoke phone');
  await js(`document.querySelector('#remote-token-form').requestSubmit()`);
  await waitFor(() => js(`Boolean(document.querySelector('.token-reveal img'))`), 'token revealed once');
  await waitFor(() => js(`document.querySelector('.token-reveal img').complete && document.querySelector('.token-reveal img').naturalWidth > 0`), 'QR code rendered');
  const token = await js(`document.querySelector('#remote-new-token').textContent`);
  assert.match(token, /^aac_[A-Za-z0-9_-]{43}$/);
  // Electron's clipboard API is asynchronous.
  const previousClipboard = await electron.clipboard.readText();
  try {
    await click(js, '[data-action="remote-copy"]');
    await waitFor(async () => (await electron.clipboard.readText()) === token, 'token copied to the clipboard');
  } finally {
    await electron.clipboard.writeText(previousClipboard);
  }
  await js(`document.querySelector('#toast-dismiss')?.click(); document.querySelector('.token-reveal').scrollIntoView({block:'center'})`);
  await capture('settings-remote-token');
  const call = (method, route, body) => fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await call('GET', '/v1/status')).status, 200);
  const created = await call('POST', '/v1/jobs', { threadId: fixtureThread.id, message: 'Scheduled from the smoke phone', delayMinutes: 90 });
  assert.equal(created.status, 201);
  const job = (await created.json()).job;
  assert.equal((await js(`window.autoContinue.getJob(${JSON.stringify(job.id)})`)).message, 'Scheduled from the smoke phone', 'remote schedules land in the desktop queue');
  const mcp = new Client({ name: 'electron-smoke', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const listed = await mcp.callTool({ name: 'list_jobs', arguments: { view: 'upcoming' } });
  assert.ok(listed.structuredContent.jobs.some(item => item.id === job.id));
  // The queue in the rail follows the remote change live.
  await goHome(js);
  await waitFor(() => js(`Boolean(document.querySelector(${JSON.stringify(`[data-job="${job.id}"]`)}))`), 'desktop queue updates live from a remote change');
  await capture('home-remote-queued');
  assert.equal((await mcp.callTool({ name: 'cancel_job', arguments: { id: job.id } })).structuredContent.job.status, 'canceled');
  await waitFor(() => js(`!document.querySelector(${JSON.stringify(`.queue > [data-job="${job.id}"]`)})`), 'remote cancel leaves the queue');
  // The production harness registry, continuation runs and keep-awake status are wired into remote control.
  assert.deepEqual((await (await call('GET', '/v1/harnesses')).json()).harnesses.map(item => item.id), ['t3', 'fake', 'desk']);
  assert.deepEqual((await (await call('GET', '/v1/status')).json()).capabilities, { keepAwake: true, continuousRuns: true, compatibility: true });
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
  // Leaving Settings forgets the plaintext token; coming back never shows it again.
  await openSection(js, 'remote');
  await waitFor(() => js(`Boolean(document.querySelector('#remote-form'))`), 'remote settings again');
  assert.equal(await js(`Boolean(document.querySelector('.token-reveal'))`), false, 'the reveal does not outlive the Settings visit');
  assert.equal(await js(`document.body.innerText.includes(${JSON.stringify(token)})`), false, 'the token is not shown again');
  await waitFor(() => js(`(() => { const text = [...document.querySelectorAll('.remote-audit')].map(row => row.textContent).join('|'); return text.includes('Canceled a schedule') && text.includes('Stopped a continuation'); })()`), 'remote activity visible');
  await js(`document.querySelector('.remote-audit').scrollIntoView({block:'start'})`);
  await js(`document.querySelector('#toast-dismiss')?.click()`);
  await capture('settings-remote-activity');
  await click(js, '[data-action="remote-revoke"]');
  await click(js, '[data-action="remote-revoke-confirm"]');
  await waitFor(() => js(`!document.querySelector('[data-action="remote-revoke"]')`), 'token revoked');
  assert.equal((await call('GET', '/v1/status')).status, 401, 'revocation is immediate');
  await js(`(() => { const box=document.querySelector('#remote-enabled'); box.checked=false; box.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await js(`document.querySelector('#remote-form').requestSubmit()`);
  await waitFor(() => js(`document.body.innerText.includes('Nothing is listening')`), 'remote control turned off');
  await assert.rejects(fetch(`http://127.0.0.1:${port}/v1/status`));
  assert.doesNotMatch(files.get('/fixture/remote-control.json'), new RegExp(token.slice(4)), 'only token digests are stored');
}
async function keepAwakeJourney(js) {
  const submit = async () => {
    await js(`document.querySelector('#keep-awake-form').requestSubmit()`);
    await waitFor(() => js(`Boolean(document.querySelector('#keep-awake-form')) && !document.querySelector('#keep-awake-form button[type="submit"]').disabled`), 'keep-awake settings saved');
  };
  const held = expected => waitFor(() => JSON.stringify(ownAssertions().map(line => line.split(' ')[2])) === JSON.stringify(expected), `assertions ${JSON.stringify(expected)}; saw ${JSON.stringify(ownAssertions())}`);
  await openSection(js, 'awake');
  assert.match(await js(`document.querySelector('#ka-status').textContent`), /Off/);
  await held([]);
  // The renderer journey confirmed a delivery, whose agent turn keep-awake follows until the job service's
  // next turn poll (every 30 seconds in the app) settles it; poll now so this journey starts with nothing to track.
  await vm.runInContext('service.pollTurns()', mainContext);
  assert.equal(vm.runInContext('service.activeWork().length', mainContext), 0);
  await click(js, '#ka-enabled');
  await submit();
  await waitFor(() => js(`window.autoContinue.getKeepAwake().then(state => state.enabled && state.state === 'off')`), 'enabled with nothing to track');
  await held([]);
  const job = await js(`window.autoContinue.createSchedule({ threadId: 'thread-active', message: 'Keep-awake fixture', whenISO: new Date(Date.now() + 7200000).toISOString(), timeZone: 'UTC' })`);
  await waitFor(() => js(`window.autoContinue.getKeepAwake().then(state => state.state === 'armed')`), 'armed for the pending schedule');
  await held(['NoIdleSleepAssertion']);
  const evidence = { armed: ownAssertions() };
  assert.match(await js(`document.querySelector('#ka-status').textContent`), /Waiting for 1 scheduled task/);
  assert.ok(menu.find(item => item.label === 'Keeping Mac awake · 1 task'), 'Tray shows the keep-awake state');
  // The keep-awake glyph is a real decodable template image, like the idle one checked at the end.
  assert.equal(trayImage.isEmpty(), false, 'The keep-awake menu-bar icon must contain pixels');
  assert.equal(trayImage.isTemplateImage(), true);
  assert.ok(trayImage.getScaleFactors().includes(2), 'The keep-awake menu-bar icon needs a Retina representation');
  assert.equal(trayImage.toPNG().equals(nativeImageFor('trayAwakeTemplate.png').toPNG()), true, 'The tray shows the keep-awake glyph while holding');
  // The header toggle is the everyday signal; its tooltip says why the Mac is awake.
  await goHome(js);
  await waitFor(() => js(`document.querySelector('#awake-toggle')?.classList.contains('holding')`), 'header toggle shows the hold');
  assert.match(await js(`document.querySelector('#awake-tip').textContent`), /Keeping your Mac awake[\s\S]*Click to turn keep-awake off/);
  assert.equal(await js(`Boolean(document.querySelector('#notices .notice.awake'))`), false, 'A routine hold needs no banner');
  await js(`document.querySelector('.tipwrap').dispatchEvent(new Event('mouseenter'))`);
  await waitFor(() => js(`document.querySelector('#awake-tip').classList.contains('open')`), 'tooltip on hover');
  await capture('home-awake-tooltip');
  await js(`document.querySelector('.tipwrap').dispatchEvent(new Event('mouseleave'))`);
  await openSection(js, 'awake');
  await click(js, '#ka-display');
  await submit();
  await held(['NoDisplaySleepAssertion']);
  await capture('settings-keep-awake');
  evidence.display = ownAssertions();
  // Letting the Mac sleep for this session comes from the tray; the banner then offers to keep awake again.
  menu.find(item => item.label === 'Let Mac sleep now').click();
  await held([]);
  await goHome(js);
  await waitFor(() => js(`document.querySelector('#notices .notice.awake')?.textContent.includes('Your Mac can sleep')`), 'stopped notice');
  await capture('home-keep-awake-stopped');
  await click(js, '#notices [data-action="keep-awake-resume"]');
  await held(['NoDisplaySleepAssertion']);
  // The production controller reaches its time limit: its clock moves past the deadline.
  const controller = vm.runInContext('keepAwake', mainContext);
  const hours = (await js('window.autoContinue.getKeepAwake()')).settings.maxHours;
  controller.now = () => Date.now() + (hours + 1) * 3_600_000;
  controller.evaluate();
  await held([]);
  await waitFor(() => js(`document.querySelector('#notices .notice.awake')?.textContent.includes('reached the time limit')`), 'capped notice');
  const capped = await js(`(() => { const notice = document.querySelector('#notices .notice.awake'); notice.querySelector('details').open = true; return { title: notice.querySelector('strong').textContent, summary: notice.querySelector('summary').textContent, items: [...notice.querySelectorAll('li')].map(item => item.textContent), button: notice.querySelector('button')?.textContent }; })()`);
  assert.equal(capped.title, 'Your Mac can sleep');
  assert.equal(capped.summary, '1 task reached the time limit');
  assert.equal(capped.items.length, 1);
  assert.match(capped.items[0], /^Production renderer test · Scheduled message waiting to send · starts .* · reached the time limit$/);
  assert.equal(capped.button, 'Keep awake again');
  assert.ok(menu.find(item => item.label === 'Keep Mac awake again'), 'Tray offers to override the limit');
  await js(`document.querySelector('#toast-dismiss')?.click()`);
  await capture('home-keep-awake-capped');
  await click(js, '#notices [data-action="keep-awake-resume"]');
  await held(['NoDisplaySleepAssertion']);
  controller.now = () => Date.now();
  // The header toggle turns keep-awake off altogether and releases the assertion.
  await click(js, '#awake-toggle');
  await waitFor(() => js(`window.autoContinue.getKeepAwake().then(state => state.enabled === false)`), 'toggle turned keep-awake off');
  await held([]);
  assert.equal(await js(`Boolean(document.querySelector('#notices .notice.awake'))`), false);
  assert.equal(await js(`document.querySelector('#awake-toggle').getAttribute('aria-pressed')`), 'false');
  await js(`window.autoContinue.cancelJob(${JSON.stringify(job.id)})`);
  if (evidenceDirectory) fs.writeFileSync(path.join(evidenceDirectory, 'keep-awake-assertions.json'), JSON.stringify(evidence, null, 2));
}
async function harnessJourney(js) {
  await goHome(js);
  await waitFor(() => js(`Boolean(document.querySelector('.head [data-agent-badge="fake"]'))`), 'every shown agent has a header mark');
  assert.deepEqual(await js(`[...document.querySelectorAll('.head [data-agent-badge]')].map(node => node.dataset.agentBadge)`), ['t3', 'fake', 'desk']);
  await click(js, '#pick');
  await waitFor(() => js(`Boolean(document.querySelector('[data-thread="conv-fake"]'))`), 'fake conversations listed');
  assert.match(await js(`document.querySelector('[data-thread="conv-fake"] small').textContent`), /Fake Agent · Fake repo/);
  await capture('picker-agents');
  await click(js, '[data-thread="conv-fake"]');
  await view(js, 'home');
  assert.match(await js(`document.querySelector('#pick').textContent`), /Fake conversation[\s\S]*Fake Agent · Fake repo/);
  await click(js, '[data-when="custom"]');
  await fill(js, '#date', '2099-11-01');
  await fill(js, '#time', '10:00');
  await fill(js, '#timezone', 'UTC');
  await capture('home-fake-agent');
  await js(`document.querySelector('#continue-form').requestSubmit()`);
  await waitFor(() => js(`document.querySelector('#toast').textContent.includes('Queued.')`), 'queued toast');
  const job = await js(`window.autoContinue.listJobs({view:'upcoming'}).then(result=>result.jobs.find(item=>item.harness==='fake'))`);
  assert.ok(job, 'The schedule records its harness');
  assert.equal(job.threadTitle, 'Fake conversation');
  await waitFor(() => js(`Boolean(document.querySelector(${JSON.stringify(`[data-job="${job.id}"] [data-agent-badge="fake"]`)}))`), 'harness mark in the row');
  await click(js, `[data-open="${job.id}"]`);
  await waitFor(() => js(`document.querySelector('.key-values')?.textContent.includes('AgentFake Agent')`), 'harness shown in the detail');
  await click(js, '[data-action="cancel"]');
  await click(js, '[data-action="confirm-cancel"]');
  await waitFor(() => js(`window.autoContinue.getJob(${JSON.stringify(job.id)}).then(item=>item.status==='canceled')`), 'fake schedule canceled');
  // Settings: each agent has a status, a Check button, its capabilities and its own fields.
  await openSection(js, 'agents');
  const fakeChecks = fake.state.calls.filter(([name]) => name === 'checkConnection').length;
  const readsBefore = t3Reads;
  await click(js, '[data-agent="t3"] [data-action="check"]');
  await waitFor(() => js(`document.querySelector('#toast').textContent.includes('Connected to T3 Code.')`), 'T3 settings connection toast');
  assert.ok(t3Reads > readsBefore, 'The T3 check button checks the T3 API');
  assert.equal(fake.state.calls.filter(([name]) => name === 'checkConnection').length, fakeChecks);
  offline = true;
  await click(js, '[data-agent="t3"] [data-action="check"]');
  await waitFor(() => js(`document.querySelector('[data-agent="t3"] .dot.off') && document.querySelector('#toast').textContent.includes('T3 Code:')`), 'T3 settings connection failure');
  offline = false;
  fakeOffline = true;
  await click(js, '[data-agent="fake"] [data-action="check"]');
  await waitFor(() => js(`document.querySelector('[data-agent="fake"] small')?.textContent.includes('Fake Agent is not reachable')`), 'fake agent offline in Settings');
  assert.equal(fake.state.calls.filter(([name]) => name === 'checkConnection').length, fakeChecks + 1);
  fakeOffline = false;
  await click(js, '[data-agent="fake"] [data-action="check"]');
  await waitFor(() => js(`document.querySelector('#toast').textContent.includes('Connected to Fake Agent.')`), 'fake agent connection toast');
  await waitFor(() => js(`Boolean(document.querySelector('[data-agent="fake"] .dot.ok'))`), 'fake agent status restored');
  assert.match(await js(`document.querySelector('[data-agent="fake"] .info').title`), /Works while locked/);
  await fill(js, '#harness-fake-port', '4555');
  await js(`document.querySelector('#agents-form').requestSubmit()`);
  await waitFor(() => js(`window.autoContinue.getSettings().then(settings=>settings.harnesses.fake.port.value===4555)`), 'harness setting saved');
  // Arrange: move the fake agent first, hide the desktop app, and see both in the header and the picker.
  await click(js, '[data-agent-move="fake"][data-direction="-1"]');
  await waitFor(() => js(`window.autoContinue.getSettings().then(settings=>settings.agents.map(item=>item.id).join()==='fake,t3,desk')`), 'order saved');
  await click(js, '[data-agent-show="desk"]');
  await waitFor(() => js(`window.autoContinue.getSettings().then(settings=>settings.agents.find(item=>item.id==='desk').hidden===true)`), 'hidden agent saved');
  await waitFor(() => js(`document.querySelector('[data-agent="desk"]').classList.contains('hidden-agent')`), 'hidden agent dimmed');
  await js(`document.querySelector('#agents-form').scrollIntoView({block:'start'}); document.querySelector('#toast-dismiss')?.click()`);
  await capture('settings-agents');
  await goHome(js);
  assert.deepEqual(await js(`[...document.querySelectorAll('.head [data-agent-badge]')].map(node => node.dataset.agentBadge)`), ['fake', 't3']);
  await click(js, '#pick');
  await waitFor(() => js(`Boolean(document.querySelector('[data-thread="conv-fake"]'))`), 'picker after arranging');
  assert.equal(await js(`Boolean(document.querySelector('[data-thread="local_fixture"]'))`), false, 'a hidden agent is not listed');
  await click(js, '[data-action="back"]');
  await openSection(js, 'agents');
  await click(js, '[data-agent-show="desk"]');
  await waitFor(() => js(`window.autoContinue.getSettings().then(settings=>settings.agents.every(item=>!item.hidden))`), 'agent shown again');
  await click(js, '[data-agent-move="fake"][data-direction="1"]');
  await waitFor(() => js(`window.autoContinue.getSettings().then(settings=>settings.agents.map(item=>item.id).join()==='t3,fake,desk')`), 'order restored');
  await goHome(js);
  assert.equal(fake.state.submitted.length, 0);
}
async function continuationJourney(js) {
  const chains = () => js(`window.autoContinue.listJobs({view:'all'}).then(result=>result.jobs.filter(job=>job.harness==='fake'&&job.automation))`);
  await js(`window.autoContinue.saveSettings({httpPort:3773,bufferSeconds:0})`);
  await waitFor(() => js(`window.autoContinue.getSettings().then(settings=>settings.bufferSeconds===0)`), 'zero buffer for fast turns');
  // T3 Code reports completion but not usage limits: How far is offered, When free is disabled with the reason.
  await js('window.autoContinue.scheduleThread("thread-active")');
  await waitFor(() => js(`document.querySelector('#pick')?.textContent.includes('Production renderer test') && document.querySelector('[data-when="available"]')?.disabled === true`), 'T3 automation support loaded');
  assert.match(await js(`document.querySelector('[data-when="available"]').title`), /T3 Code does not report usage limits/);
  assert.equal(await js(`Boolean(document.querySelector('[data-far="until"]'))`), true);
  assert.equal(await js(`Boolean(document.querySelector('#wait-if-limited'))`), false, 'No wait option without usage-limit reporting');
  await capture('home-t3-automation');
  // Auto-start with a turn limit of 3 while the fake agent is at a usage limit: an untouched draft moves to When free.
  fake.state.availability = { state: 'limited', resetsAt: new Date(Date.now() + 3000).toISOString(), reason: 'Five-hour limit', source: 'reported' };
  await js('window.autoContinue.scheduleThread("conv-chain", "fake")');
  await waitFor(() => js(`document.querySelector('#pick')?.textContent.includes('Chain fixture session')`), 'fake conversation chosen');
  await waitFor(() => js(`document.querySelector('[data-when="available"]')?.getAttribute('aria-pressed')==='true'`), 'a limited agent defaults to When free');
  assert.match(await js(`document.querySelector('.hint').textContent`), /Fake Agent is limited until/);
  assert.equal(await js(`Boolean(document.querySelector('#date'))`), false, 'No time is asked for');
  await click(js, '[data-far="upto"]');
  await fill(js, '#turn-limit', '3');
  await fill(js, '#stop-phrase', 'TASK COMPLETE');
  await waitFor(() => js(`document.querySelector('#plan').textContent.includes('When Fake Agent is free, around') && document.querySelector('#plan').textContent.includes('up to 3 turns, or at “TASK COMPLETE”')`), 'plan sentence');
  await capture('home-auto-start');
  await js(`document.querySelector('#continue-form').requestSubmit()`);
  await waitFor(() => js(`document.querySelector('#toast').textContent.includes('Waiting for Fake Agent to be free.')`), 'waiting toast');
  await waitFor(() => js(`[...document.querySelectorAll('.queue > .q small')].some(node => node.textContent.includes('Waiting for availability · turn 1 of 3'))`), 'waiting row');
  assert.equal(fake.state.submitted.length, 0, 'Nothing is sent before the limit resets');
  await capture('home-waiting-for-availability');
  await waitFor(async () => (await chains())[0]?.automation.state === 'finished', 'three turns sent and finished');
  const [finished] = await chains();
  assert.equal(fake.state.submitted.length, 3);
  assert.equal(new Set(fake.state.submitted.map(item => item.deliveryKey)).size, 3);
  assert.equal(finished.automation.sentTurns, 3);
  assert.equal(finished.automation.stopPhrase, 'TASK COMPLETE', 'The stop phrase is saved with the chain');
  await waitFor(() => js(`Boolean(document.querySelector(${JSON.stringify(`.recent [data-open="${finished.id}"]`)}))`), 'finished continuation in Recent');
  await click(js, `.recent [data-open="${finished.id}"]`);
  await waitFor(() => js(`document.querySelectorAll('.turn-list li').length === 3`), 'turn history in detail');
  assert.match(await js(`document.querySelector('.chain .key-values').textContent`), /Stop phraseTASK COMPLETE/);
  assert.match(await js(`document.querySelector('.chain-reason').textContent`), /Sent 3 turns, the turn limit/);
  await capture('detail-finished-turn-history');
  await click(js, '[data-action="back"]');
  // Continuous mode keeps going until stopped from the detail view.
  completionMode = 'manual';
  fake.state.availability = { state: 'available', source: 'reported' };
  await js('window.autoContinue.scheduleThread("conv-chain", "fake")');
  await waitFor(() => js(`document.querySelector('#pick')?.textContent.includes('Chain fixture session')`), 'fake conversation chosen again');
  await click(js, '[data-when="available"]');
  await click(js, '[data-far="until"]');
  await waitFor(() => js(`document.querySelector('#turn-limit').disabled && document.querySelector('#plan').textContent.includes('until done')`), 'continuous mode chosen');
  await js(`document.querySelector('#continue-form').requestSubmit()`);
  await waitFor(() => fake.state.submitted.length === 4 && pendingCompletions.length === 1, 'first continuous turn sent');
  pendingCompletions.shift()();
  await waitFor(() => fake.state.submitted.length === 5, 'second continuous turn sent');
  await waitFor(() => js(`[...document.querySelectorAll('.queue > .q small')].some(node => node.textContent.includes('Running turn 2 · continuous'))`), 'continuous progress row');
  assert.equal(await js(`Boolean(document.querySelector('.qhead [data-action="stop-all"]'))`), true, 'Stop all is offered while a continuation runs');
  await capture('home-continuous-running');
  const continuous = (await chains()).find(job => job.automation.unlimited);
  const continuousJob = () => js(`window.autoContinue.getJob(${JSON.stringify(continuous.id)})`);
  // After the first turn, Edit changes only the stop phrase: every other setting stays locked.
  const rowEdit = JSON.stringify(`[data-job="${continuous.id}"] [data-action="edit"]`);
  assert.equal(await js(`document.querySelector(${rowEdit})?.title`), 'Edit stop phrase', 'The running row offers the stop phrase edit');
  await js(`document.querySelector(${rowEdit}).focus(); document.querySelector('#toast').hidden = true`);
  await capture('home-continuous-row-actions');
  await click(js, `[data-open="${continuous.id}"]`);
  await waitFor(() => js(`Boolean(document.querySelector('.detail [data-action="stop"]'))`), 'stop control');
  assert.equal(await js(`document.querySelector('.detail [data-action="edit"]')?.textContent`), 'Edit stop phrase');
  await capture('detail-continuous-running');
  await click(js, '.detail [data-action="edit"]');
  await view(js, 'home');
  await waitFor(() => js(`document.activeElement?.id === 'stop-phrase'`), 'stop phrase focused for editing');
  const locked = await js(`(() => ({
    banner: document.querySelector('.editing span').textContent, scope: document.querySelector('#edit-scope').textContent,
    picker: document.querySelector('#pick').disabled, when: [...document.querySelectorAll('[data-when]')].every(node => node.disabled),
    far: [...document.querySelectorAll('[data-far]')].every(node => node.disabled), limit: document.querySelector('#turn-limit').disabled,
    message: Boolean(document.querySelector('[data-action="edit-message"]')), phrase: document.querySelector('#stop-phrase').disabled,
    plan: document.querySelector('#plan').textContent, button: document.querySelector('#continue').textContent }))()`);
  assert.deepEqual(locked, { banner: 'Editing a running continuation', scope: 'This continuation has already started, so only its stop phrase can change.', picker: true, when: true, far: true, limit: true, message: false, phrase: false, plan: 'From the next finished turn · until done', button: 'Save changes' });
  await fill(js, '#stop-phrase', 'ALL DONE');
  await waitFor(() => js(`document.querySelector('#plan').textContent === 'From the next finished turn · until done, or at “ALL DONE”'`), 'stop phrase plan');
  await js(`document.querySelector('#toast').hidden = true`);
  await capture('home-edit-stop-phrase');
  await js(`document.querySelector('#continue-form').requestSubmit()`);
  await waitFor(() => js(`document.querySelector('#toast').textContent.includes('Stop phrase updated.')`), 'stop phrase updated toast');
  const edited = await continuousJob();
  assert.deepEqual([edited.automation.stopPhrase, edited.automation.state, edited.automation.unlimited, edited.message, edited.trigger, edited.scheduleAt, edited.messageId, edited.turn.state],
    ['ALL DONE', 'active', true, continuous.message, continuous.trigger, continuous.scheduleAt, continuous.messageId, 'running'], 'Only the stop phrase changed');
  assert.equal(await js(`Boolean(document.querySelector('.editing')) || document.querySelector('#continue').textContent !== 'Continue'`), false, 'The composer returns to a new message');
  assert.equal(fake.state.submitted.length, 5, 'Editing the stop phrase sends nothing');
  // A failed turn pauses the continuation; its stop phrase can still change, and it can be removed.
  pendingCompletions.shift()({ state: 'failed', error: { code: 'agent_error', message: 'Fixture turn failed.' } });
  await waitFor(async () => (await continuousJob()).automation.state === 'paused', 'continuation paused after a failed turn');
  await waitFor(() => js(`Boolean(document.querySelector(${JSON.stringify(`.recent [data-open="${continuous.id}"]`)}))`), 'paused continuation in Recent');
  await click(js, `.recent [data-open="${continuous.id}"]`);
  await waitFor(() => js(`document.querySelector('.detail [data-action="edit"]')?.textContent === 'Edit stop phrase' && Boolean(document.querySelector('.detail [data-action="resume"]'))`), 'paused detail offers the stop phrase edit');
  await capture('detail-continuous-paused');
  await click(js, '.detail [data-action="edit"]');
  await waitFor(() => js(`document.querySelector('.editing span')?.textContent === 'Editing a paused continuation' && document.querySelector('#stop-phrase').value === 'ALL DONE'`), 'paused continuation editing');
  await fill(js, '#stop-phrase', '');
  await js(`document.querySelector('#continue-form').requestSubmit()`);
  await waitFor(() => js(`document.querySelector('#toast').textContent.includes('Stop phrase removed.')`), 'stop phrase removed toast');
  assert.deepEqual([(await continuousJob()).automation.stopPhrase, (await continuousJob()).automation.state], [null, 'paused']);
  await click(js, `.recent [data-open="${continuous.id}"]`);
  await waitFor(() => js(`Boolean(document.querySelector('.detail [data-action="stop"]'))`), 'stop control on the paused continuation');
  await click(js, '.detail [data-action="stop"]');
  await waitFor(async () => (await continuousJob()).automation.state === 'stopped', 'stopped from the detail view');
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(fake.state.submitted.length, 5, 'Nothing is sent after Stop');
  await waitFor(() => js(`document.querySelector('.chain-reason')?.textContent.includes('Stopped by you')`), 'stopped detail');
  assert.equal(await js(`Boolean(document.querySelector('.detail [data-action="edit"]'))`), false, 'An ended continuation offers no edit');
  await capture('detail-continuous-stopped');
  await click(js, '[data-action="back"]');
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
  await waitFor(() => js(`!document.querySelector('.qhead [data-action="stop-all"]')`), 'Stop all disappears');
}
// A desktop app update is noticed before the schedule fires: the rail names the app and version,
// marks the schedule at risk, copies diagnostics and clears the notice once the app checks out again.
async function compatibilityJourney(js) {
  desk.state.compatibility = ({ depth }) => depth === 'quick' ? supported : { ...supported, appVersion: '2.17.0', checked: ['app_path', 'deep_link', 'content_match'], unchecked: [{ contactPoint: 'send_label', reason: 'no_composer' }],
    problems: [{ contactPoint: 'composer_label', message: 'Claude Desktop 2.17.0 changed how its message box is labelled. Scheduled messages for it may fail until Agent Auto-Continue supports this version.', hint: 'A conversation was shown, but no text area labelled "Prompt" or "Write your prompt to Claude" was found in it. Interface language: en-US.' }] };
  await goHome(js);
  const job = await js(`window.autoContinue.createSchedule({ harness: 'desk', threadId: 'local_fixture', message: 'Continue with the next step', whenISO: '2099-10-02T09:30:00Z', timeZone: 'UTC' })`);
  await waitFor(() => js(`document.querySelector('#notices').textContent.includes('Claude Desktop 2.17.0 isn’t supported yet')`), 'compatibility notice');
  await waitFor(() => js(`Boolean(document.querySelector(${JSON.stringify(`[data-job="${job.id}"] .pill.risk`)}))`), 'schedule marked at risk');
  assert.match(await js(`document.querySelector('#notices').textContent`), /changed how its message box is labelled[\s\S]*One scheduled message is at risk/);
  assert.equal((await js(`window.autoContinue.getJob(${JSON.stringify(job.id)})`)).status, 'pending', 'A risk never cancels a schedule');
  await js(`document.querySelector('#notices details').open = true; document.querySelector('#toast').hidden = true`);
  await capture('home-compatibility-notice-dark');
  await setTheme(js, 'light');
  await js(`document.querySelector('#notices details').open = true`);
  await capture('home-compatibility-notice-light');
  await click(js, `[data-open="${job.id}"]`);
  await waitFor(() => js(`Boolean(document.querySelector('.risk-detail'))`), 'risk shown in the detail');
  assert.equal(await js(`document.querySelector('.detail-header .pill.risk')?.textContent`), 'At risk');
  await capture('detail-compatibility-light');
  await click(js, '#notices [data-action="copy-diagnostics"]');
  await waitFor(() => copied.length === 1, 'diagnostics copied');
  assert.match(copied[0], /- desk: Claude Desktop 2\.17\.0, verified 2\.16120\.0[\s\S]*composer_label/);
  assert.doesNotMatch(copied[0], /Continue with the next step|Refactor the scheduler/, 'Diagnostics never contain message text or titles');
  await waitFor(() => js(`document.querySelector('#toast').textContent.includes('Diagnostics copied')`), 'copy toast');
  desk.state.compatibility = supported;
  await click(js, '#notices [data-action="recheck-compatibility"]');
  await waitFor(() => js(`!document.querySelector('#notices').textContent.includes('supported yet')`), 'notice cleared after a passing check');
  await waitFor(() => js(`!document.querySelector('.risk-detail')`), 'risk cleared in the detail');
  await click(js, '[data-action="cancel"]');
  await click(js, '[data-action="confirm-cancel"]');
  await waitFor(() => js(`window.autoContinue.getJob(${JSON.stringify(job.id)}).then(item=>item.status==='canceled')`), 'desktop schedule canceled');
  await click(js, '[data-action="back"]');
  // A continuation for the same app is at risk as well, and its detail explains what happens to the next turn.
  desk.state.compatibility = ({ depth }) => depth === 'quick' ? supported : { ...supported, appVersion: '2.17.0', checked: ['app_path'], problems: [{ contactPoint: 'composer_label', message: 'Claude Desktop 2.17.0 changed how its message box is labelled. Scheduled messages for it may fail until Agent Auto-Continue supports this version.', hint: 'No text area labelled "Prompt".' }] };
  const chain = await js(`window.autoContinue.createSchedule({ harness: 'desk', threadId: 'local_fixture', message: 'Keep going', whenISO: '2099-10-03T09:30:00Z', timeZone: 'UTC', turnLimit: 3 })`);
  await waitFor(() => js(`Boolean(document.querySelector(${JSON.stringify(`[data-open="${chain.id}"]`)}))`), 'continuation queued');
  await click(js, `[data-open="${chain.id}"]`);
  await waitFor(() => js(`document.querySelector('.risk-detail h3')?.textContent === 'The next turn may not be sent'`), 'continuation risk shown in the detail');
  assert.equal(await js(`document.querySelector('.detail-header .pill.risk')?.textContent`), 'At risk');
  assert.match(await js(`document.querySelector('.risk-detail').textContent`), /nothing is sent and it pauses/);
  await js(`document.querySelector('#toast').hidden = true`);
  await capture('detail-compatibility-continuation');
  // Settings shows each desktop app's last result.
  await openSection(js, 'agents');
  await waitFor(() => js(`/Version 2\\.17\\.0 · Not supported yet · checked/.test(document.querySelector('[data-agent="desk"]').textContent)`), 'desktop app result in Settings');
  await js(`document.querySelector('[data-agent="desk"]').scrollIntoView({block:'center'}); document.querySelector('#toast').hidden = true`);
  await capture('settings-agents-compatibility');
  await goHome(js);
  await click(js, `[data-open="${chain.id}"]`);
  await waitFor(() => js(`Boolean(document.querySelector('.risk-detail'))`), 'continuation detail again');
  desk.state.compatibility = supported;
  await click(js, '#notices [data-action="recheck-compatibility"]');
  await waitFor(() => js(`!document.querySelector('.risk-detail')`), 'continuation risk cleared');
  await click(js, '.detail [data-action="stop"]');
  await waitFor(() => js(`window.autoContinue.getJob(${JSON.stringify(chain.id)}).then(item=>item.automation.state==='stopped')`), 'desktop continuation stopped');
  await click(js, '[data-action="back"]');
}
// Desktop apps list their conversations without Accessibility permission, so a missing permission
// first shows as a failed send. Its details offer the same Open System Settings button as the notice.
async function permissionJourney(js) {
  await goHome(js);
  const denied = () => new HarnessError('permission_required', 'Allow Agent Auto-Continue in System Settings > Privacy & Security > Accessibility so it can send messages in Claude Desktop.', { permission: 'accessibility', settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility' }, false);
  desk.state.submitError = denied();
  const job = await js(`window.autoContinue.createSchedule({ harness: 'desk', threadId: 'local_fixture', message: 'Continue', whenISO: new Date(Date.now() + 1500).toISOString(), timeZone: 'UTC' })`);
  await waitFor(() => js(`window.autoContinue.getJob(${JSON.stringify(job.id)}).then(item=>item.status==='failed'&&item.error?.code==='permission_required')`), 'send refused for a missing permission');
  await waitFor(() => js(`Boolean(document.querySelector(${JSON.stringify(`.recent [data-open="${job.id}"]`)}))`), 'failed row in Recent');
  assert.equal(await js(`document.querySelector('#notices').textContent.includes('is unavailable')`), false, 'The conversation list still loads, so no unavailable notice appears');
  await js(`document.querySelector('#toast').hidden = true`);
  await capture('home-permission-failed');
  await click(js, `[data-open="${job.id}"]`);
  await waitFor(() => js(`Boolean(document.querySelector('.error-detail'))`), 'failure shown in the detail');
  assert.equal(await js(`document.querySelector('.error-detail [data-action="open-permission-settings"]')?.textContent`), 'Open System Settings');
  await capture('detail-permission-failed');
  const opened = externalUrls.length;
  await click(js, '.error-detail [data-action="open-permission-settings"]');
  await waitFor(() => externalUrls.length === opened + 1, 'Accessibility settings opened');
  assert.match(externalUrls.at(-1), /Privacy_Accessibility$/);
  await click(js, '[data-action="ack"]');
  await waitFor(() => js(`window.autoContinue.getJob(${JSON.stringify(job.id)}).then(item=>Boolean(item.acknowledgedAt))`), 'permission failure acknowledged');
  assert.ok(await js(`Boolean(document.querySelector('.error-detail [data-action="open-permission-settings"]'))`), 'The button stays after acknowledging');
  // Any other failure offers no permission button.
  await click(js, '[data-action="back"]');
  await click(js, '[data-action="history"]');
  await click(js, '[data-open="failure-fixture"]');
  await waitFor(() => js(`Boolean(document.querySelector('.error-detail'))`), 'another failure in the detail');
  assert.equal(await js(`Boolean(document.querySelector('[data-action="open-permission-settings"]'))`), false, 'Only a permission failure offers System Settings');
  await goHome(js);
  // A continuation pauses on the same failure, and its details offer the button too.
  desk.state.submitError = denied();
  const chain = await js(`window.autoContinue.createSchedule({ harness: 'desk', threadId: 'local_fixture', message: 'Keep going', whenISO: new Date(Date.now() + 1500).toISOString(), timeZone: 'UTC', turnLimit: 3 })`);
  await waitFor(() => js(`window.autoContinue.getJob(${JSON.stringify(chain.id)}).then(item=>item.automation?.state==='paused')`), 'continuation paused for a missing permission');
  await click(js, `[data-open="${chain.id}"]`);
  await waitFor(() => js(`Boolean(document.querySelector('.error-detail [data-action="open-permission-settings"]'))`), 'permission button in the continuation detail');
  await js(`document.querySelector('#toast').hidden = true`);
  await capture('detail-permission-paused');
  await click(js, '.detail [data-action="stop"]');
  await waitFor(() => js(`window.autoContinue.getJob(${JSON.stringify(chain.id)}).then(item=>item.automation.state==='stopped')`), 'paused continuation stopped');
  await click(js, '[data-action="back"]');
  desk.state.submitError = null;
  // Check finds the permission missing; the agent keeps saying so after its conversations load again.
  desk.state.connectionError = denied();
  await openSection(js, 'agents');
  await click(js, '[data-agent="desk"] [data-action="check"]');
  await waitFor(() => js(`document.querySelector('#toast').textContent.includes('Privacy & Security')`), 'check reports the missing permission');
  await waitFor(() => js(`document.querySelector('[data-agent="desk"] .agent-head small').textContent.includes('Needs Accessibility permission')`), 'permission kept in Settings');
  await waitFor(() => js(`Boolean(document.querySelector('.head [data-agent-badge="desk"] .dot.off')) || !document.querySelector('.head [data-agent-badge="desk"]')`), 'permission shown on the agent mark');
  await js(`document.querySelector('#toast').hidden = true; document.querySelector('[data-agent="desk"]').scrollIntoView({block:'center'})`);
  await capture('settings-permission-check');
  const allowed = externalUrls.length;
  await click(js, '[data-agent="desk"] [data-action="open-permission-settings"]');
  await waitFor(() => externalUrls.length === allowed + 1, 'Accessibility settings opened from Settings');
  desk.state.connectionError = null;
  await click(js, '[data-agent="desk"] [data-action="check"]');
  await waitFor(() => js(`document.querySelector('[data-agent="desk"] .agent-head small').textContent.includes('Claude Desktop is open') && !document.querySelector('[data-agent="desk"] [data-action="open-permission-settings"]')`), 'a passing check clears the permission');
  await goHome(js);
}
// Expanding to a window rebuilds the BrowserWindow with a frame; the renderer reports the window layout.
async function layoutJourney(js) {
  const rail = windows[0];
  // The reply arrives before the rail is torn down; the fixture does not wait on a window that is about to go.
  await js(`window.autoContinue.setLayout('window').then(result => { window.__layoutReply = result.layout; }); 0`);
  await waitFor(() => js('window.__layoutReply').then(value => value === 'window', () => false), 'the layout call settles before the rail goes away');
  await waitFor(() => windows.length === 2 && rail.isDestroyed() && !windows[1].webContents.isLoading(), 'window layout created');
  const expanded = windows[1];
  assert.equal(expanded.isResizable(), true, 'The window layout can be resized');
  const inWindow = code => expanded.webContents.executeJavaScript(code, true);
  await waitFor(() => inWindow(`document.body.classList.contains('layout-window') && Boolean(document.querySelector('#pick'))`), 'window renderer initialised');
  assert.equal(await inWindow(`document.querySelector('[data-action="layout"]').dataset.layout`), 'rail', 'The window offers the way back to the menu bar');
  await waitFor(() => Boolean(menu?.find(item => item.label === 'Back to the menu bar')), 'the tray offers the way back');
  if (evidenceDirectory) {
    await new Promise(resolve => setTimeout(resolve, 150));
    fs.writeFileSync(path.join(evidenceDirectory, 'window-layout.png'), (await expanded.webContents.capturePage()).toPNG());
  }
  await inWindow(`void window.autoContinue.setLayout('rail'); 0`);
  await waitFor(() => windows.length === 3 && expanded.isDestroyed() && !windows[2].webContents.isLoading(), 'rail restored');
  assert.equal(windows[2].isResizable(), false);
  assert.equal(JSON.parse(files.get('/fixture/config.json')).layout, 'rail', 'The layout choice is saved');
}
// A downloaded update shows as one quiet line in the rail, in Settings and in the tray, and
// restarting asks first while a message is about to be sent.
async function updateJourney() {
  const rail = windows.at(-1);
  const js = code => rail.webContents.executeJavaScript(code, true);
  const shoot = async name => { if (!evidenceDirectory) return; await new Promise(resolve => setTimeout(resolve, 150)); fs.writeFileSync(path.join(evidenceDirectory, `${name}.png`), (await rail.webContents.capturePage()).toPNG()); };
  await waitFor(() => js(`Boolean(window.autoContinue && document.querySelector('#pick'))`), 'restored rail renderer initialised');
  assert.equal(await js(`Boolean(document.querySelector('.update'))`), false, 'no update notice while there is nothing to install');
  assert.ok(menu.find(item => item.label === 'Check for Updates…'), 'the tray offers a manual check');
  await openSection(js, 'updates');
  assert.match(await js(`document.querySelector('[data-section="updates"]').textContent`), /Version \d+\.\d+\.\d+/);
  await click(js, '[data-action="check-updates"]');
  await waitFor(() => js(`document.querySelector('#toast').textContent.includes('You’re up to date.')`), 'manual check result');
  assert.match(await js(`document.querySelector('#update-status').textContent`), /^Up to date\. Last checked/);
  fakeAutoUpdater.result = '2.2.0';
  await click(js, '[data-action="check-updates"]');
  await waitFor(() => js(`document.querySelector('#toast').textContent.includes('Downloading version 2.2.0.')`), 'download started');
  fakeAutoUpdater.emit('download-progress', { percent: 62.4 });
  await waitFor(() => js(`document.querySelector('#update-status')?.textContent.includes('62%')`), 'download progress in Settings');
  assert.equal(await js(`document.querySelector('[data-action="check-updates"]').disabled`), true, 'no second check while downloading');
  fakeAutoUpdater.emit('update-downloaded', { version: '2.2.0' });
  await waitFor(() => js(`Boolean(document.querySelector('.section [data-action="restart-update"]'))`), 'Settings offers the restart');
  await waitFor(() => Boolean(menu.find(item => item.label === 'Restart to Update to 2.2.0')), 'the tray offers the restart');
  await js(`document.querySelector('#toast').hidden = true; document.querySelector('#section-updates').scrollIntoView({ block: 'center' })`);
  await shoot('settings-update-ready');
  await goHome(js);
  await waitFor(() => js(`document.querySelector('#notices .update')?.textContent === 'Update ready · version 2.2.0Restart'`), 'the rail shows the update line');
  for (const theme of ['light', 'dark']) { await setTheme(js, theme); await shoot(`home-update-ready-${theme}`); }
  // The line is one row high and fits the 380 px rail without wrapping or clipping.
  const box = await js(`(() => { const line = document.querySelector('#notices .update'); const rect = line.getBoundingClientRect(); const text = line.querySelector('span'); return { width: rect.width, height: rect.height, clipped: text.scrollWidth > text.clientWidth }; })()`);
  assert.ok(box.height <= 34 && box.width <= 380 && !box.clipped, JSON.stringify(box));
  // A message due in four minutes: the restart asks, and the fixture's answer (Later) installs nothing.
  const soon = await js(`window.autoContinue.createSchedule({ threadId: 'thread-active', message: 'Due soon', whenISO: new Date(Date.now() + 4 * 60_000).toISOString(), timeZone: 'UTC' })`);
  await click(js, '#notices .update [data-action="restart-update"]');
  await waitFor(() => dialogs.length === 1, 'restart asks first');
  assert.equal(dialogs[0].message, 'Restart to update now?');
  assert.match(dialogs[0].detail, /^A scheduled message is due in [45] minutes\./);
  assert.deepEqual([...dialogs[0].buttons], ['Later', 'Restart Anyway']);
  await waitFor(() => js(`!document.querySelector('#notices .update [data-action="restart-update"]').disabled`), 'restart settled');
  assert.equal(fakeAutoUpdater.installs, 0, 'Later installs nothing');
  await js(`window.autoContinue.cancelJob(${JSON.stringify(soon.id)})`);
  await click(js, '#notices .update [data-action="restart-update"]');
  await waitFor(() => fakeAutoUpdater.installs === 1, 'restart installs once nothing is due');
  assert.equal(dialogs.length, 1, 'nothing was due the second time, so nothing was asked');
  assert.equal(fakeAutoUpdater.checks, 2, 'only the two manual checks ran');
}
// A hung window must fail the run rather than block CI or a shell indefinitely.
// Before the app is ready (for example while macOS is locked) app.exit() is ignored, so force the exit.
const HARD_TIMEOUT_MS = Number(process.env.T3_SMOKE_TIMEOUT_MS) || 300_000;
const hardTimeout = setTimeout(() => { console.error(`Electron smoke timed out after ${HARD_TIMEOUT_MS / 1000} seconds. Is the screen locked?`); app.exit(1); setTimeout(() => process.exit(1), 2000); }, HARD_TIMEOUT_MS);
run().then(() => { clearTimeout(hardTimeout); app.exit(0); }, error => { clearTimeout(hardTimeout); console.error(error.stack); app.exit(1); });
