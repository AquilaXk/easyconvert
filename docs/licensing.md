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
- **Build**: The worker image runs FFmpeg 9.0.2, built in the `ffmpeg` stage of `Dockerfile.worker` by `scripts/install-ffmpeg.sh` from the release archive (`ffmpeg-9.0.2.tar.xz`, pinned by SHA-256; the release is also signed by the FFmpeg release key) and one patch to `libavcodec/libvorbisenc.c` (`scripts/ffmpeg-patches/libvorbis-whole-frames.patch`, pinned by SHA-256, entry 131 of `docs/policy-decisions.md`). It is configured with `--enable-gpl` because libx264 and libx265 are GPL-2.0-or-later, so the `ffmpeg` and `ffprobe` programs are GPL-2.0-or-later. Nothing is nonfree: the build has no `--enable-nonfree`, no `--enable-version3` and no libfdk-aac, and the install script fails the build if `-buildconf` names `--enable-nonfree`. The codec libraries (libx264, libx265, libvpx, SVT-AV1, dav1d, Opus, LAME, Vorbis, Theora, libwebp, SoX Resampler, zimg, libass) are the unmodified Debian packages, loaded as shared libraries by the FFmpeg process. The corresponding source is the archive named in `/licenses/ffmpeg.SOURCE` with the patch that file names, which the image keeps in `/usr/share/doc/ffmpeg/patches`; the licence text is `/licenses/ffmpeg.copyright`, and `/usr/share/doc/ffmpeg/buildconf.txt` in the image holds the exact configuration.
- **Process Isolation**: EasyConvert executes `ffmpeg` via standard subprocess invocation. No FFmpeg static or dynamic libraries (`libavcodec`, `libavformat`, etc.) are linked into the Node.js binary address space. Communication occurs exclusively through standard streams (stdin/stdout) or temporary scratch files.
- **Compliance**: Invoking FFmpeg as an independent subprocess adheres to the "mere aggregation" and process boundary standards under LGPL and GPL, ensuring that EasyConvert's application codebase remains independent and unencumbered by copyleft reciprocal terms.

### 2.2 Poppler Utilities (`pdftoppm`, `pdfinfo`) (GPL 2.0+)
- **Role**: High-fidelity PDF page rendering and metadata inspection.
- **Process Isolation**: The Poppler tools are executed as standalone CLI binaries. EasyConvert does not link against `libpoppler` directly. Data exchange is performed via filesystem artifacts.

### 2.3 veraPDF (GPL 3.0+ / MPL 2.0 Dual License)
- **Role**: Official PDF/A validation oracle to guarantee ISO 19005 conformance.
- **Process Isolation**: veraPDF runs as an independent Java CLI application (`/opt/verapdf/verapdf`) inside the worker container. Execution output is parsed via standard XML/CLI stdout reporting.

### 2.4 LibreOffice (MPL 2.0)
- **Role**: Headless conversion for legacy and complex office documents (`.doc`, `.xls`, `.ppt`, `.odt`, `.ods`, `.odp`), the importer of the formats no in-process reader covers (Works, WordPerfect, OpenOffice.org 1.x, Numbers, Publisher, and the Sony BBeB and Palm e-books), and the second reader of Word, Excel and PowerPoint files that the strict in-process readers refuse as malformed. The importers are the document-format libraries that the LibreOffice packages depend on (libwps, libwpd, libetonyek, libmspub, libe-book; each MPL 2.0, several also LGPL 2.1 or later); nothing is added to the worker image for them.
- **Process Isolation**: Invoked headlessly as an isolated system process (`soffice --headless --convert-to ...`).

### 2.5 Ghostscript (`gs`) (AGPL 3.0+)
- **Role**: Image downsampling and recompression for the PDF `optimize` profiles `web`, `print` and `max` (pdfwrite), and PostScript/EPS rendering (`ps2pdf`).
- **Process Isolation**: `gs` is the unmodified distribution package, executed as a separate process with `-dSAFER` and without network access. Nothing links `libgs` into the application, and the application code does not incorporate or modify Ghostscript source. Data is exchanged through files and standard streams.
- **Compliance**: Running an unmodified, separate AGPL executable keeps EasyConvert's own code outside the AGPL. A modified Ghostscript, or one linked into the application, would not be covered by this and needs a reviewed exception.
- **GhostXPS (`gxps`)**: Draws XPS and OpenXPS documents as PDF (entry 95 of `docs/policy-decisions.md`). It is part of GhostPDL, which has the same licence as Ghostscript, and is built from the unmodified upstream release archive (`scripts/install-ghostxps.sh`, pinned by SHA-256), executed as a separate process in the process sandbox with no network access and limits on time, memory and output size. Nothing links it into the application. The worker image carries the licence text (`/licenses/ghostxps.copyright`) and a `SOURCE` note (`/licenses/ghostxps.SOURCE`) that names the release archive and its SHA-256, so the corresponding source of the binary is the archive at the URL given there. The same compliance rule applies: a modified or linked build needs a reviewed exception.

### 2.6 LibreDWG `dwg2dxf` (GPL 3.0+)
- **Role**: Reads a DWG drawing and writes it as DXF, which the DXF path then draws as SVG, PDF or a raster image (DWG input).
- **Process Isolation**: `dwg2dxf` is built from the unmodified upstream release archive (`scripts/install-libredwg.sh`, pinned by SHA-256) as a statically linked program, and executed as a separate process in the process sandbox with no network access and limits on time, memory and output size. Nothing links `libredwg` into the application, and the application code does not incorporate or modify LibreDWG source. Data is exchanged through a scratch directory that is removed after each run.
- **Compliance**: Running an unmodified, separate GPL executable keeps EasyConvert's own code outside the GPL. The worker image carries the licence text (`/licenses/libredwg.copyright`) and a `SOURCE` note (`/licenses/libredwg.SOURCE`) that names the release archive and its SHA-256, so the corresponding source of the binary is the archive at the URL given there. A modified reader, or one linked into the application, would not be covered by this and needs a reviewed exception.

### 2.7 ImageMagick, OpenJPEG, libheif and libde265 (ImageMagick License, BSD-2-Clause, LGPL 3.0)
- **Role**: Decode the pictures the image library cannot read: PSD, XCF, TGA, PCX, DDS, PNM, HEIC, HEIF and old-style JPEG TIFF (ImageMagick, with libheif and its libde265 HEVC module for HEIC and HEIF), and JPEG 2000 (OpenJPEG `opj_decompress`). The result is a lossless PNG that the image pipeline converts.
- **Process Isolation**: The Debian packages are unmodified and run as separate processes in the process sandbox, with no network and with limits on time, memory and output size. Nothing links them into the application. The ImageMagick License is a permissive, Apache-style licence; OpenJPEG is BSD-2-Clause; libheif and libde265 are LGPL 3.0 libraries loaded by the ImageMagick process, which the container's package notices cover (section 3).
- **Patents**: HEVC (the codec of HEIC) is patent-encumbered; the worker already decodes it for video (`ffmpeg`, section 2.1). The HEIC decoder is the distribution package libde265, not a build of ours.

### 2.8 Open CASCADE and `cad-convert` (LGPL 2.1 with the Open CASCADE exception)
- **Role**: Reads STEP and IGES files and writes STEP, IGES, STL and OBJ from the boundary representation (STEP and IGES input and output).
- **Process Isolation**: `cad-convert` (`native/cad-convert`, about 680 lines of our own C++; it reads STEP and IGES, writes STEP, IGES, STL and OBJ with its MTL, and writes IGES from a triangle mesh) is built in the worker image and in CI against the unmodified Debian and Ubuntu Open CASCADE libraries, linked to them dynamically, and executed as a separate process in the process sandbox with no network access and limits on time, memory and output size. Nothing of Open CASCADE is bundled into the application, and none of its source is modified.
- **Compliance**: The libraries are replaceable shared objects of the distribution, so the LGPL relinking requirement is met by the package manager (section 3); the image carries the package notices in `/licenses/libocct-*.copyright`. The test oracle `occt-import-js` (a WebAssembly build of the same kernel, LGPL 2.1) is a development dependency of the test suite only and is not part of any image or build output.

### 2.9 FontForge (GPL-3.0-or-later)
- **Role**: Reads PostScript Type 1 fonts (PFA and PFB) and writes them as OpenType fonts with CFF outlines, which the in-process font engine then converts to every target (PostScript Type 1 input).
- **Process Isolation**: `fontforge` (the Debian and Ubuntu package `fontforge-nox`, without its graphical interface) is installed unmodified, started with a fixed script (`Open($1); Generate($2)`) and the font and result as file arguments, and executed as a separate process in the process sandbox with no network access and limits on time, memory and output size. Nothing links FontForge into the application, and none of its source is modified or incorporated. Data is exchanged through a scratch directory that is removed after each run.
- **Compliance**: Running an unmodified, separate GPL executable keeps EasyConvert's own code outside the GPL. The image carries the package notices in `/licenses/fontforge-*.copyright` (section 3), and the source of the installed version is the distribution's source package, named by the version in `/licenses/tool-versions.txt`. A modified FontForge, or one linked into the application, would not be covered by this and needs a reviewed exception.

### 2.10 lbzip2 (GPL-3.0-or-later)
- **Role**: Writes the bzip2 stream of a `tar.bz2`, `tbz2` or `tbz` target when the tar is at most two bzip2 blocks long (1.8 MB at the default level); larger tarballs are written by 7-Zip.
- **Process Isolation**: `lbzip2` (the Debian and Ubuntu package `lbzip2`) is installed unmodified and executed as a separate process in the process sandbox with no network access and limits on time and output size, with the tar on standard input and the bzip2 stream on standard output. Nothing links lbzip2 into the application, and the application code does not incorporate or modify lbzip2 source. When the command is missing or fails, the 7-Zip route writes the same format.
- **Compliance**: Running an unmodified, separate GPL executable keeps EasyConvert's own code outside the GPL. The image carries the package notice in `/licenses/lbzip2.copyright` (section 3), and the source of the installed version is the distribution's source package, named by the version in `/licenses/tool-versions.txt`. A modified lbzip2, or one linked into the application, would not be covered by this and needs a reviewed exception.

### 2.11 qpdf and `qpdf-runner` (Apache-2.0)
- **Role**: Runs the qpdf jobs of the PDF operations (split, extract, delete, reorder, rotate, protect, unlock, decrypt for the readers, the lossless compression and the repair of a page tree).
- **Process Isolation**: `qpdf-runner` (`native/qpdf-runner`, about 900 lines of our own C) is built in the worker image and in CI with a C compiler only, and opens the unmodified `libqpdf` of the distribution package `qpdf` at run time with `dlopen`; nothing of qpdf is compiled or linked into it. It runs each job in a forked child, with a user and network namespace of its own, the resource limits and the time and output limits of the request, as the `qpdf` program ran under the process sandbox. The child calls `qpdfjob_run_from_argv`, the public C entry point of the command line, with the same arguments, so the result is the program's. When the runner is missing, or declines or cannot isolate a job, the `qpdf` program runs it as before.
- **Compliance**: qpdf is Apache-2.0 (since version 11), a permissive licence: use through the public API needs only the notice, which the image carries in `/licenses/qpdf.copyright` (section 3). The runner is our own code; the library is a replaceable shared object of the distribution.

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

### WebAssembly Picture Decoders of `pdfjs-dist` (BSD-3-Clause and Apache-2.0, BSD-2-Clause)
- **Role**: The PDF text reader gives pdf.js the `wasm` folder of the `pdfjs-dist` package, so it decodes the CCITT fax and JBIG2 pictures (`jbig2.wasm`, the PDFium JBIG2 and fax decoders) and the JPEG 2000 pictures (`openjpeg.wasm`, OpenJPEG) of a PDF for its HTML, Markdown and Word results (entry 101 of `docs/policy-decisions.md`). The `*_nowasm_fallback.js` files are the same decoders compiled to JavaScript, which pdf.js loads only when WebAssembly cannot start. The folder also holds `qcms_bg.wasm` (qcms, MIT), which pdf.js does not use in Node.js because the reader leaves `useWorkerFetch` off, and `quickjs-eval` (MIT), which only the scripting sandbox build loads.
- **Process Isolation**: The modules are part of the published `pdfjs-dist` package, unmodified, and run inside the text reader's worker thread under its deadline. Nothing is compiled for them: `npm prune --omit=dev` keeps the package and `Dockerfile.worker` copies `node_modules` as it is.
- **Compliance**: Every licence is permissive. The licence texts ship next to the modules, in `/app/node_modules/pdfjs-dist/wasm/` of the worker image, and `Dockerfile.worker` also copies them into `/licenses/pdfjs-dist-wasm/` with the other notices: `LICENSE_JBIG2` (PDFium, BSD-3-Clause, with the Apache-2.0 text of its Foxit code), `LICENSE_PDFJS_JBIG2` (the pdf.js wrapper, Apache-2.0), `LICENSE_OPENJPEG` (BSD-2-Clause), `LICENSE_PDFJS_OPENJPEG` (the pdf.js wrapper, BSD-2-Clause), `LICENSE_QCMS` and `LICENSE_PDFJS_QCMS` (MIT). `THIRD_PARTY_NOTICES.md` embeds only the licence files at a package's root (section 6.2), so it carries the `pdfjs-dist` Apache-2.0 text and not these; `tests/third-party-notices.test.ts` checks the copy.

### Copyright Notices Inside the Worker Container
- The worker Docker image (`Dockerfile.worker`) preserves all Debian package copyright and license texts at `/licenses/`:
  - `/licenses/*.copyright` contains upstream notices for `ffmpeg`, `poppler-utils`, `libreoffice`, `tesseract-ocr`, `qpdf`, `libraw`, `libavif` (the `avifenc` AVIF encoder), `imagemagick`, `libheif`, `libde265`, `openjpeg` (picture decoders), `p7zip`, `libocct-*` (the Open CASCADE libraries behind STEP and IGES), `libdeflate-tools` (the `libdeflate-gzip` deflate encoder for ZIP and gzip payloads past 4 MiB, MIT, run as a separate sandboxed process), `lbzip2` (the bzip2 encoder for tar.bz2 targets of up to two blocks, GPL-3.0-or-later, run as a separate sandboxed process), `xz-utils` (the `xz` encoder and decoder for .xz files, 0BSD, run as a separate sandboxed process), `libredwg` (the DWG reader, with `/licenses/libredwg.SOURCE` naming the release archive it was built from), and `ghostxps` (the XPS renderer, with `/licenses/ghostxps.SOURCE` naming the release archive it was built from).
  - `/licenses/THIRD_PARTY_NOTICES.md` contains the complete production npm package notices.
  - `/licenses/tool-versions.txt` lists the version of every Debian package in the image and of the Node.js runtime. The image is built on Debian 13 (trixie) with Node.js 24 LTS (see the policy decision "Base image and Node.js LTS").

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

## 6. Dependency Licence Governance in CI

`npm run licenses:check` runs in the `checks` job of `.github/workflows/ci.yml`. It reads only `package-lock.json`, `licenses.allow.json` and the installed `node_modules`, needs no network, and takes a few seconds. `npm run licenses:generate` rewrites the notices file; commit the result together with any lockfile change.

### 6.1 What is checked

- **Package set**: every entry of `package-lock.json` (lockfileVersion 3) except the root and entries marked `dev: true`. The name is the path after the last `node_modules/` (scopes kept); version and licence come from the lockfile entry. The installed tree and `npm ls` are never consulted for the set, so the result is the same on every host and platform. Optional platform packages (`@img/sharp-*`, `@napi-rs/canvas-*`, `@next/swc-*`) are included.
- **Licence policy**: the lockfile licence is evaluated as an SPDX expression against `allowed` in [`licenses.allow.json`](../licenses.allow.json). `A OR B` passes when any branch is allowed; `A AND B` only when every part is allowed; `AND` binds tighter than `OR`; `X WITH Y` passes only when that exact pair is listed. A missing, unparseable or disallowed licence fails the run. Nothing is guessed from licence file text.
- **Exceptions**: `exceptions` is keyed by the exact `name@version` and each needs a non-empty `reason`. When the lockfile has no licence, the exception must name it with `license`; when both are present they must agree. A version bump drops the exception, so the package fails until it is reviewed again. An exception whose `name@version` is not a production package of the lockfile is stale and fails the check.
- **Drift**: the generated file is compared byte for byte with the committed [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md). A difference exits 1 and lists the added, removed and changed packages.
- **Exit codes**: 0 ok, 1 policy failure or drift, 2 malformed input (a typed error such as `LockfileError`, `AllowlistError` or `InstallError`).

### 6.2 Licence text inclusion rule

The notices file must not change with the host that generates it, so text inclusion depends only on the lockfile:

- **Non-optional packages** (no `optional` flag in the lockfile): the file lists name, version, licence, source tarball URL and repository, followed by the full text of every `LICENSE`, `LICENCE`, `COPYING` and `NOTICE` file (including variants such as `LICENSE-MIT`) found in `node_modules/<path>`. Every host installs these with identical contents. A non-optional package that is not installed, or installed at another version, is an error rather than a silent omission. A package that ships no such file is listed with a note saying so.
- **Optional packages** (platform binaries, installed only on matching hosts): listed with name, version, licence and source tarball URL, plus a note that the licence text ships in the package. Their text is not embedded, because whether it is on disk depends on the host. In the worker image the installed copy stays in `node_modules/<path>`, together with the notices of the native libraries it bundles.

### 6.3 Why LGPL-3.0 is allowed

`LGPL-3.0` (which also matches `LGPL-3.0-only` and `LGPL-3.0-or-later`) is on the allowlist only because of the prebuilt `libvips` binaries (`@img/sharp-libvips-*`). `sharp` loads them dynamically as shared libraries that the user can replace (see section 3). Do not use the entry to admit a package that is statically linked or bundled into application code; such a package needs a reviewed exception instead. Strong network copyleft (AGPL) and non-commercial licences are never allowed as npm dependencies or as code linked or bundled into the application; AGPL is accepted only for an unmodified, separate command-line executable run as its own process (section 2.5) or a test oracle.
