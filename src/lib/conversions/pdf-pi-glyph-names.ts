import { ADOBE_PI_GLYPH_LIST_LINES } from './pdf-adobe-pi-glyph-list';

/**
 * The text of a glyph of Adobe's pi fonts, which the Adobe Glyph List lacks: MathematicalPi-One to -Six and the Universal
 * families (`Universal-GreekwithMathPi`, `Universal-NewswithCommPi`) number their glyphs in a catalogue (`H11001` is the plus
 * sign, `H9262` the Greek letter mu, `H20849` and `H20850` the parentheses of a formula). The table is the one in
 * pdf-adobe-pi-glyph-list.ts; this file reads it and applies the two changes made after checking its values against the
 * pages of the corpus:
 *
 *  - the table gives the Greek letters as the bold letters of the Mathematical Alphanumeric Symbols block (U+1D6C2 to
 *    U+1D6FF and the capitals before them), which the glyphs of these fonts are drawn as but which no reader of a text wants:
 *    each is written as the Greek letter of its compatibility decomposition (U+1D6CD becomes U+03BC, "1 `H9262`m" is "1 μm");
 *  - `H11002` is the figure dash U+2012 in the table, and the glyph is the minus sign of a formula ("0.04 m s `H11002` 1" is
 *    "m s−1"), so it is U+2212.
 *
 * A name is read only in a font of these families. The catalogue numbers are Adobe's own, and a font of another maker may use
 * a name of this shape for any glyph.
 */

/** The fonts whose glyphs the catalogue names: the MathematicalPi family and the Universal families. */
const PI_FONT = /^(?:MathematicalPi|Universal-)/;
const SUBSET_TAG = /^[A-Z]{6}\+/;
const BOLD_GREEK_FIRST = 0x1d6a8;
const MATHEMATICAL_GREEK_LAST = 0x1d7cb;
const MINUS_SIGN = '−';
const FIGURE_DASH = '‒';
const MINUS_NAME = 'H11002';

let texts: Map<string, string> | undefined;

/** The character the table gives a name, as this reader writes it. */
function adaptedText(name: string, codePoints: number[]): string {
  const text = String.fromCodePoint(...codePoints);
  if (name === MINUS_NAME && text === FIGURE_DASH) return MINUS_SIGN;
  const only = codePoints.length === 1 ? codePoints[0] : 0;
  return only >= BOLD_GREEK_FIRST && only <= MATHEMATICAL_GREEK_LAST ? text.normalize('NFKC') : text;
}

function table(): Map<string, string> {
  if (texts === undefined) {
    texts = new Map();
    for (const line of ADOBE_PI_GLYPH_LIST_LINES) {
      const [name, values] = line.split(';');
      texts.set(name, adaptedText(name, values.split(' ').map((hex) => Number.parseInt(hex, 16))));
    }
  }
  return texts;
}

/** Whether the font (a BaseFont name, subset tag or not) is one whose glyphs the catalogue names. */
export function isAdobePiFontName(fontName: string): boolean {
  return PI_FONT.test(fontName.replace(SUBSET_TAG, ''));
}

/** The text of the catalogue name `name` (`H9262`) in a font of the pi families; null for another name or font. */
export function piGlyphNameToText(name: string, fontName: string): string | null {
  return isAdobePiFontName(fontName) ? (table().get(name) ?? null) : null;
}
