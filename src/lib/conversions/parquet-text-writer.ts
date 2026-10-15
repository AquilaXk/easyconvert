import { DelimitedBytesUnsupported, DelimitedByteScanner, type CellChunk } from './delimited-bytes';
import { compressPage } from './parquet-codec';
import {
  ColumnSchema,
  CompressionCodec,
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
import { ByteSink, encodeRleHybrid } from './parquet-rle';
import {
  type ChunkStatistics,
  type EncodedChunk,
  type EncodedRowGroup,
  finishParquetFile,
  NUMERIC_TEXT_MIN_RAW_BYTES,
  NUMERIC_TEXT_MIN_WIDE_COLUMNS,
  NUMERIC_TEXT_RE,
  NUMERIC_TEXT_SNAPPY_MAX_RATIO,
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
  entryWord0: Int32Array;
  entryWord1: Int32Array;
  entrySlot: Int32Array;
  indices: Uint32Array;
  usedEntries: number;
}

interface TextDictionary {
  entries: number;
  bitWidth: number;
  /** PLAIN dictionary page body: a length prefix and the bytes of every distinct value, in first-seen order. */
  body: Buffer;
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
  let i = 0;
  for (; i + 3 < shared; i += 4) {
    const wa = ((data[a + i] << 24) | (data[a + i + 1] << 16) | (data[a + i + 2] << 8) | data[a + i + 3]) >>> 0;
    const wb = ((data[b + i] << 24) | (data[b + i + 1] << 16) | (data[b + i + 2] << 8) | data[b + i + 3]) >>> 0;
    if (wa !== wb) return wa < wb ? -1 : 1;
  }
  for (; i < shared; i++) {
    const difference = data[a + i] - data[b + i];
    if (difference !== 0) return difference;
  }
  return aLength - bLength;
}

let sharedGroupScratch: GroupScratch | null = null;

function scratchFor(rows: number): GroupScratch {
  let slots = MIN_HASH_SLOTS;
  while (slots < rows * 2) slots *= 2;
  if (
    sharedGroupScratch &&
    sharedGroupScratch.table.length >= slots &&
    sharedGroupScratch.indices.length >= rows
  ) {
    const { table, entrySlot, usedEntries } = sharedGroupScratch;
    for (let e = 0; e < usedEntries; e++) table[entrySlot[e]] = 0;
    sharedGroupScratch.usedEntries = 0;
    return sharedGroupScratch;
  }
  sharedGroupScratch = {
    table: new Int32Array(slots),
    entryHash: new Int32Array(rows),
    entryStart: new Int32Array(rows),
    entryLength: new Int32Array(rows),
    entryWord0: new Int32Array(rows),
    entryWord1: new Int32Array(rows),
    entrySlot: new Int32Array(rows),
    indices: new Uint32Array(rows),
    usedEntries: 0,
  };
  return sharedGroupScratch;
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
  const { table, entryHash, entryStart, entryLength, entryWord0, entryWord1, entrySlot, indices } = scratch;
  let slots = MIN_HASH_SLOTS;
  while (slots < rows * 2) slots *= 2;
  const mask = slots - 1;
  for (let e = 0; e < scratch.usedEntries; e++) table[entrySlot[e]] = 0;
  scratch.usedEntries = 0;

  let entries = 0;
  let dictionaryBytes = 0;
  let bitWidth = MIN_DICTIONARY_INDEX_BIT_WIDTH;
  let nextBitThreshold = 2;
  let maxDictBytes = Math.min(maxDictionaryBytes, plainBytes - 1 - Math.ceil(rows / BITS_PER_BYTE));
  if (maxDictBytes < 0) return null;

  for (let r = 0, cell = column; r < rows; r++, cell += width) {
    const start = starts[cell];
    const length = lengths[cell];
    let w0 = 0;
    let w1 = 0;
    let hash = FNV_OFFSET;
    if (length >= 4) {
      const end = start + length;
      w0 = data[start] | (data[start + 1] << 8) | (data[start + 2] << 16) | (data[start + 3] << 24);
      w1 = data[end - 4] | (data[end - 3] << 8) | (data[end - 2] << 16) | (data[end - 1] << 24);
      let h = Math.imul(w0 ^ length, FNV_PRIME);
      h = Math.imul(h ^ w1, FNV_PRIME);
      if (length > 8) {
        const w2 = data[end - 8] | (data[end - 7] << 8) | (data[end - 6] << 16) | (data[end - 5] << 24);
        h = Math.imul(h ^ w2, FNV_PRIME);
        if (length > 16) {
          const mid = start + (length >> 1);
          const wMid = data[mid] | (data[mid + 1] << 8) | (data[mid + 2] << 16) | (data[mid + 3] << 24);
          h = Math.imul(h ^ wMid, FNV_PRIME);
        }
      }
      hash = h ^ (h >>> HASH_MIX_SHIFT);
    } else if (length > 0) {
      w0 = data[start] | (data[start + (length >> 1)] << 8) | (data[start + length - 1] << 16) | (length << 24);
      const h = Math.imul(w0 ^ FNV_OFFSET, FNV_PRIME);
      hash = h ^ (h >>> HASH_MIX_SHIFT);
    }

    let slot = hash & mask;
    let index = -1;
    for (;;) {
      const held = table[slot];
      if (held === 0) break;
      const candidate = held - 1;
      if (
        entryHash[candidate] === hash &&
        entryLength[candidate] === length &&
        entryWord0[candidate] === w0 &&
        entryWord1[candidate] === w1 &&
        (length <= 8 || sameBytes(data, entryStart[candidate] + 4, start + 4, length - 8))
      ) {
        index = candidate;
        break;
      }
      slot = (slot + 1) & mask;
    }
    if (index < 0) {
      dictionaryBytes += BYTE_ARRAY_LENGTH_PREFIX_BYTES + length;
      if (entries === nextBitThreshold) {
        bitWidth++;
        nextBitThreshold <<= 1;
        const budgetFromPlain = plainBytes - 1 - Math.ceil((rows * bitWidth) / BITS_PER_BYTE);
        if (budgetFromPlain < maxDictBytes) maxDictBytes = budgetFromPlain;
      }
      if (dictionaryBytes > maxDictBytes) {
        scratch.usedEntries = entries;
        return null;
      }
      index = entries++;
      table[slot] = entries;
      entryHash[index] = hash;
      entryStart[index] = start;
      entryLength[index] = length;
      entryWord0[index] = w0;
      entryWord1[index] = w1;
      entrySlot[index] = slot;
    }
    indices[r] = index;
    if (rows >= 1024 && r === 255 && entries === 256) {
      scratch.usedEntries = entries;
      return null;
    }
  }
  scratch.usedEntries = entries;
  const body = Buffer.allocUnsafe(dictionaryBytes);
  let at = 0;
  for (let e = 0; e < entries; e++) {
    const length = entryLength[e];
    body[at] = length;
    body[at + 1] = length >>> 8;
    body[at + 2] = length >>> 16;
    body[at + 3] = length >>> 24;
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
function splitPages(
  chunk: CellChunk,
  width: number,
  column: number,
  dictionary: boolean,
  maxRows: number,
  plainBytes: number
): Page[] {
  const { rows, lengths } = chunk;
  if (rows <= maxRows && (dictionary || plainBytes < PAGE_TARGET_BYTES)) {
    return [{ rowStart: 0, rowEnd: rows }];
  }
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

function writeAllOnesDefinitionLevels(sink: ByteSink, pageRows: number): void {
  if (pageRows === 0) {
    sink.writeUint32(0);
    return;
  }
  if (pageRows >= 8) {
    const lengthAt = sink.length;
    sink.writeUint32(0);
    sink.writeVarint(pageRows << 1);
    sink.writeByte(DEFINITION_LEVEL_BIT_WIDTH);
    sink.patchUint32(lengthAt, sink.length - lengthAt - BYTE_ARRAY_LENGTH_PREFIX_BYTES);
    return;
  }
  sink.writeUint32(2);
  sink.writeByte(3);
  sink.writeByte((1 << pageRows) - 1);
}

function zigzagVarintBytes(n: number): number {
  const v = n * 2;
  if (v < 0x80) return 1;
  if (v < 0x4000) return 2;
  if (v < 0x20_00_00) return 3;
  if (v < 0x10_00_00_00) return 4;
  return 5;
}

function isNumericTextColumn(chunk: CellChunk, width: number, column: number): boolean {
  const { data, rows, starts, lengths } = chunk;
  for (let r = 0, cell = column; r < rows; r++, cell += width) {
    const length = lengths[cell];
    if (length === 0) return false;
    const at = starts[cell];
    if (!NUMERIC_TEXT_RE.test(data.toString('latin1', at, at + length))) return false;
  }
  return true;
}

interface UncompressedTextPage {
  body: Buffer;
  numValues: number;
  statistics: ChunkStatistics;
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
  let chunkCodec = options.codec;

  const pushEncodedPage = (
    pageType: PageType,
    body: Uint8Array,
    compressed: Buffer,
    numValues: number,
    stats: ChunkStatistics | null
  ): void => {
    const encoding = pageType === PageType.DICTIONARY_PAGE ? Encoding.PLAIN : valueEncoding;
    const header = pageHeaderBytes(pageType, body.length, compressed.length, numValues, encoding, stats);
    // total_uncompressed_size counts headers as they would be written without compression.
    const uncompressedHeaderLen = header.length + zigzagVarintBytes(body.length) - zigzagVarintBytes(compressed.length);
    parts.push(header, compressed);
    position += header.length + compressed.length;
    totalCompressed += header.length + compressed.length;
    totalUncompressed += uncompressedHeaderLen + body.length;
  };

  if (dictionary) {
    dictionaryPageOffset = position;
    pushEncodedPage(PageType.DICTIONARY_PAGE, dictionary.body, compressPage(chunkCodec, dictionary.body), dictionary.entries, null);
  }
  const dataPageOffset = position;

  const pages = splitPages(chunk, width, column, dictionary !== null, options.dataPageMaxRows, plainBytes);
  const singlePage = pages.length === 1;
  let wholeStatistics: ChunkStatistics | null = null;
  const seen = dictionary && !singlePage ? new Uint8Array(dictionary.entries) : null;
  const rawPages: UncompressedTextPage[] = [];
  for (const page of pages) {
    const pageRows = page.rowEnd - page.rowStart;
    sink.reset();
    writeAllOnesDefinitionLevels(sink, pageRows);

    let minAt = -1;
    let minLength = 0;
    let maxAt = -1;
    let maxLength = 0;
    if (dictionary) {
      sink.writeByte(dictionary.bitWidth);
      encodeRleHybrid(sink, scratch.indices.subarray(page.rowStart, page.rowEnd), pageRows, dictionary.bitWidth);
      if (singlePage) {
        for (let index = 0; index < dictionary.entries; index++) {
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
      }
    } else {
      let pagePlainBytes = plainBytes;
      if (!singlePage) {
        pagePlainBytes = pageRows * BYTE_ARRAY_LENGTH_PREFIX_BYTES;
        for (let r = page.rowStart, cell = page.rowStart * width + column; r < page.rowEnd; r++, cell += width) {
          pagePlainBytes += lengths[cell];
        }
      }
      sink.ensure(pagePlainBytes);
      const sinkBytes = sink.rawBuffer();
      let writePos = sink.length;
      let minPrefix = -1;
      let maxPrefix = -1;
      for (let r = page.rowStart, cell = page.rowStart * width + column; r < page.rowEnd; r++, cell += width) {
        const at = starts[cell];
        const length = lengths[cell];
        sinkBytes[writePos] = length;
        sinkBytes[writePos + 1] = length >>> 8;
        sinkBytes[writePos + 2] = length >>> 16;
        sinkBytes[writePos + 3] = length >>> 24;
        writePos += BYTE_ARRAY_LENGTH_PREFIX_BYTES;
        if (length <= SHORT_COPY_BYTES) {
          for (let i = 0; i < length; i++) sinkBytes[writePos + i] = data[at + i];
        } else {
          data.copy(sinkBytes, writePos, at, at + length);
        }
        writePos += length;
        // The first two bytes of the value as one sortable integer; -1 for an empty value, which sorts before the rest.
        let prefix = -1;
        if (length > 0) prefix = (data[at] << 9) | (length > 1 ? data[at + 1] + 1 : 0);
        if (minAt < 0) {
          minAt = maxAt = at;
          minLength = maxLength = length;
          minPrefix = maxPrefix = prefix;
          continue;
        }
        if (prefix < minPrefix || (prefix === minPrefix && length > 1 && compareRanges(data, at, length, minAt, minLength) < 0)) {
          minAt = at;
          minLength = length;
          minPrefix = prefix;
        }
        if (prefix > maxPrefix || (prefix === maxPrefix && length > 1 && compareRanges(data, at, length, maxAt, maxLength) > 0)) {
          maxAt = at;
          maxLength = length;
          maxPrefix = prefix;
        }
      }
      sink.length = writePos;
    }
    const pageStatistics = statisticsOf(data, minAt, minLength, maxAt, maxLength);
    if (singlePage) wholeStatistics = pageStatistics;
    rawPages.push({
      body: singlePage ? sink.toBuffer() : Buffer.from(sink.toBuffer()),
      numValues: pageRows,
      statistics: pageStatistics,
    });
  }
  if (wholeStatistics === null) wholeStatistics = wholeChunkStatistics(chunk, width, column);

  const snappyCompressed = rawPages.map((p) => compressPage(chunkCodec, p.body));
  let rawSum = 0;
  let snappySum = 0;
  for (let i = 0; i < rawPages.length; i++) {
    rawSum += rawPages[i].body.length;
    snappySum += snappyCompressed[i].length;
  }
  const checkNumericGzip =
    options.autoCodec &&
    dictionary === null &&
    rows > 0 &&
    (rawSum >= NUMERIC_TEXT_MIN_RAW_BYTES || width >= NUMERIC_TEXT_MIN_WIDE_COLUMNS) &&
    snappySum > rawSum * NUMERIC_TEXT_SNAPPY_MAX_RATIO &&
    isNumericTextColumn(chunk, width, column);

  if (checkNumericGzip) {
    chunkCodec = CompressionCodec.GZIP;
    for (let i = 0; i < rawPages.length; i++) {
      const p = rawPages[i];
      pushEncodedPage(PageType.DATA_PAGE, p.body, compressPage(CompressionCodec.GZIP, p.body), p.numValues, p.statistics);
    }
  } else {
    for (let i = 0; i < rawPages.length; i++) {
      const p = rawPages[i];
      pushEncodedPage(PageType.DATA_PAGE, p.body, snappyCompressed[i], p.numValues, p.statistics);
    }
  }

  return {
    schema,
    codec: chunkCodec,
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

const sharedPageSink = new ByteSink(PARQUET_DATA_PAGE_TARGET_BYTES);

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
  const pageSink = sharedPageSink;
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
  return finishParquetFile(body, schemas, rowGroups, totalRows);
}
