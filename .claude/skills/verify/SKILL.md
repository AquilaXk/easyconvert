---
name: verify
description: Run EasyConvert's deterministic verification gate (anti-cheat guard, lint, targeted or full tests, build) and produce the PR "Verification" table. Use before claiming a change is done, before committing a planned unit, and before opening or updating a PR.
argument-hint: "[test files... | --full]"
allowed-tools: Bash(git fetch origin *) Bash(npm run guard:anti-cheat) Bash(npm run lint) Bash(npm test) Bash(npx vitest run *) Bash(npm run build) Bash(git diff *) Bash(git status *)
---

Run the gate in this order and stop at the first failure, reporting the failing output verbatim:

1. `npm run guard:anti-cheat`
2. `npm run lint`
3. Tests:
   - If `$ARGUMENTS` lists test files, run `npx vitest run $ARGUMENTS`.
   - If `$ARGUMENTS` is `--full`, or the change touches `src/lib/registry.ts`, shared helpers under `tests/helpers/`, or more than one conversion family, run `npm test`.
   - Otherwise run `git fetch origin --quiet` and derive the affected test files from `git diff --name-only origin/main...HEAD` plus uncommitted changes (tests next to the changed modules, and tests that import them) and run only those with `npx vitest run`.
4. `npm run build` — only when source under `src/`, `tsconfig.json`, `next.config.mjs`, or dependencies changed.

Skipped oracle tests count as NOT RUN, not as passes; list each with the missing tool.

Finish with a Markdown table ready to paste into the PR template:

| Check | Command / Evidence | Status |
|---|---|---|

Then a "Not Run" list with a concrete reason for every skipped step.
