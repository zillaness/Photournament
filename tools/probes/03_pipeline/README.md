# Probe 03 — worker thumbnail pipeline

Working prototype and benchmark for the PRD §7.9 ingest pipeline: per photo, a
~320px grid thumbnail, a ~1600px-long-edge matchup preview, and a perceptual
hash, produced in a Web Worker pool with incremental progress while the page
stays responsive.

Results and the recommended configuration are in **[FINDINGS.md](FINDINGS.md)**.

## Files

| File | What it is |
|---|---|
| `pipeline_worker.js` | The worker. Classic (non-module) worker, no imports. Decode → preview → thumb → pHash, with per-stage timing. |
| `pipeline.js` | Worker pool, backpressure, IndexedDB cache, fingerprint/skip logic, rAF sampler, heap sampler. Exposes `window.__probe`. |
| `harness.html` | Page the drivers load. Directory `<input>`, a spinner, and a thumbnail grid. |
| `gen_corpus.js` / `gen_corpus.html` / `gen_corpus.mjs` | Synthetic 4000×3000 JPEG corpus generator. |
| `lib.mjs` | Shared driver helpers: server, Playwright, process-RSS sampler. |
| `run_bench.mjs` | Concurrency / transfer / decode-strategy / format sweeps + the unbounded-decode control. |
| `run_resume.mjs` | Interrupt-at-50% + browser restart + fingerprint perturbation. |
| `run_phash.mjs` | Checks the hash is actually perceptual. |
| `run_file_url.mjs` | Same page under `file://` vs `http://localhost`. |
| `summarise.mjs` | Turns `out/bench_all.json` into the tables in FINDINGS.md. |

## Running

```sh
export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
cd tools/probes/03_pipeline

node gen_corpus.mjs 500 4 0.82     # ~2 min, writes ~1.5 GB into corpus/
N=500 node run_bench.mjs all       # ~20 min
node run_resume.mjs
node run_phash.mjs
node run_file_url.mjs
node summarise.mjs
```

`corpus/` and `out/` are gitignored.

## Why the corpus is generated in the browser

Nothing in this environment can encode a JPEG from Node. The bundled ffmpeg is
Playwright's minimal build — `png` and `libvpx` encoders only, no `lavfi`, no
`rawvideo` demuxer — and there is no `sharp`/`jpeg-js`/`canvas` package
available. So the corpus is drawn with `OffscreenCanvas` in Chromium and
reaches disk through the browser's own download machinery, which keeps ~1.5 GB
of image data off the CDP connection.

The scenes deliberately contain gradients, hard-edged shapes, 2 200 fine
strokes, and a 1:1 repeated noise pattern. The noise is applied via
`createPattern(..., 'repeat')` rather than a scaled `drawImage`, because a
scaled draw interpolates the high frequencies away and the resulting JPEGs
would compress far better than real camera files. As generated, the corpus
averages 2.98 MB per 12 MP frame, which is in the normal range for a camera
JPEG.
