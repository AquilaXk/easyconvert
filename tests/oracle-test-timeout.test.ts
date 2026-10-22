import { describe, expect, it } from 'vitest';
import { oracleTest } from './helpers/oracle-test';

/**
 * A case that drives external programs spends its time waiting for processes to be scheduled, so a runner that is busy
 * with other test files stretches it far past what an idle machine measures (an EPUB case of 66 ms took 3.5 s with 160
 * busy processes on 4 vCPUs; the CI runs of #692 lost the zstd and EPUB cases to the 5 s default). Cases and files that
 * reach an oracle program therefore carry a bound sized for that work, and the bound is still finite so a hung program
 * fails the case.
 */

const CLI_WORK_BOUND_MS = 30_000;
const HANG_BOUND_MS = 120_000;
const VITEST_DEFAULT_MS = 5_000;

function expectSizedForCliWork(timeout: number | undefined): void {
  expect(timeout).toBeGreaterThanOrEqual(CLI_WORK_BOUND_MS);
  expect(timeout).toBeLessThanOrEqual(HANG_BOUND_MS);
}

describe('the time limit of a case that drives external programs', () => {
  const seen: Record<string, number | undefined> = {};

  oracleTest('an oracle case without a limit of its own', [], (ctx) => {
    seen.default = ctx.task.timeout;
  });

  oracleTest('an oracle case with a limit of its own', [], (ctx) => {
    seen.explicit = ctx.task.timeout;
  }, 7_000);

  it('gives an oracle case without a limit one sized for the work, and keeps a limit the case names', () => {
    expectSizedForCliWork(seen.default);
    expect(seen.default).not.toBe(VITEST_DEFAULT_MS);
    expect(seen.explicit).toBe(7_000);
  });

  it('gives the plain cases of the same file the bound too, as they reach the programs through helpers', (ctx) => {
    expectSizedForCliWork(ctx.task.timeout);
  });
});
