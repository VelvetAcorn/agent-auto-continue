'use strict';

const MAX_ENTRIES = 500;
const TEXT_LIMIT = 200;

function text(value) {
  return typeof value === 'string' ? value.replace(/\p{Cc}/gu, ' ').slice(0, TEXT_LIMIT) : undefined;
}

/**
 * A bounded, persisted record of remote actions shown to the desktop user.
 * Mutations, denials and token lifecycle events are recorded; routine reads are not,
 * so a polling phone cannot flush meaningful history out of the log.
 */
class AuditLog {
  constructor({ entries = [], persist = () => {}, now = () => Date.now(), max = MAX_ENTRIES } = {}) {
    this.entries = Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry.at === 'string' && typeof entry.action === 'string').slice(-max) : [];
    Object.assign(this, { persist, now, max });
  }

  record({ action, outcome = 'ok', tokenId, tokenLabel, transport, remoteAddress, target, error }) {
    const entry = Object.fromEntries(Object.entries({
      at: new Date(this.now()).toISOString(), action: text(action), outcome: text(outcome), tokenId: text(tokenId), tokenLabel: text(tokenLabel),
      transport: text(transport), remoteAddress: text(remoteAddress), target: text(target), error: text(error)
    }).filter(([, value]) => value !== undefined));
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    // The audit trail must never turn a completed action into a reported failure.
    try { this.persist(); } catch { /* The in-memory entry remains visible until restart. */ }
    return entry;
  }

  list(limit = 100) {
    return this.entries.slice(-Math.max(0, Math.min(limit, this.max))).reverse();
  }

  clear() {
    const previous = this.entries;
    this.entries = [];
    try { this.persist(); } catch (error) { this.entries = previous; throw error; }
  }

  toJSON() { return this.entries.map((entry) => ({ ...entry })); }
}

module.exports = { AuditLog };
