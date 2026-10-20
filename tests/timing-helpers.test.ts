import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  expectLinearScaling,
  expectNoHangOnInput,
  expectNoSlowerThanReference,
  expectSizeIndependent,
  LINEAR_RATIO_SLACK,
  MAX_SCALING_PASSES,
  measureInterleaved,
  MIN_SAMPLE_MS,
  SCALING_PASSES,
  SCALING_FACTOR,
  SCALING_TEST_TIMEOUT_MS,
  cpuClockMs,
  WARMUP_STEADY_RUNS,
  warmUpUntilSteady,
} from './helpers/timing';

/**
 * The timing helpers are the oracle for every complexity claim in the suite, so they are checked against work whose
 * growth is known by construction. The classification is checked on a virtual clock: each run of the work advances
 * the clock by a cost that is a fixed function of its input size, and no real time passes, so the verdict is exact
 * on a runner of any speed and load. One case at the end times real loops (on the CPU clock) to show that the helpers
 * work on real time as well.
 */

/** Cost, in virtual milliseconds, of one run of work that is linear, quadratic or independent of its input size. */
const LINEAR_MS_PER_UNIT = 0.01;
const QUADRATIC_MS_PER_UNIT = 0.00001;
const CONSTANT_MS = 10;
/** A run this cheap lasts about 2 microseconds: far below one timer tick, so the helper has to repeat it. */
const MICROSECOND_MS_PER_UNIT = 0.0004;
const LINEAR_BASE = 2000;
const QUADRATIC_BASE = 1500;
const FAST_BASE = 5;
const MODEST_CLAIM = 1000;
const HUGE_CLAIM = 1_000_000;
const SHORT_QUADRATIC_MODEST = 600;
const SHORT_LINEAR_MODEST = 100;
/** Cost per claimed unit of a reader that trusts the claim and walks it. */
const CLAIM_WALK_MS_PER_UNIT = 0.01;
const SHORT_QUADRATIC_MS_PER_UNIT = 0.00005;
const SHORT_LINEAR_MS_PER_UNIT = 0.1;

/** A clock that moves only when work runs; `work(costOf)` is work that costs `costOf(size)` per run. */
function virtualTime(): { clock: () => number; work: (costOf: (size: number) => number) => (size: number) => void } {
  let now = 0;
  return {
    clock: () => now,
    work: (costOf) => (size) => {
      now += costOf(size);
    },
  };
}

const linearCost = (size: number): number => size * LINEAR_MS_PER_UNIT;
const quadraticCost = (size: number): number => size * size * QUADRATIC_MS_PER_UNIT;

describe('timing helpers separate linear from super-linear growth', () => {
  it('accepts work whose time grows in proportion to the input', async () => {
    const time = virtualTime();
    const measurement = await expectLinearScaling('linear loop', time.work(linearCost), { baseSize: LINEAR_BASE, clock: time.clock });
    expect(measurement.ratio).toBeCloseTo(SCALING_FACTOR, 10);
  }, SCALING_TEST_TIMEOUT_MS);

  it('rejects quadratic work with a message that names the growth', async () => {
    const time = virtualTime();
    await expect(
      expectLinearScaling('quadratic loop', time.work(quadraticCost), { baseSize: QUADRATIC_BASE, clock: time.clock })
    ).rejects.toThrow(/quadratic loop: 4x the input took 16\.00x as long/);
  }, SCALING_TEST_TIMEOUT_MS);

  it('times work that finishes in microseconds by repeating it, so a fast machine measures as well as a slow one', async () => {
    const time = virtualTime();
    const measurement = await expectLinearScaling('microsecond loop', time.work((size) => size * MICROSECOND_MS_PER_UNIT), {
      baseSize: FAST_BASE,
      clock: time.clock,
    });
    expect(measurement.smallMs).toBeLessThan(MIN_SAMPLE_MS);
    expect(measurement.smallSampleMs).toBeGreaterThanOrEqual(MIN_SAMPLE_MS);
    expect(measurement.ratio).toBeCloseTo(SCALING_FACTOR, 10);
  }, SCALING_TEST_TIMEOUT_MS);

  it('refuses a comparison whose small run is too short to time', async () => {
    const time = virtualTime();
    await expect(expectLinearScaling('trivial loop', () => undefined, { baseSize: 1, clock: time.clock })).rejects.toThrow(
      /too short to time/
    );
  }, SCALING_TEST_TIMEOUT_MS);

  it('keeps the best of the interleaved passes of each side', async () => {
    // Call 0 of each side is the warm-up, which is not timed; the three passes cost 20, 10 and 30 ms against 100, 90 and 200 ms.
    const SMALL_COSTS = [50, 20, 10, 30];
    const LARGE_COSTS = [500, 100, 90, 200];
    let now = 0;
    let smallCalls = 0;
    let largeCalls = 0;
    const measurement = await measureInterleaved(
      () => {
        now += SMALL_COSTS[smallCalls++];
      },
      () => {
        now += LARGE_COSTS[largeCalls++];
      },
      SMALL_COSTS.length - 1,
      undefined,
      () => now
    );
    expect(measurement.smallMs).toBe(10);
    expect(measurement.largeMs).toBe(90);
    expect(measurement.ratio).toBe(9);
  }, SCALING_TEST_TIMEOUT_MS);
});

describe('size-independence check', () => {
  const constantCost = (): number => CONSTANT_MS;

  it('accepts a rejection that ignores the claimed size', async () => {
    const time = virtualTime();
    const measurement = await expectSizeIndependent('constant work', time.work(constantCost), {
      modestSize: MODEST_CLAIM,
      hugeSize: HUGE_CLAIM,
      clock: time.clock,
    });
    expect(measurement.ratio).toBe(1);
  }, SCALING_TEST_TIMEOUT_MS);

  it('rejects a reader whose work follows the claimed size', async () => {
    const time = virtualTime();
    await expect(
      expectSizeIndependent('claim walker', time.work((claimed) => claimed * CLAIM_WALK_MS_PER_UNIT), {
        modestSize: MODEST_CLAIM,
        hugeSize: HUGE_CLAIM,
        clock: time.clock,
      })
    ).rejects.toThrow(/claim walker: the larger input took .* the work must not grow with the input/);
  }, SCALING_TEST_TIMEOUT_MS);

  it('rejects quadratic work at 4x the input even when the modest run is a fraction of a second', async () => {
    const time = virtualTime();
    await expect(
      expectSizeIndependent('short quadratic', time.work((size) => size * size * SHORT_QUADRATIC_MS_PER_UNIT), {
        modestSize: SHORT_QUADRATIC_MODEST,
        hugeSize: SHORT_QUADRATIC_MODEST * SCALING_FACTOR,
        clock: time.clock,
      })
    ).rejects.toThrow(/short quadratic: the larger input took .* the work must not grow with the input/);
  }, SCALING_TEST_TIMEOUT_MS);

  it('rejects linear work at 4x the input', async () => {
    const time = virtualTime();
    await expect(
      expectSizeIndependent('short linear', time.work((size) => size * SHORT_LINEAR_MS_PER_UNIT), {
        modestSize: SHORT_LINEAR_MODEST,
        hugeSize: SHORT_LINEAR_MODEST * SCALING_FACTOR,
        clock: time.clock,
      })
    ).rejects.toThrow(/short linear: the larger input took .* the work must not grow with the input/);
  }, SCALING_TEST_TIMEOUT_MS);

  it('accepts constant work measured over the same sizes', async () => {
    const time = virtualTime();
    await expectSizeIndependent('short constant', time.work(constantCost), {
      modestSize: SHORT_QUADRATIC_MODEST,
      hugeSize: SHORT_QUADRATIC_MODEST * SCALING_FACTOR,
      clock: time.clock,
    });
  }, SCALING_TEST_TIMEOUT_MS);
});

describe('reference comparison', () => {
  const REFERENCE_MS = 6;

  it('rejects a candidate that does 16x the work of a sub-millisecond reference', async () => {
    const time = virtualTime();
    const reference = time.work(() => REFERENCE_MS);
    const candidate = time.work(() => REFERENCE_MS * SCALING_FACTOR * SCALING_FACTOR);
    await expect(
      expectNoSlowerThanReference('quadratic candidate', () => reference(0), () => candidate(0), { clock: time.clock })
    ).rejects.toThrow(/quadratic candidate: the candidate took .* for the reference/);
  }, SCALING_TEST_TIMEOUT_MS);

  it('accepts a candidate that does the same work as the reference', async () => {
    const time = virtualTime();
    const same = time.work(() => REFERENCE_MS);
    const measurement = await expectNoSlowerThanReference('identical candidate', () => same(0), () => same(0), { clock: time.clock });
    expect(measurement.ratio).toBe(1);
  }, SCALING_TEST_TIMEOUT_MS);
});

describe('extra passes on a loaded runner', () => {
  // A virtual clock makes the load deterministic: each run advances it by a fixed cost, and no real time passes.
  const SMALL_COST_MS = 10;
  const LINEAR_COST_MS = SMALL_COST_MS * SCALING_FACTOR;
  const QUADRATIC_COST_MS = SMALL_COST_MS * SCALING_FACTOR * SCALING_FACTOR;
  /** Linear work slowed 2.5x reads as 10x: over the 8x bound. */
  const LOADED_LINEAR_COST_MS = LINEAR_COST_MS * 2.5;
  /** Linear work slowed 3.3x reads as 13.2x, as the table-of-contents case of the MOBI reader did on a loaded runner. */
  const FAR_OVER_LINEAR_COST_MS = LINEAR_COST_MS * 3.3;
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

  it('takes more passes when load put a linear run far over its bound, and then accepts it', async () => {
    const measurement = await measureWith(
      (run) => (run <= LOADED_LARGE_RUNS ? FAR_OVER_LINEAR_COST_MS : LINEAR_COST_MS),
      LINEAR_BOUND
    );
    expect(measurement.ratio).toBeCloseTo(SCALING_FACTOR, 10);
  });

  it('refuses quadratic work on every pass, however many passes it takes', async () => {
    let largeRuns = 0;
    const measurement = await measureWith(() => {
      largeRuns++;
      return QUADRATIC_COST_MS;
    }, LINEAR_BOUND);
    expect(measurement.ratio).toBeCloseTo(SCALING_FACTOR * SCALING_FACTOR, 10);
    expect(measurement.ratio).toBeGreaterThan(LINEAR_BOUND);
    expect(largeRuns).toBe(MAX_SCALING_PASSES + 1);
  });
});

describe('expectNoHangOnInput', () => {
  const GUARD_MS = 50;
  const SLOW_WORK_MS = 120;

  it('runs the work once, on the given input, and returns its result as largeResult', async () => {
    const seen: number[] = [];
    const { largeResult } = await expectNoHangOnInput('doubling', (input: number) => {
      seen.push(input);
      return input * 2;
    }, 21);
    expect(seen).toEqual([21]);
    expect(largeResult).toBe(42);
  });

  it('awaits asynchronous work', async () => {
    const { largeResult } = await expectNoHangOnInput('async', async (input: string) => input.toUpperCase(), 'abc');
    expect(largeResult).toBe('ABC');
  });

  it('fails, naming the label and the guard, when the work outlasts the guard', async () => {
    const slow = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, SLOW_WORK_MS));
    await expect(expectNoHangOnInput('stuck parse', slow, null, GUARD_MS)).rejects.toThrow(/stuck parse: took \d+ ms; the hang guard is 50 ms/);
  });

  it('passes an error thrown by the work through unchanged', async () => {
    const failure = new RangeError('typed refusal');
    await expect(
      expectNoHangOnInput('throws', () => {
        throw failure;
      }, 0)
    ).rejects.toBe(failure);
  });
});

describe('warm-up until the time of the work is steady', () => {
  /**
   * A clock the work itself advances: each run of the work "takes" the cost the plan gives it, so the plan is exact on a
   * busy runner too, where real time would stretch a run or add pauses between them.
   */
  function plannedRuns(costOf: (run: number) => number): { clock: () => number; work: () => void; costs: number[] } {
    let now = 0;
    const costs: number[] = [];
    return {
      clock: () => now,
      work: () => {
        const cost = costOf(costs.length);
        costs.push(cost);
        now += cost;
      },
      costs,
    };
  }
  const SLOW_MS = 3;
  const FAST_MS = 1;
  const PLATEAU_RUNS = 12;
  const SHORT_MIN_MS = 80;

  it('runs on through a plateau of equal times until the work gets faster and then settles at the new speed', async () => {
    const plan = plannedRuns((run) => (run < PLATEAU_RUNS ? SLOW_MS : FAST_MS));
    const runs = await warmUpUntilSteady(plan.work, { minMs: SHORT_MIN_MS, clock: plan.clock });
    expect(runs).toBe(plan.costs.length);
    // More than WARMUP_STEADY_RUNS slow runs in a row did not end it: the minimum duration had not passed (12 x 3 ms < 80 ms).
    expect(PLATEAU_RUNS).toBeGreaterThan(WARMUP_STEADY_RUNS);
    expect(plan.costs.slice(0, PLATEAU_RUNS)).toEqual(Array(PLATEAU_RUNS).fill(SLOW_MS));
    expect(plan.costs.slice(-WARMUP_STEADY_RUNS)).toEqual(Array(WARMUP_STEADY_RUNS).fill(FAST_MS));
  });

  it('stops at the first run after the minimum duration when the time has been steady', async () => {
    const plan = plannedRuns(() => FAST_MS);
    const runs = await warmUpUntilSteady(plan.work, { minMs: SHORT_MIN_MS, clock: plan.clock });
    expect(runs).toBe(SHORT_MIN_MS / FAST_MS);
  });

  it('does not stop before WARMUP_STEADY_RUNS steady runs even when the minimum duration has passed', async () => {
    const plan = plannedRuns((run) => (run < 5 ? 40 : FAST_MS));
    const runs = await warmUpUntilSteady(plan.work, { minMs: SHORT_MIN_MS, clock: plan.clock });
    expect(plan.costs.slice(-WARMUP_STEADY_RUNS)).toEqual(Array(WARMUP_STEADY_RUNS).fill(FAST_MS));
    expect(runs).toBe(5 + WARMUP_STEADY_RUNS + 1);
  });

  it('gives up at the run limit for work that keeps getting faster', async () => {
    const maxRuns = 15;
    const plan = plannedRuns((run) => 6 * 0.8 ** run);
    const runs = await warmUpUntilSteady(plan.work, { minMs: SHORT_MIN_MS, maxRuns, clock: plan.clock });
    expect(runs).toBe(maxRuns);
  });

  it('gives up at the time limit for work that never settles within it', async () => {
    const plan = plannedRuns((run) => 10 * 0.9 ** run);
    const runs = await warmUpUntilSteady(plan.work, { minMs: SHORT_MIN_MS, maxMs: 30, clock: plan.clock });
    expect(runs).toBeLessThan(10);
    expect(plan.costs.reduce((sum, cost) => sum + cost, 0)).toBeGreaterThanOrEqual(30);
  });
});

describe('the CPU clock', () => {
  let sink = 0;

  function quadraticLoop(n: number): void {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) sum += (i ^ j) & 3;
    }
    sink += sum;
  }

  const SLEEP_MS = 60;
  const BUSY_CPU_MS = 10;

  it('stands still while the process waits and moves while it works', async () => {
    const idleStart = cpuClockMs();
    await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
    expect(cpuClockMs() - idleStart).toBeLessThan(SLEEP_MS / 2);
    // Moves: this loop ends only once the clock has been charged BUSY_CPU_MS, however long a busy runner takes to give them.
    const busyStart = cpuClockMs();
    let spins = 0;
    while (cpuClockMs() - busyStart < BUSY_CPU_MS) spins += 1;
    expect(spins).toBeGreaterThan(0);
  });

  // The one case on real time: 4x the input of a loop of n * n steps is 16x the work, twice the 8x bound, and the CPU clock
  // does not charge the process for the time it waits for a core.
  it('still tells a linear loop from a quadratic one when it is the clock of the comparison', async () => {
    const measurement = await measureInterleaved(
      () => quadraticLoop(QUADRATIC_BASE),
      () => quadraticLoop(QUADRATIC_BASE * SCALING_FACTOR),
      SCALING_PASSES,
      undefined,
      cpuClockMs
    );
    expect(measurement.ratio).toBeGreaterThan(SCALING_FACTOR * LINEAR_RATIO_SLACK);
  });
});
