'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CAPABILITIES, availability, conversationState, defineHarness, describeHarness, turnOutcome } = require('../lib/harnesses/contract');
const { HarnessError, redact, toErrorInfo } = require('../lib/harnesses/errors');
const { createHarnessRegistry } = require('../lib/harnesses/registry');
const { applyHarnessSettingsInput, normaliseHarnessSettings, publicHarnessSettings, resolveHarnessSettings } = require('../lib/harnesses/settings');
const { awaitingInput, createT3Harness, turnOutcomeFor } = require('../lib/harnesses/t3');
const { JobService, migrateJobs } = require('../lib/job-service');
const { createFakeHarness } = require('../tools/fake-harness.cjs');

const start = Date.now() + 60_000;
const iso = (n) => new Date(start + n).toISOString();

function service(adapters, jobs = []) {
  let clock = start, stored;
  const timers = [], notifications = [];
  const s = new JobService({ jobs, harnesses: createHarnessRegistry(adapters), now: () => clock, persist: (value) => { stored = JSON.parse(JSON.stringify(value)); },
    notify: (...args) => notifications.push(args), scheduleTimer: (date, callback) => { const timer = { date, callback, cancel() { this.canceled = true; } }; timers.push(timer); return timer; } });
  return { service: s, timers, notifications, setClock: (n) => { clock = start + n; }, get stored() { return stored; } };
}
const input = (harness, n = 60_000) => ({ harness, threadId: 'conv', message: 'Continue', whenISO: iso(n), timeZone: 'UTC' });

test('defineHarness enforces every capability, method and setting shape', () => {
  const { adapter } = createFakeHarness();
  const valid = { ...adapter, capabilities: { ...adapter.capabilities } };
  assert.equal(defineHarness(valid).id, 'fake');
  assert.throws(() => defineHarness({ ...valid, id: 'Bad Id' }), /lowercase slug/);
  assert.throws(() => defineHarness({ ...valid, kind: 'browser' }), /kind/);
  const missing = { ...valid.capabilities }; delete missing.requiresUnlockedScreen;
  assert.throws(() => defineHarness({ ...valid, capabilities: missing }), /requiresUnlockedScreen/);
  assert.throws(() => defineHarness({ ...valid, capabilities: { ...valid.capabilities, canFly: true } }), /unknown capability/);
  assert.throws(() => defineHarness({ ...valid, submitTurn: undefined }), /submitTurn/);
  assert.throws(() => defineHarness({ ...valid, checkTurn: undefined }), /checkTurn/);
  assert.throws(() => defineHarness({ ...valid, probeAvailability: undefined }), /probeAvailability/);
  assert.throws(() => defineHarness({ ...valid, settings: [{ key: 'port', type: 'color', label: 'Port' }] }), /unsupported type/);
  assert.deepEqual(Object.keys(describeHarness(adapter).capabilities), CAPABILITIES);
  assert.ok(Object.isFrozen(defineHarness(valid).capabilities));
});

test('registry keeps registration order, rejects duplicates and reports unknown harnesses as structured errors', async () => {
  const t3 = createT3Harness({ api: {} });
  const fake = createFakeHarness().adapter;
  const registry = createHarnessRegistry([t3, fake]);
  assert.deepEqual(registry.describe().map((item) => item.id), ['t3', 'fake']);
  assert.throws(() => registry.register(fake), /already registered/);
  assert.throws(() => registry.get('missing'), (error) => error instanceof HarnessError && error.code === 'unknown_harness');
  assert.equal(JSON.stringify(registry.describe()).includes('function'), false);
  await registry.shutdown();
});

test('T3 adapter capabilities describe the existing local API behaviour', () => {
  const t3 = createT3Harness({ api: {} });
  assert.equal(t3.capabilities.requiresUnlockedScreen, false);
  assert.equal(t3.capabilities.canConfirmDelivery, true);
  assert.equal(t3.capabilities.canDetectCompletion, true);
  assert.equal(t3.capabilities.canDetectUsageLimit, false);
});

test('normalisers keep unknown values explicit and timestamps in ISO form', () => {
  assert.equal(availability({ state: 'sleepy' }).state, 'unknown');
  assert.equal(availability({ state: 'limited', resetsAt: 1_790_000_000 }).resetsAt, new Date(1_790_000_000_000).toISOString());
  assert.equal(turnOutcome({ state: 'done' }).state, 'unknown');
  assert.equal(turnOutcome({ state: 'failed', usageLimit: { resetsAt: '2030-01-01T00:00:00Z', message: 'Limit' } }).usageLimit.resetsAt, '2030-01-01T00:00:00.000Z');
});

test('awaitingInput is optional and normalises anything but a boolean to unknown', () => {
  assert.equal(conversationState({ id: 'a' }).awaitingInput, null);
  assert.equal(conversationState({ id: 'a', awaitingInput: true }).awaitingInput, true);
  assert.equal(conversationState({ id: 'a', awaitingInput: false }).awaitingInput, false);
  assert.equal(conversationState({ id: 'a', awaitingInput: 'yes' }).awaitingInput, null);
});

test('T3 awaitingInput follows T3 Code open-request accounting', () => {
  const activity = (kind, requestId, detail) => ({ kind, payload: { requestId, ...(detail ? { detail } : {}) } });
  assert.equal(awaitingInput({}), null, 'Missing activities are unknown');
  assert.equal(awaitingInput({ activities: [] }), false);
  assert.equal(awaitingInput({ activities: [activity('approval.requested', 'a')] }), true);
  assert.equal(awaitingInput({ activities: [activity('approval.requested', 'a'), activity('approval.resolved', 'a')] }), false);
  assert.equal(awaitingInput({ activities: [activity('user-input.requested', 'b'), activity('approval.resolved', 'a')] }), true);
  assert.equal(awaitingInput({ activities: [activity('user-input.requested', 'b'), activity('provider.user-input.respond.failed', 'b', 'Network error')] }), true);
  assert.equal(awaitingInput({ activities: [activity('user-input.requested', 'b'), activity('provider.user-input.respond.failed', 'b', 'Stale pending user-input request')] }), false);
  assert.equal(awaitingInput({ activities: [null, { kind: 'approval.requested' }, activity('tool.completed', 'c')] }), false);
});

test('errors are sanitized and credential-like text is redacted', () => {
  assert.equal(toErrorInfo(new Error('secret')).message.includes('secret'), false);
  const text = redact('Bearer abc.def token sk-ant-api03-abcdefghijklmnop and a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6 plus my-password', ['my-password']);
  assert.doesNotMatch(text, /abc\.def|sk-ant|a1b2c3d4e5f6a1b2|my-password/);
  assert.match(redact('/Users/me/project/src/really-long-directory-name-without-digits'), /really-long/);
});

test('harness settings validate ports, keep secrets private and honour environment overrides', () => {
  const { adapter } = createFakeHarness({ settings: [{ key: 'port', type: 'port', label: 'Port', default: 4096 }, { key: 'password', type: 'secret', label: 'Password', env: 'FAKE_PASSWORD' }] });
  const adapters = [adapter];
  assert.deepEqual(normaliseHarnessSettings(adapters, { fake: { port: 99999, password: 'x', extra: 1 }, other: { a: 1 } }), { fake: { password: 'x' } });
  let stored = applyHarnessSettingsInput(adapters, {}, { fake: { port: '5000', password: 'stored-secret' } });
  assert.deepEqual(stored, { fake: { port: 5000, password: 'stored-secret' } });
  stored = applyHarnessSettingsInput(adapters, stored, { fake: { password: '' } });
  assert.equal(stored.fake.password, 'stored-secret', 'Blank secrets keep the stored value');
  assert.throws(() => applyHarnessSettingsInput(adapters, stored, { fake: { port: 0 } }), /port/);
  assert.throws(() => applyHarnessSettingsInput(adapters, stored, { nope: {} }), /Unknown/);
  const shown = publicHarnessSettings(adapters, stored, {});
  assert.deepEqual(shown.fake.password, { hasStoredValue: true, usingEnvironment: false });
  assert.doesNotMatch(JSON.stringify(shown), /stored-secret/);
  assert.equal(resolveHarnessSettings(adapter, stored.fake, { FAKE_PASSWORD: 'env-secret' }).password, 'env-secret');
  assert.equal(resolveHarnessSettings(adapter, {}, {}).port, 4096);
  assert.deepEqual(applyHarnessSettingsInput(adapters, stored, { fake: { clear: ['password'] } }), { fake: { port: 5000 } });
});

test('legacy v2 and array stores migrate to T3 without changing their records', () => {
  const legacy = { id: 'job', commandId: 'c', messageId: 'm', threadId: 't', message: 'Continue', scheduleAt: iso(0), status: 'pending', createdAt: iso(-1) };
  for (const value of [[legacy], { version: 2, jobs: [legacy] }, { version: 3, jobs: [legacy] }]) {
    const [job] = migrateJobs(value);
    assert.equal(job.harness, 't3');
    for (const key of Object.keys(legacy)) assert.equal(job[key], legacy[key]);
  }
  assert.throws(() => migrateJobs({ version: 3, jobs: [{ ...legacy, harness: '../evil' }] }), /invalid records/);
  assert.equal(migrateJobs({ version: 3, jobs: [{ ...legacy, harness: 'future-desktop' }] })[0].harness, 'future-desktop');
});

test('a non-T3 harness schedules, persists its delivery key before submitting and tracks completion', async () => {
  const fake = createFakeHarness({ conversations: [{ id: 'conv', title: 'Refactor', projectName: 'repo' }] });
  let finish;
  fake.state.completion = new Promise((resolve) => { finish = resolve; });
  const h = service([fake.adapter]);
  const job = await h.service.create(input('fake'));
  assert.equal(job.harness, 'fake');
  assert.equal(job.harnessLabel, 'Fake Agent');
  assert.equal(job.threadTitle, 'Refactor');
  assert.equal(h.stored.version, 3);
  h.setClock(70_000);
  await h.service.run(job.id);
  const sent = h.service.get(job.id);
  assert.equal(sent.status, 'sent');
  assert.equal(sent.deliveryKey, `fake-${job.messageId}`);
  assert.equal(fake.state.submitted[0].deliveryKey, sent.deliveryKey);
  assert.equal(sent.turn.state, 'running');
  assert.equal(sent.turn.turnId, 'turn-1');
  assert.equal(h.service.present(sent).deliveryLabel, 'Sent to Fake Agent');
  assert.deepEqual(h.service.activeWork().map((item) => [item.jobId, item.phase]), [[job.id, 'running']]);
  finish({ state: 'completed', completedAt: iso(80_000) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.service.get(job.id).turn.state, 'completed');
  assert.equal(h.service.activeWork().length, 0);
  assert.equal(h.notifications.at(-1)[0], 'Agent turn finished');
  h.service.recordTurn(job.id, { state: 'failed' });
  assert.equal(h.service.get(job.id).turn.state, 'completed', 'Finished outcomes are final');
});

test('polling records completion for running turns and ignores harness read failures', async () => {
  const fake = createFakeHarness({ conversations: [{ id: 'conv' }] });
  const h = service([fake.adapter]);
  const job = await h.service.create(input('fake'));
  h.setClock(70_000);
  await h.service.run(job.id);
  assert.throws(() => { fake.adapter.checkTurn = undefined; }, TypeError, 'Registered adapters are frozen');
  fake.state.turnError = new HarnessError('timeout', 'Store unreadable');
  await h.service.pollTurns();
  assert.equal(h.service.get(job.id).turn.state, 'running', 'A failed read leaves the turn running');
  fake.state.turnError = null;
  fake.state.turn = { state: 'failed', usageLimit: { resetsAt: iso(3_600_000), message: 'Usage limit reached' } };
  await h.service.pollTurns();
  const turn = h.service.get(job.id).turn;
  assert.equal(turn.state, 'failed');
  assert.equal(turn.usageLimit.resetsAt, iso(3_600_000));
  assert.equal(h.notifications.at(-1)[0], 'Agent reached a usage limit');
});

test('a reported usage limit fails before sending and remains schedulable again', async () => {
  const fake = createFakeHarness({ conversations: [{ id: 'conv' }] });
  const h = service([fake.adapter]);
  const job = await h.service.create(input('fake'));
  fake.state.availability = { state: 'limited', resetsAt: iso(7_200_000), reason: 'Weekly limit', source: 'reported' };
  h.setClock(70_000);
  await h.service.run(job.id);
  const failed = h.service.get(job.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.deliveryCertainty, 'not-delivered');
  assert.equal(failed.error.code, 'usage_limited');
  assert.equal(failed.error.details.resetsAt, iso(7_200_000));
  assert.equal(fake.state.submitted.length, 0);
  assert.equal(h.service.scheduleAgain(job.id).harness, 'fake');
});

test('a limit without a reset time blocks only when the harness reported it', async () => {
  for (const [source, expected] of [['reported', 'failed'], ['inferred', 'sent']]) {
    const fake = createFakeHarness({ conversations: [{ id: 'conv' }] });
    const h = service([fake.adapter]);
    const job = await h.service.create(input('fake'));
    fake.state.availability = { state: 'limited', resetsAt: null, reason: 'Limit', source };
    h.setClock(70_000);
    await h.service.run(job.id);
    assert.equal(h.service.get(job.id).status, expected, source);
  }
});

test('an expired limit does not block delivery', async () => {
  const fake = createFakeHarness({ conversations: [{ id: 'conv' }] });
  const h = service([fake.adapter]);
  const job = await h.service.create(input('fake'));
  fake.state.availability = { state: 'limited', resetsAt: iso(65_000), reason: 'Hourly limit', source: 'inferred' };
  h.setClock(70_000);
  await h.service.run(job.id);
  assert.equal(h.service.get(job.id).status, 'sent');
});

test('uncertain submission becomes unconfirmed and reconciliation uses the persisted delivery key', async () => {
  const fake = createFakeHarness({ conversations: [{ id: 'conv' }] });
  const h = service([fake.adapter]);
  const job = await h.service.create(input('fake'));
  fake.state.submitError = new HarnessError('timeout', 'Fake timed out', {}, true);
  h.setClock(70_000);
  await h.service.run(job.id);
  assert.equal(h.service.get(job.id).status, 'unconfirmed');
  await h.service.reconcile(job.id);
  assert.equal(h.service.get(job.id).status, 'unconfirmed');
  fake.state.conversations.get('conv').messages.push({ id: `fake-${job.messageId}`, role: 'user', createdAt: iso(70_000) });
  const confirmed = await h.service.reconcile(job.id);
  assert.equal(confirmed.deliveryStatus, 'sent');
  assert.equal(confirmed.turn.state, 'running');
  assert.equal(confirmed.turn.turnId, null);
  assert.equal(h.service.activeWork()[0].phase, 'running');
  const restored = service([fake.adapter], h.stored);
  fake.state.turn = { state: 'completed', turnId: 'recovered-turn' };
  await restored.service.pollTurns();
  assert.equal(restored.service.get(job.id).turn.state, 'completed');
  assert.deepEqual(restored.service.activeWork(), []);
  assert.equal(h.service.get(job.id).note, 'Message confirmed in Fake Agent');
  assert.equal(fake.state.submitted.length, 0);
});

test('prepare failures, missing conversations and unknown harnesses never count as uncertain delivery', async () => {
  const fake = createFakeHarness({ conversations: [{ id: 'conv' }] });
  const h = service([fake.adapter]);
  const first = await h.service.create(input('fake'));
  fake.state.prepareError = new HarnessError('conversation_busy', 'The session is open elsewhere.');
  h.setClock(70_000);
  await h.service.run(first.id);
  assert.equal(h.service.get(first.id).status, 'failed');
  assert.equal(h.service.get(first.id).deliveryCertainty, 'not-delivered');
  assert.equal(h.service.get(first.id).dispatchAttemptedAt, undefined);
  fake.state.prepareError = null;
  h.setClock(0);
  const second = await h.service.create(input('fake'));
  fake.state.conversations.delete('conv');
  h.setClock(70_000);
  await h.service.run(second.id);
  assert.equal(h.service.get(second.id).status, 'canceled');
  assert.equal(h.service.get(second.id).note, 'Session is no longer available');
  const orphan = service([fake.adapter], [{ id: 'orphan', harness: 'retired', commandId: 'c', messageId: 'm', threadId: 't', message: 'Continue', scheduleAt: iso(0), status: 'pending', createdAt: iso(-1) }]);
  orphan.setClock(70_000);
  await orphan.service.run('orphan');
  assert.equal(orphan.service.get('orphan').status, 'failed');
  assert.equal(orphan.service.get('orphan').error.code, 'unknown_harness');
  await assert.rejects(h.service.create(input('retired')), /not available/);
  await assert.rejects(h.service.create({ ...input('fake'), harness: 'Bad Harness' }), /valid agent harness/);
});

test('user activity in a non-T3 conversation cancels the schedule', async () => {
  const fake = createFakeHarness({ conversations: [{ id: 'conv' }] });
  const h = service([fake.adapter]);
  const job = await h.service.create(input('fake'));
  fake.state.conversations.get('conv').messages.push({ id: 'user-typed', role: 'user', createdAt: iso(1000) });
  h.setClock(70_000);
  await h.service.run(job.id);
  assert.equal(h.service.get(job.id).status, 'canceled');
  assert.equal(fake.state.submitted.length, 0);
});

test('running polls persist changed outcome fields and skip identical normalized outcomes', async () => {
  const fake = createFakeHarness({ conversations: [{ id: 'conv' }] });
  const h = service([fake.adapter]);
  const job = await h.service.create(input('fake'));
  h.setClock(70_000);
  await h.service.run(job.id);
  let changes = 0;
  h.service.onChange = () => { changes++; };
  fake.state.turn = { state: 'running', turnId: 'turn-1', usageLimit: { message: 'Retrying', resetsAt: iso(3_600_000) }, error: { code: 'retry', message: 'Waiting' } };
  await h.service.pollTurns();
  assert.equal(changes, 1);
  assert.equal(h.stored.jobs[0].turn.usageLimit.resetsAt, iso(3_600_000));
  assert.equal(h.stored.jobs[0].turn.error.code, 'retry');
  fake.state.turn.usageLimit.resetsAt = iso(3_600_000).replace('Z', '+00:00');
  await h.service.pollTurns();
  assert.equal(changes, 1);
  fake.state.turn = { state: 'running', turnId: 'new-turn' };
  await h.service.pollTurns();
  assert.equal(changes, 2);
  assert.equal(h.stored.jobs[0].turn.turnId, 'new-turn');
  assert.equal(h.stored.jobs[0].turn.usageLimit, null);
  assert.equal(h.stored.jobs[0].turn.error, null);
});

test('reconciliation restores turn tracking after interrupted dispatch recovery', async () => {
  const fake = createFakeHarness({ conversations: [{ id: 'conv' }] });
  const h = service([fake.adapter]);
  const job = await h.service.create(input('fake'));
  h.service.patch(h.service.get(job.id), { status: 'dispatching', dispatchAttemptedAt: iso(70_000) });
  fake.state.conversations.get('conv').messages.push({ id: job.messageId, role: 'user', createdAt: iso(70_000) });
  const restored = service([fake.adapter], h.stored);
  restored.service.recover();
  await restored.service.reconcile(job.id);
  assert.equal(restored.stored.jobs[0].turn.state, 'running');
  assert.equal(restored.service.activeWork().length, 1);
  fake.state.turn = { state: 'completed' };
  await restored.service.pollTurns();
  assert.deepEqual(restored.service.activeWork(), []);
});

test('T3 turn outcomes follow the turn its command started', () => {
  const requested = '2026-10-01T10:00:00.000Z';
  const turn = { conversationId: 'thread', deliveryKey: 'message', turnId: `requested:${requested}` };
  const now = Date.parse('2026-10-01T10:05:00Z');
  const latest = (state, extra = {}) => ({ latestTurn: { turnId: 't-1', state, requestedAt: requested, startedAt: requested, completedAt: state === 'running' ? null : '2026-10-01T10:04:00.000Z' }, ...extra });
  assert.equal(turnOutcomeFor(latest('running'), turn, now).state, 'running');
  assert.deepEqual([turnOutcomeFor(latest('completed'), turn, now).state, turnOutcomeFor(latest('completed'), turn, now).completedAt], ['completed', '2026-10-01T10:04:00.000Z']);
  assert.equal(turnOutcomeFor(latest('interrupted'), turn, now).state, 'interrupted');
  const limited = turnOutcomeFor(latest('error', { session: { status: 'error', lastError: "You've hit your usage limit · resets 3pm (UTC)" } }), turn, now);
  assert.equal(limited.state, 'failed');
  assert.equal(limited.error.code, 'usage_limited');
  assert.equal(limited.usageLimit.resetsAt, '2026-10-01T15:00:00.000Z');
  assert.equal(turnOutcomeFor(latest('error', { session: { lastError: 'Provider crashed' } }), turn, now).error.code, 'agent_error');
  const failedStart = turnOutcomeFor({ latestTurn: null, activities: [{ kind: 'provider.turn.start.failed', summary: 'Provider turn start failed', payload: { requestId: 'message', detail: 'Codex is not signed in' } }] }, turn, now);
  assert.equal(failedStart.state, 'failed');
  assert.match(failedStart.error.message, /not signed in/);
  assert.equal(turnOutcomeFor({ latestTurn: { state: 'completed', requestedAt: '2026-10-01T10:02:00.000Z' } }, turn, now).state, 'unknown', 'A later turn hides this turn result');
  assert.equal(turnOutcomeFor({ latestTurn: { state: 'completed', requestedAt: '2026-10-01T09:00:00.000Z' } }, turn, now).state, 'running', 'Queued behind an earlier turn');
  assert.equal(turnOutcomeFor({ latestTurn: null }, turn, Date.parse('2026-10-01T11:00:00Z')).state, 'unknown', 'A turn that never starts stops being tracked');
  assert.equal(turnOutcomeFor(latest('running'), { ...turn, turnId: null }, now).state, 'unknown');
});

test('a T3 job records the turn its command starts and reports completion', async () => {
  let thread = { id: 'thread', title: 'T3 thread', projectId: 'p', messages: [], modelSelection: { model: 'm', instanceId: 'i' }, runtimeMode: 'full-access', interactionMode: 'default', latestTurn: null };
  const commands = [];
  const api = { fetchThread: async () => thread, fetchSnapshot: async () => ({ threads: [thread], projects: [] }), dispatch: async (command) => { commands.push(command); return { sequence: 1 }; } };
  let clock = Date.now() + 60_000;
  const service = new JobService({ harnesses: createHarnessRegistry([createT3Harness({ api, now: () => clock })]), now: () => clock, persist: () => {}, scheduleTimer: () => ({ cancel() {} }) });
  const job = await service.create({ harness: 't3', threadId: 'thread', message: 'Continue', whenISO: new Date(clock + 60_000).toISOString(), timeZone: 'UTC' });
  clock += 120_000;
  await service.run(job.id);
  const sent = service.get(job.id);
  assert.equal(sent.status, 'sent');
  assert.equal(sent.turn.turnId, `requested:${commands[0].createdAt}`);
  thread = { ...thread, latestTurn: { turnId: 'turn-9', state: 'running', requestedAt: commands[0].createdAt, startedAt: commands[0].createdAt, completedAt: null } };
  await service.pollTurns();
  assert.equal(service.get(job.id).turn.state, 'running');
  assert.equal(service.activeWork()[0].phase, 'running');
  thread = { ...thread, latestTurn: { ...thread.latestTurn, state: 'completed', completedAt: new Date(clock).toISOString() } };
  await service.pollTurns();
  assert.equal(service.get(job.id).turn.state, 'completed');
  assert.deepEqual(service.activeWork(), []);
});

test('an interrupted send that never started runs again instead of becoming unconfirmed', async () => {
  const fake = createFakeHarness({ conversations: [{ id: 'conv' }] });
  const h = service([fake.adapter]);
  const job = await h.service.create(input('fake'));
  h.service.patch(h.service.get(job.id), { status: 'dispatching' });
  const restored = service([fake.adapter], h.stored);
  restored.service.recover();
  assert.equal(restored.service.get(job.id).status, 'pending');
  assert.equal(restored.service.get(job.id).deliveryCertainty, 'not-delivered');
  restored.setClock(70_000);
  await restored.service.resume();
  assert.equal(restored.service.get(job.id).status, 'sent');
  assert.equal(fake.state.submitted.length, 1);
});

test('a conversation that is waiting for the user or still working is refused, while unknown never blocks', async () => {
  for (const [patch, code] of [[{ awaitingInput: true }, 'awaiting_input'], [{ busy: true }, 'conversation_busy'], [{ awaitingInput: null }, null]]) {
    const fake = createFakeHarness({ conversations: [{ id: 'conv', ...patch }] });
    const h = service([fake.adapter]);
    const job = await h.service.create(input('fake'));
    h.setClock(70_000);
    await h.service.run(job.id);
    const result = h.service.get(job.id);
    if (code) {
      assert.equal(result.status, 'failed', code);
      assert.equal(result.error.code, code);
      assert.equal(result.deliveryCertainty, 'not-delivered');
      assert.equal(fake.state.submitted.length, 0);
      assert.equal(h.notifications.at(-1)[0], 'Scheduled message not sent');
    } else {
      assert.equal(result.status, 'sent');
    }
  }
});

test('a turn that cannot be followed is closed as unknown after a day', async () => {
  const fake = createFakeHarness({ conversations: [{ id: 'conv' }] });
  const h = service([fake.adapter]);
  const job = await h.service.create(input('fake'));
  h.setClock(70_000);
  await h.service.run(job.id);
  fake.state.turnError = new HarnessError('connection_refused', 'Harness is not running');
  h.setClock(70_000 + 23 * 3_600_000);
  await h.service.pollTurns();
  assert.equal(h.service.get(job.id).turn.state, 'running', 'Still tracked within a day');
  h.setClock(70_000 + 7 * 24 * 3_600_000);
  await h.service.pollTurns();
  assert.equal(h.service.get(job.id).turn.state, 'unknown');
  assert.equal(h.service.get(job.id).turn.error.code, 'tracking_expired');
  assert.deepEqual(h.service.activeWork(), []);
});

