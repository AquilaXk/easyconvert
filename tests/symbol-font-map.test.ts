import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  isSymbolFontName,
  isSymbolFontPrivateUse,
  mapSymbolFontCharacter,
  SYMBOL_FONT_FIRST_CODE,
  SYMBOL_FONT_LAST_CODE,
  SYMBOL_FONT_PRIVATE_USE_BASE,
} from '../src/lib/conversions/symbol-font-map';

const HEX = 16;

/** Oracle for Symbol: the standard Symbol font of pdf-lib (Adobe AFM glyph names through the Adobe Glyph List). */
async function adobeSymbolCodes(): Promise<Map<number, string[]>> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Symbol);
  const byCode = new Map<number, string[]>();
  for (const codePoint of font.getCharacterSet()) {
    const code = Number.parseInt(font.encodeText(String.fromCodePoint(codePoint)).toString().replace(/[<>]/g, ''), HEX);
    byCode.set(code, [...(byCode.get(code) ?? []), String.fromCodePoint(codePoint)]);
  }
  return byCode;
}

const privateUse = (code: number): number => SYMBOL_FONT_PRIVATE_USE_BASE + code;

describe('symbol font tables', () => {
  it('maps every Symbol code the Adobe standard font defines to the character that font names', async () => {
    const oracle = await adobeSymbolCodes();
    const differences: string[] = [];
    for (const [code, allCharacters] of oracle) {
      // The Glyph List gives Adobe's construction pieces private-use values; the test below pins their standard characters.
      const characters = allCharacters.filter((character) => !/\p{Co}/u.test(character));
      if (code < SYMBOL_FONT_FIRST_CODE || characters.length === 0) continue;
      const mapped = mapSymbolFontCharacter('Symbol', privateUse(code));
      const agree = mapped !== undefined && characters.some((character) => character.normalize('NFC') === mapped.normalize('NFC'));
      if (!agree) differences.push(`0x${code.toString(HEX)}: ${mapped ?? 'unmapped'} vs ${characters.join('|')}`);
    }
    expect(differences).toEqual([]);
  });

  it('maps the Office bullet characters of Wingdings to the characters the glyphs depict', () => {
    // Glyph shapes as drawn by the font: filled square, small square, four diamonds, check mark, arrowhead.
    expect(mapSymbolFontCharacter('Wingdings', 0xf0a7)).toBe('▪');
    expect(mapSymbolFontCharacter('Wingdings', 0xf076)).toBe('❖');
    expect(mapSymbolFontCharacter('Wingdings', 0xf0fc)).toBe('✓');
    expect(mapSymbolFontCharacter('Wingdings', 0xf0d8)).toBe('\u{2B9A}');
    expect(mapSymbolFontCharacter('Wingdings', 0xf0e0)).toBe('\u{1F86A}');
  });

  it('maps the construction pieces of Symbol to the characters Unicode names for the same role', () => {
    expect(mapSymbolFontCharacter('Symbol', 0xf0e6)).toBe('\u239B'); // LEFT PARENTHESIS UPPER HOOK
    expect(mapSymbolFontCharacter('Symbol', 0xf0ee)).toBe('\u23A9'); // LEFT CURLY BRACKET LOWER HOOK
    expect(mapSymbolFontCharacter('Symbol', 0xf0f4)).toBe('\u23AE'); // INTEGRAL EXTENSION
    expect(mapSymbolFontCharacter('Symbol', 0xf0bd)).toBe('\u23D0'); // VERTICAL LINE EXTENSION
    expect(mapSymbolFontCharacter('Symbol', 0xf0d3)).toBe('\u00A9'); // COPYRIGHT SIGN, serif form
  });

  it('selects the table by font name, ignoring case, spacing and foundry suffixes', () => {
    expect(mapSymbolFontCharacter('SYMBOL', 0xf0b7)).toBe('•');
    expect(mapSymbolFontCharacter('SymbolMT', 0xf0b7)).toBe('•');
    expect(mapSymbolFontCharacter('Wingdings 3', 0xf025)).toBe(mapSymbolFontCharacter('Wingdings3', 0xf025));
    expect(mapSymbolFontCharacter('Wingdings 3', 0xf025)).not.toBe(mapSymbolFontCharacter('Wingdings', 0xf025));
    expect(isSymbolFontName('Wingdings-Regular')).toBe(true);
    expect(isSymbolFontName('Arial')).toBe(false);
    expect(mapSymbolFontCharacter('Arial', 0xf0b7)).toBeUndefined();
  });

  it('maps the space of every symbol font to U+0020', () => {
    for (const font of ['Symbol', 'Wingdings', 'Wingdings 2', 'Wingdings 3', 'Webdings']) {
      expect({ font, mapped: mapSymbolFontCharacter(font, 0xf020) }).toEqual({ font, mapped: ' ' });
    }
  });

  it('has no counterpart for codes the symbol font leaves without a Unicode character', () => {
    expect(mapSymbolFontCharacter('Wingdings', 0xf0ff)).toBeUndefined();
    expect(mapSymbolFontCharacter('Symbol', 0xf060)).toBeUndefined();
    expect(isSymbolFontPrivateUse(0xf01f)).toBe(false);
    expect(isSymbolFontPrivateUse(0xf020)).toBe(true);
    expect(isSymbolFontPrivateUse(0xf0ff)).toBe(true);
    expect(isSymbolFontPrivateUse(0xf100)).toBe(false);
    expect(SYMBOL_FONT_LAST_CODE).toBe(0xff);
  });
});

describe('WordPerfect Greek fonts', () => {
  /**
   * The WP Greek TrueType fonts lay the WordPerfect character set 8 out from code 0x21, in alphabet order as capital and
   * small pairs: the Greek alphabet is the oracle (Unicode Greek and Coptic block, letter names), written out by hand.
   * Slots the set fills with a repeat of another letter (a second capital beta, a second capital sigma) have no glyph of
   * their own, and nothing maps them.
   */
  const ALPHABET: ReadonlyArray<readonly [number, string]> = [
    [0x21, 'Α'], [0x22, 'α'], [0x23, 'Β'], [0x24, 'β'], [0x26, 'ϐ'], [0x27, 'Γ'], [0x28, 'γ'], [0x29, 'Δ'], [0x2a, 'δ'],
    [0x2b, 'Ε'], [0x2c, 'ε'], [0x2d, 'Ζ'], [0x2e, 'ζ'], [0x2f, 'Η'], [0x30, 'η'], [0x31, 'Θ'], [0x32, 'θ'], [0x33, 'Ι'],
    [0x34, 'ι'], [0x35, 'Κ'], [0x36, 'κ'], [0x37, 'Λ'], [0x38, 'λ'], [0x39, 'Μ'], [0x3a, 'μ'], [0x3b, 'Ν'], [0x3c, 'ν'],
    [0x3d, 'Ξ'], [0x3e, 'ξ'], [0x3f, 'Ο'], [0x40, 'ο'], [0x41, 'Π'], [0x42, 'π'], [0x43, 'Ρ'], [0x44, 'ρ'], [0x45, 'Σ'],
    [0x46, 'σ'], [0x48, 'ς'], [0x49, 'Τ'], [0x4a, 'τ'], [0x4b, 'Υ'], [0x4c, 'υ'], [0x4d, 'Φ'], [0x4e, 'φ'], [0x4f, 'Χ'],
    [0x50, 'χ'], [0x51, 'Ψ'], [0x52, 'ψ'], [0x53, 'Ω'], [0x54, 'ω'],
  ];

  it('maps the letters of every WP Greek face to the Greek alphabet in order', () => {
    for (const font of ['WP Greek Century', 'WP Greek Courier', 'WP Greek Helve']) {
      const differences = ALPHABET.filter(([code, letter]) => mapSymbolFontCharacter(font, privateUse(code)) !== letter);
      expect({ font, differences }).toEqual({ font, differences: [] });
    }
  });

  it('maps the characters the Greek letters of two public documents stand for', () => {
    // govdocs1-001634: "TGF" + alpha; govdocs1-004581: "10" + sigma, "3.5" + mu + "m", "Lyman" + alpha, "Delta".
    expect(mapSymbolFontCharacter('WP Greek Century', 0xf022)).toBe('\u03B1');
    expect(mapSymbolFontCharacter('WP Greek Courier', 0xf046)).toBe('\u03C3');
    expect(mapSymbolFontCharacter('WP Greek Courier', 0xf03a)).toBe('\u03BC');
    expect(mapSymbolFontCharacter('WP Greek Courier', 0xf029)).toBe('\u0394');
  });

  it('selects the table for a WP Greek face and for no other WP face', () => {
    expect(isSymbolFontName('WP Greek Century')).toBe(true);
    expect(isSymbolFontName('wpgreekcourier')).toBe(true);
    expect(isSymbolFontName('WP Greek')).toBe(true);
    expect(isSymbolFontName('WP MathA')).toBe(false);
    expect(isSymbolFontName('Greek Century')).toBe(false);
    expect(mapSymbolFontCharacter('WP Greek Courier', 0xf020)).toBe(' ');
  });

  it('leaves the slots the set repeats and the codes beyond the verified letters unmapped', () => {
    expect(mapSymbolFontCharacter('WP Greek Courier', 0xf025)).toBeUndefined();
    expect(mapSymbolFontCharacter('WP Greek Courier', 0xf047)).toBeUndefined();
    expect(mapSymbolFontCharacter('WP Greek Courier', 0xf0ff)).toBeUndefined();
  });
});

