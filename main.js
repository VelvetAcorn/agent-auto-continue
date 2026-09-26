'use strict';

const { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, powerMonitor } = require('electron');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const schedule = require('node-schedule');
const {
  buildTurnStartCommand,
  findLatestUserTurnAt,
  hasMessageId,
  normaliseConfig,
  readJobs,
  validateSettingsInput,
  validateScheduleInput
} = require('./lib/model');

const APP_NAME = 'T3 Code Auto-Continue';
const DEFAULT_CONFIG = { t3Token: '', httpPort: 3773, bufferSeconds: 5 };
const jobTimers = new Map();
const runningJobs = new Set();
let config = { ...DEFAULT_CONFIG };
let jobs = [];
let tray;
let settingsWindow;
let dashboardWindow;

if (!app.requestSingleInstanceLock()) app.quit();

function dataPath(file) {
  return path.join(app.getPath('userData'), file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`Could not read ${path.basename(file)}:`, error.message);
    return fallback;
  }
}

function writeJson(file, value) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function loadState() {
  config = normaliseConfig(readJson(dataPath('config.json'), DEFAULT_CONFIG));
  jobs = readJobs(readJson(dataPath('jobs.json'), []));
}

function saveConfig() {
  writeJson(dataPath('config.json'), config);
}

function saveJobs() {
  writeJson(dataPath('jobs.json'), jobs);
}

function token() {
  return (process.env.T3_TOKEN || config.t3Token).trim();
}

function apiBase() {
  return `http://127.0.0.1:${config.httpPort}/api/orchestration`;
}

async function apiRequest(endpoint, options = {}) {
  const credential = token();
  if (!credential) throw new Error('Add a T3 token in Settings or set T3_TOKEN before starting the app.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${apiBase()}/${endpoint}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${credential}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers
      }
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${body.slice(0, 350) || response.statusText}`);
    return body ? JSON.parse(body) : null;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('T3 Code did not respond within 10 seconds.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function fetchSnapshot() {
  return apiRequest('snapshot');
}

function fetchThread(threadId) {
  return apiRequest(`threads/${encodeURIComponent(threadId)}?turnLimit=200`);
}

function snapshotThreads(snapshot) {
  const candidates = [snapshot?.threads, snapshot?.model?.threads, snapshot?.data?.threads];
  return candidates.find(Array.isArray) || [];
}

function threadDetails(snapshot) {
  return snapshot?.thread || snapshot?.data?.thread || snapshot;
}

function dateLabel(iso) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

function updateJob(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  saveJobs();
  void rebuildMenu();
}

function cancelTimer(jobId) {
  const timer = jobTimers.get(jobId);
  if (timer) timer.cancel();
  jobTimers.delete(jobId);
}

function fireTime(job) {
  return new Date(new Date(job.scheduleAt).valueOf() + config.bufferSeconds * 1_000);
}

function scheduleJob(job) {
  cancelTimer(job.id);
  if (job.status !== 'pending') return;
  const planned = fireTime(job);
  const when = planned.valueOf() <= Date.now() ? new Date(Date.now() + 250) : planned;
  const timer = schedule.scheduleJob(when, () => void runJob(job.id));
  jobTimers.set(job.id, timer);
}

async function runJob(jobId) {
  if (runningJobs.has(jobId)) return;
  const job = jobs.find((candidate) => candidate.id === jobId);
  if (!job || job.status !== 'pending') return;
  runningJobs.add(jobId);
  cancelTimer(jobId);
  updateJob(job, { status: 'dispatching', note: 'Checking thread before dispatch' });

  try {
    const snapshot = await fetchThread(job.threadId);
    const thread = threadDetails(snapshot);
    if (!thread || thread.archivedAt) {
      updateJob(job, { status: 'canceled', note: 'Thread is missing or archived' });
      notify(APP_NAME, `Canceled: ${job.message} (thread is no longer available).`);
      return;
    }
    if (hasMessageId(snapshot, job.messageId)) {
      updateJob(job, { status: 'sent', note: 'Message was already present in the thread' });
      return;
    }
    const latestUserTurn = findLatestUserTurnAt(thread);
    if (latestUserTurn && latestUserTurn.valueOf() > new Date(job.scheduleAt).valueOf()) {
      updateJob(job, { status: 'canceled', note: 'A newer user turn already exists' });
      notify(APP_NAME, `Canceled: ${job.message} (the thread has newer user activity).`);
      return;
    }

    await apiRequest('dispatch', { method: 'POST', body: JSON.stringify(buildTurnStartCommand(job, thread)) });
    updateJob(job, { status: 'sent', note: 'Message delivered', dispatchedAt: new Date().toISOString() });
    notify(APP_NAME, `“${job.message}” was sent.`);
  } catch (error) {
    updateJob(job, { status: 'failed', note: error.message });
    notify(APP_NAME, `Could not send “${job.message}”: ${error.message}`);
  } finally {
    runningJobs.delete(jobId);
  }
}

function makeTrayIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><path fill="black" d="M2 2h14v3H2zM4 7h10v3H4zM6 12h6v3H6z"/></svg>`;
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  image.setTemplateImage(true);
  return image;
}

function openScheduleWindow(threadId, threadLabel) {
  const window = new BrowserWindow({
    width: 460,
    height: 390,
    resizable: false,
    title: 'Schedule a message',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  window.removeMenu();
  window.loadFile(path.join(__dirname, 'ui.html'));
  window.webContents.once('did-finish-load', () => window.webContents.send('schedule:init', { threadId, threadLabel, bufferSeconds: config.bufferSeconds }));
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 460,
    height: 410,
    resizable: false,
    title: 'T3 Code Auto-Continue Settings',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  settingsWindow.removeMenu();
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = undefined; });
}

function openDashboard() {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.focus();
    return;
  }
  dashboardWindow = new BrowserWindow({
    width: 560,
    height: 560,
    minWidth: 480,
    minHeight: 420,
    title: APP_NAME,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  dashboardWindow.removeMenu();
  dashboardWindow.loadFile(path.join(__dirname, 'dashboard.html'));
  dashboardWindow.on('closed', () => { dashboardWindow = undefined; });
}

async function activeThreads() {
  const threads = snapshotThreads(await fetchSnapshot())
    .filter((thread) => thread && typeof thread.id === 'string' && !thread.archivedAt)
    .map((thread) => ({ id: thread.id, title: thread.title || '(Untitled thread)', projectId: thread.projectId || '' }));
  return threads;
}

function activeJobs() {
  return jobs.filter((job) => job.status === 'pending' || job.status === 'dispatching');
}

async function rebuildMenu() {
  if (!tray) return;
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
    label: `${job.message} — ${dateLabel(job.scheduleAt)}${job.status === 'dispatching' ? ' (sending)' : ''}`,
    submenu: [{
      label: 'Cancel',
      enabled: job.status === 'pending',
      click: () => {
        cancelTimer(job.id);
        updateJob(job, { status: 'canceled', note: 'Canceled by user' });
      }
    }]
  })) : [{ label: 'No scheduled messages', enabled: false }];

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: APP_NAME, enabled: false },
    { label: connectionLabel, enabled: false },
    { type: 'separator' },
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

ipcMain.handle('settings:get', () => ({ httpPort: config.httpPort, bufferSeconds: config.bufferSeconds, hasStoredToken: Boolean(config.t3Token), usingEnvironmentToken: Boolean(process.env.T3_TOKEN) }));
ipcMain.handle('settings:save', (_event, incoming) => {
  const input = validateSettingsInput(incoming);
  const next = normaliseConfig({ ...config, httpPort: input.httpPort, bufferSeconds: input.bufferSeconds });
  if (input.t3Token) next.t3Token = input.t3Token;
  config = next;
  saveConfig();
  void rebuildMenu();
  return { ok: true };
});
ipcMain.handle('schedule:create', (_event, incoming) => {
  const input = validateScheduleInput(incoming);
  const job = {
    id: randomUUID(), commandId: randomUUID(), messageId: randomUUID(),
    ...input, scheduleAt: input.whenISO, status: 'pending',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), note: ''
  };
  delete job.whenISO;
  jobs.push(job);
  saveJobs();
  scheduleJob(job);
  void rebuildMenu();
  return { id: job.id, scheduleAt: job.scheduleAt };
});
ipcMain.handle('dashboard:threads', async () => {
  try {
    const threads = await activeThreads();
    return { online: true, threads, pendingJobs: activeJobs().length, failedJobs: jobs.filter((job) => job.status === 'failed').map((job) => ({ id: job.id, message: job.message, note: job.note || 'Unknown error' })) };
  } catch (error) {
    return { online: false, error: error.message, threads: [], pendingJobs: activeJobs().length, failedJobs: jobs.filter((job) => job.status === 'failed').map((job) => ({ id: job.id, message: job.message, note: job.note || 'Unknown error' })) };
  }
});
ipcMain.handle('dashboard:schedule-thread', async (_event, threadId) => {
  if (typeof threadId !== 'string' || !threadId.trim() || threadId.length > 512) throw new Error('Invalid thread ID.');
  const thread = (await activeThreads()).find((candidate) => candidate.id === threadId);
  if (!thread) throw new Error('That thread is no longer available. Refresh and try again.');
  openScheduleWindow(thread.id, thread.title);
  return { ok: true };
});
ipcMain.handle('dashboard:open-settings', () => {
  openSettings();
  return { ok: true };
});

app.on('second-instance', () => openDashboard());

app.whenReady().then(() => {
  loadState();
  for (const job of jobs) {
    if (job.status === 'dispatching') {
      job.status = 'pending';
      job.note = 'Recovered after an interrupted dispatch; verifying idempotently';
    }
  }
  saveJobs();
  tray = new Tray(makeTrayIcon());
  tray.setToolTip(APP_NAME);
  tray.on('click', () => tray.popUpContextMenu());
  for (const job of jobs) scheduleJob(job);
  void rebuildMenu();
  openDashboard();
  if (!token()) openSettings();
  powerMonitor.on('resume', () => jobs.filter((job) => job.status === 'pending' && fireTime(job).valueOf() <= Date.now()).forEach((job) => void runJob(job.id)));
  app.on('activate', () => { openDashboard(); void rebuildMenu(); });
});

app.on('window-all-closed', (event) => event.preventDefault());
