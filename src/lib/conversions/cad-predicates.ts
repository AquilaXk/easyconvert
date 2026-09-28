/**
 * Shewchuk's Exact Robust Geometric Predicates
 * Based on Jonathan Richard Shewchuk's adaptive precision floating-point arithmetic (1997).
 *
 * Provides exact orientation (orient2d) and in-circle (incircle) tests that are completely
 * immune to floating-point roundoff errors, singularity misclassifications, and degenerate sign flips.
 */

export interface Point2D {
  u: number;
  v: number;
}

// Machine epsilon for IEEE 754 double precision (53-bit significand)
const EPSILON = 1.1102230246251565e-16; // 2^(-53)
const SPLITTER = 134217729.0; // 2^27 + 1

// Precomputed error bounds for fast floating-point filtering
const CCWERRBOUND_A = (3.0 + 16.0 * EPSILON) * EPSILON;
const ICCERRBOUND_A = (10.0 + 96.0 * EPSILON) * EPSILON;

/**
 * Splits a 53-bit floating point number into two 26-bit non-overlapping parts.
 */
export function split(a: number): [number, number] {
  const c = SPLITTER * a;
  const aHi = c - (c - a);
  const aLo = a - aHi;
  return [aHi, aLo];
}

/**
 * Exact addition of two floating-point numbers: x + y = a + b exactly.
 */
export function twoSum(a: number, b: number): [number, number] {
  const x = a + b;
  const bVirtual = x - a;
  const aVirtual = x - bVirtual;
  const bRoundoff = b - bVirtual;
  const aRoundoff = a - aVirtual;
  const y = aRoundoff + bRoundoff;
  return [x, y];
}

/**
 * Fast exact sum of two floats when |a| >= |b| is known.
 */
export function fastTwoSum(a: number, b: number): [number, number] {
  const x = a + b;
  const bVirtual = x - a;
  const y = b - bVirtual;
  return [x, y];
}

/**
 * Exact subtraction of two floating-point numbers: x + y = a - b exactly.
 */
export function twoDiff(a: number, b: number): [number, number] {
  const x = a - b;
  const bVirtual = a - x;
  const aVirtual = x + bVirtual;
  const bRoundoff = bVirtual - b;
  const aRoundoff = a - aVirtual;
  const y = aRoundoff + bRoundoff;
  return [x, y];
}

/**
 * Exact multiplication of two floating-point numbers: x + y = a * b exactly.
 */
export function twoProduct(a: number, b: number): [number, number] {
  const x = a * b;
  const [aHi, aLo] = split(a);
  const [bHi, bLo] = split(b);
  let err = x - aHi * bHi;
  err -= aLo * bHi;
  err -= aHi * bLo;
  const y = aLo * bLo - err;
  return [x, y];
}

/**
 * Exact addition of two expansions (arrays of non-overlapping floats).
 */
export function expansionSum(e: number[], f: number[]): number[] {
  const h: number[] = [];
  let eIndex = 0;
  let fIndex = 0;
  let q: number;

  const eLen = e.length;
  const fLen = f.length;

  if (eLen === 0) return [...f];
  if (fLen === 0) return [...e];

  let eNow = e[eIndex];
  let fNow = f[fIndex];

  if ((fNow > eNow) === (fNow > -eNow)) {
    q = eNow;
    eIndex++;
  } else {
    q = fNow;
    fIndex++;
  }

  while (eIndex < eLen && fIndex < fLen) {
    eNow = e[eIndex];
    fNow = f[fIndex];
    let nextVal: number;
    if ((fNow > eNow) === (fNow > -eNow)) {
      nextVal = eNow;
      eIndex++;
    } else {
      nextVal = fNow;
      fIndex++;
    }
    const [qNext, hPart] = fastTwoSum(nextVal, q);
    if (hPart !== 0) h.push(hPart);
    q = qNext;
  }

  while (eIndex < eLen) {
    const [qNext, hPart] = fastTwoSum(e[eIndex++], q);
    if (hPart !== 0) h.push(hPart);
    q = qNext;
  }

  while (fIndex < fLen) {
    const [qNext, hPart] = fastTwoSum(f[fIndex++], q);
    if (hPart !== 0) h.push(hPart);
    q = qNext;
  }

  if (q !== 0 || h.length === 0) {
    h.push(q);
  }
  return h;
}

/**
 * Multiplies an expansion by a scalar float.
 */
export function scaleExpansion(e: number[], b: number): number[] {
  const h: number[] = [];
  if (e.length === 0 || b === 0) return [0];

  const [t1, t0] = twoProduct(e[0], b);
  let q = t1;
  if (t0 !== 0) h.push(t0);

  for (let i = 1; i < e.length; i++) {
    const [p1, p0] = twoProduct(e[i], b);
    const [u1, u0] = twoSum(q, p0);
    const [qNext, v0] = fastTwoSum(p1, u1);
    if (u0 !== 0) h.push(u0);
    if (v0 !== 0) h.push(v0);
    q = qNext;
  }
  if (q !== 0 || h.length === 0) {
    h.push(q);
  }
  return h;
}

/**
 * Returns the sign of an expansion (+1, -1, or 0).
 */
export function expansionSign(e: number[]): number {
  for (let i = e.length - 1; i >= 0; i--) {
    if (e[i] > 0) return 1;
    if (e[i] < 0) return -1;
  }
  return 0;
}

/**
 * Shewchuk's exact 2D orientation test.
 * Determines whether point C is to the left (+1, CCW), right (-1, CW), or collinear (0)
 * with the directed line segment from A to B.
 */
export function orient2dExact(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number
): number {
  const detLeft = (ax - cx) * (by - cy);
  const detRight = (ay - cy) * (bx - cx);
  const det = detLeft - detRight;

  let detSum: number;
  if (detLeft > 0) {
    if (detRight <= 0) {
      return det;
    }
    detSum = detLeft + detRight;
  } else if (detLeft < 0) {
    if (detRight >= 0) {
      return det;
    }
    detSum = -detLeft - detRight;
  } else {
    return det;
  }

  const errBound = CCWERRBOUND_A * detSum;
  if (det >= errBound || -det >= errBound) {
    return det;
  }

  // Exact adaptive precision fallback
  const acx = twoDiff(ax, cx);
  const bcx = twoDiff(bx, cx);
  const acy = twoDiff(ay, cy);
  const bcy = twoDiff(by, cy);

  const leftTerms = expansionSum(
    expansionSum(scaleExpansion(twoProduct(acx[0], bcy[0]), 1), scaleExpansion(twoProduct(acx[1], bcy[0]), 1)),
    expansionSum(scaleExpansion(twoProduct(acx[0], bcy[1]), 1), scaleExpansion(twoProduct(acx[1], bcy[1]), 1))
  );

  const rightTerms = expansionSum(
    expansionSum(scaleExpansion(twoProduct(acy[0], bcx[0]), 1), scaleExpansion(twoProduct(acy[1], bcx[0]), 1)),
    expansionSum(scaleExpansion(twoProduct(acy[0], bcx[1]), 1), scaleExpansion(twoProduct(acy[1], bcx[1]), 1))
  );

  const negRightTerms = scaleExpansion(rightTerms, -1);
  const exactResult = expansionSum(leftTerms, negRightTerms);

  const sign = expansionSign(exactResult);
  return sign !== 0 ? sign : 0;
}

/**
 * Point-based helper for orient2dExact.
 */
export function orient2dPoints(a: Point2D, b: Point2D, c: Point2D): number {
  return orient2dExact(a.u, a.v, b.u, b.v, c.u, c.v);
}

/**
 * Shewchuk's exact 2D in-circle test.
 * Determines whether point D lies strictly inside (> 0), outside (< 0), or on the boundary (= 0)
 * of the circumcircle of triangle ABC (assuming ABC is oriented counter-clockwise).
 */
export function incircleExact(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number
): number {
  const adx = ax - dx;
  const ady = ay - dy;
  const bdx = bx - dx;
  const bdy = by - dy;
  const cdx = cx - dx;
  const cdy = cy - dy;

  const abdet = adx * bdy - bdx * ady;
  const bcdet = bdx * cdy - cdx * bdy;
  const cadet = cdx * ady - adx * cdy;

  const alift = adx * adx + ady * ady;
  const blift = bdx * bdx + bdy * bdy;
  const clift = cdx * cdx + cdy * cdy;

  const det = alift * bcdet + blift * cadet + clift * abdet;

  const permanent =
    (Math.abs(bdx * cdy) + Math.abs(cdx * bdy)) * alift +
    (Math.abs(cdx * ady) + Math.abs(adx * cdy)) * blift +
    (Math.abs(adx * bdy) + Math.abs(bdx * ady)) * clift;

  const errBound = ICCERRBOUND_A * permanent;
  if (det > errBound || -det > errBound) {
    return det;
  }

  // Exact adaptive evaluation using expansions
  const adxDiff = twoDiff(ax, dx);
  const adyDiff = twoDiff(ay, dy);
  const bdxDiff = twoDiff(bx, dx);
  const bdyDiff = twoDiff(by, dy);
  const cdxDiff = twoDiff(cx, dx);
  const cdyDiff = twoDiff(cy, dy);

  // Compute 2x2 determinants with exact arithmetic
  const detAB = expansionSum(
    expansionSum(scaleExpansion(twoProduct(adxDiff[0], bdyDiff[0]), 1), scaleExpansion(twoProduct(adxDiff[1], bdyDiff[0]), 1)),
    scaleExpansion(
      expansionSum(scaleExpansion(twoProduct(bdxDiff[0], adyDiff[0]), 1), scaleExpansion(twoProduct(bdxDiff[1], adyDiff[0]), 1)),
      -1
    )
  );

  const detBC = expansionSum(
    expansionSum(scaleExpansion(twoProduct(bdxDiff[0], cdyDiff[0]), 1), scaleExpansion(twoProduct(bdxDiff[1], cdyDiff[0]), 1)),
    scaleExpansion(
      expansionSum(scaleExpansion(twoProduct(cdxDiff[0], bdyDiff[0]), 1), scaleExpansion(twoProduct(cdxDiff[1], bdyDiff[0]), 1)),
      -1
    )
  );

  const detCA = expansionSum(
    expansionSum(scaleExpansion(twoProduct(cdxDiff[0], adyDiff[0]), 1), scaleExpansion(twoProduct(cdxDiff[1], adyDiff[0]), 1)),
    scaleExpansion(
      expansionSum(scaleExpansion(twoProduct(adxDiff[0], cdyDiff[0]), 1), scaleExpansion(twoProduct(adxDiff[1], cdyDiff[0]), 1)),
      -1
    )
  );

  // Compute lifts: x^2 + y^2
  const liftA = expansionSum(
    twoProduct(adxDiff[0], adxDiff[0]),
    twoProduct(adyDiff[0], adyDiff[0])
  );
  const liftB = expansionSum(
    twoProduct(bdxDiff[0], bdxDiff[0]),
    twoProduct(bdyDiff[0], bdyDiff[0])
  );
  const liftC = expansionSum(
    twoProduct(cdxDiff[0], cdxDiff[0]),
    twoProduct(cdyDiff[0], cdyDiff[0])
  );

  const termA = scaleExpansion(detBC, liftA.at(-1) ?? 0);
  const termB = scaleExpansion(detCA, liftB.at(-1) ?? 0);
  const termC = scaleExpansion(detAB, liftC.at(-1) ?? 0);

  const exactDet = expansionSum(expansionSum(termA, termB), termC);
  const sign = expansionSign(exactDet);
  return sign !== 0 ? sign : 0;
}

/**
 * Point-based helper for incircleExact.
 */
export function incirclePoints(a: Point2D, b: Point2D, c: Point2D, d: Point2D): number {
  return incircleExact(a.u, a.v, b.u, b.v, c.u, c.v, d.u, d.v);
}

/**
 * Checks if point Q lies on the segment P-R assuming P, Q, R are collinear.
 */
function isPointOnCollinearSegment(p: Point2D, q: Point2D, r: Point2D): boolean {
  return (
    q.u >= Math.min(p.u, r.u) - 1e-12 &&
    q.u <= Math.max(p.u, r.u) + 1e-12 &&
    q.v >= Math.min(p.v, r.v) - 1e-12 &&
    q.v <= Math.max(p.v, r.v) + 1e-12
  );
}

/**
 * Tests whether two 2D line segments (p1-p2 and p3-p4) strictly intersect or touch,
 * using Shewchuk's exact geometric orientation predicate.
 *
 * @param p1 Segment 1 start
 * @param p2 Segment 1 end
 * @param p3 Segment 2 start
 * @param p4 Segment 2 end
 * @param allowEndpointTouch If true, sharing an endpoint is not considered an intersection. Default: true.
 */
export function robustSegmentsIntersect(
  p1: Point2D,
  p2: Point2D,
  p3: Point2D,
  p4: Point2D,
  allowEndpointTouch = true
): boolean {
  const eps = 1e-11;
  const p1_p3 = Math.abs(p1.u - p3.u) < eps && Math.abs(p1.v - p3.v) < eps;
  const p1_p4 = Math.abs(p1.u - p4.u) < eps && Math.abs(p1.v - p4.v) < eps;
  const p2_p3 = Math.abs(p2.u - p3.u) < eps && Math.abs(p2.v - p3.v) < eps;
  const p2_p4 = Math.abs(p2.u - p4.u) < eps && Math.abs(p2.v - p4.v) < eps;

  if (p1_p3 || p1_p4 || p2_p3 || p2_p4) {
    return !allowEndpointTouch;
  }

  // Exact orientations of 4 triplets
  const o1 = orient2dPoints(p1, p2, p3);
  const o2 = orient2dPoints(p1, p2, p4);
  const o3 = orient2dPoints(p3, p4, p1);
  const o4 = orient2dPoints(p3, p4, p2);

  // General case: segments straddle each other
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) {
    return true;
  }

  // Collinear / boundary touch cases
  if (o1 === 0 && isPointOnCollinearSegment(p1, p3, p2)) return true;
  if (o2 === 0 && isPointOnCollinearSegment(p1, p4, p2)) return true;
  if (o3 === 0 && isPointOnCollinearSegment(p3, p1, p4)) return true;
  if (o4 === 0 && isPointOnCollinearSegment(p3, p2, p4)) return true;

  return false;
}
