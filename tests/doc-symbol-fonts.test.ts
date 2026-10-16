import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { convertFile } from '../src/lib/conversions';
import { withConversionWarnings } from '../src/lib/conversions/conversion-warnings';
import { extractTextFromDoc } from '../src/lib/conversions/office';
import { DOC_MAX_CHARACTER_RUNS_PER_PAGE, DOC_MAX_CHPX_PAGES } from '../src/lib/conversions/office/doc-character-formatting';
import { LegacyOfficeFormatError } from '../src/lib/conversions/office/legacy-office-errors';
import { extractFontsWithExternalPdffonts, extractTextWithExternalPdftotext } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { buildCompoundFile } from './helpers/cfb-craft';
import { buildWordBinary, buildWordBinaryParts, type WordBuildOptions, type WordBinaryParts } from './helpers/word-binary-builder';
import { normalizeWhitespace } from './helpers/soffice-office';

/**
 * Symbol-font characters in Word 97-2003 documents (#726). Symbol, Wingdings and Webdings keep their glyphs at
 * U+F020-U+F0FF; the font of the run (CHPX in the FKP pages, font table SttbfFfn, default fonts of the style sheet)
 * says which Unicode character a glyph depicts. The expected characters are written by hand from the Unicode
 * pictographic and Adobe Symbol mapping charts. Documents come from a hand-written [MS-DOC] builder and from the
 * office suite, and the PDF text is read by pdftotext.
 */

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'word-symbol-fonts', 'symbol-fonts.doc'));
const HTTP_BAD_REQUEST = 400;
const FUZZ_ITERATIONS = 400;
const FUZZ_BUDGET_MS = 30_000;
const FUZZ_ITERATION_MS = 2_000;
const FUZZ_SEED = 0x726;

// Font indexes of the builder's font table.
const FONTS = ['Times New Roman', 'Symbol', 'Wingdings', 'Arial', 'Mathematica1', 'Webdings'] as const;
const F_TIMES = 0;
const F_SYMBOL = 1;
const F_WINGDINGS = 2;
const F_ARIAL = 3;
const F_MATH = 4;
const F_WEBDINGS = 5;

function build(text: string, options: Partial<WordBuildOptions>): Buffer {
  return buildWordBinary({ pieces: [{ text, compressed: false }], fonts: FONTS, ...options });
}

function wrap(parts: WordBinaryParts): Buffer {
  return buildCompoundFile([
    { name: 'WordDocument', data: parts.word },
    { name: '1Table', data: parts.table },
  ]);
}

describe('Word 97-2003 symbol-font characters from the character formatting runs', () => {
  it('maps private-use characters by the font of their run', () => {
    const doc = build('A \uF0B7 B \uF0FC C \uF061 D\r', {
      runs: [
        { chars: 2 },
        { chars: 1, ftcAscii: F_SYMBOL, ftcOther: F_SYMBOL },
        { chars: 3 },
        { chars: 1, ftcAscii: F_WINGDINGS, ftcOther: F_WINGDINGS },
        { chars: 3 },
        { chars: 1, ftcAscii: F_WEBDINGS, ftcOther: F_WEBDINGS },
        { chars: 3 },
      ],
    });
    expect(extractTextFromDoc(doc)).toBe('A \u2022 B \u2713 C \u2714 D');
  });

  it('reads the font from any of the three font slots of a run', () => {
    for (const slot of ['ftcAscii', 'ftcFarEast', 'ftcOther'] as const) {
      const doc = build('x\uF0FCy\r', { runs: [{ chars: 1 }, { chars: 1, [slot]: F_WINGDINGS }, { chars: 3 }] });
      expect(extractTextFromDoc(doc)).toBe('x\u2713y');
    }
  });

  it('uses the default character font of the style sheet when a run sets none', () => {
    const doc = build('go \uF0FC\r', { styleFonts: { ascii: F_WINGDINGS, farEast: F_TIMES, other: F_WINGDINGS }, runs: [{ chars: 3 }, { chars: 2 }] });
    expect(extractTextFromDoc(doc)).toBe('go \u2713');
  });

  it('prefers the font of the run over the default font', () => {
    const doc = build('\uF0B7\uF0FC\r', {
      styleFonts: { ascii: F_WINGDINGS, farEast: F_WINGDINGS, other: F_WINGDINGS },
      runs: [{ chars: 1, ftcAscii: F_SYMBOL, ftcFarEast: F_SYMBOL, ftcOther: F_SYMBOL }, { chars: 2 }],
    });
    expect(extractTextFromDoc(doc)).toBe('\u2022\u2713');
  });

  it('maps characters of runs that follow compressed pieces stored out of physical order', () => {
    const doc = buildWordBinary({
      pieces: [
        { text: 'Plain café ', compressed: true },
        { text: '\uF0FC and \uF0B7\r', compressed: false },
        { text: 'tail text\r', compressed: true },
      ],
      reversePhysicalOrder: true,
      fonts: FONTS,
      runs: [{ chars: 11, ftcAscii: F_ARIAL }, { chars: 1, ftcAscii: F_WINGDINGS, ftcOther: F_WINGDINGS }, { chars: 5 }, { chars: 1, ftcAscii: F_SYMBOL, ftcOther: F_SYMBOL }, { chars: 1 }],
    });
    expect(extractTextFromDoc(doc)).toBe('Plain café \u2713 and \u2022\ntail text');
  });

  it('keeps the formatting of every FKP page of a long document', () => {
    const pairs = 350;
    const text = `${'a\uF0FC'.repeat(pairs)}\r`;
    const runs = Array.from({ length: pairs }, (_, i) => [{ chars: 1 }, { chars: 1, ftcAscii: i % 2 === 0 ? F_WINGDINGS : F_SYMBOL, ftcOther: i % 2 === 0 ? F_WINGDINGS : F_SYMBOL }]).flat();
    const parts = buildWordBinaryParts({ pieces: [{ text, compressed: false }], fonts: FONTS, runs });
    expect(parts.layout.fkpPages.length).toBeGreaterThan(2);
    const expected = Array.from({ length: pairs }, (_, i) => (i % 2 === 0 ? 'a\u2713' : 'a\u23AB')).join('');
    expect(extractTextFromDoc(wrap(parts))).toBe(expected);
  });

  it('replaces the Symbol field placeholder with the character of its font', () => {
    const doc = build('a(b(c\r', { runs: [{ chars: 1 }, { chars: 1, symbol: { ftc: F_WINGDINGS, xchar: 0xf0fc } }, { chars: 1 }, { chars: 1, symbol: { ftc: F_SYMBOL, xchar: 0x61 } }, { chars: 2 }] });
    expect(extractTextFromDoc(doc)).toBe('a\u2713b\u03B1c');
  });

  it('leaves an ordinary opening parenthesis alone', () => {
    const doc = build('f(x) \uF0FC\r', { runs: [{ chars: 5 }, { chars: 1, ftcAscii: F_WINGDINGS, ftcOther: F_WINGDINGS }, { chars: 1 }] });
    expect(extractTextFromDoc(doc)).toBe('f(x) \u2713');
  });

  it('maps the space of a symbol font to a space', () => {
    const doc = build('a\uF020b\r', { runs: [{ chars: 1 }, { chars: 1, ftcAscii: F_SYMBOL, ftcOther: F_SYMBOL }, { chars: 2 }] });
    expect(extractTextFromDoc(doc)).toBe('a b');
  });

  it('converts to text and reports each character with no known counterpart once per font and code', async () => {
    const doc = build('a\uF073\uF073\uF0FF\uF0FC\uF0FC\uF0B7\r', {
      runs: [{ chars: 1 }, { chars: 2, ftcAscii: F_MATH, ftcOther: F_MATH }, { chars: 1, ftcAscii: F_WINGDINGS, ftcOther: F_WINGDINGS }, { chars: 1, ftcAscii: F_ARIAL, ftcOther: F_ARIAL }, { chars: 1, ftcAscii: F_ARIAL, ftcOther: F_ARIAL }, { chars: 2 }],
    });
    const result = await convertFile(doc, 'doc', 'txt', {}, 'math.doc');
    expect(result.buffer.toString('utf-8')).toBe('a\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD');
    expect(result.metadata?.warnings).toEqual([
      'Replaced U+F073 of the font "Mathematica1" with U+FFFD: no Unicode counterpart is known.',
      'Replaced U+F0FF of the font "Wingdings" with U+FFFD: no Unicode counterpart is known.',
      'Replaced U+F0FC of the font "Arial" with U+FFFD: no Unicode counterpart is known.',
      'Replaced U+F0B7 with U+FFFD: no Unicode counterpart is known.',
    ]);
  });

  it('replaces a mapped character the output cannot draw and reports it', async () => {
    const doc = build('a\uF0FC\uF0B7b\r', {
      runs: [{ chars: 1 }, { chars: 1, ftcAscii: F_WINGDINGS, ftcOther: F_WINGDINGS }, { chars: 1, ftcAscii: F_SYMBOL, ftcOther: F_SYMBOL }, { chars: 2 }],
    });
    let text = '';
    const result = await withConversionWarnings(async () => {
      text = extractTextFromDoc(doc, (character) => character !== '\u2713');
      return { buffer: Buffer.alloc(0), mimeType: 'text/plain', filename: 'x.txt', size: 0 };
    });
    expect(text).toBe('a\uFFFD\u2022b');
    expect(result.metadata?.warnings).toEqual(['Replaced U+F0FC of the font "Wingdings" with U+FFFD: its character U+2713 has no glyph in the installed fonts.']);
  });

  it('names no font for a document without a font table', () => {
    const doc = buildWordBinary({ pieces: [{ text: 'x\uF0FC\r', compressed: false }] });
    expect(extractTextFromDoc(doc)).toBe('x\uFFFD');
  });

  it('leaves a document without symbol characters untouched even when its formatting is unusable', () => {
    const doc = build('Plain text only\r', { runs: [{ chars: 5, ftcAscii: 999 }, { chars: 10 }] });
    expect(extractTextFromDoc(doc)).toBe('Plain text only');
  });
});

describe('Word 97-2003 symbol-font characters of a document written by the office suite', () => {
  const EXPECTED_RUN_TEXT = ['\u2022\u03B1\u03B2\u2211', '\u2713\u26AB\u25AA', '\u2611\u2612', '\u25B2\u25BC', '\u2714'];

  it('maps every run of the fixture', () => {
    const lines = extractTextFromDoc(FIXTURE).split('\n');
    expect(lines).toEqual(EXPECTED_RUN_TEXT.map((text, i) => `Run ${i + 1}: ${text} end`));
  });

  oracleTest('writes the mapped characters into a PDF whose text a separate PDF reader confirms', ['pdftotext', 'pdffonts'], async () => {
    const result = await convertFile(FIXTURE, 'doc', 'pdf', {}, 'symbol-fonts.doc');
    const extracted = normalizeWhitespace(extractTextWithExternalPdftotext(result.buffer) ?? '');
    expect(extracted).toBe(EXPECTED_RUN_TEXT.map((text, i) => `Run ${i + 1}: ${text} end`).join(' '));
    expect(result.metadata?.warnings).toBeUndefined();
    const fonts = extractFontsWithExternalPdffonts(result.buffer);
    expect(fonts.length).toBeGreaterThan(0);
    expect(fonts.every((font) => font.emb)).toBe(true);
  });
});

describe('Word 97-2003 malformed character formatting', () => {
  function valid(): WordBinaryParts {
    return buildWordBinaryParts({
      pieces: [{ text: 'a\uF0FCb\r', compressed: false }],
      fonts: FONTS,
      styleFonts: { ascii: F_TIMES, farEast: F_TIMES, other: F_TIMES },
      runs: [{ chars: 1 }, { chars: 1, ftcAscii: F_WINGDINGS, ftcOther: F_WINGDINGS }, { chars: 2 }],
    });
  }

  function expectRefused(parts: WordBinaryParts, message: RegExp): void {
    let thrown: unknown;
    try {
      extractTextFromDoc(wrap(parts));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LegacyOfficeFormatError);
    expect((thrown as LegacyOfficeFormatError).status).toBe(HTTP_BAD_REQUEST);
    expect((thrown as LegacyOfficeFormatError).message).toMatch(message);
  }

  it('accepts the unmodified document', () => {
    expect(extractTextFromDoc(wrap(valid()))).toBe('a\u2713b');
  });

  it('refuses a PlcBteChpx whose size is not 4 + 8n', () => {
    const parts = valid();
    parts.word.writeUInt32LE(parts.layout.plcBteChpx.length + 1, parts.layout.pairOffset(12) + 4);
    expectRefused(parts, /character formatting table size/);
  });

  it('refuses a PlcBteChpx that lies outside the table stream', () => {
    const parts = valid();
    parts.word.writeUInt32LE(parts.table.length + 4096, parts.layout.pairOffset(12));
    expectRefused(parts, /character formatting table lies outside/);
  });

  it('refuses a PlcBteChpx that declares more FKP pages than the limit', () => {
    const parts = valid();
    const oversized = 4 + (DOC_MAX_CHPX_PAGES + 1) * 8;
    const start = parts.table.length;
    parts.word.writeUInt32LE(start, parts.layout.pairOffset(12));
    parts.word.writeUInt32LE(oversized, parts.layout.pairOffset(12) + 4);
    expectRefused({ ...parts, table: Buffer.concat([parts.table, Buffer.alloc(oversized)]) }, /more than the 32768 limit/);
  });

  it('refuses an FKP page that lies outside the WordDocument stream', () => {
    const parts = valid();
    const pnAt = parts.layout.plcBteChpx.offset + 8;
    parts.table.writeUInt32LE(0x3fffff, pnAt);
    expectRefused(parts, /FKP page .* outside the WordDocument stream/);
  });

  it('refuses an FKP page with no runs or with more runs than a page can hold', () => {
    for (const count of [0, DOC_MAX_CHARACTER_RUNS_PER_PAGE + 1, 255]) {
      const parts = valid();
      parts.word[parts.layout.fkpPages[0] + 511] = count;
      expectRefused(parts, /FKP page .* (holds|declares) .* runs/);
    }
  });

  /** Replaces the PlcBteChpx with `pages` entries over [fc, fc] that all address FKP page `pageNumber`. */
  function repointPlc(parts: WordBinaryParts, pageNumbers: number[], fcs: number[]): void {
    const plc = Buffer.alloc(4 + pageNumbers.length * 8);
    fcs.forEach((fc, i) => plc.writeUInt32LE(fc, i * 4));
    pageNumbers.forEach((pn, i) => plc.writeUInt32LE(pn, (pageNumbers.length + 1) * 4 + i * 4));
    parts.word.writeUInt32LE(parts.table.length, parts.layout.pairOffset(12));
    parts.word.writeUInt32LE(plc.length, parts.layout.pairOffset(12) + 4);
    parts.table = Buffer.concat([parts.table, plc]);
  }

  /** Rewrites FKP page 0 as `count` zero-width runs at one offset, all with a Chpx that sets the ASCII font. */
  function zeroWidthPage(parts: WordBinaryParts, count: number, fc: number): number {
    const pageAt = parts.layout.fkpPages[0];
    const page = parts.word.subarray(pageAt, pageAt + 512);
    page.fill(0);
    for (let i = 0; i <= count; i++) page.writeUInt32LE(fc, i * 4);
    const chpxAt = 504;
    for (let i = 0; i < count; i++) page[(count + 1) * 4 + i] = chpxAt / 2;
    page[chpxAt] = 4;
    page.writeUInt16LE(0x4a4f, chpxAt + 1);
    page.writeUInt16LE(F_WINGDINGS, chpxAt + 3);
    page[511] = count;
    return pageAt / 512;
  }

  it('refuses a PlcBteChpx that addresses the same FKP page twice', () => {
    const parts = valid();
    const pn = parts.layout.fkpPages[0] / 512;
    repointPlc(parts, [pn, pn], [0, 0x10000, 0x20000]);
    expectRefused(parts, /FKP page \d+ is addressed more than once/);
  });

  it('refuses amplified zero-width runs: many entries of one FKP page full of runs that cover no character', () => {
    const parts = valid();
    const pn = zeroWidthPage(parts, 90, 0x10000);
    const pages = 4096;
    repointPlc(parts, new Array<number>(pages).fill(pn), new Array<number>(pages + 1).fill(0x10000));
    expectRefused(parts, /addressed more than once/);
  });

  it('does not count zero-width runs against the run limit', () => {
    const parts = valid();
    const pn = zeroWidthPage(parts, 90, 0x10000);
    repointPlc(parts, [pn], [0, 0x10000]);
    expect(extractTextFromDoc(wrap(parts))).toBe('a\uFFFDb');
  });

  it('refuses more character runs than the text and pages can hold', () => {
    const parts = valid();
    const count = 90;
    const pageAt = parts.layout.fkpPages[0];
    const page = parts.word.subarray(pageAt, pageAt + 512);
    page.fill(0);
    for (let i = 0; i <= count; i++) page.writeUInt32LE(0x10000 + i, i * 4);
    const chpxAt = 504;
    for (let i = 0; i < count; i++) page[(count + 1) * 4 + i] = chpxAt / 2;
    page[chpxAt] = 4;
    page.writeUInt16LE(0x4a4f, chpxAt + 1);
    page.writeUInt16LE(F_WINGDINGS, chpxAt + 3);
    page[511] = count;
    repointPlc(parts, [pageAt / 512], [0, 0x10000 + count]);
    expectRefused(parts, /more character runs than its text can hold/);
  });

  it('refuses FKP file offsets that are not in ascending order', () => {
    const parts = valid();
    const page = parts.layout.fkpPages[0];
    parts.word.writeUInt32LE(parts.word.readUInt32LE(page + 8) + 100, page + 4);
    expectRefused(parts, /not in ascending order/);
  });

  it('refuses a Chpx offset that points into the offset arrays', () => {
    for (const rgb of [1, 2]) {
      const parts = valid();
      const page = parts.layout.fkpPages[0];
      const crun = parts.word[page + 511];
      parts.word[page + (crun + 1) * 4 + 1] = rgb;
      expectRefused(parts, /Chpx at offset \d+ .* lies outside the space after its offset arrays/);
    }
  });

  it('refuses a Chpx offset at the count byte of the page', () => {
    const parts = valid();
    const page = parts.layout.fkpPages[0];
    const crun = parts.word[page + 511];
    parts.word[page + (crun + 1) * 4 + 1] = 0x100 / 2 + 0x7f; // offset 511 is odd; 0xff * 2 = 510 is the last even offset
    parts.word[page + 510] = 0x01;
    expectRefused(parts, /Chpx at offset 510 .* runs past the end of the page/);
  });

  it('refuses a Chpx whose byte count runs past the end of the page', () => {
    const parts = valid();
    const page = parts.layout.fkpPages[0];
    const crun = parts.word[page + 511];
    parts.word[page + (crun + 1) * 4 + 1] = 0xf0;
    parts.word[page + 0xf0 * 2] = 0xff;
    expectRefused(parts, /Chpx at offset 480 .* runs past the end of the page/);
  });

  it('refuses a property modifier whose operand runs past the Chpx', () => {
    const parts = valid();
    const page = parts.layout.fkpPages[0];
    const crun = parts.word[page + 511];
    const chpxAt = parts.word[page + (crun + 1) * 4 + 1] * 2;
    parts.word[page + chpxAt] = 3; // cb: the 4-byte sprmCRgFtc0 + operand no longer fits
    expectRefused(parts, /property modifier .* past the end/);
  });

  it('refuses a font table that declares more fonts than it holds', () => {
    const tooMany = valid();
    tooMany.table.writeUInt16LE(0xffff, tooMany.layout.fonts.offset);
    expectRefused(tooMany, /font table ends before font/);
    const overrun = valid();
    overrun.table.writeUInt16LE(FONTS.length + 40, overrun.layout.fonts.offset);
    expectRefused(overrun, /font table/);
  });

  it('refuses a font entry that runs past the font table', () => {
    const parts = valid();
    parts.table[parts.layout.fonts.offset + 4] = 0xff;
    expectRefused(parts, /font table/);
  });

  it('refuses a style sheet too short for its default fonts and a font table outside the table stream', () => {
    const shortSheet = valid();
    shortSheet.word.writeUInt32LE(4, shortSheet.layout.pairOffset(1) + 4);
    expectRefused(shortSheet, /style sheet/);
    const outside = valid();
    outside.word.writeUInt32LE(outside.table.length - 2, outside.layout.pairOffset(15));
    expectRefused(outside, /font table lies outside/);
  });

  it('survives seeded mutations of the formatting structures without a hang or an untyped error', () => {
    const base = valid();
    const regions = [
      { target: 'table' as const, start: base.layout.plcBteChpx.offset, length: base.layout.plcBteChpx.length },
      { target: 'table' as const, start: base.layout.fonts.offset, length: base.layout.fonts.length },
      { target: 'table' as const, start: base.layout.styleSheet.offset, length: base.layout.styleSheet.length },
      { target: 'word' as const, start: base.layout.fkpPages[0], length: 512 },
    ];
    let state = FUZZ_SEED;
    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
    const started = Date.now();
    let refused = 0;
    let answered = 0;
    for (let i = 0; i < FUZZ_ITERATIONS; i++) {
      const word = Buffer.from(base.word);
      const table = Buffer.from(base.table);
      const region = regions[next() % regions.length];
      const flips = 1 + (next() % 4);
      for (let k = 0; k < flips; k++) {
        const at = region.start + (next() % region.length);
        (region.target === 'word' ? word : table)[at] = next() & 0xff;
      }
      const iterationStart = Date.now();
      try {
        extractTextFromDoc(wrap({ word, table, layout: base.layout }));
        answered++;
      } catch (err) {
        expect(err).toBeInstanceOf(LegacyOfficeFormatError);
        refused++;
      }
      expect(Date.now() - iterationStart).toBeLessThan(FUZZ_ITERATION_MS);
      if (Date.now() - started > FUZZ_BUDGET_MS) break;
    }
    expect(Date.now() - started).toBeLessThan(FUZZ_BUDGET_MS);
    expect(refused).toBeGreaterThan(0);
    expect(answered).toBeGreaterThan(0);
  });
});
