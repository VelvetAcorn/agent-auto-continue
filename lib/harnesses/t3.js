'use strict';

const { ApiError } = require('../api-client');
const { buildTurnStartCommand, findLatestUserTurnAt, hasMessageId } = require('../model');
const { normaliseThreads } = require('../threads');
const { conversation, conversationState, defineHarness, isoOrNull } = require('./contract');
const { redact } = require('./errors');
const { matchUsageLimit } = require('./usage-limits');

// A turn that has not started this long after its request is no longer tracked.
const START_WINDOW_MS = 15 * 60_000;
const REQUESTED = 'requested:';

// Mirrors T3 Code 0.0.40's own rule (decider openRequests): an approval or
// user-input request stays open until a later resolution for the same requestId,
// or a respond failure that marks the request stale or unknown.
const STALE_REQUEST = /(stale|unknown) pending (approval|permission|user[- ]input|codex user input) request/;
function awaitingInput(thread) {
  if (!Array.isArray(thread?.activities)) return null;
  const open = new Set();
  for (const activity of thread.activities) {
    const payload = activity && typeof activity.payload === 'object' && activity.payload !== null ? activity.payload : null;
    const requestId = typeof payload?.requestId === 'string' ? payload.requestId : null;
    if (!requestId) continue;
    if (activity.kind === 'approval.requested' || activity.kind === 'user-input.requested') open.add(requestId);
    else if (activity.kind === 'approval.resolved' || activity.kind === 'user-input.resolved') open.delete(requestId);
    else if ((activity.kind === 'provider.approval.respond.failed' || activity.kind === 'provider.user-input.respond.failed') && STALE_REQUEST.test(String(payload.detail || '').toLowerCase())) open.delete(requestId);
  }
  return open.size > 0;
}

// The text of the agent's last message in the thread's latest turn. T3 Code
// 0.0.40's projector sets latestTurn.assistantMessageId to each assistant
// message the turn sends, so it names the last one; messages still streaming are skipped.
function lastAgentMessage(thread, latest) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  const usable = (message) => message?.role === 'assistant' && message.streaming !== true && typeof message.text === 'string' && message.text.trim();
  const named = latest?.assistantMessageId ? messages.find((message) => message?.id === latest.assistantMessageId) : null;
  if (usable(named)) return named.text;
  const own = latest?.turnId ? messages.filter((message) => usable(message) && message.turnId === latest.turnId) : [];
  return own.at(-1)?.text || null;
}

// Turn outcome for the message whose turn.start command was created at
// `requestedAt`. Verified against T3 Code 0.0.40 sources: the thread's
// latestTurn.requestedAt is the createdAt of the command that started it, and
// a failed start appends a provider.turn.start.failed activity whose
// payload.requestId is the message ID.
function turnOutcomeFor(thread, turn, now) {
  const failure = (Array.isArray(thread?.activities) ? thread.activities : []).find((activity) => activity?.kind === 'provider.turn.start.failed' && activity.payload?.requestId === turn.deliveryKey);
  const failed = (text, completedAt) => {
    const limit = matchUsageLimit(text, now);
    const message = redact(text || 'T3 Code could not start the agent turn.').slice(0, 240);
    return { state: 'failed', completedAt: isoOrNull(completedAt), error: { code: limit ? 'usage_limited' : 'agent_error', message }, usageLimit: limit ? { resetsAt: limit.resetsAt, message } : null };
  };
  if (failure) return { ...failed(String(failure.payload?.detail || failure.summary || '')), turnId: turn.turnId };
  const requestedAt = typeof turn.turnId === 'string' && turn.turnId.startsWith(REQUESTED) ? Date.parse(turn.turnId.slice(REQUESTED.length)) : NaN;
  if (!Number.isFinite(requestedAt)) return { state: 'unknown' };
  const latest = thread?.latestTurn;
  const latestAt = Date.parse(latest?.requestedAt);
  if (latest && latestAt === requestedAt) {
    const base = { turnId: turn.turnId, completedAt: isoOrNull(latest.completedAt) };
    if (latest.state === 'running') return { ...base, state: 'running' };
    if (latest.state === 'completed') return { ...base, state: 'completed', lastAgentMessage: lastAgentMessage(thread, latest) };
    if (latest.state === 'interrupted') return { ...base, state: 'interrupted', lastAgentMessage: lastAgentMessage(thread, latest) };
    if (latest.state === 'error') return { ...failed(typeof thread.session?.lastError === 'string' ? thread.session.lastError : '', latest.completedAt), turnId: turn.turnId };
    return { state: 'unknown', turnId: turn.turnId };
  }
  // A later turn replaced this one, so its own result can no longer be observed.
  if (Number.isFinite(latestAt) && latestAt > requestedAt) return { state: 'unknown', turnId: turn.turnId };
  // Still queued behind another turn or starting.
  return now - requestedAt > START_WINDOW_MS ? { state: 'unknown', turnId: turn.turnId } : { state: 'running', turnId: turn.turnId };
}

// T3 Code over its loopback orchestration HTTP API (lib/api-client.js).
function createT3Harness({ api, now = () => Date.now() }) {
  return defineHarness({
    id: 't3', label: 'T3 Code', kind: 'local-api', conversationNoun: 'thread',
    description: 'Sends through the T3 Code app’s local API on 127.0.0.1.',
    capabilities: {
      canDiscoverConversations: true, canConfirmDelivery: true, canDetectUserActivity: true,
      canDetectCompletion: true, canDetectUsageLimit: false, canReportResetTime: false, canReportAgentMessage: true,
      requiresRunningApp: true, requiresUnlockedScreen: false, requiresAccessibilityPermission: false
    },
    // The bearer token and port keep their original top-level settings for compatibility.
    settings: [],
    async checkConnection() {
      await api.fetchSnapshot();
      return { ok: true };
    },
    async listConversations(options = {}) {
      return normaliseThreads(await api.fetchSnapshot(), options).map((thread) => conversation('t3', thread));
    },
    async inspectConversation(ref, { purpose = 'dispatch' } = {}) {
      const [thread, snapshot] = await Promise.all([
        api.fetchThread(ref.conversationId),
        purpose === 'schedule' && api.fetchSnapshot ? api.fetchSnapshot().catch(() => null) : null
      ]);
      const project = snapshot?.projects?.find((item) => item?.id === thread.projectId);
      return conversationState({
        id: thread.id, title: thread.title || '(Untitled thread)', projectId: thread.projectId || '',
        projectName: project?.title || project?.name || thread.projectId || '',
        archived: Boolean(thread.archivedAt), latestUserActivityAt: findLatestUserTurnAt(thread),
        delivered: Boolean(ref.deliveryKey) && hasMessageId(thread, ref.deliveryKey), busy: null, awaitingInput: awaitingInput(thread), context: thread
      });
    },
    prepareTurn(turn, state) {
      const thread = state.context;
      if (!thread?.modelSelection || !thread.runtimeMode || !thread.interactionMode) throw new ApiError('unsupported_response_shape', 'T3 Code did not return the thread settings needed to send this message. Check API compatibility.');
      const command = buildTurnStartCommand({ commandId: turn.commandId, threadId: turn.conversationId, messageId: turn.messageId, message: turn.message }, thread);
      return { deliveryKey: turn.messageId, plan: command };
    },
    async submitTurn(_turn, command) {
      await api.dispatch(command);
      // T3 Code assigns its own turn ID later; the command time identifies the turn it starts.
      return { turnId: `${REQUESTED}${command.createdAt}` };
    },
    async findDelivery(turn) {
      const thread = await api.fetchThread(turn.conversationId);
      return { delivered: hasMessageId(thread, turn.deliveryKey || turn.messageId) };
    },
    async checkTurn(turn) {
      return turnOutcomeFor(await api.fetchThread(turn.conversationId), turn, now());
    }
  });
}

module.exports = { awaitingInput, createT3Harness, lastAgentMessage, turnOutcomeFor };
