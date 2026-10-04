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

## Test integrity

- No circular mocking: an oracle or expected value must never come from the module under test. Use an independent parser, a standard CLI binary, or a separately authored golden set.
- No silent passes: when a required tool is missing, use `test.skip()` / `it.skipIf()` or throw. Never `return true` / `valid: true`.
- No hollow assertions: `toBeDefined()`, `toBe(true)`, `not.toThrow()` alone prove nothing. Assert decoded content, byte offsets, magic numbers, checksums, or schema.
- No test-shaped production code: no test filename checks, `NODE_ENV === 'test'` branches, placeholder strings (`[Text: N chars]`), raw PCM copies, or arbitrary truncation.
- Outputs must parse without error in the format's reference parser (ISO/RFC/ECMA). A reduced or synthesized payload is a failure.
- Bug fixes start with a failing regression test.

## Git & GitHub

- Never push to `main` (the `main` ruleset is the real enforcement; `.claude/settings.json` deny rules are only a safety net). Branch from `main` (`feat/`, `fix/`, `test/`, `chore/`, `docs/`), in an isolated worktree (`claude --worktree` / `.claude/worktrees/`, or `.worktrees/` for manual ones).
- Flow: plan → issue → branch → local verification → PR → review (see below) → resolve every thread → CI green (`verify`, SonarCloud) → `automerge` label. Squash merge only.
- Commits: `<type>(<scope>): <imperative summary>`, one commit per planned unit.
- Everything posted to GitHub (issues, PRs, commits, review replies) is concise English starting with an imperative verb; titles ≤ 72 chars. Use `.github/PULL_REQUEST_TEMPLATE.md`.
- Do not name or compare against other services or external reference projects in code, commits, issues, PRs, or docs; describe everything in this project's own domain terms.
- Do not split DB migrations, infra/deploy, auth/security, or legal changes into the same PR as other work.
- Stage explicit paths; never `git add -A` / `git add .`.

## Agent orchestration

The lead session owns scope, design decisions, integration, commits, and PR gates. Delegate only work whose scope and acceptance criteria are already settled.

| Need | Use |
|---|---|
| Broad read-only search or doc lookup | built-in `Explore` subagent, or your own user-level read-only explorer if you have one |
| One bounded conversion-engine/format change | `format-engine-worker` (own worktree; commits locally, never pushes) |
| Several independent format changes | several `format-engine-worker`s in parallel, then integrate one by one |
| Test/oracle integrity check | `test-integrity-reviewer` |
| Prove outputs with standard toolchains | `bitstream-verifier` |
| Deterministic gate + PR Verification table | `/verify [test files \| --full]` |
| Pre-PR multi-lens review with adversarial verification | `/pre-pr-review [base, default origin/main]` (saved workflow) |

- Give delegates a brief with goal, allowed/forbidden paths, acceptance criteria, and the verification to run. Never delegate a decision the lead has not made.
- Keep token use low: run at most one subagent at a time, and pick its model explicitly — `sonnet` for code review and implementation, `haiku` for simple search and verification. Do small fixes, CI checks, pushes, and labels in the lead session.
- Parallel writers must each have their own worktree and non-overlapping files; the lead reviews every delegate's diff and re-runs `/verify` after integrating.
- Worktrees branch from `origin/main` (`worktree.baseRef: fresh`) so unpushed work from another agent never leaks in; `node_modules` is symlinked from the main checkout.

## Multi-agent coexistence

This repository is developed by Claude Code and by Gemini/Antigravity agents in parallel.

- Antigravity/Gemini sessions follow the local, gitignored `AGENTS.md` and `GEMINI.md`, and review PRs with their own `aquila-review` skill. Claude Code sessions follow this file. The engineering rules (fail-closed, test integrity, architecture, Git flow) are the same on both sides; when changing a shared rule here, flag that `GEMINI.md`/`AGENTS.md` need the same change.
- One tracked task per branch/worktree. Never modify, rebase, push to, or clean up a branch, worktree, or uncommitted change you did not create in this session — it may belong to the other agent. The exception is an open Claude Code PR you are asked to follow up on: reuse its issue, branch, and PR. Check `git status`, `git worktree list`, and open PRs before starting.
- `implementation_plan.md` and `walkthrough.md` are Antigravity planning artifacts. Read them for context; do not rewrite them unless the task is explicitly about them.
- Do not edit, hide, or resolve `aquila-review` comments on the other agent's behalf without fixing the underlying finding.

## Code review

- Every non-draft PR, from either agent, gets an automated Claude Code review through `.github/workflows/claude-code-review.yml`. Comment `@claude` on the PR for a follow-up review or questions (`.github/workflows/claude.yml`).
- Claude Code sessions: run `/verify` and `/code-review` locally before opening a PR; for conversion, test, or security changes also run `/pre-pr-review`. Running `aquila-review` is not required from Claude Code.
- Findings from any reviewer (Claude Code review or `aquila-review`) are fixed in a separate commit and their threads resolved; the `main` ruleset requires all review threads resolved before merge.
