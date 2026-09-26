# T3 Code Auto-Continue v2: implementation review

## Outcome

This repository now contains the v2 macOS menu-bar app described here. The implementation is deliberately small: Electron supplies the native tray, settings window, notifications, and launch-at-login support; `node-schedule` supplies durable-in-process timers; the app's own JSON files supply persistence across restarts.

The original proposal was a useful starting point, but it needed correction before it could be shipped:

- It used `node-fetch` v3 through `require`, which fails because v3 is ESM-only. v2 uses Electron/Node's native `fetch`.
- Its first-run token prompt enabled Node integration and disabled context isolation. v2 uses sandboxed renderers, `contextIsolation: true`, and a minimal preload bridge.
- It trusted malformed JSON, renderer input, and clock values. v2 validates all persisted data and IPC inputs, restricts the port range, limits messages to 4,000 characters, and writes JSON atomically with owner-only permissions.
- It listed an `operationId` that was never sent. v2 retains only the identifiers that matter to dispatch: `commandId` and `messageId`.
- It claimed end-to-end verification without recording an actual integration fixture. This document separates implementation checks from the local T3 Code integration checks that still need a live token and server.

## App layout

```
main.js             Electron main process: tray, persistence, API client, scheduling
preload.js          Narrow, context-isolated IPC bridge
ui.html             Schedule window
settings.html       Token/port/buffer settings window
styles.css          Shared native-feeling UI styling
lib/model.js        Pure validation and snapshot helpers
test/model.test.js  Node test coverage for the pure helpers
assets/icon.png     Packaged application icon
```

`continue-at.sh` and `press-continue.swift` are retained only as the legacy, accessibility-driven one-shot helper. They are not part of v2.

## Local API contract

The app assumes the local T3 Code contract researched for this project:

| Operation | Request |
|---|---|
| List threads | `GET http://127.0.0.1:<port>/api/orchestration/snapshot` |
| Inspect one thread | `GET /api/orchestration/threads/<id>?turnLimit=<n>` |
| Add a user message | `POST /api/orchestration/dispatch` |

Each request carries `Authorization: Bearer <token>`. The dispatch body is:

```json
{
  "commandId": "stable UUID for this job",
  "threadId": "target thread ID",
  "message": {
    "messageId": "stable UUID for this job",
    "role": "user",
    "text": "Continue",
    "attachments": []
  },
  "modelSelection": { "model": "current thread model", "instanceId": "current provider" },
  "runtimeMode": "current thread mode",
  "interactionMode": "current interaction mode",
  "createdAt": "2026-09-19T14:00:00.000Z"
}
```

The API host is intentionally not configurable: only the loopback port can change. Every request has a ten-second timeout and response errors are preserved in the job's `note` field without logging the token.

### Required live integration check

Before relying on an installed build, run the app against the target version of T3 Code and confirm all of the following:

1. **Refresh threads** displays expected non-archived threads.
2. A job one minute in the future sends exactly one message to a test thread.
3. A manually added user message after scheduling causes the job to cancel.
4. Quitting and relaunching before the scheduled time preserves the job.
5. Suspending then resuming after the scheduled time sends the job once.

If a server version requires an additional command discriminator in the dispatch body, add it in `runJob` and record the exact supported contract here. This repository does not claim that untested endpoints are stable or documented by a third party.

## Job model and delivery safeguards

A pending job has the following essential fields:

```json
{
  "id": "local UUID",
  "commandId": "dispatch UUID",
  "messageId": "message UUID",
  "threadId": "target thread ID",
  "message": "Continue",
  "scheduleAt": "ISO-8601 UTC timestamp",
  "status": "pending"
}
```

Allowed statuses are `pending`, `dispatching`, `sent`, `failed`, and `canceled`.

At the scheduled time plus the configurable buffer, v2:

1. atomically marks the job `dispatching`;
2. retrieves a fresh thread snapshot;
3. cancels if the thread is missing/archived or has newer user activity;
4. treats an already-observed `messageId` as successfully delivered;
5. posts the dispatch with the existing IDs; and
6. records `sent` or `failed` and sends a native notification.

On a restart, an interrupted `dispatching` job returns to `pending` with the same IDs. It is therefore checked for the existing message before any replay. This is the strongest client-side duplicate protection available without a transaction spanning the local app and T3 Code. Exactly-once delivery still relies on the server treating `commandId` idempotently.

Jobs and configuration live under Electron's user-data directory, not in the repository. JSON replacement is atomic and new files are created mode `0600`. `T3_TOKEN` may be provided in the environment instead; it wins for the current process and is never persisted automatically.

## UX decisions

- The visible control window is the primary UI. It refreshes, filters, and schedules active threads; the tray menu mirrors its controls.
- The app acquires a single-instance lock, so launching another copy focuses the existing control window instead of creating duplicate tray processes.
- The scheduler defaults to five minutes ahead and includes short relative-time controls.
- The chosen time is local time in the UI and is persisted as UTC.
- The buffer is explicit in the schedule window, so a user does not unknowingly schedule before a quota reset.
- Pending jobs may be canceled. Failed sends are not automatically retried: automatic retry after an unknown provider error risks duplicated or unwanted work.

## Build and verification

```sh
npm install
npm test
npm run build
```

The source checks cover config normalization, future-time validation, persisted-job filtering, and nested message-ID detection. `npm run build` produces an arm64 ZIP; `npm run build:dmg` produces a disk image on a host with macOS disk-image tooling, and `npm run build:all` requests both. The current machine successfully assembled and inspected the app and ZIP. Distribution outside the local Mac will require the normal Apple signing/notarization process; no Developer ID certificate is bundled with this project.

## Deliberate limits

- The app does not infer provider quota-reset times; the user chooses the schedule.
- It only supports plain-text user messages.
- It does not automatically retry failures.
- Large thread lists are capped at 100 menu items to keep the macOS menu usable.
- The product is macOS-focused. The Electron core is portable, but launch-at-login, icon packaging, and distribution have not been prepared for Windows or Linux.
