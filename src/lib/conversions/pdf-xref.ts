/**
 * Cross-reference readers for the object index of `PdfDocument`, written after `XRef` of pdf.js (mozilla/pdf.js v6.3.289,
 * Apache-2.0, src/core/xref.js): `readXRefTable` (lines 160-246), `readXRefStream` (lines 285-425) and the `startXRef` getter of
 * `PDFDocument` (src/core/document.js lines 1070-1120). They only parse sections; which object a number leads to, and what
 * pdf.js does when a section is damaged, is decided by the caller.
 *
 * Entries keep the first definition of a number, as `this.#entries[first + i] ??= entry` does: sections are read newest first, so a
 * number's newest entry wins, a free entry included.
 *
 * The tokens are the ones the lexer of pdf.js reads (`Lexer.getObj` and `getNumber`, pdf.worker.mjs lines 11849-11890 and 12096-12190),
 * not the ones a PDF writer produces: an integer is whatever `getNumber` returns that `Number.isInteger` accepts (`12.0`, `+12`,
 * `12.`, `--12`), a number ends at the first character that cannot continue it (`00000n` is the number 0 and the command `n`), and
 * a lone sign or point is the number 0. A file the guard read more strictly than that would leave the guard on another object
 * than the one pdf.js draws.
 */

import { PdfStructureError } from './pdf-values';

export type XrefEntry =
  /** A free object: pdf.js treats the number as absent. */
  | { kind: 'free'; offset: number; gen: number }
  /** An object at a byte offset of the file (a table entry marked `n`, a stream entry of type 1). */
  | { kind: 'offset'; offset: number; gen: number }
  /** An object inside an object stream (a stream entry of type 2): `offset` is the number of the stream, `gen` the index of the object in it. */
  | { kind: 'member'; offset: number; gen: number };

/** A section that pdf.js would reject with a `FormatError`; the caller goes on with the next section, as `readXRef` does. */
export class XrefFormatError extends Error {}

export type AddXrefEntry = (num: number, entry: XrefEntry) => void;

const CHAR_NUL = 0;
const CHAR_TAB = 9;
const CHAR_LF = 10;
const CHAR_FF = 12;
const CHAR_CR = 13;
const CHAR_SPACE = 32;
const CHAR_PERCENT = 37;
const CHAR_ZERO = 48;
const CHAR_NINE = 57;
const CHAR_PLUS = 43;
const CHAR_MINUS = 45;
const CHAR_DOT = 46;
const CHAR_LEFT_PAREN = 40;
const CHAR_LESS = 60;
/** Characters of a command, `Lexer.getObj`: it throws at the 129th. */
const MAX_COMMAND_LENGTH = 128;
const DELIMITERS = '()<>[]{}/%';
const STARTXREF = 'startxref';
const HEADER = '%PDF-';
/** pdf.js looks for the header in the first kilobyte (`PDFDocument.checkHeader`, `find(stream, "%PDF-", 1024)`). */
const HEADER_SEARCH_BYTES = 1024;
/** The kind of an xref stream entry by its type field (0 free, 1 at an offset, 2 in an object stream). */
const STREAM_ENTRY_KINDS = ['free', 'offset', 'member'] as const;

function isWhiteCode(code: number): boolean {
  return code === CHAR_SPACE || code === CHAR_LF || code === CHAR_CR || code === CHAR_TAB || code === CHAR_FF || code === CHAR_NUL;
}

/** The offset the file's own offsets count from: pdf.js moves the start of the stream to a `%PDF-` found in the first kilobyte. */
export function headerOffset(text: string): number {
  const at = text.slice(0, HEADER_SEARCH_BYTES + HEADER.length).indexOf(HEADER);
  return at < 0 ? 0 : at;
}

/**
 * The integer after the last `startxref` of the file, 0 when there is none or it is not a number (`PDFDocument.startXRef`: it looks
 * for the keyword backwards from the end, skips white space, and takes the characters from space to `9`, so a sign or a stray
 * punctuation mark ends up in `parseInt`).
 */
export function lastStartXref(text: string): number {
  const at = text.lastIndexOf(STARTXREF);
  if (at < 0) return 0;
  let pos = at + STARTXREF.length;
  while (pos < text.length && isWhiteCode(text.charCodeAt(pos))) pos++;
  let digits = '';
  while (pos < text.length && text.charCodeAt(pos) >= CHAR_SPACE && text.charCodeAt(pos) <= CHAR_NINE) digits += text[pos++];
  const value = Number.parseInt(digits, 10);
  return Number.isNaN(value) || value < 0 ? 0 : value;
}

/** A token of the lexer of pdf.js as the cross-reference reads it: a number, a command (`xref`, `trailer`, `f`, `n`, `obj`), or anything else. */
export type XrefToken =
  | { kind: 'number'; value: number; end: number }
  | { kind: 'command'; text: string; end: number }
  | { kind: 'other'; end: number };

function isSpecial(code: number): boolean {
  return isWhiteCode(code) || (code >= 0 && DELIMITERS.includes(String.fromCharCode(code)));
}

/** `Lexer.getNumber`, from the character at `from`: the value and where the number ends. @throws XrefFormatError for a character that cannot start a number. */
function numberAt(text: string, from: number): { value: number; end: number } {
  const code = (index: number): number => (index < text.length ? text.charCodeAt(index) : -1);
  let pos = from;
  let ch = code(pos);
  let divideBy = 0;
  let sign = 1;
  if (ch === CHAR_MINUS) {
    sign = -1;
    ch = code(++pos);
    if (ch === CHAR_MINUS) ch = code(++pos);
  } else if (ch === CHAR_PLUS) {
    ch = code(++pos);
  }
  while (ch === CHAR_LF || ch === CHAR_CR) ch = code(++pos);
  if (ch === CHAR_DOT) {
    divideBy = 10;
    ch = code(++pos);
  }
  if (ch < CHAR_ZERO || ch > CHAR_NINE) {
    if (ch === CHAR_SPACE || ch === CHAR_TAB || ch === CHAR_LF || ch === CHAR_CR || ch === CHAR_LEFT_PAREN || ch === CHAR_LESS || ch === -1) return { value: 0, end: pos };
    throw new XrefFormatError(`Invalid number: charCode ${ch}`);
  }
  let value = ch - CHAR_ZERO;
  for (ch = code(++pos); ch >= 0; ch = code(++pos)) {
    if (ch >= CHAR_ZERO && ch <= CHAR_NINE) {
      if (divideBy !== 0) divideBy *= 10;
      value = value * 10 + (ch - CHAR_ZERO);
    } else if (ch === CHAR_DOT) {
      if (divideBy !== 0) break;
      divideBy = 1;
    } else if (ch !== CHAR_MINUS) {
      break;
    }
  }
  return { value: sign * (divideBy === 0 ? value : value / divideBy), end: pos };
}

/** `Lexer.getObj` for a command: a run of characters up to white space or a delimiter, or one character of a byte that is not text when text follows. */
function commandAt(text: string, from: number): XrefToken {
  const first = text.charCodeAt(from);
  const next = from + 1 < text.length ? text.charCodeAt(from + 1) : -1;
  if ((first < CHAR_SPACE || first > 0x7f) && next >= CHAR_SPACE && next <= 0x7f) return { kind: 'command', text: text[from], end: from + 1 };
  let end = from + 1;
  while (end < text.length && !isSpecial(text.charCodeAt(end))) {
    if (end - from === MAX_COMMAND_LENGTH) throw new XrefFormatError(`Command token too long: ${MAX_COMMAND_LENGTH}`);
    end++;
  }
  return { kind: 'command', text: text.slice(from, end), end };
}

/**
 * The next token of the lexer of pdf.js, or null at the end of the text: white space and comments skipped, then a number, a name,
 * a string or a delimiter (all `other`, since nothing in a cross-reference may be one), or a command.
 * @throws XrefFormatError for a token the lexer throws on.
 */
export function xrefTokenAt(text: string, from: number): XrefToken | null {
  const pos = skipComments(text, from);
  if (pos >= text.length) return null;
  const code = text.charCodeAt(pos);
  if ((code >= CHAR_ZERO && code <= CHAR_NINE) || code === CHAR_PLUS || code === CHAR_MINUS || code === CHAR_DOT) {
    const { value, end } = numberAt(text, pos);
    return { kind: 'number', value, end };
  }
  if (DELIMITERS.includes(text[pos])) return { kind: 'other', end: pos + 1 };
  const token = commandAt(text, pos);
  return token.kind === 'command' && (token.text === 'true' || token.text === 'false' || token.text === 'null') ? { kind: 'other', end: token.end } : token;
}

function skipComments(text: string, from: number): number {
  let pos = from;
  while (pos < text.length) {
    const code = text.charCodeAt(pos);
    if (isWhiteCode(code)) {
      pos++;
    } else if (code === CHAR_PERCENT) {
      while (pos < text.length && text.charCodeAt(pos) !== CHAR_LF && text.charCodeAt(pos) !== CHAR_CR) pos++;
    } else {
      break;
    }
  }
  return pos;
}

function integerOf(token: XrefToken | null): number | null {
  return token?.kind === 'number' && Number.isInteger(token.value) ? token.value : null;
}

/** `N G obj` as pdf.js reads three tokens at an offset (`fetchUncompressed`, pdf.worker.mjs lines 59011-59040). */
export interface ObjectHeader {
  num: number;
  gen: number;
  /** Where the object's value starts: after `obj`, or after the command that begins with it. */
  end: number;
  /** The integer pdf.js returns as the object when the command is `obj` followed by digits (`obj12`), whatever follows. Null for a plain `obj`. */
  glued: number | null;
}

/** The three tokens at `from`, the keyword compared as pdf.js compares it; null when they are not an object header. */
export function objectHeaderAt(text: string, from: number): ObjectHeader | null {
  let num: number | null;
  let gen: number | null;
  let keyword: XrefToken | null;
  try {
    const first = xrefTokenAt(text, from);
    const second = first === null ? null : xrefTokenAt(text, first.end);
    keyword = second === null ? null : xrefTokenAt(text, second.end);
    num = integerOf(first);
    gen = integerOf(second);
  } catch (error) {
    if (error instanceof XrefFormatError) return null;
    throw error;
  }
  if (num === null || gen === null || keyword?.kind !== 'command' || !keyword.text.startsWith('obj')) return null;
  if (keyword.text === 'obj') return { num, gen, end: keyword.end, glued: null };
  const glued = Number.parseInt(keyword.text.slice(3), 10);
  return Number.isNaN(glued) ? null : { num, gen, end: keyword.end, glued };
}

/** How far a table read got, for the caller to charge: a table that fails near its end has read nearly all of it. */
export interface XrefReach {
  end: number;
}

/**
 * Reads the subsections of the classic table whose entries start at `from` (after the `xref` keyword), up to the `trailer`
 * keyword, and returns the position after it. A first subsection that starts at 1 with a free first entry is shifted to 0
 * (xref.js lines 220-225, issues 3248 and 7229 of pdf.js). `reached.end` follows the tokens read, also when the read fails.
 * @throws XrefFormatError for an entry or a subsection header pdf.js rejects, after the entries before it were added.
 */
export function readXrefTable(text: string, from: number, add: AddXrefEntry, reached: XrefReach = { end: from }): number {
  const next = (at: number): XrefToken | null => {
    const token = xrefTokenAt(text, at);
    reached.end = token === null ? text.length : token.end;
    return token;
  };
  let pos = from;
  for (;;) {
    const head = next(pos);
    if (head === null) throw new XrefFormatError('Invalid XRef table: could not find trailer dictionary');
    if (head.kind === 'command' && head.text === 'trailer') return head.end;
    const countToken = next(head.end);
    let first = integerOf(head);
    const count = integerOf(countToken);
    if (countToken === null || first === null || count === null) throw new XrefFormatError('Invalid XRef table: wrong types in subsection header');
    pos = countToken.end;
    for (let index = 0; index < count; index++) {
      const offsetToken = next(pos);
      const genToken = offsetToken === null ? null : next(offsetToken.end);
      const typeToken = genToken === null ? null : next(genToken.end);
      const offset = integerOf(offsetToken);
      const gen = integerOf(genToken);
      const type = typeToken?.kind === 'command' ? typeToken.text : null;
      if (typeToken === null || offset === null || gen === null || (type !== 'f' && type !== 'n')) {
        throw new XrefFormatError(`Invalid entry in XRef subsection: ${first}, ${count}`);
      }
      if (index === 0 && type === 'f' && first === 1) first = 0;
      add(first + index, { kind: type === 'f' ? 'free' : 'offset', offset, gen });
      pos = typeToken.end;
    }
  }
}

/**
 * Reads the rows of an xref stream's decoded `data`: `widths` are the byte widths of the type, offset and generation fields
 * (/W), `ranges` the pairs of first object number and count (/Index, or 0 and /Size), both as the dictionary holds them (pdf.js
 * does not follow a reference inside either array). A missing type field means type 1; types other than 0, 1 and 2 are rejected,
 * and a field is built as `(value << 8) | byte` is, whatever its width (xref.js lines 340-418, pdf.worker.mjs lines 58587-58666).
 *
 * pdf.js adds a row's entry only if its number has none yet, so a range that repeats numbers adds nothing and nothing but the
 * rows bounds the work. A row of a width that takes no byte takes no data either, so `maxRows` bounds the sum of the counts of
 * the ranges, the repeated ones included, and a section whose fields all take no byte is refused: its rows could be repeated
 * without end, and every one of them is an entry with no offset (an absent object).
 * @throws XrefFormatError for a field width, a range or a row pdf.js rejects, after the rows before it were added.
 * @throws PdfStructureError for more rows than `maxRows`, or rows of no byte.
 */
export function readXrefStreamRows(data: Buffer, widths: readonly unknown[], ranges: readonly unknown[], add: AddXrefEntry, maxRows: number): void {
  const [typeWidth, offsetWidth, genWidth] = widths;
  let pos = 0;
  const field = (width: number): number => {
    let value = 0;
    for (let byte = 0; byte < width; byte++) {
      if (pos >= data.length) throw new XrefFormatError('Invalid XRef byteWidths');
      value = (value << 8) | data[pos++];
    }
    return value;
  };
  let rows = 0;
  for (let at = 0; at < ranges.length; at += 2) {
    const first = ranges[at];
    const count = ranges[at + 1];
    if (!Number.isInteger(first) || !Number.isInteger(count)) throw new XrefFormatError(`Invalid XRef range fields: ${String(first)}, ${String(count)}`);
    if (!Number.isInteger(typeWidth) || !Number.isInteger(offsetWidth) || !Number.isInteger(genWidth)) throw new XrefFormatError('Invalid XRef entry fields length');
    const fieldWidths = [typeWidth, offsetWidth, genWidth] as number[];
    if (count as number > 0) {
      rows += count as number;
      if (rows > maxRows) throw new PdfStructureError(`PDF cross-reference stream lists more than ${maxRows} rows.`);
      if (fieldWidths.every((width) => width <= 0)) throw new PdfStructureError('PDF cross-reference stream has rows that take no bytes.');
    }
    for (let index = 0; index < (count as number); index++) {
      const type = fieldWidths[0] === 0 ? 1 : field(fieldWidths[0]);
      const offset = field(fieldWidths[1]);
      const gen = field(fieldWidths[2]);
      if (type !== 0 && type !== 1 && type !== 2) throw new XrefFormatError(`Invalid XRef entry type: ${type}`);
      add((first as number) + index, { kind: STREAM_ENTRY_KINDS[type], offset, gen });
    }
  }
}
