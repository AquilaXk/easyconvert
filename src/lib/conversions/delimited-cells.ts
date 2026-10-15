import { FORMULA_TRIGGER } from './delimited-rules';

/** Byte values the direct table routes test for. */
export const CHAR_TAB = 0x09;
export const CHAR_LF = 0x0a;
export const CHAR_CR = 0x0d;
export const CHAR_SPACE = 0x20;
export const CHAR_QUOTE = 0x22;
export const CHAR_PLUS = 0x2b;
export const CHAR_COMMA = 0x2c;
export const CHAR_MINUS = 0x2d;
export const CHAR_EQUALS = 0x3d;
export const CHAR_AT = 0x40;
export const CHAR_ZERO = 0x30;
export const CHAR_NINE = 0x39;
export const CHAR_BACKSLASH = 0x5c;
export const CHAR_BOM = 0xfeff;
export const ASCII_LIMIT = 0x80;

/** The UTF-8 byte-order mark as one-byte characters. */
export const UTF8_BOM_LATIN1 = '\xef\xbb\xbf';

/** What {@link scanCell} found in a cell's text. */
const NEEDS_QUOTES = 1;
const HAS_QUOTE = 2;
const HAS_NON_ASCII = 4;

/** The cell starts with a character a spreadsheet may read as the start of a formula. */
export function mayTriggerFormula(firstCode: number): boolean {
  return (
    firstCode === CHAR_EQUALS ||
    firstCode === CHAR_AT ||
    firstCode === CHAR_PLUS ||
    firstCode === CHAR_MINUS ||
    firstCode === CHAR_TAB ||
    firstCode === CHAR_CR
  );
}

function flagsOfCharacter(code: number, delimiterCode: number): number {
  if (code >= ASCII_LIMIT) return code === CHAR_BOM ? HAS_NON_ASCII | NEEDS_QUOTES : HAS_NON_ASCII;
  if (code === CHAR_QUOTE) return HAS_QUOTE | NEEDS_QUOTES;
  return code === delimiterCode || code === CHAR_LF || code === CHAR_CR ? NEEDS_QUOTES : 0;
}

function scanCell(text: string, delimiterCode: number): number {
  let flags = 0;
  for (let i = 0; i < text.length; i++) {
    flags |= flagsOfCharacter(text.codePointAt(i) ?? 0, delimiterCode);
  }
  return flags;
}

/** The text with the quoting the delimited writer applies; `flags` is what {@link scanCell} reported. */
function quoteCell(text: string, flags: number): string {
  if ((flags & NEEDS_QUOTES) === 0) return text;
  return (flags & HAS_QUOTE) === 0 ? `"${text}"` : `"${text.replace(/"/g, '""')}"`;
}

/**
 * One cell of delimited text as the delimited writer writes it: the formula guard, then quotes when the text holds a
 * quote, the delimiter, a line break, a byte-order mark or a space at either end. `asLatin1Utf8` returns the UTF-8
 * bytes of the cell as a string of one-byte characters, which {@link ChunkedOutput.writeLatin1} copies as they are.
 */
export function formatDelimitedString(
  value: string,
  delimiterCode: number,
  escapeFormulas: boolean,
  singleColumn: boolean,
  asLatin1Utf8 = false
): string {
  if (value.length === 0) return singleColumn ? '""' : '';
  const firstCode = value.codePointAt(0) ?? 0;
  const guarded = escapeFormulas && mayTriggerFormula(firstCode) && FORMULA_TRIGGER.test(value);
  const text = guarded ? `'${value}` : value;
  const spaced = firstCode === CHAR_SPACE || text.codePointAt(text.length - 1) === CHAR_SPACE;
  const flags = scanCell(text, delimiterCode) | (guarded || spaced ? NEEDS_QUOTES : 0);
  const formatted = quoteCell(text, flags);
  return asLatin1Utf8 && (flags & HAS_NON_ASCII) !== 0 ? Buffer.from(formatted, 'utf8').toString('latin1') : formatted;
}
