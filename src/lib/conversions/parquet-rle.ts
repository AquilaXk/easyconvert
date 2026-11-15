import { ParquetFormatError } from './parquet-format';

/**
 * Parquet RLE / bit-packed hybrid encoding (definition levels and dictionary indices).
 * Governing spec: Parquet Encodings.md, "Run Length Encoding / Bit-Packing Hybrid (RLE = 3)":
 *
 *   rle-bit-packed-hybrid := <length>? <encoded-data>
 *   bit-packed-run  := <bit-pack-header = (groups << 1) | 1> <groups * bit-width bytes, LSB first>
 *   rle-run         := <rle-header = run-length << 1> <value, ceil(bit-width / 8) bytes little endian>
 *
 * 8-value group word-unrolled bit unpacking adapted from:
 * - `apache/arrow-rs` (`parquet/src/util/bit_pack.rs`, commit `112f01f195e080af7625b6420772240c8a9f9215`,
 *   SHA-256 `a1b5b4f0a60cbd8f44ffbe1e9a5a7b19c973e66d0b7d50fe7a920d506b94e55a`),
 *   Licensed to the Apache Software Foundation (ASF) under the Apache License, Version 2.0.
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

  /** Direct access to the underlying buffer after calling ensure(). */
  rawBuffer(): Buffer {
    return this.bytes;
  }

  /** Direct access to the underlying bytes as a view for word writes, after calling ensure(). */
  rawView(): DataView {
    return this.view;
  }

  /** Returns a view of the written bytes (valid until the next write or reset). */
  toBuffer(): Buffer {
    return this.bytes.subarray(0, this.length);
  }
}

function packGroups(sink: ByteSink, values: ArrayLike<number>, start: number, groups: number, bitWidth: number): void {
  const end = start + groups * RLE_GROUP_VALUES;
  const bytes = sink.rawBuffer();
  let pos = sink.length;
  let acc = 0;
  let accBits = 0;
  for (let i = start; i < end; i++) {
    acc |= values[i] << accBits;
    accBits += bitWidth;
    while (accBits >= BITS_PER_BYTE) {
      bytes[pos++] = acc & BYTE_MASK;
      acc >>>= BITS_PER_BYTE;
      accBits -= BITS_PER_BYTE;
    }
  }
  sink.length = pos;
}

function emitBitPackedRun(
  sink: ByteSink,
  values: ArrayLike<number>,
  start: number,
  count: number,
  bitWidth: number
): void {
  const groups = Math.ceil(count / RLE_GROUP_VALUES);
  sink.ensure(RLE_MAX_VARINT_BYTES + groups * bitWidth);
  sink.writeVarint((groups << RUN_LENGTH_SHIFT) | BIT_PACKED_FLAG);
  const fullGroups = Math.floor(count / RLE_GROUP_VALUES);
  packGroups(sink, values, start, fullGroups, bitWidth);
  const tail = count - fullGroups * RLE_GROUP_VALUES;
  if (tail > 0) {
    // The last group is zero padded; readers stop at the declared value count.
    const bytes = sink.rawBuffer();
    let pos = sink.length;
    let acc = 0;
    let accBits = 0;
    const base = start + fullGroups * RLE_GROUP_VALUES;
    for (let k = 0; k < RLE_GROUP_VALUES; k++) {
      const v = k < tail ? values[base + k] : 0;
      acc |= v << accBits;
      accBits += bitWidth;
      while (accBits >= BITS_PER_BYTE) {
        bytes[pos++] = acc & BYTE_MASK;
        acc >>>= BITS_PER_BYTE;
        accBits -= BITS_PER_BYTE;
      }
    }
    sink.length = pos;
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

let varintNextPos = 0;

function readVarintSlow(buf: Uint8Array, firstByte: number, pos: number, end: number): number {
  let lo = firstByte & VARINT_PAYLOAD_MASK;
  let p = pos;
  for (let n = 1; n < RLE_MAX_VARINT_BYTES; n++) {
    if (p >= end) throw new ParquetFormatError('Corrupted Parquet RLE run: truncated header');
    const b = buf[p++];
    if (n < 4) {
      lo |= (b & VARINT_PAYLOAD_MASK) << (n * VARINT_DATA_BITS);
    } else {
      const value = (lo >>> 0) + (b & VARINT_PAYLOAD_MASK) * 0x10000000;
      if ((b & VARINT_CONTINUATION) === 0) {
        varintNextPos = p;
        return value;
      }
      throw new ParquetFormatError('Corrupted Parquet RLE run: header varint too long');
    }
    if ((b & VARINT_CONTINUATION) === 0) {
      varintNextPos = p;
      return lo >>> 0;
    }
  }
  throw new ParquetFormatError('Corrupted Parquet RLE run: header varint too long');
}

function readBitsScalar(view: DataView, bitPos: number, bitWidth: number, mask: number): number {
  const len = view.byteLength;
  const bytePos = bitPos >>> BYTE_INDEX_SHIFT;
  const shift = bitPos & BYTE_SHIFT_MASK;
  if (bytePos + RLE_MAX_VARINT_BYTES <= len) {
    const lo = view.getUint32(bytePos, true) >>> shift;
    if (shift === 0 || shift + bitWidth <= 32) return (lo & mask) >>> 0;
    return ((lo | (view.getUint8(bytePos + 4) << (32 - shift))) & mask) >>> 0;
  }
  const b0 = bytePos < len ? view.getUint8(bytePos) : 0;
  const b1 = bytePos + 1 < len ? view.getUint8(bytePos + 1) : 0;
  const b2 = bytePos + 2 < len ? view.getUint8(bytePos + 2) : 0;
  const b3 = bytePos + 3 < len ? view.getUint8(bytePos + 3) : 0;
  const lo = ((b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0) >>> shift;
  if (shift === 0 || shift + bitWidth <= 32) return (lo & mask) >>> 0;
  const b4 = bytePos + 4 < len ? view.getUint8(bytePos + 4) : 0;
  return ((lo | (b4 << (32 - shift))) & mask) >>> 0;
}

function unpackBitWidth1(buf: Uint8Array, pos: number, take: number, out: Uint32Array | Uint8Array, produced: number): void {
  let rem = take;
  let bIdx = pos;
  let outIdx = produced;
  while (rem >= 8) {
    const b = buf[bIdx++];
    out[outIdx] = b & 1;
    out[outIdx + 1] = (b >>> 1) & 1;
    out[outIdx + 2] = (b >>> 2) & 1;
    out[outIdx + 3] = (b >>> 3) & 1;
    out[outIdx + 4] = (b >>> 4) & 1;
    out[outIdx + 5] = (b >>> 5) & 1;
    out[outIdx + 6] = (b >>> 6) & 1;
    out[outIdx + 7] = (b >>> 7) & 1;
    outIdx += 8;
    rem -= 8;
  }
  if (rem > 0) {
    const b = buf[bIdx];
    for (let k = 0; k < rem; k++) out[outIdx + k] = (b >>> k) & 1;
  }
}

function unpackNarrowGroups(
  view: DataView,
  pos: number,
  bitWidth: number,
  take: number,
  out: Uint32Array | Uint8Array,
  produced: number
): void {
  const mask = 0xffffffff >>> (32 - bitWidth);
  const o1 = bitWidth >>> 3, s1 = bitWidth & 7;
  const o2 = (bitWidth * 2) >>> 3, s2 = (bitWidth * 2) & 7;
  const o3 = (bitWidth * 3) >>> 3, s3 = (bitWidth * 3) & 7;
  const o4 = (bitWidth * 4) >>> 3, s4 = (bitWidth * 4) & 7;
  const o5 = (bitWidth * 5) >>> 3, s5 = (bitWidth * 5) & 7;
  const o6 = (bitWidth * 6) >>> 3, s6 = (bitWidth * 6) & 7;
  const o7 = (bitWidth * 7) >>> 3, s7 = (bitWidth * 7) & 7;
  const safeGroupEnd = view.byteLength - bitWidth - 3;
  let bIdx = pos;
  let outIdx = produced;
  let rem = take;
  while (rem >= 8 && bIdx <= safeGroupEnd) {
    out[outIdx] = (view.getUint32(bIdx, true) & mask) >>> 0;
    out[outIdx + 1] = ((view.getUint32(bIdx + o1, true) >>> s1) & mask) >>> 0;
    out[outIdx + 2] = ((view.getUint32(bIdx + o2, true) >>> s2) & mask) >>> 0;
    out[outIdx + 3] = ((view.getUint32(bIdx + o3, true) >>> s3) & mask) >>> 0;
    out[outIdx + 4] = ((view.getUint32(bIdx + o4, true) >>> s4) & mask) >>> 0;
    out[outIdx + 5] = ((view.getUint32(bIdx + o5, true) >>> s5) & mask) >>> 0;
    out[outIdx + 6] = ((view.getUint32(bIdx + o6, true) >>> s6) & mask) >>> 0;
    out[outIdx + 7] = ((view.getUint32(bIdx + o7, true) >>> s7) & mask) >>> 0;
    bIdx += bitWidth;
    outIdx += 8;
    rem -= 8;
  }
  if (rem > 0) {
    const bitBase = bIdx * BITS_PER_BYTE;
    for (let k = 0; k < rem; k++) {
      out[outIdx + k] = readBitsScalar(view, bitBase + k * bitWidth, bitWidth, mask);
    }
  }
}

function readWideAt(view: DataView, bytePos: number, shift: number, bitWidth: number, mask: number): number {
  const lo = view.getUint32(bytePos, true) >>> shift;
  if (shift === 0 || shift + bitWidth <= 32) return (lo & mask) >>> 0;
  return ((lo | (view.getUint8(bytePos + 4) << (32 - shift))) & mask) >>> 0;
}

function unpackWideGroups(
  view: DataView,
  pos: number,
  bitWidth: number,
  take: number,
  out: Uint32Array | Uint8Array,
  produced: number
): void {
  const mask = 0xffffffff >>> (32 - bitWidth);
  const o1 = bitWidth >>> 3, s1 = bitWidth & 7;
  const o2 = (bitWidth * 2) >>> 3, s2 = (bitWidth * 2) & 7;
  const o3 = (bitWidth * 3) >>> 3, s3 = (bitWidth * 3) & 7;
  const o4 = (bitWidth * 4) >>> 3, s4 = (bitWidth * 4) & 7;
  const o5 = (bitWidth * 5) >>> 3, s5 = (bitWidth * 5) & 7;
  const o6 = (bitWidth * 6) >>> 3, s6 = (bitWidth * 6) & 7;
  const o7 = (bitWidth * 7) >>> 3, s7 = (bitWidth * 7) & 7;
  const safeGroupEnd = view.byteLength - bitWidth - 4;
  let bIdx = pos;
  let outIdx = produced;
  let rem = take;
  while (rem >= 8 && bIdx <= safeGroupEnd) {
    out[outIdx] = (view.getUint32(bIdx, true) & mask) >>> 0;
    out[outIdx + 1] = readWideAt(view, bIdx + o1, s1, bitWidth, mask);
    out[outIdx + 2] = readWideAt(view, bIdx + o2, s2, bitWidth, mask);
    out[outIdx + 3] = readWideAt(view, bIdx + o3, s3, bitWidth, mask);
    out[outIdx + 4] = readWideAt(view, bIdx + o4, s4, bitWidth, mask);
    out[outIdx + 5] = readWideAt(view, bIdx + o5, s5, bitWidth, mask);
    out[outIdx + 6] = readWideAt(view, bIdx + o6, s6, bitWidth, mask);
    out[outIdx + 7] = readWideAt(view, bIdx + o7, s7, bitWidth, mask);
    bIdx += bitWidth;
    outIdx += 8;
    rem -= 8;
  }
  if (rem > 0) {
    const bitBase = bIdx * BITS_PER_BYTE;
    for (let k = 0; k < rem; k++) {
      out[outIdx + k] = readBitsScalar(view, bitBase + k * bitWidth, bitWidth, mask);
    }
  }
}

function readRleValue(buf: Uint8Array, pos: number, valueBytes: number): number {
  if (valueBytes === 0) return 0;
  if (valueBytes === 1) return buf[pos];
  if (valueBytes === 2) return buf[pos] | (buf[pos + 1] << 8);
  if (valueBytes === 3) return buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16);
  return (buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24)) >>> 0;
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
  const valueBytes = (bitWidth + 7) >>> BYTE_INDEX_SHIFT;
  const view = bitWidth >= 2 ? new DataView(buf.buffer, buf.byteOffset, buf.byteLength) : null;
  let pos = start;
  let produced = 0;
  while (produced < count) {
    if (pos >= end) throw new ParquetFormatError('Corrupted Parquet RLE run: truncated header');
    let headerVal = buf[pos++];
    if (headerVal >= VARINT_CONTINUATION) {
      headerVal = readVarintSlow(buf, headerVal, pos, end);
      pos = varintNextPos;
    }
    if ((headerVal & BIT_PACKED_FLAG) === BIT_PACKED_FLAG) {
      const groups = Math.floor(headerVal / 2);
      const runValues = groups * RLE_GROUP_VALUES;
      const runBytes = groups * bitWidth;
      if (pos + runBytes > end) throw new ParquetFormatError('Corrupted Parquet RLE stream: truncated bit-packed run');
      const take = Math.min(runValues, count - produced);
      if (bitWidth === 0) {
        out.fill(0, produced, produced + take);
      } else if (bitWidth === 1) {
        unpackBitWidth1(buf, pos, take, out, produced);
      } else if (bitWidth === 8) {
        out.set(buf.subarray(pos, pos + take), produced);
      } else if (bitWidth === 16) {
        const dv = view as DataView;
        for (let k = 0, b = pos; k < take; k++, b += 2) out[produced + k] = dv.getUint16(b, true);
      } else if (bitWidth === 32) {
        const dv = view as DataView;
        for (let k = 0, b = pos; k < take; k++, b += 4) out[produced + k] = dv.getUint32(b, true);
      } else if (bitWidth <= RLE_MAX_NARROW_READ_WIDTH) {
        unpackNarrowGroups(view as DataView, pos, bitWidth, take, out, produced);
      } else {
        unpackWideGroups(view as DataView, pos, bitWidth, take, out, produced);
      }
      produced += take;
      pos += runBytes;
    } else {
      const runLength = headerVal / 2;
      if (pos + valueBytes > end) throw new ParquetFormatError('Corrupted Parquet RLE stream: truncated RLE run');
      const value = readRleValue(buf, pos, valueBytes);
      pos += valueBytes;
      const take = Math.min(runLength, count - produced);
      out.fill(value, produced, produced + take);
      produced += take;
    }
  }
}
