import zlib from 'node:zlib';
import { ConversionFailedError, CorruptStreamError, DecompressionLimitError } from '../types';

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
/** 7-Zip allows 64 coders per folder; real archives use at most 4 (a filter plus a compressor). */
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
  ENCODED_HEADER: 0x17,
} as const;

export interface SevenZipCoder {
  codecId: Buffer;
  properties: Buffer;
  numInStreams: number;
  numOutStreams: number;
}

export interface SevenZipFolder {
  coders: SevenZipCoder[];
  /** Number of pack streams this folder consumes, in order, from the pack stream table. */
  packedStreamCount: number;
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
}

export interface SevenZipReadLimits {
  maxFiles: number;
  maxUncompressedBytes: number;
  maxRatio: number;
}

export type SevenZipFolderDecoder = (folder: SevenZipFolder, packed: Buffer) => Buffer;

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

function readFolder(reader: HeaderReader): { folder: SevenZipFolder; outStreams: number; mainOut: number } {
  const coderCount = reader.count(MAX_CODERS_PER_FOLDER, 'coder');
  if (coderCount === 0) throw corrupt('a folder has no coders');
  const coders: SevenZipCoder[] = [];
  let totalIn = 0;
  let totalOut = 0;
  for (let index = 0; index < coderCount; index += 1) {
    const flags = reader.byte();
    if ((flags & CODER_FLAG_ALTERNATIVES) !== 0) throw new ConversionFailedError('Unsupported 7z coder: alternative methods are reserved');
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
  const boundOut = new Set<number>();
  for (let index = 0; index < bindPairCount; index += 1) {
    reader.number();
    boundOut.add(reader.number());
  }
  const packedStreamCount = totalIn - bindPairCount;
  if (packedStreamCount < 1) throw corrupt('a folder has no packed stream');
  if (packedStreamCount > 1) {
    for (let index = 0; index < packedStreamCount; index += 1) reader.number();
  }
  let mainOut = 0;
  while (boundOut.has(mainOut)) mainOut += 1;
  return { folder: { coders, packedStreamCount, unpackSize: 0, substreams: [] }, outStreams: totalOut, mainOut };
}

function readUnpackInfo(reader: HeaderReader, info: StreamsInfo, limits: SevenZipReadLimits): void {
  if (reader.byte() !== ID.FOLDER) throw corrupt('the coder table is missing');
  const folderCount = reader.count(limits.maxFiles, 'folder');
  if (reader.byte() !== 0) throw new ConversionFailedError('Unsupported 7z archive: external folder data is not supported');
  const outStreamCounts: number[] = [];
  const mainOutIndexes: number[] = [];
  for (let index = 0; index < folderCount; index += 1) {
    const { folder, outStreams, mainOut } = readFolder(reader);
    mainOutIndexes.push(mainOut);
    outStreamCounts.push(outStreams);
    info.folders.push(folder);
  }
  if (reader.byte() !== ID.CODERS_UNPACK_SIZE) throw corrupt('the coder output sizes are missing');
  info.folders.forEach((folder, folderIndex) => {
    for (let outIndex = 0; outIndex < outStreamCounts[folderIndex]; outIndex += 1) {
      const size = reader.number();
      if (outIndex === mainOutIndexes[folderIndex]) folder.unpackSize = size;
    }
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

const FILE_TABLE_PROPERTIES: ReadonlySet<number> = new Set([ID.EMPTY_STREAM, ID.EMPTY_FILE, ID.ANTI, ID.NAME]);

interface FileRecord {
  name: string;
  hasStream: boolean;
  isEmptyFile: boolean;
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
    }
  }
  if (names === null) throw corrupt('the file table has no names');
  let emptyIndex = 0;
  return names.map((name, index) => {
    if (!emptyStream[index]) return { name, hasStream: true, isEmptyFile: false };
    const position = emptyIndex++;
    return { name, hasStream: false, isEmptyFile: emptyFile[position] === true && anti[position] !== true };
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
    if (folder.coders.length !== 1 || folder.packedStreamCount !== 1) {
      throw new ConversionFailedError(
        `Unsupported 7z folder: ${folder.coders.length} chained coders (filters such as BCJ are not supported)`
      );
    }
    if (packIndex >= streams.packSizes.length) throw corrupt('a folder has no pack stream');
    const packSize = streams.packSizes[packIndex++];
    if (packOffset + packSize > packEnd) throw corrupt('truncated pack stream');
    const packed = Buffer.from(archive.subarray(packOffset, packOffset + packSize));
    packOffset += packSize;

    budget.totalBytes += folder.unpackSize;
    if (budget.totalBytes > budget.limits.maxUncompressedBytes) {
      throw new DecompressionLimitError(
        `Archive bomb detected: uncompressed size exceeds limit of ${budget.limits.maxUncompressedBytes} bytes (500MB)`
      );
    }
    if (budget.archiveBytes > 0 && budget.totalBytes / budget.archiveBytes > budget.limits.maxRatio) {
      throw new DecompressionLimitError(`Archive bomb detected: compression ratio exceeds ${budget.limits.maxRatio}:1 limit`);
    }

    const data = decode(folder, packed);
    if (data.length !== folder.unpackSize) {
      throw corrupt(`unpack size mismatch (expected ${folder.unpackSize}, got ${data.length})`);
    }
    if (folder.crc !== undefined && zlib.crc32(data) !== folder.crc) {
      throw corrupt(`CRC mismatch (expected 0x${folder.crc.toString(16)}, got 0x${zlib.crc32(data).toString(16)})`);
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

/**
 * Every file of a 7z archive, with its stored name and bytes, in file-table order. Directories and anti-items are
 * omitted; an empty file is an entry with no bytes.
 */
export function readSevenZipArchive(
  archive: Buffer,
  decode: SevenZipFolderDecoder,
  limits: SevenZipReadLimits
): SevenZipEntry[] {
  const { headerStart, headerSize, headerCrc } = readStartHeader(archive);
  if (headerSize === 0) return [];
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
  const folderData = unpackFolders(archive, streams, headerStart, decode, budget);
  const pieces: { data: Buffer; crc?: number }[] = [];
  streams.folders.forEach((folder, folderIndex) => {
    let offset = 0;
    for (const substream of folder.substreams) {
      pieces.push({ data: Buffer.from(folderData[folderIndex].subarray(offset, offset + substream.size)), crc: substream.crc });
      offset += substream.size;
    }
  });

  const entries: SevenZipEntry[] = [];
  let pieceIndex = 0;
  for (const file of files) {
    if (file.hasStream) {
      const piece = pieces[pieceIndex++];
      if (piece === undefined) throw corrupt(`no data stream for ${file.name}`);
      if (piece.crc !== undefined && zlib.crc32(piece.data) !== piece.crc) throw corrupt(`CRC mismatch for ${file.name}`);
      entries.push({ name: file.name, data: piece.data });
    } else if (file.isEmptyFile) {
      entries.push({ name: file.name, data: Buffer.alloc(0) });
    }
  }
  if (pieceIndex !== pieces.length) throw corrupt(`${pieces.length} data streams for ${pieceIndex} files`);
  return entries;
}
