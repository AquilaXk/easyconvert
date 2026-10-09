import { SPEED_HISTORY_MAX_POINTS, SPEED_HISTORY_MIN_POINTS } from './config';
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
 * observation rather than a bound on the mean (Hahn and Meeker, Statistical Intervals: A Guide for Practitioners). The row fails when even the upper end of its new
 * interval is under that bound. With fewer than SPEED_HISTORY_MIN_POINTS points there is no bound and nothing fails.
 */

export interface SpeedHistoryPoint {
  /** Median speed ratio of one CI run. */
  ratio: number;
  /** `generatedAt` of the report the ratio came from; identifies the run, so refreshing twice from it adds nothing. */
  at: string;
}

/**
 * Student's t quantiles for P(T <= t) = 0.99 (one-sided 99 percent), indexed by degrees of freedom. A history holds
 * at most SPEED_HISTORY_MAX_POINTS points, so 2 to SPEED_HISTORY_MAX_POINTS - 1 degrees of freedom are all that occur.
 */
const T_QUANTILE_ONE_SIDED_99: Readonly<Record<number, number>> = {
  2: 6.964557,
  3: 4.540703,
  4: 3.746947,
  5: 3.36493,
  6: 3.142668,
  7: 2.997952,
  8: 2.896459,
  9: 2.821438,
};

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

/**
 * `history` plus this run's ratio (rounded to four decimals), ordered by run time and cut to the latest
 * SPEED_HISTORY_MAX_POINTS. A run already in the history (same `at`) is left as it is.
 */
export function appendSpeedHistory(history: readonly SpeedHistoryPoint[], ratio: number, at: string): SpeedHistoryPoint[] {
  if (history.some((point) => point.at === at)) return [...history];
  const rounded = Math.round(ratio * RATIO_DECIMALS) / RATIO_DECIMALS;
  if (!(rounded > 0)) throw new BenchArgumentError(`the speed ratio ${ratio} rounds to zero`);
  const ordered = [...history, { ratio: rounded, at }].sort((a, b) => a.at.localeCompare(b.at));
  return ordered.slice(-SPEED_HISTORY_MAX_POINTS);
}
