import { CadGeometryUnavailableError, UnsupportedOptionError } from '../types';
import { parseSvgGeometries, type ParsedSvgVectorDocument, type RgbColor, type SvgLinecap, type SvgLinejoin } from './svg-geometry';
import { planElement, nonzeroDiffersFromEvenOdd, WorkMeter, miterRatios, strokedLines, type DrawOp, type FillOp, type PlanPen, type PlanPoint } from './metafile-draw-plan';

export {
  parseCssColor,
  parseSvgGeometries,
  parseSvgPathToPoints,
  parseSvgPathToBezierPoints,
  type RgbColor,
  type SvgGeometryElement,
  type ParsedSvgVectorDocument,
} from './svg-geometry';

const SVG_ROOT_PATTERN = /<svg\b/i;

/**
 * Parses the SVG input for a metafile encoder and fails closed when there is
 * nothing to encode: empty input, a non-SVG payload, or no drawable geometry.
 */
function parseDrawableSvg(svgBuffer: Buffer, targetLabel: string): ParsedSvgVectorDocument {
  if (!svgBuffer || svgBuffer.length === 0) {
    throw new CadGeometryUnavailableError(`${targetLabel} encoding failed: SVG buffer is empty.`);
  }
  const svgText = svgBuffer.toString('utf-8');
  if (!SVG_ROOT_PATTERN.test(svgText)) {
    throw new CadGeometryUnavailableError(`${targetLabel} encoding failed: input is not an SVG document.`);
  }
  const doc = parseSvgGeometries(svgText);
  const hasDrawable = doc.elements.some((el) => planElement(el).length > 0);
  if (!hasDrawable) {
    throw new CadGeometryUnavailableError(`${targetLabel} encoding failed: SVG contains no drawable vector geometry.`);
  }
  return doc;
}

// ============================================================================
// EMF ENCODER (MS-EMF Enhanced Metafile)
// ============================================================================

// MS-EMF 2.1.1 RecordType values
const EMR_HEADER = 1;
const EMR_EOF = 14;
const EMR_SETMAPMODE = 17;
const EMR_SETBKMODE = 18;
const EMR_SETPOLYFILLMODE = 19;
const EMR_SELECTOBJECT = 37;
const EMR_CREATEBRUSHINDIRECT = 39;
const EMR_DELETEOBJECT = 40;
const EMR_POLYGON16 = 86;
const EMR_POLYLINE16 = 87;
const EMR_POLYPOLYGON16 = 91;
const EMR_EXTCREATEPEN = 95;
/** Type, Size, ihPen, offBmi, cbBmi, offBits, cbBits + LogPenEx (6 fields, no style entries). */
const EMF_EXTCREATEPEN_SIZE = 52;
/** Type, Size and one 32-bit field. */
const EMF_SMALL_RECORD_SIZE = 12;
const EMF_BS_SOLID = 0;
const EMF_POLYFILL_ALTERNATE = 1;
const EMF_MM_TEXT = 1;
const EMF_MM_ANISOTROPIC = 8;
const EMR_SETWINDOWEXTEX = 9;
const EMR_SETVIEWPORTEXTEX = 11;
const EMF_BK_TRANSPARENT = 1;
const EMF_POLYFILL_WINDING = 2;
const EMF_STOCK_NULL_BRUSH = 0x80000005;
const EMF_STOCK_NULL_PEN = 0x80000008;
const EMF_HEADER_SIZE = 88;
const EMF_EOF_SIZE = 20;
const EMF_VERSION_1_0 = 0x00010000;
/** Object table: index 0 is reserved, the pen uses 1 and the brush 2. */
const EMF_PEN_HANDLE = 1;
const EMF_BRUSH_HANDLE = 2;
const EMF_HANDLE_COUNT = EMF_BRUSH_HANDLE + 1;
/** Reference resolution: CSS pixels at 96 DPI, frame in 0.01 mm units. */
const CSS_PX_PER_INCH = 96;
const MM_PER_INCH = 25.4;
const HUNDREDTHS_MM_PER_PX = (MM_PER_INCH * 100) / CSS_PX_PER_INCH;
const INT16_MAX = 32767;

const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;

/** Rounds to an unsigned integer within `max`, throwing the typed error instead of a RangeError. */
function toUnsigned(value: number, max: number, what: string): number {
  const v = Math.round(value);
  if (!Number.isFinite(v) || v < 0 || v > max) {
    throw new CadGeometryUnavailableError(`${what} ${value} does not fit the metafile's ${max}-limited field.`);
  }
  return v;
}

/** Rounds to a signed 16-bit value; the logical space is pre-scaled so this never clamps. */
function toInt16(value: number, what = 'Coordinate'): number {
  const v = Math.round(value);
  if (!Number.isFinite(v) || v < -INT16_MAX || v > INT16_MAX) {
    throw new CadGeometryUnavailableError(`${what} ${v} does not fit the 16-bit metafile range.`);
  }
  return v;
}

/**
 * Logical coordinate space for 16-bit metafile formats. When device
 * coordinates exceed the int16 range, logical units are scaled uniformly by
 * unitsPerInch / 96 so the physical picture size stays unchanged.
 */
interface LogicalSpace {
  unitsPerInch: number;
  scale: number;
}

function computeLogicalSpace(ops: DrawOp[], width: number, height: number): LogicalSpace {
  let maxAbs = Math.max(width, height);
  for (const op of ops) {
    const groups = op.kind === 'fill' ? op.rings : op.lines;
    for (const pts of groups) {
      for (const p of pts) maxAbs = Math.max(maxAbs, Math.abs(p.x), Math.abs(p.y));
    }
  }
  if (!Number.isFinite(maxAbs)) {
    throw new CadGeometryUnavailableError('Drawing extent is not a finite number.');
  }
  if (maxAbs <= INT16_MAX) return { unitsPerInch: CSS_PX_PER_INCH, scale: 1 };
  const unitsPerInch = Math.floor((CSS_PX_PER_INCH * INT16_MAX) / maxAbs);
  if (unitsPerInch < 1) {
    throw new CadGeometryUnavailableError(
      `Drawing extent of ${Math.round(maxAbs)} px is too large for the 16-bit metafile coordinate range.`
    );
  }
  const scale = unitsPerInch / CSS_PX_PER_INCH;
  if (scale <= 0) {
    throw new CadGeometryUnavailableError('Logical coordinate scale must be positive.');
  }
  return { unitsPerInch, scale };
}

function scalePoints(points: PlanPoint[], s: number): PlanPoint[] {
  return points.map((p) => ({ x: p.x * s, y: p.y * s }));
}

/** Maps planned operations into the logical space (coordinates and pen widths). */
function scaleOps(ops: DrawOp[], s: number): DrawOp[] {
  if (s === 1) return ops;
  return ops.map((op) => {
    if (op.kind === 'stroke') {
      return { ...op, lines: op.lines.map((l) => scalePoints(l, s)), pen: { ...op.pen, width: op.pen.width * s } };
    }
    return { ...op, rings: op.rings.map((r) => scalePoints(r, s)), pen: op.pen ? { ...op.pen, width: op.pen.width * s } : null };
  });
}

/** Largest metafile the encoders will produce; beyond it the drawing is rejected as too complex. */
const MAX_METAFILE_OUTPUT_BYTES = 50 * 1024 * 1024;

function assertOutputSize(bytes: number, format: string): void {
  if (bytes > MAX_METAFILE_OUTPUT_BYTES) {
    throw new CadGeometryUnavailableError(
      `${format} output would exceed ${MAX_METAFILE_OUTPUT_BYTES} bytes; the drawing is too complex to encode.`
    );
  }
}

function totalLength(records: Buffer[]): number {
  return records.reduce((sum, r) => sum + r.length, 0);
}

function planDocument(doc: ParsedSvgVectorDocument): DrawOp[] {
  return doc.elements.flatMap((el) => planElement(el));
}

/** EMF record sizes in bytes; every record starts with Type and Size (MS-EMF 2.3.1). */
const EMF_POLY16_HEADER_SIZE = 28; // Type, Size, Bounds (16), Count
const EMF_POLYPOLY16_HEADER_SIZE = 32; // Type, Size, Bounds (16), NumberOfPolygons, Count
const EMF_POINT16_SIZE = 4; // PointS
const EMF_COUNT_SIZE = 4; // one 32-bit polygon point count
const EMF_PAIR_RECORD_SIZE = 16; // Type, Size and two 32-bit fields
const EMF_BRUSH_RECORD_SIZE = 24; // Type, Size, ihBrush, LogBrush32 (12)

/** Allocates an EMF record with its Type and Size header written. */
function emfRecord(type: number, size: number): Buffer {
  const rec = Buffer.alloc(size);
  rec.writeUInt32LE(type, 0);
  rec.writeUInt32LE(size, 4);
  return rec;
}

function emfPairRecord(type: number, x: number, y: number): Buffer {
  const rec = emfRecord(type, EMF_PAIR_RECORD_SIZE);
  rec.writeInt32LE(x, 8);
  rec.writeInt32LE(y, 12);
  return rec;
}

function createEmfStateRecords(space: LogicalSpace): Buffer[] {
  const scaled = space.scale !== 1;
  const mapModeRec = emfRecord(EMR_SETMAPMODE, EMF_SMALL_RECORD_SIZE);
  mapModeRec.writeUInt32LE(scaled ? EMF_MM_ANISOTROPIC : EMF_MM_TEXT, 8);
  // unitsPerInch logical units map onto 96 device pixels, isotropically
  const mapping = scaled
    ? [
        emfPairRecord(EMR_SETWINDOWEXTEX, space.unitsPerInch, space.unitsPerInch),
        emfPairRecord(EMR_SETVIEWPORTEXTEX, CSS_PX_PER_INCH, CSS_PX_PER_INCH),
      ]
    : [];

  const bkModeRec = emfRecord(EMR_SETBKMODE, EMF_SMALL_RECORD_SIZE);
  bkModeRec.writeUInt32LE(EMF_BK_TRANSPARENT, 8);

  const fillModeRec = emfRecord(EMR_SETPOLYFILLMODE, EMF_SMALL_RECORD_SIZE);
  fillModeRec.writeUInt32LE(EMF_POLYFILL_WINDING, 8);

  return [mapModeRec, ...mapping, bkModeRec, fillModeRec];
}

function computeBounds(pts: { x: number; y: number }[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pt of pts) {
    if (pt.x < minX) minX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y > maxY) maxY = pt.y;
  }
  return { minX, minY, maxX, maxY };
}

/** MS-EMF 2.1.25 PenStyle: geometric pen type, required for widths other than 1 (LogPen 2.2.19). */
const EMF_PS_GEOMETRIC = 0x00010000;
const EMF_PS_SOLID = 0x00000000;

/** PenStyle end-cap and join bits, shared by MS-EMF 2.1.25 and MS-WMF 2.1.1.23. */
const PEN_ENDCAP_BITS: Record<SvgLinecap, number> = { round: 0x0000, square: 0x0100, butt: 0x0200 };
const PEN_JOIN_BITS: Record<SvgLinejoin, number> = { round: 0x0000, bevel: 0x1000, miter: 0x2000 };

function penCapJoinBits(pen: PlanPen): number {
  return PEN_ENDCAP_BITS[pen.cap] | PEN_JOIN_BITS[pen.join];
}

function emfColorRef(c: RgbColor): number {
  return (c.b << 16) | (c.g << 8) | c.r;
}

function emfSelect(handle: number): Buffer {
  const rec = emfRecord(EMR_SELECTOBJECT, EMF_SMALL_RECORD_SIZE);
  rec.writeUInt32LE(handle, 8);
  return rec;
}

/** Creates and selects a geometric pen, or selects the stock NULL_PEN; returns whether one was created. */
function emitEmfPen(pen: PlanPen | null, out: Buffer[]): boolean {
  if (!pen) {
    out.push(emfSelect(EMF_STOCK_NULL_PEN));
    return false;
  }
  out.push(emfExtCreatePen(pen), emfSelect(EMF_PEN_HANDLE));
  return true;
}

/** EMR_EXTCREATEPEN (MS-EMF 2.3.7.9) with a solid geometric LogPenEx and no DIB pattern. */
function emfExtCreatePen(pen: PlanPen): Buffer {
  const rec = emfRecord(EMR_EXTCREATEPEN, EMF_EXTCREATEPEN_SIZE);
  rec.writeUInt32LE(EMF_PEN_HANDLE, 8);
  // offBmi, cbBmi, offBits, cbBits stay 0: no pattern bitmap
  rec.writeUInt32LE(EMF_PS_GEOMETRIC | EMF_PS_SOLID | penCapJoinBits(pen), 28);
  rec.writeUInt32LE(toUnsigned(Math.max(1, pen.width), UINT32_MAX, 'EMF pen width'), 32);
  rec.writeUInt32LE(EMF_BS_SOLID, 36);
  rec.writeUInt32LE(emfColorRef(pen.color), 40);
  rec.writeUInt32LE(0, 44); // BrushHatch, ignored for BS_SOLID
  rec.writeUInt32LE(0, 48); // NumStyleEntries
  return rec;
}

function emitEmfBrush(fill: RgbColor, out: Buffer[]): void {
  const brushRec = emfRecord(EMR_CREATEBRUSHINDIRECT, EMF_BRUSH_RECORD_SIZE);
  brushRec.writeUInt32LE(EMF_BRUSH_HANDLE, 8);
  brushRec.writeUInt32LE(EMF_BS_SOLID, 12);
  brushRec.writeUInt32LE(emfColorRef(fill), 16);
  brushRec.writeUInt32LE(0, 20); // BrushHatch, ignored for BS_SOLID
  out.push(brushRec, emfSelect(EMF_BRUSH_HANDLE));
}

/** Record Bounds are in device units; logical points are divided by the logical scale. */
function writeEmfBounds(rec: Buffer, points: PlanPoint[], scale: number): void {
  const bounds = computeBounds(points);
  rec.writeInt32LE(Math.round(bounds.minX / scale), 8);
  rec.writeInt32LE(Math.round(bounds.minY / scale), 12);
  rec.writeInt32LE(Math.round(bounds.maxX / scale), 16);
  rec.writeInt32LE(Math.round(bounds.maxY / scale), 20);
}

function writePoints16(rec: Buffer, at: number, points: PlanPoint[]): void {
  points.forEach((pt, i) => {
    rec.writeInt16LE(toInt16(pt.x), at + i * 4);
    rec.writeInt16LE(toInt16(pt.y), at + i * 4 + 2);
  });
}

/** EMR_POLYGON16 / EMR_POLYLINE16 (MS-EMF 2.3.5.35 / 2.3.5.37). */
function emfPoly16(type: number, points: PlanPoint[], scale: number): Buffer {
  const rec = emfRecord(type, EMF_POLY16_HEADER_SIZE + EMF_POINT16_SIZE * points.length);
  writeEmfBounds(rec, points, scale);
  rec.writeUInt32LE(points.length, 24);
  writePoints16(rec, 28, points);
  return rec;
}

/** EMR_POLYPOLYGON16 (MS-EMF 2.3.5.31): one fill area made of several rings. */
function emfPolyPolygon16(rings: PlanPoint[][], scale: number): Buffer {
  const all = rings.flat();
  const rec = emfRecord(
    EMR_POLYPOLYGON16,
    EMF_POLYPOLY16_HEADER_SIZE + EMF_COUNT_SIZE * rings.length + EMF_POINT16_SIZE * all.length
  );
  writeEmfBounds(rec, all, scale);
  rec.writeUInt32LE(rings.length, 24);
  rec.writeUInt32LE(all.length, 28);
  rings.forEach((r, i) => rec.writeUInt32LE(r.length, 32 + i * 4));
  writePoints16(rec, 32 + 4 * rings.length, all);
  return rec;
}

function deleteEmfObject(handle: number): Buffer {
  const delRec = emfRecord(EMR_DELETEOBJECT, EMF_SMALL_RECORD_SIZE);
  delRec.writeUInt32LE(handle, 8);
  return delRec;
}

function emfPolyFillMode(mode: number): Buffer {
  const rec = emfRecord(EMR_SETPOLYFILLMODE, EMF_SMALL_RECORD_SIZE);
  rec.writeUInt32LE(mode, 8);
  return rec;
}

interface EmfState {
  fillMode: number;
  scale: number;
}

function encodeEmfOp(op: DrawOp, state: EmfState, out: Buffer[]): void {
  // EMR_SETMITERLIMIT is read as UInt32 by some readers and FLOAT by GDI, so it is
  // never written; corners must agree with GDI's default limit instead.
  assertMiterCorners(op, 'EMF', GDI_DEFAULT_MITER_LIMIT);
  if (op.kind === 'stroke') {
    emitEmfPen(op.pen, out);
    out.push(emfSelect(EMF_STOCK_NULL_BRUSH));
    for (const line of op.lines) out.push(emfPoly16(EMR_POLYLINE16, line, state.scale));
    out.push(deleteEmfObject(EMF_PEN_HANDLE));
    return;
  }
  const mode = op.fillRule === 'evenodd' ? EMF_POLYFILL_ALTERNATE : EMF_POLYFILL_WINDING;
  if (mode !== state.fillMode) {
    out.push(emfPolyFillMode(mode));
    state.fillMode = mode;
  }
  const createdPen = emitEmfPen(op.pen, out);
  emitEmfBrush(op.fill, out);
  out.push(op.rings.length === 1 ? emfPoly16(EMR_POLYGON16, op.rings[0], state.scale) : emfPolyPolygon16(op.rings, state.scale));
  if (createdPen) out.push(deleteEmfObject(EMF_PEN_HANDLE));
  out.push(deleteEmfObject(EMF_BRUSH_HANDLE));
}

/** MS-EMF 2.1.14 FormatSignature ENHMETA_SIGNATURE: the ASCII string " EMF" read as a little-endian UInt32. */
const EMF_ENHMETA_SIGNATURE = 0x464d4520;

function buildEmfHeader(width: number, height: number, totalFileSize: number, totalRecordCount: number): Buffer {
  const headerRec = Buffer.alloc(EMF_HEADER_SIZE);
  headerRec.writeUInt32LE(EMR_HEADER, 0);
  headerRec.writeUInt32LE(EMF_HEADER_SIZE, 4);
  headerRec.writeInt32LE(0, 8); // rclBounds
  headerRec.writeInt32LE(0, 12);
  headerRec.writeInt32LE(width, 16);
  headerRec.writeInt32LE(height, 20);
  headerRec.writeInt32LE(0, 24); // rclFrame
  headerRec.writeInt32LE(0, 28);
  headerRec.writeInt32LE(Math.round(width * HUNDREDTHS_MM_PER_PX), 32);
  headerRec.writeInt32LE(Math.round(height * HUNDREDTHS_MM_PER_PX), 36);
  headerRec.writeUInt32LE(EMF_ENHMETA_SIGNATURE, 40);
  headerRec.writeUInt32LE(EMF_VERSION_1_0, 44);
  headerRec.writeUInt32LE(totalFileSize, 48);
  headerRec.writeUInt32LE(totalRecordCount, 52);
  headerRec.writeUInt16LE(EMF_HANDLE_COUNT, 56);
  headerRec.writeUInt16LE(0, 58);
  headerRec.writeUInt32LE(0, 60);
  headerRec.writeUInt32LE(0, 64);
  headerRec.writeUInt32LE(0, 68);
  headerRec.writeUInt32LE(width, 72);
  headerRec.writeUInt32LE(height, 76);
  headerRec.writeUInt32LE(Math.max(1, Math.round((width * MM_PER_INCH) / CSS_PX_PER_INCH)), 80);
  headerRec.writeUInt32LE(Math.max(1, Math.round((height * MM_PER_INCH) / CSS_PX_PER_INCH)), 84);
  return headerRec;
}

/**
 * Encodes an SVG document into a genuine Win32 Enhanced Metafile (EMF) binary buffer.
 */
export function encodeEmf(svgBuffer: Buffer): Buffer {
  const doc = parseDrawableSvg(svgBuffer, 'EMF');
  const width = Math.max(1, Math.round(doc.width));
  const height = Math.max(1, Math.round(doc.height));

  const deviceOps = planDocument(doc);
  const space = computeLogicalSpace(deviceOps, width, height);
  const records: Buffer[] = [...createEmfStateRecords(space)];

  const state: EmfState = { fillMode: EMF_POLYFILL_WINDING, scale: space.scale };
  for (const op of scaleOps(deviceOps, space.scale)) encodeEmfOp(op, state, records);

  // EMR_EOF
  const eofRec = emfRecord(EMR_EOF, EMF_EOF_SIZE);
  eofRec.writeUInt32LE(0, 8);
  eofRec.writeUInt32LE(0, 12);
  eofRec.writeUInt32LE(EMF_EOF_SIZE, 16); // nSizeLast
  records.push(eofRec);

  const bodySize = totalLength(records);
  assertOutputSize(EMF_HEADER_SIZE + bodySize, 'EMF');
  const headerRec = buildEmfHeader(width, height, EMF_HEADER_SIZE + bodySize, records.length + 1);

  return Buffer.concat([headerRec, ...records]);
}

// ============================================================================
// WMF ENCODER (MS-WMF Windows Metafile with Aldus Placeable Header)
// ============================================================================

// MS-WMF 2.1.1.1 RecordType values
const META_EOF = 0x0000;
const META_SETWINDOWORG = 0x020b;
const META_SETWINDOWEXT = 0x020c;
const META_SELECTOBJECT = 0x012d;
const META_DELETEOBJECT = 0x01f0;
const META_CREATEPENINDIRECT = 0x02fa;
const META_CREATEBRUSHINDIRECT = 0x02fc;
const META_POLYGON = 0x0324;
const META_POLYLINE = 0x0325;
const META_POLYPOLYGON = 0x0538;
const META_SETPOLYFILLMODE = 0x0106;
const WMF_POLYFILL_ALTERNATE = 1;
const WMF_POLYFILL_WINDING = 2;
const WMF_PS_SOLID = 0;
const WMF_PS_NULL = 5;
const WMF_BS_SOLID = 0;
const WMF_BS_HOLLOW = 1;
/** Object table slots: the pen takes 0 and the brush 1 for every shape. */
const WMF_PEN_SLOT = 0;
const WMF_BRUSH_SLOT = 1;
const WMF_OBJECT_COUNT = 2;
const WMF_PLACEABLE_KEY = 0x9ac6cdd7;
const WMF_PLACEABLE_CHECKSUM_WORDS = 10;
const WMF_MEMORY_METAFILE = 1;
const WMF_HEADER_WORDS = 9;
const WMF_VERSION_3_0 = 0x0300;

/** WMF record sizes in WORDs: RecordSize (2 words) + RecordFunction (1 word) + parameters. */
const BYTES_PER_WORD = 2;
const WMF_EOF_RECORD_WORDS = 3;
const WMF_ONE_PARAM_RECORD_WORDS = 4;
const WMF_TWO_PARAM_RECORD_WORDS = 5;
const WMF_BRUSH_RECORD_WORDS = 7; // LogBrush: style, ColorRef (2), hatch
const WMF_PEN_RECORD_WORDS = 8; // LogPen: style, PointS width (2), ColorRef (2)
const WMF_POLY_HEADER_WORDS = 4; // header + point or polygon count
const WMF_POINT_WORDS = 2;
const WMF_PLACEABLE_HEADER_SIZE = 22;

/** Allocates a WMF record with its RecordSize (in WORDs) and RecordFunction written. */
function wmfRecord(fn: number, words: number): Buffer {
  const rec = Buffer.alloc(words * BYTES_PER_WORD);
  rec.writeUInt32LE(words, 0);
  rec.writeUInt16LE(fn, 4);
  return rec;
}

function emitWmfPen(pen: PlanPen | null, out: Buffer[]): void {
  const penRec = wmfRecord(META_CREATEPENINDIRECT, WMF_PEN_RECORD_WORDS);
  if (pen) {
    penRec.writeUInt16LE(WMF_PS_SOLID | penCapJoinBits(pen), 6);
    penRec.writeInt16LE(toInt16(Math.max(1, pen.width), 'WMF pen width'), 8);
    penRec.writeUInt16LE(0, 10);
    penRec.writeUInt32LE(emfColorRef(pen.color), 12);
  } else {
    penRec.writeUInt16LE(WMF_PS_NULL, 6);
  }
  out.push(penRec, wmfSelect(WMF_PEN_SLOT));
}

function emitWmfBrush(fill: RgbColor | null, out: Buffer[]): void {
  const brushRec = wmfRecord(META_CREATEBRUSHINDIRECT, WMF_BRUSH_RECORD_WORDS);
  if (fill) {
    brushRec.writeUInt16LE(WMF_BS_SOLID, 6);
    brushRec.writeUInt32LE(emfColorRef(fill), 8);
  } else {
    brushRec.writeUInt16LE(WMF_BS_HOLLOW, 6);
  }
  out.push(brushRec, wmfSelect(WMF_BRUSH_SLOT));
}

function wmfSelect(slot: number): Buffer {
  const rec = wmfRecord(META_SELECTOBJECT, WMF_ONE_PARAM_RECORD_WORDS);
  rec.writeUInt16LE(slot, 6);
  return rec;
}

/** META_POLYGON / META_POLYLINE NumberOfPoints is a signed 16-bit field. */
const WMF_MAX_POLY_POINTS = INT16_MAX;

function assertWmfPointCount(count: number): void {
  if (count > WMF_MAX_POLY_POINTS) {
    throw new CadGeometryUnavailableError(
      `WMF encoding failed: sub-path has ${count} points, above the ${WMF_MAX_POLY_POINTS}-point record limit.`
    );
  }
}

function wmfPoly(fnCode: number, points: PlanPoint[]): Buffer {
  assertWmfPointCount(points.length);
  const rec = wmfRecord(fnCode, WMF_POLY_HEADER_WORDS + WMF_POINT_WORDS * points.length);
  rec.writeInt16LE(points.length, 6);
  writePoints16(rec, 8, points);
  return rec;
}

/** META_POLYPOLYGON (MS-WMF 2.3.3.16): one fill area made of several rings. */
function wmfPolyPolygon(rings: PlanPoint[][]): Buffer {
  rings.forEach((r) => assertWmfPointCount(r.length));
  const all = rings.flat();
  const rec = wmfRecord(META_POLYPOLYGON, WMF_POLY_HEADER_WORDS + rings.length + WMF_POINT_WORDS * all.length);
  rec.writeUInt16LE(toUnsigned(rings.length, UINT16_MAX, 'WMF polygon count'), 6);
  rings.forEach((r, i) => rec.writeUInt16LE(r.length, 8 + i * 2));
  writePoints16(rec, 8 + 2 * rings.length, all);
  return rec;
}

function wmfPolyFillMode(mode: number): Buffer {
  const rec = wmfRecord(META_SETPOLYFILLMODE, WMF_ONE_PARAM_RECORD_WORDS);
  rec.writeUInt16LE(mode, 6);
  return rec;
}

function deleteWmfObject(index: number): Buffer {
  const del = wmfRecord(META_DELETEOBJECT, WMF_ONE_PARAM_RECORD_WORDS);
  del.writeUInt16LE(index, 6);
  return del;
}

interface WmfState {
  fillMode: number;
}

/** GDI's default miter limit; WMF has no record to change it and EMF's is ambiguous, so neither sets it. */
const GDI_DEFAULT_MITER_LIMIT = 10;

/** Rejects miter corners where SVG and a fixed device limit would choose different joins. */
function assertMiterCorners(op: DrawOp, format: string, deviceLimit: number | null): void {
  for (const { points, closed } of strokedLines(op)) {
    const pen = op.pen;
    if (!pen || pen.join !== 'miter') return;
    for (const r of miterRatios(points, closed)) {
      const svgBevels = r > pen.miterLimit;
      const deviceBevels = deviceLimit === null ? false : r > deviceLimit;
      if (deviceLimit === null ? svgBevels : svgBevels !== deviceBevels) {
        throw new UnsupportedOptionError(
          `${format} cannot reproduce an SVG miter join with ratio ${r.toFixed(2)} under stroke-miterlimit ${pen.miterLimit}.`
        );
      }
    }
  }
}

function encodeWmfOp(op: DrawOp, state: WmfState, out: Buffer[]): void {
  assertMiterCorners(op, 'WMF', GDI_DEFAULT_MITER_LIMIT);
  if (op.kind === 'stroke') {
    emitWmfPen(op.pen, out);
    emitWmfBrush(null, out);
    for (const line of op.lines) out.push(wmfPoly(META_POLYLINE, line));
  } else {
    const mode = op.fillRule === 'evenodd' ? WMF_POLYFILL_ALTERNATE : WMF_POLYFILL_WINDING;
    if (mode !== state.fillMode) {
      out.push(wmfPolyFillMode(mode));
      state.fillMode = mode;
    }
    emitWmfPen(op.pen, out);
    emitWmfBrush(op.fill, out);
    out.push(op.rings.length === 1 ? wmfPoly(META_POLYGON, op.rings[0]) : wmfPolyPolygon(op.rings));
  }
  out.push(deleteWmfObject(WMF_PEN_SLOT), deleteWmfObject(WMF_BRUSH_SLOT));
}

function buildAldusHeader(width: number, height: number, unitsPerInch: number): Buffer {
  const aldusHeader = Buffer.alloc(WMF_PLACEABLE_HEADER_SIZE);
  aldusHeader.writeUInt32LE(WMF_PLACEABLE_KEY, 0);
  aldusHeader.writeUInt16LE(0, 4); // Handle
  aldusHeader.writeInt16LE(0, 6); // Left
  aldusHeader.writeInt16LE(0, 8); // Top
  aldusHeader.writeInt16LE(toInt16(width), 10); // Right
  aldusHeader.writeInt16LE(toInt16(height), 12); // Bottom
  aldusHeader.writeUInt16LE(unitsPerInch, 14); // Inch: logical units per inch
  aldusHeader.writeUInt32LE(0, 16); // Reserved

  let checksum = 0;
  for (let off = 0; off < WMF_PLACEABLE_CHECKSUM_WORDS * 2; off += 2) {
    checksum ^= aldusHeader.readUInt16LE(off);
  }
  aldusHeader.writeUInt16LE(checksum, 20);
  return aldusHeader;
}

/**
 * Encodes an SVG document into a genuine Windows Metafile (WMF) binary buffer.
 */
export function encodeWmf(svgBuffer: Buffer): Buffer {
  const doc = parseDrawableSvg(svgBuffer, 'WMF');
  const width = Math.max(1, Math.round(doc.width));
  const height = Math.max(1, Math.round(doc.height));

  const deviceOps = planDocument(doc);
  const space = computeLogicalSpace(deviceOps, width, height);
  const logicalOps = scaleOps(deviceOps, space.scale);
  const logicalWidth = Math.round(width * space.scale);
  const logicalHeight = Math.round(height * space.scale);

  const records: Buffer[] = [];

  // Window Org & Ext
  const setOrg = wmfRecord(META_SETWINDOWORG, WMF_TWO_PARAM_RECORD_WORDS);
  setOrg.writeInt16LE(0, 6);
  setOrg.writeInt16LE(0, 8);

  const setExt = wmfRecord(META_SETWINDOWEXT, WMF_TWO_PARAM_RECORD_WORDS);
  setExt.writeInt16LE(toInt16(logicalHeight), 6);
  setExt.writeInt16LE(toInt16(logicalWidth), 8);

  records.push(setOrg, setExt);

  // GDI starts with ALTERNATE; META_SETPOLYFILLMODE is written before the first shape that needs WINDING.
  const state: WmfState = { fillMode: WMF_POLYFILL_ALTERNATE };
  for (const op of logicalOps) encodeWmfOp(op, state, records);

  const eofRec = wmfRecord(META_EOF, WMF_EOF_RECORD_WORDS);
  records.push(eofRec);

  let stdBytes = 0;
  let maxRecordWords = 0;
  for (const r of records) {
    stdBytes += r.length;
    // META_HEADER.MaxRecord: size in WORDs of the largest record actually written
    maxRecordWords = Math.max(maxRecordWords, r.readUInt32LE(0));
  }
  const stdWords = Math.floor((WMF_HEADER_WORDS * BYTES_PER_WORD + stdBytes) / BYTES_PER_WORD);

  const stdHeader = Buffer.alloc(WMF_HEADER_WORDS * BYTES_PER_WORD);
  stdHeader.writeUInt16LE(WMF_MEMORY_METAFILE, 0);
  stdHeader.writeUInt16LE(WMF_HEADER_WORDS, 2);
  stdHeader.writeUInt16LE(WMF_VERSION_3_0, 4);
  stdHeader.writeUInt32LE(stdWords, 6); // FileSize in words
  stdHeader.writeUInt16LE(WMF_OBJECT_COUNT, 10);
  stdHeader.writeUInt32LE(maxRecordWords, 12);
  stdHeader.writeUInt16LE(0, 16);

  assertOutputSize(WMF_PLACEABLE_HEADER_SIZE + WMF_HEADER_WORDS * BYTES_PER_WORD + stdBytes, 'WMF');
  const aldusHeader = buildAldusHeader(logicalWidth, logicalHeight, space.unitsPerInch);
  return Buffer.concat([aldusHeader, stdHeader, ...records]);
}

// ============================================================================
// CGM ENCODER (ISO/IEC 8632 Clear-Text Encoding)
// ============================================================================

const CGM_STRING_DELIMITER = '"';

/** Quotes a clear-text CGM string; the delimiter is escaped by doubling it (ISO/IEC 8632-4). */
function quoteCgmString(str: string): string {
  const flattened = str.replace(/[\r\n]+/g, ' ').trim();
  const escaped = flattened.split(CGM_STRING_DELIMITER).join(CGM_STRING_DELIMITER + CGM_STRING_DELIMITER);
  return `${CGM_STRING_DELIMITER}${escaped}${CGM_STRING_DELIMITER}`;
}

function formatCgmPoints(points: { x: number; y: number }[]): string {
  return points.map((p) => `(${toInt16(p.x)},${toInt16(p.y)})`).join(' ');
}

/** Direct colour specifier: three colour components separated by spaces. */
function formatCgmColour(c: RgbColor): string {
  return `${c.r} ${c.g} ${c.b}`;
}

function cgmClosingPolyline(ring: PlanPoint[]): string {
  return `POLYLINE ${formatCgmPoints([...ring, ring[0]])};`;
}

/**
 * POLYGONSET (ISO/IEC 8632-1 7.6.7): each vertex carries an edge-out flag;
 * CLOSEVIS ends a ring. The set is one area, so inner rings form holes.
 */
function formatCgmPolygonSet(rings: PlanPoint[][]): string {
  const parts = rings.flatMap((ring) =>
    ring.map((p, i) => `(${toInt16(p.x)},${toInt16(p.y)}) ${i === ring.length - 1 ? 'CLOSEVIS' : 'VIS'}`)
  );
  return `POLYGONSET ${parts.join(' ')};`;
}

/**
 * CGM clear text has no fill-rule control: POLYGON and POLYGONSET interiors
 * use the even-odd rule. A nonzero fill is encoded only when even-odd gives
 * the same area; otherwise it is rejected rather than drawn differently.
 */
function assertCgmFillRule(op: FillOp, meter: WorkMeter): void {
  if (op.fillRule === 'nonzero' && nonzeroDiffersFromEvenOdd(op.rings, meter)) {
    throw new CadGeometryUnavailableError(
      'CGM encoding failed: CGM fills with the even-odd rule and this shape uses fill-rule nonzero with overlapping or same-direction nested contours.'
    );
  }
}

function formatCgmPen(pen: PlanPen, lines: string[]): void {
  // Version 1 CGM has no line cap or join elements; only the SVG defaults are accepted.
  if (pen.cap !== 'butt') {
    throw new UnsupportedOptionError(`SVG stroke-linecap "${pen.cap}" is not supported by the CGM encoder.`);
  }
  if (pen.join !== 'miter') {
    throw new UnsupportedOptionError(`SVG stroke-linejoin "${pen.join}" is not supported by the CGM encoder.`);
  }
  lines.push(`LINECOLR ${formatCgmColour(pen.color)};`, `LINEWIDTH ${toInt16(Math.max(1, pen.width), 'CGM line width')};`);
}

function formatCgmOp(op: DrawOp, lines: string[], meter: WorkMeter): void {
  // CGM has no join control: any corner SVG would bevel cannot be expressed.
  assertMiterCorners(op, 'CGM', null);
  if (op.kind === 'stroke') {
    formatCgmPen(op.pen, lines);
    for (const line of op.lines) lines.push(`POLYLINE ${formatCgmPoints(line)};`);
    return;
  }
  assertCgmFillRule(op, meter);
  lines.push(`FILLCOLR ${formatCgmColour(op.fill)};`);
  lines.push(op.rings.length === 1 ? `POLYGON ${formatCgmPoints(op.rings[0])};` : formatCgmPolygonSet(op.rings));
  if (op.pen) {
    formatCgmPen(op.pen, lines);
    for (const ring of op.rings) lines.push(cgmClosingPolyline(ring));
  }
}

/**
 * Encodes an SVG document into standard ISO 8632 clear-text Computer Graphics Metafile (CGM).
 */
export function encodeCgm(svgBuffer: Buffer, baseName: string = 'drawing'): Buffer {
  const doc = parseDrawableSvg(svgBuffer, 'CGM');
  const width = Math.max(1, Math.round(doc.width));
  const height = Math.max(1, Math.round(doc.height));
  const quotedName = quoteCgmString(baseName || 'drawing');

  // VDC integers are 16-bit by default, so large drawings use a scaled VDC space.
  const deviceOps = planDocument(doc);
  const space = computeLogicalSpace(deviceOps, width, height);
  const vdcWidth = Math.round(width * space.scale);
  const vdcHeight = Math.round(height * space.scale);

  // VDC space has its y axis pointing up; listing the bottom-left corner as
  // (0,height) and the top-right as (width,0) keeps SVG coordinates unmirrored.
  const lines: string[] = [
    `BEGMF ${quotedName};`,
    'MFVERSION 1;',
    `MFDESC ${quoteCgmString('Generated by EasyConvert Vector Engine')};`,
    `MFELEMLIST ${quoteCgmString('DRAWINGSET')};`,
    `BEGPIC ${quotedName};`,
    'COLRMODE DIRECT;',
    // Line widths are absolute VDC lengths, matching device-scaled SVG stroke widths
    'LINEWIDTHMODE ABS;',
    `VDCEXT (0,${vdcHeight}) (${vdcWidth},0);`,
    'BEGPICBODY;',
    'INTSTYLE SOLID;',
  ];

  const meter = new WorkMeter();
  let outputChars = 0;
  for (const op of scaleOps(deviceOps, space.scale)) {
    const before = lines.length;
    formatCgmOp(op, lines, meter);
    for (let k = before; k < lines.length; k++) outputChars += lines[k].length + 1;
    assertOutputSize(outputChars, 'CGM');
  }

  lines.push('ENDPIC;', 'ENDMF;', '');
  return Buffer.from(lines.join('\n'), 'utf-8');
}
