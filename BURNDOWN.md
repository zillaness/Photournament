---
file: BURNDOWN.md
version: 1.0
author: Samuel Cao
created: 2026-10-30
last_updated: 2026-10-30
description: Token-burndown ledger for the organize-and-tag build (PRD draft docs/prd_organize_and_tag_v0.2.md), checkpointed per unit.
ai_update: Append ledger lines; keep the NEXT line current; fill Handoff at stop.
---

# Burndown — 2026-10-30 (weekly usage 76% at start; reset time not given)

Context: Sam went to sleep and asked for as much as possible without input.
Building PRD v0.2 on `claude/eager-galileo-wx2cge` only. The PRD was not
explicitly signed off; "get as much done without input" is taken as the
go-ahead for reversible branch work. NOT in tonight's queue: pushing to
`claude/photournament-prd-v1-8-fojs7d` (deploys the live site) — waits for
his "proceed". Phase 0 usage experiment skipped (no meter readings tonight).

## Queue (value per token, each unit committable)
1. Metadata reader (EXIF/GPS + IPTC/XMP place names) + unit tests
2. Record plumbing: `photo.capture` on fresh and cached ingests
3. `PT.organize` pure module (categories, events, location clusters) + tests
4. Tag store + lightbox tag bar (Shift+1..9)
5. Sort mode: entry choice + Sort screen
6. Sort export: priced copy-into-folder / manifest
7. Culling: allocation "Organize by" chip row
8. Culling export: category folders, per-tag sets, CSV
9. Tags on bracket panes + export review
10. E2E tests (sort, organize-in-cull, tags)
11. PRD v1.11 §7.12, README, handoff
12. Adversarial review pass + fixes

## Ledger
- 10:20 ✅ units 1+2: whitelist capture reader (EXIF/GPS, XMP/IPTC places; JPEG/PNG/WebP/HEIC) + 14 unit tests; `photo.capture` on fresh and cached ingests — committed (see git log)
- 10:45 ✅ unit 3: `PT.organize` (32_organize.js): 11 categories, events, offline location clusters, named missing buckets; 16 unit tests
- 11:25 ✅ unit 4: `PT.tags` (36_tags.js) + lightbox metadata row and tag bar, Shift+1..9; browser-verified (two focus bugs found and fixed)
- 11:55 ✅ unit 5: entry mode choice; shared Organize-by control (38_organize_ui.js); Sort screen (55_screen_sort.js) with grouping, selection, tagging; browser-verified
- ▶ NEXT: unit 6, Sort export: priced copy-into-folder / manifest (CSV+JSON), per-tag copies

## Handoff
(filled at stop)
