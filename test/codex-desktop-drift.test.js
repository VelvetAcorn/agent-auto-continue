'use strict';
// How the Codex desktop harness behaves when a ChatGPT app update changes
// something it relies on: it must never do the wrong thing, and must say which
// app version changed what instead of failing silently or misleadingly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HarnessError } = require('../lib/harnesses/errors');
const { BUNDLE_ID, createCodexDesktopHarness } = require('../lib/harnesses/codex-desktop');
const { createFakeDesktopAutomation } = require('../tools/fake-desktop-automation.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-codex-desktop');
const START = Date.parse('2026-10-01T09:00:00.000Z');
const THREAD = '01a0f463-49c5-7d82-a1fd-2c4b9fc9a5d0';
const NAME = 'Update live Ko-fi account';
const READS = new Set(['initialize', 'thread/list', 'thread/read', 'thread/turns/list', 'account/rateLimits/read']);
const WRITES = ['setComposer', 'submit', 'clearComposer', 'activate', 'openUrl'];
const writes = (fake) => fake.state.calls.filter((call) => WRITES.includes(call[0]));
const desktopThread = (overrides = {}) => ({ id: THREAD, name: NAME, originator: 'Codex Desktop', source: 'vscode', cliVersion: '0.155.0-alpha.9.2', cwd: '/work/app', ephemeral: false, parentThreadId: null, createdAt: 1790806000, updatedAt: 1790806722, status: { type: 'notLoaded' }, ...overrides });
const userTurn = (overrides = {}) => ({ id: 'turn-1', status: 'completed', startedAt: 1790806570, completedAt: 1790806600, itemsView: 'summary', items: [{ id: 'i-1', type: 'userMessage', content: [{ type: 'text', text: 'Please update' }] }], ...overrides });

// An adapter whose reads go through a real child process speaking the app-server protocol.
function withAppServer(t, state = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-drift-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateFile = path.join(root, 'state.json');
  const log = path.join(root, 'methods.log');
  const write = (value) => fs.writeFileSync(stateFile, JSON.stringify(value));
  const current = { threads: [desktopThread()], turns: { [THREAD]: [userTurn()] }, rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1790810000 }, secondary: null }, ...state };
  write(current);
  const fake = createFakeDesktopAutomation({ bundleId: BUNDLE_ID, view: { title: NAME, composerLabel: 'Do anything', sendLabel: 'Send' } });
  fake.state.version = '27.1.0';
  const adapter = createCodexDesktopHarness({ env: { PATH: path.dirname(process.execPath), FAKE_STATE: stateFile, FAKE_LOG: log }, home: root, platform: 'darwin', automation: fake.automation,
    isLocked: async () => false, sleep: async () => {}, codexPath: () => FIXTURE, exists: () => true });
  const methods = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  return { adapter, fake, state: current, update: (change) => { change(current); write(current); }, methods };
}

const appServerDrift = (error) => {
  assert.equal(error.code, 'app_version_unsupported');
  assert.equal(error.deliveryUncertain, false);
  assert.deepEqual([error.details.app, error.details.appVersion, error.details.contactPoint], ['ChatGPT (Codex)', '27.1.0', 'app_server']);
  assert.match(error.message, /^ChatGPT \(Codex\) 27\.1\.0 changed how its built-in Codex server answers, so Agent Auto-Continue cannot work with it/);
  return true;
};

test('an unrecognised turn status fails closed instead of reading as idle', async (t) => {
  const { adapter, fake, update } = withAppServer(t);
  update((state) => { state.turns[THREAD].push(userTurn({ id: 'turn-2', status: 'queued' })); });
  await assert.rejects(adapter.inspectConversation({ conversationId: THREAD }), (error) => appServerDrift(error) && /turn status "queued"/.test(error.details.hint));
  // Even when inspection is skipped, the send re-checks busy state before typing anything.
  await assert.rejects(adapter.submitTurn({ conversationId: THREAD, message: 'Continue', messageId: 'm', deliveryKey: 'm', dispatchAttemptedAt: new Date(START).toISOString() }, { threadId: THREAD, name: NAME }), appServerDrift);
  assert.deepEqual(writes(fake), []);
});

test('protocol replies the bundled codex cannot read are reported as an app change with its version', async (t) => {
  const { adapter, update } = withAppServer(t);
  update((state) => { state.replies = { 'thread/turns/list': { result: { turns: [] } } }; });
  await assert.rejects(adapter.inspectConversation({ conversationId: THREAD }), (error) => appServerDrift(error) && /turn list/.test(error.details.hint));
  update((state) => { state.replies = { 'thread/list': { error: { code: -32601, message: 'Method not found' } } }; });
  await assert.rejects(adapter.listConversations({}), (error) => appServerDrift(error) && /-32601/.test(error.details.hint));
  // A failure that says nothing about the protocol keeps its own code.
  update((state) => { state.replies = { 'thread/read': { error: { code: -32603, message: 'database is locked' } } }; });
  await assert.rejects(adapter.inspectConversation({ conversationId: THREAD }), (error) => error.code === 'unsupported_response_shape');
});

test('the compatibility check validates the protocol shapes the harness relies on, reading only', async (t) => {
  const { adapter, fake, methods, update } = withAppServer(t);
  let result = await adapter.checkCompatibility();
  assert.ok(result.checked.includes('app_server'), JSON.stringify(result));
  assert.deepEqual(result.problems, []);
  assert.ok(methods().length > 0 && methods().every((method) => READS.has(method)), methods().join(', '));
  assert.ok(methods().includes('thread/turns/list') && methods().includes('account/rateLimits/read'));
  assert.deepEqual(writes(fake), []);

  const cases = [
    [(state) => { state.turns[THREAD] = [userTurn({ status: 'queued' })]; }, /turn status "queued"/],
    [(state) => { state.turns[THREAD] = [userTurn({ startedAt: '2026-10-01' })]; }, /startedAt/],
    [(state) => { state.turns[THREAD] = [userTurn({ items: [{ id: 'i', type: 'userMessage', input: [] }] })]; }, /userMessage/],
    [(state) => { state.turns[THREAD] = [userTurn({ items: [{ id: 'i', type: 'agentMessage', text: 'x' }] }), userTurn({ id: 'turn-0', items: [] })]; }, /no userMessage/],
    [(state) => { state.threads = [desktopThread({ id: undefined, threadId: THREAD })]; }, /thread/],
    [(state) => { state.replies = { 'account/rateLimits/read': { result: { limits: {} } } }; }, /rateLimits/],
    [(state) => { state.replies = { 'thread/turns/list': { error: { code: -32602, message: 'unknown field `limit`' } } }; }, /-32602/]
  ];
  for (const [change, hint] of cases) {
    update((state) => { state.threads = [desktopThread()]; state.turns = { [THREAD]: [userTurn()] }; state.replies = {}; change(state); });
    result = await adapter.checkCompatibility();
    assert.deepEqual(result.problems.map((item) => item.contactPoint), ['app_server'], String(hint));
    assert.match(result.problems[0].hint, hint);
    assert.match(result.problems[0].message, /^ChatGPT \(Codex\) 27\.1\.0 changed how its built-in Codex server answers\. Scheduled messages/);
  }
  assert.deepEqual(writes(fake), []);
});

test('a quick check starts no app-server, and an app-server that will not start is unchecked rather than a problem', async (t) => {
  const { adapter, methods } = withAppServer(t);
  const quick = await adapter.checkCompatibility({ depth: 'quick' });
  assert.deepEqual(quick.unchecked.filter((item) => item.contactPoint === 'app_server'), [{ contactPoint: 'app_server', reason: 'quick' }]);
  assert.deepEqual(methods(), []);
  const reader = { listThreads: async () => [], withClient: async () => { throw new HarnessError('process_failed', 'Codex could not be started.'); } };
  const fake = createFakeDesktopAutomation({ bundleId: BUNDLE_ID });
  const broken = createCodexDesktopHarness({ createReader: () => reader, automation: fake.automation, platform: 'darwin', isLocked: async () => false, sleep: async () => {}, codexPath: () => '/x/codex', exists: () => true });
  const result = await broken.checkCompatibility();
  assert.equal(result.ok, true);
  assert.equal(result.unchecked.find((item) => item.contactPoint === 'app_server').reason, 'process_failed');
});

test('a JSON-RPC "Method not found" is a protocol change, never a missing thread that would cancel jobs', () => {
  const { RpcError, toHarnessError } = require('../lib/harnesses/codex-rpc');
  const missing = toHarnessError(Object.assign(new RpcError(-32601, 'Method not found'), { method: 'thread/turns/list' }));
  assert.deepEqual([missing.code, missing.details.rpcCode, missing.details.method], ['unsupported_response_shape', -32601, 'thread/turns/list']);
  assert.equal(toHarnessError(new RpcError(-32600, `thread not found: ${THREAD}`)).code, 'conversation_not_found');
});
