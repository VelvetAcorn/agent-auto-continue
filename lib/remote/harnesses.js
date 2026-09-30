'use strict';

const { normaliseThreads } = require('../threads');

/**
 * The harness boundary the remote API reads from. It has the same shape as the
 * multi-harness registry (issue #2): describe(), has(id), get(id) returning an adapter
 * with checkConnection(), listConversations({ showSettled }) and optional probeAvailability(),
 * plus defaultHarness. Once that registry exists, pass it here instead of this T3-only stand-in.
 * @param {ReturnType<typeof import('../api-client').createApiClient>} api
 */
function createT3HarnessSource(api) {
  const adapter = Object.freeze({
    id: 't3', label: 'T3 Code', kind: 'local-api', conversationNoun: 'thread',
    description: 'Sends through the T3 Code app’s local API on 127.0.0.1.',
    capabilities: Object.freeze({
      canDiscoverConversations: true, canConfirmDelivery: true, canDetectUserActivity: true,
      canDetectCompletion: false, canDetectUsageLimit: false, canReportResetTime: false,
      requiresRunningApp: true, requiresUnlockedScreen: false, requiresAccessibilityPermission: false
    }),
    async checkConnection() { await api.fetchSnapshot(); return { ok: true }; },
    async listConversations({ showSettled = false } = {}) {
      return normaliseThreads(await api.fetchSnapshot(), { showSettled }).map((thread) => ({ harness: 't3', ...thread }));
    }
  });
  return {
    defaultHarness: 't3',
    describe: () => [{ id: adapter.id, label: adapter.label, kind: adapter.kind, conversationNoun: adapter.conversationNoun, description: adapter.description, capabilities: { ...adapter.capabilities } }],
    has: (id) => id === 't3',
    get: (id) => {
      if (id !== 't3') throw Object.assign(new Error('That agent harness is not available in this version of the app.'), { code: 'unknown_harness' });
      return adapter;
    }
  };
}

module.exports = { createT3HarnessSource };
