import type { ConversionOptions } from '../types';
import { DelimitedBytesUnsupported, DelimitedByteScanner } from './delimited-bytes';
import { nominalDelimiter } from './delimited-detect';
import { encodeParquetFromScanner } from './parquet-text-writer';
import type { ParquetWriteOptions } from './parquet-writer';

/**
 * Direct routes for the commonest table conversions. Each one reads and writes the same data as the general route
 * in data.ts (parse into records, flatten into a table, write the target) without building the records, and returns
 * null for any input it does not handle, so the general route converts that input and reports its errors.
 */

/** Header names a record object would reorder: array indices come first in an object's own keys. */
const ARRAY_INDEX_NAME = /^(?:0|[1-9][0-9]*)$/;

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
