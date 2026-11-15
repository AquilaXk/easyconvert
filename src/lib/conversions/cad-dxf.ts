import PDFDocument from 'pdfkit';
import { CadExpansionLimitError, CadGeometryError, ConversionFailedError } from '../types';
import { configurePdfKitFontFallback, renderSafePdfText } from './office';
import { plainMtextLines, plainText } from './cad-dxf-text';
import { reportConversionWarning } from './conversion-warnings';

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

/** Contiguous section-level storage for group-code pairs so individual entities do not allocate JS arrays. */
interface GroupTable {
  readonly codes: Int32Array;
  readonly values: readonly string[];
}

/** One entity, table entry, or block header as a `[start, end)` slice into its section's `GroupTable`. */
interface GroupRecord {
  readonly table: GroupTable;
  readonly start: number;
  readonly end: number;
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
  let sectionName = '';
  let sectionCodes: Int32Array | null = null;
  let sectionValues: string[] | null = null;
  let sectionSpans: Array<{ start: number; end: number }> | null = null;
  let pairCount = 0;
  let activeRecordStart = -1;

  const appendPair = (code: number, value: string): void => {
    if (!sectionCodes || !sectionValues) return;
    if (pairCount >= sectionCodes.length) {
      const grown = new Int32Array(sectionCodes.length * 2);
      grown.set(sectionCodes);
      sectionCodes = grown;
    }
    sectionCodes[pairCount] = code;
    sectionValues.push(value);
    pairCount++;
  };

  const finishSection = (): void => {
    if (!sectionCodes || !sectionValues || !sectionSpans) return;
    if (activeRecordStart >= 0) {
      sectionSpans.push({ start: activeRecordStart, end: pairCount });
      activeRecordStart = -1;
    }
    const table: GroupTable = {
      codes: sectionCodes.subarray(0, pairCount),
      values: sectionValues,
    };
    const records: GroupRecord[] = new Array<GroupRecord>(sectionSpans.length);
    for (let i = 0; i < sectionSpans.length; i++) {
      const span = sectionSpans[i];
      records[i] = { table, start: span.start, end: span.end };
    }
    sections.push({ section: sectionName, records });
    sectionCodes = null;
    sectionValues = null;
    sectionSpans = null;
    pairCount = 0;
  };

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
        sectionName = '';
        sectionCodes = new Int32Array(64);
        sectionValues = [];
        sectionSpans = [];
        pairCount = 0;
        activeRecordStart = -1;
      } else if (value === 'ENDSEC') {
        finishSection();
      } else if (sectionSpans) {
        if (activeRecordStart >= 0) {
          sectionSpans.push({ start: activeRecordStart, end: pairCount });
        }
        activeRecordStart = pairCount;
        appendPair(code, value);
      }
    } else if (activeRecordStart >= 0) {
      appendPair(code, value);
    } else if (sectionSpans && code === 2 && sectionName === '') {
      sectionName = value;
    }
  }
  return sections;
}

const recordType = (record: GroupRecord): string => record.table.values[record.start];

const first = (record: GroupRecord, code: number): string | undefined => {
  const { codes, values } = record.table;
  for (let i = record.start; i < record.end; i++) {
    if (codes[i] === code) return values[i];
  }
  return undefined;
};
/** A group value as a number; a value that is not a finite number is a damaged drawing, never a coordinate. */
function finite(value: string, code: number): number {
  const parsed = NUMBER(value);
  if (!Number.isFinite(parsed)) throw new CadGeometryError(`The DXF holds "${value.slice(0, 24)}" in group ${code}, which is not a finite number`);
  return parsed;
}
const numRaw = (raw: string | undefined, code: number, fallback: number): number =>
  raw === undefined ? fallback : finite(raw, code);
const num = (record: GroupRecord, code: number, fallback: number): number => numRaw(first(record, code), code, fallback);
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

function transformCoords(t: Affine, x: number, y: number): Point {
  return t === IDENTITY ? [x, y] : [t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f];
}

interface PolylineBuffer {
  xs: Float64Array;
  ys: Float64Array;
  bulges: Float64Array;
  count: number;
  closed: boolean;
}

function buildPolylinePoints(
  poly: PolylineBuffer,
  t: Affine,
  chargePoints: (count: number) => void
): Point[] {
  const { xs, ys, bulges, count, closed } = poly;
  const segments = closed ? count : count - 1;
  if (segments <= 0) {
    const fallback: Point[] = new Array<Point>(count);
    for (let i = 0; i < count; i++) fallback[i] = transformCoords(t, xs[i], ys[i]);
    return fallback;
  }
  const points: Point[] = [];
  for (let i = 0; i < segments; i++) {
    const next = i + 1 === count ? 0 : i + 1;
    const x0 = xs[i];
    const y0 = ys[i];
    const x1 = xs[next];
    const y1 = ys[next];
    const bulge = bulges[i];
    if (bulge === 0 || (x0 === x1 && y0 === y1)) {
      chargePoints(2);
      if (i === 0) points.push(transformCoords(t, x0, y0));
      points.push(transformCoords(t, x1, y1));
      continue;
    }
    const piece = bulgeArc([x0, y0], [x1, y1], bulge);
    // Charged as it is made, so a polyline of thousands of bulged vertices stops at the budget and not after it.
    chargePoints(piece.length);
    for (let j = i === 0 ? 0 : 1; j < piece.length; j++) {
      const pt = piece[j];
      points.push(transformCoords(t, pt[0], pt[1]));
    }
  }
  return points;
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

/** Index of the knot span of `t`: the largest k in [degree, count - 1] with knots[k] <= t (The NURBS Book, A2.1). */
export function knotSpan(knots: number[], degree: number, count: number, t: number): number {
  if (t >= knots[count]) return count - 1;
  if (t < knots[degree + 1]) return degree;
  let low = degree;
  let high = count - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (t < knots[mid]) {
      high = mid - 1;
    } else if (t >= knots[mid + 1]) {
      low = mid + 1;
    } else {
      return mid;
    }
  }
  return degree;
}

/** A point of a NURBS curve (The NURBS Book, A4.1 over the basis of A2.2). */
function nurbsPoint(degree: number, knots: number[], control: Point[], weights: number[], t: number, basis: Float64Array, left: Float64Array, right: Float64Array): Point {
  const span = knotSpan(knots, degree, control.length, t);
  // The three work arrays are reused between points: the recurrence writes every value it later reads.
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
  let rawDegree: string | undefined;
  const knots: number[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  const fitX: number[] = [];
  const fitY: number[] = [];
  const stated: number[] = [];
  const { codes, values } = record.table;
  for (let i = record.start + 1; i < record.end; i++) {
    const c = codes[i];
    if (c === 71) {
      if (rawDegree === undefined) rawDegree = values[i];
    } else if (c === 40) {
      knots.push(finite(values[i], 40));
    } else if (c === 10) {
      xs.push(finite(values[i], 10));
    } else if (c === 20) {
      ys.push(finite(values[i], 20));
    } else if (c === 11) {
      fitX.push(finite(values[i], 11));
    } else if (c === 21) {
      fitY.push(finite(values[i], 21));
    } else if (c === 41) {
      stated.push(finite(values[i], 41));
    }
  }
  const degree = Math.trunc(rawDegree === undefined ? 3 : finite(rawDegree, 71));
  if (degree < 1 || degree > MAX_SPLINE_DEGREE) throw new CadGeometryError(`The DXF has a SPLINE of degree ${degree}; degrees 1 to ${MAX_SPLINE_DEGREE} are read`);
  const control: Point[] = xs.map((x, i) => [x, ys[i] ?? 0] as Point);
  if (control.length === 0) return fitX.map((x, i) => [x, fitY[i] ?? 0] as Point);
  if (control.length <= degree) throw new CadGeometryError(`The DXF has a SPLINE of degree ${degree} with ${control.length} control points, which needs at least ${degree + 1}`);
  if (knots.length !== control.length + degree + 1) throw new CadGeometryError(`The DXF has a SPLINE with ${knots.length} knots, but ${control.length} control points of degree ${degree} need ${control.length + degree + 1}`);
  for (let i = 1; i < knots.length; i++) {
    if (knots[i] < knots[i - 1]) throw new CadGeometryError('The DXF has a SPLINE whose knots decrease');
  }
  if (!(knots[control.length] > knots[degree])) throw new CadGeometryError('The DXF has a SPLINE with an empty parameter range');
  const weights = control.map((_, i) => (stated.length === control.length && stated[i] > 0 ? stated[i] : 1));
  const spans = control.length - degree;
  const steps = Math.min(MAX_SAMPLED_POINTS_PER_CURVE, spans * SPLINE_SAMPLES_PER_SPAN);
  const from = knots[degree];
  const to = knots[control.length];
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
  /** The path of the external drawing (group 1) of a block that is an external reference, flagged 4 or 8 in group 70. */
  xrefPath?: string;
}

const BLOCK_XREF_FLAG = 4;
const BLOCK_XREF_OVERLAY_FLAG = 8;
const MAX_XREF_NAME_CHARACTERS = 200;
/** A name or path of the file as one line of a warning: no control character, not longer than a path can be. */
const printable = (value: string): string => value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_XREF_NAME_CHARACTERS);

interface Layers {
  hidden: ReadonlySet<string>;
}

function readLayers(sections: { section: string; records: GroupRecord[] }[]): Layers {
  const hidden = new Set<string>();
  for (const section of sections) {
    if (section.section !== 'TABLES') continue;
    for (const record of section.records) {
      if (recordType(record) !== 'LAYER') continue;
      const name = first(record, 2);
      if (name === undefined) continue;
      const frozen = (Math.trunc(num(record, 70, 0)) & LAYER_FROZEN_FLAG) !== 0;
      if (frozen || num(record, 62, 1) < 0) hidden.add(name);
    }
  }
  return { hidden };
}

function readStyles(sections: { section: string; records: GroupRecord[] }[]): ReadonlyMap<string, number> {
  const styles = new Map<string, number>();
  for (const section of sections) {
    if (section.section !== 'TABLES') continue;
    for (const record of section.records) {
      if (recordType(record) !== 'STYLE') continue;
      const name = first(record, 2);
      const width = num(record, 41, 1);
      if (name !== undefined && width > 0) styles.set(name.toUpperCase(), width);
    }
  }
  return styles;
}

function mtextColumnWidth(record: GroupRecord): number | undefined {
  if (first(record, 48) !== undefined) {
    const direct = num(record, 48, 0);
    if (direct > 0) return direct;
  }
  const { codes, values } = record.table;
  for (let i = record.start + 1; i + 1 < record.end; i++) {
    if (codes[i] === 1070 && Math.trunc(finite(values[i], 1070)) === 48 && codes[i + 1] === 1040) {
      const xdataWidth = finite(values[i + 1], 1040);
      if (xdataWidth > 0) return xdataWidth;
    }
  }
  return undefined;
}

function buildMtextColumnWidths(records: GroupRecord[]): Map<string, number> | null {
  let columnWidths: Map<string, number> | null = null;
  for (let r = 0; r < records.length; r++) {
    const record = records[r];
    if (recordType(record) !== 'MTEXT') continue;
    const colWidth = mtextColumnWidth(record);
    if (colWidth === undefined) continue;
    if (!columnWidths) columnWidths = new Map<string, number>();
    const handle = first(record, 5);
    if (handle !== undefined) columnWidths.set(handle, colWidth);
    const { codes, values } = record.table;
    for (let i = record.start + 1; i < record.end; i++) {
      if (codes[i] === 1005) columnWidths.set(values[i], colWidth);
    }
  }
  return columnWidths;
}

function wrapMtextLines(lines: string[], height: number, boxWidth: number, widthFactor = 1): string[] {
  const charWidth = height * TEXT_WIDTH_PER_CHARACTER * widthFactor;
  if (!(boxWidth > 0) || !(charWidth > 0)) return lines;
  const maxChars = Math.max(1, Math.floor(boxWidth / charWidth));
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

function textBaselineOffset(vertical: number, horizontal: number, height: number): number {
  if (vertical === 1) return height / 3;
  if (vertical === 2) return -height / 2;
  if (vertical === 3) return -height;
  if (horizontal === 4) return -height / 3;
  return 0;
}

function mtextVerticalLift(attachment: number, blockHeight: number): number {
  if (attachment >= 7 && attachment <= 9) return blockHeight;
  if (attachment >= 4 && attachment <= 6) return blockHeight / 2;
  return 0;
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
  private polyX = new Float64Array(64);
  private polyY = new Float64Array(64);
  private polyBulge = new Float64Array(64);

  constructor(
    private readonly blocks: ReadonlyMap<string, Block>,
    private readonly layers: Layers,
    private readonly styles: ReadonlyMap<string, number>
  ) {}

  private ensurePolyCapacity(index: number): void {
    if (index < this.polyX.length) return;
    const nextCap = this.polyX.length * 2;
    const grownX = new Float64Array(nextCap);
    const grownY = new Float64Array(nextCap);
    const grownBulge = new Float64Array(nextCap);
    grownX.set(this.polyX);
    grownY.set(this.polyY);
    grownBulge.set(this.polyBulge);
    this.polyX = grownX;
    this.polyY = grownY;
    this.polyBulge = grownBulge;
  }

  private isHiddenLayer(rawLayer: string | undefined): boolean {
    return this.layers.hidden.size > 0 && this.layers.hidden.has(rawLayer ?? '0');
  }

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

  private emitPolyline(count: number, closed: boolean, t: Affine): void {
    if (count <= 1) return;
    const points = buildPolylinePoints(
      { xs: this.polyX, ys: this.polyY, bulges: this.polyBulge, count, closed },
      t,
      (charged) => this.chargePoints(charged)
    );
    if (points.length >= 2) this.add({ kind: 'poly', points, closed });
  }

  entities(records: GroupRecord[], t: Affine, depth: number): void {
    const columnWidths = buildMtextColumnWidths(records);
    let idx = 0;
    while (idx < records.length) {
      const record = records[idx++];
      const type = recordType(record);
      if (type === 'SEQEND') continue;
      this.charge(1);
      if (type === 'POLYLINE') {
        const vertexStart = idx;
        while (idx < records.length && recordType(records[idx]) === 'VERTEX') idx++;
        const vertexEnd = idx;
        if (idx < records.length && recordType(records[idx]) === 'SEQEND') idx++;
        this.polylineEntity(record, records, vertexStart, vertexEnd, t);
        continue;
      }
      const colWidth = type === 'MTEXT' && columnWidths ? columnWidths.get(first(record, 5) ?? '') : undefined;
      this.entity(record, t, depth, colWidth);
    }
  }

  private entity(record: GroupRecord, t: Affine, depth: number, columnWidth?: number): void {
    switch (recordType(record)) {
      case 'LINE':
        this.lineEntity(record, t);
        return;
      case 'CIRCLE':
        this.circleEntity(record, t);
        return;
      case 'ARC':
        this.arcEntity(record, t);
        return;
      case 'LWPOLYLINE':
        this.lwPolylineEntity(record, t);
        return;
      case 'ELLIPSE':
        this.ellipseEntity(record, t);
        return;
      case 'SPLINE':
        this.splineEntity(record, t);
        return;
      case 'INSERT':
        this.insertEntity(record, t, depth);
        return;
      case 'DIMENSION':
        this.dimensionEntity(record, t, depth);
        return;
      case 'TEXT':
        if (!this.isHiddenLayer(first(record, 8))) this.text(record, t);
        return;
      case 'MTEXT':
        if (!this.isHiddenLayer(first(record, 8))) this.mtext(record, [num(record, 10, 0), num(record, 20, 0)], t, columnWidth);
        return;
      default:
    }
  }

  private lineEntity(record: GroupRecord, t: Affine): void {
    const { codes, values } = record.table;
    let raw8: string | undefined;
    let raw10: string | undefined;
    let raw20: string | undefined;
    let raw11: string | undefined;
    let raw21: string | undefined;
    for (let i = record.start + 1; i < record.end; i++) {
      const c = codes[i];
      if (c === 8 && raw8 === undefined) raw8 = values[i];
      else if (c === 10 && raw10 === undefined) raw10 = values[i];
      else if (c === 20 && raw20 === undefined) raw20 = values[i];
      else if (c === 11 && raw11 === undefined) raw11 = values[i];
      else if (c === 21 && raw21 === undefined) raw21 = values[i];
    }
    if (this.isHiddenLayer(raw8)) return;
    const x0 = numRaw(raw10, 10, 0);
    const y0 = numRaw(raw20, 20, 0);
    const x1 = numRaw(raw11, 11, 0);
    const y1 = numRaw(raw21, 21, 0);
    this.add({ kind: 'line', a: transformCoords(t, x0, y0), b: transformCoords(t, x1, y1) });
  }

  private circleEntity(record: GroupRecord, t: Affine): void {
    const { codes, values } = record.table;
    let raw8: string | undefined;
    let raw10: string | undefined;
    let raw20: string | undefined;
    let raw40: string | undefined;
    for (let i = record.start + 1; i < record.end; i++) {
      const c = codes[i];
      if (c === 8 && raw8 === undefined) raw8 = values[i];
      else if (c === 10 && raw10 === undefined) raw10 = values[i];
      else if (c === 20 && raw20 === undefined) raw20 = values[i];
      else if (c === 40 && raw40 === undefined) raw40 = values[i];
    }
    if (this.isHiddenLayer(raw8)) return;
    const at: Point = [numRaw(raw10, 10, 0), numRaw(raw20, 20, 0)];
    const radius = numRaw(raw40, 40, 0);
    if (!(radius > 0)) return;
    const similar = similarity(t);
    if (similar) this.add({ kind: 'circle', centre: apply(t, at), radius: radius * similar.scale });
    else this.curve(sampleArc(at, radius, 0, FULL_TURN), true, t);
  }

  private arcEntity(record: GroupRecord, t: Affine): void {
    const { codes, values } = record.table;
    let raw8: string | undefined;
    let raw10: string | undefined;
    let raw20: string | undefined;
    let raw40: string | undefined;
    let raw50: string | undefined;
    let raw51: string | undefined;
    for (let i = record.start + 1; i < record.end; i++) {
      const c = codes[i];
      if (c === 8 && raw8 === undefined) raw8 = values[i];
      else if (c === 10 && raw10 === undefined) raw10 = values[i];
      else if (c === 20 && raw20 === undefined) raw20 = values[i];
      else if (c === 40 && raw40 === undefined) raw40 = values[i];
      else if (c === 50 && raw50 === undefined) raw50 = values[i];
      else if (c === 51 && raw51 === undefined) raw51 = values[i];
    }
    if (this.isHiddenLayer(raw8)) return;
    const at: Point = [numRaw(raw10, 10, 0), numRaw(raw20, 20, 0)];
    const radius = numRaw(raw40, 40, 0);
    if (!(radius > 0)) return;
    const start = turnDegrees(numRaw(raw50, 50, 0)) * DEGREES;
    const sweep = sweepOf(start, turnDegrees(numRaw(raw51, 51, DEGREES_PER_TURN)) * DEGREES);
    const similar = similarity(t);
    if (similar) this.add({ kind: 'arc', centre: apply(t, at), radius: radius * similar.scale, start: start + similar.rotation, end: start + similar.rotation + sweep });
    else this.curve(sampleArc(at, radius, start, sweep), false, t);
  }

  private lwPolylineEntity(record: GroupRecord, t: Affine): void {
    if (this.isHiddenLayer(first(record, 8))) return;
    const { codes, values } = record.table;
    let raw70: string | undefined;
    let count = 0;
    for (let i = record.start + 1; i < record.end; i++) {
      const code = codes[i];
      if (code === 70 && raw70 === undefined) {
        raw70 = values[i];
      } else if (code === 10) {
        this.ensurePolyCapacity(count);
        this.polyX[count] = finite(values[i], 10);
        this.polyY[count] = 0;
        this.polyBulge[count] = 0;
        count++;
      } else if (code === 20) {
        const yVal = finite(values[i], 20);
        if (count > 0) this.polyY[count - 1] = yVal;
      } else if (code === 42) {
        const bVal = finite(values[i], 42);
        if (count > 0) this.polyBulge[count - 1] = bVal;
      }
    }
    const closed = (Math.trunc(numRaw(raw70, 70, 0)) & POLYLINE_CLOSED_FLAG) !== 0;
    this.emitPolyline(count, closed, t);
  }

  private polylineEntity(
    record: GroupRecord,
    records: GroupRecord[],
    vertexStart: number,
    vertexEnd: number,
    t: Affine
  ): void {
    if (this.isHiddenLayer(first(record, 8))) return;
    void num(record, 10, 0);
    void num(record, 20, 0);
    let count = 0;
    for (let vIdx = vertexStart; vIdx < vertexEnd; vIdx++) {
      const vertex = records[vIdx];
      const { codes, values } = vertex.table;
      let raw70: string | undefined;
      let raw10: string | undefined;
      let raw20: string | undefined;
      let raw42: string | undefined;
      for (let i = vertex.start + 1; i < vertex.end; i++) {
        const c = codes[i];
        if (c === 70 && raw70 === undefined) raw70 = values[i];
        else if (c === 10 && raw10 === undefined) raw10 = values[i];
        else if (c === 20 && raw20 === undefined) raw20 = values[i];
        else if (c === 42 && raw42 === undefined) raw42 = values[i];
      }
      if ((Math.trunc(numRaw(raw70, 70, 0)) & SPLINE_FRAME_VERTEX_FLAG) !== 0) continue;
      this.ensurePolyCapacity(count);
      this.polyX[count] = numRaw(raw10, 10, 0);
      this.polyY[count] = numRaw(raw20, 20, 0);
      this.polyBulge[count] = numRaw(raw42, 42, 0);
      count++;
    }
    const closed = (Math.trunc(num(record, 70, 0)) & POLYLINE_CLOSED_FLAG) !== 0;
    this.emitPolyline(count, closed, t);
  }

  private ellipseEntity(record: GroupRecord, t: Affine): void {
    if (this.isHiddenLayer(first(record, 8))) return;
    const at: Point = [num(record, 10, 0), num(record, 20, 0)];
    const ratio = num(record, 40, 1);
    const major: Point = [num(record, 11, 0), num(record, 21, 0)];
    if (!(ratio > 0) || (major[0] === 0 && major[1] === 0)) return;
    this.curve(sampleEllipse(at, major, ratio, turnRadians(num(record, 41, 0)), turnRadians(num(record, 42, FULL_TURN))), false, t);
  }

  private splineEntity(record: GroupRecord, t: Affine): void {
    if (this.isHiddenLayer(first(record, 8))) return;
    const periodic = (Math.trunc(num(record, 70, 0)) & SPLINE_PERIODIC_FLAG) !== 0;
    const points = sampleSpline(record);
    const closed =
      periodic &&
      points.length > 2 &&
      Math.hypot(points[0][0] - points[points.length - 1][0], points[0][1] - points[points.length - 1][1]) < 1e-9;
    this.curve(points, closed, t);
  }

  private dimensionEntity(record: GroupRecord, t: Affine, depth: number): void {
    if (this.isHiddenLayer(first(record, 8))) return;
    void num(record, 10, 0);
    void num(record, 20, 0);
    const name = first(record, 2);
    const block = name === undefined ? undefined : this.blocks.get(name);
    if (block && depth < MAX_BLOCK_DEPTH) {
      this.entities(block.records, compose(t, { ...IDENTITY, e: -block.base[0], f: -block.base[1] }), depth + 1);
    }
  }

  private insertEntity(record: GroupRecord, t: Affine, depth: number): void {
    if (this.isHiddenLayer(first(record, 8))) return;
    const at: Point = [num(record, 10, 0), num(record, 20, 0)];
    this.insert(record, at, t, depth);
  }

  private insert(record: GroupRecord, at: Point, t: Affine, depth: number): void {
    const name = first(record, 2);
    const block = name === undefined ? undefined : this.blocks.get(name);
    if (!block) return;
    // An uploaded drawing has no companion files: an external reference holds no entities and draws nothing, and says so.
    if (block.xrefPath !== undefined && block.records.length === 0) {
      const path = printable(block.xrefPath);
      const target = path === '' ? 'an external drawing' : `the external drawing "${path}"`;
      reportConversionWarning(`The drawing refers to ${target} (reference "${printable(name ?? '')}"), which is not part of the uploaded file, so it was left out.`);
    }
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

  private styleWidthFactor(record: GroupRecord): number {
    const styleName = first(record, 7);
    if (styleName === undefined) return 1;
    return this.styles.get(styleName.toUpperCase()) ?? 1;
  }

  private text(record: GroupRecord, t: Affine): void {
    const raw = first(record, 1);
    const height = num(record, 40, 0);
    if (raw === undefined || raw.trim() === '' || !(height > 0)) return;
    const value = plainText(raw);
    if (value.trim() === '') return;
    const horizontal = Math.trunc(num(record, 72, 0));
    const vertical = horizontal > 2 ? 0 : Math.trunc(num(record, 73, 0));
    const p1: Point = [num(record, 10, 0), num(record, 20, 0)];
    const hasSecond = first(record, 11) !== undefined;
    const p2: Point = hasSecond ? [num(record, 11, p1[0]), num(record, 21, p1[1])] : p1;
    const widthFactor = num(record, 41, this.styleWidthFactor(record));
    if ((horizontal === 3 || horizontal === 5) && hasSecond) {
      const dx = p2[0] - p1[0];
      const dy = p2[1] - p1[1];
      const spanLength = Math.hypot(dx, dy);
      const origin: Point = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
      const rotation = spanLength > 0 ? Math.atan2(dy, dx) : turnDegrees(num(record, 50, 0)) * DEGREES;
      const effectiveHeight =
        horizontal === 3 && spanLength > 0
          ? Math.min(height, spanLength / Math.max(1, value.length * TEXT_WIDTH_PER_CHARACTER * widthFactor))
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
    const baselineOffset = textBaselineOffset(vertical, horizontal, height);
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

  private mtext(record: GroupRecord, at: Point, t: Affine, columnWidth?: number): void {
    const height = num(record, 40, 0);
    const { codes, values } = record.table;
    let raw = '';
    let tail: string | undefined;
    for (let i = record.start + 1; i < record.end; i++) {
      if (codes[i] === 3) raw += values[i];
      else if (codes[i] === 1 && tail === undefined) tail = values[i];
    }
    if (tail !== undefined) raw += tail;
    if (!(height > 0) || raw.trim() === '') return;
    const stripped = plainMtextLines(raw).map((line) => line.trimEnd());
    if (stripped.every((line) => line.length === 0)) return;
    const direction = first(record, 11) === undefined ? turnDegrees(num(record, 50, 0)) * DEGREES : Math.atan2(num(record, 21, 0), num(record, 11, 1));
    const widthFactor = this.styleWidthFactor(record);
    const boxWidth = columnWidth ?? mtextColumnWidth(record) ?? num(record, 41, 0);
    const lines = wrapMtextLines(stripped, height, boxWidth, widthFactor);
    const attachment = Math.trunc(num(record, 71, 1));
    const blockHeight = height * (1 + (lines.length - 1) * MTEXT_LINE_PITCH);
    const lift = mtextVerticalLift(attachment, blockHeight);
    const origin: Point = lift === 0 ? at : [at[0] - lift * Math.sin(direction), at[1] + lift * Math.cos(direction)];
    this.place(
      {
        at: origin,
        height,
        rotation: direction,
        lines,
        anchor: MTEXT_ANCHORS[attachment] ?? 'start',
        hangsFromTop: true,
        ...(widthFactor !== 1 ? { widthFactor } : {}),
      },
      t
    );
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
  for (const text of texts) for (const corner of textBox(text)) grow(bounds, corner[0], corner[1]);
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
      const type = recordType(record);
      if (type === 'BLOCK') {
        const name = first(record, 2);
        const isXref = (Math.trunc(num(record, 70, 0)) & (BLOCK_XREF_FLAG | BLOCK_XREF_OVERLAY_FLAG)) !== 0;
        current = name === undefined ? null : { name, block: { base: [num(record, 10, 0), num(record, 20, 0)], records: [], ...(isXref ? { xrefPath: first(record, 1) ?? '' } : {}) } };
      } else if (type === 'ENDBLK') {
        if (current) blocks.set(current.name, current.block);
        current = null;
      } else if (current) {
        current.block.records.push(record);
      }
    }
  }
  const builder = new Builder(blocks, readLayers(sections), readStyles(sections));
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

function textElements(texts: DxfText[], map: (p: Point) => Point, fmt: (value: number) => string): string[] {
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
    text.lines.forEach((line, index) => {
      const drop = (text.hangsFromTop ? 1 : 0) * effectiveHeight + index * effectiveHeight * MTEXT_LINE_PITCH;
      // The drop runs down the rotated text, which is (sin, cos) in y-up units and (sin, -cos) after the page's y flip.
      const px = x + drop * sin;
      const py = y + drop * cos;
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
        const coords = new Array<string>(stroke.points.length);
        for (let i = 0; i < stroke.points.length; i++) {
          const point = stroke.points[i];
          coords[i] = `${fmt(point[0])},${fmt(-point[1])}`;
        }
        elements.push(`<${stroke.closed ? 'polygon' : 'polyline'} points="${coords.join(' ')}" />`);
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
    ${textElements(drawing.texts, flip, fmt).join(ELEMENT_SEPARATOR)}
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
          doc.path(arcPath(stroke, map, scale, exact)).stroke();
          break;
        case 'poly': {
          const firstPt = map(stroke.points[0]);
          doc.moveTo(firstPt[0], firstPt[1]);
          for (let i = 1; i < stroke.points.length; i++) {
            const pt = map(stroke.points[i]);
            doc.lineTo(pt[0], pt[1]);
          }
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
      const pdfAngle = text.fitLength !== undefined ? 0 : -text.rotation / DEGREES;
      text.lines.forEach((line, index) => {
        const drop = ((text.hangsFromTop ? 1 : 0) * effectiveHeight + index * effectiveHeight * MTEXT_LINE_PITCH) * scale;
        doc.save();
        doc.fillColor(TEXT_COLOUR).fontSize(size);
        const rawWidth = line === '' ? 0 : doc.widthOfString(line);
        const shift = ANCHOR_SHARE[text.anchor] * rawWidth;
        const tx = x + drop * Math.sin(text.rotation);
        const ty = y + drop * Math.cos(text.rotation);
        doc.translate(tx, ty);
        if (pdfAngle !== 0) doc.rotate(pdfAngle);
        renderSafePdfText(doc, line, fontFallback.hasUnicodeFont, { lineBreak: false, baseline: 'alphabetic' }, -shift, 0);
        doc.restore();
      });
    }
    doc.end();
  });
}
