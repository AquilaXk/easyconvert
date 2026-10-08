/**
 * Independent TrueType writer for tests, authored from the OpenType glyf, loca, cmap, hhea, hmtx and
 * maxp specifications with no dependency on src/. Unlike the minimal builder in
 * mac-font-containers.ts it supports off-curve points, composite glyphs, arbitrary units per em,
 * short or long loca offsets and compact (short vector, repeated flag) coordinate encoding.
 */
import { assembleSfnt, buildNameTable } from './mac-font-containers';

export interface GlyfPoint {
  x: number;
  y: number;
  /** On-curve point (default true). */
  on?: boolean;
}

export interface GlyfComponent {
  glyphIndex: number;
  dx: number;
  dy: number;
  /** Uniform scale (WE_HAVE_A_SCALE). */
  scale?: number;
  /** Two by two matrix [xscale, scale01, scale10, yscale] (WE_HAVE_A_TWO_BY_TWO). */
  matrix?: [number, number, number, number];
  /** Point-matching arguments instead of x/y offsets (unsupported by the engine). */
  pointMatching?: boolean;
}

export interface GlyfGlyphSpec {
  codePoint?: number;
  advance: number;
  contours?: GlyfPoint[][];
  components?: GlyfComponent[];
}

export interface GlyfFontSpec {
  family: string;
  unitsPerEm?: number;
  /** Glyphs 1..n; glyph 0 (.notdef) is empty unless `notdef` is given. */
  glyphs: GlyfGlyphSpec[];
  notdef?: GlyfGlyphSpec;
  shortLoca?: boolean;
  compact?: boolean;
  ascender?: number;
  descender?: number;
}

const SFNT_TRUETYPE = 0x00010000;
const HEAD_MAGIC = 0x5f0f3cf5;
const F2DOT14 = 16384;

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

function pad4(data: Buffer): Buffer {
  const remainder = data.length % 4;
  return remainder === 0 ? data : Buffer.concat([data, Buffer.alloc(4 - remainder)]);
}

function encodeAxis(
  values: number[],
  flags: number[],
  shortBit: number,
  sameBit: number,
  compact: boolean
): Buffer {
  const chunks: number[] = [];
  let previous = 0;
  values.forEach((value, i) => {
    const delta = value - previous;
    previous = value;
    if (compact && delta === 0) {
      flags[i] |= sameBit;
    } else if (compact && Math.abs(delta) <= 255) {
      flags[i] |= shortBit;
      if (delta > 0) flags[i] |= sameBit;
      chunks.push(Math.abs(delta));
    } else {
      chunks.push((delta >> 8) & 0xff, delta & 0xff);
    }
  });
  return Buffer.from(chunks);
}

function simpleGlyphRecord(contours: GlyfPoint[][], compact: boolean): Buffer {
  const points = contours.flat();
  const endPoints: number[] = [];
  let running = -1;
  for (const contour of contours) {
    running += contour.length;
    endPoints.push(running);
  }
  const header = Buffer.alloc(10 + endPoints.length * 2 + 2);
  header.writeInt16BE(contours.length, 0);
  header.writeInt16BE(Math.min(...points.map((p) => p.x)), 2);
  header.writeInt16BE(Math.min(...points.map((p) => p.y)), 4);
  header.writeInt16BE(Math.max(...points.map((p) => p.x)), 6);
  header.writeInt16BE(Math.max(...points.map((p) => p.y)), 8);
  endPoints.forEach((end, i) => header.writeUInt16BE(end, 10 + i * 2));
  header.writeUInt16BE(0, 10 + endPoints.length * 2); // instructionLength

  const flags = points.map((p) => (p.on === false ? 0 : FLAG_ON_CURVE));
  const xs = encodeAxis(points.map((p) => p.x), flags, FLAG_X_SHORT, FLAG_X_SAME_OR_POSITIVE, compact);
  const ys = encodeAxis(points.map((p) => p.y), flags, FLAG_Y_SHORT, FLAG_Y_SAME_OR_POSITIVE, compact);
  const flagBytes: number[] = [];
  for (let i = 0; i < flags.length; ) {
    let run = 1;
    while (compact && i + run < flags.length && flags[i + run] === flags[i] && run < 256) run++;
    if (run > 1) {
      flagBytes.push(flags[i] | FLAG_REPEAT, run - 1);
    } else {
      flagBytes.push(flags[i]);
    }
    i += run;
  }
  return pad4(Buffer.concat([header, Buffer.from(flagBytes), xs, ys]));
}

/** Bounding box of the transformed component points (components must be simple glyphs). */
function compositeBox(components: GlyfComponent[], glyphs: GlyfGlyphSpec[]): [number, number, number, number] {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const component of components) {
    const source = glyphs[component.glyphIndex];
    const [xx, yx, xy, yy] = component.matrix ?? [component.scale ?? 1, 0, 0, component.scale ?? 1];
    for (const p of (source?.contours ?? []).flat()) {
      xs.push(xx * p.x + xy * p.y + component.dx);
      ys.push(yx * p.x + yy * p.y + component.dy);
    }
  }
  if (xs.length === 0) return [0, 0, 0, 0];
  // Loops, not Math.min(...xs): a composite of thousands of components has more points than a call can take as arguments.
  const extent = (values: number[]): [number, number] => {
    let low = values[0];
    let high = values[0];
    for (const value of values) {
      if (value < low) low = value;
      if (value > high) high = value;
    }
    return [low, high];
  };
  const [xMin, xMax] = extent(xs);
  const [yMin, yMax] = extent(ys);
  return [Math.floor(xMin), Math.floor(yMin), Math.ceil(xMax), Math.ceil(yMax)];
}

function compositeGlyphRecord(components: GlyfComponent[], box: [number, number, number, number]): Buffer {
  const header = Buffer.alloc(10);
  header.writeInt16BE(-1, 0);
  box.forEach((value, i) => header.writeInt16BE(value, 2 + i * 2));
  const parts: Buffer[] = [header];
  components.forEach((component, i) => {
    let flags = COMPONENT_ARG_WORDS;
    if (!component.pointMatching) flags |= COMPONENT_ARGS_ARE_XY;
    if (component.scale !== undefined) flags |= COMPONENT_HAVE_SCALE;
    if (component.matrix !== undefined) flags |= COMPONENT_HAVE_TWO_BY_TWO;
    if (i < components.length - 1) flags |= COMPONENT_MORE;
    const record = Buffer.alloc(8 + (component.matrix ? 8 : 0) + (component.scale === undefined ? 0 : 2));
    record.writeUInt16BE(flags, 0);
    record.writeUInt16BE(component.glyphIndex, 2);
    record.writeInt16BE(component.dx, 4);
    record.writeInt16BE(component.dy, 6);
    if (component.scale !== undefined) record.writeInt16BE(Math.round(component.scale * F2DOT14), 8);
    if (component.matrix) {
      // Order on disk: xscale, scale01, scale10, yscale
      component.matrix.forEach((v, k) => record.writeInt16BE(Math.round(v * F2DOT14), 8 + k * 2));
    }
    parts.push(record);
  });
  return pad4(Buffer.concat(parts));
}

function buildCmapFormat4(entries: Array<{ codePoint: number; glyphId: number }>): Buffer {
  const sorted = [...entries].sort((a, b) => a.codePoint - b.codePoint);
  const segCount = sorted.length + 1;
  const subtable = Buffer.alloc(16 + segCount * 8);
  subtable.writeUInt16BE(4, 0);
  subtable.writeUInt16BE(subtable.length, 2);
  subtable.writeUInt16BE(segCount * 2, 6);
  const entrySelector = Math.floor(Math.log2(segCount));
  const searchRange = 2 * 2 ** entrySelector;
  subtable.writeUInt16BE(searchRange, 8);
  subtable.writeUInt16BE(entrySelector, 10);
  subtable.writeUInt16BE(segCount * 2 - searchRange, 12);
  const endBase = 14;
  const startBase = endBase + segCount * 2 + 2;
  const deltaBase = startBase + segCount * 2;
  sorted.forEach((entry, i) => {
    subtable.writeUInt16BE(entry.codePoint, endBase + i * 2);
    subtable.writeUInt16BE(entry.codePoint, startBase + i * 2);
    subtable.writeUInt16BE((entry.glyphId - entry.codePoint) & 0xffff, deltaBase + i * 2);
  });
  const last = sorted.length;
  subtable.writeUInt16BE(0xffff, endBase + last * 2);
  subtable.writeUInt16BE(0xffff, startBase + last * 2);
  subtable.writeUInt16BE(1, deltaBase + last * 2);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 2);
  header.writeUInt16BE(3, 4);
  header.writeUInt16BE(1, 6);
  header.writeUInt32BE(12, 8);
  return Buffer.concat([header, subtable]);
}

export function buildGlyfFont(spec: GlyfFontSpec): Buffer {
  const upem = spec.unitsPerEm ?? 1000;
  const ascender = spec.ascender ?? Math.round(upem * 0.8);
  const descender = spec.descender ?? -Math.round(upem * 0.2);
  const notdef: GlyfGlyphSpec = spec.notdef ?? { advance: Math.round(upem / 2) };
  const all = [notdef, ...spec.glyphs];
  const compact = spec.compact === true;
  const records = all.map((g) => {
    if (g.components !== undefined) return compositeGlyphRecord(g.components, compositeBox(g.components, all));
    if (g.contours !== undefined && g.contours.length > 0) return simpleGlyphRecord(g.contours, compact);
    return Buffer.alloc(0);
  });
  const numGlyphs = all.length;

  const shortLoca = spec.shortLoca === true;
  const loca = Buffer.alloc((numGlyphs + 1) * (shortLoca ? 2 : 4));
  let offset = 0;
  const writeLoca = (index: number, value: number): void => {
    if (shortLoca) {
      loca.writeUInt16BE(value / 2, index * 2);
    } else {
      loca.writeUInt32BE(value, index * 4);
    }
  };
  records.forEach((record, i) => {
    writeLoca(i, offset);
    offset += record.length;
  });
  writeLoca(numGlyphs, offset);
  const glyf = Buffer.concat(records);

  const points = all.flatMap((g) => (g.contours ?? []).flat());
  // Reduced in a loop: spreading tens of thousands of points into Math.min / Math.max overflows the call stack.
  let xMin = 0;
  let yMin = 0;
  let xMax = 0;
  let yMax = 0;
  points.forEach((point, index) => {
    xMin = index === 0 ? point.x : Math.min(xMin, point.x);
    yMin = index === 0 ? point.y : Math.min(yMin, point.y);
    xMax = index === 0 ? point.x : Math.max(xMax, point.x);
    yMax = index === 0 ? point.y : Math.max(yMax, point.y);
  });
  const maxAdvance = all.reduce((largest, g) => Math.max(largest, g.advance), 0);

  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt32BE(0x00010000, 4);
  head.writeUInt32BE(HEAD_MAGIC, 12);
  head.writeUInt16BE(0x000b, 16);
  head.writeUInt16BE(upem, 18);
  head.writeInt16BE(xMin, 36);
  head.writeInt16BE(yMin, 38);
  head.writeInt16BE(xMax, 40);
  head.writeInt16BE(yMax, 42);
  head.writeInt16BE(7, 46);
  head.writeInt16BE(2, 48);
  head.writeInt16BE(shortLoca ? 0 : 1, 50);

  const hhea = Buffer.alloc(36);
  hhea.writeUInt32BE(0x00010000, 0);
  hhea.writeInt16BE(ascender, 4);
  hhea.writeInt16BE(descender, 6);
  hhea.writeUInt16BE(maxAdvance, 10);
  hhea.writeInt16BE(xMin, 12);
  hhea.writeInt16BE(xMax, 16);
  hhea.writeInt16BE(1, 18);
  hhea.writeUInt16BE(numGlyphs, 34);

  const maxp = Buffer.alloc(32);
  maxp.writeUInt32BE(0x00010000, 0);
  maxp.writeUInt16BE(numGlyphs, 4);
  maxp.writeUInt16BE(Math.max(...all.map((g) => (g.contours ?? []).flat().length)), 6);
  maxp.writeUInt16BE(Math.max(...all.map((g) => (g.contours ?? []).length)), 8);
  maxp.writeUInt16BE(2, 14);
  maxp.writeUInt16BE(1, 24);

  const hmtx = Buffer.alloc(numGlyphs * 4);
  all.forEach((g, i) => {
    hmtx.writeUInt16BE(g.advance, i * 4);
    const gx = (g.contours ?? []).flat();
    let lsb = gx.length > 0 ? Math.min(...gx.map((p) => p.x)) : 0;
    if (g.components !== undefined) lsb = compositeBox(g.components, all)[0];
    hmtx.writeInt16BE(lsb, i * 4 + 2);
  });

  const mapped = spec.glyphs
    .map((g, i) => ({ codePoint: g.codePoint, glyphId: i + 1 }))
    .filter((entry): entry is { codePoint: number; glyphId: number } => entry.codePoint !== undefined);

  const post = Buffer.alloc(32);
  post.writeUInt32BE(0x00030000, 0);

  const tables: Record<string, Buffer> = {
    cmap: buildCmapFormat4(mapped),
    glyf,
    head,
    hhea,
    hmtx,
    loca,
    maxp,
    name: buildNameTable(spec.family, 'Regular'),
    post,
  };
  return assembleSfnt(SFNT_TRUETYPE, tables);
}
