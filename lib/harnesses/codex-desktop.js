'use strict';

// Codex threads that live in the ChatGPT desktop app (bundle com.openai.codex,
// the merged ChatGPT and Codex app). The app runs its own private app-server and
// holds each open thread's writer lock, so a second writer is never safe; the
// send therefore goes through the app's user interface. Everything else is read
// through Codex's supported app-server protocol, using the codex binary bundled
// with the app so the protocol version always matches:
//   codex://threads/<threadId>          the app's own deep link to a thread
//   thread/list, thread/read            discovery, names, archive state and duplicate names
//   thread/turns/list                   busy state and delivery evidence
//   account/rateLimits/read             usage limits with reset times
// The Codex adapter leaves desktop-originated threads to this one.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { conversation, conversationState, defineHarness, isoOrNull } = require('./contract');
const { HarnessError } = require('./errors');
const { isScreenLocked } = require('./session-lock');
const { createMacAutomation } = require('../desktop/mac-automation');
const { deliverThroughUi, normaliseText, requireReady } = require('../desktop/ui-delivery');
const { createCodexReader, isDesktopThread, ownerOfThread } = require('./codex-reader');

const BUNDLE_ID = 'com.openai.codex';
const LABEL = 'ChatGPT (Codex)';
const SKEW_MS = 5_000;
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The app ships no readable message catalogue, so only English labels are known.
const TARGET = { composerLabels: ['Do anything', 'Ask for follow-up changes'], sendLabels: ['Send', 'Send message'], stopLabels: ['Stop'] };
const APP_PATHS = ['/Applications/ChatGPT.app', path.join(os.homedir(), 'Applications', 'ChatGPT.app')];

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function userText(item) {
  if (typeof item?.text === 'string') return item.text;
  return (Array.isArray(item?.content) ? item.content : []).filter((part) => isObject(part) && part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
}
function userItems(turn) {
  return (Array.isArray(turn?.items) ? turn.items : []).filter((item) => isObject(item) && item.type === 'userMessage');
}
function inProgress(turns) {
  return turns.some((turn) => turn.status === 'inProgress');
}

function findAppBundledCodex(exists = (file) => fs.existsSync(file)) {
  for (const app of APP_PATHS) {
    const file = path.join(app, 'Contents', 'Resources', 'codex');
    if (exists(file)) return file;
  }
  return null;
}

// Reads go through a private app-server started from the app-bundled binary;
// they never load the thread for writing, so the app stays its only writer.
function createCodexDesktopHarness({ env = process.env, home = os.homedir(), createReader = (options) => createCodexReader({ ...options, env, home, transport: 'private' }), automation = createMacAutomation(), isLocked = isScreenLocked, platform = process.platform, now = () => Date.now(), sleep, timings, codexPath = findAppBundledCodex } = {}) {
  let reader = null;
  function client() {
    if (platform !== 'darwin') throw new HarnessError('harness_not_installed', 'ChatGPT desktop automation is only available on macOS.');
    const executable = codexPath();
    if (!executable) throw new HarnessError('harness_not_installed', 'The ChatGPT desktop app with Codex was not found in Applications.');
    reader ||= createReader({ executable });
    return reader;
  }
  async function desktopThreads() {
    return (await client().listThreads()).filter((item) => THREAD_ID.test(item.id || '') && isDesktopThread(item));
  }
  async function thread(id) {
    if (!THREAD_ID.test(id || '')) throw new HarnessError('conversation_not_found', 'ChatGPT could not find that thread.');
    const found = await client().readThread(id);
    if (!isDesktopThread(found)) {
      const owner = ownerOfThread(found);
      const hint = { t3: ' Schedule it with the T3 Code harness instead.', codex: ' Schedule it with the Codex harness instead.' }[owner] || ' Another Codex app owns it, so it cannot be scheduled here.';
      throw new HarnessError('owned_by_other_harness', `This thread was not created in the ChatGPT desktop app.${hint}`, { harness: owner });
    }
    return found;
  }
  // The turn this app started: the exact text, in a turn that began at or after the send attempt.
  // A turn without a start time (the protocol allows null) could be any earlier
  // turn with the same text, so it is never evidence.
  async function evidenceFor(threadId, text, since) {
    const floor = Date.parse(since || '') - SKEW_MS;
    if (!Number.isFinite(floor)) return null;
    const expected = normaliseText(text);
    for (const turn of await client().recentTurns(threadId)) {
      const started = Date.parse(isoOrNull(turn.startedAt) || '');
      if (!Number.isFinite(started) || started < floor) continue;
      if (userItems(turn).some((item) => normaliseText(userText(item)) === expected)) return { turnId: turn.id || null };
    }
    return null;
  }

  return defineHarness({
    id: 'codex-desktop', label: LABEL, kind: 'desktop-app', conversationNoun: 'thread',
    description: 'Types into Codex threads in the ChatGPT desktop app through macOS Accessibility. Needs the app open and the Mac unlocked.',
    capabilities: {
      canDiscoverConversations: true, canConfirmDelivery: true, canDetectUserActivity: true,
      canDetectCompletion: true, canDetectUsageLimit: true, canReportResetTime: true,
      requiresRunningApp: true, requiresUnlockedScreen: true, requiresAccessibilityPermission: true
    },
    settings: [],
    async checkConnection() {
      client();
      const env = await requireReady(automation, { bundleId: BUNDLE_ID, appLabel: LABEL, isLocked: async () => false });
      return { ok: true, version: env.apps[BUNDLE_ID].version || undefined };
    },
    async listConversations() {
      if (platform !== 'darwin') return [];
      return (await desktopThreads()).map((item) => conversation('codex-desktop', {
        id: item.id, title: item.name || String(item.preview || '').replace(/\s+/g, ' ').slice(0, 80) || 'Untitled thread',
        projectId: typeof item.cwd === 'string' ? item.cwd : '', projectName: typeof item.cwd === 'string' ? path.basename(item.cwd) : '',
        updatedAt: item.updatedAt, state: 'unknown', settled: null
      })).sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || a.id.localeCompare(b.id));
    },
    async inspectConversation(ref) {
      const item = await thread(ref.conversationId);
      const turns = await client().recentTurns(item.id);
      const userStarts = turns.filter((turn) => userItems(turn).length).map((turn) => isoOrNull(turn.startedAt)).filter(Boolean).sort();
      const delivered = Boolean(ref.deliveryKey && ref.dispatchAttemptedAt && ref.message) && Boolean(await evidenceFor(item.id, ref.message, ref.dispatchAttemptedAt));
      return conversationState({
        id: item.id, title: item.name || 'Untitled thread', projectId: item.cwd || '', projectName: item.cwd ? path.basename(item.cwd) : '',
        archived: item.archived === true || Boolean(item.archivedAt), latestUserActivityAt: userStarts.at(-1) || null, delivered,
        busy: inProgress(turns), awaitingInput: null, context: { name: item.name || '' }
      });
    },
    async prepareTurn(turn, state) {
      if (state.busy === true) throw new HarnessError('conversation_busy', 'Codex is still working in this thread. Nothing was sent.');
      const name = state.context?.name || '';
      // The open thread is identified by its title alone, so no other thread the
      // app could show may share it, whoever created it and even when archived.
      if (!name) throw new HarnessError('unsupported_response_shape', 'This thread has no name, so the open thread could not be verified in ChatGPT. Rename it in ChatGPT first.');
      const listings = await Promise.all([client().listAllThreads(), client().listAllThreads({ archived: true })]);
      if (listings.some((listing) => listing.complete !== true)) throw new HarnessError('conversation_busy', 'The ChatGPT threads could not all be checked for a duplicate name, so the open thread could not be verified. Nothing was sent.');
      const twins = new Set(listings.flatMap((listing) => listing.threads).filter((item) => item.name === name).map((item) => String(item.id).toLowerCase()));
      if (twins.size !== 1 || !twins.has(String(turn.conversationId).toLowerCase())) throw new HarnessError('conversation_busy', 'Another ChatGPT thread has the same name, so the open thread could not be verified. Rename one of them first.');
      // undefined means the lock holder could not be determined, which is treated as busy.
      const writer = await client().threadWriter(turn.conversationId);
      if (writer === undefined || (writer && writer.owner !== 'codex-desktop')) throw new HarnessError('conversation_busy', 'Another Codex process is writing to this thread. Nothing was sent.');
      return { deliveryKey: turn.messageId, plan: { threadId: turn.conversationId, name } };
    },
    async submitTurn(turn, plan) {
      const attemptedAt = turn.dispatchAttemptedAt || new Date(now()).toISOString();
      const evidence = await deliverThroughUi({
        automation, bundleId: BUNDLE_ID, appLabel: LABEL, noun: 'thread', text: turn.message, isLocked, now, sleep, timings,
        target: () => ({ bundleId: BUNDLE_ID, match: { title: plan.name }, ...TARGET }),
        link: { url: `codex://threads/${encodeURIComponent(plan.threadId)}`, schemes: ['codex'] },
        isBusy: async () => inProgress(await client().recentTurns(plan.threadId)),
        confirm: () => evidenceFor(plan.threadId, turn.message, attemptedAt)
      });
      return { turnId: evidence.turnId };
    },
    async findDelivery(turn) {
      return { delivered: Boolean(await evidenceFor(turn.conversationId, turn.message, turn.dispatchAttemptedAt)) };
    },
    async checkTurn(turn) {
      if (!turn.turnId) return { state: 'unknown' };
      const found = (await client().recentTurns(turn.conversationId)).find((item) => item.id === turn.turnId);
      if (!found) return { state: 'unknown' };
      const limit = found.status === 'failed' ? await client().rateLimits().catch(() => null) : null;
      return client().turnOutcome(found, limit);
    },
    async probeAvailability() {
      const checkedAt = new Date(now()).toISOString();
      if (await isLocked() === true) return { state: 'unavailable', resetsAt: null, reason: 'screen_locked', source: 'reported', checkedAt };
      const limit = await client().rateLimits();
      if (!limit) return { state: 'unknown', resetsAt: null, reason: '', source: 'none', checkedAt };
      return { state: limit.reached ? 'limited' : 'available', resetsAt: limit.reached ? limit.resetsAt : null, reason: limit.reached ? 'Codex reports a usage limit.' : '', source: 'reported', checkedAt };
    },
    async shutdown() { await reader?.close?.(); }
  });
}

module.exports = { BUNDLE_ID, TARGET, createCodexDesktopHarness, findAppBundledCodex };
