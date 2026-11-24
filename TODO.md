# TODO

One maintainer, one list. Add a line when work is found, delete it when it lands.

## Launch gates and dated tasks
- Install the Redis backup timer on the host (`deploy/oci/easyconvert-redis-backup.timer`) on or after 2026-12-08 (30-day notice of the new privacy text), and optionally enable `REDIS_BACKUP_OFFHOST_ENABLED=true` once the privacy storage location notice covers the off-host S3/OCI bucket (entry 326).
- Before Paddle billing goes on (entries 262 and 285): run one sandbox purchase of a package and one of a subscription end to end (account, the thirteen `PADDLE_` variables with the nine price ids, notification destination to `/api/billing/webhook` for subscription, transaction and adjustment events, CSP if one is added for `cdn.paddle.com` and checkout frames), then a refund of the package; check the webhook edge bucket (entry 277), whether an adjustment can arrive before its payment, whether the clock log stays silent, what the first hourly `[billing] reconcile` run reports against the sandbox lists, what `transaction.completed` carries in `details.totals.total` and `custom_data`, where `currentPeriodEnd` sits after a renewal and `subscriptions.update` of a switch (entry 285), and that `[billing] portal session failed` logs no authorization header or key.
- Turn billing on (the thirteen `PADDLE_` variables) on or after 2026-12-13, when the terms published on 2026-11-13 take effect; until then the pricing page shows the package and the subscription as coming soon.

## Conversions and quality
- Drop `scripts/install-libraw-he.sh` and the `librawhe` stage when the distribution's LibRaw (0.23 or later) reads Nikon HE/HE* NEF (entry 195).
- PDF text still leaves out 0.077% of the glyphs of the real-world corpus (entries 379, 397 and 402, 44,439 of 57.9M): 92% in Type 3 fonts (bitmap fonts whose glyphs are named `a<n>` and `i<n>`, 55% in `govdocs1-001494.pdf` alone; the table leaders `leaderdot` and `thindash`), and the rest in subset composite fonts with no `cmap` or `post` (entry 104), the 7 standalone positioned math accents of `OpenSymbol` (`govdocs1-002166.pdf`), `Wingdings` and `cmex`, the `C<n>` names of `AdvP4C4E` and 61 glyphs of the pi fonts that the table lacks (`H33527`, `H20848`, `H11509`).
- Compress PNG rows run at 1.20 (photographs) to 2.47 of the reference's speed since entry 276 (and Heckbert `PaletteInverseCmap` + lazy `32x32x32` `KdTree3` grid in entry 315), at 19.1% below its bytes and 1.1% above oxipng's; evaluate oxipng `-o1 -f 6 --zc 12` (0.6% byte gain) if `wm-deep-dart.png` and `clic-schicka-307.png` move above 0.9.
- Close the remaining JPEG gaps to the reference (entries 250, 266 and 378): a progressive scan at quality >= 90 saves 4.3% (BD-rate in PSNR, 36 photographs) at 0.73 to 0.91 of the reference's speed from 0.28 MP up (92, VM), so only a cheaper scan script can fit: the 5-scan script of entry 378 (an engine patch of the worker's mozjpeg build, not built yet) costs 1.4 to 1.65 times the baseline encode against 1.7 to 2.1 times for the 10-scan script, and overshoot deringing off from 90 gives 7 to 11% of the time back at no change in quality; extend noise estimation beyond PNG sources without paying 3.8 ms of decode on `photo-a.jpg`; keep `jpegli` (-10% bytes, too slow under 3 MP) on commit `d4c741fc` of `feat/jpegli` until speed matches.
- Carry the remaining PDF vector features left after entries 289 and 315 into slides and Word documents: clipping paths, gradients and patterns, soft masks and shadows, diagram labels inside shapes, shapes in running headers/footers, per-page backgrounds in Word, and false table grids over magazine photo columns.
- Review the 82 withdrawn pairs against the reference (`tests/parity-audit.test.ts`, besides the 37 to `rar`, after entries 309 and 310): SNB books (9 pairs; calibre 8.5.0 reads no SNB, fixed upstream in 9.10), targets EMF and WMF (28, entries 42 and 99), XPS (8), SWF (7), and GIF/WebP to audio (14, no audio stream).
- Add a corpus of real bordered tables with human transcriptions (entry 394 measured the cell rule on 16 drawn tables and three real scans only).
- Run the test shards and the pull request parity job on LibreOffice 26.8 too (entry 386 covers the nightly rows only): they install the runner's 24.2, and the 169 test files that use the suite meet 26.8 only in the container job's one text file.
- PDF to DOCX extra pages left after entries 390 and 405: `govdocs1-000341` (`7` for `6`, unequal columns beside floating tables) and remaining multi-page spills (`govdocs1-000163`, `000166`, `001383`, `004507`); the pdf2docx translation on branch `feat/pdf-docx-pdf2docx` stays unwired (entry 390), to look at again when the writer sets a paragraph beside a table or the reader gives glyph advances.
- Create encrypted 7-Zip archives asynchronously after path normalisation with 0700 staging permissions so worker heartbeats never stall.
- Disable the global libvips operation cache (sharp.cache(false)) in pinBaseImageThreads for one-shot conversions.
- Preserve quotes in stripDoctype and skip CDATA/comments in stripElement in svg-sanitizer.ts, and call sanitizeSvgDocument in text-pdf-route.ts.
- Cap browser OffscreenCanvas pixel area in canvas-header-guard.ts, close ImageBitmap in finally blocks across L0/L1A/L2, escalate >1 MiB PNG tail metadata, and stream bundle downloads.
- Write ZIP64 local file header extra fields for >= 4 GiB entries and reject > 65,535-byte entry names in streaming-zip.ts.
- Bound OpenCascade STEP/IGES assembly face/triangle expansion, pass outputUnit on STL/OBJ to IGES/STEP, and tighten OBJ/STL/STEP/CGM bounds.
- Bound or make iterative the PDFDict/PDFArray traversal in pdf-merge-object-copier.ts so deep object trees cannot overflow the call stack.

## Operations and security
- Revoke the GitHub token that the production host's `ubuntu` user had stored for ghcr.io (removed from `~/.docker/config.json` on 2026-11-22; the deploy runner logs in per job since entry 389), if it is a long-lived personal token.
- Before each deploy, check the LibreOffice version in trixie-backports and the LibreOffice security advisories, and raise the three pins of `Dockerfile.worker` together (entry 383: no `trixie-security` stream; backports keeps one version, so a newer 26.8.x stops the image build; the nightly `libreoffice-backports` job checks `amd64` and `arm64`, entry 396).
- Turn on `UNVERIFIED_ACCOUNT_PURGE_ENABLED` on or after 2026-12-20 (30 days after the privacy text naming it was published), first with `UNVERIFIED_ACCOUNT_PURGE_DRY_RUN=true` (the default) for one pass, check the counts in the worker log, then set it to `false` (entry 364).
- Confirm the Paddle checkout script under the nonce policy (entry 370) in the first sandbox purchase.
- Pick a free package name before publishing the SDKs (PyPI `easyconvert` belongs to another project; npm `@easyconvert/sdk` is unpublished) and add install lines to their READMEs.
- Watch `auth_mail_budget level=warn` (350 mails/day; verification stops at 400, resets at 480, entry 288) and move auth mail to a dedicated provider before sign-ups reach the cap, raising `AUTH_MAIL_DAILY_WARN`, `AUTH_MAIL_DAILY_VERIFY_CAP` and `AUTH_MAIL_DAILY_HARD_CAP` via `.env` (entry 326).
- Validate field types, required inputs, format pairs and options before reserving quota in POST /api/queue/jobs, and call stored.release() on errors.
- Allow capability-owned upload keys in POST /api/v1/archives/inspect, release downloaded temp objects, and dispatch inspections to workers in queue-only mode.
- Make tool job status transitions atomic against cancellation, wrap POST /api/tools/jobs in withinSingleRequest, return 404 on foreign /api/v1/jobs/[id], and harden /api/storage/bundle.
- Isolate LibreOffice OSL_PIPE sockets inside the job directory and narrow ocr-onnx-helper.ts readDirs from process.cwd() to its bundle and node_modules.
- Switch queue Lua scripts to EVALSHA, round-robin popNextEligibleJob across queues, poll targetQueue directly in waitForQueuedJobResult, and drop duplicate progress writes.
- Enforce active API key cap atomically in Lua on POST /api/keys and cap initial presigned part URLs in POST /api/v1/uploads/direct.
- Stream TUS remote multipart part flushes from file descriptors in 8 MiB slices and persist part progress incrementally.
- Fix Azure 0-byte SharedKey signing, map GCS/Azure/WebDAV 429 and 5xx responses to retryable StorageServiceError, and encode WebDAV basePath segments.

## Tests, CI and code health
- Report real LCOV coverage to SonarCloud from the CI shards, then drop `sonar.coverage.exclusions` in `.sonarcloud.properties` and switch to a CI scanner step.

## Approved backlog (QA 2026-11-12: every Later and Waiting item is approved)
- Engine choice, second step (entry 267): install a second engine version when a pair needs it, expose `default` and `latest` flags in `GET /api/formats`, show per-node engine and version in the graph view, and probe engine versions at worker startup.
- Turn website capture on (`CAPTURE_WEBSITE_ENABLED`, entry 270) once Chromium runs inside a relay-only network namespace with user-namespace/file confinement and is verified against Debian 13 Qt 6.8, then link its slugs in `TOOL_ROUTES`.
- Presets and watched sources.
- Additional UI locales beyond `en` and `ko`, and dedicated PDF sign and content-redaction engines.
- Evaluation-size sample sets: 30+ video, 30+ RAW from 10 makers, 40+ audio, 60+ PDF stress files.
- Learned OCR layout tier: pick a permissively licensed layout model and record its model and data provenance.
- Rare samples: DWG before R13, WP Greek accented letters, Word Wingdings check boxes.
- `sk`/`sk1` input through UniConvertor 2 as a separate sandboxed GPL program (behaviour only, no code copied).
- Run the first event credit campaign on or after 2026-12-13 (terms version naming event credits takes effect).
