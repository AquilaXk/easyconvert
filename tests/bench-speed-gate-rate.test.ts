import { describe, expect, it } from 'vitest';
import { AB_EXTRA_BUDGET_MS } from '../bench/ab-config';
import { abGateFails, absoluteGateFails, failureRate, type Truth, type Weight } from '../bench/simulate-speed-gate';

/**
 * The failure rates of the speed gate, from the simulation in bench/simulate-speed-gate.ts: simulated rows with a known
 * truth go through the real sampling procedure and the real verdict, with a fixed seed per trial. The noise is 2 to 3
 * percent per sample (3 to 4 percent per pair ratio), the quiet end of what CI measured for the comparison of two copies
 * of the same code; the table of the measured noise of every row is in bench/README.md. 400 trials per case.
 */

const TRIALS = 400;
const WEIGHTS: Weight[] = ['light', 'heavy'];
const truth = (headVsReference: number, headVsBase: number, sigma = 0.02): Truth => ({ headVsReference, headVsBase, sigma });

describe.each(WEIGHTS)('the A/B gate on %s rows', (weight) => {
  // The extra pairs a job may spend (bench/ab-config.ts) are on, as they are in the gate.
  const ab = (t: Truth, options = {}): Promise<number> => failureRate((seed) => abGateFails(t, weight, seed, { extra: { remainingMs: AB_EXTRA_BUDGET_MS }, ...options }), TRIALS);

  it('never fails unchanged code, whatever the row sits at against the reference', async () => {
    for (const headVsReference of [1.1, 1, 0.99, 0.98, 0.97, 0.96, 0.9]) {
      expect(await ab(truth(headVsReference, 1)), `at ${headVsReference}`).toBeLessThan(0.01);
    }
  });

  it('keeps that for noisier rows, and with extra pairs', async () => {
    expect(await ab(truth(1, 1, 0.04))).toBeLessThan(0.01);
    expect(await ab(truth(0.98, 1, 0.04), { extra: { remainingMs: 1e9 } })).toBeLessThan(0.01);
  });

  it('does not fail a head 5 percent slower or less: that is below the threshold', async () => {
    expect(await ab(truth(1, 0.95))).toBeLessThan(0.01);
    expect(await ab(truth(1, 1 / 1.1))).toBeLessThan(0.02);
  });

  it('fails a slowdown of 1.5 times the threshold (15 percent) in at least 95 percent of the trials, and one of 30 percent every time', async () => {
    expect(await ab(truth(1, 1 / 1.15))).toBeGreaterThanOrEqual(0.95);
    expect(await ab(truth(0.9, 1 / 1.15))).toBeGreaterThanOrEqual(0.95);
    expect(await ab(truth(1, 1 / 1.3))).toBe(1);
  });

  it('lets a row ask for a 5 percent threshold, and then fails a 10 percent slowdown in at least 95 percent of the trials', async () => {
    expect(await ab(truth(1, 1 / 1.1), { regression: { delta: 0.05 } })).toBeGreaterThanOrEqual(0.95);
    expect(await ab(truth(1, 1), { regression: { delta: 0.05 } })).toBeLessThan(0.01);
  });

  it('does not fail a head faster than its base', async () => {
    expect(await ab(truth(1.2, 1.2))).toBe(0);
  });
});

describe('the gate without a base, for contrast', () => {
  it('fails a row at parity by chance on a share of the runs, which is what the A/B comparison removes', async () => {
    const absolute = await failureRate((seed) => absoluteGateFails(truth(1, 1, 0.05), 'heavy', seed), TRIALS);
    expect(absolute).toBeGreaterThan(0.15);
    expect(await failureRate((seed) => abGateFails(truth(1, 1, 0.05), 'heavy', seed), TRIALS)).toBe(0);
  });
});
