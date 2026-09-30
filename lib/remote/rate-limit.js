'use strict';

/**
 * Locks out a client address after repeated authentication failures.
 * A separate global budget limits distributed guessing from many addresses.
 */
class FailureLimiter {
  constructor({ limit = 10, globalLimit = 100, windowMs = 10 * 60_000, lockMs = 15 * 60_000, now = () => Date.now() } = {}) {
    Object.assign(this, { limit, globalLimit, windowMs, lockMs, now });
    this.entries = new Map();
  }

  entry(key) {
    const time = this.now();
    let entry = this.entries.get(key);
    if (!entry || (entry.lockedUntil <= time && time - entry.windowStart >= this.windowMs)) {
      entry = { windowStart: time, failures: 0, lockedUntil: 0 };
      this.entries.set(key, entry);
    }
    return entry;
  }

  /** Returns the seconds until the key may try again, or 0 when allowed. */
  retryAfter(key) {
    const time = this.now();
    const wait = Math.max(this.entries.get(key)?.lockedUntil || 0, this.entries.get('*')?.lockedUntil || 0) - time;
    return wait > 0 ? Math.ceil(wait / 1000) : 0;
  }

  /** Records a failure; returns true when this failure started a lockout. */
  fail(key) {
    let locked = false;
    for (const [name, limit] of [[key, this.limit], ['*', this.globalLimit]]) {
      const entry = this.entry(name);
      entry.failures += 1;
      if (entry.failures >= limit && entry.lockedUntil <= this.now()) {
        entry.lockedUntil = this.now() + this.lockMs;
        locked = true;
      }
    }
    this.prune();
    return locked;
  }

  prune() {
    if (this.entries.size < 1000) return;
    const time = this.now();
    for (const [key, entry] of this.entries) if (entry.lockedUntil <= time && time - entry.windowStart >= this.windowMs) this.entries.delete(key);
  }
}

/** A per-token token bucket so a runaway client cannot monopolise the scheduler. */
class RequestLimiter {
  constructor({ perMinute = 240, now = () => Date.now() } = {}) {
    Object.assign(this, { perMinute, now });
    this.buckets = new Map();
  }

  /** Returns 0 when the request may proceed, otherwise the seconds to wait. */
  take(key) {
    const time = this.now();
    const bucket = this.buckets.get(key) || { tokens: this.perMinute, at: time };
    bucket.tokens = Math.min(this.perMinute, bucket.tokens + ((time - bucket.at) / 60_000) * this.perMinute);
    bucket.at = time;
    this.buckets.set(key, bucket);
    if (bucket.tokens >= 1) { bucket.tokens -= 1; return 0; }
    return Math.ceil(((1 - bucket.tokens) / this.perMinute) * 60);
  }

  forget(key) { this.buckets.delete(key); }
}

module.exports = { FailureLimiter, RequestLimiter };
