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
| `npm run bench:quality -- --family image,audio --runs 3` | A subset of families (`image video audio ocr document compression`) and the number of interleaved timing runs (default 5, at most 25; video, OCR and office use at most 3). |
| `npm run bench:quality -- --no-gate` | Measure and report without gating. |
| `npm run bench:quality -- --inject-regression webp-quality` | Degrade our side on purpose to show the gate fails and names the metric. `webp-quality` lowers the WebP quality setting (a regression against our baseline; it stays on the same rate-distortion curve, so it is not behind the reference at equal size). `webp-reencode` encodes WebP twice (a worse curve, which BD-rate sees). `x264-ultrafast` switches H.264 to the ultrafast preset. `slow-ours` makes every timed run of our side twice as long (a speed regression). |
| `npm run bench:quality -- --compare-report <file>` | Gate an existing report without measuring. |
| `npm run bench:quality -- --parity [--family a,b] [--quick] [--quality-only \| --speed-only]` | The reference-parity gate. Exit 0 pass, 1 regression against the baseline, 2 run failure, 3 a row below the reference. |

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
more pairs are added, up to 25 for light rows and 12 for video, OCR and office. An interval that still straddles 0.97 at
the cap is a failure. The interval of a median is as wide as the noise of a single pair, so a row whose true ratio
sits at the pass line ends UNSTABLE: ours has to be clearly at or above the reference, not merely not behind it.
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
cases `photo-a.jpg->webp`, `photo-b.png->avif` and `lineart.png->webp`; the video cases for H.264 and VP9; the audio
cases `music.wav->opus`, `speech.wav->aac` and `music.wav->flac`; and every case of OCR, office and compression, which
are one case or seconds each. The per-push quality gate uses it; the nightly run measures everything.

**Which families a pull request runs** is decided by `bench/family-map.json`: each path under `src/lib/conversions/`,
`src/lib/workers/` and `src/worker/` maps to a family (`scripts/ci-parity-families.mjs`, which the `changes` job of
`ci.yml` runs). Shared code (the dispatcher, the worker pool, the sandbox) maps to every benchmarked family. A path in
that scope that no rule covers fails the `changes` job, so a new file cannot escape the gate. A path that maps to a
family with `"bench": null` (cad, font, raw, data, ebook, pdf-ops, vector, hdr-image) fails with "add reference-compared
bench rows for <family>" until the same change adds a runner in `bench/families/` and sets the family's `bench` to its
own name.

**Known gaps and the staged rollout.** Most speed rows are below the reference today, so the gate is staged:

- *Quality is immediate.* Every quality row of a touched family must be at or above the reference. `bench/parity-gaps.json`
  never excuses a quality row: an entry only names the issue in the failure message (the image quality rows are tracked
  by #640 and still fail).
- *A speed row that is not listed* has to pass the sign-test rule outright.
- *A speed row that is listed is "tracked".* Being below the reference does not fail it, but it fails when it gets
  slower than its own history predicts (next section). A tracked row that now passes the normal rule is reported as
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
- The row fails only when the **upper end of the new interval** (the sign-test interval of the job's own pairs) is below
  that bound: ours is then slower than the history allows even at the generous end of this job's measurement.
- With fewer than `SPEED_HISTORY_MIN_POINTS` (3) runs there is no bound. The row is reported as `tracked-short-history`
  and does not fail; each nightly adds a point. The bound is wide at three points and tightens as the history fills.
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
regression; anything else is exit 2. It sets the baseline `ratio` of every measured speed row (informational, see "Gate"), adds the median of each tracked
gap's interval to its `history` (four decimals, the latest ten runs kept, ordered by the report's time), and sets the
gap's `ratio` to the latest point rounded down to two decimals (a note it generated is rewritten with it; a note written
by hand stays). Run it once per report: `bench:refresh-speed -- --write <run 1 artifact>`, then `... <run 2 artifact>`. A row whose interval was still undecided at the cap changes nothing. A tracked row that now
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
