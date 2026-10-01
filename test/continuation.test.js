'use strict';
// Automatic continuations (issue #3) with a fake harness, fake clock and fake timers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JobService, migrateJobs } = require('../lib/job-service');
const { createHarnessRegistry } = require('../lib/harnesses/registry');
const { createT3Harness } = require('../lib/harnesses/t3');
const { HarnessError } = require('../lib/harnesses/errors');
const continuation = require('../lib/continuation');
const { createFakeHarness } = require('../tools/fake-harness.cjs');

const start = Date.now() + 60_000;
const iso = (n) => new Date(start + n).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve)); };

// A service over one fake harness whose clock only moves when the test says so.
function setup({ capabilities, jobs = [], conversation = {} } = {}) {
  const fake = createFakeHarness({ capabilities, conversations: [{ id: 'conv', title: 'Refactor', projectName: 'repo', ...conversation }] });
  let clock = start;
  let stored;
  const timers = [], notifications = [], finishers = [];
  // Each submitted turn gets its own completion promise, resolved by the test.
  fake.state.completion = () => new Promise((resolve) => finishers.push(resolve));
  const make = (initial) => new JobService({ jobs: initial, harnesses: createHarnessRegistry([fake.adapter]), now: () => clock,
    persist: (value) => { stored = JSON.parse(JSON.stringify(value)); }, notify: (...args) => notifications.push(args),
    scheduleTimer: (date, callback) => { const timer = { date, callback, canceled: false, fired: false, cancel() { this.canceled = true; } }; timers.push(timer); return timer; } });
  const h = {
    fake, timers, notifications, finishers, service: make(jobs),
    get stored() { return stored; },
    get now() { return clock; },
    set(n) { clock = start + n; },
    // Moves the clock forward and fires every due timer, as node-schedule would.
    async advance(ms) {
      clock += ms;
      for (let guard = 0; guard < 50; guard++) {
        const due = timers.filter((timer) => !timer.canceled && !timer.fired && timer.date.valueOf() <= clock);
        if (!due.length) break;
        for (const timer of due) { timer.fired = true; timer.callback(); }
        await settle();
      }
      await settle();
    },
    // Resolves the completion promise of the Nth submitted turn (1-based).
    async finish(n, outcome = {}) { finishers[n - 1]({ state: 'completed', completedAt: new Date(clock).toISOString(), ...outcome }); await settle(); },
    restart() { h.service = make(stored); h.service.recover(); h.service.schedulePending(); return h.service; },
    armedTimers: () => timers.filter((timer) => !timer.canceled && !timer.fired)
  };
  return h;
}
const create = (h, patch = {}) => h.service.create({ harness: 'fake', threadId: 'conv', message: 'Continue', timeZone: 'UTC', trigger: 'available', turnLimit: 1, ...patch });
const job = (h, id) => h.service.get(id);

test('turn limit input: default 1, whole numbers only, zero and negatives rejected, continuous removes the limit', () => {
  assert.deepEqual(continuation.validateAutomation({}), { trigger: 'time', limit: 1 });
  assert.deepEqual(continuation.validateAutomation({ turnLimit: 250_000 }), { trigger: 'time', limit: 250_000 });
  assert.deepEqual(continuation.validateAutomation({ turnLimit: '12' }), { trigger: 'time', limit: 12 });
  assert.deepEqual(continuation.validateAutomation({ trigger: 'available', continuous: true, turnLimit: 0 }), { trigger: 'available', limit: null });
  assert.throws(() => continuation.validateAutomation({ turnLimit: 0 }), /at least 1/);
  assert.throws(() => continuation.validateAutomation({ turnLimit: -3 }), /at least 1/);
  assert.throws(() => continuation.validateAutomation({ turnLimit: 2.5 }), /whole number/);
  assert.throws(() => continuation.validateAutomation({ turnLimit: 'lots' }), /whole number/);
  assert.throws(() => continuation.validateAutomation({ turnLimit: 2 ** 60 }), /too large/);
  assert.throws(() => continuation.validateAutomation({ trigger: 'whenever' }), /Choose when to start/);
  assert.throws(() => continuation.validateAutomation({ continuous: 'yes' }), /continuous/);
});

test('modes a harness cannot support are rejected with the reason, and T3 keeps single timed messages', async () => {
  const blind = setup({ capabilities: { canDetectUsageLimit: false, canReportResetTime: false, canDetectCompletion: false } });
  await assert.rejects(create(blind), /does not report usage limits/);
  await assert.rejects(create(blind, { trigger: 'time', whenISO: iso(MIN), turnLimit: 3 }), /does not report when the agent finishes a turn/);
  await assert.rejects(create(blind, { trigger: 'time', whenISO: iso(MIN), continuous: true }), /does not report when the agent finishes a turn/);
  const single = await create(blind, { trigger: 'time', whenISO: iso(MIN) });
  assert.equal(single.chain, null, 'A timed single message stays a plain schedule');
  const support = continuation.automationSupport(createT3Harness({ api: {} }));
  assert.equal(support.whenAvailable.supported, false);
  assert.equal(support.multipleTurns.supported, false);
  assert.match(support.whenAvailable.reason, /T3 Code does not report usage limits/);
  assert.equal(blind.fake.state.submitted.length, 0);
});

test('auto-start waits for a reported limit to reset plus the safety buffer, then sends exactly once', async () => {
  const h = setup();
  h.fake.state.availability = { state: 'limited', resetsAt: iso(2 * HOUR), reason: '5-hour limit', source: 'reported' };
  const created = await create(h);
  assert.equal(created.scheduleAt, iso(0));
  assert.equal(created.displayStatus, 'waiting', 'An auto-start is waiting from the moment it is created');
  await h.advance(5_000);
  const waiting = h.service.present(job(h, created.id));
  assert.equal(waiting.displayStatus, 'waiting');
  assert.equal(waiting.deliveryLabel, 'Waiting for availability');
  assert.equal(waiting.waiting.nextCheckAt, iso(2 * HOUR + 5_000), 'Reset time plus the 5-second buffer');
  assert.equal(waiting.waiting.availability.source, 'reported');
  assert.equal(h.service.activeWork()[0].phase, 'waiting');
  assert.equal(h.armedTimers().at(-1).date.toISOString(), iso(2 * HOUR + 5_000));
  assert.equal(h.fake.state.submitted.length, 0);
  // The reset time is honoured even though the provider now claims availability early.
  h.fake.state.availability = { state: 'available', source: 'reported' };
  await h.advance(2 * HOUR - 1);
  assert.equal(h.fake.state.submitted.length, 0);
  await h.advance(1);
  assert.equal(h.fake.state.submitted.length, 1);
  const sent = job(h, created.id);
  assert.equal(sent.status, 'sent');
  assert.equal(sent.turn.state, 'running');
  await h.finish(1);
  const done = h.service.present(job(h, created.id));
  assert.equal(done.automation.state, 'finished');
  assert.equal(done.automation.sentTurns, 1);
  assert.equal(h.fake.state.submitted.length, 1);
  assert.equal(h.service.activeWork().length, 0);
});

test('an unavailable agent, a failed check and a reported limit without reset back off 1, 2, 5, 10 then 15 minutes', async () => {
  const h = setup();
  h.fake.state.availability = { state: 'unavailable', reason: 'App not running', source: 'reported' };
  const created = await create(h);
  await h.advance(5_000);
  const expected = [MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 15 * MIN];
  const readings = [{ state: 'unavailable', source: 'reported' }, { get state() { throw new Error('Store unreadable'); } }, { state: 'limited', source: 'reported' },
    { state: 'unavailable', source: 'none' }, { state: 'limited', source: 'reported' }, { state: 'unavailable', source: 'reported' }];
  for (let i = 0; i < expected.length; i++) {
    const current = job(h, created.id);
    assert.equal(Date.parse(current.nextAttemptAt) - h.now, expected[i], `Backoff step ${i}`);
    assert.match(current.note, /Checking again/);
    h.fake.state.availability = readings[i];
    await h.advance(expected[i]);
  }
  assert.equal(h.fake.state.submitted.length, 0);
  assert.equal(h.service.present(job(h, created.id)).waiting.availability.state, 'unavailable');
  const probes = h.fake.state.calls.filter(([name]) => name === 'probeAvailability').length;
  h.fake.state.availability = { state: 'available', source: 'reported' };
  await h.advance(15 * MIN);
  assert.equal(h.fake.state.submitted.length, 1);
  assert.equal(h.fake.state.calls.filter(([name]) => name === 'probeAvailability').length, probes + 1, 'One probe per check, none in the dispatch phase');
  assert.equal(job(h, created.id).availabilityChecks, 0, 'A successful send resets the backoff');
});

test('only a known block holds an auto-start: unknown and inferred limits without a reset time send', async () => {
  for (const availability of [{ state: 'unknown', source: 'none' }, { state: 'limited', source: 'inferred', reason: 'Recent limit message' }, { state: 'limited', resetsAt: iso(-MIN), source: 'reported' }]) {
    const h = setup();
    h.fake.state.availability = availability;
    await create(h);
    await h.advance(5_000);
    assert.equal(h.fake.state.submitted.length, 1, JSON.stringify(availability));
  }
});

test('at a time, then when available: nothing is probed before the time, and a limit at that time is waited out', async () => {
  const h = setup();
  const created = await create(h, { trigger: 'time-then-available', whenISO: iso(HOUR) });
  await h.advance(30 * MIN);
  assert.equal(h.fake.state.calls.filter(([name]) => name === 'probeAvailability').length, 0);
  h.fake.state.availability = { state: 'limited', resetsAt: iso(3 * HOUR), source: 'reported' };
  await h.advance(30 * MIN + 5_000);
  assert.equal(job(h, created.id).status, 'pending');
  assert.equal(job(h, created.id).nextAttemptAt, iso(3 * HOUR + 5_000));
  h.fake.state.availability = { state: 'available', source: 'reported' };
  await h.advance(2 * HOUR);
  assert.equal(h.fake.state.submitted.length, 1);
});

test('a timed chain still fails before sending when limited at its time, and pauses for the user', async () => {
  const h = setup();
  h.fake.state.availability = { state: 'limited', resetsAt: iso(3 * HOUR), source: 'reported' };
  const created = await create(h, { trigger: 'time', whenISO: iso(MIN), turnLimit: 3 });
  await h.advance(MIN + 5_000);
  const failed = h.service.present(job(h, created.id));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'usage_limited');
  assert.equal(failed.automation.state, 'paused');
  assert.equal(failed.automation.reasonCode, 'usage_limited');
  assert.equal(failed.canResume, true);
  // Resuming re-arms the unsent turn with new IDs and waits for the reset instead of failing again.
  h.service.resumeChain(created.id);
  const rearmed = job(h, created.id);
  assert.notEqual(rearmed.messageId, created.messageId);
  await h.advance(10_000);
  assert.equal(job(h, created.id).nextAttemptAt, iso(3 * HOUR + 5_000));
  h.fake.state.availability = { state: 'available', source: 'reported' };
  await h.advance(3 * HOUR);
  assert.equal(h.fake.state.submitted.length, 1);
});

test('a turn limit of 3 sends three distinct turns, each only after the previous one finished, then finishes', async () => {
  const h = setup();
  const created = await create(h, { turnLimit: 3 });
  await h.advance(5_000);
  assert.equal(h.fake.state.submitted.length, 1);
  await h.advance(10 * MIN);
  assert.equal(h.fake.state.submitted.length, 1, 'Nothing more is sent while the turn is running');
  assert.equal(h.service.present(job(h, created.id)).displayStatus, 'running');
  assert.deepEqual(h.service.list({ view: 'upcoming' }).jobs.map((item) => item.id), [created.id], 'A running chain stays in Upcoming');
  for (const n of [1, 2]) {
    await h.finish(n);
    const queued = h.service.present(job(h, created.id));
    assert.equal(queued.status, 'pending');
    assert.equal(queued.automation.progressLabel, `Turn ${n + 1} of 3`);
    assert.equal(h.service.activeWork().length, 1, 'Keep-awake sees continuous work between turns');
    await h.advance(5_000);
    assert.equal(h.fake.state.submitted.length, n + 1);
    await h.advance(10 * MIN);
  }
  await h.finish(3);
  const done = h.service.present(job(h, created.id));
  assert.equal(done.automation.state, 'finished');
  assert.equal(done.automation.reasonCode, 'limit_reached');
  assert.equal(done.automation.sentTurns, 3);
  assert.equal(done.automation.remainingTurns, 0);
  assert.deepEqual(done.automation.turns.map((turn) => [turn.number, turn.state]), [[1, 'completed'], [2, 'completed'], [3, 'completed']]);
  const keys = h.fake.state.submitted.map((item) => item.deliveryKey);
  assert.equal(new Set(keys).size, 3, 'Every turn has its own delivery key');
  assert.deepEqual(done.automation.turns.map((turn) => turn.deliveryKey), keys);
  await h.advance(HOUR);
  assert.equal(h.fake.state.submitted.length, 3);
  assert.deepEqual(h.service.list({ view: 'history' }).jobs.map((item) => item.id), [created.id]);
  assert.equal(h.notifications.filter(([title]) => title.startsWith('Sent to')).length, 1, 'Follow-up turns stay quiet');
  assert.equal(h.notifications.filter(([title]) => title === 'Continuation finished').length, 1);
});

test('continuous mode keeps going without a limit until stopped, and stopping mid-turn sends nothing further', async () => {
  const h = setup();
  const created = await create(h, { continuous: true });
  assert.equal(created.automation.unlimited, true);
  assert.equal(created.automation.progressLabel, 'Turn 1 · continuous');
  await h.advance(5_000);
  for (let n = 1; n <= 6; n++) {
    await h.advance(10 * MIN);
    await h.finish(n);
    await h.advance(5_000);
  }
  assert.equal(h.fake.state.submitted.length, 7);
  const running = h.service.present(job(h, created.id));
  assert.equal(running.automation.remainingTurns, null);
  assert.equal(running.automation.state, 'active');
  assert.equal(h.service.activeWork()[0].chain.unlimited, true);
  const stopped = h.service.stop(created.id);
  assert.equal(stopped.automation.state, 'stopped');
  assert.match(stopped.automation.reason, /current turn keeps running/);
  assert.equal(stopped.status, 'sent');
  assert.equal(h.service.activeWork().length, 1, 'The running turn still keeps the Mac awake');
  await h.advance(10 * MIN);
  await h.finish(7);
  await h.advance(HOUR);
  assert.equal(h.fake.state.submitted.length, 7);
  assert.equal(h.service.activeWork().length, 0);
  assert.equal(job(h, created.id).turn.state, 'completed');
  assert.throws(() => h.service.stop(created.id), /already ended/);
});

test('stop is immediate while waiting, during an availability check and during pre-send checks', async () => {
  const waitingCase = setup();
  waitingCase.fake.state.availability = { state: 'limited', resetsAt: iso(HOUR), source: 'reported' };
  const waiting = await create(waitingCase);
  await waitingCase.advance(5_000);
  const stale = waitingCase.armedTimers().at(-1);
  const result = waitingCase.service.stop(waiting.id);
  assert.equal(result.status, 'canceled');
  assert.equal(result.automation.state, 'stopped');
  assert.equal(stale.canceled, true);
  stale.callback();
  await waitingCase.advance(2 * HOUR);
  assert.equal(waitingCase.fake.state.submitted.length, 0);
  assert.equal(waitingCase.service.activeWork().length, 0);

  // A stop that lands while availability is being read.
  const probing = setup();
  let release;
  const created = await create(probing);
  probing.fake.state.availability = { state: 'available', source: 'reported' };
  const original = probing.service.adapterFor(job(probing, created.id));
  probing.service.harnesses = { has: () => true, get: () => ({ ...original, probeAvailability: () => new Promise((resolve) => { release = resolve; }) }) };
  probing.set(5_000);
  const run = probing.service.run(created.id);
  await settle();
  probing.service.stop(created.id);
  release({ state: 'available', source: 'reported' });
  await run;
  assert.equal(probing.fake.state.submitted.length, 0);
  assert.equal(job(probing, created.id).status, 'canceled');

  // A stop that lands while the conversation is inspected before sending.
  const inspecting = setup();
  const second = await create(inspecting, { trigger: 'time', whenISO: iso(MIN), turnLimit: 2 });
  const adapter = inspecting.service.adapterFor(job(inspecting, second.id));
  let proceed;
  inspecting.service.harnesses = { has: () => true, get: () => ({ ...adapter, inspectConversation: async (...args) => { await new Promise((resolve) => { proceed = resolve; }); return adapter.inspectConversation(...args); } }) };
  inspecting.set(MIN + 5_000);
  const sending = inspecting.service.run(second.id);
  await settle();
  assert.equal(job(inspecting, second.id).status, 'dispatching');
  inspecting.service.stop(second.id);
  proceed();
  await sending;
  assert.equal(inspecting.fake.state.submitted.length, 0);
  assert.equal(job(inspecting, second.id).status, 'canceled');
  assert.equal(job(inspecting, second.id).deliveryCertainty, 'not-delivered');
});

test('stopAll stops every active and paused continuation but leaves plain schedules alone', async () => {
  const h = setup();
  const plain = await create(h, { trigger: 'time', whenISO: iso(HOUR) });
  const a = await create(h, { continuous: true });
  const b = await create(h, { turnLimit: 4, trigger: 'time', whenISO: iso(2 * HOUR) });
  const c = await create(h, { turnLimit: 2 });
  h.fake.state.conversations.get('conv').awaitingInput = true;
  h.set(5_000);
  await h.service.run(c.id);
  assert.equal(job(h, c.id).chain.state, 'paused');
  assert.deepEqual(h.service.stopAll().stopped.sort(), [a.id, b.id, c.id].sort());
  assert.equal(job(h, plain.id).status, 'pending');
  assert.deepEqual(h.service.activeWork().map((item) => item.jobId), [plain.id]);
  assert.deepEqual(h.service.stopAll().stopped, []);
});

test('failed, interrupted and unknown turns pause the chain; resuming continues and keeps counting', async () => {
  for (const state of ['failed', 'interrupted', 'unknown']) {
    const h = setup();
    const created = await create(h, { turnLimit: 3 });
    await h.advance(5_000);
    await h.advance(10 * MIN);
    await h.finish(1, { state, error: state === 'failed' ? { message: 'Tool crashed' } : null });
    const paused = h.service.present(job(h, created.id));
    assert.equal(paused.automation.state, 'paused', state);
    assert.equal(paused.automation.reasonCode, `turn_${state}`);
    assert.equal(paused.displayStatus, 'paused');
    assert.equal(paused.needsAttention, true);
    assert.equal(h.service.list().unacknowledgedFailures, 1);
    assert.deepEqual(h.service.list({ view: 'history' }).jobs.map((item) => item.id), [created.id]);
    assert.equal(h.service.activeWork().length, 0, 'A paused chain does not keep the Mac awake');
    if (state === 'failed') assert.match(paused.automation.reason, /Tool crashed/);
    await h.advance(HOUR);
    assert.equal(h.fake.state.submitted.length, 1);
    const resumed = h.service.resumeChain(created.id);
    assert.equal(resumed.automation.state, 'active');
    assert.equal(resumed.automation.progressLabel, 'Turn 2 of 3');
    assert.equal(resumed.needsAttention, false);
    await h.advance(5_000);
    assert.equal(h.fake.state.submitted.length, 2);
    await h.advance(10 * MIN);
    await h.finish(2);
    await h.advance(5_000);
    await h.advance(10 * MIN);
    await h.finish(3);
    assert.equal(job(h, created.id).chain.state, 'finished');
    assert.equal(h.fake.state.submitted.length, 3);
  }
});

test('a turn that stops at a usage limit waits for the reported reset plus buffer before the next turn', async () => {
  const h = setup();
  const created = await create(h, { continuous: true });
  await h.advance(5_000);
  await h.advance(20 * MIN);
  h.fake.state.availability = { state: 'limited', resetsAt: iso(4 * HOUR), source: 'reported' };
  await h.finish(1, { state: 'failed', usageLimit: { resetsAt: iso(4 * HOUR), message: 'Usage limit reached' } });
  const queued = h.service.present(job(h, created.id));
  assert.equal(queued.automation.state, 'active');
  assert.equal(queued.displayStatus, 'waiting');
  assert.equal(queued.nextAttemptAt, iso(4 * HOUR + 5_000));
  assert.equal(queued.automation.turns[0].usageLimit.resetsAt, iso(4 * HOUR));
  await h.advance(4 * HOUR - 20 * MIN - 5_000);
  assert.equal(h.fake.state.submitted.length, 1);
  // Past the reset, an unknown reading is not a reason to hold back.
  h.fake.state.availability = { state: 'unknown', source: 'none' };
  await h.advance(10_000);
  assert.equal(h.fake.state.submitted.length, 2);
});

test('turns that end at a usage limit do not use up the turn limit; three in a row pause the chain', async () => {
  const h = setup();
  const created = await create(h);
  await h.advance(5_000);
  await h.advance(10 * MIN);
  await h.finish(1, { state: 'failed', error: { code: 'usage_limited', message: 'Limit reached' }, usageLimit: { resetsAt: iso(HOUR), message: 'Limit' } });
  const waiting = h.service.present(job(h, created.id));
  assert.equal(waiting.automation.state, 'active', 'A single-turn auto-start still continues after a limit');
  assert.equal(waiting.automation.progressLabel, 'Single turn');
  assert.equal(waiting.automation.countedTurns, 0);
  assert.equal(waiting.automation.turns[0].counted, false);
  await h.advance(HOUR);
  assert.equal(h.fake.state.submitted.length, 2);
  await h.advance(10 * MIN);
  await h.finish(2);
  const done = h.service.present(job(h, created.id));
  assert.equal(done.automation.state, 'finished');
  assert.equal(done.automation.sentTurns, 2);
  assert.equal(done.automation.countedTurns, 1);
  assert.match(done.automation.reason, /Sent 1 turn, the turn limit/);

  // A limit reported without a reset time waits 15 minutes; the third limited turn in a row pauses.
  const again = setup();
  const repeated = await create(again, { continuous: true });
  await again.advance(5_000);
  for (let n = 1; n <= 3; n++) {
    await again.advance(MIN);
    await again.finish(n, { state: 'failed', error: { code: 'usage_limited', message: 'Limit reached' } });
    if (n < 3) {
      assert.equal(Date.parse(job(again, repeated.id).nextAttemptAt) - again.now, 15 * MIN);
      await again.advance(15 * MIN);
    }
  }
  const paused = again.service.present(job(again, repeated.id));
  assert.equal(paused.automation.reasonCode, 'repeated_limits');
  assert.equal(again.fake.state.submitted.length, 3);
});

test('harness error codes: approval_required pauses for the user, agent and process failures pause, busy and ownership are handled before counting', async () => {
  const approval = setup();
  const a = await create(approval, { turnLimit: 3 });
  await approval.advance(5_000);
  await approval.advance(10 * MIN);
  await approval.finish(1, { state: 'interrupted', error: { code: 'approval_required', message: 'Approval requested' } });
  const needsYou = approval.service.present(job(approval, a.id));
  assert.equal(needsYou.automation.reasonCode, 'awaiting_input');
  assert.match(needsYou.automation.reason, /approval or input/);
  await approval.advance(HOUR);
  assert.equal(approval.fake.state.submitted.length, 1);

  for (const code of ['agent_error', 'process_failed']) {
    const h = setup();
    const created = await create(h, { continuous: true });
    await h.advance(5_000);
    await h.advance(10 * MIN);
    await h.finish(1, { state: 'failed', error: { code, message: 'The agent stopped' } });
    assert.equal(job(h, created.id).chain.state, 'paused', code);
    assert.equal(job(h, created.id).chain.reasonCode, 'turn_failed');
    await h.advance(HOUR);
    assert.equal(h.fake.state.submitted.length, 1, code);
  }

  // conversation_busy is a certain non-delivery, from prepare or from submit: wait and retry, uncounted.
  for (const stage of ['prepareError', 'submitError']) {
    const h = setup();
    const created = await create(h, { turnLimit: 2 });
    h.fake.state[stage] = new HarnessError('conversation_busy', 'The session is open in another window.');
    await h.advance(5_000);
    const busy = h.service.present(job(h, created.id));
    assert.equal(busy.status, 'pending', stage);
    assert.equal(busy.automation.state, 'active');
    assert.equal(busy.dispatchAttemptedAt, null);
    assert.equal(Date.parse(busy.nextAttemptAt) - h.now, MIN);
    assert.match(busy.note, /open in another window/);
    await h.advance(MIN);
    assert.equal(Date.parse(job(h, created.id).nextAttemptAt) - h.now, 2 * MIN, 'Backoff grows while busy');
    h.fake.state[stage] = null;
    await h.advance(2 * MIN);
    assert.equal(h.fake.state.submitted.length, 1, stage);
    assert.equal(job(h, created.id).messageId, created.messageId, 'The undelivered turn keeps its IDs');
    assert.equal(h.service.present(job(h, created.id)).automation.progressLabel, 'Turn 1 of 2');
  }

  const owned = setup();
  const o = await create(owned, { continuous: true });
  owned.fake.state.prepareError = new HarnessError('owned_by_other_harness', 'Claude Desktop owns this session.', { harness: 'claude-desktop' });
  await owned.advance(5_000);
  const stopped = owned.service.present(job(owned, o.id));
  assert.equal(stopped.automation.state, 'stopped');
  assert.equal(stopped.automation.reasonCode, 'owned_by_other_harness');
  assert.match(stopped.automation.reason, /belongs to claude-desktop/);
  assert.equal(stopped.deliveryStatus, 'failed');
  assert.equal(stopped.canResume, false);
  await owned.advance(HOUR);
  assert.equal(owned.fake.state.submitted.length, 0);
});

test('uncertain delivery pauses the chain; it resumes only after read-only reconciliation, without resending', async () => {
  const h = setup();
  const created = await create(h, { turnLimit: 3 });
  await h.advance(5_000);
  await h.advance(10 * MIN);
  h.fake.state.submitError = new HarnessError('timeout', 'Fake timed out', {}, true);
  await h.finish(1);
  await h.advance(5_000);
  const unconfirmed = h.service.present(job(h, created.id));
  assert.equal(unconfirmed.deliveryStatus, 'unconfirmed');
  assert.equal(unconfirmed.automation.state, 'paused');
  assert.equal(unconfirmed.automation.reasonCode, 'delivery_unconfirmed');
  assert.equal(unconfirmed.canResume, false);
  assert.throws(() => h.service.resumeChain(created.id), /Check delivery/);
  assert.throws(() => h.service.scheduleAgain(created.id), /Confirm/);
  h.fake.state.submitError = null;
  await h.advance(HOUR);
  assert.equal(h.fake.state.submitted.length, 1, 'Never retried automatically');
  // The message did arrive; reconciliation proves it with the persisted key.
  const pending = job(h, created.id);
  h.fake.state.conversations.get('conv').messages.push({ id: pending.deliveryKey, role: 'assistant', createdAt: new Date(start).toISOString() });
  const confirmed = await h.service.reconcile(created.id);
  assert.equal(confirmed.deliveryStatus, 'sent');
  assert.equal(confirmed.automation.reasonCode, 'delivery_confirmed');
  assert.equal(confirmed.automation.sentTurns, 2);
  h.service.resumeChain(created.id);
  assert.equal(job(h, created.id).turn.state, 'running', 'The confirmed turn is tracked before anything else is sent');
  h.fake.state.turn = { state: 'completed', completedAt: new Date(h.now).toISOString() };
  await h.service.pollTurns();
  await h.advance(5_000);
  assert.equal(h.fake.state.submitted.length, 2);
  assert.equal(job(h, created.id).chain.previousTurns, 2);
});

test('restart mid-chain: a running turn is polled, never resent, and the chain continues', async () => {
  const h = setup();
  const created = await create(h, { turnLimit: 3 });
  await h.advance(5_000);
  await h.advance(10 * MIN);
  await h.finish(1);
  await h.advance(5_000);
  assert.equal(h.fake.state.submitted.length, 2);
  const restarted = h.restart();
  await h.advance(HOUR);
  assert.equal(h.fake.state.submitted.length, 2, 'Restart never resends');
  assert.equal(restarted.present(restarted.get(created.id)).automation.progressLabel, 'Turn 2 of 3');
  assert.equal(restarted.activeWork()[0].phase, 'running');
  h.fake.state.turn = { state: 'completed', completedAt: new Date(h.now).toISOString() };
  await restarted.pollTurns();
  await h.advance(5_000);
  assert.equal(h.fake.state.submitted.length, 3);
  // The old completion promise from before the restart cannot complete the new turn.
  h.finishers[1]({ state: 'completed' });
  await settle();
  assert.equal(h.service.get(created.id).turn.state, 'running');
});

test('restart mid-chain: waiting turns keep their check time and interrupted sends are handled by certainty', async () => {
  const h = setup();
  h.fake.state.availability = { state: 'limited', resetsAt: iso(3 * HOUR), source: 'reported' };
  const waiting = await create(h, { continuous: true });
  await h.advance(5_000);
  const restarted = h.restart();
  assert.equal(h.armedTimers().at(-1).date.toISOString(), iso(3 * HOUR + 5_000));
  assert.equal(restarted.activeWork()[0].phase, 'waiting');
  assert.equal(restarted.activeWork()[0].nextCheckAt, iso(3 * HOUR + 5_000));
  assert.equal(h.fake.state.submitted.length, 0);

  // Crash after the send guard was persisted: delivery is uncertain, so the chain pauses.
  const record = { ...h.service.get(waiting.id), status: 'dispatching', dispatchAttemptedAt: iso(10_000) };
  const afterGuard = setup({ jobs: { version: 4, jobs: [record] } });
  afterGuard.service.recover();
  afterGuard.service.schedulePending();
  const paused = afterGuard.service.present(afterGuard.service.get(waiting.id));
  assert.equal(paused.deliveryStatus, 'unconfirmed');
  assert.equal(paused.automation.state, 'paused');
  assert.equal(afterGuard.armedTimers().length, 0);

  // Crash before the guard: nothing was submitted, so the turn is safely checked again.
  const beforeGuard = setup({ jobs: { version: 4, jobs: [{ ...record, dispatchAttemptedAt: null }] } });
  beforeGuard.service.recover();
  beforeGuard.service.schedulePending();
  assert.equal(beforeGuard.service.get(waiting.id).status, 'pending');
  beforeGuard.fake.state.availability = { state: 'available', source: 'reported' };
  await beforeGuard.advance(4 * HOUR);
  assert.equal(beforeGuard.fake.state.submitted.length, 1);

  // A finished turn persisted without its follow-up (crash between writes) is settled at startup.
  const finished = { ...h.service.get(waiting.id), status: 'sent', deliveryCertainty: 'delivered', dispatchedAt: iso(0), turn: { state: 'completed', completedAt: iso(20 * MIN) } };
  const settled = setup({ jobs: { version: 4, jobs: [finished] } });
  settled.service.recover();
  assert.equal(settled.service.get(waiting.id).status, 'pending');
  assert.equal(settled.service.get(waiting.id).chain.previousTurns, 1);
});

test('user activity during a running turn pauses before the next send; our own messages never do', async () => {
  const h = setup();
  const created = await create(h, { continuous: true });
  await h.advance(5_000);
  await h.advance(10 * MIN);
  await h.finish(1);
  await h.advance(5_000);
  assert.equal(h.fake.state.submitted.length, 2, 'The first sent message did not count as user activity');
  await h.advance(5 * MIN);
  h.fake.state.conversations.get('conv').messages.push({ id: 'typed', role: 'user', createdAt: new Date(h.now).toISOString() });
  await h.advance(5 * MIN);
  await h.finish(2);
  await h.advance(5_000);
  const paused = h.service.present(job(h, created.id));
  assert.equal(h.fake.state.submitted.length, 2);
  assert.equal(paused.status, 'pending');
  assert.equal(paused.automation.state, 'paused');
  assert.equal(paused.automation.reasonCode, 'user_activity');
  assert.equal(h.armedTimers().length, 0);
  h.service.resumeChain(created.id);
  await h.advance(5_000);
  assert.equal(h.fake.state.submitted.length, 3, 'Resuming accepts the activity the user already saw');
});

test('an agent waiting for input pauses the chain, and a busy agent is checked again later', async () => {
  const h = setup();
  const created = await create(h, { turnLimit: 5 });
  h.fake.state.conversations.get('conv').busy = true;
  await h.advance(5_000);
  assert.equal(job(h, created.id).status, 'pending');
  assert.match(job(h, created.id).note, /still working/);
  assert.equal(h.fake.state.submitted.length, 0);
  h.fake.state.conversations.get('conv').busy = false;
  h.fake.state.conversations.get('conv').awaitingInput = true;
  await h.advance(MIN);
  const paused = h.service.present(job(h, created.id));
  assert.equal(paused.automation.reasonCode, 'awaiting_input');
  assert.match(paused.automation.reason, /waiting for your input/);
  assert.equal(h.notifications.at(-1)[0], 'Continuation paused');
  h.fake.state.conversations.get('conv').awaitingInput = false;
  h.service.resumeChain(created.id);
  await h.advance(5_000);
  assert.equal(h.fake.state.submitted.length, 1);
});

test('turns that keep finishing within a minute pause the chain as possibly complete', async () => {
  const h = setup();
  const created = await create(h, { continuous: true });
  await h.advance(5_000);
  for (let n = 1; n <= 3; n++) {
    await h.advance(10_000);
    await h.finish(n);
    await h.advance(5_000);
  }
  const paused = h.service.present(job(h, created.id));
  assert.equal(paused.automation.reasonCode, 'no_progress');
  assert.equal(h.fake.state.submitted.length, 3);
});

test('without a completion promise, polling drives the chain; stale outcomes are ignored', async () => {
  const h = setup();
  h.fake.state.completion = null;
  const created = await create(h, { turnLimit: 2 });
  await h.advance(5_000);
  const first = job(h, created.id).messageId;
  h.fake.state.turn = { state: 'running' };
  await h.service.pollTurns();
  assert.equal(job(h, created.id).turn.state, 'running');
  await h.advance(10 * MIN);
  h.fake.state.turn = { state: 'completed', completedAt: new Date(h.now).toISOString() };
  await h.service.pollTurns();
  await h.advance(5_000);
  assert.equal(h.fake.state.submitted.length, 2);
  h.fake.state.turn = { state: 'running' };
  h.service.recordTurn(created.id, { state: 'completed' }, first);
  assert.equal(job(h, created.id).turn.state, 'running', 'An outcome for the previous turn does not complete this one');
  assert.equal(job(h, created.id).chain.state, 'active');
});

test('edits change a chain before it starts; started chains must be stopped instead', async () => {
  const h = setup();
  const created = await create(h, { trigger: 'time', whenISO: iso(HOUR), turnLimit: 2 });
  const edited = h.service.edit(created.id, { message: 'Keep going', whenISO: iso(2 * HOUR), timeZone: 'UTC', trigger: 'time', continuous: true });
  assert.equal(edited.automation.unlimited, true);
  const single = h.service.edit(created.id, { message: 'Keep going', whenISO: iso(2 * HOUR), timeZone: 'UTC', trigger: 'time', turnLimit: 1 });
  assert.equal(single.chain, null);
  assert.throws(() => h.service.edit(created.id, { message: 'x', whenISO: iso(2 * HOUR), timeZone: 'UTC', turnLimit: 0 }), /at least 1/);
  const running = await create(h, { turnLimit: 3 });
  await h.advance(5_000);
  await h.advance(10 * MIN);
  await h.finish(1);
  assert.throws(() => h.service.edit(running.id, { message: 'x', timeZone: 'UTC', trigger: 'available' }), /already started/);
});

test('schedule again keeps the trigger and turn settings of a finished chain', async () => {
  const h = setup();
  const created = await create(h, { turnLimit: 2 });
  h.service.stop(created.id);
  assert.deepEqual(h.service.scheduleAgain(created.id), { harness: 'fake', threadId: 'conv', message: 'Continue', timeZone: 'UTC', trigger: 'available', turnLimit: 2, continuous: false });
});

test('chain records persist in store version 4 and malformed chains are refused, not dropped', async () => {
  const h = setup();
  await create(h, { continuous: true });
  assert.equal(h.stored.version, 4);
  const [restored] = migrateJobs(h.stored);
  assert.equal(restored.chain.limit, null);
  assert.equal(restored.trigger, 'available');
  const legacy = { id: 'job', commandId: 'c', messageId: 'm', threadId: 't', message: 'Continue', scheduleAt: iso(0), status: 'pending', createdAt: iso(-1) };
  assert.equal(migrateJobs([legacy])[0].chain, null);
  assert.equal(migrateJobs([legacy])[0].trigger, 'time');
  assert.throws(() => migrateJobs({ version: 4, jobs: [{ ...legacy, chain: { limit: 0, state: 'active', previousTurns: 0, history: [] } }] }), /invalid records/);
  assert.throws(() => migrateJobs({ version: 4, jobs: [{ ...legacy, trigger: 'soon' }] }), /invalid records/);
});

test('a locked Mac never fails or counts a turn: the chain waits for unlock and retries on unlock', async () => {
  const h = setup();
  const created = await create(h, { turnLimit: 2 });
  h.fake.state.availability = { state: 'unavailable', reason: 'screen_locked', source: 'reported' };
  await h.advance(5_000);
  const locked = h.service.present(job(h, created.id));
  assert.equal(locked.deliveryLabel, 'Waiting for unlock');
  assert.equal(locked.note, 'Waiting for the Mac to be unlocked.');
  assert.equal(Date.parse(locked.nextAttemptAt) - h.now, continuation.LOCKED_RETRY_MS);
  await h.advance(10 * MIN);
  assert.equal(job(h, created.id).availabilityChecks, 0, 'Locked retries do not escalate the backoff');
  // Unlocked, but the send itself hits the lock: certain non-delivery, so it waits instead of failing.
  h.fake.state.availability = { state: 'available', source: 'reported' };
  h.fake.state.submitError = new HarnessError('screen_locked', 'The Mac is locked.', {}, false);
  await h.advance(MIN);
  const waiting = h.service.present(job(h, created.id));
  assert.equal(waiting.status, 'pending');
  assert.equal(waiting.automation.state, 'active');
  assert.equal(waiting.automation.sentTurns, 0);
  assert.equal(waiting.dispatchAttemptedAt, null);
  assert.equal(h.fake.state.submitted.length, 0);
  h.fake.state.submitError = null;
  await h.service.retryAfterUnlock();
  assert.equal(h.fake.state.submitted.length, 1, 'Unlock retries at once');
  assert.equal(job(h, created.id).messageId, created.messageId, 'The undelivered turn keeps its IDs');
});
