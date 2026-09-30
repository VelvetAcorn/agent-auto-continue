# Scheduler experience development plan

Prepared 2026-09-30 from a source review and the supplied design reference.
Product recommendations were accepted on 2026-09-30.
The user selected Paper / Focus for implementation after reviewing the prototypes.
Backend foundation, regression tests and the selected Paper / Focus production renderer are implemented.
Final delivery validation and PR CI establish the release-readiness evidence.
The actual live-server cause of the reported HTML response remains unconfirmed.

## Original review findings (before this implementation)

| Area | Current implementation | Consequence |
| --- | --- | --- |
| Errors | `apiRequest` in `main.js` parses every nonempty successful response as JSON and forwards error text directly. | An HTML response can surface as a JavaScript parse error; the actual endpoint/version problem still needs diagnosis. |
| Persistent warning | `dashboard:threads` returns every failed job, and `dashboard.html` renders the first failure on every refresh. | Historical failures look like a current incident forever; there is no acknowledgment state. |
| Schedule visibility | All jobs are persisted; pending/dispatching jobs appear in the tray, while the dashboard receives only a count. | Upcoming and historical schedules can be exposed using existing local data. |
| Threads | `activeThreads` excludes archived threads, preserves server order, and returns only ID, title, and project ID. | Recency and settled filtering require a richer, verified thread adapter. |
| Windows | Scheduling and settings each create separate Electron windows. | Both need to become routes or panels inside the dashboard window, including entry through the tray. |
| Dates | The composer uses native `datetime-local`; tray labels use the machine locale. | An ISO-shaped input value does not guarantee ISO-formatted visible dates. |
| Success | The app marks a job sent after a successful dispatch request, or when its message ID is found. | It does not establish that the agent completed its turn successfully. |
| Updates | Job changes rebuild the tray; the dashboard refreshes at load or on demand. | Creating or completing a job does not update the main UI immediately. |

## Proposed product shape

Use a single resizable application window, initially designed around approximately 1000 x 700 pixels with a usable compact layout.
Keep the menu-bar companion and background scheduling behavior.
Use Upcoming as the default destination so the app immediately answers what is going to happen next.

| Region | Contents |
| --- | --- |
| Navigation | Upcoming with count, History with unacknowledged failure count, Threads, Settings |
| Header | Current view, compact connection status, primary New schedule action |
| Main area | Search/filter controls and the selected list |
| Detail panel | Selected schedule details, or the schedule composer with an embedded thread picker |

At narrower widths, show the detail/composer view as an internal page with Back navigation.
Opening the composer preserves the current list, filters, scroll position, and unsaved draft.
Settings also lives in this window.
Tray actions focus the existing window and navigate to the relevant view or preselected thread.

### Upcoming and history

Upcoming sorts by effective send time, soonest first, and includes scheduled and currently sending jobs.
Rows show thread title, project, message preview, ISO date, 24-hour time, timezone context, relative time, and status.
Selecting a row reveals the full message, requested time, safety buffer, effective send time, and available actions.
Pending jobs support edit/reschedule and cancel; sending jobs cannot be edited or canceled once dispatch begins.
The main process enforces this state transition to prevent timer races.

History sorts by completion/update time, newest first, with All, Sent, Failed, and Canceled filters plus search.
Each record keeps its outcome, timestamp, and cancellation/failure reason.
Offer Schedule again for terminal jobs, with the composer prefilled, subject to delivery reconciliation when the prior result is uncertain.
Keep history readable while T3 Code is offline.
Persist thread/project display names with new jobs so deleted threads remain understandable; legacy records use a current lookup or their stored thread ID.

Use delivery labels that match evidence: Scheduled, Sending, Sent to T3 Code, Failed, Canceled, and Delivery unconfirmed when dispatch may have succeeded but no trustworthy confirmation was received.
Agent completion is a separate optional outcome, only if the upstream API can reliably associate a turn and its result with our message.
Legacy sent records should not be upgraded to agent-success records.

### Errors and recovery

Separate three kinds of feedback:

- Form validation stays beside the relevant field until corrected.
- Current connectivity problems appear in a compact status/banner with a useful action, and resolve when a check succeeds.
- Delivery failures remain in History, with an acknowledgment control that clears their attention badge without deleting the record.

New failures get a brief dismissible notification linked to their history detail.
Do not announce the same historical failure again on refresh or restart.
Success notifications can disappear automatically; persistent records remain available in History.
Apply friendly wording to desktop notifications and tray entries as well as the main window.

Normalize API errors into structured categories: missing credentials, authentication rejected, connection refused, timeout, HTTP failure, unexpected response format, and unsupported response shape.
For the reported HTML response, use wording such as “T3 Code returned a webpage instead of the expected API response. Check the connection settings and API compatibility.”
Include Settings and Check connection actions, with sanitized status/endpoint/content-type details behind Show technical details.
Do not expose tokens or raw HTML in routine UI or logs.
Handle malformed JSON, unexpected content types, empty responses according to the endpoint contract, and invalid successful payloads.

Track whether a failure happened before dispatch or after a request might have reached the server.
Reconcile ambiguous delivery using stable message/command IDs before allowing another send.
Preserve the existing no-automatic-retry policy unless explicitly changed.
Acknowledging an error must never resend a message.

### Thread selection

Use a searchable list with title, readable project name where available, thread state, and relative last activity such as “24 min ago” or “3 days ago.”
Sort by the verified upstream last-activity field, newest first, with deterministic handling of ties and missing timestamps.
Expose the exact ISO date and time on focus/hover and in details.
Refresh relative labels periodically without rebuilding focused controls.

Hide settled threads by default with an explicit Show settled toggle and a visible indication of the active filter.
Keep archived threads excluded separately.
Unknown thread states remain visible rather than silently disappearing.
Verify T3 Code's actual definition and field for settled before implementing this rule; do not equate it with idle, archived, or old.
Filtering the picker must not hide existing scheduled jobs for those threads.
An empty filtered result should offer to include settled threads or clear search.

### Scheduling and dates

Use an in-window composer with a thread summary/picker, message field, quick times, date picker, time control, and clear confirmation summary.
Provide +5 min, +30 min, +1 hour, and Tomorrow at 09:00 as initial proposed shortcuts.
Use an accessible calendar with a keyboard-editable `yyyy-mm-dd` field and a separate 24-hour `HH:mm` control.
Render all absolute dates consistently across lists, detail panels, settings-related summaries, notifications, and tray entries.
Relative labels supplement the ISO dates where space permits.

Show the selected timezone and UTC offset, and store the scheduled instant in UTC with the original timezone context.
Validate invalid dates, past times, daylight-saving gaps, and ambiguous repeated times explicitly.
Preview the actual send time including the buffer before saving.
Recommended behavior: snapshot the buffer per job so changing the setting affects newly created schedules only.
The current code uses global buffer settings but does not rebuild existing timers on settings changes, so this also needs consistent migration and timer behavior.

## Visual direction and iteration

The supplied [performative-ui reference](https://performative-ui.cncl.co/) combines dark surfaces, gradient accents, compact badges, monospace details, and animated elements.
Use its visual vocabulary as inspiration while keeping message content, dates, and delivery states easy to read.
Propose charcoal layered surfaces, subtle borders, violet/indigo accents, restrained glow on the primary action, and readable sans-serif text with tabular time numerals.
Use motion for panel transitions and real state changes, with reduced-motion support and no continuous decorative animation in working lists.
Support light and dark themes with adequate contrast and status labels that do not depend on color alone.

Add a distinct Quilla-inspired design iteration alongside the performative-ui direction, as requested on 2026-09-30.
Use the local [Quilla design canon](../quilla/docs/design/DESIGN.md), [design tokens and motion](../quilla/app/globals.css), and [ValueBadge starburst component](../quilla/app/_components/ui/value-badge.tsx) as the source references.
Quilla's philosophy is **Flat & Bold**, with **bold chrome, quiet data**: warm paper surfaces, 2px ink outlines, hard offset shadows, heavyweight Fraunces headings, and readable Inter body/control text.
Apply the bold treatment to navigation, cards, buttons, and list frames; keep schedule rows, message text, and form internals calm with hairline dividers and no row shadows.
Use the warm bone light palette (`#ECE8E1` background, `#F8F6F1` surfaces, `#34303A` ink), dusty purple actions, and semantic green/amber/red status treatments with explicit labels.
Include Quilla's Bone Outline dark treatment: warm charcoal surfaces, warm bone outlines, and hard near-black offset shadows.
Use tactile button press/lift feedback, visible keyboard focus, and reduced-motion support.
Keep this visual direction distinct from the gradient/glow treatment so the comparison reveals which identity suits the scheduler.

### Quilla starburst donation placeholder

Include a small Support this app card in Settings in the Quilla iteration, using the rotating starburst with upright centered text as a proposed donation control.
Start with “Buy me a coffee” beside a starburst labeled “Support”; identify the destination as “Ko-fi page coming soon.”
Adapt Quilla's 16-spoke amber star, ink/bone outline, hard offset shadow, and 9-second linear rotation; keep the text stationary and legible while the shape rotates.
Preview the optional 2.6-second gentle pulse separately so its intensity can be judged, rather than requiring it in the final design.
This is an intentional decorative motion moment in Settings; working lists remain free of continuous decorative animation.
Provide a static reduced-motion version and sufficient contrast in both themes.
Until a real Ko-fi URL is supplied, show a clearly unavailable placeholder with an accessible explanation and no external navigation or payment action.
Once configured, use a keyboard-accessible link with an explicit accessible name and open the verified destination in the system browser.
Keep the donation card secondary to settings controls and avoid showing it in scheduling, error recovery, or delivery confirmations.
No Ko-fi account creation, checkout integration, or payment collection is part of this work.

### Prototype comparison

Before wiring up the redesigned renderer, produce four clickable prototypes using the same realistic sample data:

1. Performative-ui direction with navigation, queue/history list, and a persistent contextual detail/composer panel.
2. Performative-ui direction with compact segmented Upcoming/History navigation and a composer that temporarily replaces the list within the same window.
3. Quilla Flat & Bold direction using the same layout as prototype 1, including Upcoming, History, Threads, composer, Settings, and the starburst donation placeholder in light and dark themes.
4. Paper / Focus: a compact focused layout using Quilla Flat & Bold paper styling and its dark theme, with less visible text and progressive disclosure of supporting details.
   This fourth iteration was added at the user’s request; retain the first three for comparison.

Compare creating a schedule, finding a recent thread, understanding a failed delivery, and rescheduling a job.
Compare prototypes 1 and 3 to judge visual identity independently of layout, then apply the chosen identity to the preferred layout.
Include empty, populated, disconnected, long-title, unknown-state, and narrow-window examples.
Use this iteration to decide density, panel behavior, and how expressive the visual treatment should be.
The reference is a React component collection, but the current app uses plain HTML and JavaScript; visual inspiration alone does not require a framework migration.
Default to modular renderer code and shared design tokens, and make a separate architecture decision if the prototype demonstrates a concrete need for React or a component library.

## Implementation sequence

| Phase | Deliverable | Acceptance gate |
| --- | --- | --- |
| 1. Reproduce and verify | Reproduce the HTML-response error through the app with a controlled local server; inspect the installed T3 API contract, thread fields, and dispatch response semantics. | Capture redacted fixtures for success, HTML, malformed JSON, authentication failure, timeout, and relevant thread states; identify whether the real endpoint needs correction. |
| 2. Design iteration | Four interactive prototypes comparing persistent-panel and compact layouts, including the quieter Paper / Focus iteration, and performative-ui versus Quilla visual directions, representative states, component styles, finalized wording, and a Settings starburst donation placeholder. | Choose the layout and visual direction independently; verify light/dark and reduced-motion treatments, upright starburst text, and an explicitly unavailable Ko-fi placeholder; confirm the open product decisions below. |
| 3. State and API foundation | Separate API client, job service/persistence, thread normalization, and IPC presentation contracts from `main.js`. | Versioned backward-compatible migration preserves all existing schedules, stable IDs, statuses, and notes. |
| 4. Single-window workflow | Main shell, richer thread picker, in-window composer/settings, shared date formatting, tray navigation. | Create a schedule entirely within one window and immediately see it in Upcoming. |
| 5. Lifecycle and recovery | Live job updates, history/detail views, acknowledgment, edit/cancel, schedule-again and reconciliation. | Jobs move from Upcoming to History without manual refresh; acknowledged failures stay acknowledged after restart. |
| 6. Verification and packaging | Automated integration/E2E checks, visual/accessibility review, packaged macOS smoke test, updated documentation. | Validate the real user journeys and reliability cases below before release. |

Keep Electron's existing context isolation, sandbox, narrow preload bridge, and local-only API destination.
Expose job listing independently of thread fetching so a server outage never hides the queue/history.
Publish job-change events from the main process, clean up renderer listeners, and refresh thread/connectivity data on focus plus a bounded interval with failure backoff.
Preserve drafts and prevent stale responses from overwriting newer UI state.
Use a validated IPC contract for list, edit, cancel, acknowledge, and reconcile actions.
Persist acknowledgment and structured outcome data separately from delivery status.

Verification must cover duplicate-send protection, ambiguous POST responses, crash recovery, canceled/edited timers, offline history, and restart persistence.
Also cover settlement filtering, missing dates, recency order, ISO display under different system locales, timezone changes and DST, focus/keyboard navigation, reduced motion, and readable long messages.
Test sleep/wake and missed schedules against the agreed policy.
The existing seven tests cover model helpers, not API behavior, the scheduler lifecycle, or renderer interactions; extend coverage at those boundaries.

## Accepted product decisions

All recommendations below were accepted by the user on 2026-09-30.
Paper / Focus is the approved layout and visual identity.
Use rotation with upright star text and reduced-motion support; the Ko-fi URL is deferred and its placeholder stays inactive.

| Question | Accepted starting point |
| --- | --- |
| What does “settled” mean in your T3 workflow? | Use the exact upstream state if available; verify it against a thread you recognize as settled. |
| Should success mean the message was sent, or the agent finished successfully? | Ship delivery history first; show agent completion only when the API provides reliable evidence. |
| Do you prefer queue-first or thread-first on launch? | Upcoming first, with New schedule always visible. |
| Should pending messages support editing as well as canceling? | Yes, edit message and time until dispatch starts. |
| Should errors disappear automatically or require acknowledgment? | Transient notification plus persistent history; explicitly acknowledge the attention badge. |
| What should happen to schedules missed while the Mac/app was unavailable? | Preserve existing catch-up behavior initially, but show lateness clearly; consider an expiry threshold if stale prompts are risky. |
| What does “newer user activity” mean for cancellation? | Cancel when a user message appears after schedule creation, using a captured baseline; current code instead compares against the requested send time. |
| Should a thread becoming settled cancel a pending job? | Treat settled as a picker filter only unless a separate cancellation rule is desired. |
| What should Tomorrow mean, and should travel change a schedule? | Tomorrow at 09:00 in the selected local timezone; a saved schedule retains its fixed instant when system timezone changes. |
| How long should history be retained? | Keep local history initially, with pagination and no silent deletion; decide retention before adding automatic cleanup. |
| Which visual direction should ship? | Compare performative-ui charcoal/violet gradients with Quilla Flat & Bold using the same layout and data; both include complete light/dark themes. |
| Should the Settings donation starburst rotate only, or also pulse? | Start with rotation and upright text; compare optional pulse in the Quilla prototype and honor reduced motion. |
| What Ko-fi URL should the donation control use? | Leave the clearly labeled placeholder inactive until the page exists and its URL is supplied; this does not block design iteration. |

No new recurring schedules, natural-language scheduling, provider-quota prediction, or automatic retries are assumed in this scope.


## Backend delivery status (2026-09-30)

Implemented independently of the prototype renderer:

- A loopback-only API client with friendly structured errors, strict dispatch acceptance checks, timeout handling, and suppressed raw response bodies.
- A versioned job service preserving existing IDs, statuses and notes, with per-job buffers, timezone context, activity baselines, stored display metadata, and UTC effective times.
- Local queue/history listing and pagination, pending edit/cancel, persistent acknowledgment, draft-only Schedule again, and reconciliation of uncertain outcomes.
- Duplicate-dispatch guards for stale timers, overlapping wake/run calls, interrupted sends, and ambiguous POST results.
- Recency-sorted thread normalization using the verified settlement field, plus narrow IPC methods and removable change listeners for the future renderer.

The installed T3 Code Alpha 0.0.40 application source maps were inspected read-only.
Its HTTP contract confirms the existing `/api/orchestration/snapshot`, `/threads/:threadId`, and `/dispatch` routes.
Dispatch acceptance is `{sequence: nonnegative integer}`; it does not confirm an agent completed successfully.
The detail response contains `thread` and optional pagination metadata.
The client classifies settled threads by `settledOverride === "settled"`; unknown values remain visible.
`updatedAt` provides the requested last-update ordering.
No credentials or personal thread content were inspected and no live messages were sent.

The original error was reproduced through the original dashboard IPC handler with a controlled HTML `Response` at the fetch boundary.
It returned `Unexpected token '<'` instead of actionable guidance.
A loopback test-server bind was denied by the sandbox, so the regression suite uses injected HTTP responses and mocked Electron/persistence boundaries.
This verifies API-to-IPC behavior, not a full Electron visual or real-server end-to-end run.

Automated tests cover response parsing/authentication/timeout, verified payload shapes, settlement/recency, migration, restart acknowledgment, offline history, effective-time ordering, stale callbacks, edit/cancel locking, persistence failures, activity cancellation, missed schedules, ambiguous dispatch, crash reconciliation, schedule-again guards, selected-zone DST offsets, IPC contracts, and listener cleanup.
The production renderer now includes Upcoming/History/acknowledgment controls, the single-window composer and settings, keyboard-operable ISO date controls, relative timestamps, and the selected Paper / Focus visual direction.
Its light and Bone Outline themes use local system fonts, reduced motion, quiet data rows and the inactive rotating Support star in Settings.
The production-window smoke fixture uses the real Electron main/preload/renderer with in-memory storage and a fake API that prohibits dispatch.
Real macOS sleep/wake and installed-server authenticated smoke tests remain release gates.
Automated PR CI runs behavioral tests, JavaScript syntax checks, the Electron smoke fixture and a macOS ZIP build.
Renderer visual/accessibility checks and local packaging results are recorded in the delivery review.
Legacy jobs without creation timestamps cannot reconstruct an activity baseline; they retain a conservative unknown baseline.
A missing message in a windowed thread snapshot does not establish nondelivery, so reconciliation leaves the job unconfirmed and never automatically resends it.

Corrupt, unreadable, invalid-record or future-version local schedule files now remain untouched; startup enters a visible read-only storage-error state with timers disabled.
This was added during independent review to avoid silently replacing the existing queue/history with an empty store.

## Paper Focus implementation review

The selected production UI received independent behavior and visual review before delivery.
Review fixes preserved focused controls and opened disclosures on background refresh, refreshed connection notices without discarding drafts, retained disabled controls after form errors, and restored list search/scroll when returning from details or the composer.
Visual checks covered desktop dark queue/composer, light Settings and its upright Support star, 620px layouts, keyboard calendar navigation across month boundaries, and reduced motion.

Final local validation passed 44 automated tests, production JavaScript syntax checks, and the isolated Electron workflow smoke test with zero dispatches.
The macOS package was inspected to confirm the main process, preload, renderer scripts and backend modules are included.
These checks do not claim authentication against the user's real server or a real macOS sleep/wake cycle.
