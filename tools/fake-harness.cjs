'use strict';
// In-memory harness adapter for tests and the Electron smoke fixture.
// It satisfies the full adapter contract and records every call.
const { compatibility: normaliseCompatibility, defineHarness } = require('../lib/harnesses/contract');
const { HarnessError } = require('../lib/harnesses/errors');

// Pass `compatibility` (a result, or a function of the check options) to give
// the adapter a checkCompatibility(); change state.compatibility to simulate an app update.
function createFakeHarness({ id = 'fake', label = 'Fake Agent', kind = 'cli', noun = 'session', capabilities = {}, conversations = [], settings = [], compatibility = null } = {}) {
  const state = {
    conversations: new Map(conversations.map((item) => [item.id, { messages: [], archived: false, ...item }])),
    calls: [], submitted: [], availability: { state: 'available', resetsAt: null, reason: '', source: 'reported' },
    turn: { state: 'running' }, submitError: null, prepareError: null, turnError: null, completion: null, connectionError: null, compatibility
  };
  const record = (name, ...args) => state.calls.push([name, ...args]);
  const find = (id) => {
    const item = state.conversations.get(id);
    if (!item) throw new HarnessError('conversation_not_found', `${label} could not find that ${noun}.`);
    return item;
  };
  const adapter = defineHarness({
    id, label, kind, conversationNoun: noun, settings,
    capabilities: {
      canDiscoverConversations: true, canConfirmDelivery: true, canDetectUserActivity: true, canDetectCompletion: true,
      canDetectUsageLimit: true, canReportResetTime: true, requiresRunningApp: false, requiresUnlockedScreen: false,
      requiresAccessibilityPermission: false, ...capabilities
    },
    async checkConnection() { record('checkConnection'); if (state.connectionError) throw state.connectionError; return { ok: true, version: 'fake' }; },
    async listConversations(options) {
      record('listConversations', options);
      return [...state.conversations.values()].filter((item) => !item.archived).map((item) => ({ harness: id, id: item.id, title: item.title || '(Untitled)', projectId: item.projectId || '', projectName: item.projectName || '', updatedAt: item.updatedAt || null, state: 'unknown', settled: null }));
    },
    async inspectConversation(ref, options) {
      record('inspectConversation', ref, options);
      const item = find(ref.conversationId);
      const users = item.messages.filter((message) => message.role === 'user').map((message) => Date.parse(message.createdAt)).filter(Number.isFinite);
      return { id: item.id, title: item.title || '(Untitled)', projectId: item.projectId || '', projectName: item.projectName || '', archived: item.archived,
        latestUserActivityAt: users.length ? new Date(Math.max(...users)).toISOString() : null,
        delivered: Boolean(ref.deliveryKey) && item.messages.some((message) => message.id === ref.deliveryKey), busy: item.busy ?? false, awaitingInput: item.awaitingInput ?? null, context: { item } };
    },
    prepareTurn(turn, conversation) {
      record('prepareTurn', turn);
      if (state.prepareError) throw state.prepareError;
      return { deliveryKey: `fake-${turn.messageId}`, plan: { conversation: conversation.context.item, text: turn.message } };
    },
    async submitTurn(turn, plan) {
      record('submitTurn', turn);
      if (state.submitError) throw state.submitError;
      plan.conversation.messages.push({ id: turn.deliveryKey, role: 'user', text: plan.text, createdAt: new Date().toISOString() });
      state.submitted.push({ conversationId: turn.conversationId, text: plan.text, deliveryKey: turn.deliveryKey });
      return { turnId: `turn-${state.submitted.length}`, ...(state.completion ? { completion: state.completion } : {}) };
    },
    async findDelivery(turn) {
      record('findDelivery', turn);
      return { delivered: find(turn.conversationId).messages.some((message) => message.id === turn.deliveryKey) };
    },
    async checkTurn(turn) { record('checkTurn', turn); if (state.turnError) throw state.turnError; return { ...state.turn }; },
    async probeAvailability() { record('probeAvailability'); return { ...state.availability, checkedAt: new Date().toISOString() }; },
    async shutdown() { record('shutdown'); },
    ...(compatibility ? {
      async checkCompatibility(options = {}) {
        record('checkCompatibility', options);
        const value = typeof state.compatibility === 'function' ? state.compatibility(options) : state.compatibility;
        return normaliseCompatibility({ checkedAt: new Date().toISOString(), depth: options.depth, ...value });
      }
    } : {})
  });
  return { adapter, state };
}

module.exports = { createFakeHarness };
