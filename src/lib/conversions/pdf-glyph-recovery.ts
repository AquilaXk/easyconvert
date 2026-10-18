import { glyphNameToText } from './pdf-glyph-names';
import { PdfTextGeometryError } from './pdf-text-types';
import { isSymbolFontName, mapSymbolFontCharacter } from './symbol-font-map';

/**
 * Text for the glyphs pdfjs gives no Unicode value for. pdfjs reads a font's /ToUnicode map first and then the names of
 * its /Encoding; a glyph it cannot map comes out as the character code itself (a control code) or as a private-use
 * character, which is not text. Before such a glyph is left out, two more sources are read:
 *
 *  - the name the font's encoding gives the code (the base encoding and its /Differences), through the Adobe Glyph List
 *    rules of pdf-glyph-names.ts: pdfjs maps `fi`, but not the `s_s` and `e_t_t` that a layout program writes for the
 *    ligatures of a typeface;
 *  - for the Symbol, Wingdings and Webdings families, the symbol-font tables of the office readers (symbol-font-map.ts)
 *    for the private-use character U+F000 + code that their fonts keep their glyphs at.
 *
 * A glyph neither source maps has no text: it is left out and counted, never replaced by a guess.
 */

/** Text with at least one character no reader can show: control codes other than white space, U+FFFD, private-use characters. */
// eslint-disable-next-line no-control-regex
const UNMAPPED_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u;
const PRIVATE_USE_BMP_START = 0xe000;
const PRIVATE_USE_BMP_END = 0xf8ff;
/** A control code that is the character code of a glyph of a simple font. */
const SINGLE_BYTE_CODES = 0x100;
const SUBSET_TAG = /^[A-Z]{6}\+/;
const ZAPF_DINGBATS_FONT = /dingbats/i;

/** The slice of a pdfjs font object (read with `fontExtraProperties`) that names the glyphs of a simple font. */
export interface RecoverableFont {
  name?: string;
  /** A Type 0 font: its codes are CIDs, which have no glyph names in the font dictionary. */
  composite?: boolean;
  /** `/Differences` of the font's encoding: the glyph name at a character code. */
  differences?: ArrayLike<string | null | undefined>;
  /** The names of the base encoding (or the font's built-in encoding) at a character code. */
  defaultEncoding?: ArrayLike<string | null | undefined>;
}

export interface RecoveredText {
  text: string;
  /** Characters that had no text and were left out. */
  unmapped: number;
}

/** Whether the text holds a character that stands for a glyph without a Unicode value. */
export function hasUnmappedGlyphs(text: string): boolean {
  return UNMAPPED_CHARACTER.test(text);
}

function isPrivateUse(codePoint: number): boolean {
  return codePoint >= PRIVATE_USE_BMP_START && codePoint <= PRIVATE_USE_BMP_END;
}

function fontNameOf(font: RecoverableFont | null): string {
  return typeof font?.name === 'string' ? font.name.replace(SUBSET_TAG, '') : '';
}

/** The text of a code of a simple font, per font: a font has at most 256 codes, so its names are read at most 256 times. */
const namedGlyphTexts = new WeakMap<RecoverableFont, Map<number, string | null>>();

function readNamedGlyph(code: number, font: RecoverableFont): string | null {
  const name = font.differences?.[code] || font.defaultEncoding?.[code];
  if (typeof name !== 'string' || name === '') return null;
  const text = glyphNameToText(name, { dingbats: ZAPF_DINGBATS_FONT.test(fontNameOf(font)) });
  return text !== null && !hasUnmappedGlyphs(text) ? text : null;
}

/** The text of a glyph that is the character code of a glyph of a simple font, read from the names of its encoding. */
function textOfNamedGlyph(code: number, font: RecoverableFont): string | null {
  if (font.composite === true) return null;
  let texts = namedGlyphTexts.get(font);
  if (texts === undefined) {
    texts = new Map();
    namedGlyphTexts.set(font, texts);
  }
  if (!texts.has(code)) texts.set(code, readNamedGlyph(code, font));
  return texts.get(code) ?? null;
}

function recoverGlyph(character: string, font: RecoverableFont | null): string | null {
  if (font === null) return null;
  const codePoint = character.codePointAt(0) as number;
  if (isPrivateUse(codePoint)) {
    const mapped = isSymbolFontName(fontNameOf(font)) ? mapSymbolFontCharacter(fontNameOf(font), codePoint) : undefined;
    return mapped ?? null;
  }
  return codePoint < SINGLE_BYTE_CODES ? textOfNamedGlyph(codePoint, font) : null;
}

/**
 * `text` with the glyphs that have a name in the font's encoding read, and the others left out and counted.
 *
 * @param maxChars the most characters the result may hold; a ligature name can make a glyph several characters long.
 * @throws PdfTextGeometryError (400) when the result grows past `maxChars`.
 */
export function recoverUnmappedGlyphs(text: string, font: RecoverableFont | null, maxChars = Number.POSITIVE_INFINITY): RecoveredText {
  let recovered = '';
  let unmapped = 0;
  for (const character of text) {
    if (!UNMAPPED_CHARACTER.test(character)) {
      recovered += character;
    } else {
      const mapped = recoverGlyph(character, font);
      if (mapped === null) unmapped++;
      else recovered += mapped;
    }
    if (recovered.length > maxChars) {
      throw new PdfTextGeometryError(`The text read from glyph names has more than ${maxChars} characters.`);
    }
  }
  return { text: recovered, unmapped };
}
