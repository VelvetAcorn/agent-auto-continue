'use strict';

const crypto = require('node:crypto');

const TOKEN_PREFIX = 'aac_';
const TOKEN_PATTERN = /^aac_[A-Za-z0-9_-]{43}$/;
const SCOPES = new Set(['control', 'read']);
const MAX_TOKENS = 50;
const MAX_LABEL_LENGTH = 60;
// Persisting every successful request would write to disk on each phone poll.
const LAST_USED_PERSIST_INTERVAL_MS = 60_000;

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest();
}

function validateLabel(value) {
  const label = typeof value === 'string' ? value.trim() : '';
  // Labels are shown in the UI and audit log; control characters are never useful there.
  if (!label || label.length > MAX_LABEL_LENGTH || /\p{Cc}/u.test(label)) throw new Error(`Name the device in 1 to ${MAX_LABEL_LENGTH} characters.`);
  return label;
}

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && typeof value.id === 'string' && typeof value.label === 'string' &&
    typeof value.hash === 'string' && /^[0-9a-f]{64}$/.test(value.hash) && SCOPES.has(value.scope) && typeof value.createdAt === 'string');
}

/**
 * Bearer tokens for the remote control API.
 * Only SHA-256 digests are stored; the plaintext is returned once at creation.
 * Tokens carry 256 bits of randomness, so a fast digest is appropriate (no password stretching needed).
 */
class TokenStore {
  constructor({ records = [], persist = () => {}, now = () => Date.now(), randomBytes = crypto.randomBytes } = {}) {
    if (!Array.isArray(records) || !records.every(isRecord)) throw new Error('The remote control token list is invalid.');
    this.records = records.map((record) => ({ ...record, lastUsedAt: record.lastUsedAt || null }));
    Object.assign(this, { persist, now, randomBytes });
    this.lastPersisted = new Map();
  }

  timestamp() { return new Date(this.now()).toISOString(); }

  static publicRecord(record) {
    const { hash: _hash, ...visible } = record;
    return visible;
  }

  list() {
    return this.records.map(TokenStore.publicRecord).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }

  create({ label, scope = 'control' } = {}) {
    const name = validateLabel(label);
    if (!SCOPES.has(scope)) throw new Error('Choose full control or read only access.');
    if (this.records.length >= MAX_TOKENS) throw new Error(`Revoke an unused device before creating more than ${MAX_TOKENS} tokens.`);
    const token = TOKEN_PREFIX + this.randomBytes(32).toString('base64url');
    const record = {
      id: this.randomBytes(9).toString('base64url'), label: name, scope,
      hash: hashToken(token).toString('hex'), hint: token.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + 4),
      createdAt: this.timestamp(), lastUsedAt: null
    };
    this.records.push(record);
    try { this.persist(); } catch (error) { this.records.pop(); throw error; }
    return { token, record: TokenStore.publicRecord(record) };
  }

  revoke(id) {
    const index = this.records.findIndex((record) => record.id === id);
    if (typeof id !== 'string' || index < 0) throw new Error('That device token was not found.');
    const [removed] = this.records.splice(index, 1);
    try { this.persist(); } catch (error) { this.records.splice(index, 0, removed); throw error; }
    this.lastPersisted.delete(id);
    return TokenStore.publicRecord(removed);
  }

  /** Returns the matching token record, or null. Every stored digest is compared so timing does not reveal which failed. */
  authenticate(presented) {
    if (typeof presented !== 'string' || !TOKEN_PATTERN.test(presented)) return null;
    const digest = hashToken(presented);
    let match = null;
    for (const record of this.records) {
      if (crypto.timingSafeEqual(Buffer.from(record.hash, 'hex'), digest)) match = record;
    }
    if (!match) return null;
    match.lastUsedAt = this.timestamp();
    const previous = this.lastPersisted.get(match.id) || 0;
    if (this.now() - previous >= LAST_USED_PERSIST_INTERVAL_MS) {
      this.lastPersisted.set(match.id, this.now());
      // Usage time is informational; a failed write must not reject an authenticated request.
      try { this.persist(); } catch { /* Retried on the next interval. */ }
    }
    return TokenStore.publicRecord(match);
  }

  toJSON() { return this.records.map((record) => ({ ...record })); }
}

module.exports = { TokenStore, TOKEN_PATTERN, hashToken, validateLabel };
