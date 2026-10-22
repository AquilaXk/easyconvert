import { vi } from 'vitest';

/** Limit for cases whose time goes to external programs, sized like the other tool-driven files; finite so a hung program still fails. */
export const CLI_TEST_TIMEOUT_MS = 60_000;

/** Runs while the file's imports load, so a later `vi.setConfig` or a per-case timeout replaces it. */
export function boundTestsForCliWork(): void {
  vi.setConfig({ testTimeout: CLI_TEST_TIMEOUT_MS });
}
