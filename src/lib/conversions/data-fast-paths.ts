import { isUtf8 } from 'node:buffer';
import { DataRepresentationError, type ConversionOptions } from '../types';
import { MAX_INTEGER_LITERAL_DIGITS } from './data-json';
import { DelimitedBytesUnsupported, DelimitedByteScanner } from './delimited-bytes';
import { nominalDelimiter } from './delimited-detect';
import { DELIMITED_RECORD_SEPARATOR, FORMULA_TRIGGER, UTF8_BOM_CHAR, writesBomByDefault } from './delimited-rules';
import { decodeParquetFormattedColumns } from './parquet-reader';
import { encodeParquetFromScanner } from './parquet-text-writer';
import type { ParquetWriteOptions } from './parquet-writer';

/**
 * Direct routes for the commonest table conversions. Each one reads and writes the same data as the general route
 * in data.ts (parse into records, flatten into a table, write the target) without building the records, and returns
 * null for any input it does not handle, so the general route converts that input and reports its errors.
 */

/** Header names a record object would reorder: array indices come first in an object's own keys. */
const ARRAY_INDEX_NAME = /^(?:0|[1-9][0-9]*)$/;

const STRING_CACHE_LIMIT = 512;
const CACHEABLE_STRING_MAX_LENGTH = 128;

const CHAR_TAB = 0x09;
const CHAR_LF = 0x0a;
const CHAR_CR = 0x0d;
const CHAR_SPACE = 0x20;
const CHAR_QUOTE = 0x22;
const CHAR_PLUS = 0x2b;
const CHAR_COMMA = 0x2c;
const CHAR_MINUS = 0x2d;
const CHAR_DOT = 0x2e;
const CHAR_SLASH = 0x2f;
const CHAR_ZERO = 0x30;
const CHAR_NINE = 0x39;
const CHAR_COLON = 0x3a;
const CHAR_EQUALS = 0x3d;
const CHAR_AT = 0x40;
const CHAR_UPPER_E = 0x45;
const CHAR_OPEN_BRACKET = 0x5b;
const CHAR_BACKSLASH = 0x5c;
const CHAR_CLOSE_BRACKET = 0x5d;
const CHAR_B = 0x62;
const CHAR_LOWER_E = 0x65;
const CHAR_F = 0x66;
const CHAR_L = 0x6c;
const CHAR_N = 0x6e;
const CHAR_R = 0x72;
const CHAR_S = 0x73;
const CHAR_T = 0x74;
const CHAR_U = 0x75;
const CHAR_OPEN_BRACE = 0x7b;
const CHAR_CLOSE_BRACE = 0x7d;
const CHAR_BOM = 0xfeff;
const UTF8_BOM_0 = 0xef;
const UTF8_BOM_1 = 0xbb;
const UTF8_BOM_2 = 0xbf;
const UTF16_BOM_FE = 0xfe;
const UTF16_BOM_FF = 0xff;

/** Delimited text to Parquet: every column is a string column, written straight from the bytes of the input. */
export function delimitedToParquet(
  input: Buffer,
  sourceFormat: string,
  options: ConversionOptions,
  writeOptions: ParquetWriteOptions = {}
): Buffer | null {
  if (options.encoding !== undefined) return null;
  try {
    const scanner = DelimitedByteScanner.open(input, options.delimiter ?? nominalDelimiter(sourceFormat), options.delimiter === undefined);
    if (scanner.header.some((name) => ARRAY_INDEX_NAME.test(name))) return null;
    return encodeParquetFromScanner(scanner, writeOptions);
  } catch (error) {
    if (error instanceof DelimitedBytesUnsupported) return null;
    throw error;
  }
}

function mayTriggerFormula(firstCode: number): boolean {
  return (
    firstCode === CHAR_EQUALS ||
    firstCode === CHAR_AT ||
    firstCode === CHAR_PLUS ||
    firstCode === CHAR_MINUS ||
    firstCode === CHAR_TAB ||
    firstCode === CHAR_CR
  );
}

const UTF8_BOM_LATIN1 = '\xef\xbb\xbf';
const ROW_WRITE_BATCH = 32;

function formatDelimitedString(
  value: string,
  delimCode: number,
  escapeFormulas: boolean,
  singleColumn: boolean,
  asLatin1Utf8 = false
): string {
  const len = value.length;
  if (len === 0) return singleColumn ? '""' : '';

  let str = value;
  let needsQuotes = false;
  const firstCode = str.charCodeAt(0);
  if (escapeFormulas && mayTriggerFormula(firstCode) && FORMULA_TRIGGER.test(str)) {
    str = `'${str}`;
    needsQuotes = true;
  }

  let hasQuote = false;
  let hasNonAscii = false;
  if (firstCode === CHAR_SPACE || str.charCodeAt(str.length - 1) === CHAR_SPACE) {
    needsQuotes = true;
  }
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0x80) {
      hasNonAscii = true;
      if (c === CHAR_BOM) needsQuotes = true;
    } else if (c === CHAR_QUOTE) {
      hasQuote = true;
      needsQuotes = true;
    } else if (c === delimCode || c === CHAR_LF || c === CHAR_CR) {
      needsQuotes = true;
    }
  }

  const formatted = !needsQuotes ? str : hasQuote ? `"${str.replace(/"/g, '""')}"` : `"${str}"`;
  return asLatin1Utf8 && hasNonAscii ? Buffer.from(formatted, 'utf8').toString('latin1') : formatted;
}

function writeFormattedColumnsLatin1(
  columns: string[][],
  numRows: number,
  outBuf: Buffer,
  startPos: number
): number {
  const numCols = columns.length;
  let pos = startPos;
  if (numCols === 9) {
    const [c0, c1, c2, c3, c4, c5, c6, c7, c8] = columns;
    for (let r = 0; r < numRows; r += ROW_WRITE_BATCH) {
      const end = Math.min(numRows, r + ROW_WRITE_BATCH);
      let chunk = '';
      for (let i = r; i < end; i++) {
        chunk += c0[i] + c1[i] + c2[i] + c3[i] + c4[i] + c5[i] + c6[i] + c7[i] + c8[i];
      }
      pos += outBuf.write(chunk, pos, chunk.length, 'latin1');
    }
    return pos;
  }
  if (numCols === 1) {
    const c0 = columns[0];
    for (let r = 0; r < numRows; r += ROW_WRITE_BATCH) {
      const end = Math.min(numRows, r + ROW_WRITE_BATCH);
      let chunk = '';
      for (let i = r; i < end; i++) {
        chunk += c0[i];
      }
      pos += outBuf.write(chunk, pos, chunk.length, 'latin1');
    }
    return pos;
  }
  const c0 = columns[0];
  for (let r = 0; r < numRows; r += ROW_WRITE_BATCH) {
    const end = Math.min(numRows, r + ROW_WRITE_BATCH);
    let chunk = '';
    for (let i = r; i < end; i++) {
      let rowStr = c0[i];
      let c = 1;
      for (; c + 3 < numCols; c += 4) {
        rowStr += columns[c][i] + columns[c + 1][i] + columns[c + 2][i] + columns[c + 3][i];
      }
      for (; c < numCols; c++) {
        rowStr += columns[c][i];
      }
      chunk += rowStr;
    }
    pos += outBuf.write(chunk, pos, chunk.length, 'latin1');
  }
  return pos;
}

/**
 * Parquet to CSV or TSV: decodes column vectors directly into delimited rows without materializing row objects
 * or running Papa.unparse over a 2D array.
 */
export function parquetToDelimited(
  input: Buffer,
  targetFormat: string,
  options: ConversionOptions = {}
): Buffer | null {
  const tgt = targetFormat.toLowerCase();
  if (tgt !== 'csv' && tgt !== 'tsv') return null;

  const delimiter = tgt === 'tsv' ? '\t' : ',';
  const delimCode = tgt === 'tsv' ? CHAR_TAB : CHAR_COMMA;
  const escapeFormulas = options.escapeFormulas ?? true;
  const withBom = options.bom ?? writesBomByDefault(tgt);

  const { names, columns, numRows, totalStringBytes } = decodeParquetFormattedColumns(
    input,
    (colNames, c, safeAsciiString) => {
      const singleColumn = colNames.length === 1;
      const prefix = c === 0 ? DELIMITED_RECORD_SEPARATOR : delimiter;
      const nullCell = c === 0 && singleColumn ? `${DELIMITED_RECORD_SEPARATOR}""` : prefix;
      const trueCell = `${prefix}true`;
      const falseCell = `${prefix}false`;
      nullCell.charCodeAt(0);
      trueCell.charCodeAt(0);
      falseCell.charCodeAt(0);
      return {
        nullCell,
        trueCell,
        falseCell,
        numberPrefix: prefix,
        numberSuffix: '',
        formatNumber: (val: number) =>
          Number.isFinite(val)
            ? prefix + val
            : prefix + formatDelimitedString(String(val), delimCode, escapeFormulas, singleColumn, true),
        formatString: safeAsciiString
          ? (val: string) => {
              if (val.length > 0) {
                const c0 = val.charCodeAt(0);
                if (c0 >= CHAR_ZERO && c0 <= CHAR_NINE) return prefix + val;
              }
              return prefix + formatDelimitedString(val, delimCode, escapeFormulas, singleColumn, true);
            }
          : (val: string) => prefix + formatDelimitedString(val, delimCode, escapeFormulas, singleColumn, true),
        formatTextSlice: (page: Buffer, start: number, end: number) => {
          const len = end - start;
          if (len === 0) return singleColumn ? `${prefix}""` : prefix;
          const b0 = page[start];
          if (b0 <= CHAR_SPACE || (escapeFormulas && mayTriggerFormula(b0)) || page[end - 1] === CHAR_SPACE) {
            return null;
          }
          for (let i = start; i < end; i++) {
            const b = page[i];
            if (b < CHAR_SPACE || b >= 0x80 || b === CHAR_QUOTE || b === delimCode) return null;
          }
          return prefix + page.toString('latin1', start, end);
        },
      };
    }
  );
  if (numRows === 0) return null;

  const numCols = names.length;
  const singleColumn = numCols === 1;
  let headerLine = formatDelimitedString(names[0], delimCode, escapeFormulas, singleColumn, true);
  for (let c = 1; c < numCols; c++) {
    headerLine += delimiter + formatDelimitedString(names[c], delimCode, escapeFormulas, singleColumn, true);
  }
  const firstLine = withBom ? UTF8_BOM_LATIN1 + headerLine : headerLine;

  const totalBytes = firstLine.length + totalStringBytes;
  const outBuf = Buffer.allocUnsafe(totalBytes);
  const pos = outBuf.write(firstLine, 0, firstLine.length, 'latin1');
  writeFormattedColumnsLatin1(columns, numRows, outBuf, pos);

  return outBuf;
}

function formatJsonString(value: string): string {
  const len = value.length;
  let hasNonAscii = false;
  let needsStringify = false;
  for (let i = 0; i < len; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0x80) {
      hasNonAscii = true;
      if (c >= 0xd800 && c <= 0xdfff) {
        needsStringify = true;
        break;
      }
    } else if (c < CHAR_SPACE || c === CHAR_QUOTE || c === CHAR_BACKSLASH) {
      needsStringify = true;
      if (hasNonAscii) break;
    }
  }
  const formatted = needsStringify ? JSON.stringify(value) : `"${value}"`;
  return hasNonAscii ? Buffer.from(formatted, 'utf8').toString('latin1') : formatted;
}

/**
 * Parquet to JSON: serializes decoded column vectors straight into 2-space indented JSON text, preserving
 * column order (including integer-named and "__proto__" columns) and -0 without building row records.
 */
export function parquetToJson(input: Buffer): Buffer {
  const { columns, numRows, totalStringBytes } = decodeParquetFormattedColumns(
    input,
    (colNames, c, safeAsciiString) => {
      const isLast = c === colNames.length - 1;
      const prefix = `${c === 0 ? ',\n  {\n    ' : ',\n    '}${formatJsonString(colNames[c])}: `;
      const suffix = isLast ? '\n  }' : '';
      const prefixQuote = `${prefix}"`;
      const suffixQuote = `"${suffix}`;
      const nullCell = `${prefix}null${suffix}`;
      const trueCell = `${prefix}true${suffix}`;
      const falseCell = `${prefix}false${suffix}`;
      const negZeroCell = `${prefix}-0${suffix}`;
      prefix.charCodeAt(0);
      prefixQuote.charCodeAt(0);
      suffixQuote.charCodeAt(0);
      nullCell.charCodeAt(0);
      trueCell.charCodeAt(0);
      falseCell.charCodeAt(0);
      negZeroCell.charCodeAt(0);
      return {
        nullCell,
        trueCell,
        falseCell,
        numberPrefix: prefix,
        numberSuffix: suffix,
        formatNumber: isLast
          ? (val: number) => {
              if (!Number.isFinite(val)) {
                throw new DataRepresentationError(`JSON cannot represent the number ${val}.`);
              }
              return val === 0 && 1 / val < 0 ? negZeroCell : prefix + val + suffix;
            }
          : (val: number) => {
              if (!Number.isFinite(val)) {
                throw new DataRepresentationError(`JSON cannot represent the number ${val}.`);
              }
              return val === 0 && 1 / val < 0 ? negZeroCell : prefix + val;
            },
        formatString: safeAsciiString
          ? (val: string) => prefixQuote + (val + suffixQuote)
          : isLast
            ? (val: string) => prefix + formatJsonString(val) + suffix
            : (val: string) => prefix + formatJsonString(val),
        formatTextSlice: (page: Buffer, start: number, end: number) => {
          for (let i = start; i < end; i++) {
            const b = page[i];
            if (b < CHAR_SPACE || b >= 0x80 || b === CHAR_QUOTE || b === CHAR_BACKSLASH) return null;
          }
          const raw = page.toString('latin1', start, end);
          return prefixQuote + (raw + suffixQuote);
        },
      };
    }
  );
  if (numRows === 0) return Buffer.from('[]', 'utf-8');

  const outBuf = Buffer.allocUnsafe(totalStringBytes + 2);
  const pos = writeFormattedColumnsLatin1(columns, numRows, outBuf, 0);
  outBuf[0] = CHAR_OPEN_BRACKET;
  outBuf[pos] = CHAR_LF;
  outBuf[pos + 1] = CHAR_CLOSE_BRACKET;

  return outBuf;
}

function matchesBytes(input: Buffer, start: number, end: number, expected: Uint8Array): boolean {
  const len = end - start;
  if (len !== expected.length) return false;
  for (let i = 0; i < len; i++) {
    if (input[start + i] !== expected[i]) return false;
  }
  return true;
}

/**
 * JSON Lines / NDJSON to CSV or TSV: scans flat UTF-8 JSON object lines directly into delimited rows.
 * Declines (returns null) on nested objects/arrays, \uXXXX escapes, new keys after the first record,
 * integer-index keys, or any encoding/syntax error so the general route handles or reports them.
 */
export function jsonLinesToDelimited(
  input: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: ConversionOptions = {}
): Buffer | null {
  const src = sourceFormat.toLowerCase();
  if (src !== 'jsonl' && src !== 'ndjson') return null;
  const tgt = targetFormat.toLowerCase();
  if (tgt !== 'csv' && tgt !== 'tsv') return null;
  const end = input.length;
  if (end === 0) return null;

  // Reject UTF-16 BOMs and invalid UTF-8 up front so decodeUtf8Text raises DataEncodingError.
  if (
    end >= 2 &&
    ((input[0] === UTF16_BOM_FF && input[1] === UTF16_BOM_FE) ||
      (input[0] === UTF16_BOM_FE && input[1] === UTF16_BOM_FF))
  ) {
    return null;
  }
  let pos = 0;
  if (end >= 3 && input[0] === UTF8_BOM_0 && input[1] === UTF8_BOM_1 && input[2] === UTF8_BOM_2) {
    pos = 3;
  }
  if (!isUtf8(input)) return null;

  const delimiter = tgt === 'tsv' ? '\t' : ',';
  const delimCode = tgt === 'tsv' ? CHAR_TAB : CHAR_COMMA;
  const escapeFormulas = options.escapeFormulas ?? true;
  const withBom = options.bom ?? writesBomByDefault(tgt);

  const fields: string[] = [];
  const keyBytes: Uint8Array[] = [];
  const fieldIndex = new Map<string, number>();

  let numCols = 0;
  let singleColumn = false;
  let emptyCell = '';
  let seenRow = new Int32Array(0);
  let rowCells: string[] = [];
  const lines: string[] = [''];
  let rowCount = 0;

  while (pos < end) {
    // Skip horizontal whitespace at the start of a line.
    while (pos < end && (input[pos] === CHAR_SPACE || input[pos] === CHAR_TAB)) pos++;
    if (pos >= end) break;
    if (input[pos] === CHAR_LF) {
      pos++;
      continue;
    }
    if (input[pos] === CHAR_CR) {
      if (pos + 1 >= end) {
        pos++;
        break;
      }
      if (input[pos + 1] === CHAR_LF) {
        pos += 2;
        continue;
      }
      return null;
    }

    if (input[pos] !== CHAR_OPEN_BRACE) return null;
    pos++;
    while (pos < end && (input[pos] === CHAR_SPACE || input[pos] === CHAR_TAB)) pos++;
    if (pos >= end || input[pos] === CHAR_CLOSE_BRACE) return null;

    const currentRowId = rowCount + 1;
    let colCursor = 0;

    for (;;) {
      if (input[pos] !== CHAR_QUOTE) return null;
      pos++;
      const keyStart = pos;
      while (pos < end) {
        const b = input[pos];
        if (b === CHAR_QUOTE) break;
        if (b < CHAR_SPACE || b === CHAR_BACKSLASH) return null;
        pos++;
      }
      if (pos >= end || pos === keyStart) {
        // Note: empty key "" is valid in JSON, wait - if pos === keyStart, key is "". Let's allow empty key or check below.
        if (pos >= end) return null;
      }
      const keyEnd = pos;
      pos++; // closing quote

      let colIdx = -1;
      if (rowCount === 0) {
        const firstByte = keyEnd > keyStart ? input[keyStart] : 0;
        if (firstByte >= CHAR_ZERO && firstByte <= CHAR_NINE) return null;
        const key = input.toString('utf8', keyStart, keyEnd);
        if (key === '__proto__' || fieldIndex.has(key)) return null;
        colIdx = fields.length;
        fields.push(key);
        keyBytes.push(input.subarray(keyStart, keyEnd));
        fieldIndex.set(key, colIdx);
      } else {
        if (colCursor < numCols && matchesBytes(input, keyStart, keyEnd, keyBytes[colCursor])) {
          colIdx = colCursor;
        } else {
          for (let k = 0; k < numCols; k++) {
            if (matchesBytes(input, keyStart, keyEnd, keyBytes[k])) {
              colIdx = k;
              break;
            }
          }
          if (colIdx === -1) return null;
        }
        if (seenRow[colIdx] === currentRowId) return null;
        seenRow[colIdx] = currentRowId;
      }
      colCursor = colIdx + 1;

      while (pos < end && (input[pos] === CHAR_SPACE || input[pos] === CHAR_TAB)) pos++;
      if (pos >= end || input[pos] !== CHAR_COLON) return null;
      pos++;
      while (pos < end && (input[pos] === CHAR_SPACE || input[pos] === CHAR_TAB)) pos++;
      if (pos >= end) return null;

      let cellValue = '';
      const vByte = input[pos];

      if (vByte === CHAR_QUOTE) {
        pos++;
        const strStart = pos;
        let hasEscape = false;
        let sawDelim = false;
        let sawEf = false;
        while (pos < end) {
          const b = input[pos];
          if (b === CHAR_QUOTE) break;
          if (b === CHAR_BACKSLASH) {
            hasEscape = true;
            break;
          }
          if (b < CHAR_SPACE) return null;
          if (b === delimCode) sawDelim = true;
          else if (b === UTF8_BOM_0) sawEf = true;
          pos++;
        }
        if (pos >= end) return null;

        if (!hasEscape) {
          const strEnd = pos;
          pos++; // closing quote
          if (strEnd === strStart) {
            cellValue = rowCount === 0 ? '' : emptyCell;
          } else {
            const b0 = input[strStart];
            const bLast = input[strEnd - 1];
            const raw = input.toString('utf8', strStart, strEnd);
            if (
              escapeFormulas &&
              (b0 === CHAR_EQUALS || b0 === CHAR_AT || ((b0 === CHAR_PLUS || b0 === CHAR_MINUS) && FORMULA_TRIGGER.test(raw)))
            ) {
              cellValue = `"'${raw}"`;
            } else if (
              b0 === CHAR_SPACE ||
              bLast === CHAR_SPACE ||
              sawDelim ||
              (sawEf && raw.indexOf(UTF8_BOM_CHAR) !== -1)
            ) {
              cellValue = `"${raw}"`;
            } else {
              cellValue = raw;
            }
          }
        } else {
          let decoded = pos > strStart ? input.toString('utf8', strStart, pos) : '';
          let chunkStart = pos;
          for (;;) {
            if (pos >= end) return null;
            const b = input[pos];
            if (b === CHAR_QUOTE) {
              if (pos > chunkStart) decoded += input.toString('utf8', chunkStart, pos);
              pos++;
              break;
            }
            if (b < CHAR_SPACE) return null;
            if (b !== CHAR_BACKSLASH) {
              pos++;
              continue;
            }
            if (pos > chunkStart) decoded += input.toString('utf8', chunkStart, pos);
            if (pos + 1 >= end) return null;
            const esc = input[pos + 1];
            if (esc === CHAR_QUOTE) decoded += '"';
            else if (esc === CHAR_BACKSLASH) decoded += '\\';
            else if (esc === CHAR_SLASH) decoded += '/';
            else if (esc === CHAR_B) decoded += '\b';
            else if (esc === CHAR_F) decoded += '\f';
            else if (esc === CHAR_N) decoded += '\n';
            else if (esc === CHAR_R) decoded += '\r';
            else if (esc === CHAR_T) decoded += '\t';
            else return null;
            pos += 2;
            chunkStart = pos;
          }
          cellValue = formatDelimitedString(decoded, delimCode, escapeFormulas, singleColumn);
        }
      } else if (vByte === CHAR_MINUS || (vByte >= CHAR_ZERO && vByte <= CHAR_NINE)) {
        const numStart = pos;
        if (input[pos] === CHAR_MINUS) pos++;
        if (pos >= end) return null;
        let intDigits = 0;
        if (input[pos] === CHAR_ZERO) {
          intDigits = 1;
          pos++;
        } else if (input[pos] >= CHAR_ZERO && input[pos] <= CHAR_NINE) {
          const dStart = pos;
          while (pos < end && input[pos] >= CHAR_ZERO && input[pos] <= CHAR_NINE) pos++;
          intDigits = pos - dStart;
        } else {
          return null;
        }
        let isFloat = false;
        if (pos < end && input[pos] === CHAR_DOT) {
          isFloat = true;
          pos++;
          const fStart = pos;
          while (pos < end && input[pos] >= CHAR_ZERO && input[pos] <= CHAR_NINE) pos++;
          if (pos === fStart) return null;
        }
        if (pos < end && (input[pos] === CHAR_LOWER_E || input[pos] === CHAR_UPPER_E)) {
          isFloat = true;
          pos++;
          if (pos < end && (input[pos] === CHAR_PLUS || input[pos] === CHAR_MINUS)) pos++;
          const eStart = pos;
          while (pos < end && input[pos] >= CHAR_ZERO && input[pos] <= CHAR_NINE) pos++;
          if (pos === eStart) return null;
        }
        if (!isFloat) {
          if (intDigits > MAX_INTEGER_LITERAL_DIGITS) return null;
          if (pos - numStart === 2 && input[numStart] === CHAR_MINUS && input[numStart + 1] === CHAR_ZERO) {
            cellValue = '0';
          } else {
            cellValue = input.toString('ascii', numStart, pos);
          }
        } else {
          const rawNum = input.toString('ascii', numStart, pos);
          const num = Number(rawNum);
          if (!Number.isFinite(num)) return null;
          cellValue = String(num);
        }
      } else if (
        vByte === CHAR_T &&
        pos + 3 < end &&
        input[pos + 1] === CHAR_R &&
        input[pos + 2] === CHAR_U &&
        input[pos + 3] === CHAR_LOWER_E
      ) {
        pos += 4;
        cellValue = 'true';
      } else if (
        vByte === CHAR_F &&
        pos + 4 < end &&
        input[pos + 1] === 0x61 &&
        input[pos + 2] === CHAR_L &&
        input[pos + 3] === CHAR_S &&
        input[pos + 4] === CHAR_LOWER_E
      ) {
        pos += 5;
        cellValue = 'false';
      } else if (
        vByte === CHAR_N &&
        pos + 3 < end &&
        input[pos + 1] === CHAR_U &&
        input[pos + 2] === CHAR_L &&
        input[pos + 3] === CHAR_L
      ) {
        pos += 4;
        cellValue = emptyCell;
      } else {
        return null;
      }

      if (rowCount === 0) {
        rowCells.push(cellValue);
      } else {
        rowCells[colIdx] = cellValue;
      }

      while (pos < end && (input[pos] === CHAR_SPACE || input[pos] === CHAR_TAB)) pos++;
      if (pos >= end) return null;
      const sep = input[pos];
      if (sep === CHAR_COMMA) {
        pos++;
        while (pos < end && (input[pos] === CHAR_SPACE || input[pos] === CHAR_TAB)) pos++;
        continue;
      }
      if (sep === CHAR_CLOSE_BRACE) {
        pos++;
        break;
      }
      return null;
    }

    // End of JSON object on this line: allow only horizontal whitespace up to LF / CRLF / EOF.
    while (pos < end && (input[pos] === CHAR_SPACE || input[pos] === CHAR_TAB)) pos++;
    if (pos < end) {
      if (input[pos] === CHAR_LF) {
        pos++;
      } else if (input[pos] === CHAR_CR) {
        if (pos + 1 < end && input[pos + 1] === CHAR_LF) {
          pos += 2;
        } else if (pos + 1 === end) {
          pos++;
        } else {
          return null;
        }
      } else {
        return null;
      }
    }

    if (rowCount === 0) {
      numCols = fields.length;
      if (numCols === 0) return null;
      singleColumn = numCols === 1;
      emptyCell = singleColumn ? '""' : '';
      seenRow = new Int32Array(numCols);
      let headerLine = formatDelimitedString(fields[0], delimCode, escapeFormulas, singleColumn);
      for (let c = 1; c < numCols; c++) {
        headerLine += delimiter + formatDelimitedString(fields[c], delimCode, escapeFormulas, singleColumn);
      }
      lines[0] = withBom ? UTF8_BOM_CHAR + headerLine : headerLine;
      if (singleColumn && rowCells[0] === '') {
        rowCells[0] = '""';
      }
      let line0 = rowCells[0];
      for (let c = 1; c < numCols; c++) {
        line0 += delimiter + rowCells[c];
      }
      lines.push(line0);
    } else {
      let line = seenRow[0] === currentRowId ? rowCells[0] : emptyCell;
      for (let c = 1; c < numCols; c++) {
        line += delimiter + (seenRow[c] === currentRowId ? rowCells[c] : emptyCell);
      }
      lines.push(line);
    }
    rowCount++;
  }

  if (rowCount === 0) return null;
  return Buffer.from(lines.join(DELIMITED_RECORD_SEPARATOR), 'utf-8');
}
