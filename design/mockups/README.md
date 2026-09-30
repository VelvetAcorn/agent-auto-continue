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

All prototypes use the same fictional sample data and **fixed sample clock of 2026-09-30 14:00 BST**. Date validation and quick shortcuts deliberately use that clock so every direction remains comparable. Nothing connects to Electron or the real scheduler. Changes last only until reload. Google Fonts supplies Fraunces and Inter; serif/system fallbacks work without a network connection.

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
