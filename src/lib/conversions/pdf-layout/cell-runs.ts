import type { PdfContentItem } from '../pdf-text-types';

/**
 * A run that crosses the lines between the cells of a ruled table is cut at those lines and each piece goes to the cell it is in.
 * pdf.js joins strings that follow each other on a baseline into one run, so the headings "3 Bedroom", "4 Bedroom" drawn one per
 * column come as one run, and a name cut off by the next cell's text comes as one run with it. pdfplumber puts each character in the
 * cell that holds its centre (`char_in_bbox` in `pdfplumber/table.py`); the reader has no character positions, so the pieces' edges
 * are estimated from the widths of typical glyphs, scaled to the width of the run.
 */

/** Em widths (Helvetica's, to the nearest tenth of a tenth) of the groups of characters the estimate tells apart. */
const NARROW_EM = 0.28;
const MEDIUM_EM = 0.36;
const WIDE_EM = 0.85;
const CAPITAL_EM = 0.68;
const DIGIT_EM = 0.556;
const LOWERCASE_EM = 0.5;
const FULL_WIDTH_EM = 1;
const NARROW = new Set([...`iIjl.,:;'!|\`’ `]);
const MEDIUM = new Set([...`ftr()[]-"/\\`]);
const WIDE = new Set([...'mwMW@%']);
const ASCII_END = 0x7f;

function emOf(character: string): number {
  if (character.charCodeAt(0) > ASCII_END) return FULL_WIDTH_EM;
  if (NARROW.has(character)) return NARROW_EM;
  if (MEDIUM.has(character)) return MEDIUM_EM;
  if (WIDE.has(character)) return WIDE_EM;
  if (character >= '0' && character <= '9') return DIGIT_EM;
  return character >= 'A' && character <= 'Z' ? CAPITAL_EM : LOWERCASE_EM;
}

/** Colour stretches of the characters from `from` to `to`, with their ends counted from `from`. */
function colorsBetween(colors: NonNullable<PdfContentItem['colors']>, from: number, to: number): NonNullable<PdfContentItem['colors']> {
  const stretches: NonNullable<PdfContentItem['colors']> = [];
  let start = 0;
  for (const { end, color } of colors) {
    if (end > from && start < to) stretches.push({ end: Math.min(end, to) - from, color });
    start = end;
  }
  return stretches;
}

function pieceOf(item: PdfContentItem, from: number, to: number, x: number, width: number): PdfContentItem {
  const { colors, ...rest } = item;
  const piece: PdfContentItem = { ...rest, text: item.text.slice(from, to), x, width };
  const stretches = colors ? colorsBetween(colors, from, to) : [];
  return stretches.length > 0 ? { ...piece, colors: stretches } : piece;
}

/** The characters of the item as code points, with the UTF-16 offset each one starts at (and the length of the text last). */
function codePointsOf(text: string): { characters: string[]; offsets: number[] } {
  const characters = [...text];
  const offsets: number[] = [];
  let offset = 0;
  for (const character of characters) {
    offsets.push(offset);
    offset += character.length;
  }
  offsets.push(offset);
  return { characters, offsets };
}

const WHITE_SPACE = /\s/u;
const LOWERCASE = /\p{Ll}/u;
const UPPERCASE = /\p{Lu}/u;
const DIGIT = /\p{Nd}/u;
const ALPHANUMERIC = /[\p{L}\p{Nd}]/u;
/** How many characters the estimate of a line's place may be off before the cut is given up. */
const CUT_SEARCH_CHARACTERS = 2;

/** Whether text may be cut between two neighbouring characters without breaking a word: at white space, or where the kind of character changes. */
function isBreak(before: string, after: string): boolean {
  if (WHITE_SPACE.test(before) || WHITE_SPACE.test(after)) return true;
  if (LOWERCASE.test(before) && UPPERCASE.test(after)) return true;
  return ALPHANUMERIC.test(before) && ALPHANUMERIC.test(after) && DIGIT.test(before) !== DIGIT.test(after);
}

/** The cut near `estimate` (the number of characters left of a line) that is nearest to it and breaks no word, or -1. */
function cutNear(characters: readonly string[], estimate: number): number {
  for (let distance = 0; distance <= CUT_SEARCH_CHARACTERS; distance++) {
    for (const cut of distance === 0 ? [estimate] : [estimate - distance, estimate + distance]) {
      if (cut > 0 && cut < characters.length && isBreak(characters[cut - 1], characters[cut])) return cut;
    }
  }
  return -1;
}

/**
 * The pieces of `item` between the lines `at` (ascending x of the lines that cross it). A line cuts the text where the estimate puts
 * it, moved to the nearest place within two characters that breaks no word (white space, a lowercase letter before a capital, a
 * letter next to a digit); a line with no such place near it cuts nothing. The white space at the ends of a piece is left out. An item
 * that no line cuts is returned as it is.
 */
export function splitAtLines(item: PdfContentItem, at: readonly number[]): PdfContentItem[] {
  if (at.length === 0 || item.rtl || item.vertical || item.width <= 0) return [item];
  const { characters, offsets } = codePointsOf(item.text);
  if (characters.length < 2) return [item];
  const starts = [0];
  for (const character of characters) starts.push(starts[starts.length - 1] + emOf(character));
  const scale = item.width / starts[characters.length];

  const cuts: number[] = [];
  for (const line of at) {
    let estimate = 0;
    while (estimate < characters.length && item.x + ((starts[estimate] + starts[estimate + 1]) / 2) * scale <= line) estimate++;
    const cut = cutNear(characters, estimate);
    if (cut > (cuts[cuts.length - 1] ?? 0)) cuts.push(cut);
  }
  if (cuts.length === 0) return [item];
  const pieces: PdfContentItem[] = [];
  let from = 0;
  for (const to of [...cuts, characters.length]) {
    let first = from;
    let last = to;
    while (first < last && characters[first].trim() === '') first++;
    while (last > first && characters[last - 1].trim() === '') last--;
    if (last > first) pieces.push(pieceOf(item, offsets[first], offsets[last], item.x + starts[first] * scale, (starts[last] - starts[first]) * scale));
    from = to;
  }
  return pieces;
}
