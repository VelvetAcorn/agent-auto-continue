'use strict';

// Read-only compatibility check shared by the desktop-app adapters, behind
// their checkCompatibility(). It never navigates, opens links, types, presses
// or changes focus. It reads, in order:
//   1. the app's installation, version and the files the profile needs inside it;
//   2. which app Launch Services would open the profile's deep links with;
//   3. with depth 'full', and only when Accessibility is granted, the app is
//      running and the Mac is unlocked: the controls of whichever conversation
//      the app already shows. Labels are the same in every conversation, so any
//      shown conversation proves them; when none is shown they are "unchecked";
//   4. the adapter's own probes of files and protocols.
// A contact point that cannot be inspected is reported in `unchecked`, never
// as a problem. Problems are reserved for evidence that the app changed.
const fs = require('node:fs');
const path = require('node:path');
const { compatibility } = require('../harnesses/contract');
const { HarnessError, driftMessage } = require('../harnesses/errors');
const { isScreenLocked } = require('../harnesses/session-lock');
const { createAppLabels } = require('./app-labels');

const INTERFACE_POINTS = Object.freeze(['content_match', 'composer_label', 'send_label']);
// A message box missing on the first look is looked for once more after this,
// so a view that is still rendering is not mistaken for an app change.
const RECHECK_MS = 1_000;

const quoted = (labels) => (labels || []).map((label) => `"${label}"`).join(' or ') || 'none';

// The conversation a content area shows, for profiles that put its ID in the URL path.
function conversationFromUrl(profile, areas) {
  for (const area of areas) {
    const match = /^https?:\/\/[^/?#]*([^?#]*)/i.exec(area.url || '');
    const segment = match?.[1].split('/').find((part) => profile.conversationId.test(part));
    if (segment) return { match: { urlSegment: segment }, conversationId: segment, language: area.language || '' };
  }
  return null;
}

// `pickConversation(areas)` resolves { match, conversationId, language } for a
// shown conversation the adapter recognises, or null. `isBusy(shown)` resolves
// true when that conversation's agent is working or waiting, because its
// message box may then be replaced. `probes` are { contactPoints, depth, run }
// objects whose run({ profile, env, app, depth }) resolves
// { checked, unchecked, problems: [{ contactPoint, hint }] } (all optional), or
// throws: an app_version_unsupported HarnessError becomes a problem, anything
// else marks the probe's contact points unchecked.
async function checkDesktopCompatibility({ profile, automation, depth = 'full', isLocked = isScreenLocked, exists = (file) => fs.existsSync(file), now = () => Date.now(), sleep,
  pickConversation = async (areas) => (profile.content.by === 'urlSegment' ? conversationFromUrl(profile, areas) : null), isBusy = async () => null, probes = [] }) {
  const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const result = { appVersion: null, verifiedVersion: profile.verifiedVersion, checkedAt: new Date(now()).toISOString(), depth: depth === 'quick' ? 'quick' : 'full', problems: [], checked: [], unchecked: [] };
  const problem = (contactPoint, hint) => result.problems.push({ contactPoint, hint,
    message: driftMessage({ app: profile.appLabel, appVersion: result.appVersion, verifiedVersion: profile.verifiedVersion, contactPoint, during: 'check' }) });
  const skip = (points, reason) => { for (const contactPoint of [].concat(points)) result.unchecked.push({ contactPoint, reason }); };
  const passed = (point) => result.checked.push(point);
  const bundled = Object.values(profile.bundledFiles);
  const everything = [...new Set(['app_path', ...bundled.map((file) => file.contactPoint), 'deep_link', ...INTERFACE_POINTS, ...probes.flatMap((probe) => probe.contactPoints || [])])];

  let env;
  try { env = await automation.environment([profile.bundleId], { schemes: profile.deepLink.schemes }); } catch (error) {
    skip(everything, error instanceof HarnessError ? error.code : 'automation_unavailable');
    return compatibility(result);
  }
  const app = env?.apps?.[profile.bundleId];
  if (!app?.installedPath) { skip(everything, 'not_installed'); return compatibility(result); }
  result.appVersion = app.version || null;

  // 1. Files inside the app bundle.
  passed('app_path');
  for (const file of bundled) {
    if (exists(path.join(app.installedPath, file.path))) passed(file.contactPoint);
    else if (file.required) problem(file.contactPoint, `${file.path} is missing inside the app.`);
    else skip(file.contactPoint, 'not_found');
  }

  // 2. The app's own links.
  for (const scheme of profile.deepLink.schemes) {
    const handlers = env.handlers && typeof env.handlers === 'object' ? env.handlers : null;
    if (!handlers || !(scheme in handlers)) skip('deep_link', 'unknown');
    else if (!handlers[scheme]) problem('deep_link', `No app is registered to open ${scheme}:// links.`);
    else if (handlers[scheme].bundleId !== profile.bundleId) skip('deep_link', 'handled_by_other_app');
    else passed('deep_link');
  }

  // 3. The controls of the conversation the app already shows.
  async function checkInterface() {
    if (result.depth === 'quick') return skip(INTERFACE_POINTS, 'quick');
    if (env.trusted !== true) return skip(INTERFACE_POINTS, 'permission_required');
    if (!app.running) return skip(INTERFACE_POINTS, 'not_running');
    if (env.screenLocked || env.onConsole === false || await isLocked() === true) return skip(INTERFACE_POINTS, 'screen_locked');
    const listed = await automation.contentAreas(profile.bundleId);
    if (!listed?.ok) return skip(INTERFACE_POINTS, listed?.error || 'unknown');
    const shown = await pickConversation(Array.isArray(listed.areas) ? listed.areas : []);
    if (!shown) return skip(INTERFACE_POINTS, 'no_conversation_shown');
    if (await isBusy(shown) === true) return skip(INTERFACE_POINTS, 'agent_working');
    const catalogue = bundled.find((file) => file.contactPoint === 'label_catalogue');
    const labels = createAppLabels({ catalogueDirectory: catalogue ? path.join(app.installedPath, catalogue.path) : null, controls: profile.controls })(shown.language || '');
    const target = { bundleId: profile.bundleId, match: shown.match, composerLabels: labels.composer, sendLabels: labels.send, stopLabels: labels.stop };
    let view = await automation.inspect(target);
    if (view?.ok && !view.composer && !view.stop) { await wait(RECHECK_MS); view = await automation.inspect(target); }
    if (!view?.ok) return skip(INTERFACE_POINTS, view?.error || 'unknown');
    passed('content_match');
    if (view.stop) return skip(['composer_label', 'send_label'], 'agent_working');
    const language = `Interface language: ${view.content?.language || shown.language || 'unknown'}.`;
    if (!view.composer) {
      problem('composer_label', `A conversation was shown, but no text area labelled ${quoted(labels.composer)} was found in it. ${language}`);
      return skip('send_label', 'no_composer');
    }
    passed('composer_label');
    if (view.send) passed('send_label');
    // An empty message box may legitimately hide its send button; one with text never should.
    else if (profile.ui.sendShownWhenEmpty === true || String(view.composer.value || '').trim() !== '') problem('send_label', `The message box was found, but no button labelled ${quoted(labels.send)} was found near it. ${language}`);
    else skip('send_label', 'hidden_while_empty');
  }
  try { await checkInterface(); } catch (error) {
    skip(INTERFACE_POINTS.filter((point) => !result.checked.includes(point)), error instanceof HarnessError ? error.code : 'error');
  }

  // 4. The adapter's own probes.
  for (const probe of probes) {
    if (probe.depth === 'full' && result.depth === 'quick') { skip(probe.contactPoints || [], 'quick'); continue; }
    try {
      const found = (await probe.run({ profile, env, app: { path: app.installedPath, version: result.appVersion }, depth: result.depth })) || {};
      for (const point of found.checked || []) passed(point);
      for (const item of found.unchecked || []) skip(item.contactPoint, item.reason);
      for (const item of found.problems || []) problem(item.contactPoint, item.hint || '');
    } catch (error) {
      if (error instanceof HarnessError && error.code === 'app_version_unsupported') problem(error.details?.contactPoint, error.details?.hint || '');
      else skip(probe.contactPoints || [], error instanceof HarnessError ? error.code : 'error');
    }
  }
  // A contact point that failed anywhere is not also reported as passed.
  const failed = new Set(result.problems.map((item) => item.contactPoint));
  result.checked = result.checked.filter((point) => !failed.has(point));
  return compatibility(result);
}

module.exports = { INTERFACE_POINTS, RECHECK_MS, checkDesktopCompatibility, conversationFromUrl };
