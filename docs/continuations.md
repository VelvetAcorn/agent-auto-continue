# Automatic continuations

This document specifies auto-start, turn limits and continuous mode ([issue #3](https://github.com/VelvetAcorn/agent-auto-continue/issues/3)).
The rules live in [`lib/continuation.js`](../lib/continuation.js), and [`lib/job-service.js`](../lib/job-service.js) applies them to stored jobs, timers and adapters.
The tests in [`test/continuation.test.js`](../test/continuation.test.js) exercise every rule below with a fake harness, a fake clock and fake timers.

## Terms

A **schedule** is one job in `jobs.json`.
A **turn** is one message the app sends into the conversation, followed by the agent's work until it stops.
**Delivered** means the harness accepted the message.
A **finished turn** means the harness reported that the agent stopped working on that message.
A **finished task** is the user's own judgement, and no harness reports it, so the app never infers it.
The turn limit and the Stop control are the safeguards against continuing past the end of a task.

## Triggers

| Trigger | When the first turn is sent | Requires |
| --- | --- | --- |
| `time` | At the chosen time plus the safety buffer, as before | Nothing |
| `available` | As soon as the harness is available | `canDetectUsageLimit` |
| `time-then-available` | Not before the chosen time, then as soon as the harness is available | `canDetectUsageLimit` |

The composer shows the `available` option and the wait-if-limited checkbox for every harness, disabled with the reason when the harness cannot report limits.
A `time` schedule that meets a limit at its time fails before sending, as before, with error code `usage_limited`.

## Turn limits and continuous mode

`turnLimit` is the total number of turns the schedule may count, including the first, and defaults to 1.
It accepts any whole number from 1 up to JavaScript's largest safe integer.
Zero, negative and fractional values are rejected with an explanation, so 0 never silently means unlimited.
`continuous: true` removes the limit, and the UI then shows Keep continuing until I stop it instead of a number.
Anything other than a single turn requires `canDetectCompletion`, because the next turn is sent only after the previous turn has finished.

A turn counts toward the limit once it is delivered, unless it ends at a usage limit.
A turn that ends at a usage limit does not use up the limit, and the next turn waits for the reset.
Sends that certainly did not arrive never count.

## Chain state

A plain schedule, meaning a `time` trigger with a limit of 1, keeps `chain: null` and behaves exactly as before.
Every other schedule carries `job.chain`:

| Field | Meaning |
| --- | --- |
| `limit` | The turn limit, or `null` for continuous mode |
| `state` | `active`, `paused`, `stopped` or `finished` |
| `reasonCode`, `reason` | Why the chain paused, stopped or finished, for code and for people |
| `previousTurns` | Delivered turns before the current one |
| `limitedTurns` | How many of those ended at a usage limit and do not count |
| `quickStreak`, `limitStreak` | Consecutive quick turns and consecutive usage-limited turns |
| `history` | The last 100 finished turns: number, IDs, delivery key, times, outcome and whether it counted |

The job's own delivery fields always describe the current turn.
When a turn finishes and the chain continues, that turn moves into `history`, and the job receives a fresh `messageId`, `commandId` and delivery key.
A new turn can therefore never be mistaken for an earlier delivery, and an earlier delivery is never resent.
The transition from a finished turn to the next pending turn is a single persisted write.

`paused` needs the user, who can resume or stop the chain.
`stopped` and `finished` are final, and Schedule again prepares a new draft with the same settings.

## What happens after each turn

| Outcome of the current turn | Result |
| --- | --- |
| `completed`, and the limit is not reached | The next turn is queued and sent after the safety buffer |
| `completed`, and the limit is reached | The chain finishes |
| Ended at a usage limit (`usageLimit`, or error code `usage_limited`) | The next turn waits until the reported reset plus the safety buffer, or 15 minutes when no reset time is known; the turn is not counted |
| Three usage-limited turns in a row | The chain pauses (`repeated_limits`) |
| Three completed turns in a row that each took under a minute | The chain pauses (`no_progress`), because the task may already be done |
| `interrupted` with error code `approval_required` | The chain pauses (`awaiting_input`) |
| `failed` (including `agent_error` and `process_failed`), `interrupted` or `unknown` | The chain pauses; nothing further is sent |

When the limit is reached, the chain finishes even if the last turn did not end normally, and the reason says so.

## Before each send

A pending turn of a chain reads the harness's availability before it is sent, while the job is still `pending`, so an interrupted read never looks like an interrupted send.
Only a known block holds the turn back, matching the job service's pre-dispatch rule.
Harnesses that cannot report usage limits, such as T3 Code, skip this read; a turn that ended at a usage limit still waits until its reported reset plus the safety buffer, or 15 minutes.

| Availability reading | Result |
| --- | --- |
| `available` or `unknown` | Send |
| `limited` with a future `resetsAt` | Wait until `resetsAt` plus the job's safety buffer |
| `limited` with a past `resetsAt`, or `inferred` without one | Send; if the limit still applies, the turn outcome reports it |
| `limited`, `reported` without `resetsAt` | Check again after 1, 2, 5, 10, then every 15 minutes |
| `unavailable`, or the read threw | Check again after 1, 2, 5, 10, then every 15 minutes |
| `unavailable` with reason `screen_locked` | Check again every minute, and at once when the Mac is unlocked |

The job service then inspects the conversation, as for every schedule.
For a chain, the following hold the turn back without counting it:

| Conversation state or send error | Result |
| --- | --- |
| Archived, or `conversation_not_found` | The chain stops |
| User activity since the previous turn was sent | The chain pauses (`user_activity`) with the turn still unsent |
| `awaitingInput: true` | The chain pauses (`awaiting_input`) with the turn still unsent |
| `busy: true`, or a certain `conversation_busy` error | The same unsent turn is checked again with the backoff above |
| A certain `screen_locked` error | The same unsent turn is checked again in a minute |
| A certain `usage_limited` error, except on a timed first turn | The same unsent turn waits until the error's `resetsAt` plus the safety buffer, or backs off as above |
| `owned_by_other_harness` | The chain stops and names the owning harness |
| Any other certain failure | The job fails and the chain pauses (`send_failed`) |
| Uncertain delivery | The job becomes unconfirmed and the chain pauses (`delivery_unconfirmed`) |

Our own messages are user messages in the conversation.
User activity therefore counts from two seconds after the previous turn was sent, and messages stamped earlier are the app's own.

## Stopping

`service.stop(id)` is the single entry point for the UI, the tray and remote control.
It never sends, takes effect at once, and works in every state:

| When | Effect |
| --- | --- |
| Waiting, scheduled or paused before sending | The unsent turn is canceled and its timer cleared |
| During an availability read or pre-send checks | Sending is abandoned when the check returns, and the turn is canceled even if the check then fails |
| After the send guard is persisted | That send completes, and nothing further is sent |
| While a turn is running | The turn keeps running in the agent, and nothing further is sent |

For a plain schedule, `stop()` is the same as `cancel()`.
`service.stopAll()` stops every active or paused chain, leaves plain schedules alone, and resolves `{ stopped: [ids] }`.
The Upcoming view shows Stop all whenever a continuation is running, each continuation's detail view has Stop continuing, and the tray offers Stop continuing per schedule and Stop all continuations.

## Resuming

`service.resumeChain(id)` resumes a paused chain and never resends a delivered turn.
It is refused while delivery is unconfirmed; Check delivery, which is read-only, must settle that first.

| Current turn | Result |
| --- | --- |
| Pending and unsent | It is armed again, and activity up to now counts as seen |
| Failed and certainly not delivered | It is replaced by a new unsent turn with new IDs |
| Delivered and still running, or confirmed by Check delivery | Its outcome is tracked again, then the chain continues |
| Delivered and finished | The next turn is queued, or the chain finishes if the limit is reached |

## Restart

Chain state is persisted in store version 4.
Older app versions refuse version 4 files rather than send a paused or availability-gated turn they do not understand.

At startup, `recover()` sends nothing:

| Stored state | Result |
| --- | --- |
| `dispatching` without `dispatchAttemptedAt` | Nothing was submitted, so the turn returns to `pending`, or is canceled if the chain was stopped |
| `dispatching` with `dispatchAttemptedAt` | Unconfirmed, and the chain pauses |
| A finished turn whose follow-up was not written | The follow-up is computed now |
| A delivered turn with no tracked outcome | The chain pauses (`turn_unknown`) |

Waiting turns keep their next check time, and running turns are polled straight away and then every 30 seconds.
An outcome recorded for an earlier turn is ignored, so a late completion can never complete a newer turn.

## Consumer interfaces

| Interface | Use |
| --- | --- |
| `service.activeWork()` | Items gain `nextCheckAt` and `chain: { state, limit, unlimited, currentTurn, sentTurns, remainingTurns }`; `phase` gains `waiting` |
| `service.stop(id)`, `service.stopAll()`, `service.resumeChain(id)` | Stop and resume, for the UI, tray and remote control |
| `service.retryAfterUnlock()` | Called on `unlock-screen` so turns waiting for the unlock are checked at once |
| `present(job).automation` | Trigger, limit, state, reason, `progressLabel`, `sentTurns`, `countedTurns`, `remainingTurns` and the full `turns` list |
| `present(job).displayStatus` | `waiting`, `running`, `paused`, `stopped` or `finished` for chains, otherwise the delivery status |
| `present(job).canStop`, `canResume`, `needsAttention` | Which controls to offer |

`activeWork()` includes every active chain, including the moment between one turn finishing and the next being sent, and excludes paused chains, which wait for the user.
A send already in flight stays in `activeWork()` as `sending` even if its chain is stopped meanwhile.
Upcoming lists active chains, and History lists paused, stopped and finished ones.
A paused chain counts toward the History attention badge until it is resumed, stopped or acknowledged.

IPC adds `jobs:stop`, `jobs:stop-all` and `jobs:resume`.
`schedule:create` and `jobs:edit` accept `trigger`, `turnLimit` and `continuous`.
`harnesses:list` adds `automation: { whenAvailable, multipleTurns }` to each harness, each `{ supported, reason }`, so the UI explains disabled modes in the app's own words.
