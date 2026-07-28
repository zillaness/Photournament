---
file: ui_redesign_prompt_v1.0.md
version: 1.0
author: Samuel Cao
created: 2026-07-28
last_updated: 2026-07-28
description: A self-contained brief for a design pass over the Photournament UI, written to be pasted into a fresh Claude conversation alongside the screenshots in docs/screens/.
ai_update: Update last_updated and version. Rename file to match. Append changelog at bottom.
---

# UI design pass — Photournament

Everything below the line is the prompt. Paste it into a fresh conversation and
attach the PNGs from `docs/screens/`.

---

I need a visual and layout redesign of a working web app. It functions correctly;
it just looks and feels unfinished. I am attaching screenshots of every screen.

## What the app is

**Photournament** is a local, single-file HTML tool for culling photographs. You
point it at a folder of a few hundred photos and it narrows them to a small set of
keepers in two phases:

1. **Grid passes.** A page of 9 photos at a time. You may keep at most a fixed
   number per screen — a quota you commit to *before* the pass starts and cannot
   raise mid-pass. Everything you don't keep is cut. Repeat until the field is small.
2. **A bracket.** Surviving photos go head to head, two at a time, until ranked.

The user is one person, alone, making several hundred fast aesthetic judgements in
a sitting. Speed and low friction matter far more than discoverability. They will
learn the interface once and then use it hard.

## The one design rule that cannot be broken

**The interface must never influence the judgement being made about a photograph.**

Every surface adjacent to a photo is a neutral grey with no colour cast — a warm or
cool surround visibly changes how an image reads, and the entire purpose of the app
is comparing images fairly. There is exactly one accent colour, deliberately
desaturated so it never competes with photographic content for attention.

Keep this. You may change the greys, the spacing, the type and the layout freely.
Do not introduce colour near photo content, gradients behind images, coloured
shadows on thumbnails, or a saturated accent.

## Hard technical constraints

- **Vanilla CSS only.** No Tailwind, no framework, no preprocessor, no build step,
  no CSS-in-JS. Plain `.css` that a browser parses directly.
- **No external resources of any kind.** The app ships as one HTML file that people
  open by double-clicking, from a `file://` origin where every network request is
  blocked. That means: no web fonts, no icon fonts, no CDN, no SVG files, no image
  files. System font stack only. Any icon must be a text glyph, a Unicode
  character, or CSS-drawn.
- **Chromium only.** Modern CSS is fair game — grid, `:has()`, container queries,
  custom properties, `color-mix()`. No vendor-prefix or legacy fallbacks needed.
- **Dark only.** No light mode.
- **Desktop first.** This is a two-monitor, mouse-and-keyboard task. A phone
  layout is not required; don't spend effort there.

## What I want back

**One stylesheet**, complete and self-contained, that I can drop in to replace the
current styles. Not a patch, not a diff — the whole file.

Alongside it, **a short list of markup changes** you'd want, if any: "the tree row
should be a `<label>` wrapping the input", "these two divs should swap order". I'll
make those changes myself. Describe them in words; don't rewrite my JavaScript.

Please also keep the CSS custom properties at the top as a design-token block, the
way the current file does, so values stay tunable in one place.

## The screens, and what is wrong with each

### 1. Entry (`01_entry.png`)
A drop zone and a "Choose a folder" button. Functional, plain. It is the first
impression and currently looks like a debug page.

### 2. Ingest progress (`02_ingest.png`, `03_ingest_done.png`)
A progress bar, a running count, a time estimate, and a summary of what was found
("601 JPEG · 137 HEIC · 175 video files skipped"). This screen is on display for a
minute or two while several hundred photos decode, so it can afford to be calm and
a little bit interesting to look at. Right now it is a thin bar and some grey text.

### 3. Folder tree (`04_tree.png`) — **the worst screen, please prioritise**
The user assigns each folder a number: how many photos survive from it. Problems:

- The number input sits at the far right, separated from its folder name by a huge
  empty gap. Associating a row with its field takes real effort.
- The folder hierarchy is indented so subtly it barely reads as a tree.
- `FIXED` and `POOLED` state labels shout in uppercase while carrying the least
  important information on the row.
- The `split` action is nearly invisible, and the `∞` button is cryptic.
- Two lines of dense help text sit above the table.
- On a wide screen the content stretches full width, so the eye travels a long way
  between the folder name and its number, and two-thirds of the page is empty.

The row's job is: **folder name → how many photos it has → how many you keep.**
That relationship should be immediate. There is also a live total at the bottom and
a validation area where errors appear ("Children are fixed at 28, which is more
than this folder's 20").

### 4. Grid pass configuration (`05_grid_config.png`)
Three settings — grid size, quota, shuffle — then a big start button. Once the pass
begins these lock, and there is a badge saying so. The lock is a real feature, not a
limitation: the whole tool rests on committing to a cut before you see the photos.
It currently reads as a disabled form. It should read as a deliberate commitment.

### 5. Grid pass (`06_grid_pass.png`, `07_grid_over_quota.png`) — **the hot path**
Nine photos, click to keep, `Enter` to advance, number keys to select by position.
This screen gets used more than all the others combined.

- Photos should be as large as possible. Chrome should shrink toward nothing.
- The kept/not-kept state must be unmistakable at a glance and from peripheral
  vision, **without a colour cast falling on the image itself**.
- `07_grid_over_quota.png` shows the state where the user has selected more than the
  quota: the advance button disables and relabels to "keep at most 4". That refusal
  should be legible instantly and shouldn't feel like an error or a scolding.
- Counters live in the top bar: photos remaining, screens left, field size vs
  target, percent cut this pass. Four numbers, currently undifferentiated.

### 6. Bracket matchup (`08_bracket_matchup.png`)
Two photos side by side, as large as the viewport allows. Click or arrow-key to
choose. There is a small toolbar: "too close to call", undo, zoom out, zoom in,
fit, 1:1. Both images zoom together to the same region.

The two photos are the entire interface here. Everything else should be nearly
invisible until wanted. The hover state on each side needs to make "this one wins"
obvious without tinting the photograph.

### 7. Duplicates (`09_duplicates.png`)
Photos that look near-identical are grouped, and the user picks which to keep — one
usually, sometimes several when the grouping was wrong. Each group is a header row
with the current keeper, expandable into a grid of the whole group. Currently a
somewhat undifferentiated stack of rows.

### 8. Export review (`11_export.png`)
Every finalist listed with rank, thumbnail, original filename, a free-text label
field, and the resulting destination filename in monospace. The label becomes part
of the filename, so the connection between what you type and what gets written
should be obvious and satisfying. Then a row of output buttons.

## Things to leave alone

- **All behaviour, text content and wording.** Style only.
- **Element IDs.** JavaScript queries these: `#topbar`, `#topbar-context`,
  `#topbar-counters`, `#topbar-stop`, `#screen`, `#modal`, `#modal-body`,
  `#toasts`, `#dropzone`, `#tree-host`, `#tree-issues`, `#tree-footer`,
  `#ingest-summary`, `#ingest-actions`, `#exp-total`, `#exp-status`, and the
  `#bk-*` and `#ro-*` toolbar buttons.
- **Class names**, unless you list the rename explicitly in your markup notes.
  The ones that carry state and must keep working:
  `.photo-cell` / `.photo-cell.kept` (a kept photo in a grid),
  `.tree-row` / `.excluded` / `.has-error`,
  `.btn` and its variants `.btn-primary .btn-quiet .btn-danger .btn-sm`,
  `.notice` and `.notice-error .notice-warn .notice-note`,
  `.bk-pane` / `.bk-vp` (bracket sides), `.ro-group` / `.ro-cell`,
  `.exp-row` / `.exp-dest`, `.grid` with `.grid-6 .grid-9 .grid-12 .grid-16`.

## One note on where the CSS currently lives

Styles are presently spread across two `.css` files and four `<style>` blocks
injected by JavaScript — six places. Don't try to preserve that structure. Give me
one stylesheet covering everything; consolidating it is my job, not yours.

If it helps to see the current values, the existing token block defines:
`--bg #0d0d0e`, `--surface #171719`, `--surface-2 #202023`, `--line #2e2e32`,
`--text #e8e8ea`, `--text-dim #9a9aa2`, `--text-mute #6b6b73`, `--accent #5b8dd6`.

Start with the folder tree and the grid pass. Those two carry the product.

## CHANGELOG
- v1.0 (2026-07-28): Initial release.
