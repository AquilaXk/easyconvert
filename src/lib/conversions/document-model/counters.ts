import type { ListKind, MarkerPunctuation } from './model';

/** The label a counter shows for a value: "3", "c", "C", "iv" or "IV". */
const LATIN_LETTERS = 26;
const CHAR_CODE_LOWER_A = 97;
const ROMAN_TABLE: readonly (readonly [number, string])[] = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
];
/** Counters above this fall back to decimal digits: roman and letter forms are for short lists. */
const MAX_LETTERED_VALUE = 3999;

function romanOf(value: number): string {
  let rest = value;
  let text = '';
  for (const [amount, symbol] of ROMAN_TABLE) {
    while (rest >= amount) {
      text += symbol;
      rest -= amount;
    }
  }
  return text;
}

/** Spreadsheet-style letters: a to z, then aa, ab. */
function lettersOf(value: number): string {
  let rest = value;
  let text = '';
  while (rest > 0) {
    rest -= 1;
    text = String.fromCharCode(CHAR_CODE_LOWER_A + (rest % LATIN_LETTERS)) + text;
    rest = Math.floor(rest / LATIN_LETTERS);
  }
  return text;
}

export function counterLabel(kind: ListKind, value: number): string {
  if (value < 1 || value > MAX_LETTERED_VALUE) return String(value);
  switch (kind) {
    case 'lowerLetter':
      return lettersOf(value);
    case 'upperLetter':
      return lettersOf(value).toUpperCase();
    case 'lowerRoman':
      return romanOf(value);
    case 'upperRoman':
      return romanOf(value).toUpperCase();
    default:
      return String(value);
  }
}

/** The marker text of a list item: the bullet, or the counter with its punctuation. */
export function markerText(kind: ListKind, value: number, punctuation: MarkerPunctuation, glyph: string): string {
  if (kind === 'bullet') return glyph;
  const label = counterLabel(kind, value);
  if (punctuation === 'both') return `(${label})`;
  return punctuation === 'paren' ? `${label})` : `${label}.`;
}
