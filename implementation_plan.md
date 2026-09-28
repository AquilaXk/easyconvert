# Master Implementation Plan: Enterprise Conversion Pipeline Hardening (Phases 1 - 6)

## Overview
Remediate baseline P0 and P1 audit findings across storage, media, archives, office documents, 3D CAD, camera RAW, OCR, differential testnets, distributed auth, and worker container sandboxes in `AquilaXk/easyconvert`. Strictly conform to commercial enterprise conversion standards and international specifications (ISO 32000-1, RFC 8878, RFC 1952, etc.) with 100% Fail-Closed enforcement, zero test cheating, and zero production backdoors.

---

## Phase Breakdown

### Phase 1: Storage Architecture & Streaming Unification (P0)
- **Unified SSOT Storage Provider**: Unify `s3Storage` and `ociStorage` into a single SSOT storage provider interface across `src/lib/storage/index.ts`, `src/app/api/v1/jobs/route.ts`, and `src/worker/index.ts`. Eliminate "OCI Object not found" runtime exceptions by sharing in-memory/disk object state.
- **Zero-Heap Quota & File Storage**: Eliminate full Base64 Data URI serialization into `.easyconvert/user-files.json` in `src/app/api/v1/convert/route.ts` and `src/lib/api-keys/key-store.ts`. Store lightweight file download URLs backed by the unified storage engine.
- **Streaming Pipeline Integration**: Connect streaming pipeline in production API and workers for bounded memory consumption.

### Phase 2: Media & Archive Fail-Closed & Spec Parity (P0)
- **Media Fail-Closed**: Remove `options.allowPureLossyBitstream` test backdoor from `src/lib/conversions/media.ts`. Enforce Fail-Closed for pure MP3 when native FFmpeg is unavailable.
- **Even Video Dimensions**: Fix odd video dimensions breaking H.264 encoders in `src/lib/conversions/media-ffmpeg-args.ts` by ensuring even dimensions (`scale=trunc(iw/2)*2:trunc(ih/2)*2`) for video codecs.
- **Archive Fail-Closed**: Fix corrupt archive fail-open swallowing in `src/lib/conversions/archive.ts` (throw explicit errors on corrupt archives instead of returning empty file lists and wrapping broken payloads).
- **Zstandard RFC 8878 Compliance**: Conform strictly to RFC 8878 Zstandard specifications in `src/lib/conversions/zstd-dict.ts` without proprietary token escapes.
- **LZMA 0-Byte Compliance**: Fix 0-byte LZMA output in `src/lib/conversions/lzma-encoder.ts`.

### Phase 3: Office & Document CJK Mojibake & Legacy BIFF8 XLS (P0 / P1)
- **Office CJK Rendering**: Resolve silent CJK Mojibake in `src/lib/conversions/office.ts` PDFKit paths by registering authentic CJK Unicode fonts or delegating CJK documents to headless native LibreOffice worker.
- **Authentic BIFF8 XLS**: Eliminate synthetic fallback rows `['Data'], ['XLS spreadsheet content']` in BIFF8 XLS conversions. Parse authentic BIFF8 records or delegate to headless LibreOffice worker, failing closed on corrupt inputs.
- **Compliant OpenXPS Container**: Complete OpenXPS container structure (`[Content_Types].xml`, `FixedDocumentSequence.fdseq`, `FixedDocument.fdoc`, page visual canvas).

### Phase 4: 3D CAD, Camera RAW & OCR Parity (P1)
- **Authentic CAD Triangulation**: In `src/lib/conversions/cad-nurbs.ts`, eliminate arbitrary `+0.1` coordinate shifts and dummy normals `[0, 0, 1]`. Replace sequential point-soup grouping in `buildTrianglesFromPoints` with authentic Delaunay surface reconstruction.
- **Multi-Strip & Tiled RAW Sensor**: In `src/lib/conversions/image.ts`, handle multi-strip TIFF/DNG sensor data without truncating to strip 0; support tiled DNG sensor images; decode 8-bit indexed BMP palettes authentically.
- **Type 0 CIDFont & OCR**: Eliminate fake ONNX CJK facade in `src/lib/conversions/ocr.ts`. Embed proper `/FontFile2` TrueType stream in `src/lib/conversions/ocr-pdf-combiner.ts` for Type 0 CIDFont per ISO 32000-1.

### Phase 5: Testnet & Differential Oracle Integrity (P0)
- **Differential Oracle Fail-Closed**: In `tests/helpers/differential-oracle.ts`, eliminate silent pass bypass returning `matched: true` on invalid buffers when external tools are absent by enforcing `assertFormatIntegrity`.
- **Anti-Cheat Guard Fortification**: Fortify `scripts/guard-anti-cheat.ts` against tautological self-assertions (`expect(x).toBe(x)`), meaningless constants, and hollow bypasses.

### Phase 6: Distributed Auth & Worker Sandbox Hardening (P0)
- **Authentic Redis Integration**: Integrate authentic `ioredis` client into `RedisUserStore` and `RedisKeyStore` with atomic Lua scripts and seamless in-memory fallback.
- **Singleton Unification**: Eliminate decoupled singleton disk overwrites between `keyStore` and `redisKeyStore`.
- **Worker Sandbox Hardening**: Enforce per-job ephemeral isolated temporary directories with `0o700` permissions, isolated environment variables, and automatic teardown.

---

## Verification & Review Gate
For each phase:
1. Create GitHub Issue via `gh issue create`.
2. Branch from `main` (`git checkout -b <branch>`).
3. Implement changes and add deterministic tests.
4. Verify locally: `npm run guard:anti-cheat`, `npm run lint`, `npm test`, `npm run build`.
5. Push branch, open PR via `gh pr create`.
6. Compile and submit code review via `aquila-review` skill.
7. Merge PR into `main` with squash merge and branch deletion.
