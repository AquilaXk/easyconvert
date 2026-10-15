import { describe, expect, it } from 'vitest';
import {
  SPEED_CONFIDENCE_LEVEL,
  SPEED_HEAVY_EXTENDED_MAX_PAIRS,
  SPEED_HEAVY_INITIAL_PAIRS,
  SPEED_HEAVY_MAX_PAIRS,
  SPEED_LIGHT_EXTENDED_MAX_PAIRS,
  SPEED_LIGHT_INITIAL_PAIRS,
  SPEED_LIGHT_MAX_PAIRS,
  SPEED_MAX_SAMPLE_REPEATS,
  SPEED_MIN_PAIRS,
  SPEED_MIN_SAMPLE_MS,
  SPEED_PARITY_TOLERANCE,
} from '../bench/config';
import { createContext } from '../bench/context';
import { BenchArgumentError } from '../bench/errors';
import { ReferenceCache } from '../bench/ref-cache';
import { type AdaptiveTiming, adaptiveSpeedTiming, calibrateRepeats, decideSpeed, HEAVY_SPEED_PLAN, LIGHT_SPEED_PLAN, signTestRank, SpeedSampleError, speedRatios } from '../bench/speed-parity';

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

  it('give a row still undecided at its cap a second cap, within the 64 pairs the interval is exact for', () => {
    expect([SPEED_LIGHT_EXTENDED_MAX_PAIRS, SPEED_HEAVY_EXTENDED_MAX_PAIRS]).toEqual([50, 36]);
    expect(LIGHT_SPEED_PLAN.extendedMaxPairs).toBe(SPEED_LIGHT_EXTENDED_MAX_PAIRS);
    expect(HEAVY_SPEED_PLAN.extendedMaxPairs).toBe(SPEED_HEAVY_EXTENDED_MAX_PAIRS);
    for (const plan of [LIGHT_SPEED_PLAN, HEAVY_SPEED_PLAN]) {
      expect(plan.extendedMaxPairs).toBeGreaterThan(plan.maxPairs);
      expect(plan.extendedMaxPairs).toBeLessThanOrEqual(64);
    }
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

  it('goes on to the second cap while the interval straddles the line, and stops there with unstableAtCap', async () => {
    // Alternating 0.8 and 1.2: the median is 1 but the interval always spans the line.
    const run = scripted((pair) => (pair % 2 === 0 ? 0.8 : 1.2));
    const timing = await adaptiveSpeedTiming(run.ours, run.reference, { ...HEAVY_SPEED_PLAN, warmup: 0 }, run.now);
    expect(timing.runs).toBe(SPEED_HEAVY_EXTENDED_MAX_PAIRS);
    expect(timing.unstableAtCap).toBe(true);
    expect(timing.decision.verdict).toBe('fail');
    expect(timing.decision.lower).toBeLessThan(PASS_LINE);
    expect(timing.decision.upper).toBeGreaterThan(PASS_LINE);
  });

  it('extends only a row that is undecided at the first cap, and stops as soon as the extension decides', async () => {
    // Undecided through the first cap (every third pair slow), then every pair is fast: the interval clears the line during the extension.
    const late = scripted((pair) => (pair < SPEED_HEAVY_MAX_PAIRS ? (pair % 3 === 0 ? 0.8 : 1.2) : 1.4));
    const extended = await adaptiveSpeedTiming(late.ours, late.reference, { ...HEAVY_SPEED_PLAN, warmup: 0 }, late.now);
    expect(extended.runs).toBeGreaterThan(SPEED_HEAVY_MAX_PAIRS);
    expect(extended.runs).toBeLessThanOrEqual(SPEED_HEAVY_EXTENDED_MAX_PAIRS);
    expect(extended.decision.verdict).toBe('pass');
    expect(extended.unstableAtCap).toBe(false);
    // A row that decides before the first cap collects nothing more, whatever the second cap is.
    const early = scripted((pair) => (pair === 0 ? 0.95 : 1.1));
    const stopped = await adaptiveSpeedTiming(early.ours, early.reference, { ...HEAVY_SPEED_PLAN, warmup: 0 }, early.now);
    expect(stopped.runs).toBeLessThan(SPEED_HEAVY_MAX_PAIRS);
    // Without a second cap the plan stops at the first.
    const plain = scripted((pair) => (pair % 2 === 0 ? 0.8 : 1.2));
    const capped = await adaptiveSpeedTiming(plain.ours, plain.reference, { ...HEAVY_SPEED_PLAN, extendedMaxPairs: undefined, warmup: 0 }, plain.now);
    expect(capped.runs).toBe(SPEED_HEAVY_MAX_PAIRS);
    expect(capped.unstableAtCap).toBe(true);
  });

  it('refuses a second cap beyond the pairs the interval is exact for', async () => {
    const run = scripted(() => 1);
    await expect(adaptiveSpeedTiming(run.ours, run.reference, { ...HEAVY_SPEED_PLAN, extendedMaxPairs: 65, warmup: 0 }, run.now)).rejects.toThrow(SpeedSampleError);
  });

  it('times several back-to-back calls of ours per sample and records the mean per call', async () => {
    // Calls of ours alternate 10 ms and 90 ms, a jitter that decides a single call but cancels over two.
    let clock = 0;
    let oursCalls = 0;
    const ours = (): void => {
      clock += oursCalls++ % 2 === 0 ? 10 : 90;
    };
    const reference = (): void => {
      clock += 100;
    };
    const batched = await adaptiveSpeedTiming(ours, reference, { ...LIGHT_SPEED_PLAN, warmup: 0, oursRepeats: 2 }, () => clock);
    expect(oursCalls).toBe(SPEED_LIGHT_INITIAL_PAIRS * 2);
    expect(batched.oursMs).toEqual(Array(SPEED_LIGHT_INITIAL_PAIRS).fill(50));
    expect(batched.runs).toBe(SPEED_LIGHT_INITIAL_PAIRS);
    expect(batched.decision).toMatchObject({ verdict: 'pass', median: 2, lower: 2, upper: 2 });

    // One call per sample sees the jitter itself: ratios of 10 and 1.11 alternate.
    clock = 0;
    oursCalls = 0;
    const single = await adaptiveSpeedTiming(ours, reference, { ...LIGHT_SPEED_PLAN, warmup: 0 }, () => clock);
    expect(new Set(single.oursMs.slice(0, 4))).toEqual(new Set([10, 90]));
  });

  it('rejects a repeat count that is not a positive integer', async () => {
    const noop = (): void => undefined;
    await expect(adaptiveSpeedTiming(noop, noop, { ...LIGHT_SPEED_PLAN, oursRepeats: 0 }, () => 1)).rejects.toThrow(SpeedSampleError);
    await expect(adaptiveSpeedTiming(noop, noop, { ...LIGHT_SPEED_PLAN, oursRepeats: 1.5 }, () => 1)).rejects.toThrow(SpeedSampleError);
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

describe('calibrating the calls per sample so every sample lasts long enough', () => {
  it('names a minimum of 50 ms and a cap of 1000 calls', () => {
    expect(SPEED_MIN_SAMPLE_MS).toBe(50);
    expect(SPEED_MAX_SAMPLE_REPEATS).toBe(1000);
    expect(LIGHT_SPEED_PLAN.minSampleMs).toBe(SPEED_MIN_SAMPLE_MS);
    expect(HEAVY_SPEED_PLAN.minSampleMs).toBe(SPEED_MIN_SAMPLE_MS);
  });

  it.each([
    // [call ms, min ms, expected calls]: the smallest count whose total reaches the minimum.
    [2, 50, 25],
    [0.5, 50, 100],
    [3, 50, 17],
    [50, 50, 1],
    [80, 50, 1],
    [4000, 50, 1],
    [0.01, 50, 1000],
    [0, 50, 1000],
    [2, 0, 1],
  ])('takes %f ms per call and a %f ms minimum to %i calls', (callMs, minMs, expected) => {
    expect(calibrateRepeats(callMs, minMs, SPEED_MAX_SAMPLE_REPEATS)).toBe(expected);
  });

  it('caps the calls at the requested maximum and rejects malformed inputs', () => {
    expect(calibrateRepeats(0.01, 50, 10)).toBe(10);
    expect(() => calibrateRepeats(1, -1, 10)).toThrow(SpeedSampleError);
    expect(() => calibrateRepeats(1, Number.NaN, 10)).toThrow(SpeedSampleError);
    expect(() => calibrateRepeats(1, 50, 0)).toThrow(SpeedSampleError);
    expect(() => calibrateRepeats(1, 50, 2.5)).toThrow(SpeedSampleError);
    expect(() => calibrateRepeats(-1, 50, 10)).toThrow(SpeedSampleError);
    expect(() => calibrateRepeats(Number.NaN, 50, 10)).toThrow(SpeedSampleError);
  });

  /** A virtual clock where each side advances time by its own per-call duration (a call can be scripted per call index). */
  function clocked(oursCallMs: (call: number) => number, referenceCallMs: (call: number) => number) {
    let clock = 0;
    const calls = { ours: 0, reference: 0 };
    return {
      now: () => clock,
      calls,
      ours: (): void => {
        clock += oursCallMs(calls.ours++);
      },
      reference: (): void => {
        clock += referenceCallMs(calls.reference++);
      },
    };
  }

  it('batches each side from its fastest warm-up call, so every timed sample lasts at least the minimum', async () => {
    // Ours takes 2 ms a call, the reference 0.5 ms: 25 and 100 calls make 50 ms.
    const run = clocked(() => 2, () => 0.5);
    const plan = { ...LIGHT_SPEED_PLAN, warmup: 3, minSampleMs: 50 };
    const timing = await adaptiveSpeedTiming(run.ours, run.reference, plan, run.now);
    expect(timing.repeats).toEqual({ ours: 25, reference: 100 });
    expect(run.calls.ours).toBe(3 + timing.runs * 25);
    expect(run.calls.reference).toBe(3 + timing.runs * 100);
    // The sample is the mean per call, and the whole sample lasted repeats * per-call time = 50 ms on both sides.
    expect(timing.oursMs).toEqual(Array(timing.runs).fill(2));
    expect(timing.referenceMs).toEqual(Array(timing.runs).fill(0.5));
    expect(timing.oursMs.every((ms) => ms * timing.repeats.ours >= 50)).toBe(true);
    expect(timing.referenceMs.every((ms) => ms * timing.repeats.reference >= 50)).toBe(true);
    expect(timing.decision).toMatchObject({ verdict: 'fail', median: 0.25 });
  });

  it('takes the fastest warm-up call, not the first, which is slowed by a cold start', async () => {
    // The first call of ours takes 30 ms, then 2 ms: calibrating on the first would give 2 calls, not 25.
    const run = clocked((call) => (call === 0 ? 30 : 2), () => 5);
    const timing = await adaptiveSpeedTiming(run.ours, run.reference, { ...LIGHT_SPEED_PLAN, warmup: 3, minSampleMs: 50 }, run.now);
    expect(timing.repeats).toEqual({ ours: 25, reference: 10 });
  });

  it('keeps one call per sample for a side that already lasts the minimum, and does not calibrate without warm-up rounds', async () => {
    const slow = clocked(() => 80, () => 60);
    const long = await adaptiveSpeedTiming(slow.ours, slow.reference, { ...HEAVY_SPEED_PLAN, warmup: 1, minSampleMs: 50 }, slow.now);
    expect(long.repeats).toEqual({ ours: 1, reference: 1 });
    expect(slow.calls.ours).toBe(1 + long.runs);

    const quick = clocked(() => 2, () => 2);
    const uncalibrated = await adaptiveSpeedTiming(quick.ours, quick.reference, { ...LIGHT_SPEED_PLAN, warmup: 0, minSampleMs: 50 }, quick.now);
    expect(uncalibrated.repeats).toEqual({ ours: 1, reference: 1 });
  });

  it('never goes below the calls a family asked of ours, and never above the cap', async () => {
    const run = clocked(() => 2, () => 0.01);
    const timing = await adaptiveSpeedTiming(run.ours, run.reference, { ...LIGHT_SPEED_PLAN, warmup: 2, minSampleMs: 50, oursRepeats: 40, maxRepeats: 60 }, run.now);
    expect(timing.repeats).toEqual({ ours: 40, reference: 60 });
  });

  it('still alternates which side runs first', async () => {
    const order: string[] = [];
    let clock = 0;
    await adaptiveSpeedTiming(
      () => {
        order.push('ours');
        clock += 25;
      },
      () => {
        order.push('reference');
        clock += 25;
      },
      { initialPairs: 6, maxPairs: 6, step: 1, warmup: 1, minSampleMs: 50 },
      () => clock
    );
    // One warm-up round, then 6 pairs of 2 calls per side: ours first in pair 0, the reference first in pair 1.
    expect(order.slice(0, 2)).toEqual(['ours', 'reference']);
    expect(order.slice(2, 6)).toEqual(['ours', 'ours', 'reference', 'reference']);
    expect(order.slice(6, 10)).toEqual(['reference', 'reference', 'ours', 'ours']);
  });
});

describe('the timing a family asks of its context', () => {
  const context = (parity: boolean) =>
    createContext({
      resolve: () => null,
      strict: true,
      runs: 6,
      heavyRuns: 3,
      warmup: 0,
      injection: null,
      parity,
      quality: true,
      speed: true,
      quick: false,
      refCache: new ReferenceCache({ dir: null, toolVersion: () => null, fileHash: () => '', harnessHash: () => '', log: () => undefined }),
      work: '/nonexistent',
      log: () => undefined,
    });

  it('calls ours the requested number of times per sample in a fixed-run benchmark', async () => {
    let oursCalls = 0;
    let referenceCalls = 0;
    const timing = await context(false).time(
      'compression/case/throughput',
      async () => {
        oursCalls++;
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
      () => {
        referenceCalls++;
      },
      'light',
      3
    );
    expect(oursCalls).toBe(timing.runs * 3);
    expect(referenceCalls).toBe(timing.runs);
  });

  it('calibrates the calls per sample in a parity run, with the requested number as the least for ours', async () => {
    let oursCalls = 0;
    let referenceCalls = 0;
    const logged: string[] = [];
    const parityContext = createContext({
      resolve: () => null,
      strict: true,
      runs: 6,
      heavyRuns: 3,
      warmup: 0,
      injection: null,
      parity: true,
      quality: true,
      speed: true,
      quick: false,
      refCache: new ReferenceCache({ dir: null, toolVersion: () => null, fileHash: () => '', harnessHash: () => '', log: () => undefined }),
      work: '/nonexistent',
      log: (message) => logged.push(message),
    });
    const timing = (await parityContext.time(
      'compression/case/throughput',
      () => {
        oursCalls++;
      },
      () => {
        referenceCalls++;
      },
      'light',
      3
    )) as AdaptiveTiming;
    expect(timing.repeats.ours).toBeGreaterThanOrEqual(3);
    expect(oursCalls).toBe(LIGHT_SPEED_PLAN.warmup + timing.runs * timing.repeats.ours);
    expect(referenceCalls).toBe(LIGHT_SPEED_PLAN.warmup + timing.runs * timing.repeats.reference);
    // Both sides return at once, so each sample is batched up to the cap, and the log says so.
    expect(logged.some((line) => line.startsWith(`samples of at least ${SPEED_MIN_SAMPLE_MS} ms`))).toBe(true);
  });

  it('calls ours once per sample unless asked for more', async () => {
    let oursCalls = 0;
    const timing = await context(false).time(
      'compression/case/throughput',
      async () => {
        oursCalls++;
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
      () => undefined,
      'light'
    );
    expect(oursCalls).toBe(timing.runs);
  });
});
