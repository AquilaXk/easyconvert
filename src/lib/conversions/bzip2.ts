/**
 * Pure TypeScript bzip2 compressor and decompressor.
 * Zero external dependencies, in-memory, bounded-resource and fail-closed on malformed input.
 *
 * Format reference: bzip2 1.0.x stream layout (stream header, 900k-style blocks with initial RLE1,
 * BWT, MTF + RUNA/RUNB zero-run coding, multi-table Huffman with selectors, block and stream CRCs).
 */

import { CorruptStreamError, DecompressionLimitError } from '../types';
import { copyYielding, CPU_POOL_MIN_BYTES, getCpuPool, yieldToEventLoop } from '../workers/cpu-pool';
import { burrowsWheelerTransform, BwtWorkspace } from './bzip2-bwt';

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

const BZ_BLOCK_UNIT = 100_000;
const BZ_MIN_LEVEL = 1;
const BZ_MAX_LEVEL = 9;
/** Encoder slack so that one RLE1 run (<= 5 bytes) can always be appended without passing the block size. */
const BZ_BLOCK_SLACK = 19;
const BZ_RLE1_MIN_RUN = 4;
const BZ_RLE1_MAX_RUN = 255;
const BZ_RLE1_RUN_BYTES = 5;
const BZ_GROUP_SIZE = 50;
const BZ_MIN_TREES = 2;
const BZ_MAX_TREES = 6;
const BZ_MAX_SELECTORS = 18_002;
const BZ_ENCODE_MAX_CODE_LEN = 17;
const BZ_DECODE_MAX_CODE_LEN = 20;
const BZ_MAX_ALPHA_SIZE = 258;
const BZ_RUNA = 0;
const BZ_RUNB = 1;
const BZ_HUFFMAN_ITERATIONS = 4;
const BZ_INITIAL_UNUSED_COST = 15;
const BZ_PEEK_BITS = 20;
const BZ_ORIG_PTR_BITS = 24;
const BZ_CRC_POLY = 0x04c11db7;
const BZ_CRC_INIT = 0xffffffff;
const BZ_CRC_TOP_BIT = 0x80000000;
const BZ_CRC_ROTATE_SHIFT = 31;
const HALF_WORD_MASK = 0xffff;
/** Symbol counts below which the encoder uses 2, 3, 4 and 5 coding tables (6 above), as the reference does. */
const BZ_TREE_COUNT_THRESHOLDS = [200, 600, 1200, 2400];
const BZ_BYTE_MASK = 0xff;

const BZ_BLOCK_MAGIC = [0x31, 0x41, 0x59, 0x26, 0x53, 0x59];
const BZ_END_MAGIC = [0x17, 0x72, 0x45, 0x38, 0x50, 0x90];
const BZ_SIGNATURE = [0x42, 0x5a, 0x68]; // 'B' 'Z' 'h'
const BZ_DIGIT_ZERO = 0x30;

/** Default cap on decoded output (matches the archive layer's uncompressed-size limit). */
export const BZIP2_DEFAULT_MAX_OUTPUT_BYTES = 500 * 1024 * 1024;

const OUTPUT_INITIAL_CAPACITY = 64 * 1024;
const OUTPUT_INITIAL_CAPACITY_MAX = 32 * 1024 * 1024;
const OUTPUT_EXPECTED_EXPANSION = 4;
const BZ_ALPHABET = 256;
const BZ_MAP_GROUPS = 16;
const BZ_CODE_START_BITS = 5;
const BZ_TREE_COUNT_BITS = 3;
const BZ_SELECTOR_COUNT_BITS = 15;
const BZ_CRC_BITS = 32;
const BZ_HEADER_MIN_BYTES = 4;
const BIT_BUFFER_REFILL_THRESHOLD = 23;
const BYTE_BITS = 8;
const HALF_WORD_BITS = 16;
const HALF_WORD_MULTIPLIER = 65_536;

function bzError(message: string): CorruptStreamError {
  return new CorruptStreamError(`Invalid bzip2 data: ${message}`);
}

// ---------------------------------------------------------------------------------------------
// CRC-32 (MSB-first, polynomial 0x04C11DB7)
// ---------------------------------------------------------------------------------------------

const BZ_CRC_TABLE = new Uint32Array(BZ_ALPHABET);
for (let i = 0; i < BZ_ALPHABET; i++) {
  let c = i << 24;
  for (let j = 0; j < 8; j++) {
    c = (c & BZ_CRC_TOP_BIT) ? ((c << 1) ^ BZ_CRC_POLY) : (c << 1);
  }
  BZ_CRC_TABLE[i] = c >>> 0;
}

export function computeBzBlockCrc(buf: Uint8Array): number {
  let crc = BZ_CRC_INIT;
  for (let i = 0; i < buf.length; i++) {
    crc = ((crc << 8) ^ BZ_CRC_TABLE[((crc >>> 24) ^ buf[i]) & BZ_BYTE_MASK]) >>> 0;
  }
  return (crc ^ BZ_CRC_INIT) >>> 0;
}

function combineCrc(combined: number, blockCrc: number): number {
  return (((combined << 1) | (combined >>> BZ_CRC_ROTATE_SHIFT)) ^ blockCrc) >>> 0;
}

// ---------------------------------------------------------------------------------------------
// Bit I/O
// ---------------------------------------------------------------------------------------------

class BitWriter {
  private buffer: Uint8Array;
  private bytePos = 0;
  private acc = 0;
  private accBits = 0;

  constructor(initialCapacity: number) {
    this.buffer = new Uint8Array(Math.max(initialCapacity, 64));
  }

  private grow(): void {
    const next = new Uint8Array(this.buffer.length * 2);
    next.set(this.buffer.subarray(0, this.bytePos));
    this.buffer = next;
  }

  /** Writes the low `width` bits of `value`, MSB first. */
  writeBits(value: number, width: number): void {
    if (width > HALF_WORD_BITS) {
      this.writeBits(value >>> HALF_WORD_BITS, width - HALF_WORD_BITS);
      this.writeBits(value & HALF_WORD_MASK, HALF_WORD_BITS);
      return;
    }
    this.acc = (this.acc << width) | (value & ((1 << width) - 1));
    this.accBits += width;
    while (this.accBits >= BYTE_BITS) {
      if (this.bytePos >= this.buffer.length) this.grow();
      this.accBits -= BYTE_BITS;
      this.buffer[this.bytePos++] = (this.acc >>> this.accBits) & BZ_BYTE_MASK;
    }
    this.acc &= (1 << this.accBits) - 1;
  }

  writeByte(value: number): void {
    this.writeBits(value, BYTE_BITS);
  }

  finish(): Buffer {
    if (this.accBits > 0) {
      this.writeBits(0, BYTE_BITS - this.accBits);
    }
    return Buffer.from(this.buffer.subarray(0, this.bytePos));
  }

  /** Bits written so far, including those still in the accumulator. */
  get bitLength(): number {
    return this.bytePos * BYTE_BITS + this.accBits;
  }

  /** The written bits as bytes plus their count; the last byte is zero-padded when the count is not a multiple of 8. */
  takeBitStream(): BitStream {
    const bitLength = this.bitLength;
    const bytes = new Uint8Array(Math.ceil(bitLength / BYTE_BITS));
    bytes.set(this.buffer.subarray(0, this.bytePos));
    if (this.accBits > 0) bytes[this.bytePos] = (this.acc << (BYTE_BITS - this.accBits)) & BZ_BYTE_MASK;
    return { bytes, bitLength };
  }

  /** Appends the first `bitLength` bits of `bytes` (most significant bit first). */
  writeBitStream(stream: BitStream): void {
    const whole = Math.floor(stream.bitLength / BYTE_BITS);
    for (let i = 0; i < whole; i++) this.writeBits(stream.bytes[i], BYTE_BITS);
    const rest = stream.bitLength - whole * BYTE_BITS;
    if (rest > 0) this.writeBits(stream.bytes[whole] >>> (BYTE_BITS - rest), rest);
  }
}

/** A run of bits that does not end on a byte boundary: bzip2 blocks are bit-aligned, not byte-aligned. */
export interface BitStream {
  bytes: Uint8Array;
  bitLength: number;
}

class BitReader {
  private bitBuf = 0;
  private bitCnt = 0;
  private pos = 0;
  /** Number of zero bits appended past the end of the data (never legitimately consumable). */
  private padBits = 0;

  constructor(private readonly data: Uint8Array, start: number) {
    this.pos = start;
  }

  private fill(): void {
    while (this.bitCnt <= BIT_BUFFER_REFILL_THRESHOLD) {
      let byte = 0;
      if (this.pos < this.data.length) {
        byte = this.data[this.pos++];
      } else {
        this.padBits += BYTE_BITS;
      }
      this.bitBuf = (this.bitBuf << BYTE_BITS) | byte;
      this.bitCnt += BYTE_BITS;
    }
  }

  /** Returns the next `n` (<= 24) bits without consuming them; bits past the end read as zero. */
  peek(n: number): number {
    this.fill();
    return this.bitBuf >>> (this.bitCnt - n);
  }

  consume(n: number): void {
    this.bitCnt -= n;
    this.bitBuf &= (1 << this.bitCnt) - 1;
    if (this.padBits > this.bitCnt) {
      throw bzError('unexpected end of data (truncated stream)');
    }
  }

  /** Reads `n` (<= 24) bits. */
  readBits(n: number): number {
    const v = this.peek(n);
    this.consume(n);
    return v;
  }

  readBit(): number {
    return this.readBits(1);
  }

  read32(): number {
    const hi = this.readBits(HALF_WORD_BITS);
    const lo = this.readBits(HALF_WORD_BITS);
    return hi * HALF_WORD_MULTIPLIER + lo;
  }

  /** Drops bits up to the next byte boundary of the underlying data. */
  alignToByte(): void {
    const realBits = this.bitCnt - this.padBits;
    this.consume(realBits % BYTE_BITS);
  }

  /** Whole unread bytes of real data left (only meaningful after alignToByte). */
  bytesRemaining(): number {
    return ((this.bitCnt - this.padBits) >> 3) + (this.data.length - this.pos);
  }
}

// ---------------------------------------------------------------------------------------------
// Encoder: length-limited Huffman code construction
// ---------------------------------------------------------------------------------------------

/**
 * Builds Huffman code lengths for `alphaSize` symbols limited to `maxLen`. Frequencies are floored
 * at one so every symbol receives a code; if the tree is too deep the weights are flattened and
 * the tree is rebuilt, as the reference encoder does.
 */
function makeCodeLengths(freq: Int32Array, alphaSize: number, maxLen: number): Uint8Array {
  const weights = new Int32Array(alphaSize);
  for (let i = 0; i < alphaSize; i++) weights[i] = Math.max(1, freq[i]);

  const totalNodes = 2 * alphaSize - 1;
  const nodeWeight = new Float64Array(totalNodes);
  const parent = new Int32Array(totalNodes);
  const depth = new Int32Array(totalNodes);
  const lengths = new Uint8Array(alphaSize);

  for (;;) {
    const order = Array.from({ length: alphaSize }, (_, i) => i).sort(
      (a, b) => weights[a] - weights[b] || a - b
    );
    // Leaves are nodes 0..alphaSize-1 in sorted order; internal nodes are appended in creation order.
    const leafOf = new Int32Array(alphaSize);
    for (let i = 0; i < alphaSize; i++) {
      leafOf[i] = order[i];
      nodeWeight[i] = weights[order[i]];
    }
    let leafHead = 0;
    let internalHead = alphaSize;
    let internalTail = alphaSize;
    const takeSmallest = (): number => {
      const leafAvailable = leafHead < alphaSize;
      const internalAvailable = internalHead < internalTail;
      if (leafAvailable && (!internalAvailable || nodeWeight[leafHead] <= nodeWeight[internalHead])) {
        return leafHead++;
      }
      return internalHead++;
    };
    for (let made = 0; made < alphaSize - 1; made++) {
      const a = takeSmallest();
      const b = takeSmallest();
      nodeWeight[internalTail] = nodeWeight[a] + nodeWeight[b];
      parent[a] = internalTail;
      parent[b] = internalTail;
      internalTail++;
    }
    const root = totalNodes - 1;
    depth[root] = 0;
    let deepest = 0;
    for (let node = root - 1; node >= 0; node--) {
      depth[node] = depth[parent[node]] + 1;
    }
    for (let i = 0; i < alphaSize; i++) {
      lengths[leafOf[i]] = depth[i];
      if (depth[i] > deepest) deepest = depth[i];
    }
    if (deepest <= maxLen) return lengths;
    for (let i = 0; i < alphaSize; i++) weights[i] = 1 + (weights[i] >> 1);
  }
}

/** Canonical code assignment: shorter lengths first, ties broken by symbol order. */
function assignCanonicalCodes(lengths: Uint8Array, alphaSize: number): Int32Array {
  const codes = new Int32Array(alphaSize);
  let code = 0;
  for (let len = 1; len <= BZ_ENCODE_MAX_CODE_LEN; len++) {
    for (let i = 0; i < alphaSize; i++) {
      if (lengths[i] === len) codes[i] = code++;
    }
    code <<= 1;
  }
  return codes;
}

function chooseTreeCount(symbolCount: number): number {
  const below = BZ_TREE_COUNT_THRESHOLDS.findIndex((threshold) => symbolCount < threshold);
  return below === -1 ? BZ_MAX_TREES : BZ_MIN_TREES + below;
}

// ---------------------------------------------------------------------------------------------
// Encoder: one block
// ---------------------------------------------------------------------------------------------

function encodeBlock(bw: BitWriter, rle1Block: Uint8Array, blockCrc: number, workspace: BwtWorkspace): void {
  const n = rle1Block.length;
  const { lColumn, origPtr } = burrowsWheelerTransform(rle1Block, workspace);

  const unseqToSeq = new Int16Array(BZ_ALPHABET).fill(-1);
  const inUse = new Uint8Array(BZ_ALPHABET);
  for (let i = 0; i < n; i++) inUse[lColumn[i]] = 1;
  const seqToUnseq: number[] = [];
  for (let i = 0; i < BZ_ALPHABET; i++) {
    if (inUse[i]) {
      unseqToSeq[i] = seqToUnseq.length;
      seqToUnseq.push(i);
    }
  }
  const numSymbols = seqToUnseq.length;
  const eob = numSymbols + 1;
  const alphaSize = numSymbols + 2;

  // MTF + zero-run coding (RUNA/RUNB bijective base-2 digits).
  const symbols = new Uint16Array(n + 1);
  let symCount = 0;
  const mtf = new Uint8Array(BZ_ALPHABET);
  for (let i = 0; i < numSymbols; i++) mtf[i] = i;
  const symFreq = new Int32Array(alphaSize);
  let zeroRun = 0;
  const flushZeroRun = (): void => {
    let z = zeroRun;
    while (z > 0) {
      if (z % 2 === 1) {
        symbols[symCount++] = BZ_RUNA;
        symFreq[BZ_RUNA]++;
        z = (z - 1) / 2;
      } else {
        symbols[symCount++] = BZ_RUNB;
        symFreq[BZ_RUNB]++;
        z = (z - 2) / 2;
      }
    }
    zeroRun = 0;
  };
  for (let i = 0; i < n; i++) {
    const target = unseqToSeq[lColumn[i]];
    if (mtf[0] === target) {
      zeroRun++;
      continue;
    }
    if (zeroRun > 0) flushZeroRun();
    let pos = 1;
    let prev = mtf[0];
    let cur = mtf[1];
    mtf[1] = prev;
    while (cur !== target) {
      pos++;
      prev = cur;
      cur = mtf[pos];
      mtf[pos] = prev;
    }
    mtf[0] = cur;
    symbols[symCount++] = pos + 1;
    symFreq[pos + 1]++;
  }
  if (zeroRun > 0) flushZeroRun();
  symbols[symCount++] = eob;
  symFreq[eob]++;

  // Multi-table Huffman: iteratively assign 50-symbol groups to the cheapest table.
  const numTrees = chooseTreeCount(symCount);
  const treeLengths: Uint8Array[] = Array.from({ length: numTrees }, () => new Uint8Array(alphaSize));
  let remainingFreq = symCount;
  let groupStart = 0;
  for (let part = numTrees; part > 0; part--) {
    const targetFreq = Math.floor(remainingFreq / part);
    let groupEnd = groupStart - 1;
    let accumulated = 0;
    while (accumulated < targetFreq && groupEnd < alphaSize - 1) {
      groupEnd++;
      accumulated += symFreq[groupEnd];
    }
    // Like the reference encoder, every other inner partition gives back its last symbol so the
    // initial tables overlap less; the parity alternates from the first partition.
    const givesBackLastSymbol = (numTrees - part) % 2 === 1;
    if (groupEnd > groupStart && part !== numTrees && part !== 1 && givesBackLastSymbol) {
      accumulated -= symFreq[groupEnd];
      groupEnd--;
    }
    const lens = treeLengths[part - 1];
    for (let v = 0; v < alphaSize; v++) {
      lens[v] = v >= groupStart && v <= groupEnd ? 0 : BZ_INITIAL_UNUSED_COST;
    }
    groupStart = groupEnd + 1;
    remainingFreq -= accumulated;
  }

  const numSelectors = Math.ceil(symCount / BZ_GROUP_SIZE);
  const selectors = new Uint8Array(numSelectors);
  for (let iter = 0; iter < BZ_HUFFMAN_ITERATIONS; iter++) {
    const treeFreq = Array.from({ length: numTrees }, () => new Int32Array(alphaSize));
    const costs = new Int32Array(numTrees);
    for (let g = 0; g < numSelectors; g++) {
      const start = g * BZ_GROUP_SIZE;
      const end = Math.min(start + BZ_GROUP_SIZE, symCount);
      costs.fill(0);
      for (let t = 0; t < numTrees; t++) {
        const lens = treeLengths[t];
        let cost = 0;
        for (let k = start; k < end; k++) cost += lens[symbols[k]];
        costs[t] = cost;
      }
      let best = 0;
      for (let t = 1; t < numTrees; t++) {
        if (costs[t] < costs[best]) best = t;
      }
      selectors[g] = best;
      const freqs = treeFreq[best];
      for (let k = start; k < end; k++) freqs[symbols[k]]++;
    }
    for (let t = 0; t < numTrees; t++) {
      treeLengths[t] = makeCodeLengths(treeFreq[t], alphaSize, BZ_ENCODE_MAX_CODE_LEN);
    }
  }
  const treeCodes = treeLengths.map((lens) => assignCanonicalCodes(lens, alphaSize));

  // Block header.
  BZ_BLOCK_MAGIC.forEach((b) => bw.writeByte(b));
  bw.writeBits(blockCrc, BZ_CRC_BITS);
  bw.writeBits(0, 1); // not randomised
  bw.writeBits(origPtr, BZ_ORIG_PTR_BITS);

  // Symbol map: 16 coarse bits, then 16 fine bits per used group.
  const groupUsed = new Uint8Array(BZ_MAP_GROUPS);
  for (let g = 0; g < BZ_MAP_GROUPS; g++) {
    for (let j = 0; j < BZ_MAP_GROUPS; j++) groupUsed[g] |= inUse[g * BZ_MAP_GROUPS + j];
    bw.writeBits(groupUsed[g], 1);
  }
  for (let g = 0; g < BZ_MAP_GROUPS; g++) {
    if (!groupUsed[g]) continue;
    for (let j = 0; j < BZ_MAP_GROUPS; j++) bw.writeBits(inUse[g * BZ_MAP_GROUPS + j], 1);
  }

  // Selectors, MTF-coded and written in unary.
  bw.writeBits(numTrees, BZ_TREE_COUNT_BITS);
  bw.writeBits(numSelectors, BZ_SELECTOR_COUNT_BITS);
  const selectorMtf = Array.from({ length: numTrees }, (_, i) => i);
  for (let g = 0; g < numSelectors; g++) {
    const idx = selectorMtf.indexOf(selectors[g]);
    selectorMtf.splice(idx, 1);
    selectorMtf.unshift(selectors[g]);
    for (let k = 0; k < idx; k++) bw.writeBits(1, 1);
    bw.writeBits(0, 1);
  }

  // Delta-coded code lengths.
  for (let t = 0; t < numTrees; t++) {
    const lens = treeLengths[t];
    let curLen = lens[0];
    bw.writeBits(curLen, BZ_CODE_START_BITS);
    for (let i = 0; i < alphaSize; i++) {
      while (curLen < lens[i]) {
        bw.writeBits(0b10, 2);
        curLen++;
      }
      while (curLen > lens[i]) {
        bw.writeBits(0b11, 2);
        curLen--;
      }
      bw.writeBits(0, 1);
    }
  }

  // Payload.
  for (let g = 0; g < numSelectors; g++) {
    const lens = treeLengths[selectors[g]];
    const codes = treeCodes[selectors[g]];
    const start = g * BZ_GROUP_SIZE;
    const end = Math.min(start + BZ_GROUP_SIZE, symCount);
    for (let k = start; k < end; k++) {
      const sym = symbols[k];
      bw.writeBits(codes[sym], lens[sym]);
    }
  }
}

/** The input bytes of one bzip2 block. */
export interface Bzip2BlockRange {
  start: number;
  end: number;
}

const BZ_BLOCK_LIMIT = BZ_MAX_LEVEL * BZ_BLOCK_UNIT - BZ_BLOCK_SLACK;

/**
 * Applies the initial run-length encoding (stage 1 of the format) from `start` until the encoded block holds the
 * block limit. Writes the encoded block into `rle1` when given; returns its length and where the input stopped.
 */
function scanRle1(input: Uint8Array, start: number, rle1: Uint8Array | null): { length: number; end: number } {
  let pos = start;
  let n = 0;
  while (pos < input.length && n < BZ_BLOCK_LIMIT) {
    const byte = input[pos];
    let run = 1;
    while (run < BZ_RLE1_MAX_RUN && pos + run < input.length && input[pos + run] === byte) run++;
    pos += run;
    if (run < BZ_RLE1_MIN_RUN) {
      if (rle1 !== null) for (let k = 0; k < run; k++) rle1[n + k] = byte;
      n += run;
    } else {
      if (rle1 !== null) {
        for (let k = 0; k < BZ_RLE1_MIN_RUN; k++) rle1[n + k] = byte;
        rle1[n + BZ_RLE1_MIN_RUN] = run - BZ_RLE1_MIN_RUN;
      }
      n += BZ_RLE1_MIN_RUN + 1;
    }
  }
  return { length: n, end: pos };
}

/** Splits the input into the byte ranges that become bzip2 blocks; a count-only pass, far cheaper than encoding. */
export function planBzip2Blocks(input: Uint8Array): Bzip2BlockRange[] {
  const blocks: Bzip2BlockRange[] = [];
  let pos = 0;
  while (pos < input.length) {
    const { end } = scanRle1(input, pos, null);
    blocks.push({ start: pos, end });
    pos = end;
  }
  return blocks;
}

/** `planBzip2Blocks` that lets the event loop run between blocks (each block's scan is a few milliseconds). */
async function planBzip2BlocksYielding(input: Uint8Array): Promise<Bzip2BlockRange[]> {
  const blocks: Bzip2BlockRange[] = [];
  let pos = 0;
  while (pos < input.length) {
    const { end } = scanRle1(input, pos, null);
    blocks.push({ start: pos, end });
    pos = end;
    await yieldToEventLoop();
  }
  return blocks;
}

function newRle1Scratch(inputLength: number): Uint8Array {
  return new Uint8Array(Math.min(BZ_BLOCK_LIMIT, Math.ceil((inputLength * BZ_RLE1_RUN_BYTES) / BZ_RLE1_MIN_RUN)) + BZ_RLE1_RUN_BYTES);
}

/** Encodes one planned block into `bw` and returns its CRC. */
function encodePlannedBlock(bw: BitWriter, input: Uint8Array, range: Bzip2BlockRange, rle1: Uint8Array, workspace: BwtWorkspace): number {
  const { length } = scanRle1(input, range.start, rle1);
  const blockCrc = computeBzBlockCrc(input.subarray(range.start, range.end));
  encodeBlock(bw, rle1.subarray(0, length), blockCrc, workspace);
  return blockCrc;
}

/**
 * Encodes one block of `input` on its own, for a worker thread: the block's bits (not byte aligned) and its CRC. The
 * pieces of all blocks are joined with `joinBzip2Blocks` into the same stream `compressBzip2` writes.
 */
export function encodeBzip2Block(input: Uint8Array, range: Bzip2BlockRange): { stream: BitStream; crc: number } {
  const bw = new BitWriter(Math.ceil((range.end - range.start) / 2) + 1024);
  const crc = encodePlannedBlock(bw, input, range, newRle1Scratch(range.end - range.start), new BwtWorkspace());
  return { stream: bw.takeBitStream(), crc };
}

/** Joins independently encoded blocks (in input order) into one bzip2 stream. */
export function joinBzip2Blocks(blocks: ReadonlyArray<{ stream: BitStream; crc: number }>): Buffer {
  const total = blocks.reduce((sum, block) => sum + block.stream.bytes.length, 0);
  const bw = new BitWriter(total + 64);
  BZ_SIGNATURE.forEach((b) => bw.writeByte(b));
  bw.writeByte(BZ_DIGIT_ZERO + BZ_MAX_LEVEL);
  let combinedCrc = 0;
  for (const block of blocks) {
    combinedCrc = combineCrc(combinedCrc, block.crc);
    bw.writeBitStream(block.stream);
  }
  BZ_END_MAGIC.forEach((b) => bw.writeByte(b));
  bw.writeBits(combinedCrc, BZ_CRC_BITS);
  return bw.finish();
}

/** `joinBzip2Blocks` that lets the event loop run between blocks (copying a block's bits is a few milliseconds). */
async function joinBzip2BlocksYielding(blocks: ReadonlyArray<{ stream: BitStream; crc: number }>): Promise<Buffer> {
  const total = blocks.reduce((sum, block) => sum + block.stream.bytes.length, 0);
  const bw = new BitWriter(total + 64);
  BZ_SIGNATURE.forEach((b) => bw.writeByte(b));
  bw.writeByte(BZ_DIGIT_ZERO + BZ_MAX_LEVEL);
  let combinedCrc = 0;
  for (const block of blocks) {
    combinedCrc = combineCrc(combinedCrc, block.crc);
    bw.writeBitStream(block.stream);
    await yieldToEventLoop();
  }
  BZ_END_MAGIC.forEach((b) => bw.writeByte(b));
  bw.writeBits(combinedCrc, BZ_CRC_BITS);
  return bw.finish();
}

/**
 * Compresses an input buffer to a standard single-stream bzip2 file (block size 900k).
 */
export function compressBzip2(input: Buffer): Buffer {
  const bw = new BitWriter(Math.ceil(input.length / 2) + 1024);
  BZ_SIGNATURE.forEach((b) => bw.writeByte(b));
  bw.writeByte(BZ_DIGIT_ZERO + BZ_MAX_LEVEL);

  const rle1 = newRle1Scratch(input.length);
  const workspace = new BwtWorkspace();
  let combinedCrc = 0;
  let pos = 0;
  while (pos < input.length) {
    const { length, end } = scanRle1(input, pos, rle1);
    const blockCrc = computeBzBlockCrc(input.subarray(pos, end));
    combinedCrc = combineCrc(combinedCrc, blockCrc);
    encodeBlock(bw, rle1.subarray(0, length), blockCrc, workspace);
    pos = end;
  }

  BZ_END_MAGIC.forEach((b) => bw.writeByte(b));
  bw.writeBits(combinedCrc, BZ_CRC_BITS);
  return bw.finish();
}

/**
 * Compresses without holding the event loop: the blocks of a large input are encoded on pool threads, a few at a time,
 * and joined in order, which yields byte-for-byte the stream `compressBzip2` writes. The input is copied once into
 * shared memory that every thread reads. Small inputs run inline.
 */
export async function compressBzip2Async(input: Buffer, options: { signal?: AbortSignal } = {}): Promise<Buffer> {
  if (input.length < CPU_POOL_MIN_BYTES) return compressBzip2(input);
  const plan = await planBzip2BlocksYielding(input);
  const shared = await copyYielding<Uint8Array>(input, new Uint8Array(new SharedArrayBuffer(input.length)));
  const pool = getCpuPool();
  // Keep a few more blocks in flight than there are threads, but never fill the queue: a long input is fed as blocks finish.
  const inFlightMax = Math.max(2, pool.threadLimit * 2);
  const results: Array<{ stream: BitStream; crc: number }> = new Array(plan.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < plan.length) {
      const at = next++;
      results[at] = await pool.submit<{ stream: BitStream; crc: number }>(
        'bzip2Block',
        { data: shared, start: plan[at].start, end: plan[at].end },
        { signal: options.signal }
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(inFlightMax, plan.length) }, () => lane()));
  return joinBzip2BlocksYielding(results);
}

// ---------------------------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------------------------

interface HuffmanDecodeTable {
  minLen: number;
  maxLen: number;
  alphaSize: number;
  limit: Int32Array;
  base: Int32Array;
  perm: Uint16Array;
}

function buildDecodeTable(lengths: Uint8Array, alphaSize: number): HuffmanDecodeTable {
  let minLen = BZ_DECODE_MAX_CODE_LEN;
  let maxLen = 1;
  for (let i = 0; i < alphaSize; i++) {
    if (lengths[i] > maxLen) maxLen = lengths[i];
    if (lengths[i] < minLen) minLen = lengths[i];
  }
  const limit = new Int32Array(BZ_DECODE_MAX_CODE_LEN + 2);
  const base = new Int32Array(BZ_DECODE_MAX_CODE_LEN + 2);
  const perm = new Uint16Array(BZ_MAX_ALPHA_SIZE);
  const count = new Int32Array(BZ_DECODE_MAX_CODE_LEN + 2);
  for (let i = 0; i < alphaSize; i++) count[lengths[i]]++;

  let permPos = 0;
  for (let len = minLen; len <= maxLen; len++) {
    for (let i = 0; i < alphaSize; i++) {
      if (lengths[i] === len) perm[permPos++] = i;
    }
  }
  let code = 0;
  let firstIndex = 0;
  for (let len = minLen; len <= maxLen; len++) {
    base[len] = code - firstIndex; // symbol index = code - base
    code += count[len];
    firstIndex += count[len];
    limit[len] = code - 1;
    code <<= 1;
  }
  return { minLen, maxLen, alphaSize, limit, base, perm };
}

class OutputSink {
  buffer: Buffer;
  length = 0;

  constructor(private readonly maxBytes: number, expectedBytes: number) {
    this.buffer = Buffer.alloc(Math.min(Math.max(expectedBytes, OUTPUT_INITIAL_CAPACITY), maxBytes));
  }

  /** Grows capacity so `needed` total bytes fit; fails closed past the output limit. */
  ensure(needed: number): void {
    if (needed > this.maxBytes) {
      throw new DecompressionLimitError(`Invalid bzip2 data: decompressed size exceeds the limit of ${this.maxBytes} bytes`);
    }
    if (needed <= this.buffer.length) return;
    const grown = Math.min(Math.max(this.buffer.length * 2, needed), this.maxBytes);
    const next = Buffer.alloc(grown);
    this.buffer.copy(next, 0, 0, this.length);
    this.buffer = next;
  }

  result(): Buffer {
    return this.buffer.subarray(0, this.length);
  }
}

function decodeSymbol(reader: BitReader, table: HuffmanDecodeTable): number {
  const window = reader.peek(BZ_PEEK_BITS);
  let len = table.minLen;
  let code = window >>> (BZ_PEEK_BITS - len);
  while (code > table.limit[len]) {
    len++;
    if (len > table.maxLen) throw bzError('invalid Huffman code');
    code = window >>> (BZ_PEEK_BITS - len);
  }
  const index = code - table.base[len];
  if (index < 0 || index >= table.alphaSize) throw bzError('invalid Huffman code');
  reader.consume(len);
  return table.perm[index];
}

function readCodeLengths(reader: BitReader, alphaSize: number): Uint8Array {
  const lengths = new Uint8Array(alphaSize);
  let cur = reader.readBits(BZ_CODE_START_BITS);
  for (let i = 0; i < alphaSize; i++) {
    for (;;) {
      if (cur < 1 || cur > BZ_DECODE_MAX_CODE_LEN) throw bzError('code length out of range');
      if (reader.readBit() === 0) break;
      cur += reader.readBit() === 0 ? 1 : -1;
    }
    lengths[i] = cur;
  }
  return lengths;
}

function readByteMap(reader: BitReader): number[] {
  const used16: number[] = [];
  for (let i = 0; i < BZ_MAP_GROUPS; i++) used16.push(reader.readBit());
  const seqToUnseq: number[] = [];
  for (let i = 0; i < BZ_MAP_GROUPS; i++) {
    if (!used16[i]) continue;
    for (let j = 0; j < BZ_MAP_GROUPS; j++) {
      if (reader.readBit()) seqToUnseq.push(i * BZ_MAP_GROUPS + j);
    }
  }
  if (seqToUnseq.length === 0) throw bzError('block uses no symbols');
  return seqToUnseq;
}

function readSelectors(reader: BitReader, numTrees: number): Uint8Array {
  const numSelectors = reader.readBits(BZ_SELECTOR_COUNT_BITS);
  if (numSelectors < 1) throw bzError('block has no selectors');
  const stored = Math.min(numSelectors, BZ_MAX_SELECTORS);
  const selectors = new Uint8Array(stored);
  const order = Array.from({ length: numTrees }, (_, i) => i);
  for (let i = 0; i < numSelectors; i++) {
    let j = 0;
    while (reader.readBit() === 1) {
      j++;
      if (j >= numTrees) throw bzError('selector index out of range');
    }
    const tree = order[j];
    order.splice(j, 1);
    order.unshift(tree);
    if (i < stored) selectors[i] = tree;
  }
  return selectors;
}

/**
 * Decodes one block into `sink`, returning nothing; verifies the block CRC and returns it via
 * the caller. `tt` is a reusable work array sized for the stream's declared block size.
 */
function decodeBlock(reader: BitReader, tt: Uint32Array, maxBlock: number, sink: OutputSink): number {
  const storedCrc = reader.read32();
  if (reader.readBit() !== 0) {
    throw bzError('randomised blocks are not supported');
  }
  const origPtr = reader.readBits(BZ_ORIG_PTR_BITS);
  const seqToUnseq = readByteMap(reader);
  const numSymbols = seqToUnseq.length;
  const alphaSize = numSymbols + 2;
  const eob = numSymbols + 1;

  const numTrees = reader.readBits(BZ_TREE_COUNT_BITS);
  if (numTrees < BZ_MIN_TREES || numTrees > BZ_MAX_TREES) {
    throw bzError(`invalid tree count ${numTrees}`);
  }
  const selectors = readSelectors(reader, numTrees);
  const tables: HuffmanDecodeTable[] = [];
  for (let t = 0; t < numTrees; t++) {
    tables.push(buildDecodeTable(readCodeLengths(reader, alphaSize), alphaSize));
  }

  // Huffman + MTF + zero-run decode into tt (low 8 bits hold the BWT last column).
  const mtf = new Uint8Array(BZ_ALPHABET);
  for (let i = 0; i < numSymbols; i++) mtf[i] = i;
  const byteCounts = new Int32Array(BZ_ALPHABET);
  let nblock = 0;
  let groupNo = -1;
  let groupLeft = 0;
  let table = tables[0];
  let runLength = 0;
  let runWeight = 1;

  const flushRun = (): void => {
    if (runLength === 0) return;
    const byte = seqToUnseq[mtf[0]];
    tt.fill(byte, nblock, nblock + runLength);
    byteCounts[byte] += runLength;
    nblock += runLength;
    runLength = 0;
    runWeight = 1;
  };

  for (;;) {
    if (groupLeft === 0) {
      groupNo++;
      if (groupNo >= selectors.length) throw bzError('ran out of selectors');
      table = tables[selectors[groupNo]];
      groupLeft = BZ_GROUP_SIZE;
    }
    groupLeft--;
    const sym = decodeSymbol(reader, table);

    if (sym === BZ_RUNA || sym === BZ_RUNB) {
      runLength += runWeight * (sym + 1);
      runWeight *= 2;
      if (runLength > maxBlock - nblock) throw bzError('block exceeds the declared block size');
      continue;
    }
    flushRun();
    if (sym === eob) break;

    if (nblock >= maxBlock) throw bzError('block exceeds the declared block size');
    const idx = sym - 1;
    const moved = mtf[idx];
    mtf.copyWithin(1, 0, idx);
    mtf[0] = moved;
    const byte = seqToUnseq[moved];
    tt[nblock++] = byte;
    byteCounts[byte]++;
  }

  if (nblock === 0) throw bzError('empty block');
  if (origPtr >= nblock) throw bzError('origPtr outside the block');

  // Inverse BWT: pack the forward pointer into the upper 24 bits.
  const cumulative = new Int32Array(BZ_ALPHABET);
  let sum = 0;
  for (let i = 0; i < BZ_ALPHABET; i++) {
    cumulative[i] = sum;
    sum += byteCounts[i];
  }
  for (let i = 0; i < nblock; i++) {
    const byte = tt[i] & BZ_BYTE_MASK;
    tt[cumulative[byte]++] |= i << BYTE_BITS;
  }

  // Walk the permutation and undo the initial RLE1 stage while emitting output.
  const outStart = sink.length;
  let out = sink.buffer;
  let outPos = outStart;
  let tPos = tt[origPtr] >>> BYTE_BITS;
  let prev = -1;
  let runCount = 0;
  for (let i = 0; i < nblock; i++) {
    const entry = tt[tPos];
    const ch = entry & BZ_BYTE_MASK;
    tPos = entry >>> BYTE_BITS;
    if (runCount === BZ_RLE1_MIN_RUN) {
      if (ch > 0) {
        sink.length = outPos;
        sink.ensure(outPos + ch);
        out = sink.buffer;
        out.fill(prev, outPos, outPos + ch);
        outPos += ch;
      }
      runCount = 0;
      prev = -1;
      continue;
    }
    if (ch === prev) {
      runCount++;
    } else {
      prev = ch;
      runCount = 1;
    }
    if (outPos >= out.length) {
      sink.length = outPos;
      sink.ensure(outPos + 1);
      out = sink.buffer;
    }
    out[outPos++] = ch;
  }
  sink.length = outPos;

  const actualCrc = computeBzBlockCrc(out.subarray(outStart, outPos));
  if (actualCrc !== storedCrc) {
    throw bzError(`block CRC mismatch (expected 0x${storedCrc.toString(16)}, got 0x${actualCrc.toString(16)})`);
  }
  return actualCrc;
}

function matchesMagic(bytes: number[], expected: number[]): boolean {
  return bytes.length === expected.length && bytes.every((b, i) => b === expected[i]);
}

function decodeStream(reader: BitReader, sink: OutputSink): void {
  const sig: number[] = [];
  for (let i = 0; i < BZ_SIGNATURE.length; i++) sig.push(reader.readBits(BYTE_BITS));
  if (!matchesMagic(sig, BZ_SIGNATURE)) throw bzError('missing BZh signature');
  const level = reader.readBits(BYTE_BITS) - BZ_DIGIT_ZERO;
  if (level < BZ_MIN_LEVEL || level > BZ_MAX_LEVEL) throw bzError('invalid block size digit');
  const maxBlock = level * BZ_BLOCK_UNIT;
  let tt: Uint32Array | null = null;

  let combined = 0;
  for (;;) {
    const magic: number[] = [];
    for (let i = 0; i < BZ_BLOCK_MAGIC.length; i++) magic.push(reader.readBits(BYTE_BITS));
    if (matchesMagic(magic, BZ_END_MAGIC)) {
      const storedCombined = reader.read32();
      if (storedCombined !== combined) {
        throw bzError(
          `stream CRC mismatch (expected 0x${storedCombined.toString(16)}, got 0x${combined.toString(16)})`
        );
      }
      return;
    }
    if (!matchesMagic(magic, BZ_BLOCK_MAGIC)) throw bzError('invalid block header');
    tt ??= new Uint32Array(maxBlock);
    combined = combineCrc(combined, decodeBlock(reader, tt, maxBlock, sink));
  }
}

function isZeroPadding(input: Buffer, from: number): boolean {
  for (let i = from; i < input.length; i += 1) {
    if (input[i] !== 0) return false;
  }
  return true;
}

/**
 * Decompresses a standard bzip2 buffer (one or more concatenated streams). Zero bytes after the
 * last stream are accepted as padding.
 *
 * Fails closed with a `CorruptStreamError` (or a `DecompressionLimitError` past the output cap) on any structural violation, CRC mismatch, trailing
 * garbage, or when the decoded output would exceed `maxOutputBytes`.
 */
export function decompressBzip2(input: Buffer, maxOutputBytes = BZIP2_DEFAULT_MAX_OUTPUT_BYTES): Buffer {
  if (input.length < BZ_HEADER_MIN_BYTES) {
    throw bzError('input too short');
  }
  const reader = new BitReader(input, 0);
  const sink = new OutputSink(
    maxOutputBytes,
    Math.min(input.length * OUTPUT_EXPECTED_EXPANSION, OUTPUT_INITIAL_CAPACITY_MAX)
  );
  for (;;) {
    decodeStream(reader, sink);
    reader.alignToByte();
    if (reader.bytesRemaining() === 0) break;
    // Block-device and tape writers pad files with zero bytes; that padding carries no data.
    if (isZeroPadding(input, input.length - reader.bytesRemaining())) break;
    if (reader.peek(BYTE_BITS) !== BZ_SIGNATURE[0]) {
      throw bzError('trailing garbage after end of stream');
    }
  }
  return sink.result();
}
