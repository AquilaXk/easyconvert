import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { withFontProgramToUnicode } from '../src/lib/conversions/pdf-font-tounicode';
import { assertPdfStreamsWithinLimits } from '../src/lib/conversions/pdf-stream-guard';
import { buildCff, buildOverlappingPrivateCff, cs } from './helpers/cff-font-builder';
import { hex, stream } from './helpers/composite-font-pdf';
import { requireOracleTool } from './helpers/differential-oracle';
import { extraObjectNumber, rawPdf } from './helpers/raw-pdf';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';
import { expectWithinHangGuard } from './helpers/timing';

/**
 * Composite fonts of CFF outlines (CIDFontType0, FontFile3 /CIDFontType0C, Identity-H) whose /ToUnicode map lists some of their
 * codes. Poppler reads such a font through the map alone: a code the map lacks has no text (`poppler/GfxFont.cc` 26.09,
 * `GfxCIDFont::getNextChar` lines 1939 to 1948; `CharCodeToUnicode::mapToUnicode`, `CharCodeToUnicode.cc` lines 499 to 519).
 * pdf.js writes the code itself as the character (`src/core/fonts.js` `_charToGlyph`: `toUnicode.get(charcode) || charcode`), and
 * Apache PDFBox does the same (`PDType0Font.toUnicode`, `PDType0Font.java` lines 589 to 595). Entry 104 of the policy record chose
 * Poppler's reading for TrueType fonts; the CFF fonts follow it. The independent oracle is `pdftotext`, which reads the same bytes.
 * The CFF programs are written by tests/helpers/cff-font-builder.ts from Adobe Technical Notes #5176 and #5177.
 */

const toolsMissing = skipWithoutTools('pdftotext');
const GLYPH_CODES = [0x41, 0x42, 0x43, 0x44];

interface CffFontOptions {
  /** The CIDs the page shows. */
  cids: number[];
  cff: Buffer;
  toUnicode?: string;
  name?: string;
  /** The /W array as written, between its brackets. */
  widths?: string;
}

/** A CID-keyed CFF program (Adobe-Identity) whose glyph n has the CID `charset[n - 1]`, each an empty outline. */
function cidKeyedCff(charset: number[]): Buffer {
  return buildCff({
    fontName: 'Probe',
    charstrings: [cs('endchar'), ...charset.map(() => cs('endchar'))],
    charset,
    strings: ['Adobe', 'Identity'],
    cid: { registrySid: 391, orderingSid: 392, supplement: 0, fds: [{}], fdSelect: { format: 0, fdOfGlyph: new Array(charset.length + 1).fill(0) } },
  });
}

/** A name-keyed CFF program of `glyphs` glyphs in a CIDFontType0 font: its CIDs are its glyph ids (ISO 32000-1 section 9.7.4.2). */
function nameKeyedCff(glyphs: number): Buffer {
  return buildCff({ fontName: 'Probe', charstrings: Array.from({ length: glyphs }, () => cs('endchar')) });
}

function toUnicodeCMap(pairs: ReadonlyArray<readonly [number, string]>): string {
  const entries = pairs.map(([code, text]) => `<${hex([code]).toUpperCase()}> <${hex([...text].map((character) => character.codePointAt(0) as number)).toUpperCase()}>`);
  return ['/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap', '1 begincodespacerange', '<0000> <FFFF>', 'endcodespacerange', `${pairs.length} beginbfchar`, ...entries, 'endbfchar', 'endcmap', 'end', 'end'].join('\n');
}

/** One page showing `cids` in a Type0 font (Identity-H) whose descendant is a CIDFontType0 with the program `cff`. */
function cffFontPdf({ cids, cff, toUnicode, name = 'DejaVuSans', widths = '' }: CffFontOptions): Buffer {
  const type0 = extraObjectNumber(1);
  const [descendant, descriptor, file, toUnicodeStream] = [type0 + 1, type0 + 2, type0 + 3, type0 + 4];
  const objects = [
    `<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H /DescendantFonts [${descendant} 0 R]${toUnicode === undefined ? '' : ` /ToUnicode ${toUnicodeStream} 0 R`} >>`,
    `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW 556 /W [${widths}] >>`,
    `<< /Type /FontDescriptor /FontName /${name} /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 /FontFile3 ${file} 0 R >>`,
    stream('/Subtype /CIDFontType0C', cff),
    ...(toUnicode === undefined ? [] : [stream('', Buffer.from(toUnicode, 'latin1'))]),
  ];
  return rawPdf([{ width: 400, height: 200, content: `BT /F2 14 Tf 20 100 Td <${hex(cids)}> Tj ET`, fonts: `/F2 ${type0} 0 R` }], objects);
}

/** `count` Type0 fonts that name one descendant program and one ToUnicode stream, one page showing a glyph of each. */
function sharedCffFontsPdf(count: number, cff: Buffer, toUnicode: string): Buffer {
  const first = extraObjectNumber(1);
  const [descriptor, file, toUnicodeStream] = [first, first + 1, first + 2];
  const objects = [
    `<< /Type /FontDescriptor /FontName /Shared /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 /FontFile3 ${file} 0 R >>`,
    stream('/Subtype /CIDFontType0C', cff),
    stream('', Buffer.from(toUnicode, 'latin1')),
  ];
  const type0 = (index: number): number => first + 3 + index * 2;
  for (let index = 0; index < count; index++) {
    objects.push(
      `<< /Type /Font /Subtype /Type0 /BaseFont /Shared${index} /Encoding /Identity-H /DescendantFonts [${type0(index) + 1} 0 R] /ToUnicode ${toUnicodeStream} 0 R >>`,
      `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /Shared${index} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW 556 >>`
    );
  }
  const content = Array.from({ length: count }, (_, index) => `BT /F${index} 14 Tf 20 ${20 + index * 2} Td <0041> Tj ET`).join('\n');
  const fonts = Array.from({ length: count }, (_, index) => `/F${index} ${type0(index)} 0 R`).join(' ');
  return rawPdf([{ width: 400, height: 200, content, fonts }], objects);
}

async function textOf(pdf: Buffer, target: 'txt' | 'md' = 'txt'): Promise<string> {
  return (await convertFile(pdf, 'pdf', target, {}, 'cff.pdf')).buffer.toString('utf8').trim();
}

/** What `pdftotext` prints for the bytes, without the trailing form feed of each page. */
function pdftotext(bytes: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-cff-oracle-'));
  try {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, bytes);
    return execFileSync(requireOracleTool('pdftotext'), ['-q', '-enc', 'UTF-8', file, '-'], { encoding: 'utf8' }).replace(/\f/g, '').trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const readable = (pdf: Buffer) => withFontProgramToUnicode(pdf, assertPdfStreamsWithinLimits(pdf));
const added = (pdf: Buffer): string => readable(pdf).subarray(pdf.length).toString('latin1');

describe.skipIf(toolsMissing)('a CID-keyed CFF composite font whose ToUnicode map lacks a code', () => {
  const partial = toUnicodeCMap([
    [0x41, 'Q'],
    [0x42, 'R'],
  ]);
  /** Glyphs the map lists outnumber the ones it lacks, or the page would be left out as a page of glyphs without text. */
  const SHOWN = [0x41, 0x41, 0x41, 0x42, 0x43, 0x44];

  it('prints nothing for the codes the map lacks, as pdftotext does, where pdf.js printed the code as itself', async () => {
    const pdf = cffFontPdf({ cids: SHOWN, cff: cidKeyedCff(GLYPH_CODES), toUnicode: partial });
    expect(pdftotext(pdf)).toBe('QQQR');
    expect(await textOf(pdf)).toBe('QQQR');
  });

  it('reads the same in Markdown', async () => {
    const pdf = cffFontPdf({ cids: SHOWN, cff: cidKeyedCff(GLYPH_CODES), toUnicode: partial, widths: '65 [556 722 500 611]' });
    expect(await textOf(pdf, 'md')).toBe('QQQR');
  });

  it('keeps the text the map gives, and a map that gives text to every glyph leaves the file as it is', async () => {
    const complete = toUnicodeCMap([[0, ' '], ...GLYPH_CODES.map((code, index) => [code, 'WXYZ'[index]] as const)]);
    const pdf = cffFontPdf({ cids: GLYPH_CODES, cff: cidKeyedCff(GLYPH_CODES), toUnicode: complete });
    expect(await textOf(pdf)).toBe('WXYZ');
    expect(readable(pdf)).toBe(pdf);
  });

  it('puts only the glyphs the map lacks in front of the font\'s own map, which follows it, and no entry for a code that is no glyph', () => {
    const update = added(cffFontPdf({ cids: SHOWN, cff: cidKeyedCff([0x41, 0x42, 0x43, 0x44, 0x50]), toUnicode: partial }));
    const body = update.slice(update.indexOf('stream\n') + 'stream\n'.length, update.indexOf('\nendstream'));
    expect(body.endsWith(partial)).toBe(true);
    expect(body).toMatch(/<0000> <0000> <E000>/);
    expect(body).toMatch(/<0043> <0044> <E000>/);
    expect(body).toMatch(/<0050> <0050> <E000>/);
    expect(body).not.toMatch(/<0041>.*<E000>/);
    expect(body).not.toMatch(/<0045>/);
  });

  it('reads an Arial font of CFF outlines with a partial map from the glyph order for the codes the map lacks, and the map for the rest', async () => {
    const cids = [53, 72, 83, 82, 85, 87];
    const widths = '53 [722] 72 [556] 82 [556] 83 [556] 85 [333] 87 [278]';
    const pdf = cffFontPdf({ cids, cff: cidKeyedCff([53, 72, 82, 83, 85, 87]), toUnicode: toUnicodeCMap([[53, 'Q']]), name: 'ArialMT', widths });
    expect(await textOf(pdf)).toBe('Qeport');
  });
});

describe.skipIf(toolsMissing)('a name-keyed CFF program in a CIDFontType0 font', () => {
  it('has the glyph ids as its CIDs, so a glyph the map lacks prints nothing', async () => {
    const pdf = cffFontPdf({ cids: [0x41, 0x41, 0x41, 0x42, 0x43], cff: nameKeyedCff(0x44), toUnicode: toUnicodeCMap([[0x41, 'Q']]) });
    expect(pdftotext(pdf)).toBe('QQQ');
    expect(await textOf(pdf)).toBe('QQQ');
  });

  it('is left as the file has it when its map gives text to every glyph', () => {
    const glyphs = 0x44;
    const complete = toUnicodeCMap(Array.from({ length: glyphs }, (_, code) => [code, 'x'] as const));
    const pdf = cffFontPdf({ cids: [0x41, 0x42], cff: nameKeyedCff(glyphs), toUnicode: complete });
    expect(readable(pdf)).toBe(pdf);
  });
});

describe('a CFF composite font that the update leaves as the file has it', () => {
  const partial = toUnicodeCMap([[0x41, 'Q']]);

  it('a map that names another CMap with usecmap', () => {
    const pdf = cffFontPdf({ cids: GLYPH_CODES, cff: cidKeyedCff(GLYPH_CODES), toUnicode: `/Identity-H usecmap\n${partial}` });
    expect(readable(pdf)).toBe(pdf);
  });

  it('a program that is not CFF', () => {
    const pdf = cffFontPdf({ cids: GLYPH_CODES, cff: Buffer.from('not a font program'), toUnicode: partial });
    expect(readable(pdf)).toBe(pdf);
  });

  it('a CFF table that is cut short', () => {
    const cff = cidKeyedCff(GLYPH_CODES);
    const pdf = cffFontPdf({ cids: GLYPH_CODES, cff: cff.subarray(0, cff.length - 40), toUnicode: partial });
    expect(readable(pdf)).toBe(pdf);
  });

  it('a font that embeds no program', () => {
    const pdf = cffFontPdf({ cids: GLYPH_CODES, cff: cidKeyedCff(GLYPH_CODES), toUnicode: partial });
    const stripped = Buffer.from(pdf.toString('latin1').replace(/\/FontFile3 \d+ 0 R/, ''), 'latin1');
    expect(readable(stripped)).toBe(stripped);
  });
});

describe('hostile CFF composite fonts with a ToUnicode map', () => {
  const HOSTILE_GUARD = { guardMs: 20_000, expectedLocalMs: 700 };
  const timed = <T>(read: () => T): { value: T; ms: number } => {
    const started = performance.now();
    const value = read();
    return { value, ms: performance.now() - started };
  };

  it('reads a program of 65,520 glyphs within the bound, its codes counted against the 262,144 of the document as those of a TrueType font are', () => {
    const charset = Array.from({ length: 0xfff0 }, (_, index) => index + 1);
    const pdf = cffFontPdf({ cids: [0x41], cff: cidKeyedCff(charset), toUnicode: toUnicodeCMap([[0x41, 'Q']]) });
    const { value, ms } = timed(() => readable(pdf));
    expect(value.length).toBeGreaterThan(pdf.length);
    expect(value.subarray(pdf.length).length).toBeLessThan(3 * 1024 * 1024);
    expectWithinHangGuard('hostile CFF composite font', ms, HOSTILE_GUARD);
  });

  it('adds no entry for a CID past the last glyph of the program, and reads the glyphs in range as before', async () => {
    const pdf = cffFontPdf({ cids: [0x41, 0x42, 0x7000], cff: cidKeyedCff([0x41, 0x42]), toUnicode: toUnicodeCMap([[0x41, 'Q']]) });
    expect(added(pdf)).not.toContain('<7000>');
    expect((await textOf(pdf)).startsWith('Q')).toBe(true);
  });

  it('reads a charset whose ids repeat or run backwards as the set of CIDs it names', async () => {
    const pdf = cffFontPdf({ cids: [0x41, 0x41, 0x41, 0x44], cff: cidKeyedCff([0x44, 0x41, 0x41, 0x43]), toUnicode: toUnicodeCMap([[0x41, 'Q']]) });
    expect(await textOf(pdf)).toBe('QQQ');
  });

  it('reads, within the bound of the font parser, a table whose 256 Private DICT ranges of 1 MiB overlap', () => {
    const pdf = cffFontPdf({ cids: [0x41], cff: buildOverlappingPrivateCff(1024 * 1024, 256), toUnicode: toUnicodeCMap([[0x41, 'Q']]) });
    const { ms } = timed(() => readable(pdf));
    expectWithinHangGuard('hostile CFF composite font', ms, HOSTILE_GUARD);
  });

  it('gives a map to at most the fonts whose codes fit the 262,144 of the document, however many fonts name a 60,000-glyph program', () => {
    const pdf = sharedCffFontsPdf(64, cidKeyedCff(Array.from({ length: 0xea60 }, (_, index) => index + 1)), toUnicodeCMap([[0x41, 'Q']]));
    const { value, ms } = timed(() => readable(pdf));
    expect(value.subarray(pdf.length).toString('latin1').match(/\/ToUnicode \d+ 0 R >>\nendobj/g)).toHaveLength(4);
    expectWithinHangGuard('hostile CFF composite font', ms, HOSTILE_GUARD);
  });

  it('survives a program whose INDEX counts run past its bytes', () => {
    const cff = Buffer.from(cidKeyedCff(GLYPH_CODES));
    cff.writeUInt16BE(0xffff, cff.readUInt8(2));
    const pdf = cffFontPdf({ cids: GLYPH_CODES, cff, toUnicode: toUnicodeCMap([[0x41, 'Q']]) });
    expect(readable(pdf)).toBe(pdf);
  });
});

describe.skipIf(toolsMissing)('a real file with CFF composite fonts whose ToUnicode maps lack codes', () => {
  it('govdocs1-004148.pdf: its Greek font draws code 12, which its map lacks (a form feed, so no visible change), and the words stay those pdftotext prints', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'govdocs1-004148.pdf');
    const text = (await convertFile(bytes, 'pdf', 'txt', {}, 'govdocs1-004148.pdf')).buffer.toString('utf8');
    const poppler = pdftotext(bytes);
    const words = (value: string) => new Set(value.split(/\s+/).filter((word) => /^[A-Za-z]{4,}$/.test(word)));
    const ours = words(text);
    const theirs = words(poppler);
    const missing = [...theirs].filter((word) => !ours.has(word));
    expect(missing.length / theirs.size).toBeLessThan(0.02);
  });
});
