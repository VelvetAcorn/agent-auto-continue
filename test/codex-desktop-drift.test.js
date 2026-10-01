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

// A ChatGPT update that renames the originator its threads are created with.
const APP_CODEX = '0.160.0-alpha.1';
const RENAMED = 'ChatGPT Desktop';
const NEW_THREAD = '01a0f500-0000-7000-8000-000000000001';
function renamed({ threads, writers = new Map([[NEW_THREAD, { pid: 4242, owner: 'codex-desktop' }]]), version = APP_CODEX } = {}) {
  const state = {
    threads: threads || [
      { id: NEW_THREAD, name: 'Plan the launch', originator: RENAMED, source: 'vscode', cliVersion: APP_CODEX, cwd: '/work/app', createdAt: 1790900000, updatedAt: 1790900100 },
      { id: '01a0f500-0000-7000-8000-000000000002', name: 'Draft notes', originator: RENAMED, source: 'vscode', cliVersion: APP_CODEX, cwd: '/work/app', createdAt: 1790900200, updatedAt: 1790900300 },
      { id: '01a0f499-0000-7000-8000-000000000003', name: 'Exec run', originator: 'codex_exec', source: 'exec', cliVersion: '0.159.0', cwd: '/work/app', createdAt: 1790800000, updatedAt: 1790800000 }
    ],
    writers, version, turns: new Map()
  };
  const reader = {
    listThreads: async () => state.threads,
    listAllThreads: async () => ({ threads: state.threads, complete: true }),
    readThread: async (id) => state.threads.find((item) => item.id === id),
    recentTurns: async (id) => state.turns.get(id) || [],
    threadWriter: async (id) => state.writers?.get(id) || null,
    threadWriters: async () => state.writers,
    serverVersion: async () => state.version,
    rateLimits: async () => null
  };
  const fake = createFakeDesktopAutomation({ bundleId: BUNDLE_ID, view: { title: 'Plan the launch', composerLabel: 'Do anything', sendLabel: 'Send' } });
  fake.state.version = '27.0.1';
  const adapter = createCodexDesktopHarness({ createReader: () => reader, automation: fake.automation, platform: 'darwin', isLocked: async () => false, sleep: async () => {}, codexPath: () => '/x/codex', exists: () => true });
  return { adapter, fake, state };
}
const originatorDrift = (error) => {
  assert.equal(error.code, 'app_version_unsupported');
  assert.deepEqual([error.details.contactPoint, error.details.appVersion], ['originator', '27.0.1']);
  assert.match(error.message, /^ChatGPT \(Codex\) 27\.0\.1 creates its threads as "ChatGPT Desktop", which this version of Agent Auto-Continue does not recognise yet/);
  assert.match(error.details.hint, /2 recent threads with originator "ChatGPT Desktop" \(source vscode\)/);
  return true;
};

test('an originator renamed by an app update is reported, not shown as an empty thread list', async () => {
  const { adapter } = renamed();
  await assert.rejects(adapter.listConversations({}), originatorDrift);
});

test('a thread created under the renamed originator is refused with the reason, and never claimed', async () => {
  const { ownerOfThread } = require('../lib/harnesses/codex-reader');
  const { adapter, state } = renamed();
  await assert.rejects(adapter.inspectConversation({ conversationId: NEW_THREAD }), (error) => originatorDrift(error) && /cannot schedule this thread yet/.test(error.message));
  // Neither Codex harness claims it: ownership stays strict.
  assert.equal(ownerOfThread(state.threads[0]), 'other');
});

test('the compatibility check reports the renamed originator, and proves the known one', async () => {
  const drifted = renamed();
  let result = await drifted.adapter.checkCompatibility();
  assert.deepEqual(result.problems.map((item) => item.contactPoint), ['originator']);
  assert.match(result.problems[0].message, /^ChatGPT \(Codex\) 27\.0\.1 creates its threads as "ChatGPT Desktop", which this version of Agent Auto-Continue does not recognise yet/);
  assert.deepEqual(writes(drifted.fake), []);
  const healthy = renamed({ threads: [{ id: NEW_THREAD, name: 'Plan the launch', originator: 'Codex Desktop', source: 'vscode', cliVersion: APP_CODEX, cwd: '/w', createdAt: 1, updatedAt: 2 }] });
  result = await healthy.adapter.checkCompatibility();
  assert.ok(result.checked.includes('originator'));
  const stale = renamed({ threads: [{ id: NEW_THREAD, name: 'Plan the launch', originator: 'Codex Desktop', source: 'vscode', cliVersion: '0.150.0', cwd: '/w', createdAt: 1, updatedAt: 2 }] });
  result = await stale.adapter.checkCompatibility();
  assert.equal(result.unchecked.find((item) => item.contactPoint === 'originator')?.reason, 'no_recent_threads', 'No thread made by this build proves nothing either way');
});

test('one signal alone is not drift: other Codex apps keep their own threads', async () => {
  // The ChatGPT app opened a thread another Codex client created: it holds the lock, but another build made it.
  const opened = renamed({ threads: [{ id: NEW_THREAD, name: 'IDE thread', originator: 'codex_vscode', source: 'vscode', cliVersion: '0.158.0', cwd: '/w', createdAt: 1, updatedAt: 2 }] });
  assert.deepEqual(await opened.adapter.listConversations({}), []);
  await assert.rejects(opened.adapter.inspectConversation({ conversationId: NEW_THREAD }), (error) => error.code === 'owned_by_other_harness' && error.details.harness === 'other');
  assert.equal((await opened.adapter.checkCompatibility()).problems.length, 0);
  // Another client that ships the same codex build, with no lock held by the app.
  const sameBuild = renamed({ writers: new Map() });
  assert.deepEqual(await sameBuild.adapter.listConversations({}), []);
  // Lock holders that cannot be read, or a server version that cannot be, detect nothing.
  assert.deepEqual(await renamed({ writers: null }).adapter.listConversations({}), []);
  assert.deepEqual(await renamed({ version: null }).adapter.listConversations({}), []);
});

test('with recognised threads too, they stay listed and the check carries the warning', async () => {
  const { adapter, state } = renamed();
  state.threads.push({ id: THREAD, name: NAME, originator: 'Codex Desktop', source: 'vscode', cliVersion: '0.155.0-alpha.9.2', cwd: '/work/app', createdAt: 1790806000, updatedAt: 1790806722 });
  assert.deepEqual((await adapter.listConversations({})).map((item) => item.id), [THREAD]);
  assert.deepEqual((await adapter.checkCompatibility()).problems.map((item) => item.contactPoint), ['originator']);
});

// A fake app whose deep link shows `shows` (a view change) after opening the thread's link.
function titled({ before = 'Rename repo', shows, threads } = {}) {
  const list = threads || [
    { id: THREAD, name: NAME, originator: 'Codex Desktop', source: 'vscode', cwd: '/work/app', updatedAt: 1790806722 },
    { id: '01a0f450-98b4-77c0-a6df-d45777e05f40', name: 'Rename repo', originator: 'Codex Desktop', source: 'vscode', cwd: '/work/app', updatedAt: 1790806000 }
  ];
  const reader = { listThreads: async () => list, listAllThreads: async () => ({ threads: list, complete: true }), recentTurns: async () => [], readThread: async (id) => list.find((item) => item.id === id), threadWriter: async () => null };
  const fake = createFakeDesktopAutomation({ bundleId: BUNDLE_ID, view: { title: before, composerLabel: 'Do anything', sendLabel: 'Send' }, navigate: () => (shows === undefined ? null : { title: shows }) });
  fake.state.version = '27.2.0';
  let clock = START;
  const adapter = createCodexDesktopHarness({ createReader: () => reader, automation: fake.automation, platform: 'darwin', isLocked: async () => false, now: () => clock, sleep: async (ms) => { clock += ms; },
    timings: { navigateMs: 3000, confirmMs: 3000, pollMs: 250 }, codexPath: () => '/x/codex', exists: () => true });
  const send = () => adapter.submitTurn({ conversationId: THREAD, message: 'Continue', messageId: 'm', deliveryKey: 'm', dispatchAttemptedAt: new Date(START).toISOString() }, { threadId: THREAD, name: NAME });
  return { adapter, fake, send };
}

test('a thread shown under a reformatted title is reported as content_match, not as a link problem', async () => {
  const { fake, send } = titled({ shows: `${NAME} - ChatGPT` });
  await assert.rejects(send(), (error) => {
    assert.deepEqual([error.code, error.deliveryUncertain, error.details.contactPoint, error.details.appVersion], ['timeout', false, 'content_match', '27.2.0']);
    assert.match(error.message, /ChatGPT \(Codex\) 27\.2\.0 did not show the thread in time\. Nothing was sent\. If ChatGPT \(Codex\) was updated recently, it may have changed how it shows which conversation is open\./);
    assert.match(error.details.hint, /title is the thread name with 10 more characters after it/);
    assert.ok(!error.details.hint.includes(NAME), 'Thread names never reach logs');
    return true;
  });
  assert.equal(fake.state.sent.length, 0);
  assert.deepEqual(fake.state.calls.filter((call) => ['setComposer', 'submit'].includes(call[0])), []);
});

test('a new view with a message box after the link is content_match; an unchanged view still points at the link', async () => {
  // The title no longer carries the name at all, but the link did change the view.
  await assert.rejects(titled({ shows: 'ChatGPT' }).send(), (error) => error.details.contactPoint === 'content_match' && /appeared after the link opened/.test(error.details.hint));
  // The link changed nothing: the same view as before is still shown.
  await assert.rejects(titled({ before: 'ChatGPT' }).send(), (error) => error.code === 'timeout' && error.details.contactPoint === 'deep_link' && /links open a thread/.test(error.message));
  await assert.rejects(titled({ shows: 'Rename repo' }).send(), (error) => error.details.contactPoint === 'deep_link');
});

test('the compatibility check reports a shown thread whose title embeds its name, and ignores other pages', async () => {
  let { adapter, fake } = titled({ before: `${NAME} — Codex` });
  let result = await adapter.checkCompatibility();
  assert.deepEqual(result.problems.map((item) => item.contactPoint), ['content_match']);
  assert.match(result.problems[0].message, /^ChatGPT \(Codex\) 27\.2\.0 changed how it shows which conversation is open\. Scheduled messages/);
  assert.match(result.problems[0].hint, /thread name with 8 more characters after it/);
  assert.ok(!result.problems[0].hint.includes(NAME));
  assert.ok(!result.unchecked.some((item) => item.contactPoint === 'content_match'));
  assert.deepEqual(writes(fake), []);
  ({ adapter } = titled({ before: `Codex: ${NAME}` }));
  assert.match((await adapter.checkCompatibility()).problems[0]?.hint || '', /7 more characters before it/);
  // A page that is not a thread, such as the start page, proves nothing either way.
  ({ adapter } = titled({ before: 'ChatGPT' }));
  result = await adapter.checkCompatibility();
  assert.deepEqual(result.problems, []);
  assert.equal(result.unchecked.find((item) => item.contactPoint === 'content_match').reason, 'no_conversation_shown');
  // Without a message box the view may still be loading or not a thread: no problem.
  ({ adapter, fake } = titled({ before: `${NAME} - ChatGPT` }));
  fake.state.view.composerLabel = 'Something else';
  assert.deepEqual((await adapter.checkCompatibility()).problems, []);
});

// The ChatGPT app shown in another interface language, with its labels translated.
function localised(view) {
  const result = titled({ before: NAME });
  Object.assign(result.fake.state.view, view);
  return result;
}
const languageRefusal = (contactPoint, what, language) => (error) => {
  assert.deepEqual([error.code, error.deliveryUncertain, error.details.contactPoint, error.details.reason, error.details.language, error.details.appVersion], ['harness_not_configured', false, contactPoint, 'unsupported_language', language, '27.2.0']);
  assert.match(error.message, new RegExp(`^ChatGPT \\(Codex\\) 27\\.2\\.0 shows its interface in .*\\(${language}\\), but Agent Auto-Continue only knows its English labels, so it could not find the ${what}\\. Switch ChatGPT to English to schedule messages in it\\. Nothing was sent\\.$`));
  return true;
};

test('a translated message box in another interface language is reported as unsupported, not as an app change', async () => {
  const { fake, send } = localised({ language: 'de-DE', composerLabel: 'Frag einfach' });
  await assert.rejects(send(), languageRefusal('composer_label', 'message box', 'de-DE'));
  assert.deepEqual(fake.state.calls.filter((call) => ['setComposer', 'submit'].includes(call[0])), []);
});

test('a translated send button is reported the same way, and the inserted text is removed', async () => {
  const { fake, send } = localised({ language: 'fr', sendLabel: 'Envoyer' });
  await assert.rejects(send(), languageRefusal('send_label', 'send button', 'fr'));
  assert.equal(fake.state.sent.length, 0);
  assert.equal(fake.state.view.composer, '');
});

test('in English, a renamed label is still an app change; with a translated label the check says why', async () => {
  const english = localised({ language: 'en-GB', composerLabel: 'Ask ChatGPT' });
  await assert.rejects(english.send(), (error) => error.code === 'app_version_unsupported' && error.details.contactPoint === 'composer_label');
  let result = await localised({ language: 'en-GB', composerLabel: 'Ask ChatGPT' }).adapter.checkCompatibility();
  assert.match(result.problems[0].message, /changed how its message box is labelled/);
  const german = localised({ language: 'de-DE', composerLabel: 'Frag einfach' });
  result = await german.adapter.checkCompatibility();
  assert.deepEqual(result.problems.map((item) => item.contactPoint), ['composer_label']);
  assert.match(result.problems[0].message, /^ChatGPT \(Codex\) 27\.2\.0 shows its interface in .*\(de-DE\), but Agent Auto-Continue only knows its English labels\. Scheduled messages for it will fail until ChatGPT is switched to English\.$/);
  assert.match(result.problems[0].hint, /Interface language: de-DE/);
  assert.deepEqual(writes(german.fake), []);
  // Labels that still match in another language are fine.
  assert.deepEqual((await localised({ language: 'de-DE' }).adapter.checkCompatibility()).problems, []);
});
