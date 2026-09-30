'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DISPLAY_BLOCKER, KeepAwakeController, SYSTEM_BLOCKER, WorkSourceRegistry,
  normaliseKeepAwake, parseBatteryStatus, validateKeepAwakeInput
} = require('../lib/keep-awake');

const HOUR = 3_600_000;
const ENABLED = { enabled: true, keepDisplayOn: false, powerSource: 'any', batteryFloorPercent: 20, maxHours: 12, includeRunningAgents: false };

function fakePower({ onBattery = false, percent = null } = {}) {
  const blockers = new Map();
  let next = 0;
  return {
    blockers, onBattery, percent, log: [], batteryReads: 0,
    startBlocker(type) { const id = next++; blockers.set(id, type); this.log.push(['start', type]); return id; },
    stopBlocker(id) { this.log.push(['stop', blockers.get(id)]); return blockers.delete(id); },
    isBlockerStarted(id) { return blockers.has(id); },
    isOnBattery() { return this.onBattery; },
    async readBatteryPercent() { this.batteryReads++; return this.percent; },
    held() { return [...blockers.values()]; }
  };
}

function harness({ settings = ENABLED, tasks = [], power = fakePower(), releaseGraceMs = 120_000 } = {}) {
  let time = Date.parse('2026-10-01T00:00:00Z');
  const timers = [];
  const notifications = [];
  const published = [];
  const source = { id: 'fake', label: 'Fake', list: tasks, refreshes: 0, tasks() { return this.list; }, async refresh() { this.refreshes++; } };
  const registry = new WorkSourceRegistry();
  registry.register(source);
  const controller = new KeepAwakeController({
    power, registry, settings, releaseGraceMs, now: () => time,
    setTimer: (callback, ms) => { const timer = { callback, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: (timer) => { timer.cleared = true; },
    notify: (title, body) => notifications.push({ title, body }),
    onChange: (snapshot) => published.push(snapshot)
  });
  return {
    controller, power, source, registry, timers, notifications, published,
    advance(ms) { time += ms; },
    setTasks(list) { source.list = list; controller.evaluate(); }
  };
}

const waiting = (id = 'job-1') => ({ id, harness: 't3', label: `Thread ${id}`, state: 'waiting', detail: 'Scheduled', until: '2026-10-01T01:00:00.000Z' });
const running = (id = 'job-1') => ({ id, harness: 't3', label: `Thread ${id}`, state: 'running', detail: 'Agent working' });

test('keep-awake is off by default and never takes an assertion without opt-in', () => {
  const { controller, power } = harness({ settings: {}, tasks: [running()] });
  controller.start();
  assert.equal(controller.snapshot().state, 'off');
  assert.equal(controller.snapshot().enabled, false);
  assert.deepEqual(power.log, []);
});

test('waiting work arms a system-only assertion and running work makes the session active', () => {
  const h = harness({ tasks: [waiting()] });
  h.controller.start();
  let snapshot = h.controller.snapshot();
  assert.equal(snapshot.state, 'armed');
  assert.equal(snapshot.holding, 'system');
  assert.deepEqual(h.power.held(), [SYSTEM_BLOCKER]);
  assert.equal(snapshot.deadline, '2026-10-01T12:00:00.000Z');
  assert.match(snapshot.reason, /Waiting for 1 scheduled task/);
  h.setTasks([running(), waiting('job-2')]);
  snapshot = h.controller.snapshot();
  assert.equal(snapshot.state, 'active');
  assert.match(snapshot.reason, /1 task running, 1 waiting/);
  assert.deepEqual(h.power.held(), [SYSTEM_BLOCKER], 'A state change must not stack assertions');
  assert.equal(h.power.log.length, 1);
});

test('switching to display-on starts the new assertion before releasing the old one', () => {
  const h = harness({ tasks: [running()] });
  h.controller.start();
  h.controller.configure({ ...ENABLED, keepDisplayOn: true });
  assert.deepEqual(h.power.log, [['start', SYSTEM_BLOCKER], ['start', DISPLAY_BLOCKER], ['stop', SYSTEM_BLOCKER]]);
  assert.deepEqual(h.power.held(), [DISPLAY_BLOCKER]);
  assert.equal(h.controller.snapshot().holding, 'display');
  h.controller.configure(ENABLED);
  assert.deepEqual(h.power.held(), [SYSTEM_BLOCKER]);
});

test('completion releases after a short grace, and new work during the grace keeps the same assertion', () => {
  const h = harness({ tasks: [running()] });
  h.controller.start();
  h.setTasks([]);
  assert.equal(h.controller.snapshot().state, 'releasing');
  assert.equal(h.controller.snapshot().releaseAt, '2026-10-01T00:02:00.000Z');
  assert.deepEqual(h.power.held(), [SYSTEM_BLOCKER]);
  h.advance(60_000);
  h.setTasks([running('job-2')]);
  assert.equal(h.controller.snapshot().state, 'active');
  assert.equal(h.power.log.length, 1, 'No gap or second assertion while work continues');
  h.setTasks([]);
  h.advance(119_000);
  h.controller.evaluate();
  assert.equal(h.controller.snapshot().state, 'releasing');
  h.advance(1_000);
  h.controller.evaluate();
  const snapshot = h.controller.snapshot();
  assert.equal(snapshot.state, 'off');
  assert.equal(snapshot.holding, null);
  assert.equal(snapshot.lastRelease.reason, 'complete');
  assert.deepEqual(h.power.held(), []);
});

test('disabling releases immediately without a grace period', () => {
  const h = harness({ tasks: [running()] });
  h.controller.start();
  h.controller.configure({ ...ENABLED, enabled: false });
  assert.equal(h.controller.snapshot().state, 'off');
  assert.deepEqual(h.power.held(), []);
  assert.equal(h.controller.snapshot().lastRelease.reason, 'disabled');
});

test('an explicit stop holds for the current work, new work starts a new session, and resume re-arms', () => {
  const h = harness({ tasks: [waiting()] });
  h.controller.start();
  const stopped = h.controller.stop();
  assert.equal(stopped.state, 'ended');
  assert.equal(stopped.ended.reason, 'user-stop');
  assert.deepEqual(h.power.held(), []);
  h.setTasks([running()]);
  assert.equal(h.controller.snapshot().state, 'ended', 'The same task changing state is not new work');
  h.controller.resume();
  assert.equal(h.controller.snapshot().state, 'active');
  assert.deepEqual(h.power.held(), [SYSTEM_BLOCKER]);
  h.controller.stop();
  h.setTasks([running(), waiting('job-2')]);
  assert.equal(h.controller.snapshot().state, 'active');
  assert.equal(h.controller.snapshot().ended, null);
});

test('the maximum duration ends a session and notifies once', () => {
  const h = harness({ settings: { ...ENABLED, maxHours: 2 }, tasks: [running()] });
  h.controller.start();
  h.advance(2 * HOUR - 1);
  h.controller.evaluate();
  assert.equal(h.controller.snapshot().state, 'active');
  h.advance(1);
  h.controller.evaluate();
  h.controller.evaluate();
  const snapshot = h.controller.snapshot();
  assert.equal(snapshot.state, 'ended');
  assert.equal(snapshot.ended.reason, 'max-duration');
  assert.deepEqual(h.power.held(), []);
  assert.equal(h.notifications.length, 1);
  assert.match(h.notifications[0].body, /2-hour limit/);
  h.setTasks([running(), waiting('job-2')]);
  assert.equal(h.controller.snapshot().state, 'active');
  assert.equal(h.controller.snapshot().deadline, new Date(Date.parse('2026-10-01T02:00:00Z') + 2 * HOUR).toISOString());
});

test('changing the time limit applies to the running session', () => {
  const h = harness({ tasks: [running()] });
  h.controller.start();
  h.advance(3 * HOUR);
  h.controller.configure({ ...ENABLED, maxHours: 2 });
  assert.equal(h.controller.snapshot().state, 'ended');
});

test('AC-only mode pauses on battery and resumes on power without ending the session', async () => {
  const power = fakePower();
  const h = harness({ settings: { ...ENABLED, powerSource: 'ac-only' }, tasks: [running()], power });
  h.controller.start();
  const deadline = h.controller.snapshot().deadline;
  power.onBattery = true;
  h.controller.handlePowerSourceChange();
  await h.controller.tick();
  assert.equal(h.controller.snapshot().state, 'paused');
  assert.deepEqual(power.held(), []);
  power.onBattery = false;
  await h.controller.tick();
  assert.equal(h.controller.snapshot().state, 'active');
  assert.equal(h.controller.snapshot().deadline, deadline);
  assert.deepEqual(power.held(), [SYSTEM_BLOCKER]);
});

test('the battery floor ends the session until power returns', async () => {
  const power = fakePower({ onBattery: true, percent: 40 });
  const h = harness({ tasks: [running()], power });
  h.controller.start();
  await h.controller.tick();
  assert.equal(h.controller.snapshot().state, 'active');
  assert.equal(h.controller.snapshot().power.batteryPercent, 40);
  power.percent = 20;
  await h.controller.tick();
  assert.equal(h.controller.snapshot().state, 'ended');
  assert.equal(h.controller.snapshot().ended.reason, 'battery-floor');
  assert.deepEqual(power.held(), []);
  assert.equal(h.notifications.length, 1);
  h.setTasks([running(), running('job-2')]);
  assert.equal(h.controller.snapshot().state, 'ended', 'New work cannot override a low battery');
  power.onBattery = false;
  await h.controller.tick();
  assert.equal(h.controller.snapshot().state, 'active');
  assert.equal(power.batteryReads, 2, 'Battery level is only read while on battery');
});

test('a zero floor or an unreadable battery level never ends the session', async () => {
  const power = fakePower({ onBattery: true, percent: 3 });
  const h = harness({ settings: { ...ENABLED, batteryFloorPercent: 0 }, tasks: [running()], power });
  h.controller.start();
  await h.controller.tick();
  assert.equal(h.controller.snapshot().state, 'active');
  const failing = fakePower({ onBattery: true });
  failing.readBatteryPercent = async () => { throw new Error('pmset unavailable'); };
  const unreadable = harness({ tasks: [running()], power: failing });
  unreadable.controller.start();
  await unreadable.controller.tick();
  assert.equal(unreadable.controller.snapshot().power.batteryPercent, null);
  assert.equal(unreadable.controller.snapshot().state, 'active');
});

test('sleeping anyway is recorded and the session re-evaluates on wake', async () => {
  const h = harness({ tasks: [waiting()] });
  h.controller.start();
  h.controller.handleSuspend();
  h.advance(2 * HOUR);
  h.source.list = [running()];
  await h.controller.handleResume();
  const snapshot = h.controller.snapshot();
  assert.deepEqual(snapshot.lastSleep, { from: '2026-10-01T00:00:00.000Z', to: '2026-10-01T02:00:00.000Z', whileHolding: true });
  assert.equal(snapshot.state, 'active');
  assert.equal(h.source.refreshes, 1, 'Wake refreshes sources before re-evaluating');
});

test('a lost assertion is taken again on the next evaluation', () => {
  const h = harness({ tasks: [running()] });
  h.controller.start();
  h.power.blockers.clear();
  h.controller.evaluate();
  assert.deepEqual(h.power.held(), [SYSTEM_BLOCKER]);
});

test('a power adapter failure is reported rather than thrown', () => {
  const power = fakePower();
  power.startBlocker = () => { throw new Error('denied'); };
  const h = harness({ tasks: [running()], power });
  h.controller.start();
  const snapshot = h.controller.snapshot();
  assert.equal(snapshot.holding, null);
  assert.match(snapshot.errors[0].message, /Could not keep the Mac awake: denied/);
});

test('dispose releases the assertion and stops polling', () => {
  const h = harness({ tasks: [running()] });
  h.controller.start();
  assert.equal(h.timers.at(-1).ms, 60_000);
  h.controller.dispose();
  assert.deepEqual(h.power.held(), []);
  assert.equal(h.timers.at(-1).cleared, true);
  h.controller.evaluate();
  assert.deepEqual(h.power.held(), []);
});

test('ticking is only scheduled while enabled', () => {
  const h = harness({ settings: { ...ENABLED, enabled: false } });
  h.controller.start();
  assert.equal(h.timers.length, 0);
  h.controller.configure(ENABLED);
  assert.equal(h.timers.length, 1);
  h.controller.configure({ ...ENABLED, enabled: false });
  assert.equal(h.timers[0].cleared, true);
});

test('publishing only happens when the snapshot changes', () => {
  const h = harness({ tasks: [running()] });
  h.controller.start();
  const count = h.published.length;
  h.controller.evaluate();
  h.controller.evaluate();
  assert.equal(h.published.length, count);
});

test('the registry validates sources, isolates failures and de-duplicates tasks', () => {
  const registry = new WorkSourceRegistry();
  assert.throws(() => registry.register({ id: '' }), /Invalid work source/);
  let notify;
  const unregister = registry.register({ id: 'a', tasks: () => [running('same'), { id: 'bad', state: 'sleeping', label: 'x' }, running('same')], subscribe: (listener) => { notify = listener; return () => { notify = null; }; } });
  assert.throws(() => registry.register({ id: 'a', tasks: () => [] }), /already registered/);
  registry.register({ id: 'b', tasks: () => { throw new Error('adapter offline'); } });
  const { tasks, errors } = registry.tasks();
  assert.deepEqual(tasks.map((task) => [task.id, task.source]), [['same', 'a']]);
  assert.deepEqual(errors, [{ source: 'b', message: 'adapter offline' }]);
  let changes = 0;
  registry.subscribe(() => changes++);
  notify();
  assert.equal(changes, 1);
  unregister();
  assert.equal(notify, null);
  assert.equal(registry.tasks().tasks.length, 0);
});

test('source change notifications re-evaluate the controller', () => {
  let list = [];
  let notify;
  const power = fakePower();
  const registry = new WorkSourceRegistry();
  registry.register({ id: 'push', tasks: () => list, subscribe: (listener) => { notify = listener; return () => {}; } });
  const controller = new KeepAwakeController({ power, registry, settings: ENABLED, setTimer: () => null, clearTimer: () => {} }).start();
  assert.equal(controller.snapshot().state, 'off');
  list = [running()];
  notify();
  assert.equal(controller.snapshot().state, 'active');
  controller.dispose();
});

test('parseBatteryStatus reads pmset output for laptops, desktops and failures', () => {
  assert.deepEqual(parseBatteryStatus("Now drawing from 'AC Power'\n -InternalBattery-0 (id=34996323)\t100%; charged; 0:00 remaining present: true\n"), { onBattery: false, percent: 100 });
  assert.deepEqual(parseBatteryStatus("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t18%; discharging; 1:02 remaining present: true\n"), { onBattery: true, percent: 18 });
  assert.deepEqual(parseBatteryStatus("Now drawing from 'AC Power'\n"), { onBattery: false, percent: null });
  assert.deepEqual(parseBatteryStatus(undefined), { onBattery: null, percent: null });
});

test('keep-awake settings validation rejects unsafe values', () => {
  assert.deepEqual(validateKeepAwakeInput({ ...ENABLED, batteryFloorPercent: '25', maxHours: '6' }), { ...ENABLED, batteryFloorPercent: 25, maxHours: 6 });
  for (const bad of [null, { ...ENABLED, enabled: 'yes' }, { ...ENABLED, powerSource: 'solar' }, { ...ENABLED, batteryFloorPercent: 96 }, { ...ENABLED, batteryFloorPercent: 1.5 }, { ...ENABLED, maxHours: 0 }, { ...ENABLED, maxHours: 73 }]) {
    assert.throws(() => validateKeepAwakeInput(bad));
  }
  assert.deepEqual(normaliseKeepAwake(null), { ...ENABLED, enabled: false });
});

test('work that drives a user interface keeps the display on and is reported', () => {
  const h = harness({ tasks: [running()] });
  h.controller.start();
  assert.deepEqual(h.power.held(), [SYSTEM_BLOCKER]);
  h.setTasks([running(), { ...running('desktop'), harness: 'desktop-app', requiresUnlockedScreen: true }]);
  assert.deepEqual(h.power.held(), [DISPLAY_BLOCKER]);
  assert.equal(h.controller.snapshot().requiresUnlockedScreen, true);
  h.setTasks([running()]);
  assert.deepEqual(h.power.held(), [SYSTEM_BLOCKER]);
  assert.equal(h.controller.snapshot().requiresUnlockedScreen, false);
});

test('waiting work that starts after the time limit is deferred until it comes within it', () => {
  const later = { ...waiting('far'), until: '2026-10-03T00:00:00.000Z' };
  const h = harness({ settings: { ...ENABLED, maxHours: 12 }, tasks: [later] });
  h.controller.start();
  let snapshot = h.controller.snapshot();
  assert.equal(snapshot.state, 'off');
  assert.deepEqual(snapshot.deferred.map((task) => task.id), ['far']);
  assert.match(snapshot.reason, /1 scheduled task starts after the 12-hour limit/);
  assert.deepEqual(h.power.held(), []);
  h.advance(36 * HOUR);
  h.controller.evaluate();
  snapshot = h.controller.snapshot();
  assert.equal(snapshot.state, 'armed');
  assert.deepEqual(snapshot.deferred, []);
});

test('supplementary tasks are dropped when another task covers the same conversation', () => {
  const registry = new WorkSourceRegistry();
  registry.register({ id: 'jobs', tasks: () => [{ ...running('job:1'), conversation: 't3:a' }] });
  registry.register({ id: 'threads', tasks: () => [
    { ...running('t3:thread:a'), conversation: 't3:a', supplementary: true },
    { ...running('t3:thread:b'), conversation: 't3:b', supplementary: true }
  ] });
  assert.deepEqual(registry.tasks().tasks.map((task) => task.id), ['job:1', 't3:thread:b']);
});

test('an existing session defers later work and never suppresses it at the deadline', () => {
  const later = { ...waiting('later'), until: '2026-10-01T13:00:00.000Z' };
  const h = harness({ tasks: [running(), later] });
  h.controller.start();
  h.advance(11 * HOUR);
  h.controller.evaluate();
  assert.deepEqual(h.controller.snapshot().tasks.map((task) => task.id), ['job-1']);
  assert.deepEqual(h.controller.snapshot().deferred.map((task) => task.id), ['later']);
  h.advance(HOUR);
  h.controller.evaluate();
  assert.equal(h.controller.snapshot().ended.reason, 'max-duration');
  assert.deepEqual([...h.controller.suppression.taskIds], ['job-1']);
  h.advance(HOUR);
  h.setTasks([running(), running('later')]);
  assert.equal(h.controller.snapshot().state, 'active');
  assert.deepEqual(h.power.held(), [SYSTEM_BLOCKER]);
});

test('an explicit stop stays released when clearing the session brings deferred work within the limit', () => {
  const later = { ...waiting('later'), until: '2026-10-01T13:00:00.000Z' };
  const h = harness({ tasks: [running(), later] });
  h.controller.start();
  h.advance(11 * HOUR);
  h.controller.evaluate();
  assert.deepEqual(h.controller.snapshot().deferred.map((task) => task.id), ['later']);
  const stopped = h.controller.stop();
  assert.equal(stopped.state, 'ended');
  assert.equal(stopped.ended.reason, 'user-stop');
  assert.deepEqual(h.power.held(), []);
  h.controller.evaluate();
  assert.equal(h.controller.snapshot().state, 'ended');
  h.setTasks([running(), later, waiting('new')]);
  assert.equal(h.controller.snapshot().state, 'active', 'Genuinely new work still starts a new session');
});

test('an explicit stop covers running work hidden by supplementary de-duplication', () => {
  const h = harness({ tasks: [{ ...waiting('job:pending'), conversation: 't3:a' }] });
  let threads = [{ ...running('t3:thread:a'), conversation: 't3:a', supplementary: true }];
  h.registry.register({ id: 'threads', tasks: () => threads });
  h.controller.start();
  assert.deepEqual(h.controller.snapshot().tasks.map((task) => task.id), ['job:pending']);
  h.controller.stop();
  assert.deepEqual(h.power.held(), []);
  h.setTasks([]);
  assert.deepEqual(h.controller.snapshot().tasks.map((task) => task.id), ['t3:thread:a']);
  assert.equal(h.controller.snapshot().state, 'ended', 'Canceling the job only reveals the same running thread');
  assert.deepEqual(h.power.held(), []);
  threads = [];
  h.controller.evaluate();
  assert.equal(h.controller.snapshot().state, 'off');
});

for (const state of ['running', 'unknown']) {
  test(`deferral preserves supplementary ${state} coverage across sources`, () => {
    const later = { ...waiting('later'), conversation: 't3:a', until: '2026-10-03T00:00:00.000Z' };
    const h = harness({ tasks: [later] });
    h.registry.register({ id: 'threads', tasks: () => [{ ...running('thread:a'), state, conversation: 't3:a', supplementary: true }] });
    h.controller.start();
    assert.equal(h.controller.snapshot().state, 'active');
    assert.deepEqual(h.controller.snapshot().tasks.map((task) => task.id), ['thread:a']);
    assert.deepEqual(h.controller.snapshot().deferred.map((task) => task.id), ['later']);
    assert.deepEqual(h.power.held(), [SYSTEM_BLOCKER]);
    assert.deepEqual(h.registry.tasks().tasks.map((task) => task.id), ['later']);
    h.setTasks([{ ...later, until: '2026-10-01T01:00:00.000Z' }]);
    assert.deepEqual(h.controller.snapshot().tasks.map((task) => task.id), ['later']);
  });
}

test('completion grace cannot extend the session deadline', () => {
  const h = harness({ tasks: [running()], settings: { ...ENABLED, maxHours: 1 } });
  h.controller.start();
  h.advance(HOUR - 60_000);
  h.setTasks([]);
  assert.equal(h.controller.snapshot().state, 'releasing');
  h.advance(60_000);
  h.controller.evaluate();
  assert.equal(h.controller.snapshot().ended.reason, 'max-duration');
  assert.equal(h.controller.snapshot().releaseAt, null);
  assert.deepEqual(h.power.held(), []);
  assert.equal(h.notifications.length, 1);
});

test('AC-only completion grace releases as soon as battery power is observed', async () => {
  const h = harness({ tasks: [running()], settings: { ...ENABLED, powerSource: 'ac-only' } });
  h.controller.start();
  h.setTasks([]);
  assert.equal(h.controller.snapshot().state, 'releasing');
  h.power.onBattery = true;
  await h.controller.tick();
  assert.equal(h.controller.snapshot().state, 'paused');
  assert.equal(h.controller.snapshot().lastRelease.reason, 'on-battery');
  assert.equal(h.controller.snapshot().releaseAt, null);
  assert.deepEqual(h.power.held(), []);
  h.power.onBattery = false;
  await h.controller.tick();
  assert.equal(h.controller.snapshot().state, 'off');
  assert.deepEqual(h.power.held(), []);
});

test('completion grace releases at the battery floor', async () => {
  const power = fakePower({ onBattery: true, percent: 40 });
  const h = harness({ tasks: [running()], power });
  h.controller.start();
  await h.controller.tick();
  h.setTasks([]);
  assert.equal(h.controller.snapshot().state, 'releasing');
  power.percent = 20;
  await h.controller.tick();
  assert.equal(h.controller.snapshot().ended.reason, 'battery-floor');
  assert.equal(h.controller.snapshot().releaseAt, null);
  assert.deepEqual(power.held(), []);
  assert.equal(h.notifications.length, 1);
});
