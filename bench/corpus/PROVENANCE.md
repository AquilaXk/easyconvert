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
