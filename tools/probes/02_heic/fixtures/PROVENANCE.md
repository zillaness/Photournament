# Fixture provenance

| file | source | bytes | decoded | structure |
|---|---|---|---|---|
| `photo_12mp.heic` | https://raw.githubusercontent.com/tigranbs/test-heic-images/master/image1.heic | 2,994,394 | 3992x2992 (11.94 MP) | `ftyp heic/mif1`, **grid** derived image over **48 `hvc1` tiles**, 50 `infe` entries, 2 `Exif` boxes. This tiled-grid layout is exactly what an iPhone camera writes. **This is a genuine HEVC-coded HEIC, not an AVIF stand-in.** |
| `example_strukturag.heic` | https://raw.githubusercontent.com/strukturag/libheif/master/examples/example.heic | 718,114 | 1280x854 x2 items | `ftyp mif1 / heic / hevc`. Upstream libheif's own example. Single non-tiled hvc1 + thumb. |
| `nokia_C003.heic` | https://raw.githubusercontent.com/nokiatech/heif_conformance/master/conformance_files/C003.heic | 224,452 | 1280x720 x2 items | Nokia HEIF conformance file C003. |

No AVIF fallback was needed and none is used. No npm packages were installed for this probe
(`sharp` was never required — a real 12MP HEVC HEIC was obtained directly).
