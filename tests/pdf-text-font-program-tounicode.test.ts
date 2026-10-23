import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { withFontProgramToUnicode } from '../src/lib/conversions/pdf-font-tounicode';
import { assertPdfStreamsWithinLimits } from '../src/lib/conversions/pdf-stream-guard';
import { requireOracleTool } from './helpers/differential-oracle';
import { repeatedRecordsFont, sharedProgramPdf } from './helpers/hostile-cmap-font';
import { hasControlCharacters } from './helpers/pdf-text-metrics';
import { extraObjectNumber, rawPdf } from './helpers/raw-pdf';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * Composite fonts (Type0, Identity-H, CIDFontType2) that carry no /ToUnicode map: the text of a glyph is read from the
 * `cmap` of the embedded TrueType program, as the glyph id the CID selects. The font program is the DejaVu Sans subset of
 * tests/fixtures/woff2 (written by fontTools, see its PROVENANCE.txt); the glyph ids below are the ones fontTools reads
 * from that font's cmap for each character. The PDFs are written by hand (tests/helpers/raw-pdf.ts), and the expected text
 * is the sentence the content stream shows.
 */

const FONT_PROGRAM = fs.readFileSync(path.join(__dirname, 'fixtures', 'woff2', 'dejavu-sans-latin.ttf'));
const SENTENCE = 'Façade déjà vu, 42 hélas!';
/** Glyph ids of SENTENCE in FONT_PROGRAM, as fontTools maps each character through the font's cmap. */
const SENTENCE_GLYPHS = [
  0x27, 0x42, 0x8a, 0x42, 0x45, 0x46, 0x01, 0x45, 0x8c, 0x4b, 0x83, 0x01, 0x57, 0x56, 0x0d, 0x01, 0x15, 0x13, 0x01, 0x49, 0x8c, 0x4d, 0x42, 0x54, 0x02,
];
/** Glyph ids of "Xyzzw" in FONT_PROGRAM. */
const OTHER_GLYPHS = [0x39, 0x5a, 0x5b, 0x5b, 0x58];
/** Adobe-Japan1 CIDs of "Hello" (CID 1 is the space, and CIDs 1 to 95 follow ASCII from U+0020). */
const JAPAN1_HELLO = [41, 70, 77, 77, 80];
const CID_BASE = 0x200;

interface CompositeFontOptions {
  /** The CIDs the page shows. */
  cids: number[];
  program?: Buffer | null;
  /** CID to glyph id pairs written as a /CIDToGIDMap stream; the map is /Identity when absent. */
  cidToGid?: Map<number, number>;
  ordering?: { registry: string; ordering: string };
}

function hex(values: number[]): string {
  return values.map((value) => value.toString(16).padStart(4, '0')).join('');
}

function stream(dictionary: string, bytes: Buffer): string {
  return `<< ${dictionary} /Length ${bytes.length} >>\nstream\n${bytes.toString('latin1')}\nendstream`;
}

function cidToGidStream(pairs: Map<number, number>): Buffer {
  const map = Buffer.alloc((Math.max(...pairs.keys()) + 1) * 2);
  for (const [cid, gid] of pairs) map.writeUInt16BE(gid, cid * 2);
  return map;
}

/** One page showing `cids` in a Type0 font with an Identity-H encoding and no /ToUnicode. */
function compositeFontPdf({ cids, program = FONT_PROGRAM, cidToGid, ordering = { registry: 'Adobe', ordering: 'Identity' } }: CompositeFontOptions): Buffer {
  const type0 = extraObjectNumber(1);
  const [descendant, descriptor, file, map] = [type0 + 1, type0 + 2, type0 + 3, type0 + 4];
  const fontFile = program === null ? '' : `/FontFile2 ${file} 0 R`;
  const objects = [
    `<< /Type /Font /Subtype /Type0 /BaseFont /DejaVuSans /Encoding /Identity-H /DescendantFonts [${descendant} 0 R] >>`,
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /DejaVuSans /CIDSystemInfo << /Registry (${ordering.registry}) /Ordering (${ordering.ordering}) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW 600 /W [1 [318]] /CIDToGIDMap ${cidToGid ? `${map} 0 R` : '/Identity'} >>`,
    `<< /Type /FontDescriptor /FontName /DejaVuSans /Flags 32 /FontBBox [-1021 -463 1793 1232] /ItalicAngle 0 /Ascent 928 /Descent -236 /CapHeight 729 /StemV 80 ${fontFile} >>`,
    stream(`/Length1 ${program?.length ?? 0}`, program ?? Buffer.alloc(0)),
    stream('', cidToGid ? cidToGidStream(cidToGid) : Buffer.alloc(0)),
  ];
  const content = `BT /F2 14 Tf 20 100 Td <${hex(cids)}> Tj ET`;
  return rawPdf([{ width: 400, height: 200, content, fonts: `/F2 ${type0} 0 R` }], objects);
}

/** A copy of the font program whose table directory names the table `tag` something else, so readers do not find it. */
function withoutTable(program: Buffer, tag: string): Buffer {
  const copy = Buffer.from(program);
  const tables = copy.readUInt16BE(4);
  for (let index = 0; index < tables; index++) {
    const record = 12 + index * 16;
    if (copy.toString('latin1', record, record + 4) === tag) copy.write('zzzz', record, 'latin1');
  }
  return copy;
}

/** A copy of the font program whose cmap claims 65,535 encoding records, far more than its bytes hold. */
function withClaimedCmapRecords(program: Buffer): Buffer {
  const copy = Buffer.from(program);
  const tables = copy.readUInt16BE(4);
  for (let index = 0; index < tables; index++) {
    const record = 12 + index * 16;
    if (copy.toString('latin1', record, record + 4) === 'cmap') copy.writeUInt16BE(0xffff, copy.readUInt32BE(record + 8) + 2);
  }
  return copy;
}

/** The file as qpdf writes it with `args`: objects in object streams, a cross-reference stream, or linearized. */
function rewrittenByQpdf(pdf: Buffer, ...args: string[]): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'font-program-qpdf-'));
  try {
    fs.writeFileSync(path.join(dir, 'in.pdf'), pdf);
    execFileSync(requireOracleTool('qpdf'), [...args, path.join(dir, 'in.pdf'), path.join(dir, 'out.pdf')]);
    return fs.readFileSync(path.join(dir, 'out.pdf'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function convert(pdf: Buffer, target: 'txt' | 'md' = 'txt') {
  return convertFile(pdf, 'pdf', target, {}, 'composite.pdf');
}

async function textOf(pdf: Buffer, target: 'txt' | 'md' = 'txt'): Promise<string> {
  return (await convert(pdf, target)).buffer.toString('utf8').trim();
}

describe('composite TrueType fonts without a /ToUnicode map', () => {
  it('reads each glyph through the cmap of the embedded font program', async () => {
    const result = await convert(compositeFontPdf({ cids: SENTENCE_GLYPHS }));
    expect(result.buffer.toString('utf8').trim()).toBe(SENTENCE);
    expect(result.metadata?.warnings).toBeUndefined();
  });

  it('gives the same text in Markdown', async () => {
    expect(await textOf(compositeFontPdf({ cids: SENTENCE_GLYPHS }), 'md')).toBe(SENTENCE);
  });

  it('follows a /CIDToGIDMap stream from the CID to the glyph', async () => {
    const cids = SENTENCE_GLYPHS.map((_, index) => CID_BASE + index);
    const cidToGid = new Map(cids.map((cid, index) => [cid, SENTENCE_GLYPHS[index]]));
    expect(await textOf(compositeFontPdf({ cids, cidToGid }))).toBe(SENTENCE);
  });

  it('keeps the predefined Unicode mapping of a registered character collection over the font program', async () => {
    const cidToGid = new Map(JAPAN1_HELLO.map((cid, index) => [cid, OTHER_GLYPHS[index]]));
    const pdf = compositeFontPdf({ cids: JAPAN1_HELLO, cidToGid, ordering: { registry: 'Adobe', ordering: 'Japan1' } });
    expect(await textOf(pdf)).toBe('Hello');
  });

  it('keeps CIDs that already are the code points the font program maps to their glyphs', async () => {
    const cids = [...SENTENCE].map((character) => character.codePointAt(0) as number);
    const cidToGid = new Map(cids.map((cid, index) => [cid, SENTENCE_GLYPHS[index]]));
    expect(await textOf(compositeFontPdf({ cids, cidToGid }))).toBe(SENTENCE);
  });
});

describe.skipIf(skipWithoutTools('qpdf'))('the cross-reference data the map is added to', () => {
  it('reads the font when its dictionary sits in an object stream behind a cross-reference stream', async () => {
    const pdf = rewrittenByQpdf(compositeFontPdf({ cids: SENTENCE_GLYPHS }), '--object-streams=generate');
    expect(await textOf(pdf)).toBe(SENTENCE);
  });

  it('reads the font of a linearized file', async () => {
    const pdf = rewrittenByQpdf(compositeFontPdf({ cids: SENTENCE_GLYPHS }), '--object-streams=generate', '--linearize');
    expect(await textOf(pdf)).toBe(SENTENCE);
  });
});

describe('a cross-reference table that points nowhere', () => {
  it('reads the font when the file is read by scanning its objects', async () => {
    const pdf = compositeFontPdf({ cids: SENTENCE_GLYPHS });
    const damaged = Buffer.from(pdf.toString('latin1').replace(/startxref\n\d+/, 'startxref\n12345'), 'latin1');
    expect(await textOf(damaged)).toBe(SENTENCE);
  });
});

describe('the bytes the text reader reads', () => {
  const readable = (pdf: Buffer) => withFontProgramToUnicode(pdf, assertPdfStreamsWithinLimits(pdf));

  it('are the file itself when no composite font lacks a map', () => {
    const pdf = rawPdf([{ width: 400, height: 200, content: 'BT /F1 14 Tf 20 100 Td (Plain text) Tj ET' }]);
    expect(readable(pdf)).toBe(pdf);
  });

  it('are the file itself when every CID already is the code point the program maps to its glyph', () => {
    const cids = [...SENTENCE].map((character) => character.codePointAt(0) as number);
    const pdf = compositeFontPdf({ cids, cidToGid: new Map(cids.map((cid, index) => [cid, SENTENCE_GLYPHS[index]])) });
    expect(readable(pdf)).toBe(pdf);
  });

  it('are the file followed by an update when the CIDs are glyph ids', () => {
    const pdf = compositeFontPdf({ cids: SENTENCE_GLYPHS });
    const updated = readable(pdf);
    expect(updated.subarray(0, pdf.length).equals(pdf)).toBe(true);
    expect(updated.length).toBeGreaterThan(pdf.length);
  });
});

describe('font programs that give no text', () => {
  it('reads the document as before when the program has no cmap', async () => {
    const withoutCmap = await textOf(compositeFontPdf({ cids: SENTENCE_GLYPHS, program: withoutTable(FONT_PROGRAM, 'cmap') }));
    const withoutProgram = await textOf(compositeFontPdf({ cids: SENTENCE_GLYPHS, program: null }));
    expect(withoutCmap).toBe(withoutProgram);
    expect(hasControlCharacters(withoutCmap)).toBe(false);
  });

  it('reads the document as before when the cmap claims more encoding records than it holds', async () => {
    const hostile = await textOf(compositeFontPdf({ cids: SENTENCE_GLYPHS, program: withClaimedCmapRecords(FONT_PROGRAM) }));
    expect(hostile).toBe(await textOf(compositeFontPdf({ cids: SENTENCE_GLYPHS, program: null })));
  });
});

describe('many fonts that share one font program', () => {
  const SHARING_FONTS = 64;
  const BOUND_MS = 1_000;
  const readable = (pdf: Buffer) => withFontProgramToUnicode(pdf, assertPdfStreamsWithinLimits(pdf));
  const timed = <T>(read: () => T): { value: T; ms: number } => {
    const started = performance.now();
    const value = read();
    return { value, ms: performance.now() - started };
  };

  it('are read within a second when the program repeats one unreadable cmap subtable, and the file is passed on as it is', () => {
    const pdf = sharedProgramPdf(SHARING_FONTS, repeatedRecordsFont(0xffff));
    const { value, ms } = timed(() => readable(pdf));
    expect(value).toBe(pdf);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it('each get the text of the readable subtable behind such records, within a second', () => {
    const pdf = sharedProgramPdf(SHARING_FONTS, repeatedRecordsFont(0xfffe, true));
    const { value, ms } = timed(() => readable(pdf));
    expect(value.subarray(0, pdf.length).equals(pdf)).toBe(true);
    expect(value.toString('latin1').split('<0007> <0061>').length - 1).toBe(SHARING_FONTS);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it('each get their text from a program of 40 MiB, which the document budget of 64 MiB allows once', () => {
    const program = Buffer.concat([repeatedRecordsFont(0xfffe, true), Buffer.alloc(40 * 1024 * 1024)]);
    const updated = readable(sharedProgramPdf(SHARING_FONTS, program));
    expect(updated.toString('latin1').split('<0007> <0061>').length - 1).toBe(SHARING_FONTS);
  });

  it('cost no more to read as a stream that inflates past the cap than as one font, and the file is passed on as it is', () => {
    const bomb = Buffer.alloc(70 * 1024 * 1024);
    const one = sharedProgramPdf(1, bomb);
    const many = sharedProgramPdf(SHARING_FONTS, bomb);
    const single = timed(() => readable(one));
    const shared = timed(() => readable(many));
    expect(single.value).toBe(one);
    expect(shared.value).toBe(many);
    expect(shared.ms).toBeLessThan(single.ms * 4 + 150);
  });
});
