import { performance } from 'node:perf_hooks';
import { AB_FAMILYWISE_ALPHA, AB_ROW_BUDGET, SPEED_MAX_SAMPLE_REPEATS, SPEED_PARITY_TOLERANCE } from './config';
import { type AdaptiveTiming, binomialCdfHalf, calibrateRepeats, decideSpeed, SpeedSampleError, type SpeedPlan } from './speed-parity';
import { coefficientOfVariation, mean, median, timed } from './stats';

function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

/**
 * Speed of a pull request against its base, measured in one process with the reference tool as the third side. Each
 * pair times the head, the base and the reference once, in an order that rotates through all six permutations, so a
 * drifting load or a warming cache favours none of them. Noise common to the pair (the machine of this job, this
 * minute) cancels in the head-to-base ratio; that is what an absolute threshold on the reference ratio cannot do.
 *
 * The decision is one-sided and fails only on evidence: the head is credibly slower than the base when the upper
 * confidence bound of the median of base time / head time is below the pass line (1 - SPEED_PARITY_TOLERANCE). The
 * bound is the exact sign-test bound (the order statistic x(n + 1 - k) with k the largest rank such that
 * P(Binomial(n, 1/2) <= k - 1) <= alpha; Conover, Practical Nonparametric Statistics, 3rd ed., section 3.2), at the
 * error rate alpha = AB_FAMILYWISE_ALPHA / AB_ROW_BUDGET, so that over a run of AB_ROW_BUDGET rows the chance of any
 * false failure is at most AB_FAMILYWISE_ALPHA (Bonferroni). With too few pairs for that alpha the bound is infinite
 * and the row cannot fail.
 */

/** Per-row error rate of the one-sided bounds. */
export const AB_ROW_ALPHA = AB_FAMILYWISE_ALPHA / AB_ROW_BUDGET;

/** The largest rank k with P(Binomial(n, 1/2) <= k - 1) <= alpha, or 0 when even k = 1 exceeds alpha. */
export function oneSidedRank(n: number, alpha: number): number {
  if (!Number.isInteger(n) || n < 1) throw new SpeedSampleError(`the one-sided bound needs at least one pair, got ${n}`);
  if (!(alpha > 0 && alpha < 1)) throw new SpeedSampleError(`alpha must be between 0 and 1, got ${alpha}`);
  let rank = 0;
  for (let k = 1; k <= n; k++) {
    if (binomialCdfHalf(n, k - 1) <= alpha) rank = k;
    else break;
  }
  return rank;
}

/** One-sided upper confidence bound of the median of `ratios` at error rate `alpha`; Infinity when there are too few pairs. */
export function upperBoundOfMedian(ratios: readonly number[], alpha: number): number {
  const rank = oneSidedRank(ratios.length, alpha);
  if (rank === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...ratios].sort((a, b) => a - b);
  return sorted[sorted.length - rank];
}

export interface AbSummary {
  pairs: number;
  /** Median of base time / head time: above 1, the head is faster than the base. */
  headVsBaseMedian: number;
  /** Upper bound of that median at AB_ROW_ALPHA; below the pass line, the head is credibly slower than the base. */
  headVsBaseUpper: number;
  /** Upper bound at AB_ROW_ALPHA of the median of reference time / head time; below the pass line, the head is credibly below the reference. */
  headVsReferenceUpper: number;
  /** Standard deviation of the natural logarithm of the per-pair base time / head time. */
  noise: number;
  /** Median of reference time / base time: the speed of the base against the reference, in the same pairs. */
  baseVsReferenceMedian: number;
}

export interface AbTiming extends AdaptiveTiming {
  ab: AbSummary;
  baseMs: number[];
}

export interface AbPlan {
  pairs: number;
  warmup: number;
  oursRepeats?: number;
  minSampleMs?: number;
  maxRepeats?: number;
  tolerance?: number;
  confidence?: number;
}

const ORDERS: ReadonlyArray<readonly ('head' | 'base' | 'reference')[]> = [
  ['head', 'base', 'reference'],
  ['reference', 'base', 'head'],
  ['base', 'head', 'reference'],
  ['reference', 'head', 'base'],
  ['head', 'reference', 'base'],
  ['base', 'reference', 'head'],
];

/**
 * Times `head`, `base` and `reference` for `plan.pairs` pairs. `head` and `base` are two versions of one action: they
 * run the same number of back-to-back calls per sample, set from the fastest warm-up call of either.
 */
export async function abSpeedTiming(
  head: () => Promise<void> | void,
  base: () => Promise<void> | void,
  reference: () => Promise<void> | void,
  plan: AbPlan,
  now: () => number = () => performance.now()
): Promise<AbTiming> {
  if (!Number.isInteger(plan.pairs) || plan.pairs < 1 || plan.pairs > 64) throw new SpeedSampleError(`the A/B comparison needs 1 to 64 pairs, got ${plan.pairs}`);
  const repeats = plan.oursRepeats ?? 1;
  const minSampleMs = plan.minSampleMs ?? 0;
  const maxRepeats = plan.maxRepeats ?? SPEED_MAX_SAMPLE_REPEATS;
  let fastestOurs = Number.POSITIVE_INFINITY;
  let fastestReference = Number.POSITIVE_INFINITY;
  for (let i = 0; i < plan.warmup; i++) {
    fastestOurs = Math.min(fastestOurs, await timed(head, now), await timed(base, now));
    fastestReference = Math.min(fastestReference, await timed(reference, now));
  }
  const calibrated = (fastest: number): number => (Number.isFinite(fastest) ? calibrateRepeats(fastest, minSampleMs, maxRepeats) : 1);
  const oursCalls = Math.max(repeats, calibrated(fastestOurs));
  const referenceCalls = calibrated(fastestReference);
  const sample = (side: () => Promise<void> | void, calls: number) => async (): Promise<number> =>
    (await timed(async () => {
      for (let call = 0; call < calls; call++) await side();
    }, now)) / calls;
  const samplers = { head: sample(head, oursCalls), base: sample(base, oursCalls), reference: sample(reference, referenceCalls) };
  const times = { head: [] as number[], base: [] as number[], reference: [] as number[] };
  for (let pair = 0; pair < plan.pairs; pair++) {
    for (const side of ORDERS[pair % ORDERS.length]) times[side].push(await samplers[side]());
  }
  const ratio = (numerator: number[], denominator: number[]): number[] => numerator.map((value, index) => value / denominator[index]);
  const headVsBase = ratio(times.base, times.head);
  const headVsReference = ratio(times.reference, times.head);
  const baseVsReference = ratio(times.reference, times.base);
  const decision = decideSpeed(times.head, times.reference, { tolerance: plan.tolerance, confidence: plan.confidence });
  const unstableAtCap = decision.verdict === 'unstable';
  return {
    runs: plan.pairs,
    repeats: { ours: oursCalls, reference: referenceCalls },
    oursMs: times.head,
    referenceMs: times.reference,
    baseMs: times.base,
    oursMedianMs: median(times.head),
    referenceMedianMs: median(times.reference),
    oursCv: coefficientOfVariation(times.head),
    referenceCv: coefficientOfVariation(times.reference),
    decision: unstableAtCap ? { ...decision, verdict: 'fail' } : decision,
    unstableAtCap,
    ab: {
      pairs: plan.pairs,
      headVsBaseMedian: median(headVsBase),
      headVsBaseUpper: upperBoundOfMedian(headVsBase, AB_ROW_ALPHA),
      headVsReferenceUpper: upperBoundOfMedian(headVsReference, AB_ROW_ALPHA),
      noise: standardDeviation(headVsBase.map((value) => Math.log(value))),
      baseVsReferenceMedian: median(baseVsReference),
    },
  };
}

/** The line the A/B bounds are compared with: the head may lose this share of the base's speed, as it may lose it against the reference. */
export const AB_PASS_LINE = 1 - SPEED_PARITY_TOLERANCE;
