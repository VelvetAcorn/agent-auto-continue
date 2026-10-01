# Keep the Mac awake until scheduled work completes

This is the investigation and design record for [issue #5](https://github.com/VelvetAcorn/agent-auto-continue/issues/5).
It was written on 2026-09-30 and 2026-10-01, and the implementation described in [Implementation](#implementation) follows it.
Measurements come from one Mac: an Apple M1 Pro MacBook Pro on macOS 26.5.1 (build 25F80), on AC power, with Electron 33.4.11.

## Summary

The app uses Electron's `powerSaveBlocker`.
`prevent-app-suspension` is the default and keeps the system awake while letting the display sleep.
`prevent-display-sleep` is used when the user asks for it, or when a task drives an app's user interface.
The app never uses `sudo`, never runs `pmset` to change settings, and never uses `pmset disablesleep`.

Keep-awake is opt-in and off by default.
While it is on, the app holds one assertion for as long as tracked work across all registered work sources is waiting or running.
It releases the assertion when the work completes, when the user stops it, at a battery floor, at a time limit, when the app quits, and when the app crashes.
The spike confirmed that macOS releases the assertion on crash or `SIGKILL`.

Closing a laptop lid is a forced sleep that no unprivileged assertion prevents.
The app supports closed-display mode only where Apple supports it: with power, an external display, and an external keyboard or mouse connected.

## 1. Mechanisms compared

### Electron `powerSaveBlocker`

Electron documents two blocker types.
[`prevent-app-suspension`](https://www.electronjs.org/docs/latest/api/power-save-blocker) "Keeps system active but allows screen to be turned off".
`prevent-display-sleep` "Keeps system and screen active".
The same page states that "`prevent-display-sleep` always takes precedence over `prevent-app-suspension`".

Chromium implements both in [`power_save_blocker_mac.cc`](https://chromium.googlesource.com/chromium/src/+/main/services/device/wake_lock/power_save_blocker/power_save_blocker_mac.cc).
`prevent-app-suspension` becomes `IOPMAssertionCreateWithName(kIOPMAssertionTypeNoIdleSleep, ...)`.
`prevent-display-sleep` becomes `kIOPMAssertionTypeNoDisplaySleep`.
The IOKit header says both names are deprecated aliases of `PreventUserIdleSystemSleep` and `PreventUserIdleDisplaySleep`, and that the aliases behave identically.
Electron passes `ELECTRON_PRODUCT_NAME` as the assertion name ([source](https://github.com/electron/electron/blob/main/shell/browser/api/electron_api_power_save_blocker.cc)), which is always `Electron`.
`pmset -g assertions` also lists the owning process name, so a packaged build is still identifiable.
The Claude desktop app on this Mac already appears as `pid 74881(Claude): NoIdleSleepAssertion named: "Electron"`.

### `caffeinate`

`man caffeinate` documents these flags.

| Flag | Assertion observed in the spike | Meaning |
| --- | --- | --- |
| `-i` | `PreventUserIdleSystemSleep` | Prevent system idle sleep; this is the default when no flag is given |
| `-d` | `PreventUserIdleDisplaySleep` | Prevent display idle sleep |
| `-m` | `PreventDiskIdle` | Prevent disk idle sleep |
| `-s` | `PreventSystemSleep` | Prevent system sleep; "valid only when system is running on AC power" |
| `-u` | `UserIsActive` | Declare user activity and turn the display on; the default timeout is 5 seconds |
| `-t <seconds>` | Timeout on the assertion | Ignored when a utility is given |
| `-w <pid>` | Released when that process exits | Ignored when a utility is given |

With a utility argument, such as `caffeinate -i make`, the assertion lasts for the life of the utility and is labelled as `caffeinate asserting on behalf of '<utility>' (pid N)`.
The legacy helper in [`legacy/continue-at.sh`](../legacy/continue-at.sh) runs `caffeinate -di -w $$`, which ties the assertion to the shell script's life.

### IOKit `IOPMAssertionCreateWithName`

The SDK header `IOKit.framework/Headers/pwr_mgt/IOPMLib.h` documents the types directly.

- `PreventUserIdleSystemSleep`: "The display may dim and idle sleep while kIOPMAssertPreventUserIdleSystemSleep is enabled, but the system may not idle sleep. The system may still sleep for lid close, Apple menu, low battery, or other sleep reasons."
- `PreventUserIdleDisplaySleep`: "the display may still sleep for other reasons, like a user closing a portable's lid or the machine sleeping."
- `PreventSystemSleep`: the header says "Deprecated in 10.9. This assertion is not supported in any OS X releases."
  In practice `caffeinate -s` still creates a live `PreventSystemSleep` assertion on macOS 26.5.1, and the man page says it only applies on AC power.
  Apple's [QA1340](https://developer.apple.com/library/archive/qa/qa1340/_index.html) states that "it is not possible to prevent forced sleep, only delay it", and that closing the lid or choosing Sleep from the Apple menu both cause forced sleep.
- `IOPMAssertionCreateWithName`: "No special privileges are necessary to make this call - any process may activate a power assertion."

A native addon would let the app choose a descriptive assertion name and use `PreventSystemSleep`.
Neither changes what happens when the lid closes.

### `pmset`

`man pmset` states that "pmset must be run as root in order to modify any settings", and that settings persist in `/Library/Preferences/SystemConfiguration/com.apple.PowerManagement.plist`.
`pmset disablesleep 1` is not in the man page but sets `SleepDisabled`, which disables sleep system-wide, including when the lid closes.
Because it is a persistent system setting rather than a process assertion, it survives the app crashing.
A MacBook left asleep in a bag with sleep disabled can overheat and drain its battery.
Amphetamine's own [Power Protect](https://github.com/x74353/Amphetamine-Power-Protect) helper does exactly this through a `sudoers` entry for `/usr/bin/pmset -a disablesleep 1` and `0`.
Its companion [Amphetamine Enhancer](https://github.com/x74353/Amphetamine-Enhancer) installs a LaunchAgent that checks every 10 seconds and re-enables sleep if Amphetamine exited without doing so.
That design shows how much machinery is needed to make `disablesleep` safe.

The app uses `pmset` only to read state: `pmset -g batt` for the battery percentage, and `pmset -g assertions` in tests.

### Recommendation

Use Electron `powerSaveBlocker`: `prevent-app-suspension` by default, and `prevent-display-sleep` when the display must stay on.

| Criterion | `powerSaveBlocker` | `caffeinate` child process | Native IOKit addon | `pmset disablesleep` |
| --- | --- | --- | --- | --- |
| Privileges | None | None | None | Root |
| Released on crash | Yes, verified | Yes with `-w`, verified | Yes | No, persists |
| Extra process or build step | No | A child process to supervise | Native build, signing, Electron ABI upgrades | A privileged helper |
| Lid-close behaviour | Sleeps | Sleeps | Sleeps | Stays awake, which is risky |
| Testability | Injected adapter, verified by `pmset` | Process lifecycle tests | Native test harness | Needs root in tests |
| Maintenance | Supported Electron API | Stable CLI | Highest | Highest risk |

It is the only option that is in-process, unprivileged, released automatically on any exit, and covered by Electron's API stability.
The alternatives either add a process or native code for no gain in what stays awake, or change a system setting in a way that is unsafe if the app crashes.
`PreventSystemSleep` is the one capability `powerSaveBlocker` lacks, and the header documents it as unsupported.

## 2. Empirical spike

The spike scripts lived in `/tmp/keepawake-spike/` and are not committed.
They made no system setting changes and used no `sudo`.
The committed tests in [`tools/electron-smoke.cjs`](../tools/electron-smoke.cjs) and [`tools/keep-awake-e2e.cjs`](../tools/keep-awake-e2e.cjs) repeat the key checks against the production app.
This Mac's settings show `sleep 0`, which means automatic sleep on power is already disabled.
The spike therefore measured which assertions appear and when they are released, not whether the Mac would otherwise have slept.

### `powerSaveBlocker` assertions

Output from an Electron 33.4.11 main process, filtered to its own PID:

```text
prevent-app-suspension started: pid 70832(Electron): NoIdleSleepAssertion named: "Electron"
prevent-app-suspension stopped: (none)
prevent-display-sleep started:  pid 70832(Electron): NoDisplaySleepAssertion named: "Electron"
                                system-wide PreventUserIdleDisplaySleep 0 -> 1
prevent-display-sleep stopped:  (none)
both types, three ids:          pid 70832(Electron): NoDisplaySleepAssertion named: "Electron"
after stopping the display id:  pid 70832(Electron): NoIdleSleepAssertion named: "Electron"
after stopping 1 of 2 app ids:  pid 70832(Electron): NoIdleSleepAssertion named: "Electron"
after stopping all:             (none)
powerSaveBlocker.stop(9999):    false
```

Chromium collapses several blockers into one IOKit assertion of the strongest type and reference-counts the IDs.

### Release on exit

A child Electron process took both blocker types and was then ended five ways.

| Ending | Exit | Assertion while alive | After exit |
| --- | --- | --- | --- |
| `SIGTERM` | `0` | `NoDisplaySleepAssertion` | Released |
| `SIGKILL` | `SIGKILL` | `NoDisplaySleepAssertion` | Released |
| `process.crash()` | `SIGSEGV` | `NoDisplaySleepAssertion` | Released |
| `app.quit()` without `stop()` | `0` | `NoDisplaySleepAssertion` | Released |
| `process.exit(0)` without `stop()` | `0` | `NoDisplaySleepAssertion` | Released |

This matches powerd's open-source [`PMAssertions.c`](https://github.com/apple-oss-distributions/PowerManagement/blob/main/pmconfigd/PMAssertions.c), which watches each client with `DISPATCH_PROC_EXIT` and releases all of its assertions in `HandleProcessExit`.

One caution came out of the spike.
The first spike run quit its parent before killing a child, and that orphaned child kept a `NoDisplaySleepAssertion` for about 20 minutes until it was found and killed.
Assertions end with the process that holds them, not with its parent, which is another reason to hold the assertion in the app's own process.
The committed E2E driver kills its fixture in a `finally` block.

### `caffeinate`

```text
caffeinate -i -t 5:    PreventUserIdleSystemSleep named: "caffeinate command-line tool"
caffeinate -m -t 5:    PreventDiskIdle named: "caffeinate command-line tool"
caffeinate -s -t 5:    PreventSystemSleep named: "caffeinate command-line tool"
caffeinate -d -t 5:    PreventUserIdleDisplaySleep named: "caffeinate command-line tool"
caffeinate -u -t 5:    UserIsActive named: "caffeinate command-line tool"
caffeinate -dims -t 5: PreventUserIdleSystemSleep, PreventUserIdleDisplaySleep, PreventSystemSleep, PreventDiskIdle
caffeinate -i -w PID:  released and caffeinate exited when the watched process exited
kill -9 caffeinate:    released
caffeinate -u:         "Timeout will fire in 19 secs" with -t 20; without -t the details read "caffeinate asserting forever"
```

### AC and battery detection

| Source | Result |
| --- | --- |
| `powerMonitor.isOnBatteryPower()` and `powerMonitor.onBatteryPower` | `false` |
| `powerMonitor.getCurrentThermalState()` | `nominal` |
| `pmset -g batt` | `Now drawing from 'AC Power'` and `-InternalBattery-0 (id=34996323) 100%; charged; 0:00 remaining present: true` |
| `navigator.getBattery()` on a `file://` page | `{ charging: true, level: 1, chargingTime: 0, dischargingTime: null }` |
| `navigator.getBattery()` on a `data:` page | Unavailable, because it is not a secure context |

Electron's main process does not expose the battery percentage.
The app reads `pmset -g batt` at most once per minute, and only while on battery with a session holding or about to hold an assertion that the battery floor can end, rather than depending on a renderer window being open.
`ioreg` reported `AppleClamshellCausesSleep = No` with an external display attached, which is the flag that closed-display mode clears.

### App Nap and timers

Two Electron main processes with hidden Dock icons ran for 180 seconds, one holding `prevent-app-suspension`.

| Process | 1-second interval lateness (n, p50, p95, max) | 60-second timeout lateness |
| --- | --- | --- |
| With blocker | 179, 5 ms, 6 ms, 11 ms | 2 ms |
| Without blocker | 179, 4 ms, 6 ms, 12 ms | 3 ms |

No App Nap throttling was observed in this window, on AC power, with the user active.
The spike is short, so the design does not rely on it.

## 3. Amphetamine as a product reference

Amphetamine, by William Gustafson ([Mac App Store](https://apps.apple.com/us/app/amphetamine/id937984704?mt=12)), is the reference for session behaviour.

- Sessions run "Indefinitely, for a specified amount of time, or until a specified time", "While a file is downloading", or "While a specific app is running".
- Triggers start sessions automatically, for example when an external display is connected, a power adapter is connected, the Mac is on a given Wi-Fi network, a drive is mounted, the CPU passes a threshold, or the Mac has been idle for a while.
- Each session can allow or prevent display sleep, screen saver activation, "System sleep when built-in display is closed", and locking of the screen.
- It can "Auto-end session if your Mac's battery is low", and triggers can require that the battery is charging or above a threshold.
- Closed-display mode on Apple silicon laptops needs the separately downloaded Power Protect helper, because "Apple won't allow Amphetamine to directly install the script and configuration file needed".
  Amphetamine 5.3 notes that closed-display mode on Apple silicon previously failed when power was connected or disconnected, and that it forces the built-in display to sleep when closed to prevent burn-in.
- Amphetamine Enhancer adds the closed-display fail-safe and full process discovery, because a sandboxed App Store app cannot list every running process.

What maps well onto "stay awake until all tracked tasks complete":

| Amphetamine concept | This app |
| --- | --- |
| While a file is downloading | While tracked work is waiting or running: this is the core session type |
| While an app is running | Optional: while any T3 Code agent turn is running |
| For a duration, as a safety net | The per-session time limit |
| Allow display sleep | Default on; "Keep the display on too" turns it off |
| End when the battery is low | Battery floor, plus an AC-only mode |
| Closed-display mode through a privileged helper | Not adopted; documented supported configurations instead |
| Triggers | Not needed, because tracked work is the trigger |

## 4. Lid closed

Apple's current article on [external displays with Apple silicon laptops](https://support.apple.com/en-us/117373) requires an "External keyboard and mouse or trackpad" with the lid closed, and says "If the external display provides power to the Mac, a separate power adapter isn't needed."
The retired [closed-display mode article HT201834](http://web.archive.org/web/20210409014733/https://support.apple.com/en-us/HT201834) required "An AC power adapter or an external display that provides power over USB-C or Thunderbolt 3", an external display or projector, and "An external keyboard and mouse or trackpad".
Without those, closing the lid is a forced sleep.
No unprivileged API prevents it, and only `pmset disablesleep` works around it, which this app rejects for the reasons above.

Apple silicon and Intel laptops follow the same documented requirements.
The differences are in third-party workarounds: Amphetamine needs Power Protect only on Apple silicon laptops, and reported closed-display failures there when power changed.
No Apple source documents a behaviour difference for supported closed-display mode.

### Supported configurations

| Configuration | Scheduled work keeps running? | Notes |
| --- | --- | --- |
| Desktop Mac (Mac mini, Mac Studio, Mac Pro, iMac) | Yes | Display sleep does not matter |
| Laptop, lid open, on power | Yes | |
| Laptop, lid open, on battery | Yes, until the battery floor or macOS's own low-battery sleep | Choose "Only when connected to power" to avoid battery use |
| Laptop, lid open, screen locked or display asleep | Yes, for API and CLI harnesses | Harnesses that drive an app's interface need the screen unlocked |
| Laptop, lid closed, with power, an external display and an external keyboard or mouse | Yes | Apple's supported closed-display mode; a display that powers the Mac counts as power on Apple silicon |
| Laptop, lid closed, without an external display | No | Forced sleep; missed schedules catch up after waking |
| Laptop, lid closed, on battery only | No | Not a supported closed-display configuration |
| Sleep chosen from the Apple menu, the power button, or a critically low battery | No | Forced sleep; the app shows that macOS slept anyway |

## 5. Screen locked and display asleep

Locking the screen does not suspend processes, and neither does display sleep.
An Apple DTS engineer [describes system sleep](https://developer.apple.com/forums/thread/795461) as the point where "the CPU gets suspended and thus stops running any code, including app code".
So work continues exactly while the system is awake, which is what the assertion guarantees.
Loopback TCP to `127.0.0.1` does not depend on the display or on the login window.
This was not reproduced with a real screen lock in the spike, because locking the owner's screen would have interrupted them.

| Harness | Works with the screen locked or display asleep? | Why |
| --- | --- | --- |
| T3 Code over its local HTTP API (this app today) | Expected yes | The T3 Code server and its agent processes keep running; delivery is a loopback HTTP POST |
| Claude Code CLI, Codex CLI, Aider | Expected yes | Terminal processes that call provider APIs over the network |
| OpenCode | Expected yes | Its server and CLI are background processes |
| Ollama | Expected yes | A local server; inference does not need the display |
| Desktop-app harnesses driven through the interface, and the legacy Accessibility helper | No | Synthetic input cannot reach a locked session; the helper's own README requires an unlocked screen |

T3 Code 0.0.40 does not hold a power assertion of its own while an agent runs; its bundled main process never calls `powerSaveBlocker` or `caffeinate`.
Without keep-awake, idle sleep can therefore interrupt a running T3 agent turn.

### App Nap and timer throttling

Apple's [App Nap guide](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/AppNap.html) says an app is only eligible when "It hasn't taken any IOKit power management or NSProcessInfo assertions", and that napping throttles timers and I/O.
Holding the assertion therefore makes the main process ineligible for App Nap for the whole session.
`node-schedule` uses Node timers, which measure elapsed time on a clock that stops during system sleep.
A timer due during sleep fires late by the time the Mac slept.
The job service already handles this on `powerMonitor` `resume` by running every pending job whose time has passed, and it records the lateness.
Keep-awake makes that catch-up the exception rather than the rule.

## 6. Lifecycle design

### Tracked tasks

Keep-awake depends on a small work-source interface in [`lib/keep-awake.js`](../lib/keep-awake.js) rather than on the job service.
A source has an `id`, a `label`, a synchronous `tasks()`, and optional `refresh()` and `subscribe()` hooks.
A task is `{ id, harness, label, state, detail, until, conversation, supplementary, requiresUnlockedScreen }`, with `state` of `waiting`, `running` or `unknown`.
Harness adapters for [#2](https://github.com/VelvetAcorn/agent-auto-continue/issues/2), continuation chains for [#3](https://github.com/VelvetAcorn/agent-auto-continue/issues/3), and remote control for [#4](https://github.com/VelvetAcorn/agent-auto-continue/issues/4) register sources without changing the controller.

The first source, [`lib/t3-work-source.js`](../lib/t3-work-source.js), maps the current job model as follows.

| Job | Task state | Ends when |
| --- | --- | --- |
| `pending` | `waiting` until its effective send time | It dispatches, is edited, or is canceled |
| `dispatching` | `running` | The dispatch settles |
| `sent` with a recorded dispatch | `running` while the thread's T3 session is `starting` or `running`, or has an `activeTurnId` | The session is seen idle after a 3-minute start grace |
| `unconfirmed` or `failed` with `deliveryCertainty: 'unknown'` | As for `sent`; it is never resent | As for `sent` |
| `failed` before dispatch, `canceled` | Not tracked | |

T3 Code 0.0.40 exposes `session: { status, activeTurnId }` on every thread in `/api/orchestration/snapshot`.
`status` is one of `idle`, `starting`, `running`, `ready`, `interrupted`, `stopped` and `error`.
The source polls the snapshot once a minute, and only while a delivery or agent turn needs watching.
An optional setting also tracks every running T3 Code agent turn, even without a schedule.
Those tasks are supplementary and are dropped only when a job retained after deferral filtering already covers the same thread.

[`lib/active-work-source.js`](../lib/active-work-source.js) adapts the harness-neutral `service.activeWork()` view from #2 and the continuations of #3.
`main.js` registers it first and the T3 Code source second.

| `activeWork()` phase | Task state | Ends when |
| --- | --- | --- |
| `scheduled` | `waiting` until its effective send time | It dispatches, is edited, canceled or stopped |
| `waiting` (a continuation or auto-start held back by a usage limit, a busy agent or a locked screen) | `waiting` until its next check; the detail names the cause and the turn progress | It sends, or the chain is paused or stopped |
| `sending` | `running` | The dispatch settles |
| `running` | `running` while the job service tracks the agent turn, for any harness that reports completion | The harness reports the turn finished, or after the 24-hour tracking limit |

`activeWork()` covers every harness, every active chain including the gap between turns, and excludes paused chains, which wait for the user.
Both sources use `job:<id>` task IDs, and the registry keeps the first report of each ID, so a T3 Code job is reported once, by the chain-aware source.
The T3 Code source still adds what the job service cannot follow: deliveries whose outcome is unconfirmed, legacy records without turn tracking, and the optional supplementary agent turns.
It skips pending turns of paused chains and sent jobs whose turn the job service already saw finish, so neither source keeps the Mac awake for them.
`requiresUnlockedScreen` from a desktop-app harness makes the controller hold the display assertion and warn the user.

Remote control reports the controller's status read-only in `GET /v1/status` and the MCP `get_status` tool, through `remoteStatus()` in `lib/keep-awake.js`, without the settings or source errors.

### State machine

| State | Assertion | Meaning |
| --- | --- | --- |
| `off` | None | Disabled, or nothing to track |
| `armed` | Held | All tracked work is waiting for its time or for availability |
| `active` | Held | At least one task is running or has unknown completion |
| `releasing` | Held | Tracked work just finished; a 2-minute grace avoids gaps between delivery and the agent turn starting |
| `paused` | None | On battery in "Only when connected to power" mode; resumes on power |
| `ended` | None | Ended early for the current work by the user, the battery floor, or the time limit |

```text
off --work appears--> armed/active
armed <--> active (task states change; same assertion)
armed/active --no work--> releasing --grace expires--> off
releasing --work appears--> armed/active (same assertion)
armed/active/releasing --Let Mac sleep--> ended (release now)
armed/active --time limit--> ended --new work, deferred work that is due, or "Keep awake again"--> armed/active
armed/active --battery at floor--> ended --power connected--> armed/active
armed/active --on battery, AC-only--> paused --power connected--> armed/active
any --disabled, app quit--> off (release now)
```

The controller holds at most one blocker.
When the type changes, it starts the new blocker before stopping the old one, so there is no gap.
It re-acquires a blocker that `isStarted()` reports as lost.
It evaluates on every source change, power-source change and wake, and on a one-minute tick while enabled.

### Explicit cases

- **Completion unknown or unconfirmed delivery.**
  Unconfirmed deliveries are watched like sent ones, because the agent may be working, but they are never resent.
  If T3 Code stops answering, completion becomes `unknown` for 30 minutes from when the agent was last seen working, then the task ends.
  Only an idle reading taken after the 3-minute start grace closes a delivery's watch.
  While T3 Code is answering but has not yet been polled after the grace, the delivery stays `running` until the next poll.
  The time limit bounds everything else.
- **Agent disconnects.**
  The same 30-minute unknown window applies.
  An archived or missing thread ends its task.
- **App quits or crashes.**
  `will-quit` disposes the controller, which releases the assertion.
  macOS releases it on a crash or `SIGKILL`, which the E2E test verifies.
  On the next launch the session is recomputed from persisted jobs; no session state is persisted.
- **macOS sleeps anyway.**
  `suspend` and `resume` are recorded, and the notice reports "macOS slept anyway" for the current session.
  On wake the job service catches up missed schedules, and the controller refreshes sources and re-evaluates.
- **User stops.**
  "Let Mac sleep" releases immediately and ends the session for the current tasks, including deferred work and running threads hidden behind a job.
  A task changing state is not new work, and neither is the agent turn that a stopped job starts on its thread; a task that was not known at the stop starts a new session.
  "Keep awake again" re-arms.
- **Battery floor.**
  On battery at or below the floor, the session ends with a notification and stays ended until power is connected.
  A floor of 0 leaves low-battery handling to macOS, and an unreadable level never ends a session.
- **Time limit.**
  Each session ends after the configured hours, from 1 to 72, with a notification.
  Waiting work that starts after the active session deadline is deferred.
  When the limit ends a session, the tasks it covered stay excluded from later sessions until they finish, or until a task that was still waiting starts, so a stuck task cannot chain sessions.
  Deferred work counts as new only once it is due, so it then starts its own session without the capped tasks.
  Without a session, eligibility uses the configured duration from now.

### UI

The UI stays within the existing Paper / Focus style until the new direction from [#6](https://github.com/VelvetAcorn/agent-auto-continue/issues/6) is approved.

- **Settings:** a "Keep awake" card with the opt-in, "Keep the display on too", "Also stay awake while any T3 Code agent turn runs", battery behaviour, battery floor, time limit, a live status line, and a disclosure explaining lids, locking and forced sleep.
- **Status notice:** shown above every view while a session is armed, active, releasing, paused or ended.
  It states why the Mac is awake, the latest stop time, and a disclosure listing each task with its detail and start or expiry time.
  It offers "Let Mac sleep" or "Keep awake again", warns when a task needs the screen unlocked, and reports when macOS slept anyway.
- **Menu bar:** a dot on the tray icon and a tooltip while an assertion is held, plus a status line and a "Let Mac sleep now" or "Keep Mac awake again" item in the menu.

## 7. Open questions for the owner

1. **Battery default.**
   Should keep-awake run on battery by default?
   Recommendation: yes, with a 20% floor, because unattended overnight runs on a charged laptop are the main use case and the floor prevents a flat battery; "Only when connected to power" stays one click away.
2. **Time limit default.**
   Recommendation: 12 hours, which covers an overnight usage-limit reset plus a long agent turn.
3. **Track all running T3 Code turns by default?**
   Recommendation: no, until #3 defines continuation chains; the setting exists but is off.
4. **Should an explicit stop survive a restart?**
   Recommendation: no; a restart re-evaluates from persisted jobs, which is predictable and avoids stale suppression.
5. **Should the app schedule a wake from sleep?**
   `pmset schedule wake` needs root.
   Recommendation: no; document catch-up on wake instead.
6. **Should closed-display mode without an external display be supported through a privileged helper?**
   Recommendation: no, because of the root requirement, the persistent system change and the heat risk; keep the supported-configurations table.
7. **Should the app notify when macOS slept anyway?**
   Recommendation: show it in the status notice only, because a notification at wake time is noise when catch-up already ran.
8. **Should desktop-app harnesses keep the display on automatically?**
   Recommendation: yes, which is implemented, because display sleep usually locks the screen and blocks interface-driven delivery.

## Implementation

| Part | Location |
| --- | --- |
| Settings, controller, state machine and work-source registry | [`lib/keep-awake.js`](../lib/keep-awake.js) |
| T3 Code work source | [`lib/t3-work-source.js`](../lib/t3-work-source.js) |
| Adapter for `service.activeWork()` from #2 | [`lib/active-work-source.js`](../lib/active-work-source.js) |
| Electron power adapter, power events, IPC and tray | [`main.js`](../main.js) and [`preload.js`](../preload.js) |
| Settings card and status notice | [`renderer/app.js`](../renderer/app.js) and [`styles.css`](../styles.css) |
| Unit tests with a fake clock, timers and power adapter | [`test/keep-awake.test.js`](../test/keep-awake.test.js), [`test/t3-work-source.test.js`](../test/t3-work-source.test.js), [`test/active-work-source.test.js`](../test/active-work-source.test.js) |
| IPC and tray tests | [`test/ipc.test.js`](../test/ipc.test.js) |
| Real Electron checks through `pmset -g assertions` | [`tools/electron-smoke.cjs`](../tools/electron-smoke.cjs) and [`tools/keep-awake-e2e.cjs`](../tools/keep-awake-e2e.cjs) |

The E2E driver runs the production main process under real Electron with keep-awake enabled and a pending schedule, and confirms that exactly one `NoIdleSleepAssertion` appears for that process.
It then confirms that nothing remains after a normal quit (released in `will-quit`), after `process.crash()`, and after `SIGKILL`.
The smoke test drives the real Settings card and status notice, and confirms `NoIdleSleepAssertion`, then `NoDisplaySleepAssertion`, then no assertion after "Let Mac sleep" and after turning keep-awake off.
