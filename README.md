# Agent Auto-Continue

Agent Auto-Continue is a macOS menu-bar companion that schedules a user message (by default, `Continue`) for an existing agent conversation.
It supports T3 Code threads, OpenCode sessions, Claude Code CLI sessions, Codex CLI threads, Claude Desktop Code sessions and ChatGPT app Codex threads.
Its Paper Focus interface keeps the queue, history, conversation picker, composer and settings in one window.
Each harness is reached through its own local interface: T3 Code's and OpenCode's loopback HTTP APIs, Claude Code's headless mode, and the Codex app-server protocol.
Claude Desktop and the ChatGPT app run their agents inside the app, so those two harnesses fill in and press the app's own message box and send button through macOS Accessibility; see [desktop app harnesses](docs/desktop-harnesses.md).
It does not modify those apps, post keyboard events, or send messages to a remote service of its own.

The repository is [agent-auto-continue](https://github.com/VelvetAcorn/agent-auto-continue).
Ideas not yet built are tracked in the [future feature backlog](docs/roadmap.md).
[Agent harness adapters](docs/harnesses.md) documents the adapter contract, every integration and its limits.
The existing package name and macOS app identity are retained to preserve compatibility with installed copies and their saved data.

## Repository layout

| Location | Purpose |
| --- | --- |
| `main.js`, `preload.js`, `dashboard.html`, `styles.css` | Electron entry points and shared styles |
| `lib/`, `renderer/` | Backend services and production UI |
| `lib/remote/` | Optional remote control REST API and MCP server |
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
- Waits instead of failing when a one-off message is due while the agent is still working, the Mac is locked or the harness is unavailable, checking again with backoff for up to six hours; see [waiting one-off messages](docs/harnesses.md#waiting-one-off-messages).
- Schedules a message for a chosen thread, with `+5 min`, `+30 min`, `+1 hour`, and tomorrow shortcuts.
- For agents that report usage limits, starts as soon as the agent is available, or at a time and then once any limit has reset.
- For agents that report when a turn finishes, sends follow-up turns up to a turn limit, or continuously until stopped, and optionally finishes when the agent's last message contains a stop phrase such as `TASK COMPLETE`; see [automatic continuations](docs/continuations.md).
- Stops any schedule or continuation at once from its detail view, the Upcoming Stop all control, or the menu-bar tray.
- Lists recent conversations from every connected harness in the menu-bar tray, grouped by harness, from a cache that refreshes in the background so the menu opens at once.
- Persists jobs through quitting, restarting, and sleep/wake.
- Checks Claude Desktop and the ChatGPT app read-only at launch, when something is scheduled for them and every five minutes while it waits, so an app update that changed what the app relies on is shown on the dashboard, with the schedules it puts at risk, before they are due; see [surviving app updates](docs/desktop-harnesses.md#checking-before-schedules-fire).
- Optionally keeps the Mac awake while scheduled work waits or runs, and shows why and for which tasks.
- Snapshots a configurable post-time safety buffer per job (5 seconds by default).
- Checks the conversation before dispatching. It cancels a job if the conversation is missing, archived, or has newer user activity.
- Uses stable command/message IDs and marks interrupted or ambiguous dispatches as unconfirmed for reconciliation without automatic resending.
- Keeps the token in the app's macOS application-data directory (permissions `0600`) or accepts `T3_TOKEN` only for the current launch.
- Optionally lets a phone or AI agent control the schedule through a token-protected REST API and MCP server, on this Mac or over Tailscale only.

## Requirements

- macOS and at least one supported harness:
  - T3 Code running with its local orchestration HTTP API.
  - OpenCode running as a server, for example `opencode serve --port 4096`.
  - Claude Code CLI (`claude`), signed in.
  - Codex CLI (`codex`), signed in.
  - Claude Desktop or the ChatGPT app running, with Accessibility permission for this app and the Mac unlocked when a message is due.
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

## Remote control

Settings includes an optional **Remote control** section, off by default.
When enabled, the app serves a REST API and an MCP server on `127.0.0.1`, and optionally on your Tailscale address; it never listens on ordinary local-network, public or all-interface addresses.
A local-network address saved by an earlier version is dropped at launch, with a notice, while loopback keeps working.
Each phone or agent gets its own revocable bearer token, shown once with a QR code, and every remote change appears under Remote activity.
Status includes each desktop app's last compatibility check without running a new one, and a send refused because an app changed answers `503 app_version_unsupported`; see [remote control](docs/remote-control.md).
Remote clients can schedule for any harness, start, stop and resume automatic continuations, and read the keep-awake status.
See [remote control](docs/remote-control.md) for the security model, Tailscale setup, MCP client configuration and the API reference.

## Build a macOS app

```sh
npm run build       # signed/unsigned ZIP, depending on local certificate setup
npm run build:dmg   # optional disk image
```

All build scripts package locally without publishing releases (`--publish never`).
The default build produces a ZIP in `dist/`, which is the most portable artifact for local testing. `npm run build:dmg` creates a disk image on a normal macOS host with disk-image tooling available; `npm run build:all` requests both. The menu includes **Launch at login** after the app has been installed.

The app icon (`assets/icon.icns`) and menu-bar glyphs (`assets/trayTemplate.png` and, while keep-awake holds the Mac awake, `assets/trayAwakeTemplate.png`, each with an `@2x` file) are generated from the SVG sources in `assets/` and committed.
After editing `assets/icon.svg`, `assets/trayTemplate.svg` or `assets/trayAwakeTemplate.svg`, run `npm run icons` on macOS and commit the regenerated files.

## Keep awake

Keep-awake is off by default; turn it on in **Settings → Keep awake**.
While it is on, the app holds a macOS power assertion for as long as tracked work is waiting or running.
Tracked work covers every harness: pending schedules, automatic continuations while they wait for availability or for the next turn, deliveries in flight, and the agent turn a delivery started.
Paused continuations wait for you, so they do not keep the Mac awake.
Compatibility checks of the desktop apps are never tracked work, and a continuation that pauses because its app changed lets the Mac sleep.
You can also track every running T3 Code agent turn.
By default the display may sleep; choose **Keep the display on too** to keep it lit.
Work for Claude Desktop or ChatGPT Codex threads drives the app's interface, so the display stays on while it is tracked.
The assertion is released when the work finishes, when you choose **Let Mac sleep**, at the battery floor, at the time limit, and when the app quits or crashes.
A notice above every view and the menu-bar icon show when the Mac is being kept awake, why, and until when.

The app uses Electron's `powerSaveBlocker`, never `sudo`, and never changes system settings.
macOS still sleeps when a laptop lid closes, unless the Mac is in closed-display mode with power, an external display and an external keyboard or mouse.
It also sleeps when you choose Sleep or the battery is critically low; missed schedules catch up after waking.
Locking the screen or letting the display sleep does not stop scheduled work, except for Claude Desktop and ChatGPT Codex threads, which need the Mac unlocked to send.

| Configuration | Scheduled work keeps running? |
| --- | --- |
| Desktop Mac | Yes |
| Laptop, lid open, on power or battery | Yes, down to the battery floor you set |
| Laptop, lid open, screen locked or display asleep | Yes, except desktop-app harnesses, which wait for the unlock (one-off schedules for up to six hours) |
| Laptop, lid closed, with power, an external display and an external keyboard or mouse | Yes |
| Laptop, lid closed, without an external display, or on battery only | No; the Mac sleeps and catches up after waking |

See the [keep-awake investigation](docs/keep-awake-investigation.md) for the mechanisms compared, measurements and the lifecycle design.

## Reliability model

Jobs are stored under macOS's app data directory as `jobs.json`; configuration is stored beside it as `config.json`. Do not place either file in this repository or source control.

At dispatch time the app reads the conversation, then sends the message with a stable per-message key that the harness records.
For T3 Code this is a `thread.turn.start` command containing persistent `commandId` and `messageId` values.
A verified acceptance, or finding the key in the conversation, establishes delivery to the harness, not successful completion of the agent's work.
Harnesses that report completion also record whether the agent's turn finished, stopped at a usage limit, or stopped because it asked for approval.
See [agent harness adapters](docs/harnesses.md) for each harness's delivery evidence.
New user activity since schedule creation cancels the job; settling a thread only filters the picker.
Archived threads are always excluded from the picker, while unknown states remain visible.
Jobs saved by older versions without a creation time skip this check, because earlier activity cannot be told apart from new activity.
Saved schedules retain their UTC instant and buffer when settings or the system timezone change.
Missed pending schedules catch up after restart or wake and record lateness.

Interrupted sends and ambiguous POST responses become `unconfirmed` and never retry automatically, because resending could duplicate a message that was already accepted.
Reconciliation only reads the conversation, marking delivery confirmed if the stable message key is found.
Absence from a windowed snapshot is not proof of nondelivery.
When the user has checked the conversation and the message is not there, they can mark it as not delivered, with explicit confirmation, from the tray or over remote control; the app checks once more and records the assertion on the job, and a continuation then resends that turn on Resume with a new delivery key.
Schedule again provides a draft only for confirmed terminal outcomes; it is blocked for unconfirmed delivery until it is confirmed or marked as not delivered.
Acknowledgment clears an attention badge without deleting history or sending anything.

The renderer uses queue/history, edit/cancel, acknowledgment, reconciliation and job-change APIs.
Corrupt, unreadable, or unsupported local schedule files are preserved; the app pauses scheduling and shows a storage error instead of overwriting them.
See [the roadmap](docs/roadmap.md) for feature status and [the UI review](docs/ui-review.md) for open design decisions.

## Verify the source

```sh
npm test
npm run test:electron  # production-window smoke fixture and keep-awake assertion checks; no real sends
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
Usage-limit reset times come only from what each harness reports or records, and the app never retries unconfirmed sends.
Automatic continuations distinguish a delivered message from a finished turn, but no harness reports that a task is finished, so the turn limit and Stop are the safeguards.
A user can cancel a pending job or stop a continuation from the menu at any time.
