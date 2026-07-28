# Final top-left-recursion identity

The final logo keeps the primary nine-cell mark and `Photournament` wordmark.
Only the top-left source cell recurses. Every nested source grid selects its
center, while the next level continues through that grid’s top-left cell.

## Responsive icon strategy

- Full logo and large mark: deep recursion.
- 180, 192, and 512 px app icons: deep recursion inside a rounded app tile.
- SVG favicon: square-corner geometry with one explicit recursive level for
  predictable small rendering.
- 16, 32, and 48 px favicon PNG/ICO: individually pixel-tuned with square
  corners. Each retains a white micro-center inside the top-left source cell.

The small variants simplify depth, not concept: the recursive source and primary
white winner remain present at every supplied size. Rounded corners remain on
the primary logo, large mark, and 180/192/512 px app icons. The pixel-tuned
nested grid aligns exactly with the outer bounds of its top-left parent cell.
