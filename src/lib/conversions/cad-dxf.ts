import PDFDocument from 'pdfkit';
import { CadExpansionLimitError, CadGeometryError, ConversionFailedError } from '../types';
import { configurePdfKitFontFallback, renderSafePdfText } from './office';

/**
 * Two-dimensional DXF reading and drawing.
 *
 * The reader walks the group-code stream of the DXF reference (a code line and a value line per pair), reads the layer
 * table, the BLOCKS section and the ENTITIES section, and turns every entity a plan or a part drawing is made of into
 * strokes in drawing units, y pointing up:
 * - LINE, CIRCLE and ARC stay exact; an ARC runs counter-clockwise from its start angle to its end angle.
 * - LWPOLYLINE and POLYLINE (with VERTEX and SEQEND) are polylines; a vertex with a bulge starts a circular arc, which is
 *   sampled (bulge = tan(sweep / 4), positive counter-clockwise).
 * - ELLIPSE (a centre, a major axis, a ratio and a parameter range) and SPLINE (a NURBS curve of any degree from its knots,
 *   control points and weights; fit points when the curve states no control points) are sampled.
 * - INSERT places a block through its insert point, scale and rotation (and the row and column array of an INSERT), nested
 *   blocks included; DIMENSION draws the anonymous block it names. A circle or arc stays exact under a uniform
 *   scale and a rotation, and is sampled under any other transform.
 * - TEXT and MTEXT keep their string (MTEXT formatting codes are removed), height, rotation and anchor.
 * Entities on a layer that is off or frozen are not drawn. The extents are those of the geometry, not the header's.
 *
 * A drawing is expanded under limits (nesting depth, strokes) so that a block that inserts itself, or a pyramid of
 * blocks, fails closed instead of exhausting memory.
 */

export type Point = readonly [number, number];

export type DxfStroke =
  | { kind: 'line'; a: Point; b: Point }
  | { kind: 'poly'; points: Point[]; closed: boolean }
  | { kind: 'circle'; centre: Point; radius: number }
  /** Counter-clockwise from `start` to `end` in radians, with `end` greater than `start`. */
  | { kind: 'arc'; centre: Point; radius: number; start: number; end: number };

export interface DxfText {
  at: Point;
  height: number;
  /** Counter-clockwise rotation in radians. */
  rotation: number;
  lines: string[];
  anchor: 'start' | 'middle' | 'end';
  /** MTEXT is attached by the top of its first line, TEXT by its baseline. */
  hangsFromTop: boolean;
}

export interface DxfDrawing {
  strokes: DxfStroke[];
  texts: DxfText[];
  extents: { minX: number; minY: number; maxX: number; maxY: number };
}

const MAX_BLOCK_DEPTH = 8;
const MAX_STROKES = 500_000;
/**
 * The budget of one drawing's expansion, shared by every nested INSERT and checked inside the walk: entities visited and
 * block copies made (an empty block in a 1000 x 500 array costs 500,000 visits), points of all strokes, text items and
 * characters. Each is far above what a drawing of a few megabytes holds and far below what exhausts a worker's memory
 * or a job's time.
 */
const MAX_VISITS = 2_000_000;
const MAX_STROKE_POINTS = 3_000_000;
const MAX_TEXTS = 100_000;
const MAX_TEXT_CHARACTERS = 5_000_000;
/** Highest spline degree read: CAD programs draw degrees 1 to 10, DXF writers go to about 25, and the cost of a point grows with its square. */
const MAX_SPLINE_DEGREE = 25;
const DEGREES_PER_TURN = 360;
const MAX_ARC_QUARTERS = 8;
const MAX_SAMPLED_POINTS_PER_CURVE = 20_000;
const SAMPLE_STEP_RADIANS = Math.PI / 180;
const SPLINE_SAMPLES_PER_SPAN = 24;
const FULL_TURN = 2 * Math.PI;
const FULL_TURN_TOLERANCE = 1e-6;
const MTEXT_LINE_PITCH = 5 / 3;
const TEXT_WIDTH_PER_CHARACTER = 0.6;
const DEGREES = Math.PI / 180;
const LAYER_FROZEN_FLAG = 1;
const POLYLINE_CLOSED_FLAG = 1;
const SPLINE_PERIODIC_FLAG = 2;
const SPLINE_FRAME_VERTEX_FLAG = 16;
const NUMBER = (value: string): number => Number.parseFloat(value);

interface Pair {
  code: number;
  value: string;
}

type GroupRecord = Pair[];

interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function compose(outer: Affine, inner: Affine): Affine {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}

const apply = (t: Affine, p: Point): Point => [t.a * p[0] + t.c * p[1] + t.e, t.b * p[0] + t.d * p[1] + t.f];

/** The rotation and uniform scale of a transform that is only that (no mirror, no shear), or null. */
function similarity(t: Affine): { scale: number; rotation: number } | null {
  const scaleX = Math.hypot(t.a, t.b);
  const scaleY = Math.hypot(t.c, t.d);
  const rotation = Math.atan2(t.b, t.a);
  const orthogonal = Math.abs(t.a * t.c + t.b * t.d) <= 1e-9 * scaleX * scaleY;
  const proper = t.a * t.d - t.b * t.c > 0;
  return orthogonal && proper && Math.abs(scaleX - scaleY) <= 1e-9 * Math.max(scaleX, scaleY) ? { scale: scaleX, rotation } : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Group-code stream

function readRecords(text: string): { section: string; records: GroupRecord[] }[] {
  const lines = text.split(/\r?\n/);
  const sections: { section: string; records: GroupRecord[] }[] = [];
  let current: { section: string; records: GroupRecord[] } | null = null;
  let record: GroupRecord | null = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i].trim(), 10);
    if (!Number.isInteger(code)) continue;
    const value = lines[i + 1].trim();
    if (code === 0) {
      if (value === 'SECTION') {
        current = { section: '', records: [] };
        record = null;
      } else if (value === 'ENDSEC') {
        if (current) sections.push(current);
        current = null;
        record = null;
      } else if (current) {
        record = [{ code, value }];
        current.records.push(record);
      }
    } else if (record) {
      record.push({ code, value });
    } else if (current && code === 2 && current.section === '') {
      current.section = value;
    }
  }
  return sections;
}

const first = (record: GroupRecord, code: number): string | undefined => record.find((pair) => pair.code === code)?.value;
/** A group value as a number; a value that is not a finite number is a damaged drawing, never a coordinate. */
function finite(value: string, code: number): number {
  const parsed = NUMBER(value);
  if (!Number.isFinite(parsed)) throw new CadGeometryError(`The DXF holds "${value.slice(0, 24)}" in group ${code}, which is not a finite number`);
  return parsed;
}
const num = (record: GroupRecord, code: number, fallback: number): number => {
  const raw = first(record, code);
  return raw === undefined ? fallback : finite(raw, code);
};
const all = (record: GroupRecord, code: number): number[] => record.filter((pair) => pair.code === code).map((pair) => finite(pair.value, code));
/** An angle in degrees reduced into [0, 360), so arithmetic on it stays exact however large the file states it. */
const turnDegrees = (degrees: number): number => ((degrees % DEGREES_PER_TURN) + DEGREES_PER_TURN) % DEGREES_PER_TURN;
/** The same for an angle in radians. */
const turnRadians = (radians: number): number => ((radians % FULL_TURN) + FULL_TURN) % FULL_TURN;

// ---------------------------------------------------------------------------------------------------------------
// Curves

function sweepOf(start: number, end: number): number {
  const sweep = end - start;
  return sweep > 0 ? sweep : sweep + FULL_TURN;
}

function sampleArc(centre: Point, radius: number, start: number, sweep: number): Point[] {
  const steps = Math.min(MAX_SAMPLED_POINTS_PER_CURVE, Math.max(2, Math.ceil(Math.abs(sweep) / SAMPLE_STEP_RADIANS)));
  return Array.from({ length: steps + 1 }, (_, i) => {
    const angle = start + (sweep * i) / steps;
    return [centre[0] + radius * Math.cos(angle), centre[1] + radius * Math.sin(angle)] as Point;
  });
}

/** The points of a circular arc from `p0` to `p1` with the bulge of a polyline vertex, ends included. */
function bulgeArc(p0: Point, p1: Point, bulge: number): Point[] {
  const chord = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  if (chord === 0 || bulge === 0) return [p0, p1];
  const sweep = 4 * Math.atan(bulge);
  const offset = ((1 - bulge * bulge) / (4 * bulge)) * chord;
  const left: Point = [-(p1[1] - p0[1]) / chord, (p1[0] - p0[0]) / chord];
  const centre: Point = [(p0[0] + p1[0]) / 2 + left[0] * offset, (p0[1] + p1[1]) / 2 + left[1] * offset];
  const radius = Math.hypot(p0[0] - centre[0], p0[1] - centre[1]);
  const arc = sampleArc(centre, radius, Math.atan2(p0[1] - centre[1], p0[0] - centre[0]), sweep);
  arc[0] = p0;
  arc[arc.length - 1] = p1;
  return arc;
}

interface Vertex {
  point: Point;
  bulge: number;
}

function polylinePoints(vertices: Vertex[], closed: boolean, chargePoints: (count: number) => void): Point[] {
  const points: Point[] = [];
  const segments = closed ? vertices.length : vertices.length - 1;
  for (let i = 0; i < segments; i++) {
    const from = vertices[i];
    const to = vertices[(i + 1) % vertices.length];
    const piece = bulgeArc(from.point, to.point, from.bulge);
    // Charged as it is made, so a polyline of thousands of bulged vertices stops at the budget and not after it.
    chargePoints(piece.length);
    for (const point of i === 0 ? piece : piece.slice(1)) points.push(point);
  }
  return points.length > 0 ? points : vertices.map((vertex) => vertex.point);
}

function sampleEllipse(centre: Point, major: Point, ratio: number, start: number, end: number): Point[] {
  const sweep = Math.abs(end - start) < FULL_TURN_TOLERANCE ? FULL_TURN : sweepOf(start, end);
  const steps = Math.min(MAX_SAMPLED_POINTS_PER_CURVE, Math.max(8, Math.ceil(sweep / SAMPLE_STEP_RADIANS)));
  const a = Math.hypot(major[0], major[1]);
  const rotation = Math.atan2(major[1], major[0]);
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = start + (sweep * i) / steps;
    const x = a * Math.cos(t);
    const y = a * ratio * Math.sin(t);
    return [centre[0] + x * Math.cos(rotation) - y * Math.sin(rotation), centre[1] + x * Math.sin(rotation) + y * Math.cos(rotation)] as Point;
  });
}

/** Index of the knot span of `t`: the largest k in [degree, count - 1] with knots[k] <= t, taking the last span at the end. */
function knotSpan(knots: number[], degree: number, count: number, t: number): number {
  if (t >= knots[count]) return count - 1;
  let k = degree;
  while (k < count - 1 && t >= knots[k + 1]) k++;
  return k;
}

/** A point of a NURBS curve (The NURBS Book, A4.1 over the basis of A2.2). */
function nurbsPoint(degree: number, knots: number[], control: Point[], weights: number[], t: number): Point {
  const span = knotSpan(knots, degree, control.length, t);
  const basis = new Array<number>(degree + 1).fill(0);
  const left = new Array<number>(degree + 1).fill(0);
  const right = new Array<number>(degree + 1).fill(0);
  basis[0] = 1;
  for (let j = 1; j <= degree; j++) {
    left[j] = t - knots[span + 1 - j];
    right[j] = knots[span + j] - t;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const denominator = right[r + 1] + left[j - r];
      const term = denominator === 0 ? 0 : basis[r] / denominator;
      basis[r] = saved + right[r + 1] * term;
      saved = left[j - r] * term;
    }
    basis[j] = saved;
  }
  let x = 0;
  let y = 0;
  let w = 0;
  for (let j = 0; j <= degree; j++) {
    const index = span - degree + j;
    const weighted = basis[j] * weights[index];
    x += weighted * control[index][0];
    y += weighted * control[index][1];
    w += weighted;
  }
  return w === 0 ? control[span] : [x / w, y / w];
}

function sampleSpline(record: GroupRecord): Point[] {
  const degree = Math.trunc(num(record, 71, 3));
  if (degree < 1 || degree > MAX_SPLINE_DEGREE) throw new CadGeometryError(`The DXF has a SPLINE of degree ${degree}; degrees 1 to ${MAX_SPLINE_DEGREE} are read`);
  const knots = all(record, 40);
  const xs = all(record, 10);
  const ys = all(record, 20);
  const control: Point[] = xs.map((x, i) => [x, ys[i] ?? 0] as Point);
  const fitX = all(record, 11);
  const fitY = all(record, 21);
  const fit: Point[] = fitX.map((x, i) => [x, fitY[i] ?? 0] as Point);
  if (control.length === 0) return fit;
  if (control.length <= degree) throw new CadGeometryError(`The DXF has a SPLINE of degree ${degree} with ${control.length} control points, which needs at least ${degree + 1}`);
  if (knots.length !== control.length + degree + 1) throw new CadGeometryError(`The DXF has a SPLINE with ${knots.length} knots, but ${control.length} control points of degree ${degree} need ${control.length + degree + 1}`);
  for (let i = 1; i < knots.length; i++) {
    if (knots[i] < knots[i - 1]) throw new CadGeometryError('The DXF has a SPLINE whose knots decrease');
  }
  if (!(knots[control.length] > knots[degree])) throw new CadGeometryError('The DXF has a SPLINE with an empty parameter range');
  const stated = all(record, 41);
  const weights = control.map((_, i) => (stated.length === control.length && stated[i] > 0 ? stated[i] : 1));
  const spans = control.length - degree;
  const steps = Math.min(MAX_SAMPLED_POINTS_PER_CURVE, spans * SPLINE_SAMPLES_PER_SPAN);
  const from = knots[degree];
  const to = knots[control.length];
  return Array.from({ length: steps + 1 }, (_, i) => nurbsPoint(degree, knots, control, weights, from + ((to - from) * i) / steps));
}

// ---------------------------------------------------------------------------------------------------------------
// Entities

interface Block {
  base: Point;
  records: GroupRecord[];
}

interface Layers {
  hidden: ReadonlySet<string>;
}

function readLayers(sections: { section: string; records: GroupRecord[] }[]): Layers {
  const hidden = new Set<string>();
  for (const section of sections) {
    if (section.section !== 'TABLES') continue;
    for (const record of section.records) {
      if (record[0].value !== 'LAYER') continue;
      const name = first(record, 2);
      if (name === undefined) continue;
      const frozen = (Math.trunc(num(record, 70, 0)) & LAYER_FROZEN_FLAG) !== 0;
      if (frozen || num(record, 62, 1) < 0) hidden.add(name);
    }
  }
  return { hidden };
}

/** A POLYLINE record is followed by its VERTEX records and SEQEND; they are read as one entity. */
function groupPolylines(records: GroupRecord[]): Array<{ record: GroupRecord; vertices: GroupRecord[] }> {
  const entities: Array<{ record: GroupRecord; vertices: GroupRecord[] }> = [];
  let open: { record: GroupRecord; vertices: GroupRecord[] } | null = null;
  for (const record of records) {
    const type = record[0].value;
    if (type === 'POLYLINE') {
      open = { record, vertices: [] };
      entities.push(open);
    } else if (type === 'VERTEX' && open) {
      open.vertices.push(record);
    } else if (type === 'SEQEND') {
      open = null;
    } else {
      open = null;
      entities.push({ record, vertices: [] });
    }
  }
  return entities;
}

function stripMtext(raw: string): string[] {
  const text = raw
    .replace(/\\P/g, '\n')
    .replace(/\\~/g, ' ')
    .replace(/\\S([^;^/#]*)[\^/#]([^;]*);/g, '$1/$2')
    .replace(/\\[ACFHQTWfcw][^;]*;/g, '')
    .replace(/\\[LlOoKk]/g, '')
    .replace(/[{}]/g, '')
    .replace(/\\\\/g, '\\');
  return text.split('\n').map((line) => line.trimEnd());
}

/** Share of the text width that lies left of the anchor point. */
const ANCHOR_SHARE: Readonly<Record<DxfText['anchor'], number>> = { start: 0, middle: 0.5, end: 1 };
const TEXT_ANCHORS: Readonly<Record<number, DxfText['anchor']>> = { 1: 'middle', 2: 'end', 4: 'middle' };
const MTEXT_ANCHORS: Readonly<Record<number, DxfText['anchor']>> = { 1: 'start', 2: 'middle', 3: 'end', 4: 'start', 5: 'middle', 6: 'end', 7: 'start', 8: 'middle', 9: 'end' };

class Builder {
  readonly strokes: DxfStroke[] = [];
  readonly texts: DxfText[] = [];
  private visits = 0;
  private strokePoints = 0;
  private textCharacters = 0;

  constructor(
    private readonly blocks: ReadonlyMap<string, Block>,
    private readonly layers: Layers
  ) {}

  /** Entities visited and block copies made, across every nested INSERT. */
  private charge(count: number): void {
    this.visits += count;
    if (this.visits > MAX_VISITS) throw new CadExpansionLimitError(`The DXF expands to more than ${MAX_VISITS} entities and block copies (blocks inserted into blocks or arrays of them), which is over the limit`);
  }

  private chargePoints(count: number): void {
    this.strokePoints += count;
    if (this.strokePoints > MAX_STROKE_POINTS) throw new CadExpansionLimitError(`The DXF expands to more than ${MAX_STROKE_POINTS} stroke points, which is over the limit`);
  }

  private add(stroke: DxfStroke): void {
    if (this.strokes.length >= MAX_STROKES) throw new CadExpansionLimitError(`The DXF expands to more than ${MAX_STROKES} strokes (blocks inserted into blocks), which is over the limit`);
    this.chargePoints(stroke.kind === 'poly' ? stroke.points.length : 2);
    this.strokes.push(stroke);
  }

  private curve(points: Point[], closed: boolean, t: Affine): void {
    if (points.length < 2) return;
    this.add({ kind: 'poly', points: points.map((p) => apply(t, p)), closed });
  }

  entities(records: GroupRecord[], t: Affine, depth: number): void {
    for (const { record, vertices } of groupPolylines(records)) {
      this.charge(1);
      this.entity(record, vertices, t, depth);
    }
  }

  private entity(record: GroupRecord, vertices: GroupRecord[], t: Affine, depth: number): void {
    const type = record[0].value;
    if (this.layers.hidden.has(first(record, 8) ?? '0')) return;
    const at: Point = [num(record, 10, 0), num(record, 20, 0)];
    const similar = similarity(t);
    switch (type) {
      case 'LINE':
        this.add({ kind: 'line', a: apply(t, at), b: apply(t, [num(record, 11, 0), num(record, 21, 0)]) });
        return;
      case 'CIRCLE': {
        const radius = num(record, 40, 0);
        if (!(radius > 0)) return;
        if (similar) this.add({ kind: 'circle', centre: apply(t, at), radius: radius * similar.scale });
        else this.curve(sampleArc(at, radius, 0, FULL_TURN), true, t);
        return;
      }
      case 'ARC': {
        const radius = num(record, 40, 0);
        if (!(radius > 0)) return;
        const start = turnDegrees(num(record, 50, 0)) * DEGREES;
        const sweep = sweepOf(start, turnDegrees(num(record, 51, DEGREES_PER_TURN)) * DEGREES);
        if (similar) this.add({ kind: 'arc', centre: apply(t, at), radius: radius * similar.scale, start: start + similar.rotation, end: start + similar.rotation + sweep });
        else this.curve(sampleArc(at, radius, start, sweep), false, t);
        return;
      }
      case 'LWPOLYLINE': {
        const list: Vertex[] = [];
        for (const pair of record) {
          if (pair.code === 10) list.push({ point: [finite(pair.value, 10), 0], bulge: 0 });
          else if (pair.code === 20 && list.length > 0) list[list.length - 1].point = [list[list.length - 1].point[0], finite(pair.value, 20)];
          else if (pair.code === 42 && list.length > 0) list[list.length - 1].bulge = finite(pair.value, 42);
        }
        const closed = (Math.trunc(num(record, 70, 0)) & POLYLINE_CLOSED_FLAG) !== 0;
        if (list.length > 1) this.curve(polylinePoints(list, closed, (count) => this.chargePoints(count)), closed, t);
        return;
      }
      case 'POLYLINE': {
        const list: Vertex[] = vertices
          .filter((vertex) => (Math.trunc(num(vertex, 70, 0)) & SPLINE_FRAME_VERTEX_FLAG) === 0)
          .map((vertex) => ({ point: [num(vertex, 10, 0), num(vertex, 20, 0)] as Point, bulge: num(vertex, 42, 0) }));
        const closed = (Math.trunc(num(record, 70, 0)) & POLYLINE_CLOSED_FLAG) !== 0;
        if (list.length > 1) this.curve(polylinePoints(list, closed, (count) => this.chargePoints(count)), closed, t);
        return;
      }
      case 'ELLIPSE': {
        const ratio = num(record, 40, 1);
        const major: Point = [num(record, 11, 0), num(record, 21, 0)];
        if (!(ratio > 0) || (major[0] === 0 && major[1] === 0)) return;
        this.curve(sampleEllipse(at, major, ratio, turnRadians(num(record, 41, 0)), turnRadians(num(record, 42, FULL_TURN))), false, t);
        return;
      }
      case 'SPLINE': {
        const periodic = (Math.trunc(num(record, 70, 0)) & SPLINE_PERIODIC_FLAG) !== 0;
        const points = sampleSpline(record);
        this.curve(points, periodic && points.length > 2 && Math.hypot(points[0][0] - points[points.length - 1][0], points[0][1] - points[points.length - 1][1]) < 1e-9, t);
        return;
      }
      case 'INSERT':
        this.insert(record, at, t, depth);
        return;
      case 'DIMENSION': {
        const name = first(record, 2);
        const block = name === undefined ? undefined : this.blocks.get(name);
        if (block && depth < MAX_BLOCK_DEPTH) this.entities(block.records, compose(t, { ...IDENTITY, e: -block.base[0], f: -block.base[1] }), depth + 1);
        return;
      }
      case 'TEXT':
        this.text(record, t);
        return;
      case 'MTEXT':
        this.mtext(record, at, t);
        return;
      default:
    }
  }

  private insert(record: GroupRecord, at: Point, t: Affine, depth: number): void {
    const name = first(record, 2);
    const block = name === undefined ? undefined : this.blocks.get(name);
    if (!block) return;
    if (depth >= MAX_BLOCK_DEPTH) throw new CadExpansionLimitError(`The DXF nests blocks deeper than ${MAX_BLOCK_DEPTH} levels (block ${name})`);
    const scaleX = num(record, 41, 1);
    const scaleY = num(record, 42, 1);
    const rotation = turnDegrees(num(record, 50, 0)) * DEGREES;
    const columns = Math.max(1, Math.trunc(num(record, 70, 1)));
    const rows = Math.max(1, Math.trunc(num(record, 71, 1)));
    const columnSpacing = num(record, 44, 0);
    const rowSpacing = num(record, 45, 0);
    // Every copy is a visit, drawn or not: an array of an empty block costs what it walks.
    this.charge(columns * rows);
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const offsetX = column * columnSpacing;
        const offsetY = row * rowSpacing;
        // x' = at + R * (offset + S * (p - base)); the offset of an array cell is rotated with the block.
        const place: Affine = {
          a: cos * scaleX,
          b: sin * scaleX,
          c: -sin * scaleY,
          d: cos * scaleY,
          e: at[0] + cos * offsetX - sin * offsetY - (cos * scaleX * block.base[0] - sin * scaleY * block.base[1]),
          f: at[1] + sin * offsetX + cos * offsetY - (sin * scaleX * block.base[0] + cos * scaleY * block.base[1]),
        };
        this.entities(block.records, compose(t, place), depth + 1);
      }
    }
  }

  private text(record: GroupRecord, t: Affine): void {
    const value = first(record, 1);
    const height = num(record, 40, 0);
    if (value === undefined || value.trim() === '' || !(height > 0)) return;
    const horizontal = Math.trunc(num(record, 72, 0));
    const aligned = (horizontal !== 0 || Math.trunc(num(record, 73, 0)) !== 0) && first(record, 11) !== undefined;
    const origin: Point = aligned ? [num(record, 11, 0), num(record, 21, 0)] : [num(record, 10, 0), num(record, 20, 0)];
    this.place({ at: origin, height, rotation: turnDegrees(num(record, 50, 0)) * DEGREES, lines: [value], anchor: TEXT_ANCHORS[horizontal] ?? 'start', hangsFromTop: false }, t);
  }

  private mtext(record: GroupRecord, at: Point, t: Affine): void {
    const height = num(record, 40, 0);
    const raw = `${record.filter((pair) => pair.code === 3).map((pair) => pair.value).join('')}${first(record, 1) ?? ''}`;
    if (!(height > 0) || raw.trim() === '') return;
    const direction = first(record, 11) === undefined ? turnDegrees(num(record, 50, 0)) * DEGREES : Math.atan2(num(record, 21, 0), num(record, 11, 1));
    this.place({ at, height, rotation: direction, lines: stripMtext(raw), anchor: MTEXT_ANCHORS[Math.trunc(num(record, 71, 1))] ?? 'start', hangsFromTop: true }, t);
  }

  private place(text: DxfText, t: Affine): void {
    this.textCharacters += text.lines.reduce((sum, line) => sum + line.length, 0);
    if (this.texts.length >= MAX_TEXTS || this.textCharacters > MAX_TEXT_CHARACTERS) {
      throw new CadExpansionLimitError(`The DXF expands to more than ${MAX_TEXTS} text items or ${MAX_TEXT_CHARACTERS} characters of text, which is over the limit`);
    }
    const similar = similarity(t);
    const scale = similar ? similar.scale : Math.hypot(t.c, t.d);
    this.texts.push({ ...text, at: apply(t, text.at), height: text.height * scale, rotation: text.rotation + (similar ? similar.rotation : Math.atan2(t.b, t.a)) });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Extents

function textBox(text: DxfText): Point[] {
  const longest = text.lines.reduce((most, line) => Math.max(most, line.length), 0);
  const width = longest * text.height * TEXT_WIDTH_PER_CHARACTER;
  const heightTotal = text.height * (1 + (text.lines.length - 1) * MTEXT_LINE_PITCH);
  const left = -width * ANCHOR_SHARE[text.anchor];
  const top = text.hangsFromTop ? 0 : text.height;
  const corners: Point[] = [[left, top], [left + width, top], [left, top - heightTotal], [left + width, top - heightTotal]];
  const cos = Math.cos(text.rotation);
  const sin = Math.sin(text.rotation);
  return corners.map(([x, y]) => [text.at[0] + x * cos - y * sin, text.at[1] + x * sin + y * cos] as Point);
}

function strokePoints(stroke: DxfStroke): Point[] {
  switch (stroke.kind) {
    case 'line':
      return [stroke.a, stroke.b];
    case 'poly':
      return stroke.points;
    case 'circle':
      return [[stroke.centre[0] - stroke.radius, stroke.centre[1] - stroke.radius], [stroke.centre[0] + stroke.radius, stroke.centre[1] + stroke.radius]];
    case 'arc': {
      const at = (angle: number): Point => [stroke.centre[0] + stroke.radius * Math.cos(angle), stroke.centre[1] + stroke.radius * Math.sin(angle)];
      const points = [at(stroke.start), at(stroke.end)];
      // The axis extremes the arc passes through.
      // The angles are reduced into a turn when read (and by a similarity's rotation of at most a half turn), so the arc
      // crosses a handful of quarter turns; the bound makes that a fact of the loop and not of its input.
      const firstQuarter = Math.ceil(stroke.start / (Math.PI / 2));
      for (let quarter = firstQuarter; quarter <= firstQuarter + MAX_ARC_QUARTERS && quarter * (Math.PI / 2) <= stroke.end; quarter++) points.push(at(quarter * (Math.PI / 2)));
      return points;
    }
  }
}

function extentsOf(strokes: DxfStroke[], texts: DxfText[]): DxfDrawing['extents'] {
  const points = [...strokes.flatMap(strokePoints), ...texts.flatMap(textBox)];
  if (points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) {
    throw new CadGeometryError('The DXF has coordinates that overflow once its blocks and scales are applied, so it has no drawable extent');
  }
  if (points.length === 0) throw new ConversionFailedError('The DXF holds no drawable entities (LINE, CIRCLE, ARC, polyline, ELLIPSE, SPLINE, INSERT or text on a visible layer)');
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(maxX - minX) || !Number.isFinite(maxY - minY)) throw new CadGeometryError('The DXF is so large that its extent overflows');
  return { minX, minY, maxX, maxY };
}

/** Reads the drawing of a DXF text, expanded to strokes and texts with their extents. */
export function parseDxfDrawing(dxf: string): DxfDrawing {
  const sections = readRecords(dxf);
  const blocks = new Map<string, Block>();
  for (const section of sections) {
    if (section.section !== 'BLOCKS') continue;
    let current: { name: string; block: Block } | null = null;
    for (const record of section.records) {
      const type = record[0].value;
      if (type === 'BLOCK') {
        const name = first(record, 2);
        current = name === undefined ? null : { name, block: { base: [num(record, 10, 0), num(record, 20, 0)], records: [] } };
      } else if (type === 'ENDBLK') {
        if (current) blocks.set(current.name, current.block);
        current = null;
      } else if (current) {
        current.block.records.push(record);
      }
    }
  }
  const builder = new Builder(blocks, readLayers(sections));
  for (const section of sections) {
    if (section.section === 'ENTITIES') builder.entities(section.records, IDENTITY, 0);
  }
  return { strokes: builder.strokes, texts: builder.texts, extents: extentsOf(builder.strokes, builder.texts) };
}

// ---------------------------------------------------------------------------------------------------------------
// Output

const STROKE_COLOUR = '#5C6BC0';
const TEXT_COLOUR = '#1F2340';
const MARGIN_SHARE = 0.02;
const STROKE_SHARE = 0.005;
const SVG_LONG_SIDE_PX = 288;
const PDF_LONG_SIDE_PT = 576;
const PDF_STROKE_PT = 0.75;
const FONT_FAMILY = 'system-ui, sans-serif';
const ELEMENT_SEPARATOR = '\n    ';

const fmt = (value: number): string => String(Number(value.toPrecision(9)));
const escapeXml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A sine or cosine without the rounding noise of a quarter turn (6e-17 for 90 degrees). */
const trig = (value: number): number => (Math.abs(value) < 1e-12 ? 0 : value);

/** An SVG path of an arc stroke through `map`, which carries drawing units to the output; `scale` is the length ratio. */
function arcPath(stroke: Extract<DxfStroke, { kind: 'arc' }>, map: (p: Point) => Point, scale: number): string {
  const at = (angle: number): Point => [stroke.centre[0] + stroke.radius * trig(Math.cos(angle)), stroke.centre[1] + stroke.radius * trig(Math.sin(angle))];
  const from = map(at(stroke.start));
  const to = map(at(stroke.end));
  const large = stroke.end - stroke.start > Math.PI ? 1 : 0;
  const r = fmt(stroke.radius * scale);
  // Counter-clockwise in a y-up drawing is counter-clockwise on the page, which SVG's sweep flag 0 means.
  return `M ${fmt(from[0])} ${fmt(from[1])} A ${r} ${r} 0 ${large} 0 ${fmt(to[0])} ${fmt(to[1])}`;
}

function extentSizes(extents: DxfDrawing['extents']): { width: number; height: number; longest: number } {
  const width = extents.maxX - extents.minX;
  const height = extents.maxY - extents.minY;
  return { width, height, longest: Math.max(width, height, Number.MIN_VALUE) };
}

function textElements(texts: DxfText[], map: (p: Point) => Point): string[] {
  return texts.flatMap((text) => {
    const anchor = text.anchor === 'start' ? '' : ` text-anchor="${text.anchor}"`;
    const [x, y] = map(text.at);
    const lines = text.lines.map((line, index) => {
      const drop = (text.hangsFromTop ? 1 : 0) * text.height + index * text.height * MTEXT_LINE_PITCH;
      return { line, drop };
    });
    return lines.map(({ line, drop }) => {
      const cos = Math.cos(text.rotation);
      const sin = Math.sin(text.rotation);
      // The drop runs down the rotated text, which is (sin, cos) in y-up units and (sin, -cos) after the page's y flip.
      const px = x + drop * sin;
      const py = y + drop * cos;
      const rotate = text.rotation === 0 ? '' : ` transform="rotate(${fmt(-text.rotation / DEGREES)} ${fmt(px)} ${fmt(py)})"`;
      return `<text x="${fmt(px)}" y="${fmt(py)}" fill="${TEXT_COLOUR}" font-family="${FONT_FAMILY}" font-size="${fmt(text.height)}"${anchor}${rotate}>${escapeXml(line)}</text>`;
    });
  });
}

/** The drawing as a resolution-independent SVG: y is negated so the drawing is upright, the view box is the extents and a margin. */
export function dxfDrawingToSvg(drawing: DxfDrawing, title: string): string {
  const { extents } = drawing;
  const { width, height, longest } = extentSizes(extents);
  const margin = longest * MARGIN_SHARE;
  const strokeWidth = longest * STROKE_SHARE;
  const flip = (p: Point): Point => [p[0], -p[1]];
  const elements = drawing.strokes.map((stroke) => {
    switch (stroke.kind) {
      case 'line':
        return `<line x1="${fmt(stroke.a[0])}" y1="${fmt(-stroke.a[1])}" x2="${fmt(stroke.b[0])}" y2="${fmt(-stroke.b[1])}" />`;
      case 'circle':
        return `<circle cx="${fmt(stroke.centre[0])}" cy="${fmt(-stroke.centre[1])}" r="${fmt(stroke.radius)}" />`;
      case 'arc':
        return `<path d="${arcPath(stroke, flip, 1)}" />`;
      case 'poly':
        return `<${stroke.closed ? 'polygon' : 'polyline'} points="${stroke.points.map((p) => `${fmt(p[0])},${fmt(-p[1])}`).join(' ')}" />`;
    }
  });
  const viewWidth = width + 2 * margin;
  const viewHeight = height + 2 * margin;
  const pixelScale = SVG_LONG_SIDE_PX / Math.max(viewWidth, viewHeight);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmt(extents.minX - margin)} ${fmt(-extents.maxY - margin)} ${fmt(viewWidth)} ${fmt(viewHeight)}" width="${fmt(viewWidth * pixelScale)}" height="${fmt(viewHeight * pixelScale)}">
  <title>${escapeXml(title)}</title>
  <g fill="none" stroke="${STROKE_COLOUR}" stroke-width="${fmt(strokeWidth)}" stroke-linecap="round" stroke-linejoin="round">
    ${elements.join(ELEMENT_SEPARATOR)}
  </g>
  <g>
    ${textElements(drawing.texts, flip).join(ELEMENT_SEPARATOR)}
  </g>
</svg>`;
}

/** The drawing as one vector PDF page the size of its extents and a margin: no title, no frame, real text. */
export async function renderDxfDrawingToPdf(drawing: DxfDrawing): Promise<Buffer> {
  const { extents } = drawing;
  const { width, height, longest } = extentSizes(extents);
  const scale = PDF_LONG_SIDE_PT / longest;
  const margin = PDF_LONG_SIDE_PT * MARGIN_SHARE;
  const page: [number, number] = [width * scale + 2 * margin, height * scale + 2 * margin];
  const map = (p: Point): Point => [margin + (p[0] - extents.minX) * scale, margin + (extents.maxY - p[1]) * scale];
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: page, margin: 0 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const fontFallback = configurePdfKitFontFallback(doc);
    doc.strokeColor(STROKE_COLOUR).lineWidth(PDF_STROKE_PT).lineCap('round').lineJoin('round');
    for (const stroke of drawing.strokes) {
      switch (stroke.kind) {
        case 'line': {
          const [a, b] = [map(stroke.a), map(stroke.b)];
          doc.moveTo(a[0], a[1]).lineTo(b[0], b[1]).stroke();
          break;
        }
        case 'circle': {
          const c = map(stroke.centre);
          doc.circle(c[0], c[1], stroke.radius * scale).stroke();
          break;
        }
        case 'arc':
          doc.path(arcPath(stroke, map, scale)).stroke();
          break;
        case 'poly': {
          const points = stroke.points.map(map);
          doc.moveTo(points[0][0], points[0][1]);
          for (const point of points.slice(1)) doc.lineTo(point[0], point[1]);
          if (stroke.closed) doc.closePath();
          doc.stroke();
          break;
        }
      }
    }
    for (const text of drawing.texts) {
      const [x, y] = map(text.at);
      const size = text.height * scale;
      text.lines.forEach((line, index) => {
        const drop = ((text.hangsFromTop ? 1 : 0) * text.height + index * text.height * MTEXT_LINE_PITCH) * scale;
        doc.save();
        doc.translate(x + drop * Math.sin(text.rotation), y + drop * Math.cos(text.rotation));
        doc.rotate(-text.rotation / DEGREES);
        doc.fillColor(TEXT_COLOUR).fontSize(size);
        const shift = line === '' ? 0 : ANCHOR_SHARE[text.anchor] * doc.widthOfString(line);
        renderSafePdfText(doc, line, fontFallback.hasUnicodeFont, { lineBreak: false, baseline: 'alphabetic' }, -shift, 0);
        doc.restore();
      });
    }
    doc.end();
  });
}
