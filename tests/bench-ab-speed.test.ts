import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AB_DEFAULT_REGRESSION,
  AB_EXTRA_BUDGET_MS,
  AB_EXTRA_STEP_PAIRS,
  AB_FAMILYWISE_ALPHA,
  AB_HEAVY_PAIRS,
  AB_LIGHT_PAIRS,
  AB_MAX_PAIRS,
  AB_ROW_BUDGET,
  AB_ROW_REGRESSION,
} from '../bench/ab-config';
import { AB_ROW_ALPHA, abSpeedTiming, localSide, lowerBoundOfMedian, oneSidedRank, regressionDelta, type Side, slowdownLine, upperBoundOfMedian } from '../bench/ab-speed';
import { SpeedSampleError } from '../bench/speed-parity';

/**
 * The A/B comparison on hand-written pairs. The ranks of the one-sided bound are checked against binomial sums worked
 * out by hand (P(Binomial(n, 1/2) <= k - 1)); the timings come from scripted sides.
 */

describe('the error rate of one row', () => {
  it('is the family-wise rate shared by the rows of a run', () => {
    expect(AB_FAMILYWISE_ALPHA).toBe(0.01);
    expect(AB_ROW_BUDGET).toBe(50);
    expect(AB_ROW_ALPHA).toBeCloseTo(0.0002, 12);
  });

  it('is met by the pair counts, which are whole cycles of the six orders: the light plan reaches rank 4, the heavy plan rank 2', () => {
    expect([AB_LIGHT_PAIRS, AB_HEAVY_PAIRS]).toEqual([24, 18]);
    expect(AB_LIGHT_PAIRS % 6).toBe(0);
    expect(AB_HEAVY_PAIRS % 6).toBe(0);
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
    // n = 18: P(<= 1) = 19/262144 = 0.0000725 <= 0.0002; P(<= 2) = 172/262144 = 0.000656 > 0.0002.
    expect(oneSidedRank(18, 0.0002)).toBe(2);
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
    const ratios = Array.from({ length: 13 }, (_, index) => 0.9 + index * 0.01);
    expect(upperBoundOfMedian(ratios, 0.0002)).toBeCloseTo(1.02, 12); // k = 1: the largest
    expect(upperBoundOfMedian([...ratios].reverse(), 0.0002)).toBeCloseTo(1.02, 12);
    const more = Array.from({ length: 24 }, (_, index) => 0.9 + index * 0.01);
    expect(upperBoundOfMedian(more, 0.0002)).toBeCloseTo(0.9 + 20 * 0.01, 12); // k = 4: x(21)
  });

  it('is infinite when there are too few pairs for the error rate', () => {
    expect(upperBoundOfMedian([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5], 0.0002)).toBe(Number.POSITIVE_INFINITY);
  });
});

/** Head, base and reference whose k-th call takes `time(k)` ms; each advances the clock the benchmark reads. */
function sides(head: (call: number) => number, base: (call: number) => number, reference: (call: number) => number) {
  let clock = 0;
  const order: string[] = [];
  const counts = { head: 0, base: 0, reference: 0 };
  const make = (name: 'head' | 'base' | 'reference', time: (call: number) => number): Side => {
    const run = async (): Promise<number> => {
      order.push(name);
      const ms = time(counts[name]++);
      clock += ms;
      return ms;
    };
    return { call: run, sample: run };
  };
  return { head: make('head', head), base: make('base', base), reference: make('reference', reference), now: () => clock, order, counts };
}

describe('the A/B timing', () => {
  it('times the three sides once per pair, in an order that rotates through all six permutations, each equally often', async () => {
    const run = sides(() => 100, () => 100, () => 100);
    await abSpeedTiming(run.head, run.base, run.reference, { pairs: AB_HEAVY_PAIRS, warmup: 0 }, run.now);
    expect(run.counts).toEqual({ head: 18, base: 18, reference: 18 });
    const orders = Array.from({ length: 18 }, (_, pair) => run.order.slice(pair * 3, pair * 3 + 3).join(','));
    expect(new Set(orders).size).toBe(6);
    for (const order of new Set(orders)) expect(orders.filter((candidate) => candidate === order)).toHaveLength(3);
    // The head comes before the base in half of the pairs.
    expect(orders.filter((order) => order.indexOf('head') < order.indexOf('base'))).toHaveLength(9);
  });

  it('measures a head as fast as its base, and one 10 percent slower, by the pair ratios', async () => {
    const same = sides(() => 100, () => 100, () => 100);
    const equal = await abSpeedTiming(same.head, same.base, same.reference, { pairs: AB_LIGHT_PAIRS, warmup: 0 }, same.now);
    expect(equal.ab).toMatchObject({ pairs: 24, headVsBaseMedian: 1, headVsBaseUpper: 1, headVsReferenceUpper: 1, baseVsReferenceMedian: 1, noise: 0, extraPairs: 0, confirmed: {} });
    const slow = sides(() => 110, () => 100, () => 100);
    const slower = await abSpeedTiming(slow.head, slow.base, slow.reference, { pairs: AB_LIGHT_PAIRS, warmup: 0 }, slow.now);
    expect(slower.ab.headVsBaseMedian).toBeCloseTo(100 / 110, 12);
    expect(slower.ab.headVsBaseUpper).toBeCloseTo(100 / 110, 12);
    expect(slower.ab.headVsReferenceUpper).toBeCloseTo(100 / 110, 12);
    expect(slower.ab.baseVsReferenceMedian).toBeCloseTo(1, 12);
  });

  it('reports the head and the reference as the ordinary timing does, and the noise of the pair ratios', async () => {
    const run = sides((call) => (call % 2 === 0 ? 90 : 110), () => 100, () => 200);
    const timing = await abSpeedTiming(run.head, run.base, run.reference, { pairs: 12, warmup: 0 }, run.now);
    expect(timing.runs).toBe(12);
    expect(timing.oursMedianMs).toBe(100);
    expect(timing.referenceMedianMs).toBe(200);
    expect(timing.baseMs).toEqual(Array(12).fill(100));
    expect(timing.decision.median).toBeCloseTo(2.0202, 3);
    expect(timing.ab.noise).toBeGreaterThan(0.09);
    expect(timing.ab.noise).toBeLessThan(0.11);
  });

  it('gives head and base the same number of calls per sample, from the fastest warm-up call of either', async () => {
    const requested: number[] = [];
    let clock = 0;
    const side = (ms: number): Side => ({
      call: async () => {
        clock += ms;
        return ms;
      },
      sample: async (calls) => {
        requested.push(calls);
        clock += ms * calls;
        return ms;
      },
    });
    const timing = await abSpeedTiming(side(10), side(5), side(100), { pairs: 6, warmup: 2, minSampleMs: 50 }, () => clock);
    // The base's 5 ms is the fastest call: 50 / 5 = 10 calls per sample for both versions, one for the reference.
    expect(timing.repeats).toEqual({ ours: 10, reference: 1 });
    expect(requested.filter((calls) => calls === 10)).toHaveLength(12);
    expect(requested.filter((calls) => calls === 1)).toHaveLength(6);
  });

  it('cannot fail a head with too few pairs: the bound does not exist', async () => {
    const run = sides(() => 200, () => 100, () => 100);
    const timing = await abSpeedTiming(run.head, run.base, run.reference, { pairs: 12, warmup: 0 }, run.now);
    expect(timing.ab.headVsBaseMedian).toBeCloseTo(0.5, 12);
    expect(timing.ab.headVsBaseUpper).toBe(Number.POSITIVE_INFINITY);
  });

  it('refuses a plan of no pair or of more pairs than the interval is exact for', async () => {
    const run = sides(() => 1, () => 1, () => 1);
    await expect(abSpeedTiming(run.head, run.base, run.reference, { pairs: 0, warmup: 0 }, run.now)).rejects.toThrow(SpeedSampleError);
    await expect(abSpeedTiming(run.head, run.base, run.reference, { pairs: AB_MAX_PAIRS + 1, warmup: 0 }, run.now)).rejects.toThrow(SpeedSampleError);
  });

  it('times a side of this process over back-to-back calls', async () => {
    let clock = 0;
    let runs = 0;
    const local = localSide(() => {
      runs++;
      clock += 7;
    }, () => clock);
    expect(await local.call()).toBe(7);
    expect(await local.sample(4)).toBe(7);
    expect(runs).toBe(5);
  });
});

describe('the lower bound of the median', () => {
  it('is the order statistic x(k) of the sorted ratios, and 0 with too few pairs', () => {
    const more = Array.from({ length: 24 }, (_, index) => 0.9 + index * 0.01);
    expect(lowerBoundOfMedian(more, 0.0002)).toBeCloseTo(0.93, 12); // k = 4: x(4)
    expect(lowerBoundOfMedian([1, 1, 1, 1, 1, 1], 0.0002)).toBe(0);
  });
});

describe('extra pairs for a row the first pairs leave undecided', () => {
  /** The head's time alternates around the base's by the given spread. */
  const noisy = (spread: number) => sides((call) => (call % 2 === 0 ? 100 * (1 - spread) : 100 * (1 + spread)), () => 100, () => 100);

  it('are added six at a time up to the limit while a budget lasts, to a row whose bounds straddle its line', async () => {
    // 30 percent either way: the lower bound is under 1 / 1.1 and the upper bound over it.
    const wide = noisy(0.3);
    const timing = await abSpeedTiming(wide.head, wide.base, wide.reference, { pairs: 24, warmup: 0, extra: { remainingMs: 1e9 } }, wide.now);
    expect(timing.ab.extraPairs).toBe(AB_MAX_PAIRS - 24);
    expect(timing.runs).toBe(AB_MAX_PAIRS);
    expect(AB_EXTRA_STEP_PAIRS).toBe(6);
  });

  it('are not added to a row the first pairs decide: the lower bound is over its line, so more pairs cannot make it fail', async () => {
    const quiet = noisy(0.03);
    const timing = await abSpeedTiming(quiet.head, quiet.base, quiet.reference, { pairs: 24, warmup: 0, extra: { remainingMs: 1e9 } }, quiet.now);
    expect(timing.ab.extraPairs).toBe(0);
    // Nor to a row clearly slower: its upper bound is under the line.
    const slow = sides(() => 150, () => 100, () => 100);
    const slower = await abSpeedTiming(slow.head, slow.base, slow.reference, { pairs: 24, warmup: 0, confirm: false, extra: { remainingMs: 1e9 } }, slow.now);
    expect(slower.ab.extraPairs).toBe(0);
  });

  it('stop when the budget is spent, and the budget is spent by the time they took, the confirmation set included', async () => {
    const wide = noisy(0.3);
    const extra = { remainingMs: 1 };
    const timing = await abSpeedTiming(wide.head, wide.base, wide.reference, { pairs: 24, warmup: 0, extra }, wide.now);
    // One step of six pairs took far more than the 1 ms left, so the budget ended the extension after it.
    expect(timing.ab.extraPairs).toBe(6);
    expect(extra.remainingMs).toBeLessThan(0);
    const none = await abSpeedTiming(wide.head, wide.base, wide.reference, { pairs: 24, warmup: 0, extra: { remainingMs: 0 } }, wide.now);
    expect(none.ab.extraPairs).toBe(0);
    expect(AB_EXTRA_BUDGET_MS).toBe(4 * 60 * 1000);
    // A failure's confirmation set is charged to the budget, though it is taken whatever is left.
    const steady = sides(() => 150, () => 100, () => 100);
    const charged = { remainingMs: 1e9 };
    const confirmed = await abSpeedTiming(steady.head, steady.base, steady.reference, { pairs: 24, warmup: 0, extra: charged }, steady.now);
    expect(confirmed.ab.confirmed.slower).toBe(true);
    expect(1e9 - charged.remainingMs).toBeCloseTo(24 * (150 + 100 + 100), 6);
  });

  it('follow the threshold of the row: a narrower one leaves a row undecided that the default decides', async () => {
    // The head is 4 to 8 percent slower: surely not more than 10 percent slower, but possibly more than 5.
    const run = sides((call) => (call % 2 === 0 ? 104 : 108), () => 100, () => 100);
    const defaultPlan = await abSpeedTiming(run.head, run.base, run.reference, { pairs: 24, warmup: 0, extra: { remainingMs: 1e9 } }, run.now);
    expect(defaultPlan.ab.extraPairs).toBe(0);
    const strict = sides((call) => (call % 2 === 0 ? 104 : 108), () => 100, () => 100);
    const strictPlan = await abSpeedTiming(strict.head, strict.base, strict.reference, { pairs: 24, warmup: 0, delta: 0.05, extra: { remainingMs: 1e9 } }, strict.now);
    expect(strictPlan.ab.extraPairs).toBeGreaterThan(0);
  });
});

describe('the regression threshold of a row', () => {
  it('is 10 percent unless the row has its own, and the line is the base time over the slower head time', () => {
    expect(AB_DEFAULT_REGRESSION).toBe(0.1);
    expect(regressionDelta('image/a/throughput')).toBe(0.1);
    expect(slowdownLine('image/a/throughput')).toBeCloseTo(1 / 1.1, 12);
    expect(regressionDelta('x/y/throughput', { 'x/y/throughput': { delta: 0.25 } })).toBe(0.25);
    expect(slowdownLine('x/y/throughput', { 'x/y/throughput': { delta: 0.05 } })).toBeCloseTo(1 / 1.05, 12);
  });

  it('is overridden only for a row of the baseline, with its measured noise and the run that measured it as the reason', () => {
    const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bench', 'baseline.json'), 'utf8')) as { entries: Record<string, unknown> };
    const noise = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bench', 'ab-noise-samples.json'), 'utf8')) as { rows: { id: string; noise: number }[] };
    const measured = new Map(noise.rows.map((row) => [row.id, row.noise]));
    expect(Object.keys(AB_ROW_REGRESSION).length).toBeGreaterThan(0);
    for (const [id, override] of Object.entries(AB_ROW_REGRESSION)) {
      expect(id in baseline.entries, id).toBe(true);
      expect(override.delta, id).toBeGreaterThan(AB_DEFAULT_REGRESSION);
      expect(override.delta, id).toBeLessThanOrEqual(1.25);
      expect(override.reason, id).toMatch(/run \d{8,}/);
      expect(override.reason, id).toContain(`noise ${(measured.get(id) ?? NaN).toFixed(3)}`);
    }
  });
});

describe('the confirmation of a failure by a second set of fresh pairs', () => {
  it('is taken only for a row the first pairs show credibly slower, and keeps the first pairs as the report', async () => {
    const steady = sides(() => 130, () => 100, () => 100);
    const timing = await abSpeedTiming(steady.head, steady.base, steady.reference, { pairs: AB_LIGHT_PAIRS, warmup: 0 }, steady.now);
    expect(timing.ab.confirmed).toEqual({ slower: true, lost: true });
    expect(steady.counts.head).toBe(2 * AB_LIGHT_PAIRS);
    expect(timing.runs).toBe(AB_LIGHT_PAIRS);
    const same = sides(() => 100, () => 100, () => 100);
    const quiet = await abSpeedTiming(same.head, same.base, same.reference, { pairs: AB_LIGHT_PAIRS, warmup: 0 }, same.now);
    expect(quiet.ab.confirmed).toEqual({});
    expect(same.counts.head).toBe(AB_LIGHT_PAIRS);
  });

  it('does not confirm a burst: a first set that is slow and a second that is not', async () => {
    // The head is 30 percent slower for its first 24 calls (a neighbour on the runner), then as fast as the base.
    const burst = sides((call) => (call < AB_LIGHT_PAIRS ? 130 : 100), () => 100, () => 100);
    const timing = await abSpeedTiming(burst.head, burst.base, burst.reference, { pairs: AB_LIGHT_PAIRS, warmup: 0 }, burst.now);
    expect(timing.ab.headVsBaseUpper).toBeLessThan(1 / 1.1);
    expect(timing.ab.confirmed).toEqual({ slower: false, lost: false });
  });

  it('can be switched off for a test of the first set', async () => {
    const steady = sides(() => 130, () => 100, () => 100);
    const timing = await abSpeedTiming(steady.head, steady.base, steady.reference, { pairs: AB_LIGHT_PAIRS, warmup: 0, confirm: false }, steady.now);
    expect(timing.ab.confirmed).toEqual({});
    expect(steady.counts.head).toBe(AB_LIGHT_PAIRS);
  });
});
