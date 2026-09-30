'use strict';

const http = require('node:http');
const { Readable } = require('node:stream');
const { LOOPBACK, classifyAddress, urlHost } = require('./network');
const { RemoteError, errorBody, toRemoteError } = require('./errors');
const { handleApiRequest } = require('./http-api');

const MAX_BODY_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const CORS_HEADERS = 'Authorization, Content-Type, Idempotency-Key, Mcp-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID';
const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
};

function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) { res.destroy(); return; }
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length });
  res.end(payload);
}

function sendError(res, error, headers = {}) {
  const failure = toRemoteError(error);
  const { allow, ...details } = failure.details || {};
  const extra = { ...headers, ...(allow ? { Allow: allow.join(', ') } : {}) };
  sendJson(res, failure.status, errorBody({ code: failure.code, message: failure.message, details: Object.keys(details).length ? details : undefined }), extra);
}

function hostName(value) {
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(value || '');
  return match ? { name: match[1].replace(/^\[|\]$/g, '').toLowerCase(), port: match[2] ? Number(match[2]) : 80 } : null;
}

/**
 * The loopback listener only answers requests addressed to loopback names (DNS rebinding defence).
 * Private-network listeners accept any name that resolves to them, such as a Tailscale MagicDNS name,
 * because every request still needs a bearer token.
 */
function hostAllowed(listener, value) {
  const host = hostName(value);
  if (!host || host.port !== listener.port) return false;
  return listener.address === LOOPBACK ? LOOPBACK_HOSTS.has(host.name) : true;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) { reject(new RemoteError(413, 'payload_too_large', `Request bodies are limited to ${limit} bytes.`)); return; }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { req.pause(); reject(new RemoteError(413, 'payload_too_large', `Request bodies are limited to ${limit} bytes.`)); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Creates the request handler shared by every listener.
 * Order: host, origin, lockout, authentication, per-token rate limit, body limit, routing.
 */
function createRequestHandler({ tokens, failures, requests, audit, operations, mcp, getAllowedOrigins, maxBodyBytes = MAX_BODY_BYTES }) {
  return async function handle(req, res, listener) {
    for (const [name, value] of Object.entries(BASE_HEADERS)) res.setHeader(name, value);
    const remoteAddress = req.socket.remoteAddress || 'unknown';
    try {
      if (!hostAllowed(listener, req.headers.host)) throw new RemoteError(403, 'host_not_allowed', 'This request was addressed to a host name the control API does not serve.');
      const origin = req.headers.origin;
      if (origin !== undefined) {
        if (!getAllowedOrigins().includes(origin)) throw new RemoteError(403, 'origin_not_allowed', 'Browser access from this origin is not allowed.');
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Expose-Headers', 'Idempotent-Replayed, Mcp-Session-Id, Retry-After');
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE', 'Access-Control-Allow-Headers': CORS_HEADERS, 'Access-Control-Max-Age': '600' });
          res.end();
          return;
        }
      }
      const wait = failures.retryAfter(remoteAddress);
      if (wait) throw new RemoteError(429, 'too_many_failures', 'Too many failed authentication attempts. Try again later.', { retryAfterSeconds: wait });
      const match = /^Bearer ([^\s]+)$/.exec(req.headers.authorization || '');
      const token = match ? tokens.authenticate(match[1]) : null;
      if (!token) {
        const lockedOut = failures.fail(remoteAddress);
        audit.record({ action: 'authenticate', outcome: 'denied', transport: listener.address === LOOPBACK ? 'loopback' : 'network', remoteAddress, error: lockedOut ? 'Too many failures; address locked out' : match ? 'Unknown or revoked token' : 'Missing bearer token' });
        res.setHeader('WWW-Authenticate', `Bearer realm="agent-auto-continue"${match ? ', error="invalid_token"' : ''}`);
        throw new RemoteError(401, 'unauthorized', 'A valid device token is required. Create one in the desktop app under Settings, Remote control.');
      }
      const throttled = requests.take(token.id);
      if (throttled) throw new RemoteError(429, 'rate_limited', 'Too many requests from this device. Slow down and try again.', { retryAfterSeconds: throttled });
      const url = new URL(req.url, `http://${urlHost(listener.address)}:${listener.port}`);
      const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req, maxBodyBytes) : Buffer.alloc(0);
      const context = { token, transport: url.pathname === '/mcp' ? 'mcp' : 'http', remoteAddress };
      if (url.pathname === '/mcp') { await forwardMcp({ req, res, url, body, mcp, context }); return; }
      const result = await handleApiRequest({ method: req.method, url, headers: req.headers, body, operations, context });
      sendJson(res, result.status, result.body, result.headers);
    } catch (error) {
      const failure = toRemoteError(error);
      const retry = failure.details?.retryAfterSeconds;
      sendError(res, failure, retry ? { 'Retry-After': String(retry) } : {});
      if (failure.status === 413) res.once('finish', () => req.destroy());
    }
  };
}

async function forwardMcp({ req, res, url, body, mcp, context }) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    // The bearer token has already been verified and is not passed further.
    if (name === 'authorization' || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  const response = await mcp.fetch(new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, signal: controller.signal }), context);
  const outgoing = {};
  response.headers.forEach((value, name) => { outgoing[name] = value; });
  res.writeHead(response.status, outgoing);
  if (!response.body) { res.end(); return; }
  Readable.fromWeb(response.body).on('error', () => res.destroy()).pipe(res);
}

/** Starts one HTTP listener per address and reports each listener's state. */
class ListenerSet {
  constructor({ handle, createServer = http.createServer }) {
    Object.assign(this, { handle, createServer });
    this.listeners = [];
  }

  async start(addresses, port) {
    await this.stop();
    // Validate everything before opening anything, so a bad address never leaves a partial set running.
    for (const address of addresses) {
      if (!classifyAddress(address)) throw new Error(`Refusing to listen on ${address}: only loopback and private-network addresses are allowed.`);
    }
    this.listeners = addresses.map((address) => ({ address, port, listening: false, error: null, errorCode: null, server: null }));
    for (const listener of this.listeners) await this.open(listener);
    return this.status();
  }

  /** Re-attempts listeners that could not start, for example before Tailscale connects. */
  async retryFailed() {
    for (const listener of this.listeners) if (!listener.listening) await this.open(listener);
    return this.status();
  }

  hasFailures() { return this.listeners.some((listener) => !listener.listening); }

  open(listener) {
    const server = this.createServer((req, res) => void this.handle(req, res, listener));
    Object.assign(server, { headersTimeout: 10_000, requestTimeout: 30_000, keepAliveTimeout: 5_000, maxHeadersCount: 64 });
    server.maxConnections = 64;
    return new Promise((resolve) => {
      const onError = (error) => {
        Object.assign(listener, { listening: false, server: null, errorCode: error.code || 'UNKNOWN',
          error: error.code === 'EADDRINUSE' ? `Port ${listener.port} is already in use.` : error.code === 'EADDRNOTAVAIL' ? `${listener.address} is not available on this Mac right now.` : 'The listener could not start.' });
        resolve();
      };
      server.once('error', onError);
      server.listen({ host: listener.address, port: listener.port, exclusive: true }, () => {
        server.off('error', onError);
        Object.assign(listener, { listening: true, server, error: null, errorCode: null });
        resolve();
      });
    });
  }

  status() {
    return this.listeners.map(({ address, port, listening, error, errorCode }) => ({ address, port, listening, error, errorCode, url: `http://${urlHost(address)}:${port}` }));
  }

  async stop() {
    const servers = this.listeners.map((listener) => listener.server).filter(Boolean);
    this.listeners = [];
    await Promise.all(servers.map((server) => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); })));
  }
}

module.exports = { ListenerSet, createRequestHandler, hostAllowed, MAX_BODY_BYTES };
