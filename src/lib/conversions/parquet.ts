/**
 * Pure TypeScript Apache Parquet engine (facade over the format modules).
 *
 * - parquet-format.ts : enums, typed errors, named limits
 * - parquet-thrift.ts : Thrift Compact Protocol (footer and page headers)
 * - parquet-snappy.ts : Snappy block compressor/decompressor
 * - parquet-rle.ts    : RLE/bit-packed hybrid (definition levels, dictionary indices)
 * - parquet-codec.ts  : page compression (UNCOMPRESSED, SNAPPY, GZIP read, ZSTD)
 * - parquet-writer.ts : typed OPTIONAL columns, dictionary encoding, statistics, row groups
 * - parquet-reader.ts : flat-table decoder with fail-closed validation
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
export { isZstdWriteAvailable } from './parquet-codec';
export type { ParquetWriteOptions } from './parquet-writer';
export { encodeParquet, inferColumnSchemas } from './parquet-writer';
export { decodeParquet } from './parquet-reader';
