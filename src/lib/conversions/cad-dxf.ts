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
  widthFactor?: number;
  fitLength?: number;
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
const SAMPLE_STEP_RADIANS = Math.PI / 90;
const SPLINE_SAMPLES_PER_SPAN = 16;
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

/** The pairs of one entity (or table entry, or block header) as parallel arrays: group codes and their values. */
interface GroupRecord {
  codes: number[];
  values: string[];
}

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
const IDENTITY_SIMILARITY = { scale: 1, rotation: 0 };

function similarity(t: Affine): { scale: number; rotation: number } | null {
  if (t === IDENTITY) return IDENTITY_SIMILARITY;
  const scaleX = Math.hypot(t.a, t.b);
  const scaleY = Math.hypot(t.c, t.d);
  const rotation = Math.atan2(t.b, t.a);
  const orthogonal = Math.abs(t.a * t.c + t.b * t.d) <= 1e-9 * scaleX * scaleY;
  const proper = t.a * t.d - t.b * t.c > 0;
  return orthogonal && proper && Math.abs(scaleX - scaleY) <= 1e-9 * Math.max(scaleX, scaleY) ? { scale: scaleX, rotation } : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Group-code stream

const CHAR_NEWLINE = 10;
const CHAR_ZERO = 48;
const CHAR_NINE = 57;
const CHAR_SPACE_LIMIT = 32;
const CHAR_ASCII_LIMIT = 127;
const MAX_CODE_DIGITS = 4;

/** One line of the stream without its surrounding white space (what `String.prototype.trim` removes), as a slice of `text`. */
function trimmedSlice(text: string, from: number, to: number): string {
  let start = from;
  let end = to;
  while (start < end && text.charCodeAt(start) <= CHAR_SPACE_LIMIT) start++;
  while (end > start && text.charCodeAt(end - 1) <= CHAR_SPACE_LIMIT) end--;
  const slice = text.substring(start, end);
  // Characters beyond ASCII that trim also removes (no-break space, byte-order mark, line separators) are rare: the check is two reads.
  return slice.length > 0 && (slice.charCodeAt(0) > CHAR_ASCII_LIMIT || slice.charCodeAt(slice.length - 1) > CHAR_ASCII_LIMIT) ? slice.trim() : slice;
}

/** The group code of a line: a plain run of digits is read directly, anything else as `parseInt` reads it. */
function groupCode(line: string): number {
  const length = line.length;
  if (length > 0 && length <= MAX_CODE_DIGITS) {
    let value = 0;
    for (let i = 0; i < length; i++) {
      const digit = line.charCodeAt(i) - CHAR_ZERO;
      if (digit < 0 || digit > CHAR_NINE - CHAR_ZERO) return Number.parseInt(line, 10);
      value = value * 10 + digit;
    }
    return value;
  }
  return Number.parseInt(line, 10);
}

/**
 * The group-code stream as sections of records. Lines are split at "\n" (a "\r" before it is white space), a code line and a
 * value line make a pair, a code that is not an integer drops its pair, and an unpaired last line is ignored.
 */
function readRecords(text: string): { section: string; records: GroupRecord[] }[] {
  const sections: { section: string; records: GroupRecord[] }[] = [];
  let current: { section: string; records: GroupRecord[] } | null = null;
  let record: GroupRecord | null = null;
  let at = 0;
  const length = text.length;
  while (at < length) {
    const codeEnd = text.indexOf('\n', at);
    if (codeEnd < 0) break;
    const code = groupCode(trimmedSlice(text, at, codeEnd));
    const valueStart = codeEnd + 1;
    let valueEnd = text.indexOf('\n', valueStart);
    // The last line of the file has no newline after it.
    if (valueEnd < 0) valueEnd = length;
    at = valueEnd + 1;
    if (!Number.isInteger(code)) continue;
    const value = trimmedSlice(text, valueStart, valueEnd);
    if (code === 0) {
      if (value === 'SECTION') {
        current = { section: '', records: [] };
        record = null;
      } else if (value === 'ENDSEC') {
        if (current) sections.push(current);
        current = null;
        record = null;
      } else if (current) {
        record = { codes: [code], values: [value] };
        current.records.push(record);
      }
    } else if (record) {
      record.codes.push(code);
      record.values.push(value);
    } else if (current && code === 2 && current.section === '') {
      current.section = value;
    }
  }
  return sections;
}

const first = (record: GroupRecord, code: number): string | undefined => {
  const at = record.codes.indexOf(code);
  return at < 0 ? undefined : record.values[at];
};
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
const all = (record: GroupRecord, code: number): number[] => {
  const found: number[] = [];
  for (let i = 0; i < record.codes.length; i++) if (record.codes[i] === code) found.push(finite(record.values[i], code));
  return found;
};
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
  const points: Point[] = new Array<Point>(steps + 1);
  for (let i = 0; i <= steps; i++) {
    const angle = start + (sweep * i) / steps;
    points[i] = [centre[0] + radius * Math.cos(angle), centre[1] + radius * Math.sin(angle)];
  }
  return points;
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
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const points: Point[] = new Array<Point>(steps + 1);
  for (let i = 0; i <= steps; i++) {
    const t = start + (sweep * i) / steps;
    const x = a * Math.cos(t);
    const y = a * ratio * Math.sin(t);
    points[i] = [centre[0] + x * cos - y * sin, centre[1] + x * sin + y * cos];
  }
  return points;
}

/** Index of the knot span of `t`: the largest k in [degree, count - 1] (or [0, count - 1] for an unclamped knot vector) with knots[k] <= t. */
function knotSpan(knots: number[], degree: number, count: number, t: number): number {
  if (t >= knots[count]) return count - 1;
  if (knots[degree] > knots[0]) {
    let k = 0;
    while (k < count && knots[k] <= t) k++;
    return Math.max(0, k - 1);
  }
  let k = degree;
  while (k < count - 1 && t >= knots[k + 1]) k++;
  return k;
}

/** A point of a NURBS curve (The NURBS Book, A4.1 over the basis of A2.2). */
function nurbsPoint(degree: number, knots: number[], control: Point[], weights: number[], t: number, basis: Float64Array, left: Float64Array, right: Float64Array): Point {
  const span = knotSpan(knots, degree, control.length, t);
  // The three work arrays are reused between points: the recurrence writes every value it later reads.
  basis[0] = 1;
  for (let j = 1; j <= degree; j++) {
    left[j] = t - knots[Math.max(0, span + 1 - j)];
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
    const index = (span - degree + j + control.length) % control.length;
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
  const from = knots[0];
  const to = knots[knots.length - 1];
  const basis = new Float64Array(degree + 1);
  const left = new Float64Array(degree + 1);
  const right = new Float64Array(degree + 1);
  const points: Point[] = new Array<Point>(steps + 1);
  for (let i = 0; i <= steps; i++) points[i] = nurbsPoint(degree, knots, control, weights, from + ((to - from) * i) / steps, basis, left, right);
  return points;
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
      if (record.values[0] !== 'LAYER') continue;
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
    const type = record.values[0];
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

function decodeSpecialChars(raw: string): string {
  return raw
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/%%[cC]/g, 'Ø');
}

function stripMtext(raw: string): string[] {
  const text = decodeSpecialChars(raw)
    .replace(/\\P/g, '\n')
    .replace(/\\N/g, ' ')
    .replace(/\\~/g, ' ')
    .replace(/\\S([^;^/#]*)[\^/#]([^;]*);/g, '$1/$2')
    .replace(/\\[ACFHQTWfcwp][^;]*;/g, '')
    .replace(/\\[LlOoKk]/g, '')
    .replace(/[{}]/g, '')
    .replace(/\\\\/g, '\\');
  return text.split('\n').map((line) => line.trimEnd());
}

function wrapMtextLines(lines: string[], height: number, boxWidth: number): string[] {
  if (!(boxWidth > 0) || !(height > 0)) return lines;
  const maxChars = Math.max(1, Math.floor(boxWidth / (height * TEXT_WIDTH_PER_CHARACTER)));
  const out: string[] = [];
  for (const line of lines) {
    if (line.length <= maxChars || !line.includes(' ')) {
      out.push(line);
      continue;
    }
    const words = line.split(/\s+/);
    let current = '';
    for (const word of words) {
      if (current === '') current = word;
      else if (current.length + 1 + word.length <= maxChars) current += ` ${word}`;
      else {
        out.push(current);
        current = word;
      }
    }
    if (current !== '') out.push(current);
  }
  return out;
}

const FLIP_X: Affine = { a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 };
/** Share of the text width that lies left of the anchor point. */
const ANCHOR_SHARE: Readonly<Record<DxfText['anchor'], number>> = { start: 0, middle: 0.5, end: 1 };
const TEXT_ANCHORS: Readonly<Record<number, DxfText['anchor']>> = { 1: 'middle', 2: 'end', 3: 'middle', 4: 'middle', 5: 'middle' };
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
    this.add({ kind: 'poly', points: t === IDENTITY ? points : points.map((p) => apply(t, p)), closed });
  }

  entities(records: GroupRecord[], t: Affine, depth: number): void {
    const linkedHandles = new Set<string>();
    for (const record of records) {
      if (record.values[0] !== 'MTEXT') continue;
      for (let i = 0; i < record.codes.length; i++) {
        if (record.codes[i] === 1005) linkedHandles.add(record.values[i]);
      }
    }
    for (const { record, vertices } of groupPolylines(records)) {
      this.charge(1);
      if (record.values[0] === 'MTEXT' && linkedHandles.size > 0) {
        const handle = first(record, 5);
        if (handle !== undefined && linkedHandles.has(handle)) continue;
      }
      this.entity(record, vertices, t, depth);
    }
  }

  private entity(record: GroupRecord, vertices: GroupRecord[], t: Affine, depth: number): void {
    const type = record.values[0];
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
        for (let i = 0; i < record.codes.length; i++) {
          const code = record.codes[i];
          if (code === 10) list.push({ point: [finite(record.values[i], 10), 0], bulge: 0 });
          else if (code === 20 && list.length > 0) list[list.length - 1].point = [list[list.length - 1].point[0], finite(record.values[i], 20)];
          else if (code === 42 && list.length > 0) list[list.length - 1].bulge = finite(record.values[i], 42);
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
    const scaleZ = num(record, 43, 1);
    const rotation = turnDegrees(num(record, 50, 0)) * DEGREES;
    const columns = Math.max(1, Math.trunc(num(record, 70, 1)));
    const rows = Math.max(1, Math.trunc(num(record, 71, 1)));
    const columnSpacing = num(record, 44, 0);
    const rowSpacing = num(record, 45, 0);
    // Every copy is a visit, drawn or not: an array of an empty block costs what it walks.
    this.charge(columns * rows);
    if (scaleX === 0 || scaleY === 0 || scaleZ === 0) return;
    const ocs = num(record, 230, 1) < 0 ? compose(t, FLIP_X) : t;
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
        this.entities(block.records, compose(ocs, place), depth + 1);
      }
    }
  }

  private text(record: GroupRecord, t: Affine): void {
    const raw = first(record, 1);
    const height = num(record, 40, 0);
    if (raw === undefined || raw.trim() === '' || !(height > 0)) return;
    const value = decodeSpecialChars(raw);
    const horizontal = Math.trunc(num(record, 72, 0));
    const vertical = horizontal > 2 ? 0 : Math.trunc(num(record, 73, 0));
    const p1: Point = [num(record, 10, 0), num(record, 20, 0)];
    const hasSecond = first(record, 11) !== undefined;
    const p2: Point = hasSecond ? [num(record, 11, p1[0]), num(record, 21, p1[1])] : p1;
    const widthFactor = num(record, 41, 1);
    if ((horizontal === 3 || horizontal === 5) && hasSecond) {
      const dx = p2[0] - p1[0];
      const dy = p2[1] - p1[1];
      const spanLength = Math.hypot(dx, dy);
      const origin: Point = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
      const rotation = turnDegrees(num(record, 50, 0)) * DEGREES;
      const effectiveHeight =
        spanLength > 0
          ? Math.min(height, spanLength / Math.max(1, value.length * TEXT_WIDTH_PER_CHARACTER))
          : height;
      this.place(
        {
          at: origin,
          height: effectiveHeight,
          rotation,
          lines: [value],
          anchor: 'middle',
          hangsFromTop: false,
          ...(widthFactor !== 1 ? { widthFactor } : {}),
          ...(spanLength > 0 ? { fitLength: spanLength } : {}),
        },
        t
      );
      return;
    }
    const aligned = (horizontal !== 0 || vertical !== 0) && hasSecond;
    const alignPoint: Point = aligned ? p2 : p1;
    const rotation = turnDegrees(num(record, 50, 0)) * DEGREES;
    const baselineOffset =
      vertical === 1 ? height / 3 : vertical === 2 ? -height / 2 : vertical === 3 ? -height : horizontal === 4 ? -height / 3 : 0;
    const origin: Point =
      baselineOffset === 0
        ? alignPoint
        : [alignPoint[0] - baselineOffset * Math.sin(rotation), alignPoint[1] + baselineOffset * Math.cos(rotation)];
    this.place(
      {
        at: origin,
        height,
        rotation,
        lines: [value],
        anchor: TEXT_ANCHORS[horizontal] ?? 'start',
        hangsFromTop: false,
        ...(widthFactor !== 1 ? { widthFactor } : {}),
      },
      t
    );
  }

  private mtext(record: GroupRecord, at: Point, t: Affine): void {
    const height = num(record, 40, 0);
    const raw = `${record.values.filter((_, i) => record.codes[i] === 3).join('')}${first(record, 1) ?? ''}`;
    if (!(height > 0) || raw.trim() === '') return;
    const direction = first(record, 11) === undefined ? turnDegrees(num(record, 50, 0)) * DEGREES : Math.atan2(num(record, 21, 0), num(record, 11, 1));
    const lines = wrapMtextLines(stripMtext(raw), height, num(record, 41, 0));
    this.place({ at, height, rotation: direction, lines, anchor: MTEXT_ANCHORS[Math.trunc(num(record, 71, 1))] ?? 'start', hangsFromTop: true }, t);
  }

  private place(text: DxfText, t: Affine): void {
    this.textCharacters += text.lines.reduce((sum, line) => sum + line.length, 0);
    if (this.texts.length >= MAX_TEXTS || this.textCharacters > MAX_TEXT_CHARACTERS) {
      throw new CadExpansionLimitError(`The DXF expands to more than ${MAX_TEXTS} text items or ${MAX_TEXT_CHARACTERS} characters of text, which is over the limit`);
    }
    const similar = similarity(t);
    const scale = similar ? similar.scale : Math.hypot(t.c, t.d);
    this.texts.push({
      ...text,
      at: apply(t, text.at),
      height: text.height * scale,
      rotation: text.rotation + (similar ? similar.rotation : Math.atan2(t.b, t.a)),
      ...(text.fitLength !== undefined ? { fitLength: text.fitLength * scale } : {}),
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Extents

function textBox(text: DxfText): Point[] {
  const longest = text.lines.reduce((most, line) => Math.max(most, line.length), 0);
  const width = text.fitLength ?? longest * text.height * TEXT_WIDTH_PER_CHARACTER * (text.widthFactor ?? 1);
  const heightTotal = text.height * (1 + (text.lines.length - 1) * MTEXT_LINE_PITCH);
  const left = -width * ANCHOR_SHARE[text.anchor];
  const top = text.hangsFromTop ? 0 : text.height;
  const corners: Point[] = [[left, top], [left + width, top], [left, top - heightTotal], [left + width, top - heightTotal]];
  const cos = Math.cos(text.rotation);
  const sin = Math.sin(text.rotation);
  return corners.map(([x, y]) => [text.at[0] + x * cos - y * sin, text.at[1] + x * sin + y * cos] as Point);
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  finite: boolean;
}

function grow(bounds: Bounds, x: number, y: number): void {
  // NaN and infinities fail the comparisons below and are caught by the finite flag.
  if (!(Number.isFinite(x) && Number.isFinite(y))) bounds.finite = false;
  if (x < bounds.minX) bounds.minX = x;
  if (y < bounds.minY) bounds.minY = y;
  if (x > bounds.maxX) bounds.maxX = x;
  if (y > bounds.maxY) bounds.maxY = y;
}

function growByStroke(bounds: Bounds, stroke: DxfStroke): void {
  switch (stroke.kind) {
    case 'line':
      grow(bounds, stroke.a[0], stroke.a[1]);
      grow(bounds, stroke.b[0], stroke.b[1]);
      return;
    case 'poly':
      for (const point of stroke.points) grow(bounds, point[0], point[1]);
      return;
    case 'circle':
      grow(bounds, stroke.centre[0] - stroke.radius, stroke.centre[1] - stroke.radius);
      grow(bounds, stroke.centre[0] + stroke.radius, stroke.centre[1] + stroke.radius);
      return;
    case 'arc': {
      const at = (angle: number): void => grow(bounds, stroke.centre[0] + stroke.radius * Math.cos(angle), stroke.centre[1] + stroke.radius * Math.sin(angle));
      at(stroke.start);
      at(stroke.end);
      // The axis extremes the arc passes through.
      // The angles are reduced into a turn when read (and by a similarity's rotation of at most a half turn), so the arc
      // crosses a handful of quarter turns; the bound makes that a fact of the loop and not of its input.
      const firstQuarter = Math.ceil(stroke.start / (Math.PI / 2));
      for (let quarter = firstQuarter; quarter <= firstQuarter + MAX_ARC_QUARTERS && quarter * (Math.PI / 2) <= stroke.end; quarter++) at(quarter * (Math.PI / 2));
    }
  }
}

function extentsOf(strokes: DxfStroke[], texts: DxfText[]): DxfDrawing['extents'] {
  const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, finite: true };
  for (const stroke of strokes) growByStroke(bounds, stroke);
  if (strokes.length === 0) {
    for (const text of texts) for (const corner of textBox(text)) grow(bounds, corner[0], corner[1]);
  } else {
    for (const text of texts) for (const [x, y] of textBox(text)) if (!(Number.isFinite(x) && Number.isFinite(y))) bounds.finite = false;
  }
  if (!bounds.finite) {
    throw new CadGeometryError('The DXF has coordinates that overflow once its blocks and scales are applied, so it has no drawable extent');
  }
  if (bounds.minX === Infinity) throw new ConversionFailedError('The DXF holds no drawable entities (LINE, CIRCLE, ARC, polyline, ELLIPSE, SPLINE, INSERT or text on a visible layer)');
  const { minX, minY, maxX, maxY } = bounds;
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
      const type = record.values[0];
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
const SVG_LONG_SIDE_PX = 220;
const PDF_LONG_SIDE_PT = 576;
const PDF_STROKE_PT = 0.75;
const FONT_FAMILY = 'system-ui, sans-serif';
const ELEMENT_SEPARATOR = '\n    ';

/** A number with nine significant digits, for the few values (angles, sizes) whose scale is not that of the drawing. */
const exact = (value: number): string => String(Number(value.toPrecision(9)));

/**
 * Characters XML 1.0 cannot carry in text (controls other than tab, line feed and carriage return, lone surrogates, U+FFFE
 * and U+FFFF): they are left out, so that the document stays well-formed whatever a DXF text holds.
 */
const NEEDS_XML_ESCAPE = /[&<>"\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/;
const XML_ENTITIES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;

function escapeXml(value: string): string {
  if (!NEEDS_XML_ESCAPE.test(value)) return value;
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    const entity = XML_ENTITIES[value[i]];
    if (entity !== undefined) out += entity;
    else if (unit >= HIGH_SURROGATE_MIN && unit <= HIGH_SURROGATE_MAX && i + 1 < value.length && value.charCodeAt(i + 1) >= LOW_SURROGATE_MIN && value.charCodeAt(i + 1) <= LOW_SURROGATE_MAX) {
      out += value[i] + value[i + 1];
      i++;
    } else if (unit < 0x20 && unit !== 0x09 && unit !== 0x0a && unit !== 0x0d) continue;
    else if (unit >= HIGH_SURROGATE_MIN && unit <= LOW_SURROGATE_MAX) continue;
    else if (unit === 0xfffe || unit === 0xffff) continue;
    else out += value[i];
  }
  return out;
}

/** Decimals that resolve a drawing to a ten-millionth of its longest side. */
const DECIMALS_BELOW_LONGEST = 7;
const MAX_DECIMALS = 12;

/**
 * Number writer of one drawing: coordinates are rounded to a fixed number of decimals that follows its size (a
 * ten-millionth of the longest side) and printed in their shortest form, which is several times faster than formatting
 * significant digits and writes fewer characters.
 */
function coordinateWriter(longest: number): (value: number) => string {
  const decimals = Math.min(MAX_DECIMALS, Math.max(0, DECIMALS_BELOW_LONGEST - Math.floor(Math.log10(longest))));
  const scale = 10 ** decimals;
  return (value) => {
    const scaled = Math.round(value * scale);
    // Beyond 2^53 the rounding is the identity, and a scale of 1e12 on a huge value would overflow: print the value itself.
    return String(Number.isFinite(scaled) ? scaled / scale : value);
  };
}

/** A sine or cosine without the rounding noise of a quarter turn (6e-17 for 90 degrees). */
const trig = (value: number): number => (Math.abs(value) < 1e-12 ? 0 : value);

/** An SVG path of an arc stroke through `map`, which carries drawing units to the output; `scale` is the length ratio. */
function arcPath(stroke: Extract<DxfStroke, { kind: 'arc' }>, map: (p: Point) => Point, scale: number, fmt: (value: number) => string): string {
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

/** The view box margin and the declared size of the SVG of a drawing: its long side is `SVG_LONG_SIDE_PX` user units. */
function svgLayout(extents: DxfDrawing['extents']): { margin: number; viewWidth: number; viewHeight: number; pixelWidth: number; pixelHeight: number } {
  const { width, height, longest } = extentSizes(extents);
  const margin = longest * MARGIN_SHARE;
  const viewWidth = width + 2 * margin;
  const viewHeight = height + 2 * margin;
  const pixelScale = SVG_LONG_SIDE_PX / Math.max(viewWidth, viewHeight);
  return { margin, viewWidth, viewHeight, pixelWidth: viewWidth * pixelScale, pixelHeight: viewHeight * pixelScale };
}

/** The width and height `dxfDrawingToSvg` declares for the drawing, in user units (pixels at 72 dpi). */
export function dxfSvgDeclaredSize(drawing: DxfDrawing): { width: number; height: number } {
  const { pixelWidth, pixelHeight } = svgLayout(drawing.extents);
  return { width: Number(exact(pixelWidth)), height: Number(exact(pixelHeight)) };
}

function textElements(texts: DxfText[], extents: DxfDrawing['extents'], clampToExtents: boolean, map: (p: Point) => Point, fmt: (value: number) => string): string[] {
  const elements: string[] = [];
  for (const text of texts) {
    const anchor = text.anchor === 'start' ? '' : ` text-anchor="${text.anchor}"`;
    const [x, y] = map(text.at);
    const cos = Math.cos(text.rotation);
    const sin = Math.sin(text.rotation);
    const longestLine = text.lines.reduce((most, line) => Math.max(most, line.length), 0);
    const effectiveHeight =
      text.fitLength !== undefined && longestLine > 0
        ? Math.min(text.height, text.fitLength / (longestLine * TEXT_WIDTH_PER_CHARACTER))
        : text.height;
    const size = exact(effectiveHeight);
    const share = ANCHOR_SHARE[text.anchor];
    text.lines.forEach((line, index) => {
      const drop = (text.hangsFromTop ? 1 : 0) * effectiveHeight + index * effectiveHeight * MTEXT_LINE_PITCH;
      // The drop runs down the rotated text, which is (sin, cos) in y-up units and (sin, -cos) after the page's y flip.
      const rawX = x + drop * sin;
      const rawY = y + drop * cos;
      const lineWidth = line.length * effectiveHeight * TEXT_WIDTH_PER_CHARACTER;
      const minPx = extents.minX + share * lineWidth;
      const maxPx = Math.max(minPx, extents.maxX - (1 - share) * lineWidth);
      const minPy = -extents.maxY + effectiveHeight;
      const maxPy = Math.max(minPy, -extents.minY);
      const px = clampToExtents ? Math.min(maxPx, Math.max(minPx, rawX)) : rawX;
      const py = clampToExtents ? Math.min(maxPy, Math.max(minPy, rawY)) : rawY;
      const rotate = text.rotation === 0 ? '' : ` transform="rotate(${exact(-text.rotation / DEGREES)} ${fmt(px)} ${fmt(py)})"`;
      elements.push(`<text x="${fmt(px)}" y="${fmt(py)}" fill="${TEXT_COLOUR}" font-family="${FONT_FAMILY}" font-size="${size}"${anchor}${rotate}>${escapeXml(line)}</text>`);
    });
  }
  return elements;
}

/**
 * The drawing as a resolution-independent SVG: y is negated so the drawing is upright, the view box is the extents and a
 * margin. The document is safe by construction: the elements are the fixed set svg, title, g, line, circle, path, polyline,
 * polygon and text, every attribute is a number this function printed or a constant, and the two free texts (the title
 * and the drawing's texts) go through `escapeXml`. It needs no pass through the general SVG sanitizer, which
 * tests/cad-dxf-svg-safe.test.ts checks by feeding hostile drawings to both and requiring the sanitizer to change nothing.
 */
export function dxfDrawingToSvg(drawing: DxfDrawing, title: string): string {
  const { extents } = drawing;
  const { longest } = extentSizes(extents);
  const { margin, viewWidth, viewHeight, pixelWidth, pixelHeight } = svgLayout(extents);
  const strokeWidth = longest * STROKE_SHARE;
  const fmt = coordinateWriter(longest);
  const flip = (p: Point): Point => [p[0], -p[1]];
  const elements: string[] = [];
  for (const stroke of drawing.strokes) {
    switch (stroke.kind) {
      case 'line':
        elements.push(`<line x1="${fmt(stroke.a[0])}" y1="${fmt(-stroke.a[1])}" x2="${fmt(stroke.b[0])}" y2="${fmt(-stroke.b[1])}" />`);
        break;
      case 'circle':
        elements.push(`<circle cx="${fmt(stroke.centre[0])}" cy="${fmt(-stroke.centre[1])}" r="${fmt(stroke.radius)}" />`);
        break;
      case 'arc':
        elements.push(`<path d="${arcPath(stroke, flip, 1, fmt)}" />`);
        break;
      case 'poly': {
        let points = '';
        for (const point of stroke.points) points += `${points === '' ? '' : ' '}${fmt(point[0])},${fmt(-point[1])}`;
        elements.push(`<${stroke.closed ? 'polygon' : 'polyline'} points="${points}" />`);
      }
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${exact(extents.minX - margin)} ${exact(-extents.maxY - margin)} ${exact(viewWidth)} ${exact(viewHeight)}" width="${exact(pixelWidth)}" height="${exact(pixelHeight)}">
  <title>${escapeXml(title)}</title>
  <g fill="none" stroke="${STROKE_COLOUR}" stroke-width="${exact(strokeWidth)}" stroke-linecap="round" stroke-linejoin="round">
    ${elements.join(ELEMENT_SEPARATOR)}
  </g>
  <g>
    ${textElements(drawing.texts, extents, drawing.strokes.length > 0, flip, fmt).join(ELEMENT_SEPARATOR)}
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
  const clampToExtents = drawing.strokes.length > 0;
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
          doc.path(arcPath(stroke, map, scale, exact)).stroke();
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
      const longestLine = text.lines.reduce((most, line) => Math.max(most, line.length), 0);
      const effectiveHeight =
        text.fitLength !== undefined && longestLine > 0
          ? Math.min(text.height, text.fitLength / (longestLine * TEXT_WIDTH_PER_CHARACTER))
          : text.height;
      const size = effectiveHeight * scale;
      text.lines.forEach((line, index) => {
        const drop = ((text.hangsFromTop ? 1 : 0) * effectiveHeight + index * effectiveHeight * MTEXT_LINE_PITCH) * scale;
        doc.save();
        doc.fillColor(TEXT_COLOUR).fontSize(size);
        const rawWidth = line === '' ? 0 : doc.widthOfString(line);
        const shift = ANCHOR_SHARE[text.anchor] * rawWidth;
        const rawX = x + drop * Math.sin(text.rotation);
        const rawY = y + drop * Math.cos(text.rotation);
        const minTx = margin + shift;
        const maxTx = Math.max(minTx, page[0] - margin - (rawWidth - shift));
        const minTy = margin + size;
        const maxTy = Math.max(minTy, page[1] - margin);
        const tx = clampToExtents ? Math.min(maxTx, Math.max(minTx, rawX)) : rawX;
        const ty = clampToExtents ? Math.min(maxTy, Math.max(minTy, rawY)) : rawY;
        doc.translate(tx, ty);
        doc.rotate(-text.rotation / DEGREES);
        renderSafePdfText(doc, line, fontFallback.hasUnicodeFont, { lineBreak: false, baseline: 'alphabetic' }, -shift, 0);
        doc.restore();
      });
    }
    doc.end();
  });
}
