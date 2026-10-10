import { performance } from 'node:perf_hooks';
import {
  AB_CONFIRM_ALPHA,
  AB_DEFAULT_REGRESSION,
  AB_EXTRA_STEP_PAIRS,
  AB_FAMILYWISE_ALPHA,
  AB_MAX_PAIRS,
  AB_ROW_BUDGET,
  AB_ROW_REGRESSION,
  type AbRegressionOverride,
} from './ab-config';
import { SPEED_MAX_SAMPLE_REPEATS, SPEED_PARITY_TOLERANCE } from './speed-config';
import { type AdaptiveTiming, binomialCdfHalf, calibrateRepeats, decideSpeed, SpeedSampleError } from './speed-parity';
import { coefficientOfVariation, mean, median, timed } from './stats';

/**
 * Speed of a pull request against its base, with the reference tool as the third side. Each pair times the head, the
 * base and the reference once, in an order that rotates through all six permutations, so a drifting load or a warming
 * cache favours none of them. Noise common to the pair (this runner, this minute) cancels in the head-to-base ratio;
 * that is what an absolute threshold on the reference ratio cannot do. The head and the base are separate processes
 * with their own checkouts and dependencies (bench/ab-host.ts), so a change of a dependency is measured too.
 *
 * The decision is one-sided and fails only on evidence: the head is credibly slower than the base when the upper
 * confidence bound of the median of base time / head time is below the row's slowdown line, 1 / (1 + delta) for the
 * regression threshold delta of the row. The bound is the exact sign-test bound (the order statistic x(n + 1 - k) with
 * k the largest rank such that P(Binomial(n, 1/2) <= k - 1) <= alpha; Conover, Practical Nonparametric Statistics,
 * 3rd ed., section 3.2), at the error rate alpha = AB_FAMILYWISE_ALPHA / AB_ROW_BUDGET, so that over a run of
 * AB_ROW_BUDGET rows the chance of any false failure is at most AB_FAMILYWISE_ALPHA (Bonferroni). With too few pairs
 * for that alpha the bound is infinite and the row cannot fail.
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

/** One-sided lower confidence bound of the median of `ratios` at error rate `alpha`; 0 when there are too few pairs. */
export function lowerBoundOfMedian(ratios: readonly number[], alpha: number): number {
  const rank = oneSidedRank(ratios.length, alpha);
  if (rank === 0) return 0;
  return [...ratios].sort((a, b) => a - b)[rank - 1];
}

/** The regression threshold of a row: its own, recorded with its reason in bench/ab-config.ts, or the default. */
export function regressionDelta(rowId: string, overrides: Readonly<Record<string, Pick<AbRegressionOverride, 'delta'>>> = AB_ROW_REGRESSION): number {
  return overrides[rowId]?.delta ?? AB_DEFAULT_REGRESSION;
}

/** The ratio of base time / head time below which the head took more than the threshold longer than the base. */
export function slowdownLine(rowId: string, overrides?: Readonly<Record<string, Pick<AbRegressionOverride, 'delta'>>>): number {
  return 1 / (1 + regressionDelta(rowId, overrides));
}

/** A side of a pair: something that can be timed one call at a time, or over a number of back-to-back calls. */
export interface Side {
  /** Milliseconds of one call. */
  call: () => Promise<number>;
  /** Mean milliseconds per call over `calls` back-to-back calls. */
  sample: (calls: number) => Promise<number>;
}

/** A side that runs in this process. */
export function localSide(action: () => Promise<void> | void, now: () => number = () => performance.now()): Side {
  return {
    call: () => timed(action, now),
    sample: async (calls) =>
      (await timed(async () => {
        for (let call = 0; call < calls; call++) await action();
      }, now)) / calls,
  };
}

export interface AbSummary {
  pairs: number;
  /** Median of base time / head time: above 1, the head is faster than the base. */
  headVsBaseMedian: number;
  /** Upper bound of that median at AB_ROW_ALPHA; below the row's slowdown line, the head is credibly slower than the base. */
  headVsBaseUpper: number;
  /** Upper bound at AB_ROW_ALPHA of the median of reference time / head time; below the pass line, the head is credibly below the reference. */
  headVsReferenceUpper: number;
  /** Standard deviation of the natural logarithm of the per-pair base time / head time. */
  noise: number;
  /** Median of reference time / base time: the speed of the base against the reference, in the same pairs. */
  baseVsReferenceMedian: number;
  /** Pairs added beyond the fixed number because the first pairs left the row undecided. */
  extraPairs: number;
  /** Mean milliseconds one pair (the head, the base and the reference once each) took: what the simulation spends a budget with. */
  pairMs: number;
  /**
   * Set when the first pairs showed the head credibly slower than the base (`slower`) or credibly below the reference
   * while the base was at it (`lost`), and a second set of fresh pairs was taken: whether that set shows it too. Absent
   * for a condition the first pairs did not show.
   */
  confirmed: { slower?: boolean; lost?: boolean };
}

export interface AbTiming extends AdaptiveTiming {
  ab: AbSummary;
  baseMs: number[];
}

/** Measuring time the extra pairs and the confirmation sets of a shard may use together; once it is spent, the rows after stay at the fixed pairs. */
export interface ExtraBudget {
  remainingMs: number;
}

export interface AbPlan {
  pairs: number;
  warmup: number;
  oursRepeats?: number;
  minSampleMs?: number;
  maxRepeats?: number;
  tolerance?: number;
  confidence?: number;
  /** The regression threshold of the row, which sets how wide a bound may be before the row gets extra pairs. */
  delta?: number;
  /** Extra pairs for a row whose bound is too wide; none when absent. */
  extra?: ExtraBudget;
  /** Take a second set of pairs to confirm a failure (the default); false for a test of the first set alone. */
  confirm?: boolean;
}

const ORDERS: ReadonlyArray<readonly ('head' | 'base' | 'reference')[]> = [
  ['head', 'base', 'reference'],
  ['reference', 'base', 'head'],
  ['base', 'head', 'reference'],
  ['reference', 'head', 'base'],
  ['head', 'reference', 'base'],
  ['base', 'reference', 'head'],
];

function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

/**
 * Times `head`, `base` and `reference` for `plan.pairs` pairs, then six more at a time while the bound is too wide to be
 * useful and the extra budget lasts. `head` and `base` are two versions of one action: they run the same number of
 * back-to-back calls per sample, set from the fastest warm-up call of either.
 */
export async function abSpeedTiming(head: Side, base: Side, reference: Side, plan: AbPlan, now: () => number = () => performance.now()): Promise<AbTiming> {
  if (!Number.isInteger(plan.pairs) || plan.pairs < 1 || plan.pairs > AB_MAX_PAIRS) throw new SpeedSampleError(`the A/B comparison needs 1 to ${AB_MAX_PAIRS} pairs, got ${plan.pairs}`);
  const repeats = plan.oursRepeats ?? 1;
  const minSampleMs = plan.minSampleMs ?? 0;
  const maxRepeats = plan.maxRepeats ?? SPEED_MAX_SAMPLE_REPEATS;
  const delta = plan.delta ?? AB_DEFAULT_REGRESSION;
  let fastestOurs = Number.POSITIVE_INFINITY;
  let fastestReference = Number.POSITIVE_INFINITY;
  for (let i = 0; i < plan.warmup; i++) {
    fastestOurs = Math.min(fastestOurs, await head.call(), await base.call());
    fastestReference = Math.min(fastestReference, await reference.call());
  }
  const calibrated = (fastest: number): number => (Number.isFinite(fastest) ? calibrateRepeats(fastest, minSampleMs, maxRepeats) : 1);
  const oursCalls = Math.max(repeats, calibrated(fastestOurs));
  const referenceCalls = calibrated(fastestReference);
  const calls = { head: oursCalls, base: oursCalls, reference: referenceCalls };
  const sides = { head, base, reference };
  const times = { head: [] as number[], base: [] as number[], reference: [] as number[] };
  const collect = async (count: number): Promise<void> => {
    for (let n = 0; n < count; n++) {
      const pair = times.head.length;
      for (const side of ORDERS[pair % ORDERS.length]) times[side].push(await sides[side].sample(calls[side]));
    }
  };
  const ratio = (numerator: number[], denominator: number[]): number[] => numerator.map((value, index) => value / denominator[index]);
  await collect(plan.pairs);
  const slowerLine = 1 / (1 + delta);
  // Undecided: the pairs so far neither show the head slower than the threshold nor rule it out.
  const undecided = (): boolean => {
    const headVsBase = ratio(times.base, times.head);
    return lowerBoundOfMedian(headVsBase, AB_ROW_ALPHA) < slowerLine && upperBoundOfMedian(headVsBase, AB_ROW_ALPHA) >= slowerLine;
  };
  let extraPairs = 0;
  if (plan.extra) {
    while (times.head.length + AB_EXTRA_STEP_PAIRS <= AB_MAX_PAIRS && plan.extra.remainingMs > 0 && undecided()) {
      const start = now();
      await collect(AB_EXTRA_STEP_PAIRS);
      plan.extra.remainingMs -= now() - start;
      extraPairs += AB_EXTRA_STEP_PAIRS;
    }
  }
  const headVsBase = ratio(times.base, times.head);
  const headVsReference = ratio(times.reference, times.head);
  const baseVsReference = ratio(times.reference, times.base);
  const headVsBaseUpper = upperBoundOfMedian(headVsBase, AB_ROW_ALPHA);
  const headVsReferenceUpper = upperBoundOfMedian(headVsReference, AB_ROW_ALPHA);
  const parityLine = 1 - (plan.tolerance ?? SPEED_PARITY_TOLERANCE);
  const confirmed: AbSummary['confirmed'] = {};
  const slower = headVsBaseUpper < slowerLine;
  const lost = median(baseVsReference) >= parityLine && headVsReferenceUpper < parityLine;
  if ((slower || lost) && plan.confirm !== false) {
    // Fresh pairs, taken after the first set: a burst of noise in the first is not in them. Their time counts against the extra budget.
    const first = { head: times.head.length, base: times.base.length, reference: times.reference.length };
    const start = now();
    await collect(plan.pairs);
    if (plan.extra) plan.extra.remainingMs -= now() - start;
    const again = {
      head: times.head.slice(first.head),
      base: times.base.slice(first.base),
      reference: times.reference.slice(first.reference),
    };
    if (slower) confirmed.slower = upperBoundOfMedian(ratio(again.base, again.head), AB_CONFIRM_ALPHA) < slowerLine;
    if (lost) confirmed.lost = upperBoundOfMedian(ratio(again.reference, again.head), AB_CONFIRM_ALPHA) < parityLine;
    for (const side of ['head', 'base', 'reference'] as const) times[side].length = first[side];
  }
  const decision = decideSpeed(times.head, times.reference, { tolerance: plan.tolerance, confidence: plan.confidence });
  const unstableAtCap = decision.verdict === 'unstable';
  return {
    runs: times.head.length,
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
      pairs: times.head.length,
      headVsBaseMedian: median(headVsBase),
      headVsBaseUpper,
      headVsReferenceUpper,
      noise: standardDeviation(headVsBase.map((value) => Math.log(value))),
      baseVsReferenceMedian: median(baseVsReference),
      extraPairs,
      pairMs: (times.head.reduce((a, b) => a + b, 0) + times.base.reduce((a, b) => a + b, 0) + times.reference.reduce((a, b) => a + b, 0)) / times.head.length,
      confirmed,
    },
  };
}
