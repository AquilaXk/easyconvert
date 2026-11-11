# TODO

One maintainer, one list. Add a line when work is found, delete it when it lands.

## Conversions and quality
- Drop `scripts/install-libraw-he.sh` and the `librawhe` stage when the distribution's LibRaw (0.23 or later) reads Nikon HE/HE* NEF (entry 195).
- PDF text still leaves out 0.10% of the glyphs of the real-world corpus (61,350 of 60.7M): 68% in Type 3 fonts (pictures, which stay counted, and bitmap fonts whose codes are no text: 58% of them `govdocs1-001494.pdf`), 20% in simple Type 1 fonts (the built-in encodings map 5 of them; `CG.Times` `G<n>` names, MathematicalPi `H<n>` catalogue names that need Adobe's table, private-use extension pieces of Symbol and CMEX10: entry 227), 8% in composite fonts whose subset programs carry no `cmap` or `post` (nothing to read; Poppler prints control codes there, entry 104).
- Close the noisy-picture JPEG gap (`jxl-noise->jpg` BD-rate PSNR +5.2%; the same pixels from a PNG give the same result).

## Speed
- Bring `3fr->gif`, `x3f-quattro->gif`, `3fr->avif` and `mos->gif` under a fifth of a conformance part on CI, then record the durations.
- Cut the `arw` GIF time: 16-to-8-bit RGBA conversion (119 ms) and LZW (52 ms).
- Lift `screenshot.png->svg` from 0.85 to 0.90 of the reference on arm64.
- Lift `silesia-xml.xz->tar` from 0.876 to the reference speed on the x64 runner (1.12 on the arm64 VM, entry 111): start 7-Zip from the launcher helper with the spool opened by its path, so the fork of a large worker (1.8 ms from 116 MB, 6.0 ms from 570 MB) is not paid.
- Lift `jxl->avif` throughput from 0.87 (sandbox start plus the intermediate PNG).

## Product and API

## Operations and security
- Cache the public HTML pages at the Cloudflare edge (a cache rule for the page routes; `cf-cache-status` is `DYNAMIC` on `/ko` today although the page sends `s-maxage`): QA sets it in the dashboard later, or puts a scoped API token in `.env`. Leave `/dashboard`, `/*/dashboard` and `/api/` out of the rule and never override the origin's `private, no-store` with an edge TTL (entry 210).
- Install the Redis backup timer on the host on or after 2026-12-08 (30-day notice of the new privacy text).

## Tests and CI
- Make the stale-worker check of the PDF text, RAW, CPU and image-fetch hosts compare the compiled worker with every source file it bundles, not only its entry file: on 2026-11-11 a dist/pdf-text-worker.js older than a changed import ran in local tests (`olderThanSource`).
- Re-pin `book-pg84.epub` and `book-pg2701.epub` to a fresh archived capture with a matching gutenberg.org mirror: their live files were rebuilt, so they have no mirror and depend on web.archive.org and the CI cache (entry 224).

## Later
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
