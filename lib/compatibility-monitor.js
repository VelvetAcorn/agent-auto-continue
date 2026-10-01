'use strict';

// Keeps track of whether each desktop app still matches what its harness
// relies on, so an app update is noticed before a schedule fires.
// It runs adapters' read-only checkCompatibility():
//   - at startup: a quick check of every adapter that has one, and a full check
//     when that harness has scheduled work or its app version differs from the
//     last version that passed;
//   - when a schedule is created for the harness (full);
//   - from tick(), every few minutes while the harness has scheduled work: a
//     quick check, then a full one when the app version changed since the last
//     full check, the version has not passed yet, or the last full check is an
//     hour old;
//   - right after a delivery failed in a way that names a contact point.
// A problem stays until a later check or delivery proves that contact point
// works again, or the app version changes. The last passing version is kept
// per harness. Problems are logged to the diagnostics log and marked on
// upcoming schedules as a risk; nothing is ever canceled because of them.
const { driftMessage } = require('./harnesses/errors');

const FULL_INTERVAL_MS = 3_600_000;
// A version that has not passed yet is fully re-checked at most this often, so
// an app that never shows a conversation is not inspected on every tick.
const RETRY_UNPASSED_MS = 15 * 60_000;
// Contact points a successful send proves.
const PROVEN_BY_DELIVERY = Object.freeze(['app_path', 'deep_link', 'content_match', 'composer_label', 'send_label']);
const ID = /^[a-z][a-z0-9_-]{0,39}$/;

function createCompatibilityMonitor({ harnesses, load = () => null, save = () => {}, diagnostics = null, now = () => Date.now(), hasScheduledWork = () => false,
  onChange = () => {}, onProblem = () => {}, fullIntervalMs = FULL_INTERVAL_MS, retryUnpassedMs = RETRY_UNPASSED_MS } = {}) {
  // harness -> { appVersion, verifiedVersion, checkedAt, lastPassing, problems: Map(contactPoint -> problem), lastFullAt, lastFullVersion }
  const states = new Map();
  const running = new Map();
  const adapters = () => harnesses.list().filter((adapter) => typeof adapter.checkCompatibility === 'function');
  const supported = (id) => typeof id === 'string' && harnesses.has(id) && typeof harnesses.get(id).checkCompatibility === 'function';

  function stateOf(id) {
    if (!states.has(id)) states.set(id, { appVersion: null, verifiedVersion: null, checkedAt: null, lastPassing: null, problems: new Map(), lastFullAt: null, lastFullVersion: null });
    return states.get(id);
  }
  try {
    const stored = load();
    for (const [id, value] of Object.entries(stored?.harnesses || {})) {
      if (!ID.test(id) || !value || typeof value !== 'object') continue;
      const state = stateOf(id);
      state.appVersion = typeof value.appVersion === 'string' ? value.appVersion : null;
      state.verifiedVersion = typeof value.verifiedVersion === 'string' ? value.verifiedVersion : null;
      state.checkedAt = typeof value.checkedAt === 'string' ? value.checkedAt : null;
      if (typeof value.lastPassing?.appVersion === 'string') state.lastPassing = { appVersion: value.lastPassing.appVersion, checkedAt: String(value.lastPassing.checkedAt || '') };
      for (const problem of Array.isArray(value.problems) ? value.problems : []) {
        if (problem && ID.test(problem.contactPoint || '')) state.problems.set(problem.contactPoint, { contactPoint: problem.contactPoint, message: String(problem.message || ''), hint: String(problem.hint || ''), appVersion: problem.appVersion || null, source: problem.source === 'delivery' ? 'delivery' : 'check', since: String(problem.since || '') });
      }
    }
  } catch { /* Unreadable state only means the next checks start fresh. */ }

  function persist() {
    const value = { version: 1, harnesses: {} };
    for (const [id, state] of states) {
      value.harnesses[id] = { appVersion: state.appVersion, verifiedVersion: state.verifiedVersion, checkedAt: state.checkedAt, lastPassing: state.lastPassing, problems: [...state.problems.values()] };
    }
    try { save(value); } catch { /* Compatibility state never blocks scheduling. */ }
  }
  const fingerprint = () => JSON.stringify(snapshot());
  function changed(before) {
    if (fingerprint() === before) return;
    persist();
    try { onChange(); } catch { /* A closed window must not break checks. */ }
  }
  function log(id, problem, extra = {}) {
    const adapter = harnesses.has(id) ? harnesses.get(id) : null;
    try { diagnostics?.record({ source: problem.source, harness: id, app: adapter?.label, appVersion: problem.appVersion, verifiedVersion: stateOf(id).verifiedVersion, contactPoint: problem.contactPoint, hint: problem.hint, ...extra }); } catch { /* Logging is best effort. */ }
  }
  // Problems found for another app version say nothing about this one.
  function forgetOtherVersions(state, appVersion) {
    if (!appVersion) return;
    for (const [point, problem] of state.problems) if (problem.appVersion && problem.appVersion !== appVersion) state.problems.delete(point);
  }
  function addProblem(id, problem) {
    const state = stateOf(id);
    const fresh = !state.problems.has(problem.contactPoint) || state.problems.get(problem.contactPoint).appVersion !== problem.appVersion;
    state.problems.set(problem.contactPoint, { ...problem, since: fresh ? new Date(now()).toISOString() : state.problems.get(problem.contactPoint).since });
    return fresh;
  }

  function apply(id, result) {
    const before = fingerprint();
    const state = stateOf(id);
    Object.assign(state, { appVersion: result.appVersion, verifiedVersion: result.verifiedVersion, checkedAt: result.checkedAt });
    forgetOtherVersions(state, result.appVersion);
    for (const point of result.checked) state.problems.delete(point);
    const added = [];
    for (const item of result.problems) {
      const problem = { contactPoint: item.contactPoint, message: item.message, hint: item.hint, appVersion: result.appVersion, source: 'check' };
      if (addProblem(id, problem)) added.push(problem);
      log(id, problem, { code: 'app_version_unsupported' });
    }
    if (result.depth === 'full') { state.lastFullAt = now(); state.lastFullVersion = result.appVersion; }
    // A version passes once its message box was actually seen and nothing is wrong.
    if (result.appVersion && result.depth === 'full' && result.checked.includes('composer_label') && state.problems.size === 0) state.lastPassing = { appVersion: result.appVersion, checkedAt: result.checkedAt };
    changed(before);
    if (added.length) try { onProblem(id, added); } catch { /* Notification is best effort. */ }
  }

  // Runs one check; concurrent requests for the same harness share it.
  async function check(id, { depth = 'full' } = {}) {
    if (!supported(id)) return null;
    const key = `${id}:${depth}`;
    if (running.has(key)) return running.get(key);
    const task = (async () => {
      let result;
      try { result = await harnesses.get(id).checkCompatibility({ depth }); } catch { return null; }
      if (!result || typeof result !== 'object' || !Array.isArray(result.problems)) return null;
      apply(id, result);
      return result;
    })().finally(() => running.delete(key));
    running.set(key, task);
    return task;
  }
  function fullDue(id, appVersion) {
    const state = stateOf(id);
    if (state.lastFullAt === null) return true;
    if (appVersion && appVersion !== state.lastFullVersion) return true;
    const age = now() - state.lastFullAt;
    if (age >= fullIntervalMs) return true;
    return Boolean(appVersion) && appVersion !== state.lastPassing?.appVersion && age >= retryUnpassedMs;
  }
  async function tick() {
    for (const adapter of adapters()) {
      if (!hasScheduledWork(adapter.id)) continue;
      const quick = await check(adapter.id, { depth: 'quick' });
      if (quick && fullDue(adapter.id, quick.appVersion)) await check(adapter.id, { depth: 'full' });
    }
  }
  async function startup() {
    for (const adapter of adapters()) {
      const quick = await check(adapter.id, { depth: 'quick' });
      const passed = stateOf(adapter.id).lastPassing?.appVersion;
      if (hasScheduledWork(adapter.id) || (quick?.appVersion && passed && quick.appVersion !== passed)) await check(adapter.id, { depth: 'full' });
    }
  }
  // A job outcome from the job service: { harness, jobId, status, error }.
  function observe({ harness, jobId, status, error } = {}) {
    if (!supported(harness)) return;
    const before = fingerprint();
    const state = stateOf(harness);
    const details = error?.details || {};
    if (status === 'sent') {
      for (const point of PROVEN_BY_DELIVERY) state.problems.delete(point);
      changed(before);
      return;
    }
    if (!details.contactPoint) return;
    const problem = { contactPoint: details.contactPoint, hint: String(details.hint || ''), appVersion: details.appVersion || state.appVersion || null, source: 'delivery' };
    log(harness, problem, { code: error.code, jobId });
    if (error.code === 'app_version_unsupported') {
      if (details.verifiedVersion) state.verifiedVersion = details.verifiedVersion;
      forgetOtherVersions(state, problem.appVersion);
      problem.message = driftMessage({ app: harnesses.get(harness).label, appVersion: problem.appVersion, verifiedVersion: details.verifiedVersion || state.verifiedVersion, contactPoint: problem.contactPoint, during: 'check' });
      if (problem.appVersion) state.appVersion = problem.appVersion;
      const fresh = addProblem(harness, problem);
      changed(before);
      if (fresh) try { onProblem(harness, [problem]); } catch { /* Notification is best effort. */ }
    }
    // Look again now, while the cause is fresh; the check itself never changes anything.
    void check(harness, { depth: 'full' });
  }
  function snapshot() {
    return [...states].filter(([id]) => supported(id)).map(([id, state]) => ({
      harness: id, label: harnesses.get(id).label, appVersion: state.appVersion, verifiedVersion: state.verifiedVersion, checkedAt: state.checkedAt,
      lastPassing: state.lastPassing, ok: state.problems.size === 0,
      problems: [...state.problems.values()].map(({ contactPoint, message, hint, source, since, appVersion }) => ({ contactPoint, message, hint, source, since, appVersion }))
    }));
  }
  // Why a scheduled job for this harness may not be sent, or null.
  function riskFor(id) {
    if (!states.has(id) || !supported(id)) return null;
    const state = states.get(id);
    const problems = [...state.problems.values()];
    if (!problems.length) return null;
    return { appVersion: state.appVersion, contactPoints: problems.map((item) => item.contactPoint), message: problems[0].message };
  }
  return { check, tick, startup, observe, snapshot, riskFor, supported };
}

module.exports = { FULL_INTERVAL_MS, PROVEN_BY_DELIVERY, RETRY_UNPASSED_MS, createCompatibilityMonitor };
