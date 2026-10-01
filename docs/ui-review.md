# UI review with Claude (issue #6)

Prepared 2026-10-01 for [issue #6](https://github.com/VelvetAcorn/agent-auto-continue/issues/6).
This is a review and a set of prototypes to agree a direction.
No product UI was changed by the review itself.
The direction chosen afterwards was the one-screen menu-bar rail sketched in `design/mockups/simple/`, which replaced the Upcoming, History, Threads and Settings views described below, so the findings here document the interface that was replaced.
The capture tool `tools/ui-review-capture.cjs` drove that earlier interface and was retired with it; `tools/electron-smoke.cjs` now captures the current screens when `T3_SMOKE_EVIDENCE_DIR` is set.
Two pre-existing tooling problems found along the way were fixed in separate commits (see [Tooling fixes](#tooling-fixes)).

## Contents

- [How the review was run](#how-the-review-was-run)
- [Top 10 findings](#top-10-findings)
- [Findings by area](#findings-by-area)
- [Contrast measurements](#contrast-measurements)
- [What already works well](#what-already-works-well)
- [Quick wins](#quick-wins)
- [Feature prototypes](#feature-prototypes)
- [Evaluation of the Fable design pass](#evaluation-of-the-fable-design-pass)
- [Decisions to approve](#decisions-to-approve)
- [Tooling fixes](#tooling-fixes)

## How the review was run

The real app was driven end to end.
`tools/ui-review-capture.cjs` (since retired) ran the production `main.js`, `preload.js` and renderer the same way as the existing smoke fixture.
It uses in-memory storage and a fake T3 Code API, so no real messages can be sent.
The fake API serves 11 realistic threads across 3 projects, 7 upcoming jobs and 69 history records.
Those cover long titles, an untitled thread, an unknown settlement state, a missing timestamp, three timezones, a 30-second buffer, a 45-minute catch-up and a legacy record.
A pending job entered the production dispatch path; the fake API held its request to capture Sending, then rejected it with HTTP 401 to capture the live failure toast.

Scenarios captured: populated, empty, first connection pending, missing token, unreadable storage, T3 Code returning HTML, and connection refused.
Views were captured in light and Bone Outline themes at 1180 px (the default window), 620 px (the real minimum window width), 420 px and 375 px.
The fixture lowers the window's 620 px minimum only to exercise the narrow CSS breakpoints.
Keyboard order was recorded with real Tab and arrow key events through the Chrome DevTools Protocol.
Accessibility trees were dumped for Upcoming, a detail, the composer, Threads and Settings.
Contrast was computed with the WCAG 2.2 formula from the tokens in `styles.css` and from sampled pixels.
Reduced motion was checked with emulated `prefers-reduced-motion: reduce`.

Regenerate the evidence with:

```sh
env -u ELECTRON_RUN_AS_NODE npx electron tools/ui-review-capture.cjs
for s in empty storage loading no-token; do env -u ELECTRON_RUN_AS_NODE UI_REVIEW_SCENARIO=$s npx electron tools/ui-review-capture.cjs; done
```

Screenshots are in [`docs/ui-review/screens/`](ui-review/screens/).
File names are `<step>-<state>-<theme>-<width>.png` for the populated tour and `<scenario>-<view>-<theme>-<width>.png` for other scenarios.
The harness writes accessibility trees, keyboard reports and capture indexes to `aac-ui-review-data` under the system temporary directory.
The committed screenshots are a selected set; regeneration also captures additional full-page and scenario views.
Committed copies were reduced to 256 colours to keep the repository small.
The amber or blue rings around page headings in many screenshots are real: see A3.

`styles.css` is a single line, so CSS references use `styles.css:1` plus the selector.
`renderer/app.js` references point at the line of the rendering function.

## Top 10 findings

1. **P0 S1** Offline status says "Offline · queue saved" while upcoming sends are about to fail.
2. **P0 E3** A storage error shows "Upcoming 0" and keeps New schedule enabled, so the queue looks empty and scheduling looks possible.
3. **P1 N4** The History attention count looks exactly like the Upcoming quantity, disappears at 420 px, and is announced as "History2".
4. **P1 S3** The connection status is hidden at 650 px and below, which includes the app's own 620 px minimum window width.
5. **P1 S7** While the first connection is pending, Threads and the thread picker say "No matching threads" and offer to show settled threads.
6. **P1 S2** A missing token is headlined "T3 Code is unavailable" and "Offline", although T3 Code may be running fine.
7. **P1 V1** Fraunces and Inter are not bundled and the CSP blocks web fonts, so production renders Georgia and San Francisco, not the approved Paper / Focus type; the packaged app also uses the default Electron icon.
8. **P1 F1** Form validation is split between native browser bubbles and one error line at the bottom of the form, far from the field.
9. **P1 H3** Detail and composer cards are centred 90 px to the right of their Back link and heading.
10. **P1 E1** The failure toast covers the primary action and offers View for the message already open.

## Findings by area

Priorities: **P0** can mislead someone into a wrong decision about whether work will happen.
**P1** is a real usability, accessibility or polish problem worth fixing soon.
**P2** is worth fixing when nearby.

### Navigation

#### N1 (P1) Back from Edit skips the detail it came from

- **What:** Detail, then Edit schedule, then Back returns to Upcoming, not to the detail.
- **Where:** `renderer/app.js:211` (`back` navigates to `state.returnView`), `renderer/app.js:220` (`edit` keeps `returnView` as the list).
- **Evidence:** reproduced while scripting the capture; the harness had to follow this path (`06-composer-edit-light-1180.png`).
- **Why:** abandoning an edit should return to where the user decided to edit; losing the detail forces a re-find in a long list.
- **Fix:** push a return target of `detail:<id>` when opening Edit, and label the button "Back to message".

#### N2 (P2) The thread picker highlights the Threads tab

- **What:** Choosing a thread from the composer shows "Threads" as the active tab with "Back to draft".
- **Where:** `renderer/app.js:212` (`pick` sets `state.view='threads'`), nav at `renderer/app.js:47`.
- **Evidence:** `19-composer-thread-picker-light-1180.png`.
- **Why:** the user is still inside the composer; the highlighted tab suggests they left it.
- **Fix:** keep the composer's tab active (or no tab) while picking.

#### N3 (P2) A detail's Back label goes stale when its job moves

- **What:** A detail opened from Upcoming keeps "Back to upcoming" after the job fails and moves to History.
- **Where:** `renderer/app.js:184`.
- **Evidence:** `30-toast-failure-light-1180.png`.
- **Why:** Back lands on a list that no longer contains the item.
- **Fix:** derive the Back target from the job's current status.

#### N4 (P1) The attention badge is indistinguishable from a count

- **What:** "History 2" (unacknowledged failures) uses the same 10 px muted grey as "Upcoming 7" (a quantity); both are hidden at 420 px and below.
- **Where:** `renderer/app.js:48`, `styles.css:1` `.nav-count` and the `max-width:420px` rule.
- **Evidence:** `08-history-light-1180.png`, `08-history-light-420.png`.
- **Why:** the only persistent signal that a delivery failed is easy to miss and vanishes at narrow widths.
- **Fix:** render attention as a filled amber badge with spoken text ("2 need attention"); keep it at every width; drop the "0" quantity.

#### N5 (P1) The History attention notice has no way to act

- **What:** "2 deliveries need a look" has no button, and the filters split Failed and Unconfirmed, which also include already acknowledged records.
- **Where:** `renderer/app.js:85`.
- **Evidence:** `08-history-light-1180.png`.
- **Why:** the user has to scan 69 rows to find the two that need them.
- **Fix:** add a Review button that applies a "Needs attention" filter.

### Hierarchy and density

#### H1 (P1) Rows are tall; four fit in the default window

- **What:** Each job row is about 140 px: uppercase project overline, pill, title, message preview and meta line with large gaps.
- **Where:** `renderer/app.js:87`, `styles.css:1` `.row`, `.row-top`, `.row-preview`.
- **Evidence:** `01-upcoming-light-1180.png` shows 4 of 7 jobs; the full History page with 69 records was about 15,000 px tall.
- **Why:** the queue is the home screen; its main question ("what happens next?") needs more than four answers per screen.
- **Fix:** a denser row: agent/project in normal case on the status line, title, one meta line; message preview only when it differs from "Continue".

#### H2 (P2) Detail pages have a generic heading

- **What:** The h1 is "Message details" and the thread title is an h2 in the card.
- **Where:** `renderer/app.js:69` (titles), `renderer/app.js:134`.
- **Evidence:** `10-detail-failed-light-1180.png`.
- **Why:** the page's real subject is the thread; screen reader users hear "Message details" on every detail.
- **Fix:** make the thread title the h1 with project and status above it.

#### H3 (P1) Cards are not aligned with their heading

- **What:** `.panel` is 620 px and centred inside the 850 px content column, while Back and the h1 are left-aligned; the card starts 90 px to the right.
- **Where:** `styles.css:1` `.panel{max-width:620px;margin:auto}`.
- **Evidence:** `04-detail-pending-light-1180.png`, `17-composer-new-light-1180.png`; at 620 px it aligns (`10-detail-failed-dark-620.png`).
- **Why:** it reads as a layout bug and breaks the strong left edge the rest of Paper / Focus relies on.
- **Fix:** constrain the whole view (Back, heading, card) to one column width, as in the prototypes.

#### H4 (P2) Thread state pills are noisy and inconsistent

- **What:** Every thread shows an "active" pill; thread states are lowercase while job states are sentence case; "active" uses the same accent as "Scheduled".
- **Where:** `renderer/app.js:95`.
- **Evidence:** `16-threads-show-settled-light-1180.png`.
- **Why:** the exception (settled, unknown) is what matters and it is drowned out.
- **Fix:** show a pill only for settled and unknown, in sentence case.

#### H5 (P1) Threads do not show existing schedules

- **What:** The thread list and picker give no hint that a thread already has a scheduled message.
- **Where:** `renderer/app.js:95`.
- **Evidence:** `15-threads-light-1180.png`, `19-composer-thread-picker-light-1180.png`.
- **Why:** it invites duplicate schedules on the same thread.
- **Fix:** add "1 scheduled" (or the next time) on the row.

#### H6 (P2) History times are unlabelled

- **What:** History rows show `updatedAt` without saying whether it is the send, failure or cancel time.
- **Where:** `renderer/app.js:87`.
- **Evidence:** `08-history-light-1180.png`.
- **Why:** Without an event label, readers cannot tell what the timestamp confirms.
- **Fix:** prefix with the event ("Sent 23:31", "Failed 23:31", "Canceled 22:10").

#### H7 (P2) Detail repeats near-identical timestamps

- **What:** Requested, Effective (with seconds) and Last updated are usually within seconds; catch-up delay shows "106 seconds".
- **Where:** `renderer/app.js:134`.
- **Evidence:** `10-detail-failed-light-1180.png`, `30-toast-failure-light-1180.png`.
- **Why:** Repeated timestamps obscure the requested send time and the size of a delay.
- **Fix:** show one "Sends at" line with the buffer as a hint, and humanise lateness ("1 min 46 s late").

### Forms

#### F1 (P1) Validation is split between native bubbles and a custom line

- **What:** `pattern`, `required` and `min`/`max` trigger native browser bubbles ("Please match the requested format.", "Value must be less than or equal to 65535.") before the app's own messages can run.
- **Where:** `renderer/app.js:102` (date/time `pattern`, `required`), `renderer/app.js:144` (port and buffer `min`/`max`).
- **Evidence:** recorded in the capture report: a date of `2026-2-3` makes `checkValidity()` false with the native message, so the friendly "Use yyyy-mm-dd" text never appears.
- **Why:** two visual languages for errors; native bubbles are unstyled, transient and not announced consistently.
- **Fix:** add `novalidate` to both forms and route every check through the app's messages.

#### F2 (P1) Errors appear far from the field

- **What:** "Choose a thread before scheduling." appears at the bottom above the submit button; the thread picker is at the top; no field gets `aria-invalid`.
- **Where:** `renderer/app.js:102` (`#schedule-error`), `renderer/app.js:194` (submit handler).
- **Evidence:** `18-composer-error-no-thread-light-1180.png`, `20-composer-error-past-light-1180.png`.
- **Why:** Users must search back through the form to find and correct the invalid input.
- **Fix:** render the message under the relevant field, set `aria-invalid`, move focus to the first invalid field.

#### F3 (P1) Quick times are grouped with the message

- **What:** The +5 min to Tomorrow chips sit between Message and the Date label.
- **Where:** `renderer/app.js:102`.
- **Evidence:** `17-composer-new-light-1180.png`.
- **Why:** they read as message presets.
- **Fix:** wrap date, time, chips, calendar and timezone in a "When" fieldset with the chips under its legend.

#### F4 (P2) Calendar gaps

- **What:** Escape does not close it; there is no today marker; past days are selectable; the toggle glyph ▦ renders as a filled grey square; the ghost toggle is inset 16 px from the field edge.
- **Where:** `renderer/app.js:117`, `renderer/app.js:193`, `styles.css:1` `.ghost`.
- **Evidence:** `24-composer-calendar-light-1180.png`, `25-composer-calendar-keyboard-light-1180.png`; Escape check recorded as not closing.
- **Why:** Keyboard users lose a predictable exit, and selectable past dates invite avoidable errors.
- **Fix:** Escape closes and returns focus to the toggle, mark today, disable past days, use a text label "Calendar" aligned to the field edge.

#### F5 (P2) The thread picker reads like a button with a stray chevron

- **What:** The chevron sits inline after the title rather than at the right edge; "Send to thread" is a `<label>` not associated with any control, so it is announced as nothing.
- **Where:** `renderer/app.js:102`.
- **Evidence:** `17-composer-new-light-1180.png`; the accessibility tree shows an empty `LabelText` and a button named "Choose a thread ⌄ Most recently active first".
- **Why:** The selection affordance is unclear visually and its label is unavailable to assistive technology.
- **Fix:** right-align the chevron as a decorative element and use `aria-labelledby` from a visible label.

#### F6 (P2) Settings feedback is thin

- **What:** Save and Check connection report only through a 5-second toast; the token placeholder says "Leave blank to keep the saved token" while an environment token is in use; "Launch at login" exists only in the tray.
- **Where:** `renderer/app.js:144`, `main.js:188`.
- **Evidence:** `26-settings-light-1180.png`, `27-toast-connected-light-1180.png`.
- **Why:** Transient feedback is easy to miss, and token guidance can imply that a different credential is active.
- **Fix:** show the last connection result inline in the Connection card, adapt the placeholder, add Launch at login to the window.

#### F7 (P2) Invalid timezone is shown as a hint

- **What:** An unknown timezone shows grey help text in the preview rather than an error on the field.
- **Where:** `renderer/app.js:111`.
- **Evidence:** `23-composer-bad-timezone-light-1180.png`.
- **Why:** A blocking input problem looks like optional guidance, delaying correction.
- **Fix:** Mark the timezone field `aria-invalid`, show the message under it as an error, and offer a suggestion list.

### Status clarity

#### S1 (P0) Offline understates the consequence

- **What:** The status reads "Offline · queue saved" and the notice says the queue and history remain available.
- **Where:** `renderer/app.js:51`, `renderer/app.js:53`.
- **Evidence:** `33-upcoming-offline-html-light-1180.png` shows a message due in 24 minutes under "queue saved".
- **Why:** the jobs are saved but will fail if T3 Code is still unreachable when they run; "saved" reads as "safe".
- **Fix:** name the risk: "T3 Code is unreachable.
  2 messages are due in the next hour and will fail unless it is back."
  Mark affected rows.

#### S2 (P1) A missing token looks like an outage

- **What:** With no token the notice title is "T3 Code is unavailable" and the status is "Offline · queue saved"; only the body mentions the token.
- **Where:** `renderer/app.js:53` (title is fixed regardless of error code).
- **Evidence:** `no-token-upcoming-light-1180.png`.
- **Why:** An outage diagnosis sends users toward connection troubleshooting instead of credential setup.
- **Fix:** title by error category: "Add your T3 token", "T3 Code rejected the token", "T3 Code is not running", "Unexpected response from T3 Code".

#### S3 (P1) Connection status disappears at the real minimum width

- **What:** `.connection{display:none}` applies at 650 px and below; the window's minimum width is 620 px.
- **Where:** `styles.css:1` `@media(max-width:650px)`, `main.js:122`.
- **Evidence:** `01-upcoming-light-620.png`, `01-upcoming-light-420.png`.
- **Why:** Users at a supported window width lose the persistent connection signal.
- **Fix:** keep the dot with an accessible label at narrow widths.

#### S4 (P2) Overdue pending jobs say "Scheduled · 1 min ago"

- **What:** A job waiting for catch-up (after wake or while sending) shows the Scheduled pill with a past relative time.
- **Where:** `renderer/app.js:87`.
- **Evidence:** `01-upcoming-light-1180.png` (first row).
- **Why:** A past scheduled time does not explain whether the app is catching up or has stalled.
- **Fix:** show "Sending now" or "Catching up" when the effective time has passed.

#### S5 (P2) Unconfirmed delivery uses failure styling and two action areas

- **What:** The unconfirmed block has a red border while its pill is amber; Acknowledge appears before Check delivery, in a separate action area.
- **Where:** `renderer/app.js:134`, `styles.css:1` `.error-detail`.
- **Evidence:** `11-detail-unconfirmed-light-1180.png`.
- **Why:** Failure styling suggests a known outcome even though delivery remains uncertain.
- **Fix:** amber styling, one action row with Check delivery first.

#### S6 (P2) Connection changes are silent to screen readers

- **What:** `#connection-state` is not a live region.
- **Where:** `renderer/app.js:51`.
- **Evidence:** The `ax-upcoming.txt` accessibility tree dump from `tools/ui-review-capture.cjs` has no live status for the connection label; `renderer/app.js:51` renders `#connection-state` without live-region semantics.
- **Why:** Connection changes can go unnoticed when the interface is read through assistive technology.
- **Fix:** `role="status"` on the connection label.

#### S7 (P1) Loading looks like an empty result

- **What:** Before the first thread response, Threads says "No matching threads" and offers "Show all non-archived threads".
- **Where:** `renderer/app.js:95` (empty state ignores `state.online === null`).
- **Evidence:** `loading-threads-light-1180.png`, `loading-composer-picker-light-1180.png`.
- **Why:** Users may change filters or assume their threads are missing before loading finishes.
- **Fix:** a "Loading threads…" state while `state.online === null`.

### Error recovery

#### E1 (P1) The failure toast covers the primary action

- **What:** The live "A scheduled message failed. View" toast appears bottom-centre over "Schedule again", including when the failed job is the one on screen.
- **Where:** `renderer/app.js:163`, `renderer/app.js:240`, `styles.css:1` `#toast`.
- **Evidence:** `30-toast-failure-light-1180.png`.
- **Why:** The recovery action is obscured, and the redundant View action adds no useful destination.
- **Fix:** skip View when that job is open, place the toast bottom-left clear of the content column, and keep action toasts until dismissed (the 10-second timeout also conflicts with WCAG 2.2.1).

#### E2 (P2) Authentication failures lead with Schedule again

- **What:** For a rejected token the primary action is Schedule again; Connection settings is a ghost button.
- **Where:** `renderer/app.js:134`.
- **Evidence:** `10-detail-failed-light-1180.png`.
- **Why:** Rescheduling does not repair the rejected credential and can lead to another failure.
- **Fix:** when `error.code` is `authentication_rejected` or `missing_credentials`, make "Update token" primary.

#### E3 (P0) Storage errors hide the queue and still offer scheduling

- **What:** With an unreadable `jobs.json`, the nav shows "Upcoming 0", History has no badge, and New schedule opens a composer that cannot save.
- **Where:** `renderer/app.js:82`, `renderer/app.js:69`.
- **Evidence:** `storage-upcoming-light-1180.png`, `storage-composer-light-1180.png`.
- **Why:** "0" tells the user nothing is scheduled when their jobs are simply unreadable; they may re-create them elsewhere.
- **Fix:** replace counts with "?", disable New schedule with the reason, and add "Show data folder".

#### E4 (P2) Legacy records show raw thread IDs

- **What:** A legacy record shows "t-sched" and "T3 CODE" although the thread is in the current list.
- **Where:** `renderer/app.js:134` (`job.threadTitle || job.threadId`).
- **Evidence:** `14-detail-legacy-light-1180.png`.
- **Why:** An internal identifier makes a historical outcome harder to associate with its conversation.
- **Fix:** look up the current thread title, as the development plan intended; say "Timezone not recorded" rather than "(legacy record)".

### Accessibility

#### A1 (P1) Navigation names run the count into the label

- **What:** Buttons are announced as "Upcoming7" and "History2".
- **Where:** `renderer/app.js:48`.
- **Evidence:** accessibility tree for Upcoming.
- **Why:** The count has no spoken meaning and runs into the navigation label.
- **Fix:** visually hidden text: "Upcoming, 7 scheduled", "History, 2 need attention".

#### A2 (P1) Row buttons have long, badly ordered names

- **What:** Rows are announced as "AGENT-AUTO-CONTINUE Scheduled Refactor the sync worker Continue with the sync worker refactor. 2026-09-30 · 23…"; the project is in capitals; `<div>` inside `<button>` is invalid HTML.
- **Where:** `renderer/app.js:87`, `renderer/app.js:95`.
- **Evidence:** The `ax-upcoming.txt` accessibility tree dump from `tools/ui-review-capture.cjs` records row names beginning "AGENT-AUTO-CONTINUE Scheduled Refactor the sync worker Continue with the sync worker refactor.", with the project and status before the title.
- **Why:** Screen reader users must hear metadata and message text before identifying the conversation.
- **Fix:** make the title the accessible name and the rest a description, or use the prototype pattern of a title button inside an `<article>`.

#### A3 (P2) Headings get an off-brand browser focus ring

- **What:** After keyboard navigation the h1 (`tabindex="-1"`) shows the browser's default ring: amber in light, blue in dark.
- **Where:** `renderer/app.js:69`, `styles.css:1` (no `h1:focus` rule).
- **Evidence:** most screenshots, for example `08-history-light-1180.png`, `01-upcoming-dark-1180.png`.
- **Why:** Inconsistent focus treatments make navigation feel disconnected from the rest of the interface.
- **Fix:** `h1:focus{outline:none}` for programmatic focus, or the accent ring for `:focus-visible` only.

#### A4 (P1) Field and pill borders are nearly invisible

- **What:** Input borders are 1.23:1 against their fill and 1.31:1 against the card; WCAG 1.4.11 asks for 3:1 for component boundaries.
- **Where:** `styles.css:1` `--line` used by `.field input`, `.search`, `textarea`, `.pill`.
- **Evidence:** [Contrast measurements](#contrast-measurements).
- **Why:** Low-contrast boundaries make editable controls harder to distinguish from their surroundings.
- **Fix:** a separate `--field-line` token (`#857E74` light, 3.46:1; `#8A8398` dark, 3.64:1), as used in the prototypes.

#### A5 (P2) Several small texts are below 4.5:1 or very small

- **What:** Muted text on the page background is 4.50:1 (a hair under), the accent "Scheduled" pill text is 4.45:1 at 9 px, the light placeholder is 3.98:1, and dark error text on raised surfaces is 4.35:1; pills are 9 px and meta text 10 px.
- **Where:** `styles.css:1` tokens and `.pill`, `.meta`, `.overline`.
- **Evidence:** [Contrast measurements](#contrast-measurements) lists the measured foreground and background pairs.
- **Why:** Small, low-contrast labels make status and error information harder to read.
- **Fix:** `--muted:#66616D` (4.92:1 on the page), an `--accent-ink:#655785` for text, a warm placeholder colour, pills at 11 px.

#### A6 (P2) The calendar is not a grid

- **What:** Day buttons are named only by ISO date; there is no grid role or weekday in the name.
- **Where:** `renderer/app.js:117`.
- **Evidence:** The `ax-composer.txt` accessibility tree dump from `tools/ui-review-capture.cjs` covers the composer controls; `renderer/app.js:117` supplies ISO-only day names and no grid semantics for the opened calendar shown in `24-composer-calendar-light-1180.png`.
- **Why:** Assistive technology lacks the weekday and row relationships that make a calendar understandable.
- **Fix:** `role="grid"` semantics or names like "Friday 2 October 2026".

### Visual polish

#### V1 (P1) The approved type is not what ships, and neither is the icon

- **What:** Fraunces and Inter are not installed on a typical Mac or bundled; the CSP blocks remote fonts, so headings render in Georgia bold and body text in San Francisco.
  `package.json` points at `assets/icon.png`, which does not exist, and the build logs "default Electron icon is used".
- **Where:** `styles.css:1` `h1,h2,.brand`, `dashboard.html` CSP, `package.json:25`, `package.json:40`.
- **Evidence:** every production screenshot versus the prototypes; CI build log.
- **Why:** Fallback typography changes the approved visual identity, while a default icon makes the installed app harder to recognise.
- **Fix:** bundle Fraunces and Inter (both OFL) as local `woff2` with `@font-face`; generate `icon.png`/`icns` from `assets/icon.svg`.

#### V2 (P2) Empty count spans skew the nav

- **What:** `.nav-count` keeps its 7 px left margin when empty, so Threads and Settings have lopsided padding.
- **Where:** `styles.css:1` `.nav-count`, `renderer/app.js:48`.
- **Evidence:** `01-upcoming-light-1180.png` (compare the gaps after "History 2", "Threads" and "Settings").
- **Why:** Empty badge spacing makes otherwise equivalent navigation buttons look uneven.
- **Fix:** `.nav-count:empty{display:none}`.

#### V3 (P2) The Connection overline touches its heading

- **What:** "CONNECTION" sits directly on "Your local T3 Code"; the support card has an 8 px gap.
- **Where:** `styles.css:1` `.settings .card`, `.support h2`.
- **Evidence:** `26-settings-light-1180.png`.
- **Why:** The missing gap weakens the separation between the section label and its heading.
- **Fix:** `.overline + h2{margin-top:6px}`.

#### V4 (P2) Copy and glyph details

- **What:** The ambiguous-time label joins "This time occurs twice" and "choose an offset" with an em dash; the appearance option is called "Bone Outline"; History search says "Search loaded messages"; "↗" on submit suggests an external link; "＋" is a full-width plus.
- **Where:** `renderer/app.js:111`, `renderer/app.js:144`, `renderer/app.js:85`, `renderer/app.js:102`, `renderer/app.js:69`.
- **Evidence:** `renderer/app.js:111`, `renderer/app.js:144`, `renderer/app.js:85`, `renderer/app.js:102` and `renderer/app.js:69` contain the copy and glyphs; `22-composer-dst-ambiguous-light-1180.png` and `26-settings-light-1180.png` show the ambiguous-time label and appearance option.
- **Why:** Inconsistent terminology and ambiguous glyphs add interpretation work to common actions.
- **Fix:** "This time happens twice.
  Choose an offset.", "Dark", "Search messages", drop the arrows, use "+".

#### V5 (P2) Empty Upcoming has two primary buttons and a "0"

- **Where:** `renderer/app.js:85`.
- **Evidence:** `empty-upcoming-light-1180.png`.
- **Why:** Competing primary actions and a redundant zero distract from the empty-state next step.
- **Fix:** hide the header button when the empty state shows its own.

#### V6 (P2) Retired screens are still packaged

- **What:** `ui.html` and `settings.html` are unused, still in `build.files`, and use classes (`eyebrow`, `hint`, `secondary`) that no longer exist in `styles.css`.
- **Where:** `package.json:33`.
- **Evidence:** `package.json` `build.files` includes `ui.html` and `settings.html`; `grep -Eo "\.(eyebrow|hint|secondary)([^[:alnum:]_-]|$)" styles.css` returns no matching class selectors.
- **Why:** Packaged obsolete screens add maintenance ambiguity and can be mistaken for supported interfaces.
- **Fix:** remove them from the package, or delete them.

#### V7 (note) The 420 px breakpoint is unreachable in the app

- **What:** The window cannot be narrower than 620 px, so the 420 px rules only matter if the renderer is reused for the phone board in issue #4.
- **Where:** `main.js:122`, `styles.css:1`.

## Contrast measurements

WCAG 2.2 ratios from the `styles.css` tokens.
Text needs 4.5:1; component boundaries and focus indicators need 3:1.

| Pair | Light | Dark | Use |
| --- | --- | --- | --- |
| ink on surface | 11.93 | 12.00 | body text |
| muted on surface | 5.08 | 6.88 | help, meta |
| muted on page background | 4.50 (just under) | 7.89 | help under cards |
| accent on surface | 4.45 (fails) | 4.86 | Scheduled pill, 9 px |
| red on surface / raised | 4.84 / 4.51 | 4.82 / 4.35 (fails) | errors |
| white on accent | 4.81 | 5.57 (dark text) | primary buttons |
| accent ring on page / card | 3.94 / 4.45 | 5.57 / 4.86 | focus indicator, passes |
| line on raised (input border) | 1.23 (fails) | 1.14 (fails) | input boundaries |
| line on surface (pill border) | 1.31 (fails) | 1.27 (fails) | pill and input boundaries |
| placeholder `#757575` on raised | 3.98 (fails) | not measured | search placeholder |
| star text on amber | 5.51 | 5.51 | support sticker |

## What already works well

- Tab order follows the visual order in every view, and every control has a visible 3 px accent focus ring.
- Focus moves to the new page heading on navigation and is restored after background refreshes.
- Reduced motion is honoured: the support star stops and no transitions run.
- Timezone, DST gap and repeated-hour handling is clear and correct in the composer preview.
- Offline history stays readable; technical details are sanitised and behind a disclosure.
- "Sent to T3 Code" versus agent completion is explained where it matters.
- The inline cancel confirmation is calm and reversible.

## Quick wins

Each is small, low risk and independent of the feature direction.
Approve any subset for immediate implementation.

1. Nav counts: spoken labels and a distinct attention badge that stays visible at every width (N4, A1).
2. `.nav-count:empty{display:none}` (V2).
3. One column width for Back, heading and card in detail and composer (H3).
4. `h1:focus{outline:none}` for programmatic focus (A3).
5. `.overline + h2` spacing in Settings (V3).
6. Copy: remove the em dash, "Dark" instead of "Bone Outline", "Search messages", drop "↗" and "＋" (V4).
7. "Loading threads…" while the first connection is pending (S7).
8. Notice titles by error category, starting with the missing token (S2).
9. Keep the connection dot at narrow widths (S3).
10. Toast: no View for the open job, bottom-left placement, action toasts stay until dismissed (E1).
11. Back from Edit returns to the detail (N1).
12. `--field-line` token for input and pill borders (A4).
13. Escape closes the calendar (F4).
14. `novalidate` on both forms so the app's own messages always show (F1).
15. Offline notice names the jobs at risk (S1) and storage errors hide counts and disable New schedule (E3).

## Feature prototypes

The prototypes extend `design/mockups/` with four new concepts.
Open `design/mockups/index.html` and choose 05 to 08, or see the [README](../design/mockups/README.md).
The dark studio bar at the top switches between the alternatives below, with the recommendation marked "rec.".
Screenshots are in [`design/mockups/screenshots/`](../design/mockups/screenshots/).

| Screen | Screenshot |
| --- | --- |
| Board, tonight | [light](../design/mockups/screenshots/05-board-tonight.png), [dark](../design/mockups/screenshots/05-board-tonight-dark.png), [620 px](../design/mockups/screenshots/05-board-620.png), [420 px dark](../design/mockups/screenshots/05-board-420-dark.png) |
| Board, something went wrong | [light](../design/mockups/screenshots/05-board-something-wrong.png) |
| Board, next morning report | [light](../design/mockups/screenshots/05-board-next-morning.png) |
| Board, empty | [light](../design/mockups/screenshots/05-board-empty.png) |
| Composer, when free and until done | [light](../design/mockups/screenshots/05-compose-when-free-until-done.png), [at a time, dark](../design/mockups/screenshots/05-compose-at-a-time-dark.png), [turn error](../design/mockups/screenshots/05-compose-turn-error.png), [presets](../design/mockups/screenshots/05-compose-presets.png), [420 px](../design/mockups/screenshots/05-compose-420.png) |
| Thread picker | [grouped by agent](../design/mockups/screenshots/05-picker-grouped.png), [agent first](../design/mockups/screenshots/05-picker-agent-first.png) |
| Task detail | [needs you](../design/mockups/screenshots/05-detail-needs-you.png), [running, dark](../design/mockups/screenshots/05-detail-running-dark.png) |
| Agents | [capabilities](../design/mockups/screenshots/05-agents.png), [add an agent](../design/mockups/screenshots/05-agents-add.png) |
| Settings: keep awake and phone | [light](../design/mockups/screenshots/05-settings-awake-phone.png), [420 px dark](../design/mockups/screenshots/05-settings-420-dark.png) |
| History | [light](../design/mockups/screenshots/05-history.png) |
| Alternatives | [keep-awake chip only](../design/mockups/screenshots/05-board-awake-chip-only.png), ["handoff" wording](../design/mockups/screenshots/05-board-words-handoff.png), [Queue+ light](../design/mockups/screenshots/06-queue-tonight.png), [Queue+ dark](../design/mockups/screenshots/06-queue-tonight-dark.png) |
| Phone board | [reachable](../design/mockups/screenshots/07-phone.png), [unreachable, dark](../design/mockups/screenshots/07-phone-unreachable-dark.png) |
| Menu bar | [light](../design/mockups/screenshots/08-menu-bar.png), [dark](../design/mockups/screenshots/08-menu-bar-dark.png) |

### What the recommended direction does

- **Board home (05).** Tasks are grouped by what the user must do: Needs you, Running, Waiting, Done tonight.
  Waiting stays soonest first, so today's time-ordered answer is still there.
  Each row names its agent with a monogram and says in words what will stop or start it.
- **Status strip.** The top bar replaces "T3 Code connected" with one monogram per agent carrying an availability dot, a keep-awake chip and a phone chip.
  Below 760 px it collapses to "3 agents need a look" and the moon, so status never disappears (fixes S3).
- **Composer.** Three questions in order: which thread, when (When the agent is free, At a time, Right away), and how far (a set number of turns, or Until done).
  In Until done mode, the turn limit is optional for agents that can report completion and required for API agents that cannot; Until done is unavailable for desktop agents.
  Safety stops that can never be turned off are shown checked and locked.
  A plan sentence restates the whole task, and the recommended task wording makes the submit button repeat the commitment ("Start when Claude Code is free", "Schedule for 06:30"). When the selected agent is already free, the When free plan says it starts right away and the button says "Start now".
  Turn counts are validated inline with `aria-invalid` (fixes F1 and F2 in the new design).
- **Harness selection.** The agent is chosen implicitly through a thread picker grouped by agent, with availability per group and agents that cannot run listed with a reason.
  Agents is a management page with a capability table per agent and an Add agent flow that explains Accessibility permission for desktop apps.
- **Keep awake.** A session card appears on the Board only while the Mac is being kept awake, always says why and until when, turns amber when a desktop agent needs the screen, and becomes a morning report.
  Settings owns the rules: when to keep awake, display, battery floor, and an honest note about closing the lid.
- **Phone.** Settings offers Off, This Mac only, or Private network (Tailscale), paired devices with revoke, a QR code with four typed words, and an MCP connector.
  The phone board (07) shows the Mac's receipt for every action and a greyed, last-seen state when unreachable.
- **Review fixes built in.** One column width, attention badge with spoken text, h1 focus handling, `--field-line` borders, `--muted:#66616D`, `--accent-ink` for text, title buttons inside `<article>` rows.

## Evaluation of the Fable design pass

A separate Fable 5.1 pass produced concept sketches and written suggestions, kept in [`design/mockups/fable-pass/`](../design/mockups/fable-pass/) with its own [suggestions](../design/mockups/fable-pass/suggestions.md).
I evaluated each idea against the findings above and the Paper / Focus language.

### Adopted from the Fable pass

- The Board grouped by Needs you, Running, Waiting and Done, with collapsed empty sections.
- Agent monograms, square for API and CLI harnesses and round for desktop apps, with no vendor logos.
- Five availability states that always name their source and age, with Unknown as a first-class state.
- The composer's "which thread, when, how far" order, the locked safety stops, and the plan sentence in Fraunces.
- The keep-awake session card that says why, its attention state for desktop agents that need the screen, and the morning report.
- The capability table per agent, and moving per-agent connection settings out of Settings.
- Delivered versus Done wording, turn tallies, the Mac receipt on the phone, and colour in the menu bar meaning only "needs you".

### Changed

- **"Handoff" becomes "task" (switchable).** In this audience's tools a handoff already means passing work from one agent to another, and "Hand off" on a button reads as transferring the thread to a different harness, which issue #2 makes plausible.
  The owner's own issues say "task" (#3 "resumes a task", #5 "which tasks need it"), and it pairs naturally with "task complete".
  The studio bar can switch the prototype to "handoff" or today's "schedule" to compare.
- **"Shift" becomes "Keep awake".** Shift is charming but needs explaining; "Keep awake" matches issue #5, Amphetamine and macOS vocabulary, and the card still has a start, an end and a report.
- **Zero turns is rejected, not "never send".**
  A task that never sends is a canceled task; the prototype says "Use at least 1 turn.
  To stop a task, end it instead."
  Unlimited continuous mode remains available for agents that can report completion; see the [composer behaviour](#what-the-recommended-direction-does) for capability restrictions.
- **The mandatory no-progress guard** for Until done is kept, but shown as a locked stop only when Until done is chosen.
- **Phone reach** drops the relay option; per the owner it is localhost or Tailscale with revocable tokens and MCP, never public.
- **The primary button** restates the commitment instead of a fixed verb.

### Not adopted

- Hiding the Waiting time order: kept as the sort within Waiting.
- Replacing the timezone on every row with a single board-level line: adopted for the Board, but the detail keeps the full instant because tasks can be created in other timezones.
- Keyboard shortcuts are a good idea but were not prototyped; see decision D12.

## Decisions to approve

Each decision has a recommendation.
The prototype's studio bar demonstrates the alternatives for D1, D2, D3, D5 and D6.
D4 is a proposed first-use policy; the Settings mockup shows the automatic option selected, without a first-use prompt.
D9 proposes Off as the initial phone-access setting; the mockup instead illustrates an already paired private-network session.

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D1 | Home screen | **Board** grouped by Needs you, Running, Waiting, Done (05) or **Queue+**, today's time-ordered Upcoming with a Needs you notice (06) | Board, because "when free" and "until done" have no fixed time, and overnight the first question is "does anything need me?" |
| D2 | Name of the thing the user creates | **Task**, **Handoff** (Fable), or **Schedule** (today) | Task, for the reasons above; keep the data model's field names. |
| D3 | Keep-awake presentation | **Session card** on the Board plus a strip chip, or **strip chip only** | Session card, to explain why and until when the Mac stays awake and to show the morning report afterwards. |
| D4 | Keep-awake default | Automatic while tasks need it, ask each time, or never | Ask the first time a task needs it and remember the answer; default to automatic afterwards. |
| D5 | Composer shape | **Two questions** (when, how far) or **three presets** | Two questions, because when and how far are independent; presets hide "at 03:00, until done". |
| D6 | Harness selection | **Thread picker grouped by agent**, or **agent first** | Grouped picker, because most users think of the thread, not the tool; agent-first adds a step every time. |
| D7 | Turn limit semantics | 0 and negative values rejected; capability-dependent limits as described in the [composer behaviour](#what-the-recommended-direction-does); a turn counts only after confirmed delivery | Approve as prototyped. |
| D8 | Desktop-app agents that need an unlocked screen | Keep display on automatically, ask per task, or never | Ask per task with a clear warning on the Board; never unlock or bypass the lock screen. |
| D9 | Phone access | Off by default; This Mac only; Private network (Tailscale); tokens per device; MCP connector | Approve as prototyped, off by default, pairing codes expire in 5 minutes. |
| D10 | Navigation | Board, History, Agents, Settings (Threads moves into Agents and the picker) | Approve. |
| D11 | Implement the quick wins now | Any subset of the 15 | Approve all; they are independent of D1 to D10. |
| D12 | Keyboard shortcuts | Cmd+N new task, Cmd+1 to Cmd+4 navigation, Esc back | Approve with the quick wins. |
| D13 | Bundle fonts and ship an icon | Bundle Fraunces and Inter locally and generate `icon.icns`, or switch tokens to system fonts | Bundle them; the approved identity depends on Fraunces. |

## Tooling fixes

These were pre-existing problems found during the review and are in separate commits.

- **The Electron smoke fixture never delivered `jobs:changed` or `settings:changed`.**
  `BrowserWindow.getAllWindows()` does not list the subclassed fixture window, so every main-process broadcast was dropped and live renderer updates were never exercised.
  The fixture now lists its windows explicitly and asserts that a broadcast arrives; the assertion fails without the fix.
- **CI fails on every push to main.**
  The Package macOS app job builds successfully, then electron-builder detects CI and tries to publish a GitHub release without `GH_TOKEN`.
  The packaging policy is documented under [Build a macOS app](../README.md#build-a-macos-app).
  This only happens on push events, so the pull request run cannot prove it; it will be confirmed by the first push to main after merging.

`npm test` (46 tests) passed repeatedly with no flakiness, and `npm run test:electron` passes.
