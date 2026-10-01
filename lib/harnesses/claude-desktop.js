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
const { HarnessError, appVersionUnsupported } = require('./errors');
const sessions = require('./claude-sessions');
const { createClaudeDesktopProbes } = require('./claude-desktop-probes');
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

// Live registry state of the loaded session. No live process means nothing is
// running. busy and awaitingInput come only from the reported status; a process
// that has just started and reports none yet counts as working. A status this
// version does not know, or none at all later, means Claude Code changed how it
// reports its state, so the session cannot be judged: `drift` says what changed
// and sending refuses. A process other than Claude Desktop (such as
// `claude --resume` in a terminal), or one that does not say which it is, would
// make the app a second writer, so it is marked elsewhere.
function liveState(live) {
  if (!live) return { busy: false, awaitingInput: null, label: 'idle' };
  if (live.state === 'unrecognised') return { busy: null, awaitingInput: null, label: 'unknown', drift: live.drift };
  const state = live.state === 'busy' || live.state === 'starting' ? { busy: true, awaitingInput: false, label: 'working' }
    : live.state === 'waiting' ? { busy: false, awaitingInput: true, label: 'waiting' }
      : { busy: false, awaitingInput: false, label: 'idle' };
  return live.entrypoint === PROFILE.liveRegistry.entrypoint ? state : { ...state, label: 'open elsewhere', elsewhere: true };
}
const ELSEWHERE = 'This session is open in Claude Code outside Claude Desktop. Close it there first. Nothing was sent.';
const WAITING = 'Claude is waiting for your answer in this session. Nothing was sent.';

function createClaudeDesktopHarness({ home = os.homedir(), env = process.env, isAlive, automation = createMacAutomation(), isLocked = isScreenLocked, platform = process.platform,
  now = () => Date.now(), sleep, timings, appPath, exists = (file) => fs.existsSync(file), processes } = {}) {
  const options = { home, env, isAlive, now };
  // Read-only file probes for checkCompatibility(); `processes` replaces the process table in tests.
  const probes = createClaudeDesktopProbes({ options, ...(processes ? { processes } : {}) });
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
  // The session's live state, with `drift` set when the registry cannot be
  // trusted for it: its own entry is unrecognised, or a live entry names no
  // session and so could be this one.
  async function live(item) {
    const registry = await sessions.readLiveRegistry(options);
    const status = liveState(registry.sessions.get(item.cliSessionId));
    return { ...status, drift: status.drift || registry.unidentified[0]?.hint || '' };
  }
  // The installed version, for drift messages; null when it cannot be read.
  const installedVersion = async () => (await locator.locate().catch(() => null))?.appVersion || null;
  const drift = ({ contactPoint, hint, appVersion = null, during = 'send' }) => appVersionUnsupported({ app: LABEL, appVersion, verifiedVersion: PROFILE.verifiedVersion, contactPoint, hint, during });
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
      const [items, registry] = await Promise.all([sessions.readDesktopCodeSessions(options), sessions.readLiveRegistry(options)]);
      return items.filter((item) => !item.archived).map((item) => conversation('claude-desktop', {
        id: item.sessionId, title: item.title || 'Untitled session', projectId: item.cwd, projectName: item.cwd ? path.basename(item.cwd) : '',
        updatedAt: item.lastActivityAt, state: liveState(registry.sessions.get(item.cliSessionId)).label, settled: null
      }));
    },
    async inspectConversation(ref) {
      const item = await session(ref.conversationId);
      const file = await transcript(item);
      const [scan, state, evidence] = await Promise.all([file ? sessions.scanTranscript(file, null) : null, live(item),
        ref.deliveryKey && ref.dispatchAttemptedAt && ref.message ? evidenceFor(item, ref.message, ref.dispatchAttemptedAt) : null]);
      // A change found here refuses in prepareTurn(), with the installed version in its message.
      // Without a readable transcript, user activity and delivery evidence would silently go missing.
      const found = state.drift ? { contactPoint: 'live_registry', hint: state.drift }
        : scan?.drift ? { contactPoint: 'transcript', hint: scan.drift, during: 'read' } : null;
      return conversationState({
        id: item.sessionId, title: item.title || 'Untitled session', projectId: item.cwd, projectName: item.cwd ? path.basename(item.cwd) : '',
        archived: item.archived, latestUserActivityAt: scan?.latestUserActivityAt || null, delivered: Boolean(evidence),
        busy: state.drift ? null : state.busy, awaitingInput: state.drift ? null : state.awaitingInput,
        context: { item, hasTranscript: Boolean(file), elsewhere: state.elsewhere === true, drift: found && { ...found, appVersion: await installedVersion() } }
      });
    },
    prepareTurn(turn, state) {
      macOnly();
      const item = state.context?.item;
      if (!item) throw new HarnessError('conversation_not_found', 'Claude Desktop could not find that session on this Mac.');
      if (state.context.drift) throw drift(state.context.drift);
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
          // A stop button near the message box means Claude is working, whatever the registry says.
          return { bundleId: BUNDLE_ID, match: { urlSegment: item.sessionId }, composerLabels: labels.composer, sendLabels: labels.send, stopLabels: labels.stop };
        },
        link: { url: deepLinkFor(PROFILE, item.sessionId), schemes: PROFILE.deepLink.schemes },
        // Re-checked right before typing and again before sending.
        isBusy: async () => {
          const status = await live(item);
          if (status.drift) throw drift({ contactPoint: 'live_registry', hint: status.drift, appVersion: await installedVersion() });
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
    // Read-only: never navigates, types or changes focus.
    async checkCompatibility({ depth = 'full' } = {}) {
      return checkDesktopCompatibility({ profile: PROFILE, automation, depth, isLocked, exists, now, sleep, probes,
        // A session whose agent is working or waiting may show approval controls instead of the message box.
        isBusy: async (shown) => {
          const item = (await sessions.readDesktopCodeSessions(options)).find((entry) => entry.sessionId === shown.conversationId);
          if (!item) return null;
          const status = await live(item);
          // A state that cannot be read may hide a working agent; the registry probe reports the change.
          return Boolean(status.drift) || status.busy === true || status.awaitingInput === true;
        } });
    },
    async checkTurn(turn) {
      const item = await session(turn.conversationId);
      const file = turn.turnId ? await transcript(item) : null;
      if (!file) return { state: 'unknown' };
      const status = await live(item);
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
