import zlib from 'node:zlib';
import { CorruptStreamError, DecompressionLimitError } from '../types';
import { LzmaDecoder } from './lzma-decoder';

/**
 * lzip (`.lz`) reader, in process. A file is one or more members laid end to end; a member is the 6-byte header
 * (`LZIP`, version 1, a dictionary size byte), an LZMA stream with the fixed properties lc 3, lp 0, pb 2 that always
 * ends in an end-of-stream marker, and a 20-byte trailer (CRC-32 of the data, data size, member size; all little endian).
 *
 * The member sizes in the trailers tile the file, so the members are located from the end backwards and each one is
 * decoded between its own header and trailer. Fail closed: the size the trailer declares is checked against the caller's
 * limit before decoding, the stream must end exactly where the trailer starts with exactly that many bytes decoded, and
 * the CRC-32 must match. Bytes that are not part of a member (trailing data) are an error.
 */

const MAGIC = Buffer.from('LZIP', 'latin1');
const SUPPORTED_VERSION = 1;
const HEADER_BYTES = 6;
const TRAILER_BYTES = 20;
const VERSION_OFFSET = 4;
const DICTIONARY_BYTE_OFFSET = 5;
const TRAILER_CRC_OFFSET = 0;
const TRAILER_DATA_SIZE_OFFSET = 4;
const TRAILER_MEMBER_SIZE_OFFSET = 12;
const MIN_DICTIONARY_LOG2 = 12;
const MAX_DICTIONARY_LOG2 = 29;
const DICTIONARY_LOG2_MASK = 0x1f;
const DICTIONARY_WRAP_SHIFT = 5;
const LZIP_PROPERTIES = { lc: 3, lp: 0, pb: 2 } as const;

function corrupt(detail: string): CorruptStreamError {
  return new CorruptStreamError(`Corrupt lzip data: ${detail}`);
}

interface Member {
  /** Offset of the member's header. */
  start: number;
  /** Offset one past the member's trailer. */
  end: number;
  dataSize: number;
  crc: number;
}

/** A trailer field that has to be a size inside the file: a 64-bit value beyond the safe integers cannot be one. */
function readSize(input: Buffer, offset: number, what: string): number {
  const value = input.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw corrupt(`the ${what} is out of range`);
  return Number(value);
}

function assertMemberHeader(input: Buffer, start: number): void {
  if (!input.subarray(start, start + MAGIC.length).equals(MAGIC)) throw corrupt('a member header is missing');
  if (input[start + VERSION_OFFSET] !== SUPPORTED_VERSION) throw corrupt(`member version ${input[start + VERSION_OFFSET]} is not supported`);
  const dictionaryByte = input[start + DICTIONARY_BYTE_OFFSET];
  const log2 = dictionaryByte & DICTIONARY_LOG2_MASK;
  const wrap = dictionaryByte >> DICTIONARY_WRAP_SHIFT;
  // A wrap fraction only exists above the 4 KiB minimum.
  if (log2 < MIN_DICTIONARY_LOG2 || log2 > MAX_DICTIONARY_LOG2 || (log2 === MIN_DICTIONARY_LOG2 && wrap > 0)) {
    throw corrupt('a member declares an invalid dictionary size');
  }
}

/** The members of the file in order, found from the member sizes the trailers state. */
function locateMembers(input: Buffer): Member[] {
  const members: Member[] = [];
  let end = input.length;
  while (end > 0) {
    if (end < HEADER_BYTES + TRAILER_BYTES) throw corrupt('the file is shorter than one member');
    const trailer = end - TRAILER_BYTES;
    const memberSize = readSize(input, trailer + TRAILER_MEMBER_SIZE_OFFSET, 'member size');
    if (memberSize < HEADER_BYTES + TRAILER_BYTES || memberSize > end) throw corrupt('a member size does not fit the file');
    const start = end - memberSize;
    assertMemberHeader(input, start);
    members.push({
      start,
      end,
      dataSize: readSize(input, trailer + TRAILER_DATA_SIZE_OFFSET, 'data size'),
      crc: input.readUInt32LE(trailer + TRAILER_CRC_OFFSET),
    });
    end = start;
  }
  return members.reverse();
}

/**
 * Decodes an lzip file. The result never exceeds `maxOutputBytes`; a member whose trailer declares more is refused as a
 * {@link DecompressionLimitError} before it is decoded.
 */
export function decompressLzip(input: Buffer, maxOutputBytes: number): Buffer {
  const members = locateMembers(input);
  if (members.length === 0) throw corrupt('the file is empty');
  let declared = 0;
  for (const member of members) {
    declared += member.dataSize;
    if (declared > maxOutputBytes) {
      throw new DecompressionLimitError(`Archive bomb detected: lzip output exceeds the limit of ${maxOutputBytes} bytes`);
    }
  }

  // The decoder looks one byte past each member (the end marker), so its own limit is one above the caller's. The buffer is
  // sized from the trailers, which the caller's limit has already bounded.
  const decoder = new LzmaDecoder(declared + 1, maxOutputBytes + 1);
  for (const member of members) {
    decoder.setProperties(LZIP_PROPERTIES);
    decoder.resetState();
    decoder.resetDictionary();
    const outputStart = decoder.outPos;
    const streamEnd = member.end - TRAILER_BYTES;
    // One byte more than the member holds: the byte that is not there is where the end marker must be.
    const consumed = decoder.decode(input, member.start + HEADER_BYTES, streamEnd, member.dataSize + 1, true);
    if (decoder.outPos - outputStart !== member.dataSize) throw corrupt('a member decodes to a different size than its trailer states');
    if (consumed !== streamEnd) throw corrupt('a member has data between its stream and its trailer');
    if (zlib.crc32(decoder.output.subarray(outputStart)) !== member.crc) throw corrupt('a member does not match its CRC-32');
  }
  const output = decoder.output;
  return Buffer.from(output.buffer, output.byteOffset, output.byteLength);
}
