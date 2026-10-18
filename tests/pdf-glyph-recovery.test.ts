import { describe, expect, it } from 'vitest';
import { hasUnmappedGlyphs, recoverUnmappedGlyphs, type RecoverableFont } from '../src/lib/conversions/pdf-glyph-recovery';

/**
 * Glyphs pdfjs gives no Unicode value for: read from the names of the font's encoding or the tables of a symbol font,
 * or left out and counted. The expected characters come from the Adobe Glyph List and from the Adobe Symbol encoding
 * (the Greek letter alpha is the glyph at code 0x61 of Symbol), not from the code under test.
 */

const names = (entries: Record<number, string>): string[] => {
  const list: string[] = [];
  for (const [code, name] of Object.entries(entries)) list[Number(code)] = name;
  return list;
};

describe('which characters stand for a glyph without a Unicode value', () => {
  it('flags control codes, the replacement character and private-use characters, and nothing else', () => {
    for (const text of ['\u0001', '\u001f', '\u007f', '\ufffd', '\ue000', '\uf8ff', '\u{f0000}', '\u{10fffd}']) expect(hasUnmappedGlyphs(text), JSON.stringify(text)).toBe(true);
    for (const text of ['A', ' ', '\t', '\n', '\r', 'é', '日本', '\u00a0', '\u2028', 'ﬁ', '\u{1f600}', '\u{20000}', '\u{1d400}']) expect(hasUnmappedGlyphs(text), JSON.stringify(text)).toBe(false);
  });
});

describe('a glyph that has a name in the encoding of a simple font', () => {
  const font: RecoverableFont = { name: 'ABCDEF+Garamond', differences: names({ 1: 'f_f_i', 2: 's_s', 3: 'fi', 4: 'uni20AC', 5: 'ornamentone' }), defaultEncoding: names({ 6: 'germandbls' }) };

  it('is read through the Adobe Glyph List rules', () => {
    expect(recoverUnmappedGlyphs('o\u0001ce \u0002 \u0003 \u0004 \u0006', font)).toEqual({ text: 'office ss fi € ß', unmapped: 0 });
  });

  it('is left out and counted when its name maps to nothing, or when the font has no such name', () => {
    expect(recoverUnmappedGlyphs('a\u0005b\u0007c�d', font)).toEqual({ text: 'abcd', unmapped: 3 });
  });

  it('is left out for a composite font, whose codes are not glyph names, and when no font is known', () => {
    expect(recoverUnmappedGlyphs('a\u0001b', { ...font, composite: true })).toEqual({ text: 'ab', unmapped: 1 });
    expect(recoverUnmappedGlyphs('a\u0001b', null)).toEqual({ text: 'ab', unmapped: 1 });
  });

  it('keeps the characters that already have text untouched', () => {
    expect(recoverUnmappedGlyphs('Ünïcode 日本 \u0001', font)).toEqual({ text: 'Ünïcode 日本 ffi', unmapped: 0 });
  });
});

describe('names that mean something else in a bitmap font and in Zapf Dingbats', () => {
  it('reads a1 to a206 only in a Zapf Dingbats font', () => {
    const differences = names({ 1: 'a1' });
    expect(recoverUnmappedGlyphs('\u0001', { name: 'Type3', differences })).toEqual({ text: '', unmapped: 1 });
    expect(recoverUnmappedGlyphs('\u0001', { name: 'ZapfDingbats', differences })).toEqual({ text: '✁', unmapped: 0 });
  });
});

describe('private-use characters', () => {
  it('are read from the table of a symbol font and left out for any other font', () => {
    expect(recoverUnmappedGlyphs('', { name: 'ABCDEF+Symbol' })).toEqual({ text: 'α', unmapped: 0 });
    expect(recoverUnmappedGlyphs('', { name: 'Arial' })).toEqual({ text: '', unmapped: 1 });
    expect(recoverUnmappedGlyphs('', { name: 'cmex10' })).toEqual({ text: '', unmapped: 2 });
  });
});
