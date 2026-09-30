# Scheduler UI review

Open `index.html` directly, or run from the repository root:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory design/mockups
```

Then visit <http://127.0.0.1:4173/>.

## Four directions

- **01 Signal / workspace** (`?concept=split`): queue and contextual composer/details side by side.
- **02 Signal / focus** (`?concept=compact`): compact navigation and internal composer page.
- **03 Paper / workspace** (`?concept=quilla`): same workspace layout in Quilla's Flat & Bold style, with light and Bone Outline dark palettes.

- **04 Paper / focus** (`?concept=paper-focus`): requested hybrid of compact internal-page composition and Quilla styling, with short headings, quieter message rows, less repeated copy, and scheduling rules behind disclosure.

“Later” is an exploratory wordmark, not a proposed repository/app rename.

Directions 01-04 use the same fictional sample data and **fixed sample clock of 2026-09-30 14:00 BST**. Date validation and quick shortcuts deliberately use that clock so every direction remains comparable. Nothing connects to Electron or the real scheduler. Changes last only until reload. Google Fonts supplies Fraunces and Inter; serif/system fallbacks work without a network connection.

## Suggested review sequence

1. Compare 01 with 03 for visual identity without changing layout.
2. Compare 01 with 02 for panel versus internal-page composition.
3. Create a schedule; choose a thread and use the quick times or ISO date field/calendar. The queue immediately shows the simulated result.
4. Select a scheduled row, edit the time/message, or cancel it; inspect History.
5. Open History and acknowledge the failed delivery. The attention badge clears but the record remains. Expand technical details or schedule again.
6. Open Threads, inspect recency and the unknown state, and enable Show settled.
7. Open Settings and switch theme. In Quilla, inspect the rotating Support star, optional pulse, and Reduce motion. The centered label never rotates; the Ko-fi placeholder is disabled.
8. Use the top-right scenario selector to preview an empty queue or disconnected state. Resize the browser to assess narrower windows.

## Boundaries

This is a design prototype, not production scheduling/date infrastructure. Calendar is a representative October 2026 month; timezone display is fixed to the sample BST context. Full timezone/DST handling, persistence, delivery reconciliation, actual connection checking, and production accessibility/focus management belong to implementation. History confirms delivery, not completion of agent work.

## Verification performed

- `node --check design/mockups/app.js` passed.
- Browser inspected all four designs visually, plus Quilla Bone Outline and the support card.
- Created a mock schedule and observed the queue count and detail update.
- Acknowledged the example failure and verified the badge cleared while the record remained.
- Verified newest-first history sorting, including after creating a schedule.
- Checked compact in-window composition, recent thread selection, unknown-state visibility, and the Show settled toggle.
- Inspected at 640px width for readable rows, navigation and long-title handling.
- Verified the star's computed rotation is 9 seconds; label has no animation; Reduce motion disables rotation.
- Checked empty and offline scenarios and theme switching.

Fourth-direction verification: created a message using Tomorrow, confirmed it returned to Upcoming with an updated count, and inspected empty/offline states. The fixed sample clock applies to all four directions.

## Feature prototypes 05-08 (issue #6)

These explore how the planned features fit into Paper / Focus: several agents (#2), auto-start with turn limits and continuous mode (#3), phone control (#4) and keep-awake (#5).
They were built after a hands-on review of the shipped app; see [the UI review](../../docs/ui-review.md) for findings, the evaluation of the Fable pass and the decisions to approve.

- **05 Board** (`?concept=board`, recommended): tasks grouped by Needs you, Running, Waiting and Done, with a keep-awake session card, agent status strip, grouped thread picker, the two-question composer and plan sentence, Agents with capability tables, History and Settings for keep-awake and phone access.
- **06 Queue+** (`?concept=queue`): the alternative that keeps today's time-ordered Upcoming list and adds the same features, with Needs you as a notice.
- **07 Phone** (`?concept=phone`): the trimmed board served on the private network, with Mac receipts and an unreachable state.
- **08 Menu bar** (`?concept=tray`): tray icon states and menu.

The dark studio bar at the top holds prototype-only controls for each open design choice.
Options marked "rec." are the recommendation.
The following URL parameters select reproducible prototype states (`scenario`, `words`, `awake`, `composer`, `picker`, `theme`, `view`, `task`, `agent`, `when`, `far`, `turns`, `max`, `stops`, `pairing`, `add`), so these states can be linked directly.
Scenarios cover a busy evening, something going wrong (a missed start while the Mac slept, an agent not running, a desktop agent that needs the screen), the next morning's report and an empty board.

The feature prototypes use a **fixed sample clock of 2026-09-30 22:40 BST** instead of 14:00, because these features are about work that runs overnight.
They load `features.css`, a self-contained copy of the production tokens with the review's contrast and alignment fixes applied, instead of `style.css`.
Agent names, capabilities and availability sources are illustrative; each integration's real capabilities must be verified before implementation.

`fable-pass/` holds the independent concept sketches and written suggestions from a Fable 5.1 design pass, kept for reference and credit.
Ideas adopted from it are credited in the review.

### Screenshots

`screenshots/` holds full-page captures of 05-08 in light and Bone Outline themes at 1180, 620 and 420 pixels wide, plus the Phone stage at 1000 pixels wide.
Regenerate them from the repository root with `env -u ELECTRON_RUN_AS_NODE npx electron design/mockups/capture.cjs`.
Committed copies were reduced to 256 colours to keep the repository small.
Electron cannot start while the Mac's screen is locked; headless Chrome renders the same pages at the same widths and was used for the current copies.

### Browser interaction checks

Run `CHROME_BIN=/path/to/chrome node design/mockups/browser-smoke.cjs ./prototype-evidence` from the repository root with Node.js 22 and Chrome installed.
The output directory argument is required; screenshots and an interaction transcript are written there.
This standalone browser check is run explicitly, separately from `npm test`, which discovers the Node.js unit tests without requiring Chrome or an evidence directory.
