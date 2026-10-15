import type { ConversionOptions } from '../types';
import { ChunkedOutput } from './chunked-output';
import { CHAR_COMMA, CHAR_TAB, UTF8_BOM_LATIN1 } from './delimited-cells';
import { DelimitedBytesUnsupported, DelimitedByteScanner } from './delimited-bytes';
import { nominalDelimiter } from './delimited-detect';
import { writesBomByDefault } from './delimited-rules';
import { FormattedParquetTable } from './parquet-formatted';
import { encodeParquetFromScanner } from './parquet-text-writer';
import type { ParquetWriteOptions } from './parquet-writer';
import { delimitedFormatters, delimitedHeaderLine, jsonFormatters, writeTableRows } from './table-text';

/**
 * Direct routes for the commonest table conversions. Each one reads and writes the same data as the general route
 * in data.ts (parse into records, flatten into a table, write the target) without building the records, and returns
 * null for any input it does not handle, so the general route converts that input and reports its errors.
 */

/** Header names a record object would reorder: array indices come first in an object's own keys. */
const ARRAY_INDEX_NAME = /^(?:0|[1-9][0-9]*)$/;
const CHAR_OPEN_BRACKET = 0x5b;

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

/**
 * Parquet to CSV or TSV: formats the cells of each row window straight into delimited rows, without row objects
 * and without Papa.unparse over a 2D array.
 */
export function parquetToDelimited(input: Buffer, targetFormat: string, options: ConversionOptions = {}): Buffer | null {
  const target = targetFormat.toLowerCase();
  if (target !== 'csv' && target !== 'tsv') return null;
  const style = {
    delimiter: target === 'tsv' ? '\t' : ',',
    delimiterCode: target === 'tsv' ? CHAR_TAB : CHAR_COMMA,
    escapeFormulas: options.escapeFormulas ?? true,
  };
  const table = FormattedParquetTable.open(input, delimitedFormatters(style));
  if (table.numRows === 0) return null;

  const out = new ChunkedOutput({ expectedBytes: input.length });
  const header = delimitedHeaderLine(table.names, style);
  out.writeLatin1(options.bom ?? writesBomByDefault(target) ? UTF8_BOM_LATIN1 + header : header);
  writeTableRows(table, out);
  return out.toBuffer();
}

/**
 * Parquet to JSON: serializes the cells of each row window straight into 2-space indented JSON text, preserving
 * column order (including integer-named and "__proto__" columns) and -0 without building row records.
 */
export function parquetToJson(input: Buffer): Buffer {
  const table = FormattedParquetTable.open(input, jsonFormatters());
  if (table.numRows === 0) return Buffer.from('[]', 'utf-8');

  // Every cell opens with a comma; the one before the first object becomes the bracket.
  const out = new ChunkedOutput({ expectedBytes: input.length });
  writeTableRows(table, out);
  out.writeLatin1('\n]');
  const json = out.toBuffer();
  json[0] = CHAR_OPEN_BRACKET;
  return json;
}

export { jsonLinesToDelimited } from './jsonl-delimited';
