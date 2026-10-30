---
file: prd_organize_and_tag_v0.3.md
version: 0.3
author: Samuel Cao
created: 2026-10-30
last_updated: 2026-10-30
description: Design record for metadata-aware organizing and user tagging in Photournament (Sort mode and the culling tree). Built on branch claude/eager-galileo-wx2cge and folded into photournament_prd_v1.11.md section 7.12; not yet deployed.
ai_update: Update last_updated and version. Rename file to match. Append changelog at bottom.
---

# Organize and tag: design record (v0.3, built, awaiting review)

## 0. The current workflow, mapped

How a shoot gets organized today, inside and outside Photournament:

1. **Outside the tool.** Photos land in whatever structure the camera or phone
   produced. A phone dump or a single SD card is one flat folder. Any structure
   by day, place or camera is built by hand in Finder or Photos.
2. **Ingest keeps one piece of metadata.** `10_ingest_worker.js` reads EXIF
   Orientation and nothing else, by documented decision. Capture time, camera,
   lens, exposure and GPS are read off disk with the file and thrown away.
3. **Allocation is per disk folder.** `PT.tree.build()` keys the tree on
   `photo.dir`. A flat folder offers one row: one quota, no coverage guarantee.
4. **Tagging exists in one place.** The export label: one free-text field per
   finalist, at the very end, which becomes part of the filename.
5. **Export** writes finalists only, to `_finalists_<folder>`, mirrored or
   flat. There is no way to sort a whole shoot without culling it.

Where it breaks:

- **Structure has to exist on disk first.** Per-folder quotas are how the tool
  guarantees coverage (PRD §1), and a flat dump has no folders. "Four from each
  day" out of a 742-photo camera roll means sorting by hand in Finder first.
- **The data that would build that structure is already in every file**, and
  ingest discards it.
- **Mixed sources are indistinguishable.** Phone plus camera look identical.
- **Labels are one field, finalists only, end only.** Nothing marks
  "portfolio" or "print" while judging.
- **Sorting a shoot is not a job the tool does at all.** Only culling is.

## 1. Problem

Photournament can only organize by structure the user already built on disk,
can only annotate the photos that survive to export, and has no way to sort a
shoot without culling it. The capture metadata that would solve all three is
read at ingest and discarded.

## 2. Decisions taken in the interview (2026-10-30)

| Question | Answer |
| --- | --- |
| Where organizing lives | **Both, built now:** a standalone Sort mode, and the same categories inside culling |
| Where tags are applied | **Lightbox, bracket panes, export review** (and the Sort screen) |
| Culling export | **Category folders + manifest** (CSV, and the decision JSON gains tags and metadata) |
| Sort-mode output | **Chosen each time**: copy into a new folder, or manifest only, priced in GB first |
| Location | **From the photo's own metadata, offline** (see 3.2) |
| Deploy | **Fast-forward the live Pages branch**, after an explicit "proceed" |

## 3. Scope

### 3.1 Read the metadata at ingest

The worker already holds every file's bytes before the cache check (it
fingerprints them), so metadata is read there, for fresh and cached photos
alike, with no extra file reads. A whitelist reader, bounds-checked, extending
the two places that already find the EXIF block (JPEG APP1, HEIC `Exif` item):

- **When:** DateTimeOriginal, OffsetTimeOriginal, SubSecTimeOriginal
- **What with:** Make, Model, LensModel
- **How:** FocalLength, FocalLengthIn35mmFilm, FNumber, ExposureTime, ISO
- **Where:** GPS latitude and longitude; and, when a file carries one, a
  written place name from IPTC or XMP (City, State, Country, Sublocation),
  which Lightroom, Photo Mechanic and similar tools write.

Stored on the photo record, which persists with the session, so a resumed
session keeps it. Files without EXIF (most PNG, WebP, GIF, screenshots,
messaging-app copies) get an explicit "No date" / "Unknown camera" bucket.

### 3.2 Location, from metadata only

Reading GPS is entirely local: the photo and its coordinates never leave the
device. Phones usually store only coordinates, not a place name, so:

1. **A written place name in the file wins** (IPTC/XMP City, Country).
2. **Otherwise coordinates are grouped offline** into nearby clusters (photos
   within a set distance of each other, default 5 km; 1 / 5 / 25 km offered).
   Each cluster shows its centre coordinates and can be named once ("Kyoto");
   the name is kept with the session.
3. **No GPS at all:** "No location".

Not done: online reverse geocoding (would send coordinates to a third party
and break the one-request promise). A bundled offline city list (+0.5 to 1 MB)
remains possible later if naming clusters by hand gets tedious.

### 3.3 The categories, shared by both modes

| Category | Groups by |
| --- | --- |
| Folders | disk structure (culling's default, today's behaviour) |
| Year / Month / Day | capture date |
| Event | time gaps: a new event after a gap you set (default 2 h) |
| Camera | make + model |
| Lens | lens model |
| Focal length | ultra-wide, wide, normal, short tele, tele (35 mm equivalent) |
| Location | 3.2 |
| Orientation | portrait / landscape / square |
| Format | JPEG / HEIC / PNG / ... |

Picked as chips; order is nesting ("Day > Camera" = a folder per day, a
camera folder inside each). Each chip previews its group count. Event and
Location groups can be renamed. `PT.organize` is one pure module: photo +
ordered categories -> a path. Both modes use it.

### 3.4 Standalone Sort mode

Chosen on the entry screen beside today's culling start. Flow:

```
Entry (Sort) → Ingest (unchanged) → Sort screen → Export
```

- **Sort screen:** category chips at the top; below, every photo in sections
  by group (header = path and count). Click selects (shift-click for a range,
  "select group" per section); a selection bar applies or removes tags; the
  expand button opens the lightbox, which shows metadata and tag toggles.
- **No culling, no quotas.** Nothing is kept or cut; every photo is sorted.
- **Export, chosen each time, priced first** ("742 photos, 1.6 GB"):
  - **Copy into a new folder**: `<chosen folder>/<category path>/<original
    name>`, name collisions suffixed, plus `manifest.csv`. Needs Chromium's
    folder access; elsewhere the option says why it is unavailable.
  - **Manifest only**: CSV + JSON of every photo's group, tags and metadata,
    zero extra disk.
  - **Per-tag copies** optional alongside the category copy.
- Resumes like any session; a reloaded session reconnects its folder before
  copying, exactly as culling export already does.

### 3.5 Inside culling

The same chip row sits on the allocation screen. "Folders" alone is today's
behaviour exactly. Any other choice gives each photo a synthetic folder path
from `PT.organize`, handed to the unchanged `PT.tree.build()`; allocation
states, percent, ranking, broadcast row and Stage D keep working because they
only see paths. Changing the organization resets allocations, with a warning
when any were set, and it locks once the first folder starts (paths are the
units' identity). Finalists export into the chosen category folders.

### 3.6 Tags

- Define up to 9 tags (e.g. portfolio, print, client). Toggle them in the
  lightbox (Shift+1..9 or click), on bracket panes, in the export review, and
  on the Sort screen's selection bar. Digit keys stay reserved for grid cells.
- **Tags never keep, cut, or change a quota.** A "maybe" tag cannot become a
  second keep pile (PRD §2).
- **Tags organize the output, not the allocation.** Allocation is set before
  judging, when tags mostly do not exist yet, and a photo can carry several
  tags but must sit in exactly one tournament unit.
- Export: tags go into the CSV and decision JSON; optional per-tag result sets
  (`_tagged_portfolio/`), duplicates across sets allowed (PRD §10).

## 4. Constraints and conflicts, flagged

1. **Reverses a documented decision.** The EXIF reader stops being
   orientation-only. Bounded: whitelisted tags, every read bounds-checked,
   worker-side, malformed data skipped silently as today.
2. **Originals are never modified** (PRD §9). Tags live in the session and in
   exported manifests, never in the source files.
3. **Sessions made before this ships have no metadata** on their records.
   Their photos read as "No date" etc. until re-ingested.
4. **Camera clocks.** DateTimeOriginal has no timezone; "day" is what the
   camera clock said. Unsynced bodies will disagree, and the tool shows that.
5. **No ML.** Faces, scenes and content tags stay out (PRD §9).
6. **Sort-mode copy costs disk equal to the shoot**, hence the price shown
   before choosing.

## 5. Assumptions carried (not asked; correct me at sign-off)

- Photos without a capture date go to "No date"; file modified time is not
  used as a stand-in, because a downloaded or copied file would land on the
  wrong day silently.
- Event gap 2 h and location radius 5 km by default, both adjustable.
- Tags belong to a session; they do not carry across sessions.
- Keep-rate stats by camera/lens/day are parked, not built.

## 6. Plan

1. EXIF/IPTC/XMP whitelist reader; unit tests on crafted blocks (JPEG, HEIC).
2. Record plumbing; metadata on cached photos via the fingerprint step.
3. `PT.organize` (categories, event gaps, location clusters, names); unit tests.
4. Tag store + lightbox and bracket controls + export review chips.
5. Sort mode: entry choice, Sort screen, priced export (copy / manifest).
6. Culling: allocation chip row, lock, export into category folders, per-tag
   sets, CSV.
7. E2E for Sort mode, culling-with-organize, and tags (EXIF fixtures built in
   the tests); full suite green; dist rebuilt.
8. PRD v1.11 §7.12, README, handoff, file changelogs.
9. Adversarial review of the diff; fixes.
10. Push to `claude/eager-galileo-wx2cge`. Then stop for "proceed" before
    fast-forwarding `claude/photournament-prd-v1-8-fojs7d`, which deploys the
    live site (revertible, but public the moment it lands).

## 7. Build notes (2026-10-30)

Built overnight on `claude/eager-galileo-wx2cge` under a token-burndown run,
taking "get as much done without input" as the go-ahead. v0.2 was not
explicitly signed off, so every departure from it is listed here for review.

Where the build differs from sections 3 to 6:

- **Culling export folders are one level, named for the group path**
  (`_finalists_2026-07-14_Canon_EOS_R6`), not nested category folders. One
  level keeps PRD §7.8's collision prompt and add/replace/sibling choices
  working untouched. Sort mode's copy IS nested, because it has no such
  machinery to preserve.
- **An emptied Organize-by row means one group**, not folders. Found in a
  browser: the earlier rule snapped the row back to Folders and nested the
  next choice under the disk folders.
- **No Shift+digit on bracket panes.** With two photos showing, which one a
  key meant would be a guess. Chips under each pane instead, outside the
  viewport so a tag click can never count as a choice.
- **A latent bug fixed in passing:** two folders with the same leaf name
  (Day1/Canon, Day2/Canon) both exported into `_finalists_Canon`. Organizing
  makes that shape common, so a clash now falls back to the full path.
- **Sort mode's opening view** is Day when most photos are dated, else
  Folders. An assumption, one click to change.
- **Parked:** keep-rate stats by camera/lens/day (§3.5); a bundled offline city
  list for naming GPS clusters.

Not done, waiting on Sam: the deploy. Pages builds only from
`claude/photournament-prd-v1-8-fojs7d`; pushing there replaces the live site,
and he asked to be asked first.

Coverage: `tests/capture_test.mjs` (14), `tests/organize_test.mjs` (19),
`tests/e2e_sort.mjs`, `tests/e2e_organize.mjs`; full `npm test` green.

## CHANGELOG

- v0.1 (2026-10-30): Draft for review. Current workflow mapped, scope proposed,
  five open questions.
- v0.2 (2026-10-30): Interview answers folded in. Standalone Sort mode added
  alongside the culling integration; location clarified as metadata-only
  (written place names when present, else offline coordinate clusters);
  priced copy-or-manifest choice for Sort export; deploy path fixed;
  assumptions listed.
- v0.3 (2026-10-30): Built. Status changed to design record; section 7 lists
  every departure from v0.2, the bug fixed in passing, what is parked, and
  the deploy still awaiting a go-ahead. Folded into the main PRD as §7.12.
