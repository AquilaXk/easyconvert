import fs from 'node:fs';
import { glyphNameToText } from './pdf-glyph-names';
import { pdfjsDataUrl } from './pdfjs-data';
import { readAdvanceWidths, readUnicodeCmap } from './truetype-cmap';

/**
 * The text of a composite font whose CIDs are the glyph ids of an Arial or Times New Roman font and whose embedded program
 * names no character (no `cmap`, no `post`, or a CID-keyed CFF): what print-to-PDF distillers wrote for those fonts.
 *
 * The glyph order is the standard Macintosh one, read as pdfjs reads it (pdf.js 6.3.289, Apache-2.0, commit 1c8020a7):
 * the 258 names of `MacStandardGlyphOrdering` (src/core/fonts_utils.js lines 44 to 80; Apple TrueType Reference Manual,
 * `post` table, format 1), each through the Adobe Glyph List, as `getGlyphMapForMacOrderedFonts` builds it
 * (src/core/standard_fonts.js lines 330 to 339). The Arial and Times New Roman fonts keep that order for glyph ids 3 to
 * 171 only: from 172 on they leave out `nonbreakingspace` and order the rest their own way. pdfjs's map for "standard
 * fonts embedded as CID font without glyph mapping" (`getGlyphMapForStandardFonts`, standard_fonts.js lines 344 to 841,
 * applied by `fallbackToSystemFont`, src/core/fonts.js lines 1300 to 1358) gives the same characters for 3 to 171 (U+037E,
 * the canonical equivalent of U+003B, for the semicolon at 30), leaves 155 out, and gives other characters from 179 on.
 * So the table is glyph ids 3 to 171 without 155.
 *
 * A name is a guess, so the widths decide: the font is read this way only when /W gives every CID of the table it lists
 * the width the reference font has for that glyph. The names follow `getStdFontMap` (standard_fonts.js lines 54 to 64
 * and 85 to 99) after `normalizeFontName` (fonts_utils.js lines 167 to 169); the reference for Arial is the Liberation
 * Sans font that pdfjs-dist ships and pdfjs draws Arial with (`getFontNameToFileMap`, standard_fonts.js lines 108 to 111),
 * and for Times New Roman the widths pdfjs keeps for Times (`getMetrics`, src/core/metrics.js lines 1492 to 2762).
 *
 * Limits, against pdfjs's: the table is 169 of the 258 standard names, so at most 168 CIDs of a font get text; /W is read
 * with pdfjs's rules (`extractWidths`, src/core/evaluator.js lines 4129 to 4158) but only for those CIDs, so a range is
 * filled in one step where pdfjs walks every CID it spans; a CID that /W does not list (pdfjs gives it /DW, line 4127)
 * or that lies outside the table keeps the reading it had; a name longer than a PDF name may be is no font name.
 */

/** The standard fonts pdfjs reads Arial and Times New Roman as (`getStdFontMap`). */
type StandardFont =
  | 'Helvetica'
  | 'Helvetica-Bold'
  | 'Helvetica-Oblique'
  | 'Helvetica-BoldOblique'
  | 'Times-Roman'
  | 'Times-Bold'
  | 'Times-Italic'
  | 'Times-BoldItalic';

/** A CID and the code point of its glyph. */
export type CidText = [cid: number, codePoint: number];

/** Glyph ids 0 to 2 are .notdef, .null and nonmarkingreturn, which carry no text. */
const FIRST_GID = 3;
/** The last glyph id at which the Arial and Times New Roman fonts keep the standard Macintosh order. */
const LAST_GID = 171;
/** `pi` in the Macintosh order, an unmapped `pi1` in those fonts; pdfjs's map for them leaves it out too. */
const GIDS_LEFT_OUT = new Set([155]);
/** Glyph ids 0 to LAST_GID of `MacStandardGlyphOrdering`, the 258 standard Macintosh glyph names (`post` format 1). */
const MAC_STANDARD_GLYPH_NAMES: readonly string[] = [
  '.notdef', '.null', 'nonmarkingreturn', 'space', 'exclam', 'quotedbl', 'numbersign', 'dollar', 'percent',
  'ampersand', 'quotesingle', 'parenleft', 'parenright', 'asterisk', 'plus', 'comma', 'hyphen', 'period', 'slash',
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'colon', 'semicolon', 'less',
  'equal', 'greater', 'question', 'at', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P',
  'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'bracketleft', 'backslash', 'bracketright', 'asciicircum',
  'underscore', 'grave', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's',
  't', 'u', 'v', 'w', 'x', 'y', 'z', 'braceleft', 'bar', 'braceright', 'asciitilde', 'Adieresis', 'Aring', 'Ccedilla',
  'Eacute', 'Ntilde', 'Odieresis', 'Udieresis', 'aacute', 'agrave', 'acircumflex', 'adieresis', 'atilde', 'aring',
  'ccedilla', 'eacute', 'egrave', 'ecircumflex', 'edieresis', 'iacute', 'igrave', 'icircumflex', 'idieresis', 'ntilde',
  'oacute', 'ograve', 'ocircumflex', 'odieresis', 'otilde', 'uacute', 'ugrave', 'ucircumflex', 'udieresis', 'dagger',
  'degree', 'cent', 'sterling', 'section', 'bullet', 'paragraph', 'germandbls', 'registered', 'copyright', 'trademark',
  'acute', 'dieresis', 'notequal', 'AE', 'Oslash', 'infinity', 'plusminus', 'lessequal', 'greaterequal', 'yen', 'mu',
  'partialdiff', 'summation', 'product', 'pi', 'integral', 'ordfeminine', 'ordmasculine', 'Omega', 'ae', 'oslash',
  'questiondown', 'exclamdown', 'logicalnot', 'radical', 'florin', 'approxequal', 'Delta', 'guillemotleft',
  'guillemotright', 'ellipsis',
];

/**
 * How far a /W width may be from the reference, in thousandths of an em: both are the same design width rounded to whole
 * units at most once each, so they differ by at most 0.5 + 0.5. Measured over the drawn CIDs of the table in the corpus
 * fonts: at most 0.18 against Liberation Sans (4,411 widths) and 0 against the Times widths (25).
 */
const WIDTH_TOLERANCE = 1;
/** Glyph space units of an em (ISO 32000-1 section 9.2.4). */
const GLYPH_SPACE_UNITS = 1000;
/** Longest name a PDF may hold (ISO 32000-1 Annex C, 127 bytes); a longer /BaseFont names no font here. */
const MAX_NAME_LENGTH = 127;
/** The subset tag of a font name: six uppercase letters and a plus sign (ISO 32000-1 section 9.6.4). */
const SUBSET_TAG = /^[A-Z]{6}\+/;

/** Names of `getStdFontMap` for Arial and Times New Roman (Arial Narrow, Black and Unicode MS differ in widths or order). */
const CORE_FONTS = new Map<string, StandardFont>([
  ['Arial', 'Helvetica'],
  ['Arial-Bold', 'Helvetica-Bold'],
  ['Arial-BoldItalic', 'Helvetica-BoldOblique'],
  ['Arial-Italic', 'Helvetica-Oblique'],
  ['ArialMT', 'Helvetica'],
  ['Arial-BoldItalicMT', 'Helvetica-BoldOblique'],
  ['Arial-BoldMT', 'Helvetica-Bold'],
  ['Arial-ItalicMT', 'Helvetica-Oblique'],
  ['Arial-BoldItalicMT-BoldItalic', 'Helvetica-BoldOblique'],
  ['Arial-BoldMT-Bold', 'Helvetica-Bold'],
  ['Arial-ItalicMT-Italic', 'Helvetica-Oblique'],
  ['TimesNewRoman', 'Times-Roman'],
  ['TimesNewRoman-Bold', 'Times-Bold'],
  ['TimesNewRoman-BoldItalic', 'Times-BoldItalic'],
  ['TimesNewRoman-Italic', 'Times-Italic'],
  ['TimesNewRomanPS', 'Times-Roman'],
  ['TimesNewRomanPS-Bold', 'Times-Bold'],
  ['TimesNewRomanPS-BoldItalic', 'Times-BoldItalic'],
  ['TimesNewRomanPS-BoldItalicMT', 'Times-BoldItalic'],
  ['TimesNewRomanPS-BoldMT', 'Times-Bold'],
  ['TimesNewRomanPS-Italic', 'Times-Italic'],
  ['TimesNewRomanPS-ItalicMT', 'Times-Italic'],
  ['TimesNewRomanPSMT', 'Times-Roman'],
  ['TimesNewRomanPSMT-Bold', 'Times-Bold'],
  ['TimesNewRomanPSMT-BoldItalic', 'Times-BoldItalic'],
  ['TimesNewRomanPSMT-Italic', 'Times-Italic'],
]);

/**
 * The widths pdfjs keeps for the Times fonts (`getMetrics`), by glyph id FIRST_GID to LAST_GID through the Macintosh order;
 * 0 where it has none (infinity, product, integral, Omega, approxequal and pi).
 */
const TIMES_WIDTHS: Record<Extract<StandardFont, `Times-${string}`>, readonly number[]> = {
  'Times-Roman': [250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444, 921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722, 556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500, 333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500, 500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541, 722, 722, 667, 611, 722, 722, 722, 444, 444, 444, 444, 444, 444, 444, 444, 444, 444, 444, 278, 278, 278, 278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 400, 500, 500, 500, 350, 453, 500, 760, 760, 980, 333, 333, 549, 889, 722, 0, 564, 549, 549, 500, 500, 476, 600, 0, 0, 0, 276, 310, 0, 667, 500, 444, 333, 564, 453, 500, 0, 612, 500, 500, 1000],
  'Times-Bold': [250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570, 570, 500, 930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667, 944, 722, 778, 611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667, 333, 278, 333, 581, 500, 333, 500, 556, 444, 556, 444, 333, 500, 556, 278, 333, 556, 278, 833, 556, 500, 556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444, 394, 220, 394, 520, 722, 722, 722, 667, 722, 778, 722, 500, 500, 500, 500, 500, 500, 444, 444, 444, 444, 444, 278, 278, 278, 278, 556, 500, 500, 500, 500, 500, 556, 556, 556, 556, 500, 400, 500, 500, 500, 350, 540, 556, 747, 747, 1000, 333, 333, 549, 1000, 778, 0, 570, 549, 549, 500, 556, 494, 600, 0, 0, 0, 300, 330, 0, 722, 500, 500, 333, 570, 549, 500, 0, 612, 500, 500, 1000],
  'Times-Italic': [250, 333, 420, 500, 500, 833, 778, 214, 333, 333, 500, 675, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 675, 675, 675, 500, 920, 611, 611, 667, 722, 611, 611, 722, 722, 333, 444, 667, 556, 833, 667, 722, 611, 722, 611, 500, 556, 722, 611, 833, 611, 556, 556, 389, 278, 389, 422, 500, 333, 500, 500, 444, 500, 444, 278, 500, 500, 278, 278, 444, 278, 722, 500, 500, 500, 500, 389, 389, 278, 500, 444, 667, 444, 444, 389, 400, 275, 400, 541, 611, 611, 667, 611, 667, 722, 722, 500, 500, 500, 500, 500, 500, 444, 444, 444, 444, 444, 278, 278, 278, 278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 400, 500, 500, 500, 350, 523, 500, 760, 760, 980, 333, 333, 549, 889, 722, 0, 675, 549, 549, 500, 500, 476, 600, 0, 0, 0, 276, 310, 0, 667, 500, 500, 389, 675, 453, 500, 0, 612, 500, 500, 889],
  'Times-BoldItalic': [250, 389, 555, 500, 500, 833, 778, 278, 333, 333, 500, 570, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570, 570, 500, 832, 667, 667, 667, 722, 667, 667, 722, 778, 389, 500, 667, 611, 889, 722, 722, 611, 722, 667, 556, 611, 722, 667, 889, 667, 611, 611, 333, 278, 333, 570, 500, 333, 500, 500, 444, 500, 444, 333, 500, 556, 278, 278, 500, 278, 778, 556, 500, 500, 500, 389, 389, 278, 556, 444, 667, 500, 444, 389, 348, 220, 348, 570, 667, 667, 667, 667, 722, 722, 722, 500, 500, 500, 500, 500, 500, 444, 444, 444, 444, 444, 278, 278, 278, 278, 556, 500, 500, 500, 500, 500, 556, 556, 556, 556, 500, 400, 500, 500, 500, 350, 500, 500, 747, 747, 1000, 333, 333, 549, 944, 722, 0, 570, 549, 549, 500, 576, 494, 600, 0, 0, 0, 266, 300, 0, 722, 500, 500, 389, 606, 549, 500, 0, 612, 500, 500, 1000],
};

/** The Liberation Sans file of pdfjs-dist's `standard_fonts` that pdfjs draws each Helvetica font with. */
const LIBERATION_FILES: Record<Extract<StandardFont, `Helvetica${string}`>, string> = {
  Helvetica: 'LiberationSans-Regular.ttf',
  'Helvetica-Bold': 'LiberationSans-Bold.ttf',
  'Helvetica-Oblique': 'LiberationSans-Italic.ttf',
  'Helvetica-BoldOblique': 'LiberationSans-BoldItalic.ttf',
};

let macCodePoints: Uint32Array | undefined;

/** The code point of glyph id `gid` of the table: its Macintosh name through the Adobe Glyph List (pdf-glyph-names.ts). */
function codePointOf(gid: number): number {
  macCodePoints ??= Uint32Array.from(MAC_STANDARD_GLYPH_NAMES, (name) => glyphNameToText(name)?.codePointAt(0) ?? 0);
  return macCodePoints[gid];
}

/** The width of each glyph of the table in a Liberation Sans font, through its cmap and `hmtx`; NaN where it has none. */
function liberationWidths(file: string): Float64Array | null {
  const folder = pdfjsDataUrl('standard_fonts');
  let program: Buffer;
  try {
    if (folder === undefined) return null;
    program = fs.readFileSync(`${folder}${file}`);
  } catch {
    return null;
  }
  const cmap = readUnicodeCmap(program);
  const advances = readAdvanceWidths(program);
  if (cmap === null || advances === null) return null;
  const widths = new Float64Array(LAST_GID - FIRST_GID + 1).fill(Number.NaN);
  for (let gid = FIRST_GID; gid <= LAST_GID; gid++) {
    const glyph = cmap.glyphOfBmpCodePoint[codePointOf(gid)];
    if (glyph !== 0 && glyph < advances.length) widths[gid - FIRST_GID] = advances[glyph] * GLYPH_SPACE_UNITS;
  }
  return widths;
}

const referenceCache = new Map<StandardFont, Float64Array | null>();

/** The width of each glyph of the table in the reference for `font`, in glyph space units; NaN where it has none. */
function referenceWidths(font: StandardFont): Float64Array | null {
  if (!referenceCache.has(font)) {
    const widths =
      font in LIBERATION_FILES
        ? liberationWidths(LIBERATION_FILES[font as keyof typeof LIBERATION_FILES])
        : Float64Array.from(TIMES_WIDTHS[font as keyof typeof TIMES_WIDTHS], (width) => (width === 0 ? Number.NaN : width));
    referenceCache.set(font, widths);
  }
  return referenceCache.get(font) ?? null;
}

/** The standard font a /BaseFont names, after its subset tag and pdfjs's `normalizeFontName` (`,` and `_` to `-`, no white space). */
export function coreFontOf(name: string | null): StandardFont | undefined {
  if (name === null || name.length > MAX_NAME_LENGTH) return undefined;
  return CORE_FONTS.get(name.replace(SUBSET_TAG, '').replaceAll(/[,_]/g, '-').replaceAll(/\s/g, ''));
}

/**
 * The text of the CIDs that `widths` lists in the table, when `name` names an Arial or Times New Roman font and each of
 * those widths is the reference width of its glyph; none otherwise, so a font that is not what its name says reads as before.
 * `widths(first, last)` gives the /W widths of the CIDs from `first` to `last`.
 */
export function standardOrderTexts(name: string | null, widths: (first: number, last: number) => Map<number, number>): CidText[] {
  const font = coreFontOf(name);
  const reference = font === undefined ? null : referenceWidths(font);
  if (reference === null) return [];
  const entries: CidText[] = [];
  for (const [cid, width] of widths(FIRST_GID, LAST_GID)) {
    if (GIDS_LEFT_OUT.has(cid)) continue;
    const expected = reference[cid - FIRST_GID];
    if (!(Math.abs(width - expected) <= WIDTH_TOLERANCE)) return [];
    entries.push([cid, codePointOf(cid)]);
  }
  return entries;
}
