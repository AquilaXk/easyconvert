import { describe, expect, it } from 'vitest';
import { SPEED_HISTORY_CONFIDENCE, SPEED_HISTORY_MAX_POINTS, SPEED_HISTORY_MIN_POINTS } from '../bench/config';
import { assertSupportedConfidence, predictionLowerBound, T_QUANTILE_ONE_SIDED_99 } from '../bench/speed-history';

/**
 * The Student's t quantiles the prediction bound uses, checked against an independent source: the density of the t
 * distribution integrated numerically, not another copy of the table. A history of n points uses n - 1 degrees of freedom.
 */

/** ln Gamma by the Lanczos approximation (g = 7, n = 9), accurate to about 1e-15 for positive arguments. */
function lnGamma(x: number): number {
  const g = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  const z = x - 1;
  let sum = g[0];
  for (let i = 1; i < g.length; i++) sum += g[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

function tDensity(x: number, df: number): number {
  const logNorm = lnGamma((df + 1) / 2) - lnGamma(df / 2) - 0.5 * Math.log(df * Math.PI);
  return Math.exp(logNorm - ((df + 1) / 2) * Math.log(1 + (x * x) / df));
}

/** P(T <= t) for t >= 0: one half plus the integral of the density from 0 to t, by Simpson's rule. */
function tCdf(t: number, df: number): number {
  const steps = 20_000;
  const h = t / steps;
  let sum = tDensity(0, df) + tDensity(t, df);
  for (let i = 1; i < steps; i++) sum += tDensity(i * h, df) * (i % 2 === 0 ? 2 : 4);
  return 0.5 + (sum * h) / 3;
}

describe('the t quantiles of the prediction bound', () => {
  it('has one entry for every degree of freedom a history can have', () => {
    const dfs = Object.keys(T_QUANTILE_ONE_SIDED_99).map(Number);
    expect(dfs).toEqual(Array.from({ length: SPEED_HISTORY_MAX_POINTS - 2 }, (_value, index) => index + 2));
  });

  it.each(Array.from({ length: 8 }, (_value, index) => index + 2))('puts 99 percent of the t distribution with %i degrees of freedom below its entry', (df) => {
    expect(tCdf(T_QUANTILE_ONE_SIDED_99[df], df)).toBeCloseTo(SPEED_HISTORY_CONFIDENCE, 6);
  });

  it('is the quantile the bound uses for each history length, including four points (three degrees of freedom)', () => {
    for (let n = SPEED_HISTORY_MIN_POINTS; n <= SPEED_HISTORY_MAX_POINTS; n++) {
      const ratios = Array.from({ length: n }, (_value, index) => 0.5 + index / 100);
      expect(predictionLowerBound(ratios)?.quantile, `n = ${n}`).toBe(T_QUANTILE_ONE_SIDED_99[n - 1]);
    }
    expect(T_QUANTILE_ONE_SIDED_99[3]).toBeCloseTo(4.540703, 6);
  });

  it('checks the integrator itself on a value known in closed form: the Cauchy distribution (one degree of freedom) has its 0.75 quantile at 1', () => {
    expect(tCdf(1, 1)).toBeCloseTo(0.75, 8);
  });
});

describe('the confidence the quantiles are for', () => {
  it('is the level of the table, and any other level is refused instead of silently using the wrong table', () => {
    expect(() => assertSupportedConfidence(SPEED_HISTORY_CONFIDENCE)).not.toThrow();
    expect(() => assertSupportedConfidence(0.95)).toThrow('0.99');
    expect(() => assertSupportedConfidence(0.995)).toThrow('0.99');
    expect(() => assertSupportedConfidence(Number.NaN)).toThrow('0.99');
  });
});
