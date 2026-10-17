import { CorruptStreamError, DecompressionLimitError } from '../types';
import { crc32 } from './crc32';
import { decompressLzo1xBlock } from './lzo1x';

/**
 * lzop file container (the format `lzop` writes and the `.lzo` and `.tar.lzo` extensions name), read in process.
 *
 * Layout: the 9-byte magic, a header (version, library version, version needed, method, level, flags, optional filter,
 * mode, modification time, file name, a header checksum, optional extra field), then blocks. A block is the
 * uncompressed length, the compressed length, the checksums the flags ask for and the data; a compressed length equal to
 * the uncompressed length means the block is stored. A block length of zero ends the file.
 *
 * Fail closed: the header and block checksums the file declares are verified, a block longer than the format allows or
 * a total over the caller's limit is refused before it is decoded, and trailing data after the end mark is an error.
 * Only the LZO1X methods (1 to 3) exist in files written by any lzop 1.x, so the NRV methods are refused.
 */

const MAGIC = Buffer.from([0x89, 0x4c, 0x5a, 0x4f, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Oldest header layout this reader knows (it has the version-needed, level and high modification time fields). */
const MIN_VERSION = 0x0940;
const METHOD_LZO1X_1 = 1;
const METHOD_LZO1X_1_15 = 2;
const METHOD_LZO1X_999 = 3;
const LZO1X_METHODS = new Set([METHOD_LZO1X_1, METHOD_LZO1X_1_15, METHOD_LZO1X_999]);

const FLAG_ADLER32_DECOMPRESSED = 0x00000001;
const FLAG_ADLER32_COMPRESSED = 0x00000002;
const FLAG_EXTRA_FIELD = 0x00000040;
const FLAG_CRC32_DECOMPRESSED = 0x00000100;
const FLAG_CRC32_COMPRESSED = 0x00000200;
const FLAG_MULTIPART = 0x00000400;
const FLAG_FILTER = 0x00000800;
const FLAG_HEADER_CRC32 = 0x00001000;

/** lzop's own ceiling on the size of one block. */
const MAX_BLOCK_BYTES = 64 * 1024 * 1024;
const ADLER_MODULUS = 65521;
/** The largest run of bytes whose Adler sums cannot overflow 2^32 before the modulo is taken. */
const ADLER_RUN = 5552;
const ADLER_HIGH_SHIFT = 16;
const U32_BYTES = 4;
const U16_BYTES = 2;

function corrupt(detail: string): CorruptStreamError {
  return new CorruptStreamError(`Corrupt lzop data: ${detail}`);
}

function adler32(data: Uint8Array): number {
  let low = 1;
  let high = 0;
  for (let start = 0; start < data.length; start += ADLER_RUN) {
    const end = Math.min(start + ADLER_RUN, data.length);
    for (let i = start; i < end; i++) {
      low += data[i];
      high += low;
    }
    low %= ADLER_MODULUS;
    high %= ADLER_MODULUS;
  }
  return ((high << ADLER_HIGH_SHIFT) | low) >>> 0;
}

/** A cursor over the input whose every read is bounds-checked. */
class Reader {
  pos = 0;
  constructor(private readonly data: Uint8Array) {}

  get remaining(): number {
    return this.data.length - this.pos;
  }

  u8(): number {
    return this.take(1)[0];
  }

  u16(): number {
    const bytes = this.take(U16_BYTES);
    return (bytes[0] << 8) | bytes[1];
  }

  u32(): number {
    const bytes = this.take(U32_BYTES);
    return ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  }

  take(length: number): Uint8Array {
    if (length > this.remaining) throw corrupt('input ends inside the file structure');
    const slice = this.data.subarray(this.pos, this.pos + length);
    this.pos += length;
    return slice;
  }
}

/** Reads and verifies the file header; returns its flags, which say which checksums the blocks carry. */
function readHeader(reader: Reader, input: Uint8Array): number {
  if (!Buffer.from(reader.take(MAGIC.length)).equals(MAGIC)) throw corrupt('the lzop magic is missing');
  const checksumStart = reader.pos;
  const version = reader.u16();
  reader.u16(); // library version
  if (version < MIN_VERSION) throw corrupt(`header version 0x${version.toString(16)} is older than this reader supports`);
  reader.u16(); // version needed to extract
  const method = reader.u8();
  reader.u8(); // compression level
  const flags = reader.u32();
  if (flags & FLAG_MULTIPART) throw corrupt('multi-part files are not supported');
  if (flags & FLAG_FILTER) throw corrupt('files written with a filter are not supported');
  if (!LZO1X_METHODS.has(method)) throw corrupt(`compression method ${method} is not an LZO1X method`);
  reader.u32(); // mode
  reader.u32(); // modification time (low)
  reader.u32(); // modification time (high)
  reader.take(reader.u8()); // original file name
  const headerBytes = input.subarray(checksumStart, reader.pos);
  const declared = reader.u32();
  const actual = flags & FLAG_HEADER_CRC32 ? crc32(headerBytes) : adler32(headerBytes);
  if (actual !== declared) throw corrupt('the header checksum does not match');
  if (flags & FLAG_EXTRA_FIELD) {
    // No lzop release writes one; it is skipped (with its checksum word), not interpreted.
    reader.take(reader.u32());
    reader.u32();
  }
  return flags;
}

/** The checksum of `data` the flags ask for (CRC-32 over Adler-32), or null when the file declares none. */
function declaredChecksum(flags: number, adlerFlag: number, crcFlag: number, reader: Reader): { crc: boolean; value: number } | null {
  if (flags & crcFlag) return { crc: true, value: reader.u32() };
  if (flags & adlerFlag) return { crc: false, value: reader.u32() };
  return null;
}

function verifyChecksum(expected: { crc: boolean; value: number } | null, data: Uint8Array, what: string): void {
  if (expected === null) return;
  const actual = expected.crc ? crc32(data) : adler32(data);
  if (actual !== expected.value) throw corrupt(`the ${what} checksum does not match`);
}

/**
 * Decodes an lzop file. The result never exceeds `maxOutputBytes`; a file that would decode past it is refused with a
 * {@link DecompressionLimitError} before the offending block is decoded.
 */
export function decompressLzop(input: Uint8Array, maxOutputBytes: number): Buffer {
  const reader = new Reader(input);
  const flags = readHeader(reader, input);
  const blocks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const uncompressedLength = reader.u32();
    if (uncompressedLength === 0) break;
    if (uncompressedLength > MAX_BLOCK_BYTES) throw corrupt('a block is larger than the format allows');
    total += uncompressedLength;
    if (total > maxOutputBytes) {
      throw new DecompressionLimitError(`Archive bomb detected: LZO output exceeds the limit of ${maxOutputBytes} bytes`);
    }
    const compressedLength = reader.u32();
    if (compressedLength === 0 || compressedLength > uncompressedLength) throw corrupt('a block has an invalid compressed length');
    const decompressedChecksum = declaredChecksum(flags, FLAG_ADLER32_DECOMPRESSED, FLAG_CRC32_DECOMPRESSED, reader);
    const stored = compressedLength === uncompressedLength;
    const compressedChecksum = stored ? null : declaredChecksum(flags, FLAG_ADLER32_COMPRESSED, FLAG_CRC32_COMPRESSED, reader);
    const compressed = reader.take(compressedLength);
    verifyChecksum(compressedChecksum, compressed, 'compressed block');
    const block = stored ? compressed : decompressLzo1xBlock(compressed, uncompressedLength);
    verifyChecksum(decompressedChecksum, block, 'decompressed block');
    blocks.push(Buffer.from(block.buffer, block.byteOffset, block.byteLength));
  }
  if (reader.remaining > 0) throw corrupt('data follows the end of the file');
  return Buffer.concat(blocks, total);
}
