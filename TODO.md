# TODO

One maintainer, one list. Add a line when work is found, delete it when it lands.

## Conversions and quality
- Drop `scripts/install-libraw-he.sh` and the `librawhe` stage when the distribution's LibRaw (0.23 or later) reads Nikon HE/HE* NEF (entry 195).
- Hand the developed RAW picture to the encoder from its file, not a 75 MB buffer, to cut the DNG to PDF peak further (entry 191).
- Keep the title and figure labels of a PDF page whose Type 3 glyphs outnumber the mapped ones (`govdocs1-002202.pdf` page 3: Poppler prints them, we leave the whole page out, policy 49).
- PDF text still leaves out 0.10% of the glyphs of the real-world corpus (61,544 of 60.7M): 68% in Type 3 fonts, 20% in simple Type 1 fonts (`CG.Times095`, `MathematicalPi`, `CMEX10`; read their built-in encoding and glyph names), 8% in composite fonts whose subset programs carry no `cmap` or `post` (nothing to read; Poppler prints control codes there, entry 104).
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

## Operations and security
- Cache the public HTML pages at the Cloudflare edge (a cache rule for the page routes; `cf-cache-status` is `DYNAMIC` on `/ko` today although the page sends `s-maxage`): QA sets it in the dashboard later, or puts a scoped API token in `.env`.
- Record the final outputs of a finished graph in the history of converted files (`recordJobResultInHistory` skips graph nodes, so only plain queue jobs and synchronous conversions are listed there today).
- Hide the `/proc` entries of other runs from a sandboxed program: it cannot signal them any more, but still reads their command line and status (no `/proc` mount is allowed in the container).
- Install the Redis backup timer on the host on or after 2026-12-08 (30-day notice of the new privacy text).
- Add alerts on SLO burn, queue age and worker restarts, linked to `docs/operations/alerts.md`.
- Pass the declared `--infilter` for the legacy binary Office formats (`doc`, `xls`, `ppt`, their templates, `wps`, `pdb`): the suite has one filter per generation behind each extension, so a fixed name fails on older files.
- Make the remaining ffprobe runs asynchronous: the audio channel, sample rate and stream count probes of the argument builders (`probeScalar`), the HDR and empty-output probes, and the run that explains a failed probe; they run in the sandbox with limits but hold the event loop.

## Tests and CI
- Make the PDF text and RAW hosts skip a compiled worker in `dist/` that is older than its source, or have vitest use the source: a stale `dist/pdf-text-worker.js` (2026-11-05) made local tests run last week's PDF code in the main checkout on 2026-11-09.
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
