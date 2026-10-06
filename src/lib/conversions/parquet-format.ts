import { ConversionFailedError } from '../types';

/**
 * Parquet format constants shared by the writer and the reader.
 *
 * Governing spec: Apache Parquet format (parquet.thrift, Encodings.md, LogicalTypes.md).
 */

export const PARQUET_MAGIC = 'PAR1';

export enum ParquetType {
  BOOLEAN = 0,
  INT32 = 1,
  INT64 = 2,
  INT96 = 3,
  FLOAT = 4,
  DOUBLE = 5,
  BYTE_ARRAY = 6,
  FIXED_LEN_BYTE_ARRAY = 7,
}

export enum FieldRepetitionType {
  REQUIRED = 0,
  OPTIONAL = 1,
  REPEATED = 2,
}

export enum ConvertedType {
  UTF8 = 0,
}

export enum CompressionCodec {
  UNCOMPRESSED = 0,
  SNAPPY = 1,
  GZIP = 2,
  LZO = 3,
  BROTLI = 4,
  LZ4 = 5,
  ZSTD = 6,
}

export enum PageType {
  DATA_PAGE = 0,
  INDEX_PAGE = 1,
  DICTIONARY_PAGE = 2,
  DATA_PAGE_V2 = 3,
}

export enum Encoding {
  PLAIN = 0,
  PLAIN_DICTIONARY = 2,
  RLE = 3,
  BIT_PACKED = 4,
  RLE_DICTIONARY = 8,
}

export interface ColumnSchema {
  name: string;
  type: ParquetType;
  convertedType?: ConvertedType;
  repetitionType: FieldRepetitionType;
}

// ==========================================
// Typed errors (extend ConversionFailedError so the API answers HTTP 400)
// ==========================================

/** The Parquet payload is malformed, truncated, or uses a feature this engine does not decode. */
export class ParquetFormatError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'ParquetFormatError';
  }
}

/** The records handed to the writer cannot be represented as a typed Parquet table. */
export class ParquetValueError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'ParquetValueError';
  }
}

/** The requested compression codec is not available in this runtime. */
export class ParquetCodecUnavailableError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'ParquetCodecUnavailableError';
  }
}

// ==========================================
// Named limits (every loop and allocation driven by input is bounded by one of these)
// ==========================================

const MIB = 1024 * 1024;

/** Maximum rows accepted by the writer and declared by a file the reader decodes. */
export const PARQUET_MAX_ROWS = 10_000_000;
/** Maximum leaf columns in a file. */
export const PARQUET_MAX_COLUMNS = 4096;
/** Maximum rows x columns held in memory at once. */
export const PARQUET_MAX_CELLS = 20_000_000;
/** Maximum row groups the reader accepts in one file. */
export const PARQUET_MAX_ROW_GROUPS = 100_000;
/** Maximum UTF-8 bytes of one string value (also bounds one page, which is an i32 on the wire). */
export const PARQUET_MAX_VALUE_BYTES = 64 * MIB;
/** Maximum uncompressed bytes of one page the reader will materialize. */
export const PARQUET_MAX_PAGE_BYTES = 256 * MIB;
/** Maximum bytes of a footer the reader will parse. */
export const PARQUET_MAX_FOOTER_BYTES = 64 * MIB;

/** Writer defaults: bounded row groups and pages. */
export const PARQUET_ROW_GROUP_MAX_ROWS = 1_048_576;
export const PARQUET_ROW_GROUP_MAX_BYTES = 128 * MIB;
export const PARQUET_DATA_PAGE_MAX_ROWS = 65_536;
export const PARQUET_DATA_PAGE_TARGET_BYTES = MIB;
/** A dictionary larger than this is abandoned and the column chunk falls back to PLAIN. */
export const PARQUET_DICTIONARY_MAX_BYTES = MIB;
/** Min/max statistics longer than this are omitted (null_count is still written). */
export const PARQUET_STATS_MAX_BYTES = 4096;

export const PARQUET_FORMAT_VERSION = 1;
export const PARQUET_CREATED_BY = 'easyconvert';
