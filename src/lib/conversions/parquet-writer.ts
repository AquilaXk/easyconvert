import { compressPage, isZstdWriteAvailable } from './parquet-codec';
import {
  ColumnSchema,
  CompressionCodec,
  ConvertedType,
  Encoding,
  FieldRepetitionType,
  PageType,
  PARQUET_CREATED_BY,
  PARQUET_DATA_PAGE_MAX_ROWS,
  PARQUET_DATA_PAGE_TARGET_BYTES,
  PARQUET_DICTIONARY_MAX_BYTES,
  PARQUET_FORMAT_VERSION,
  PARQUET_MAGIC,
  PARQUET_MAX_CELLS,
  PARQUET_MAX_COLUMNS,
  PARQUET_MAX_ROWS,
  PARQUET_MAX_VALUE_BYTES,
  PARQUET_ROW_GROUP_MAX_BYTES,
  PARQUET_ROW_GROUP_MAX_ROWS,
  PARQUET_STATS_MAX_BYTES,
  ParquetCodecUnavailableError,
  ParquetType,
  ParquetValueError,
} from './parquet-format';
import { NumericDictionary } from './parquet-dictionary';
import { bitWidthFor, ByteSink, encodeRleHybrid } from './parquet-rle';
import { CompactProtocolWriter, ThriftType } from './parquet-thrift';

/**
 * Parquet writer: typed OPTIONAL columns, RLE/bit-packed definition levels, dictionary encoding with
 * a PLAIN fallback, SNAPPY/ZSTD page compression, column statistics, and bounded row groups.
 *
 * Governing spec: Apache Parquet format (parquet.thrift, Encodings.md, LogicalTypes.md).
 * Data pages are version 1: `<4-byte length><definition levels (RLE hybrid, width 1)><values>`.
 */

export interface ParquetWriteOptions {
  /** Page compression. Defaults to SNAPPY (readable everywhere, available on every Node version). */
  codec?: CompressionCodec;
  rowGroupMaxRows?: number;
  rowGroupMaxBytes?: number;
  dataPageMaxRows?: number;
  dictionaryMaxBytes?: number;
}

interface ResolvedOptions {
  codec: CompressionCodec;
  rowGroupMaxRows: number;
  rowGroupMaxBytes: number;
  dataPageMaxRows: number;
  dictionaryMaxBytes: number;
}

/** Value kinds seen in a column, as bit flags. Empty strings and null/undefined set no flag. */
const KIND_STRING = 1;
const KIND_FLOAT = 2;
const KIND_INT = 4;
const KIND_BOOL = 8;
const KIND_OTHER = 16;
const KIND_DATE = 32;
/** Kinds that are exactly one family of value; more than one family widens the column to text. */
const NUMBER_KINDS = KIND_FLOAT | KIND_INT;
const FAMILY_KINDS = [KIND_STRING, NUMBER_KINDS, KIND_BOOL, KIND_DATE];

const SUPPORTED_WRITE_CODECS: ReadonlySet<CompressionCodec> = new Set([
  CompressionCodec.UNCOMPRESSED,
  CompressionCodec.SNAPPY,
  CompressionCodec.ZSTD,
]);

const DEFINITION_LEVEL_BIT_WIDTH = 1;
const MIN_DICTIONARY_INDEX_BIT_WIDTH = 1;
const BYTE_ARRAY_LENGTH_PREFIX_BYTES = 4;
const INT64_BYTES = 8;
const BITS_PER_BYTE = 8;
const DICTIONARY_INITIAL_BYTES = 4096;
/** Room beyond the dictionary byte bound for the entry that trips it. */
const DICTIONARY_SLACK_BYTES = 64;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const ANY_SURROGATE = /[\uD800-\uDFFF]/;
const UTF16_SURROGATE_START = 0xd800;
const UTF16_PRIVATE_BMP_START = 0xe000;
const UTF16_SURROGATE_REMAP = 0x2000;
const UTF16_BMP_REMAP = 0x800;

function typeName(type: ParquetType): string {
  return ParquetType[type] ?? String(type);
}

function classifyValue(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const t = typeof value;
  if (t === 'string') return KIND_STRING;
  if (t === 'boolean') return KIND_BOOL;
  if (t === 'number') return Number.isSafeInteger(value) ? KIND_INT : KIND_FLOAT;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? KIND_OTHER : KIND_DATE;
  return KIND_OTHER;
}

// ==========================================
// Record analysis and type inference
// ==========================================

interface AnalyzedColumn {
  name: string;
  flags: number;
  values: unknown[];
}

function analyzeRecords(records: readonly unknown[]): AnalyzedColumn[] {
  const numRows = records.length;
  if (numRows === 0) {
    throw new ParquetValueError('Cannot write Parquet: no records were provided.');
  }
  if (numRows > PARQUET_MAX_ROWS) {
    throw new ParquetValueError(`Cannot write Parquet: ${numRows} records exceed the limit of ${PARQUET_MAX_ROWS} rows.`);
  }

  const columnIndex = new Map<string, number>();
  const columns: AnalyzedColumn[] = [];
  for (let r = 0; r < numRows; r++) {
    const row = records[r];
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new ParquetValueError(`Cannot write Parquet: record ${r} is not an object of column values.`);
    }
    const keys = Object.keys(row);
    for (const key of keys) {
      let index = columnIndex.get(key);
      if (index === undefined) {
        if (columns.length >= PARQUET_MAX_COLUMNS) {
          throw new ParquetValueError(`Cannot write Parquet: more than ${PARQUET_MAX_COLUMNS} columns.`);
        }
        if (numRows * (columns.length + 1) > PARQUET_MAX_CELLS) {
          throw new ParquetValueError(`Cannot write Parquet: table exceeds the limit of ${PARQUET_MAX_CELLS} cells.`);
        }
        index = columns.length;
        columnIndex.set(key, index);
        columns.push({ name: key, flags: 0, values: new Array<unknown>(numRows) });
      }
      const value = (row as Record<string, unknown>)[key];
      const column = columns[index];
      column.values[r] = value;
      column.flags |= classifyValue(value);
    }
  }
  if (columns.length === 0) {
    throw new ParquetValueError('Cannot write Parquet: the records contain no columns.');
  }
  return columns;
}

function inferType(flags: number): ParquetType {
  const families = FAMILY_KINDS.filter((family) => (flags & family) !== 0).length;
  // Mixed families (or dates, which have no column type of their own) widen to text, losslessly.
  if (families > 1 || (flags & KIND_DATE) !== 0) return ParquetType.BYTE_ARRAY;
  if ((flags & KIND_STRING) !== 0) return ParquetType.BYTE_ARRAY;
  if ((flags & KIND_FLOAT) !== 0) return ParquetType.DOUBLE;
  if ((flags & KIND_INT) !== 0) return ParquetType.INT64;
  if ((flags & KIND_BOOL) !== 0) return ParquetType.BOOLEAN;
  return ParquetType.BYTE_ARRAY;
}

function schemaFor(name: string, type: ParquetType): ColumnSchema {
  if (type === ParquetType.BYTE_ARRAY) {
    return { name, type, convertedType: ConvertedType.UTF8, repetitionType: FieldRepetitionType.OPTIONAL };
  }
  return { name, type, repetitionType: FieldRepetitionType.OPTIONAL };
}

/**
 * Infers one OPTIONAL column per record key: double, int64, boolean or string. A column that mixes numbers,
 * booleans, strings or dates becomes a string column (numbers and booleans in their canonical JS text, dates as
 * ISO-8601); a column with no values is an all-null string column.
 */
export function inferColumnSchemas(records: Record<string, unknown>[]): ColumnSchema[] {
  if (records.length === 0) return [];
  return analyzeRecords(records).map((c) => schemaFor(c.name, inferType(c.flags)));
}

/** Throws a typed error naming the first value that no column type can represent. */
function assertValuesFit(column: AnalyzedColumn): void {
  if ((column.flags & KIND_OTHER) === 0) return;
  for (let r = 0; r < column.values.length; r++) {
    if (classifyValue(column.values[r]) === KIND_OTHER) {
      throw new ParquetValueError(
        `Cannot write Parquet: column "${column.name}" row ${r} holds ${describeUnsupported(column.values[r])}, which has no Parquet column type.`
      );
    }
  }
}

function describeUnsupported(value: unknown): string {
  if (value instanceof Date) return 'an invalid date';
  if (Array.isArray(value)) return 'an array';
  if (value !== null && typeof value === 'object') return 'a nested object';
  return `a ${typeof value} value`;
}

// ==========================================
// Column plans (per-column state shared by all row groups)
// ==========================================

interface ColumnPlan {
  schema: ColumnSchema;
  values: unknown[];
  /** UTF-8 byte length per row for string columns (0 for nulls). */
  byteLengths: Uint32Array | null;
}

/** Text form of a value that widened into a string column; null for nulls and non-text values. */
function canonicalText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString();
  return null;
}

function planColumn(column: AnalyzedColumn): ColumnPlan {
  const type = inferType(column.flags);
  assertValuesFit(column);
  let byteLengths: Uint32Array | null = null;
  if (type === ParquetType.BYTE_ARRAY) {
    byteLengths = new Uint32Array(column.values.length);
    for (let r = 0; r < column.values.length; r++) {
      const v = canonicalText(column.values[r]);
      if (v === null) continue;
      column.values[r] = v;
      if (ANY_SURROGATE.test(v) && LONE_SURROGATE.test(v)) {
        throw new ParquetValueError(
          `Cannot write Parquet: column "${column.name}" row ${r} holds a string with an unpaired UTF-16 surrogate, which has no UTF-8 encoding.`
        );
      }
      const bytes = Buffer.byteLength(v, 'utf8');
      if (bytes > PARQUET_MAX_VALUE_BYTES) {
        throw new ParquetValueError(
          `Cannot write Parquet: column "${column.name}" row ${r} holds a string of ${bytes} bytes (limit ${PARQUET_MAX_VALUE_BYTES}).`
        );
      }
      byteLengths[r] = bytes;
    }
  }
  return { schema: schemaFor(column.name, type), values: column.values, byteLengths };
}

// ==========================================
// Statistics
// ==========================================

interface ChunkStatistics {
  nullCount: number;
  min: Buffer | null;
  max: Buffer | null;
}

/** Orders strings by their UTF-8 bytes (unsigned lexicographic), which differs from UTF-16 order for astral characters. */
export function compareUtf8Order(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca !== cb) return remapUtf16Unit(ca) - remapUtf16Unit(cb);
  }
  return a.length - b.length;
}

function remapUtf16Unit(unit: number): number {
  if (unit >= UTF16_PRIVATE_BMP_START) return unit - UTF16_BMP_REMAP;
  if (unit >= UTF16_SURROGATE_START) return unit + UTF16_SURROGATE_REMAP;
  return unit;
}

function int64Bytes(v: number): Buffer {
  const sink = new ByteSink(INT64_BYTES);
  sink.writeInt64(v);
  return Buffer.from(sink.toBuffer());
}

function float64Bytes(v: number): Buffer {
  const sink = new ByteSink(INT64_BYTES);
  sink.writeFloat64(v);
  return Buffer.from(sink.toBuffer());
}

function numericStatistics(
  values: Float64Array,
  from: number,
  to: number,
  isDouble: boolean
): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let seen = false;
  for (let i = from; i < to; i++) {
    const v = values[i];
    if (v !== v) continue; // NaN never takes part in min/max
    seen = true;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!seen) return null;
  if (!isDouble) return { min: min + 0, max: max + 0 };
  // Parquet: a zero bound may stand for either sign, so write -0.0 as min and +0.0 as max.
  return { min: min === 0 ? -0 : min, max: max === 0 ? 0 : max };
}

function stringStatistics(strings: readonly string[], from: number, to: number): { min: string; max: string } | null {
  if (to <= from) return null;
  let min = strings[from];
  let max = strings[from];
  for (let i = from + 1; i < to; i++) {
    const s = strings[i];
    if (compareUtf8Order(s, min) < 0) min = s;
    if (compareUtf8Order(s, max) > 0) max = s;
  }
  return { min, max };
}

// ==========================================
// Column chunk encoding
// ==========================================

interface Gathered {
  type: ParquetType;
  /** 1 where the row has a value (definition level), per row of the group. */
  levels: Uint8Array;
  nonNullCount: number;
  numbers: Float64Array | null;
  booleans: Uint8Array | null;
  strings: string[] | null;
  stringBytes: Uint32Array | null;
}

interface DictionaryResult {
  entryCount: number;
  indices: Uint32Array;
  bitWidth: number;
  pageBody: Buffer;
}

interface EncodedChunk {
  schema: ColumnSchema;
  parts: Buffer[];
  numValues: number;
  encodings: Encoding[];
  totalUncompressed: number;
  totalCompressed: number;
  dictionaryPageOffset: number | null;
  dataPageOffset: number;
  statistics: ChunkStatistics;
}

function gatherChunk(plan: ColumnPlan, rowStart: number, rowEnd: number): Gathered {
  const n = rowEnd - rowStart;
  const type = plan.schema.type;
  const levels = new Uint8Array(n);
  let count = 0;
  if (type === ParquetType.BYTE_ARRAY) {
    const strings = new Array<string>(n);
    const stringBytes = new Uint32Array(n);
    const lengths = plan.byteLengths as Uint32Array;
    for (let i = 0; i < n; i++) {
      const v = plan.values[rowStart + i];
      if (typeof v === 'string') {
        levels[i] = 1;
        strings[count] = v;
        stringBytes[count] = lengths[rowStart + i];
        count++;
      }
    }
    strings.length = count;
    return { type, levels, nonNullCount: count, numbers: null, booleans: null, strings, stringBytes };
  }
  if (type === ParquetType.BOOLEAN) {
    const booleans = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const v = plan.values[rowStart + i];
      if (typeof v === 'boolean') {
        levels[i] = 1;
        booleans[count++] = v ? 1 : 0;
      }
    }
    return { type, levels, nonNullCount: count, numbers: null, booleans, strings: null, stringBytes: null };
  }
  const numbers = new Float64Array(n);
  const isInt64 = type === ParquetType.INT64;
  for (let i = 0; i < n; i++) {
    const v = plan.values[rowStart + i];
    if (typeof v === 'number') {
      levels[i] = 1;
      // INT64 holds integers only: fold -0 into 0 so equal values share one dictionary entry.
      numbers[count++] = isInt64 ? v + 0 : v;
    }
  }
  return { type, levels, nonNullCount: count, numbers, booleans: null, strings: null, stringBytes: null };
}

function plainValueBytes(g: Gathered): number {
  if (g.type === ParquetType.BYTE_ARRAY) {
    let total = g.nonNullCount * BYTE_ARRAY_LENGTH_PREFIX_BYTES;
    const lens = g.stringBytes as Uint32Array;
    for (let i = 0; i < g.nonNullCount; i++) total += lens[i];
    return total;
  }
  if (g.type === ParquetType.BOOLEAN) return Math.ceil(g.nonNullCount / BITS_PER_BYTE);
  return g.nonNullCount * INT64_BYTES;
}

function buildDictionary(g: Gathered, maxDictionaryBytes: number): DictionaryResult | null {
  if (g.type === ParquetType.BOOLEAN || g.nonNullCount === 0) return null;
  const n = g.nonNullCount;
  const indices = new Uint32Array(n);
  const dictSink = new ByteSink(DICTIONARY_INITIAL_BYTES, maxDictionaryBytes + DICTIONARY_SLACK_BYTES);
  let entryCount = 0;

  if (g.type === ParquetType.BYTE_ARRAY) {
    const strings = g.strings as string[];
    const lens = g.stringBytes as Uint32Array;
    const seen = new Map<string, number>();
    let dictBytes = 0;
    for (let i = 0; i < n; i++) {
      const s = strings[i];
      let idx = seen.get(s);
      if (idx === undefined) {
        dictBytes += BYTE_ARRAY_LENGTH_PREFIX_BYTES + lens[i];
        if (dictBytes > maxDictionaryBytes) return null;
        idx = entryCount++;
        seen.set(s, idx);
        dictSink.writeUint32(lens[i]);
        dictSink.writeUtf8(s, lens[i]);
      }
      indices[i] = idx;
    }
  } else {
    const numbers = g.numbers as Float64Array;
    const table = new NumericDictionary(Math.floor(maxDictionaryBytes / INT64_BYTES), n);
    for (let i = 0; i < n; i++) {
      const idx = table.indexOf(numbers[i]);
      if (idx < 0) return null;
      indices[i] = idx;
    }
    entryCount = table.count;
    if (g.type === ParquetType.DOUBLE) {
      for (let e = 0; e < entryCount; e++) dictSink.writeFloat64(table.values[e]);
    } else {
      for (let e = 0; e < entryCount; e++) dictSink.writeInt64(table.values[e]);
    }
  }
  const bitWidth = Math.max(MIN_DICTIONARY_INDEX_BIT_WIDTH, bitWidthFor(entryCount - 1));
  return { entryCount, indices, bitWidth, pageBody: Buffer.from(dictSink.toBuffer()) };
}

function writePlainValues(sink: ByteSink, g: Gathered, from: number, to: number): void {
  if (g.type === ParquetType.BYTE_ARRAY) {
    const strings = g.strings as string[];
    const lens = g.stringBytes as Uint32Array;
    for (let i = from; i < to; i++) {
      sink.writeUint32(lens[i]);
      sink.writeUtf8(strings[i], lens[i]);
    }
  } else if (g.type === ParquetType.DOUBLE) {
    const numbers = g.numbers as Float64Array;
    for (let i = from; i < to; i++) sink.writeFloat64(numbers[i]);
  } else if (g.type === ParquetType.INT64) {
    const numbers = g.numbers as Float64Array;
    for (let i = from; i < to; i++) sink.writeInt64(numbers[i]);
  } else {
    // BOOLEAN PLAIN: one bit per value, least significant bit first.
    const booleans = g.booleans as Uint8Array;
    let byte = 0;
    let bit = 0;
    for (let i = from; i < to; i++) {
      byte |= booleans[i] << bit;
      bit++;
      if (bit === BITS_PER_BYTE) {
        sink.writeByte(byte);
        byte = 0;
        bit = 0;
      }
    }
    if (bit > 0) sink.writeByte(byte);
  }
}

interface PageSlice {
  rowStart: number;
  rowEnd: number;
  valueStart: number;
  valueEnd: number;
}

function splitPages(g: Gathered, dictionary: boolean, maxRows: number): PageSlice[] {
  const pages: PageSlice[] = [];
  const rows = g.levels.length;
  const sizeAware = !dictionary && g.type === ParquetType.BYTE_ARRAY;
  const lens = g.stringBytes;
  let rowStart = 0;
  let valueStart = 0;
  let valueIdx = 0;
  let pageBytes = 0;
  for (let r = 0; r < rows; r++) {
    if (g.levels[r] === 1) {
      if (sizeAware && lens) pageBytes += BYTE_ARRAY_LENGTH_PREFIX_BYTES + lens[valueIdx];
      valueIdx++;
    }
    const full = r + 1 - rowStart >= maxRows || pageBytes >= PARQUET_DATA_PAGE_TARGET_BYTES;
    if (full) {
      pages.push({ rowStart, rowEnd: r + 1, valueStart, valueEnd: valueIdx });
      rowStart = r + 1;
      valueStart = valueIdx;
      pageBytes = 0;
    }
  }
  if (rowStart < rows) pages.push({ rowStart, rowEnd: rows, valueStart, valueEnd: valueIdx });
  return pages;
}

function pageHeaderBytes(
  pageType: PageType,
  uncompressedSize: number,
  compressedSize: number,
  numValues: number,
  encoding: Encoding,
  statistics: ChunkStatistics | null
): Buffer {
  const w = new CompactProtocolWriter();
  w.writeStructBegin();
  w.writeFieldBegin(1, ThriftType.I32);
  w.writeI32(pageType);
  w.writeFieldBegin(2, ThriftType.I32);
  w.writeI32(uncompressedSize);
  w.writeFieldBegin(3, ThriftType.I32);
  w.writeI32(compressedSize);
  if (pageType === PageType.DATA_PAGE) {
    w.writeFieldBegin(5, ThriftType.STRUCT);
    w.writeStructBegin();
    w.writeFieldBegin(1, ThriftType.I32);
    w.writeI32(numValues);
    w.writeFieldBegin(2, ThriftType.I32);
    w.writeI32(encoding);
    w.writeFieldBegin(3, ThriftType.I32);
    w.writeI32(Encoding.RLE);
    w.writeFieldBegin(4, ThriftType.I32);
    w.writeI32(Encoding.RLE);
    if (statistics) {
      w.writeFieldBegin(5, ThriftType.STRUCT);
      writeStatistics(w, statistics);
    }
    w.writeFieldStop();
    w.writeStructEnd();
  } else {
    w.writeFieldBegin(7, ThriftType.STRUCT);
    w.writeStructBegin();
    w.writeFieldBegin(1, ThriftType.I32);
    w.writeI32(numValues);
    w.writeFieldBegin(2, ThriftType.I32);
    w.writeI32(encoding);
    w.writeFieldStop();
    w.writeStructEnd();
  }
  w.writeFieldStop();
  w.writeStructEnd();
  return w.toBuffer();
}

/** Statistics over the non-null values [from, to) of a column chunk (a page or the whole chunk). */
function rangeStatistics(
  g: Gathered,
  dictionary: DictionaryResult | null,
  from: number,
  to: number,
  nullCount: number
): ChunkStatistics {
  const none: ChunkStatistics = { nullCount, min: null, max: null };
  if (to <= from) return none;
  if (g.type === ParquetType.BYTE_ARRAY) {
    const strings = g.strings as string[];
    // With a dictionary only the distinct entries of the range need comparing.
    const source = dictionary ? distinctStrings(strings, dictionary, from, to) : strings;
    const stats = dictionary ? stringStatistics(source, 0, source.length) : stringStatistics(source, from, to);
    if (!stats) return none;
    const min = Buffer.from(stats.min, 'utf8');
    const max = Buffer.from(stats.max, 'utf8');
    if (min.length > PARQUET_STATS_MAX_BYTES || max.length > PARQUET_STATS_MAX_BYTES) return none;
    return { nullCount, min, max };
  }
  if (g.type === ParquetType.BOOLEAN) {
    const booleans = g.booleans as Uint8Array;
    let hasFalse = false;
    let hasTrue = false;
    for (let i = from; i < to; i++) {
      if (booleans[i] === 1) hasTrue = true;
      else hasFalse = true;
    }
    return {
      nullCount,
      min: Buffer.from([hasFalse ? 0 : 1]),
      max: Buffer.from([hasTrue ? 1 : 0]),
    };
  }
  const isDouble = g.type === ParquetType.DOUBLE;
  const stats = numericStatistics(g.numbers as Float64Array, from, to, isDouble);
  if (!stats) return none;
  return isDouble
    ? { nullCount, min: float64Bytes(stats.min), max: float64Bytes(stats.max) }
    : { nullCount, min: int64Bytes(stats.min), max: int64Bytes(stats.max) };
}

/** The distinct strings among the dictionary-encoded values [from, to). */
function distinctStrings(strings: string[], dictionary: DictionaryResult, from: number, to: number): string[] {
  const out: string[] = [];
  const seen = new Uint8Array(dictionary.entryCount);
  for (let i = from; i < to; i++) {
    const idx = dictionary.indices[i];
    if (seen[idx] === 0) {
      seen[idx] = 1;
      out.push(strings[i]);
    }
  }
  return out;
}

function writeStatistics(w: CompactProtocolWriter, stats: ChunkStatistics): void {
  w.writeStructBegin();
  w.writeFieldBegin(3, ThriftType.I64);
  w.writeI64(BigInt(stats.nullCount));
  if (stats.max && stats.min) {
    w.writeFieldBegin(5, ThriftType.BINARY);
    w.writeBinary(stats.max);
    w.writeFieldBegin(6, ThriftType.BINARY);
    w.writeBinary(stats.min);
  }
  w.writeFieldStop();
  w.writeStructEnd();
}

function encodeColumnChunk(
  plan: ColumnPlan,
  rowStart: number,
  rowEnd: number,
  fileOffset: number,
  options: ResolvedOptions,
  sink: ByteSink
): EncodedChunk {
  const g = gatherChunk(plan, rowStart, rowEnd);
  const rows = rowEnd - rowStart;
  const nullCount = rows - g.nonNullCount;

  let dictionary = buildDictionary(g, options.dictionaryMaxBytes);
  if (dictionary) {
    const indexBytes = Math.ceil((g.nonNullCount * dictionary.bitWidth) / BITS_PER_BYTE);
    if (dictionary.pageBody.length + indexBytes >= plainValueBytes(g)) dictionary = null;
  }

  const valueEncoding = dictionary ? Encoding.PLAIN_DICTIONARY : Encoding.PLAIN;
  const parts: Buffer[] = [];
  let position = fileOffset;
  let totalUncompressed = 0;
  let totalCompressed = 0;
  let dictionaryPageOffset: number | null = null;

  const pushPage = (pageType: PageType, body: Uint8Array, numValues: number, pageStats: ChunkStatistics | null) => {
    const compressed = compressPage(options.codec, body);
    const header = pageHeaderBytes(pageType, body.length, compressed.length, numValues, valueEncoding, pageStats);
    // total_uncompressed_size counts headers as they would be written without compression.
    const uncompressedHeader = pageHeaderBytes(pageType, body.length, body.length, numValues, valueEncoding, pageStats);
    parts.push(header, compressed);
    position += header.length + compressed.length;
    totalCompressed += header.length + compressed.length;
    totalUncompressed += uncompressedHeader.length + body.length;
  };

  if (dictionary) {
    dictionaryPageOffset = position;
    pushPage(PageType.DICTIONARY_PAGE, dictionary.pageBody, dictionary.entryCount, null);
  }
  const dataPageOffset = position;

  for (const page of splitPages(g, dictionary !== null, options.dataPageMaxRows)) {
    sink.reset();
    const lengthAt = sink.length;
    sink.writeUint32(0);
    encodeRleHybrid(
      sink,
      g.levels.subarray(page.rowStart, page.rowEnd),
      page.rowEnd - page.rowStart,
      DEFINITION_LEVEL_BIT_WIDTH
    );
    sink.patchUint32(lengthAt, sink.length - lengthAt - BYTE_ARRAY_LENGTH_PREFIX_BYTES);
    if (dictionary) {
      sink.writeByte(dictionary.bitWidth);
      encodeRleHybrid(
        sink,
        dictionary.indices.subarray(page.valueStart, page.valueEnd),
        page.valueEnd - page.valueStart,
        dictionary.bitWidth
      );
    } else {
      writePlainValues(sink, g, page.valueStart, page.valueEnd);
    }
    const pageRows = page.rowEnd - page.rowStart;
    const pageNulls = pageRows - (page.valueEnd - page.valueStart);
    const pageStats = rangeStatistics(g, dictionary, page.valueStart, page.valueEnd, pageNulls);
    pushPage(PageType.DATA_PAGE, sink.toBuffer(), pageRows, pageStats);
  }

  const encodings = dictionary ? [Encoding.PLAIN_DICTIONARY, Encoding.RLE] : [Encoding.PLAIN, Encoding.RLE];
  return {
    schema: plan.schema,
    parts,
    numValues: rows,
    encodings,
    totalUncompressed,
    totalCompressed,
    dictionaryPageOffset,
    dataPageOffset,
    statistics: rangeStatistics(g, dictionary, 0, g.nonNullCount, nullCount),
  };
}

// ==========================================
// Footer
// ==========================================

interface EncodedRowGroup {
  chunks: EncodedChunk[];
  numRows: number;
  startOffset: number;
  totalUncompressed: number;
  totalCompressed: number;
}

function writeSchemaElement(w: CompactProtocolWriter, s: ColumnSchema): void {
  w.writeStructBegin();
  w.writeFieldBegin(1, ThriftType.I32);
  w.writeI32(s.type);
  w.writeFieldBegin(3, ThriftType.I32);
  w.writeI32(s.repetitionType);
  w.writeFieldBegin(4, ThriftType.BINARY);
  w.writeString(s.name);
  if (s.convertedType !== undefined) {
    w.writeFieldBegin(6, ThriftType.I32);
    w.writeI32(s.convertedType);
    // LogicalType union, member 1: StringType (an empty struct).
    w.writeFieldBegin(10, ThriftType.STRUCT);
    w.writeStructBegin();
    w.writeFieldBegin(1, ThriftType.STRUCT);
    w.writeStructBegin();
    w.writeFieldStop();
    w.writeStructEnd();
    w.writeFieldStop();
    w.writeStructEnd();
  }
  w.writeFieldStop();
  w.writeStructEnd();
}

function writeColumnChunkMeta(w: CompactProtocolWriter, chunk: EncodedChunk, codec: CompressionCodec): void {
  w.writeStructBegin();
  w.writeFieldBegin(2, ThriftType.I64);
  w.writeI64(BigInt(chunk.dictionaryPageOffset ?? chunk.dataPageOffset));
  w.writeFieldBegin(3, ThriftType.STRUCT);
  w.writeStructBegin();
  w.writeFieldBegin(1, ThriftType.I32);
  w.writeI32(chunk.schema.type);
  w.writeFieldBegin(2, ThriftType.LIST);
  w.writeListBegin(ThriftType.I32, chunk.encodings.length);
  for (const e of chunk.encodings) w.writeI32(e);
  w.writeFieldBegin(3, ThriftType.LIST);
  w.writeListBegin(ThriftType.BINARY, 1);
  w.writeString(chunk.schema.name);
  w.writeFieldBegin(4, ThriftType.I32);
  w.writeI32(codec);
  w.writeFieldBegin(5, ThriftType.I64);
  w.writeI64(BigInt(chunk.numValues));
  w.writeFieldBegin(6, ThriftType.I64);
  w.writeI64(BigInt(chunk.totalUncompressed));
  w.writeFieldBegin(7, ThriftType.I64);
  w.writeI64(BigInt(chunk.totalCompressed));
  w.writeFieldBegin(9, ThriftType.I64);
  w.writeI64(BigInt(chunk.dataPageOffset));
  if (chunk.dictionaryPageOffset !== null) {
    w.writeFieldBegin(11, ThriftType.I64);
    w.writeI64(BigInt(chunk.dictionaryPageOffset));
  }
  w.writeFieldBegin(12, ThriftType.STRUCT);
  writeStatistics(w, chunk.statistics);
  w.writeFieldStop();
  w.writeStructEnd(); // ColumnMetaData
  w.writeFieldStop();
  w.writeStructEnd(); // ColumnChunk
}

function buildFooter(
  schemas: ColumnSchema[],
  rowGroups: EncodedRowGroup[],
  numRows: number,
  codec: CompressionCodec
): Buffer {
  const w = new CompactProtocolWriter();
  w.writeStructBegin();
  w.writeFieldBegin(1, ThriftType.I32);
  w.writeI32(PARQUET_FORMAT_VERSION);

  w.writeFieldBegin(2, ThriftType.LIST);
  w.writeListBegin(ThriftType.STRUCT, 1 + schemas.length);
  w.writeStructBegin();
  w.writeFieldBegin(4, ThriftType.BINARY);
  w.writeString('root');
  w.writeFieldBegin(5, ThriftType.I32);
  w.writeI32(schemas.length);
  w.writeFieldStop();
  w.writeStructEnd();
  for (const s of schemas) writeSchemaElement(w, s);

  w.writeFieldBegin(3, ThriftType.I64);
  w.writeI64(BigInt(numRows));

  w.writeFieldBegin(4, ThriftType.LIST);
  w.writeListBegin(ThriftType.STRUCT, rowGroups.length);
  rowGroups.forEach((rg, ordinal) => {
    w.writeStructBegin();
    w.writeFieldBegin(1, ThriftType.LIST);
    w.writeListBegin(ThriftType.STRUCT, rg.chunks.length);
    for (const chunk of rg.chunks) writeColumnChunkMeta(w, chunk, codec);
    w.writeFieldBegin(2, ThriftType.I64);
    w.writeI64(BigInt(rg.totalUncompressed));
    w.writeFieldBegin(3, ThriftType.I64);
    w.writeI64(BigInt(rg.numRows));
    w.writeFieldBegin(5, ThriftType.I64);
    w.writeI64(BigInt(rg.startOffset));
    w.writeFieldBegin(6, ThriftType.I64);
    w.writeI64(BigInt(rg.totalCompressed));
    w.writeFieldBegin(7, ThriftType.I16);
    w.writeI16(ordinal);
    w.writeFieldStop();
    w.writeStructEnd();
  });

  w.writeFieldBegin(6, ThriftType.BINARY);
  w.writeString(PARQUET_CREATED_BY);

  // Every column uses the type-defined sort order that the min/max statistics above follow.
  w.writeFieldBegin(7, ThriftType.LIST);
  w.writeListBegin(ThriftType.STRUCT, schemas.length);
  for (let i = 0; i < schemas.length; i++) {
    w.writeStructBegin();
    w.writeFieldBegin(1, ThriftType.STRUCT);
    w.writeStructBegin();
    w.writeFieldStop();
    w.writeStructEnd();
    w.writeFieldStop();
    w.writeStructEnd();
  }

  w.writeFieldStop();
  w.writeStructEnd();
  return w.toBuffer();
}

// ==========================================
// Public entry point
// ==========================================

function resolveLimit(name: string, value: number | undefined, fallback: number, hardMax: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > hardMax) {
    throw new ParquetValueError(`Invalid Parquet write option ${name}: ${String(value)} (expected an integer from 1 to ${hardMax}).`);
  }
  return value;
}

function resolveOptions(options: ParquetWriteOptions): ResolvedOptions {
  const codec = options.codec ?? CompressionCodec.SNAPPY;
  if (!SUPPORTED_WRITE_CODECS.has(codec)) {
    throw new ParquetCodecUnavailableError(
      `Unsupported Parquet write codec ${String(codec)}. Supported: UNCOMPRESSED, SNAPPY, ZSTD.`
    );
  }
  if (codec === CompressionCodec.ZSTD && !isZstdWriteAvailable()) {
    throw new ParquetCodecUnavailableError(
      'ZSTD compression requires a Node.js runtime with zstd support in node:zlib (22.15 or newer); use SNAPPY instead.'
    );
  }
  return {
    codec,
    rowGroupMaxRows: resolveLimit('rowGroupMaxRows', options.rowGroupMaxRows, PARQUET_ROW_GROUP_MAX_ROWS, PARQUET_MAX_ROWS),
    rowGroupMaxBytes: resolveLimit(
      'rowGroupMaxBytes',
      options.rowGroupMaxBytes,
      PARQUET_ROW_GROUP_MAX_BYTES,
      Number.MAX_SAFE_INTEGER
    ),
    dataPageMaxRows: resolveLimit('dataPageMaxRows', options.dataPageMaxRows, PARQUET_DATA_PAGE_MAX_ROWS, PARQUET_MAX_ROWS),
    dictionaryMaxBytes: resolveLimit(
      'dictionaryMaxBytes',
      options.dictionaryMaxBytes,
      PARQUET_DICTIONARY_MAX_BYTES,
      PARQUET_DICTIONARY_MAX_BYTES
    ),
  };
}

/** Splits [0, numRows) into row groups bounded by both a row count and an (exact) byte estimate. */
function splitRowGroups(plans: ColumnPlan[], numRows: number, maxRows: number, maxBytes: number): [number, number][] {
  let fixedBytesPerRow = 0;
  const stringColumns: Uint32Array[] = [];
  for (const plan of plans) {
    if (plan.byteLengths) {
      stringColumns.push(plan.byteLengths);
      fixedBytesPerRow += BYTE_ARRAY_LENGTH_PREFIX_BYTES;
    } else {
      fixedBytesPerRow += INT64_BYTES;
    }
  }
  const groups: [number, number][] = [];
  let start = 0;
  let bytes = 0;
  for (let r = 0; r < numRows; r++) {
    let rowBytes = fixedBytesPerRow;
    for (const lengths of stringColumns) rowBytes += lengths[r];
    if (r > start && (r - start >= maxRows || bytes + rowBytes > maxBytes)) {
      groups.push([start, r]);
      start = r;
      bytes = 0;
    }
    bytes += rowBytes;
  }
  groups.push([start, numRows]);
  return groups;
}

/**
 * Serializes row objects into a Parquet file.
 *
 * Columns are inferred per key (string, double, int64, boolean) and written OPTIONAL. A value that
 * does not fit the inferred column type, an empty or malformed record set, or an unsupported option
 * throws a typed error (HTTP 400 through the ConversionFailedError family).
 */
export function encodeParquet(records: Record<string, unknown>[], options: ParquetWriteOptions = {}): Buffer {
  const resolved = resolveOptions(options);
  const plans = analyzeRecords(records).map(planColumn);
  const numRows = records.length;
  const schemas = plans.map((p) => p.schema);

  const body: Buffer[] = [Buffer.from(PARQUET_MAGIC, 'ascii')];
  let offset = PARQUET_MAGIC.length;
  const rowGroups: EncodedRowGroup[] = [];
  const pageSink = new ByteSink(PARQUET_DATA_PAGE_TARGET_BYTES);
  for (const [rowStart, rowEnd] of splitRowGroups(plans, numRows, resolved.rowGroupMaxRows, resolved.rowGroupMaxBytes)) {
    const group: EncodedRowGroup = {
      chunks: [],
      numRows: rowEnd - rowStart,
      startOffset: offset,
      totalUncompressed: 0,
      totalCompressed: 0,
    };
    for (const plan of plans) {
      const chunk = encodeColumnChunk(plan, rowStart, rowEnd, offset, resolved, pageSink);
      for (const part of chunk.parts) {
        body.push(part);
        offset += part.length;
      }
      group.chunks.push(chunk);
      group.totalUncompressed += chunk.totalUncompressed;
      group.totalCompressed += chunk.totalCompressed;
    }
    rowGroups.push(group);
  }

  const footer = buildFooter(schemas, rowGroups, numRows, resolved.codec);
  const footerLength = Buffer.alloc(BYTE_ARRAY_LENGTH_PREFIX_BYTES);
  footerLength.writeUInt32LE(footer.length, 0);
  body.push(footer, footerLength, Buffer.from(PARQUET_MAGIC, 'ascii'));
  return Buffer.concat(body);
}
