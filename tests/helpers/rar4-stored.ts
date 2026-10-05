import { crc32 } from 'node:zlib';

/**
 * Writes a RAR 4.x archive whose entries are stored (method 0x30, no compression), following the RAR
 * 4.x technical note: a 7-byte marker block, a main header (type 0x73), one file header (type 0x74)
 * followed by the entry bytes per file, and an end-of-archive block (type 0x7b). Every header starts
 * with the low 16 bits of the CRC-32 of the header from its type byte on. Authored for the tests,
 * separately from the archive engine under test.
 */
export interface StoredRarEntry {
  name: string;
  data: Buffer;
}

const MARKER = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
const HEAD_MAIN = 0x73;
const HEAD_FILE = 0x74;
const HEAD_END = 0x7b;
/** File header flag: the block carries data (ADD_SIZE) after the header. */
const FLAG_LONG_BLOCK = 0x8000;
/** End-of-archive flag: no further volume follows. */
const FLAG_END_NO_NEXT_VOLUME = 0x4000;
const MAIN_HEADER_BYTES = 13;
const END_HEADER_BYTES = 7;
/** Bytes of a file header before its name. */
const FILE_HEADER_FIXED_BYTES = 32;
const HOST_OS_UNIX = 3;
const UNPACK_VERSION_2_9 = 29;
const METHOD_STORE = 0x30;
/** MS-DOS date/time of 2024-01-01 00:00:00, so archives are byte-stable. */
const DOS_TIME = ((2024 - 1980) << 25) | (1 << 21) | (1 << 16);
/** Unix mode 0100644 (regular file, rw-r--r--). */
const UNIX_REGULAR_FILE_MODE = 0o100644;
const CRC16_MASK = 0xffff;

function sealHeader(header: Buffer): Buffer {
  header.writeUInt16LE(crc32(header.subarray(2)) & CRC16_MASK, 0);
  return header;
}

export function buildStoredRar4(entries: readonly StoredRarEntry[]): Buffer {
  const main = Buffer.alloc(MAIN_HEADER_BYTES);
  main.writeUInt8(HEAD_MAIN, 2);
  main.writeUInt16LE(0, 3);
  main.writeUInt16LE(MAIN_HEADER_BYTES, 5);
  const blocks: Buffer[] = [MARKER, sealHeader(main)];

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'latin1');
    const header = Buffer.alloc(FILE_HEADER_FIXED_BYTES + name.length);
    header.writeUInt8(HEAD_FILE, 2);
    header.writeUInt16LE(FLAG_LONG_BLOCK, 3);
    header.writeUInt16LE(header.length, 5);
    header.writeUInt32LE(entry.data.length, 7);
    header.writeUInt32LE(entry.data.length, 11);
    header.writeUInt8(HOST_OS_UNIX, 15);
    header.writeUInt32LE(crc32(entry.data), 16);
    header.writeUInt32LE(DOS_TIME >>> 0, 20);
    header.writeUInt8(UNPACK_VERSION_2_9, 24);
    header.writeUInt8(METHOD_STORE, 25);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt32LE(UNIX_REGULAR_FILE_MODE, 28);
    name.copy(header, FILE_HEADER_FIXED_BYTES);
    blocks.push(sealHeader(header), entry.data);
  }

  const end = Buffer.alloc(END_HEADER_BYTES);
  end.writeUInt8(HEAD_END, 2);
  end.writeUInt16LE(FLAG_END_NO_NEXT_VOLUME, 3);
  end.writeUInt16LE(END_HEADER_BYTES, 5);
  blocks.push(sealHeader(end));
  return Buffer.concat(blocks);
}
