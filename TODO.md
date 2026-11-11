# TODO

One maintainer, one list. Add a line when work is found, delete it when it lands.

## Conversions and quality
- Drop `scripts/install-libraw-he.sh` and the `librawhe` stage when the distribution's LibRaw (0.23 or later) reads Nikon HE/HE* NEF (entry 195).
- PDF text still leaves out 0.10% of the glyphs of the real-world corpus (61,350 of 60.7M): 68% in Type 3 fonts (pictures, which stay counted, and bitmap fonts whose codes are no text: 58% of them `govdocs1-001494.pdf`), 20% in simple Type 1 fonts (the built-in encodings map 5 of them; `CG.Times` `G<n>` names, MathematicalPi `H<n>` catalogue names that need Adobe's table, private-use extension pieces of Symbol and CMEX10: entry 227), 8% in composite fonts whose subset programs carry no `cmap` or `post` (nothing to read; Poppler prints control codes there, entry 104).
- A 16-bit grey PNG converted to PNG comes out larger than its source (`wm-deep-xray.png` 3.80 MB from 2.72 MB, `wm-deep-dart.png` 1.23 MB from 1.15 MB; the optimiser of entry 232 takes them to 3.42 MB and 1.21 MB, oxipng on the source alone to 2.44 MB and 1.13 MB): find what the 16-bit writer does to grey samples and to the rows the source stored well.
- Offer the lossless PNG optimiser to other PNG outputs (JPG, WebP, TIFF or RAW to PNG) behind an option: the 55-picture corpus shows 3 to 55 percent (entry 232), but a conversion to PNG then costs 0.1 to 1 s more than the reference's.
- Close the noisy-picture JPEG gap (`jxl-noise->jpg` BD-rate PSNR +5.2%; the same pixels from a PNG give the same result) and the high-quality gap (from quality 88 to 96 the photographs are +14.6% PSNR behind the reference): both are mozjpeg table 3, and table 0 with a progressive scan is -3.6% PSNR there (entry 234); the tables need quality rows from 88 to 96 and a speed check on the 4:4:4 scan before the policy of entry 2 changes. jpegli itself (-10% bytes at the benchmark's qualities) fails the speed bar on pictures under 3 MP; it stays on commit `d4c741fc` of `feat/jpegli`.

## Speed
- Bring `3fr->avif` and the GIF rows `3fr`, `x3f-quattro` and `mos` (3.4 s, 4.4 s and 2.0 s end to end on the VM since entry 233, from 10 to 15 s) under a fifth of a conformance part on CI and record the durations.
- Cut the `arw` GIF time further: of 418 ms end to end on the VM (508 ms before entry 229) the palette search (`mapNearest` and the k-d tree) is about 200 ms, the LZW coder 41 ms (46 before), the RGBA read 35 ms on four threads (118 ms before).
- Lift `screenshot.png->svg` from 0.85 to 0.90 of the reference on arm64.
- Lift `silesia-xml.xz->tar` from 0.876 to the reference speed on the x64 runner (1.12 on the arm64 VM, entry 111): start 7-Zip from the launcher helper with the spool opened by its path, so the fork of a large worker (1.8 ms from 116 MB, 6.0 ms from 570 MB) is not paid.
- Lift `jxl->avif` throughput from 0.87 (sandbox start plus the intermediate PNG).

## Product and API

## Operations and security
- Cache the public HTML pages at the Cloudflare edge (a cache rule for the page routes; `cf-cache-status` is `DYNAMIC` on `/ko` today although the page sends `s-maxage`): QA sets it in the dashboard later, or puts a scoped API token in `.env`. Leave `/dashboard`, `/*/dashboard` and `/api/` out of the rule and never override the origin's `private, no-store` with an edge TTL (entry 210).
- Install the Redis backup timer on the host on or after 2026-12-08 (30-day notice of the new privacy text).

## Tests and CI
- Re-pin `book-pg2701.epub` to an archived capture taken after its live file was rebuilt on 2026-11-08, with a gutenberg.org mirror (latest capture 2026-11-01 differs; `book-pg84.epub` done); the pg84 quality rows were not re-measured against the rebuilt bytes (entry 224).

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
- Korean ONNX OCR (entry 230, off by default, 0.33% CER against 8.73% on the 29-page render set): QA decides after the provenance sign-off whether to wire it behind a sandboxed helper process and ship the 18 MB of models; real Korean scans are needed to confirm.
- Rare samples: DWG before R13, WP Greek accented letters, Word Wingdings check boxes.
- sk/sk1 input: QA decision on UniConvertor 2 (GPL, separate process).
- Erasure of an account does not search open multipart sessions of the local store by owner (they expire by their own sweep within the session lifetime).
