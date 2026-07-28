repo: zillaness/Photournament
branch: claude/photournament-prd-v1-8-fojs7d
path: src

## Last sync
date: 2026-07-28T08:12:32Z

### Updated in this project
- Read every screen module and both stylesheets, then wrote a single replacement stylesheet: `photournament_ui_v2.0.css`.
- Built `Photournament v2.dc.html`, a clickable prototype of all eight screens using the app's real class names and ids, loading that stylesheet directly.
- Redesigned the folder tree and grid pass first, per the brief in `docs/ui_redesign_prompt_v1.0.md`.
- Listed the JS/markup changes the new stylesheet expects in `markup_notes_v1.0.md`.

## Screen map
| Project screen | Repo files it was built from |
| --- | --- |
| Entry | src/js/40_screen_ingest.js (welcome), src/css/10_screens.css, src/index.html |
| Ingest progress | src/js/40_screen_ingest.js (ingest, renderTriage, reportCache) |
| Folder tree | src/js/50_screen_tree.js, src/js/30_tree.js |
| Pass configuration | src/js/60_screen_grid.js (configCard, renderSetup) |
| Grid pass | src/js/60_screen_grid.js (renderPass, paintScreen, paintState, photoCell) |
| Cut pile rescue | src/js/60_screen_grid.js (renderRescueLimit, renderRescueReview) |
| Bracket matchup | src/js/70_screen_bracket.js (paintMatch, buildPane, injectStyle) |
| Final ranking | src/js/70_screen_bracket.js (paintDone) |
| Duplicates | src/js/70_screen_bracket.js (paintRunoff, runoffGroupEl) |
| Export review | src/js/80_screen_export.js (renderList, destName) |
| Shell, topbar, toasts, modal | src/index.html, src/js/99_app.js, src/css/00_base.css |
