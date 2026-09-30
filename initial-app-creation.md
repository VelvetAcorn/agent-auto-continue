# T3 Code Auto-Continue v2: implementation review

## Outcome

This repository now contains the v2 macOS menu-bar app described here. The implementation is deliberately small: Electron supplies the native tray, single application window, notifications, and launch-at-login support; `node-schedule` supplies durable-in-process timers; the app's own JSON files supply persistence across restarts.

The original proposal was a useful starting point, but it needed correction before it could be shipped:

- It used `node-fetch` v3 through `require`, which fails because v3 is ESM-only. v2 uses Electron/Node's native `fetch`.
- Its first-run token prompt enabled Node integration and disabled context isolation. v2 uses sandboxed renderers, `contextIsolation: true`, and a minimal preload bridge.
- It trusted malformed JSON, renderer input, and clock values. v2 validates all persisted data and IPC inputs, restricts the port range, limits messages to 4,000 characters, and writes JSON atomically with owner-only permissions.
- It listed an `operationId` that was never sent. v2 retains only the identifiers that matter to dispatch: `commandId` and `messageId`.
- It claimed end-to-end verification without recording an actual integration fixture. This document separates implementation checks from the local T3 Code integration checks that still need a live token and server.

## App layout

The production entry point is `dashboard.html`, with `renderer/app.js` for the
Paper Focus views and `renderer/date-time.js` for timezone-aware date controls.
`main.js` owns Electron integration and persistence; `preload.js` exposes the
narrow IPC bridge. Backend responsibilities are split between `lib/api-client.js`,
`lib/job-service.js`, `lib/threads.js`, and `lib/model.js`.
The retained `ui.html` and `settings.html` are no longer opened by the app.
See [the README](README.md) for current usage and the legacy helper boundary.

## Local API contract

The routes were checked against installed T3 Code Alpha 0.0.40 source maps.
The executable request and response contract lives in
[`lib/api-client.js`](lib/api-client.js); the dispatch payload is built by
`buildTurnStartCommand` in [`lib/model.js`](lib/model.js). Consult those sources
rather than a copied payload schema when changing compatibility behavior.
Thread settlement and recency normalization live in
[`lib/threads.js`](lib/threads.js).

The API host is intentionally restricted to loopback to keep credentials and
messages local. Requests have a ten-second timeout. Errors expose structured,
sanitized metadata rather than raw response bodies; dispatch acceptance establishes
delivery, not agent completion. See [the reliability model](README.md#reliability-model)
for handling uncertain outcomes.

### Integration verification boundary

Use the isolated Electron fixture for scheduling and dispatch-related validation;
see [verification commands](README.md#verify-the-source). Do not send live messages
for validation. Real-server compatibility and real macOS sleep/wake remain release
gates; authenticated inspection must remain read-only, with delivery scenarios
using controlled fixtures.

## Job model and delivery safeguards

The authoritative lifecycle and recovery guidance is the
[README reliability model](README.md#reliability-model).
The persisted format, migration, status presentation, and dispatch guards are
implemented in [`lib/job-service.js`](lib/job-service.js), with record validation
in [`lib/model.js`](lib/model.js).

Migration accepts legacy job arrays and writes a versioned envelope. Existing
IDs, statuses and notes are preserved; delivery certainty is separate from the
stored status, so a legacy failure may display as unconfirmed. Legacy jobs without
creation timestamps cannot reconstruct historical activity baselines and retain
an unknown baseline. Corrupt or unsupported stores are not replaced.

JSON replacement is atomic and new files are created mode `0600`.
See [token setup](README.md#run-in-development) and
[storage guidance](README.md#reliability-model) for configuration and data locations.

## UX decisions

See [the README](README.md#run-in-development) for the single-window workflow and
[the development plan](DEVELOPMENT_PLAN.md) for design decisions and review history.

## Build and verification

See [build commands](README.md#build-a-macos-app) and
[source verification](README.md#verify-the-source).
Distribution outside the local Mac requires the normal Apple signing/notarization
process; no Developer ID certificate is bundled with this project.

## Deliberate limits

- The app does not infer provider quota-reset times; the user chooses the schedule.
- It only supports plain-text user messages.
- It does not automatically retry failures.
- Large thread lists are capped at 100 menu items to keep the macOS menu usable.
- The product is macOS-focused. The Electron core is portable, but launch-at-login, icon packaging, and distribution have not been prepared for Windows or Linux.
