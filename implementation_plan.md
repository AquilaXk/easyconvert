# Master Implementation Plan: Next-Generation Enterprise Conversion Architecture & Hardening

## Overview
Remediate newly uncovered critical gaps and architectural deficiencies in `AquilaXk/easyconvert` against commercial enterprise conversion service standards and international specifications (ISO 32000-1, RFC 8878, RFC 9842, Adobe DNG 1.6, W3C WebCodecs). Enforce strict zero-leak quota accounting, zero test cheating, authentic distributed queue decoupling, true watertight B-Rep tessellation, and zero-trust container security with 100% Fail-Closed integrity.

---

## Phase Breakdown

### Phase 1: Distributed BullMQ Queue Decoupling & Container Airgap Remediation (P0)
- **True Distributed BullMQ Engine**: In [`src/lib/queue/bullmq-engine.ts`](file:///Volumes/MACSSD/Projects/GitProjects/easyconvert/src/lib/queue/bullmq-engine.ts), eliminate in-memory `memoryFallback` delegation when `REDIS_URL` is configured; connect authentic Redis Stream/Hash queue.
- **Producer / Consumer Lifecycle Decoupling**: In [`src/lib/queue/conversion-queue.ts`](file:///Volumes/MACSSD/Projects/GitProjects/easyconvert/src/lib/queue/conversion-queue.ts), eliminate unconditional module-level `conversionWorker` spawning in Next.js web API routes; isolate consumer worker to dedicated backend daemon environment.
- **Worker Lifecycle Integration**: In [`src/worker/index.ts`](file:///Volumes/MACSSD/Projects/GitProjects/easyconvert/src/worker/index.ts), unify job completion/failure lifecycle with `redisKeyStore.commitQuota / rollbackQuota` and `webhookDispatcher.dispatch` to prevent split-brain quota leaks and missed webhooks.
- **Container Airgap Architecture Fix**: In [`docker-compose.yml`](file:///Volumes/MACSSD/Projects/GitProjects/easyconvert/docker-compose.yml), remove container-wide `seccomp:./docker/seccomp-airgap.json` that breaks Redis TCP socket connections. Enable `cap_add: [SYS_ADMIN]` or child-process seccomp injection so that [`src/lib/security/process-sandbox.ts`](file:///Volumes/MACSSD/Projects/GitProjects/easyconvert/src/lib/security/process-sandbox.ts) can actually create `unshare -n` network namespaces without silent fallback to unsandboxed execution.

### Phase 2: Domain Engine Spec Parity & Defect Remediation (P0 / P1)
- **Office vMerge & DrawingML Crop**: In [`src/lib/conversions/office.ts`](file:///Volumes/MACSSD/Projects/GitProjects/easyconvert/src/lib/conversions/office.ts), implement vertical table cell merging (`w:vMerge w:val="restart"` / `w:vMerge`) in `parseSingleDocxTable` and inherit table styles from `word/styles.xml`. Parse `<a:srcRect>` in `<p:pic>` to apply authentic image cropping.
- **Camera RAW DNG Tag Collision Fix**: In [`src/lib/conversions/image.ts`](file:///Volumes/MACSSD/Projects/GitProjects/easyconvert/src/lib/conversions/image.ts), separate DNG tags 50738 (`ForwardMatrix1`) and 50739 (`ForwardMatrix2`) from `blackLevel` and `whiteLevel` case blocks; map to dedicated 3x3 Forward Matrix fields. Parse `ActiveArea` (50710), `DefaultCropOrigin` (50719), and `DefaultCropSize` (50720) to crop optical black sensor borders.
- **3D CAD Red-Green Watertight Tessellation**: In [`src/lib/conversions/cad-nurbs.ts`](file:///Volumes/MACSSD/Projects/GitProjects/easyconvert/src/lib/conversions/cad-nurbs.ts), replace naive 1:4 midpoint subdivision with Red-Green conforming refinement (Rivara longest-edge bisection) to mathematically eliminate T-junctions (hanging nodes). Add tolerance-based ($\epsilon = 10^{-5}\text{m}$) boundary vertex sewing across adjacent B-Rep trimmed faces.
- **Archive Password Schema & WebCrypto ZIP**: In [`src/lib/registry.ts`](file:///Volumes/MACSSD/Projects/GitProjects/easyconvert/src/lib/registry.ts), expose `password: true` in `optionsSchema` for archive formats. Add pure TS PKZIP AES-256 decryption in [`src/lib/conversions/archive.ts`](file:///Volumes/MACSSD/Projects/GitProjects/easyconvert/src/lib/conversions/archive.ts).

### Phase 3: Developer API Enterprise Hardening & DX (P1)
- **Trusted Proxy IP Spoofing Defense**: In [`src/lib/api-keys/ip-utils.ts`](file:///Volumes/MACSSD/Projects/GitProjects/easyconvert/src/lib/api-keys/ip-utils.ts), validate incoming request proxy hops against `TRUSTED_PROXIES` CIDR ranges; reject unverified `cf-connecting-ip` / `x-forwarded-for` header spoofing for API key IP whitelists.
- **Sliding-Window Burst Rate Limiter**: In [`src/lib/api-keys/redis-key-store.ts`](file:///Volumes/MACSSD/Projects/GitProjects/easyconvert/src/lib/api-keys/redis-key-store.ts), implement an atomic Lua sliding-window token bucket (e.g. 20 RPS / 300 RPM) to protect backend workers against burst request exhaustion.
- **Webhook Subscriptions & Secret Rolling**: In [`src/lib/api-keys/webhook-dispatcher.ts`](file:///Volumes/MACSSD/Projects/GitProjects/easyconvert/src/lib/api-keys/webhook-dispatcher.ts), support event filtering (`subscribedEvents`), dual-secret rolling (Active/Retiring), and persistent Redis retry scheduling.
- **OpenAPI 3.1 & SDK Generation**: Provide `/api/v1/openapi.json` route and generate TypeScript/Python SDK client definitions.

### Phase 4: Testnet & Anti-Cheating Differential Oracle Hardening (P0)
- **Eliminate Hollow CJK OCR Assertions**: In [`tests/skeptical-audit.test.ts`](file:///Volumes/MACSSD/Projects/GitProjects/easyconvert/tests/skeptical-audit.test.ts), replace `expect(result.confidence).toBeGreaterThanOrEqual(0.9)` with actual Korean substring assertions (`expect(result.text).toContain('한글')`). Eliminate fake `"DE"` fallback passes in [`src/lib/conversions/ocr.ts`](file:///Volumes/MACSSD/Projects/GitProjects/easyconvert/src/lib/conversions/ocr.ts).
- **Enforce `ORACLE_STRICT_MODE=1`**: In [`tests/helpers/differential-oracle.ts`](file:///Volumes/MACSSD/Projects/GitProjects/easyconvert/tests/helpers/differential-oracle.ts), throw explicit configuration errors or trigger explicit `test.skip()` when external CLI tools are missing in strict CI runs, preventing silent green passes.

### Phase 5: High-Performance Algorithmic Upgrades (P2)
- **WebGPU WGSL AMaZE/AHD Demosaicing**: Implement WGSL 2D compute shader kernels (`@workgroup_size(16, 16)`) in `src/lib/edge/shaders/` to accelerate 24MP Bayer CFA demosaicing from 4.5s (single-thread CPU) down to 10~15ms on WebGPU hardware.
- **RFC 8878 Zstandard Streaming Dictionary Pipeline**: Complete chunked streaming dictionary compression for high-volume enterprise office/JSON/CSV payload streams.
- **Remote Multi-Volume Range VFS**: Design Range-Request VFS for extracting individual files from split multi-volume archives without downloading the entire spanned sequence.

---

## Verification & Review Gate
For each phase:
1. Create GitHub Issue via `gh issue create`.
2. Branch from `main` (`git checkout -b <branch>`).
3. Implement changes and add deterministic regression tests (Anti-Cheating strictly enforced).
4. Verify locally: `npm run lint`, `npm test`, `npm run build`.
5. Push branch, open PR via `gh pr create`.
6. Compile and submit code review via `aquila-review` skill (`~/.gemini/config/skills/aquila-review/SKILL.md`).
7. Obtain clean verification and trigger automerge.
