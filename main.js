'use strict';

const { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, powerMonitor, shell } = require('electron');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { setInterval, setTimeout } = require('node:timers');
const schedule = require('node-schedule');
const { normaliseConfig, validateSettingsInput } = require('./lib/model');
const { createApiClient, toErrorInfo } = require('./lib/api-client');
const { JobService } = require('./lib/job-service');
const { DEFAULT_HARNESS, applyHarnessSettingsInput, createHarnesses, normaliseHarnessSettings, publicHarnessSettings, resolveHarnessSettings } = require('./lib/harnesses');
const { ACCESSIBILITY_SETTINGS_URL } = require('./lib/desktop/mac-automation');

const APP_NAME = 'T3 Code Auto-Continue';
const DEFAULT_CONFIG = { t3Token: '', httpPort: 3773, bufferSeconds: 5 };
const TURN_POLL_MS = 30_000;
let config = { ...DEFAULT_CONFIG, harnesses: {} };
let service;
let storageError;
let tray;
let dashboardWindow;
let dashboardReady = false;
let pendingNavigation;
let menuRevision = 0;

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

function dateLabel(iso) {
  return new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body });
  notification.on('click', () => openDashboard({ view: 'history' }));
  notification.show();
}

function makeTrayIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><path fill="black" d="M2 2h14v3H2zM4 7h10v3H4zM6 12h6v3H6z"/></svg>`;
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  image.setTemplateImage(true);
  return image;
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

function activeJobs() {
  return service?.jobs.filter((job) => job.status === 'pending' || job.status === 'dispatching') || [];
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

  const pending = activeJobs();
  const jobItems = pending.length ? pending.map((job) => ({
    label: `${job.message} — ${dateLabel(service.present(job).effectiveAt)}${job.status === 'dispatching' ? ' (sending)' : ''}`,
    submenu: [{ label: 'View schedule', click: () => openDashboard({ view: 'upcoming', jobId: job.id }) }, {
      label: 'Cancel',
      enabled: job.status === 'pending',
      click: () => {
        try { ensureStorage(); if (job.status === 'pending') service.cancel(job.id); }
        catch { notify('Schedule could not be canceled', 'Check local disk space and try again in the scheduler.'); }
      }
    }]
  })) : [{ label: 'No scheduled messages', enabled: false }];

  if (revision !== menuRevision) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: APP_NAME, enabled: false },
    { label: connectionLabel, enabled: false },
    { type: 'separator' },
    { label: 'Open scheduler', click: () => openDashboard({ view: 'upcoming' }) },
    { label: 'History', click: () => openDashboard({ view: 'history' }) },
    { label: 'Refresh threads', click: () => void rebuildMenu() },
    { label: 'Schedule from a thread', submenu: threadItems },
    { label: `Scheduled messages (${pending.length})`, submenu: jobItems },
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
ipcMain.handle('harnesses:list', () => ({ harnesses: harnesses.describe(), defaultHarness: DEFAULT_HARNESS }));
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
ipcMain.handle('dashboard:open-settings', () => {
  openSettings();
  return { ok: true };
});

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
  void rebuildMenu();
  openDashboard();
  if (!token()) openSettings();
  setInterval(() => { if (!storageError) void service.pollTurns().catch(() => {}); }, TURN_POLL_MS).unref?.();
  // Give supervised agent turns a bounded chance to stop cleanly before quitting.
  let harnessesStopped = false;
  app.on('before-quit', (event) => {
    if (harnessesStopped) return;
    event.preventDefault();
    harnessesStopped = true;
    void Promise.race([harnesses.shutdown(), new Promise((resolve) => setTimeout(resolve, 6000))]).finally(() => app.quit());
  });
  powerMonitor.on('resume', () => !storageError && void service.resume().catch(() => notify('Schedule could not be updated', 'Check local disk space and restart the app.')));
  app.on('activate', () => { openDashboard(); void rebuildMenu(); });
});

app.on('window-all-closed', () => { /* Keep the scheduler running in the tray. */ });
