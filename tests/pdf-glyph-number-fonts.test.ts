import { describe, expect, it } from 'vitest';
import { type GlyphNumberFont, glyphNumberTexts } from '../src/lib/conversions/pdf-glyph-number-fonts';
import { timesAsciiWidths } from '../src/lib/conversions/standard-font-glyph-order';

/**
 * CG Times faces whose glyphs are named by their numbers in the converted TrueType font. The font below is the dictionary of
 * `DFGLPA+CG.Times095` of govdocs1-001389.pdf: /FirstChar 2, its 91 /Widths, and a /Differences of six names. The characters
 * expected are those the page shows: `G54 G74 G71` is "The", `G20 G15 G19` is "2-1" (the heading "SECTION 2").
 */

// prettier-ignore
const WIDTHS = [
  290, 0, 461, 0, 495, 890, 769, 330, 330, 330, 495, 0, 330, 337, 330, 330, 495, 495, 495, 495, 495, 495, 495, 495, 495, 495, 330, 330, 0, 0, 0, 0, 0,
  714, 626, 680, 736, 630, 593, 714, 736, 330, 385, 703, 626, 901, 740, 720, 571, 714, 659, 530, 630, 736, 714, 945, 714, 714, 0, 0, 0, 0, 0, 0, 0,
  439, 495, 439, 495, 439, 330, 495, 495, 275, 275, 495, 275, 769, 495, 495, 495, 495, 374, 385, 275, 495, 495, 714, 495, 495, 439,
];
const DIFFERENCES = [0, 'G0', 9, 'G9', 10, 'G10', 13, 'G13', 127, 'G127', 128, 'G128'];
const font: GlyphNumberFont = { baseFont: 'DFGLPA+CG.Times095', differences: DIFFERENCES, firstChar: 2, widths: WIDTHS };

const textOf = (texts: ReadonlyArray<[number, number]>, code: number): string | undefined => {
  const entry = texts.find(([key]) => key === code);
  return entry === undefined ? undefined : String.fromCodePoint(entry[1]);
};

describe('the glyph numbers of a CG Times face', () => {
  it('read as the characters of the Times order, the glyph number plus 30', () => {
    const texts = glyphNumberTexts(font);
    expect(['54', '74', '71'].map((code) => textOf(texts, Number(code))).join('')).toBe('The');
    expect([20, 15, 19].map((code) => textOf(texts, code)).join('')).toBe('2-1');
    expect(textOf(texts, 2)).toBe(' ');
    expect(textOf(texts, 92)).toBe('z');
  });

  it('give no text to a code that /Widths does not list', () => {
    const texts = glyphNumberTexts(font);
    expect(textOf(texts, 3)).toBeUndefined();
    expect(textOf(texts, 0)).toBeUndefined();
    expect(textOf(texts, 93)).toBeUndefined();
  });

  it('read a bold or italic face against the widths of the Times face of its style', () => {
    const italic = timesAsciiWidths('Times-Italic').slice(0, 95);
    const bold = timesAsciiWidths('Times-Bold').slice(0, 95);
    const face = (baseFont: string, widths: readonly number[]): GlyphNumberFont => ({ ...font, baseFont, widths });
    expect(textOf(glyphNumberTexts(face('DINKNI+CG.Times.Italic091', italic)), 54)).toBe('T');
    expect(textOf(glyphNumberTexts(face('DINKNI+CG.Times.Bold091', bold)), 54)).toBe('T');
    expect(glyphNumberTexts(face('CG.Times.Italic', bold))).toEqual([]);
    expect(glyphNumberTexts(face('CG.Times095', italic))).toEqual([]);
  });

  it('read nothing in a font that is not a CG Times face, or whose names are not the numbers of its codes', () => {
    expect(glyphNumberTexts({ ...font, baseFont: 'Times-Roman' })).toEqual([]);
    expect(glyphNumberTexts({ ...font, baseFont: null })).toEqual([]);
    expect(glyphNumberTexts({ ...font, differences: null })).toEqual([]);
    expect(glyphNumberTexts({ ...font, differences: [0, 'G1'] })).toEqual([]);
    expect(glyphNumberTexts({ ...font, differences: [0, 'G0', 'uni0041'] })).toEqual([]);
    expect(glyphNumberTexts({ ...font, differences: [] })).toEqual([]);
  });

  it('read nothing when the widths are not those of the Times order (one glyph out, or too few letters to tell)', () => {
    expect(glyphNumberTexts({ ...font, firstChar: 3 })).toEqual([]);
    expect(glyphNumberTexts({ ...font, firstChar: null })).toEqual([]);
    expect(glyphNumberTexts({ ...font, widths: null })).toEqual([]);
    expect(glyphNumberTexts({ ...font, widths: WIDTHS.slice(0, 20) })).toEqual([]);
    expect(glyphNumberTexts({ ...font, widths: WIDTHS.map((width) => width * 1.5) })).toEqual([]);
  });
});
