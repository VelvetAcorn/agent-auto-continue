'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('autoContinue', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  createSchedule: (job) => ipcRenderer.invoke('schedule:create', job),
  onScheduleInit: (callback) => ipcRenderer.on('schedule:init', (_event, payload) => callback(payload)),
  getThreads: () => ipcRenderer.invoke('dashboard:threads'),
  scheduleThread: (threadId) => ipcRenderer.invoke('dashboard:schedule-thread', threadId),
  openSettings: () => ipcRenderer.invoke('dashboard:open-settings')
});
