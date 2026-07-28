# Photournament final identity

The final identity pairs the `Photournament` wordmark with the simple nine-cell
selection mark, adding recursion only inside the top-left source cell. Each
nested round selects its center while the next round continues through the
top-left cell—a compact expression of repeated culling and advancement.

## Recommended use

- `01-logo/photournament-logo-recursive-dark.svg` — primary horizontal logo
- `01-logo/photournament-mark-recursive-dark.svg` — standalone large mark
- `02-favicon/favicon.ico` — traditional browser favicon
- `02-favicon/favicon.svg` — scalable browser favicon
- `03-app-icons/apple-touch-icon.png` — 180 px touch icon
- `03-app-icons/icon-192.png` and `icon-512.png` — app/PWA icons
- `04-repository-ready/` — assets in their intended repository paths, the
  integrated source HTML, and rebuilt standalone app files

## Responsive geometry

The logo, large mark, and app icons retain deep recursion and rounded corners.
The favicon family switches to square corners for greater clarity at small
sizes. Its 16, 32, and 48 px PNGs are individually pixel-tuned, while the SVG
favicon uses the same square treatment as its scalable fallback.

The top-left cell still contains a nested selection and white micro-center, so
the concept survives without turning into visual noise. In every raster size,
the nested grid occupies the exact outer bounds of the top-left parent cell.

## Palette

- Background: `#171717`
- Grid cells: `#474747`
- Selected frame: `#F3F3F3`

Use the dark-background logo as the primary lockup. Keep at least one top-level
cell width of clear space around the mark.
