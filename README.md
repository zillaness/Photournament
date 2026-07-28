# Photournament

Narrows a folder of photos down to a small set of keepers: quota-enforced grid
passes to cut the field, then head-to-head comparison to rank what survives.

Spec: [`photournament_prd_v1.9.md`](photournament_prd_v1.9.md).

## Running it

Two ways, and they behave identically apart from one thing.

**Download the file.** Grab `dist/photournament_v1.0.html`, save it anywhere and
double-click. Chrome, Edge, Brave or Opera — resume and writing results back to
disk need the File System Access API, which Chromium alone implements.

**Or open the hosted page**, if GitHub Pages is enabled for this repository
(Settings → Pages → Source: GitHub Actions). The workflow in
`.github/workflows/pages.yml` builds from source on every push, so the site can
never be a rebuild behind.

### Your photos never leave your machine

This holds either way. There is no server, no upload and no account. The page
reads the folder you point it at, decodes the photos in your browser, and
caches thumbnails in that browser's own storage. Nothing is transmitted
anywhere — served or not, the app makes exactly one network request: the page
itself.

Serving it over https is in fact slightly *better* than opening the file
directly, because a real origin gets its own storage bucket. Every page opened
from `file://` shares one bucket with every other local HTML page in that
browser profile.

## Building

```
npm install
npm run build     # -> dist/photournament_v1.0.html  (and a slim, no-HEIC build)
npm test          # unit tests, artifact smoke, and nine end-to-end runs
```

The build concatenates `src/` into one self-contained HTML file. That is not a
stylistic choice: from a `file://` origin Chromium blocks `fetch`, `XHR`, module
scripts with `src`, and relative-URL Workers, so a multi-file app cannot run
from a double-clicked file. See
[`tools/probes/01_capability_matrix/FINDINGS.md`](tools/probes/01_capability_matrix/FINDINGS.md)
for the measured constraint table.

## What it does

1. **Ingest** — reads the folder, decodes JPEG, HEIC, PNG, WebP and GIF, and
   builds thumbnails off the main thread. Video and RAW are counted and skipped,
   never treated as errors.
2. **Allocation** — say how many photos you want to keep from each folder. Fixed
   counts, a share of the folder (`5%`), `0` to skip, `*` for no limit, or blank
   to compete with sibling folders for whatever the parent has left over.
3. **Duplicates** — near-identical shots are grouped so a burst costs one
   decision rather than several: the grid deals one cell per group and the
   bracket seats one competitor per group, each wearing a badge with the member
   count. Open the badge anywhere to switch which frame stands for the group;
   split, merge and remove by hand when the grouping itself is wrong.
4. **Grid passes** — a screen of photos at a time, keeping at most the quota you
   committed to before the pass started. The cap does not move mid-pass; that is
   the entire point. **Stop early** in the top bar ends the folder whenever you
   are already happy: everything still standing — kept or simply not yet shown —
   becomes a finalist, and only the photos you actively passed over stay cut.
5. **Bracket** — survivors go head to head, with a second-chance round so a
   strong photo is not lost to an unlucky early draw.
6. **Export** — review every finalist, label it in its own words, and write the
   results to a folder, download them as one zip, or take a contact sheet.

Press <kbd>T</kbd> anywhere to switch between the dark and light surround. The
light theme is a mid-grey, not white, deliberately: a white surround makes a
photograph read darker and flatter than the same photograph against mid-grey,
which is the interference the whole tool exists to avoid.

## Known limits

- **Chromium only.** Other browsers can still cull, but cannot resume a session
  or write results back to disk; the app says so plainly when it detects that.
- **The folder-picker to disk-write path is untested in CI.** A native folder
  dialog cannot be driven headlessly, so the automated tests use the
  `webkitdirectory` input instead. Downloading a zip is fully covered.
- **Perceptual-hash thresholds were tuned on procedurally generated images**, not
  photographs. The defaults measure well, but real bursts are the real test.
