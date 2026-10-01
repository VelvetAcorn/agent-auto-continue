'use strict';

const crypto = require('node:crypto');
const { RemoteError } = require('./errors');

const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const TTL_MS = 24 * 60 * 60_000;
const MAX_PER_TOKEN = 1000;
const MAX_TOTAL = 5000;

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validEntry(entry) {
  return Boolean(entry && typeof entry.scope === 'string' && typeof entry.tokenId === 'string' && typeof entry.fingerprint === 'string' &&
    Number.isFinite(Date.parse(entry.at)) && (typeof entry.jobId === 'string' || (entry.pending && typeof entry.pending === 'object')));
}

/**
 * Remembers which job an idempotency key created, per token, for 24 hours.
 * A phone that retries after a dropped response gets the original job instead of a duplicate.
 *
 * The key is reserved durably before the job is created, so a failed write refuses the
 * request instead of risking a duplicate, and a reservation left by a crash is reconciled
 * against the saved jobs on the next retry. Unexpired keys are never evicted; at capacity,
 * new keyed requests are refused before anything is created.
 */
class IdempotencyStore {
  constructor({ entries = [], persist = () => {}, now = () => Date.now() } = {}) {
    Object.assign(this, { persist, now });
    this.entries = new Map((Array.isArray(entries) ? entries : []).filter(validEntry).map((entry) => [entry.scope, { ...entry }]));
    this.inFlight = new Map();
  }

  static validateKey(key) {
    if (key === undefined) return undefined;
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) throw new RemoteError(400, 'invalid_idempotency_key', 'Idempotency keys must be 1 to 128 letters, digits, ".", "_", ":" or "-".');
    return key;
  }

  pruneExpired() {
    const cutoff = this.now() - TTL_MS;
    for (const [scope, entry] of this.entries) if (Date.parse(entry.at) < cutoff) this.entries.delete(scope);
  }

  save(onFailure) {
    try { this.persist(); return true; } catch (error) { onFailure?.(error); return false; }
  }

  reserve(scope, tokenId, print, pending) {
    const forToken = [...this.entries.values()].filter((entry) => entry.tokenId === tokenId).length;
    if (forToken >= MAX_PER_TOKEN || this.entries.size >= MAX_TOTAL) {
      throw new RemoteError(429, 'idempotency_capacity', 'Too many idempotency keys are still active. Retry later or send the request without a key.');
    }
    const entry = { scope, tokenId, fingerprint: print, at: new Date(this.now()).toISOString(), pending };
    this.entries.set(scope, entry);
    this.save(() => {
      this.entries.delete(scope);
      throw new RemoteError(503, 'storage_unavailable', 'The retry key could not be saved, so nothing was scheduled. Check disk space on the Mac and try again.');
    });
    return entry;
  }

  /**
   * Runs create() at most once per (token, key). Returns { replayed, jobId?, result? }.
   * @param {object} options
   * @param {string} options.tokenId
   * @param {string|undefined} options.key
   * @param {unknown} options.request The caller's request, fingerprinted to detect key reuse.
   * @param {object} options.pending Durable description of the job about to be created, used to find it after a crash.
   * @param {(pending: object, since: string) => string[]} options.locate Returns IDs of saved jobs matching a reservation.
   * @param {() => Promise<{id: string}>} options.create
   */
  async run({ tokenId, key, request, pending, locate, create }) {
    if (key === undefined) return { replayed: false, result: await create() };
    const scope = `${tokenId}:${key}`;
    const print = fingerprint(request);
    this.pruneExpired();
    const inFlight = this.inFlight.get(scope);
    if (inFlight) {
      if (inFlight.fingerprint !== print) throw new RemoteError(409, 'idempotency_conflict', 'This idempotency key was already used for a different request.');
      return { replayed: true, jobId: (await inFlight.promise).id };
    }
    let entry = this.entries.get(scope);
    if (entry && entry.fingerprint !== print) throw new RemoteError(409, 'idempotency_conflict', 'This idempotency key was already used for a different request.');
    if (entry?.jobId) return { replayed: true, jobId: entry.jobId };
    if (entry) {
      // A reservation without a job ID means an earlier attempt stopped between saving the key and the job.
      const matches = locate(entry.pending, entry.at);
      if (matches.length === 1) {
        Object.assign(entry, { jobId: matches[0], pending: undefined });
        this.save();
        return { replayed: true, jobId: matches[0] };
      }
      if (matches.length > 1) throw new RemoteError(409, 'idempotency_indeterminate', 'An earlier attempt with this key may have created a schedule, but it cannot be identified. Check list_jobs before retrying with a new key.');
      // No job was saved, so creating it now cannot duplicate anything.
      entry.pending = pending;
    } else {
      entry = this.reserve(scope, tokenId, print, pending);
    }
    const promise = create();
    this.inFlight.set(scope, { fingerprint: print, promise });
    try {
      const result = await promise;
      Object.assign(entry, { jobId: result.id, pending: undefined });
      // If this write fails, the saved reservation still lets a retry find the job.
      this.save();
      return { replayed: false, result };
    } catch (error) {
      this.entries.delete(scope);
      this.save();
      throw error;
    } finally {
      this.inFlight.delete(scope);
    }
  }

  forgetToken(tokenId) {
    for (const [scope, entry] of this.entries) if (entry.tokenId === tokenId) this.entries.delete(scope);
  }

  toJSON() {
    return [...this.entries.values()].map((entry) => Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)));
  }
}

module.exports = { IdempotencyStore, MAX_PER_TOKEN, MAX_TOTAL };
