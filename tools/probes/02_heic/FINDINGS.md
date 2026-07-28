---
file: FINDINGS.md
probe: 02_heic — "does HEIC decode work in-browser, offline, with no fetch access?"
prd: photournament_prd_v1.8.md §8 (riskiest unknown), §11 phase 1, §7.9 ingest
date: 2026-07-28
status: PROVEN — with one mandatory API-usage constraint that is not in the libheif-js docs
---

# HEIC decode probe — findings

## Verdict

**It works.** A genuine 11.94 MP HEVC-coded HEIC decodes to correct RGBA in headless
Chromium from a `file://` page with zero network access, inside a blob-URL Web Worker,
in ~0.95 s. PRD §8's designated riskiest unknown is retired.

**One catch, and it is a hard blocker if missed.** The decode pattern shown in the
libheif-js README leaks **6.35 MB of wasm heap per image, permanently**. At the PRD's
stated 500 photos that projects to **~3.2 GB** and a dead tab. The fix is two lines and
costs nothing in speed, but both halves are required and neither is documented.
See [The leak](#5-the-leak-the-actual-finding).

---

## 1. Test material — a real HEIC, not an AVIF stand-in

The task allowed falling back to AVIF. **That was not necessary.** All results below are
from genuine HEVC-in-HEIF files.

| fixture | bytes | decoded | structure |
|---|---:|---|---|
| **`photo_12mp.heic`** | 2,994,394 | **3992x2992 = 11.94 MP** | `ftyp heic/mif1`, **`grid` derived image over 48 `hvc1` tiles**, 50 `infe` entries, 2 `Exif` boxes — the tiled layout an iPhone camera writes |
| `example_strukturag.heic` | 718,114 | 1280x854, 2 items | upstream libheif's own example, non-tiled |
| `nokia_C003.heic` | 224,452 | 1280x720, 2 items | Nokia HEIF conformance suite |

Sources and byte-level evidence in `fixtures/PROVENANCE.md`.
The primary fixture is 11.94 MP, so **nothing below is extrapolated from a small image** —
the ~12 MP numbers are measured at ~12 MP.

`sharp`/ImageMagick/ffmpeg were never needed. **No npm packages were installed.**

Visual proof: `out/preview_640.png` — an aerial coastline shot, decoded from HEIC → RGBA →
canvas → PNG entirely in the browser. Full-size output at
`out/decoded_file_wasm_photo_12mp_heic.png` (22.6 MB).

---

## 2. Zero-network proof

Every probe installs **two independent tripwires**:

1. Playwright `context.route('**/*')` recording every request Chromium's network stack issues.
2. An in-page (and in-worker) override of `fetch` / `XMLHttpRequest` / `WebSocket` /
   `EventSource` that records the call **and throws**, installed *before* the libheif
   `<script>` tag evaluates.

| scenario | total requests observed | requests for `*.wasm` | remote-host requests | in-page tripwire hits | verdict |
|---|---:|---:|---:|---:|---|
| `file://` page, wasm-bundle | 2 (the HTML + the bundle `.js`) | **0** | **0** | **0** | PASS |
| `http://localhost`, wasm-bundle | 2 | **0** | **0** | **0** | PASS |
| `file://` page, asm.js | 2 | **0** | **0** | **0** | PASS |
| `http://localhost`, asm.js | 2 | **0** | **0** | **0** | PASS |
| `file://` worker, bundle inlined in HTML | **1** (the HTML only) | **0** | **0** | **0** | PASS |

Corroborating static evidence: `libheif-bundle.js` contains a **1,379,076-character base64
literal decoding to 1,034,307 bytes**, against the standalone `libheif.wasm` on disk of
1,034,305 bytes. The wasm binary is inside the JS. There is no `instantiateStreaming` call
in the file. The `fetch(`/`XMLHttpRequest` occurrences that *do* exist are Emscripten's
generic loader branches, and the tripwires prove they are never taken.

> **Honest limitation.** For the *page* cases Playwright routing did observe the `file://`
> script load, so routing does see `file://` traffic. For the *worker* case, the blob
> worker's `importScripts` of a `file://` URL was **not** surfaced through page routing —
> Playwright does not route blob-worker subresource loads. The no-network claim for workers
> rests on the in-worker tripwire, the base64 evidence above, and strategy D (below), where
> there is no `importScripts` at all and the entire session makes one request.

---

## 3. Worker loading — the `file://` result matters

PRD §7.9 requires worker-threaded decode. PRD §8 requires it to work from a local HTML file.
Those two constraints collide in a non-obvious way.

| # | strategy | `file://` | `http://localhost` |
|---|---|---|---|
| **A** | blob-URL worker → `importScripts(`**absolute** URL of the bundle`)` | works | works |
| B | blob-URL worker → `importScripts('../../relative/path.js')` | FAILS: `Failed to execute 'importScripts'… The URL '../../…' is invalid.` | FAILS: same |
| C | classic worker: `new Worker('worker_classic.js')` | **BLOCKED** — `Script at 'file:///…' cannot be accessed from origin 'null'` | works |
| **D** | blob-URL worker with the bundle **source text inlined in the HTML** (`<script type="text/plain">` → `Blob`) | works | works |

Three things fall out of this:

- **A classic same-directory worker file is unusable under `file://`.** The page's origin is
  `null`, so `new Worker('./x.js')` throws at construction. Any design that assumes
  "ship `worker.js` next to `index.html`" breaks the moment the user double-clicks the HTML.
- **Blob-URL workers escape that**, and `importScripts` of an **absolute** `file://` URL from
  inside one succeeds. Build the URL with `new URL(rel, location.href).href` — a relative
  path resolves against the `blob:` base and is rejected outright.
- **Strategy D removes the last external request entirely**, at the cost of a 1.47 MB
  single-file HTML. It was the fastest to initialise (23.5 ms, no script fetch/parse round trip).

RGBA transfer out of the worker: the `Uint8ClampedArray`'s **47,776,256-byte ArrayBuffer was
transferred zero-copy** via `postMessage(…, [buf])` and arrived intact (`byteLength` preserved,
`instanceof ArrayBuffer` true). Confirmed under both `file://` and `http://`.

---

## 4. Benchmarks

Host: **4 vCPU Intel Xeon @ 2.10 GHz, 16.9 GB RAM**, headless Chromium via playwright 1.56.1.
This is a modest cloud VM; a modern laptop will be meaningfully faster. Treat these as a
pessimistic floor.

### 4.1 Cold parse + init — 5 fresh browser processes per build, `file://`

`factory()` is where the wasm is base64-decoded, compiled and instantiated; the script-parse
column is evaluating the `.js` text.

| build | file size | script parse (median) | `libheif()` factory | **total cold init** |
|---|---:|---:|---:|---:|
| **`libheif-wasm/libheif-bundle.js`** | 1.46 MB | 22.7 ms | 22.3 ms | **45.0 ms** |
| `libheif/libheif.js` (asm.js) | 2.08 MB | 64.4 ms | 50.8 ms | **115.2 ms** |

Init is a rounding error either way. It is **not** a reason to pick a build.

### 4.2 Per-image decode — median of 6 steady-state runs

| fixture | MP | **wasm-bundle** | asm.js | asm/wasm |
|---|---:|---:|---:|---:|
| `photo_12mp.heic` | 11.94 | **994 ms** | 1,997 ms | **2.01x** |
| `example_strukturag.heic` | 1.09 | **94.5 ms** | 237.8 ms | 2.52x |
| `nokia_C003.heic` | 0.92 | **73.8 ms** | 143.2 ms | 1.94x |
| **normalised** | per MP | **83.2 ms/MP** | 167.2 ms/MP | **2.01x** |

Decode cost is **linear in megapixels** across a 13x size range, so ms/MP is a safe scaling
constant for other camera resolutions.

The **first** decode in a fresh page is ~20 % slower (1,180 ms wasm / 2,551 ms asm) from JIT
warm-up. Budget one throwaway image, or accept it.

### 4.3 Worker parallelism — 12 MP fixture, decode only

| workers | ms/image (wall) | throughput | speed-up |
|---:|---:|---:|---:|
| 1 | 1,266 | 0.79 img/s | 1.0x |
| 2 | 728 | 1.37 img/s | 1.74x |
| **4** | **446** | **2.24 img/s** | **2.84x** |
| 8 | 457 | 2.19 img/s | 2.83x |

**Scaling stops dead at the core count.** 8 workers is no better than 4 and costs 2x the
memory. Size the pool at `navigator.hardwareConcurrency`, capped — do not oversubscribe.

(1 worker looks *slower* than the main thread because the wall-clock figure amortises worker
startup and the 3 MB `postMessage` of the source bytes over only 3 images.)

### 4.4 The full ingest step per PRD §7.9, in-worker via `OffscreenCanvas`

Decode → 1600 px matchup preview → 320 px grid thumbnail → full-size JPEG sidecar:

| stage | 1 worker (median) | share |
|---|---:|---:|
| HEIC decode | 1,033 ms | **81 %** |
| 1600 px preview JPEG q0.85 | 41 ms | 3 % |
| 320 px thumb JPEG q0.80 | 2.8 ms | <1 % |
| full-size JPEG sidecar q0.90 | 199 ms | 15 % |
| **total per image** | **1,430 ms** | |

`OffscreenCanvas` + `convertToBlob` works inside the blob worker under `file://`. The whole
derivative pipeline is affordable; **the HEIC decode dominates at ~81 %**, which means
optimisation effort belongs nowhere else.

### 4.5 500-photo projection (PRD §3)

Measured at 11.94 MP, not extrapolated from a smaller image.

| configuration | 500 x 12 MP HEICs |
|---|---:|
| asm.js, main thread, decode only | 998 s — **16 min 38 s** |
| wasm, main thread, decode only | 497 s — 8 min 17 s |
| wasm, 1 worker, decode only | 633 s — 10 min 33 s |
| **wasm, 4 workers, decode only** | **223 s — 3 min 43 s** |
| wasm, 1 worker, **full ingest** | 715 s — 11 min 55 s |
| **wasm, 4 workers, full ingest** | **241 s — 4 min 1 s** |

Excludes perceptual hashing, IndexedDB writes and disk writes. **~4 minutes on 4 cores** for a
one-time, cached, resumable ingest is acceptable against PRD §8's "HEIC ingest speed" row.
On the asm.js build, single-threaded, it would be ~17 minutes — which is what makes the build
choice matter.

---

## 5. The leak (the actual finding)

The `HeifDecoder` wrapper shipped inside `libheif-bundle.js` is:

```js
HeifDecoder.prototype.decode = function (buf) {
  if (this.decoder) Module.heif_context_free(this.decoder);   // frees the PREVIOUS context
  this.decoder = Module.heif_context_alloc();
  ...
};
```

A `heif_context` is freed **only by the next `decode()` call on the same `HeifDecoder`
instance**. There is no destructor. So `new HeifDecoder()` per image — exactly what the
libheif-js README shows — strands one entire context (file bytes plus decoded planes) in the
Emscripten heap forever. Emscripten heaps only grow and are never returned to the OS.

**60 sequential 11.94 MP decodes, one worker, four variants:**

| variant | heap @1 | @20 | @60 | growth/decode | **projected @500** | median decode |
|---|---:|---:|---:|---:|---:|---:|
| A — `new HeifDecoder()` each image | 72 MB | 215 MB | 446 MB | 6.35 MB | **3,245 MB** | 949 ms |
| B — A + `image.free()` | 72 MB | 215 MB | 446 MB | 6.35 MB | **3,245 MB** | 970 ms |
| C — shared decoder, no `free()` | 72 MB | 215 MB | 446 MB | 6.35 MB | **3,245 MB** | 974 ms |
| **D — shared decoder + `image.free()`** | **72 MB** | **72 MB** | **72 MB** | **0.00 MB** | **72 MB** | **949 ms** |

**Both halves are required. Neither alone helps at all.** B and C are indistinguishable from
the naive A.

Confirmation run at PRD volume — **200 sequential 12 MP decodes**:

- heap: **72 MB at decode 1, 72 MB at decode 200. Zero growth.** Checkpoints at 0/25/50/…/175 all 72 MB.
- decode ms: min 924, **median 953**, p95 1,030, max 1,384 — no degradation over the run.
- pixel checksum of decode #1 and decode #200: **identical** (5,105,342). Correctness is not traded away.
- zero page errors.

The correct pattern:

```js
const decoder = new libheif.HeifDecoder();   // ONE instance, per worker, for the whole run
for (const file of files) {
  const images = decoder.decode(bytes);
  const img = images[0];
  // ... img.display(imageData, cb) ...
  for (const im of images) im.free();        // EVERY returned handle, not just images[0]
}
```

Note `for (const im of images)` — a multi-image HEIC (thumbnail pair, Live Photo, burst)
returns more than one handle and every one must be released.

**3.2 GB projected vs 72 MB flat** is the difference between the ingest completing and the tab
being killed, and it is invisible at the 2–3 image scale anyone would test by hand. This is the
single most important output of this probe.

---

## 6. Memory profile

- **Steady-state wasm heap for 12 MP decode: 72 MB**, with the correct pattern. Does not grow.
- Peak transient inside a single decode is contained within that 72 MB arena (17 MB after init → 72 MB on first decode, then flat).
- JS heap sits at ~26 MB and does not move (Chromium buckets `performance.memory` to ~5 MB, so the exact wasm `HEAPU8.length` is the trustworthy number and is what is reported here).
- **4 workers ~ 288 MB total** wasm arena. Comfortable. The same 4 workers with the leaky pattern would hit ~3.2 GB and run into the wasm32 4 GB address-space ceiling.
- **The RGBA buffer is transferable.** 47,776,256 bytes moved worker→main zero-copy, verified. Do transfer it; do not structured-clone 48 MB per image.
- A 12 MP RGBA buffer is 47.8 MB. PRD §8's "500 full-resolution decodes cannot coexist" is correct — at 500 that would be 23.9 GB. Never hold more than a couple at once.

### Derivative sizes — for the IndexedDB quota row in PRD §8

| artefact | dims | bytes | x 500 |
|---|---|---:|---:|
| original HEIC | 3992x2992 | 2,994,394 | 1.50 GB |
| **full-size JPEG sidecar q0.90** | 3992x2992 | **3,323,667** | **1.66 GB** |
| 1600 px preview q0.85 | 1600x1199 | 548,364 | 274 MB |
| 320 px thumbnail q0.80 | 320x240 | 25,425 | 13 MB |

**The JPEG sidecar is 11 % *larger* than the HEIC it came from.** PRD §8 commits to writing
one per HEIC; that is +1.66 GB of disk for a 500-photo set, roughly doubling the folder. Worth
surfacing in the UI before writing, and worth asking whether the 1600 px preview alone would
serve display duty with the full sidecar generated lazily at export.
The IndexedDB cache itself is cheap (287 MB for previews + thumbs).

---

## 7. Error handling — a gap against PRD §7.9

PRD §7.9 requires "flag unsupported files at load rather than dropping them silently."
`HeifDecoder.decode()` **never throws.** It `console.log`s and returns an array.

| input | threw? | returned | usable signal? |
|---|---|---|---|
| a JPEG | no | `[]` (length 0) | yes — empty array = reject |
| 4 KB of `0x41` | no | `[]` | yes |
| empty buffer | no | `[]` | yes |
| **truncated HEIC (first 50 KB of a 2.9 MB file)** | no | **1 image, reports 3992x2992** | **NO — looks valid** |

The first three are fine — treat `length === 0` as unsupported. The fourth is the trap: a
truncated or corrupt HEIC parses its metadata, yields a handle, and reports full dimensions.
The failure only surfaces later, when `image.display()` invokes its callback with `null`.
**Detect ingest failure on the `display()` callback, not on `decode()`**, and treat a `null`
there as a load error to be flagged in the UI.

---

## 8. Recommendation

**Ship `libheif-js/libheif-wasm/libheif-bundle.js` (1.46 MB).** It is 2.01x faster than the
asm.js build at every image size tested, needs no separate `.wasm` fetch, and works identically
under `file://` and `http://`. The asm.js build's only advantage would be environments without
WebAssembly, which PRD §8 has already excluded by targeting Chromium.

**Never ship `libheif-wasm/libheif.js` (81 KB + separate 1.03 MB `libheif.wasm`).** It fetches
its `.wasm` at runtime, which is exactly what a `file://` page cannot do.

### How to load it

1. Copy `libheif-bundle.js` into the app's asset folder (PRD §8 permits one). Reference it
   with a path relative to the HTML.
2. Decode in **blob-URL Web Workers**, pool size = `navigator.hardwareConcurrency` **capped at
   the core count** — 8 workers bought nothing over 4.
3. Inside the worker, `importScripts()` an **absolute** URL:
   `new URL('assets/libheif-bundle.js', location.href).href`. A relative path fails, and a
   classic non-blob worker file cannot be constructed under `file://` at all.
4. If a true single-file deliverable is ever wanted, strategy D (bundle source inlined in a
   `<script type="text/plain">` block, read via `.textContent` into the worker Blob) is proven
   and slightly faster to start. Cost: a 1.47 MB HTML file.
5. **One `HeifDecoder` per worker, reused for every image, and `.free()` every handle in the
   returned array.** Non-negotiable — see §5.
6. Transfer the RGBA `ArrayBuffer` out of the worker; do not clone it.
7. Treat `decode()` returning an empty array as "unsupported", and a `null` in the
   `display()` callback as "corrupt" — `decode()` itself never throws.

### What this means for the PRD

- §8 "Chromium HEIC / WASM decode at ingest" — **confirmed viable.**
- §8 "HEIC ingest speed … one-time, cached, worker-threaded, resumable" — **confirmed.**
  ~4 minutes for 500 x 12 MP on a 4-core VM.
- §11 phase 1 can proceed. The riskiest unknown is retired.
- Add a row to §8's constraint table for the libheif heap leak, or the mitigation will be
  lost — it is the one thing here that is fatal and easy to get wrong.

---

## 9. Not verified

- **Real iPhone provenance.** `photo_12mp.heic` is structurally an iPhone-style HEIC (grid over
  48 HEVC tiles at 3992x2992) but carries no Apple maker-note, so I cannot claim it came off an
  iPhone. It is unambiguously genuine HEVC-in-HEIF, not AVIF.
- **10-bit / HDR HEIC**, Live Photos, depth maps, burst containers, and HEICs with rotation in
  the `irot`/`imir` boxes. All fixtures were 8-bit stills. Orientation handling in particular is
  untested and is a plausible source of sideways thumbnails.
- **Real Chromium, headed, on real hardware.** Everything here is headless Chromium on a 4 vCPU
  Xeon VM. Absolute times will differ; the wasm/asm ratio and the memory behaviour should not.
- **The File System Access API path.** Bytes were handed to the page via `page.evaluate`,
  which is equivalent to a `File.arrayBuffer()` result, but the actual directory-handle →
  `getFile()` → decode chain was not exercised. That belongs to the ingest probe.
- **Sidecar disk writes** and IndexedDB persistence — out of scope here, sizes estimated in §6.
- **Sustained thermal/GC behaviour past 200 decodes** in one worker. Flat at 200; not run to 500.

---

## Files

| path | what |
|---|---|
| `fixtures/` | the three HEICs + `PROVENANCE.md` |
| `harness.html` | page harness with network tripwire; `<script>` tag injected by `gen_harness.js` |
| `gen_harness.js` | writes `out/h_wasm.html` and `out/h_asm.html` |
| `run_page.js` | `node run_page.js <file\|http> <wasm\|asm> [--png]` — decode + network assertion |
| `worker_probe.html`, `run_worker.js` | the four worker-loading strategies |
| `bench.js` | cold init, warm decode, parallelism, full ingest step, 500-photo projection |
| `mem_soak.js` | 60-decode soak + unsupported-input handling |
| `mem_fix.js` | the four-variant leak isolation (the §5 table) |
| `confirm_fix.js` | 200-decode confirmation with pixel checksums |
| `out/*.json` | every raw measurement |
| `out/preview_640.png` | human-visible proof the decode is correct |

Reproduce:

```bash
export NODE_PATH=/opt/node22/lib/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
cd tools/probes/02_heic
node run_page.js file wasm --png     # exits 0 only if zero network requests
node run_worker.js file              # add --inline for strategy D
node bench.js
node mem_fix.js 60
node confirm_fix.js 200
# http:// runs need a server at the repo root on :8099
```
