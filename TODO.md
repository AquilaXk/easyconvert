# TODO

One maintainer, one list. Add a line when work is found, delete it when it lands.

## Conversions and quality
- Make Samsung S23 DNG convert to JPG and PNG; it fails with `RawDecodeError: data corrupted`.
- Check the CI build of the RAW library; Nikon Z f NEF and Sigma SD15 X3F are still refused.
- Stop Pixel 6 Pro DNG to PDF running out of memory when two other jobs run.
- Make empty or wrong-format output a typed error: html to txt/md, xlsx to csv/tsv, xlsm to csv, dotx to txt.
- Fix PDF/A-1b veraPDF rule 6.7.3-1 by syncing XMP create and modify dates in `pdfa.ts`.
- Review the PDF-to-text refusals (77 `PdfTextUnmappedError`, 25 `CorruptStreamError`) and convert the wrong ones.
- Read composite fonts without a ToUnicode map through a `cmap` reader; 2.2% of glyphs are still missing.
- Add JPEG XL input through `djxl` (in progress).

## Speed
- Bring `3fr->gif`, `x3f-quattro->gif`, `3fr->avif` and `mos->gif` under a fifth of a conformance part on CI, then record the durations.
- Cut the `arw` GIF time: 16-to-8-bit RGBA conversion (119 ms) and LZW (52 ms).
- Lift `screenshot.png->svg` from 0.85 to 0.90 of the reference on arm64.
- Lift `silesia-xml.xz->tar` from 0.876 to the reference speed.
- Size thread and process counts from cgroup `cpu.max`, not `os.availableParallelism()`.

## Product and API
- Finish WCAG 2.1 AA in a real browser: contrast, target size, focus order, 200% zoom.
- Fix the OpenAPI 422 list, the 429 response and the v1 `code` of the convert routes.
- Split a dependency-free liveness route from the `/api/health` readiness route.
- Set SMTP in production `.env` (Gmail app password) so password reset and email verification go live.

## Operations and security
- Install the Redis backup timer on the host on or after 2026-12-08 (30-day notice of the new privacy text).
- Add alerts on SLO burn, queue age and worker restarts, linked to `docs/operations/alerts.md`.
- Give sandboxed jobs their own PID namespace or a distinct uid; `kill(sibling, 0)` succeeds today.
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
