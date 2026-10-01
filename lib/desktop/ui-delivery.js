'use strict';

// One careful, verifiable delivery through a desktop app's user interface.
// The sequence is shared by every desktop-app adapter:
//   1. check the app, Accessibility permission and an unlocked screen;
//   2. show the target conversation, opening the app's own deep link if needed;
//   3. refuse while the agent is busy or the composer holds a user's draft;
//   4. set the composer text through AXValue and read it back;
//   5. press the verified send button with AXPress;
//   6. wait for persisted evidence that the message arrived;
//   7. give the front back to the app the user was using.
// Nothing is typed with synthetic key events, and each write re-verifies the
// conversation in the same Accessibility pass. Failures before the press are
// certain non-deliveries; any doubt after it is reported as uncertain.
const { HarnessError } = require('../harnesses/errors');
const { isScreenLocked } = require('../harnesses/session-lock');
const { ACCESSIBILITY_SETTINGS_URL } = require('./mac-automation');

const LOGIN_WINDOW = 'com.apple.loginwindow';
const DEFAULT_TIMINGS = Object.freeze({ navigateMs: 15_000, confirmMs: 45_000, pollMs: 500 });

// Mirrors normalise() in jxa-program.js so both sides compare the same text.
function normaliseText(value) {
  return String(value ?? '').replace(/ /g, ' ').replace(/\s+$/u, '');
}

let queue = Promise.resolve();
// Desktop deliveries share the screen and focus, so they run one at a time.
function serialise(task) {
  const result = queue.then(task, task);
  queue = result.catch(() => {});
  return result;
}

function certain(code, message, details = {}) { return new HarnessError(code, message, details, false); }

function permissionError(appLabel) {
  return certain('permission_required', `Allow Agent Auto-Continue in System Settings > Privacy & Security > Accessibility so it can send messages in ${appLabel}.`,
    { permission: 'accessibility', settingsUrl: ACCESSIBILITY_SETTINGS_URL });
}
function lockedError(appLabel) {
  return certain('screen_locked', `The Mac is locked, so ${appLabel} cannot be used. Leave the Mac unlocked for desktop app schedules.`);
}

// Checks that the app can be driven right now. Throws a certain failure otherwise.
async function requireReady(automation, { bundleId, appLabel, isLocked = isScreenLocked }) {
  const env = await automation.environment([bundleId]);
  const app = env.apps?.[bundleId];
  if (!app?.installedPath) throw certain('harness_not_installed', `${appLabel} is not installed.`);
  if (env.trusted !== true) throw permissionError(appLabel);
  if (!app.running) throw certain('connection_refused', `${appLabel} is not running. Open it and try again.`);
  if (env.screenLocked || env.onConsole === false || await isLocked() === true) throw lockedError(appLabel);
  return env;
}

function failure(reason, appLabel, noun) {
  if (reason === 'untrusted') return permissionError(appLabel);
  if (reason === 'screen_locked') return lockedError(appLabel);
  const messages = {
    not_running: ['connection_refused', `${appLabel} is not running. Open it and try again.`],
    no_window: ['connection_refused', `${appLabel} has no open window. Open it and try again.`],
    content_mismatch: ['conversation_not_found', `${appLabel} is not showing the ${noun}. Nothing was sent.`],
    composer_missing: ['unsupported_response_shape', `The message box in ${appLabel} was not found. This version of ${appLabel} may not be supported. Nothing was sent.`],
    composer_not_empty: ['conversation_busy', `The ${noun} in ${appLabel} has an unsent draft, so it was left untouched. Nothing was sent.`],
    value_mismatch: ['unexpected', `The message box in ${appLabel} changed before sending. Nothing was sent.`],
    send_missing: ['unsupported_response_shape', `The send button in ${appLabel} was not found. Nothing was sent.`],
    send_disabled: ['unexpected', `${appLabel} did not enable its send button. Nothing was sent.`],
    write_failed: ['unexpected', `${appLabel} did not accept the message text. Nothing was sent.`]
  };
  const [code, message] = messages[reason] || ['unexpected', `${appLabel} could not be automated. Nothing was sent.`];
  return certain(code, message, { reason: String(reason || 'unknown').slice(0, 40) });
}

async function restoreFront(automation, bundleId, previous) {
  if (!previous?.pid || !previous.bundleId || [bundleId, LOGIN_WINDOW].includes(previous.bundleId)) return;
  try {
    const env = await automation.environment([]);
    if (env.frontmost?.bundleId === bundleId) await automation.activate(previous.pid);
  } catch { /* Focus restoration is best effort and never changes the delivery outcome. */ }
}

// `target(language)` returns the Accessibility target for the app's UI language,
// which is only known once the conversation's content area has been read.
async function deliver({ automation, bundleId, appLabel, noun, target, link, text, isBusy = async () => null, confirm, timings = {}, sleep, now = Date.now, isLocked }) {
  const { navigateMs, confirmMs, pollMs } = { ...DEFAULT_TIMINGS, ...timings };
  const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const expected = normaliseText(text);
  const env = await requireReady(automation, { bundleId, appLabel, isLocked });
  const previous = env.frontmost;
  let language = '';
  let current = target(language);
  async function look() {
    let view = await automation.inspect(current);
    const found = view.content?.language || '';
    if (view.ok && found && found !== language) {
      language = found;
      current = target(language);
      view = await automation.inspect(current);
    }
    return view;
  }
  let typed = false;
  let navigated = false;
  try {
    // 2. Show the conversation. The app's own deep link is the only navigation used.
    let view = await look();
    if (!view.ok && view.error === 'content_mismatch' && link) {
      navigated = true;
      await automation.openUrl(link.url, link.schemes);
    } else if (!view.ok) throw failure(view.error, appLabel, noun);
    const deadline = now() + navigateMs;
    while (!view.ok || !view.composer) {
      if (!view.ok && !['content_mismatch', 'no_window'].includes(view.error)) throw failure(view.error, appLabel, noun);
      if (now() >= deadline) throw certain('timeout', `${appLabel} did not show the ${noun} in time. Nothing was sent.`);
      await wait(pollMs);
      view = await look();
    }

    // 3. Never interrupt a running agent or overwrite a user's draft.
    if (view.stop || await isBusy() === true) throw certain('conversation_busy', `The agent is still working in this ${noun}. Nothing was sent.`);
    if (view.composer.value.trim() !== '') throw failure('composer_not_empty', appLabel, noun);

    // 4. Insert the text and read it back.
    const set = await automation.setComposer(current, text);
    typed = set.ok === true || set.error === 'write_failed';
    if (!set.ok) throw failure(set.error, appLabel, noun);
    if (normaliseText(set.composer?.value) !== expected) throw failure('write_failed', appLabel, noun);
    if (!set.send?.enabled) throw failure('send_disabled', appLabel, noun);
    if (set.stop || await isBusy() === true) throw certain('conversation_busy', `The agent started working in this ${noun}. Nothing was sent.`);

    // 5. Press send. Once a press is attempted the composer is never touched
    // again, and any doubt means the message may have arrived.
    typed = false;
    let submitted;
    try { submitted = await automation.submit(current, text); } catch (error) {
      throw new HarnessError(error.code || 'unexpected', `${appLabel} may have received the message, but sending could not be confirmed. Check the ${noun} before scheduling again.`, error.details || {}, true);
    }
    if (!submitted.pressed) {
      typed = true;
      throw failure(submitted.error, appLabel, noun);
    }
    if (!submitted.ok) throw new HarnessError('unexpected', `${appLabel} reported a problem after the message was submitted. Check the ${noun} before scheduling again.`, {}, true);

    // 6. Wait for evidence persisted by the app itself.
    const until = now() + confirmMs;
    for (;;) {
      let evidence = null;
      try { evidence = await confirm(); } catch { evidence = null; }
      if (evidence) return evidence;
      if (now() >= until) break;
      await wait(pollMs);
    }
    throw new HarnessError('timeout', `${appLabel} accepted the message, but it has not appeared in the ${noun} yet. Check the ${noun} before scheduling again.`, {}, true);
  } finally {
    // Remove only our own text, and only when send was never pressed.
    if (typed) await automation.clearComposer(current, text).catch(() => {});
    // Only a deep link moves the app to the front; otherwise the user chose it.
    if (navigated) await restoreFront(automation, bundleId, previous);
  }
}

function deliverThroughUi(options) {
  return serialise(() => deliver(options));
}

module.exports = { DEFAULT_TIMINGS, deliverThroughUi, normaliseText, requireReady };
