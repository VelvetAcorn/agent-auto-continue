'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compatibility, defineHarness } = require('../lib/harnesses/contract');
const { HarnessError, appVersionUnsupported } = require('../lib/harnesses/errors');
const { checkDesktopCompatibility } = require('../lib/desktop/compatibility');
const { claudeDesktop, codexDesktop } = require('../lib/desktop/profiles');
const { createClaudeDesktopHarness } = require('../lib/harnesses/claude-desktop');
const { createCodexDesktopHarness } = require('../lib/harnesses/codex-desktop');
const { createFakeDesktopAutomation } = require('../tools/fake-desktop-automation.cjs');

const SESSION = 'local_7de42224-49eb-4544-a87c-181a7de40229';
const CLI = '660279f3-a100-4809-91a0-dc5991157d17';
const THREAD = '01a0f463-49c5-7d82-a1fd-2c4b9fc9a5d0';
// Operations that could change anything the user sees. A check must never call them.
const WRITES = ['setComposer', 'submit', 'clearComposer', 'activate', 'openUrl'];
const writes = (fake) => fake.state.calls.filter((call) => WRITES.includes(call[0]));
const ops = (fake) => fake.state.calls.map((call) => call[0]);

function claude(t, { view = {}, live = null, files = () => true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-compat-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const index = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', 'account', 'org');
  fs.mkdirSync(index, { recursive: true });
  fs.writeFileSync(path.join(index, `${SESSION}.json`), JSON.stringify({ sessionId: SESSION, cliSessionId: CLI, cwd: home, title: 'Plan', isArchived: false }));
  if (live) {
    fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'sessions', '13299.json'), JSON.stringify({ pid: 13299, sessionId: CLI, entrypoint: 'claude-desktop', status: live }));
  }
  const fake = createFakeDesktopAutomation({ bundleId: claudeDesktop.bundleId, view: { urlSegment: SESSION, ...view } });
  fake.state.version = '2.17.0';
  let slept = 0;
  const adapter = createClaudeDesktopHarness({ home, env: {}, isAlive: (pid) => pid === 13299, automation: fake.automation, isLocked: async () => false, platform: 'darwin',
    exists: files, sleep: async (ms) => { slept += ms; }, appPath: null, processes: async () => [] });
  return { adapter, fake, slept: () => slept };
}

test('a passing check reads the shown session and touches nothing', async (t) => {
  const { adapter, fake } = claude(t);
  const result = await adapter.checkCompatibility();
  assert.equal(result.ok, true);
  assert.deepEqual([result.appVersion, result.verifiedVersion, result.depth], ['2.17.0', '2.16120.0', 'full']);
  assert.deepEqual([...result.checked].sort(), ['app_path', 'composer_label', 'content_match', 'deep_link', 'label_catalogue', 'send_label', 'session_store']);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(writes(fake), [], 'No navigation, typing, pressing or focus change');
  assert.deepEqual(ops(fake), ['environment', 'contentAreas', 'inspect']);
  assert.deepEqual(fake.state.calls[0][1], [claudeDesktop.bundleId]);
});

test('a renamed message box is a problem only after a second look', async (t) => {
  const { adapter, fake, slept } = claude(t, { view: { composerLabel: 'Message Claude' } });
  const result = await adapter.checkCompatibility();
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems.map((item) => item.contactPoint), ['composer_label']);
  assert.equal(result.problems[0].message, 'Claude Desktop 2.17.0 changed how its message box is labelled. Scheduled messages for it may fail until Agent Auto-Continue supports this version.');
  assert.match(result.problems[0].hint, /"Prompt" or "Write your prompt to Claude".*Interface language: en-US/);
  assert.equal(ops(fake).filter((op) => op === 'inspect').length, 2);
  assert.equal(slept(), 1000);
  assert.deepEqual(writes(fake), []);
  assert.equal(result.unchecked.find((item) => item.contactPoint === 'send_label').reason, 'no_composer');
});

test('Claude Desktop shows its send button while empty, so a missing one is a problem', async (t) => {
  const { adapter } = claude(t, { view: { sendLabel: 'Submit' } });
  const result = await adapter.checkCompatibility();
  assert.deepEqual(result.problems.map((item) => item.contactPoint), ['send_label']);
});

test('nothing that cannot be inspected is reported as a problem', async (t) => {
  const cases = [
    [(fake) => { fake.state.view.urlSegment = 'epitaxy'; }, 'no_conversation_shown'],
    [(fake) => { fake.state.running = false; }, 'not_running'],
    [(fake) => { fake.state.trusted = false; }, 'permission_required'],
    [(fake) => { fake.state.screenLocked = true; }, 'screen_locked'],
    [(fake) => { fake.state.view.stop = true; fake.state.view.composerLabel = 'gone'; }, 'agent_working']
  ];
  for (const [change, reason] of cases) {
    const { adapter, fake } = claude(t);
    change(fake);
    const result = await adapter.checkCompatibility();
    assert.equal(result.ok, true, reason);
    assert.equal(result.unchecked.find((item) => item.contactPoint === 'composer_label')?.reason, reason);
    assert.deepEqual(writes(fake), []);
  }
  const busy = claude(t, { live: 'waiting', view: { composerLabel: 'gone' } });
  const result = await busy.adapter.checkCompatibility();
  assert.deepEqual([result.ok, result.unchecked.find((item) => item.contactPoint === 'composer_label').reason], [true, 'agent_working'], 'A session waiting for an answer may hide its message box');
  assert.equal(ops(busy.fake).includes('inspect'), false);
});

test('a quick check reads only the installation and link registration', async (t) => {
  const { adapter, fake } = claude(t, { view: { composerLabel: 'gone' } });
  const result = await adapter.checkCompatibility({ depth: 'quick' });
  assert.deepEqual([result.ok, result.depth], [true, 'quick']);
  assert.deepEqual(ops(fake), ['environment']);
  assert.ok(result.unchecked.some((item) => item.contactPoint === 'composer_label' && item.reason === 'quick'));
});

test('an app that is not installed is unchecked, and a dropped link scheme is a problem', async (t) => {
  const missing = claude(t);
  missing.fake.state.installed = false;
  const result = await missing.adapter.checkCompatibility();
  assert.deepEqual([result.ok, result.appVersion, result.checked], [true, null, []]);
  assert.ok(result.unchecked.every((item) => item.reason === 'not_installed'));

  const dropped = claude(t);
  dropped.fake.state.handlers = { claude: null };
  assert.deepEqual((await dropped.adapter.checkCompatibility()).problems.map((item) => item.contactPoint), ['deep_link']);
  const taken = claude(t);
  taken.fake.state.handlers = { claude: { path: '/Applications/Other.app', bundleId: 'com.example.other' } };
  const other = await taken.adapter.checkCompatibility();
  assert.equal(other.ok, true);
  assert.equal(other.unchecked.find((item) => item.contactPoint === 'deep_link').reason, 'handled_by_other_app');
});

test('the ChatGPT app check recognises a shown thread by name and needs its bundled binary', async () => {
  const fake = createFakeDesktopAutomation({ bundleId: codexDesktop.bundleId, view: { title: 'Fix the build', composerLabel: 'Ask for follow-up changes', sendLabel: 'Dictate' } });
  fake.state.version = '26.915.31945';
  const threads = [{ id: THREAD, name: 'Fix the build', originator: 'Codex Desktop', source: 'vscode' }];
  let turns = [];
  const reader = { listThreads: async () => threads, recentTurns: async () => turns };
  let binary = true;
  const adapter = createCodexDesktopHarness({ createReader: () => reader, automation: fake.automation, platform: 'darwin', isLocked: async () => false, sleep: async () => {},
    codexPath: () => '/Applications/ChatGPT.app/Contents/Resources/codex', exists: (file) => binary || !file.endsWith('/codex') });
  let result = await adapter.checkCompatibility();
  assert.equal(result.ok, true);
  assert.ok(result.checked.includes('composer_label'));
  assert.equal(result.unchecked.find((item) => item.contactPoint === 'send_label').reason, 'hidden_while_empty', 'The ChatGPT app may hide Send while the box is empty');
  assert.deepEqual(writes(fake), []);
  turns = [{ id: 't', status: 'inProgress', items: [] }];
  result = await adapter.checkCompatibility();
  assert.equal(result.unchecked.find((item) => item.contactPoint === 'composer_label').reason, 'agent_working');
  binary = false;
  result = await adapter.checkCompatibility({ depth: 'quick' });
  assert.deepEqual(result.problems.map((item) => [item.contactPoint, item.hint]), [['app_path', 'Contents/Resources/codex is missing inside the app.']]);
  fake.state.view.title = 'ChatGPT';
  binary = true;
  result = await adapter.checkCompatibility();
  assert.equal(result.unchecked.find((item) => item.contactPoint === 'composer_label').reason, 'no_conversation_shown', 'A page that is not a known thread proves nothing');
});

test('per-app probes slot in: drift errors become problems, other failures unchecked, full-only probes skip quick checks', async () => {
  const fake = createFakeDesktopAutomation({ bundleId: claudeDesktop.bundleId, view: { urlSegment: SESSION } });
  const probes = [
    { contactPoints: ['session_store'], depth: 'quick', run: async ({ app }) => { assert.equal(app.version, '1.0'); return { checked: ['session_store'] }; } },
    { contactPoints: ['transcript'], depth: 'quick', run: async () => { throw appVersionUnsupported({ app: 'Claude Desktop', contactPoint: 'transcript', hint: 'Unknown record type', during: 'read' }); } },
    { contactPoints: ['live_registry'], depth: 'quick', run: async () => { throw new HarnessError('timeout', 'slow'); } },
    { contactPoints: ['originator'], depth: 'full', run: async () => ({ problems: [{ contactPoint: 'originator', hint: 'x' }] }) }
  ];
  const quick = await checkDesktopCompatibility({ profile: claudeDesktop, automation: fake.automation, depth: 'quick', exists: () => true, probes });
  assert.deepEqual(quick.problems.map((item) => [item.contactPoint, item.hint]), [['transcript', 'Unknown record type']]);
  assert.match(quick.problems[0].message, /^Claude Desktop 1\.0 changed how it records conversations\. Scheduled messages/);
  assert.ok(quick.checked.includes('session_store'));
  assert.deepEqual(quick.unchecked.filter((item) => ['live_registry', 'originator'].includes(item.contactPoint)), [{ contactPoint: 'live_registry', reason: 'timeout' }, { contactPoint: 'originator', reason: 'quick' }]);
  const full = await checkDesktopCompatibility({ profile: claudeDesktop, automation: fake.automation, exists: () => true, probes });
  assert.deepEqual(full.problems.map((item) => item.contactPoint), ['transcript', 'originator']);
});

test('checkCompatibility is an optional contract method with a normalised result', () => {
  const base = { id: 'x', label: 'X', kind: 'desktop-app', conversationNoun: 'thread', settings: [],
    capabilities: { canDiscoverConversations: false, canConfirmDelivery: false, canDetectUserActivity: false, canDetectCompletion: false, canDetectUsageLimit: false, canReportResetTime: false, requiresRunningApp: true, requiresUnlockedScreen: true, requiresAccessibilityPermission: true },
    checkConnection() {}, listConversations() {}, inspectConversation() {}, prepareTurn() {}, submitTurn() {}, findDelivery() {} };
  assert.equal(typeof defineHarness({ ...base, checkCompatibility: async () => ({}) }).checkCompatibility, 'function');
  assert.throws(() => defineHarness({ ...base, checkCompatibility: true }), /checkCompatibility must be a function/);
  const value = compatibility({ ok: true, appVersion: '1', problems: [{ contactPoint: 'Bad Id', message: 'm' }], checked: ['app_path', 'app_path'], unchecked: [null, { contactPoint: 'deep_link', reason: 'quick' }], depth: 'weird' });
  assert.equal(value.ok, false, 'ok follows the problems, not the adapter');
  assert.deepEqual(value.problems, [{ contactPoint: 'unknown', message: 'm', hint: '' }]);
  assert.deepEqual([value.checked, value.unchecked, value.depth], [['app_path'], [{ contactPoint: 'deep_link', reason: 'quick' }], 'full']);
});
