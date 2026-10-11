# Quality benchmark

`npm run bench:quality` converts the committed corpus (`bench/corpus/`, see `PROVENANCE.md`) through the project's
public conversion dispatcher, measures each output with independent tools, compares it with a reference encoder at
the same settings, and checks the result against `bench/baseline.json`. The plain run is the check against our own
baseline; `--parity` is the merge gate that compares every row with the reference tool itself (see "Reference
parity" below).

## Commands

| Command | Effect |
|---|---|
| `npm run bench:quality` | Run every family, write `bench-results/<date>.json` and `.md`, gate against the baseline. Exit 0 pass, 1 regression, 2 run failure. |
| `npm run bench:quality:update-baseline` | Run, then rewrite `bench/baseline.json` from the measured rows. Review the diff before committing. |
| `npm run bench:quality -- --baseline-from-report <report.json>` | Add the rows of a report that a CI run measured (Linux, `ORACLE_STRICT_MODE=1`, no injected regression, with its workflow source) to `bench/baseline.json` when the baseline has no entry for them; an existing entry is never rewritten. The way new rows get their numbers from the runner. |
| `npm run bench:quality -- --family image,audio --runs 3` | A subset of families (`image video audio ocr document compression pdf-ops data ebook font`) and the number of interleaved timing runs (default 5, at most 25; video, OCR and office use at most 3). |
| `npm run bench:quality -- --no-gate` | Measure and report without gating. |
| `npm run bench:quality -- --inject-regression webp-quality` | Degrade our side on purpose to show the gate fails and names the metric. `webp-quality` lowers the WebP quality setting (a regression against our baseline; it stays on the same rate-distortion curve, so it is not behind the reference at equal size). `webp-reencode` encodes WebP twice (a worse curve, which BD-rate sees). `x264-ultrafast` switches H.264 to the ultrafast preset. `slow-ours` makes every timed run of our side twice as long (a speed regression). |
| `npm run bench:quality -- --compare-report <file>` | Gate an existing report without measuring. |
| `npm run bench:quality -- --parity [--family a,b] [--quick] [--quality-only \| --speed-only] [--base-gaps <file>] [--base-root <dir>]` | The reference-parity gate. Exit 0 pass, 1 regression against the baseline, 2 run failure, 3 a row below the reference. |

`ORACLE_STRICT_MODE=1` turns a missing reference tool from an explicit skip (listed in the report) into a failure. The data and
font families also need Python (`python3`) with pyarrow, DuckDB, openpyxl and fontTools, which CI installs pinned (`.github/actions/ci-setup`);
the reference tools of the new families are listed in the table below, and the report's `tools` field records the version of each.
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
| compression | tar to zst and 7z; zst, xz and 7z back to tar; tar to zip, gz and tar.bz2; zip, gz, bz2 and rar back to tar (the rar input is a stored RAR 4.x archive written by `tests/helpers/rar4-stored.ts`, no open-source RAR writer exists) | size ratio, compress and decompress MB/s; every output is decoded by the reference tool and compared with the original bytes (a `lossless_exact` row for the archive formats that records 1 or 0) | `zstd`, `7z`, `xz`; Info-ZIP `zip -6` and `unzip`, `gzip -6`, `bzip2 -9`, `unrar` |
| data | a typed table of 2,500 rows (commas, quotes and line breaks inside cells, digit strings with leading zeros, `1e4`-style strings, empty cells, East Asian text, emoji, ISO timestamps) from CSV to JSON and Parquet and XLSX, from JSON lines to CSV, from Parquet to CSV and JSON, from XLSX to CSV | cells of the output that are not the cells of the source, counted after the output is read back by a parser that is not the product's (Python `csv` and `json`; pyarrow and DuckDB as two independent Parquet readers, the worse one counts; openpyxl): the same text, the same instant for a timestamp and the same boolean count as equal, a number for a string does not; bytes of the Parquet and XLSX outputs; MB/s | DuckDB (CSV and JSON), Apache Arrow (Parquet), both kept up in one Python process (`bench/reference-server.ts`) so the time is the conversion's and not the interpreter's; `soffice --convert-to` for XLSX (a cold process, as for documents) |
| ebook | one book (ten chapters, a list, a table, a picture; 5,300 words) as EPUB, FB2 and MOBI to txt and pdf, and from MOBI and FB2 to EPUB | word F1 of the output text against the text the book was written from (the text itself, `pdftotext`, the spine of the EPUB read by the benchmark); for EPUB outputs EPUBCheck errors and the precision and recall of the headings (WHATWG parser) against the source package; pictures found in a PDF (`pdfimages`) or an EPUB; end-to-end time per book | calibre `ebook-convert` (the standard ebook converter, GPL-3.0, run as a separate process; a cold process per conversion) |
| font | DejaVu Sans (subset, about 800 glyphs) with TrueType outlines and hinting, and the same glyphs in CFF: to and from WOFF and WOFF2, TrueType to CFF and back | size of the encoded file against the reference's; tables of the decoded font that differ from the reference decoder's output (WOFF2) or from the source font (WOFF), byte for byte except `head.checkSumAdjustment`; for the outline conversions (no reference converter exists, so spec conformance is the bar) glyph count, character map, advances, vertical metrics, required tables and each outline's area, centroid and second moments against the source's; end-to-end time | `woff2_compress` and `woff2_decompress` (the WOFF2 reference implementation), `sfnt2woff` and `woff2sfnt` (the WOFF 1.0 tools); fontTools reads the files as the independent parser |
| pdf-ops | merge of three PDFs, a text watermark on pages 2 and 3 of three, AES-256 protection, decryption and unlocking (owner restrictions removed on a confirmed request) of a PDF, split into one file per page, extract (`3,1`), delete (`2`), reorder (`3,1,2`) and rotate (pages 2-3 by 90 degrees) of a three-page PDF, and compress (profile `web`) of a PDF with a photograph on every page (sources: `tests/fixtures/pdf-text`, and a PDF written by `bench/pdf-photo.ts` around `bench/corpus/photo-a.jpg`) | `qpdf --check` failures, page-count error, per-page word F1 of the `pdftotext` text against the source pages, SSIM of the `pdftoppm` pages against the source pages (merge, page operations, compress; pages the watermark leaves alone), watermark render equal to the reference render in the central square (SSIM at least 0.97), rotation of every page as `pdfinfo` reports it, `qpdf --show-encryption` equal to the reference's, output bytes, end-to-end time per operation | `qpdf` (`--pages`, `--split-pages`, `--rotate`, `--overlay` of a stamp PDF written in `bench/pdf-stamp.ts`, `--encrypt`, `--decrypt`); Ghostscript pdfwrite `/ebook` for compress |

Throughput rows time ours and the reference alternately in one window (the order flips every run) and report the
median of N runs per side, the coefficient of variation, MB/s of input and the speed ratio. A conversion of milliseconds is timed over five back-to-back calls per sample (the mean per call), so scheduler jitter does not decide it. Only the ratio is
compared, never the absolute speed, so the result does not depend on the machine. Our side is called in-process and the reference is spawned, so small
inputs favour the reference by the process start-up cost; the ratio is for tracking, not for ranking.

The video rows use the same ffmpeg encoder arguments on both sides, so their BD-rate is 0 until the project's
encoder settings change; they exist to catch that change.

## Public sample sets

The generated corpus (`bench/corpus/`, 4 MB) is a trend tracker: its pictures, clips and tracks are synthetic. The families that
encode media or compress files also measure the public sample sets that codec and compressor evaluations use, so that "at or above
the reference" holds beyond one or two inputs per pair. `bench/corpus/remote-manifest.json` pins every sample (origin, size,
SHA-256, licence code); `bench/corpus/PROVENANCE.md` records the licence of each one; `bench/corpora.ts` fetches them.

| Family | Samples | Classes |
|---|---|---|
| image | the Kodak lossless suite (24 pictures), ten pictures of the CLIC 2020 professional validation set (512x384 to 2048x1365), seven screenshots, four line-art pictures, two more diagrams with a transparent background (the line-art icon has one too), three 16-bit pictures (a grey radiograph, two RGB) | photo, screen, lineart, alpha, deep |
| video | the first frames of 13 sequences of the AV1 common test conditions (270p to 1080p, 0.7 to 3 s): natural scenes, fast motion, screen content and game capture, computer animation, film grain | natural, highmotion, screen, animation, grain |
| audio | 14 tracks of the EBU SQAM material (speech in three languages, solo instruments, voice, castanets, claves and a side drum, orchestra, pop), a 24-bit studio production, and five edge cases built from them (a quiet passage with one burst, 8 kHz telephone speech, a 5.1 mix, a clipped signal, 96 kHz 24-bit) | speech, instrument, vocal, transient, orchestra, pop, modern24, edge |
| compression | the 12 files of the Silesia corpus (5 to 51 MB: text, markup, source, executables, databases, medical images, a PDF), a JPEG and a FLAC file as already compressed members | text, markup, source, binary, database, data, medical, compressed |

**Cases and rows.** A sample is a case like any other, named `<sample id>-><target>` (`kodim23.png->avif`,
`aom-debugging-1080p.y4m->h264`, `sqam-27-castanets.flac->opus`, `silesia-xml.tar->zst`), measured with the same oracles and the same
rows as the generated corpus. A sequence is stored once as a lossless H.264 file, which decodes to the sequence's frames, and both
sides encode that file; an audio track is cut to its first 12 s as PCM. The compression cases wrap the sample in a tar like `mixed`.
The Silesia files `xml`, `samba` and `mozilla` are tar archives, so converting one of their streams to tar gives back an archive with
the same entries, and the check compares the files, not the padding. A picture with transparency is compared flattened onto
mid-grey and is not converted to JPEG. A product output that the oracle cannot read, or a sample the product rejects, is a row
(`converts` or `lossless_exact` at 0, below the reference), not an ended run, so one sample cannot hide the others.

**Per sample and per class.** Quality verdicts are never one number for the whole set. Every sample has its own rows and is judged
alone, like the BD-rate over the four-point curve of a codec comparison. Beside them each content class has rows named
`class-<class>-><target>`: the mean of the BD-rates of its samples without weights (the average over a class that video codec
evaluations report), and for compression the ratio pooled over the class (sum of compressed over sum of original sizes). A class
row exists only when every sample of the class was measured for the target, so a skipped sample states nothing about its class. A
sample whose points determine no BD-rate (a curve that is flat or shares no quality with the other, which happens to flat
graphics coded near losslessly at every quality) has skipped BD-rate rows that say why and leaves the class mean; the rest of its
rows are judged at the headline quality.

**Fetching.** A sample is fetched from the host that publishes it the first time a run needs it and kept in
`.bench-corpora/<family>/<sha256>` (git-ignored; `BENCH_CORPUS_CACHE` moves it). A digest or size that differs from the manifest
fails the run. A host that does not deliver fails a run under `ORACLE_STRICT_MODE=1` and otherwise skips the rows of that sample
(listed in the report). CI caches the directory per family with `actions/cache`, keyed by the hash of the manifest
(`.github/actions/bench-corpora`); `npx tsx bench/corpora.ts verify` fetches and checks everything, and
`npx tsx bench/corpora.ts pin <seeds.json>` resolves the origin, size and digest of new samples.

**Which runs measure them.** The nightly run measures every sample's quality rows and the throughput rows of the samples in
`PUBLIC_SPEED_SAMPLES` (`bench/config.ts`: a few per class, because speed follows the code path and the input size more than the picture,
and a timed row costs many pairs). A pull request's quality job (`--quick`) measures the cases of `QUICK_PUBLIC_SUBSET`, whose
reference side is read from the cache the nightly run keeps. A pull request's speed job sets `BENCH_CORPUS_TIER=pr` and times the
generated corpus only, as before; a change that lands a speed gap on a public sample is found by the nightly run (the gate files
that judge speed rows are the base's, `scripts/ci-parity-base-gate.mjs`, so the number of rows a pull request times stays as it was).

## Gate

Each baseline entry has a direction (`higher` or `lower` is better) and a tolerance (`abs`, `rel`; the larger
applies). A measured row fails when our value is worse than the baseline value by more than the tolerance, when our
delta to the reference is worse than the baseline delta by more than the tolerance. Every failing metric is printed as
`REGRESSION <row id>: ...`. Tolerances are edited by hand in `bench/baseline.json`; `--update-baseline` keeps them and
only rewrites the numbers.

**Throughput rows never fail this gate.** On a shared runner the wall-clock time of a run moves by 10 to 20 percent
between jobs, and a speed ratio against a spawned reference tool moves with it, so a stored number compared with a fixed
tolerance fails on noise (the same code measured the office conversions 40 percent apart on two nights). A throughput
row's ratio worse than its baseline entry by more than the tolerance is printed as `note <row id>: ...` and nothing
else. Speed is judged only by the parity speed jobs, from ratios measured interleaved in one job and compared with the
reference tool and, for tracked rows, with their own history (below). Quality rows are gated exactly as before.

## BD-rate

`bench/bd-rate.ts` follows VCEG-M33 (Bjontegaard): a cubic fit of ln(rate) against quality, integrated over the
overlapping quality range, reported as a percentage (negative: ours needs fewer bits). `tests/bench-bd-rate.test.ts`
checks it against published curve pairs and an exact closed-form case.

## Baseline and tool versions

`bench/baseline.json` was recorded with the tool versions listed in the report's `tools` block (see the `.md`
summary). Pixel and sample metrics are deterministic for fixed versions; a different `cwebp`, `avifenc`, ffmpeg or
libvpx build can move them, so refresh the baseline in the same change that moves the toolchain.

## Reference parity

A conversion change merges only when it is at or above the reference tool in both quality and speed. `--parity` runs
the same corpus and cases, then judges every row against the reference tool itself instead of against our last
baseline. It also runs the baseline gate on what it measured, so a metric that got worse than our own baseline fails
with exit 1 whether or not it is behind the reference.

| Row | At or above the reference means |
|---|---|
| BD-rate (`bd_rate_*`) | ours is at most 0 (a negative BD-rate needs fewer bits at equal quality) |
| CER, word F1, loudness and true-peak drift | the metric's own direction: ours is no worse |
| Compression ratio, lossless size | ours is no larger |
| SSIM, PSNR, SNR, VMAF, bytes, bit rate of a lossy case | not worse at equal size; where the sizes differ the case is judged by its BD-rate (a lowered quality setting moves along the same rate-distortion curve and is not behind the reference) |
| Lossless exactness | ours is 1 |
| Throughput | the lower bound of the speed-ratio interval is at least `1 - SPEED_PARITY_TOLERANCE` (0.03) |

The row's own tolerance in `bench/rows.ts` is the measurement allowance and nothing more: a number worse than the
reference by no more than that passes, and the summary counts it as "within the measurement allowance".

**Speed** is decided by a paired test measured in the same job, never cached and never compared with a stored number.
Ours and the reference run alternately (the order flips every pair) after a warm-up (five rounds for light rows, since
our side runs in-process and its JIT needs them; one for video, OCR and office), and each pair gives the ratio of
reference time to our time. The interval is the sign-test interval of the median ratio, taken from the order
statistics of the sorted ratios (`bench/speed-parity.ts`): 95 percent coverage, no distribution assumption, no random
numbers. PASS when its lower bound is at least 0.97, FAIL when its upper bound is below 0.97, otherwise UNSTABLE: four
more pairs are added, up to 25 for light rows and 12 for video, OCR and office, and then (second cap) up to 50 and 36
(`SPEED_LIGHT_EXTENDED_MAX_PAIRS`, `SPEED_HEAVY_EXTENDED_MAX_PAIRS`; the interval is exact up to 64 pairs). The extension
is sequential sampling: only a row still undecided at the first cap pays for it, and it stops at the first decision. A
row still undecided at the last cap is a failure of this absolute rule, which the nightly run and a run without a base
(`--parity` without `--base-root`) apply to every row, and the pull request job applies to a row the base cannot run.

**Pull requests: speed against the base of the change.** A fixed line cannot be both stable and sensitive for a row whose
true ratio sits near it (issue #700: a row at 0.98 straddles 0.97 at any cap, and an unchanged row fails by chance), so the
`parity speed` jobs of a pull request judge the change by what it did to the row, as performance gates that compare with the
base branch do. A job takes the first parent of the merge commit it tested as the base (not the event's base sha, which can be
older), checks it out beside the head (`ab-base`) with its own dependencies (its own `npm ci` when its lock file differs,
cached by the lock file's hash; a change of a dependency is measured), and measures three sides in every pair, in a rotating
order of the six permutations: the head and the base, each in a node process of its own started in its checkout
(`bench/ab-host.ts`, `bench/ab-child.ts`: its tsconfig, its `node_modules`, `BENCH_PRODUCT_ROOT` pointing at it), and the
reference, run by the benchmark's process, which does nothing else while a child works. Rows are matched by id (`bench/ab-host.ts`): a row a child does not time is a row it cannot run and is measured against the reference alone, and the row the child announced instead is kept for the benchmark's next request, so the processes never get out of step. Every speed row of a family runner names itself with `speedRowId` and loads the product through `importProduct` (`tests/bench-product.test.ts` checks both). The head and the base being
alike (two processes, two checkouts, one family runner) is what makes their ratio fair: measured with the base in the
benchmark's own process the ratio of two copies of one code was 0.97 on most image rows. Noise common to the three
samples of a pair (this runner, this minute) cancels in the head-to-base ratio. A row **fails** when

- the head is credibly more than `delta` slower than the base, `delta` being the row's own threshold from `AB_ROW_REGRESSION`
  (each with the noise that justifies it, none above the cap of 50 percent, `AB_REGRESSION_CAP`) and 10 percent
  (`AB_DEFAULT_REGRESSION`) for the rows that have none: the one-sided
  upper confidence bound of the median of base time / head time is below `1 / (1 + delta)`, and a second set of fresh
  pairs (as many as the first, taken after it) shows it too; or
- the base was at the reference (median reference time / base time at least 0.97) and the head is credibly below it (that
  bound for reference time / head time under 0.97), confirmed the same way; or
- the row is a tracked gap (`bench/parity-gaps.json`) and the level of its history (the median of its points, or the
  recorded ratio) times the median head-to-base ratio is under the floor or the prediction bound of that history: the history
  rule of the nightly run applies to what the change did, so a change that walks a gap down by less than `delta` at a time
  still cannot do it run after run.

The bound is the exact sign-test bound (the order statistic x(n + 1 - k), Conover section 3.2) at the error rate
`AB_FAMILYWISE_ALPHA / AB_ROW_BUDGET` = 0.01 / 50 = 0.0002 per row (Bonferroni), so a run of up to 50 rows of unchanged
code fails with a probability under 1 percent; the confirmation is taken at 0.01 and makes a failure need two independent
sets, because noise comes in bursts of minutes on a shared runner and one set of pairs can be shifted by one. The first
pairs are fixed, a whole number of cycles of the six orders so that every order runs equally often: 24 for light rows and 18
for video, OCR and office rows (ranks 4 and 2 at that error rate), no peeking.

**Extra pairs and the time of the job.** The job is a matrix, one `parity speed (<family>)` shard per changed family, in
parallel (`bench_families_json` of the `changes` job), so the wall time of a pull request is that of its slowest family and
not the sum of all of them. A row whose first pairs leave it undecided (its lower bound under its slowdown line and its upper
bound over it: it could still turn out slower than its threshold, or not) gets six more pairs at a time, up to
`AB_MAX_PAIRS` = 240, while the extra measuring time of its shard (`AB_EXTRA_BUDGET_MS`, 4 minutes) lasts; the budget is one
per shard, shared by its rows in the order of the benchmark, and the confirmation sets of failing rows are charged to it. A
row the first pairs decide (credibly not slower than its threshold, or credibly slower) gets none: more pairs cannot make it
fail. The width of the bound does not depend on whether the head is slower, so extending does not change the error rate.
Everything else passes: a row below the reference that the base was already below is the standing gap the nightly run
reports, not a failure of this change. A row the base cannot run (a new capability) is measured against the reference alone,
as above, and marked `abFallback` in the report.

**A change cannot loosen the gate that judges it.** The files that decide a speed row (`GATE_FILES` in
`scripts/ci-parity-base-gate.mjs`) are taken from the base commit before the job measures (`ci.yml`, "Use the gate of the
base"): the verdict, its exit code and its thresholds (`judge.ts`, `parity.ts`, `gate.ts`, `speed-config.ts`,
`speed-parity.ts`, `speed-history.ts`, `ab-config.ts`, `ab-speed.ts`), how a speed row is timed and built
(`speed-timing.ts`, `speed-rows.ts`, the A/B host, child core and protocol, `product.ts`), the shape of a row a verdict can
read (`report-schema.ts`) and the helpers under them (`stats.ts`, `errors.ts`, `parity-gaps.ts`). What a family defines stays
the change's, as a change that adds a family or a row is measured with it: the family runners, `rows.ts` (the metric specs),
`config.ts`, `context.ts`, `report.ts` (the family names), `run.ts`, the corpus and the baseline; each of them delegates the
parts that judge or time to a gate file, so a change to them cannot move a threshold, a bound or a row's verdict. A row of the
change that the base does not know is judged by the absolute rule, and a gate file the base lacks is the change's own (the
change that introduces it is judged by it). The job fails when the base's gate does not fit the change's tree (`tsc` over
`bench/` and `scripts/`).

A change that needs another interface of the gate files (a renamed export, a new field the family runners read) lands in two
steps: the pull request that changes the gate files, judged by the gate of its base, and then the one that uses the new
interface, judged by the gate the first one merged. The `tsc` message of the job says so. `ab-base/` is a checkout of the base
commit and is excluded from `tsconfig.json` and `vitest.config.ts` and ignored by git, so neither the type check, the tests nor
the linter read it. (The workflow file of a pull request is the pull request's own, which GitHub runs; that is the limit of
what a check inside the repository can do.)

**What it measures on the CI runner** (nightly dispatch `ab_base_ref` with the commit under test as its own base, runs
38037770394 and 38038913260, two measurements of 40 speed rows, `bench/ab-noise-samples.json`; `npx tsx
bench/replay-speed-reports.ts --noise-out bench/ab-noise-samples.json <artifact>` regenerates it):

- No false failure: 0 failing rows of 80 row-measurements with the per-row thresholds (`npx tsx bench/replay-speed-reports.ts
  <artifact>`; the run before, with the earlier design, 0 of 80 as well). The bias of the comparison is nil: the mean of
  the log of the head-to-base median over the rows is +0.009 (run 38038913260; -0.006 and +0.002 in the two runs before),
  except `document/rich-structure.docx->odt`, which two copies of one code differ on by +0.17 in log terms, which is why that row
  is nightly-only. The earlier design, the head in the benchmark's process, gave -0.020 and failed
  `document/rich-structure.docx->odt` once with a median of 0.664; that is why the head runs in its own process and a failure
  needs a second set of pairs.
- The noise of the comparison (standard deviation of the log of the pair ratios): median 0.039, 90th percentile 0.136, worst
  0.230 in run 38038913260 (0.039, 0.181 and 0.315 in run 38037770394, whose 14 reports `bench/ab-noise-samples.json` holds
  and the thresholds derive from); the office conversions, `mixed.zst->tar` and `mixed.tar->7z` are the noisy rows.
- Extra pairs: none were taken for the unchanged code (80 of 80 row-measurements decided on the first 24 or 18 pairs: with
  its own threshold a row whose lower bound is over its slowdown line is credibly not slower, and nothing more is measured),
  so the shards ran on the first pairs alone. A change that makes a row slower, or that leaves it undecided, spends its
  shard's 4 minutes on that row.
- Wall time of a shard (the `bench-ab-speed (family)` job of run 38038913260, two measurements of the family back to back,
  minutes for the measuring step; one measurement is half): image 4.4, document 5.8, video 3.0, audio 2.3, compression 1.1,
  ocr 1.0, pdf-ops 0.8; the jobs took 5.9, 7.4, 4.6, 3.8, 2.6, 2.5 and 2.3 including checkout, dependencies and tools. One
  measurement of the slowest family, the document shard, is therefore about 3 minutes of measuring and 4.5 of job, and
  the extra budget adds at most 4 more: under the 11 minutes of the rest of CI. (Run 38037770394, with all rows
  extended: image 6.9, document 10.9 minutes per job for two measurements; the whole job before sharding took 19.7 minutes
  per measurement.)

**Nightly-only rows.** A threshold above 50 percent says little about a change (a row that must get 1.5 times slower to
be noticed is not guarded by a pull request), so no row has one: a row whose noise needs more than the cap
(`AB_NIGHTLY_ONLY` in `bench/ab-config.ts`, each with its noise, the run that measured it and why) is not judged on a pull
request. The `parity speed` job times it with one cycle of six pairs for the report, gives it no extra pairs and no
confirmation set, and its verdict passes it as `speed-nightly-only`; the nightly run, which judges every row against the
reference alone, still guards it (and so does the tracked-gap history of `compression/mixed.tar->7z`). 7 of the 40 speed
rows are nightly-only and 33 are gated on a pull request:

| Nightly-only row | Noise | Threshold it would need |
|---|---|---|
| document/rich-structure.docx->html/throughput | 0.196 | more than 125% |
| document/rich-structure.docx->odt/throughput | 0.136 | more than 125% (biased by +0.17 in log terms: two copies of one code differ systematically on it) |
| document/rich-structure.docx->epub/throughput | 0.197 | more than 125% |
| document/noori.hwp->txt/throughput | 0.181 | 106.3% |
| document/pdf-structure->docx/throughput | 0.187 | 125% |
| compression/mixed.tar->7z/throughput | 0.315 | more than 125% |
| compression/mixed.zst->tar/throughput | 0.122 | 56.3% |

Detection by simulation, per gated row, with the measured noise of that row, one extra budget per family shared by the gated
rows of the family in the order of the benchmark (a nightly-only row takes none), 300 trials per row (`npx tsx
bench/simulate-speed-gate.ts --noise bench/ab-noise-samples.json --row-trials 300`; `--derive` finds the thresholds below).
The threshold of a row is the smallest at which a head 1.5 times that much slower fails in at least 95 percent of the
trials; a row with the default threshold had a noise small enough for 10 percent. Unchanged code fails 0 percent on every
row.

| Row | Noise | Threshold | Unchanged fails | At the threshold fails | At 1.5 times the threshold fails |
|---|---|---|---|---|---|
| image/photo-a.jpg->webp/throughput | 0.023 | 10.0% | 0.0% | 0.3% | 100.0% |
| image/photo-a.jpg->avif/throughput | 0.033 | 10.0% | 0.0% | 0.0% | 98.0% |
| image/photo-a.jpg->jpg/throughput | 0.040 | 12.5% | 0.0% | 0.0% | 97.0% |
| image/photo-b.png->webp/throughput | 0.015 | 10.0% | 0.0% | 0.0% | 100.0% |
| image/photo-b.png->avif/throughput | 0.021 | 10.0% | 0.0% | 2.0% | 100.0% |
| image/photo-b.png->jpg/throughput | 0.037 | 10.0% | 0.0% | 0.0% | 96.7% |
| image/screenshot.png->webp/throughput | 0.025 | 10.0% | 0.0% | 0.0% | 100.0% |
| image/screenshot.png->avif/throughput | 0.025 | 10.0% | 0.0% | 0.0% | 100.0% |
| image/screenshot.png->jpg/throughput | 0.042 | 10.0% | 0.0% | 0.0% | 99.3% |
| image/lineart.png->webp/throughput | 0.018 | 10.0% | 0.0% | 0.0% | 100.0% |
| image/lineart.png->avif/throughput | 0.033 | 10.0% | 0.0% | 0.0% | 97.3% |
| image/lineart.png->jpg/throughput | 0.034 | 10.0% | 0.0% | 0.0% | 99.7% |
| video/clip.mp4->h264/throughput | 0.031 | 10.0% | 0.0% | 0.0% | 99.3% |
| video/clip.mp4->hevc/throughput | 0.020 | 10.0% | 0.0% | 0.0% | 100.0% |
| video/clip.mp4->vp9/throughput | 0.029 | 10.0% | 0.0% | 0.0% | 96.0% |
| audio/music.wav->opus/throughput | 0.035 | 10.0% | 0.0% | 0.0% | 95.7% |
| audio/music.wav->aac/throughput | 0.032 | 10.0% | 0.0% | 0.0% | 99.3% |
| audio/music.wav->flac/throughput | 0.031 | 10.0% | 0.0% | 0.0% | 98.3% |
| audio/speech.wav->opus/throughput | 0.020 | 10.0% | 0.0% | 0.0% | 100.0% |
| audio/speech.wav->aac/throughput | 0.023 | 10.0% | 0.0% | 0.0% | 100.0% |
| audio/speech.wav->flac/throughput | 0.045 | 10.0% | 0.0% | 0.0% | 96.0% |
| ocr/scan.png->pdf/throughput | 0.039 | 15.0% | 0.0% | 0.0% | 97.7% |
| document/report.docx->pdf/throughput | 0.057 | 20.0% | 0.0% | 0.0% | 96.3% |
| document/rich-structure.docx->pdf/throughput | 0.048 | 17.5% | 0.0% | 0.0% | 96.7% |
| document/pdf-text->txt/throughput | 0.029 | 10.0% | 0.0% | 0.0% | 98.3% |
| document/complex-script txt->pdf/throughput | 0.056 | 22.5% | 0.0% | 0.0% | 96.3% |
| compression/mixed.tar->zst/throughput | 0.054 | 15.0% | 0.0% | 0.0% | 95.0% |
| compression/mixed.xz->tar/throughput | 0.074 | 20.0% | 0.0% | 0.7% | 96.3% |
| compression/mixed.7z->tar/throughput | 0.116 | 42.5% | 0.0% | 0.0% | 95.3% |
| pdf-ops/merge.pdf->pdf/throughput | 0.105 | 22.5% | 0.0% | 43.7% | 95.0% |
| pdf-ops/watermark.pdf->pdf/throughput | 0.079 | 30.0% | 0.0% | 0.0% | 96.7% |
| pdf-ops/protect.pdf->pdf/throughput | 0.061 | 20.0% | 0.0% | 0.0% | 96.0% |
| pdf-ops/decrypt.pdf->pdf/throughput | 0.079 | 22.5% | 0.0% | 0.7% | 96.3% |

All 33 gated rows fail a head 1.5 times their threshold slower in at least 95 percent of the trials, and none fails
unchanged code in more than 1 percent (0 percent on every row). `pdf-ops/merge.pdf->pdf` fails 43.7 percent at exactly its
threshold: a head at the threshold is what the bound cannot decide, which is why the table also gives 1.5 times.

Detection by size, from the simulation with a quiet row (2 percent noise per sample, 1000 trials; the percentages are the
head's extra time over the base's):

| Rows | 0 to 10% | 15% | 20% | 30% |
|---|---|---|---|---|
| light, A/B gate fails | 0.0% | 96.3% | 100% | 100% |
| heavy, A/B gate fails (18 pairs, no extra) | 0.0% | 70.1% | 99.9% | 100% |
| absolute gate (the head against the reference alone), a row at parity | 0.0% light, 0.3% heavy | | | |
| absolute gate, a row at 0.98 | 42.3% light, 56.2% heavy | | | |

A row that needs a 10 percent slowdown seen asks for its own threshold: 5 percent detects a 10 percent slowdown in at least 95
percent of the light trials (`tests/bench-speed-gate-rate.test.ts`). The rows whose noise is too large for a slowdown of 15 to
20 percent are listed by `bench/ab-noise-samples.json`; making them quieter (pinned CPUs, fewer processes on the runner) is the
way to guard them closer.

**Minimum sample duration.** A timed sample of either side lasts at least `SPEED_MIN_SAMPLE_MS` (50 ms). Before the
timed pairs, the warm-up rounds of a row are timed; the fastest single call of each side sets the number of back-to-back
calls per sample, `ceil(50 / fastest call)` with at least 1 and at most `SPEED_MAX_SAMPLE_REPEATS` (1000), and each sample is
the mean per call (`calibrateRepeats` in `bench/speed-parity.ts`). The fastest call is taken because it is the one least
disturbed by the machine, which makes the count the safest. A row whose calls already last 50 ms, such as video, OCR and
office conversions, runs one call per sample; a row of a millisecond, such as `document/pdf-text->txt`, runs 50 calls, so
timer resolution and scheduler jitter are a small share of every sample instead of deciding the pair. The least calls
of ours a family asks for (`ctx.time(..., oursRepeats)`, `IN_PROCESS_REPEATS`) still apply. The log of a parity run
says which rows were batched. Batching cuts noise; it cannot decide a row whose true ratio sits at the pass line, and
such a row is tracked in `bench/parity-gaps.json`.

**Quality** of the reference side is deterministic for fixed tool versions, so it is cached in `.bench-cache/`
(ignored by version control), keyed on the reference tool names and versions, the content hash of every corpus file, the
settings and a hash of the harness code that takes the measurement (`bench/ref-cache.ts`). A changed key is a miss,
never a stale hit; an entry that fails its checksum or schema is reported, measured again and overwritten.
`--no-ref-cache` turns the cache off and `--cache-dir` moves it. CI restores it with `actions/cache`, keyed on
`--print-tool-fingerprint` and the corpus manifest; the nightly run is the only writer.

**`--quick`** measures a representative subset per family, listed as `QUICK_SUBSET` in `bench/config.ts`: the image
cases `photo-a.jpg->webp`, `photo-b.png->avif` (photographs, 4:2:0), `screenshot.png->avif` (graphics, 4:4:4),
`lineart.png->avif` (grey, 4:0:0), `lineart.png->jpg` and `lineart.png->webp`, so every target format and AVIF chroma path
has a quality row (`tests/bench-quick-subset.test.ts`); the video cases for H.264 and VP9; the audio
cases `music.wav->opus`, `speech.wav->aac` and `music.wav->flac`; and every case of OCR, office, compression, PDF operations, data, ebooks and fonts, which
are one case or seconds each. The per-push quality gate uses it; the nightly run measures everything.

**Which families a pull request runs** is decided by `bench/family-map.json`: each path under `src/lib/conversions/`,
`src/lib/workers/` and `src/worker/`, and the two graph files `src/lib/jobs/artifact-helpers.ts` (PDF merge, pdf-ops) and `src/lib/queue/graph/node-executor.ts` (dispatches every node, so every family), maps to a family (`scripts/ci-parity-families.mjs`, which the `changes` job of
`ci.yml` runs). Shared code (the dispatcher, the worker pool, the sandbox) maps to every benchmarked family, and so does what every
conversion runs on: the tool runner `src/lib/security/process-sandbox.ts`, `package.json` and `package-lock.json`, the
Dockerfiles, the seccomp profiles and `.github/actions/ci-setup/` (the SVG sanitizer maps to image). A path in
that scope that no rule covers fails the `changes` job, so a new file cannot escape the gate. A path that maps to a
family with `"bench": null` (cad, raw, vector, hdr-image) fails with "add reference-compared
bench rows for <family>" until the same change adds a runner in `bench/families/` and sets the family's `bench` to its
own name.

The benchmark's own files are mapped too, so a change to what measures or judges cannot skip the measurement: a family's
runner and helpers (`bench/families/<family>.ts`, `bench/pdf-stamp.ts`, `bench/structure-*.ts`, `bench/bd-rate.ts`, ...) map to
that family; the harness, the gate, the map, the corpus, `scripts/ci-parity-*.mjs` and `ci.yml` map to every family;
`bench/baseline.json` and `bench/parity-gaps.json` map to the families of the rows whose entries changed against the base
(`PR_BASE_SHA`; every family when the base cannot be read or a row names an unknown family).

A known-gap entry a pull request adds or edits is checked against that pull request's own speed run: the `parity speed` job
passes the base's `bench/parity-gaps.json` as `--base-gaps`, and the recorded ratio and every new history point (which must
carry the commit of a CI run) have to lie within the speed-ratio interval the job measured for the row, widened by
`GAP_BACKING_LOG_MARGIN`. A made-up entry fails with `gap-not-backed`; an entry the base already holds is not rechecked. A shard checks the entries of the family of its `--family` argument only (`run.ts` parses the argument and is the change's own file, so the judge of the base receives the head's value; an empty list counts as every family, and neither the `families` field nor the rows of the report say which family a shard is); the shard of another family checks that family's entries, and a family that emitted no rows is refused as unmeasured. The `changes` job fails when a changed entry's family has no shard in the run (`scripts/ci-parity-shards.mjs`, reading the base's family map and gap file). A row
measured against the base (above) was timed from a lighter benchmark process than the history, whose reference ratio is not
the same number for rows that are mostly a spawn (`mixed.tar->zst` 0.33 against 0.60, `document/pdf-text->txt` 0.59 against 1.2); for
such a row only the form of a changed entry is checked (a history point needs the commit of its run), and the history rule
applies to what the change did to the row.

**Known gaps and the staged rollout.** Most speed rows are below the reference today, so the gate is staged:

- *Quality is immediate.* Every quality row of a touched family must be at or above the reference. `bench/parity-gaps.json`
  never excuses a quality row: an entry only names the issue in the failure message (the image quality rows are tracked
  by #640 and still fail).
- *A speed row that is not listed* has to pass the sign-test rule outright.
- *A speed row that is listed is "tracked".* Being below the reference does not fail it, but it fails when its median gets
  slower than its own history predicts or falls 35 percent under the median of its history (next section). A tracked row that now passes the normal rule is reported as
  "now at parity: remove it from bench/parity-gaps.json". A row already at parity is not tracked and has to keep its
  interval lower bound at or above 0.97 in the same job, unchanged.
- *Every entry names its issue* (`issue` is required and the loader refuses `null`): image quality #640, image speed
  #641, audio #642, video #643, OCR #644, 7z/xz decompress and 7z compress #487, zstd compress #497 (and the near-parity zstd decode row, `compression/mixed.zst->tar/throughput`, until it has an issue of its own; its note says so). Speed entries carry
  the latest CI-measured `ratio` for display and a `history` of the ratios of the latest runs; remove the entry when
  the row reaches parity.

**The boundary of a tracked row.** A tracked row used to fail when its ratio fell 3 percent under one recorded number;
on a shared runner the same code moves a ratio by 5 to 10 percent between nights, so that rule failed on noise. The
boundary is now taken from the row's history, the way a regression is separated from run-to-run variation in
continuous benchmarking (`bench/speed-history.ts`):

- `bench/parity-gaps.json` keeps, per tracked row, the median speed ratios of the latest `SPEED_HISTORY_MAX_POINTS` (10)
  CI runs as `history: [{ ratio, at }]`, oldest first, with `at` the run's report time. Only `bench:refresh-speed --write`
  writes it, and only from reports measured on the runner (the nightly `bench-speed-results` artifact or the
  `parity-speed-results` artifact of a pull request); a laptop measurement cannot enter it, and refreshing the same
  report twice adds nothing.
- With the n historical ratios r_i, take x_i = ln r_i (ratios combine multiplicatively), their mean m and sample standard
  deviation s. A new measurement is predicted, with 99 percent one-sided confidence (`SPEED_HISTORY_CONFIDENCE`), to be
  above `exp(m - t * s * sqrt(1 + 1/n))`, where t is the Student's t quantile with n - 1 degrees of freedom (2.82 at
  ten runs, 3.75 at five, 6.96 at three). This is a one-sided prediction bound for one new observation, not a bound on the
  mean, so it includes the run-to-run variance of the runner.
- The row fails when its **median** (the number the history stores, and the one the bound predicts) is below that bound.
  The interval of the job's own pairs decides only whether the row passes the normal rule; its upper end, which for a
  heavy row can be a single lucky pair, is not used.
- **The floor.** The bound alone admits a large slowdown whenever a history is noisy, so a tracked row also fails when
  its median is below `SPEED_GAP_FLOOR` (0.65) times the median of its history since the last step, whichever limit is
  higher. The number comes from the runner: over three nightly runs of unchanged code the log ratio of a row moved by a
  standard deviation of 0.108 per run, the worst fall between two runs was 31 percent and the fifth percentile 24 percent,
  and a whole run is fast or slow together. A floor of 85 percent of the latest point failed 7 of 17 rows on the next
  run, so the level is the history's median (one lucky run does not set it) and the share is 65 percent, which still
  fails a halving of a speed.
- With fewer than `SPEED_HISTORY_MIN_POINTS` (3) runs there is no bound, and the floor is the only limit: a row with no
  history is held to 65 percent of its recorded `ratio`. A run that ended undecided at the cap counts the same way, by its
  median; the pass line of 0.97 is not used for a tracked row.
- **A history restarts at a step.** A speed-up that lands on main puts the older points on the wrong side of a code
  change, and their spread then measures the change, not the runner. A run more than `SPEED_STEP_FACTOR` (1.6) times the
  geometric mean of the history, or above the upper edge of its 99 percent prediction interval (the spread no lower than
  `SPEED_HISTORY_MIN_LOG_SPREAD`, 0.11), is a step up: the history restarts at that run. A drop never restarts it.
  `bench:refresh-speed -- --reseed --write` applies this to the histories on file.
- Each point keeps the commit its report was measured at.
- A tracked row's `ratio` field is the latest point rounded down, kept for display and for the gap note.

The report has separate sections: failing rows, tracked rows (with issue, ratio and interval), rows now at parity, then
the rows at or above the reference and the rows not evaluated.

**The `security` exemption** (`scripts/ci-parity-policy.mjs`): a pull request labelled `security` that links an issue
(`Closes #N`, `Refs #N`, ...) is excused from the parity verdict only. Tests, the guard, lint, build, the container and
conformance still run, and a metric worse than our own baseline still fails. The job then posts one comment listing the
rows below the reference and their gap issue, and opens or updates one `parity-gap` issue per family.

`ci.yml` wires this into `verify`: `parity-quality` runs on every push to a pull request that changes a conversion
family; `parity-speed` runs when the `automerge` label is on (and again for a commit pushed after it). With a
conversion family changed and no label, `parity-speed` is skipped and `verify` fails with "add the automerge label",
so auto-merge cannot fire before speed parity ran on the current head. The nightly workflow runs the full parity
benchmark on every family and case.

## Refreshing recorded numbers from CI

Speed depends on the machine, so the speed ratios in `bench/baseline.json` and `bench/parity-gaps.json`, and the
per-part durations in `.github/ci/conformance-durations.json`, are recorded from a CI run and never from a laptop.

**Speed ratios.** The nightly workflow's `bench-parity-speed` job measures every throughput row on the runner and keeps
the report as the `bench-speed-results` artifact for 30 days (the `parity speed` job of a pull request keeps
`parity-speed-results` for 7 days). The job summary also lists what a refresh would change. To refresh:

```sh
gh workflow run nightly.yml --ref <branch>        # main once merged; or pick the run of a pull request's parity speed job
gh run download <run id> -n bench-speed-results -D speed-results
npm run bench:refresh-speed -- speed-results            # dry run: prints every change
npm run bench:refresh-speed -- --write speed-results    # rewrites baseline.json and parity-gaps.json
```

The command takes only reports measured on Linux under `ORACLE_STRICT_MODE=1` by a `--parity` run, without an injected
regression, by a schedule, workflow_dispatch or push run of `main` (the report records its commit, branch and event);
anything else is exit 2, so a pull request's regressed report cannot lower the bound of later pull requests. A branch that
refreshes its own numbers before it merges names itself with `--allow-branch <branch>`. It sets the baseline `ratio` of every measured speed row (informational, see "Gate"), adds the median of each tracked
gap's interval to its `history` (four decimals, the latest ten runs since the last step, ordered by the report's time, with the commit), and sets the
gap's `ratio` to the latest point rounded down to two decimals (a note it generated is rewritten with it; a note written
by hand stays). Run it once per report: `bench:refresh-speed -- --write <run 1 artifact>`, then `... <run 2 artifact>`. A row whose interval was still undecided at the cap keeps its baseline ratio, but its median joins the history. A tracked row that now
passes is listed, not removed: delete its entry by hand in the same commit. Review the diff before committing.

**Conformance durations.** Each part of the `conformance` job uploads `conformance-durations-<part>` (14 days):

```sh
gh run download <run id> -p 'conformance-durations-*' -D conformance-durations
node scripts/ci-conformance-parts.mjs --update conformance-durations/*/conformance-part-*.json
node scripts/ci-conformance-parts.mjs --summary 10    # planned load per part, to check the balance
```

## Real-world corpus

`npm run bench:realworld` runs thousands of real files through the conversions users can request, to find crashes,
hangs and broken outputs that hand-authored fixtures miss. It runs nightly in ten shards (`.github/workflows/nightly.yml`).

```sh
npm run bench:realworld -- run --shard 1/10 [--per-file 3] [--workers N] [--deadline-ms 180000] [--limit 50]
npm run bench:realworld -- merge --out realworld-results realworld-shard-*.json [--update-baseline]
```

- **Corpus:** `bench/realworld/manifest.json` lists every file's origin, size, SHA-256 and the licence statement of its
  source. Files are never committed; the runner downloads them (single ZIP entries are read with range requests),
  checks each digest and caches them in `~/.cache/easyconvert-realworld`. `scripts/realworld-manifest.ts` rebuilds the
  manifest deterministically.
- **Jobs:** each file goes through `--per-file` of its format's advertised targets, rotating so that the corpus covers
  every pair. Jobs run in child processes with a deadline and a heap cap; a job past its deadline kills its process group.
- **Verdicts:** `ok`; `refused` (a typed error the API answers with 4xx or 503); `crash` (anything the API would answer
  with 500, or a dead job server); `hang` (deadline passed); `bad-output` (empty, wrong magic bytes, or refused by
  `pdfinfo` or ImageMagick `identify`).
- **Gate:** any crash, hang or bad output fails, and so does a pair whose refusal rate grew more than 2 points over
  `bench/realworld/baseline.json` (pairs with at least 20 jobs).
- **Triage:** reduce each failing file to a minimal input, commit it under `tests/fixtures/regressions/` with a failing
  test, then fix the reader.
