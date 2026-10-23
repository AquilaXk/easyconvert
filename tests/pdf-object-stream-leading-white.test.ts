import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { InflateBudget } from '../src/lib/conversions/bounded-inflate';
import { withFontProgramToUnicode } from '../src/lib/conversions/pdf-font-tounicode';
import { assertPdfStreamsWithinLimits } from '../src/lib/conversions/pdf-stream-guard';
import { objectStreamPdf } from './helpers/object-stream-pdf';
import { extraObjectNumber, rawPdfObjects } from './helpers/raw-pdf';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * Objects stored in an object stream (ISO 32000-1 section 7.5.7) may have white space or comments in front of them: a
 * byte stream is read by a tokenizer that skips both (section 7.2.2 and 7.2.3), as the lexer of pdf.js, the tokenizer of qpdf
 * and the parser of PDFBox read the members. The font pass of the text reader (policy 70) must reach a composite font
 * dictionary written that way, as it reaches one that starts at its first byte.
 *
 * The PDFs are written by hand around the DejaVu Sans subset that fontTools wrote (see tests/fixtures/woff2); the glyph ids
 * are the ones fontTools reads from that font's cmap, and the expected text is the sentence the content stream shows.
 */

const FONT_PROGRAM = fs.readFileSync(path.join(__dirname, 'fixtures', 'woff2', 'dejavu-sans-latin.ttf'));
const SENTENCE = 'Façade déjà vu, 42 hélas!';
/** Glyph ids of SENTENCE in FONT_PROGRAM, as fontTools maps each character through the font's cmap. */
const SENTENCE_GLYPHS = [
  0x27, 0x42, 0x8a, 0x42, 0x45, 0x46, 0x01, 0x45, 0x8c, 0x4b, 0x83, 0x01, 0x57, 0x56, 0x0d, 0x01, 0x15, 0x13, 0x01, 0x49, 0x8c, 0x4d, 0x42, 0x54, 0x02,
];
const MIB = 1024 * 1024;
const BOUND_MS = 1_000;
const TIMEOUT_MS = 120_000;

const readable = (pdf: Buffer) => withFontProgramToUnicode(pdf, assertPdfStreamsWithinLimits(pdf));
const timed = <T>(read: () => T): { value: T; ms: number } => {
  const started = performance.now();
  const value = read();
  return { value, ms: performance.now() - started };
};

function hex(values: number[]): string {
  return values.map((value) => value.toString(16).padStart(4, '0')).join('');
}

function stream(dictionary: string, bytes: Buffer): string {
  return `<< ${dictionary} /Length ${bytes.length} >>\nstream\n${bytes.toString('latin1')}\nendstream`;
}

const TYPE0_A = extraObjectNumber(1);
const TYPE0_B = TYPE0_A + 1;
const DESCENDANT = TYPE0_A + 2;
const DESCRIPTOR = TYPE0_A + 3;

/**
 * One page that shows SENTENCE in font B of two Type0 fonts (A is drawn nowhere), both with an Identity-H encoding and no
 * /ToUnicode, over one CIDFontType2 whose Identity CIDs are the glyph ids of the DejaVu program. Returns the object bodies.
 */
function fontObjects(): string[] {
  const type0 = (name: string) =>
    `<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H /DescendantFonts [${DESCENDANT} 0 R] >>`;
  return rawPdfObjects(
    [{ width: 400, height: 200, content: `BT /F3 14 Tf 20 100 Td <${hex(SENTENCE_GLYPHS)}> Tj ET`, fonts: `/F2 ${TYPE0_A} 0 R /F3 ${TYPE0_B} 0 R` }],
    [
      type0('DejaVuSansA'),
      type0('DejaVuSansB'),
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /DejaVuSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${DESCRIPTOR} 0 R /DW 600 /W [1 [318]] /CIDToGIDMap /Identity >>`,
      `<< /Type /FontDescriptor /FontName /DejaVuSans /Flags 32 /FontBBox [-1021 -463 1793 1232] /ItalicAngle 0 /Ascent 928 /Descent -236 /CapHeight 729 /StemV 80 /FontFile2 ${DESCRIPTOR + 1} 0 R >>`,
      stream(`/Length1 ${FONT_PROGRAM.length}`, FONT_PROGRAM),
    ]
  );
}

/** The document with font B, its CIDFont and the descriptor stored in the object stream, each behind `before`; font A stays where it is. */
function packedPdf(before: string, fontA: 'plain' | { before: string } = 'plain'): Buffer {
  const packed = new Map<number, string>();
  if (fontA !== 'plain') packed.set(TYPE0_A, fontA.before);
  packed.set(TYPE0_B, before).set(DESCENDANT, before).set(DESCRIPTOR, before);
  return objectStreamPdf(fontObjects(), packed);
}

/** Numbers of the font dictionaries the update that `readable` appends writes again, in the order it writes them. */
function readFonts(pdf: Buffer): number[] {
  const update = readable(pdf).subarray(pdf.length).toString('latin1');
  return [...update.matchAll(/\n(\d+) 0 obj\n<< \/ToUnicode /g)].map((match) => Number(match[1]));
}

async function textOf(pdf: Buffer): Promise<string> {
  return (await convertFile(pdf, 'pdf', 'txt', {}, 'packed.pdf')).buffer.toString('utf8').trim();
}

const BEHIND = [
  ['nothing', ''],
  ['a space', ' '],
  ['a line end', '\n'],
  ['a run of the six white-space characters', '\0\t\n\f\r '],
  ['a comment', '% font\n'],
  ['a comment ended by a carriage return', '% font\r'],
  ['comments between white space', ' \r\n%one\r\n \t%two\n\f '],
] as const;

describe('a composite font dictionary in an object stream', () => {
  it.each(BEHIND)('is read when it stands behind %s', async (_case, before) => {
    const pdf = packedPdf(before);
    expect(await textOf(pdf)).toBe(SENTENCE);
    expect(readFonts(pdf)).toEqual([TYPE0_A, TYPE0_B]);
  });

  it.each(BEHIND)('starts at its first token for the font reader when it stands behind %s', (_case, before) => {
    const fonts = assertPdfStreamsWithinLimits(packedPdf(before)).compositeFonts(64, new InflateBudget());
    expect(fonts.map((font) => font.text.slice(0, 2))).toEqual(['<<', '<<']);
  });

  it('is left as it was when a comment in front of it runs to the end of its entry, and the entry after it is still read', () => {
    const open = `%${'x'.repeat(4096)}`;
    expect(readFonts(packedPdf('', { before: open }))).toEqual([TYPE0_B]);
  });
});

describe('white space and comments in front of a stored object cost no more than their length', () => {
  const FOUR_MIB_LESS_ENTRY = 3 * MIB;

  it('reads a font behind 3 MiB of white space', () => {
    const pdf = packedPdf(' \n'.repeat(FOUR_MIB_LESS_ENTRY / 2));
    const { value, ms } = timed(() => readFonts(pdf));
    expect(value).toEqual([TYPE0_A, TYPE0_B]);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it('reads a font behind 3 MiB of comment lines', () => {
    const line = `%${'c'.repeat(62)}\n`;
    const pdf = packedPdf(line.repeat(FOUR_MIB_LESS_ENTRY / line.length));
    const { value, ms } = timed(() => readFonts(pdf));
    expect(value).toEqual([TYPE0_A, TYPE0_B]);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it('leaves a font alone when a comment with no line end fills its entry', () => {
    const pdf = objectStreamPdf(fontObjects(), new Map([[TYPE0_B, `%${'x'.repeat(FOUR_MIB_LESS_ENTRY)}`]]));
    const { value, ms } = timed(() => readFonts(pdf));
    expect(value).toEqual([TYPE0_A]);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it('skips the run in front of an offset once however many entries name it', () => {
    const ALIASES = 50_000;
    const pdf = objectStreamPdf(fontObjects(), new Map([[TYPE0_B, ' \n'.repeat(FOUR_MIB_LESS_ENTRY / 2)]]), ALIASES);
    const { value, ms } = timed(() => readFonts(pdf));
    expect(value).toEqual([TYPE0_A, TYPE0_B]);
    expect(ms).toBeLessThan(BOUND_MS * 3);
  });
});

describe('real file: cc-6400269.pdf', () => {
  it('reads its two Times New Roman fonts, whose dictionaries stand in object streams behind a line end', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'cc-6400269.pdf');
    expect(readFonts(bytes).filter((font) => font === 3980 || font === 3983)).toEqual([3980, 3983]);
    const text = (await convertFile(bytes, 'pdf', 'txt', {}, 'cc-6400269.pdf')).buffer.toString('utf8');
    // Page 31 as the drawn page shows it (pdftoppm): the date of the decree and the blank lines of the form.
    expect(text).toContain('17.05.2021');
    expect(text).toContain('_'.repeat(15));
    expect(text).not.toContain('B'.repeat(15));
  }, TIMEOUT_MS);
});
