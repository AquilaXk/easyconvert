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
 *
 * SWAR structural byte classification (`lowByteBias = 0x0e0e0e0e` + delimiter/quote XOR masks) and bounded per-cell
 * quote unescaping follow:
 * - `simdjson/simdjson` (commit `a0d5ad9798f9e51706399b649929dafb91d9b714`, Apache-2.0)
 * - `BurntSushi/rust-csv` (`csv-core/src/reader.rs`, commit `05612e87e6e92910d40d7214b70952b8434fef9b`,
 *   SHA-256 `f6afc1ff07b4bcc50aa609b758a3a15f777f1985c89f97739e0de4745057b308`, MIT):
 *   Copyright (c) 2015 Andrew Gallant
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 *   documentation files (the "Software"), to deal in the Software without restriction, including without limitation
 *   the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
 *   to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 *   The above copyright notice and this permission notice shall be included in all copies or substantial portions of
 *   the Software.
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
 *   THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
 *   CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 *   IN THE SOFTWARE.
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
const BYTES_PER_LENGTH_PREFIX = 4;

type LineBreakStyle = 'lf' | 'crlf';

export interface CellChunk {
  /** The bytes the offsets point into (a private copy once a cell with doubled quotes was collapsed). */
  data: Buffer;
  /** A view of `data` for multi-byte loads, which are one instruction where four indexed byte reads are not. */
  view: DataView;
  /** Records held. */
  rows: number;
  /** Row-major: the cell of row r and column c is at index r * width + c. */
  starts: Int32Array;
  /** Byte length of each cell, after a quoted cell's doubled quotes are collapsed. */
  lengths: Int32Array;
}

function viewOf(data: Buffer): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
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

const sharedHeaderStarts = new Int32Array(PARQUET_MAX_COLUMNS + 1);
const sharedHeaderLengths = new Int32Array(PARQUET_MAX_COLUMNS + 1);
let sharedChunkStarts = new Int32Array(INITIAL_CHUNK_ROWS * 16);
let sharedChunkLengths = new Int32Array(INITIAL_CHUNK_ROWS * 16);
const INITIAL_QUOTE_SCRATCH_BYTES = 256;
const RETAINED_CHUNK_BYTE_SCRATCH = 256 * 1024;
let sharedChunkByteScratch: Buffer | null = null;

/** Gives back cell-offset scratch that a large row group grew past its initial size, so it is not held until exit. */
export function releaseChunkScratch(): void {
  if (sharedChunkByteScratch && sharedChunkByteScratch.length > RETAINED_CHUNK_BYTE_SCRATCH) {
    sharedChunkByteScratch = null;
  }
  if (sharedChunkStarts.length <= INITIAL_CHUNK_ROWS * 16) return;
  sharedChunkStarts = new Int32Array(INITIAL_CHUNK_ROWS * 16);
  sharedChunkLengths = new Int32Array(INITIAL_CHUNK_ROWS * 16);
}

/** Entries of the shared cell-offset scratch; tests use it to check that {@link releaseChunkScratch} shrinks it. */
export function chunkScratchLength(): number {
  return sharedChunkStarts.length;
}

function unescapeCellBytes(src: Uint8Array, rawStart: number, dst: Uint8Array, dstStart: number, collapsedLen: number): void {
  let r = rawStart;
  let w = dstStart;
  const dstEnd = dstStart + collapsedLen;
  while (w < dstEnd) {
    const b = src[r++];
    dst[w++] = b;
    if (b === QUOTE) r++;
  }
}

export class DelimitedByteScanner {
  /** The input bytes. */
  data: Buffer;
  /** Cells per record. */
  width = 0;
  /** Column names, as the general reader names them (a leading BOM stripped, repeated names suffixed). */
  header: string[] = [];
  private pos: number;
  private pending: { starts: Int32Array; lengths: Int32Array; bytes: number; hasEscaped: boolean } | null = null;
  private view: DataView;
  /** Bytes of the cells of the record {@link readCells} read last. */
  private recordBytes = 0;
  /** Whether the record {@link readCells} read last contained at least one doubled-quote escape (`starts[i] < 0`). */
  private recordHasEscaped = false;
  /** Growable per-cell scratch buffer used to unescape quoted cells without copying `this.data`. */
  private quoteScratch: Uint8Array | null = null;

  private constructor(
    data: Buffer,
    private readonly delimiter: number,
    private style: LineBreakStyle | null,
    pos: number
  ) {
    this.data = data;
    this.view = viewOf(data);
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

  private unescapeToScratch(rawStart: number, collapsedLen: number): Uint8Array {
    let scratch = this.quoteScratch;
    if (!scratch || scratch.length < collapsedLen) {
      let cap = scratch ? scratch.length : INITIAL_QUOTE_SCRATCH_BYTES;
      while (cap < collapsedLen) cap *= 2;
      scratch = new Uint8Array(cap);
      this.quoteScratch = scratch;
    }
    unescapeCellBytes(this.data, rawStart, scratch, 0, collapsedLen);
    return scratch.subarray(0, collapsedLen);
  }

  private readHeader(autoDetected: boolean): void {
    const starts = sharedHeaderStarts;
    const lengths = sharedHeaderLengths;
    const count = this.readCells(starts, lengths, 0, PARQUET_MAX_COLUMNS + 1, true);
    if (count < 0) unsupported('no header record');
    if (count > PARQUET_MAX_COLUMNS) unsupported('more columns than a Parquet file holds');
    if (autoDetected && count < 2) unsupported('a one-column table, whose delimiter the general reader detects');
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      const start = starts[i];
      const len = lengths[i];
      if (start >= 0) {
        names.push(this.data.toString('utf8', start, start + len));
      } else {
        const unescaped = this.unescapeToScratch(~start, len);
        names.push(Buffer.from(unescaped.buffer, unescaped.byteOffset, unescaped.byteLength).toString('utf8'));
      }
    }
    this.width = count;
    this.header = renameDuplicateHeaders(names);
  }

  /**
   * Reads the next non-blank record into `starts`/`lengths` at `base` and returns its width, or -1 at the end of the
   * input. The record must be exactly `limit` cells wide, unless `atMost` is set (the header: any width up to `limit`).
   * {@link recordBytes} is left holding the bytes of its cells.
   */
  private readCells(starts: Int32Array, lengths: Int32Array, base: number, limit: number, atMost = false): number {
    const data = this.data;
    const size = data.length;
    const delimiter = this.delimiter;
    // The scan reads four bytes at a time with SWAR zero-byte / byte-below tests:
    // - `lowByteBias = 0x0e0e0e0e` flags bytes `< 0x0e` (including LF 0x0a and CR 0x0d) while allowing ASCII space
    //   (`0x20`) and `!` (`0x21`) to pass at full 4-byte word speed.
    // - `delimXored` and `quoteXored` flag exact matches with `delimiter` and `"` (`0x22`).
    const byteOnes = 0x01010101;
    const lowByteBias = 0x0e0e0e0e;
    const quoteWord = 0x22222222;
    const byteHighBits = 0x80808080 | 0;
    const delimiterWord = delimiter * byteOnes;
    const lastWordStart = size - 4;
    const view = this.view;
    let pos = this.pos;
    for (;;) {
      if (pos >= size) {
        this.pos = pos;
        return -1;
      }
      let column = 0;
      let bytes = 0;
      let hasEscaped = false;
      for (;;) {
        const cellStart = pos;
        let encodedStart: number;
        let cellLen: number;
        // The byte that ends the cell (a delimiter, a line break), or -1 at the end of the input.
        let ender: number;
        let next: number;
        if (cellStart < size && data[cellStart] === QUOTE) {
          let scan = cellStart + 1;
          let escapedQuotes = 0;
          for (;;) {
            while (scan < size && data[scan] !== QUOTE) scan++;
            if (scan >= size) return unsupported('an unterminated quoted cell');
            if (data[scan + 1] === QUOTE) {
              escapedQuotes++;
              scan += 2;
              continue;
            }
            break;
          }
          const rawStart = cellStart + 1;
          cellLen = scan - rawStart - escapedQuotes;
          if (escapedQuotes > 0) {
            encodedStart = ~rawStart;
            hasEscaped = true;
          } else {
            encodedStart = rawStart;
          }
          next = scan + 1;
          ender = next < size ? data[next] : -1;
        } else {
          let scan = cellStart;
          for (;;) {
            while (scan <= lastWordStart) {
              const word = view.getInt32(scan, true);
              const delimXored = word ^ delimiterWord;
              const quoteXored = word ^ quoteWord;
              const flagged =
                (((word - lowByteBias) & ~word) |
                  ((delimXored - byteOnes) & ~delimXored) |
                  ((quoteXored - byteOnes) & ~quoteXored)) &
                byteHighBits;
              if (flagged !== 0) {
                scan += (31 - Math.clz32(flagged & -flagged)) >> 3; // bits below the lowest flag, as bytes
                break;
              }
              scan += 4;
            }
            if (scan >= size) {
              ender = -1;
              break;
            }
            ender = data[scan];
            if (ender === delimiter || ender === LINE_FEED || ender === CARRIAGE_RETURN) break;
            if (ender === QUOTE) return unsupported('a quote inside an unquoted cell');
            scan++;
          }
          encodedStart = cellStart;
          cellLen = scan - cellStart;
          next = scan;
        }

        if (column >= limit) return unsupported('a record wider than the header');
        starts[base + column] = encodedStart;
        lengths[base + column] = cellLen;
        bytes += cellLen;
        column++;
        if (ender === delimiter) {
          pos = next + 1;
          continue;
        }
        if (ender === -1) {
          pos = size;
        } else if (ender === LINE_FEED && this.style !== 'crlf') {
          this.style = 'lf';
          pos = next + 1;
        } else if (ender === CARRIAGE_RETURN && this.style !== 'lf' && data[next + 1] === LINE_FEED) {
          this.style = 'crlf';
          pos = next + 2;
        } else {
          return unsupported('a line break outside the file line-break style, or text after a closing quote');
        }
        break;
      }
      if (column === 1 && bytes === 0) continue; // a blank line: the general reader skips it
      this.pos = pos;
      if (!atMost && column !== limit) return unsupported('a record narrower than the header');
      this.recordBytes = bytes;
      this.recordHasEscaped = hasEscaped;
      return column;
    }
  }

  /**
   * Materializes only the cell bytes of the current chunk into reusable scratch when at least one cell in the chunk
   * contained doubled quotes, leaving `this.data` untouched and avoiding a full-input copy.
   */
  private materializeEscapedChunk(rows: number, starts: Int32Array, lengths: Int32Array, totalCellBytes: number): CellChunk {
    const cellCount = rows * this.width;
    let needed = Math.max(totalCellBytes + BYTES_PER_LENGTH_PREFIX, 16);
    let buf = sharedChunkByteScratch;
    if (!buf || buf.length < needed) {
      let cap = buf ? buf.length : Math.max(4096, needed);
      while (cap < needed) cap *= 2;
      buf = Buffer.allocUnsafe(cap);
      sharedChunkByteScratch = buf;
    }
    const src = this.data;
    let writePos = 0;
    for (let i = 0; i < cellCount; i++) {
      const s = starts[i];
      const len = lengths[i];
      starts[i] = writePos;
      if (len === 0) continue;
      if (s >= 0) {
        if (len <= 24) {
          for (let k = 0; k < len; k++) buf[writePos + k] = src[s + k];
        } else {
          src.copy(buf, writePos, s, s + len);
        }
      } else {
        unescapeCellBytes(src, ~s, buf, writePos, len);
      }
      writePos += len;
    }
    const slice = buf.subarray(0, writePos);
    return { data: slice, view: viewOf(slice), rows, starts, lengths };
  }

  /**
   * Reads up to `maxRows` records, stopping before a record that would take the group past `maxBytes` of PLAIN
   * string storage (4 length bytes per cell plus the cell bytes) unless it is the first. Returns null when the input
   * is exhausted.
   */
  nextChunk(maxRows: number, maxBytes: number): CellChunk | null {
    const width = this.width;
    let capacity = Math.min(maxRows, Math.max(INITIAL_CHUNK_ROWS, Math.floor(sharedChunkStarts.length / Math.max(1, width))));
    if (capacity * width > sharedChunkStarts.length) {
      sharedChunkStarts = new Int32Array(capacity * width);
      sharedChunkLengths = new Int32Array(capacity * width);
    }
    let starts = sharedChunkStarts;
    let lengths = sharedChunkLengths;
    let rows = 0;
    let bytes = 0;
    let chunkHasEscaped = false;
    if (this.pending) {
      starts.set(this.pending.starts);
      lengths.set(this.pending.lengths);
      bytes = this.pending.bytes;
      chunkHasEscaped = this.pending.hasEscaped;
      rows = 1;
      this.pending = null;
    }
    while (rows < maxRows) {
      if (rows >= capacity) {
        capacity = Math.min(maxRows, capacity * 2);
        const grownStarts = new Int32Array(capacity * width);
        const grownLengths = new Int32Array(capacity * width);
        grownStarts.set(starts.subarray(0, rows * width));
        grownLengths.set(lengths.subarray(0, rows * width));
        sharedChunkStarts = starts = grownStarts;
        sharedChunkLengths = lengths = grownLengths;
      }
      const base = rows * width;
      if (this.readCells(starts, lengths, base, width) < 0) break;
      const rowBytes = this.recordBytes + width * BYTES_PER_LENGTH_PREFIX;
      if (rows > 0 && bytes + rowBytes > maxBytes) {
        this.pending = {
          starts: starts.slice(base, base + width),
          lengths: lengths.slice(base, base + width),
          bytes: rowBytes,
          hasEscaped: this.recordHasEscaped,
        };
        break;
      }
      if (this.recordHasEscaped) chunkHasEscaped = true;
      rows++;
      bytes += rowBytes;
    }
    if (rows === 0) return null;
    if (chunkHasEscaped) {
      const totalCellBytes = bytes - rows * width * BYTES_PER_LENGTH_PREFIX;
      return this.materializeEscapedChunk(rows, starts, lengths, totalCellBytes);
    }
    return { data: this.data, view: this.view, rows, starts, lengths };
  }
}
