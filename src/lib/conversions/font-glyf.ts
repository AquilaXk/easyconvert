import { ConversionFailedError } from '../types';
import type { GlyphPoint } from './font';

/**
 * Strict TrueType glyf outline reader (OpenType glyf table specification). Unlike a lenient
 * reader it throws ConversionFailedError for every inconsistency: a loca table that does not match
 * the glyph count or runs past glyf, truncated glyph data, composite glyphs that loop, reference a
 * missing glyph or place a component by point matching. Composite glyphs are flattened into
 * simple contours, so callers always see real outlines.
 */

export interface GlyfSource {
  glyf: Buffer;
  loca: Buffer;
  /** head.indexToLocFormat: 0 for 16-bit (halved) offsets, 1 for 32-bit offsets. */
  indexToLocFormat: number;
  numGlyphs: number;
}

/** Deepest component nesting accepted; OpenType fonts stay far below this. */
export const GLYF_MAX_COMPOSITE_DEPTH = 8;
/** Components visited while resolving one glyph, which bounds the work a hostile font can cause. */
export const GLYF_MAX_COMPONENT_VISITS = 4096;
/** Points one glyph may have after composites are flattened (the glyf point count is 16 bits). */
export const GLYF_MAX_POINTS_PER_GLYPH = 0xffff;
/**
 * Points all glyphs of a font may have after composites are flattened: a floor for small fonts plus
 * a share per byte of glyf, so a few KB of composites that reuse one another cannot expand into
 * millions of points. Composites are compact (a three component syllable is about 30 bytes and
 * flattens to hundreds of points), so the share is far above the one point per byte of simple
 * glyphs: a Hangul font with 11,172 syllables needs 4 points per byte. The absolute cap keeps
 * padding from buying a bigger budget; it matches the budget of the CFF to TrueType conversion.
 */
export const GLYF_BASE_OUTPUT_POINTS = 250_000;
export const GLYF_OUTPUT_POINTS_PER_TABLE_BYTE = 8;
export const GLYF_ABSOLUTE_MAX_OUTPUT_POINTS = 12_000_000;

const LOCA_FORMAT_SHORT = 0;
const LOCA_FORMAT_LONG = 1;
const SHORT_LOCA_UNIT = 2;
const SHORT_LOCA_ENTRY_BYTES = 2;
const LONG_LOCA_ENTRY_BYTES = 4;
const GLYPH_HEADER_BYTES = 10;
const COMPOSITE_CONTOUR_COUNT = -1;

const FLAG_ON_CURVE = 0x01;
const FLAG_X_SHORT = 0x02;
const FLAG_Y_SHORT = 0x04;
const FLAG_REPEAT = 0x08;
const FLAG_X_SAME_OR_POSITIVE = 0x10;
const FLAG_Y_SAME_OR_POSITIVE = 0x20;

const COMPONENT_ARG_WORDS = 0x0001;
const COMPONENT_ARGS_ARE_XY = 0x0002;
const COMPONENT_HAVE_SCALE = 0x0008;
const COMPONENT_MORE = 0x0020;
const COMPONENT_HAVE_XY_SCALE = 0x0040;
const COMPONENT_HAVE_TWO_BY_TWO = 0x0080;
const COMPONENT_HAVE_INSTRUCTIONS = 0x0100;
const COMPONENT_SCALED_OFFSET = 0x0800;
const COMPONENT_UNSCALED_OFFSET = 0x1000;
const F2DOT14_DIVISOR = 16384;

class GlyphReader {
  private pos: number;

  constructor(
    private readonly data: Buffer,
    private readonly end: number,
    start: number,
    private readonly glyphId: number
  ) {
    this.pos = start;
  }

  private need(bytes: number): void {
    if (this.pos + bytes > this.end) {
      throw new ConversionFailedError(`Invalid font: glyph ${this.glyphId} in 'glyf' is truncated.`);
    }
  }

  u8(): number {
    this.need(1);
    return this.data[this.pos++];
  }

  i8(): number {
    this.need(1);
    return this.data.readInt8(this.pos++);
  }

  u16(): number {
    this.need(2);
    const value = this.data.readUInt16BE(this.pos);
    this.pos += 2;
    return value;
  }

  i16(): number {
    this.need(2);
    const value = this.data.readInt16BE(this.pos);
    this.pos += 2;
    return value;
  }

  skip(bytes: number): void {
    this.need(bytes);
    this.pos += bytes;
  }
}

function readLocaOffsets(source: GlyfSource): number[] {
  const { loca, glyf, indexToLocFormat, numGlyphs } = source;
  if (indexToLocFormat !== LOCA_FORMAT_SHORT && indexToLocFormat !== LOCA_FORMAT_LONG) {
    throw new ConversionFailedError(`Invalid font: head.indexToLocFormat ${indexToLocFormat} is neither 0 nor 1.`);
  }
  const long = indexToLocFormat === LOCA_FORMAT_LONG;
  const entryBytes = long ? LONG_LOCA_ENTRY_BYTES : SHORT_LOCA_ENTRY_BYTES;
  const entries = numGlyphs + 1;
  if (loca.length < entries * entryBytes) {
    throw new ConversionFailedError(
      `Invalid font: 'loca' has ${Math.floor(loca.length / entryBytes)} entries but ${numGlyphs} glyphs need ${entries}.`
    );
  }
  const offsets: number[] = [];
  let previous = 0;
  for (let i = 0; i < entries; i++) {
    const offset = long ? loca.readUInt32BE(i * entryBytes) : loca.readUInt16BE(i * entryBytes) * SHORT_LOCA_UNIT;
    if (offset < previous) {
      throw new ConversionFailedError(`Invalid font: 'loca' offset ${i} (${offset}) is smaller than the one before it (${previous}).`);
    }
    if (offset > glyf.length) {
      throw new ConversionFailedError(`Invalid font: 'loca' offset ${i} (${offset}) lies beyond the end of 'glyf' (${glyf.length} bytes).`);
    }
    offsets.push(offset);
    previous = offset;
  }
  return offsets;
}

function readSimpleGlyph(reader: GlyphReader, contourCount: number, glyphId: number): GlyphPoint[][] {
  const endPoints: number[] = [];
  for (let c = 0; c < contourCount; c++) {
    const endPoint = reader.u16();
    if (c > 0 && endPoint <= endPoints[c - 1]) {
      throw new ConversionFailedError(`Invalid font: glyph ${glyphId} has contour end points that do not increase.`);
    }
    endPoints.push(endPoint);
  }
  const pointCount = endPoints[contourCount - 1] + 1;
  if (pointCount > GLYF_MAX_POINTS_PER_GLYPH) {
    throw new ConversionFailedError(`Invalid font: glyph ${glyphId} has more than ${GLYF_MAX_POINTS_PER_GLYPH} points.`);
  }
  reader.skip(reader.u16()); // instructions are not needed for outlines

  const flags: number[] = [];
  while (flags.length < pointCount) {
    const flag = reader.u8();
    flags.push(flag);
    if (flag & FLAG_REPEAT) {
      const repeat = reader.u8();
      if (flags.length + repeat > pointCount) {
        throw new ConversionFailedError(`Invalid font: glyph ${glyphId} repeats flags past its last point.`);
      }
      for (let r = 0; r < repeat; r++) flags.push(flag);
    }
  }

  const coordinates = (shortBit: number, sameOrPositiveBit: number): number[] => {
    const values: number[] = [];
    let value = 0;
    for (const flag of flags) {
      if (flag & shortBit) {
        const delta = reader.u8();
        value += flag & sameOrPositiveBit ? delta : -delta;
      } else if (!(flag & sameOrPositiveBit)) {
        value += reader.i16();
      }
      values.push(value);
    }
    return values;
  };
  const xs = coordinates(FLAG_X_SHORT, FLAG_X_SAME_OR_POSITIVE);
  const ys = coordinates(FLAG_Y_SHORT, FLAG_Y_SAME_OR_POSITIVE);

  const contours: GlyphPoint[][] = [];
  let first = 0;
  for (const last of endPoints) {
    const contour: GlyphPoint[] = [];
    for (let i = first; i <= last; i++) contour.push({ x: xs[i], y: ys[i], onCurve: (flags[i] & FLAG_ON_CURVE) !== 0 });
    contours.push(contour);
    first = last + 1;
  }
  return contours;
}

interface ResolveBudget {
  /** Components visited while resolving the current glyph. */
  visits: number;
  /** Points the current glyph has after flattening. */
  points: number;
}

/** State shared by every glyph of one font. */
interface FontResolveState {
  /** Points still allowed across the font; every flattened component spends from it. */
  pointsLeft: number;
  /** Simple glyphs already parsed, so a component shared by many composites is read once. Never mutated. */
  simpleGlyphs: Map<number, GlyphPoint[][]>;
}

type Matrix = [number, number, number, number];

function resolveGlyph(
  source: GlyfSource,
  offsets: number[],
  glyphId: number,
  depth: number,
  budget: ResolveBudget,
  state: FontResolveState
): GlyphPoint[][] {
  if (glyphId < 0 || glyphId >= source.numGlyphs) {
    throw new ConversionFailedError(`Invalid font: a composite glyph references glyph ${glyphId}, but the font has ${source.numGlyphs} glyphs.`);
  }
  budget.visits++;
  if (depth > GLYF_MAX_COMPOSITE_DEPTH || budget.visits > GLYF_MAX_COMPONENT_VISITS) {
    throw new ConversionFailedError(
      `Invalid font: composite glyph nesting exceeds the limit (depth ${GLYF_MAX_COMPOSITE_DEPTH}, ${GLYF_MAX_COMPONENT_VISITS} components) at glyph ${glyphId}.`
    );
  }
  const start = offsets[glyphId];
  const end = offsets[glyphId + 1];
  if (end === start) return [];
  const reader = new GlyphReader(source.glyf, end, start, glyphId);
  const contourCount = reader.i16();
  reader.skip(GLYPH_HEADER_BYTES - 2); // bounding box: recomputed from the points by writers
  if (contourCount === 0) return [];
  if (contourCount > 0) {
    let contours = state.simpleGlyphs.get(glyphId);
    if (contours === undefined) {
      contours = readSimpleGlyph(reader, contourCount, glyphId);
      state.simpleGlyphs.set(glyphId, contours);
    }
    const pointCount = contours.reduce((sum, c) => sum + c.length, 0);
    budget.points += pointCount;
    if (budget.points > GLYF_MAX_POINTS_PER_GLYPH) {
      throw new ConversionFailedError(`Invalid font: glyph ${glyphId} expands to more than ${GLYF_MAX_POINTS_PER_GLYPH} points.`);
    }
    // Spent on every use: each use of a shared component copies its points into the composite.
    state.pointsLeft -= pointCount;
    if (state.pointsLeft < 0) {
      throw new ConversionFailedError(
        `Invalid font: composite glyphs expand to more points than the font budget allows (reached at component glyph ${glyphId}).`
      );
    }
    return contours;
  }
  if (contourCount !== COMPOSITE_CONTOUR_COUNT) {
    throw new ConversionFailedError(`Invalid font: glyph ${glyphId} declares ${contourCount} contours.`);
  }

  const result: GlyphPoint[][] = [];
  let flags: number;
  do {
    flags = reader.u16();
    const componentId = reader.u16();
    if (!(flags & COMPONENT_ARGS_ARE_XY)) {
      throw new ConversionFailedError(
        `Cannot convert glyph ${glyphId}: component ${componentId} is placed by point matching, which is not supported.`
      );
    }
    let dx: number;
    let dy: number;
    if (flags & COMPONENT_ARG_WORDS) {
      dx = reader.i16();
      dy = reader.i16();
    } else {
      dx = reader.i8();
      dy = reader.i8();
    }
    let matrix: Matrix = [1, 0, 0, 1];
    if (flags & COMPONENT_HAVE_SCALE) {
      const scale = reader.i16() / F2DOT14_DIVISOR;
      matrix = [scale, 0, 0, scale];
    } else if (flags & COMPONENT_HAVE_XY_SCALE) {
      const xScale = reader.i16() / F2DOT14_DIVISOR;
      const yScale = reader.i16() / F2DOT14_DIVISOR;
      matrix = [xScale, 0, 0, yScale];
    } else if (flags & COMPONENT_HAVE_TWO_BY_TWO) {
      // On disk: xscale, scale01, scale10, yscale. x' = xscale x + scale10 y, y' = scale01 x + yscale y.
      const xScale = reader.i16() / F2DOT14_DIVISOR;
      const scale01 = reader.i16() / F2DOT14_DIVISOR;
      const scale10 = reader.i16() / F2DOT14_DIVISOR;
      const yScale = reader.i16() / F2DOT14_DIVISOR;
      matrix = [xScale, scale01, scale10, yScale];
    }
    const [xx, yx, xy, yy] = matrix;
    if (flags & COMPONENT_SCALED_OFFSET && !(flags & COMPONENT_UNSCALED_OFFSET)) {
      dx *= Math.hypot(xx, xy);
      dy *= Math.hypot(yy, yx);
    }
    for (const contour of resolveGlyph(source, offsets, componentId, depth + 1, budget, state)) {
      result.push(contour.map((p) => ({ x: xx * p.x + xy * p.y + dx, y: yx * p.x + yy * p.y + dy, onCurve: p.onCurve })));
    }
  } while (flags & COMPONENT_MORE);
  if (flags & COMPONENT_HAVE_INSTRUCTIONS) reader.skip(reader.u16());
  return result;
}

/**
 * Reads the outline of every glyph as contours of points, with composite glyphs flattened. The
 * result has one entry per glyph id; an empty glyph (a space) has no contours.
 */
export function readGlyfOutlines(source: GlyfSource): GlyphPoint[][][] {
  const offsets = readLocaOffsets(source);
  const state: FontResolveState = {
    pointsLeft: Math.min(
      GLYF_BASE_OUTPUT_POINTS + GLYF_OUTPUT_POINTS_PER_TABLE_BYTE * source.glyf.length,
      GLYF_ABSOLUTE_MAX_OUTPUT_POINTS
    ),
    simpleGlyphs: new Map(),
  };
  const outlines: GlyphPoint[][][] = [];
  for (let glyphId = 0; glyphId < source.numGlyphs; glyphId++) {
    outlines.push(resolveGlyph(source, offsets, glyphId, 0, { visits: 0, points: 0 }, state));
  }
  return outlines;
}
