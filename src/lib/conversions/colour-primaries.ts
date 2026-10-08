/**
 * RGB primaries as CIE 1931 xy chromaticities and the 3x3 matrices between linear RGB spaces. Standard
 * derivation (SMPTE RP 177): the columns of the RGB to XYZ matrix are the primaries' XYZ scaled so that
 * RGB (1, 1, 1) lands on the white point.
 */

/** Row-major 3x3 matrix. */
export type Matrix3 = readonly [number, number, number, number, number, number, number, number, number];

export interface Xy {
  readonly x: number;
  readonly y: number;
}

export interface Chromaticities {
  readonly red: Xy;
  readonly green: Xy;
  readonly blue: Xy;
  readonly white: Xy;
}

/** D65 white point shared by BT.709, Display P3 and BT.2020 (ITU-T H.273 value 1, 9, 12). */
export const D65_WHITE: Xy = { x: 0.3127, y: 0.329 };

export const BT709_PRIMARIES: Chromaticities = {
  red: { x: 0.64, y: 0.33 },
  green: { x: 0.3, y: 0.6 },
  blue: { x: 0.15, y: 0.06 },
  white: D65_WHITE,
};

export const DISPLAY_P3_PRIMARIES: Chromaticities = {
  red: { x: 0.68, y: 0.32 },
  green: { x: 0.265, y: 0.69 },
  blue: { x: 0.15, y: 0.06 },
  white: D65_WHITE,
};

export const BT2020_PRIMARIES: Chromaticities = {
  red: { x: 0.708, y: 0.292 },
  green: { x: 0.17, y: 0.797 },
  blue: { x: 0.131, y: 0.046 },
  white: D65_WHITE,
};

export const IDENTITY_MATRIX: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Largest absolute entry difference at which two chromaticity sets count as the same primaries. */
const PRIMARIES_TOLERANCE = 0.002;

export function multiply3(a: Matrix3, b: Matrix3): Matrix3 {
  const out: number[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      out.push(a[row * 3] * b[col] + a[row * 3 + 1] * b[3 + col] + a[row * 3 + 2] * b[6 + col]);
    }
  }
  return out as unknown as Matrix3;
}

/** Inverse of a 3x3 matrix; a singular matrix (degenerate primaries) throws RangeError. */
export function invert3(m: Matrix3): Matrix3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const cofactorA = e * i - f * h;
  const cofactorB = f * g - d * i;
  const cofactorC = d * h - e * g;
  const determinant = a * cofactorA + b * cofactorB + c * cofactorC;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < Number.EPSILON) {
    throw new RangeError('colour matrix is singular');
  }
  const inv = 1 / determinant;
  return [
    cofactorA * inv,
    (c * h - b * i) * inv,
    (b * f - c * e) * inv,
    cofactorB * inv,
    (a * i - c * g) * inv,
    (c * d - a * f) * inv,
    cofactorC * inv,
    (b * g - a * h) * inv,
    (a * e - b * d) * inv,
  ];
}

/** CIE XYZ of a chromaticity at Y = 1. */
export function xyzOfXy(p: Xy): readonly [number, number, number] {
  return [p.x / p.y, 1, (1 - p.x - p.y) / p.y];
}

/** Linear RGB (of these primaries) to CIE XYZ, white = the set's white point at Y = 1. */
export function rgbToXyzMatrix(c: Chromaticities): Matrix3 {
  const r = xyzOfXy(c.red);
  const g = xyzOfXy(c.green);
  const b = xyzOfXy(c.blue);
  const w = xyzOfXy(c.white);
  const columns: Matrix3 = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]];
  const inverse = invert3(columns);
  const sr = inverse[0] * w[0] + inverse[1] * w[1] + inverse[2] * w[2];
  const sg = inverse[3] * w[0] + inverse[4] * w[1] + inverse[5] * w[2];
  const sb = inverse[6] * w[0] + inverse[7] * w[1] + inverse[8] * w[2];
  return [r[0] * sr, g[0] * sg, b[0] * sb, r[1] * sr, g[1] * sg, b[1] * sb, r[2] * sr, g[2] * sg, b[2] * sb];
}

/** Bradford cone response matrix. */
const BRADFORD: Matrix3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];

/** Bradford chromatic adaptation taking XYZ relative to the `from` white to XYZ relative to the `to` white. */
export function bradfordAdaptation(from: readonly [number, number, number], to: readonly [number, number, number]): Matrix3 {
  const cone = (white: readonly [number, number, number]): number[] => [
    BRADFORD[0] * white[0] + BRADFORD[1] * white[1] + BRADFORD[2] * white[2],
    BRADFORD[3] * white[0] + BRADFORD[4] * white[1] + BRADFORD[5] * white[2],
    BRADFORD[6] * white[0] + BRADFORD[7] * white[1] + BRADFORD[8] * white[2],
  ];
  const source = cone(from);
  const target = cone(to);
  const scale: Matrix3 = [target[0] / source[0], 0, 0, 0, target[1] / source[1], 0, 0, 0, target[2] / source[2]];
  return multiply3(invert3(BRADFORD), multiply3(scale, BRADFORD));
}

/**
 * Matrix taking linear RGB of the `from` primaries to linear RGB of the `to` primaries. When the white points
 * differ the colours are adapted between them with the Bradford transform.
 */
export function primariesToPrimaries(from: Chromaticities, to: Chromaticities): Matrix3 {
  const adaptation = bradfordAdaptation(xyzOfXy(from.white), xyzOfXy(to.white));
  return multiply3(invert3(rgbToXyzMatrix(to)), multiply3(adaptation, rgbToXyzMatrix(from)));
}

function sameXy(a: Xy, b: Xy): boolean {
  return Math.abs(a.x - b.x) <= PRIMARIES_TOLERANCE && Math.abs(a.y - b.y) <= PRIMARIES_TOLERANCE;
}

export function samePrimaries(a: Chromaticities, b: Chromaticities): boolean {
  return sameXy(a.red, b.red) && sameXy(a.green, b.green) && sameXy(a.blue, b.blue) && sameXy(a.white, b.white);
}
