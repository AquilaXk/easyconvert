import { ConversionFailedError } from '../types';

// Cubic and quadratic Bézier conversion for glyph outlines, moved out of font.ts unchanged.

export type BezierPoint = { x: number; y: number };

/**
 * Upper bound on quadratic pieces produced for one cubic; exceeding it fails closed. A cubic spanning
 * the whole 16-bit coordinate range needs about 23 pieces at the default tolerance, so 64 leaves headroom
 * and is reached only by malformed coordinates or a tolerance far below one font unit.
 */
const MAX_QUADRATIC_PIECES_PER_CUBIC = 64;
/**
 * Coefficient of the midpoint-quadratic error bound: the largest distance between a cubic
 * and its quadratic approximation is at most (sqrt(3) / 36) * |P3 - 3*C2 + 3*C1 - P0|.
 */
const CUBIC_TO_QUADRATIC_ERROR_COEFFICIENT = Math.sqrt(3) / 36;
/** Guards the cube root against floating point noise when the bound equals a whole piece count. */
const PIECE_COUNT_EPSILON = 1e-9;

function lerpPoint(a: BezierPoint, b: BezierPoint, t: number): BezierPoint {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function isFinitePoint(pt: BezierPoint): boolean {
  return Number.isFinite(pt.x) && Number.isFinite(pt.y);
}

/**
 * Approximates a cubic Bézier curve with a chain of quadratic Bézier curves.
 *
 * Each quadratic uses the control point that matches the cubic at its midpoint. Its distance to
 * the cubic is bounded by (sqrt(3) / 36) * |third difference|, and uniformly splitting the
 * cubic into n pieces divides that bound by n^3, so the smallest n meeting `tolerance` is chosen
 * directly. Pieces are cut with de Casteljau subdivision. The first piece starts exactly at P0
 * and the last piece ends exactly at P3, so adjacent glyph segments stay watertight.
 *
 * Throws ConversionFailedError for non-finite input, a non-positive tolerance, or when more
 * than MAX_QUADRATIC_PIECES_PER_CUBIC pieces would be needed (no silent loss of accuracy).
 */
export function cubicToQuadraticBezier(
  P0: BezierPoint,
  C1: BezierPoint,
  C2: BezierPoint,
  P3: BezierPoint,
  tolerance = 1.5
): Array<{
  q: BezierPoint;
  p: BezierPoint;
  p0?: BezierPoint;
  p2?: BezierPoint;
}> {
  if (![P0, C1, C2, P3].every(isFinitePoint)) {
    throw new ConversionFailedError('Cannot convert cubic Bézier: control points must be finite numbers.');
  }
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new ConversionFailedError('Cannot convert cubic Bézier: tolerance must be a positive finite number.');
  }

  const thirdDifference = Math.hypot(
    P3.x - 3 * C2.x + 3 * C1.x - P0.x,
    P3.y - 3 * C2.y + 3 * C1.y - P0.y
  );
  const errorBound = CUBIC_TO_QUADRATIC_ERROR_COEFFICIENT * thirdDifference;
  const pieceCount = Math.max(1, Math.ceil(Math.cbrt(errorBound / tolerance) - PIECE_COUNT_EPSILON));
  if (pieceCount > MAX_QUADRATIC_PIECES_PER_CUBIC) {
    throw new ConversionFailedError(
      `Cannot convert cubic Bézier within tolerance ${tolerance}: ${pieceCount} quadratic pieces exceed the limit of ${MAX_QUADRATIC_PIECES_PER_CUBIC}.`
    );
  }

  const pieces: Array<{ q: BezierPoint; p: BezierPoint; p0: BezierPoint; p2: BezierPoint }> = [];
  let a = P0;
  let b = C1;
  let c = C2;
  const d = P3;
  for (let i = 0; i < pieceCount; i++) {
    const remaining = pieceCount - i;
    let end = d;
    let nextB = b;
    let nextC = c;
    let leftC1 = b;
    let leftC2 = c;
    if (remaining > 1) {
      // De Casteljau split of the remaining cubic at t = 1 / remaining.
      const t = 1 / remaining;
      const ab = lerpPoint(a, b, t);
      const bc = lerpPoint(b, c, t);
      const cd = lerpPoint(c, d, t);
      const abc = lerpPoint(ab, bc, t);
      const bcd = lerpPoint(bc, cd, t);
      end = lerpPoint(abc, bcd, t);
      leftC1 = ab;
      leftC2 = abc;
      nextB = bcd;
      nextC = cd;
    }
    const q = {
      x: (3 * (leftC1.x + leftC2.x) - (a.x + end.x)) / 4,
      y: (3 * (leftC1.y + leftC2.y) - (a.y + end.y)) / 4,
    };
    pieces.push({ q, p: end, p0: a, p2: end });
    a = end;
    b = nextB;
    c = nextC;
  }
  return pieces;
}

/**
 * Exact conversion of a quadratic Bézier curve to a cubic Bézier curve.
 */
export function quadraticToCubicBezier(
  P0: { x: number; y: number },
  Q: { x: number; y: number },
  P2: { x: number; y: number }
): {
  C1: { x: number; y: number };
  C2: { x: number; y: number };
  P3: { x: number; y: number };
  c1: { x: number; y: number };
  c2: { x: number; y: number };
  p3: { x: number; y: number };
} {
  const c1 = {
    x: P0.x + (2 / 3) * (Q.x - P0.x),
    y: P0.y + (2 / 3) * (Q.y - P0.y),
  };
  const c2 = {
    x: P2.x + (2 / 3) * (Q.x - P2.x),
    y: P2.y + (2 / 3) * (Q.y - P2.y),
  };
  return {
    C1: c1,
    C2: c2,
    P3: P2,
    c1,
    c2,
    p3: P2,
  };
}
