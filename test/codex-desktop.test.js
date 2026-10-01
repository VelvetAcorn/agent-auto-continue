'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BUNDLE_ID, createCodexDesktopHarness } = require('../lib/harnesses/codex-desktop');
const { createFakeDesktopAutomation } = require('../tools/fake-desktop-automation.cjs');

const START = Date.parse('2026-10-01T09:00:00.000Z');
const THREAD = '01a0f463-49c5-7d82-a1fd-2c4b9fc9a5d0';
const OTHER = '01a0f450-98b4-77c0-a6df-d45777e05f40';

function fakeReader() {
  const state = {
    threads: [
      { id: THREAD, name: 'Update live Ko-fi account', originator: 'Codex Desktop', source: 'vscode', cwd: '/work/app', updatedAt: 1790806722 },
      { id: OTHER, name: 'Rename repo', originator: null, source: 'vscode', cwd: '/work/app', updatedAt: 1790806000 },
      { id: '01a0f499-e435-7682-aec4-b694f2bcc9aa', name: 'Exec run', originator: 'codex_exec', source: 'exec', cwd: '/work/app', updatedAt: 1790809999 },
      { id: '01a0f400-0000-7000-8000-000000000001', name: 'T3 thread', originator: 't3code_desktop', source: 'vscode', cwd: '/work/app', updatedAt: 1790809000 }
    ],
    turns: new Map([[THREAD, [{ id: 'turn-1', status: 'completed', startedAt: 1790806570, items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Please update' }] }] }]]]),
    limits: null, executables: [], writer: null, listComplete: true
  };
  const createReader = ({ executable }) => {
    state.executables.push(executable);
    return {
      listThreads: async ({ archived = false } = {}) => state.threads.filter((item) => Boolean(item.archived) === archived).slice(0, 100),
      listAllThreads: async ({ archived = false } = {}) => ({ threads: state.threads.filter((item) => Boolean(item.archived) === archived), complete: state.listComplete }),
      readThread: async (id) => { const found = state.threads.find((item) => item.id === id); if (!found) throw Object.assign(new Error('missing'), { code: 'conversation_not_found' }); return found; },
      recentTurns: async (id) => state.turns.get(id) || [],
      rateLimits: async () => state.limits,
      turnOutcome: (turn, limit) => ({ state: turn.status === 'inProgress' ? 'running' : turn.status, turnId: turn.id, limit }),
      threadWriter: async () => state.writer
    };
  };
  return { state, createReader };
}

function setup({ writer = null } = {}) {
  let clock = START;
  const reader = fakeReader();
  reader.state.writer = writer;
  const fake = createFakeDesktopAutomation({
    bundleId: BUNDLE_ID,
    view: { title: 'Rename repo', composerLabel: 'Do anything', sendLabel: 'Send' },
    navigate: (url) => (url === `codex://threads/${THREAD}` ? { title: 'Update live Ko-fi account' } : null),
    onSend: (text) => reader.state.turns.get(THREAD).push({ id: 'turn-2', status: 'inProgress', startedAt: Math.floor(clock / 1000), items: [{ type: 'userMessage', content: [{ type: 'text', text }] }] })
  });
  const adapter = createCodexDesktopHarness({ createReader: reader.createReader, automation: fake.automation, isLocked: async () => false,
    platform: 'darwin', now: () => clock, sleep: async (ms) => { clock += ms; }, timings: { navigateMs: 3000, confirmMs: 3000, pollMs: 250 }, codexPath: () => '/Applications/ChatGPT.app/Contents/Resources/codex' });
  return { adapter, fake, reader, now: () => clock };
}
const turn = (overrides = {}) => ({ jobId: 'job', harness: 'codex-desktop', conversationId: THREAD, message: 'Continue', messageId: 'm-1', commandId: 'c-1', deliveryKey: 'm-1', createdAt: null, dispatchAttemptedAt: new Date(START).toISOString(), turnId: null, ...overrides });

test('lists desktop threads newest first using the app-bundled codex binary', async () => {
  const { adapter, reader } = setup();
  assert.deepEqual((await adapter.listConversations({})).map((item) => item.title), ['Update live Ko-fi account', 'Rename repo']);
  assert.deepEqual(reader.state.executables, ['/Applications/ChatGPT.app/Contents/Resources/codex']);
  assert.equal(adapter.capabilities.requiresUnlockedScreen, true);
  assert.equal(adapter.capabilities.requiresAccessibilityPermission, true);
});

test('threads from other harnesses are refused and named', async () => {
  const { adapter } = setup();
  await assert.rejects(adapter.inspectConversation({ conversationId: '01a0f499-e435-7682-aec4-b694f2bcc9aa' }), (error) => error.code === 'owned_by_other_harness' && error.details.harness === 'codex');
  await assert.rejects(adapter.inspectConversation({ conversationId: '01a0f400-0000-7000-8000-000000000001' }), (error) => error.code === 'owned_by_other_harness' && error.details.harness === 't3');
});

test('a thread from another Codex app is not sent to the Codex harness either', async () => {
  const { adapter, reader } = setup();
  const id = '01a0f400-0000-7000-8000-000000000009';
  reader.state.threads.push({ id, name: 'IDE thread', originator: 'codex_vscode', source: 'vscode', cwd: '/work/app', updatedAt: 1 });
  await assert.rejects(adapter.inspectConversation({ conversationId: id }), (error) => error.code === 'owned_by_other_harness' && error.details.harness === 'other' && !/Codex harness/.test(error.message));
});

test('inspect reports activity and an in-progress turn as busy', async () => {
  const { adapter, reader } = setup();
  let state = await adapter.inspectConversation({ conversationId: THREAD, deliveryKey: null });
  assert.equal(state.latestUserActivityAt, new Date(1790806570 * 1000).toISOString());
  assert.equal(state.busy, false);
  reader.state.turns.get(THREAD).push({ id: 'turn-x', status: 'inProgress', startedAt: 1790806600, items: [] });
  state = await adapter.inspectConversation({ conversationId: THREAD });
  assert.equal(state.busy, true);
});

test('prepareTurn refuses busy, unnamed, ambiguous and foreign-writer threads', async () => {
  const { adapter, reader } = setup();
  const state = await adapter.inspectConversation({ conversationId: THREAD });
  await assert.rejects(adapter.prepareTurn(turn(), { ...state, busy: true }), (error) => error.code === 'conversation_busy');
  await assert.rejects(adapter.prepareTurn(turn(), { ...state, context: { name: '' } }), (error) => error.code === 'unsupported_response_shape');
  reader.state.threads.push({ ...reader.state.threads[0], id: '01a0f463-0000-7000-8000-000000000002' });
  await assert.rejects(adapter.prepareTurn(turn(), state), /same name/);
  reader.state.threads.pop();
  const foreign = setup({ writer: { pid: 99, owner: 'codex' } });
  await assert.rejects(foreign.adapter.prepareTurn(turn(), state), /Another Codex process/);
  const unknown = setup({ writer: undefined });
  unknown.reader.state.writer = undefined;
  await assert.rejects(unknown.adapter.prepareTurn(turn(), state), /Another Codex process/, 'An undeterminable lock holder counts as busy');
  const held = setup({ writer: { pid: 99, owner: 'codex-desktop' } });
  assert.deepEqual(await held.adapter.prepareTurn(turn(), state), { deliveryKey: 'm-1', plan: { threadId: THREAD, name: 'Update live Ko-fi account' } });
});

test('submitTurn opens the thread by deep link, verifies it by title and confirms from its turns', async () => {
  const { adapter, fake } = setup();
  const result = await adapter.submitTurn(turn(), { threadId: THREAD, name: 'Update live Ko-fi account' });
  assert.deepEqual(result, { turnId: 'turn-2' });
  assert.deepEqual(fake.state.opened, [`codex://threads/${THREAD}`]);
  assert.equal(fake.state.sent[0].view.title, 'Update live Ko-fi account');
  assert.equal((await adapter.findDelivery(turn())).delivered, true);
  assert.equal((await adapter.findDelivery(turn({ message: 'Something else' }))).delivered, false);
});

test('a thread that is busy when the app shows it is left alone', async () => {
  const { adapter, fake, reader } = setup();
  reader.state.turns.get(THREAD).push({ id: 'turn-x', status: 'inProgress', startedAt: 1790806600, items: [] });
  await assert.rejects(adapter.submitTurn(turn(), { threadId: THREAD, name: 'Update live Ko-fi account' }), (error) => error.code === 'conversation_busy' && error.deliveryUncertain === false);
  assert.equal(fake.state.sent.length, 0);
});

test('checkTurn and availability use the Codex protocol results', async () => {
  const { adapter, reader, now } = setup();
  await adapter.submitTurn(turn(), { threadId: THREAD, name: 'Update live Ko-fi account' });
  assert.deepEqual(await adapter.checkTurn(turn({ turnId: 'turn-2' })), { state: 'running', turnId: 'turn-2', limit: null });
  assert.deepEqual(await adapter.checkTurn(turn({ turnId: 'missing' })), { state: 'unknown' });
  assert.equal((await adapter.probeAvailability()).state, 'unknown');
  const resetsAt = new Date(now() + 3_600_000).toISOString();
  reader.state.limits = { reached: true, resetsAt, usedPercent: 100 };
  const available = await adapter.probeAvailability();
  assert.deepEqual([available.state, available.resetsAt, available.source], ['limited', resetsAt, 'reported']);
});

test('a ChatGPT update that renames the send button is reported with its version, and the text is removed', async () => {
  const { adapter, fake } = setup();
  fake.state.version = '27.1.0';
  fake.state.view.sendLabel = 'Submit';
  await assert.rejects(adapter.submitTurn(turn(), { threadId: THREAD, name: 'Update live Ko-fi account' }), (error) => {
    assert.equal(error.code, 'app_version_unsupported');
    assert.equal(error.deliveryUncertain, false);
    assert.deepEqual([error.details.app, error.details.appVersion, error.details.verifiedVersion, error.details.contactPoint], ['ChatGPT (Codex)', '27.1.0', '26.915.31945', 'send_label']);
    assert.match(error.message, /^ChatGPT \(Codex\) 27\.1\.0 changed how its send button is labelled/);
    return true;
  });
  assert.equal(fake.state.sent.length, 0);
  assert.equal(fake.state.view.composer, '');
});

test('the bundled codex binary is found inside the app wherever Launch Services says it is installed', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'Tools', 'ChatGPT.app');
  fs.mkdirSync(path.join(bundle, 'Contents', 'Resources'), { recursive: true });
  const reader = fakeReader();
  const fake = createFakeDesktopAutomation({ bundleId: BUNDLE_ID });
  fake.state.installedPath = bundle;
  fake.state.version = '27.0';
  const adapter = createCodexDesktopHarness({ createReader: reader.createReader, automation: fake.automation, platform: 'darwin', home: root });
  // An update that moves or drops the bundled binary is an app change, not a missing app.
  await assert.rejects(adapter.listConversations({}), (error) => error.code === 'app_version_unsupported' && error.details.contactPoint === 'app_path' && /^ChatGPT \(Codex\) 27\.0 changed where it keeps/.test(error.message));
  fs.writeFileSync(path.join(bundle, 'Contents', 'Resources', 'codex'), '');
  await adapter.listConversations({});
  assert.deepEqual(reader.state.executables, [path.join(bundle, 'Contents', 'Resources', 'codex')]);
});

test('without the app the harness reports it as not installed', async () => {
  const reader = fakeReader();
  const adapter = createCodexDesktopHarness({ createReader: reader.createReader, platform: 'darwin', codexPath: () => null });
  await assert.rejects(adapter.listConversations({}), (error) => error.code === 'harness_not_installed');
});

test('a turn without a start time is never delivery evidence, even with the same text', async () => {
  const { adapter, reader } = setup();
  // The protocol allows startedAt to be null, for example for turns rebuilt from older rollouts.
  reader.state.turns.get(THREAD).push({ id: 'turn-old', status: 'completed', startedAt: null, items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Continue' }] }] });
  assert.equal((await adapter.findDelivery(turn())).delivered, false, 'An undated earlier "Continue" is not this delivery');
  assert.equal((await adapter.inspectConversation(turn())).delivered, false);
  assert.equal((await adapter.findDelivery(turn({ dispatchAttemptedAt: 'not a time' }))).delivered, false, 'Without a valid send time nothing can be confirmed');
});

test('an undated earlier turn with the same text does not make an unproven send look delivered', async () => {
  const { adapter, fake, reader } = setup();
  reader.state.turns.get(THREAD).push({ id: 'turn-old', status: 'completed', startedAt: null, items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Continue' }] }] });
  // The press is reported, but the app never records the message.
  fake.state.faults.submit = () => ({ ok: true, pressed: true });
  await assert.rejects(adapter.submitTurn(turn(), { threadId: THREAD, name: 'Update live Ko-fi account' }), (error) => error.code === 'timeout' && error.deliveryUncertain === true);
});

test('the title must be unique across every thread the app could show, not only unarchived desktop ones', async () => {
  const { adapter, reader } = setup();
  const state = await adapter.inspectConversation({ conversationId: THREAD });
  const name = 'Update live Ko-fi account';
  for (const twin of [
    { id: '01a0f499-0000-7000-8000-000000000003', name, originator: 'codex_cli_rs', source: 'cli', cwd: '/work/app', updatedAt: 1790806000 },
    { id: '01a0f499-0000-7000-8000-000000000006', name, originator: 'codex_exec', source: 'exec', cwd: '/work/app', updatedAt: 1790806000 },
    { id: '01a0f499-0000-7000-8000-000000000004', name, originator: 'Codex Desktop', source: 'vscode', cwd: '/work/app', updatedAt: 1790806000, archived: true }
  ]) {
    reader.state.threads.push(twin);
    await assert.rejects(adapter.prepareTurn(turn(), state), /same name/, `${twin.source}${twin.archived ? ' archived' : ''} twin`);
    reader.state.threads.pop();
  }
  assert.equal((await adapter.prepareTurn(turn(), state)).plan.name, name);
});

test('a twin older than the most recent 100 threads is still found, and a listing that cannot be finished refuses', async () => {
  const { adapter, reader } = setup();
  const state = await adapter.inspectConversation({ conversationId: THREAD });
  const filler = Array.from({ length: 120 }, (_, index) => ({ id: `01a0f499-0000-7000-8000-${String(index).padStart(12, '0')}`, name: `Other ${index}`, originator: 'Codex Desktop', source: 'vscode', cwd: '/work/app', updatedAt: 1790809000 }));
  reader.state.threads.unshift(...filler);
  reader.state.threads.push({ id: '01a0f499-1111-7000-8000-000000000005', name: 'Update live Ko-fi account', originator: 'codex_cli_rs', source: 'cli', cwd: '/work/app', updatedAt: 1 });
  await assert.rejects(adapter.prepareTurn(turn(), state), /same name/, 'The twin is the 123rd thread');
  reader.state.threads.pop();
  assert.equal((await adapter.prepareTurn(turn(), state)).plan.threadId, THREAD);
  reader.state.listComplete = false;
  await assert.rejects(adapter.prepareTurn(turn(), state), (error) => error.code === 'conversation_busy' && /could not all be checked/.test(error.message));
});

test('reads open read-only app-server connections that leave approval prompts to the app', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-desktop-readonly-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, 'codex');
  const log = path.join(root, 'answers.jsonl');
  // An app-server that asks for approval on the very thread being read, and logs any answer.
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
const thread = { id: '${THREAD}', name: 'Update live Ko-fi account', originator: 'Codex Desktop', source: 'vscode', cwd: '/work/app' };
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') return send({ id: message.id, result: {} });
  if (message.method === 'initialized') return send({ id: 9001, method: 'item/commandExecution/requestApproval', params: { threadId: thread.id, turnId: 't', itemId: 'i', startedAtMs: 0, command: 'git push' } });
  if (message.id === 9001 && message.method === undefined) return fs.appendFileSync(process.env.FAKE_LOG, line + '\\n');
  if (message.method === 'thread/read') return send({ id: message.id, result: { thread } });
  if (message.method === 'thread/turns/list') return send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === 'account/rateLimits/read') return send({ id: message.id, result: { rateLimits: null } });
});
`);
  fs.chmodSync(executable, 0o755);
  const adapter = createCodexDesktopHarness({ env: { PATH: path.dirname(process.execPath), FAKE_LOG: log }, home: root, platform: 'darwin', isLocked: async () => false, codexPath: () => executable });
  const state = await adapter.inspectConversation({ conversationId: THREAD });
  assert.equal(state.busy, false);
  assert.equal((await adapter.probeAvailability()).state, 'unknown');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(fs.existsSync(log), false, 'The approval prompt was left for the ChatGPT app');
});
