import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXTRA_PASS_RATIO_MARGIN,
  expectLinearScaling,
  expectNoSlowerThanReference,
  expectSizeIndependent,
  LINEAR_RATIO_SLACK,
  MAX_SCALING_PASSES,
  measureInterleaved,
  MIN_SAMPLE_MS,
  SCALING_PASSES,
  SCALING_FACTOR,
  SCALING_TEST_TIMEOUT_MS,
} from './helpers/timing';

/**
 * The timing helpers are the oracle for every complexity claim in the suite, so they are checked against
 * algorithms whose growth is known by construction: a loop of n steps, a loop of n * n steps, and work that
 * ignores its size argument.
 */

const LINEAR_STEPS_PER_UNIT = 4000;
const LINEAR_BASE = 2000;
const QUADRATIC_BASE = 1500;
const FAST_BASE = 5;
const CONSTANT_STEPS = 20_000;
const MODEST_CLAIM = 1000;
const HUGE_CLAIM = 1_000_000;
/**
 * A modest size whose quadratic run takes a fraction of a millisecond, the regime in which a fixed floor on the
 * baseline used to hide growth: 4x the size is 16x the work, and still under 10 ms.
 */
const SHORT_QUADRATIC_MODEST = 600;
const SHORT_LINEAR_MODEST = 100;
/** Steps per claimed unit for a reader that trusts the claim and walks it. */
const CLAIM_WALK_STEPS_PER_UNIT = 50;

let sink = 0;

function linearWork(n: number): void {
  let sum = 0;
  for (let i = 0; i < n * LINEAR_STEPS_PER_UNIT; i++) sum += i % 7;
  sink += sum;
}

function quadraticWork(n: number): void {
  let sum = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) sum += (i ^ j) & 3;
  }
  sink += sum;
}

function constantWork(): void {
  let sum = 0;
  for (let i = 0; i < CONSTANT_STEPS; i++) sum += i % 5;
  sink += sum;
}

function claimWalkingWork(claimed: number): void {
  let sum = 0;
  for (let i = 0; i < claimed * CLAIM_WALK_STEPS_PER_UNIT; i++) sum += i & 1;
  sink += sum;
}

describe('timing helpers separate linear from super-linear growth', () => {
  it('accepts work whose time grows in proportion to the input', async () => {
    const measurement = await expectLinearScaling('linear loop', linearWork, { baseSize: LINEAR_BASE });
    expect(measurement.ratio).toBeGreaterThan(1);
    expect(measurement.ratio).toBeLessThanOrEqual(SCALING_FACTOR * 2);
  }, SCALING_TEST_TIMEOUT_MS);

  it('rejects quadratic work with a message that names the growth', async () => {
    await expect(expectLinearScaling('quadratic loop', quadraticWork, { baseSize: QUADRATIC_BASE })).rejects.toThrow(
      /quadratic loop: 4x the input took \d+\.\d+x as long/
    );
  }, SCALING_TEST_TIMEOUT_MS);

  it('times work that finishes in microseconds by repeating it, so a fast machine measures as well as a slow one', async () => {
    // 5 units are 20,000 loop steps, tens of microseconds: far below one timer tick per run.
    const measurement = await expectLinearScaling('microsecond loop', linearWork, { baseSize: FAST_BASE });
    expect(measurement.smallMs).toBeLessThan(MIN_SAMPLE_MS);
    expect(measurement.smallSampleMs).toBeGreaterThanOrEqual(MIN_SAMPLE_MS);
    expect(measurement.ratio).toBeGreaterThan(1);
  }, SCALING_TEST_TIMEOUT_MS);

  it('refuses a comparison whose small run is too short to time', async () => {
    await expect(expectLinearScaling('trivial loop', () => undefined, { baseSize: 1 })).rejects.toThrow(
      /too short to time/
    );
  }, SCALING_TEST_TIMEOUT_MS);

  it('keeps the best of the interleaved passes of each side', async () => {
    const measurement = await measureInterleaved(
      () => linearWork(LINEAR_BASE),
      () => linearWork(LINEAR_BASE * SCALING_FACTOR)
    );
    expect(measurement.smallMs).toBeGreaterThan(0);
    expect(measurement.largeMs).toBeGreaterThan(measurement.smallMs);
    expect(measurement.ratio).toBeCloseTo(measurement.largeMs / measurement.smallMs, 10);
  }, SCALING_TEST_TIMEOUT_MS);
});

describe('size-independence check', () => {
  it('accepts a rejection that ignores the claimed size', async () => {
    await expectSizeIndependent('constant work', constantWork, { modestSize: MODEST_CLAIM, hugeSize: HUGE_CLAIM });
  }, SCALING_TEST_TIMEOUT_MS);

  it('rejects a reader whose work follows the claimed size', async () => {
    await expect(
      expectSizeIndependent('claim walker', claimWalkingWork, { modestSize: MODEST_CLAIM, hugeSize: HUGE_CLAIM })
    ).rejects.toThrow(/claim walker: the larger input took .* the work must not grow with the input/);
  }, SCALING_TEST_TIMEOUT_MS);

  it('rejects quadratic work at 4x the input even when the modest run is a fraction of a millisecond', async () => {
    await expect(
      expectSizeIndependent('short quadratic', quadraticWork, {
        modestSize: SHORT_QUADRATIC_MODEST,
        hugeSize: SHORT_QUADRATIC_MODEST * SCALING_FACTOR,
      })
    ).rejects.toThrow(/short quadratic: the larger input took .* the work must not grow with the input/);
  }, SCALING_TEST_TIMEOUT_MS);

  it('rejects linear work at 4x the input', async () => {
    await expect(
      expectSizeIndependent('short linear', linearWork, {
        modestSize: SHORT_LINEAR_MODEST,
        hugeSize: SHORT_LINEAR_MODEST * SCALING_FACTOR,
      })
    ).rejects.toThrow(/short linear: the larger input took .* the work must not grow with the input/);
  }, SCALING_TEST_TIMEOUT_MS);

  it('accepts constant work measured over the same sizes', async () => {
    await expectSizeIndependent('short constant', constantWork, {
      modestSize: SHORT_QUADRATIC_MODEST,
      hugeSize: SHORT_QUADRATIC_MODEST * SCALING_FACTOR,
    });
  }, SCALING_TEST_TIMEOUT_MS);
});

describe('reference comparison', () => {
  it('rejects a candidate that does 16x the work of a sub-millisecond reference', async () => {
    await expect(
      expectNoSlowerThanReference(
        'quadratic candidate',
        () => quadraticWork(SHORT_QUADRATIC_MODEST),
        () => quadraticWork(SHORT_QUADRATIC_MODEST * SCALING_FACTOR)
      )
    ).rejects.toThrow(/quadratic candidate: the candidate took .* for the reference/);
  }, SCALING_TEST_TIMEOUT_MS);

  it('accepts a candidate that does the same work as the reference', async () => {
    await expectNoSlowerThanReference(
      'identical candidate',
      () => quadraticWork(SHORT_QUADRATIC_MODEST),
      () => quadraticWork(SHORT_QUADRATIC_MODEST)
    );
  }, SCALING_TEST_TIMEOUT_MS);
});

describe('extra passes on a loaded runner', () => {
  // A virtual clock makes the load deterministic: each run advances it by a fixed cost, and no real time passes.
  const SMALL_COST_MS = 10;
  const LINEAR_COST_MS = SMALL_COST_MS * SCALING_FACTOR;
  const QUADRATIC_COST_MS = SMALL_COST_MS * SCALING_FACTOR * SCALING_FACTOR;
  /** Linear work slowed 2.5x reads as 10x: over the 8x bound, inside the margin that earns extra passes. */
  const LOADED_LINEAR_COST_MS = LINEAR_COST_MS * 2.5;
  /** The warm-up run and the first SCALING_PASSES passes of the large side. */
  const LOADED_LARGE_RUNS = SCALING_PASSES + 1;
  const LINEAR_BOUND = SCALING_FACTOR * LINEAR_RATIO_SLACK;

  let clockMs = 0;

  function installVirtualClock(): void {
    clockMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clockMs);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function measureWith(largeCostMs: (largeRun: number) => number, acceptRatio?: number) {
    installVirtualClock();
    let largeRuns = 0;
    return measureInterleaved(
      () => {
        clockMs += SMALL_COST_MS;
      },
      () => {
        largeRuns++;
        clockMs += largeCostMs(largeRuns);
      },
      SCALING_PASSES,
      acceptRatio
    );
  }

  it('keeps the best of three passes when no bound is given', async () => {
    const measurement = await measureWith((run) => (run <= LOADED_LARGE_RUNS ? LOADED_LINEAR_COST_MS : LINEAR_COST_MS));
    expect(measurement.ratio).toBeCloseTo(LOADED_LINEAR_COST_MS / SMALL_COST_MS, 10);
  });

  it('takes more passes when load alone put a linear run just over its bound, and then accepts it', async () => {
    const measurement = await measureWith(
      (run) => (run <= LOADED_LARGE_RUNS ? LOADED_LINEAR_COST_MS : LINEAR_COST_MS),
      LINEAR_BOUND
    );
    expect(measurement.ratio).toBeCloseTo(SCALING_FACTOR, 10);
  });

  it('still refuses work that is slow on every pass, however many passes it takes', async () => {
    let largeRuns = 0;
    const measurement = await measureWith((run) => {
      largeRuns = run;
      return LOADED_LINEAR_COST_MS;
    }, LINEAR_BOUND);
    expect(measurement.ratio).toBeCloseTo(LOADED_LINEAR_COST_MS / SMALL_COST_MS, 10);
    expect(measurement.ratio).toBeGreaterThan(LINEAR_BOUND);
    // The warm-up run plus one run per pass, up to the cap.
    expect(largeRuns).toBe(MAX_SCALING_PASSES + 1);
  });

  it('refuses quadratic work after the first passes without retrying it', async () => {
    let largeRuns = 0;
    const measurement = await measureWith(() => {
      largeRuns++;
      return QUADRATIC_COST_MS;
    }, LINEAR_BOUND);
    expect(measurement.ratio).toBeGreaterThan(LINEAR_BOUND * EXTRA_PASS_RATIO_MARGIN);
    expect(largeRuns).toBe(SCALING_PASSES + 1);
  });
});
