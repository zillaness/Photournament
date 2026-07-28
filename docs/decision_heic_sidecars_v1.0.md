---
file: decision_heic_sidecars_v1.0.md
version: 1.0
author: Samuel Cao
created: 2026-07-28
last_updated: 2026-07-28
description: Why HEIC sidecar writing is deferred out of v1.0 despite being specified in the PRD, and what would change the decision.
ai_update: Update last_updated and version. Rename file to match. Append changelog at bottom.
---

# Decision: HEIC sidecars are deferred out of v1.0

**Status: deferred, deliberately.** `sidecarLocation` and `exportHeicAs` exist as
settings defaults in `35_session.js` with nothing behind them. That is a decision,
not an oversight, and this is the record of it.

## What the PRD asks for

PRD §8 specifies: decode each HEIC once at ingest and write a JPEG sidecar beside
it, in a `_sidecars` subfolder by default. All screen display reads the sidecar;
the original is never modified. §12 adds a per-export choice of whether finalists
come out as original HEIC or as JPEG sidecar.

The stated rationale is speed: *"This is what keeps later sessions fast, since the
expensive decode happens once rather than every time."*

## Why it is deferred

**The measurement contradicts the rationale.** A full-size q0.90 JPEG sidecar came
out at **3,323,667 bytes against the 2,994,394-byte HEIC it was made from — 11%
larger.** The PRD treats sidecars as a free speed win; they are not free, and at
volume they roughly double the source folder.

Three things follow:

1. **The speed problem is already solved without them.** Decoded derivatives —
   thumbnail and 1280px preview — are cached in IndexedDB at ingest. Later sessions
   never re-decode a HEIC to display it. The sidecar would buy nothing the cache
   does not already provide.

2. **The cost lands on the user's disk, permanently.** Writing 137 sidecars for a
   real measured folder adds several hundred MB of duplication to a source tree the
   user did not ask us to grow. The cache, by contrast, is evictable and lives in
   the browser profile.

3. **The one case sidecars genuinely serve is export**, not display: a finalist
   that has to be handed to something which cannot read HEIC. That is a per-export
   need for a handful of chosen photos, not an ingest-time need for all of them.

## What v1.0 does instead

Nothing at ingest. HEIC finalists export as their original files. Every display
path reads the cached derivative, so nothing is slow.

## What would change the decision

Build it **at export time, for chosen finalists only** — the shape §8's constraint
table now recommends. Concretely:

- Add a per-export choice: original HEIC, or JPEG converted on the way out.
- Convert only the finalists being exported, in the ingest worker, reusing the
  decoder that is already there.
- Never write into the source tree by default; write into the same
  `_finalists_*` folder as the rest of the export.

That version is worth building. The ingest-time version specified in §8 is not,
and PRD v1.9 records the measurement in its §8 constraint table.

## Trigger to revisit

If a real source folder turns out to be **majority HEIC** rather than the measured
18%, re-open this. The arithmetic changes when nearly every file needs converting
for downstream tools, and a one-time batch conversion starts to look better than
converting at every export.

## CHANGELOG
- v1.0 (2026-07-28): Initial release.
