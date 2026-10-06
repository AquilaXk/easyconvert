import { ParquetFormatError } from './parquet-format';

/**
 * Snappy raw-block compressor and decompressor (plus the framing format, read-only).
 * Governing spec: Snappy format description (format_description.txt) and framing_format.txt.
 *
 * The compressor is the standard greedy matcher: a 4-byte hash table per 64 KiB fragment, a
 * skip heuristic over incompressible stretches, literals, and 1- and 2-byte-offset copies.
 */

/** The format compresses independent 64 KiB fragments, so offsets always fit in 16 bits. */
const SNAPPY_FRAGMENT_BYTES = 65_536;
const SNAPPY_MAX_HASH_TABLE_BITS = 14;
const SNAPPY_MIN_HASH_TABLE_BITS = 8;
/** Fragments shorter than this are emitted as one literal (the matcher reads 4 bytes ahead). */
const SNAPPY_INPUT_MARGIN_BYTES = 15;
const SNAPPY_HASH_MULTIPLIER = 0x1e35a7bd;
const SNAPPY_SKIP_SHIFT = 5;
const SNAPPY_INITIAL_SKIP = 32;
const SNAPPY_MIN_MATCH_BYTES = 4;
const SNAPPY_MAX_COPY_BYTES = 64;
/** Length of the first copy when a 65..67 byte match is split, leaving a tail of at least 5 bytes. */
const SNAPPY_SPLIT_COPY_BYTES = 60;
const SNAPPY_SHORT_LITERAL_BYTES = 16;
const SNAPPY_COPY1_MAX_LEN = 11;
const SNAPPY_COPY1_MAX_OFFSET = 2048;
const SNAPPY_MAX_VARINT_SHIFT = 35;
const BYTE_BITS = 8;
const BYTE_MASK = 0xff;
const VARINT_PAYLOAD_MASK = 0x7f;
const VARINT_CONTINUATION = 0x80;
const VARINT_PAYLOAD_BITS = 7;
/** Element tag layout: low two bits select literal or copy form, the rest carries a length. */
const TAG_TYPE_MASK = 0x03;
const TAG_LENGTH_SHIFT = 2;
const COPY1_LENGTH_MASK = 0x07;
const COPY1_OFFSET_HIGH_MASK = 0xe0;
const COPY1_OFFSET_DECODE_SHIFT = 3;
const COPY1_OFFSET_ENCODE_SHIFT = 5;
const COPY1_OFFSET_BYTES = 1;
const COPY2_OFFSET_BYTES = 2;
const COPY4_OFFSET_BYTES = 4;
const LITERAL_LENGTH_PREFIX_BASE = 59;
/** Worst-case output is 32 bytes plus the input plus one sixth of it. */
const WORST_CASE_SLACK_BYTES = 32;
const WORST_CASE_DIVISOR = 6;
const VARINT_RESERVE_BYTES = 5;
/** Framing format: a stream identifier chunk (type 0xff, 6 payload bytes "sNaPpY"), then chunks. */
const FRAME_IDENTIFIER_TYPE = 0xff;
const FRAME_IDENTIFIER_LENGTH = 6;
const FRAME_CHUNK_HEADER_BYTES = 4;
const FRAME_CHUNK_LENGTH_BYTES = 3;
const FRAME_IDENTIFIER_NAME = 'sNaPpY';
const SNAPPY_LITERAL_INLINE_MAX = 60;
const SNAPPY_TAG_LITERAL = 0;
const SNAPPY_TAG_COPY1 = 1;
const SNAPPY_TAG_COPY2 = 2;
const SNAPPY_TAG_COPY4 = 3;
const SNAPPY_FRAME_CHUNK_COMPRESSED = 0x00;
const SNAPPY_FRAME_CHUNK_UNCOMPRESSED = 0x01;
const SNAPPY_FRAME_CRC_BYTES = 4;
const SNAPPY_FRAME_HEADER_BYTES = 10;
/** Raw Snappy blocks declare a 32-bit length; anything larger is not a Snappy block. */
const SNAPPY_MAX_DECLARED_BYTES = 0xffff_ffff;

/** Worst-case compressed size of `n` input bytes (matches the reference bound). */
export function maxCompressedSnappyLength(n: number): number {
  return WORST_CASE_SLACK_BYTES + n + Math.floor(n / WORST_CASE_DIVISOR);
}

function writeVarint32(out: Uint8Array, pos: number, value: number): number {
  let v = value;
  while (v >= VARINT_CONTINUATION) {
    out[pos++] = (v & VARINT_PAYLOAD_MASK) | VARINT_CONTINUATION;
    v >>>= VARINT_PAYLOAD_BITS;
  }
  out[pos++] = v;
  return pos;
}

function emitLiteral(out: Uint8Array, opStart: number, src: Uint8Array, start: number, len: number): number {
  let op = opStart;
  const n = len - 1;
  if (n < SNAPPY_LITERAL_INLINE_MAX) {
    out[op++] = n << TAG_LENGTH_SHIFT;
  } else {
    let extraBytes = 1;
    let rest = n >>> BYTE_BITS;
    while (rest > 0) {
      extraBytes++;
      rest >>>= BYTE_BITS;
    }
    out[op++] = (LITERAL_LENGTH_PREFIX_BASE + extraBytes) << TAG_LENGTH_SHIFT;
    for (let i = 0; i < extraBytes; i++) {
      out[op++] = (n >>> (BYTE_BITS * i)) & BYTE_MASK;
    }
  }
  if (len <= SNAPPY_SHORT_LITERAL_BYTES) {
    for (let i = 0; i < len; i++) out[op + i] = src[start + i];
  } else {
    out.set(src.subarray(start, start + len), op);
  }
  return op + len;
}

function emitCopyAtMost64(out: Uint8Array, opStart: number, offset: number, len: number): number {
  let op = opStart;
  if (len <= SNAPPY_COPY1_MAX_LEN && offset < SNAPPY_COPY1_MAX_OFFSET) {
    out[op++] =
      SNAPPY_TAG_COPY1 |
      ((len - SNAPPY_MIN_MATCH_BYTES) << TAG_LENGTH_SHIFT) |
      ((offset >>> BYTE_BITS) << COPY1_OFFSET_ENCODE_SHIFT);
    out[op++] = offset & BYTE_MASK;
  } else {
    out[op++] = SNAPPY_TAG_COPY2 | ((len - 1) << TAG_LENGTH_SHIFT);
    out[op++] = offset & BYTE_MASK;
    out[op++] = (offset >>> BYTE_BITS) & BYTE_MASK;
  }
  return op;
}

function emitCopy(out: Uint8Array, opStart: number, offset: number, lenStart: number): number {
  let op = opStart;
  let len = lenStart;
  // Keep the tail at least 4 bytes (minimum copy length) by splitting long copies as 64 + rest.
  while (len >= SNAPPY_MAX_COPY_BYTES + SNAPPY_MIN_MATCH_BYTES) {
    op = emitCopyAtMost64(out, op, offset, SNAPPY_MAX_COPY_BYTES);
    len -= SNAPPY_MAX_COPY_BYTES;
  }
  if (len > SNAPPY_MAX_COPY_BYTES) {
    op = emitCopyAtMost64(out, op, offset, SNAPPY_SPLIT_COPY_BYTES);
    len -= SNAPPY_SPLIT_COPY_BYTES;
  }
  return emitCopyAtMost64(out, op, offset, len);
}

function load32(a: Uint8Array, i: number): number {
  return (a[i] | (a[i + 1] << BYTE_BITS) | (a[i + 2] << (2 * BYTE_BITS)) | (a[i + 3] << (3 * BYTE_BITS))) >>> 0;
}

function matchLength(a: Uint8Array, s1: number, s2: number, limit: number): number {
  let n = 0;
  while (s2 + n < limit && a[s1 + n] === a[s2 + n]) n++;
  return n;
}

function compressFragment(
  src: Uint8Array,
  fragStart: number,
  fragLen: number,
  out: Uint8Array,
  opStart: number,
  table: Int32Array
): number {
  let op = opStart;
  const fragEnd = fragStart + fragLen;
  if (fragLen < SNAPPY_INPUT_MARGIN_BYTES) {
    return fragLen === 0 ? op : emitLiteral(out, op, src, fragStart, fragLen);
  }

  let tableBits = SNAPPY_MIN_HASH_TABLE_BITS;
  while (tableBits < SNAPPY_MAX_HASH_TABLE_BITS && 1 << tableBits < fragLen) tableBits++;
  const shift = 32 - tableBits;
  table.fill(0, 0, 1 << tableBits);

  const ipLimit = fragEnd - SNAPPY_INPUT_MARGIN_BYTES;
  let nextEmit = fragStart;
  let ip = fragStart + 1;
  let nextHash = Math.imul(load32(src, ip), SNAPPY_HASH_MULTIPLIER) >>> shift;

  for (;;) {
    // Skip ahead faster over data that does not match.
    let skip = SNAPPY_INITIAL_SKIP;
    let nextIp = ip;
    let candidate = 0;
    let found = false;
    while (!found) {
      ip = nextIp;
      const hash = nextHash;
      const bytesBetweenLookups = skip++ >>> SNAPPY_SKIP_SHIFT;
      nextIp = ip + bytesBetweenLookups;
      if (nextIp > ipLimit) {
        return nextEmit < fragEnd ? emitLiteral(out, op, src, nextEmit, fragEnd - nextEmit) : op;
      }
      nextHash = Math.imul(load32(src, nextIp), SNAPPY_HASH_MULTIPLIER) >>> shift;
      candidate = fragStart + table[hash];
      table[hash] = ip - fragStart;
      found = load32(src, ip) === load32(src, candidate);
    }

    op = emitLiteral(out, op, src, nextEmit, ip - nextEmit);

    // Emit copies while the next position keeps matching.
    let matching = true;
    while (matching) {
      const base = ip;
      const matched = SNAPPY_MIN_MATCH_BYTES + matchLength(src, candidate + SNAPPY_MIN_MATCH_BYTES, ip + SNAPPY_MIN_MATCH_BYTES, fragEnd);
      ip += matched;
      op = emitCopy(out, op, base - candidate, matched);
      nextEmit = ip;
      if (ip >= ipLimit) {
        return nextEmit < fragEnd ? emitLiteral(out, op, src, nextEmit, fragEnd - nextEmit) : op;
      }
      const prevHash = Math.imul(load32(src, ip - 1), SNAPPY_HASH_MULTIPLIER) >>> shift;
      table[prevHash] = ip - 1 - fragStart;
      const curHash = Math.imul(load32(src, ip), SNAPPY_HASH_MULTIPLIER) >>> shift;
      candidate = fragStart + table[curHash];
      table[curHash] = ip - fragStart;
      matching = load32(src, ip) === load32(src, candidate);
    }
    ip++;
    nextHash = Math.imul(load32(src, ip), SNAPPY_HASH_MULTIPLIER) >>> shift;
  }
}

/**
 * Encodes a buffer into a raw Snappy block (varint length, then literal and copy elements).
 */
export function compressSnappy(input: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(maxCompressedSnappyLength(input.length) + VARINT_RESERVE_BYTES);
  let op = writeVarint32(out, 0, input.length);
  const table = new Int32Array(1 << SNAPPY_MAX_HASH_TABLE_BITS);
  for (let offset = 0; offset < input.length; offset += SNAPPY_FRAGMENT_BYTES) {
    const fragLen = Math.min(SNAPPY_FRAGMENT_BYTES, input.length - offset);
    op = compressFragment(input, offset, fragLen, out, op, table);
  }
  return Buffer.from(out.subarray(0, op));
}

/**
 * Decompresses a raw Snappy block with varint length prefix and element tags.
 * `maxOutputBytes` rejects a block whose declared size exceeds the caller's bound before allocating.
 */
export function decompressRawSnappyBlock(buf: Uint8Array, maxOutputBytes = SNAPPY_MAX_DECLARED_BYTES): Buffer {
  let offset = 0;
  let uncompressedLen = 0;
  let shift = 0;

  for (;;) {
    if (offset >= buf.length) throw new ParquetFormatError('Corrupted Snappy block: truncated length prefix');
    const b = buf[offset++];
    uncompressedLen += (b & VARINT_PAYLOAD_MASK) * 2 ** shift;
    if ((b & VARINT_CONTINUATION) === 0) break;
    shift += VARINT_PAYLOAD_BITS;
    if (shift > SNAPPY_MAX_VARINT_SHIFT) throw new ParquetFormatError('Corrupted Snappy varint uncompressed length');
  }
  if (uncompressedLen > SNAPPY_MAX_DECLARED_BYTES || uncompressedLen > maxOutputBytes) {
    throw new ParquetFormatError(
      `Snappy decompression error: declared size ${uncompressedLen} exceeds the ${maxOutputBytes} byte limit`
    );
  }

  const out = Buffer.alloc(uncompressedLen);
  let outPos = 0;

  while (offset < buf.length && outPos < uncompressedLen) {
    const tag = buf[offset++];
    const elemType = tag & TAG_TYPE_MASK;

    if (elemType === SNAPPY_TAG_LITERAL) {
      let len = tag >> TAG_LENGTH_SHIFT;
      if (len >= SNAPPY_LITERAL_INLINE_MAX) {
        const extraBytes = len - SNAPPY_LITERAL_INLINE_MAX + 1;
        if (offset + extraBytes > buf.length) throw new ParquetFormatError('Snappy decompression error: truncated literal length');
        len = 0;
        for (let i = 0; i < extraBytes; i++) len += buf[offset + i] * 2 ** (BYTE_BITS * i);
        offset += extraBytes;
      }
      len += 1;
      if (offset + len > buf.length || outPos + len > uncompressedLen) {
        throw new ParquetFormatError('Snappy decompression error: literal bounds exceeded');
      }
      out.set(buf.subarray(offset, offset + len), outPos);
      offset += len;
      outPos += len;
    } else {
      let copyLen = 0;
      let copyOffset = 0;
      if (elemType === SNAPPY_TAG_COPY1) {
        if (offset + COPY1_OFFSET_BYTES > buf.length) throw new ParquetFormatError('Snappy decompression error: truncated copy');
        copyLen = ((tag >> TAG_LENGTH_SHIFT) & COPY1_LENGTH_MASK) + SNAPPY_MIN_MATCH_BYTES;
        copyOffset = ((tag & COPY1_OFFSET_HIGH_MASK) << COPY1_OFFSET_DECODE_SHIFT) | buf[offset++];
      } else if (elemType === SNAPPY_TAG_COPY2) {
        if (offset + COPY2_OFFSET_BYTES > buf.length) throw new ParquetFormatError('Snappy decompression error: truncated copy');
        copyLen = (tag >> TAG_LENGTH_SHIFT) + 1;
        copyOffset = buf[offset] | (buf[offset + 1] << BYTE_BITS);
        offset += COPY2_OFFSET_BYTES;
      } else if (elemType === SNAPPY_TAG_COPY4) {
        if (offset + COPY4_OFFSET_BYTES > buf.length) throw new ParquetFormatError('Snappy decompression error: truncated copy');
        copyLen = (tag >> TAG_LENGTH_SHIFT) + 1;
        copyOffset = load32(buf, offset);
        offset += COPY4_OFFSET_BYTES;
      }

      if (copyOffset <= 0 || copyOffset > outPos) {
        throw new ParquetFormatError(`Snappy decompression error: invalid copy offset ${copyOffset} (outPos=${outPos})`);
      }
      if (outPos + copyLen > uncompressedLen) {
        throw new ParquetFormatError('Snappy decompression error: copy length exceeds uncompressed size');
      }
      // Byte-wise on purpose: overlapping copies (offset < length) replicate a pattern.
      for (let i = 0; i < copyLen; i++) {
        out[outPos] = out[outPos - copyOffset];
        outPos++;
      }
    }
  }

  if (outPos !== uncompressedLen) {
    throw new ParquetFormatError(`Snappy decompression error: produced ${outPos} of ${uncompressedLen} declared bytes`);
  }
  return out;
}

/**
 * Decompresses a Snappy raw block or framed stream (stream identifier chunk 0xff 0x06 0x00 0x00 "sNaPpY").
 */
export function decompressSnappy(buf: Buffer, maxOutputBytes = SNAPPY_MAX_DECLARED_BYTES): Buffer {
  const isFramed =
    buf.length >= SNAPPY_FRAME_HEADER_BYTES &&
    buf[0] === FRAME_IDENTIFIER_TYPE &&
    buf.readUIntLE(1, FRAME_CHUNK_LENGTH_BYTES) === FRAME_IDENTIFIER_LENGTH &&
    buf.subarray(FRAME_CHUNK_HEADER_BYTES, SNAPPY_FRAME_HEADER_BYTES).toString('ascii') === FRAME_IDENTIFIER_NAME;
  if (!isFramed) return decompressRawSnappyBlock(buf, maxOutputBytes);

  let offset = SNAPPY_FRAME_HEADER_BYTES;
  let total = 0;
  const chunks: Buffer[] = [];
  while (offset + FRAME_CHUNK_HEADER_BYTES <= buf.length) {
    const chunkType = buf[offset++];
    const chunkLen = buf.readUIntLE(offset, FRAME_CHUNK_LENGTH_BYTES);
    offset += FRAME_CHUNK_LENGTH_BYTES;
    if (offset + chunkLen > buf.length) break;
    if (chunkType === SNAPPY_FRAME_CHUNK_COMPRESSED || chunkType === SNAPPY_FRAME_CHUNK_UNCOMPRESSED) {
      const body = buf.subarray(offset + SNAPPY_FRAME_CRC_BYTES, offset + chunkLen);
      const chunk =
        chunkType === SNAPPY_FRAME_CHUNK_COMPRESSED ? decompressRawSnappyBlock(body, maxOutputBytes - total) : body;
      total += chunk.length;
      if (total > maxOutputBytes) {
        throw new ParquetFormatError(`Snappy decompression error: output exceeds the ${maxOutputBytes} byte limit`);
      }
      chunks.push(chunk);
    }
    offset += chunkLen;
  }
  return Buffer.concat(chunks);
}
