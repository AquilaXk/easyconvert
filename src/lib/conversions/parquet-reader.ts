import { decompressPage } from './parquet-codec';
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
  resolveColumnReader,
  TimeUnit,
  unsignedInteger,
} from './parquet-logical';
import { decodeRleHybrid } from './parquet-rle';
import { CompactProtocolReader, ThriftType } from './parquet-thrift';

/**
 * Parquet reader for flat (non-nested) tables: PLAIN and dictionary encodings, RLE/bit-packed
 * definition levels, v1 data pages, UNCOMPRESSED/SNAPPY/GZIP/ZSTD pages, any number of row groups.
 *
 * Governing spec: Apache Parquet format (parquet.thrift, Encodings.md, LogicalTypes.md). Values keep
 * their exact meaning (see parquet-logical.ts); anything outside the supported scope (nested schemas,
 * v2 pages, INT96) throws a typed error rather than guessing.
 *
 * Untrusted-input bounds: column chunks must lie inside the data section and not overlap, page
 * headers are scanned and charged against one decompression budget before any page is decompressed,
 * and decoded cells are charged against a memory cap that counts a dictionary string once per row.
 */

const FOOTER_TRAILER_BYTES = 8;
const MAGIC_BYTES = 4;
const MIN_FILE_BYTES = 12;
const BITS_PER_BYTE = 8;
const BYTE_ARRAY_LENGTH_PREFIX_BYTES = 4;
const WIDE_VALUE_BYTES = 8;
const NARROW_VALUE_BYTES = 4;
const MAX_DEFINITION_LEVEL = 1;
const MAX_DICTIONARY_INDEX_BIT_WIDTH = 32;
const PROTO_KEY = '__proto__';
const UINT32_RANGE = 2 ** 32;

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
const LOGICAL_NAMES: Record<number, string> = { 2: 'MAP', 3: 'LIST', 11: 'UNKNOWN', 15: 'FLOAT16' };
const TIME_UNIT_BY_FIELD: Record<number, TimeUnit> = { 1: 'millis', 2: 'micros', 3: 'nanos' };

const DICTIONARY_DATA_ENCODINGS: ReadonlySet<number> = new Set([Encoding.PLAIN_DICTIONARY, Encoding.RLE_DICTIONARY]);

interface LeafColumn {
  name: string;
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

interface FileMeta {
  leaves: LeafColumn[];
  numRows: number;
  rowGroups: RowGroupMeta[];
}

interface PageHeader {
  type: PageType;
  uncompressedSize: number;
  compressedSize: number;
  numValues: number;
  encoding: number;
  definitionLevelEncoding: number;
  hasDataPageV2: boolean;
  headerEnd: number;
}

interface ScannedPage {
  header: PageHeader;
  bodyStart: number;
  bodyEnd: number;
}

interface ChunkPlan {
  chunk: ChunkMeta;
  leaf: LeafColumn;
  rows: number;
  start: number;
  end: number;
  pages: ScannedPage[];
}

interface DecodeBudget {
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
    leaves.push({ name, type, repetition, typeLength, annotation, reader: { kind: 'bytes', width: 0, map: null } });
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
    encoding: Encoding.PLAIN,
    // A data page that does not declare levels with RLE stores none (see decodeDataPage).
    definitionLevelEncoding: Encoding.PLAIN,
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
    } else {
      if (pf.fieldId === 8) header.hasDataPageV2 = true;
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
    if (header.hasDataPageV2 || header.type === PageType.DATA_PAGE_V2) {
      throw new ParquetUnsupportedError(`Unsupported Parquet data page version 2 in column '${leaf.name}'`);
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
    if (header.type === PageType.DATA_PAGE) {
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

interface Dictionary {
  values: ColumnValue[];
  /** UTF-8 bytes each entry costs per row that references it. */
  bytes: Uint32Array;
}

function minPlainBytes(type: ParquetType, width: number, count: number): number {
  if (type === ParquetType.BOOLEAN) return Math.ceil(count / BITS_PER_BYTE);
  if (type === ParquetType.FIXED_LEN_BYTE_ARRAY) return count * width;
  if (type === ParquetType.BYTE_ARRAY || type === ParquetType.INT32 || type === ParquetType.FLOAT) {
    return count * NARROW_VALUE_BYTES;
  }
  return count * WIDE_VALUE_BYTES;
}

function int64Value(page: Buffer, pos: number): number | string {
  const high = page.readInt32LE(pos + NARROW_VALUE_BYTES);
  const low = page.readUInt32LE(pos);
  const approx = high * UINT32_RANGE + low;
  return Number.isSafeInteger(approx) ? approx : page.readBigInt64LE(pos).toString();
}

function readPlainValues(
  page: Buffer,
  start: number,
  leaf: LeafColumn,
  count: number
): { values: ColumnValue[]; end: number; stringBytes: number } {
  const reader = leaf.reader;
  const type = leaf.type;
  const fixedWidth = type === ParquetType.FIXED_LEN_BYTE_ARRAY ? leaf.typeLength : 0;
  // Every value occupies at least this many bytes, so a hostile count cannot force a large allocation.
  if (start + minPlainBytes(type, fixedWidth, count) > page.length) {
    throw new ParquetFormatError(`Corrupted Parquet file: truncated ${ParquetType[type].toLowerCase()} data in column '${leaf.name}'`);
  }
  const values: ColumnValue[] = new Array<ColumnValue>(count);
  let pos = start;
  let stringBytes = 0;
  const map = reader.map;

  if (reader.kind === 'bool') {
    for (let i = 0; i < count; i++) values[i] = ((page[pos + (i >> 3)] >> (i & 7)) & 1) === 1;
    return { values, end: pos + Math.ceil(count / BITS_PER_BYTE), stringBytes };
  }
  if (reader.kind === 'bytes') {
    for (let i = 0; i < count; i++) {
      let len = fixedWidth;
      if (fixedWidth === 0) {
        if (pos + BYTE_ARRAY_LENGTH_PREFIX_BYTES > page.length) {
          throw new ParquetFormatError(`Corrupted Parquet file: truncated string length in column '${leaf.name}'`);
        }
        len = page.readUInt32LE(pos);
        pos += BYTE_ARRAY_LENGTH_PREFIX_BYTES;
      }
      if (pos + len > page.length) {
        throw new ParquetFormatError(`Corrupted Parquet file: string length ${len} exceeds page bounds in column '${leaf.name}'`);
      }
      const slice = page.subarray(pos, pos + len);
      values[i] = (map as (raw: Buffer) => ColumnValue)(slice);
      stringBytes += len;
      pos += len;
    }
    return { values, end: pos, stringBytes };
  }

  const width = reader.kind === 'i64' || reader.kind === 'u64' || reader.kind === 'f64' ? WIDE_VALUE_BYTES : NARROW_VALUE_BYTES;
  for (let i = 0; i < count; i++) {
    if (reader.kind === 'f64') {
      values[i] = page.readDoubleLE(pos);
    } else if (reader.kind === 'f32') {
      values[i] = page.readFloatLE(pos);
    } else if (reader.kind === 'i32') {
      const raw = page.readInt32LE(pos);
      values[i] = map ? (map(raw) as ColumnValue) : raw;
    } else if (reader.kind === 'u32') {
      values[i] = page.readUInt32LE(pos);
    } else if (reader.kind === 'u64') {
      values[i] = unsignedInteger(page.readBigInt64LE(pos));
    } else if (map) {
      values[i] = map(page.readBigInt64LE(pos));
    } else {
      values[i] = int64Value(page, pos);
    }
    pos += width;
  }
  return { values, end: pos, stringBytes };
}

function chargeValueBytes(budget: DecodeBudget, bytes: number): void {
  budget.valueBytes -= bytes;
  if (budget.valueBytes < 0) {
    throw new ParquetFormatError(
      `Corrupted Parquet file: decoded values exceed the limit of ${PARQUET_MAX_DECODED_VALUE_BYTES} bytes`
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
  if (pos >= page.length) {
    throw new ParquetFormatError(`Corrupted Parquet file: truncated dictionary indices in column '${leaf.name}'`);
  }
  const bitWidth = page[pos++];
  if (bitWidth > MAX_DICTIONARY_INDEX_BIT_WIDTH) {
    throw new ParquetFormatError(`Corrupted Parquet file: dictionary index bit width ${bitWidth} in column '${leaf.name}'`);
  }
  const indices = new Uint32Array(count);
  decodeRleHybrid(page, pos, page.length, bitWidth, count, indices);
  let referencedBytes = 0;
  for (let i = 0; i < count; i++) {
    const index = indices[i];
    if (index >= dictionary.values.length) {
      throw new ParquetFormatError(
        `Corrupted Parquet file: dictionary index ${index} out of range (${dictionary.values.length} entries) in column '${leaf.name}'`
      );
    }
    referencedBytes += dictionary.bytes[index];
  }
  // A dictionary string is materialized once per referencing row, so it is charged once per row.
  chargeValueBytes(budget, referencedBytes);
  const present = new Array<ColumnValue>(count);
  for (let i = 0; i < count; i++) present[i] = dictionary.values[indices[i]];
  return present;
}

function decodeDataPage(
  page: Buffer,
  header: PageHeader,
  leaf: LeafColumn,
  dictionary: Dictionary | null,
  budget: DecodeBudget
): ColumnValue[] {
  const count = header.numValues;
  chargeValueBytes(budget, count * PARQUET_CELL_BYTES);
  const optional = leaf.repetition === FieldRepetitionType.OPTIONAL;
  let pos = 0;
  let levels: Uint8Array | null = null;
  // PLAIN levels are not a valid Parquet level encoding: older easyconvert files declared them but
  // wrote no level bytes, so every row holds a value.
  const legacyLayout = optional && header.definitionLevelEncoding === Encoding.PLAIN;
  if (optional && !legacyLayout) {
    if (header.definitionLevelEncoding !== Encoding.RLE) {
      throw new ParquetUnsupportedError(
        `Unsupported Parquet definition level encoding ${header.definitionLevelEncoding} in column '${leaf.name}'`
      );
    }
    if (page.length < BYTE_ARRAY_LENGTH_PREFIX_BYTES) {
      throw new ParquetFormatError(`Corrupted Parquet file: truncated definition levels in column '${leaf.name}'`);
    }
    const levelBytes = page.readUInt32LE(0);
    const levelEnd = BYTE_ARRAY_LENGTH_PREFIX_BYTES + levelBytes;
    if (levelEnd > page.length) {
      throw new ParquetFormatError(`Corrupted Parquet file: definition levels exceed page bounds in column '${leaf.name}'`);
    }
    levels = new Uint8Array(count);
    decodeRleHybrid(page, BYTE_ARRAY_LENGTH_PREFIX_BYTES, levelEnd, MAX_DEFINITION_LEVEL, count, levels);
    pos = levelEnd;
  }

  let nonNull = count;
  if (levels) {
    nonNull = 0;
    for (let i = 0; i < count; i++) {
      if (levels[i] > MAX_DEFINITION_LEVEL) {
        throw new ParquetFormatError(`Corrupted Parquet file: definition level ${levels[i]} out of range in column '${leaf.name}'`);
      }
      nonNull += levels[i];
    }
  }

  let present: ColumnValue[];
  if (DICTIONARY_DATA_ENCODINGS.has(header.encoding)) {
    if (!dictionary) {
      throw new ParquetFormatError(`Corrupted Parquet file: dictionary-encoded page without a dictionary in column '${leaf.name}'`);
    }
    present = decodeDictionaryIndices(page, pos, nonNull, dictionary, leaf, budget);
  } else if (header.encoding === Encoding.PLAIN) {
    const plain = readPlainValues(page, pos, leaf, nonNull);
    chargeValueBytes(budget, plain.stringBytes);
    present = plain.values;
  } else {
    throw new ParquetUnsupportedError(`Unsupported Parquet value encoding ${header.encoding} in column '${leaf.name}'`);
  }

  if (!levels) return present;
  const out = new Array<ColumnValue>(count);
  let next = 0;
  for (let i = 0; i < count; i++) out[i] = levels[i] === 1 ? present[next++] : null;
  return out;
}

function decodeChunk(buffer: Buffer, plan: ChunkPlan, budget: DecodeBudget): ColumnValue[] {
  const { chunk, leaf, rows } = plan;
  const values: ColumnValue[] = [];
  let dictionary: Dictionary | null = null;
  for (const page of plan.pages) {
    const { header } = page;
    if (header.type === PageType.INDEX_PAGE) continue;
    const body = decompressPage(chunk.codec, buffer.subarray(page.bodyStart, page.bodyEnd), header.uncompressedSize);

    if (header.type === PageType.DICTIONARY_PAGE) {
      if (header.encoding !== Encoding.PLAIN && header.encoding !== Encoding.PLAIN_DICTIONARY) {
        throw new ParquetUnsupportedError(`Unsupported Parquet dictionary encoding ${header.encoding} in column '${leaf.name}'`);
      }
      if (header.numValues > PARQUET_MAX_ROWS) {
        throw new ParquetFormatError(`Corrupted Parquet file: dictionary of ${header.numValues} entries in column '${leaf.name}'`);
      }
      const plain = readPlainValues(body, 0, leaf, header.numValues);
      const bytes = new Uint32Array(header.numValues);
      for (let i = 0; i < header.numValues; i++) {
        const entry = plain.values[i];
        bytes[i] = typeof entry === 'string' ? Buffer.byteLength(entry, 'utf8') : 0;
      }
      dictionary = { values: plain.values, bytes };
      continue;
    }
    if (header.type !== PageType.DATA_PAGE) {
      throw new ParquetUnsupportedError(`Unsupported Parquet page type ${header.type} in column '${leaf.name}'`);
    }
    const pageValues = decodeDataPage(body, header, leaf, dictionary, budget);
    for (let i = 0; i < pageValues.length; i++) values.push(pageValues[i]);
  }
  if (values.length !== rows) {
    throw new ParquetFormatError(`Corrupted Parquet file: column '${leaf.name}' ends before all rows are present`);
  }
  return values;
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

function decodeParquetUnguarded(buffer: Buffer): Record<string, unknown>[] {
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
  if (meta.numRows === 0) return [];
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

  const budget: DecodeBudget = { valueBytes: PARQUET_MAX_DECODED_VALUE_BYTES };
  const columns = new Map<string, ColumnValue[]>();
  for (const plan of plans) {
    const values = decodeChunk(buffer, plan, budget);
    const existing = columns.get(plan.leaf.name);
    if (existing) {
      for (let i = 0; i < values.length; i++) existing.push(values[i]);
    } else {
      columns.set(plan.leaf.name, values);
    }
  }

  const names = meta.leaves.map((leaf) => leaf.name).filter((name) => columns.has(name));
  const columnValues = names.map((name) => columns.get(name) as ColumnValue[]);
  const records: Record<string, unknown>[] = new Array<Record<string, unknown>>(meta.numRows);
  for (let r = 0; r < meta.numRows; r++) {
    const row: Record<string, unknown> = {};
    for (let c = 0; c < names.length; c++) {
      const value = columnValues[c][r] ?? null;
      if (names[c] === PROTO_KEY) {
        // A column named __proto__ must stay a data property, never rewrite the row's prototype.
        Object.defineProperty(row, PROTO_KEY, { value, enumerable: true, writable: true, configurable: true });
      } else {
        row[names[c]] = value;
      }
    }
    records[r] = row;
  }
  return records;
}

/**
 * Deserializes a flat Parquet file into row records. Integers beyond 2^53, decimals, dates, times and
 * timestamps are returned as exact strings; binary that is not UTF-8 text is returned as base64.
 */
export function decodeParquet(buffer: Buffer): Record<string, unknown>[] {
  try {
    return decodeParquetUnguarded(buffer);
  } catch (error) {
    // Allocation limits of the JS engine (array or string length) mean the table is too large to hold.
    if (error instanceof RangeError) {
      throw new ParquetFormatError(`Unsupported Parquet file: the decoded table exceeds engine limits (${error.message})`);
    }
    throw error;
  }
}
