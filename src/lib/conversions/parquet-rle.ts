import { ParquetFormatError } from './parquet-format';

/**
 * Parquet RLE / bit-packed hybrid encoding (definition levels and dictionary indices).
 * Governing spec: Parquet Encodings.md, "Run Length Encoding / Bit-Packing Hybrid (RLE = 3)":
 *
 *   rle-bit-packed-hybrid := <length>? <encoded-data>
 *   bit-packed-run  := <bit-pack-header = (groups << 1) | 1> <groups * bit-width bytes, LSB first>
 *   rle-run         := <rle-header = run-length << 1> <value, ceil(bit-width / 8) bytes little endian>
 */

/** Bit-packed runs hold whole groups of eight values. */
const RLE_GROUP_VALUES = 8;
/** A repeat shorter than one group cannot beat bit-packing. */
const RLE_MIN_RUN_VALUES = 8;
const BITS_PER_BYTE = 8;
/** The writer packs through a 32-bit accumulator: 7 pending bits plus one value must fit. */
const RLE_MAX_WRITE_BIT_WIDTH = 24;
/** The reader supports every width the format allows for 32-bit values. */
const RLE_MAX_READ_BIT_WIDTH = 32;
const RLE_MAX_NARROW_READ_WIDTH = 25;
const RLE_MAX_VARINT_BYTES = 5;
const VARINT_DATA_BITS = 7;
const VARINT_CONTINUATION = 0x80;
const INITIAL_SINK_BYTES = 256;
/** Slices up to this long are copied byte by byte. */
const SHORT_SLICE_BYTES = 24;
/** Buffers (and Parquet page sizes, an i32 on the wire) never grow past 2 GiB - 1. */
const SINK_MAX_BYTES = 0x7fff_ffff;
const UINT32_RANGE = 2 ** 32;
const BYTE_MASK = 0xff;
const VARINT_PAYLOAD_MASK = 0x7f;
const BYTE_SHIFT_MASK = 7;
const BIT_PACKED_FLAG = 1;
const BYTE_INDEX_SHIFT = 3;
const RUN_LENGTH_SHIFT = 1;

/** Smallest bit width that represents `maxValue` (0 needs 0 bits). */
export function bitWidthFor(maxValue: number): number {
  return maxValue <= 0 ? 0 : 32 - Math.clz32(maxValue);
}

/**
 * Growable byte buffer with little-endian primitive writers, so hot encoding loops do not allocate
 * per value. `maxBytes` bounds growth (a malicious value size cannot exhaust memory).
 */
export class ByteSink {
  private bytes: Buffer;
  private view: DataView;
  length = 0;

  constructor(initialCapacity = INITIAL_SINK_BYTES, private readonly maxBytes = SINK_MAX_BYTES) {
    this.bytes = Buffer.allocUnsafe(Math.max(initialCapacity, 1));
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
  }

  ensure(extra: number): void {
    const needed = this.length + extra;
    if (needed <= this.bytes.length) return;
    if (needed > this.maxBytes) {
      throw new ParquetFormatError(`Parquet encoder buffer would exceed ${this.maxBytes} bytes`);
    }
    let capacity = this.bytes.length * 2;
    while (capacity < needed) capacity *= 2;
    const grown = Buffer.allocUnsafe(Math.min(capacity, this.maxBytes));
    this.bytes.copy(grown, 0, 0, this.length);
    this.bytes = grown;
    this.view = new DataView(grown.buffer, grown.byteOffset, grown.byteLength);
  }

  writeByte(v: number): void {
    this.ensure(1);
    this.bytes[this.length++] = v;
  }

  writeUint32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.length, v, true);
    this.length += 4;
  }

  writeFloat64(v: number): void {
    this.ensure(8);
    this.view.setFloat64(this.length, v, true);
    this.length += 8;
  }

  /** Writes a safe integer (|v| < 2^53) as a little-endian two's-complement int64. */
  writeInt64(v: number): void {
    this.ensure(8);
    const high = Math.floor(v / UINT32_RANGE);
    this.view.setUint32(this.length, v - high * UINT32_RANGE, true);
    this.view.setInt32(this.length + 4, high, true);
    this.length += 8;
  }

  /** Writes the UTF-8 bytes of `str`; the caller passes the exact byte length. */
  writeUtf8(str: string, byteLength: number): void {
    this.ensure(byteLength);
    const written = this.bytes.write(str, this.length, byteLength, 'utf8');
    if (written !== byteLength) {
      throw new ParquetFormatError('Parquet encoder produced an unexpected UTF-8 length');
    }
    this.length += byteLength;
  }

  /** Copies `length` bytes of `src` from `start`; short runs are copied inline, which beats a native call. */
  writeSlice(src: Uint8Array, start: number, length: number): void {
    this.ensure(length);
    const bytes = this.bytes;
    let to = this.length;
    if (length <= SHORT_SLICE_BYTES) {
      for (let i = start; i < start + length; i++) bytes[to++] = src[i];
    } else {
      bytes.set(src.subarray(start, start + length), to);
    }
    this.length += length;
  }

  writeBytes(src: Uint8Array): void {
    this.ensure(src.length);
    this.bytes.set(src, this.length);
    this.length += src.length;
  }

  writeVarint(value: number): void {
    let v = value;
    while (v >= VARINT_CONTINUATION) {
      this.writeByte((v & VARINT_PAYLOAD_MASK) | VARINT_CONTINUATION);
      v >>>= VARINT_DATA_BITS;
    }
    this.writeByte(v);
  }

  /** Overwrites four bytes at `offset` (used to back-patch length prefixes). */
  patchUint32(offset: number, v: number): void {
    this.view.setUint32(offset, v, true);
  }

  /** Forgets the written bytes but keeps the allocation. */
  reset(): void {
    this.length = 0;
  }

  /** Returns a view of the written bytes (valid until the next write or reset). */
  toBuffer(): Buffer {
    return this.bytes.subarray(0, this.length);
  }
}

function packGroups(sink: ByteSink, values: ArrayLike<number>, start: number, groups: number, bitWidth: number): void {
  const end = start + groups * RLE_GROUP_VALUES;
  let acc = 0;
  let accBits = 0;
  for (let i = start; i < end; i++) {
    acc |= values[i] << accBits;
    accBits += bitWidth;
    while (accBits >= BITS_PER_BYTE) {
      sink.writeByte(acc & BYTE_MASK);
      acc >>>= BITS_PER_BYTE;
      accBits -= BITS_PER_BYTE;
    }
  }
}

function emitBitPackedRun(
  sink: ByteSink,
  values: ArrayLike<number>,
  start: number,
  count: number,
  bitWidth: number
): void {
  const groups = Math.ceil(count / RLE_GROUP_VALUES);
  sink.writeVarint((groups << RUN_LENGTH_SHIFT) | BIT_PACKED_FLAG);
  const fullGroups = Math.floor(count / RLE_GROUP_VALUES);
  packGroups(sink, values, start, fullGroups, bitWidth);
  const tail = count - fullGroups * RLE_GROUP_VALUES;
  if (tail > 0) {
    // The last group is zero padded; readers stop at the declared value count.
    let acc = 0;
    let accBits = 0;
    for (let k = 0; k < RLE_GROUP_VALUES; k++) {
      const v = k < tail ? values[start + fullGroups * RLE_GROUP_VALUES + k] : 0;
      acc |= v << accBits;
      accBits += bitWidth;
      while (accBits >= BITS_PER_BYTE) {
        sink.writeByte(acc & BYTE_MASK);
        acc >>>= BITS_PER_BYTE;
        accBits -= BITS_PER_BYTE;
      }
    }
  }
}

function emitRleRun(sink: ByteSink, value: number, runLength: number, bitWidth: number): void {
  sink.writeVarint(runLength << RUN_LENGTH_SHIFT);
  const valueBytes = Math.ceil(bitWidth / BITS_PER_BYTE);
  for (let b = 0; b < valueBytes; b++) {
    sink.writeByte((value >>> (b * BITS_PER_BYTE)) & BYTE_MASK);
  }
}

/**
 * Appends the RLE/bit-packed hybrid encoding of `values[0..count)` (each < 2^bitWidth) to `sink`.
 * Repeats of eight or more become RLE runs; everything else is packed in groups of eight.
 */
export function encodeRleHybrid(
  sink: ByteSink,
  values: ArrayLike<number>,
  count: number,
  bitWidth: number
): void {
  if (bitWidth < 0 || bitWidth > RLE_MAX_WRITE_BIT_WIDTH) {
    throw new ParquetFormatError(`Unsupported RLE bit width ${bitWidth} for encoding`);
  }
  let literalStart = 0;
  let i = 0;
  while (i < count) {
    const v = values[i];
    let j = i + 1;
    while (j < count && values[j] === v) j++;
    const run = j - i;
    if (run >= RLE_MIN_RUN_VALUES) {
      const pending = i - literalStart;
      // Top up the pending literal group with the head of this run so packed groups stay whole.
      const borrow = pending > 0 ? (RLE_GROUP_VALUES - (pending % RLE_GROUP_VALUES)) % RLE_GROUP_VALUES : 0;
      if (run - borrow >= RLE_MIN_RUN_VALUES) {
        if (pending + borrow > 0) emitBitPackedRun(sink, values, literalStart, pending + borrow, bitWidth);
        emitRleRun(sink, v, run - borrow, bitWidth);
        literalStart = j;
      }
    }
    i = j;
  }
  if (literalStart < count) emitBitPackedRun(sink, values, literalStart, count - literalStart, bitWidth);
}

function readVarint32(buf: Uint8Array, pos: number, end: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let p = pos;
  for (let n = 0; n < RLE_MAX_VARINT_BYTES; n++) {
    if (p >= end) throw new ParquetFormatError('Corrupted Parquet RLE run: truncated header');
    const b = buf[p++];
    value += (b & VARINT_PAYLOAD_MASK) * 2 ** shift;
    if ((b & VARINT_CONTINUATION) === 0) return { value, next: p };
    shift += VARINT_DATA_BITS;
  }
  throw new ParquetFormatError('Corrupted Parquet RLE run: header varint too long');
}

/** Reads `width` bits starting at bit `bitPos` (width <= 32, LSB first). */
function readBits(buf: Uint8Array, bitPos: number, width: number): number {
  const byte = bitPos >>> BYTE_INDEX_SHIFT;
  const shift = bitPos & BYTE_SHIFT_MASK;
  if (width <= RLE_MAX_NARROW_READ_WIDTH) {
    const window =
      (buf[byte] | (buf[byte + 1] << BITS_PER_BYTE) | (buf[byte + 2] << (2 * BITS_PER_BYTE)) | (buf[byte + 3] << (3 * BITS_PER_BYTE))) >>>
      shift;
    return (window & ((1 << width) - 1)) >>> 0;
  }
  const wide =
    buf[byte] +
    buf[byte + 1] * 2 ** BITS_PER_BYTE +
    buf[byte + 2] * 2 ** (2 * BITS_PER_BYTE) +
    buf[byte + 3] * 2 ** (3 * BITS_PER_BYTE) +
    buf[byte + 4] * UINT32_RANGE;
  return Math.floor(wide / 2 ** shift) % 2 ** width;
}

/**
 * Decodes exactly `count` hybrid-encoded values from `buf[start, end)` into `out`.
 * Runs may not read beyond `end`; a short or overlong stream is a typed error.
 */
export function decodeRleHybrid(
  buf: Uint8Array,
  start: number,
  end: number,
  bitWidth: number,
  count: number,
  out: Uint32Array | Uint8Array
): void {
  if (bitWidth < 0 || bitWidth > RLE_MAX_READ_BIT_WIDTH) {
    throw new ParquetFormatError(`Corrupted Parquet RLE stream: unsupported bit width ${bitWidth}`);
  }
  if (count > out.length) throw new ParquetFormatError('Corrupted Parquet RLE stream: output too small');
  const valueBytes = Math.ceil(bitWidth / BITS_PER_BYTE);
  let pos = start;
  let produced = 0;
  while (produced < count) {
    const header = readVarint32(buf, pos, end);
    pos = header.next;
    if ((header.value & BIT_PACKED_FLAG) === BIT_PACKED_FLAG) {
      const groups = Math.floor(header.value / 2);
      const runValues = groups * RLE_GROUP_VALUES;
      const runBytes = groups * bitWidth;
      if (pos + runBytes > end) throw new ParquetFormatError('Corrupted Parquet RLE stream: truncated bit-packed run');
      const take = Math.min(runValues, count - produced);
      const bitBase = pos * BITS_PER_BYTE;
      for (let k = 0; k < take; k++) {
        out[produced + k] = bitWidth === 0 ? 0 : readBitsSafe(buf, bitBase + k * bitWidth, bitWidth, end);
      }
      produced += take;
      pos += runBytes;
    } else {
      const runLength = header.value / 2;
      if (pos + valueBytes > end) throw new ParquetFormatError('Corrupted Parquet RLE stream: truncated RLE run');
      let value = 0;
      for (let b = 0; b < valueBytes; b++) value += buf[pos + b] * 2 ** (b * BITS_PER_BYTE);
      pos += valueBytes;
      const take = Math.min(runLength, count - produced);
      out.fill(value, produced, produced + take);
      produced += take;
    }
  }
}

/** readBits with a guard for the 4-5 byte look-ahead window at the tail of the buffer. */
function readBitsSafe(buf: Uint8Array, bitPos: number, width: number, end: number): number {
  const lastByte = (bitPos + width - 1) >>> BYTE_INDEX_SHIFT;
  if (lastByte >= end) throw new ParquetFormatError('Corrupted Parquet RLE stream: truncated bit-packed values');
  const byte = bitPos >>> BYTE_INDEX_SHIFT;
  // Bytes past `end` read as zero via a bounded window copy.
  if (byte + RLE_MAX_VARINT_BYTES <= end) return readBits(buf, bitPos, width);
  const window = new Uint8Array(RLE_MAX_VARINT_BYTES);
  for (let i = 0; i < RLE_MAX_VARINT_BYTES && byte + i < end; i++) window[i] = buf[byte + i];
  return readBits(window, bitPos - byte * BITS_PER_BYTE, width);
}
