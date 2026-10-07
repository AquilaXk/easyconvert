import { describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertFile } from '../src/lib/conversions';
import {
  convertFontToTrueType,
  decodeSfnt,
  encodeSvgFont,
  extractCffGlyphs,
  parseFontToSfnt,
} from '../src/lib/conversions/font';
import {
  CFF_ABSOLUTE_MAX_SEGMENTS_PER_FONT,
  CFF_ABSOLUTE_MAX_STEPS_PER_FONT,
  CFF_BASE_SEGMENTS_PER_FONT,
  CFF_BASE_STEPS_PER_FONT,
  CFF_MAX_SEGMENTS_PER_GLYPH,
  CffCharStringError,
  CffFormatError,
  cffFontBudgets,
  parseCff,
} from '../src/lib/conversions/font-cff';
import { ConversionFailedError } from '../src/lib/types';
import {
  buildCff,
  buildCffWithLayout,
  buildOtf,
  buildOverlappingPrivateCff,
  cs,
  padCff,
  sidForAscii,
  type CharstringItem,
  type OtfGlyph,
  type OtfSpec,
} from './helpers/cff-font-builder';
import { buildTrueTypeFont } from './helpers/mac-font-containers';

/** Real engine, CLI or large-input work: the 5 s default fails on a loaded CI shard without any regression; 60 s only stops a hang. */
const ENGINE_TEST_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: ENGINE_TEST_TIMEOUT_MS });

/**
 * CFF-flavoured OpenType (OTTO) to TrueType conversion.
 *
 * Inputs are built by tests/helpers/cff-font-builder.ts, an independent CFF writer with its own
 * Type 2 charstring assembler. Expected geometry is written down by hand as absolute outlines in
 * each fixture, never derived from the engine. Outputs are decoded by the glyf reader in this file
 * (authored from the OpenType glyf specification) and compared with the hand-written geometry by
 * area, orientation, point count and a two-sided distance check. fc-scan and a FreeType render
 * (ImageMagick) are additional external oracles when installed.
 */

const HAS_FC_SCAN = spawnSync('fc-scan', ['--version'], { stdio: 'ignore' }).status === 0;
const HAS_CONVERT = spawnSync('convert', ['-version'], { stdio: 'ignore' }).status === 0;
const HAS_FREETYPE =
  HAS_CONVERT &&
  spawnSync('sh', ['-c', "convert -list format | grep -q 'OTF.*Freetype'"], { stdio: 'ignore' }).status === 0;
// CI runs the oracles in strict mode: a missing fc-scan or FreeType renderer must fail there instead of skipping.
if (process.env.ORACLE_STRICT_MODE === '1' && !HAS_FC_SCAN) {
  throw new Error('ORACLE_STRICT_MODE requires fc-scan (fontconfig) for the CFF to TrueType oracle');
}
if (process.env.ORACLE_STRICT_MODE === '1' && !HAS_FREETYPE) {
  throw new Error('ORACLE_STRICT_MODE requires ImageMagick built with FreeType for the CFF to TrueType render oracle');
}

const SFNT_TRUETYPE = 0x00010000;
const SFNT_HEADER_SIZE = 12;
const SFNT_DIRECTORY_ENTRY_SIZE = 16;
const HEAD_INDEX_TO_LOC_FORMAT_OFFSET = 50;
const HEAD_UNITS_PER_EM_OFFSET = 18;
const HEAD_BBOX_OFFSET = 36;
/** Hang guards only (deterministic step budgets end these conversions in milliseconds); see ENGINE_TEST_TIMEOUT_MS. */
const REJECT_HANG_GUARD_MS = 30_000;
const FONT_BUDGET_HANG_GUARD_MS = 30_000;
const CURVE_SAMPLES = 96;
const RESAMPLE_STEP = 3;
/** Quadratic approximation (<= 0.5 unit) plus integer rounding (<= 0.71 unit) of the converter. */
const GEOMETRY_TOLERANCE = 1.25;
const AREA_RELATIVE_TOLERANCE = 0.006;
const AREA_ABSOLUTE_TOLERANCE = 8;

// ---------------------------------------------------------------------------
// Hand-written expected geometry (font units, y up, CFF convention: outer contours counter-clockwise)
// ---------------------------------------------------------------------------

type Cmd = ['M', number, number] | ['L', number, number] | ['C', number, number, number, number, number, number];
type Shape = Cmd[][];

interface Pt {
  x: number;
  y: number;
}

interface GlyphFixture {
  name: string;
  codePoint: number;
  charstring: Buffer;
  advance: number;
  shape: Shape;
  /** Exact point count of every output contour when the glyph has no curves. */
  exactLines?: boolean;
}

const DEFAULT_WIDTH_X = 800;
const NOMINAL_WIDTH_X = 500;

function shapeXMin(shape: Shape): number {
  let min = Infinity;
  for (const contour of shape) {
    for (const cmd of contour) min = Math.min(min, cmd[cmd.length - 2] as number);
  }
  return min;
}

const RECT: Shape = [[['M', 100, 0], ['L', 500, 0], ['L', 500, 700], ['L', 100, 700]]];

const OUTER_RING: Cmd[] = [
  ['M', 750, 350],
  ['C', 750, 543, 593, 700, 400, 700],
  ['C', 207, 700, 50, 543, 50, 350],
  ['C', 50, 157, 207, 0, 400, 0],
  ['C', 593, 0, 750, 157, 750, 350],
];
const INNER_RING: Cmd[] = [
  ['M', 600, 350],
  ['C', 600, 240, 510, 150, 400, 150],
  ['C', 290, 150, 200, 240, 200, 350],
  ['C', 200, 460, 290, 550, 400, 550],
  ['C', 510, 550, 600, 460, 600, 350],
];
const RING: Shape = [OUTER_RING, INNER_RING];

/** Gently bulging bottom edge shared by the four flex operator glyphs. */
const FLEX_SHAPE: Shape = [
  [
    ['M', 100, 0],
    ['C', 150, 0, 200, 20, 300, 20],
    ['C', 400, 20, 450, 0, 500, 0],
    ['L', 500, 700],
    ['L', 100, 700],
  ],
];

const hexMask = (...bytes: number[]): Buffer => Buffer.from(bytes);

const BASIC_FIXTURES: GlyphFixture[] = [
  {
    name: 'rectangle with explicit width',
    codePoint: 0x41,
    // width delta 100 (nominalWidthX 500 -> 600), rmoveto 100 0, hlineto 400 700 -400
    charstring: cs(100, 100, 0, 'rmoveto', 400, 700, -400, 'hlineto', 'endchar'),
    advance: 600,
    shape: RECT,
    exactLines: true,
  },
  {
    name: 'ring from rrcurveto',
    codePoint: 0x42,
    charstring: cs(
      750, 350, 'rmoveto',
      0, 193, -157, 157, -193, 0,
      -193, 0, -157, -157, 0, -193,
      0, -193, 157, -157, 193, 0,
      193, 0, 157, 157, 0, 193,
      'rrcurveto',
      -150, 'hmoveto',
      0, -110, -90, -90, -110, 0,
      -110, 0, -90, 90, 0, 110,
      0, 110, 90, 90, 110, 0,
      110, 0, 90, -90, 0, -110,
      'rrcurveto',
      'endchar'
    ),
    advance: DEFAULT_WIDTH_X,
    shape: RING,
  },
  {
    name: 'ring from vhcurveto',
    codePoint: 0x43,
    charstring: cs(
      750, 350, 'rmoveto',
      193, -157, 157, -193, -193, -157, -157, -193, -193, 157, -157, 193, 193, 157, 157, 193,
      'vhcurveto',
      -150, 'hmoveto',
      -110, -90, -90, -110, -110, -90, 90, 110, 110, 90, 90, 110, 110, 90, -90, -110,
      'vhcurveto',
      'endchar'
    ),
    advance: DEFAULT_WIDTH_X,
    shape: RING,
  },
  {
    name: 'rounded stem from hvcurveto with trailing argument',
    codePoint: 0x44,
    charstring: cs(
      100, 0, 'rmoveto',
      300, 'hlineto',
      50, 50, 50, 50, 10, 'hvcurveto',
      500, 'vlineto',
      50, -60, 50, -50, 'vhcurveto',
      -300, 'hlineto',
      'endchar'
    ),
    advance: DEFAULT_WIDTH_X,
    shape: [
      [
        ['M', 100, 0],
        ['L', 400, 0],
        ['C', 450, 0, 500, 50, 510, 100],
        ['L', 510, 600],
        ['C', 510, 650, 450, 700, 400, 700],
        ['L', 100, 700],
      ],
    ],
  },
  {
    name: 'flex',
    codePoint: 0x46,
    charstring: cs(100, 0, 'rmoveto', 50, 0, 50, 20, 100, 0, 100, 0, 50, -20, 50, 0, 50, 'flex', 700, -400, 'vlineto', 'endchar'),
    advance: DEFAULT_WIDTH_X,
    shape: FLEX_SHAPE,
  },
  {
    name: 'hflex',
    codePoint: 0x47,
    charstring: cs(100, 0, 'rmoveto', 50, 50, 20, 100, 100, 50, 50, 'hflex', 700, -400, 'vlineto', 'endchar'),
    advance: DEFAULT_WIDTH_X,
    shape: FLEX_SHAPE,
  },
  {
    name: 'hflex1',
    codePoint: 0x48,
    charstring: cs(100, 0, 'rmoveto', 50, 10, 50, 20, 100, 100, 50, -20, 50, 'hflex1', 700, -400, 'vlineto', 'endchar'),
    advance: DEFAULT_WIDTH_X,
    shape: [
      [
        ['M', 100, 0],
        ['C', 150, 10, 200, 30, 300, 30],
        ['C', 400, 30, 450, 10, 500, 0],
        ['L', 500, 700],
        ['L', 100, 700],
      ],
    ],
  },
  {
    name: 'flex1 closing horizontally',
    codePoint: 0x49,
    charstring: cs(100, 0, 'rmoveto', 50, 5, 50, 15, 100, 5, 100, 5, 50, -15, 50, 'flex1', 700, -400, 'vlineto', 'endchar'),
    advance: DEFAULT_WIDTH_X,
    shape: [
      [
        ['M', 100, 0],
        ['C', 150, 5, 200, 20, 300, 25],
        ['C', 400, 30, 450, 15, 500, 0],
        ['L', 500, 700],
        ['L', 100, 700],
      ],
    ],
  },
  {
    name: 'flex1 closing vertically',
    codePoint: 0x4a,
    charstring: cs(0, 100, 'rmoveto', 5, 50, 15, 50, 5, 100, 5, 100, -15, 50, 50, 'flex1', 700, -400, 'hlineto', 'endchar'),
    advance: DEFAULT_WIDTH_X,
    shape: [
      [
        ['M', 0, 100],
        ['C', 5, 150, 20, 200, 25, 300],
        ['C', 30, 400, 15, 450, 0, 500],
        ['L', 700, 500],
        ['L', 700, 100],
      ],
    ],
  },
  {
    name: 'stem hints, hintmask and cntrmask with two-byte masks',
    codePoint: 0x4b,
    charstring: cs(
      // width delta 150 (nominalWidthX 500 -> 650), five horizontal stems, then four implicit vertical stems
      150, 0, 20, 100, 20, 200, 20, 300, 20, 400, 20, 'hstemhm',
      50, 20, 150, 20, 250, 20, 350, 20, 'cntrmask', hexMask(0x80, 0x00),
      'hintmask', hexMask(0xf0, 0x80),
      100, 0, 'rmoveto',
      300, 700, -300, 'hlineto',
      'hintmask', hexMask(0x40, 0xff),
      50, -600, 'rmoveto',
      500, 150, -500, 'vlineto',
      'endchar'
    ),
    advance: 650,
    shape: [
      [['M', 100, 0], ['L', 400, 0], ['L', 400, 700], ['L', 100, 700]],
      [['M', 150, 100], ['L', 150, 600], ['L', 300, 600], ['L', 300, 100]],
    ],
    exactLines: true,
  },
  {
    name: 'arithmetic operators',
    codePoint: 0x4c,
    charstring: cs(
      100, 0, 'rmoveto',
      150, 150, 'add', 7, 100, 'mul', 300, 'neg', 'hlineto',
      50, 60, 3, 4, 'ifelse', -600, 0, 'put', 0, 'get', 'rmoveto',
      150, 500, 'exch', 500, 'neg', 'vlineto',
      900, 2, 'div', 100, 'abs', 150, 'sub', 'rmoveto',
      200, -100, 100, 3, 1, 'roll', 'hlineto',
      100, 3, 3, 'eq', 0, 'not', 'and', 0, 'or', 'add', -200, 'dup', 'drop', 'rmoveto',
      20, 30, 1, 'index', 'neg', 'hlineto',
      'endchar'
    ),
    advance: DEFAULT_WIDTH_X,
    shape: [
      [['M', 100, 0], ['L', 400, 0], ['L', 400, 700], ['L', 100, 700]],
      [['M', 150, 100], ['L', 150, 600], ['L', 300, 600], ['L', 300, 100]],
      [['M', 750, 50], ['L', 850, 50], ['L', 850, 250], ['L', 750, 250]],
      [['M', 851, 50], ['L', 871, 50], ['L', 871, 80], ['L', 851, 80]],
    ],
    exactLines: true,
  },
];

// ---------------------------------------------------------------------------
// Fixture fonts
// ---------------------------------------------------------------------------

function toOtfGlyphs(fixtures: GlyphFixture[]): OtfGlyph[] {
  const notdef: OtfGlyph = { charstring: cs('endchar'), advance: 500, lsb: 0 };
  return [
    notdef,
    ...fixtures.map((f) => ({ charstring: f.charstring, advance: f.advance, lsb: shapeXMin(f.shape) })),
  ];
}

function fixtureFont(fixtures: GlyphFixture[], overrides: Partial<OtfSpec> = {}): Buffer {
  return buildOtf({
    family: 'Cff Probe',
    glyphs: toOtfGlyphs(fixtures),
    codePoints: fixtures.map((f) => f.codePoint),
    cff: { defaultWidthX: DEFAULT_WIDTH_X, nominalWidthX: NOMINAL_WIDTH_X },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Independent sfnt / glyf reader (OpenType glyf specification)
// ---------------------------------------------------------------------------

function readSfntTables(font: Buffer): Map<string, Buffer> {
  const tables = new Map<string, Buffer>();
  const numTables = font.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const base = SFNT_HEADER_SIZE + i * SFNT_DIRECTORY_ENTRY_SIZE;
    const tag = font.toString('latin1', base, base + 4);
    const offset = font.readUInt32BE(base + 8);
    const length = font.readUInt32BE(base + 12);
    expect(offset + length).toBeLessThanOrEqual(font.length);
    tables.set(tag, font.subarray(offset, offset + length));
  }
  return tables;
}

interface TtPoint extends Pt {
  on: boolean;
}

interface TtGlyph {
  bbox: [number, number, number, number];
  contours: TtPoint[][];
}

function readGlyf(tables: Map<string, Buffer>, glyphId: number): TtGlyph | null {
  const head = tables.get('head')!;
  const loca = tables.get('loca')!;
  const glyf = tables.get('glyf')!;
  const long = head.readInt16BE(HEAD_INDEX_TO_LOC_FORMAT_OFFSET) === 1;
  const start = long ? loca.readUInt32BE(glyphId * 4) : loca.readUInt16BE(glyphId * 2) * 2;
  const end = long ? loca.readUInt32BE(glyphId * 4 + 4) : loca.readUInt16BE(glyphId * 2 + 2) * 2;
  if (end === start) return null;
  const numberOfContours = glyf.readInt16BE(start);
  expect(numberOfContours).toBeGreaterThan(0);
  const bbox: [number, number, number, number] = [
    glyf.readInt16BE(start + 2),
    glyf.readInt16BE(start + 4),
    glyf.readInt16BE(start + 6),
    glyf.readInt16BE(start + 8),
  ];
  let p = start + 10;
  const endPoints: number[] = [];
  for (let c = 0; c < numberOfContours; c++, p += 2) endPoints.push(glyf.readUInt16BE(p));
  const numPoints = endPoints[endPoints.length - 1] + 1;
  p += 2 + glyf.readUInt16BE(p);
  const flags: number[] = [];
  while (flags.length < numPoints) {
    const flag = glyf[p++];
    flags.push(flag);
    if (flag & 0x08) {
      const repeat = glyf[p++];
      for (let r = 0; r < repeat; r++) flags.push(flag);
    }
  }
  const coordinates = (shortBit: number, sameBit: number): number[] => {
    const values: number[] = [];
    let value = 0;
    for (const flag of flags) {
      if (flag & shortBit) {
        const delta = glyf[p++];
        value += flag & sameBit ? delta : -delta;
      } else if (!(flag & sameBit)) {
        value += glyf.readInt16BE(p);
        p += 2;
      }
      values.push(value);
    }
    return values;
  };
  const xs = coordinates(0x02, 0x10);
  const ys = coordinates(0x04, 0x20);
  const contours: TtPoint[][] = [];
  let first = 0;
  for (const last of endPoints) {
    const contour: TtPoint[] = [];
    for (let i = first; i <= last; i++) contour.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) === 1 });
    contours.push(contour);
    first = last + 1;
  }
  expect(p).toBeLessThanOrEqual(end);
  return { bbox, contours };
}

function sampleQuadratic(a: Pt, c: Pt, b: Pt): Pt[] {
  const out: Pt[] = [];
  for (let i = 1; i <= CURVE_SAMPLES; i++) {
    const t = i / CURVE_SAMPLES;
    const u = 1 - t;
    out.push({
      x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
      y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
    });
  }
  return out;
}

/** Flattens a TrueType contour (implied on-curve midpoints between consecutive off-curve points). */
function flattenTrueType(points: TtPoint[]): Pt[] {
  const expanded: TtPoint[] = [];
  points.forEach((cur, i) => {
    const next = points[(i + 1) % points.length];
    expanded.push(cur);
    if (!cur.on && !next.on) expanded.push({ x: (cur.x + next.x) / 2, y: (cur.y + next.y) / 2, on: true });
  });
  const firstOn = expanded.findIndex((p) => p.on);
  expect(firstOn).toBeGreaterThanOrEqual(0);
  const ring = [...expanded.slice(firstOn), ...expanded.slice(0, firstOn)];
  const poly: Pt[] = [{ x: ring[0].x, y: ring[0].y }];
  let i = 1;
  while (i <= ring.length) {
    const point = ring[i % ring.length];
    const prev = poly[poly.length - 1];
    if (point.on) {
      poly.push({ x: point.x, y: point.y });
      i += 1;
    } else {
      const end = ring[(i + 1) % ring.length];
      poly.push(...sampleQuadratic(prev, point, end));
      i += 2;
    }
  }
  poly.pop(); // the loop returns to the start point
  return poly;
}

function sampleCubic(a: Pt, c1: Pt, c2: Pt, b: Pt): Pt[] {
  const out: Pt[] = [];
  for (let i = 1; i <= CURVE_SAMPLES; i++) {
    const t = i / CURVE_SAMPLES;
    const u = 1 - t;
    out.push({
      x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
    });
  }
  return out;
}

function flattenExpected(contour: Cmd[]): Pt[] {
  const poly: Pt[] = [];
  for (const cmd of contour) {
    if (cmd[0] === 'M' || cmd[0] === 'L') {
      poly.push({ x: cmd[1], y: cmd[2] });
    } else {
      const prev = poly[poly.length - 1];
      poly.push(
        ...sampleCubic(prev, { x: cmd[1], y: cmd[2] }, { x: cmd[3], y: cmd[4] }, { x: cmd[5], y: cmd[6] })
      );
    }
  }
  // A contour that returns to its start point repeats it; the closing edge is implicit.
  const first = poly[0];
  const last = poly[poly.length - 1];
  if (poly.length > 1 && first.x === last.x && first.y === last.y) poly.pop();
  return poly;
}

/** Shoelace area: positive for counter-clockwise polygons in a y-up coordinate system. */
function signedArea(poly: Pt[]): number {
  let sum = 0;
  poly.forEach((a, i) => {
    const b = poly[(i + 1) % poly.length];
    sum += a.x * b.y - b.x * a.y;
  });
  return sum / 2;
}

function resample(poly: Pt[]): Pt[] {
  const out: Pt[] = [];
  poly.forEach((a, i) => {
    const b = poly[(i + 1) % poly.length];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / RESAMPLE_STEP));
    for (let s = 0; s < steps; s++) {
      out.push({ x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps });
    }
  });
  return out;
}

function distanceToPolygon(pt: Pt, poly: Pt[]): number {
  let best = Infinity;
  poly.forEach((a, i) => {
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2));
    best = Math.min(best, Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy)));
  });
  return best;
}

function hausdorff(a: Pt[], b: Pt[]): number {
  const forward = Math.max(...resample(a).map((pt) => distanceToPolygon(pt, b)));
  const backward = Math.max(...resample(b).map((pt) => distanceToPolygon(pt, a)));
  return Math.max(forward, backward);
}

function bounds(polys: Pt[][]): [number, number, number, number] {
  const all = polys.flat();
  return [
    Math.min(...all.map((p) => p.x)),
    Math.min(...all.map((p) => p.y)),
    Math.max(...all.map((p) => p.x)),
    Math.max(...all.map((p) => p.y)),
  ];
}

/**
 * Asserts that a converted glyph is the hand-written shape with every contour reversed (TrueType
 * outer contours run clockwise, CFF outer contours counter-clockwise).
 */
function expectGlyphMatches(glyph: TtGlyph | null, fixture: GlyphFixture): void {
  expect(glyph, fixture.name).not.toBeNull();
  const out = glyph!;
  expect(out.contours.length, `${fixture.name}: contour count`).toBe(fixture.shape.length);
  const expectedPolys = fixture.shape.map(flattenExpected);
  const outPolys = out.contours.map(flattenTrueType);

  expectedPolys.forEach((expectedPoly, c) => {
    const expectedArea = signedArea(expectedPoly);
    const outArea = signedArea(outPolys[c]);
    expect(Math.sign(outArea), `${fixture.name}: contour ${c} direction`).toBe(-Math.sign(expectedArea));
    const tolerance = Math.max(AREA_ABSOLUTE_TOLERANCE, Math.abs(expectedArea) * AREA_RELATIVE_TOLERANCE);
    expect(Math.abs(-outArea - expectedArea), `${fixture.name}: contour ${c} area`).toBeLessThanOrEqual(tolerance);
    expect(hausdorff(expectedPoly, outPolys[c]), `${fixture.name}: contour ${c} distance`).toBeLessThanOrEqual(
      GEOMETRY_TOLERANCE
    );
  });

  const totalExpected = expectedPolys.map(signedArea).reduce((a, b) => a + b, 0);
  const totalOut = outPolys.map(signedArea).reduce((a, b) => a + b, 0);
  expect(Math.abs(-totalOut - totalExpected), `${fixture.name}: total area`).toBeLessThanOrEqual(
    Math.max(AREA_ABSOLUTE_TOLERANCE, Math.abs(totalExpected) * AREA_RELATIVE_TOLERANCE)
  );

  const [xMin, yMin, xMax, yMax] = bounds(expectedPolys);
  const [oxMin, oyMin, oxMax, oyMax] = bounds(outPolys);
  for (const [actual, expected] of [
    [oxMin, xMin],
    [oyMin, yMin],
    [oxMax, xMax],
    [oyMax, yMax],
  ]) {
    expect(Math.abs(actual - expected), `${fixture.name}: bounds`).toBeLessThanOrEqual(GEOMETRY_TOLERANCE);
  }

  // The glyph header box must be the box of the decoded points (control points included).
  const allPoints = out.contours.flat();
  expect(out.bbox).toEqual([
    Math.min(...allPoints.map((p) => p.x)),
    Math.min(...allPoints.map((p) => p.y)),
    Math.max(...allPoints.map((p) => p.x)),
    Math.max(...allPoints.map((p) => p.y)),
  ]);

  if (fixture.exactLines) {
    // Line-only glyphs convert without approximation: the same corner points, reversed.
    const expectedCorners = fixture.shape.map((contour) => contour.map((cmd) => `${cmd[1]},${cmd[2]}`).sort());
    const outCorners = out.contours.map((contour) => contour.map((p) => `${p.x},${p.y}`).sort());
    expect(outCorners).toEqual(expectedCorners);
    expect(out.contours.flat().every((p) => p.on)).toBe(true);
  } else {
    expect(out.contours.flat().some((p) => !p.on), `${fixture.name}: quadratic control points`).toBe(true);
  }
}

async function convertToTtf(otf: Buffer): Promise<Buffer> {
  const result = await convertFile(otf, 'otf', 'ttf', {}, 'probe.otf');
  expect(result.mimeType).toBe('font/ttf');
  expect(result.filename).toBe('probe.ttf');
  expect(result.size).toBe(result.buffer.length);
  return result.buffer;
}

// ---------------------------------------------------------------------------
// Conversion of the fixture glyphs
// ---------------------------------------------------------------------------

describe('CFF to TrueType: outlines are converted, not replaced by placeholder glyphs', () => {
  it.each(BASIC_FIXTURES.map((f) => [f.name, f] as const))('%s', async (_name, fixture) => {
    const otf = fixtureFont([fixture]);
    const ttf = await convertToTtf(otf);
    const tables = readSfntTables(ttf);
    expect(ttf.readUInt32BE(0)).toBe(SFNT_TRUETYPE);
    expect(tables.has('CFF ')).toBe(false);
    expect(tables.has('glyf')).toBe(true);
    expect(tables.has('loca')).toBe(true);
    expectGlyphMatches(readGlyf(tables, 1), fixture);
    // .notdef is an empty charstring, so it has no outline.
    expect(readGlyf(tables, 0)).toBeNull();
  });

  it('converts every fixture glyph of one font and fills the TrueType bookkeeping tables', async () => {
    const otf = fixtureFont(BASIC_FIXTURES);
    const input = readSfntTables(otf);
    const ttf = await convertToTtf(otf);
    const tables = readSfntTables(ttf);
    const numGlyphs = BASIC_FIXTURES.length + 1;

    BASIC_FIXTURES.forEach((fixture, i) => expectGlyphMatches(readGlyf(tables, i + 1), fixture));

    // head: 32-bit loca offsets, loca sized for numGlyphs + 1 entries, box covering all glyphs.
    const head = tables.get('head')!;
    expect(head.readInt16BE(HEAD_INDEX_TO_LOC_FORMAT_OFFSET)).toBe(1);
    expect(tables.get('loca')!).toHaveLength((numGlyphs + 1) * 4);
    const glyphs = Array.from({ length: numGlyphs }, (_, g) => readGlyf(tables, g));
    const present = glyphs.filter((g): g is TtGlyph => g !== null);
    expect([
      head.readInt16BE(HEAD_BBOX_OFFSET),
      head.readInt16BE(HEAD_BBOX_OFFSET + 2),
      head.readInt16BE(HEAD_BBOX_OFFSET + 4),
      head.readInt16BE(HEAD_BBOX_OFFSET + 6),
    ]).toEqual([
      Math.min(...present.map((g) => g.bbox[0])),
      Math.min(...present.map((g) => g.bbox[1])),
      Math.max(...present.map((g) => g.bbox[2])),
      Math.max(...present.map((g) => g.bbox[3])),
    ]);

    // maxp version 1.0 with counts that describe the real glyphs.
    const maxp = tables.get('maxp')!;
    expect(maxp).toHaveLength(32);
    expect(maxp.readUInt32BE(0)).toBe(0x00010000);
    expect(maxp.readUInt16BE(4)).toBe(numGlyphs);
    expect(maxp.readUInt16BE(6)).toBe(Math.max(...present.map((g) => g.contours.flat().length)));
    expect(maxp.readUInt16BE(8)).toBe(Math.max(...present.map((g) => g.contours.length)));
    expect(maxp.readUInt16BE(14)).toBeGreaterThanOrEqual(1);

    // hmtx keeps the advances of the source font and records lsb == glyph xMin.
    const hhea = tables.get('hhea')!;
    const hmtx = tables.get('hmtx')!;
    const metrics = hhea.readUInt16BE(34);
    const inputHmtx = input.get('hmtx')!;
    for (let g = 0; g < numGlyphs; g++) {
      expect(g < metrics).toBe(true);
      expect(hmtx.readUInt16BE(g * 4)).toBe(inputHmtx.readUInt16BE(g * 4));
      const glyph = glyphs[g];
      expect(hmtx.readInt16BE(g * 4 + 2)).toBe(glyph === null ? 0 : glyph.bbox[0]);
    }
    expect(hmtx).toHaveLength(metrics * 4 + (numGlyphs - metrics) * 2);
    expect(hhea.readUInt16BE(10)).toBe(Math.max(...BASIC_FIXTURES.map((f) => f.advance), 500));

    // Identity tables travel unchanged.
    for (const tag of ['cmap', 'name', 'OS/2', 'post']) {
      expect(tables.get(tag)!.equals(input.get(tag)!), tag).toBe(true);
    }
    // The glyphs are not the old placeholders (a 700-unit square or the fixed triangle).
    expect(glyphs[2]!.contours).toHaveLength(2);
    expect(glyphs[1]!.bbox).toEqual([100, 0, 500, 700]);
  });

  it('leaves a TrueType font with glyf and loca untouched', () => {
    const otf = fixtureFont([BASIC_FIXTURES[0]]);
    const once = convertFontToTrueType(otf) as Buffer;
    const twice = convertFontToTrueType(once) as Buffer;
    expect(twice.equals(once)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Subroutines, seac, CID-keyed fonts, FontMatrix
// ---------------------------------------------------------------------------

const RECT_300x200 = cs(300, 200, -300, 'hlineto', 'return');

describe('CFF to TrueType: subroutines, seac, CID-keyed fonts and FontMatrix', () => {
  it('runs local and global subroutines, including a nested call', async () => {
    const fixture: GlyphFixture = {
      name: 'subroutines',
      codePoint: 0x45,
      // local 0 draws the first rectangle; local 1 calls global 0, which moves and draws the second.
      charstring: cs(50, 50, 'rmoveto', -107, 'callsubr', -106, 'callsubr', 'endchar'),
      advance: DEFAULT_WIDTH_X,
      shape: [
        [['M', 50, 50], ['L', 350, 50], ['L', 350, 250], ['L', 50, 250]],
        [['M', 450, 50], ['L', 650, 50], ['L', 650, 200], ['L', 450, 200]],
      ],
      exactLines: true,
    };
    const otf = fixtureFont([fixture], {
      cff: {
        defaultWidthX: DEFAULT_WIDTH_X,
        nominalWidthX: NOMINAL_WIDTH_X,
        localSubrs: [RECT_300x200, cs(-107, 'callgsubr', 'return')],
        globalSubrs: [cs(400, -200, 'rmoveto', 200, 150, -200, 'hlineto', 'return')],
      },
    });
    const tables = readSfntTables(await convertToTtf(otf));
    expectGlyphMatches(readGlyf(tables, 1), fixture);
  });

  it('applies the subroutine bias of 1131 for fonts with 1240 or more subroutines', async () => {
    const fixture: GlyphFixture = {
      name: 'large subr bias',
      codePoint: 0x45,
      charstring: cs(50, 50, 'rmoveto', 0, 'callsubr', 'endchar'),
      advance: DEFAULT_WIDTH_X,
      shape: [[['M', 50, 50], ['L', 350, 50], ['L', 350, 250], ['L', 50, 250]]],
      exactLines: true,
    };
    const subrs = Array.from({ length: 1300 }, (_, i) => (i === 1131 ? RECT_300x200 : cs('return')));
    const otf = fixtureFont([fixture], {
      cff: { defaultWidthX: DEFAULT_WIDTH_X, nominalWidthX: NOMINAL_WIDTH_X, localSubrs: subrs },
    });
    const tables = readSfntTables(await convertToTtf(otf));
    expectGlyphMatches(readGlyf(tables, 1), fixture);
  });

  const cidFixtures = (): { glyphs: OtfGlyph[]; shapes: Shape[] } => ({
    glyphs: [
      { charstring: cs('endchar'), advance: 500, lsb: 0 },
      { charstring: cs(100, 50, 'rmoveto', -107, 'callsubr', 'endchar'), advance: 600, lsb: 100 },
      { charstring: cs(150, 100, 0, 'rmoveto', -107, 'callsubr', 'endchar'), advance: 550, lsb: 100 },
      { charstring: cs(100, 50, 'rmoveto', -107, 'callsubr', 'endchar'), advance: 900, lsb: 100 },
      { charstring: cs(-100, 20, 20, 'rmoveto', -107, 'callsubr', 'endchar'), advance: 200, lsb: 20 },
    ],
    // Font DICT 0 and font DICT 1 both define local subr 0, with different outlines.
    shapes: [
      [[['M', 100, 50], ['L', 300, 50], ['L', 300, 350], ['L', 100, 350]]],
      [[['M', 100, 0], ['L', 300, 0], ['L', 300, 300], ['L', 100, 300]]],
      [[['M', 100, 50], ['L', 200, 50], ['L', 200, 450], ['L', 100, 450]]],
      [[['M', 20, 20], ['L', 120, 20], ['L', 120, 420], ['L', 20, 420]]],
    ],
  });

  it.each([0, 3] as const)('converts a CID-keyed font with per-FD subroutines (FDSelect format %i)', async (format) => {
    const { glyphs, shapes } = cidFixtures();
    const otf = buildOtf({
      family: 'Cid Probe',
      glyphs,
      codePoints: [0x41, 0x42, 0x43, 0x44],
      cff: {
        charset: [1, 5, 10, 20],
        cid: {
          registrySid: 391,
          orderingSid: 392,
          supplement: 0,
          fds: [
            { defaultWidthX: 600, nominalWidthX: 400, localSubrs: [cs(200, 300, -200, 'hlineto', 'return')] },
            { defaultWidthX: 900, nominalWidthX: 300, localSubrs: [cs(100, 400, -100, 'hlineto', 'return')] },
          ],
          fdSelect: { format, fdOfGlyph: [0, 0, 0, 1, 1] },
        },
        strings: ['Adobe', 'Identity'],
      },
    });
    const tables = readSfntTables(await convertToTtf(otf));
    shapes.forEach((shape, i) => {
      expectGlyphMatches(readGlyf(tables, i + 1), {
        name: `cid glyph ${i + 1}`,
        codePoint: 0x41 + i,
        charstring: Buffer.alloc(0),
        advance: 0,
        shape,
        exactLines: true,
      });
    });
  });

  it('reads charstring widths from each font DICT (defaultWidthX / nominalWidthX)', () => {
    const { glyphs } = cidFixtures();
    const cff = buildCff({
      fontName: 'CidWidths',
      charstrings: glyphs.map((g) => g.charstring),
      charset: [1, 5, 10, 20],
      strings: ['Adobe', 'Identity'],
      cid: {
        registrySid: 391,
        orderingSid: 392,
        supplement: 0,
        fds: [
          { defaultWidthX: 600, nominalWidthX: 400, localSubrs: [cs(200, 300, -200, 'hlineto', 'return')] },
          { defaultWidthX: 900, nominalWidthX: 300, localSubrs: [cs(100, 400, -100, 'hlineto', 'return')] },
        ],
        fdSelect: { format: 3, fdOfGlyph: [0, 0, 0, 1, 1] },
      },
    });
    const font = parseCff(cff);
    expect(font.isCidKeyed).toBe(true);
    expect(font.numGlyphs).toBe(5);
    expect(Array.from(font.charset!)).toEqual([0, 1, 5, 10, 20]);
    expect(Array.from({ length: font.numGlyphs }, (_, g) => font.glyph(g).width)).toEqual([600, 600, 550, 900, 200]);
  });

  it('rebuilds hmtx from the charstring widths when the source font has no hmtx', async () => {
    const { glyphs } = cidFixtures();
    const otf = buildOtf({
      family: 'Cid Probe',
      glyphs,
      codePoints: [0x41, 0x42, 0x43, 0x44],
      omitTables: ['hmtx'],
      cff: {
        charset: [1, 5, 10, 20],
        strings: ['Adobe', 'Identity'],
        cid: {
          registrySid: 391,
          orderingSid: 392,
          supplement: 0,
          fds: [
            { defaultWidthX: 600, nominalWidthX: 400, localSubrs: [cs(200, 300, -200, 'hlineto', 'return')] },
            { defaultWidthX: 900, nominalWidthX: 300, localSubrs: [cs(100, 400, -100, 'hlineto', 'return')] },
          ],
          fdSelect: { format: 3, fdOfGlyph: [0, 0, 0, 1, 1] },
        },
      },
    });
    const tables = readSfntTables(await convertToTtf(otf));
    const hmtx = tables.get('hmtx')!;
    const advances = [0, 1, 2, 3, 4].map((g) => hmtx.readUInt16BE(g * 4));
    expect(advances).toEqual([600, 600, 550, 900, 200]);
    const lsbs = [1, 2, 3, 4].map((g) => hmtx.readInt16BE(g * 4 + 2));
    expect(lsbs).toEqual([100, 100, 100, 20]);
  });

  it('scales coordinates by FontMatrix relative to head.unitsPerEm', async () => {
    // Charstring units are 2048 per em (FontMatrix 1/2048); the head table declares 1000 per em.
    const doubled: GlyphFixture = {
      name: 'font matrix',
      codePoint: 0x41,
      charstring: cs(200, 0, 'rmoveto', 800, 1400, -800, 'hlineto', 'endchar'),
      advance: 1600,
      shape: [[['M', 200, 0], ['L', 1000, 0], ['L', 1000, 1400], ['L', 200, 1400]]],
    };
    const otf = fixtureFont([doubled], {
      cff: {
        defaultWidthX: 1600,
        nominalWidthX: 0,
        fontMatrix: ['0.00048828125', '0', '0', '0.00048828125', '0', '0'],
      },
    });
    const tables = readSfntTables(await convertToTtf(otf));
    const glyph = readGlyf(tables, 1)!;
    const scaled = 1000 / 2048;
    expect(glyph.bbox).toEqual([Math.round(200 * scaled), 0, Math.round(1000 * scaled), Math.round(1400 * scaled)]);
    expect(tables.get('head')!.readUInt16BE(HEAD_UNITS_PER_EM_OFFSET)).toBe(1000);
  });

  it('keeps outer contours clockwise when a mirroring FontMatrix already reversed their direction', async () => {
    const mirrored: GlyphFixture = {
      name: 'mirrored font matrix',
      codePoint: 0x41,
      charstring: cs(100, 0, 'rmoveto', 400, 700, -400, 'hlineto', 'endchar'),
      advance: 600,
      shape: [[['M', -100, 0], ['L', -500, 0], ['L', -500, 700], ['L', -100, 700]]],
    };
    const otf = fixtureFont([mirrored], {
      cff: {
        defaultWidthX: 600,
        nominalWidthX: 0,
        fontMatrix: ['-0.001', '0', '0', '0.001', '0', '0'],
      },
    });
    const tables = readSfntTables(await convertToTtf(otf));
    const glyph = readGlyf(tables, 1)!;
    expect(glyph.bbox).toEqual([-500, 0, -100, 700]);
    expect(glyph.contours).toHaveLength(1);
    // Mirroring the counter-clockwise charstring rectangle makes it clockwise; it must stay that way.
    expect(signedArea(flattenTrueType(glyph.contours[0]))).toBe(-280000);
  });

  it('keeps coordinates unchanged when FontMatrix agrees with head.unitsPerEm', async () => {
    const fixture: GlyphFixture = {
      name: 'matching font matrix',
      codePoint: 0x41,
      charstring: cs(200, 0, 'rmoveto', 800, 1400, -800, 'hlineto', 'endchar'),
      advance: 1600,
      shape: [[['M', 200, 0], ['L', 1000, 0], ['L', 1000, 1400], ['L', 200, 1400]]],
      exactLines: true,
    };
    const otf = fixtureFont([fixture], {
      unitsPerEm: 2048,
      cff: {
        defaultWidthX: 1600,
        nominalWidthX: 0,
        fontMatrix: ['0.00048828125', '0', '0', '0.00048828125', '0', '0'],
      },
    });
    const tables = readSfntTables(await convertToTtf(otf));
    expectGlyphMatches(readGlyf(tables, 1), fixture);
  });
});

// ---------------------------------------------------------------------------
// Output validity against external readers
// ---------------------------------------------------------------------------

function fcScan(font: Buffer, extension: string): Record<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cff-ttf-'));
  try {
    const file = path.join(dir, `probe.${extension}`);
    fs.writeFileSync(file, font);
    const out = execFileSync(
      'fc-scan',
      ['--format', '%{family}\t%{style}\t%{fullname}\t%{postscriptname}\t%{charset}\t%{fontformat}\n', file],
      { encoding: 'utf8' }
    );
    const [family, style, fullname, postscriptname, charset, fontformat] = out.trim().split('\t');
    return { family, style, fullname, postscriptname, charset, fontformat };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!HAS_FC_SCAN)('CFF to TrueType: fontconfig reads the output as the same face (needs fc-scan)', () => {
  it('keeps family, style, names and character set and reports a TrueType face', async () => {
    const otf = fixtureFont(BASIC_FIXTURES);
    const before = fcScan(otf, 'otf');
    expect(before.fontformat).toBe('CFF');
    const after = fcScan(await convertToTtf(otf), 'ttf');
    expect(after.fontformat).toBe('TrueType');
    expect(after.family).toBe('Cff Probe');
    expect(after.style).toBe('Regular');
    expect(after.fullname).toBe(before.fullname);
    expect(after.postscriptname).toBe(before.postscriptname);
    expect(after.charset).toBe(before.charset);
    expect(after.charset).toBe('41-44 46-4c');
  });
});

const PNG_RENDER_SIZE = 96;
const PNG_POINT_SIZE = 72;
const INK_THRESHOLD = 128;

/** Renders one character with FreeType through ImageMagick into an 8-bit grayscale buffer. */
function renderGlyph(fontFile: string, char: string): Buffer {
  const pgm = execFileSync(
    'convert',
    [
      '-size', `${PNG_RENDER_SIZE}x${PNG_RENDER_SIZE}`, 'xc:white',
      '-font', fontFile,
      '-pointsize', String(PNG_POINT_SIZE),
      '-fill', 'black',
      '-gravity', 'SouthWest',
      '-annotate', '+4+16', char,
      '-depth', '8',
      'pgm:-',
    ],
    { maxBuffer: 1024 * 1024 }
  );
  // P5 header: "P5\nW H\n255\n"
  let newlines = 0;
  let at = 0;
  while (newlines < 3) {
    if (pgm[at++] === 0x0a) newlines++;
  }
  return pgm.subarray(at);
}

describe.skipIf(!HAS_FREETYPE)('CFF to TrueType: FreeType renders the output like the input (needs ImageMagick with FreeType)', () => {
  it('draws the same ink for every fixture glyph before and after conversion', async () => {
    const fixtures = BASIC_FIXTURES.filter((f) => f.codePoint !== 0x4a);
    const otf = fixtureFont(fixtures);
    const ttf = await convertToTtf(otf);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cff-render-'));
    try {
      const otfFile = path.join(dir, 'in.otf');
      const ttfFile = path.join(dir, 'out.ttf');
      fs.writeFileSync(otfFile, otf);
      fs.writeFileSync(ttfFile, ttf);
      for (const fixture of fixtures) {
        const char = String.fromCodePoint(fixture.codePoint);
        const before = renderGlyph(otfFile, char);
        const after = renderGlyph(ttfFile, char);
        expect(after).toHaveLength(before.length);
        const inkBefore = before.filter((v) => v < INK_THRESHOLD).length;
        expect(inkBefore, `${fixture.name}: input renders ink`).toBeGreaterThan(100);
        let union = 0;
        let intersection = 0;
        for (let i = 0; i < before.length; i++) {
          const a = before[i] < INK_THRESHOLD;
          const b = after[i] < INK_THRESHOLD;
          if (a || b) union++;
          if (a && b) intersection++;
        }
        expect(intersection / union, `${fixture.name}: ink overlap`).toBeGreaterThan(0.97);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// SVG font output uses the CFF outlines
// ---------------------------------------------------------------------------

describe('CFF to SVG font: outlines come from the CFF charstrings', () => {
  it('emits the real glyph paths and advances instead of default glyphs', async () => {
    const otf = fixtureFont([BASIC_FIXTURES[0], BASIC_FIXTURES[1]]);
    const result = await convertFile(otf, 'otf', 'svg', {}, 'probe.otf');
    const svg = result.buffer.toString('utf8');
    const glyphRe = /<glyph unicode="([^"]*)" horiz-adv-x="(\d+)" d="([^"]*)" \/>/g;
    const glyphs = new Map<string, { advance: number; d: string }>();
    for (const m of svg.matchAll(glyphRe)) glyphs.set(m[1], { advance: Number(m[2]), d: m[3] });

    const a = glyphs.get('A')!;
    expect(a.advance).toBe(600);
    expect(a.d).toBe('M100 0 L500 0 L500 700 L100 700 Z');

    const b = glyphs.get('B')!;
    expect(b.advance).toBe(DEFAULT_WIDTH_X);
    // The ring keeps its cubic curves exactly: one move and four cubics per contour.
    expect(b.d).toBe(
      'M750 350 C750 543 593 700 400 700 C207 700 50 543 50 350 C50 157 207 0 400 0 C593 0 750 157 750 350 Z ' +
        'M600 350 C600 240 510 150 400 150 C290 150 200 240 200 350 C200 460 290 550 400 550 C510 550 600 460 600 350 Z'
    );
    // None of the old hard-coded glyph paths appears.
    expect(svg).not.toContain('M30 0 L310 700');
    expect(svg).not.toContain('M80 0 L80 700');
  });

  it('fails closed instead of emitting default glyphs when the font has no outlines', async () => {
    const shell = fs.readFileSync(path.join(__dirname, 'fixtures/golden/font/variable-geometric.otf'));
    await expect(convertFile(shell, 'otf', 'svg', {}, 'shell.otf')).rejects.toThrow(ConversionFailedError);
    await expect(convertFile(shell, 'otf', 'svg', {}, 'shell.otf')).rejects.toThrow(/outline/i);
  });
});

// ---------------------------------------------------------------------------
// Fail closed
// ---------------------------------------------------------------------------

async function expectRejected(
  font: Buffer,
  errorClass: new (...args: never[]) => Error,
  pattern: RegExp,
  budgetMs = REJECT_HANG_GUARD_MS
): Promise<void> {
  const started = performance.now();
  let caught: unknown;
  try {
    await convertFile(font, 'otf', 'ttf', {}, 'hostile.otf');
  } catch (error) {
    caught = error;
  }
  const elapsed = performance.now() - started;
  expect(caught, 'conversion must throw').toBeInstanceOf(errorClass);
  expect(caught).toBeInstanceOf(ConversionFailedError);
  expect((caught as Error).message).toMatch(pattern);
  expect(elapsed).toBeLessThan(budgetMs);
}

function singleGlyphFont(charstring: Buffer, cffExtra: OtfSpec['cff'] = {}): Buffer {
  return buildOtf({
    family: 'Hostile',
    glyphs: [
      { charstring: cs('endchar'), advance: 500, lsb: 0 },
      { charstring, advance: 600, lsb: 0 },
    ],
    codePoints: [0x41],
    cff: { defaultWidthX: 600, nominalWidthX: 0, ...cffExtra },
  });
}

const manyNumbers = (count: number): CharstringItem[] => Array.from({ length: count }, () => 1);

function repeatItems(items: CharstringItem[], times: number): CharstringItem[] {
  return Array.from({ length: times }, () => items).flat();
}

describe('CFF to TrueType: structurally invalid CFF tables are rejected with a typed error', () => {
  const validCff = (): { cff: Buffer; layout: ReturnType<typeof buildCffWithLayout>['layout'] } =>
    buildCffWithLayout({
      fontName: 'Probe',
      charstrings: [cs('endchar'), cs(0, 0, 'rmoveto', 100, 100, 'rlineto', 'endchar')],
      strings: ['aa', 'bb'],
      defaultWidthX: 600,
    });

  const wrap = (cff: Buffer): Buffer =>
    buildOtf({
      family: 'Hostile',
      glyphs: [
        { charstring: cs('endchar'), advance: 500, lsb: 0 },
        { charstring: cs('endchar'), advance: 600, lsb: 0 },
      ],
      codePoints: [0x41],
      cffOverride: cff,
    });

  it('accepts the unmodified table', async () => {
    const tables = readSfntTables(await convertToTtf(wrap(validCff().cff)));
    expect(readGlyf(tables, 1)!.contours[0]).toHaveLength(2);
  });

  const patches: Array<[string, (cff: Buffer, layout: ReturnType<typeof validCff>['layout']) => Buffer, RegExp]> = [
    ['an empty table', () => Buffer.alloc(0), /header/],
    ['a truncated header', (cff) => cff.subarray(0, 3), /header/],
    ['an unsupported major version', (cff) => Buffer.concat([Buffer.from([2]), cff.subarray(1)]), /major version/],
    ['an INDEX with offSize 0', (cff, l) => patchByte(cff, l.nameIndex + 2, 0), /offSize/],
    ['an INDEX with offSize 5', (cff, l) => patchByte(cff, l.nameIndex + 2, 5), /offSize/],
    ['an INDEX whose first offset is not 1', (cff, l) => patchU16(cff, l.stringIndex + 3, 2), /first offset/],
    ['an INDEX with non-monotonic offsets', (cff, l) => patchU16(cff, l.stringIndex + 5, 9), /monotonic/],
    ['an INDEX whose data runs past the table', (cff, l) => patchU16(cff, l.stringIndex + 7, 0x7fff), /past the end/],
    ['a CharStrings offset outside the table', (cff, l) => patchU32(cff, l.charStringsOperand, 0x00ffffff), /CharStrings offset/],
    [
      'a CharStrings INDEX claiming more glyphs than it holds',
      (cff, l) => patchU16(cff, l.charStringsIndex, 0xffff),
      /offset array|past the end/,
    ],
  ];

  it.each(patches)('rejects %s', async (_name, patch, pattern) => {
    const { cff, layout } = validCff();
    await expectRejected(wrap(patch(Buffer.from(cff), layout)), CffFormatError, pattern);
  });

  it('rejects a Private DICT that runs past the table', async () => {
    const { cff, layout } = validCff();
    const topDictEnd = layout.topDictIndex + 6 + cff.readUInt16BE(layout.topDictIndex + 5);
    await expectRejected(wrap(patchU32(Buffer.from(cff), topDictEnd - 5, 0x00ffffff)), CffFormatError, /Private DICT/);
  });

  it('rejects a CID-keyed font whose FDSelect names a missing font DICT', async () => {
    const { glyphs } = {
      glyphs: [
        { charstring: cs('endchar'), advance: 500, lsb: 0 },
        { charstring: cs(0, 0, 'rmoveto', 100, 100, 'rlineto', 'endchar'), advance: 600, lsb: 0 },
      ],
    };
    const font = buildOtf({
      family: 'Hostile',
      glyphs,
      codePoints: [0x41],
      cff: {
        charset: [1],
        strings: ['Adobe', 'Identity'],
        cid: {
          registrySid: 391,
          orderingSid: 392,
          supplement: 0,
          fds: [{ defaultWidthX: 600 }, { defaultWidthX: 600 }],
          fdSelect: { format: 0, fdOfGlyph: [0, 5] },
        },
      },
    });
    await expectRejected(font, CffFormatError, /FDSelect/);
  });

  it('rejects a glyph count that disagrees with maxp', async () => {
    const font = buildOtf({
      family: 'Hostile',
      glyphs: [
        { charstring: cs('endchar'), advance: 500, lsb: 0 },
        { charstring: cs('endchar'), advance: 600, lsb: 0 },
      ],
      codePoints: [0x41],
      cffOverride: buildCff({ fontName: 'Probe', charstrings: [cs('endchar'), cs('endchar'), cs('endchar')] }),
    });
    await expectRejected(font, ConversionFailedError, /glyph/);
  });

  it('rejects CFF2 variable outlines as unsupported', async () => {
    const font = buildOtf({
      family: 'Hostile',
      glyphs: [
        { charstring: cs('endchar'), advance: 500, lsb: 0 },
        { charstring: cs('endchar'), advance: 600, lsb: 0 },
      ],
      codePoints: [0x41],
      omitTables: ['CFF '],
      extraTables: { CFF2: Buffer.from([2, 0, 5, 0, 0]) },
    });
    await expectRejected(font, ConversionFailedError, /CFF2/);
  });

  it('rejects a font that has neither glyf nor CFF outlines instead of inventing glyphs', async () => {
    const font = buildOtf({
      family: 'Hostile',
      glyphs: [
        { charstring: cs('endchar'), advance: 500, lsb: 0 },
        { charstring: cs('endchar'), advance: 600, lsb: 0 },
      ],
      codePoints: [0x41],
      omitTables: ['CFF '],
    });
    await expectRejected(font, ConversionFailedError, /outline/);
    const golden = fs.readFileSync(path.join(__dirname, 'fixtures/golden/font/variable-geometric.otf'));
    await expectRejected(golden, ConversionFailedError, /outline/);
  });

  it('rejects a CFF font without the head, hhea or maxp tables TrueType needs', async () => {
    for (const tag of ['hhea', 'maxp']) {
      const font = buildOtf({
        family: 'Hostile',
        glyphs: [
          { charstring: cs('endchar'), advance: 500, lsb: 0 },
          { charstring: cs(0, 0, 'rmoveto', 100, 100, 'rlineto', 'endchar'), advance: 600, lsb: 0 },
        ],
        codePoints: [0x41],
        omitTables: [tag],
      });
      await expectRejected(font, ConversionFailedError, new RegExp(tag));
    }
  });
});

function patchByte(buffer: Buffer, at: number, value: number): Buffer {
  buffer[at] = value;
  return buffer;
}

function patchU16(buffer: Buffer, at: number, value: number): Buffer {
  buffer.writeUInt16BE(value, at);
  return buffer;
}

function patchU32(buffer: Buffer, at: number, value: number): Buffer {
  buffer.writeUInt32BE(value, at);
  return buffer;
}

describe('CFF to TrueType: hostile charstrings are rejected quickly with a typed error', () => {
  const hostile: Array<[string, () => Buffer, RegExp]> = [
    ['an argument stack deeper than 48', () => singleGlyphFont(cs(...manyNumbers(49), 'endchar')), /stack limit/],
    [
      'a subroutine that calls itself',
      () => singleGlyphFont(cs(-107, 'callsubr', 'endchar'), { localSubrs: [cs(-107, 'callsubr', 'return')] }),
      /deeper than 10/,
    ],
    [
      'exponential subroutine fan-out',
      () => fanOutFont(1),
      /exceeds \d+ steps/,
    ],
    ['a charstring without endchar', () => singleGlyphFont(cs(0, 0, 'rmoveto', 10, 10, 'rlineto')), /without endchar/],
    ['a subroutine without return', () => singleGlyphFont(cs(-107, 'callsubr', 'endchar'), { localSubrs: [cs(1, 'drop')] }), /without return/],
    ['a path operator before the first moveto', () => singleGlyphFont(cs(10, 10, 'rlineto', 'endchar')), /before its first moveto/],
    ['rmoveto with four arguments', () => singleGlyphFont(cs(1, 2, 3, 4, 'rmoveto', 'endchar')), /rmoveto|moveto/],
    ['rlineto with an odd argument count', () => singleGlyphFont(cs(0, 0, 'rmoveto', 1, 2, 3, 'rlineto', 'endchar')), /rlineto/],
    ['rrcurveto with five arguments', () => singleGlyphFont(cs(0, 0, 'rmoveto', 1, 2, 3, 4, 5, 'rrcurveto', 'endchar')), /rrcurveto/],
    ['a reserved operator', () => singleGlyphFont(cs(0, 0, 'rmoveto', Buffer.from([2]), 'endchar')), /reserved operator/],
    ['callsubr into a font without subroutines', () => singleGlyphFont(cs(-107, 'callsubr', 'endchar')), /does not exist/],
    ['callsubr outside the subroutine index', () => singleGlyphFont(cs(50, 'callsubr', 'endchar'), { localSubrs: [cs('return')] }), /calls subroutine/],
    ['return outside a subroutine', () => singleGlyphFont(cs('return')), /outside a subroutine/],
    ['a hint mask cut short by the end of the charstring', () => singleGlyphFont(cs(...manyNumbers(18), 'hstemhm', 'hintmask', hexMask(0xff))), /hint mask/],
    ['division by zero', () => singleGlyphFont(cs(1, 0, 'div', 'endchar')), /divides by zero/],
    ['the nondeterministic random operator', () => singleGlyphFont(cs('random', 'endchar')), /random/],
    ['seac naming a base glyph that is not in the font', () => singleGlyphFont(cs(0, 0, 66, 194, 'endchar'), { charset: [34] }), /seac/],
    ['a stack underflow', () => singleGlyphFont(cs('add', 'endchar')), /empty stack/],
    ['a 16.16 operand cut short', () => singleGlyphFont(cs(Buffer.from([255, 0, 1]))), /16\.16/],
    [
      'a glyph with more path segments than the limit',
      () =>
        singleGlyphFont(cs(0, 0, 'rmoveto', ...repeatItems([-107, 'callsubr'], 1400), 'endchar'), {
          localSubrs: [cs(...repeatItems([1, 0], 24), 'rlineto', 'return')],
        }),
      new RegExp(`more than ${CFF_MAX_SEGMENTS_PER_GLYPH} segments`),
    ],
  ];

  it.each(hostile)('rejects %s', async (_name, build, pattern) => {
    await expectRejected(build(), CffCharStringError, pattern);
  });

  it('rejects a font whose glyphs together exceed the per-font step budget', async () => {
    await expectRejected(fanOutFont(220), CffCharStringError, /budget of \d+ charstring steps/, FONT_BUDGET_HANG_GUARD_MS);
  });

  it('reports typed errors from the parser entry point as CffFormatError instances', () => {
    expect(() => parseCff(Buffer.alloc(2))).toThrow(CffFormatError);
    expect(() => parseCff(Buffer.alloc(64))).toThrow(CffFormatError);
  });
});

/**
 * A font whose glyphs each run about 110,000 interpreter steps (below the per-glyph limit) through
 * nested subroutines. One glyph is fine; `glyphCount` of them exhaust the per-font budget. With
 * glyphCount 1 the glyph calls an extra fan-out level and exceeds the per-glyph limit instead.
 */
function fanOutFont(glyphCount: number): Buffer {
  const repeat = repeatItems;
  const leaf = cs('return'); // subr 0
  const level1 = cs(...repeat([-107, 'callsubr'], 100), 'return'); // subr 1: 100 calls of subr 0
  const level2 = cs(...repeat([-106, 'callsubr'], 100), 'return'); // subr 2: 100 calls of subr 1
  const level3 = cs(...repeat([-105, 'callsubr'], 5), 'return'); // subr 3: 5 calls of subr 2 (~100k steps)
  const level4 = cs(...repeat([-104, 'callsubr'], 100), 'return'); // subr 4: 100 calls of subr 3 (far over the limit)
  const glyphCall = glyphCount === 1 ? -103 : -104;
  const glyphs: OtfGlyph[] = [{ charstring: cs('endchar'), advance: 500, lsb: 0 }];
  for (let g = 0; g < glyphCount; g++) {
    glyphs.push({ charstring: cs(glyphCall, 'callsubr', 'endchar'), advance: 600, lsb: 0 });
  }
  return buildOtf({
    family: 'FanOut',
    glyphs,
    codePoints: [0x41],
    cff: {
      defaultWidthX: 600,
      nominalWidthX: 0,
      charset: Array.from({ length: glyphCount }, (_, i) => i + 1),
      localSubrs: [leaf, level1, level2, level3, level4],
    },
  });
}

// ---------------------------------------------------------------------------
// Charset formats, seac, subroutine bias 32768, real-number Private DICT operands
// ---------------------------------------------------------------------------

const SEAC_BASE = cs(100, 0, 'rmoveto', 400, 500, -400, 'hlineto', 'endchar');
const SEAC_ACCENT = cs(50, 0, 'rmoveto', 100, 0, 'rlineto', 50, 120, 'rlineto', -100, 0, 'rlineto', 'endchar');
// width delta 100, adx 200, ady 500, bchar 65 ('A'), achar 194 (acute), both in StandardEncoding
const SEAC_COMPOSITE = cs(100, 200, 500, 65, 194, 'endchar');
const SEAC_COMPOSED: GlyphFixture = {
  name: 'seac',
  codePoint: 0xc1,
  charstring: SEAC_COMPOSITE,
  advance: 600,
  shape: [
    [['M', 100, 0], ['L', 500, 0], ['L', 500, 500], ['L', 100, 500]],
    [['M', 250, 500], ['L', 350, 500], ['L', 400, 620], ['L', 300, 620]],
  ],
  exactLines: true,
};
const SEAC_SIDS = [sidForAscii('A'), sidForAscii('B'), sidForAscii('C'), 125, 391];

/** Glyphs: .notdef, A, B, C (SIDs 34-36, one range), acute (SID 125) and the composite (custom SID 391). */
function seacGlyphs(): OtfGlyph[] {
  const plain = cs(100, 0, 'rmoveto', 300, 300, -300, 'hlineto', 'endchar');
  return [
    { charstring: cs('endchar'), advance: 500, lsb: 0 },
    { charstring: SEAC_BASE, advance: DEFAULT_WIDTH_X, lsb: 100 },
    { charstring: plain, advance: DEFAULT_WIDTH_X, lsb: 100 },
    { charstring: plain, advance: DEFAULT_WIDTH_X, lsb: 100 },
    { charstring: SEAC_ACCENT, advance: DEFAULT_WIDTH_X, lsb: 50 },
    { charstring: SEAC_COMPOSITE, advance: 600, lsb: 100 },
  ];
}

describe('CFF to TrueType: charset encodings resolve seac components', () => {
  it.each([0, 1, 2] as const)('charset format %i', async (format) => {
    const spec = { defaultWidthX: DEFAULT_WIDTH_X, nominalWidthX: NOMINAL_WIDTH_X, charset: SEAC_SIDS, charsetFormat: format, strings: ['Aacute'] };
    const font = parseCff(buildCff({ fontName: 'Seac', charstrings: seacGlyphs().map((g) => g.charstring), ...spec }));
    expect(Array.from(font.charset!)).toEqual([0, ...SEAC_SIDS]);

    const otf = buildOtf({ family: 'Seac Probe', glyphs: seacGlyphs(), codePoints: [0x41, 0x42, 0x43, 0xb4, 0xc1], cff: spec });
    const tables = readSfntTables(await convertToTtf(otf));
    expectGlyphMatches(readGlyf(tables, 5), SEAC_COMPOSED);
    expect(tables.get('hmtx')!.readUInt16BE(5 * 4)).toBe(600);
  });

  it('predefined ISOAdobe charset maps glyph ids to SIDs', async () => {
    // ISOAdobe: glyph id == SID, so A must be glyph 34 and acute glyph 125.
    const acuteGid = 125;
    const composedGid = 126;
    const glyphs: OtfGlyph[] = Array.from({ length: composedGid + 1 }, () => ({ charstring: cs('endchar'), advance: 500, lsb: 0 }));
    glyphs[sidForAscii('A')] = { charstring: SEAC_BASE, advance: DEFAULT_WIDTH_X, lsb: 100 };
    glyphs[acuteGid] = { charstring: SEAC_ACCENT, advance: DEFAULT_WIDTH_X, lsb: 50 };
    glyphs[composedGid] = { charstring: SEAC_COMPOSITE, advance: 600, lsb: 100 };
    const cffSpec = { defaultWidthX: DEFAULT_WIDTH_X, nominalWidthX: NOMINAL_WIDTH_X, charsetFormat: 'iso-adobe' as const };

    const parsed = parseCff(buildCff({ fontName: 'Iso', charstrings: glyphs.map((g) => g.charstring), ...cffSpec }));
    expect(Array.from(parsed.charset!)).toEqual(Array.from({ length: composedGid + 1 }, (_, g) => g));

    const otf = buildOtf({ family: 'Iso Probe', glyphs, codePoints: [0x41], cff: cffSpec });
    const tables = readSfntTables(await convertToTtf(otf));
    expectGlyphMatches(readGlyf(tables, composedGid), SEAC_COMPOSED);
  });

  it('rejects an explicit charset range that runs past the glyph count', () => {
    const cff = buildCff({
      fontName: 'Seac',
      charstrings: seacGlyphs().map((g) => g.charstring),
      charset: SEAC_SIDS,
      charsetFormat: 1,
      strings: ['Aacute'],
    });
    // Patch the first range's nLeft (u8) so it claims more glyphs than the font has.
    const at = cff.indexOf(Buffer.from([1, 0, sidForAscii('A'), 2]));
    expect(at).toBeGreaterThan(0);
    cff[at + 3] = 200;
    expect(() => parseCff(cff)).toThrow(CffFormatError);
    expect(() => parseCff(cff)).toThrow(/charset range/);
  });
});

describe('CFF to TrueType: large subroutine counts and real-number Private DICT operands', () => {
  it('applies the subroutine bias of 32768 for fonts with 33,900 or more subroutines', async () => {
    const fixture: GlyphFixture = {
      name: 'huge subr bias',
      codePoint: 0x45,
      charstring: cs(50, 50, 'rmoveto', 0, 'callsubr', 'endchar'),
      advance: DEFAULT_WIDTH_X,
      shape: [[['M', 50, 50], ['L', 350, 50], ['L', 350, 250], ['L', 50, 250]]],
      exactLines: true,
    };
    const subrs = Array.from({ length: 33_900 }, (_, i) => (i === 32_768 ? RECT_300x200 : cs('return')));
    const otf = fixtureFont([fixture], {
      cff: { defaultWidthX: DEFAULT_WIDTH_X, nominalWidthX: NOMINAL_WIDTH_X, localSubrs: subrs },
    });
    const tables = readSfntTables(await convertToTtf(otf));
    expectGlyphMatches(readGlyf(tables, 1), fixture);
  });

  it('keeps the medium bias of 1131 just below 33,900 subroutines', async () => {
    const fixture: GlyphFixture = {
      name: 'medium subr bias at the limit',
      codePoint: 0x45,
      charstring: cs(50, 50, 'rmoveto', 0, 'callsubr', 'endchar'),
      advance: DEFAULT_WIDTH_X,
      shape: [[['M', 50, 50], ['L', 350, 50], ['L', 350, 250], ['L', 50, 250]]],
      exactLines: true,
    };
    const subrs = Array.from({ length: 33_899 }, (_, i) => (i === 1131 ? RECT_300x200 : cs('return')));
    const otf = fixtureFont([fixture], {
      cff: { defaultWidthX: DEFAULT_WIDTH_X, nominalWidthX: NOMINAL_WIDTH_X, localSubrs: subrs },
    });
    const tables = readSfntTables(await convertToTtf(otf));
    expectGlyphMatches(readGlyf(tables, 1), fixture);
  });

  const realWidthGlyphs = (): OtfGlyph[] => [
    { charstring: cs('endchar'), advance: 600, lsb: 0 },
    // explicit width delta 200 on rmoveto
    { charstring: cs(200, 0, 0, 'rmoveto', 100, 100, 'rlineto', 'endchar'), advance: 50, lsb: 0 },
    { charstring: cs(0, 0, 'rmoveto', 100, 100, 'rlineto', 'endchar'), advance: 600, lsb: 0 },
  ];

  it('reads defaultWidthX and nominalWidthX written as real numbers with exponents', async () => {
    const spec = { defaultWidthXReal: '6E2', nominalWidthXReal: '-1.5E2' };
    const font = parseCff(buildCff({ fontName: 'Reals', charstrings: realWidthGlyphs().map((g) => g.charstring), ...spec }));
    expect([0, 1, 2].map((g) => font.glyph(g).width)).toEqual([600, 50, 600]);

    // Without hmtx the converter takes the advances from these charstring widths.
    const otf = buildOtf({ family: 'Reals', glyphs: realWidthGlyphs(), codePoints: [0x41, 0x42], omitTables: ['hmtx'], cff: spec });
    const hmtx = readSfntTables(await convertToTtf(otf)).get('hmtx')!;
    expect([0, 1, 2].map((g) => hmtx.readUInt16BE(g * 4))).toEqual([600, 50, 600]);
  });

  it('reads a negative-exponent real number (E-) and fractional widths', () => {
    const font = parseCff(
      buildCff({
        fontName: 'Reals',
        charstrings: realWidthGlyphs().map((g) => g.charstring),
        defaultWidthXReal: '2.5E-1',
        nominalWidthXReal: '12.5',
      })
    );
    expect(font.glyph(0).width).toBe(0.25);
    expect(font.glyph(1).width).toBe(212.5);
  });
});

// ---------------------------------------------------------------------------
// Coordinates, deltas and amplification limits
// ---------------------------------------------------------------------------

describe('CFF to TrueType: coordinate deltas and amplification limits', () => {
  it('writes glyphs with large negative coordinates when every delta fits 16 bits', async () => {
    const wide: GlyphFixture = {
      name: 'wide negative glyph',
      codePoint: 0x41,
      charstring: cs(-30000, -1000, 'rmoveto', 32000, 6000, -32000, 'hlineto', 'endchar'),
      advance: 700,
      shape: [[['M', -30000, -1000], ['L', 2000, -1000], ['L', 2000, 5000], ['L', -30000, 5000]]],
      exactLines: true,
    };
    const tables = readSfntTables(await convertToTtf(fixtureFont([wide])));
    const glyph = readGlyf(tables, 1)!;
    expect(glyph.bbox).toEqual([-30000, -1000, 2000, 5000]);
    expectGlyphMatches(glyph, wide);
    expect(tables.get('hmtx')!.readInt16BE(1 * 4 + 2)).toBe(-30000);
  });

  it('rejects a coordinate step beyond 16 bits with a typed error instead of a RangeError', async () => {
    const font = singleGlyphFont(cs(-30000, 0, 'rmoveto', 30000, 30000, 'add', 'hlineto', 10, 'vlineto', 'endchar'));
    await expectRejected(font, ConversionFailedError, /16-bit coordinate deltas/);
  });

  it('rejects two contours whose start points are further apart than 16 bits', async () => {
    const font = singleGlyphFont(
      cs(-30000, 0, 'rmoveto', 100, 100, -100, 'hlineto', 30000, 30000, 'add', 'hmoveto', 100, 100, -100, 'hlineto', 'endchar')
    );
    await expectRejected(font, ConversionFailedError, /16-bit coordinate deltas/);
  });

  it('does not let a shared subroutine tree expand a small font into a huge outline', async () => {
    // 28,800 segments per glyph (30 x 20 x 48) from a tiny table; 440 such glyphs are about 12.7 million segments.
    const leaf = cs(...repeatItems([1], 48), 'hlineto', 'return');
    const middle = cs(...repeatItems([-107, 'callsubr'], 20), 'return');
    const glyphs: OtfGlyph[] = [{ charstring: cs('endchar'), advance: 500, lsb: 0 }];
    for (let g = 0; g < 440; g++) {
      glyphs.push({ charstring: cs(0, 0, 'rmoveto', ...repeatItems([-106, 'callsubr'], 30), 'endchar'), advance: 600, lsb: 0 });
    }
    const font = buildOtf({
      family: 'SharedTree',
      glyphs,
      codePoints: [0x41],
      cff: { defaultWidthX: 600, nominalWidthX: 0, charset: Array.from({ length: 440 }, (_, i) => i + 1), localSubrs: [leaf, middle] },
    });
    expect(font.length).toBeLessThan(40_000);
    await expectRejected(font, CffCharStringError, /budget of \d+ path segments/, FONT_BUDGET_HANG_GUARD_MS);
  });

  it('caps the total output points of a small font whose curves each need many quadratics', async () => {
    // One subroutine of eight wide cubic loops (each about 21 quadratic pieces), called 100 times per glyph.
    const loop = [15000, 15000, -30000, 0, 15000, -15000];
    const leaf = cs(...repeatItems(loop, 8), 'rrcurveto', 'return');
    const glyphs: OtfGlyph[] = [{ charstring: cs('endchar'), advance: 500, lsb: 0 }];
    for (let g = 0; g < 100; g++) {
      glyphs.push({ charstring: cs(0, 0, 'rmoveto', ...repeatItems([-107, 'callsubr'], 100), 'endchar'), advance: 600, lsb: 0 });
    }
    const font = buildOtf({
      family: 'CurveFlood',
      glyphs,
      codePoints: [0x41],
      cff: { defaultWidthX: 600, nominalWidthX: 0, charset: Array.from({ length: 100 }, (_, i) => i + 1), localSubrs: [leaf] },
    });
    await expectRejected(font, ConversionFailedError, /points in total/, FONT_BUDGET_HANG_GUARD_MS);
  });

  it('keeps realistic fonts far below the budgets', () => {
    const real = parseCff(buildCff({ fontName: 'Probe', charstrings: toOtfGlyphs(BASIC_FIXTURES).map((g) => g.charstring), defaultWidthX: DEFAULT_WIDTH_X, nominalWidthX: NOMINAL_WIDTH_X }));
    for (let g = 0; g < real.numGlyphs; g++) real.glyph(g);
    expect(real.stepsExecuted).toBeGreaterThan(100);
    expect(real.stepsExecuted).toBeLessThan(CFF_BASE_STEPS_PER_FONT / 100);
  });
});

// ---------------------------------------------------------------------------
// SVG font header and advances come from the font itself
// ---------------------------------------------------------------------------

describe('SVG font output uses the font metrics', () => {
  it('writes units-per-em, ascent, descent and advances of a 2048 units-per-em CFF font', async () => {
    const glyph: GlyphFixture = {
      name: 'em 2048',
      codePoint: 0x41,
      charstring: cs(200, 0, 'rmoveto', 800, 1400, -800, 'hlineto', 'endchar'),
      advance: 1600,
      shape: [[['M', 200, 0], ['L', 1000, 0], ['L', 1000, 1400], ['L', 200, 1400]]],
    };
    const otf = fixtureFont([glyph], {
      unitsPerEm: 2048,
      cff: { defaultWidthX: 1600, nominalWidthX: 0, fontMatrix: ['0.00048828125', '0', '0', '0.00048828125', '0', '0'] },
    });
    const svg = (await convertFile(otf, 'otf', 'svg', {}, 'em.otf')).buffer.toString('utf8');
    const fontElement = /<font id="([^"]*)" horiz-adv-x="(\d+)">/.exec(svg);
    expect(fontElement?.slice(1)).toEqual(['Cff Probe', '2048']);
    const fontFace = /units-per-em="(\d+)" ascent="(-?\d+)" descent="(-?\d+)"/.exec(svg);
    expect(fontFace?.slice(1).map(Number)).toEqual([2048, 1638, -410]);
    // The .notdef glyph of this font draws nothing, so missing-glyph carries its advance from hmtx
    // and no invented outline.
    const notdefAdvance = readSfntTables(otf).get('hmtx')!.readUInt16BE(0);
    const missing = /<missing-glyph ([^>]*)\/>/.exec(svg);
    expect(missing?.[1].trim()).toBe(`horiz-adv-x="${notdefAdvance}"`);
    const glyphA = /<glyph unicode="A" horiz-adv-x="(\d+)" d="([^"]*)"/.exec(svg);
    expect(glyphA?.slice(1)).toEqual(['1600', 'M200 0 L1000 0 L1000 1400 L200 1400 Z']);
  });

  it('gives TrueType glyphs past the long metrics the last advance instead of a fixed 1000', () => {
    const font = decodeSfnt(buildTrueTypeFont({ family: 'Short Metrics' }), 'Short Metrics');
    const glyphCount = font.tables['maxp'].data.readUInt16BE(4);
    // One long metric (advance 640), then left side bearings only.
    const hmtx = Buffer.alloc(4 + (glyphCount - 1) * 2);
    hmtx.writeUInt16BE(640, 0);
    const hhea = Buffer.from(font.tables['hhea'].data);
    hhea.writeUInt16BE(1, 34);
    font.tables['hmtx'] = { ...font.tables['hmtx'], data: hmtx, length: hmtx.length };
    font.tables['hhea'] = { ...font.tables['hhea'], data: hhea };

    const svg = encodeSvgFont(font, 'Short Metrics').toString('utf8');
    const advances = [...svg.matchAll(/<glyph unicode="[ABC]" horiz-adv-x="(\d+)"/g)].map((m) => Number(m[1]));
    expect(advances).toEqual([640, 640, 640]);
  });
});


// ---------------------------------------------------------------------------
// Absolute ceilings, SVG route limits, non-finite numbers and Private DICT overlap
// ---------------------------------------------------------------------------

const MIB = 1024 * 1024;
const CEILING_HANG_GUARD_MS = 30_000;
const PADDED_TABLE_BYTES = 24 * MIB;

/**
 * A font whose glyphs each spend about 157,000 interpreter steps (under the per-glyph limit) in a
 * four-level global subroutine fan-out that draws nothing. The table is zero padded to a size at
 * which a per-byte budget alone would allow far more steps than the absolute ceiling.
 */
function paddedFanOutFont(glyphCount: number, paddedBytes: number): Buffer {
  const fan = (child: number): Buffer => cs(...repeatItems([child, 'callgsubr'], 16), 'return');
  const gsubrs = [cs('return'), fan(-107), fan(-106), fan(-105)];
  const charstrings = [
    cs('endchar'),
    ...Array.from({ length: glyphCount - 1 }, () => cs(...repeatItems([-104, 'callgsubr'], 12), 'endchar')),
  ];
  const cff = padCff(buildCff({ fontName: 'Padded', charstrings, globalSubrs: gsubrs }), paddedBytes);
  return buildOtf({
    family: 'Padded',
    glyphs: charstrings.map(() => ({ charstring: Buffer.alloc(0), advance: 500, lsb: 0 })),
    codePoints: Array.from({ length: glyphCount - 1 }, (_, i) => 0x4e00 + i),
    cffOverride: cff,
  });
}

describe('CFF limits that hold whatever the table size', () => {
  it('caps the scaled budgets at the absolute ceilings and scales small tables', () => {
    expect(cffFontBudgets(1000)).toEqual({
      steps: CFF_BASE_STEPS_PER_FONT + 4 * 1000,
      segments: CFF_BASE_SEGMENTS_PER_FONT + 2 * 1000,
    });
    expect(cffFontBudgets(8 * MIB)).toEqual({
      steps: CFF_ABSOLUTE_MAX_STEPS_PER_FONT,
      segments: CFF_ABSOLUTE_MAX_SEGMENTS_PER_FONT,
    });
    expect(cffFontBudgets(64 * MIB)).toEqual(cffFontBudgets(8 * MIB));
  });

  it('keeps the ceilings above the largest real fonts measured (5.5M steps, 4.1M segments)', () => {
    expect(CFF_ABSOLUTE_MAX_STEPS_PER_FONT).toBeGreaterThanOrEqual(4 * 5_500_000);
    expect(CFF_ABSOLUTE_MAX_SEGMENTS_PER_FONT).toBeGreaterThanOrEqual(1.9 * 4_100_000);
  });

  it.each([
    ['TrueType', 'ttf'],
    ['SVG', 'svg'],
  ] as const)('stops a padded %s conversion at the absolute step ceiling', async (_route, target) => {
    const font = paddedFanOutFont(300, PADDED_TABLE_BYTES);
    expect(font.length).toBeGreaterThan(PADDED_TABLE_BYTES);
    const started = performance.now();
    let caught: unknown;
    try {
      await convertFile(font, 'otf', target, {}, 'padded.otf');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CffCharStringError);
    expect((caught as Error).message).toContain(`budget of ${CFF_ABSOLUTE_MAX_STEPS_PER_FONT} charstring steps`);
    expect(performance.now() - started).toBeLessThan(CEILING_HANG_GUARD_MS);
  });

  it('rejects SVG path data beyond the character budget with a typed error', () => {
    const font = parseFontToSfnt(fixtureFont([BASIC_FIXTURES[0]]), 'otf', 'probe');
    // The rectangle is "M100 0 L500 0 L500 700 L100 700 Z", 33 characters.
    expect(extractCffGlyphs(font, 33)).toHaveLength(1);
    expect(() => extractCffGlyphs(font, 32)).toThrow(ConversionFailedError);
    expect(() => extractCffGlyphs(font, 32)).toThrow(/32 characters of path data/);
  });

  it('turns a string-length RangeError while writing the SVG font into a typed error', () => {
    const font = parseFontToSfnt(fixtureFont([BASIC_FIXTURES[0]]), 'otf', 'probe');
    const join = vi.spyOn(Array.prototype, 'join').mockImplementation(() => {
      throw new RangeError('Invalid string length');
    });
    let caught: unknown;
    try {
      encodeSvgFont(font, 'probe');
    } catch (error) {
      caught = error;
    } finally {
      join.mockRestore();
    }
    expect(caught).toBeInstanceOf(ConversionFailedError);
    expect(caught).not.toBeInstanceOf(RangeError);
    expect((caught as Error).message).toMatch(/too large for one document/);
  });
});

describe('CFF to SVG and TrueType: non-finite and absurd numbers', () => {
  const squared: CharstringItem[] = [32767];
  for (let i = 0; i < 8; i++) squared.push('dup', 'mul'); // 32767^256 overflows to Infinity

  function singleFont(charstring: Buffer, omitTables: string[] = []): Buffer {
    const cff = buildCff({ fontName: 'N', charstrings: [cs('endchar'), charstring] });
    return buildOtf({
      family: 'N',
      glyphs: [
        { charstring: cs('endchar'), advance: 500, lsb: 0 },
        { charstring, advance: 500, lsb: 0 },
      ],
      codePoints: [0x41],
      cffOverride: cff,
      omitTables,
    });
  }

  it.each([
    ['Infinity', cs(...squared, 0, 'rmoveto', 10, 10, 'rlineto', 10, 'hlineto', 'endchar')],
    ['NaN', cs(...squared, 'dup', 'sub', 0, 'rmoveto', 10, 10, 'rlineto', 10, 'hlineto', 'endchar')],
    ['finite but beyond a billion', cs(32767, 'dup', 'mul', 'dup', 'mul', 0, 'rmoveto', 10, 10, 'rlineto', 10, 'hlineto', 'endchar')],
  ])('refuses to write %s into an SVG path', async (_name, charstring) => {
    const font = singleFont(charstring);
    const failure = await convertFile(font, 'otf', 'svg', {}, 'n.otf').then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toMatch(/not a usable finite number/);
  });

  it.each(['svg', 'ttf'] as const)('rejects an infinite charstring width for %s output when hmtx is missing', async (target) => {
    // rmoveto with three operands: the first is the width delta, here Infinity.
    const font = singleFont(cs(...squared, 0, 0, 'rmoveto', 10, 10, 'rlineto', 10, 'hlineto', 'endchar'), ['hmtx']);
    await expect(convertFile(font, 'otf', target, {}, 'n.otf')).rejects.toThrow(/advance width Infinity/);
  });
});

describe('CFF parsing: Private DICT work is bounded by the table size', () => {
  it('rejects font DICTs whose shifted Private ranges overlap one large range', async () => {
    const otf = buildOtf({
      family: 'Overlap',
      glyphs: [
        { charstring: Buffer.alloc(0), advance: 500, lsb: 0 },
        { charstring: Buffer.alloc(0), advance: 500, lsb: 0 },
      ],
      codePoints: [0x41],
      cffOverride: buildOverlappingPrivateCff(MIB, 256),
    });
    await expectRejected(otf, CffFormatError, /Private DICT data overlaps/);
  });
});
