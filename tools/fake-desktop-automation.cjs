'use strict';
// In-memory stand-in for lib/desktop/mac-automation.js. It models one desktop
// app window with a conversation view, a composer and a send button, records
// every call, and lets tests inject failures. No real user interface is used.
const { ACCESSIBILITY_SETTINGS_URL } = require('../lib/desktop/mac-automation');
const { normaliseText } = require('../lib/desktop/ui-delivery');

function createFakeDesktopAutomation({ bundleId, pid = 4242, view = {}, navigate = () => null, onSend = () => {} } = {}) {
  const state = {
    trusted: true, screenLocked: false, onConsole: true, installed: true, running: true, version: '1.0', installedPath: null,
    frontmost: { bundleId: 'com.example.editor', pid: 777 },
    // The conversation currently shown: { urlSegment?, title?, language, composerLabel, sendLabel, composer, sendEnabled, stop }
    view: { urlSegment: null, title: null, language: 'en-US', composerLabel: 'Prompt', sendLabel: 'Send', composer: '', stop: false, sendEnabled: null, ...view },
    // Number of inspections before a navigation takes effect, to model page loads.
    navigationDelay: 0, pendingView: null,
    // The app each URL scheme opens; by default every requested scheme opens this app.
    handlers: null,
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
    // A locked session exposes no content at all, so nothing can be located.
    if (state.screenLocked) return { error: 'content_mismatch' };
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
      send: found.send ? { enabled: sendEnabled() } : null,
      stop: view.stop
    };
  }
  // Mirrors guard() in jxa-program.js: clearing needs trust but not an unlocked screen.
  const guard = (mutating = true) => {
    if (!state.trusted) return { ok: false, error: 'untrusted' };
    if (mutating && state.screenLocked) return { ok: false, error: 'screen_locked' };
    return null;
  };
  const sendEnabled = () => state.view.sendEnabled ?? state.view.composer.trim() !== '';
  const automation = {
    accessibilitySettingsUrl: ACCESSIBILITY_SETTINGS_URL,
    async environment(bundleIds, { schemes = [] } = {}) {
      record('environment', bundleIds);
      const injected = fault('environment');
      if (injected) return injected;
      const apps = {};
      for (const id of bundleIds) apps[id] = id === bundleId && state.installed
        ? { installedPath: state.installedPath || `/Applications/${id}.app`, version: state.version, running: state.running, pid: state.running ? pid : null, active: state.frontmost?.bundleId === id }
        : { installedPath: null, version: null, running: false, pid: null, active: false };
      const handlers = {};
      const own = state.installed ? { path: state.installedPath || `/Applications/${bundleId}.app`, bundleId } : null;
      for (const scheme of schemes) handlers[scheme] = state.handlers && scheme in state.handlers ? state.handlers[scheme] : own;
      return { ok: true, trusted: state.trusted, screenLocked: state.screenLocked, onConsole: state.onConsole, frontmost: state.frontmost, apps, handlers };
    },
    // Read-only list of the web content areas the app shows: the current view only.
    async contentAreas(id) {
      record('contentAreas', id);
      const injected = fault('contentAreas');
      if (injected) return injected;
      const blocked = guard();
      if (blocked) return blocked;
      if (!state.running) return { ok: false, error: 'not_running' };
      if (state.screenLocked) return { ok: true, areas: [] };
      const view = state.view;
      return { ok: true, areas: [{ url: view.urlSegment ? `https://example.test/${view.urlSegment}` : 'app://-/index.html', title: view.title || '', language: view.language }] };
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
      if (normaliseText(state.view.composer) !== normaliseText(text)) return { ok: false, error: 'value_mismatch' };
      if (!found.send) return { ok: false, error: 'send_missing' };
      if (!sendEnabled()) return { ok: false, error: 'send_disabled' };
      state.sent.push({ view: { ...state.view }, text });
      state.view.composer = '';
      onSend(text, state);
      return { ok: true, error: null, pressed: true };
    },
    async clearComposer(target, text) {
      record('clearComposer', target, text);
      const blocked = guard(false);
      if (blocked) return blocked;
      const found = locate(target);
      if (found.error) return { ok: false, error: found.error };
      if (!found.composer) return { ok: false, error: 'composer_missing' };
      if (normaliseText(state.view.composer) !== normaliseText(text)) return { ok: false, error: 'value_mismatch' };
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
