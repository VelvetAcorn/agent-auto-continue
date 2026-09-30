# Agent harness adapters

Agent Auto-Continue sends a scheduled message into an existing conversation of an agent harness.
Each harness is integrated through one adapter that satisfies the contract in this document.
The executable contract is [`lib/harnesses/contract.js`](../lib/harnesses/contract.js), and the in-memory reference adapter is [`tools/fake-harness.cjs`](../tools/fake-harness.cjs).

## Contract version 1

### Layout

| File | Responsibility |
| --- | --- |
| `lib/harnesses/contract.js` | Capability names, `defineHarness()` validation, and normalisers for conversations, availability and turn outcomes |
| `lib/harnesses/errors.js` | `HarnessError`, `toErrorInfo()` and `redact()` |
| `lib/harnesses/registry.js` | `createHarnessRegistry()` and the default harness ID `t3` |
| `lib/harnesses/settings.js` | Storage, validation, resolution and public presentation of adapter settings |
| `lib/harnesses/index.js` | `createHarnesses()`, which builds the production registry |
| `lib/harnesses/<id>.js` | One adapter per harness |

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
| `shutdown()` | No | Called before the app quits; interrupt or release long-running work gracefully |

`ref` is `{ conversationId, deliveryKey }`.
`turn` is a frozen view of a job: `{ jobId, harness, conversationId, message, messageId, commandId, deliveryKey, createdAt, dispatchAttemptedAt, turnId }`.
`messageId` and `commandId` are UUIDs created with the job and never change.
`deliveryKey` is the key returned by `prepareTurn()`, or `messageId` when the adapter returned none.
The job service persists `deliveryKey` and `dispatchAttemptedAt` before calling `submitTurn()`, so a restart never resends automatically.
Use `prepareTurn()` to create a harness-specific key when the harness needs its own ID format.

### Data shapes

A conversation summary is `{ harness, id, title, projectId, projectName, updatedAt, state, settled }`.
`state` is `active`, `settled` or `unknown`, and `settled` is `true`, `false` or `null`; unknown states stay visible.

A conversation state is `{ id, title, projectId, projectName, archived, latestUserActivityAt, delivered, busy, context }`.
`delivered` is true when `ref.deliveryKey` is already present.
`busy` is `true`, `false` or `null` when unknown.
`context` is private to the adapter and is passed back to `prepareTurn()`.

An availability is `{ state, resetsAt, reason, source, checkedAt }`.
`state` is `available`, `limited`, `unavailable` or `unknown`.
`source` is `reported` when the harness returned the value, `inferred` when the adapter derived it from local records, or `none`.
All timestamps are ISO 8601 UTC strings or `null`.

A turn outcome is `{ state, turnId, completedAt, error, usageLimit }`.
`state` is `running`, `completed`, `failed`, `interrupted` or `unknown`.
`usageLimit` is `{ resetsAt, message }` when a turn stopped at a provider usage limit.

`submitTurn()` may also return `completion`, a promise of a turn outcome for work the adapter supervises in-process.

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
| `conversation_busy` | The conversation cannot accept a turn right now |
| `harness_not_installed` | The harness executable or app is missing |
| `harness_not_configured` | A required harness setting is missing |
| `process_failed` | A harness process exited unexpectedly |
| `usage_limited` | A provider usage limit blocks the turn |
| `unknown_harness` | A job names a harness this build does not include |

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
The schedule store is written as version 3.
Version 2 files and legacy arrays load unchanged apart from the added `harness` field.
Older app versions refuse version 3 files without changing them, rather than sending another harness's conversation ID to T3 Code.

Before sending, the job service inspects the conversation, cancels on archive or newer user activity, and fails without sending when `probeAvailability()` reports a limit whose reset time is still in the future.
That failure has error code `usage_limited`, `deliveryCertainty: 'not-delivered'`, and `error.details.resetsAt`, so Schedule again remains available.
For adapters with `canDetectCompletion`, a sent job carries `turn: { state, turnId, completedAt, error, usageLimit, updatedAt }`.
The main process calls `service.pollTurns()` every 30 seconds, and a `completion` promise records the outcome immediately.
Finished turn outcomes are final.

### Consumer interfaces

These interfaces are stable for other features.

| Interface | Use |
| --- | --- |
| `service.activeWork()` | Returns `{ jobId, harness, conversationId, phase, effectiveAt, requiresUnlockedScreen }` for scheduled, sending and running work; `phase` is `scheduled`, `sending` or `running` |
| `onChange` passed to `JobService` | Fires after every persisted job change |
| `adapter.probeAvailability()` | Current usage-limit state and reset time |
| `job.error.code === 'usage_limited'` with `job.error.details.resetsAt` | A schedule that was skipped because of a usage limit |
| `job.turn.usageLimit` | A delivered turn that stopped at a usage limit |
| `registry.describe()` | Serialisable harness metadata and capabilities |

### IPC

| Channel | Payload |
| --- | --- |
| `harnesses:list` | Resolves `{ harnesses: describe(), defaultHarness }` |
| `harnesses:availability` | Takes a harness ID and resolves `{ ok, availability }` or `{ ok: false, error }` |
| `dashboard:threads` | Accepts `{ harness, showSettled }` |
| `connection:check` | Accepts a harness ID |
| `schedule:create` | Accepts `harness` alongside the existing fields |
| `dashboard:schedule-thread` | Accepts a conversation ID and harness ID |
| `settings:save` | Accepts `harnesses: { <id>: { <key>: value } }` alongside the existing fields |

## Adding an adapter

1. Create `lib/harnesses/<id>.js` exporting a factory that returns `defineHarness({...})`.
2. Register it in `createHarnesses()` in `lib/harnesses/index.js`.
3. Add unit tests that use fakes only: a loopback fake server, fake executables on `PATH`, or fixture files.
4. Document discovery sources, delivery evidence, usage-limit signals and limits below.

Desktop-app adapters use `kind: 'desktop-app'` and must set `requiresUnlockedScreen` and `requiresAccessibilityPermission` truthfully.
They should report `delivered` only from evidence read back from the app, and should throw `deliveryUncertain: true` whenever input may have reached the app without confirmation.
