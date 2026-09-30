# Agent Auto-Continue

Agent Auto-Continue is a macOS menu-bar companion that schedules a user message (by default, `Continue`) for an existing T3 Code thread.
Its Paper Focus interface keeps the queue, history, thread picker, composer and settings in one window.
It uses T3 Code's local orchestration HTTP API; it does not modify the T3 Code app, simulate keyboard input, or send messages to a remote service.

The repository is [agent-auto-continue](https://github.com/VelvetAcorn/agent-auto-continue).
The current app supports T3 Code; additional harnesses and automation modes are tracked in the [future feature backlog](docs/roadmap.md).
The existing package name and macOS app identity are retained to preserve compatibility with installed copies and their saved data.

## Repository layout

| Location | Purpose |
| --- | --- |
| `main.js`, `preload.js`, `dashboard.html`, `styles.css` | Electron entry points and shared styles |
| `lib/`, `renderer/` | Backend services and production UI |
| `assets/` | Application artwork |
| `test/`, `tools/` | Automated checks and Electron smoke fixture |
| `docs/` | Development plan, implementation reference and future backlog |
| `design/mockups/` | Standalone design prototypes |
| `legacy/` | Original accessibility-based shell and Swift helpers |
| `ui.html`, `settings.html` | Retained older screens, still listed in the build configuration |

## What it does

- Lists threads by most recent update with relative and exact times, hiding settled by default with a Show settled option.
- Shows upcoming schedules and local delivery history, including failed, canceled and unconfirmed outcomes.
- Schedules a message for a chosen thread, with `+5 min`, `+30 min`, `+1 hour`, and tomorrow shortcuts.
- Persists jobs through quitting, restarting, and sleep/wake.
- Optionally keeps the Mac awake while scheduled work waits or runs, and shows why and for which tasks.
- Snapshots a configurable post-time safety buffer per job (5 seconds by default).
- Checks the thread before dispatching. It cancels a job if the thread is missing, archived, or has newer user activity.
- Uses stable command/message IDs and marks interrupted or ambiguous dispatches as unconfirmed for reconciliation without automatic resending.
- Keeps the token in the app's macOS application-data directory (permissions `0600`) or accepts `T3_TOKEN` only for the current launch.

## Requirements

- macOS and a running T3 Code app exposing its local orchestration HTTP API.
- Node.js 20+ for development.
- A T3 Code bearer token. Create one according to your installed T3 Code version's authentication instructions. For versions supporting the session-issue command:

  ```sh
  npx t3 auth session issue --token-only --label t3code-auto-continue --ttl 365d
  ```

## Run in development

```sh
npm install
npm start
```

On launch, the app opens its control window. Enter the bearer token in **Settings** if it is not already configured. The default server address is fixed to `http://127.0.0.1:3773`; Settings only permits changing the port, so the app cannot be pointed at a remote host.

Choose **New schedule** (initially five minutes ahead), select a thread, enter a message, then choose an ISO date (`yyyy-mm-dd`), 24-hour time and timezone.
Quick times include +5 minutes, +30 minutes, +1 hour and tomorrow at 09:00.
The preview includes the safety buffer; daylight-saving gaps are rejected and repeated local times require choosing an offset.
Upcoming shows saved schedules immediately; select one to edit or cancel it before sending starts.
History keeps outcomes and lets you acknowledge delivery problems, check uncertain delivery, or prepare another schedule.
Use **Load more** for older records; search applies to the records currently loaded.
The menu-bar controls open the relevant view in the same window.
Only one copy may run at a time.

Settings offers light, Bone Outline dark and system appearance with reduced-motion support.
The rotating Support star keeps its text upright; the Settings support button opens [VelvetAcorn on Ko-fi](https://ko-fi.com/velvetacorn) in your default browser.

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

The default build produces a ZIP in `dist/`, which is the most portable artifact for local testing. `npm run build:dmg` creates a disk image on a normal macOS host with disk-image tooling available; `npm run build:all` requests both. The menu includes **Launch at login** after the app has been installed.

## Keep awake

Keep-awake is off by default; turn it on in **Settings → Keep awake**.
While it is on, the app holds a macOS power assertion for as long as tracked work is waiting or running.
Tracked work includes pending schedules, deliveries in flight, and the T3 Code agent turn a delivery started.
You can also track every running T3 Code agent turn.
By default the display may sleep; choose **Keep the display on too** to keep it lit.
The assertion is released when the work finishes, when you choose **Let Mac sleep**, at the battery floor, at the time limit, and when the app quits or crashes.
A notice above every view and the menu-bar icon show when the Mac is being kept awake, why, and until when.

The app uses Electron's `powerSaveBlocker`, never `sudo`, and never changes system settings.
macOS still sleeps when a laptop lid closes, unless the Mac is in closed-display mode with power, an external display and an external keyboard or mouse.
It also sleeps when you choose Sleep or the battery is critically low; missed schedules catch up after waking.
Locking the screen or letting the display sleep does not stop scheduled work.

| Configuration | Scheduled work keeps running? |
| --- | --- |
| Desktop Mac | Yes |
| Laptop, lid open, on power or battery | Yes, down to the battery floor you set |
| Laptop, lid open, screen locked or display asleep | Yes |
| Laptop, lid closed, with power, an external display and an external keyboard or mouse | Yes |
| Laptop, lid closed, without an external display, or on battery only | No; the Mac sleeps and catches up after waking |

See the [keep-awake investigation](docs/keep-awake-investigation.md) for the mechanisms compared, measurements and the lifecycle design.

## Reliability model

Jobs are stored under macOS's app data directory as `jobs.json`; configuration is stored beside it as `config.json`. Do not place either file in this repository or source control.

At dispatch time the app fetches a per-thread snapshot, then posts a `thread.turn.start` command containing persistent `commandId` and `messageId` values.
A verified `{sequence}` acceptance response or finding the message in a thread establishes delivery to T3 Code, not successful completion of the agent's work.
New user activity since schedule creation cancels the job; settling a thread only filters the picker.
Archived threads are always excluded from the picker, while unknown states remain visible.
See [migration details](docs/implementation-review.md#job-model-and-delivery-safeguards) for legacy activity-baseline limits.
Saved schedules retain their UTC instant and buffer when settings or the system timezone change.
Missed pending schedules catch up after restart or wake and record lateness.

Interrupted sends and ambiguous POST responses become `unconfirmed` and never retry automatically, because resending could duplicate a message that was already accepted.
Reconciliation only reads the thread snapshot, marking delivery confirmed if the stable message ID is found.
Absence from a windowed snapshot is not proof of nondelivery.
Schedule again provides a draft only for confirmed terminal outcomes; it is blocked for unconfirmed delivery.
Acknowledgment clears an attention badge without deleting history or sending anything.

The renderer uses queue/history, edit/cancel, acknowledgment, reconciliation and job-change APIs.
Corrupt, unreadable, or unsupported local schedule files are preserved; the app pauses scheduling and shows a storage error instead of overwriting them.
See [the development plan](docs/development-plan.md) for accepted decisions, prototype review, and remaining release gates.

## Verify the source

```sh
npm test
npm run test:electron  # production-window smoke fixture and keep-awake assertion checks; no real sends
node --check main.js
node --check preload.js
for file in lib/*.js renderer/*.js; do node --check "$file"; done
```

## Legacy script

[`legacy/continue-at.sh`](legacy/continue-at.sh) and [`legacy/press-continue.swift`](legacy/press-continue.swift) remain as the original, accessibility-based one-shot helper. They are not used by the v2 app and require an unlocked Mac, a focused prepared draft, and Accessibility permission. Prefer the menu-bar app for ordinary use.

## Limits

The HTTP routes and settlement/dispatch fields were checked against the installed T3 Code Alpha 0.0.40 source maps.
The reported HTML response was reproduced with controlled responses through the dashboard IPC boundary; its actual live-server cause is still unconfirmed.
No live messages were sent during these checks.
Unit and IPC tests inject transport, clocks, timers and persistence.
The Electron smoke fixture exercises the production main process, preload and renderer against in-memory storage and a fake API that prohibits dispatch.
Read-only live-server compatibility checks and controlled real macOS sleep/wake checks remain necessary before release; do not send live messages for validation.
The app cannot determine a provider quota-reset time on its own, and it does not retry failed or unconfirmed sends.
A user can still cancel a pending job from the menu at any time.
