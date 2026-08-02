---
file: README.md
version: 1.0
author: Samuel Cao
created: 2026-08-02
last_updated: 2026-08-02
description: What the standalone HEIC converter is, why it lives in this repo, and when to use something else instead.
ai_update: Update last_updated and version. Append changelog at bottom.
---

# HEIC converter — standalone

`heic_convert_v1.0.html` is Photournament's HEIC decode path lifted out and given
its own front end. Double-click it. Drop HEIC or HEIF files, get JPEG or PNG.
No install, no server, no network, no upload, no per-day limit.

Build it with `npm run build:heic`. `tests/heic_fresh.mjs` fails if the committed
artifact has drifted from the source, the same guard `dist_fresh.mjs` puts on the
app itself.

## Why it exists here rather than as a separate thing

It shares this repo's decoder and, more importantly, its **measured decode
lessons** — see the file header, and `tools/probes/02_heic/FINDINGS.md` behind it:

1. **One `HeifDecoder` per worker, for its whole lifetime.** A decoder per image
   strands a `heif_context` in the Emscripten heap forever — 6.35 MB per image,
   ~3.2 GB at 500 photos. The context is only released by the *next* `decode()`
   on the same instance.
2. **A null from `display()` is the error signal.** A truncated HEIC parses its
   metadata and returns a handle reporting full, valid dimensions; the failure
   only surfaces as a null in the display callback.
3. **Free every handle, not just `[0]`.** A multi-image HEIC — thumbnail pair,
   Live Photo, burst — returns several, each holding wasm memory.
4. **libheif applies `irot`/`imir` itself**, so nothing downstream re-rotates.

Keeping it in the repo means those four survive in one more place, and the
converter cannot drift onto a different libheif build than the app.

## What it does

- Drop or pick files or a whole folder; non-HEIF files are ignored by **ftyp
  brand**, not by extension, so a mislabelled file is named as such rather than
  failing mysteriously.
- JPEG (quality slider) or PNG, with an optional max-edge resize.
- Output three ways: save one, save all to a folder, or one STORED zip.
- **Write straight to a folder** streams each result to disk the moment it is
  encoded and releases it, so batch size is bounded by disk rather than memory —
  and a crash part way through keeps everything already written.
- Decoding runs in a pool of blob-URL workers, so the UI stays live.

## When to use something else

Honestly, often:

- **macOS, nothing to install:** `sips -s format jpeg *.heic --out converted/`.
  Strips most EXIF, which may or may not matter.
- **The reference CLI:** `brew install libheif` then
  `heif-convert -q 92 in.heic out.jpg`. Same library this wraps, natively
  compiled, so it is faster.
- **A maintained GUI:** [Converseen](https://github.com/Faster3ck/Converseen)
  (GPL-3.0, Windows/macOS/Linux/BSD, ImageMagick-backed). HEIC support depends
  on ImageMagick having the libheif delegate, which is the usual failure point
  on Homebrew.

This file wins only where those lose: a machine where you cannot install
anything, no network, and one double-click.

## CHANGELOG
- v1.0 (2026-08-02): Initial release.
