import { ConversionFailedError } from '../types';
import { ZSTD_FSE_ACCURACY_LOG_MIN as ZSTD_FSE_MIN_LOG } from './zstd-tables';

/**
 * Finite State Entropy (FSE) primitives for RFC 8878 section 4.1: bit streams, table
 * description reading/writing, count normalization, and decode/encode table construction.
 */

const BITS_PER_BYTE = 8;
const BITS_PER_FIELD_CHUNK = 24;
const FIELD_CHUNK_RADIX = 2 ** BITS_PER_FIELD_CHUNK;
const NCOUNT_ACCURACY_LOG_BITS = 4;
const NCOUNT_LONG_ZERO_RUN = 24;
const NCOUNT_SHORT_ZERO_RUN = 3;
const NCOUNT_LONG_ZERO_FLAG = 0xffff;
const NCOUNT_LONG_ZERO_FLAG_BITS = 16;
const NCOUNT_SHORT_ZERO_FLAG_BITS = 2;
const FSE_STATE_DELTA_SHIFT = 16;
const FSE_STATE_DELTA_ROUND = 1 << 15;
const WRITER_CHUNK_BITS = 16;
const WRITER_CHUNK_RADIX = 1 << WRITER_CHUNK_BITS;

export function zstdFail(message: string): never {
  throw new ConversionFailedError(message);
}

export function highBit32(value: number): number {
  return 31 - Math.clz32(value);
}

// ---------------------------------------------------------------------------
// Bit streams
// ---------------------------------------------------------------------------

/**
 * Backward bit reader for streams that end with a stop bit (RFC 8878 section 4.1.1).
 * `bitsLeft` may become negative when a caller over-reads; missing bits read as zero.
 */
export class ReverseBitReader {
  public bitsLeft: number;
  private readonly buf: Uint8Array;
  private readonly start: number;
  private readonly end: number;

  constructor(buf: Uint8Array, start: number, end: number) {
    if (end <= start) zstdFail('Malformed Zstandard bitstream: empty stream.');
    const last = buf[end - 1];
    if (last === 0) zstdFail('Malformed Zstandard bitstream: missing end mark.');
    this.buf = buf;
    this.start = start;
    this.end = end;
    this.bitsLeft = (end - 1 - start) * BITS_PER_BYTE + highBit32(last);
  }

  private byteAt(index: number): number {
    const abs = this.start + index;
    if (abs < this.start || abs >= this.end) return 0;
    return this.buf[abs];
  }

  /** Value of bits [pos, pos + n) with n <= 24, bits below zero reading as zero. */
  private field(pos: number, n: number): number {
    const byteIdx = pos >> 3;
    const shift = pos & 7;
    const fast = this.start + byteIdx;
    if (pos >= 0 && fast + 3 < this.end) {
      const buf = this.buf;
      const fastWord = (buf[fast] | (buf[fast + 1] << 8) | (buf[fast + 2] << 16) | (buf[fast + 3] << 24)) >>> 0;
      return (fastWord >>> shift) & ((1 << n) - 1);
    }
    const b0 = this.byteAt(byteIdx);
    const b1 = this.byteAt(byteIdx + 1);
    const b2 = this.byteAt(byteIdx + 2);
    const b3 = this.byteAt(byteIdx + 3);
    const word = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
    return (word >>> shift) & ((1 << n) - 1);
  }

  private wideField(pos: number, n: number): number {
    if (n <= BITS_PER_FIELD_CHUNK) return this.field(pos, n);
    const lo = this.field(pos, BITS_PER_FIELD_CHUNK);
    const hi = this.field(pos + BITS_PER_FIELD_CHUNK, n - BITS_PER_FIELD_CHUNK);
    return hi * FIELD_CHUNK_RADIX + lo;
  }

  /** Reads and consumes n (<= 32) bits. */
  public read(n: number): number {
    if (n === 0) return 0;
    this.bitsLeft -= n;
    return this.wideField(this.bitsLeft, n);
  }

  /** Reads n (<= 24) bits without consuming them. */
  public peek(n: number): number {
    return this.field(this.bitsLeft - n, n);
  }

  public consume(n: number): void {
    this.bitsLeft -= n;
  }

  public get overflowed(): boolean {
    return this.bitsLeft < 0;
  }
}

/** Forward LSB-first bit reader used for FSE table descriptions. */
export class ForwardBitReader {
  public bitPos = 0;
  private readonly buf: Uint8Array;
  private readonly start: number;
  private readonly totalBits: number;

  constructor(buf: Uint8Array, start: number, end: number) {
    this.buf = buf;
    this.start = start;
    this.totalBits = (end - start) * BITS_PER_BYTE;
  }

  public peek(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i++) {
      const bit = this.bitPos + i;
      if (bit < this.totalBits) {
        value |= ((this.buf[this.start + (bit >> 3)] >> (bit & 7)) & 1) << i;
      }
    }
    return value;
  }

  public skip(n: number): void {
    this.bitPos += n;
  }

  public read(n: number): number {
    const value = this.peek(n);
    this.bitPos += n;
    return value;
  }

  public get overrun(): boolean {
    return this.bitPos > this.totalBits;
  }

  public get bytesConsumed(): number {
    return (this.bitPos + 7) >> 3;
  }
}

/** Forward LSB-first bit writer into a preallocated buffer. Writes past capacity set `overflow`. */
export class BitWriter {
  public pos: number;
  public overflow = false;
  private readonly buf: Uint8Array;
  private readonly capacityEnd: number;
  private acc = 0;
  private nbits = 0;

  constructor(buf: Uint8Array, start: number, end: number = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.capacityEnd = end;
  }

  private flushBytes(): void {
    while (this.nbits >= BITS_PER_BYTE) {
      if (this.pos >= this.capacityEnd) {
        this.overflow = true;
        this.acc = 0;
        this.nbits = 0;
        return;
      }
      this.buf[this.pos++] = this.acc & 0xff;
      this.acc >>>= BITS_PER_BYTE;
      this.nbits -= BITS_PER_BYTE;
    }
  }

  /** Writes the low n (<= 24) bits of value. */
  public write(value: number, n: number): void {
    if (n === 0) return;
    this.acc |= value << this.nbits;
    this.nbits += n;
    this.flushBytes();
  }

  /** Writes the low n (<= 32) bits of a non-negative integer value. */
  public writeWide(value: number, n: number): void {
    if (n <= BITS_PER_FIELD_CHUNK) {
      this.write(value, n);
      return;
    }
    this.write(value % WRITER_CHUNK_RADIX, WRITER_CHUNK_BITS);
    this.write(Math.floor(value / WRITER_CHUNK_RADIX), n - WRITER_CHUNK_BITS);
  }

  /** Appends the end mark (a 1 bit) and pads to a byte boundary. Returns the end position. */
  public closeWithStopBit(): number {
    this.write(1, 1);
    this.flushPartial();
    return this.pos;
  }

  /** Pads to a byte boundary without an end mark. Returns the end position. */
  public flushPartial(): number {
    if (this.nbits > 0) {
      if (this.pos >= this.capacityEnd) {
        this.overflow = true;
      } else {
        this.buf[this.pos++] = this.acc & 0xff;
      }
      this.acc = 0;
      this.nbits = 0;
    }
    return this.pos;
  }
}

// ---------------------------------------------------------------------------
// Decode tables
// ---------------------------------------------------------------------------

export interface FseDecodeTable {
  accuracyLog: number;
  symbol: Uint8Array;
  nbBits: Uint8Array;
  base: Uint16Array;
}

export interface FseNormalizedTable {
  accuracyLog: number;
  counts: Int16Array;
  maxSymbol: number;
}

/** Spreads symbols over the state table (RFC 8878 section 4.1.1). */
function spreadSymbols(counts: ArrayLike<number>, maxSymbol: number, accuracyLog: number): Uint8Array {
  const size = 1 << accuracyLog;
  const tableSymbol = new Uint8Array(size);
  let highThreshold = size - 1;
  for (let s = 0; s <= maxSymbol; s++) {
    if (counts[s] === -1) tableSymbol[highThreshold--] = s;
  }
  const step = (size >> 1) + (size >> 3) + 3;
  const mask = size - 1;
  let position = 0;
  for (let s = 0; s <= maxSymbol; s++) {
    for (let i = 0; i < counts[s]; i++) {
      tableSymbol[position] = s;
      position = (position + step) & mask;
      while (position > highThreshold) position = (position + step) & mask;
    }
  }
  if (position !== 0) zstdFail('Malformed Zstandard FSE table: symbol spreading did not close.');
  return tableSymbol;
}

export function buildFseDecodeTable(counts: ArrayLike<number>, maxSymbol: number, accuracyLog: number): FseDecodeTable {
  const size = 1 << accuracyLog;
  const tableSymbol = spreadSymbols(counts, maxSymbol, accuracyLog);
  const symbolNext = new Uint16Array(maxSymbol + 1);
  for (let s = 0; s <= maxSymbol; s++) {
    symbolNext[s] = counts[s] === -1 ? 1 : counts[s];
  }
  const nbBits = new Uint8Array(size);
  const base = new Uint16Array(size);
  for (let u = 0; u < size; u++) {
    const s = tableSymbol[u];
    const next = symbolNext[s]++;
    const bits = accuracyLog - highBit32(next);
    nbBits[u] = bits;
    base[u] = (next << bits) - size;
  }
  return { accuracyLog, symbol: tableSymbol, nbBits, base };
}

/** Reads an FSE table description (RFC 8878 section 4.1.1). */
export function readFseNormalizedTable(
  buf: Uint8Array,
  start: number,
  end: number,
  maxSymbol: number,
  maxAccuracyLog: number
): { table: FseNormalizedTable; bytesRead: number } {
  const reader = new ForwardBitReader(buf, start, end);
  const accuracyLog = reader.read(NCOUNT_ACCURACY_LOG_BITS) + ZSTD_FSE_MIN_LOG;
  if (accuracyLog > maxAccuracyLog) {
    zstdFail(`Malformed Zstandard FSE table: accuracy log ${accuracyLog} exceeds ${maxAccuracyLog}.`);
  }
  const counts = new Int16Array(maxSymbol + 1);
  let remaining = (1 << accuracyLog) + 1;
  let threshold = 1 << accuracyLog;
  let nbBits = accuracyLog + 1;
  let symbol = 0;
  let previousIsZero = false;
  while (remaining > 1 && symbol <= maxSymbol) {
    if (previousIsZero) {
      let zeroEnd = symbol;
      while (reader.peek(NCOUNT_LONG_ZERO_FLAG_BITS) === NCOUNT_LONG_ZERO_FLAG) {
        zeroEnd += NCOUNT_LONG_ZERO_RUN;
        reader.skip(NCOUNT_LONG_ZERO_FLAG_BITS);
        if (reader.overrun) zstdFail('Malformed Zstandard FSE table: truncated.');
      }
      while (reader.peek(NCOUNT_SHORT_ZERO_FLAG_BITS) === 3) {
        zeroEnd += NCOUNT_SHORT_ZERO_RUN;
        reader.skip(NCOUNT_SHORT_ZERO_FLAG_BITS);
        if (reader.overrun) zstdFail('Malformed Zstandard FSE table: truncated.');
      }
      zeroEnd += reader.read(NCOUNT_SHORT_ZERO_FLAG_BITS);
      if (zeroEnd > maxSymbol) zstdFail('Malformed Zstandard FSE table: symbol out of range.');
      while (symbol < zeroEnd) counts[symbol++] = 0;
    }
    const max = 2 * threshold - 1 - remaining;
    let count = reader.peek(nbBits - 1);
    if (count < max) {
      reader.skip(nbBits - 1);
    } else {
      count = reader.peek(nbBits);
      if (count >= threshold) count -= max;
      reader.skip(nbBits);
    }
    count--;
    remaining -= count < 0 ? -count : count;
    counts[symbol++] = count;
    previousIsZero = count === 0;
    if (remaining < 1) zstdFail('Malformed Zstandard FSE table: probabilities exceed table size.');
    while (remaining < threshold) {
      nbBits--;
      threshold >>= 1;
    }
    if (reader.overrun) zstdFail('Malformed Zstandard FSE table: truncated.');
  }
  if (remaining !== 1) zstdFail('Malformed Zstandard FSE table: probabilities do not fill the table.');
  if (reader.overrun) zstdFail('Malformed Zstandard FSE table: truncated.');
  return {
    table: { accuracyLog, counts, maxSymbol: symbol - 1 },
    bytesRead: reader.bytesConsumed,
  };
}

// ---------------------------------------------------------------------------
// Encode tables
// ---------------------------------------------------------------------------

export interface FseEncodeTable {
  accuracyLog: number;
  stateTable: Uint16Array;
  deltaNbBits: Int32Array;
  deltaFindState: Int32Array;
}

export function buildFseEncodeTable(counts: ArrayLike<number>, maxSymbol: number, accuracyLog: number): FseEncodeTable {
  const size = 1 << accuracyLog;
  const tableSymbol = spreadSymbols(counts, maxSymbol, accuracyLog);
  const cumul = new Int32Array(maxSymbol + 2);
  for (let s = 0; s <= maxSymbol; s++) {
    const c = counts[s] === -1 ? 1 : counts[s];
    cumul[s + 1] = cumul[s] + c;
  }
  const cursor = Int32Array.from(cumul);
  const stateTable = new Uint16Array(size);
  for (let u = 0; u < size; u++) {
    stateTable[cursor[tableSymbol[u]]++] = size + u;
  }
  const deltaNbBits = new Int32Array(maxSymbol + 1);
  const deltaFindState = new Int32Array(maxSymbol + 1);
  let total = 0;
  for (let s = 0; s <= maxSymbol; s++) {
    const c = counts[s];
    if (c === 0) {
      deltaNbBits[s] = ((accuracyLog + 1) << FSE_STATE_DELTA_SHIFT) - size;
    } else if (c === -1 || c === 1) {
      deltaNbBits[s] = (accuracyLog << FSE_STATE_DELTA_SHIFT) - size;
      deltaFindState[s] = total - 1;
      total++;
    } else {
      const maxBitsOut = accuracyLog - highBit32(c - 1);
      const minStatePlus = c << maxBitsOut;
      deltaNbBits[s] = (maxBitsOut << FSE_STATE_DELTA_SHIFT) - minStatePlus;
      deltaFindState[s] = total - c;
      total += c;
    }
  }
  return { accuracyLog, stateTable, deltaNbBits, deltaFindState };
}

/** Returns the FSE state a stream starts from when its final (first-encoded) symbol is `symbol`. */
export function fseInitState(table: FseEncodeTable, symbol: number): number {
  const delta = table.deltaNbBits[symbol];
  const nbBitsOut = (delta + FSE_STATE_DELTA_ROUND) >> FSE_STATE_DELTA_SHIFT;
  const value = (nbBitsOut << FSE_STATE_DELTA_SHIFT) - delta;
  return table.stateTable[(value >> nbBitsOut) + table.deltaFindState[symbol]];
}

// ---------------------------------------------------------------------------
// Normalization and table description writing
// ---------------------------------------------------------------------------

/**
 * Scales a histogram to a normalized distribution summing to 2^accuracyLog. Symbols whose
 * share is below one table slot get the "less than 1" marker (-1), mirroring the format.
 * Requires at least two distinct symbols.
 */
export function normalizeFseCounts(
  histogram: ArrayLike<number>,
  maxSymbol: number,
  total: number,
  accuracyLog: number
): Int16Array {
  const size = 1 << accuracyLog;
  const norm = new Int16Array(maxSymbol + 1);
  const lowThreshold = total >> accuracyLog;
  let assigned = 0;
  for (let s = 0; s <= maxSymbol; s++) {
    const count = histogram[s];
    if (count === 0) continue;
    if (count <= lowThreshold) {
      norm[s] = -1;
      assigned++;
    } else {
      const scaled = Math.round((count * size) / total);
      norm[s] = scaled < 1 ? 1 : scaled;
      assigned += norm[s];
    }
  }
  while (assigned !== size) {
    let pick = -1;
    let pickScore = assigned < size ? -Infinity : Infinity;
    for (let s = 0; s <= maxSymbol; s++) {
      const count = histogram[s];
      if (count === 0 || norm[s] === -1) continue;
      if (assigned < size) {
        const score = count / norm[s];
        if (score > pickScore) {
          pickScore = score;
          pick = s;
        }
      } else if (norm[s] > 1) {
        const score = count / (norm[s] - 1);
        if (score < pickScore) {
          pickScore = score;
          pick = s;
        }
      }
    }
    if (pick < 0) zstdFail('Zstandard FSE normalization failed: no adjustable symbol.');
    if (assigned < size) {
      norm[pick]++;
      assigned++;
    } else {
      norm[pick]--;
      assigned--;
    }
  }
  return norm;
}

/** Estimated payload bits of coding `histogram` with the given distribution. */
export function estimateFseBits(
  histogram: ArrayLike<number>,
  maxSymbol: number,
  counts: ArrayLike<number>,
  accuracyLog: number
): number {
  let bits = 0;
  for (let s = 0; s <= maxSymbol; s++) {
    const h = histogram[s];
    if (h === 0) continue;
    const c = counts[s];
    if (c === 0) return Infinity;
    const probability = c === -1 ? 1 : c;
    bits += h * (accuracyLog - Math.log2(probability));
  }
  return bits;
}

/** Serialises a normalized table (RFC 8878 section 4.1.1). Returns the end position or -1 on overflow. */
export function writeFseNormalizedTable(
  out: Uint8Array,
  start: number,
  counts: ArrayLike<number>,
  maxSymbol: number,
  accuracyLog: number
): number {
  const writer = new BitWriter(out, start);
  const size = 1 << accuracyLog;
  let remaining = size + 1;
  let threshold = size;
  let nbBits = accuracyLog + 1;
  writer.write(accuracyLog - ZSTD_FSE_MIN_LOG, NCOUNT_ACCURACY_LOG_BITS);
  let symbol = 0;
  let previousIsZero = false;
  while (symbol <= maxSymbol && remaining > 1) {
    if (previousIsZero) {
      let zeroStart = symbol;
      while (symbol <= maxSymbol && counts[symbol] === 0) symbol++;
      while (symbol >= zeroStart + NCOUNT_LONG_ZERO_RUN) {
        writer.write(NCOUNT_LONG_ZERO_FLAG, NCOUNT_LONG_ZERO_FLAG_BITS);
        zeroStart += NCOUNT_LONG_ZERO_RUN;
      }
      while (symbol >= zeroStart + NCOUNT_SHORT_ZERO_RUN) {
        writer.write(3, NCOUNT_SHORT_ZERO_FLAG_BITS);
        zeroStart += NCOUNT_SHORT_ZERO_RUN;
      }
      writer.write(symbol - zeroStart, NCOUNT_SHORT_ZERO_FLAG_BITS);
    }
    let count = counts[symbol++];
    const max = 2 * threshold - 1 - remaining;
    remaining -= count < 0 ? -count : count;
    count++;
    if (count >= threshold) count += max;
    writer.write(count, count < max ? nbBits - 1 : nbBits);
    previousIsZero = count === 1;
    if (remaining < 1) zstdFail('Zstandard FSE table writer: probabilities exceed table size.');
    while (remaining < threshold) {
      nbBits--;
      threshold >>= 1;
    }
  }
  if (remaining !== 1) zstdFail('Zstandard FSE table writer: probabilities do not fill the table.');
  const end = writer.flushPartial();
  return writer.overflow ? -1 : end;
}
