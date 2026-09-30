'use strict';

const { ApiError } = require('../api-client');
const { buildTurnStartCommand, findLatestUserTurnAt, hasMessageId } = require('../model');
const { normaliseThreads } = require('../threads');
const { conversation, conversationState, defineHarness } = require('./contract');

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

// T3 Code over its loopback orchestration HTTP API (lib/api-client.js).
function createT3Harness({ api }) {
  return defineHarness({
    id: 't3', label: 'T3 Code', kind: 'local-api', conversationNoun: 'thread',
    description: 'Sends through the T3 Code app’s local API on 127.0.0.1.',
    capabilities: {
      canDiscoverConversations: true, canConfirmDelivery: true, canDetectUserActivity: true,
      canDetectCompletion: false, canDetectUsageLimit: false, canReportResetTime: false,
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
      return { turnId: null };
    },
    async findDelivery(turn) {
      const thread = await api.fetchThread(turn.conversationId);
      return { delivered: hasMessageId(thread, turn.deliveryKey || turn.messageId) };
    }
  });
}

module.exports = { awaitingInput, createT3Harness };
