'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAppLabels } = require('../lib/desktop/app-labels');
const { accessibilityProgram } = require('../lib/desktop/jxa-program');
const { ACCESSIBILITY_SETTINGS_URL, createMacAutomation } = require('../lib/desktop/mac-automation');
const { isScreenLocked, parseConsoleSession } = require('../lib/harnesses/session-lock');

function recorder(respond) {
  const calls = [];
  const runFile = async (file, args, options) => { calls.push({ file, args, options }); return respond({ file, args, options }); };
  return { calls, runFile };
}

test('driver runs one osascript per call with the request embedded as a JSON literal on stdin', async () => {
  const { calls, runFile } = recorder(() => '{"ok":true,"trusted":true}\n');
  const automation = createMacAutomation({ runFile, platform: 'darwin' });
  const result = await automation.setComposer({ bundleId: 'com.example', match: { urlSegment: 'a' } }, 'Continue "now"; $(rm -rf ~)');
  assert.deepEqual(result, { ok: true, trusted: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, '/usr/bin/osascript');
  assert.deepEqual(calls[0].args, ['-l', 'JavaScript', '-'], 'No user text is passed as an argument');
  const source = calls[0].options.input;
  assert.ok(source.startsWith(`(${accessibilityProgram.toString()})(`));
  const literal = JSON.parse(source.slice(`(${accessibilityProgram.toString()})(`.length, -1));
  assert.deepEqual(literal, { op: 'setComposer', bundleId: 'com.example', match: { urlSegment: 'a' }, text: 'Continue "now"; $(rm -rf ~)' });
});

test('driver maps timeouts, crashes and garbage output to structured errors', async () => {
  const timeout = createMacAutomation({ platform: 'darwin', runFile: async () => { throw Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }); } });
  await assert.rejects(timeout.inspect({}), (error) => error.code === 'timeout' && error.deliveryUncertain === false);
  const crash = createMacAutomation({ platform: 'darwin', runFile: async () => { throw Object.assign(new Error('exit 1'), { stderr: 'execution error: Bearer abcdefghijklmnop' }); } });
  await assert.rejects(crash.inspect({}), (error) => error.code === 'process_failed' && !JSON.stringify(error.details).includes('abcdefghijklmnop'));
  const garbage = createMacAutomation({ platform: 'darwin', runFile: async () => 'not json' });
  await assert.rejects(garbage.inspect({}), (error) => error.code === 'unexpected_response_format');
});

test('driver refuses to run off macOS and opens only allow-listed URL schemes in the background', async () => {
  const { calls, runFile } = recorder(() => '');
  await assert.rejects(createMacAutomation({ runFile, platform: 'linux' }).environment([]), (error) => error.code === 'harness_not_installed');
  const automation = createMacAutomation({ runFile, platform: 'darwin' });
  await automation.openUrl('claude://code/continue?session=local_1', ['claude']);
  assert.deepEqual(calls.at(-1).args, ['-g', 'claude://code/continue?session=local_1']);
  assert.equal(calls.at(-1).file, '/usr/bin/open');
  for (const url of ['https://example.com', 'file:///etc/passwd', 'x-apple.systempreferences:x', 'no-scheme']) {
    await assert.rejects(automation.openUrl(url, ['claude']));
  }
  assert.equal(calls.length, 1);
  assert.equal(automation.accessibilitySettingsUrl, ACCESSIBILITY_SETTINGS_URL);
});

test('the Accessibility program is self-contained source that parses on its own', () => {
  const source = accessibilityProgram.toString();
  assert.doesNotThrow(() => new Function(`return (${source})`));
  assert.doesNotMatch(source, /require\(|process\.|CGEventPost|keystroke|key code/, 'It never loads Node modules or synthesises key events');
});

const ioreg = (users) => `<?xml version="1.0"?><plist><dict><key>IOConsoleUsers</key><array>${users.map((user) => `<dict>${Object.entries(user).map(([key, value]) => `<key>${key}</key>${value === true ? '<true/>' : value === false ? '<false/>' : `<integer>${value}</integer>`}`).join('')}</dict>`).join('')}</array><key>IOKitBuildVersion</key><string>x</string></dict></plist>`;

test('screen lock state is read per user from the IORegistry console sessions', async () => {
  assert.deepEqual(parseConsoleSession(ioreg([{ kCGSSessionUserIDKey: 501, CGSSessionScreenIsLocked: true, kCGSSessionOnConsoleKey: true }]), 501), { locked: true, onConsole: true });
  assert.deepEqual(parseConsoleSession(ioreg([{ kCGSSessionUserIDKey: 501, kCGSSessionOnConsoleKey: true }]), 501), { locked: false, onConsole: true });
  assert.deepEqual(parseConsoleSession(ioreg([{ kCGSSessionUserIDKey: 502, kCGSSessionOnConsoleKey: true }]), 501), { locked: true, onConsole: false }, 'Another user on the console');
  assert.equal(parseConsoleSession('<plist/>', 501), null);
  const read = async () => ioreg([{ kCGSSessionUserIDKey: 501, kCGSSessionOnConsoleKey: false }]);
  assert.equal(await isScreenLocked({ read, uid: 501, platform: 'darwin' }), true, 'Fast user switching counts as locked');
  assert.equal(await isScreenLocked({ read: async () => ioreg([{ kCGSSessionUserIDKey: 501, kCGSSessionOnConsoleKey: true }]), uid: 501, platform: 'darwin' }), false);
  assert.equal(await isScreenLocked({ read: async () => { throw new Error('timeout'); }, uid: 501, platform: 'darwin' }), null);
  assert.equal(await isScreenLocked({ read, uid: 501, platform: 'linux' }), null);
});

test('labels come from the app catalogue for the UI language, with English as a fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'labels-'));
  fs.writeFileSync(path.join(dir, 'de-DE.json'), JSON.stringify({ send: 'Senden', prompt: 'Eingabe' }));
  fs.writeFileSync(path.join(dir, 'fr-FR.json'), '{ broken');
  const labels = createAppLabels({ catalogueDirectory: dir, controls: { send: { ids: ['send'], english: ['Send'] }, composer: { ids: ['prompt', 'missing'], english: ['Prompt'] } } });
  assert.deepEqual(labels('de-DE'), { send: ['Senden', 'Send'], composer: ['Eingabe', 'Prompt'] });
  assert.deepEqual(labels('de-AT'), { send: ['Senden', 'Send'], composer: ['Eingabe', 'Prompt'] }, 'Falls back to the same base language');
  assert.deepEqual(labels('fr-FR'), { send: ['Send'], composer: ['Prompt'] }, 'An unreadable catalogue means English only');
  assert.deepEqual(labels('en-US'), { send: ['Send'], composer: ['Prompt'] });
  assert.deepEqual(labels('../../etc'), { send: ['Send'], composer: ['Prompt'] }, 'Locale names are validated before touching the file system');
  fs.rmSync(dir, { recursive: true, force: true });
});

// Runs the real program in osascript without touching any app: an unknown
// bundle ID is never running, so no Accessibility element is created.
test('the Accessibility program runs in osascript and reports environment facts', { skip: process.platform !== 'darwin' }, async () => {
  const automation = createMacAutomation();
  const missing = 'io.example.not-installed-app';
  const env = await automation.environment([missing]);
  assert.equal(env.ok, true);
  assert.equal(typeof env.trusted, 'boolean');
  assert.equal(typeof env.screenLocked, 'boolean');
  assert.deepEqual(env.apps[missing], { installedPath: null, version: null, running: false, pid: null, active: false });
  const view = await automation.inspect({ bundleId: missing, match: { urlSegment: 'x' }, composerLabels: [], sendLabels: [] });
  assert.equal(view.ok, false);
  assert.ok(['not_running', 'untrusted', 'screen_locked'].includes(view.error), view.error);
  assert.equal((await automation.activate(-1)).ok, false);
});

test('desktop error codes are part of the contract and keep their details', () => {
  const { ERROR_CODES, HarnessError, toErrorInfo } = require('../lib/harnesses/errors');
  assert.ok(ERROR_CODES.has('permission_required'));
  assert.ok(ERROR_CODES.has('screen_locked'));
  const info = toErrorInfo(new HarnessError('permission_required', 'Allow access.', { permission: 'accessibility', settingsUrl: ACCESSIBILITY_SETTINGS_URL }));
  assert.deepEqual(info, { code: 'permission_required', message: 'Allow access.', details: { permission: 'accessibility', settingsUrl: ACCESSIBILITY_SETTINGS_URL }, deliveryUncertain: false });
});

test('an app change is a certain, sanitised failure that names the app, its version and what changed', () => {
  const { CONTACT_POINTS, ERROR_CODES, appVersionUnsupported, driftMessage, toErrorInfo } = require('../lib/harnesses/errors');
  assert.ok(ERROR_CODES.has('app_version_unsupported'));
  const error = appVersionUnsupported({ app: 'Claude Desktop', appVersion: '2.17.0', verifiedVersion: '2.16120.0', contactPoint: 'composer_label', hint: `Token Bearer abcdefghijklmnop ${'x'.repeat(400)}` });
  assert.equal(error.message, 'Claude Desktop 2.17.0 changed how its message box is labelled, so Agent Auto-Continue could not send. Nothing was sent.');
  const info = toErrorInfo(error);
  assert.equal(info.deliveryUncertain, false);
  assert.deepEqual(Object.keys(info.details), ['app', 'appVersion', 'verifiedVersion', 'contactPoint', 'hint']);
  assert.doesNotMatch(info.details.hint, /abcdefghijklmnop/);
  assert.ok(info.details.hint.length <= 300);
  assert.equal(appVersionUnsupported({ app: 'ChatGPT (Codex)', contactPoint: 'made_up' }).details.contactPoint, 'unknown', 'Unknown contact points are not passed through');
  assert.match(appVersionUnsupported({ app: 'ChatGPT (Codex)', contactPoint: 'deep_link' }).message, /^ChatGPT \(Codex\) changed how its links open a conversation/, 'An unknown version is left out');
  assert.match(driftMessage({ app: 'A', appVersion: '1', verifiedVersion: '1', contactPoint: 'send_label' }), /^A 1 did not match what this version of Agent Auto-Continue expects/);
  assert.match(driftMessage({ app: 'A', appVersion: '2', contactPoint: 'send_label', during: 'check' }), /^A 2 changed how its send button is labelled\. Scheduled messages for it may fail/);
  assert.match(appVersionUnsupported({ app: 'A', contactPoint: 'transcript', during: 'read' }).message, /^A changed how it records conversations, so Agent Auto-Continue cannot work with it until it supports this version\.$/);
  for (const id of Object.keys(CONTACT_POINTS)) assert.match(id, /^[a-z_]+$/);
});

test('a child that exits before reading its input is a failed call, not a crash', async () => {
  const { run } = require('../lib/desktop/mac-automation');
  // Writing to a pipe whose reader is gone raises EPIPE on stdin, which must not go unhandled.
  await assert.rejects(run('/bin/sh', ['-c', 'exit 3'], { timeout: 5000, input: 'x'.repeat(8 * 1024 * 1024) }), (error) => error.code === 3);
});

test('a call that times out stops the whole process group it started', { skip: process.platform === 'win32' }, async () => {
  const { run } = require('../lib/desktop/mac-automation');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-run-'));
  const pidFile = path.join(dir, 'pid');
  await assert.rejects(run('/bin/sh', ['-c', `sleep 30 & echo $! > "${pidFile}"; wait`], { timeout: 300 }), (error) => error.killed === true);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'The helper the child started is gone too');
  fs.rmSync(dir, { recursive: true, force: true });
});
