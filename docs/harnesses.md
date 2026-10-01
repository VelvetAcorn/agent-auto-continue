# Agent harness adapters

Agent Auto-Continue sends a scheduled message into an existing conversation of an agent harness.
Each harness is integrated through one adapter that satisfies the contract in this document.
The executable contract is [`lib/harnesses/contract.js`](../lib/harnesses/contract.js), and the in-memory reference adapter is [`tools/fake-harness.cjs`](../tools/fake-harness.cjs).

## Contract version 1

### Layout

| File | Responsibility |
| --- | --- |
| `lib/harnesses/contract.js` | Capability names, `defineHarness()` validation, and normalisers for conversations, availability and turn outcomes |
| `lib/harnesses/errors.js` | `HarnessError`, `toErrorInfo()`, `redact()`, and the drift helpers `appVersionUnsupported()`, `driftMessage()` and `CONTACT_POINTS` |
| `lib/harnesses/registry.js` | `createHarnessRegistry()` and the default harness ID `t3` |
| `lib/harnesses/settings.js` | Storage, validation, resolution and public presentation of adapter settings |
| `lib/harnesses/index.js` | `createHarnesses()`, which builds the production registry |
| `lib/harnesses/<id>.js` | One adapter per harness |
| `lib/harnesses/process.js` | Safe child processes: executable lookup, sanitized environment, timeouts |
| `lib/harnesses/usage-limits.js` | Usage-limit wording and reset-time parsing |
| `lib/harnesses/claude-sessions.js` | Shared reader for Claude Code and Claude Desktop local state |
| `lib/harnesses/codex-reader.js`, `codex-rpc.js`, `websocket.js` | Shared Codex app-server client and transports |
| `lib/harnesses/codex-locks.js` | Shared Codex thread writer-lock inspection |
| `lib/harnesses/session-lock.js` | `isScreenLocked()`, shared locked-screen detection for desktop-app harnesses |
| `lib/desktop/ui-delivery.js` | The shared, verified send sequence for desktop-app harnesses |
| `lib/desktop/mac-automation.js`, `jxa-program.js` | macOS Accessibility driver, run through `osascript` without a shell |
| `lib/desktop/app-labels.js` | Control labels in the app's interface language |
| `lib/desktop/profiles/<id>.js` | One profile per desktop app with every contact point the harness relies on; `profiles/define.js` validates them |
| `lib/desktop/app-location.js` | `createAppLocator()`, which finds the app by bundle ID and resolves files inside it |
| `lib/desktop/compatibility.js` | `checkDesktopCompatibility()`, the shared read-only check behind `checkCompatibility()` |
| `lib/compatibility-monitor.js` | Runs compatibility checks, tracks problems per harness and marks scheduled work at risk |
| `lib/diagnostics.js` | The bounded diagnostics log and its plain-text bug report |

### Identity

Every adapter is a plain object passed through `defineHarness()`, which validates and freezes it.
Construction must be free of side effects: no processes, sockets or file reads may start until a method is called.

| Field | Meaning |
| --- | --- |
| `id` | Stable lowercase slug, persisted as `job.harness`; never rename an ID once shipped |
| `label` | User-facing name, such as `T3 Code` |
| `kind` | `local-api`, `cli` or `desktop-app` |
| `conversationNoun` | `thread`, `session` or `conversation`, used in user-facing wording |
| `description` | One sentence shown in Settings |
| `capabilities` | Object with every capability below as a boolean |
| `settings` | Array of setting descriptors, possibly empty |

### Capabilities

Every capability is required, so consumers never guess a default.

| Capability | True when |
| --- | --- |
| `canDiscoverConversations` | `listConversations()` returns the user's existing conversations |
| `canConfirmDelivery` | A stable per-turn key lets `findDelivery()` prove that a turn arrived |
| `canDetectUserActivity` | `inspectConversation()` reports when the user last sent a message |
| `canDetectCompletion` | `checkTurn()` reports when the agent finished; requires `checkTurn()` |
| `canDetectUsageLimit` | `probeAvailability()` reports provider usage limits; requires `probeAvailability()` |
| `canReportResetTime` | Usage-limit signals include the reset time; requires `canDetectUsageLimit` |
| `requiresRunningApp` | The harness app or server must already be running |
| `requiresUnlockedScreen` | Delivery drives a user interface, so the Mac must be awake and unlocked |
| `requiresAccessibilityPermission` | Delivery needs macOS Accessibility permission |

### Methods

All methods may be asynchronous.
Failures throw `HarnessError(code, message, details, deliveryUncertain)` with a friendly message and sanitized details.
Adapters must never put tokens, passwords or raw response bodies into messages or details; use `redact()` for any process output.

| Method | Required | Contract |
| --- | --- | --- |
| `checkConnection()` | Yes | Resolves `{ ok: true, version? }` when the harness is reachable and authenticated |
| `listConversations({ showSettled })` | Yes | Resolves conversation summaries, newest activity first |
| `inspectConversation(ref, { purpose })` | Yes | Resolves the conversation state used before scheduling (`purpose: 'schedule'`) and before sending (`purpose: 'dispatch'`) |
| `prepareTurn(turn, state)` | Yes | Validates that a turn can be sent and returns `{ deliveryKey?, plan }`; throwing here is always a certain non-delivery |
| `submitTurn(turn, plan)` | Yes | Delivers the turn and resolves `{ turnId?, completion? }` only when the harness has accepted it |
| `findDelivery(turn)` | Yes | Read-only check that resolves `{ delivered }` using the delivery key |
| `checkTurn(turn)` | With `canDetectCompletion` | Resolves a turn outcome for a delivered turn |
| `probeAvailability()` | With `canDetectUsageLimit` | Resolves the account's current availability |
| `checkCompatibility({ depth })` | No | Read-only check that the installed app still matches what the adapter relies on; see [Compatibility checks](#compatibility-checks) |
| `shutdown()` | No | Called before the app quits; interrupt or release long-running work gracefully |

`ref` is `{ conversationId, deliveryKey }`.
`turn` is a frozen view of a job: `{ jobId, harness, conversationId, message, messageId, commandId, deliveryKey, createdAt, dispatchAttemptedAt, turnId }`.
`messageId` and `commandId` are UUIDs created with the job and never change.
`deliveryKey` is the key returned by `prepareTurn()`, or `messageId` when the adapter returned none.
The job service persists `deliveryKey` and `dispatchAttemptedAt` before calling `submitTurn()`, so a restart never resends automatically.
Use `prepareTurn()` to create a harness-specific key when the harness needs its own ID format.

### Data shapes

A conversation summary is `{ harness, id, title, projectId, projectName, updatedAt, state, settled, source }`.
`state` is a short lowercase label for display, such as `active`, `settled`, `working`, `idle` or `unknown`.
`settled` is `true`, `false` or `null` and drives the Show settled filter; unknown states stay visible.
`source` is an optional short label for how the conversation was created, such as Codex's `exec`, or `null`.

A conversation state is `{ id, title, projectId, projectName, archived, latestUserActivityAt, delivered, busy, awaitingInput, context }`.
`delivered` is true when `ref.deliveryKey` is already present.
`busy` is `true`, `false` or `null` when unknown.
`awaitingInput` is `true` when the agent is blocked on the user, such as a question, an approval or permission prompt, or a plan confirmation.
It is optional for adapters and normalises to `null`, meaning unknown; `null` must never block anything.
Adapters set it only from a signal the harness genuinely exposes.
`context` is private to the adapter and is passed back to `prepareTurn()`.

An availability is `{ state, resetsAt, reason, source, checkedAt }`.
`state` is `available`, `limited`, `unavailable` or `unknown`.
`source` is `reported` when the harness returned the value, `inferred` when the adapter derived it from local records, or `none`.
All timestamps are ISO 8601 UTC strings or `null`.

A turn outcome is `{ state, turnId, completedAt, error, usageLimit }`.
`state` is `running`, `completed`, `failed`, `interrupted` or `unknown`.
`usageLimit` is `{ resetsAt, message }` when a turn stopped at a provider usage limit.
`error` is `{ code, message }`.
`error.code` is `usage_limited` for a provider limit, `approval_required` when an unattended turn stopped because the agent asked for approval or input, `agent_error` for other agent failures, `process_failed` when a supervised process died, or `tracking_expired` when the job service stopped following a turn that stayed unresolved for 24 hours.
Automations must treat `approval_required` as a stop condition rather than scheduling another turn.

`submitTurn()` may also return `completion`, a promise of a turn outcome for work the adapter supervises in-process.

A compatibility result is `{ ok, appVersion, verifiedVersion, checkedAt, depth, problems, checked, unchecked }`, normalised by `compatibility()` in `contract.js`.
`problems` is a list of `{ contactPoint, message, hint }`, and `ok` is true exactly when it is empty.
`checked` lists the contact points that were inspected and found working.
`unchecked` lists `{ contactPoint, reason }` for contact points that could not be inspected this time, such as `not_running`, `screen_locked`, `no_conversation_shown`, `agent_working` or `quick`; an unchecked contact point is never a problem.

### Compatibility checks

Adapters that depend on undocumented details of another app implement `checkCompatibility({ depth })`.
It must never navigate, open links, type, press anything or change focus.
`depth: 'quick'` must be cheap, such as reading the installation, version and link registration.
`depth: 'full'` may also inspect what the app currently shows, start a short-lived read-only protocol client, or read files.

Each such detail is a contact point with a stable ID from `CONTACT_POINTS` in `errors.js`:

| Contact point | What it covers |
| --- | --- |
| `app_path` | Where the app and the files the harness reads inside it are installed |
| `deep_link` | The app's URL scheme and the link that opens a conversation |
| `content_match` | How the open conversation's content area is recognised |
| `composer_label` | The accessible label of the message box |
| `send_label` | The accessible label of the send button |
| `stop_label` | The accessible label of the stop button |
| `label_catalogue` | The app's translated label catalogue |
| `session_store` | The app's local session index |
| `live_registry` | The live process registry that reports whether the agent is working |
| `transcript` | The conversation transcript format |
| `originator` | How the app marks the conversations it created |
| `app_server` | The app's built-in protocol server |

The desktop adapters build their check with `checkDesktopCompatibility()` and add app-specific probes as `probes: [{ contactPoints, depth, run }]`.
`run({ profile, env, app, depth })` resolves `{ checked, unchecked, problems: [{ contactPoint, hint }] }`, all optional.
A probe that throws an `app_version_unsupported` error reports a problem; any other error marks its contact points unchecked.
A probe with `depth: 'full'` is skipped by quick checks.

### Delivery semantics

A resolved `submitTurn()` means the harness accepted the message, not that the agent finished.
A rejection with `deliveryUncertain: false` means the message certainly did not arrive.
A rejection with `deliveryUncertain: true` means it may have arrived; the job becomes unconfirmed and is never retried automatically.
Unconfirmed jobs are reconciled only through `findDelivery()`.
Absence of a key from a partial or windowed read is not proof of non-delivery, so adapters report `delivered: false` and the job stays unconfirmed.

### Error codes

| Code | Meaning |
| --- | --- |
| `missing_credentials` | Required credentials are not configured |
| `authentication_rejected` | The harness rejected the credentials |
| `connection_refused` | The harness is not running or not reachable |
| `timeout` | The harness did not answer in time |
| `http_failure` | A local HTTP API returned a failure status |
| `unexpected_response_format` | The response was not the expected format |
| `unsupported_response_shape` | The response parsed but did not match the expected shape |
| `conversation_not_found` | The conversation no longer exists; a pending job is canceled |
| `awaiting_input` | The agent is waiting for the user's answer, so a scheduled message is not sent |
| `conversation_busy` | The conversation cannot accept a turn right now, for example because the agent is still working |
| `harness_not_installed` | The harness executable or app is missing |
| `harness_not_configured` | A required harness setting is missing |
| `owned_by_other_harness` | Another harness owns the conversation; `details.harness` names it |
| `process_failed` | A harness process exited unexpectedly |
| `usage_limited` | A provider usage limit blocks the turn |
| `unknown_harness` | A job names a harness this build does not include |
| `permission_required` | A macOS permission is missing; `details.permission` names it and `details.settingsUrl` opens its System Settings pane |
| `screen_locked` | The Mac is locked or another user is on the console, so a desktop app cannot be driven; always a certain non-delivery |
| `app_version_unsupported` | The app changed in a way this version of Agent Auto-Continue does not understand; always a certain non-delivery, with `details` `{ app, appVersion, verifiedVersion, contactPoint, hint }` |

Build `app_version_unsupported` with `appVersionUnsupported({ app, appVersion, verifiedVersion, contactPoint, hint, during })`, so every adapter words it the same way.
Its message names the app, its installed version and what changed, for example "Claude Desktop 2.17.0 changed how its message box is labelled, so Agent Auto-Continue could not send. Nothing was sent."
Pass `during: 'read'` when a file or protocol read failed rather than a send.
Throw it only on strong evidence and only before anything could have reached the app.
`hint` is a short technical note for bug reports; it is redacted and capped at 300 characters, and must never contain message text.
Use a truthful code for ambiguous failures instead, and add `contactPoint`, `appVersion` and `hint` to its details so the failure is still logged against the contact point.
Every desktop delivery failure carries the installed app version in `details.appVersion`.

Remote control keeps the codes that describe the conversation or the Mac in its errors: `conversation_busy`, `awaiting_input` and `owned_by_other_harness` answer `409`, and `screen_locked`, `permission_required` and `usage_limited` answer `503`.
`conversation_not_found` answers `404 thread_not_found`, `unknown_harness` answers `400`, and every other code answers `502 harness_unavailable`; see [remote control](remote-control.md#errors).

### Settings

A setting descriptor is `{ key, type, label, help?, env?, default? }` with `type` of `port`, `secret` or `text`.
Values are stored in `config.json` under `harnesses[<id>][<key>]`.
An environment variable named by `env` takes precedence over the stored value.
Secrets are never returned to the renderer; only `hasStoredValue` and `usingEnvironment` are exposed.
Blank secret input keeps the stored value, and `{ clear: [key] }` removes it.
Adapters receive resolved values through the `getSettings(id)` function passed to `createHarnesses()`.
The T3 token and port keep their original top-level settings for compatibility.

## Job service integration

Jobs store `harness`, which defaults to `t3` when older records are read.
The schedule store is written as version 4, which adds [automatic continuations](continuations.md).
Version 2 and 3 files and legacy arrays load unchanged apart from the added fields.
Older app versions refuse newer files without changing them, rather than sending another harness's conversation ID to T3 Code or a continuation turn they do not understand.

Before sending, the job service inspects the conversation, cancels on archive or newer user activity, and fails without sending when `probeAvailability()` reports a limit whose reset time is still in the future.
A limit without a reset time blocks only when its `source` is `reported`; an inferred limit without a reset time is sent, and the turn outcome records the limit if it still applies.
It also fails without sending, as a certain non-delivery the user is notified about, when `awaitingInput` is `true` (error code `awaiting_input`) or `busy` is `true` (error code `conversation_busy`).
A `null` value for either never blocks.
That failure has error code `usage_limited`, `deliveryCertainty: 'not-delivered'`, and `error.details.resetsAt`, so Schedule again remains available.
For adapters with `canDetectCompletion`, a sent job carries `turn: { state, turnId, completedAt, error, usageLimit, updatedAt }`.
The main process calls `service.pollTurns()` every 30 seconds, and a `completion` promise records the outcome immediately.
Finished turn outcomes are final.
A turn still `running` 24 hours after delivery is closed as `unknown` with error code `tracking_expired`.
When the app restarts, a send that was interrupted before `dispatchAttemptedAt` was saved is certainly unsent and returns to pending; one interrupted after it becomes unconfirmed.
Version 1 stores did not record send attempts, so their interrupted sends always become unconfirmed.

### Consumer interfaces

These interfaces are stable for other features.

| Interface | Use |
| --- | --- |
| `service.activeWork()` | Returns `{ jobId, harness, conversationId, phase, effectiveAt, nextCheckAt, requiresUnlockedScreen, chain }` for scheduled, waiting, sending and running work, including every active continuation; `phase` is `scheduled`, `waiting`, `sending` or `running`, and `chain` is `null` for plain schedules. Keep-awake tracks it through `lib/active-work-source.js` |
| `service.stop(id)`, `service.stopAll()`, `service.resumeChain(id)` | Stop a schedule or continuation, stop every continuation, or resume a paused one; see [automatic continuations](continuations.md) |
| `onChange` passed to `JobService` | Fires after every persisted job change |
| `adapter.probeAvailability()` | Current usage-limit state and reset time |
| `job.error.code === 'usage_limited'` with `job.error.details.resetsAt` | A schedule that was skipped because of a usage limit |
| `job.turn.usageLimit` | A delivered turn that stopped at a usage limit |
| `registry.describe()` | Serialisable harness metadata and capabilities |
| `observe` and `riskFor` passed to `JobService` | `observe({ harness, jobId, status, error })` hears every new schedule (`status: 'scheduled'`), every send outcome, and a running turn that could not be read because the app changed (`status: 'turn_unreadable'`); `riskFor(harness)` returns `{ message, appVersion, contactPoints }` or `null` |
| `job.risk` | Present on pending and sending jobs and on active continuations whose harness has a compatibility problem; such jobs are never canceled for it |

### IPC

| Channel | Payload |
| --- | --- |
| `harnesses:list` | Resolves `{ harnesses, defaultHarness }`, where each entry is `describe()` plus `automation: { whenAvailable, multipleTurns }` |
| `harnesses:availability` | Takes a harness ID and resolves `{ ok, availability }` or `{ ok: false, error }` |
| `dashboard:threads` | Accepts `{ harness, showSettled }` |
| `connection:check` | Accepts a harness ID |
| `schedule:create` | Accepts `harness`, `trigger`, `turnLimit` and `continuous` alongside the existing fields |
| `jobs:stop`, `jobs:stop-all`, `jobs:resume` | Stop a schedule or continuation, stop every continuation, resume a paused continuation |
| `dashboard:schedule-thread` | Accepts a conversation ID and harness ID |
| `settings:save` | Accepts `harnesses: { <id>: { <key>: value } }` alongside the existing fields |
| `harnesses:open-permission-settings` | Takes no arguments and opens the Accessibility pane of System Settings |
| `harnesses:compatibility` | Resolves the compatibility state of every checked harness: `{ harness, label, appVersion, verifiedVersion, checkedAt, lastPassing, ok, problems }` |
| `harnesses:check-compatibility` | Takes a harness ID, runs a full read-only check and resolves the same list |
| `diagnostics:copy` | Copies the plain-text diagnostics report to the clipboard |
| `compatibility:changed` | Sent to windows when the compatibility state changes |

## Adding an adapter

1. Create `lib/harnesses/<id>.js` exporting a factory that returns `defineHarness({...})`.
2. Register it in `createHarnesses()` in `lib/harnesses/index.js`.
3. Add unit tests that use fakes only: a loopback fake server, fake executables on `PATH`, or fixture files.
4. Document discovery sources, delivery evidence, usage-limit signals and limits below.

Desktop-app adapters use `kind: 'desktop-app'` and must set `requiresUnlockedScreen` and `requiresAccessibilityPermission` truthfully.
They should report `delivered` only from evidence read back from the app, and should throw `deliveryUncertain: true` whenever input may have reached the app without confirmation.
They keep every app-specific detail in a profile under `lib/desktop/profiles`, locate the app with `createAppLocator()`, implement `checkCompatibility()` with `checkDesktopCompatibility()`, and pass the profile's `verifiedVersion` to delivery.
They send through `deliverThroughUi()` in `lib/desktop/ui-delivery.js`, and report `{ state: 'unavailable', reason: 'screen_locked', source: 'reported' }` from `probeAvailability()` while the screen is locked.
A one-off schedule that fires while the screen is locked fails as not sent with `screen_locked`.
An automatic continuation waits instead: the same unsent turn is checked again every minute and when the Mac is unlocked (see [automatic continuations](continuations.md)).
Keep-awake keeps the display on for these tasks, but it cannot unlock a locked screen, so desktop-app schedules need the Mac left unlocked.
See [desktop-harnesses.md](desktop-harnesses.md) for the design and the investigation behind it.

## Shared helpers

These modules are the single reader for each external file or protocol, and the desktop adapters import them rather than parsing the same data again.
Functions accept `{ home, env }` so tests can point them at fixtures.

`lib/harnesses/claude-sessions.js` exports:

| Export | Returns |
| --- | --- |
| `claudePaths(options)` | `{ configDir, projectsDir, sessionsDir, desktopDir }` |
| `readDesktopCodeSessionStore(options)` | `{ found, files, sessions, unrecognised, drift }`, where `drift` is a hint when the session files no longer look like the known store |
| `readDesktopCodeSessions(options)` | Claude Desktop Code sessions as `{ sessionId, cliSessionId, cwd, originCwd, title, archived, createdAt, lastActivityAt }` |
| `desktopOwnedCliSessionIds(options)` | A `Set` of lowercase CLI session IDs that Claude Desktop owns, archived or not |
| `readLiveRegistry(options)` | `{ found, pids, sessions, unidentified }` for alive processes only; `sessions` maps a CLI session ID to the entry that refuses most firmly, and `unidentified` lists live entries that name no session |
| `readLiveSessions(options)`, `readLiveSession(cliSessionId, options)` | Live registry entries `{ pid, status, state, drift, waitingFor, entrypoint, kind, hostSessionId, name, updatedAt }`; `state` is `busy`, `waiting`, `idle`, `starting` or `unrecognised`, and `drift` says what changed when unrecognised |
| `readClaudePlanUsage(options)` | The newest plan-usage sample `{ sampledAt, org, fiveHourPct, sevenDayPct }` or `null`; pass `org` to filter |
| `findTranscriptPath(cliSessionId, options)` | The transcript path or `null` |
| `readHumanPrompts(file)` | Typed prompts `{ uuid, timestamp, text }`, excluding tool results, meta, synthetic, compact-summary and sidechain records |
| `scanTranscript(file, promptUuid)` | Working directory, permission mode, latest human prompt time, whether `promptUuid` is present, the records after it, whether Claude Desktop wrote to the session (`desktopOwned`) and a format-change hint (`drift`) |
| `transcriptDrift(records)` | A hint when transcript records no longer look like the known format, or an empty string |
| `turnOutcomeAfter(file, promptUuid, { running, now })` | A turn outcome for the turn after `promptUuid` |
| `listTranscripts`, `summariseTranscript`, `recentLimitSignal`, `isHumanPrompt` | Listing and usage-limit helpers |

Pass `isAlive` in `options` to replace the process liveness check in tests, and `now` to fix the clock.
Claude Desktop's compatibility probes, which read these files without changing anything, are in `lib/harnesses/claude-desktop-probes.js`.

`lib/harnesses/codex-reader.js` exports `createReader({ executable, env, home, transport, detectDaemon, requestTimeoutMs })` (also named `createCodexReader`).
The reader offers `listThreads()`, `listAllThreads({ archived, sourceKinds })`, `readThread(id)`, `recentTurns(id, limit)`, `rateLimits()`, `account()`, `turnOutcome(turn, limit)`, `threadWriter(threadId)`, `selectTransport()`, `open()`, `withClient()` and `close()`.
`listAllThreads()` follows every page in creation order and resolves `{ threads, complete }`, where `complete` is false when the listing may have been cut short.
It requests every top-level source kind by default (`TOP_LEVEL_SOURCE_KINDS`), because `thread/list` otherwise returns interactive threads only and hides `codex exec` threads.
`recentTurns()` returns the newest turns first, each with `id`, `status`, `startedAt`, `completedAt`, `error` and summary `items`, where user message items carry `clientId`.
`rateLimits()` returns `{ reached, resetsAt, usedPercent, reason }` or `null`.
Each call uses its own short-lived connection, so `close()` has nothing to release.
`executable` is a path or a function returning one, so the desktop adapter can use the app-bundled binary.
The module also exports `ownerOfThread(thread)`, which returns `codex-desktop`, `t3`, `codex` or `other`, `isDesktopThread(thread)`, `limitFromRateLimits()`, `outcomeFromTurn()` and `daemonAvailable(socketPath)`.

`lib/harnesses/codex-locks.js` exports `codexThreadWriter(threadId, { selfPids, run })`, which resolves `{ pid, owner }` with `owner` of `self`, `daemon`, `codex-desktop` or `other`.
It resolves `null` when no process holds the lock, and `undefined` when holders cannot be determined.
`readCodexThreadWriters()` returns a `Map` of every held lock, and `codexPaths()` returns the Codex home, lock directory, daemon PID file and control socket.
Both run `/usr/sbin/lsof` and `/bin/ps` with argument arrays and timeouts, never a shell; `run` replaces them in tests.

## Child processes

Every harness process starts in its own process group.
Stopping it signals the whole group, so helpers it started, such as MCP servers, stop with it.
After a process exits, its output is drained for 500 milliseconds before the pipes are closed and the rest of its group is stopped.
Claude Code is interrupted with SIGINT to its main process only, which ends its turn cleanly.

## Adapters

All adapters were verified on 2026-10-01 against the versions listed, using read-only calls, isolated servers, and zero-cost probes that named a nonexistent model so no paid inference ran.
The on-disk and protocol details below are internal to each tool unless stated otherwise, and each adapter parses them defensively.

### T3 Code (`t3`)

The adapter uses T3 Code's loopback orchestration API as before; the client lives in `lib/api-client.js`.
Delivery evidence is the `{sequence}` acceptance response or the stable message ID in the thread.
`awaitingInput` follows T3 Code 0.0.40's own open-request accounting of `approval.*` and `user-input.*` activities.
Completion was derived from the T3 Code 0.0.40 server sources and has not yet been observed against a live T3 Code turn.
The thread's `latestTurn.requestedAt` is the `createdAt` of the `thread.turn.start` command that started it, so the adapter records that time as the turn key and maps `latestTurn.state` to the turn outcome.
A `provider.turn.start.failed` activity whose `payload.requestId` is the message ID means the turn failed to start.
A failed turn reports a usage limit when the session's `lastError` reads as one, with its reset time when the text states one.
When a later turn has replaced the scheduled one, or the turn has not started within 15 minutes, the outcome is `unknown`.
Turns confirmed through reconciliation have no recorded command time, so their outcome is `unknown`.
T3 Code does not expose account-level usage limits, so availability is not reported.

### OpenCode (`opencode`)

The adapter was verified with OpenCode 1.18.34 and its documented server API.
Start the server with `opencode serve --port 4096`, or run the TUI with `--port`, and set the port in Settings; the adapter connects only to `127.0.0.1`.
When the server sets `OPENCODE_SERVER_PASSWORD`, enter the password in Settings or launch the app with the same variable.
`OPENCODE_SERVER_USERNAME` overrides the default username `opencode`.

| Need | Source |
| --- | --- |
| Connection | `GET /global/health` |
| Discovery | `GET /project`, then `GET /session?roots=true` for the server's default project and `GET /session?directory=<worktree>&roots=true` for each project |
| User activity | Latest user message in `GET /session/:id/message?limit=50` |
| Waiting on the user | Pending entries for the session in `GET /permission` and `GET /question` |
| Sending | `POST /session/:id/prompt_async` with `messageID`, the session's last `agent`, `model` and `variant`, and a text part; `204` means accepted |
| Delivery evidence | `GET /session/:id/message/:messageID`; resending the same `messageID` was verified to be idempotent |
| Completion | `GET /session/status`, then the assistant reply whose `parentID` is the message |
| Usage limits | A `retry` session status whose message reads as a usage limit, with `next` as the earliest retry time, or an assistant `APIError` with status 429 |

A session that is busy or waiting on a permission or question when a schedule is due is refused rather than sent, so the message is not queued behind the current work.
A refused connection never reaches OpenCode, so a send that fails that way is a certain non-delivery.
OpenCode sorts messages by ID, so the delivery key uses OpenCode's ascending format and is created when sending, not when scheduling.
Sessions of the global project whose directory is not the server's own directory are not returned by the documented listing and do not appear.
OpenCode does not report account quotas, so availability is `unknown` unless a session is waiting on a limit.

### Claude Code (`claude-code`)

The adapter was verified with Claude Code 2.1.286 and its documented headless mode.
Sending runs `claude -p --resume <session> --input-format stream-json --output-format stream-json --verbose --replay-user-messages` in the session's recorded working directory.
The prompt is written to stdin as a user message whose `uuid` is the job's message ID, so it never appears in the process list.
`--permission-mode` repeats the session's last recorded mode; the transcript value `default` maps to the CLI's `manual`, and unknown values are omitted.
Delivery is confirmed when Claude Code replays that `uuid` on stdout; if the replay does not arrive within two minutes, the transcript is the authority.
After the process exits, the transcript is re-read for a two-second flush grace; absence of the `uuid` after that is a certain non-delivery.
Claude Code records an interruption (Esc or SIGINT) as a user record reading `[Request interrupted by user]`; it ends the turn as `interrupted` and does not count as user activity.

Discovery reads transcripts under `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`, newest 150 first, using the head and tail of each file for the title and working directory.
Titles prefer a user rename, then Claude's generated title, then the first typed prompt.
Sessions owned by Claude Desktop are hidden, and sending to one fails with `owned_by_other_harness`.
A session is Claude Desktop's when its store lists it or when its transcript has messages whose `entrypoint` is `claude-desktop`, so a changed Desktop store cannot expose them.
Sessions open in any live Claude process, from the registry in `sessions/<pid>.json`, fail with `conversation_busy`, because a second writer would fork the conversation.
A live registry entry that names no session could hold any session, so every send refuses with `app_version_unsupported` for the `live_registry` contact point.
A transcript whose records no longer look like the known format refuses with `app_version_unsupported` for the `transcript` contact point, because new user activity could not be seen.
Exit that Claude Code session after scheduling so the turn can resume it.

Completion comes from the supervised process's final `result` event, or from the transcript after a restart.
Usage limits come from Claude Desktop's account-wide plan-usage samples when one is under 20 minutes old.
Otherwise they come from the most recent limit message in recent transcripts, with its reset time when the message states one.
Both signals are `inferred`, so a limit without a reset time does not block sending.
`claude auth status --json` checks sign-in.
Quitting the app interrupts running turns with SIGINT, which Claude Code documents as ending the turn cleanly.
Headless permission prompts are denied by Claude Code itself; the turn continues without the denied action.

### Codex (`codex`)

The adapter was verified with codex-cli 0.159 and the app-server protocol that `codex app-server generate-json-schema` publishes.
Thread storage moved from rollout files to SQLite in this version, so the adapter uses the protocol rather than reading storage.

Transport selection happens for every connection.
When the shared app-server daemon's control socket, `$CODEX_HOME/app-server-control/app-server-control.sock`, accepts a connection, the adapter talks to the daemon through `codex app-server proxy`.
The proxy relays the socket's bytes, and the socket speaks WebSocket, so the adapter performs the upgrade handshake and frames JSON-RPC messages.
If that handshake fails, the operation fails; the adapter never falls back to a private server while a daemon runs.
Otherwise the adapter starts a private `codex app-server` over stdio.
Daemon turns keep running in the daemon, so quitting the app does not interrupt them and completion is polled.
Private-server turns are interrupted cleanly when the app quits.

| Need | Protocol call |
| --- | --- |
| Connection and sign-in | `account/read` |
| Discovery | `thread/list` for every top-level source kind, following every page, excluding subagent and ephemeral threads |
| User activity and delivery evidence | `thread/turns/list`; user message items carry `clientId` |
| Sending | `thread/resume`, then `turn/start` with `clientUserMessageId` set to the job's message ID |
| Completion | The `turn/completed` notification, or the turn's status from `thread/turns/list` |
| Usage limits | `account/rateLimits/read`, which Codex reports with reset times |

`codex exec resume` uses the same requests internally but cannot carry a client message ID, so it cannot prove delivery.
Threads belong to the app that created them.
Threads with originator `Codex Desktop`, and older top-level threads with no originator and source `vscode`, belong to the Codex desktop harness.
Threads whose originator starts with `t3code` belong to T3 Code, which drives its own Codex process for them.
The Codex CLI adapter claims only threads with originator `codex_cli_rs` or `codex_exec`, or with no originator and source `cli` or `exec`; any other originator, such as an IDE extension, is reported as `other`.
Threads it does not own are not listed, and sending to one fails with `owned_by_other_harness`.
An unknown originator is never claimed by either Codex adapter, even when an app update renamed the desktop app's originator; the Codex desktop harness reports that case as an app change instead (see [desktop-harnesses.md](desktop-harnesses.md#chatgpt-desktop-app-codex-threads-codex-desktop)).
A JSON-RPC `Method not found` error never counts as a missing thread, so it cannot cancel a job.
Every turn is checked before busy detection or user activity reads it, both when inspecting and right before `turn/start`.
A turn status other than `completed`, `interrupted`, `failed` or `inProgress`, a malformed `startedAt`, or a user message without content fails with `unsupported_response_shape` instead of reading as idle.
Its message names the codex version from the `initialize` reply, and its details carry contact point `app_server` and a hint naming the request.
The CLI has no app bundle or verified app version, so `app_version_unsupported` would not fit; the remedy is a Codex version this app supports.
Listed threads show their source, so threads created by `codex exec` automation are recognisable.

Codex serialises writers with a lock file per thread, and a second `thread/resume` fails with "already has an active writer".
Before sending, and again immediately before `turn/start`, the adapter refuses with `conversation_busy` when a process other than the server it writes through holds the lock, or when a turn is already in progress.
A fresh server cannot see another server's in-memory thread status, so the guard relies on the lock and on in-progress turns rather than on thread status.
When the lock holder cannot be determined, the guard refuses.
Lock paths are compared through their real paths, because `lsof` reports resolved paths.
An in-progress turn is reported as running only while some server holds the thread's lock, so a private-server turn that ended with its server is not mistaken for a daemon turn.
Approval requests are answered only by the connection running that thread; read-only connections never answer, so another client's approval is left for that client.
The app runs unattended, so approval requests are answered with the choice that stops the turn, and other requests for input are refused and the turn is interrupted.
The outcome is then `interrupted` with error code `approval_required`.

### Claude Desktop (`claude-desktop`)

The adapter was built against Claude Desktop 2.16120.0 and covers its Code sessions; sending in the real app awaits the owner's check.
It opens a session with `claude://code/continue?session=local_<uuid>`, sets the message through Accessibility and presses send; it never starts `claude` itself.
Discovery, activity, busy state, delivery evidence, completion and usage limits come from `claude-sessions.js`.
A Stop button near the message box is a second busy signal, independent of the live registry.
Delivery is confirmed by a typed prompt with exactly the scheduled text in the session transcript, written after the send attempt.
An unrecognised live status, transcript format or session store refuses with `app_version_unsupported` before anything is typed, and `checkCompatibility()` probes all three and the label catalogue.
Usage limits are inferred from Claude Desktop's plan-usage samples, without a reset time.
Chat conversations are not supported; [desktop-harnesses.md](desktop-harnesses.md) explains why and lists every detail.

### ChatGPT desktop app, Codex threads (`codex-desktop`)

The adapter was built against the merged ChatGPT and Codex app 26.915.31945, bundle `com.openai.codex`; sending in the real app awaits the owner's check.
It covers the Codex threads the app created, which the app keeps loaded with their writer locks held.
It opens a thread with `codex://threads/<threadId>`, verifies it by the thread name, sets the message through Accessibility and presses send.
Everything else uses `codex-reader.js` with the codex binary bundled in the app, including busy state, delivery evidence, completion and usage limits with reset times.
ChatGPT chats are not supported; [desktop-harnesses.md](desktop-harnesses.md) explains why and lists every detail.
