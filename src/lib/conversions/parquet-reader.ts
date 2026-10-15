import { setOwn } from './data-json';
import { decompressPage, decompressPageSlice } from './parquet-codec';
import {
  decodeBitPackedLevels,
  decodeBooleanRle,
  decodeByteStreamSplit,
  decodeDeltaBinaryPacked,
  decodeDeltaByteArray,
  decodeDeltaLengthByteArray,
} from './parquet-encodings';
import {
  CompressionCodec,
  Encoding,
  FieldRepetitionType,
  PageType,
  PARQUET_CELL_BYTES,
  PARQUET_MAGIC,
  PARQUET_MAX_CELLS,
  PARQUET_MAX_COLUMNS,
  PARQUET_MAX_DECODED_VALUE_BYTES,
  PARQUET_MAX_FOOTER_BYTES,
  PARQUET_MAX_PAGE_BYTES,
  PARQUET_MAX_ROW_GROUPS,
  PARQUET_MAX_ROWS,
  PARQUET_MAX_TOTAL_DECOMPRESSED_BYTES,
  ParquetFormatError,
  ParquetType,
  ParquetUnsupportedError,
} from './parquet-format';
import {
  Annotation,
  annotationFromConverted,
  ColumnReader,
  ColumnValue,
  exactInteger,
  resolveColumnReader,
  TimeUnit,
  unsignedInteger,
} from './parquet-logical';
import { decodeRleHybrid } from './parquet-rle';
import { CompactProtocolReader, ThriftType } from './parquet-thrift';

/**
 * Parquet reader for flat (non-nested) tables: PLAIN, dictionary, DELTA_BINARY_PACKED,
 * DELTA_LENGTH_BYTE_ARRAY, DELTA_BYTE_ARRAY, BYTE_STREAM_SPLIT, and RLE boolean encodings,
 * RLE/bit-packed definition levels, v1 and v2 data pages, UNCOMPRESSED/SNAPPY/GZIP/ZSTD/LZ4_RAW
 * pages, any number of row groups.
 *
 * Governing spec: Apache Parquet format (parquet.thrift, Encodings.md, LogicalTypes.md). Values keep
 * their exact meaning (see parquet-logical.ts); anything outside the supported scope (nested schemas)
 * throws a typed error rather than guessing.
 *
 * Untrusted-input bounds: column chunks must lie inside the data section and not overlap, page
 * headers are scanned and charged against one decompression budget before any page is decompressed,
 * and decoded cells are charged against a memory cap that counts a dictionary string once per row.
 */

const FOOTER_TRAILER_BYTES = 8;
const MAGIC_BYTES = 4;
const MIN_FILE_BYTES = 12;
const BITS_PER_BYTE = 8;
export const BYTE_ARRAY_LENGTH_PREFIX_BYTES = 4;
export const WIDE_VALUE_BYTES = 8;
export const NARROW_VALUE_BYTES = 4;
const MAX_DEFINITION_LEVEL = 1;
const MAX_DICTIONARY_INDEX_BIT_WIDTH = 32;
export const UINT32_RANGE = 2 ** 32;

/** SchemaElement / LogicalType / PageHeader field ids (parquet.thrift). */
const SCHEMA_TYPE = 1;
const SCHEMA_TYPE_LENGTH = 2;
const SCHEMA_REPETITION = 3;
const SCHEMA_NAME = 4;
const SCHEMA_NUM_CHILDREN = 5;
const SCHEMA_CONVERTED_TYPE = 6;
const SCHEMA_SCALE = 7;
const SCHEMA_PRECISION = 8;
const SCHEMA_LOGICAL_TYPE = 10;
const LOGICAL_STRING = 1;
const LOGICAL_ENUM = 4;
const LOGICAL_DECIMAL = 5;
const LOGICAL_DATE = 6;
const LOGICAL_TIME = 7;
const LOGICAL_TIMESTAMP = 8;
const LOGICAL_INTEGER = 10;
const LOGICAL_JSON = 12;
const LOGICAL_BSON = 13;
const LOGICAL_UUID = 14;
const LOGICAL_FLOAT16 = 15;
const LOGICAL_NAMES: Record<number, string> = { 2: 'MAP', 3: 'LIST', 11: 'UNKNOWN' };
const TIME_UNIT_BY_FIELD: Record<number, TimeUnit> = { 1: 'millis', 2: 'micros', 3: 'nanos' };

export const DICTIONARY_DATA_ENCODINGS: ReadonlySet<number> = new Set([Encoding.PLAIN_DICTIONARY, Encoding.RLE_DICTIONARY]);

export interface LeafColumn {
  name: string;
  colIndex: number;
  type: ParquetType;
  repetition: FieldRepetitionType;
  typeLength: number;
  annotation: Annotation;
  reader: ColumnReader;
}

interface ChunkMeta {
  path: string;
  type: ParquetType;
  codec: CompressionCodec;
  numValues: number;
  dataPageOffset: number;
  dictionaryPageOffset: number;
  fileOffset: number;
  totalCompressedSize: number;
}

interface RowGroupMeta {
  numRows: number;
  chunks: ChunkMeta[];
}

export interface FileMeta {
  leaves: LeafColumn[];
  numRows: number;
  rowGroups: RowGroupMeta[];
}

export interface PageHeader {
  type: PageType;
  uncompressedSize: number;
  compressedSize: number;
  numValues: number;
  numNulls: number;
  numRows: number;
  encoding: number;
  definitionLevelEncoding: number;
  definitionLevelsByteLength: number;
  repetitionLevelsByteLength: number;
  isCompressed: boolean;
  hasDataPageV2: boolean;
  headerEnd: number;
}

export interface ScannedPage {
  header: PageHeader;
  bodyStart: number;
  bodyEnd: number;
}

export interface ChunkPlan {
  chunk: ChunkMeta;
  leaf: LeafColumn;
  rows: number;
  start: number;
  end: number;
  pages: ScannedPage[];
}

export interface DecodeBudget {
  /** Decoded-cell bytes still available (cells, plus UTF-8 bytes per string reference). */
  valueBytes: number;
}

function toSafeInt(value: bigint, what: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ParquetFormatError(`Corrupted Parquet metadata: ${what} ${value} is out of range`);
  }
  return Number(value);
}

// ==========================================
// Footer
// ==========================================

function readTimeUnit(reader: CompactProtocolReader): TimeUnit {
  reader.structBegin();
  let unit: TimeUnit = 'millis';
  for (;;) {
    const f = reader.readFieldBegin();
    if (f.isStop) break;
    unit = TIME_UNIT_BY_FIELD[f.fieldId] ?? unit;
    reader.skip(f.type);
  }
  reader.structEnd();
  return unit;
}

function readLogicalType(reader: CompactProtocolReader): Annotation {
  reader.structBegin();
  let annotation: Annotation = { tag: 'none' };
  for (;;) {
    const f = reader.readFieldBegin();
    if (f.isStop) break;
    if (f.fieldId === LOGICAL_STRING) annotation = { tag: 'string' };
    else if (f.fieldId === LOGICAL_ENUM) annotation = { tag: 'enum' };
    else if (f.fieldId === LOGICAL_JSON) annotation = { tag: 'json' };
    else if (f.fieldId === LOGICAL_BSON) annotation = { tag: 'bson' };
    else if (f.fieldId === LOGICAL_UUID) annotation = { tag: 'uuid' };
    else if (f.fieldId === LOGICAL_FLOAT16) annotation = { tag: 'float16' };
    else if (f.fieldId === LOGICAL_DATE) annotation = { tag: 'date' };
    else if (f.fieldId === LOGICAL_DECIMAL) annotation = readDecimalType(reader);
    else if (f.fieldId === LOGICAL_TIME || f.fieldId === LOGICAL_TIMESTAMP) {
      annotation = readTimeType(reader, f.fieldId === LOGICAL_TIMESTAMP);
    } else if (f.fieldId === LOGICAL_INTEGER) annotation = readIntegerType(reader);
    else annotation = { tag: 'unsupported', name: LOGICAL_NAMES[f.fieldId] ?? `logical type ${f.fieldId}` };
    if (f.fieldId !== LOGICAL_DECIMAL && f.fieldId !== LOGICAL_TIME && f.fieldId !== LOGICAL_TIMESTAMP && f.fieldId !== LOGICAL_INTEGER) {
      reader.skip(f.type);
    }
  }
  reader.structEnd();
  return annotation;
}

function readDecimalType(reader: CompactProtocolReader): Annotation {
  reader.structBegin();
  let scale = 0;
  let precision = 0;
  for (;;) {
    const f = reader.readFieldBegin();
    if (f.isStop) break;
    if (f.fieldId === 1) scale = reader.readZigzag32();
    else if (f.fieldId === 2) precision = reader.readZigzag32();
    else reader.skip(f.type);
  }
  reader.structEnd();
  return { tag: 'decimal', scale, precision };
}

function readTimeType(reader: CompactProtocolReader, isTimestamp: boolean): Annotation {
  reader.structBegin();
  let adjustedToUtc = false;
  let unit: TimeUnit = 'millis';
  for (;;) {
    const f = reader.readFieldBegin();
    if (f.isStop) break;
    if (f.fieldId === 1) adjustedToUtc = f.type === ThriftType.BOOL_TRUE;
    else if (f.fieldId === 2) unit = readTimeUnit(reader);
    else reader.skip(f.type);
  }
  reader.structEnd();
  return isTimestamp ? { tag: 'timestamp', unit, adjustedToUtc } : { tag: 'time', unit };
}

function readIntegerType(reader: CompactProtocolReader): Annotation {
  reader.structBegin();
  let bitWidth = 0;
  let signed = true;
  for (;;) {
    const f = reader.readFieldBegin();
    if (f.isStop) break;
    if (f.fieldId === 1) bitWidth = reader.readByte();
    else if (f.fieldId === 2) signed = f.type === ThriftType.BOOL_TRUE;
    else reader.skip(f.type);
  }
  reader.structEnd();
  return { tag: 'int', bitWidth, signed };
}

function readSchemaElements(reader: CompactProtocolReader): LeafColumn[] {
  const { size } = reader.readListBegin();
  if (size < 1 || size > PARQUET_MAX_COLUMNS + 1) {
    throw new ParquetFormatError(`Unsupported Parquet schema: ${size} schema elements (limit ${PARQUET_MAX_COLUMNS} columns)`);
  }
  const leaves: LeafColumn[] = [];
  for (let i = 0; i < size; i++) {
    reader.structBegin();
    let type: ParquetType | undefined;
    let repetition = FieldRepetitionType.REQUIRED;
    let name = '';
    let numChildren = 0;
    let typeLength = 0;
    let converted: number | undefined;
    let scale = 0;
    let precision = 0;
    let logical: Annotation | null = null;
    for (;;) {
      const f = reader.readFieldBegin();
      if (f.isStop) break;
      if (f.fieldId === SCHEMA_TYPE) type = reader.readZigzag32() as ParquetType;
      else if (f.fieldId === SCHEMA_TYPE_LENGTH) typeLength = reader.readZigzag32();
      else if (f.fieldId === SCHEMA_REPETITION) repetition = reader.readZigzag32() as FieldRepetitionType;
      else if (f.fieldId === SCHEMA_NAME) name = reader.readString();
      else if (f.fieldId === SCHEMA_NUM_CHILDREN) numChildren = reader.readZigzag32();
      else if (f.fieldId === SCHEMA_CONVERTED_TYPE) converted = reader.readZigzag32();
      else if (f.fieldId === SCHEMA_SCALE) scale = reader.readZigzag32();
      else if (f.fieldId === SCHEMA_PRECISION) precision = reader.readZigzag32();
      else if (f.fieldId === SCHEMA_LOGICAL_TYPE) logical = readLogicalType(reader);
      else reader.skip(f.type);
    }
    reader.structEnd();
    if (i === 0) {
      if (numChildren !== size - 1) {
        throw new ParquetUnsupportedError('Unsupported Parquet schema: nested columns are not supported');
      }
      continue;
    }
    if (numChildren > 0 || type === undefined) {
      throw new ParquetUnsupportedError(`Unsupported Parquet schema: column '${name}' is a nested group`);
    }
    if (repetition === FieldRepetitionType.REPEATED) {
      throw new ParquetUnsupportedError(`Unsupported Parquet schema: column '${name}' is repeated`);
    }
    const annotation = logical ?? annotationFromConverted(converted, scale, precision);
    // The reader is resolved lazily (INT96 and unknown annotations only matter when rows are decoded).
    leaves.push({
      name,
      colIndex: leaves.length,
      type,
      repetition,
      typeLength,
      annotation,
      reader: { kind: 'bytes', width: 0, map: null },
    });
  }
  return leaves;
}

function readColumnMetaData(reader: CompactProtocolReader, chunk: ChunkMeta): void {
  reader.structBegin();
  for (;;) {
    const mf = reader.readFieldBegin();
    if (mf.isStop) break;
    if (mf.fieldId === 1) {
      chunk.type = reader.readZigzag32() as ParquetType;
    } else if (mf.fieldId === 3) {
      const { size } = reader.readListBegin();
      const parts: string[] = [];
      for (let p = 0; p < size; p++) parts.push(reader.readString());
      if (parts.length !== 1) {
        throw new ParquetUnsupportedError('Unsupported Parquet schema: nested column paths are not supported');
      }
      chunk.path = parts[0];
    } else if (mf.fieldId === 4) {
      chunk.codec = reader.readZigzag32() as CompressionCodec;
    } else if (mf.fieldId === 5) {
      chunk.numValues = toSafeInt(reader.readZigzag64(), 'num_values');
    } else if (mf.fieldId === 7) {
      chunk.totalCompressedSize = toSafeInt(reader.readZigzag64(), 'total_compressed_size');
    } else if (mf.fieldId === 9) {
      chunk.dataPageOffset = toSafeInt(reader.readZigzag64(), 'data_page_offset');
    } else if (mf.fieldId === 11) {
      chunk.dictionaryPageOffset = toSafeInt(reader.readZigzag64(), 'dictionary_page_offset');
    } else {
      reader.skip(mf.type);
    }
  }
  reader.structEnd();
}

function readRowGroup(reader: CompactProtocolReader, leafCount: number): RowGroupMeta {
  reader.structBegin();
  const group: RowGroupMeta = { numRows: 0, chunks: [] };
  for (;;) {
    const rgf = reader.readFieldBegin();
    if (rgf.isStop) break;
    if (rgf.fieldId === 1) {
      const { size } = reader.readListBegin();
      if (size > leafCount) {
        throw new ParquetFormatError(`Corrupted Parquet metadata: row group lists ${size} column chunks for ${leafCount} columns`);
      }
      for (let c = 0; c < size; c++) {
        reader.structBegin();
        const chunk: ChunkMeta = {
          path: '',
          type: ParquetType.BYTE_ARRAY,
          codec: CompressionCodec.UNCOMPRESSED,
          numValues: 0,
          dataPageOffset: 0,
          dictionaryPageOffset: 0,
          fileOffset: 0,
          totalCompressedSize: 0,
        };
        for (;;) {
          const ccf = reader.readFieldBegin();
          if (ccf.isStop) break;
          if (ccf.fieldId === 2) chunk.fileOffset = toSafeInt(reader.readZigzag64(), 'file_offset');
          else if (ccf.fieldId === 3) readColumnMetaData(reader, chunk);
          else reader.skip(ccf.type);
        }
        reader.structEnd();
        group.chunks.push(chunk);
      }
    } else if (rgf.fieldId === 3) {
      group.numRows = toSafeInt(reader.readZigzag64(), 'row group num_rows');
    } else {
      reader.skip(rgf.type);
    }
  }
  reader.structEnd();
  return group;
}

function readFooter(buffer: Buffer, metaOffset: number): FileMeta {
  const reader = new CompactProtocolReader(buffer, metaOffset);
  reader.structBegin();
  const meta: FileMeta = { leaves: [], numRows: 0, rowGroups: [] };
  for (;;) {
    const f = reader.readFieldBegin();
    if (f.isStop) break;
    if (f.fieldId === 2) {
      meta.leaves = readSchemaElements(reader);
    } else if (f.fieldId === 3) {
      meta.numRows = toSafeInt(reader.readZigzag64(), 'num_rows');
    } else if (f.fieldId === 4) {
      const { size } = reader.readListBegin();
      if (size > PARQUET_MAX_ROW_GROUPS) {
        throw new ParquetFormatError(`Unsupported Parquet file: ${size} row groups exceed the limit of ${PARQUET_MAX_ROW_GROUPS}`);
      }
      for (let rg = 0; rg < size; rg++) meta.rowGroups.push(readRowGroup(reader, meta.leaves.length));
    } else {
      reader.skip(f.type);
    }
  }
  reader.structEnd();
  return meta;
}

// ==========================================
// Pages
// ==========================================

function readPageHeader(buffer: Buffer, offset: number, column: string): PageHeader {
  const reader = new CompactProtocolReader(buffer, offset);
  reader.structBegin();
  const header: PageHeader = {
    type: PageType.DATA_PAGE,
    uncompressedSize: 0,
    compressedSize: 0,
    numValues: 0,
    numNulls: 0,
    numRows: 0,
    encoding: Encoding.PLAIN,
    // A data page that does not declare levels with RLE stores none (see decodeDataPage).
    definitionLevelEncoding: Encoding.PLAIN,
    definitionLevelsByteLength: 0,
    repetitionLevelsByteLength: 0,
    isCompressed: true,
    hasDataPageV2: false,
    headerEnd: 0,
  };
  let hasType = false;
  let hasUncompressed = false;
  let hasCompressed = false;
  for (;;) {
    const pf = reader.readFieldBegin();
    if (pf.isStop) break;
    if (pf.fieldId === 1) {
      header.type = reader.readZigzag32() as PageType;
      hasType = true;
    } else if (pf.fieldId === 2) {
      header.uncompressedSize = reader.readZigzag32();
      hasUncompressed = true;
    } else if (pf.fieldId === 3) {
      header.compressedSize = reader.readZigzag32();
      hasCompressed = true;
    } else if (pf.fieldId === 5 || pf.fieldId === 7) {
      reader.structBegin();
      for (;;) {
        const sub = reader.readFieldBegin();
        if (sub.isStop) break;
        if (sub.fieldId === 1) header.numValues = reader.readZigzag32();
        else if (sub.fieldId === 2) header.encoding = reader.readZigzag32();
        else if (sub.fieldId === 3 && pf.fieldId === 5) header.definitionLevelEncoding = reader.readZigzag32();
        else reader.skip(sub.type);
      }
      reader.structEnd();
    } else if (pf.fieldId === 8) {
      header.hasDataPageV2 = true;
      header.isCompressed = true;
      reader.structBegin();
      for (;;) {
        const sub = reader.readFieldBegin();
        if (sub.isStop) break;
        if (sub.fieldId === 1) header.numValues = reader.readZigzag32();
        else if (sub.fieldId === 2) header.numNulls = reader.readZigzag32();
        else if (sub.fieldId === 3) header.numRows = reader.readZigzag32();
        else if (sub.fieldId === 4) header.encoding = reader.readZigzag32();
        else if (sub.fieldId === 5) header.definitionLevelsByteLength = reader.readZigzag32();
        else if (sub.fieldId === 6) header.repetitionLevelsByteLength = reader.readZigzag32();
        else if (sub.fieldId === 7) header.isCompressed = sub.type === ThriftType.BOOL_TRUE;
        else reader.skip(sub.type);
      }
      reader.structEnd();
    } else {
      reader.skip(pf.type);
    }
  }
  reader.structEnd();
  header.headerEnd = reader.offset;
  const missing = [
    hasType ? '' : 'type',
    hasUncompressed ? '' : 'uncompressed_page_size',
    hasCompressed ? '' : 'compressed_page_size',
  ].filter((name) => name !== '');
  if (missing.length > 0) {
    throw new ParquetFormatError(`Corrupted Parquet file: page header is missing ${missing.join(', ')} in column '${column}'`);
  }
  return header;
}

/** Walks a chunk's page headers (no decompression) and charges their declared sizes to the budget. */
function scanChunkPages(buffer: Buffer, plan: ChunkPlan, decompressBudget: { remaining: number }): void {
  const { leaf, start, end } = plan;
  let offset = start;
  let dataValues = 0;
  while (offset < end) {
    const header = readPageHeader(buffer, offset, leaf.name);
    if ((header.type === PageType.DATA_PAGE_V2) !== header.hasDataPageV2) {
      throw new ParquetFormatError(`Corrupted Parquet file: mismatched data_page_header_v2 in column '${leaf.name}'`);
    }
    if (header.compressedSize < 0 || header.uncompressedSize < 0 || header.numValues < 0) {
      throw new ParquetFormatError(`Corrupted Parquet file: negative page size in column '${leaf.name}'`);
    }
    if (header.compressedSize === 0) {
      throw new ParquetFormatError(`Corrupted Parquet file: empty page in column '${leaf.name}'`);
    }
    if (header.uncompressedSize > PARQUET_MAX_PAGE_BYTES) {
      throw new ParquetFormatError(
        `Corrupted Parquet file: page of ${header.uncompressedSize} bytes exceeds the ${PARQUET_MAX_PAGE_BYTES} byte page limit in column '${leaf.name}'`
      );
    }
    if (header.type === PageType.DATA_PAGE_V2) {
      const levelBytes = header.definitionLevelsByteLength + header.repetitionLevelsByteLength;
      if (
        header.numNulls < 0 ||
        header.numNulls > header.numValues ||
        header.numRows < 0 ||
        header.definitionLevelsByteLength < 0 ||
        header.repetitionLevelsByteLength < 0 ||
        levelBytes > header.compressedSize ||
        levelBytes > header.uncompressedSize
      ) {
        throw new ParquetFormatError(`Corrupted Parquet file: invalid v2 page header in column '${leaf.name}'`);
      }
    }
    const bodyEnd = header.headerEnd + header.compressedSize;
    if (bodyEnd > end) {
      throw new ParquetFormatError(`Corrupted Parquet file: page of column '${leaf.name}' extends past its column chunk`);
    }
    decompressBudget.remaining -= header.uncompressedSize;
    if (decompressBudget.remaining < 0) {
      throw new ParquetFormatError(
        `Corrupted Parquet file: pages would decompress to more than ${PARQUET_MAX_TOTAL_DECOMPRESSED_BYTES} bytes in total`
      );
    }
    if (header.type === PageType.DATA_PAGE || header.type === PageType.DATA_PAGE_V2) {
      if (header.numValues === 0) {
        throw new ParquetFormatError(`Corrupted Parquet file: data page with no values in column '${leaf.name}'`);
      }
      dataValues += header.numValues;
    }
    plan.pages.push({ header, bodyStart: header.headerEnd, bodyEnd });
    offset = bodyEnd;
  }
  if (dataValues !== plan.rows) {
    throw new ParquetFormatError(
      `Corrupted Parquet file: column '${leaf.name}' holds ${dataValues} values for a row group of ${plan.rows} rows`
    );
  }
}

export interface Dictionary {
  values: ColumnValue[];
  /** UTF-8 bytes each entry costs per row that references it. */
  bytes: Uint32Array;
}

let scratchIndices = new Uint32Array(8192);

function isAllOnesRleLevels(buf: Uint8Array, start: number, end: number, count: number): boolean {
  const len = end - start;
  if (len < 2 || len > 5 || buf[end - 1] !== 1) return false;
  const b0 = buf[start];
  if ((b0 & 1) !== 0) return false;
  if (len === 2) return (b0 & 0x80) === 0 && b0 >>> 1 === count;
  if (len === 3) {
    const b1 = buf[start + 1];
    return (b0 & 0x80) !== 0 && (b1 & 0x80) === 0 && (((b0 & 0x7f) | (b1 << 7)) >>> 1) === count;
  }
  if (len === 4) {
    const b1 = buf[start + 1];
    const b2 = buf[start + 2];
    return (
      (b0 & 0x80) !== 0 &&
      (b1 & 0x80) !== 0 &&
      (b2 & 0x80) === 0 &&
      (((b0 & 0x7f) | ((b1 & 0x7f) << 7) | (b2 << 14)) >>> 1) === count
    );
  }
  const b1 = buf[start + 1];
  const b2 = buf[start + 2];
  const b3 = buf[start + 3];
  return (
    (b0 & 0x80) !== 0 &&
    (b1 & 0x80) !== 0 &&
    (b2 & 0x80) !== 0 &&
    (b3 & 0x80) === 0 &&
    (((b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x7f) << 14) | (b3 << 21)) >>> 1) === count
  );
}

export function minPlainBytes(type: ParquetType, width: number, count: number): number {
  if (type === ParquetType.BOOLEAN) return Math.ceil(count / BITS_PER_BYTE);
  if (type === ParquetType.FIXED_LEN_BYTE_ARRAY || type === ParquetType.INT96) return count * width;
  if (type === ParquetType.BYTE_ARRAY || type === ParquetType.INT32 || type === ParquetType.FLOAT) {
    return count * NARROW_VALUE_BYTES;
  }
  return count * WIDE_VALUE_BYTES;
}

/** Fails when a PLAIN page is too short to hold `count` values, so a hostile count cannot force a large allocation. */
export function assertPlainBytes(page: Buffer, start: number, leaf: LeafColumn, count: number): void {
  if (start + minPlainBytes(leaf.type, leaf.reader.width, count) > page.length) {
    throw new ParquetFormatError(`Corrupted Parquet file: truncated ${ParquetType[leaf.type].toLowerCase()} data in column '${leaf.name}'`);
  }
}

/** The little-endian signed 32-bit integer at `pos`. */
export function int32At(page: Uint8Array, pos: number): number {
  return page[pos] | (page[pos + 1] << 8) | (page[pos + 2] << 16) | (page[pos + 3] << 24);
}

/** The little-endian unsigned 32-bit integer at `pos`. */
export function uint32At(page: Uint8Array, pos: number): number {
  return int32At(page, pos) >>> 0;
}

/** A high word below 2^21 in magnitude: with any low word, the 64-bit integer is exact in a double. */
const SAFE_HIGH_WORD_BIAS = 0x00_1f_ff_ff;
const SAFE_HIGH_WORD_SPAN = 0x00_3f_ff_fe;

/** The little-endian signed 64-bit integer at `pos` when it is a safe integer; NaN otherwise. */
export function safeInt64At(page: Uint8Array, pos: number): number {
  const high = int32At(page, pos + NARROW_VALUE_BYTES);
  const approx = high * UINT32_RANGE + uint32At(page, pos);
  return (high + SAFE_HIGH_WORD_BIAS) >>> 0 <= SAFE_HIGH_WORD_SPAN || Number.isSafeInteger(approx) ? approx : Number.NaN;
}

function int64Value(page: Buffer, pos: number): number | string {
  const safe = safeInt64At(page, pos);
  return Number.isNaN(safe) ? page.readBigInt64LE(pos).toString() : safe;
}

/** The length of the BYTE_ARRAY value whose 4-byte prefix starts at `pos`. */
export function byteArrayLengthAt(page: Buffer, pos: number, leaf: LeafColumn): number {
  if (pos + BYTE_ARRAY_LENGTH_PREFIX_BYTES > page.length) {
    throw new ParquetFormatError(`Corrupted Parquet file: truncated string length in column '${leaf.name}'`);
  }
  return uint32At(page, pos);
}

/** Fails when a value of `length` bytes ending at `end` runs past the page. */
export function assertValueWithinPage(page: Buffer, end: number, length: number, leaf: LeafColumn): void {
  if (end > page.length) {
    throw new ParquetFormatError(`Corrupted Parquet file: string length ${length} exceeds page bounds in column '${leaf.name}'`);
  }
}

interface PlainRead {
  values: ColumnValue[];
  end: number;
  stringBytes: number;
}

function readPlainBooleans(page: Buffer, start: number, count: number): PlainRead {
  const values = new Array<ColumnValue>(count);
  for (let i = 0; i < count; i++) values[i] = ((page[start + (i >> 3)] >> (i & 7)) & 1) === 1;
  return { values, end: start + Math.ceil(count / BITS_PER_BYTE), stringBytes: 0 };
}

function readPlainByteArrays(page: Buffer, start: number, leaf: LeafColumn, count: number, byteLengths?: Uint32Array): PlainRead {
  const { width: fixedWidth, readSlice, map } = leaf.reader;
  const exactBytes = Boolean(leaf.reader.sliceByteLengthExact);
  const values = new Array<ColumnValue>(count);
  let pos = start;
  let stringBytes = 0;
  for (let i = 0; i < count; i++) {
    let len = fixedWidth;
    if (fixedWidth === 0) {
      len = byteArrayLengthAt(page, pos, leaf);
      pos += BYTE_ARRAY_LENGTH_PREFIX_BYTES;
    }
    const end = pos + len;
    assertValueWithinPage(page, end, len, leaf);
    const val = readSlice ? readSlice(page, pos, end) : (map as (raw: Buffer) => ColumnValue)(page.subarray(pos, end));
    values[i] = val;
    if (byteLengths) byteLengths[i] = byteLengthOf(val, len, exactBytes);
    stringBytes += len;
    pos = end;
  }
  return { values, end: pos, stringBytes };
}

function byteLengthOf(value: ColumnValue, sliceLength: number, exactBytes: boolean): number {
  if (exactBytes) return sliceLength;
  if (typeof value !== 'string') return 0;
  return value.length === sliceLength ? sliceLength : Buffer.byteLength(value, 'utf8');
}

function readPlainFloats(page: Buffer, start: number, leaf: LeafColumn, count: number): PlainRead {
  const wide = leaf.reader.kind === 'f64';
  const width = wide ? WIDE_VALUE_BYTES : NARROW_VALUE_BYTES;
  const view = new DataView(page.buffer, page.byteOffset, page.byteLength);
  const values = new Array<ColumnValue>(count);
  for (let i = 0, pos = start; i < count; i++, pos += width) {
    values[i] = wide ? view.getFloat64(pos, true) : view.getFloat32(pos, true);
  }
  return { values, end: start + count * width, stringBytes: 0 };
}

function readPlainInt32s(page: Buffer, start: number, leaf: LeafColumn, count: number): PlainRead {
  const { kind, map } = leaf.reader;
  const values = new Array<ColumnValue>(count);
  for (let i = 0, pos = start; i < count; i++, pos += NARROW_VALUE_BYTES) {
    if (kind === 'u32') values[i] = uint32At(page, pos);
    else values[i] = map ? map(int32At(page, pos)) : int32At(page, pos);
  }
  return { values, end: start + count * NARROW_VALUE_BYTES, stringBytes: 0 };
}

function readPlainInt64s(page: Buffer, start: number, leaf: LeafColumn, count: number): PlainRead {
  const { kind, map, mapNumber } = leaf.reader;
  const values = new Array<ColumnValue>(count);
  for (let i = 0, pos = start; i < count; i++, pos += WIDE_VALUE_BYTES) {
    if (kind === 'u64') {
      values[i] = unsignedInteger(page.readBigInt64LE(pos));
    } else if (map) {
      const safe = mapNumber ? safeInt64At(page, pos) : Number.NaN;
      values[i] = Number.isNaN(safe) ? map(page.readBigInt64LE(pos)) : (mapNumber as (raw: number) => ColumnValue)(safe);
    } else {
      values[i] = int64Value(page, pos);
    }
  }
  return { values, end: start + count * WIDE_VALUE_BYTES, stringBytes: 0 };
}

function readPlainValues(page: Buffer, start: number, leaf: LeafColumn, count: number, byteLengths?: Uint32Array): PlainRead {
  assertPlainBytes(page, start, leaf, count);
  switch (leaf.reader.kind) {
    case 'bool':
      return readPlainBooleans(page, start, count);
    case 'bytes':
      return readPlainByteArrays(page, start, leaf, count, byteLengths);
    case 'f64':
    case 'f32':
      return readPlainFloats(page, start, leaf, count);
    case 'i32':
    case 'u32':
      return readPlainInt32s(page, start, leaf, count);
    default:
      return readPlainInt64s(page, start, leaf, count);
  }
}

export function chargeValueBytes(budget: DecodeBudget, bytes: number): void {
  budget.valueBytes -= bytes;
  if (budget.valueBytes < 0) {
    throw new ParquetFormatError(
      `Corrupted Parquet file: decoded values exceed the limit of ${PARQUET_MAX_DECODED_VALUE_BYTES} bytes`
    );
  }
}

/** Decodes the RLE/bit-packed dictionary indices of a data page into a scratch array (valid until the next call). */
export function readDictionaryIndices(page: Buffer, pos: number, count: number, leaf: LeafColumn): Uint32Array {
  if (pos >= page.length) {
    throw new ParquetFormatError(`Corrupted Parquet file: truncated dictionary indices in column '${leaf.name}'`);
  }
  const bitWidth = page[pos];
  if (bitWidth > MAX_DICTIONARY_INDEX_BIT_WIDTH) {
    throw new ParquetFormatError(`Corrupted Parquet file: dictionary index bit width ${bitWidth} in column '${leaf.name}'`);
  }
  if (scratchIndices.length < count) {
    scratchIndices = new Uint32Array(Math.max(count, scratchIndices.length * 2));
  }
  decodeRleHybrid(page, pos + 1, page.length, bitWidth, count, scratchIndices);
  return scratchIndices;
}

/** Fails on a dictionary index past the end of the dictionary. */
export function assertDictionaryIndex(index: number, dictionaryLength: number, leaf: LeafColumn): void {
  if (index >= dictionaryLength) {
    throw new ParquetFormatError(
      `Corrupted Parquet file: dictionary index ${index} out of range (${dictionaryLength} entries) in column '${leaf.name}'`
    );
  }
}

function decodeDictionaryIndices(
  page: Buffer,
  pos: number,
  count: number,
  dictionary: Dictionary,
  leaf: LeafColumn,
  budget: DecodeBudget
): ColumnValue[] {
  if (count === 0) return [];
  const indices = readDictionaryIndices(page, pos, count, leaf);
  const dictValues = dictionary.values;
  const dictBytes = dictionary.bytes;
  const present = new Array<ColumnValue>(count);
  let referencedBytes = 0;
  for (let i = 0; i < count; i++) {
    const index = indices[i];
    assertDictionaryIndex(index, dictValues.length, leaf);
    referencedBytes += dictBytes[index];
    present[i] = dictValues[index];
  }
  // A dictionary string is materialized once per referencing row, so it is charged once per row.
  chargeValueBytes(budget, referencedBytes);
  return present;
}

function wrongTypeForEncoding(encoding: string, leaf: LeafColumn): ParquetFormatError {
  return new ParquetFormatError(`Corrupted Parquet file: ${encoding} on ${ParquetType[leaf.type]} column '${leaf.name}'`);
}

function decodeDeltaIntegers(page: Buffer, pos: number, nonNull: number, leaf: LeafColumn): ColumnValue[] {
  if (leaf.type !== ParquetType.INT32 && leaf.type !== ParquetType.INT64) throw wrongTypeForEncoding('DELTA_BINARY_PACKED', leaf);
  const bitWidthLimit = leaf.type === ParquetType.INT32 ? 32 : 64;
  const decoded = decodeDeltaBinaryPacked(page, pos, nonNull, bitWidthLimit, leaf.name);
  const { map, kind } = leaf.reader;
  const present = new Array<ColumnValue>(nonNull);
  for (let i = 0; i < nonNull; i++) {
    const raw = decoded.values[i];
    if (kind === 'i32') present[i] = map ? map(Number(raw)) : Number(raw);
    else if (kind === 'u32') present[i] = Number(BigInt.asUintN(32, raw));
    else if (kind === 'u64') present[i] = unsignedInteger(raw);
    else present[i] = map ? map(raw) : exactInteger(raw);
  }
  return present;
}

function mapByteSlices(slices: Buffer[], nonNull: number, leaf: LeafColumn): ColumnValue[] {
  const map = leaf.reader.map as (raw: Buffer) => ColumnValue;
  const present = new Array<ColumnValue>(nonNull);
  for (let i = 0; i < nonNull; i++) present[i] = map(slices[i]);
  return present;
}

function decodeDeltaLengthByteArrays(page: Buffer, pos: number, nonNull: number, leaf: LeafColumn, budget: DecodeBudget): ColumnValue[] {
  if (leaf.type !== ParquetType.BYTE_ARRAY) throw wrongTypeForEncoding('DELTA_LENGTH_BYTE_ARRAY', leaf);
  const decoded = decodeDeltaLengthByteArray(page, pos, nonNull, leaf.name, budget.valueBytes);
  chargeValueBytes(budget, decoded.totalBytes);
  return mapByteSlices(decoded.slices, nonNull, leaf);
}

function decodeDeltaByteArrays(page: Buffer, pos: number, nonNull: number, leaf: LeafColumn, budget: DecodeBudget): ColumnValue[] {
  if (leaf.type !== ParquetType.BYTE_ARRAY && leaf.type !== ParquetType.FIXED_LEN_BYTE_ARRAY) {
    throw wrongTypeForEncoding('DELTA_BYTE_ARRAY', leaf);
  }
  const decoded = decodeDeltaByteArray(page, pos, nonNull, leaf.name, budget.valueBytes, leaf.reader.width);
  chargeValueBytes(budget, decoded.totalBytes);
  return mapByteSlices(decoded.slices, nonNull, leaf);
}

/** Bytes of one value in a BYTE_STREAM_SPLIT stream. */
function byteStreamSplitWidth(leaf: LeafColumn): number {
  switch (leaf.type) {
    case ParquetType.FLOAT:
    case ParquetType.INT32:
      return NARROW_VALUE_BYTES;
    case ParquetType.DOUBLE:
    case ParquetType.INT64:
      return WIDE_VALUE_BYTES;
    case ParquetType.FIXED_LEN_BYTE_ARRAY:
      return leaf.typeLength;
    default:
      throw wrongTypeForEncoding('BYTE_STREAM_SPLIT', leaf);
  }
}

function decodeByteStreamSplitValues(page: Buffer, pos: number, nonNull: number, leaf: LeafColumn, budget: DecodeBudget): ColumnValue[] {
  const transposed = decodeByteStreamSplit(page, pos, nonNull, byteStreamSplitWidth(leaf), leaf.name);
  const plain = readPlainValues(transposed.buffer, 0, leaf, nonNull);
  chargeValueBytes(budget, plain.stringBytes);
  return plain.values;
}

export function decodeEncodedValues(
  page: Buffer,
  pos: number,
  nonNull: number,
  encoding: number,
  leaf: LeafColumn,
  dictionary: Dictionary | null,
  budget: DecodeBudget
): ColumnValue[] {
  if (DICTIONARY_DATA_ENCODINGS.has(encoding)) {
    if (!dictionary) {
      throw new ParquetFormatError(`Corrupted Parquet file: dictionary-encoded page without a dictionary in column '${leaf.name}'`);
    }
    return decodeDictionaryIndices(page, pos, nonNull, dictionary, leaf, budget);
  }
  switch (encoding) {
    case Encoding.PLAIN: {
      const plain = readPlainValues(page, pos, leaf, nonNull);
      chargeValueBytes(budget, plain.stringBytes);
      return plain.values;
    }
    case Encoding.RLE:
      if (leaf.type !== ParquetType.BOOLEAN) {
        throw new ParquetUnsupportedError(`Unsupported Parquet RLE value encoding on ${ParquetType[leaf.type]} column '${leaf.name}'`);
      }
      return decodeBooleanRle(page, pos, nonNull, leaf.name).values;
    case Encoding.DELTA_BINARY_PACKED:
      return decodeDeltaIntegers(page, pos, nonNull, leaf);
    case Encoding.DELTA_LENGTH_BYTE_ARRAY:
      return decodeDeltaLengthByteArrays(page, pos, nonNull, leaf, budget);
    case Encoding.DELTA_BYTE_ARRAY:
      return decodeDeltaByteArrays(page, pos, nonNull, leaf, budget);
    case Encoding.BYTE_STREAM_SPLIT:
      return decodeByteStreamSplitValues(page, pos, nonNull, leaf, budget);
    default:
      throw new ParquetUnsupportedError(`Unsupported Parquet value encoding ${encoding} in column '${leaf.name}'`);
  }
}

function assembleNulls(levels: Uint8Array | null, present: ColumnValue[], count: number, column: string): ColumnValue[] {
  if (!levels || present.length === count) return present;
  const out = new Array<ColumnValue>(count);
  let next = 0;
  for (let i = 0; i < count; i++) {
    if (levels[i] > MAX_DEFINITION_LEVEL) {
      throw new ParquetFormatError(`Corrupted Parquet file: definition level ${levels[i]} out of range in column '${column}'`);
    }
    out[i] = levels[i] === 1 ? present[next++] : null;
  }
  return out;
}

export interface PageLevels {
  /** Definition levels per value, or null when every value is present. */
  levels: Uint8Array | null;
  /** Values present (not null). */
  nonNull: number;
  /** Where the encoded values start in the page body. */
  pos: number;
}

/** Sums the presence levels of a page, failing on a level above the column's maximum. */
function countPresentLevels(levels: Uint8Array, count: number, leaf: LeafColumn): number {
  let present = 0;
  for (let i = 0; i < count; i++) {
    if (levels[i] > MAX_DEFINITION_LEVEL) {
      throw new ParquetFormatError(`Corrupted Parquet file: definition level ${levels[i]} out of range in column '${leaf.name}'`);
    }
    present += levels[i];
  }
  return present;
}

/** RLE-encoded definition levels behind a 4-byte length; null levels when every value is present. */
function readRleDefinitionLevels(page: Buffer, count: number, leaf: LeafColumn): { levels: Uint8Array | null; pos: number } {
  if (page.length < BYTE_ARRAY_LENGTH_PREFIX_BYTES) {
    throw new ParquetFormatError(`Corrupted Parquet file: truncated definition levels in column '${leaf.name}'`);
  }
  const levelEnd = BYTE_ARRAY_LENGTH_PREFIX_BYTES + page.readUInt32LE(0);
  if (levelEnd > page.length) {
    throw new ParquetFormatError(`Corrupted Parquet file: definition levels exceed page bounds in column '${leaf.name}'`);
  }
  if (isAllOnesRleLevels(page, BYTE_ARRAY_LENGTH_PREFIX_BYTES, levelEnd, count)) return { levels: null, pos: levelEnd };
  const levels = new Uint8Array(count);
  decodeRleHybrid(page, BYTE_ARRAY_LENGTH_PREFIX_BYTES, levelEnd, MAX_DEFINITION_LEVEL, count, levels);
  return { levels, pos: levelEnd };
}

export function decodeDataPageLevels(page: Buffer, header: PageHeader, leaf: LeafColumn, budget: DecodeBudget): PageLevels {
  const count = header.numValues;
  chargeValueBytes(budget, count * PARQUET_CELL_BYTES);
  // PLAIN levels are not a valid Parquet level encoding: older easyconvert files declared them but
  // wrote no level bytes, so every row holds a value.
  const hasLevels = leaf.repetition === FieldRepetitionType.OPTIONAL && header.definitionLevelEncoding !== Encoding.PLAIN;
  if (!hasLevels) return { levels: null, nonNull: count, pos: 0 };

  let levels: Uint8Array | null;
  let pos: number;
  if (header.definitionLevelEncoding === Encoding.RLE) {
    ({ levels, pos } = readRleDefinitionLevels(page, count, leaf));
  } else if (header.definitionLevelEncoding === Encoding.BIT_PACKED) {
    levels = new Uint8Array(count);
    pos = decodeBitPackedLevels(page, 0, MAX_DEFINITION_LEVEL, count, levels, leaf.name);
  } else {
    throw new ParquetUnsupportedError(
      `Unsupported Parquet definition level encoding ${header.definitionLevelEncoding} in column '${leaf.name}'`
    );
  }
  return { levels, nonNull: levels ? countPresentLevels(levels, count, leaf) : count, pos };
}

function decodeDataPage(
  page: Buffer,
  header: PageHeader,
  leaf: LeafColumn,
  dictionary: Dictionary | null,
  budget: DecodeBudget
): ColumnValue[] {
  const { levels, nonNull, pos } = decodeDataPageLevels(page, header, leaf, budget);
  const present = decodeEncodedValues(page, pos, nonNull, header.encoding, leaf, dictionary, budget);
  return assembleNulls(levels, present, header.numValues, leaf.name);
}

/** Definition levels of a v2 page (stored outside the compressed body), checked against the header's null count. */
function readV2DefinitionLevels(rawBody: Buffer, header: PageHeader, leaf: LeafColumn): Uint8Array | null {
  const count = header.numValues;
  const repBytes = header.repetitionLevelsByteLength;
  const levelBytes = repBytes + header.definitionLevelsByteLength;
  if (leaf.repetition !== FieldRepetitionType.OPTIONAL) {
    if (header.numNulls !== 0) {
      throw new ParquetFormatError(`Corrupted Parquet file: required column '${leaf.name}' declares ${header.numNulls} nulls`);
    }
    return null;
  }
  if (header.definitionLevelsByteLength > 0) {
    if (header.numNulls === 0 && isAllOnesRleLevels(rawBody, repBytes, levelBytes, count)) return null;
    const levels = new Uint8Array(count);
    decodeRleHybrid(rawBody, repBytes, levelBytes, MAX_DEFINITION_LEVEL, count, levels);
    return levels;
  }
  if (header.numNulls === count) return new Uint8Array(count);
  if (header.numNulls !== 0) {
    throw new ParquetFormatError(`Corrupted Parquet file: missing v2 definition levels in column '${leaf.name}'`);
  }
  return null;
}

/** The values section of a v2 page, decompressed when the header says it is compressed. */
function readV2ValuesPage(rawBody: Buffer, codec: CompressionCodec, header: PageHeader, leaf: LeafColumn): Buffer {
  const levelBytes = header.repetitionLevelsByteLength + header.definitionLevelsByteLength;
  const compressedValues = rawBody.subarray(levelBytes);
  const uncompressedValuesBytes = header.uncompressedSize - levelBytes;
  if (header.isCompressed && codec !== CompressionCodec.UNCOMPRESSED && uncompressedValuesBytes > 0) {
    return decompressPage(codec, compressedValues, uncompressedValuesBytes);
  }
  if (compressedValues.length !== uncompressedValuesBytes) {
    throw new ParquetFormatError(
      `Corrupted Parquet file: uncompressed v2 page body of ${compressedValues.length} bytes does not match declared ${uncompressedValuesBytes} bytes in column '${leaf.name}'`
    );
  }
  return compressedValues;
}

export function decodeDataPageV2LevelsAndValues(
  rawBody: Buffer,
  codec: CompressionCodec,
  header: PageHeader,
  leaf: LeafColumn,
  budget: DecodeBudget
): { levels: Uint8Array | null; nonNull: number; valuesPage: Buffer } {
  const count = header.numValues;
  chargeValueBytes(budget, count * PARQUET_CELL_BYTES);
  const levels = readV2DefinitionLevels(rawBody, header, leaf);
  let nonNull = count - header.numNulls;
  if (levels) {
    const present = countPresentLevels(levels, count, leaf);
    if (present !== nonNull) {
      throw new ParquetFormatError(
        `Corrupted Parquet file: v2 page header declares ${header.numNulls} nulls but levels contain ${count - present} in column '${leaf.name}'`
      );
    }
    nonNull = present;
  }
  return { levels, nonNull, valuesPage: readV2ValuesPage(rawBody, codec, header, leaf) };
}

function decodeDataPageV2(
  rawBody: Buffer,
  codec: CompressionCodec,
  header: PageHeader,
  leaf: LeafColumn,
  dictionary: Dictionary | null,
  budget: DecodeBudget
): ColumnValue[] {
  const { levels, nonNull, valuesPage } = decodeDataPageV2LevelsAndValues(rawBody, codec, header, leaf, budget);
  const present = decodeEncodedValues(valuesPage, 0, nonNull, header.encoding, leaf, dictionary, budget);
  return assembleNulls(levels, present, header.numValues, leaf.name);
}

/** The decompressed body of a dictionary page, after its encoding and entry count are checked. */
export function readDictionaryPageBody(buffer: Buffer, plan: ChunkPlan, page: ScannedPage): Buffer {
  const { header } = page;
  const body = decompressPageSlice(plan.chunk.codec, buffer, page.bodyStart, page.bodyEnd, header.uncompressedSize);
  if (header.encoding !== Encoding.PLAIN && header.encoding !== Encoding.PLAIN_DICTIONARY) {
    throw new ParquetUnsupportedError(`Unsupported Parquet dictionary encoding ${header.encoding} in column '${plan.leaf.name}'`);
  }
  if (header.numValues > PARQUET_MAX_ROWS) {
    throw new ParquetFormatError(`Corrupted Parquet file: dictionary of ${header.numValues} entries in column '${plan.leaf.name}'`);
  }
  return body;
}

function decodeChunk(buffer: Buffer, plan: ChunkPlan, budget: DecodeBudget): ColumnValue[] {
  const { chunk, leaf, rows } = plan;
  let values: ColumnValue[] | null = null;
  let dictionary: Dictionary | null = null;
  for (const page of plan.pages) {
    const { header } = page;
    if (header.type === PageType.INDEX_PAGE) continue;

    if (header.type === PageType.DICTIONARY_PAGE) {
      const body = readDictionaryPageBody(buffer, plan, page);
      const bytes = new Uint32Array(header.numValues);
      const plain = readPlainValues(body, 0, leaf, header.numValues, bytes);
      if (leaf.reader.kind !== 'bytes' && (leaf.reader.map !== null || leaf.reader.kind === 'i64' || leaf.reader.kind === 'u64')) {
        for (let i = 0; i < header.numValues; i++) {
          const entry = plain.values[i];
          bytes[i] = typeof entry === 'string' ? entry.length : 0;
        }
      }
      dictionary = { values: plain.values, bytes };
      continue;
    }
    if (header.type === PageType.DATA_PAGE) {
      const body = decompressPageSlice(chunk.codec, buffer, page.bodyStart, page.bodyEnd, header.uncompressedSize);
      const pageValues = decodeDataPage(body, header, leaf, dictionary, budget);
      if (!values) values = pageValues;
      else for (const value of pageValues) values.push(value);
      continue;
    }
    if (header.type === PageType.DATA_PAGE_V2) {
      const rawSlice = buffer.subarray(page.bodyStart, page.bodyEnd);
      const pageValues = decodeDataPageV2(rawSlice, chunk.codec, header, leaf, dictionary, budget);
      if (!values) values = pageValues;
      else for (const value of pageValues) values.push(value);
      continue;
    }
    throw new ParquetUnsupportedError(`Unsupported Parquet page type ${header.type} in column '${leaf.name}'`);
  }
  const resolved = values ?? [];
  if (resolved.length !== rows) {
    throw new ParquetFormatError(`Corrupted Parquet file: column '${leaf.name}' ends before all rows are present`);
  }
  return resolved;
}

// ==========================================
// File
// ==========================================

function chunkStart(chunk: ChunkMeta): number {
  const hasDictionary = chunk.dictionaryPageOffset > 0 && chunk.dictionaryPageOffset < chunk.dataPageOffset;
  if (hasDictionary) return chunk.dictionaryPageOffset;
  return chunk.dataPageOffset > 0 ? chunk.dataPageOffset : chunk.fileOffset;
}

/** Every row group must hold each schema column exactly once, with a chunk range inside the data section. */
function planChunks(meta: FileMeta, footerStart: number): ChunkPlan[] {
  const leafByName = new Map<string, LeafColumn>(meta.leaves.map((leaf) => [leaf.name, leaf]));
  const plans: ChunkPlan[] = [];
  for (const group of meta.rowGroups) {
    if (group.numRows === 0) continue;
    const seen = new Set<string>();
    for (const chunk of group.chunks) {
      const leaf = leafByName.get(chunk.path);
      if (!leaf) {
        throw new ParquetFormatError(`Corrupted Parquet metadata: column chunk '${chunk.path}' has no schema element`);
      }
      seen.add(chunk.path);
      if (chunk.type !== leaf.type) {
        throw new ParquetFormatError(`Corrupted Parquet metadata: column '${leaf.name}' chunk type differs from its schema type`);
      }
      if (chunk.numValues !== group.numRows) {
        throw new ParquetFormatError(
          `Corrupted Parquet metadata: column '${leaf.name}' declares ${chunk.numValues} values for a row group of ${group.numRows} rows`
        );
      }
      if (chunk.totalCompressedSize <= 0) {
        throw new ParquetFormatError(`Corrupted Parquet metadata: column '${leaf.name}' has no total_compressed_size`);
      }
      const start = chunkStart(chunk);
      const end = start + chunk.totalCompressedSize;
      if (start < MAGIC_BYTES || end > footerStart) {
        throw new ParquetFormatError(
          `Corrupted Parquet metadata: column '${leaf.name}' range ${start}-${end} is outside the data section`
        );
      }
      plans.push({ chunk, leaf, rows: group.numRows, start, end, pages: [] });
    }
    if (group.chunks.length !== meta.leaves.length || seen.size !== meta.leaves.length) {
      throw new ParquetFormatError('Corrupted Parquet metadata: every row group must hold each column exactly once');
    }
  }
  const byStart = [...plans].sort((a, b) => a.start - b.start);
  for (let i = 1; i < byStart.length; i++) {
    if (byStart[i].start < byStart[i - 1].end) {
      throw new ParquetFormatError(
        `Corrupted Parquet metadata: column chunks '${byStart[i - 1].leaf.name}' and '${byStart[i].leaf.name}' overlap`
      );
    }
  }
  return plans;
}

export interface DecodedParquetColumns {
  names: string[];
  columns: ColumnValue[][];
  numRows: number;
}

export function prepareParquetPlans(buffer: Buffer): { meta: FileMeta; plans: ChunkPlan[] } {
  if (buffer.length < MIN_FILE_BYTES) {
    throw new ParquetFormatError('Invalid Parquet file: buffer too small (minimum 12 bytes).');
  }

  const magicHeader = buffer.toString('ascii', 0, MAGIC_BYTES);
  const magicFooter = buffer.toString('ascii', buffer.length - MAGIC_BYTES, buffer.length);
  if (magicHeader !== PARQUET_MAGIC || magicFooter !== PARQUET_MAGIC) {
    throw new ParquetFormatError(
      `Invalid Parquet file: magic header='${magicHeader}', magic footer='${magicFooter}' (expected 'PAR1').`
    );
  }

  const metaLength = buffer.readUInt32LE(buffer.length - FOOTER_TRAILER_BYTES);
  if (metaLength <= 0) {
    throw new ParquetFormatError(
      `Corrupted Parquet metadata: invalid footer length ${metaLength} for buffer of ${buffer.length} bytes.`
    );
  }
  const metaOffset = buffer.length - FOOTER_TRAILER_BYTES - metaLength;
  if (metaOffset < MAGIC_BYTES) {
    throw new ParquetFormatError(`Corrupted Parquet metadata: metadata offset ${metaOffset} overlaps magic header.`);
  }
  if (metaLength > PARQUET_MAX_FOOTER_BYTES) {
    throw new ParquetFormatError(`Corrupted Parquet metadata: footer of ${metaLength} bytes exceeds ${PARQUET_MAX_FOOTER_BYTES}.`);
  }

  const meta = readFooter(buffer.subarray(0, metaOffset + metaLength), metaOffset);
  if (meta.numRows === 0) {
    return { meta, plans: [] };
  }
  if (meta.numRows > PARQUET_MAX_ROWS) {
    throw new ParquetFormatError(`Unsupported Parquet file: ${meta.numRows} rows exceed the limit of ${PARQUET_MAX_ROWS}.`);
  }
  if (meta.leaves.length === 0) {
    throw new ParquetFormatError('Corrupted Parquet metadata: rows are declared but the schema has no columns.');
  }
  if (meta.numRows * meta.leaves.length > PARQUET_MAX_CELLS) {
    throw new ParquetFormatError(`Unsupported Parquet file: table exceeds the limit of ${PARQUET_MAX_CELLS} cells.`);
  }
  const rowsInGroups = meta.rowGroups.reduce((sum, group) => sum + group.numRows, 0);
  if (rowsInGroups !== meta.numRows) {
    throw new ParquetFormatError(`Corrupted Parquet metadata: row groups hold ${rowsInGroups} rows but the file declares ${meta.numRows}.`);
  }
  for (const leaf of meta.leaves) {
    leaf.reader = resolveColumnReader(leaf.name, leaf.type, leaf.typeLength, leaf.annotation);
  }

  const plans = planChunks(meta, metaOffset);
  const decompressBudget = { remaining: PARQUET_MAX_TOTAL_DECOMPRESSED_BYTES };
  for (const plan of plans) scanChunkPages(buffer, plan, decompressBudget);
  return { meta, plans };
}

function decodeParquetColumnsUnguarded(buffer: Buffer): DecodedParquetColumns {
  const { meta, plans } = prepareParquetPlans(buffer);
  if (meta.numRows === 0) {
    return {
      names: meta.leaves.map((leaf) => leaf.name),
      columns: meta.leaves.map(() => []),
      numRows: 0,
    };
  }

  const budget: DecodeBudget = { valueBytes: PARQUET_MAX_DECODED_VALUE_BYTES };
  const columns = new Map<string, ColumnValue[]>();
  const writeOffsets = new Map<string, number>();
  const singleRowGroup = plans.length === meta.leaves.length;
  for (const plan of plans) {
    const values = decodeChunk(buffer, plan, budget);
    if (singleRowGroup) {
      columns.set(plan.leaf.name, values);
      continue;
    }
    const existing = columns.get(plan.leaf.name);
    if (existing) {
      const base = writeOffsets.get(plan.leaf.name) ?? 0;
      for (let i = 0; i < values.length; i++) existing[base + i] = values[i];
      writeOffsets.set(plan.leaf.name, base + values.length);
    } else {
      const col = new Array<ColumnValue>(meta.numRows);
      for (let i = 0; i < values.length; i++) col[i] = values[i];
      columns.set(plan.leaf.name, col);
      writeOffsets.set(plan.leaf.name, values.length);
    }
  }

  const names = meta.leaves.map((leaf) => leaf.name).filter((name) => columns.has(name));
  const columnValues = names.map((name) => columns.get(name) as ColumnValue[]);
  return { names, columns: columnValues, numRows: meta.numRows };
}

/**
 * Deserializes a flat Parquet file into column vectors in schema leaf order.
 */
export function decodeParquetColumns(buffer: Buffer): DecodedParquetColumns {
  try {
    return decodeParquetColumnsUnguarded(buffer);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new ParquetFormatError(`Unsupported Parquet file: the decoded table exceeds engine limits (${error.message})`);
    }
    throw error;
  }
}

const CHAR_ZERO = 0x30;
const CHAR_NINE = 0x39;

/** A column name that a plain record assignment would mangle: `__proto__`, or an array index, which reorders keys. */
function isUnsafeRecordKey(name: string): boolean {
  const first = name.codePointAt(0) ?? 0;
  return name === '__proto__' || (first >= CHAR_ZERO && first <= CHAR_NINE);
}

/**
 * Deserializes a flat Parquet file into row records. Integers beyond 2^53, decimals, dates, times and
 * timestamps are returned as exact strings; binary that is not UTF-8 text is returned as base64.
 */
export function decodeParquet(buffer: Buffer): Record<string, unknown>[] {
  try {
    const { names, columns: columnValues, numRows } = decodeParquetColumnsUnguarded(buffer);
    if (numRows === 0) return [];
    const needsSetOwn = names.some(isUnsafeRecordKey);
    const records: Record<string, unknown>[] = new Array<Record<string, unknown>>(numRows);
    for (let r = 0; r < numRows; r++) {
      const row: Record<string, ColumnValue> = {};
      if (needsSetOwn) {
        for (let c = 0; c < names.length; c++) {
          setOwn(row, names[c], columnValues[c][r] ?? null);
        }
      } else {
        for (let c = 0; c < names.length; c++) {
          row[names[c]] = columnValues[c][r] ?? null;
        }
      }
      records[r] = row;
    }
    return records;
  } catch (error) {
    // Allocation limits of the JS engine (array or string length) mean the table is too large to hold.
    if (error instanceof RangeError) {
      throw new ParquetFormatError(`Unsupported Parquet file: the decoded table exceeds engine limits (${error.message})`);
    }
    throw error;
  }
}
