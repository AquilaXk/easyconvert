import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { withFontProgramToUnicode } from '../src/lib/conversions/pdf-font-tounicode';
import { assertPdfStreamsWithinLimits } from '../src/lib/conversions/pdf-stream-guard';
import { compositeFontPdf, FONT_PROGRAM } from './helpers/composite-font-pdf';
import { readGlyphCount } from '../src/lib/conversions/truetype-cmap';
import { repeatedRecordsFont, sharedProgramPdf } from './helpers/hostile-cmap-font';
import { requireRealworldSample } from './helpers/realworld-sample';
import { withoutTables } from './helpers/sfnt-tables';
import { expectWithinHangGuard } from './helpers/timing';

/**
 * Composite fonts (Type0, Identity-H, CIDFontType2) whose /ToUnicode map lists some of their codes. Poppler reads such a
 * font through the map alone (`poppler/GfxFont.cc` 26.09, `GfxCIDFont::getNextChar` lines 1939 to 1948; a code the map does
 * not list maps to nothing, `CharCodeToUnicode::mapToUnicode` lines 499 to 519), so a code the map lacks has no text.
 * pdf.js writes the code itself as the character (`src/core/fonts.js` `_charToGlyph`: `toUnicode.get(charcode) || charcode`),
 * which for a font whose codes are glyph ids is a wrong letter. The font program is the DejaVu Sans subset of
 * tests/fixtures/woff2; the glyph ids are the ones fontTools reads from its cmap.
 */

const SENTENCE = 'Façade déjà vu, 42 hélas!';
const SENTENCE_GLYPHS = [
  0x27, 0x42, 0x8a, 0x42, 0x45, 0x46, 0x01, 0x45, 0x8c, 0x4b, 0x83, 0x01, 0x57, 0x56, 0x0d, 0x01, 0x15, 0x13, 0x01, 0x49, 0x8c, 0x4d, 0x42, 0x54, 0x02,
];
/** The glyph of "a" in the program: a printable character as a code ("B"), so a code printed as itself shows. */
const GLYPH_A = 0x42;
const GLYPH_F = 0x27;
const CHARACTERS = [...SENTENCE];

const hex4 = (value: number): string => value.toString(16).toUpperCase().padStart(4, '0');

/** A ToUnicode CMap with one bfchar entry per pair; a character outside the Basic Multilingual Plane is not needed here. */
function toUnicodeCMap(pairs: ReadonlyArray<readonly [number, string]>): string {
  const entries = pairs.map(([code, text]) => `<${hex4(code)}> <${[...text].map((character) => hex4(character.codePointAt(0) as number)).join('')}>`);
  return ['/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap', '1 begincodespacerange', '<0000> <FFFF>', 'endcodespacerange', `${pairs.length} beginbfchar`, ...entries, 'endbfchar', 'endcmap', 'end', 'end'].join('\n');
}

/** The map of every glyph of the sentence except the glyph of "a", with "F" written as "Q" so the file's map is told from the program's. */
function mapWithoutA(): string {
  const pairs = new Map<number, string>();
  SENTENCE_GLYPHS.forEach((glyph, index) => pairs.set(glyph, glyph === GLYPH_F ? 'Q' : CHARACTERS[index]));
  pairs.delete(GLYPH_A);
  return toUnicodeCMap([...pairs]);
}

async function textOf(pdf: Buffer, target: 'txt' | 'md' = 'txt'): Promise<string> {
  return (await convertFile(pdf, 'pdf', target, {}, 'partial.pdf')).buffer.toString('utf8').trim();
}

describe('a composite font whose ToUnicode map lacks a code', () => {
  it('reads the code from the cmap of the font program, and the codes the map lists from the map', async () => {
    const pdf = compositeFontPdf({ cids: SENTENCE_GLYPHS, toUnicode: mapWithoutA() });
    expect(await textOf(pdf)).toBe('Qaçade déjà vu, 42 hélas!');
  });

  it('prints nothing for a code that neither the map nor the font program gives, never the code itself', async () => {
    const pdf = compositeFontPdf({ cids: SENTENCE_GLYPHS, program: withoutTables(FONT_PROGRAM, 'cmap'), toUnicode: mapWithoutA() });
    expect(await textOf(pdf)).toBe('Qçde déjà vu, 42 héls!');
  });

  it('reads the same in Markdown', async () => {
    const pdf = compositeFontPdf({ cids: SENTENCE_GLYPHS, program: withoutTables(FONT_PROGRAM, 'cmap'), toUnicode: mapWithoutA() });
    expect(await textOf(pdf, 'md')).toBe('Qçde déjà vu, 42 héls!');
  });
});

describe('a real file with composite fonts whose ToUnicode maps lack codes', () => {
  it('prints nothing for the cmmi10 code that stood for the epsilon of a formula, where it printed the digit 6', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'govdocs1-002384.pdf');
    const text = (await convertFile(bytes, 'pdf', 'txt', {}, 'govdocs1-002384.pdf')).buffer.toString('utf8');
    expect(text).toMatch(/^\t=\tratio of feed to chip width$/m);
    expect(text).not.toMatch(/^6\t=\tratio of feed to chip width$/m);
  });

  it('keeps the words of its paragraphs together, which the code characters of the big operators of cmex10 had broken', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'govdocs1-002384.pdf');
    const text = (await convertFile(bytes, 'pdf', 'txt', {}, 'govdocs1-002384.pdf')).buffer.toString('utf8');
    const paragraph = text.split('\n').find((line) => line.startsWith('of the boring bar material, Kc is the specific cutting energy'));
    expect(paragraph?.slice(-57)).toBe('the grooves overlap and can lead to regenerative effects.');
  });
});

describe('a composite font whose ToUnicode map lists no code', () => {
  const NO_CODES: ReadonlyArray<readonly [string, string]> = [
    ['only a codespace range', toUnicodeCMap([])],
    ['a bfrange wider than pdf.js maps (2^24 codes and more)', 'begincmap\n1 beginbfrange\n<0000> <FFFFFFFF> <0000>\nendbfrange\nendcmap'],
    ['a bfrange that ends before it starts', 'begincmap\n1 beginbfrange\n<0010> <0001> <0000>\nendbfrange\nendcmap'],
    ['entries without a destination', 'begincmap\n1 beginbfchar\n<0001>\nendbfchar\nendcmap'],
  ];

  it.each(NO_CODES)('is no map, so the font reads as one without: %s', async (_name, toUnicode) => {
    const pdf = compositeFontPdf({ cids: SENTENCE_GLYPHS, toUnicode });
    expect(await textOf(pdf)).toBe(SENTENCE);
    expect(await textOf(pdf)).toBe(await textOf(compositeFontPdf({ cids: SENTENCE_GLYPHS })));
  });
});

describe('the update that carries the map to pdf.js', () => {
  const readable = (pdf: Buffer) => withFontProgramToUnicode(pdf, assertPdfStreamsWithinLimits(pdf));
  const added = (pdf: Buffer): string => readable(pdf).subarray(pdf.length).toString('latin1');

  it('is the file itself when the map gives text to every code the font can select', () => {
    const everyGlyph = Array.from({ length: readGlyphCount(FONT_PROGRAM) as number }, (_, glyph) => [glyph, 'x'] as const);
    const pdf = compositeFontPdf({ cids: SENTENCE_GLYPHS, toUnicode: toUnicodeCMap(everyGlyph) });
    expect(readable(pdf)).toBe(pdf);
  });

  it('is the file itself when a bfrange gives text to every code, however wide', () => {
    const wide = 'begincmap\n1 beginbfrange\n<0000> <FFFF> <0020>\nendbfrange\nendcmap';
    const pdf = compositeFontPdf({ cids: SENTENCE_GLYPHS, toUnicode: wide });
    expect(readable(pdf)).toBe(pdf);
  });

  it('puts only the codes the map lacks in front of the font\'s own map, which follows it, and names the stream last', () => {
    const own = mapWithoutA();
    const update = added(compositeFontPdf({ cids: SENTENCE_GLYPHS, toUnicode: own }));
    const stream = update.slice(update.indexOf('stream\n') + 'stream\n'.length, update.indexOf('\nendstream'));
    expect(stream.endsWith(own)).toBe(true);
    expect(stream.indexOf('beginbfchar')).toBeLessThan(stream.indexOf('begincmap'));
    expect(update).toMatch(/\/ToUnicode \d+ 0 R >>\nendobj/);
    expect(update.match(/<0042> <0061>/g)).toHaveLength(1);
    expect(update.slice(0, update.indexOf(own))).not.toMatch(/^<0027> /m);
  });

  it('gives the codes of a CID-to-glyph stream their text from the glyph the CID selects', async () => {
    const cids = SENTENCE_GLYPHS.map((_, index) => 0x200 + index);
    const cidToGid = new Map(cids.map((cid, index) => [cid, SENTENCE_GLYPHS[index]]));
    const aCids = new Set(cids.filter((_, index) => SENTENCE_GLYPHS[index] === GLYPH_A));
    const listed = cids.filter((cid) => !aCids.has(cid)).map((cid) => [cid, CHARACTERS[cid - 0x200]] as const);
    expect(await textOf(compositeFontPdf({ cids, cidToGid, toUnicode: toUnicodeCMap(listed) }))).toBe(SENTENCE);
  });

  it('reads a CID that already is the code point of its glyph as that character, since pdf.js no longer gives it as itself', async () => {
    const cids = CHARACTERS.map((character) => character.codePointAt(0) as number);
    const cidToGid = new Map(cids.map((cid, index) => [cid, SENTENCE_GLYPHS[index]]));
    const listed = [[cids[0], 'Q'] as const];
    expect(await textOf(compositeFontPdf({ cids, cidToGid, toUnicode: toUnicodeCMap(listed) }))).toBe('Qaçade déjà vu, 42 hélas!');
  });

  it('leaves the font as the file has it when its map names another CMap with usecmap', () => {
    const pdf = compositeFontPdf({ cids: SENTENCE_GLYPHS, toUnicode: `/Identity-H usecmap\n${mapWithoutA()}` });
    expect(readable(pdf)).toBe(pdf);
  });

  it('leaves the font as the file has it when /ToUnicode names a CMap instead of holding one', () => {
    const named = compositeFontPdf({ cids: SENTENCE_GLYPHS, toUnicode: mapWithoutA() }).toString('latin1').replace(/\/ToUnicode \d+ 0 R/, '/ToUnicode /Identity-H');
    const pdf = Buffer.from(named, 'latin1');
    expect(readable(pdf)).toBe(pdf);
  });

  it('leaves a font that has no cmap and no glyph count as the file has it', () => {
    const pdf = compositeFontPdf({ cids: SENTENCE_GLYPHS, program: withoutTables(FONT_PROGRAM, 'cmap', 'maxp'), toUnicode: mapWithoutA() });
    expect(readable(pdf)).toBe(pdf);
  });
});

describe('hostile composite fonts with a ToUnicode map', () => {
  /** The hostile fonts take up to 0.7 s on a fast core (a 64-font document); the guard stops a map built per font, not a slow runner. */
  const HOSTILE_GUARD = { guardMs: 20_000, expectedLocalMs: 700 };
  const FONTS = 64;
  const readable = (pdf: Buffer) => withFontProgramToUnicode(pdf, assertPdfStreamsWithinLimits(pdf));
  const timed = <T>(read: () => T): { value: T; ms: number } => {
    const started = performance.now();
    const value = read();
    return { value, ms: performance.now() - started };
  };
  const mapsIn = (pdf: Buffer, updated: Buffer): number =>
    updated.subarray(pdf.length).toString('latin1').match(/\/ToUnicode \d+ 0 R >>\nendobj/g)?.length ?? 0;

  it('adds no entry for a CID past the glyphs of the font, and reads the glyphs in range as before', async () => {
    const pdf = compositeFontPdf({ cids: [...SENTENCE_GLYPHS, 0x7000], toUnicode: mapWithoutA() });
    const updated = readable(pdf);
    expect(updated.subarray(pdf.length).toString('latin1')).not.toContain('<7000>');
    expect((await textOf(pdf)).startsWith('Qaçade déjà vu, 42 hélas!')).toBe(true);
  });

  it('does not count a bfrange wider than pdf.js maps as giving text, since pdf.js ignores it', async () => {
    const wide = mapWithoutA().replace('endcmap', '1 beginbfrange\n<0000> <FFFFFFFF> <0000>\nendbfrange\nendcmap');
    const started = performance.now();
    const text = await textOf(compositeFontPdf({ cids: SENTENCE_GLYPHS, toUnicode: wide }));
    expectWithinHangGuard('hostile composite font', performance.now() - started, HOSTILE_GUARD);
    expect(text).toBe('Qaçade déjà vu, 42 hélas!');
  });

  it('reads 100,000 bfranges that each span the whole code space within the bound, as one table of marks', () => {
    const ranges = '<0000> <FFFF> <0020>\n'.repeat(100_000);
    const pdf = compositeFontPdf({ cids: SENTENCE_GLYPHS, toUnicode: `begincmap\n100000 beginbfrange\n${ranges}endbfrange\nendcmap` });
    const { value, ms } = timed(() => readable(pdf));
    expect(value).toBe(pdf);
    expectWithinHangGuard('hostile composite font', ms, HOSTILE_GUARD);
  });

  it('gives a map to at most the fonts whose entries fit the 262,144 of the document, however many fonts name a 65,535-glyph program', () => {
    const pdf = sharedProgramPdf(FONTS, repeatedRecordsFont(0xfffe, true), (index) => `${toUnicodeCMap([[7, 'a']])}\n% font ${index}`);
    const { value, ms } = timed(() => readable(pdf));
    expect(mapsIn(pdf, value)).toBe(4);
    expectWithinHangGuard('hostile composite font', ms, HOSTILE_GUARD);
  });

  it('gives fonts that share their program and their map one stream', () => {
    const pdf = sharedProgramPdf(FONTS, FONT_PROGRAM, toUnicodeCMap([[7, 'a']]));
    const update = readable(pdf).subarray(pdf.length).toString('latin1');
    expect(update.match(/beginbfrange/g)).toHaveLength(1);
    expect(update.match(/\/ToUnicode \d+ 0 R >>\nendobj/g)).toHaveLength(FONTS);
  });

  it('copies the fonts\' own maps at most 8 MiB in all when 32 fonts each have a map of 1 MiB', () => {
    const lines = Array.from({ length: 75_000 }, (_, index) => `<${hex4(index % 100)}> <0061>`).join('\n');
    const big = `begincmap\n${75_000} beginbfchar\n${lines}\nendbfchar\nendcmap`;
    const pdf = sharedProgramPdf(32, FONT_PROGRAM, (index) => `${big}\n% font ${index}`);
    const { value, ms } = timed(() => readable(pdf));
    expect(mapsIn(pdf, value)).toBe(Math.floor((8 * 1024 * 1024) / big.length));
    expect(value.length - pdf.length).toBeLessThan(10 * 1024 * 1024);
    // 32 MiB of maps are read once: about 2 s on a CI runner, where a pass per copy would take minutes.
    expectWithinHangGuard('hostile composite font', ms, HOSTILE_GUARD);
  });

  it('scans a map of 5 MiB of unterminated blocks once, within the bound', () => {
    const hostile = `begincmap\n${'beginbfchar '.repeat(400_000)}`;
    const pdf = sharedProgramPdf(FONTS, FONT_PROGRAM, hostile);
    const { value, ms } = timed(() => readable(pdf));
    expect(mapsIn(pdf, value)).toBe(FONTS);
    expectWithinHangGuard('hostile composite font', ms, HOSTILE_GUARD);
  });
});
