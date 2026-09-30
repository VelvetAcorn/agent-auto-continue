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
