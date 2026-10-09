import { performance } from 'node:perf_hooks';
import {
  SPEED_CONFIDENCE_LEVEL,
  SPEED_HEAVY_INITIAL_PAIRS,
  SPEED_HEAVY_MAX_PAIRS,
  SPEED_HEAVY_WARMUP_ROUNDS,
  SPEED_LIGHT_INITIAL_PAIRS,
  SPEED_LIGHT_MAX_PAIRS,
  SPEED_LIGHT_WARMUP_ROUNDS,
  SPEED_MIN_PAIRS,
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
 * straddles it (or fewer than SPEED_MIN_PAIRS pairs exist), so more pairs are collected, up to a cap; an interval that
 * still straddles the line at the cap counts as a failure.
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
  step: number;
  warmup: number;
  tolerance?: number;
  confidence?: number;
}

export const LIGHT_SPEED_PLAN: SpeedPlan = { initialPairs: SPEED_LIGHT_INITIAL_PAIRS, maxPairs: SPEED_LIGHT_MAX_PAIRS, step: SPEED_PAIRS_STEP, warmup: SPEED_LIGHT_WARMUP_ROUNDS };
export const HEAVY_SPEED_PLAN: SpeedPlan = { initialPairs: SPEED_HEAVY_INITIAL_PAIRS, maxPairs: SPEED_HEAVY_MAX_PAIRS, step: SPEED_PAIRS_STEP, warmup: SPEED_HEAVY_WARMUP_ROUNDS };

export interface AdaptiveTiming extends InterleavedTiming {
  decision: SpeedDecision;
  /** True when the interval still straddled the pass line at the cap, which counts as a failure. */
  unstableAtCap: boolean;
}

/**
 * Collects paired runs until the speed decision is stable or the cap is reached. The order of the two sides
 * alternates with the pair index, so a drifting machine load or a warming cache favours neither. An UNSTABLE decision
 * at the cap is returned as a FAIL with `unstableAtCap` set.
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
  if (!Number.isInteger(plan.step) || plan.step < 1) throw new SpeedSampleError(`the step must be a positive integer, got ${plan.step}`);
  for (let i = 0; i < plan.warmup; i++) {
    await ours();
    await reference();
  }
  const oursMs: number[] = [];
  const referenceMs: number[] = [];
  const collect = async (count: number): Promise<void> => {
    for (let i = 0; i < count; i++) {
      if (oursMs.length % 2 === 0) {
        oursMs.push(await timed(ours, now));
        referenceMs.push(await timed(reference, now));
      } else {
        referenceMs.push(await timed(reference, now));
        oursMs.push(await timed(ours, now));
      }
    }
  };
  await collect(plan.initialPairs);
  let decision = decideSpeed(oursMs, referenceMs, plan);
  while (decision.verdict === 'unstable' && oursMs.length < plan.maxPairs) {
    await collect(Math.min(plan.step, plan.maxPairs - oursMs.length));
    decision = decideSpeed(oursMs, referenceMs, plan);
  }
  const unstableAtCap = decision.verdict === 'unstable';
  return {
    runs: oursMs.length,
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
