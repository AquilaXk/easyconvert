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
- Dashboard: render the first view on the server (2.3 s spinner today); the key form's terms checkbox stays (policy 146), drop it only with a policy change.
- Tool pages the references have and our API already supports: archive create/extract, PNG/JPG compress, PDF split/rotate, PDF/A.
- Finish WCAG 2.1 AA in a real browser: contrast, target size, focus order, 200% zoom.

## Operations and security
- Keep the history of converted files (`recordUserFile`, `listUserFiles`, `deleteUserFile`) in Redis, the store the other account data uses, and record a queue job's result when it completes: today only the synchronous `/api/v1/convert` writes it, in one process's memory and `user-files.json`, so a worker's results are not listed and a delete is exact only in the process that holds the record (`forgetUsage` and `scripts/erase-account.ts` must cover the Redis copy).
- List a user's graphs in `GET /api/queue/jobs` and `GET /api/v1/jobs`: the node jobs are hidden now (the graph is the job), but graph state has no per-user index, so a graph is read only by its id.
- Seed the rotation store with the API key's current webhook secret when `POST /api/v1/webhooks/secrets/rotate` rotates a key that has no record yet, so the first rotation keeps the old secret as the previous one for the grace period (today only the second rotation does).
- Turn the PID namespace back on (`SANDBOX_PID_NAMESPACE`, off since 2026-11-08): on CI an aborted run left its program running inside the namespace (lbzip2, libdeflate, avifenc, OCR stand-ins), and calibre failed with "Failed to read exe path". Reproduce in the CI container profile, not only the VM.
- Close the window in which pid-init's PID 1 is started after its parent died (PDEATHSIG is set after the fork, and the parent's death is not seen until the pipe is polled): rare, needs a poll of the report pipe.
- Hide the `/proc` entries of other runs from a sandboxed program: it cannot signal them any more, but still reads their command line and status (no `/proc` mount is allowed in the container).
- Install the Redis backup timer on the host on or after 2026-12-08 (30-day notice of the new privacy text).
- Add alerts on SLO burn, queue age and worker restarts, linked to `docs/operations/alerts.md`.
- Pass the declared `--infilter` for the legacy binary Office formats (`doc`, `xls`, `ppt`, their templates, `wps`, `pdb`): the suite has one filter per generation behind each extension, so a fixed name fails on older files.
- Make the remaining ffprobe runs asynchronous: the audio channel, sample rate and stream count probes of the argument builders (`probeScalar`), the HDR and empty-output probes, and the run that explains a failed probe; they run in the sandbox with limits but hold the event loop.
- Make the PDF guard walk `/Parent` resources, count draws, and cover encrypted PDFs.
- Fix graph start recovery so queued node jobs are cancelled even when the cancel fails.

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
