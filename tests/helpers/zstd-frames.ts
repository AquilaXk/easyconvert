import { expect } from 'vitest';

/**
 * Hand-built Zstandard frame fixtures for decoder tests. Everything here is written from the
 * RFC 8878 wire format and shares no code with src/lib/conversions/zstd*.ts, so a mistake in the
 * production encoder or decoder cannot also hide in the oracle.
 */

export const ZSTD_TEST_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const BLOCK_RAW = 0;
const BLOCK_RLE = 1;
const BLOCK_COMPRESSED = 2;
const BLOCK_MAX = 128 * 1024;
const WINDOW_LOG_MIN = 10;

export interface TestBlock {
  type: number;
  /** Decoded size for RLE blocks, otherwise the payload length. */
  size: number;
  payload: Buffer;
  last?: boolean;
}

export function rawBlock(data: Buffer): TestBlock {
  return { type: BLOCK_RAW, size: data.length, payload: data };
}

export function rleBlock(byte: number, size: number): TestBlock {
  return { type: BLOCK_RLE, size, payload: Buffer.from([byte]) };
}

export function compressedBlock(payload: Buffer): TestBlock {
  return { type: BLOCK_COMPRESSED, size: payload.length, payload };
}

function blockHeader(block: TestBlock, last: boolean): Buffer {
  const value = (last ? 1 : 0) | (block.type << 1) | (block.size << 3);
  return Buffer.from([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff]);
}

export interface TestFrameOptions {
  /** Window descriptor exponent (window = 2^(10 + n)); omit with `singleSegment`. */
  windowLog?: number;
  singleSegment?: boolean;
  /** Frame_Content_Size; written with the smallest legal field. */
  contentSize?: number;
  checksum?: Buffer;
}

/** Builds a frame from explicit blocks. The last block gets the last-block flag. */
export function buildFrame(blocks: TestBlock[], options: TestFrameOptions = {}): Buffer {
  const singleSegment = options.singleSegment === true;
  const contentSize = options.contentSize;
  let fcsFlag = 0;
  let fcs = Buffer.alloc(0);
  if (contentSize !== undefined) {
    if (singleSegment && contentSize < 256) {
      fcsFlag = 0;
      fcs = Buffer.from([contentSize]);
    } else if (contentSize >= 256 && contentSize < 65536 + 256) {
      fcsFlag = 1;
      fcs = Buffer.alloc(2);
      fcs.writeUInt16LE(contentSize - 256);
    } else if (contentSize < 2 ** 32) {
      fcsFlag = 2;
      fcs = Buffer.alloc(4);
      fcs.writeUInt32LE(contentSize);
    } else {
      fcsFlag = 3;
      fcs = Buffer.alloc(8);
      fcs.writeBigUInt64LE(BigInt(contentSize));
    }
  }
  const fhd = (fcsFlag << 6) | ((singleSegment ? 1 : 0) << 5) | ((options.checksum ? 1 : 0) << 2);
  const parts: Buffer[] = [ZSTD_TEST_MAGIC, Buffer.from([fhd])];
  if (!singleSegment) parts.push(Buffer.from([((options.windowLog ?? 17) - WINDOW_LOG_MIN) << 3]));
  parts.push(fcs);
  blocks.forEach((block, index) => {
    parts.push(blockHeader(block, index === blocks.length - 1), block.payload);
  });
  if (options.checksum) parts.push(options.checksum);
  return Buffer.concat(parts);
}

/** A frame of `blockCount` 128 KiB RLE blocks: ratio 32768:1, no content size or checksum. */
export function buildRleBombFrame(blockCount: number): Buffer {
  const blocks: TestBlock[] = [];
  for (let i = 0; i < blockCount; i++) blocks.push(rleBlock(0, BLOCK_MAX));
  return buildFrame(blocks, { windowLog: 17 });
}

/** Single-segment frame holding `data` in one raw block, with the exact content size. */
export function buildRawFrame(data: Buffer): Buffer {
  return buildFrame([rawBlock(data)], { singleSegment: true, contentSize: data.length });
}

// ---------------------------------------------------------------------------
// Compressed-block builders
// ---------------------------------------------------------------------------

/** Predefined distributions from RFC 8878 section 3.1.1.3.2.2.1 (-1 = less than one slot). */
const LL_DEFAULT = [4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1];
const ML_DEFAULT = [1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1];
const OF_DEFAULT = [1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1];

/** Maps every FSE state to its symbol using the spreading rule of section 4.1.1. */
function stateSymbols(distribution: number[], accuracyLog: number): number[] {
  const size = 1 << accuracyLog;
  const table = new Array<number>(size).fill(-1);
  let high = size - 1;
  distribution.forEach((count, symbol) => {
    if (count === -1) table[high--] = symbol;
  });
  const step = (size >> 1) + (size >> 3) + 3;
  let pos = 0;
  distribution.forEach((count, symbol) => {
    for (let i = 0; i < count; i++) {
      table[pos] = symbol;
      do {
        pos = (pos + step) & (size - 1);
      } while (pos > high);
    }
  });
  return table;
}

const LL_STATES = stateSymbols(LL_DEFAULT, 6);
const OF_STATES = stateSymbols(OF_DEFAULT, 5);
const ML_STATES = stateSymbols(ML_DEFAULT, 6);

const LL_BASE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
const LL_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

/** LSB-first writer; bit 0 of the first byte is the first bit written. */
class TestBitWriter {
  private readonly bytes: number[] = [];
  private bitCount = 0;

  public write(value: number, bits: number): void {
    for (let i = 0; i < bits; i++) {
      if (this.bitCount % 8 === 0) this.bytes.push(0);
      if (Math.floor(value / 2 ** i) % 2 === 1) this.bytes[this.bytes.length - 1] |= 1 << (this.bitCount % 8);
      this.bitCount++;
    }
  }

  /** Appends the end mark and returns the stream. */
  public finish(): Buffer {
    this.write(1, 1);
    return Buffer.from(this.bytes);
  }
}

export interface OneSequence {
  litLen: number;
  matchLen: number;
  /** Offset_Value field: 1-3 are repeat codes, otherwise offset + 3. */
  offsetValue: number;
}

function llCodeFor(litLen: number): number {
  let code = 0;
  while (code + 1 < LL_BASE.length && LL_BASE[code + 1] <= litLen) code++;
  return code;
}

function mlCodeFor(matchLen: number): { code: number; extraBits: number; base: number } {
  if (matchLen <= 34) return { code: matchLen - 3, extraBits: 0, base: matchLen };
  const bases = [35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051, 4099, 8195, 16387, 32771, 65539];
  const extras = [1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  let index = 0;
  while (index + 1 < bases.length && bases[index + 1] <= matchLen) index++;
  return { code: 32 + index, extraBits: extras[index], base: bases[index] };
}

/**
 * A compressed block with raw literals and exactly one sequence coded with the predefined
 * tables (so no state updates follow the initial states).
 */
export function singleSequenceBlock(literals: Buffer, seq: OneSequence): Buffer {
  const llCode = llCodeFor(seq.litLen);
  const mlInfo = mlCodeFor(seq.matchLen);
  const ofCode = Math.floor(Math.log2(seq.offsetValue));
  const llState = LL_STATES.indexOf(llCode);
  const ofState = OF_STATES.indexOf(ofCode);
  const mlState = ML_STATES.indexOf(mlInfo.code);
  if (llState < 0 || ofState < 0 || mlState < 0) throw new Error('Test fixture: symbol absent from predefined table.');

  // Reverse of the decoder's read order: literal-length extra, match-length extra, offset extra, then the states.
  const writer = new TestBitWriter();
  writer.write(seq.litLen - LL_BASE[llCode], LL_EXTRA[llCode]);
  writer.write(seq.matchLen - mlInfo.base, mlInfo.extraBits);
  writer.write(seq.offsetValue - 2 ** ofCode, ofCode);
  writer.write(mlState, 6);
  writer.write(ofState, 5);
  writer.write(llState, 6);
  return Buffer.concat([rawLiteralsSection(literals), Buffer.from([1, 0x00]), writer.finish()]);
}

export function rawLiteralsSection(literals: Buffer): Buffer {
  const n = literals.length;
  if (n < 32) return Buffer.concat([Buffer.from([n << 3]), literals]);
  if (n < 4096) return Buffer.concat([Buffer.from([0x04 | ((n & 0x0f) << 4), n >> 4]), literals]);
  return Buffer.concat([Buffer.from([0x0c | ((n & 0x0f) << 4), (n >> 4) & 0xff, n >> 12]), literals]);
}

/** Sequence-count header in the 1-, 2- or 3-byte form (RFC 8878 section 3.1.1.3.2.1). */
export function sequenceCountBytes(count: number): Buffer {
  if (count < 128) return Buffer.from([count]);
  if (count < 0x7f00) return Buffer.from([(count >> 8) + 128, count & 0xff]);
  return Buffer.from([255, (count - 0x7f00) & 0xff, (count - 0x7f00) >> 8]);
}

/**
 * A block of `count` sequences that all use RLE tables (literal length 1, match length 3, offset
 * code 2 with extra 0, i.e. offset 1), so the stream carries only two offset bits per sequence.
 * Decodes to `4 * count` copies of `byte`.
 */
export function rleTableSequencesBlock(count: number, byte: number): Buffer {
  const literals = Buffer.alloc(count, byte);
  const writer = new TestBitWriter();
  for (let i = 0; i < count; i++) writer.write(0, 2);
  const modes = (1 << 6) | (1 << 4) | (1 << 2);
  return Buffer.concat([
    rawLiteralsSection(literals),
    sequenceCountBytes(count),
    Buffer.from([modes, 1, 2, 0]),
    writer.finish(),
  ]);
}

/** Compressed block with raw literals, and the given raw sequences section appended verbatim. */
export function blockWithSequencesSection(literals: Buffer, sequencesSection: Buffer): Buffer {
  return Buffer.concat([rawLiteralsSection(literals), sequencesSection]);
}

/**
 * Compressed-literals section (Huffman) from an explicit tree description and stream bytes.
 * `streamCount` 1 uses size format 00, 4 uses format 01 (10-bit sizes).
 */
export function huffmanLiteralsSection(
  regeneratedSize: number,
  treeDescription: Buffer,
  streams: Buffer,
  streamCount: 1 | 4
): Buffer {
  const compressedSize = treeDescription.length + streams.length;
  const format = streamCount === 1 ? 0 : 1;
  const value = 2 + format * 4 + regeneratedSize * 16 + compressedSize * 2 ** 14;
  return Buffer.concat([
    Buffer.from([value & 0xff, Math.floor(value / 256) & 0xff, Math.floor(value / 65536) & 0xff]),
    treeDescription,
    streams,
  ]);
}

/**
 * Backward Huffman stream for the two-symbol tree [weight 1, implied weight 1]: symbol 0 is the
 * 1-bit code 0 and symbol 1 the 1-bit code 1. `symbols` are given in output order.
 */
export function twoSymbolHuffmanStream(symbols: number[]): Buffer {
  const writer = new TestBitWriter();
  for (let i = symbols.length - 1; i >= 0; i--) writer.write(symbols[i], 1);
  return writer.finish();
}

/** Direct-form tree description (header byte 128 + count - 1, one nibble per weight). */
export function directTreeDescription(weights: number[]): Buffer {
  const bytes = [127 + weights.length];
  for (let i = 0; i < weights.length; i += 2) {
    bytes.push((weights[i] << 4) | (weights[i + 1] ?? 0));
  }
  return Buffer.from(bytes);
}

/**
 * Wraps one compressed block (payload) into a frame with a 128 KiB window descriptor and no content
 * size, so the block maximum is the full 128 KiB.
 */
export function singleBlockFrame(payload: Buffer): Buffer {
  return buildFrame([compressedBlock(payload)], { windowLog: 17 });
}

// ---------------------------------------------------------------------------
// Deterministic data generators shared by the Zstandard suites
// ---------------------------------------------------------------------------

export function makeRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

export function noiseBytes(length: number, seed: number): Buffer {
  const rng = makeRng(seed);
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) out[i] = Math.floor(rng() * 256);
  return out;
}

/**
 * Walks a complete digraph with self loops (Hierholzer) so that every consecutive node pair in the
 * returned path is a distinct edge. Returns `edges + 1` nodes.
 */
export function distinctPairWalk(nodes: number, edges: number): number[] {
  const next = new Array<number>(nodes).fill(0);
  const stack = [0];
  const circuit: number[] = [];
  while (stack.length > 0) {
    const v = stack[stack.length - 1];
    if (next[v] < nodes) {
      stack.push(next[v]++);
    } else {
      circuit.push(stack.pop() as number);
    }
  }
  circuit.reverse();
  return circuit.slice(0, edges + 1);
}

/**
 * One 128 KiB block of 4-byte tokens in which no token pair repeats, so every token after its
 * first occurrence matches exactly 4 bytes: close to the 32768-sequence ceiling of one block.
 */
export function maxSequenceBlockInput(tokenCount: number, seed: number): Buffer {
  const rng = makeRng(seed);
  const firstBytes = Array.from({ length: 256 }, (_, i) => i).sort(() => rng() - 0.5);
  const tokens: Buffer[] = [];
  for (let i = 0; i < tokenCount; i++) {
    const token = Buffer.alloc(4);
    token[0] = firstBytes[i];
    for (let k = 1; k < 4; k++) token[k] = Math.floor(rng() * 256);
    tokens.push(token);
  }
  const walk = distinctPairWalk(tokenCount, BLOCK_MAX / 4);
  const input = Buffer.alloc(BLOCK_MAX);
  for (let i = 0; i < BLOCK_MAX / 4; i++) tokens[walk[i]].copy(input, i * 4);
  return input;
}

/** Back-to-back copies at a small pool of offsets with occasional literals: exercises repeat codes with litLen == 0. */
export function repeatOffsetStress(length: number, seed: number): Buffer {
  const rng = makeRng(seed);
  const out = Buffer.alloc(length);
  let pos = 0;
  while (pos < 64) out[pos++] = Math.floor(rng() * 256);
  const pool = [7, 19, 53, 211];
  while (pos < length) {
    if (rng() < 0.12) {
      const literals = 1 + Math.floor(rng() * 3);
      for (let k = 0; k < literals && pos < length; k++) out[pos++] = Math.floor(rng() * 256);
      continue;
    }
    if (rng() < 0.1) pool[Math.floor(rng() * pool.length)] = 5 + Math.floor(rng() * 2000);
    const offset = Math.min(pos, pool[Math.floor(rng() * pool.length)]);
    const copyLength = 4 + Math.floor(rng() * 24);
    for (let k = 0; k < copyLength && pos < length; k++, pos++) out[pos] = out[pos - offset];
  }
  return out;
}

/**
 * Sequence count of the first block when it is a Compressed block in a frame whose header is
 * single-segment or has a window descriptor; -1 when the first block is not compressed.
 */
export function firstBlockSequenceCount(frame: Buffer): number {
  const fhd = frame[4];
  const fcsFlag = fhd >> 6;
  let pos = 5 + ((fhd & 0x20) !== 0 ? 0 : 1);
  if (fcsFlag === 0) pos += (fhd & 0x20) !== 0 ? 1 : 0;
  else pos += [0, 2, 4, 8][fcsFlag];
  const header = frame[pos] | (frame[pos + 1] << 8) | (frame[pos + 2] << 16);
  pos += 3;
  if (((header >> 1) & 3) !== BLOCK_COMPRESSED) return -1;
  const first = frame[pos];
  const type = first & 3;
  const format = (first >> 2) & 3;
  let end = pos;
  if (type < 2) {
    if (format === 0 || format === 2) end += 1 + (type === 0 ? first >> 3 : 1);
    else if (format === 1) end += 2 + (type === 0 ? (first >> 4) + frame[pos + 1] * 16 : 1);
    else end += 3 + (type === 0 ? (first >> 4) + frame[pos + 1] * 16 + frame[pos + 2] * 4096 : 1);
  } else {
    const headerBytes = [3, 3, 4, 5][format];
    let value = 0;
    let scale = 1;
    for (let i = 0; i < headerBytes; i++) {
      value += frame[pos + i] * scale;
      scale *= 256;
    }
    const sizeBits = [10, 10, 14, 18][format];
    end += headerBytes + Math.floor(Math.floor(value / 16) / 2 ** sizeBits);
  }
  const count = frame[end];
  if (count < 128) return count;
  if (count < 255) return ((count - 128) << 8) + frame[end + 1];
  return frame[end + 1] + frame[end + 2] * 256 + 0x7f00;
}

/** Straightforward BigInt XXH64 (seed 0) written from the public algorithm description. */
export function referenceXxh64(data: Buffer): bigint {
  const mask = 0xffffffffffffffffn;
  const p1 = 11400714785074694791n;
  const p2 = 14029467366897019727n;
  const p3 = 1609587929392839161n;
  const p4 = 9650029242287828579n;
  const p5 = 2870177450012600261n;
  const rotl = (x: bigint, r: bigint): bigint => ((x << r) | (x >> (64n - r))) & mask;
  const round = (acc: bigint, input: bigint): bigint => (rotl((acc + input * p2) & mask, 31n) * p1) & mask;
  const merge = (acc: bigint, val: bigint): bigint => (((acc ^ round(0n, val)) * p1) + p4) & mask;
  let pos = 0;
  let hash: bigint;
  if (data.length >= 32) {
    let v1 = (p1 + p2) & mask;
    let v2 = p2;
    let v3 = 0n;
    let v4 = (0n - p1) & mask;
    while (pos + 32 <= data.length) {
      v1 = round(v1, data.readBigUInt64LE(pos));
      v2 = round(v2, data.readBigUInt64LE(pos + 8));
      v3 = round(v3, data.readBigUInt64LE(pos + 16));
      v4 = round(v4, data.readBigUInt64LE(pos + 24));
      pos += 32;
    }
    hash = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & mask;
    hash = merge(hash, v1);
    hash = merge(hash, v2);
    hash = merge(hash, v3);
    hash = merge(hash, v4);
  } else {
    hash = p5;
  }
  hash = (hash + BigInt(data.length)) & mask;
  while (pos + 8 <= data.length) {
    hash ^= round(0n, data.readBigUInt64LE(pos));
    hash = (rotl(hash, 27n) * p1 + p4) & mask;
    pos += 8;
  }
  if (pos + 4 <= data.length) {
    hash ^= (BigInt(data.readUInt32LE(pos)) * p1) & mask;
    hash = (rotl(hash, 23n) * p2 + p3) & mask;
    pos += 4;
  }
  while (pos < data.length) {
    hash ^= (BigInt(data[pos]) * p5) & mask;
    hash = (rotl(hash, 11n) * p1) & mask;
    pos++;
  }
  hash ^= hash >> 33n;
  hash = (hash * p2) & mask;
  hash ^= hash >> 29n;
  hash = (hash * p3) & mask;
  hash ^= hash >> 32n;
  return hash;
}


/**
 * Checks the content checksum trailer of a frame against the independent XXH64 above: the frame
 * must announce a checksum and end with the low 32 bits of XXH64(input), little endian.
 */
export function assertFrameChecksum(frame: Buffer, input: Buffer): void {
  expect((frame[4] >> 2) & 1, 'checksum flag').toBe(1);
  expect(frame.readUInt32LE(frame.length - 4), 'content checksum').toBe(Number(referenceXxh64(input) & 0xffffffffn));
}
