'use strict';

// A small, bounded, persistent log of app-compatibility events, kept for bug
// reports. Entries hold only timestamps, harness IDs, app versions, contact
// points, error codes and redacted hints: never message text, conversation
// titles or credentials. Storage is injected so the main process can use its
// atomic JSON writer and tests can use memory.
const { redact } = require('./harnesses/errors');

const MAX_ENTRIES = 200;
const SOURCES = new Set(['delivery', 'check']);
const ID = /^[a-z][a-z0-9_-]{0,39}$/;

const short = (value, limit) => (value === null || value === undefined || value === '' ? null : redact(String(value)).slice(0, limit));
function clean(entry, now) {
  return {
    at: typeof entry.at === 'string' && Number.isFinite(Date.parse(entry.at)) ? entry.at : new Date(now()).toISOString(),
    lastSeenAt: typeof entry.lastSeenAt === 'string' && Number.isFinite(Date.parse(entry.lastSeenAt)) ? entry.lastSeenAt : null,
    count: Number.isInteger(entry.count) && entry.count > 0 ? entry.count : 1,
    source: SOURCES.has(entry.source) ? entry.source : 'check',
    harness: ID.test(entry.harness || '') ? entry.harness : 'unknown',
    app: short(entry.app, 60), appVersion: short(entry.appVersion, 40), verifiedVersion: short(entry.verifiedVersion, 40),
    contactPoint: ID.test(entry.contactPoint || '') ? entry.contactPoint : 'unknown',
    code: ID.test(entry.code || '') ? entry.code : null,
    jobId: typeof entry.jobId === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(entry.jobId) ? entry.jobId : null,
    hint: short(entry.hint, 300) || ''
  };
}
const sameEvent = (a, b) => ['source', 'harness', 'appVersion', 'contactPoint', 'code', 'hint'].every((key) => a[key] === b[key]) && !a.jobId && !b.jobId;

function createDiagnosticsLog({ load = () => null, save = () => {}, now = () => Date.now(), limit = MAX_ENTRIES } = {}) {
  let entries = [];
  try {
    const stored = load();
    entries = (Array.isArray(stored?.entries) ? stored.entries : []).filter((item) => item && typeof item === 'object').map((item) => clean(item, now)).slice(-limit);
  } catch { entries = []; /* An unreadable log only loses history; it is rewritten on the next entry. */ }
  function persist() {
    try { save({ version: 1, entries }); } catch { /* Diagnostics never block scheduling. */ }
  }
  return {
    // Adds one entry. A check that keeps finding the same problem updates the
    // previous entry's count instead of filling the log.
    record(entry) {
      const value = clean({ ...entry, at: undefined, lastSeenAt: undefined, count: undefined }, now);
      const previous = entries.at(-1);
      if (previous && sameEvent(previous, value)) {
        previous.count += 1;
        previous.lastSeenAt = value.at;
      } else {
        entries.push(value);
        entries = entries.slice(-limit);
      }
      persist();
      return value;
    },
    list() { return entries.map((item) => ({ ...item })); },
    // Plain text for a bug report: environment, current harness states and the newest entries first.
    report({ appName = 'Agent Auto-Continue', appVersion = '', platform = '', states = [] } = {}) {
      const line = (item) => [item.lastSeenAt ? `${item.at} to ${item.lastSeenAt} (${item.count}x)` : item.at, item.source, item.harness,
        `${item.app || ''} ${item.appVersion || 'unknown version'}`.trim(), item.verifiedVersion ? `(verified ${item.verifiedVersion})` : '', item.contactPoint, item.code || '', item.hint ? `- ${item.hint}` : '']
        .filter(Boolean).join(' ');
      const state = (item) => {
        const problems = item.problems.map((problem) => `${problem.contactPoint} (${problem.source})`).join(', ') || 'none';
        return `- ${item.harness}: ${item.label} ${item.appVersion || 'unknown version'}, verified ${item.verifiedVersion || 'unknown'}, last passed ${item.lastPassing?.appVersion || 'never'}, last checked ${item.checkedAt || 'never'}, problems: ${problems}`;
      };
      return [
        `${appName} diagnostics`,
        `Version: ${appVersion || 'unknown'}${platform ? ` on ${platform}` : ''}`,
        `Generated: ${new Date(now()).toISOString()}`,
        '', 'Desktop app compatibility:', ...(states.length ? states.map(state) : ['- no desktop app has been checked']),
        '', `Recent events (newest first, ${entries.length} kept):`, ...(entries.length ? [...entries].reverse().map(line) : ['- none'])
      ].join('\n');
    }
  };
}

module.exports = { MAX_ENTRIES, createDiagnosticsLog };
