# TODO

One maintainer, one list. Add a line when work is found, delete it when it lands.

## Launch gates and dated tasks
- Install the Redis backup timer on the host (`deploy/oci/easyconvert-redis-backup.timer`) on or after 2026-12-08 (30-day notice of the new privacy text), and optionally enable `REDIS_BACKUP_OFFHOST_ENABLED=true` once the privacy storage location notice covers the off-host S3/OCI bucket (entry 326).
- Before Paddle billing goes on (entries 262 and 285): run one sandbox purchase of a package and one of a subscription end to end (account, the thirteen `PADDLE_` variables with the nine price ids, notification destination to `/api/billing/webhook` for subscription, transaction and adjustment events, CSP if one is added for `cdn.paddle.com` and checkout frames), then a refund of the package; check the webhook edge bucket (entry 277), whether an adjustment can arrive before its payment, whether the clock log stays silent, what the first hourly `[billing] reconcile` run reports against the sandbox lists, what `transaction.completed` carries in `details.totals.total` and `custom_data`, where `currentPeriodEnd` sits after a renewal and `subscriptions.update` of a switch (entry 285), and that `[billing] portal session failed` logs no authorization header or key.
- Turn billing on (the thirteen `PADDLE_` variables) on or after 2026-12-13, when the terms published on 2026-11-13 take effect; until then the pricing page shows the package and the subscription as coming soon.

## Conversions and quality
- Drop `scripts/install-libraw-he.sh` and the `librawhe` stage when the distribution's LibRaw (0.23 or later) reads Nikon HE/HE* NEF (entry 195).
- PDF text still leaves out ~0.09% of the glyphs of the real-world corpus (entry 259, and corporate PUA `U+F600..U+F8FF` + `braceex` in entry 315): 71% in Type 3 fonts (pictures and bitmap fonts, 58% of them `govdocs1-001494.pdf`), 12% `CG.Times` simple Type 1 `G<n>` glyph numbers, 5% MathematicalPi/Universal-GreekwithMathPi `H<n>` Adobe catalogue numbers, and most of the rest in subset composite fonts with no `cmap` or `post` (entry 104).
- Compress PNG rows run at 1.20 (photographs) to 2.47 of the reference's speed since entry 276 (and Heckbert `PaletteInverseCmap` + lazy `32x32x32` `KdTree3` grid in entry 315), at 19.1% below its bytes and 1.1% above oxipng's; evaluate oxipng `-o1 -f 6 --zc 12` (0.6% byte gain) if `wm-deep-dart.png` and `clic-schicka-307.png` move above 0.9.
- Close the remaining JPEG gaps to the reference (entries 250 and 266): progressive scans at quality >= 90 save 3.6% (4.2% with scan search) at 0.64 to 1.00 of the reference's speed; add benchmark quality rows across 88 to 96 (`tests/image-photo-jpeg-high-quality-parity.test.ts` gates two photographs meanwhile); extend noise estimation beyond PNG sources without paying 3.8 ms of decode on `photo-a.jpg`; decide table 2 vs table 3 below quality 90 (+1.3 dB PSNR and +2.5 SSIMULACRA 2 BD-rate vs -1.0 SSIM and +3.7% bytes across 13 pictures); keep `jpegli` (-10% bytes, too slow under 3 MP) on commit `d4c741fc` of `feat/jpegli` until speed matches.
- Carry the remaining PDF vector features left after entries 289 and 315 into slides and Word documents: clipping paths, gradients and patterns, soft masks and shadows, diagram labels inside shapes, shapes in running headers/footers, per-page backgrounds in Word, and false table grids over magazine photo columns.
- Review the 82 withdrawn pairs against the reference (`tests/parity-audit.test.ts`, besides the 37 to `rar`, after entries 309 and 310): SNB books (9 pairs; calibre 8.5.0 reads no SNB, fixed upstream in 9.10), targets EMF and WMF (28, entries 42 and 99), XPS (8), SWF (7), and GIF/WebP to audio (14, no audio stream).
- List the licences of the Haskell libraries linked into the static pandoc binary alongside `/licenses/pandoc.COPYRIGHT` (as `scripts/oxipng-notices` does for Rust crates), and offer `input_markdown_syntax` if wanted (entry 310).
- Cut long scanned-PDF OCR wall time and bordered-table CER (entries 291, 292 and 300): revisit the 0.9 second-reading trigger with the 35 px enlargement target (entry 33) and page-count-scaled stage/judge limits (`gd-074905.pdf` 234 s, `gd-217600.pdf` 113 s idle / 193 s busy, `cc-7600350.pdf` 100 s); build a transcribed bordered-table corpus and trigger for pages Tesseract scores 0.94 to 0.96 while losing 19 to 98% of text; revisit the `(3 + pages)` document budget on PDFs under 15 pages.
- Install `epubcheck` in the Linux VM so `ORACLE_STRICT_MODE=1 npm run bench:quality -- --parity --family document` does not stop at `rich-structure.docx->html` with `MissingToolError`.

- Close the gaps the 2026-11-20 comparison with self-hosted open-source converters found (results in the session scratch `compare/tables.md`): PDF to DOCX keeps too few pages (10-page PDF gives 6 pages, page SSIM 0.68 vs 0.87); HTML to PDF waits ~30 s on unreachable external hosts; MP3 from low-rate sources is written at ~160 kbps (16 kHz mono); small MP4 to WebM grows 1.33x; PDF compress leaves small files at 0.99; skewed Korean scans lose reading order; LibreOffice is 25.2 (others ship 26.x).
- PDF to DOCX: wire the pdf2docx layout translation kept on branch `feat/pdf-docx-pdf2docx` (MIT, matched the Python on 34 files) once the writer can set a paragraph beside a table or the reader gives per-glyph advances (entry 362); remaining gaps are wrap drift on justified text (000353, 000572) and extra pages (000018, 000572, 000618, 001135).
- Fix the remaining live-sweep refusals of 2026-11-20: SVG `<text>` to EMF/WMF/CGM, CB7/CBT to PDF, SHW to PDF, CHM to EPUB (calibre `lstrip` on None), HTML with a CSS backslash escape to PDF, ICNS without PNG/JPEG members, HWP 3.0, TOML with an empty key to XML, PSB headers, RAR method 0x33 in the extract tool, and RM/WTV same-format output quality.

- Write the words of a tilted line as wide as the words without `ocrDeskew` too (`placeWords` `exactBoxes`, entry 371): the box of such a word is wider by the line height times sin(2 x tilt), so the highlight is a few points too wide at 3 degrees and more at 10.

## Speed
- Investigate `pdf-ops` speed parity on `pdf-gov-000142.pdf` on the Linux arm64 VM (protect 0.80 to 0.82, delete 0.905 to 0.91, extract/reorder/rotate 0.91 to 0.93 after entry 292 brought split to 0.95 to 0.96; zero-copy `pdf-text-worker` transfer landed in entry 315, and the Ubuntu 24.04 arm64 `native/qpdf-runner` 105/105 decline was resolved in entry 322): decide whether `--compression-level=1` (-0.6 ms of 7.3 ms for +0.3% bytes) is wanted.
- Cut camera-RAW-to-GIF time further (`3fr` 1.88 s, `mos` 1.23 s, `arw` 337 ms after entries 279, 313 and 315): split the palette histogram/median-cut/k-means step across pool threads, decide whether multi-segment parallel LZW (~200 ms saved on `3fr`, <0.01% byte change) is acceptable, and profile `dcraw_emu` on `3fr` (0.9 s).

## Operations and security
- Turn on `UNVERIFIED_ACCOUNT_PURGE_ENABLED` on or after 2026-12-20 (30 days after the privacy text naming it was published), first with `UNVERIFIED_ACCOUNT_PURGE_DRY_RUN=true` (the default) for one pass, check the counts in the worker log, then set it to `false` (entry 364).
- Cap how many storage credentials one account keeps (launch audit of 2026-11-20; entry 343 bounds each record).
- Add browser error reporting for crashes in the converter UI.
- Confirm the Paddle checkout script under the nonce policy (entry 370) in the first sandbox purchase.
- Pick a free package name before publishing the SDKs (PyPI `easyconvert` belongs to another project; npm `@easyconvert/sdk` is unpublished) and add install lines to their READMEs.
- Watch `auth_mail_budget level=warn` (350 mails/day; verification stops at 400, resets at 480, entry 288) and move auth mail to a dedicated provider before sign-ups reach the cap, raising `AUTH_MAIL_DAILY_WARN`, `AUTH_MAIL_DAILY_VERIFY_CAP` and `AUTH_MAIL_DAILY_HARD_CAP` via `.env` (entry 326).

## Tests, CI and code health
- Re-measure the `book-pg84.epub` quality rows against its rebuilt bytes (entry 224; `book-pg2701.epub` re-pinned in entry 328).
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
- `pages` for PDF to TXT, DOCX, HTML and XLSX: the reference offers it for each of the four pairs and the converter ignores it; select the pages inside the readers, since a qpdf pre-selection would apply the edit-rights check of entry 4 (`confirmEditRights`) to a conversion that only reads the PDF.
- Animated GIF of 256 colours still takes the image library's local palettes (up to 281 colours composed on a photographic pan): entry 368 writes every count below 256 from a raster that `quantizr-pixels` reduced, with the library's frame differencing, so the same route at 255 colours (+0.1 to +1.2 dB on pans and +14 dB on a screen scroll at 256 in entry 366) needs only a decision on the one colour that an opaque differenced frame gives up.
- 8-bit ICO (`oklabPaletteRaster`) still takes its palette from the Oklab quantiser; measure it against `quantizr-pixels` the way entry 366 did for GIF and BMP.
- GIF of a photograph: `quantizr-pixels` ties the Oklab route on SSIM and CIEDE2000 at 256 colours and takes 1.3 to 2 times the time above 1.3 MP because it runs on one thread: thread the program's remap and port the run tolerance to it, then measure again (entry 366).
