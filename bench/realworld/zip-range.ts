/**
 * Reads single entries out of a remote ZIP archive with HTTP range requests (APPNOTE 6.3.10, sections 4.3.6, 4.3.7,
 * 4.3.12 and 4.3.16): the end-of-central-directory record at the tail gives the central directory, whose headers give
 * each entry's local header offset and compressed size. Only the bytes of the chosen entries are transferred.
 */
import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_BYTES = 22;
const CENTRAL_HEADER_BYTES = 46;
const LOCAL_HEADER_BYTES = 30;
const ZIP64_MARKER_32 = 0xffffffff;
const ZIP64_MARKER_16 = 0xffff;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
const FLAG_ENCRYPTED = 0x1;
/** Longest archive comment plus the record itself: the EOCD record lies within this many bytes of the end. */
export const EOCD_SEARCH_BYTES = EOCD_MIN_BYTES + ZIP64_MARKER_16;

export class ZipRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipRangeError';
  }
}

export interface CentralDirectoryLocation {
  offset: number;
  size: number;
  entries: number;
}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

/** The central directory's position, from the last bytes of the archive (`tail`, ending at the archive's end). */
export function locateCentralDirectory(tail: Buffer): CentralDirectoryLocation {
  for (let at = tail.length - EOCD_MIN_BYTES; at >= 0; at--) {
    if (tail.readUInt32LE(at) !== EOCD_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(at + 20);
    if (at + EOCD_MIN_BYTES + commentLength !== tail.length) continue;
    const entries = tail.readUInt16LE(at + 10);
    const size = tail.readUInt32LE(at + 12);
    const offset = tail.readUInt32LE(at + 16);
    if (entries === ZIP64_MARKER_16 || size === ZIP64_MARKER_32 || offset === ZIP64_MARKER_32) {
      throw new ZipRangeError('ZIP64 archives are not supported by the range reader');
    }
    return { offset, size, entries };
  }
  throw new ZipRangeError('no end-of-central-directory record in the archive tail');
}

/** Every entry of a central directory read in full. */
export function parseCentralDirectory(directory: Buffer, expectedEntries: number): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let at = 0;
  while (at < directory.length) {
    if (at + CENTRAL_HEADER_BYTES > directory.length || directory.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      throw new ZipRangeError(`bad central directory header at offset ${at}`);
    }
    const flags = directory.readUInt16LE(at + 8);
    const method = directory.readUInt16LE(at + 10);
    const compressedSize = directory.readUInt32LE(at + 20);
    const size = directory.readUInt32LE(at + 24);
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    const localHeaderOffset = directory.readUInt32LE(at + 42);
    const end = at + CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength;
    if (end > directory.length) throw new ZipRangeError(`central directory entry at offset ${at} runs past the directory`);
    const name = directory.subarray(at + CENTRAL_HEADER_BYTES, at + CENTRAL_HEADER_BYTES + nameLength).toString('latin1');
    if ((flags & FLAG_ENCRYPTED) === 0 && !name.endsWith('/')) {
      entries.push({ name, method, compressedSize, size, localHeaderOffset });
    }
    at = end;
  }
  if (entries.length > expectedEntries) throw new ZipRangeError(`central directory lists more entries than its record (${expectedEntries})`);
  return entries;
}

/** Length of an entry's local header, from its first 30 bytes (name and extra field lengths may differ from the central copy). */
export function localHeaderLength(head: Buffer): number {
  if (head.length < LOCAL_HEADER_BYTES || head.readUInt32LE(0) !== LOCAL_SIGNATURE) throw new ZipRangeError('bad local file header');
  return LOCAL_HEADER_BYTES + head.readUInt16LE(26) + head.readUInt16LE(28);
}

/** The entry's uncompressed bytes from its compressed data. */
export function inflateEntry(entry: ZipEntry, data: Buffer): Buffer {
  if (data.length !== entry.compressedSize) throw new ZipRangeError(`${entry.name}: got ${data.length} compressed bytes, expected ${entry.compressedSize}`);
  let out: Buffer;
  if (entry.method === METHOD_STORED) out = data;
  else if (entry.method === METHOD_DEFLATED) out = inflateRawSync(data, { maxOutputLength: entry.size + 1 });
  else throw new ZipRangeError(`${entry.name}: compression method ${entry.method} is not supported`);
  if (out.length !== entry.size) throw new ZipRangeError(`${entry.name}: inflated to ${out.length} bytes, expected ${entry.size}`);
  return out;
}
