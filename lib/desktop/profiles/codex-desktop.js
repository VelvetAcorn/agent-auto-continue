'use strict';

// Every undocumented contact point Agent Auto-Continue relies on in the ChatGPT
// desktop app (bundle com.openai.codex, the merged ChatGPT and Codex app), in
// one place. When an update changes one of them, the fix should be a data
// change here, followed by re-verifying and bumping `verifiedVersion`.
// Verified with the ChatGPT app 26.915.31945 and codex-cli 0.159 on 2026-10-01;
// docs/desktop-harnesses.md records how each value was found.
const { defineProfile } = require('./define');

module.exports = defineProfile({
  harness: 'codex-desktop',
  appLabel: 'ChatGPT (Codex)',
  bundleId: 'com.openai.codex',
  verifiedVersion: '26.915.31945',
  verifiedOn: '2026-10-01',
  // Where the app is looked for when Launch Services cannot say; `~` is the user's home.
  appCandidates: ['/Applications/ChatGPT.app', '~/Applications/ChatGPT.app'],
  // Bundle names whose processes count as the desktop app when they hold a Codex thread lock.
  appBundleNames: ['ChatGPT.app', 'Codex.app'],
  // Files inside the app bundle, relative to it. Required files missing from a
  // found app mean the app changed (contact point `app_path`).
  bundledFiles: {
    // The codex binary bundled with the app, so the app-server protocol version matches.
    codex: { path: 'Contents/Resources/codex', required: true, contactPoint: 'app_path' }
  },
  // The app's router opens a thread with this link; it is the only navigation used.
  deepLink: { schemes: ['codex'], template: 'codex://threads/{id}' },
  conversationId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  // Every thread's content area has the URL app://-/index.html, so the open
  // thread is verified by the content area's title, which is the thread name.
  content: { by: 'title' },
  // The app ships no readable message catalogue, so only English labels are known.
  controls: {
    composer: { ids: [], english: ['Do anything', 'Ask for follow-up changes'] },
    send: { ids: [], english: ['Send', 'Send message'] },
    stop: { ids: [], english: ['Stop'] }
  },
  // Not verified either way, so a missing send button next to an empty message box proves nothing.
  ui: { sendShownWhenEmpty: false },
  // Which app created a thread, from the app-server's `originator` and `source`
  // fields (codex-cli 0.159 values). Threads without an originator fall back to
  // `legacySources`. Owners are harness IDs; anything else is reported as `other`.
  originators: {
    'codex-desktop': { exact: ['Codex Desktop'], prefixes: [], legacySources: ['vscode'] },
    codex: { exact: ['codex_cli_rs', 'codex_exec'], prefixes: [], legacySources: ['cli', 'exec'] },
    t3: { exact: [], prefixes: ['t3code'], legacySources: [] }
  }
});
