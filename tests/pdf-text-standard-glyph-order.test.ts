import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { withFontProgramToUnicode } from '../src/lib/conversions/pdf-font-tounicode';
import { assertPdfStreamsWithinLimits } from '../src/lib/conversions/pdf-stream-guard';
import { coreFontOf, standardOrderTexts } from '../src/lib/conversions/standard-font-glyph-order';
import { buildCff, cs } from './helpers/cff-font-builder';
import { hasControlCharacters } from './helpers/pdf-text-metrics';
import { extraObjectNumber, rawPdf } from './helpers/raw-pdf';
import { requireRealworldSample } from './helpers/realworld-sample';
import { withoutTables } from './helpers/sfnt-tables';

/**
 * Composite fonts whose CIDs are the glyph ids of an Arial or Times New Roman font and whose embedded program names no
 * glyph (a TrueType program without `cmap` and `post`, or a CID-keyed CFF program): print-to-PDF distillers wrote them.
 * Their text comes from the standard Macintosh glyph order, only when the font's name and every /W width of the table's
 * CIDs show the font to be the one named.
 *
 * The /W widths of the hand-written PDFs are those Acrobat Distiller wrote for the same glyphs in govdocs1-003205.pdf
 * (Arial, Arial Bold) and cc-6400269.pdf (Times New Roman); the CIDs are the glyph ids of the sentence's characters in the
 * Macintosh order (space 3, digits 19 to 28, capitals 36 to 61, small letters 68 to 93, micro sign 151), and the expected
 * text is the sentence the content stream shows. The pdfjs-dist tables are read from the build the reader runs.
 */

const DEJAVU = fs.readFileSync(path.join(__dirname, 'fixtures', 'woff2', 'dejavu-sans-latin.ttf'));
/** A TrueType program that names no glyph: the DejaVu Sans subset with its `cmap` and `post` tables hidden. */
const BARE_TRUETYPE = withoutTables(DEJAVU, 'cmap', 'post');
const PDFJS_WORKER = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'legacy', 'build', 'pdf.worker.mjs');

const ARIAL_SENTENCE = 'Report No. 02-083 (5 µm)';
/** The same as the reader writes it: its text is NFKC-folded, which makes the micro sign a Greek mu. */
const ARIAL_TEXT = ARIAL_SENTENCE.normalize('NFKC');
const ARIAL_CIDS = [53, 72, 83, 82, 85, 87, 3, 49, 82, 17, 3, 19, 21, 16, 19, 27, 22, 3, 11, 24, 3, 151, 80, 12];
/** /W of the Arial fonts of govdocs1-003205.pdf for those CIDs. */
const ARIAL_WIDTHS = new Map([
  [3, 278], [11, 333], [12, 333], [16, 333], [17, 278], [19, 556], [21, 556], [22, 556], [24, 556], [27, 556], [49, 722], [53, 722],
  [72, 556], [80, 833], [82, 556], [83, 556], [85, 333], [87, 278], [151, 576],
]);
const ARIAL_BOLD_SENTENCE = 'Report No. 02-083';
/** /W of the Arial Bold fonts of govdocs1-003205.pdf for the CIDs of ARIAL_BOLD_SENTENCE. */
const ARIAL_BOLD_WIDTHS = new Map([
  [3, 278], [16, 333], [17, 278], [19, 556], [21, 556], [22, 556], [27, 556], [49, 722], [53, 722], [72, 556], [82, 611], [83, 611],
  [85, 389], [87, 333],
]);
const TIMES_SENTENCE = '(1) 2,3-4/5: 6.7!';
/** /W of the Times New Roman font of cc-6400269.pdf for the CIDs of TIMES_SENTENCE. */
const TIMES_WIDTHS = new Map([
  [3, 250], [4, 333], [11, 333], [12, 333], [15, 250], [16, 333], [17, 250], [18, 278], [20, 500], [21, 500], [22, 500], [23, 500],
  [24, 500], [25, 500], [26, 500], [29, 278],
]);
/** The first glyph id of the Macintosh order (space) and its last printable ASCII one (asciitilde). */
const MAC_SPACE = 3;
const ASCII_OFFSET = 0x20 - MAC_SPACE;

/** The CIDs of an ASCII sentence or one with the micro sign, by the Macintosh order. */
function macCids(sentence: string): number[] {
  return [...sentence].map((character) => (character === 'µ' ? 151 : (character.codePointAt(0) as number) - ASCII_OFFSET));
}

type ProgramKind = 'truetype' | 'cff' | 'truetype-with-post';

interface LegacyFontOptions {
  name: string;
  cids: number[];
  /** The /W array as written, between its brackets. */
  widths: string;
  program?: ProgramKind;
  ordering?: string;
  /** Write a /CIDToGIDMap stream that sends each CID to the glyph after it, instead of none (Identity). */
  shiftedGlyphs?: boolean;
}

function wArray(widths: Map<number, number>): string {
  return [...widths].map(([cid, width]) => `${cid} [${width}]`).join(' ');
}

function hex(values: number[]): string {
  return values.map((value) => value.toString(16).padStart(4, '0')).join('');
}

function stream(dictionary: string, bytes: Buffer): string {
  return `<< ${dictionary} /Length ${bytes.length} >>\nstream\n${bytes.toString('latin1')}\nendstream`;
}

/** A CID-keyed CFF program (Adobe-Identity) whose glyphs are the CIDs 0 to `last`, each an empty outline. */
function cidKeyedCff(last: number): Buffer {
  return buildCff({
    fontName: 'Legacy',
    charstrings: Array.from({ length: last + 1 }, () => cs(0, 'endchar')),
    charset: Array.from({ length: last }, (_, index) => index + 1),
    strings: ['Adobe', 'Identity'],
    cid: { registrySid: 391, orderingSid: 392, supplement: 0, fds: [{}], fdSelect: { format: 0, fdOfGlyph: new Array(last + 1).fill(0) } },
  });
}

/** One page showing `cids` in a Type0 font (Identity-H, no /ToUnicode) whose descendant is named `name`. */
function legacyFontPdf({ name, cids, widths, program = 'truetype', ordering = 'Identity', shiftedGlyphs = false }: LegacyFontOptions): Buffer {
  const type0 = extraObjectNumber(1);
  const [descendant, descriptor, file, map] = [type0 + 1, type0 + 2, type0 + 3, type0 + 4];
  const glyphMap = Buffer.alloc((Math.max(...cids) + 1) * 2);
  for (let cid = 0; cid * 2 < glyphMap.length; cid++) glyphMap.writeUInt16BE(cid + 1, cid * 2);
  const cff = program === 'cff';
  const bytes = cff ? cidKeyedCff(Math.max(...cids)) : program === 'truetype' ? BARE_TRUETYPE : withoutTables(DEJAVU, 'cmap');
  const objects = [
    `<< /Type /Font /Subtype /Type0 /BaseFont /${name}-Identity-H /Encoding /Identity-H /DescendantFonts [${descendant} 0 R] >>`,
    `<< /Type /Font /Subtype /${cff ? 'CIDFontType0' : 'CIDFontType2'} /BaseFont /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (${ordering}) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW 1000 /W [${widths}]${shiftedGlyphs ? ` /CIDToGIDMap ${map} 0 R` : ''} >>`,
    `<< /Type /FontDescriptor /FontName /${name} /Flags 32 /FontBBox [-665 -325 2000 1006] /ItalicAngle 0 /Ascent 905 /Descent -212 /CapHeight 716 /StemV 80 /${cff ? 'FontFile3' : 'FontFile2'} ${file} 0 R >>`,
    stream(cff ? '/Subtype /CIDFontType0C' : `/Length1 ${bytes.length}`, bytes),
    stream('', glyphMap),
  ];
  return rawPdf([{ width: 400, height: 200, content: `BT /F2 14 Tf 20 100 Td <${hex(cids)}> Tj ET`, fonts: `/F2 ${type0} 0 R` }], objects);
}

async function textOf(pdf: Buffer): Promise<string> {
  return (await convertFile(pdf, 'pdf', 'txt', {}, 'legacy.pdf')).buffer.toString('utf8').trim();
}

const readable = (pdf: Buffer) => withFontProgramToUnicode(pdf, assertPdfStreamsWithinLimits(pdf));

const timed = <T>(read: () => T): { value: T; ms: number } => {
  const started = performance.now();
  const value = read();
  return { value, ms: performance.now() - started };
};

describe('Arial and Times New Roman fonts whose program names no glyph', () => {
  it('reads an Arial TrueType font without cmap and post through the Macintosh glyph order', async () => {
    const pdf = legacyFontPdf({ name: 'ArialMT', cids: ARIAL_CIDS, widths: wArray(ARIAL_WIDTHS) });
    expect(await textOf(pdf)).toBe(ARIAL_TEXT);
  });

  it('reads an Arial Bold font of CID-keyed CFF outlines whose name carries a subset tag', async () => {
    const pdf = legacyFontPdf({ name: 'HPGKBN+Arial,Bold', cids: macCids(ARIAL_BOLD_SENTENCE), widths: wArray(ARIAL_BOLD_WIDTHS), program: 'cff' });
    expect(await textOf(pdf)).toBe(ARIAL_BOLD_SENTENCE);
  });

  it('reads a Times New Roman font against the widths pdfjs keeps for Times', async () => {
    const pdf = legacyFontPdf({ name: 'BGKUVQ+TimesNewRomanPSMT', cids: macCids(TIMES_SENTENCE), widths: wArray(TIMES_WIDTHS) });
    const text = await textOf(pdf);
    expect(text).toBe(TIMES_SENTENCE);
    expect(hasControlCharacters(text)).toBe(false);
  });

  it('gives the CIDs past glyph id 171 no text of the order, where the fonts leave it', () => {
    // CID 180 is quotedblleft in the Macintosh order and quotedblright in Arial; both are 333 wide, so only the cut tells them apart.
    const widths = new Map([...ARIAL_WIDTHS, [180, 333]]);
    const entries = standardOrderTexts('ArialMT', (first, last) => new Map([...widths].filter(([cid]) => cid >= first && cid <= last)));
    expect(entries.map(([cid]) => cid)).not.toContain(180);
    expect(entries).toHaveLength(ARIAL_WIDTHS.size);
  });
});

describe('fonts that are not what their name says', () => {
  it('reads a font named Arial as before when one width of /W is not the width of its glyph in Arial', () => {
    const crafted = new Map([...ARIAL_WIDTHS, [151, 556]]);
    const pdf = legacyFontPdf({ name: 'ArialMT', cids: ARIAL_CIDS, widths: wArray(crafted) });
    expect(readable(pdf)).toBe(pdf);
  });

  it('reads a font named Arial as before when /W gives every CID one width', () => {
    const pdf = legacyFontPdf({ name: 'ArialMT', cids: ARIAL_CIDS, widths: '0 65535 556' });
    expect(readable(pdf)).toBe(pdf);
  });

  it('reads a font named Arial as before when /W lists none of the CIDs of the table', () => {
    const pdf = legacyFontPdf({ name: 'ArialMT', cids: [300, 301], widths: '300 [556 556]' });
    expect(readable(pdf)).toBe(pdf);
  });

  it.each([
    ['a font of another name', 'Wingdings-Regular', 'truetype'],
    ['Arial Narrow, whose widths differ', 'ArialNarrow-Bold', 'truetype'],
    ['Arial Black, whose glyph order differs', 'Arial-Black', 'truetype'],
    ['Courier New, whose glyphs are all one width', 'CourierNewPSMT', 'truetype'],
    ['a subset tag in small letters', 'hpgkbn+ArialMT', 'truetype'],
    ['a subset tag of five letters', 'HPGKB+ArialMT', 'truetype'],
    ['a program with glyph names', 'ArialMT', 'truetype-with-post'],
  ] as const)('reads %s as before', (_case, name, program) => {
    const pdf = legacyFontPdf({ name, cids: ARIAL_CIDS, widths: wArray(ARIAL_WIDTHS), program });
    expect(readable(pdf)).toBe(pdf);
  });

  it('reads a font as before when a /CIDToGIDMap stream makes its CIDs other than glyph ids', () => {
    const pdf = legacyFontPdf({ name: 'ArialMT', cids: ARIAL_CIDS, widths: wArray(ARIAL_WIDTHS), shiftedGlyphs: true });
    expect(readable(pdf)).toBe(pdf);
  });

  it('keeps the predefined mapping of a registered character collection', () => {
    const pdf = legacyFontPdf({ name: 'ArialMT', cids: ARIAL_CIDS, widths: wArray(ARIAL_WIDTHS), ordering: 'Japan1' });
    expect(readable(pdf)).toBe(pdf);
  });
});

describe('the font names pdfjs reads as Arial and Times New Roman', () => {
  it.each([
    ['ABCDEF+Arial,Bold', 'Helvetica-Bold'],
    ['Arial,BoldItalic', 'Helvetica-BoldOblique'],
    ['Arial_Italic', 'Helvetica-Oblique'],
    ['ABCDEF+Arial-BoldMT', 'Helvetica-Bold'],
    ['TimesNewRoman,Italic', 'Times-Italic'],
    ['TimesNewRomanPS-BoldItalicMT', 'Times-BoldItalic'],
    ['Times New Roman', 'Times-Roman'],
    ['ABCDEF+ArialUnicodeMS', undefined],
    [`ABCDEF+Arial${'x'.repeat(200)}`, undefined],
  ])('reads %s as %s', (name, standard) => {
    expect(coreFontOf(name)).toBe(standard);
  });
});

describe('the tables against the pdfjs-dist build', () => {
  const worker = fs.readFileSync(PDFJS_WORKER, 'utf8');
  const block = (start: string): string => worker.slice(worker.indexOf(start), worker.indexOf('\n});', worker.indexOf(start)));
  const order = JSON.parse(/const MacStandardGlyphOrdering = (\[[^\]]*\]);/.exec(worker)?.[1] ?? '[]') as string[];
  const glyphs = new Map([...block('const getGlyphsUnicode = ').matchAll(/t(?:\.(\w+)|\["(\w+)"\]) = 0x([0-9a-fA-F]+);/g)].map((m) => [m[1] ?? m[2], parseInt(m[3], 16)]));
  const timesWidths = (style: string): Map<string, number> => {
    const start = worker.indexOf(`t["${style}"] = getLookupTableFactory`, worker.indexOf('const getMetrics = '));
    return new Map([...worker.slice(start, worker.indexOf('});', start)).matchAll(/t(?:\.(\w+)|\["(\w+)"\]) = (\d+);/g)].map((m) => [m[1] ?? m[2], Number(m[3])]));
  };

  it.each(['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'])(
    'gives each glyph id from 3 to 171 but 155 the character of MacStandardGlyphOrdering, at the %s widths of getMetrics',
    (style) => {
      const widths = timesWidths(style);
      const listed = new Map<number, number>();
      for (let gid = 3; gid <= 171; gid++) if (gid !== 155 && widths.has(order[gid])) listed.set(gid, widths.get(order[gid]) as number);
      const name = { 'Times-Roman': 'TimesNewRoman', 'Times-Bold': 'TimesNewRoman,Bold', 'Times-Italic': 'TimesNewRoman,Italic', 'Times-BoldItalic': 'TimesNewRoman,BoldItalic' }[style] ?? '';
      const entries = standardOrderTexts(name, () => listed);
      expect(entries).toHaveLength(listed.size);
      for (const [cid, codePoint] of entries) expect(codePoint).toBe(glyphs.get(order[cid]));
    },
  );

  it('agrees with getGlyphMapForStandardFonts up to glyph id 171 and differs from it after, where the order is cut', () => {
    const standard = new Map([...block('const getGlyphMapForStandardFonts = ').matchAll(/t\[(\d+)\] = (\d+);/g)].map((m) => [Number(m[1]), Number(m[2])]));
    for (let gid = 3; gid <= 171; gid++) {
      if (!standard.has(gid)) continue;
      expect(String.fromCodePoint(standard.get(gid) as number).normalize('NFC')).toBe(String.fromCodePoint(glyphs.get(order[gid]) as number).normalize('NFC'));
    }
    expect(standard.get(179)).not.toBe(glyphs.get(order[179]));
  });

  it('names every font that getStdFontMap reads as Helvetica or Times as the same font, but Arial Narrow, Black and Unicode MS', () => {
    const map = [...block('const getStdFontMap = ').matchAll(/t(?:\.([\w]+)|\["([\w-]+)"\]) = "([\w-]+)";/g)].map((m) => [m[1] ?? m[2], m[3]]);
    const core = map.filter(([name]) => /^(Arial|TimesNewRoman)/.test(name) && !/Narrow|Black|Unicode/.test(name));
    expect(core.length).toBeGreaterThan(20);
    for (const [name, standard] of core) expect(coreFontOf(name)).toBe(standard);
  });
});

describe('the cost of /W arrays and fonts built to be expensive', () => {
  const BOUND_MS = 1_000;

  it('reads a /W range over 2^32 CIDs at once', () => {
    const pdf = legacyFontPdf({ name: 'ArialMT', cids: ARIAL_CIDS, widths: `0 4294967295 556` });
    const { value, ms } = timed(() => readable(pdf));
    expect(value).toBe(pdf);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it('reads 65,536 CIDs listed one by one at the cost of the array', () => {
    const widths = Array.from({ length: 0x10000 }, (_, cid) => ARIAL_WIDTHS.get(cid) ?? 556).join(' ');
    const pdf = legacyFontPdf({ name: 'ArialMT', cids: ARIAL_CIDS, widths: `0 [${widths}]` });
    const { value, ms } = timed(() => readable(pdf));
    expect(value).toBe(pdf);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it('reads 200,000 ranges that each span every CID in time linear in the array', () => {
    const pdf = legacyFontPdf({ name: 'ArialMT', cids: ARIAL_CIDS, widths: '0 65535 556 '.repeat(200_000) });
    const { value, ms } = timed(() => readable(pdf));
    expect(value).toBe(pdf);
    expect(ms).toBeLessThan(BOUND_MS * 2);
  });

  it('maps the CIDs of the table when /W also lists every CID past it', async () => {
    const past = new Array(0x10000 - 172).fill(0).join(' ');
    const pdf = legacyFontPdf({ name: 'ArialMT', cids: ARIAL_CIDS, widths: `${wArray(ARIAL_WIDTHS)} 172 [${past}]` });
    expect(await textOf(pdf)).toBe(ARIAL_TEXT);
  });
});

describe('real files written by print-to-PDF distillers', () => {
  const TIMEOUT_MS = 120_000;

  it('govdocs1-003205.pdf: reads the Arial fonts of CID-keyed CFF outlines, whose CIDs are Arial glyph ids', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'govdocs1-003205.pdf');
    const result = await convertFile(bytes, 'pdf', 'txt', {}, 'govdocs1-003205.pdf');
    const text = result.buffer.toString('utf8');
    // Strings of page 20 as the page shows them when drawn (pdftoppm); Poppler prints ")LJXUH" for "Figure".
    for (const shown of ['Figure 1. Engineering drawing of a typical lug cross section', 'stringer inner flange', 'rib 1 flange', 'ImageNo:210A0048, Project No:A00387']) {
      expect(text).toContain(shown);
    }
    expect(text).not.toContain(')LJXUH');
    expect(result.metadata?.warnings).toBeUndefined();
  }, TIMEOUT_MS);

  it('cc-4000041.pdf: reads the notice set in Arial fonts of CID-keyed CFF outlines', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'cc-4000041.pdf');
    const text = (await convertFile(bytes, 'pdf', 'txt', {}, 'cc-4000041.pdf')).buffer.toString('utf8');
    // Strings of page 14 as the page shows them when drawn (pdftoppm).
    for (const shown of ['Renesas Electronics hereby expressly disclaims any warranties', 'You shall not alter, modify, copy, or reverse engineer']) {
      expect(text).toContain(shown);
    }
  }, TIMEOUT_MS);
});
