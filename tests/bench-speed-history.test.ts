import { describe, expect, it } from 'vitest';
import { SPEED_HISTORY_CONFIDENCE, SPEED_HISTORY_MAX_POINTS, SPEED_HISTORY_MIN_POINTS } from '../bench/config';
import { BenchArgumentError } from '../bench/errors';
import { appendSpeedHistory, predictionLowerBound, type SpeedHistoryPoint } from '../bench/speed-history';

/**
 * The statistical boundary of a tracked gap on small histories whose bound can be worked out by hand. Ratios are powers
 * of two, so their logarithms are whole numbers of ln 2 and the standard deviation is exact:
 *
 *   [1, 2, 2, 2, 4]: log2 values 0, 1, 1, 1, 2 -> mean 1, sum of squares 2, variance 2 / 4, s = sqrt(0.5) (in log2 units)
 *     n = 5, df = 4, t(0.99, 4) = 3.746947 (one-sided), prediction factor sqrt(1 + 1/5) = sqrt(1.2)
 *     lower = 2^(1 - 3.746947 * sqrt(0.5) * sqrt(1.2)) = 2^(-1.90237) = 0.26750
 *   [1, 2, 4]: log2 values 0, 1, 2 -> mean 1, s = 1, df = 2, t(0.99, 2) = 6.964557, factor sqrt(4/3)
 *     lower = 2^(1 - 6.964557 * sqrt(4/3)) = 2^(-7.04198) = 0.0075885
 */

describe('the policy constants', () => {
  it('keep ten runs, need three to judge, and bound at 99 percent one-sided', () => {
    expect(SPEED_HISTORY_MAX_POINTS).toBe(10);
    expect(SPEED_HISTORY_MIN_POINTS).toBe(3);
    expect(SPEED_HISTORY_CONFIDENCE).toBe(0.99);
  });
});

describe('the one-sided prediction bound over a history', () => {
  it('gives the hand-computed lower edge for five points', () => {
    const bound = predictionLowerBound([1, 2, 2, 2, 4]);
    expect(bound).not.toBeNull();
    expect(bound?.points).toBe(5);
    expect(bound?.centre).toBeCloseTo(2, 10);
    expect(bound?.logSpread).toBeCloseTo(Math.sqrt(0.5) * Math.LN2, 10);
    expect(bound?.quantile).toBe(3.746947);
    expect(bound?.lower).toBeCloseTo(0.2675, 4);
  });

  it('gives the hand-computed lower edge for the smallest history that is judged', () => {
    expect(predictionLowerBound([1, 2, 4])?.lower).toBeCloseTo(0.0075885, 6);
  });

  it('does not depend on the order of the points', () => {
    expect(predictionLowerBound([4, 2, 1, 2, 2])?.lower).toBeCloseTo(predictionLowerBound([1, 2, 2, 2, 4])?.lower as number, 12);
  });

  it('puts the bound at the shared value when every point is the same, and at the largest history uses nine degrees of freedom', () => {
    const flat = predictionLowerBound(Array(SPEED_HISTORY_MAX_POINTS).fill(0.5));
    expect(flat?.lower).toBeCloseTo(0.5, 12);
    expect(flat?.quantile).toBe(2.821438);
  });

  it('has no bound below three points, so nothing can be judged', () => {
    expect(predictionLowerBound([])).toBeNull();
    expect(predictionLowerBound([0.5])).toBeNull();
    expect(predictionLowerBound([0.5, 0.6])).toBeNull();
    expect(predictionLowerBound([0.5, 0.6, 0.55])).not.toBeNull();
  });

  it('refuses a history longer than the cap and ratios that are not positive and finite', () => {
    expect(() => predictionLowerBound(Array(SPEED_HISTORY_MAX_POINTS + 1).fill(1))).toThrow(BenchArgumentError);
    expect(() => predictionLowerBound([1, 0, 2])).toThrow('positive finite');
    expect(() => predictionLowerBound([1, Number.NaN, 2])).toThrow('positive finite');
  });
});

describe('appending a run to a history', () => {
  const at = (day: number): string => `2026-10-${String(day).padStart(2, '0')}T02:00:00.000Z`;

  it('adds the ratio rounded to four decimals, in run order', () => {
    const history: SpeedHistoryPoint[] = [{ ratio: 0.79, at: at(2) }];
    expect(appendSpeedHistory(history, 0.718312, at(1))).toEqual([
      { ratio: 0.7183, at: at(1) },
      { ratio: 0.79, at: at(2) },
    ]);
  });

  it('adds nothing for a run already in the history, so refreshing twice from one report is harmless', () => {
    const history: SpeedHistoryPoint[] = [{ ratio: 0.79, at: at(2) }];
    expect(appendSpeedHistory(history, 0.5, at(2))).toEqual(history);
  });

  it('keeps only the latest ten runs', () => {
    let history: SpeedHistoryPoint[] = [];
    for (let day = 1; day <= 12; day++) history = appendSpeedHistory(history, day / 10, at(day));
    expect(history).toHaveLength(SPEED_HISTORY_MAX_POINTS);
    expect(history[0]).toEqual({ ratio: 0.3, at: at(3) });
    expect(history[SPEED_HISTORY_MAX_POINTS - 1]).toEqual({ ratio: 1.2, at: at(12) });
  });

  it('refuses a ratio that rounds to zero', () => {
    expect(() => appendSpeedHistory([], 0.00001, at(1))).toThrow('rounds to zero');
  });
});
