import { glyphNameToText } from './pdf-glyph-names';

/**
 * The characters of a simple font whose /Differences glyph names are numbers, as Poppler reads them (`poppler/GfxFont.cc`
 * 26.09, `Gfx8BitFont::Gfx8BitFont` lines 1228 to 1295, `parseNumericName` lines 865 to 909 and `testForNumericNames`
 * lines 913 to 943; GPL, followed for its behaviour only). A font is read this way only when every name of its
 * /Differences is a number after at most two letters (`G101`, `MT69`, `g110`) and every run of codes starts at 5 or below;
 * the number of a name that the Adobe Glyph List does not know (with the ZapfDingbats list for a font whose name ends in
 * `ZapfDingbats`, line 1084) is then its character. The numbers are decimal, or hexadecimal when an unknown name is two
 * hexadecimal digits with a letter digit last, or a letter and two hexadecimal digits with a letter digit among them (`Cf`,
 * `Ga5`). Poppler makes that choice per font; it is made here for the document, because one producer names the glyphs of
 * all its fonts the same way and a small subset may hold no letter digit: in `gd-915462.pdf` a font named `G46 G49 G47 G55
 * G52 G45` ("FIGURE" in hexadecimal) sits beside fonts named `G4D` and `G2C`, and read per font it gives `.1/74-`.
 *
 * pdf.js reads such names by its own rules (`src/core/evaluator.js`, `_simpleFontToUnicode`: two hexadecimal digits after
 * `G`, four after `g`, two or three decimal digits after `C`), so it reads `G69` as `i` and leaves `G101` and `MT69` as
 * the code itself. Printers write these names for TrueType fonts they convert: the number is the character code in the
 * font's code page (`G69` is "E"). Poppler's rule reads every number, and the symbol fonts that number their glyphs in a
 * catalogue (`H20849` of the MathematicalPi fonts) then read as unrelated characters (U+5171); only numbers that are a
 * character of a one-byte code page (U+0020 to U+007E and U+00A0 to U+00FF) are taken, and any other glyph keeps the text
 * pdf.js gives it.
 */

/** The codes a simple font's encoding has: one byte (ISO 32000-1 section 9.6.5). */
const CODE_COUNT = 0x100;
/** Poppler reads a font's names as numbers only when no run of its /Differences starts past code 5. */
const MAX_RUN_START = 5;
/** At most two letters precede the number of a decimal name. */
const MAX_LETTERS = 2;
const NOTDEF = '.notdef';
const ZAPF_DINGBATS = 'ZapfDingbats';
const FIRST_PRINTABLE = 0x20;
const LAST_ASCII = 0x7e;
const FIRST_LATIN1_PRINTABLE = 0xa0;
const LAST_LATIN1 = 0xff;
const HEX_LETTER = /^[a-f]$/i;
const HEX_DIGIT = /^[0-9a-f]$/i;
const LETTER = /^[a-z]$/i;
const ALPHANUMERIC = /^[a-z0-9]$/i;
const DECIMAL_NUMBER = /^[+-]?\d+/;
const HEX_NUMBER = /^[+-]?(?:0x)?[0-9a-f]+/i;

/** A code of the font and the code point Poppler reads its glyph name as. */
export type CodeText = [code: number, codePoint: number];

/** Poppler's test for a hexadecimal name among those the glyph list does not know: `xx` with a letter digit last, or `Axx` with a letter digit. */
function looksHexadecimal(name: string): boolean {
  if (name.length === 3) {
    return LETTER.test(name[0]) && HEX_DIGIT.test(name[1]) && HEX_DIGIT.test(name[2]) && (HEX_LETTER.test(name[1]) || HEX_LETTER.test(name[2]));
  }
  return name.length === 2 && HEX_DIGIT.test(name[0]) && HEX_DIGIT.test(name[1]) && HEX_LETTER.test(name[1]);
}

/** The number a glyph name stands for, or null: Poppler's `parseNumericName`, which `strtol` and its tolerance of trailing marks define. */
export function numericGlyphName(name: string, hex: boolean): number | null {
  let rest = name;
  if (hex) {
    let length = 0;
    while (length < name.length && ALPHANUMERIC.test(name[length])) length++;
    if (length === 3 && LETTER.test(name[0])) rest = name.slice(1);
    else if (length !== 2) return null;
  } else {
    let letters = 0;
    while (letters < MAX_LETTERS && letters < rest.length && LETTER.test(rest[letters])) letters++;
    rest = rest.slice(letters);
  }
  const digits = (hex ? HEX_NUMBER : DECIMAL_NUMBER).exec(rest.trimStart());
  if (digits === null) return null;
  const trailing = rest.trimStart().slice(digits[0].length);
  if ([...trailing].some((character) => ALPHANUMERIC.test(character))) return null;
  return Number.parseInt(digits[0], hex ? 16 : 10);
}

function isOneByteCharacter(codePoint: number): boolean {
  return (codePoint >= FIRST_PRINTABLE && codePoint <= LAST_ASCII) || (codePoint >= FIRST_LATIN1_PRINTABLE && codePoint <= LAST_LATIN1);
}

/** The glyph name at each code the /Differences array sets, for codes 0 to 255, the later name of a code winning; as in Poppler, a name past the range does not move the code. */
function namesByCode(differences: ReadonlyArray<number | string | null>): Map<number, string> {
  const names = new Map<number, string>();
  let code = 0;
  for (const item of differences) {
    if (typeof item === 'number') {
      code = item;
    } else if (typeof item === 'string' && code >= 0 && code < CODE_COUNT) {
      names.set(code, item);
      code++;
    }
  }
  return names;
}

/** The /Differences and /BaseFont of a simple font, as the document gives them. */
export interface NamedFont {
  differences: ReadonlyArray<number | string | null> | null;
  baseFont: string | null;
}

/** The names of the font's codes that neither the Adobe Glyph List nor, for a ZapfDingbats font, its list maps; none for a font Poppler does not read by numbers. */
function unknownNames({ differences, baseFont }: NamedFont): Array<[code: number, name: string]> {
  if (differences === null || differences.some((item) => item === null)) return [];
  if (!differences.every((item) => typeof item !== 'number' || item <= MAX_RUN_START)) return [];
  const dingbats = baseFont?.endsWith(ZAPF_DINGBATS) === true;
  return [...namesByCode(differences)].filter(([, name]) => name !== NOTDEF && glyphNameToText(name, { dingbats }) === null);
}

function textsOf(differences: ReadonlyArray<number | string | null>, unknown: Array<[number, string]>, hex: boolean): CodeText[] {
  const names = differences.filter((item): item is string => typeof item === 'string');
  if (unknown.length === 0 || names.some((name) => numericGlyphName(name, hex) === null)) return [];
  const texts: CodeText[] = [];
  for (const [code, name] of unknown) {
    const codePoint = numericGlyphName(name, hex);
    if (codePoint !== null && isOneByteCharacter(codePoint)) texts.push([code, codePoint]);
  }
  return texts;
}

/**
 * For each font of the document, in order, the code points of the codes whose glyph names are numbers: none for a font
 * whose /Differences hold a name that is not one. A name the Adobe Glyph List (or the ZapfDingbats list) maps keeps its
 * text, as in Poppler and pdf.js.
 */
export function numericGlyphNameTexts(fonts: readonly NamedFont[]): CodeText[][] {
  const unknown = fonts.map(unknownNames);
  const hex = unknown.some((names) => names.some(([, name]) => looksHexadecimal(name)));
  return fonts.map((font, index) => (font.differences === null ? [] : textsOf(font.differences, unknown[index], hex)));
}
