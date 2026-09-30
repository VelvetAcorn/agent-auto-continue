'use strict';
// Opt-in, manual end-to-end check of the desktop-app harnesses against the real
// Claude Desktop and ChatGPT apps. It is a DRY RUN: it reads state and locates
// the conversation, message box and send button, but it can never type or send.
// The automation driver is wrapped so any write operation throws.
//
//   AAC_DESKTOP_E2E=1 node tools/desktop-e2e-dry-run.cjs
//       Reports permission, lock state, installed apps, discovered conversations,
//       and the controls of whichever listed conversation each app shows now.
//   AAC_DESKTOP_E2E=1 node tools/desktop-e2e-dry-run.cjs --open claude-desktop <local_...>
//   AAC_DESKTOP_E2E=1 node tools/desktop-e2e-dry-run.cjs --open codex-desktop <thread id>
//       Also opens that conversation through the app's own deep link (the app
//       comes to the front and then the previous app is restored) and locates
//       its controls. Use a throwaway conversation you created for testing.
//
// Run it from a terminal that has Accessibility permission, with the Mac unlocked.
const path = require('node:path');
const { createAppLabels } = require('../lib/desktop/app-labels');
const { createMacAutomation } = require('../lib/desktop/mac-automation');
const { isScreenLocked } = require('../lib/harnesses/session-lock');
const claude = require('../lib/harnesses/claude-desktop');
const codex = require('../lib/harnesses/codex-desktop');

if (process.env.AAC_DESKTOP_E2E !== '1') {
  console.error('Refusing to run: set AAC_DESKTOP_E2E=1 to drive the real desktop apps (read-only dry run).');
  process.exit(2);
}

const WRITES = new Set(['setComposer', 'submit', 'clearComposer']);
const real = createMacAutomation();
// The dry-run guarantee: write operations are unreachable.
const automation = new Proxy(real, { get(target, name) {
  if (WRITES.has(name)) return () => { throw new Error(`Dry run: ${String(name)} is disabled.`); };
  return target[name];
} });

const claudeLabels = createAppLabels({ catalogueDirectory: '/Applications/Claude.app/Contents/Resources/ion-dist/i18n', controls: claude.CONTROLS });
const apps = {
  'claude-desktop': {
    bundleId: claude.BUNDLE_ID,
    adapter: claude.createClaudeDesktopHarness({ automation }),
    link: (id) => `claude://code/continue?session=${encodeURIComponent(id)}`, scheme: 'claude',
    // Which listed conversation a content area shows, and the target that locates its controls.
    shown: (area, conversations) => conversations.find((item) => (area.url || '').split(/[/?#]/).includes(item.id)),
    target: (item, language) => ({ bundleId: claude.BUNDLE_ID, match: { urlSegment: item.id }, composerLabels: claudeLabels(language).composer, sendLabels: claudeLabels(language).send })
  },
  'codex-desktop': {
    bundleId: codex.BUNDLE_ID,
    adapter: codex.createCodexDesktopHarness({ automation }),
    link: (id) => `codex://threads/${encodeURIComponent(id)}`, scheme: 'codex',
    shown: (area, conversations) => conversations.find((item) => item.title && item.title === area.title),
    target: (item) => ({ bundleId: codex.BUNDLE_ID, match: { title: item.title }, ...codex.TARGET })
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = (label, value) => console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);

async function locate(name, spec, item, area) {
  const view = await automation.inspect(spec.target(item, area?.language || ''));
  report(`  ${name} controls for "${item.title}"`, view.ok
    ? { composer: view.composer ? { found: true, empty: view.composer.value.trim() === '' } : { found: false }, send: view.send || { found: false }, stopVisible: view.stop, language: view.content.language }
    : { error: view.error });
}

async function check(name, spec, openId) {
  console.log(`\n== ${name}`);
  const env = await automation.environment([spec.bundleId]);
  report('  app', env.apps[spec.bundleId]);
  let conversations = [];
  try {
    conversations = await spec.adapter.listConversations({});
    report('  conversations discovered', conversations.length);
    for (const item of conversations.slice(0, 5)) report('   -', `${item.title} [${item.state}] ${item.projectName}`);
  } catch (error) { report('  discovery failed', { code: error.code, message: error.message }); }
  report('  availability', await spec.adapter.probeAvailability().catch((error) => ({ error: error.code })));
  if (!env.apps[spec.bundleId]?.running) return;
  const areas = await automation.contentAreas(spec.bundleId);
  if (!areas.ok) { report('  content areas', areas); return; }
  report('  content areas', areas.areas.map((area) => ({ url: area.url.replace(/[?#].*$/, ''), title: area.title, language: area.language })));
  for (const area of areas.areas) {
    const item = spec.shown(area, conversations);
    if (item) await locate(name, spec, item, area);
  }
  if (!openId) return;
  const item = conversations.find((entry) => entry.id === openId);
  if (!item) { report('  --open', 'that conversation was not discovered; nothing opened'); return; }
  const previous = env.frontmost;
  await automation.openUrl(spec.link(item.id), [spec.scheme]);
  for (let attempt = 0; attempt < 30; attempt++) {
    const view = await automation.inspect(spec.target(item, ''));
    if (view.ok && view.composer) break;
    await sleep(500);
  }
  const shownNow = (await automation.contentAreas(spec.bundleId)).areas || [];
  await locate(name, spec, item, shownNow.find((area) => spec.shown(area, [item])));
  const after = await automation.environment([]);
  if (previous?.pid && after.frontmost?.bundleId === spec.bundleId && previous.bundleId !== spec.bundleId) await automation.activate(previous.pid);
}

async function main() {
  const args = process.argv.slice(2);
  const open = args[0] === '--open' ? { harness: args[1], id: args[2] } : null;
  if (open && !apps[open.harness]) throw new Error(`Unknown harness ${open.harness}. Use claude-desktop or codex-desktop.`);
  const env = await automation.environment([]);
  report('Accessibility permission', env.trusted ? 'granted' : `missing (System Settings: ${real.accessibilitySettingsUrl})`);
  report('Screen locked', await isScreenLocked());
  report('Front app', env.frontmost);
  if (!env.trusted) return;
  for (const [name, spec] of Object.entries(apps)) await check(name, spec, open?.harness === name ? open.id : null);
  console.log(`\nDry run complete. ${path.basename(__filename)} never types or sends.`);
}

main().catch((error) => { console.error(error.stack || error); process.exit(1); });
