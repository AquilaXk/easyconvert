import { afterAll, beforeEach, vi } from 'vitest';

/**
 * For a suite whose stand-in programs write a record outside the directory of their job (a spy that appends the arguments it was called
 * with to a log of the test, a marker file the test waits for): the confinement of the files of a sandboxed run (policy 232) refuses
 * that write by design, and what these suites check is which programs run and with what, not where they may write. The confinement
 * itself is tested in sandbox-file-confinement.test.ts, pid-init-confine.test.ts and qpdf-runner.test.ts.
 */
export function runWithoutFileConfinement(): void {
  // Before each test, because a suite that unstubs the environment after a test would otherwise confine the next one.
  beforeEach(() => {
    vi.stubEnv('SANDBOX_CONFINE_FILES', 'false');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });
}
