# EasyConvert

[English](README.md) | [한국어](README.ko.md)

EasyConvert is a modern, high-performance universal file conversion platform built with Next.js, TypeScript, and a signature lavender color system. It provides seamless in-browser and server-assisted conversion across images, documents, spreadsheets, data structures, archives, and media formats with strict privacy and deterministic guarantees.

---

## Features

- **Extensive Format Support**: Convert seamlessly between dozens of standard formats across images (PNG, JPG, WebP, AVIF, GIF, BMP, TIFF, SVG, ICO), documents (PDF, Markdown, HTML, Plain Text), data (CSV, JSON, TSV, XML, YAML, XLSX), and archives (ZIP, TAR, GZ).
- **Signature Lavender Design System**: Crafted with a carefully calibrated lavender palette featuring high-contrast typography, accessible touch targets, and full light/dark mode support.
- **Fine-Grained Conversion Controls**: Configure format-specific parameters such as quality, dimensions, scaling modes, metadata stripping, page orientation, audio bitrates, and archive compression.
- **Batch Processing & Archive Bundling**: Convert multiple files concurrently and download individual outputs or a combined ZIP archive.
- **Fail-Closed Security**: Uploaded files are processed in ephemeral memory or isolated temporary storage and cleared immediately after conversion. No silent fallbacks or corrupted data substitution.
- **Developer-Friendly REST API**: Comprehensive programmatic endpoints for format querying, conversion jobs, and batch workflows.

---

## Architecture Overview

```
easyconvert/
├── src/
│   ├── app/                 # Next.js App Router (pages & API endpoints)
│   │   ├── api/
│   │   │   ├── convert/     # Conversion execution API
│   │   │   ├── formats/     # Format registry & matrix API
│   │   │   └── health/      # Service health API
│   │   ├── layout.tsx       # Root layout with theme provider
│   │   ├── page.tsx         # Converter interactive dashboard
│   │   └── globals.css      # Design system variables & utilities
│   ├── components/          # Reusable UI components
│   │   ├── Header.tsx       # Sticky navigation with theme toggle
│   │   ├── Hero.tsx         # Converter selector & drag-and-drop zone
│   │   ├── ConversionList.tsx # Queue table with per-item options
│   │   ├── OptionsModal.tsx # Parameter configuration dialog
│   │   ├── FormatMatrix.tsx # Interactive supported format browser
│   │   ├── ValueProps.tsx   # Feature highlights & security cards
│   │   ├── FaqSection.tsx   # Common questions & answers
│   │   └── Footer.tsx       # Brand footer & status indicators
│   ├── lib/
│   │   ├── conversions/     # Real conversion engines (Image, Doc, Data, Archive)
│   │   ├── registry.ts      # Canonical format definitions & constraints
│   │   ├── theme.ts         # Lavender color system constants
│   │   └── types.ts         # Shared TypeScript interfaces
│   └── tests/               # Deterministic unit and integration tests
├── .github/
│   └── workflows/ci.yml     # Automated verification pipeline
└── package.json
```

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

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Running Tests

```bash
npm test
```

### Production Build

```bash
npm run build
npm start
```

---

## API Reference

### 1. Format Registry
`GET /api/formats`
Returns the complete list of supported formats, categories, options, and conversion pairings.

### 2. File Conversion
`POST /api/convert`
Multipart form upload containing:
- `file`: The source binary file.
- `targetFormat`: The destination format identifier (e.g. `webp`, `pdf`, `json`).
- `options`: Optional JSON string of conversion parameters (e.g. `{"quality": 85, "width": 1200}`).

### 3. Service Health
`GET /api/health`
Returns system status, uptime, and engine availability.

---

## License

MIT License. See [LICENSE](LICENSE) for details.
