import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ADOBE_GLYPH_LIST, ZAPF_DINGBATS_GLYPH_LIST } from '../src/lib/conversions/pdf-glyph-list';
import { glyphNameToText } from '../src/lib/conversions/pdf-glyph-names';

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

describe('the Zapf Dingbats names', () => {
  it('map for a Zapf Dingbats font only, because other fonts number their glyphs with the same names', () => {
    expect(glyphNameToText('a1')).toBeNull();
    expect(glyphNameToText('a1', { dingbats: true })).toBe('✁');
    expect(glyphNameToText('a16', { dingbats: false })).toBeNull();
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
