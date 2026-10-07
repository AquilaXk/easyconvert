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

export interface ScalingMeasurement<R = unknown> {
  smallMs: number;
  largeMs: number;
  /** largeMs / smallMs. */
  ratio: number;
  /** What the last large run returned, so the caller can assert on the output of the timed work. */
  largeResult: R;
}

/** The outcome of work that may throw: timing a rejection needs its error as a value. */
export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Runs `fn` and returns its result or the error it threw. */
export function settle<T>(fn: () => T): Settled<T> {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

async function timeOnce<T>(work: () => T | Promise<T>): Promise<{ ms: number; value: T }> {
  const started = performance.now();
  const value = (await work()) as T;
  return { ms: performance.now() - started, value };
}

/**
 * Times `small` and `large` alternately for `passes` rounds (after one warm-up of each) and returns the
 * best time of each.
 */
export async function measureInterleaved<R = unknown>(
  small: () => unknown,
  large: () => R | Promise<R>,
  passes: number = SCALING_PASSES
): Promise<ScalingMeasurement<R>> {
  await small();
  let largeResult = (await large()) as R;
  let smallMs = Number.POSITIVE_INFINITY;
  let largeMs = Number.POSITIVE_INFINITY;
  for (let pass = 0; pass < passes; pass++) {
    smallMs = Math.min(smallMs, (await timeOnce(small)).ms);
    const largeRun = await timeOnce<R>(large);
    largeMs = Math.min(largeMs, largeRun.ms);
    largeResult = largeRun.value;
  }
  return { smallMs, largeMs, ratio: largeMs / smallMs, largeResult };
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
export async function expectLinearScaling<R = unknown>(
  label: string,
  run: (size: number) => R | Promise<R>,
  options: ScalingOptions
): Promise<ScalingMeasurement<R>> {
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
export async function expectLinearOnInputs<T, R = unknown>(
  label: string,
  run: (input: T) => R | Promise<R>,
  inputs: { small: T; large: T; factor?: number; passes?: number; maxRatio?: number; minMeasurableMs?: number }
): Promise<ScalingMeasurement<R>> {
  const factor = inputs.factor ?? SCALING_FACTOR;
  const measurement = await measureInterleaved(() => run(inputs.small), () => run(inputs.large), inputs.passes);
  assertLinearRatio(label, measurement, factor, inputs.maxRatio, inputs.minMeasurableMs);
  return measurement;
}

function assertLinearRatio(
  label: string,
  measurement: ScalingMeasurement<unknown>,
  factor: number,
  maxRatioOverride?: number,
  minMeasurableMs: number = MIN_MEASURABLE_MS
): void {
  const maxRatio = maxRatioOverride ?? factor * LINEAR_RATIO_SLACK;
  expect(
    measurement.smallMs,
    `${label}: the small run took ${measurement.smallMs.toFixed(3)} ms, too short to time; use a larger input`
  ).toBeGreaterThanOrEqual(minMeasurableMs);
  expect(
    measurement.ratio,
    `${label}: ${factor}x the input took ${measurement.ratio.toFixed(2)}x as long ` +
      `(${measurement.smallMs.toFixed(1)} ms -> ${measurement.largeMs.toFixed(1)} ms); linear stays under ${maxRatio}x`
  ).toBeLessThanOrEqual(maxRatio);
}

/**
 * Asserts that work which must not depend on a claimed size (a hostile header that announces a huge
 * allocation, a rejected count, a sniff that reads a bounded prefix) takes about as long for a huge input as
 * for a modest one: the ratio of the two stays under `maxRatio`. A reader that trusts the claim scales with
 * it and fails the bound. Inputs are prebuilt so that building them is not timed.
 */
export async function expectSizeIndependentOnInputs<T, R = unknown>(
  label: string,
  run: (input: T) => R | Promise<R>,
  inputs: { modest: T; huge: T; passes?: number; maxRatio?: number }
): Promise<ScalingMeasurement<R>> {
  const maxRatio = inputs.maxRatio ?? CONSTANT_RATIO_BOUND;
  const measurement = await measureInterleaved(() => run(inputs.modest), () => run(inputs.huge), inputs.passes);
  // The floor keeps a sub-millisecond baseline from turning timer noise into a large ratio.
  const baselineMs = Math.max(measurement.smallMs, SIZE_INDEPENDENT_FLOOR_MS);
  expect(
    measurement.largeMs / baselineMs,
    `${label}: the larger input took ${measurement.largeMs.toFixed(2)} ms against ` +
      `${measurement.smallMs.toFixed(2)} ms for the modest one; the work must not grow with the input`
  ).toBeLessThanOrEqual(maxRatio);
  return measurement;
}

/** expectSizeIndependentOnInputs for work parameterised by a claimed size (a number the code under test is told). */
export async function expectSizeIndependent<R = unknown>(
  label: string,
  run: (claimedSize: number) => R | Promise<R>,
  options: { modestSize: number; hugeSize: number; passes?: number; maxRatio?: number }
): Promise<ScalingMeasurement<R>> {
  return expectSizeIndependentOnInputs(label, run, {
    modest: options.modestSize,
    huge: options.hugeSize,
    passes: options.passes,
    maxRatio: options.maxRatio,
  });
}

/**
 * Default hang guard. Work that is linear in a megabyte-sized input finishes in milliseconds, work that is
 * quadratic needs minutes: 10 s separates them by orders of magnitude on any runner.
 */
export const DEFAULT_HANG_GUARD_MS = 10_000;

/**
 * For adversarial inputs that a linear scan finishes in well under a millisecond (a single `indexOf`
 * over the input), so that no two sizes can be compared reliably: runs `run` once and asserts that it
 * finishes within the hang guard. It catches an algorithm that never finishes, not one that is merely slow.
 */
export async function expectNoHang<R>(label: string, run: () => R | Promise<R>, guardMs: number = DEFAULT_HANG_GUARD_MS): Promise<R> {
  const { ms, value } = await timeOnce<R>(run);
  expect(ms, `${label}: took ${ms.toFixed(0)} ms; the hang guard is ${guardMs} ms`).toBeLessThan(guardMs);
  return value;
}

/** An absolute hang guard: `expectedMs` is how long a healthy run needs; the ceiling is a multiple of it. */
export function hangGuardMs(expectedMs: number): number {
  return expectedMs * HANG_GUARD_MULTIPLE;
}
