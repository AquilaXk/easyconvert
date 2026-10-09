# Quality benchmark

`npm run bench:quality` converts the committed corpus (`bench/corpus/`, see `PROVENANCE.md`) through the project's
public conversion dispatcher, measures each output with independent tools, compares it with a reference encoder at
the same settings, and checks the result against `bench/baseline.json`. It is not part of `verify` or CI; a
scheduled or label-triggered workflow is a separate change.

## Commands

| Command | Effect |
|---|---|
| `npm run bench:quality` | Run every family, write `bench-results/<date>.json` and `.md`, gate against the baseline. Exit 0 pass, 1 regression, 2 run failure. |
| `npm run bench:quality:update-baseline` | Run, then rewrite `bench/baseline.json` from the measured rows. Review the diff before committing. |
| `npm run bench:quality -- --family image,audio --runs 3` | A subset of families (`image video audio ocr document compression`) and the number of interleaved timing runs (default 5, at most 25; video, OCR and office use at most 3). |
| `npm run bench:quality -- --no-gate` | Measure and report without gating. |
| `npm run bench:quality -- --inject-regression webp-quality` | Degrade our side on purpose (`webp-quality` lowers the WebP quality setting, `x264-ultrafast` switches H.264 to the ultrafast preset) to show the gate fails and names the metric. |
| `npm run bench:quality -- --compare-report <file>` | Gate an existing report without measuring. |

`ORACLE_STRICT_MODE=1` turns a missing reference tool from an explicit skip (listed in the report) into a failure.
`ssimulacra2` and libvmaf are optional metrics and are only reported when installed.

The document family reads its inputs from `tests/fixtures/document` and `tests/fixtures/hwp` (provenance is recorded there) and calls the in-process engine directly, because the dispatcher prefers the office suite when it is installed. Its reference time is a cold `soffice --convert-to` process per document, so the speed ratio includes the office suite's start-up.

## What is measured

| Family | Cases | Metrics | Reference |
|---|---|---|---|
| image | jpg/png to webp, avif, jpg at quality 40/55/70/85 | SSIM, PSNR, bytes at quality 70; BD-rate over the four points (PSNR and SSIM-in-dB); ssimulacra2 when installed | `cwebp`, `avifenc`, ImageMagick |
| video | mp4 to h264, hevc, vp9 at four CRFs | SSIM, PSNR, bitrate, BD-rate, VMAF when libvmaf is present | ffmpeg `libx264`, `libx265`, `libvpx-vp9` |
| audio | wav to opus and aac at four bit rates; wav to flac | SNR (ffmpeg `asdr` after alignment), loudness and true-peak drift (`ebur128`), bit rate, BD-rate; FLAC bit-exact decode and size | ffmpeg `libopus`, `aac`, `flac` |
| ocr | scanned png to searchable pdf | CER and word F1 of the pdftotext text layer against ground truth | `tesseract` |
| document | docx to pdf (`report.docx`); an authored DOCX with nested lists, merged table cells, pictures and notes to html, odt, epub and pdf; an EPUB to docx; an HWP 5.0 file to html and txt | word F1 and CER of the text against the authored text; per structure category (headings, list items with level, table cells with spans, pictures by hash, notes) precision and recall against the structure written by hand; EPUBCheck error count; end-to-end time per document | `soffice` for the DOCX cases. It cannot open EPUB or HWP, so those rows use the hand-written structure or an independent OLE2 reader (`tests/fixtures/hwp/reference-extract.py`) as the reference, and the HWP time is compared with that reader |
| compression | tar to zst and 7z; zst, xz and 7z back to tar | size ratio, compress and decompress MB/s; every output is decoded by the reference tool and compared with the original bytes | `zstd`, `7z`, `xz` |

Throughput rows time ours and the reference alternately in one window (the order flips every run) and report the
median of N runs per side, the coefficient of variation, MB/s of input and the speed ratio. A conversion of milliseconds is timed over five back-to-back calls per sample (the mean per call), so scheduler jitter does not decide it. Only the ratio is gated,
so the result does not depend on the machine. Our side is called in-process and the reference is spawned, so small
inputs favour the reference by the process start-up cost; the ratio is for tracking, not for ranking.

The video rows use the same ffmpeg encoder arguments on both sides, so their BD-rate is 0 until the project's
encoder settings change; they exist to catch that change.

## Gate

Each baseline entry has a direction (`higher` or `lower` is better) and a tolerance (`abs`, `rel`; the larger
applies). A measured row fails when our value is worse than the baseline value by more than the tolerance, when our
delta to the reference is worse than the baseline delta by more than the tolerance, or (throughput) when the speed
ratio is. Every failing metric is printed as `REGRESSION <row id>: ...`. Tolerances are edited by hand in
`bench/baseline.json`; `--update-baseline` keeps them and only rewrites the numbers.

## BD-rate

`bench/bd-rate.ts` follows VCEG-M33 (Bjontegaard): a cubic fit of ln(rate) against quality, integrated over the
overlapping quality range, reported as a percentage (negative: ours needs fewer bits). `tests/bench-bd-rate.test.ts`
checks it against published curve pairs and an exact closed-form case.

## Baseline and tool versions

`bench/baseline.json` was recorded with the tool versions listed in the report's `tools` block (see the `.md`
summary). Pixel and sample metrics are deterministic for fixed versions; a different `cwebp`, `avifenc`, ffmpeg or
libvpx build can move them, so refresh the baseline in the same change that moves the toolchain.
