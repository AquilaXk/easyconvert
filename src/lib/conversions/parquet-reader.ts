import { decompressPage } from './parquet-codec';
import {
  CompressionCodec,
  Encoding,
  FieldRepetitionType,
  PageType,
  PARQUET_MAGIC,
  PARQUET_MAX_CELLS,
  PARQUET_MAX_COLUMNS,
  PARQUET_MAX_FOOTER_BYTES,
  PARQUET_MAX_PAGE_BYTES,
  PARQUET_MAX_ROW_GROUPS,
  PARQUET_MAX_ROWS,
  ParquetFormatError,
  ParquetType,
} from './parquet-format';
import { decodeRleHybrid } from './parquet-rle';
import { CompactProtocolReader, ThriftType } from './parquet-thrift';

/**
 * Parquet reader for flat (non-nested) tables: PLAIN and dictionary encodings, RLE/bit-packed
 * definition levels, v1 data pages, UNCOMPRESSED/SNAPPY/GZIP/ZSTD pages, any number of row groups.
 *
 * Governing spec: Apache Parquet format (parquet.thrift, Encodings.md). Anything outside that scope
 * (nested schemas, v2 pages, INT96, FIXED_LEN_BYTE_ARRAY) throws a typed error rather than guessing.
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

const DICTIONARY_DATA_ENCODINGS: ReadonlySet<number> = new Set([Encoding.PLAIN_DICTIONARY, Encoding.RLE_DICTIONARY]);

interface LeafColumn {
  name: string;
  type: ParquetType;
  repetition: FieldRepetitionType;
}

interface ChunkMeta {
  path: string;
  type: ParquetType;
  codec: CompressionCodec;
  numValues: number;
  dataPageOffset: number;
  dictionaryPageOffset: number;
  fileOffset: number;
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

function toSafeInt(value: bigint, what: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ParquetFormatError(`Corrupted Parquet metadata: ${what} ${value} is out of range`);
  }
  return Number(value);
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
    for (;;) {
      const f = reader.readFieldBegin();
      if (f.isStop) break;
      if (f.fieldId === 1) type = reader.readZigzag32() as ParquetType;
      else if (f.fieldId === 3) repetition = reader.readZigzag32() as FieldRepetitionType;
      else if (f.fieldId === 4) name = reader.readString();
      else if (f.fieldId === 5) numChildren = reader.readZigzag32();
      else reader.skip(f.type);
    }
    reader.structEnd();
    if (i === 0) {
      if (numChildren !== size - 1) {
        throw new ParquetFormatError('Unsupported Parquet schema: nested columns are not supported');
      }
      continue;
    }
    if (numChildren > 0 || type === undefined) {
      throw new ParquetFormatError(`Unsupported Parquet schema: column '${name}' is a nested group`);
    }
    if (repetition === FieldRepetitionType.REPEATED) {
      throw new ParquetFormatError(`Unsupported Parquet schema: column '${name}' is repeated`);
    }
    leaves.push({ name, type, repetition });
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
        throw new ParquetFormatError('Unsupported Parquet schema: nested column paths are not supported');
      }
      chunk.path = parts[0];
    } else if (mf.fieldId === 4) {
      chunk.codec = reader.readZigzag32() as CompressionCodec;
    } else if (mf.fieldId === 5) {
      chunk.numValues = toSafeInt(reader.readZigzag64(), 'num_values');
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

function readPageHeader(buffer: Buffer, offset: number): PageHeader {
  const reader = new CompactProtocolReader(buffer, offset);
  reader.structBegin();
  const header: PageHeader = {
    type: PageType.DATA_PAGE,
    uncompressedSize: 0,
    compressedSize: 0,
    numValues: 0,
    encoding: Encoding.PLAIN,
    // A data page that does not declare levels with RLE/BIT_PACKED stores none (see decodeDataPage).
    definitionLevelEncoding: Encoding.PLAIN,
    hasDataPageV2: false,
    headerEnd: 0,
  };
  for (;;) {
    const pf = reader.readFieldBegin();
    if (pf.isStop) break;
    if (pf.fieldId === 1) {
      header.type = reader.readZigzag32() as PageType;
    } else if (pf.fieldId === 2) {
      header.uncompressedSize = reader.readZigzag32();
    } else if (pf.fieldId === 3) {
      header.compressedSize = reader.readZigzag32();
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
      reader.skip(pf.type);
    } else {
      reader.skip(pf.type);
    }
  }
  reader.structEnd();
  header.headerEnd = reader.offset;
  return header;
}

type ColumnValue = string | number | boolean | null;

interface Dictionary {
  values: ColumnValue[];
}

function minPlainBytes(type: ParquetType, count: number): number {
  if (type === ParquetType.BOOLEAN) return Math.ceil(count / BITS_PER_BYTE);
  if (type === ParquetType.BYTE_ARRAY || type === ParquetType.INT32 || type === ParquetType.FLOAT) {
    return count * NARROW_VALUE_BYTES;
  }
  if (type === ParquetType.INT64 || type === ParquetType.DOUBLE) return count * WIDE_VALUE_BYTES;
  return 0;
}

function readPlainValues(
  page: Buffer,
  start: number,
  type: ParquetType,
  count: number,
  column: string,
  legacyBooleans: boolean
): { values: ColumnValue[]; end: number } {
  // Every value occupies at least this many bytes, so a hostile count cannot force a large allocation.
  if (start + minPlainBytes(type, count) > page.length) {
    throw new ParquetFormatError(`Corrupted Parquet file: truncated ${ParquetType[type]?.toLowerCase() ?? 'value'} data in column '${column}'`);
  }
  const values: ColumnValue[] = new Array<ColumnValue>(count);
  let pos = start;
  if (type === ParquetType.BOOLEAN) {
    const packedBytes = Math.ceil(count / BITS_PER_BYTE);
    // Files written before the writer used spec-conformant levels may store one byte per boolean.
    const looseBytes = legacyBooleans && page.length - start >= count && page.length - start !== packedBytes;
    if (looseBytes) {
      for (let i = 0; i < count; i++) values[i] = page[pos++] !== 0;
      return { values, end: pos };
    }
    if (pos + packedBytes > page.length) {
      throw new ParquetFormatError(`Corrupted Parquet file: truncated boolean data in column '${column}'`);
    }
    for (let i = 0; i < count; i++) values[i] = ((page[pos + (i >> 3)] >> (i & 7)) & 1) === 1;
    return { values, end: pos + packedBytes };
  }
  if (type === ParquetType.BYTE_ARRAY) {
    for (let i = 0; i < count; i++) {
      if (pos + BYTE_ARRAY_LENGTH_PREFIX_BYTES > page.length) {
        throw new ParquetFormatError(`Corrupted Parquet file: truncated string length in column '${column}'`);
      }
      const len = page.readUInt32LE(pos);
      pos += BYTE_ARRAY_LENGTH_PREFIX_BYTES;
      if (pos + len > page.length) {
        throw new ParquetFormatError(`Corrupted Parquet file: string length ${len} exceeds page bounds in column '${column}'`);
      }
      values[i] = page.toString('utf-8', pos, pos + len);
      pos += len;
    }
    return { values, end: pos };
  }
  const width = type === ParquetType.DOUBLE || type === ParquetType.INT64 ? WIDE_VALUE_BYTES : NARROW_VALUE_BYTES;
  if (type !== ParquetType.DOUBLE && type !== ParquetType.INT64 && type !== ParquetType.INT32 && type !== ParquetType.FLOAT) {
    throw new ParquetFormatError(`Unsupported Parquet physical type ${ParquetType[type] ?? type} in column '${column}'`);
  }
  if (pos + count * width > page.length) {
    throw new ParquetFormatError(`Corrupted Parquet file: truncated ${ParquetType[type].toLowerCase()} value in column '${column}'`);
  }
  for (let i = 0; i < count; i++) {
    if (type === ParquetType.DOUBLE) values[i] = page.readDoubleLE(pos);
    else if (type === ParquetType.INT64) values[i] = Number(page.readBigInt64LE(pos));
    else if (type === ParquetType.FLOAT) values[i] = page.readFloatLE(pos);
    else values[i] = page.readInt32LE(pos);
    pos += width;
  }
  return { values, end: pos };
}

function decodeDataPage(
  page: Buffer,
  header: PageHeader,
  leaf: LeafColumn,
  dictionary: Dictionary | null
): ColumnValue[] {
  const count = header.numValues;
  const optional = leaf.repetition === FieldRepetitionType.OPTIONAL;
  let pos = 0;
  let levels: Uint8Array | null = null;
  // PLAIN levels are not a valid Parquet level encoding: older easyconvert files declared them but
  // wrote no level bytes, so every row holds a value.
  const legacyLayout = optional && header.definitionLevelEncoding === Encoding.PLAIN;
  if (optional && !legacyLayout) {
    if (header.definitionLevelEncoding !== Encoding.RLE) {
      throw new ParquetFormatError(
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
    if (pos >= page.length && nonNull > 0) {
      throw new ParquetFormatError(`Corrupted Parquet file: truncated dictionary indices in column '${leaf.name}'`);
    }
    const bitWidth = nonNull > 0 ? page[pos++] : 0;
    if (bitWidth > MAX_DICTIONARY_INDEX_BIT_WIDTH) {
      throw new ParquetFormatError(`Corrupted Parquet file: dictionary index bit width ${bitWidth} in column '${leaf.name}'`);
    }
    const indices = new Uint32Array(nonNull);
    if (nonNull > 0) decodeRleHybrid(page, pos, page.length, bitWidth, nonNull, indices);
    present = new Array<ColumnValue>(nonNull);
    for (let i = 0; i < nonNull; i++) {
      if (indices[i] >= dictionary.values.length) {
        throw new ParquetFormatError(
          `Corrupted Parquet file: dictionary index ${indices[i]} out of range (${dictionary.values.length} entries) in column '${leaf.name}'`
        );
      }
      present[i] = dictionary.values[indices[i]];
    }
  } else if (header.encoding === Encoding.PLAIN) {
    present = readPlainValues(page, pos, leaf.type, nonNull, leaf.name, legacyLayout).values;
  } else {
    throw new ParquetFormatError(`Unsupported Parquet value encoding ${header.encoding} in column '${leaf.name}'`);
  }

  if (!levels) return present;
  const out = new Array<ColumnValue>(count);
  let next = 0;
  for (let i = 0; i < count; i++) out[i] = levels[i] === 1 ? present[next++] : null;
  return out;
}

function decodeChunk(
  buffer: Buffer,
  footerStart: number,
  chunk: ChunkMeta,
  leaf: LeafColumn,
  expectedRows: number
): ColumnValue[] {
  if (chunk.type !== leaf.type) {
    throw new ParquetFormatError(`Corrupted Parquet metadata: column '${leaf.name}' chunk type differs from its schema type`);
  }
  if (chunk.numValues !== expectedRows) {
    throw new ParquetFormatError(
      `Corrupted Parquet metadata: column '${leaf.name}' declares ${chunk.numValues} values for a row group of ${expectedRows} rows`
    );
  }
  let offset = chunk.dictionaryPageOffset > 0 ? chunk.dictionaryPageOffset : chunk.dataPageOffset;
  if (offset <= 0) offset = chunk.fileOffset;
  if (offset < MAGIC_BYTES || offset >= footerStart) {
    throw new ParquetFormatError(`Corrupted Parquet metadata: page offset ${offset} of column '${leaf.name}' is outside the data section`);
  }

  const values: ColumnValue[] = [];
  let dictionary: Dictionary | null = null;
  while (values.length < expectedRows) {
    if (offset >= footerStart) {
      throw new ParquetFormatError(`Corrupted Parquet file: column '${leaf.name}' ends before all rows are present`);
    }
    const header = readPageHeader(buffer, offset);
    if (header.hasDataPageV2 || header.type === PageType.DATA_PAGE_V2) {
      throw new ParquetFormatError(`Unsupported Parquet data page version 2 in column '${leaf.name}'`);
    }
    if (
      header.compressedSize < 0 ||
      header.uncompressedSize < 0 ||
      header.uncompressedSize > PARQUET_MAX_PAGE_BYTES ||
      header.numValues < 0
    ) {
      throw new ParquetFormatError(`Corrupted Parquet file: invalid page sizes in column '${leaf.name}'`);
    }
    const bodyEnd = header.headerEnd + header.compressedSize;
    if (bodyEnd > footerStart) {
      throw new ParquetFormatError(`Corrupted Parquet file: page of column '${leaf.name}' extends past the data section`);
    }
    offset = bodyEnd;
    if (header.type === PageType.INDEX_PAGE) continue;
    const body = decompressPage(chunk.codec, buffer.subarray(header.headerEnd, bodyEnd), header.uncompressedSize);

    if (header.type === PageType.DICTIONARY_PAGE) {
      if (header.encoding !== Encoding.PLAIN && header.encoding !== Encoding.PLAIN_DICTIONARY) {
        throw new ParquetFormatError(`Unsupported Parquet dictionary encoding ${header.encoding} in column '${leaf.name}'`);
      }
      if (header.numValues > PARQUET_MAX_ROWS) {
        throw new ParquetFormatError(`Corrupted Parquet file: dictionary of ${header.numValues} entries in column '${leaf.name}'`);
      }
      dictionary = { values: readPlainValues(body, 0, leaf.type, header.numValues, leaf.name, false).values };
      continue;
    }
    if (header.type !== PageType.DATA_PAGE) {
      throw new ParquetFormatError(`Unsupported Parquet page type ${header.type} in column '${leaf.name}'`);
    }
    if (values.length + header.numValues > expectedRows) {
      throw new ParquetFormatError(`Corrupted Parquet file: column '${leaf.name}' holds more values than its row group`);
    }
    const pageValues = decodeDataPage(body, header, leaf, dictionary);
    for (let i = 0; i < pageValues.length; i++) values.push(pageValues[i]);
  }
  return values;
}

/**
 * Deserializes a flat Parquet file into row records. Columns the file omits are absent from the rows.
 */
export function decodeParquet(buffer: Buffer): Record<string, unknown>[] {
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

  const meta = readFooter(buffer, metaOffset);
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

  const leafByName = new Map<string, LeafColumn>(meta.leaves.map((leaf) => [leaf.name, leaf]));
  const columns = new Map<string, ColumnValue[]>();
  let rowsSeen = 0;
  for (const group of meta.rowGroups) {
    rowsSeen += group.numRows;
    for (const chunk of group.chunks) {
      const leaf = leafByName.get(chunk.path);
      if (!leaf) {
        throw new ParquetFormatError(`Corrupted Parquet metadata: column chunk '${chunk.path}' has no schema element`);
      }
      const values = decodeChunk(buffer, metaOffset, chunk, leaf, group.numRows);
      const existing = columns.get(leaf.name);
      if (existing) {
        for (let i = 0; i < values.length; i++) existing.push(values[i]);
      } else {
        columns.set(leaf.name, values);
      }
    }
  }
  if (rowsSeen !== meta.numRows) {
    throw new ParquetFormatError(`Corrupted Parquet metadata: row groups hold ${rowsSeen} rows but the file declares ${meta.numRows}.`);
  }

  const names = Array.from(columns.keys());
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
