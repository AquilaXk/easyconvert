import { vi } from 'vitest';

/**
 * Limit of a test whose time goes to external programs. A case that starts programs spends most of its time waiting
 * for them to be scheduled, so a runner busy with other test files stretches it far past an idle measurement: an EPUB
 * case of 66 ms took 3.5 s beside 160 busy processes on 4 vCPUs, and the zstd level 1 to 19 case (76 compressions)
 * timed out three times at the 5 s default on the CI runner. 60 s is the limit the tool-driven files already use; it
 * stays finite so a program that hangs still fails the case.
 */
export const CLI_TEST_TIMEOUT_MS = 60_000;

/**
 * Sets the default limit of every case in the calling file. It runs while the file's imports load, so a limit the file
 * sets itself afterwards (`vi.setConfig`) or names on a case replaces it.
 */
export function boundTestsForCliWork(): void {
  vi.setConfig({ testTimeout: CLI_TEST_TIMEOUT_MS });
}
