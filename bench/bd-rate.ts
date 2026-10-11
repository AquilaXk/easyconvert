import { BD_MAX_POINTS, BD_MIN_POINTS } from './config';
import { BdRateInputError } from './errors';

/**
 * Bjontegaard delta metrics, after G. Bjontegaard, "Calculation of average PSNR differences between RD-curves",
 * ITU-T SG16/Q6 VCEG-M33 (April 2001), as used in ITU-T H-series coding-efficiency comparisons:
 *
 * - BD-rate: fit a cubic polynomial of ln(rate) against quality for each curve, integrate both fits over the
 *   quality interval the curves share, and turn the mean ln-rate difference into a percentage. Negative means
 *   the test curve needs fewer bits at the same quality.
 * - BD-PSNR: the same fit with the axes swapped, giving the mean quality difference in dB at equal rate.
 *
 * Exactly four points define the cubic; more points are fitted by least squares.
 */

export interface RdPoint {
  /** Size or bit rate; any unit, only ratios matter. Must be positive. */
  rate: number;
  /** Quality of that encode, for example PSNR in dB. */
  quality: number;
}

const POLYNOMIAL_DEGREE = 3;
const COEFFICIENT_COUNT = POLYNOMIAL_DEGREE + 1;
const PERCENT = 100;
/** A pivot below this means the points do not determine a cubic (duplicate abscissae). */
const SINGULAR_PIVOT = 1e-10;

interface ScaledPolynomial {
  /** Coefficients of c0 + c1 u + c2 u^2 + c3 u^3 where u = (x - centre) / scale. */
  coefficients: number[];
  centre: number;
  scale: number;
}

function assertPoints(name: string, points: readonly RdPoint[]): void {
  if (points.length < BD_MIN_POINTS) {
    throw new BdRateInputError(`${name} curve needs at least ${BD_MIN_POINTS} points, got ${points.length}`);
  }
  if (points.length > BD_MAX_POINTS) {
    throw new BdRateInputError(`${name} curve takes at most ${BD_MAX_POINTS} points, got ${points.length}`);
  }
  for (const point of points) {
    if (!Number.isFinite(point.rate) || point.rate <= 0 || !Number.isFinite(point.quality)) {
      throw new BdRateInputError(`${name} curve holds a point with a non-positive rate or a non-finite value`);
    }
  }
}

/** Solves the dense linear system `a x = b` by Gaussian elimination with partial pivoting. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  for (let column = 0; column < n; column++) {
    let pivotRow = column;
    for (let row = column + 1; row < n; row++) {
      if (Math.abs(a[row][column]) > Math.abs(a[pivotRow][column])) pivotRow = row;
    }
    if (Math.abs(a[pivotRow][column]) < SINGULAR_PIVOT) {
      throw new BdRateInputError('the points do not determine a cubic: their quality (or rate) values coincide');
    }
    [a[column], a[pivotRow]] = [a[pivotRow], a[column]];
    [b[column], b[pivotRow]] = [b[pivotRow], b[column]];
    for (let row = column + 1; row < n; row++) {
      const factor = a[row][column] / a[column][column];
      for (let k = column; k < n; k++) a[row][k] -= factor * a[column][k];
      b[row] -= factor * b[column];
    }
  }
  const solution = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = b[row];
    for (let k = row + 1; k < n; k++) sum -= a[row][k] * solution[k];
    solution[row] = sum / a[row][row];
  }
  return solution;
}

/** Least-squares cubic through (x, y); the abscissae are centred and scaled first so the normal equations stay well conditioned. */
function fitCubic(xs: readonly number[], ys: readonly number[]): ScaledPolynomial {
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const centre = (lo + hi) / 2;
  const scale = (hi - lo) / 2;
  if (scale === 0) throw new BdRateInputError('the points do not determine a cubic: all quality (or rate) values are equal');
  const normal = Array.from({ length: COEFFICIENT_COUNT }, () => new Array<number>(COEFFICIENT_COUNT).fill(0));
  const rhs = new Array<number>(COEFFICIENT_COUNT).fill(0);
  xs.forEach((x, i) => {
    const u = (x - centre) / scale;
    const powers = [1, u, u * u, u * u * u];
    for (let r = 0; r < COEFFICIENT_COUNT; r++) {
      rhs[r] += powers[r] * ys[i];
      for (let c = 0; c < COEFFICIENT_COUNT; c++) normal[r][c] += powers[r] * powers[c];
    }
  });
  return { coefficients: solve(normal, rhs), centre, scale };
}

/** Integral of the fitted polynomial from `lo` to `hi` (in the original abscissa), by the exact antiderivative. */
function integrate(poly: ScaledPolynomial, lo: number, hi: number): number {
  const antiderivative = (x: number): number => {
    const u = (x - poly.centre) / poly.scale;
    let total = 0;
    poly.coefficients.forEach((coefficient, power) => {
      total += (coefficient * u ** (power + 1)) / (power + 1);
    });
    return total * poly.scale;
  };
  return antiderivative(hi) - antiderivative(lo);
}

function overlap(a: readonly number[], b: readonly number[]): { lo: number; hi: number } {
  const lo = Math.max(Math.min(...a), Math.min(...b));
  const hi = Math.min(Math.max(...a), Math.max(...b));
  if (!(hi > lo)) throw new BdRateInputError('the two curves have no overlapping interval to integrate over');
  return { lo, hi };
}

/** BD-rate of `test` against `anchor` in percent: negative when `test` needs fewer bits at equal quality. */
export function bdRate(anchor: readonly RdPoint[], test: readonly RdPoint[]): number {
  assertPoints('anchor', anchor);
  assertPoints('test', test);
  const qualityA = anchor.map((p) => p.quality);
  const qualityT = test.map((p) => p.quality);
  const { lo, hi } = overlap(qualityA, qualityT);
  const fitA = fitCubic(qualityA, anchor.map((p) => Math.log(p.rate)));
  const fitT = fitCubic(qualityT, test.map((p) => Math.log(p.rate)));
  const meanDifference = (integrate(fitT, lo, hi) - integrate(fitA, lo, hi)) / (hi - lo);
  return (Math.exp(meanDifference) - 1) * PERCENT;
}

/** BD-PSNR of `test` against `anchor` in dB: positive when `test` has the higher quality at equal rate. */
export function bdPsnr(anchor: readonly RdPoint[], test: readonly RdPoint[]): number {
  assertPoints('anchor', anchor);
  assertPoints('test', test);
  const logRateA = anchor.map((p) => Math.log(p.rate));
  const logRateT = test.map((p) => Math.log(p.rate));
  const { lo, hi } = overlap(logRateA, logRateT);
  const fitA = fitCubic(logRateA, anchor.map((p) => p.quality));
  const fitT = fitCubic(logRateT, test.map((p) => p.quality));
  return (integrate(fitT, lo, hi) - integrate(fitA, lo, hi)) / (hi - lo);
}

/** The BD-rate, or null with the reason when the points do not determine one (a curve that is flat or has no quality in common). */
export function tryBdRate(anchor: readonly RdPoint[], test: readonly RdPoint[]): { value: number } | { reason: string } {
  try {
    return { value: bdRate(anchor, test) };
  } catch (error) {
    if (error instanceof BdRateInputError) return { reason: error.message };
    throw error;
  }
}
