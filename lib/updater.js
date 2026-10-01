'use strict';

// Automatic updates from GitHub Releases through electron-updater.
// A released copy checks shortly after launch and then every few hours, downloads a newer
// version in the background, and installs it the next time the app quits normally. The user can
// also restart to install at once; that is the only time this module quits the app, and main.js
// first asks whether queued work would be interrupted (see restartBlocker). Nothing here ever
// quits on its own, so a scheduled message is never cut off by an update.
//
// electron-updater is loaded lazily through `loadAutoUpdater`, so development, the tests and the
// smoke fixture never touch the network or Squirrel. Timers and the clock are injected too.

const CHECK_INTERVAL_MS = 4 * 60 * 60_000;
// The first check waits, so launching at login does not compete with everything else starting.
const STARTUP_DELAY_MS = 60_000;
// How often the schedule is looked at. Checking elapsed time, not counting ticks, means a Mac
// that slept through a check catches up soon after it wakes.
const TICK_MS = 15 * 60_000;
// A queued message due this soon counts as "about to fire" for a restart.
const DUE_SOON_MS = 5 * 60_000;

const STATES = new Set(['disabled', 'idle', 'checking', 'downloading', 'ready', 'error']);

// What went wrong, in words for a person. The raw error stays in the log only.
function friendlyError(error) {
  const code = error?.code || '';
  const text = String(error?.message || '');
  if (code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' || code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' || /No published versions/i.test(text)) return 'No release has been published yet.';
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') return 'The latest release is missing its update information. Try again later.';
  // electron-updater passes GitHub's HTTP errors through as HttpError (code HTTP_ERROR_<status>).
  const status = Number(error?.statusCode) || Number(/^HTTP_ERROR_(\d{3})$/.exec(code)?.[1]) || 0;
  if (status === 404) return 'No published release was found on GitHub.';
  if (status === 403 || status === 429) return 'GitHub is limiting requests right now. Try again later.';
  if (status >= 500) return 'GitHub is not responding right now. Try again later.';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|net::ERR_/i.test(`${code} ${text}`)) return 'GitHub could not be reached. Check the internet connection and try again.';
  if (/code signature|signature|Gatekeeper/i.test(text)) return 'The downloaded update could not be verified, so it was not installed.';
  if (/read-only volume|translocat/i.test(text)) return 'Updates need the app to run from the Applications folder.';
  return 'Something went wrong while checking. Try again later.';
}

// electron-updater's errors carry whole HTTP responses, headers and cookies included; a log line keeps the first line.
function oneLine(message) {
  const text = String(message?.message ?? message ?? '').split('\n')[0].trim();
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

function minutes(ms) {
  const value = Math.max(1, Math.ceil(ms / 60_000));
  return `${value} ${value === 1 ? 'minute' : 'minutes'}`;
}

// Why restarting right now would interrupt queued work, or null when nothing would be.
// `work` is the job service's activeWork(): { phase, effectiveAt, ... } per job.
function restartBlocker(work, { now = Date.now(), dueSoonMs = DUE_SOON_MS } = {}) {
  const items = Array.isArray(work) ? work : [];
  if (items.some((item) => item?.phase === 'sending')) return 'A scheduled message is being sent right now.';
  if (items.some((item) => item?.phase === 'running')) return 'An agent is still working on a message this app sent, and restarting can interrupt agents the app started itself.';
  const due = items.filter((item) => item?.phase === 'scheduled').map((item) => Date.parse(item.effectiveAt)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  if (due !== undefined && due - now <= dueSoonMs) return due <= now ? 'A scheduled message is due now.' : `A scheduled message is due in ${minutes(due - now)}.`;
  return null;
}

function createUpdater({
  loadAutoUpdater, enabled = false, disabledReason = 'development', currentVersion = '',
  now = () => Date.now(), timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  onChange = () => {}, log = () => {},
  checkIntervalMs = CHECK_INTERVAL_MS, startupDelayMs = STARTUP_DELAY_MS, tickMs = TICK_MS
} = {}) {
  let updater = null;
  let state = enabled ? 'idle' : 'disabled';
  let version = null;
  let percent = null;
  let checkedAt = null;
  let lastAttemptAt = null;
  let error = null;
  let pending = null;
  let startupTimer = null;
  let tickTimer = null;

  function snapshot() {
    return { enabled, disabledReason: enabled ? null : disabledReason, state, currentVersion, version, percent, checkedAt: checkedAt ? new Date(checkedAt).toISOString() : null, error };
  }
  function set(patch) {
    const before = JSON.stringify(snapshot());
    if (patch.state !== undefined && STATES.has(patch.state)) state = patch.state;
    if ('version' in patch) version = patch.version;
    if ('percent' in patch) percent = patch.percent;
    if ('error' in patch) error = patch.error;
    if (JSON.stringify(snapshot()) !== before) { try { onChange(snapshot()); } catch { /* A listener cannot break updating. */ } }
  }

  function instance() {
    if (updater) return updater;
    updater = loadAutoUpdater();
    // Downloads start on their own; installing waits for a normal quit or the user's restart.
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.logger = { info: (message) => log('info', oneLine(message)), warn: (message) => log('warn', oneLine(message)), error: (message) => log('error', oneLine(message)), debug: () => {} };
    updater.on('checking-for-update', () => { if (state !== 'ready') set({ state: 'checking', error: null }); });
    updater.on('update-not-available', () => { checkedAt = now(); if (state !== 'ready') set({ state: 'idle', version: null, percent: null, error: null }); });
    updater.on('update-available', (info) => { checkedAt = now(); if (state !== 'ready') set({ state: 'downloading', version: info?.version || null, percent: 0, error: null }); });
    updater.on('download-progress', (progress) => {
      if (state !== 'downloading') return;
      const value = Math.max(0, Math.min(100, Math.floor(Number(progress?.percent) || 0)));
      if (value !== percent) set({ percent: value });
    });
    updater.on('update-downloaded', (info) => set({ state: 'ready', version: info?.version || version, percent: 100, error: null }));
    // An unhandled 'error' event would throw. Errors are recorded quietly; only a manual check reports them.
    updater.on('error', (cause) => {
      log('warn', `Update check failed: ${oneLine(cause)}`);
      if (state !== 'ready') set({ state: 'error', percent: null, error: { message: friendlyError(cause), code: typeof cause?.code === 'string' ? cause.code : null } });
    });
    return updater;
  }

  // Checks once, sharing a check already in progress. Resolves to the snapshot afterwards and never rejects.
  function check() {
    if (!enabled) return Promise.resolve(snapshot());
    if (state === 'ready') return Promise.resolve(snapshot());
    if (pending) return pending;
    lastAttemptAt = now();
    pending = (async () => {
      try {
        set({ state: 'checking', error: null });
        await instance().checkForUpdates();
        // electron-updater resolves without any event when it decides not to check at all.
        if (state === 'checking') set({ state: 'idle' });
      } catch (cause) {
        if (state !== 'ready') set({ state: 'error', percent: null, error: { message: friendlyError(cause), code: typeof cause?.code === 'string' ? cause.code : null } });
      }
      // The download carries on in the background; a check is over once its result is known.
      return snapshot();
    })().finally(() => { pending = null; });
    return pending;
  }

  function due() {
    if (!enabled || state === 'ready' || pending) return false;
    return lastAttemptAt === null || now() - lastAttemptAt >= checkIntervalMs;
  }
  function tick() {
    if (due()) void check();
  }

  function start() {
    if (!enabled || startupTimer || tickTimer) return api;
    startupTimer = timers.setTimeout(() => { startupTimer = null; tick(); }, startupDelayMs);
    startupTimer?.unref?.();
    tickTimer = timers.setInterval(tick, tickMs);
    tickTimer?.unref?.();
    return api;
  }
  function stop() {
    if (startupTimer) timers.clearTimeout(startupTimer);
    if (tickTimer) timers.clearInterval(tickTimer);
    startupTimer = null;
    tickTimer = null;
  }

  // Quits and installs the downloaded update. main.js decides first whether that is all right.
  function install() {
    if (!enabled || state !== 'ready' || !updater) return false;
    stop();
    updater.quitAndInstall(false, true);
    return true;
  }

  const api = { start, stop, check, tick, install, snapshot };
  return api;
}

module.exports = { createUpdater, restartBlocker, friendlyError, CHECK_INTERVAL_MS, STARTUP_DELAY_MS, TICK_MS, DUE_SOON_MS };
