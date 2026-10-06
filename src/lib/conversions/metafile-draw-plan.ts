import { CadGeometryUnavailableError } from '../types';
import type { RgbColor, SvgFillRule, SvgGeometryElement, SvgLinecap, SvgLinejoin } from './svg-geometry';

export interface PlanPoint {
  x: number;
  y: number;
}

export interface PlanPen {
  color: RgbColor;
  /** Stroke width in device pixels. */
  width: number;
  cap: SvgLinecap;
  join: SvgLinejoin;
  miterLimit: number;
}

/** One filled shape: every ring belongs to the same area, so holes stay holes. */
export interface FillOp {
  kind: 'fill';
  /** Rings without a repeated closing point; each is closed implicitly. */
  rings: PlanPoint[][];
  fill: RgbColor;
  fillRule: SvgFillRule;
  /** Outline pen when every sub-path is explicitly closed, otherwise null. */
  pen: PlanPen | null;
}

/** Stroked open or closed polylines (closed ones repeat their first point). */
export interface StrokeOp {
  kind: 'stroke';
  lines: PlanPoint[][];
  pen: PlanPen;
}

export type DrawOp = FillOp | StrokeOp;

const MIN_RING_POINTS = 3;
const MIN_LINE_POINTS = 2;
const POINT_EPSILON = 1e-9;

function samePoint(a: PlanPoint, b: PlanPoint): boolean {
  return Math.abs(a.x - b.x) <= POINT_EPSILON && Math.abs(a.y - b.y) <= POINT_EPSILON;
}

function dedupeConsecutive(points: PlanPoint[]): PlanPoint[] {
  const out: PlanPoint[] = [];
  for (const p of points) {
    if (out.length === 0 || !samePoint(out[out.length - 1], p)) out.push(p);
  }
  return out;
}

function isExplicitlyClosed(points: PlanPoint[]): boolean {
  return points.length >= MIN_RING_POINTS + 1 && samePoint(points[0], points[points.length - 1]);
}

function toRing(points: PlanPoint[]): PlanPoint[] {
  return isExplicitlyClosed(points) ? points.slice(0, -1) : points;
}

/**
 * Turns an SVG geometry element into fill and stroke operations. SVG fills
 * open sub-paths by closing them implicitly, and all sub-paths of one element
 * form a single fill area governed by its fill-rule.
 */
export function planElement(el: SvgGeometryElement): DrawOp[] {
  const subpaths = el.subpaths.map(dedupeConsecutive).filter((s) => s.length >= MIN_LINE_POINTS);
  const ops: DrawOp[] = [];
  const pen: PlanPen | null = el.stroke ? { color: el.stroke, width: el.strokeWidth, cap: el.strokeLinecap, join: el.strokeLinejoin, miterLimit: el.strokeMiterlimit } : null;

  const rings = el.fillable && el.fill ? subpaths.map(toRing).filter((r) => r.length >= MIN_RING_POINTS) : [];
  const allClosed = subpaths.length > 0 && subpaths.every(isExplicitlyClosed);
  const outlineWithFill = pen !== null && allClosed && rings.length === subpaths.length;

  if (el.fill && rings.length > 0) {
    ops.push({ kind: 'fill', rings, fill: el.fill, fillRule: el.fillRule, pen: outlineWithFill ? pen : null });
  }
  if (pen && !outlineWithFill && subpaths.length > 0) {
    ops.push({ kind: 'stroke', lines: subpaths, pen });
  }
  return ops;
}

// ============================================================================
// Miter corners
// ============================================================================

const COLLINEAR_EPSILON = 1e-12;

/**
 * Miter ratios (miter length / stroke width = 1 / sin(theta / 2), theta the
 * interior corner angle) at every vertex of a stroked polyline. Closed lines
 * (first point repeated last) include the corner at the closing vertex.
 */
export function miterRatios(points: PlanPoint[], closed: boolean): number[] {
  const pts = closed && points.length > 1 && samePoint(points[0], points[points.length - 1]) ? points.slice(0, -1) : points;
  const n = pts.length;
  const ratios: number[] = [];
  const first = closed ? 0 : 1;
  const last = closed ? n : n - 1;
  for (let i = first; i < last; i++) {
    const prev = pts[(i - 1 + n) % n];
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    const ux = cur.x - prev.x;
    const uy = cur.y - prev.y;
    const vx = next.x - cur.x;
    const vy = next.y - cur.y;
    const lu = Math.hypot(ux, uy);
    const lv = Math.hypot(vx, vy);
    if (lu === 0 || lv === 0) continue;
    const cosTurn = (ux * vx + uy * vy) / (lu * lv);
    const half = (1 + cosTurn) / 2;
    ratios.push(half <= COLLINEAR_EPSILON ? Infinity : 1 / Math.sqrt(half));
  }
  return ratios;
}

/** Every stroked polyline of a draw operation with whether it is closed. */
export function strokedLines(op: DrawOp): { points: PlanPoint[]; closed: boolean }[] {
  if (op.kind === 'stroke') {
    return op.lines.map((points) => ({ points, closed: points.length > 2 && samePoint(points[0], points[points.length - 1]) }));
  }
  return op.pen ? op.rings.map((points) => ({ points: [...points, points[0]], closed: true })) : [];
}

// ============================================================================
// Fill-rule equivalence (nonzero vs even-odd)
// ============================================================================

interface Edge {
  a: PlanPoint;
  b: PlanPoint;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * Work budget for the fill-rule analysis of one whole document (every shape
 * and <use> copy together), in edge-pair tests plus scanline x edge
 * evaluations. Beyond it the document is rejected as too complex to verify
 * rather than analysed in super-quadratic time.
 */
export const FILL_RULE_WORK_BUDGET = 5_000_000;

function fillRuleTooComplex(): CadGeometryUnavailableError {
  return new CadGeometryUnavailableError(
    `Fill-rule analysis is too complex to verify within ${FILL_RULE_WORK_BUDGET} steps; simplify the shape or use fill-rule evenodd.`
  );
}

/** Tracks fill-rule analysis work for one document against FILL_RULE_WORK_BUDGET. */
export class WorkMeter {
  private used = 0;

  spend(units: number): void {
    this.used += units;
    if (this.used > FILL_RULE_WORK_BUDGET) throw fillRuleTooComplex();
  }
}

function cross(o: PlanPoint, a: PlanPoint, b: PlanPoint): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function buildEdges(rings: PlanPoint[][]): Edge[] {
  const edges: Edge[] = [];
  for (const ring of rings) {
    ring.forEach((a, i) => {
      const b = ring[(i + 1) % ring.length];
      edges.push({ a, b, minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) });
    });
  }
  return edges;
}

/** y coordinates of every vertex and every proper edge crossing. */
function eventYs(edges: Edge[], meter: WorkMeter): number[] {
  const ys = new Set<number>();
  for (const e of edges) {
    ys.add(e.a.y);
    ys.add(e.b.y);
  }
  const byX = [...edges].sort((s, t) => s.minX - t.minX);
  for (let i = 0; i < byX.length; i++) {
    const s = byX[i];
    for (let j = i + 1; j < byX.length && byX[j].minX <= s.maxX; j++) {
      meter.spend(1);
      const t = byX[j];
      if (t.maxY < s.minY || t.minY > s.maxY) continue;
      const d1 = cross(t.a, t.b, s.a);
      const d2 = cross(t.a, t.b, s.b);
      const d3 = cross(s.a, s.b, t.a);
      const d4 = cross(s.a, s.b, t.b);
      if (d1 * d2 < 0 && d3 * d4 < 0) {
        const u = d1 / (d1 - d2);
        ys.add(s.a.y + u * (s.b.y - s.a.y));
      }
    }
  }
  return [...ys].sort((p, q) => p - q);
}

/**
 * Reports whether filling the rings with the nonzero rule covers a different
 * area than the even-odd rule, i.e. whether some region has a winding number
 * of magnitude two or more. Every face of the edge arrangement spans an open
 * band between two consecutive vertex/crossing y values, so scanning the
 * middle of each band visits every face.
 */
export function nonzeroDiffersFromEvenOdd(rings: PlanPoint[][], meter: WorkMeter): boolean {
  const edges = buildEdges(rings);
  meter.spend(edges.length);
  const sloped = edges.filter((e) => e.a.y !== e.b.y);
  const ys = eventYs(edges, meter);
  // Charge the whole scan up front so an oversized arrangement fails before any scanning.
  meter.spend(Math.max(0, ys.length - 1) * sloped.length);
  for (let k = 0; k + 1 < ys.length; k++) {
    const ym = (ys[k] + ys[k + 1]) / 2;
    const crossings: { x: number; dir: number }[] = [];
    for (const e of sloped) {
      if (e.minY < ym && ym < e.maxY) {
        const x = e.a.x + ((ym - e.a.y) * (e.b.x - e.a.x)) / (e.b.y - e.a.y);
        crossings.push({ x, dir: Math.sign(e.b.y - e.a.y) });
      }
    }
    crossings.sort((p, q) => p.x - q.x);
    let winding = 0;
    for (const c of crossings) {
      winding += c.dir;
      if (Math.abs(winding) >= 2) return true;
    }
  }
  return false;
}
