# EasyConvert

[English](README.md) | [한국어](README.ko.md)

EasyConvert is a file conversion platform built with Next.js 15 (App Router) and TypeScript. It converts files across **308 file formats** and **2,766 conversion pairs** in **13 categories**.

EasyConvert combines in-memory TypeScript binary engines, sandboxed native tools, a Redis-backed queue with Lua scripts, and S3 or OCI multipart object storage. It fails closed on malformed or spoofed input and deletes stored files on a fixed schedule: a result 10 minutes after its first complete download or 1 hour after conversion, and an upload 10 minutes after the last job that reads it (policy decision 125).

---

## Key Highlights

- **308 Formats Across 13 Categories**: Supports Images, Documents, Archives, Video, Audio, Ebooks, Spreadsheets, Presentations, Data & Tables, Vector, Fonts, and CAD & 3D (`2,766` source-to-target pairs).
- **Binary Conversion Engines**:
  - **HWP 5.0 CFBF**: Compound File Binary Format (OLE2) parser and builder with paragraph and table extraction.
  - **Cox-de Boor Curves**: B-spline basis evaluator and Bézier flattening for CAD and vector paths.
  - **BZip2**: Burrows-Wheeler Transform (BWT), Move-To-Front (MTF), and Huffman coding encoder and decoder.
  - **Color Quantization**: Oklab k-d tree, NeuQuant, and Median Cut palette quantization with error diffusion dithering.
  - **Media Encoders**: Audio and video transcoding with stream validation and container packaging.
  - **Font Engines**: TrueType and OpenType SFNT table parser and converter for TTF, OTF, WOFF, WOFF2, EOT, PFA, PFB, DFONT, BIN, and SVG fonts.
  - **Searchable OCR**: Optical Character Recognition engine that embeds a searchable text layer into PDF output.
- **Redis-Backed Job Queue with Lua Scripts**: Asynchronous queue engine (`src/lib/queue/bullmq-engine.ts`, `src/lib/queue/conversion-queue.ts`) serving `/api/v1/jobs` and `/api/queue/jobs` with progress tracking, two-phase quota reservation, retries, DAG pipelines, and HMAC-signed webhooks.
- **Resumable and Multipart Storage**: Public tus 1.0.0 and presigned direct multipart uploads (`/api/v1/uploads`, `/api/v1/uploads/direct`) alongside web multipart chunk ingestion (`/api/storage/multipart`, `/api/storage/file/[...key]`) with scheduled expiration.
- **Dynamic Landing and API Reference Routes**: Localized `/[slug]` format-pair pages (for example `/pdf-to-docx`, `/png-to-webp`, `/mp4-to-mp3`) and topic-based `/api-docs` reference pages generated from the OpenAPI 3.1 specification (`/api/v1/openapi.json`).
- **Fail-Closed Processing and Scheduled Deletion**: Every job runs in an isolated worker, and results and uploads are deleted on the schedule above. Malformed payloads, spoofed magic bytes, or unsupported pairs fail closed with HTTP 400 or 422 responses.

---

## Supported Format Matrix (13 Categories)

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

---

## Architecture Overview

```
easyconvert/
├── src/
│   ├── app/                         # Next.js App Router (pages & API routes)
│   │   ├── [locale]/                # Localized UI pages (converter, /[slug], /api-docs)
│   │   ├── api/
│   │   │   ├── convert/             # Web synchronous conversion endpoints
│   │   │   │   └── batch/           # Batch conversion with ZIP bundling
│   │   │   ├── fetch-url/           # Remote file ingestion via URL
│   │   │   ├── formats/             # Format registry & capability query API
│   │   │   ├── health/              # Service health, readiness & smoke probes
│   │   │   ├── keys/                # API key management & secret rotation
│   │   │   ├── openapi.json/        # OpenAPI 3.1 specification endpoint
│   │   │   ├── queue/               # Web asynchronous job queue endpoints
│   │   │   │   ├── jobs/            # Job creation & status polling ([id])
│   │   │   │   └── stats/           # Queue metrics & throughput
│   │   │   ├── storage/             # Object storage download & multipart routes
│   │   │   │   ├── file/[...key]/   # Ephemeral artifact download
│   │   │   │   └── multipart/       # Multipart chunk upload orchestration
│   │   │   ├── v1/                  # Public REST API v1 (/api/v1/*)
│   │   │   │   ├── archives/inspect/# Archive structure & encryption inspection
│   │   │   │   ├── convert/         # Synchronous conversion with 2-phase quota
│   │   │   │   ├── jobs/            # Async jobs & DAG pipelines ([id])
│   │   │   │   ├── ocr/languages/   # Installed OCR language catalog
│   │   │   │   ├── openapi.json/    # Public OpenAPI 3.1 specification
│   │   │   │   ├── storage/         # Customer BYOS credential vault
│   │   │   │   ├── uploads/         # tus 1.0.0 & direct presigned multipart uploads
│   │   │   │   ├── usage/           # Metered API usage & quota reporting
│   │   │   │   └── webhooks/        # Webhook signing secret rotation
│   │   │   └── webhooks/dlq/        # Webhook dead-letter queue inspection & replay
│   │   ├── globals.css              # Design system variables & utility classes
│   │   └── layout.tsx               # Root layout & providers
│   ├── components/                  # UI and API documentation components
│   └── lib/
│       ├── api/openapi/             # OpenAPI 3.1 schema and path definitions
│       ├── conversions/             # Binary conversion engines and dispatchers
│       ├── queue/                   # Redis-backed queue with Lua scripts
│       │   ├── bullmq-engine.ts     # Redis Lua queue adapter & in-memory engine
│       │   └── conversion-queue.ts  # Queue manager & job lifecycle coordinator
│       ├── storage/                 # Local, S3, and OCI object storage backends
│       ├── registry.ts              # 308 canonical format definitions & options
│       ├── registry-stats.ts        # Computed format, category, and pair statistics
│       ├── slug-parser.ts           # Dynamic route slug parser ([source]-to-[target])
│       └── types.ts                 # TypeScript schemas & queue contracts
├── docs/                            # Policy decisions, deployment, and generated stats
├── scripts/                         # Build, verification, and doc generation scripts
├── tests/                           # Vitest unit, integration, and drift test suites
├── sonar-project.properties         # SonarCloud code quality configuration
└── package.json
```

---

## API Reference

Written reference documentation for the public v1 API is served at `/api-docs` (with topic pages `/api-docs/quickstart`, `/api-docs/convert`, `/api-docs/jobs`, `/api-docs/uploads`, `/api-docs/downloads`, `/api-docs/formats`, `/api-docs/ocr-languages`, `/api-docs/archives`, and `/api-docs/usage`) and backed by the OpenAPI 3.1 document at `GET /api/v1/openapi.json` (alias `GET /api/openapi.json`).

### 1. Public v1 Conversion & Jobs (`/api/v1/*`)
- **Synchronous Conversion**: `POST /api/v1/convert` (`multipart/form-data` with `file`, `targetFormat`, optional `options`, and optional `Idempotency-Key` header).
  - **Document options** (inside `options`):
    - `layout` (PDF to TXT): `true` keeps the physical page layout so table rows stay on one line. The default reads text in reading order, column after column.
    - `imageDpi` (72-1200) and `jpegQuality` (1-100) (Office to PDF): opt into a compression profile. By default the embedded JPEG streams, the outline, and the links pass through unchanged.
    - `pdfa` (`{"conformance": "pdfa-1b" | "pdfa-2b" | "pdfa-3b"}`) or `pdfStandard`: request PDF/A output. A request that names no level (`{}` or `"pdfa"`) is answered at **PDF/A-2b**. Every PDF/A output is validated with veraPDF against the requested level: a missing veraPDF answers `503`, and a file that fails validation answers `422` with the failed rule IDs (`failedRules`) and the requested `profile`.
- **Asynchronous Jobs & Pipelines**: `POST /api/v1/jobs`, `GET /api/v1/jobs`, `GET /api/v1/jobs/:id`, `DELETE /api/v1/jobs/:id`
  - Enqueues single-step conversions, sequential `tasks` pipelines, or multi-node `graph` DAGs to the Redis-backed queue with Lua scripts, automatic two-phase quota reservation, and optional HMAC-SHA256 webhook callbacks.
- **Resumable & Direct Multipart Uploads**:
  - tus 1.0.0 resumable uploads: `OPTIONS /api/v1/uploads`, `POST /api/v1/uploads`, `HEAD /api/v1/uploads/:id`, `PATCH /api/v1/uploads/:id`, `DELETE /api/v1/uploads/:id`
  - Presigned direct multipart uploads: `POST /api/v1/uploads/direct`, `PUT /api/v1/uploads/direct/part`, `POST /api/v1/uploads/direct/complete`, `DELETE /api/v1/uploads/direct/:id`
- **Archive Inspection & OCR Catalog**:
  - `POST /api/v1/archives/inspect`: Inspects archive entries and encryption status without extracting payloads.
  - `GET /api/v1/ocr/languages`: Lists installed OCR language packs and script metadata.

### 2. Web Application Endpoints
- **Synchronous Conversion**: `POST /api/convert` and `POST /api/convert/batch`
- **Format Registry Query**: `GET /api/formats` (optional `category` and `search` query parameters)
- **Remote URL Ingestion**: `POST /api/fetch-url` (`{"url": "https://example.com/asset.png"}`)
- **Web Job Queue**:
  - Submit job: `POST /api/queue/jobs` with `{"filename": "model.step", "targetFormat": "stl", "storageKey": "...", "fileSize": 1048576, "options": {}}`
  - Poll or stream status: `GET /api/queue/jobs/:id` (supports `?stream=true` for Server-Sent Events)
  - Cancel job: `DELETE /api/queue/jobs/:id`
  - Queue metrics: `GET /api/queue/stats`
- **Multipart Chunked Storage (`POST /api/storage/multipart`)**:
  - Initialize upload: `POST /api/storage/multipart?action=initiate` with JSON body `{"filename": "archive.zip", "mimeType": "application/zip", "totalSize": 104857600}` (and optional `partSize`, or `contentType` / `fileSize` metadata on job handoff). Returns `uploadId`, `key`, `partSize`, `totalParts`, and `expiresAt`.
  - Upload chunk part: `POST /api/storage/multipart?action=chunk&uploadId=...&partNumber=1` with raw binary body (`application/octet-stream`) and `Content-Length`.
  - Complete upload: `POST /api/storage/multipart?action=complete` with `{"uploadId": "...", "parts": [{"partNumber": 1, "etag": "..."}]}`.
  - Abort upload: `POST /api/storage/multipart?action=abort` with `{"uploadId": "..."}`.
  - Retrieve file: `GET /api/storage/file/[...key]`
- **Service Health & Diagnostics**:
  - `GET /api/health`: Returns `{"status": "healthy" | "unhealthy"}` with HTTP `200` (`healthy`) or `503` (`unhealthy`) based on live `redis` (when configured) and `storage` probes. Native binaries (`soffice`, `ffmpeg`, `ffprobe`, `pdftoppm`, `pdftotext`, `tesseract`, `7z`, `dcraw_emu`, `ebook-convert`) are probed as advisory components under `components`, which are included when called with a wildcard (`*`) scope API key.

---

## Getting Started

### Prerequisites

- Node.js >= 24 (active LTS)
- npm >= 10.x

### Installation

```bash
git clone https://github.com/AquilaXk/easyconvert.git
cd easyconvert
npm install
```

### Configuration

- `KEY_HASH_PEPPER`: server-side secret used to store API key hashes as HMAC-SHA256 instead of plain SHA-256; set it to a long random value (at least 32 bytes) in production. Zero-downtime rotation is supported by pairing the new value with `KEY_HASH_PEPPER_PREVIOUS` so existing keys verify and rehash on first use; rotating without `KEY_HASH_PEPPER_PREVIOUS` invalidates keys hashed under the previous value.
- `KEY_HASH_PEPPER_PREVIOUS`: optional previous pepper secret used during zero-downtime `KEY_HASH_PEPPER` rotation. When set, an API key that does not match the current `KEY_HASH_PEPPER` is checked against `KEY_HASH_PEPPER_PREVIOUS` and transparently migrated to the current pepper hash upon successful verification.
- `JOB_SECRET_KEK`: dedicated secret that seals the signed URLs and request headers stored in queued job data (AES-256-GCM, bound to the job id). It is required in production for both the web app and every worker: use a random value of at least 32 bytes, for example `openssl rand -hex 32`; the JWT, vault, and encryption secrets are never reused for this. `docker compose up` refuses to start the workers until it is set. Outside production a development key is used when it is unset.
- `JOB_SECRET_KEK_PREVIOUS`: optional; during a rotation, set it to the old `JOB_SECRET_KEK` value so jobs queued before the change can still be opened. Remove it once those jobs have finished. A job sealed under a key that is neither configured fails with an unknown-key error.
- `EASYCONVERT_MAX_INPUT_PIXELS`: most pixels a still image (or an image inside a document) may declare before conversion; larger pictures are refused with HTTP 413 from the container header, before any pixel is decoded. Default 100000000 (100 megapixels), a plain decimal number, lowered to 268402689 (16383 x 16383) when larger; a malformed value is reported once in the log and ignored. Tighter built-in budgets apply to in-process per-pixel paths (Oklab and Riemersma palette quantization, camera RAW sensors, Ultra HDR).
- `TRUSTED_PROXIES`: client-IP trust mode, required when `NODE_ENV=production`. Set it to the CIDR list of the proxy hops in front of the server, or to `none` when the server is exposed directly (every client then shares one rate-limit bucket). Without it the edge answers API routes with 503.
- `TRUSTED_CDN`: set to `cloudflare` to honour `CF-Connecting-IP` from verified Cloudflare edge hops.
- `TRUSTED_PROXY_HEADER`: the single forwarding header your proxy maintains, `x-forwarded-for` (default) or `forwarded`.

See [docs/client-ip-trust.md](docs/client-ip-trust.md) and [docs/configuration.md](docs/configuration.md) for the full deployment contract.

### Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the application.

### Deterministic Verification

Run the test suite with Vitest:

```bash
npm test
```

Run ESLint syntax and rule validation:

```bash
npm run lint
```

Check that no new code smell entered `src` (see [Code smell ratchet](#code-smell-ratchet)):

```bash
npm run guard:code-smells
```

### Production Build

```bash
npm run build
npm start
```

---

## Code Quality & Engineering Standards

### Code smell ratchet

`npm run guard:code-smells` (CI `checks` job) runs ESLint with only these rules over `src/**/*.{ts,tsx}`, independent of `next lint`: `complexity` 30, `max-depth` 5, `max-lines-per-function` 250 (blank lines and comments skipped), `max-params` 6, `no-nested-ternary`, `@typescript-eslint/no-explicit-any`, and `max-lines` 1500. Inline `eslint-disable` comments are ignored by this gate.

Existing violations are recorded in `.github/code-smell-baseline.json`, keyed by file, rule, and enclosing function name (never by line number, so unrelated edits do not move keys), with a count and the worst measured value. The baseline only shrinks:

- `NEW` or `GREW` lines name the file, function, rule, and measured value of a smell above the baseline. Fix the code; do not raise the baseline.
- `GONE` or improved lines mean you removed a smell. Run `npm run guard:code-smells -- --update` and commit the smaller baseline in the same change. `--update` refuses to raise any entry.
- A hot codec loop that must stay may keep its entry; add an optional `reason` field to that baseline entry. `--update` preserves it.
- CI also runs `npm run guard:code-smells -- --check-base <base baseline file>` against the commit a push replaces (or the base of a pull request): the baseline may not exceed it, summed per file and rule (a rename passes).

- **Deterministic Test Suite**: Vitest unit, integration, and drift tests verify RFC compliance, mathematical basis functions, OLE2 CFBF structures, OpenAPI contracts, and memory safety.
- **Fail-Closed Principle**: Zero-byte files, unknown extensions, and corrupt binary headers trigger HTTP 400 or 422 responses.
- **Scheduled Deletion**: A result is kept until its first complete download plus 10 minutes, or 1 hour after conversion, and an upload until 10 minutes after its last job (policy decision 125).
- **SonarCloud Integration**: Static analysis and code quality gates configured via `sonar-project.properties`.

---

## Policy decisions

Conversion and product policies, such as output defaults, limits, engines, and the quality gate, are recorded with their rationale and trade-offs in [docs/policy-decisions.md](docs/policy-decisions.md). Update it in the same commit that changes a policy.

## Maintenance

One maintainer. Changes go straight to `main` and CI runs on every push. Remaining work is listed in `TODO.md`. A release is tagged per deploy with a short hand-written note (see `docs/deploy-oci.md`, "Releases").

## Licensing

- **Project License**: EasyConvert is distributed under the [Apache License 2.0](LICENSE); see [NOTICE](NOTICE) for the parts that keep their own licences. Versions published before 2026-11-12 were released under the MIT License.
- **Third-Party Open Source Notices**: Full attribution, copyright, and licence terms for all production dependencies are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- **External Tools, Relinking & Patent Considerations**: Legal and architecture guidelines covering external CLI tools (FFmpeg, Poppler, veraPDF), LGPL relinking, unRAR component restrictions, and codec patent considerations are available in [docs/licensing.md](docs/licensing.md).
