'use strict';
// How main.js wires automatic updates and the move-to-Applications offer: the tray items, the
// renderer bridge, the restart that never interrupts queued work without asking, and the startup
// order that keeps the scheduler from starting while the app is about to move.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { appHarness } = require('./app-harness');
const updaterModule = require('../lib/updater');

const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const thread = { id: 'thread', title: 'T3 thread', projectId: 'p', updatedAt: '2026-09-30T10:00:00.000Z', settledOverride: null, messages: [], session: null };
const settle = () => new Promise((resolve) => setImmediate(resolve));
// Values made inside main.js's VM context compare structurally only after a copy.
const plain = (value) => JSON.parse(JSON.stringify(value));

// main.js with a released-app updater whose electron-updater is a scripted fake.
function releasedApp(options = {}) {
  const auto = new EventEmitter();
  auto.checks = 0;
  auto.installs = 0;
  auto.result = (updater) => updater.emit('update-not-available', {});
  auto.checkForUpdates = async () => { auto.checks++; auto.result(auto); };
  auto.quitAndInstall = () => { auto.installs++; };
  let instance;
  const overrides = { './lib/updater': { ...updaterModule, createUpdater: (settings) => { instance = updaterModule.createUpdater({ ...settings, enabled: true, loadAutoUpdater: () => auto }); return instance; } } };
  const app = appHarness([], { ...options, overrides: { ...overrides, ...options.overrides } });
  app.setResponse(async (url) => url.includes('/threads/') ? json({ thread }) : json({ threads: [thread], projects: [] }));
  return { app, auto, get updater() { return instance; } };
}
const updateItems = (app) => app.trayMenu.filter((item) => /Update/.test(String(item.label))).map((item) => ({ ...item }));

test('development builds show no update controls and never check', async () => {
  const app = appHarness();
  const snapshot = app.invoke('update:get');
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.disabledReason, 'development');
  assert.equal(snapshot.currentVersion, '2.1.0');
  assert.equal((await app.invoke('update:check')).state, 'disabled');
  assert.deepEqual(plain(await app.invoke('update:restart')), { restarting: false });
  assert.equal(updateItems(app).length, 0);
});

test('a released app offers Check for Updates in the tray and starts its schedule with the app', async () => {
  const { app, auto, updater } = releasedApp();
  assert.deepEqual(plain(updateItems(app).map((item) => item.label)), ['Check for Updates…']);
  const settings = app.trayMenu.findIndex((item) => item.label === 'Settings…');
  assert.equal(app.trayMenu[settings + 1].label, 'Check for Updates…', 'it sits right under Settings');
  assert.equal(auto.checks, 0, 'the first check waits for its startup delay');
  updater.tick();
  await settle();
  assert.equal(auto.checks, 1);
  app.trayMenu.find((item) => item.label === 'Check for Updates…').click();
  await settle();
  await settle();
  assert.equal(app.dialogs.at(-1).message, 'You’re up to date');
  assert.equal(app.dialogs.at(-1).detail, 'Agent Auto-Continue 2.1.0 is the newest version.');
  await app.emit('before-quit');
});

test('a failed menu check explains itself once, and automatic checks stay silent', async () => {
  const { app, auto, updater } = releasedApp();
  const failure = Object.assign(new Error('No published versions on GitHub'), { code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' });
  auto.result = (emitter) => { emitter.emit('error', failure); throw failure; };
  updater.tick();
  await settle();
  assert.equal(app.dialogs.length, 0, 'no dialog for a background check');
  assert.equal(app.invoke('update:get').state, 'error');
  assert.deepEqual(plain(updateItems(app).map((item) => item.label)), ['Check for Updates…'], 'the menu stays usable');
  app.trayMenu.find((item) => item.label === 'Check for Updates…').click();
  for (let attempt = 0; attempt < 5; attempt++) await settle();
  assert.equal(app.dialogs.length, 1);
  assert.equal(app.dialogs[0].message, 'Couldn’t check for updates');
  assert.equal(app.dialogs[0].detail, 'No release has been published yet.');
  await app.emit('before-quit');
});

test('a downloaded update reaches the renderer and the tray, and restarting installs it when nothing is due', async () => {
  const { app, auto } = releasedApp();
  auto.result = (emitter) => emitter.emit('update-available', { version: '2.2.0' });
  const checked = await app.invoke('update:check');
  assert.equal(checked.state, 'downloading');
  assert.deepEqual(plain(updateItems(app).map((item) => [item.label, item.enabled])), [['Downloading Update…', false]]);
  auto.emit('download-progress', { percent: 50 });
  assert.equal(updateItems(app)[0].label, 'Downloading Update… 50%');
  auto.emit('update-downloaded', { version: '2.2.0' });
  const sent = app.events.filter(([name]) => name === 'update:changed').map(([, snapshot]) => snapshot.state);
  assert.deepEqual([...new Set(sent)], ['checking', 'downloading', 'ready']);
  assert.deepEqual(plain(updateItems(app).map((item) => item.label)), ['Restart to Update to 2.2.0']);
  // The rail hides instead of closing until the app quits; a restart must let it close.
  const closing = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  app.windows[0].handlers.close(closing);
  assert.equal(closing.defaultPrevented, true);
  assert.deepEqual(plain(await app.invoke('update:restart')), { restarting: true });
  assert.equal(auto.installs, 1);
  assert.equal(app.dialogs.length, 0, 'nothing was due, so nothing was asked');
  const afterRestart = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  app.windows[0].handlers.close(afterRestart);
  assert.equal(afterRestart.defaultPrevented, false);
});

test('restarting asks first when a message is about to be sent, and Later installs nothing', async () => {
  const { app, auto } = releasedApp();
  auto.result = (emitter) => { emitter.emit('update-available', { version: '2.2.0' }); emitter.emit('update-downloaded', { version: '2.2.0' }); };
  await app.invoke('update:check');
  await app.invoke('schedule:create', { threadId: 'thread', message: 'Continue', whenISO: new Date(Date.now() + 120_000).toISOString(), timeZone: 'UTC' });
  app.setDialogResponse(0);
  const later = await app.invoke('update:restart');
  assert.equal(later.restarting, false);
  assert.match(later.reason, /^A scheduled message is due in \d minutes?\.$/);
  assert.equal(auto.installs, 0);
  const asked = app.dialogs.at(-1);
  assert.equal(asked.message, 'Restart to update now?');
  assert.deepEqual(plain(asked.buttons), ['Later', 'Restart Anyway']);
  assert.equal(asked.defaultId, 0, 'Later is the default');
  assert.match(asked.detail, /installs by itself the next time you quit Agent Auto-Continue\./);
  const closing = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  app.windows[0].handlers.close(closing);
  assert.equal(closing.defaultPrevented, true, 'declining leaves the rail as it was');
  app.setDialogResponse(1);
  assert.deepEqual(plain(await app.invoke('update:restart')), { restarting: true });
  assert.equal(auto.installs, 1);
});

test('quitAndInstall lets the rail close instead of hiding it', async () => {
  const app = appHarness();
  await app.emit('before-quit-for-update');
  const closing = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  app.windows[0].handlers.close(closing);
  assert.equal(closing.defaultPrevented, false);
});

// A stand-in for lib/install-location.js that answers ensure() when the test says so.
function fakeLocation({ applies = true } = {}) {
  let answer;
  const calls = [];
  const location = { applies: () => applies, readOnly: () => false, ensure: (options) => { calls.push(options); return new Promise((resolve) => { answer = resolve; }); } };
  return { module: { createInstallLocation: () => location }, calls, answer: (value) => answer(value) };
}

test('the move offer runs before the tray, scheduler and window start, and moving quits without starting them', async () => {
  const location = fakeLocation();
  const app = appHarness([], { overrides: { './lib/install-location': location.module } });
  assert.deepEqual(plain(location.calls), [{ ownsInstance: true }]);
  assert.equal(app.trays, 0);
  assert.equal(app.windows.length, 0);
  // A second launch while the question is open must not open a half-started window.
  await app.emit('second-instance');
  assert.equal(app.windows.length, 0);
  location.answer('quit');
  await settle();
  assert.equal(app.quits, 1);
  assert.equal(app.trays, 0);
  assert.equal(app.windows.length, 0);
});

test('choosing Not Now starts the app normally', async () => {
  const location = fakeLocation();
  const app = appHarness([], { overrides: { './lib/install-location': location.module } });
  location.answer('continue');
  await settle();
  assert.equal(app.quits, 0);
  assert.equal(app.trays, 1);
  assert.equal(app.windows.length, 1);
  assert.ok(app.trayMenu.find((item) => item.label === 'Open'));
  await app.emit('before-quit');
});

test('a second instance waits for the move offer instead of quitting, and never starts the scheduler', async () => {
  const location = fakeLocation();
  const app = appHarness([], { ownsInstance: false, overrides: { './lib/install-location': location.module } });
  assert.equal(app.quits, 0, 'not quit before the offer');
  assert.deepEqual(plain(location.calls), [{ ownsInstance: false }]);
  location.answer('continue');
  await settle();
  assert.equal(app.trays, 0, 'only the instance holding the lock runs the scheduler');
  assert.equal(app.quits, 1);
});

test('a second instance with nothing to offer quits at once, as before', () => {
  const location = fakeLocation({ applies: false });
  const app = appHarness([], { ownsInstance: false, overrides: { './lib/install-location': location.module } });
  assert.equal(app.quits, 1);
  assert.equal(location.calls.length, 0);
  assert.equal(app.trays, 0);
});
