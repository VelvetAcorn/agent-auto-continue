'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('autoContinue', {
  onNavigate: (callback) => {
    const listener = (_event, route) => callback(route);
    ipcRenderer.on('app:navigate', listener);
    return () => ipcRenderer.removeListener('app:navigate', listener);
  },
  onSettingsChanged: (callback) => {
    const listener = (_event, settings) => callback(settings);
    ipcRenderer.on('settings:changed', listener);
    return () => ipcRenderer.removeListener('settings:changed', listener);
  },
  openSupport: () => ipcRenderer.invoke('support:open'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  getRemote: () => ipcRenderer.invoke('remote:get'),
  configureRemote: (settings) => ipcRenderer.invoke('remote:configure', settings),
  createRemoteToken: (input) => ipcRenderer.invoke('remote:create-token', input),
  revokeRemoteToken: (id) => ipcRenderer.invoke('remote:revoke-token', id),
  clearRemoteAudit: () => ipcRenderer.invoke('remote:clear-audit'),
  onRemoteChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('remote:changed', listener);
    return () => ipcRenderer.removeListener('remote:changed', listener);
  },
  createSchedule: (job) => ipcRenderer.invoke('schedule:create', job),
  onScheduleInit: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('schedule:init', listener);
    return () => ipcRenderer.removeListener('schedule:init', listener);
  },
  getThreads: (options) => ipcRenderer.invoke('dashboard:threads', options),
  getJob: (id) => ipcRenderer.invoke('jobs:get', id),
  listJobs: (options) => ipcRenderer.invoke('jobs:list', options),
  editJob: (id, job) => ipcRenderer.invoke('jobs:edit', id, job),
  cancelJob: (id) => ipcRenderer.invoke('jobs:cancel', id),
  stopJob: (id) => ipcRenderer.invoke('jobs:stop', id),
  stopAllContinuations: () => ipcRenderer.invoke('jobs:stop-all'),
  resumeJob: (id) => ipcRenderer.invoke('jobs:resume', id),
  markNotDelivered: (id, options) => ipcRenderer.invoke('jobs:mark-not-delivered', id, options),
  scheduleAgain: (id) => ipcRenderer.invoke('jobs:schedule-again', id),
  acknowledgeJob: (id) => ipcRenderer.invoke('jobs:acknowledge', id),
  reconcileJob: (id) => ipcRenderer.invoke('jobs:reconcile', id),
  checkConnection: (harness) => ipcRenderer.invoke('connection:check', harness),
  listHarnesses: () => ipcRenderer.invoke('harnesses:list'),
  checkAvailability: (harness) => ipcRenderer.invoke('harnesses:availability', harness),
  openPermissionSettings: () => ipcRenderer.invoke('harnesses:open-permission-settings'),
  getCompatibility: () => ipcRenderer.invoke('harnesses:compatibility'),
  checkCompatibility: (harness) => ipcRenderer.invoke('harnesses:check-compatibility', harness),
  copyDiagnostics: () => ipcRenderer.invoke('diagnostics:copy'),
  onCompatibilityChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('compatibility:changed', listener);
    return () => ipcRenderer.removeListener('compatibility:changed', listener);
  },
  onJobsChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('jobs:changed', listener);
    return () => ipcRenderer.removeListener('jobs:changed', listener);
  },
  getUpdate: () => ipcRenderer.invoke('update:get'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  restartToUpdate: () => ipcRenderer.invoke('update:restart'),
  onUpdateChanged: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('update:changed', listener);
    return () => ipcRenderer.removeListener('update:changed', listener);
  },
  getKeepAwake: () => ipcRenderer.invoke('keep-awake:get'),
  configureKeepAwake: (settings) => ipcRenderer.invoke('keep-awake:configure', settings),
  stopKeepAwake: () => ipcRenderer.invoke('keep-awake:stop'),
  resumeKeepAwake: () => ipcRenderer.invoke('keep-awake:resume'),
  onKeepAwakeChanged: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('keep-awake:changed', listener);
    return () => ipcRenderer.removeListener('keep-awake:changed', listener);
  },
  scheduleThread: (threadId, harness) => ipcRenderer.invoke('dashboard:schedule-thread', threadId, harness),
  openSettings: () => ipcRenderer.invoke('dashboard:open-settings'),
  getLayout: () => ipcRenderer.invoke('layout:get'),
  setLayout: (layout) => ipcRenderer.invoke('layout:set', layout),
  fitWindow: (height) => ipcRenderer.invoke('window:fit', height)
});
