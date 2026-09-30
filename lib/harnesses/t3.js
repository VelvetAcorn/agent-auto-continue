'use strict';

const { ApiError } = require('../api-client');
const { buildTurnStartCommand, findLatestUserTurnAt, hasMessageId } = require('../model');
const { normaliseThreads } = require('../threads');
const { conversation, conversationState, defineHarness } = require('./contract');

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
        delivered: Boolean(ref.deliveryKey) && hasMessageId(thread, ref.deliveryKey), busy: null, context: thread
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

module.exports = { createT3Harness };
