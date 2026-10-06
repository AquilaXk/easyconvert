# EasyConvert Licensing and Third-Party Notices Guide

This document outlines the licensing architecture, operational compliance boundaries, and legal considerations for EasyConvert and its third-party dependencies, external tools, and container runtimes.

---

## 1. Overview & Architectural Boundaries

EasyConvert is released under the **MIT License**. Its core algorithms, web application (Next.js), and in-process conversion engines are implemented in pure TypeScript without proprietary runtime dependencies.

To support wide-ranging format conversion across media, vector, and document formats, EasyConvert orchestrates external open-source engines in worker container environments. These components are categorized into two architectural tiers:

1. **In-Process Dependencies (npm Packages)**:
   - Governed by permissive licenses (MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, Unicode-DFS-2016, CC0-1.0) and LGPL-3.0 for dynamically linked native bindings (`sharp` / `libvips`).
   - Every production dependency is audited via [`licenses.allow.json`](../licenses.allow.json) and documented in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

2. **External CLI Tools & Native Executables**:
   - Executed as separate operating system processes (`node:child_process.spawn`) across strict process, pipe, and filesystem boundaries.
   - Governed by their respective open-source licenses (GPL, LGPL, MPL, and unRAR terms).

---

## 2. LGPL and GPL External Tools as Separate Executables

Certain format conversions require specialized external command-line utilities. These tools run strictly as separate executables:

### 2.1 FFmpeg (LGPL 2.1+ / GPL 2.0+)
- **Role**: Media transcoding, container multiplexing/demultiplexing, and audio/video stream filtering.
- **Process Isolation**: EasyConvert executes `ffmpeg` via standard subprocess invocation. No FFmpeg static or dynamic libraries (`libavcodec`, `libavformat`, etc.) are linked into the Node.js binary address space. Communication occurs exclusively through standard streams (stdin/stdout) or temporary scratch files.
- **Compliance**: Invoking FFmpeg as an independent subprocess adheres to the "mere aggregation" and process boundary standards under LGPL and GPL, ensuring that EasyConvert's application codebase remains independent and unencumbered by copyleft reciprocal terms.

### 2.2 Poppler Utilities (`pdftoppm`, `pdfinfo`) (GPL 2.0+)
- **Role**: High-fidelity PDF page rendering and metadata inspection.
- **Process Isolation**: The Poppler tools are executed as standalone CLI binaries. EasyConvert does not link against `libpoppler` directly. Data exchange is performed via filesystem artifacts.

### 2.3 veraPDF (GPL 3.0+ / MPL 2.0 Dual License)
- **Role**: Official PDF/A validation oracle to guarantee ISO 19005 conformance.
- **Process Isolation**: veraPDF runs as an independent Java CLI application (`/opt/verapdf/verapdf`) inside the worker container. Execution output is parsed via standard XML/CLI stdout reporting.

### 2.4 LibreOffice (MPL 2.0)
- **Role**: Headless conversion for legacy and complex office documents (`.doc`, `.xls`, `.ppt`, `.odt`, `.ods`, `.odp`).
- **Process Isolation**: Invoked headlessly as an isolated system process (`soffice --headless --convert-to ...`).

---

## 3. LGPL Relinking & On-Premises Container Images

Under the terms of the GNU Lesser General Public License (LGPLv3, Section 4), when distributing a work that uses an LGPL library in binary form (such as an on-premises container image), users must be provided with:
1. Suitable notice that the library is used and that the LGPL applies.
2. A copy of the LGPL and third-party notices.
3. The ability to relink or replace the LGPL library with a modified version.

### Prebuilt Binary Libraries (`sharp` / `libvips`)
- The `sharp` image-processing package dynamically loads prebuilt `libvips` shared libraries (`@img/sharp-libvips-*`), which are licensed under LGPL-3.0-or-later.
- **Relinking / Replacement Mechanism**:
  - The shared libraries reside in standard directories within `node_modules/@img/sharp-libvips-<arch>/lib/`.
  - Users may replace the dynamic `.so` / `.dylib` files with their own custom-built versions of `libvips` without recompiling or modifying EasyConvert source code.
  - Alternatively, `sharp` can be compiled against a system-installed `libvips` by setting `SHARP_IGNORE_GLOBAL_LIBVIPS=0` during container build.

### Copyright Notices Inside the Worker Container
- The worker Docker image (`Dockerfile.worker`) preserves all Debian package copyright and license texts at `/licenses/`:
  - `/licenses/*.copyright` contains upstream notices for `ffmpeg`, `poppler-utils`, `libreoffice`, `tesseract-ocr`, `qpdf`, `libraw`, and `p7zip`.
  - `/licenses/THIRD_PARTY_NOTICES.md` contains the complete production npm package notices.

---

## 4. unRAR Component Restrictions (p7zip-rar / 7-Zip)

EasyConvert provides archive extraction for RAR archives through `p7zip-rar` (or upstream 7-Zip with unRAR plugin).

### The unRAR License
The unRAR decompression algorithm and source code are copyrighted by Alexander Roshal and subject to specific non-free license conditions:
- **Decompression**: Free to use for extracting and decompressing RAR archives.
- **Algorithm Recreation Prohibition**: The license explicitly prohibits using the unRAR source code to recreate or reverse-engineer the RAR compression algorithm.
- **Debian Status**: Because of this restriction, `p7zip-rar` is categorized under Debian's `non-free` repository component.

### EasyConvert Operating Policy
- EasyConvert utilizes unRAR **strictly for decompression and archive inspection**.
- EasyConvert **never creates RAR archives** and does not provide RAR compression capabilities. All archive compression targets standard, unencumbered formats (ZIP, TAR, GZ, BZ2, 7Z, ZSTD).

---

## 5. Codec Patents (Open Items for Legal Counsel)

Certain multimedia compression and container formats are subject to patent pools managed by licensing administrators (e.g., MPEG LA, Via Licensing Alliance, Velos Media):

| Codec / Format | Patent Licensing Pool | Notes / EasyConvert Usage |
| :--- | :--- | :--- |
| **H.264 / AVC** | MPEG LA / Via LA | Video encoding and decoding via external FFmpeg or pure in-memory baseline NAL stream. |
| **H.265 / HEVC** | MPEG LA / Access Advance / Velos Media | High-efficiency video decoding via external FFmpeg. |
| **AAC** | Via Licensing Alliance | Audio encoding/decoding for MP4 containers via FFmpeg. |
| **MP3** | Expired (worldwide patents lapsed ~2017) | Free for commercial and private use without patent royalties. |
| **HEIC / HEIF** | Access Advance / Via LA | Image container wrapping HEVC/AV1 bitstreams. |

### Enterprise & Commercial Deployment Note
The inclusion of software supporting these formats does not constitute a patent grant or indemnity. Organizations distributing EasyConvert binaries, hosting commercial conversion SaaS instances, or embedding it into commercial hardware should consult legal counsel regarding applicable patent pool licensing requirements in their operational jurisdictions.

---

## 6. Dependency License Governance in CI

EasyConvert enforces strict automated license gating in continuous integration:
- **Policy File**: [`licenses.allow.json`](../licenses.allow.json) defines approved open-source licenses and vetted package exceptions.
- **Prohibited Licenses**: Reciprocal network copyleft licenses (AGPL) and non-commercial/source-available restrictions are strictly rejected.
- **Audit Script**: `scripts/third-party-notices.mjs` verifies that every production dependency is permitted and that [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) reflects the exact installed dependency graph.
