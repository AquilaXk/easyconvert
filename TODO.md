# TODO

One maintainer, one list. Add a line when work is found, delete it when it lands.

## Conversions and quality
- Drop `scripts/install-libraw-he.sh` and the `librawhe` stage when the distribution's LibRaw (0.23 or later) reads Nikon HE/HE* NEF (entry 195).
- PDF text still leaves out 0.097% of the glyphs of the real-world corpus (59,106 of 60.7M; entry 259 took 2,244 off the 61,350): 71% in Type 3 fonts (pictures, which stay counted, and bitmap fonts whose codes are no text: 58% of them `govdocs1-001494.pdf`), 12% `CG.Times` simple Type 1 fonts whose `G<n>` names are glyph numbers (pdf.js and Poppler have no table; the codes are shifted letters), 5% MathematicalPi, Universal-GreekwithMathPi and kin whose `H<n>` names are Adobe catalogue numbers (pdf.js has no table; a table of Adobe's would be needed), and most of the rest in composite fonts whose subset programs carry no `cmap` or `post` (nothing to read; Poppler prints control codes there, entry 104). Open, small: `braceex` (U+F8F4, 278 glyphs of cmex10 and Symbol in 11 files) is the one private-use piece pdf.js's table lacks; `symbol-font-map.ts` maps code 0xEF of Symbol to U+23AA, so one entry would read it.
- Compress rows run at 1.20 of the reference's speed since entry 258 (photographs 1.19, graphics 1.28 to 1.49), at 15.7 percent below its bytes; `scan.png` (0.51) and `wm-deep-dart.png` (0.72) stay under 0.9, and four files end 1 to 10 percent above its size (`screenshot.png` +9.8). A deflater that runs libdeflate level 11 or 12 on several threads would win back the 5.2 percent that the optimiser took (a program of ours that splits the rows and joins the blocks). Copy quantizr's source into `scripts/quantizr-pixels` for a Lloyd step on its palette and a dither like the image library's, to win back the tenth of a decibel that entry 253 gives up on photographs.
- Offer the lossless PNG optimiser to other PNG outputs (JPG, WebP, TIFF or RAW to PNG) behind an option: the 55-picture corpus shows 3 to 55 percent (entry 241), but a conversion to PNG then costs 0.1 to 1 s more than the reference's.
- Close the rest of the JPEG gaps to the reference (entry 250 took the 4:4:4 photographs to its curve with table 0 from quality 90): `jxl-noise->jpg` is still +5.2% PSNR behind from quality 40 to 85 (table 3; table 0 is -0.1% there and the code has no noise detection to switch on), the 16-bit photographs from 88 to 96 are +3% PSNR behind, a progressive scan at 90 and above would save another 3.6% (4.2% with the scan search) but takes 1.1 to 1.7 times the reference's time, and the benchmark has no quality rows from 88 to 96 (the rows share the four points 40 to 85; `tests/image-photo-jpeg-high-quality-parity.test.ts` gates two photographs meanwhile). jpegli itself (-10% bytes at the benchmark's qualities) fails the speed bar on pictures under 3 MP; it stays on commit `d4c741fc` of `feat/jpegli`.

## Speed
- Cut the GIF time of the camera rows further: the palette mapper (`mapNearest`) is 13 to 38 ns a pixel on the VM after the direct colour table, and the run tolerance check is 45 percent of it (half of the 50 to 60 percent of pixels that change their nearest colour read the 32-byte Oklab entry of the colour, a quarter of those keep the previous colour); a split over the pool threads needs each stripe to start with a guess of the previous colour and a short repair at its first pixels, which is not written. The LZW coder (200 to 320 ms for 20 to 39 MP) and the `3fr` development by `dcraw_emu` (0.9 s) are the other large steps.

## Product and API
- Before Paddle billing goes on (entry 262): add Paddle as a processor of billing data to `docs/legal/privacy.en.md`, `privacy.ko.md` and the DPA with the next legal revision (30-day notice, as for the cookie table below), run one sandbox purchase end to end (account, six `PADDLE_` variables, notification destination to `/api/billing/webhook`, CSP if one is added for cdn.paddle.com and checkout frames), and make `PAID_PLANS_ON_SALE` follow `isBillingConfigured()` so the 413 text and the FAQ name the paid plans.

## Operations and security
- Reconcile subscriptions against Paddle (entry 262): a lost cancel or past-due event leaves a paid tier until `tierUntil` or forever, and a first subscription event with no valid binding is `unattributed` and answered 200, so Paddle never retries it; add a job that lists subscriptions through the API and compares them with the store, and an alert on `unattributed` and `unknown_user` log lines.
- Consider exempting `/api/billing/webhook` from the edge IP rate limit in `src/middleware.ts` (a burst from Paddle's addresses answers 429, which Paddle retries) once the sandbox shows the real delivery pattern, and check the server clock against the 5 second signature window (a skewed clock rejects every event with 400).
- Check once in the Paddle sandbox that the portal-session error log (`[billing] portal session failed`) carries no authorization header or key.
- Bound the `{q}:dlq:unparsed` set of entry 257: a file name with a lone surrogate puts a letter there, and every erasure and every `remove(id)` reads and parses the whole set (age trimming is the only bound today); cap it, or keep its members by job and user as the other index sets do.
- Run `node dist/backfill-dlq-index.js` (dry run, then `--apply`) on the host after the deploy that carries entry 257 has replaced every worker, with QA's approval; until then removal of a job's dead letters reads the whole list as before (docs/deploy-oci.md, "Indexing the dead letters").
- Removing a dead letter is an `LREM`, which scans the list in Redis: 1,000 jobs over 50,000 letters take 2.3 s (entry 257). Keep the letters in a hash by id, with a sorted set for the order, when the list passes about 50,000, and extend the backfill script to move the old list.
- Cache the public HTML pages at the Cloudflare edge (a cache rule for the page routes; `cf-cache-status` is `DYNAMIC` on `/ko` today although the page sends `s-maxage`): QA sets it in the dashboard later, or puts a scoped API token in `.env`. Leave `/dashboard`, `/*/dashboard` and `/api/` out of the rule and never override the origin's `private, no-store` with an edge TTL (entry 210).
- Install the Redis backup timer on the host on or after 2026-12-08 (30-day notice of the new privacy text).

## Tests and CI
- Re-pin `book-pg2701.epub` to an archived capture taken after its live file was rebuilt on 2026-11-08, with a gutenberg.org mirror (latest capture 2026-11-01 differs; `book-pg84.epub` done); the pg84 quality rows were not re-measured against the rebuilt bytes (entry 224).

## Approved backlog (QA 2026-11-12: every Later and Waiting item is approved)
- Engine choice and version pinning per conversion.
- Named task graphs in one API job.
- Thumbnail, metadata and website capture (website capture needs an SSRF suite).
- Customer storage and SFTP import and export; presets and watched sources after that.
- SDKs generated from OpenAPI with a drift check.
- Split `office.ts` (10,339 lines) and `buildFfmpegArguments`; merge the 15 `escapeXml`/`escapeHtml` copies.
- Evaluation-size sample sets: 30+ video, 30+ RAW from 10 makers, 40+ audio, 60+ PDF stress files.
- Learned OCR layout tier: pick a permissively licensed layout model and record its model and data provenance with the change.
- Rare samples: DWG before R13, WP Greek accented letters, Word Wingdings check boxes.
- sk/sk1 input through UniConvertor 2, run as a separate sandboxed GPL program (behaviour only, no code copied).
- Privacy cookie table (docs/legal/privacy.en.md and privacy.ko.md) names easyconvert_session; production now writes __Host-easyconvert_session (entry 241): name both in the next legal revision, and drop the plain name from SESSION_COOKIE_NAMES 7 days after the first deploy.
- Erasure of an account does not search open multipart sessions of the local store by owner (they expire by their own sweep within the session lifetime).
- Report real LCOV coverage to SonarCloud from the CI shards (then drop sonar.coverage.exclusions in .sonarcloud.properties and switch to a CI scanner step)
