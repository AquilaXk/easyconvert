# Implementation Plan: Anti-Cheating & Falsifiability Fixes

## 1. Context
- The adversarial review revealed that `scripts/guard-anti-cheat.ts` misses circular mocking patterns involving `serialize/deserialize` and `create/extract`.
- The `tests/cad-predicates.test.ts` contains tautological assertions (e.g., `expect(sum + sumErr).toBe(a + b);`) which survive falsifiability probes (Gate 1 failure).

## 2. Changes
### 2.1 Update `scripts/guard-anti-cheat.ts`
- Modify the `checkCircularMocking` rule to include `serialize`, `create`, `extract` in the regex for `hasEncode`, `hasParse`, `hasCompress`, `hasDecompress`.

### 2.2 Fix `tests/cad-predicates.test.ts`
- Replace tautological `twoSum` and `twoProduct` assertions with exact ground-truth values (e.g. asserting exact bitwise expected values or known edge-case constants instead of `a + b`).

### 2.3 Verify `.gitignore`
- Confirmed that `.gitignore` successfully excludes `.agents/`, `AGENTS.md`, and `GEMINI.md`.

## 3. Verification
- Run `npm run guard:anti-cheat` to ensure no new errors.
- Run `vitest run tests/cad-predicates.test.ts` to ensure it passes.
- Run `probe-falsifiability.mjs` to ensure the mutation is now caught (KILLED).
