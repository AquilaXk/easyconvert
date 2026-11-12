# TODO

One maintainer, one list. Add a line when work is found, delete it when it lands.

## Conversions and quality
- Drop `scripts/install-libraw-he.sh` and the `librawhe` stage when the distribution's LibRaw (0.23 or later) reads Nikon HE/HE* NEF (entry 195).
- PDF text still leaves out 0.10% of the glyphs of the real-world corpus (61,350 of 60.7M): 68% in Type 3 fonts (pictures, which stay counted, and bitmap fonts whose codes are no text: 58% of them `govdocs1-001494.pdf`), 20% in simple Type 1 fonts (the built-in encodings map 5 of them; `CG.Times` `G<n>` names, MathematicalPi `H<n>` catalogue names that need Adobe's table, private-use extension pieces of Symbol and CMEX10: entry 227), 8% in composite fonts whose subset programs carry no `cmap` or `post` (nothing to read; Poppler prints control codes there, entry 104).
- Compress rows run at 0.72 of the reference's speed (0.76 photographs, 0.39 to 0.55 graphics, entry 253): the optimiser is 45 to 116 ms of a conversion of 78 to 250 ms and is more than the whole reference run for a graphic; a faster step for graphics (entry 247's options give up bytes) is the way to 0.90. Copy quantizr's source into `scripts/quantizr-pixels` for a Lloyd step on its palette and a dither like the image library's, to win back the tenth of a decibel that entry 253 gives up on photographs.
- Offer the lossless PNG optimiser to other PNG outputs (JPG, WebP, TIFF or RAW to PNG) behind an option: the 55-picture corpus shows 3 to 55 percent (entry 241), but a conversion to PNG then costs 0.1 to 1 s more than the reference's.
- Close the rest of the JPEG gaps to the reference (entry 250 took the 4:4:4 photographs to its curve with table 0 from quality 90): `jxl-noise->jpg` is still +5.2% PSNR behind from quality 40 to 85 (table 3; table 0 is -0.1% there and the code has no noise detection to switch on), the 16-bit photographs from 88 to 96 are +3% PSNR behind, a progressive scan at 90 and above would save another 3.6% (4.2% with the scan search) but takes 1.1 to 1.7 times the reference's time, and the benchmark has no quality rows from 88 to 96 (the rows share the four points 40 to 85; `tests/image-photo-jpeg-high-quality-parity.test.ts` gates two photographs meanwhile). jpegli itself (-10% bytes at the benchmark's qualities) fails the speed bar on pictures under 3 MP; it stays on commit `d4c741fc` of `feat/jpegli`.

## Speed
- Cut the GIF time of the camera rows further: the palette mapper (`mapNearest`) is 13 to 38 ns a pixel on the VM after the direct colour table, and the run tolerance check is 45 percent of it (half of the 50 to 60 percent of pixels that change their nearest colour read the 32-byte Oklab entry of the colour, a quarter of those keep the previous colour); a split over the pool threads needs each stripe to start with a guess of the previous colour and a short repair at its first pixels, which is not written. The LZW coder (200 to 320 ms for 20 to 39 MP) and the `3fr` development by `dcraw_emu` (0.9 s) are the other large steps.
- Compare `raw-x3f.ts` with the BSD X3F reference credited by LibRaw (Roland Karlsson) and copy its decode loops with attribution where they are faster or decode more cameras.
- `quantize.ts` (401 lines) is on the product path only for the 8-bit BMP (`quantizeNeuQuant`, the Floyd-Steinberg mapper, `encodeBmp8`); decide whether BMP takes its palette from `color-quantizer.ts` and the file goes. That changes the BMP bytes, so it needs an `image` parity run.

## Product and API

## Operations and security
- `conversionQueue.remove(id)` still reads the whole dead-letter list inside its Lua script for each job, so the per-job removal of `scripts/erase-account.ts` (removeEndedJobs) is O(jobs x letters): keep a per-job or per-user index of the letters at `moveToDlq` and remove by it.
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
- Rare samples: DWG before R13, WP Greek accented letters, Word Wingdings check boxes.
- sk/sk1 input: QA decision on UniConvertor 2 (GPL, separate process).
- Delete src/lib/quota (usage ledger and pricing) and tests/usage-metering-ledger.test.ts parts 1 to 3: nothing writes the ledger or prices a job since GET /api/v1/usage was removed (entry 241); conversions are charged one unit each.
- Privacy cookie table (docs/legal/privacy.en.md and privacy.ko.md) names easyconvert_session; production now writes __Host-easyconvert_session (entry 241): name both in the next legal revision, and drop the plain name from SESSION_COOKIE_NAMES 7 days after the first deploy.
- Erasure of an account does not search open multipart sessions of the local store by owner (they expire by their own sweep within the session lifetime).
