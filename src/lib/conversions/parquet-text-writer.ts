import { DelimitedBytesUnsupported, DelimitedByteScanner, type CellChunk } from './delimited-bytes';
import { compressPage } from './parquet-codec';
import {
  ColumnSchema,
  Encoding,
  PageType,
  PARQUET_DATA_PAGE_TARGET_BYTES,
  PARQUET_MAGIC,
  PARQUET_MAX_CELLS,
  PARQUET_MAX_ROWS,
  PARQUET_MAX_VALUE_BYTES,
  PARQUET_STATS_MAX_BYTES,
  ParquetType,
} from './parquet-format';
import { bitWidthFor, ByteSink, encodeRleHybrid } from './parquet-rle';
import {
  type ChunkStatistics,
  type EncodedChunk,
  type EncodedRowGroup,
  finishParquetFile,
  pageHeaderBytes,
  type ParquetWriteOptions,
  type ResolvedOptions,
  resolveOptions,
  schemaFor,
} from './parquet-writer';

/**
 * Parquet writer for tables whose every cell is text that still sits in the bytes it was read from (the cell
 * scanner of delimited-bytes.ts): the dictionary, the PLAIN values and the min/max statistics are all built from byte
 * ranges, so no cell is ever turned into a JavaScript string.
 *
 * It writes what encodeParquet writes for the same table of string cells, byte for byte: the same row-group and page
 * boundaries, the same dictionary decision, the same statistics. Cells are UTF-8 (the scanner checked), so ordering
 * them by their bytes is the UTF-8 order the statistics need.
 */

/** Local copies of shared limits: an imported binding costs a getter call each time a hot loop reads it. */
const PAGE_TARGET_BYTES = PARQUET_DATA_PAGE_TARGET_BYTES;
const MAX_VALUE_BYTES = PARQUET_MAX_VALUE_BYTES;
const BYTE_ARRAY_LENGTH_PREFIX_BYTES = 4;
const BITS_PER_BYTE = 8;
const MIN_DICTIONARY_INDEX_BIT_WIDTH = 1;
const DEFINITION_LEVEL_BIT_WIDTH = 1;
const MIN_HASH_SLOTS = 16;
const FNV_OFFSET = 0x811c9dc5 | 0;
const FNV_PRIME = 0x01000193;
const HASH_MIX_SHIFT = 15;

/** Scratch space one row group needs, reused by every column of it. */
interface GroupScratch {
  table: Int32Array;
  entryHash: Int32Array;
  entryStart: Int32Array;
  entryLength: Int32Array;
  indices: Uint32Array;
  ones: Uint8Array;
}

interface TextDictionary {
  entries: number;
  bitWidth: number;
  /** PLAIN dictionary page body: a length prefix and the bytes of every distinct value, in first-seen order. */
  body: Buffer;
}

function hashCell(data: Uint8Array, start: number, length: number): number {
  let hash = FNV_OFFSET;
  const end = start + length;
  for (let i = start; i < end; i++) hash = Math.imul(hash ^ data[i], FNV_PRIME);
  return hash ^ (hash >>> HASH_MIX_SHIFT);
}

function sameBytes(data: Uint8Array, a: number, b: number, length: number): boolean {
  for (let i = 0; i < length; i++) {
    if (data[a + i] !== data[b + i]) return false;
  }
  return true;
}

/** Orders two byte ranges lexicographically as unsigned bytes. */
function compareRanges(data: Uint8Array, a: number, aLength: number, b: number, bLength: number): number {
  const shared = aLength < bLength ? aLength : bLength;
  for (let i = 0; i < shared; i++) {
    const difference = data[a + i] - data[b + i];
    if (difference !== 0) return difference;
  }
  return aLength - bLength;
}

function scratchFor(rows: number): GroupScratch {
  let slots = MIN_HASH_SLOTS;
  while (slots < rows * 2) slots *= 2;
  return {
    table: new Int32Array(slots),
    entryHash: new Int32Array(rows),
    entryStart: new Int32Array(rows),
    entryLength: new Int32Array(rows),
    indices: new Uint32Array(rows),
    ones: new Uint8Array(rows).fill(1),
  };
}

/**
 * Builds the dictionary of column `column` over the rows of the chunk. Returns null when the dictionary outgrows
 * `maxDictionaryBytes`, or when it would not be smaller than the PLAIN values (the rule encodeParquet applies).
 */
function buildDictionary(
  chunk: CellChunk,
  width: number,
  column: number,
  plainBytes: number,
  maxDictionaryBytes: number,
  scratch: GroupScratch
): TextDictionary | null {
  const { data, rows, starts, lengths } = chunk;
  const { table, entryHash, entryStart, entryLength, indices } = scratch;
  const mask = table.length - 1;
  table.fill(0);
  let entries = 0;
  let dictionaryBytes = 0;
  for (let r = 0, cell = column; r < rows; r++, cell += width) {
    const start = starts[cell];
    const length = lengths[cell];
    const hash = hashCell(data, start, length);
    let slot = hash & mask;
    let index = -1;
    for (;;) {
      const held = table[slot];
      if (held === 0) break;
      const candidate = held - 1;
      if (entryHash[candidate] === hash && entryLength[candidate] === length && sameBytes(data, entryStart[candidate], start, length)) {
        index = candidate;
        break;
      }
      slot = (slot + 1) & mask;
    }
    if (index < 0) {
      dictionaryBytes += BYTE_ARRAY_LENGTH_PREFIX_BYTES + length;
      if (dictionaryBytes > maxDictionaryBytes) return null;
      index = entries++;
      table[slot] = entries;
      entryHash[index] = hash;
      entryStart[index] = start;
      entryLength[index] = length;
    }
    indices[r] = index;
  }
  const bitWidth = Math.max(MIN_DICTIONARY_INDEX_BIT_WIDTH, bitWidthFor(entries - 1));
  const indexBytes = Math.ceil((rows * bitWidth) / BITS_PER_BYTE);
  if (dictionaryBytes + indexBytes >= plainBytes) return null;
  const body = Buffer.allocUnsafe(dictionaryBytes);
  let at = 0;
  for (let e = 0; e < entries; e++) {
    const length = entryLength[e];
    body.writeUInt32LE(length, at);
    at += BYTE_ARRAY_LENGTH_PREFIX_BYTES;
    const from = entryStart[e];
    if (length <= SHORT_COPY_BYTES) {
      for (let i = 0; i < length; i++) body[at + i] = data[from + i];
    } else {
      data.copy(body, at, from, from + length);
    }
    at += length;
  }
  return { entries, bitWidth, body };
}

/** Entries up to this long are copied byte by byte. */
const SHORT_COPY_BYTES = 24;

function statisticsOf(data: Buffer, minAt: number, minLength: number, maxAt: number, maxLength: number): ChunkStatistics {
  if (minLength > PARQUET_STATS_MAX_BYTES || maxLength > PARQUET_STATS_MAX_BYTES) return { nullCount: 0, min: null, max: null };
  return {
    nullCount: 0,
    min: Buffer.from(data.subarray(minAt, minAt + minLength)),
    max: Buffer.from(data.subarray(maxAt, maxAt + maxLength)),
  };
}

interface Page {
  rowStart: number;
  rowEnd: number;
}

/** Pages of a PLAIN chunk close on a row count or on the byte target; those of a dictionary chunk on a row count. */
function splitPages(chunk: CellChunk, width: number, column: number, dictionary: boolean, maxRows: number): Page[] {
  const { rows, lengths } = chunk;
  if (dictionary) {
    const pages: Page[] = [];
    for (let rowStart = 0; rowStart < rows; rowStart += maxRows) pages.push({ rowStart, rowEnd: Math.min(rows, rowStart + maxRows) });
    return pages;
  }
  const pages: Page[] = [];
  let rowStart = 0;
  let pageBytes = 0;
  for (let r = 0; r < rows; r++) {
    pageBytes += BYTE_ARRAY_LENGTH_PREFIX_BYTES + lengths[r * width + column];
    if (r + 1 - rowStart >= maxRows || pageBytes >= PAGE_TARGET_BYTES) {
      pages.push({ rowStart, rowEnd: r + 1 });
      rowStart = r + 1;
      pageBytes = 0;
    }
  }
  if (rowStart < rows) pages.push({ rowStart, rowEnd: rows });
  return pages;
}

function encodeTextColumnChunk(
  chunk: CellChunk,
  width: number,
  column: number,
  schema: ColumnSchema,
  fileOffset: number,
  options: ResolvedOptions,
  scratch: GroupScratch,
  sink: ByteSink
): EncodedChunk {
  const { data, rows, starts, lengths } = chunk;
  let plainBytes = rows * BYTE_ARRAY_LENGTH_PREFIX_BYTES;
  for (let r = 0, cell = column; r < rows; r++, cell += width) {
    const length = lengths[cell];
    if (length > MAX_VALUE_BYTES) throw new DelimitedBytesUnsupported('a cell beyond the Parquet value limit');
    plainBytes += length;
  }
  const dictionary = buildDictionary(chunk, width, column, plainBytes, options.dictionaryMaxBytes, scratch);

  const valueEncoding = dictionary ? Encoding.RLE_DICTIONARY : Encoding.PLAIN;
  const parts: Buffer[] = [];
  let position = fileOffset;
  let totalUncompressed = 0;
  let totalCompressed = 0;
  let dictionaryPageOffset: number | null = null;

  const pushPage = (pageType: PageType, body: Uint8Array, numValues: number, stats: ChunkStatistics | null): void => {
    const compressed = compressPage(options.codec, body);
    const encoding = pageType === PageType.DICTIONARY_PAGE ? Encoding.PLAIN : valueEncoding;
    const header = pageHeaderBytes(pageType, body.length, compressed.length, numValues, encoding, stats);
    // total_uncompressed_size counts headers as they would be written without compression.
    const uncompressedHeader = pageHeaderBytes(pageType, body.length, body.length, numValues, encoding, stats);
    parts.push(header, compressed);
    position += header.length + compressed.length;
    totalCompressed += header.length + compressed.length;
    totalUncompressed += uncompressedHeader.length + body.length;
  };

  if (dictionary) {
    dictionaryPageOffset = position;
    pushPage(PageType.DICTIONARY_PAGE, dictionary.body, dictionary.entries, null);
  }
  const dataPageOffset = position;

  const pages = splitPages(chunk, width, column, dictionary !== null, options.dataPageMaxRows);
  let wholeStatistics: ChunkStatistics | null = null;
  const seen = dictionary ? new Uint8Array(dictionary.entries) : null;
  for (const page of pages) {
    const pageRows = page.rowEnd - page.rowStart;
    sink.reset();
    const lengthAt = sink.length;
    sink.writeUint32(0);
    encodeRleHybrid(sink, scratch.ones, pageRows, DEFINITION_LEVEL_BIT_WIDTH);
    sink.patchUint32(lengthAt, sink.length - lengthAt - BYTE_ARRAY_LENGTH_PREFIX_BYTES);

    let minAt = -1;
    let minLength = 0;
    let maxAt = -1;
    let maxLength = 0;
    if (dictionary) {
      sink.writeByte(dictionary.bitWidth);
      encodeRleHybrid(sink, scratch.indices.subarray(page.rowStart, page.rowEnd), pageRows, dictionary.bitWidth);
      // Only the distinct entries of the page need comparing.
      (seen as Uint8Array).fill(0);
      for (let r = page.rowStart; r < page.rowEnd; r++) {
        const index = scratch.indices[r];
        if ((seen as Uint8Array)[index] === 1) continue;
        (seen as Uint8Array)[index] = 1;
        const at = scratch.entryStart[index];
        const length = scratch.entryLength[index];
        if (minAt < 0) {
          minAt = maxAt = at;
          minLength = maxLength = length;
          continue;
        }
        if (compareRanges(data, at, length, minAt, minLength) < 0) {
          minAt = at;
          minLength = length;
        }
        if (compareRanges(data, at, length, maxAt, maxLength) > 0) {
          maxAt = at;
          maxLength = length;
        }
      }
    } else {
      for (let r = page.rowStart, cell = page.rowStart * width + column; r < page.rowEnd; r++, cell += width) {
        const at = starts[cell];
        const length = lengths[cell];
        sink.writeUint32(length);
        sink.writeSlice(data, at, length);
        if (minAt < 0) {
          minAt = maxAt = at;
          minLength = maxLength = length;
          continue;
        }
        if (compareRanges(data, at, length, minAt, minLength) < 0) {
          minAt = at;
          minLength = length;
        }
        if (compareRanges(data, at, length, maxAt, maxLength) > 0) {
          maxAt = at;
          maxLength = length;
        }
      }
    }
    const pageStatistics = statisticsOf(data, minAt, minLength, maxAt, maxLength);
    if (pages.length === 1) wholeStatistics = pageStatistics;
    pushPage(PageType.DATA_PAGE, sink.toBuffer(), pageRows, pageStatistics);
  }
  if (wholeStatistics === null) wholeStatistics = wholeChunkStatistics(chunk, width, column);

  return {
    schema,
    parts,
    numValues: rows,
    encodings: dictionary ? [Encoding.PLAIN, Encoding.RLE, Encoding.RLE_DICTIONARY] : [Encoding.PLAIN, Encoding.RLE],
    totalUncompressed,
    totalCompressed,
    dictionaryPageOffset,
    dataPageOffset,
    statistics: wholeStatistics,
  };
}

function wholeChunkStatistics(chunk: CellChunk, width: number, column: number): ChunkStatistics {
  const { data, rows, starts, lengths } = chunk;
  let minAt = starts[column];
  let minLength = lengths[column];
  let maxAt = minAt;
  let maxLength = minLength;
  for (let r = 1, cell = width + column; r < rows; r++, cell += width) {
    const at = starts[cell];
    const length = lengths[cell];
    if (compareRanges(data, at, length, minAt, minLength) < 0) {
      minAt = at;
      minLength = length;
    }
    if (compareRanges(data, at, length, maxAt, maxLength) > 0) {
      maxAt = at;
      maxLength = length;
    }
  }
  return statisticsOf(data, minAt, minLength, maxAt, maxLength);
}

/**
 * Writes every record of `scanner` as a Parquet file of OPTIONAL UTF-8 string columns, one row group at a time, so
 * only one group's cell offsets are held at once. Throws {@link DelimitedBytesUnsupported} for a table the general
 * writer would reject, so that writer reports it.
 */
export function encodeParquetFromScanner(scanner: DelimitedByteScanner, options: ParquetWriteOptions = {}): Buffer {
  const resolved = resolveOptions(options);
  const width = scanner.width;
  const schemas = scanner.header.map((name) => schemaFor(name, ParquetType.BYTE_ARRAY));
  const body: Buffer[] = [Buffer.from(PARQUET_MAGIC, 'ascii')];
  let offset = PARQUET_MAGIC.length;
  const rowGroups: EncodedRowGroup[] = [];
  const pageSink = new ByteSink(PARQUET_DATA_PAGE_TARGET_BYTES);
  let totalRows = 0;
  for (;;) {
    const chunk = scanner.nextChunk(resolved.rowGroupMaxRows, resolved.rowGroupMaxBytes);
    if (chunk === null) break;
    totalRows += chunk.rows;
    if (totalRows > PARQUET_MAX_ROWS || totalRows * width > PARQUET_MAX_CELLS) {
      throw new DelimitedBytesUnsupported('a table beyond the Parquet row and cell limits');
    }
    const scratch = scratchFor(chunk.rows);
    const group: EncodedRowGroup = { chunks: [], numRows: chunk.rows, startOffset: offset, totalUncompressed: 0, totalCompressed: 0 };
    for (let column = 0; column < width; column++) {
      const encoded = encodeTextColumnChunk(chunk, width, column, schemas[column], offset, resolved, scratch, pageSink);
      for (const part of encoded.parts) {
        body.push(part);
        offset += part.length;
      }
      group.chunks.push(encoded);
      group.totalUncompressed += encoded.totalUncompressed;
      group.totalCompressed += encoded.totalCompressed;
    }
    rowGroups.push(group);
  }
  if (totalRows === 0) throw new DelimitedBytesUnsupported('a table without records');
  return finishParquetFile(body, schemas, rowGroups, totalRows, resolved.codec);
}
