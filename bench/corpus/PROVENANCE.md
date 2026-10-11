# Benchmark corpus provenance

Every file here is generated deterministically by `bench/corpus/generate.ts` from standard command-line tools
(ImageMagick `convert`, ffmpeg with its bundled `flite` voice and `aevalsrc`/`mandelbrot` sources, and jszip) and
from text written for this project. No third-party photographs, recordings or documents are included, so nothing
carries an external licence: all files are released under the repository licence (CC0 for the generated content).
`manifest.json` lists the SHA-256 of each file; `tests/bench-corpus.test.ts` checks the files against it and the
total against the 5 MB budget. Regenerate with `npx tsx bench/corpus/generate.ts` and commit the new manifest.

| File | Class | How it is made |
|---|---|---|
| `photo-a.jpg` | photo (JPEG, 768x512) | `convert -seed 7 plasma:fractal`, blurred, Gaussian noise added, JPEG quality 92 |
| `photo-b.png` | photo with a hard-edged subject (PNG, 640x432) | `plasma:fractal` seed 21 with a soft ellipse composited, noise added |
| `screenshot.png` | screenshot-like UI (PNG, 1024x640) | `convert -draw`/`-annotate` with DejaVu fonts (Bitstream Vera licence) |
| `lineart.png` | line art (PNG, 640x640) | anti-aliased circles, spokes and a polygon drawn with `convert -draw` |
| `clip.mp4` | short video (H.264, 320x240, 24 fps, 2 s, no audio) | ffmpeg `mandelbrot` source encoded with x264 at CRF 14 |
| `speech.wav` | speech (16 kHz mono PCM, 7.9 s) | ffmpeg `flite` filter (voice `slt`) reading a pangram text |
| `music.wav` | music (44.1 kHz stereo PCM, 4 s) | ffmpeg `aevalsrc` plucked-note chords (sums of decaying sines) |
| `scan.png` + `scan.gt.txt` | scanned page for OCR (grey PNG) | text of `scan.gt.txt` rendered with `convert`, rotated 0.6 degrees, blurred, noise added (a deliberately poor scan, 16 pt text) |
| `report.docx` + `report.gt.txt` | office document | built with jszip from the text of `report.gt.txt`: headings, paragraphs and a table, fixed timestamps |
| `data/records.jsonl` | compressible structured data | seeded generator (mulberry32) of 5000 JSON-lines log records |

The ground-truth texts (`scan.gt.txt`, `report.gt.txt`) are original prose written for this repository. Synthetic
photographs are textures, not natural scenes; they exercise smooth gradients, noise and edges but understate the
detail of real photographs, so absolute numbers are for trend tracking rather than public comparison.

## Vector graphics, CAD and office parts

These files are written by `generate-vector-cad.ts` and `generate-office.ts` (CC0, like the rest of the corpus), each
with the ground truth its family scores against. Every shape, entity and number is a pure function of the constants in
the generator, so a re-run yields the same bytes; both generators refresh only their own folders in `manifest.json`.
The camera RAW rows use no committed file: they read the public-domain (CC0) samples of `tests/fixtures/raw/manifest.json`
(`npm run fixtures:raw`), checked against the SHA-256 listed there. The slide rows read
`tests/fixtures/golden/office/drawingml-shapes-presentation.pptx`, checked against `tests/fixtures/golden/corpus-manifest.json`.

| File | Class | How it is made |
|---|---|---|
| `vector/shapes.svg` | vector drawing (400 x 300) | seven solid shapes (rectangles, circles, an ellipse, polygons) in painter's order |
| `vector/shapes.eps` | the same drawing as Encapsulated PostScript | the same shape list written as PostScript operators, y axis flipped |
| `vector/shapes.truth.png` | ground truth of the two above | the shape list rasterised analytically: an 8 x 8 point grid per pixel, topmost shape per point, no renderer involved |
| `vector/label.svg` | vector drawing with text | three lines of text in DejaVu Sans |
| `vector/label.gt.txt` | words of `label.svg` | the three lines |
| `cad/plate-basic.dxf` | 2D drawing, 200 x 120 mm plate | LINE, ARC, CIRCLE, LWPOLYLINE and TEXT entities, written as AC1015 ASCII DXF |
| `cad/plate-full.dxf` | the same plate with field entities | adds ELLIPSE, SPLINE, POLYLINE with VERTEX, INSERT of a block and MTEXT |
| `cad/plate-basic.truth.json`, `cad/plate-full.truth.json` | stroke geometry of the two drawings | polylines in drawing units, sampled from the entity list the DXF is written from (arcs every 2 degrees, the spline by de Boor evaluation), with the boxes and words of the text |
| `office/workbook.xlsx` | two-sheet workbook | column widths, number formats, bold headers, SUM and AVERAGE formulas with cached results, wrapped text, built with jszip |
| `office/workbook.gt.txt` | text the workbook displays | the cells formatted from the numbers they are written from |
