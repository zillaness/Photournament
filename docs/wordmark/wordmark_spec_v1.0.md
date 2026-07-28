---
file: wordmark_spec_v1.0.md
version: 1.0
author: Samuel Cao
created: 2026-07-28
last_updated: 2026-07-28
description: Construction, sizing, colour and usage spec for the Photournament wordmark. Ships alongside the SVG exports and wordmark.css in the same folder.
ai_update: Update last_updated and version. Rename file to match. Append changelog at bottom.
---

# Photournament wordmark

## The idea

PHOTO and TOURNAMENT share exactly two letters. Set the word once and it contains
both:

    P H O T O U R N A M E N T
    └── PHOTO ──┘
          └──── TOURNAMENT ────┘

The mark draws that. An accent rail runs under PHOTO, a neutral rail runs under
TOURNAMENT, and they sit at different depths so the shared **TO** is the only
stretch of the word with a rail above *and* below it. Nothing is coloured, boxed
or weighted differently — the overlap is shown by geometry, which is why the mark
survives being printed in one colour.

## Construction

Three cells, two rails, one grid.

| Cell | Letters | Rail |
| --- | --- | --- |
| 1 | PHO | upper rail starts here |
| 2 | TO | both rails present |
| 3 | URNAMENT | lower rail ends here |

The upper rail spans cells 1–2. The lower rail spans cells 2–3. Because the rails
span *grid columns* rather than measured offsets, the geometry is correct on any
platform regardless of which font the stack resolves to.

## Metrics

Every value below is per **100 units of font size**. Multiply by
`font-size / 100`.

| | Canonical | Display |
| --- | --- | --- |
| Tracking | 9 (0.09em) | 4 (0.04em) |
| Rail thickness | 9 (0.09em), floored at 2px | same |
| Word → upper rail | 7.5 (0.075em) | same |
| Upper → lower rail | 6 (0.06em) | same |
| Cap height | 71 | 71 |
| Full width | 1017.03 | 962.03 |
| Full height, cap top to lower rail | 127.5 | 127.5 |
| Upper rail | x 0, w 389.59 | x 0, w 364.59 |
| Lower rail | x 240.87, w 776.16 | x 225.87, w 736.16 |

Rail thickness is matched to the letter stems on purpose, so the rails read as
drawn by the same tool as the type. The 2px floor is what keeps them from
dissolving in the topbar.

**Known and accepted:** a single em-based gap cannot be optically right across
the whole range. Tuned for 14px, it reads very slightly loose at 100px. It is
tuned for 14px because that is where the mark actually lives. If a large lockup
ever needs it tightened, override the upper rail's `margin-top` at that one call
site — do not change the spec.

## Sizes

| Use | Size | Variant |
| --- | --- | --- |
| App topbar | 14px | canonical |
| Entry screen lockup | 64px | display |
| README / slide title | 40–120px | display |
| Favicon, sticker, one-colour print | any | mono |

Below 14px the rails collide with the letterforms and the mark stops resolving —
set the word plain instead. There is no icon-only lockup; **TO** on its own is
not the mark.

## Colour

Achromatic everywhere except the one accent rail. This is the same rule the app
runs on: nothing that sits near a photograph may carry a colour cast.

| Role | Dark surrounds | Light surrounds |
| --- | --- | --- |
| Type | `#efefef` | `#1f1f1f` |
| Upper rail (accent) | `#759cc2` | `#466c90` |
| Lower rail (neutral) | `#777777` | `#767676` |

Source tokens, if you are working inside the app: `--text-dim` for the type,
`--accent` for the upper rail, `--text-mute` for the lower rail. They invert with
the theme on their own.

Do not use a saturated accent, a gradient, or a second hue. If only one colour is
available, use the mono variant — the geometry carries the idea without it.

## Type

System stack, no web font, by requirement — the app opens from a `file://` origin
where no network request succeeds.

    ui-sans-serif, system-ui, -apple-system, "Segoe UI",
    "Helvetica Neue", Helvetica, Arial, sans-serif

Weight **650**, uppercase. On macOS this resolves to SF Pro, on Windows to Segoe
UI, on Linux typically to a Helvetica clone. All three have a cap height near
0.71em, which is why the metrics table holds across platforms.

The SVGs carry **live text**, not outlines, and were generated against
Helvetica/Arial metrics. On a machine without that stack the glyphs will shift
slightly inside the rails. For anything going to print or to a third party,
open the SVG in a vector editor and convert the text to outlines first.

## Files

| File | Use |
| --- | --- |
| `photournament-wordmark-dark.svg` | canonical, for dark surrounds |
| `photournament-wordmark-light.svg` | canonical, for light surrounds |
| `photournament-wordmark-display-dark.svg` | tighter tracking, above ~40px |
| `photournament-wordmark-display-light.svg` | tighter tracking, above ~40px |
| `photournament-wordmark-mono.svg` | one colour, inherits `currentColor` |
| `wordmark.css` | the live HTML/CSS version — **the source of truth for the app** |
| `wordmark-preview.html` | every variant at every size, both themes |

## Don'ts

- Don't split the word anywhere but `PHO` / `TO` / `URNAMENT`. The grid columns
  encode which letters belong to which word; a different split silently moves
  both rails.
- Don't set the rails to the same depth. They overlap under TO and the upper one
  disappears.
- Don't add a third rail, a box, a border or a shadow.
- Don't set it in mixed case or in a display face. Uppercase, system stack, 650.
- Don't place the mark on a photograph. It belongs on chrome.

CHANGELOG
v1.0 (2026-07-28): Initial release. Canonical, display and mono variants, with
  measured metrics per 100 units of font size.
