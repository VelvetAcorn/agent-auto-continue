'use strict';

// Minimal JSON-RPC 2.0 client for `codex app-server` over stdio
// (newline-delimited JSON). The protocol is published by
// `codex app-server generate-json-schema`; verified with codex-cli 0.159.0.
const { HarnessError } = require('./errors');
const { spawnJsonLines } = require('./process');

// The app runs unattended, so anything that would ask a person is declined.
function declineServerRequest(method) {
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return { decision: 'decline' };
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') return { decision: 'denied' };
  if (method === 'mcpServer/elicitation/request') return { action: 'decline', content: null };
  return undefined;
}

class RpcError extends Error {
  constructor(code, message) { super(message); this.name = 'RpcError'; this.code = code; }
}

function startAppServer({ file, cwd, env, requestTimeoutMs = 30_000, onNotification = () => {}, clientVersion = '0' }) {
  const pending = new Map();
  let nextId = 0;
  let closed = false;
  const handle = spawnJsonLines(file, ['app-server'], {
    cwd, env,
    onMessage(message) {
      if (message.id !== undefined && message.method === undefined) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new RpcError(message.error.code, String(message.error.message || 'Codex request failed')));
        else request.resolve(message.result);
        return;
      }
      if (message.id !== undefined && typeof message.method === 'string') {
        const result = declineServerRequest(message.method);
        handle.write(result === undefined
          ? { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Agent Auto-Continue runs unattended and cannot answer this request.' } }
          : { jsonrpc: '2.0', id: message.id, result });
        return;
      }
      if (typeof message.method === 'string') {
        try { onNotification(message.method, message.params || {}); } catch { /* Observers must not break the transport. */ }
      }
    }
  });
  const exited = handle.exited.then((exit) => {
    closed = true;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new RpcError('closed', 'Codex app-server stopped.')); }
    pending.clear();
    return exit;
  });
  function request(method, params, { timeoutMs = requestTimeoutMs } = {}) {
    if (closed) return Promise.reject(new RpcError('closed', 'Codex app-server stopped.'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new RpcError('timeout', `Codex did not answer ${method} in time.`)); }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      handle.write({ jsonrpc: '2.0', id, method, params: params ?? null });
    });
  }
  const client = {
    request, exited, get stderr() { return handle.stderr; }, get pid() { return handle.child.pid; },
    notify(method, params) { if (!closed) handle.write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }); },
    async initialize() {
      await request('initialize', { clientInfo: { name: 'agent-auto-continue', title: 'Agent Auto-Continue', version: clientVersion } });
      client.notify('initialized');
    },
    async close(graceMs = 2000) {
      if (closed) return;
      handle.end();
      const timer = setTimeout(() => handle.terminate(1000), graceMs);
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
  if (error?.code === 'closed') return new HarnessError('process_failed', 'Codex stopped unexpectedly.', {}, posting);
  if (/no rollout found|thread not found|not found/i.test(error?.message || '')) return new HarnessError('conversation_not_found', 'Codex could not find that thread.');
  return new HarnessError('unsupported_response_shape', 'Codex rejected the request. Check that Codex is up to date.', { rpcCode: typeof error?.code === 'number' ? error.code : undefined });
}

module.exports = { RpcError, declineServerRequest, startAppServer, toHarnessError };
