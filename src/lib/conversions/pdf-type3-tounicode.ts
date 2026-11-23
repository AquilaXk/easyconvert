/**
 * Character text for Type 3 bitmap fonts whose `/Encoding /Differences` name glyphs by the characters they draw
 * (`/.`, `/,`, `/4`, `/[`, `/a`), and for TeX `OT1` text ligatures named by control codes (`U+000B`..`U+000F`).
 *
 * Open-source / reference hierarchy checked before writing this rule:
 *  1. Permissively licensed libraries/bindings: `mozilla/pdf.js` v6.3.289 (Apache-2.0, `src/core/evaluator.js`
 *     `_simpleFontToUnicode` / `amendFallbackToUnicode` / `buildTextContentItem` and `src/core/fonts.js` `_charToGlyph`),
 *     `apache/pdfbox` 3.0 (Apache-2.0, `PDType3Font.java`), and `pdfminer/pdfminer.six` (MIT, `encodingdb.py`) map simple
 *     font names through the Adobe Glyph List, `Gxx`/`gxxxx`/`Cnnn`, and `uniXXXX`/`uXXXX`, leaving single-character
 *     punctuation/digit names and TeX `OT1` control-code ligatures unmapped.
 *  2. Existing project dependencies: `pdfjs-dist`'s `/ToUnicode` parser (`readToUnicode` + `parseBfChar` in
 *     `pdf.worker.mjs`) already accepts one-byte codes, multi-character UTF-16BE destinations (`<00660069>` -> `"fi"`),
 *     and added `bfchar` blocks prepended ahead of a partial `/ToUnicode` stream.
 *  3. Why it runs in `/ToUnicode` (`pdf-font-tounicode.ts`) rather than only in post-extraction `recoverUnmappedGlyphs`:
 *     dvips/Ghostscript Type 3 fonts commonly carry partial `/Ordering (T3UV)` `/ToUnicode` streams covering only
 *     ASCII letters (`<41> <7a>`), leaving codes `1..32` unmapped. For any unmapped code, `pdf.js` falls back to
 *     `String.fromCharCode(charcode)`, so codes `9..13` (`\t`, `\n`, `\v`, `\f`, `\r`) and `32` (`' '`) acquire
 *     `category.isWhitespace === true` and `buildTextContentItem` converts them into spaces before `getTextContent()`
 *     returns (`govdocs1-004647.pdf` loses `1`, `4`, `,`, `[`, `]`, `8`, `9`, `-`, and `fi` that Poppler 26.09 prints).
 *     Post-extraction `pdf-glyph-recovery.ts` still shares `characterGlyphName` and `MIN_CHARACTER_NAMES` for files
 *     that have no cross-reference base for incremental updates.
 *
 * TeX `OT1` ligatures (`ff`, `fi`, `fl`, `ffi`, `ffl` at `0x0B..0x0F`, *The TeXbook* Appendix F / TeX Live `ot1.enc`)
 * share code slots `0x0B..0x0F` with Greek lowercase letters in `OML` math italic (`cmmi`) and arrows/punctuation in
 * fixed-pitch `OT1` typewriter (`cmtt`), so they are mapped only when the font's own `/Widths` and `/Differences`
 * identify a proportional `OT1` text face: unequal positive widths, at least 8 lowercase ASCII letter names, and at
 * least one digit or text punctuation mark (`.,-0-9()`).
 */

/** Fewest distinct single-character glyph names needed to treat a Type 3 font as text rather than a figure glyph set. */
export const MIN_CHARACTER_NAMES = 4;

const TYPE3_SUBTYPE = 'Type3';
const SIMPLE_FONT_CODES = 0x100;
const MAX_DIFFERENCES_ITEMS = 4096;
const MIN_OT1_LOWERCASE = 8;
const SPACE = 0x20;
const DELETE = 0x7f;
const PROSE_MARK_OR_DIGIT = /^[.,\-0-9()]$/;

/** Knuth OT1 prose ligatures at codes 0x0B..0x0F (0x0B=ff, 0x0C=fi, 0x0D=fl, 0x0E=ffi, 0x0F=ffl). */
const OT1_LIGATURES: ReadonlyMap<number, string> = new Map([
  [0x0b, 'ff'],
  [0x0c, 'fi'],
  [0x0d, 'fl'],
  [0x0e, 'ffi'],
  [0x0f, 'ffl'],
]);

/** A one-byte character code and its Unicode text for a `/ToUnicode` `bfchar` entry. */
export type SimpleTextEntry = readonly [code: number, text: string];

/** Slice of a simple font dictionary needed to derive Type 3 glyph text. */
export interface Type3FontInput {
  subtype: string;
  differences: ReadonlyArray<number | string | null> | null;
  widths: ReadonlyArray<number | null> | null;
}

/** The character a glyph name represents when it is one printable character (excluding space and delete). */
export function characterGlyphName(name: string): string | null {
  const codePoint = name.codePointAt(0);
  return codePoint !== undefined && name.length === String.fromCodePoint(codePoint).length && codePoint > SPACE && codePoint !== DELETE ? name : null;
}

function isProportional(widths: ReadonlyArray<number | null> | null): boolean {
  if (widths === null) return false;
  let firstPositive: number | null = null;
  for (const width of widths) {
    if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) continue;
    if (firstPositive === null) firstPositive = width;
    else if (width !== firstPositive) return true;
  }
  return false;
}

function namesByCode(differences: ReadonlyArray<number | string | null>): Map<number, string> {
  const byCode = new Map<number, string>();
  let code = 0;
  for (const item of differences) {
    if (typeof item === 'number') {
      code = item;
    } else if (typeof item === 'string') {
      if (code >= 0 && code < SIMPLE_FONT_CODES) byCode.set(code, item);
      code++;
    } else if (code >= 0 && code < SIMPLE_FONT_CODES) {
      code++;
    }
  }
  return byCode;
}

/**
 * Character mappings to add to `/ToUnicode` for a Type 3 font whose glyph names are single printable characters
 * (and `OT1` `f`-ligatures `U+000B..U+000F` for proportional `OT1` prose fonts), skipping codes already covered.
 */
export function type3GlyphTexts(font: Type3FontInput, covered?: (code: number) => boolean): SimpleTextEntry[] {
  if (font.subtype !== TYPE3_SUBTYPE || font.differences === null || font.differences.length > MAX_DIFFERENCES_ITEMS) return [];
  const byCode = namesByCode(font.differences);
  const charNames = new Set<string>();
  const lowercase = new Set<string>();
  let hasProseMarkOrDigit = false;
  for (const name of byCode.values()) {
    const single = characterGlyphName(name);
    if (single === null) continue;
    charNames.add(single);
    if (single >= 'a' && single <= 'z') lowercase.add(single);
    if (!hasProseMarkOrDigit && PROSE_MARK_OR_DIGIT.test(single)) hasProseMarkOrDigit = true;
  }
  if (charNames.size < MIN_CHARACTER_NAMES) return [];
  const ot1Text = isProportional(font.widths) && lowercase.size >= MIN_OT1_LOWERCASE && hasProseMarkOrDigit;
  const codes = [...byCode.keys()].sort((first, second) => first - second);
  const entries: SimpleTextEntry[] = [];
  for (const code of codes) {
    if (covered?.(code) === true) continue;
    const name = byCode.get(code) as string;
    let mapped = characterGlyphName(name);
    if (mapped === null && ot1Text && name.length === 1) {
      mapped = OT1_LIGATURES.get(name.charCodeAt(0)) ?? null;
    }
    if (mapped !== null) entries.push([code, mapped]);
  }
  return entries;
}
