# agent-auto-continue: UI and UX direction for issues #2 to #6

Prepared 2026-09-30 as a design proposal.
It reads the shipped Paper / Focus renderer, the four prototypes in `design/mockups/`, and the five open issues.
Concept sketches sit beside this file; open `index.html` for the list.
Nothing here is implemented, and nothing in the repository was changed.

## 1. The concept in one paragraph

Today the app is a message scheduler with one destination.
After issues #2 to #5 it becomes something else: a helper that keeps agent work moving while you are away, across several agents, with the Mac kept awake for as long as that takes, and a phone in your pocket that can nudge it.
The proposal is to name that clearly.
The unit of work becomes a **handoff** (a thread, a message, when to start, how far to go).
The home screen becomes a **board** grouped by what you need to do, not by which agent is involved.
Keep-awake becomes a **shift** that you start and end, with an honest morning report when it is over.
Agents are connections with capabilities that you manage once, not places you navigate to every day.
The visual language stays exactly Paper / Focus: bold chrome, quiet data, one memorable element per screen.

## 2. Mental model and naming

### Fork A: "Handoffs and a shift" (recommended)

The user hands a thread to the app and, optionally, puts the Mac on a shift.
The words are ordinary, they scale to any number of agents, and they match what people actually say ("I handed it off overnight", "the Mac was up all night").
"Shift" gives keep-awake a beginning, an end, and a report, which is exactly the Amphetamine session model the issue asks for.
Turn limits and continuous mode become "how far" a handoff goes, which reads naturally in a sentence.

### Fork B: "Queue and keep awake toggle"

Keep the current vocabulary (schedule, message, queue) and add a Keep awake switch in Settings plus an Auto-start checkbox in the composer.
This is the smallest change and the least risky to document.
It also turns into a control panel quickly: five checkboxes, three modes, and a switch that does not explain why the Mac is awake.
It does not give the user a name for "everything that is happening tonight", which is the thing they most want to glance at.

Recommendation: A.
Keep "schedule" out of the interface entirely except as a verb inside the composer ("At a time").

### Vocabulary

| Old word | New word | Why |
| --- | --- | --- |
| Schedule, scheduled message, job | Handoff | One noun for the whole thing, including auto-start and continuous mode. |
| Upcoming | Board | The home is no longer only a list of future times. |
| Threads | Agents (and the thread picker) | Threads belong to an agent; the picker is the everyday path. |
| Send | Hand off (primary button), Continue (the message) | The button says what the app does; the message stays literal. |
| Keep awake | Shift | A session with a start, an end, and a reason. |
| Sent to T3 Code | Delivered | Delivery is one event; "Done" is reserved for agent-reported completion. |
| Pending, Dispatching | Waiting, Running | Plain words, and "Running" now covers multi-turn work. |

The heading on the board is contextual and human: "Tonight" after 18:00, "Today" otherwise, "Nothing waiting" when empty.
The app name can stay Agent Auto-Continue; the vocabulary inside it is what changes.

## 3. Information architecture and navigation

### Fork A: one board with agent badges (recommended)

Four navigation items: Board, History, Agents, Settings.
Every handoff row carries a small agent monogram and project, and the board is grouped by state: Needs you, Running, Waiting, Done tonight.
Agents are a facet (filter chips appear only when more than one agent has handoffs) and a management page.
Adding a sixth agent changes nothing in the navigation.

### Fork B: a tab or sidebar per agent

Each harness gets its own queue and its own threads page.
This mirrors how the integrations are built and makes capabilities easy to explain in place.
It also means the user has to visit five places to answer "is anything stuck", and the tray can no longer summarise one queue.
It grows a sidebar, which the accepted Paper / Focus decision deliberately avoided.

Recommendation: A.
The board is the product; agents are plumbing.

### Where things live

- Board: shift card (when relevant), Needs you, Running, Waiting, Done tonight, and the New handoff button.
- History: the existing delivery log, renamed labels, with per-turn records nested under each handoff.
- Agents: connection list with availability and source, an expandable capability table per agent, and that agent's threads.
- Settings: Shift, Phone, Appearance, Support.
Connection details for each agent move out of Settings and into the Agents page so Settings stops growing with every integration.
- New handoff: an internal page, as today, reached from the board, the tray, and the phone.
- Handoff detail: an internal page with the plan sentence, the turn log, and the actions for its current state.

### The status strip

The top bar keeps the navigation on the left and replaces the single "T3 Code connected" text with a compact strip on the right.
The strip holds: agent monograms with a small availability dot each, a moon with "On shift" when a shift is running, a phone glyph when a paired phone has been seen in the last few minutes, and the theme toggle.
Hovering or focusing a monogram reveals the full availability sentence.
When only one agent is configured, the strip collapses to today's single connection label.

## 4. Feature by feature

### 4.1 Several agents (#2)

Agents page rows show: monogram, name, availability with its source and age, a one-line transport summary, current counts, and the two capabilities that matter most day to day (runs with screen locked, reports completion).
Availability has exactly five states: Free, Limited (with reset time), Unknown, Not running, Stale.
Every state names its source in small text, for example "read from Claude Code, 2 min ago".
Unknown is a first-class state with its own dashed dot, never an empty space.
Stale keeps the last known value at reduced opacity with "last checked 40 min ago".

Expanding an agent shows a capability table with three columns: capability, status, and what it means for handoffs.
The table is the honest place to say "Claude desktop needs the screen unlocked" or "OpenCode completion is inferred from an idle session".
Below the table sits that agent's thread list, which is where the current Threads view goes.

Monograms are two-letter badges in a 2px outline with a small hard shadow: T3, CC, OC, CX, AI for Aider, CL for Claude desktop, GP for ChatGPT desktop.
Desktop apps get a round badge and CLI or API harnesses get a rounded square, so "needs a window" is legible without reading.
No vendor logos; they clash with the paper language and create licensing questions.

Add an agent is a short flow: choose the harness, follow the connection instructions for that harness, and see a live capability check before saving.
Failure copy names the fix: "OpenCode's server is not answering on port 4096. Start it with `opencode serve` and try again."

In the composer picker, threads are grouped by agent, most recent first, with the same availability dot per group.
Agents that cannot continue a thread right now are still listed but greyed with a reason line, never hidden.

### 4.2 Auto-start, turn limits, continuous mode (#3)

The composer asks three questions in order: which thread, when, and how far.
Everything else sits behind a disclosure.

"When" is a segmented control with three options.
"When the agent is free" is the default whenever the chosen agent is currently limited.
It shows the detected reset time, its source, and a Check again button inline, so a stale reading is visible before you commit.
"At a time" keeps the current ISO date, 24-hour time, timezone, calendar and quick chips, and adds an "After the next reset" chip that copies the detected time into the fields.
"Right away" exists so you can hand a running thread to the shift before you leave.

"How far" is a second segmented control: "Up to" with a stepper defaulting to 1, or "Until done".
The stepper accepts any whole number typed directly; 0 is allowed and means never send, and negative values are rejected inline.
"Until done" always adds a no-progress guard, shown as a checked rule, so continuous mode cannot loop forever.

"Stop and ask me if" is a disclosure with the safety rules.
The first three (asks a question, requests permission, delivery cannot be confirmed) are always on and shown checked and disabled, because they are the reasons the app never blindly resends.
Optional rules: no visible progress for N turns, a turn longer than N minutes, and someone else touching the thread.

The plan card is the one bold element on this screen.
It restates the whole handoff as a sentence in Fraunces, with the time and thread title in the accent colour: "When Claude Code is free, around 03:00, send "Continue" to Write release notes for 2.1 and keep going until Claude Code says it is done. Stop and wait for you if it asks anything."
Below it, two bullets say whether the shift is needed and whether the screen can lock, and state the counting rule: a turn counts only after delivery is confirmed.
The button says "Hand off".

On the board, a running handoff shows a turn tally (four small squares plus "3 of 4", or "turn 7, until done") and the sentence that explains what stops it.
A waiting handoff says "Starts when Claude Code is free, 1 turn" and "In about 3 hours".
Editing after the first turn is limited to how far and the stop rules; the thread and message are fixed once a turn has been sent.

### 4.3 Keep awake as a shift (#5)

#### Fork A: a shift session (recommended)

The shift is one object with a start, an end, and settings.
It appears as a single card at the top of the board in four states: a nudge when handoffs would miss their start if the Mac sleeps, a calm "Awake until everything is done" state, an attention state when something about power or the screen threatens a handoff, and a morning report once it ends.
The card always says why the Mac is awake, which handoffs still need it, and the estimated end time.
The tray shows a moon while a shift runs.

#### Fork B: a per-handoff keep-awake flag

Each handoff has a "keep the Mac awake for this" checkbox and the app holds the assertion while any flagged handoff is pending.
It is simpler to store but it hides the cumulative effect, and the user gets no place to end it all or see why the Mac is still awake at 04:00.

Recommendation: A, with an "Start a shift automatically when a handoff needs it" setting that defaults off.

Settings for the shift are three short cards.
"What a shift keeps awake": System is always on; Display is "Only when an agent needs it" by default, driven by the capability table; Lid is a warning, because macOS decides that and the app can only tell the truth about it.
"When to give up": battery floor (default 20%), idle timeout, and the automatic start option.
The rules on the card ("Screen may lock", "Battery: ends at 20%", "Lid must stay open") are the same words as the settings so the user can trace each one.

The morning report appears once, on the first open after a shift ends, and then lives in History.
It says when the shift ended, how long the Mac was awake, battery from and to, how many handoffs finished and how many turns ran, and what needs you now.
Its primary button is "See what needs you".

If macOS sleeps anyway, the board and the notification say so plainly: "The Mac slept anyway. Write release notes started at 07:12, 4 h 12 m late."

### 4.4 Phone (#4)

Pairing lives in Settings under Phone.
It shows a QR code and the same secret as four words for typing, a five-minute expiry, and a note that a code pairs exactly one device.
Paired devices are listed with what they can do and when they were last used, each with Remove.
The scope statement is written out: a paired phone can view the board and pause, resume, end or create handoffs; it cannot read agent tokens, change agent settings or pair other devices.

#### Fork A: MCP connector only

Expose the board as an MCP server and let the user's mobile Claude or ChatGPT client drive it in conversation.
Least UI to build, and it fits the audience.
It leaves the user without a glanceable board on the phone, and it makes every status question a round trip through a chat.

#### Fork B: a small web board plus the MCP connector (recommended)

Build the API once, serve a trimmed board as a mobile web page on the same network, and offer the MCP connector on top.
The web board reuses the desktop board's sections and copy at phone width, so nothing new has to be learned.
Recommendation: B, with "Same network" on by default and an end-to-end encrypted relay as an explicit opt-in.

On the phone, a reachability line sits under the heading: "Mac reachable, seen 12 s ago".
Every action shows an acceptance receipt from the Mac: "Mac accepted Resume at 23:58".
Each tap carries a request id, so a retried tap never creates two handoffs; the Mac is the single source of truth.
When the Mac is unreachable, the phone shows the last known board greyed with "Last seen 02:14" and every action becomes "Queue for when the Mac is back", clearly marked as possibly stale.

### 4.5 Quality of life on the existing UI (#6)

- Rename Upcoming to Board and make the count the number of handoffs that need you, not the total.
- Drop the all-caps overline on every row; show agent and project as normal-case small text, and keep the uppercase style only for the list head where it labels a structure.
- Replace "Sent to T3 Code" with "Delivered" everywhere and reserve "Done" for reported completion; keep the help line that explains the difference.
- Turn the thread picker into a grouped, full-height page with the agent monogram and availability, and remember the last used agent.
- Move the connection notice into the status strip and the Agents page so the board is not pushed down by a banner while the agent is merely limited.
- Show the timezone once at the top of the board ("Times in Europe/London, BST") rather than on every row, and keep the exact instant on hover and in detail.
- Add keyboard shortcuts: Cmd+N new handoff, Cmd+O open board, Cmd+1 to Cmd+4 for navigation, Esc for back.
- Reduce the tray thread submenu to at most eight recent threads across agents.
- Keep the star in Settings and make the support card the only place with continuous motion.

## 5. Status at a glance

### Handoff states

| State | Label on the board | Colour | Tray glyph |
| --- | --- | --- | --- |
| Waiting for a time | "2026-10-01, 06:30 BST" pill | accent | small clock |
| Waiting for the agent | "Limited, resets 03:00 (from Claude Code)" | amber dot | small clock |
| Waiting, availability unknown | "Waiting, availability unknown" | dashed dot | small clock |
| Running | turn tally "3 of 4" or "turn 7, until done" | accent bar on the row | small play triangle |
| Paused, needs you | "Paused after turn 2 of 5" and the reason | amber bar on the row | tinted dot on the icon |
| Delivered, awaiting result | "Delivered, waiting for the agent" | accent | small play triangle |
| Done | "Done, 4 turns" | green | none |
| Ended by you | "Ended after turn 2" | muted | none |
| Failed | "Failed" and the reason | red | tinted dot on the icon |
| Delivery unconfirmed | "Delivery unconfirmed" | amber | tinted dot on the icon |

Colour never carries meaning alone; every state has words, and the two row bars (accent for running, amber for needs you) are reinforced by section headings.

### Availability pill

A dot plus text, always with a source and age in smaller text.
Free is green, Limited is amber with the reset time, Not running is an empty ring in red, Unknown is a dashed dot, and Stale reduces opacity and says when it was last checked.
The same component appears in the strip (dot only, text on hover), the Agents page, the composer, waiting rows, and the phone.

### History

History gains a per-turn log under each handoff: turn number, delivered at, agent reported end of turn at, what stopped the handoff.
Filters become All, Done, Needs you, Ended, Failed, Unconfirmed.

## 6. Tray menu

The icon is a monochrome template image with a small overlay glyph for state: nothing for idle, a clock while waiting, a play triangle while a turn runs, a moon during a shift, and a dimmed icon when every agent is offline.
"Needs you" is the only tinted, non-template state, so colour in the menu bar always means "look at me".
An optional countdown title next to the icon is available but off by default.

Menu structure when something is happening:

1. A status header in Fraunces: "On shift, awake until done", with "2 running, 1 waiting, 1 needs you" beneath.
2. Up to six handoffs, needs-you first, each with a glyph, its title, and a second line for agent and turn state; each opens a submenu with Open in agent, Resume, Skip this turn, End handoff, Show on board.
3. New handoff (Cmd+N), Pause everything, End shift.
4. Open board (Cmd+O), Settings, Quit.

When nothing is waiting, the header says "Nothing waiting" with a one-line availability summary, and the list is replaced by a Recent threads submenu of at most eight items across agents.
Every verb matches the window: Resume, End handoff, End shift.
The word "schedule" does not appear in the tray.

Notifications use the same voice: "Claude Code needs you", "Handoff done", "Shift ended", "Started late", each with one sentence of reason.

## 7. Error recovery

The board's Needs you section is the recovery surface.
Each paused row states the reason in one sentence with the agent's own words quoted where available, and offers the one or two actions that fit.

| Reason | Row copy | Actions |
| --- | --- | --- |
| Agent asked a question | Claude Code asked a question: "..." | Open in Claude Code, Resume, End handoff |
| Agent requested permission | Claude Code is waiting for permission to run a command | Open in Claude Code, Resume, End handoff |
| Delivery unconfirmed | The last send could not be confirmed. No resend was attempted. | Check delivery, End handoff |
| Agent went offline | Codex desktop is not running. The handoff will wait. | Open Codex desktop, End handoff |
| Screen locked and the agent needs it | Claude desktop cannot run while the screen is locked | Keep display on instead, Skip that handoff |
| No progress | 3 turns passed with no visible progress | Resume with 1 more turn, End handoff |
| Missed start | The Mac slept anyway. Started 4 h 12 m late. | Acknowledge |
| Storage problem | Local storage needs attention (existing notice) | Open data folder |

Rules that stay from today: failed and unconfirmed sends never count as turns and never retry on their own; acknowledging never sends; reconciliation only reads.
The composer keeps field-level validation, the strip carries connectivity, and History keeps outcomes.

## 8. Delight, within the paper language

The rule is one deliberate moment per screen, never inside a working list, and always with a static version.

- The plan sentence in the composer is the delight moment of that screen: reading your own intent back in the display face.
- The shift card's night wash (a lavender paper tint) is the only tinted surface, so the eye finds it first.
- The morning report carries a slightly rotated "Done" stamp in green ink that lands once with a short press; with reduced motion it simply appears.
- The tray moon during a shift is a tiny, honest signal, not decoration.
- Empty board copy is an invitation: "Nothing waiting. Hand something off and go for a walk."
- The spinning star stays in Settings and nowhere else.

Not proposed: confetti, progress rings, animated agent avatars, or motion on list rows.

## 9. Accessibility and reduced motion

- All state is conveyed by text as well as colour, and row bars are paired with section headings.
- The board's section counts and the Needs you list are wrapped in a polite live region so a paused handoff is announced once, not on every poll.
- The segmented controls are radio groups with arrow-key movement; the stepper is a numeric input with labelled buttons.
- The plan sentence is the accessible description of the Hand off button, so a screen reader hears the whole plan before committing.
- The capability table is a real table with headers, not a grid of pills.
- The QR code has a text alternative (the four words) that is itself the pairing method.
- Reduced motion removes the star spin, the stamp press, and any panel transition; the existing motion-off class and media query cover the new components.
- Focus is restored after background refreshes exactly as the current renderer does; the new sections must not steal it when a handoff changes state.
- Tray menu items and notifications carry the same words as the window so switching between them is not a translation exercise.

## 10. Visual language notes

Keep everything already in `styles.css`.
Add the following tokens and components, and no more.

- `--night`: a lavender paper wash (`#E4DEEE` light, `#352F45` dark) used only for the shift card and the plan card.
- Agent monogram: 20px badge, 2px outline, 1.5px hard shadow, round for desktop apps.
- Availability pill: dot plus text plus small source text; five states.
- Segmented control and stepper: the existing 2px outline and hard shadow applied to a joined group.
- Row bars: a 4px left border in accent or amber for running and needs-you rows; no shadows on rows.
- Turn tally: small outlined squares, filled in accent as turns complete.
- Stamp: Fraunces 900, green ink, 3px border, slight rotation, one appearance.
- Section titles on the board use Fraunces at 17px with a small muted explanation on the right.

Do not add: vendor logos, a sidebar, gradients, a second accent colour, or all-caps eyebrow labels on content rows.

## 11. Copy examples

- Board heading: "Tonight", "Today", "Nothing waiting".
- Shift nudge: "Two handoffs will miss their start if the Mac sleeps. Start a shift to keep the Mac awake until they finish. Nothing else changes."
- Shift running: "Awake until everything is done. 2 handoffs still need the Mac. Display can sleep. Ends around 07:15 if all goes to plan."
- Shift attention: "Awake, but Claude desktop cannot run with the screen locked. The 06:30 handoff will pause unless the Mac is unlocked."
- Plan: "When Claude Code is free, around 03:00, send "Continue" to Write release notes for 2.1 and keep going until Claude Code says it is done. Stop and wait for you if it asks anything."
- Turn counting: "Counts a turn only after delivery is confirmed. Failed or unconfirmed sends never count and never repeat."
- Waiting row: "Starts when Claude Code is free, 1 turn" and "In about 3 hours".
- Needs you row: "Claude Code asked a question: "Should I keep the legacy endpoint alive for 30 days?"" then "Answer in Claude Code, then Resume".
- Done row: "Done, 4 turns" and "T3 Code reported the task complete".
- Morning report: "Good morning. The shift ended at 06:52. Awake for 7 h 10 m. Battery 100% to 74%."
- Phone receipt: "Mac accepted Resume at 23:58".
- Phone unreachable: "Last seen 02:14. Actions will queue for when the Mac is back and may be stale."
- Help line under the board: "Done means the agent reported the task complete. Delivered would only mean a message was accepted."

## 12. Risks and open questions

- Availability sources differ in trust; the UI must always show the source, and "Unknown" must be common enough that users trust it rather than a guessed time.
- Completion detection is uncertain for most harnesses; "Until done" should ship with the no-progress guard mandatory and a conservative default of three turns.
- Desktop-app harnesses that require an unlocked screen create a real security trade-off; the shift attention state should make the user choose rather than defaulting to display on.
- Lid-closed operation depends on power and an external display; promise a warning, not support.
- The relay for phone control introduces a hosted component; keep it opt-in and keep same-network as the default so the local-only promise in the README still holds.
- Renaming Upcoming, jobs and Sent changes persisted labels and documentation; the data model can keep its field names while the presentation layer changes words.
- The board's four sections can feel empty for a single-agent user with one handoff; collapse empty sections and show only the ones with content.
- The plan sentence must be generated from the same data the scheduler uses, or it will drift from what actually happens.

## 13. Suggested order of work

1. Vocabulary and board sections with the existing single agent, so the new shape is proven before new integrations arrive.
2. The composer's three questions and the plan sentence, including turn limits and stop rules.
3. The shift card and settings, because keep-awake is the most requested night-time behaviour.
4. Agents page and the second harness.
5. The phone API, then the web board, then the MCP connector.
