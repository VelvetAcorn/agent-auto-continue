'use strict';

// Claude Desktop "Code" sessions, driven through the app's own user interface.
// Discovery, activity, delivery evidence and outcomes come from the files
// Claude Desktop and its embedded Claude Code write (read by claude-sessions.js);
// only the send itself uses the interface, through the app's own deep link:
//   claude://code/continue?session=local_<uuid>
// The adapter never starts `claude`, so it is never a second writer, and the
// Claude Code adapter leaves these sessions to this one.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { conversation, conversationState, defineHarness } = require('./contract');
const { HarnessError } = require('./errors');
const sessions = require('./claude-sessions');
const { isScreenLocked } = require('./session-lock');
const { createAppLabels } = require('../desktop/app-labels');
const { createAppLocator } = require('../desktop/app-location');
const { checkDesktopCompatibility } = require('../desktop/compatibility');
const { createMacAutomation } = require('../desktop/mac-automation');
const { deliverThroughUi, normaliseText, requireReady } = require('../desktop/ui-delivery');
const { claudeDesktop: PROFILE, deepLinkFor } = require('../desktop/profiles');

// Every app-specific contact point comes from the profile.
const BUNDLE_ID = PROFILE.bundleId;
const LABEL = PROFILE.appLabel;
const SESSION_ID = PROFILE.conversationId;
const CONTROLS = PROFILE.controls;
// Clock skew allowed between this app and the transcript writer.
const SKEW_MS = 5_000;
// A usage sample older than this says nothing about the current limit.
const USAGE_FRESH_MS = 20 * 60_000;

// Live registry status of the loaded session. No live process means nothing is
// running. busy and awaitingInput come only from the reported status, and an
// unknown status is null, which never blocks. A process other than Claude
// Desktop (such as `claude --resume` in a terminal), or one that does not say
// which it is, would make the app a second writer, so it is marked elsewhere.
function liveState(live) {
  if (!live) return { busy: false, awaitingInput: null, label: 'idle' };
  const state = live.status === 'busy' ? { busy: true, awaitingInput: false, label: 'working' }
    : live.status === 'waiting' || live.status === 'blocked' ? { busy: false, awaitingInput: true, label: 'waiting' }
      : live.status === 'idle' ? { busy: false, awaitingInput: false, label: 'idle' }
        : { busy: null, awaitingInput: null, label: 'unknown' };
  return live.entrypoint === PROFILE.liveRegistry.entrypoint ? state : { ...state, label: 'open elsewhere', elsewhere: true };
}
const ELSEWHERE = 'This session is open in Claude Code outside Claude Desktop. Close it there first. Nothing was sent.';
const WAITING = 'Claude is waiting for your answer in this session. Nothing was sent.';

function createClaudeDesktopHarness({ home = os.homedir(), env = process.env, isAlive, automation = createMacAutomation(), isLocked = isScreenLocked, platform = process.platform,
  now = () => Date.now(), sleep, timings, appPath, exists = (file) => fs.existsSync(file) } = {}) {
  const options = { home, env, isAlive };
  // The app is located by bundle ID; pass `appPath` (or null for none) to fix it instead.
  const locator = createAppLocator({ profile: PROFILE, automation, home, exists, now });
  let appDir = appPath === undefined ? null : appPath;
  async function locateApp() {
    if (appPath !== undefined) return;
    appDir = (await locator.locate().catch(() => null))?.appPath || null;
  }
  const labelsFor = createAppLabels({ catalogueDirectory: () => (appDir ? path.join(appDir, PROFILE.bundledFiles.labelCatalogue.path) : null), controls: CONTROLS });

  async function session(id) {
    if (!SESSION_ID.test(id || '')) throw new HarnessError('conversation_not_found', 'Claude Desktop could not find that session.');
    const found = (await sessions.readDesktopCodeSessions(options)).find((item) => item.sessionId === id);
    if (!found) throw new HarnessError('conversation_not_found', 'Claude Desktop could not find that session on this Mac.');
    return found;
  }
  const live = (item) => sessions.readLiveSession(item.cliSessionId, options);
  const transcript = (item) => sessions.findTranscriptPath(item.cliSessionId, options);
  // The prompt this app sent: identical text, written at or after the send attempt.
  async function evidenceFor(item, text, since) {
    const file = since ? await transcript(item) : null;
    if (!file) return null;
    const floor = Date.parse(since) - SKEW_MS;
    const expected = normaliseText(text);
    return (await sessions.readHumanPrompts(file)).find((prompt) => Date.parse(prompt.timestamp) >= floor && normaliseText(prompt.text) === expected) || null;
  }
  function macOnly() {
    if (platform !== 'darwin') throw new HarnessError('harness_not_installed', 'Claude Desktop automation is only available on macOS.');
  }

  return defineHarness({
    id: 'claude-desktop', label: LABEL, kind: 'desktop-app', conversationNoun: 'session',
    description: 'Sends to Claude Desktop Code sessions through macOS Accessibility. Needs Claude Desktop open and the Mac unlocked.',
    capabilities: {
      canDiscoverConversations: true, canConfirmDelivery: true, canDetectUserActivity: true,
      canDetectCompletion: true, canDetectUsageLimit: true, canReportResetTime: false,
      requiresRunningApp: true, requiresUnlockedScreen: true, requiresAccessibilityPermission: true
    },
    settings: [],
    async checkConnection() {
      macOnly();
      const env = await requireReady(automation, { bundleId: BUNDLE_ID, appLabel: LABEL, isLocked: async () => false });
      return { ok: true, version: env.apps[BUNDLE_ID].version || undefined };
    },
    async listConversations() {
      if (platform !== 'darwin') return [];
      const [items, loaded] = await Promise.all([sessions.readDesktopCodeSessions(options), sessions.readLiveSessions(options)]);
      return items.filter((item) => !item.archived).map((item) => conversation('claude-desktop', {
        id: item.sessionId, title: item.title || 'Untitled session', projectId: item.cwd, projectName: item.cwd ? path.basename(item.cwd) : '',
        updatedAt: item.lastActivityAt, state: liveState(loaded.get(item.cliSessionId)).label, settled: null
      }));
    },
    async inspectConversation(ref) {
      const item = await session(ref.conversationId);
      const file = await transcript(item);
      const [scan, state, evidence] = await Promise.all([file ? sessions.scanTranscript(file, null) : null, live(item),
        ref.deliveryKey && ref.dispatchAttemptedAt && ref.message ? evidenceFor(item, ref.message, ref.dispatchAttemptedAt) : null]);
      const status = liveState(state);
      return conversationState({
        id: item.sessionId, title: item.title || 'Untitled session', projectId: item.cwd, projectName: item.cwd ? path.basename(item.cwd) : '',
        archived: item.archived, latestUserActivityAt: scan?.latestUserActivityAt || null, delivered: Boolean(evidence),
        busy: status.busy, awaitingInput: status.awaitingInput, context: { item, hasTranscript: Boolean(file), elsewhere: status.elsewhere === true }
      });
    },
    prepareTurn(turn, state) {
      macOnly();
      const item = state.context?.item;
      if (!item) throw new HarnessError('conversation_not_found', 'Claude Desktop could not find that session on this Mac.');
      if (!state.context.hasTranscript) throw new HarnessError('unsupported_response_shape', 'This Claude Desktop session has no transcript yet, so delivery could not be confirmed. Send one message in it first.');
      if (!item.cwd || !exists(item.cwd)) throw new HarnessError('conversation_not_found', 'The working folder for this Claude Desktop session no longer exists.');
      if (state.context.elsewhere) throw new HarnessError('conversation_busy', ELSEWHERE);
      if (state.awaitingInput === true) throw new HarnessError('awaiting_input', WAITING);
      if (state.busy === true) throw new HarnessError('conversation_busy', 'Claude is still working in this session. Nothing was sent.');
      return { deliveryKey: turn.messageId, plan: { sessionId: item.sessionId } };
    },
    async submitTurn(turn, plan) {
      const attemptedAt = turn.dispatchAttemptedAt || new Date(now()).toISOString();
      const item = await session(plan.sessionId);
      // The label catalogue lives inside the app, wherever it is installed.
      await locateApp();
      const evidence = await deliverThroughUi({
        automation, bundleId: BUNDLE_ID, appLabel: LABEL, verifiedVersion: PROFILE.verifiedVersion, noun: 'session', text: turn.message, isLocked, now, sleep, timings,
        target: (language) => {
          const labels = labelsFor(language);
          return { bundleId: BUNDLE_ID, match: { urlSegment: item.sessionId }, composerLabels: labels.composer, sendLabels: labels.send };
        },
        link: { url: deepLinkFor(PROFILE, item.sessionId), schemes: PROFILE.deepLink.schemes },
        // Re-checked right before typing and again before sending.
        isBusy: async () => {
          const status = liveState(await live(item));
          if (status.elsewhere) throw new HarnessError('conversation_busy', ELSEWHERE);
          if (status.awaitingInput === true) throw new HarnessError('awaiting_input', WAITING);
          return status.busy;
        },
        confirm: () => evidenceFor(item, turn.message, attemptedAt)
      });
      return { turnId: evidence.uuid || null };
    },
    async findDelivery(turn) {
      return { delivered: Boolean(await evidenceFor(await session(turn.conversationId), turn.message, turn.dispatchAttemptedAt)) };
    },
    // Read-only: never navigates, types or changes focus. Per-app file probes belong in `probes`.
    async checkCompatibility({ depth = 'full' } = {}) {
      return checkDesktopCompatibility({ profile: PROFILE, automation, depth, isLocked, exists, now, sleep,
        // A session whose agent is working or waiting may show approval controls instead of the message box.
        isBusy: async (shown) => {
          const item = (await sessions.readDesktopCodeSessions(options)).find((entry) => entry.sessionId === shown.conversationId);
          if (!item) return null;
          const status = liveState(await live(item));
          return status.busy === true || status.awaitingInput === true;
        } });
    },
    async checkTurn(turn) {
      const item = await session(turn.conversationId);
      const file = turn.turnId ? await transcript(item) : null;
      if (!file) return { state: 'unknown' };
      const status = liveState(await live(item));
      return sessions.turnOutcomeAfter(file, turn.turnId, { running: status.busy === true || status.awaitingInput === true, now: now() });
    },
    async probeAvailability() {
      const checkedAt = new Date(now()).toISOString();
      if (await isLocked() === true) return { state: 'unavailable', resetsAt: null, reason: 'screen_locked', source: 'reported', checkedAt };
      const usage = await sessions.readClaudePlanUsage(options).catch(() => null);
      const sampledAt = Date.parse(usage?.sampledAt || '');
      if (!usage || !Number.isFinite(sampledAt) || now() - sampledAt > USAGE_FRESH_MS) return { state: 'unknown', resetsAt: null, reason: '', source: 'none', checkedAt };
      const limited = usage.fiveHourPct >= 100 || usage.sevenDayPct >= 100;
      return { state: limited ? 'limited' : 'available', resetsAt: null, source: 'inferred', checkedAt,
        reason: limited ? `Claude Desktop shows ${usage.fiveHourPct >= 100 ? 'the 5-hour' : 'the weekly'} usage limit reached.` : '' };
    }
  });
}

module.exports = { BUNDLE_ID, CONTROLS, createClaudeDesktopHarness };
