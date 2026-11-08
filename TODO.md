# TODO

One maintainer, one list. Add a line when work is found, delete it when it lands.

## Conversions and quality
- Drop `scripts/install-libraw-he.sh` and the `librawhe` stage when the distribution's LibRaw (0.23 or later) reads Nikon HE/HE* NEF (entry 195).
- Hand the developed RAW picture to the encoder from its file, not a 75 MB buffer, to cut the DNG to PDF peak further (entry 191).
- Review the PDF-to-text refusals (77 `PdfTextUnmappedError`, 25 `CorruptStreamError`) and convert the wrong ones.
- Read composite fonts without a ToUnicode map through a `cmap` reader; 2.2% of glyphs are still missing.
- Close the noisy-picture JPEG gap (`jxl-noise->jpg` BD-rate PSNR +5.2%; the same pixels from a PNG give the same result).

## Speed
- Bring `3fr->gif`, `x3f-quattro->gif`, `3fr->avif` and `mos->gif` under a fifth of a conformance part on CI, then record the durations.
- Cut the `arw` GIF time: 16-to-8-bit RGBA conversion (119 ms) and LZW (52 ms).
- Lift `screenshot.png->svg` from 0.85 to 0.90 of the reference on arm64.
- Lift `silesia-xml.xz->tar` from 0.876 to the reference speed.
- Give the 8-bit PNG writer adaptive filtering: level 6 gives 1,000,922 against 1,523,900 bytes on `jxl-bicycles` in 43 against 29 ms; it affects every PNG output, so measure the speed rows first.
- Lift `jxl->avif` throughput from 0.87 (sandbox start plus the intermediate PNG).
- Size thread and process counts from cgroup `cpu.max`, not `os.availableParallelism()`.

## Product and API
- Finish WCAG 2.1 AA in a real browser: contrast, target size, focus order, 200% zoom.

## Operations and security
- Install the Redis backup timer on the host on or after 2026-12-08 (30-day notice of the new privacy text).
- Add alerts on SLO burn, queue age and worker restarts, linked to `docs/operations/alerts.md`.
- Run the office suite with a fixed profile: macros off, link updates off, `file:` reads restricted.
- Pass the declared `--infilter` for every office input, and strip macros by content, not extension.
- Bound multipart bodies before `req.formData()` in the convert and batch routes.
- Run ffprobe through the process sandbox with rlimits, asynchronously.
- Make the qpdf steps in `compress.ts` honour the job abort signal and deadline.
- Make the PDF guard walk `/Parent` resources, count draws, and cover encrypted PDFs.
- Restore the link-import charge that a failed write loses (up to 4 MiB).
- Fix graph start recovery so queued node jobs are cancelled even when the cancel fails.
- Key loopback rate limits by something callers cannot write; `X-Forwarded-For` rotates today.
- Pin `actions/checkout` by SHA in three workflows.
- Fix Dependabot alert #57 (moderate).

## Tests and CI
- Stabilise the `lzma-decoder` timing and `ocr-pdf-concurrency` guards; both fail every nightly.
- Fix the flakes `job-input-deletion` and `upload-completion-receipt`.
- Split the parity quality job by family; RAW hits the 60-minute cap from a cold cache.
- Move the worker image layer cache to the registry; the Actions cache is over 10 GB.
- Type-check the test files; about 100 `tsc` errors exist under `tests/`.

## Later
- Korean-first CPU neural OCR engine; switch the default only where it wins.
- Engine choice and version pinning per conversion.
- Named task graphs in one API job.
- Thumbnail, metadata and website capture (website capture needs an SSRF suite).
- Customer storage and SFTP import and export; presets and watched sources after that.
- SDKs generated from OpenAPI with a drift check.
- Split `office.ts` (10,339 lines) and `buildFfmpegArguments`; merge the 15 `escapeXml`/`escapeHtml` copies.
- Evaluation-size sample sets: 30+ video, 30+ RAW from 10 makers, 40+ audio, 60+ PDF stress files.

## Waiting
- Paid plans and a payment provider: QA decision; launch is free only.
- Learned OCR layout tier: legal sign-off on model and data provenance first.
- Rare samples: DWG before R13, WP Greek accented letters, Word Wingdings check boxes.
- sk/sk1 input: QA decision on UniConvertor 2 (GPL, separate process).
