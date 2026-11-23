import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { withFontProgramToUnicode } from '../src/lib/conversions/pdf-font-tounicode';
import { pdfjsReadableBytes } from '../src/lib/conversions/pdf-reader-input';
import { assertPdfStreamsWithinLimits } from '../src/lib/conversions/pdf-stream-guard';
import { extractPdfDocument } from '../src/lib/conversions/pdf-text-document';
import { type Type3FontInput, type3GlyphTexts } from '../src/lib/conversions/pdf-type3-tounicode';
import { DecompressionLimitError } from '../src/lib/types';
import { extraObjectNumber, rawPdf } from './helpers/raw-pdf';

const hex2 = (value: number): string => value.toString(16).toUpperCase().padStart(2, '0');

function encodePdfName(name: string): string {
  let out = '/';
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    if (code <= 0x20 || code >= 0x7f || '()<>[]{}/%#'.includes(name[index])) out += `#${hex2(code)}`;
    else out += name[index];
  }
  return out;
}

function pdfStringHex(bytes: readonly number[]): string {
  return `<${bytes.map(hex2).join('')}>`;
}

function type3Pdf(options: { glyphs: ReadonlyArray<readonly [code: number, name: string]>; show: readonly number[]; toUnicode?: string | Buffer; proportional?: boolean }): Buffer {
  const firstExtra = extraObjectNumber(1);
  const fontObj = firstExtra;
  const encodingObj = firstExtra + 1;
  const charProcsObj = firstExtra + 2;
  const glyphProcObj = firstExtra + 3;
  const toUnicodeObj = firstExtra + 4;

  const byCode = new Map<number, string>(options.glyphs);
  const minCode = Math.min(...byCode.keys());
  const maxCode = Math.max(...byCode.keys());
  const widths: number[] = [];
  for (let code = minCode; code <= maxCode; code++) {
    if (!byCode.has(code)) widths.push(0);
    else if (options.proportional === false) widths.push(525);
    else widths.push(code % 2 === 0 ? 278 : 500);
  }
  const differences = [...byCode.entries()].sort((a, b) => a[0] - b[0]).flatMap(([code, name]) => `${code} ${encodePdfName(name)}`).join(' ');
  const charProcEntries = [...new Set(byCode.values())].map((name) => `${encodePdfName(name)} ${glyphProcObj} 0 R`).join(' ');
  const toUnicodeEntry = options.toUnicode === undefined ? '' : ` /ToUnicode ${toUnicodeObj} 0 R`;
  const fontDict =
    `<< /Type /Font /Subtype /Type3 /FontBBox [0 -200 1000 800] /FontMatrix [0.001 0 0 0.001 0 0] ` +
    `/FirstChar ${minCode} /LastChar ${maxCode} /Widths [${widths.join(' ')}] ` +
    `/Encoding ${encodingObj} 0 R /CharProcs ${charProcsObj} 0 R${toUnicodeEntry} >>`;
  const encodingDict = `<< /Type /Encoding /Differences [${differences}] >>`;
  const charProcsDict = `<< ${charProcEntries} >>`;
  const glyphStreamBody = '500 0 d0\n10 0 40 40 re f';
  const glyphProcStream = `<< /Length ${glyphStreamBody.length} >>\nstream\n${glyphStreamBody}\nendstream`;

  const extraObjects = [fontDict, encodingDict, charProcsDict, glyphProcStream];
  if (typeof options.toUnicode === 'string') {
    extraObjects.push(`<< /Length ${options.toUnicode.length} >>\nstream\n${options.toUnicode}\nendstream`);
  } else if (options.toUnicode instanceof Buffer) {
    extraObjects.push(`<< /Filter /FlateDecode /Length ${options.toUnicode.length} >>\nstream\n${options.toUnicode.toString('latin1')}\nendstream`);
  }

  const content = `BT /T3 12 Tf 1 0 0 1 72 700 Tm ${pdfStringHex(options.show)} Tj ET\n`;
  return rawPdf([{ width: 612, height: 792, content, fonts: `/T3 ${fontObj} 0 R` }], extraObjects);
}

const ASCII_LETTER_T3UV = [
  '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
  '/CIDSystemInfo << /Registry (T6+0) /Ordering (T3UV) /Supplement 0 >> def',
  '/CMapName /T6+0 def',
  '/CMapType 2 def',
  '1 begincodespacerange <41> <7a> endcodespacerange',
  '2 beginbfrange',
  '<41> <5A> <0041>',
  '<61> <7a> <0061>',
  'endbfrange',
  'endcmap CMapName currentdict /CMap defineresource pop end end',
].join('\n');

describe('type3GlyphTexts', () => {
  it('maps printable character names and TeX OT1 ligatures for proportional prose fonts, skipping covered codes', () => {
    const cmr: Type3FontInput = {
      subtype: 'Type3',
      widths: [278, 500, 444],
      differences: [1, '.', 8, '-', 9, '\f', 10, '[', 11, '4', 12, ']', 13, '1', 24, '\u000b', 28, '\r', 29, '\u000e', 30, '\u0001', 31, '\u000f', 32, ';;', 99, 'c', 100, 'd', 101, 'e', 102, 'f', 105, 'i', 108, 'l', 111, 'o', 115, 's', 116, 't', 117, 'u', 119, 'w'],
    };
    const mapped = type3GlyphTexts(cmr, (code) => code >= 0x41 && code <= 0x7a);
    expect(mapped).toEqual([
      [1, '.'],
      [8, '-'],
      [9, 'fi'],
      [10, '['],
      [11, '4'],
      [12, ']'],
      [13, '1'],
      [24, 'ff'],
      [28, 'fl'],
      [29, 'ffi'],
      [31, 'ffl'],
    ]);
  });

  it('does not apply OT1 ligatures to OML math italic fonts without digits or prose punctuation', () => {
    const cmmi: Type3FontInput = {
      subtype: 'Type3',
      widths: [278, 500, 777],
      differences: [1, ':', 2, ';;', 3, '\u0019', 4, '\u000b', 5, '\f', 97, 'a', 'b', 'c', 107, 'k', 'm', 'n', 112, 'p', 'q', 120, 'x', 'y'],
    };
    expect(type3GlyphTexts(cmmi)).toEqual([
      [1, ':'],
      [97, 'a'],
      [98, 'b'],
      [99, 'c'],
      [107, 'k'],
      [108, 'm'],
      [109, 'n'],
      [112, 'p'],
      [113, 'q'],
      [120, 'x'],
      [121, 'y'],
    ]);
  });

  it('does not apply OT1 ligatures to fixed-pitch typewriter fonts with uniform positive widths', () => {
    const cmtt: Type3FontInput = {
      subtype: 'Type3',
      widths: [0, 525, 525, 525],
      differences: [1, '.', 9, '1', 10, '2', 11, '\u000b', 12, '\f', 97, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
    };
    expect(type3GlyphTexts(cmtt)).toEqual([
      [1, '.'],
      [9, '1'],
      [10, '2'],
      [97, 'a'],
      [98, 'b'],
      [99, 'c'],
      [100, 'd'],
      [101, 'e'],
      [102, 'f'],
      [103, 'g'],
      [104, 'h'],
    ]);
  });

  it('ignores non-Type3 fonts, small figure symbol sets, and oversized Differences arrays', () => {
    const figure: Type3FontInput = { subtype: 'Type3', widths: [350, 500], differences: [1, '4', '2'] };
    const type1: Type3FontInput = { subtype: 'Type1', widths: [278, 500], differences: [1, '.', 2, ',', 3, '1', 4, '2'] };
    const oversized: Type3FontInput = {
      subtype: 'Type3',
      widths: [278, 500],
      differences: Array.from({ length: 4097 }, (_, index) => (index % 2 === 0 ? 1 : 'a')),
    };
    expect(type3GlyphTexts(figure)).toEqual([]);
    expect(type3GlyphTexts(type1)).toEqual([]);
    expect(type3GlyphTexts(oversized)).toEqual([]);
  });
});

describe('Type 3 /ToUnicode completion end to end', () => {
  it('completes a partial T3UV /ToUnicode map so pdf.js preserves codes 9..13 and TeX OT1 ligatures', async () => {
    const glyphs: Array<[number, string]> = [
      [8, '-'],
      [9, '\f'],
      [10, '['],
      [11, '4'],
      [12, ']'],
      [13, '1'],
      [24, '\u000b'],
      [28, '\r'],
      [29, '\u000e'],
      [31, '\u000f'],
      [32, ' '],
    ];
    for (const ch of 'abcdefilmnorstuwy') glyphs.push([ch.charCodeAt(0), ch]);
    const encodeWord = (word: string): number[] => [...word].map((ch) => ch.charCodeAt(0));
    // "low-field [14] effect baffle traffic fluently"
    const show = [
      ...encodeWord('low'),
      8,
      9,
      ...encodeWord('eld'),
      32,
      10,
      13,
      11,
      12,
      32,
      ...encodeWord('e'),
      24,
      ...encodeWord('ect'),
      32,
      ...encodeWord('ba'),
      31,
      ...encodeWord('e'),
      32,
      ...encodeWord('tra'),
      29,
      ...encodeWord('c'),
      32,
      28,
      ...encodeWord('uently'),
    ];
    const pdf = type3Pdf({ glyphs, show, toUnicode: ASCII_LETTER_T3UV, proportional: true });
    const extracted = await extractPdfDocument(pdf);
    expect(extracted.text.trim()).toBe('low-field [14] effect baffle traffic fluently');
    expect(extracted.pages.reduce((sum, page) => sum + page.unmappedGlyphs, 0)).toBe(0);
  });

  it('adds /ToUnicode for a Type 3 font without one while preserving AGL names via pdf.js fallback', async () => {
    const glyphs: Array<[number, string]> = [
      [9, '\f'],
      [10, '['],
      [11, '4'],
      [12, ']'],
      [13, '1'],
      [20, 'endash'],
      [32, ' '],
    ];
    for (const ch of 'abcdefgilmnoprst') glyphs.push([ch.charCodeAt(0), ch]);
    // "fi [14] –"
    const show = [9, 32, 10, 13, 11, 12, 32, 20];
    const pdf = type3Pdf({ glyphs, show, proportional: true });
    const extracted = await extractPdfDocument(pdf);
    expect(extracted.text.trim()).toBe('fi [14] –');
    expect(extracted.pages.reduce((sum, page) => sum + page.unmappedGlyphs, 0)).toBe(0);
  });

  it('leaves a Type 3 font whose /ToUnicode inherits via usecmap untouched and rejects decompression bombs Fail-Closed', async () => {
    const glyphs: Array<[number, string]> = [
      [1, '.'],
      [2, ','],
      [10, '['],
      [13, '1'],
      [97, 'a'],
      [98, 'b'],
      [99, 'c'],
      [100, 'd'],
    ];
    const inheritsPdf = type3Pdf({ glyphs, show: [97, 98], toUnicode: `/Custom-Base usecmap\n${ASCII_LETTER_T3UV}` });
    expect(withFontProgramToUnicode(inheritsPdf, assertPdfStreamsWithinLimits(inheritsPdf))).toBe(inheritsPdf);

    // 70 MiB of zeros compresses cleanly below stream budget input size yet blows past MAX_STREAM_INFLATE_BYTES
    const bomb = zlib.deflateSync(Buffer.alloc(70 * 1024 * 1024));
    const bombPdf = type3Pdf({ glyphs, show: [97], toUnicode: bomb });
    expect(() => pdfjsReadableBytes(bombPdf, { content: true, pictures: false })).toThrow(DecompressionLimitError);
    await expect(extractPdfDocument(bombPdf)).rejects.toThrow(DecompressionLimitError);
  });
});
