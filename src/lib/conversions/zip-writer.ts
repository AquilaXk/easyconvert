import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import zlib from 'node:zlib';
import { ConversionFailedError, PayloadLimitError, UnsupportedOptionError } from '../types';
import { crc32 } from './crc32';

/**
 * Streaming ZIP writer (PKWARE APPNOTE 6.3.10): local headers, optional data descriptors, ZIP64 extra fields and end
 * records when a size, an offset or the entry count passes the classic 32-bit / 16-bit fields, and per-entry choice
 * between Store and Deflate. Output goes to a sink function one chunk at a time, so the writer holds no more than one
 * compressed entry (or one stream chunk) plus the central directory, which is O(entries).
 */

// ---------------------------------------------------------------------------
// Format constants (APPNOTE section 4)
// ---------------------------------------------------------------------------

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_RECORD_SIGNATURE = 0x06054b50;
const ZIP64_END_RECORD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EXTRA_ID = 0x0001;

const LOCAL_HEADER_FIXED_BYTES = 30;
const CENTRAL_HEADER_FIXED_BYTES = 46;
const END_RECORD_BYTES = 22;
const ZIP64_END_RECORD_BYTES = 56;
const ZIP64_END_RECORD_BODY_BYTES = 44;
const ZIP64_LOCATOR_BYTES = 20;
const ZIP64_EXTRA_HEADER_BYTES = 4;
const DATA_DESCRIPTOR_BYTES_32 = 16;
const DATA_DESCRIPTOR_BYTES_64 = 24;

const VERSION_DEFAULT = 20;
const VERSION_ZIP64 = 45;
/** "Version made by": host system 3 (Unix) so that the external attributes carry a Unix mode. */
const HOST_UNIX = 3;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8_NAME = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;
const UINT32_RADIX = 0x100000000;
const MAX_ENTRY_NAME_BYTES = MAX_UINT16;

const DEFAULT_FILE_MODE = 0o100644;
const DEFAULT_DIRECTORY_MODE = 0o040755;
const DOS_DIRECTORY_ATTRIBUTE = 0x10;
const UNIX_MODE_SHIFT = 16;

const DOS_YEAR_BASE = 1980;
const DOS_YEAR_MAX = 2107;
const DOS_YEAR_SHIFT = 9;
const DOS_MONTH_SHIFT = 5;
const DOS_HOUR_SHIFT = 11;
const DOS_MINUTE_SHIFT = 5;
const DOS_SECOND_UNITS = 2;

/** Deflate level used when the caller names none (zlib's default speed/ratio balance). */
export const ZIP_DEFAULT_LEVEL = 6;
const ZIP_LEVEL_MIN = 0;
const ZIP_LEVEL_MAX = 9;

/** Bytes the writer hands to the sink at once when it copies (stream sources arrive in the chunks their source makes). */
export const ZIP_WRITER_BUFFER_BYTES = 1024 * 1024;
/** Most entries one archive may hold: the central directory is kept in memory, so the count is bounded. */
export const ZIP_WRITER_MAX_ENTRIES = 262_144;
/** Magic-number inspection reads this many leading bytes of an entry. */
const MAGIC_PROBE_BYTES = 16;

// ---------------------------------------------------------------------------
// Which entries are already compressed
// ---------------------------------------------------------------------------

/** Extensions of formats whose payload is already entropy-coded: deflating them costs time and gains nothing. */
const PRECOMPRESSED_EXTENSIONS: ReadonlySet<string> = new Set([
  'jpg', 'jpeg', 'jpe', 'jfif', 'png', 'apng', 'webp', 'avif', 'heic', 'heif', 'gif', 'jp2', 'j2k', 'jxl',
  'mp4', 'm4v', 'm4a', 'mov', 'mkv', 'webm', 'avi', 'mpg', 'mpeg', 'ogv', '3gp', 'flv',
  'mp3', 'aac', 'opus', 'ogg', 'oga', 'flac', 'wma', 'wmv',
  'zip', 'jar', 'war', 'apk', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub',
  '7z', 'gz', 'tgz', 'xz', 'txz', 'bz2', 'tbz2', 'zst', 'lz4', 'lzma', 'rar', 'woff', 'woff2',
]);

function bytesAt(head: Uint8Array, offset: number, text: string): boolean {
  if (head.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (head[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

const ISO_BMFF_PLAIN_BRANDS: ReadonlySet<string> = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4A ', 'M4V ', 'qt  ', 'dash', '3gp4', '3gp5', 'f4v ']);
const ISO_BMFF_IMAGE_BRANDS: ReadonlySet<string> = new Set(['avif', 'avis', 'heic', 'heix', 'mif1', 'msf1', 'hevc']);

/** True when the leading bytes identify a container whose payload is already compressed. */
export function hasCompressedMagic(head: Uint8Array): boolean {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true; // JPEG
  if (bytesAt(head, 1, 'PNG')) return head[0] === 0x89;
  if (bytesAt(head, 0, 'RIFF') && bytesAt(head, 8, 'WEBP')) return true;
  if (bytesAt(head, 0, 'GIF8')) return true;
  if (bytesAt(head, 0, 'OggS') || bytesAt(head, 0, 'fLaC') || bytesAt(head, 0, 'ID3')) return true;
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xf6) === 0xf0) return true; // ADTS AAC
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return true; // MPEG audio frame sync
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return true; // Matroska
  if (bytesAt(head, 0, 'PK\x03\x04') || bytesAt(head, 0, 'PK\x05\x06') || bytesAt(head, 0, '7z\xbc\xaf\x27\x1c')) return true;
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return true; // gzip
  if (bytesAt(head, 0, '\xfd7zXZ\x00') || bytesAt(head, 0, 'BZh') || bytesAt(head, 0, 'Rar!')) return true;
  if (head.length >= 4 && head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd) return true; // zstd
  if (bytesAt(head, 0, 'wOFF') || bytesAt(head, 0, 'wOF2')) return true;
  if (bytesAt(head, 4, 'ftyp') && head.length >= 12) {
    const brand = String.fromCharCode(head[8], head[9], head[10], head[11]);
    return ISO_BMFF_PLAIN_BRANDS.has(brand) || ISO_BMFF_IMAGE_BRANDS.has(brand) || brand.trim().length > 0;
  }
  return false;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  const slash = name.lastIndexOf('/');
  return dot > slash ? name.slice(dot + 1).toLowerCase() : '';
}

/** Whether an entry should be stored rather than deflated, judged by its extension and its leading bytes. */
export function isPrecompressedEntry(name: string, head: Uint8Array): boolean {
  return PRECOMPRESSED_EXTENSIONS.has(extensionOf(name)) || hasCompressedMagic(head);
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export type ZipSource = Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
export type ZipSink = (chunk: Uint8Array) => void | Promise<void>;

export interface ZipEntryInput {
  /** Path inside the archive with `/` separators; a name ending in `/` is a directory entry. */
  name: string;
  /** Entry content: bytes held in memory, or a (possibly async) iterable of chunks. Absent for directories. */
  data?: ZipSource;
  /** Size of a streamed source when known up front; it selects 32-bit data descriptors and is checked against the stream. */
  declaredSize?: number;
  mtime?: Date;
  /** `auto` (default) stores precompressed entries and deflates the rest. */
  method?: 'auto' | 'store' | 'deflate';
  /** Deflate level 0-9. */
  level?: number;
  /** Unix permission bits and file type (default 0o100644 for files, 0o040755 for directories). */
  mode?: number;
}

export interface ZipWriterOptions {
  /** `auto` writes ZIP64 records only where a field overflows; `always` writes them for every entry and the archive. */
  zip64?: 'auto' | 'always';
  defaultLevel?: number;
}

interface CentralRecord {
  nameBytes: Buffer;
  flags: number;
  method: number;
  dosTime: number;
  dosDate: number;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
  /** The entry's local header carries a ZIP64 extra field. */
  localZip64: boolean;
  externalAttributes: number;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(DOS_YEAR_MAX, Math.max(DOS_YEAR_BASE, date.getFullYear()));
  const time =
    (date.getHours() << DOS_HOUR_SHIFT) | (date.getMinutes() << DOS_MINUTE_SHIFT) | Math.floor(date.getSeconds() / DOS_SECOND_UNITS);
  const day = ((year - DOS_YEAR_BASE) << DOS_YEAR_SHIFT) | ((date.getMonth() + 1) << DOS_MONTH_SHIFT) | date.getDate();
  return { time, date: day };
}

function writeUint64(buffer: Buffer, value: number, offset: number): void {
  buffer.writeUInt32LE(value % UINT32_RADIX, offset);
  buffer.writeUInt32LE(Math.floor(value / UINT32_RADIX), offset + 4);
}

function zipFailure(message: string): ConversionFailedError {
  return new ConversionFailedError(`ZIP writer: ${message}`);
}

function isBytes(source: ZipSource): source is Uint8Array {
  return source instanceof Uint8Array;
}

export class ZipWriter {
  private readonly records: CentralRecord[] = [];
  private offset = 0;
  private finished = false;
  private readonly zip64Always: boolean;
  private readonly defaultLevel: number;

  constructor(private readonly sink: ZipSink, options: ZipWriterOptions = {}) {
    this.zip64Always = options.zip64 === 'always';
    const level = options.defaultLevel ?? ZIP_DEFAULT_LEVEL;
    if (!Number.isInteger(level) || level < ZIP_LEVEL_MIN || level > ZIP_LEVEL_MAX) {
      throw new UnsupportedOptionError(`ZIP compression level must be an integer from ${ZIP_LEVEL_MIN} to ${ZIP_LEVEL_MAX}.`);
    }
    this.defaultLevel = level;
  }

  /** Bytes written to the sink so far. */
  get bytesWritten(): number {
    return this.offset;
  }

  get entryCount(): number {
    return this.records.length;
  }

  private async emit(chunk: Uint8Array): Promise<void> {
    if (chunk.length === 0) return;
    await this.sink(chunk);
    this.offset += chunk.length;
  }

  async addEntry(entry: ZipEntryInput): Promise<void> {
    if (this.finished) throw zipFailure('the archive is already finished');
    if (this.records.length >= ZIP_WRITER_MAX_ENTRIES) {
      throw new PayloadLimitError(`ZIP writer: more than ${ZIP_WRITER_MAX_ENTRIES} entries`);
    }
    const nameBytes = Buffer.from(entry.name, 'utf8');
    if (nameBytes.length === 0) throw zipFailure('an entry has an empty name');
    if (nameBytes.length > MAX_ENTRY_NAME_BYTES) throw zipFailure(`entry name of ${nameBytes.length} bytes is too long`);
    const isDirectory = entry.name.endsWith('/');
    const when = dosDateTime(entry.mtime ?? new Date());
    const nonAscii = nameBytes.some((byte) => byte > 0x7f);
    const mode = entry.mode ?? (isDirectory ? DEFAULT_DIRECTORY_MODE : DEFAULT_FILE_MODE);
    const externalAttributes = ((mode << UNIX_MODE_SHIFT) | (isDirectory ? DOS_DIRECTORY_ATTRIBUTE : 0)) >>> 0;
    const base = { nameBytes, dosTime: when.time, dosDate: when.date, externalAttributes };

    if (isDirectory) {
      await this.writeBufferedEntry({ ...base, flags: nonAscii ? FLAG_UTF8_NAME : 0 }, new Uint8Array(0), METHOD_STORE, 0);
      return;
    }
    if (entry.data === undefined) throw zipFailure(`entry "${entry.name}" has no data`);
    const flagsUtf8 = nonAscii ? FLAG_UTF8_NAME : 0;
    const level = entry.level ?? this.defaultLevel;
    if (!Number.isInteger(level) || level < ZIP_LEVEL_MIN || level > ZIP_LEVEL_MAX) {
      throw new UnsupportedOptionError(`ZIP compression level must be an integer from ${ZIP_LEVEL_MIN} to ${ZIP_LEVEL_MAX}.`);
    }

    if (isBytes(entry.data)) {
      const storeWanted = entry.method === 'store' || level === 0 || (entry.method !== 'deflate' && isPrecompressedEntry(entry.name, entry.data.subarray(0, MAGIC_PROBE_BYTES)));
      await this.writeBufferedEntry({ ...base, flags: flagsUtf8 }, entry.data, storeWanted ? METHOD_STORE : METHOD_DEFLATE, level);
      return;
    }
    await this.writeStreamedEntry({ ...base, flags: flagsUtf8 }, entry, entry.data, level);
  }

  /** An entry whose bytes are in memory: sizes and CRC are known before the header, so no data descriptor is needed. */
  private async writeBufferedEntry(
    base: Pick<CentralRecord, 'nameBytes' | 'flags' | 'dosTime' | 'dosDate' | 'externalAttributes'>,
    data: Uint8Array,
    wantedMethod: number,
    level: number
  ): Promise<void> {
    const crc = crc32(data);
    let method = wantedMethod;
    let payload: Uint8Array = data;
    if (method === METHOD_DEFLATE && data.length > 0) {
      const deflated = await deflateRaw(data, level);
      // Deflate that does not shrink the data is not worth the decode time: keep the original bytes.
      if (deflated.length < data.length) payload = deflated;
      else method = METHOD_STORE;
    } else if (method === METHOD_DEFLATE) {
      method = METHOD_STORE;
    }
    const size = data.length;
    const compressedSize = payload.length;
    const needsZip64 = this.zip64Always || size >= MAX_UINT32 || compressedSize >= MAX_UINT32;
    const record: CentralRecord = {
      ...base,
      method,
      crc,
      compressedSize,
      size,
      offset: this.offset,
      localZip64: needsZip64,
    };
    await this.emit(localHeader(record, needsZip64));
    await this.emit(payload);
    this.records.push(record);
  }

  /** A streamed entry: the header is written first with zero sizes, and a data descriptor follows the data. */
  private async writeStreamedEntry(
    base: Pick<CentralRecord, 'nameBytes' | 'flags' | 'dosTime' | 'dosDate' | 'externalAttributes'>,
    entry: ZipEntryInput,
    source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
    level: number
  ): Promise<void> {
    // Without a size the descriptor must be able to hold more than 32 bits, so the entry is written as ZIP64.
    const zip64 = this.zip64Always || entry.declaredSize === undefined || entry.declaredSize >= MAX_UINT32;
    const iterator = toAsyncIterator(source);
    // The method for `auto` is decided from the first chunk, so that chunk is read before the header goes out.
    const firstResult = await iterator.next();
    const first = firstResult.done ? undefined : firstResult.value;
    let method = entry.method === 'store' || level === 0 ? METHOD_STORE : METHOD_DEFLATE;
    if (entry.method === undefined || entry.method === 'auto') {
      if (first !== undefined && isPrecompressedEntry(entry.name, first.subarray(0, MAGIC_PROBE_BYTES))) method = METHOD_STORE;
    }
    const record: CentralRecord = {
      ...base,
      flags: base.flags | FLAG_DATA_DESCRIPTOR,
      method,
      crc: 0,
      compressedSize: 0,
      size: 0,
      offset: this.offset,
      localZip64: zip64,
    };
    await this.emit(localHeader(record, zip64, true));

    let crc = 0;
    let size = 0;
    let compressedSize = 0;
    async function* chunks(): AsyncGenerator<Uint8Array> {
      if (first !== undefined) yield first;
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    }
    async function* checksum(input: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
      for await (const chunk of input) {
        crc = crc32(chunk, crc);
        size += chunk.length;
        yield chunk;
      }
    }
    const write = async (output: AsyncIterable<Uint8Array>): Promise<void> => {
      for await (const chunk of output) {
        compressedSize += chunk.length;
        await this.emit(chunk);
      }
    };
    if (method === METHOD_DEFLATE) await pipeline(chunks(), checksum, zlib.createDeflateRaw({ level }), write);
    else await pipeline(chunks(), checksum, write);

    if (entry.declaredSize !== undefined && entry.declaredSize !== size) {
      throw zipFailure(`entry "${entry.name}" declared ${entry.declaredSize} bytes but its source produced ${size}`);
    }
    record.crc = crc;
    record.size = size;
    record.compressedSize = compressedSize;
    const descriptor = Buffer.alloc(zip64 ? DATA_DESCRIPTOR_BYTES_64 : DATA_DESCRIPTOR_BYTES_32);
    descriptor.writeUInt32LE(DATA_DESCRIPTOR_SIGNATURE, 0);
    descriptor.writeUInt32LE(crc, 4);
    if (zip64) {
      writeUint64(descriptor, compressedSize, 8);
      writeUint64(descriptor, size, 16);
    } else {
      if (size >= MAX_UINT32 || compressedSize >= MAX_UINT32) throw zipFailure(`entry "${entry.name}" outgrew its declared 32-bit size`);
      descriptor.writeUInt32LE(compressedSize, 8);
      descriptor.writeUInt32LE(size, 12);
    }
    await this.emit(descriptor);
    this.records.push(record);
  }

  /** Writes the central directory and the end records; the writer accepts no more entries afterwards. */
  async finish(): Promise<void> {
    if (this.finished) throw zipFailure('the archive is already finished');
    this.finished = true;
    const directoryOffset = this.offset;
    const count = this.records.length;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    for (const record of this.records) {
      const header = centralHeader(record);
      pending.push(header);
      pendingBytes += header.length;
      if (pendingBytes >= ZIP_WRITER_BUFFER_BYTES) {
        await this.emit(Buffer.concat(pending, pendingBytes));
        pending = [];
        pendingBytes = 0;
      }
    }
    if (pendingBytes > 0) await this.emit(Buffer.concat(pending, pendingBytes));
    const directorySize = this.offset - directoryOffset;

    const needsZip64 = this.zip64Always || count >= MAX_UINT16 || directorySize >= MAX_UINT32 || directoryOffset >= MAX_UINT32;
    if (needsZip64) {
      const zip64End = Buffer.alloc(ZIP64_END_RECORD_BYTES + ZIP64_LOCATOR_BYTES);
      zip64End.writeUInt32LE(ZIP64_END_RECORD_SIGNATURE, 0);
      writeUint64(zip64End, ZIP64_END_RECORD_BODY_BYTES, 4);
      zip64End.writeUInt16LE((HOST_UNIX << 8) | VERSION_ZIP64, 12);
      zip64End.writeUInt16LE(VERSION_ZIP64, 14);
      zip64End.writeUInt32LE(0, 16);
      zip64End.writeUInt32LE(0, 20);
      writeUint64(zip64End, count, 24);
      writeUint64(zip64End, count, 32);
      writeUint64(zip64End, directorySize, 40);
      writeUint64(zip64End, directoryOffset, 48);
      zip64End.writeUInt32LE(ZIP64_LOCATOR_SIGNATURE, ZIP64_END_RECORD_BYTES);
      zip64End.writeUInt32LE(0, ZIP64_END_RECORD_BYTES + 4);
      writeUint64(zip64End, this.offset, ZIP64_END_RECORD_BYTES + 8);
      zip64End.writeUInt32LE(1, ZIP64_END_RECORD_BYTES + 16);
      await this.emit(zip64End);
    }
    const end = Buffer.alloc(END_RECORD_BYTES);
    end.writeUInt32LE(END_RECORD_SIGNATURE, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(needsZip64 && count >= MAX_UINT16 ? MAX_UINT16 : count, 8);
    end.writeUInt16LE(needsZip64 && count >= MAX_UINT16 ? MAX_UINT16 : count, 10);
    end.writeUInt32LE(directorySize >= MAX_UINT32 || this.zip64Always ? MAX_UINT32 : directorySize, 12);
    end.writeUInt32LE(directoryOffset >= MAX_UINT32 || this.zip64Always ? MAX_UINT32 : directoryOffset, 16);
    end.writeUInt16LE(0, 20);
    await this.emit(end);
  }
}

// ---------------------------------------------------------------------------
// Record encoding
// ---------------------------------------------------------------------------

/**
 * Local file header for `record`. A ZIP64 entry carries the extra field (original size, then compressed size) and marks
 * both 32-bit sizes as "see the extra field"; `unknownSizes` is a streamed entry whose CRC and sizes follow in a data
 * descriptor, so the header holds zeros (and a ZIP64 streamed entry holds zeros in the extra field).
 */
function localHeader(record: CentralRecord, zip64: boolean, unknownSizes = false): Buffer {
  const extraBytes = zip64 ? ZIP64_EXTRA_HEADER_BYTES + 16 : 0;
  const header = Buffer.alloc(LOCAL_HEADER_FIXED_BYTES + record.nameBytes.length + extraBytes);
  header.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(zip64 ? VERSION_ZIP64 : VERSION_DEFAULT, 4);
  header.writeUInt16LE(record.flags, 6);
  header.writeUInt16LE(record.method, 8);
  header.writeUInt16LE(record.dosTime, 10);
  header.writeUInt16LE(record.dosDate, 12);
  header.writeUInt32LE(unknownSizes ? 0 : record.crc, 14);
  header.writeUInt32LE(zip64 ? MAX_UINT32 : unknownSizes ? 0 : record.compressedSize, 18);
  header.writeUInt32LE(zip64 ? MAX_UINT32 : unknownSizes ? 0 : record.size, 22);
  header.writeUInt16LE(record.nameBytes.length, 26);
  header.writeUInt16LE(extraBytes, 28);
  record.nameBytes.copy(header, LOCAL_HEADER_FIXED_BYTES);
  if (zip64) {
    const at = LOCAL_HEADER_FIXED_BYTES + record.nameBytes.length;
    header.writeUInt16LE(ZIP64_EXTRA_ID, at);
    header.writeUInt16LE(16, at + 2);
    writeUint64(header, unknownSizes ? 0 : record.size, at + 4);
    writeUint64(header, unknownSizes ? 0 : record.compressedSize, at + 12);
  }
  return header;
}

function centralHeader(record: CentralRecord): Buffer {
  const sizeOverflow = record.size >= MAX_UINT32 || record.compressedSize >= MAX_UINT32;
  const offsetOverflow = record.offset >= MAX_UINT32;
  // Fields move into the ZIP64 extra in this fixed order, and only those that overflow (APPNOTE 4.5.3).
  const moved: number[] = [];
  if (record.localZip64 || sizeOverflow) {
    moved.push(record.size, record.compressedSize);
  }
  if (offsetOverflow) moved.push(record.offset);
  const extraBytes = moved.length > 0 ? ZIP64_EXTRA_HEADER_BYTES + moved.length * 8 : 0;
  const zip64 = moved.length > 0;
  const header = Buffer.alloc(CENTRAL_HEADER_FIXED_BYTES + record.nameBytes.length + extraBytes);
  header.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
  header.writeUInt16LE((HOST_UNIX << 8) | (zip64 ? VERSION_ZIP64 : VERSION_DEFAULT), 4);
  header.writeUInt16LE(zip64 ? VERSION_ZIP64 : VERSION_DEFAULT, 6);
  header.writeUInt16LE(record.flags, 8);
  header.writeUInt16LE(record.method, 10);
  header.writeUInt16LE(record.dosTime, 12);
  header.writeUInt16LE(record.dosDate, 14);
  header.writeUInt32LE(record.crc, 16);
  const sizesInExtra = record.localZip64 || sizeOverflow;
  header.writeUInt32LE(sizesInExtra ? MAX_UINT32 : record.compressedSize, 20);
  header.writeUInt32LE(sizesInExtra ? MAX_UINT32 : record.size, 24);
  header.writeUInt16LE(record.nameBytes.length, 28);
  header.writeUInt16LE(extraBytes, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(record.externalAttributes, 38);
  header.writeUInt32LE(offsetOverflow ? MAX_UINT32 : record.offset, 42);
  record.nameBytes.copy(header, CENTRAL_HEADER_FIXED_BYTES);
  if (zip64) {
    let at = CENTRAL_HEADER_FIXED_BYTES + record.nameBytes.length;
    header.writeUInt16LE(ZIP64_EXTRA_ID, at);
    header.writeUInt16LE(moved.length * 8, at + 2);
    at += ZIP64_EXTRA_HEADER_BYTES;
    for (const value of moved) {
      writeUint64(header, value, at);
      at += 8;
    }
  }
  return header;
}

// ---------------------------------------------------------------------------
// Stream helpers
// ---------------------------------------------------------------------------

/** Entries up to this size are deflated on the calling thread: the thread-pool round trip costs more than the work. */
const SYNC_DEFLATE_MAX_BYTES = 64 * 1024;

function deflateRaw(data: Uint8Array, level: number): Promise<Buffer> {
  if (data.length <= SYNC_DEFLATE_MAX_BYTES) return Promise.resolve(zlib.deflateRawSync(data, { level }));
  return new Promise((resolve, reject) => {
    zlib.deflateRaw(data, { level }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

/** Both sync and async iterables become one async iterator, so a source is consumed the same way either way. */
function toAsyncIterator(source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>): AsyncIterator<Uint8Array> {
  if (Symbol.asyncIterator in source) return (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  const sync = (source as Iterable<Uint8Array>)[Symbol.iterator]();
  return {
    next: async (): Promise<IteratorResult<Uint8Array>> => sync.next(),
  };
}

// ---------------------------------------------------------------------------
// Convenience sinks
// ---------------------------------------------------------------------------

/** Writes the entries into one Buffer. For archives that may not fit in memory use `writeZipFile`. */
export async function createZipBuffer(entries: Iterable<ZipEntryInput>, options: ZipWriterOptions = {}): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const writer = new ZipWriter((chunk) => {
    chunks.push(chunk);
  }, options);
  for (const entry of entries) await writer.addEntry(entry);
  await writer.finish();
  return Buffer.concat(chunks, writer.bytesWritten);
}

/** Streams the entries into a file, waiting for each write to complete before the next one. */
export async function writeZipFile(
  filePath: string,
  entries: Iterable<ZipEntryInput> | AsyncIterable<ZipEntryInput>,
  options: ZipWriterOptions = {}
): Promise<void> {
  const out = createWriteStream(filePath);
  const writer = new ZipWriter(
    (chunk) =>
      new Promise<void>((resolve, reject) => {
        out.write(chunk, (error) => (error ? reject(error) : resolve()));
      }),
    options
  );
  try {
    for await (const entry of entries) await writer.addEntry(entry);
    await writer.finish();
    await new Promise<void>((resolve, reject) => {
      out.once('error', reject);
      out.end(() => resolve());
    });
  } catch (error) {
    out.destroy();
    throw error;
  }
}
