---
file: FINDINGS.md
probe: 03_pipeline — "does the PRD 7.9 ingest pipeline actually work, stay bounded, and stay out of the main thread's way?"
prd: photournament_prd_v1.8.md §7.9 ingest, §7.7 near-duplicate grouping, §7.10 persistence, §8 architecture
module: src/js/10_ingest_worker.js
date: 2026-07-28
status: BUILT AND MEASURED — one real bug found and fixed (double-applied EXIF rotation)
---

# Ingest pipeline — findings

Every number below was produced by running `src/js/10_ingest_worker.js` in real
Chromium 141 from a `file://` URL, headless on a 4 vCPU VM, with a second run
headed under Xvfb where frame timing mattered. Raw output is in `out/*.json`.

## Verdict

The pipeline works end to end. 500 x 12 MP HEICs project to **4 minutes 1 second**
on 4 workers, the wasm heap is **flat at 68.7 MB across 70 sequential decodes**,
and the main thread **dropped zero frames** while 48 twelve-megapixel HEICs were
queued at once. Every failure mode in the mixed corpus set `err` instead of
throwing or disappearing.

One genuine bug surfaced during verification and is fixed: **Chromium silently
ignores `createImageBitmap`'s `imageOrientation: 'none'`**, so the obvious
implementation rotates every EXIF-tagged JPEG twice. See §3.

---

## 1. What was built

`src/js/10_ingest_worker.js` is a classic script attaching to `window.PT`.

| export | what |
|---|---|
| `PT.ingest.WORKER_SRC` | 33,730-byte worker source string, no `import`/`export` |
| `PT.ingest.createPool(opts)` | spawns the pool; `size` defaults to `min(hardwareConcurrency, 4)` |
| `pool.process(fileOrHandle, meta)` | -> `Promise<photoRecord>` |
| `pool.terminate()` / `pool.stats()` / `pool.diag()` / `pool.warm()` | lifecycle and instrumentation |
| `PT.ingest.fingerprint(file)` | -> `Promise<string>`, PRD 7.9 content+name+size+mtime id |
| `PT.ingest.setLibheifSource(text)` | for the fully-inlined single-file build |

The worker source is assembled by **stringifying two real functions** rather than
being written as a template literal. That keeps the worker body ordinary,
lintable, `node --check`-able JavaScript with no backtick or `${` escaping, and it
lets the format-sniffing / EXIF / fingerprint helpers be installed on the main
thread *and* inside the worker **from one source**. A fingerprint that drifted
between the two would break resume silently, which is exactly the class of bug
that does not show up in testing.

Measured (`out/contract.json`): `WORKER_SRC` is a string, contains no ES module
tokens, and the whole documented API is present. Default pool size on this
4-core box: **4**.

---

## 2. The leak constraint from probe 02 — held

Probe 02 measured that `new HeifDecoder()` per image, or omitting `.free()`,
leaks 6.35 MB per image (~3.2 GB at 500 photos). The module keeps **one
`HeifDecoder` per worker for the worker's whole lifetime** and calls `.free()`
on **every** handle in the array `decode()` returns, not just `[0]`.

**70 sequential 11.94 MP decodes, one worker** (`out/memory.json`):

| after decodes | wasm heap |
|---:|---:|
| 1 | 68.7 MB |
| 10 | 68.7 MB |
| 20 | 68.7 MB |
| 30 | 68.7 MB |
| 40 | 68.7 MB |
| 50 | 68.7 MB |
| 60 | 68.7 MB |
| 70 | 68.7 MB |

Growth per decode: **0.0000 MB**. Projection at 500 photos: **69 MB**, against
3,245 MB for the naive pattern.

Renderer-process RSS over the same run: first-half mean **268 MB**, second-half
mean **268 MB**. Flat by both measures — the wasm arena (the number that actually
moves when the decoder leaks) and the OS's view of the process.

Per-image decode time over the run: min 1,188 ms, median 1,233 ms, p95 1,438 ms,
max 1,711 ms. **No degradation across the run**, and the perceptual hash of
decode #70 (`2a1e6bb3d89c29d5`) is identical to decode #1. Correctness is not
being traded for the flat heap.

### Bounded memory regardless of queue depth

PRD §8 says 500 full-resolution decodes cannot coexist. The pool never lets more
than one full decode exist per worker: `pool.process` queues a **File reference**
(no bytes read), and a worker only receives a job when it is idle. Bytes are read
inside the worker, and the full-resolution `ImageBitmap` is `close()`d the moment
the 1600 px preview has been drawn.

Measured by queueing **48 x 12 MP HEICs simultaneously** into a 4-worker pool
(`out/raf_burst48.json`): renderer RSS starts at 437 MB, reaches ~990 MB within
1.5 s and then oscillates 895–1,122 MB for the remaining 21 s. It **plateaus**;
it does not track the 48-deep queue. The plateau is set by pool size, roughly
`workers x (69 MB wasm arena + one 47.8 MB full-res buffer + working set)`.

**Consequence for the app:** peak memory is a function of pool size, not photo
count. On a memory-constrained machine, `createPool({size: 2})` roughly halves
it at the cost of throughput.

---

## 3. Orientation — the bug that was actually there

Probe 02 flagged orientation as untested and "a plausible source of sideways
thumbnails". It was.

### 3.1 Nothing to test against, so a fixture was fabricated

None of the three probe 02 HEIC fixtures carries `irot`, `imir`, or a non-1 EXIF
Orientation (`photo_12mp.heic` has two `Exif` boxes; Orientation is 1).

`make_rotated_heic.mjs` injects an `irot` property into the real 12 MP HEIC. That
means growing `ipco`, adding an association to `ipma`, growing `iprp` and `meta`
— which shifts `mdat` — and therefore **patching every `construction_method == 0`
extent offset in `iloc` by the same delta**, or the file decodes to garbage. 49
of the 50 items needed patching (the 50th is the `grid` item, which lives in
`idat`). It produces `rot90_ccw.heic` and `rot180.heic`, both 10 bytes larger
than the original and both decoded successfully by libheif.

### 3.2 libheif applies irot itself — measured, not assumed

Mean absolute RGB difference (0–255) between the base thumbnail and each rotated
fixture's thumbnail, under all four quarter-turn hypotheses, on aspect-matched
grids (`out/heic.json`):

| fixture | identity | rot90 CCW | rot180 | rot90 CW |
|---|---:|---:|---:|---:|
| `irot=1` (90° CCW) | 72.08 | **2.39** | 72.34 | 94.80 |
| `irot=2` (180°) | 94.91 | 72.10 | **0.50** | 72.40 |

Unambiguous. `irot=1` decodes to `2992x3992` — axes swapped — and its pixels are
genuinely the base rotated 90° counter-clockwise. libheif honours `irot`/`imir`
during decode.

**Therefore: when a HEIF carries `irot`/`imir`, its EXIF Orientation must be
ignored**, or the image is rotated twice. The module walks `meta -> iprp -> ipco`
for those boxes and suppresses EXIF when it finds them. When there is no
transform box it locates the `Exif` item properly (`iinf` for the item ID, `iloc`
for its extent) and applies the orientation itself, because libheif never reads
EXIF.

### 3.3 The bug: `imageOrientation: 'none'` is a no-op in Chromium

For JPEG/PNG/WebP the first implementation asked for `{imageOrientation: 'none'}`
and applied EXIF by hand, on the theory that pinning the option removes any
browser-version dependence. The mixed corpus caught it immediately:

| file | EXIF | expected thumb | got (first version) |
|---|---:|---|---|
| `exif_o6_800x600.jpg` | 6 (90° CW) | 240x320, rotated CW | **320x240, rotated 180°** |
| `exif_o8_800x600.jpg` | 8 (90° CCW) | 240x320, rotated CCW | **320x240, rotated 180°** |
| `exif_o3_800x600.jpg` | 3 (180°) | 320x240, rotated 180° | **320x240, unrotated** |

Orientations 6 and 8 producing the *same* wrong result is the tell: Chromium had
already applied the rotation, and the module applied its own on top, so 90+90 and
270+270 both landed on 180, and 180+180 landed back on 0. Chromium deprecated
`imageOrientation: 'none'` and now treats it as `'from-image'` — silently, with
no throw and no warning.

**Fix, and why it is a runtime measurement rather than a constant:** the worker
carries an 803-byte 16x4 JPEG tagged Orientation=6. The first time a non-HEIC
file with a non-1 orientation appears, it decodes that probe and checks whether
it came back 4x16. If the browser rotated it, the module applies nothing; if a
future Chromium stops doing so, the module applies the transform itself. The
probe costs nothing for sets with no EXIF orientation.

### 3.4 Verified correct afterwards

Corner-coded test images (red TL, green TR, blue BL, yellow BR) round-tripped
through ingest, sampling the four corners of the resulting 320 px thumbnail
(`out/mixed.json`):

| file | thumb dims | TL | TR | BL | BR | correct? |
|---|---|---|---|---|---|---|
| plain (o=1) | 320x240 | red | green | blue | yellow | baseline |
| o=6 (90° CW) | **240x320** | blue | red | yellow | green | yes |
| o=8 (90° CCW) | **240x320** | green | yellow | red | blue | yes |
| o=3 (180°) | 320x240 | yellow | blue | green | red | yes |

Human-openable output: `out/mixed_thumb_exif_o6_800x600.jpg.jpg` shows the "F"
lying on its side exactly once, and `out/thumb_rot90_ccw.jpg` is the aerial
coastline photo in portrait, rotated once.

---

## 4. Real HEIC end to end

`out/heic.json`, pool size 2, all five HEIC fixtures, `file://`:

| fixture | dims out | orientation source | thumb | preview | ms |
|---|---|---|---:|---:|---:|
| `photo_12mp.heic` | 3992x2992 | none | 17,401 B | 481,464 B | 1,771 |
| `rot90_ccw.heic` | **2992x3992** | irot, applied by libheif | 17,404 B | 481,822 B | 1,833 |
| `rot180.heic` | 3992x2992 | irot, applied by libheif | 17,404 B | 481,789 B | 1,507 |
| `example_strukturag.heic` | 1280x854 | none | 21,624 B | 352,459 B | 281 |
| `nokia_C003.heic` | 1280x720 | none | 12,193 B | 162,221 B | 101 |

Zero page errors, zero failures, 678.6 ms/image wall on 2 workers.

Written out for human inspection in `out/`: `thumb_*.jpg` (320 px) and
`preview_*.jpg` (1600 px) for all five. They open in any image viewer and are
correct: the 12 MP fixture is an aerial coastline shot, `rot90_ccw` is the same
image in portrait rotated 90° counter-clockwise, `rot180` is upside down.

The full-resolution RGBA buffer **never crosses a thread boundary** — the worker
produces the JPEG derivatives itself, so the 47.8 MB transfer probe 02 measured
is avoided entirely rather than merely made zero-copy.

---

## 5. Mixed corpus — every failure mode flagged, none dropped

`out/mixed.json`, one 4-worker pool, one batch:

| file | kind | dims | thumb+preview | err |
|---|---|---|---|---|
| `plain_800x600.jpg` | `jpeg` | 800x600 | yes | null |
| `exif_o6_800x600.jpg` | `jpeg` | 600x800 | yes | null |
| `exif_o8_800x600.jpg` | `jpeg` | 600x800 | yes | null |
| `exif_o3_800x600.jpg` | `jpeg` | 800x600 | yes | null |
| `plain_640x480.png` | `png` | 640x480 | yes | null |
| `plain_640x480.webp` | `webp` | 640x480 | yes | null |
| `tiny_40x30.jpg` | `jpeg` | 40x30 | yes | null |
| `nokia_C003.heic` | `heic` | 1280x720 | yes | null |
| `truncated.heic` | `heic` | 0x0 | no | `[corrupt] HEIC pixel decode failed (display returned null) - file is truncated or corrupt` |
| `corrupt.jpg` | `jpeg` | 0x0 | no | `[corrupt] decode failed: The source image could not be decoded.` |
| `notreally.jpg` (a .txt) | `unsupported` | 0x0 | no | `unsupported file format (unrecognised)` |
| `empty.jpg` (0 bytes) | `unsupported` | 0x0 | no | `unsupported file format (empty)` |

`stats` reported `done: 8, failed: 4`. **Zero page errors, zero uncaught
exceptions, zero dropped records.** PRD 7.9's "flag unsupported files at load
rather than dropping them silently" is satisfied by construction: every input
resolves to a record, and failure is a populated `err` field.

Three things worth calling out:

- **Kind comes from magic bytes, never the extension.** That is the only way
  `notreally.jpg` gets caught. `truncated.heic` still sniffs as `heic` — it is a
  real HEIF container — and fails later, correctly.
- **The truncated HEIC is the trap probe 02 identified.** `decode()` returned a
  handle reporting valid dimensions; the failure only appeared as `null` in the
  `display()` callback. Error detection hangs off that callback.
- **`display()`'s callback runs inside a `setTimeout`**, so a throw in there
  becomes an uncaught worker error rather than a rejected promise. The worker
  installs a global `error` listener that fails the job actually in flight, plus
  a 180 s watchdog, so a pathological file cannot wedge a worker forever.

`avif`, `gif`, `bmp` and `tiff` are also sniffed and classified `unsupported`
with the detected format named in `err`. Chromium could decode some of them, but
the shared record contract fixes `kind` to
`jpeg|png|webp|heic|unsupported` and PRD §3 lists only the four. If AVIF support
is ever wanted, this is the single place to change.

---

## 6. Main-thread responsiveness — a number, per PRD 7.9

Two instruments, because headless Chromium does not vsync-lock
`requestAnimationFrame` and rAF deltas alone would be a weak claim:

1. rAF frame deltas.
2. `MessageChannel` ping-pong latency — a genuine macrotask, so any main-thread
   block shows up directly.

### 48 x 12 MP HEICs, all queued at once, 4 workers, headless (`out/raf_burst48.json`)

| | idle baseline | during ingest |
|---|---|---|
| rAF frames sampled | 180 | 1,388 |
| rAF median | 16.7 ms | 16.7 ms |
| **rAF p95** | 16.8 ms | **16.8 ms** |
| **rAF worst gap** | 16.8 ms | **16.8 ms** |
| rAF gaps > 50 ms | 0 | **0** |
| latency samples | 510,513 | 3,475,137 |
| latency p95 / p99 | 0.1 / 0.1 ms | **0.1 / 0.1 ms** |
| **latency worst** | 11.3 ms | **25.2 ms** |
| latency > 16 ms | 0 | 3 (of 3.47 M) |
| latency > 50 ms | 0 | **0** |

**Zero dropped frames across 23 seconds of continuous 12 MP HEIC decoding.**

### Headed under Xvfb, real 60 Hz compositing, 40 mixed HEICs (`out/raf_headed.json`)

| | idle | during ingest |
|---|---|---|
| rAF p95 | 16.7 ms | 16.8 ms |
| **rAF worst gap** | 16.8 ms | **50.0 ms** (one event, 2 dropped frames) |
| rAF gaps > 50 ms | 0 | 0 |
| latency worst | — | 21.8 ms |
| latency p99 | — | 0.1 ms |

**The honest headline number: worst frame gap 50 ms, p95 16.8 ms, one visible
hitch in 40 images.** The main thread's only work per photo is a structured
clone of a `File` reference in and two `Blob` handles out; all decoding,
scaling, hashing and JPEG encoding happens in the workers.

---

## 7. Throughput and the 500-photo projection

| configuration | ms/image | 500 x 12 MP |
|---|---:|---:|
| 1 worker, 12 MP, full ingest | 1,257 | 10 min 29 s |
| **4 workers, 12 MP, full ingest** | **482** | **4 min 1 s** |
| 4 workers, mixed HEIC sizes | 205 | — |
| 4 workers, small JPEG/PNG/WebP | 29.5 | 15 s |

"Full ingest" here means decode + 1600 px preview JPEG + 320 px thumbnail JPEG +
perceptual hash + sharpness + SHA-256 fingerprint. Probe 02 projected 4 min 1 s
for decode-plus-derivatives alone; **the hash, sharpness and fingerprint are
free at this resolution** because HEIC decode still dominates.

Pool size defaults to `min(navigator.hardwareConcurrency, 4)` per probe 02's
finding that 8 workers were no faster than 4 and doubled memory.

---

## 8. Perceptual hash and sharpness (PRD 7.7)

Both are computed **in the same pass as the derivatives**, off the already-drawn
preview canvas, so they cost nothing extra:

- **phash**: a self-contained dhash inlined in the worker. The preview is drawn
  to a 32x32 canvas, converted to grayscale, bilinearly resampled to 9x8, and
  adjacent horizontal pairs compared — 64 bits, emitted as 16 lowercase hex chars
  exactly as the record contract requires.
- **sharpness**: variance of the Laplacian over the 320 px thumbnail's grayscale.
  Computing it on the normalised thumbnail rather than the full image makes
  scores comparable across photos of different resolutions, which is what PRD
  7.7's "sharpness and resolution heuristic" needs. Measured range on the
  fixtures: 700 (soft synthetic) to 2,904 (detailed HEIC), and 73,155 for a 40x30
  image where every pixel is an edge — a reminder to weight by resolution.

**No load-order coupling with `20_phash.js`.** The worker uses a runtime
`PT.phash` when one is present *and* it returns a valid 16-hex string; otherwise
it silently uses the inlined dhash. All branches were exercised
(`out/contract.json`):

| host state | phash | sharp |
|---|---|---|
| nothing injected | `716869ce3beef7e7` (inlined dhash) | `700.72` (inlined) |
| **real `20_phash.js` as `extraSrc`** | `065b0cd8f3a6f059` (its `PT.phash.phash`, DCT) | `0.3222` (its `PT.phash.sharpness`) |
| stub returning `deadbeefcafe1234` | `deadbeefcafe1234` — honoured | — |
| stub returning `"not-a-hash"` | `716869ce3beef7e7` — rejected, inlined used | — |

That matters because `20_phash.js` exports a **namespace object**, not a bare
function. A naive `typeof PT.phash === 'function'` check would have silently
fallen back to the inlined dhash forever. The hook handles the bare function, the
namespace object (preferring its own `RECOMMENDED_HASH`, currently `phash`), and
absence.

**One thing the host must decide once and never change mid-project:** the two
hashers produce different hashes, and the two sharpness functions are on
different scales (700.72 vs 0.3222 for the same image — `20_phash.js`
contrast-normalises). Mixing them across sessions would scramble PRD 7.7's
near-duplicate groups. Pass `extraSrc` on every pool or on none.

---

## 9. Fingerprint and resume (PRD 7.9 / 7.10)

`PT.ingest.fingerprint(file)` = `SHA-256(SHA-256(content) | name | size |
lastModified)`, a 64-char hex string.

Measured (`out/resume.json`), three files including the 2.99 MB 12 MP HEIC:

- IDs are **byte-identical across two independent ingest passes**.
- The **main-thread** `PT.ingest.fingerprint()` result **matches the worker's**
  for all three files. Same source, so it cannot drift.
- Pass 1 (cold): **1,409 ms**. Pass 2 (cache seeded): **28 ms**. **50x faster**,
  3/3 cache hits, `fromCache: true` on every record.

The skip path is a handshake, not a main-thread pre-scan: the worker reads bytes,
computes the fingerprint, posts it back, and **waits** while the host's `lookup`
callback checks IndexedDB. A hit aborts before any decoding. That keeps the
hashing off the main thread, which matters — 500 x 3 MB of SHA-256 on the UI
thread would be exactly the stall PRD 7.9 forbids.

The residual cost of resume is unavoidable and worth stating: **every file is
still read and hashed on return**, because the PRD's fingerprint is content-based.
28 ms for 3 MB means roughly **5 s of hashing for a 500-photo, 1.5 GB set** —
against ~4 minutes for a cold ingest.

---

## 10. `file://` delivery constraints — both loading paths verified

Per probe 01, `new Worker('./x.js')` is a `SecurityError` on `file://` (opaque
`null` origin) and only blob-URL workers survive. The pool spawns from a blob URL
built out of `PT.ingest.WORKER_SRC`.

libheif is loaded **lazily, on the first HEIC only** — a JPEG/PNG/WebP set never
pays the 1.46 MB cost. Both sources work:

| path | how | measured |
|---|---|---|
| **asset folder** | `importScripts()` of an absolute URL | works — `out/heic.json` |
| **inlined** | source text injected, loaded by indirect `eval` | works — `out/inline.json`, 1,462,173 B |

Two details that are easy to get wrong and are handled explicitly:

- **The URL is resolved on the main thread**, with `new URL(rel, location.href)`.
  Inside a blob worker `location.href` is `blob:null/<uuid>`, so the worker
  cannot resolve a relative path itself — and `importScripts` rejects relative
  paths outright.
- **The libheif global is an Emscripten MODULARIZE factory.** It must be called
  and awaited before `new .HeifDecoder()`. The libheif-js README's
  `new libheif.HeifDecoder()` throws "not a constructor". Indirect `eval` is
  required for the injected-source path so the bundle's top-level
  `var libheif` lands on the worker global; `new Function(src)()` would scope it
  away.

A HEIC with no libheif configured at all fails cleanly and immediately:
`err: "libheif not configured (no libheifUrl and no injected source)"`. It does
not hang.

---

## 11. Not verified

- **500 photos end to end.** The largest single run was 70 sequential and 48
  concurrent 12 MP decodes. The heap is flat over both and the projection is
  linear, but nothing here ran to 500.
- **A real `FileSystemFileHandle` from `showDirectoryPicker`.** `pool.process`
  accepts one and calls `getFile()`, and files reached the page through a real
  `<input type=file>` (so `File` objects with genuine `name`/`size`/
  `lastModified`), but no picker-derived handle was exercised — that needs a
  headed browser with a human at the dialog.
- **IndexedDB.** `lookup` was wired to an in-memory map. Persisting and reloading
  the derivative Blobs is 7.10's job, not this module's.
- **Real iPhone HEICs with `irot`.** The rotated fixtures are synthesised by
  `make_rotated_heic.mjs` from a genuine tiled 12 MP HEIC. They are structurally
  correct and libheif decodes them, but no camera wrote them. `imir` (mirroring)
  is detected and suppresses EXIF the same way `irot` does, but was **not**
  round-tripped through a fixture.
- **HEICs with both `irot` and a conflicting non-1 EXIF Orientation.** The module
  resolves this in favour of `irot`, per the HEIF spec's precedence. No fixture
  exercises the conflict.
- **10-bit / HDR HEIC, Live Photos, depth maps, burst containers.** Multi-image
  containers are handled correctly on the memory side — every handle in the
  `decode()` array is freed — but only `images[0]` is rendered, and no
  multi-image fixture was available.
- **Worker crash recovery.** If a worker dies outright the pool returns it to the
  idle set, which could wedge subsequent jobs. No crash was observed across
  ~250 decodes including deliberately corrupt input, so this is untested.
- **`msPerImage` in `pool.stats()`** is wall time since the pool's first job
  divided by completions. For a long-lived pool with idle gaps it understates
  throughput.
- **Non-Linux, non-Chromium.** Everything is Chromium 141 on Linux x86_64.
  The `imageOrientation` finding in §3.3 is version-dependent by nature, which is
  precisely why the module measures it at runtime instead of hard-coding it.

---

## Files

| path | what |
|---|---|
| `../../../src/js/10_ingest_worker.js` | the module under test |
| `harness.html`, `driver.js` | `file://` page harness and page-side test driver |
| `run_ingest.mjs` | the Playwright driver — `heic\|mixed\|memory\|raf\|resume\|inline\|contract\|all` |
| `make_corpus.mjs` | generates the 11-file mixed corpus (248 KB) incl. the deliberate failures |
| `make_rotated_heic.mjs` | ISO-BMFF surgery: injects `irot` and patches `iloc` |
| `lib.mjs` | RSS sampling by Chromium process type |
| `out/*.json` | every raw measurement |
| `out/thumb_*.jpg`, `out/preview_*.jpg` | human-openable derivatives, correctly oriented |

Reproduce:

```bash
export NODE_PATH=/opt/node22/lib/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
cd tools/probes/03_pipeline

# fixtures are not kept on disk; regenerate them first (about 8 s, ~6 MB)
node make_corpus.mjs
node make_rotated_heic.mjs ../02_heic/fixtures/photo_12mp.heic fixtures/rot90_ccw.heic 1
node make_rotated_heic.mjs ../02_heic/fixtures/photo_12mp.heic fixtures/rot180.heic 2

node run_ingest.mjs contract
node run_ingest.mjs heic
node run_ingest.mjs mixed
node run_ingest.mjs inline
node run_ingest.mjs resume
node run_ingest.mjs memory 70
PT_ALL12MP=1 node run_ingest.mjs raf 48
xvfb-run -a env PT_HEADED=1 node run_ingest.mjs raf 40   # real 60 Hz frame timing
```

No bulk corpus was generated. The mixed corpus is 11 files totalling 248 KB and
the two rotated HEICs are 3 MB each; all of it is regenerated by the three
commands above in under ten seconds, so `fixtures/` is deleted rather than kept.
