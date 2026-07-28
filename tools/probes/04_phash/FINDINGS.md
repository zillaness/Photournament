---
file: FINDINGS.md
probe: 04_phash — "what threshold groups a burst without gluing unrelated photos together?"
prd: photournament_prd_v1.8.md §7.7 (near-duplicate grouping), §7.9 (hash at ingest), §8 (accuracy risk row)
module: src/js/20_phash.js
date: 2026-07-28
status: MEASURED — every number below was produced by running the shipping module in Chromium from a file:// URL
---

# Perceptual hashing, clustering and nomination — findings

## Verdict

**Cluster on `phash`, in `strict` mode, at threshold 14.**

On a 122-frame corpus giving 7,381 labelled pairs, that combination scored
**precision 1.000 and recall 1.000**: every burst frame, expression variant,
JPEG re-encode and minor crop/rotation was grouped with its siblings, and not a
single unrelated pair was grouped with anything. The first false positive
appears at threshold 16, the first false negative at 13.

`dHash` has no threshold that does this. Its positive and negative populations
overlap in the band 11–14, so at its best setting (10) it still leaves 6 true
pairs ungrouped, and one step further it starts merging unrelated photos.

**PRD §8's flagged risk — "burst frames differing mainly in expression may not
group" — did not reproduce, and it is not close.** With the camera, exposure and
sensor grain held identical and only the face changed, the maximum distance over
27 expression frames at three subject scales was **2 bits** (pHash) and **1 bit**
(dHash), against a default threshold of 14 and a nearest unrelated pair at 16.
Even at a portrait framing where the head fills 39 % of the frame height, an
expression change moves the hash by 0–2 bits. Quantified in §5.

The interesting risk is the opposite one, and it is real: **rotation past ~2° and
crops past ~10 % break grouping entirely** (§4.4).

---

## 1. What was run, and where

| | |
|---|---|
| Browser | Chromium 141 (Playwright 1.56.1 bundle), headless, Linux x86_64, **4 vCPU** |
| Origin | **`file://`** — `location.protocol === 'file:'` asserted at the top of every run |
| Module load | `<script src="../../../src/js/20_phash.js">`, a classic script tag, the one URL-based load that survives `file://` (probe 01, matrix row 36) |
| Under test | `src/js/20_phash.js` itself. The probe has no private copy of the algorithm; `lib/analysis.js` and `lib/bench.js` call `window.PT.phash.*` |
| Console errors | 0 across every run (`results/console_errors.json`) |
| Wall time | 18–20 s for the whole probe: corpus, analysis, benchmarks |

Reproduce:

```bash
export NODE_PATH=/opt/node22/lib/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
node tools/probes/04_phash/run.js            # add --samples to dump sample JPEGs
```

### 1.1 Self-tests — 31 checks, all pass

Run before any measurement (`results/selftest.json`). The ones worth naming:

| check | result |
|---|---|
| `dhash` / `phash` return `/^[0-9a-f]{16}$/` | pass |
| identical input → identical hash, both hashes | pass |
| `hamming(x,x) === 0`, `hamming(all-ones, all-zeros) === 64` | pass |
| `hamming` symmetric, and obeys the triangle inequality over 216 triples | pass |
| pHash DC bit is always 0 | pass |
| `sharpness(sharp) > sharpness(blur(3px))` | pass (0.166 vs 0.002) |
| `cluster` result identical when the input array is shuffled, both modes | pass |
| groups sorted by smallest member id; ids sorted within a group | pass |
| every input id appears in exactly one group; singletons included; `[]` → `[]` | pass |
| union merges a 4-link chain into one group; strict refuses | pass |
| `nominate` singleton, tie-break on smallest id, tolerates `sharp: null` | pass |
| `dhash` rejects non-ImageData; `hamming` rejects wrong length; `cluster` rejects an unknown mode | pass |

---

## 2. The corpus

122 frames, rendered procedurally (no network in this environment, so no real
photographs), each pushed through a **real `canvas.toBlob('image/jpeg')` encode
and `createImageBitmap` decode** before hashing, so JPEG artefacts are in every
measurement. Hashed twice: at full 1200×800 resolution and at the PRD §7.9
320 px grid thumbnail.

| category | n | what it is |
|---|---:|---|
| `burst_tight` | 18 | same scene, <0.3 % subject displacement, ±1.2 % exposure, expression change, per-frame sensor grain, <0.15° jitter |
| `burst_loose` | 18 | same scene seconds apart: 3–4 % displacement, pose and arm change, ±6 % exposure, reframe, <0.7° rotation, ±1.8 % zoom |
| `expression` | 27 | **identical frame except the face** — same seed, same camera, same exposure, same grain seed. Three subject scales |
| `base` | 3 | the reference frame of each scene |
| `reencode` | 12 | q85 / q50 / q30 / 400 px re-encodes of the base frame |
| `geom_minor` | 6 | rot 1°, crop 5 % |
| `geom_major` | 6 | rot 5°, crop 20 % |
| `recompose` | 3 | same scene, 1.45× zoom, subject moved 24 % of frame width — the hard negative |
| `subject_move` | 3 | same subject, completely different scene |
| `nominate` | 18 | blur 1.5 px / blur 4 px / 480 px crisp downscale, from two source frames per scene |
| `chain` | 8 | an 8-frame pan, 5.5 % of frame width per step. The transitivity test |

Ground truth is structural, not eyeballed: each family gets its own terrain
seed, so "different scene" is unambiguous. Pairs are labelled `POS_*` (must
group), `NEG_*` (must not), or `AMB_*` (reasonable people disagree — reported,
but excluded from the headline error rates). 126 positive pairs, 7,084 negative,
171 ambiguous.

**Corpus realism is the main limitation of this probe.** A first version of the
scene generator produced smooth gradients with almost no mid-frequency energy;
unrelated frames landed at a median dHash distance of 21 instead of the ~28 real
photographs give, and the separation looked worse than it should. Adding a
scene-space multi-octave 1/f texture layer fixed the spectrum, and every number
in this document comes from the textured corpus. It is still not a photograph —
see §10.

---

## 3. Distance distribution by category

Hamming distance over all 7,381 pairs. Both hashes, full-resolution frames.

| pair category | n | dHash min / median / p95 / max | pHash min / median / p95 / max |
|---|---:|---|---|
| **POS** re-encode (q85–q30, 400 px) | 30 | 0 / 0 / 2 / **2** | 0 / 0 / 2 / **2** |
| **POS** expression only, wide (head ≈3 % of frame) | 9 | 0 / 0 / 0 / **0** | 0 / 0 / 0 / **0** |
| **POS** expression only, medium (≈9 %) | 9 | 0 / 0 / 0 / **0** | 0 / 0 / 0 / **0** |
| **POS** expression only, portrait (≈39 %) | 9 | 0 / 0 / 1 / **1** | 0 / 2 / 2 / **2** |
| **POS** burst tight, wide | 9 | 0 / 1 / 2 / **2** | 0 / 0 / 2 / **2** |
| **POS** burst tight, portrait | 9 | 0 / 0 / 2 / **2** | 0 / 2 / 4 / **4** |
| **POS** burst loose, wide | 9 | 2 / 4 / 8 / **8** | 0 / 2 / 6 / **6** |
| **POS** burst loose, portrait | 9 | 2 / 9 / 11 / **11** | 2 / 6 / 8 / **8** |
| **POS** geometry minor (rot 1°, crop 5 %) | 33 | 2 / 6 / 14 / **14** | 2 / 10 / 14 / **14** |
| *AMB* geometry major (rot 5°, crop 20 %) | 45 | 5 / 18 / 31 / 31 | 6 / 22 / 30 / 30 |
| *AMB* heavy degradation (blur, downscale) | 108 | 0 / 1 / 27 / 31 | 0 / 2 / 30 / 30 |
| *AMB* chain, one step apart | 7 | 11 / 18 / 23 / 23 | 8 / 12 / 16 / 16 |
| *AMB* chain, 2–3 steps apart | 11 | 23 / 31 / 39 / 39 | 20 / 26 / 34 / 34 |
| **NEG** same scene, recomposed | 408 | **18** / 28 / 34 / 37 | **20** / 28 / 34 / 36 |
| **NEG** same subject, different scene | 1422 | **13** / 27 / 35 / 42 | **16** / 30 / 34 / 42 |
| **NEG** unrelated | 5244 | **11** / 28 / 36 / 43 | **16** / 30 / 36 / 42 |
| **NEG** chain, ≥4 steps apart | 10 | **25** / 30 / 37 / 37 | **28** / 32 / 36 / 36 |

Read the bold columns against each other. For pHash the worst positive is **14**
and the best negative is **16**: the two populations do not touch. For dHash the
worst positive is **14** and the best negative is **11**: they overlap by four
bits, and no threshold can separate them.

### 3.1 pHash distances are always even

Every one of the 122 pHash values has **exactly 31 one-bits**
(`results/analysis.json → hashStats`). That is forced by the construction: 63
non-DC coefficients thresholded at their own median puts exactly 31 above it, and
the DC bit is pinned to 0. A constant-weight code has only even distances, and
all 7,381 measured pHash distances were even (dHash's split 3,705 odd / 3,676
even, as expected).

Consequence for PRD §7.7's sensitivity slider: **odd thresholds are dead stops on
pHash.** 15 behaves identically to 14, 11 to 10. Step the slider by 2, or the
user drags it and nothing happens half the time.

---

## 4. Threshold selection

### 4.1 The sweep

Pair-level, `AMB_*` excluded. 126 positives, 7,084 negatives.

**pHash**

| threshold | TP | FN | FP | false-negative rate | false-positive rate | precision | recall | F1 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 8 | 109 | 17 | 0 | 13.49 % | 0 | 1.000 | 0.865 | 0.928 |
| 10 | 116 | 10 | 0 | 7.94 % | 0 | 1.000 | 0.921 | 0.959 |
| 12 | 121 | 5 | 0 | 3.97 % | 0 | 1.000 | 0.960 | 0.980 |
| **14** | **126** | **0** | **0** | **0 %** | **0 %** | **1.000** | **1.000** | **1.000** |
| 16 | 126 | 0 | 16 | 0 % | 0.226 % | 0.887 | 1.000 | 0.940 |
| 18 | 126 | 0 | 70 | 0 % | 0.988 % | 0.643 | 1.000 | 0.783 |
| 20 | 126 | 0 | 181 | 0 % | 2.555 % | 0.410 | 1.000 | 0.582 |

**dHash**

| threshold | TP | FN | FP | false-negative rate | false-positive rate | precision | recall | F1 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 8 | 115 | 11 | 0 | 8.73 % | 0 | 1.000 | 0.913 | 0.954 |
| **10** | **120** | **6** | **0** | **4.76 %** | **0 %** | **1.000** | **0.952** | **0.976** |
| 11 | 121 | 5 | 42 | 3.97 % | 0.593 % | 0.742 | 0.960 | 0.837 |
| 12 | 121 | 5 | 63 | 3.97 % | 0.889 % | 0.658 | 0.960 | 0.781 |
| 14 | 126 | 0 | 118 | 0 % | 1.666 % | 0.516 | 1.000 | 0.681 |

### 4.2 Why 14, and why pHash

`DEFAULT_THRESHOLD = 14` is the only value on this corpus with **both** error
rates at zero, and it is the F1 maximum by definition. It is one even step above
the last false negative (13) and one even step below the first false positive
(16), so it sits in the middle of the perfect-separation interval rather than at
its edge.

pHash rather than dHash because of the shape of the two curves, not just the peak:

- pHash holds **precision at exactly 1.000 for every threshold from 4 to 15**,
  while recall climbs 0.79 → 1.00. Sliding the sensitivity control up only ever
  finds more true duplicates. Nothing wrong appears until 16.
- dHash's precision falls off a cliff between 10 and 11 — one step of the slider
  takes it from 1.000 to 0.742 — because the positive and negative populations
  genuinely overlap. There is no setting that groups every burst without also
  grouping unrelated photos.

The cost is that pHash is ~1.2× more expensive to compute (§7), which is
irrelevant: both are under 1 ms on the thumbnail the app already has.

`THRESHOLD_RANGE = [4, 20]`. Below 4, only re-encodes of the same file group
(recall 0.79 at 4). Above 20, pHash precision drops under 0.41 and the review
screen becomes a splitting chore. With pHash's even-only distances that is 9
usable stops.

### 4.3 The false negatives, named

At pHash 12 the 5 remaining false negatives are all `geom_minor` — 5 % crops and
1° rotations sitting at exactly distance 14. Raising to 14 collects them. There
are no burst or expression false negatives at any threshold ≥ 10.

Excluding the expression category entirely (in case a synthetic face flatters the
result — see §10), the sweep barely moves: 99 positives instead of 126, and pHash
still hits recall 1.000 / precision 1.000 at 14.

### 4.4 What does **not** group, at any usable threshold

Distance from the base frame, per scene, at full resolution:

| variant | dHash (S0/S1/S2) | pHash (S0/S1/S2) | groups at 14? |
|---|---|---|---|
| JPEG q85 / q50 / q30 | 0 / 0 / 0 | 0 / 0 / 0 | yes |
| downscale to 400 px | 1 / 0 / 2 | 0 / 0 / 2 | yes |
| blur 1.5 px | 1 / 0 / 0 | 2 / 0 / 0 | yes |
| blur 4 px | 1 / 0 / 2 | 2 / 0 / 0 | yes |
| 480 px crisp downscale | 0 / 0 / 0 | 0 / 0 / 0 | yes |
| rotate 1° | 4 / 4 / 2 | 4 / 4 / 2 | yes |
| crop 5 % | 7 / 14 / 8 | 14 / 10 / 12 | yes, just |
| **rotate 5°** | 9 / 14 / 13 | **16 / 10 / 16** | **no, 2 of 3** |
| **crop 20 %** | 21 / 31 / 27 | **22 / 30 / 30** | **no** |
| recomposed (1.45× zoom, subject moved) | 23 / 27 / 28 | 28 / 30 / 22 | no (correct) |
| same subject, different scene | 23 / 25 / 26 | 22 / 18 / 22 | no (correct) |

Both hashes are essentially immune to compression, resolution and blur, and
degrade fast under geometry. **A crop of 5 % lands at 10–14 bits — right at the
default threshold.** That is the real accuracy risk in this feature, not
expression. The PRD's §8 mitigation (slider, review, manual merge) is the right
answer; it is just pointed at the wrong failure mode.

---

## 5. The expression risk, quantified

PRD §8 lists "burst frames differing mainly in expression may not group" as a
known constraint. The `expression` category isolates exactly that: same terrain
seed, same camera, same exposure, **same sensor-grain seed**, subject in the same
position. The only pixels that differ are eyes, brows and mouth.

Maximum distance within an expression set (neutral / smile / laugh), over 3 scenes:

| subject scale | head ≈ % of frame height | max dHash | max pHash |
|---|---:|---:|---:|
| wide | 3 % | **0** | **0** |
| medium | 9 % | **0** | **0** |
| portrait | 39 % | **1** | **2** |

Against a default threshold of 14 and a nearest unrelated pair at 16, that is a
margin of 12–14 bits. **An expression change cannot break grouping** at any
threshold the slider offers.

The mechanism is obvious in hindsight and worth writing down: both hashes reduce
the frame to a 32×32 or 9×8 grid. A face occupying 39 % of the frame *height*
occupies roughly 3 % of its *area*, so the mouth lands inside one or two cells of
a 1,024-cell grid, and moving it changes at most those cells. For the risk to
bite you would need a face filling most of the frame — a head-and-shoulders
portrait tighter than anything in this corpus.

**Honest caveat.** The subject here is a drawn figure whose expression is a few
strokes: an arc for a smile, an ellipse for a laugh. A real face changes shading
across the whole face when it smiles, not just the mouth line. This measurement
establishes that the *geometry* of the concern is wrong — the face is too small a
fraction of the frame to matter — but it does not measure a photograph of a real
smile. Treat the 0–2 bit figure as a lower bound and the conclusion (expression is
not what breaks grouping) as well-supported but not proven on real faces. This is
the single result here most worth re-checking against a real burst.

---

## 6. Clustering mode: `strict` is the default

Perceptual hashes are not a transitive relation, and at the default threshold
this is common, not exotic:

| hash | A~B~C triples at threshold 14 | of those, A–C over threshold |
|---|---:|---:|
| dHash | 4,661 | **224 (4.8 %)** |
| pHash | 1,355 | **35 (2.6 %)** |

So the linkage rule is a product decision. Both are exposed as `mode`.

### 6.1 The chain case, explicitly

The 8-frame pan (`chain/c0` … `chain/c7`, 5.5 % of frame width per step) contains
the requested A~B~C configuration outright. pHash distances:

```
       c0   c1   c2   c3   c4   c5   c6   c7
c0      0   14   24   34   36   32   32   32
c1     14    0   10   24   30   28   32   34
c2     24   10    0   16   28   30   30   28
c3     34   24   16    0   16   26   32   32
c4     36   30   28   16    0   10   22   26
c5     32   28   30   26   10    0   12   20
c6     32   32   30   32   22   12    0    8
c7     32   34   28   32   26   20    8    0
```

Three triples break transitivity at threshold 14:

| A | B | C | d(A,B) | d(B,C) | d(A,C) |
|---|---|---|---:|---:|---:|
| c0 | c1 | c2 | 14 | 10 | **24** |
| c4 | c5 | c6 | 10 | 12 | **22** |
| c5 | c6 | c7 | 12 | 8 | **20** |

What each mode does with them, at threshold 14:

| mode | groups | worst group diameter |
|---|---|---:|
| `union` | `[c0 c1 c2] [c3] [c4 c5 c6 c7]` | **26** |
| `strict` | `[c0 c1] [c2] [c3] [c4 c5] [c6 c7]` | **14** |

Union puts `c0` and `c2` — 24 bits apart, well outside anything the user asked
for — in one group and calls them duplicates. Strict never produces a group whose
diameter exceeds the threshold, because that is what complete linkage means.

### 6.2 The same effect across the whole corpus

pHash, whole corpus, pair-level precision/recall against ground truth:

| mode | t | groups | largest group | precision | recall | worst group diameter |
|---|---:|---:|---:|---:|---:|---:|
| union | 10 | 39 | 11 | 1.000 | 1.000 | 16 |
| union | 12 | 37 | 11 | 1.000 | 1.000 | **26** |
| union | 14 | 36 | 11 | 1.000 | 1.000 | **26** |
| union | 16 | 31 | 11 | 0.759 | 1.000 | **36** |
| union | 18 | 20 | 27 | 0.205 | 1.000 | 42 |
| union | 20 | 7 | **93** | 0.030 | 1.000 | 42 |
| strict | 10 | 42 | 10 | 1.000 | 0.905 | 10 |
| strict | 12 | 40 | 11 | 1.000 | 0.952 | 12 |
| **strict** | **14** | **40** | **11** | **1.000** | **1.000** | **14** |
| strict | 16 | 37 | 11 | 0.977 | 1.000 | 16 |
| strict | 18 | 36 | 11 | 0.836 | 0.968 | 18 |
| strict | 20 | 33 | 11 | 0.741 | 0.952 | 20 |

Both reach perfect scores at 14. The difference is what happens when the user
moves the slider, which they will, because PRD §7.7 puts it on screen and calls
it live:

- **Union degrades catastrophically.** Two steps past the default it has merged
  93 of 122 photos into one group. dHash union is worse still: at 12 its
  precision is 0.510 and its largest group holds 22 photos.
- **Strict degrades gracefully.** At 20 — six steps too far — it still has 33
  groups, the largest holding 11, precision 0.741.

Three further reasons `strict` is the default:

1. **The slider means something.** Under strict, "threshold 14" is a guarantee
   that every photo in a group is within 14 bits of every other. Under union it is
   a statement about *some* path through the group, which is not a claim a user
   can act on.
2. **The failure mode is the recoverable one.** Strict's error is splitting one
   burst into two groups; PRD §7.7 has a merge button. Union's error is a group
   the user must inspect member by member to take apart.
3. **It is faster.** 0.40 ms vs 1.50 ms at 500 items (§7), because it never
   materialises the full O(n²) edge set.

**One caveat on strict, measured and worth knowing.** Greedy complete linkage is
not guaranteed monotonic in the threshold. With dHash, recall went 0.810 at 8 →
0.778 at 9 → 0.937 at 10 → 0.794 at 11: raising the slider *reduced* grouping.
With pHash, recall was monotonic across the whole useful range (0.786 at 4 through
1.000 at 14), which is one more reason to cluster on pHash. If a future change
moves clustering onto dHash, that non-monotonic slider response will be a visible
bug.

### 6.3 Determinism

`cluster()` sorts items by id before doing anything, and in strict mode a joining
photo picks the group with the smallest worst-case distance rather than the first
group that fits. Verified in the self-tests: shuffling the input array produces a
byte-identical result in both modes. Groups come back sorted by smallest member
id, ids sorted within each group, singletons included, every id present exactly
once.

---

## 7. Benchmarks

4 vCPU Xeon, headless Chromium, `file://`. Treat as a pessimistic floor; a laptop
will be faster.

### 7.1 Hashing throughput

| pixel scale | MP | `dhash` | `phash` | `sharpness` | all three |
|---|---:|---:|---:|---:|---:|
| **320 px thumbnail** (PRD §7.9) | 0.08 | 0.53 ms | 0.67 ms | 1.33 ms | **2.53 ms** |
| 1600 px preview | 1.92 | 12.6 ms | 12.7 ms | 13.7 ms | 39.0 ms |
| 12 MP full decode | 11.94 | 75.1 ms | 78.4 ms | 78.3 ms | 231.7 ms |

Cost is linear in pixel count and dominated by the greyscale conversion, which
each of the three entry points does independently.

**Hash the 320 px thumbnail, not the full decode.** For 500 photos that is
**1.3 s** of hashing versus **116 s**, against the ~241 s that probe 02 measured
for the whole 4-worker HEIC ingest. Hashing is a rounding error on the thumbnail
and a 48 % surcharge on the full decode.

Grouping is not measurably worse for it. Over all 7,381 pairs, the thumbnail dHash
differed from the full-resolution dHash by a median of **1 bit** (mean 0.93, p95
3, max 5), and clustering on `dhashThumb` in strict mode reproduces the
full-resolution precision of 1.000 up to threshold 12.

One implementation note found while benchmarking: the obvious "walk the output
grid, average the source box" downsample is **3.5× slower** at 9×8 output on a
1600 px source (39 ms vs 15 ms) than a single sequential scatter pass, because
each output cell strides across ~1 MB of source and the next cell re-walks the
same rows. `downsampleGrey` does the scatter, accumulating in a register and
touching memory only at bucket boundaries.

### 7.2 `hamming()`

2,000,000 calls: **139 ms total, 69.7 ns per call, 14.4 M calls/s.**
The 124,750 pairs of a 500-photo library cost **8.7 ms** if computed naively
through the public string API.

### 7.3 `cluster()`

Realistic input — families of 4 frames with 0–6 bits of noise, threshold 12:

| n | pairs | union | strict |
|---:|---:|---:|---:|
| 100 | 4,950 | 0.19 ms | 0.13 ms |
| 250 | 31,125 | 0.42 ms | 0.17 ms |
| **500** | **124,750** | **1.50 ms** | **0.40 ms** |

Degenerate inputs at n = 500, threshold 14:

| input | mode | ms | groups | largest |
|---|---|---:|---:|---:|
| all 500 hashes identical | union | 1.30 | 1 | 500 |
| all 500 hashes identical | strict | 0.56 | 1 | 500 |
| all 500 hashes far apart | union | 0.92 | 4 | 125 |
| all 500 hashes far apart | strict | 0.46 | 85 | 8 |

Both are far inside a single frame budget, so PRD §7.7's live sensitivity slider
can re-cluster on every drag with no debounce and no worker. Clustering is cheaper
than hashing one thumbnail.

`nominate()` on an 8-member group: **0.0002 ms**.

---

## 8. Representative nomination

`nominate()` scores each member inside its own group:

```
score = 0.70 * (sharp / maxSharp)  +  0.30 * (pixels / maxPixels)
```

### 8.1 Trials

Six independent source photographs, each with three deliberately degraded siblings
(blur 1.5 px, blur 4 px, and a crisp 480×320 downscale). A trial is the original
plus any non-empty subset of its siblings — 42 trials, the original always the
ground-truth answer. Members are passed in reverse-id order so that any accidental
first-wins behaviour would show up as a failure.

| trial size | trials | correct |
|---:|---:|---:|
| 2 members | 18 | **18** |
| 3 members | 18 | **18** |
| 4 members | 6 | **6** |
| **total** | **42** | **42 (100 %)** |

Identical result whether sharpness was measured on the full decode or on the
320 px thumbnail — which is the case that matters, since that is what the app will
have.

Sharpness is monotonic in blur radius for **6 of 6 ladders**, both at full
resolution and on the thumbnail:

| source | original | blur 1.5 px | blur 4 px | 480 px crisp |
|---|---:|---:|---:|---:|
| S0 base | 0.145 | 0.077 | 0.017 | 0.141 |
| S0 recompose | 0.218 | 0.111 | 0.019 | 0.179 |
| S1 base | 0.137 | 0.068 | 0.013 | 0.124 |
| S1 recompose | 0.169 | 0.083 | 0.012 | 0.144 |
| S2 base | 0.311 | 0.151 | 0.023 | 0.277 |
| S2 recompose | 0.359 | 0.196 | 0.025 | 0.303 |

A 1.5 px blur halves the score; a 4 px blur takes it to under 10 %. The metric
separates blur by a wide margin.

### 8.2 Why the resolution term exists

Weight controls, same 42 trials, scoring a trial correct only when the truth is the
**unique** maximum:

| weights | uniquely correct | undecided ties |
|---|---:|---:|
| 1.00 sharp / 0.00 resolution | 42 | 0 |
| **0.70 / 0.30 (shipped)** | **42** | **0** |
| 0.50 / 0.50 | 42 | 0 |
| 0.00 sharp / 1.00 resolution | 6 | **36** |

Sharpness alone also scores 42/42 here, so the resolution term is not *required*
on this corpus. It is there for margin, and the margin is the point. Look at the
`480 px crisp` column above: a downscaled but perfectly sharp copy scores within
**3–13 %** of the full-size original on contrast-normalised sharpness, because
that metric is deliberately resolution-invariant. Three to thirteen percent is
inside the noise of JPEG quality, exposure and scene content — on a slightly
different corpus it flips, and the app nominates a 480 px thumbnail as the
representative of a 12 MP burst. (An earlier, less-textured version of this same
corpus did exactly that: sharpness-only scored 38/42.) The resolution term turns
that 3 % margin into a decisive one: `0.30 × (1 − 0.16) = 0.25`.

The resolution-only control confirms the term cannot be allowed to decide on its
own: it leaves 36 of 42 trials tied, because blurred siblings usually have exactly
the same pixel count as the original.

### 8.3 When does resolution override sharpness?

Closed form, so the weighting can be read rather than guessed. A full-size frame
with relative sharpness *q* beats a smaller frame that is the group's sharpest when
`q > 1 − (0.30/0.70)(1 − r)`, where *r* is its pixel ratio:

| smaller frame's pixel ratio | sharpness the full-size frame needs to still win |
|---:|---:|
| 1.00 (same size) | 1.00 — resolution never breaks a same-size comparison |
| 0.50 | 0.79 |
| 0.25 | 0.68 |
| 0.16 (1200×800 vs 480×320) | 0.64 |
| 0.0625 | 0.60 |
| 0.01 | 0.58 |

So a full-resolution frame must be measurably soft — under ~64 % of the sharpest
member's score, roughly a 1 px blur — before a quarter-size crisp copy takes the
nomination from it. That is the intended behaviour: mild softness loses to
resolution, real blur does not.

### 8.4 Sample size, stated plainly

42 trials from **6 independent source photographs**. That supports "the ranking
function is not obviously broken and the metric separates blur cleanly". It does
not support a precision figure for real bursts, where the sharp frame differs from
the soft one by camera shake rather than a Gaussian blur filter, and where two
frames are often equally sharp with different subjects in focus. PRD §7.7's
one-click override is doing real work and should not be treated as a nicety.

---

## 9. What this means for the PRD

- **§7.7 "auto-group by perceptual hash Hamming distance, with a live sensitivity
  slider"** — buildable as specified. Default: pHash, `strict`, 14. Slider range
  4–20, **stepping by 2** (§3.1). Re-clustering 500 photos costs 0.40 ms, so the
  slider can be genuinely live.
- **§7.7 "each group nominates one representative via a sharpness and resolution
  heuristic"** — implemented as a group-normalised weighted score, 42/42 on the
  probe's blur ladders.
- **§7.9 "compute a perceptual hash in the same pass"** — do it on the 320 px
  thumbnail the ingest pass already produces. 2.5 ms per photo for both hashes plus
  sharpness; 1.3 s for 500 photos, against ~241 s for the HEIC ingest itself.
- **§8 accuracy risk row** — the wording should change. "Burst frames differing
  mainly in expression may not group" did not reproduce (0–2 bits at every subject
  scale tested). The measured risk is **geometry**: a 5 % crop lands at 10–14 bits,
  right at the default threshold, and a 5° rotation or 20 % crop does not group at
  all. Suggested replacement: *"Cropped or rotated versions of the same photo may
  not group; expression and exposure changes do not affect grouping."*
- **§7.7 "manual split, merge, remove, confirm"** — strict linkage makes *split*
  the rarer operation and *merge* the common one, which is the cheaper direction
  for the user. Worth reflecting in the UI's prominence.

---

## 10. Not verified

- **Real photographs.** No network in this environment, so the corpus is
  procedurally rendered. The texture layer added in §2 gives it a plausible 1/f
  spectrum, but real photographs have structured high-frequency content (faces,
  text, foliage detail) that a noise field does not. Expect the negative
  distribution on real photos to sit *higher* than measured here, which would make
  threshold 14 more conservative, not less — but that is a prediction, not a
  measurement.
- **Real faces.** See §5. The expression result is the most important claim here
  and rests on a drawn figure.
- **Real camera shake.** The blur ladders are a Gaussian `ctx.filter`, not motion
  blur, and every frame in a nomination trial is blurred uniformly. Real burst
  frames differ by subject motion and focus plane, where the sharpest frame is
  sharpest only in part of the image.
- **HEIC-decoded input.** All frames went through canvas JPEG. A HEIC decoded via
  libheif produces RGBA the same way (probe 02 §3), so this should not matter, but
  the two paths were never compared hash-for-hash.
- **EXIF orientation.** Probe 02 §9 flags `irot`/`imir` as untested. A sideways
  decode would hash as a 90° rotation, which §4.4 shows both hashes fail
  completely. If orientation handling is wrong anywhere in ingest, it will surface
  here as bursts that refuse to group.
- **Scale.** Clustering was measured at 500 synthetic items and 122 real ones. The
  O(n²) cost is 1.5 ms at 500; at 5,000 it would be ~150 ms, still fine, but the
  quality of grouping at that scale was not measured.
- **10-bit / HDR input.** `toGrey` assumes 8-bit sRGB-ish RGBA.
- **Non-headless, non-Linux Chromium.** Same caveat as probes 01 and 02.

---

## 11. Files

| path | what |
|---|---|
| `harness.html` | loads the shipping module + probe libs from `file://`; exposes `selfTest`, `runCorpus`, `runAnalysis`, `runBench` |
| `run.js` | Playwright driver; asserts the `file://` origin, runs everything, writes `results/*.json` |
| `lib/scenegen.js` | seeded synthetic scene renderer (terrain, clutter, 1/f texture, figure with a real face, grain, vignette, post transforms) |
| `lib/corpus.js` | the 122-frame corpus spec and the render → JPEG → decode → hash pipeline |
| `lib/analysis.js` | ground-truth pair labelling, distributions, threshold sweeps, clustering scoring, transitivity, nomination trials |
| `lib/bench.js` | hashing / hamming / cluster / nominate throughput, including degenerate inputs |
| `results/selftest.json` | the 31 correctness checks |
| `results/corpus_records.json` | every frame with both hashes at both scales, sharpness, dimensions |
| `results/analysis.json` | every table in this document, raw |
| `results/bench.json` | every benchmark, raw |
| `results/module_shape.json` | the exported API surface as observed in the browser |
| `corpus/` | sample JPEGs, written only with `--samples`. **Delete after looking at them** |
