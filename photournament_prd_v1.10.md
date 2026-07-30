---
file: photournament_prd_v1.10.md
version: 1.10
author: Samuel Cao
created: 2026-07-27
last_updated: 2026-07-30
description: Product requirements for Photournament, a local browser-based tool that narrows photo sets to a top-N through quota-enforced grid passes and pairwise tournament ranking, with per-folder allocation, an optional cross-category final, and annotated export.
ai_update: Update last_updated and version. Rename file to match. Append changelog at bottom.
---

# Photournament PRD

A local HTML tool that lifts the best photos out of a set: quota-enforced grid passes to cut the field, then pairwise tournament comparison to rank what survives, with finalist counts allocated across a folder tree and an optional best-of-the-best round on top. Supersedes `photournament_prd_v1.8.md`.

**Status: implemented as a working prototype. Sections corrected against measurement are marked MEASURED; those numbers came from running the thing, not from estimating.**

---

## 1. Problem

Culling a shoot currently means scrolling a grid in Photos, Lightroom, or Finder and flagging favorites over repeated passes. That breaks down in five ways:

- **No side-by-side for distant frames.** Two of the best images may sit 300 files apart and never get directly compared.
- **Fatigue and drift.** Standards loosen or tighten partway through.
- **Burst frames cause re-litigation.** Near-identical frames get evaluated separately, and the same debate repeats each pass.
- **Nothing forces a cut.** Flagging is additive. Without a forcing function, "narrowing down" produces a shortlist and stalls there.
- **Best-of and representative-of are different jobs**, and often both are wanted from the same set. A chronological slideshow and a highlight reel are different deliverables built from the same photos.

---

## 2. Core principle: the quota is a commitment device

**The user sets the survivor quota before a pass begins, and the tool holds them to it.**

Left unconstrained, the natural behavior is to keep too much and the pile never shrinks. A quota chosen in advance is a decision made while thinking about the whole set, applied at the moment the user is thinking about nine photos they like. Present-you is worse at cutting than past-you.

1. **Quotas lock for the duration of a pass.** No raising the cap mid-pass because the current screen feels unusually strong. That is exactly when the cap matters.
2. **Quotas are adjustable between passes.** The commitment is per pass, not per session.
3. **Rescue is bound by the same discipline** (§7.5), or it becomes the loophole that voids every quota upstream.

**Uncapped modes exist** (§4.2) because "cull until I'm satisfied" is a legitimate goal. They are not the default, and cut percentages are reported so an uncapped session that isn't making progress is visible rather than silent.

---

## 3. Source material

**MEASURED, from a real source folder.** 746 stills and 175 video files:

| | count | bytes |
|---|---:|---:|
| JPEG | 601 | 1.28 GB |
| HEIC | 137 | 300 MB |
| PNG | 3 | 15.5 MB |
| WebP | 3 | 526 KB |
| GIF | 2 | 15.2 MB |
| **video** (.mp4, .mov) | **175** | **6.06 GB** |

Three corrections to the earlier estimate of "roughly 500 photos, formats HEIC, JPEG, PNG, WebP":

- **The count was 50% low**, and structure varies as described: categories, days, SD cards, or nested combinations.
- **GIF occurs** and was missing from the list. Chromium decodes it natively; the first frame is used.
- **Video is 79% of the bytes and sits in the same folders.** It is out of scope (§9), but "out of scope" cannot mean "unhandled": 175 files reported as errors would read as 175 problems. Video and RAW are recognised, counted categories that are reported as skipped and never decoded.

**HEIC is a minority, not the norm.** At 18% of stills it is worth loading the decoder lazily, so a mostly-JPEG set never pays its 1.46 MB cost (§8).

---

## 4. Folder hierarchy and finalist allocation

The folder tree is how the user expresses **whether they want the best photos or a representative spread**, and the tool treats it as first-class.

### 4.1 The tree surfaces in the UI

On ingest, the folder structure is displayed as a tree at **whatever depth the source has**. There is no depth cap; the tree mirrors the folder structure being culled. Every node shows its photo count and carries an allocation state.

### 4.2 Five allocation states

Each node answers one question: *how many finalists come out of this folder?*

| State | Entry | Parent node meaning | Leaf node meaning |
|---|---|---|---|
| **Fixed** | a number ≥ 1 | Children must sum to this; parent is authoritative | Exactly this many guaranteed |
| **Percent** | a share like `5%`, **or** a % toggle | Resolves against this folder's own photo count, then behaves as Fixed | Same — `5%` of 746 photos is 37, then behaves as Fixed |
| **Excluded** | `0` (and `0%`) | Entire subtree skipped | Folder skipped; no photos enter any tournament |
| **Pooled** | left blank | Competes with blank siblings for the parent's remainder | Competes with blank siblings; no guarantee any survive |
| **Uncapped** | `*` typed, **or** an ∞ toggle | **Total floats to the sum of its children**; children become authoritative | Cull until satisfied; no target, user stops when happy |

**Percent is a way of SAYING a fixed number, not a fifth kind of arithmetic.**
It resolves against the folder's *own* count — never the parent's remainder — as
soon as the counts are known, and everything downstream sees an ordinary Fixed
allocation. The field keeps showing what was typed (`5%`), the state column
shows what it came to (`= 37`), and rounding is to nearest but never silently
to zero: exclusion is a state the user has to ask for by name.

**`0` means excluded, not unlimited.** Every other value counts survivors, so 5 means five survive and 0 means none survive. Overloading 0 to mean its own opposite inverts the scale at one point. Uncapped is not a number and gets its own affordances.

**Uncapped has two entry paths, both always available:** typing `*` in the number field for speed when setting many nodes, and an ∞ toggle beside the field for discoverability. Neither is a mode; both work at any time.

### 4.3 Worked example

```
Trip/                    20
├── Day1/  (80 photos)   5      → 5 guaranteed
├── Day2/  (120 photos)  5      → 5 guaranteed
├── Day3/  (150 photos)  —      ┐
├── Day4/  (90 photos)   0      │ excluded
└── Misc/  (40 photos)   —      ┘ 10 remaining, pooled across Day3 + Misc
```

All children fixed: pure chronological representation.
All children pooled: pure best-of, one tournament across everything.
Mixed: guaranteed floor where it matters, open competition for the rest.

### 4.4 Which direction the math runs

The parent's state decides who is authoritative.

- **Fixed parent:** parent constrains children. Setting a parent target offers to distribute it across children. **Default distribution is weighted by photo count**; even split is available as an option. Either way the suggestion is editable per child.
- **Uncapped parent:** children are authoritative. The parent total is computed, displayed read-only, and rises as children are raised.

Distribution must be decided up front rather than derived from "whatever survives," because each tournament needs its target before its first grid pass in order to enforce quotas and estimate remaining work.

### 4.5 Rules and edge cases

- **Children summing above a fixed parent** is blocked at entry, showing the offending sum. Switching the parent to uncapped is offered as the resolution.
- **A fixed count above the folder's photo count** clamps to what is available, flagged in the tree.
- **Pooled children under an uncapped parent** have no remainder to compete for. The tree flags this dead state and prompts to fix the parent or give the child a count.
- **Every child fixed under a fixed parent** leaves no pooled remainder. Stated plainly in the tree.
- **Excluded folders are skipped everywhere**: not ingested into tournaments, not hashed for near-duplicate grouping, not counted in totals. They stay visible in the tree, struck through, so exclusion never looks like an import failure.
- **Everything uncapped** is valid and means "cull until satisfied" with no target. The tree shows a live projected total as passes complete.

### 4.6 Single-folder use

One folder with no subfolders is the degenerate case: one node, one state, one tournament. The hierarchy adds no friction when it isn't needed.

---

## 5. Success criteria

1. A folder reaches its target with substantially fewer decisions than reviewing every photo individually.
2. Obvious rejects are cut cheaply, in bulk, without a head-to-head comparison each.
3. Near-identical frames cost one decision at ranking time, not N decisions.
4. A strong photo is not lost purely to an unlucky pairing or a strong screen.
5. The field actually shrinks. A pass that cuts almost nothing is surfaced as a problem.
6. Representation, best-of, and uncapped culling are all reachable by editing a tree rather than switching workflows.
7. A single session can produce both a chronological set and a highlight set, each self-contained.
8. Finalists can carry the user's reasoning forward into their filenames, so intent survives the export.
9. The user can stop early at any point and still get a usable ranked result.
10. Sessions survive reload and next-day return with all decisions intact.

---

## 6. The flow

```
Ingest → [Tree setup] → per unit: [Stage A: Grid passes] → [Cut pile rescue] → [Stage B: Bracket] → [Stage C: Burst runoff]
       → [Stage D: Cross-category final]  (optional)
       → [Export review] → Output
```

Stages A through C run per tournament unit: a fixed-count folder, an uncapped folder, or a pooled group of blank siblings. Stage D runs once, across the winners of all units.

A unit marked for **ranking** (§7.11) skips Stage A entirely: Ingest → Tree → Stage B at a chosen, priced depth → Stage C → Export. The choice is per unit, so a 30-photo album can rank while a 700-photo folder culls in the same session.

---

## 7. Stage detail

### 7.1 Stage A: Grid pass

Show a page of photos. Keep up to the quota. Everything unkept is cut. Repeat until the field is small enough for a bracket.

**Configured before each pass, then locked:**

| Setting | Options | Default |
|---|---|---|
| Grid size | 6, 9, 12, 16 per screen | 9 |
| Survivor quota | Keep 1 / Keep up to half / Custom number / Unlimited | Keep up to half |
| Shuffle before paging | On / Off | **On** |

**Shuffle** distributes strong photos across screens instead of letting them clump by capture order, the main cause of a good photo dying on a crowded screen. On by default; toggleable for anyone reviewing in shot order.

**Interaction:** click to toggle keep. Number keys select by position. Enter advances. Undo and back-navigation within the pass. The advance button disables while the selection exceeds the quota, showing "keep at most 4" rather than silently rejecting clicks.

**Counters:** photos remaining, screens left this pass, field size versus target, percentage cut this pass.

**Handoff:** the user decides when to stop passing and start the bracket. For fixed targets the tool suggests roughly 2 to 3 times the target. For uncapped nodes there is no suggestion.

### 7.2 The low cull rate warning

**What it is not:** this is unrelated to stopping early. Early-stop is the user deciding they are satisfied and ending a stage. The low cull rate warning fires at the end of a single completed pass and asks whether that pass was worth the clicking.

**What it is:** one pass shows every remaining photo exactly once. If a pass over 60 photos keeps 55, it cost seven screens and left the pile intact. At the end of each pass the tool reports the percentage cut, and below the configured floor it says so and offers to re-run that pass with a tighter quota. It never forces a re-run; results stand if the user declines.

**Setting, default 25%.** At the default *Keep up to half* quota this floor is mathematically unreachable, since keeping at most half always cuts at least half. That is intended: the warning is a guard on the loose modes (Unlimited, or a generous Custom), not a nag during normal use. Setting it to 0 disables it entirely.

### 7.3 Stage B: Bracket with second-chance round

- Randomly seeded single elimination across Stage A survivors.
- The bracket records who eliminated whom.
- A repechage round runs among photos eliminated by deep finishers, filling places 2 through N, preventing a strong photo being lost to an unlucky early draw.
- Matchup screen: two photos side by side, as large as the viewport allows. Click or tap to choose; arrow keys do the same. "Too close to call" defers the pairing. Unlimited undo. Simultaneous 1:1 zoom.
- Persistent header: folder, target, remaining, comparisons completed, estimated remaining, early-stop.

### 7.4 Stage C: Burst runoff

Any finalist from a near-duplicate group can be expanded into a *Keep 1* grid pass over that group, selecting the best frame. Optional and per-photo. Bursts eliminated earlier cost one decision total.

### 7.5 Cut pile rescue

Everything eliminated in Stage A lands in a scrollable cut pile, reviewable before the bracket starts.

**Rescue has its own pre-committed limit,** set before review and locked during it: fixed number, percentage of the cut pile, or unlimited. Without it, rescue voids every quota upstream.

The cut pile exists because a 9-way screen can drop a strong photo that landed among stronger ones, and the bracket's second-chance round only knows about bracket losses.

### 7.6 Stage D: Cross-category final (optional)

**Off by default. Enabled per session.**

After every folder has produced its finalists, Stage D runs one more tournament whose field is **the union of all folder winners**. It has its own target count and uses the same grid and bracket machinery as any other unit.

This exists because the two jobs in §1 are often both wanted from one set. Per-folder allocation guarantees chronological coverage; Stage D finds the strongest photos irrespective of source. Running both in one session produces a slideshow set and a highlight set from the same culling effort.

**Both result sets are kept.** Stage D adds a second, smaller set alongside the per-folder winners rather than replacing or filtering them.

**Duplication across output sets is intentional** (§7.8). A photo that wins its category and then wins the overall round is written to both folders, so each set stands alone.

### 7.7 Near-duplicate grouping

- Auto-group by perceptual hash Hamming distance, with a live sensitivity slider.
- **MEASURED: cluster on pHash in strict mode at a Hamming distance of 14** — precision and recall both 1.000 over 7,381 labelled pairs. dHash has no clean threshold at all; its positives and negatives overlap by 4 bits.
- **The slider must step by 2.** pHash is a constant-weight code — every hash carries exactly 31 one-bits — so every pairwise distance is even and odd thresholds are dead stops where nothing changes.
- **Strict, not union.** Hamming distance is not transitive, and at threshold 14 roughly 3% of triples break it. Union merges a chain A~B~C whose ends are far apart; strict caps every group at the threshold. Strict's failure mode is over-splitting, which a merge button fixes; union's is a runaway merge, which nothing fixes.
- Scrollable review showing every group with all members.
- Manual split, merge, remove, confirm.
- Each group nominates one representative via a sharpness and resolution heuristic; one click overrides. Other members stay attached for a possible Stage C runoff.
- Excluded folders (§4.5) are not hashed and never appear in groups.

### 7.8 Export review and output

Before anything is written, an export review screen lists every finalist with its rank, source folder, and destination filename.

**Renaming with intent.** Each finalist has an editable label field. The label is the user's note to themselves about why the photo won or how it will be used, and it becomes part of the filename:

```
01_hero_for_cover_IMG_1234.jpg
02_opening_slide_IMG_0987.jpg
03_IMG_0450.jpg                  ← label left blank
```

Labels are optional and default to empty. The original filename is always retained as the final component so provenance survives renaming, and the decision JSON records the full original-to-exported mapping.

**Ordered prefixes** (`01_`, `02_`) preserve sequence through alphabetical sorting in slideshow tools. **Toggleable**, on by default.

**Folder naming.** Each result set writes to its own folder, named for its source:

```
Trip/
├── Day1/
├── Day2/
├── _finalists_Day1/        ← Day1's winners
├── _finalists_Day2/        ← Day2's winners
├── _finalists_pooled/      ← pooled-group winners
└── _finalists_overall/     ← Stage D winners, if run
```

**Output structure** defaults to mirroring the source folder structure, matching whatever nesting the input had. A **flatten option** collapses all finalists into a single folder for users who prefer flatter output.

**Collision handling applies to disk writes only.** Per-source naming means different folders never collide with each other; collision arises only when re-running the same folder. When writing into the source tree and a target folder already exists with contents, the tool asks: add, replace, or timestamped sibling. It never silently overwrites. Downloads have no collision problem and skip this prompt.

**Other outputs:**

- Ranked finalists as a thumbnail grid, grouped by source.
- Download any result set as a labeled bundle, alongside or instead of disk writes.
- Copy ranked filename list to clipboard.
- Export decision history as JSON, including labels and filename mapping.

### 7.9 Ingest

- Read images recursively and build the folder tree at full source depth.
- Generate a grid thumbnail (~320px) and matchup preview (~1600px long edge) per photo. Cache both in IndexedDB.
- Compute a perceptual hash in the same pass.
- Web Worker with incremental progress; the page stays responsive.
- Fingerprint each photo as `hash + filename + byte size + last modified` so cached derivatives and decisions re-associate on return.
- Flag unsupported files at load rather than dropping them silently.
- **MEASURED: this cannot hang off the decoder's return value.** libheif's `decode()` never throws — a JPEG, random bytes and an empty buffer all return an empty array. Worse, a *truncated* HEIC returns a handle reporting full, valid-looking dimensions, and only fails when `display()` invokes its callback with null. A decode returning length 0 means "unsupported"; everything else must be detected at the display callback.

### 7.10 Persistence

- Resume per tournament unit, including mid-pass in Stage A.
- Tree allocation and export labels persist with the session.
- New photos detected on resume, with a prompt to fold them in or start fresh.

### 7.11 Ranking mode

Culling subtracts toward a target; ranking **orders**. For a folder that needs
nothing thrown away — a 30-photo album, a 60-photo shortlist — the right product
is the ordering the bracket already computes, without the mandatory Stage A in
front of it.

- **Entry, two ways.** A per-folder toggle (⇅) on the allocation tree beside %
  and ∞ — all three change what the number *means*, so they share a column
  ("10" + rank is *order the top 10*, not *cut to 10*). And an offer on every
  unit's pass-setup screen, present at **every field size**: the price is the
  gatekeeper, not a size threshold. Ranking the top 10 of 60 reads as ~110
  comparisons; a full order of 742 prices itself out honestly.
- **Depth is the commitment.** The offer asks how deep, priced per option —
  winner only (exactly N−1), top-target in order, or the full order — with the
  projected cost of culling from the same point beside it, in the same time
  model. The depth locks when the ranking starts, the same shape as a pass
  quota: the cost is chosen before the first pairing is seen.
- **Depth and cap are distinct.** The engine decides `depth` places head to
  head; the standings still pre-choose the folder's **target** and draw the
  cutoff line there. Full-order ranking of a target-10 folder ranks all 30 and
  pre-chooses the top 10; an uncapped folder ranked in full arrives with
  everything chosen — an ordering with nothing cut unless rows are unpicked.
- **Cost, measured not modelled.** The engine's repechage reuses answers, so a
  full order costs ≈ N·(log₂N − 1) — ~116 comparisons for 30, ~290 for 60 —
  about 30% under the textbook count. Partial depth follows
  (N−1) + (depth−1)·log₂N. Both are asserted against the real engine in tests.
- **The duplicate gate is skipped, the grouping is not.** A session where every
  unit ranks goes straight to the offer; bursts are still bundled from ingest
  hashes so they compete as one, and a wrong bundle comes apart in the Stage C
  runoff, which every ranking passes through anyway. A mixed session keeps the
  review gate for everyone.
- Everything downstream is unchanged: standings, runoff, export. Rank prefixes
  in filenames make a ranked album's order durable on disk.

---

## 8. Architecture and constraints

**One self-contained HTML file, opened in a Chromium browser, pointed at a folder on disk.**

**MEASURED: "plus an asset folder" is not viable.** From a `file://` origin `window.origin` is the opaque string `"null"`, and `fetch`, `XMLHttpRequest`, `<script type="module" src>` and `new Worker('./w.js')` are all CORS-blocked. OPFS is blocked too. Classic `<script src>` is the only URL-based loading that survives, so an asset folder would work for plain scripts and nothing else — including the worker, which is the trap: a sibling `worker.js` works perfectly over localhost in development and throws at construction the moment a user double-clicks the file. Every worker is built from a blob URL instead.

What does work on `file://`, all verified: IndexedDB in full, including Blob, File and ImageBitmap round-trips, surviving a complete browser restart; `showDirectoryPicker` opening the real native dialog; `crypto.subtle`; untainted canvas; `importScripts` of an absolute `file://` URL from inside a blob worker.

| Decision | Choice | Reason |
|---|---|---|
| Delivery | Local HTML; asset folder permitted | Escapes claude.ai sandbox storage and memory limits |
| Browser | Chromium (Chrome, Edge, Brave, Opera) | File System Access API is Chromium-only; enables resume and disk-write |
| Source | Folder handle via drag-drop or picker | A directory handle is persistable; a file list is not |
| Persistence | IndexedDB | Folder handle, tree allocation, previews, hashes, decision state, labels |
| Storage caveat | **MEASURED: every `file://` page in a Chrome profile shares ONE origin bucket, `file__0`** | No per-file isolation and a shared quota, so the database name is explicitly namespaced |
| Cache durability | **MEASURED: `storage.persist()` returns false even on localhost in a fresh profile** | Treat the cache as evictable: every derivative must be re-derivable, and resume must restore decisions even when the cache is gone |

**Entry points:** drag a folder (yields a directory handle in Chromium), a choose-folder button, or drag loose files as a session-only fallback with resume and disk-write disabled, stated plainly.

| Constraint | Detail | Mitigation |
|---|---|---|
| Grid over-cutting | A strong photo on a strong screen gets cut | Shuffle on by default; cut pile rescue (§7.5) |
| Low cull rate | Generous quotas leave the pile intact | Locked quotas (§2); low cull rate warning (§7.2) |
| Allocation confusion | Four states across a nested tree can produce non-obvious results | Live totals, pooled remainder, clamping, dead-state flags (§4.5) |
| Chromium HEIC | Chrome never licensed HEVC and cannot decode HEIC natively | WASM decode at ingest; sidecars remove it later |
| HEIC ingest speed | WASM decode is the slowest step, at 83 ms per megapixel — 81% of the whole per-image pipeline | One-time, cached, worker-threaded, resumable. Budget ~4 minutes for 500 12MP HEICs on 4 cores |
| **HEIC decoder heap leak** | **MEASURED: the decode pattern in the libheif-js README leaks 6.35 MB of wasm heap per image — about 3.2 GB at this project's volume, which kills the tab. Invisible at the two-or-three-image scale anyone tests by hand.** | Reuse ONE `HeifDecoder` for the worker's lifetime AND call `.free()` on every handle in the array `decode()` returns. Both are required; either alone leaks identically. Verified flat across 200 sequential decodes |
| Sidecars cost more than they save | **MEASURED: a full-size q0.90 JPEG sidecar came out 11% LARGER than the HEIC it was made from.** §8 treated sidecars as a free speed win; at scale they roughly double the source folder | Generate the 1600px preview for display and defer any full-size sidecar to export, for chosen finalists only |
| Memory | 500 full-resolution decodes cannot coexist | Grid uses thumbnails; bracket decodes only the two on screen; originals unread until export |
| Disk writes | Tool writes sidecars and finalist folders | Never overwrites without asking; never modifies originals |
| Duplicate output files | Stage D duplicates winners across sets | Deliberate (§7.6); total output size reported before writing |
| Renamed files lose linkage | Labels change filenames | Original filename retained as final component; decision JSON records full mapping |
| Browser lock-in | Resume and disk-write are Chromium-only | Accepted deliberately; loose-file fallback degrades |
| Perceptual hash accuracy | **MEASURED: the risk is geometry, not expression.** A 5% crop lands at 10–14 bits, right at the threshold; 5° rotation and a 20% crop do not group at all. Expression does *not* reproduce as a risk: holding camera and exposure fixed and changing only the face moved the distance by at most 2 bits over 27 frames, because a face is ~3% of frame area and lands in one or two cells of a 1,024-cell grid. | Sensitivity slider, review, manual split and merge |
| IndexedDB quota | Cached previews consume disk | Cap preview dimensions, show cache size, offer clear-cache |

### Format handling

| Format | Handling |
|---|---|
| JPEG, PNG, WebP | Native Chromium decode. No special work. |
| HEIC | WASM decode via `libheif` at ingest, then JPEG sidecar. |
| RAW | Out of scope, flagged at load |

**HEIC sidecars.** Chromium cannot display HEIC. The tool decodes each HEIC once at ingest and writes a JPEG copy, called a sidecar because it rides along with the original. All screen display reads the sidecar; the original HEIC is never modified. This is what keeps later sessions fast, since the expensive decode happens once rather than every time. Sidecars are written to a **`_sidecars` subfolder by default**, configurable to sit alongside originals. At export the user chooses whether finalists come out as original HEIC or as JPEG sidecars; both files are retained, so the choice is per export.

---

## 9. Deferred and out of scope

### Deferred to v2

- **Sequential king-of-the-hill.** Champion-versus-challenger scanning. Roughly N×M comparisons because it discards what it learns between slots. Some users prefer its directness, so it stays on the roadmap. Not built in v1.

### Out of scope, v1

- Google Photos as a source (§10)
- RAW decoding (CR2, NEF, ARW, DNG)
- Image editing, rating sync, or writing back into original files
- Cloud sync or multi-device sessions
- EXIF-based automatic scoring or aesthetic ML models
- Video files
- Non-Chromium browsers as a supported target

---

## 10. Rejected options

**`0` as the no-limit sentinel.** Rejected in favor of `0` meaning excluded. Counting survivors is the meaning of every other value; making zero mean unbounded inverts the scale at one point.

**Deduplicating across output sets.** A photo winning both its category and the overall round is written to both folders. Deduplication would break the self-containment that makes each set directly usable.

**Deriving child targets from "whatever survives."** Considered for top-down distribution, but each tournament needs its target before its first grid pass in order to enforce quotas and estimate work (§4.4).

**Google Photos as a source.** As of March 31, 2025, Google removed the Library API read scopes. No third-party tool can read an existing library. The remaining Picker API requires manually selecting every photo in Google's UI each session, more work than the culling. Photos in Google Drive rather than Photos remain a viable future path.

**In-chat claude.ai artifact.** No persistent storage, so every reload means re-uploading, and no ability to write results back to disk.

**Claude Cowork as the runtime.** Built for delegating tasks; the clicking here is irreducibly the user's judgment. Still useful as a *build* venue given its filesystem access. Specifics need verification before committing.

**Native HEIC converters (HeifConvert, HEIF-Utility).** Both are Windows desktop binaries and cannot be called from a browser tab. HeifConvert is a thin wrapper over ImageMagick; use ImageMagick directly if CLI conversion is wanted. HEIF-Utility was archived in May 2021 and its authors now point to OS-native support. libheif compiled to WASM is the in-browser equivalent.

---

## 11. Build plan

| Phase | Deliverable | Proves |
|---|---|---|
| 1 | Folder ingest, tree construction, worker thumbnailer, HEIC WASM decode, `_sidecars` writer, progress UI, IndexedDB cache | The riskiest part (HEIC at volume) works before anything depends on it |
| 2 | Tree UI: five allocation states, dual uncapped entry, both math directions, weighted distribution, conflict, clamp, and dead-state rules | Allocation is correct before any culling depends on it |
| 3 | Stage A grid pass: paging, quota lock, shuffle, keyboard, undo, counters, low cull rate warning | Highest-leverage stage; usable on its own |
| 4 | Perceptual hashing, group review, sensitivity slider, representative nomination | Field shrinks correctly before ranking |
| 5 | Cut pile rescue with its own quota | Makes Stage A safe to trust |
| 6 | Stage B bracket with second-chance round; matchup UI with dual zoom | Fine ranking |
| 7 | Stage C burst runoff; export review with labels and prefixes; output writer with per-source naming, mirrored or flat structure, collision prompts, download bundles, decision JSON | Output |
| 8 | Stage D cross-category final | Best-of-the-best, reusing existing machinery |
| 9 | Resume: handle persistence, per-unit restore, new-file detection | Multi-sitting use |

Phase 1 first because HEIC decode is the riskiest unknown. Phase 2 second because allocation determines what every later stage operates on. Stage D lands late deliberately: it reuses stages A through C wholesale and adds no new mechanics.

---

## 12. Settings summary

Every option below is user-configurable; defaults shown.

| Setting | Default |
|---|---|
| Grid size | 9 per screen |
| Survivor quota | Keep up to half |
| Shuffle before paging | On |
| Low cull rate warning floor | 25% |
| Cut pile rescue limit | User-set per review |
| Cross-category final (Stage D) | Off |
| Ordered filename prefixes | On |
| Export labels | Empty |
| Output structure | Mirror source |
| Top-down distribution | Weighted by photo count |
| Sidecar location | `_sidecars` subfolder |
| Export format for HEIC finalists | Chosen per export |
| Uncapped entry | `*` typed or ∞ toggle, both always available |
| Ranking mode (§7.11) | Off; per-folder ⇅ toggle or the priced offer on pass setup |

---

## CHANGELOG

- v1.0 (2026-07-27): Initial release as `photo_culler_prd_v1.0.md`. Architecture decision, dual selection engines, near-duplicate grouping, HEIC WASM decode strategy, comparison budget, rejection of Google Photos, in-chat artifact, and Cowork-as-runtime.
- v1.1 (2026-07-27): Renamed project to Photournament. Added category-subfolder structure. Confirmed HEIC sidecar mode and dual-format export.
- v1.2 (2026-07-28): Restructured around a three-stage flow after clarifying that "king of the hill" meant a quota-limited grid pass. Added Stage A grid pass, Stage C burst runoff, and cut pile review.
- v1.3 (2026-07-28): Promoted the quota to a stated core principle. Added the unlimited-mode tension and cut-percentage warning. Gave cut pile rescue its own pre-committed limit.
- v1.4 (2026-07-28): Added folder hierarchy and finalist allocation as a first-class concept, plus the best-of versus representative-of distinction.
- v1.5 (2026-07-28): Expanded allocation to four states: Fixed, Excluded, Pooled, Uncapped. Defined `0` as excluded. Added uncapped parents where children are authoritative.
- v1.6 (2026-07-28): Reinstated the cross-category final as optional Stage D. Established intentional duplication across output sets. Added per-source output folder naming and scoped collision handling to disk writes.
- v1.7 (2026-07-28): Resolved all remaining open questions. Set the under-cut warning floor to a configurable 50% and rewrote §7.2 to distinguish it from early-stop. Added export review with per-finalist intent labels embedded in filenames, with originals retained and mapping recorded in the decision JSON. Made ordered prefixes a default-on toggle. Removed the nesting depth cap so the tree mirrors source structure at any depth, and made output structure default to mirroring with a flatten option. Set top-down distribution to weight by photo count by default, and recorded why "whatever survives" cannot work. Confirmed `_sidecars` as the default sidecar location. Gave uncapped both typed `*` and toggle entry. Added §12 settings summary. Marked the document ready for sign-off review.
- v1.8 (2026-07-28): Renamed "under-cut warning" to "low cull rate warning" after confirming the original term was invented rather than standard; cull rate and keeper rate are the terms photographers actually use. Revised the warning floor default from 50% to 25% and noted that 0 disables it.
- v1.9 (2026-07-28): Corrected against a working implementation. Replaced the estimated source material in §3 with a measured inventory — 746 stills rather than "roughly 500", GIF added, and 175 video files at 79% of the bytes made a recognised skipped category rather than an error. Rewrote §7.7's accuracy risk: expression does not reproduce as a failure, geometry does, and the measured defaults are pHash, strict mode, threshold 14, with a slider that must step by 2 because pHash is a constant-weight code. Recorded that §7.9's unsupported-file detection cannot hang off the decoder's return value, since a truncated HEIC reports valid dimensions and only fails at the display callback. Added §8 rows for the libheif heap leak that reaches ~3.2GB at volume, and for sidecars measuring larger than the originals they come from. Replaced §8's "plus an asset folder if needed" with the measured file:// constraint matrix that rules it out.
v1.9a (2026-07-28): §4.2 grows the Percent state — a share of the folder's own
  count, resolved to Fixed once counts are known. Shipped in v1.0 of the app;
  recorded here so the spec and the tool agree on how many states there are.
v1.10 (2026-07-30): Ranking mode (new §7.11). Culling subtracts, ranking
  orders: a per-folder ⇅ toggle on the tree and a priced offer on every pass
  setup screen let a unit skip Stage A and go straight to the bracket at a
  chosen depth. Depth is the pre-committed cost (winner only / top-target /
  full order, each priced against the measured engine); the standings cap
  stays the folder's target. Rank-only sessions skip the §7.7 review gate
  while keeping the bundling. §6 gains the ranking path, §12 the setting row.
