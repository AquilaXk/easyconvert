import { expect } from 'vitest';

/**
 * Load-robust timing assertions.
 *
 * An absolute wall-clock budget ("under 2 s") measures the runner as much as the code: a loaded CI shard
 * runs the same work several times slower, and the test fails without any regression. These helpers keep
 * the claim and drop the dependency on machine speed:
 *
 * - a complexity claim ("linear time") times the same work at n and at k * n, interleaved pass by pass,
 *   keeps the best pass of each size, and bounds the ratio of the two. Load that slows the machine hits
 *   both sizes, so the ratio stays put; a super-linear algorithm shows up as a ratio near k^2 or worse.
 * - a hang guard is an absolute ceiling far above the expected time. It catches an algorithm that never
 *   finishes, not one that is merely slow.
 */

/**
 * Explicit timeout for a test that runs a scaling comparison: it executes the work 2 x (passes + 1) times, which
 * can pass the 5 s default on a loaded shard even when nothing regressed.
 */
export const SCALING_TEST_TIMEOUT_MS = 60_000;
/** Interleaved passes per comparison; the best pass of each side is kept. */
export const SCALING_PASSES = 3;
/** The input grows by this factor between the small and the large run. */
export const SCALING_FACTOR = 4;
/**
 * A linear algorithm may take up to SCALING_FACTOR * LINEAR_RATIO_SLACK times as long on the larger input
 * (cache effects, allocator growth). With SCALING_FACTOR = 4 the bound is 8x, where a quadratic algorithm
 * takes 16x and a cubic one 64x.
 */
export const LINEAR_RATIO_SLACK = 2;
/**
 * The small run must take at least this long for the ratio to mean anything; below it a timer tick or a
 * garbage collection dominates. A test whose small run is faster than this has to use a bigger input.
 */
export const MIN_MEASURABLE_MS = 1;
/** Baseline floor for size-independence checks: a sub-millisecond rejection is compared against this instead. */
export const SIZE_INDEPENDENT_FLOOR_MS = 5;
/** Ceiling on how much longer a bounded-work rejection may take when the claimed size grows. */
export const CONSTANT_RATIO_BOUND = 4;
/** Multiplier from the time a healthy run needs to the absolute ceiling that only catches a hang. */
export const HANG_GUARD_MULTIPLE = 10;

export interface ScalingMeasurement {
  smallMs: number;
  largeMs: number;
  /** largeMs / smallMs. */
  ratio: number;
}

async function timeOnce(work: () => unknown): Promise<number> {
  const started = performance.now();
  await work();
  return performance.now() - started;
}

/**
 * Times `small` and `large` alternately for `passes` rounds (after one warm-up of each) and returns the
 * best time of each.
 */
export async function measureInterleaved(
  small: () => unknown,
  large: () => unknown,
  passes: number = SCALING_PASSES
): Promise<ScalingMeasurement> {
  await small();
  await large();
  let smallMs = Number.POSITIVE_INFINITY;
  let largeMs = Number.POSITIVE_INFINITY;
  for (let pass = 0; pass < passes; pass++) {
    smallMs = Math.min(smallMs, await timeOnce(small));
    largeMs = Math.min(largeMs, await timeOnce(large));
  }
  return { smallMs, largeMs, ratio: largeMs / smallMs };
}

export interface ScalingOptions {
  /** Input size of the small run; `run` receives it unchanged. */
  baseSize: number;
  factor?: number;
  passes?: number;
  /** Largest allowed largeMs / smallMs. Defaults to factor * LINEAR_RATIO_SLACK. */
  maxRatio?: number;
}

/**
 * Asserts that `run(factor * baseSize)` takes no more than `maxRatio` times as long as `run(baseSize)`.
 * `run` builds its input for the given size and exercises the code under test; it may assert on the output.
 */
export async function expectLinearScaling(
  label: string,
  run: (size: number) => unknown,
  options: ScalingOptions
): Promise<ScalingMeasurement> {
  const factor = options.factor ?? SCALING_FACTOR;
  const measurement = await measureInterleaved(
    () => run(options.baseSize),
    () => run(options.baseSize * factor),
    options.passes
  );
  assertLinearRatio(label, measurement, factor, options.maxRatio);
  return measurement;
}

/**
 * Like expectLinearScaling, for a run that takes a prebuilt input: building a multi-megabyte string
 * inside the timed section would measure the builder as well. `large` must be `factor` times `small`.
 */
export async function expectLinearOnInputs<T>(
  label: string,
  run: (input: T) => unknown,
  inputs: { small: T; large: T; factor?: number; passes?: number; maxRatio?: number }
): Promise<ScalingMeasurement> {
  const factor = inputs.factor ?? SCALING_FACTOR;
  const measurement = await measureInterleaved(() => run(inputs.small), () => run(inputs.large), inputs.passes);
  assertLinearRatio(label, measurement, factor, inputs.maxRatio);
  return measurement;
}

function assertLinearRatio(label: string, measurement: ScalingMeasurement, factor: number, maxRatioOverride?: number): void {
  const maxRatio = maxRatioOverride ?? factor * LINEAR_RATIO_SLACK;
  expect(
    measurement.smallMs,
    `${label}: the small run took ${measurement.smallMs.toFixed(3)} ms, too short to time; use a larger input`
  ).toBeGreaterThanOrEqual(MIN_MEASURABLE_MS);
  expect(
    measurement.ratio,
    `${label}: ${factor}x the input took ${measurement.ratio.toFixed(2)}x as long ` +
      `(${measurement.smallMs.toFixed(1)} ms -> ${measurement.largeMs.toFixed(1)} ms); linear stays under ${maxRatio}x`
  ).toBeLessThanOrEqual(maxRatio);
}

/**
 * Asserts that work which must not depend on a claimed size (a hostile header that announces a huge
 * allocation, a rejected count) takes about as long for a huge claim as for a modest one: the ratio of the
 * two stays under `maxRatio`. A reader that trusts the claim scales with it and fails the bound.
 */
export async function expectSizeIndependent(
  label: string,
  run: (claimedSize: number) => unknown,
  options: { modestSize: number; hugeSize: number; passes?: number; maxRatio?: number }
): Promise<ScalingMeasurement> {
  const maxRatio = options.maxRatio ?? CONSTANT_RATIO_BOUND;
  const measurement = await measureInterleaved(
    () => run(options.modestSize),
    () => run(options.hugeSize),
    options.passes
  );
  // The floor keeps a sub-millisecond baseline from turning timer noise into a large ratio.
  const baselineMs = Math.max(measurement.smallMs, SIZE_INDEPENDENT_FLOOR_MS);
  expect(
    measurement.largeMs / baselineMs,
    `${label}: a claim of ${options.hugeSize} took ${measurement.largeMs.toFixed(2)} ms against ` +
      `${measurement.smallMs.toFixed(2)} ms for ${options.modestSize}; rejection work must not grow with the claim`
  ).toBeLessThanOrEqual(maxRatio);
  return measurement;
}

/** An absolute hang guard: `expectedMs` is how long a healthy run needs; the ceiling is a multiple of it. */
export function hangGuardMs(expectedMs: number): number {
  return expectedMs * HANG_GUARD_MULTIPLE;
}
