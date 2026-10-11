import { isUtf8 } from 'node:buffer';
import { LINE_BREAK_GUESS_WINDOW_CHARS, renameDuplicateHeaders } from './delimited-detect';
import { PARQUET_MAX_COLUMNS } from './parquet-format';

/**
 * Byte-level reader for well-formed delimited text (CSV, TSV): it records where every cell lies in the input
 * instead of building a string per cell, so a table can be written without ever materialising its cells as
 * JavaScript strings.
 *
 * It reads exactly the subset of delimited text on which the general reader (papaparse over decoded text, see
 * delimited-detect.ts) has one unambiguous answer: valid UTF-8, one line-break style, cells that are either free of
 * quotes or wrapped in quotes with doubled inner quotes, and every record as wide as the header. Anything else
 * (another encoding, a stray quote, a ragged record, mixed line breaks) throws {@link DelimitedBytesUnsupported}, and
 * the caller reads the file with the general reader, which also owns every error message.
 */

export class DelimitedBytesUnsupported extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'DelimitedBytesUnsupported';
  }
}

const QUOTE = 0x22;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const UTF8_BOM: readonly number[] = [0xef, 0xbb, 0xbf];
const UTF16_BOMS: readonly (readonly number[])[] = [
  [0xff, 0xfe],
  [0xfe, 0xff],
];
/** Leading bytes searched for the NUL lane of BOM-less UTF-16, which the general reader decodes as UTF-16. */
const UTF16_SNIFF_BYTES = 4096;
const CONTINUATION_MASK = 0xc0;
const CONTINUATION_BITS = 0x80;
const FOUR_BYTE_LEAD = 0xf0;
const INITIAL_CHUNK_ROWS = 4096;
/** Cell offsets are 32-bit. */
const MAX_INPUT_BYTES = 0x7fff_fff0;
/** Highest byte value that needs a look in the unquoted cell scan: control characters, space, `!` and the quote. */
const SPECIAL_BYTE_LIMIT = QUOTE;
const BYTES_PER_LENGTH_PREFIX = 4;

type LineBreakStyle = 'lf' | 'crlf';

export interface CellChunk {
  /** The bytes the offsets point into (a private copy once a cell with doubled quotes was collapsed). */
  data: Buffer;
  /** Records held. */
  rows: number;
  /** Row-major: the cell of row r and column c is at index r * width + c. */
  starts: Int32Array;
  /** Byte length of each cell, after a quoted cell's doubled quotes are collapsed. */
  lengths: Int32Array;
}

function unsupported(reason: string): never {
  throw new DelimitedBytesUnsupported(reason);
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
}

/**
 * The line-break style the general reader guesses for this file (guessLineBreak, over the first 1 MiB of text). The
 * common cases are decided on the bytes: no carriage return in the head means LF, and a head whose line feeds and
 * carriage returns all pair up means CRLF. A head with cells that hold line breaks of their own is guessed by the
 * same rules as guessLineBreak, applied to the bytes outside quoted spans.
 */
function lineBreakStyle(data: Buffer, start: number): LineBreakStyle | null {
  // A file that fits the guess window is read whole, and the scan below fails on any break that does not match the
  // first one it meets, so that first break is the style the general reader would guess for it.
  if (data.length - start <= LINE_BREAK_GUESS_WINDOW_CHARS) return null;
  const head = data.subarray(start, start + guessWindowBytes(data, start));
  if (head.indexOf(CARRIAGE_RETURN) === -1) return 'lf';
  if (pairsUp(head, data[start + head.length] ?? -1)) return 'crlf';
  const guessed = guessOutsideQuotes(head);
  return guessed === 'cr' ? unsupported('lone carriage returns as line breaks') : guessed;
}

/** Bytes that make up the first LINE_BREAK_GUESS_WINDOW_CHARS UTF-16 units of the text that starts at `start`. */
function guessWindowBytes(data: Buffer, start: number): number {
  const available = data.length - start;
  // Every character takes at least one byte, so a window of that many bytes always lies inside the character window.
  if (available <= LINE_BREAK_GUESS_WINDOW_CHARS) return available;
  let units = 0;
  let at = start;
  while (at < data.length && units < LINE_BREAK_GUESS_WINDOW_CHARS) {
    const byte = data[at++];
    if ((byte & CONTINUATION_MASK) === CONTINUATION_BITS) continue;
    units += byte >= FOUR_BYTE_LEAD ? 2 : 1;
    if (units >= LINE_BREAK_GUESS_WINDOW_CHARS) break;
  }
  while (at < data.length && (data[at] & CONTINUATION_MASK) === CONTINUATION_BITS) at++;
  return at - start;
}

/**
 * Whether every line feed in `head` follows a carriage return and every carriage return is followed by a line feed;
 * `after` is the byte after the head, or -1.
 */
function pairsUp(head: Buffer, after: number): boolean {
  for (let at = head.indexOf(LINE_FEED); at !== -1; at = head.indexOf(LINE_FEED, at + 1)) {
    if (at === 0 || head[at - 1] !== CARRIAGE_RETURN) return false;
  }
  for (let at = head.indexOf(CARRIAGE_RETURN); at !== -1; at = head.indexOf(CARRIAGE_RETURN, at + 1)) {
    // A carriage return that ends the head is followed by the first byte past it.
    if ((at + 1 === head.length ? after : head[at + 1]) !== LINE_FEED) return false;
  }
  return true;
}

/**
 * guessLineBreak on bytes: quoted spans (a quote up to the next quote, paired from the start; a quote left open at
 * the end pairs with nothing and its tail counts) are dropped, then LF wins when there is no CR or an LF comes first,
 * CRLF when at least half of the pieces the CRs cut the text into start with an LF, else CR.
 */
function guessOutsideQuotes(head: Buffer): 'lf' | 'crlf' | 'cr' {
  let inside = false;
  let opened = 0;
  let kept = 0;
  let firstCr = -1;
  let firstLf = -1;
  let carriageReturns = 0;
  let pairs = 0;
  let previous = -1;
  const keep = (byte: number): void => {
    if (byte === CARRIAGE_RETURN) {
      if (firstCr < 0) firstCr = kept;
      carriageReturns++;
    } else if (byte === LINE_FEED) {
      if (firstLf < 0) firstLf = kept;
      if (previous === CARRIAGE_RETURN || kept === 0) pairs++;
    }
    previous = byte;
    kept++;
  };
  for (let i = 0; i < head.length; i++) {
    const byte = head[i];
    if (byte === QUOTE) {
      inside = !inside;
      if (inside) opened = i;
      continue;
    }
    if (!inside && (byte === CARRIAGE_RETURN || byte === LINE_FEED)) keep(byte);
    else if (!inside) {
      previous = byte;
      kept++;
    }
  }
  if (inside) {
    // The last quote never closed, so the regular expression leaves everything after it in place.
    for (let i = opened + 1; i < head.length; i++) {
      const byte = head[i];
      if (byte === CARRIAGE_RETURN || byte === LINE_FEED) keep(byte);
      else {
        previous = byte;
        kept++;
      }
    }
  }
  const lfAppearsFirst = firstLf >= 0 && (firstCr < 0 ? true : firstLf < firstCr);
  if (carriageReturns === 0 || lfAppearsFirst) return 'lf';
  return pairs >= (carriageReturns + 1) / 2 ? 'crlf' : 'cr';
}

export class DelimitedByteScanner {
  /** The input, or a private copy of it once a cell with doubled quotes had to be collapsed in place. */
  data: Buffer;
  /** Cells per record. */
  width = 0;
  /** Column names, as the general reader names them (a leading BOM stripped, repeated names suffixed). */
  header: string[] = [];
  private pos: number;
  private owned = false;
  private pending: { starts: Int32Array; lengths: Int32Array; bytes: number } | null = null;
  private rowStarts = new Int32Array(0);
  private rowLengths = new Int32Array(0);

  private constructor(
    data: Buffer,
    private readonly delimiter: number,
    private style: LineBreakStyle | null,
    pos: number
  ) {
    this.data = data;
    this.pos = pos;
  }

  /**
   * Opens `input` for scanning, or throws {@link DelimitedBytesUnsupported}. `delimiter` is a single ASCII character.
   * `autoDetected` marks a delimiter that is only the format's nominal one: the general reader keeps it only for a
   * table of two or more columns, so a one-column table is left to it.
   */
  static open(input: Buffer, delimiter: string, autoDetected: boolean): DelimitedByteScanner {
    if (delimiter.length !== 1 || delimiter.charCodeAt(0) > 0x7f) unsupported('a delimiter that is not ASCII');
    if (input.length > MAX_INPUT_BYTES) unsupported('input beyond the offset range');
    let start = 0;
    if (startsWith(input, UTF8_BOM)) start = UTF8_BOM.length;
    else if (UTF16_BOMS.some((bom) => startsWith(input, bom))) unsupported('a UTF-16 byte-order mark');
    else if (input.subarray(0, UTF16_SNIFF_BYTES).includes(0)) unsupported('NUL bytes in the head of the input');
    if (!isUtf8(input)) unsupported('input that is not UTF-8');
    const scanner = new DelimitedByteScanner(input, delimiter.charCodeAt(0), lineBreakStyle(input, start), start);
    scanner.readHeader(autoDetected);
    return scanner;
  }

  private readHeader(autoDetected: boolean): void {
    const starts = new Int32Array(PARQUET_MAX_COLUMNS + 1);
    const lengths = new Int32Array(PARQUET_MAX_COLUMNS + 1);
    const count = this.readCells(starts, lengths, 0, PARQUET_MAX_COLUMNS + 1, true);
    if (count < 0) unsupported('no header record');
    if (count > PARQUET_MAX_COLUMNS) unsupported('more columns than a Parquet file holds');
    if (autoDetected && count < 2) unsupported('a one-column table, whose delimiter the general reader detects');
    const names: string[] = [];
    for (let i = 0; i < count; i++) names.push(this.data.toString('utf8', starts[i], starts[i] + lengths[i]));
    this.width = count;
    this.header = renameDuplicateHeaders(names);
    this.rowStarts = new Int32Array(count);
    this.rowLengths = new Int32Array(count);
  }

  /**
   * Reads the next non-blank record into `starts`/`lengths` at `base` and returns its width, or -1 at the end of the
   * input. The record must be exactly `limit` cells wide, unless `atMost` is set (the header: any width up to `limit`).
   */
  private readCells(starts: Int32Array, lengths: Int32Array, base: number, limit: number, atMost = false): number {
    let data = this.data;
    const size = data.length;
    const delimiter = this.delimiter;
    for (;;) {
      if (this.pos >= size) return -1;
      let column = 0;
      for (;;) {
        let cellStart = this.pos;
        let cellEnd: number;
        let next: number;
        if (cellStart < size && data[cellStart] === QUOTE) {
          cellStart++;
          let scan = cellStart;
          let escaped = false;
          for (;;) {
            while (scan < size && data[scan] !== QUOTE) scan++;
            if (scan >= size) return unsupported('an unterminated quoted cell');
            if (data[scan + 1] === QUOTE) {
              escaped = true;
              scan += 2;
              continue;
            }
            break;
          }
          cellEnd = escaped ? this.collapseQuotes(cellStart, scan) : scan;
          data = this.data;
          next = scan + 1;
        } else {
          let scan = cellStart;
          while (scan < size) {
            const byte = data[scan];
            if (byte <= SPECIAL_BYTE_LIMIT || byte === delimiter) {
              if (byte === delimiter || byte === LINE_FEED || byte === CARRIAGE_RETURN) break;
              if (byte === QUOTE) return unsupported('a quote inside an unquoted cell');
            }
            scan++;
          }
          cellEnd = scan;
          next = scan;
        }

        // What ends the cell: a delimiter, a line break, or the end of the input.
        const byte = next < size ? data[next] : -1;
        let rowEnds = true;
        if (byte === delimiter) {
          rowEnds = false;
          this.pos = next + 1;
        } else if (byte === -1) {
          this.pos = size;
        } else if (byte === LINE_FEED && this.style !== 'crlf') {
          this.style = 'lf';
          this.pos = next + 1;
        } else if (byte === CARRIAGE_RETURN && this.style !== 'lf' && data[next + 1] === LINE_FEED) {
          this.style = 'crlf';
          this.pos = next + 2;
        } else {
          return unsupported('a line break outside the file line-break style, or text after a closing quote');
        }

        if (column >= limit) return unsupported('a record wider than the header');
        starts[base + column] = cellStart;
        lengths[base + column] = cellEnd - cellStart;
        column++;
        if (rowEnds) break;
      }
      if (column === 1 && lengths[base] === 0) continue; // a blank line: the general reader skips it
      if (!atMost && column !== limit) return unsupported('a record narrower than the header');
      return column;
    }
  }

  /** Rewrites the quoted cell [start, end) with its doubled quotes collapsed, in place; returns the new end. */
  private collapseQuotes(start: number, end: number): number {
    if (!this.owned) {
      this.data = Buffer.from(this.data);
      this.owned = true;
    }
    const data = this.data;
    let write = start;
    for (let read = start; read < end; read++) {
      data[write++] = data[read];
      if (data[read] === QUOTE) read++;
    }
    return write;
  }

  /**
   * Reads up to `maxRows` records, stopping before a record that would take the group past `maxBytes` of PLAIN
   * string storage (4 length bytes per cell plus the cell bytes) unless it is the first. Returns null when the input
   * is exhausted.
   */
  nextChunk(maxRows: number, maxBytes: number): CellChunk | null {
    const width = this.width;
    let capacity = Math.min(maxRows, INITIAL_CHUNK_ROWS);
    let starts = new Int32Array(capacity * width);
    let lengths = new Int32Array(capacity * width);
    let rows = 0;
    let bytes = 0;
    if (this.pending) {
      starts.set(this.pending.starts);
      lengths.set(this.pending.lengths);
      bytes = this.pending.bytes;
      rows = 1;
      this.pending = null;
    }
    const rowStarts = this.rowStarts;
    const rowLengths = this.rowLengths;
    while (rows < maxRows) {
      if (rows >= capacity) {
        capacity = Math.min(maxRows, capacity * 2);
        const grownStarts = new Int32Array(capacity * width);
        const grownLengths = new Int32Array(capacity * width);
        grownStarts.set(starts);
        grownLengths.set(lengths);
        starts = grownStarts;
        lengths = grownLengths;
      }
      if (this.readCells(rowStarts, rowLengths, 0, width) < 0) break;
      let rowBytes = width * BYTES_PER_LENGTH_PREFIX;
      for (let c = 0; c < width; c++) rowBytes += rowLengths[c];
      if (rows > 0 && bytes + rowBytes > maxBytes) {
        this.pending = { starts: rowStarts.slice(), lengths: rowLengths.slice(), bytes: rowBytes };
        break;
      }
      starts.set(rowStarts, rows * width);
      lengths.set(rowLengths, rows * width);
      rows++;
      bytes += rowBytes;
    }
    if (rows === 0) return null;
    return { data: this.data, rows, starts, lengths };
  }
}
