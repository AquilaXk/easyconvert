import { describe, expect, it } from 'vitest';
import { AB_ROW_ALPHA, abSpeedTiming, oneSidedRank, regressionDelta, slowdownLine, upperBoundOfMedian } from '../bench/ab-speed';
import { AB_DEFAULT_REGRESSION, AB_FAMILYWISE_ALPHA, AB_HEAVY_PAIRS, AB_LIGHT_PAIRS, AB_ROW_BUDGET, AB_ROW_REGRESSION } from '../bench/config';
import fs from 'node:fs';
import path from 'node:path';
import { SpeedSampleError } from '../bench/speed-parity';

/**
 * The A/B comparison on hand-written pairs. The ranks of the one-sided bound are checked against binomial sums worked
 * out by hand (P(Binomial(n, 1/2) <= k - 1)); the timings come from a fake clock.
 */

describe('the error rate of one row', () => {
  it('is the family-wise rate shared by the rows of a run', () => {
    expect(AB_FAMILYWISE_ALPHA).toBe(0.01);
    expect(AB_ROW_BUDGET).toBe(50);
    expect(AB_ROW_ALPHA).toBeCloseTo(0.0002, 12);
  });

  it('is met by the pair counts: the light plan reaches rank 4, the heavy plan rank 2', () => {
    expect([AB_LIGHT_PAIRS, AB_HEAVY_PAIRS]).toEqual([24, 17]);
    expect(oneSidedRank(AB_LIGHT_PAIRS, AB_ROW_ALPHA)).toBe(4);
    expect(oneSidedRank(AB_HEAVY_PAIRS, AB_ROW_ALPHA)).toBe(2);
  });
});

describe('the one-sided rank', () => {
  it('is the largest k with P(Binomial(n, 1/2) <= k - 1) at most alpha', () => {
    // n = 13: P(<= 0) = 1/8192 = 0.000122 <= 0.0002, P(<= 1) = 14/8192 = 0.0017 > 0.0002.
    expect(oneSidedRank(13, 0.0002)).toBe(1);
    // n = 12: P(<= 0) = 1/4096 = 0.000244 > 0.0002: no rank, so a bound cannot exist.
    expect(oneSidedRank(12, 0.0002)).toBe(0);
    // n = 17: P(<= 1) = 18/131072 = 0.000137 <= 0.0002; P(<= 2) = 154/131072 = 0.00117 > 0.0002.
    expect(oneSidedRank(17, 0.0002)).toBe(2);
    // n = 24: P(<= 3) = 2325/16777216 = 0.000139 <= 0.0002; P(<= 4) = 12951/16777216 = 0.00077 > 0.0002.
    expect(oneSidedRank(24, 0.0002)).toBe(4);
    // A looser alpha reaches further: n = 10, alpha 0.05: P(<= 1) = 11/1024 = 0.0107, P(<= 2) = 56/1024 = 0.0547 > 0.05.
    expect(oneSidedRank(10, 0.05)).toBe(2);
  });

  it('refuses a sample of no pair and an alpha outside (0, 1)', () => {
    expect(() => oneSidedRank(0, 0.01)).toThrow(SpeedSampleError);
    expect(() => oneSidedRank(5, 0)).toThrow(SpeedSampleError);
    expect(() => oneSidedRank(5, 1)).toThrow(SpeedSampleError);
  });
});

describe('the upper bound of the median', () => {
  it('is the order statistic x(n + 1 - k) of the sorted ratios', () => {
    const ratios = Array.from({ length: 13 }, (_, index) => 0.9 + index * 0.01); // 0.90 .. 1.02
    expect(upperBoundOfMedian(ratios, 0.0002)).toBeCloseTo(1.02, 12); // k = 1: the largest
    expect(upperBoundOfMedian([...ratios].reverse(), 0.0002)).toBeCloseTo(1.02, 12);
    const more = Array.from({ length: 24 }, (_, index) => 0.9 + index * 0.01);
    expect(upperBoundOfMedian(more, 0.0002)).toBeCloseTo(0.9 + 20 * 0.01, 12); // k = 4: x(21)
  });

  it('is infinite when there are too few pairs for the error rate', () => {
    expect(upperBoundOfMedian([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5], 0.0002)).toBe(Number.POSITIVE_INFINITY);
  });
});

/** Head, base and reference run in a rotating order; each call advances the clock by the time of the side it is. */
function scripted(times: (pair: number) => { head: number; base: number; reference: number }) {
  let clock = 0;
  const calls = { head: 0, base: 0, reference: 0 };
  const order: string[] = [];
  const side = (name: 'head' | 'base' | 'reference') => (): void => {
    order.push(name);
    clock += times(calls[name]++)[name];
  };
  return { now: () => clock, head: side('head'), base: side('base'), reference: side('reference'), calls, order };
}

describe('the A/B timing', () => {
  it('times the three sides once per pair, in an order that rotates through all six permutations', async () => {
    const run = scripted(() => ({ head: 100, base: 100, reference: 100 }));
    await abSpeedTiming(run.head, run.base, run.reference, { pairs: 6, warmup: 0 }, run.now);
    expect(run.calls).toEqual({ head: 6, base: 6, reference: 6 });
    const orders = Array.from({ length: 6 }, (_, pair) => run.order.slice(pair * 3, pair * 3 + 3).join(','));
    expect(new Set(orders).size).toBe(6);
    // The head comes first, second and third twice each: no side owns a position.
    for (const position of [0, 1, 2]) expect(orders.filter((order) => order.split(',')[position] === 'head')).toHaveLength(2);
  });

  it('measures a head as fast as its base, and one 10 percent slower, by the pair ratios', async () => {
    const same = scripted(() => ({ head: 100, base: 100, reference: 100 }));
    const equal = await abSpeedTiming(same.head, same.base, same.reference, { pairs: AB_LIGHT_PAIRS, warmup: 0 }, same.now);
    expect(equal.ab).toMatchObject({ pairs: 24, headVsBaseMedian: 1, headVsBaseUpper: 1, headVsReferenceUpper: 1, baseVsReferenceMedian: 1, noise: 0 });
    const slow = scripted(() => ({ head: 110, base: 100, reference: 100 }));
    const slower = await abSpeedTiming(slow.head, slow.base, slow.reference, { pairs: AB_LIGHT_PAIRS, warmup: 0 }, slow.now);
    expect(slower.ab.headVsBaseMedian).toBeCloseTo(100 / 110, 12);
    expect(slower.ab.headVsBaseUpper).toBeCloseTo(100 / 110, 12);
    expect(slower.ab.headVsReferenceUpper).toBeCloseTo(100 / 110, 12);
    expect(slower.ab.baseVsReferenceMedian).toBeCloseTo(1, 12);
  });

  it('reports the head and the reference as the ordinary timing does, and the noise of the pair ratios', async () => {
    const run = scripted((pair) => ({ head: pair % 2 === 0 ? 90 : 110, base: 100, reference: 200 }));
    const timing = await abSpeedTiming(run.head, run.base, run.reference, { pairs: 12, warmup: 0 }, run.now);
    expect(timing.runs).toBe(12);
    expect(timing.oursMedianMs).toBe(100);
    expect(timing.referenceMedianMs).toBe(200);
    expect(timing.baseMs).toEqual(Array(12).fill(100));
    expect(timing.decision.median).toBeCloseTo(2.0202, 3); // the median of 200 / 90 and 200 / 110 alternating: (2.2222 + 1.8182) / 2
    expect(timing.ab.noise).toBeGreaterThan(0.09);
    expect(timing.ab.noise).toBeLessThan(0.11);
  });

  it('gives head and base the same number of calls per sample, from the fastest warm-up call of either', async () => {
    let clock = 0;
    const headCalls: number[] = [];
    const head = (): void => {
      headCalls.push(1);
      clock += 10;
    };
    const base = (): void => {
      clock += 5;
    };
    const reference = (): void => {
      clock += 100;
    };
    const timing = await abSpeedTiming(head, base, reference, { pairs: 6, warmup: 2, minSampleMs: 50 }, () => clock);
    // The base's 5 ms is the fastest call: 50 / 5 = 10 calls per sample for both versions.
    expect(timing.repeats).toEqual({ ours: 10, reference: 1 });
    expect(headCalls).toHaveLength(2 + 6 * 10);
    expect(timing.oursMs.every((ms) => ms === 10)).toBe(true);
    expect(timing.baseMs.every((ms) => ms === 5)).toBe(true);
  });

  it('cannot fail a head with too few pairs: the bound does not exist', async () => {
    const run = scripted(() => ({ head: 200, base: 100, reference: 100 }));
    const timing = await abSpeedTiming(run.head, run.base, run.reference, { pairs: 12, warmup: 0 }, run.now);
    expect(timing.ab.headVsBaseMedian).toBeCloseTo(0.5, 12);
    expect(timing.ab.headVsBaseUpper).toBe(Number.POSITIVE_INFINITY);
  });

  it('refuses a plan of no pair or of more pairs than the interval is exact for', async () => {
    const run = scripted(() => ({ head: 1, base: 1, reference: 1 }));
    await expect(abSpeedTiming(run.head, run.base, run.reference, { pairs: 0, warmup: 0 }, run.now)).rejects.toThrow(SpeedSampleError);
    await expect(abSpeedTiming(run.head, run.base, run.reference, { pairs: 65, warmup: 0 }, run.now)).rejects.toThrow(SpeedSampleError);
  });
});

describe('the regression threshold of a row', () => {
  it('is 10 percent unless the row has its own, and the line is the base time over the slower head time', () => {
    expect(AB_DEFAULT_REGRESSION).toBe(0.1);
    expect(regressionDelta('image/a/throughput')).toBe(0.1);
    expect(slowdownLine('image/a/throughput')).toBeCloseTo(1 / 1.1, 12);
    expect(regressionDelta('x/y/throughput', { 'x/y/throughput': { delta: 0.25 } })).toBe(0.25);
    expect(slowdownLine('x/y/throughput', { 'x/y/throughput': { delta: 0.25 } })).toBeCloseTo(0.8, 12);
  });

  it('is overridden only with a recorded reason, for a row of the baseline, and only upwards from the default', () => {
    const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bench', 'baseline.json'), 'utf8')) as { entries: Record<string, unknown> };
    for (const [id, override] of Object.entries(AB_ROW_REGRESSION)) {
      expect(id in baseline.entries, id).toBe(true);
      expect(override.delta, id).toBeGreaterThan(AB_DEFAULT_REGRESSION);
      expect(override.delta, id).toBeLessThanOrEqual(0.5);
      expect(override.reason.length, id).toBeGreaterThan(60);
      expect(override.reason, id).toMatch(/\d+(\.\d+)?/);
    }
  });
});
