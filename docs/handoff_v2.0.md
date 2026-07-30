---
file: handoff_v2.0.md
version: 2.0
author: Samuel Cao
created: 2026-07-29
last_updated: 2026-07-29
description: Handoff for Photournament as of commit 657f5b3. Replaces handoff_v1.0.md, whose queue is now mostly shipped. Everything below the line is a prompt for a fresh session.
ai_update: Update last_updated and version. Rename file to match. Append changelog at bottom.
---

# Handoff — Photournament, 2026-07-29

`handoff_v1.0.md` is superseded. Its numbered queue described a v0.2 prototype;
almost all of it shipped. Keep that file for the measured probe context in its
"Constraints" section, but read this one for what is true now.

---

You are picking up **Photournament**, a local single-file HTML photo-culling
tool built for Samuel Cao's real portfolio work. It is shipped and in real use:
he has run it against a 742-photo folder and reports bugs from live sessions.
Treat his reports as ground truth about behaviour, and verify them in a real
browser rather than by reading code.

## Where things stand

- **Branch:** `claude/photournament-prd-v1-8-fojs7d`. Everything is pushed;
  HEAD is `657f5b3`. Never push elsewhere without asking.
- **Spec:** `photournament_prd_v1.9.md`. §4.2 now documents five allocation
  states (Percent joined the four). Cite section numbers in commits.
- **Hosted:** <https://zillaness.github.io/Photournament/> — live and current.
  Pages source is "GitHub Actions"; `.github/workflows/pages.yml` builds from
  source on every push, so the site is never a rebuild behind. (Historical
  trap, now resolved: while the source was "Deploy from a branch", GitHub's
  Jekyll pipeline republished the README render over every deploy.)
- **Build:** `npm run build` emits `dist/photournament_v1.0.html` and a slim
  no-HEIC twin. `npm test` is unit tests + freshness + 2 smokes + **15 e2e
  runs**, and it is green at HEAD. Keep it that way; `tests/dist_fresh.mjs`
  fails if the committed artifacts drift from a fresh build, so rebuild before
  committing.

## The three things that shape every decision here

1. **`file://` is the target origin.** Chromium blocks `fetch`, XHR, module
   scripts with `src`, and relative-URL workers there. That is why the app is
   one concatenated HTML file, why workers spawn from blob URLs, and why every
   asset is inlined. Measured table:
   `tools/probes/01_capability_matrix/FINDINGS.md`.
2. **The quota is the product** (PRD §2). It locks at pass start, copied into
   `unit.currentPass`; nothing may loosen it mid-pass. Features that make
   culling faster are welcome; features that let present-you relax a commitment
   past-you made are not.
3. **Bursts cost one decision.** A reviewed near-duplicate group is dealt as a
   single slot wearing one representative — in Stage A grid passes, and as one
   competitor in the bracket. `PT.session.slotsFor()` is the seam. Members ride
   along and are prised apart only in the Stage C runoff.

## Architecture, briefly

Vanilla JS classic scripts attaching to a `PT` global, concatenated in filename
order by `tools/build.mjs`. No framework, no bundler.

| File | Owns |
| --- | --- |
| `00_core.js` | store (named actions, debounced persist), IndexedDB, DOM helpers, router, `PT.orient` (rotate/flip), `PT.lightbox` |
| `10_ingest_worker.js` | blob-URL worker pool: decode, thumbnail, preview, pHash, sharpness |
| `20_phash.js` | perceptual hash, clustering, `nominate` |
| `30_tree.js` | PRD §4 allocation math, pure and directly testable |
| `35_session.js` | session/unit model, quota resolution, pass bookkeeping, `slotsFor` |
| `40_screen_ingest.js` | entry + ingest screens, wordmark, brand mark, throbber |
| `45_screen_dupes.js` | PRD 7.7 duplicate review, marquee selection |
| `50_screen_tree.js` | allocation screen, broadcast row |
| `60_screen_grid.js` | Stage A passes, rescue, finish-early |
| `70_screen_bracket.js` | bracket engine + screen, Stage C runoff |
| `80_screen_export.js` | export review, zip, contact sheet, session stats |
| `99_app.js` | boot, resume, `PT.advance()`, theme |

State lives in the store, never in screen closures — that is what makes PRD
7.10 mid-pass resume fall out of the data model.

## Conventions that are enforced, not preferred

- Every file carries a version header and an **append-only changelog** whose
  entries say *why*, not just what. Bump on every substantive change.
- Comments state constraints and reasoning the code cannot show. No narration.
- **Design tokens only** — `var(--bg)`, `var(--surface)`, never literals. The
  stylesheet is a Claude Design v2.1 drop; a token audit has been run against
  the pristine file and found zero drift. Keep it that way.
- `--accent` never touches a photograph. Chips over photos use the fixed-dark
  `--chip` / `--on-photo` pair, because those must not invert with the theme.
- Tests are prose-labelled and assert *behaviour a user could notice*. Several
  guard bugs that looked fine in code and wrong on screen.

## Hard-won facts worth not rediscovering

- **pHash is a constant-weight code** — exactly 31 one-bits, so all distances
  are even and the sensitivity slider must step by 2. Threshold 14, strict.
- **Procedurally generated test images cluster.** Smooth gradients and sine
  scenes that look distinct read as one burst to the hash, which has broken two
  tests. Use the block-board generator (`pngBoard` in `e2e_zip.mjs` /
  `e2e_resume.mjs`): a multiplicative-hash 4×4 board with a provable minimum of
  4/16 blocks differing between any two seeds.
- **File sources die with the page.** `PT.sources` is runtime-only. A resumed
  session can rename, label and take a contact sheet, but writing originals
  needs the folder handed over again. The export screen now says so and offers
  a path-matched reconnect.
- **Keyboard handlers are document-level and outlive `showModal()`.** Every one
  of them checks `document.querySelector('dialog[open]')` first. Two real bugs
  came from not doing this.
- **`imageOrientation: 'none'`** is silently ignored by Chromium; there is a
  runtime self-test for it.

## What the next session is for

**Ranking mode vs culling mode, especially for small albums.** Samuel's
question, and the reason this handoff exists. The tool today is built around
*subtraction* — quota-enforced passes that throw most of a big folder away, then
a bracket to order the survivors. For a 30-photo album that framing is wrong:
nothing needs cutting, everything needs *ordering*. Ranking is currently the
second half of a pipeline whose first half is mandatory.

Worth knowing before designing it:

- **The bracket engine is already the ranking mode.** `PT.bracket` in
  `70_screen_bracket.js` is pure: seeded draw, standard seed slots, a
  second-chance (repechage) round, an op log of `{t, m, w}` referencing matches
  *positionally*, and `results()` which returns the whole ranked field —
  `chosenWinners()` then applies the target. It ranks N photos in roughly
  `(N−1) + (T−1)·log₂N` comparisons and reports live estimates. Nothing about
  it requires Stage A to have run.
- **The standings screen is already a picker.** As of `4cf2b2c` it renders the
  entire ranked field, draws the target's cutoff line through it, pre-chooses
  the top-N as a suggestion, and lets any row toggle. That is most of a ranking
  mode's output UI.
- **The plumbing assumption to break** is that a unit enters at `phase:
  'gridA'`. `PT.session.newUnit` sets it, `PT.advance()` routes on it, and
  `pendingUnits` drives the flow. A ranking mode is plausibly "create the unit
  at `phase: 'bracket'` with an uncapped or user-set target, skip Stage A
  entirely" — but check `35_session.js` and `99_app.js` before believing that.
- **Where the choice belongs** is an open design question worth asking him
  rather than guessing: a mode switch on the entry screen, a per-folder choice
  on the allocation screen (a folder of 30 could rank while a folder of 700
  culls), or an automatic offer when a folder is under some size. His allocation
  screen already expresses per-folder intent, which makes it the natural home.
- **Small albums change the economics.** 30 photos to a full ranking is ~29
  comparisons plus repechage — a couple of minutes, no passes at all. The
  research doc's crossover math (`docs/research_faster_culling_v1.0.md` §3) is
  directly relevant: it computes when ranking beats another pass.
- **Related tabled item:** king-of-the-hill (below) is a *ranking* interaction,
  and small albums are exactly where its legibility would shine. If ranking mode
  gets built, revisit that at the same time.

## The open queue

### Tabled by the user — do not start without asking

1. **"The initial culling rounds run long."** Fully researched, not built.
   `docs/research_faster_culling_v1.0.md` has the arithmetic for his real case
   (742 photos, target 16 → ~145 screens over 4 passes; pass 1 is 57% of it)
   and three ranked recommendations: pass projection + an aggressive first-pass
   preset (~10–15 min saved, near-zero risk), a single-photo speed round with a
   pre-committed pool budget (~12–20 min), and pre-flagging likely rejects from
   data ingest already computes. Read that before touching Stage A pacing.
2. **King-of-the-hill mode.** Preserved on the PRD roadmap at his request
   (§ rejected alternatives). The economical form is a match-*scheduling* skin
   over the existing bracket — champion visibly holds, identical comparison
   count. KOTH-for-final-slots is a dead end (~O(N·T)).
3. **Demote the duplicate review from a gate to an offer.** Proposed and not
   yet answered: he called the step "high friction right at the beginning."
   Since bundling landed, groups are visible and fixable everywhere in the
   flow, so the screen's unique powers are only split/merge/remove and the
   slider. Suggested shape: go straight to culling, with a one-line offer on
   the pass-setup screen ("9 groups bundled · review the grouping").

### Known limits, honestly stated

- Chromium only for resume and disk writes.
- The **native folder-picker → disk-write** path cannot be driven headlessly,
  so it is the one flow with no automated coverage. The zip is covered down to
  parsing the archive.
- **pHash thresholds were tuned on procedural images**, not photographs. They
  measured at precision/recall 1.000 there, and his real bursts have grouped
  well, but a real-photo validation set is still owed.
- Manual rotate/flip is visual: it corrects everything in-app including the
  contact sheet, but exported originals are written byte-for-byte as shot.

## How to work with Samuel

He sends short, high-signal reports — often mid-turn, often several at once,
sometimes with annotated screenshots. They are precise: "the logo is a
different shade of black" was a real `--bg` vs `--surface` mismatch, and "I
don't think the zip exported" was a build that silently shipped an empty
archive. When he describes a problem, find the mechanism before proposing a
fix, and verify in a browser.

He asks for things to be **parked** as often as built — respect that exactly,
and record parked items in this file's queue with enough context to start cold.

Adversarial review has paid for itself repeatedly on this project: a review
pass over the previous commit found keyboard handlers live behind modals and a
percent toggle that silently changed counts. If you make a substantial change,
review it before he does.

CHANGELOG
v2.0 (2026-07-29): Rewritten for the shipped v1.0 app at commit 657f5b3, and
  aimed at the next session's question — a ranking mode distinct from culling,
  for small albums.
  Replaces the v0.2-era queue in handoff_v1.0.md with current state, the seams
  that matter, the facts worth not rediscovering, and the three tabled items.
