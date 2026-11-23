import { describe, expect, it } from 'vitest';
import {
  isOpenSymbolFontName,
  mapOpenSymbolCharacter,
  OPEN_SYMBOL_PUA_END,
  OPEN_SYMBOL_PUA_START,
} from '../src/lib/conversions/pdf-opensymbol-map';
import { PdfTextGeometryError } from '../src/lib/conversions/pdf-text-types';
import { recoverUnmappedGlyphs } from '../src/lib/conversions/pdf-glyph-recovery';
import { isSymbolFontName, mapSymbolFontCharacter } from '../src/lib/conversions/symbol-font-map';

/**
 * Unit coverage for OpenSymbol / StarSymbol / StarMath private-use glyphs (0xE080..0xE0DD) and
 * URW StandardSymL mapping through Adobe's Symbol table.
 */

const GREEK_UPPER: ReadonlyArray<readonly [number, string]> = [
  [0xe0ac, 'Γ'], [0xe0ad, 'Δ'], [0xe0ae, 'Θ'], [0xe0af, 'Λ'], [0xe0b0, 'Ξ'],
  [0xe0b1, 'Π'], [0xe0b2, 'Σ'], [0xe0b3, 'Υ'], [0xe0b4, 'Φ'], [0xe0b5, 'Ψ'], [0xe0b6, 'Ω'],
];

const GREEK_LOWER: ReadonlyArray<readonly [number, string]> = [
  [0xe0b7, 'α'], [0xe0b8, 'β'], [0xe0b9, 'γ'], [0xe0ba, 'δ'], [0xe0bb, 'ε'], [0xe0bc, 'ζ'],
  [0xe0bd, 'η'], [0xe0be, 'θ'], [0xe0bf, 'ι'], [0xe0c0, 'κ'], [0xe0c1, 'λ'], [0xe0c2, 'μ'],
  [0xe0c3, 'ν'], [0xe0c4, 'ξ'], [0xe0c5, 'ο'], [0xe0c6, 'π'], [0xe0c7, 'ρ'], [0xe0c8, 'σ'],
  [0xe0c9, 'τ'], [0xe0ca, 'υ'], [0xe0cb, 'φ'], [0xe0cc, 'χ'], [0xe0cd, 'ψ'], [0xe0ce, 'ω'],
];

const MATH_OPERATORS_AND_ARROWS: ReadonlyArray<readonly [number, string]> = [
  [0xe080, '‰'], [0xe081, '⏟'], [0xe082, '⏞'], [0xe083, '+'], [0xe084, '<'],
  [0xe085, '>'], [0xe086, '⩽'], [0xe087, '⩾'], [0xe089, '∈'], [0xe08a, 'ƒ'],
  [0xe08b, '…'], [0xe08c, '→'], [0xe08d, '√'], [0xe08e, '√'], [0xe08f, '√'],
  [0xe09e, '('], [0xe09f, ')'], [0xe0a0, '∡'], [0xe0a6, '′'], [0xe0a7, '|'],
  [0xe0a8, '/'], [0xe0a9, '\\'], [0xe0ab, '|'], [0xe0cf, 'ε'], [0xe0d0, 'ϑ'],
  [0xe0d1, 'ϖ'], [0xe0d3, 'ς'], [0xe0d4, 'ϕ'], [0xe0d5, '∂'], [0xe0d6, 'ı'],
  [0xe0d9, '⊤'], [0xe0db, '←'], [0xe0dc, '↑'], [0xe0dd, '↓'],
];

describe('OpenSymbol and StarSymbol private-use mappings', () => {
  it('recognizes OpenSymbol, StarSymbol, and StarMath with or without subset tags or suffixes', () => {
    for (const name of ['OpenSymbol', 'DAAAAA+OpenSymbol', 'OpenSymbol-Regular', 'StarSymbol', 'ABCDEF+StarMath']) {
      expect(isOpenSymbolFontName(name), name).toBe(true);
      expect(isSymbolFontName(name), name).toBe(true);
    }
    for (const name of ['Arial', 'Symbol', 'CMEX10', 'Wingdings']) {
      expect(isOpenSymbolFontName(name), name).toBe(false);
    }
    expect(OPEN_SYMBOL_PUA_START).toBe(0xe080);
    expect(OPEN_SYMBOL_PUA_END).toBe(0xe0dd);
  });

  it('maps Greek capitals, lowercase letters, variant symbols, operators, and arrows', () => {
    for (const [codePoint, expected] of [...GREEK_UPPER, ...GREEK_LOWER, ...MATH_OPERATORS_AND_ARROWS]) {
      expect(mapOpenSymbolCharacter('DAAAAA+OpenSymbol', codePoint), `U+${codePoint.toString(16)}`).toBe(expected);
      expect(mapSymbolFontCharacter('OpenSymbol', codePoint), `U+${codePoint.toString(16)}`).toBe(expected);
    }
  });

  it('leaves standalone positioned math accents unmapped and refuses non-OpenSymbol fonts', () => {
    for (let cp = 0xe090; cp <= 0xe09b; cp++) {
      expect(mapOpenSymbolCharacter('OpenSymbol', cp), `U+${cp.toString(16)}`).toBeUndefined();
    }
    for (const font of ['Arial', 'Symbol', 'CMEX10']) {
      expect(mapOpenSymbolCharacter(font, 0xe09e)).toBeUndefined();
      expect(mapSymbolFontCharacter(font, 0xe083)).toBeUndefined();
    }
  });
});

describe('URW StandardSymL mapping', () => {
  it('routes StandardSymL through the Adobe Symbol table', () => {
    expect(isSymbolFontName('StandardSymL')).toBe(true);
    expect(isSymbolFontName('ABCDEF+StandardSymL')).toBe(true);
    expect(mapSymbolFontCharacter('StandardSymL', 0xf079)).toBe('ψ');
    expect(mapSymbolFontCharacter('StandardSymL', 0xf0b7)).toBe('•');
  });
});

describe('recoverUnmappedGlyphs with OpenSymbol and StandardSymL', () => {
  it('recovers equations and Greek text while leaving standalone OpenSymbol accents unmapped', () => {
    expect(recoverUnmappedGlyphs('Q = I3 \uE083 (B \uE083 S)/2', { name: 'DAAAAA+OpenSymbol', composite: true })).toEqual({
      text: 'Q = I3 + (B + S)/2',
      unmapped: 0,
    });
    expect(recoverUnmappedGlyphs('0 \uE086 \uE0C1 \uE086 1', { name: 'OpenSymbol' })).toEqual({
      text: '0 ⩽ λ ⩽ 1',
      unmapped: 0,
    });
    expect(recoverUnmappedGlyphs('\uE091s', { name: 'OpenSymbol' })).toEqual({
      text: 's',
      unmapped: 1,
    });
    expect(recoverUnmappedGlyphs('\uF079', { name: 'StandardSymL' })).toEqual({
      text: 'ψ',
      unmapped: 0,
    });
    expect(recoverUnmappedGlyphs('\uF079', { name: 'ABCDEF+StandardSymL' })).toEqual({
      text: 'ψ',
      unmapped: 0,
    });
  });

  it('enforces maxChars fail-closed when recovering repeated OpenSymbol private-use characters', () => {
    expect(() => recoverUnmappedGlyphs('\uE09E'.repeat(20), { name: 'OpenSymbol' }, 10)).toThrow(PdfTextGeometryError);
  });
});
