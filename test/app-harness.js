'use strict';
// Runs the production main.js in a VM with fake Electron, filesystem, power and T3 transport.
// Shared by test/ipc.test.js and test/remote-main.test.js so there is one main-process harness.
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {object[]} initialJobs Jobs saved in jobs.json before launch.
 * @param {object} [options]
 * @param {boolean} [options.ownsInstance] Whether this launch wins the single-instance lock.
 * @param {string} [options.rawJobs] Raw jobs.json contents, overriding initialJobs.
 * @param {object} [options.config] Saved config.json contents.
 * @param {Record<string, string>} [options.extraFiles] Further files in the fake app-data directory.
 * @param {(options: object) => object[]} [options.extraHarnesses] Adapters added to the registry after T3 Code.
 * @param {(registry: object) => object} [options.wrapRegistry] Adjusts the registry main.js receives.
 * @param {Record<string, string>} [options.env] The process environment main.js sees.
 * @param {Record<string, object>} [options.overrides] Modules main.js requires, replaced by name (for example './lib/updater').
 */
function appHarness(initialJobs = [], { ownsInstance = true, rawJobs, config, extraFiles = {}, extraHarnesses, wrapRegistry, env = { T3_TOKEN: 'test-secret' }, overrides = {} } = {}) {
  const handlers = {}, files = new Map(), events = [], windows = [], opened = [], clipboard = [], appEvents = {}, powerEvents = {}, trayEvents = {}, blockers = new Map(), dialogs = [];
  let dialogResponse = 1;
  let quits = 0;
  let nextBlocker = 0;
  let trayMenu, trayTooltip, failWrite = false, trays = 0;
  let ready, response = () => new Response('<!doctype html><html>test-secret</html>', { headers: { 'content-type': 'text/html' } });
  files.set('/fixture/jobs.json', rawJobs ?? JSON.stringify(initialJobs));
  if (config) files.set('/fixture/config.json', JSON.stringify(config));
  for (const [name, value] of Object.entries(extraFiles)) files.set(name, value);
  class Window {
    static getAllWindows() { return windows; }
    constructor(options) {
      this.options = options; this.listeners = {}; this.loaded = false; windows.push(this);
      this.webContents = { send: (...args) => events.push(args), once: (name, callback) => { this.listeners[name] = callback; } };
    }
    finishLoad() { this.loaded = true; this.listeners['did-finish-load']?.(); }
    removeMenu() {} loadFile(file) { this.file = file; } focus() {} isDestroyed() { return this.destroyed === true; }
    on(name, fn) { (this.handlers ||= {})[name] = fn; } removeAllListeners(name) { if (this.handlers) delete this.handlers[name]; }
    show() { this.shown = (this.shown || 0) + 1; this.visible = true; } hide() { this.visible = false; } isVisible() { return this.visible === true; }
    destroy() { this.destroyed = true; this.handlers?.closed?.(); } getSize() { return [this.options.width, this.options.height]; } setPosition() {} setContentSize(width, height) { this.contentSize = [width, height]; }
  }
  const electron = {
    // Every listener is kept, because main.js registers more than one for some app events (before-quit).
    app: { requestSingleInstanceLock: () => ownsInstance, quit() { quits++; }, getVersion: () => '2.1.0', on: (name, fn) => { (appEvents[name] ||= []).push(fn); }, whenReady: () => ({ then: fn => { ready = fn; } }), getPath: () => '/fixture', getLoginItemSettings: () => ({ openAtLogin: false }) },
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, BrowserWindow: Window,
    Menu: { buildFromTemplate: value => { trayMenu = value; return value; } }, Notification: { isSupported: () => false },
    Tray: class { constructor() { trays++; } setToolTip(value) { trayTooltip = value; } setImage() {} on(name, fn) { (trayEvents[name] ||= []).push(fn); } popUpContextMenu() {} },
    nativeImage: { createFromPath: () => ({ setTemplateImage() {} }) },
    powerMonitor: { on: (name, fn) => { powerEvents[name] = fn; }, isOnBatteryPower: () => false },
    powerSaveBlocker: { start: (type) => { blockers.set(nextBlocker, type); return nextBlocker++; }, stop: (id) => blockers.delete(id), isStarted: (id) => blockers.has(id) },
    shell: { openExternal: async (url) => { opened.push(url); } },
    clipboard: { writeText: (text) => { clipboard.push(text); } },
    // Message boxes answer with the button index set by setDialogResponse (default 1, Cancel in this app's dialogs).
    dialog: { showMessageBox: async (options) => { dialogs.push(options); return { response: dialogResponse }; } }
  };
  const fakeFs = { readFileSync: name => { if (!files.has(name)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return files.get(name); }, mkdirSync() {}, writeFileSync: (name, value) => { if (failWrite) throw new Error('Disk full'); files.set(name, value); }, renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); } };
  const apiModule = require('../lib/api-client');
  const harnessModule = require('../lib/harnesses');
  const createHarnesses = (options) => {
    const registry = extraHarnesses ? harnessModule.createHarnessRegistry([require('../lib/harnesses/t3').createT3Harness({ api: options.api }), ...extraHarnesses(options)]) : harnessModule.createHarnesses(options);
    return wrapRegistry ? wrapRegistry(registry) : registry;
  };
  const context = { require: name => Object.hasOwn(overrides, name) ? overrides[name] : name === 'electron' ? electron : name === 'node:fs' ? fakeFs : name === 'node-schedule' ? { scheduleJob: () => ({ cancel() {} }) } : name === './lib/api-client' ? { ...apiModule, createApiClient: options => apiModule.createApiClient({ ...options, fetchImpl: (...args) => response(...args) }) } : name === './lib/harnesses' ? { ...harnessModule, createHarnesses } : name.startsWith('./lib/') ? require(path.join(__dirname, '..', name)) : require(name), __dirname: path.join(__dirname, '..'), process: { env, pid: 123 }, console, Buffer };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), context);
  ready();
  return {
    get quits() { return quits; }, get trays() { return trays; },
    invoke: (name, ...args) => handlers[name]({}, ...args),
    // Calls every listener for an app event with an Electron-like event object.
    emit: (name) => { const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; return Promise.all((appEvents[name] || []).map((fn) => fn(event))); },
    setResponse: fn => { response = fn; }, files, events, windows, opened, clipboard, appEvents, powerEvents, blockers, handlers, dialogs,
    setDialogResponse: (value) => { dialogResponse = value; },
    setWriteFailure: value => { failWrite = value; }, get trayMenu() { return trayMenu; }, get trayTooltip() { return trayTooltip; }, trayEvents
  };
}

module.exports = { appHarness };
