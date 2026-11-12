# EasyConvert

[![CI](https://github.com/AquilaXk/easyconvert/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/AquilaXk/easyconvert/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

[English](README.md) | [한국어](README.ko.md)

EasyConvert is an open-source file conversion service with a web app and an HTTP API. It converts **308 formats** in **13 categories** (**2,766** source-to-target pairs). Production runs at <https://convert.aquilaxk.site>.

[Live service](https://convert.aquilaxk.site) · [API reference](https://convert.aquilaxk.site/api-docs) · [Configuration](docs/configuration.md) · [Security policy](SECURITY.md)

## Features

- **Many formats, one API.** Images (including camera RAW), documents, archives, video, audio, subtitles, ebooks, spreadsheets, presentations, data files, vector graphics, fonts, and CAD and 3D.
- **Sandboxed engines.** LibreOffice, FFmpeg, libvips, Poppler, Tesseract, 7-Zip, Calibre, and veraPDF run as external tools inside a per-job sandbox. Some formats use in-process TypeScript engines: HWP 5.0 (OLE2 CFBF), BZip2, TrueType/OpenType font tables, B-spline and Bézier path flattening, and Oklab and NeuQuant palette quantization.
- **Searchable OCR.** Scanned input becomes a PDF with a searchable text layer.
- **PDF/A output.** Every PDF/A result is validated with veraPDF against the requested level.
- **Synchronous and queued conversion.** `POST /api/v1/convert` answers in the request. `POST /api/v1/jobs` queues single conversions, `tasks` pipelines, and `graph` DAGs on a Redis-backed queue with retries, progress, and HMAC-SHA256 signed webhooks.
- **Large uploads.** tus 1.0.0 resumable uploads and presigned direct multipart uploads, with S3, OCI, or local storage behind them.
- **Fails closed.** Zero-byte files, spoofed magic bytes, corrupt headers, and unsupported pairs are refused with HTTP 400 or 422. There is no silent fallback.
- **Scheduled deletion.** A result is deleted 10 minutes after its first complete download or 1 hour after conversion. An upload is deleted 10 minutes after the last job that reads it (policy decision 125).
- **Localized UI and pair pages.** Pages such as `/pdf-to-docx`, `/png-to-webp`, and `/mp4-to-mp3`, and API reference pages generated from the OpenAPI 3.1 document.

## Supported formats

EasyConvert reads and writes the formats below. The `GET /api/formats` endpoint lists them with the pairs each one supports.

<!-- registry-stats:start -->
| Category | Format Count | Supported Extensions |
| :--- | ---: | :--- |
| **Images** (`image`) | 50 | 3FR, AI, ARW, AVIF, BMP, CR2, CR3, CRW, CUR, DCR, DDS, DNG, EPS, ERF, EXR, GIF, HEIC, HEIF, ICNS, ICO, J2K, JFIF, JP2, JPEG, JPG, JXL, MOS, MRW, NEF, ORF, PBM, PCX, PEF, PGM, PNG, PNM, PPM, PSB, PSD, RAF, RAW, RW2, TGA, TIF, TIFF, WBMP, WEBP, X3F, XCF |
| **Documents** (`document`) | 43 | ABW, DJVU, DOC, DOCM, DOCX, DOT, DOTX, EML, FODT, HOCR, HTM, HTML, HWP, HWPX, LATEX, LOG, LWP, MAN, MD, MSG, ODD, ODG, ODT, OTT, OXPS, PAGES, PDB, PDF, PDFA, PUB, RST, RTF, SDW, SXW, TEX, TEXT, TXT, WPD, WPS, XHTML, XML, XPS, ZABW |
| **Archives** (`archive`) | 44 | 7Z, ACE, ALZ, ARC, ARJ, BZ, BZ2, CAB, CPIO, DEB, DMG, EAR, GZ, IMG, ISO, JAR, LHA, LZ, LZMA, LZO, RAR, RPM, RZ, TAR, TAR.7Z, TAR.BZ, TAR.BZ2, TAR.GZ, TAR.LZO, TAR.XZ, TAR.Z, TAR.ZST, TBZ, TBZ2, TGZ, TXZ, TZ, TZO, WAR, XZ, Z, ZIP, ZST, ZSTD |
| **Video** (`video`) | 37 | 3G2, 3GP, 3GPP, ASF, AV1, AVI, CAVS, DIVX, DV, DVR, F4V, FLV, H264, H265, HEVC, M2TS, M2V, M4V, MKV, MOD, MOV, MP4, MPEG, MPG, MTS, MXF, OGV, RM, RMVB, SWF, TS, VOB, WEBM, WEBP, WMV, WTV, XVID |
| **Audio** (`audio`) | 29 | AAC, AC3, AIF, AIFC, AIFF, ALAC, AMR, APE, AU, CAF, DSS, DTS, FLAC, M4A, M4B, MID, MIDI, MKA, MP3, MPC, OGA, OGG, OPUS, RA, SPX, VOC, WAV, WEBA, WMA |
| **Subtitles** (`subtitle`) | 5 | ASS, SRT, SSA, SUB, VTT |
| **Ebooks** (`ebook`) | 24 | AZW, AZW3, AZW4, CB7, CBC, CBR, CBT, CBZ, CHM, DJV, EPUB, FB2, HTMLZ, IBOOKS, LIT, LRF, MOBI, OEB, PML, PRC, RB, SNB, TCR, TXTZ |
| **Spreadsheets** (`spreadsheet`) | 18 | DBF, DIF, ET, FODS, NUMBERS, ODS, OTS, PRN, QPW, SDC, SLK, WK1, WKS, XLS, XLSM, XLSX, XLT, XLTX |
| **Presentations** (`presentation`) | 18 | DPS, FODP, KEY, KEYNOTES, ODP, OTP, POT, POTX, PPS, PPSX, PPT, PPTM, PPTX, PRESENTATION, SDA, SHW, SXD, SXI |
| **Data & Tables** (`data`) | 11 | CSV, JSON, JSONL, NDJSON, PARQUET, TAB, TOML, TSV, XML, YAML, YML |
| **Vector** (`vector`) | 10 | CDR, CGM, EMF, PS, SK, SK1, SVG, SVGZ, VSD, WMF |
| **Fonts** (`font`) | 10 | BIN, DFONT, EOT, OTF, PFA, PFB, SVG, TTF, WOFF, WOFF2 |
| **CAD & 3D** (`cad`) | 9 | DWF, DWG, DXF, IGES, IGS, OBJ, STEP, STL, STP |
<!-- registry-stats:end -->

Regenerate `docs/generated/registry-stats.json` and the table above after changing `src/lib/registry.ts`:

```bash
npm run docs:generate
```

## Quick start

Requirements: Node.js 24 or newer, npm 10 or newer, and Docker with Compose for the worker.

```bash
git clone https://github.com/AquilaXk/easyconvert.git
cd easyconvert
npm install
docker compose up -d   # Redis and one worker, local storage, no cloud setting or secret needed
npm run dev            # web app at http://localhost:3000
```

`docker compose up` starts Redis and a worker that subscribes to every queue. `docker compose --profile split up -d --scale worker=0` starts one worker per resource class instead. For a production build, run `npm run build` and `npm start`.

The production stack (web, worker, Redis, hard limits) is `docker-compose.prod.yml`. See [docs/deploy-oci.md](docs/deploy-oci.md).

## Configuration

The server and the worker validate the whole environment at start-up and refuse to run on a malformed value. [docs/configuration.md](docs/configuration.md) lists all variables, and [docs/configuration.example.env](docs/configuration.example.env) is a starting file. The settings below matter most in production.

- `KEY_HASH_PEPPER`: server-side secret that stores API key hashes as HMAC-SHA256 instead of plain SHA-256. Use a random value of at least 32 bytes. To rotate without downtime, set the new value and put the old one in `KEY_HASH_PEPPER_PREVIOUS`. A key that matches only the old value is verified and rehashed on first use. Rotating without `KEY_HASH_PEPPER_PREVIOUS` invalidates the existing keys.
- `JOB_SECRET_KEK`: secret that seals the signed URLs and request headers stored in queued job data (AES-256-GCM, bound to the job id). It is required in production for the web app and every worker. Use a value such as `openssl rand -hex 32`, and do not reuse the JWT, vault, or encryption secrets. `docker-compose.prod.yml` refuses to start the workers until it is set. Outside production, a development key is used when it is unset.
- `JOB_SECRET_KEK_PREVIOUS`: optional. During a rotation, set it to the old `JOB_SECRET_KEK` so jobs queued before the change can still be opened, and remove it when those jobs finish. A job sealed under a key that is not configured fails with an unknown-key error.
- `EASYCONVERT_MAX_INPUT_PIXELS`: most pixels a still image (or an image inside a document) may declare. Larger pictures are refused with HTTP 413 from the container header, before any pixel is decoded. The default is 100000000 (100 megapixels), a plain decimal number, and a larger value is lowered to 268402689 (16383 x 16383). A malformed value is reported once in the log and ignored. Tighter built-in budgets apply to in-process per-pixel paths (Oklab and Riemersma palette quantization, camera RAW sensors, Ultra HDR).
- `TRUSTED_PROXIES`: client-IP trust mode, required when `NODE_ENV=production`. Set it to the CIDR list of the proxy hops in front of the server, or to `none` when the server is exposed directly (every client then shares one rate-limit bucket). Without it the edge answers API routes with 503.
- `TRUSTED_CDN`: set to `cloudflare` to honour `CF-Connecting-IP` from verified Cloudflare edge hops.
- `TRUSTED_PROXY_HEADER`: the single forwarding header your proxy maintains, `x-forwarded-for` (default) or `forwarded`.

See also [docs/client-ip-trust.md](docs/client-ip-trust.md).

## API

The written reference is served at `/api-docs` (topic pages `quickstart`, `convert`, `jobs`, `uploads`, `downloads`, `formats`, `ocr-languages`, `archives`, `usage`). The OpenAPI 3.1 document is at `GET /api/v1/openapi.json` (alias `GET /api/openapi.json`). TypeScript and Python clients are in [sdk/](sdk).

Convert a file synchronously:

```bash
curl -X POST https://convert.aquilaxk.site/api/v1/convert \
  -H "Authorization: Bearer $EASYCONVERT_API_KEY" \
  -F "file=@report.docx" \
  -F "targetFormat=pdf" \
  -o response.json
```

The key can also be sent in an `x-api-key` header. The response is JSON with `fileId`, `fileName`, `mimeType`, `size`, `downloadUrl`, `expiresAt`, and a `dataUri` for small results. Send `Accept: application/octet-stream` (or `?raw=true`) to receive the converted bytes directly:

```bash
curl -X POST "https://convert.aquilaxk.site/api/v1/convert?raw=true" \
  -H "Authorization: Bearer $EASYCONVERT_API_KEY" \
  -F "file=@photo.png" -F "targetFormat=webp" -o photo.webp
```

Callers without an account have a daily limit (policy decision 16 in [docs/policy-decisions.md](docs/policy-decisions.md)).

### Public v1 (`/api/v1/*`)

- **Synchronous conversion**: `POST /api/v1/convert` (`multipart/form-data` with `file`, `targetFormat`, optional `options`, and an optional `Idempotency-Key` header).
  - `layout` (PDF to TXT): `true` keeps the physical page layout so table rows stay on one line. The default reads text in reading order, column after column.
  - `imageDpi` (72-1200) and `jpegQuality` (1-100) (Office to PDF): opt into a compression profile. By default the embedded JPEG streams, the outline, and the links pass through unchanged.
  - `pdfa` (`{"conformance": "pdfa-1b" | "pdfa-2b" | "pdfa-3b"}`) or `pdfStandard`: request PDF/A output. A request that names no level (`{}` or `"pdfa"`) is answered at PDF/A-2b. A missing veraPDF answers `503`. A file that fails validation answers `422` with the failed rule IDs (`failedRules`) and the requested `profile`.
- **Jobs and pipelines**: `POST /api/v1/jobs`, `GET /api/v1/jobs`, `GET /api/v1/jobs/:id`, `DELETE /api/v1/jobs/:id`. Single-step conversions, sequential `tasks` pipelines, and multi-node `graph` DAGs, with two-phase quota reservation and optional HMAC-SHA256 webhook callbacks.
- **tus 1.0.0 uploads**: `OPTIONS` and `POST /api/v1/uploads`, `HEAD`, `PATCH`, and `DELETE /api/v1/uploads/:id`.
- **Direct multipart uploads**: `POST /api/v1/uploads/direct`, `PUT /api/v1/uploads/direct/part`, `POST /api/v1/uploads/direct/complete`, `DELETE /api/v1/uploads/direct/:id`.
- **Archive inspection**: `POST /api/v1/archives/inspect` lists entries and encryption status without extracting payloads.
- **OCR languages**: `GET /api/v1/ocr/languages` lists installed language packs and script metadata.

### Web application endpoints

- `POST /api/convert` and `POST /api/convert/batch` (ZIP bundling): synchronous conversion.
- `GET /api/formats`: format registry, with optional `category` and `search` query parameters.
- `POST /api/fetch-url`: remote ingestion, body `{"url": "https://example.com/asset.png"}`.
- `POST /api/queue/jobs` with `{"filename": "model.step", "targetFormat": "stl", "storageKey": "...", "fileSize": 1048576, "options": {}}`: submit a job. `GET /api/queue/jobs/:id` polls it (`?stream=true` streams Server-Sent Events), `DELETE /api/queue/jobs/:id` cancels it, and `GET /api/queue/stats` reports queue metrics.
- `POST /api/storage/multipart` with `action` set to:
  - `initiate`: JSON body `{"filename": "archive.zip", "mimeType": "application/zip", "totalSize": 104857600}` (optional `partSize`, or `contentType` and `fileSize` on job handoff). Returns `uploadId`, `key`, `partSize`, `totalParts`, and `expiresAt`.
  - `chunk`: `?action=chunk&uploadId=...&partNumber=1` with a raw `application/octet-stream` body and `Content-Length`.
  - `complete`: `{"uploadId": "...", "parts": [{"partNumber": 1, "etag": "..."}]}`.
  - `abort`: `{"uploadId": "..."}`.
  - `GET /api/storage/file/[...key]` downloads the stored file.
- `GET /api/health`: `{"status": "healthy" | "unhealthy"}` with HTTP `200` or `503`, from live `redis` (when configured) and `storage` probes. The native binaries (`soffice`, `ffmpeg`, `ffprobe`, `pdftoppm`, `pdftotext`, `tesseract`, `7z`, `dcraw_emu`, `ebook-convert`) are advisory components. A request with a wildcard (`*`) scope API key also gets `components`.

## Architecture

The web app (Next.js 15 App Router, TypeScript) accepts a request and checks quota. Work is queued in Redis (Lua scripts), and workers run each conversion in a sandboxed child process. Objects live on local disk, S3, or OCI object storage.

```
easyconvert/
├── src/
│   ├── app/                 # Next.js pages and API routes
│   │   ├── [locale]/        # Localized UI (converter, /[slug], /api-docs)
│   │   └── api/             # convert, formats, queue, storage, keys, health, v1/*
│   ├── components/          # UI and API documentation components
│   ├── lib/
│   │   ├── api/openapi/     # OpenAPI 3.1 schema and paths
│   │   ├── conversions/     # Conversion engines and dispatchers
│   │   ├── queue/           # Redis queue (bullmq-engine.ts, conversion-queue.ts)
│   │   ├── storage/         # Local, S3, and OCI storage backends
│   │   ├── registry.ts      # Canonical format definitions and options
│   │   └── slug-parser.ts   # [source]-to-[target] route parser
│   └── worker/              # Queue worker entry point
├── sdk/                     # TypeScript and Python clients
├── bench/                   # Quality and speed benchmarks
├── docs/                    # Policy decisions, deployment, configuration, generated stats
├── scripts/                 # Build, verification, and doc generation scripts
├── tests/                   # Vitest unit, integration, and drift tests
├── Dockerfile.web, Dockerfile.worker
└── docker-compose.yml, docker-compose.prod.yml
```

## Development

```bash
npm test                   # Vitest (runs guard:anti-cheat first)
npm run lint
npm run guard:code-smells  # no new code smell in src
npm run bench:quality      # conversion quality benchmark
```

- **Code smell ratchet.** `npm run guard:code-smells` runs ESLint over `src/**/*.{ts,tsx}` with `complexity` 30, `max-depth` 5, `max-lines-per-function` 250, `max-params` 6, `max-lines` 1500, `no-nested-ternary`, and `no-explicit-any`. Inline `eslint-disable` comments are ignored. Existing violations are in `.github/code-smell-baseline.json`, keyed by file, rule, and function name. The baseline only shrinks: fix a `NEW` or `GREW` line, and run `npm run guard:code-smells -- --update` to commit a smaller baseline.
- **Policy decisions.** Output defaults, limits, engines, and the quality gate are recorded with their rationale in [docs/policy-decisions.md](docs/policy-decisions.md). Update it in the commit that changes a policy.
- **Operations.** [docs/operations/README.md](docs/operations/README.md), [docs/deploy-oci.md](docs/deploy-oci.md), and [docs/slo.md](docs/slo.md).
- **Static analysis.** SonarCloud, configured in `sonar-project.properties`.

One maintainer works on this project. Changes go straight to `main` and CI runs on every push. Remaining work is listed in [TODO.md](TODO.md). A release is tagged per deploy with a short hand-written note (see [docs/deploy-oci.md](docs/deploy-oci.md), "Releases", and [CHANGELOG.md](CHANGELOG.md)).

## Security

Report a vulnerability privately as described in [SECURITY.md](SECURITY.md). Do not open a public issue.

## License

EasyConvert is distributed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for the parts that keep their own licences. Versions published before 2026-11-12 were released under the MIT License.

- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): attribution, copyright, and licence terms for all production dependencies.
- [docs/licensing.md](docs/licensing.md): external CLI tools (FFmpeg, Poppler, veraPDF), LGPL relinking, unRAR restrictions, and codec patent considerations.
