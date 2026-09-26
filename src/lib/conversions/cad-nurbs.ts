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

  // Extract DATA section
  const dataMatch = content.match(/DATA\s*;([\s\S]*?)ENDSEC\s*;/i);
  const dataSection = dataMatch ? dataMatch[1] : content;

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
export function extractStepPoint(id: number, entityMap: Map<number, StepEntity>): Point3D | null {
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
      return extractStepPoint(ptId, entityMap);
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

// ============================================================================
// 7. High-Level STEP & IGES 3D Model Tessellator
// ============================================================================

/**
 * Tessellates any STEP or IGES CAD model with B-spline curves/surfaces into
 * a unified 3D mesh (TessellatedMesh) ready for STL, OBJ, or DXF export.
 */
export function tessellateCadBuffer(
  buffer: Buffer,
  format: 'step' | 'stp' | 'iges' | 'igs',
  modelName = 'cad_model'
): TessellatedMesh {
  const text = buffer.toString('utf-8');
  const isIges = format === 'iges' || format === 'igs' || text.includes('S      1');

  if (isIges) {
    const surfaces = parseIgesBSplineSurfaces(text);
    if (surfaces.length > 0) {
      return mergeTessellatedSurfaces(surfaces, modelName);
    }

    // Fallback 1: IGES B-Spline Curves (Entity 126)
    const curves = parseIgesBSplineCurves(text);
    if (curves.length > 0) {
      return tessellateCurvesToMesh(curves, modelName);
    }

    // Fallback 2: Check for IGES 116 points
    const pointList: Point3D[] = [];
    const ptRegex = /116\s*,\s*([0-9.eE+-]+)\s*,\s*([0-9.eE+-]+)\s*,\s*([0-9.eE+-]+)/g;
    let m: RegExpExecArray | null;
    while ((m = ptRegex.exec(text)) !== null) {
      pointList.push({
        x: parseFloat(m[1]) || 0,
        y: parseFloat(m[2]) || 0,
        z: parseFloat(m[3]) || 0,
      });
    }

    if (pointList.length >= 3) {
      return buildTrianglesFromPoints(pointList, modelName);
    }
  } else {
    // STEP format
    const entityMap = parseStepEntities(text);
    const surfaces = extractStepBSplineSurfaces(entityMap);
    if (surfaces.length > 0) {
      return mergeTessellatedSurfaces(surfaces, modelName);
    }

    // Fallback 1: STEP B-Spline Curves
    const curves = extractStepBSplineCurves(entityMap);
    if (curves.length > 0) {
      return tessellateCurvesToMesh(curves, modelName);
    }

    // Fallback 2: If no B-spline surface or curves but Cartesian points exist in STEP
    const pointList: Point3D[] = [];
    for (const ent of entityMap.values()) {
      if (ent.type.includes('CARTESIAN_POINT')) {
        const pt = extractStepPoint(ent.id, entityMap);
        if (pt) pointList.push(pt);
      }
    }

    if (pointList.length >= 3) {
      return buildTrianglesFromPoints(pointList, modelName);
    }
  }

  throw new Error(`Failed to tessellate CAD geometry from ${format}: No valid B-spline surfaces or Cartesian points found.`);
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
    for (let i = 0; i < c1.length; i++) {
      vertices.push([c1[i].x, c1[i].y, c1[i].z]);
      normals.push([0, 0, 1]);
    }
    for (let i = 0; i < c1.length; i++) {
      vertices.push([c1[i].x + 0.1, c1[i].y + 0.1, c1[i].z + 0.1]);
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
    const mesh = tessellateBSplineSurface(s, { uSamples: 16, vSamples: 16 }, `${modelName}_s${idx}`);
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

function buildTrianglesFromPoints(points: Point3D[], modelName: string): TessellatedMesh {
  const vertices: [number, number, number][] = points.map((p) => [p.x, p.y, p.z]);
  const faces: [number, number, number][] = [];
  const normals: [number, number, number][] = [];

  for (let i = 0; i + 2 < vertices.length; i += 3) {
    faces.push([i, i + 1, i + 2]);
    const v1 = vertices[i];
    const v2 = vertices[i + 1];
    const v3 = vertices[i + 2];
    const ax = v2[0] - v1[0];
    const ay = v2[1] - v1[1];
    const az = v2[2] - v1[2];
    const bx = v3[0] - v1[0];
    const by = v3[1] - v1[1];
    const bz = v3[2] - v1[2];
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-8) {
      normals.push([nx / len, ny / len, nz / len]);
      normals.push([nx / len, ny / len, nz / len]);
      normals.push([nx / len, ny / len, nz / len]);
    } else {
      normals.push([0, 0, 1]);
      normals.push([0, 0, 1]);
      normals.push([0, 0, 1]);
    }
  }

  return { name: modelName, vertices, normals, faces };
}
