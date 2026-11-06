/**
 * Cross-reference readers for the object index of `PdfDocument`, written after `XRef` of pdf.js (mozilla/pdf.js v6.3.289,
 * Apache-2.0, src/core/xref.js): `readXRefTable` (lines 160-246), `readXRefStream` (lines 285-425) and the `startXRef` getter of
 * `PDFDocument` (src/core/document.js lines 1070-1120). They only parse sections; which object a number leads to, and what
 * pdf.js does when a section is damaged, is decided by the caller.
 *
 * Entries keep the first definition of a number, as `this.#entries[first + i] ??= entry` does: sections are read newest first, so a
 * number's newest entry wins, a free entry included.
 */

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
const CHAR_NINE = 57;
const DELIMITERS = '()<>[]{}/%';
const STARTXREF = 'startxref';
const HEADER = '%PDF-';
/** pdf.js looks for the header in the first kilobyte (`PDFDocument.checkHeader`, `find(stream, "%PDF-", 1024)`). */
const HEADER_SEARCH_BYTES = 1024;
const INTEGER = /^[+-]?\d+$/;
/** The kind of an xref stream entry by its type field (0 free, 1 at an offset, 2 in an object stream). */
const STREAM_ENTRY_KINDS = ['free', 'offset', 'member'] as const;

function isWhiteCode(code: number): boolean {
  return code === CHAR_SPACE || code === CHAR_LF || code === CHAR_CR || code === CHAR_TAB || code === CHAR_FF || code === CHAR_NUL;
}

function integerOf(token: string): number | null {
  return INTEGER.test(token) ? Number(token) : null;
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

/** The next token of the lexer: white space and comments skipped, then a run of regular characters or one delimiter. */
function tokenAt(text: string, from: number): { token: string; end: number } | null {
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
  if (pos >= text.length) return null;
  const start = pos;
  if (DELIMITERS.includes(text[pos])) return { token: text[pos], end: pos + 1 };
  while (pos < text.length && !isWhiteCode(text.charCodeAt(pos)) && !DELIMITERS.includes(text[pos])) pos++;
  return { token: text.slice(start, pos), end: pos };
}

/**
 * Reads the subsections of the classic table whose entries start at `from` (after the `xref` keyword), up to the `trailer`
 * keyword, and returns the position after it. A first subsection that starts at 1 with a free first entry is shifted to 0
 * (xref.js lines 220-225, issues 3248 and 7229 of pdf.js).
 * @throws XrefFormatError for an entry or a subsection header pdf.js rejects, after the entries before it were added.
 */
export function readXrefTable(text: string, from: number, add: AddXrefEntry): number {
  let pos = from;
  for (;;) {
    const head = tokenAt(text, pos);
    if (head === null) throw new XrefFormatError('Invalid XRef table: could not find trailer dictionary');
    if (head.token === 'trailer') return head.end;
    const countToken = tokenAt(text, head.end);
    let first = integerOf(head.token);
    const count = countToken === null ? null : integerOf(countToken.token);
    if (countToken === null || first === null || count === null) throw new XrefFormatError('Invalid XRef table: wrong types in subsection header');
    pos = countToken.end;
    for (let index = 0; index < count; index++) {
      const offsetToken = tokenAt(text, pos);
      const genToken = offsetToken === null ? null : tokenAt(text, offsetToken.end);
      const typeToken = genToken === null ? null : tokenAt(text, genToken.end);
      const offset = offsetToken === null ? null : integerOf(offsetToken.token);
      const gen = genToken === null ? null : integerOf(genToken.token);
      const type = typeToken?.token;
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
 * (/W), `ranges` the pairs of first object number and count (/Index, or 0 and /Size). A missing type field means type 1; types
 * other than 0, 1 and 2 are rejected (xref.js lines 340-418).
 * @throws XrefFormatError for a field width, a range or a row pdf.js rejects, after the rows before it were added.
 */
export function readXrefStreamRows(data: Buffer, widths: readonly unknown[], ranges: readonly unknown[], add: AddXrefEntry): void {
  const [typeWidth, offsetWidth, genWidth] = widths;
  if (!Number.isInteger(typeWidth) || !Number.isInteger(offsetWidth) || !Number.isInteger(genWidth)) {
    throw new XrefFormatError('Invalid XRef entry fields length');
  }
  const fieldWidths = [typeWidth, offsetWidth, genWidth] as number[];
  if (fieldWidths.some((width) => width < 0 || width > 8)) throw new XrefFormatError('Invalid XRef entry fields length');
  let pos = 0;
  const field = (width: number): number => {
    let value = 0;
    for (let byte = 0; byte < width; byte++) {
      if (pos >= data.length) throw new XrefFormatError('Invalid XRef byteWidths');
      value = value * 256 + data[pos++];
    }
    return value;
  };
  for (let at = 0; at < ranges.length; at += 2) {
    const first = ranges[at];
    const count = ranges[at + 1];
    if (!Number.isInteger(first) || !Number.isInteger(count)) throw new XrefFormatError(`Invalid XRef range fields: ${String(first)}, ${String(count)}`);
    for (let index = 0; index < (count as number); index++) {
      const type = fieldWidths[0] === 0 ? 1 : field(fieldWidths[0]);
      const offset = field(fieldWidths[1]);
      const gen = field(fieldWidths[2]);
      if (type !== 0 && type !== 1 && type !== 2) throw new XrefFormatError(`Invalid XRef entry type: ${type}`);
      add((first as number) + index, { kind: STREAM_ENTRY_KINDS[type], offset, gen });
    }
  }
}
