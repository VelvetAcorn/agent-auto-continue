'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JobService, migrateJobs } = require('../lib/job-service');
const { ApiError } = require('../lib/api-client');
const start = Date.now() + 60_000;
const iso = n => new Date(start + n).toISOString();
const thread = () => ({ id: 'thread', title: 'Fix scheduler', projectId: 'project', messages: [], modelSelection: { model: 'test', instanceId: 'provider' }, runtimeMode: 'full-access', interactionMode: 'default' });
const input = (n = 60_000) => ({ threadId: 'thread', message: 'Continue', whenISO: iso(n), timeZone: 'Europe/London' });
function harness(jobs = [], overrides = {}) {
  let clock = start, stored, calls = 0;
  const timers = [], notifications = [];
  let current = thread();
  const api = { fetchThread: async () => current, dispatch: async () => { calls++; return { sequence: 1 }; }, ...overrides };
  const service = new JobService({ jobs, api, now: () => clock, persist: value => { stored = JSON.parse(JSON.stringify(value)); }, notify: (...args) => notifications.push(args), scheduleTimer: (date, callback) => { const timer = { date, callback, canceled: false, cancel() { this.canceled = true; } }; timers.push(timer); return timer; } });
  return { service, api, timers, notifications, setClock: n => { clock = start + n; }, setThread: value => { current = value; }, get stored() { return stored; }, get calls() { return calls; } };
}
const legacy = (patch = {}) => ({ id: 'job', commandId: 'command', messageId: 'message', threadId: 'thread', message: 'Continue', scheduleAt: iso(60_000), status: 'pending', createdAt: iso(0), ...patch });

test('legacy migration preserves IDs/outcomes and snapshots buffer once', () => {
  const original = legacy({ status: 'failed', note: 'Original failure' });
  const migrated = migrateJobs([original], 12);
  assert.equal(migrated.length, 1);
  for (const key of Object.keys(original)) assert.equal(migrated[0][key], original[key]);
  assert.equal(migrated[0].bufferSeconds, 12);
  assert.equal(migrateJobs({ version: 2, jobs: migrated }, 90)[0].bufferSeconds, 12);
});

test('create snapshots baseline and buffer; editing preserves original baseline and stable IDs', async () => {
  const h = harness();
  h.setThread({ ...thread(), messages: [{ role: 'user', createdAt: iso(-1000) }] });
  const job = await h.service.create(input());
  assert.equal(job.baselineUserTurnAt, iso(-1000));
  h.service.bufferSeconds = 100;
  const edited = h.service.edit(job.id, { ...input(120_000), message: 'Proceed' });
  assert.equal(edited.bufferSeconds, 5);
  assert.equal(edited.effectiveAt, iso(125_000));
  assert.equal(edited.commandId, job.commandId);
  assert.equal(edited.messageId, job.messageId);
  assert.equal(edited.activitySince, job.activitySince);
  assert.equal(h.stored.version, 3);
});

test('obsolete edited and canceled timer callbacks never dispatch', async () => {
  const h = harness();
  const job = await h.service.create(input());
  const stale = h.timers[0];
  h.service.edit(job.id, input(120_000));
  assert.equal(stale.canceled, true);
  stale.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.service.get(job.id).status, 'pending');
  assert.equal(h.calls, 0);
  const current = h.timers.at(-1);
  h.service.cancel(job.id);
  current.callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls, 0);
  assert.equal(h.service.get(job.id).status, 'canceled');
});

test('dispatch transition locks out edit/cancel and overlapping delivery', async () => {
  const h = harness();
  const job = await h.service.create(input());
  let release;
  h.api.fetchThread = () => new Promise(resolve => { release = resolve; });
  h.setClock(70_000);
  const running = h.service.run(job.id);
  assert.throws(() => h.service.edit(job.id, input(120_000)), /Only scheduled/);
  assert.throws(() => h.service.cancel(job.id), /Only scheduled/);
  await h.service.run(job.id);
  release(thread());
  await running;
  assert.equal(h.calls, 1);
});

test('user activity after creation but before planned send cancels the schedule', async () => {
  const h = harness();
  const job = await h.service.create(input());
  h.setThread({ ...thread(), messages: [{ role: 'user', createdAt: iso(1000) }] });
  h.setClock(70_000);
  await h.service.run(job.id);
  assert.equal(h.service.get(job.id).status, 'canceled');
  assert.equal(h.calls, 0);
});

test('ambiguous delivery cannot auto-retry; acknowledgment persists across restart with offline history', async () => {
  const h = harness([], { dispatch: async () => { throw new ApiError('timeout', 'T3 Code did not respond in time.', {}, true); } });
  const job = await h.service.create(input());
  h.setClock(70_000);
  await h.service.run(job.id);
  assert.equal(h.service.get(job.id).status, 'unconfirmed');
  assert.equal(h.service.list().unacknowledgedFailures, 1);
  h.service.acknowledge(job.id);
  const restored = harness(h.stored, { fetchThread: async () => { throw new Error('offline'); } });
  restored.service.recover();
  restored.service.schedulePending();
  await restored.service.resume();
  assert.equal(restored.timers.length, 0);
  assert.equal(restored.calls, 0);
  assert.equal(restored.service.list({ view: 'history' }).jobs[0].status, 'unconfirmed');
  assert.equal(restored.service.list().unacknowledgedFailures, 0);
  assert.equal(restored.notifications.length, 0);
});

test('crash recovery reconciles message presence without any new POST', async () => {
  const h = harness([legacy({ status: 'dispatching' })]);
  h.service.recover();
  assert.equal(h.service.get('job').status, 'unconfirmed');
  await h.service.reconcile('job');
  assert.equal(h.service.get('job').status, 'unconfirmed');
  h.setThread({ ...thread(), messages: [{ id: 'message', role: 'user', createdAt: iso(0) }] });
  await h.service.reconcile('job');
  assert.equal(h.service.get('job').status, 'sent');
  // The reconciled turn cannot be matched to a T3 turn, so the first poll closes it as unknown.
  assert.equal(h.service.get('job').turn.state, 'running');
  await h.service.pollTurns();
  assert.equal(h.service.get('job').turn.state, 'unknown');
  assert.deepEqual(h.service.activeWork(), []);
  assert.equal(h.calls, 0);
});

test('missed pending schedules catch up once and record lateness', async () => {
  const h = harness([legacy()]);
  h.setClock(90_000);
  await Promise.all([h.service.resume(), h.service.resume()]);
  assert.equal(h.calls, 1);
  assert.equal(h.service.get('job').lateBySeconds, 25);
  assert.equal(h.service.get('job').status, 'sent');
});

test('local queue uses effective times and history pagination does not discard records', () => {
  const h = harness([legacy({ id: 'slow', bufferSeconds: 100 }), legacy({ id: 'fast', scheduleAt: iso(70_000), bufferSeconds: 0 }), legacy({ id: 'old', status: 'failed', updatedAt: iso(-1000) }), legacy({ id: 'new', status: 'sent', updatedAt: iso(0) })]);
  assert.deepEqual(h.service.list({ view: 'upcoming' }).jobs.map(x => x.id), ['fast', 'slow']);
  assert.equal(h.service.list({ view: 'history', limit: 1 }).jobs[0].id, 'new');
  assert.equal(h.service.list({ view: 'history', limit: 1, offset: 1 }).jobs[0].id, 'old');
  assert.equal(h.service.jobs.length, 4);
});

test('failed edits and cancellations leave the original schedule armed', async () => {
  for (const action of ['edit', 'cancel']) {
    const h = harness();
    const job = await h.service.create(input());
    const persist = h.service.persist;
    h.service.persist = () => { throw new Error('disk full'); };
    assert.throws(() => action === 'edit' ? h.service.edit(job.id, input(120_000)) : h.service.cancel(job.id), /disk full/);
    assert.equal(h.service.get(job.id).status, 'pending');
    assert.equal(h.service.get(job.id).scheduleAt, job.scheduleAt);
    assert.equal(h.timers.at(-1).canceled, false);
    h.service.persist = persist;
    h.setClock(70_000);
    h.timers.at(-1).callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.calls, 1);
  }
});

test('schedule again blocks uncertainty and returns a draft without sending', () => {
  const h = harness([legacy({ status: 'unconfirmed' })]);
  assert.throws(() => h.service.scheduleAgain('job'), /Confirm/);
  h.service.patch(h.service.get('job'), { status: 'sent' });
  const draft = h.service.scheduleAgain('job');
  assert.equal(draft.message, 'Continue');
  assert.equal(draft.threadId, 'thread');
  assert.equal(h.calls, 0);
});

test('selected timezone offset follows scheduled instant across DST independent of host timezone', async () => {
  const h = harness();
  const summer = await h.service.create({ ...input(), whenISO: '2099-07-15T12:00:00Z', timeZone: 'Europe/London' });
  assert.equal(summer.utcOffsetMinutes, 60);
  const winter = h.service.edit(summer.id, { ...input(), whenISO: '2099-12-15T12:00:00Z', timeZone: 'Europe/London' });
  assert.equal(winter.utcOffsetMinutes, 0);
  assert.equal(winter.scheduleAt, '2099-12-15T12:00:00.000Z');
});

test('confirmed missing and archived threads cancel without dispatch; settled alone still sends', async () => {
  for (const state of ['missing', 'archived', 'settled']) {
    const h = harness([legacy()]);
    if (state === 'missing') h.api.fetchThread = async () => { throw new ApiError('http_failure', 'HTTP 404', { status: 404 }); };
    else h.setThread({ ...thread(), ...(state === 'archived' ? { archivedAt: iso(0) } : { settledOverride: 'settled' }) });
    h.setClock(70_000);
    await h.service.run('job');
    assert.equal(h.service.get('job').status, state === 'settled' ? 'sent' : 'canceled');
    assert.equal(h.calls, state === 'settled' ? 1 : 0);
  }
});


test('migration refuses unknown versions and invalid persisted records instead of dropping data', () => {
  assert.throws(() => migrateJobs({ version: 4, jobs: [legacy()] }), /unsupported format/);
  assert.throws(() => migrateJobs([legacy(), { id: 'broken' }]), /invalid records/);
});


test('legacy ambiguous failures preserve history and require read-only confirmation across restarts', async () => {
  for (const note of ['T3 Code did not respond within 10 seconds.', 'Unexpected token <', 'Unknown failure']) {
    for (const wrapped of [false, true]) {
      const original = legacy({ status: 'failed', note });
      const h = harness(wrapped ? { version: 2, jobs: [original] } : [original]);
      h.service.recover();
      for (const key of Object.keys(original)) assert.equal(h.stored.jobs[0][key], original[key]);
      assert.equal(h.stored.jobs[0].deliveryCertainty, 'unknown');
      const presented = h.service.list({ view: 'history', status: 'unconfirmed' });
      assert.equal(presented.total, 1);
      assert.equal(presented.jobs[0].deliveryLabel, 'Delivery unconfirmed');
      assert.equal(h.service.list({ status: 'failed' }).total, 0);
      assert.throws(() => h.service.scheduleAgain('job'), /Confirm/);
      h.service.acknowledge('job');
      assert.throws(() => h.service.scheduleAgain('job'), /Confirm/);
      await h.service.reconcile('job');
      assert.equal(h.stored.jobs[0].note, note);
      assert.equal(h.stored.jobs[0].deliveryCertainty, 'unknown');
      const restored = harness(h.stored);
      restored.service.schedulePending();
      restored.setClock(90_000);
      await restored.service.resume();
      await restored.service.run('job');
      assert.equal(restored.timers.length, 0);
      assert.throws(() => restored.service.scheduleAgain('job'), /Confirm/);
      restored.api.fetchThread = async () => { throw new Error('offline'); };
      await assert.rejects(restored.service.reconcile('job'), /offline/);
      assert.throws(() => restored.service.scheduleAgain('job'), /Confirm/);
      restored.api.fetchThread = async () => ({ ...thread(), messages: [{ id: original.messageId }] });
      const confirmed = await restored.service.reconcile('job');
      assert.equal(confirmed.deliveryStatus, 'sent');
      assert.equal(restored.stored.jobs[0].status, original.status);
      assert.equal(restored.stored.jobs[0].note, original.note);
      assert.equal(restored.service.list({ status: 'sent' }).total, 1);
      assert.equal(restored.service.list().unacknowledgedFailures, 0);
      const confirmedRestart = harness(restored.stored);
      assert.equal(confirmedRestart.service.scheduleAgain('job').message, original.message);
      assert.equal(confirmedRestart.service.list({ status: 'unconfirmed' }).total, 0);
      assert.equal(h.calls + restored.calls + confirmedRestart.calls, 0);
    }
  }
});

test('confirmed pre-dispatch failures remain eligible for a draft after restart', async () => {
  const h = harness([legacy()], { fetchThread: async () => { throw new ApiError('timeout', 'Read timed out', {}, true); } });
  h.setClock(90_000);
  await h.service.run('job');
  assert.equal(h.service.get('job').deliveryCertainty, 'not-delivered');
  assert.equal(h.service.list({ status: 'failed' }).total, 1);
  const restored = harness(h.stored);
  assert.equal(restored.service.scheduleAgain('job').message, 'Continue');
  assert.equal(h.calls + restored.calls, 0);
});
