import { describe, expect, it } from 'vitest';
import { convertFont, convertFontToOpenTypeCff, FontOutlinesMissingError } from '../src/lib/conversions/font';
import { ConversionFailedError } from '../src/lib/types';
import {
  cffGlyphName,
  decodeCff,
  fcScan,
  flattenCharstringContour,
  flattenCommands,
  HAS_FC_SCAN,
  HAS_FREETYPE,
  hausdorff,
  inkCount,
  inkOverlap,
  readCmap,
  readGlyphCount,
  readHmtx,
  readSfntTables,
  readUnitsPerEm,
  renderGlyph,
  requireStrictFcScan,
  requireStrictFreeType,
  requireTable,
  signedArea,
  withFontFile,
  type Cmd,
  type DecodedCff,
  type Pt,
} from './helpers/font-oracles';
import { buildGlyfFont, type GlyfFontSpec, type GlyfGlyphSpec } from './helpers/glyf-font-builder';
import { assembleSfnt } from './helpers/mac-font-containers';
import { expectSizeIndependentOnInputs, SCALING_TEST_TIMEOUT_MS, settle } from './helpers/timing';

/**
 * TrueType (glyf) to OpenType CFF conversion.
 *
 * Inputs come from tests/helpers/glyf-font-builder.ts, an independent glyf writer. Expected
 * geometry is written down by hand as path commands. Outputs are decoded by the CFF / Type 2
 * charstring decoder in tests/helpers/font-oracles.ts (authored from Adobe TN 5176 / 5177), and
 * fc-scan plus a FreeType render (ImageMagick) are additional external oracles when installed.
 */

requireStrictFcScan('TrueType to CFF');
requireStrictFreeType('TrueType to CFF');

const SFNT_OTTO = 0x4f54544f;
const MAXP_VERSION_05 = 0x00005000;
/** Quadratic to cubic elevation is exact; only the 16.16 fixed point quantization remains. */
const ELEVATION_TOLERANCE = 1e-3;
const GEOMETRY_TOLERANCE = 0.05;
const AREA_RELATIVE_TOLERANCE = 1e-3;
const FIRST_CUSTOM_SID = 391;
const OVERLAP_MINIMUM = 0.97;
const MIN_RENDERED_INK = 100;

// ---------------------------------------------------------------------------
// Hand-written glyph fixtures (font units, y up, TrueType convention: outer contours clockwise)
// ---------------------------------------------------------------------------

interface Fixture {
  name: string;
  glyph: GlyfGlyphSpec;
  /** Expected outline drawn in the same direction as the source glyf contours. */
  expected: Cmd[][];
}

const ARCH: Fixture = {
  name: 'arch with one quadratic',
  glyph: {
    codePoint: 0x41,
    advance: 700,
    contours: [
      [
        { x: 0, y: 0 },
        { x: 301, y: 601, on: false },
        { x: 600, y: 0 },
      ],
    ],
  },
  expected: [[['M', 0, 0], ['Q', 301, 601, 600, 0]]],
};

const ROUNDED_SQUARE_OFF_START: Fixture = {
  name: 'rounded square whose contour starts on an off-curve point',
  glyph: {
    codePoint: 0x42,
    advance: 650,
    contours: [
      [
        { x: 0, y: 0, on: false },
        { x: 0, y: 200 },
        { x: 0, y: 400 },
        { x: 0, y: 600, on: false },
        { x: 200, y: 600 },
        { x: 400, y: 600 },
        { x: 600, y: 600, on: false },
        { x: 600, y: 400 },
        { x: 600, y: 200 },
        { x: 600, y: 0, on: false },
        { x: 400, y: 0 },
        { x: 200, y: 0 },
      ],
    ],
  },
  expected: [
    [
      ['M', 0, 200],
      ['L', 0, 400],
      ['Q', 0, 600, 200, 600],
      ['L', 400, 600],
      ['Q', 600, 600, 600, 400],
      ['L', 600, 200],
      ['Q', 600, 0, 400, 0],
      ['L', 200, 0],
      ['Q', 0, 0, 0, 200],
    ],
  ],
};

const ALL_OFF_CURVE: Fixture = {
  name: 'contour made only of off-curve points (implied on-curve midpoints)',
  glyph: {
    codePoint: 0x43,
    advance: 1100,
    contours: [
      [
        { x: 0, y: 0, on: false },
        { x: 0, y: 1000, on: false },
        { x: 1000, y: 1000, on: false },
        { x: 1000, y: 0, on: false },
      ],
    ],
  },
  expected: [
    [
      ['M', 0, 500],
      ['Q', 0, 1000, 500, 1000],
      ['Q', 1000, 1000, 1000, 500],
      ['Q', 1000, 0, 500, 0],
      ['Q', 0, 0, 0, 500],
    ],
  ],
};

const ENDS_OFF_CURVE: Fixture = {
  name: 'contour that ends on an off-curve point and closes with a curve',
  glyph: {
    codePoint: 0x44,
    advance: 700,
    contours: [
      [
        { x: 0, y: 0 },
        { x: 0, y: 600 },
        { x: 300, y: 600 },
        { x: 600, y: 600, on: false },
        { x: 600, y: 0, on: false },
      ],
    ],
  },
  expected: [
    [
      ['M', 0, 0],
      ['L', 0, 600],
      ['L', 300, 600],
      ['Q', 600, 600, 600, 300],
      ['Q', 600, 0, 0, 0],
    ],
  ],
};

const FRAME: Fixture = {
  name: 'frame with a counter-clockwise hole',
  glyph: {
    codePoint: 0x45,
    advance: 800,
    contours: [
      [
        { x: 0, y: 0 },
        { x: 0, y: 700 },
        { x: 700, y: 700 },
        { x: 700, y: 0 },
      ],
      [
        { x: 200, y: 200 },
        { x: 500, y: 200 },
        { x: 500, y: 500 },
        { x: 200, y: 500 },
      ],
    ],
  },
  expected: [
    [['M', 0, 0], ['L', 0, 700], ['L', 700, 700], ['L', 700, 0]],
    [['M', 200, 200], ['L', 500, 200], ['L', 500, 500], ['L', 200, 500]],
  ],
};

const SPACE: GlyfGlyphSpec = { codePoint: 0x20, advance: 250 };

/** Component 1 = ARCH scaled by 0.5 and moved by (100, 50): fractional coordinates. */
const SCALED_COMPOSITE: Fixture = {
  name: 'composite with a scaled component',
  glyph: { codePoint: 0x47, advance: 500, components: [{ glyphIndex: 1, dx: 100, dy: 50, scale: 0.5 }] },
  expected: [[['M', 100, 50], ['Q', 250.5, 350.5, 400, 50]]],
};

/** Component 5 = FRAME rotated a quarter turn counter-clockwise, (x, y) -> (-y, x), then moved by (800, 0). */
const ROTATED_COMPOSITE: Fixture = {
  name: 'composite with a two by two rotation',
  glyph: {
    codePoint: 0x48,
    advance: 900,
    components: [{ glyphIndex: 5, dx: 800, dy: 0, matrix: [0, 1, -1, 0] }],
  },
  expected: [
    [['M', 800, 0], ['L', 100, 0], ['L', 100, 700], ['L', 800, 700]],
    [['M', 600, 200], ['L', 600, 500], ['L', 300, 500], ['L', 300, 200]],
  ],
};

const OUTLINE_FIXTURES: Fixture[] = [
  ARCH,
  ROUNDED_SQUARE_OFF_START,
  ALL_OFF_CURVE,
  ENDS_OFF_CURVE,
  FRAME,
  { name: 'space', glyph: SPACE, expected: [] },
  SCALED_COMPOSITE,
  ROTATED_COMPOSITE,
];

function fixtureSpec(overrides: Partial<GlyfFontSpec> = {}): GlyfFontSpec {
  return {
    family: 'Glyf Probe',
    glyphs: OUTLINE_FIXTURES.map((f) => f.glyph),
    ...overrides,
  };
}

function convertToOtf(ttf: Buffer): Promise<Buffer> {
  return convertFont(ttf, 'ttf', 'otf', {}, 'probe.ttf').then((result) => result.buffer);
}

function decodedOtf(otf: Buffer): DecodedCff {
  return decodeCff(requireTable(readSfntTables(otf), 'CFF '));
}

function flattenGlyph(cff: DecodedCff, glyphId: number): Pt[][] {
  return cff.glyphs[glyphId].contours.map((contour) => flattenCharstringContour(contour));
}

/** Asserts that the decoded CFF glyph is the hand-written outline with every contour reversed. */
function expectCffGlyphMatches(cff: DecodedCff, glyphId: number, fixture: Fixture): void {
  const actual = flattenGlyph(cff, glyphId);
  const expected = fixture.expected.map((contour) => flattenCommands(contour));
  expect(actual.length, `${fixture.name}: contour count`).toBe(expected.length);
  const unmatched = [...actual];
  for (const wanted of expected) {
    let best = -1;
    let bestDistance = Infinity;
    unmatched.forEach((candidate, i) => {
      const distance = hausdorff(candidate, wanted);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    });
    expect(bestDistance, `${fixture.name}: contour shape`).toBeLessThan(GEOMETRY_TOLERANCE);
    const [matched] = unmatched.splice(best, 1);
    // TrueType outer contours run clockwise and CFF outer contours counter-clockwise, so the
    // converted contour winds the other way round.
    const wantedArea = signedArea(wanted);
    expect(Math.abs(signedArea(matched) + wantedArea), `${fixture.name}: winding`).toBeLessThan(
      Math.abs(wantedArea) * AREA_RELATIVE_TOLERANCE + 1
    );
  }
}

// ---------------------------------------------------------------------------
// Real outlines
// ---------------------------------------------------------------------------

describe('TrueType to CFF: charstrings are built from the real glyf outlines', () => {
  it.each(OUTLINE_FIXTURES.map((f, i) => [f.name, i + 1] as const))('draws the hand-written outline: %s', async (_name, glyphId) => {
    const otf = await convertToOtf(buildGlyfFont(fixtureSpec()));
    const cff = decodedOtf(otf);
    expectCffGlyphMatches(cff, glyphId, OUTLINE_FIXTURES[glyphId - 1]);
  });

  it('turns a quadratic into the exact cubic with control points p0 + 2/3 (c - p0) and p2 + 2/3 (c - p2)', async () => {
    const cff = decodedOtf(await convertToOtf(buildGlyfFont(fixtureSpec())));
    const contour = cff.glyphs[1].contours[0];
    const curves = contour.segments.filter((s) => s.kind === 'curve');
    expect(curves).toHaveLength(1);
    // The converter reverses the contour, so the cubic runs from (600, 0) back to (0, 0).
    const [curve] = curves;
    expect(curve.c1!.x).toBeCloseTo(600 + (2 / 3) * (301 - 600), 3);
    expect(curve.c1!.y).toBeCloseTo((2 / 3) * 601, 3);
    expect(curve.c2!.x).toBeCloseTo((2 / 3) * 301, 3);
    expect(curve.c2!.y).toBeCloseTo((2 / 3) * 601, 3);
    expect(Math.abs(curve.c1!.x - 400.6666667)).toBeLessThan(ELEVATION_TOLERANCE);
    expect(Math.abs(curve.c2!.x - 200.6666667)).toBeLessThan(ELEVATION_TOLERANCE);
    expect(curve.to).toEqual({ x: 0, y: 0 });
    expect(contour.start).toEqual({ x: 0, y: 0 });
    // The quadratic is the only curve: the rest of the closed shape is one straight edge.
    expect(contour.segments.filter((s) => s.kind === 'line')).toHaveLength(1);
  });

  it('keeps every on-curve end point exactly where the glyf table has it (no accumulated rounding)', async () => {
    const cff = decodedOtf(await convertToOtf(buildGlyfFont(fixtureSpec())));
    const contour = cff.glyphs[2].contours[0];
    const ends = [contour.start, ...contour.segments.map((s) => s.to)];
    const wantedCorners = [
      { x: 0, y: 200 },
      { x: 0, y: 400 },
      { x: 200, y: 600 },
      { x: 400, y: 600 },
      { x: 600, y: 400 },
      { x: 600, y: 200 },
      { x: 400, y: 0 },
      { x: 200, y: 0 },
    ];
    for (const corner of wantedCorners) {
      expect(ends, `corner ${corner.x},${corner.y}`).toContainEqual(corner);
    }
  });

  it('writes the advance width of every glyph into its charstring and keeps glyph order', async () => {
    const ttf = buildGlyfFont(fixtureSpec());
    const otf = await convertToOtf(ttf);
    const tables = readSfntTables(otf);
    const cff = decodeCff(requireTable(tables, 'CFF '));
    const expectedAdvances = [500, ...OUTLINE_FIXTURES.map((f) => f.glyph.advance)];
    expect(cff.numGlyphs).toBe(expectedAdvances.length);
    expect(cff.glyphs.map((g) => g.width)).toEqual(expectedAdvances);
    expect(readGlyphCount(tables)).toBe(expectedAdvances.length);
    expect(requireTable(tables, 'maxp').readUInt32BE(0)).toBe(MAXP_VERSION_05);
    expectedAdvances.forEach((advance, g) => expect(readHmtx(tables, g).advance).toBe(advance));
    expect(cff.glyphs[6].contours).toHaveLength(0); // the space glyph stays empty
  });

  it('wraps the CFF table as an OTTO font without glyf, loca or TrueType hinting tables', async () => {
    const otf = await convertToOtf(buildGlyfFont(fixtureSpec()));
    expect(otf.readUInt32BE(0)).toBe(SFNT_OTTO);
    const tables = readSfntTables(otf);
    for (const tag of ['CFF ', 'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'post']) {
      expect(tables.has(tag), tag).toBe(true);
    }
    for (const tag of ['glyf', 'loca', 'cvt ', 'fpgm', 'prep']) {
      expect(tables.has(tag), tag).toBe(false);
    }
    expect(requireTable(tables, 'post').readUInt32BE(0)).toBe(0x00030000);
    const cmap = readCmap(tables);
    expect(cmap.get(0x41)).toBe(1);
    expect(cmap.get(0x48)).toBe(8);
  });

  it('keeps the units per em of the source instead of assuming 1000', async () => {
    const spec = fixtureSpec({
      unitsPerEm: 2048,
      glyphs: [
        {
          codePoint: 0x41,
          advance: 1400,
          contours: [
            [
              { x: 100, y: 0 },
              { x: 100, y: 1500 },
              { x: 1200, y: 1500 },
              { x: 1200, y: 0 },
            ],
          ],
        },
      ],
    });
    const otf = await convertToOtf(buildGlyfFont(spec));
    const tables = readSfntTables(otf);
    expect(readUnitsPerEm(tables)).toBe(2048);
    const cff = decodeCff(requireTable(tables, 'CFF '));
    const xs = [cff.glyphs[1].contours[0].start, ...cff.glyphs[1].contours[0].segments.map((s) => s.to)].map((p) => p.x);
    expect(Math.min(...xs)).toBe(100);
    expect(Math.max(...xs)).toBe(1200);
  });

  it('reads short loca offsets and compact (short vector, repeated flag) coordinates', async () => {
    const compactOtf = await convertToOtf(buildGlyfFont(fixtureSpec({ compact: true, shortLoca: true })));
    const plainOtf = await convertToOtf(buildGlyfFont(fixtureSpec()));
    const compact = decodedOtf(compactOtf);
    const plain = decodedOtf(plainOtf);
    expect(compact.glyphs.map((g) => g.contours)).toEqual(plain.glyphs.map((g) => g.contours));
    expectCffGlyphMatches(compact, 5, FRAME);
    expectCffGlyphMatches(compact, 2, ROUNDED_SQUARE_OFF_START);
  });

  it('declares a Private DICT that fits inside the table and a FontBBox that bounds the glyphs', async () => {
    const ttf = buildGlyfFont(fixtureSpec());
    const otf = await convertToOtf(ttf);
    const tables = readSfntTables(otf);
    const cffTable = requireTable(tables, 'CFF ');
    const cff = decodeCff(cffTable);
    expect(cff.privateExtent.offset + cff.privateExtent.size).toBeLessThanOrEqual(cffTable.length);
    const head = requireTable(tables, 'head');
    expect(cff.fontBBox).toEqual([head.readInt16BE(36), head.readInt16BE(38), head.readInt16BE(40), head.readInt16BE(42)]);
    const [xMin, yMin, xMax, yMax] = cff.fontBBox!;
    for (let g = 0; g < cff.numGlyphs; g++) {
      for (const poly of flattenGlyph(cff, g)) {
        for (const pt of poly) {
          expect(pt.x).toBeGreaterThanOrEqual(xMin);
          expect(pt.x).toBeLessThanOrEqual(xMax);
          expect(pt.y).toBeGreaterThanOrEqual(yMin);
          expect(pt.y).toBeLessThanOrEqual(yMax);
        }
      }
    }
  });

  it('names glyphs with unique custom strings instead of the standard strings that the glyph index would select', async () => {
    const cff = decodedOtf(await convertToOtf(buildGlyfFont(fixtureSpec())));
    expect(cff.charsetSids[0]).toBe(0);
    const names = cff.charsetSids.slice(1).map((sid) => sid);
    names.forEach((sid) => expect(sid).toBeGreaterThanOrEqual(FIRST_CUSTOM_SID));
    const resolved = Array.from({ length: cff.numGlyphs }, (_, g) => cffGlyphName(cff, g));
    expect(new Set(resolved).size).toBe(cff.numGlyphs);
    expect(resolved[1]).toBe('glyph1');
  });

  it('is what convertFontToOpenTypeCff returns for a parsed font and for a raw buffer', () => {
    const ttf = buildGlyfFont(fixtureSpec());
    const fromBuffer = convertFontToOpenTypeCff(ttf) as Buffer;
    expect(fromBuffer.readUInt32BE(0)).toBe(SFNT_OTTO);
    const cff = decodedOtf(fromBuffer);
    expectCffGlyphMatches(cff, 1, ARCH);
  });
});

// ---------------------------------------------------------------------------
// No placeholder glyphs
// ---------------------------------------------------------------------------

function withoutTables(font: Buffer, drop: string[]): Buffer {
  const tables: Record<string, Buffer> = {};
  for (const [tag, data] of readSfntTables(font)) {
    if (!drop.includes(tag)) tables[tag] = Buffer.from(data);
  }
  return assembleSfnt(font.readUInt32BE(0), tables);
}

function withTable(font: Buffer, tag: string, data: Buffer): Buffer {
  const tables: Record<string, Buffer> = {};
  for (const [name, table] of readSfntTables(font)) tables[name] = Buffer.from(table);
  tables[tag] = data;
  return assembleSfnt(font.readUInt32BE(0), tables);
}

describe('TrueType to CFF: a font without outlines is rejected instead of getting a placeholder glyph', () => {
  const baseline = buildGlyfFont(fixtureSpec());

  it('throws FontOutlinesMissingError when the font has neither glyf nor loca', async () => {
    const noOutlines = withoutTables(baseline, ['glyf', 'loca']);
    const failure = await convertFont(noOutlines, 'ttf', 'otf', {}, 'shell.ttf').then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(FontOutlinesMissingError);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toMatch(/outline/i);
  });

  it('throws FontOutlinesMissingError when glyf exists without loca (and the other way round)', () => {
    expect(() => convertFontToOpenTypeCff(withoutTables(baseline, ['loca']))).toThrow(FontOutlinesMissingError);
    expect(() => convertFontToOpenTypeCff(withoutTables(baseline, ['glyf']))).toThrow(FontOutlinesMissingError);
  });

  it('throws FontOutlinesMissingError when every glyph is empty', () => {
    const blank = buildGlyfFont({ family: 'Blank', glyphs: [SPACE, { codePoint: 0x2003, advance: 1000 }] });
    expect(() => convertFontToOpenTypeCff(blank)).toThrow(FontOutlinesMissingError);
  });

  it('never emits the old fixed triangle glyph for any input', () => {
    const noOutlines = withoutTables(baseline, ['glyf', 'loca']);
    let output: Buffer | null = null;
    try {
      output = convertFontToOpenTypeCff(noOutlines) as Buffer;
    } catch (error) {
      expect(error).toBeInstanceOf(FontOutlinesMissingError);
    }
    expect(output).toBeNull();
    // The legacy placeholder was a triangle with these corner coordinates and a 680 unit advance.
    const real = decodedOtf(convertFontToOpenTypeCff(baseline) as Buffer);
    for (const glyph of real.glyphs) {
      const points = glyph.contours.flatMap((c) => [c.start, ...c.segments.map((s) => s.to)]);
      const hasLegacyCorner = points.some((p) => p.x === 310 && p.y === 700) && points.some((p) => p.x === 650 && p.y === 0);
      expect(hasLegacyCorner).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Fail closed on malformed glyf data
// ---------------------------------------------------------------------------

describe('TrueType to CFF: malformed glyf data is rejected with a typed error', () => {
  const baseline = buildGlyfFont(fixtureSpec());

  function expectConversionFailure(font: Buffer, pattern: RegExp): void {
    let caught: unknown;
    try {
      convertFontToOpenTypeCff(font);
    } catch (error) {
      caught = error;
    }
    expect(caught, 'conversion must throw').toBeInstanceOf(ConversionFailedError);
    expect(caught).not.toBeInstanceOf(FontOutlinesMissingError);
    expect((caught as Error).message).toMatch(pattern);
  }

  it('rejects a glyf table that is shorter than loca says', () => {
    const tables = readSfntTables(baseline);
    const glyf = requireTable(tables, 'glyf');
    expectConversionFailure(withTable(baseline, 'glyf', glyf.subarray(0, glyf.length - 12)), /loca|glyf/i);
  });

  it('rejects loca offsets that run backwards', () => {
    const loca = Buffer.from(requireTable(readSfntTables(baseline), 'loca'));
    loca.writeUInt32BE(loca.readUInt32BE(8) + 4, 4); // glyph 1 now ends after glyph 2 begins
    expectConversionFailure(withTable(baseline, 'loca', loca), /loca/i);
  });

  it('rejects a loca table that is too short for the glyph count in maxp', () => {
    const loca = requireTable(readSfntTables(baseline), 'loca');
    expectConversionFailure(withTable(baseline, 'loca', loca.subarray(0, loca.length - 8)), /loca/i);
  });

  it('rejects a simple glyph whose point data is truncated', () => {
    const tables = readSfntTables(baseline);
    const glyf = Buffer.from(requireTable(tables, 'glyf'));
    const loca = requireTable(tables, 'loca');
    const start = loca.readUInt32BE(4); // glyph 1
    const end = loca.readUInt32BE(8);
    // Claim many more points than the record holds.
    glyf.writeUInt16BE(0x3fff, start + 10);
    expect(end).toBeGreaterThan(start);
    expectConversionFailure(withTable(baseline, 'glyf', glyf), /glyph 1/i);
  });

  it('rejects a composite glyph that references itself', () => {
    const font = buildGlyfFont({
      family: 'Loop',
      glyphs: [{ codePoint: 0x41, advance: 500, components: [{ glyphIndex: 1, dx: 0, dy: 0 }] }],
    });
    expectConversionFailure(font, /composite|component|depth/i);
  });

  it('rejects a composite glyph that points past the last glyph', () => {
    const font = buildGlyfFont({
      family: 'Dangling',
      glyphs: [
        ARCH.glyph,
        { codePoint: 0x42, advance: 500, components: [{ glyphIndex: 40, dx: 0, dy: 0 }] },
      ],
    });
    expectConversionFailure(font, /component|glyph 40/i);
  });

  it('rejects point-matching composite arguments that this engine cannot place', () => {
    const font = buildGlyfFont({
      family: 'Matching',
      glyphs: [
        ARCH.glyph,
        { codePoint: 0x42, advance: 500, components: [{ glyphIndex: 1, dx: 0, dy: 0, pointMatching: true }] },
      ],
    });
    expectConversionFailure(font, /point|match/i);
  });

  it('rejects coordinates that cannot be written as a Type 2 charstring operand', () => {
    const square = (xOffset: number): GlyfGlyphSpec['contours'] => [
      [
        { x: xOffset, y: 0 },
        { x: xOffset, y: 100 },
        { x: xOffset + 100, y: 100 },
        { x: xOffset + 100, y: 0 },
      ],
    ];
    const font = buildGlyfFont({
      family: 'Wide',
      glyphs: [
        { codePoint: 0x41, advance: 500, contours: square(0) },
        {
          codePoint: 0x42,
          advance: 500,
          components: [
            { glyphIndex: 1, dx: -30000, dy: 0 },
            { glyphIndex: 1, dx: 30000, dy: 0 },
          ],
        },
      ],
    });
    expectConversionFailure(font, /operand|range|32767/i);
  });
});

describe('TrueType to CFF: advances that do not fit a Type 2 operand are written relative to nominalWidthX', () => {
  const UNITS_PER_EM = 16384;
  const WIDE_ADVANCE = 40000;
  const SQUARE = [[{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 0 }]];

  function convertedAdvances(advances: number[], notdefAdvance: number): { cffWidths: number[]; hmtxWidths: number[] } {
    const font = buildGlyfFont({
      family: 'Wide advances',
      unitsPerEm: UNITS_PER_EM,
      notdef: { advance: notdefAdvance },
      glyphs: advances.map((advance, i) => ({ codePoint: 0x41 + i, advance, contours: SQUARE })),
    });
    const tables = readSfntTables(convertFontToOpenTypeCff(font) as Buffer);
    const cff = decodeCff(requireTable(tables, 'CFF '));
    const hmtxWidths = cff.glyphs.map((_, g) => readHmtx(tables, g).advance);
    return { cffWidths: cff.glyphs.map((g) => g.width), hmtxWidths };
  }

  it('converts an advance of 40000 at 16384 units per em and reads the same width back', () => {
    const { cffWidths, hmtxWidths } = convertedAdvances([WIDE_ADVANCE, 600, 600], 600);
    expect(cffWidths).toEqual([600, WIDE_ADVANCE, 600, 600]);
    expect(hmtxWidths).toEqual(cffWidths);
  });

  it('keeps every width of a font whose advances are mostly tiny and a few huge', () => {
    // The median advance (0) is too far from 65000 for a delta; the nominal width must come from the range.
    const advances = [0, 0, 0, 0, 65000, 65000, 12];
    const { cffWidths, hmtxWidths } = convertedAdvances(advances, 0);
    expect(cffWidths).toEqual([0, ...advances]);
    expect(hmtxWidths).toEqual(cffWidths);
  });

  it('keeps every width of a font that uses the whole 16-bit advance range up to its limit', () => {
    const advances = [0, 65534, 32767];
    const { cffWidths } = convertedAdvances(advances, 0);
    expect(cffWidths).toEqual([0, ...advances]);
  });
});

describe('TrueType to CFF: the glyph count a CFF charset can name', () => {
  /** Custom CFF strings are numbered from SID 391 and a SID is 16 bits: .notdef plus 65,145 named glyphs. */
  const LAST_NAMED_GLYPH_COUNT = 0xffff - FIRST_CUSTOM_SID + 1 + 1;
  const MAX_GLYPH_COUNT = 0xffff;
  const LARGE_FONT_TIMEOUT_MS = 60_000;
  const TRIANGLE = [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }]];

  function fontWithGlyphCount(total: number): Buffer {
    return buildGlyfFont({
      family: 'Many',
      shortLoca: false,
      glyphs: Array.from({ length: total - 1 }, (_, i) => ({ advance: 500, contours: i === 0 ? TRIANGLE : [] })),
    });
  }

  it(
    'converts a font with as many glyphs as the charset can name and keeps their names',
    () => {
      const out = convertFontToOpenTypeCff(fontWithGlyphCount(LAST_NAMED_GLYPH_COUNT)) as Buffer;
      const cff = decodeCff(requireTable(readSfntTables(out), 'CFF '));
      expect(cff.numGlyphs).toBe(LAST_NAMED_GLYPH_COUNT);
      expect(cffGlyphName(cff, LAST_NAMED_GLYPH_COUNT - 1)).toBe(`glyph${LAST_NAMED_GLYPH_COUNT - 1}`);
    },
    LARGE_FONT_TIMEOUT_MS
  );

  it(
    'rejects more glyphs than the charset can name with a typed error instead of a RangeError',
    () => {
      for (const total of [LAST_NAMED_GLYPH_COUNT + 1, MAX_GLYPH_COUNT]) {
        let caught: unknown;
        try {
          convertFontToOpenTypeCff(fontWithGlyphCount(total));
        } catch (error) {
          caught = error;
        }
        expect(caught, `${total} glyphs`).toBeInstanceOf(ConversionFailedError);
        expect(caught).not.toBeInstanceOf(FontOutlinesMissingError);
        expect((caught as Error).message, `${total} glyphs`).toMatch(/CFF.*(name|string)/i);
      }
    },
    LARGE_FONT_TIMEOUT_MS
  );
});

describe('TrueType to CFF: composite expansion is bounded across the whole font', () => {
  const RING_POINTS = 32;
  const RING_RADIUS = 100;
  const FULL_TURN = 2 * Math.PI;
  const SHARED_COMPONENTS = 1000;
  const COMPOSITE_GLYPHS = 1000;
  const RSS_GROWTH_LIMIT_BYTES = 400 * 1024 * 1024;
  const BYTES_PER_MB = 1024 * 1024;
  const SMALL_FONT_BYTES = 100 * 1024;
  const ring = Array.from({ length: RING_POINTS }, (_, i) => ({
    x: Math.round(RING_RADIUS * Math.cos((i / RING_POINTS) * FULL_TURN)),
    y: Math.round(RING_RADIUS * Math.sin((i / RING_POINTS) * FULL_TURN)),
  }));

  /** Glyph 1 is a ring, glyph 2 places it `shared` times, and every later glyph places glyph 2 once. */
  function amplifierFont(shared: number, composites: number): Buffer {
    const glyphs: GlyfGlyphSpec[] = [
      { codePoint: 0x41, advance: 500, contours: [ring] },
      { codePoint: 0x42, advance: 500, components: Array.from({ length: shared }, () => ({ glyphIndex: 1, dx: 0, dy: 0 })) },
    ];
    for (let i = 0; i < composites; i++) glyphs.push({ advance: 500, components: [{ glyphIndex: 2, dx: 0, dy: 0 }] });
    return buildGlyfFont({ family: 'Amplifier', glyphs });
  }

  it('rejects a small font whose composites expand to tens of millions of points, quickly and without large allocations', async () => {
    // 37 KB expanding to 32 million points, against 76 KB expanding to 192 million: the amplification guard
    // refuses both after the same work, so the time must not follow the claimed expansion (tests/helpers/timing.ts).
    const modest = amplifierFont(SHARED_COMPONENTS, COMPOSITE_GLYPHS);
    const huge = amplifierFont(SHARED_COMPONENTS * 2, COMPOSITE_GLYPHS * 3);
    expect(modest.length).toBeLessThan(SMALL_FONT_BYTES);
    expect(huge.length).toBeLessThan(SMALL_FONT_BYTES);
    const rssBefore = process.memoryUsage().rss;
    const { largeResult } = await expectSizeIndependentOnInputs(
      'composite amplification',
      (font: Buffer) => settle(() => convertFontToOpenTypeCff(font)),
      { modest, huge }
    );
    const rssGrowth = process.memoryUsage().rss - rssBefore;
    if (largeResult.ok) throw new Error('the amplifying font was converted instead of rejected');
    expect(largeResult.error, 'conversion must throw').toBeInstanceOf(ConversionFailedError);
    expect((largeResult.error as Error).message).toMatch(/points|expand/i);
    expect(rssGrowth, `rss grew by ${Math.round(rssGrowth / BYTES_PER_MB)} MB`).toBeLessThan(RSS_GROWTH_LIMIT_BYTES);
  }, SCALING_TEST_TIMEOUT_MS);

  it('converts a Hangul-style font: 11,172 compact composites of three shared jamo outlines', () => {
    // Each syllable is 3 components (about 30 bytes) and flattens to 180 points, so the 2.0 million
    // output points are legitimate: compact composite-heavy fonts must stay within the budget.
    const JAMO = 60;
    const JAMO_POINTS = 60;
    const SYLLABLES = 11172;
    const JAMO_RADIUS = 300;
    const jamoRing = (k: number): Array<{ x: number; y: number }> =>
      Array.from({ length: JAMO_POINTS }, (_, i) => ({
        x: Math.round(JAMO_RADIUS * Math.cos((i / JAMO_POINTS) * FULL_TURN)) + k,
        y: Math.round(JAMO_RADIUS * Math.sin((i / JAMO_POINTS) * FULL_TURN)),
      }));
    const glyphs: GlyfGlyphSpec[] = [];
    for (let j = 0; j < JAMO; j++) glyphs.push({ advance: 1000, contours: [jamoRing(j)] });
    const parts = (syllable: number): number[] => [syllable % JAMO, (syllable * 7) % JAMO, (syllable * 13) % JAMO];
    for (let sy = 0; sy < SYLLABLES; sy++) {
      glyphs.push({ advance: 1000, components: parts(sy).map((jamo) => ({ glyphIndex: 1 + jamo, dx: 0, dy: 0 })) });
    }
    const out = convertFontToOpenTypeCff(buildGlyfFont({ family: 'Hangul', glyphs })) as Buffer;
    const tables = readSfntTables(out);
    expect(readGlyphCount(tables)).toBe(1 + JAMO + SYLLABLES);
    const cff = decodeCff(requireTable(tables, 'CFF '));
    const sampled = 5000;
    const outline = cff.glyphs[1 + JAMO + sampled];
    expect(outline.contours).toHaveLength(3);
    parts(sampled).forEach((jamo, c) => {
      const expected: Cmd[] = jamoRing(jamo).map((pt, i) => [i === 0 ? 'M' : 'L', pt.x, pt.y] as Cmd);
      expect(hausdorff(flattenCharstringContour(outline.contours[c]), flattenCommands(expected)), `component ${c}`).toBeLessThan(GEOMETRY_TOLERANCE);
    });
  });

  it('still converts a font whose glyphs share a component many times within the budget', () => {
    const font = amplifierFont(2, 300); // 300 glyphs x 64 points, far below the budget
    const out = convertFontToOpenTypeCff(font) as Buffer;
    expect(readGlyphCount(readSfntTables(out))).toBe(2 + 300 + 1);
  });
});

// ---------------------------------------------------------------------------
// External oracles
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_FC_SCAN)('TrueType to CFF: fontconfig reads the output as the same face (needs fc-scan)', () => {
  it('reports a CFF face with the family, names and character set of the source', async () => {
    const ttf = buildGlyfFont(fixtureSpec());
    const before = fcScan(ttf, 'ttf');
    expect(before.fontformat).toBe('TrueType');
    const after = fcScan(await convertToOtf(ttf), 'otf');
    expect(after.fontformat).toBe('CFF');
    expect(after.family).toBe('Glyf Probe');
    expect(after.style).toBe('Regular');
    expect(after.fullname).toBe(before.fullname);
    expect(after.postscriptname).toBe(before.postscriptname);
    expect(after.charset).toBe(before.charset);
    expect(after.charset).toBe('20 41-45 47-48');
  });
});

describe.skipIf(!HAS_FREETYPE)('TrueType to CFF: FreeType renders the output like the input (needs ImageMagick with FreeType)', () => {
  it('draws the same ink for every glyph before and after conversion', async () => {
    const ttf = buildGlyfFont(fixtureSpec());
    const otf = await convertToOtf(ttf);
    withFontFile(ttf, 'ttf', (ttfFile) =>
      withFontFile(otf, 'otf', (otfFile) => {
        // The half-size composite is only about 20 pixels wide at this size, where FreeType's
        // automatic hinter (it hints TrueType fonts that have no bytecode) moves edges by a pixel
        // depending on the other glyphs of the font; its geometry is asserted exactly above.
        const renderable = OUTLINE_FIXTURES.filter((f) => f.expected.length > 0 && f !== SCALED_COMPOSITE);
        for (const fixture of renderable) {
          const char = String.fromCodePoint(fixture.glyph.codePoint as number);
          const before = renderGlyph(ttfFile, char);
          const after = renderGlyph(otfFile, char);
          expect(inkCount(before), `${fixture.name}: source renders ink`).toBeGreaterThan(MIN_RENDERED_INK);
          expect(inkOverlap(before, after), `${fixture.name}: ink overlap`).toBeGreaterThan(OVERLAP_MINIMUM);
        }
      })
    );
  });
});

describe('TrueType to CFF: the converted font survives the other conversions', () => {
  it('converts back to TrueType with the original outlines (round trip through the CFF reader)', async () => {
    const ttf = buildGlyfFont(fixtureSpec());
    const otf = await convertToOtf(ttf);
    const back = await convertFont(otf, 'otf', 'ttf', {}, 'probe.otf');
    const tables = readSfntTables(back.buffer);
    expect(tables.has('glyf')).toBe(true);
    expect(tables.has('CFF ')).toBe(false);
    expect(readCmap(tables).get(0x42)).toBe(2);
  });
});
