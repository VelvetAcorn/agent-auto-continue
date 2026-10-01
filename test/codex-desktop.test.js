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
