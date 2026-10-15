import sharp from 'sharp';

/**
 * Fixtures and curve interpolation for the graphic-content parity tests. The fixtures are drawn here, with known
 * flat areas and hard edges, so that no expectation depends on the converter under test.
 */

export const SIDE = 256;
const GRID = 16;

export function svgPng(body: string, width = SIDE, height = SIDE): Promise<Buffer> {
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`)).png().toBuffer();
}

/** One-pixel black lines on white: a grid, two diagonals and two circles. 16-bit grey, as the benchmark's line art is. */
export async function lineArt16(): Promise<Buffer> {
  const lines: string[] = [];
  for (let at = GRID; at < SIDE; at += GRID) lines.push(`M${at} 0V${SIDE}M0 ${at}H${SIDE}`);
  const body =
    '<rect width="100%" height="100%" fill="#fff"/>' +
    `<g fill="none" stroke="#000" stroke-width="1"><path d="${lines.join('')}M0 0L${SIDE} ${SIDE}M${SIDE} 0L0 ${SIDE}"/>` +
    '<circle cx="128" cy="128" r="90"/><circle cx="128" cy="128" r="45"/></g>';
  return sharp(await svgPng(body)).toColourspace('grey16').png().toBuffer();
}

/** An interface: flat panels with hard coloured edges and a strip of one-pixel rules. 16-bit RGB. */
export async function interface16(): Promise<Buffer> {
  const body =
    '<rect width="100%" height="100%" fill="#eceff1"/><rect width="256" height="28" fill="#2c3e50"/>' +
    '<rect x="12" y="44" width="96" height="26" rx="5" fill="#3498db"/><rect x="124" y="44" width="96" height="26" rx="5" fill="#e74c3c"/>' +
    '<rect x="12" y="88" width="208" height="64" fill="#fff" stroke="#95a5a6"/><path d="M20 100H210M20 112H190M20 124H200M20 136H170" stroke="#34495e" stroke-width="2"/>' +
    '<circle cx="40" cy="190" r="16" fill="#27ae60"/><rect x="72" y="176" width="150" height="3" fill="#8e44ad"/><rect x="72" y="196" width="110" height="3" fill="#f39c12"/>';
  return sharp(await svgPng(body)).toColourspace('rgb16').png().toBuffer();
}

export interface Point {
  bytes: number;
  value: number;
}

/** Reference quality at `bytes`: linear in ln(size) between the two reference points around it. */
export function interpolateAt(points: Point[], bytes: number): number {
  const sorted = [...points].sort((a, b) => a.bytes - b.bytes);
  for (let i = 1; i < sorted.length; i += 1) {
    const lo = sorted[i - 1];
    const hi = sorted[i];
    if (bytes >= lo.bytes && bytes <= hi.bytes) {
      const share = (Math.log(bytes) - Math.log(lo.bytes)) / (Math.log(hi.bytes) - Math.log(lo.bytes));
      return lo.value + share * (hi.value - lo.value);
    }
  }
  throw new Error(`${bytes} bytes lies outside the reference curve ${sorted[0].bytes}..${sorted[sorted.length - 1].bytes}`);
}

/** Solves the small dense system `a x = b` by Gaussian elimination with partial pivoting. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    for (let row = col + 1; row < n; row += 1) {
      const factor = a[row][col] / a[col][col];
      for (let k = col; k < n; k += 1) a[row][k] -= factor * a[col][k];
      b[row] -= factor * b[col];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let rest = b[row];
    for (let k = row + 1; k < n; k += 1) rest -= a[row][k] * x[k];
    x[row] = rest / a[row][row];
  }
  return x;
}

const CUBIC_TERMS = 4;

/** Least-squares cubic of ln(bytes) over the quality metric, on metric values centred and scaled to [-1, 1]. */
function fitLogRate(points: Point[], centre: number, half: number): number[] {
  const normal = Array.from({ length: CUBIC_TERMS }, () => new Array<number>(CUBIC_TERMS).fill(0));
  const rhs = new Array<number>(CUBIC_TERMS).fill(0);
  for (const { bytes, value } of points) {
    const t = (value - centre) / half;
    for (let i = 0; i < CUBIC_TERMS; i += 1) {
      rhs[i] += t ** i * Math.log(bytes);
      for (let j = 0; j < CUBIC_TERMS; j += 1) normal[i][j] += t ** (i + j);
    }
  }
  return solve(normal, rhs);
}

function integrateCubic(c: number[], from: number, to: number): number {
  const antiderivative = (t: number): number => c.reduce((sum, coefficient, i) => sum + (coefficient * t ** (i + 1)) / (i + 1), 0);
  return antiderivative(to) - antiderivative(from);
}

/**
 * Bjontegaard delta rate of `test` against `anchor`, in percent (positive means `test` needs more bytes for the same quality).
 * Each curve is a cubic fit of ln(bytes) over the quality metric; the fits are integrated over the metric range both curves cover.
 */
export function bdRatePercent(anchor: Point[], test: Point[]): number {
  if (anchor.length < CUBIC_TERMS || test.length < CUBIC_TERMS) throw new Error(`BD-rate needs at least ${CUBIC_TERMS} points per curve`);
  const span = (points: Point[]): [number, number] => [Math.min(...points.map((p) => p.value)), Math.max(...points.map((p) => p.value))];
  const [anchorLo, anchorHi] = span(anchor);
  const [testLo, testHi] = span(test);
  const lo = Math.max(anchorLo, testLo);
  const hi = Math.min(anchorHi, testHi);
  if (!(hi > lo)) throw new Error(`The curves share no quality range: ${anchorLo}..${anchorHi} against ${testLo}..${testHi}`);
  const centre = (lo + hi) / 2;
  const half = (hi - lo) / 2;
  const anchorFit = fitLogRate(anchor, centre, half);
  const testFit = fitLogRate(test, centre, half);
  const meanDifference = (integrateCubic(testFit, -1, 1) - integrateCubic(anchorFit, -1, 1)) / 2;
  return (Math.exp(meanDifference) - 1) * 100;
}
