import {
  ReverseBitReader,
  buildFseDecodeTable,
  highBit32,
  readFseNormalizedTable,
  zstdFail,
} from './zstd-fse';
import { ZSTD_HUFFMAN_MAX_BITS, ZSTD_HUFFMAN_MAX_SYMBOL, ZSTD_WEIGHT_MAX_ACCURACY_LOG } from './zstd-tables';

/**
 * Huffman literal decoding for RFC 8878 section 4.2: weight table description, canonical code
 * assignment, and 1 or 4 stream decoding.
 */

const HUFFMAN_ALPHABET_SIZE = ZSTD_HUFFMAN_MAX_SYMBOL + 1;
const DIRECT_WEIGHTS_HEADER_BASE = 127;
const WEIGHT_MAX_SYMBOL = ZSTD_HUFFMAN_MAX_BITS;
const NIBBLE_BITS = 4;
const NIBBLE_MASK = 0x0f;
const STREAM_COUNT = 4;
const JUMP_TABLE_BYTES = 6;

export interface HuffmanDecodeTable {
  maxBits: number;
  symbol: Uint8Array;
  nbBits: Uint8Array;
  /** `symbol` in the low byte and `nbBits` above it, so a decoded symbol costs one table read. */
  entry: Uint16Array;
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function weightsToDecodeTable(weights: Uint8Array, count: number): HuffmanDecodeTable {
  let sum = 0;
  for (let i = 0; i < count; i++) {
    if (weights[i] > 0) sum += 1 << (weights[i] - 1);
  }
  if (sum === 0) zstdFail('Malformed Zstandard Huffman table: no weighted symbols.');
  const maxBits = highBit32(sum) + 1;
  if (maxBits > ZSTD_HUFFMAN_MAX_BITS) zstdFail('Malformed Zstandard Huffman table: code length exceeds 11 bits.');
  const rest = (1 << maxBits) - sum;
  if (rest === 0 || (rest & (rest - 1)) !== 0) {
    zstdFail('Malformed Zstandard Huffman table: weights do not form a complete code.');
  }
  if (count > ZSTD_HUFFMAN_MAX_SYMBOL) zstdFail('Malformed Zstandard Huffman table: too many symbols.');
  weights[count] = highBit32(rest) + 1;
  const total = count + 1;
  const size = 1 << maxBits;
  const symbol = new Uint8Array(size);
  const nbBits = new Uint8Array(size);
  const entry = new Uint16Array(size);
  let index = 0;
  for (let w = 1; w <= maxBits; w++) {
    const span = 1 << (w - 1);
    const bits = maxBits + 1 - w;
    for (let s = 0; s < total; s++) {
      if (weights[s] !== w) continue;
      symbol.fill(s, index, index + span);
      nbBits.fill(bits, index, index + span);
      entry.fill((bits << 8) | s, index, index + span);
      index += span;
    }
  }
  if (index !== size) zstdFail('Malformed Zstandard Huffman table: code space mismatch.');
  return { maxBits, symbol, nbBits, entry };
}

/** Reads a Huffman tree description (RFC 8878 section 4.2.1). */
export function readHuffmanTable(
  buf: Uint8Array,
  start: number,
  end: number
): { table: HuffmanDecodeTable; bytesRead: number } {
  if (start >= end) zstdFail('Malformed Zstandard Huffman table: truncated header.');
  const header = buf[start];
  const weights = new Uint8Array(HUFFMAN_ALPHABET_SIZE + 1);
  let count = 0;
  let bytesRead: number;
  if (header >= 128) {
    count = header - DIRECT_WEIGHTS_HEADER_BASE;
    bytesRead = 1 + ((count + 1) >> 1);
    if (start + bytesRead > end) zstdFail('Malformed Zstandard Huffman table: truncated direct weights.');
    for (let i = 0; i < count; i++) {
      const byte = buf[start + 1 + (i >> 1)];
      weights[i] = (i & 1) === 0 ? byte >> NIBBLE_BITS : byte & NIBBLE_MASK;
    }
  } else {
    bytesRead = 1 + header;
    if (header === 0 || start + bytesRead > end) {
      zstdFail('Malformed Zstandard Huffman table: invalid compressed weights size.');
    }
    const payloadEnd = start + bytesRead;
    const parsed = readFseNormalizedTable(buf, start + 1, payloadEnd, WEIGHT_MAX_SYMBOL, ZSTD_WEIGHT_MAX_ACCURACY_LOG);
    const fse = buildFseDecodeTable(parsed.table.counts, parsed.table.maxSymbol, parsed.table.accuracyLog);
    const streamStart = start + 1 + parsed.bytesRead;
    if (streamStart >= payloadEnd) zstdFail('Malformed Zstandard Huffman table: missing weight stream.');
    const reader = new ReverseBitReader(buf, streamStart, payloadEnd);
    let state1 = reader.read(fse.accuracyLog);
    let state2 = reader.read(fse.accuracyLog);
    for (;;) {
      if (count >= ZSTD_HUFFMAN_MAX_SYMBOL) zstdFail('Malformed Zstandard Huffman table: too many weights.');
      weights[count++] = fse.symbol[state1];
      state1 = fse.base[state1] + reader.read(fse.nbBits[state1]);
      if (reader.overflowed) {
        weights[count++] = fse.symbol[state2];
        break;
      }
      if (count >= ZSTD_HUFFMAN_MAX_SYMBOL) zstdFail('Malformed Zstandard Huffman table: too many weights.');
      weights[count++] = fse.symbol[state2];
      state2 = fse.base[state2] + reader.read(fse.nbBits[state2]);
      if (reader.overflowed) {
        weights[count++] = fse.symbol[state1];
        break;
      }
    }
  }
  for (let i = 0; i < count; i++) {
    if (weights[i] > ZSTD_HUFFMAN_MAX_BITS) zstdFail('Malformed Zstandard Huffman table: weight out of range.');
  }
  return { table: weightsToDecodeTable(weights, count), bytesRead };
}

/**
 * Decodes exactly `count` symbols from one backward Huffman stream into `out`.
 *
 * The hot loop reads the next `maxBits` bits straight from the byte array (a 32-bit little-endian window shifted to the
 * bit position) instead of going through ReverseBitReader. Bytes past `end` can enter the window only in bits above the
 * ones the index uses, which the mask drops; the slow branch handles the last bytes of the buffer and positions below 0
 * (bits before the stream start read as zero, as in ReverseBitReader).
 */
export function decodeHuffmanStream(
  table: HuffmanDecodeTable,
  buf: Uint8Array,
  start: number,
  end: number,
  out: Uint8Array,
  outStart: number,
  count: number
): void {
  if (count === 0) {
    if (end - start !== 0) zstdFail('Malformed Zstandard Huffman stream: unexpected data for empty stream.');
    return;
  }
  const reader = new ReverseBitReader(buf, start, end);
  finishHuffmanStream(table, buf, start, end, reader, out, outStart, count, 0, reader.bitsLeft);
}

/**
 * Decodes the symbols from `done` to `count` of a stream whose first `done` symbols are written and whose unread bits
 * are `bitsLeft`: in bulk while a 32-bit container can be refilled from inside the stream, then one at a time for the
 * last few bytes.
 */
function finishHuffmanStream(
  table: HuffmanDecodeTable,
  buf: Uint8Array,
  start: number,
  end: number,
  reader: ReverseBitReader,
  out: Uint8Array,
  outStart: number,
  count: number,
  done: number,
  bitsLeftNow: number
): void {
  const { maxBits, symbol, nbBits } = table;
  const mask = (1 << maxBits) - 1;
  const bufLength = buf.length;
  const decoded = decodeHuffmanBulk(table, buf, start, bitsLeftNow, out, outStart, count, done);
  let bitsLeft = decoded.bitsLeft;
  for (let i = decoded.symbols; i < count; i++) {
    const pos = bitsLeft - maxBits;
    const at = start + (pos >> 3);
    let index: number;
    if (pos >= 0 && at + 3 < bufLength) {
      index = (((buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16) | (buf[at + 3] << 24)) >>> (pos & 7)) & mask) | 0;
    } else {
      reader.bitsLeft = bitsLeft;
      index = reader.peek(maxBits);
    }
    out[outStart + i] = symbol[index];
    bitsLeft -= nbBits[index];
  }
  if (bitsLeft !== 0) zstdFail('Malformed Zstandard Huffman stream: bitstream not fully consumed.');
}

/** Bytes a 32-bit bit container holds. */
const CONTAINER_BYTES = 4;
const CONTAINER_BITS = 32;

/**
 * Decodes symbols from the top of a 32-bit container of the stream's bytes (the stream is read from its end, so the
 * container is the little-endian word whose highest byte holds the next bit), refilling by whole consumed bytes. One
 * refill serves two or three symbols where reading each symbol from the byte array would load four bytes per symbol.
 * It stops, with the position it reached, when the next refill would reach below `start`; the caller finishes those
 * last symbols one at a time. The result is exactly what the one-at-a-time reader produces.
 */
function decodeHuffmanBulk(
  table: HuffmanDecodeTable,
  buf: Uint8Array,
  start: number,
  bitsLeftAtEnd: number,
  out: Uint8Array,
  outStart: number,
  count: number,
  done: number
): { symbols: number; bitsLeft: number } {
  const topBit = bitsLeftAtEnd - 1;
  const topByte = topBit >> 3;
  if (topByte < CONTAINER_BYTES - 1) return { symbols: done, bitsLeft: bitsLeftAtEnd };
  const { maxBits, entry } = table;
  const shift = CONTAINER_BITS - maxBits;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let ptr = start + topByte - (CONTAINER_BYTES - 1);
  let consumed = 7 - (topBit & 7);
  let container = view.getInt32(ptr, true);
  let i = done;
  while (i < count) {
    if (consumed > shift) {
      const next = ptr - (consumed >> 3);
      if (next < start) break;
      ptr = next;
      consumed &= 7;
      container = view.getInt32(ptr, true);
    }
    const e = entry[(container << consumed) >>> shift];
    out[outStart + i] = e & 0xff;
    consumed += e >>> 8;
    i++;
  }
  return { symbols: i, bitsLeft: (ptr - start + CONTAINER_BYTES) * 8 - consumed };
}

/** Decodes a Huffman-coded literals payload of 1 or 4 streams into `out`. */
export function decodeHuffmanLiterals(
  table: HuffmanDecodeTable,
  buf: Uint8Array,
  start: number,
  end: number,
  out: Uint8Array,
  regeneratedSize: number,
  fourStreams: boolean
): void {
  if (!fourStreams) {
    decodeHuffmanStream(table, buf, start, end, out, 0, regeneratedSize);
    return;
  }
  if (end - start < JUMP_TABLE_BYTES) zstdFail('Malformed Zstandard literals: truncated jump table.');
  const size1 = buf[start] | (buf[start + 1] << 8);
  const size2 = buf[start + 2] | (buf[start + 3] << 8);
  const size3 = buf[start + 4] | (buf[start + 5] << 8);
  const dataStart = start + JUMP_TABLE_BYTES;
  const size4 = end - dataStart - size1 - size2 - size3;
  if (size4 < 1) zstdFail('Malformed Zstandard literals: stream sizes exceed payload.');
  const segment = (regeneratedSize + STREAM_COUNT - 1) >> 2;
  const lastSegment = regeneratedSize - 3 * segment;
  if (lastSegment < 0) zstdFail('Malformed Zstandard literals: too few literals for four streams.');
  const starts = [dataStart, dataStart + size1, dataStart + size1 + size2, dataStart + size1 + size2 + size3];
  const ends = [starts[1], starts[2], starts[3], end];
  const readers = starts.map((at, k) => new ReverseBitReader(buf, at, ends[k]));
  const positions = readers.map((reader) => reader.bitsLeft);
  // The streams advance in lockstep, so that the four chains of dependent table reads overlap.
  const lockstep = decodeFourStreamsLockstep(table, buf, starts, positions, out, segment, lastSegment);
  for (let k = 0; k < STREAM_COUNT; k++) {
    const length = k < STREAM_COUNT - 1 ? segment : lastSegment;
    finishHuffmanStream(table, buf, starts[k], ends[k], readers[k], out, k * segment, length, lockstep.symbols, lockstep.bitsLeft[k]);
  }
}

/** Four streams of a block carry `segment`, `segment`, `segment` and `lastSegment` symbols. */
function decodeFourStreamsLockstep(
  table: HuffmanDecodeTable,
  buf: Uint8Array,
  starts: readonly number[],
  bitsLeftAtEnd: readonly number[],
  out: Uint8Array,
  segment: number,
  lastSegment: number
): { symbols: number; bitsLeft: number[] } {
  const entry = table.entry;
  const shift = CONTAINER_BITS - table.maxBits;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const lockstepCount = Math.min(segment, lastSegment);
  const bitsLeft = [...bitsLeftAtEnd];
  for (let k = 0; k < STREAM_COUNT; k++) {
    if (((bitsLeftAtEnd[k] - 1) >> 3) < CONTAINER_BYTES - 1) return { symbols: 0, bitsLeft };
  }
  const start0 = starts[0];
  const start1 = starts[1];
  const start2 = starts[2];
  const start3 = starts[3];
  let ptr0 = start0 + ((bitsLeftAtEnd[0] - 1) >> 3) - (CONTAINER_BYTES - 1);
  let ptr1 = start1 + ((bitsLeftAtEnd[1] - 1) >> 3) - (CONTAINER_BYTES - 1);
  let ptr2 = start2 + ((bitsLeftAtEnd[2] - 1) >> 3) - (CONTAINER_BYTES - 1);
  let ptr3 = start3 + ((bitsLeftAtEnd[3] - 1) >> 3) - (CONTAINER_BYTES - 1);
  let used0 = 7 - ((bitsLeftAtEnd[0] - 1) & 7);
  let used1 = 7 - ((bitsLeftAtEnd[1] - 1) & 7);
  let used2 = 7 - ((bitsLeftAtEnd[2] - 1) & 7);
  let used3 = 7 - ((bitsLeftAtEnd[3] - 1) & 7);
  let word0 = view.getInt32(ptr0, true);
  let word1 = view.getInt32(ptr1, true);
  let word2 = view.getInt32(ptr2, true);
  let word3 = view.getInt32(ptr3, true);
  const out1 = segment;
  const out2 = 2 * segment;
  const out3 = 3 * segment;
  let i = 0;
  while (i < lockstepCount) {
    // A refill below the start of its stream ends the lockstep; the stream is finished on its own.
    if (used0 > shift) {
      const next = ptr0 - (used0 >> 3);
      if (next < start0) break;
      ptr0 = next;
      used0 &= 7;
      word0 = view.getInt32(ptr0, true);
    }
    if (used1 > shift) {
      const next = ptr1 - (used1 >> 3);
      if (next < start1) break;
      ptr1 = next;
      used1 &= 7;
      word1 = view.getInt32(ptr1, true);
    }
    if (used2 > shift) {
      const next = ptr2 - (used2 >> 3);
      if (next < start2) break;
      ptr2 = next;
      used2 &= 7;
      word2 = view.getInt32(ptr2, true);
    }
    if (used3 > shift) {
      const next = ptr3 - (used3 >> 3);
      if (next < start3) break;
      ptr3 = next;
      used3 &= 7;
      word3 = view.getInt32(ptr3, true);
    }
    const e0 = entry[(word0 << used0) >>> shift];
    const e1 = entry[(word1 << used1) >>> shift];
    const e2 = entry[(word2 << used2) >>> shift];
    const e3 = entry[(word3 << used3) >>> shift];
    out[i] = e0 & 0xff;
    out[out1 + i] = e1 & 0xff;
    out[out2 + i] = e2 & 0xff;
    out[out3 + i] = e3 & 0xff;
    used0 += e0 >>> 8;
    used1 += e1 >>> 8;
    used2 += e2 >>> 8;
    used3 += e3 >>> 8;
    i++;
  }
  bitsLeft[0] = (ptr0 - start0 + CONTAINER_BYTES) * 8 - used0;
  bitsLeft[1] = (ptr1 - start1 + CONTAINER_BYTES) * 8 - used1;
  bitsLeft[2] = (ptr2 - start2 + CONTAINER_BYTES) * 8 - used2;
  bitsLeft[3] = (ptr3 - start3 + CONTAINER_BYTES) * 8 - used3;
  return { symbols: i, bitsLeft };
}
