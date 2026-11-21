import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ADOBE_PI_GLYPH_LIST_LINES } from '../src/lib/conversions/pdf-adobe-pi-glyph-list';
import { recoverUnmappedGlyphs, type RecoverableFont } from '../src/lib/conversions/pdf-glyph-recovery';
import { isAdobePiFontName, piGlyphNameToText } from '../src/lib/conversions/pdf-pi-glyph-names';

/**
 * The catalogue names of Adobe's pi fonts. The expected characters are those the pages of the corpus show where the
 * glyph stands (govdocs1-004161.pdf: "0.04 m Pa" and a minus before the 1 of "Pa-1"; govdocs1-000839.pdf: "10.8" and the
 * Greek mu of "um", parentheses around "FDTD"), not values read back from the table under test.
 */

const names = (entries: Record<number, string>): string[] => {
  const list: string[] = [];
  for (const [code, name] of Object.entries(entries)) list[Number(code)] = name;
  return list;
};

describe('the copied table', () => {
  it('has the 503 lines of docling-parse MathematicalPi.dat, unchanged', () => {
    expect(ADOBE_PI_GLYPH_LIST_LINES).toHaveLength(503);
    const digest = createHash('sha256').update(`${ADOBE_PI_GLYPH_LIST_LINES.join('\n')}\n`).digest('hex');
    expect(digest).toBe('effe9c2ca001d496b4060c8eb84e0b215fa3ded01efc0619cb6cff525d9506f7');
  });
});

describe('the catalogue name of a glyph in a pi font', () => {
  it('reads the plain signs and the parentheses of a formula', () => {
    expect(piGlyphNameToText('H11001', 'MathematicalPi-One')).toBe('+');
    expect(piGlyphNameToText('H11005', 'MathematicalPi-One')).toBe('=');
    expect(piGlyphNameToText('H11006', 'Universal-GreekwithMathPi')).toBe('±');
    expect(piGlyphNameToText('H20849', 'MathematicalPi-Three')).toBe('(');
    expect(piGlyphNameToText('H20850', 'MathematicalPi-Three')).toBe(')');
  });

  it('writes the bold Greek letters of the table as Greek letters', () => {
    expect(piGlyphNameToText('H9262', 'MathematicalPi-One')).toBe('μ');
    expect(piGlyphNameToText('H9004', 'Universal-GreekwithMathPi')).toBe('Δ');
    expect(piGlyphNameToText('H9268', 'Universal-GreekwithMathPi')).toBe('σ');
  });

  it('writes the glyph the table calls a figure dash as the minus sign', () => {
    expect(piGlyphNameToText('H11002', 'MathematicalPi-One')).toBe('−');
  });

  it('keeps a base character with its combining mark and the letters that are not Greek', () => {
    expect(piGlyphNameToText('H11325', 'MathematicalPi-Six')).toBe('≦̸');
    expect(piGlyphNameToText('H11928', 'MathematicalPi-Six')).toBe('ℍ');
  });

  it('leaves out a glyph that is a combining mark alone, which would attach to the wrong letter', () => {
    expect(piGlyphNameToText('H33527', 'MathematicalPi-Five')).toBeNull();
  });

  it('reads a subset of the family and nothing in another font', () => {
    expect(piGlyphNameToText('H11001', 'ABCDEF+MathematicalPi-One')).toBe('+');
    expect(piGlyphNameToText('H11001', 'Times-Roman')).toBeNull();
    expect(piGlyphNameToText('H11001', '')).toBeNull();
    expect(isAdobePiFontName('XYZABC+Universal-NewswithCommPi')).toBe(true);
    expect(isAdobePiFontName('MyMathematicalPi')).toBe(false);
  });

  it('knows no name outside the table', () => {
    expect(piGlyphNameToText('H99999', 'MathematicalPi-One')).toBeNull();
    expect(piGlyphNameToText('G101', 'MathematicalPi-One')).toBeNull();
  });
});

describe('a glyph of a pi font whose name is in the catalogue', () => {
  const font: RecoverableFont = { name: 'ABCDEF+MathematicalPi-One', differences: names({ 1: 'H11001', 2: 'H9262', 3: 'H11002', 4: 'H99999' }) };

  it('is read by its name, and a name the catalogue lacks is left out and counted', () => {
    expect(recoverUnmappedGlyphs('1\u00012\u00023\u00034\u0004', font)).toEqual({ text: '1+2μ3−4', unmapped: 1 });
  });

  it('is left out in a font that is not a pi font', () => {
    expect(recoverUnmappedGlyphs('\u0001', { ...font, name: 'Garamond' })).toEqual({ text: '', unmapped: 1 });
  });
});
