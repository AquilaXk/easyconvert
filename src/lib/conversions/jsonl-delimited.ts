import { isUtf8 } from 'node:buffer';
import type { ConversionOptions } from '../types';
import { ChunkedOutput } from './chunked-output';
import { MAX_INTEGER_LITERAL_DIGITS } from './data-json';
import {
  CHAR_AT,
  CHAR_BACKSLASH,
  CHAR_COMMA,
  CHAR_CR,
  CHAR_EQUALS,
  CHAR_LF,
  CHAR_MINUS,
  CHAR_NINE,
  CHAR_PLUS,
  CHAR_QUOTE,
  CHAR_SPACE,
  CHAR_TAB,
  CHAR_ZERO,
  formatDelimitedString,
} from './delimited-cells';
import { DELIMITED_RECORD_SEPARATOR, FORMULA_TRIGGER, UTF8_BOM_CHAR, writesBomByDefault } from './delimited-rules';

/**
 * JSON Lines / NDJSON to CSV or TSV, read straight from the bytes of flat UTF-8 object lines. It declines (returns
 * null) on nested objects and arrays, \uXXXX escapes, keys that first appear after the first record, keys that
 * would be array indices, and any encoding or syntax error, so the general route converts that input and reports
 * its errors. Rows are written as they are read, in chunks, so no string per row is kept.
 */

class JsonLinesDecline extends Error {
  constructor() {
    super('JSON Lines input the direct route does not handle');
    this.name = 'JsonLinesDecline';
  }
}

/** Thrown for every decline: the cause is of no interest to the caller, so one error serves them all. */
const DECLINE = new JsonLinesDecline();

function decline(): never {
  throw DECLINE;
}

const CHAR_COLON = 0x3a;
const CHAR_DOT = 0x2e;
const CHAR_SLASH = 0x2f;
const CHAR_UPPER_E = 0x45;
const CHAR_LOWER_E = 0x65;
const CHAR_OPEN_BRACE = 0x7b;
const CHAR_CLOSE_BRACE = 0x7d;
const UTF8_BOM_BYTES = [0xef, 0xbb, 0xbf];
const UTF16_BOMS = [
  [0xff, 0xfe],
  [0xfe, 0xff],
];
const TRUE_BYTES = Buffer.from('true');
const FALSE_BYTES = Buffer.from('false');
const NULL_BYTES = Buffer.from('null');
const SIMPLE_ESCAPES = new Map<number, string>([
  [CHAR_QUOTE, '"'],
  [CHAR_BACKSLASH, '\\'],
  [CHAR_SLASH, '/'],
  [0x62, '\b'],
  [0x66, '\f'],
  [0x6e, '\n'],
  [0x72, '\r'],
  [0x74, '\t'],
]);

/** Rows joined into one string before they are written. */
const ROW_WRITE_BATCH = 32;

/** What the scan of a string without escapes saw. */
const SAW_DELIMITER = 1;
const SAW_BOM_LEAD = 2;
const SAW_ESCAPE = 4;

interface CellStyle {
  delimiter: string;
  delimiterCode: number;
  escapeFormulas: boolean;
}

function startsWithBytes(input: Buffer, signature: readonly number[]): boolean {
  return input.length >= signature.length && signature.every((byte, index) => input[index] === byte);
}

function isDigit(byte: number): boolean {
  return byte >= CHAR_ZERO && byte <= CHAR_NINE;
}

class JsonLinesWriter {
  private pos: number;
  private readonly end: number;
  private readonly fields: string[] = [];
  private readonly keyBytes: Uint8Array[] = [];
  private readonly fieldIndex = new Map<string, number>();
  private numCols = 0;
  private singleColumn = false;
  private emptyCell = '';
  private seenRow = new Int32Array(0);
  private readonly rowCells: string[] = [];
  private rowCount = 0;
  private recordId = 0;
  private columnCursor = 0;
  private batch = '';
  private batchRows = 0;

  constructor(
    private readonly input: Buffer,
    start: number,
    private readonly style: CellStyle,
    private readonly withBom: boolean,
    private readonly out: ChunkedOutput
  ) {
    this.pos = start;
    this.end = input.length;
  }

  /** Writes the whole input; declines (throws) when it holds anything the direct route does not handle. */
  run(): void {
    while (this.startRecord()) {
      this.readRecord();
      this.endRecord();
    }
    if (this.rowCount === 0) decline();
    this.out.writeUtf8(this.batch);
  }

  private skipBlanks(): void {
    const { input, end } = this;
    while (this.pos < end && (input[this.pos] === CHAR_SPACE || input[this.pos] === CHAR_TAB)) this.pos++;
  }

  /** Moves past blank lines to the `{` of the next record; false at the end of the input. */
  private startRecord(): boolean {
    const { input, end } = this;
    for (;;) {
      this.skipBlanks();
      if (this.pos >= end) return false;
      const byte = input[this.pos];
      if (byte === CHAR_LF) {
        this.pos++;
        continue;
      }
      if (byte !== CHAR_CR) break;
      if (this.pos + 1 >= end) return false;
      if (input[this.pos + 1] !== CHAR_LF) decline();
      this.pos += 2;
    }
    if (input[this.pos] !== CHAR_OPEN_BRACE) decline();
    this.pos++;
    this.skipBlanks();
    if (this.pos >= end || input[this.pos] === CHAR_CLOSE_BRACE) decline();
    return true;
  }

  private readRecord(): void {
    const { input, end } = this;
    this.recordId = this.rowCount + 1;
    this.columnCursor = 0;
    for (;;) {
      const column = this.readKey();
      this.columnCursor = column + 1;
      this.expectColon();
      const cell = this.readValue();
      if (this.rowCount === 0) this.rowCells.push(cell);
      else this.rowCells[column] = cell;
      this.skipBlanks();
      if (this.pos >= end) decline();
      const separator = input[this.pos];
      if (separator === CHAR_CLOSE_BRACE) {
        this.pos++;
        return;
      }
      if (separator !== CHAR_COMMA) decline();
      this.pos++;
      this.skipBlanks();
    }
  }

  private readKey(): number {
    const { input, end } = this;
    if (input[this.pos] !== CHAR_QUOTE) decline();
    const keyStart = ++this.pos;
    while (this.pos < end && input[this.pos] !== CHAR_QUOTE) {
      const byte = input[this.pos];
      if (byte < CHAR_SPACE || byte === CHAR_BACKSLASH) decline();
      this.pos++;
    }
    if (this.pos >= end) decline();
    const keyEnd = this.pos++;
    return this.rowCount === 0 ? this.registerKey(keyStart, keyEnd) : this.lookupKey(keyStart, keyEnd);
  }

  /** A key of the first record becomes a column. */
  private registerKey(keyStart: number, keyEnd: number): number {
    if (keyEnd > keyStart && isDigit(this.input[keyStart])) decline();
    const key = this.input.toString('utf8', keyStart, keyEnd);
    if (key === '__proto__' || this.fieldIndex.has(key)) decline();
    const column = this.fields.length;
    this.fields.push(key);
    this.keyBytes.push(this.input.subarray(keyStart, keyEnd));
    this.fieldIndex.set(key, column);
    return column;
  }

  /** A key of a later record must be a column of the first record, and appear once. */
  private lookupKey(keyStart: number, keyEnd: number): number {
    let column = -1;
    if (this.columnCursor < this.numCols && this.keyIs(this.columnCursor, keyStart, keyEnd)) {
      column = this.columnCursor;
    } else {
      for (let k = 0; k < this.numCols && column === -1; k++) {
        if (this.keyIs(k, keyStart, keyEnd)) column = k;
      }
    }
    if (column === -1 || this.seenRow[column] === this.recordId) decline();
    this.seenRow[column] = this.recordId;
    return column;
  }

  private keyIs(column: number, keyStart: number, keyEnd: number): boolean {
    const expected = this.keyBytes[column];
    if (keyEnd - keyStart !== expected.length) return false;
    for (let i = 0; i < expected.length; i++) {
      if (this.input[keyStart + i] !== expected[i]) return false;
    }
    return true;
  }

  private expectColon(): void {
    this.skipBlanks();
    if (this.pos >= this.end || this.input[this.pos] !== CHAR_COLON) decline();
    this.pos++;
    this.skipBlanks();
    if (this.pos >= this.end) decline();
  }

  private readValue(): string {
    const byte = this.input[this.pos];
    if (byte === CHAR_QUOTE) return this.readString();
    if (byte === CHAR_MINUS || isDigit(byte)) return this.readNumber();
    if (this.takeLiteral(TRUE_BYTES)) return 'true';
    if (this.takeLiteral(FALSE_BYTES)) return 'false';
    if (this.takeLiteral(NULL_BYTES)) return this.emptyCell;
    return decline();
  }

  private takeLiteral(literal: Uint8Array): boolean {
    if (this.pos + literal.length > this.end) return false;
    for (let i = 0; i < literal.length; i++) {
      if (this.input[this.pos + i] !== literal[i]) return false;
    }
    this.pos += literal.length;
    return true;
  }

  /** Scans a string up to its closing quote or its first backslash; leaves `pos` there. */
  private scanPlainString(): number {
    const { input, end } = this;
    const { delimiterCode } = this.style;
    let seen = 0;
    while (this.pos < end) {
      const byte = input[this.pos];
      if (byte === CHAR_QUOTE) break;
      if (byte === CHAR_BACKSLASH) {
        seen |= SAW_ESCAPE;
        break;
      }
      if (byte < CHAR_SPACE) decline();
      if (byte === delimiterCode) seen |= SAW_DELIMITER;
      else if (byte === UTF8_BOM_BYTES[0]) seen |= SAW_BOM_LEAD;
      this.pos++;
    }
    if (this.pos >= end) decline();
    return seen;
  }

  private readString(): string {
    const start = ++this.pos;
    const seen = this.scanPlainString();
    if ((seen & SAW_ESCAPE) !== 0) return this.readEscapedString(start);
    const stop = this.pos++;
    return stop === start ? this.emptyCell : this.quoteRawString(start, stop, seen);
  }

  /** A string without escapes: the text of the bytes, quoted the way the delimited writer quotes it. */
  private quoteRawString(start: number, stop: number, seen: number): string {
    const { input } = this;
    const first = input[start];
    const raw = input.toString('utf8', start, stop);
    if (this.style.escapeFormulas && this.opensFormula(first, raw)) return `"'${raw}"`;
    const spaced = first === CHAR_SPACE || input[stop - 1] === CHAR_SPACE;
    const bomInside = (seen & SAW_BOM_LEAD) !== 0 && raw.includes(UTF8_BOM_CHAR);
    return spaced || (seen & SAW_DELIMITER) !== 0 || bomInside ? `"${raw}"` : raw;
  }

  private opensFormula(first: number, raw: string): boolean {
    if (first === CHAR_EQUALS || first === CHAR_AT) return true;
    return (first === CHAR_PLUS || first === CHAR_MINUS) && FORMULA_TRIGGER.test(raw);
  }

  /** A string with escapes: decoded, then written by the general cell rules. */
  private readEscapedString(start: number): string {
    const { input, end } = this;
    let decoded = input.toString('utf8', start, this.pos);
    let chunkStart = this.pos;
    for (;;) {
      if (this.pos >= end) decline();
      const byte = input[this.pos];
      if (byte === CHAR_QUOTE) {
        decoded += input.toString('utf8', chunkStart, this.pos);
        this.pos++;
        break;
      }
      if (byte < CHAR_SPACE) decline();
      if (byte !== CHAR_BACKSLASH) {
        this.pos++;
        continue;
      }
      decoded += input.toString('utf8', chunkStart, this.pos);
      decoded += this.readEscape();
      chunkStart = this.pos;
    }
    return formatDelimitedString(decoded, this.style.delimiterCode, this.style.escapeFormulas, this.singleColumn);
  }

  /** The character of the escape at `pos` (a backslash); \u escapes are declined. */
  private readEscape(): string {
    if (this.pos + 1 >= this.end) decline();
    const character = SIMPLE_ESCAPES.get(this.input[this.pos + 1]);
    if (character === undefined) decline();
    this.pos += 2;
    return character;
  }

  private skipDigits(): number {
    const start = this.pos;
    while (this.pos < this.end && isDigit(this.input[this.pos])) this.pos++;
    return this.pos - start;
  }

  /** Digits after a mark (a point or an exponent sign); at least one is required. */
  private requireDigits(): void {
    if (this.skipDigits() === 0) decline();
  }

  private readNumber(): string {
    const { input, end } = this;
    const start = this.pos;
    if (input[this.pos] === CHAR_MINUS) this.pos++;
    if (this.pos >= end || !isDigit(input[this.pos])) decline();
    let integerDigits = 1;
    if (input[this.pos++] !== CHAR_ZERO) integerDigits += this.skipDigits();
    const hasFraction = this.skipFraction();
    const hasExponent = this.skipExponent();
    if (!hasFraction && !hasExponent) return this.integerCell(start, integerDigits);
    const number = Number(input.toString('ascii', start, this.pos));
    return Number.isFinite(number) ? String(number) : decline();
  }

  /** Reads a fraction when one follows; true when it did. */
  private skipFraction(): boolean {
    if (this.pos >= this.end || this.input[this.pos] !== CHAR_DOT) return false;
    this.pos++;
    this.requireDigits();
    return true;
  }

  /** Reads an exponent when one follows; true when it did. */
  private skipExponent(): boolean {
    const { input, end } = this;
    if (this.pos >= end || (input[this.pos] !== CHAR_LOWER_E && input[this.pos] !== CHAR_UPPER_E)) return false;
    this.pos++;
    if (this.pos < end && (input[this.pos] === CHAR_PLUS || input[this.pos] === CHAR_MINUS)) this.pos++;
    this.requireDigits();
    return true;
  }

  private integerCell(start: number, integerDigits: number): string {
    if (integerDigits > MAX_INTEGER_LITERAL_DIGITS) decline();
    const isNegativeZero = this.pos - start === 2 && this.input[start] === CHAR_MINUS && this.input[start + 1] === CHAR_ZERO;
    return isNegativeZero ? '0' : this.input.toString('ascii', start, this.pos);
  }

  /** After the closing brace: only blanks up to the line break (or the end) may follow. */
  private endOfLine(): void {
    const { input, end } = this;
    this.skipBlanks();
    if (this.pos >= end) return;
    if (input[this.pos] === CHAR_LF) {
      this.pos++;
    } else if (input[this.pos] === CHAR_CR && this.pos + 1 < end && input[this.pos + 1] === CHAR_LF) {
      this.pos += 2;
    } else if (input[this.pos] === CHAR_CR && this.pos + 1 === end) {
      this.pos++;
    } else {
      decline();
    }
  }

  private endRecord(): void {
    this.endOfLine();
    if (this.rowCount === 0) this.endFirstRecord();
    else this.emitRow(this.rowLine());
    this.rowCount++;
  }

  /** The first record fixes the columns, the header line and the cell that stands for an empty value. */
  private endFirstRecord(): void {
    const { delimiter, delimiterCode, escapeFormulas } = this.style;
    this.numCols = this.fields.length;
    this.singleColumn = this.numCols === 1;
    this.emptyCell = this.singleColumn ? '""' : '';
    this.seenRow = new Int32Array(this.numCols);
    const header = this.fields
      .map((name) => formatDelimitedString(name, delimiterCode, escapeFormulas, this.singleColumn))
      .join(delimiter);
    this.batch = this.withBom ? UTF8_BOM_CHAR + header : header;
    if (this.singleColumn && this.rowCells[0] === '') this.rowCells[0] = '""';
    this.emitRow(this.rowCells.join(delimiter));
  }

  private rowLine(): string {
    const { delimiter } = this.style;
    const { rowCells, seenRow, emptyCell, recordId } = this;
    let line = seenRow[0] === recordId ? rowCells[0] : emptyCell;
    for (let c = 1; c < this.numCols; c++) {
      line += delimiter + (seenRow[c] === recordId ? rowCells[c] : emptyCell);
    }
    return line;
  }

  private emitRow(line: string): void {
    this.batch += DELIMITED_RECORD_SEPARATOR + line;
    if (++this.batchRows < ROW_WRITE_BATCH) return;
    this.out.writeUtf8(this.batch);
    this.batch = '';
    this.batchRows = 0;
  }
}

export function jsonLinesToDelimited(
  input: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: ConversionOptions = {}
): Buffer | null {
  const source = sourceFormat.toLowerCase();
  const target = targetFormat.toLowerCase();
  if ((source !== 'jsonl' && source !== 'ndjson') || (target !== 'csv' && target !== 'tsv')) return null;
  // UTF-16 and invalid UTF-8 are left to the general route, which names the encoding error.
  if (input.length === 0 || UTF16_BOMS.some((bom) => startsWithBytes(input, bom)) || !isUtf8(input)) return null;

  const start = startsWithBytes(input, UTF8_BOM_BYTES) ? UTF8_BOM_BYTES.length : 0;
  const style: CellStyle = {
    delimiter: target === 'tsv' ? '\t' : ',',
    delimiterCode: target === 'tsv' ? CHAR_TAB : CHAR_COMMA,
    escapeFormulas: options.escapeFormulas ?? true,
  };
  const out = new ChunkedOutput({ expectedBytes: input.length });
  try {
    new JsonLinesWriter(input, start, style, options.bom ?? writesBomByDefault(target), out).run();
  } catch (error) {
    if (error === DECLINE) return null;
    throw error;
  }
  return out.toBuffer();
}
