---
file: prd_organize_and_tag_v0.1.md
version: 0.1
author: Samuel Cao
created: 2026-10-30
last_updated: 2026-10-30
description: Draft PRD for metadata-aware organizing and user tagging in Photournament. Not approved; folds into the main PRD as section 7.12 once signed off.
ai_update: Update last_updated and version. Rename file to match. Append changelog at bottom.
---

# Organize and tag: draft PRD (v0.1, awaiting sign-off)

## 0. The current workflow, mapped

How a shoot gets organized today, inside and outside Photournament:

1. **Outside the tool.** Photos land in whatever structure the camera or phone
   produced. A phone dump or a single SD card is one flat folder. Any structure
   by day, event or camera is built by hand in Finder or Photos before
   Photournament sees it (PRD §3: "categories, days, SD cards, or nested
   combinations").
2. **Ingest keeps one piece of metadata.** `10_ingest_worker.js` reads EXIF
   Orientation and nothing else, by documented decision ("a general EXIF parser
   is not needed"). Capture time, camera, lens, exposure and GPS are read off
   disk with the file and thrown away.
3. **Allocation is per disk folder.** `PT.tree.build()` keys the tree on
   `photo.dir`. A flat folder offers one row: one quota, no coverage guarantee.
4. **Tagging exists in one place.** The export label: one free-text field per
   finalist, available only at the very end, which becomes part of the filename.
5. **Export** writes finalists to `_finalists_<folder>`, mirrored or flat.
   Session stats break keep rates down by folder, orientation and format only.

Where it breaks:

- **Structure has to exist on disk before the tool can use it.** The
  representative-of job (PRD §1) runs on per-folder quotas, and a flat dump has
  no folders. Getting "4 from each day" out of a 742-photo camera roll means
  sorting it by hand in Finder first. That manual sort is the root cause; a
  tagging button alone would not remove it.
- **The data that would build that structure is already in every file**, and
  ingest discards it.
- **Mixed sources are indistinguishable.** Phone plus camera, or two bodies,
  look identical to the tree.
- **Labels are one field, finalists only, end only.** Nothing marks "portfolio"
  or "print" while judging, and nothing comes out in a form a photo library
  can import.

## 1. Problem

Photournament can only organize by structure the user already built on disk,
and it can only annotate the handful of photos that survive to export. The
capture metadata that would let it build the structure itself is discarded.

## 2. Success criteria

- A flat folder with EXIF can be allocated per day, per event, per camera (or
  any nesting of those) without touching Finder.
- The user picks which categories to organize by and in what order. Choosing
  "Folders" alone reproduces today's behaviour exactly.
- Photos missing a field never disappear: they land in a bucket named
  "Unknown <field>", visible and allocatable like any other.
- Tags never change what is kept or cut, and never touch a quota (PRD §2).
- Still exactly one network request (the page). Originals are never modified.
- Existing suite stays green; new unit and e2e coverage for each part; dist
  rebuilt; deployed.

## 3. Proposed scope

### 3.1 Read the metadata at ingest

A whitelist EXIF reader in the worker, bounds-checked, extending the two
places that already locate the EXIF block (JPEG APP1, HEIC `Exif` item).
Fields: DateTimeOriginal (+ OffsetTimeOriginal, SubSecTimeOriginal), Make,
Model, LensModel, FocalLength, FNumber, ExposureTime, ISO, GPS
latitude/longitude. Stored on the photo record and in the derivative cache, so
a resumed session keeps it. Formats without EXIF (most PNG, WebP, GIF,
screenshots, messaging-app copies) fall back to file modified time for date,
marked as approximate.

### 3.2 Organize by: the user picks categories and their order

A chip row above the allocation tree. Available categories:

| Category | Groups by |
| --- | --- |
| Folders | disk structure (today's behaviour, the default) |
| Year / Month / Day | capture date |
| Event | time gaps: a new event starts after a gap you set (default 2 h) |
| Camera | make + model |
| Lens | lens model |
| Focal length | bands (ultra-wide, wide, normal, short tele, tele) |
| Orientation | portrait / landscape / square |
| Format | JPEG / HEIC / PNG / ... |
| Location | see open question 4 |

Clicking a chip adds it; order is nesting ("Day > Camera" gives day folders
with a camera sub-folder each). Each chip previews its group count.

**Engine seam:** each photo gets a synthetic `dir` derived from the chosen
categories, handed to the unchanged `PT.tree.build()`. Allocation states,
percent, rank toggle, broadcast row and Stage D all keep working because they
only ever see paths. Changing the organization resets allocations (paths
changed), with a warning when any were set.

### 3.3 Tags

- **User tags.** Define a short list (e.g. portfolio, print, client, family).
  Toggle them from the lightbox (already reachable everywhere photos are
  judged), from bracket panes, and in the export review. Digit keys are taken
  in the grid pass (cell toggles), so tag shortcuts are Shift+1..9.
- **Tags are orthogonal to keep/cut.** Tagging a photo does not keep it, and a
  "maybe" tag cannot become a second keep pile.
- **Metadata as read-only info** in the lightbox: date, camera, lens, settings.

**Why tags organize the output, not the allocation:** allocation is set before
the first pass, and tags are mostly applied during judging, so at allocation
time they do not exist yet. A photo can also carry several tags, but must sit
in exactly one tournament unit. So metadata organizes the input; tags organize
the output.

### 3.4 Organized output

- Finalists export into the chosen category folders ("mirror" now mirrors the
  organization, not only disk).
- Optional per-tag result sets (`_tagged_portfolio/`), duplicates across sets
  allowed, consistent with PRD §10's rejection of cross-set dedup.
- Decision JSON gains metadata and tags; a CSV manifest is added.
- Further outputs depend on open question 3.

### 3.5 Stats (small, optional)

The export stats panel gains keep-rate by camera, lens and day, from the same
records. Costs nothing new.

## 4. Constraints and conflicts, flagged

1. **Reverses a documented decision.** The EXIF reader stops being
   orientation-only. Risk is bounded: whitelisted tags, every read
   bounds-checked, worker-side, malformed data skipped silently as today.
2. **Place names need a lookup.** Online reverse geocoding breaks "your photos
   never leave your machine" and the one-request promise. Open question 4.
3. **Writing tags into originals is out of scope** (PRD §9). Tags go to
   manifests, filenames or sidecar files, never into the source bytes.
4. **Older sessions and caches have no metadata.** Their photos read as
   Unknown until the folder is reconnected; reconnect re-reads headers only
   (first ~128 KB per file, no re-decode).
5. **Camera clocks.** DateTimeOriginal has no timezone; "day" is what the
   camera clock said. Two unsynced bodies will disagree, and the tool shows
   that rather than guessing.
6. **No ML.** Faces, scenes and content tags stay out (PRD §9).
7. **Deploy path.** Pages builds only from `claude/photournament-prd-v1-8-fojs7d`
   (the live site). This session's branch is `claude/eager-galileo-wx2cge`.
   Pages serves one site per repo, so any deploy replaces the live one.

## 5. Plan

1. EXIF whitelist reader; unit tests on crafted TIFF blocks, JPEG and HEIC.
2. Record and cache plumbing; reconnect backfill.
3. `PT.organize`: pure module, photo + ordered categories -> synthetic dir;
   unit tests.
4. Allocation-screen chip row; e2e.
5. Tags: store, lightbox, bracket, export review; e2e.
6. Export: category folders, per-tag sets, CSV/JSON, plus whatever question 3
   adds; e2e parses the zip.
7. PRD v1.11 §7.12, README, handoff, file changelogs; dist rebuilt; suite green.
8. Adversarial review of the diff, then deploy per question 5.

## 6. Open questions

1. Is this an organizing aid inside the culling flow, a standalone
   sort-everything mode, or both?
2. Where should tags be applied?
3. What should organizing and tagging produce on export?
4. How should location work, given the privacy promise?
5. How should the deploy happen, given the branch situation?

## CHANGELOG

- v0.1 (2026-10-30): Draft for review. Current workflow mapped, scope proposed,
  five open questions.
