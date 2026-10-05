# Design

This is the visual language of Agent Auto-Continue.
It covers the app as it ships, and it is the reference for the website and anything else made for the project.
The source of truth for values is `styles.css`; if this document and the stylesheet disagree, the stylesheet wins and this document should be corrected.

## The idea

The app is a small old painting that happens to have controls on it.
It keeps agents working through the night, so its two subjects are the moon and the sun.
Night shows a painted full moon over dark trees and still water.
Day shows a painted solar eclipse over a classical city.
The controls keep the plain, sturdy shapes they always had, and take a gilt rim in place of an ink outline.

Three rules follow from that.

- **Real paint only.** The moon, the sun and the sky are photographs of real 16th and 17th century paintings, never drawings or generated images.
- **The painting is a backdrop, not a banner.** It lies behind the whole surface at low strength and the controls sit straight on it.
- **Ornament frames, it does not decorate.** Gilt appears on edges, rules and corners. Nothing is ornamented for its own sake.

## Themes

| | Day (default) | Night |
|---|---|---|
| Body class | none | `dark` |
| Painting | Caron's eclipse | Elsheimer's moon |
| Ground | warm plaster | near-black umber |
| Feel | fresco, daylight, matte | oil on copper, moonlight |

Day is the default for anyone who has not chosen.
The user can choose Day, Night or follow the system.
The switch is three pictures with no visible words: a sun, a crescent and a half disc.
Each picture still carries a tooltip and a screen-reader label.

## Paintings

Both backdrops are public domain works with openly licensed photographs.
Credits ship with the app in `assets/art/CREDITS.md`.

| File | Work | Holder | Image licence |
|---|---|---|---|
| `assets/art/day.webp` | Antoine Caron, *Dionysius the Areopagite Converting the Pagan Philosophers*, 1570s | J. Paul Getty Museum, 85.PB.117 | CC0, Getty Open Content |
| `assets/art/night.webp` | Adam Elsheimer, *The Flight into Egypt* (detail of the moon and its reflection), 1609 | Alte Pinakothek, Munich, inv. 216 | Public domain scan, Yorck Project via Wikimedia Commons |
| App icon moon | Albrecht Altdorfer, *The Battle of Alexander at Issus* (detail of the crescent), 1529 | Alte Pinakothek, Munich, inv. 688 | Public domain scan, Google Art Project via Wikimedia Commons |

The full-size scans live in `design/sources/`, which is not committed because the files are large.

### Choosing a painting

Use these tests before adding or replacing a painting, in the app or on the website.

- It was painted between about 1450 and 1800.
- It contains a moon, a sun or an eclipse that the painter actually painted.
- The work is public domain and the photograph has an open licence (CC0, a museum open-access programme, or a public domain mark on Wikimedia Commons).
- The holder is named in the credits, with the accession number.

Do not use auction house, dealer or stock photographs, even of public domain works.
Do not use photographs from institutions that claim rights over reproductions unless the licence is checked and recorded.
Good open sources are the Getty, the National Gallery of Art in Washington, the Metropolitan Museum, the Rijksmuseum and Wikimedia Commons.

### How the painting is shown

- It covers the whole surface, fixed in place, and content scrolls over it.
- Its strength is the `--art` variable, 30% by default.
- The user can set it from 0% to 60% in Settings, Appearance. Above 60% text over the painting stops being readable.
- Night multiplies the strength by 1.7 (`--art-gain`), because the night painting is itself dark.
- A linen weave lies over everything, controls included. It is a pre-rendered tile, `assets/art/weave.webp`, built by `npm run icons`.
- Position is set per layout with `--art-x`, `--art-y` and `--art-size`, so the moon or the eclipse lands in open space rather than under a control.

On the website the painting can be shown at full strength where there is no text over it, such as a hero image.
Wherever text sits on it, keep to the same 30% to 60% range or put the text on a solid ground.

## Colour

Colours are named for what they are in a painting.
Use the token names in code and the plain names in conversation.

| Token | Day | Night | Plain name |
|---|---|---|---|
| `--bg` | `#EFE7D6` | `#141312` | Ground: plaster by day, umber by night |
| `--surface` | `#FBF6EA` | `#24201D` | Control fill |
| `--raised` | `#F1E8D3` | `#302A25` | Field fill, hover |
| `--ink` | `#2C2118` | `#F0E7D3` | Text: umber by day, lead white by night |
| `--muted` | `#5F5142` | `#C2B59D` | Secondary text |
| `--accent` | `#27466E` | `#DDBD78` | Links: Prussian blue by day, pale gold by night |
| `--selected` | `#BCD0DE` | `#27405F` | Chosen option: sky blue by day, Prussian blue by night |
| `--green` | `#44664C` | `#8FB394` | Success |
| `--amber` | `#96481A` | `#E39A5C` | Warning |
| `--red` | `#A4371C` | `#DE876C` | Failure: vermilion |
| `--outline` | `#8A6A2A` | `#B08A3C` | Solid gilt line |
| `--shadow` | `#4A3523` | `#070403` | Hard offset shadow |
| `--gilt-a` | `#C9A652` | `#F3DFA0` | Gilt highlight |
| `--gilt-b` | `#8A6A2A` | `#B08A3C` | Gilt body |
| `--gilt-c` | `#6A4C1C` | `#7D5D24` | Gilt shadow |
| `--line` | umber at 30% | gilt at 22% | Hairline between rows |
| `--veil` | plaster at 50% | umber at 42% | Wash that quiets the painting behind a panel |

Gilt is always the three-stop gradient `--gilt`, running corner to corner, never a flat yellow.
The primary button is the one place gold is used as a fill: `#F3DFA0` to `#D3AC5A` to `#A9812F`, top to bottom, with `#2A1B0A` text in both themes.

Warning amber sits close to gilt.
Never rely on amber alone to mark a warning; pair it with a dot, an icon or a word.

## Type

Three open-licence typefaces ship with the app in `assets/fonts/`, each with its licence text.

| Face | Used for | Notes |
|---|---|---|
| Cormorant Garamond, bold italic | The name, view titles, the Continue button, empty-state headings | The voice of the app. Use it sparingly and large. |
| EB Garamond | All body text and controls | Base size 14 px. It runs small, so never go below 12.5 px. |
| Cinzel, semibold capitals | Section labels and status pills | 10 px with 1.6 px letter spacing, always uppercase, always short. |

Sizes in use: 25 px and 19 px headings, 15 px picker title, 14 px body, 13 px chips and fields, 12.5 px secondary text, 10 px labels, 8.5 px pills.
The plan sentence under the Continue button is italic.
On the website, scale headings up freely but keep the same three roles.
Fallbacks are Georgia and Times New Roman.

## Shape and ornament

- **Controls** keep the Paper / Focus shapes: 9 px corner radius, a 1.5 px rim, and a hard 2 px offset shadow with no blur. Buttons lift one pixel on hover and press flat when clicked.
- **The rim** is the gilt gradient, drawn as a border around a solid fill.
- **The frame** is a single gilt hairline inset 4 px from the edge of the content, with a rocaille corner at each of its four corners (`#o-corner` in `renderer/icons.js`).
- **The rule** between the compose block and the queue is two hairlines fading outward from a small diamond between two scrolls (`#o-rule`).
- **Rows** in the queue and settings have no fill; they sit on the painting, separated by hairlines, and take the veil on hover.
- **The header** is the ground colour, almost opaque, with a gilt line beneath.
- **No blend modes or backdrop blur.** Both make the whole window repaint on every animation frame, which is slow on machines without a GPU.

Do not add drop shadows with blur, glows, gradients other than gilt, or rounded pill buttons.
Do not put ornament inside controls.

## Logo

The logo is a painted crescent moon holding a gold-leaf play head.
The crescent sits on the left and opens to the right, and the play head sits in its hollow.
The moon is cut from Altdorfer's 1529 painting; the play head and the thin gilt rim are drawn.
The outer shape is the macOS rounded square filled with the painting's own night sky.
The moon and sky are regraded from Altdorfer's Prussian blue to a deep green with a pale green-white crescent: each pixel's lightness is mapped onto a green ramp, so the brushwork is kept and only the hue changes.
The gold of the play head and rim is not regraded.

| File | What it is |
|---|---|
| `assets/icon.png` | The 1024 px master |
| `assets/icon.icns` | The packaged app icon, generated by `npm run icons` |
| `assets/logo.webp` | The small mark beside the name in the app header |
| `assets/trayTemplate.svg` | The menu bar glyph: the same crescent and play head in one colour |
| `design/logo-ideas/round4/` | The script that cuts the moon and builds the master |

Rules for using it:

- Keep the crescent on the left. Never mirror or rotate it.
- Do not recolour the moon beyond the green grade above, or redraw it as a flat shape, except for the one-colour menu bar glyph.
- Leave clear space around it equal to a quarter of its width.
- Below 32 px, prefer the one-colour glyph.
- Beside the name, set the name in Cormorant Garamond bold italic.

## Layout

There is one screen in two layouts.
The rail is a 380 px wide menu bar popover that grows with its content.
The window puts the compose block in a 360 px column on the left, under a veil, with the queue filling the rest over the open painting.
In both, the order is: who (the conversation), when, how far, the message, then the Continue button and one sentence saying exactly what will happen.

## Motion

Motion is small and physical: a button lifts and presses, a row's actions fade in.
The paintings never move.
Reduced motion is respected from the system setting and from Settings, and turns every transition off.

## Voice

Labels are short and plain: "When", "How far", "Message", "Continue".
The period feel comes from type, paint and gilt, never from wording.
Do not write in an antique or theatrical voice.

## For the website

- Lead with the painting at full strength and the name in Cormorant Garamond bold italic.
- Use Day as the default look, with Night as the alternate.
- Use the same tokens, the same three typefaces and the same gilt rim on buttons.
- Show the app in real screenshots over the plaster or umber ground, inside the gilt hairline frame.
- Credit every painting on the page where it appears, with artist, title, date, holder and licence.
- Keep one primary gold button per view.

## Changing things

- Colours, type and shapes: edit `styles.css`, then update the tables here.
- Backdrops: replace the files in `assets/art/`, update `CREDITS.md` and the table above, and adjust `--art-x`, `--art-y` and `--art-size` so the moon or sun clears the controls in both layouts.
- Icon: edit the master and run `npm run icons` on macOS, then commit the regenerated files.
- Disk image background: edit `tools/build-dmg-background.cjs` and run `npm run dmg-background`.
- After any visual change, run `npm run test:electron` and look at the screenshots it saves when `T3_SMOKE_EVIDENCE_DIR` is set.
