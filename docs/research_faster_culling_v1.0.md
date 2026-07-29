---
file: research_faster_culling_v1.0.md
version: 1.0
author: Samuel Cao
created: 2026-07-29
last_updated: 2026-07-29
description: Research report on making Stage A reach the target with fewer screens and less user time, without weakening the pre-committed-quota forcing function. Grounded in pass-count arithmetic for the real 742-photo run, the measured bracket costs in 70_screen_bracket.js, and the culling-tool landscape.
ai_update: Update last_updated and version. Rename file to match. Append changelog at bottom.
---

# Faster initial culling — research

**The feedback** (handoff queue item 0): "the initial culling rounds run long," after a real
742-photo portfolio run. This report models where the time goes, what would shorten it, and
which options do it without touching PRD §2 — the quota locking at pass start is the product
and is not on the table. Every proposal below keeps a limit that is **chosen before looking
and locked while looking**; the only things that vary are what the limit is attached to and
what the first cut looks like on screen.

**Worked case throughout:** 742 photos, target 16, the user's real run. Quota math mirrors
`resolveQuota` in `src/js/35_session.js` (keep-half at 9-up is *keep up to 4 of 9*, ratio
4/9, worst case assumed — the user keeps the full quota every screen). Bracket costs use
the textbook `(N−1) + (T−1)·log₂N` that `70_screen_bracket.js` measured the real engine at
1.00–1.03× of. Time model, stated once and reused: a grid screen ≈ 4 s overhead + ~1–1.5 s
per photo shown (9-up ≈ 13–18 s), a pairwise comparison ≈ 2.5–3 s, a single-photo yes/no
≈ 1–1.2 s (see §4 for where that number comes from).

---

## 1. Where the time actually goes

Baseline: defaults (9-up, keep-half, hand off when pool ≤ 3×target per `bracketSuggestion`):

| Pass | Field | Screens | Survivors (worst case) |
|---|---|---|---|
| 1 | 742 | **83** | 330 |
| 2 | 330 | 37 | 147 |
| 3 | 147 | 17 | 65 |
| 4 | 65 | 8 | 29 |
| Bracket | 29 → 16 | — | ~101 comparisons |

**145 screens, 1,284 photo-appearances, then ~101 comparisons. ≈ 33 min optimistic,
≈ 48 min at 18 s/screen.** That matches "runs long."

Three structural facts fall out of the arithmetic:

- **Pass 1 is dominant: 83 of 145 screens (57%), 742 of 1,284 photo-views (58%).** Passes
  shrink geometrically (total appearances ≈ N/(1−r), r = keep ratio), so whatever treatment
  makes the *first* cut cheaper matters roughly as much as everything after it combined.
- **Grid size barely matters; quota ratio is the lever.** Keep-half at 16-up is 89 screens
  instead of 145 — but the photo-appearance count is unchanged (~1,390), because keep-half
  shrinks the pool at the same rate regardless of how it's paged. If per-screen time scales
  with photos shown (it mostly does), 16-up saves only the per-screen overhead: ~3–5 min of
  35. A tighter quota changes the appearance count itself:

| Schedule (worst case) | Screens | Photo-appearances | Hand off at | Bracket | Est. total |
|---|---|---|---|---|---|
| 9-up keep-half (baseline) | 145 | 1,284 | 29 | ~101 | 33–48 min |
| 16-up keep-half | 89 | 1,390 | 46 | ~128 | 31–35 min |
| 9-up keep-3 | 121 | 1,075 | 30 | ~103 | 29–41 min |
| 9-up keep-2 | 102 | 908 | 38 | ~116 | 25–36 min |
| 9-up keep-1 | 93 | 825 | 10 | ~59 | 21–31 min |
| 16-up keep-6, 9-up keep-3, 9-up keep-half | 90 | 1,120 | 43 | ~123 | 23–33 min |

- **Keep-half is the weakest quota that still guarantees progress**, and it is the default.
  A 742-photo folder pays four full passes because each pass only cuts ~55%.

## 2. Adaptive schedules, and what PRD 7.2 already covers

**PRD 7.2 cannot help the default user.** The low-cull-rate offer fires when a completed
pass cuts below the floor (default 25%); keep-half *always* cuts ≥ 55%, so — as §7.2 itself
notes — the floor is mathematically unreachable at the default. It is a guard on Unlimited
and loose Custom modes, and it is also *reactive*: it refunds a wasted pass after the
screens were clicked. Nothing in the tool today makes the schedule aggressive up front.

An "aggressive by default for large pools" schedule — coarse first pass, tighter early
quotas, loosening as the pool nears the target (when decisions get genuinely hard) — saves
55 of 145 screens (~38%, ~10–15 min) at zero mechanism cost: every pass still locks its
quota at start. The mixed schedule in the table (16-up keep-6 → 9-up keep-3 → 9-up
keep-half) is a reasonable shape: broad and harsh while the pool is junk-heavy, familiar
9-up keep-half for the last, hardest pass. Since quota tightness already escalates
*emotionally* (the last photos are the hardest to cut), front-loading the harsh quotas
also matches where decisions are cheapest.

The missing companion feature: **the setup screen never projects the cost of the chosen
configuration.** The user commits to keep-half at 9-up with no warning that it implies
~145 screens over ~4 passes. Showing the projection turns the schedule choice into an
informed commitment — which strengthens §2's philosophy rather than bending it.

## 3. Early hand-off: when does the bracket beat another pass?

One more keep-half pass over a field of N costs ceil(N/9) screens and hands the bracket
~4N/9 photos instead of N; the bracket saves ≈ (5N/9 + T−1) comparisons. With the stated
time model, the two options are startlingly close at every field size:

| Field | Bracket now | One more pass first | Winner |
|---|---|---|---|
| 330 | ~454 cmp ≈ 18.9 min | 37 screens + ~254 cmp ≈ 18.0 min | pass, barely |
| 147 | ~254 cmp ≈ 10.6 min | 17 screens + ~154 cmp ≈ 9.8 min | pass, barely |
| 93 | ~190 cmp ≈ 7.9 min | 11 screens + ~120 cmp ≈ 7.2 min | pass, barely |
| 66 | ~156 cmp ≈ 6.5 min | 8 screens + ~101 cmp ≈ 5.8 min | pass, barely |
| 48 | ~131 cmp ≈ 5.5 min | 6 screens + ~86 cmp ≈ 4.8 min | pass, barely |

The crossover rule: a keep-half pass wins while a screen costs less than ~5 comparisons'
time (≈ 12–15 s); a tighter pass (keep-2 ≈ 7 comparisons ≈ 17–21 s) wins by more. Two
honest consequences:

- **Handing off early is nearly free.** Jumping to the bracket at 66 instead of 29 costs
  ~1 minute — and buys a full ranking, which passes never produce. The 2–3× guidance in
  `bracketSuggestion` could relax to "any time under ~4–5× target costs you almost
  nothing" without lying.
- **Passing is only *clearly* better than the bracket when the quota is tight.** At
  keep-half the two are within noise of each other, which is another way of saying the
  default quota is what makes the rounds feel long.

**Concrete heuristic for the setup screen** (drop-in beside `bracketSuggestion`):
`bracketNow = (N−1) + (T−1)·log₂N` (measured-accurate); `passFirst = screens(N, g) ×
S + bracketNow(survivorsWorstCase)`. Surface both: *"Bracket now: ~156 comparisons
(≈ 6½ min). One more pass first: 8 screens, then ~101 comparisons (≈ 6 min) — saves you
about 55 head-to-head calls."* The user stays in charge of the hand-off, as PRD 7.1
requires; the tool just prices the choice.

## 4. What culling tools in the wild do, and what transplants

Landscape summary (sources at end): the professional consensus workflow is **two-tier** —
a fast *linear reject* pass first, then *comparative* views only for what survives.

- **Photo Mechanic**: single photo, keyboard rating with auto-advance, speed from
  pre-rendered previews; skim rates around 30 images in 8 s, sustained *deciding* rates
  around 1/s. Pattern: one keystroke = one decision = auto-advance, zero navigation cost.
- **FastRawViewer / Lightroom P-X flow**: pick/reject keys with auto-advance; practitioners
  explicitly describe "a quick cull to ditch obvious rejects, then a detailed pass."
- **Lightroom Survey/Compare views**: small-group side-by-side is used *late*, on
  filtered survivors — exactly Photournament's grid and bracket, in the same order.
- **Narrative Select**: AI pre-assessments (focus, closed eyes) *flag* problems for review
  rather than deciding; grouping of similar shots; the human confirms piles.

**What transplants cleanly:** the single-photo keep/cut speed round for the *first* cut.
The first pass is dominated by obvious calls (junk, misfires, redundant frames), which is
precisely where per-photo cost matters and comparison doesn't. At ~1–1.2 s/decision, 742
single-photo decisions take **12–15 min** and can cut far deeper than half in one linear
pass. Speed round to a pre-committed budget of ~100–150 survivors, then one 9-up pass,
then the bracket:

- budget 150: 14.8 min + 25 screens (5 min) + ~103 comparisons (4.3 min) ≈ **24 min**
- budget 100: 14.8 min + 12 screens (2.4 min) + ~126 comparisons (5.3 min) ≈ **22.5 min**

versus 33–48 min baseline. The honest caveats: single-photo review gives up side-by-side
context (§1's founding complaint) and is exposed to drift (complaint #2) — which is why it
must be scoped to the first cut only, where decisions are absolute ("is this even a
candidate?") rather than comparative. And the per-screen quota becomes a **pool-level
budget**: pre-committed before the round, locked during it, a running "kept 83 of 150 ·
412 remain" counter, and the round cannot finish over budget (same disabled-button-with-
reason pattern as `advance()`). The tool already has this exact commitment shape:
**the rescue limit in PRD 7.5 is a pool-level pre-committed cap**, locked before looking.
The speed round is the same device pointed at the front of the funnel instead of the back.

**What fights the model:** AI *scoring* or auto-rejection (out of scope per PRD §9, and it
replaces the judgment the tool exists to force). Ratings-first workflows (stars) also fight
it — a rating is additive and defers the cut, which is complaint #4.

## 5. What pHash and sharpness can pre-do for free

`20_phash.js` already computes, per photo, at ingest: a pHash, a dHash, a sharpness score,
and (transiently) the greyscale plane the metrics run on.

- **Pre-flag likely rejects into a review pile.** Bottom-decile sharpness within the unit,
  plus near-black/near-white frames (mean luminance is one extra reduction over the grey
  plane already in hand — currently not stored, trivially added in the ingest worker). On a
  742-photo phone/portfolio dump, 8–15% is a realistic flag rate: **60–110 photos**. Flow:
  before pass 1, a "likely rejects — confirm" screen structured exactly like the rescue
  screen (scroller, IntersectionObserver, pre-committed framing), flagged photos start
  *selected for cutting*, one click un-flags. Confirmed cuts land in `unit.cut`, still
  rescuable later. The PRD forbids auto-deletion; this is flag-plus-review, the Narrative
  Select pattern. Saves ~10% of every downstream pass (~14 screens ≈ 3–4 min) for ~2 min
  of fast confirmation — a modest net win, but it also removes the most fatiguing content
  from every screen the user does see.
- **Similarity-sorted dealing** (pHash-near photos on the same screen) makes per-screen
  choices easier — like-vs-like is a cheaper judgment — but it is in direct tension with
  the documented rationale for shuffle: it *clumps* strong photos, recreating "a good
  photo dying on a crowded screen." True near-duplicates are already bundled into one
  slot by `slotsFor`, which captures most of the benefit with none of the risk. Verdict:
  a per-pass deal-order option at most; not a default, low priority.

## 6. King-of-the-hill without its cost

Full KOTH is rejected for good reason (~N×M comparisons; PRD §10/roadmap). Two bounded
hybrids:

- **KOTH as a scheduling skin on the existing bracket — nearly free.** Single elimination
  does not dictate match *order*. Resolving the draw depth-first (A vs B, C vs D, then
  AB-winner vs CD-winner immediately) means every second match retains one photo from the
  previous screen — a visible "champion holds, challenger arrives" feel at *identical*
  comparison count, inside the engine's existing op log and positional match ids. This
  captures KOTH's legibility at cost zero and is the version worth building.
- **KOTH for the final T slots** does *not* pencil out: sequentially defending 16 slots
  over a 32-photo pool costs ~O(N·T) ≈ several hundred comparisons where the bracket +
  repechage does 32→16 in ~106. Dead end; keep it off the schedule path.

## 7. Recommendation: three changes, ranked by (time saved) / (risk to the quota design)

### 1. Pass projection + a "fast start" schedule on the setup screen — saves ~10–15 min, risk ≈ zero

Two halves. (a) A pure function `projectPasses(poolSize, target, settings)` in
`35_session.js` beside `bracketSuggestion`: fold the worst-case pass arithmetic of §1
(reusing `resolveQuota` per screen, remainder screens included) until pool ≤ 3×target,
returning screens-per-pass, total screens, and the §3 bracket-now-vs-pass-first pricing.
(b) Render it in `renderSetup()`/`configCard()` in `60_screen_grid.js`, live-updating as
the user changes grid/quota (the `onchange` handlers already call `render()`), plus one
preset button — "Fast start: 16-up keep-6, then tighten" — that just writes
`session.settings` the same way the existing selects do. Nothing about locking changes;
the quota is still committed before the pass and copied into it by `startPass`. This
turns 145 baseline screens into ~90–102 and, more importantly, makes the cost of
keep-half visible *before* it is paid.

### 2. Single-photo speed round with a pre-committed pool budget — saves ~12–20 min, moderate build risk, low philosophy risk

A new optional first stage, offered when the pool is large (say ≥ 150): full-viewport one
photo, J/K (or ←/→) = cut/keep with auto-advance, 1 keystroke per decision. The forcing
function is a **budget locked before the round starts** ("keep at most 150 of 742"), the
same pre-commit-then-lock device as `rescueLimit`, with a running budget counter and a
finish button that refuses while over budget, reusing the `advance()` disabled-with-reason
pattern. Implementation: register a `speedround` screen like `grid`; state lives on the
unit (`unit.speedRound = {budget, order, index, kept}`) persisted like `currentPass` so
mid-round resume is free; deal **slots** via `slotsFor` so bursts stay one decision;
hydrate the large preview the way the bracket's `hydrate()` does. Ends by setting
`unit.pool`/`unit.cut` exactly as `finishPass` does, so rescue, low-cull reporting, and
everything downstream work unchanged. 742 decisions ≈ 13–15 min replaces passes 1–3
(≈ 25–33 min of screens); total session ≈ 22–24 min versus 33–48.

### 3. Pre-flag likely rejects into a confirm pile — saves ~3–4 min plus fatigue, low risk

In `10_ingest_worker.js`, store mean luminance next to the existing sharpness score (one
loop over the grey plane already computed for pHash). At unit start, compute flags:
bottom-decile `sharp` within the unit, or extreme mean luminance. Offer — never force — a
"review N likely rejects" screen cloned from the rescue screen in `60_screen_grid.js`
(scroller + IntersectionObserver + locked framing), with flagged photos pre-selected for
cutting and one click to spare. Confirmed cuts go to `unit.cut` (rescuable, honest
accounting in pass summaries via a `preflagged` count). No auto-deletion; the user
confirms every cut, which is the line the PRD draws.

**Also worth doing when touching the bracket anyway:** relax `bracketSuggestion`'s 2–3×
copy to say early hand-off is cheap (§3), and note the DFS/KOTH scheduling skin (§6) on
the roadmap entry.

---

Sources (landscape, §4):
[PPA — Photo Mechanic power tips](https://www.ppa.com/ppmag/articles/photo-mechanic-power-tips) ·
[Imagen — Photo Mechanic vs Lightroom culling](https://imagen-ai.com/valuable-tips/photo-mechanic-vs-lightroom-culling/) ·
[Trung Hoang — PM + LR culling workflow](https://www.trunghoangphotography.com/for-photographers/photo-mechanic-lightroom-workflow-culling-faster-with-photo-mechanic) ·
[Photography Life — cull faster with FastRawViewer](https://photographylife.com/how-to-cull-your-images-faster-with-fastrawviewer) ·
[Rhett.cc — FastRawViewer culling setup](https://rhett.cc/FastRawViewer/) ·
[The Lens Lounge — Lightroom culling](https://thelenslounge.com/how-to-cull-photos-in-lightroom/) ·
[Narrative Select](https://narrative.so/select) ·
[SLR Lounge — Narrative Select review](https://www.slrlounge.com/narrative-select-review/) ·
[Fstoppers — Lightroom Survey view](https://fstoppers.com/lightroom/how-use-lightrooms-survey-view-efficient-photo-selection-669325) ·
[Photography Life — professional culling workflow](https://photographylife.com/professional-workflow-image-culling)

## CHANGELOG
- v1.0 (2026-07-29): Initial report. Pass-count model for the 742/16 case, adaptive
  schedule table, bracket crossover pricing, culling-tool landscape, pHash pre-flag and
  similarity analysis, KOTH hybrids, and three ranked recommendations with sketches.
