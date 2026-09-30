'use strict';

// Read-only Codex client over the supported app-server protocol, shared by the
// Codex CLI adapter and the Codex desktop adapter so neither parses Codex's
// private storage. The executable is injectable (the desktop adapter passes the
// app-bundled binary so the protocol version matches the app).
//
// Transport: `auto` uses the shared app-server daemon when its control socket
// accepts a connection (through `codex app-server proxy`), otherwise a private
// `codex app-server` child. Both speak the same JSON-RPC methods. Each call
// uses its own short-lived connection.
const net = require('node:net');
const os = require('node:os');
const { isoOrNull } = require('./contract');
const { HarnessError, redact } = require('./errors');
const { childEnv, firstLine } = require('./process');
const { codexPaths, codexThreadWriter } = require('./codex-locks');
const { startAppServer, toHarnessError } = require('./codex-rpc');
const { matchUsageLimit } = require('./usage-limits');

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Ownership is by the app that created the thread (codex-cli 0.159 values).
// Older desktop-app threads have no originator and source "vscode".
function isDesktopThread(thread) {
  if (!isObject(thread) || thread.parentThreadId || thread.ephemeral) return false;
  return thread.originator === 'Codex Desktop' || ((thread.originator === null || thread.originator === undefined) && thread.source === 'vscode');
}
// 'codex-desktop' | 't3' | 'codex'. T3 Code drives its own Codex process for its threads.
function ownerOfThread(thread) {
  if (isDesktopThread(thread)) return 'codex-desktop';
  if (thread?.originator === 't3code_desktop') return 't3';
  return 'codex';
}

// { reached, resetsAt, usedPercent, reason } from account/rateLimits/read, or null.
function limitFromRateLimits(result, now = Date.now()) {
  const snapshot = isObject(result?.rateLimits) ? result.rateLimits : null;
  if (!snapshot) return null;
  const windows = [snapshot.primary, snapshot.secondary].filter(isObject);
  const exhausted = windows.filter((window) => Number(window.usedPercent) >= 100);
  const reached = typeof snapshot.rateLimitReachedType === 'string' || result.ordinaryUsageAllowed === false || exhausted.length > 0;
  const resets = (exhausted.length ? exhausted : windows).map((window) => isoOrNull(window.resetsAt)).filter((value) => value && Date.parse(value) > now).sort();
  return { reached, resetsAt: reached ? resets.at(-1) || null : null, usedPercent: Math.max(0, ...windows.map((window) => Number(window.usedPercent) || 0)), reason: snapshot.rateLimitReachedType || '' };
}

// Turn outcome from a protocol turn; `limit` (limitFromRateLimits shape) supplies a reset time.
function outcomeFromTurn(turn, limit = null, now = Date.now()) {
  const error = isObject(turn?.error) ? turn.error : null;
  const usage = error && (error.codexErrorInfo === 'usageLimitExceeded' || matchUsageLimit(error.message, now));
  const base = { turnId: turn?.id || null, completedAt: isoOrNull(turn?.completedAt) };
  if (turn?.status === 'completed') return { ...base, state: 'completed' };
  if (turn?.status === 'interrupted') return { ...base, state: 'interrupted' };
  if (turn?.status === 'failed') {
    return { ...base, state: 'failed', error: { code: usage ? 'usage_limited' : 'agent_error', message: usage ? 'Codex reached a usage limit.' : redact(String(error?.message || 'Codex reported an error.')).slice(0, 240) },
      usageLimit: usage ? { resetsAt: limit?.resetsAt || null, message: 'Codex reached a usage limit.' } : null };
  }
  return { ...base, state: 'running' };
}

function daemonAvailable(socketPath, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const done = (value) => { clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function createCodexReader({ executable, env = process.env, home = os.homedir(), now = () => Date.now(), requestTimeoutMs = 30_000, transport = 'auto', detectDaemon, clientVersion = '0' } = {}) {
  const resolveExecutable = () => (typeof executable === 'function' ? executable() : executable);
  async function selectTransport() {
    if (transport !== 'auto') return transport;
    return (await (detectDaemon || daemonAvailable)(codexPaths({ home, env }).controlSocket)) ? 'daemon' : 'private';
  }
  // Opens an initialized client. Callers must close it.
  async function open({ cwd = home, onNotification, onServerRequest, transport: chosen } = {}) {
    const file = resolveExecutable();
    const client = startAppServer({ file, transport: chosen || await selectTransport(), cwd, env: childEnv(env, { executable: file, home }), requestTimeoutMs, onNotification, onServerRequest, clientVersion });
    try { await client.initialize(); } catch (error) {
      await client.close();
      if (error?.code === 'closed' || error?.code === 'handshake') throw new HarnessError('process_failed', client.transport === 'daemon' ? 'Could not connect to the Codex app-server daemon.' : 'Codex could not be started. Check that the Codex CLI works in Terminal.', { transport: client.transport, hint: redact(firstLine(client.stderr)) });
      throw toHarnessError(error);
    }
    return client;
  }
  async function withClient(operation) {
    const client = await open();
    try { return await operation(client); } catch (error) { throw toHarnessError(error); } finally { await client.close(); }
  }
  const shape = (what) => new HarnessError('unsupported_response_shape', `Codex returned an unsupported ${what}. Check that Codex is up to date.`);
  const checkId = (threadId) => { if (!THREAD_ID.test(threadId || '')) throw new HarnessError('conversation_not_found', 'Codex could not find that thread.'); };
  async function readThread(threadId, client) {
    checkId(threadId);
    const run = async (c) => {
      const result = await c.request('thread/read', { threadId, includeTurns: false });
      if (!isObject(result?.thread) || result.thread.id !== threadId) throw shape('thread');
      return result.thread;
    };
    return client ? run(client) : withClient(run);
  }
  // Most recent turns first, each with summary items (userMessage items carry clientId).
  async function recentTurns(threadId, limit = 30, client) {
    checkId(threadId);
    const run = async (c) => {
      const result = await c.request('thread/turns/list', { threadId, limit });
      if (!Array.isArray(result?.data)) throw shape('turn list');
      return result.data.filter(isObject);
    };
    return client ? run(client) : withClient(run);
  }
  async function listThreads({ limit = 100, archived = false } = {}) {
    return withClient(async (client) => {
      const result = await client.request('thread/list', { limit, sortKey: 'updated_at', archived });
      if (!Array.isArray(result?.data)) throw shape('thread list');
      return result.data.filter((thread) => isObject(thread) && THREAD_ID.test(thread.id || ''));
    });
  }
  return {
    selectTransport, open, withClient, readThread, recentTurns, listThreads,
    rawRateLimits: () => withClient((client) => client.request('account/rateLimits/read', null)),
    async rateLimits() { return limitFromRateLimits(await withClient((client) => client.request('account/rateLimits/read', null)), now()); },
    account: () => withClient((client) => client.request('account/read', { refreshToken: false })),
    turnOutcome: (turn, limit) => outcomeFromTurn(turn, limit, now()),
    threadWriter: (threadId, options = {}) => codexThreadWriter(threadId, { home, env, ...options }),
    async close() { /* Every call uses its own short-lived connection. */ }
  };
}

module.exports = { createCodexReader, createReader: createCodexReader, daemonAvailable, isDesktopThread, limitFromRateLimits, outcomeFromTurn, ownerOfThread };
