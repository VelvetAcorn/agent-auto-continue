'use strict';

// Codex CLI through its app-server protocol (`codex app-server`, JSON-RPC over
// stdio). `codex exec resume` is implemented on the same thread/resume and
// turn/start requests, but only the protocol accepts a client message ID
// (`clientUserMessageId`), which makes delivery provable and never duplicated.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { conversation, conversationState, defineHarness, isoOrNull } = require('./contract');
const { HarnessError, redact } = require('./errors');
const { childEnv, findExecutable, firstLine } = require('./process');
const { startAppServer, toHarnessError } = require('./codex-rpc');
const { matchUsageLimit } = require('./usage-limits');

const TURN_WINDOW = 30;
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const validThreadId = (id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

function statusLabel(status) {
  if (status?.type === 'active') return Array.isArray(status.activeFlags) && status.activeFlags.length ? 'waiting' : 'working';
  if (status?.type === 'systemError') return 'error';
  return 'idle';
}
function awaitingInput(status) {
  if (status?.type === 'active') return Array.isArray(status.activeFlags) && status.activeFlags.some((flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput');
  if (status?.type === 'idle') return false;
  return null;
}
function userItems(turn) {
  return (Array.isArray(turn?.items) ? turn.items : []).filter((item) => isObject(item) && item.type === 'userMessage');
}

// Reads the account snapshot the Codex UI uses for its own usage meter.
function limitFromRateLimits(result, now) {
  const snapshot = isObject(result?.rateLimits) ? result.rateLimits : null;
  if (!snapshot) return null;
  const windows = [snapshot.primary, snapshot.secondary].filter(isObject);
  const exhausted = windows.filter((window) => Number(window.usedPercent) >= 100);
  const reached = typeof snapshot.rateLimitReachedType === 'string' || result.ordinaryUsageAllowed === false || exhausted.length > 0;
  const resets = (exhausted.length ? exhausted : windows).map((window) => isoOrNull(window.resetsAt)).filter((value) => value && Date.parse(value) > now).sort();
  return { reached, resetsAt: reached ? resets.at(-1) || null : null, usedPercent: Math.max(0, ...windows.map((window) => Number(window.usedPercent) || 0)), reason: snapshot.rateLimitReachedType || '' };
}

function createCodexHarness({ getSettings = () => ({}), env = process.env, home = os.homedir(), now = () => Date.now(), requestTimeoutMs = 30_000, resumeTimeoutMs = 120_000, maxTurnMs = 12 * 3_600_000, clientVersion = '0' } = {}) {
  const runs = new Map();

  function executable() {
    const override = getSettings('codex')?.executable || '';
    const file = findExecutable('codex', { home, env, override });
    if (!file) throw new HarnessError('harness_not_installed', override ? 'The Codex executable in Settings was not found or is not executable.' : 'Codex was not found. Install the Codex CLI, or set its executable path in Settings.');
    return file;
  }
  function open(file, cwd, onNotification) {
    return startAppServer({ file, cwd, env: childEnv(env, { executable: file, home }), requestTimeoutMs, onNotification, clientVersion });
  }
  // Runs read-only requests against a short-lived app-server.
  async function withClient(operation) {
    const file = executable();
    const client = open(file, home);
    try {
      await client.initialize();
      return await operation(client);
    } catch (error) {
      if (error?.code === 'closed') throw new HarnessError('process_failed', 'Codex stopped unexpectedly. Check that the Codex CLI works in Terminal.', { hint: redact(firstLine(client.stderr)) });
      throw toHarnessError(error);
    } finally { await client.close(); }
  }
  async function readThread(client, threadId) {
    if (!validThreadId(threadId)) throw new HarnessError('conversation_not_found', 'Codex could not find that thread.');
    const result = await client.request('thread/read', { threadId, includeTurns: false });
    if (!isObject(result?.thread) || result.thread.id !== threadId) throw new HarnessError('unsupported_response_shape', 'Codex returned an unsupported thread. Check that Codex is up to date.');
    return result.thread;
  }
  async function recentTurns(client, threadId) {
    const result = await client.request('thread/turns/list', { threadId, limit: TURN_WINDOW });
    if (!Array.isArray(result?.data)) throw new HarnessError('unsupported_response_shape', 'Codex returned an unsupported turn list. Check that Codex is up to date.');
    return result.data.filter(isObject);
  }
  function turnWithKey(turns, key) {
    return turns.find((turn) => userItems(turn).some((item) => item.clientId === key)) || null;
  }
  function outcomeFromTurn(turn, limit) {
    const error = isObject(turn.error) ? turn.error : null;
    const usage = error && (error.codexErrorInfo === 'usageLimitExceeded' || matchUsageLimit(error.message, now()));
    const base = { turnId: turn.id, completedAt: isoOrNull(turn.completedAt) };
    if (turn.status === 'completed') return { ...base, state: 'completed' };
    if (turn.status === 'interrupted') return { ...base, state: 'interrupted' };
    if (turn.status === 'failed') {
      return { ...base, state: 'failed', error: { code: usage ? 'usage_limited' : 'agent_error', message: usage ? 'Codex reached a usage limit.' : redact(String(error?.message || 'Codex reported an error.')).slice(0, 240) },
        usageLimit: usage ? { resetsAt: limit?.resetsAt || null, message: 'Codex reached a usage limit.' } : null };
    }
    return { ...base, state: 'running' };
  }

  return defineHarness({
    id: 'codex', label: 'Codex', kind: 'cli', conversationNoun: 'thread',
    description: 'Resumes Codex CLI and IDE threads through codex app-server. Runs while the screen is locked.',
    capabilities: {
      canDiscoverConversations: true, canConfirmDelivery: true, canDetectUserActivity: true,
      canDetectCompletion: true, canDetectUsageLimit: true, canReportResetTime: true,
      requiresRunningApp: false, requiresUnlockedScreen: false, requiresAccessibilityPermission: false
    },
    settings: [{ key: 'executable', type: 'text', label: 'Codex executable', help: 'Optional absolute path. Leave blank to find codex automatically.' }],
    async checkConnection() {
      return withClient(async (client) => {
        const result = await client.request('account/read', { refreshToken: false });
        if (!isObject(result)) throw new HarnessError('unsupported_response_shape', 'Codex returned an unsupported account response.');
        if (!result.account && result.requiresOpenaiAuth !== false) throw new HarnessError('missing_credentials', 'Codex is not signed in. Run “codex login” in Terminal.');
        return { ok: true };
      });
    },
    async listConversations() {
      return withClient(async (client) => {
        const result = await client.request('thread/list', { limit: 100, sortKey: 'updated_at', archived: false });
        if (!Array.isArray(result?.data)) throw new HarnessError('unsupported_response_shape', 'Codex returned an unsupported thread list. Check that Codex is up to date.');
        return result.data.filter((thread) => isObject(thread) && validThreadId(thread.id) && !thread.parentThreadId && !thread.ephemeral).map((thread) => conversation('codex', {
          id: thread.id, title: thread.name || String(thread.preview || '').replace(/\s+/g, ' ').slice(0, 80) || 'Untitled thread',
          projectId: typeof thread.cwd === 'string' ? thread.cwd : '', projectName: typeof thread.cwd === 'string' ? path.basename(thread.cwd) : '',
          updatedAt: thread.updatedAt, settled: false, state: runs.has(thread.id) ? 'working' : statusLabel(thread.status)
        })).sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || a.id.localeCompare(b.id));
      });
    },
    async inspectConversation(ref) {
      return withClient(async (client) => {
        const thread = await readThread(client, ref.conversationId);
        const turns = await recentTurns(client, ref.conversationId);
        const userStarts = turns.filter((turn) => userItems(turn).length).map((turn) => isoOrNull(turn.startedAt)).filter(Boolean).sort();
        return conversationState({
          id: thread.id, title: thread.name || String(thread.preview || '').replace(/\s+/g, ' ').slice(0, 80) || 'Untitled thread',
          projectId: thread.cwd || '', projectName: thread.cwd ? path.basename(thread.cwd) : '',
          archived: thread.archived === true || Boolean(thread.archivedAt), latestUserActivityAt: userStarts.at(-1) || null,
          delivered: Boolean(ref.deliveryKey) && Boolean(turnWithKey(turns, ref.deliveryKey)),
          busy: [...runs.values()].some((run) => run.threadId === thread.id && !run.outcome) || (thread.status?.type === 'active' ? true : thread.status?.type === 'idle' ? false : null),
          awaitingInput: awaitingInput(thread.status), context: { cwd: thread.cwd }
        });
      });
    },
    prepareTurn(turn, state) {
      if ([...runs.values()].some((run) => run.threadId === turn.conversationId && !run.outcome)) throw new HarnessError('conversation_busy', 'A scheduled turn is already running in this thread.');
      const cwd = state.context?.cwd;
      let directory = false;
      try { directory = Boolean(cwd) && fs.statSync(cwd).isDirectory(); } catch { directory = false; }
      if (!directory) throw new HarnessError('conversation_not_found', 'The working folder for this Codex thread no longer exists.', { cwd: cwd ? path.basename(cwd) : '' });
      return { deliveryKey: turn.messageId, plan: { file: executable(), cwd } };
    },
    async submitTurn(turn, plan) {
      const run = { threadId: turn.conversationId, turnId: null, outcome: null, client: null };
      let settle;
      run.completion = new Promise((resolve) => { settle = resolve; });
      const finish = async (outcome) => {
        if (run.outcome) return;
        clearTimeout(run.deadline);
        if (outcome.state === 'failed' && outcome.usageLimit) {
          const limits = await run.client.request('account/rateLimits/read', null, { timeoutMs: 10_000 }).catch(() => null);
          outcome.usageLimit.resetsAt = limitFromRateLimits(limits, now())?.resetsAt || outcome.usageLimit.resetsAt;
        }
        run.outcome = outcome;
        settle(outcome);
        void run.client.close();
      };
      run.client = open(plan.file, plan.cwd, (method, params) => {
        if (method === 'turn/completed' && params.threadId === run.threadId && isObject(params.turn) && (!run.turnId || params.turn.id === run.turnId)) void finish(outcomeFromTurn(params.turn));
      });
      runs.set(turn.deliveryKey, run);
      void run.client.exited.then(() => finish({ state: run.turnId ? 'interrupted' : 'unknown', turnId: run.turnId, completedAt: new Date(now()).toISOString() }));
      try {
        await run.client.initialize();
        await run.client.request('thread/resume', { threadId: turn.conversationId, excludeTurns: true }, { timeoutMs: resumeTimeoutMs });
      } catch (error) {
        runs.delete(turn.deliveryKey);
        await run.client.close();
        throw toHarnessError(error);
      }
      let started;
      try {
        started = await run.client.request('turn/start', { threadId: turn.conversationId, clientUserMessageId: turn.deliveryKey, input: [{ type: 'text', text: turn.message, text_elements: [] }] });
      } catch (error) {
        const rejected = typeof error?.code === 'number';
        if (rejected) { runs.delete(turn.deliveryKey); await run.client.close(); }
        // A JSON-RPC error is a definite rejection; a timeout or crash may have started the turn.
        throw toHarnessError(error, { posting: !rejected });
      }
      if (!isObject(started?.turn) || typeof started.turn.id !== 'string') throw new HarnessError('unsupported_response_shape', 'Codex did not confirm the new turn.', {}, true);
      run.turnId = started.turn.id;
      run.deadline = setTimeout(() => {
        void run.client.request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId }, { timeoutMs: 10_000 }).catch(() => {}).finally(() => run.client.close());
      }, maxTurnMs);
      run.deadline.unref?.();
      return { turnId: run.turnId, completion: run.completion };
    },
    async findDelivery(turn) {
      return withClient(async (client) => ({ delivered: Boolean(turnWithKey(await recentTurns(client, turn.conversationId), turn.deliveryKey)) }));
    },
    async checkTurn(turn) {
      const run = runs.get(turn.deliveryKey);
      if (run) return run.outcome || { state: 'running', turnId: run.turnId };
      return withClient(async (client) => {
        const found = turnWithKey(await recentTurns(client, turn.conversationId), turn.deliveryKey);
        if (!found) return { state: 'unknown' };
        const outcome = outcomeFromTurn(found);
        // A turn still marked in progress after this app restarted was interrupted with its process.
        return outcome.state === 'running' ? { state: 'unknown', turnId: found.id } : outcome;
      });
    },
    async probeAvailability() {
      return withClient(async (client) => {
        const limit = limitFromRateLimits(await client.request('account/rateLimits/read', null), now());
        const checkedAt = new Date(now()).toISOString();
        if (!limit) return { state: 'unknown', reason: 'Codex did not report usage limits for this account.', source: 'none', checkedAt };
        if (limit.reached) return { state: 'limited', resetsAt: limit.resetsAt, reason: limit.reason ? `Codex usage limit reached (${limit.reason}).` : 'Codex usage limit reached.', source: 'reported', checkedAt };
        return { state: 'available', reason: `Codex usage is at ${limit.usedPercent}% of the current limit.`, source: 'reported', checkedAt };
      });
    },
    async shutdown() {
      const active = [...runs.values()].filter((run) => !run.outcome && run.turnId);
      await Promise.all(active.map((run) => run.client.request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId }, { timeoutMs: 5000 }).catch(() => {})));
      await Promise.all([...runs.values()].filter((run) => !run.outcome).map((run) => run.client.close()));
    }
  });
}

module.exports = { createCodexHarness, limitFromRateLimits };
