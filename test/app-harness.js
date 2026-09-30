'use strict';
// Runs the production main.js in a VM with fake Electron, filesystem and T3 transport.
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function appHarness(initialJobs = [], { ownsInstance = true, rawJobs, extraFiles = {} } = {}) {
  const handlers = {}, files = new Map(), events = [], windows = [], appEvents = {};
  let trayMenu, failWrite = false;
  let ready, response = () => new Response('<!doctype html><html>test-secret</html>', { headers: { 'content-type': 'text/html' } });
  files.set('/fixture/jobs.json', rawJobs ?? JSON.stringify(initialJobs));
  for (const [name, value] of Object.entries(extraFiles)) files.set(name, value);
  class Window {
    static getAllWindows() { return windows; }
    constructor(options) {
      this.options = options; this.listeners = {}; this.loaded = false; windows.push(this);
      this.webContents = { send: (...args) => events.push(args), once: (name, callback) => { this.listeners[name] = callback; } };
    }
    finishLoad() { this.loaded = true; this.listeners['did-finish-load']?.(); }
    removeMenu() {} loadFile(file) { this.file = file; } on() {} focus() {} isDestroyed() { return false; }
  }
  const electron = {
    app: { requestSingleInstanceLock: () => ownsInstance, quit() {}, on: (name, fn) => { (appEvents[name] ||= []).push(fn); }, whenReady: () => ({ then: fn => { ready = fn; } }), getPath: () => '/fixture', getLoginItemSettings: () => ({ openAtLogin: false }) },
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, BrowserWindow: Window,
    Menu: { buildFromTemplate: value => value }, Notification: { isSupported: () => false },
    Tray: class { setToolTip() {} on() {} setContextMenu(menu) { trayMenu = menu; } },
    nativeImage: { createFromDataURL: () => ({ setTemplateImage() {} }) }, powerMonitor: { on() {} }
  };
  const fakeFs = { readFileSync: name => { if (!files.has(name)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(name); }, mkdirSync() {}, writeFileSync: (name, value) => { if (failWrite) throw new Error('Disk full'); files.set(name, value); }, renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); } };
  const apiModule = require('../lib/api-client');
  const context = { require: name => name === 'electron' ? electron : name === 'node:fs' ? fakeFs : name === 'node-schedule' ? { scheduleJob: () => ({ cancel() {} }) } : name === './lib/api-client' ? { ...apiModule, createApiClient: options => apiModule.createApiClient({ ...options, fetchImpl: (...args) => response(...args) }) } : name.startsWith('./lib/') ? require(path.join(__dirname, '..', name)) : require(name), __dirname: path.join(__dirname, '..'), process: { env: { T3_TOKEN: 'test-secret' }, pid: 123 }, console, Buffer };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), context);
  ready();
  return { invoke: (name, ...args) => handlers[name]({}, ...args), emit: (name) => Promise.all((appEvents[name] || []).map((fn) => fn())), setResponse: fn => { response = fn; }, files, events, windows, setWriteFailure: value => { failWrite = value; }, get trayMenu() { return trayMenu; } };
}

module.exports = { appHarness };
