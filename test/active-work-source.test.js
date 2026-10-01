'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createActiveWorkSource } = require('../lib/active-work-source');
const { createT3WorkSource } = require('../lib/t3-work-source');
const { WorkSourceRegistry } = require('../lib/keep-awake');

// The exact item shape documented for service.activeWork() in the harness contract (issue #2).
const activeWork = [
  { jobId: 'a', harness: 't3', conversationId: 'thread-a', phase: 'scheduled', effectiveAt: '2026-10-01T01:00:05.000Z', requiresUnlockedScreen: false },
  { jobId: 'b', harness: 'claude-desktop', conversationId: 'conv-b', phase: 'sending', effectiveAt: '2026-10-01T00:00:05.000Z', requiresUnlockedScreen: true },
  { jobId: 'c', harness: 'codex', conversationId: 'session-c', phase: 'running', effectiveAt: '2026-09-30T23:00:05.000Z', requiresUnlockedScreen: false },
  { jobId: 'd', harness: 'codex', conversationId: 'session-d', phase: 'mystery', effectiveAt: null, requiresUnlockedScreen: false }
];

test('activeWork() items become keep-awake tasks', () => {
  const service = { jobs: [{ id: 'a', threadTitle: 'Night refactor' }], activeWork: () => activeWork };
  const source = createActiveWorkSource({ service });
  assert.deepEqual(source.tasks(), [
    { id: 'job:a', harness: 't3', conversation: 't3:thread-a', label: 'Night refactor', state: 'waiting', detail: 'Scheduled message waiting to send', until: '2026-10-01T01:00:05.000Z', requiresUnlockedScreen: false },
    { id: 'job:b', harness: 'claude-desktop', conversation: 'claude-desktop:conv-b', label: 'conv-b', state: 'running', detail: 'Sending scheduled message', until: null, requiresUnlockedScreen: true },
    { id: 'job:c', harness: 'codex', conversation: 'codex:session-c', label: 'session-c', state: 'running', detail: 'Agent is working on your message', until: null, requiresUnlockedScreen: false }
  ]);
  assert.throws(() => createActiveWorkSource({ service: {} }), /activeWork/);
});

test('change notifications reach subscribers', () => {
  const source = createActiveWorkSource({ service: { activeWork: () => [] } });
  let calls = 0;
  const unsubscribe = source.subscribe(() => calls++);
  source.changed();
  unsubscribe();
  source.changed();
  assert.equal(calls, 1);
});

test('the activeWork() source and the T3 Code source report each job once', () => {
  const jobs = [{ id: 'a', threadId: 'thread-a', threadTitle: 'Night refactor', harness: 't3', status: 'pending', scheduleAt: '2026-10-01T01:00:00.000Z', bufferSeconds: 5 }];
  const service = { jobs, activeWork: () => activeWork.slice(0, 1) };
  const registry = new WorkSourceRegistry();
  registry.register(createActiveWorkSource({ service }));
  registry.register(createT3WorkSource({ service, api: { fetchSnapshot: async () => ({ threads: [] }) } }));
  assert.deepEqual(registry.tasks().tasks.map((task) => [task.id, task.source]), [['job:a', 'active-work']]);
});

test('the T3 Code source ignores jobs that belong to other harnesses', () => {
  const service = { jobs: [{ id: 'x', threadId: 'conv', harness: 'codex', status: 'pending', scheduleAt: '2026-10-01T01:00:00.000Z', bufferSeconds: 5 }] };
  assert.deepEqual(createT3WorkSource({ service, api: {} }).tasks(), []);
});

test('waiting continuations become waiting tasks until their next check, with the cause and progress', () => {
  const jobs = [
    { id: 'w1', threadTitle: 'Limited', availability: { state: 'limited', resetsAt: '2026-10-01T05:00:00.000Z' } },
    { id: 'w2', threadTitle: 'Locked', availability: { state: 'unavailable', reason: 'screen_locked' } },
    { id: 'w3', threadTitle: 'Next turn', waitReason: 'continuation' },
    { id: 'w4', threadTitle: 'First start', waitReason: 'availability' }
  ];
  const work = [
    { jobId: 'w1', harness: 'opencode', conversationId: 'ses-1', phase: 'waiting', effectiveAt: '2026-10-01T01:00:05.000Z', nextCheckAt: '2026-10-01T05:00:05.000Z', requiresUnlockedScreen: false, chain: { state: 'active', limit: 3, unlimited: false, currentTurn: 2 } },
    { jobId: 'w2', harness: 'claude-desktop', conversationId: 'local_1', phase: 'waiting', effectiveAt: '2026-10-01T01:00:05.000Z', nextCheckAt: '2026-10-01T01:01:05.000Z', requiresUnlockedScreen: true, chain: { state: 'active', limit: null, unlimited: true, currentTurn: 4 } },
    { jobId: 'w3', harness: 'codex', conversationId: 'thr', phase: 'scheduled', effectiveAt: '2026-10-01T01:02:05.000Z', nextCheckAt: null, requiresUnlockedScreen: false, chain: { state: 'active', limit: 1, unlimited: false, currentTurn: 1 } },
    { jobId: 'w4', harness: 'claude-code', conversationId: 'sess', phase: 'waiting', effectiveAt: '2026-10-01T01:03:05.000Z', nextCheckAt: null, requiresUnlockedScreen: false, chain: null }
  ];
  const tasks = createActiveWorkSource({ service: { jobs, activeWork: () => work } }).tasks();
  assert.deepEqual(tasks.map((task) => [task.id, task.state, task.detail, task.until, task.requiresUnlockedScreen]), [
    ['job:w1', 'waiting', 'Waiting for the usage limit to reset · turn 2 of 3', '2026-10-01T05:00:05.000Z', false],
    ['job:w2', 'waiting', 'Waiting for the Mac to be unlocked · turn 4, continuous', '2026-10-01T01:01:05.000Z', true],
    ['job:w3', 'waiting', 'Scheduled message waiting to send', '2026-10-01T01:02:05.000Z', false],
    ['job:w4', 'waiting', 'Waiting for the agent to be available', '2026-10-01T01:03:05.000Z', false]
  ]);
});

test('with the real job service, every harness and every active chain is tracked once, and paused or finished work is not', async () => {
  const { JobService } = require('../lib/job-service');
  const { createHarnessRegistry } = require('../lib/harnesses');
  const { createT3Harness } = require('../lib/harnesses/t3');
  const { createFakeHarness } = require('../tools/fake-harness.cjs');
  const desk = createFakeHarness({ id: 'desk', label: 'Desk App', kind: 'desktop-app', capabilities: { requiresUnlockedScreen: true, requiresAccessibilityPermission: true }, conversations: [{ id: 'conv-d', title: 'Desk session' }] });
  desk.state.availability = { state: 'limited', resetsAt: '2099-01-01T00:00:00.000Z', reason: '', source: 'reported' };
  const thread = (id) => ({ id, title: `Thread ${id}`, projectId: 'p', messages: [], session: null });
  const api = { fetchSnapshot: async () => ({ threads: [thread('t-1'), thread('t-2'), thread('t-3')], projects: [] }), fetchThread: async (id) => thread(id) };
  const at = '2026-10-01T08:00:00.000Z';
  const base = { harness: 't3', message: 'Continue', scheduleAt: at, createdAt: at, timeZone: 'UTC', bufferSeconds: 5, trigger: 'time' };
  const chain = (state) => ({ limit: null, state, reasonCode: state === 'paused' ? 'user_activity' : null, reason: '', changedAt: at, previousTurns: 1, history: [] });
  const service = new JobService({
    api, harnesses: createHarnessRegistry([createT3Harness({ api }), desk.adapter]), now: () => Date.parse('2026-10-01T09:00:00.000Z'),
    jobs: { version: 4, jobs: [
      { ...base, id: 't3-paused', commandId: 'c1', messageId: 'm1', threadId: 't-1', status: 'pending', deliveryCertainty: 'not-delivered', chain: chain('paused') },
      { ...base, id: 't3-finished-turn', commandId: 'c2', messageId: 'm2', threadId: 't-2', status: 'sent', deliveryCertainty: 'delivered', dispatchAttemptedAt: '2026-10-01T08:59:00.000Z', dispatchedAt: '2026-10-01T08:59:01.000Z', turn: { state: 'completed', turnId: null, completedAt: '2026-10-01T08:59:30.000Z', error: null, usageLimit: null, updatedAt: '2026-10-01T08:59:30.000Z' } },
      { ...base, id: 't3-running-turn', commandId: 'c3', messageId: 'm3', threadId: 't-3', status: 'sent', deliveryCertainty: 'delivered', dispatchAttemptedAt: '2026-10-01T08:59:00.000Z', dispatchedAt: '2026-10-01T08:59:01.000Z', turn: { state: 'running', turnId: null, completedAt: null, error: null, usageLimit: null, updatedAt: '2026-10-01T08:59:01.000Z' } }
    ] }
  });
  await service.create({ harness: 't3', threadId: 't-1', message: 'Plain', whenISO: '2026-10-01T10:00:00.000Z', timeZone: 'UTC' });
  const waiting = await service.create({ harness: 'desk', threadId: 'conv-d', message: 'Keep going', timeZone: 'UTC', trigger: 'available', continuous: true });
  const registry = new WorkSourceRegistry();
  registry.register(createActiveWorkSource({ service }));
  registry.register(createT3WorkSource({ service, api, now: () => Date.parse('2026-10-01T09:00:00.000Z') }));
  const { tasks } = registry.tasks();
  const plain = service.jobs.find((job) => job.message === 'Plain');
  assert.deepEqual(tasks.map((task) => [task.id, task.source, task.harness, task.state, task.requiresUnlockedScreen]).sort(), [
    [`job:${plain.id}`, 'active-work', 't3', 'waiting', false],
    [`job:${waiting.id}`, 'active-work', 'desk', 'waiting', true],
    ['job:t3-running-turn', 'active-work', 't3', 'running', false]
  ].sort(), 'paused chains and turns the job service saw finish are not tracked, and no job is listed twice');
  assert.equal(tasks.find((task) => task.id === `job:${waiting.id}`).detail, 'Waiting for the agent to be available · turn 1, continuous');
  service.stop(waiting.id);
  assert.equal(registry.tasks().tasks.some((task) => task.id === `job:${waiting.id}`), false, 'a stopped chain releases keep-awake');
  assert.equal(desk.state.submitted.length, 0);
});
