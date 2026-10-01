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
const { codexPaths, codexThreadWriter, readCodexThreadWriters } = require('./codex-locks');
const { startAppServer, toHarnessError } = require('./codex-rpc');
const { matchUsageLimit } = require('./usage-limits');
const codexDesktopProfile = require('../desktop/profiles/codex-desktop');

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOP_LEVEL_SOURCE_KINDS = Object.freeze(['cli', 'vscode', 'exec', 'appServer', 'unknown']);
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Ownership is by the app that created the thread, from the originator table in
// the Codex desktop profile (codex-cli 0.159 values). Threads without an
// originator fall back to their source; older desktop-app threads have no
// originator and source "vscode".
const OWNERS = Object.entries(codexDesktopProfile.originators);
function originatorOwner(thread) {
  const originator = thread?.originator;
  if (originator === null || originator === undefined) {
    return OWNERS.find(([, rule]) => rule.legacySources.includes(thread?.source))?.[0] || null;
  }
  if (typeof originator !== 'string') return null;
  return OWNERS.find(([, rule]) => rule.exact.includes(originator) || rule.prefixes.some((prefix) => originator.startsWith(prefix)))?.[0] || null;
}
function isDesktopThread(thread) {
  if (!isObject(thread) || thread.parentThreadId || thread.ephemeral) return false;
  return originatorOwner(thread) === 'codex-desktop';
}
// 'codex-desktop' | 't3' | 'codex' | 'other'. T3 Code drives its own Codex process for its threads.
// Only originators known to be the Codex CLI (TUI or exec) are claimed; other
// app-server clients (IDE extensions, future T3 builds) are reported as 'other'.
function ownerOfThread(thread) {
  if (isDesktopThread(thread)) return 'codex-desktop';
  const owner = originatorOwner(thread);
  return owner && owner !== 'codex-desktop' ? owner : 'other';
}

// Originators the desktop app most likely creates its threads with now, but
// that the ownership table does not recognise: an app update renamed it. This
// only explains why threads are missing; such threads stay owned by 'other'.
// An originator counts only with both signals, because the app can also open
// threads another Codex client created (and then holds their lock), and
// another client could ship the same codex build:
//   - the app's own process holds the writer lock of one of its threads
//     (`writers`, from readCodexThreadWriters);
//   - one of its threads was created by the codex binary bundled with the app
//     (`cliVersion`, recorded at creation, equals `appCodexVersion`).
// Returns [{ originator, sources, threads }], newest first; nothing when either
// signal cannot be read.
function unrecognisedDesktopOriginators(threads, { writers, appCodexVersion } = {}) {
  if (!appCodexVersion || !(writers instanceof Map)) return [];
  const groups = new Map();
  for (const thread of Array.isArray(threads) ? threads : []) {
    if (!isObject(thread) || thread.parentThreadId || thread.ephemeral || originatorOwner(thread) !== null) continue;
    const originator = typeof thread.originator === 'string' ? thread.originator : null;
    if (!groups.has(originator)) groups.set(originator, { originator, sources: new Set(), threads: 0, locked: false, built: false, newest: 0 });
    const group = groups.get(originator);
    group.threads += 1;
    group.sources.add(typeof thread.source === 'string' ? thread.source : isObject(thread.source) ? Object.keys(thread.source)[0] || 'unknown' : 'unknown');
    group.newest = Math.max(group.newest, Number(thread.createdAt) || 0);
    if (writers.get(String(thread.id).toLowerCase())?.owner === 'codex-desktop') group.locked = true;
    if (thread.cliVersion === appCodexVersion) group.built = true;
  }
  return [...groups.values()].filter((group) => group.locked && group.built).sort((a, b) => b.newest - a.newest)
    .map(({ originator, sources, threads: count }) => ({ originator, sources: [...sources].sort(), threads: count }));
}

// Turn statuses this version understands (TurnStatus, codex-cli 0.155 to 0.159).
// Busy detection depends on them, so any other value must fail closed.
const TURN_STATUSES = Object.freeze(['completed', 'interrupted', 'failed', 'inProgress']);
const shown = (value) => JSON.stringify(String(value)).slice(0, 42);
// What makes a protocol turn differ from the shape busy detection and delivery
// evidence rely on, or '' when nothing does.
function turnShapeProblem(turn) {
  if (!isObject(turn) || typeof turn.id !== 'string' || !turn.id) return 'a turn without an id';
  if (!TURN_STATUSES.includes(turn.status)) return `turn status ${shown(turn.status)}`;
  if (turn.startedAt !== undefined && turn.startedAt !== null && !Number.isFinite(turn.startedAt)) return 'a turn startedAt that is not a Unix time';
  if (!Array.isArray(turn.items)) return 'a turn without an items list';
  if (turn.items.some((item) => isObject(item) && item.type === 'userMessage' && !Array.isArray(item.content) && typeof item.text !== 'string')) return 'a userMessage item without content';
  return '';
}
// The same for a thread from thread/list or thread/read.
function threadShapeProblem(thread) {
  if (!isObject(thread) || !THREAD_ID.test(typeof thread.id === 'string' ? thread.id : '')) return 'a thread without an id';
  for (const key of ['name', 'originator']) if (thread[key] !== undefined && thread[key] !== null && typeof thread[key] !== 'string') return `a thread ${key} that is not text`;
  if (typeof thread.source !== 'string' && !isObject(thread.source)) return 'a thread without a source';
  if (!isoOrNull(thread.updatedAt)) return 'a thread without updatedAt';
  return '';
}
// The codex version behind an app-server, from its initialize userAgent
// ("<client>/<version> (<os>) ..."), or null.
function serverVersionFrom(info) {
  return /^[^/\s]+\/(\d[\w.+-]*)/.exec(typeof info?.userAgent === 'string' ? info.userAgent : '')?.[1] || null;
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
  let serverInfo = null;
  // Opens an initialized client. Callers must close it.
  async function open({ cwd = home, onNotification, onServerRequest, transport: chosen, threadId } = {}) {
    const file = resolveExecutable();
    const client = startAppServer({ file, transport: chosen || await selectTransport(), cwd, env: childEnv(env, { executable: file, home }), requestTimeoutMs, onNotification, onServerRequest, clientVersion, threadId });
    try { await client.initialize(); } catch (error) {
      await client.close();
      if (error?.code === 'closed' || error?.code === 'handshake') throw new HarnessError('process_failed', client.transport === 'daemon' ? 'Could not connect to the Codex app-server daemon.' : 'Codex could not be started. Check that the Codex CLI works in Terminal.', { transport: client.transport, hint: redact(firstLine(client.stderr)) });
      throw toHarnessError(error);
    }
    serverInfo = client.serverInfo || serverInfo;
    return client;
  }
  async function withClient(operation) {
    const client = await open();
    try { return await operation(client); } catch (error) { throw toHarnessError(error); } finally { await client.close(); }
  }
  // `details` say which request returned what, for app_server drift reports.
  const shape = (what, method) => new HarnessError('unsupported_response_shape', `Codex returned an unsupported ${what}. Check that Codex is up to date.`, { method, what: `an unsupported ${what}` });
  const checkId = (threadId) => { if (!THREAD_ID.test(threadId || '')) throw new HarnessError('conversation_not_found', 'Codex could not find that thread.'); };
  async function readThread(threadId, client) {
    checkId(threadId);
    const run = async (c) => {
      const result = await c.request('thread/read', { threadId, includeTurns: false });
      if (!isObject(result?.thread) || result.thread.id !== threadId) throw shape('thread', 'thread/read');
      return result.thread;
    };
    return client ? run(client) : withClient(run);
  }
  // Most recent turns first, each with summary items (userMessage items carry clientId).
  async function recentTurns(threadId, limit = 30, client) {
    checkId(threadId);
    const run = async (c) => {
      const result = await c.request('thread/turns/list', { threadId, limit });
      if (!Array.isArray(result?.data)) throw shape('turn list', 'thread/turns/list');
      return result.data.filter(isObject);
    };
    return client ? run(client) : withClient(run);
  }
  // Every thread in one archive state, following nextCursor through one
  // connection. Creation order keeps pages stable while threads are updated.
  // thread/list defaults to interactive sources only, which hides `codex exec`
  // threads, so every top-level source kind is requested. `complete` is false
  // when the listing may have been cut short, so callers that must see every
  // thread can refuse instead of guessing.
  async function listAllThreads({ archived = false, sourceKinds = TOP_LEVEL_SOURCE_KINDS, pageSize = 100, maxPages = 100 } = {}) {
    return withClient(async (client) => {
      const threads = [];
      let cursor = null;
      for (let page = 0; page < maxPages; page += 1) {
        const result = await client.request('thread/list', { limit: pageSize, sortKey: 'created_at', archived, sourceKinds, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(result?.data)) throw shape('thread list', 'thread/list');
        threads.push(...result.data.filter((thread) => isObject(thread) && THREAD_ID.test(thread.id || '')));
        const next = result.nextCursor;
        if (next === null || (next === undefined && result.data.length < pageSize)) return { threads, complete: true };
        if (typeof next !== 'string' || !next || next === cursor) return { threads, complete: false };
        cursor = next;
      }
      return { threads, complete: false };
    });
  }
  async function listThreads(options) { return (await listAllThreads(options)).threads; }
  return {
    selectTransport, open, withClient, readThread, recentTurns, listThreads, listAllThreads,
    rawRateLimits: () => withClient((client) => client.request('account/rateLimits/read', null)),
    async rateLimits() { return limitFromRateLimits(await withClient((client) => client.request('account/rateLimits/read', null)), now()); },
    account: () => withClient((client) => client.request('account/read', { refreshToken: false })),
    turnOutcome: (turn, limit) => outcomeFromTurn(turn, limit, now()),
    threadWriter: (threadId, options = {}) => codexThreadWriter(threadId, { home, env, ...options }),
    threadWriters: (options = {}) => readCodexThreadWriters({ home, env, ...options }),
    // The codex version of the most recent connection's server, connecting once if there was none.
    async serverVersion() { return serverVersionFrom(serverInfo || await withClient(async (client) => client.serverInfo)); },
    async close() { /* Every call uses its own short-lived connection. */ }
  };
}

module.exports = { TOP_LEVEL_SOURCE_KINDS, TURN_STATUSES, createCodexReader, createReader: createCodexReader, daemonAvailable, isDesktopThread, limitFromRateLimits, outcomeFromTurn, ownerOfThread, serverVersionFrom, threadShapeProblem, turnShapeProblem, unrecognisedDesktopOriginators };
