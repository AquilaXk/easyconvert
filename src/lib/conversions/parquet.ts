/**
 * Pure TypeScript Apache Parquet engine (facade over the format modules).
 *
 * - parquet-format.ts : enums, typed errors, named limits
 * - parquet-thrift.ts : Thrift Compact Protocol (footer and page headers)
 * - parquet-snappy.ts : Snappy block compressor/decompressor
 * - parquet-rle.ts    : RLE/bit-packed hybrid (definition levels, dictionary indices)
 * - parquet-codec.ts  : page compression (UNCOMPRESSED, SNAPPY, GZIP read, ZSTD)
 * - parquet-writer.ts : typed OPTIONAL columns, dictionary encoding, statistics, row groups
 * - parquet-reader.ts : schema, page headers and the pages of a column, with fail-closed validation
 * - parquet-schema.ts : the schema tree, with the LIST and MAP rules
 * - parquet-nested.ts : nested columns assembled into records from repetition and definition levels
 * - parquet-table.ts  : the entry points that read a file into columns and records
 */

export type { ColumnSchema } from './parquet-format';
export {
  CompressionCodec,
  ConvertedType,
  Encoding,
  FieldRepetitionType,
  PageType,
  PARQUET_MAGIC,
  ParquetCodecUnavailableError,
  ParquetFormatError,
  ParquetUnsupportedError,
  ParquetType,
  ParquetValueError,
} from './parquet-format';
export { CompactProtocolReader, CompactProtocolWriter } from './parquet-thrift';
export { compressSnappy, decompressRawSnappyBlock, decompressSnappy } from './parquet-snappy';
export { decompressLz4Raw, isZstdWriteAvailable } from './parquet-codec';
export type { ParquetWriteOptions } from './parquet-writer';
export { encodeParquet, inferColumnSchemas } from './parquet-writer';
export type { ColumnCellFormatter, ColumnFormatterFactory, FormattedRowWindow } from './parquet-formatted';
export { FormattedParquetTable } from './parquet-formatted';
export type { DecodedParquetColumns, ParquetRecords } from './parquet-table';
export { decodeParquet, decodeParquetColumns, decodeParquetTable } from './parquet-table';
export type { CellShape } from './parquet-schema';
