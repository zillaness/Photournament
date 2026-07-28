---
file: handoff_v1.0.md
version: 1.0
author: Samuel Cao
created: 2026-07-28
last_updated: 2026-07-28
description: Cold-start handoff for Photournament — what is built, what is verified, what is still open, and what the PRD gets wrong.
ai_update: Update last_updated and version. Rename file to match. Append changelog at bottom.
---

# Photournament handoff

Everything below the line is a prompt. Paste it into a fresh session working in
this repository.

---

You are picking up **Photournament**, a local single-file HTML photo-culling tool.
It shipped as v1.0 and the whole spine runs end to end. Your job is
the open queue at the bottom.

## Orient yourself first

Read in this order:

1. `photournament_prd_v1.9.md` — the spec. Cite section numbers in commits.
2. `docs/handoff_v1.0.md` — this file.
3. `tools/probes/01_capability_matrix/FINDINGS.md` and
   `tools/probes/02_heic/FINDINGS.md` — **measured** facts about the runtime.
   Several are counter-intuitive and all of them constrain the design.
4. `docs/markup_notes_v1.0.md` — what the current stylesheet expects of the markup.

## How to work on it

```
npm install                 # libheif-js only
node tools/build.mjs        # -> dist/photournament_v1.0.html
npm test                    # unit + freshness + 2 smokes + 12 E2E runs, all must stay green
node tools/screenshots.mjs  # -> docs/screens/*.png, all ten screens
```

Source is `src/js/*.js`, loaded in numeric filename order and concatenated into one
HTML file. **Classic scripts only** — the build hard-fails on `import`/`export`.
Everything hangs off a `PT` global. Styling is one file, `src/css/photournament_ui_v2.0.css`.

Conventions: every file carries a metadata header and a changelog, and is version
bumped when changed (see the `revision-control` skill). Internal `src/` filenames
deliberately do **not** carry `_vX.Y` suffixes — only `dist/` and `docs/` do —
because renaming modules on every patch would churn the build order and git history.

## The constraints that are easy to violate by accident

All measured, not assumed. Breaking any of these produces something that works over
`localhost` and fails the moment a user double-clicks the file.

- **The app runs from a `file://` origin**, where `window.origin` is the opaque
  string `"null"`. `fetch`, `XHR`, `<script type=module src>` and
  `new Worker('./w.js')` are **all CORS-blocked**. OPFS is blocked. Classic
  `<script src>` is the only URL-based loading that survives.
- **Therefore: no external resources, ever.** No web fonts, no icon fonts, no CDN,
  no `.svg` or image files. Everything ships in the one HTML file.
- **Every worker must be built from a blob URL.** A sibling `worker.js` throws at
  construction.
- **IndexedDB works fine on `file://`** and survives a browser restart, so it
  carries all persistence. But every `file://` page in a Chrome profile shares one
  origin bucket (`file__0`), so the database name is namespaced.
- **The derivative cache is evictable.** `storage.persist()` returns false even on
  localhost. Decisions must survive an evicted cache; thumbnails are re-derivable.
- **libheif: reuse ONE `HeifDecoder` and `.free()` every returned handle.** Either
  alone leaks 6.35 MB per image, about 3.2 GB at 500 photos. This is the single
  most important line in `10_ingest_worker.js`.
- **Nothing adjacent to a photo may carry a colour cast.** A warm or cool surround
  changes how an image reads, and the product is comparing images fairly.

## What is built and verified

Ingest (picker, drag-drop, `webkitdirectory`, loose files) · format triage with
video and RAW counted-and-skipped · the PRD 4 allocation tree, all four states,
both directions, clamping and dead states · Stage A grid passes with a locked
quota, keyboard, undo, back-navigation and the low cull rate offer · cut pile
rescue with its own pre-committed limit · Stage B bracket with repechage · Stage C
duplicates with multi-keep · Stage D wired and off by default · export review with
intent labels, prefixes, folder naming, disk write with collision prompts, a
single-folder save, a hand-rolled zip and the decision JSON · persistence and
resume · the v2.0 UI.

Test suite: 22 unit tests on the allocation math, a dist-freshness guard, a module
smoke, an artifact smoke, and two E2E runs that drive the real UI in Chromium from
a `file://` URL.

## What is NOT built — the open queue

Ordered by value. Items 1 and 2 are the real gaps; the rest are smaller.

> **Status note (2026-07-28):** item 1 shipped (45_screen_dupes.js and the
> burst bundling that followed it), as did much of what sat below it. The
> queue is kept for its measured context; check the changelogs before
> starting anything listed here.

### 0. User feedback, tabled — not yet designed

- **"The initial culling rounds run long."** (Samuel, 2026-07-28, after a real
  742-photo run.) Deliberately parked, not acted on. Candidate directions when
  it is picked up: a tighter default quota for pass 1, larger grids for the
  first pass only, projecting how many passes the current quota implies before
  the pass starts, or letting Stage A hand over to the bracket earlier when the
  field is already near the target. Stop early (now shipped) softens this but
  does not shorten the rounds themselves.
- **King-of-the-hill sort.** (Samuel, 2026-07-28.) A different comparison mode:
  a champion holds the screen and challengers arrive one at a time — beat the
  champion to take its place. Parked by request. Fit to think through later:
  it is a natural alternative BRACKET mode (the engine's op log and positional
  match ids could support it as a third sub-bracket shape), and possibly a
  Stage A alternative for small pools; it trades the bracket's balanced-draw
  fairness for speed and a very legible mental model, so the second-chance
  round matters more, not less, if it lands.
- **Bracket standings: the action bar floats over the list.** (Samuel,
  2026-07-28, screenshot, real run: nerf_field_setup, stopped early at 16
  finalists.) On the stopped-early/complete standings screen, "Resume
  ranking", "Undo last comparison" and "Next: check for duplicates" render
  ON TOP of the standings rows, vertically mid-list — left buttons overlap
  rows 12–13, the Next button overlaps 12–14 on the right — instead of
  sitting in their own bar above or below the scroller. Cosmetic but
  disorienting, and clickable rows sit UNDER buttons. Likely the completion
  painter reuses S.bar, whose layout assumes the two-pane match view; the
  standings box (.bk-results) scrolls beneath it with no reserved space or
  background. Fix direction: give the done-state its own pinned bar (top or
  bottom) with a real background, and reserve its height in the scroller.
  Queued by request — not fixed in this pass.

### 1. Near-duplicate grouping review (PRD 7.7) — the largest gap

Grouping is computed at ingest and used silently. Everything PRD 7.7 promises
around it is missing: the **live sensitivity slider**, the scrollable review of
every group with all members, and **manual split, merge, remove and confirm**.

Today a wrong grouping only surfaces during Stage C, and the only recourse is the
multi-keep escape hatch. This screen would stop bad groups reaching the user at all.

`PT.phash` already provides everything needed: `cluster(items, {threshold, mode})`,
`hamming`, `nominate`. Two measured facts that must shape the UI:

- **pHash is a constant-weight code** — every hash has exactly 31 one-bits, so all
  distances are even. **The slider must step by 2.** Odd values are dead stops.
- Default threshold **14**, `strict` mode, measured at precision and recall 1.000
  over 7,381 labelled pairs. `strict` over-splits rather than over-merges, which is
  the failure mode a merge button can fix.

### 2. HEIC sidecars (PRD 8, PRD 12) — specified, never implemented

`sidecarLocation` and `exportHeicAs` exist as settings defaults in `35_session.js`
with **no implementation behind them**. Nothing writes a `_sidecars` folder and
export cannot choose HEIC versus JPEG.

Before building this, read the measurement: a full-size q0.90 JPEG sidecar came out
**11% larger than the HEIC it came from**. The PRD treats sidecars as a free speed
win; at 137 HEICs that is a few hundred MB of duplication. Consider generating them
only at export, for chosen finalists, rather than for everything at ingest.

### 3. New-photo detection on resume (PRD 7.10)

"New photos detected on resume, with a prompt to fold them in or start fresh." Not
implemented. Resume restores what was there; added files are invisible until a
fresh session. `PT.fingerprint` already gives stable identity to diff against.

### 4. A settings screen (PRD 12)

PRD 12 lists thirteen configurable settings. Grid size, quota and shuffle are
exposed in the pass configuration; prefixes and output structure in export. The
rest have no UI at all: low cull rate floor, duplicate threshold and mode, sidecar
location, Stage D target, top-down distribution mode.

### 5. Ranked thumbnail grid output (PRD 7.8)

"Ranked finalists as a thumbnail grid, grouped by source." Not built. Everything
needed is in the export screen already.

### 6. PRD amendments — the spec is wrong in four places

Findings that should land in a v1.9:

- **7.7's stated risk is wrong.** "Burst frames differing mainly in expression may
  not group" does not reproduce: max distance over 27 frames with only the face
  changing was **2 bits**. The real failure is **geometry** — a 5% crop sits at the
  threshold, and 5° rotation or a 20% crop do not group at all.
- **Section 3 undercounts.** "Roughly 500 photos" measured as **746 stills**, plus
  **175 video files** at 79% of the bytes. Video is out of scope per section 9 but
  must be handled deliberately, not treated as an error. GIF is absent from the
  format list and does occur.
- **7.9's error detection cannot work as written.** libheif's `decode()` never
  throws, and a truncated file returns a handle reporting valid dimensions.
  Detection must hang off the `display()` callback receiving null.
- **Section 8 needs a row for the libheif leak**, or the mitigation is lost.

### 7. Blocked on hardware — needs a real machine

- **The folder picker → read → disk-write chain has never run.** A native dialog
  cannot be completed headlessly, so E2E drives `webkitdirectory` instead. This is
  the least-tested path in the product and it is where a real user already hit two
  bugs.
- **Real HEIC at volume.** Decode is verified on real fixtures with flat memory
  across 70 decodes, but not at 137 files inside a real session.
- **The perceptual-hash thresholds were tuned on a procedurally generated corpus**,
  not photographs. The expression and nomination results specifically deserve
  re-checking against a real burst.

## Working style that has paid off here

Every significant bug in this project was found by measuring rather than reasoning.
A partial list: `String.replace` expanding `$$` in a replacement string silently
corrupted the built artifact while `src/` stayed correct; Chromium silently ignores
`createImageBitmap`'s `imageOrientation: 'none'` and rotated every tagged JPEG
twice; revoking an object URL mid-decode surfaced as a console error only on
`file://`; a full tree re-render on every keystroke stole focus so two-digit numbers
could not be typed.

None of those were visible by reading the code. Write the test, run the real
browser, look at the screenshot.

## CHANGELOG
- v1.0 (2026-07-28): Initial release.
