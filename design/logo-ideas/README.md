# Logo ideas

Draft logo concepts for Agent Auto-Continue.
They follow the Paper Focus language already in the app: bone paper, 2px ink outlines, hard offset shadows, lavender accent and the Support star shape.

Regenerate everything with `node design/logo-ideas/generate.js` from the repository root.
Render `contact-sheet.html` in a browser to compare the concepts side by side.

| Concept | Idea | Menu bar variant |
| --- | --- | --- |
| A. Later Play | A clock ring whose face is a play triangle: continue, but later | Yes |
| B. Ellipsis Arrow | A trailing-off thread picked back up by a play head | Yes |
| C. Spoke Star | The Settings star shape in lavender, with a play head cut out | Yes |
| D. Thread Loop | A return arrow landing on a play head | Yes |
| E. Page and Clock | A thread page with a scheduled time badge | No |
| F. Pause to Play | Pause bars handing off to a play head | Yes |

The `-tray.svg` files are 18px monochrome drafts intended as macOS template images.
The wordmarks use Fraunces when installed and fall back to Georgia.

## Round 3 and round 4: the painted crescent

Round 3 (`round3/`) tried seven play marks on a crescent cut from a real painting.
Option A, a gold-leaf play head on a rounded square of night sky with a thin gilt rim, was chosen.
Its moon came from an auction house photograph that cannot be published, so its outputs are not committed.

Round 4 (`round4/`) rebuilds option A on the crescent from Albrecht Altdorfer's *The Battle of Alexander at Issus* (1529), a public domain scan.
Its sky and moon are regraded to green by default (`--tone blue` keeps Altdorfer's own colour); the gilt rim and play head are unchanged.
Its `icon-1024.png` is the master copied to `assets/icon.png`.
Regenerate it with `python design/logo-ideas/round4/generate.py` (Pillow, numpy, scipy and scikit-image) after placing the scan in `design/sources/`, then run `npm run icons`.
See [the design document](../../docs/design.md) for how the logo is used.
