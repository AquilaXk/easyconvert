import {
  BitWriter,
  ReverseBitReader,
  buildFseDecodeTable,
  buildFseEncodeTable,
  fseInitState,
  highBit32,
  normalizeFseCounts,
  readFseNormalizedTable,
  writeFseNormalizedTable,
  zstdFail,
} from './zstd-fse';
import { ZSTD_HUFFMAN_MAX_BITS, ZSTD_HUFFMAN_MAX_SYMBOL, ZSTD_WEIGHT_MAX_ACCURACY_LOG } from './zstd-tables';

/**
 * Huffman literal coding for RFC 8878 section 4.2: weight table description, canonical code
 * assignment, and 1 or 4 stream encoding/decoding.
 */

const HUFFMAN_ALPHABET_SIZE = ZSTD_HUFFMAN_MAX_SYMBOL + 1;
const DIRECT_WEIGHTS_HEADER_BASE = 127;
const DIRECT_WEIGHTS_MAX = 128;
const FSE_WEIGHTS_SIZE_LIMIT = 128;
const WEIGHT_MAX_SYMBOL = ZSTD_HUFFMAN_MAX_BITS;
const WEIGHT_FSE_MIN_ACCURACY_LOG = 5;
const NIBBLE_BITS = 4;
const NIBBLE_MASK = 0x0f;
const STREAM_COUNT = 4;
const JUMP_TABLE_BYTES = 6;
const JUMP_ENTRY_BYTES = 2;
const MAX_STREAM_BYTES = 0xffff;

export interface HuffmanDecodeTable {
  maxBits: number;
  symbol: Uint8Array;
  nbBits: Uint8Array;
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
  let index = 0;
  for (let w = 1; w <= maxBits; w++) {
    const span = 1 << (w - 1);
    const bits = maxBits + 1 - w;
    for (let s = 0; s < total; s++) {
      if (weights[s] !== w) continue;
      symbol.fill(s, index, index + span);
      nbBits.fill(bits, index, index + span);
      index += span;
    }
  }
  if (index !== size) zstdFail('Malformed Zstandard Huffman table: code space mismatch.');
  return { maxBits, symbol, nbBits };
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
  const { maxBits, symbol, nbBits } = table;
  const mask = (1 << maxBits) - 1;
  const bufLength = buf.length;
  let bitsLeft = reader.bitsLeft;
  for (let i = 0; i < count; i++) {
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
  let cursor = dataStart;
  decodeHuffmanStream(table, buf, cursor, cursor + size1, out, 0, segment);
  cursor += size1;
  decodeHuffmanStream(table, buf, cursor, cursor + size2, out, segment, segment);
  cursor += size2;
  decodeHuffmanStream(table, buf, cursor, cursor + size3, out, 2 * segment, segment);
  cursor += size3;
  decodeHuffmanStream(table, buf, cursor, end, out, 3 * segment, lastSegment);
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

export interface HuffmanEncodeTable {
  maxBits: number;
  maxSymbol: number;
  lengths: Uint8Array;
  codes: Uint16Array;
}

/** Unrestricted Huffman code lengths for the symbols in `symbols` (sorted by ascending frequency). */
function huffmanTreeLengths(histogram: Uint32Array, symbols: number[]): Uint8Array {
  const n = symbols.length;
  const weight = new Float64Array(2 * n);
  const parent = new Int32Array(2 * n);
  for (let i = 0; i < n; i++) weight[i] = histogram[symbols[i]];
  let leaf = 0;
  let queueHead = n;
  let queueTail = n;
  for (let k = 0; k < n - 1; k++) {
    let a: number;
    if (leaf < n && (queueHead >= queueTail || weight[leaf] <= weight[queueHead])) a = leaf++;
    else a = queueHead++;
    let b: number;
    if (leaf < n && (queueHead >= queueTail || weight[leaf] <= weight[queueHead])) b = leaf++;
    else b = queueHead++;
    weight[queueTail] = weight[a] + weight[b];
    parent[a] = queueTail;
    parent[b] = queueTail;
    queueTail++;
  }
  const depth = new Uint8Array(2 * n);
  const lengths = new Uint8Array(n);
  const root = 2 * n - 2;
  for (let i = root - 1; i >= 0; i--) depth[i] = depth[parent[i]] + 1;
  for (let i = 0; i < n; i++) lengths[i] = depth[i];
  return lengths;
}

/** Restricts lengths to `limit` bits while keeping the code complete (Kraft sum exactly 1). */
function limitHuffmanLengths(lengths: Uint8Array, frequency: Float64Array, limit: number): void {
  const n = lengths.length;
  let maxLength = 0;
  for (let i = 0; i < n; i++) if (lengths[i] > maxLength) maxLength = lengths[i];
  if (maxLength <= limit) return;
  const target = 1 << limit;
  let kraft = 0;
  for (let i = 0; i < n; i++) {
    if (lengths[i] > limit) lengths[i] = limit;
    kraft += 1 << (limit - lengths[i]);
  }
  while (kraft > target) {
    let pick = -1;
    for (let i = 0; i < n; i++) {
      if (lengths[i] >= limit) continue;
      if (pick < 0 || lengths[i] > lengths[pick] || (lengths[i] === lengths[pick] && frequency[i] < frequency[pick])) {
        pick = i;
      }
    }
    if (pick < 0) zstdFail('Zstandard Huffman length limiting failed.');
    kraft -= 1 << (limit - lengths[pick] - 1);
    lengths[pick]++;
  }
  while (kraft < target) {
    const deficit = target - kraft;
    let pick = -1;
    for (let i = 0; i < n; i++) {
      const unit = 1 << (limit - lengths[i]);
      if (lengths[i] < 2 || unit > deficit) continue;
      if (pick < 0 || lengths[i] > lengths[pick] || (lengths[i] === lengths[pick] && frequency[i] > frequency[pick])) {
        pick = i;
      }
    }
    if (pick < 0) zstdFail('Zstandard Huffman length repair failed.');
    kraft += 1 << (limit - lengths[pick]);
    lengths[pick]--;
  }
}

/**
 * Builds a canonical Huffman code (max 11 bits) for the histogram. Returns null when fewer than
 * two distinct symbols are present (callers use RLE literals in that case).
 */
export function buildHuffmanEncodeTable(histogram: Uint32Array): HuffmanEncodeTable | null {
  const symbols: number[] = [];
  for (let s = 0; s < HUFFMAN_ALPHABET_SIZE; s++) if (histogram[s] > 0) symbols.push(s);
  if (symbols.length < 2) return null;
  symbols.sort((a, b) => histogram[a] - histogram[b] || a - b);
  const lengths = huffmanTreeLengths(histogram, symbols);
  const frequency = new Float64Array(symbols.length);
  for (let i = 0; i < symbols.length; i++) frequency[i] = histogram[symbols[i]];
  limitHuffmanLengths(lengths, frequency, ZSTD_HUFFMAN_MAX_BITS);
  let maxBits = 0;
  let maxSymbol = 0;
  const symbolLengths = new Uint8Array(HUFFMAN_ALPHABET_SIZE);
  for (let i = 0; i < symbols.length; i++) {
    symbolLengths[symbols[i]] = lengths[i];
    if (lengths[i] > maxBits) maxBits = lengths[i];
    if (symbols[i] > maxSymbol) maxSymbol = symbols[i];
  }
  // Canonical assignment mirrors the decoder: ascending weight (descending length), then symbol.
  const codes = new Uint16Array(HUFFMAN_ALPHABET_SIZE);
  let index = 0;
  for (let w = 1; w <= maxBits; w++) {
    const length = maxBits + 1 - w;
    for (let s = 0; s <= maxSymbol; s++) {
      if (symbolLengths[s] !== length) continue;
      codes[s] = index >> (w - 1);
      index += 1 << (w - 1);
    }
  }
  return { maxBits, maxSymbol, lengths: symbolLengths, codes };
}

/** Estimated payload bits of encoding the histogram with the table. */
export function estimateHuffmanBits(table: HuffmanEncodeTable, histogram: Uint32Array): number {
  let bits = 0;
  for (let s = 0; s <= table.maxSymbol; s++) bits += histogram[s] * table.lengths[s];
  return bits;
}

/**
 * Writes the tree description for `table` at out[pos..]. Chooses the smaller of the FSE-compressed
 * and direct nibble forms. Returns the end position, or -1 when it does not fit before `cap`.
 */
export function writeHuffmanTableDescription(
  table: HuffmanEncodeTable,
  out: Uint8Array,
  pos: number,
  cap: number
): number {
  const count = table.maxSymbol;
  const weights = new Uint8Array(count);
  for (let s = 0; s < count; s++) {
    weights[s] = table.lengths[s] > 0 ? table.maxBits + 1 - table.lengths[s] : 0;
  }
  const scratch = new Uint8Array(HUFFMAN_ALPHABET_SIZE);
  let compressedEnd = -1;
  if (count >= 2) {
    compressedEnd = writeFseCompressedWeights(weights, scratch);
  }
  const directSize = 1 + ((count + 1) >> 1);
  const useDirect = count <= DIRECT_WEIGHTS_MAX && (compressedEnd < 0 || directSize <= compressedEnd);
  if (useDirect) {
    if (pos + directSize > cap) return -1;
    out[pos] = DIRECT_WEIGHTS_HEADER_BASE + count;
    out.fill(0, pos + 1, pos + directSize);
    for (let i = 0; i < count; i++) {
      out[pos + 1 + (i >> 1)] |= (i & 1) === 0 ? weights[i] << NIBBLE_BITS : weights[i];
    }
    return pos + directSize;
  }
  if (compressedEnd < 0) zstdFail('Zstandard Huffman table does not fit either weight encoding.');
  if (pos + 1 + compressedEnd > cap) return -1;
  out[pos] = compressedEnd;
  out.set(scratch.subarray(0, compressedEnd), pos + 1);
  return pos + 1 + compressedEnd;
}

/** FSE-compresses the weights into `scratch`. Returns the byte length, or -1 when not applicable. */
function writeFseCompressedWeights(weights: Uint8Array, scratch: Uint8Array): number {
  const count = weights.length;
  const histogram = new Uint32Array(WEIGHT_MAX_SYMBOL + 1);
  let maxSymbol = 0;
  for (let i = 0; i < count; i++) {
    histogram[weights[i]]++;
    if (weights[i] > maxSymbol) maxSymbol = weights[i];
  }
  let distinct = 0;
  for (let s = 0; s <= maxSymbol; s++) if (histogram[s] > 0) distinct++;
  if (distinct < 2) return -1;
  let best = -1;
  const candidate = new Uint8Array(scratch.length);
  for (let accuracyLog = WEIGHT_FSE_MIN_ACCURACY_LOG; accuracyLog <= ZSTD_WEIGHT_MAX_ACCURACY_LOG; accuracyLog++) {
    if (1 << accuracyLog < distinct) continue;
    const counts = normalizeFseCounts(histogram, maxSymbol, count, accuracyLog);
    const tableEnd = writeFseNormalizedTable(candidate, 0, counts, maxSymbol, accuracyLog);
    if (tableEnd < 0) continue;
    const end = encodeWeightStream(weights, counts, maxSymbol, accuracyLog, candidate, tableEnd);
    if (end < 0 || end >= FSE_WEIGHTS_SIZE_LIMIT) continue;
    if (best < 0 || end < best) {
      best = end;
      scratch.set(candidate.subarray(0, end));
    }
  }
  return best;
}

/** Encodes weights with two interleaved FSE states (RFC 8878 section 4.2.1.2). */
function encodeWeightStream(
  weights: Uint8Array,
  counts: Int16Array,
  maxSymbol: number,
  accuracyLog: number,
  out: Uint8Array,
  pos: number
): number {
  const table = buildFseEncodeTable(counts, maxSymbol, accuracyLog);
  const writer = new BitWriter(out, pos);
  const n = weights.length;
  let state1 = 0;
  let state2 = 0;
  let i = n - 1;
  // The last symbol and the one before it seed the two states, matching the decoder's order.
  if ((i & 1) === 0) {
    state1 = fseInitState(table, weights[i]);
    state2 = fseInitState(table, weights[i - 1]);
  } else {
    state2 = fseInitState(table, weights[i]);
    state1 = fseInitState(table, weights[i - 1]);
  }
  i -= 2;
  for (; i >= 0; i--) {
    const symbol = weights[i];
    const isState1 = (i & 1) === 0;
    const state = isState1 ? state1 : state2;
    const nbBitsOut = (state + table.deltaNbBits[symbol]) >> 16;
    writer.write(state & ((1 << nbBitsOut) - 1), nbBitsOut);
    const next = table.stateTable[(state >> nbBitsOut) + table.deltaFindState[symbol]];
    if (isState1) state1 = next;
    else state2 = next;
  }
  writer.write(state2 - (1 << accuracyLog), accuracyLog);
  writer.write(state1 - (1 << accuracyLog), accuracyLog);
  const end = writer.closeWithStopBit();
  return writer.overflow ? -1 : end;
}

/** Encodes src[start..end) as one backward Huffman stream. Returns the end position or -1 on overflow. */
function encodeHuffmanStream(
  table: HuffmanEncodeTable,
  src: Uint8Array,
  start: number,
  end: number,
  out: Uint8Array,
  pos: number,
  cap: number
): number {
  const writer = new BitWriter(out, pos, cap);
  const { codes, lengths } = table;
  for (let i = end - 1; i >= start; i--) {
    const s = src[i];
    writer.write(codes[s], lengths[s]);
  }
  const written = writer.closeWithStopBit();
  return writer.overflow ? -1 : written;
}

/**
 * Encodes literals as 1 or 4 Huffman streams at out[pos..cap). Returns the end position, or -1 when
 * the payload does not fit or a stream exceeds the jump table's 16-bit size field.
 */
export function encodeHuffmanLiterals(
  table: HuffmanEncodeTable,
  src: Uint8Array,
  length: number,
  fourStreams: boolean,
  out: Uint8Array,
  pos: number,
  cap: number
): number {
  if (!fourStreams) return encodeHuffmanStream(table, src, 0, length, out, pos, cap);
  const segment = (length + STREAM_COUNT - 1) >> 2;
  const dataStart = pos + JUMP_TABLE_BYTES;
  if (dataStart > cap) return -1;
  let cursor = dataStart;
  const bounds = [0, segment, 2 * segment, 3 * segment, length];
  for (let k = 0; k < STREAM_COUNT; k++) {
    const end = encodeHuffmanStream(table, src, bounds[k], bounds[k + 1], out, cursor, cap);
    if (end < 0) return -1;
    const size = end - cursor;
    if (k < STREAM_COUNT - 1) {
      if (size > MAX_STREAM_BYTES) return -1;
      out[pos + k * JUMP_ENTRY_BYTES] = size & 0xff;
      out[pos + k * JUMP_ENTRY_BYTES + 1] = size >> 8;
    }
    cursor = end;
  }
  return cursor;
}
