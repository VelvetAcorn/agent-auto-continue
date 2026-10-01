'use strict';

// Every undocumented contact point Agent Auto-Continue relies on in Claude
// Desktop, in one place. When an update changes one of them, the fix should be
// a data change here, followed by re-verifying and bumping `verifiedVersion`.
// Verified with Claude Desktop 2.16120.0 (Electron) and Claude Code 2.1.286 on
// 2026-10-01; docs/desktop-harnesses.md records how each value was found.
const { defineProfile } = require('./define');

module.exports = defineProfile({
  harness: 'claude-desktop',
  appLabel: 'Claude Desktop',
  bundleId: 'com.anthropic.claudefordesktop',
  verifiedVersion: '2.16120.0',
  verifiedOn: '2026-10-01',
  // Where the app is looked for when Launch Services cannot say; `~` is the user's home.
  appCandidates: ['/Applications/Claude.app', '~/Applications/Claude.app'],
  // Files inside the app bundle, relative to it. Required files missing from a
  // found app mean the app changed (contact point `app_path`).
  bundledFiles: {
    // Message catalogues keyed by stable message IDs, <locale>.json; English needs none.
    labelCatalogue: { path: 'Contents/Resources/ion-dist/i18n', required: false, contactPoint: 'label_catalogue' }
  },
  // The app's own URL handler opens a local Code session; it is the only navigation used.
  deepLink: { schemes: ['claude'], template: 'claude://code/continue?session={id}' },
  conversationId: /^local_[0-9a-f-]{36}$/i,
  // The Code view's web content area has the URL https://claude.ai/epitaxy/local_<uuid>,
  // so the open session is verified by that path segment.
  content: { by: 'urlSegment' },
  // Accessible names, as message IDs in the catalogue plus the English text.
  controls: {
    composer: { ids: ['iWKE8shLIt', 'uxkiTeN6WU'], english: ['Prompt', 'Write your prompt to Claude'] },
    send: { ids: ['9WRlF4R2gm'], english: ['Send'] },
    // Not used yet: no Stop label has been verified for Claude Desktop.
    stop: { ids: [], english: [] }
  },
  // The send button exists, disabled, while the message box is empty.
  ui: { sendShownWhenEmpty: true },
  // Local state, relative to the user's home unless stated otherwise.
  files: {
    desktopDir: ['Library', 'Application Support', 'Claude'],
    // <desktopDir>/claude-code-sessions/<account>/<org>/local_<uuid>.json
    codeSessionsDir: 'claude-code-sessions',
    codeSessionFile: /^local_[0-9a-f-]{36}\.json$/i,
    // <desktopDir>/plan-usage-history.json
    planUsageFile: 'plan-usage-history.json',
    // Claude Code's own state, shared with the Claude Code CLI harness:
    // <config>/projects/<encoded cwd>/<cliSessionId>.jsonl and <config>/sessions/<pid>.json,
    // where <config> is $CLAUDE_CONFIG_DIR or ~/.claude.
    claudeConfigDir: '.claude',
    claudeConfigEnv: 'CLAUDE_CONFIG_DIR',
    transcriptsDir: 'projects',
    liveRegistryDir: 'sessions'
  },
  // The live registry, <config>/sessions/<pid>.json, one entry per running Claude Code
  // process. Claude Code 2.1.286 writes { pid, sessionId, startedAt, kind, entrypoint }
  // at startup and adds `status` with its first update; its own reader knows the
  // statuses busy, shell (a shell command is running, shown as working), idle and
  // waiting. `blocked` is kept for older versions. Any other status, or none once
  // `startupGraceMs` has passed, means the registry changed.
  liveRegistry: {
    statuses: { busy: ['busy', 'shell'], waiting: ['waiting', 'blocked'], idle: ['idle'] },
    entrypoint: 'claude-desktop',
    startupGraceMs: 30_000
  }
});
