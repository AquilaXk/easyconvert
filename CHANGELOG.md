# Changelog

All notable changes to EasyConvert are recorded here. The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and the versions follow [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html) as set out in entry 122 of `docs/policy-decisions.md`: one version per production deploy, beta releases are `0.y.z`, and `1.0.0` comes when every conversion feature and the frontend are complete. Each deploy moves the `Unreleased` entries under its version and date.

## [Unreleased]

The contents of the first production deploy (`v0.1.0`, a pre-release), summarised by area from the merged pull requests since the repository began.

### Added

- Conversion between 302 formats in 12 categories: images, documents, structured data, spreadsheets, presentations, archives, audio, video, e-books, fonts, CAD and vector graphics.
- PDF tools: text and layout extraction, watermark, protect, merge, unlock, compress, page operations and PDF/A, and tables written as the sheets of an XLSX or XLS workbook.
- OCR with hOCR and ALTO output, CJK and vertical text, deskew and multi-page documents.
- E-book writers for MOBI, AZW3, PDB, LRF and OEB, a RocketBook reader, XPS, DWG, Visio, CorelDRAW and Type 1 font sources, and STEP and IGES writers.
- A public API with a single contract, job graphs with fan-out and fan-in, task chaining, cancellation, idempotency keys, presigned multipart and resumable (TUS) uploads, webhooks with rotating secrets and durable retries, API keys with scopes and rate-limit headers, and a generated SDK and OpenAPI document.
- Accounts with Google sign-in, a dashboard for API keys, usage metering and quotas.
- Local, S3-compatible and OCI object storage behind one streaming interface, with bring-your-own-storage credentials sealed in the job.
- The web interface: format pages with bidirectional conversion grids, and accessible FAQs.
- Production packaging for the shared OCI arm64 host: a web image on the worker image, a hardened Compose stack with hard CPU and memory limits and a capped scratch mount, an AppArmor profile, the nginx site, a manual deploy workflow with health and smoke checks, rollback and reconcile, and the operations guide `docs/deploy-oci.md`.
- A quality and speed gate on conversion changes, a nightly run on real-world files, a weekly 20,000-file corpus, and a record of every policy decision with its reasons in `docs/policy-decisions.md`.

### Changed

- Faster conversions on the speed rows: native zstd, bzip2, deflate and ZIP writers, faster AVIF, WebP and JPEG encoding, qpdf run by a native runner, and Parquet and CSV cells scanned a word at a time.
- Output closer to the reference tools: AVIF written as one tile at the reference settings, Opus and AAC encoded and resampled as the references do, DOCX, ODT and HTML pages laid out as the office suite draws them, and EMF, WMF, DXF and PostScript pages sized as the references size them.
- The worker image moves to Debian 13 and Node.js 24, and builds FFmpeg 9.0.2, libvips with its codecs at -O3, and a pinned 7-Zip and veraPDF.
- New code smells are gated by a shrinking baseline.

### Fixed

- Conversions that fabricated output now fail closed: no synthesised media, no placeholder glyphs and no invented formats, and empty or invalid output is refused with a typed error.
- Many real-file failures found by the nightly run: damaged and late-header PDFs, legacy Office and e-book sources, HEIC, JPEG 2000, PSD, XCF and RAW sources, rpm, deb, dmg and cab archives, and fonts, spreadsheets and CSV in legacy encodings.
- Bugs in text recovery from PDF fonts, annotation text, links and named destinations, tables, nested tables and page breaks in the in-process renderers.
- Flaky timing tests and CI failures, fixed at their cause.

### Security

- Every native conversion runs in a namespace sandbox with rlimits, a seccomp profile and no network; the strict sandbox answers 503 when it is unavailable, and the container runs read-only with all capabilities dropped.
- Archive bombs, decompression bombs, page bombs and pixel counts are bounded; zip-slip, 7z and encrypted ZIP extraction are contained; PDF passwords stay out of process arguments.
- Server-side request forgery is blocked in graph imports and exports, webhooks, SVG and HTML images; the SVG and HTML sanitisers are linear-time and neutralise external references; conversion options that name server files are refused on every route.
- Authentication fails closed: JWT, session revocation, OAuth with PKCE, API key scopes and hashing, a trusted-proxy resolver for client addresses, CSRF protection, and owner checks on every download and job input.
- Uploads are checked against their detected type, bounded by size, and limited to the session ids the store generated; playlist and reference media inputs are refused, and ffmpeg and ffprobe run in the sandbox.
- Dependencies are patched for the open advisories, third-party notices ship with the image, and a private vulnerability reporting policy is published.

[Unreleased]: https://github.com/AquilaXk/easyconvert/commits/main
