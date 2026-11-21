import type { CodeText } from './pdf-numeric-glyph-names';
import { type StandardFont, timesAsciiWidths } from './standard-font-glyph-order';

/**
 * The text of a simple Type 1 font whose glyphs are named by their numbers in a TrueType font that the printer driver
 * converted (`G2`, `G54`, `G74`): the CG Times faces of Agfa and Monotype that Windows drivers of the 1990s wrote. The
 * number is the glyph's place in the original font, not a code of a character, so the numeric names of
 * pdf-numeric-glyph-names.ts (Poppler's reading, where the number is the character) read them as the wrong letter: "The
 * tables" is `6JG VCDNGU`. In these fonts glyph 2 is the space and the glyphs of U+0021 to U+007E follow it in order, so
 * the character of glyph n is U+0020 + (n - 2), which is the code plus 30 (govdocs1-001389.pdf: `G54 G74 G71` is "The").
 * Each code of a font of these faces is its glyph number: the /Differences names and the program's own encoding agree.
 *
 * No reference engine reads these names (pdf.js reads `G` and two hexadecimal digits as the character code, pdfminer.six
 * and PDFBox read none), and the order is the font's own, so the widths decide, as they do for the Arial and Times New Roman
 * fonts of standard-font-glyph-order.ts: the font is read this way only when the letters and digits that /Widths lists
 * have, at the character the order gives, the width the Times font of that style has (a CG Times face is metrically a Times
 * face, within 13% of a letter's width: 0.93 to 1.12 of Times across the 62 letters and digits of
 * govdocs1-001389.pdf), for nine in ten of at least ten of them. A font that is not what its name says reads as before.
 */

const CG_TIMES = /^CG\.Times(?<bold>\.Bold)?(?<italic>\.Italic)?\d*$/;
const SUBSET_TAG = /^[A-Z]{6}\+/;
const GLYPH_NUMBER = /^G(\d{1,3})$/;
const GLYPH_TO_CHARACTER = 30;
const FIRST_CODE = 2;
const LAST_CODE = 0x7e - GLYPH_TO_CHARACTER;
const FIRST_CHARACTER = 0x20;
const ALPHANUMERIC = /^[0-9A-Za-z]$/;
/** How far a letter's or digit's width may be from the Times width, as a share of the Times width. */
const WIDTH_TOLERANCE = 0.13;
const MIN_CHECKED = 10;
const MIN_MATCHING_SHARE = 0.9;

/** The slice of a simple font dictionary this reading needs. */
export interface GlyphNumberFont {
  baseFont: string | null;
  differences: ReadonlyArray<number | string | null> | null;
  firstChar: number | null;
  widths: ReadonlyArray<number | null> | null;
}

function timesStyleOf(baseFont: string | null): Extract<StandardFont, `Times-${string}`> | null {
  const style = baseFont === null ? null : CG_TIMES.exec(baseFont.replace(SUBSET_TAG, ''))?.groups;
  if (!style) return null;
  if (style.bold && style.italic) return 'Times-BoldItalic';
  if (style.bold) return 'Times-Bold';
  return style.italic ? 'Times-Italic' : 'Times-Roman';
}

/** Whether every glyph name of the /Differences is the number of its own code (`/G10` at code 10), and there is one. */
function namesAreCodes(differences: ReadonlyArray<number | string | null> | null): boolean {
  if (differences === null) return false;
  let code = 0;
  let names = 0;
  for (const item of differences) {
    if (typeof item === 'number') code = item;
    else if (typeof item === 'string' && Number(GLYPH_NUMBER.exec(item)?.[1]) === code) {
      names++;
      code++;
    } else return false;
  }
  return names > 0;
}

/** The codes `widths` lists (a width above 0) with the code point their glyph number gives. */
function listedCodes({ firstChar, widths }: GlyphNumberFont): Array<{ code: number; width: number }> {
  const listed: Array<{ code: number; width: number }> = [];
  widths?.forEach((width, index) => {
    const code = (firstChar ?? 0) + index;
    if (width !== null && width > 0 && code >= FIRST_CODE && code <= LAST_CODE) listed.push({ code, width });
  });
  return firstChar === null ? [] : listed;
}

/**
 * The characters of the codes of `font`, when it is a CG Times face whose glyph names are the numbers of its codes and
 * whose widths are those of the Times face of its style; none otherwise.
 */
export function glyphNumberTexts(font: GlyphNumberFont): CodeText[] {
  const style = timesStyleOf(font.baseFont);
  if (style === null || !namesAreCodes(font.differences)) return [];
  const times = timesAsciiWidths(style);
  const listed = listedCodes(font);
  let checked = 0;
  let matching = 0;
  for (const { code, width } of listed) {
    const codePoint = code + GLYPH_TO_CHARACTER;
    if (!ALPHANUMERIC.test(String.fromCodePoint(codePoint))) continue;
    const expected = times[codePoint - FIRST_CHARACTER];
    checked++;
    if (Math.abs(width - expected) <= WIDTH_TOLERANCE * expected) matching++;
  }
  if (checked < MIN_CHECKED || matching < checked * MIN_MATCHING_SHARE) return [];
  return listed.map(({ code }): CodeText => [code, code + GLYPH_TO_CHARACTER]);
}
