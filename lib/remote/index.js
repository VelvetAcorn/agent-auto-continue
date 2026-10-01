'use strict';

const os = require('node:os');
const { AuditLog } = require('./audit');
const { IdempotencyStore } = require('./idempotency');
const { createMcpEndpoint } = require('./mcp');
const { LOOPBACK, classifyAddress, listBindableAddresses } = require('./network');
const { createOperations } = require('./operations');
const { qrDataUrl } = require('./qr');
const { FailureLimiter, RequestLimiter } = require('./rate-limit');
const { ListenerSet, MAX_BODY_BYTES, createRequestHandler } = require('./server');
const { TokenStore } = require('./tokens');

const DEFAULT_PORT = 3799;
const MAX_ORIGINS = 10;
const RETRY_MS = 30_000;

function defaults() {
  return { version: 1, enabled: false, port: DEFAULT_PORT, bindAddress: null, allowedOrigins: [], tokens: [], audit: [], idempotency: [] };
}

function readState(value) {
  if (value === undefined) return defaults();
  const state = { ...defaults(), ...value };
  if (!value || typeof value !== 'object' || value.version !== 1 || typeof state.enabled !== 'boolean' || !Number.isInteger(state.port) ||
    (state.bindAddress !== null && typeof state.bindAddress !== 'string') || !Array.isArray(state.allowedOrigins) || !Array.isArray(state.tokens)) {
    throw new Error('The remote control settings file is invalid. Restore or remove remote-control.json, then restart. Existing data has not been changed.');
  }
  return state;
}

function validateOrigins(value) {
  if (!Array.isArray(value) || value.length > MAX_ORIGINS) throw new Error(`List at most ${MAX_ORIGINS} browser origins.`);
  return value.map((origin) => {
    let parsed;
    try { parsed = new URL(origin); } catch { parsed = null; }
    if (typeof origin !== 'string' || !parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error('Browser origins must look like https://example.com with no path or wildcard.');
    }
    return origin;
  });
}

/**
 * Owns the remote control feature: persisted settings, device tokens, audit log,
 * idempotency keys and the HTTP listeners that serve the REST API and MCP endpoint.
 */
class RemoteControl {
  /**
   * @param {object} options
   * @param {() => unknown} options.load Returns the saved state, or undefined when none exists. Throws if unreadable.
   * @param {(state: object) => void} options.save Persists the state atomically with owner-only permissions.
   * @param {() => import('../job-service').JobService} options.getService
   * @param {() => void} options.ensureStorage
   * @param {() => object|null|undefined} options.getStorageError
   * @param {object} options.harnesses Harness registry, see harnesses.js.
   * @param {{status: () => object}} [options.keepAwake] Optional keep-awake status provider (issue #5).
   * @param {{supported: Function, snapshot: Function}} [options.compatibility] Optional read-only desktop app compatibility provider.
   * @param {{listRuns: Function, stopRun: Function}} [options.automation] Optional continuous-run provider (issue #3).
   * @param {{name: string, version: string}} options.appInfo
   * @param {() => void} [options.onChange]
   */
  constructor({ load, save, getService, ensureStorage, getStorageError, harnesses, keepAwake, compatibility, automation, appInfo, onChange = () => {},
    networkInterfaces = () => os.networkInterfaces(), now = () => Date.now(), createServer, retryMs = RETRY_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { save, onChange, networkInterfaces, now, retryMs, setTimer, clearTimer });
    let state;
    try { state = readState(load()); } catch (error) { this.loadError = error.message; state = defaults(); }
    this.settings = { enabled: state.enabled, port: state.port, bindAddress: state.bindAddress, allowedOrigins: state.allowedOrigins };
    const persist = () => this.persist();
    try {
      this.tokens = new TokenStore({ records: state.tokens, persist, now });
    } catch (error) {
      this.loadError ||= `${error.message} Restore or remove remote-control.json, then restart. Existing data has not been changed.`;
      this.tokens = new TokenStore({ records: [], persist, now });
    }
    this.audit = new AuditLog({ entries: state.audit, persist, now });
    this.idempotency = new IdempotencyStore({ entries: state.idempotency, persist, now });
    this.failures = new FailureLimiter({ now });
    this.requests = new RequestLimiter({ now });
    this.operations = createOperations({ getService, ensureStorage, getStorageError, harnesses, keepAwake, compatibility, automation, appInfo, now, idempotency: this.idempotency, audit: this.audit });
    this.mcp = createMcpEndpoint({ operations: this.operations, appInfo, maxRequestBodySize: MAX_BODY_BYTES });
    this.listeners = new ListenerSet({
      createServer,
      handle: createRequestHandler({ tokens: this.tokens, failures: this.failures, requests: this.requests, audit: this.audit, operations: this.operations, mcp: this.mcp, getAllowedOrigins: () => this.settings.allowedOrigins, now })
    });
  }

  persist() {
    if (this.loadError) throw new Error(this.loadError);
    this.save({ version: 1, ...this.settings, tokens: this.tokens.toJSON(), audit: this.audit.toJSON(), idempotency: this.idempotency.toJSON() });
    try { this.onChange(); } catch { /* A closed window must not fail a saved change. */ }
  }

  addresses() {
    return [LOOPBACK, ...(this.settings.bindAddress ? [this.settings.bindAddress] : [])];
  }

  /** Starts or stops listeners to match the saved settings. */
  async apply() {
    this.clearTimer(this.retryTimer);
    this.retryTimer = undefined;
    if (!this.settings.enabled || this.loadError || this.stopping) { await this.listeners.stop(); return this.listeners.status(); }
    await this.listeners.start(this.addresses(), this.settings.port);
    this.scheduleRetry();
    return this.listeners.status();
  }

  scheduleRetry() {
    if (!this.listeners.hasFailures() || this.retryTimer) return;
    this.retryTimer = this.setTimer(async () => {
      this.retryTimer = undefined;
      const before = JSON.stringify(this.listeners.status());
      await this.listeners.retryFailed();
      if (JSON.stringify(this.listeners.status()) !== before) try { this.onChange(); } catch { /* Status is reread on demand. */ }
      this.scheduleRetry();
    }, this.retryMs);
    this.retryTimer?.unref?.();
  }

  async start() { return this.apply(); }

  /** Closes listeners and the MCP handler once; later calls share the first shutdown (quit may fire twice). */
  stop() {
    this.stopping ||= (async () => {
      this.clearTimer(this.retryTimer);
      this.retryTimer = undefined;
      await this.listeners.stop();
      await this.mcp.close();
    })();
    return this.stopping;
  }

  bindableAddresses() {
    const available = listBindableAddresses(this.networkInterfaces());
    const saved = this.settings.bindAddress;
    if (saved && !available.some((item) => item.address === saved)) {
      available.push({ address: saved, interface: null, kind: classifyAddress(saved), label: `${saved} (not currently available)`, unavailable: true });
    }
    return available;
  }

  /** Validates and saves settings, then restarts listeners. */
  async configure(input) {
    if (this.loadError) throw new Error(this.loadError);
    if (!input || typeof input !== 'object') throw new Error('Invalid remote control settings.');
    const enabled = input.enabled === undefined ? this.settings.enabled : input.enabled;
    const port = input.port === undefined ? this.settings.port : Number(input.port);
    const bindAddress = input.bindAddress === undefined ? this.settings.bindAddress : input.bindAddress || null;
    if (typeof enabled !== 'boolean') throw new Error('Choose whether remote control is on.');
    if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error('Remote control port must be a whole number between 1024 and 65535.');
    if (bindAddress !== null) {
      const kind = classifyAddress(bindAddress);
      // A previously chosen address may be temporarily down (for example, Tailscale disconnected).
      const present = listBindableAddresses(this.networkInterfaces()).some((item) => item.address === bindAddress);
      if (!kind || kind === 'loopback' || (!present && bindAddress !== this.settings.bindAddress)) {
        throw new Error('Choose a Tailscale or private network address currently on this Mac. Public and all-interface addresses are never allowed.');
      }
    }
    const allowedOrigins = input.allowedOrigins === undefined ? this.settings.allowedOrigins : validateOrigins(input.allowedOrigins);
    const previous = this.settings;
    this.settings = { enabled, port, bindAddress, allowedOrigins };
    try { this.persist(); } catch (error) { this.settings = previous; throw error; }
    this.audit.record({ action: 'settings_changed', transport: 'desktop', target: enabled ? `on · ${this.addresses().join(', ')} · port ${port}` : 'off' });
    await this.apply();
    return this.getState();
  }

  createToken(input) {
    if (this.loadError) throw new Error(this.loadError);
    const { token, record } = this.tokens.create(input || {});
    this.audit.record({ action: 'token_created', transport: 'desktop', tokenId: record.id, tokenLabel: record.label, target: record.scope });
    return { token, record, qrDataUrl: qrDataUrl(token), state: this.getState() };
  }

  revokeToken(id) {
    const record = this.tokens.revoke(id);
    this.idempotency.forgetToken(record.id);
    this.requests.forget(record.id);
    this.audit.record({ action: 'token_revoked', transport: 'desktop', tokenId: record.id, tokenLabel: record.label });
    return this.getState();
  }

  clearAudit() {
    this.audit.clear();
    return this.getState();
  }

  /** Public state for the desktop UI. Never includes token digests. */
  getState() {
    const listeners = this.listeners.status();
    return {
      ...this.settings, loadError: this.loadError || null, defaultPort: DEFAULT_PORT,
      running: listeners.some((listener) => listener.listening),
      listeners: listeners.map((listener) => ({ ...listener, apiUrl: `${listener.url}/v1`, mcpUrl: `${listener.url}/mcp` })),
      interfaces: this.bindableAddresses(), tokens: this.tokens.list(), audit: this.audit.list(50)
    };
  }
}

module.exports = { RemoteControl, DEFAULT_PORT, readState };
