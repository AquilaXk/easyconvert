import zlib from 'node:zlib';
import {
  ArchivePasswordRequiredError,
  ConversionFailedError,
  CorruptStreamError,
  DecompressionLimitError,
  InvalidArchivePasswordError,
  PayloadLimitError,
  UnsupportedArchiveMethodError,
} from '../types';

/**
 * Reader for the 7z container (7-Zip's 7zFormat.txt): the 32-byte start header, the (possibly encoded) header with
 * its pack, coder and sub-stream tables, and the files table that names every stream, empty file and directory.
 *
 * Folder decompression is supplied by the caller, so the codecs stay with the archive engine. Every count read from
 * the header is checked against a named limit before it drives a loop or an allocation, and a header that does not
 * add up (bad checksum, truncated table, names that do not match the streams) throws a CorruptStreamError instead of
 * yielding fewer or differently named files.
 */

const START_HEADER_BYTES = 32;
const SIGNATURE = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const START_HEADER_CRC_OFFSET = 8;
const NEXT_HEADER_OFFSET_OFFSET = 12;
const NEXT_HEADER_SIZE_OFFSET = 20;
const NEXT_HEADER_CRC_OFFSET = 28;
const BITS_PER_BYTE = 8;
const FIRST_LENGTH_MASK = 0x80;
const MAX_NUMBER_BYTES = 8;
const CODER_ID_SIZE_MASK = 0x0f;
const CODER_FLAG_COMPLEX = 0x10;
const CODER_FLAG_ATTRIBUTES = 0x20;
const CODER_FLAG_ALTERNATIVES = 0x80;
const BYTE_MASK = 0xff;
const UTF16_UNIT_BYTES = 2;

/** An encoded header may itself be encoded; 7-Zip writes one level, so a deeper chain is not an archive. */
const MAX_ENCODED_HEADER_DEPTH = 4;
/** 7-Zip allows 64 coders per folder; real archives use at most 8 (BCJ2 with its three compressors, AES, filters). */
const MAX_CODERS_PER_FOLDER = 32;
const MAX_STREAMS_PER_CODER = 32;
/** The decoded header holds file names and tables only; this bounds how much a packed header may inflate to. */
const MAX_HEADER_BYTES = 64 * 1024 * 1024;

/** Property ids of 7zFormat.txt. */
const ID = {
  END: 0x00,
  HEADER: 0x01,
  ARCHIVE_PROPERTIES: 0x02,
  ADDITIONAL_STREAMS_INFO: 0x03,
  MAIN_STREAMS_INFO: 0x04,
  FILES_INFO: 0x05,
  PACK_INFO: 0x06,
  UNPACK_INFO: 0x07,
  SUBSTREAMS_INFO: 0x08,
  SIZE: 0x09,
  CRC: 0x0a,
  FOLDER: 0x0b,
  CODERS_UNPACK_SIZE: 0x0c,
  NUM_UNPACK_STREAM: 0x0d,
  EMPTY_STREAM: 0x0e,
  EMPTY_FILE: 0x0f,
  ANTI: 0x10,
  NAME: 0x11,
  MTIME: 0x14,
  WIN_ATTRIBUTES: 0x15,
  ENCODED_HEADER: 0x17,
} as const;

/** The AES-256 + SHA-256 coder id of an encrypted folder (06 F1 07 01). */
const AES_CODEC_ID = Buffer.from([0x06, 0xf1, 0x07, 0x01]);
/** Ticks of 100 ns between the Windows FILETIME epoch (1601) and the Unix epoch, in milliseconds. */
const FILETIME_UNIX_EPOCH_OFFSET_MS = 11_644_473_600_000n;
const FILETIME_TICKS_PER_MS = 10_000n;
const FILETIME_BYTES = 8;
const ATTRIBUTE_BYTES = 4;

export interface SevenZipCoder {
  codecId: Buffer;
  properties: Buffer;
  numInStreams: number;
  numOutStreams: number;
}

/** The input stream `inIndex` of a coder reads the output stream `outIndex` of another (indexes run over all coders). */
export interface SevenZipBindPair {
  inIndex: number;
  outIndex: number;
}

export interface SevenZipFolder {
  coders: SevenZipCoder[];
  bindPairs: SevenZipBindPair[];
  /** The input streams that read packed data, in the order of the folder's pack streams. */
  packedInStreams: number[];
  /** Number of pack streams this folder consumes, in order, from the pack stream table. */
  packedStreamCount: number;
  /** The size of every coder output stream, in output-stream order. */
  outSizes: number[];
  /** The output stream no bind pair consumes: the folder's result. */
  mainOut: number;
  /** Size of the folder's final output, the out stream no bind pair consumes. */
  unpackSize: number;
  crc?: number;
  /** The streams the folder's output is cut into (one per file that has data). */
  substreams: { size: number; crc?: number }[];
}

interface StreamsInfo {
  packPos: number;
  packSizes: number[];
  folders: SevenZipFolder[];
}

export interface SevenZipEntry {
  /** The name as stored (UTF-16LE decoded), not yet sanitized. */
  name: string;
  data: Buffer;
  /** The 32-bit attribute word: Windows bits, plus the Unix mode in the high half when bit 15 is set. */
  attributes?: number;
}

export interface SevenZipReadLimits {
  maxFiles: number;
  maxUncompressedBytes: number;
  maxRatio: number;
}

/** Decodes one folder from its pack streams (in pack order) to the bytes of its final output stream. */
export type SevenZipFolderDecoder = (folder: SevenZipFolder, packed: Buffer[]) => Buffer;

const ATTRIBUTE_DIRECTORY = 0x10;
const ATTRIBUTE_REPARSE_POINT = 0x400;
const ATTRIBUTE_UNIX_EXTENSION = 0x8000;
const UNIX_MODE_SHIFT = 16;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
/** Character and block devices, FIFOs and sockets. */
const SPECIAL_FILE_TYPES: ReadonlySet<number> = new Set([0o020000, 0o060000, 0o010000, 0o140000]);

export interface SevenZipAttributeKind {
  isDirectory: boolean;
  /** A Unix symbolic link, or a Windows reparse point (symlink or junction). */
  isSymlink: boolean;
  /** A device, FIFO or socket. */
  isSpecial: boolean;
}

/** What an attribute word says an item is. An item without attributes is a regular file. */
export function classifySevenZipAttributes(attributes: number | undefined): SevenZipAttributeKind {
  const word = attributes ?? 0;
  const unixType = (word & ATTRIBUTE_UNIX_EXTENSION) !== 0 ? (word >>> UNIX_MODE_SHIFT) & S_IFMT : 0;
  return {
    isDirectory: (word & ATTRIBUTE_DIRECTORY) !== 0 || unixType === S_IFDIR,
    isSymlink: unixType === S_IFLNK || (word & ATTRIBUTE_REPARSE_POINT) !== 0,
    isSpecial: SPECIAL_FILE_TYPES.has(unixType),
  };
}

/**
 * A folder whose structure cannot be decoded whatever the key (a coder graph that loops, an input that reads nothing,
 * properties that do not parse, an encrypted stream that is not whole blocks). It stays a plain malformed-input error
 * when the folder is encrypted; only a failure of the decoded data reads as a wrong password.
 */
export class SevenZipStructureError extends CorruptStreamError {
  constructor(message: string) {
    super(message);
    this.name = 'SevenZipStructureError';
  }
}

function corrupt(detail: string): CorruptStreamError {
  return new CorruptStreamError(`Corrupted 7z archive: ${detail}`);
}

class HeaderReader {
  offset = 0;

  constructor(private readonly bytes: Buffer) {}

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  byte(): number {
    if (this.offset >= this.bytes.length) throw corrupt('header truncated');
    return this.bytes[this.offset++];
  }

  /** A 7z variable-length number: the leading 1-bits of the first byte count the extra little-endian bytes. */
  number(): number {
    const first = this.byte();
    let mask = FIRST_LENGTH_MASK;
    let value = 0;
    for (let index = 0; index < MAX_NUMBER_BYTES; index += 1) {
      if ((first & mask) === 0) {
        value += (first & (mask - 1)) * 2 ** (BITS_PER_BYTE * index);
        break;
      }
      value += this.byte() * 2 ** (BITS_PER_BYTE * index);
      mask >>= 1;
    }
    if (!Number.isSafeInteger(value)) throw corrupt('header number out of range');
    return value;
  }

  /** A count that drives a loop or an allocation, refused above `max`. */
  count(max: number, what: string): number {
    const value = this.number();
    if (value > max) throw corrupt(`${what} count ${value} exceeds the limit of ${max}`);
    return value;
  }

  bytesOf(length: number): Buffer {
    if (length > this.remaining) throw corrupt('header truncated');
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  skipProperty(): void {
    this.bytesOf(this.number());
  }

  bitVector(length: number): boolean[] {
    const packed = this.bytesOf(Math.ceil(length / BITS_PER_BYTE));
    return Array.from({ length }, (_, index) => ((packed[index >> 3] >> (7 - (index & 7))) & 1) === 1);
  }

  /** The "all defined" byte, or else a bit vector, that precedes a digest or time list. */
  definedVector(length: number): boolean[] {
    const allDefined = this.byte();
    return allDefined === 0 ? this.bitVector(length) : new Array<boolean>(length).fill(true);
  }

  digests(length: number): (number | undefined)[] {
    const defined = this.definedVector(length);
    return defined.map((isDefined) => (isDefined ? this.bytesOf(4).readUInt32LE(0) : undefined));
  }
}

function readPackInfo(reader: HeaderReader, info: StreamsInfo, limits: SevenZipReadLimits): void {
  info.packPos = reader.number();
  const count = reader.count(limits.maxFiles, 'pack stream');
  for (let id = reader.byte(); id !== ID.END; id = reader.byte()) {
    if (id === ID.SIZE) {
      for (let index = 0; index < count; index += 1) info.packSizes.push(reader.number());
    } else if (id === ID.CRC) {
      reader.digests(count);
    } else {
      reader.skipProperty();
    }
  }
}

function readFolder(reader: HeaderReader): { folder: SevenZipFolder; outStreams: number } {
  const coderCount = reader.count(MAX_CODERS_PER_FOLDER, 'coder');
  if (coderCount === 0) throw corrupt('a folder has no coders');
  const coders: SevenZipCoder[] = [];
  let totalIn = 0;
  let totalOut = 0;
  for (let index = 0; index < coderCount; index += 1) {
    const flags = reader.byte();
    if ((flags & CODER_FLAG_ALTERNATIVES) !== 0) {
      throw new UnsupportedArchiveMethodError('Unsupported 7z coder: alternative methods are reserved');
    }
    const codecId = Buffer.from(reader.bytesOf(flags & CODER_ID_SIZE_MASK));
    let numInStreams = 1;
    let numOutStreams = 1;
    if ((flags & CODER_FLAG_COMPLEX) !== 0) {
      numInStreams = reader.count(MAX_STREAMS_PER_CODER, 'coder input stream');
      numOutStreams = reader.count(MAX_STREAMS_PER_CODER, 'coder output stream');
    }
    const properties = (flags & CODER_FLAG_ATTRIBUTES) !== 0 ? Buffer.from(reader.bytesOf(reader.number())) : Buffer.alloc(0);
    coders.push({ codecId, properties, numInStreams, numOutStreams });
    totalIn += numInStreams;
    totalOut += numOutStreams;
  }
  if (totalOut === 0) throw corrupt('a folder produces no output');
  const bindPairCount = totalOut - 1;
  const bindPairs: SevenZipBindPair[] = [];
  const boundIn = new Set<number>();
  const boundOut = new Set<number>();
  for (let index = 0; index < bindPairCount; index += 1) {
    const inIndex = reader.number();
    const outIndex = reader.number();
    if (inIndex >= totalIn || outIndex >= totalOut) throw corrupt('a bind pair names a stream the coders do not have');
    if (boundIn.has(inIndex) || boundOut.has(outIndex)) throw corrupt('a coder stream is bound twice');
    boundIn.add(inIndex);
    boundOut.add(outIndex);
    bindPairs.push({ inIndex, outIndex });
  }
  const packedStreamCount = totalIn - bindPairCount;
  if (packedStreamCount < 1) throw corrupt('a folder has no packed stream');
  const packedInStreams: number[] = [];
  if (packedStreamCount === 1) {
    for (let inIndex = 0; inIndex < totalIn; inIndex += 1) if (!boundIn.has(inIndex)) packedInStreams.push(inIndex);
  } else {
    const seen = new Set<number>();
    for (let index = 0; index < packedStreamCount; index += 1) {
      const inIndex = reader.number();
      if (inIndex >= totalIn || boundIn.has(inIndex) || seen.has(inIndex)) throw corrupt('a packed stream names an input that is bound or unknown');
      seen.add(inIndex);
      packedInStreams.push(inIndex);
    }
  }
  let mainOut = 0;
  while (boundOut.has(mainOut)) mainOut += 1;
  const folder: SevenZipFolder = {
    coders,
    bindPairs,
    packedInStreams,
    packedStreamCount,
    outSizes: [],
    mainOut,
    unpackSize: 0,
    substreams: [],
  };
  return { folder, outStreams: totalOut };
}

function readUnpackInfo(reader: HeaderReader, info: StreamsInfo, limits: SevenZipReadLimits): void {
  if (reader.byte() !== ID.FOLDER) throw corrupt('the coder table is missing');
  const folderCount = reader.count(limits.maxFiles, 'folder');
  if (reader.byte() !== 0) throw new ConversionFailedError('Unsupported 7z archive: external folder data is not supported');
  const outStreamCounts: number[] = [];
  for (let index = 0; index < folderCount; index += 1) {
    const { folder, outStreams } = readFolder(reader);
    outStreamCounts.push(outStreams);
    info.folders.push(folder);
  }
  if (reader.byte() !== ID.CODERS_UNPACK_SIZE) throw corrupt('the coder output sizes are missing');
  info.folders.forEach((folder, folderIndex) => {
    for (let outIndex = 0; outIndex < outStreamCounts[folderIndex]; outIndex += 1) folder.outSizes.push(reader.number());
    folder.unpackSize = folder.outSizes[folder.mainOut];
  });
  for (let id = reader.byte(); id !== ID.END; id = reader.byte()) {
    if (id === ID.CRC) {
      reader.digests(folderCount).forEach((crc, folderIndex) => {
        info.folders[folderIndex].crc = crc;
      });
    } else {
      reader.skipProperty();
    }
  }
}

function readSubStreamsInfo(reader: HeaderReader, info: StreamsInfo, limits: SevenZipReadLimits): void {
  const streamCounts = info.folders.map(() => 1);
  let id = reader.byte();
  if (id === ID.NUM_UNPACK_STREAM) {
    streamCounts.forEach((_, index) => {
      streamCounts[index] = reader.count(limits.maxFiles, 'stream');
    });
    id = reader.byte();
  }
  if (streamCounts.reduce((sum, value) => sum + value, 0) > limits.maxFiles) {
    throw new DecompressionLimitError(`Archive bomb detected: file count exceeds limit of ${limits.maxFiles}`);
  }

  info.folders.forEach((folder, folderIndex) => {
    const streams = streamCounts[folderIndex];
    folder.substreams = [];
    if (streams === 0) return;
    if (id !== ID.SIZE) {
      if (streams > 1) throw corrupt('the sizes of the streams in a folder are missing');
      folder.substreams.push({ size: folder.unpackSize });
      return;
    }
    let sum = 0;
    for (let stream = 0; stream < streams - 1; stream += 1) {
      const size = reader.number();
      folder.substreams.push({ size });
      sum += size;
    }
    if (sum > folder.unpackSize) throw corrupt('stream sizes exceed the folder size');
    folder.substreams.push({ size: folder.unpackSize - sum });
  });
  if (id === ID.SIZE) id = reader.byte();

  const needsDigest = (folder: SevenZipFolder): boolean => folder.substreams.length !== 1 || folder.crc === undefined;
  const digestCount = info.folders.reduce((sum, folder) => sum + (needsDigest(folder) ? folder.substreams.length : 0), 0);
  let digests: (number | undefined)[] = [];
  for (; id !== ID.END; id = reader.byte()) {
    if (id === ID.CRC) {
      digests = reader.digests(digestCount);
    } else {
      reader.skipProperty();
    }
  }
  let digestIndex = 0;
  for (const folder of info.folders) {
    if (!needsDigest(folder)) {
      folder.substreams[0].crc = folder.crc;
      continue;
    }
    for (const substream of folder.substreams) substream.crc = digests[digestIndex++];
  }
}

function readStreamsInfo(reader: HeaderReader, limits: SevenZipReadLimits): StreamsInfo {
  const info: StreamsInfo = { packPos: 0, packSizes: [], folders: [] };
  let id = reader.byte();
  if (id === ID.PACK_INFO) {
    readPackInfo(reader, info, limits);
    id = reader.byte();
  }
  if (id === ID.UNPACK_INFO) {
    readUnpackInfo(reader, info, limits);
    id = reader.byte();
  }
  for (const folder of info.folders) folder.substreams = [{ size: folder.unpackSize, crc: folder.crc }];
  if (id === ID.SUBSTREAMS_INFO) {
    readSubStreamsInfo(reader, info, limits);
    id = reader.byte();
  }
  if (id !== ID.END) throw corrupt(`unexpected property 0x${id.toString(16)} in the streams table`);
  return info;
}

const FILE_TABLE_PROPERTIES: ReadonlySet<number> = new Set([ID.EMPTY_STREAM, ID.EMPTY_FILE, ID.ANTI, ID.NAME, ID.MTIME, ID.WIN_ATTRIBUTES]);

interface FileRecord {
  name: string;
  hasStream: boolean;
  isEmptyFile: boolean;
  /** An anti-item marks a deletion in an update archive; it names nothing to extract. */
  isAnti: boolean;
  /** Modification time in milliseconds since the Unix epoch, when the table states one. */
  mtimeMs?: number;
  /** The 32-bit attribute word: Windows attribute bits, plus the Unix mode in the high half when bit 15 is set. */
  attributes?: number;
}

/** One value per defined file: the "defined" vector, the external flag, then the packed values. */
function readPerFileValues<T>(property: HeaderReader, fileCount: number, read: (reader: HeaderReader) => T): (T | undefined)[] {
  const defined = property.definedVector(fileCount);
  if (property.byte() !== 0) throw new ConversionFailedError('Unsupported 7z archive: external file properties are not supported');
  return defined.map((isDefined) => (isDefined ? read(property) : undefined));
}

function readFileTime(property: HeaderReader): number {
  const ticks = property.bytesOf(FILETIME_BYTES).readBigUInt64LE(0);
  return Number(ticks / FILETIME_TICKS_PER_MS - FILETIME_UNIX_EPOCH_OFFSET_MS);
}

function decodeNames(bytes: Buffer, expected: number): string[] {
  const names: string[] = [];
  let start = 0;
  for (let offset = 0; offset + UTF16_UNIT_BYTES <= bytes.length; offset += UTF16_UNIT_BYTES) {
    if (bytes[offset] === 0 && bytes[offset + 1] === 0) {
      names.push(bytes.toString('utf16le', start, offset));
      start = offset + UTF16_UNIT_BYTES;
    }
  }
  if (names.length !== expected || start !== bytes.length) throw corrupt(`the file table names ${names.length} files but declares ${expected}`);
  return names;
}

function readFilesInfo(reader: HeaderReader, limits: SevenZipReadLimits): FileRecord[] {
  const fileCount = reader.number();
  if (fileCount > limits.maxFiles) {
    throw new DecompressionLimitError(`Archive bomb detected: file count exceeds limit of ${limits.maxFiles}`);
  }
  let emptyStream = new Array<boolean>(fileCount).fill(false);
  let emptyStreamCount = 0;
  let emptyFile: boolean[] = [];
  let anti: boolean[] = [];
  let names: string[] | null = null;
  let mtimes: (number | undefined)[] = [];
  let attributes: (number | undefined)[] = [];
  const seen = new Set<number>();
  for (let type = reader.number(); type !== ID.END; type = reader.number()) {
    const property = new HeaderReader(reader.bytesOf(reader.number()));
    // Each of these describes the whole table once; a repeat is not a valid file table.
    if (FILE_TABLE_PROPERTIES.has(type)) {
      if (seen.has(type)) throw corrupt(`the file table repeats property 0x${type.toString(16)}`);
      seen.add(type);
    }
    if (type === ID.EMPTY_STREAM) {
      emptyStream = property.bitVector(fileCount);
      emptyStreamCount = emptyStream.filter(Boolean).length;
    } else if (type === ID.EMPTY_FILE) {
      emptyFile = property.bitVector(emptyStreamCount);
    } else if (type === ID.ANTI) {
      anti = property.bitVector(emptyStreamCount);
    } else if (type === ID.NAME) {
      if (property.byte() !== 0) throw new ConversionFailedError('Unsupported 7z archive: external file names are not supported');
      names = decodeNames(property.bytesOf(property.remaining), fileCount);
    } else if (type === ID.MTIME) {
      mtimes = readPerFileValues(property, fileCount, readFileTime);
    } else if (type === ID.WIN_ATTRIBUTES) {
      attributes = readPerFileValues(property, fileCount, (reader) => reader.bytesOf(ATTRIBUTE_BYTES).readUInt32LE(0));
    }
  }
  if (names === null) throw corrupt('the file table has no names');
  let emptyIndex = 0;
  return names.map((name, index) => {
    const metadata = { mtimeMs: mtimes[index], attributes: attributes[index] };
    if (!emptyStream[index]) return { name, hasStream: true, isEmptyFile: false, isAnti: false, ...metadata };
    const position = emptyIndex++;
    const isAnti = anti[position] === true;
    return { name, hasStream: false, isEmptyFile: emptyFile[position] === true && !isAnti, isAnti, ...metadata };
  });
}

interface ParsedHeader {
  streams: StreamsInfo;
  files: FileRecord[];
}

function readHeader(reader: HeaderReader, limits: SevenZipReadLimits): ParsedHeader {
  let streams: StreamsInfo = { packPos: 0, packSizes: [], folders: [] };
  let files: FileRecord[] = [];
  for (let id = reader.byte(); id !== ID.END; id = reader.byte()) {
    if (id === ID.ARCHIVE_PROPERTIES) {
      while (reader.byte() !== ID.END) reader.skipProperty();
    } else if (id === ID.ADDITIONAL_STREAMS_INFO) {
      readStreamsInfo(reader, limits);
    } else if (id === ID.MAIN_STREAMS_INFO) {
      streams = readStreamsInfo(reader, limits);
    } else if (id === ID.FILES_INFO) {
      files = readFilesInfo(reader, limits);
    } else {
      throw corrupt(`unexpected property 0x${id.toString(16)} in the header`);
    }
  }
  return { streams, files };
}

interface UnpackBudget {
  totalBytes: number;
  archiveBytes: number;
  limits: SevenZipReadLimits;
}

function usesAes(folder: SevenZipFolder): boolean {
  return folder.coders.some((coder) => coder.codecId.equals(AES_CODEC_ID));
}

/** Errors that say something about the request or the archive's declared work, not about whether the bytes decoded. */
function isDecodeFailureOfDataAlone(err: unknown): boolean {
  return (
    err instanceof ConversionFailedError &&
    !(err instanceof SevenZipStructureError) &&
    !(err instanceof ArchivePasswordRequiredError) &&
    !(err instanceof InvalidArchivePasswordError) &&
    !(err instanceof UnsupportedArchiveMethodError) &&
    !(err instanceof PayloadLimitError)
  );
}

function invalidPassword(): InvalidArchivePasswordError {
  return new InvalidArchivePasswordError('Invalid password for the encrypted 7z archive.');
}

function assertWithinBudget(size: number, archiveBytes: number, limits: SevenZipReadLimits): void {
  if (size > limits.maxUncompressedBytes) {
    throw new DecompressionLimitError(`Archive bomb detected: uncompressed size exceeds limit of ${limits.maxUncompressedBytes} bytes (500MB)`);
  }
  if (archiveBytes > 0 && size / archiveBytes > limits.maxRatio) {
    throw new DecompressionLimitError(`Archive bomb detected: compression ratio exceeds ${limits.maxRatio}:1 limit`);
  }
}

/** Decodes every folder of `streams`, checking sizes, checksums and the decompression-bomb limits. */
function unpackFolders(
  archive: Buffer,
  streams: StreamsInfo,
  packEnd: number,
  decode: SevenZipFolderDecoder,
  budget: UnpackBudget
): Buffer[] {
  let packOffset = START_HEADER_BYTES + streams.packPos;
  let packIndex = 0;
  return streams.folders.map((folder) => {
    if (packIndex + folder.packedStreamCount > streams.packSizes.length) throw corrupt('a folder has no pack stream');
    const packed: Buffer[] = [];
    for (let stream = 0; stream < folder.packedStreamCount; stream += 1) {
      const packSize = streams.packSizes[packIndex++];
      if (packOffset + packSize > packEnd) throw corrupt('truncated pack stream');
      packed.push(Buffer.from(archive.subarray(packOffset, packOffset + packSize)));
      packOffset += packSize;
    }

    // Every coder's output is allocated or produced in full, so each declared size is bounded before any is decoded.
    folder.outSizes.forEach((size) => assertWithinBudget(size, budget.archiveBytes, budget.limits));
    budget.totalBytes += folder.unpackSize;
    assertWithinBudget(budget.totalBytes, budget.archiveBytes, budget.limits);

    const encrypted = usesAes(folder);
    let data: Buffer;
    try {
      data = decode(folder, packed);
    } catch (err) {
      // Decrypting with a wrong key yields noise, which no decoder accepts: that is the signal 7-Zip reports too.
      throw encrypted && isDecodeFailureOfDataAlone(err) ? invalidPassword() : err;
    }
    const mismatch = (detail: string): CorruptStreamError | InvalidArchivePasswordError => (encrypted ? invalidPassword() : corrupt(detail));
    if (data.length !== folder.unpackSize) {
      throw mismatch(`unpack size mismatch (expected ${folder.unpackSize}, got ${data.length})`);
    }
    if (folder.crc !== undefined && zlib.crc32(data) !== folder.crc) {
      throw mismatch(`CRC mismatch (expected 0x${folder.crc.toString(16)}, got 0x${zlib.crc32(data).toString(16)})`);
    }
    return data;
  });
}

function readStartHeader(archive: Buffer): { headerStart: number; headerSize: number; headerCrc: number } {
  if (archive.length < START_HEADER_BYTES) throw new CorruptStreamError('Invalid 7z archive: shorter than the 32-byte start header');
  if (!archive.subarray(0, SIGNATURE.length).equals(SIGNATURE)) throw new CorruptStreamError('Invalid 7z archive: bad signature');
  if (zlib.crc32(archive.subarray(NEXT_HEADER_OFFSET_OFFSET, START_HEADER_BYTES)) !== archive.readUInt32LE(START_HEADER_CRC_OFFSET)) {
    throw corrupt('start header CRC mismatch');
  }
  const offset = archive.readBigUInt64LE(NEXT_HEADER_OFFSET_OFFSET);
  const size = archive.readBigUInt64LE(NEXT_HEADER_SIZE_OFFSET);
  const end = BigInt(START_HEADER_BYTES) + offset + size;
  if (end > BigInt(archive.length)) throw corrupt('truncated next header');
  return {
    headerStart: START_HEADER_BYTES + Number(offset),
    headerSize: Number(size),
    headerCrc: archive.readUInt32LE(NEXT_HEADER_CRC_OFFSET),
  };
}

interface LoadedHeader {
  streams: StreamsInfo;
  files: FileRecord[];
  headerStart: number;
  budget: UnpackBudget;
}

/** Reads the start header and the (possibly encoded) header; `decode` is used on the header's own folders only. */
function loadHeader(archive: Buffer, decode: SevenZipFolderDecoder, limits: SevenZipReadLimits): LoadedHeader | null {
  const { headerStart, headerSize, headerCrc } = readStartHeader(archive);
  if (headerSize === 0) return null;
  const nextHeader = archive.subarray(headerStart, headerStart + headerSize);
  if (zlib.crc32(nextHeader) !== headerCrc) throw corrupt('next header CRC mismatch');

  const budget: UnpackBudget = { totalBytes: 0, archiveBytes: archive.length, limits };
  let reader = new HeaderReader(nextHeader);
  let id = reader.byte();
  for (let depth = 0; id === ID.ENCODED_HEADER; depth += 1) {
    if (depth >= MAX_ENCODED_HEADER_DEPTH) throw corrupt('the header is encoded too many times');
    const streams = readStreamsInfo(reader, limits);
    if (streams.folders.some((folder) => folder.unpackSize > MAX_HEADER_BYTES)) throw corrupt('the packed header is implausibly large');
    const [decoded] = unpackFolders(archive, streams, headerStart, decode, budget);
    if (decoded === undefined) throw corrupt('the encoded header has no folder');
    reader = new HeaderReader(decoded);
    id = reader.byte();
  }
  if (id !== ID.HEADER) throw corrupt(`unexpected header type 0x${id.toString(16)}`);

  const { streams, files } = readHeader(reader, limits);
  return { streams, files, headerStart, budget };
}

/**
 * Every file of a 7z archive, with its stored name and bytes, in file-table order. Directories and anti-items are
 * omitted; an empty file is an entry with no bytes.
 */
export function readSevenZipArchive(
  archive: Buffer,
  decode: SevenZipFolderDecoder,
  limits: SevenZipReadLimits
): SevenZipEntry[] {
  const header = loadHeader(archive, decode, limits);
  if (header === null) return [];
  const { streams, files, headerStart, budget } = header;
  const folderData = unpackFolders(archive, streams, headerStart, decode, budget);
  const pieces: { data: Buffer; crc?: number; encrypted: boolean }[] = [];
  streams.folders.forEach((folder, folderIndex) => {
    let offset = 0;
    const encrypted = usesAes(folder);
    for (const substream of folder.substreams) {
      pieces.push({ data: Buffer.from(folderData[folderIndex].subarray(offset, offset + substream.size)), crc: substream.crc, encrypted });
      offset += substream.size;
    }
  });

  const entries: SevenZipEntry[] = [];
  let pieceIndex = 0;
  for (const file of files) {
    if (file.hasStream) {
      const piece = pieces[pieceIndex++];
      if (piece === undefined) throw corrupt(`no data stream for ${file.name}`);
      if (piece.crc !== undefined && zlib.crc32(piece.data) !== piece.crc) {
        throw piece.encrypted ? invalidPassword() : corrupt(`CRC mismatch for ${file.name}`);
      }
      entries.push({ name: file.name, data: piece.data, attributes: file.attributes });
    } else if (file.isEmptyFile) {
      entries.push({ name: file.name, data: Buffer.alloc(0), attributes: file.attributes });
    }
  }
  if (pieceIndex !== pieces.length) throw corrupt(`${pieces.length} data streams for ${pieceIndex} files`);
  return entries;
}

/**
 * The properties of every AES coder of the archive's data folders, read from the header alone (the header itself is
 * decoded through `decode`). An async reader derives the keys they name before it decodes any data.
 */
export function collectSevenZipAesProperties(archive: Buffer, decode: SevenZipFolderDecoder, limits: SevenZipReadLimits): Buffer[] {
  const header = loadHeader(archive, decode, limits);
  if (header === null) return [];
  return header.streams.folders.flatMap((folder) => folder.coders.filter((coder) => coder.codecId.equals(AES_CODEC_ID)).map((coder) => coder.properties));
}

/** One item of a 7z file table, as 7-Zip would list it, without decoding any file data. */
export interface SevenZipListedFile {
  /** The name as stored (UTF-16LE decoded), not yet sanitized. */
  name: string;
  isDirectory: boolean;
  /** Bytes of the file's data stream; 0 for a directory or an empty file. */
  size: number;
  /** CRC-32 of the data stream, when the table states one. */
  crc?: number;
  mtimeMs?: number;
  /** The 32-bit attribute word: Windows bits, plus the Unix mode in the high half when bit 15 is set. */
  attributes?: number;
}

export interface SevenZipListing {
  /** In file-table order, which is the order `7z x -so` writes the data streams. Anti-items are omitted. */
  files: SevenZipListedFile[];
  /** A folder uses the AES coder, so its data cannot be read without a password. */
  encrypted: boolean;
}

/**
 * The file table of a 7z archive with sizes, checksums, times and attributes. Only the header is decoded (through
 * `decode`); the data folders are never touched, so listing costs the header's size, not the archive's. The table
 * must add up: every stream of every folder belongs to exactly one file, and the stream sizes fit the folders.
 */
export function listSevenZipArchive(archive: Buffer, decode: SevenZipFolderDecoder, limits: SevenZipReadLimits): SevenZipListing {
  const header = loadHeader(archive, decode, limits);
  if (header === null) return { files: [], encrypted: false };
  const { streams, files } = header;
  const substreams = streams.folders.flatMap((folder) => folder.substreams);
  let streamIndex = 0;
  const listed: SevenZipListedFile[] = [];
  for (const file of files) {
    if (file.isAnti) continue;
    const common = { name: file.name, mtimeMs: file.mtimeMs, attributes: file.attributes };
    if (file.hasStream) {
      const stream = substreams[streamIndex++];
      if (stream === undefined) throw corrupt(`no data stream for ${file.name}`);
      listed.push({ ...common, isDirectory: false, size: stream.size, crc: stream.crc });
    } else {
      listed.push({ ...common, isDirectory: !file.isEmptyFile, size: 0 });
    }
  }
  if (streamIndex !== substreams.length) throw corrupt(`${substreams.length} data streams for ${streamIndex} files`);
  return { files: listed, encrypted: streams.folders.some(usesAes) };
}
