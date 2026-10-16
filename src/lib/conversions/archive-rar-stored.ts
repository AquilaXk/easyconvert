import { crc32 } from './crc32';

/**
 * Reads a RAR 4.x archive whose entries are all stored (method 0x30): the bytes of an entry are in the file as they are, so
 * no decoder and no child process is needed to get them. The reader answers only for archives it can verify completely
 * and returns null for everything else, which a caller hands to the general pipeline (7-Zip), so a compressed, encrypted,
 * multi-volume or unusual archive is never half-read here.
 *
 * Layout (RAR 4.x technical note): the 7-byte marker, then blocks that each start with the low 16 bits of the CRC-32 of the
 * block's header from its type byte on, the type, flags and header size. A file block (0x74) is followed by the entry's
 * bytes; the file header carries the packed and unpacked size, the creating system, the CRC-32 of the entry, the MS-DOS
 * modification time, the method, the attributes and the name.
 */

const MARKER = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
const HEAD_MAIN = 0x73;
const HEAD_FILE = 0x74;
const HEAD_END = 0x7b;
const BLOCK_PREFIX_BYTES = 7;
const FILE_HEADER_FIXED_BYTES = 32;
const MAIN_HEADER_MIN_BYTES = 13;
const HEADER_CRC_MASK = 0xffff;
const HEADER_CRC_SKIP = 2;

const MAIN_FLAG_VOLUME = 0x0001;
const MAIN_FLAG_ENCRYPTED_HEADERS = 0x0080;

const FILE_FLAG_SPLIT_BEFORE = 0x0001;
const FILE_FLAG_SPLIT_AFTER = 0x0002;
const FILE_FLAG_PASSWORD = 0x0004;
const FILE_FLAG_DIRECTORY_MASK = 0x00e0;
const FILE_FLAG_LARGE = 0x0100;
const FILE_FLAG_UNICODE_NAME = 0x0200;
const FILE_FLAG_SALT = 0x0400;
const FILE_FLAG_VERSION = 0x0800;
const FILE_FLAG_EXTENDED_TIME = 0x1000;
const FILE_FLAG_EXTRA_AREA = 0x2000;
/** File flags the reader does not interpret: an archive that sets one is left to the general pipeline. */
const UNSUPPORTED_FILE_FLAGS =
  FILE_FLAG_SPLIT_BEFORE |
  FILE_FLAG_SPLIT_AFTER |
  FILE_FLAG_PASSWORD |
  FILE_FLAG_LARGE |
  FILE_FLAG_UNICODE_NAME |
  FILE_FLAG_SALT |
  FILE_FLAG_VERSION |
  FILE_FLAG_EXTENDED_TIME |
  FILE_FLAG_EXTRA_AREA;

const METHOD_STORE = 0x30;
const HOST_UNIX = 3;
const HOST_MACOS = 5;
const UNIX_TYPE_MASK = 0o170000;
const UNIX_SYMLINK = 0o120000;
const UNIX_DIRECTORY = 0o040000;
const PERMISSION_MASK = 0o777;
const FIRST_PRINTABLE_ASCII = 0x20;
const LAST_PRINTABLE_ASCII = 0x7e;
const BACKSLASH = 0x5c;

export interface StoredRarEntry {
  /** Name as stored (ASCII), with the separator the creator used; a Windows creator's backslashes are turned into slashes. */
  name: string;
  isDirectory: boolean;
  /** True for an entry whose Unix mode says it is a symbolic link; its bytes are the link target. */
  isSymlink: boolean;
  /** The entry's bytes: a view into the archive buffer. */
  data: Buffer;
  /** Permission bits when a Unix system created the entry. */
  mode?: number;
  /** MS-DOS date and time (date in the high half), local time. */
  dosDateTime: number;
}

/** Whether the buffer starts with the RAR 4.x marker. */
export function hasRar4Marker(buffer: Uint8Array): boolean {
  return buffer.length >= MARKER.length && MARKER.every((byte, index) => buffer[index] === byte);
}

function isPrintableAscii(name: Buffer): boolean {
  return name.every((byte) => byte >= FIRST_PRINTABLE_ASCII && byte <= LAST_PRINTABLE_ASCII);
}

function entryName(raw: Buffer, host: number): string {
  const name = raw.toString('latin1');
  return host === HOST_UNIX || host === HOST_MACOS ? name : name.replaceAll(String.fromCharCode(BACKSLASH), '/');
}

/** A block header whose CRC-16 holds, or null. */
function readHeader(buffer: Buffer, at: number, minimum: number): { type: number; flags: number; size: number } | null {
  if (at + BLOCK_PREFIX_BYTES > buffer.length) return null;
  const size = buffer.readUInt16LE(at + 5);
  if (size < minimum || at + size > buffer.length) return null;
  const expected = buffer.readUInt16LE(at);
  if ((crc32(buffer.subarray(at + HEADER_CRC_SKIP, at + size)) & HEADER_CRC_MASK) !== expected) return null;
  return { type: buffer[at + 2], flags: buffer.readUInt16LE(at + 3), size };
}

/**
 * The entries of a stored RAR 4.x archive in archive order, each checked against its CRC-32, or null when the archive is
 * anything else (another version, volumes, encryption, a compressed entry, a name that is not plain ASCII, a damaged
 * header or entry). `maxEntries` bounds the work on an archive that is a list of empty entries.
 */
export function readStoredRar4(buffer: Buffer, maxEntries: number): StoredRarEntry[] | null {
  if (!hasRar4Marker(buffer)) return null;
  let at = MARKER.length;
  const main = readHeader(buffer, at, MAIN_HEADER_MIN_BYTES);
  if (main === null || main.type !== HEAD_MAIN || (main.flags & (MAIN_FLAG_VOLUME | MAIN_FLAG_ENCRYPTED_HEADERS)) !== 0) return null;
  at += main.size;

  const entries: StoredRarEntry[] = [];
  for (;;) {
    const header = readHeader(buffer, at, BLOCK_PREFIX_BYTES);
    if (header === null) return null;
    if (header.type === HEAD_END) return entries;
    if (header.type !== HEAD_FILE || header.size < FILE_HEADER_FIXED_BYTES || (header.flags & UNSUPPORTED_FILE_FLAGS) !== 0) return null;
    if (entries.length >= maxEntries) return null;

    const packed = buffer.readUInt32LE(at + 7);
    const unpacked = buffer.readUInt32LE(at + 11);
    const host = buffer[at + 15];
    const expectedCrc = buffer.readUInt32LE(at + 16);
    const dosDateTime = buffer.readUInt32LE(at + 20);
    const method = buffer[at + 25];
    const nameLength = buffer.readUInt16LE(at + 26);
    const attributes = buffer.readUInt32LE(at + 28);
    if (method !== METHOD_STORE || packed !== unpacked || header.size !== FILE_HEADER_FIXED_BYTES + nameLength) return null;
    const rawName = buffer.subarray(at + FILE_HEADER_FIXED_BYTES, at + FILE_HEADER_FIXED_BYTES + nameLength);
    if (nameLength === 0 || !isPrintableAscii(rawName)) return null;

    const dataStart = at + header.size;
    const dataEnd = dataStart + packed;
    if (dataEnd > buffer.length) return null;
    const data = buffer.subarray(dataStart, dataEnd);
    if (crc32(data) !== expectedCrc) return null;

    const unixHost = host === HOST_UNIX || host === HOST_MACOS;
    const unixType = unixHost ? attributes & UNIX_TYPE_MASK : 0;
    entries.push({
      name: entryName(rawName, host),
      isDirectory: (header.flags & FILE_FLAG_DIRECTORY_MASK) === FILE_FLAG_DIRECTORY_MASK || unixType === UNIX_DIRECTORY,
      isSymlink: unixType === UNIX_SYMLINK,
      data,
      mode: unixType === 0 ? undefined : attributes & PERMISSION_MASK,
      dosDateTime,
    });
    at = dataEnd;
  }
}
