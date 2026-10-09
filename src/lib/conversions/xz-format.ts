import { createHash } from 'node:crypto';
import { CorruptStreamError, DecompressionLimitError, UnsupportedOptionError } from '../types';
import { crc32 } from './crc32';
import { decodeLzma2At } from './lzma-decoder';

/**
 * The .xz file format, version 1.1.0 (Lasse Collin's specification): stream header, blocks with a header listing the
 * filter chain, the LZMA2 payload and a check, an index, and a stream footer. Writing produces one stream with one
 * block and a CRC-32 check. Reading accepts what real encoders write: any number of blocks and concatenated streams
 * (with the zero padding between them), CRC-32, CRC-64, SHA-256 or no check, and LZMA2 as the only filter.
 */

const HEADER_MAGIC = Uint8Array.of(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00);
const FOOTER_MAGIC = Uint8Array.of(0x59, 0x5a);
const STREAM_HEADER_BYTES = 12;
const STREAM_FOOTER_BYTES = 12;
const STREAM_FLAGS_BYTES = 2;
const CHECK_NONE = 0x00;
const CHECK_CRC32 = 0x01;
const CHECK_CRC64 = 0x04;
const CHECK_SHA256 = 0x0a;
const FILTER_LZMA2 = 0x21;
const BLOCK_HEADER_MIN_BYTES = 8;
const INDEX_INDICATOR = 0x00;
const VARINT_MAX_BYTES = 9;
const VARINT_PAYLOAD_BITS = 7;
const VARINT_CONTINUE = 0x80;
const BLOCK_FLAG_COMPRESSED_SIZE = 0x40;
const BLOCK_FLAG_UNCOMPRESSED_SIZE = 0x80;
const BLOCK_FLAG_FILTER_COUNT_MASK = 0x03;
const BLOCK_FLAGS_RESERVED_MASK = 0x3c;
const CRC_BYTES = 4;
const PADDING_UNIT = 4;
const LZMA2_PROPS_BYTES = 1;
const INDEX_RECORDS_MAX = 1 << 20;

function xzError(detail: string): CorruptStreamError {
  return new CorruptStreamError(`Invalid XZ archive: ${detail}`);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function pad4(length: number): number {
  return (PADDING_UNIT - (length % PADDING_UNIT)) % PADDING_UNIT;
}

function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  let v = value;
  while (v >= VARINT_CONTINUE) {
    bytes.push((v % VARINT_CONTINUE) | VARINT_CONTINUE);
    v = Math.floor(v / VARINT_CONTINUE);
  }
  bytes.push(v);
  return bytes;
}

// ---------------------------------------------------------------------------
// CRC-64 (ECMA-182, reflected) for the check type xz writes by default
// ---------------------------------------------------------------------------

const CRC64_POLY_LOW = 0xd7870f42;
const CRC64_POLY_HIGH = 0xc96c5795;
/** Bytes a slicing step consumes: one table per byte of the 64-bit word. */
const CRC64_SLICES = 8;
const CRC64_TABLE_SIZE = 256;
// Table k holds the CRC-64 of a byte followed by k zero bytes; table 0 is the plain byte-at-a-time table. Halves are kept
// apart so the arithmetic stays in 32-bit integers.
const crc64Low = new Uint32Array(CRC64_SLICES * CRC64_TABLE_SIZE);
const crc64High = new Uint32Array(CRC64_SLICES * CRC64_TABLE_SIZE);
for (let n = 0; n < CRC64_TABLE_SIZE; n++) {
  let low = n;
  let high = 0;
  for (let k = 0; k < 8; k++) {
    const carry = low & 1;
    low = ((low >>> 1) | ((high & 1) << 31)) >>> 0;
    high >>>= 1;
    if (carry) {
      low = (low ^ CRC64_POLY_LOW) >>> 0;
      high = (high ^ CRC64_POLY_HIGH) >>> 0;
    }
  }
  crc64Low[n] = low;
  crc64High[n] = high;
}
for (let slice = 1; slice < CRC64_SLICES; slice++) {
  for (let n = 0; n < CRC64_TABLE_SIZE; n++) {
    const previousLow = crc64Low[(slice - 1) * CRC64_TABLE_SIZE + n];
    const previousHigh = crc64High[(slice - 1) * CRC64_TABLE_SIZE + n];
    const index = previousLow & 0xff;
    crc64Low[slice * CRC64_TABLE_SIZE + n] = (((previousLow >>> 8) | (previousHigh << 24)) ^ crc64Low[index]) >>> 0;
    crc64High[slice * CRC64_TABLE_SIZE + n] = ((previousHigh >>> 8) ^ crc64High[index]) >>> 0;
  }
}

/** CRC-64 of `data` as [low, high] 32-bit halves, eight bytes per step. */
function crc64(data: Uint8Array): [number, number] {
  let low = 0xffffffff;
  let high = 0xffffffff;
  let i = 0;
  const wordEnd = data.length - (CRC64_SLICES - 1);
  for (; i < wordEnd; i += CRC64_SLICES) {
    const a = low ^ (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24));
    const b = high ^ (data[i + 4] | (data[i + 5] << 8) | (data[i + 6] << 16) | (data[i + 7] << 24));
    low =
      crc64Low[7 * CRC64_TABLE_SIZE + (a & 0xff)] ^
      crc64Low[6 * CRC64_TABLE_SIZE + ((a >>> 8) & 0xff)] ^
      crc64Low[5 * CRC64_TABLE_SIZE + ((a >>> 16) & 0xff)] ^
      crc64Low[4 * CRC64_TABLE_SIZE + (a >>> 24)] ^
      crc64Low[3 * CRC64_TABLE_SIZE + (b & 0xff)] ^
      crc64Low[2 * CRC64_TABLE_SIZE + ((b >>> 8) & 0xff)] ^
      crc64Low[CRC64_TABLE_SIZE + ((b >>> 16) & 0xff)] ^
      crc64Low[b >>> 24];
    high =
      crc64High[7 * CRC64_TABLE_SIZE + (a & 0xff)] ^
      crc64High[6 * CRC64_TABLE_SIZE + ((a >>> 8) & 0xff)] ^
      crc64High[5 * CRC64_TABLE_SIZE + ((a >>> 16) & 0xff)] ^
      crc64High[4 * CRC64_TABLE_SIZE + (a >>> 24)] ^
      crc64High[3 * CRC64_TABLE_SIZE + (b & 0xff)] ^
      crc64High[2 * CRC64_TABLE_SIZE + ((b >>> 8) & 0xff)] ^
      crc64High[CRC64_TABLE_SIZE + ((b >>> 16) & 0xff)] ^
      crc64High[b >>> 24];
  }
  for (; i < data.length; i++) {
    const index = (low ^ data[i]) & 0xff;
    const nextLow = ((low >>> 8) | (high << 24)) ^ crc64Low[index];
    high = (high >>> 8) ^ crc64High[index];
    low = nextLow;
  }
  return [(low ^ 0xffffffff) >>> 0, (high ^ 0xffffffff) >>> 0];
}

function checkSize(type: number): number {
  if (type === CHECK_NONE) return 0;
  if (type === CHECK_CRC32) return 4;
  if (type === CHECK_CRC64) return 8;
  if (type === CHECK_SHA256) return 32;
  throw new UnsupportedOptionError(`XZ check type ${type} is not supported`);
}

function verifyCheck(type: number, data: Uint8Array, stored: Uint8Array): void {
  if (type === CHECK_CRC32) {
    const expected = stored[0] | (stored[1] << 8) | (stored[2] << 16) | (stored[3] << 24);
    if (crc32(data) !== expected >>> 0) throw xzError('payload CRC32 mismatch');
  } else if (type === CHECK_CRC64) {
    const [low, high] = crc64(data);
    const storedLow = (stored[0] | (stored[1] << 8) | (stored[2] << 16) | (stored[3] << 24)) >>> 0;
    const storedHigh = (stored[4] | (stored[5] << 8) | (stored[6] << 16) | (stored[7] << 24)) >>> 0;
    if (low !== storedLow || high !== storedHigh) throw xzError('payload CRC64 mismatch');
  } else if (type === CHECK_SHA256) {
    if (!sameBytes(createHash('sha256').update(data).digest(), stored)) throw xzError('payload SHA-256 mismatch');
  }
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/** One stream, one block, CRC-32 check; `lzma2.props` is the LZMA2 dictionary-size byte the encoder used. */
export function packXzStream(uncompressed: Uint8Array, lzma2: { buffer: Uint8Array; props: Uint8Array }): Buffer {
  const streamFlags = Uint8Array.of(0x00, CHECK_CRC32);
  const flagsCrc = Buffer.alloc(CRC_BYTES);
  flagsCrc.writeUInt32LE(crc32(streamFlags), 0);
  const header = Buffer.concat([HEADER_MAGIC, streamFlags, flagsCrc]);

  // Block header: size byte, flags (one filter, no sizes), LZMA2 filter id, one property byte, padding, CRC-32.
  const filterAndProps = [FILTER_LZMA2, LZMA2_PROPS_BYTES, lzma2.props[0]];
  const headerBodyBytes = 2 + filterAndProps.length;
  const paddedBody = headerBodyBytes + pad4(headerBodyBytes + CRC_BYTES);
  const blockHeaderNoCrc = Buffer.alloc(paddedBody);
  blockHeaderNoCrc[0] = (paddedBody + CRC_BYTES) / PADDING_UNIT - 1;
  blockHeaderNoCrc[1] = 0x00;
  Buffer.from(filterAndProps).copy(blockHeaderNoCrc, 2);
  const blockHeaderCrc = Buffer.alloc(CRC_BYTES);
  blockHeaderCrc.writeUInt32LE(crc32(blockHeaderNoCrc), 0);
  const blockHeader = Buffer.concat([blockHeaderNoCrc, blockHeaderCrc]);

  const padding = Buffer.alloc(pad4(lzma2.buffer.length));
  const check = Buffer.alloc(CRC_BYTES);
  check.writeUInt32LE(crc32(uncompressed), 0);

  const unpaddedSize = blockHeader.length + lzma2.buffer.length + CRC_BYTES;
  const indexBody = Buffer.from([INDEX_INDICATOR, ...encodeVarint(1), ...encodeVarint(unpaddedSize), ...encodeVarint(uncompressed.length)]);
  const indexNoCrc = Buffer.concat([indexBody, Buffer.alloc(pad4(indexBody.length))]);
  const indexCrc = Buffer.alloc(CRC_BYTES);
  indexCrc.writeUInt32LE(crc32(indexNoCrc), 0);
  const index = Buffer.concat([indexNoCrc, indexCrc]);

  const footerBody = Buffer.alloc(6);
  footerBody.writeUInt32LE(index.length / PADDING_UNIT - 1, 0);
  footerBody.set(streamFlags, 4);
  const footerCrc = Buffer.alloc(CRC_BYTES);
  footerCrc.writeUInt32LE(crc32(footerBody), 0);

  return Buffer.concat([header, blockHeader, lzma2.buffer, padding, check, index, footerCrc, footerBody, FOOTER_MAGIC]);
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

interface VarintRead {
  value: number;
  next: number;
}

function readVarint(buf: Uint8Array, pos: number, limit: number): VarintRead {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < VARINT_MAX_BYTES; i++) {
    if (pos + i >= limit) throw xzError('truncated variable-length integer');
    const byte = buf[pos + i];
    value += (byte & (VARINT_CONTINUE - 1)) * scale;
    if ((byte & VARINT_CONTINUE) === 0) {
      if (byte === 0 && i > 0) throw xzError('variable-length integer is not minimal');
      if (value > Number.MAX_SAFE_INTEGER) throw xzError('variable-length integer is too large');
      return { value, next: pos + i + 1 };
    }
    scale *= 2 ** VARINT_PAYLOAD_BITS;
  }
  throw xzError('variable-length integer is too long');
}

interface BlockHeader {
  size: number;
  compressedSize?: number;
  uncompressedSize?: number;
  dictionaryByte: number;
}

function parseBlockHeader(buf: Uint8Array, offset: number): BlockHeader {
  const size = (buf[offset] + 1) * PADDING_UNIT;
  if (size < BLOCK_HEADER_MIN_BYTES || offset + size > buf.length) throw xzError('truncated block header');
  const stored = (buf[offset + size - 4] | (buf[offset + size - 3] << 8) | (buf[offset + size - 2] << 16) | (buf[offset + size - 1] << 24)) >>> 0;
  if (crc32(buf.subarray(offset, offset + size - CRC_BYTES)) !== stored) throw xzError('block header CRC mismatch');
  const flags = buf[offset + 1];
  if ((flags & BLOCK_FLAGS_RESERVED_MASK) !== 0) throw xzError('reserved block header flags are set');
  const end = offset + size - CRC_BYTES;
  let pos = offset + 2;
  let compressedSize: number | undefined;
  let uncompressedSize: number | undefined;
  if (flags & BLOCK_FLAG_COMPRESSED_SIZE) {
    const read = readVarint(buf, pos, end);
    compressedSize = read.value;
    pos = read.next;
  }
  if (flags & BLOCK_FLAG_UNCOMPRESSED_SIZE) {
    const read = readVarint(buf, pos, end);
    uncompressedSize = read.value;
    pos = read.next;
  }
  const filterCount = (flags & BLOCK_FLAG_FILTER_COUNT_MASK) + 1;
  if (filterCount !== 1) throw new UnsupportedOptionError('XZ blocks with a filter chain before LZMA2 are not supported');
  const id = readVarint(buf, pos, end);
  if (id.value !== FILTER_LZMA2) throw new UnsupportedOptionError(`XZ filter 0x${id.value.toString(16)} is not supported`);
  const propsSize = readVarint(buf, id.next, end);
  if (propsSize.value !== LZMA2_PROPS_BYTES || propsSize.next + LZMA2_PROPS_BYTES > end) throw xzError('invalid LZMA2 filter properties');
  const dictionaryByte = buf[propsSize.next];
  for (let i = propsSize.next + LZMA2_PROPS_BYTES; i < end; i++) {
    if (buf[i] !== 0) throw xzError('block header padding is not zero');
  }
  return { size, compressedSize, uncompressedSize, dictionaryByte };
}

interface IndexRecord {
  unpaddedSize: number;
  uncompressedSize: number;
}

function parseIndex(buf: Uint8Array, offset: number, size: number): IndexRecord[] {
  const stored = (buf[offset + size - 4] | (buf[offset + size - 3] << 8) | (buf[offset + size - 2] << 16) | (buf[offset + size - 1] << 24)) >>> 0;
  if (crc32(buf.subarray(offset, offset + size - CRC_BYTES)) !== stored) throw xzError('index CRC mismatch');
  const end = offset + size - CRC_BYTES;
  if (buf[offset] !== INDEX_INDICATOR) throw xzError('index indicator missing');
  const count = readVarint(buf, offset + 1, end);
  if (count.value > INDEX_RECORDS_MAX) throw new DecompressionLimitError(`XZ index lists more than ${INDEX_RECORDS_MAX} blocks`);
  const records: IndexRecord[] = [];
  let pos = count.next;
  for (let i = 0; i < count.value; i++) {
    const unpadded = readVarint(buf, pos, end);
    const uncompressed = readVarint(buf, unpadded.next, end);
    records.push({ unpaddedSize: unpadded.value, uncompressedSize: uncompressed.value });
    pos = uncompressed.next;
  }
  for (let i = pos; i < end; i++) if (buf[i] !== 0) throw xzError('index padding is not zero');
  return records;
}

/**
 * Decodes every stream of an .xz file and returns the concatenated payload. Checks the stream header and footer, every
 * block header, the index against what was decoded, and each block's check. The output never exceeds `maxOutput`.
 */
export function unpackXzStream(buf: Uint8Array, maxOutput: number): Buffer {
  if (buf.length < STREAM_HEADER_BYTES + STREAM_FOOTER_BYTES) throw xzError('buffer too small');
  const outputs: Uint8Array[] = [];
  let total = 0;
  let offset = 0;
  let streamsRead = 0;
  while (offset < buf.length) {
    // Zero padding (a multiple of four bytes) may follow a stream, before the next one or at the end of the file.
    if (buf[offset] === 0 && streamsRead > 0) {
      let zeros = 0;
      while (offset + zeros < buf.length && buf[offset + zeros] === 0) zeros++;
      if (zeros % PADDING_UNIT !== 0) throw xzError('stream padding is not a multiple of four bytes');
      offset += zeros;
      if (offset === buf.length) break;
    }
    if (offset + STREAM_HEADER_BYTES > buf.length) throw xzError('truncated stream header');
    if (!sameBytes(buf.subarray(offset, offset + HEADER_MAGIC.length), HEADER_MAGIC)) throw xzError('magic number mismatch');
    const streamFlags = buf.subarray(offset + 6, offset + 6 + STREAM_FLAGS_BYTES);
    const flagsCrc = (buf[offset + 8] | (buf[offset + 9] << 8) | (buf[offset + 10] << 16) | (buf[offset + 11] << 24)) >>> 0;
    if (crc32(streamFlags) !== flagsCrc) throw xzError('header CRC mismatch');
    if (streamFlags[0] !== 0) throw xzError('reserved stream flags are set');
    const checkType = streamFlags[1];
    const checkBytes = checkSize(checkType);

    let pos = offset + STREAM_HEADER_BYTES;
    const records: IndexRecord[] = [];
    const streamOutputs: Uint8Array[] = [];
    for (;;) {
      if (pos >= buf.length) throw xzError('truncated block header');
      if (buf[pos] === INDEX_INDICATOR) break;
      const block = parseBlockHeader(buf, pos);
      const dataStart = pos + block.size;
      const decoded = decodeLzma2At(buf, dataStart, maxOutput - total, block.uncompressedSize);
      const compressedSize = decoded.end - dataStart;
      if (block.compressedSize !== undefined && block.compressedSize !== compressedSize) throw xzError('block compressed size mismatch');
      const padding = pad4(compressedSize);
      let cursor = decoded.end;
      for (let i = 0; i < padding; i++) if (cursor + i >= buf.length || buf[cursor + i] !== 0) throw xzError('block padding is not zero');
      cursor += padding;
      if (cursor + checkBytes > buf.length) throw xzError('truncated block check');
      verifyCheck(checkType, decoded.output, buf.subarray(cursor, cursor + checkBytes));
      cursor += checkBytes;
      records.push({ unpaddedSize: block.size + compressedSize + checkBytes, uncompressedSize: decoded.output.length });
      streamOutputs.push(decoded.output);
      total += decoded.output.length;
      if (total > maxOutput) throw new DecompressionLimitError(`Archive bomb detected: XZ output exceeds the limit of ${maxOutput} bytes`);
      pos = cursor;
    }

    // Index, then the footer.
    let indexEnd = pos + 1;
    const count = readVarint(buf, indexEnd, buf.length);
    indexEnd = count.next;
    for (let i = 0; i < count.value; i++) {
      const unpadded = readVarint(buf, indexEnd, buf.length);
      indexEnd = readVarint(buf, unpadded.next, buf.length).next;
    }
    const indexSize = indexEnd + pad4(indexEnd - pos) + CRC_BYTES - pos;
    if (pos + indexSize + STREAM_FOOTER_BYTES > buf.length) throw xzError('invalid index size');
    const listed = parseIndex(buf, pos, indexSize);
    if (listed.length !== records.length) throw xzError('index does not match the blocks');
    for (let i = 0; i < listed.length; i++) {
      if (listed[i].unpaddedSize !== records[i].unpaddedSize || listed[i].uncompressedSize !== records[i].uncompressedSize) {
        throw xzError('index does not match the blocks');
      }
    }
    const footer = pos + indexSize;
    if (!sameBytes(buf.subarray(footer + 10, footer + 12), FOOTER_MAGIC)) throw xzError('footer magic mismatch');
    const footerBody = buf.subarray(footer + 4, footer + 10);
    const footerCrc = (buf[footer] | (buf[footer + 1] << 8) | (buf[footer + 2] << 16) | (buf[footer + 3] << 24)) >>> 0;
    if (crc32(footerBody) !== footerCrc) throw xzError('footer CRC mismatch');
    if (footerBody[4] !== streamFlags[0] || footerBody[5] !== streamFlags[1]) throw xzError('stream flags mismatch between header and footer');
    const backwardSize = (footerBody[0] | (footerBody[1] << 8) | (footerBody[2] << 16) | (footerBody[3] << 24)) >>> 0;
    if ((backwardSize + 1) * PADDING_UNIT !== indexSize) throw xzError('backward size does not match the index');
    for (const piece of streamOutputs) outputs.push(piece);
    streamsRead++;
    offset = footer + STREAM_FOOTER_BYTES;
  }
  if (outputs.length === 1) return Buffer.from(outputs[0].buffer, outputs[0].byteOffset, outputs[0].byteLength);
  return Buffer.concat(outputs, total);
}
