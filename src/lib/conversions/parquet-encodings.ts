import { PARQUET_MAX_DECODED_VALUE_BYTES, ParquetFormatError } from './parquet-format';
import { ColumnValue } from './parquet-logical';
import { decodeRleHybrid } from './parquet-rle';

/**
 * Additional Parquet value and level decoders (Encodings.md):
 *  - DELTA_BINARY_PACKED (5) for INT32 and INT64 columns and length streams
 *  - DELTA_LENGTH_BYTE_ARRAY (6) for BYTE_ARRAY columns
 *  - DELTA_BYTE_ARRAY (7) for prefix-compressed BYTE_ARRAY and FIXED_LEN_BYTE_ARRAY columns
 *  - BYTE_STREAM_SPLIT (9) for fixed-width physical types (FLOAT, DOUBLE, INT32, INT64, FIXED_LEN_BYTE_ARRAY)
 *  - RLE (3) for BOOLEAN data pages
 *  - BIT_PACKED (4) for legacy v1 definition/repetition levels
 */

const BITS_PER_BYTE = 8;
const BYTE_ARRAY_LENGTH_PREFIX_BYTES = 4;
const MAX_VARINT_BYTES = 10;
const VARINT_DATA_BITS = 7n;
const VARINT_DATA_MASK = 0x7fn;
const VARINT_CONTINUE_BIT = 0x80;
const DELTA_BLOCK_MULTIPLE = 128;
const DELTA_MINIBLOCK_MULTIPLE = 32;

function readUleb128(page: Buffer, start: number, column: string): { value: bigint; next: number } {
  let result = 0n;
  let shift = 0n;
  let pos = start;
  for (let i = 0; i < MAX_VARINT_BYTES; i++) {
    if (pos >= page.length) {
      throw new ParquetFormatError(`Corrupted Parquet file: truncated varint in column '${column}'`);
    }
    const byte = page[pos++];
    if (i === MAX_VARINT_BYTES - 1 && (byte & 0xfe) !== 0) {
      throw new ParquetFormatError(`Corrupted Parquet file: varint overflow in column '${column}'`);
    }
    result |= (BigInt(byte) & VARINT_DATA_MASK) << shift;
    if ((byte & VARINT_CONTINUE_BIT) === 0) {
      return { value: BigInt.asUintN(64, result), next: pos };
    }
    shift += VARINT_DATA_BITS;
  }
  throw new ParquetFormatError(`Corrupted Parquet file: varint exceeds ${MAX_VARINT_BYTES} bytes in column '${column}'`);
}

function readZigzagLeb128(page: Buffer, start: number, column: string): { value: bigint; next: number } {
  const { value: u, next } = readUleb128(page, start, column);
  return { value: (u >> 1n) ^ -(u & 1n), next };
}

/**
 * Decodes a DELTA_BINARY_PACKED stream of `count` integers (32-bit or 64-bit two's-complement wrapping).
 */
export function decodeDeltaBinaryPacked(
  page: Buffer,
  start: number,
  count: number,
  bitWidthLimit: 32 | 64,
  column: string
): { values: BigInt64Array; end: number } {
  if (count === 0 && start === page.length) {
    return { values: new BigInt64Array(0), end: start };
  }
  const blockSizeVar = readUleb128(page, start, column);
  const miniBlocksVar = readUleb128(page, blockSizeVar.next, column);
  const totalValuesVar = readUleb128(page, miniBlocksVar.next, column);
  const firstValueVar = readZigzagLeb128(page, totalValuesVar.next, column);

  const blockSize = Number(blockSizeVar.value);
  const miniBlocks = Number(miniBlocksVar.value);
  const totalValues = Number(totalValuesVar.value);
  if (
    !Number.isSafeInteger(blockSize) ||
    blockSize < DELTA_BLOCK_MULTIPLE ||
    blockSize % DELTA_BLOCK_MULTIPLE !== 0 ||
    !Number.isSafeInteger(miniBlocks) ||
    miniBlocks < 1 ||
    blockSize % miniBlocks !== 0
  ) {
    throw new ParquetFormatError(`Corrupted Parquet file: invalid delta block header in column '${column}'`);
  }
  const valuesPerMiniBlock = blockSize / miniBlocks;
  if (valuesPerMiniBlock % DELTA_MINIBLOCK_MULTIPLE !== 0) {
    throw new ParquetFormatError(`Corrupted Parquet file: invalid delta miniblock size in column '${column}'`);
  }
  if (totalValues !== count) {
    throw new ParquetFormatError(
      `Corrupted Parquet file: delta stream declares ${totalValues} values for ${count} values in column '${column}'`
    );
  }

  let pos = firstValueVar.next;
  if (count === 0) {
    return { values: new BigInt64Array(0), end: pos };
  }

  const values = new BigInt64Array(count);
  let current = BigInt.asIntN(bitWidthLimit, firstValueVar.value);
  values[0] = current;
  let outIdx = 1;

  while (outIdx < count) {
    const minDeltaVar = readZigzagLeb128(page, pos, column);
    pos = minDeltaVar.next;
    const minDelta = BigInt.asIntN(bitWidthLimit, minDeltaVar.value);

    if (pos + miniBlocks > page.length) {
      throw new ParquetFormatError(`Corrupted Parquet file: truncated delta miniblock bitwidths in column '${column}'`);
    }
    const bitWidths = page.subarray(pos, pos + miniBlocks);
    pos += miniBlocks;

    for (let m = 0; m < miniBlocks && outIdx < count; m++) {
      const bw = bitWidths[m];
      if (bw > bitWidthLimit) {
        throw new ParquetFormatError(
          `Corrupted Parquet file: delta bit width ${bw} exceeds ${bitWidthLimit} in column '${column}'`
        );
      }
      const miniBlockBytes = (valuesPerMiniBlock / BITS_PER_BYTE) * bw;
      if (pos + miniBlockBytes > page.length) {
        throw new ParquetFormatError(`Corrupted Parquet file: truncated delta miniblock data in column '${column}'`);
      }
      const take = Math.min(valuesPerMiniBlock, count - outIdx);
      if (bw === 0) {
        for (let i = 0; i < take; i++) {
          current = BigInt.asIntN(bitWidthLimit, current + minDelta);
          values[outIdx++] = current;
        }
      } else {
        const mask = (1n << BigInt(bw)) - 1n;
        let bitPos = 0;
        for (let i = 0; i < take; i++) {
          let byteIdx = pos + (bitPos >>> 3);
          let bitOffset = bitPos & 7;
          let raw = 0n;
          let bitsFilled = 0;
          while (bitsFilled < bw) {
            raw |= BigInt(page[byteIdx++] >>> bitOffset) << BigInt(bitsFilled);
            const step = BITS_PER_BYTE - bitOffset;
            bitsFilled += step;
            bitOffset = 0;
          }
          const delta = raw & mask;
          current = BigInt.asIntN(bitWidthLimit, current + minDelta + delta);
          values[outIdx++] = current;
          bitPos += bw;
        }
      }
      pos += miniBlockBytes;
    }
  }

  return { values, end: pos };
}

/**
 * Decodes DELTA_LENGTH_BYTE_ARRAY values: a DELTA_BINARY_PACKED length stream followed by concatenated bytes.
 */
export function decodeDeltaLengthByteArray(
  page: Buffer,
  start: number,
  count: number,
  column: string,
  maxBytes: number
): { slices: Buffer[]; end: number; totalBytes: number } {
  if (count === 0 && start === page.length) {
    return { slices: [], end: start, totalBytes: 0 };
  }
  const lengths = decodeDeltaBinaryPacked(page, start, count, 32, column);
  let pos = lengths.end;
  const slices = new Array<Buffer>(count);
  let totalBytes = 0;
  for (let i = 0; i < count; i++) {
    const len = Number(lengths.values[i]);
    if (len < 0 || pos + len > page.length) {
      throw new ParquetFormatError(
        `Corrupted Parquet file: invalid delta byte array length ${len} in column '${column}'`
      );
    }
    totalBytes += len;
    if (totalBytes > maxBytes) {
      throw new ParquetFormatError(
        `Corrupted Parquet file: decoded values exceed the limit of ${PARQUET_MAX_DECODED_VALUE_BYTES} bytes`
      );
    }
    slices[i] = page.subarray(pos, pos + len);
    pos += len;
  }
  return { slices, end: pos, totalBytes };
}

/**
 * Decodes DELTA_BYTE_ARRAY (incremental / prefix-compressed strings or fixed-length byte arrays):
 * a DELTA_BINARY_PACKED stream of prefix lengths followed by a DELTA_LENGTH_BYTE_ARRAY stream of suffixes.
 */
export function decodeDeltaByteArray(
  page: Buffer,
  start: number,
  count: number,
  column: string,
  maxBytes: number,
  expectedFixedWidth: number
): { slices: Buffer[]; end: number; totalBytes: number } {
  if (count === 0 && start === page.length) {
    return { slices: [], end: start, totalBytes: 0 };
  }
  const prefixes = decodeDeltaBinaryPacked(page, start, count, 32, column);
  const suffixes = decodeDeltaLengthByteArray(page, prefixes.end, count, column, maxBytes);
  const slices = new Array<Buffer>(count);
  let prev: Buffer = Buffer.alloc(0);
  let totalBytes = 0;
  for (let i = 0; i < count; i++) {
    const prefixLen = Number(prefixes.values[i]);
    const suffix = suffixes.slices[i];
    const suffixLen = suffix.length;
    if (prefixLen < 0 || prefixLen > prev.length) {
      throw new ParquetFormatError(
        `Corrupted Parquet file: delta byte array prefix length ${prefixLen} exceeds previous length ${prev.length} in column '${column}'`
      );
    }
    const len = prefixLen + suffixLen;
    if (expectedFixedWidth > 0 && len !== expectedFixedWidth) {
      throw new ParquetFormatError(
        `Corrupted Parquet file: delta byte array length ${len} does not match fixed width ${expectedFixedWidth} in column '${column}'`
      );
    }
    totalBytes += len;
    if (totalBytes > maxBytes) {
      throw new ParquetFormatError(
        `Corrupted Parquet file: decoded values exceed the limit of ${PARQUET_MAX_DECODED_VALUE_BYTES} bytes`
      );
    }
    let current: Buffer;
    if (prefixLen === 0) {
      current = suffix;
    } else if (suffixLen === 0) {
      current = prev.subarray(0, prefixLen);
    } else {
      current = Buffer.allocUnsafe(len);
      prev.copy(current, 0, 0, prefixLen);
      suffix.copy(current, prefixLen, 0, suffixLen);
    }
    slices[i] = current;
    prev = current;
  }
  return { slices, end: suffixes.end, totalBytes };
}

/**
 * Reassembles `count` fixed-width values of `width` bytes from BYTE_STREAM_SPLIT into PLAIN byte order.
 */
export function decodeByteStreamSplit(
  page: Buffer,
  start: number,
  count: number,
  width: number,
  column: string
): { buffer: Buffer; end: number } {
  if (width <= 0) {
    throw new ParquetFormatError(`Corrupted Parquet file: BYTE_STREAM_SPLIT requires a fixed-width type in column '${column}'`);
  }
  const total = count * width;
  if (start + total > page.length) {
    throw new ParquetFormatError(`Corrupted Parquet file: truncated BYTE_STREAM_SPLIT data in column '${column}'`);
  }
  const out = Buffer.allocUnsafe(total);
  for (let b = 0; b < width; b++) {
    const streamOffset = start + b * count;
    for (let i = 0; i < count; i++) {
      out[i * width + b] = page[streamOffset + i];
    }
  }
  return { buffer: out, end: start + total };
}

/**
 * Decodes BOOLEAN values encoded with RLE/bit-packing hybrid (`<4-byte length><rle-stream>`).
 */
export function decodeBooleanRle(
  page: Buffer,
  start: number,
  count: number,
  column: string
): { values: ColumnValue[]; end: number } {
  if (count === 0) return { values: [], end: start };
  if (start + BYTE_ARRAY_LENGTH_PREFIX_BYTES > page.length) {
    throw new ParquetFormatError(`Corrupted Parquet file: truncated RLE boolean length in column '${column}'`);
  }
  const byteLength = page.readUInt32LE(start);
  const streamStart = start + BYTE_ARRAY_LENGTH_PREFIX_BYTES;
  const streamEnd = streamStart + byteLength;
  if (streamEnd > page.length) {
    throw new ParquetFormatError(`Corrupted Parquet file: RLE boolean stream exceeds page bounds in column '${column}'`);
  }
  const raw = new Uint8Array(count);
  decodeRleHybrid(page, streamStart, streamEnd, 1, count, raw);
  const values = new Array<ColumnValue>(count);
  for (let i = 0; i < count; i++) values[i] = raw[i] === 1;
  return { values, end: streamEnd };
}

/**
 * Decodes deprecated BIT_PACKED levels (MSB-first within each byte, no length prefix).
 */
export function decodeBitPackedLevels(
  page: Buffer,
  start: number,
  bitWidth: number,
  count: number,
  out: Uint8Array,
  column: string
): number {
  const byteLength = Math.ceil((count * bitWidth) / BITS_PER_BYTE);
  if (start + byteLength > page.length) {
    throw new ParquetFormatError(`Corrupted Parquet file: truncated BIT_PACKED levels in column '${column}'`);
  }
  if (bitWidth === 0) {
    out.fill(0, 0, count);
    return start;
  }
  let bitPos = 0;
  for (let i = 0; i < count; i++) {
    let value = 0;
    for (let b = 0; b < bitWidth; b++) {
      const byteIdx = start + (bitPos >>> 3);
      const bitInByte = BITS_PER_BYTE - 1 - (bitPos & 7);
      value = (value << 1) | ((page[byteIdx] >>> bitInByte) & 1);
      bitPos++;
    }
    out[i] = value;
  }
  return start + byteLength;
}
