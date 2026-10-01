'use strict';
// A JobService over one in-memory fake harness whose clock and timers only move when the test
// says so, with persistence captured for restart checks. Shared by the one-off waiting,
// stop phrase and mark-as-not-delivered tests.
const { JobService } = require('../lib/job-service');
const { createHarnessRegistry } = require('../lib/harnesses/registry');
const { createFakeHarness } = require('../tools/fake-harness.cjs');

const MIN = 60_000;
const HOUR = 60 * MIN;
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve)); };

function serviceFixture({ capabilities, jobs = [], conversation = {}, serviceOptions = {}, start = Date.now() + 60_000 } = {}) {
  const fake = createFakeHarness({ capabilities, conversations: [{ id: 'conv', title: 'Refactor', projectName: 'repo', ...conversation }] });
  let clock = start;
  let stored;
  const timers = [], notifications = [], finishers = [], reports = [];
  // Each submitted turn gets its own completion promise, resolved by the test.
  fake.state.completion = () => new Promise((resolve) => finishers.push(resolve));
  const make = (initial) => new JobService({ jobs: initial, harnesses: createHarnessRegistry([fake.adapter]), now: () => clock,
    persist: (value) => { stored = JSON.parse(JSON.stringify(value)); }, notify: (...args) => notifications.push(args), observe: (event) => reports.push(event),
    scheduleTimer: (date, callback) => { const timer = { date, callback, canceled: false, fired: false, cancel() { this.canceled = true; } }; timers.push(timer); return timer; }, ...serviceOptions });
  const h = {
    fake, timers, notifications, finishers, reports, service: make(jobs), start,
    get stored() { return stored; },
    get now() { return clock; },
    iso: (offset = 0) => new Date(clock + offset).toISOString(),
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
    // A new service from what was persisted, as after quitting and relaunching the app.
    restart() { h.service = make(stored); h.service.recover(); h.service.schedulePending(); return h.service; },
    armedTimers: () => timers.filter((timer) => !timer.canceled && !timer.fired),
    get: (id) => h.service.get(id),
    view: (id) => h.service.present(h.service.get(id))
  };
  return h;
}

module.exports = { HOUR, MIN, serviceFixture, settle };
