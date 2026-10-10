import { performance } from 'node:perf_hooks';
import {
  SPEED_CONFIDENCE_LEVEL,
  SPEED_HEAVY_EXTENDED_MAX_PAIRS,
  SPEED_HEAVY_INITIAL_PAIRS,
  SPEED_HEAVY_MAX_PAIRS,
  SPEED_HEAVY_WARMUP_ROUNDS,
  SPEED_LIGHT_EXTENDED_MAX_PAIRS,
  SPEED_LIGHT_INITIAL_PAIRS,
  SPEED_LIGHT_MAX_PAIRS,
  SPEED_LIGHT_WARMUP_ROUNDS,
  SPEED_MAX_SAMPLE_REPEATS,
  SPEED_MIN_PAIRS,
  SPEED_MIN_SAMPLE_MS,
  SPEED_PAIRS_STEP,
  SPEED_PARITY_TOLERANCE,
} from './config';
import { BenchArgumentError } from './errors';
import { coefficientOfVariation, median, type InterleavedTiming, timed } from './stats';

/**
 * Statistical speed-parity decision. Ours and the reference run alternately in one window; each pair gives the speed
 * ratio reference time / our time (above 1: ours is faster). The interval is the distribution-free sign-test interval
 * of the median ratio: with the n ratios sorted, [x(k), x(n + 1 - k)] contains the true median with probability
 * 1 - 2 P(Binomial(n, 1/2) <= k - 1) (Hodges and Lehmann; Conover, Practical Nonparametric Statistics, 3rd ed.,
 * section 3.2). It needs no distributional assumption and no random numbers, so a decision is reproducible.
 *
 * PASS: the lower bound is at or above 1 - tolerance. FAIL: the upper bound is below it. UNSTABLE: the interval
 * straddles it (or fewer than SPEED_MIN_PAIRS pairs exist), so more pairs are collected, up to a cap and then, for a
 * row still undecided, up to a second cap (sequential sampling: it stops at the first decision). An interval that still
 * straddles the line at the last cap is returned as `unstableAtCap`; bench/parity.ts judges such a row by its median.
 *
 * Every timed sample of either side lasts at least SPEED_MIN_SAMPLE_MS: the number of back-to-back calls per sample is
 * calibrated once per row from its warm-up rounds, as benchmark harnesses calibrate their iteration counts, so a
 * side that finishes in milliseconds is not decided by timer resolution and scheduler jitter.
 */

export class SpeedSampleError extends BenchArgumentError {}

/** Largest sample the interval is computed for; binomial coefficients stay exact in a double up to here. */
const MAX_INTERVAL_PAIRS = 64;

export type SpeedVerdict = 'pass' | 'fail' | 'unstable';

export interface SpeedDecision {
  verdict: SpeedVerdict;
  pairs: number;
  /** Median of the per-pair speed ratios. */
  median: number;
  /** Bounds of the confidence interval of the median ratio; null while too few pairs exist for the level. */
  lower: number | null;
  upper: number | null;
  /** Exact coverage of [lower, upper]. */
  confidence: number | null;
  /** The speed ratio a row must be at least this good as: 1 - tolerance. */
  passLine: number;
}

export interface SpeedOptions {
  tolerance?: number;
  /** Two-sided confidence level, in (0, 1). */
  confidence?: number;
}

/** P(Binomial(n, 1/2) <= j), exact for n up to MAX_INTERVAL_PAIRS. */
function binomialCdfHalf(n: number, j: number): number {
  let coefficient = 1;
  let sum = 0;
  for (let i = 0; i <= j; i++) {
    sum += coefficient;
    coefficient = (coefficient * (n - i)) / (i + 1);
  }
  return sum / 2 ** n;
}

/**
 * The widest order-statistic index k (1-based) whose interval [x(k), x(n+1-k)] still has at least the requested
 * confidence, or 0 when even [min, max] falls short of it.
 */
export function signTestRank(n: number, confidence: number): number {
  if (!Number.isInteger(n) || n < 1 || n > MAX_INTERVAL_PAIRS) {
    throw new SpeedSampleError(`the speed interval needs 1 to ${MAX_INTERVAL_PAIRS} pairs, got ${n}`);
  }
  if (!(confidence > 0 && confidence < 1)) throw new SpeedSampleError(`confidence must be between 0 and 1, got ${confidence}`);
  const alpha = 1 - confidence;
  let rank = 0;
  for (let k = 1; k <= Math.floor((n + 1) / 2); k++) {
    if (2 * binomialCdfHalf(n, k - 1) <= alpha) rank = k;
    else break;
  }
  return rank;
}

/** Per-pair speed ratios reference / ours, validated: the same count on both sides, finite and positive times. */
export function speedRatios(oursMs: readonly number[], referenceMs: readonly number[]): number[] {
  if (oursMs.length !== referenceMs.length) throw new SpeedSampleError(`paired samples differ in length: ${oursMs.length} against ${referenceMs.length}`);
  if (oursMs.length === 0) throw new SpeedSampleError('the speed decision needs at least one pair');
  return oursMs.map((ours, index) => {
    const reference = referenceMs[index];
    if (!Number.isFinite(ours) || !Number.isFinite(reference) || ours <= 0 || reference <= 0) {
      throw new SpeedSampleError(`pair ${index} holds a non-positive or non-finite time (${ours} ms, ${reference} ms)`);
    }
    return reference / ours;
  });
}

export function decideSpeed(oursMs: readonly number[], referenceMs: readonly number[], options: SpeedOptions = {}): SpeedDecision {
  const tolerance = options.tolerance ?? SPEED_PARITY_TOLERANCE;
  const confidence = options.confidence ?? SPEED_CONFIDENCE_LEVEL;
  if (!(tolerance >= 0 && tolerance < 1)) throw new SpeedSampleError(`tolerance must be in [0, 1), got ${tolerance}`);
  const ratios = speedRatios(oursMs, referenceMs);
  const sorted = [...ratios].sort((a, b) => a - b);
  const passLine = 1 - tolerance;
  const centre = median(ratios);
  const n = sorted.length;
  const rank = n >= SPEED_MIN_PAIRS ? signTestRank(n, confidence) : 0;
  if (rank === 0) {
    return { verdict: 'unstable', pairs: n, median: centre, lower: null, upper: null, confidence: null, passLine };
  }
  const lower = sorted[rank - 1];
  const upper = sorted[n - rank];
  const coverage = 1 - 2 * binomialCdfHalf(n, rank - 1);
  let verdict: SpeedVerdict = 'unstable';
  if (lower >= passLine) verdict = 'pass';
  else if (upper < passLine) verdict = 'fail';
  return { verdict, pairs: n, median: centre, lower, upper, confidence: coverage, passLine };
}

export interface SpeedPlan {
  initialPairs: number;
  maxPairs: number;
  /** A second cap for a row still undecided at `maxPairs`; omitted or not above `maxPairs`: there is none. */
  extendedMaxPairs?: number;
  step: number;
  warmup: number;
  /** Fewest back-to-back calls of our side timed per sample (the sample is the mean per call); 1 when omitted. */
  oursRepeats?: number;
  /**
   * Shortest a timed sample of either side may last. The warm-up rounds are timed, and the fastest call of each side
   * sets how many calls make a sample. Omitted or 0: no calibration (a plan without warm-up rounds cannot calibrate).
   */
  minSampleMs?: number;
  /** Most calls per calibrated sample; SPEED_MAX_SAMPLE_REPEATS when omitted. */
  maxRepeats?: number;
  tolerance?: number;
  confidence?: number;
}

export const LIGHT_SPEED_PLAN: SpeedPlan = {
  initialPairs: SPEED_LIGHT_INITIAL_PAIRS,
  maxPairs: SPEED_LIGHT_MAX_PAIRS,
  extendedMaxPairs: SPEED_LIGHT_EXTENDED_MAX_PAIRS,
  step: SPEED_PAIRS_STEP,
  warmup: SPEED_LIGHT_WARMUP_ROUNDS,
  minSampleMs: SPEED_MIN_SAMPLE_MS,
};
export const HEAVY_SPEED_PLAN: SpeedPlan = {
  initialPairs: SPEED_HEAVY_INITIAL_PAIRS,
  maxPairs: SPEED_HEAVY_MAX_PAIRS,
  extendedMaxPairs: SPEED_HEAVY_EXTENDED_MAX_PAIRS,
  step: SPEED_PAIRS_STEP,
  warmup: SPEED_HEAVY_WARMUP_ROUNDS,
  minSampleMs: SPEED_MIN_SAMPLE_MS,
};

/**
 * Back-to-back calls that make a sample last at least `minSampleMs` when one call takes `callMs`: the smallest count
 * whose total reaches it, at least 1 and at most `maxRepeats` (a call too short to reach it within the cap gets the cap).
 */
export function calibrateRepeats(callMs: number, minSampleMs: number, maxRepeats: number): number {
  if (!(minSampleMs >= 0) || !Number.isFinite(minSampleMs)) throw new SpeedSampleError(`the minimum sample duration must be a non-negative number, got ${minSampleMs}`);
  if (!Number.isInteger(maxRepeats) || maxRepeats < 1) throw new SpeedSampleError(`the repeat cap must be a positive integer, got ${maxRepeats}`);
  if (!Number.isFinite(callMs) || callMs < 0) throw new SpeedSampleError(`a call time must be a non-negative number, got ${callMs}`);
  if (callMs === 0) return minSampleMs === 0 ? 1 : maxRepeats;
  return Math.min(maxRepeats, Math.max(1, Math.ceil(minSampleMs / callMs)));
}

export interface AdaptiveTiming extends InterleavedTiming {
  /** Back-to-back calls per timed sample on each side, as calibrated; each sample in `oursMs` and `referenceMs` is the mean per call. */
  repeats: { ours: number; reference: number };
  decision: SpeedDecision;
  /** True when the interval still straddled the pass line at the last cap: the row is judged by its median (bench/parity.ts). */
  unstableAtCap: boolean;
}

/**
 * Collects paired runs until the speed decision is stable or the cap is reached. The order of the two sides
 * alternates with the pair index, so a drifting machine load or a warming cache favours neither. Pairs are added until
 * the interval decides, the first cap (`maxPairs`) is reached and then the second (`extendedMaxPairs`). An UNSTABLE
 * decision at the last cap is returned as a FAIL with `unstableAtCap` set; the verdict of such a row is taken from its median.
 */
export async function adaptiveSpeedTiming(
  ours: () => Promise<void> | void,
  reference: () => Promise<void> | void,
  plan: SpeedPlan,
  now: () => number = () => performance.now()
): Promise<AdaptiveTiming> {
  if (plan.initialPairs < SPEED_MIN_PAIRS) throw new SpeedSampleError(`at least ${SPEED_MIN_PAIRS} initial pairs are needed, got ${plan.initialPairs}`);
  if (plan.maxPairs < plan.initialPairs || plan.maxPairs > MAX_INTERVAL_PAIRS) {
    throw new SpeedSampleError(`the cap must be from ${plan.initialPairs} to ${MAX_INTERVAL_PAIRS} pairs, got ${plan.maxPairs}`);
  }
  const lastCap = Math.max(plan.maxPairs, plan.extendedMaxPairs ?? 0);
  if (lastCap > MAX_INTERVAL_PAIRS) throw new SpeedSampleError(`the second cap must not exceed ${MAX_INTERVAL_PAIRS} pairs, got ${lastCap}`);
  if (!Number.isInteger(plan.step) || plan.step < 1) throw new SpeedSampleError(`the step must be a positive integer, got ${plan.step}`);
  const repeats = plan.oursRepeats ?? 1;
  if (!Number.isInteger(repeats) || repeats < 1) throw new SpeedSampleError(`oursRepeats must be a positive integer, got ${repeats}`);
  const minSampleMs = plan.minSampleMs ?? 0;
  const maxRepeats = plan.maxRepeats ?? SPEED_MAX_SAMPLE_REPEATS;
  // The warm-up rounds are timed: the fastest single call of a side is the one least disturbed by the machine, and
  // gives the largest, so safest, repeat count.
  let fastestOurs = Number.POSITIVE_INFINITY;
  let fastestReference = Number.POSITIVE_INFINITY;
  for (let i = 0; i < plan.warmup; i++) {
    fastestOurs = Math.min(fastestOurs, await timed(ours, now));
    fastestReference = Math.min(fastestReference, await timed(reference, now));
  }
  const calibrated = (fastest: number): number => (Number.isFinite(fastest) ? calibrateRepeats(fastest, minSampleMs, maxRepeats) : 1);
  const oursCalls = Math.max(repeats, calibrated(fastestOurs));
  const referenceCalls = calibrated(fastestReference);
  const oursMs: number[] = [];
  const referenceMs: number[] = [];
  // A side that finishes in milliseconds is timed over several calls so scheduler jitter does not decide the pair.
  const batched = (side: () => Promise<void> | void, calls: number) => async (): Promise<number> =>
    (await timed(async () => {
      for (let call = 0; call < calls; call++) await side();
    }, now)) / calls;
  const oursSample = batched(ours, oursCalls);
  const referenceSample = batched(reference, referenceCalls);
  const collect = async (count: number): Promise<void> => {
    for (let i = 0; i < count; i++) {
      if (oursMs.length % 2 === 0) {
        oursMs.push(await oursSample());
        referenceMs.push(await referenceSample());
      } else {
        referenceMs.push(await referenceSample());
        oursMs.push(await oursSample());
      }
    }
  };
  await collect(plan.initialPairs);
  let decision = decideSpeed(oursMs, referenceMs, plan);
  while (decision.verdict === 'unstable' && oursMs.length < lastCap) {
    await collect(Math.min(plan.step, lastCap - oursMs.length));
    decision = decideSpeed(oursMs, referenceMs, plan);
  }
  const unstableAtCap = decision.verdict === 'unstable';
  return {
    runs: oursMs.length,
    repeats: { ours: oursCalls, reference: referenceCalls },
    oursMs,
    referenceMs,
    oursMedianMs: median(oursMs),
    referenceMedianMs: median(referenceMs),
    oursCv: coefficientOfVariation(oursMs),
    referenceCv: coefficientOfVariation(referenceMs),
    decision: unstableAtCap ? { ...decision, verdict: 'fail' } : decision,
    unstableAtCap,
  };
}
