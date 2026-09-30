'use strict';

/* global ObjC, $, Ref, delay */
// macOS Accessibility program executed by `osascript -l JavaScript`.
// It is serialised with Function.prototype.toString(), so it must stay
// self-contained: no closures over module scope and no Node APIs.
// Every operation re-locates its target elements and re-verifies them before
// any write, so a stale element or a changed window can never receive input.
// It never posts keyboard events; text is set through AXValue and submission
// is an AXPress on the verified send button inside the verified content area.
function accessibilityProgram(request) {
  ObjC.import('AppKit');
  ObjC.import('ApplicationServices');
  ObjC.import('CoreGraphics');
  ObjC.bindFunction('AXIsProcessTrusted', ['bool', []]);
  ObjC.bindFunction('AXUIElementCreateApplication', ['id', ['int']]);
  ObjC.bindFunction('AXUIElementCopyAttributeValue', ['int', ['id', 'id', 'id*']]);
  ObjC.bindFunction('AXUIElementSetAttributeValue', ['int', ['id', 'id', 'id']]);
  ObjC.bindFunction('AXUIElementPerformAction', ['int', ['id', 'id']]);
  ObjC.bindFunction('AXUIElementSetMessagingTimeout', ['int', ['id', 'float']]);
  ObjC.bindFunction('CGSessionCopyCurrentDictionary', ['id', []]);

  const MAX_NODES = 20000;
  const MAX_DEPTH = 80;

  // Accessibility values arrive as Objective-C objects. deepUnwrap() leaves URLs
  // wrapped, so they are converted to their string form first.
  function unwrap(value) {
    if (value === undefined || value === null) return null;
    try { if (value.isKindOfClass($.NSURL)) return value.absoluteString.js; } catch (error) { /* Not an Objective-C object. */ }
    try { const plain = ObjC.deepUnwrap(value); return plain === undefined ? null : plain; } catch (error) { return null; }
  }
  function attribute(element, name) {
    const ref = Ref();
    if ($.AXUIElementCopyAttributeValue(element, name, ref) !== 0) return null;
    return ref[0];
  }
  function text(element, name) {
    const value = unwrap(attribute(element, name));
    return typeof value === 'string' ? value : '';
  }
  function bool(element, name) { return unwrap(attribute(element, name)) === true; }
  function children(element) {
    const list = attribute(element, 'AXChildren');
    if (!list) return [];
    const result = [];
    for (let index = 0; index < list.count; index += 1) result.push(list.objectAtIndex(index));
    return result;
  }
  // Iterative depth-first walk with depth and node budgets.
  function walk(root, visit) {
    const stack = [[root, 0]];
    let seen = 0;
    while (stack.length && seen < MAX_NODES) {
      const [element, depth] = stack.pop();
      seen += 1;
      if (visit(element, depth) === false) return;
      // A locked session exposes the application as its own descendant; never recurse into it.
      if (depth >= MAX_DEPTH || (depth > 0 && text(element, 'AXRole') === 'AXApplication')) continue;
      const kids = children(element);
      for (let index = kids.length - 1; index >= 0; index -= 1) stack.push([kids[index], depth + 1]);
    }
  }
  function label(element) { return text(element, 'AXDescription') || text(element, 'AXTitle'); }
  function normalise(value) { return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+$/u, ''); }
  function pathSegments(url) {
    const match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(url || '');
    return match ? match[1].split('/').filter(Boolean).map((part) => { try { return decodeURIComponent(part); } catch (error) { return part; } }) : [];
  }

  function sessionState() {
    const dict = $.CGSessionCopyCurrentDictionary();
    const session = dict ? unwrap(dict) : null;
    if (!session) return { screenLocked: true, onConsole: false };
    return { screenLocked: session.CGSSessionScreenIsLocked === true || session.CGSSessionScreenIsLocked === 1, onConsole: session.kCGSSessionOnConsoleKey !== false && session.kCGSSessionOnConsoleKey !== 0 };
  }
  function frontmost() {
    const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!app || app.isNil()) return null;
    return { bundleId: app.bundleIdentifier.isNil() ? '' : app.bundleIdentifier.js, pid: app.processIdentifier };
  }
  function running(bundleId) {
    const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundleId);
    for (let index = 0; index < apps.count; index += 1) {
      const app = apps.objectAtIndex(index);
      if (!app.terminated) return app;
    }
    return null;
  }
  function describeApp(bundleId) {
    const url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(bundleId);
    const path = url.isNil() ? null : url.path.js;
    let version = null;
    if (path) {
      const bundle = $.NSBundle.bundleWithPath(path);
      const value = bundle.isNil() ? null : bundle.objectForInfoDictionaryKey('CFBundleShortVersionString');
      version = value && !value.isNil() ? value.js : null;
    }
    const app = running(bundleId);
    return { installedPath: path, version, running: Boolean(app), pid: app ? app.processIdentifier : null, active: app ? app.active === true : false };
  }

  function applicationElement(bundleId) {
    const app = running(bundleId);
    if (!app) return null;
    const element = $.AXUIElementCreateApplication(app.processIdentifier);
    $.AXUIElementSetMessagingTimeout(element, 3);
    // Chromium and Electron build their web accessibility tree only on request.
    $.AXUIElementSetAttributeValue(element, 'AXManualAccessibility', $.NSNumber.numberWithBool(true));
    return { app, element };
  }
  function windows(appElement) {
    const list = attribute(appElement, 'AXWindows');
    const result = [];
    if (list) for (let index = 0; index < list.count; index += 1) result.push(list.objectAtIndex(index));
    return result;
  }
  // Finds the web content area that matches `match`: either a URL whose path
  // contains `match.urlSegment`, or a web area titled exactly `match.title`.
  function contentArea(appElement, match) {
    let found = null;
    for (const window of windows(appElement)) {
      walk(window, (element) => {
        if (text(element, 'AXRole') !== 'AXWebArea') return true;
        const url = text(element, 'AXURL');
        const title = text(element, 'AXTitle');
        const byUrl = match.urlSegment && /^https?:/i.test(url) && pathSegments(url).includes(match.urlSegment);
        const byTitle = match.title && title === match.title;
        if (byUrl || byTitle) { found = { element, url, title }; return false; }
        return true;
      });
      if (found) break;
    }
    return found ? { ...found, language: text(found.element, 'AXLanguage') } : null;
  }
  function findComposer(area, labels) {
    let composer = null;
    walk(area, (element) => {
      if (text(element, 'AXRole') === 'AXTextArea' && labels.includes(label(element))) { composer = element; return false; }
      return true;
    });
    return composer;
  }
  // Buttons are matched near the composer, so a same-named control elsewhere
  // in the window is never pressed.
  function findNear(composer, labels) {
    let scope = composer;
    for (let level = 0; level < 8; level += 1) {
      const parent = attribute(scope, 'AXParent');
      if (!parent) break;
      scope = parent;
      let button = null;
      let budget = 600;
      walk(scope, (element) => {
        budget -= 1;
        if (budget <= 0) return false;
        if (text(element, 'AXRole') === 'AXButton' && labels.includes(label(element))) { button = element; return false; }
        return true;
      });
      if (button) return button;
    }
    return null;
  }

  function locate(target) {
    const app = applicationElement(target.bundleId);
    if (!app) return { error: 'not_running' };
    if (!windows(app.element).length) return { error: 'no_window' };
    const area = contentArea(app.element, target.match || {});
    if (!area) return { error: 'content_mismatch' };
    const composer = findComposer(area.element, target.composerLabels || []);
    const send = composer ? findNear(composer, target.sendLabels || []) : null;
    const stop = composer && (target.stopLabels || []).length ? findNear(composer, target.stopLabels) : null;
    return { app, area, composer, send, stop };
  }
  // The composer counts as empty when it only shows its placeholder.
  function composerValue(composer) {
    const value = normalise(text(composer, 'AXValue'));
    const placeholders = [text(composer, 'AXPlaceholderValue'), label(composer)].map((item) => item.trim()).filter(Boolean);
    return placeholders.includes(value.trim()) ? '' : value;
  }
  function summary(found) {
    return {
      content: { url: found.area.url, title: found.area.title, language: found.area.language },
      composer: found.composer ? { value: composerValue(found.composer), focused: bool(found.composer, 'AXFocused') } : null,
      send: found.send ? { enabled: bool(found.send, 'AXEnabled') } : null,
      stop: Boolean(found.stop)
    };
  }
  function guard(mutating) {
    if (!$.AXIsProcessTrusted()) return { ok: false, error: 'untrusted' };
    if (mutating && sessionState().screenLocked) return { ok: false, error: 'screen_locked' };
    return null;
  }

  const operations = {
    environment() {
      const apps = {};
      for (const bundleId of request.bundleIds || []) apps[bundleId] = describeApp(bundleId);
      return { ok: true, trusted: $.AXIsProcessTrusted(), ...sessionState(), frontmost: frontmost(), apps };
    },
    // Read-only list of the web content areas the app shows, for diagnostics.
    contentAreas() {
      const blocked = guard(true);
      if (blocked) return blocked;
      const app = applicationElement(request.bundleId);
      if (!app) return { ok: false, error: 'not_running' };
      const areas = [];
      for (const window of windows(app.element)) {
        walk(window, (element) => {
          if (text(element, 'AXRole') === 'AXWebArea') areas.push({ url: text(element, 'AXURL'), title: text(element, 'AXTitle'), language: text(element, 'AXLanguage') });
          return areas.length < 20;
        });
      }
      return { ok: true, areas };
    },
    inspect() {
      // The tree is not exposed while the screen is locked, so reads need an unlocked session too.
      const blocked = guard(true);
      if (blocked) return blocked;
      const found = locate(request);
      if (found.error) return { ok: false, error: found.error };
      return { ok: true, ...summary(found) };
    },
    setComposer() {
      const blocked = guard(true);
      if (blocked) return blocked;
      const found = locate(request);
      if (found.error) return { ok: false, error: found.error };
      if (!found.composer) return { ok: false, error: 'composer_missing' };
      if (composerValue(found.composer).trim() !== '') return { ok: false, error: 'composer_not_empty' };
      const status = $.AXUIElementSetAttributeValue(found.composer, 'AXValue', $(request.text));
      delay(0.2);
      return { ok: status === 0, error: status === 0 ? null : 'write_failed', status, ...summary(found) };
    },
    submit() {
      const blocked = guard(true);
      if (blocked) return blocked;
      const found = locate(request);
      if (found.error) return { ok: false, error: found.error };
      if (!found.composer) return { ok: false, error: 'composer_missing' };
      if (composerValue(found.composer) !== normalise(request.text)) return { ok: false, error: 'value_mismatch', ...summary(found) };
      if (!found.send) return { ok: false, error: 'send_missing' };
      if (!bool(found.send, 'AXEnabled')) return { ok: false, error: 'send_disabled' };
      const status = $.AXUIElementPerformAction(found.send, 'AXPress');
      return { ok: status === 0, error: status === 0 ? null : 'press_failed', status, pressed: true };
    },
    clearComposer() {
      const blocked = guard(false);
      if (blocked) return blocked;
      const found = locate(request);
      if (found.error) return { ok: false, error: found.error };
      if (!found.composer) return { ok: false, error: 'composer_missing' };
      // Only ever clear text this app put there; a user's draft is never touched.
      if (composerValue(found.composer) !== normalise(request.text)) return { ok: false, error: 'value_mismatch' };
      const status = $.AXUIElementSetAttributeValue(found.composer, 'AXValue', $(''));
      return { ok: status === 0, error: status === 0 ? null : 'write_failed' };
    },
    activate() {
      const apps = $.NSRunningApplication.runningApplicationWithProcessIdentifier(request.pid);
      if (!apps || apps.isNil()) return { ok: false, error: 'not_running' };
      return { ok: apps.activateWithOptions($.NSApplicationActivateIgnoringOtherApps) === true };
    }
  };
  const operation = operations[request.op];
  if (!operation) return JSON.stringify({ ok: false, error: 'unknown_operation' });
  try {
    return JSON.stringify(operation());
  } catch (error) {
    return JSON.stringify({ ok: false, error: 'script_error', message: String(error && error.message || error).slice(0, 200) });
  }
}

module.exports = { accessibilityProgram };
