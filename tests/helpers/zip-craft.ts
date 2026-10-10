import zlib from 'node:zlib';

/**
 * Hand-assembled ZIP archives for adversarial reader tests.
 *
 * Every byte is laid out from the PKWARE APPNOTE 6.3.x record definitions, independent of the readers in src/. Each
 * header field can be overridden on its own, so a test can make the local header and the central directory disagree,
 * declare a size the data does not have, or point two entries at the same bytes. `unzip -t` and `7z t` are the
 * oracles for whether a fixture is a well-formed archive when it is meant to be one.
 */

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const ZIP64_END_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const DESCRIPTOR_SIGNATURE = 0x08074b50;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;

export const ZIP_FLAG_ENCRYPTED = 0x0001;
export const ZIP_FLAG_DESCRIPTOR = 0x0008;
export const ZIP_FLAG_UTF8 = 0x0800;
export const UNIX_HOST = 3;
export const S_IFLNK = 0o120000;
export const S_IFREG = 0o100000;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function zipCrc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip64Extra(fields: { uncompressed?: bigint; compressed?: bigint; offset?: bigint }): Buffer {
  const values = [fields.uncompressed, fields.compressed, fields.offset].filter((v): v is bigint => v !== undefined);
  const body = Buffer.alloc(values.length * 8);
  values.forEach((value, index) => body.writeBigUInt64LE(value, index * 8));
  const header = Buffer.alloc(4);
  header.writeUInt16LE(0x0001, 0);
  header.writeUInt16LE(body.length, 2);
  return Buffer.concat([header, body]);
}

export interface CraftedEntry {
  /** Name in the central directory (and, unless `localName` is set, in the local header). */
  name: string | Buffer;
  localName?: string | Buffer;
  /** The uncompressed content. */
  data?: Buffer;
  /** Compression method; 0 stores, 8 deflates. Any other value stores the bytes under that method id. */
  method?: number;
  /** The bytes written as the entry's data, in place of `data` stored or deflated. */
  rawPayload?: Buffer;
  flags?: number;
  localFlags?: number;
  /** High 16 bits are the unix mode when the host is unix. */
  externalAttributes?: number;
  versionMadeBy?: number;
  crc?: number;
  localCrc?: number;
  compressedSize?: number;
  localCompressedSize?: number;
  uncompressedSize?: number;
  localUncompressedSize?: number;
  centralExtra?: Buffer;
  localExtra?: Buffer;
  /** Append a data descriptor and set bit 3 in both headers (local sizes and crc are then written as zero). */
  descriptor?: boolean;
  /** Local header offset recorded in the central directory, in place of the real one. */
  offsetOverride?: number;
}

export interface CraftOptions {
  comment?: Buffer;
  /** Bytes in front of the first local header (a self-extractor stub); offsets in the headers stay relative to the archive start. */
  prefix?: Buffer;
  /** Write a ZIP64 end record and locator, and saturate the end record's count, size and offset fields. */
  zip64End?: boolean;
  /** Entry count written to the end records, in place of the real one. */
  declaredEntries?: number;
  /** Central directory size / offset written to the end record, in place of the real ones. */
  declaredDirectorySize?: number;
  declaredDirectoryOffset?: number;
  /** Take the local header and data of every entry from this entry index instead (builds the layout, not the directory). */
  trailing?: Buffer;
}

function nameBytes(name: string | Buffer): Buffer {
  return typeof name === 'string' ? Buffer.from(name, 'utf8') : name;
}

function payloadOf(entry: CraftedEntry): Buffer {
  if (entry.rawPayload) return entry.rawPayload;
  const data = entry.data ?? Buffer.alloc(0);
  const method = entry.method ?? 8;
  return method === 8 ? zlib.deflateRawSync(data) : data;
}

export interface CraftedLayout {
  archive: Buffer;
  /** Offset of each entry's local header, relative to the start of the archive (after any prefix). */
  offsets: number[];
  directoryOffset: number;
  directorySize: number;
}

export function craftZipArchive(entries: CraftedEntry[], options: CraftOptions = {}): CraftedLayout {
  const prefix = options.prefix ?? Buffer.alloc(0);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    const method = entry.method ?? 8;
    const payload = payloadOf(entry);
    const name = nameBytes(entry.name);
    const localName = nameBytes(entry.localName ?? entry.name);
    const flags = (entry.flags ?? ZIP_FLAG_UTF8) | (entry.descriptor ? ZIP_FLAG_DESCRIPTOR : 0);
    const localFlags = (entry.localFlags ?? entry.flags ?? ZIP_FLAG_UTF8) | (entry.descriptor ? ZIP_FLAG_DESCRIPTOR : 0);
    const crc = entry.crc ?? zipCrc32(data);
    const compressedSize = entry.compressedSize ?? payload.length;
    const uncompressedSize = entry.uncompressedSize ?? data.length;
    const centralExtra = entry.centralExtra ?? Buffer.alloc(0);
    const localExtra = entry.localExtra ?? Buffer.alloc(0);

    const local = Buffer.alloc(LOCAL_HEADER_BYTES);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(localFlags, 6);
    local.writeUInt16LE(method, 8);
    if (!entry.descriptor) {
      local.writeUInt32LE(entry.localCrc ?? crc, 14);
      local.writeUInt32LE((entry.localCompressedSize ?? compressedSize) >>> 0, 18);
      local.writeUInt32LE((entry.localUncompressedSize ?? uncompressedSize) >>> 0, 22);
    }
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    const descriptor = Buffer.alloc(entry.descriptor ? 16 : 0);
    if (entry.descriptor) {
      descriptor.writeUInt32LE(DESCRIPTOR_SIGNATURE, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(compressedSize >>> 0, 8);
      descriptor.writeUInt32LE(uncompressedSize >>> 0, 12);
    }
    const localBytes = Buffer.concat([local, localName, localExtra, payload, descriptor]);
    offsets.push(offset);

    const central = Buffer.alloc(CENTRAL_HEADER_BYTES);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    central.writeUInt16LE(entry.versionMadeBy ?? (UNIX_HOST << 8) | 30, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize >>> 0, 20);
    central.writeUInt32LE(uncompressedSize >>> 0, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(centralExtra.length, 30);
    central.writeUInt32LE((entry.externalAttributes ?? (S_IFREG | 0o644) * 0x10000) >>> 0, 38);
    central.writeUInt32LE((entry.offsetOverride ?? offset) >>> 0, 42);
    centrals.push(Buffer.concat([central, name, centralExtra]));
    locals.push(localBytes);
    offset += localBytes.length;
  }
  const body = Buffer.concat([...locals, options.trailing ?? Buffer.alloc(0)]);
  const directory = Buffer.concat(centrals);
  const directoryOffset = body.length;
  const count = options.declaredEntries ?? entries.length;
  const comment = options.comment ?? Buffer.alloc(0);

  const end = Buffer.alloc(END_RECORD_BYTES);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(options.zip64End ? MAX_U16 : count, 8);
  end.writeUInt16LE(options.zip64End ? MAX_U16 : count, 10);
  end.writeUInt32LE(options.zip64End ? MAX_U32 : (options.declaredDirectorySize ?? directory.length), 12);
  end.writeUInt32LE(options.zip64End ? MAX_U32 : (options.declaredDirectoryOffset ?? directoryOffset), 16);
  end.writeUInt16LE(comment.length, 20);

  let zip64Tail = Buffer.alloc(0);
  if (options.zip64End) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(ZIP64_END_SIGNATURE, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(count), 24);
    record.writeBigUInt64LE(BigInt(count), 32);
    record.writeBigUInt64LE(BigInt(options.declaredDirectorySize ?? directory.length), 40);
    record.writeBigUInt64LE(BigInt(options.declaredDirectoryOffset ?? directoryOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(ZIP64_LOCATOR_SIGNATURE, 0);
    locator.writeBigUInt64LE(BigInt(directoryOffset + directory.length), 8);
    locator.writeUInt32LE(1, 16);
    zip64Tail = Buffer.concat([record, locator]);
  }
  const archive = Buffer.concat([prefix, body, directory, zip64Tail, end, comment]);
  return { archive, offsets, directoryOffset, directorySize: directory.length };
}

export function craftZip(entries: CraftedEntry[], options: CraftOptions = {}): Buffer {
  return craftZipArchive(entries, options).archive;
}
