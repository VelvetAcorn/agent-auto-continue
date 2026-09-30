'use strict';

const crypto = require('node:crypto');
const { RemoteError } = require('./errors');

const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const TTL_MS = 24 * 60 * 60_000;
const MAX_ENTRIES = 1000;

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Remembers which job an idempotency key created, per token, for 24 hours.
 * A phone that retries after a dropped response gets the original job instead of a duplicate.
 */
class IdempotencyStore {
  constructor({ entries = [], persist = () => {}, now = () => Date.now() } = {}) {
    Object.assign(this, { persist, now });
    this.entries = new Map((Array.isArray(entries) ? entries : [])
      .filter((entry) => entry && typeof entry.scope === 'string' && typeof entry.jobId === 'string' && typeof entry.fingerprint === 'string' && Number.isFinite(Date.parse(entry.at)))
      .map((entry) => [entry.scope, entry]));
    this.inFlight = new Map();
  }

  static validateKey(key) {
    if (key === undefined) return undefined;
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) throw new RemoteError(400, 'invalid_idempotency_key', 'Idempotency keys must be 1 to 128 letters, digits, ".", "_", ":" or "-".');
    return key;
  }

  prune() {
    const cutoff = this.now() - TTL_MS;
    for (const [scope, entry] of this.entries) if (Date.parse(entry.at) < cutoff) this.entries.delete(scope);
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value);
  }

  /**
   * Runs create() once per (token, key). Returns { replayed, jobId?, result? }.
   * Concurrent duplicates wait for the first attempt instead of racing it.
   */
  async run({ tokenId, key, request, create }) {
    if (key === undefined) return { replayed: false, result: await create() };
    const scope = `${tokenId}:${key}`;
    const print = fingerprint(request);
    this.prune();
    const existing = this.entries.get(scope);
    if (existing) {
      if (existing.fingerprint !== print) throw new RemoteError(409, 'idempotency_conflict', 'This idempotency key was already used for a different request.');
      return { replayed: true, jobId: existing.jobId };
    }
    if (this.inFlight.has(scope)) {
      const pending = this.inFlight.get(scope);
      if (pending.fingerprint !== print) throw new RemoteError(409, 'idempotency_conflict', 'This idempotency key was already used for a different request.');
      const result = await pending.promise;
      return { replayed: true, jobId: result.id };
    }
    const promise = create();
    this.inFlight.set(scope, { fingerprint: print, promise });
    try {
      const result = await promise;
      this.entries.set(scope, { scope, jobId: result.id, fingerprint: print, at: new Date(this.now()).toISOString() });
      // The job itself is already saved; losing the key only weakens duplicate protection.
      try { this.persist(); } catch { /* The in-memory entry still protects this session. */ }
      return { replayed: false, result };
    } finally {
      this.inFlight.delete(scope);
    }
  }

  forgetToken(tokenId) {
    for (const scope of this.entries.keys()) if (scope.startsWith(`${tokenId}:`)) this.entries.delete(scope);
  }

  toJSON() { return [...this.entries.values()].map((entry) => ({ ...entry })); }
}

module.exports = { IdempotencyStore };
