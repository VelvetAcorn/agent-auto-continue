'use strict';

// JSON-RPC 2.0 client for the Codex app-server (protocol published by
// `codex app-server generate-json-schema`; verified with codex-cli 0.159).
// Two transports share it:
//   private  `codex app-server`        newline-delimited JSON over stdio
//   daemon   `codex app-server proxy`  raw bytes of the shared daemon's control
//            socket, which speaks WebSocket (HTTP upgrade, then text frames)
const readline = require('node:readline');
const { HarnessError } = require('./errors');
const { afterExitDrain, spawnChild, terminate } = require('./process');
const websocket = require('./websocket');

// The app runs unattended: approvals are answered with the variant that also
// stops the turn, so an unattended turn never continues past a refused action.
function answerServerRequest(method) {
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return { decision: 'cancel' };
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') return { decision: 'abort' };
  if (method === 'mcpServer/elicitation/request') return { action: 'cancel', content: null };
  return undefined;
}
const NEEDS_PERSON = /approval|requestUserInput|elicitation|permissions/i;

class RpcError extends Error {
  constructor(code, message) { super(message); this.name = 'RpcError'; this.code = code; }
}

function startAppServer({ file, transport = 'private', cwd, env, requestTimeoutMs = 30_000, handshakeTimeoutMs = 10_000, onNotification = () => {}, onServerRequest = () => {}, clientVersion = '0', threadId = null }) {
  const daemon = transport === 'daemon';
  const child = spawnChild(file, daemon ? ['app-server', 'proxy'] : ['app-server'], { cwd, env });
  const pending = new Map();
  let nextId = 0, closed = false, stderr = '';
  let spawnError = null;
  child.stderr.setEncoding('utf8').on('data', (chunk) => { if (stderr.length < 16_000) stderr += chunk; });
  child.stdin.on('error', () => { /* The child may exit first. */ });

  function rejectAll(error) {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  }
  const exited = new Promise((resolve) => {
    child.on('error', (error) => { spawnError = error; if (child.pid === undefined) resolve({ code: null, signal: null, error }); });
    child.on('close', (code, signal) => resolve({ code, signal, error: spawnError }));
    afterExitDrain(child, () => resolve({ code: child.exitCode, signal: child.signalCode, error: spawnError }));
  }).then((exit) => { closed = true; rejectAll(new RpcError('closed', 'Codex app-server stopped.')); return exit; });

  let ready;
  let write;
  function receive(message) {
    if (!message || typeof message !== 'object') return;
    if (message.id !== undefined && message.method === undefined) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(Object.assign(new RpcError(message.error.code, String(message.error.message || 'Codex request failed')), { method: request.method }));
      else request.resolve(message.result);
      return;
    }
    if (message.id !== undefined && typeof message.method === 'string') {
      // On the shared daemon other clients may own this request. Answer only for
      // the thread this connection is running; read-only connections never answer.
      // Unanswered requests stay with whichever client can answer them.
      const target = typeof message.params?.threadId === 'string' ? message.params.threadId : null;
      if (!threadId || (target !== null && target !== threadId)) return;
      const result = answerServerRequest(message.method);
      if (NEEDS_PERSON.test(message.method)) { try { onServerRequest(message.method, message.params || {}); } catch { /* Observers must not break the transport. */ } }
      write(result === undefined
        ? { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Agent Auto-Continue runs unattended and cannot answer this request.' } }
        : { jsonrpc: '2.0', id: message.id, result });
      return;
    }
    if (typeof message.method === 'string') { try { onNotification(message.method, message.params || {}); } catch { /* Observers must not break the transport. */ } }
  }
  const parse = (text) => { try { receive(JSON.parse(text)); } catch { /* Ignore foreign output. */ } };

  if (daemon) {
    const { key, text } = websocket.handshakeRequest();
    const decoder = websocket.createDecoder(key);
    let settleHandshake;
    ready = new Promise((resolve, reject) => { settleHandshake = { resolve, reject }; });
    const handshakeTimer = setTimeout(() => settleHandshake.reject(new RpcError('handshake', 'The Codex app-server daemon did not complete its handshake.')), handshakeTimeoutMs);
    handshakeTimer.unref?.();
    void exited.then(() => { clearTimeout(handshakeTimer); settleHandshake.reject(new RpcError('closed', 'Codex app-server stopped.')); });
    write = (value) => { if (!closed && child.stdin.writable) child.stdin.write(websocket.encodeFrame(websocket.OPCODES.text, JSON.stringify(value))); };
    child.stdout.on('data', (chunk) => {
      for (const event of decoder.push(chunk)) {
        if (event.type === 'handshake') { clearTimeout(handshakeTimer); if (event.ok) settleHandshake.resolve(); else settleHandshake.reject(new RpcError('handshake', 'The Codex app-server daemon refused the connection.')); }
        else if (event.type === 'message') parse(event.text);
        else if (event.type === 'ping' && child.stdin.writable) child.stdin.write(websocket.encodeFrame(websocket.OPCODES.pong, event.payload));
        else if (event.type === 'close' || event.type === 'error') { child.stdin.end(); terminate(child, 1000); }
      }
    });
    child.stdin.write(text);
  } else {
    ready = Promise.resolve();
    write = (value) => { if (!closed && child.stdin.writable) child.stdin.write(`${JSON.stringify(value)}\n`); };
    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => { if (line.trim()) parse(line); });
  }

  async function request(method, params, { timeoutMs = requestTimeoutMs } = {}) {
    await ready;
    if (closed) throw new RpcError('closed', 'Codex app-server stopped.');
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new RpcError('timeout', `Codex did not answer ${method} in time.`)); }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer, method });
      write({ jsonrpc: '2.0', id, method, params: params ?? null });
    });
  }
  const client = {
    transport, request, exited, get stderr() { return stderr; }, get pid() { return child.pid; },
    // The server's initialize reply, such as { userAgent }, once initialized.
    serverInfo: null,
    notify(method, params) { write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }); },
    async initialize() {
      const result = await request('initialize', { clientInfo: { name: 'agent-auto-continue', title: 'Agent Auto-Continue', version: clientVersion } });
      client.serverInfo = result && typeof result === 'object' ? result : null;
      client.notify('initialized');
    },
    async close(graceMs = 2000) {
      if (closed) return;
      if (daemon && child.stdin.writable) child.stdin.write(websocket.encodeFrame(websocket.OPCODES.close, Buffer.from([0x03, 0xe8])));
      child.stdin.end();
      const timer = setTimeout(() => terminate(child, 1000), graceMs);
      timer.unref?.();
      await exited;
      clearTimeout(timer);
    }
  };
  return client;
}

// Maps transport failures to structured harness errors.
function toHarnessError(error, { posting = false } = {}) {
  if (error instanceof HarnessError) return error;
  if (error?.code === 'timeout') return new HarnessError('timeout', 'Codex did not respond in time.', {}, posting);
  if (error?.code === 'closed' || error?.code === 'handshake') return new HarnessError('process_failed', error.code === 'handshake' ? 'Could not connect to the Codex app-server daemon.' : 'Codex stopped unexpectedly.', {}, posting);
  const message = String(error?.message || '');
  // "Method not found" names a protocol method, never a thread: it must not cancel jobs as conversation_not_found.
  const missingMethod = error?.code === -32601;
  if (/already has an active writer/i.test(message)) return new HarnessError('conversation_busy', 'Another Codex process is writing to this thread. Close it there, or schedule it with the Codex desktop harness if it is open in the desktop app.');
  if (!missingMethod && /no rollout found|thread not found|not found/i.test(message)) return new HarnessError('conversation_not_found', 'Codex could not find that thread.');
  return new HarnessError('unsupported_response_shape', 'Codex rejected the request. Check that Codex is up to date.', { rpcCode: typeof error?.code === 'number' ? error.code : undefined, method: typeof error?.method === 'string' ? error.method : undefined });
}

module.exports = { NEEDS_PERSON, RpcError, answerServerRequest, startAppServer, toHarnessError };
