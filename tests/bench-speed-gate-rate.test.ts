import { describe, expect, it } from 'vitest';
import { abGateFails, absoluteGateFails, failureRate, type Truth, type Weight } from '../bench/simulate-speed-gate';

/**
 * The failure rates of the speed gate, from the simulation in bench/simulate-speed-gate.ts: simulated rows with a known
 * truth go through the real sampling procedure and the real verdict, with a fixed seed per trial. The noise is the
 * 2 to 3 percent per sample (3 to 4 percent per pair ratio) that CI measured for the A/B comparison of unchanged code
 * (bench/README.md). 400 trials per case.
 */

const TRIALS = 400;
const WEIGHTS: Weight[] = ['light', 'heavy'];
const truth = (headVsReference: number, headVsBase: number, sigma = 0.02): Truth => ({ headVsReference, headVsBase, sigma });

describe.each(WEIGHTS)('the A/B gate on %s rows', (weight) => {
  const ab = (t: Truth): Promise<number> => failureRate((seed) => abGateFails(t, weight, seed), TRIALS);

  it('never fails unchanged code, whatever the row sits at against the reference', async () => {
    for (const headVsReference of [1.1, 1, 0.99, 0.98, 0.97, 0.96, 0.9]) {
      expect(await ab(truth(headVsReference, 1)), `at ${headVsReference}`).toBeLessThan(0.01);
    }
  });

  it('keeps that at the noisiest rows the CI measured (6 percent per pair, 4 percent per sample)', async () => {
    expect(await ab(truth(1, 1, 0.04))).toBeLessThan(0.01);
    expect(await ab(truth(0.98, 1, 0.04))).toBeLessThan(0.01);
  });

  it('fails a 20 percent slowdown every time', async () => {
    expect(await ab(truth(1, 0.8))).toBe(1);
  });

  it('does not fail a head faster than its base', async () => {
    expect(await ab(truth(1.2, 1.2))).toBe(0);
  });
});

describe('the injected 10 percent slowdown of a row at parity', () => {
  it('fails every light row and nearly every heavy row at the noise CI measured', async () => {
    const light = await failureRate((seed) => abGateFails(truth(1, 0.9), 'light', seed), TRIALS);
    const heavy = await failureRate((seed) => abGateFails(truth(1, 0.9), 'heavy', seed), TRIALS);
    expect(light).toBeGreaterThanOrEqual(0.99);
    expect(heavy).toBeGreaterThanOrEqual(0.95);
  });

  it('is caught also when the row was already below the reference on the base', async () => {
    expect(await failureRate((seed) => abGateFails(truth(0.9, 0.9), 'light', seed), TRIALS)).toBeGreaterThanOrEqual(0.99);
  });
});

describe('the gate without a base, for contrast', () => {
  it('fails a row at parity by chance on a share of the runs, which is what the A/B comparison removes', async () => {
    const absolute = await failureRate((seed) => absoluteGateFails(truth(1, 1, 0.03), 'heavy', seed), TRIALS);
    expect(absolute).toBeGreaterThan(0.2);
    expect(await failureRate((seed) => abGateFails(truth(1, 1, 0.03), 'heavy', seed), TRIALS)).toBe(0);
  });
});
