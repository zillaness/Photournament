---
file: markup_notes_v1.1.md
version: 1.1
author: Samuel Cao
created: 2026-07-28
last_updated: 2026-07-28
description: The JS and markup changes `photournament_ui_v2.1.css` expects, described in words. Companion to the stylesheet; no JavaScript is rewritten here.
ai_update: Update last_updated and version. Rename file to match. Append changelog at bottom.
---

# Markup notes for photournament_ui_v2.1.css

Ten changes. Two are required, eight are improvements the stylesheet is already
written for and degrades gracefully without. Nothing here touches behaviour,
wording, element ids, or any of the state-carrying class names.

---

## Required

### 1. Delete the six old style sources

`src/css/00_base.css`, `src/css/10_screens.css`, and the `injectStyle()`
functions plus their `STYLE_ID` constants in `50_screen_tree.js`,
`60_screen_grid.js`, `70_screen_bracket.js` and `80_screen_export.js`. Remove the
four `injectStyle()` call sites too. Load `photournament_ui_v2.1.css` in the
`<!--BUILD:CSS-->` block instead.

Every selector those blocks defined is in the new file. It is written under `#app`
specifically so that a stray injected block cannot win by document order if one
survives the consolidation — but leaving them in means two definitions of the same
component, so take them out.

### 2. `50_screen_tree.js` — the folder-tree row order

In `rowFor()`, the row's children are currently

    name, count, state, input, ∞, [split]

and they need to be

    name, count, input, ∞, bar, state, [split]

That is the whole point of the tree redesign: the row reads as the sentence the
screen is asking — *Trip has 36, keep 8* — with those three adjacent instead of at
opposite ends of a full-width table. The proportion bar and the resolved state
word follow the decision rather than separating the field from its folder.

`headerRow()` needs the matching order: name, count, alloc, then four empty
`<span>` placeholders so the header aligns with the rows beneath it.

---

## Improvements

### 3. `50_screen_tree.js` — depth as a custom property

Replace the inline `style: 'padding-left:' + depth * 16 + 'px'` on `.tree-name`
with `style: '--d:' + depth` on the `.tree-row` itself. CSS then owns both the
indent and the new hierarchy rails — one hairline per level, drawn with a
repeating gradient — which is what makes the tree read as a tree. Without this
the rows still lay out correctly, just with no rails and no indent.

### 4. `50_screen_tree.js` — the keep:has proportion bar

Add one element to each row, between the `∞` button and the state word:

    el('span', { class: 'tree-bar', style: '--p:' + p }, [el('i')])

where `p` is `node.target / node.subtreeCount` clamped to 0–1, or `1` for an
uncapped folder. It is the fastest read on the screen for *how brutal is this
cut*, and it is away from photo content so the accent is safe there. If the
element is absent nothing breaks; the column is simply empty.

### 5. `50_screen_tree.js` — wrap the row in a `<label>`

Make `.tree-row` a `<label>` rather than a `<div>` so clicking anywhere on the row
— the folder name especially — focuses that row's keep field. This is the change
you suggested yourself and it is the single biggest reduction in effort on the
screen. The header row stays a `<div>`.

### 6. `50_screen_tree.js` — the help text

The two dense lines above the table become one line plus a disclosure:

    <div class="tree-help">The number is how many photos <b>survive</b> … </div>
    <details class="tree-help">
      <summary>Blank, zero and no-limit</summary>
      <div>Use <b>0</b> to skip … whatever its parent has left over.</div>
    </details>

Same words, same order, none of them deleted. The stylesheet gives `details` a
caret and quiet summary styling. Also add `class="screen-tree"` to the tree
screen's root element so it picks up the measure constraint.

### 7. `40_screen_ingest.js` — split the count from its time estimate

`detail.textContent = done + ' / ' + total + note` puts a display-size number and
a small grey estimate in the same node. Split it:

    el('div', { class: 'ingest-count nums' })   // "247 / 746"
    el('div', { class: 'small dim' })           // "~1m 20s left"

and give the ingest screen root `class="screen-ingest"`. There is a fallback rule
for the combined node, so if you skip this the count just renders at 21px instead
of 44px.

### 8. `80_screen_export.js` — mark the typed part of the filename

In the `refresh()` closure, instead of setting `dest.textContent`, build three
children: the ordered prefix, `<span class="exp-slug">` holding
`slugLabel(labelInput.value) + '_'`, and the original filename. The stylesheet
brightens `.exp-slug` and turns it accent on focus, so what you type visibly
becomes part of what gets written. Without it the destination still renders — just
uniformly grey.

### 9. `40_screen_ingest.js` — the nine-square mark

Two decorative elements, both CSS-drawn, no image and no SVG:

    // entry screen, above the h1
    el('div', { class: 'pt-mark' }, nine el('i') children)

    // ingest screen, beside the count
    el('div', { class: 'pt-mark pt-mark-live' }, nine el('i') children)

Nine cells with one marked — the product in one glyph. The `pt-mark-live` variant
walks the cells on a keyframe loop as the ingest activity indicator, monochrome
and small, and stops entirely under `prefers-reduced-motion`. Purely additive.

### 10. The theme switch

Two states. The only JS is setting one attribute on the root element:

    document.documentElement.dataset.theme = 'dark' | 'light';

- **absent or `dark`** — dark. The default; nothing to do if you never add a switch.
- **`light`** — the light theme.

Deliberate toggle only. There is no auto mode and no `prefers-color-scheme`
query: which surround suits depends on the light in the room the culling is
happening in, and the OS setting does not know that.

Persist the choice in `localStorage` alongside the other prefs and apply it before
first paint (an inline `<script>` in `<head>`, or the existing prefs load if it runs
early enough) so there is no flash of the wrong theme.

Where to put the control: the topbar right cluster, before `#topbar-stop`, with
id `#topbar-theme` — the stylesheet styles it already, including a glyph drawn
from the two colours it is choosing between (the well and the mount). Put the same
button on the entry screen, since the topbar is hidden there. Label it with the
theme it switches *to*, and put the shortcut in the `title` attribute rather than
an inline `<kbd>` — permanent room in the topbar is expensive.

Bind a key to it, and make it global rather than per-screen. The reason to switch
is never "I prefer light mode" — it is "does this photograph read differently
against the other surround", asked mid-judgement about one specific image. If the
user has to leave the keyboard and find a button, they will stop asking. `T` is
free in every screen's handler (the grid pass uses `0`–`9`, `Enter`, `U` and `←`;
the bracket uses the arrows, `D` and `U`). Nothing in the stylesheet transitions
colour, so the repaint is immediate and the two states can be flipped between as
fast as the key repeats.

**One thing worth not "fixing" about the light theme:** it is deliberately not a
white theme. The page is a light neutral grey and the well photographs sit on is
L\* 50 mid-grey, which is what ISO 3664 specifies for a viewing surround. A white
surround makes an image read darker, flatter and lower in contrast than the same
image against mid-grey — exactly the interference the app's one unbreakable rule
exists to prevent. If white ever looks more finished: it does, and it is also
wrong for the task.

---

## Left alone, as asked

All behaviour, all wording, all element ids (`#topbar`, `#topbar-context`,
`#topbar-counters`, `#topbar-stop`, `#screen`, `#modal`, `#modal-body`, `#toasts`,
`#dropzone`, `#tree-host`, `#tree-issues`, `#tree-footer`, `#ingest-summary`,
`#ingest-actions`, `#exp-total`, `#exp-status`, `#bk-*`, `#ro-*`), and every
state-carrying class: `.photo-cell` / `.kept`, `.tree-row` / `.excluded` /
`.has-error`, `.btn` and its four variants, `.notice` and its three levels,
`.bk-pane` / `.bk-vp`, `.ro-group` / `.ro-cell`, `.exp-row` / `.exp-dest`, and
`.grid` with `.grid-6 .grid-9 .grid-12 .grid-16`. No renames.

CHANGELOG
v1.1 (2026-07-28): Added note 10, the theme switch (dark default plus a light
  theme, deliberate toggle only), and repointed the stylesheet filename to v2.1.
v1.0 (2026-07-28): Initial release. Two required changes (delete the old style
  sources; reorder the tree row) and seven optional ones.
