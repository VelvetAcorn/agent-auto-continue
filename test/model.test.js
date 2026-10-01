'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  arrangeAgents,
  buildTurnStartCommand,
  hasMessageId,
  normaliseConfig,
  validateAgentsInput,
  validateLayoutInput,
  readJobs,
  validateSettingsInput,
  validateScheduleInput
} = require('../lib/model');

test('buildTurnStartCommand includes the required type, attachments, and thread settings', () => {
  const job = { commandId: 'command', threadId: 'thread', messageId: 'message', message: 'Continue' };
  const command = buildTurnStartCommand(job, { modelSelection: { model: 'test', instanceId: 'provider' }, runtimeMode: 'full-access', interactionMode: 'default' });
  assert.deepEqual({ type: command.type, message: command.message, modelSelection: command.modelSelection, runtimeMode: command.runtimeMode, interactionMode: command.interactionMode }, {
    type: 'thread.turn.start',
    message: { messageId: 'message', role: 'user', text: 'Continue', attachments: [] },
    modelSelection: { model: 'test', instanceId: 'provider' },
    runtimeMode: 'full-access', interactionMode: 'default'
  });
});

test('normaliseConfig applies safe defaults to malformed values', () => {
  assert.deepEqual(normaliseConfig({ httpPort: 0, bufferSeconds: -1, t3Token: ' token ' }), {
    httpPort: 3773,
    bufferSeconds: 5,
    t3Token: 'token',
    keepAwake: { enabled: false, keepDisplayOn: false, powerSource: 'any', batteryFloorPercent: 20, maxHours: 12, includeRunningAgents: false },
    agents: { order: [], hidden: [] },
    layout: 'rail'
  });
});

test('normaliseConfig keeps a valid agent arrangement and layout and repairs invalid ones', () => {
  const saved = normaliseConfig({ agents: { order: ['codex', 't3', 'codex', 'Bad Id', 7], hidden: ['claude-desktop'] }, layout: 'window' });
  assert.deepEqual(saved.agents, { order: ['codex', 't3'], hidden: ['claude-desktop'] });
  assert.equal(saved.layout, 'window');
  assert.deepEqual(normaliseConfig({ agents: 'all', layout: 'popover' }).agents, { order: [], hidden: [] });
  assert.equal(normaliseConfig({ layout: 'popover' }).layout, 'rail');
});

test('validateAgentsInput keeps only known agents and arrangeAgents never loses a harness', () => {
  const known = ['t3', 'opencode', 'claude-code'];
  assert.deepEqual(validateAgentsInput({ order: ['claude-code', 'nope', 't3'], hidden: ['opencode', 'nope'] }, known), { order: ['claude-code', 't3'], hidden: ['opencode'] });
  assert.throws(() => validateAgentsInput({ order: 'claude-code', hidden: [] }, known), /arrangement/);
  assert.throws(() => validateAgentsInput(null, known), /arrangement/);
  assert.deepEqual(arrangeAgents(known, { order: ['claude-code'], hidden: ['opencode'] }), [
    { id: 'claude-code', hidden: false }, { id: 't3', hidden: false }, { id: 'opencode', hidden: true }
  ]);
  assert.deepEqual(arrangeAgents(known, { order: ['gone'], hidden: [] }).map((item) => item.id), known);
  assert.equal(validateLayoutInput('window'), 'window');
  assert.throws(() => validateLayoutInput('sheet'), /rail or the window/);
});

test('normaliseConfig keeps valid keep-awake preferences and repairs invalid ones', () => {
  const saved = { enabled: true, keepDisplayOn: true, powerSource: 'ac-only', batteryFloorPercent: 0, maxHours: 72, includeRunningAgents: true };
  assert.deepEqual(normaliseConfig({ keepAwake: saved }).keepAwake, saved);
  assert.deepEqual(normaliseConfig({ keepAwake: { enabled: 'yes', powerSource: 'solar', batteryFloorPercent: 99, maxHours: 0.5 } }).keepAwake,
    { enabled: false, keepDisplayOn: false, powerSource: 'any', batteryFloorPercent: 20, maxHours: 12, includeRunningAgents: false });
});

test('validateScheduleInput accepts a future job and rejects expired jobs', () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.equal(validateScheduleInput({ threadId: 'thr_1', message: ' Continue ', whenISO: future }).message, 'Continue');
  assert.throws(() => validateScheduleInput({ threadId: 'thr_1', message: 'Continue', whenISO: '2000-01-01T00:00:00.000Z' }));
});

test('validateSettingsInput rejects unsafe port and buffer values', () => {
  assert.deepEqual(validateSettingsInput({ httpPort: 3773, bufferSeconds: 5, t3Token: ' token ' }), { httpPort: 3773, bufferSeconds: 5, t3Token: 'token' });
  assert.throws(() => validateSettingsInput({ httpPort: 0, bufferSeconds: 5 }));
  assert.throws(() => validateSettingsInput({ httpPort: 3773, bufferSeconds: 301 }));
});

test('readJobs removes malformed persisted entries', () => {
  const valid = {
    id: 'a', commandId: 'b', messageId: 'c', threadId: 'd', message: 'Continue',
    scheduleAt: '2030-01-01T00:00:00.000Z', status: 'pending'
  };
  assert.deepEqual(readJobs([valid, { id: 'broken' }]), [valid]);
});

test('hasMessageId finds nested messages and tolerates cycles', () => {
  const snapshot = { turns: [{ message: { messageId: 'msg_1' } }] };
  snapshot.self = snapshot;
  assert.equal(hasMessageId(snapshot, 'msg_1'), true);
  assert.equal(hasMessageId(snapshot, 'msg_2'), false);
});

test('findLatestUserTurnAt reads the latest user message from a thread detail', () => {
  const { findLatestUserTurnAt } = require('../lib/model');
  const date = findLatestUserTurnAt({ messages: [
    { role: 'assistant', createdAt: '2030-01-01T00:02:00.000Z' },
    { role: 'user', createdAt: '2030-01-01T00:01:00.000Z' },
    { role: 'user', createdAt: '2030-01-01T00:03:00.000Z' }
  ] });
  assert.equal(date.toISOString(), '2030-01-01T00:03:00.000Z');
});

test('schedule input rejects ambiguous local timestamps and nonexistent calendar dates', () => {
  for (const whenISO of ['2099-02-30T12:00:00Z', '2099-02-29T12:00:00Z', '2099-01-01T12:00', '2099-01-01', '2099-13-01T12:00:00Z']) {
    assert.throws(() => validateScheduleInput({ threadId: 'thread', message: 'Continue', whenISO }));
  }
  assert.equal(validateScheduleInput({ threadId: 'thread', message: 'Continue', whenISO: '2099-01-01T12:00:00+05:30' }).whenISO, '2099-01-01T06:30:00.000Z');
});
