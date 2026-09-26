# EasyConvert

[English](README.md) | [한국어](README.ko.md)

EasyConvert is a high-performance universal file conversion platform built with Next.js 14 (App Router), TypeScript, and a signature lavender design system. It delivers deterministic conversion across **292 file formats** and **2,156 verified conversion specifications** spanning **12 distinct categories**.

Powered by authentic in-memory pure-TypeScript binary engines, distributed BullMQ job queues, and S3/OCI chunked multipart storage, EasyConvert enforces a strict zero-retention, fail-closed privacy architecture for both browser and API workflows.

---

## Key Highlights

- **292 Universal Formats Across 12 Categories**: Comprehensive support for Images, Documents, Spreadsheets, Presentations, Korean Office (HWP), Vector & CAD, Fonts, Audio, Video, E-Books, Structured Data, and Archives.
- **Authentic Pure-TypeScript Algorithmic Engines**:
  - **HWP 5.0 CFBF**: Compound File Binary Format (OLE2) parser and bidirectional generator with paragraph and table extraction.
  - **Cox-de Boor NURBS**: Recursive basis evaluator and adaptive $(u, v)$ tessellator for STEP and IGES boundary representations.
  - **Pure BZip2**: Native Burrows-Wheeler Transform (BWT), Move-To-Front (MTF), and Huffman coding encoder/decoder.
  - **Color Quantization**: NeuQuant (1994) neural-gas and Median Cut (1982) algorithms with Floyd-Steinberg error diffusion dithering.
  - **Media Encoders**: In-memory MP3 MDCT spectral quantization and H.264 NAL baseline encoder packaged into ISO BMFF MP4 containers.
  - **Font Engines**: TrueType/OpenType SFNT table directory parser, font converter (TTF, OTF, WOFF, WOFF2, EOT, SVG Font), and quadratic Bézier curve extraction.
  - **Searchable OCR**: Optical Character Recognition engine generating invisible text overlays directly inside searchable PDFs.
- **Distributed Async Job Queue**: BullMQ-ready queue system (`/api/queue/jobs`, `/api/queue/stats`) with real-time job progress tracking, retry semantics, and webhook notifications.
- **S3 & OCI Chunked Multipart Storage**: Object storage abstraction (`/api/storage/multipart`, `/api/storage/file/[...key]`) supporting large binary file ingestion with automatic expiration.
- **Dynamic SEO Landing Routes**: Fully rendered dynamic `/[slug]` subpages for format pairs (e.g., `/pdf-to-docx`, `/png-to-webp`, `/mp4-to-mp3`) with format parameters, FAQs, and breadcrumbs.
- **Fail-Closed & Zero-Retention Security**: Ephemeral memory processing with instant cleanup upon job termination. Malformed payloads or unsupported formats immediately fail closed with HTTP 400 Bad Request, preventing corrupted outputs or silent fallbacks.
- **Signature Lavender Design System**: High-contrast, accessible user interface featuring a signature lavender palette with seamless light and dark mode support.

---

## Supported Format Matrix (12 Categories)

| Category | Format Count | Notable Supported Extensions |
| :--- | :--- | :--- |
| **Images & RAW** | 68 | PNG, JPG, JPEG, WebP, AVIF, GIF, BMP, TIFF, SVG, ICO, ICNS, EPS, 3FR, CRW, NEF, ARW, DNG, RAF, RW2, HEIC |
| **Documents** | 32 | PDF, DOCX, DOC, ODT, RTF, TXT, MD, HTML, XHTML, EPUB, AZW4, XPS, ABW, WPS, SXW |
| **Spreadsheets** | 18 | XLSX, XLS, CSV, TSV, ODS, ET, Numbers, XLSM, XLSB, XML, TAB |
| **Presentations** | 16 | PPTX, PPT, ODP, DPS, Keynote, PPS, PPSX, POT, POTX, VSDX |
| **Korean Office (HWP)** | 4 | HWP (5.0 OLE2 CFBF), HWPX, HWT, HWTX |
| **Vector & CAD** | 28 | DXF, DWG, SVG, EMF, WMF, CGM, CDR, STEP, STP, IGES, IGS, STL, OBJ, PLY, DWF |
| **Fonts** | 8 | TTF, OTF, WOFF, WOFF2, EOT, SVG Font, PFA, PFB |
| **Audio** | 22 | MP3, WAV, FLAC, AAC, OGG, M4A, WMA, AIFF, AC3, AMR, OPUS, MID |
| **Video** | 26 | MP4, WebM, AVI, MOV, MKV, FLV, WMV, MPEG, 3GP, M4V, TS, VOB |
| **E-Books** | 14 | EPUB, MOBI, AZW3, AZW, FB2, CBZ, CBR, LIT, LRF, PDB |
| **Data Structures** | 18 | JSON, JSONL, NDJSON, YAML, YML, XML, CSV, TSV, TOML, SQL, PLIST |
| **Archives** | 38 | ZIP, TAR, GZ, TGZ, BZ2, TBZ2, 7Z, RAR, XZ, Z, ISO, CAB, ARJ |

---

## Architecture Overview

```
easyconvert/
├── src/
│   ├── app/                         # Next.js App Router (pages & API routes)
│   │   ├── [slug]/                  # Dynamic format landing pages (e.g. /pdf-to-docx)
│   │   ├── api/
│   │   │   ├── convert/             # Synchronous conversion endpoints
│   │   │   │   └── batch/           # Batch conversion with ZIP bundling
│   │   │   ├── fetch-url/           # Remote file ingestion via URL
│   │   │   ├── formats/             # Format registry & capability query API
│   │   │   ├── health/              # Service health, uptime & engine status
│   │   │   ├── queue/               # Distributed BullMQ asynchronous job queue
│   │   │   │   ├── jobs/            # Job creation & polling ([id])
│   │   │   │   └── stats/           # Queue metrics & throughput
│   │   │   ├── storage/             # S3/OCI chunked object storage
│   │   │   │   ├── file/[...key]/   # Ephemeral artifact download
│   │   │   │   └── multipart/       # Multipart chunk upload orchestration
│   │   │   └── v2/                  # Interactive API v2 documentation dashboard
│   │   ├── login/                   # Authentication login view
│   │   ├── register/                # User registration view
│   │   ├── pricing/                 # Pricing plans & tier comparison table
│   │   ├── globals.css              # Lavender design system variables & utility classes
│   │   ├── layout.tsx               # Root layout & theme provider
│   │   └── page.tsx                 # Converter main dashboard
│   ├── components/                  # Reusable UI components
│   │   ├── AuthModal.tsx            # Login & register modal
│   │   ├── ConversionQueue.tsx      # Real-time conversion queue with progress & ZIP bundle
│   │   ├── FaqSection.tsx           # Accordion FAQ component
│   │   ├── Features.tsx             # Privacy, performance, and architecture highlights
│   │   ├── Footer.tsx               # Brand footer with status indicator
│   │   ├── FormatExplorer.tsx       # Searchable format browser across all 12 categories
│   │   ├── FormatSelector.tsx       # Filterable format picker popover
│   │   ├── Header.tsx               # Sticky navigation with theme toggle & user actions
│   │   ├── Hero.tsx                 # Converter selector & drag-and-drop zone
│   │   ├── OptionsModal.tsx         # Granular parameter configuration modal
│   │   ├── UrlImportModal.tsx       # Remote URL file ingestion modal
│   │   └── UrlUploadModal.tsx       # Secondary URL upload dialog
│   └── lib/
│       ├── conversions/             # Authentic binary conversion engines
│       │   ├── archive.ts           # ZIP, TAR, GZ, TGZ, BZ2, TBZ2, 7Z, RAR
│       │   ├── bzip2.ts             # Pure TS BZip2 (BWT + MTF + Huffman)
│       │   ├── cad-nurbs.ts         # Cox-de Boor NURBS tessellation for STEP/IGES
│       │   ├── data.ts              # CSV, TSV, JSON, JSONL, YAML, XML
│       │   ├── document.ts          # PDFKit, Markdown, HTML, RTF, EPUB
│       │   ├── font.ts              # TTF, OTF, WOFF, WOFF2, EOT, SVG Font
│       │   ├── hwp.ts               # Pure TS HWP 5.0 OLE2 CFBF parser & builder
│       │   ├── image.ts             # Sharp, PostScript raster, RAW formats
│       │   ├── media.ts             # Audio & video transcoding wrapper
│       │   ├── media-encoder.ts     # In-memory MDCT MP3 & NAL H.264 encoders
│       │   ├── ocr.ts               # Searchable PDF invisible text layer generator
│       │   ├── office.ts            # OOXML (DOCX, XLSX, PPTX), ODF, iWork
│       │   ├── pdf-utils.ts         # PDF layout, extraction, and utility methods
│       │   ├── quantize.ts          # NeuQuant & Median Cut color quantization
│       │   └── vector-cad.ts        # SVG, EMF, WMF, CGM, CDR, DXF, DWG
│       ├── queue/                   # BullMQ async worker & queue abstraction
│       │   ├── bullmq-engine.ts     # Redis client connection & job processor
│       │   └── conversion-queue.ts  # In-memory & distributed queue manager
│       ├── storage/                 # Multipart cloud storage abstractions
│       │   ├── oci-storage.ts       # Oracle Cloud Infrastructure Object Storage
│       │   └── s3-storage.ts        # AWS S3-compatible chunked upload engine
│       ├── pricing.ts               # Subscription tiers & credit calculator
│       ├── registry.ts              # 292 canonical format definitions & options
│       ├── slug-parser.ts           # Dynamic route slug parser ([source]-to-[target])
│       ├── theme.ts                 # Lavender palette design tokens
│       └── types.ts                 # TypeScript schemas & queue contracts
├── scripts/                         # Headless browser inspection & capture tools
├── tests/                           # 21 test suites & 192 deterministic tests
├── sonar-project.properties         # SonarCloud code quality configuration
└── package.json
```

---

## API Reference

EasyConvert provides synchronous REST endpoints, an asynchronous job queue for long-running conversions, and chunked multipart storage endpoints.

### 1. Synchronous File Conversion
- **Endpoint**: `POST /api/convert`
- **Content-Type**: `multipart/form-data`
- **Fields**:
  - `file`: The source binary file (required).
  - `targetFormat`: Destination format identifier (e.g., `webp`, `docx`, `mp3`, `pdf`).
  - `options`: Optional JSON string of conversion parameters (e.g., `{"quality": 85, "width": 1920}`).
- **Response**: Binary stream of the converted file with correct `Content-Type` and `Content-Disposition` headers.

### 2. Batch Conversion
- **Endpoint**: `POST /api/convert/batch`
- **Content-Type**: `multipart/form-data`
- **Fields**:
  - `files`: Multiple binary files.
  - `targetFormat`: Common target format (or per-file format mapping).
  - `bundleZip`: Boolean flag (`true` to return a combined ZIP archive).
- **Response**: Binary ZIP stream or JSON array of completed conversion results.

### 3. Format Registry Query
- **Endpoint**: `GET /api/formats`
- **Query Parameters**:
  - `category` *(optional)*: Filter by category (e.g., `image`, `document`, `cad`, `font`, `media`).
  - `search` *(optional)*: Search term matching format ID, name, or extension.
- **Response**: JSON array of format definitions, supported target formats, and option schemas.

### 4. Remote URL Ingestion
- **Endpoint**: `POST /api/fetch-url`
- **Content-Type**: `application/json`
- **Body**: `{"url": "https://example.com/asset.png", "targetFormat": "webp"}`
- **Response**: Ingested file metadata and temporary storage reference.

### 5. Distributed Asynchronous Job Queue
- **Submit Job**: `POST /api/queue/jobs`
  - Body: `{"originalFilename": "model.step", "targetFormat": "stl", "storageKey": "...", "options": {}}`
  - Returns: `{"jobId": "job-12345", "status": "waiting"}`
- **Poll Status**: `GET /api/queue/jobs/:id`
  - Returns: `{"jobId": "job-12345", "status": "completed", "downloadUrl": "/api/storage/file/..."}`
- **Queue Metrics**: `GET /api/queue/stats`
  - Returns active, waiting, completed, and failed job counters.

### 6. Multipart Chunked Storage
- **Initialize Upload**: `POST /api/storage/multipart?action=init`
  - Body: `{"filename": "archive.zip", "contentType": "application/zip", "size": 104857600}`
  - Returns: `uploadId`, `key`, and `partSize`.
- **Upload Part**: `POST /api/storage/multipart?action=part&uploadId=...&partNumber=1`
- **Complete Upload**: `POST /api/storage/multipart?action=complete&uploadId=...`
- **Retrieve File**: `GET /api/storage/file/[...key]`

### 7. Service Health & Diagnostics
- **Endpoint**: `GET /api/health`
- **Response**: System uptime, available engines, memory usage, and queue health.

---

## Getting Started

### Prerequisites

- Node.js >= 20.x
- npm >= 10.x

### Installation

```bash
git clone https://github.com/AquilaXk/easyconvert.git
cd easyconvert
npm install
```

### Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the application.

### Deterministic Verification

Execute the complete test suite across all 21 test files and 192 deterministic tests:

```bash
npm test
```

Run ESLint syntax and rule validation:

```bash
npm run lint
```

### Production Build

```bash
npm run build
npm start
```

---

## Code Quality & Engineering Standards

- **Deterministic Test Suite**: 21 test files containing 192 tests verifying RFC compliance, pure-TS mathematical basis functions, OLE2 CFBF structures, and memory safety.
- **Fail-Closed Principle**: Zero-byte files, unknown extensions, and corrupt binary headers immediately trigger HTTP 400 Bad Request responses.
- **Strict Zero-Retention**: No persistent file storage. Temporary buffers are allocated in ephemeral heap memory and cleared immediately upon conversion.
- **SonarCloud Integration**: Automated static analysis and code quality gates configured via `sonar-project.properties`.

---

## License

MIT License. See [LICENSE](LICENSE) for details.
