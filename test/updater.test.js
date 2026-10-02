'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdater, restartBlocker, friendlyError, CHECK_INTERVAL_MS, STARTUP_DELAY_MS, TICK_MS } = require('../lib/updater');

// A stand-in for electron-updater's autoUpdater: checkForUpdates runs a scripted result.
function fakeAutoUpdater(script = async () => {}) {
  const updater = new EventEmitter();
  updater.checks = 0;
  updater.installs = [];
  updater.checkForUpdates = async () => { updater.checks++; return script(updater); };
  updater.quitAndInstall = (...args) => { updater.installs.push(args); };
  return updater;
}

function fakeTimers() {
  const timers = [];
  return {
    timers,
    api: {
      setTimeout: (fn, ms) => { const timer = { fn, ms, kind: 'timeout', cleared: false }; timers.push(timer); return timer; },
      clearTimeout: (timer) => { timer.cleared = true; },
      setInterval: (fn, ms) => { const timer = { fn, ms, kind: 'interval', cleared: false }; timers.push(timer); return timer; },
      clearInterval: (timer) => { timer.cleared = true; }
    }
  };
}

const notAvailable = async (updater) => { updater.emit('checking-for-update'); updater.emit('update-not-available', { version: '2.1.0' }); };
const newVersion = async (updater) => { updater.emit('checking-for-update'); updater.emit('update-available', { version: '2.2.0' }); };

test('a disabled updater never loads electron-updater and reports why', async () => {
  let loaded = false;
  const updater = createUpdater({ enabled: false, disabledReason: 'development', currentVersion: '2.1.0', loadAutoUpdater: () => { loaded = true; return fakeAutoUpdater(); } });
  const { timers, api } = fakeTimers();
  createUpdater({ enabled: false, timers: api }).start();
  assert.equal(timers.length, 0, 'no timers are scheduled');
  assert.deepEqual(await updater.check(), updater.snapshot());
  assert.equal(updater.snapshot().state, 'disabled');
  assert.equal(updater.snapshot().disabledReason, 'development');
  assert.equal(updater.snapshot().currentVersion, '2.1.0');
  assert.equal(updater.install(), false);
  assert.equal(loaded, false);
});

test('the auto updater is configured to download in the background and install only on quit', async () => {
  const auto = fakeAutoUpdater(notAvailable);
  const updater = createUpdater({ enabled: true, loadAutoUpdater: () => auto });
  await updater.check();
  assert.equal(auto.autoDownload, true);
  assert.equal(auto.autoInstallOnAppQuit, true);
  assert.equal(auto.allowPrerelease, false);
  assert.equal(auto.allowDowngrade, false);
  assert.equal(typeof auto.logger.info, 'function');
  assert.ok(auto.listenerCount('error') > 0, 'an error event must never be unhandled');
});

test('checks run shortly after launch and then every few hours, catching up after sleep', async () => {
  let clock = 0;
  const auto = fakeAutoUpdater(notAvailable);
  const { timers, api } = fakeTimers();
  const updater = createUpdater({ enabled: true, loadAutoUpdater: () => auto, timers: api, now: () => clock }).start();
  updater.start();
  assert.deepEqual(timers.map((timer) => [timer.kind, timer.ms]), [['timeout', STARTUP_DELAY_MS], ['interval', TICK_MS]], 'started once');
  const [startup, tick] = timers;
  tick.fn();
  await new Promise(setImmediate);
  assert.equal(auto.checks, 1, 'the first tick checks when nothing was checked yet');
  startup.fn();
  await new Promise(setImmediate);
  assert.equal(auto.checks, 1, 'a check inside the interval is skipped');
  clock += CHECK_INTERVAL_MS - 1;
  tick.fn();
  await new Promise(setImmediate);
  assert.equal(auto.checks, 1);
  // A Mac that slept through the interval checks on the first tick after waking.
  clock += 10 * CHECK_INTERVAL_MS;
  tick.fn();
  await new Promise(setImmediate);
  assert.equal(auto.checks, 2);
  updater.stop();
  assert.equal(tick.cleared, true, 'stopping ends the periodic checks');
});

test('a found update downloads in the background, reports progress and waits for a restart', async () => {
  const auto = fakeAutoUpdater(newVersion);
  const changes = [];
  const updater = createUpdater({ enabled: true, loadAutoUpdater: () => auto, onChange: (snapshot) => changes.push(snapshot.state), now: () => Date.parse('2026-10-01T12:00:00Z') });
  const result = await updater.check();
  assert.equal(result.state, 'downloading');
  assert.equal(result.version, '2.2.0');
  assert.equal(result.checkedAt, '2026-10-01T12:00:00.000Z');
  auto.emit('download-progress', { percent: 41.7 });
  assert.equal(updater.snapshot().percent, 41);
  auto.emit('update-downloaded', { version: '2.2.0' });
  assert.equal(updater.snapshot().state, 'ready');
  assert.deepEqual([...new Set(changes)], ['checking', 'downloading', 'ready']);
  assert.equal(auto.installs.length, 0, 'nothing installs until asked');
  // Once an update is ready, further checks are skipped and an error cannot hide it.
  await updater.check();
  assert.equal(auto.checks, 1);
  auto.emit('error', new Error('late failure'));
  assert.equal(updater.snapshot().state, 'ready');
  assert.equal(updater.install(), true);
  assert.equal(auto.installs.length, 1);
});

test('concurrent checks share one request', async () => {
  let release;
  const auto = fakeAutoUpdater(() => new Promise((resolve) => { release = () => { auto.emit('update-not-available', {}); resolve(); }; }));
  const updater = createUpdater({ enabled: true, loadAutoUpdater: () => auto });
  const first = updater.check();
  const second = updater.check();
  assert.equal(first, second);
  await new Promise(setImmediate);
  release();
  assert.equal((await first).state, 'idle');
  assert.equal(auto.checks, 1);
});

test('a failed check is quiet, friendly and never rejects', async () => {
  const noReleases = Object.assign(new Error('No published versions on GitHub'), { code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' });
  const logs = [];
  const auto = fakeAutoUpdater(async (updater) => { updater.emit('error', noReleases); throw noReleases; });
  const updater = createUpdater({ enabled: true, loadAutoUpdater: () => auto, log: (level, message) => logs.push([level, message]) });
  const result = await updater.check();
  assert.equal(result.state, 'error');
  assert.deepEqual(result.error, { message: 'No release has been published yet.', code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' });
  assert.ok(logs.some(([level, message]) => level === 'warn' && /No published versions/.test(message)), 'the raw error goes to the log');
  // The next check starts over.
  auto.checkForUpdates = async () => { auto.checks++; notAvailable(auto); };
  assert.equal((await updater.check()).state, 'idle');
  assert.equal(updater.snapshot().error, null);
});

test('log lines stay on one short line even when GitHub answers with a whole HTTP response', async () => {
  const response = Object.assign(new Error(`404 \n"method: GET url: https://github.com/VelvetAcorn/agent-auto-continue/releases.atom"\nHeaders: {\n  "set-cookie": ["logged_in=no"]\n}`), { name: 'HttpError', statusCode: 404, code: 'HTTP_ERROR_404' });
  const logs = [];
  const auto = fakeAutoUpdater(async (updater) => { updater.logger.error(`Error: ${response.stack}`); updater.emit('error', response); throw response; });
  const updater = createUpdater({ enabled: true, loadAutoUpdater: () => auto, log: (level, message) => logs.push([level, message]) });
  const result = await updater.check();
  assert.equal(result.error.message, 'No published release was found on GitHub.');
  assert.ok(logs.length >= 2);
  for (const [, message] of logs) {
    assert.doesNotMatch(message, /\n|set-cookie|Headers/, message);
    assert.ok(message.length <= 300);
  }
  assert.deepEqual(logs.at(-1), ['warn', 'Update check failed: 404']);
});

test('a check electron-updater skips without any event ends idle instead of stuck checking', async () => {
  const updater = createUpdater({ enabled: true, loadAutoUpdater: () => fakeAutoUpdater(async () => null) });
  assert.equal((await updater.check()).state, 'idle');
});

test('error messages are written for people', () => {
  assert.equal(friendlyError({ code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND', message: 'x' }), 'No release has been published yet.');
  assert.match(friendlyError(new Error('net::ERR_INTERNET_DISCONNECTED')), /could not be reached/);
  assert.match(friendlyError(Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' })), /could not be reached/);
  assert.match(friendlyError(new Error('Could not get code signature for running application')), /could not be verified/);
  assert.match(friendlyError(new Error('Cannot update while running on a read-only volume')), /Applications folder/);
  // A private or missing repository answers the releases feed with 404.
  assert.equal(friendlyError(Object.assign(new Error('404 Not Found'), { name: 'HttpError', statusCode: 404, code: 'HTTP_ERROR_404' })), 'No published release was found on GitHub.');
  assert.equal(friendlyError({ code: 'HTTP_ERROR_404', message: '' }), 'No published release was found on GitHub.');
  assert.match(friendlyError({ statusCode: 403, code: 'HTTP_ERROR_403' }), /limiting requests/);
  assert.match(friendlyError({ statusCode: 429, code: 'HTTP_ERROR_429' }), /limiting requests/);
  assert.match(friendlyError({ statusCode: 502, code: 'HTTP_ERROR_502' }), /not responding/);
  assert.equal(friendlyError(new Error('something odd')), 'Something went wrong while checking. Try again later.');
});

test('restartBlocker names work a restart would interrupt and ignores work far away', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  const at = (minutes) => new Date(now + minutes * 60_000).toISOString();
  assert.equal(restartBlocker([], { now }), null);
  assert.equal(restartBlocker(undefined, { now }), null);
  assert.equal(restartBlocker([{ phase: 'scheduled', effectiveAt: at(30) }], { now }), null);
  // Waiting work is checked again after a restart, so it does not hold one up.
  assert.equal(restartBlocker([{ phase: 'waiting', effectiveAt: at(1) }], { now }), null);
  assert.equal(restartBlocker([{ phase: 'scheduled', effectiveAt: at(4.2) }, { phase: 'scheduled', effectiveAt: at(1) }], { now }), 'A scheduled message is due in 1 minute.');
  assert.equal(restartBlocker([{ phase: 'scheduled', effectiveAt: at(4.2) }], { now }), 'A scheduled message is due in 5 minutes.');
  assert.equal(restartBlocker([{ phase: 'scheduled', effectiveAt: at(-1) }], { now }), 'A scheduled message is due now.');
  assert.match(restartBlocker([{ phase: 'running' }], { now }), /still working/);
  assert.equal(restartBlocker([{ phase: 'running' }, { phase: 'sending' }], { now }), 'A scheduled message is being sent right now.');
});
