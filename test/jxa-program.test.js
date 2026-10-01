'use strict';
// Runs the real Accessibility program from jxa-program.js in a VM against an
// in-memory Accessibility tree, so its element matching can be tested without
// osascript or any real app.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { accessibilityProgram } = require('../lib/desktop/jxa-program');

function node(role, props = {}, children = []) {
  const element = { role, ...props, children };
  for (const child of children) child.parent = element;
  return element;
}

// Minimal stand-ins for the JXA globals the program uses (ObjC, $, Ref, delay).
function runProgram(request, { windows, trusted = true, locked = false }) {
  const app = node('AXApplication', {}, windows);
  const pressed = [];
  const list = (items) => ({ count: items.length, objectAtIndex: (index) => items[index] });
  const read = (element, name) => {
    switch (name) {
      case 'AXRole': return element.role;
      case 'AXChildren': return element === app ? undefined : list(element.children);
      case 'AXWindows': return element === app ? list(windows) : undefined;
      case 'AXParent': return element.parent;
      case 'AXDescription': return element.description;
      case 'AXTitle': return element.title;
      case 'AXURL': return element.url;
      case 'AXValue': return element.value;
      case 'AXEnabled': return element.enabled;
      case 'AXLanguage': return element.language;
      case 'AXPlaceholderValue': return element.placeholder;
      default: return undefined;
    }
  };
  const $ = (value) => value;
  Object.assign($, {
    AXIsProcessTrusted: () => trusted,
    AXUIElementCreateApplication: () => app,
    AXUIElementSetMessagingTimeout: () => 0,
    AXUIElementCopyAttributeValue: (element, name, ref) => {
      const value = read(element, name);
      if (value === undefined || value === null) return -25205;
      ref[0] = value;
      return 0;
    },
    AXUIElementSetAttributeValue: (element, name, value) => { if (name === 'AXValue') element.value = value; return 0; },
    AXUIElementPerformAction: (element, action) => { pressed.push({ element, action }); return 0; },
    CGSessionCopyCurrentDictionary: () => ({ CGSSessionScreenIsLocked: locked, kCGSSessionOnConsoleKey: true }),
    NSURL: {},
    NSNumber: { numberWithBool: (value) => value },
    NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => list([{ terminated: false, processIdentifier: 42, active: false }]) }
  });
  const ObjC = { import() {}, bindFunction() {}, deepUnwrap: (value) => value };
  const context = vm.createContext({ ObjC, $, Ref: () => [], delay: () => {} });
  const output = vm.runInContext(`(${accessibilityProgram.toString()})(${JSON.stringify(request)})`, context);
  return { result: JSON.parse(output), pressed };
}

const SESSION = 'local_7de42224-49eb-4544-a87c-181a7de40229';
const target = { bundleId: 'com.example.agent', match: { urlSegment: SESSION }, composerLabels: ['Prompt'], sendLabels: ['Send'], stopLabels: ['Stop'] };

// A window whose verified content area holds the composer, plus controls outside it.
function window({ sendInArea = true, outside = [] } = {}) {
  const composer = node('AXTextArea', { description: 'Prompt', value: 'Continue' });
  const send = node('AXButton', { description: 'Send', enabled: true });
  const area = node('AXWebArea', { url: `https://claude.ai/epitaxy/${SESSION}`, title: 'Session', language: 'en-US' }, [
    node('AXGroup', {}, [node('AXGroup', {}, [composer]), ...(sendInArea ? [node('AXGroup', {}, [send])] : [])])
  ]);
  return { composer, send, window: node('AXWindow', {}, [node('AXGroup', {}, [area]), ...outside]) };
}

test('the send button next to the composer inside the verified content area is pressed', () => {
  const { send, window: win } = window();
  const { result, pressed } = runProgram({ op: 'submit', ...target, text: 'Continue' }, { windows: [win] });
  assert.deepEqual(result, { ok: true, error: null, status: 0, pressed: true });
  assert.equal(pressed.length, 1);
  assert.equal(pressed[0].element, send);
});

test('a same-named button outside the verified content area is never pressed', () => {
  const outsideSend = node('AXButton', { description: 'Send', enabled: true });
  const { window: win } = window({ sendInArea: false, outside: [node('AXGroup', {}, [outsideSend])] });
  const { result, pressed } = runProgram({ op: 'submit', ...target, text: 'Continue' }, { windows: [win] });
  assert.deepEqual(result, { ok: false, error: 'send_missing' });
  assert.equal(pressed.length, 0);
});

test('a Stop button outside the verified content area does not count for this conversation', () => {
  const { window: win } = window({ outside: [node('AXButton', { description: 'Stop', enabled: true })] });
  const { result } = runProgram({ op: 'inspect', ...target }, { windows: [win] });
  assert.equal(result.ok, true);
  assert.equal(result.stop, false);
  assert.deepEqual(result.send, { enabled: true });
});

test('every operation refuses another conversation, a locked screen and missing trust', () => {
  const { window: win } = window();
  assert.equal(runProgram({ op: 'submit', ...target, match: { urlSegment: 'local_other' }, text: 'Continue' }, { windows: [win] }).result.error, 'content_mismatch');
  assert.equal(runProgram({ op: 'submit', ...target, text: 'Continue' }, { windows: [win], locked: true }).result.error, 'screen_locked');
  assert.equal(runProgram({ op: 'setComposer', ...target, text: 'Continue' }, { windows: [win], trusted: false }).result.error, 'untrusted');
});
