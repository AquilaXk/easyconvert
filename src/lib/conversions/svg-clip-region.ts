import { CadGeometryUnavailableError, UnsupportedOptionError } from '../types';
import type { AffineMatrix } from './svg-geometry';
import { PAGE_CLIP_TOLERANCE_PIXELS, type ClipNode } from './svg-page-clip';

/**
 * The clip a writer that holds no clip may drop. A DXF has no clipping, so a page that clips its drawing is refused unless
 * dropping the clip draws nothing the clip hides (policy 42). Both reference exporters drop every clip (Inkscape's
 * dxf_outlines.py `process_shape` reads none); this reader keeps the part of the refusal that guards against visible loss: a
 * non-page `clip-path` is dropped when no vertex of what it clips is more than PAGE_CLIP_TOLERANCE_PIXELS (one point of the
 * page) outside its region, measured on the flattened device-space geometry the writer writes (policy 79).
 *
 * The region of a clip is the union of the shapes of its `<clipPath>` (SVG 1.1 section 14.3.5), each filled by its own
 * `clip-rule`, in the user space of the clipped element; a point is inside by the winding count of the edges to its left that
 * cairo's `_cairo_path_fixed_in_fill` keeps (src/cairo-path-in-fill.c master, `_cairo_in_fill_add_edge` lines 100 to 148: half-open in y;
 * `_cairo_path_fixed_in_fill` lines 255 to 298: nonzero is a count other than zero, evenodd an odd count, a point on an edge is
 * inside). Poppler's SVG comes from cairo's SVG surface, which writes a clip as `<clipPath id="clip-N"><path clip-rule="..."
 * d="..."/></clipPath>` (src/cairo-svg-surface.c master, lines 1007 to 1011 and 3870 to 3874); cairo is LGPL/MPL, so only its
 * behaviour is followed.
 * The distance of a point outside is its distance to the nearest edge (closest point on a segment: Ericson, Real-Time
 * Collision Detection, section 5.1.2). That is its distance to the region when every edge borders the region: the winding count
 * on the two sides of an edge differs by one, so one side is inside, unless another edge of the same shape lies on it. Such
 * edges (a spike of no width, a path drawn twice under evenodd) may border nothing, so a clip with them is refused; a polygon
 * whose points are all on one line fills nothing and adds nothing to any count, so it is left out.
 *
 * The limits are this reader's own (neither reference has any): MAX_ACTIVE_CLIPS clips under one element, MAX_CLIP_EDGES edges
 * in one clip, MAX_CLIP_WORK edge tests in a document, on top of the document's vertex budget, which the clip shapes are
 * charged to once per clip. A clip that cannot be measured exactly (a bounding-box unit, a clip on the clip, text, a picture or
 * a group as its shape) stays refused.
 */

export const MAX_ACTIVE_CLIPS = 8;
export const MAX_CLIP_EDGES = 1024;
export const MAX_CLIP_WORK = 1 << 26;
/**
 * The largest coordinate of a clip or of what is drawn under it, in device pixels. The largest page a PDF reader accepts is
 * 14,400 points a side (ISO 32000-1 Annex C.2, `MAX_PAGE_POINTS`), 19,200 pixels; this is 50,000 times that, and keeps the
 * squared distances below 1e19, where a coordinate past 1e154 would overflow them to Infinity and their difference to NaN.
 */
export const MAX_CLIP_COORDINATE = 1e9;

interface Point {
  x: number;
  y: number;
}

/** The elements whose fill is a clip shape this reader measures (`text`, `use` and groups are not exact). */
const CLIP_SHAPE_ELEMENTS = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon']);
const CLIP_URL_PATTERN = /^url\(\s*#([^)\s"']+)\s*\)$/;
const MAX_REPORTED_DECIMALS = 2;
const FULL_TURN = 2 * Math.PI;
const TURN_EPSILON = 1e-6;

/** What the reader gives this module: the element index, the flattened outline of a shape and the style of an element. */
export interface ClipReader {
  ids: ReadonlyMap<string, ClipNode>;
  /** The user-space subpaths of a shape, charged to the document's vertex budget; null for a shape with no geometry. */
  outlineOf: (shape: ClipNode) => Point[][] | null;
  /** The declared properties of an element (attributes, `style` and stylesheet), `clip-rule`, `display` and `visibility` among them. */
  declaredOf: (node: ClipNode) => ReadonlyMap<string, string>;
  transformOf: (value: string) => AffineMatrix;
}

/** Counts the edge tests of a document and fails as soon as the cap is crossed. */
export class ClipWork {
  private used = 0;

  constructor(private readonly limit: number = MAX_CLIP_WORK) {}

  charge(count: number): void {
    this.used += count;
    if (this.used > this.limit) {
      throw new CadGeometryUnavailableError(`SVG clip-path work exceeds ${this.limit} edge tests; the clips are too complex to measure.`);
    }
  }
}

type FillRule = 'nonzero' | 'evenodd';

/** The shapes of a clip as closed polygons in the user space of the clipped element. */
interface ClipDefinition {
  shapes: { rule: FillRule; polygons: Point[][] }[];
}

/** One shape in device space: the edges as `ax, ay, bx, by` runs. */
interface DeviceShape {
  rule: FillRule;
  edges: Float64Array;
}

interface ClipRegion {
  shapes: DeviceShape[];
  edgeCount: number;
  /** One convex polygon: a segment with both ends inside is inside, so only the vertices are measured. */
  convex: boolean;
}

/** A polygon whose points are all on one line, which adds nothing to the winding count of any point off that line. */
function fillsNothing(polygon: readonly Point[]): boolean {
  if (polygon.length < 3) return true;
  const [a, b] = polygon;
  return polygon.every((p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) === 0);
}

/** The edges of closed polygons as `ax, ay, bx, by` runs. */
function edgeRuns(polygons: readonly (readonly Point[])[]): Float64Array {
  const edges = new Float64Array(polygons.reduce((total, polygon) => total + polygon.length, 0) * 4);
  let at = 0;
  for (const polygon of polygons) {
    polygon.forEach((a, i) => {
      const b = polygon[(i + 1) % polygon.length];
      edges.set([a.x, a.y, b.x, b.y], at);
      at += 4;
    });
  }
  return edges;
}

/** Whether the edges at runs `i` and `j` are on one line and share a piece of it longer than a point. */
function overlap(edges: Float64Array, i: number, j: number): boolean {
  const [ax, ay, dx, dy] = [edges[i], edges[i + 1], edges[i + 2] - edges[i], edges[i + 3] - edges[i + 1]];
  const cross = (x: number, y: number): number => dx * (y - ay) - dy * (x - ax);
  if (cross(edges[j], edges[j + 1]) !== 0 || cross(edges[j + 2], edges[j + 3]) !== 0) return false;
  const along = (x: number, y: number): number => (x - ax) * dx + (y - ay) * dy;
  const [s, t] = [along(edges[j], edges[j + 1]), along(edges[j + 2], edges[j + 3])];
  return Math.min(Math.max(s, t), dx * dx + dy * dy) > Math.max(Math.min(s, t), 0);
}

/** Whether two edges of the polygons of one shape lie on one another; every pair is tested and charged to the work. */
function hasOverlappingEdges(polygons: readonly (readonly Point[])[], work: ClipWork): boolean {
  const edges = edgeRuns(polygons);
  const count = edges.length / 4;
  work.charge((count * (count - 1)) / 2);
  for (let i = 0; i < edges.length; i += 4) {
    for (let j = i + 4; j < edges.length; j += 4) if (overlap(edges, i, j)) return true;
  }
  return false;
}

/** A polygon without its closing repeat of the first point and without consecutive equal points. */
function simplePolygon(points: readonly Point[]): Point[] {
  const kept = points.filter((p, i) => i === 0 || p.x !== points[i - 1].x || p.y !== points[i - 1].y);
  while (kept.length > 1 && kept[0].x === kept[kept.length - 1].x && kept[0].y === kept[kept.length - 1].y) kept.pop();
  return kept;
}

/** Convex and simple: the turns all go one way and add up to one full turn (a star turns the same way twice round). */
function isConvexPolygon(polygon: readonly Point[]): boolean {
  if (polygon.length < 3) return false;
  let direction = 0;
  let turning = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const c = polygon[(i + 2) % polygon.length];
    const [abx, aby, bcx, bcy] = [b.x - a.x, b.y - a.y, c.x - b.x, c.y - b.y];
    const cross = abx * bcy - aby * bcx;
    if (cross !== 0) {
      if (direction !== 0 && Math.sign(cross) !== direction) return false;
      direction = Math.sign(cross);
    }
    turning += Math.atan2(cross, abx * bcx + aby * bcy);
  }
  return Math.abs(Math.abs(turning) - FULL_TURN) < TURN_EPSILON;
}

function pointOnPage(p: Point): Point {
  if (!(Math.abs(p.x) <= MAX_CLIP_COORDINATE && Math.abs(p.y) <= MAX_CLIP_COORDINATE)) {
    throw new CadGeometryUnavailableError(`SVG clip-path measures a coordinate that is not a finite number within ${MAX_CLIP_COORDINATE} device pixels.`);
  }
  return p;
}

const transformPoint = (m: AffineMatrix, p: Point): Point => pointOnPage({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

function multiply(m1: AffineMatrix, m2: AffineMatrix): AffineMatrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/** The device-space region of a clip under `ctm`; a polygon that a singular `ctm` puts on one line fills nothing and is left out. */
function deviceRegion(definition: ClipDefinition, ctm: AffineMatrix): ClipRegion {
  const shapes: DeviceShape[] = [];
  for (const shape of definition.shapes) {
    const polygons = shape.polygons.map((polygon) => simplePolygon(polygon.map((p) => transformPoint(ctm, p)))).filter((polygon) => !fillsNothing(polygon));
    if (polygons.length > 0) shapes.push({ rule: shape.rule, edges: edgeRuns(polygons) });
  }
  const convex = shapes.length === 1 && definition.shapes.length === 1 && definition.shapes[0].polygons.length === 1 && isConvexPolygon(simplePolygon(definition.shapes[0].polygons[0]));
  return { shapes, edgeCount: shapes.reduce((total, shape) => total + shape.edges.length / 4, 0), convex };
}

/**
 * Zero for a point inside the region, otherwise its distance to the region (Infinity when the region is empty). One pass over
 * the edges of a shape gives both the winding count of cairo's `_cairo_in_fill_add_edge` and the nearest edge.
 */
function distanceOutside(region: ClipRegion, x: number, y: number): number {
  let nearest = Infinity;
  for (const { rule, edges } of region.shapes) {
    let winding = 0;
    let shapeNearest = Infinity;
    for (let i = 0; i < edges.length; i += 4) {
      const [ax, ay, bx, by] = [edges[i], edges[i + 1], edges[i + 2], edges[i + 3]];
      const [dx, dy] = [bx - ax, by - ay];
      const lengthSquared = dx * dx + dy * dy;
      const along = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / lengthSquared));
      const [ex, ey] = [ax + along * dx - x, ay + along * dy - y];
      shapeNearest = Math.min(shapeNearest, ex * ex + ey * ey);
      if (ay === by) continue;
      const [lowY, highY, lowX, highX, direction] = ay < by ? [ay, by, ax, bx, 1] : [by, ay, bx, ax, -1];
      if (highY <= y || lowY > y) continue;
      if (lowX + ((y - lowY) * (highX - lowX)) / (highY - lowY) < x) winding += direction;
    }
    if (shapeNearest === 0 || (rule === 'evenodd' ? (winding & 1) !== 0 : winding !== 0)) return 0;
    nearest = Math.min(nearest, shapeNearest);
  }
  return Math.sqrt(nearest);
}

/** Where a segment from `p` to `q` crosses an edge of the region, as parameters strictly between 0 and 1, in order. */
function crossings(region: ClipRegion, p: Point, q: Point): number[] {
  const [rx, ry] = [q.x - p.x, q.y - p.y];
  const found: number[] = [];
  for (const { edges } of region.shapes) {
    for (let i = 0; i < edges.length; i += 4) {
      const [sx, sy] = [edges[i + 2] - edges[i], edges[i + 3] - edges[i + 1]];
      const denominator = rx * sy - ry * sx;
      if (denominator === 0) continue;
      const [px, py] = [edges[i] - p.x, edges[i + 1] - p.y];
      const t = (px * sy - py * sx) / denominator;
      const u = (px * ry - py * rx) / denominator;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) found.push(t);
    }
  }
  return found.sort((a, b) => a - b);
}

/** A piece of a segment between parameters `a` and `b`, with the distances outside the region of its two ends. */
type Piece = [a: number, distanceA: number, b: number, distanceB: number];

/**
 * The most a piece of the segment from `p` to `q` that crosses no edge of the region is outside it, or the first distance past
 * `tolerance`. No edge crosses the piece, so it is inside or outside as a whole, and its middle says which. The distance to
 * a region changes by at most the distance moved, so on a piece of length L with ends at d0 and d1 no point is farther than
 * (d0 + d1 + L) / 2; a piece is halved, each middle measured and charged to the work, until that bound is within the tolerance.
 */
function farthestOnPiece(region: ClipRegion, p: Point, q: Point, piece: Piece, tolerance: number, work: ClipWork): number {
  const length = Math.hypot(q.x - p.x, q.y - p.y);
  const pending: Piece[] = [piece];
  let farthest = 0;
  while (pending.length > 0) {
    const [a, distanceA, b, distanceB] = pending.pop() as Piece;
    if ((distanceA + distanceB + (b - a) * length) / 2 <= tolerance) continue;
    work.charge(region.edgeCount);
    const middle = (a + b) / 2;
    const distance = distanceOutside(region, p.x + middle * (q.x - p.x), p.y + middle * (q.y - p.y));
    farthest = Math.max(farthest, distance);
    if (distance === 0) continue;
    if (!(distance <= tolerance)) return farthest;
    pending.push([a, distanceA, middle, distance], [middle, distance, b, distanceB]);
  }
  return farthest;
}

/**
 * The most any point of `subpaths` is outside the region (0 when all are inside), measured on its vertices and, against a
 * region that is not one convex polygon, on each piece of a segment between its crossings of the region's edges. Against a
 * convex region the distance along a segment is convex, so the vertices hold its largest value. A crossing is on an edge,
 * and every edge borders the region (`deviceRegion`), so a crossing is at distance 0.
 */
function farthestOutside(region: ClipRegion, subpaths: readonly (readonly Point[])[], tolerance: number, work: ClipWork): number {
  let farthest = 0;
  for (const subpath of subpaths) {
    work.charge(subpath.length * region.edgeCount);
    let previous = 0;
    for (let i = 0; i < subpath.length; i++) {
      pointOnPage(subpath[i]);
      const distance = distanceOutside(region, subpath[i].x, subpath[i].y);
      farthest = Math.max(farthest, distance);
      if (!region.convex && i > 0) {
        const [p, q] = [subpath[i - 1], subpath[i]];
        work.charge(region.edgeCount);
        const cuts = [0, ...crossings(region, p, q), 1];
        for (let k = 1; k < cuts.length; k++) {
          const piece: Piece = [cuts[k - 1], k === 1 ? previous : 0, cuts[k], k === cuts.length - 1 ? distance : 0];
          farthest = Math.max(farthest, farthestOnPiece(region, p, q, piece, tolerance, work));
        }
      }
      previous = distance;
    }
  }
  return farthest;
}

function formatPixels(value: number): string {
  return String(Number(value.toFixed(MAX_REPORTED_DECIMALS)));
}

/** The refusal of a clip: the same words as for any clip the reader cannot drop, and why this one is not. */
function clipRefusal(value: string, reason: string): UnsupportedOptionError {
  return new UnsupportedOptionError(`SVG clip-path "${value}" is not supported: ${reason}.`);
}

interface ActiveClip {
  value: string;
  region: ClipRegion;
}

/**
 * The clips an element is drawn under, innermost last. `enter` opens a clip when its element starts, `assertWithin` measures
 * each shape drawn under it, `leave` closes it. A clip is read once per id however many elements refer to it; its region is
 * placed under each referring element's matrix.
 */
export class ActiveClips {
  private readonly stack: ActiveClip[] = [];
  private readonly definitions = new Map<string, ClipDefinition>();

  constructor(
    private readonly reader: ClipReader,
    private readonly work: ClipWork = new ClipWork(),
    private readonly tolerance: number = PAGE_CLIP_TOLERANCE_PIXELS
  ) {}

  /** Opens the clip named by a `clip-path` value for an element drawn under `ctm`; refuses a clip it cannot measure. */
  enter(value: string, ctm: AffineMatrix): true {
    const id = CLIP_URL_PATTERN.exec(value)?.[1];
    if (id === undefined) throw clipRefusal(value, 'it is not a reference to a <clipPath>');
    if (this.stack.length >= MAX_ACTIVE_CLIPS) throw clipRefusal(value, `clips are nested more than ${MAX_ACTIVE_CLIPS} deep`);
    const region = deviceRegion(this.definitionOf(id, value), ctm);
    this.work.charge(region.edgeCount);
    this.stack.push({ value, region });
    return true;
  }

  leave(): void {
    this.stack.pop();
  }

  /**
   * Refuses the shape when it reaches past a clip it is drawn under: by more than the tolerance under one clip, by anything
   * under more than one. A point a little outside each of two clips can be far outside their intersection, which can even be
   * empty, and the intersection is not measured, so under nested clips the shape must be inside each.
   */
  assertWithin(subpaths: readonly (readonly Point[])[]): void {
    const nested = this.stack.length > 1;
    const tolerance = nested ? 0 : this.tolerance;
    for (const { value, region } of this.stack) {
      const farthest = farthestOutside(region, subpaths, tolerance, this.work);
      if (!(farthest <= tolerance)) throw clipRefusal(value, this.reach(farthest, nested));
    }
  }

  private reach(farthest: number, nested: boolean): string {
    if (!Number.isFinite(farthest)) return 'it hides everything under it';
    const past = `a drawn path reaches ${formatPixels(farthest)} pixels past it`;
    return nested ? `${past}, and a path under more than one clip must be inside each of them` : `${past}, more than the ${formatPixels(this.tolerance)} pixels (one point) a clip may hide`;
  }

  private definitionOf(id: string, value: string): ClipDefinition {
    const known = this.definitions.get(id);
    if (known !== undefined) return known;
    const definition = this.readDefinition(id, value);
    this.definitions.set(id, definition);
    return definition;
  }

  private readDefinition(id: string, value: string): ClipDefinition {
    const { ids, declaredOf, outlineOf, transformOf } = this.reader;
    const clip = ids.get(id);
    if (clip === undefined) throw clipRefusal(value, `no element has the id "${id}"`);
    if (clip.name !== 'clipPath') throw clipRefusal(value, `#${id} is not a <clipPath>`);
    const hasClipOfItsOwn = (node: ClipNode, declared: ReadonlyMap<string, string>): boolean => node.attrs.has('clip-path') || declared.has('clip-path');
    const clipDeclared = declaredOf(clip);
    if (hasClipOfItsOwn(clip, clipDeclared)) throw clipRefusal(value, 'the <clipPath> has a clip-path of its own');
    const units = clip.attrs.get('clipPathUnits');
    if (units !== undefined && units.trim() !== 'userSpaceOnUse') throw clipRefusal(value, `clipPathUnits="${units}" is relative to the box of the clipped element, which is not exact on flattened geometry (only userSpaceOnUse is measured)`);
    const clipTransform = transformOf(clip.attrs.get('transform') ?? '');
    const shapes: ClipDefinition['shapes'] = [];
    let edges = 0;
    for (const shape of clip.children) {
      if (!CLIP_SHAPE_ELEMENTS.has(shape.name)) throw clipRefusal(value, `it holds <${shape.name}>, which is not a shape this reader measures`);
      const declared = declaredOf(shape);
      if (hasClipOfItsOwn(shape, declared)) throw clipRefusal(value, 'a shape of the <clipPath> has a clip-path of its own');
      if (declared.get('display') === 'none' || ['hidden', 'collapse'].includes(declared.get('visibility') ?? '')) continue;
      const outline = outlineOf(shape);
      if (outline === null) continue;
      const toClipSpace = multiply(clipTransform, transformOf(shape.attrs.get('transform') ?? ''));
      const polygons = outline.map((subpath) => simplePolygon(subpath.map((p) => transformPoint(toClipSpace, p)))).filter((polygon) => !fillsNothing(polygon));
      edges += polygons.reduce((total, polygon) => total + polygon.length, 0);
      if (edges > MAX_CLIP_EDGES) throw clipRefusal(value, `it has more than ${MAX_CLIP_EDGES} edges`);
      if (hasOverlappingEdges(polygons, this.work)) throw clipRefusal(value, 'two edges of a shape in it lie on one another, so an edge may border nothing');
      const rule = (declared.get('clip-rule') ?? clipDeclared.get('clip-rule')) === 'evenodd' ? 'evenodd' : 'nonzero';
      shapes.push({ rule, polygons });
    }
    return { shapes };
  }
}
