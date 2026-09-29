# Implementation Plan: Adversarial Audit Gap Remediation

## Overview
Remediate the 5 critical and high-priority gaps identified in the adversarial audit of commits `acaf119` ~ `06dda3c` across domain conversion engines, security guards, and distributed data store clustering. Enforce strict Fail-Closed error handling, authentic standard specifications (ISO/IEC 29500, Adobe DNG 1.7.1.0, Redis Cluster RFC), clean modularity, and superior developer experience (DX).

---

## Phases

### Phase 1: Domain Conversions Fidelity & Spec Parity (Office & Camera RAW)
- **Word OpenXML PDF Nested Table Rendering** ([`src/lib/conversions/office.ts`](file:///Volumes/MACSSD/Projects/GitProjects/easyconvert/src/lib/conversions/office.ts)):
  - Enhance `DocxTableCell` interface to support `fullCellText?: string`.
  - In `parseSingleDocxTable`, store `fullCellText` on each `DocxTableCell` containing parent text and formatted nested table text (`row.join('\t')`).
  - Provide `getFullDocxCellText(cell: DocxTableCell): string` helper.
  - In `generatePdfFromDocx`, compute dynamic row height using `getFullDocxCellText(cell)` and render `getFullDocxCellText(cell)` instead of dropping nested tables.
- **Bayer Sensor Dynamic Range & Calibration Validation** ([`src/lib/conversions/image.ts`](file:///Volumes/MACSSD/Projects/GitProjects/easyconvert/src/lib/conversions/image.ts)):
  - Extract and enforce unified `validateBayerSensorCalibration` across `demosaicAhdBayerCfa` and `demosaicAmazeBayerCfa`.
  - Validate `whiteLevel > maxBLevel` and strict `blackLevel` array length/finiteness checks.
  - Fail closed consistently with descriptive errors on inverted dynamic range or malformed calibration arrays in production DNG decoding pipelines.
- **Adobe DNG 1.7.1.0 ColorMatrix1 Inversion & sRGB Mapping** ([`src/lib/conversions/image.ts`](file:///Volumes/MACSSD/Projects/GitProjects/easyconvert/src/lib/conversions/image.ts)):
  - Implement robust 3x3 matrix inversion `invert3x3(matrix)` via Gauss-Jordan elimination with row pivoting.
  - Implement 3x3 matrix multiplication `multiply3x3(a, b)`.
  - Define Bradford-adapted $M_{XYZ\_D50\_TO\_SRGB}$ matrix.
  - In `decodeRawBayerSensor`, correctly invert DNG Tag 50721 `ColorMatrix1` ($XYZ_{D50} \to Camera$) and map to sRGB: $M = M_{XYZ\_D50\_TO\_SRGB} \times (\text{ColorMatrix1})^{-1}$, passing $M$ as `colorMatrix` to demosaicing.
- **Verification**:
  - Deterministic tests in `tests/office-conversions.test.ts` verifying nested table content in generated PDF buffers.
  - Deterministic tests in `tests/camera-raw-ahd-amaze-separation.test.ts` verifying fail-closed validation on inverted dynamic range in `demosaicAmazeBayerCfa` and authentic DNG ColorMatrix1 inversion.

### Phase 2: Security Guards & Distributed Cluster Integrity (Spoofing & Redis Store)
- **Anti-Spoofing Fail-Closed Rejection of 0-Byte Payloads** ([`src/lib/registry.ts`](file:///Volumes/MACSSD/Projects/GitProjects/easyconvert/src/lib/registry.ts), [`src/lib/security/file-guard.ts`](file:///Volumes/MACSSD/Projects/GitProjects/easyconvert/src/lib/security/file-guard.ts)):
  - In `assertNotSpoofedFile`: reject empty or 0-byte buffers (`!buffer || buffer.length === 0`) with `FileExtensionSpoofError`.
  - In `assertNotSpoofedFilePath`: reject 0-byte files (`stat.size === 0`) with `FileExtensionSpoofError`.
  - Ensure zero silent pass bypass for empty payloads.
- **Redis User Store Cluster Slot Compatibility** ([`src/lib/auth/redis-user-store.ts`](file:///Volumes/MACSSD/Projects/GitProjects/easyconvert/src/lib/auth/redis-user-store.ts)):
  - Ensure `keyPrefix` defaults to `'easyconvert:{user}:'`.
  - In `RedisUserStore` constructor, enforce hash tag `{user}` on user-related key prefixes.
  - Ensure `KEYS[1]` (`emailIndexKey`) and `KEYS[2]` (`userKey`) in `CREATE_USER_LUA_SCRIPT` share `{user}` hash tag, guaranteeing Redis cluster slot parity and preventing `CROSSSLOT` failures.
- **Verification**:
  - Tests in `tests/phase-5-ocr-and-security.test.ts` and `tests/worker-native-engines-and-api-dx.test.ts` verifying 0-byte rejection.
  - Tests in `tests/phase-6-auth-sandbox.test.ts` verifying `{user}` hash tags in distributed Lua eval arguments.

---

## Standard 5-Step Delivery Pipeline per Phase
1. Create GitHub Issue via `gh issue create`.
2. Checkout new branch from `main` (`git checkout -b <branch> origin/main`).
3. Implement features, clean DX code, and deterministic tests (Zero Cheating).
4. Run full deterministic test gate: `npm run guard:anti-cheat && npm run lint && npm test && npm run build`.
5. Create PR via `gh pr create`, run `aquila-review` skill, post review payload comment, address feedback, and trigger automerge.
