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
// The Codex adapter leaves desktop-originated threads to this one. A protocol
// reply this version cannot read is reported as an app change (contact point
// `app_server`), and an unknown turn status never reads as idle. Threads the
// app creates under an originator this version does not know are never
// claimed, but are reported (contact point `originator`) instead of looking
// like an empty thread list.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compatibility, conversation, conversationState, defineHarness, isoOrNull } = require('./contract');
const { HarnessError, appVersionUnsupported, driftMessage } = require('./errors');
const { isScreenLocked } = require('./session-lock');
const { createAppLocator, expandHome } = require('../desktop/app-location');
const { checkDesktopCompatibility } = require('../desktop/compatibility');
const { createMacAutomation } = require('../desktop/mac-automation');
const { deliverThroughUi, normaliseText, requireReady } = require('../desktop/ui-delivery');
const { TOP_LEVEL_SOURCE_KINDS, createCodexReader, isDesktopThread, ownerOfThread, threadShapeProblem, turnShapeProblem, unrecognisedDesktopOriginators } = require('./codex-reader');
const { codexDesktop: PROFILE, deepLinkFor } = require('../desktop/profiles');

// Every app-specific contact point comes from the profile.
const BUNDLE_ID = PROFILE.bundleId;
const LABEL = PROFILE.appLabel;
const SKEW_MS = 5_000;
const THREAD_ID = PROFILE.conversationId;
// The app ships no readable message catalogue, so only English labels are known.
const TARGET = Object.freeze({ composerLabels: PROFILE.controls.composer.english, sendLabels: PROFILE.controls.send.english, stopLabels: PROFILE.controls.stop.english });

// Reader methods that speak the app-server protocol of the codex binary inside
// the app, so a reply this version cannot read means the app changed.
const PROTOCOL_METHODS = Object.freeze(['listThreads', 'listAllThreads', 'readThread', 'recentTurns', 'rateLimits', 'withClient', 'serverVersion']);
// JSON-RPC errors that mean a method or its parameters no longer exist.
const PROTOCOL_RPC_CODES = Object.freeze([-32601, -32602]);
// How many of the newest threads the compatibility check reads turns from.
const PROBE_THREADS = 3;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const quotedOriginator = (value) => (value === null ? 'no originator' : JSON.stringify(value.slice(0, 40)));
const KNOWN_ORIGINATORS = PROFILE.originators['codex-desktop'].exact.map((value) => JSON.stringify(value)).join(' or ');
const unreadable = (method, what) => new HarnessError('unsupported_response_shape', 'Codex returned an unsupported reply. Check that Codex is up to date.', { method, what });

function userText(item) {
  if (typeof item?.text === 'string') return item.text;
  return (Array.isArray(item?.content) ? item.content : []).filter((part) => isObject(part) && part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
}
function userItems(turn) {
  return (Array.isArray(turn?.items) ? turn.items : []).filter((item) => isObject(item) && item.type === 'userMessage');
}
// Turns come through the guarded reader, so every status here is a known one.
function inProgress(turns) {
  return turns.some((turn) => turn.status === 'inProgress');
}
// Busy detection and delivery evidence read every turn, so one with an unknown
// status or shape stops them instead of being skipped (an unknown status could
// be a running turn).
function knownTurns(turns) {
  for (const turn of turns) {
    const problem = turnShapeProblem(turn);
    if (problem) throw unreadable('thread/turns/list', problem);
  }
  return turns;
}

// A title that is a thread name with more text around it, such as
// "Name - ChatGPT", means the app changed how it titles a thread. The name must
// meet the extra text at a non-word character, and names under three
// characters are ignored. Returns { position: 'before' | 'after', extra } with
// only the extra text's length, so no title reaches logs, or null.
function embeddedName(title, names) {
  let best = null;
  for (const name of names) {
    if (typeof name !== 'string' || name.length < 3 || typeof title !== 'string' || title === name) continue;
    const found = title.startsWith(name) && /^\W/.test(title.slice(name.length)) ? 'after' : title.endsWith(name) && /\W$/.test(title.slice(0, -name.length)) ? 'before' : null;
    if (found && (!best || name.length > best.length)) best = { position: found, extra: title.length - name.length, length: name.length };
  }
  return best && { position: best.position, extra: best.extra };
}
const embeddedHint = (embedded) => `the thread name with ${embedded.extra} more characters ${embedded.position} it`;

// The bundled codex binary in the first usual install location, without asking
// Launch Services. The adapter itself locates the app by bundle ID first.
function findAppBundledCodex(exists = (file) => fs.existsSync(file), home = os.homedir()) {
  for (const app of PROFILE.appCandidates) {
    const file = path.join(expandHome(app, home), PROFILE.bundledFiles.codex.path);
    if (exists(file)) return file;
  }
  return null;
}

// Reads go through a private app-server started from the app-bundled binary;
// they never load the thread for writing, so the app stays its only writer.
// The binary is found inside the app located by bundle ID; `codexPath`
// (sync or async, returning a path or null) replaces that lookup.
function createCodexDesktopHarness({ env = process.env, home = os.homedir(), createReader = (options) => createCodexReader({ ...options, env, home, transport: 'private' }), automation = createMacAutomation(), isLocked = isScreenLocked, platform = process.platform, now = () => Date.now(), sleep, timings, codexPath, exists = (file) => fs.existsSync(file) } = {}) {
  const locator = createAppLocator({ profile: PROFILE, automation, home, exists, now });
  let reader = null;
  let readerPath = null;
  // A reply this version cannot read, or a request the bundled codex no longer
  // accepts, is an app change; any other failure keeps its own code.
  async function protocolDrift(error) {
    const details = error instanceof HarnessError && error.code === 'unsupported_response_shape' ? error.details || {} : null;
    if (!details || !(details.what || PROTOCOL_RPC_CODES.includes(details.rpcCode))) return error;
    const app = await locator.locate().catch(() => null);
    const method = details.method || 'A request';
    return appVersionUnsupported({ app: LABEL, appVersion: app?.appVersion || null, verifiedVersion: PROFILE.verifiedVersion, contactPoint: 'app_server', during: 'read',
      hint: details.what ? `${method} returned ${details.what}.` : `${method} was rejected with JSON-RPC error ${details.rpcCode}.` });
  }
  function guarded(raw) {
    const guardedReader = { ...raw };
    for (const name of PROTOCOL_METHODS) {
      if (typeof raw[name] !== 'function') continue;
      guardedReader[name] = async (...args) => {
        try {
          const value = await raw[name](...args);
          return name === 'recentTurns' ? knownTurns(value) : value;
        } catch (error) { throw await protocolDrift(error); }
      };
    }
    return guardedReader;
  }
  async function executable() {
    if (codexPath === undefined) return locator.requireBundledFile('codex', { what: 'bundled codex binary' });
    const file = await codexPath();
    if (!file) throw new HarnessError('harness_not_installed', 'The ChatGPT desktop app with Codex was not found in Applications.');
    return file;
  }
  async function client() {
    if (platform !== 'darwin') throw new HarnessError('harness_not_installed', 'ChatGPT desktop automation is only available on macOS.');
    const file = await executable();
    // A moved or updated app gets a reader for its own binary.
    if (!reader || readerPath !== file) { await reader?.close?.(); reader = guarded(createReader({ executable: file })); readerPath = file; }
    return reader;
  }
  const ownThreads = (threads) => threads.filter((item) => THREAD_ID.test(item.id || '') && isDesktopThread(item));
  async function desktopThreads() {
    return ownThreads(await (await client()).listThreads());
  }
  // Originators the app now seems to create its threads with that this version
  // does not recognise; see unrecognisedDesktopOriginators() for the evidence.
  async function originatorDrift(threads) {
    const codex = await client();
    const [writers, appCodexVersion, app] = await Promise.all([
      codex.threadWriters ? codex.threadWriters().catch(() => null) : null,
      codex.serverVersion ? codex.serverVersion().catch(() => null) : null,
      locator.locate().catch(() => null)
    ]);
    return { drifted: unrecognisedDesktopOriginators(threads, { writers, appCodexVersion }), appCodexVersion, appVersion: app?.appVersion || null };
  }
  function originatorHint({ appCodexVersion }, group) {
    const count = `${group.threads} recent thread${group.threads === 1 ? '' : 's'}`;
    const sources = group.sources.map((value) => String(value).slice(0, 20)).join(', ');
    return `${count} with ${group.originator === null ? 'no originator' : `originator ${quotedOriginator(group.originator)}`} (source ${sources}): the app holds the writer lock of one, and its bundled codex ${appCodexVersion} created one. Recognised: ${KNOWN_ORIGINATORS}.`;
  }
  function originatorMessage({ appVersion }, group, consequence) {
    const as = group.originator === null ? 'without an originator' : `as ${quotedOriginator(group.originator)}`;
    return `${appVersion ? `${LABEL} ${appVersion}` : LABEL} creates its threads ${as}, which this version of Agent Auto-Continue does not recognise yet, so ${consequence}.`;
  }
  function originatorError(drift, group, consequence) {
    const error = appVersionUnsupported({ app: LABEL, appVersion: drift.appVersion, verifiedVersion: PROFILE.verifiedVersion, contactPoint: 'originator', during: 'read', hint: originatorHint(drift, group) });
    error.message = originatorMessage(drift, group, consequence);
    return error;
  }
  async function thread(id) {
    if (!THREAD_ID.test(id || '')) throw new HarnessError('conversation_not_found', 'ChatGPT could not find that thread.');
    const found = await (await client()).readThread(id);
    if (!isDesktopThread(found)) {
      const owner = ownerOfThread(found);
      // Still never claimed, but a thread the app made under a renamed originator says so.
      if (owner === 'other') {
        const drift = await originatorDrift(await (await client()).listThreads()).catch(() => null);
        const group = drift?.drifted.find((item) => item.originator === (typeof found.originator === 'string' ? found.originator : null));
        if (group) throw originatorError(drift, group, 'Agent Auto-Continue cannot schedule this thread yet');
      }
      const hint = { t3: ' Schedule it with the T3 Code harness instead.', codex: ' Schedule it with the Codex harness instead.' }[owner] || ' Another Codex app owns it, so it cannot be scheduled here.';
      throw new HarnessError('owned_by_other_harness', `This thread was not created in the ChatGPT desktop app.${hint}`, { harness: owner });
    }
    return found;
  }
  // Read-only check, through one short-lived connection to the app-bundled
  // codex, that the replies this harness depends on keep their shape:
  // thread/list, thread/turns/list of the newest threads (statuses, start times
  // and userMessage items) and account/rateLimits/read.
  async function checkProtocol() {
    let turns = 0;
    let withUser = 0;
    let withText = 0;
    await (await client()).withClient(async (rpc) => {
      const list = await rpc.request('thread/list', { limit: 20, sortKey: 'created_at', archived: false, sourceKinds: TOP_LEVEL_SOURCE_KINDS });
      if (!Array.isArray(list?.data)) throw unreadable('thread/list', 'no data list');
      const odd = list.data.map(threadShapeProblem).find(Boolean);
      if (odd) throw unreadable('thread/list', odd);
      for (const item of list.data.filter((entry) => !entry.parentThreadId && !entry.ephemeral).slice(0, PROBE_THREADS)) {
        const page = await rpc.request('thread/turns/list', { threadId: item.id, limit: 5 });
        if (!Array.isArray(page?.data)) throw unreadable('thread/turns/list', 'no data list');
        for (const turn of knownTurns(page.data)) {
          const messages = userItems(turn);
          turns += 1;
          if (messages.length) withUser += 1;
          if (messages.some((message) => userText(message))) withText += 1;
        }
      }
      // Turns start from a message, so recent turns without one mean user
      // activity and delivery evidence can no longer be read.
      if (turns && !withUser) throw unreadable('thread/turns/list', `${turns} recent turns with no userMessage item`);
      if (withUser && !withText) throw unreadable('thread/turns/list', 'userMessage items with no text part');
      const limits = await rpc.request('account/rateLimits/read', null);
      if (!isObject(limits) || !(limits.rateLimits === null || isObject(limits.rateLimits))) throw unreadable('account/rateLimits/read', 'no rateLimits');
    });
    return turns ? { checked: ['app_server'] } : { unchecked: [{ contactPoint: 'app_server', reason: 'no_turns' }] };
  }

  // Read-only check that threads made by the app's current codex build still
  // carry a recognised originator, and that no unrecognised one shows the app's
  // signals. Only the newest page of threads is read.
  async function checkOriginators() {
    const { threads } = await (await client()).listAllThreads({ maxPages: 1 });
    const drift = await originatorDrift(threads);
    if (drift.drifted.length) {
      const group = drift.drifted[0];
      return { problems: [{ contactPoint: 'originator', hint: originatorHint(drift, group) }], message: originatorMessage(drift, group, 'its new threads are not listed and cannot be scheduled until Agent Auto-Continue supports this version') };
    }
    if (!drift.appCodexVersion) return { unchecked: [{ contactPoint: 'originator', reason: 'unknown_version' }] };
    const proven = ownThreads(threads).some((item) => item.cliVersion === drift.appCodexVersion);
    return proven ? { checked: ['originator'] } : { unchecked: [{ contactPoint: 'originator', reason: 'no_recent_threads' }] };
  }

  // Why a thread opened by its deep link never matched by title, from a
  // read-only look at what the app shows now: a view with a message box whose
  // title embeds the name, or one the link brought up under a title that is no
  // thread's name, means the title format changed. A view the link did not
  // change, or another thread, points at the link instead (null).
  async function explainMismatch(name, before) {
    const listed = await automation.contentAreas(BUNDLE_ID);
    if (!listed?.ok || !Array.isArray(listed.areas)) return null;
    const earlier = Array.isArray(before?.areas) ? new Set(before.areas.map((area) => area.title)) : null;
    const known = new Set((await (await client()).listThreads().catch(() => [])).map((item) => item.name).filter(Boolean));
    for (const area of listed.areas) {
      if (!area.title || area.title === name) continue;
      const embedded = embeddedName(area.title, [name]);
      if (!embedded && (!earlier || earlier.has(area.title) || known.has(area.title))) continue;
      const view = await automation.inspect({ bundleId: BUNDLE_ID, match: { title: area.title }, ...TARGET });
      if (!view?.ok || !view.composer) continue;
      return { contactPoint: 'content_match', hint: embedded
        ? `A thread view with a message box appeared, but its title is ${embeddedHint(embedded)}.`
        : `A view with a message box appeared after the link opened, but its title (${area.title.length} characters) is not the thread name.` };
    }
    return null;
  }

  // The turn this app started: the exact text, in a turn that began at or after the send attempt.
  // A turn without a start time (the protocol allows null) could be any earlier
  // turn with the same text, so it is never evidence.
  async function evidenceFor(threadId, text, since) {
    const floor = Date.parse(since || '') - SKEW_MS;
    if (!Number.isFinite(floor)) return null;
    const expected = normaliseText(text);
    for (const turn of await (await client()).recentTurns(threadId)) {
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
      await client();
      const env = await requireReady(automation, { bundleId: BUNDLE_ID, appLabel: LABEL, isLocked: async () => false });
      return { ok: true, version: env.apps[BUNDLE_ID].version || undefined };
    },
    async listConversations() {
      if (platform !== 'darwin') return [];
      const threads = await (await client()).listThreads();
      const own = ownThreads(threads);
      // No recognised thread at all may mean the app renamed its originator: say so instead of listing nothing.
      if (!own.length && threads.length) {
        const drift = await originatorDrift(threads);
        if (drift.drifted.length) throw originatorError(drift, drift.drifted[0], 'its threads are not listed here until Agent Auto-Continue supports this version');
      }
      return own.map((item) => conversation('codex-desktop', {
        id: item.id, title: item.name || String(item.preview || '').replace(/\s+/g, ' ').slice(0, 80) || 'Untitled thread',
        projectId: typeof item.cwd === 'string' ? item.cwd : '', projectName: typeof item.cwd === 'string' ? path.basename(item.cwd) : '',
        updatedAt: item.updatedAt, state: 'unknown', settled: null
      })).sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || a.id.localeCompare(b.id));
    },
    async inspectConversation(ref) {
      const item = await thread(ref.conversationId);
      const turns = await (await client()).recentTurns(item.id);
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
      const codex = await client();
      const listings = await Promise.all([codex.listAllThreads(), codex.listAllThreads({ archived: true })]);
      if (listings.some((listing) => listing.complete !== true)) throw new HarnessError('conversation_busy', 'The ChatGPT threads could not all be checked for a duplicate name, so the open thread could not be verified. Nothing was sent.');
      const twins = new Set(listings.flatMap((listing) => listing.threads).filter((item) => item.name === name).map((item) => String(item.id).toLowerCase()));
      if (twins.size !== 1 || !twins.has(String(turn.conversationId).toLowerCase())) throw new HarnessError('conversation_busy', 'Another ChatGPT thread has the same name, so the open thread could not be verified. Rename one of them first.');
      // undefined means the lock holder could not be determined, which is treated as busy.
      const writer = await codex.threadWriter(turn.conversationId);
      if (writer === undefined || (writer && writer.owner !== 'codex-desktop')) throw new HarnessError('conversation_busy', 'Another Codex process is writing to this thread. Nothing was sent.');
      return { deliveryKey: turn.messageId, plan: { threadId: turn.conversationId, name } };
    },
    async submitTurn(turn, plan) {
      const attemptedAt = turn.dispatchAttemptedAt || new Date(now()).toISOString();
      const evidence = await deliverThroughUi({
        automation, bundleId: BUNDLE_ID, appLabel: LABEL, verifiedVersion: PROFILE.verifiedVersion, noun: 'thread', text: turn.message, isLocked, now, sleep, timings,
        target: () => ({ bundleId: BUNDLE_ID, match: { title: plan.name }, ...TARGET }),
        link: { url: deepLinkFor(PROFILE, plan.threadId), schemes: PROFILE.deepLink.schemes,
          snapshot: () => automation.contentAreas(BUNDLE_ID), explain: (before) => explainMismatch(plan.name, before) },
        isBusy: async () => inProgress(await (await client()).recentTurns(plan.threadId)),
        confirm: () => evidenceFor(plan.threadId, turn.message, attemptedAt)
      });
      return { turnId: evidence.turnId };
    },
    async findDelivery(turn) {
      return { delivered: Boolean(await evidenceFor(turn.conversationId, turn.message, turn.dispatchAttemptedAt)) };
    },
    // Read-only: never navigates, types or changes focus. The protocol probe only reads.
    async checkCompatibility({ depth = 'full' } = {}) {
      // Problems whose generic wording would mislead get the adapter's own message.
      const messages = {};
      let titleDrift = null;
      const originators = async () => {
        const found = await checkOriginators();
        if (found.message) messages.originator = found.message;
        return found;
      };
      const result = await checkDesktopCompatibility({ profile: PROFILE, automation, depth, isLocked, exists, now, sleep,
        // Every thread's content area has the same URL, so a shown thread is recognised by its name.
        pickConversation: async (areas) => {
          const titled = areas.filter((area) => area.title);
          if (!titled.length) return null;
          const threads = await (await client()).listThreads().catch(() => []);
          const own = ownThreads(threads);
          for (const area of titled) {
            const found = own.filter((item) => item.name === area.title);
            if (found.length === 1) return { match: { title: area.title }, conversationId: found[0].id, language: area.language || '' };
          }
          // No title is a thread name. One that embeds a name, in a view with a
          // message box, means the app changed how it titles threads; any
          // other page (such as the start page) proves nothing.
          const names = threads.map((item) => item.name);
          if (titled.some((area) => names.includes(area.title))) return null;
          for (const area of titled) {
            const embedded = embeddedName(area.title, names);
            if (!embedded) continue;
            const view = await automation.inspect({ bundleId: BUNDLE_ID, match: { title: area.title }, ...TARGET }).catch(() => null);
            if (view?.ok && view.composer) { titleDrift = embedded; break; }
          }
          return null;
        },
        isBusy: async (shown) => inProgress(await (await client()).recentTurns(shown.conversationId)),
        probes: [{ contactPoints: ['app_server'], depth: 'full', run: checkProtocol }, { contactPoints: ['originator'], depth: 'full', run: originators }] });
      const problems = result.problems.map((item) => (messages[item.contactPoint] ? { ...item, message: messages[item.contactPoint] } : item));
      if (titleDrift) {
        problems.push({ contactPoint: 'content_match', hint: `A thread view with a message box is shown, but its title is ${embeddedHint(titleDrift)}.`,
          message: driftMessage({ app: LABEL, appVersion: result.appVersion, verifiedVersion: PROFILE.verifiedVersion, contactPoint: 'content_match', during: 'check' }) });
      }
      const failed = new Set(problems.map((item) => item.contactPoint));
      return compatibility({ ...result, problems, checked: result.checked.filter((point) => !failed.has(point)), unchecked: result.unchecked.filter((item) => !failed.has(item.contactPoint)) });
    },
    async checkTurn(turn) {
      if (!turn.turnId) return { state: 'unknown' };
      const codex = await client();
      const found = (await codex.recentTurns(turn.conversationId)).find((item) => item.id === turn.turnId);
      if (!found) return { state: 'unknown' };
      const limit = found.status === 'failed' ? await codex.rateLimits().catch(() => null) : null;
      return codex.turnOutcome(found, limit);
    },
    async probeAvailability() {
      const checkedAt = new Date(now()).toISOString();
      if (await isLocked() === true) return { state: 'unavailable', resetsAt: null, reason: 'screen_locked', source: 'reported', checkedAt };
      const limit = await (await client()).rateLimits();
      if (!limit) return { state: 'unknown', resetsAt: null, reason: '', source: 'none', checkedAt };
      return { state: limit.reached ? 'limited' : 'available', resetsAt: limit.reached ? limit.resetsAt : null, reason: limit.reached ? 'Codex reports a usage limit.' : '', source: 'reported', checkedAt };
    },
    async shutdown() { await reader?.close?.(); }
  });
}

module.exports = { BUNDLE_ID, TARGET, createCodexDesktopHarness, findAppBundledCodex };
