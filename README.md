# Agent Auto-Continue

Agent Auto-Continue is a macOS menu-bar companion that schedules a user message (by default, `Continue`) for an existing agent conversation.
It supports T3 Code threads, OpenCode sessions, Claude Code CLI sessions and Codex CLI threads.
Its Paper Focus interface keeps the queue, history, conversation picker, composer and settings in one window.
Each harness is reached through its own local interface: T3 Code's and OpenCode's loopback HTTP APIs, Claude Code's headless mode, and the Codex app-server protocol.
It does not modify those apps, simulate keyboard input, or send messages to a remote service of its own.

The repository is [agent-auto-continue](https://github.com/VelvetAcorn/agent-auto-continue).
Desktop apps and automation modes are tracked in the [future feature backlog](docs/roadmap.md).
[Agent harness adapters](docs/harnesses.md) documents the adapter contract, every integration and its limits.
The existing package name and macOS app identity are retained to preserve compatibility with installed copies and their saved data.

## Repository layout

| Location | Purpose |
| --- | --- |
| `main.js`, `preload.js`, `dashboard.html`, `styles.css` | Electron entry points and shared styles |
| `lib/`, `renderer/` | Backend services and production UI |
| `assets/` | Application artwork |
| `test/`, `tools/` | Automated checks and Electron smoke fixture |
| `docs/` | Development plan, implementation reference, harness adapters and future backlog |
| `design/mockups/` | Standalone design prototypes |
| `legacy/` | Original accessibility-based shell and Swift helpers |
| `ui.html`, `settings.html` | Retained older screens, still listed in the build configuration |

## What it does

- Lets you choose an agent harness, then lists its conversations by most recent update with relative and exact times, hiding settled T3 Code threads by default with a Show settled option.
- Shows which harness each schedule targets and whether the agent's turn finished.
- Skips a schedule without sending when the harness reports a usage limit that has not reset yet.
- Shows upcoming schedules and local delivery history, including failed, canceled and unconfirmed outcomes.
- Schedules a message for a chosen thread, with `+5 min`, `+30 min`, `+1 hour`, and tomorrow shortcuts.
- Persists jobs through quitting, restarting, and sleep/wake.
- Snapshots a configurable post-time safety buffer per job (5 seconds by default).
- Checks the conversation before dispatching. It cancels a job if the conversation is missing, archived, or has newer user activity.
- Uses stable command/message IDs and marks interrupted or ambiguous dispatches as unconfirmed for reconciliation without automatic resending.
- Keeps the token in the app's macOS application-data directory (permissions `0600`) or accepts `T3_TOKEN` only for the current launch.

## Requirements

- macOS and at least one supported harness:
  - T3 Code running with its local orchestration HTTP API.
  - OpenCode running as a server, for example `opencode serve --port 4096`.
  - Claude Code CLI (`claude`), signed in.
  - Codex CLI (`codex`), signed in.
- Node.js 20+ for development.
- For T3 Code, a bearer token. Create one according to your installed T3 Code version's authentication instructions. For versions supporting the session-issue command:

  ```sh
  npx t3 auth session issue --token-only --label t3code-auto-continue --ttl 365d
  ```

## Run in development

```sh
npm install
npm start
```

On launch, the app opens its control window. Enter the T3 Code bearer token in **Settings** if it is not already configured. The default server address is fixed to `http://127.0.0.1:3773`; Settings only permits changing the port, so the app cannot be pointed at a remote host.
The **Agent harnesses** card in Settings shows what each harness supports, including whether it works while the screen is locked, and holds the OpenCode port and password and optional CLI executable paths.
The CLIs are found automatically in common install locations.

Choose **New schedule** (initially five minutes ahead), choose the agent harness, select a conversation, enter a message, then choose an ISO date (`yyyy-mm-dd`), 24-hour time and timezone.
Quick times include +5 minutes, +30 minutes, +1 hour and tomorrow at 09:00.
The preview includes the safety buffer; daylight-saving gaps are rejected and repeated local times require choosing an offset.
Upcoming shows saved schedules immediately; select one to edit or cancel it before sending starts.
History keeps outcomes and lets you acknowledge delivery problems, check uncertain delivery, or prepare another schedule.
Use **Load more** for older records; search applies to the records currently loaded.
The menu-bar controls open the relevant view in the same window.
Only one copy may run at a time.

Settings offers light, Bone Outline dark and system appearance with reduced-motion support.
The rotating Support sticker shows a random phrase each time you open Settings; click it (or press Enter or Space) for a spin and another phrase.
Its text stays upright, wraps and shrinks to fit, and the phrases live in `STICKER_PHRASES` in `renderer/support-star.js`.
With reduced motion the sticker stays still but still changes phrase.
The Settings support button opens [VelvetAcorn on Ko-fi](https://ko-fi.com/velvetacorn) in your default browser.

You can avoid persisting the token by launching with an environment variable:

```sh
T3_TOKEN='…' npm start
```

The environment token takes precedence for that launch.

## Build a macOS app

```sh
npm run build       # signed/unsigned ZIP, depending on local certificate setup
npm run build:dmg   # optional disk image
```

All build scripts package locally without publishing releases (`--publish never`).
The default build produces a ZIP in `dist/`, which is the most portable artifact for local testing. `npm run build:dmg` creates a disk image on a normal macOS host with disk-image tooling available; `npm run build:all` requests both. The menu includes **Launch at login** after the app has been installed.

The app icon (`assets/icon.icns`) and menu-bar glyph (`assets/trayTemplate.png`, `assets/trayTemplate@2x.png`) are generated from the SVG sources in `assets/` and committed.
After editing `assets/icon.svg` or `assets/trayTemplate.svg`, run `npm run icons` on macOS and commit the regenerated files.

## Reliability model

Jobs are stored under macOS's app data directory as `jobs.json`; configuration is stored beside it as `config.json`. Do not place either file in this repository or source control.

At dispatch time the app reads the conversation, then sends the message with a stable per-message key that the harness records.
For T3 Code this is a `thread.turn.start` command containing persistent `commandId` and `messageId` values.
A verified acceptance, or finding the key in the conversation, establishes delivery to the harness, not successful completion of the agent's work.
Harnesses that report completion also record whether the agent's turn finished, stopped at a usage limit, or stopped because it asked for approval.
See [agent harness adapters](docs/harnesses.md) for each harness's delivery evidence.
New user activity since schedule creation cancels the job; settling a thread only filters the picker.
Archived threads are always excluded from the picker, while unknown states remain visible.
See [migration details](docs/implementation-review.md#job-model-and-delivery-safeguards) for legacy activity-baseline limits.
Saved schedules retain their UTC instant and buffer when settings or the system timezone change.
Missed pending schedules catch up after restart or wake and record lateness.

Interrupted sends and ambiguous POST responses become `unconfirmed` and never retry automatically, because resending could duplicate a message that was already accepted.
Reconciliation only reads the conversation, marking delivery confirmed if the stable message key is found.
Absence from a windowed snapshot is not proof of nondelivery.
Schedule again provides a draft only for confirmed terminal outcomes; it is blocked for unconfirmed delivery.
Acknowledgment clears an attention badge without deleting history or sending anything.

The renderer uses queue/history, edit/cancel, acknowledgment, reconciliation and job-change APIs.
Corrupt, unreadable, or unsupported local schedule files are preserved; the app pauses scheduling and shows a storage error instead of overwriting them.
See [the development plan](docs/development-plan.md) for accepted decisions, prototype review, and remaining release gates.

## Verify the source

```sh
npm test
npm run test:electron  # safe production-window smoke fixture; no real sends
npm run check:syntax  # every script, including nested lib directories
```

## Legacy script

[`legacy/continue-at.sh`](legacy/continue-at.sh) and [`legacy/press-continue.swift`](legacy/press-continue.swift) remain as the original, accessibility-based one-shot helper. They are not used by the v2 app and require an unlocked Mac, a focused prepared draft, and Accessibility permission. Prefer the menu-bar app for ordinary use.

## Limits

The HTTP routes and settlement/dispatch fields were checked against the installed T3 Code Alpha 0.0.40 source maps.
The OpenCode, Claude Code and Codex adapters were checked against OpenCode 1.18.34, Claude Code 2.1.286 and codex-cli 0.159 with read-only calls and zero-cost probes; see [agent harness adapters](docs/harnesses.md).
Claude Code and private Codex turns run as child processes of this app, so quitting it interrupts them; turns in the shared Codex daemon continue.
The reported HTML response was reproduced with controlled responses through the dashboard IPC boundary; its actual live-server cause is still unconfirmed.
No live messages were sent during these checks.
Unit and IPC tests inject transport, clocks, timers and persistence.
The Electron smoke fixture exercises the production main process, preload and renderer against in-memory storage and a fake API that prohibits dispatch.
Read-only live-server compatibility checks and controlled real macOS sleep/wake checks remain necessary before release; do not send live messages for validation.
Usage-limit reset times come only from what each harness reports or records, and the app does not retry failed or unconfirmed sends.
A user can still cancel a pending job from the menu at any time.
