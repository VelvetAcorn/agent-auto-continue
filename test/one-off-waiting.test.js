'use strict';
// One-off schedules wait and retry, instead of failing, when the agent is busy, the Mac is
// locked or the harness reports itself unavailable, for at most MAX_ONE_OFF_WAIT_MS.
const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_ONE_OFF_WAIT_MS } = require('../lib/job-service');
const { HarnessError } = require('../lib/harnesses/errors');
const { createActiveWorkSource } = require('../lib/active-work-source');
const { HOUR, MIN, serviceFixture } = require('./service-fixture');

const oneOff = (h, patch = {}) => h.service.create({ harness: 'fake', threadId: 'conv', message: 'Continue', whenISO: h.iso(MIN), timeZone: 'UTC', ...patch });
const conversation = (h) => h.fake.state.conversations.get('conv');
const titles = (h) => h.notifications.map(([title]) => title);
const nextCheckIn = (h, id) => Date.parse(h.get(id).nextAttemptAt) - h.now;

test('the wait limit is a named six-hour constant', () => {
  assert.equal(MAX_ONE_OFF_WAIT_MS, 6 * HOUR);
});

test('a busy agent holds a one-off message with the continuation backoff, then it is sent exactly once when the agent finishes', async () => {
  const h = serviceFixture();
  const created = await oneOff(h);
  assert.equal(created.chain, null, 'A plain one-off schedule');
  conversation(h).busy = true;
  await h.advance(MIN + 5_000);
  const waiting = h.view(created.id);
  assert.deepEqual([waiting.status, waiting.deliveryStatus, waiting.displayStatus, waiting.deliveryLabel, waiting.error], ['pending', 'pending', 'waiting', 'Waiting for the agent to finish', null]);
  assert.equal(waiting.waitingSince, h.iso(0));
  assert.equal(waiting.waiting.nextCheckAt, h.iso(MIN));
  assert.equal(waiting.effectiveAt, h.iso(MIN), 'The list shows the next check');
  assert.match(waiting.note, /^Fake Agent is still working\. Checking again in 1 min\. Gives up at \d{4}-\d\d-\d\d \d\d:\d\d UTC\.$/);
  assert.equal(waiting.availability.reason, 'conversation_busy');
  assert.equal(waiting.canStop, true);
  assert.deepEqual(titles(h), ['Scheduled message waiting']);
  assert.match(h.notifications[0][1], /for up to 6 hours/);
  // Keep-awake sees the wait, with its cause and next check.
  const [work] = h.service.activeWork();
  assert.deepEqual([work.phase, work.nextCheckAt, work.chain], ['waiting', h.iso(MIN), null]);
  const [task] = createActiveWorkSource({ service: h.service }).tasks();
  assert.deepEqual([task.state, task.detail, task.until], ['waiting', 'Waiting for the agent to finish its current turn', h.iso(MIN)]);
  for (const delay of [MIN, 2 * MIN, 5 * MIN]) {
    assert.equal(nextCheckIn(h, created.id), delay);
    await h.advance(delay);
  }
  assert.equal(h.fake.state.submitted.length, 0);
  assert.equal(titles(h).filter((title) => title === 'Scheduled message waiting').length, 1, 'The wait is announced once');
  conversation(h).busy = false;
  await h.advance(10 * MIN);
  const sent = h.view(created.id);
  assert.deepEqual([sent.status, sent.deliveryStatus, sent.availabilityChecks], ['sent', 'sent', 0]);
  assert.equal(h.fake.state.submitted.length, 1);
  assert.equal(titles(h).at(-1), 'Sent to Fake Agent');
  assert.equal(h.service.activeWork()[0].phase, 'running', 'Its turn is now followed');
});

test('a one-off message still refused after six hours fails clearly as not delivered and can be scheduled again', async () => {
  const h = serviceFixture();
  const created = await oneOff(h);
  conversation(h).busy = true;
  await h.advance(MIN + 5_000);
  const since = Date.parse(h.get(created.id).waitingSince);
  for (let guard = 0; guard < 100 && h.get(created.id).status === 'pending'; guard++) await h.advance(Math.max(nextCheckIn(h, created.id), 0));
  const failed = h.view(created.id);
  assert.equal(h.now, since + MAX_ONE_OFF_WAIT_MS, 'The last check is exactly at the limit');
  assert.deepEqual([failed.status, failed.deliveryStatus, failed.deliveryCertainty, failed.error.code], ['failed', 'failed', 'not-delivered', 'conversation_busy']);
  assert.equal(failed.error.message, 'Fake Agent was still working in this session after 6 hours, so the message was not sent. Schedule it again when the session is free.');
  assert.equal(failed.note, failed.error.message);
  assert.deepEqual([failed.error.details.waitedSince, failed.error.details.waitLimitMs], [new Date(since).toISOString(), MAX_ONE_OFF_WAIT_MS]);
  assert.equal(failed.needsAttention, true);
  assert.equal(h.fake.state.submitted.length, 0);
  assert.deepEqual(h.service.activeWork(), [], 'Keep-awake lets go');
  assert.equal(h.armedTimers().length, 0);
  assert.equal(titles(h).at(-1), 'Scheduled message not sent');
  assert.equal(h.reports.at(-1).status, 'failed');
  assert.equal(h.service.scheduleAgain(created.id).threadId, 'conv');
});

test('a locked Mac holds a one-off message, checks every minute, and sends at once on unlock', async () => {
  const h = serviceFixture();
  const created = await oneOff(h);
  h.fake.state.submitError = new HarnessError('screen_locked', 'The Mac is locked.', {}, false);
  await h.advance(MIN + 5_000);
  let waiting = h.view(created.id);
  assert.deepEqual([waiting.status, waiting.deliveryLabel, waiting.dispatchAttemptedAt, waiting.availability.reason], ['pending', 'Waiting for unlock', null, 'screen_locked']);
  assert.equal(nextCheckIn(h, created.id), MIN);
  await h.advance(MIN);
  assert.equal(nextCheckIn(h, created.id), MIN, 'No backoff for a locked screen');
  assert.equal(h.get(created.id).availabilityChecks, 0);
  // The harness now reports the lock before anything is prepared.
  h.fake.state.submitError = null;
  h.fake.state.availability = { state: 'unavailable', resetsAt: null, reason: 'screen_locked', source: 'reported' };
  const prepares = h.fake.state.calls.filter(([name]) => name === 'prepareTurn').length;
  await h.advance(MIN);
  waiting = h.view(created.id);
  assert.equal(waiting.deliveryLabel, 'Waiting for unlock');
  assert.equal(h.fake.state.calls.filter(([name]) => name === 'prepareTurn').length, prepares, 'Nothing is prepared while the harness reports the lock');
  h.fake.state.availability = { state: 'available', resetsAt: null, reason: '', source: 'reported' };
  await h.service.retryAfterUnlock();
  assert.equal(h.get(created.id).status, 'sent');
  assert.equal(h.fake.state.submitted.length, 1);
});

test('an unavailable harness holds a one-off message with backoff; a probe that throws never blocks', async () => {
  const h = serviceFixture();
  const created = await oneOff(h);
  h.fake.state.availability = { state: 'unavailable', resetsAt: null, reason: 'App not running', source: 'reported' };
  await h.advance(MIN + 5_000);
  const waiting = h.view(created.id);
  assert.deepEqual([waiting.displayStatus, waiting.deliveryLabel], ['waiting', 'Waiting for availability']);
  assert.match(waiting.note, /^The agent is unavailable\. Checking again in 1 minute\. Gives up at/);
  assert.equal(nextCheckIn(h, created.id), MIN);
  await h.advance(MIN);
  assert.equal(nextCheckIn(h, created.id), 2 * MIN);
  assert.equal(h.fake.state.calls.filter(([name]) => name === 'prepareTurn').length, 0);
  h.fake.state.availabilityError = new Error('Store unreadable');
  await h.advance(2 * MIN);
  assert.equal(h.get(created.id).status, 'sent', 'An unreadable availability is unknown and does not block');
});

test('a harness that stays unavailable fails the message after six hours with harness_unavailable', async () => {
  const h = serviceFixture();
  const created = await oneOff(h);
  h.fake.state.availability = { state: 'unavailable', resetsAt: null, reason: 'App not running', source: 'reported' };
  await h.advance(MIN + 5_000);
  for (let guard = 0; guard < 100 && h.get(created.id).status === 'pending'; guard++) await h.advance(Math.max(nextCheckIn(h, created.id), 0));
  const failed = h.get(created.id);
  assert.deepEqual([failed.status, failed.error.code], ['failed', 'harness_unavailable']);
  assert.equal(failed.error.message, 'Fake Agent stayed unavailable for 6 hours, so the message was not sent. Schedule it again when the session is free.');
});

test('awaiting input is never retried: a one-off message fails at once, from the inspection or from the harness', async () => {
  for (const how of ['inspection', 'prepare', 'submit']) {
    const h = serviceFixture();
    const created = await oneOff(h);
    if (how === 'inspection') conversation(h).awaitingInput = true;
    else h.fake.state[`${how}Error`] = new HarnessError('awaiting_input', 'The agent is waiting for your answer.');
    await h.advance(MIN + 5_000);
    const failed = h.view(created.id);
    assert.deepEqual([failed.status, failed.deliveryCertainty, failed.error.code], ['failed', 'not-delivered', 'awaiting_input'], how);
    assert.equal(failed.waitingSince, null, how);
    assert.equal(h.fake.state.submitted.length, 0, how);
    assert.equal(h.armedTimers().length, 0, how);
  }
});

test('new user activity while a one-off message waits still cancels it', async () => {
  const h = serviceFixture();
  const created = await oneOff(h);
  conversation(h).busy = true;
  await h.advance(MIN + 5_000);
  conversation(h).messages.push({ id: 'typed', role: 'user', createdAt: h.iso(0) });
  await h.advance(MIN);
  const canceled = h.view(created.id);
  assert.deepEqual([canceled.status, canceled.note], ['canceled', 'New user activity appeared after this schedule was created']);
  assert.equal(h.fake.state.submitted.length, 0);
});

test('the six-hour limit counts from the first refusal and survives a change of cause and a restart', async () => {
  const h = serviceFixture();
  const created = await oneOff(h);
  conversation(h).busy = true;
  await h.advance(MIN + 5_000);
  const since = h.get(created.id).waitingSince;
  const deadlineNote = /Gives up at (.+ UTC)\./.exec(h.get(created.id).note)[1];
  // Busy, then locked, then busy again: one wait.
  conversation(h).busy = false;
  h.fake.state.submitError = new HarnessError('screen_locked', 'The Mac is locked.', {}, false);
  await h.advance(MIN);
  assert.equal(h.view(created.id).deliveryLabel, 'Waiting for unlock');
  h.fake.state.submitError = null;
  conversation(h).busy = true;
  await h.advance(MIN);
  assert.equal(h.get(created.id).waitingSince, since);
  // Quit and relaunch while waiting: nothing is sent at launch, the next check stays armed, and the limit is unchanged.
  const before = h.get(created.id);
  const restarted = h.restart();
  const after = restarted.get(created.id);
  assert.deepEqual([after.status, after.waitingSince, after.nextAttemptAt], ['pending', since, before.nextAttemptAt]);
  assert.equal(/Gives up at (.+ UTC)\./.exec(after.note)[1], deadlineNote);
  assert.equal(h.armedTimers().at(-1).date.toISOString(), before.nextAttemptAt);
  assert.equal(h.service.present(after).displayStatus, 'waiting');
  for (let guard = 0; guard < 100 && h.get(created.id).status === 'pending'; guard++) await h.advance(Math.max(nextCheckIn(h, created.id), 0));
  assert.equal(h.get(created.id).status, 'failed');
  assert.equal(h.now, Date.parse(since) + MAX_ONE_OFF_WAIT_MS);
});

test('a check interrupted by quitting returns the waiting message to pending, keeping its wait', async () => {
  const h = serviceFixture();
  const created = await oneOff(h);
  conversation(h).busy = true;
  await h.advance(MIN + 5_000);
  const since = h.get(created.id).waitingSince;
  // The app quit while the next check was reading the conversation, before anything was submitted.
  h.service.patch(h.get(created.id), { status: 'dispatching' });
  const restarted = h.restart();
  assert.deepEqual([restarted.get(created.id).status, restarted.get(created.id).deliveryCertainty, restarted.get(created.id).waitingSince], ['pending', 'not-delivered', since]);
  conversation(h).busy = false;
  await h.advance(MIN);
  assert.equal(h.get(created.id).status, 'sent');
  assert.equal(h.fake.state.submitted.length, 1);
});

test('waking after the limit sends a message whose agent is free, and fails one that is still blocked', async () => {
  for (const [busy, expected] of [[false, 'sent'], [true, 'failed']]) {
    const h = serviceFixture();
    const created = await oneOff(h);
    conversation(h).busy = true;
    await h.advance(MIN + 5_000);
    // Asleep for eight hours: no timer fires until the wake handler runs.
    h.timers.forEach((timer) => { timer.fired = true; });
    await h.advance(8 * HOUR);
    conversation(h).busy = busy;
    await h.service.resume();
    assert.equal(h.get(created.id).status, expected);
  }
});

test('editing a waiting one-off message starts it afresh, and cancelling it clears its check', async () => {
  const h = serviceFixture();
  const created = await oneOff(h);
  conversation(h).busy = true;
  await h.advance(MIN + 5_000);
  const edited = h.service.edit(created.id, { message: 'Keep going', whenISO: h.iso(10 * MIN), timeZone: 'UTC' });
  assert.deepEqual([edited.displayStatus, edited.waitingSince, edited.nextAttemptAt, edited.availability, edited.effectiveAt], ['pending', null, null, null, h.iso(10 * MIN + 5_000)]);
  await h.advance(10 * MIN + 5_000);
  assert.equal(h.view(created.id).displayStatus, 'waiting');
  const canceled = h.service.cancel(created.id);
  assert.equal(canceled.status, 'canceled');
  assert.equal(h.armedTimers().length, 0);
  await h.advance(HOUR);
  assert.equal(h.fake.state.submitted.length, 0);
});

test('continuations keep waiting for a busy agent without the one-off limit', async () => {
  const h = serviceFixture();
  const created = await h.service.create({ harness: 'fake', threadId: 'conv', message: 'Continue', timeZone: 'UTC', trigger: 'available', turnLimit: 3 });
  conversation(h).busy = true;
  await h.advance(5_000);
  for (let elapsed = 0; elapsed < 8 * HOUR; elapsed += 15 * MIN) await h.advance(15 * MIN);
  const waiting = h.view(created.id);
  assert.deepEqual([waiting.status, waiting.displayStatus, waiting.automation.state, waiting.waitingSince], ['pending', 'waiting', 'active', null]);
  assert.doesNotMatch(waiting.note, /Gives up/);
  conversation(h).busy = false;
  await h.advance(15 * MIN);
  assert.equal(h.fake.state.submitted.length, 1);
});
