import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertFile } from '../src/lib/conversions';
import { Type1FontError } from '../src/lib/conversions/font-type1';
import { ConversionFailedError } from '../src/lib/types';
import {
  STANDARD_SUBRS,
  buildType1Font,
  type CharToken,
  type ExpectedContour,
  type ExpectedGlyph,
} from './helpers/type1-font-builder';
import {
  checkDirectoryIntegrity,
  cubicPoints,
  outlineBounds,
  readCffFont,
  readCmapSubtables,
  readHmtx,
  readNameRecords,
  readPostGlyphNames,
  readSfntFile,
  readTrueTypeOutlines,
  signedArea,
  type Polyline,
  type SfntFile,
} from './helpers/sfnt-outline-reader';

/**
 * Adobe Type 1 (PFA / PFB) to TrueType / OpenType conversion.
 *
 * Inputs come from tests/helpers/type1-font-builder.ts, an independent writer built from the Type 1
 * specification. Oracles: fontconfig / FreeType (fc-scan and ImageMagick rendering, which read the
 * Type 1 input and the converted output with their own code) and tests/helpers/sfnt-outline-reader.ts
 * (an independent SFNT / CFF reader), compared against hand-written glyph coordinates.
 */

const STRICT_MODE = process.env.ORACLE_STRICT_MODE === '1';

function hasTool(command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_FC_SCAN = hasTool('fc-scan', ['--version']);
const HAS_IMAGEMAGICK = hasTool('convert', ['-version']);

if (STRICT_MODE && !(HAS_FC_SCAN && HAS_IMAGEMAGICK)) {
  throw new Error('ORACLE_STRICT_MODE=1 requires fc-scan (fontconfig) and convert (ImageMagick with FreeType).');
}

const PAIRS: Array<['pfa' | 'pfb', 'ttf' | 'otf']> = [
  ['pfa', 'otf'],
  ['pfa', 'ttf'],
  ['pfb', 'otf'],
  ['pfb', 'ttf'],
];

const UNITS_PER_EM = 1000;
const SFNT_VERSION_TRUETYPE = 0x00010000;
const SFNT_VERSION_CFF = 0x4f54544f;
const WIN_PLATFORM = 3;
const NAME_FAMILY = 1;
const NAME_SUBFAMILY = 2;
const NAME_FULL = 4;
const NAME_VERSION = 5;
const NAME_POSTSCRIPT = 6;
const NAME_TYPOGRAPHIC_FAMILY = 16;
const NAME_TYPOGRAPHIC_SUBFAMILY = 17;
const NBSP = 0xa0;
const BBOX_TOLERANCE = 1.5;
const AREA_TOLERANCE = 0.005;
const FS_SELECTION_ITALIC = 0x01;
const FS_SELECTION_BOLD = 0x20;
const FS_SELECTION_REGULAR = 0x40;
const HOSTILE_DEADLINE_MS = 2000;
const RENDER_POINT_SIZE = 200;
const RENDER_CANVAS = '1000x320';
const RENDER_TEXT = 'HOEIAÁ';
const PIXEL_THRESHOLD = 128;
const MAX_RENDER_DIFF_FRACTION = 0.01;
const MIN_RENDER_INK = 30000;
const MIN_SAMPLE_INK = 20000;
const RENDER_INK_TOLERANCE = 0.05;
/** Code points FreeType adds beyond the Adobe Glyph List for the Bitstream fonts below. */
const FREETYPE_ONLY_CODE_POINTS = new Set([0x2c9, 0x3bc, 0x2215, 0x2219]);
const SAMPLE_POINT_SIZE = 90;
const SAMPLE_CANVAS = '1900x200';
const SYSTEM_TYPE1_DIR = '/usr/share/fonts/X11/Type1';

let workDir = '';

beforeAll(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'easyconvert-type1-'));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeWork(name: string, data: Buffer): string {
  const file = path.join(workDir, name);
  writeFileSync(file, data);
  return file;
}

// ---------------------------------------------------------------------------------------------
// Oracles
// ---------------------------------------------------------------------------------------------

interface ScanResult {
  family: string;
  style: string;
  fontformat: string;
  postscriptname: string;
  codePoints: Set<number>;
}

function parseCharset(charset: string): Set<number> {
  const points = new Set<number>();
  for (const token of charset.split(' ').filter(Boolean)) {
    const [first, last = first] = token.split('-');
    for (let cp = Number.parseInt(first, 16); cp <= Number.parseInt(last, 16); cp++) points.add(cp);
  }
  return points;
}

function scan(file: string): ScanResult {
  const out = execFileSync(
    'fc-scan',
    ['--format', '%{family[0]}|%{style[0]}|%{fontformat}|%{postscriptname}|%{charset}', file],
    { encoding: 'utf8' }
  ).trim();
  const [family, style, fontformat, postscriptname, charset] = out.split('|');
  return { family, style, fontformat, postscriptname, codePoints: parseCharset(charset) };
}

function renderGray(fontFile: string, text: string, pointSize = RENDER_POINT_SIZE, canvas = RENDER_CANVAS): Buffer {
  return execFileSync(
    'convert',
    [
      '-background',
      'white',
      '-fill',
      'black',
      '-font',
      fontFile,
      '-pointsize',
      String(pointSize),
      `label:${text}`,
      '-gravity',
      'NorthWest',
      '-extent',
      canvas,
      '-depth',
      '8',
      'gray:-',
    ],
    { maxBuffer: 1 << 26 }
  );
}

function inkPixels(gray: Buffer): number {
  let ink = 0;
  for (const value of gray) if (value < PIXEL_THRESHOLD) ink++;
  return ink;
}

function differingPixels(a: Buffer, b: Buffer): number {
  expect(b.length).toBe(a.length);
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > PIXEL_THRESHOLD) diff++;
  return diff;
}

function flattenExpected(contours: ExpectedContour[]): Polyline[] {
  return contours.map((contour) => {
    const poly: Polyline = [contour.start];
    let current = contour.start;
    for (const segment of contour.segments) {
      if (segment.kind === 'L') {
        current = [segment.x, segment.y];
        poly.push(current);
      } else {
        const end: [number, number] = [segment.x3, segment.y3];
        poly.push(...cubicPoints(current, [segment.x1, segment.y1], [segment.x2, segment.y2], end));
        current = end;
      }
    }
    if (current[0] === contour.start[0] && current[1] === contour.start[1]) poly.pop();
    return poly;
  });
}

function distanceToSegment(px: number, py: number, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / lengthSquared));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

function distanceToOutline(point: [number, number], outline: Polyline[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const poly of outline) {
    for (let i = 0; i < poly.length; i++) {
      best = Math.min(best, distanceToSegment(point[0], point[1], poly[i], poly[(i + 1) % poly.length]));
    }
  }
  return best;
}

/** Largest distance from a vertex of one outline to the other outline, in both directions. */
function outlineDeviation(a: Polyline[], b: Polyline[]): number {
  let worst = 0;
  for (const point of a.flat()) worst = Math.max(worst, distanceToOutline(point, b));
  for (const point of b.flat()) worst = Math.max(worst, distanceToOutline(point, a));
  return worst;
}

function netArea(outline: Polyline[]): number {
  return outline.reduce((sum, poly) => sum + signedArea(poly), 0);
}

interface OutputFont {
  file: SfntFile;
  glyphNames: string[];
  outlines: Polyline[][];
  /** Advance widths carried by the outlines themselves (CFF only). */
  charstringWidths: number[] | null;
}

function readOutput(buffer: Buffer, target: 'ttf' | 'otf'): OutputFont {
  const file = readSfntFile(buffer);
  if (target === 'ttf') {
    return { file, glyphNames: readPostGlyphNames(file.table('post')), outlines: readTrueTypeOutlines(file), charstringWidths: null };
  }
  const cff = readCffFont(file.table('CFF '));
  return { file, glyphNames: cff.glyphNames, outlines: cff.outlines, charstringWidths: cff.widths };
}

function winNames(file: SfntFile): Map<number, string> {
  const names = new Map<number, string>();
  for (const record of readNameRecords(file.table('name'))) {
    if (record.platform === WIN_PLATFORM) names.set(record.id, record.text);
  }
  return names;
}

function unicodeMap(file: SfntFile): Map<number, number> {
  const windows = readCmapSubtables(file.table('cmap')).find((t) => t.platform === WIN_PLATFORM && t.encoding === 1);
  if (!windows) throw new Error('cmap has no Windows Unicode BMP subtable');
  return windows.map;
}

async function convert(buffer: Buffer, source: string, target: string): Promise<Buffer> {
  const result = await convertFile(buffer, source, target, {}, `sample.${source}`);
  expect(result.filename).toBe(`sample.${target}`);
  return result.buffer;
}

// ---------------------------------------------------------------------------------------------
// The four registry pairs
// ---------------------------------------------------------------------------------------------

describe('Type 1 to TrueType / OpenType conversion', () => {
  const built = buildType1Font();
  const expectedByName = new Map<string, ExpectedGlyph>(built.expectedGlyphs.map((g) => [g.name, g]));
  const expectedCodePoints = new Set<number>([NBSP, ...built.expectedGlyphs.filter((g) => g.unicode >= 0).map((g) => g.unicode)]);

  describe.each(PAIRS)('%s -> %s', (source, target) => {
    let output: Buffer;
    let font: OutputFont;
    const inputBuffer = source === 'pfa' ? built.pfa : built.pfb;

    beforeAll(async () => {
      output = await convert(inputBuffer, source, target);
      font = readOutput(output, target);
    });

    it('writes the right SFNT flavor with a sorted directory and valid checksums', () => {
      expect(font.file.version).toBe(target === 'ttf' ? SFNT_VERSION_TRUETYPE : SFNT_VERSION_CFF);
      const required = target === 'ttf'
        ? ['OS/2', 'cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post']
        : ['CFF ', 'OS/2', 'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'post'];
      expect(font.file.entries.map((e) => e.tag)).toEqual(required);
      expect(checkDirectoryIntegrity(font.file)).toEqual([]);
    });

    it('keeps the glyph order and the hsbw advances in hmtx, with lsb at the outline xMin', () => {
      expect(font.glyphNames).toEqual(built.expectedGlyphs.map((g) => g.name));
      const head = font.file.table('head');
      expect(head.readUInt16BE(18)).toBe(UNITS_PER_EM);
      const hhea = font.file.table('hhea');
      expect(hhea.readUInt16BE(34)).toBe(built.expectedGlyphs.length);
      expect(font.file.table('maxp').readUInt16BE(4)).toBe(built.expectedGlyphs.length);
      const metrics = readHmtx(font.file.table('hmtx'), hhea.readUInt16BE(34));
      built.expectedGlyphs.forEach((glyph, gid) => {
        expect(metrics[gid].advance, `advance of ${glyph.name}`).toBe(glyph.advance);
        expect(metrics[gid].lsb, `lsb of ${glyph.name}`).toBe(glyph.bbox === null ? 0 : glyph.bbox[0]);
      });
      if (font.charstringWidths !== null) {
        expect(font.charstringWidths).toEqual(built.expectedGlyphs.map((g) => g.advance));
      }
      expect(hhea.readInt16BE(4)).toBe(790);
      expect(hhea.readInt16BE(6)).toBe(-20);
      expect([head.readInt16BE(36), head.readInt16BE(38), head.readInt16BE(40), head.readInt16BE(42)]).toEqual([20, -20, 680, 790]);
    });

    it('maps Adobe Glyph List names to Unicode in cmap', () => {
      const map = unicodeMap(font.file);
      expect(new Set(map.keys())).toEqual(expectedCodePoints);
      for (const glyph of built.expectedGlyphs.filter((g) => g.unicode >= 0)) {
        expect(font.glyphNames[map.get(glyph.unicode) as number], `U+${glyph.unicode.toString(16)}`).toBe(glyph.name);
      }
      expect(map.get(NBSP)).toBe(map.get(0x20));
      const unicodeSubtable = readCmapSubtables(font.file.table('cmap')).find((t) => t.platform === 0);
      expect(unicodeSubtable?.map).toEqual(map);
    });

    it('reproduces every glyph outline: bounds, area, and contour direction', () => {
      font.glyphNames.forEach((name, gid) => {
        const expected = expectedByName.get(name) as ExpectedGlyph;
        const actual = font.outlines[gid];
        if (expected.bbox === null) {
          expect(actual, `${name} has no outline`).toEqual([]);
          return;
        }
        const bounds = outlineBounds(actual) as [number, number, number, number];
        bounds.forEach((value, i) => {
          expect(Math.abs(value - (expected.bbox as number[])[i]), `${name} bound ${i}: ${value}`).toBeLessThanOrEqual(BBOX_TOLERANCE);
        });
        const expectedArea = Math.abs(netArea(flattenExpected(expected.contours)));
        const actualSigned = netArea(actual);
        expect(Math.abs(Math.abs(actualSigned) - expectedArea) / expectedArea, `${name} area ${actualSigned}`).toBeLessThan(AREA_TOLERANCE);
        expect(outlineDeviation(actual, flattenExpected(expected.contours)), `${name} shape deviation`).toBeLessThan(BBOX_TOLERANCE);
        // Each contour must sit where the hand-written coordinates put it (this pins seac offsets and flex).
        const expectedContours = flattenExpected(expected.contours).map((poly) => outlineBounds([poly]) as number[]);
        const actualContours = actual.map((poly) => outlineBounds([poly]) as number[]);
        expect(actualContours.length, `${name} contour count`).toBe(expectedContours.length);
        const byBounds = (a: number[], b: number[]): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];
        expectedContours.sort(byBounds);
        actualContours.sort(byBounds);
        expectedContours.forEach((box, c) => {
          box.forEach((value, i) => {
            expect(Math.abs(actualContours[c][i] - value), `${name} contour ${c} bound ${i}`).toBeLessThanOrEqual(BBOX_TOLERANCE);
          });
        });
        // TrueType fills outer contours clockwise; PostScript outlines run counter-clockwise.
        expect(Math.sign(actualSigned), `${name} direction`).toBe(target === 'ttf' ? -1 : 1);
      });
    });

    it('carries the font dictionary into name, OS/2, post, and hhea', () => {
      const names = winNames(font.file);
      expect(names.get(NAME_FAMILY)).toBe(built.familyName);
      expect(names.get(NAME_SUBFAMILY)).toBe('Regular');
      expect(names.get(NAME_FULL)).toBe(`${built.familyName} Regular`);
      expect(names.get(NAME_POSTSCRIPT)).toBe(built.fontName);
      expect(names.get(NAME_VERSION)).toBe('Version 001.000');

      const os2 = font.file.table('OS/2');
      expect(os2.readUInt16BE(0)).toBe(4);
      expect(os2.readUInt16BE(4)).toBe(400);
      expect(os2.readUInt16BE(62) & FS_SELECTION_REGULAR).toBe(FS_SELECTION_REGULAR);
      expect(os2.readUInt16BE(64)).toBe(0x20);
      expect(os2.readUInt16BE(66)).toBe(0xc1);
      expect(os2.readInt16BE(88)).toBe(700);
      const advances = built.expectedGlyphs.map((g) => g.advance).filter((w) => w > 0);
      expect(os2.readInt16BE(2)).toBe(Math.round(advances.reduce((a, b) => a + b, 0) / advances.length));

      const post = font.file.table('post');
      expect(post.readUInt32BE(0)).toBe(target === 'ttf' ? 0x00020000 : 0x00030000);
      expect(post.readInt32BE(4)).toBe(0);
      expect(post.readInt16BE(8)).toBe(-100);
      expect(post.readInt16BE(10)).toBe(50);
      expect(post.readUInt32BE(12)).toBe(0);
    });

    it.skipIf(!HAS_FC_SCAN)('is read by FreeType as the same family, style, and code points as the input', () => {
      const inputScan = scan(writeWork(`input-${source}-${target}.${source}`, inputBuffer));
      const outputScan = scan(writeWork(`output-${source}.${target}`, output));
      expect(inputScan.fontformat).toBe('Type 1');
      expect(outputScan.fontformat).toBe(target === 'ttf' ? 'TrueType' : 'CFF');
      expect(outputScan.family).toBe(built.familyName);
      expect(outputScan.family).toBe(inputScan.family);
      expect(outputScan.style).toBe('Regular');
      expect(outputScan.style).toBe(inputScan.style);
      expect(outputScan.postscriptname).toBe(built.fontName);
      expect(outputScan.codePoints).toEqual(inputScan.codePoints);
      expect(outputScan.codePoints).toEqual(expectedCodePoints);
    });

    it.skipIf(!HAS_IMAGEMAGICK)('renders like the Type 1 input does under FreeType', () => {
      const inputFile = writeWork(`render-in-${source}-${target}.${source}`, inputBuffer);
      const outputFile = writeWork(`render-out-${source}.${target}`, output);

      // The E glyph is a solid slab, so its ink area proves the font loaded instead of a fallback face.
      const slab = expectedByName.get('E') as ExpectedGlyph;
      const slabArea = Math.abs(netArea(flattenExpected(slab.contours))) * (RENDER_POINT_SIZE / UNITS_PER_EM) ** 2;
      for (const file of [inputFile, outputFile]) {
        expect(Math.abs(inkPixels(renderGray(file, 'E')) - slabArea) / slabArea).toBeLessThan(RENDER_INK_TOLERANCE);
      }

      const reference = renderGray(inputFile, RENDER_TEXT);
      const converted = renderGray(outputFile, RENDER_TEXT);
      const ink = inkPixels(reference);
      expect(ink).toBeGreaterThan(MIN_RENDER_INK);
      expect(differingPixels(reference, converted) / ink).toBeLessThan(MAX_RENDER_DIFF_FRACTION);
    });
  });

  it('produces identical output from the PFA and PFB containers', async () => {
    for (const target of ['ttf', 'otf']) {
      const fromPfa = await convert(built.pfa, 'pfa', target);
      const fromPfb = await convert(built.pfb, 'pfb', target);
      expect(fromPfa.equals(fromPfb)).toBe(true);
    }
  });

  it('is independent of lenIV, the Encoding form, and charstring encryption', async () => {
    const reference = await convert(built.pfb, 'pfb', 'otf');
    const referenceTtf = await convert(built.pfb, 'pfb', 'ttf');
    for (const lenIV of [0, 1, 7, -1]) {
      const variant = buildType1Font({ lenIV });
      expect((await convert(variant.pfb, 'pfb', 'otf')).equals(reference), `lenIV ${lenIV} otf`).toBe(true);
      expect((await convert(variant.pfa, 'pfa', 'ttf')).equals(referenceTtf), `lenIV ${lenIV} ttf`).toBe(true);
    }
    const standard = buildType1Font({ standardEncoding: true });
    expect((await convert(standard.pfb, 'pfb', 'otf')).equals(reference)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Naming and style
// ---------------------------------------------------------------------------------------------

describe('Type 1 naming and style metadata', () => {
  it('maps Bold and an italic angle to RIBBI style, macStyle, OS/2, post, and caret slope', async () => {
    const built = buildType1Font({
      fontName: 'EasyConvertT1Test-BoldItalic',
      weight: 'Bold',
      italicAngle: -12,
      fullName: 'EasyConvert T1 Test Bold Italic',
    });
    const buffer = await convert(built.pfb, 'pfb', 'ttf');
    const file = readSfntFile(buffer);
    const names = winNames(file);
    expect(names.get(NAME_FAMILY)).toBe(built.familyName);
    expect(names.get(NAME_SUBFAMILY)).toBe('Bold Italic');
    expect(names.get(NAME_FULL)).toBe('EasyConvert T1 Test Bold Italic');
    expect(names.get(NAME_POSTSCRIPT)).toBe('EasyConvertT1Test-BoldItalic');
    expect(file.table('head').readUInt16BE(44)).toBe(3);
    const os2 = file.table('OS/2');
    expect(os2.readUInt16BE(4)).toBe(700);
    expect(os2.readUInt16BE(62) & (FS_SELECTION_BOLD | FS_SELECTION_ITALIC | FS_SELECTION_REGULAR)).toBe(FS_SELECTION_BOLD | FS_SELECTION_ITALIC);
    expect(file.table('post').readInt32BE(4)).toBe(-12 * 0x10000);
    const hhea = file.table('hhea');
    expect(hhea.readInt16BE(18)).toBe(Math.round(Math.cos((12 * Math.PI) / 180) * 1000));
    expect(hhea.readInt16BE(20)).toBe(Math.round(Math.sin((12 * Math.PI) / 180) * 1000));
    expect(checkDirectoryIntegrity(file)).toEqual([]);
  });

  it.skipIf(!HAS_FC_SCAN)('is read by FreeType with the same Bold Italic style and family as the input', async () => {
    const built = buildType1Font({
      fontName: 'EasyConvertT1Test-BoldItalic',
      weight: 'Bold',
      italicAngle: -12,
      fullName: 'EasyConvert T1 Test Bold Italic',
    });
    const input = scan(writeWork('bolditalic.pfb', built.pfb));
    for (const target of ['ttf', 'otf'] as const) {
      const output = scan(writeWork(`bolditalic.${target}`, await convert(built.pfb, 'pfb', target)));
      expect(input.style).toBe('Bold Italic');
      expect(output.style).toBe(input.style);
      expect(output.family).toBe(input.family);
      expect(output.postscriptname).toBe('EasyConvertT1Test-BoldItalic');
    }
  });

  it('keeps non-RIBBI weights as typographic family and subfamily names', async () => {
    const built = buildType1Font({ fontName: 'EasyConvertT1Test-Light', weight: 'Light', fullName: 'EasyConvert T1 Test Light' });
    const file = readSfntFile(await convert(built.pfa, 'pfa', 'otf'));
    const names = winNames(file);
    expect(names.get(NAME_FAMILY)).toBe('EasyConvert T1 Test Light');
    expect(names.get(NAME_SUBFAMILY)).toBe('Regular');
    expect(names.get(NAME_TYPOGRAPHIC_FAMILY)).toBe(built.familyName);
    expect(names.get(NAME_TYPOGRAPHIC_SUBFAMILY)).toBe('Light');
    expect(file.table('OS/2').readUInt16BE(4)).toBe(300);
  });
});

// ---------------------------------------------------------------------------------------------
// Glyph name to Unicode rules
// ---------------------------------------------------------------------------------------------

describe('Type 1 glyph name to Unicode mapping', () => {
  const square: CharToken[] = [0, 500, 'hsbw', 0, 0, 'rmoveto', 100, 'hlineto', 100, 'vlineto', -100, 'hlineto', 'closepath', 'endchar'];

  it('handles uniXXXX, uXXXXX, suffixed variants, and the Encoding fallback for unnamed glyphs', async () => {
    const built = buildType1Font({
      charStrings: {
        uni20AC: square,
        u1F600: square,
        'H.swash': square,
        'B.alt': square,
        foo: square,
        f_i: square,
        x_y: square,
      },
      encoding: [
        [66, 'foo'],
        [72, 'H'],
      ],
    });
    const file = readSfntFile(await convert(built.pfb, 'pfb', 'ttf'));
    const names = readPostGlyphNames(file.table('post'));
    const subtables = readCmapSubtables(file.table('cmap'));
    const bmp = subtables.find((t) => t.platform === WIN_PLATFORM && t.encoding === 1);
    const full = subtables.find((t) => t.platform === WIN_PLATFORM && t.encoding === 10);
    const nameAt = (map: Map<number, number> | undefined, cp: number): string | undefined => names[map?.get(cp) ?? -1];

    expect(nameAt(bmp?.map, 0x20ac)).toBe('uni20AC');
    expect(nameAt(bmp?.map, 0x48)).toBe('H');
    expect(nameAt(bmp?.map, 0x42)).toBe('B.alt');
    expect(nameAt(bmp?.map, 0xf042)).toBe('foo');
    expect(bmp?.map.has(0x1f600)).toBe(false);
    expect(nameAt(full?.map, 0x1f600)).toBe('u1F600');
    expect(nameAt(full?.map, 0x20ac)).toBe('uni20AC');
    expect(nameAt(bmp?.map, 0xfb01)).toBe('f_i');
    expect([...(bmp?.map.values() ?? [])].map((gid) => names[gid])).not.toContain('x_y');
    expect(checkDirectoryIntegrity(file)).toEqual([]);
  });

  it.skipIf(!HAS_FC_SCAN)('exposes the mapped code points to FreeType, including astral and symbol-block ones', async () => {
    const built = buildType1Font({
      charStrings: { uni20AC: square, u1F600: square, foo: square },
      encoding: [[66, 'foo']],
    });
    const output = scan(writeWork('names.ttf', await convert(built.pfb, 'pfb', 'ttf')));
    expect([0x20ac, 0x1f600, 0xf042].filter((cp) => output.codePoints.has(cp))).toEqual([0x20ac, 0x1f600, 0xf042]);
  });
});

// ---------------------------------------------------------------------------------------------
// Hostile and malformed inputs
// ---------------------------------------------------------------------------------------------

async function expectRejected(buffer: Buffer, source: 'pfa' | 'pfb', target: 'ttf' | 'otf', pattern: RegExp): Promise<void> {
  const started = performance.now();
  let caught: unknown;
  try {
    await convertFile(buffer, source, target, {}, `hostile.${source}`);
  } catch (error) {
    caught = error;
  }
  const elapsed = performance.now() - started;
  expect(caught, 'conversion must throw').toBeInstanceOf(Type1FontError);
  expect(caught).toBeInstanceOf(ConversionFailedError);
  expect((caught as Error).message).toMatch(pattern);
  expect(elapsed).toBeLessThan(HOSTILE_DEADLINE_MS);
}

describe('Type 1 hostile and malformed input fails closed', () => {
  const good = buildType1Font();
  const cleartextEnd = 6 + good.pfb.readUInt32LE(2);

  it.each(['otf', 'ttf'] as const)('rejects a PFB truncated inside a segment header and body (%s)', async (target) => {
    await expectRejected(good.pfb.subarray(0, 5), 'pfb', target, /Truncated PFB segment header/);
    await expectRejected(good.pfb.subarray(0, 120), 'pfb', target, /declares \d+ bytes but the file ends first/);
    await expectRejected(good.pfb.subarray(0, cleartextEnd + 100), 'pfb', target, /declares \d+ bytes but the file ends first/);
  });

  it('rejects a bad segment type, a bad marker, and an absurd segment length', async () => {
    const badType = Buffer.from(good.pfb);
    badType[1] = 0x07;
    await expectRejected(badType, 'pfb', 'ttf', /Invalid PFB segment type 7/);

    const badMarker = Buffer.from(good.pfb);
    badMarker[cleartextEnd] = 0x81;
    await expectRejected(badMarker, 'pfb', 'otf', /Invalid PFB segment marker 0x81/);

    const hugeLength = Buffer.from(good.pfb);
    hugeLength.writeUInt32LE(0xffffffff, 2);
    await expectRejected(hugeLength, 'pfb', 'ttf', /declares 4294967295 bytes/);
  });

  it('rejects a PFB without a binary segment and a PFB cut inside its trailer segment', async () => {
    const asciiOnly = Buffer.concat([good.pfb.subarray(0, cleartextEnd), Buffer.from([0x80, 0x03])]);
    await expectRejected(asciiOnly, 'pfb', 'ttf', /no binary \(eexec\) segment/);
    await expectRejected(good.pfb.subarray(0, good.pfb.length - 20), 'pfb', 'otf', /declares \d+ bytes but the file ends first/);
  });

  it('rejects a font with no eexec section, plain text, and a bare CFF named like a Type 1 font', async () => {
    const noEexec = Buffer.from(good.pfa.toString('latin1').replace('currentfile eexec', 'currentfile xxxxx'), 'latin1');
    await expectRejected(noEexec, 'pfa', 'ttf', /no "currentfile eexec" section/);
    await expectRejected(Buffer.from('this is not a font'), 'pfa', 'otf', /no "currentfile eexec" section/);
    await expectRejected(Buffer.from([1, 0, 4, 2, 0, 1, 1, 1, 14, 67, 104, 114, 111, 109]), 'pfb', 'ttf', /no "currentfile eexec" section/);
  });

  it('rejects broken PFA hexadecimal data', async () => {
    const text = good.pfa.toString('latin1');
    const hexStart = text.indexOf('currentfile eexec') + 'currentfile eexec\n'.length;
    const badDigit = Buffer.from(text.slice(0, hexStart + 10) + 'Z' + text.slice(hexStart + 11), 'latin1');
    await expectRejected(badDigit, 'pfa', 'ttf', /non-hexadecimal/);
    const oddDigits = Buffer.from(text.slice(0, hexStart + 10) + text.slice(hexStart + 11), 'latin1');
    await expectRejected(oddDigits, 'pfa', 'otf', /odd number of hexadecimal digits/);
  });

  it('rejects an eexec section cut off before the charstrings end', async () => {
    const text = good.pfa.toString('latin1');
    const hexStart = text.indexOf('currentfile eexec') + 'currentfile eexec\n'.length;
    const hexDigits = text.slice(hexStart).replace(/\s/g, '');
    const cut = Buffer.from(`${text.slice(0, hexStart)}${hexDigits.slice(0, 1200)}\n`, 'latin1');
    await expectRejected(cut, 'pfa', 'ttf', /runs past the end|not terminated|has no/);
  });

  it('rejects an eexec section too short for a private dictionary', async () => {
    const text = good.pfa.toString('latin1');
    const hexStart = text.indexOf('currentfile eexec') + 'currentfile eexec\n'.length;
    const header = text.slice(0, hexStart);
    const digits = text.slice(hexStart).replace(/\s/g, '');
    await expectRejected(Buffer.from(`${header}${digits.slice(0, 8)}\ncleartomark\n`, 'latin1'), 'pfa', 'ttf', /eexec section is too short/);
    await expectRejected(Buffer.from(`${header}${digits.slice(0, 16)}\ncleartomark\n`, 'latin1'), 'pfa', 'otf', /has no \/CharStrings/);
  });

  it('rejects charstring operand stack overflow', async () => {
    const font = buildType1Font({ charStrings: { H: [80, 700, 'hsbw', ...Array<number>(25).fill(1), 'endchar'] } });
    await expectRejected(font.pfb, 'pfb', 'ttf', /Glyph H: operand stack overflow/);
  });

  it('rejects stack underflow, a missing endchar, and path operators before hsbw', async () => {
    await expectRejected(buildType1Font({ charStrings: { H: [80, 700, 'hsbw', 5, 'rlineto', 'endchar'] } }).pfb, 'pfb', 'otf', /needs 2 operands, found 1/);
    await expectRejected(buildType1Font({ charStrings: { H: [80, 700, 'hsbw', 0, 0, 'rmoveto'] } }).pfa, 'pfa', 'ttf', /ended without endchar/);
    await expectRejected(buildType1Font({ charStrings: { H: [0, 0, 'rmoveto', 'endchar'] } }).pfb, 'pfb', 'ttf', /path operator before hsbw/);
    await expectRejected(buildType1Font({ charStrings: { H: [80, 700, 'hsbw', 1, 0, 'div', 'endchar'] } }).pfb, 'pfb', 'ttf', /division by zero/);
  });

  it('rejects infinite callsubr recursion at the nesting limit', async () => {
    const recursive = buildType1Font({
      subrs: [...STANDARD_SUBRS, [6, 'callsubr', 'return']],
      charStrings: { H: [80, 700, 'hsbw', 6, 'callsubr', 'endchar'] },
    });
    await expectRejected(recursive.pfb, 'pfb', 'otf', /subroutine nesting is too deep/);
  });

  it('rejects a call to an undefined subroutine and a subroutine without return', async () => {
    await expectRejected(buildType1Font({ charStrings: { H: [80, 700, 'hsbw', 99, 'callsubr', 'endchar'] } }).pfb, 'pfb', 'ttf', /undefined subroutine 99/);
    const noReturn = buildType1Font({
      subrs: [...STANDARD_SUBRS, [1, 2, 'rmoveto']],
      charStrings: { H: [80, 700, 'hsbw', 6, 'callsubr', 'endchar'] },
    });
    await expectRejected(noReturn.pfb, 'pfb', 'ttf', /subroutine ended without return/);
  });

  it('stops exponential subroutine fan-out with the operation limit', async () => {
    const fanOut = (next: number): CharToken[] => [...Array.from({ length: 20 }, () => [next, 'callsubr'] as CharToken[]).flat(), 'return'];
    const subrs: CharToken[][] = [...STANDARD_SUBRS.map((s) => [...s])];
    for (let level = 6; level <= 14; level++) subrs.push(fanOut(level + 1));
    subrs.push(['return']);
    const bomb = buildType1Font({ subrs, charStrings: { H: [80, 700, 'hsbw', 6, 'callsubr', 'endchar'] } });
    await expectRejected(bomb.pfb, 'pfb', 'ttf', /exceeds the operation limit/);
  });

  it('rejects an absurd /Subrs count and an absurd /CharStrings count without allocating', async () => {
    await expectRejected(buildType1Font({ declaredSubrCount: 2_000_000_000 }).pfb, 'pfb', 'ttf', /\/Subrs count 2000000000 is outside/);
    await expectRejected(buildType1Font({ declaredSubrCount: 3 }).pfa, 'pfa', 'otf', /outside the declared \/Subrs count 3/);
    await expectRejected(buildType1Font({ declaredGlyphCount: 999_999_999 }).pfb, 'pfb', 'ttf', /\/CharStrings count 999999999 is outside/);
    await expectRejected(buildType1Font({ declaredGlyphCount: 2 }).pfb, 'pfb', 'ttf', /More charstrings than declared/);
  });

  it('rejects flex misuse, unsupported OtherSubrs, and malformed seac', async () => {
    const shortFlex: CharToken[] = [80, 700, 'hsbw', 0, 0, 'rmoveto', 1, 'callsubr', 10, 0, 'rmoveto', 2, 'callsubr', 20, 450, 0, 0, 'callsubr', 'endchar'];
    await expectRejected(buildType1Font({ charStrings: { H: shortFlex } }).pfb, 'pfb', 'ttf', /flex sequence does not hold seven points/);
    await expectRejected(buildType1Font({ charStrings: { H: [80, 700, 'hsbw', 0, 20, 'callothersubr', 'endchar'] } }).pfb, 'pfb', 'ttf', /unsupported OtherSubrs entry 20/);
    await expectRejected(buildType1Font({ charStrings: { H: [80, 700, 'hsbw', 'pop', 'endchar'] } }).pfb, 'pfb', 'ttf', /pop on an empty PostScript stack/);
    await expectRejected(buildType1Font({ charStrings: { Aacute: [20, 700, 'hsbw', 100, 180, 30, 65, 7, 'seac'] } }).pfb, 'pfb', 'ttf', /outside StandardEncoding/);
    await expectRejected(buildType1Font({ charStrings: { Aacute: [20, 700, 'hsbw', 100, 180, 30, 65, 195, 'seac'] } }).pfb, 'pfb', 'ttf', /seac references missing glyph circumflex/);
    const nested: CharToken[] = [20, 700, 'hsbw', 100, 180, 30, 65, 194, 'seac'];
    await expectRejected(buildType1Font({ charStrings: { A: nested } }).pfb, 'pfb', 'ttf', /nested seac/);
  });
});

// ---------------------------------------------------------------------------------------------
// A real-world Type 1 face, when the system ships one
// ---------------------------------------------------------------------------------------------

describe('Type 1 conversion of an installed real-world font', () => {
  const REAL_FONTS = ['c0648bt_.pfb', 'c0633bt_.pfb'];
  const available = REAL_FONTS.filter((f) => existsSync(path.join(SYSTEM_TYPE1_DIR, f)));

  it.skipIf(available.length === 0 || !HAS_FC_SCAN || !HAS_IMAGEMAGICK)(
    'matches FreeType on names, code points, and rendering for every installed sample',
    async () => {
      expect(available.length).toBeGreaterThan(0);
      for (const name of available) {
        const input = readFileSync(path.join(SYSTEM_TYPE1_DIR, name));
        const inputScan = scan(path.join(SYSTEM_TYPE1_DIR, name));
        for (const target of ['ttf', 'otf'] as const) {
          const output = await convert(input, 'pfb', target);
          expect(checkDirectoryIntegrity(readSfntFile(output))).toEqual([]);
          const outputFile = writeWork(`real-${name}.${target}`, output);
          const outputScan = scan(outputFile);
          expect(outputScan.family).toBe(inputScan.family);
          expect(outputScan.style).toBe(inputScan.style);
          expect(outputScan.postscriptname).toBe(inputScan.postscriptname);

          // No invented code points, and anything FreeType maps that we do not is a known FreeType-only alias.
          for (const cp of outputScan.codePoints) expect(inputScan.codePoints.has(cp), `U+${cp.toString(16)}`).toBe(true);
          const missing = [...inputScan.codePoints].filter((cp) => !outputScan.codePoints.has(cp));
          for (const cp of missing) expect(FREETYPE_ONLY_CODE_POINTS.has(cp), `U+${cp.toString(16)} missing`).toBe(true);
          expect(outputScan.codePoints.size).toBeGreaterThan(200);

          const sample = 'Hamburgefonstiv 0123 ÀÉÎõü ﬁ Œšß ÅøÆ';
          const reference = renderGray(path.join(SYSTEM_TYPE1_DIR, name), sample, SAMPLE_POINT_SIZE, SAMPLE_CANVAS);
          const converted = renderGray(outputFile, sample, SAMPLE_POINT_SIZE, SAMPLE_CANVAS);
          const ink = inkPixels(reference);
          expect(ink).toBeGreaterThan(MIN_SAMPLE_INK);
          const limit = target === 'otf' ? 0.01 : 0.06;
          expect(differingPixels(reference, converted) / ink, `${name} -> ${target}`).toBeLessThan(limit);
        }
      }
    }
  );
});
