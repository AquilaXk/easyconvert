/**
 * List markers and list assembly. A marker is a bullet character or a counter ("1.", "2)", "(a)", "iv.") at the start
 * of a paragraph. Several consecutive paragraphs whose markers continue each other (bullets of one family, counters
 * that count on) are one list; indentation gives the nesting level. A single paragraph that merely starts like a
 * marker ("A. Smith said") is not a list.
 */

import type { ListKind, MarkerPunctuation } from '../document-model/model';

export type { ListKind, MarkerPunctuation };

export interface ListMarker {
  kind: ListKind;
  /** The counter value (1-based); 0 for bullets. */
  value: number;
  punctuation: MarkerPunctuation;
  /** The bullet character, for a bullet. */
  glyph: string;
  /** The text after the marker and the white space that follows it. */
  rest: string;
}

/** Bullet characters; a hyphen or dash counts only when white space follows. */
const BULLET_CHARS = new Set(['•', '◦', '▪', '▫', '●', '○', '■', '□', '◆', '◇', '‣', '⁃', '·', '∙', '▪', '❖', '➢', '✓', '*', '-', '–', '—']);
const MAX_COUNTER_DIGITS = 3;
const MAX_ROMAN_LENGTH = 6;
const LATIN_BASE = 26;
const CHAR_CODE_LOWER_A = 97;
const CHAR_CODE_UPPER_A = 65;
const ROMAN_VALUES = new Map<string, number>([
  ['i', 1],
  ['v', 5],
  ['x', 10],
  ['l', 50],
  ['c', 100],
  ['d', 500],
  ['m', 1000],
]);
const COUNTER = new RegExp(`^(\\(?)(\\d{1,${MAX_COUNTER_DIGITS}}|[a-zA-Z]|[ivxlcdmIVXLCDM]{1,${MAX_ROMAN_LENGTH}})([.)])\\s+(\\S.*)$`, 'su');
const SECTION_NUMBER = new RegExp(`^(\\d{1,${MAX_COUNTER_DIGITS}}(?:\\.\\d{1,${MAX_COUNTER_DIGITS}})+)\\.?\\s+(\\S.*)$`, 'su');
const ROMAN_PATTERN = /^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i;

function romanValue(text: string): number | null {
  const lower = text.toLowerCase();
  if (!ROMAN_PATTERN.test(lower)) return null;
  let total = 0;
  for (let i = 0; i < lower.length; i++) {
    const value = ROMAN_VALUES.get(lower[i]) ?? 0;
    const next = ROMAN_VALUES.get(lower[i + 1]) ?? 0;
    total += value < next ? -value : value;
  }
  return total;
}

/** The marker a paragraph's text starts with, or null. */
export function parseListMarker(text: string): ListMarker | null {
  const first = Array.from(text)[0];
  if (first !== undefined && BULLET_CHARS.has(first)) {
    const rest = text.slice(first.length);
    // A bullet is followed by white space and text; "-" and "*" also need a space so that "-5" and "**bold" do not match.
    if (/^\s+\S/u.test(rest)) return { kind: 'bullet', value: 0, punctuation: 'dot', glyph: first, rest: rest.trimStart() };
    return null;
  }
  const counter = COUNTER.exec(text);
  if (counter === null) return null;
  const [, open, label, close, rest] = counter;
  const punctuation: MarkerPunctuation = open === '(' ? 'both' : close === ')' ? 'paren' : 'dot';
  if (open === '(' && close !== ')') return null;
  if (/^\d+$/.test(label)) {
    return { kind: 'decimal', value: Number(label), punctuation, glyph: '', rest };
  }
  const roman = label.length > 1 || 'ivxlcdmIVXLCDM'.includes(label) ? romanValue(label) : null;
  const isUpper = label === label.toUpperCase();
  if (roman !== null && label.length > 1) {
    return { kind: isUpper ? 'upperRoman' : 'lowerRoman', value: roman, punctuation, glyph: '', rest };
  }
  if (label.length === 1) {
    const code = label.charCodeAt(0) - (isUpper ? CHAR_CODE_UPPER_A : CHAR_CODE_LOWER_A) + 1;
    if (code >= 1 && code <= LATIN_BASE) return { kind: isUpper ? 'upperLetter' : 'lowerLetter', value: code, punctuation, glyph: '', rest };
  }
  return null;
}

/** A section number such as "2.1.3 Title": a heading number, not a list item. */
export function parseSectionNumber(text: string): { number: string; rest: string } | null {
  const match = SECTION_NUMBER.exec(text);
  return match === null ? null : { number: match[1], rest: match[2] };
}

/** Whether `next` can follow `previous` in one list (same family, counters counting on). */
export function continues(previous: ListMarker, next: ListMarker): boolean {
  if (previous.kind !== next.kind || previous.punctuation !== next.punctuation) return false;
  if (previous.kind === 'bullet') return true;
  return next.value === previous.value + 1;
}

/** A roman numeral and a letter share spellings ("i", "c"); a letter marker that follows a roman one is read as roman. */
export function reconcileLetterAndRoman(markers: (ListMarker | null)[]): void {
  for (let i = 1; i < markers.length; i++) {
    const previous = markers[i - 1];
    const marker = markers[i];
    if (previous === null || marker === null) continue;
    if ((previous.kind === 'lowerRoman' || previous.kind === 'upperRoman') && (marker.kind === 'lowerLetter' || marker.kind === 'upperLetter')) {
      const raw = marker.kind === 'lowerLetter' ? String.fromCharCode(CHAR_CODE_LOWER_A + marker.value - 1) : String.fromCharCode(CHAR_CODE_UPPER_A + marker.value - 1);
      const roman = romanValue(raw);
      if (roman !== null && roman === previous.value + 1) {
        marker.kind = marker.kind === 'lowerLetter' ? 'lowerRoman' : 'upperRoman';
        marker.value = roman;
      }
    }
  }
}
