import { describe, expect, it } from 'vitest';
import {
  SPEED_CONFIDENCE_LEVEL,
  SPEED_HEAVY_INITIAL_PAIRS,
  SPEED_HEAVY_MAX_PAIRS,
  SPEED_LIGHT_INITIAL_PAIRS,
  SPEED_LIGHT_MAX_PAIRS,
  SPEED_MIN_PAIRS,
  SPEED_PARITY_TOLERANCE,
} from '../bench/config';
import { BenchArgumentError } from '../bench/errors';
import { adaptiveSpeedTiming, decideSpeed, HEAVY_SPEED_PLAN, LIGHT_SPEED_PLAN, signTestRank, SpeedSampleError, speedRatios } from '../bench/speed-parity';

/**
 * The speed-parity decision on hand-written paired samples. Every time below is typed in; the confidence of the
 * order-statistic interval is checked against binomial sums worked out by hand (1 - 2 P(Bin(n, 1/2) <= k - 1)).
 */

const PASS_LINE = 1 - SPEED_PARITY_TOLERANCE;
/** Reference time 100 ms for every pair, ours scaled so the pair's speed ratio is the given one. */
function pairs(ratios: number[]): { ours: number[]; reference: number[] } {
  return { ours: ratios.map((ratio) => 100 / ratio), reference: ratios.map(() => 100) };
}
function decide(ratios: number[], options?: Parameters<typeof decideSpeed>[2]): ReturnType<typeof decideSpeed> {
  const { ours, reference } = pairs(ratios);
  return decideSpeed(ours, reference, options);
}

describe('the policy constants', () => {
  it('allow ours to lose three percent of the reference speed, with a 95 percent interval', () => {
    expect(SPEED_PARITY_TOLERANCE).toBe(0.03);
    expect(PASS_LINE).toBeCloseTo(0.97, 12);
    expect(SPEED_CONFIDENCE_LEVEL).toBe(0.95);
  });

  it('start every plan at the smallest sample that can reach the confidence, and cap it', () => {
    expect(SPEED_MIN_PAIRS).toBe(6);
    expect(1 - 2 / 2 ** (SPEED_MIN_PAIRS - 1)).toBeLessThan(SPEED_CONFIDENCE_LEVEL);
    expect(1 - 2 / 2 ** SPEED_MIN_PAIRS).toBeGreaterThanOrEqual(SPEED_CONFIDENCE_LEVEL);
    for (const plan of [LIGHT_SPEED_PLAN, HEAVY_SPEED_PLAN]) {
      expect(plan.initialPairs).toBeGreaterThanOrEqual(SPEED_MIN_PAIRS);
      expect(plan.maxPairs).toBeGreaterThan(plan.initialPairs);
    }
    expect([SPEED_LIGHT_INITIAL_PAIRS, SPEED_LIGHT_MAX_PAIRS, SPEED_HEAVY_INITIAL_PAIRS, SPEED_HEAVY_MAX_PAIRS]).toEqual([7, 25, 6, 12]);
    expect([LIGHT_SPEED_PLAN.warmup, HEAVY_SPEED_PLAN.warmup]).toEqual([5, 1]);
  });
});

describe('the sign-test interval of the median ratio', () => {
  it('has no valid interval below six pairs', () => {
    for (const n of [1, 2, 3, 4, 5]) expect(signTestRank(n, 0.95)).toBe(0);
  });

  it('uses [min, max] for six and seven pairs: coverage 1 - 2/64 and 1 - 2/128', () => {
    expect(signTestRank(6, 0.95)).toBe(1);
    expect(signTestRank(7, 0.95)).toBe(1);
    expect(decide([1, 1, 1, 1, 1, 1]).confidence).toBeCloseTo(1 - 2 / 64, 12);
    expect(decide([1, 1, 1, 1, 1, 1, 1]).confidence).toBeCloseTo(1 - 2 / 128, 12);
  });

  it('widens the rank with the sample: ten pairs drop the extremes (1 - 2 * 11 / 1024), 25 pairs the lowest seven', () => {
    expect(signTestRank(10, 0.95)).toBe(2);
    expect(signTestRank(25, 0.95)).toBe(8);
    const ten = decide([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(ten.confidence).toBeCloseTo(1 - (2 * 11) / 1024, 12);
    const many = decide(Array.from({ length: 25 }, () => 1));
    expect(many.confidence).toBeCloseTo(1 - (2 * 726206) / 33554432, 12);
  });

  it('takes the order statistics of the sorted ratios as the bounds', () => {
    const ratios = [1.5, 0.8, 1.1, 1.3, 0.9, 1.2, 1.0, 1.4, 1.05, 1.15];
    const { ours, reference } = pairs(ratios);
    const decision = decideSpeed(ours, reference);
    // Sorted: 0.8 0.9 1.0 1.05 1.1 1.15 1.2 1.3 1.4 1.5; rank 2 for ten pairs.
    expect(decision.lower).toBeCloseTo(0.9, 12);
    expect(decision.upper).toBeCloseTo(1.4, 12);
    expect(decision.median).toBeCloseTo(1.125, 12);
  });

  it('rejects a sample size or confidence outside what the exact binomial sum supports', () => {
    expect(() => signTestRank(0, 0.95)).toThrow(SpeedSampleError);
    expect(() => signTestRank(65, 0.95)).toThrow(SpeedSampleError);
    expect(() => signTestRank(10, 1)).toThrow(SpeedSampleError);
    expect(() => signTestRank(10, 0)).toThrow(BenchArgumentError);
  });
});

describe('the speed decision', () => {
  it('passes when ours is clearly faster', () => {
    const { ours, reference } = pairs([1.5, 1.4, 1.6, 1.45, 1.55, 1.5, 1.52]);
    const decision = decideSpeed(ours, reference);
    expect(decision.verdict).toBe('pass');
    expect(decision.lower).toBeCloseTo(1.4, 12);
    expect(decision.upper).toBeCloseTo(1.6, 12);
    expect(decision.pairs).toBe(7);
  });

  it('passes when ours is within the tolerance below the reference and steady', () => {
    const { ours, reference } = pairs([0.99, 0.98, 1.0, 0.985, 0.995, 0.99, 0.975]);
    expect(decideSpeed(ours, reference).verdict).toBe('pass');
  });

  it('fails when the whole interval is below one minus the tolerance', () => {
    const { ours, reference } = pairs([0.5, 0.52, 0.48, 0.5, 0.51, 0.49, 0.5]);
    const decision = decideSpeed(ours, reference);
    expect(decision.verdict).toBe('fail');
    expect(decision.upper).toBeLessThan(PASS_LINE);
  });

  it('fails a steady shortfall just beyond the tolerance', () => {
    const { ours, reference } = pairs([0.95, 0.96, 0.955, 0.95, 0.96, 0.955, 0.96]);
    expect(decideSpeed(ours, reference).verdict).toBe('fail');
  });

  it('is unstable when the interval straddles the pass line', () => {
    const { ours, reference } = pairs([0.9, 0.95, 1.0, 1.05, 0.98, 1.02, 0.96]);
    const decision = decideSpeed(ours, reference);
    expect(decision.verdict).toBe('unstable');
    expect(decision.lower).toBeLessThan(PASS_LINE);
    expect(decision.upper).toBeGreaterThanOrEqual(PASS_LINE);
  });

  it('is unstable below six pairs however large the lead, since no interval reaches the confidence', () => {
    const { ours, reference } = pairs([3, 3, 3, 3, 3]);
    const decision = decideSpeed(ours, reference);
    expect(decision.verdict).toBe('unstable');
    expect(decision.lower).toBeNull();
    expect(decision.upper).toBeNull();
    expect(decision.confidence).toBeNull();
  });

  it('is not moved by one outlier: the median stays with the bulk of the pairs', () => {
    const { ours, reference } = pairs([1.2, 1.2, 1.2, 1.2, 1.2, 1.2, 0.05, 1.2, 1.2, 1.2, 1.2, 1.2]);
    const decision = decideSpeed(ours, reference);
    expect(decision.median).toBeCloseTo(1.2, 12);
    expect(decision.verdict).toBe('pass');
  });

  it('takes the tolerance from the caller', () => {
    const { ours, reference } = pairs([0.9, 0.91, 0.92, 0.9, 0.91, 0.92, 0.9]);
    expect(decideSpeed(ours, reference).verdict).toBe('fail');
    expect(decideSpeed(ours, reference, { tolerance: 0.15 }).verdict).toBe('pass');
  });

  it('throws typed errors for malformed pairs', () => {
    expect(() => decideSpeed([1, 2], [1])).toThrow(SpeedSampleError);
    expect(() => decideSpeed([], [])).toThrow(/at least one pair/);
    expect(() => speedRatios([1, 0], [1, 1])).toThrow(/pair 1/);
    expect(() => speedRatios([1, Number.NaN], [1, 1])).toThrow(SpeedSampleError);
    expect(() => speedRatios([1], [-1])).toThrow(SpeedSampleError);
    expect(() => decideSpeed([1], [1], { tolerance: 1 })).toThrow(SpeedSampleError);
  });
});

/**
 * A virtual clock: each side advances it by the duration scripted for its call, so the timing the loop sees is exactly
 * the script, whatever the machine does.
 */
function scripted(ratios: (call: number) => number) {
  let clock = 0;
  let calls = 0;
  const referenceMs = 100;
  return {
    now: () => clock,
    // The pair index is the number of times ours has run (the tests below use no warm-up).
    ours: (): void => {
      clock += referenceMs / ratios(calls++);
    },
    reference: (): void => {
      clock += referenceMs;
    },
  };
}

describe('collecting paired runs until the decision is stable', () => {
  it('stops at the initial pairs when the first interval already decides', async () => {
    const run = scripted(() => 1.5);
    let oursCalls = 0;
    const timing = await adaptiveSpeedTiming(
      () => {
        oursCalls++;
        run.ours();
      },
      run.reference,
      { ...LIGHT_SPEED_PLAN, warmup: 0 },
      run.now
    );
    expect(timing.runs).toBe(SPEED_LIGHT_INITIAL_PAIRS);
    expect(oursCalls).toBe(SPEED_LIGHT_INITIAL_PAIRS);
    expect(timing.decision.verdict).toBe('pass');
    expect(timing.unstableAtCap).toBe(false);
  });

  it('adds the warm-up rounds without timing them', async () => {
    const run = scripted(() => 2);
    let oursCalls = 0;
    const timing = await adaptiveSpeedTiming(
      () => {
        oursCalls++;
        run.ours();
      },
      run.reference,
      { ...HEAVY_SPEED_PLAN, warmup: 2 },
      run.now
    );
    expect(oursCalls).toBe(SPEED_HEAVY_INITIAL_PAIRS + 2);
    expect(timing.oursMs).toHaveLength(SPEED_HEAVY_INITIAL_PAIRS);
    expect(timing.oursMs.every((ms) => Math.abs(ms - 50) < 1e-9)).toBe(true);
  });

  it('fails at once on a clear shortfall without collecting more pairs', async () => {
    const run = scripted(() => 0.5);
    const timing = await adaptiveSpeedTiming(run.ours, run.reference, { ...LIGHT_SPEED_PLAN, warmup: 0 }, run.now);
    expect(timing.runs).toBe(SPEED_LIGHT_INITIAL_PAIRS);
    expect(timing.decision.verdict).toBe('fail');
    expect(timing.unstableAtCap).toBe(false);
  });

  it('collects more pairs while the interval straddles the line, and passes once it clears it', async () => {
    // Seven pairs with one slow outlier straddle the line; every later pair is fast, so four more clear it at 11.
    const run = scripted((pair) => (pair === 0 ? 0.95 : 1.1));
    const timing = await adaptiveSpeedTiming(run.ours, run.reference, { ...LIGHT_SPEED_PLAN, warmup: 0 }, run.now);
    expect(timing.runs).toBe(SPEED_LIGHT_INITIAL_PAIRS + LIGHT_SPEED_PLAN.step);
    expect(timing.decision.verdict).toBe('pass');
    expect(timing.unstableAtCap).toBe(false);
  });

  it('treats an interval that still straddles the line at the cap as a failure', async () => {
    // Alternating 0.8 and 1.2: the median is 1 but the interval always spans the line.
    const run = scripted((pair) => (pair % 2 === 0 ? 0.8 : 1.2));
    const timing = await adaptiveSpeedTiming(run.ours, run.reference, { ...HEAVY_SPEED_PLAN, warmup: 0 }, run.now);
    expect(timing.runs).toBe(SPEED_HEAVY_MAX_PAIRS);
    expect(timing.unstableAtCap).toBe(true);
    expect(timing.decision.verdict).toBe('fail');
    expect(timing.decision.lower).toBeLessThan(PASS_LINE);
    expect(timing.decision.upper).toBeGreaterThan(PASS_LINE);
  });

  it('alternates which side runs first, so a drifting machine favours neither', async () => {
    const order: string[] = [];
    let clock = 0;
    await adaptiveSpeedTiming(
      () => {
        order.push('ours');
        clock += 1;
      },
      () => {
        order.push('reference');
        clock += 1;
      },
      { initialPairs: 6, maxPairs: 6, step: 1, warmup: 0 },
      () => clock
    );
    expect(order.slice(0, 4)).toEqual(['ours', 'reference', 'reference', 'ours']);
    expect(order).toHaveLength(12);
  });

  it('rejects a plan that cannot reach the confidence or that exceeds the interval limit', async () => {
    const noop = (): void => undefined;
    await expect(adaptiveSpeedTiming(noop, noop, { initialPairs: 5, maxPairs: 10, step: 1, warmup: 0 }, () => 1)).rejects.toThrow(SpeedSampleError);
    await expect(adaptiveSpeedTiming(noop, noop, { initialPairs: 6, maxPairs: 5, step: 1, warmup: 0 }, () => 1)).rejects.toThrow(SpeedSampleError);
    await expect(adaptiveSpeedTiming(noop, noop, { initialPairs: 6, maxPairs: 65, step: 1, warmup: 0 }, () => 1)).rejects.toThrow(SpeedSampleError);
    await expect(adaptiveSpeedTiming(noop, noop, { initialPairs: 6, maxPairs: 8, step: 0, warmup: 0 }, () => 1)).rejects.toThrow(SpeedSampleError);
  });
});
