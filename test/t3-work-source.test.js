'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createT3WorkSource, threadIsWorking } = require('../lib/t3-work-source');

const MINUTE = 60_000;
const START = Date.parse('2026-10-01T00:00:00Z');

function job(overrides = {}) {
  return { id: 'job', commandId: 'command', messageId: 'message', threadId: 'thread', threadTitle: 'Refactor parser', message: 'Continue',
    scheduleAt: '2026-10-01T01:00:00.000Z', bufferSeconds: 5, status: 'pending', deliveryCertainty: 'not-delivered', updatedAt: '2026-10-01T00:00:00.000Z', ...overrides };
}
const session = (status, activeTurnId = null) => ({ threadId: 'thread', status, activeTurnId, providerName: null, lastError: null, updatedAt: '2026-10-01T00:00:00.000Z' });
const thread = (overrides = {}) => ({ id: 'thread', title: 'Refactor parser', archivedAt: null, session: session('idle'), ...overrides });

function harness({ jobs = [], threads = [thread()], includeRunningAgents = false, fail = false } = {}) {
  let time = START;
  const calls = [];
  const api = { fetchSnapshot: async () => { calls.push(time); if (state.fail) throw new Error('connection refused'); return { threads: state.threads }; } };
  const state = { threads, fail };
  const service = { jobs };
  const source = createT3WorkSource({ service, api, now: () => time, getOptions: () => ({ includeRunningAgents, horizonMs: 12 * 60 * MINUTE }) });
  return { source, service, state, calls, advance(ms) { time += ms; }, get time() { return time; } };
}

test('threadIsWorking follows the T3 Code session status and active turn', () => {
  assert.equal(threadIsWorking(thread({ session: session('running') })), true);
  assert.equal(threadIsWorking(thread({ session: session('starting') })), true);
  assert.equal(threadIsWorking(thread({ session: session('ready', 'turn-1') })), true);
  for (const status of ['idle', 'ready', 'interrupted', 'stopped', 'error']) assert.equal(threadIsWorking(thread({ session: session(status) })), false);
  assert.equal(threadIsWorking(thread({ session: null, latestTurn: { state: 'running' } })), false, 'Stale latest-turn state alone must not keep the Mac awake');
  assert.equal(threadIsWorking(undefined), false);
});

test('pending and dispatching jobs are tracked as waiting and running', async () => {
  const h = harness({ jobs: [job(), job({ id: 'sending', status: 'dispatching' }), job({ id: 'old', status: 'canceled' })] });
  assert.deepEqual(h.source.tasks().map((task) => [task.id, task.state, task.until, task.harness]), [
    ['job:job', 'waiting', '2026-10-01T01:00:05.000Z', 't3'],
    ['job:sending', 'running', null, 't3']
  ]);
  await h.source.refresh();
  assert.equal(h.calls.length, 1, 'A delivery in flight needs session data');
});

test('no snapshot is requested when nothing needs session data', async () => {
  const h = harness({ jobs: [job()] });
  await h.source.refresh();
  assert.equal(h.calls.length, 0);
});

test('a delivered message is tracked while its agent turn runs and released once idle', async () => {
  const h = harness({ jobs: [job({ status: 'sent', deliveryCertainty: 'delivered', dispatchedAt: '2026-10-01T00:00:00.000Z' })] });
  assert.equal(h.source.tasks()[0].detail, 'Waiting for the agent to start');
  h.state.threads = [thread({ session: session('running', 'turn-1') })];
  h.advance(MINUTE);
  await h.source.refresh();
  assert.deepEqual(h.source.tasks().map((task) => [task.state, task.detail]), [['running', 'Agent is working on your message']]);
  h.advance(60 * MINUTE);
  await h.source.refresh();
  assert.equal(h.source.tasks()[0].state, 'running', 'Long turns stay tracked while running');
  h.state.threads = [thread()];
  h.advance(MINUTE);
  await h.source.refresh();
  assert.deepEqual(h.source.tasks(), []);
  h.state.threads = [thread({ session: session('running') })];
  h.advance(MINUTE);
  await h.source.refresh();
  assert.deepEqual(h.source.tasks(), [], 'A finished turn stays closed even if the user starts more work in the thread');
});

test('an idle thread right after delivery is still given time to start', async () => {
  const h = harness({ jobs: [job({ status: 'sent', deliveryCertainty: 'delivered', dispatchedAt: '2026-10-01T00:00:00.000Z' })] });
  h.advance(30_000);
  await h.source.refresh();
  assert.equal(h.source.tasks()[0].detail, 'Waiting for the agent to start');
  h.advance(3 * MINUTE);
  await h.source.refresh();
  assert.deepEqual(h.source.tasks(), []);
});

test('when T3 Code stops responding, completion is unknown for a bounded window', async () => {
  const h = harness({ jobs: [job({ status: 'sent', deliveryCertainty: 'delivered', dispatchedAt: '2026-10-01T00:00:00.000Z' })], threads: [thread({ session: session('running') })] });
  h.advance(MINUTE);
  await h.source.refresh();
  h.state.fail = true;
  h.advance(10 * MINUTE);
  await h.source.refresh();
  const [task] = h.source.tasks();
  assert.equal(task.state, 'unknown');
  assert.equal(task.until, '2026-10-01T00:31:00.000Z', 'The window starts when the agent was last seen working');
  h.advance(21 * MINUTE);
  assert.deepEqual(h.source.tasks(), []);
});

test('unconfirmed deliveries are watched without ever being resent, and failures before sending are ignored', async () => {
  const unconfirmed = job({ id: 'maybe', status: 'unconfirmed', deliveryCertainty: 'unknown', dispatchAttemptedAt: '2026-10-01T00:00:00.000Z' });
  const neverSent = job({ id: 'never', status: 'failed', deliveryCertainty: 'not-delivered' });
  const h = harness({ jobs: [unconfirmed, neverSent], threads: [thread({ session: session('running') })] });
  h.advance(4 * MINUTE);
  await h.source.refresh();
  assert.deepEqual(h.source.tasks().map((task) => [task.id, task.detail]), [['job:maybe', 'Delivery unconfirmed, but the agent is working']]);
});

test('deliveries without a recorded dispatch attempt are not watched', () => {
  const h = harness({ jobs: [job({ status: 'sent', deliveryCertainty: 'delivered', confirmedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' })] });
  assert.deepEqual(h.source.tasks(), []);
});

test('deliveries older than the session horizon are ignored after a restart', () => {
  const h = harness({ jobs: [job({ status: 'sent', deliveryCertainty: 'delivered', dispatchedAt: '2026-09-30T11:00:00.000Z' })] });
  assert.deepEqual(h.source.tasks(), []);
});

test('running agent turns without a schedule are tracked only when opted in', async () => {
  const threads = [thread({ id: 'a', title: 'Alpha', session: session('running') }), thread({ id: 'b', title: 'Archived', archivedAt: '2026-09-01T00:00:00Z', session: session('running') }), thread({ id: 'c', title: 'Idle' })];
  const off = harness({ threads });
  await off.source.refresh();
  assert.deepEqual(off.source.tasks(), []);
  const on = harness({ threads, includeRunningAgents: true, jobs: [job({ threadId: 'a' })] });
  await on.source.refresh();
  assert.deepEqual(on.source.tasks().map((task) => task.id), ['job:job', 't3:thread:a']);
  assert.equal(on.source.tasks()[1].supplementary, true);
  assert.equal(on.source.tasks()[1].conversation, 't3:a');
  on.service.jobs.length = 0;
  assert.deepEqual(on.source.tasks().map((task) => [task.id, task.label, task.state]), [['t3:thread:a', 'Alpha', 'running']]);
  on.state.fail = true;
  on.advance(5 * MINUTE);
  await on.source.refresh();
  assert.deepEqual(on.source.tasks().map((task) => [task.id, task.state]), [['t3:thread:a', 'unknown']]);
  on.advance(30 * MINUTE);
  assert.deepEqual(on.source.tasks(), []);
});

test('refresh notifies subscribers so the controller can re-evaluate', async () => {
  const h = harness({ includeRunningAgents: true });
  let calls = 0;
  const unsubscribe = h.source.subscribe(() => calls++);
  await h.source.refresh();
  h.source.changed();
  unsubscribe();
  h.source.changed();
  assert.equal(calls, 2);
});

test('a distant pending schedule preserves running and unknown supplementary coverage', async () => {
  const h = harness({ includeRunningAgents: true, jobs: [job({ scheduleAt: '2026-10-03T00:00:00.000Z' })],
    threads: [thread({ session: session('running') })] });
  await h.source.refresh();
  assert.deepEqual(h.source.tasks().map(({ id, state, conversation, supplementary }) => ({ id, state, conversation, supplementary })), [
    { id: 'job:job', state: 'waiting', conversation: 't3:thread', supplementary: undefined },
    { id: 't3:thread:thread', state: 'running', conversation: 't3:thread', supplementary: true }
  ]);
  h.state.fail = true;
  h.advance(5 * MINUTE);
  await h.source.refresh();
  assert.equal(h.source.tasks()[1].state, 'unknown');
  assert.equal(h.source.tasks()[1].supplementary, true);
});
