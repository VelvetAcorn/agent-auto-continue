'use strict';

// Codex CLI threads through the app-server protocol (see codex-reader.js for
// transport selection). Sending is thread/resume + turn/start with
// `clientUserMessageId`, the protocol's stable client message ID, which makes
// delivery provable and never duplicated. `codex exec resume` uses the same
// requests internally but cannot carry that ID. Verified with codex-cli 0.159.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { conversation, conversationState, defineHarness, isoOrNull } = require('./contract');
const { HarnessError } = require('./errors');
const { findExecutable } = require('./process');
const { codexThreadWriter, readCodexThreadWriters } = require('./codex-locks');
const { createCodexReader, outcomeFromTurn, ownerOfThread } = require('./codex-reader');
const { toHarnessError } = require('./codex-rpc');

const TURN_WINDOW = 30;
const OWNER_LABELS = { 'codex-desktop': 'the Codex desktop app', t3: 'T3 Code' };
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

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
const userItems = (turn) => (Array.isArray(turn?.items) ? turn.items : []).filter((item) => isObject(item) && item.type === 'userMessage');
const turnWithKey = (turns, key) => turns.find((turn) => userItems(turn).some((item) => item.clientId === key)) || null;
const titleOf = (thread) => thread.name || String(thread.preview || '').replace(/\s+/g, ' ').slice(0, 80) || 'Untitled thread';

function busyError(writer) {
  if (writer.owner === 'codex-desktop') return new HarnessError('conversation_busy', 'This thread is open in the Codex desktop app. Close it there, or schedule it with the Codex desktop harness.', { owner: writer.owner, pid: writer.pid });
  return new HarnessError('conversation_busy', `Another Codex process (pid ${writer.pid}) is writing to this thread. Close it and try again.`, { owner: writer.owner, pid: writer.pid });
}

function createCodexHarness({ getSettings = () => ({}), env = process.env, home = os.homedir(), now = () => Date.now(), requestTimeoutMs = 30_000, resumeTimeoutMs = 120_000, maxTurnMs = 12 * 3_600_000, clientVersion = '0', transport = 'auto', detectDaemon, threadWriter, threadWriters } = {}) {
  const runs = new Map();
  const writerOf = threadWriter || ((id, options) => codexThreadWriter(id, { home, env, ...options }));
  const writers = threadWriters || (() => readCodexThreadWriters({ home, env }));
  function executable() {
    const override = getSettings('codex')?.executable || '';
    const file = findExecutable('codex', { home, env, override });
    if (!file) throw new HarnessError('harness_not_installed', override ? 'The Codex executable in Settings was not found or is not executable.' : 'Codex was not found. Install the Codex CLI, or set its executable path in Settings.');
    return file;
  }
  const reader = createCodexReader({ executable, env, home, now, requestTimeoutMs, transport, detectDaemon, clientVersion });
  const activeRun = (threadId) => [...runs.values()].find((run) => run.threadId === threadId && !run.outcome);

  return defineHarness({
    id: 'codex', label: 'Codex', kind: 'cli', conversationNoun: 'thread',
    description: 'Resumes Codex CLI threads through codex app-server, using the shared Codex daemon when it runs. Works while the screen is locked.',
    capabilities: {
      canDiscoverConversations: true, canConfirmDelivery: true, canDetectUserActivity: true,
      canDetectCompletion: true, canDetectUsageLimit: true, canReportResetTime: true,
      requiresRunningApp: false, requiresUnlockedScreen: false, requiresAccessibilityPermission: false
    },
    settings: [{ key: 'executable', type: 'text', label: 'Codex executable', help: 'Optional absolute path. Leave blank to find codex automatically.' }],
    async checkConnection() {
      const result = await reader.account();
      if (!isObject(result)) throw new HarnessError('unsupported_response_shape', 'Codex returned an unsupported account response.');
      if (!result.account && result.requiresOpenaiAuth !== false) throw new HarnessError('missing_credentials', 'Codex is not signed in. Run “codex login” in Terminal.');
      return { ok: true };
    },
    async listConversations() {
      const [threads, held] = await Promise.all([reader.listThreads(), writers().catch(() => null)]);
      return threads.filter((thread) => !thread.parentThreadId && !thread.ephemeral && ownerOfThread(thread) === 'codex').map((thread) => {
        const writer = held?.get(thread.id.toLowerCase());
        return conversation('codex', {
          id: thread.id, title: titleOf(thread), projectId: typeof thread.cwd === 'string' ? thread.cwd : '', projectName: typeof thread.cwd === 'string' ? path.basename(thread.cwd) : '',
          updatedAt: thread.updatedAt, settled: false,
          state: activeRun(thread.id) ? 'working' : writer && writer.owner !== 'daemon' ? 'in-use' : statusLabel(thread.status)
        });
      }).sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || a.id.localeCompare(b.id));
    },
    async inspectConversation(ref) {
      return reader.withClient(async (client) => {
        const thread = await reader.readThread(ref.conversationId, client);
        const turns = await reader.recentTurns(ref.conversationId, TURN_WINDOW, client);
        const writer = await writerOf(ref.conversationId).catch(() => undefined);
        const userStarts = turns.filter((turn) => userItems(turn).length).map((turn) => isoOrNull(turn.startedAt)).filter(Boolean).sort();
        return conversationState({
          id: thread.id, title: titleOf(thread), projectId: thread.cwd || '', projectName: thread.cwd ? path.basename(thread.cwd) : '',
          archived: thread.archived === true || Boolean(thread.archivedAt), latestUserActivityAt: userStarts.at(-1) || null,
          delivered: Boolean(ref.deliveryKey) && Boolean(turnWithKey(turns, ref.deliveryKey)),
          busy: Boolean(activeRun(thread.id)) || turns.some((turn) => turn.status === 'inProgress') || (thread.status?.type === 'active' ? true : thread.status?.type === 'idle' ? false : null),
          awaitingInput: awaitingInput(thread.status),
          context: { cwd: thread.cwd, owner: ownerOfThread(thread), writer, inProgress: turns.some((turn) => turn.status === 'inProgress') }
        });
      });
    },
    prepareTurn(turn, state) {
      const { cwd, owner, writer, inProgress } = state.context || {};
      if (owner && owner !== 'codex') throw new HarnessError('owned_by_other_harness', `This thread belongs to ${OWNER_LABELS[owner] || owner}. Schedule it with that harness instead.`, { harness: owner });
      if (activeRun(turn.conversationId)) throw new HarnessError('conversation_busy', 'A scheduled turn is already running in this thread.');
      if (inProgress) throw new HarnessError('conversation_busy', 'Codex is already working on a turn in this thread.');
      if (writer && writer.owner !== 'daemon') throw busyError(writer);
      let directory = false;
      try { directory = Boolean(cwd) && fs.statSync(cwd).isDirectory(); } catch { directory = false; }
      if (!directory) throw new HarnessError('conversation_not_found', 'The working folder for this Codex thread no longer exists.', { cwd: cwd ? path.basename(cwd) : '' });
      executable();
      return { deliveryKey: turn.messageId, plan: { cwd } };
    },
    async submitTurn(turn, plan) {
      const run = { threadId: turn.conversationId, turnId: null, outcome: null, client: null, approvalRequired: false, detached: false };
      let settle;
      run.completion = new Promise((resolve) => { settle = resolve; });
      const finish = async (outcome) => {
        if (run.outcome || run.detached) return;
        clearTimeout(run.deadline);
        if (run.approvalRequired) outcome = { ...outcome, state: 'interrupted', error: { code: 'approval_required', message: 'Codex asked for approval or input, so the unattended turn was stopped.' }, usageLimit: null };
        if (outcome.state === 'failed' && outcome.usageLimit) {
          const limit = await reader.rateLimits().catch(() => null);
          outcome.usageLimit.resetsAt = limit?.resetsAt || null;
        }
        run.outcome = outcome;
        settle(outcome);
        void run.client.close();
      };
      const chosen = await reader.selectTransport();
      run.client = await reader.open({
        cwd: plan.cwd, transport: chosen,
        onNotification(method, params) {
          if (method === 'turn/completed' && params.threadId === run.threadId && isObject(params.turn) && (!run.turnId || params.turn.id === run.turnId)) void finish(outcomeFromTurn(params.turn, null, now()));
        },
        onServerRequest(method) {
          run.approvalRequired = true;
          // Approval answers already stop the turn; other requests need an explicit interrupt.
          if (!/requestApproval|Approval$/.test(method) && run.turnId) void run.client.request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId }, { timeoutMs: 10_000 }).catch(() => {});
        }
      });
      try {
        await run.client.request('thread/resume', { threadId: turn.conversationId, excludeTurns: true }, { timeoutMs: resumeTimeoutMs });
        // Re-check immediately before sending: only the server we write through may hold the writer lock.
        const writer = await writerOf(turn.conversationId, { selfPids: [run.client.pid] }).catch(() => undefined);
        if (writer && !(writer.owner === 'self' || (chosen === 'daemon' && writer.owner === 'daemon'))) throw busyError(writer);
        if ((await reader.recentTurns(turn.conversationId, 5, run.client)).some((item) => item.status === 'inProgress')) throw new HarnessError('conversation_busy', 'Codex is already working on a turn in this thread.');
      } catch (error) {
        await run.client.close();
        throw toHarnessError(error);
      }
      runs.set(turn.deliveryKey, run);
      void run.client.exited.then(() => {
        // Daemon turns keep running without this client; they are polled instead.
        if (chosen === 'daemon' && !run.outcome) { run.detached = true; runs.delete(turn.deliveryKey); return; }
        void finish({ state: run.turnId ? 'interrupted' : 'unknown', turnId: run.turnId, completedAt: new Date(now()).toISOString() });
      });
      let started;
      try {
        started = await run.client.request('turn/start', { threadId: turn.conversationId, clientUserMessageId: turn.deliveryKey, input: [{ type: 'text', text: turn.message, text_elements: [] }] });
      } catch (error) {
        // A JSON-RPC error is a definite rejection; a timeout or lost connection may have started the turn.
        const rejected = typeof error?.code === 'number';
        if (rejected) { runs.delete(turn.deliveryKey); await run.client.close(); }
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
      return { delivered: Boolean(turnWithKey(await reader.recentTurns(turn.conversationId, TURN_WINDOW), turn.deliveryKey)) };
    },
    async checkTurn(turn) {
      const run = runs.get(turn.deliveryKey);
      if (run) return run.outcome || { state: 'running', turnId: run.turnId };
      const found = turnWithKey(await reader.recentTurns(turn.conversationId, TURN_WINDOW), turn.deliveryKey);
      if (!found) return { state: 'unknown' };
      const outcome = outcomeFromTurn(found, null, now());
      if (outcome.state !== 'running') return outcome;
      // Only the shared daemon keeps a turn running without this app; a private server's turn ended with it.
      return (await reader.selectTransport()) === 'daemon' ? outcome : { state: 'unknown', turnId: found.id };
    },
    async probeAvailability() {
      const limit = await reader.rateLimits();
      const checkedAt = new Date(now()).toISOString();
      if (!limit) return { state: 'unknown', reason: 'Codex did not report usage limits for this account.', source: 'none', checkedAt };
      if (limit.reached) return { state: 'limited', resetsAt: limit.resetsAt, reason: limit.reason ? `Codex usage limit reached (${limit.reason}).` : 'Codex usage limit reached.', source: 'reported', checkedAt };
      return { state: 'available', reason: `Codex usage is at ${limit.usedPercent}% of the current limit.`, source: 'reported', checkedAt };
    },
    async shutdown() {
      const active = [...runs.values()].filter((run) => !run.outcome);
      await Promise.all(active.map(async (run) => {
        // Daemon turns continue in the daemon; private turns end with their server, so interrupt them cleanly.
        if (run.client.transport === 'daemon') { run.detached = true; runs.delete([...runs.entries()].find(([, value]) => value === run)?.[0]); }
        else if (run.turnId) await run.client.request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId }, { timeoutMs: 5000 }).catch(() => {});
        await run.client.close();
      }));
    }
  });
}

module.exports = { createCodexHarness };
