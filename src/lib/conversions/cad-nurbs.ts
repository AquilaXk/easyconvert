/**
 * CAD NURBS Engine - Pure Mathematical de Boor-Cox Algorithm & STEP/IGES Tessellator
 *
 * Implements:
 * 1. Cox-de Boor recursive basis functions N_{i,p}(u) and derivatives N'_{i,p}(u)
 * 2. Rational & non-rational B-spline curves and surfaces evaluation S(u, v)
 * 3. Analytical surface normal computation n(u, v) = (dS/du x dS/dv) / |dS/du x dS/dv|
 * 4. Adaptive & uniform (u, v) grid sampling and triangle mesh generation
 * 5. STEP (ISO 10303-21) B-Spline entity parser (B_SPLINE_CURVE_WITH_KNOTS,
 *    B_SPLINE_SURFACE_WITH_KNOTS, RATIONAL_B_SPLINE_SURFACE, ADVANCED_FACE, EDGE_LOOP, etc.)
 * 6. IGES Entity 128 (B-Spline Surface) and 126 (B-Spline Curve) parser
 */

import {
  orient2dPoints,
  incirclePoints,
  robustSegmentsIntersect,
  orient2dExact,
  incircleExact,
  windingNumberPointInPolygon,
} from './cad-predicates';
import { CadGeometryUnavailableError, CadTopologyError, ConversionOptions } from '../types';

export interface Point3D {
  x: number;
  y: number;
  z: number;
}

export interface BSplineCurve {
  degree: number;
  controlPoints: Point3D[];
  weights?: number[];
  knots: number[];
}

export interface BSplineSurface {
  uDegree: number;
  vDegree: number;
  controlPoints: Point3D[][]; // [u][v]
  weights?: number[][]; // [u][v]
  uKnots: number[];
  vKnots: number[];
  uClosed?: boolean;
  vClosed?: boolean;
}

export interface TessellatedMesh {
  name: string;
  vertices: [number, number, number][];
  normals: [number, number, number][];
  faces: [number, number, number][];
  topologyReport?: MeshTopologyReport;
  unit?: string;
}

// ============================================================================
// 1. Pure Mathematical Cox-de Boor Basis Function & Derivative Algorithm
// ============================================================================

/**
 * Evaluates the i-th B-spline basis function of degree p at parameter u: N_{i,p}(u).
 * Uses the Cox-de Boor recurrence relation with exact handling of boundary knots.
 */
export function coxDeBoorBasis(i: number, p: number, u: number, knots: number[]): number {
  if (i < 0 || i + p + 1 >= knots.length) return 0.0;
  if (p === 0) {
    const uStart = knots[i];
    const uEnd = knots[i + 1];
    const uMax = knots.at(-1) ?? knots[0];

    // Boundary condition: include right endpoint for the last active knot interval
    if (u >= uStart && (u < uEnd || (u === uMax && u <= uEnd && uStart < uEnd))) {
      return 1.0;
    }
    return 0.0;
  }

  let left = 0.0;
  let right = 0.0;

  const denomLeft = knots[i + p] - knots[i];
  if (denomLeft > 1e-12) {
    left = ((u - knots[i]) / denomLeft) * coxDeBoorBasis(i, p - 1, u, knots);
  }

  const denomRight = knots[i + p + 1] - knots[i + 1];
  if (denomRight > 1e-12) {
    right = ((knots[i + p + 1] - u) / denomRight) * coxDeBoorBasis(i + 1, p - 1, u, knots);
  }

  return left + right;
}

/**
 * Evaluates the first derivative of the i-th B-spline basis function: N'_{i,p}(u)
 */
export function coxDeBoorBasisDerivative(i: number, p: number, u: number, knots: number[]): number {
  if (p === 0) return 0.0;

  let left = 0.0;
  let right = 0.0;

  const denomLeft = knots[i + p] - knots[i];
  if (denomLeft > 1e-12) {
    left = (p / denomLeft) * coxDeBoorBasis(i, p - 1, u, knots);
  }

  const denomRight = knots[i + p + 1] - knots[i + 1];
  if (denomRight > 1e-12) {
    right = (p / denomRight) * coxDeBoorBasis(i + 1, p - 1, u, knots);
  }

  return left - right;
}

/**
 * Computes all non-zero B-spline basis functions of degree p at parameter u.
 * Returns an array of size (n + 1).
 */
export function evaluateAllBasis(n: number, p: number, u: number, knots: number[]): number[] {
  const basis = new Array<number>(n + 1).fill(0);
  for (let i = 0; i <= n; i++) {
    basis[i] = coxDeBoorBasis(i, p, u, knots);
  }
  return basis;
}

/**
 * Computes all basis function derivatives of degree p at parameter u.
 * Returns an array of size (n + 1).
 */
export function evaluateAllBasisDerivatives(n: number, p: number, u: number, knots: number[]): number[] {
  const derivs = new Array<number>(n + 1).fill(0);
  for (let i = 0; i <= n; i++) {
    derivs[i] = coxDeBoorBasisDerivative(i, p, u, knots);
  }
  return derivs;
}

// ============================================================================
// 2. B-Spline / NURBS Curve Evaluation
// ============================================================================

/**
 * Evaluates a B-spline or NURBS curve at parameter u: C(u)
 */
export function evaluateBSplineCurve(curve: BSplineCurve, u: number): Point3D {
  const { degree, controlPoints, weights, knots } = curve;
  const n = controlPoints.length - 1;

  let x = 0;
  let y = 0;
  let z = 0;
  let wSum = 0;

  for (let i = 0; i <= n; i++) {
    const basisVal = coxDeBoorBasis(i, degree, u, knots);
    if (basisVal === 0) continue;
    const w = weights ? weights[i] : 1.0;
    const prod = basisVal * w;

    x += controlPoints[i].x * prod;
    y += controlPoints[i].y * prod;
    z += controlPoints[i].z * prod;
    wSum += prod;
  }

  const denom = wSum !== 0 ? wSum : 1.0;
  return { x: x / denom, y: y / denom, z: z / denom };
}

/**
 * Evaluates Cubic Bezier curve at parameter t in [0, 1] using Bernstein polynomials:
 * B(t) = (1-t)^3 * P0 + 3*(1-t)^2*t * P1 + 3*(1-t)*t^2 * P2 + t^3 * P3
 */
export function evaluateCubicBezier(p0: Point3D, p1: Point3D, p2: Point3D, p3: Point3D, t: number): Point3D {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;

  const c0 = uuu;
  const c1 = 3 * uu * t;
  const c2 = 3 * u * tt;
  const c3 = ttt;

  return {
    x: c0 * p0.x + c1 * p1.x + c2 * p2.x + c3 * p3.x,
    y: c0 * p0.y + c1 * p1.y + c2 * p2.y + c3 * p3.y,
    z: c0 * p0.z + c1 * p1.z + c2 * p2.z + c3 * p3.z,
  };
}

/**
 * Evaluates first derivative of Cubic Bezier curve:
 * B'(t) = 3*(1-t)^2 * (P1 - P0) + 6*(1-t)*t * (P2 - P1) + 3*t^2 * (P3 - P2)
 */
export function evaluateCubicBezierDerivative(p0: Point3D, p1: Point3D, p2: Point3D, p3: Point3D, t: number): Point3D {
  const u = 1 - t;
  const c0 = 3 * u * u;
  const c1 = 6 * u * t;
  const c2 = 3 * t * t;

  return {
    x: c0 * (p1.x - p0.x) + c1 * (p2.x - p1.x) + c2 * (p3.x - p2.x),
    y: c0 * (p1.y - p0.y) + c1 * (p2.y - p1.y) + c2 * (p3.y - p2.y),
    z: c0 * (p1.z - p0.z) + c1 * (p2.z - p1.z) + c2 * (p3.z - p2.z),
  };
}

/**
 * Evaluates Quadratic Bezier curve:
 * Q(t) = (1-t)^2 * P0 + 2*(1-t)*t * P1 + t^2 * P2
 */
export function evaluateQuadraticBezier(p0: Point3D, p1: Point3D, p2: Point3D, t: number): Point3D {
  const u = 1 - t;
  const c0 = u * u;
  const c1 = 2 * u * t;
  const c2 = t * t;
  return {
    x: c0 * p0.x + c1 * p1.x + c2 * p2.x,
    y: c0 * p0.y + c1 * p1.y + c2 * p2.y,
    z: c0 * p0.z + c1 * p1.z + c2 * p2.z,
  };
}

/**
 * Converts a Cubic Bezier curve into an equivalent degree-3 B-Spline curve
 * with clamped knot vector [0, 0, 0, 0, 1, 1, 1, 1] and unit weights.
 */
export function cubicBezierToBSpline(p0: Point3D, p1: Point3D, p2: Point3D, p3: Point3D): BSplineCurve {
  return {
    degree: 3,
    controlPoints: [p0, p1, p2, p3],
    knots: [0, 0, 0, 0, 1, 1, 1, 1],
    weights: [1, 1, 1, 1],
  };
}

/**
 * Adaptive tessellation of Cubic Bezier curve using recursive de Casteljau subdivision
 * based on chord deviation tolerance.
 */
export function adaptiveTessellateCubicBezier(
  p0: Point3D,
  p1: Point3D,
  p2: Point3D,
  p3: Point3D,
  tolerance: number = 0.5,
  maxDepth: number = 8
): Point3D[] {
  const points: Point3D[] = [p0];

  function subdivide(
    a0: Point3D,
    a1: Point3D,
    a2: Point3D,
    a3: Point3D,
    depth: number
  ) {
    const dx = a3.x - a0.x;
    const dy = a3.y - a0.y;
    const dz = a3.z - a0.z;
    const lineLen = Math.hypot(dx, dy, dz);

    let d1 = 0;
    let d2 = 0;
    if (lineLen > 1e-6) {
      const vx1 = a1.x - a0.x;
      const vy1 = a1.y - a0.y;
      const vz1 = a1.z - a0.z;
      const cross1x = vy1 * dz - vz1 * dy;
      const cross1y = vz1 * dx - vx1 * dz;
      const cross1z = vx1 * dy - vy1 * dx;
      d1 = Math.hypot(cross1x, cross1y, cross1z) / lineLen;

      const vx2 = a2.x - a0.x;
      const vy2 = a2.y - a0.y;
      const vz2 = a2.z - a0.z;
      const cross2x = vy2 * dz - vz2 * dy;
      const cross2y = vz2 * dx - vx2 * dz;
      const cross2z = vx2 * dy - vy2 * dx;
      d2 = Math.hypot(cross2x, cross2y, cross2z) / lineLen;
    }

    if ((d1 <= tolerance && d2 <= tolerance) || depth >= maxDepth) {
      points.push(a3);
      return;
    }

    // de Casteljau split at t = 0.5
    const q0 = { x: (a0.x + a1.x) * 0.5, y: (a0.y + a1.y) * 0.5, z: (a0.z + a1.z) * 0.5 };
    const q1 = { x: (a1.x + a2.x) * 0.5, y: (a1.y + a2.y) * 0.5, z: (a1.z + a2.z) * 0.5 };
    const q2 = { x: (a2.x + a3.x) * 0.5, y: (a2.y + a3.y) * 0.5, z: (a2.z + a3.z) * 0.5 };

    const r0 = { x: (q0.x + q1.x) * 0.5, y: (q0.y + q1.y) * 0.5, z: (q0.z + q1.z) * 0.5 };
    const r1 = { x: (q1.x + q2.x) * 0.5, y: (q1.y + q2.y) * 0.5, z: (q1.z + q2.z) * 0.5 };

    const s = { x: (r0.x + r1.x) * 0.5, y: (r0.y + r1.y) * 0.5, z: (r0.z + r1.z) * 0.5 };

    subdivide(a0, q0, r0, s, depth + 1);
    subdivide(s, r1, q2, a3, depth + 1);
  }

  subdivide(p0, p1, p2, p3, 0);
  return points;
}

/**
 * Tessellates an SVG elliptical arc path command into discrete 3D points
 * using the W3C SVG 1.1 endpoint-to-center parameterization algorithm.
 */
export interface SvgArcParams {
  x1: number;
  y1: number;
  rx: number;
  ry: number;
  phiDeg: number;
  largeArcFlag: boolean | number;
  sweepFlag: boolean | number;
  x2: number;
  y2: number;
}

/**
 * Tessellates an SVG elliptical arc path command into discrete 3D points
 * using the W3C SVG 1.1 endpoint-to-center parameterization algorithm.
 */
export function tessellateSvgArc(params: SvgArcParams): Point3D[];
export function tessellateSvgArc(
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  phiDeg: number,
  largeArcFlag: boolean | number,
  sweepFlag: boolean | number,
  x2: number,
  y2: number
): Point3D[];
export function tessellateSvgArc(
  pOrX1: SvgArcParams | number,
  ...args: any[]
): Point3D[] {
  let x1: number, y1: number, rxIn: number, ryIn: number, phiDeg: number;
  let largeArcFlag: boolean | number, sweepFlag: boolean | number, x2: number, y2: number;

  if (typeof pOrX1 === 'object') {
    x1 = pOrX1.x1;
    y1 = pOrX1.y1;
    rxIn = pOrX1.rx;
    ryIn = pOrX1.ry;
    phiDeg = pOrX1.phiDeg;
    largeArcFlag = pOrX1.largeArcFlag;
    sweepFlag = pOrX1.sweepFlag;
    x2 = pOrX1.x2;
    y2 = pOrX1.y2;
  } else {
    x1 = pOrX1;
    y1 = args[0];
    rxIn = args[1];
    ryIn = args[2];
    phiDeg = args[3];
    largeArcFlag = args[4];
    sweepFlag = args[5];
    x2 = args[6];
    y2 = args[7];
  }

  if (Math.abs(x1 - x2) < 1e-7 && Math.abs(y1 - y2) < 1e-7) {
    return [{ x: x2, y: y2, z: 0 }];
  }

  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);

  if (rx < 1e-7 || ry < 1e-7) {
    return [{ x: x2, y: y2, z: 0 }];
  }

  const phi = (phiDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1Prime = cosPhi * dx + sinPhi * dy;
  const y1Prime = -sinPhi * dx + cosPhi * dy;

  const lambda = (x1Prime * x1Prime) / (rx * rx) + (y1Prime * y1Prime) / (ry * ry);
  if (lambda > 1) {
    const sqrtLambda = Math.sqrt(lambda);
    rx *= sqrtLambda;
    ry *= sqrtLambda;
  }

  const rxSq = rx * rx;
  const rySq = ry * ry;
  const x1PrimeSq = x1Prime * x1Prime;
  const y1PrimeSq = y1Prime * y1Prime;

  let num = rxSq * rySq - rxSq * y1PrimeSq - rySq * x1PrimeSq;
  if (num < 0) num = 0;
  const den = rxSq * y1PrimeSq + rySq * x1PrimeSq;
  const flagA = largeArcFlag ? 1 : 0;
  const flagB = sweepFlag ? 1 : 0;
  const sign = flagA === flagB ? -1 : 1;
  const factor = sign * Math.sqrt(num / den);

  const cxPrime = factor * ((rx * y1Prime) / ry);
  const cyPrime = factor * (-(ry * x1Prime) / rx);

  const cx = cosPhi * cxPrime - sinPhi * cyPrime + (x1 + x2) / 2;
  const cy = sinPhi * cxPrime + cosPhi * cyPrime + (y1 + y2) / 2;

  function angleBetween(ux: number, uy: number, vx: number, vy: number): number {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let ang = Math.acos(Math.max(-1, Math.min(1, dot / (len || 1))));
    if (ux * vy - uy * vx < 0) ang = -ang;
    return ang;
  }

  const ux = (x1Prime - cxPrime) / rx;
  const uy = (y1Prime - cyPrime) / ry;
  const vx = (-x1Prime - cxPrime) / rx;
  const vy = (-y1Prime - cyPrime) / ry;

  const theta1 = angleBetween(1, 0, ux, uy);
  let deltaTheta = angleBetween(ux, uy, vx, vy);

  const sweep = sweepFlag ? 1 : 0;
  if (!sweep && deltaTheta > 0) {
    deltaTheta -= 2 * Math.PI;
  } else if (sweep && deltaTheta < 0) {
    deltaTheta += 2 * Math.PI;
  }

  const segments = Math.max(4, Math.min(64, Math.ceil(Math.abs(deltaTheta) / (Math.PI / 16))));
  const points: Point3D[] = [];

  for (let s = 1; s <= segments; s++) {
    const theta = theta1 + (deltaTheta * s) / segments;
    const cosTheta = Math.cos(theta);
    const sinTheta = Math.sin(theta);

    const px = cosPhi * (rx * cosTheta) - sinPhi * (ry * sinTheta) + cx;
    const py = sinPhi * (rx * cosTheta) + cosPhi * (ry * sinTheta) + cy;
    points.push({ x: px, y: py, z: 0 });
  }

  return points;
}

// ============================================================================
// 3. B-Spline / NURBS Surface Evaluation & Exact Analytical Normals
// ============================================================================

export interface SurfaceEvaluationResult {
  point: Point3D;
  dSud: Point3D; // dS/du
  dSvd: Point3D; // dS/dv
  normal: Point3D; // unit normal
}

/**
 * Evaluates B-spline / NURBS surface point and exact analytical normal at (u, v)
 * using the Cox-de Boor basis function values and derivatives.
 */
export function evaluateBSplineSurface(
  surface: BSplineSurface,
  u: number,
  v: number
): SurfaceEvaluationResult {
  const { uDegree, vDegree, controlPoints, weights, uKnots, vKnots } = surface;
  const numU = controlPoints.length;
  const numV = controlPoints[0].length;
  const nU = numU - 1;
  const nV = numV - 1;

  const nuBasis = evaluateAllBasis(nU, uDegree, u, uKnots);
  const nvBasis = evaluateAllBasis(nV, vDegree, v, vKnots);
  const nuDeriv = evaluateAllBasisDerivatives(nU, uDegree, u, uKnots);
  const nvDeriv = evaluateAllBasisDerivatives(nV, vDegree, v, vKnots);

  // Homogeneous coordinates and partial derivatives
  let Sx = 0, Sy = 0, Sz = 0, Sw = 0;
  let dSu_x = 0, dSu_y = 0, dSu_z = 0, dSu_w = 0;
  let dSv_x = 0, dSv_y = 0, dSv_z = 0, dSv_w = 0;

  for (let i = 0; i <= nU; i++) {
    const bu = nuBasis[i];
    const dbu = nuDeriv[i];

    for (let j = 0; j <= nV; j++) {
      const bv = nvBasis[j];
      const dbv = nvDeriv[j];

      const w = weights ? weights[i][j] : 1.0;
      const pt = controlPoints[i][j];

      // Basis products
      const pB = bu * bv * w;
      const pDu = dbu * bv * w;
      const pDv = bu * dbv * w;

      Sx += pt.x * pB;
      Sy += pt.y * pB;
      Sz += pt.z * pB;
      Sw += pB;

      dSu_x += pt.x * pDu;
      dSu_y += pt.y * pDu;
      dSu_z += pt.z * pDu;
      dSu_w += pDu;

      dSv_x += pt.x * pDv;
      dSv_y += pt.y * pDv;
      dSv_z += pt.z * pDv;
      dSv_w += pDv;
    }
  }

  const wVal = Math.abs(Sw) > 1e-12 ? Sw : 1.0;
  const point: Point3D = {
    x: Sx / wVal,
    y: Sy / wVal,
    z: Sz / wVal,
  };

  // Quotient rule for derivatives of S = (Sx, Sy, Sz) / Sw:
  // dS/du = (dSu * Sw - S * dSu_w) / Sw^2
  const wSq = wVal * wVal;
  const dSud: Point3D = {
    x: (dSu_x * wVal - Sx * dSu_w) / wSq,
    y: (dSu_y * wVal - Sy * dSu_w) / wSq,
    z: (dSu_z * wVal - Sz * dSu_w) / wSq,
  };

  const dSvd: Point3D = {
    x: (dSv_x * wVal - Sx * dSv_w) / wSq,
    y: (dSv_y * wVal - Sy * dSv_w) / wSq,
    z: (dSv_z * wVal - Sz * dSv_w) / wSq,
  };

  // Cross product: n = dSud x dSvd
  const nx = dSud.y * dSvd.z - dSud.z * dSvd.y;
  const ny = dSud.z * dSvd.x - dSud.x * dSvd.z;
  const nz = dSud.x * dSvd.y - dSud.y * dSvd.x;

  const len = Math.hypot(nx, ny, nz);
  let normal: Point3D;

  if (len > 1e-10) {
    normal = { x: nx / len, y: ny / len, z: nz / len };
  } else {
    // Fallback normal if gradient vanishes at singular pole
    normal = { x: 0, y: 0, z: 1 };
  }

  return { point, dSud, dSvd, normal };
}

// ============================================================================
// 4. NURBS Surface Tessellation Algorithm
// ============================================================================

export interface TessellationOptions {
  uSamples?: number;
  vSamples?: number;
}

/**
 * Tessellates a B-spline surface into a triangular mesh with exact analytical normals
 * using parameter grid sampling.
 */
export function tessellateBSplineSurface(
  surface: BSplineSurface,
  options: TessellationOptions = {},
  meshName = 'nurbs_surface'
): TessellatedMesh {
  const uSamples = Math.max(4, Math.min(64, options.uSamples || 16));
  const vSamples = Math.max(4, Math.min(64, options.vSamples || 16));

  const uMin = surface.uKnots && surface.uKnots.length > surface.uDegree ? surface.uKnots[surface.uDegree] : 0;
  const uMaxRaw = surface.uKnots && surface.uKnots.length > surface.uDegree ? surface.uKnots[surface.uKnots.length - 1 - surface.uDegree] : 1;
  const uMax = uMaxRaw > uMin ? uMaxRaw : uMin + 1;

  const vMin = surface.vKnots && surface.vKnots.length > surface.vDegree ? surface.vKnots[surface.vDegree] : 0;
  const vMaxRaw = surface.vKnots && surface.vKnots.length > surface.vDegree ? surface.vKnots[surface.vKnots.length - 1 - surface.vDegree] : 1;
  const vMax = vMaxRaw > vMin ? vMaxRaw : vMin + 1;

  const vertices: [number, number, number][] = [];
  const normals: [number, number, number][] = [];
  const faces: [number, number, number][] = [];

  // Sample grid of (u, v) points
  const gridIndex: number[][] = [];

  for (let ui = 0; ui <= uSamples; ui++) {
    gridIndex[ui] = [];
    const tU = ui / uSamples;
    const u = uMin + tU * (uMax - uMin);

    for (let vi = 0; vi <= vSamples; vi++) {
      const tV = vi / vSamples;
      const v = vMin + tV * (vMax - vMin);

      const ev = evaluateBSplineSurface(surface, u, v);
      const vIdx = vertices.length;
      vertices.push([ev.point.x, ev.point.y, ev.point.z]);
      normals.push([ev.normal.x, ev.normal.y, ev.normal.z]);
      gridIndex[ui][vi] = vIdx;
    }
  }

  // Generate 2 triangles per quad cell
  for (let ui = 0; ui < uSamples; ui++) {
    for (let vi = 0; vi < vSamples; vi++) {
      const i00 = gridIndex[ui][vi];
      const i10 = gridIndex[ui + 1][vi];
      const i11 = gridIndex[ui + 1][vi + 1];
      const i01 = gridIndex[ui][vi + 1];

      // Triangle 1: (0,0) -> (1,0) -> (1,1)
      faces.push([i00, i10, i11]);
      // Triangle 2: (0,0) -> (1,1) -> (0,1)
      faces.push([i00, i11, i01]);
    }
  }

  return { name: meshName, vertices, normals, faces };
}

// ============================================================================
// 4.1 Gaussian & Mean Curvature Evaluation & Adaptive Subdivision
// ============================================================================

export interface SurfaceCurvatureResult {
  point: Point3D;
  normal: Point3D;
  gaussianCurvature: number; // K = (LN - M^2) / (EG - F^2)
  meanCurvature: number; // H = (EN - 2FM + GL) / (2(EG - F^2))
  principalCurvatures: [number, number]; // [k1, k2]
  maxPrincipalCurvature: number; // max(|k1|, |k2|)
}

/**
 * Evaluates Gaussian and Mean curvature via first (E, F, G) and second (L, M, N)
 * fundamental forms of the parametric surface at (u, v).
 */
export function evaluateSurfaceCurvature(
  surface: BSplineSurface,
  u: number,
  v: number
): SurfaceCurvatureResult {
  const base = evaluateBSplineSurface(surface, u, v);
  const uMin = surface.uKnots && surface.uKnots.length > surface.uDegree ? surface.uKnots[surface.uDegree] : 0;
  const uMaxRaw = surface.uKnots && surface.uKnots.length > surface.uDegree ? surface.uKnots[surface.uKnots.length - 1 - surface.uDegree] : 1;
  const uMax = uMaxRaw > uMin ? uMaxRaw : uMin + 1;

  const vMin = surface.vKnots && surface.vKnots.length > surface.vDegree ? surface.vKnots[surface.vDegree] : 0;
  const vMaxRaw = surface.vKnots && surface.vKnots.length > surface.vDegree ? surface.vKnots[surface.vKnots.length - 1 - surface.vDegree] : 1;
  const vMax = vMaxRaw > vMin ? vMaxRaw : vMin + 1;

  const hu = Math.max(1e-5, (uMax - uMin) * 1e-4);
  const hv = Math.max(1e-5, (vMax - vMin) * 1e-4);

  const uP = Math.min(uMax, u + hu);
  const uM = Math.max(uMin, u - hu);
  const vP = Math.min(vMax, v + hv);
  const vM = Math.max(vMin, v - hv);

  const du = (uP - uM) || hu;
  const dv = (vP - vM) || hv;

  const p00 = base.point;
  const pU_P = evaluateBSplineSurface(surface, uP, v).point;
  const pU_M = evaluateBSplineSurface(surface, uM, v).point;
  const pV_P = evaluateBSplineSurface(surface, u, vP).point;
  const pV_M = evaluateBSplineSurface(surface, u, vM).point;

  const pU_P_V_P = evaluateBSplineSurface(surface, uP, vP).point;
  const pU_P_V_M = evaluateBSplineSurface(surface, uP, vM).point;
  const pU_M_V_P = evaluateBSplineSurface(surface, uM, vP).point;
  const pU_M_V_M = evaluateBSplineSurface(surface, uM, vM).point;

  const Suu: Point3D = {
    x: (pU_P.x - 2 * p00.x + pU_M.x) / (((du / 2) ** 2) || 1e-8),
    y: (pU_P.y - 2 * p00.y + pU_M.y) / (((du / 2) ** 2) || 1e-8),
    z: (pU_P.z - 2 * p00.z + pU_M.z) / (((du / 2) ** 2) || 1e-8),
  };

  const Svv: Point3D = {
    x: (pV_P.x - 2 * p00.x + pV_M.x) / (((dv / 2) ** 2) || 1e-8),
    y: (pV_P.y - 2 * p00.y + pV_M.y) / (((dv / 2) ** 2) || 1e-8),
    z: (pV_P.z - 2 * p00.z + pV_M.z) / (((dv / 2) ** 2) || 1e-8),
  };

  const Suv: Point3D = {
    x: (pU_P_V_P.x - pU_P_V_M.x - pU_M_V_P.x + pU_M_V_M.x) / ((du * dv) || 1e-8),
    y: (pU_P_V_P.y - pU_P_V_M.y - pU_M_V_P.y + pU_M_V_M.y) / ((du * dv) || 1e-8),
    z: (pU_P_V_P.z - pU_P_V_M.z - pU_M_V_P.z + pU_M_V_M.z) / ((du * dv) || 1e-8),
  };

  const n = base.normal;
  const dot = (a: Point3D, b: Point3D) => a.x * b.x + a.y * b.y + a.z * b.z;

  const E = dot(base.dSud, base.dSud);
  const F = dot(base.dSud, base.dSvd);
  const G = dot(base.dSvd, base.dSvd);

  const L = dot(Suu, n);
  const M = dot(Suv, n);
  const N = dot(Svv, n);

  const detI = E * G - F * F;
  if (detI < 1e-12) {
    return {
      point: base.point,
      normal: base.normal,
      gaussianCurvature: 0,
      meanCurvature: 0,
      principalCurvatures: [0, 0],
      maxPrincipalCurvature: 0,
    };
  }

  const K = (L * N - M * M) / detI;
  const H = (E * N - 2 * F * M + G * L) / (2 * detI);
  const disc = Math.max(0, H * H - K);
  const k1 = H + Math.sqrt(disc);
  const k2 = H - Math.sqrt(disc);
  const maxCurv = Math.max(Math.abs(k1), Math.abs(k2));

  return {
    point: base.point,
    normal: base.normal,
    gaussianCurvature: K,
    meanCurvature: H,
    principalCurvatures: [k1, k2],
    maxPrincipalCurvature: maxCurv,
  };
}

export interface AdaptiveTessellationOptions extends TessellationOptions {
  chordalTolerance?: number; // Model unit max chordal deflection (default 0.005)
  angularTolerance?: number; // Radians normal deviation threshold (default 0.15)
  curvatureThreshold?: number; // Gaussian & principal curvature threshold (default 1e-4)
  minDepth?: number; // Minimum quadtree depth (default 1, i.e. 2x2 base grid)
  maxDepth?: number; // Maximum quadtree depth (default 5, up to 32x32)
}

interface QuadCell {
  id: number;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  depth: number;
  isLeaf: boolean;
  children: [QuadCell, QuadCell, QuadCell, QuadCell] | null; // SW, SE, NW, NE
  parent: QuadCell | null;
}

/**
 * Tessellates a B-spline surface using a Curvature-Adaptive Quadtree algorithm.
 *
 * Mathematical Principles:
 * 1. Evaluates differential geometry curvature: Gaussian curvature K = kappa_1 * kappa_2
 *    and maximum principal curvature kappa_max.
 * 2. Flat / developable zones (|K| < epsilon and kappa_max < epsilon): preserves coarse
 *    2x2 base quads with minimal triangles.
 * 3. High-curvature zones (|K| >= threshold or chordal deflection > tolerance):
 *    recursively subdivides quads into 4 quadrants up to maxDepth.
 * 4. 2:1 Balance Rule (Restricted Quadtree): guarantees adjacent cells never differ
 *    in subdivision depth by more than 1 level.
 * 5. T-Junction & Crack Prevention: eliminates hanging nodes along subdivision boundaries
 *    by inserting Steiner center vertices and performing adaptive fan-out triangulation,
 *    producing a perfectly watertight 2-manifold triangle mesh.
 */
export function tessellateBSplineSurfaceAdaptive(
  surface: BSplineSurface,
  options: AdaptiveTessellationOptions = {},
  meshName = 'adaptive_nurbs_mesh'
): TessellatedMesh {
  const chordalTol = options.chordalTolerance ?? 0.005;
  const angularTol = options.angularTolerance ?? 0.15; // ~8.6 degrees
  const curvThresh = options.curvatureThreshold ?? 1e-4;
  const minDepth = Math.max(1, options.minDepth ?? 1);
  const maxDepth = Math.max(minDepth, Math.min(7, options.maxDepth ?? 5));

  const uMin = surface.uKnots && surface.uKnots.length > surface.uDegree ? surface.uKnots[surface.uDegree] : 0;
  const uMaxRaw = surface.uKnots && surface.uKnots.length > surface.uDegree ? surface.uKnots[surface.uKnots.length - 1 - surface.uDegree] : 1;
  const uMax = uMaxRaw > uMin ? uMaxRaw : uMin + 1;

  const vMin = surface.vKnots && surface.vKnots.length > surface.vDegree ? surface.vKnots[surface.vDegree] : 0;
  const vMaxRaw = surface.vKnots && surface.vKnots.length > surface.vDegree ? surface.vKnots[surface.vKnots.length - 1 - surface.vDegree] : 1;
  const vMax = vMaxRaw > vMin ? vMaxRaw : vMin + 1;

  let nextCellId = 1;

  function createCell(
    u0: number,
    u1: number,
    v0: number,
    v1: number,
    depth: number,
    parent: QuadCell | null
  ): QuadCell {
    return {
      id: nextCellId++,
      u0,
      u1,
      v0,
      v1,
      depth,
      isLeaf: true,
      children: null,
      parent,
    };
  }

  // 1. Initialize Base 2x2 Root Cells
  const roots: QuadCell[] = [];
  const baseU = 2;
  const baseV = 2;
  for (let i = 0; i < baseU; i++) {
    const u0 = uMin + (i / baseU) * (uMax - uMin);
    const u1 = uMin + ((i + 1) / baseU) * (uMax - uMin);
    for (let j = 0; j < baseV; j++) {
      const v0 = vMin + (j / baseV) * (vMax - vMin);
      const v1 = vMin + ((j + 1) / baseV) * (vMax - vMin);
      roots.push(createCell(u0, u1, v0, v1, 1, null));
    }
  }

  function shouldSubdivideCell(cell: QuadCell): boolean {
    if (cell.depth >= maxDepth) return false;
    if (cell.depth < minDepth) return true;

    const uMid = (cell.u0 + cell.u1) / 2;
    const vMid = (cell.v0 + cell.v1) / 2;

    const c00 = evaluateSurfaceCurvature(surface, cell.u0, cell.v0);
    const c10 = evaluateSurfaceCurvature(surface, cell.u1, cell.v0);
    const c01 = evaluateSurfaceCurvature(surface, cell.u0, cell.v1);
    const c11 = evaluateSurfaceCurvature(surface, cell.u1, cell.v1);
    const center = evaluateSurfaceCurvature(surface, uMid, vMid);

    const maxK = Math.max(
      Math.abs(c00.gaussianCurvature),
      Math.abs(c10.gaussianCurvature),
      Math.abs(c01.gaussianCurvature),
      Math.abs(c11.gaussianCurvature),
      Math.abs(center.gaussianCurvature)
    );

    const maxKappa = Math.max(
      c00.maxPrincipalCurvature,
      c10.maxPrincipalCurvature,
      c01.maxPrincipalCurvature,
      c11.maxPrincipalCurvature,
      center.maxPrincipalCurvature
    );

    // Flat plane or zero-curvature developable surface
    if (maxK < curvThresh && maxKappa < curvThresh) {
      return false;
    }

    // Chordal deflection between actual evaluated center and bilinear corner average
    const linCenterX = (c00.point.x + c10.point.x + c01.point.x + c11.point.x) / 4;
    const linCenterY = (c00.point.y + c10.point.y + c01.point.y + c11.point.y) / 4;
    const linCenterZ = (c00.point.z + c10.point.z + c01.point.z + c11.point.z) / 4;
    const chordalDeflection = Math.hypot(
      center.point.x - linCenterX,
      center.point.y - linCenterY,
      center.point.z - linCenterZ
    );

    if (chordalDeflection > chordalTol) {
      return true;
    }

    // Angular deviation of unit normals
    const dot = (a: Point3D, b: Point3D) => a.x * b.x + a.y * b.y + a.z * b.z;
    const minDot = Math.min(
      dot(c00.normal, center.normal),
      dot(c10.normal, center.normal),
      dot(c01.normal, center.normal),
      dot(c11.normal, center.normal)
    );
    const clampedDot = Math.max(-1, Math.min(1, minDot));
    const angularDev = Math.acos(clampedDot);

    if (angularDev > angularTol) {
      return true;
    }

    // For non-flat surfaces, guarantee at least depth 2 for resolution
    if (maxK >= curvThresh && cell.depth < 2) {
      return true;
    }

    return false;
  }

  function splitCell(cell: QuadCell): void {
    const uMid = (cell.u0 + cell.u1) / 2;
    const vMid = (cell.v0 + cell.v1) / 2;
    const childDepth = cell.depth + 1;

    // [SW, SE, NW, NE]
    cell.children = [
      createCell(cell.u0, uMid, cell.v0, vMid, childDepth, cell),
      createCell(uMid, cell.u1, cell.v0, vMid, childDepth, cell),
      createCell(cell.u0, uMid, vMid, cell.v1, childDepth, cell),
      createCell(uMid, cell.u1, vMid, cell.v1, childDepth, cell),
    ];
    cell.isLeaf = false;
  }

  function subdivideRecursive(cell: QuadCell): void {
    if (shouldSubdivideCell(cell)) {
      splitCell(cell);
      if (cell.children) {
        for (const child of cell.children) {
          subdivideRecursive(child);
        }
      }
    }
  }

  for (const root of roots) {
    subdivideRecursive(root);
  }

  // 2. 2:1 Balancing Rule (Restricted Quadtree)
  function getAllLeaves(cellList: QuadCell[]): QuadCell[] {
    const leaves: QuadCell[] = [];
    function collect(c: QuadCell) {
      if (c.isLeaf) {
        leaves.push(c);
      } else if (c.children) {
        for (const child of c.children) collect(child);
      }
    }
    for (const r of cellList) collect(r);
    return leaves;
  }

  const eps = 1e-9;
  function areCellsAdjacent(a: QuadCell, b: QuadCell): boolean {
    const uOverlap = Math.max(0, Math.min(a.u1, b.u1) - Math.max(a.u0, b.u0));
    const vOverlap = Math.max(0, Math.min(a.v1, b.v1) - Math.max(a.v0, b.v0));

    // Vertical edge contact
    const touchesU = Math.abs(a.u1 - b.u0) < eps || Math.abs(a.u0 - b.u1) < eps;
    if (touchesU && vOverlap > eps) return true;

    // Horizontal edge contact
    const touchesV = Math.abs(a.v1 - b.v0) < eps || Math.abs(a.v0 - b.v1) < eps;
    if (touchesV && uOverlap > eps) return true;

    return false;
  }

  let balanced = false;
  let balancePass = 0;
  while (!balanced && balancePass < 10) {
    balanced = true;
    balancePass++;
    const currentLeaves = getAllLeaves(roots);
    for (const leaf of currentLeaves) {
      if (!leaf.isLeaf) continue;
      for (const other of currentLeaves) {
        if (!other.isLeaf || leaf === other) continue;
        if (leaf.depth > other.depth + 1 && areCellsAdjacent(leaf, other)) {
          splitCell(other);
          balanced = false;
        }
      }
    }
  }

  // 3. Collect Final Leaves and Build Corner Vertex Set
  const finalLeaves = getAllLeaves(roots);
  const cornerKey = (u: number, v: number) => `${Math.round(u * 1e7)}:${Math.round(v * 1e7)}`;
  const cornerSet = new Set<string>();

  for (const leaf of finalLeaves) {
    cornerSet.add(cornerKey(leaf.u0, leaf.v0));
    cornerSet.add(cornerKey(leaf.u1, leaf.v0));
    cornerSet.add(cornerKey(leaf.u0, leaf.v1));
    cornerSet.add(cornerKey(leaf.u1, leaf.v1));
  }

  // 4. Mesh Generation with Watertight T-Junction Elimination
  const vertices: [number, number, number][] = [];
  const normals: [number, number, number][] = [];
  const faces: [number, number, number][] = [];
  const vertexCache = new Map<string, number>();

  function getOrAddVertex(u: number, v: number): number {
    const key = cornerKey(u, v);
    const existing = vertexCache.get(key);
    if (existing !== undefined) return existing;

    const ev = evaluateBSplineSurface(surface, u, v);
    const idx = vertices.length;
    vertices.push([ev.point.x, ev.point.y, ev.point.z]);
    normals.push([ev.normal.x, ev.normal.y, ev.normal.z]);
    vertexCache.set(key, idx);
    return idx;
  }

  for (const leaf of finalLeaves) {
    const u0 = leaf.u0;
    const u1 = leaf.u1;
    const v0 = leaf.v0;
    const v1 = leaf.v1;
    const uMid = (u0 + u1) / 2;
    const vMid = (v0 + v1) / 2;

    const hasSouthMid = cornerSet.has(cornerKey(uMid, v0));
    const hasEastMid = cornerSet.has(cornerKey(u1, vMid));
    const hasNorthMid = cornerSet.has(cornerKey(uMid, v1));
    const hasWestMid = cornerSet.has(cornerKey(u0, vMid));

    if (!hasSouthMid && !hasEastMid && !hasNorthMid && !hasWestMid) {
      // Standard quad with 0 hanging nodes -> 2 triangles
      const i00 = getOrAddVertex(u0, v0);
      const i10 = getOrAddVertex(u1, v0);
      const i11 = getOrAddVertex(u1, v1);
      const i01 = getOrAddVertex(u0, v1);

      faces.push([i00, i10, i11]);
      faces.push([i00, i11, i01]);
    } else {
      // Quad with hanging midpoints along boundary: insert center Steiner point and fan out
      const centerIdx = getOrAddVertex(uMid, vMid);

      // Boundary polygon vertices in counter-clockwise order
      const boundaryIndices: number[] = [];
      boundaryIndices.push(getOrAddVertex(u0, v0));
      if (hasSouthMid) boundaryIndices.push(getOrAddVertex(uMid, v0));

      boundaryIndices.push(getOrAddVertex(u1, v0));
      if (hasEastMid) boundaryIndices.push(getOrAddVertex(u1, vMid));

      boundaryIndices.push(getOrAddVertex(u1, v1));
      if (hasNorthMid) boundaryIndices.push(getOrAddVertex(uMid, v1));

      boundaryIndices.push(getOrAddVertex(u0, v1));
      if (hasWestMid) boundaryIndices.push(getOrAddVertex(u0, vMid));

      const count = boundaryIndices.length;
      for (let k = 0; k < count; k++) {
        const pCurrent = boundaryIndices[k];
        const pNext = boundaryIndices[(k + 1) % count];
        faces.push([centerIdx, pCurrent, pNext]);
      }
    }
  }

  return { name: meshName, vertices, normals, faces };
}

// ============================================================================
// 4.2 2D Parameter-Plane Constrained Delaunay Triangulation (CDT) for Trimmed B-Rep Faces
// ============================================================================

export interface Parametric2DPoint {
  u: number;
  v: number;
}

export interface LoopHierarchyNode {
  loop: Parametric2DPoint[];
  signedArea: number;
  isHole: boolean;
  depth: number;
  parent?: LoopHierarchyNode;
  children: LoopHierarchyNode[];
}

export interface TrimmedParametricFace {
  surface: BSplineSurface;
  outerLoop?: Parametric2DPoint[];
  innerHoles?: Parametric2DPoint[][];
  islands?: Parametric2DPoint[][];
  loops?: Parametric2DPoint[][];
}

/**
 * Calculates 2D signed area of a polygon loop in parameter space.
 * Positive indicates counter-clockwise (CCW), negative indicates clockwise (CW).
 */
export function calculateParametricSignedArea(loop: Parametric2DPoint[]): number {
  let area = 0;
  for (let i = 0; i < loop.length; i++) {
    const j = (i + 1) % loop.length;
    area += loop[i].u * loop[j].v - loop[j].u * loop[i].v;
  }
  return area / 2;
}

/**
 * Tests whether a 2D parametric point lies inside a parametric polygon loop
 * using exact Shewchuk orientation predicates and Dan Sunday winding number.
 */
export function isPointInParametricPolygon(pt: Parametric2DPoint, loop: Parametric2DPoint[]): boolean {
  if (!loop || loop.length < 3) return false;
  return windingNumberPointInPolygon(pt, loop) !== 0;
}

/**
 * Obtains an interior point strictly inside a 2D parametric polygon loop.
 */
export function getInteriorPointOfLoop(loop: Parametric2DPoint[]): Parametric2DPoint {
  let cu = 0;
  let cv = 0;
  for (const p of loop) {
    cu += p.u;
    cv += p.v;
  }
  const centroid = { u: cu / loop.length, v: cv / loop.length };
  if (isPointInParametricPolygon(centroid, loop)) {
    return centroid;
  }

  // Ear midpoint fallback for non-convex polygons
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const prev = loop[(i + n - 1) % n];
    const cur = loop[i];
    const next = loop[(i + 1) % n];
    const earPt = {
      u: (prev.u + cur.u * 2 + next.u) / 4,
      v: (prev.v + cur.v * 2 + next.v) / 4,
    };
    if (isPointInParametricPolygon(earPt, loop)) {
      return earPt;
    }
  }
  return centroid;
}

/**
 * Constructs a robust loop hierarchy containment forest for trimmed B-Rep parametric faces.
 * Classifies loops by containment depth:
 * Even depth (0, 2, ...) = positive solid boundaries (CCW)
 * Odd depth (1, 3, ...) = negative hole cutouts (CW)
 */
export function buildLoopHierarchy(loops: Parametric2DPoint[][]): LoopHierarchyNode[] {
  const validLoops: Array<{ loop: Parametric2DPoint[]; area: number }> = [];
  for (const rawLoop of loops) {
    if (!rawLoop || rawLoop.length < 3) continue;
    const loop = rawLoop.map((p) => ({ u: p.u, v: p.v }));
    const area = calculateParametricSignedArea(loop);
    if (Math.abs(area) > 1e-9) {
      validLoops.push({ loop, area });
    }
  }

  if (validLoops.length === 0) return [];

  // Sort descending by absolute enclosed area so that outermost bounding loops come first
  validLoops.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));

  const nodes: LoopHierarchyNode[] = validLoops.map((vl) => ({
    loop: vl.loop,
    signedArea: vl.area,
    isHole: false,
    depth: 0,
    children: [],
  }));

  // Find direct enclosing parent for each loop (the smallest-area loop that contains it)
  for (let i = 0; i < nodes.length; i++) {
    const child = nodes[i];
    let parentNode: LoopHierarchyNode | undefined;
    const testPt = getInteriorPointOfLoop(child.loop);

    for (let j = i - 1; j >= 0; j--) {
      const candidate = nodes[j];
      if (isPointInParametricPolygon(testPt, candidate.loop)) {
        if (!parentNode || Math.abs(candidate.signedArea) < Math.abs(parentNode.signedArea)) {
          parentNode = candidate;
        }
      }
    }

    if (parentNode) {
      child.parent = parentNode;
      parentNode.children.push(child);
    }
  }

  // Assign depth and topological orientation:
  // Even depth (0, 2, ...) -> solid boundary (CCW, positive area)
  // Odd depth (1, 3, ...) -> cutout hole (CW, negative area)
  const assignDepthAndOrientation = (node: LoopHierarchyNode, depth: number) => {
    node.depth = depth;
    node.isHole = depth % 2 === 1;

    const currentArea = calculateParametricSignedArea(node.loop);
    if (node.isHole && currentArea > 0) {
      node.loop.reverse();
      node.signedArea = -currentArea;
    } else if (!node.isHole && currentArea < 0) {
      node.loop.reverse();
      node.signedArea = -currentArea;
    }

    for (const child of node.children) {
      assignDepthAndOrientation(child, depth + 1);
    }
  };

  const roots = nodes.filter((n) => !n.parent);
  for (const root of roots) {
    assignDepthAndOrientation(root, 0);
  }

  return roots;
}

/**
 * Tests whether two 2D parametric segments strictly intersect using Shewchuk exact predicates.
 */
export function parametricSegmentsIntersect(
  p1: Parametric2DPoint,
  p2: Parametric2DPoint,
  p3: Parametric2DPoint,
  p4: Parametric2DPoint
): boolean {
  return robustSegmentsIntersect(p1, p2, p3, p4, true);
}

/**
 * Evaluates the 2D Delaunay in-circle condition using Shewchuk exact predicates.
 */
export function inCircle2D(
  a: Parametric2DPoint,
  b: Parametric2DPoint,
  c: Parametric2DPoint,
  d: Parametric2DPoint
): number {
  return incirclePoints(a, b, c, d);
}

/**
 * Lawson edge-flip topology healing for 2D Constrained Delaunay Triangulation.
 * Iteratively flips non-constrained internal edges violating the empty circumcircle property,
 * healing triangle slivers and maximizing the minimum interior angle.
 */
export function lawsonEdgeFlipHealing2D(
  points: Parametric2DPoint[],
  triangles: Array<[number, number, number]>,
  constrainedEdges: Set<string> = new Set(),
  validHoles: Parametric2DPoint[][] = [],
  outerLoop?: Parametric2DPoint[]
): Array<[number, number, number]> {
  const currentTriangles = triangles.map((t) => [...t] as [number, number, number]);
  let flipped = true;
  let iterations = 0;
  const maxIterations = Math.max(50, currentTriangles.length * 3);

  while (flipped && iterations < maxIterations) {
    flipped = false;
    iterations++;

    const edgeMap = new Map<string, Array<{ triIdx: number; edgeIdx: number; oppVertex: number }>>();

    for (let tIdx = 0; tIdx < currentTriangles.length; tIdx++) {
      const tri = currentTriangles[tIdx];
      const p0 = points[tri[0]];
      const p1 = points[tri[1]];
      const p2 = points[tri[2]];
      const signedArea = (p1.u - p0.u) * (p2.v - p0.v) - (p2.u - p0.u) * (p1.v - p0.v);
      if (signedArea < 0) {
        const tmp = tri[1];
        tri[1] = tri[2];
        tri[2] = tmp;
      }

      for (let e = 0; e < 3; e++) {
        const v1 = tri[e];
        const v2 = tri[(e + 1) % 3];
        const opp = tri[(e + 2) % 3];
        const edgeKey = v1 < v2 ? `${v1}-${v2}` : `${v2}-${v1}`;
        let list = edgeMap.get(edgeKey);
        if (!list) {
          list = [];
          edgeMap.set(edgeKey, list);
        }
        list.push({ triIdx: tIdx, edgeIdx: e, oppVertex: opp });
      }
    }

    for (const [edgeKey, adj] of edgeMap.entries()) {
      if (adj.length !== 2) continue;
      if (constrainedEdges.has(edgeKey)) continue;

      const [adj1, adj2] = adj;
      if (adj1.triIdx === adj2.triIdx) continue;

      const [vA, vB] = edgeKey.split('-').map(Number);
      const vC = adj1.oppVertex;
      const vD = adj2.oppVertex;

      const pA = points[vA];
      const pB = points[vB];
      const pC = points[vC];
      const pD = points[vD];

      // Strict convexity check via Shewchuk orient2d
      const oAB_C = orient2dPoints(pA, pB, pC);
      const oAB_D = orient2dPoints(pA, pB, pD);
      if ((oAB_C > 0 && oAB_D > 0) || (oAB_C < 0 && oAB_D < 0) || oAB_C === 0 || oAB_D === 0) continue;

      const oCD_A = orient2dPoints(pC, pD, pA);
      const oCD_B = orient2dPoints(pC, pD, pB);
      if ((oCD_A > 0 && oCD_B > 0) || (oCD_A < 0 && oCD_B < 0) || oCD_A === 0 || oCD_B === 0) continue;

      // Delaunay in-circle condition via Shewchuk incircle
      const orient = oAB_C > 0 ? [pA, pB, pC] : [pB, pA, pC];
      if (incirclePoints(orient[0], orient[1], orient[2], pD) > 0) {
        // Verify diagonal midpoint and triangle centroids remain within valid face domain
        const midCD: Parametric2DPoint = { u: (pC.u + pD.u) / 2, v: (pC.v + pD.v) / 2 };
        const c1: Parametric2DPoint = { u: (pC.u + pD.u + pA.u) / 3, v: (pC.v + pD.v + pA.v) / 3 };
        const c2: Parametric2DPoint = { u: (pC.u + pB.u + pD.u) / 3, v: (pC.v + pB.v + pD.v) / 3 };

        let insideHole = false;
        for (const h of validHoles) {
          if (
            isPointInParametricPolygon(midCD, h) ||
            isPointInParametricPolygon(c1, h) ||
            isPointInParametricPolygon(c2, h)
          ) {
            insideHole = true;
            break;
          }
        }
        if (insideHole) continue;

        if (outerLoop) {
          if (
            !isPointInParametricPolygon(midCD, outerLoop) ||
            !isPointInParametricPolygon(c1, outerLoop) ||
            !isPointInParametricPolygon(c2, outerLoop)
          ) {
            continue;
          }
        }

        // Verify diagonal CD does not intersect any hole or outer boundary constraint segments
        let crossesConstraint = false;
        for (const h of validHoles) {
          for (let i = 0; i < h.length; i++) {
            if (robustSegmentsIntersect(pC, pD, h[i], h[(i + 1) % h.length], true)) {
              crossesConstraint = true;
              break;
            }
          }
          if (crossesConstraint) break;
        }
        if (crossesConstraint) continue;

        if (outerLoop) {
          for (let i = 0; i < outerLoop.length; i++) {
            if (robustSegmentsIntersect(pC, pD, outerLoop[i], outerLoop[(i + 1) % outerLoop.length], true)) {
              crossesConstraint = true;
              break;
            }
          }
          if (crossesConstraint) continue;
        }

        // Execute Lawson flip
        currentTriangles[adj1.triIdx] = [vC, vD, vA];
        currentTriangles[adj2.triIdx] = [vC, vB, vD];
        flipped = true;
        break;
      }
    }
  }

  // Final pass: ensure all triangles maintain counter-clockwise (positive signed area) orientation
  // and eliminate any degenerate zero-area sliver triangles
  const cleanedTriangles: Array<[number, number, number]> = [];
  for (const tri of currentTriangles) {
    const p0 = points[tri[0]];
    const p1 = points[tri[1]];
    const p2 = points[tri[2]];
    const signedArea = (p1.u - p0.u) * (p2.v - p0.v) - (p2.u - p0.u) * (p1.v - p0.v);
    if (Math.abs(signedArea) < 1e-10) {
      continue;
    }
    if (signedArea < 0) {
      cleanedTriangles.push([tri[0], tri[2], tri[1]]);
    } else {
      cleanedTriangles.push(tri);
    }
  }

  return cleanedTriangles;
}

/**
 * Consolidates an outer boundary loop with inner cutout hole loops by creating
 * non-intersecting bridge cut segments based on mutual visibility and Shewchuk exact predicates.
 * Guarantees zero non-manifold self-intersecting boundary edges even for 3+ nested island hierarchies.
 */
export function consolidatePolygonLoopsWithBridges(
  outer: Parametric2DPoint[],
  holes: Parametric2DPoint[][],
  associatedIndices?: { outer: number[]; holes: number[][] }
): {
  consolidated2D: Parametric2DPoint[];
  consolidatedIndices?: number[];
  allSegments: [Parametric2DPoint, Parametric2DPoint][];
} {
  if (!holes || holes.length === 0) {
    const allSegments: [Parametric2DPoint, Parametric2DPoint][] = [];
    for (let i = 0; i < outer.length; i++) {
      allSegments.push([outer[i], outer[(i + 1) % outer.length]]);
    }
    return {
      consolidated2D: [...outer],
      consolidatedIndices: associatedIndices ? [...associatedIndices.outer] : undefined,
      allSegments,
    };
  }

  // Pre-process holes: ensure all holes have clockwise (CW, negative area) orientation
  interface ProcessedHoleData {
    pts2D: Parametric2DPoint[];
    indices?: number[];
  }
  const processedHoles: ProcessedHoleData[] = [];
  for (let hi = 0; hi < holes.length; hi++) {
    const rawH = holes[hi];
    if (!rawH || rawH.length < 3) continue;
    const hArea = calculateParametricSignedArea(rawH);
    const pts = hArea > 0 ? [...rawH].reverse() : [...rawH];
    let inds: number[] | undefined;
    if (associatedIndices && associatedIndices.holes[hi]) {
      const rawInds = associatedIndices.holes[hi];
      inds = hArea > 0 ? [...rawInds].reverse() : [...rawInds];
    }
    processedHoles.push({ pts2D: pts, indices: inds });
  }

  // Sort holes by rightmost u coordinate descending
  processedHoles.sort((a, b) => {
    const maxA = Math.max(...a.pts2D.map((p) => p.u));
    const maxB = Math.max(...b.pts2D.map((p) => p.u));
    return maxB - maxA;
  });

  let consolidated2D = [...outer];
  let consolidatedIndices = associatedIndices ? [...associatedIndices.outer] : undefined;

  const allSegments: [Parametric2DPoint, Parametric2DPoint][] = [];
  for (let i = 0; i < outer.length; i++) {
    allSegments.push([outer[i], outer[(i + 1) % outer.length]]);
  }
  for (const h of processedHoles) {
    for (let i = 0; i < h.pts2D.length; i++) {
      allSegments.push([h.pts2D[i], h.pts2D[(i + 1) % h.pts2D.length]]);
    }
  }

  for (const hole of processedHoles) {
    const h2D = hole.pts2D;
    const hInd = hole.indices;

    let bestDist = Infinity;
    let bestLoopIdx = -1;
    let bestHoleIdx = -1;

    for (let li = 0; li < consolidated2D.length; li++) {
      const pL = consolidated2D[li];
      for (let hi = 0; hi < h2D.length; hi++) {
        const pH = h2D[hi];
        const dist = Math.hypot(pL.u - pH.u, pL.v - pH.v);
        if (dist >= bestDist) continue;

        // Verify bridge interior sample points are strictly inside outer boundary and outside all inner holes
        const s25 = { u: pL.u * 0.75 + pH.u * 0.25, v: pL.v * 0.75 + pH.v * 0.25 };
        const s50 = { u: (pL.u + pH.u) * 0.5, v: (pL.v + pH.v) * 0.5 };
        const s75 = { u: pL.u * 0.25 + pH.u * 0.75, v: pL.v * 0.25 + pH.v * 0.75 };

        if (
          !isPointInParametricPolygon(s25, outer) ||
          !isPointInParametricPolygon(s50, outer) ||
          !isPointInParametricPolygon(s75, outer)
        ) {
          continue;
        }

        let insideAnyHole = false;
        for (const otherH of processedHoles) {
          if (
            isPointInParametricPolygon(s25, otherH.pts2D) ||
            isPointInParametricPolygon(s50, otherH.pts2D) ||
            isPointInParametricPolygon(s75, otherH.pts2D)
          ) {
            insideAnyHole = true;
            break;
          }
        }
        if (insideAnyHole) continue;

        // Exact Shewchuk segment intersection check against all existing perimeter and bridge edges
        let intersects = false;
        for (const [s1, s2] of allSegments) {
          if (robustSegmentsIntersect(pL, pH, s1, s2, true)) {
            intersects = true;
            break;
          }
        }
        if (intersects) continue;

        bestDist = dist;
        bestLoopIdx = li;
        bestHoleIdx = hi;
      }
    }

    if (bestLoopIdx !== -1) {
      const pBridgeL = consolidated2D[bestLoopIdx];
      const pBridgeH = h2D[bestHoleIdx];

      allSegments.push([pBridgeL, pBridgeH]);

      const holeCycle2D: Parametric2DPoint[] = [];
      const holeCycleIndices: number[] = [];
      for (let i = 0; i < h2D.length; i++) {
        const idx = (bestHoleIdx + i) % h2D.length;
        holeCycle2D.push(h2D[idx]);
        if (hInd) holeCycleIndices.push(hInd[idx]);
      }
      holeCycle2D.push({ ...h2D[bestHoleIdx] });
      if (hInd) holeCycleIndices.push(hInd[bestHoleIdx]);

      const bridgeBack2D = { ...pBridgeL };
      consolidated2D = [
        ...consolidated2D.slice(0, bestLoopIdx + 1),
        ...holeCycle2D,
        bridgeBack2D,
        ...consolidated2D.slice(bestLoopIdx + 1),
      ];

      if (consolidatedIndices && hInd) {
        const bridgeBackIdx = consolidatedIndices[bestLoopIdx];
        consolidatedIndices = [
          ...consolidatedIndices.slice(0, bestLoopIdx + 1),
          ...holeCycleIndices,
          bridgeBackIdx,
          ...consolidatedIndices.slice(bestLoopIdx + 1),
        ];
      }
    }
  }

  return { consolidated2D, consolidatedIndices, allSegments };
}

/**
 * Recursively refines high-curvature regions of a trimmed NURBS surface patch
 * using a 2:1 balanced quadtree in parameter space based on normal angular deviation and chordal sagitta.
 */
export function refineCurvatureAdaptiveQuadtree(
  surface: BSplineSurface,
  outerLoop: Parametric2DPoint[],
  holes: Parametric2DPoint[][] = [],
  options: {
    maxDepth?: number;
    angleToleranceDeg?: number;
    chordTolerance?: number;
  } = {}
): Parametric2DPoint[] {
  const isCurved = (surface.uDegree && surface.uDegree > 1) || (surface.vDegree && surface.vDegree > 1);
  if (!isCurved) return [];

  const maxDepth = options.maxDepth ?? 3;
  const angleTol = options.angleToleranceDeg ?? 12.0;
  const chordTol = options.chordTolerance ?? 0.05;

  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;

  for (const p of outerLoop) {
    if (p.u < uMin) uMin = p.u;
    if (p.u > uMax) uMax = p.u;
    if (p.v < vMin) vMin = p.v;
    if (p.v > vMax) vMax = p.v;
  }

  if (!Number.isFinite(uMin) || uMax <= uMin || vMax <= vMin) {
    return [];
  }

  interface QuadNode {
    u0: number;
    u1: number;
    v0: number;
    v1: number;
    depth: number;
    children?: QuadNode[];
  }

  const root: QuadNode = {
    u0: uMin,
    u1: uMax,
    v0: vMin,
    v1: vMax,
    depth: 0,
  };

  const evaluateCellCurvature = (node: QuadNode): boolean => {
    const { u0, u1, v0, v1 } = node;
    const umid = (u0 + u1) / 2;
    const vmid = (v0 + v1) / 2;

    const p00 = evaluateBSplineSurface(surface, u0, v0);
    const p10 = evaluateBSplineSurface(surface, u1, v0);
    const p11 = evaluateBSplineSurface(surface, u1, v1);
    const p01 = evaluateBSplineSurface(surface, u0, v1);
    const pMid = evaluateBSplineSurface(surface, umid, vmid);

    const normals = [p00.normal, p10.normal, p11.normal, p01.normal, pMid.normal];

    // Angular deviation check
    let minDot = 1.0;
    for (let i = 0; i < normals.length; i++) {
      for (let j = i + 1; j < normals.length; j++) {
        const dot =
          normals[i].x * normals[j].x +
          normals[i].y * normals[j].y +
          normals[i].z * normals[j].z;
        if (dot < minDot) minDot = dot;
      }
    }
    const angleDev = Math.acos(Math.max(-1, Math.min(1, minDot))) * (180 / Math.PI);

    // Chordal deviation (sagitta) check
    const avgX = (p00.point.x + p10.point.x + p11.point.x + p01.point.x) / 4;
    const avgY = (p00.point.y + p10.point.y + p11.point.y + p01.point.y) / 4;
    const avgZ = (p00.point.z + p10.point.z + p11.point.z + p01.point.z) / 4;
    const sagitta = Math.hypot(pMid.point.x - avgX, pMid.point.y - avgY, pMid.point.z - avgZ);

    return angleDev > angleTol || sagitta > chordTol;
  };

  const subdivide = (node: QuadNode) => {
    if (node.depth >= maxDepth) return;
    const shouldRefine = evaluateCellCurvature(node);
    if (!shouldRefine && node.depth >= 1) return;

    const umid = (node.u0 + node.u1) / 2;
    const vmid = (node.v0 + node.v1) / 2;
    const nextDepth = node.depth + 1;

    node.children = [
      { u0: node.u0, u1: umid, v0: node.v0, v1: vmid, depth: nextDepth },
      { u0: umid, u1: node.u1, v0: node.v0, v1: vmid, depth: nextDepth },
      { u0: node.u0, u1: umid, v0: vmid, v1: node.v1, depth: nextDepth },
      { u0: umid, u1: node.u1, v0: vmid, v1: node.v1, depth: nextDepth },
    ];

    for (const child of node.children) {
      subdivide(child);
    }
  };

  subdivide(root);

  // Extract Steiner points located inside the valid trimmed face domain
  const steinerPoints: Parametric2DPoint[] = [];
  const pointKeySet = new Set<string>();

  const collectSteinerPoints = (node: QuadNode) => {
    if (node.children) {
      for (const child of node.children) {
        collectSteinerPoints(child);
      }
      return;
    }

    if (node.depth > 0) {
      const umid = (node.u0 + node.u1) / 2;
      const vmid = (node.v0 + node.v1) / 2;
      const pt = { u: umid, v: vmid };

      if (isPointInParametricPolygon(pt, outerLoop)) {
        let insideHole = false;
        for (const h of holes) {
          if (isPointInParametricPolygon(pt, h)) {
            insideHole = true;
            break;
          }
        }
        if (!insideHole) {
          const key = `${pt.u.toFixed(6)},${pt.v.toFixed(6)}`;
          if (!pointKeySet.has(key)) {
            pointKeySet.add(key);
            steinerPoints.push(pt);
          }
        }
      }
    }
  };

  collectSteinerPoints(root);
  return steinerPoints;
}

/**
 * Triangulates a trimmed B-Rep face with boundary loops in the (u, v) parameter plane
 * preserving all inner cutouts (innerHoles) and nested island boundaries via Loop Hierarchy
 * Constrained Delaunay Triangulation (CDT), eliminating degenerate zero-area sliver triangles
 * and projecting onto the 3D NURBS surface with exact analytical normals.
 */
export function tessellateTrimmedFaceCDT(
  face: TrimmedParametricFace,
  meshName = 'trimmed_face'
): TessellatedMesh {
  const { surface } = face;

  // 1. Gather all loops from face (either loops, or outerLoop + innerHoles + islands)
  const allLoops: Parametric2DPoint[][] = [];
  if (face.loops && face.loops.length > 0) {
    allLoops.push(...face.loops);
  } else {
    if (face.outerLoop && face.outerLoop.length >= 3) {
      allLoops.push(face.outerLoop);
    }
    if (face.innerHoles) {
      for (const h of face.innerHoles) {
        if (h && h.length >= 3) allLoops.push(h);
      }
    }
    if (face.islands) {
      for (const isl of face.islands) {
        if (isl && isl.length >= 3) allLoops.push(isl);
      }
    }
  }

  if (allLoops.length === 0) {
    return { name: meshName, vertices: [], normals: [], faces: [] };
  }

  // 2. Build loop containment hierarchy forest
  const hierarchyRoots = buildLoopHierarchy(allLoops);
  if (hierarchyRoots.length === 0) {
    return { name: meshName, vertices: [], normals: [], faces: [] };
  }

  // 3. Extract solid regions (even depth) with their corresponding cutout holes (odd depth)
  interface SolidRegion {
    outer: Parametric2DPoint[];
    holes: Parametric2DPoint[][];
  }
  const regions: SolidRegion[] = [];
  const collectRegions = (node: LoopHierarchyNode) => {
    if (node.depth % 2 === 0) {
      regions.push({
        outer: node.loop,
        holes: node.children.map((c) => c.loop),
      });
    }
    for (const child of node.children) {
      collectRegions(child);
    }
  };
  for (const root of hierarchyRoots) {
    collectRegions(root);
  }

  // 4. Index unique parametric vertices across all regions
  const uniqueParametricPoints: Parametric2DPoint[] = [];
  const vertexIndexMap = new Map<string, number>();

  const getOrAddPointIndex = (pt: Parametric2DPoint): number => {
    const key = `${pt.u.toFixed(7)},${pt.v.toFixed(7)}`;
    const existing = vertexIndexMap.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const newIdx = uniqueParametricPoints.length;
    uniqueParametricPoints.push({ u: pt.u, v: pt.v });
    vertexIndexMap.set(key, newIdx);
    return newIdx;
  };

  const allRegionTriangles: Array<[number, number, number]> = [];

  // 5. Triangulate each solid region preserving its holes
  for (const region of regions) {
    const outer = region.outer;
    const validHoles = region.holes;

    const { consolidated2D } = consolidatePolygonLoopsWithBridges(outer, validHoles);

    // Convert consolidated loop to 3D plane points for earcut planar triangulation
    const planePoints: Point3D[] = consolidated2D.map((p) => ({
      x: p.u,
      y: p.v,
      z: 0,
    }));
    const normal: [number, number, number] = [0, 0, 1];

    const rawTriangles = triangulatePolygonEarcut(planePoints, normal);
    const regionMappedTriangles: Array<[number, number, number]> = [];

    for (const [i0, i1, i2] of rawTriangles) {
      const uIdx0 = getOrAddPointIndex(consolidated2D[i0]);
      const uIdx1 = getOrAddPointIndex(consolidated2D[i1]);
      const uIdx2 = getOrAddPointIndex(consolidated2D[i2]);

      // Skip degenerate triangles with shared indices
      if (uIdx0 === uIdx1 || uIdx1 === uIdx2 || uIdx2 === uIdx0) {
        continue;
      }

      const p0 = uniqueParametricPoints[uIdx0];
      const p1 = uniqueParametricPoints[uIdx1];
      const p2 = uniqueParametricPoints[uIdx2];

      // Compute 2D triangle cross product area
      const crossArea = Math.abs((p1.u - p0.u) * (p2.v - p0.v) - (p2.u - p0.u) * (p1.v - p0.v));
      if (crossArea < 1e-10) {
        continue;
      }

      // Verify centroid is strictly inside outer loop and outside all inner holes
      const centroid: Parametric2DPoint = {
        u: (p0.u + p1.u + p2.u) / 3,
        v: (p0.v + p1.v + p2.v) / 3,
      };

      let insideAnyHole = false;
      for (const h of validHoles) {
        if (isPointInParametricPolygon(centroid, h)) {
          insideAnyHole = true;
          break;
        }
      }

      if (!insideAnyHole && isPointInParametricPolygon(centroid, outer)) {
        regionMappedTriangles.push([uIdx0, uIdx1, uIdx2]);
      }
    }

    // Lawson edge-flip topology healing respecting constrained outer/inner boundary loops
    const constrainedEdges = new Set<string>();
    for (let i = 0; i < outer.length; i++) {
      const i0 = getOrAddPointIndex(outer[i]);
      const i1 = getOrAddPointIndex(outer[(i + 1) % outer.length]);
      constrainedEdges.add(i0 < i1 ? `${i0}-${i1}` : `${i1}-${i0}`);
    }
    for (const h of validHoles) {
      for (let i = 0; i < h.length; i++) {
        const i0 = getOrAddPointIndex(h[i]);
        const i1 = getOrAddPointIndex(h[(i + 1) % h.length]);
        constrainedEdges.add(i0 < i1 ? `${i0}-${i1}` : `${i1}-${i0}`);
      }
    }

    const healedRegionTriangles = lawsonEdgeFlipHealing2D(
      uniqueParametricPoints,
      regionMappedTriangles,
      constrainedEdges,
      validHoles,
      outer
    );

    allRegionTriangles.push(...healedRegionTriangles);
  }

  // 6. Curvature-adaptive mesh refinement via 2:1 balanced quadtree
  const isCurvedSurface = (surface.uDegree && surface.uDegree > 1) || (surface.vDegree && surface.vDegree > 1);
  let finalTriangles: Array<[number, number, number]> = allRegionTriangles;

  if (isCurvedSurface && regions.length > 0) {
    const steinerPoints: Parametric2DPoint[] = [];
    for (const region of regions) {
      const pts = refineCurvatureAdaptiveQuadtree(surface, region.outer, region.holes, {
        maxDepth: 3,
        angleToleranceDeg: 12.0,
        chordTolerance: 0.05,
      });
      steinerPoints.push(...pts);
    }

    if (steinerPoints.length > 0) {
      for (const sp of steinerPoints) {
        const spIdx = getOrAddPointIndex(sp);
        let pointInserted = false;

        // 1. Check for interior triangle split (Shewchuk orientation strictly non-zero)
        for (let tIdx = 0; tIdx < finalTriangles.length; tIdx++) {
          const [v0, v1, v2] = finalTriangles[tIdx];
          if (spIdx === v0 || spIdx === v1 || spIdx === v2) {
            pointInserted = true;
            break;
          }

          const p0 = uniqueParametricPoints[v0];
          const p1 = uniqueParametricPoints[v1];
          const p2 = uniqueParametricPoints[v2];

          // Check if sp lies inside triangle v0-v1-v2 using Shewchuk orientation
          const o0 = orient2dPoints(p0, p1, sp);
          const o1 = orient2dPoints(p1, p2, sp);
          const o2 = orient2dPoints(p2, p0, sp);

          if ((o0 > 0 && o1 > 0 && o2 > 0) || (o0 < 0 && o1 < 0 && o2 < 0)) {
            // Split triangle into 3 triangles
            finalTriangles.splice(tIdx, 1, [v0, v1, spIdx], [v1, v2, spIdx], [v2, v0, spIdx]);
            pointInserted = true;
            break;
          }
        }

        // 2. If not strictly interior, check if sp lies on an edge of any triangle (edge-split)
        if (!pointInserted) {
          const EPS = 1e-11;
          const isOnSegment = (pa: Parametric2DPoint, pb: Parametric2DPoint, p: Parametric2DPoint) => {
            const minU = Math.min(pa.u, pb.u) - 1e-9;
            const maxU = Math.max(pa.u, pb.u) + 1e-9;
            const minV = Math.min(pa.v, pb.v) - 1e-9;
            const maxV = Math.max(pa.v, pb.v) + 1e-9;
            return p.u >= minU && p.u <= maxU && p.v >= minV && p.v <= maxV;
          };

          for (let tIdx = 0; tIdx < finalTriangles.length; tIdx++) {
            const [v0, v1, v2] = finalTriangles[tIdx];
            if (spIdx === v0 || spIdx === v1 || spIdx === v2) continue;

            const p0 = uniqueParametricPoints[v0];
            const p1 = uniqueParametricPoints[v1];
            const p2 = uniqueParametricPoints[v2];

            const o0 = orient2dPoints(p0, p1, sp);
            const o1 = orient2dPoints(p1, p2, sp);
            const o2 = orient2dPoints(p2, p0, sp);

            let edgeV0 = -1;
            let edgeV1 = -1;
            let oppV = -1;

            if (Math.abs(o0) <= EPS && isOnSegment(p0, p1, sp)) {
              edgeV0 = v0; edgeV1 = v1; oppV = v2;
            } else if (Math.abs(o1) <= EPS && isOnSegment(p1, p2, sp)) {
              edgeV0 = v1; edgeV1 = v2; oppV = v0;
            } else if (Math.abs(o2) <= EPS && isOnSegment(p2, p0, sp)) {
              edgeV0 = v2; edgeV1 = v0; oppV = v1;
            }

            if (edgeV0 !== -1 && edgeV1 !== -1) {
              const newTris: Array<[number, number, number]> = [
                [edgeV0, spIdx, oppV],
                [spIdx, edgeV1, oppV],
              ];

              // Find neighboring triangle sharing edge (edgeV0, edgeV1)
              let neighborIdx = -1;
              let neighborOppV = -1;
              for (let nIdx = 0; nIdx < finalTriangles.length; nIdx++) {
                if (nIdx === tIdx) continue;
                const [nv0, nv1, nv2] = finalTriangles[nIdx];
                if ((nv0 === edgeV0 && nv1 === edgeV1) || (nv0 === edgeV1 && nv1 === edgeV0)) {
                  neighborIdx = nIdx; neighborOppV = nv2; break;
                }
                if ((nv1 === edgeV0 && nv2 === edgeV1) || (nv1 === edgeV1 && nv2 === edgeV0)) {
                  neighborIdx = nIdx; neighborOppV = nv0; break;
                }
                if ((nv2 === edgeV0 && nv0 === edgeV1) || (nv2 === edgeV1 && nv0 === edgeV0)) {
                  neighborIdx = nIdx; neighborOppV = nv1; break;
                }
              }

              if (neighborIdx !== -1) {
                const [nv0, nv1, nv2] = finalTriangles[neighborIdx];
                const nEdgeForward = (nv0 === edgeV0 && nv1 === edgeV1) ||
                                     (nv1 === edgeV0 && nv2 === edgeV1) ||
                                     (nv2 === edgeV0 && nv0 === edgeV1);
                const nV0 = nEdgeForward ? edgeV0 : edgeV1;
                const nV1 = nEdgeForward ? edgeV1 : edgeV0;
                const neighborSplit: Array<[number, number, number]> = [
                  [nV0, spIdx, neighborOppV],
                  [spIdx, nV1, neighborOppV],
                ];

                const firstIdx = Math.max(tIdx, neighborIdx);
                const secondIdx = Math.min(tIdx, neighborIdx);
                finalTriangles.splice(firstIdx, 1);
                finalTriangles.splice(secondIdx, 1, ...newTris, ...neighborSplit);
              } else {
                finalTriangles.splice(tIdx, 1, ...newTris);
              }
              pointInserted = true;
              break;
            }
          }
        }
      }

      // Re-run Lawson flip healing on refined triangles
      finalTriangles = lawsonEdgeFlipHealing2D(
        uniqueParametricPoints,
        finalTriangles
      );
    }
  }

  // 7. Evaluate 3D coordinates and analytical surface normals from B-Spline surface
  const rawVertices: [number, number, number][] = [];
  const rawNormals: [number, number, number][] = [];

  for (const p of uniqueParametricPoints) {
    const evalPt = evaluateBSplineSurface(surface, p.u, p.v);
    rawVertices.push([evalPt.point.x, evalPt.point.y, evalPt.point.z]);
    rawNormals.push([evalPt.normal.x, evalPt.normal.y, evalPt.normal.z]);
  }

  // 8. Weld duplicate seam vertices along bridge cuts
  const welded = weldCoincidentVertices(rawVertices, finalTriangles, { epsilon: 1e-6 });

  return {
    name: meshName,
    vertices: welded.vertices,
    normals: welded.normals,
    faces: welded.faces,
  };
}

// ============================================================================
// 4.3 Half-Edge Manifold Data Structure & Watertight Verification
// ============================================================================

export interface HalfEdge {
  index: number;
  origin: number; // vertex index
  twin: number;   // -1 if boundary
  next: number;   // index of next half-edge in face cycle
  prev: number;   // index of prev half-edge in face cycle
  face: number;   // index of face
  edge: number;   // undirected edge index
}

export interface MeshTopologyReport {
  isManifold: boolean;
  isWatertight: boolean;
  eulerCharacteristic: number; // chi = V - E + F
  boundaryEdges: number;
  nonManifoldEdges: number;
  hasDegenerateFace?: boolean;
  hasNonManifoldVertex?: boolean;
  verticesCount: number;
  edgesCount: number;
  facesCount: number;
  genus: number;
  componentsCount: number;
}

export class HalfEdgeMesh {
  public vertices: [number, number, number][];
  public faces: [number, number, number][];
  public halfEdges: HalfEdge[] = [];
  public edgeCount: number = 0;

  constructor(vertices: [number, number, number][], faces: [number, number, number][]) {
    this.vertices = vertices;
    this.faces = faces;
    this.buildTopology();
  }

  private buildTopology(): void {
    const directedEdgeMap = new Map<string, number>();
    const undirectedEdgeMap = new Map<string, number>();
    let nextEdgeIndex = 0;

    for (let fIdx = 0; fIdx < this.faces.length; fIdx++) {
      const f = this.faces[fIdx];
      const baseHeIdx = this.halfEdges.length;

      for (let i = 0; i < 3; i++) {
        const vFrom = f[i];
        const vTo = f[(i + 1) % 3];
        const heIdx = baseHeIdx + i;
        const nextIdx = baseHeIdx + ((i + 1) % 3);
        const prevIdx = baseHeIdx + ((i + 2) % 3);

        const uKey = vFrom < vTo ? `${vFrom}-${vTo}` : `${vTo}-${vFrom}`;
        let edgeId = undirectedEdgeMap.get(uKey);
        if (edgeId === undefined) {
          edgeId = nextEdgeIndex++;
          undirectedEdgeMap.set(uKey, edgeId);
        }

        const he: HalfEdge = {
          index: heIdx,
          origin: vFrom,
          twin: -1,
          next: nextIdx,
          prev: prevIdx,
          face: fIdx,
          edge: edgeId,
        };

        this.halfEdges.push(he);
        directedEdgeMap.set(`${vFrom}->${vTo}`, heIdx);
      }
    }

    this.edgeCount = nextEdgeIndex;

    // Connect twins
    for (const he of this.halfEdges) {
      if (he.twin !== -1) continue;
      const vFrom = he.origin;
      const vTo = this.halfEdges[he.next].origin;
      const twinKey = `${vTo}->${vFrom}`;
      const twinIdx = directedEdgeMap.get(twinKey);
      if (twinIdx !== undefined && twinIdx !== he.index) {
        he.twin = twinIdx;
        this.halfEdges[twinIdx].twin = he.index;
      }
    }
  }

  public verifyTopology(): MeshTopologyReport {
    return verifyWatertightManifoldMesh(this.vertices, this.faces);
  }
}

/**
 * Computes the Euler-Poincaré characteristic and validates watertight 2-manifold topology.
 * For a closed watertight manifold homeomorphic to a sphere (genus 0):
 * Euler characteristic chi = V - E + F = 2, and boundaryEdges = 0.
 */
export function verifyWatertightManifoldMesh(
  vertices: [number, number, number][],
  faces: [number, number, number][]
): MeshTopologyReport {
  const V = vertices.length;
  const F = faces.length;
  if (V === 0 || F === 0) {
    return {
      isManifold: false,
      isWatertight: false,
      eulerCharacteristic: 0,
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      verticesCount: V,
      edgesCount: 0,
      facesCount: F,
      genus: 0,
      componentsCount: 0,
    };
  }

  const directedEdges = new Map<string, number>();
  const undirectedEdges = new Map<string, number>();
  let hasDegenerateFace = false;

  for (const [v0, v1, v2] of faces) {
    if (v0 < 0 || v0 >= V || v1 < 0 || v1 >= V || v2 < 0 || v2 >= V) {
      return {
        isManifold: false,
        isWatertight: false,
        eulerCharacteristic: 0,
        boundaryEdges: 0,
        nonManifoldEdges: 1,
        verticesCount: V,
        edgesCount: 0,
        facesCount: F,
        genus: 0,
        componentsCount: 0,
      };
    }
    if (v0 === v1 || v1 === v2 || v2 === v0) {
      hasDegenerateFace = true;
    }
    const pairs: [number, number][] = [
      [v0, v1],
      [v1, v2],
      [v2, v0],
    ];
    for (const [a, b] of pairs) {
      const dirKey = `${a}->${b}`;
      const uKey = a < b ? `${a}-${b}` : `${b}-${a}`;

      directedEdges.set(dirKey, (directedEdges.get(dirKey) || 0) + 1);
      undirectedEdges.set(uKey, (undirectedEdges.get(uKey) || 0) + 1);
    }
  }

  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  for (const [uKey, count] of undirectedEdges.entries()) {
    if (count === 1) {
      boundaryEdges++;
    } else if (count > 2) {
      nonManifoldEdges++;
    } else {
      // count === 2: check if directed edges are properly opposite
      const [vA, vB] = uKey.split('-').map(Number);
      const dir1 = directedEdges.get(`${vA}->${vB}`) || 0;
      const dir2 = directedEdges.get(`${vB}->${vA}`) || 0;
      if (dir1 > 1 || dir2 > 1) {
        nonManifoldEdges++;
      }
    }
  }

  // Non-manifold vertex check (1-ring star disk topology)
  let hasNonManifoldVertex = false;
  const vertexFaces = new Map<number, number[]>();
  for (let fIdx = 0; fIdx < faces.length; fIdx++) {
    const [v0, v1, v2] = faces[fIdx];
    for (const v of [v0, v1, v2]) {
      let fl = vertexFaces.get(v);
      if (!fl) {
        fl = [];
        vertexFaces.set(v, fl);
      }
      fl.push(fIdx);
    }
  }

  for (const [v, fIndices] of vertexFaces.entries()) {
    if (fIndices.length <= 1) continue;
    const vEdges = new Map<number, number[]>();
    for (const fIdx of fIndices) {
      const f = faces[fIdx];
      for (const other of f) {
        if (other !== v) {
          let list = vEdges.get(other);
          if (!list) {
            list = [];
            vEdges.set(other, list);
          }
          list.push(fIdx);
        }
      }
    }
    const visitedF = new Set<number>();
    let fanComponents = 0;
    for (const fIdx of fIndices) {
      if (visitedF.has(fIdx)) continue;
      fanComponents++;
      const queue = [fIdx];
      visitedF.add(fIdx);
      while (queue.length > 0) {
        const curr = queue.shift()!;
        const f = faces[curr];
        for (const other of f) {
          if (other !== v) {
            const sharedFaces = vEdges.get(other);
            if (sharedFaces) {
              for (const adjF of sharedFaces) {
                if (!visitedF.has(adjF)) {
                  visitedF.add(adjF);
                  queue.push(adjF);
                }
              }
            }
          }
        }
      }
    }
    if (fanComponents > 1) {
      hasNonManifoldVertex = true;
      break;
    }
  }

  const E = undirectedEdges.size;
  const chi = V - E + F;

  // Connected components via disjoint-set
  const parent = Array.from({ length: V }, (_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (root !== parent[root]) root = parent[root];
    let curr = i;
    while (curr !== root) {
      const nxt = parent[curr];
      parent[curr] = root;
      curr = nxt;
    }
    return root;
  };
  const union = (i: number, j: number) => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  };

  const activeVertices = new Set<number>();
  for (const [v0, v1, v2] of faces) {
    activeVertices.add(v0);
    activeVertices.add(v1);
    activeVertices.add(v2);
    union(v0, v1);
    union(v1, v2);
  }

  const componentRoots = new Set<number>();
  for (const v of activeVertices) {
    componentRoots.add(find(v));
  }
  const componentsCount = componentRoots.size;
  const hasIsolatedVertices = activeVertices.size < V;

  const genus = Math.max(0, Math.round((2 * componentsCount - chi) / 2));
  const isManifold = nonManifoldEdges === 0 && !hasDegenerateFace && !hasNonManifoldVertex;
  // Watertight: 2-manifold without boundary edges, no floating isolated vertices, and non-empty faces
  const isWatertight = isManifold && boundaryEdges === 0 && !hasIsolatedVertices && faces.length > 0;

  return {
    isManifold,
    isWatertight,
    eulerCharacteristic: chi,
    boundaryEdges,
    nonManifoldEdges,
    hasDegenerateFace,
    hasNonManifoldVertex,
    verticesCount: V,
    edgesCount: E,
    facesCount: F,
    genus,
    componentsCount,
  };
}

export interface WeldOptions {
  epsilon?: number; // default 1e-6
}

/**
 * Welds coincident 3D vertices within tolerance epsilon (default 1e-6) using a 3D spatial hash grid.
 * Remaps face indices, removes degenerate collapsed triangles and zero-area slivers,
 * compacts the vertex buffer to eliminate isolated unused vertices, and recalculates normals.
 */
export function weldCoincidentVertices(
  vertices: [number, number, number][],
  faces: [number, number, number][],
  options: WeldOptions = {}
): {
  vertices: [number, number, number][];
  faces: [number, number, number][];
  normals: [number, number, number][];
} {
  const eps = Math.max(1e-12, Math.abs(options.epsilon ?? 1e-6));
  const epsSq = eps * eps;
  const cellSize = Math.max(1e-6, eps);

  const weldedVertices: [number, number, number][] = [];
  const grid = new Map<string, number[]>();
  const vertexRemap = new Int32Array(vertices.length);

  for (let i = 0; i < vertices.length; i++) {
    const v = vertices[i];
    const cx = Math.floor(v[0] / cellSize);
    const cy = Math.floor(v[1] / cellSize);
    const cz = Math.floor(v[2] / cellSize);

    let foundIdx = -1;

    neighborLoop: for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const key = `${cx + dx},${cy + dy},${cz + dz}`;
          const cellList = grid.get(key);
          if (cellList) {
            for (const candIdx of cellList) {
              const cand = weldedVertices[candIdx];
              const distSq =
                (v[0] - cand[0]) ** 2 +
                (v[1] - cand[1]) ** 2 +
                (v[2] - cand[2]) ** 2;
              if (distSq <= epsSq) {
                foundIdx = candIdx;
                break neighborLoop;
              }
            }
          }
        }
      }
    }

    if (foundIdx !== -1) {
      vertexRemap[i] = foundIdx;
    } else {
      const newIdx = weldedVertices.length;
      weldedVertices.push([v[0], v[1], v[2]]);
      const cellKey = `${cx},${cy},${cz}`;
      let cellList = grid.get(cellKey);
      if (!cellList) {
        cellList = [];
        grid.set(cellKey, cellList);
      }
      cellList.push(newIdx);
      vertexRemap[i] = newIdx;
    }
  }

  // Remap faces and filter degenerate / collapsed triangles
  const newFaces: [number, number, number][] = [];
  for (const [i0, i1, i2] of faces) {
    if (
      i0 < 0 || i0 >= vertices.length ||
      i1 < 0 || i1 >= vertices.length ||
      i2 < 0 || i2 >= vertices.length
    ) {
      continue;
    }
    const w0 = vertexRemap[i0];
    const w1 = vertexRemap[i1];
    const w2 = vertexRemap[i2];
    if (w0 === w1 || w1 === w2 || w2 === w0) {
      continue;
    }
    const p0 = weldedVertices[w0];
    const p1 = weldedVertices[w1];
    const p2 = weldedVertices[w2];
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
    const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
    const cx = ay * bz - az * by;
    const cy = az * bx - ax * bz;
    const cz = ax * by - ay * bx;
    const areaSq = cx * cx + cy * cy + cz * cz;
    if (areaSq < 1e-20) {
      continue;
    }
    newFaces.push([w0, w1, w2]);
  }

  // Compact vertices to eliminate unreferenced vertices
  const usedMap = new Int32Array(weldedVertices.length).fill(-1);
  const compactVertices: [number, number, number][] = [];
  for (const [w0, w1, w2] of newFaces) {
    if (usedMap[w0] === -1) {
      usedMap[w0] = compactVertices.length;
      compactVertices.push(weldedVertices[w0]);
    }
    if (usedMap[w1] === -1) {
      usedMap[w1] = compactVertices.length;
      compactVertices.push(weldedVertices[w1]);
    }
    if (usedMap[w2] === -1) {
      usedMap[w2] = compactVertices.length;
      compactVertices.push(weldedVertices[w2]);
    }
  }

  const finalFaces: [number, number, number][] = newFaces.map(([w0, w1, w2]) => [
    usedMap[w0],
    usedMap[w1],
    usedMap[w2],
  ]);

  // Recalculate area-weighted smooth vertex normals
  const normals: [number, number, number][] = [];
  const normalAcc = Array.from({ length: compactVertices.length }, () => [0, 0, 0]);

  for (const [f0, f1, f2] of finalFaces) {
    const p0 = compactVertices[f0];
    const p1 = compactVertices[f1];
    const p2 = compactVertices[f2];
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
    const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
    const fnx = ay * bz - az * by;
    const fny = az * bx - ax * bz;
    const fnz = ax * by - ay * bx;

    normalAcc[f0][0] += fnx; normalAcc[f0][1] += fny; normalAcc[f0][2] += fnz;
    normalAcc[f1][0] += fnx; normalAcc[f1][1] += fny; normalAcc[f1][2] += fnz;
    normalAcc[f2][0] += fnx; normalAcc[f2][1] += fny; normalAcc[f2][2] += fnz;
  }

  for (let i = 0; i < compactVertices.length; i++) {
    const n = normalAcc[i];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len > 1e-10) {
      normals.push([n[0] / len, n[1] / len, n[2] / len]);
    } else {
      normals.push([0, 0, 1]);
    }
  }

  return { vertices: compactVertices, faces: finalFaces, normals };
}

export interface GlueBRepOptions extends WeldOptions {
  enforceOrientedManifold?: boolean; // default true
}

/**
 * Glues B-Rep topological boundary edges by welding coincident vertices and stitching
 * half-edge topology to enforce watertight 2-manifold meshing (Euler characteristic V - E + F = 2
 * and 0 open boundary edges for closed solids).
 * Also coherently orients adjacent faces and guarantees outward-pointing surface normals.
 */
export function glueBRepTopologicalEdges(
  mesh: TessellatedMesh,
  options: GlueBRepOptions = {}
): TessellatedMesh {
  const { epsilon = 1e-6, enforceOrientedManifold = true } = options;

  // Step 1: Weld coincident vertices
  const welded = weldCoincidentVertices(mesh.vertices, mesh.faces, { epsilon });
  let faces = welded.faces;
  const vertices = welded.vertices;

  if (faces.length === 0 || vertices.length === 0) {
    return { name: mesh.name, vertices, normals: [], faces: [] };
  }

  if (enforceOrientedManifold) {
    // Step 2: Coherent face orientation propagation via half-edge graph
    const edgeAdj = new Map<string, Array<{ faceIdx: number; vFrom: number; vTo: number }>>();
    for (let fIdx = 0; fIdx < faces.length; fIdx++) {
      const f = faces[fIdx];
      for (let i = 0; i < 3; i++) {
        const a = f[i];
        const b = f[(i + 1) % 3];
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        let list = edgeAdj.get(key);
        if (!list) {
          list = [];
          edgeAdj.set(key, list);
        }
        list.push({ faceIdx: fIdx, vFrom: a, vTo: b });
      }
    }

    const visited = new Uint8Array(faces.length);
    const orientedFaces = faces.map((f) => [...f] as [number, number, number]);

    for (let startFace = 0; startFace < faces.length; startFace++) {
      if (visited[startFace]) continue;

      const queue: number[] = [startFace];
      visited[startFace] = 1;
      const componentFaces: number[] = [startFace];

      while (queue.length > 0) {
        const currIdx = queue.shift()!;
        const currFace = orientedFaces[currIdx];

        for (let i = 0; i < 3; i++) {
          const a = currFace[i];
          const b = currFace[(i + 1) % 3];
          const key = a < b ? `${a}-${b}` : `${b}-${a}`;
          const adjList = edgeAdj.get(key);
          if (!adjList || adjList.length !== 2) continue; // Only propagate across valid 2-manifold shared edges

          for (const neighbor of adjList) {
            const nIdx = neighbor.faceIdx;
            if (visited[nIdx]) continue;

            const nFace = orientedFaces[nIdx];
            let nEdgeA = -1;
            let nEdgeB = -1;
            for (let ni = 0; ni < 3; ni++) {
              const na = nFace[ni];
              const nb = nFace[(ni + 1) % 3];
              if ((na === a && nb === b) || (na === b && nb === a)) {
                nEdgeA = na;
                nEdgeB = nb;
                break;
              }
            }

            // In a valid 2-manifold orientation, the edge must be traversed in opposite directions:
            // currFace traverses a -> b, so neighbor must traverse b -> a.
            // If neighbor also traverses a -> b, flip neighbor face winding!
            if (nEdgeA === a && nEdgeB === b) {
              const tmp = nFace[1];
              nFace[1] = nFace[2];
              nFace[2] = tmp;
            }

            visited[nIdx] = 1;
            queue.push(nIdx);
            componentFaces.push(nIdx);
          }
        }
      }

      // Step 3: Outward normal / Positive volume check per connected component
      const compEdges = new Map<string, number>();
      for (const fIdx of componentFaces) {
        const f = orientedFaces[fIdx];
        for (let i = 0; i < 3; i++) {
          const a = f[i];
          const b = f[(i + 1) % 3];
          const key = a < b ? `${a}-${b}` : `${b}-${a}`;
          compEdges.set(key, (compEdges.get(key) || 0) + 1);
        }
      }

      let compBoundaryEdges = 0;
      for (const [, count] of compEdges.entries()) {
        if (count === 1) compBoundaryEdges++;
      }

      // If this connected component has 0 boundary edges, it is a closed solid shell!
      if (compBoundaryEdges === 0) {
        let compSignedVolume = 0;
        for (const fIdx of componentFaces) {
          const [v0, v1, v2] = orientedFaces[fIdx];
          const p0 = vertices[v0];
          const p1 = vertices[v1];
          const p2 = vertices[v2];
          const crossX = p1[1] * p2[2] - p1[2] * p2[1];
          const crossY = p1[2] * p2[0] - p1[0] * p2[2];
          const crossZ = p1[0] * p2[1] - p1[1] * p2[0];
          compSignedVolume += (p0[0] * crossX + p0[1] * crossY + p0[2] * crossZ) / 6;
        }

        // If inward-pointing, flip only the faces belonging to this closed component
        if (compSignedVolume < 0) {
          for (const fIdx of componentFaces) {
            const f = orientedFaces[fIdx];
            const tmp = f[1];
            f[1] = f[2];
            f[2] = tmp;
          }
        }
      }
    }

    faces = orientedFaces;
  }

  // Recalculate vertex normals
  const normals: [number, number, number][] = [];
  const normalAcc = Array.from({ length: vertices.length }, () => [0, 0, 0]);

  for (const [f0, f1, f2] of faces) {
    const p0 = vertices[f0];
    const p1 = vertices[f1];
    const p2 = vertices[f2];
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
    const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
    const fnx = ay * bz - az * by;
    const fny = az * bx - ax * bz;
    const fnz = ax * by - ay * bx;

    normalAcc[f0][0] += fnx; normalAcc[f0][1] += fny; normalAcc[f0][2] += fnz;
    normalAcc[f1][0] += fnx; normalAcc[f1][1] += fny; normalAcc[f1][2] += fnz;
    normalAcc[f2][0] += fnx; normalAcc[f2][1] += fny; normalAcc[f2][2] += fnz;
  }

  for (let i = 0; i < vertices.length; i++) {
    const n = normalAcc[i];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len > 1e-10) {
      normals.push([n[0] / len, n[1] / len, n[2] / len]);
    } else {
      normals.push([0, 0, 1]);
    }
  }

  return {
    name: mesh.name,
    vertices,
    normals,
    faces,
  };
}

// ============================================================================
// 5. STEP (ISO 10303-21) Parser
// ============================================================================

export interface StepSubEntity {
  type: string;
  args: any[];
}

export interface StepEntity {
  id: number;
  type: string;
  args: any[];
  subEntities?: StepSubEntity[];
}

/**
 * Tokenizes and parses STEP ISO 10303-21 DATA section entities into structured objects,
 * including composite/complex entities (e.g. #10 = ( BOUNDED_SURFACE() B_SPLINE_SURFACE(...) ... )).
 */
export function parseStepEntities(content: string): Map<number, StepEntity> {
  const entityMap = new Map<number, StepEntity>();

  // Strip ISO 10303-21 comments /* ... */
  const cleanedContent = content.replace(/\/\*[\s\S]*?\*\//g, '');

  // Extract DATA section
  const dataMatch = cleanedContent.match(/DATA\s*;([\s\S]*?)ENDSEC\s*;/i);
  const dataSection = dataMatch ? dataMatch[1] : cleanedContent;

  // Split on semicolons that terminate statements
  const statements = dataSection.split(/;\s*(?=#|$)/);

  for (const rawStmt of statements) {
    const trimmed = rawStmt.trim();
    if (!trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const idStr = trimmed.substring(1, eqIdx).trim();
    const id = parseInt(idStr, 10);
    if (isNaN(id)) continue;

    const rest = trimmed.substring(eqIdx + 1).trim();

    // Check if it is a complex entity: ( TYPE1(...) TYPE2(...) ... )
    if (rest.startsWith('(') && rest.endsWith(')')) {
      const inner = rest.substring(1, rest.length - 1).trim();
      const subEntities: StepSubEntity[] = [];
      let sIdx = 0;

      while (sIdx < inner.length) {
        while (sIdx < inner.length && /\s/.test(inner[sIdx])) sIdx++;
        if (sIdx >= inner.length) break;

        const startType = sIdx;
        while (sIdx < inner.length && /[A-Za-z0-9_]/.test(inner[sIdx])) sIdx++;
        const subType = inner.substring(startType, sIdx).toUpperCase();

        while (sIdx < inner.length && /\s/.test(inner[sIdx])) sIdx++;
        if (sIdx < inner.length && inner[sIdx] === '(') {
          const parenStart = sIdx;
          let depth = 0;
          let inStr = false;
          while (sIdx < inner.length) {
            const ch = inner[sIdx];
            if (ch === "'" && (sIdx === 0 || inner[sIdx - 1] !== '\\')) {
              inStr = !inStr;
            } else if (!inStr && ch === '(') {
              depth++;
            } else if (!inStr && ch === ')') {
              depth--;
              if (depth === 0) {
                sIdx++;
                break;
              }
            }
            sIdx++;
          }
          const rawArg = inner.substring(parenStart, sIdx);
          try {
            const subArgs = parseStepArgTuple(rawArg);
            subEntities.push({ type: subType, args: subArgs });
          } catch {}
        }
      }

      if (subEntities.length > 0) {
        const type = subEntities.map((s) => s.type).join('/');
        entityMap.set(id, { id, type, args: subEntities[0].args, subEntities });
        continue;
      }
    }

    const parenIdx = rest.indexOf('(');
    if (parenIdx === -1) continue;

    const type = rest.substring(0, parenIdx).trim().toUpperCase();
    const rawArgs = rest.substring(parenIdx).trim();

    try {
      const args = parseStepArgTuple(rawArgs);
      entityMap.set(id, { id, type, args });
    } catch {
      // Malformed entity args skipped
    }
  }

  return entityMap;
}

/**
 * Parses nested STEP arguments like ('name', 3, (#1, #2), ((1.0, 2.0)), .T.)
 */
function parseStepArgTuple(text: string): any[] {
  let s = text.trim();
  if (s.startsWith('(') && s.endsWith(')')) {
    s = s.substring(1, s.length - 1).trim();
  }

  const items: any[] = [];
  let depth = 0;
  let inString = false;
  let curr = '';

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (c === "'" && (i === 0 || s[i - 1] !== '\\')) {
      inString = !inString;
      curr += c;
    } else if (!inString && c === '(') {
      depth++;
      curr += c;
    } else if (!inString && c === ')') {
      depth--;
      curr += c;
    } else if (!inString && c === ',' && depth === 0) {
      items.push(parseStepToken(curr.trim()));
      curr = '';
    } else {
      curr += c;
    }
  }

  if (curr.trim().length > 0) {
    items.push(parseStepToken(curr.trim()));
  }

  return items;
}

function parseStepToken(tok: string): any {
  if (tok.startsWith('(') && tok.endsWith(')')) {
    return parseStepArgTuple(tok);
  }
  if (tok.startsWith("'") && tok.endsWith("'")) {
    return tok.substring(1, tok.length - 1);
  }
  if (tok.startsWith('#')) {
    return parseInt(tok.substring(1), 10);
  }
  if (tok === '.T.') return true;
  if (tok === '.F.') return false;
  if (tok === '$' || tok === '*') return null;
  const num = parseFloat(tok);
  if (!isNaN(num) && !tok.includes(' ')) {
    return num;
  }
  return tok;
}

/**
 * Extracts Cartesian Point from STEP entity
 */
export function extractStepPoint(
  id: number,
  entityMap: Map<number, StepEntity>,
  visited: Set<number> = new Set<number>()
): Point3D | null {
  if (visited.has(id)) return null;
  visited.add(id);

  const ent = entityMap.get(id);
  if (!ent) return null;

  if (ent.type.includes('CARTESIAN_POINT')) {
    let coords: any = Array.isArray(ent.args[1]) ? ent.args[1] : (Array.isArray(ent.args[0]) ? ent.args[0] : null);
    if (!coords && ent.subEntities) {
      const sub = ent.subEntities.find((s) => s.type === 'CARTESIAN_POINT');
      if (sub) {
        coords = Array.isArray(sub.args[1]) ? sub.args[1] : (Array.isArray(sub.args[0]) ? sub.args[0] : null);
      }
    }
    if (Array.isArray(coords) && coords.length >= 3) {
      return {
        x: parseFloat(coords[0]) || 0,
        y: parseFloat(coords[1]) || 0,
        z: parseFloat(coords[2]) || 0,
      };
    }
    if (Array.isArray(coords) && coords.length >= 2) {
      return {
        x: parseFloat(coords[0]) || 0,
        y: parseFloat(coords[1]) || 0,
        z: 0,
      };
    }
  }

  if (ent.type.includes('VERTEX_POINT')) {
    const ptId = ent.args[1] !== undefined ? ent.args[1] : ent.args[0];
    if (typeof ptId === 'number') {
      return extractStepPoint(ptId, entityMap, visited);
    }
  }

  return null;
}

/**
 * Expands knot multiplicities into a non-decreasing knot vector
 */
export function expandKnotsWithMultiplicities(knots: number[], multiplicities: number[]): number[] {
  const fullKnots: number[] = [];
  for (let i = 0; i < knots.length; i++) {
    const count = multiplicities[i] || 1;
    const kVal = knots[i];
    for (let c = 0; c < count; c++) {
      fullKnots.push(kVal);
    }
  }
  return fullKnots;
}

/**
 * Extracts B_SPLINE_SURFACE_WITH_KNOTS or RATIONAL_B_SPLINE_SURFACE from STEP entities,
 * supporting both simple and complex composite entity instances.
 */
export function extractStepBSplineSurfaces(entityMap: Map<number, StepEntity>): BSplineSurface[] {
  const surfaces: BSplineSurface[] = [];

  for (const ent of entityMap.values()) {
    if (
      ent.type === 'B_SPLINE_SURFACE_WITH_KNOTS' ||
      ent.type === 'RATIONAL_B_SPLINE_SURFACE' ||
      ent.type.includes('B_SPLINE_SURFACE')
    ) {
      try {
        let uDegree = 3;
        let vDegree = 3;
        let rawCpGrid: any = [];
        let uClosed = false;
        let vClosed = false;
        let uMults: number[] = [];
        let vMults: number[] = [];
        let uKnotsRaw: number[] = [];
        let vKnotsRaw: number[] = [];
        let weights: number[][] | undefined;

        if (ent.subEntities) {
          const bSub =
            ent.subEntities.find((s) => s.type === 'B_SPLINE_SURFACE') ||
            ent.subEntities.find((s) => s.type.includes('B_SPLINE'));
          const kSub = ent.subEntities.find((s) => s.type.includes('KNOTS'));
          const rSub = ent.subEntities.find((s) => s.type.includes('RATIONAL'));

          if (bSub) {
            const shift = typeof bSub.args[0] === 'string' ? 1 : 0;
            uDegree = typeof bSub.args[shift] === 'number' ? bSub.args[shift] : 3;
            vDegree = typeof bSub.args[shift + 1] === 'number' ? bSub.args[shift + 1] : 3;
            rawCpGrid = bSub.args[shift + 2] || [];
            uClosed = bSub.args[shift + 4] === true;
            vClosed = bSub.args[shift + 5] === true;
          }

          if (kSub) {
            uMults = Array.isArray(kSub.args[0]) ? kSub.args[0] : [uDegree + 1, uDegree + 1];
            vMults = Array.isArray(kSub.args[1]) ? kSub.args[1] : [vDegree + 1, vDegree + 1];
            uKnotsRaw = Array.isArray(kSub.args[2]) ? kSub.args[2] : [0, 1];
            vKnotsRaw = Array.isArray(kSub.args[3]) ? kSub.args[3] : [0, 1];
          }

          if (rSub && Array.isArray(rSub.args[0])) {
            weights = rSub.args[0];
          }
        } else {
          const shift = typeof ent.args[0] === 'string' ? 1 : 0;
          uDegree = typeof ent.args[shift] === 'number' ? ent.args[shift] : 3;
          vDegree = typeof ent.args[shift + 1] === 'number' ? ent.args[shift + 1] : 3;
          rawCpGrid = ent.args[shift + 2] || [];
          uClosed = ent.args[shift + 4] === true;
          vClosed = ent.args[shift + 5] === true;

          uMults = Array.isArray(ent.args[shift + 7]) ? ent.args[shift + 7] : [uDegree + 1, uDegree + 1];
          vMults = Array.isArray(ent.args[shift + 8]) ? ent.args[shift + 8] : [vDegree + 1, vDegree + 1];
          uKnotsRaw = Array.isArray(ent.args[shift + 9]) ? ent.args[shift + 9] : [0, 1];
          vKnotsRaw = Array.isArray(ent.args[shift + 10]) ? ent.args[shift + 10] : [0, 1];

          if (ent.type.includes('RATIONAL') && Array.isArray(ent.args[shift + 12])) {
            weights = ent.args[shift + 12];
          }
        }

        if (!Array.isArray(rawCpGrid) || rawCpGrid.length === 0) continue;

        const controlPoints: Point3D[][] = [];
        let validGrid = true;

        for (let u = 0; u < rawCpGrid.length; u++) {
          const row = rawCpGrid[u];
          if (!Array.isArray(row)) {
            validGrid = false;
            break;
          }
          controlPoints[u] = [];
          for (let v = 0; v < row.length; v++) {
            const ptId = row[v];
            const pt = typeof ptId === 'number' ? extractStepPoint(ptId, entityMap) : null;
            if (!pt) {
              validGrid = false;
              break;
            }
            controlPoints[u][v] = pt;
          }
          if (!validGrid) break;
        }

        if (!validGrid || controlPoints.length === 0) continue;

        if (uMults.length === 0) uMults = [uDegree + 1, uDegree + 1];
        if (vMults.length === 0) vMults = [vDegree + 1, vDegree + 1];
        if (uKnotsRaw.length === 0) uKnotsRaw = [0, 1];
        if (vKnotsRaw.length === 0) vKnotsRaw = [0, 1];

        const uKnots = expandKnotsWithMultiplicities(uKnotsRaw, uMults);
        const vKnots = expandKnotsWithMultiplicities(vKnotsRaw, vMults);

        surfaces.push({
          uDegree,
          vDegree,
          controlPoints,
          weights,
          uKnots,
          vKnots,
          uClosed,
          vClosed,
        });
      } catch {
        // Continue parsing next surface
      }
    }
  }

  return surfaces;
}

/**
 * Extracts B_SPLINE_CURVE_WITH_KNOTS from STEP entities
 */
export function extractStepBSplineCurves(entityMap: Map<number, StepEntity>): BSplineCurve[] {
  const curves: BSplineCurve[] = [];

  for (const ent of entityMap.values()) {
    if (ent.type === 'B_SPLINE_CURVE_WITH_KNOTS' || ent.type.includes('B_SPLINE_CURVE')) {
      try {
        let degree = 3;
        let rawCps: any[] = [];
        let mults: number[] = [];
        let knotsRaw: number[] = [];

        if (ent.subEntities) {
          const cSub =
            ent.subEntities.find((s) => s.type.includes('B_SPLINE_CURVE')) ||
            ent.subEntities.find((s) => s.type.includes('B_SPLINE'));
          const kSub = ent.subEntities.find((s) => s.type.includes('KNOTS'));
          if (cSub) {
            const shift = typeof cSub.args[0] === 'string' ? 1 : 0;
            degree = typeof cSub.args[shift] === 'number' ? cSub.args[shift] : 3;
            rawCps = Array.isArray(cSub.args[shift + 1]) ? cSub.args[shift + 1] : [];
          }
          if (kSub) {
            mults = Array.isArray(kSub.args[0]) ? kSub.args[0] : [degree + 1, degree + 1];
            knotsRaw = Array.isArray(kSub.args[1]) ? kSub.args[1] : [0, 1];
          }
        } else {
          const shift = typeof ent.args[0] === 'string' ? 1 : 0;
          degree = typeof ent.args[shift] === 'number' ? ent.args[shift] : 3;
          rawCps = Array.isArray(ent.args[shift + 1]) ? ent.args[shift + 1] : [];
          mults = Array.isArray(ent.args[shift + 5])
            ? ent.args[shift + 5]
            : Array.isArray(ent.args[shift + 6])
            ? ent.args[shift + 6]
            : [degree + 1, degree + 1];
          knotsRaw = Array.isArray(ent.args[shift + 6])
            ? ent.args[shift + 6]
            : Array.isArray(ent.args[shift + 7])
            ? ent.args[shift + 7]
            : [0, 1];
        }

        if (!Array.isArray(rawCps) || rawCps.length === 0) continue;

        const controlPoints: Point3D[] = [];
        for (const ptId of rawCps) {
          const pt = typeof ptId === 'number' ? extractStepPoint(ptId, entityMap) : null;
          if (pt) controlPoints.push(pt);
        }

        if (controlPoints.length === 0) continue;

        const knots = expandKnotsWithMultiplicities(knotsRaw, mults);
        curves.push({ degree, controlPoints, knots });
      } catch {
        // Skip
      }
    }
  }

  return curves;
}

// ============================================================================
// 6. IGES B-Spline Surface (Entity 128) & Curve (Entity 126) Parser
// ============================================================================

/**
 * Parses IGES Entity 128 (Rational B-Spline Surface)
 */
export function parseIgesBSplineSurfaces(content: string): BSplineSurface[] {
  const surfaces: BSplineSurface[] = [];
  const lines = content.split(/\r?\n/);

  // Clean lines: strip IGES sequence number and section code at the end of each line (columns 73-80)
  const cleanedLines: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const stripped = (line.length > 72 ? line.substring(0, 72) : line.replace(/[PGDTS]\s*\d+$/i, '')).trim();
    if (stripped) {
      cleanedLines.push(stripped);
    }
  }

  const pContent = cleanedLines.join('');
  const entities = pContent.split(';');

  for (const entStr of entities) {
    const trimmed = entStr.trim();
    const idx128 = trimmed.indexOf('128,');
    if (idx128 === -1) continue;
    const entPayload = trimmed.substring(idx128);

    const parts = entPayload.split(',').map((p) => p.trim());
    if (parts.length < 15) continue;

    // Entity 128 parameters:
    // 128, K1, K2, M1, M2, PROP1, PROP2, PROP3, PROP4, PROP5,
    // S(0)..S(A), T(0)..T(B), W(0,0)..W(K1,K2), X(0,0)..Z(K1,K2), ...
    const k1 = Number.parseInt(parts[1], 10); // K1 = upper index in first direction = numU - 1
    const k2 = Number.parseInt(parts[2], 10); // K2 = upper index in second direction = numV - 1
    const m1 = Number.parseInt(parts[3], 10); // Degree in first direction
    const m2 = Number.parseInt(parts[4], 10); // Degree in second direction

    if (Number.isNaN(k1) || Number.isNaN(k2) || Number.isNaN(m1) || Number.isNaN(m2)) continue;

    const numU = k1 + 1;
    const numV = k2 + 1;
    const sKnotCount = 1 + k1 + m1 + 1;
    const tKnotCount = 1 + k2 + m2 + 1;

    let idx = 10;
    const uKnots: number[] = [];
    for (let i = 0; i < sKnotCount && idx < parts.length; i++) {
      uKnots.push(Number.parseFloat(parts[idx++]) || 0);
    }

    const vKnots: number[] = [];
    for (let i = 0; i < tKnotCount && idx < parts.length; i++) {
      vKnots.push(Number.parseFloat(parts[idx++]) || 0);
    }

    // Weights W(0..k1, 0..k2)
    const weights: number[][] = [];
    for (let u = 0; u < numU; u++) {
      weights[u] = [];
      for (let v = 0; v < numV; v++) {
        weights[u][v] = idx < parts.length ? Number.parseFloat(parts[idx++]) || 1.0 : 1.0;
      }
    }

    // Control Points (X, Y, Z)
    const controlPoints: Point3D[][] = [];
    for (let u = 0; u < numU; u++) {
      controlPoints[u] = [];
      for (let v = 0; v < numV; v++) {
        const x = idx < parts.length ? Number.parseFloat(parts[idx++]) || 0 : 0;
        const y = idx < parts.length ? Number.parseFloat(parts[idx++]) || 0 : 0;
        const z = idx < parts.length ? Number.parseFloat(parts[idx++]) || 0 : 0;
        controlPoints[u][v] = { x, y, z };
      }
    }

    surfaces.push({
      uDegree: m1,
      vDegree: m2,
      controlPoints,
      weights,
      uKnots,
      vKnots,
    });
  }

  return surfaces;
}

/**
 * Parses IGES Entity 126 (Rational B-Spline Curve)
 */
export function parseIgesBSplineCurves(content: string): BSplineCurve[] {
  const curves: BSplineCurve[] = [];
  const lines = content.split(/\r?\n/);
  const cleanedLines: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const stripped = (line.length > 72 ? line.substring(0, 72) : line.replace(/[PGDTS]\s*\d+$/i, '')).trim();
    if (stripped) cleanedLines.push(stripped);
  }
  const pContent = cleanedLines.join('');
  const entities = pContent.split(';');

  for (const entStr of entities) {
    const trimmed = entStr.trim();
    const idx126 = trimmed.indexOf('126,');
    if (idx126 === -1) continue;
    const entPayload = trimmed.substring(idx126);
    const parts = entPayload.split(',').map((p) => p.trim());
    if (parts.length < 10) continue;

    const k = Number.parseInt(parts[1], 10);
    const m = Number.parseInt(parts[2], 10);
    if (Number.isNaN(k) || Number.isNaN(m)) continue;

    const numCp = k + 1;
    const knotCount = 1 + k + m + 1;

    let idx = 7;
    const knots: number[] = [];
    for (let i = 0; i < knotCount && idx < parts.length; i++) {
      knots.push(Number.parseFloat(parts[idx++]) || 0);
    }

    // Skip weights W(0)..W(K)
    idx += numCp;

    const controlPoints: Point3D[] = [];
    for (let i = 0; i < numCp && idx + 2 < parts.length; i++) {
      const x = Number.parseFloat(parts[idx++]) || 0;
      const y = Number.parseFloat(parts[idx++]) || 0;
      const z = Number.parseFloat(parts[idx++]) || 0;
      controlPoints.push({ x, y, z });
    }

    if (controlPoints.length >= 2 && knots.length >= m + controlPoints.length + 1) {
      curves.push({ degree: m, controlPoints, knots });
    }
  }

  return curves;
}

/**
 * Extracts B-Rep solid boundary topology from IGES 5.3 entity records (Entities 502, 504, 508, 510, 514, 186)
 * and tessellates into watertight 3D triangle mesh.
 */
export function parseIgesBRepMesh(
  content: string,
  modelName = 'iges_brep'
): TessellatedMesh | null {
  if (!content) return null;
  const lines = content.split(/\r?\n/);

  // Group P lines by Directory Entry (DE) pointer
  const pDataByDe = new Map<number, string[]>();
  const pAllData: string[] = [];

  for (const rawLine of lines) {
    if (rawLine.length < 73) continue;
    const section = rawLine[72];
    if (section === 'P') {
      const deStr = rawLine.substring(64, 72).trim();
      const dePtr = Number.parseInt(deStr, 10);
      const text64 = rawLine.substring(0, 64);
      pAllData.push(text64);
      if (!Number.isNaN(dePtr)) {
        let arr = pDataByDe.get(dePtr);
        if (!arr) {
          arr = [];
          pDataByDe.set(dePtr, arr);
        }
        arr.push(text64);
      }
    }
  }

  const fullPJoined = pAllData.join('');
  if (!fullPJoined.includes('502,') && !fullPJoined.includes('504,')) {
    return null;
  }

  // Parse all records from P section (split by ';')
  const rawRecords = fullPJoined.split(';').map((r) => r.trim()).filter(Boolean);

  let vertices: [number, number, number][] = [];
  const edges: [number, number][] = [];
  const loops: [number, number, number][] = [];

  for (const rec of rawRecords) {
    const tokens = rec.split(',').map((t) => t.trim());
    const entityType = Number.parseInt(tokens[0], 10);

    if (entityType === 502) {
      // Entity 502: Vertex List (502, N, X1, Y1, Z1, X2, Y2, Z2, ...)
      const nV = Number.parseInt(tokens[1], 10);
      if (!Number.isNaN(nV) && nV > 0) {
        vertices = [];
        for (let i = 0; i < nV; i++) {
          const x = Number.parseFloat(tokens[2 + 3 * i]) || 0;
          const y = Number.parseFloat(tokens[3 + 3 * i]) || 0;
          const z = Number.parseFloat(tokens[4 + 3 * i]) || 0;
          vertices.push([x, y, z]);
        }
      }
    } else if (entityType === 504) {
      // Entity 504: Edge List (504, N, CRV1, V1_START, V1_END, ...)
      const nE = Number.parseInt(tokens[1], 10);
      if (!Number.isNaN(nE) && nE > 0) {
        for (let i = 0; i < nE; i++) {
          const base = 2 + 3 * i;
          const vStart = Number.parseInt(tokens[base + 1], 10) - 1;
          const vEnd = Number.parseInt(tokens[base + 2], 10) - 1;
          edges.push([vStart, vEnd]);
        }
      }
    } else if (entityType === 508) {
      // Entity 508: Loop (508, TYPE, N, EDGE1_TYPE, EDGE1_INDEX, EDGE1_ORIENTATION, EDGE1_ISO, ...)
      const nEdgesInLoop = Number.parseInt(tokens[2], 10);
      if (nEdgesInLoop >= 3) {
        const loopV: number[] = [];
        for (let k = 0; k < nEdgesInLoop; k++) {
          const base = 3 + 4 * k;
          const eIdx = Number.parseInt(tokens[base + 1], 10) - 1;
          const dir = Number.parseInt(tokens[base + 2], 10);
          if (eIdx >= 0 && eIdx < edges.length) {
            const edge = edges[eIdx];
            const startV = dir === 1 ? edge[0] : edge[1];
            loopV.push(startV);
          }
        }
        if (loopV.length === 3) {
          loops.push([loopV[0], loopV[1], loopV[2]]);
        } else if (loopV.length > 3) {
          for (let k = 1; k < loopV.length - 1; k++) {
            loops.push([loopV[0], loopV[k], loopV[k + 1]]);
          }
        }
      }
    }
  }

  if (vertices.length === 0 || loops.length === 0) {
    return null;
  }

  const normals: [number, number, number][] = [];
  for (const [i0, i1, i2] of loops) {
    const p0 = vertices[i0] || [0, 0, 0];
    const p1 = vertices[i1] || [0, 0, 0];
    const p2 = vertices[i2] || [0, 0, 0];
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-12) {
      nx /= len; ny /= len; nz /= len;
    } else {
      nx = 0; ny = 0; nz = 1;
    }
    normals.push([nx, ny, nz]);
  }

  const rawMesh: TessellatedMesh = {
    name: modelName,
    vertices,
    faces: loops,
    normals,
  };

  return glueBRepTopologicalEdges(rawMesh, { epsilon: 1e-6, enforceOrientedManifold: true });
}

// ============================================================================
// 7. STEP B-Rep Topology Extractor & High-Level 3D Model Tessellator
// ============================================================================

function resolveVertexPoint(
  vertexId: number | null,
  entityMap: Map<number, StepEntity>,
  visited: Set<number> = new Set<number>()
): Point3D | null {
  if (vertexId === null || visited.has(vertexId)) return null;
  visited.add(vertexId);

  const vertEnt = entityMap.get(vertexId);
  if (!vertEnt) return null;

  if (vertEnt.type.includes('CARTESIAN_POINT')) {
    return extractStepPoint(vertexId, entityMap, visited);
  }

  const targetId = vertEnt.args.find((a) => typeof a === 'number');
  if (typeof targetId === 'number') {
    return extractStepPoint(targetId, entityMap, visited);
  }

  return null;
}

function isPointInTriangle(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number
): boolean {
  const v0x = cx - ax;
  const v0y = cy - ay;
  const v1x = bx - ax;
  const v1y = by - ay;
  const v2x = px - ax;
  const v2y = py - ay;

  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot02 = v0x * v2x + v0y * v2y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot12 = v1x * v2x + v1y * v2y;

  const invDenom = 1 / (dot00 * dot11 - dot01 * dot01);
  if (!Number.isFinite(invDenom) || invDenom === 0) return false;
  const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
  const v = (dot00 * dot12 - dot01 * dot02) * invDenom;
  return u > 1e-9 && v > 1e-9 && u + v < 1 - 1e-9;
}

function checkEar(
  prevIdx: number,
  earIdx: number,
  nextIdx: number,
  p2d: Array<{ u: number; v: number; origIdx: number }>,
  indices: number[]
): boolean {
  const a = p2d[prevIdx];
  const b = p2d[earIdx];
  const c = p2d[nextIdx];

  const cross = (b.u - a.u) * (c.v - a.v) - (b.v - a.v) * (c.u - a.u);
  if (cross <= 1e-12) return false;

  for (const otherIdx of indices) {
    if (otherIdx === prevIdx || otherIdx === earIdx || otherIdx === nextIdx) continue;
    const p = p2d[otherIdx];
    // Skip points coincident with candidate ear vertices (e.g. duplicate seam/bridge vertices)
    if (
      (Math.abs(p.u - a.u) < 1e-9 && Math.abs(p.v - a.v) < 1e-9) ||
      (Math.abs(p.u - b.u) < 1e-9 && Math.abs(p.v - b.v) < 1e-9) ||
      (Math.abs(p.u - c.u) < 1e-9 && Math.abs(p.v - c.v) < 1e-9)
    ) {
      continue;
    }
    if (isPointInTriangle(p.u, p.v, a.u, a.v, b.u, b.v, c.u, c.v)) {
      return false;
    }
  }
  return true;
}

export function triangulatePolygonEarcut(
  points: Point3D[],
  normal: [number, number, number]
): Array<[number, number, number]> {
  const n = points.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];

  const nLen = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  const nz = [normal[0] / nLen, normal[1] / nLen, normal[2] / nLen];

  // Construct invariant right-handed orthonormal basis (ux, vx, nz) on the plane
  const ax = Math.abs(nz[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let ux = [
    ax[1] * nz[2] - ax[2] * nz[1],
    ax[2] * nz[0] - ax[0] * nz[2],
    ax[0] * nz[1] - ax[1] * nz[0],
  ];
  const uLen = Math.hypot(ux[0], ux[1], ux[2]) || 1;
  ux = [ux[0] / uLen, ux[1] / uLen, ux[2] / uLen];

  const vx = [
    nz[1] * ux[2] - nz[2] * ux[1],
    nz[2] * ux[0] - nz[0] * ux[2],
    nz[0] * ux[1] - nz[1] * ux[0],
  ];

  const p2d: Array<{ u: number; v: number; origIdx: number }> = points.map((p, idx) => ({
    u: p.x * ux[0] + p.y * ux[1] + p.z * ux[2],
    v: p.x * vx[0] + p.y * vx[1] + p.z * vx[2],
    origIdx: idx,
  }));

  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += p2d[i].u * p2d[j].v - p2d[j].u * p2d[i].v;
  }

  const indices: number[] = [];
  if (area < 0) {
    for (let i = n - 1; i >= 0; i--) indices.push(i);
  } else {
    for (let i = 0; i < n; i++) indices.push(i);
  }

  const triangles: Array<[number, number, number]> = [];
  let iterations = 0;
  const maxIterations = n * n * 2;

  while (indices.length > 3 && iterations < maxIterations) {
    iterations++;
    let earFound = false;

    for (let i = 0; i < indices.length; i++) {
      const prev = indices[(i + indices.length - 1) % indices.length];
      const cur = indices[i];
      const next = indices[(i + 1) % indices.length];

      if (checkEar(prev, cur, next, p2d, indices)) {
        triangles.push([p2d[prev].origIdx, p2d[cur].origIdx, p2d[next].origIdx]);
        indices.splice(i, 1);
        earFound = true;
        break;
      }
    }

    if (!earFound) {
      const prev = indices[0];
      const cur = indices[1];
      const next = indices[2];
      triangles.push([p2d[prev].origIdx, p2d[cur].origIdx, p2d[next].origIdx]);
      indices.splice(1, 1);
    }
  }

  if (indices.length === 3) {
    triangles.push([p2d[indices[0]].origIdx, p2d[indices[1]].origIdx, p2d[indices[2]].origIdx]);
  }

  return triangles;
}

/**
 * Extracts B-Rep solid boundary topology from STEP entity map (ADVANCED_FACE, FACE_OUTER_BOUND,
 * EDGE_LOOP, ORIENTED_EDGE, EDGE_CURVE, VERTEX_POINT, CARTESIAN_POINT) and tessellates
 * into watertight 3D triangle mesh.
 */
export function extractStepBRepMesh(
  entityMap: Map<number, StepEntity>,
  modelName = 'step_brep'
): TessellatedMesh | null {
  if (!entityMap || typeof entityMap.values !== 'function') {
    return null;
  }
  const faces = Array.from(entityMap.values()).filter(
    (e) => e.type === 'ADVANCED_FACE' || e.type === 'FACE_SURFACE' || e.type.endsWith('_FACE')
  );

  if (faces.length === 0) {
    return null;
  }

  const vertices: [number, number, number][] = [];
  const normals: [number, number, number][] = [];
  const facesList: [number, number, number][] = [];

  for (const face of faces) {
    let boundIds: number[] = [];
    if (Array.isArray(face.args[1])) {
      boundIds = face.args[1].filter((x: any): x is number => typeof x === 'number');
    } else if (typeof face.args[1] === 'number') {
      boundIds = [face.args[1]];
    } else if (Array.isArray(face.args[0])) {
      boundIds = face.args[0].filter((x: any): x is number => typeof x === 'number');
    }

    interface ExtractedBound {
      isOuter: boolean;
      points: Point3D[];
    }
    const extractedBounds: ExtractedBound[] = [];

    for (const boundId of boundIds) {
      const boundEnt = entityMap.get(boundId);
      if (!boundEnt) continue;

      let loopId: number | null = null;
      if (typeof boundEnt.args[1] === 'number') {
        loopId = boundEnt.args[1];
      } else if (typeof boundEnt.args[0] === 'number') {
        loopId = boundEnt.args[0];
      }

      if (!loopId) continue;
      const loopEnt = entityMap.get(loopId);
      if (!loopEnt) continue;

      if (loopEnt.type.includes('POLY_LOOP')) {
        let ptIds: number[] = [];
        if (Array.isArray(loopEnt.args[1])) {
          ptIds = loopEnt.args[1].filter((x: any): x is number => typeof x === 'number');
        } else if (Array.isArray(loopEnt.args[0])) {
          ptIds = loopEnt.args[0].filter((x: any): x is number => typeof x === 'number');
        }
        const pts: Point3D[] = [];
        for (const pid of ptIds) {
          const pt = extractStepPoint(pid, entityMap);
          if (pt) pts.push(pt);
        }
        if (pts.length >= 3) {
          extractedBounds.push({
            isOuter: boundEnt.type.includes('FACE_OUTER_BOUND') || boundEnt.type.includes('OUTER'),
            points: pts,
          });
        }
        continue;
      }

      let edgeIds: number[] = [];
      if (Array.isArray(loopEnt.args[1])) {
        edgeIds = loopEnt.args[1].filter((x: any): x is number => typeof x === 'number');
      } else if (Array.isArray(loopEnt.args[0])) {
        edgeIds = loopEnt.args[0].filter((x: any): x is number => typeof x === 'number');
      }

      interface RawEdgePair {
        v1Id: number;
        v2Id: number;
        sameSense: boolean;
      }
      const rawEdgePairs: RawEdgePair[] = [];

      for (const edgeId of edgeIds) {
        const edgeEnt = entityMap.get(edgeId);
        if (!edgeEnt) continue;

        let curveId: number | null = null;
        let sameSense = true;

        if (edgeEnt.type.includes('ORIENTED_EDGE')) {
          const numArgs = edgeEnt.args.filter((a) => typeof a === 'number');
          if (numArgs.length > 0) {
            curveId = numArgs[numArgs.length - 1];
          }
          if (edgeEnt.args.includes(false)) {
            sameSense = false;
          }
        } else if (edgeEnt.type.includes('EDGE_CURVE')) {
          curveId = edgeId;
        }

        if (!curveId) continue;
        const curveEnt = entityMap.get(curveId);
        if (!curveEnt) continue;

        let startVertexId: number | null = null;
        let endVertexId: number | null = null;
        const vertexIds = curveEnt.args.filter((a) => typeof a === 'number');
        if (vertexIds.length >= 2) {
          startVertexId = vertexIds[0];
          endVertexId = vertexIds[1];
        }

        if (curveEnt.args.includes(false)) {
          sameSense = !sameSense;
        }

        if (startVertexId !== null && endVertexId !== null) {
          rawEdgePairs.push({
            v1Id: startVertexId,
            v2Id: endVertexId,
            sameSense,
          });
        }
      }

      if (rawEdgePairs.length < 3) continue;

      // Topologically chain edge pairs into an ordered cyclic sequence of vertices
      const orderedVertexIds: number[] = [];
      const remainingEdges = [...rawEdgePairs];

      let currentV = remainingEdges[0].sameSense ? remainingEdges[0].v1Id : remainingEdges[0].v2Id;
      orderedVertexIds.push(currentV);

      while (remainingEdges.length > 0) {
        let matchIdx = -1;
        let nextV = -1;

        for (let i = 0; i < remainingEdges.length; i++) {
          const e = remainingEdges[i];
          if (e.v1Id === currentV) {
            nextV = e.v2Id;
            matchIdx = i;
            break;
          } else if (e.v2Id === currentV) {
            nextV = e.v1Id;
            matchIdx = i;
            break;
          }
        }

        if (matchIdx === -1) {
          break;
        }

        remainingEdges.splice(matchIdx, 1);
        if (nextV !== orderedVertexIds[0]) {
          orderedVertexIds.push(nextV);
        }
        currentV = nextV;
      }

      const uniquePoints: Point3D[] = [];
      for (const vId of orderedVertexIds) {
        const pt = resolveVertexPoint(vId, entityMap);
        if (pt) uniquePoints.push(pt);
      }

      extractedBounds.push({
        isOuter: boundEnt.type.includes('FACE_OUTER_BOUND'),
        points: uniquePoints,
      });
    }

    if (extractedBounds.length === 0) continue;

    if (extractedBounds.length === 1) {
      // Single boundary loop (no inner holes)
      const uniquePoints = extractedBounds[0].points;
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (let i = 0; i < uniquePoints.length; i++) {
        const cur = uniquePoints[i];
        const next = uniquePoints[(i + 1) % uniquePoints.length];
        nx += (cur.y - next.y) * (cur.z + next.z);
        ny += (cur.z - next.z) * (cur.x + next.x);
        nz += (cur.x - next.x) * (cur.y + next.y);
      }
      const len = Math.hypot(nx, ny, nz) || 1;
      const normal: [number, number, number] = [nx / len, ny / len, nz / len];

      const startIdx = vertices.length;
      for (const p of uniquePoints) {
        vertices.push([p.x, p.y, p.z]);
        normals.push(normal);
      }

      const localTriangles = triangulatePolygonEarcut(uniquePoints, normal);
      for (const [i0, i1, i2] of localTriangles) {
        facesList.push([startIdx + i0, startIdx + i1, startIdx + i2]);
      }
    } else {
      // Multiple boundary loops: outer face boundary with one or more inner cutout holes
      let outerIdx = extractedBounds.findIndex((b) => b.isOuter);
      if (outerIdx === -1) {
        // Fallback: choose loop with largest 3D bounding box / Newell area magnitude
        let maxNewellMag = -1;
        for (let bi = 0; bi < extractedBounds.length; bi++) {
          const pts = extractedBounds[bi].points;
          let nx = 0, ny = 0, nz = 0;
          for (let i = 0; i < pts.length; i++) {
            const cur = pts[i];
            const next = pts[(i + 1) % pts.length];
            nx += (cur.y - next.y) * (cur.z + next.z);
            ny += (cur.z - next.z) * (cur.x + next.x);
            nz += (cur.x - next.x) * (cur.y + next.y);
          }
          const mag = Math.hypot(nx, ny, nz);
          if (mag > maxNewellMag) {
            maxNewellMag = mag;
            outerIdx = bi;
          }
        }
      }

      let outerPoints = [...extractedBounds[outerIdx].points];
      const holeBounds = extractedBounds.filter((_, idx) => idx !== outerIdx);

      // Compute normal from outer loop using Newell's method
      let nx = 0, ny = 0, nz = 0;
      for (let i = 0; i < outerPoints.length; i++) {
        const cur = outerPoints[i];
        const next = outerPoints[(i + 1) % outerPoints.length];
        nx += (cur.y - next.y) * (cur.z + next.z);
        ny += (cur.z - next.z) * (cur.x + next.x);
        nz += (cur.x - next.x) * (cur.y + next.y);
      }
      const len = Math.hypot(nx, ny, nz) || 1;
      const normal: [number, number, number] = [nx / len, ny / len, nz / len];

      // Construct orthonormal 2D basis on plane (uAxis, vAxis)
      let uAxis: [number, number, number];
      if (Math.abs(normal[2]) < 0.9) {
        uAxis = [-normal[1], normal[0], 0];
      } else {
        uAxis = [normal[2], 0, -normal[0]];
      }
      const uLen = Math.hypot(uAxis[0], uAxis[1], uAxis[2]) || 1;
      uAxis = [uAxis[0] / uLen, uAxis[1] / uLen, uAxis[2] / uLen];
      const vAxis: [number, number, number] = [
        normal[1] * uAxis[2] - normal[2] * uAxis[1],
        normal[2] * uAxis[0] - normal[0] * uAxis[2],
        normal[0] * uAxis[1] - normal[1] * uAxis[0],
      ];

      const to2D = (p: Point3D): Parametric2DPoint => ({
        u: p.x * uAxis[0] + p.y * uAxis[1] + p.z * uAxis[2],
        v: p.x * vAxis[0] + p.y * vAxis[1] + p.z * vAxis[2],
      });

      let outer2D = outerPoints.map(to2D);
      const outerArea = calculateParametricSignedArea(outer2D);
      if (outerArea < 0) {
        outer2D.reverse();
        outerPoints.reverse();
      }

      // Add outer vertices to mesh
      const outerIndices: number[] = [];
      for (const p of outerPoints) {
        outerIndices.push(vertices.length);
        vertices.push([p.x, p.y, p.z]);
        normals.push(normal);
      }

      interface ProcessedHole {
        pts: Point3D[];
        pts2D: Parametric2DPoint[];
        indices: number[];
      }
      const processedHoles: ProcessedHole[] = [];

      for (const hb of holeBounds) {
        let hPts = [...hb.points];
        let h2D = hPts.map(to2D);
        const hArea = calculateParametricSignedArea(h2D);
        if (hArea > 0) {
          // Invert to CW for inner cutout hole
          h2D.reverse();
          hPts.reverse();
        }
        const hIndices: number[] = [];
        for (const p of hPts) {
          hIndices.push(vertices.length);
          vertices.push([p.x, p.y, p.z]);
          normals.push(normal);
        }
        processedHoles.push({
          pts: hPts,
          pts2D: h2D,
          indices: hIndices,
        });
      }

      // Sort holes descending by rightmost u coordinate for stable leftward bridging
      processedHoles.sort((a, b) => {
        const maxA = Math.max(...a.pts2D.map((p) => p.u));
        const maxB = Math.max(...b.pts2D.map((p) => p.u));
        return maxB - maxA;
      });

      let consolidated2D = [...outer2D];
      let consolidatedIndices = [...outerIndices];

      const allSegments: [Parametric2DPoint, Parametric2DPoint][] = [];
      for (let i = 0; i < outer2D.length; i++) {
        allSegments.push([outer2D[i], outer2D[(i + 1) % outer2D.length]]);
      }
      for (const h of processedHoles) {
        for (let i = 0; i < h.pts2D.length; i++) {
          allSegments.push([h.pts2D[i], h.pts2D[(i + 1) % h.pts2D.length]]);
        }
      }

      for (const hole of processedHoles) {
        const h2D = hole.pts2D;
        const hInd = hole.indices;

        let bestDist = Infinity;
        let bestLoopIdx = -1;
        let bestHoleIdx = -1;

        for (let li = 0; li < consolidated2D.length; li++) {
          for (let hi = 0; hi < h2D.length; hi++) {
            const pL = consolidated2D[li];
            const pH = h2D[hi];
            const dist = Math.hypot(pL.u - pH.u, pL.v - pH.v);

            const mid = { u: (pL.u + pH.u) / 2, v: (pL.v + pH.v) / 2 };
            let insideAnyHole = false;
            for (const otherH of processedHoles) {
              if (isPointInParametricPolygon(mid, otherH.pts2D)) {
                insideAnyHole = true;
                break;
              }
            }
            if (insideAnyHole || !isPointInParametricPolygon(mid, outer2D)) continue;

            let intersects = false;
            for (const [s1, s2] of allSegments) {
              if (parametricSegmentsIntersect(pL, pH, s1, s2)) {
                intersects = true;
                break;
              }
            }

            if (!intersects && dist < bestDist) {
              bestDist = dist;
              bestLoopIdx = li;
              bestHoleIdx = hi;
            }
          }
        }

        // Fallback if geometric intersection precision prevented bridge
        if (bestLoopIdx === -1) {
          for (let li = 0; li < consolidated2D.length; li++) {
            for (let hi = 0; hi < h2D.length; hi++) {
              const pL = consolidated2D[li];
              const pH = h2D[hi];
              const dist = Math.hypot(pL.u - pH.u, pL.v - pH.v);
              if (dist < bestDist) {
                bestDist = dist;
                bestLoopIdx = li;
                bestHoleIdx = hi;
              }
            }
          }
        }

        if (bestLoopIdx !== -1) {
          const holeCycle2D: Parametric2DPoint[] = [];
          const holeCycleIndices: number[] = [];
          for (let i = 0; i < h2D.length; i++) {
            const idx = (bestHoleIdx + i) % h2D.length;
            holeCycle2D.push(h2D[idx]);
            holeCycleIndices.push(hInd[idx]);
          }
          holeCycle2D.push({ ...h2D[bestHoleIdx] });
          holeCycleIndices.push(hInd[bestHoleIdx]);

          const bridgeBack2D = { ...consolidated2D[bestLoopIdx] };
          const bridgeBackIdx = consolidatedIndices[bestLoopIdx];

          allSegments.push([consolidated2D[bestLoopIdx], h2D[bestHoleIdx]]);

          consolidated2D = [
            ...consolidated2D.slice(0, bestLoopIdx + 1),
            ...holeCycle2D,
            bridgeBack2D,
            ...consolidated2D.slice(bestLoopIdx + 1),
          ];
          consolidatedIndices = [
            ...consolidatedIndices.slice(0, bestLoopIdx + 1),
            ...holeCycleIndices,
            bridgeBackIdx,
            ...consolidatedIndices.slice(bestLoopIdx + 1),
          ];
        }
      }

      const planePoints: Point3D[] = consolidated2D.map((p) => ({
        x: p.u,
        y: p.v,
        z: 0,
      }));
      const localTriangles = triangulatePolygonEarcut(planePoints, [0, 0, 1]);

      for (const [i0, i1, i2] of localTriangles) {
        const v0 = consolidatedIndices[i0];
        const v1 = consolidatedIndices[i1];
        const v2 = consolidatedIndices[i2];
        if (v0 === v1 || v1 === v2 || v2 === v0) continue;

        const p0 = consolidated2D[i0];
        const p1 = consolidated2D[i1];
        const p2 = consolidated2D[i2];
        const centroid: Parametric2DPoint = {
          u: (p0.u + p1.u + p2.u) / 3,
          v: (p0.v + p1.v + p2.v) / 3,
        };

        let inHole = false;
        for (const h of processedHoles) {
          if (isPointInParametricPolygon(centroid, h.pts2D)) {
            inHole = true;
            break;
          }
        }
        if (inHole || !isPointInParametricPolygon(centroid, outer2D)) continue;

        facesList.push([v0, v1, v2]);
      }
    }
  }

  if (facesList.length === 0) {
    return null;
  }

  const rawMesh: TessellatedMesh = {
    name: modelName,
    vertices,
    normals,
    faces: facesList,
  };

  return glueBRepTopologicalEdges(rawMesh, { epsilon: 1e-6, enforceOrientedManifold: true });
}

// ============================================================================
// 4.4 STEP & IGES Units Resolution, Scaling & Crease Angle Normal Splitting
// ============================================================================

export const CAD_UNIT_FACTORS_IN_MM: Record<string, number> = {
  mm: 1.0,
  cm: 10.0,
  m: 1000.0,
  in: 25.4,
  ft: 304.8,
};

export function parseStepUnit(text: string, entityMap?: Map<number, StepEntity>): string | null {
  if (entityMap && typeof entityMap.values === 'function') {
    for (const ent of entityMap.values()) {
      if (ent.type === 'CONVERSION_BASED_UNIT' || ent.type.includes('CONVERSION_BASED_UNIT')) {
        const unitName = String(ent.args[0] || '').replace(/['"]/g, '').trim().toUpperCase();
        if (unitName === 'INCH' || unitName === 'IN') return 'in';
        if (unitName === 'FOOT' || unitName === 'FEET' || unitName === 'FT') return 'ft';
        if (unitName === 'MILLIMETRE' || unitName === 'MM') return 'mm';
        if (unitName === 'CENTIMETRE' || unitName === 'CM') return 'cm';
        if (unitName === 'METRE' || unitName === 'M') return 'm';
      }
      if (ent.type === 'SI_UNIT' || ent.type.includes('SI_UNIT')) {
        const str = JSON.stringify(ent.args).toUpperCase();
        if (str.includes('.MILLI.') && str.includes('.METRE.')) return 'mm';
        if (str.includes('.CENTI.') && str.includes('.METRE.')) return 'cm';
        if (str.includes('.METRE.')) return 'm';
      }
    }
  }

  const convMatch = text.match(/CONVERSION_BASED_UNIT\s*\(\s*['"]([A-Z_]+)['"]/i);
  if (convMatch) {
    const unitName = convMatch[1].toUpperCase();
    if (unitName === 'INCH' || unitName === 'IN') return 'in';
    if (unitName === 'FOOT' || unitName === 'FEET' || unitName === 'FT') return 'ft';
    if (unitName === 'MILLIMETRE' || unitName === 'MM') return 'mm';
    if (unitName === 'CENTIMETRE' || unitName === 'CM') return 'cm';
    if (unitName === 'METRE' || unitName === 'M') return 'm';
  }

  if (/SI_UNIT\s*\([^)]*\.MILLI\.[^)]*\.METRE\.[^)]*\)/i.test(text)) return 'mm';
  if (/SI_UNIT\s*\([^)]*\.CENTI\.[^)]*\.METRE\.[^)]*\)/i.test(text)) return 'cm';
  if (/SI_UNIT\s*\([^)]*\.METRE\.[^)]*\)/i.test(text)) return 'm';
  if (/LENGTH_MEASURE_WITH_UNIT\s*\(\s*LENGTH_MEASURE\s*\(\s*25\.4\s*\)/i.test(text)) return 'in';

  return null;
}

export function parseIgesUnit(text: string): string | null {
  const lines = text.split(/\r?\n/);
  const gLines: string[] = [];
  for (const line of lines) {
    if (line.length >= 73 && line[72].toUpperCase() === 'G') {
      gLines.push(line.substring(0, 72));
    } else if (/[Gg]\s*\d+\s*$/.test(line)) {
      gLines.push(line.replace(/[Gg]\s*\d+\s*$/, ''));
    }
  }

  const gText = gLines.length > 0 ? gLines.join('') : text;
  let delim = ',';
  const term = ';';
  const trimmedG = gText.trim();
  if (trimmedG.startsWith('1H')) {
    delim = trimmedG[2] || ',';
  }

  const endIdx = gText.indexOf(term);
  const payload = endIdx !== -1 ? gText.substring(0, endIdx) : gText;

  const tokens: string[] = [];
  let cur = '';
  let inHollerith = 0;
  for (let i = 0; i < payload.length; i++) {
    const ch = payload[i];
    if (inHollerith > 0) {
      cur += ch;
      inHollerith--;
      continue;
    }
    const hMatch = payload.substring(i).match(/^(\d+)H/);
    if (hMatch) {
      const len = parseInt(hMatch[1], 10);
      const prefixLen = hMatch[0].length;
      cur += payload.substring(i, i + prefixLen);
      i += prefixLen - 1;
      inHollerith = len;
      continue;
    }
    if (ch === delim) {
      tokens.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) tokens.push(cur.trim());

  if (tokens.length >= 14) {
    const flag = parseInt(tokens[13], 10);
    switch (flag) {
      case 1: return 'in';
      case 2: return 'mm';
      case 4: return 'ft';
      case 6: return 'm';
      case 10: return 'cm';
    }
  }
  if (tokens.length >= 15) {
    const name = tokens[14].replace(/^\d+H/i, '').trim().toUpperCase();
    if (name === 'MM' || name === 'MILLIMETER' || name === 'MILLIMETRE') return 'mm';
    if (name === 'INCH' || name === 'IN') return 'in';
    if (name === 'FEET' || name === 'FOOT' || name === 'FT') return 'ft';
    if (name === 'METER' || name === 'METRE' || name === 'M') return 'm';
    if (name === 'CM' || name === 'CENTIMETER' || name === 'CENTIMETRE') return 'cm';
  }

  const flagMatch = text.match(/,\s*([1246]|10)\s*,\s*\d+H(MM|INCH|IN|FEET|FOOT|METRE|METER|CM)/i);
  if (flagMatch) {
    const f = parseInt(flagMatch[1], 10);
    if (f === 1) return 'in';
    if (f === 2) return 'mm';
    if (f === 4) return 'ft';
    if (f === 6) return 'm';
    if (f === 10) return 'cm';
  }

  return null;
}

export function scaleMeshCoordinates(
  mesh: TessellatedMesh,
  sourceUnit: string | null,
  targetUnit?: 'mm' | 'cm' | 'm' | 'in'
): TessellatedMesh {
  if (!sourceUnit || !CAD_UNIT_FACTORS_IN_MM[sourceUnit]) {
    mesh.unit = 'unknown';
    return mesh;
  }

  mesh.unit = sourceUnit;
  if (!targetUnit || targetUnit === sourceUnit || !CAD_UNIT_FACTORS_IN_MM[targetUnit]) {
    return mesh;
  }

  const factorSrc = CAD_UNIT_FACTORS_IN_MM[sourceUnit];
  const factorTgt = CAD_UNIT_FACTORS_IN_MM[targetUnit];
  const scale = factorSrc / factorTgt;

  for (let i = 0; i < mesh.vertices.length; i++) {
    mesh.vertices[i][0] *= scale;
    mesh.vertices[i][1] *= scale;
    mesh.vertices[i][2] *= scale;
  }
  mesh.unit = targetUnit;
  return mesh;
}

function computeFaceNormalsAndAreas(
  vertices: [number, number, number][],
  faces: [number, number, number][]
): { normals: [number, number, number][]; areas: number[] } {
  const F = faces.length;
  const normals: [number, number, number][] = new Array(F);
  const areas: number[] = new Array(F);

  for (let f = 0; f < F; f++) {
    const [i0, i1, i2] = faces[f];
    const p0 = vertices[i0] || [0, 0, 0];
    const p1 = vertices[i1] || [0, 0, 0];
    const p2 = vertices[i2] || [0, 0, 0];
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
    const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
    const cx = ay * bz - az * by;
    const cy = az * bx - ax * bz;
    const cz = ax * by - ay * bx;
    const len = Math.hypot(cx, cy, cz);
    if (len > 1e-12) {
      normals[f] = [cx / len, cy / len, cz / len];
      areas[f] = 0.5 * len;
    } else {
      normals[f] = [0, 0, 1];
      areas[f] = 0;
    }
  }
  return { normals, areas };
}

function buildMeshAdjacencies(
  vertexCount: number,
  faces: [number, number, number][]
): { vertexFaces: number[][]; edgeFaces: Map<string, number[]> } {
  const vertexFaces: number[][] = Array.from({ length: vertexCount }, () => []);
  const edgeFaces = new Map<string, number[]>();

  for (let f = 0; f < faces.length; f++) {
    const [i0, i1, i2] = faces[f];
    if (i0 < vertexCount) vertexFaces[i0].push(f);
    if (i1 < vertexCount) vertexFaces[i1].push(f);
    if (i2 < vertexCount) vertexFaces[i2].push(f);

    const edges = [
      i0 < i1 ? `${i0}_${i1}` : `${i1}_${i0}`,
      i1 < i2 ? `${i1}_${i2}` : `${i2}_${i1}`,
      i2 < i0 ? `${i2}_${i0}` : `${i0}_${i2}`,
    ];
    for (const eKey of edges) {
      let list = edgeFaces.get(eKey);
      if (!list) {
        list = [];
        edgeFaces.set(eKey, list);
      }
      list.push(f);
    }
  }
  return { vertexFaces, edgeFaces };
}

export function splitNormalsByCreaseAngle(
  mesh: TessellatedMesh,
  smoothingAngleDeg = 30
): TessellatedMesh {
  const { vertices, faces, name } = mesh;
  if (faces.length === 0 || vertices.length === 0) {
    return { ...mesh };
  }

  const angleRad = (Math.max(0, Math.min(180, smoothingAngleDeg)) * Math.PI) / 180;
  const cosThreshold = Math.cos(angleRad);

  const { normals: faceNormals, areas: faceAreas } = computeFaceNormalsAndAreas(vertices, faces);
  const V = vertices.length;
  const F = faces.length;
  const { vertexFaces, edgeFaces } = buildMeshAdjacencies(V, faces);

  const outputVertices: [number, number, number][] = [];
  const outputNormals: [number, number, number][] = [];
  const vertexFaceToNewIndex = new Map<string, number>();

  for (let v = 0; v < V; v++) {
    const adjFaces = vertexFaces[v];
    if (adjFaces.length === 0) continue;

    const parent: Record<number, number> = {};
    for (const f of adjFaces) parent[f] = f;
    const findRoot = (i: number): number => {
      let r = i;
      while (parent[r] !== r) r = parent[r];
      let curr = i;
      while (curr !== r) {
        const nxt = parent[curr];
        parent[curr] = r;
        curr = nxt;
      }
      return r;
    };
    const unionGroup = (i: number, j: number) => {
      const ri = findRoot(i);
      const rj = findRoot(j);
      if (ri !== rj) parent[ri] = rj;
    };

    for (let i = 0; i < adjFaces.length; i++) {
      const f1 = adjFaces[i];
      const [v0, v1, v2] = faces[f1];
      const otherVerts = [v0, v1, v2].filter((u) => u !== v);
      for (const w of otherVerts) {
        const eKey = v < w ? `${v}_${w}` : `${w}_${v}`;
        const sharing = edgeFaces.get(eKey);
        if (sharing) {
          for (const f2 of sharing) {
            if (f2 !== f1 && adjFaces.includes(f2)) {
              const dot =
                faceNormals[f1][0] * faceNormals[f2][0] +
                faceNormals[f1][1] * faceNormals[f2][1] +
                faceNormals[f1][2] * faceNormals[f2][2];
              if (dot >= cosThreshold - 1e-9) {
                unionGroup(f1, f2);
              }
            }
          }
        }
      }
    }

    const groups = new Map<number, number[]>();
    for (const f of adjFaces) {
      const root = findRoot(f);
      let g = groups.get(root);
      if (!g) {
        g = [];
        groups.set(root, g);
      }
      g.push(f);
    }

    const origPos = vertices[v];
    for (const group of groups.values()) {
      let nx = 0, ny = 0, nz = 0;
      for (const f of group) {
        const w = faceAreas[f] > 0 ? faceAreas[f] : 1;
        nx += faceNormals[f][0] * w;
        ny += faceNormals[f][1] * w;
        nz += faceNormals[f][2] * w;
      }
      const nLen = Math.hypot(nx, ny, nz);
      const finalNorm: [number, number, number] =
        nLen > 1e-12 ? [nx / nLen, ny / nLen, nz / nLen] : faceNormals[group[0]];

      const newIdx = outputVertices.length;
      outputVertices.push([origPos[0], origPos[1], origPos[2]]);
      outputNormals.push(finalNorm);

      for (const f of group) {
        vertexFaceToNewIndex.set(`${v}_${f}`, newIdx);
      }
    }
  }

  const outputFaces: [number, number, number][] = new Array(F);
  for (let f = 0; f < F; f++) {
    const [i0, i1, i2] = faces[f];
    const n0 = vertexFaceToNewIndex.get(`${i0}_${f}`) ?? i0;
    const n1 = vertexFaceToNewIndex.get(`${i1}_${f}`) ?? i1;
    const n2 = vertexFaceToNewIndex.get(`${i2}_${f}`) ?? i2;
    outputFaces[f] = [n0, n1, n2];
  }

  return {
    name,
    vertices: outputVertices,
    normals: outputNormals,
    faces: outputFaces,
    topologyReport: mesh.topologyReport,
    unit: mesh.unit,
  };
}

/**
 * Tessellates any STEP or IGES CAD model string with B-spline curves/surfaces or B-Rep topology into
 * a unified 3D mesh (TessellatedMesh) ready for STL, OBJ, or DXF export.
 */
export function tessellateCadText(
  text: string,
  format: 'step' | 'stp' | 'iges' | 'igs' | string,
  modelName = 'cad_model',
  options: ConversionOptions = {}
): TessellatedMesh {
  const isIges = format === 'iges' || format === 'igs' || text.includes('S      1');
  let mesh: TessellatedMesh | null = null;
  let isSolid = false;
  let sourceUnit: string | null = null;

  if (isIges) {
    sourceUnit = parseIgesUnit(text);
    isSolid = /^\s*186\s/m.test(text) || text.includes(',186,') || /MANIFOLD_SOLID_BREP/i.test(text);

    const surfaces = parseIgesBSplineSurfaces(text);
    if (surfaces.length > 0) {
      mesh = mergeTessellatedSurfaces(surfaces, modelName);
    } else {
      const brepMesh = parseIgesBRepMesh(text, modelName);
      if (brepMesh && brepMesh.faces.length > 0) {
        mesh = brepMesh;
      } else {
        const curves = parseIgesBSplineCurves(text);
        if (curves.length > 0) {
          mesh = tessellateCurvesToMesh(curves, modelName);
        }
      }
    }
  } else {
    // STEP format
    const entityMap = parseStepEntities(text);
    sourceUnit = parseStepUnit(text, entityMap);
    isSolid =
      Array.from(entityMap.values()).some(
        (e) =>
          e.type === 'MANIFOLD_SOLID_BREP' ||
          e.type === 'BREP_WITH_VOIDS' ||
          e.type === 'FACETED_BREP'
      ) || /MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS|FACETED_BREP/i.test(text);

    const surfaces = extractStepBSplineSurfaces(entityMap);
    if (surfaces.length > 0) {
      mesh = mergeTessellatedSurfaces(surfaces, modelName);
    } else {
      const brepMesh = extractStepBRepMesh(entityMap, modelName);
      if (brepMesh && brepMesh.faces.length > 0) {
        mesh = brepMesh;
      } else {
        const curves = extractStepBSplineCurves(entityMap);
        if (curves.length > 0) {
          mesh = tessellateCurvesToMesh(curves, modelName);
        }
      }
    }
  }

  if (!mesh || mesh.vertices.length === 0) {
    throw new CadGeometryUnavailableError(
      `Failed to tessellate CAD geometry from ${format}: No valid B-spline surfaces, B-Rep topology, or curves found.`
    );
  }

  // 1. Topology validation and watertightness gate for solid B-Reps
  if (mesh.faces.length > 0) {
    const topologyReport = verifyWatertightManifoldMesh(mesh.vertices, mesh.faces);
    mesh.topologyReport = topologyReport;

    if (isSolid && !topologyReport.isWatertight && !options.allowOpenMesh) {
      throw new CadTopologyError(
        `CAD solid B-Rep model '${modelName}' produced a non-watertight mesh (${topologyReport.boundaryEdges} boundary edges, ${topologyReport.nonManifoldEdges} non-manifold edges, Euler characteristic=${topologyReport.eulerCharacteristic}, genus=${topologyReport.genus}). Set allowOpenMesh: true to bypass.`
      );
    }
  }

  // 2. Unit scaling
  scaleMeshCoordinates(mesh, sourceUnit, options.outputUnit);

  // 3. Normal splitting by crease angle
  if (options.smoothingAngleDeg !== undefined) {
    mesh = splitNormalsByCreaseAngle(mesh, options.smoothingAngleDeg);
  }

  return mesh;
}

/**
 * Tessellates any STEP or IGES CAD model with B-spline curves/surfaces into
 * a unified 3D mesh (TessellatedMesh) ready for STL, OBJ, or DXF export.
 */
export function tessellateCadBuffer(
  buffer: Buffer | Uint8Array | string,
  format: 'step' | 'stp' | 'iges' | 'igs',
  modelName = 'cad_model',
  options: ConversionOptions = {}
): TessellatedMesh {
  const text =
    typeof buffer === 'string'
      ? buffer
      : typeof Buffer !== 'undefined' && Buffer.isBuffer(buffer)
      ? buffer.toString('utf-8')
      : new TextDecoder('utf-8').decode(buffer);
  return tessellateCadText(text, format, modelName, options);
}

/**
 * Tessellates 3D B-spline curves into a continuous surface mesh (ribbon / ruled quad strip)
 * with non-zero face areas and exact normal vectors.
 */
export function tessellateCurvesToMesh(curves: BSplineCurve[], modelName: string): TessellatedMesh {
  if (curves.length === 0) {
    throw new Error('Failed to tessellate CAD curves: No curves provided.');
  }

  const samplesPerCurve = 32;
  const curvePointsList: Point3D[][] = [];

  for (const crv of curves) {
    const pts: Point3D[] = [];
    const deg = crv.degree || 3;
    const uMin = crv.knots && crv.knots.length > deg ? crv.knots[deg] : 0;
    const uMax = crv.knots && crv.knots.length > deg ? crv.knots[crv.knots.length - 1 - deg] : 1;
    const effectiveUMax = uMax > uMin ? uMax : uMin + 1;

    for (let i = 0; i <= samplesPerCurve; i++) {
      const u = uMin + (i / samplesPerCurve) * (effectiveUMax - uMin);
      pts.push(evaluateBSplineCurve(crv, u));
    }
    curvePointsList.push(pts);
  }

  const vertices: [number, number, number][] = [];
  const faces: [number, number, number][] = [];
  const normals: [number, number, number][] = [];

  if (curvePointsList.length >= 2) {
    // Generate ruled quad strips between adjacent curves
    for (let c = 0; c < curvePointsList.length - 1; c++) {
      const c1 = curvePointsList[c];
      const c2 = curvePointsList[c + 1];
      const baseIdx = vertices.length;

      for (let i = 0; i < c1.length; i++) {
        vertices.push([c1[i].x, c1[i].y, c1[i].z]);
        normals.push([0, 0, 1]);
      }
      for (let i = 0; i < c2.length; i++) {
        vertices.push([c2[i].x, c2[i].y, c2[i].z]);
        normals.push([0, 0, 1]);
      }

      for (let i = 0; i < samplesPerCurve; i++) {
        const i0 = baseIdx + i;
        const i1 = baseIdx + i + 1;
        const j0 = baseIdx + c1.length + i;
        const j1 = baseIdx + c1.length + i + 1;

        faces.push([i0, j0, j1]);
        faces.push([i0, j1, i1]);
      }
    }
  } else if (curvePointsList.length === 1) {
    // Single curve: generate extruded ribbon wireframe
    const c1 = curvePointsList[0];
    const baseIdx = vertices.length;

    const bbox = c1.reduce(
      (acc, p) => ({
        minX: Math.min(acc.minX, p.x),
        maxX: Math.max(acc.maxX, p.x),
        minY: Math.min(acc.minY, p.y),
        maxY: Math.max(acc.maxY, p.y),
        minZ: Math.min(acc.minZ, p.z),
        maxZ: Math.max(acc.maxZ, p.z),
      }),
      { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity }
    );
    const diag = Math.hypot(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY, bbox.maxZ - bbox.minZ);
    const ribbonHalfWidth = Math.max(1e-4, diag * 0.005);

    const leftRibbon: [number, number, number][] = [];
    const rightRibbon: [number, number, number][] = [];
    const ribbonNorms: [number, number, number][] = [];

    for (let i = 0; i < c1.length; i++) {
      const prev = c1[Math.max(0, i - 1)];
      const next = c1[Math.min(c1.length - 1, i + 1)];
      const tx = next.x - prev.x, ty = next.y - prev.y, tz = next.z - prev.z;
      const tLen = Math.hypot(tx, ty, tz);
      let nx = 0, ny = 0, nz = 1;
      if (tLen > 1e-8) {
        const utx = tx / tLen, uty = ty / tLen, utz = tz / tLen;
        const ref = Math.abs(uty) > 0.9 ? [1, 0, 0] : [0, 1, 0];
        nx = uty * ref[2] - utz * ref[1];
        ny = utz * ref[0] - utx * ref[2];
        nz = utx * ref[1] - uty * ref[0];
        const nLen = Math.hypot(nx, ny, nz);
        if (nLen > 1e-8) {
          nx /= nLen; ny /= nLen; nz /= nLen;
        } else {
          nx = 0; ny = 0; nz = 1;
        }
      }
      leftRibbon.push([c1[i].x - nx * ribbonHalfWidth, c1[i].y - ny * ribbonHalfWidth, c1[i].z - nz * ribbonHalfWidth]);
      rightRibbon.push([c1[i].x + nx * ribbonHalfWidth, c1[i].y + ny * ribbonHalfWidth, c1[i].z + nz * ribbonHalfWidth]);
      ribbonNorms.push([nx, ny, nz]);
    }

    vertices.push(...leftRibbon, ...rightRibbon);
    normals.push(...ribbonNorms, ...ribbonNorms);
    for (let i = 0; i < samplesPerCurve; i++) {
      const i0 = baseIdx + i;
      const i1 = baseIdx + i + 1;
      const j0 = baseIdx + c1.length + i;
      const j1 = baseIdx + c1.length + i + 1;

      faces.push([i0, j0, j1]);
      faces.push([i0, j1, i1]);
    }
  }

  // Recalculate vertex normals by accumulating adjacent face normals
  const accumNormals: [number, number, number][] = vertices.map(() => [0, 0, 0]);
  for (let fIdx = 0; fIdx < faces.length; fIdx++) {
    const f = faces[fIdx];
    const v0 = vertices[f[0]];
    const v1 = vertices[f[1]];
    const v2 = vertices[f[2]];
    const ax = v1[0] - v0[0], ay = v1[1] - v0[1], az = v1[2] - v0[2];
    const bx = v2[0] - v0[0], by = v2[1] - v0[1], bz = v2[2] - v0[2];
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-8) {
      const fnx = nx / len;
      const fny = ny / len;
      const fnz = nz / len;
      for (const vi of f) {
        accumNormals[vi][0] += fnx;
        accumNormals[vi][1] += fny;
        accumNormals[vi][2] += fnz;
      }
    }
  }

  for (let i = 0; i < vertices.length; i++) {
    const n = accumNormals[i];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len > 1e-8) {
      normals[i] = [n[0] / len, n[1] / len, n[2] / len];
    } else {
      normals[i] = [0, 0, 1];
    }
  }

  return { name: modelName, vertices, normals, faces };
}

function mergeTessellatedSurfaces(surfaces: BSplineSurface[], modelName: string): TessellatedMesh {
  const mergedVertices: [number, number, number][] = [];
  const mergedNormals: [number, number, number][] = [];
  const mergedFaces: [number, number, number][] = [];

  surfaces.forEach((s, idx) => {
    const mesh = tessellateBSplineSurfaceAdaptive(s, {}, `${modelName}_s${idx}`);
    const vOffset = mergedVertices.length;

    mesh.vertices.forEach((v) => mergedVertices.push(v));
    mesh.normals.forEach((n) => mergedNormals.push(n));
    mesh.faces.forEach((f) => mergedFaces.push([f[0] + vOffset, f[1] + vOffset, f[2] + vOffset]));
  });

  return {
    name: modelName,
    vertices: mergedVertices,
    normals: mergedNormals,
    faces: mergedFaces,
  };
}

export function delaunayTriangulation2DPoints(pts: Parametric2DPoint[]): Array<[number, number, number]> {
  const n = pts.length;
  if (n < 3) return [];
  if (n === 3) {
    const signedArea = (pts[1].u - pts[0].u) * (pts[2].v - pts[0].v) - (pts[2].u - pts[0].u) * (pts[1].v - pts[0].v);
    return signedArea >= 0 ? [[0, 1, 2]] : [[0, 2, 1]];
  }

  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of pts) {
    if (p.u < minU) minU = p.u;
    if (p.u > maxU) maxU = p.u;
    if (p.v < minV) minV = p.v;
    if (p.v > maxV) maxV = p.v;
  }

  const dU = Math.max(1e-4, maxU - minU);
  const dV = Math.max(1e-4, maxV - minV);
  const midU = (minU + maxU) / 2;
  const midV = (minV + maxV) / 2;
  const delta = Math.max(dU, dV) * 20;

  const allPts: Parametric2DPoint[] = [...pts];
  allPts.push({ u: midU - delta, v: midV - delta });
  allPts.push({ u: midU + delta, v: midV - delta });
  allPts.push({ u: midU, v: midV + delta });

  let triangles: Array<[number, number, number]> = [[n, n + 1, n + 2]];

  for (let i = 0; i < n; i++) {
    const p = allPts[i];
    const badTriangles: number[] = [];
    const polygonEdges: Array<[number, number]> = [];

    for (let tIdx = 0; tIdx < triangles.length; tIdx++) {
      const tri = triangles[tIdx];
      const p0 = allPts[tri[0]];
      const p1 = allPts[tri[1]];
      const p2 = allPts[tri[2]];

      const ax = p0.u - p.u, ay = p0.v - p.v;
      const bx = p1.u - p.u, by = p1.v - p.v;
      const cx = p2.u - p.u, cy = p2.v - p.v;
      const det =
        (ax * ax + ay * ay) * (bx * cy - cx * by) -
        (bx * bx + by * by) * (ax * cy - cx * ay) +
        (cx * cx + cy * cy) * (ax * by - bx * ay);

      const area = (p1.u - p0.u) * (p2.v - p0.v) - (p2.u - p0.u) * (p1.v - p0.v);
      const inCircle = area > 0 ? det > 1e-12 : det < -1e-12;

      if (inCircle) {
        badTriangles.push(tIdx);
      }
    }

    const edgeCount = new Map<string, { edge: [number, number]; count: number }>();
    for (const bIdx of badTriangles) {
      const tri = triangles[bIdx];
      for (let e = 0; e < 3; e++) {
        const vA = tri[e];
        const vB = tri[(e + 1) % 3];
        const key = vA < vB ? `${vA}-${vB}` : `${vB}-${vA}`;
        const existing = edgeCount.get(key);
        if (existing) {
          existing.count++;
        } else {
          edgeCount.set(key, { edge: [vA, vB], count: 1 });
        }
      }
    }

    for (const entry of edgeCount.values()) {
      if (entry.count === 1) {
        polygonEdges.push(entry.edge);
      }
    }

    triangles = triangles.filter((_, idx) => !badTriangles.includes(idx));

    for (const [vA, vB] of polygonEdges) {
      const signedArea =
        (allPts[vB].u - allPts[vA].u) * (p.v - allPts[vA].v) -
        (p.u - allPts[vA].u) * (allPts[vB].v - allPts[vA].v);
      if (signedArea >= 0) {
        triangles.push([vA, vB, i]);
      } else {
        triangles.push([vB, vA, i]);
      }
    }
  }

  const validTriangles = triangles.filter(
    (tri) => tri[0] < n && tri[1] < n && tri[2] < n
  );

  return lawsonEdgeFlipHealing2D(pts, validTriangles);
}

export function buildTrianglesFromPoints(points: Point3D[], modelName: string): TessellatedMesh {
  if (points.length < 3) {
    return { name: modelName, vertices: [], normals: [], faces: [] };
  }

  const uniquePoints: Point3D[] = [];
  for (const pt of points) {
    if (!uniquePoints.some((u) => Math.hypot(u.x - pt.x, u.y - pt.y, u.z - pt.z) < 1e-7)) {
      uniquePoints.push(pt);
    }
  }

  if (uniquePoints.length < 3) {
    return { name: modelName, vertices: [], normals: [], faces: [] };
  }

  const vertices: [number, number, number][] = uniquePoints.map((p) => [p.x, p.y, p.z]);

  // Compute Centroid
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const p of uniquePoints) {
    cx += p.x;
    cy += p.y;
    cz += p.z;
  }
  cx /= uniquePoints.length;
  cy /= uniquePoints.length;
  cz /= uniquePoints.length;

  // Find Best-Fit Plane Normal via cross product accumulation
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < uniquePoints.length; i++) {
    const p1 = uniquePoints[i];
    const p2 = uniquePoints[(i + 1) % uniquePoints.length];
    const ax = p1.x - cx;
    const ay = p1.y - cy;
    const az = p1.z - cz;
    const bx = p2.x - cx;
    const by = p2.y - cy;
    const bz = p2.z - cz;
    nx += ay * bz - az * by;
    ny += az * bx - ax * bz;
    nz += ax * by - ay * bx;
  }
  let normLen = Math.hypot(nx, ny, nz);

  if (normLen < 1e-6) {
    for (let i = 0; i < uniquePoints.length - 2; i++) {
      for (let j = i + 1; j < uniquePoints.length - 1; j++) {
        for (let k = j + 1; k < uniquePoints.length; k++) {
          const v1x = uniquePoints[j].x - uniquePoints[i].x;
          const v1y = uniquePoints[j].y - uniquePoints[i].y;
          const v1z = uniquePoints[j].z - uniquePoints[i].z;
          const v2x = uniquePoints[k].x - uniquePoints[i].x;
          const v2y = uniquePoints[k].y - uniquePoints[i].y;
          const v2z = uniquePoints[k].z - uniquePoints[i].z;
          const tx = v1y * v2z - v1z * v2y;
          const ty = v1z * v2x - v1x * v2z;
          const tz = v1x * v2y - v1y * v2x;
          const tLen = Math.hypot(tx, ty, tz);
          if (tLen > normLen) {
            nx = tx;
            ny = ty;
            nz = tz;
            normLen = tLen;
          }
        }
      }
    }
  }

  if (normLen < 1e-8) {
    return { name: modelName, vertices, normals: vertices.map(() => [0, 0, 1]), faces: [] };
  }

  nx /= normLen;
  ny /= normLen;
  nz /= normLen;

  let refX = 0;
  let refY = 1;
  let refZ = 0;
  if (Math.abs(ny) > 0.9) {
    refX = 1;
    refY = 0;
    refZ = 0;
  }
  let ux = refY * nz - refZ * ny;
  let uy = refZ * nx - refX * nz;
  let uz = refX * ny - refY * nx;
  const uLen = Math.hypot(ux, uy, uz);
  ux /= uLen;
  uy /= uLen;
  uz /= uLen;

  const vx = ny * uz - nz * uy;
  const vy = nz * ux - nx * uz;
  const vz = nx * uy - ny * ux;

  const pts2D: Parametric2DPoint[] = uniquePoints.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const dz = p.z - cz;
    return {
      u: dx * ux + dy * uy + dz * uz,
      v: dx * vx + dy * vy + dz * vz,
    };
  });

  const faces = delaunayTriangulation2DPoints(pts2D);

  const accumNormals: [number, number, number][] = vertices.map(() => [0, 0, 0]);
  for (const f of faces) {
    const v0 = vertices[f[0]];
    const v1 = vertices[f[1]];
    const v2 = vertices[f[2]];
    const ax = v1[0] - v0[0];
    const ay = v1[1] - v0[1];
    const az = v1[2] - v0[2];
    const bx = v2[0] - v0[0];
    const by = v2[1] - v0[1];
    const bz = v2[2] - v0[2];
    const fnx = ay * bz - az * by;
    const fny = az * bx - ax * bz;
    const fnz = ax * by - ay * bx;
    const fLen = Math.hypot(fnx, fny, fnz);
    if (fLen > 1e-8) {
      const unx = fnx / fLen;
      const uny = fny / fLen;
      const unz = fnz / fLen;
      for (const idx of f) {
        accumNormals[idx][0] += unx;
        accumNormals[idx][1] += uny;
        accumNormals[idx][2] += unz;
      }
    }
  }

  const normals: [number, number, number][] = accumNormals.map((norm) => {
    const len = Math.hypot(norm[0], norm[1], norm[2]);
    return len > 1e-8 ? [norm[0] / len, norm[1] / len, norm[2] / len] : [nx, ny, nz];
  });

  return { name: modelName, vertices, normals, faces };
}

export interface AdaptiveDeflectionOptions {
  linearDeflection?: number;
  angularDeflection?: number;
  relativeDeflection?: boolean;
}

/**
 * Adaptive Incremental BRepMesh Tessellation.
 * Discretizes analytical and parametric B-Rep solid topologies adaptively
 * adhering to linear (chordal) deflection and angular normal variation tolerances.
 */
export function adaptiveIncrementalBRepMesh(
  entityMap: Map<number, StepEntity>,
  options: AdaptiveDeflectionOptions = {},
  modelName = 'adaptive_brep_mesh'
): TessellatedMesh | null {
  if (!entityMap || typeof entityMap.values !== 'function') {
    return null;
  }

  const {
    linearDeflection = 0.05,
    angularDeflection = 0.5,
  } = options;

  // First extract baseline B-Rep mesh
  const baseMesh = extractStepBRepMesh(entityMap, modelName);
  if (!baseMesh || baseMesh.faces.length === 0) {
    return null;
  }

  // If deflection is coarse and baseline mesh is valid, return baseline
  if (linearDeflection >= 0.5 && angularDeflection >= 1.0) {
    return baseMesh;
  }

  const maxEdgeLenSq = Math.max(0.01, linearDeflection * 10) ** 2;
  const hasNormals = baseMesh.normals && baseMesh.normals.length === baseMesh.vertices.length;

  const checkNormalAngle = (idxA: number, idxB: number): boolean => {
    if (!hasNormals || !baseMesh.normals) return false;
    const nA = baseMesh.normals[idxA];
    const nB = baseMesh.normals[idxB];
    if (!nA || !nB) return false;
    const lenA = Math.hypot(nA[0], nA[1], nA[2]);
    const lenB = Math.hypot(nB[0], nB[1], nB[2]);
    if (lenA < 1e-6 || lenB < 1e-6) return false;
    const dot = Math.max(-1, Math.min(1, (nA[0] * nB[0] + nA[1] * nB[1] + nA[2] * nB[2]) / (lenA * lenB)));
    const angle = Math.acos(dot);
    return angle > angularDeflection;
  };

  // 1. Collect all edges from baseMesh faces and identify those exceeding maxEdgeLenSq or angularDeflection
  const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const markedEdges = new Set<string>();

  for (const [i1, i2, i3] of baseMesh.faces) {
    const v1 = baseMesh.vertices[i1];
    const v2 = baseMesh.vertices[i2];
    const v3 = baseMesh.vertices[i3];

    const d12Sq = (v1[0] - v2[0]) ** 2 + (v1[1] - v2[1]) ** 2 + (v1[2] - v2[2]) ** 2;
    const d23Sq = (v2[0] - v3[0]) ** 2 + (v2[1] - v3[1]) ** 2 + (v2[2] - v3[2]) ** 2;
    const d31Sq = (v3[0] - v1[0]) ** 2 + (v3[1] - v1[1]) ** 2 + (v3[2] - v1[2]) ** 2;

    if (d12Sq > maxEdgeLenSq || checkNormalAngle(i1, i2)) markedEdges.add(edgeKey(i1, i2));
    if (d23Sq > maxEdgeLenSq || checkNormalAngle(i2, i3)) markedEdges.add(edgeKey(i2, i3));
    if (d31Sq > maxEdgeLenSq || checkNormalAngle(i3, i1)) markedEdges.add(edgeKey(i3, i1));
  }

  if (markedEdges.size === 0) {
    return baseMesh;
  }

  // 2. Red-Green Conforming Closure:
  // Any triangle with 2 marked edges is promoted to Red refinement (mark 3rd edge),
  // preventing hanging nodes and aspect ratio degradation.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [i1, i2, i3] of baseMesh.faces) {
      const k12 = edgeKey(i1, i2);
      const k23 = edgeKey(i2, i3);
      const k31 = edgeKey(i3, i1);

      const m12 = markedEdges.has(k12);
      const m23 = markedEdges.has(k23);
      const m31 = markedEdges.has(k31);

      const count = (m12 ? 1 : 0) + (m23 ? 1 : 0) + (m31 ? 1 : 0);
      if (count === 2) {
        if (!m12) { markedEdges.add(k12); changed = true; }
        if (!m23) { markedEdges.add(k23); changed = true; }
        if (!m31) { markedEdges.add(k31); changed = true; }
      }
    }
  }

  // 3. Compute unique midpoints for all marked edges
  const refinedVertices: [number, number, number][] = [...baseMesh.vertices];
  const refinedNormals: [number, number, number][] =
    hasNormals && baseMesh.normals
      ? [...baseMesh.normals]
      : baseMesh.vertices.map(() => [0, 0, 1]);
  const edgeMidpointMap = new Map<string, number>();

  for (const k of markedEdges) {
    const [uStr, vStr] = k.split('_');
    const u = parseInt(uStr, 10);
    const v = parseInt(vStr, 10);
    const vu = refinedVertices[u];
    const vv = refinedVertices[v];
    const nu = refinedNormals[u] || [0, 0, 1];
    const nv = refinedNormals[v] || [0, 0, 1];

    const midV: [number, number, number] = [
      (vu[0] + vv[0]) / 2,
      (vu[1] + vv[1]) / 2,
      (vu[2] + vv[2]) / 2,
    ];

    let nx = (nu[0] + nv[0]) / 2;
    let ny = (nu[1] + nv[1]) / 2;
    let nz = (nu[2] + nv[2]) / 2;
    const nLen = Math.hypot(nx, ny, nz) || 1;
    const midN: [number, number, number] = [nx / nLen, ny / nLen, nz / nLen];

    const midIdx = refinedVertices.length;
    refinedVertices.push(midV);
    refinedNormals.push(midN);
    edgeMidpointMap.set(k, midIdx);
  }

  // 4. Construct conforming sub-triangles (Red 1:4 or Green 1:2 bisection)
  const refinedFaces: [number, number, number][] = [];

  for (const [i1, i2, i3] of baseMesh.faces) {
    const k12 = edgeKey(i1, i2);
    const k23 = edgeKey(i2, i3);
    const k31 = edgeKey(i3, i1);

    const m12 = edgeMidpointMap.get(k12);
    const m23 = edgeMidpointMap.get(k23);
    const m31 = edgeMidpointMap.get(k31);

    if (m12 !== undefined && m23 !== undefined && m31 !== undefined) {
      // Red Refinement (1:4 split)
      refinedFaces.push(
        [i1, m12, m31],
        [m12, i2, m23],
        [m31, m23, i3],
        [m12, m23, m31]
      );
    } else if (m12 !== undefined) {
      // Green Refinement (1:2 bisection across edge 1-2)
      refinedFaces.push([i1, m12, i3], [m12, i2, i3]);
    } else if (m23 !== undefined) {
      // Green Refinement (1:2 bisection across edge 2-3)
      refinedFaces.push([i2, m23, i1], [m23, i3, i1]);
    } else if (m31 !== undefined) {
      // Green Refinement (1:2 bisection across edge 3-1)
      refinedFaces.push([i3, m31, i2], [m31, i1, i2]);
    } else {
      // Untouched triangle
      refinedFaces.push([i1, i2, i3]);
    }
  }

  const refinedMesh: TessellatedMesh = {
    name: modelName,
    vertices: refinedVertices,
    normals: refinedNormals,
    faces: refinedFaces,
  };

  // 5. Sew and glue B-Rep topological boundary edges with tolerance epsilon = 1e-5
  return glueBRepTopologicalEdges(refinedMesh, { epsilon: 1e-5, enforceOrientedManifold: true });
}
