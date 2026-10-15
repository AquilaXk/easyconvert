import { ChunkedOutput } from './chunked-output';
import * as delimitedCells from './delimited-cells';
import { flatCopy } from './flat-string';
import * as delimitedRules from './delimited-rules';
import { DataRepresentationError } from '../types';
import type { ColumnCellFormatter, ColumnFormatterFactory, FormattedParquetTable, FormattedRowWindow } from './parquet-formatted';

// Bound once at load: the cell formatters below run for every cell, and a binding imported from another module costs a
// property lookup on every use when the code runs through a TypeScript loader.
const { ASCII_LIMIT, CHAR_BACKSLASH, CHAR_NINE, CHAR_QUOTE, CHAR_SPACE, CHAR_ZERO, formatDelimitedString, mayTriggerFormula } = delimitedCells;
const { DELIMITED_RECORD_SEPARATOR } = delimitedRules;

/**
 * Cell text of the Parquet-to-text routes. A cell is written as a string of one-byte characters that holds the UTF-8
 * bytes of the text (the "Latin-1 form"), so a row window is copied to the output without being encoded again.
 */

const SURROGATE_START = 0xd800;
const SURROGATE_END = 0xdfff;
/** Rows joined into one string before they are written. */
const ROW_WRITE_BATCH = 32;
const ROW_UNROLL = 4;

// ---------------------------------------------------------------------------
// Row windows
// ---------------------------------------------------------------------------

function rowText(columns: string[][], offsets: Int32Array, row: number): string {
  const count = columns.length;
  let text = columns[0][offsets[0] + row];
  let c = 1;
  for (; c + ROW_UNROLL <= count; c += ROW_UNROLL) {
    text +=
      columns[c][offsets[c] + row] +
      columns[c + 1][offsets[c + 1] + row] +
      columns[c + 2][offsets[c + 2] + row] +
      columns[c + 3][offsets[c + 3] + row];
  }
  for (; c < count; c++) text += columns[c][offsets[c] + row];
  return text;
}

function writeWindow(window: FormattedRowWindow, out: ChunkedOutput): void {
  const { columns, offsets, rows } = window;
  for (let first = 0; first < rows; first += ROW_WRITE_BATCH) {
    const last = Math.min(rows, first + ROW_WRITE_BATCH);
    let chunk = '';
    for (let row = first; row < last; row++) chunk += rowText(columns, offsets, row);
    out.writeLatin1(chunk);
  }
}

/** Writes every row of the table to `out`, one row window at a time. */
export function writeTableRows(table: FormattedParquetTable, out: ChunkedOutput): void {
  for (const window of table.windows()) writeWindow(window, out);
}

// ---------------------------------------------------------------------------
// Delimited text
// ---------------------------------------------------------------------------

export interface DelimitedStyle {
  delimiter: string;
  delimiterCode: number;
  escapeFormulas: boolean;
}

function delimitedNumber(prefix: string) {
  // A non-finite number is a number, not text: the general writer writes it as it is, with no formula guard.
  return (value: number): string => prefix + value;
}

function delimitedText(prefix: string, style: DelimitedStyle, singleColumn: boolean) {
  const { delimiterCode, escapeFormulas } = style;
  return (value: string): string => prefix + formatDelimitedString(value, delimiterCode, escapeFormulas, singleColumn, true);
}

/** Text that cannot need quotes or a formula guard when it starts with a digit, as dates, decimals and ids do. */
function delimitedDigitText(prefix: string, style: DelimitedStyle, singleColumn: boolean) {
  const general = delimitedText(prefix, style, singleColumn);
  return (value: string): string => {
    const first = value.length > 0 ? (value.codePointAt(0) ?? 0) : 0;
    return first >= CHAR_ZERO && first <= CHAR_NINE ? prefix + value : general(value);
  };
}

function plainTextSlice(page: Buffer, start: number, end: number, delimiterCode: number): boolean {
  for (let i = start; i < end; i++) {
    const byte = page[i];
    if (byte < CHAR_SPACE || byte >= ASCII_LIMIT || byte === CHAR_QUOTE || byte === delimiterCode) return false;
  }
  return true;
}

function delimitedTextSlice(prefix: string, style: DelimitedStyle, singleColumn: boolean) {
  const { delimiterCode, escapeFormulas } = style;
  return (page: Buffer, start: number, end: number): string | null => {
    if (end === start) return singleColumn ? `${prefix}""` : prefix;
    const first = page[start];
    if (first <= CHAR_SPACE || (escapeFormulas && mayTriggerFormula(first)) || page[end - 1] === CHAR_SPACE) return null;
    return plainTextSlice(page, start, end, delimiterCode) ? prefix + page.toString('latin1', start, end) : null;
  };
}

/** The cell formatters of CSV and TSV: each cell carries the delimiter (or record separator) before it. */
export function delimitedFormatters(style: DelimitedStyle): ColumnFormatterFactory {
  return (names, column, asciiOnly): ColumnCellFormatter => {
    const singleColumn = names.length === 1;
    const prefix = column === 0 ? DELIMITED_RECORD_SEPARATOR : style.delimiter;
    return {
      nullCell: flatCopy(column === 0 && singleColumn ? `${DELIMITED_RECORD_SEPARATOR}""` : prefix),
      trueCell: flatCopy(`${prefix}true`),
      falseCell: flatCopy(`${prefix}false`),
      numberPrefix: prefix,
      numberSuffix: '',
      formatNumber: delimitedNumber(prefix),
      formatString: asciiOnly ? delimitedDigitText(prefix, style, singleColumn) : delimitedText(prefix, style, singleColumn),
      formatTextSlice: delimitedTextSlice(prefix, style, singleColumn),
    };
  };
}

/** The header line of a table written as delimited text, in the Latin-1 form. */
export function delimitedHeaderLine(names: string[], style: DelimitedStyle): string {
  const singleColumn = names.length === 1;
  return names
    .map((name) => formatDelimitedString(name, style.delimiterCode, style.escapeFormulas, singleColumn, true))
    .join(style.delimiter);
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/** A JSON string literal in the Latin-1 form. Text that needs escaping goes through JSON.stringify. */
export function formatJsonString(value: string): string {
  let hasNonAscii = false;
  let needsStringify = false;
  for (let i = 0; i < value.length && !(needsStringify && hasNonAscii); i++) {
    const code = value.codePointAt(i) ?? 0;
    if (code >= ASCII_LIMIT) {
      hasNonAscii = true;
      // A code point beyond the BMP is a surrogate pair of code units; only a lone surrogate needs an escape.
      if (code > 0xffff) i++;
      else if (code >= SURROGATE_START && code <= SURROGATE_END) needsStringify = true;
    } else if (code < CHAR_SPACE || code === CHAR_QUOTE || code === CHAR_BACKSLASH) {
      needsStringify = true;
    }
  }
  const formatted = needsStringify ? JSON.stringify(value) : `"${value}"`;
  return hasNonAscii ? Buffer.from(formatted, 'utf8').toString('latin1') : formatted;
}

function jsonNumber(prefix: string, suffix: string, negativeZeroCell: string) {
  return (value: number): string => {
    if (!Number.isFinite(value)) throw new DataRepresentationError(`JSON cannot represent the number ${value}.`);
    return value === 0 && 1 / value < 0 ? negativeZeroCell : prefix + value + suffix;
  };
}

function jsonText(prefix: string, suffix: string, asciiOnly: boolean) {
  if (asciiOnly) return (value: string): string => `${prefix}"${value}"${suffix}`;
  return (value: string): string => prefix + formatJsonString(value) + suffix;
}

function jsonTextSlice(prefix: string, suffix: string) {
  const opening = `${prefix}"`;
  const closing = `"${suffix}`;
  return (page: Buffer, start: number, end: number): string | null => {
    for (let i = start; i < end; i++) {
      const byte = page[i];
      if (byte < CHAR_SPACE || byte >= ASCII_LIMIT || byte === CHAR_QUOTE || byte === CHAR_BACKSLASH) return null;
    }
    return opening + (page.toString('latin1', start, end) + closing);
  };
}

/** The cell formatters of a JSON array of objects, two-space indented: each cell carries its key and its separators. */
export function jsonFormatters(): ColumnFormatterFactory {
  return (names, column, asciiOnly): ColumnCellFormatter => {
    const suffix = column === names.length - 1 ? '\n  }' : '';
    const prefix = flatCopy(`${column === 0 ? ',\n  {\n    ' : ',\n    '}${formatJsonString(names[column])}: `);
    return {
      nullCell: flatCopy(`${prefix}null${suffix}`),
      trueCell: flatCopy(`${prefix}true${suffix}`),
      falseCell: flatCopy(`${prefix}false${suffix}`),
      numberPrefix: prefix,
      numberSuffix: suffix,
      formatNumber: jsonNumber(prefix, suffix, flatCopy(`${prefix}-0${suffix}`)),
      formatString: jsonText(prefix, suffix, asciiOnly),
      formatTextSlice: jsonTextSlice(prefix, suffix),
    };
  };
}
