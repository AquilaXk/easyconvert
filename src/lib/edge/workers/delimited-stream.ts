/**
 * Streaming CSV <-> TSV conversion for the L3 OPFS pipeline (files over 100 MB).
 *
 * Reads input like the server engine (src/lib/conversions/delimited-detect.ts): the delimiter is
 * detected from the first 50 records with the same algorithm unless `delimiter` is given (the
 * stream buffers just enough text for the sample to be complete), and duplicate header names are
 * renamed the same way. Writes under the server's delimited-output rules
 * (src/lib/conversions/delimited-rules.ts): RFC 4180 parsing and quoting, formula cells prefixed
 * with ' unless they are numeric literals, a UTF-8 BOM by default for CSV only, the `bom` and
 * `escapeFormulas` options, CRLF between records, blank lines skipped and every record checked
 * against the header's field count.
 *
 * Input must be UTF-8 (a leading BOM is dropped): it is decoded strictly, so a file in another
 * encoding fails with a DataEncodingError asking for the `encoding` option, which the tier
 * router sends to the server. Memory is bounded by the chunk plus the record being read: a
 * multibyte sequence or a quoted field cut by a chunk boundary is carried over, and one record
 * longer than MAX_STREAMED_RECORD_CHARS is rejected.
 */

import {
  DELIMITED_RECORD_SEPARATOR,
  FORMULA_TRIGGER,
  UTF8_BOM_CHAR,
  writesBomByDefault,
} from '../../conversions/delimited-rules';
import {
  DELIMITER_CANDIDATES,
  LINE_BREAK_GUESS_WINDOW_CHARS,
  detectDelimiter,
  guessLineBreak,
  isDelimiterSampleComplete,
  nominalDelimiter,
  renameDuplicateHeaders,
} from '../../conversions/delimited-detect';
import { DataEncodingError, DataLimitExceededError, DataParseError, UnsupportedOptionError } from '../../types';

/** Characters one record may hold while it is being read; larger records are not streamed. */
export const MAX_STREAMED_RECORD_CHARS = 16 * 1024 * 1024;
/** Text buffered at most while the delimiter sample (the first 50 records) is incomplete. */
export const MAX_DELIMITER_SAMPLE_CHARS = 2 * MAX_STREAMED_RECORD_CHARS;
const LINE_FEED = '\n';
/** Whitespace String.prototype.trim removes; the server parser skips it after a closing quote. */
const TRIMMED_WHITESPACE = /\s/;

const QUOTE = '"';
const ESCAPED_QUOTE = '""';
const ALL_QUOTES = /"/g;
/** Characters that force quoting besides the output delimiter (Papa's BAD_DELIMITERS). */
const NEEDS_QUOTING = /["\r\n﻿]/;
const ALLOWED_DELIMITERS: ReadonlySet<string> = new Set(DELIMITER_CANDIDATES);
const STREAMABLE_SOURCES: ReadonlySet<string> = new Set(['csv', 'tsv', 'tab']);

type ParseState = 'fieldStart' | 'unquoted' | 'quoted' | 'quoteInQuoted' | 'afterQuoteSpace';

export interface DelimitedStreamOptions {
  delimiter?: unknown;
  encoding?: unknown;
  bom?: unknown;
  escapeFormulas?: unknown;
}

/** Whether a source/target pair is a delimited-text pair this module streams. */
export function isStreamableDelimitedPair(src: string, tgt: string): boolean {
  return STREAMABLE_SOURCES.has(src) && STREAMABLE_SOURCES.has(tgt) && (src === 'csv') !== (tgt === 'csv');
}

/** Whether an `encoding` option is absent or names UTF-8, the only encoding streamed in the browser. */
export function isStreamableEncoding(encoding: unknown): boolean {
  if (encoding === undefined) return true;
  if (typeof encoding !== 'string') return false;
  try {
    return new TextDecoder(encoding).encoding === 'utf-8';
  } catch {
    return false;
  }
}

function optionalBoolean(options: DelimitedStreamOptions, name: 'bom' | 'escapeFormulas'): boolean | undefined {
  const value = options[name];
  if (value !== undefined && typeof value !== 'boolean') {
    throw new UnsupportedOptionError(`Option "${name}" must be true or false.`);
  }
  return value;
}

/**
 * A stateful transformer for one stream: call it with consecutive chunks; the chunk that reaches
 * `totalSize` flushes the last record. Returns the UTF-8 output bytes for each chunk.
 */
export function createDelimitedStreamTransformer(
  sourceFormat: string,
  targetFormat: string,
  options: DelimitedStreamOptions = {}
): (chunk: Uint8Array, offset: number, totalSize: number) => Uint8Array {
  const src = sourceFormat.toLowerCase();
  const tgt = targetFormat.toLowerCase();
  const label = src.toUpperCase();
  if (!isStreamableEncoding(options.encoding)) {
    throw new UnsupportedOptionError(
      `Option "encoding" must name UTF-8 for a streamed ${label} conversion; other encodings are converted on the server.`
    );
  }
  const requestedDelimiter = options.delimiter;
  if (requestedDelimiter !== undefined && (typeof requestedDelimiter !== 'string' || !ALLOWED_DELIMITERS.has(requestedDelimiter))) {
    throw new UnsupportedOptionError('Option "delimiter" must be one of ",", ";", TAB or "|".');
  }
  // Set once the delimiter is known: the option, or detection on the buffered sample.
  let inDelimiter = requestedDelimiter as string | undefined;
  let sample = '';
  const outDelimiter = nominalDelimiter(tgt);
  const escapeFormulas = optionalBoolean(options, 'escapeFormulas') ?? true;
  const withBom = optionalBoolean(options, 'bom') ?? writesBomByDefault(tgt);

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const encoder = new TextEncoder();
  let state: ParseState = 'fieldStart';
  let field = '';
  let record: string[] = [];
  let recordChars = 0;
  /** Records ended so far, blank lines included: rows are numbered over every line, as on the server. */
  let rawRows = 0;
  let headerFieldCount: number | null = null;
  /** The line break the server would guess; set from the first 1 MiB (or the whole input). */
  let lineBreak: string | undefined;
  /** A CR held back at a chunk end until the next chunk shows whether it starts a CRLF. */
  let carry = '';
  /** Line (counted by LF, as the server's positions are) where the current quoted field's text starts. */
  let quotedFieldLine = 1;
  // Line counting over the current chunk: `line` is the line at every position up to and including
  // `nextLineFeed`, the next LF not yet counted (the chunk length when there is none).
  let chunkText = '';
  let nextLineFeed = 0;
  let line = 1;
  let wroteRecord = false;
  /** Whether a record after the header was written; a header-only output ends with a separator. */
  let wroteDataRecord = false;
  let finished = false;

  const mismatchError = (reason: string, row: number): DataParseError =>
    new DataParseError(`Failed to parse ${label}: ${reason} (row ${row}).`, { row });
  /** A quote error of the record being read, located like the server's: its row and the quoted field's line. */
  const quoteError = (reason: string): DataParseError => {
    const row = rawRows + 1;
    return new DataParseError(`Failed to parse ${label}: ${reason} (row ${row}, line ${quotedFieldLine}).`, {
      row,
      line: quotedFieldLine,
    });
  };

  /** The next LF at or after `from` in the current chunk, or the chunk length when there is none. */
  const findLineFeed = (from: number): number => {
    const found = chunkText.indexOf(LINE_FEED, from);
    return found === -1 ? chunkText.length : found;
  };

  /**
   * Line number at a position of the current chunk. Each LF is found once per chunk (the cached
   * `nextLineFeed` is only advanced past positions already asked for), so counting stays linear
   * however many quoted fields ask; positions must not go backwards within a chunk.
   */
  const lineAt = (index: number): number => {
    while (nextLineFeed < index) {
      line++;
      nextLineFeed = findLineFeed(nextLineFeed + 1);
    }
    return line;
  };

  const writeField = (value: string, recordLength: number): string => {
    let text = value;
    let quote = false;
    if (escapeFormulas && FORMULA_TRIGGER.test(text)) {
      text = `'${text}`;
      quote = true;
    }
    quote =
      quote ||
      text.includes(outDelimiter) ||
      NEEDS_QUOTING.test(text) ||
      text.startsWith(' ') ||
      text.endsWith(' ') ||
      // A one-column record whose only value is empty would otherwise be an empty line.
      (recordLength === 1 && text === '');
    return quote ? QUOTE + text.replace(ALL_QUOTES, ESCAPED_QUOTE) + QUOTE : text;
  };

  const endField = (): void => {
    record.push(field);
    field = '';
  };

  const endRecord = (out: string[]): void => {
    endField();
    const fields = record;
    record = [];
    recordChars = 0;
    state = 'fieldStart';
    rawRows++;
    // A blank line is skipped, as the server parser does.
    if (fields.length === 1 && fields[0] === '') return;
    let written = fields;
    if (headerFieldCount === null) {
      headerFieldCount = fields.length;
      written = renameDuplicateHeaders(fields);
    } else if (fields.length !== headerFieldCount) {
      const amount = fields.length > headerFieldCount ? 'many' : 'few';
      throw mismatchError(`Too ${amount} fields: expected ${headerFieldCount} fields but parsed ${fields.length}`, rawRows);
    }
    if (wroteRecord) {
      out.push(DELIMITED_RECORD_SEPARATOR);
      wroteDataRecord = true;
    }
    out.push(written.map((value) => writeField(value, written.length)).join(outDelimiter));
    wroteRecord = true;
  };

  const countChars = (count: number): void => {
    recordChars += count;
    if (recordChars > MAX_STREAMED_RECORD_CHARS) {
      throw new DataLimitExceededError(
        `A ${label} record is longer than ${MAX_STREAMED_RECORD_CHARS} characters, more than a streamed conversion holds in memory.`
      );
    }
  };

  /** Matches the delimiter or the first character of the line break; set once both are known. */
  let boundary = /$^/g;
  /** Index of the next delimiter or line-break start at or after `from`, or the text length. */
  const nextBoundary = (text: string, from: number): number => {
    boundary.lastIndex = from;
    return boundary.exec(text)?.index ?? text.length;
  };

  /**
   * Text ready to parse once the delimiter and the line break are known; null while the sample is
   * incomplete. Both are decided on the text the server decides them on: the line break on the
   * first 1 MiB, the delimiter on the first 50 records (unless the `delimiter` option names it).
   */
  const takeParsableText = (text: string, last: boolean): string | null => {
    if (lineBreak !== undefined) return text;
    sample += text;
    if (!last) {
      if (sample.length > MAX_DELIMITER_SAMPLE_CHARS) {
        throw new DataLimitExceededError(
          `The first ${label} records exceed ${MAX_DELIMITER_SAMPLE_CHARS} characters before the delimiter can be detected; pass the "delimiter" option.`
        );
      }
      const ready =
        inDelimiter === undefined
          ? isDelimiterSampleComplete(sample, LINE_BREAK_GUESS_WINDOW_CHARS)
          : sample.length >= LINE_BREAK_GUESS_WINDOW_CHARS;
      if (!ready) return null;
    }
    inDelimiter ??= detectDelimiter(sample, nominalDelimiter(src));
    lineBreak = guessLineBreak(sample);
    // The delimiter is one of , ; TAB | and the line break starts with CR or LF; escaped for the class.
    boundary = new RegExp(`[\\${inDelimiter}\\${lineBreak === '\n' ? 'n' : 'r'}]`, 'g');
    const buffered = sample;
    sample = '';
    return buffered;
  };

  const parse = (text: string, out: string[]): void => {
    const delimiter = inDelimiter as string;
    const recordEnd = lineBreak as string;
    let index = 0;
    while (index < text.length) {
      if (state === 'quoted') {
        const close = text.indexOf(QUOTE, index);
        const end = close === -1 ? text.length : close;
        countChars(end - index);
        field += text.slice(index, end);
        index = end;
        if (close !== -1) {
          state = 'quoteInQuoted';
          index++;
        }
        continue;
      }
      const c = text[index];
      if (state === 'quoteInQuoted' || state === 'afterQuoteSpace') {
        if (state === 'quoteInQuoted' && c === QUOTE) {
          // An escaped quote inside the quoted field.
          countChars(1);
          field += QUOTE;
          state = 'quoted';
          index++;
          continue;
        }
        if (c !== delimiter && !text.startsWith(recordEnd, index)) {
          // Whitespace may separate the closing quote from the delimiter or line break.
          if (!TRIMMED_WHITESPACE.test(c)) throw quoteError('Trailing quote on quoted field is malformed');
          state = 'afterQuoteSpace';
          index++;
          continue;
        }
      } else if (state === 'fieldStart' && c === QUOTE) {
        quotedFieldLine = lineAt(index);
        state = 'quoted';
        index++;
        continue;
      }
      if (c === delimiter) {
        endField();
        state = 'fieldStart';
        index++;
      } else if (text.startsWith(recordEnd, index)) {
        endRecord(out);
        index += recordEnd.length;
      } else {
        // Unquoted text runs to the next delimiter or line break; a quote or another line-break
        // character inside it (a bare CR in an LF file) is data.
        // The character at `index` is neither, so the run includes it.
        let end = nextBoundary(text, index + 1);
        while (end < text.length && text[end] !== delimiter && !text.startsWith(recordEnd, end)) {
          end = nextBoundary(text, end + 1);
        }
        countChars(end - index);
        field += text.slice(index, end);
        state = 'unquoted';
        index = end;
      }
    }
  };

  const finish = (out: string[]): void => {
    if (state === 'quoted') throw quoteError('Quoted field unterminated');
    if (state === 'afterQuoteSpace') {
      // The server reports both; the trailing-quote error comes first.
      throw quoteError('Trailing quote on quoted field is malformed');
    }
    if (state !== 'fieldStart' || record.length > 0) endRecord(out);
    // The server writes a header with no records as one terminated line.
    if (wroteRecord && !wroteDataRecord) out.push(DELIMITED_RECORD_SEPARATOR);
  };

  /** Parses one decoded piece, holding back a CR that may pair with an LF in the next chunk. */
  const parseChunk = (text: string, last: boolean, out: string[]): void => {
    let piece = carry + text;
    carry = '';
    if (!last && lineBreak === '\r\n' && piece.endsWith('\r')) {
      carry = '\r';
      piece = piece.slice(0, -1);
    }
    chunkText = piece;
    nextLineFeed = findLineFeed(0);
    parse(piece, out);
    lineAt(piece.length);
  };

  return (chunk: Uint8Array, offset: number, totalSize: number): Uint8Array => {
    if (finished) throw new Error('The streamed delimited conversion has already finished.');
    const last = offset + chunk.byteLength >= totalSize;
    let text: string;
    try {
      text = decoder.decode(chunk, { stream: !last });
    } catch {
      throw new DataEncodingError(
        `Streamed ${label} input is not valid UTF-8 text; pass the "encoding" option to convert it on the server.`
      );
    }
    const out: string[] = [];
    if (withBom && offset === 0) out.push(UTF8_BOM_CHAR);
    const parsable = takeParsableText(text, last);
    if (parsable !== null) parseChunk(parsable, last, out);
    if (last) {
      finish(out);
      finished = true;
    }
    return encoder.encode(out.join(''));
  };
}
