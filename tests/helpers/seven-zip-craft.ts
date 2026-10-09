import zlib from 'node:zlib';

/**
 * Byte-level 7z writer for hostile fixtures that 7-Zip itself would not produce: a file whose name ends in a
 * separator, a member with a setuid mode, a symlink that declares gigabytes of data. Every member is stored (the Copy
 * coder, one folder each) so the sizes in the header can be chosen freely. 7-Zip reads the result back in the tests,
 * which is what keeps the writer honest.
 */
const SIGNATURE = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const START_HEADER_BYTES = 32;
const ID = {
  END: 0x00,
  HEADER: 0x01,
  MAIN_STREAMS_INFO: 0x04,
  FILES_INFO: 0x05,
  PACK_INFO: 0x06,
  UNPACK_INFO: 0x07,
  SIZE: 0x09,
  CRC: 0x0a,
  FOLDER: 0x0b,
  CODERS_UNPACK_SIZE: 0x0c,
  EMPTY_STREAM: 0x0e,
  EMPTY_FILE: 0x0f,
  NAME: 0x11,
  MTIME: 0x14,
  WIN_ATTRIBUTES: 0x15,
} as const;
const COPY_CODER_FLAGS = 0x01; // a one-byte codec id, no properties
const COPY_CODEC_ID = 0x00;
const FILETIME_TICKS_PER_MS = 10_000n;
const FILETIME_UNIX_EPOCH_OFFSET_MS = 11_644_473_600_000n;
const DEFAULT_MTIME_MS = 1_614_834_360_000;

export const ATTRIBUTE_ARCHIVE = 0x20;
export const ATTRIBUTE_DIRECTORY = 0x10;
export const ATTRIBUTE_UNIX_EXTENSION = 0x8000;
export const S_IFREG = 0o100000;
export const S_IFDIR = 0o040000;
export const S_IFLNK = 0o120000;

/** The attribute word 7-Zip writes on Unix: Windows bits, with the st_mode in the high half. */
export function unixAttributes(stMode: number, windowsBits: number): number {
  return ((stMode << 16) | ATTRIBUTE_UNIX_EXTENSION | windowsBits) >>> 0;
}

export interface CraftedMember {
  name: string;
  /** The stored bytes. */
  data?: Buffer;
  /** The size the header declares for the data stream when it must differ from `data`. */
  declaredSize?: number;
  /** An empty-stream item that is a directory (the default for a member with no data and no declared size). */
  directory?: boolean;
  /** The 32-bit attribute word; defaults to a regular 0644 file or a 0755 directory. */
  attributes?: number;
  mtimeMs?: number;
}

function number7z(value: number): Buffer {
  let remaining = BigInt(value);
  for (let extra = 0; extra < 8; extra++) {
    if (remaining < 1n << BigInt(7 * (extra + 1))) {
      const high = Number(remaining >> BigInt(8 * extra));
      const marker = (0xff << (8 - extra)) & 0xff;
      const bytes = [marker | high];
      for (let index = 0; index < extra; index++) bytes.push(Number((remaining >> BigInt(8 * index)) & 0xffn));
      return Buffer.from(bytes);
    }
  }
  const bytes = Buffer.alloc(9);
  bytes[0] = 0xff;
  bytes.writeBigUInt64LE(remaining, 1);
  return bytes;
}

function bitVector(bits: boolean[]): Buffer {
  const out = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((bit, index) => {
    if (bit) out[index >> 3] |= 0x80 >> (index & 7);
  });
  return out;
}

function property(id: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([id]), number7z(body.length), body]);
}

function crc32Bytes(data: Buffer): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(zlib.crc32(data), 0);
  return out;
}

function fileTime(ms: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE((BigInt(ms) + FILETIME_UNIX_EPOCH_OFFSET_MS) * FILETIME_TICKS_PER_MS, 0);
  return out;
}

function defaultAttributes(member: CraftedMember, isDirectory: boolean): number {
  if (isDirectory) return unixAttributes(S_IFDIR | 0o755, ATTRIBUTE_DIRECTORY);
  return unixAttributes(S_IFREG | 0o644, ATTRIBUTE_ARCHIVE);
}

/** A complete 7z archive holding the members, in order. */
export function craftSevenZip(members: CraftedMember[]): Buffer {
  const streams = members.filter((member) => member.data !== undefined || member.declaredSize !== undefined);
  const packed = Buffer.concat(streams.map((member) => member.data ?? Buffer.alloc(0)));

  const parts: Buffer[] = [Buffer.from([ID.HEADER])];
  if (streams.length > 0) {
    parts.push(Buffer.from([ID.MAIN_STREAMS_INFO]));
    parts.push(Buffer.from([ID.PACK_INFO]), number7z(0), number7z(streams.length), Buffer.from([ID.SIZE]));
    parts.push(...streams.map((member) => number7z((member.data ?? Buffer.alloc(0)).length)), Buffer.from([ID.END]));
    parts.push(Buffer.from([ID.UNPACK_INFO, ID.FOLDER]), number7z(streams.length), Buffer.from([0]));
    for (let index = 0; index < streams.length; index++) {
      parts.push(number7z(1), Buffer.from([COPY_CODER_FLAGS, COPY_CODEC_ID]));
    }
    parts.push(Buffer.from([ID.CODERS_UNPACK_SIZE]));
    parts.push(...streams.map((member) => number7z(member.declaredSize ?? (member.data as Buffer).length)));
    parts.push(Buffer.from([ID.CRC, 1]), ...streams.map((member) => crc32Bytes(member.data ?? Buffer.alloc(0))));
    parts.push(Buffer.from([ID.END, ID.END]));
  }

  const hasStream = members.map((member) => member.data !== undefined || member.declaredSize !== undefined);
  const emptyStreamMembers = members.filter((_, index) => !hasStream[index]);
  parts.push(Buffer.from([ID.FILES_INFO]), number7z(members.length));
  if (emptyStreamMembers.length > 0) {
    parts.push(property(ID.EMPTY_STREAM, bitVector(hasStream.map((value) => !value))));
    parts.push(property(ID.EMPTY_FILE, bitVector(emptyStreamMembers.map((member) => member.directory === false))));
  }
  parts.push(property(ID.NAME, Buffer.concat([Buffer.from([0]), ...members.map((member) => Buffer.from(`${member.name}\0`, 'utf16le'))])));
  parts.push(property(ID.MTIME, Buffer.concat([Buffer.from([1, 0]), ...members.map((member) => fileTime(member.mtimeMs ?? DEFAULT_MTIME_MS))])));
  const attributeWords = members.map((member, index) => {
    const isDirectory = !hasStream[index] && member.directory !== false;
    const word = Buffer.alloc(4);
    word.writeUInt32LE(member.attributes ?? defaultAttributes(member, isDirectory), 0);
    return word;
  });
  parts.push(property(ID.WIN_ATTRIBUTES, Buffer.concat([Buffer.from([1, 0]), ...attributeWords])));
  parts.push(Buffer.from([ID.END, ID.END]));

  const header = Buffer.concat(parts);
  const startFields = Buffer.alloc(20);
  startFields.writeBigUInt64LE(BigInt(packed.length), 0);
  startFields.writeBigUInt64LE(BigInt(header.length), 8);
  startFields.writeUInt32LE(zlib.crc32(header), 16);
  const start = Buffer.alloc(START_HEADER_BYTES);
  SIGNATURE.copy(start, 0);
  start[6] = 0;
  start[7] = 4;
  start.writeUInt32LE(zlib.crc32(startFields), 8);
  startFields.copy(start, 12);
  return Buffer.concat([start, packed, header]);
}
