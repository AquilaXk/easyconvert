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
  detectDelimiter,
  isDelimiterSampleComplete,
  nominalDelimiter,
  renameDuplicateHeaders,
} from '../../conversions/delimited-detect';
import { DataEncodingError, DataLimitExceededError, DataParseError, UnsupportedOptionError } from '../../types';

/** Characters one record may hold while it is being read; larger records are not streamed. */
export const MAX_STREAMED_RECORD_CHARS = 16 * 1024 * 1024;
/** Text buffered at most while the delimiter sample (the first 50 records) is incomplete. */
export const MAX_DELIMITER_SAMPLE_CHARS = 2 * MAX_STREAMED_RECORD_CHARS;
/** papaparse guesses the line break from the first 1 MiB of text, so the sample covers it too. */
const PAPA_LINE_BREAK_WINDOW_CHARS = 1024 * 1024;

const QUOTE = '"';
const ESCAPED_QUOTE = '""';
const ALL_QUOTES = /"/g;
/** Characters that force quoting besides the output delimiter (Papa's BAD_DELIMITERS). */
const NEEDS_QUOTING = /["\r\n﻿]/;
const ALLOWED_DELIMITERS: ReadonlySet<string> = new Set(DELIMITER_CANDIDATES);
const STREAMABLE_SOURCES: ReadonlySet<string> = new Set(['csv', 'tsv', 'tab']);

type ParseState = 'fieldStart' | 'unquoted' | 'quoted' | 'quoteInQuoted';

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
  let skipLineFeed = false;
  let recordNumber = 0;
  let headerFieldCount: number | null = null;
  let wroteRecord = false;
  let finished = false;

  const parseError = (reason: string, row: number): DataParseError =>
    new DataParseError(`Failed to parse ${label}: ${reason} (row ${row}).`, { row });

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
    // A blank line is skipped, as the server parser does.
    if (fields.length === 1 && fields[0] === '') return;
    recordNumber++;
    let written = fields;
    if (headerFieldCount === null) {
      headerFieldCount = fields.length;
      written = renameDuplicateHeaders(fields);
    } else if (fields.length !== headerFieldCount) {
      const amount = fields.length > headerFieldCount ? 'many' : 'few';
      throw parseError(
        `Too ${amount} fields: expected ${headerFieldCount} fields but parsed ${fields.length}`,
        recordNumber
      );
    }
    if (wroteRecord) out.push(DELIMITED_RECORD_SEPARATOR);
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

  // The delimiter is one of , ; TAB | (checked or detected); escaped for the character class.
  let boundary = /[\r\n]/g;
  /** Index of the next delimiter, CR or LF at or after `from`, or the text length. */
  const nextBoundary = (text: string, from: number): number => {
    boundary.lastIndex = from;
    return boundary.exec(text)?.index ?? text.length;
  };
  const adoptDelimiter = (delimiter: string): void => {
    inDelimiter = delimiter;
    boundary = new RegExp(`[\\${delimiter}\\r\\n]`, 'g');
  };
  if (inDelimiter !== undefined) adoptDelimiter(inDelimiter);

  /**
   * Text ready to parse once the delimiter is known; null while the sample is still incomplete.
   * Detection runs on the same records the server samples, so both pick the same delimiter.
   */
  const takeParsableText = (text: string, last: boolean): string | null => {
    if (inDelimiter !== undefined) return text;
    sample += text;
    if (!last) {
      if (sample.length > MAX_DELIMITER_SAMPLE_CHARS) {
        throw new DataLimitExceededError(
          `The first ${label} records exceed ${MAX_DELIMITER_SAMPLE_CHARS} characters before the delimiter can be detected; pass the "delimiter" option.`
        );
      }
      if (!isDelimiterSampleComplete(sample, PAPA_LINE_BREAK_WINDOW_CHARS)) return null;
    }
    adoptDelimiter(detectDelimiter(sample, nominalDelimiter(src)));
    const buffered = sample;
    sample = '';
    return buffered;
  };

  const parse = (text: string, out: string[]): void => {
    let index = 0;
    while (index < text.length) {
      const c = text[index];
      if (skipLineFeed) {
        skipLineFeed = false;
        if (c === '\n') {
          index++;
          continue;
        }
      }
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
      if (state === 'quoteInQuoted') {
        if (c === QUOTE) {
          countChars(1);
          field += QUOTE;
          state = 'quoted';
          index++;
          continue;
        }
        if (c !== inDelimiter && c !== '\r' && c !== '\n') {
          throw parseError('Trailing quote on quoted field is malformed', recordNumber + 1);
        }
      } else if (state === 'fieldStart' && c === QUOTE) {
        state = 'quoted';
        index++;
        continue;
      }
      if (c === inDelimiter) {
        endField();
        state = 'fieldStart';
        index++;
      } else if (c === '\r' || c === '\n') {
        endRecord(out);
        skipLineFeed = c === '\r';
        index++;
      } else {
        // Unquoted text runs to the next delimiter or line break; a quote inside it is literal.
        const end = nextBoundary(text, index);
        countChars(end - index);
        field += text.slice(index, end);
        state = 'unquoted';
        index = end;
      }
    }
  };

  const finish = (out: string[]): void => {
    if (state === 'quoted') throw parseError('Quoted field unterminated', recordNumber + 1);
    if (state !== 'fieldStart' || record.length > 0) endRecord(out);
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
    if (parsable !== null) parse(parsable, out);
    if (last) {
      finish(out);
      finished = true;
    }
    return encoder.encode(out.join(''));
  };
}
