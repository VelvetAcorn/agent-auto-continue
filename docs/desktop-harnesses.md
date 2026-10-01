# Desktop app harnesses

This document records how Agent Auto-Continue drives agent conversations that live inside macOS desktop apps.
It covers what was investigated, the mechanism chosen for each app, the safety design and the known limits.
The adapter contract itself is in [harnesses.md](harnesses.md).

## Summary

| App | Harness | Status |
| --- | --- | --- |
| Claude Desktop, Code sessions | `claude-desktop` | Implemented; live send verification pending the owner |
| ChatGPT desktop app, Codex threads | `codex-desktop` | Implemented; live send verification pending the owner |
| Claude Desktop, chat conversations | none | Not supported; see [blockers](#not-supported) |
| ChatGPT desktop app, ChatGPT chats | none | Not supported; see [blockers](#not-supported) |

Both harnesses send through the app's own user interface, because each app runs its agent in-process and a second writer would fork or corrupt the conversation.
Everything else, including discovery, activity, delivery evidence, completion and usage limits, is read from files or protocols the apps already maintain.

## Requirements for the user

- The app must be running; the harness never launches it.
- The Mac must be unlocked, with this user on the console.
- Keep-awake cannot help with a locked screen: desktop-app schedules need the Mac left unlocked, and the display may sleep only if sleeping does not lock it.
- Agent Auto-Continue needs Accessibility permission in System Settings > Privacy & Security > Accessibility.
- A missing permission fails with error code `permission_required`, whose `details.settingsUrl` opens that pane; the dashboard shows an Open System Settings button for it.
- The app never shows the system permission prompt by itself, so an unattended schedule never pops a dialog.
- macOS attributes the permission to the app that starts the automation, so the packaged app needs the grant; during development with `npm start`, the terminal running Electron needs it instead.
- No Automation (Apple Events) permission is needed, because the harnesses call the Accessibility API directly and never script System Events or the target apps.

## Safety design

The shared engine is `lib/desktop/ui-delivery.js`, and every send follows the same sequence.

1. Check that the app is installed and running, Accessibility is granted, and the screen is unlocked; any failure is a certain non-delivery.
2. If the app is not already showing the conversation, open it with the app's own deep link and wait until the content area proves it is the right one; the link is opened only when Launch Services would hand it to the app itself.
3. Refuse while the agent is busy or waiting for input, and refuse if the message box already contains text, so a user's draft is never touched.
4. Set the message text through the Accessibility value of the verified message box and read it back.
5. Press the verified send button with an Accessibility press action.
6. Wait for the app's own persisted record of the new message.
7. If the harness opened the deep link and the target app took the front, bring back the app that was in front before.

No synthetic keystrokes or clipboard pastes are used anywhere, so input cannot land in whichever window happens to have focus.
Every write re-locates the conversation, the message box and the send button in the same Accessibility pass, and aborts if any of them does not match.
The send and stop buttons are searched for only in the message box's own containers, nearest first and never above the verified content area, so a same-named button elsewhere in the window is never pressed.
If the send button is not inside the content area, nothing is sent.
Deliveries run one at a time across all desktop harnesses, because they share the screen and focus.
Text inserted by the harness is removed again when it stops before pressing send, and only when the box still holds exactly that text.
Once a press has been attempted the message box is never touched again.

Failures before the press are certain non-deliveries.
When the conversation is shown but its message box never appears, or the box accepts the text but no send button is found near it, the app has changed, and the failure is `app_version_unsupported`; see [Surviving app updates](#surviving-app-updates).
A running or waiting agent is ruled out first, because it may replace the message box with its own controls.
After the press, a missing confirmation is reported with `deliveryUncertain: true`, so the job becomes unconfirmed and is never retried automatically.
Unconfirmed jobs are reconciled from the same evidence the send waits for.

The automation layer is `lib/desktop/mac-automation.js`.
Each call runs one short-lived `/usr/bin/osascript -l JavaScript` process with the self-contained program in `lib/desktop/jxa-program.js`.
The request, including the message text, travels on standard input as a JSON literal, so no shell is involved and the text is never part of a command line.
The program uses `AXUIElement` functions through the JavaScript for Automation Objective-C bridge, with a three-second Accessibility messaging timeout and node and depth budgets on every tree walk.
Electron and Chromium apps build their web accessibility tree on request, so the program sets `AXManualAccessibility` on the target app first.
Locked-screen detection is `lib/harnesses/session-lock.js`, which reads the IORegistry console sessions with `/usr/sbin/ioreg` and needs no permission.
While the screen is locked, both apps expose their application element as its own descendant and no content at all, so the automation program refuses every operation while locked.
`probeAvailability()` reports `{ state: 'unavailable', reason: 'screen_locked', source: 'reported' }` while locked.
The job service does not wait for an unlock: a schedule that fires while the screen is locked fails as not sent, with error code `screen_locked`, and nothing is typed.
Whether one-off schedules should instead be deferred until the next unlock is an open decision for the owner.

## Surviving app updates

T3 Code is driven through an API, but these harnesses depend on about a dozen undocumented details of each app, called contact points.
An app update can change any of them, so the design aims for three things: never do the wrong thing, notice the change before a schedule fires, and tell the user which app version changed what.

### App profiles

Every contact point of an app lives in one profile, `lib/desktop/profiles/claude-desktop.js` or `lib/desktop/profiles/codex-desktop.js`.
A profile holds the bundle ID, the app version it was verified with (`verifiedVersion`), the usual install locations, the files read inside the app bundle, the deep-link template and schemes, how the open conversation is recognised, the control labels with their message IDs, and the local files and ownership markers the harness reads.
The adapters, `claude-sessions.js`, `codex-reader.js` and `codex-locks.js` read from the profiles, so adapting to an update is usually one data change followed by re-verifying and bumping `verifiedVersion`.
`defineProfile()` validates a profile when it loads, so a typo fails at once rather than as a confusing delivery failure.

### Finding the app

The app is located by bundle ID through Launch Services, using the same Accessibility helper process, and the answer is reused for a minute.
Only when that is unavailable are the profile's candidate paths tried.
Claude Desktop's label catalogue and the ChatGPT app's bundled `codex` binary are read from inside the app found this way, wherever it is installed.
A required file missing from an app that was found is an app change (`app_version_unsupported` with contact point `app_path`), never "not installed".

### When a send meets a change

A change found while sending fails the job with `app_version_unsupported`, a certain non-delivery.
The job's note names the app, its installed version and what changed, for example "Claude Desktop 2.17.0 changed how its message box is labelled, so Agent Auto-Continue could not send. Nothing was sent."
The error details add the verified version, the contact point and a short technical hint.
When the deep link was opened but the conversation never appeared, the evidence is ambiguous, so the failure stays a `timeout`, but its message and details name the app version, the `deep_link` contact point and the possibility of an update.
A link scheme that no app handles is an app change; one that another app handles fails with `harness_not_configured`, and the link is not opened.

### Checking before schedules fire

Both harnesses implement `checkCompatibility()`, which never navigates, opens a link, types, presses or changes focus.
A quick check reads the installation, the version, the files the profile needs inside the app, and which app opens the profile's links.
A full check also reads the message box and send button of whichever conversation the app already shows, when Accessibility is granted, the app is running and the Mac is unlocked.
Labels are the same in every conversation, so any shown conversation proves them; Claude Desktop sessions are recognised by their URL and ChatGPT threads by a unique thread name.
When no conversation is shown, or its agent is working or waiting, the interface is reported as not checked rather than as a problem.
A missing message box counts as a problem only after a second look one second later.
The ChatGPT app may hide its send button while the message box is empty, so a missing send button there is only a problem when the box holds text.

The app runs the checks through `lib/compatibility-monitor.js`:

- ten seconds after launch, a quick check of each desktop harness, and a full one when that harness has scheduled work or its app version differs from the last version that passed;
- a full check whenever a schedule is created for the harness;
- every five minutes while the harness has scheduled work, a quick check, followed by a full one when the app version changed since the last full check, when the version has not passed yet and the last full check is 15 minutes old, or hourly;
- a full check right after a delivery failure that names a contact point.

A version passes when a full check saw its message box and found no problem, and the last passing version is kept per harness in `compatibility.json` in the app's data folder.
A problem stays until a later check proves that contact point works, a send to the harness succeeds, or the app version changes.
While a harness has a problem, its pending schedules are marked at risk in the list and the detail, but they are never canceled; if the problem remains when one is due, it fails without sending.
A newly found problem with scheduled work also raises a notification.

### Diagnostics

Problems from checks and deliveries, and failures that name a contact point, are written to `diagnostics.json` in the app's data folder.
The log keeps the newest 200 entries, and a check that keeps finding the same problem updates one entry's count instead of adding more.
Entries hold timestamps, the harness, the app and verified versions, the contact point, the error code, the job ID and a redacted hint, and never message text or conversation titles.
The dashboard shows a notice for each app in a drift state, with Copy diagnostics, which copies a plain-text report for a bug report, and Check again, which runs a full check.

### Extending the checks

Per-app probes of files and protocols slot into `checkCompatibility()` as `probes` of `checkDesktopCompatibility()`; see [Compatibility checks](harnesses.md#compatibility-checks).
Readers that find an unknown format should throw `appVersionUnsupported({ ..., during: 'read' })` with the matching contact point, so the failure is worded, logged and shown like the rest.

## Claude Desktop (`claude-desktop`)

Investigated with Claude Desktop 2.16120.0 (bundle `com.anthropic.claudefordesktop`, Electron) on 2026-10-01.

Claude Desktop has no AppleScript dictionary, but it registers the `claude` URL scheme.
Its URL handler opens a local Code session with `claude://code/continue?session=local_<uuid>`, which the harness uses as the only navigation.
The handler brings Claude Desktop to the front, which is why the harness restores the previous front app afterwards.
The Code view's content area has the URL `https://claude.ai/epitaxy/local_<uuid>`, so the harness verifies the session by that path segment.
The message box is an `AXTextArea` described as `Prompt`, and the send button is an `AXButton` described as `Send`, which the app enables only when the box has text.
Setting the text area's `AXValue` updates the app's editor state, as shown by the send button changing from disabled to enabled, including while the app is in the background.
The value can be read back exactly and cleared again.
Setting `AXSelectedText` reported success but changed nothing, so it is not used.

Discovery and evidence come from local files, read through `lib/harnesses/claude-sessions.js`.

| Need | Source |
| --- | --- |
| Sessions, titles, folders, archive state | `~/Library/Application Support/Claude/claude-code-sessions/<account>/<org>/local_<uuid>.json` |
| User activity and delivery evidence | The session's Claude Code transcript, `~/.claude/projects/<encoded cwd>/<cliSessionId>.jsonl` |
| Busy and waiting-for-input state | The live registry `~/.claude/sessions/<pid>.json`, status `busy`, `waiting` or `blocked` |
| Completion and usage-limit outcomes | Transcript records after the delivered prompt |
| Usage limits before sending | `plan-usage-history.json` samples under 20 minutes old, as inferred state without a reset time |

Busy and waiting-for-input state come only from the registry status, and an unknown status never blocks.
The job service refuses a busy session with `conversation_busy` and a waiting one with `awaiting_input`, and the harness checks the registry again right before typing and before pressing send.

Delivery is confirmed when the transcript gains a typed prompt with exactly the scheduled text, written no earlier than five seconds before the send attempt.
The text match is the evidence because the app assigns the prompt's own ID; the same text typed by hand in the same session at the same moment would also match.
The job service cancels a schedule when new user activity appears before it runs, which keeps that window small.
A session open in a Claude Code process other than Claude Desktop, such as `claude --resume` in a terminal, is refused, because Claude Desktop would become a second writer.
A live process that does not report its entrypoint counts as another process too.
The Claude Code harness in turn hides and refuses every session Claude Desktop owns.
A session whose working folder no longer exists is canceled, because Claude Desktop cannot continue it either.

The labels are localised by reading Claude Desktop's own message catalogue, `Contents/Resources/ion-dist/i18n/<locale>.json` inside the app wherever it is installed, for the language of the content area.
The message IDs used are `iWKE8shLIt` (`Prompt`), `uxkiTeN6WU` (`Write your prompt to Claude`) and `9WRlF4R2gm` (`Send`), and English is always included as a fallback.

## ChatGPT desktop app, Codex threads (`codex-desktop`)

Investigated with the ChatGPT app 26.915.31945 (bundle `com.openai.codex`, also named Codex) on 2026-10-01.

The ChatGPT desktop app is now a merged ChatGPT and Codex app built on Chromium, and there is no separate Codex app on this Mac.
Its AppleScript dictionary is Chromium's standard suite of windows, tabs and bookmarks, and scripting it would need an extra Automation permission without giving thread access.
It registers the `codex` URL scheme, and its router opens a thread with `codex://threads/<threadId>`, which the harness uses as the only navigation.
The app runs a private `codex app-server` child and holds each open thread's writer lock (`~/.codex/thread-writer-locks/<threadId>.lock`), so no other process can safely write to those threads.
The shared app-server daemon does not load the app's threads, so sending through the daemon or a private server would create a second writer.

The content area's URL is `app://-/index.html` for every thread, so the harness verifies the open thread by the content area's title, which is the thread name.
Threads without a name, and threads whose name any other listed thread shares, archived or not and whatever created it, are refused rather than guessed.
The check pages through every thread, and refuses when the listing cannot be finished.
The message box is an `AXTextArea` described as `Do anything`, whose value includes the placeholder text while empty.
The send button is labelled `Send` or `Send message`, and a `Stop` button near the message box means a turn is running.
The app ships no readable message catalogue, so these labels are English only, and another interface language fails safely with `app_version_unsupported` before anything is typed.

Everything else uses the supported app-server protocol through `lib/harnesses/codex-reader.js`, with the codex binary bundled inside the app (`Contents/Resources/codex`, wherever the app is installed) so the protocol version matches.
Reads use a private server that never loads a thread for writing.

| Need | Protocol call |
| --- | --- |
| Discovery | `thread/list`, keeping threads the desktop app created |
| Busy state, user activity and delivery evidence | `thread/turns/list`, where an `inProgress` turn means busy |
| Completion | The turn's status from `thread/turns/list` |
| Usage limits with reset times | `account/rateLimits/read` |
| Writer ownership | The thread's writer lock holder, which must be the desktop app or nobody |

Delivery is confirmed when a turn that started no earlier than five seconds before the send attempt contains a user message with exactly the scheduled text.
A turn without a start time is never evidence, because it could be any earlier turn with the same text.
Threads with originator `Codex Desktop`, and older top-level threads with no originator and source `vscode`, belong to this harness, and the Codex harness refuses them.
A lock holder that cannot be determined counts as busy.

## Not supported

Claude Desktop chat conversations (the Claude mode, as opposed to Code sessions) are not supported.
Their conversations live in the cloud, and no local file lists their IDs.
The sidebar exposes titles only, as buttons without links, so a scheduled conversation could not be identified reliably.
The deep link `claude://claude.ai/chat/<uuid>` would open one, but there is no local evidence store to confirm delivery.

ChatGPT chats in the ChatGPT app are not supported for the same reasons.
They are cloud threads of kind `chatgpt` whose IDs come from the ChatGPT backend with the user's credentials, which this app must not use.
Their content area has no per-conversation URL, and there is no local record to confirm delivery.

Supporting either would mean identifying conversations by visible titles and confirming delivery by reading message text from the screen.
That would be too unreliable to send messages unattended, so it was left out rather than shipped in a flaky form.

## Testing

Unit tests use `tools/fake-desktop-automation.cjs`, an in-memory model of one app window, and fixture files, so no real interface is touched.
App updates are simulated by changing the fake app's version, labels, install path or link registration, and the tests check that compatibility checks never call a write or focus operation.
They cover the full job-service path, including unconfirmed sends, reconciliation, locked screens, busy agents and user drafts.

`tools/desktop-e2e-dry-run.cjs` is a manual, opt-in check against the real apps that can never type or send, because its driver throws on every write operation.
Run it with `AAC_DESKTOP_E2E=1 node tools/desktop-e2e-dry-run.cjs` from a terminal that has Accessibility permission, with the Mac unlocked.
It reports permission, lock state, discovered conversations, availability, and the message box and send button of whichever listed conversation each app shows.
Adding `--open claude-desktop <local_...>` or `--open codex-desktop <thread id>` also opens that conversation through its deep link and locates its controls; use a throwaway conversation.

Live evidence gathered on 2026-10-01, all read-only apart from inserting and clearing text in an unsent new Code session:

- The Accessibility tree dumps of both apps, the content-area URLs, and the message box and send button labels above.
- Setting and clearing the Claude Code message box through `AXValue`, in the foreground and in the background, with the send button tracking the text.
- The dry run discovered 16 Claude Desktop Code sessions and 11 ChatGPT Codex threads, matching both apps' sidebars.
- Locked-screen detection, and the collapsed Accessibility tree while locked.

Pressing send in a real app has not been exercised, because no message was sent to a real conversation.
The owner should confirm one send per app in a throwaway conversation before relying on these harnesses.

Known risk to check live: a draft that holds only attachments.
The message box counts as empty when its text is empty, and the Accessibility dumps gathered so far do not show how either app exposes attachment chips.
If a user has attached a file or image without typing, the harness could send its message with that attachment.
The owner should attach a file in a throwaway conversation without typing, run the dry run, and check whether the attachment is visible near the message box, so that such drafts can be refused.
