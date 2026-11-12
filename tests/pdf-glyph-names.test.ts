import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ADOBE_GLYPH_LIST, ZAPF_DINGBATS_GLYPH_LIST } from '../src/lib/conversions/pdf-glyph-list';
import { glyphNameToText } from '../src/lib/conversions/pdf-glyph-names';
import { PDFJS_GLYPH_LIST_ADDITIONS, SPECIAL_PRIVATE_USE_SYMBOLS } from '../src/lib/conversions/pdf-glyph-list-pdfjs';

/**
 * Glyph names to text. The expectations are the worked examples of the Adobe Glyph List specification, and the lists
 * themselves are compared with the glyph tables that pdfjs ships, a separate copy of the same data (the code under test
 * never reads them).
 */

const PDFJS_WORKER = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs');
const HEX_RADIX = 16;

/** The `name = code point` table a pdfjs lookup factory builds, read from the worker's source. */
function pdfjsTable(factory: string): Map<string, number> {
  const source = fs.readFileSync(PDFJS_WORKER, 'utf8');
  const start = source.indexOf(`const ${factory} = getLookupTableFactory(function (t) {`);
  expect(start, `${factory} in the pdfjs worker`).toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf('\n});', start));
  return new Map([...body.matchAll(/t\.(\w+) = 0x([0-9a-fA-F]+);/g)].map((match) => [match[1], Number.parseInt(match[2], HEX_RADIX)]));
}

/** The `code = code point` table of a lookup factory whose keys are numbers. */
function pdfjsNumberedTable(factory: string): Map<number, number> {
  const source = fs.readFileSync(PDFJS_WORKER, 'utf8');
  const start = source.indexOf(`const ${factory} = getLookupTableFactory(function (t) {`);
  expect(start, `${factory} in the pdfjs worker`).toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf('\n});', start));
  return new Map([...body.matchAll(/t\[(\d+)\] = 0x([0-9a-fA-F]+);/g)].map((match) => [Number(match[1]), Number.parseInt(match[2], HEX_RADIX)]));
}

function entriesOf(list: string): Array<[string, string]> {
  return list.split(',').map((entry) => entry.split(';') as [string, string]);
}

describe('the worked examples of the Adobe Glyph List specification', () => {
  it('maps a listed name, a uni name, a u name and a ligature with a suffix', () => {
    expect(glyphNameToText('Lcommaaccent')).toBe('Ļ');
    expect(glyphNameToText('uni20AC0308')).toBe('€̈');
    expect(glyphNameToText('u1040C')).toBe('\u{1040C}');
    expect(glyphNameToText('Lcommaaccent_uni20AC0308_u1040C.alternate')).toBe('Ļ€̈\u{1040C}');
  });

  it('maps a uni name that holds a surrogate code unit, an unknown name and .notdef to nothing', () => {
    expect(glyphNameToText('uniD801DC0C')).toBeNull();
    expect(glyphNameToText('foo')).toBeNull();
    expect(glyphNameToText('.notdef')).toBeNull();
    expect(glyphNameToText('uni20ac')).toBeNull();
    expect(glyphNameToText('u110000')).toBeNull();
  });

  it('writes the ligatures of typesetting systems as the letters they join', () => {
    expect(glyphNameToText('f_f_i')).toBe('ffi');
    expect(glyphNameToText('s_s')).toBe('ss');
    expect(glyphNameToText('e_t_t')).toBe('ett');
    expect(glyphNameToText('fi')).toBe('fi');
    expect(glyphNameToText('ffl')).toBe('ffl');
  });

  it('maps no ligature that has a component no rule maps, so a half-mapped ligature never reaches the text', () => {
    expect(glyphNameToText('f_zzz')).toBeNull();
    expect(glyphNameToText('a_b_.swash')).toBeNull();
  });
});

describe('the names pdf.js adds to the Adobe Glyph List', () => {
  it('maps the glyph names of the TeX fonts and the names the list misses', () => {
    expect(glyphNameToText('parenleftbig')).toBe('(');
    expect(glyphNameToText('bracketrightBigg')).toBe(']');
    expect(glyphNameToText('angbracketleftbig')).toBe('\u2329');
    expect(glyphNameToText('summationtext')).toBe('\u2211');
    expect(glyphNameToText('integraldisplay')).toBe('\u222B');
    expect(glyphNameToText('bracehtipdownleft')).toBe('\uFE37');
    expect(glyphNameToText('angbracketleft')).toBe('\u3008');
    expect(glyphNameToText('planckover2pi')).toBe('\u210F');
    expect(glyphNameToText('circlecopyrt')).toBe('\u00A9');
  });

  it('reads them in a ligature and with a suffix, like any listed name', () => {
    expect(glyphNameToText('summationtext.alt')).toBe('\u2211');
    expect(glyphNameToText('parenleftbig_parenrightbig')).toBe('()');
    expect(glyphNameToText('parenleftbig_zzz')).toBeNull();
  });

  it('lists no name twice with the Adobe Glyph List, and gives each the code point pdfjs gives it', () => {
    const pdfjs = pdfjsTable('getGlyphsUnicode');
    const adobe = new Set(entriesOf(ADOBE_GLYPH_LIST).map(([name]) => name));
    const names = Object.keys(PDFJS_GLYPH_LIST_ADDITIONS);
    expect(names.length).toBeGreaterThan(110);
    expect(names.filter((name) => adobe.has(name))).toEqual([]);
    expect(names.filter((name) => pdfjs.get(name) !== PDFJS_GLYPH_LIST_ADDITIONS[name])).toEqual([]);
  });

  it('keeps the characters pdfjs draws private-use glyphs as, and no more', () => {
    const pdfjs = pdfjsNumberedTable('getSpecialPUASymbols');
    expect(pdfjs.size).toBe(27);
    expect(new Map(Object.entries(SPECIAL_PRIVATE_USE_SYMBOLS).map(([code, point]) => [Number(code), point]))).toEqual(pdfjs);
  });
});

describe('names that no table maps', () => {
  it('maps the glyph numbers of a printer driver and the catalogue names of the Mathematical Pi fonts to nothing, never to a guess', () => {
    for (const name of ['G101', 'G69', 'g0041', 'C24', 'H20849', 'H9262', 'H11011', 'MT69']) expect(glyphNameToText(name), name).toBeNull();
  });

  it('maps a uni or u name that holds a character that is not an uppercase hexadecimal digit to nothing', () => {
    expect(glyphNameToText('uni03BC')).toBe('\u03BC');
    for (const name of ['uni03bc', 'uniZZZZ', 'uni03B', 'uni03BCG', 'u12G4', 'u+0041', 'u0041 ', 'uni']) expect(glyphNameToText(name), name).toBeNull();
  });

  it('maps a name of 100 KB made of a listed name, a catalogue number or hexadecimal digits to nothing', () => {
    expect(glyphNameToText('parenleftbig'.repeat(10_000))).toBeNull();
    expect(glyphNameToText(`H${'9'.repeat(100_000)}`)).toBeNull();
    expect(glyphNameToText(`u${'F'.repeat(100_000)}`)).toBeNull();
    expect(glyphNameToText(`parenleftbig${'_parenleftbig'.repeat(10_000)}`)).toBeNull();
  });
});

describe('the length of a glyph name', () => {
  /** ISO 32000-2 Annex C: a name holds at most 127 bytes. */
  const MAX_NAME_LENGTH = 127;

  it('maps a ligature name of 127 characters and nothing longer', () => {
    const atLimit = Array.from({ length: 64 }, () => 'f').join('_');
    expect(atLimit).toHaveLength(MAX_NAME_LENGTH);
    expect(glyphNameToText(atLimit)).toBe('f'.repeat(64));
    expect(glyphNameToText(`${atLimit}x`)).toBeNull();
    expect(glyphNameToText(`${atLimit}_f`)).toBeNull();
  });

  it('maps a uni name of 127 characters, 31 code units, and not one more', () => {
    const atLimit = `uni${'0041'.repeat(31)}`;
    expect(atLimit).toHaveLength(MAX_NAME_LENGTH);
    expect(glyphNameToText(atLimit)).toBe('A'.repeat(31));
    expect(glyphNameToText(`${atLimit}0041`)).toBeNull();
  });

  it('maps no name of 100 KB, whatever it is made of', () => {
    expect(glyphNameToText('f_'.repeat(50_000))).toBeNull();
    expect(glyphNameToText(`uni${'0041'.repeat(25_000)}`)).toBeNull();
  });
});

describe('the Zapf Dingbats names', () => {
  it('map for a Zapf Dingbats font only, because other fonts number their glyphs with the same names', () => {
    expect(glyphNameToText('a1')).toBeNull();
    expect(glyphNameToText('a1', { dingbats: true })).toBe('✁');
    expect(glyphNameToText('a16', { dingbats: false })).toBeNull();
  });

  it('reads the brackets, the last name and a ligature of Zapf Dingbats names, and no name past the list', () => {
    expect(glyphNameToText('a89', { dingbats: true })).toBe('\u2768');
    expect(glyphNameToText('a206', { dingbats: true })).toBe('\u2770');
    expect(glyphNameToText('a89_a90', { dingbats: true })).toBe('\u2768\u2769');
    expect(glyphNameToText('a207', { dingbats: true })).toBeNull();
    expect(glyphNameToText('a'.concat('9'.repeat(1000)), { dingbats: true })).toBeNull();
  });
});

describe('the vendored lists against the glyph tables of pdfjs', () => {
  it('gives every Adobe Glyph List name of a single character the code point pdfjs gives it', () => {
    const pdfjs = pdfjsTable('getGlyphsUnicode');
    const single = entriesOf(ADOBE_GLYPH_LIST).filter(([, points]) => !points.includes(' '));
    expect(single.length).toBeGreaterThan(4000);
    const wrong = single.filter(([name, points]) => pdfjs.get(name) !== Number.parseInt(points, HEX_RADIX));
    expect(wrong).toEqual([]);
  });

  it('gives every Zapf Dingbats name the code point pdfjs gives it', () => {
    const pdfjs = pdfjsTable('getDingbatsGlyphsUnicode');
    const entries = entriesOf(ZAPF_DINGBATS_GLYPH_LIST);
    expect(entries.length).toBeGreaterThan(190);
    const wrong = entries.filter(([name, points]) => pdfjs.get(name) !== Number.parseInt(points, HEX_RADIX));
    expect(wrong).toEqual([]);
  });
});
