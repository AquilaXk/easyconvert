import {
  SPEED_GAP_FLOOR,
  SPEED_HISTORY_CONFIDENCE,
  SPEED_HISTORY_MAX_POINTS,
  SPEED_HISTORY_MIN_LOG_SPREAD,
  SPEED_HISTORY_MIN_POINTS,
  SPEED_STEP_FACTOR,
} from './speed-config';
import { BenchArgumentError } from './errors';

/**
 * Statistical boundary of a tracked speed gap. A shared runner moves a speed ratio by several percent from one night to
 * the next, so a tracked row is not compared with one recorded number and a fixed percentage. It keeps the ratios of the
 * latest CI runs and fails only when the new ratio is below what that history predicts.
 *
 * The ratios are reference time / our time, so they combine multiplicatively and the bound is taken on their
 * logarithms: with n historical ratios r_i, x_i = ln r_i, mean m and sample standard deviation s, a new measurement
 * falls above exp(m - t * s * sqrt(1 + 1/n)) with the chosen one-sided confidence, where t is the Student's t quantile
 * at that confidence with n - 1 degrees of freedom. The sqrt(1 + 1/n) factor makes it a prediction bound for one new
 * observation rather than a bound on the mean (Hahn and Meeker, Statistical Intervals: A Guide for Practitioners). The row fails when its median is under that bound
 * (the history stores medians, so the bound predicts a median). The bound is never allowed to fall under SPEED_GAP_FLOOR
 * of the history's median, and with fewer than SPEED_HISTORY_MIN_POINTS points the floor is the only limit.
 *
 * A prediction bound assumes exchangeable points. A speed-up that landed on main breaks that: points from before and
 * after it differ by the code, not by the runner, and the spread of the window then measures the change. A history
 * therefore restarts at a step (isStepUp) and holds only the runs since.
 */

export interface SpeedHistoryPoint {
  /** Median speed ratio of one CI run. */
  ratio: number;
  /** `generatedAt` of the report the ratio came from; identifies the run, so refreshing twice from it adds nothing. */
  at: string;
  /** Commit the run measured, when its report recorded one. */
  commit?: string;
}

/**
 * Student's t quantiles for P(T <= t) = 0.99 (one-sided 99 percent), indexed by degrees of freedom. A history holds
 * at most SPEED_HISTORY_MAX_POINTS points, so 2 to SPEED_HISTORY_MAX_POINTS - 1 degrees of freedom are all that occur.
 */
export const T_QUANTILE_ONE_SIDED_99: Readonly<Record<number, number>> = {
  2: 6.964557,
  3: 4.540703,
  4: 3.746947,
  5: 3.36493,
  6: 3.142668,
  7: 2.997952,
  8: 2.896459,
  9: 2.821438,
};

/** The level the table above is for. */
const TABLE_CONFIDENCE = 0.99;
const CONFIDENCE_TOLERANCE = 1e-12;

/** Refuses a confidence the quantile table is not for, so changing the constant cannot silently keep the 99 percent table. */
export function assertSupportedConfidence(confidence: number): void {
  if (!(Math.abs(confidence - TABLE_CONFIDENCE) <= CONFIDENCE_TOLERANCE)) {
    throw new BenchArgumentError(`SPEED_HISTORY_CONFIDENCE is ${confidence}, but the Student's t table in bench/speed-history.ts is for ${TABLE_CONFIDENCE} only; add the quantiles for the new level first`);
  }
}
assertSupportedConfidence(SPEED_HISTORY_CONFIDENCE);

export interface PredictionBound {
  /** Historical points the bound was computed from. */
  points: number;
  /** Geometric mean of the history. */
  centre: number;
  /** Standard deviation of the log ratios. */
  logSpread: number;
  /** Student's t quantile used. */
  quantile: number;
  /** Ratios below this are predicted away by the history with the configured confidence. */
  lower: number;
}

/** The lower edge of the one-sided prediction bound, or null while the history has too few points to give one. */
export function predictionLowerBound(ratios: readonly number[]): PredictionBound | null {
  const n = ratios.length;
  if (n > SPEED_HISTORY_MAX_POINTS) throw new BenchArgumentError(`a speed history holds at most ${SPEED_HISTORY_MAX_POINTS} points, got ${n}`);
  if (n < SPEED_HISTORY_MIN_POINTS) return null;
  if (ratios.some((ratio) => !Number.isFinite(ratio) || ratio <= 0)) throw new BenchArgumentError('speed history ratios must be positive finite numbers');
  const logs = ratios.map((ratio) => Math.log(ratio));
  const centreLog = logs.reduce((sum, value) => sum + value, 0) / n;
  const variance = logs.reduce((sum, value) => sum + (value - centreLog) ** 2, 0) / (n - 1);
  const logSpread = Math.sqrt(variance);
  const quantile = T_QUANTILE_ONE_SIDED_99[n - 1];
  return {
    points: n,
    centre: Math.exp(centreLog),
    logSpread,
    quantile,
    lower: Math.exp(centreLog - quantile * logSpread * Math.sqrt(1 + 1 / n)),
  };
}

const RATIO_DECIMALS = 10_000;

const logMean = (ratios: readonly number[]): number => ratios.reduce((sum, ratio) => sum + Math.log(ratio), 0) / ratios.length;

/**
 * Whether a run at `ratio` is a step up from a history: more than SPEED_STEP_FACTOR times its geometric mean, or above
 * the upper edge of its prediction interval (the same one-sided 99 percent, with the spread no lower than
 * SPEED_HISTORY_MIN_LOG_SPREAD). A drop is never a step: a slowdown is what the gate is there to catch. An empty history
 * has nothing to step from.
 */
export function isStepUp(all: readonly number[], ratio: number): boolean {
  const history = all.slice(-SPEED_HISTORY_MAX_POINTS);
  const n = history.length;
  if (n === 0) return false;
  const centreLog = logMean(history);
  if (Math.log(ratio) > centreLog + Math.log(SPEED_STEP_FACTOR)) return true;
  if (n < SPEED_HISTORY_MIN_POINTS) return false;
  const variance = history.reduce((sum, value) => sum + (Math.log(value) - centreLog) ** 2, 0) / (n - 1);
  const spread = Math.max(Math.sqrt(variance), SPEED_HISTORY_MIN_LOG_SPREAD);
  return Math.log(ratio) > centreLog + T_QUANTILE_ONE_SIDED_99[n - 1] * spread * Math.sqrt(1 + 1 / n);
}

/** The points since the last step of `points`, ordered by run time: each step restarts the window at its own run. */
export function sinceLastStep(points: readonly SpeedHistoryPoint[]): SpeedHistoryPoint[] {
  const ordered = [...points].sort((a, b) => a.at.localeCompare(b.at));
  let window: SpeedHistoryPoint[] = [];
  for (const point of ordered) {
    window = isStepUp(window.map((kept) => kept.ratio), point.ratio) ? [point] : [...window, point].slice(-SPEED_HISTORY_MAX_POINTS);
  }
  return window;
}

/**
 * `history` plus this run's ratio (rounded to four decimals) and the commit it measured, ordered by run time, restarted at
 * the last step and cut to the latest SPEED_HISTORY_MAX_POINTS. A run already in the history (same `at`) is left as it is.
 */
export function appendSpeedHistory(history: readonly SpeedHistoryPoint[], ratio: number, at: string, commit?: string): SpeedHistoryPoint[] {
  if (history.some((point) => point.at === at)) return [...history];
  const rounded = Math.round(ratio * RATIO_DECIMALS) / RATIO_DECIMALS;
  if (!(rounded > 0)) throw new BenchArgumentError(`the speed ratio ${ratio} rounds to zero`);
  const added: SpeedHistoryPoint = commit === undefined ? { ratio: rounded, at } : { ratio: rounded, at, commit };
  return sinceLastStep([...history, added]).slice(-SPEED_HISTORY_MAX_POINTS);
}

export interface SpeedGapThreshold {
  /** What the floor is taken from: the median of the history since its last step, or the recorded ratio of a row with no points. */
  level: number;
  /** SPEED_GAP_FLOOR of the level. */
  floor: number;
  /** The prediction bound of the history, or null while it has too few points. */
  bound: PredictionBound | null;
  /** The median below which a tracked row fails: the higher of the bound and the floor. */
  lower: number;
}

/** Median of positive ratios; for an even count the geometric mean of the two middle ones, as ratios combine multiplicatively. */
function medianRatio(ratios: readonly number[]): number {
  const sorted = [...ratios].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : Math.sqrt(sorted[middle - 1] * sorted[middle]);
}

/** The lowest median a tracked row may have, from its history (oldest first) and its recorded ratio. */
export function speedGapThreshold(ratios: readonly number[], recorded: number): SpeedGapThreshold {
  const level = ratios.length > 0 ? medianRatio(ratios) : recorded;
  const floor = SPEED_GAP_FLOOR * level;
  const bound = predictionLowerBound(ratios);
  return { level, floor, bound, lower: Math.max(floor, bound?.lower ?? 0) };
}
