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
| `npm run bench:quality -- --family image,audio --runs 3` | A subset of families (`image video audio ocr document compression pdf-ops`) and the number of interleaved timing runs (default 5, at most 25; video, OCR and office use at most 3). |
| `npm run bench:quality -- --no-gate` | Measure and report without gating. |
| `npm run bench:quality -- --inject-regression webp-quality` | Degrade our side on purpose to show the gate fails and names the metric. `webp-quality` lowers the WebP quality setting (a regression against our baseline; it stays on the same rate-distortion curve, so it is not behind the reference at equal size). `webp-reencode` encodes WebP twice (a worse curve, which BD-rate sees). `x264-ultrafast` switches H.264 to the ultrafast preset. `slow-ours` makes every timed run of our side twice as long (a speed regression). |
| `npm run bench:quality -- --compare-report <file>` | Gate an existing report without measuring. |
| `npm run bench:quality -- --parity [--family a,b] [--quick] [--quality-only \| --speed-only] [--base-gaps <file>] [--base-root <dir>]` | The reference-parity gate. Exit 0 pass, 1 regression against the baseline, 2 run failure, 3 a row below the reference. |

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
| pdf-ops | merge of three PDFs, a text watermark on pages 2 and 3 of three, AES-256 protection and decryption of a PDF (sources: `tests/fixtures/pdf-text`); split, rotate and compress are listed as unsupported because the product has no such operation | `qpdf --check` failures, page-count error, per-page word F1 of the `pdftotext` text against the source pages, SSIM of the `pdftoppm` pages against the source pages (merge; pages the watermark leaves alone), watermark render equal to the reference render in the central square (SSIM at least 0.97), `qpdf --show-encryption` equal to the reference's, output bytes, end-to-end time per operation | `qpdf` (`--pages`, `--overlay` of a stamp PDF written in `bench/pdf-stamp.ts`, `--encrypt`, `--decrypt`) |

Throughput rows time ours and the reference alternately in one window (the order flips every run) and report the
median of N runs per side, the coefficient of variation, MB/s of input and the speed ratio. A conversion of milliseconds is timed over five back-to-back calls per sample (the mean per call), so scheduler jitter does not decide it. Only the ratio is
compared, never the absolute speed, so the result does not depend on the machine. Our side is called in-process and the reference is spawned, so small
inputs favour the reference by the process start-up cost; the ratio is for tracking, not for ranking.

The video rows use the same ffmpeg encoder arguments on both sides, so their BD-rate is 0 until the project's
encoder settings change; they exist to catch that change.

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
`parity speed` job of a pull request judges the change by what it did to the row, as performance gates that compare with the
base branch do. It takes the first parent of the merge commit it tested as the base (not the event's base sha, which can be
older), checks it out beside the head (`ab-base`) with its own dependencies (its own `npm ci` when its lock file differs,
cached by the lock file's hash; a change of a dependency is measured), and measures three sides in every pair, in a rotating
order of the six permutations: the head and the base, each in a node process of its own started in its checkout
(`bench/ab-host.ts`, `bench/ab-child.ts`: its tsconfig, its `node_modules`, `BENCH_PRODUCT_ROOT` pointing at it), and the
reference, run by the benchmark's process, which does nothing else while a child works. The head and the base being
alike (two processes, two checkouts, one family runner) is what makes their ratio fair: measured with the base in the
benchmark's own process the ratio of two copies of one code was 0.97 on most image rows. Noise common to the three
samples of a pair (this runner, this minute) cancels in the head-to-base ratio. A row **fails** when

- the head is credibly more than `delta` slower than the base, `delta` being 10 percent (`AB_DEFAULT_REGRESSION`) unless the
  row has its own in `AB_ROW_REGRESSION` with the measurement that justifies it: the one-sided upper confidence bound of the
  median of base time / head time is below `1 / (1 + delta)`, and a second set of fresh pairs (taken after the first)
  shows it too; or
- the base was at the reference (median reference time / base time at least 0.97) and the head is credibly below it (that
  bound for reference time / head time under 0.97), confirmed the same way; or
- the row is a tracked gap (`bench/parity-gaps.json`) and the level of its history (the median of its points, or the
  recorded ratio) times the median head-to-base ratio is under the floor or the prediction bound of that history: the history
  rule of the nightly run applies to what the change did, so a change that walks a gap down by less than `delta` at a time
  still cannot do it run after run.

The bound is the exact sign-test bound (the order statistic x(n + 1 - k), Conover section 3.2) at the error rate
`AB_FAMILYWISE_ALPHA / AB_ROW_BUDGET` = 0.01 / 50 = 0.0002 per row (Bonferroni), so a run of up to 50 rows of unchanged
code fails with a probability under 1 percent; the confirmation is taken at 0.01 and makes a failure need two independent
sets, because noise comes in bursts of minutes on a shared runner and one set of pairs can be shifted by one. The pairs
are fixed, a whole number of cycles of the six orders so that every order runs equally often: 24 for light rows and 18
for video, OCR and office rows (ranks 4 and 2 at that error rate), no peeking. A row whose bound is too wide to show a
slowdown of 1.25 times its threshold gets six more pairs at a time, up to 60, while the extra measuring time of the job
(`AB_EXTRA_BUDGET_MS`, 12 minutes) lasts; the width of the bound does not depend on whether the head is slower, so this
does not change the error rate. Everything else passes: a row below the reference that the base was already below is
the standing gap the nightly run reports, not a failure of this change. A row the base cannot run (a new capability) is
measured against the reference alone, as above, and marked `abFallback` in the report.

**A change cannot loosen the gate that judges it.** The files that decide a speed row (`GATE_FILES` in
`scripts/ci-parity-base-gate.mjs`: the verdict, its thresholds and overrides, the A/B machinery) are taken from the base commit
before the job measures (`ci.yml`, "Use the gate of the base"), and the job fails when the base's gate does not fit the
change's tree. The family runners, rows, corpus and baseline stay the change's, so a change that adds a family or a row is
measured with it. The change that introduces a gate file is judged by its own; the next one by that file. (The workflow
file of a pull request is the pull request's own, which GitHub runs; that is the limit of what a check inside the
repository can do.)

**What it measures on the CI runner** (nightly dispatch `ab_base_ref` with the commit under test as its own base, run
38032254816, two measurements of 36 speed rows, `bench/ab-noise-samples.json`; `npx tsx bench/replay-speed-reports.ts
--noise-out bench/ab-noise-samples.json <artifact>` regenerates it):

- No false failure: 0 failing rows of 72 (`npx tsx bench/replay-speed-reports.ts <artifact>`), and the bias of the comparison
  is nil: the mean of the log of the head-to-base median over the rows is -0.006 (the earlier design, the head in the
  benchmark's process, gave -0.020 and failed `document/rich-structure.docx->odt` once with a median of 0.664; that is why the
  head runs in its own process and a failure needs a second set of pairs).
- The noise of the comparison (standard deviation of the log of the pair ratios): median 0.044, 90th percentile 0.153, worst
  0.314 (`document/noori.hwp->txt`; the office conversions and `mixed.zst->tar` are the noisy rows).
- Cost: the speed step of the whole benchmark took 19.7 minutes per measurement (about 3 minutes without the base), of which
  the extra pairs are at most 12.
- Detection by simulation with those noises (`npx tsx bench/simulate-speed-gate.ts --noise bench/ab-noise-samples.json`, 100
  trials per row): with the extra pairs, a head 15 percent slower than the base (1.5 times the default threshold) fails
  in at least 95 percent of the trials on 12 of 36 rows, 20 percent slower on 23 rows and 30 percent slower on 30 rows;
  the other rows are the noisy ones, which only a larger slowdown can show; unchanged rows fail 0 percent. A 10 percent
  slowdown is the threshold and is not failed (0 percent), by design.

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
cases `music.wav->opus`, `speech.wav->aac` and `music.wav->flac`; and every case of OCR, office, compression and PDF operations, which
are one case or seconds each. The per-push quality gate uses it; the nightly run measures everything.

**Which families a pull request runs** is decided by `bench/family-map.json`: each path under `src/lib/conversions/`,
`src/lib/workers/` and `src/worker/`, and the two graph files `src/lib/jobs/artifact-helpers.ts` (PDF merge, pdf-ops) and `src/lib/queue/graph/node-executor.ts` (dispatches every node, so every family), maps to a family (`scripts/ci-parity-families.mjs`, which the `changes` job of
`ci.yml` runs). Shared code (the dispatcher, the worker pool, the sandbox) maps to every benchmarked family, and so does what every
conversion runs on: the tool runner `src/lib/security/process-sandbox.ts`, `package.json` and `package-lock.json`, the
Dockerfiles, the seccomp profiles and `.github/actions/ci-setup/` (the SVG sanitizer maps to image). A path in
that scope that no rule covers fails the `changes` job, so a new file cannot escape the gate. A path that maps to a
family with `"bench": null` (cad, font, raw, data, ebook, vector, hdr-image) fails with "add reference-compared
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
`GAP_BACKING_LOG_MARGIN`. A made-up entry fails with `gap-not-backed`; an entry the base already holds is not rechecked. A row
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
