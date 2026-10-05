import { describe, expect, it } from 'vitest';
import { convertFont, decodeSvgFont, FontOutlinesMissingError } from '../src/lib/conversions/font';
import { MAX_SVG_FONT_GLYPHS } from '../src/lib/conversions/font-svg';
import { MAX_SVG_PATH_COMMANDS_PER_GLYPH, SvgPathDataError } from '../src/lib/conversions/font-svg-path';
import { ConversionFailedError } from '../src/lib/types';
import {
  cffGlyphName,
  decodeCff,
  fcScan,
  flattenCharstringContour,
  flattenCommands,
  flattenTrueType,
  HAS_FC_SCAN,
  HAS_FREETYPE,
  hausdorff,
  inkCount,
  inkOverlap,
  readCmap,
  readGlyf,
  readGlyphCount,
  readHmtx,
  readPostCustomNames,
  readSfntTables,
  readUnitsPerEm,
  renderGlyph,
  requireStrictFcScan,
  requireTable,
  signedArea,
  unwrapEot,
  unwrapWoff,
  unwrapWoff2,
  withFontFile,
  type Cmd,
  type Pt,
} from './helpers/font-oracles';
import { buildGlyfFont } from './helpers/glyf-font-builder';

/**
 * SVG font glyph outlines: the d attribute of every glyph becomes a real outline in TTF, OTF,
 * WOFF, WOFF2, EOT and SVG output.
 *
 * The fixture font is written by hand with expected geometry worked out per glyph. Outputs are read
 * back with the independent glyf, cmap, hmtx, post, CFF and container readers in
 * tests/helpers/font-oracles.ts. fc-scan and a FreeType render (ImageMagick) are additional external
 * oracles when installed.
 */

requireStrictFcScan('SVG font');

const UNITS_PER_EM = 2048;
const ASCENT = 1600;
const DESCENT = -448;
const FONT_ADVANCE = 1200;
const EMOJI = 0x1f600;
/** Cubic to quadratic tolerance (0.0005 em, about 1 unit) plus the integer grid (0.71 unit). */
const QUADRATIC_TOLERANCE = 1.8;
const CIRCLE_TOLERANCE = 2.5;
const OVERLAP_MINIMUM = 0.97;
const MIN_RENDERED_INK = 100;
const WIDE_GLYPH_ID_BASE = 1;

const FIXTURE_SVG = `<?xml version="1.0" standalone="no"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg">
  <defs>
    <font id="svgprobe" horiz-adv-x="${FONT_ADVANCE}">
      <font-face font-family="Svg Probe" units-per-em="${UNITS_PER_EM}" ascent="${ASCENT}" descent="${DESCENT}" />
      <missing-glyph horiz-adv-x="900" d="M100 0 H800 V1400 H100 Z" />
      <!-- 1 --><glyph unicode="A" glyph-name="A" horiz-adv-x="1300" d="M0 0 L650 1400 L1300 0 Z" />
      <!-- 2 --><glyph unicode="B" glyph-name="uni0042" d="M200 0 L200 1400 Q1000 1400 1000 700 Q1000 0 200 0 Z" />
      <!-- 3 --><glyph unicode="C" d="m0 0c0 1000 1000 1000 1000 0z" />
      <!-- 4 --><glyph unicode="D" d="M0 700 A700 700 0 1 1 1400 700 A700 700 0 1 1 0 700 Z" />
      <!-- 5 --><glyph unicode=" " horiz-adv-x="500" />
      <!-- 6 --><glyph unicode="ff" glyph-name="f_f" horiz-adv-x="700" d="M0 0 H600 V700 H0 Z" />
      <!-- 7 --><glyph glyph-name="alt.one" horiz-adv-x="1000" d="M0 0 H100 V100 Z" />
      <!-- 8 --><glyph unicode="&#x1F600;" horiz-adv-x="800" d="M100 100 H700 V700 H100 Z" />
      <!-- 9 --><glyph unicode="&amp;" horiz-adv-x="650" d="M0 0 H500 V500 Z" />
      <!-- 10 --><glyph unicode="A" arabic-form="final" horiz-adv-x="1111" d="M0 0 H100 V100 H0 Z" />
      <glyph unicode="V" orientation="v" horiz-adv-x="333" d="M0 0 H1 V1 Z" />
    </font>
  </defs>
</svg>`;

const FIXTURE_GLYPH_COUNT = 11; // .notdef plus ten horizontal glyphs; the vertical-only glyph is skipped
const FIXTURE_ADVANCES = [900, 1300, FONT_ADVANCE, FONT_ADVANCE, FONT_ADVANCE, 500, 700, 1000, 800, 650, 1111];

const svgBuffer = (text: string = FIXTURE_SVG): Buffer => Buffer.from(text, 'utf8');

async function convertSvg(target: string, text?: string): Promise<Buffer> {
  return (await convertFont(svgBuffer(text), 'svg', target, {}, 'probe.svg')).buffer;
}

function glyphPolygons(tables: Map<string, Buffer>, glyphId: number): Pt[][] {
  const glyph = readGlyf(tables, glyphId);
  return glyph === null ? [] : glyph.contours.map((contour) => flattenTrueType(contour));
}

// Hand-written outlines of the fixture glyphs, in the direction of the SVG path.
const NOTDEF_EXPECTED: Cmd[] = [['M', 100, 0], ['L', 800, 0], ['L', 800, 1400], ['L', 100, 1400]];
const TRIANGLE_EXPECTED: Cmd[] = [['M', 0, 0], ['L', 650, 1400], ['L', 1300, 0]];
const B_EXPECTED: Cmd[] = [['M', 200, 0], ['L', 200, 1400], ['Q', 1000, 1400, 1000, 700], ['Q', 1000, 0, 200, 0]];
const C_EXPECTED: Cmd[] = [['M', 0, 0], ['C', 0, 1000, 1000, 1000, 1000, 0]];
const SQUARE_600_EXPECTED: Cmd[] = [['M', 0, 0], ['L', 600, 0], ['L', 600, 700], ['L', 0, 700]];
const ALT_EXPECTED: Cmd[] = [['M', 0, 0], ['L', 100, 0], ['L', 100, 100]];
const EMOJI_EXPECTED: Cmd[] = [['M', 100, 100], ['L', 700, 100], ['L', 700, 700], ['L', 100, 700]];
const AMP_EXPECTED: Cmd[] = [['M', 0, 0], ['L', 500, 0], ['L', 500, 500]];

function expectPolygonNear(actual: Pt[], expected: Cmd[], tolerance: number, label: string): void {
  expect(hausdorff(actual, flattenCommands(expected)), label).toBeLessThan(tolerance);
}

// ---------------------------------------------------------------------------
// TrueType output
// ---------------------------------------------------------------------------

describe('SVG font to TTF: glyph paths become real glyf outlines', () => {
  it('writes the font metrics from font-face and the glyph advances from horiz-adv-x', async () => {
    const tables = readSfntTables(await convertSvg('ttf'));
    expect(readUnitsPerEm(tables)).toBe(UNITS_PER_EM);
    const hhea = requireTable(tables, 'hhea');
    expect(hhea.readInt16BE(4)).toBe(ASCENT);
    expect(hhea.readInt16BE(6)).toBe(DESCENT);
    expect(readGlyphCount(tables)).toBe(FIXTURE_GLYPH_COUNT);
    FIXTURE_ADVANCES.forEach((advance, g) => expect(readHmtx(tables, g).advance, `glyph ${g}`).toBe(advance));
  });

  it('maps unicode attributes to glyph ids: entities decoded, first glyph wins, ligatures and unnamed forms skipped', async () => {
    const cmap = readCmap(readSfntTables(await convertSvg('ttf')));
    expect(cmap.get(0x41)).toBe(1); // the second "A" (arabic-form final) does not replace the first
    expect(cmap.get(0x42)).toBe(2);
    expect(cmap.get(0x43)).toBe(3);
    expect(cmap.get(0x44)).toBe(4);
    expect(cmap.get(0x20)).toBe(5);
    expect(cmap.get(EMOJI)).toBe(8);
    expect(cmap.get(0x26)).toBe(9);
    expect(cmap.has(0x66)).toBe(false); // "ff" is a ligature, not the character f
    expect(cmap.has(0x56)).toBe(false); // vertical-only glyph is not part of horizontal text
    expect([...cmap.keys()].sort((a, b) => a - b)).toEqual([0x20, 0x26, 0x41, 0x42, 0x43, 0x44, EMOJI]);
  });

  it('draws the .notdef glyph from missing-glyph and every other glyph from its own path', async () => {
    const tables = readSfntTables(await convertSvg('ttf'));
    const notdef = readGlyf(tables, 0)!;
    expect(notdef.contours).toHaveLength(1);
    expect(notdef.contours[0]).toEqual([
      { x: 100, y: 0, on: true },
      { x: 800, y: 0, on: true },
      { x: 800, y: 1400, on: true },
      { x: 100, y: 1400, on: true },
    ]);

    const triangle = readGlyf(tables, 1)!;
    expect(triangle.contours).toEqual([
      [
        { x: 0, y: 0, on: true },
        { x: 650, y: 1400, on: true },
        { x: 1300, y: 0, on: true },
      ],
    ]);
    expect(triangle.bbox).toEqual([0, 0, 1300, 1400]);

    expectPolygonNear(glyphPolygons(tables, 6)[0], SQUARE_600_EXPECTED, 0.01, 'ligature glyph');
    expectPolygonNear(glyphPolygons(tables, 7)[0], ALT_EXPECTED, 0.01, 'glyph-name only glyph');
    expectPolygonNear(glyphPolygons(tables, 8)[0], EMOJI_EXPECTED, 0.01, 'astral glyph');
    expectPolygonNear(glyphPolygons(tables, 9)[0], AMP_EXPECTED, 0.01, 'ampersand glyph');
    expect(readGlyf(tables, 5)).toBeNull(); // the space glyph has no outline
  });

  it('keeps quadratic segments exactly: Q becomes one off-curve point', async () => {
    const tables = readSfntTables(await convertSvg('ttf'));
    const glyph = readGlyf(tables, 2)!;
    expect(glyph.contours).toEqual([
      [
        { x: 200, y: 0, on: true },
        { x: 200, y: 1400, on: true },
        { x: 1000, y: 1400, on: false },
        { x: 1000, y: 700, on: true },
        { x: 1000, y: 0, on: false },
      ],
    ]);
    expectPolygonNear(glyphPolygons(tables, 2)[0], B_EXPECTED, 0.01, 'quadratic glyph');
  });

  it('approximates cubic segments by a chain of quadratics within the tolerance', async () => {
    const tables = readSfntTables(await convertSvg('ttf'));
    const glyph = readGlyf(tables, 3)!;
    expect(glyph.contours[0].filter((p) => !p.on).length).toBeGreaterThanOrEqual(3);
    expectPolygonNear(glyphPolygons(tables, 3)[0], C_EXPECTED, QUADRATIC_TOLERANCE, 'cubic glyph');
  });

  it('converts elliptical arcs to a circle of the right radius and area', async () => {
    const tables = readSfntTables(await convertSvg('ttf'));
    const [circle] = glyphPolygons(tables, 4);
    for (const pt of circle) {
      expect(Math.abs(Math.hypot(pt.x - 700, pt.y - 700) - 700)).toBeLessThan(CIRCLE_TOLERANCE);
    }
    const expectedArea = Math.PI * 700 * 700;
    expect(Math.abs(Math.abs(signedArea(circle)) - expectedArea) / expectedArea).toBeLessThan(0.005);
    expect(readGlyf(tables, 4)!.bbox[0]).toBeGreaterThanOrEqual(-2);
    expect(readGlyf(tables, 4)!.bbox[2]).toBeLessThanOrEqual(1402);
  });

  it('stores glyph-name values in a post table version 2.0 with unique valid names', async () => {
    const tables = readSfntTables(await convertSvg('ttf'));
    const names = readPostCustomNames(tables);
    expect(names.get(1)).toBe('A');
    expect(names.get(2)).toBe('uni0042');
    expect(names.get(6)).toBe('f_f');
    expect(names.get(7)).toBe('alt.one');
    const all = [...names.values()];
    expect(new Set(all).size).toBe(all.length);
    for (const name of all) expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9._]{0,62}$/);
    expect(names.size).toBe(FIXTURE_GLYPH_COUNT - 1);
  });

  it('accepts relative commands, implicit repeats and compact numbers like their absolute spelling', async () => {
    const absolute = svgWith('<glyph unicode="A" horiz-adv-x="800" d="M10 20 L110 20 L110 120 L10 120 Z" />');
    const relative = svgWith('<glyph unicode="A" horiz-adv-x="800" d="m10 20 100 0 0 100 -100 0z" />');
    const compact = svgWith('<glyph unicode="A" horiz-adv-x="800" d="M10,20H110v100H10z" />');
    const readFirst = async (svg: string): Promise<unknown> => readGlyf(readSfntTables(await convertSvg('ttf', svg)), 1)!.contours;
    const wanted = [
      [
        { x: 10, y: 20, on: true },
        { x: 110, y: 20, on: true },
        { x: 110, y: 120, on: true },
        { x: 10, y: 120, on: true },
      ],
    ];
    expect(await readFirst(absolute)).toEqual(wanted);
    expect(await readFirst(relative)).toEqual(wanted);
    expect(await readFirst(compact)).toEqual(wanted);
  });

  it('uses the SVG defaults of 1000 units per em and a zero advance when attributes are missing', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><font><font-face font-family="Bare"/>
      <glyph unicode="A" d="M0 0 H500 V500 H0 Z"/></font></svg>`;
    const tables = readSfntTables(await convertSvg('ttf', svg));
    expect(readUnitsPerEm(tables)).toBe(1000);
    expect(readHmtx(tables, 1).advance).toBe(0);
  });

  it('decodeSvgFont returns a font that already has glyf outlines', () => {
    const font = decodeSvgFont(svgBuffer(), 'fallback');
    expect(font.tables['glyf']).toBeDefined();
    expect(font.tables['loca']).toBeDefined();
    expect(font.fontFamily).toBe('Svg Probe');
  });
});

function svgWith(glyphs: string, fontFace = `units-per-em="1000" ascent="800" descent="-200"`): string {
  return `<svg xmlns="http://www.w3.org/2000/svg"><defs><font horiz-adv-x="700">
    <font-face font-family="Variant" ${fontFace} />${glyphs}</font></defs></svg>`;
}

// ---------------------------------------------------------------------------
// The other targets carry the same outlines
// ---------------------------------------------------------------------------

describe('SVG font to OTF, WOFF, WOFF2, EOT and SVG: the same real outlines', () => {
  it('OTF: charstrings draw the same shapes with the same advances and the glyph names', async () => {
    const otf = await convertSvg('otf');
    expect(otf.readUInt32BE(0)).toBe(0x4f54544f);
    const tables = readSfntTables(otf);
    expect(tables.has('glyf')).toBe(false);
    expect(readUnitsPerEm(tables)).toBe(UNITS_PER_EM);
    const cff = decodeCff(requireTable(tables, 'CFF '));
    expect(cff.numGlyphs).toBe(FIXTURE_GLYPH_COUNT);
    expect(cff.glyphs.map((g) => g.width)).toEqual(FIXTURE_ADVANCES);
    const polygon = (g: number): Pt[] => flattenCharstringContour(cff.glyphs[g].contours[0]);
    expectPolygonNear(polygon(0), NOTDEF_EXPECTED, 0.01, 'notdef');
    expectPolygonNear(polygon(1), TRIANGLE_EXPECTED, 0.01, 'triangle');
    expectPolygonNear(polygon(2), B_EXPECTED, 0.05, 'quadratic');
    expectPolygonNear(polygon(3), C_EXPECTED, QUADRATIC_TOLERANCE, 'cubic');
    expect(cff.glyphs[5].contours).toHaveLength(0);
    expect(cffGlyphName(cff, 1)).toBe('A');
    expect(cffGlyphName(cff, 2)).toBe('uni0042');
    expect(cffGlyphName(cff, 7)).toBe('alt.one');
    expect(readCmap(tables).get(0x43)).toBe(3);
  });

  it('WOFF: the sfnt tables inside carry the glyf outlines', async () => {
    const tables = unwrapWoff(await convertSvg('woff'));
    expect(readGlyphCount(tables)).toBe(FIXTURE_GLYPH_COUNT);
    expect(readGlyf(tables, 1)!.contours[0]).toHaveLength(3);
    expectPolygonNear(glyphPolygons(tables, 2)[0], B_EXPECTED, 0.01, 'woff quadratic');
  });

  it('WOFF2: glyf and loca are declared with the null transform and decode to the same outlines', async () => {
    const tables = unwrapWoff2(await convertSvg('woff2'));
    expect(readGlyphCount(tables)).toBe(FIXTURE_GLYPH_COUNT);
    expect(readGlyf(tables, 1)!.contours[0]).toHaveLength(3);
    expectPolygonNear(glyphPolygons(tables, 2)[0], B_EXPECTED, 0.01, 'woff2 quadratic');
    expectPolygonNear(glyphPolygons(tables, 3)[0], C_EXPECTED, QUADRATIC_TOLERANCE, 'woff2 cubic');
  });

  it('EOT: the embedded sfnt carries the glyf outlines', async () => {
    const tables = readSfntTables(unwrapEot(await convertSvg('eot')));
    expect(readGlyphCount(tables)).toBe(FIXTURE_GLYPH_COUNT);
    expect(readGlyf(tables, 2)!.contours[0]).toHaveLength(5);
    expectPolygonNear(glyphPolygons(tables, 2)[0], B_EXPECTED, 0.01, 'eot quadratic');
    expectPolygonNear(glyphPolygons(tables, 3)[0], C_EXPECTED, QUADRATIC_TOLERANCE, 'eot cubic');
  });

  it('SVG: writes the real paths, the declared metrics and the glyph names back, without placeholder glyphs', async () => {
    const svg = (await convertSvg('svg')).toString('utf8');
    expect(svg).toContain(`units-per-em="${UNITS_PER_EM}"`);
    expect(svg).toContain(`ascent="${ASCENT}"`);
    expect(svg).toContain(`descent="${DESCENT}"`);
    expect(svg).toContain('<glyph unicode="A" glyph-name="A" horiz-adv-x="1300" d="M0 0 L650 1400 L1300 0 Z" />');
    expect(svg).toContain(
      '<glyph unicode="B" glyph-name="uni0042" horiz-adv-x="1200" d="M200 0 L200 1400 Q1000 1400 1000 700 Q1000 0 200 0 Z" />'
    );
    expect(svg).toContain('<glyph glyph-name="alt.one" horiz-adv-x="1000" d="M0 0 L100 0 L100 100 Z" />');
    expect(svg).toContain('<missing-glyph horiz-adv-x="900" d="M100 0 L800 0 L800 1400 L100 1400 Z" />');
    expect(svg).toContain('<glyph unicode=" " horiz-adv-x="500" />');
    expect(svg).toContain(`<glyph unicode="${String.fromCodePoint(EMOJI)}" horiz-adv-x="800" d="M100 100 L700 100 L700 700 L100 700 Z" />`);
    expect(svg).toContain('<glyph unicode="&amp;" horiz-adv-x="650" d="M0 0 L500 0 L500 500 Z" />');
    // The old default missing-glyph box and the character-by-index fallbacks are gone.
    expect(svg).not.toContain('M0 0 L500 0 L500 800 L0 800 Z');
    expect(svg).not.toContain('&#x0;');
    // Glyphs that are neither mapped to a character nor named (the final-form "A") cannot be
    // addressed in an SVG font, so they are left out; the .notdef glyph is the missing-glyph element.
    const glyphDs = [...svg.matchAll(/<glyph [^>]*\sd="([^"]*)"/g)].map((m) => m[1]);
    expect(glyphDs).toHaveLength(8);
  });

  it('SVG to SVG to TTF keeps the outlines (round trip through the written paths)', async () => {
    const roundTripped = await convertSvg('ttf', (await convertSvg('svg')).toString('utf8'));
    const tables = readSfntTables(roundTripped);
    expect(readUnitsPerEm(tables)).toBe(UNITS_PER_EM);
    const cmap = readCmap(tables);
    const polygon = glyphPolygons(tables, cmap.get(0x42)!)[0];
    expectPolygonNear(polygon, B_EXPECTED, 0.01, 'round trip quadratic');
    expectPolygonNear(glyphPolygons(tables, cmap.get(0x43)!)[0], C_EXPECTED, QUADRATIC_TOLERANCE + 1, 'round trip cubic');
  });

  it('SVG output keeps more than 512 glyphs', async () => {
    const many = Array.from(
      { length: 600 },
      (_, i) => `<glyph unicode="&#x${(0x4e00 + i).toString(16)};" horiz-adv-x="1000" d="M0 0 H${100 + i} V100 H0 Z" />`
    ).join('\n');
    const svg = (await convertSvg('svg', svgWith(many))).toString('utf8');
    expect((svg.match(/<glyph /g) ?? []).length).toBe(600);
    expect(svg).toContain('d="M0 0 L699 0 L699 100 L0 100 Z"');
  });
});

// ---------------------------------------------------------------------------
// External oracles
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_FC_SCAN)('SVG font: fontconfig reads the TTF and OTF output (needs fc-scan)', () => {
  it.each([
    ['ttf', 'TrueType'],
    ['otf', 'CFF'],
  ])('reports the %s face with family Svg Probe, format %s and the mapped characters', async (target, format) => {
    const scanned = fcScan(await convertSvg(target), target);
    expect(scanned.fontformat).toBe(format);
    expect(scanned.family).toBe('Svg Probe');
    expect(scanned.charset).toBe('20 26 41-44 1f600');
  });
});

describe.skipIf(!HAS_FREETYPE)('SVG font: FreeType renders the output like a reference font (needs ImageMagick with FreeType)', () => {
  it('draws the same ink as a reference TrueType font written from the hand-written outlines', async () => {
    const reference = buildGlyfFont({
      family: 'Reference',
      unitsPerEm: UNITS_PER_EM,
      glyphs: [
        {
          codePoint: 0x41,
          advance: 1300,
          contours: [
            [
              { x: 0, y: 0 },
              { x: 650, y: 1400 },
              { x: 1300, y: 0 },
            ],
          ],
        },
        {
          codePoint: 0x42,
          advance: FONT_ADVANCE,
          contours: [
            [
              { x: 200, y: 0 },
              { x: 200, y: 1400 },
              { x: 1000, y: 1400, on: false },
              { x: 1000, y: 700 },
              { x: 1000, y: 0, on: false },
            ],
          ],
        },
      ],
    });
    const ttf = await convertSvg('ttf');
    const otf = await convertSvg('otf');
    withFontFile(reference, 'ttf', (referenceFile) =>
      withFontFile(ttf, 'ttf', (ttfFile) =>
        withFontFile(otf, 'otf', (otfFile) => {
          for (const char of ['A', 'B']) {
            const wanted = renderGlyph(referenceFile, char);
            expect(inkCount(wanted), `${char}: reference renders ink`).toBeGreaterThan(MIN_RENDERED_INK);
            expect(inkOverlap(wanted, renderGlyph(ttfFile, char)), `${char}: ttf`).toBeGreaterThan(OVERLAP_MINIMUM);
            expect(inkOverlap(wanted, renderGlyph(otfFile, char)), `${char}: otf`).toBeGreaterThan(OVERLAP_MINIMUM);
          }
          // The curved glyphs cannot be written down exactly, but the TrueType and CFF renders agree.
          for (const char of ['C', 'D']) {
            const fromTtf = renderGlyph(ttfFile, char);
            expect(inkCount(fromTtf), `${char}: renders ink`).toBeGreaterThan(MIN_RENDERED_INK);
            expect(inkOverlap(fromTtf, renderGlyph(otfFile, char)), `${char}: ttf vs otf`).toBeGreaterThan(OVERLAP_MINIMUM);
          }
        })
      )
    );
  });
});

// ---------------------------------------------------------------------------
// Fail closed
// ---------------------------------------------------------------------------

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error
  );
}

describe('SVG font: fonts without outlines and malformed paths are rejected with typed errors', () => {
  it.each(['ttf', 'otf', 'woff', 'woff2', 'eot', 'svg'])(
    'throws FontOutlinesMissingError for %s output when no glyph has a path',
    async (target) => {
      const svg = svgWith('<glyph unicode="A" horiz-adv-x="500" /><glyph unicode=" " horiz-adv-x="250" d="" />');
      const failure = await failureOf(convertSvg(target, svg));
      expect(failure).toBeInstanceOf(FontOutlinesMissingError);
      expect(failure).toBeInstanceOf(ConversionFailedError);
      expect((failure as Error).message).toBe('Cannot convert the SVG font: none of its glyphs has a usable path (d attribute).');
    }
  );

  it('throws FontOutlinesMissingError for an SVG document that has no font element', async () => {
    const failure = await failureOf(convertSvg('ttf', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'));
    expect(failure).toBeInstanceOf(FontOutlinesMissingError);
    expect((failure as Error).message).toBe('Cannot read the SVG font: the document has no <font> element with glyphs.');
  });

  it('throws FontOutlinesMissingError when every path only moves without drawing', async () => {
    const failure = await failureOf(convertSvg('ttf', svgWith('<glyph unicode="A" horiz-adv-x="500" d="M10 10 M20 20" />')));
    expect(failure).toBeInstanceOf(FontOutlinesMissingError);
    expect((failure as Error).message).toMatch(/none of its glyphs has a usable path/);
  });

  it('rejects malformed path data with an SvgPathDataError that names the glyph', async () => {
    const svg = svgWith(
      '<glyph unicode="A" d="M0 0 H100 V100 Z" /><glyph unicode="Q" glyph-name="broken" d="M0 0 L100" />'
    );
    const failure = await failureOf(convertSvg('ttf', svg));
    expect(failure).toBeInstanceOf(SvgPathDataError);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toMatch(/broken/);
  });

  it('rejects a glyph with more path commands than the limit', async () => {
    const d = `M0 0${' L1 1'.repeat(MAX_SVG_PATH_COMMANDS_PER_GLYPH)}`;
    const failure = await failureOf(convertSvg('ttf', svgWith(`<glyph unicode="A" d="${d}" />`)));
    expect(failure).toBeInstanceOf(SvgPathDataError);
    expect((failure as Error).message).toMatch(/limit|too many/i);
  });

  it('rejects a font with more glyphs than the limit', async () => {
    const glyphs = '<glyph unicode="A" d="M0 0 H1 V1 Z"/>'.repeat(MAX_SVG_FONT_GLYPHS + WIDE_GLYPH_ID_BASE);
    const failure = await failureOf(convertSvg('ttf', svgWith(glyphs)));
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect(failure).not.toBeInstanceOf(FontOutlinesMissingError);
    expect((failure as Error).message).toMatch(/glyphs/i);
  });

  it.each([
    ['units-per-em of zero', svgWith('<glyph unicode="A" d="M0 0 H1 V1 Z"/>', 'units-per-em="0"'), /units-per-em/i],
    ['units-per-em that is not a number', svgWith('<glyph unicode="A" d="M0 0 H1 V1 Z"/>', 'units-per-em="big"'), /units-per-em/i],
    ['a negative advance', svgWith('<glyph unicode="A" horiz-adv-x="-5" d="M0 0 H1 V1 Z"/>'), /horiz-adv-x/i],
    ['an advance above the 16-bit range', svgWith('<glyph unicode="A" horiz-adv-x="70000" d="M0 0 H1 V1 Z"/>'), /horiz-adv-x/i],
    ['an unknown entity in unicode', svgWith('<glyph unicode="&bogus;" d="M0 0 H1 V1 Z"/>'), /entity/i],
    ['a character reference to NUL', svgWith('<glyph unicode="&#0;" d="M0 0 H1 V1 Z"/>'), /character|unicode/i],
    ['a coordinate outside the 16-bit glyf range', svgWith('<glyph unicode="A" d="M0 0 L40000 0 L0 10 Z"/>'), /16-bit|range/i],
  ])('rejects %s', async (_name, svg, pattern) => {
    const failure = await failureOf(convertSvg('ttf', svg));
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect(failure).not.toBeInstanceOf(FontOutlinesMissingError);
    expect((failure as Error).message).toMatch(pattern);
  });
});

describe('SVG font: output point counts are bounded while paths are converted', () => {
  const FAST_REJECT_MS = 1000;
  const AMPLIFIED_GLYPHS = 100;
  const ARC_REPEATS = MAX_SVG_PATH_COMMANDS_PER_GLYPH - 1;
  const TRUETYPE_POINT_LIMIT = 0xffff;
  const CUBIC_REPEATS = MAX_SVG_PATH_COMMANDS_PER_GLYPH - 1;
  const CUBIC_GLYPHS = 30;
  const BUDGET_GLYPHS = 70;
  const BUDGET_CUBICS = 1100;
  const BUDGET_REJECT_MS = 10_000;
  // Each of these cubics needs about 27 quadratic pieces, so a few dozen of them already exceed 65,535 points.
  const WIDE_CUBIC = 'C32000 0 -32000 0 0 0';
  const BIG_ARC = 'a12000 12000 0 1 1 1 0';

  function glyphsWithPath(count: number, path: string, repeats: number): string {
    const d = `M0 0${` ${path}`.repeat(repeats)}`;
    return Array.from({ length: count }, (_, i) => `<glyph unicode="&#x${(0x4e00 + i).toString(16)};" horiz-adv-x="500" d="${d}"/>`).join('');
  }

  async function timedFailure(svg: string): Promise<{ failure: unknown; elapsed: number }> {
    const started = performance.now();
    const failure = await failureOf(convertSvg('ttf', svg));
    return { failure, elapsed: performance.now() - started };
  }

  it('rejects glyphs whose arcs expand into far more curve pieces than the path allows, without converting them all', async () => {
    const { failure, elapsed } = await timedFailure(svgWith(glyphsWithPath(AMPLIFIED_GLYPHS, BIG_ARC, ARC_REPEATS)));
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect(failure).not.toBeInstanceOf(FontOutlinesMissingError);
    expect((failure as Error).message).toMatch(/more than \d+ points|too many segments/i);
    expect(elapsed).toBeLessThan(FAST_REJECT_MS);
  });

  it('stops converting once the glyphs of the font together pass the shared point budget', async () => {
    // About 59,000 points per glyph (below the per-glyph limit): 70 of them pass the 4,000,000 point budget.
    const glyphs = glyphsWithPath(BUDGET_GLYPHS, WIDE_CUBIC, BUDGET_CUBICS);
    const { failure, elapsed } = await timedFailure(svgWith(glyphs));
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect(failure).not.toBeInstanceOf(FontOutlinesMissingError);
    expect((failure as Error).message).toMatch(/points together/);
    expect(elapsed).toBeLessThan(BUDGET_REJECT_MS);
  });

  it('stops converting a glyph as soon as it passes the 65,535 points of the glyf format', async () => {
    const { failure, elapsed } = await timedFailure(svgWith(glyphsWithPath(CUBIC_GLYPHS, WIDE_CUBIC, CUBIC_REPEATS)));
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect(failure).not.toBeInstanceOf(FontOutlinesMissingError);
    expect((failure as Error).message).toMatch(new RegExp(`more than ${TRUETYPE_POINT_LIMIT} points`));
    expect(elapsed).toBeLessThan(FAST_REJECT_MS);
  });
});

describe('SVG font: fonts with the most glyphs a 16-bit glyph id can address', () => {
  const MAX_GLYPHS_WITH_NOTDEF = MAX_SVG_FONT_GLYPHS + 1;
  /** post 2.0 indexes custom names from 258, and an index is 16 bits: .notdef plus 65,278 custom names. */
  const LAST_POST_NAMED_GLYPH_COUNT = 0xffff - 258 + 1 + 1;
  /** CFF custom strings are numbered from SID 391 and a SID is 16 bits: .notdef plus 65,145 named glyphs. */
  const LAST_CFF_NAMED_GLYPH_COUNT = 0xffff - 391 + 1 + 1;
  const POST_VERSION_2 = 0x00020000;
  const POST_VERSION_3 = 0x00030000;
  const POST_HEADER_BYTES = 32;
  const LARGE_FONT_TIMEOUT_MS = 60_000;

  /** An SVG font whose `total` glyphs include the empty .notdef; every other glyph is a triangle. */
  function svgWithGlyphCount(total: number): string {
    const glyphs = ['<glyph unicode="A" horiz-adv-x="500" d="M0 0 H10 V10 Z"/>'];
    for (let i = 2; i < total; i++) glyphs.push('<glyph horiz-adv-x="500" d="M0 0 H10 V10 Z"/>');
    return svgWith(glyphs.join(''));
  }

  it(
    'TTF: names every glyph in post 2.0 up to the last count its 16-bit name indexes can address',
    async () => {
      const tables = readSfntTables(await convertSvg('ttf', svgWithGlyphCount(LAST_POST_NAMED_GLYPH_COUNT)));
      expect(readGlyphCount(tables)).toBe(LAST_POST_NAMED_GLYPH_COUNT);
      const post = requireTable(tables, 'post');
      expect(post.readUInt32BE(0)).toBe(POST_VERSION_2);
      const names = readPostCustomNames(tables);
      expect(names.size).toBe(LAST_POST_NAMED_GLYPH_COUNT - 1);
      expect(names.get(LAST_POST_NAMED_GLYPH_COUNT - 1)).toBe(`glyph${LAST_POST_NAMED_GLYPH_COUNT - 1}`);
    },
    LARGE_FONT_TIMEOUT_MS
  );

  it(
    'TTF and WOFF2: fall back to post 3.0 (no glyph names) instead of failing when the names no longer fit',
    async () => {
      for (const total of [LAST_POST_NAMED_GLYPH_COUNT + 1, MAX_GLYPHS_WITH_NOTDEF]) {
        const svg = svgWithGlyphCount(total);
        const ttf = readSfntTables(await convertSvg('ttf', svg));
        expect(readGlyphCount(ttf), `ttf ${total}`).toBe(total);
        const post = requireTable(ttf, 'post');
        expect(post.readUInt32BE(0), `ttf ${total}`).toBe(POST_VERSION_3);
        expect(post.length, `ttf ${total}`).toBe(POST_HEADER_BYTES);
        expect(readCmap(ttf).get(0x41), `ttf ${total}`).toBe(1);
      }
      const woff2 = unwrapWoff2(await convertSvg('woff2', svgWithGlyphCount(MAX_GLYPHS_WITH_NOTDEF)));
      expect(readGlyphCount(woff2)).toBe(MAX_GLYPHS_WITH_NOTDEF);
      expect(requireTable(woff2, 'post').readUInt32BE(0)).toBe(POST_VERSION_3);
    },
    LARGE_FONT_TIMEOUT_MS
  );

  it(
    'OTF: names every glyph in the CFF charset up to the last count its 16-bit string ids can address',
    async () => {
      const cff = decodeCff(requireTable(readSfntTables(await convertSvg('otf', svgWithGlyphCount(LAST_CFF_NAMED_GLYPH_COUNT))), 'CFF '));
      expect(cff.numGlyphs).toBe(LAST_CFF_NAMED_GLYPH_COUNT);
      expect(cffGlyphName(cff, LAST_CFF_NAMED_GLYPH_COUNT - 1)).toBe(`glyph${LAST_CFF_NAMED_GLYPH_COUNT - 1}`);
    },
    LARGE_FONT_TIMEOUT_MS
  );

  it(
    'OTF: rejects a font whose glyphs cannot all be named with a typed error, not a RangeError',
    async () => {
      for (const total of [LAST_CFF_NAMED_GLYPH_COUNT + 1, MAX_GLYPHS_WITH_NOTDEF]) {
        const failure = await failureOf(convertSvg('otf', svgWithGlyphCount(total)));
        expect(failure, `otf ${total}`).toBeInstanceOf(ConversionFailedError);
        expect(failure).not.toBeInstanceOf(FontOutlinesMissingError);
        expect((failure as Error).message, `otf ${total}`).toMatch(/CFF.*(name|string)/i);
      }
    },
    LARGE_FONT_TIMEOUT_MS
  );
});
