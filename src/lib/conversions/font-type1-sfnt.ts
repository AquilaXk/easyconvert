import {
  GlyphPoint,
  ParsedFont,
  SfntTable,
  buildCffIndex,
  buildGlyfAndLoca,
  calculateTableChecksum,
  createFormat12Subtable,
  createFormat4Subtable,
  encodeCffNumber,
  encodeSfnt,
} from './font';
import { Type1Font, Type1PathCommand, Type1FontError, parseType1Font } from './font-type1';
import { AGL_ENTRIES, ZAPF_DINGBATS_ENTRIES } from './font-type1-data';

/**
 * Builds TrueType (glyf) and OpenType (CFF) fonts from a parsed Type 1 font.
 *
 * Outlines stay cubic for CFF (Type 2 charstrings) and are approximated by quadratic splines for
 * glyf. The cmap comes from the Adobe Glyph List, hmtx from the hsbw advances, and name, OS/2,
 * post, head, hhea and maxp from the font dictionary and the glyph geometry.
 */

export type Type1OutputFlavor = 'ttf' | 'otf';

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

const SFNT_VERSION_TRUETYPE = 0x00010000;
const SFNT_VERSION_CFF = 0x4f54544f;
const HEAD_MAGIC = 0x5f0f3cf5;
const HEAD_CHECKSUM_TARGET = 0xb1b0afba;
const HEAD_TABLE_LENGTH = 54;
const HEAD_CHECKSUM_ADJUSTMENT_OFFSET = 8;
const HEAD_FLAG_BASELINE_AT_ZERO = 0x0001;
const HEAD_LOWEST_REC_PPEM = 8;
const HEAD_DIRECTION_HINT_MIXED = 2;
const HEAD_MAC_STYLE_BOLD = 0x0001;
const HEAD_MAC_STYLE_ITALIC = 0x0002;
const HHEA_TABLE_LENGTH = 36;
const MAXP_TRUETYPE_LENGTH = 32;
const MAXP_CFF_LENGTH = 6;
const MAXP_VERSION_CFF = 0x00005000;
const MAXP_ZONES = 1;
const OS2_TABLE_LENGTH = 96;
const OS2_VERSION = 4;
const OS2_WIDTH_CLASS_MEDIUM = 5;
const OS2_FS_ITALIC = 0x0001;
const OS2_FS_BOLD = 0x0020;
const OS2_FS_REGULAR = 0x0040;
const OS2_FS_USE_TYPO_METRICS = 0x0080;
const OS2_BREAK_CHAR = 0x20;
const OS2_VENDOR_ID = 'NONE';
const POST_TABLE_HEADER_LENGTH = 32;
const POST_VERSION_NAMED = 0x00020000;
const POST_VERSION_NONE = 0x00030000;
const POST_CUSTOM_NAME_BASE = 258;
const FIXED_ONE = 0x10000;

const MIN_UNITS_PER_EM = 16;
const MAX_UNITS_PER_EM = 16384;
const DEFAULT_UNITS_PER_EM = 1000;
const INT16_MIN = -32768;
const INT16_MAX = 32767;
const UINT16_MAX = 0xffff;
const MAX_POSTSCRIPT_NAME_LENGTH = 63;
const MAX_CFF_INDEX_BYTES = 0xfffffe;
const MAX_UNICODE = 0x10ffff;
const SURROGATE_START = 0xd800;
const SURROGATE_END = 0xdfff;
const PRIVATE_USE_SYMBOL_BASE = 0xf000;
const BASIC_LATIN_FIRST = 0x20;
const BASIC_LATIN_LAST = 0x7e;
const BMP_LAST = 0xffff;
const FIRST_NAME_ID_TYPOGRAPHIC = 16;

/** Quadratic approximation error, as a fraction of the em square (0.5 unit at 1000 units per em). */
const QUADRATIC_TOLERANCE_EM = 0.0005;
const CUBIC_TO_QUADRATIC_ERROR_FACTOR = Math.sqrt(3) / 36;
const MAX_QUADRATIC_PIECES = 64;
const SUBSCRIPT_SIZE_X_EM = 0.65;
const SUBSCRIPT_SIZE_Y_EM = 0.6;
const SUBSCRIPT_OFFSET_Y_EM = 0.14;
const SUPERSCRIPT_OFFSET_Y_EM = 0.48;
const STRIKEOUT_SIZE_EM = 0.05;
const STRIKEOUT_POSITION_EM = 0.26;
const CARET_RISE_BASE = 1000;
const DEGREES_TO_RADIANS = Math.PI / 180;

// CFF (Adobe Technical Note 5176)
const CFF_HEADER = Buffer.from([1, 0, 4, 4]);
const CFF_STANDARD_STRING_COUNT = 391;
const CFF_OP_FULL_NAME = 2;
const CFF_OP_FAMILY_NAME = 3;
const CFF_OP_WEIGHT = 4;
const CFF_OP_FONT_BBOX = 5;
const CFF_OP_CHARSET = 15;
const CFF_OP_CHARSTRINGS = 17;
const CFF_OP_PRIVATE = 18;
const CFF_OP_ESCAPE = 12;
const CFF_OP_FONT_MATRIX = 7;
const CFF_OP_DEFAULT_WIDTH_X = 20;
const CFF_OP_NOMINAL_WIDTH_X = 21;
const CFF_CHARSET_FORMAT_0 = 0;
const CFF_DICT_INT32 = 0x1d;
const CFF_REAL_PREFIX = 30;
const CFF_REAL_END_NIBBLE = 0xf;
const CFF_REAL_POINT_NIBBLE = 0xa;
const CFF_REAL_MINUS_NIBBLE = 0xe;
const CFF_FONT_MATRIX_DECIMALS = 12;
const T2_RMOVETO = 21;
const T2_RLINETO = 5;
const T2_RRCURVETO = 8;
const T2_ENDCHAR = 14;

const REGULAR_WEIGHT_CLASS = 400;
const BOLD_WEIGHT_CLASS = 700;
const WEIGHT_CLASSES: ReadonlyMap<string, number> = new Map([
  ['thin', 100],
  ['hairline', 100],
  ['extralight', 200],
  ['ultralight', 200],
  ['extra light', 200],
  ['ultra light', 200],
  ['light', 300],
  ['book', 400],
  ['regular', 400],
  ['roman', 400],
  ['normal', 400],
  ['plain', 400],
  ['medium', 500],
  ['semibold', 600],
  ['demibold', 600],
  ['demi', 600],
  ['semi bold', 600],
  ['demi bold', 600],
  ['bold', 700],
  ['extrabold', 800],
  ['ultrabold', 800],
  ['extra bold', 800],
  ['ultra bold', 800],
  ['heavy', 800],
  ['black', 900],
]);

/** OS/2 ulUnicodeRange bits for the Unicode blocks a Type 1 font commonly covers. */
const UNICODE_RANGE_BITS: ReadonlyArray<readonly [number, number, number]> = [
  [0x0000, 0x007f, 0],
  [0x0080, 0x00ff, 1],
  [0x0100, 0x017f, 2],
  [0x0180, 0x024f, 3],
  [0x0250, 0x02af, 4],
  [0x02b0, 0x02ff, 5],
  [0x0300, 0x036f, 6],
  [0x0370, 0x03ff, 7],
  [0x0400, 0x04ff, 9],
  [0x1e00, 0x1eff, 29],
  [0x1f00, 0x1fff, 30],
  [0x2000, 0x206f, 31],
  [0x2070, 0x209f, 32],
  [0x20a0, 0x20cf, 33],
  [0x20d0, 0x20ff, 34],
  [0x2100, 0x214f, 35],
  [0x2150, 0x218f, 36],
  [0x2190, 0x21ff, 37],
  [0x2200, 0x22ff, 38],
  [0x2300, 0x23ff, 39],
  [0x2500, 0x257f, 43],
  [0x2580, 0x259f, 44],
  [0x25a0, 0x25ff, 45],
  [0x2600, 0x26ff, 46],
  [0x2700, 0x27bf, 47],
  [0xe000, 0xf8ff, 60],
  [0xfb00, 0xfb4f, 62],
];
const OS2_CODE_PAGE_LATIN1_BIT = 0x1;
/**
 * Latin text encodings reuse the space glyph for U+00A0 and the hyphen glyph for U+00AD (the
 * WinAnsi convention), so Type 1 fonts that have no separate glyphs for them serve both code points.
 */
const ALIASED_CODE_POINTS: ReadonlyArray<readonly [string, number]> = [
  ['space', 0x00a0],
  ['hyphen', 0x00ad],
];

// ---------------------------------------------------------------------------------------------
// Glyph name to Unicode (Adobe Glyph List specification)
// ---------------------------------------------------------------------------------------------

let aglCache: Map<string, number> | null = null;
let dingbatsCache: Map<string, number> | null = null;

function loadEntries(entries: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of entries) {
    for (const entry of line.split(' ')) {
      const split = entry.lastIndexOf('=');
      map.set(entry.slice(0, split), Number.parseInt(entry.slice(split + 1), 16));
    }
  }
  return map;
}

const UNI_NAME_PATTERN = /^uni([0-9A-F]{4})$/;
const U_NAME_PATTERN = /^u([0-9A-F]{4,6})$/;

function isScalarValue(codePoint: number): boolean {
  return codePoint <= MAX_UNICODE && !(codePoint >= SURROGATE_START && codePoint <= SURROGATE_END);
}

/** Maps one glyph name (without any ".suffix") to a single code point, or undefined. */
function lookupCodePoint(name: string): number | undefined {
  aglCache ??= loadEntries(AGL_ENTRIES);
  dingbatsCache ??= loadEntries(ZAPF_DINGBATS_ENTRIES);
  const listed = aglCache.get(name) ?? dingbatsCache.get(name);
  if (listed !== undefined) return listed;
  const uni = UNI_NAME_PATTERN.exec(name);
  if (uni) {
    const value = Number.parseInt(uni[1], 16);
    return isScalarValue(value) ? value : undefined;
  }
  const u = U_NAME_PATTERN.exec(name);
  if (u) {
    const value = Number.parseInt(u[1], 16);
    return isScalarValue(value) ? value : undefined;
  }
  return undefined;
}

/**
 * Builds the code point to glyph index map. Exact names win over ".suffix" variants, and glyphs
 * with no Unicode name that the font's own Encoding assigns a code keep that code in the
 * private-use symbol block (U+F000 + code).
 */
function buildCodePointMap(font: Type1Font): Map<number, number> {
  const map = new Map<number, number>();
  const unmapped: number[] = [];
  const suffixed: Array<{ gid: number; base: string }> = [];

  font.glyphs.forEach((glyph, gid) => {
    if (gid === 0) return;
    const codePoint = lookupCodePoint(glyph.name);
    if (codePoint !== undefined) {
      if (!map.has(codePoint)) map.set(codePoint, gid);
      return;
    }
    const dot = glyph.name.indexOf('.');
    if (dot > 0) {
      suffixed.push({ gid, base: glyph.name.slice(0, dot) });
    } else {
      unmapped.push(gid);
    }
  });

  for (const { gid, base } of suffixed) {
    const codePoint = base.includes('_') ? undefined : lookupCodePoint(base);
    if (codePoint !== undefined && !map.has(codePoint)) map.set(codePoint, gid);
  }

  const gidByName = new Map<string, number>();
  font.glyphs.forEach((glyph, gid) => gidByName.set(glyph.name, gid));
  for (const [glyphName, alias] of ALIASED_CODE_POINTS) {
    const gid = gidByName.get(glyphName);
    if (gid !== undefined && !map.has(alias)) map.set(alias, gid);
  }
  const mappedGids = new Set(map.values());
  for (const [code, name] of font.encoding) {
    const gid = gidByName.get(name);
    if (gid === undefined || gid === 0 || mappedGids.has(gid)) continue;
    if (!unmapped.includes(gid) && !suffixed.some((s) => s.gid === gid)) continue;
    const target = PRIVATE_USE_SYMBOL_BASE + code;
    if (!map.has(target)) {
      map.set(target, gid);
      mappedGids.add(gid);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

interface Pt {
  x: number;
  y: number;
}

type Segment = { kind: 'line'; p: Pt } | { kind: 'curve'; c1: Pt; c2: Pt; p: Pt };

interface Subpath {
  start: Pt;
  segments: Segment[];
}

interface Bounds {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

interface GlyphModel {
  name: string;
  advance: number;
  subpaths: Subpath[];
}

interface Transform {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
  unitsPerEm: number;
}

function createTransform(font: Type1Font): Transform {
  const [a, b, c, d, tx, ty] = font.fontMatrix;
  if (![a, b, c, d, tx, ty].every(Number.isFinite) || a <= 0 || d <= 0) {
    throw new Type1FontError('Unsupported FontMatrix: the x and y scale must be positive.');
  }
  const unitsPerEm = Math.round(1 / a);
  if (unitsPerEm < MIN_UNITS_PER_EM || unitsPerEm > MAX_UNITS_PER_EM) {
    throw new Type1FontError(`FontMatrix implies ${unitsPerEm} units per em; supported range is 16..16384.`);
  }
  return { a, b, c, d, tx, ty, unitsPerEm };
}

function applyTransform(t: Transform, x: number, y: number): Pt {
  return {
    x: Math.round((t.a * x + t.c * y + t.tx) * t.unitsPerEm),
    y: Math.round((t.b * x + t.d * y + t.ty) * t.unitsPerEm),
  };
}

function toSubpaths(commands: Type1PathCommand[], t: Transform): Subpath[] {
  const subpaths: Subpath[] = [];
  let current: Subpath | null = null;
  const finish = (): void => {
    if (current !== null && current.segments.length > 0) subpaths.push(current);
    current = null;
  };
  for (const command of commands) {
    if (command.type === 'move') {
      finish();
      current = { start: applyTransform(t, command.x, command.y), segments: [] };
    } else if (command.type === 'close') {
      finish();
    } else if (current !== null) {
      if (command.type === 'line') {
        current.segments.push({ kind: 'line', p: applyTransform(t, command.x, command.y) });
      } else {
        current.segments.push({
          kind: 'curve',
          c1: applyTransform(t, command.x1, command.y1),
          c2: applyTransform(t, command.x2, command.y2),
          p: applyTransform(t, command.x3, command.y3),
        });
      }
    }
  }
  finish();
  return subpaths;
}

function buildGlyphModels(font: Type1Font, t: Transform): GlyphModel[] {
  return font.glyphs.map((glyph) => {
    const advance = Math.round(glyph.advance * t.a * t.unitsPerEm);
    if (!Number.isFinite(advance) || advance < 0 || advance > UINT16_MAX) {
      throw new Type1FontError(`Glyph ${glyph.name}: advance width ${advance} is outside 0..65535.`);
    }
    const subpaths = toSubpaths(glyph.commands, t);
    for (const subpath of subpaths) {
      const points = [subpath.start, ...subpath.segments.flatMap((s) => (s.kind === 'line' ? [s.p] : [s.c1, s.c2, s.p]))];
      for (const p of points) {
        if (p.x < INT16_MIN || p.x > INT16_MAX || p.y < INT16_MIN || p.y > INT16_MAX) {
          throw new Type1FontError(`Glyph ${glyph.name}: coordinate ${p.x},${p.y} exceeds the 16-bit range.`);
        }
      }
    }
    return { name: glyph.name, advance, subpaths };
  });
}

/** Extremum parameters of one cubic coordinate, strictly inside (0, 1). */
function cubicExtremaParameters(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const roots: number[] = [];
  if (Math.abs(a) < Number.EPSILON) {
    if (b !== 0) roots.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const root = Math.sqrt(disc);
      roots.push((-b + root) / (2 * a), (-b - root) / (2 * a));
    }
  }
  return roots.filter((r) => r > 0 && r < 1);
}

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** Exact outline bounds (curve extrema, rounded outward). Null for a glyph with no outline. */
function exactBounds(subpaths: Subpath[]): Bounds | null {
  let bounds: Bounds | null = null;
  const include = (x: number, y: number): void => {
    if (bounds === null) {
      bounds = { xMin: x, yMin: y, xMax: x, yMax: y };
    } else {
      bounds.xMin = Math.min(bounds.xMin, x);
      bounds.yMin = Math.min(bounds.yMin, y);
      bounds.xMax = Math.max(bounds.xMax, x);
      bounds.yMax = Math.max(bounds.yMax, y);
    }
  };
  for (const subpath of subpaths) {
    include(subpath.start.x, subpath.start.y);
    let from = subpath.start;
    for (const segment of subpath.segments) {
      include(segment.p.x, segment.p.y);
      if (segment.kind === 'curve') {
        for (const t of cubicExtremaParameters(from.x, segment.c1.x, segment.c2.x, segment.p.x)) {
          include(cubicAt(from.x, segment.c1.x, segment.c2.x, segment.p.x, t), cubicAt(from.y, segment.c1.y, segment.c2.y, segment.p.y, t));
        }
        for (const t of cubicExtremaParameters(from.y, segment.c1.y, segment.c2.y, segment.p.y)) {
          include(cubicAt(from.x, segment.c1.x, segment.c2.x, segment.p.x, t), cubicAt(from.y, segment.c1.y, segment.c2.y, segment.p.y, t));
        }
      }
      from = segment.p;
    }
  }
  if (bounds === null) return null;
  const b: Bounds = bounds;
  return { xMin: Math.floor(b.xMin), yMin: Math.floor(b.yMin), xMax: Math.ceil(b.xMax), yMax: Math.ceil(b.yMax) };
}

function pointBounds(contours: GlyphPoint[][]): Bounds | null {
  let bounds: Bounds | null = null;
  for (const contour of contours) {
    for (const p of contour) {
      if (bounds === null) {
        bounds = { xMin: p.x, yMin: p.y, xMax: p.x, yMax: p.y };
      } else {
        bounds.xMin = Math.min(bounds.xMin, p.x);
        bounds.yMin = Math.min(bounds.yMin, p.y);
        bounds.xMax = Math.max(bounds.xMax, p.x);
        bounds.yMax = Math.max(bounds.yMax, p.y);
      }
    }
  }
  return bounds;
}

// ---------------------------------------------------------------------------------------------
// glyf outlines
// ---------------------------------------------------------------------------------------------

function signedArea(points: GlyphPoint[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    sum += p.x * q.y - q.x * p.y;
  }
  return sum / 2;
}

interface CubicSegment {
  p0: Pt;
  c1: Pt;
  c2: Pt;
  p3: Pt;
}

function lerp(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Splits a cubic at parameter t (de Casteljau) into the part before and the part after. */
function splitCubic(curve: CubicSegment, t: number): [CubicSegment, CubicSegment] {
  const ab = lerp(curve.p0, curve.c1, t);
  const bc = lerp(curve.c1, curve.c2, t);
  const cd = lerp(curve.c2, curve.p3, t);
  const abc = lerp(ab, bc, t);
  const bcd = lerp(bc, cd, t);
  const mid = lerp(abc, bcd, t);
  return [
    { p0: curve.p0, c1: ab, c2: abc, p3: mid },
    { p0: mid, c1: bcd, c2: cd, p3: curve.p3 },
  ];
}

/**
 * Approximates a cubic by equal-parameter quadratic pieces. The best single quadratic for a cubic
 * deviates by at most sqrt(3)/36 * |P3 - 3*C2 + 3*C1 - P0|, and splitting into n parts divides that
 * bound by n cubed, which gives the piece count for the requested tolerance.
 */
function approximateCubicWithQuadratics(curve: CubicSegment, tolerance: number): Array<{ q: Pt; p: Pt }> {
  const dx = curve.p3.x - 3 * curve.c2.x + 3 * curve.c1.x - curve.p0.x;
  const dy = curve.p3.y - 3 * curve.c2.y + 3 * curve.c1.y - curve.p0.y;
  const singlePieceError = CUBIC_TO_QUADRATIC_ERROR_FACTOR * Math.hypot(dx, dy);
  const pieces = Math.min(MAX_QUADRATIC_PIECES, Math.max(1, Math.ceil(Math.cbrt(singlePieceError / tolerance))));

  const result: Array<{ q: Pt; p: Pt }> = [];
  let remaining = curve;
  for (let i = 0; i < pieces; i++) {
    const [piece, rest] = i === pieces - 1 ? [remaining, remaining] : splitCubic(remaining, 1 / (pieces - i));
    result.push({
      q: {
        x: (3 * (piece.c1.x + piece.c2.x) - (piece.p0.x + piece.p3.x)) / 4,
        y: (3 * (piece.c1.y + piece.c2.y) - (piece.p0.y + piece.p3.y)) / 4,
      },
      p: piece.p3,
    });
    remaining = rest;
  }
  return result;
}

function subpathToQuadraticContour(subpath: Subpath, tolerance: number): GlyphPoint[] {
  const points: GlyphPoint[] = [{ x: subpath.start.x, y: subpath.start.y, onCurve: true }];
  let from = subpath.start;
  for (const segment of subpath.segments) {
    if (segment.kind === 'line') {
      points.push({ x: segment.p.x, y: segment.p.y, onCurve: true });
    } else {
      for (const piece of approximateCubicWithQuadratics({ p0: from, c1: segment.c1, c2: segment.c2, p3: segment.p }, tolerance)) {
        points.push({ x: Math.round(piece.q.x), y: Math.round(piece.q.y), onCurve: false });
        points.push({ x: Math.round(piece.p.x), y: Math.round(piece.p.y), onCurve: true });
      }
    }
    from = segment.p;
  }

  // The closing segment is implicit in glyf, so a final point equal to the start is redundant.
  const first = points[0];
  const last = points[points.length - 1];
  if (points.length > 1 && last.onCurve && last.x === first.x && last.y === first.y) points.pop();

  const deduped: GlyphPoint[] = [];
  for (const p of points) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.onCurve && p.onCurve && prev.x === p.x && prev.y === p.y) continue;
    deduped.push(p);
  }
  return deduped;
}

function reverseContour(points: GlyphPoint[]): GlyphPoint[] {
  return [points[0], ...points.slice(1).reverse()];
}

function buildTrueTypeContours(glyph: GlyphModel, tolerance: number): GlyphPoint[][] {
  const contours = glyph.subpaths
    .map((s) => subpathToQuadraticContour(s, tolerance))
    // A contour of fewer than three on-curve points encloses no area.
    .filter((c) => c.length >= 3 || c.some((p) => !p.onCurve));
  const total = contours.reduce((sum, c) => sum + signedArea(c), 0);
  // TrueType fills outer contours clockwise; Type 1 outer contours run counter-clockwise.
  return total > 0 ? contours.map(reverseContour) : contours;
}

// ---------------------------------------------------------------------------------------------
// Naming and style
// ---------------------------------------------------------------------------------------------

interface StyleInfo {
  psName: string;
  family: string;
  fullName: string;
  legacyFamily: string;
  legacyStyle: string;
  typographicFamily: string | null;
  typographicStyle: string | null;
  weightClass: number;
  bold: boolean;
  italic: boolean;
  weightWord: string;
}

const PS_NAME_PATTERN = /^[\x21-\x7e]+$/;

function deriveStyle(font: Type1Font): StyleInfo {
  if (!PS_NAME_PATTERN.test(font.fontName) || font.fontName.length > MAX_POSTSCRIPT_NAME_LENGTH) {
    throw new Type1FontError('FontName is not a valid PostScript name of at most 63 characters.');
  }
  const dash = font.fontName.indexOf('-');
  const nameFamily = dash > 0 ? font.fontName.slice(0, dash) : font.fontName;
  const family = font.familyName.trim() || nameFamily;
  const weightWord = font.weight.trim();
  const mapped = WEIGHT_CLASSES.get(weightWord.toLowerCase());
  let weightClass = mapped ?? REGULAR_WEIGHT_CLASS;
  if (mapped === undefined && /bold/i.test(font.fontName)) weightClass = BOLD_WEIGHT_CLASS;
  const bold = weightClass >= BOLD_WEIGHT_CLASS;
  const italic = font.italicAngle !== 0 || /italic|oblique/i.test(`${font.fontName} ${font.fullName}`);

  let ribbi = 'Regular';
  if (bold && italic) ribbi = 'Bold Italic';
  else if (bold) ribbi = 'Bold';
  else if (italic) ribbi = 'Italic';

  const needsTypographic = weightClass !== REGULAR_WEIGHT_CLASS && weightClass !== BOLD_WEIGHT_CLASS && weightWord !== '';
  let legacyFamily = family;
  let legacyStyle = ribbi;
  let typographicFamily: string | null = null;
  let typographicStyle: string | null = null;
  if (needsTypographic) {
    const alreadyNamed = family.toLowerCase().endsWith(weightWord.toLowerCase());
    legacyFamily = alreadyNamed ? family : `${family} ${weightWord}`;
    legacyStyle = italic ? 'Italic' : 'Regular';
    typographicFamily = family;
    typographicStyle = italic ? `${weightWord} Italic` : weightWord;
  }
  const fullName = font.fullName.trim() || (ribbi === 'Regular' ? family : `${family} ${ribbi}`);
  return {
    psName: font.fontName,
    family,
    fullName,
    legacyFamily,
    legacyStyle,
    typographicFamily,
    typographicStyle,
    weightClass,
    bold,
    italic,
    weightWord,
  };
}

interface NameRecord {
  id: number;
  value: string;
}

function buildNameTable(records: NameRecord[]): Buffer {
  const entries: Array<{ platform: number; encoding: number; language: number; id: number; data: Buffer }> = [];
  for (const record of records) {
    const utf16 = Buffer.from(record.value, 'utf16le').swap16();
    entries.push({ platform: 1, encoding: 0, language: 0, id: record.id, data: Buffer.from(record.value.replace(/[^\x20-\x7e]/g, '?'), 'ascii') });
    entries.push({ platform: 3, encoding: 1, language: 0x409, id: record.id, data: utf16 });
  }
  entries.sort((a, b) => a.platform - b.platform || a.encoding - b.encoding || a.language - b.language || a.id - b.id);

  const headerLength = 6 + entries.length * 12;
  const header = Buffer.alloc(headerLength);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(entries.length, 2);
  header.writeUInt16BE(headerLength, 4);
  let offset = 0;
  entries.forEach((entry, i) => {
    const at = 6 + i * 12;
    header.writeUInt16BE(entry.platform, at);
    header.writeUInt16BE(entry.encoding, at + 2);
    header.writeUInt16BE(entry.language, at + 4);
    header.writeUInt16BE(entry.id, at + 6);
    header.writeUInt16BE(entry.data.length, at + 8);
    header.writeUInt16BE(offset, at + 10);
    offset += entry.data.length;
    if (offset > UINT16_MAX) throw new Type1FontError('Font name strings are too long for the name table.');
  });
  return Buffer.concat([header, ...entries.map((e) => e.data)]);
}

function buildNameRecords(font: Type1Font, style: StyleInfo): NameRecord[] {
  const version = font.version.trim() || '1.000';
  const records: NameRecord[] = [];
  if (font.notice.trim()) records.push({ id: 0, value: font.notice.trim() });
  records.push(
    { id: 1, value: style.legacyFamily },
    { id: 2, value: style.legacyStyle },
    { id: 3, value: `${style.psName};${version}` },
    { id: 4, value: style.fullName },
    { id: 5, value: `Version ${version}` },
    { id: 6, value: style.psName }
  );
  if (style.typographicFamily !== null && style.typographicStyle !== null) {
    records.push(
      { id: FIRST_NAME_ID_TYPOGRAPHIC, value: style.typographicFamily },
      { id: FIRST_NAME_ID_TYPOGRAPHIC + 1, value: style.typographicStyle }
    );
  }
  return records;
}

// ---------------------------------------------------------------------------------------------
// Table builders shared by both flavors
// ---------------------------------------------------------------------------------------------

interface FontMetrics {
  unitsPerEm: number;
  bounds: Bounds;
  glyphBounds: Array<Bounds | null>;
  advances: number[];
  ascent: number;
  descent: number;
  advanceMax: number;
  minLsb: number;
  minRsb: number;
  xMaxExtent: number;
  numGlyphs: number;
}

function computeMetrics(models: GlyphModel[], glyphBounds: Array<Bounds | null>, unitsPerEm: number): FontMetrics {
  const advances = models.map((m) => m.advance);
  let xMin = 0;
  let yMin = 0;
  let xMax = 0;
  let yMax = 0;
  let seen = false;
  let minLsb = 0;
  let minRsb = 0;
  let xMaxExtent = 0;
  glyphBounds.forEach((b, gid) => {
    if (b === null) return;
    if (!seen) {
      xMin = b.xMin;
      yMin = b.yMin;
      xMax = b.xMax;
      yMax = b.yMax;
      minLsb = b.xMin;
      minRsb = advances[gid] - b.xMax;
      xMaxExtent = b.xMax;
      seen = true;
      return;
    }
    xMin = Math.min(xMin, b.xMin);
    yMin = Math.min(yMin, b.yMin);
    xMax = Math.max(xMax, b.xMax);
    yMax = Math.max(yMax, b.yMax);
    minLsb = Math.min(minLsb, b.xMin);
    minRsb = Math.min(minRsb, advances[gid] - b.xMax);
    xMaxExtent = Math.max(xMaxExtent, b.xMax);
  });
  return {
    unitsPerEm,
    bounds: { xMin, yMin, xMax, yMax },
    glyphBounds,
    advances,
    ascent: Math.max(0, yMax),
    descent: Math.min(0, yMin),
    advanceMax: Math.max(0, ...advances),
    minLsb,
    minRsb,
    xMaxExtent,
    numGlyphs: models.length,
  };
}

function buildHmtx(metrics: FontMetrics): Buffer {
  const buf = Buffer.alloc(metrics.numGlyphs * 4);
  metrics.advances.forEach((advance, gid) => {
    buf.writeUInt16BE(advance, gid * 4);
    buf.writeInt16BE(metrics.glyphBounds[gid]?.xMin ?? 0, gid * 4 + 2);
  });
  return buf;
}

function buildHead(font: Type1Font, style: StyleInfo, metrics: FontMetrics, longLoca: boolean): Buffer {
  const buf = Buffer.alloc(HEAD_TABLE_LENGTH);
  const revision = Number.parseFloat(font.version);
  const fixedRevision = Number.isFinite(revision) && revision > 0 && revision < INT16_MAX ? Math.round(revision * FIXED_ONE) : FIXED_ONE;
  buf.writeUInt32BE(SFNT_VERSION_TRUETYPE, 0);
  buf.writeUInt32BE(fixedRevision, 4);
  buf.writeUInt32BE(0, HEAD_CHECKSUM_ADJUSTMENT_OFFSET);
  buf.writeUInt32BE(HEAD_MAGIC, 12);
  buf.writeUInt16BE(HEAD_FLAG_BASELINE_AT_ZERO, 16);
  buf.writeUInt16BE(metrics.unitsPerEm, 18);
  // created / modified stay zero: the Type 1 source carries no timestamps, and zero keeps output reproducible.
  buf.writeInt16BE(metrics.bounds.xMin, 36);
  buf.writeInt16BE(metrics.bounds.yMin, 38);
  buf.writeInt16BE(metrics.bounds.xMax, 40);
  buf.writeInt16BE(metrics.bounds.yMax, 42);
  let macStyle = 0;
  if (style.bold) macStyle |= HEAD_MAC_STYLE_BOLD;
  if (style.italic) macStyle |= HEAD_MAC_STYLE_ITALIC;
  buf.writeUInt16BE(macStyle, 44);
  buf.writeUInt16BE(HEAD_LOWEST_REC_PPEM, 46);
  buf.writeInt16BE(HEAD_DIRECTION_HINT_MIXED, 48);
  buf.writeInt16BE(longLoca ? 1 : 0, 50);
  buf.writeInt16BE(0, 52);
  return buf;
}

function buildHhea(font: Type1Font, metrics: FontMetrics): Buffer {
  const buf = Buffer.alloc(HHEA_TABLE_LENGTH);
  const radians = font.italicAngle * DEGREES_TO_RADIANS;
  const caretRise = font.italicAngle === 0 ? 1 : Math.round(Math.cos(radians) * CARET_RISE_BASE);
  const caretRun = font.italicAngle === 0 ? 0 : Math.round(-Math.sin(radians) * CARET_RISE_BASE);
  buf.writeUInt32BE(SFNT_VERSION_TRUETYPE, 0);
  buf.writeInt16BE(metrics.ascent, 4);
  buf.writeInt16BE(metrics.descent, 6);
  buf.writeInt16BE(0, 8);
  buf.writeUInt16BE(metrics.advanceMax, 10);
  buf.writeInt16BE(metrics.minLsb, 12);
  buf.writeInt16BE(metrics.minRsb, 14);
  buf.writeInt16BE(metrics.xMaxExtent, 16);
  buf.writeInt16BE(caretRise, 18);
  buf.writeInt16BE(caretRun, 20);
  buf.writeUInt16BE(metrics.numGlyphs, 34);
  return buf;
}

function unicodeRangeBits(codePoints: Iterable<number>): number[] {
  const words = [0, 0, 0, 0];
  for (const cp of codePoints) {
    for (const [first, last, bit] of UNICODE_RANGE_BITS) {
      if (cp >= first && cp <= last) {
        words[bit >> 5] = (words[bit >> 5] | (1 << (bit & 31))) >>> 0;
        break;
      }
    }
  }
  return words;
}

function glyphHeight(map: Map<number, number>, codePoint: number, bounds: Array<Bounds | null>): number {
  const gid = map.get(codePoint);
  return gid === undefined ? 0 : (bounds[gid]?.yMax ?? 0);
}

function buildOs2(
  font: Type1Font,
  style: StyleInfo,
  metrics: FontMetrics,
  codePoints: Map<number, number>
): Buffer {
  const buf = Buffer.alloc(OS2_TABLE_LENGTH);
  const upem = metrics.unitsPerEm;
  const positive = metrics.advances.filter((w) => w > 0);
  const average = positive.length === 0 ? 0 : Math.round(positive.reduce((a, b) => a + b, 0) / positive.length);

  let fsSelection = OS2_FS_USE_TYPO_METRICS;
  if (style.italic) fsSelection |= OS2_FS_ITALIC;
  if (style.bold) fsSelection |= OS2_FS_BOLD;
  if (!style.bold && !style.italic) fsSelection |= OS2_FS_REGULAR;

  const bmp = [...codePoints.keys()].filter((cp) => cp <= BMP_LAST);
  const ranges = unicodeRangeBits(codePoints.keys());
  let hasLatin = true;
  for (let cp = BASIC_LATIN_FIRST; cp <= BASIC_LATIN_LAST && hasLatin; cp++) hasLatin = codePoints.has(cp);

  buf.writeUInt16BE(OS2_VERSION, 0);
  buf.writeInt16BE(average, 2);
  buf.writeUInt16BE(style.weightClass, 4);
  buf.writeUInt16BE(OS2_WIDTH_CLASS_MEDIUM, 6);
  buf.writeUInt16BE(font.fsType & UINT16_MAX, 8);
  buf.writeInt16BE(Math.round(upem * SUBSCRIPT_SIZE_X_EM), 10);
  buf.writeInt16BE(Math.round(upem * SUBSCRIPT_SIZE_Y_EM), 12);
  buf.writeInt16BE(0, 14);
  buf.writeInt16BE(Math.round(upem * SUBSCRIPT_OFFSET_Y_EM), 16);
  buf.writeInt16BE(Math.round(upem * SUBSCRIPT_SIZE_X_EM), 18);
  buf.writeInt16BE(Math.round(upem * SUBSCRIPT_SIZE_Y_EM), 20);
  buf.writeInt16BE(0, 22);
  buf.writeInt16BE(Math.round(upem * SUPERSCRIPT_OFFSET_Y_EM), 24);
  buf.writeInt16BE(Math.round(upem * STRIKEOUT_SIZE_EM), 26);
  buf.writeInt16BE(Math.round(upem * STRIKEOUT_POSITION_EM), 28);
  ranges.forEach((word, i) => buf.writeUInt32BE(word, 42 + i * 4));
  buf.write(OS2_VENDOR_ID, 58, 4, 'ascii');
  buf.writeUInt16BE(fsSelection, 62);
  buf.writeUInt16BE(bmp.length === 0 ? 0 : Math.min(...bmp), 64);
  buf.writeUInt16BE(bmp.length === 0 ? 0 : Math.max(...bmp), 66);
  buf.writeInt16BE(metrics.ascent, 68);
  buf.writeInt16BE(metrics.descent, 70);
  buf.writeInt16BE(0, 72);
  buf.writeUInt16BE(metrics.ascent, 74);
  buf.writeUInt16BE(-metrics.descent, 76);
  buf.writeUInt32BE(hasLatin ? OS2_CODE_PAGE_LATIN1_BIT : 0, 78);
  buf.writeInt16BE(glyphHeight(codePoints, 'x'.charCodeAt(0), metrics.glyphBounds), 86);
  buf.writeInt16BE(glyphHeight(codePoints, 'H'.charCodeAt(0), metrics.glyphBounds), 88);
  buf.writeUInt16BE(0, 90);
  buf.writeUInt16BE(OS2_BREAK_CHAR, 92);
  buf.writeUInt16BE(1, 94);
  return buf;
}

function toFixed1616(value: number): number {
  return Math.round(value * FIXED_ONE) | 0;
}

function buildPost(font: Type1Font, models: GlyphModel[], transform: Transform, named: boolean): Buffer {
  const header = Buffer.alloc(POST_TABLE_HEADER_LENGTH);
  header.writeUInt32BE(named ? POST_VERSION_NAMED : POST_VERSION_NONE, 0);
  header.writeInt32BE(toFixed1616(font.italicAngle), 4);
  const scaleY = transform.d * transform.unitsPerEm;
  header.writeInt16BE(Math.round(font.underlinePosition * scaleY), 8);
  header.writeInt16BE(Math.round(font.underlineThickness * scaleY), 10);
  header.writeUInt32BE(font.isFixedPitch ? 1 : 0, 12);
  if (!named) return header;

  const indexes = Buffer.alloc(2 + models.length * 2);
  indexes.writeUInt16BE(models.length, 0);
  const names: Buffer[] = [];
  let custom = 0;
  models.forEach((model, gid) => {
    if (gid === 0) {
      indexes.writeUInt16BE(0, 2);
      return;
    }
    indexes.writeUInt16BE(POST_CUSTOM_NAME_BASE + custom, 2 + gid * 2);
    custom++;
    names.push(Buffer.from([model.name.length]), Buffer.from(model.name, 'ascii'));
  });
  return Buffer.concat([header, indexes, ...names]);
}

function buildCmap(codePoints: Map<number, number>): Buffer {
  const mappings = [...codePoints].map(([charCode, glyphId]) => ({ charCode, glyphId }));
  const subtables: Array<{ platform: number; encoding: number; data: Buffer }> = [];
  const format4 = createFormat4Subtable(mappings);
  subtables.push({ platform: 0, encoding: 3, data: format4 }, { platform: 3, encoding: 1, data: format4 });
  const needsFormat12 = mappings.some((m) => m.charCode > BMP_LAST);
  if (needsFormat12) {
    const format12 = createFormat12Subtable(mappings);
    subtables.push({ platform: 0, encoding: 4, data: format12 }, { platform: 3, encoding: 10, data: format12 });
  }

  const unique: Buffer[] = [];
  const offsets: number[] = [];
  const dataStart = 4 + subtables.length * 8;
  let cursor = dataStart;
  for (const table of subtables) {
    let index = unique.indexOf(table.data);
    if (index < 0) {
      index = unique.length;
      unique.push(table.data);
      offsets.push(cursor);
      cursor += table.data.length + ((4 - (table.data.length % 4)) % 4);
    }
  }
  const header = Buffer.alloc(dataStart);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(subtables.length, 2);
  subtables.forEach((table, i) => {
    header.writeUInt16BE(table.platform, 4 + i * 8);
    header.writeUInt16BE(table.encoding, 6 + i * 8);
    header.writeUInt32BE(offsets[unique.indexOf(table.data)], 8 + i * 8);
  });
  const body = unique.map((data) => Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]));
  return Buffer.concat([header, ...body]);
}

function makeTable(tag: string, data: Buffer): SfntTable {
  return { tag, checkSum: calculateTableChecksum(data), offset: 0, length: data.length, data };
}

// ---------------------------------------------------------------------------------------------
// TrueType flavor
// ---------------------------------------------------------------------------------------------

function buildTrueTypeTables(font: Type1Font, models: GlyphModel[], transform: Transform): Record<string, SfntTable> {
  const tolerance = transform.unitsPerEm * QUADRATIC_TOLERANCE_EM;
  const contours = models.map((m) => buildTrueTypeContours(m, tolerance));
  for (const [gid, glyphContours] of contours.entries()) {
    if (glyphContours.reduce((n, c) => n + c.length, 0) > UINT16_MAX) {
      throw new Type1FontError(`Glyph ${models[gid].name} has too many outline points for glyf.`);
    }
    // glyf stores each point as a 16-bit delta from the previous one.
    let previous: GlyphPoint = { x: 0, y: 0, onCurve: true };
    for (const point of glyphContours.flat()) {
      if (Math.abs(point.x - previous.x) > INT16_MAX || Math.abs(point.y - previous.y) > INT16_MAX) {
        throw new Type1FontError(`Glyph ${models[gid].name} has a point step outside the 16-bit glyf range.`);
      }
      previous = point;
    }
  }
  const glyphBounds = contours.map((c) => pointBounds(c));
  const metrics = computeMetrics(models, glyphBounds, transform.unitsPerEm);
  const style = deriveStyle(font);
  const codePoints = buildCodePointMap(font);

  const built = buildGlyfAndLoca(contours.map((c, gid) => ({ contours: c, advWidth: models[gid].advance })));
  const maxp = Buffer.alloc(MAXP_TRUETYPE_LENGTH);
  maxp.writeUInt32BE(SFNT_VERSION_TRUETYPE, 0);
  maxp.writeUInt16BE(models.length, 4);
  maxp.writeUInt16BE(built.maxp.readUInt16BE(6), 6);
  maxp.writeUInt16BE(built.maxp.readUInt16BE(8), 8);
  maxp.writeUInt16BE(MAXP_ZONES, 14);

  return {
    cmap: makeTable('cmap', buildCmap(codePoints)),
    glyf: makeTable('glyf', built.glyf),
    head: makeTable('head', buildHead(font, style, metrics, built.indexToLocFormat === 1)),
    hhea: makeTable('hhea', buildHhea(font, metrics)),
    hmtx: makeTable('hmtx', buildHmtx(metrics)),
    loca: makeTable('loca', built.loca),
    maxp: makeTable('maxp', maxp),
    name: makeTable('name', buildNameTable(buildNameRecords(font, style))),
    'OS/2': makeTable('OS/2', buildOs2(font, style, metrics, codePoints)),
    post: makeTable('post', buildPost(font, models, transform, true)),
  };
}

// ---------------------------------------------------------------------------------------------
// CFF flavor
// ---------------------------------------------------------------------------------------------

function cffInt32(value: number): number[] {
  return [CFF_DICT_INT32, (value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function cffReal(value: number): number[] {
  const text = value.toFixed(CFF_FONT_MATRIX_DECIMALS).replace(/0+$/, '').replace(/\.$/, '');
  const nibbles: number[] = [];
  for (const ch of text) {
    if (ch === '.') nibbles.push(CFF_REAL_POINT_NIBBLE);
    else if (ch === '-') nibbles.push(CFF_REAL_MINUS_NIBBLE);
    else nibbles.push(Number.parseInt(ch, 10));
  }
  nibbles.push(CFF_REAL_END_NIBBLE);
  if (nibbles.length % 2 !== 0) nibbles.push(CFF_REAL_END_NIBBLE);
  const bytes: number[] = [CFF_REAL_PREFIX];
  for (let i = 0; i < nibbles.length; i += 2) bytes.push((nibbles[i] << 4) | nibbles[i + 1]);
  return bytes;
}

function type2Number(value: number, glyphName: string): number[] {
  if (value < INT16_MIN || value > INT16_MAX) {
    throw new Type1FontError(`Glyph ${glyphName}: charstring operand ${value} exceeds the 16-bit range.`);
  }
  return encodeCffNumber(value);
}

function buildType2CharString(model: GlyphModel, defaultWidth: number): Buffer {
  const bytes: number[] = [];
  if (model.advance !== defaultWidth) bytes.push(...type2Number(model.advance, model.name));
  let x = 0;
  let y = 0;
  for (const subpath of model.subpaths) {
    bytes.push(...type2Number(subpath.start.x - x, model.name), ...type2Number(subpath.start.y - y, model.name), T2_RMOVETO);
    x = subpath.start.x;
    y = subpath.start.y;
    for (const segment of subpath.segments) {
      if (segment.kind === 'line') {
        bytes.push(...type2Number(segment.p.x - x, model.name), ...type2Number(segment.p.y - y, model.name), T2_RLINETO);
      } else {
        bytes.push(
          ...type2Number(segment.c1.x - x, model.name),
          ...type2Number(segment.c1.y - y, model.name),
          ...type2Number(segment.c2.x - segment.c1.x, model.name),
          ...type2Number(segment.c2.y - segment.c1.y, model.name),
          ...type2Number(segment.p.x - segment.c2.x, model.name),
          ...type2Number(segment.p.y - segment.c2.y, model.name),
          T2_RRCURVETO
        );
      }
      x = segment.p.x;
      y = segment.p.y;
    }
  }
  bytes.push(T2_ENDCHAR);
  return Buffer.from(bytes);
}

function mostCommon(values: number[]): number {
  const counts = new Map<number, number>();
  let best = 0;
  let bestCount = 0;
  for (const v of values) {
    const count = (counts.get(v) ?? 0) + 1;
    counts.set(v, count);
    if (count > bestCount) {
      best = v;
      bestCount = count;
    }
  }
  return best;
}

function buildCffTable(font: Type1Font, style: StyleInfo, models: GlyphModel[], metrics: FontMetrics, transform: Transform): Buffer {
  const defaultWidth = mostCommon(models.map((m) => m.advance));
  const charStrings = models.map((m) => buildType2CharString(m, defaultWidth));
  const charStringBytes = charStrings.reduce((n, c) => n + c.length, 0);
  if (charStringBytes > MAX_CFF_INDEX_BYTES) throw new Type1FontError('CharStrings exceed the CFF INDEX size limit.');

  const strings: Buffer[] = [];
  const sidFor = (text: string): number => {
    strings.push(Buffer.from(text, 'latin1'));
    return CFF_STANDARD_STRING_COUNT + strings.length - 1;
  };
  const fullNameSid = sidFor(style.fullName);
  const familySid = sidFor(style.family);
  const weightSid = style.weightWord ? sidFor(style.weightWord) : -1;
  const glyphSids = models.slice(1).map((m) => sidFor(m.name));
  if (CFF_STANDARD_STRING_COUNT + strings.length > UINT16_MAX) throw new Type1FontError('Too many CFF strings.');

  const nameIndex = buildCffIndex([Buffer.from(style.psName, 'ascii')]);
  const stringIndex = buildCffIndex(strings);
  const globalSubrIndex = buildCffIndex([]);
  const charStringsIndex = buildCffIndex(charStrings);

  const charset = Buffer.alloc(1 + glyphSids.length * 2);
  charset.writeUInt8(CFF_CHARSET_FORMAT_0, 0);
  glyphSids.forEach((sid, i) => charset.writeUInt16BE(sid, 1 + i * 2));

  const privateDict = Buffer.from([...encodeCffNumber(defaultWidth), CFF_OP_DEFAULT_WIDTH_X, ...encodeCffNumber(0), CFF_OP_NOMINAL_WIDTH_X]);

  const buildTopDict = (charsetOffset: number, charStringsOffset: number, privateOffset: number): Buffer => {
    const bytes: number[] = [
      ...encodeCffNumber(fullNameSid),
      CFF_OP_FULL_NAME,
      ...encodeCffNumber(familySid),
      CFF_OP_FAMILY_NAME,
    ];
    if (weightSid >= 0) bytes.push(...encodeCffNumber(weightSid), CFF_OP_WEIGHT);
    const b = metrics.bounds;
    bytes.push(...encodeCffNumber(b.xMin), ...encodeCffNumber(b.yMin), ...encodeCffNumber(b.xMax), ...encodeCffNumber(b.yMax), CFF_OP_FONT_BBOX);
    if (transform.unitsPerEm !== DEFAULT_UNITS_PER_EM) {
      const scale = 1 / transform.unitsPerEm;
      for (const value of [scale, 0, 0, scale, 0, 0]) bytes.push(...(value === 0 ? encodeCffNumber(0) : cffReal(value)));
      bytes.push(CFF_OP_ESCAPE, CFF_OP_FONT_MATRIX);
    }
    bytes.push(...cffInt32(charsetOffset), CFF_OP_CHARSET);
    bytes.push(...cffInt32(charStringsOffset), CFF_OP_CHARSTRINGS);
    bytes.push(...encodeCffNumber(privateDict.length), ...cffInt32(privateOffset), CFF_OP_PRIVATE);
    return Buffer.from(bytes);
  };

  const sizingIndex = buildCffIndex([buildTopDict(0, 0, 0)]);
  const charsetOffset = CFF_HEADER.length + nameIndex.length + sizingIndex.length + stringIndex.length + globalSubrIndex.length;
  const charStringsOffset = charsetOffset + charset.length;
  const privateOffset = charStringsOffset + charStringsIndex.length;
  const topDictIndex = buildCffIndex([buildTopDict(charsetOffset, charStringsOffset, privateOffset)]);

  return Buffer.concat([CFF_HEADER, nameIndex, topDictIndex, stringIndex, globalSubrIndex, charset, charStringsIndex, privateDict]);
}

function buildCffFlavorTables(font: Type1Font, models: GlyphModel[], transform: Transform): Record<string, SfntTable> {
  const glyphBounds = models.map((m) => exactBounds(m.subpaths));
  const metrics = computeMetrics(models, glyphBounds, transform.unitsPerEm);
  const style = deriveStyle(font);
  const codePoints = buildCodePointMap(font);

  const maxp = Buffer.alloc(MAXP_CFF_LENGTH);
  maxp.writeUInt32BE(MAXP_VERSION_CFF, 0);
  maxp.writeUInt16BE(models.length, 4);

  return {
    'CFF ': makeTable('CFF ', buildCffTable(font, style, models, metrics, transform)),
    cmap: makeTable('cmap', buildCmap(codePoints)),
    head: makeTable('head', buildHead(font, style, metrics, false)),
    hhea: makeTable('hhea', buildHhea(font, metrics)),
    hmtx: makeTable('hmtx', buildHmtx(metrics)),
    maxp: makeTable('maxp', maxp),
    name: makeTable('name', buildNameTable(buildNameRecords(font, style))),
    'OS/2': makeTable('OS/2', buildOs2(font, style, metrics, codePoints)),
    post: makeTable('post', buildPost(font, models, transform, false)),
  };
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/** Builds the canonical SFNT tables for a parsed Type 1 font in the requested flavor. */
export function buildType1ParsedFont(font: Type1Font, flavor: Type1OutputFlavor): ParsedFont {
  const transform = createTransform(font);
  const models = buildGlyphModels(font, transform);
  const tables = flavor === 'otf' ? buildCffFlavorTables(font, models, transform) : buildTrueTypeTables(font, models, transform);
  const style = deriveStyle(font);
  return {
    sfntVersion: flavor === 'otf' ? SFNT_VERSION_CFF : SFNT_VERSION_TRUETYPE,
    flavor: flavor === 'otf' ? 'OTTO' : 'TrueType',
    numTables: Object.keys(tables).length,
    tables,
    fontFamily: style.family,
  };
}

/** Parses PFA or PFB bytes into the canonical SFNT structure used by the other font converters. */
export function parseType1ToSfnt(buffer: Buffer, flavor: Type1OutputFlavor): ParsedFont {
  return buildType1ParsedFont(parseType1Font(buffer), flavor);
}

/** Serialises a Type 1 derived font and records the whole-file checksum in head.checkSumAdjustment. */
export function serializeType1Sfnt(font: ParsedFont): Buffer {
  const out = encodeSfnt(font, font.sfntVersion);
  const numTables = out.readUInt16BE(4);
  let sum = 0;
  for (let i = 0; i + 4 <= out.length; i += 4) sum = (sum + out.readUInt32BE(i)) >>> 0;
  for (let i = 0; i < numTables; i++) {
    const entry = 12 + i * 16;
    if (out.toString('ascii', entry, entry + 4) === 'head') {
      const adjustment = (HEAD_CHECKSUM_TARGET - sum) >>> 0;
      out.writeUInt32BE(adjustment, out.readUInt32BE(entry + 8) + HEAD_CHECKSUM_ADJUSTMENT_OFFSET);
    }
  }
  return out;
}
