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
