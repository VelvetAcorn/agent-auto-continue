'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const time = require('../renderer/date-time');
const { resolveWhen, farLabel, planSentence, queueMeta, mergeConversations, agentStatus, WHEN } = require('../renderer/compose');

const display = (iso, zone, style) => `${style}:${iso}@${zone}`;
const relative = () => 'In 25 min';
const base = { when: '5', timeZone: 'UTC', date: '2099-10-02', time: '06:30', occurrence: '', waitIfLimited: false, far: 'once', turnLimit: '1' };

test('the when chips cover every start mode and quick chips resolve from the moment Continue is pressed', () => {
  assert.deepEqual(WHEN.map(([value]) => value), ['5', '30', '60', 'tomorrow', 'available', 'custom']);
  const now = Date.parse('2026-10-01T22:40:00Z');
  assert.deepEqual(resolveWhen(base, time, now), { trigger: 'time', whenISO: '2026-10-01T22:45:00.000Z' });
  assert.deepEqual(resolveWhen({ ...base, when: 'tomorrow' }, time, now), { trigger: 'time', whenISO: '2026-10-02T09:00:00.000Z' });
  assert.deepEqual(resolveWhen({ ...base, when: 'custom', waitIfLimited: true }, time, now), { trigger: 'time-then-available', whenISO: '2099-10-02T06:30:00.000Z' });
  assert.deepEqual(resolveWhen({ ...base, when: 'available' }, time, now), { trigger: 'available' });
  assert.throws(() => resolveWhen({ ...base, when: 'custom', date: '2099-02-30' }, time, now), /calendar/);
});

test('the plan sentence says when, whether it waits for a limit, and how far', () => {
  assert.equal(farLabel({ far: 'once' }), 'once');
  assert.equal(farLabel({ far: 'upto', turnLimit: '3' }), 'up to 3 turns');
  assert.equal(farLabel({ far: 'upto', turnLimit: 'x' }), 'up to ? turns');
  assert.equal(farLabel({ far: 'until' }), 'until done');
  assert.equal(farLabel({ far: 'until', stopPhrase: ' TASK COMPLETE ' }), 'until done, or at “TASK COMPLETE”');
  assert.equal(farLabel({ far: 'once', stopPhrase: 'TASK COMPLETE' }), 'once', 'A single turn cannot end on a phrase');
  const now = Date.parse('2026-10-01T22:40:00Z');
  assert.equal(planSentence({ draft: base, label: 'T3 Code', time, display, now }), 'In 5 minutes · once');
  assert.equal(planSentence({ draft: { ...base, when: '60', far: 'until' }, label: 'T3 Code', time, display, now, supportsTurns: false }), 'In 1 hour');
  assert.equal(planSentence({ draft: { ...base, when: 'tomorrow', waitIfLimited: true }, label: 'Claude Code', time, display, now }), 'Tomorrow 09:00, or when free if limited · once');
  assert.equal(planSentence({ draft: { ...base, when: 'available', far: 'upto', turnLimit: '3' }, label: 'Claude Code', availability: { state: 'limited', resetsAt: '2026-10-02T02:00:00Z' }, time, display, now }), 'When Claude Code is free, around time:2026-10-02T02:00:00Z@UTC · up to 3 turns');
  assert.equal(planSentence({ draft: { ...base, when: 'custom' }, label: 'T3 Code', time, display, now }), 'full:2099-10-02T06:30:00.000Z@UTC · once');
  assert.match(planSentence({ draft: { ...base, when: 'custom', date: '2026-03-29', time: '01:30', timeZone: 'Europe/London' }, label: 'T3 Code', time, display, now }), /does not exist/);
  assert.match(planSentence({ draft: { ...base, when: 'custom', date: '2026-10-25', time: '01:30', timeZone: 'Europe/London' }, label: 'T3 Code', time, display, now }), /occurs twice/);
});

test('queued and recent rows get one honest meta line', () => {
  const ctx = { display, relative, localZone: 'UTC' };
  assert.equal(queueMeta({ displayStatus: 'pending', effectiveAt: 'x', timeZone: 'UTC' }, ctx), 'In 25 min · once');
  assert.equal(queueMeta({ displayStatus: 'pending', effectiveAt: 'x', automation: { limit: 3, unlimited: false, currentTurn: 1, progressLabel: 'Turn 1 of 3' } }, ctx), 'In 25 min · up to 3 turns');
  assert.equal(queueMeta({ displayStatus: 'running', dispatchedAt: 'd', automation: { limit: 4, unlimited: false, currentTurn: 3, progressLabel: 'Turn 3 of 4' } }, ctx), 'Running turn 3 of 4 · sent time:d@UTC');
  assert.equal(queueMeta({ displayStatus: 'waiting', deliveryLabel: 'Waiting for availability', automation: { unlimited: true, progressLabel: 'Turn 1 · continuous' } }, ctx), 'Waiting for availability · turn 1 · continuous');
  assert.equal(queueMeta({ displayStatus: 'dispatching' }, ctx), 'Sending…');
  assert.equal(queueMeta({ displayStatus: 'sent', updatedAt: 'u' }, ctx), 'Done short:u@UTC');
  assert.equal(queueMeta({ displayStatus: 'finished', updatedAt: 'u', automation: { sentTurns: 4 } }, ctx), 'Done short:u@UTC · 4 turns');
  assert.equal(queueMeta({ displayStatus: 'paused', updatedAt: 'u', automation: { reason: 'The agent asked a question.' } }, ctx), 'Paused short:u@UTC · The agent asked a question.');
  assert.equal(queueMeta({ displayStatus: 'failed', updatedAt: 'u', error: { message: 'OpenCode was not running' } }, ctx), 'Failed short:u@UTC · OpenCode was not running');
  assert.equal(queueMeta({ displayStatus: 'failed', updatedAt: 'u', error: { message: 'OpenCode was not running' } }, { ...ctx, labelled: false }), 'short:u@UTC · OpenCode was not running');
});

test('conversations from every visible agent merge newest first and filter by text and settled state', () => {
  const sources = [
    { harness: 't3', label: 'T3 Code', threads: [{ id: 'a', title: 'Older', updatedAt: '2026-10-01T10:00:00Z', settled: null }, { id: 's', title: 'Settled', updatedAt: '2026-10-01T12:00:00Z', settled: true }] },
    { harness: 'claude-code', label: 'Claude Code', threads: [{ id: 'b', title: 'Newer', projectName: 'quilla', updatedAt: '2026-10-01T11:00:00Z' }] },
    { harness: 'opencode', label: 'OpenCode', threads: [] }
  ];
  assert.deepEqual(mergeConversations(sources).map((row) => [row.harness, row.id]), [['claude-code', 'b'], ['t3', 'a']]);
  assert.deepEqual(mergeConversations(sources, { showSettled: true }).map((row) => row.id), ['s', 'b', 'a']);
  assert.deepEqual(mergeConversations(sources, { query: 'QUIL' }).map((row) => row.id), ['b']);
  assert.equal(mergeConversations(sources)[0].harnessLabel, 'Claude Code');
});

test('agent status reads permission, reachability, compatibility and usage limits in that order', () => {
  const info = { id: 'claude-desktop', label: 'Claude Desktop', kind: 'desktop-app' };
  assert.deepEqual(agentStatus({ info, hidden: true }), { tone: 'off', text: 'Hidden from the picker and the header' });
  assert.deepEqual(agentStatus({ info, online: false, connectionError: { code: 'permission_required', message: 'x' } }), { tone: 'off', text: 'Needs Accessibility permission', action: 'permission' });
  assert.deepEqual(agentStatus({ info, online: false, connectionError: { code: 'app_not_running', message: 'Claude Desktop is not open.' } }), { tone: 'off', text: 'Claude Desktop is not open.' });
  assert.deepEqual(agentStatus({ info, online: false, connectionError: { code: 'weird' } }), { tone: 'off', text: 'Claude Desktop is not reachable' });
  assert.deepEqual(agentStatus({ info, online: true, compatibility: { checkedAt: 'c', ok: false, label: 'Claude Desktop', appVersion: '2.17.0' } }), { tone: 'limited', text: 'Claude Desktop 2.17.0 is not supported yet' });
  assert.deepEqual(agentStatus({ info: { id: 'claude-code', label: 'Claude Code', kind: 'cli' }, online: true, availability: { state: 'limited', resetsAt: 'r', resetsAtLabel: '03:00' } }), { tone: 'limited', text: 'Limited until 03:00' });
  assert.deepEqual(agentStatus({ info, online: true }), { tone: 'ok', text: 'Claude Desktop is open' });
  assert.deepEqual(agentStatus({ info: { id: 't3', label: 'T3 Code', kind: 'api' }, online: true }), { tone: 'ok', text: 'Connected' });
  assert.deepEqual(agentStatus({ info }), { tone: 'unknown', text: 'Checking…' });
});
