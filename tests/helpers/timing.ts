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
/**
 * A ratio that lands just over its bound after SCALING_PASSES passes may be load rather than growth: a busy shard can
 * slow every large sample of a short run. Such a comparison takes more passes, up to this many in all. Noise only ever
 * adds time to a sample, so the best of more passes can only move toward the true ratio: work that really grows faster
 * than the bound stays over it however many passes are taken.
 */
export const MAX_SCALING_PASSES = 12;
/** Extra passes are taken only for a ratio up to this multiple of the bound; a clearly super-linear one is refused at once. */
export const EXTRA_PASS_RATIO_MARGIN = 1.5;
/** Extra passes stop once a comparison has used this much time, so that a slow case cannot run into the test timeout. */
export const EXTRA_PASS_BUDGET_MS = 20_000;
/** The input grows by this factor between the small and the large run. */
export const SCALING_FACTOR = 4;
/**
 * A linear algorithm may take up to SCALING_FACTOR * LINEAR_RATIO_SLACK times as long on the larger input
 * (cache effects, allocator growth). With SCALING_FACTOR = 4 the bound is 8x, where a quadratic algorithm
 * takes 16x and a cubic one 64x.
 */
export const LINEAR_RATIO_SLACK = 2;
/**
 * A timed sample must last at least this long for a ratio to mean anything; below it a timer tick or a garbage
 * collection dominates. Work faster than that is repeated inside the sample, so a fast machine measures as well as
 * a slow one: a run that takes 0.9 ms on an idle core and 3 ms on a loaded one is timed over enough repetitions to
 * pass this floor on both.
 */
export const MIN_SAMPLE_MS = 5;
/** Most repetitions of one run inside a sample; work that is still shorter than MIN_SAMPLE_MS then is too trivial to compare. */
export const MAX_SAMPLE_REPETITIONS = 4096;
/** Calibration aims this much past MIN_SAMPLE_MS. */
const SAMPLE_OVERSHOOT = 1.25;
/** A sample that reads as zero is treated as this long when sizing the next one. */
const MIN_TIMER_MS = 0.001;
/**
 * Ceiling on how much longer a bounded-work rejection may take when the claimed size grows. Both sides are timed over
 * samples of at least MIN_SAMPLE_MS and the best of the passes is kept, so constant work reads as about 1x even on a
 * loaded runner; work that grows linearly with a 4x larger input reads as about 4x and fails.
 */
export const CONSTANT_RATIO_BOUND = 2;

export interface ScalingMeasurement<R = unknown> {
  /** Best time of one run of the smaller side, in milliseconds. */
  smallMs: number;
  /** Best time of one run of the larger side, in milliseconds. */
  largeMs: number;
  /** largeMs / smallMs. */
  ratio: number;
  /** Length of the shortest sample of the smaller side: its runs repeated until the sample is long enough to time. */
  smallSampleMs: number;
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

/** Times `repetitions` back-to-back runs of `work` as one sample and returns the last result. */
async function timeSample<T>(work: () => T | Promise<T>, repetitions: number): Promise<{ ms: number; value: T }> {
  const started = performance.now();
  let value!: T;
  for (let run = 0; run < repetitions; run++) value = (await work()) as T;
  return { ms: performance.now() - started, value };
}

/**
 * One sample of `work` that lasts at least MIN_SAMPLE_MS: when the sample is shorter, the repetition count grows and
 * the sample is taken again, so a cold first run (a slow interpreter tier, a garbage collection) cannot fix the count
 * too low for the warm runs that follow. Returns the repetition count to start the next sample from.
 */
async function timeAdaptiveSample<T>(
  work: () => T | Promise<T>,
  startRepetitions: number
): Promise<{ ms: number; value: T; repetitions: number }> {
  let repetitions = startRepetitions;
  for (;;) {
    const sample = await timeSample(work, repetitions);
    if (sample.ms >= MIN_SAMPLE_MS || repetitions >= MAX_SAMPLE_REPETITIONS) return { ...sample, repetitions };
    // Aim a little past the floor so that the next sample clears it even when it runs slightly faster.
    const wanted = Math.ceil((repetitions * MIN_SAMPLE_MS * SAMPLE_OVERSHOOT) / Math.max(sample.ms, MIN_TIMER_MS));
    repetitions = Math.min(MAX_SAMPLE_REPETITIONS, Math.max(repetitions * 2, wanted));
  }
}

/**
 * Times `small` and `large` alternately for `passes` rounds (after one warm-up of each) and returns the
 * best time of one run of each. Work shorter than MIN_SAMPLE_MS is repeated inside each sample and the sample
 * time is divided back to one run.
 */
export async function measureInterleaved<R = unknown>(
  small: () => unknown,
  large: () => R | Promise<R>,
  passes: number = SCALING_PASSES,
  acceptRatio?: number
): Promise<ScalingMeasurement<R>> {
  const started = performance.now();
  await small();
  let largeResult = (await large()) as R;
  let smallRepetitions = 1;
  let largeRepetitions = 1;
  let smallMs = Number.POSITIVE_INFINITY;
  let largeMs = Number.POSITIVE_INFINITY;
  let smallSampleMs = Number.POSITIVE_INFINITY;
  for (let pass = 0; ; pass++) {
    if (pass >= passes && !wantsExtraPass(pass, largeMs / smallMs, performance.now() - started, acceptRatio)) break;
    const smallSample = await timeAdaptiveSample(small, smallRepetitions);
    smallRepetitions = smallSample.repetitions;
    smallMs = Math.min(smallMs, smallSample.ms / smallSample.repetitions);
    smallSampleMs = Math.min(smallSampleMs, smallSample.ms);
    const largeSample = await timeAdaptiveSample<R>(large, largeRepetitions);
    largeRepetitions = largeSample.repetitions;
    largeMs = Math.min(largeMs, largeSample.ms / largeSample.repetitions);
    largeResult = largeSample.value;
  }
  return { smallMs, largeMs, ratio: largeMs / smallMs, smallSampleMs, largeResult };
}

/** Whether a comparison that has finished `pass` passes with this ratio should take another one (see MAX_SCALING_PASSES). */
function wantsExtraPass(pass: number, ratio: number, elapsedMs: number, acceptRatio: number | undefined): boolean {
  if (acceptRatio === undefined || pass >= MAX_SCALING_PASSES || elapsedMs >= EXTRA_PASS_BUDGET_MS) return false;
  return ratio > acceptRatio && ratio <= acceptRatio * EXTRA_PASS_RATIO_MARGIN;
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
  const maxRatio = options.maxRatio ?? factor * LINEAR_RATIO_SLACK;
  const measurement = await measureInterleaved(
    () => run(options.baseSize),
    () => run(options.baseSize * factor),
    options.passes,
    maxRatio
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
  inputs: { small: T; large: T; factor?: number; passes?: number; maxRatio?: number }
): Promise<ScalingMeasurement<R>> {
  const factor = inputs.factor ?? SCALING_FACTOR;
  const maxRatio = inputs.maxRatio ?? factor * LINEAR_RATIO_SLACK;
  const measurement = await measureInterleaved(() => run(inputs.small), () => run(inputs.large), inputs.passes, maxRatio);
  assertLinearRatio(label, measurement, factor, inputs.maxRatio);
  return measurement;
}

function assertLinearRatio(
  label: string,
  measurement: ScalingMeasurement<unknown>,
  factor: number,
  maxRatioOverride?: number
): void {
  const maxRatio = maxRatioOverride ?? factor * LINEAR_RATIO_SLACK;
  expect(
    measurement.smallSampleMs,
    `${label}: even ${MAX_SAMPLE_REPETITIONS} repetitions of the small run took ${measurement.smallSampleMs.toFixed(3)} ms, too short to time; use a larger input`
  ).toBeGreaterThanOrEqual(MIN_SAMPLE_MS);
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
  const measurement = await measureInterleaved(() => run(inputs.modest), () => run(inputs.huge), inputs.passes, maxRatio);
  // The raw per-call ratio: measureInterleaved repeats a fast side until its sample is long enough to time, so no
  // floor on the baseline is needed (and one would hide growth of work that takes under a millisecond).
  expect(
    measurement.ratio,
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

/** How much slower than its in-process reference a candidate may be (a cheap pass versus an adversarial pass). */
export const REFERENCE_RATIO_BOUND = 4;

/**
 * Asserts that `candidate` costs no more than `maxRatio` times what `reference` costs, both measured in this
 * process, interleaved and best of the passes: "a request carrying the adversarial option is not slower than
 * the same request carrying a plain one". Returns the measurement (largeResult is the candidate's result).
 */
export async function expectNoSlowerThanReference<R = unknown>(
  label: string,
  reference: () => unknown,
  candidate: () => R | Promise<R>,
  options: { maxRatio?: number; passes?: number } = {}
): Promise<ScalingMeasurement<R>> {
  const maxRatio = options.maxRatio ?? REFERENCE_RATIO_BOUND;
  const measurement = await measureInterleaved(reference, candidate, options.passes, maxRatio);
  expect(
    measurement.ratio,
    `${label}: the candidate took ${measurement.largeMs.toFixed(2)} ms against ${measurement.smallMs.toFixed(2)} ms for the reference`
  ).toBeLessThanOrEqual(maxRatio);
  return measurement;
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

/**
 * The PR-gate form of a scaling check on a hostile input: runs `run(input)` once under the hang guard and returns
 * the result as `largeResult`, the name the scaling helpers use, so the assertions on the output stay as they are.
 * The growth ratio itself is measured by the nightly performance suites.
 */
export async function expectNoHangOnInput<T, R>(
  label: string,
  run: (input: T) => R | Promise<R>,
  input: T,
  guardMs: number = DEFAULT_HANG_GUARD_MS
): Promise<{ largeResult: R }> {
  return { largeResult: await expectNoHang(label, () => run(input), guardMs) };
}
