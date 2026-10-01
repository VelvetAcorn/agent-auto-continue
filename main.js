'use strict';

const { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, powerMonitor, powerSaveBlocker, shell } = require('electron');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { clearTimeout, setInterval, setTimeout } = require('node:timers');
const schedule = require('node-schedule');
const { normaliseConfig, validateSettingsInput } = require('./lib/model');
const { createApiClient, toErrorInfo } = require('./lib/api-client');
const { RemoteControl } = require('./lib/remote');
const { registerRemoteIpc } = require('./lib/remote/ipc');
const { createContinuationRuns } = require('./lib/remote/continuations');
const { JobService } = require('./lib/job-service');
const { automationSupport } = require('./lib/continuation');
const { DEFAULT_HARNESS, applyHarnessSettingsInput, createHarnesses, normaliseHarnessSettings, publicHarnessSettings, resolveHarnessSettings } = require('./lib/harnesses');
const { ACCESSIBILITY_SETTINGS_URL } = require('./lib/desktop/mac-automation');
const { KeepAwakeController, WorkSourceRegistry, parseBatteryStatus, remoteStatus, validateKeepAwakeInput } = require('./lib/keep-awake');
const { createActiveWorkSource } = require('./lib/active-work-source');
const { createT3WorkSource } = require('./lib/t3-work-source');

const APP_NAME = 'T3 Code Auto-Continue';
const DEFAULT_CONFIG = { t3Token: '', httpPort: 3773, bufferSeconds: 5 };
const TURN_POLL_MS = 30_000;
let config = { ...normaliseConfig(DEFAULT_CONFIG), harnesses: {} };
let service;
let storageError;
let tray;
let dashboardWindow;
let dashboardReady = false;
let pendingNavigation;
let menuRevision = 0;
let workSources;
let activeWorkSource;
let t3WorkSource;
let keepAwake;
let trayKeepAwakeKey = '';
let remote;

const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();

function dataPath(file) {
  return path.join(app.getPath('userData'), file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`The local ${path.basename(file)} file could not be read. Restore or repair it before restarting. Existing data has not been changed.`);
  }
}

function writeJson(file, value) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function loadState() {
  const raw = readJson(dataPath('config.json'), DEFAULT_CONFIG);
  config = { ...normaliseConfig(raw), harnesses: normaliseHarnessSettings(harnesses.list(), raw?.harnesses) };
  service = new JobService({
    jobs: readJson(dataPath('jobs.json'), []), bufferSeconds: config.bufferSeconds, api, harnesses,
    persist: (state) => writeJson(dataPath('jobs.json'), state),
    scheduleTimer: (when, callback) => schedule.scheduleJob(when, callback),
    onChange: () => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('jobs:changed');
      activeWorkSource?.changed();
      t3WorkSource?.changed();
      void rebuildMenu();
    },
    notify: (title, body) => notify(title, body)
  });
}

function saveConfig(value = config) {
  writeJson(dataPath('config.json'), value);
}

function ensureStorage() {
  if (storageError) throw new Error(storageError.message);
}

function publicSettings() {
  return { storageError, httpPort: config.httpPort, bufferSeconds: config.bufferSeconds, hasStoredToken: Boolean(config.t3Token), usingEnvironmentToken: Boolean(process.env.T3_TOKEN),
    harnesses: publicHarnessSettings(harnesses.list(), config.harnesses, process.env) };
}

function token() {
  return (process.env.T3_TOKEN || config.t3Token).trim();
}

const api = createApiClient({ getConfig: () => config, getToken: token });
// Adapters read their settings lazily so a Settings change applies to the next operation.
const harnesses = createHarnesses({ api, clientVersion: app.getVersion?.(), getSettings: (id) => resolveHarnessSettings(harnesses.get(id), config.harnesses?.[id], process.env) });

function harnessFor(id) {
  return harnesses.get(id === undefined || id === null || id === '' ? DEFAULT_HARNESS : id);
}

// Every harness with its capabilities, settings and which automatic continuations it supports.
function describeHarnesses() {
  const described = harnesses.describe();
  return harnesses.list().map((adapter, index) => ({ ...described[index], automation: automationSupport(adapter) }));
}

function createRemoteControl() {
  return new RemoteControl({
    load: () => readJson(dataPath('remote-control.json'), undefined),
    save: (state) => writeJson(dataPath('remote-control.json'), state),
    getService: () => service, ensureStorage, getStorageError: () => storageError,
    // The production registry, so every harness is listed and can be scheduled remotely.
    harnesses: { defaultHarness: DEFAULT_HARNESS, describe: describeHarnesses, has: (id) => harnesses.has(id), get: (id) => harnesses.get(id) },
    // Remote stop, stop-all and resume use the same job service calls as the detail view and the tray.
    automation: createContinuationRuns({ getService: () => service, ensureStorage }),
    keepAwake: { status: () => remoteStatus(requireKeepAwake().snapshot()) },
    appInfo: { name: APP_NAME, version: app.getVersion?.() || '' },
    onChange: () => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('remote:changed'); }
  });
}

function dateLabel(iso) {
  return new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body });
  notification.on('click', () => openDashboard({ view: 'history' }));
  notification.show();
}

function makeTrayIcon(awake = false) {
  // nativeImage cannot decode SVG, so the glyphs ship as PNGs generated by `npm run icons`.
  // Electron loads the @2x file beside each one as the Retina representation.
  // While keep-awake holds an assertion, the top bar shortens and a dot marks the menu-bar icon.
  const image = nativeImage.createFromPath(path.join(__dirname, 'assets', awake ? 'trayAwakeTemplate.png' : 'trayTemplate.png'));
  image.setTemplateImage(true);
  return image;
}

const electronPower = {
  startBlocker: (type) => powerSaveBlocker.start(type),
  stopBlocker: (id) => powerSaveBlocker.stop(id),
  isBlockerStarted: (id) => powerSaveBlocker.isStarted(id),
  isOnBattery: () => powerMonitor.isOnBatteryPower(),
  readBatteryPercent: () => new Promise((resolve, reject) => {
    execFile('/usr/bin/pmset', ['-g', 'batt'], { timeout: 5_000 }, (error, stdout) => error ? reject(error) : resolve(parseBatteryStatus(stdout).percent));
  })
};

function keepAwakeTrayItems(snapshot) {
  if (!snapshot?.enabled) return [];
  const count = snapshot.tasks.length;
  const label = snapshot.holding ? `Keeping Mac awake · ${count} ${count === 1 ? 'task' : 'tasks'}` :
    snapshot.state === 'paused' ? 'Keep-awake paused on battery' : snapshot.state === 'ended' ? 'Keep-awake stopped' : 'Keep-awake on · nothing to track';
  const items = [{ label, enabled: false }];
  if (snapshot.holding) items.push({ label: 'Let Mac sleep now', click: () => keepAwake?.stop() });
  else if (snapshot.state === 'ended' && snapshot.ended?.reason !== 'battery-floor') items.push({ label: 'Keep Mac awake again', click: () => keepAwake?.resume() });
  return items;
}

function publishKeepAwake(snapshot) {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('keep-awake:changed', snapshot);
  if (!tray) return;
  const key = JSON.stringify([snapshot.enabled, snapshot.state, snapshot.holding, snapshot.tasks.length, snapshot.ended?.reason]);
  if (key === trayKeepAwakeKey) return;
  trayKeepAwakeKey = key;
  tray.setImage?.(makeTrayIcon(Boolean(snapshot.holding)));
  tray.setToolTip(snapshot.holding ? `${APP_NAME} · Keeping Mac awake` : APP_NAME);
  void rebuildMenu();
}

function startKeepAwake() {
  workSources = new WorkSourceRegistry();
  // The job service is read through getters: a storage failure at startup replaces it with an empty one.
  const jobs = { get jobs() { return service?.jobs || []; }, activeWork: () => service?.activeWork() || [] };
  // Every harness and every active continuation, including its waiting phase and whether it needs an unlocked screen.
  activeWorkSource = createActiveWorkSource({ service: jobs });
  // T3 Code deliveries the job service cannot follow (unconfirmed, or legacy records without turn tracking),
  // and optionally every running T3 Code agent turn. Both sources name jobs `job:<id>` and the registry keeps
  // the first report of each, so registering activeWork first means it wins and no job is counted twice.
  t3WorkSource = createT3WorkSource({
    service: jobs, api,
    getOptions: () => ({ includeRunningAgents: config.keepAwake.includeRunningAgents, horizonMs: config.keepAwake.maxHours * 3_600_000 })
  });
  workSources.register(activeWorkSource);
  workSources.register(t3WorkSource);
  keepAwake = new KeepAwakeController({ power: electronPower, registry: workSources, settings: config.keepAwake, onChange: publishKeepAwake, notify }).start();
}

function requireKeepAwake() {
  if (!keepAwake) throw new Error('Keep-awake is still starting. Try again in a moment.');
  return keepAwake;
}

function openScheduleWindow(threadId, threadLabel, harness = DEFAULT_HARNESS) {
  openDashboard({ view: 'composer', threadId, threadLabel, harness });
}

function openSettings() {
  openDashboard({ view: 'settings' });
}

function openDashboard(route) {
  if (route) pendingNavigation = route;
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    if (dashboardWindow.isMinimized?.()) dashboardWindow.restore();
    dashboardWindow.show?.();
    dashboardWindow.focus();
    if (dashboardReady && pendingNavigation) {
      dashboardWindow.webContents.send('app:navigate', pendingNavigation);
      pendingNavigation = undefined;
    }
    return;
  }
  dashboardReady = false;
  pendingNavigation ||= { view: 'upcoming' };
  dashboardWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 620,
    minHeight: 560,
    title: APP_NAME,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  dashboardWindow.removeMenu();
  dashboardWindow.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
  dashboardWindow.webContents.on?.('will-navigate', (event) => event.preventDefault());
  dashboardWindow.webContents.once('did-finish-load', () => {
    dashboardReady = true;
    if (pendingNavigation) dashboardWindow.webContents.send('app:navigate', pendingNavigation);
    pendingNavigation = undefined;
  });
  dashboardWindow.loadFile(path.join(__dirname, 'dashboard.html'));
  dashboardWindow.on('closed', () => { dashboardWindow = undefined; dashboardReady = false; });
}

async function activeThreads(options) {
  return harnessFor(options?.harness).listConversations({ showSettled: options?.showSettled === true });
}

// Plain schedules not yet sent, and every active automatic continuation.
function activeJobs() {
  return service?.jobs.filter((job) => service.upcoming(job)) || [];
}

// Schedules listed per item in the tray: everything upcoming, plus paused continuations waiting for the user.
function trayJobs() {
  return service?.jobs.filter((job) => service.upcoming(job) || job.chain?.state === 'paused') || [];
}

function trayJobLabel(job) {
  const view = service.present(job);
  const when = job.chain?.state === 'paused' ? (view.deliveryStatus === 'unconfirmed' ? 'paused · check delivery' : 'paused') : view.displayStatus === 'running' ? 'agent working' : view.displayStatus === 'waiting' ? view.deliveryLabel.toLowerCase() : view.displayStatus === 'dispatching' ? 'sending' : dateLabel(view.effectiveAt);
  return `${job.message.slice(0, 60)} · ${view.automation ? `${view.automation.progressLabel} · ` : ''}${when}`;
}

function trayAction(action, title) {
  try { ensureStorage(); action(); }
  catch (error) { notify(title, String(error?.message || 'Check local disk space and try again in the scheduler.').slice(0, 200)); }
}

function trayJobItem(job) {
  const view = service.present(job);
  const items = [{ id: `view:${job.id}`, label: 'View schedule', click: () => openDashboard({ view: service.upcoming(job) ? 'upcoming' : 'history', jobId: job.id }) }];
  if (!job.chain) {
    items.push({ label: 'Cancel', enabled: job.status === 'pending', click: () => trayAction(() => { if (job.status === 'pending') service.cancel(job.id); }, 'Could not cancel') });
  } else {
    if (job.chain.state === 'paused') {
      items.push({ label: 'Resume continuation', enabled: view.canResume, click: () => trayAction(() => { if (service.present(job).canResume) service.resumeChain(job.id); }, 'Could not resume') });
    }
    items.push({ label: 'Stop continuing', click: () => trayAction(() => { if (service.present(job).canStop) service.stop(job.id); }, 'Could not stop') });
  }
  return { label: trayJobLabel(job), submenu: items };
}

async function rebuildMenu() {
  if (!tray) return;
  const revision = ++menuRevision;
  let threadItems = [];
  let connectionLabel = `T3 Code on port ${config.httpPort}`;
  try {
    const threads = await activeThreads();
    threadItems = threads.slice(0, 100).map((thread) => ({
      label: thread.title || '(Untitled thread)',
      sublabel: thread.projectId || '',
      click: () => openScheduleWindow(thread.id, thread.title || '(Untitled thread)')
    }));
    if (threads.length > 100) threadItems.push({ label: `Showing first 100 of ${threads.length} threads`, enabled: false });
  } catch (error) {
    connectionLabel = `Cannot connect: ${error.message.slice(0, 90)}`;
    threadItems = [{ label: 'Refresh after checking T3 Code and Settings', enabled: false }];
  }

  const listed = trayJobs();
  const continuing = service?.jobs.filter((job) => job.chain && ['active', 'paused'].includes(job.chain.state)) || [];
  const jobItems = listed.length ? listed.map(trayJobItem) : [{ label: 'No scheduled messages', enabled: false }];

  if (revision !== menuRevision) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: APP_NAME, enabled: false },
    { label: connectionLabel, enabled: false },
    ...keepAwakeTrayItems(keepAwake?.snapshot()),
    { type: 'separator' },
    { label: 'Open scheduler', click: () => openDashboard({ view: 'upcoming' }) },
    { label: 'History', click: () => openDashboard({ view: 'history' }) },
    { label: 'Refresh threads', click: () => void rebuildMenu() },
    { label: 'Schedule from a thread', submenu: threadItems },
    { label: `Scheduled messages (${listed.length})`, submenu: jobItems },
    ...(continuing.length ? [{ label: `Stop all continuations (${continuing.length})`, click: () => trayAction(() => service.stopAll(), 'Could not stop') }] : []),
    { type: 'separator' },
    { label: 'Settings…', click: openSettings },
    {
      label: 'Launch at login', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked })
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]));
}

ipcMain.handle('support:open', () => shell.openExternal('https://ko-fi.com/velvetacorn'));
ipcMain.handle('settings:get', publicSettings);
ipcMain.handle('settings:save', (_event, incoming) => {
  ensureStorage();
  const input = validateSettingsInput(incoming);
  const next = { ...normaliseConfig({ ...config, httpPort: input.httpPort, bufferSeconds: input.bufferSeconds }), harnesses: applyHarnessSettingsInput(harnesses.list(), config.harnesses, incoming.harnesses) };
  if (input.t3Token) next.t3Token = input.t3Token;
  saveConfig(next);
  config = next;
  service.bufferSeconds = config.bufferSeconds;
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('settings:changed', publicSettings());
  void rebuildMenu();
  return { ok: true };
});
ipcMain.handle('schedule:create', (_event, incoming) => { ensureStorage(); return service.create(incoming); });
ipcMain.handle('jobs:get', (_event, id) => service.present(service.get(id)));
ipcMain.handle('jobs:list', (_event, options) => ({ ...service.list(options), storageError }));
ipcMain.handle('jobs:edit', (_event, id, incoming) => { ensureStorage(); return service.edit(id, incoming); });
ipcMain.handle('jobs:cancel', (_event, id) => { ensureStorage(); return service.cancel(id); });
ipcMain.handle('jobs:stop', (_event, id) => { ensureStorage(); return service.stop(id); });
ipcMain.handle('jobs:stop-all', () => { ensureStorage(); return service.stopAll(); });
ipcMain.handle('jobs:resume', (_event, id) => { ensureStorage(); return service.resumeChain(id); });
ipcMain.handle('jobs:schedule-again', (_event, id) => service.scheduleAgain(id));
ipcMain.handle('jobs:acknowledge', (_event, id) => { ensureStorage(); return service.acknowledge(id); });
ipcMain.handle('jobs:reconcile', async (_event, id) => {
  try { ensureStorage(); return { ok: true, job: await service.reconcile(id) }; }
  catch (error) { return { ok: false, error: toErrorInfo(error) }; }
});
ipcMain.handle('connection:check', async (_event, harness) => {
  try { await harnessFor(harness).checkConnection(); return { online: true }; }
  catch (error) { return { online: false, error: toErrorInfo(error) }; }
});
// Opens only the Accessibility pane; the renderer cannot choose the URL.
ipcMain.handle('harnesses:open-permission-settings', () => shell.openExternal(ACCESSIBILITY_SETTINGS_URL));
ipcMain.handle('harnesses:list', () => ({ harnesses: describeHarnesses(), defaultHarness: DEFAULT_HARNESS }));
ipcMain.handle('harnesses:availability', async (_event, harness) => {
  try {
    const adapter = harnessFor(harness);
    return { ok: true, availability: adapter.probeAvailability ? await adapter.probeAvailability() : { state: 'unknown', resetsAt: null, reason: 'This harness does not report usage limits.', source: 'none', checkedAt: new Date().toISOString() } };
  } catch (error) { return { ok: false, error: toErrorInfo(error) }; }
});
ipcMain.handle('dashboard:threads', async (_event, options) => {
  const failedJobs = service.jobs.filter((job) => ['failed', 'unconfirmed'].includes(service.present(job).deliveryStatus) && !job.acknowledgedAt)
    .map((job) => ({ id: job.id, message: job.message, note: service.present(job).note }));
  try {
    const threads = await activeThreads({ harness: options?.harness, showSettled: options?.showSettled === true });
    return { online: true, threads, storageError, pendingJobs: activeJobs().length, failedJobs };
  } catch (error) {
    return { online: false, error: error.message, errorInfo: toErrorInfo(error), threads: [], storageError, pendingJobs: activeJobs().length, failedJobs };
  }
});
ipcMain.handle('dashboard:schedule-thread', async (_event, threadId, harness) => {
  if (typeof threadId !== 'string' || !threadId.trim() || threadId.length > 512) throw new Error('Invalid thread ID.');
  const adapter = harnessFor(harness);
  const thread = (await activeThreads({ harness: adapter.id, showSettled: true })).find((candidate) => candidate.id === threadId);
  if (!thread) throw new Error(`That ${adapter.conversationNoun} is no longer available. Refresh and try again.`);
  openScheduleWindow(thread.id, thread.title, adapter.id);
  return { ok: true };
});
registerRemoteIpc(ipcMain, () => remote);
ipcMain.handle('dashboard:open-settings', () => {
  openSettings();
  return { ok: true };
});
ipcMain.handle('keep-awake:get', () => requireKeepAwake().snapshot());
ipcMain.handle('keep-awake:configure', (_event, incoming) => {
  ensureStorage();
  const controller = requireKeepAwake();
  // normaliseConfig only knows the core settings, so harness settings are carried over explicitly.
  const next = { ...normaliseConfig({ ...config, keepAwake: validateKeepAwakeInput(incoming) }), harnesses: config.harnesses };
  saveConfig(next);
  config = next;
  return controller.configure(config.keepAwake);
});
ipcMain.handle('keep-awake:stop', () => requireKeepAwake().stop());
ipcMain.handle('keep-awake:resume', () => requireKeepAwake().resume());

app.on('second-instance', () => openDashboard());

app.whenReady().then(() => {
  if (!ownsInstance) return;
  try {
    loadState();
    service.recover();
  } catch (error) {
    storageError = { code: 'storage_unavailable', message: error.message };
    service ||= new JobService({ jobs: [], api, harnesses, persist: () => ensureStorage() });
  }
  tray = new Tray(makeTrayIcon());
  tray.setToolTip(APP_NAME);
  tray.on('click', () => tray.popUpContextMenu());
  if (!storageError) service.schedulePending();
  remote = createRemoteControl();
  void remote.start();
  // The first keep-awake publish also builds the tray menu.
  startKeepAwake();
  openDashboard();
  if (!token()) openSettings();
  // Turns that were running before a restart are checked straight away, then every 30 seconds.
  if (!storageError) void service.pollTurns().catch(() => {});
  setInterval(() => { if (!storageError) void service.pollTurns().catch(() => {}); }, TURN_POLL_MS).unref?.();
  // Give supervised agent turns a bounded chance to stop cleanly before quitting.
  let harnessesStopped = false;
  app.on('before-quit', (event) => {
    if (harnessesStopped) return;
    event.preventDefault();
    harnessesStopped = true;
    let timeout;
    void Promise.race([harnesses.shutdown(), new Promise((resolve) => { timeout = setTimeout(resolve, 6000); })]).finally(() => { clearTimeout(timeout); app.quit(); });
  });
  powerMonitor.on('suspend', () => keepAwake.handleSuspend());
  powerMonitor.on('resume', () => {
    if (!storageError) void service.resume().catch(() => notify('Schedule could not be updated', 'Check local disk space and restart the app.'));
    void keepAwake.handleResume();
  });
  powerMonitor.on('unlock-screen', () => !storageError && void service.retryAfterUnlock().catch(() => notify('Schedule could not be updated', 'Check local disk space and restart the app.')));
  for (const event of ['on-ac', 'on-battery']) powerMonitor.on(event, () => keepAwake.handlePowerSourceChange());
  app.on('activate', () => { openDashboard(); void rebuildMenu(); });
});

app.on('before-quit', () => { void remote?.stop(); });
app.on('window-all-closed', () => { /* Keep the scheduler running in the tray. */ });
// macOS also releases the assertion if the process crashes or is killed.
app.on('will-quit', () => keepAwake?.dispose());
