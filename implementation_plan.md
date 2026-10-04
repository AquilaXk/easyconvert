# Implementation Plan: Next-Generation Advancement (Wave 7–13)

> Source of truth: [`docs/EXECUTION_PLAN_V3.md`](docs/EXECUTION_PLAN_V3.md). It holds the audit evidence, acceptance criteria, oracles and the decision register.
> This file lists the planned file changes for each Work Package (WP). One WP is one issue, one branch, and one PR. Security, infra and migration WPs ship alone.

## Wave 7 — Integrity regression recovery (blocks all later waves)

| WP | Branch | Files to change | New or changed tests |
|---|---|---|---|
| WP-70 | `fix/graph-redis-execution-path` | `src/lib/queue/graph/{scheduler,redis-scheduler,lua-scripts,node-executor,validate-graph,types}.ts`, `src/lib/queue/bullmq-engine.ts` (export prefix/queue constants), `src/lib/queue/resource-class.ts`, `src/app/api/v1/jobs/route.ts` → move logic into new `src/lib/jobs/submit-job.ts`, `src/lib/jobs/graph.ts` (types re-export only), delete `src/lib/jobs/graph-executor.ts` after moving helpers to new `src/lib/queue/graph/artifacts.ts`, `src/lib/types.ts` | new `tests/job-graph-redis-e2e.test.ts`; update `tests/job-graph-redis.test.ts`, `tests/job-graph-validation.test.ts`, `tests/graph-scheduler.test.ts` |
| WP-71 | `fix/media-audio-probe-and-10bit` | `src/lib/conversions/media-ffmpeg-args.ts`, `src/lib/conversions/media.ts` | `tests/media-hls-dash-packaging.test.ts` (real ffprobe audio stream count), new `tests/media-downmix-and-main10.test.ts` |
| WP-72 | `fix/pdfa-fail-open-and-registry-parity` | `src/lib/conversions/pdf-postprocess/pdfa.ts`, `src/lib/registry.ts` (withdraw raw→dng and epub→mobi/azw3/rtf/lrf/oeb/pdb), `src/lib/conversions/office.ts` (EPUB identifier/lang only) | new `tests/registry-engine-conformance.test.ts`; update `tests/pdf-watermark-protect-pdfa.test.ts`, `tests/registry.test.ts` |
| WP-73 | `fix/hwp5-record-parsing` | `src/lib/conversions/hwp.ts` | `tests/hwp.test.ts` rewritten against the external golden set in `tests/fixtures/golden/document/hwp/` (D-14) |
| WP-74 | `fix/edge-ocr-fail-open` | `src/lib/edge-ocr/index.ts`, `src/lib/edge/pipelines/fallback-pipeline.ts`, delete `public/workers/edge-ocr.worker.js` | new `tests/e2e/edge-ocr-fallback.spec.ts` (Playwright) |
| WP-75 | `test/oracle-self-comparison-and-ratchet` | `tests/oracles/product/product-differential-oracles.test.ts`, `tests/phase-4-vrt-visual-regression.test.ts`, `tests/helpers/vrt-engine.ts`, `tests/helpers/mutation-sensitivity.ts`, `tests/phase-4-adversarial-fuzzing.test.ts`, `scripts/anti-cheat-baseline.json`, `.github/workflows/ci.yml` (strict `test:redis`), `.github/workflows/soak-test.yml` (toolset parity) | the edited suites themselves |
| WP-76 | `chore/governance-cleanup` | delete `scripts/inspect-*.mjs` and `scripts/subpages-inspection-result.json`; add the `node:` prefix in `src/lib/conversions/{hwp,vector-cad,zstd,font}.ts` and the remaining files; `scripts/guard-anti-cheat.ts` (rules G5 and G6) | `tests/guard-anti-cheat-rules.test.ts` |
| WP-77 | `fix/byos-s3-real-sigv4` (security) | `src/lib/storage/s3-compatible-storage.ts`, `src/lib/storage/adapters/s3.ts`, `src/lib/storage/sigv4-presigner.ts`, `src/lib/storage/credentials-vault.ts` (provider gate) | new `tests/byos-s3-sigv4-vectors.test.ts`, new `tests/byos-s3-local-server.test.ts` |
| WP-78 | `fix/sandbox-seccomp-and-gpu-queues` (infra) | `docker-compose.yml`, `Dockerfile.worker`, `docker/AIRGAP.md`, new `scripts/verify-worker-container.sh`, `.github/workflows/ci.yml` (container job) | output of the container verification script |

## Wave 8 — Ultra-scale orchestration

| WP | Main files |
|---|---|
| WP-80 | `src/lib/queue/graph/{types,validate-graph,lua-scripts,redis-scheduler,in-memory-scheduler,node-executor}.ts`, new `src/lib/queue/graph/map-reduce.ts`, new `src/lib/queue/graph/splitters/{pdf-pages,archive-entries,media-segments}.ts`, `src/lib/api/contracts/schemas.ts` |
| WP-81 | new `src/lib/queue/graph/checkpoint.ts`, new `src/lib/queue/graph/compensation.ts`, new `src/app/api/v1/jobs/[id]/resume/route.ts`, `src/lib/storage/tus-engine.ts`, `src/lib/storage/s3-storage.ts`, `src/worker/index.ts` |
| WP-82 | `src/lib/queue/bullmq-engine.ts` (tenant weighted pop), `src/lib/queue/resource-class.ts` |
| WP-83 | new `src/lib/streaming/stream-egress.ts`, `src/lib/streaming/large-payload-streamer.ts`, `src/worker/engines.ts`, `src/lib/registry.ts` (`streamableEgress`) |

## Wave 9 — Keyless BYOS (each WP is a security PR on its own)

| WP | Main files |
|---|---|
| WP-90 | new `src/lib/storage/identity/web-identity-sts.ts`, `src/lib/storage/adapters/s3.ts`, `src/lib/storage/credentials-vault.ts` |
| WP-91 | new `src/lib/storage/identity/{token-exchange,managed-identity}.ts`, `src/lib/storage/adapters/{gcs,azure-blob}.ts` |
| WP-92 | `src/lib/storage/credentials-vault.ts`, new `scripts/rotate-vault-kek.ts` |

## Wave 10 — Ultra-fidelity engines

| WP | Main files |
|---|---|
| WP-100–102 | `src/lib/conversions/pdf-postprocess/{pdfa,pdfua,pdfx}.ts` (pdfua and pdfx are new), `src/lib/conversions/office.ts` (PDF generation path only, extracted to new `src/lib/conversions/office/pdf-writer.ts`), `src/lib/conversions/ocr-pdf-combiner.ts`, `src/worker/libreoffice-pool.ts` |
| WP-103 | new `src/lib/conversions/epub/{reader,writer,fixed-layout}.ts`; remove the EPUB code from `office.ts` |
| WP-104 | new `src/lib/conversions/office/{omml-mathml,smartart,ole-fallback}.ts`, ODF writers in `office.ts` |
| WP-105 | `src/lib/conversions/hwpx.ts` (DOM parser), `src/lib/conversions/hwp.ts` |
| WP-110 | new `src/lib/conversions/media-hdr.ts`, new `src/lib/conversions/media-hdr-lut.ts`, `media-ffmpeg-args.ts` |
| WP-111 | `media-ffmpeg-args.ts`, new `src/lib/conversions/jpegxl.ts`, `src/worker/engines.ts` (capability probe), `src/lib/registry.ts` |
| WP-112 | `media-ffmpeg-args.ts` (audio copy, layouts, multi-track metadata, CMAF groups), `src/lib/types.ts` |
| WP-113 | new `src/worker/capabilities.ts`, `src/lib/queue/resource-class.ts`, `docker-compose.yml` (infra part split into its own PR) |
| WP-120–122 | new `src/lib/conversions/bim/ifc-reader.ts`, new `src/lib/conversions/3d/{gltf-writer,usdz-writer}.ts`, `src/lib/registry.ts` |
| WP-123–124 | `src/lib/conversions/cad-nurbs.ts` (tessellation extracted to new `src/lib/conversions/cad/edge-first-tessellation.ts`), new `src/lib/conversions/cad/hidden-line-projection.ts` |
| WP-130–133 | `src/lib/conversions/raw-hdr.ts`, `src/lib/conversions/image.ts`, new `src/lib/conversions/color/{aces,icc}.ts`, new `src/lib/conversions/raw/{wavelet-denoise,dng-writer}.ts` |
| WP-140–142 | new `src/lib/conversions/docai/{table-structure,formula-detect,semantic-chunker}.ts`, `src/lib/conversions/dla-engine.ts`, `src/lib/conversions/document.ts`, new `src/lib/api/contracts/chunk.schema.json` |

## Wave 11 — L0/L1 client edge

| WP | Main files |
|---|---|
| WP-150 (security) | `next.config.mjs` |
| WP-151 | `public/wasm/*` (version-pinned, SRI), `src/lib/edge/workers/wasm-engine.worker.ts`, new `src/lib/edge/pure/{svg-optimize,pdf-split-merge}.ts`, `src/lib/edge/tier-router.ts` |
| WP-152 | new `tests/e2e/edge-parity.spec.ts`, Playwright config |

## Wave 12 — Developer platform and FinOps

| WP | Main files |
|---|---|
| WP-160 | `scripts/generate-sdk.ts` (spec-driven), `sdk/{typescript,python,go,java,dotnet}/`, new `.github/workflows/sdk-release.yml` (infra PR) |
| WP-161 | new `src/app/api/v1/jobs/[id]/events/route.ts`, new `src/lib/queue/job-events.ts`, new `src/lib/conversions/ffmpeg-progress.ts` |
| WP-162 | new `proto/easyconvert/v1/events.proto`, `buf.yaml`, CI lint and breaking-change job |
| WP-163 (migration) | new `src/lib/tenancy/{organization,budget}.ts`, `src/lib/quota/*`, new `scripts/migrate-tenancy.ts`, new `src/lib/quota/ledger-export.ts` |
| WP-164 | `src/lib/quota/usage-ledger.ts` |

## Wave 13 — Chaos and differential verification network

| WP | Main files |
|---|---|
| WP-170 | new `docker-compose.chaos.yml`, new `tests/chaos/*.test.ts`, new `.github/workflows/nightly-chaos.yml` |
| WP-171 | `tests/oracles/product/*`, new `tests/fixtures/external-reference/manifest.json` (manifest only) |
| WP-172 | new `tests/fuzz/*`, `tests/fixtures/fuzz-regressions/` |
| WP-173 | `scripts/run-endurance-soak.ts` (real pipeline), `.github/workflows/soak-test.yml` |

## Per-WP delivery pipeline
1. Create an issue from the WP section of V3, quoting its acceptance criteria and oracles.
2. Branch from `origin/main` in an isolated worktree.
3. For bug fixes, commit a failing regression test first. Then implement.
4. Run `/verify` (guard → lint → tsc → targeted tests → full tests → build). For engine, test or security changes, also run `/pre-pr-review`.
5. Open a PR from the template. Resolve every review thread. Wait for `verify` and SonarCloud to pass, then add the `automerge` label. Merge by squash only.
