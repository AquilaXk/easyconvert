# EasyConvert — Project Instructions

Universal file conversion platform: Next.js 14 (App Router) + TypeScript, pure-TypeScript binary engines, BullMQ queue, S3/OCI multipart storage, and a containerized OCI worker. This file is read by Claude Code sessions and by the automated PR review, which flags violations of the rules below.

## Commands

- `npm run dev` — Next.js dev server
- `npm run lint` — ESLint (`next/core-web-vitals`); must report 0 errors
- `npm test` — runs `guard:anti-cheat` (pretest) then `vitest run`
- `npx vitest run tests/<file>.test.ts` — run a single test file (fast feedback loop)
- `npm run guard:anti-cheat` — static scan for circular mocking, silent passes, hollow assertions, production cheats
- `npm run build` — production build (also type-checks)
- `npm run worker` / `docker compose up` — local worker + Redis
- CI (`.github/workflows/ci.yml`) runs guard → lint → test (`ORACLE_STRICT_MODE=1`) → build, with ffmpeg, 7z, poppler, LibreOffice, ImageMagick, and Tesseract installed. Oracle tests that need those CLIs must `skip` explicitly when the tool is missing locally.

## Architecture boundaries

- `src/app/` — routes and thin API handlers only; no conversion logic
- `src/components/`, `src/hooks/` — React UI
- `src/lib/` — shared core: format registry (`registry.ts` is the SSOT for formats), `conversions/`, `security/`, `storage/`, `queue/`, `auth/`, `api-keys/`, `edge/`
- `src/worker/` — OCI container worker runtime, native engines, sandbox
- `tests/` — vitest suites; `tests/helpers/` holds independent oracles; `tests/fixtures/` holds golden corpus
- Path alias `@/*` → `src/*`. Keep format specs and sandbox core in their SSOT files; upper layers consume them through facades.

## Code rules

- Fail closed: malformed input, unsupported formats, and missing data throw a typed error (HTTP 400 at the API). No dummy output, no silent fallback.
- No nested ternaries; prefer explicit branches. No magic numbers without a named constant.
- Import Node built-ins with the `node:` prefix (`node:fs`, `node:path`, `node:os`).
- Use constant `Set`s for membership lookups on hot paths.
- Keep local development cloud-free: preserve in-memory / mock adapters for Redis, S3/OCI, and queues.
- Keep changes bounded to the task; no speculative abstractions or unrelated refactors.
- Do not hard-code AI model names in code or docs.
- Never commit secrets, tokens, or `.env*` / `.easyconvert/` data.

## Test integrity (zero tolerance)

- No circular mocking: an oracle or expected value must never come from the module under test. Use an independent parser, a standard CLI binary, or a separately authored golden set.
- No silent passes: when a required tool is missing, use `test.skip()` / `it.skipIf()` or throw. Never `return true` / `valid: true`.
- No hollow assertions: `toBeDefined()`, `toBe(true)`, `not.toThrow()` alone prove nothing. Assert decoded content, byte offsets, magic numbers, checksums, or schema.
- No test-shaped production code: no test filename checks, `NODE_ENV === 'test'` branches, placeholder strings (`[Text: N chars]`), raw PCM copies, or arbitrary truncation.
- Outputs must parse without error in the format's reference parser (ISO/RFC/ECMA). A reduced or synthesized payload is a failure.
- Bug fixes start with a failing regression test.

## Git & GitHub

- Never push to `main`. Branch from `main` (`feat/`, `fix/`, `test/`, `chore/`, `docs/`), preferably in a worktree under `.worktrees/`.
- Flow: issue → branch → local verification → PR → Claude Code review → resolve every thread → CI green (`verify`, SonarCloud) → `automerge` label. Squash merge only.
- Commits: `<type>(<scope>): <imperative summary>`, one commit per planned unit.
- Everything posted to GitHub (issues, PRs, commits, review replies) is concise English starting with an imperative verb; titles ≤ 72 chars. Use `.github/PULL_REQUEST_TEMPLATE.md`.
- Do not name or compare against other services or external reference projects in code, commits, issues, PRs, or docs; describe everything in this project's own domain terms.
- Do not split DB migrations, infra/deploy, auth/security, or legal changes into the same PR as other work.
- Stage explicit paths; never `git add -A` / `git add .`.

## Code review

- Automated review runs through the Claude Code GitHub Action (`.github/workflows/claude-code-review.yml`) on every non-draft PR. Comment `@claude` on the PR for a follow-up review or questions (`.github/workflows/claude.yml`).
- Locally, run `/code-review` before opening a PR, and use the `test-integrity-reviewer` subagent for test/oracle changes.
- Every actionable finding is fixed in a separate commit and its thread resolved; the `main` ruleset requires all review threads resolved before merge.
