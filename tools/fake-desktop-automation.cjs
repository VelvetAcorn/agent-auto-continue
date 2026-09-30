'use strict';
// In-memory stand-in for lib/desktop/mac-automation.js. It models one desktop
// app window with a conversation view, a composer and a send button, records
// every call, and lets tests inject failures. No real user interface is used.
const { ACCESSIBILITY_SETTINGS_URL } = require('../lib/desktop/mac-automation');

function createFakeDesktopAutomation({ bundleId, pid = 4242, view = {}, navigate = () => null, onSend = () => {} } = {}) {
  const state = {
    trusted: true, screenLocked: false, onConsole: true, installed: true, running: true, version: '1.0',
    frontmost: { bundleId: 'com.example.editor', pid: 777 },
    // The conversation currently shown: { urlSegment?, title?, language, composerLabel, sendLabel, composer, sendEnabled, stop }
    view: { urlSegment: null, title: null, language: 'en-US', composerLabel: 'Prompt', sendLabel: 'Send', composer: '', stop: false, sendEnabled: null, ...view },
    // Number of inspections before a navigation takes effect, to model page loads.
    navigationDelay: 0, pendingView: null,
    calls: [], opened: [], sent: [], faults: {}, acceptText: (text) => text
  };
  const record = (name, ...args) => state.calls.push([name, ...args]);
  const fault = (op) => {
    const value = state.faults[op];
    if (value === undefined) return undefined;
    if (typeof value === 'function') return value();
    if (value instanceof Error) throw value;
    return value;
  };
  function shows(match = {}) {
    const view = state.view;
    return Boolean((match.urlSegment && match.urlSegment === view.urlSegment) || (match.title && match.title === view.title));
  }
  function locate(target) {
    if (!state.running) return { error: 'not_running' };
    if (state.pendingView && --state.navigationDelay < 0) { state.view = { ...state.view, ...state.pendingView }; state.pendingView = null; }
    if (!shows(target.match)) return { error: 'content_mismatch' };
    const composer = (target.composerLabels || []).includes(state.view.composerLabel);
    const send = composer && (target.sendLabels || []).includes(state.view.sendLabel);
    return { composer, send };
  }
  function summary(found) {
    const view = state.view;
    return {
      content: { url: view.urlSegment ? `https://example.test/${view.urlSegment}` : 'app://-/index.html', title: view.title || '', language: view.language },
      composer: found.composer ? { value: view.composer, focused: true } : null,
      send: found.send ? { enabled: view.sendEnabled ?? view.composer.trim() !== '' } : null,
      stop: view.stop
    };
  }
  const guard = () => {
    if (!state.trusted) return { ok: false, error: 'untrusted' };
    if (state.screenLocked) return { ok: false, error: 'screen_locked' };
    return null;
  };
  const automation = {
    accessibilitySettingsUrl: ACCESSIBILITY_SETTINGS_URL,
    async environment(bundleIds) {
      record('environment', bundleIds);
      const injected = fault('environment');
      if (injected) return injected;
      const apps = {};
      for (const id of bundleIds) apps[id] = id === bundleId && state.installed
        ? { installedPath: `/Applications/${id}.app`, version: state.version, running: state.running, pid: state.running ? pid : null, active: state.frontmost?.bundleId === id }
        : { installedPath: null, version: null, running: false, pid: null, active: false };
      return { ok: true, trusted: state.trusted, screenLocked: state.screenLocked, onConsole: state.onConsole, frontmost: state.frontmost, apps };
    },
    async inspect(target) {
      record('inspect', target);
      const injected = fault('inspect');
      if (injected) return injected;
      const blocked = guard();
      if (blocked) return blocked;
      const found = locate(target);
      if (found.error) return { ok: false, error: found.error };
      return { ok: true, ...summary(found) };
    },
    async setComposer(target, text) {
      record('setComposer', target, text);
      const injected = fault('setComposer');
      if (injected) return injected;
      const blocked = guard();
      if (blocked) return blocked;
      const found = locate(target);
      if (found.error) return { ok: false, error: found.error };
      if (!found.composer) return { ok: false, error: 'composer_missing' };
      if (state.view.composer.trim() !== '') return { ok: false, error: 'composer_not_empty' };
      state.view.composer = state.acceptText(text);
      return { ok: true, error: null, ...summary(found) };
    },
    async submit(target, text) {
      record('submit', target, text);
      const injected = fault('submit');
      if (injected) return injected;
      const blocked = guard();
      if (blocked) return blocked;
      const found = locate(target);
      if (found.error) return { ok: false, error: found.error };
      if (!found.composer) return { ok: false, error: 'composer_missing' };
      if (state.view.composer !== text) return { ok: false, error: 'value_mismatch' };
      if (!found.send) return { ok: false, error: 'send_missing' };
      state.sent.push({ view: { ...state.view }, text });
      state.view.composer = '';
      onSend(text, state);
      return { ok: true, error: null, pressed: true };
    },
    async clearComposer(target, text) {
      record('clearComposer', target, text);
      if (state.view.composer !== text) return { ok: false, error: 'value_mismatch' };
      state.view.composer = '';
      return { ok: true };
    },
    async activate(targetPid) {
      record('activate', targetPid);
      if (targetPid === 777) state.frontmost = { bundleId: 'com.example.editor', pid: 777 };
      return { ok: true };
    },
    async openUrl(url, schemes) {
      record('openUrl', url, schemes);
      const injected = fault('openUrl');
      if (injected) return injected;
      state.opened.push(url);
      // Real apps bring themselves to the front while handling their links.
      state.frontmost = { bundleId, pid };
      const next = navigate(url, state);
      if (next) { state.pendingView = next; }
    }
  };
  return { automation, state };
}

module.exports = { createFakeDesktopAutomation };
