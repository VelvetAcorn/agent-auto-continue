# T3 Code Auto-Continue

T3 Code Auto-Continue is a small macOS menu-bar companion that schedules a user message (by default, `Continue`) for an existing T3 Code thread. It uses T3 Code's local orchestration HTTP API; it does not modify the T3 Code app, simulate keyboard input, or send data to a remote service.

## What it does

- Lists active T3 Code threads from the local server.
- Schedules a message for a chosen thread, with `+5 min`, `+30 min`, `+1 hour`, and tomorrow shortcuts.
- Persists jobs through quitting, restarting, and sleep/wake.
- Adds a configurable post-time safety buffer (5 seconds by default).
- Checks the thread before dispatching. It cancels a job if the thread is missing, archived, or has newer user activity.
- Uses stable command/message IDs and inspects the latest snapshot before replaying an interrupted dispatch, reducing duplicate sends after a crash.
- Keeps the token in the app's macOS application-data directory (permissions `0600`) or accepts `T3_TOKEN` only for the current launch.

## Requirements

- macOS and a running T3 Code app exposing its local orchestration HTTP API.
- Node.js 20+ for development.
- A T3 Code bearer token. Create one according to your installed T3 Code version's authentication instructions. The implementation document in this repository uses:

  ```sh
  npx t3 auth session issue --token-only --label t3code-auto-continue --ttl 365d
  ```

## Run in development

```sh
npm install
npm start
```

On launch, the app opens its control window. Enter the bearer token in **Settings** if it is not already configured. The default server address is fixed to `http://127.0.0.1:3773`; Settings only permits changing the port, so the app cannot be pointed at a remote host.

Use the search field to find a thread, choose **Schedule…**, then select a date and time and save. The configured buffer is added to the selected time. The menu-bar icon provides the same controls, but the visible window is the primary interface. Only one copy may run at a time.

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

## Reliability model

Jobs are stored under macOS's app data directory as `jobs.json`; configuration is stored beside it as `config.json`. Do not place either file in this repository or source control.

At dispatch time the app fetches a per-thread snapshot, then posts a `thread.turn.start`-shaped dispatch containing persistent `commandId` and `messageId` values. If the app stopped after starting an outbound dispatch but before storing the response, it reuses those identifiers and first checks whether the message already appears in the snapshot. End-to-end exactly-once delivery ultimately depends on the local T3 Code server honoring the command ID as an idempotency key; the client deliberately never creates a new ID while recovering the same job.

Failures are recorded in the menu and require the user to schedule a new message. The app intentionally does not retry provider failures automatically, which avoids repeatedly sending messages after an unknown quota reset.

## Verify the source

```sh
npm test
node --check main.js
node --check preload.js
```

## Legacy script

`continue-at.sh` and `press-continue.swift` remain as the original, accessibility-based one-shot helper. They are not used by the v2 app and require an unlocked Mac, a focused prepared draft, and Accessibility permission. Prefer the menu-bar app for ordinary use.

## Limits

The app needs the API endpoint and command payload described in [`initial-app-creation.md`](initial-app-creation.md). It cannot determine a provider quota-reset time on its own, and it does not retry a failed send. A user can still cancel a pending job from the menu at any time.
