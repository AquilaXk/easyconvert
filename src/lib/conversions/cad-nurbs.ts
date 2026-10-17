/**
 * CAD curve mathematics for the SVG and 2D paths, and the topology check of a triangle mesh.
 *
 * Implements:
 * 1. Cox-de Boor recursive basis functions N_{i,p}(u) and derivatives N'_{i,p}(u)
 * 2. Rational & non-rational B-spline curve evaluation, cubic and quadratic Bezier evaluation and adaptive flattening,
 *    and the flattening of an SVG elliptical arc
 * 3. A half-edge mesh and the Euler-Poincare check of a closed 2-manifold (used when a mesh is written as B-rep)
 *
 * STEP and IGES are not read here: the worker runs the Open CASCADE program (cad-occt.ts).
 */

import { CadGeometryError } from '../types';

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

/** Knots closer than this are one knot; a knot vector whose usable range is no wider spans nothing. */
const MIN_KNOT_RANGE = 1e-12;

/**
 * Refuses a knot vector no B-spline can be evaluated on (NURBS Book, 2.1): the count must be control points
 * + degree + 1, every knot finite, the sequence non-decreasing, and the usable range (from knot `degree` to
 * knot `controlPointCount`) wider than zero. Evaluating anyway returns a number for any input, a wrong one.
 */
export function assertValidKnotVector(
  owner: 'curve' | 'surface',
  axis: string,
  knots: number[],
  controlPointCount: number,
  degree: number
): void {
  const label = ['B-spline', owner, axis, 'knot vector'].filter(Boolean).join(' ');
  const needed = controlPointCount + degree + 1;
  if (knots.length !== needed) {
    throw new CadGeometryError(`${label} has ${knots.length} knots, ${needed} needed for ${controlPointCount} control points of degree ${degree}`);
  }
  for (let i = 0; i < knots.length; i++) {
    if (!Number.isFinite(knots[i])) throw new CadGeometryError(`${label} holds a non-finite knot at index ${i}`);
    if (i > 0 && knots[i] < knots[i - 1]) {
      throw new CadGeometryError(`${label} decreases at index ${i} (${knots[i]} follows ${knots[i - 1]})`);
    }
  }
  if (knots[controlPointCount] - knots[degree] <= MIN_KNOT_RANGE) {
    throw new CadGeometryError(`${label} spans no parameter range`);
  }
}

/**
 * Evaluates a B-spline or NURBS curve at parameter u: C(u)
 */
export function evaluateBSplineCurve(curve: BSplineCurve, u: number): Point3D {
  const { degree, controlPoints, weights, knots } = curve;
  const n = controlPoints.length - 1;
  assertValidKnotVector('curve', '', knots, controlPoints.length, degree);

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
