import {
  ConversionFailedError,
  ArchivePasswordRequiredError,
  UnsupportedOptionError,
  DecompressionLimitError,
} from '../types';
import { crc32, sanitizeArchivePath, matchArchiveGlob } from './archive';
import { decompressBzip2 } from './bzip2';
import { inflateBounded, MAX_STREAM_INFLATE_BYTES } from './bounded-inflate';
import {
  METHOD_COPY,
  METHOD_DELTA,
  METHOD_LZMA,
  METHOD_BCJ,
  METHOD_PPC,
  METHOD_IA64,
  METHOD_ARM,
  METHOD_ARMT,
  METHOD_SPARC,
  METHOD_ARM64,
  METHOD_ARM64_ALT,
  METHOD_BCJ2,
  METHOD_DEFLATE,
  METHOD_DEFLATE_ZIP,
  METHOD_DEFLATE_64,
  METHOD_BZIP2,
  METHOD_AES256,
  METHOD_LZMA2,
  methodIdToHex,
  decrypt7zAes,
  decodeDelta,
  decodeBcj,
  decodeArm,
  decodeArmt,
  decodeArm64,
  decodePpc,
  decodeSparc,
  decodeIa64,
  decodeBcj2,
  decompressLzma,
  decompressLzma2,
} from './sevenzip-coders';

export interface SevenZipFile {
  filename: string;
  buffer: Buffer;
}

export interface Extract7zOptions {
  password?: string;
  entries?: string[];
}

const ARCHIVE_SECURITY_LIMITS = {
  MAX_UNCOMPRESSED_SIZE: 500 * 1024 * 1024, // 500 MB
  MAX_FILES: 10000,
  MAX_RATIO: 1000,
};

const SEVENZIP_MAGIC = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);

// 7z Property IDs
const kEnd = 0x00;
const kHeader = 0x01;
const kArchiveProperties = 0x02;
const kAdditionalStreamsInfo = 0x03;
const kMainStreamsInfo = 0x04;
const kFilesInfo = 0x05;
const kPackInfo = 0x06;
const kUnpackInfo = 0x07;
const kSubStreamsInfo = 0x08;
const kSize = 0x09;
const kCRC = 0x0a;
const kFolder = 0x0b;
const kCodersUnpackSize = 0x0c;
const kNumUnpackStream = 0x0d;
const kEmptyStream = 0x0e;
const kEmptyFile = 0x0f;
const kAnti = 0x10;
const kName = 0x11;
const kCTime = 0x12;
const kATime = 0x13;
const kMTime = 0x14;
const kWinAttributes = 0x15;
const kComment = 0x16;
const kEncodedHeader = 0x17;
const kStartPos = 0x18;
const kDummy = 0x19;

class StreamCursor {
  constructor(public readonly buf: Buffer, public pos = 0) {}

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  readByte(): number {
    if (this.pos >= this.buf.length) {
      throw new ConversionFailedError('Truncated 7z stream reading byte');
    }
    return this.buf[this.pos++];
  }

  readBytes(count: number): Buffer {
    if (this.pos + count > this.buf.length) {
      throw new ConversionFailedError(`Truncated 7z stream reading ${count} bytes`);
    }
    const res = this.buf.subarray(this.pos, this.pos + count);
    this.pos += count;
    return res;
  }

  readUInt32LE(): number {
    if (this.pos + 4 > this.buf.length) {
      throw new ConversionFailedError('Truncated 7z stream reading uint32');
    }
    const res = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return res;
  }

  readUInt64LE(): bigint {
    if (this.pos + 8 > this.buf.length) {
      throw new ConversionFailedError('Truncated 7z stream reading uint64');
    }
    const res = this.buf.readBigUInt64LE(this.pos);
    this.pos += 8;
    return res;
  }

  readVarint(): number {
    if (this.pos >= this.buf.length) {
      throw new ConversionFailedError('Truncated 7z stream reading varint');
    }
    const firstByte = this.buf[this.pos++];
    let mask = 0x80;
    let value = 0;
    for (let i = 0; i < 8; i++) {
      if ((firstByte & mask) === 0) {
        const highPart = firstByte & (mask - 1);
        value += highPart * Math.pow(2, i * 8);
        return value;
      }
      if (this.pos >= this.buf.length) {
        throw new ConversionFailedError('Truncated 7z stream within varint');
      }
      value += this.buf[this.pos++] * Math.pow(2, i * 8);
      mask >>= 1;
    }
    return value;
  }

  readBitVector(count: number): boolean[] {
    const bits: boolean[] = [];
    let curByte = 0;
    let mask = 0;
    for (let i = 0; i < count; i++) {
      if (mask === 0) {
        curByte = this.readByte();
        mask = 0x80;
      }
      bits.push((curByte & mask) !== 0);
      mask >>= 1;
    }
    return bits;
  }
}

interface CoderInfo {
  codecId: Buffer;
  numInStreams: number;
  numOutStreams: number;
  properties?: Buffer;
}

interface BindPair {
  inIndex: number;
  outIndex: number;
}

interface FolderInfo {
  coders: CoderInfo[];
  bindPairs: BindPair[];
  packedStreamIndices: number[];
  unpackSizes: number[];
  unpackCrc?: number;
  totalUnpackSize: number;
}

interface PackInfo {
  dataOffset: number;
  packSizes: number[];
  packCrcs?: (number | undefined)[];
}

interface StreamsInfo {
  packInfo: PackInfo;
  folders: FolderInfo[];
  folderSubstreams?: {
    numUnpackStreams: number[];
    unpackSizes: number[][];
    unpackCrcs?: (number | undefined)[][];
  };
}

interface FilesInfo {
  numFiles: number;
  names: string[];
  emptyStreams: boolean[];
  emptyFiles: boolean[];
  winAttributes?: (number | undefined)[];
}

/**
 * Parses a 7z StreamsInfo block (kPackInfo, kUnpackInfo, kSubStreamsInfo).
 */
function parseStreamsInfo(cursor: StreamCursor): StreamsInfo {
  let packInfo: PackInfo = { dataOffset: 0, packSizes: [] };
  let folders: FolderInfo[] = [];
  let folderSubstreams: StreamsInfo['folderSubstreams'];

  while (cursor.pos < cursor.buf.length) {
    const propId = cursor.readByte();
    if (propId === kEnd) break;

    if (propId === kPackInfo) {
      const dataOffset = cursor.readVarint();
      const numPackStreams = cursor.readVarint();
      const packSizes: number[] = [];
      let packCrcs: (number | undefined)[] | undefined;

      while (cursor.pos < cursor.buf.length) {
        const subId = cursor.readByte();
        if (subId === kEnd) break;
        if (subId === kSize) {
          for (let i = 0; i < numPackStreams; i++) {
            packSizes.push(cursor.readVarint());
          }
        } else if (subId === kCRC) {
          const allDefined = cursor.readByte() !== 0;
          const definedBits = allDefined ? [] : cursor.readBitVector(numPackStreams);
          packCrcs = [];
          for (let i = 0; i < numPackStreams; i++) {
            if (allDefined || definedBits[i]) {
              packCrcs.push(cursor.readUInt32LE());
            } else {
              packCrcs.push(undefined);
            }
          }
        } else {
          throw new ConversionFailedError(`Unexpected property 0x${subId.toString(16)} in PackInfo`);
        }
      }
      packInfo = { dataOffset, packSizes, packCrcs };
    } else if (propId === kUnpackInfo) {
      while (cursor.pos < cursor.buf.length) {
        const subId = cursor.readByte();
        if (subId === kEnd) break;

        if (subId === kFolder) {
          const numFolders = cursor.readVarint();
          const external = cursor.readByte();
          if (external !== 0) {
            throw new ConversionFailedError('External folders not supported');
          }

          folders = [];
          for (let f = 0; f < numFolders; f++) {
            const numCoders = cursor.readVarint();
            const coders: CoderInfo[] = [];
            let totalInStreams = 0;
            let totalOutStreams = 0;

            for (let c = 0; c < numCoders; c++) {
              const flags = cursor.readByte();
              const idSize = flags & 0x0f;
              const isComplex = (flags & 0x10) !== 0;
              const hasProps = (flags & 0x20) !== 0;
              const codecId = cursor.readBytes(idSize);

              let inStreams = 1;
              let outStreams = 1;
              if (isComplex) {
                inStreams = cursor.readVarint();
                outStreams = cursor.readVarint();
              }
              totalInStreams += inStreams;
              totalOutStreams += outStreams;

              let properties: Buffer | undefined;
              if (hasProps) {
                const propSize = cursor.readVarint();
                properties = cursor.readBytes(propSize);
              }

              coders.push({
                codecId,
                numInStreams: inStreams,
                numOutStreams: outStreams,
                properties,
              });
            }

            const numBindPairs = totalOutStreams - 1;
            const bindPairs: BindPair[] = [];
            for (let b = 0; b < numBindPairs; b++) {
              const inIndex = cursor.readVarint();
              const outIndex = cursor.readVarint();
              bindPairs.push({ inIndex, outIndex });
            }

            const numPackedStreams = totalInStreams - numBindPairs;
            const packedStreamIndices: number[] = [];
            if (numPackedStreams === 1) {
              for (let i = 0; i < totalInStreams; i++) {
                if (!bindPairs.some((p) => p.inIndex === i)) {
                  packedStreamIndices.push(i);
                  break;
                }
              }
            } else {
              for (let p = 0; p < numPackedStreams; p++) {
                packedStreamIndices.push(cursor.readVarint());
              }
            }

            folders.push({
              coders,
              bindPairs,
              packedStreamIndices,
              unpackSizes: [],
              totalUnpackSize: 0,
            });
          }
        } else if (subId === kCodersUnpackSize) {
          for (const folder of folders) {
            folder.unpackSizes = [];
            let folderTotal = 0;
            let totalOut = 0;
            for (const c of folder.coders) totalOut += c.numOutStreams;
            for (let i = 0; i < totalOut; i++) {
              const sz = cursor.readVarint();
              folder.unpackSizes.push(sz);
              folderTotal += sz;
            }
            folder.totalUnpackSize = folderTotal;
          }
        } else if (subId === kCRC) {
          const allDefined = cursor.readByte() !== 0;
          const definedBits = allDefined ? [] : cursor.readBitVector(folders.length);
          for (let i = 0; i < folders.length; i++) {
            if (allDefined || definedBits[i]) {
              folders[i].unpackCrc = cursor.readUInt32LE();
            }
          }
        } else {
          throw new ConversionFailedError(`Unexpected property 0x${subId.toString(16)} in UnpackInfo`);
        }
      }
    } else if (propId === kSubStreamsInfo) {
      const numUnpackStreams: number[] = new Array(folders.length).fill(1);
      const subSizes: number[][] = folders.map(() => []);
      let subCrcs: (number | undefined)[][] | undefined;

      while (cursor.pos < cursor.buf.length) {
        const subId = cursor.readByte();
        if (subId === kEnd) break;

        if (subId === kNumUnpackStream) {
          for (let f = 0; f < folders.length; f++) {
            numUnpackStreams[f] = cursor.readVarint();
          }
        } else if (subId === kSize) {
          for (let f = 0; f < folders.length; f++) {
            const count = numUnpackStreams[f];
            let sum = 0;
            for (let i = 0; i < count - 1; i++) {
              const sz = cursor.readVarint();
              subSizes[f].push(sz);
              sum += sz;
            }
            // The last stream gets the remainder of the folder's unpack size
            const unboundOutIndex = folderUnboundOutStream(folders[f]);
            const totalSz = folders[f].unpackSizes[unboundOutIndex] ?? folders[f].totalUnpackSize;
            subSizes[f].push(Math.max(0, totalSz - sum));
          }
        } else if (subId === kCRC) {
          let totalStreams = 0;
          for (let f = 0; f < folders.length; f++) {
            totalStreams += numUnpackStreams[f];
          }
          const allDefined = cursor.readByte() !== 0;
          const definedBits = allDefined ? [] : cursor.readBitVector(totalStreams);
          subCrcs = folders.map(() => []);
          let sIdx = 0;
          for (let f = 0; f < folders.length; f++) {
            const count = numUnpackStreams[f];
            for (let i = 0; i < count; i++) {
              if (allDefined || definedBits[sIdx]) {
                subCrcs[f].push(cursor.readUInt32LE());
              } else {
                subCrcs[f].push(undefined);
              }
              sIdx++;
            }
          }
        } else {
          throw new ConversionFailedError(`Unexpected property 0x${subId.toString(16)} in SubStreamsInfo`);
        }
      }

      // If sizes weren't explicitly provided, default to folder unpack size
      for (let f = 0; f < folders.length; f++) {
        if (subSizes[f].length === 0) {
          const unboundOutIndex = folderUnboundOutStream(folders[f]);
          subSizes[f].push(folders[f].unpackSizes[unboundOutIndex] ?? folders[f].totalUnpackSize);
        }
      }

      folderSubstreams = {
        numUnpackStreams,
        unpackSizes: subSizes,
        unpackCrcs: subCrcs,
      };
    } else {
      throw new ConversionFailedError(`Unexpected property 0x${propId.toString(16)} in StreamsInfo`);
    }
  }

  return { packInfo, folders, folderSubstreams };
}

function folderUnboundOutStream(folder: FolderInfo): number {
  let totalOut = 0;
  for (const c of folder.coders) totalOut += c.numOutStreams;
  for (let o = 0; o < totalOut; o++) {
    if (!folder.bindPairs.some((p) => p.outIndex === o)) {
      return o;
    }
  }
  return 0;
}

/**
 * Executes the coder graph for a 7z folder to produce the folder's decoded output.
 */
function decodeFolder(
  folder: FolderInfo,
  packStreamBuffers: Buffer[],
  options: Extract7zOptions
): Buffer {
  // Check bomb safeguard before decompression
  let totalOutStreams = 0;
  for (const c of folder.coders) totalOutStreams += c.numOutStreams;
  for (let i = 0; i < totalOutStreams; i++) {
    const sz = folder.unpackSizes[i] ?? 0;
    if (sz > ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
      throw new DecompressionLimitError(
        `7z stream declared size ${sz} exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE}`
      );
    }
  }

  // Calculate stream index offsets for each coder
  const coderInOffset: number[] = [];
  const coderOutOffset: number[] = [];
  let curIn = 0;
  let curOut = 0;
  for (const c of folder.coders) {
    coderInOffset.push(curIn);
    coderOutOffset.push(curOut);
    curIn += c.numInStreams;
    curOut += c.numOutStreams;
  }

  const inStreams: Map<number, Buffer> = new Map();
  const outStreams: Map<number, Buffer> = new Map();

  // Populate external input streams from pack streams
  for (let p = 0; p < folder.packedStreamIndices.length; p++) {
    const inIdx = folder.packedStreamIndices[p];
    const packBuf = packStreamBuffers[p];
    if (!packBuf) {
      throw new ConversionFailedError(`Missing packed stream ${p} for folder`);
    }
    inStreams.set(inIdx, packBuf);
  }

  const executedCoders = new Set<number>();

  while (executedCoders.size < folder.coders.length) {
    let progress = false;

    for (let c = 0; c < folder.coders.length; c++) {
      if (executedCoders.has(c)) continue;

      const coder = folder.coders[c];
      const startIn = coderInOffset[c];
      let ready = true;
      const inputBuffers: Buffer[] = [];

      for (let i = 0; i < coder.numInStreams; i++) {
        const inIdx = startIn + i;
        if (!inStreams.has(inIdx)) {
          ready = false;
          break;
        }
        inputBuffers.push(inStreams.get(inIdx)!);
      }

      if (!ready) continue;

      const startOut = coderOutOffset[c];
      const methodHex = methodIdToHex(coder.codecId);
      const outSize = folder.unpackSizes[startOut] ?? 0;

      let decodedOuts: Buffer[];

      if (methodHex === METHOD_COPY) {
        decodedOuts = [inputBuffers[0]];
      } else if (
        methodHex === METHOD_DEFLATE ||
        methodHex === METHOD_DEFLATE_ZIP ||
        methodHex === METHOD_DEFLATE_64
      ) {
        decodedOuts = [
          inflateBounded(inputBuffers[0], {
            label: '7z Deflate stream',
            format: 'raw',
            expectedLength: outSize || undefined,
            maxOutputLength: outSize || MAX_STREAM_INFLATE_BYTES,
          }),
        ];
      } else if (methodHex === METHOD_BZIP2) {
        decodedOuts = [
          decompressBzip2(inputBuffers[0], outSize || ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE),
        ];
      } else if (methodHex === METHOD_LZMA) {
        if (!coder.properties) throw new ConversionFailedError('Missing LZMA properties');
        decodedOuts = [decompressLzma(inputBuffers[0], coder.properties, outSize)];
      } else if (methodHex === METHOD_LZMA2) {
        decodedOuts = [decompressLzma2(inputBuffers[0], outSize)];
      } else if (methodHex === METHOD_DELTA) {
        decodedOuts = [decodeDelta(inputBuffers[0], coder.properties)];
      } else if (methodHex === METHOD_BCJ) {
        decodedOuts = [decodeBcj(inputBuffers[0])];
      } else if (methodHex === METHOD_ARM) {
        decodedOuts = [decodeArm(inputBuffers[0])];
      } else if (methodHex === METHOD_ARMT) {
        decodedOuts = [decodeArmt(inputBuffers[0])];
      } else if (methodHex === METHOD_ARM64 || methodHex === METHOD_ARM64_ALT) {
        decodedOuts = [decodeArm64(inputBuffers[0])];
      } else if (methodHex === METHOD_PPC) {
        decodedOuts = [decodePpc(inputBuffers[0])];
      } else if (methodHex === METHOD_SPARC) {
        decodedOuts = [decodeSparc(inputBuffers[0])];
      } else if (methodHex === METHOD_IA64) {
        decodedOuts = [decodeIa64(inputBuffers[0])];
      } else if (methodHex === METHOD_BCJ2) {
        if (inputBuffers.length < 4) {
          throw new ConversionFailedError('BCJ2 requires 4 input streams');
        }
        decodedOuts = [
          decodeBcj2(inputBuffers[0], inputBuffers[1], inputBuffers[2], inputBuffers[3], outSize),
        ];
      } else if (methodHex === METHOD_AES256) {
        decodedOuts = [
          decrypt7zAes(inputBuffers[0], coder.properties, options.password, outSize),
        ];
      } else {
        throw new UnsupportedOptionError(`Unsupported 7z compression method: 0x${methodHex}`);
      }

      for (let o = 0; o < coder.numOutStreams; o++) {
        const outIdx = startOut + o;
        const outBuf = decodedOuts[o];
        outStreams.set(outIdx, outBuf);

        // Feed any bind pairs waiting for this outStream
        for (const pair of folder.bindPairs) {
          if (pair.outIndex === outIdx) {
            inStreams.set(pair.inIndex, outBuf);
          }
        }
      }

      executedCoders.add(c);
      progress = true;
    }

    if (!progress) {
      throw new ConversionFailedError('Circular or unresolved dependencies in 7z coder pipeline');
    }
  }

  const finalOutIndex = folderUnboundOutStream(folder);
  const result = outStreams.get(finalOutIndex);
  if (!result) {
    throw new ConversionFailedError('Failed to produce unpacked folder stream');
  }

  if (folder.unpackCrc !== undefined && crc32(result) !== folder.unpackCrc) {
    throw new ConversionFailedError('Folder unpack CRC mismatch');
  }

  return result;
}

/**
 * Parses FilesInfo (kFilesInfo).
 */
function parseFilesInfo(cursor: StreamCursor): FilesInfo {
  const numFiles = cursor.readVarint();
  let emptyStreams: boolean[] = new Array(numFiles).fill(false);
  let emptyFiles: boolean[] = new Array(numFiles).fill(false);
  let names: string[] = [];
  let winAttributes: (number | undefined)[] | undefined;

  while (cursor.pos < cursor.buf.length) {
    const propId = cursor.readByte();
    if (propId === kEnd) break;

    const size = cursor.readVarint();

    if (propId === kEmptyStream) {
      emptyStreams = cursor.readBitVector(numFiles);
    } else if (propId === kEmptyFile) {
      const emptyCount = emptyStreams.filter(Boolean).length;
      const bits = cursor.readBitVector(emptyCount);
      let bitIdx = 0;
      emptyFiles = new Array(numFiles).fill(false);
      for (let i = 0; i < numFiles; i++) {
        if (emptyStreams[i]) {
          emptyFiles[i] = bits[bitIdx++];
        }
      }
    } else if (propId === kName) {
      const external = cursor.readByte();
      if (external !== 0) throw new ConversionFailedError('External file names not supported');
      names = [];
      for (let i = 0; i < numFiles; i++) {
        const chars: number[] = [];
        while (true) {
          if (cursor.remaining < 2) {
            throw new ConversionFailedError('Truncated 7z file name in header');
          }
          const codeUnit = cursor.buf.readUInt16LE(cursor.pos);
          cursor.pos += 2;
          if (codeUnit === 0) break;
          chars.push(codeUnit);
        }
        names.push(String.fromCharCode(...chars));
      }
    } else if (propId === kWinAttributes) {
      const allDefined = cursor.readByte() !== 0;
      const definedBits = allDefined ? [] : cursor.readBitVector(numFiles);
      winAttributes = [];
      for (let i = 0; i < numFiles; i++) {
        if (allDefined || definedBits[i]) {
          winAttributes.push(cursor.readUInt32LE());
        } else {
          winAttributes.push(undefined);
        }
      }
    } else {
      // Skip unknown or unneeded property
      cursor.readBytes(size);
    }
  }

  return {
    numFiles,
    names,
    emptyStreams,
    emptyFiles,
    winAttributes,
  };
}

/**
 * Extracts all files from a 7z archive.
 */
export function extract7zArchive(
  archiveBuffer: Buffer,
  options: Extract7zOptions = {}
): SevenZipFile[] {
  // Fail closed if not a 7z file or truncated before SignatureHeader
  if (archiveBuffer.length < 32) {
    return [];
  }

  for (let i = 0; i < 6; i++) {
    if (archiveBuffer[i] !== SEVENZIP_MAGIC[i]) {
      return [];
    }
  }

  // Verify StartHeader CRC
  const startHeaderCrc = archiveBuffer.readUInt32LE(8);
  const startHeaderData = archiveBuffer.subarray(12, 32);
  if (crc32(startHeaderData) !== startHeaderCrc) {
    throw new ConversionFailedError('Corrupted 7z archive: StartHeader CRC mismatch');
  }

  const nextHeaderOffset = archiveBuffer.readBigUInt64LE(12);
  const nextHeaderSize = archiveBuffer.readBigUInt64LE(20);
  const nextHeaderCrc = archiveBuffer.readUInt32LE(28);

  const nhStart = 32 + Number(nextHeaderOffset);
  const nhEnd = nhStart + Number(nextHeaderSize);

  if (nhStart < 32 || nhEnd > archiveBuffer.length || nextHeaderSize < 0n) {
    throw new ConversionFailedError('Truncated 7z archive: NextHeader extends beyond buffer');
  }

  const nextHeaderBuf = archiveBuffer.subarray(nhStart, nhEnd);
  if (nextHeaderSize > 0n && crc32(nextHeaderBuf) !== nextHeaderCrc) {
    throw new ConversionFailedError('Corrupted 7z archive: NextHeader CRC mismatch');
  }

  let headerBuf = nextHeaderBuf;

  // Handle kEncodedHeader
  if (headerBuf.length > 0 && headerBuf[0] === kEncodedHeader) {
    const encCursor = new StreamCursor(headerBuf, 1);
    const streamsInfo = parseStreamsInfo(encCursor);

    if (streamsInfo.folders.length === 0) {
      throw new ConversionFailedError('Corrupted 7z encoded header: no folders');
    }

    // Build pack stream slices from archive buffer
    let packOffset = 32 + streamsInfo.packInfo.dataOffset;
    const packSlices: Buffer[] = [];
    for (const sz of streamsInfo.packInfo.packSizes) {
      if (packOffset + sz > archiveBuffer.length) {
        throw new ConversionFailedError('Truncated 7z archive in encoded header pack stream');
      }
      packSlices.push(archiveBuffer.subarray(packOffset, packOffset + sz));
      packOffset += sz;
    }

    headerBuf = decodeFolder(streamsInfo.folders[0], packSlices, options);
  }

  if (headerBuf.length === 0) {
    return [];
  }

  // Parse Header (kHeader)
  const cursor = new StreamCursor(headerBuf);
  const firstByte = cursor.readByte();
  if (firstByte !== kHeader) {
    throw new ConversionFailedError(`Expected kHeader (0x01) but found 0x${firstByte.toString(16)}`);
  }

  let streamsInfo: StreamsInfo | undefined;
  let filesInfo: FilesInfo | undefined;

  while (cursor.pos < cursor.buf.length) {
    const propId = cursor.readByte();
    if (propId === kEnd) break;

    if (propId === kMainStreamsInfo) {
      streamsInfo = parseStreamsInfo(cursor);
    } else if (propId === kFilesInfo) {
      filesInfo = parseFilesInfo(cursor);
    } else {
      // Skip unsupported top-level property
      const sz = cursor.readVarint();
      cursor.readBytes(sz);
    }
  }

  if (!filesInfo || filesInfo.numFiles === 0) {
    return [];
  }

  // Unpack folder substreams if present
  const substreamPayloads: Buffer[] = [];

  if (streamsInfo && streamsInfo.folders.length > 0) {
    let globalPackPos = 32 + streamsInfo.packInfo.dataOffset;
    let packIdx = 0;

    for (let f = 0; f < streamsInfo.folders.length; f++) {
      const folder = streamsInfo.folders[f];
      const folderPackSlices: Buffer[] = [];

      for (let p = 0; p < folder.packedStreamIndices.length; p++) {
        const sz = streamsInfo.packInfo.packSizes[packIdx++];
        if (sz === undefined || globalPackPos + sz > archiveBuffer.length) {
          throw new ConversionFailedError('Truncated 7z archive packed stream');
        }
        folderPackSlices.push(archiveBuffer.subarray(globalPackPos, globalPackPos + sz));
        globalPackPos += sz;
      }

      const decompressed = decodeFolder(folder, folderPackSlices, options);

      // Distribute decompressed folder data into substreams
      const subSizes = streamsInfo.folderSubstreams?.unpackSizes[f] ?? [decompressed.length];
      const subCrcs = streamsInfo.folderSubstreams?.unpackCrcs?.[f];

      let offset = 0;
      for (let s = 0; s < subSizes.length; s++) {
        const sz = subSizes[s];
        if (offset + sz > decompressed.length) {
          throw new ConversionFailedError('Folder substream exceeds decoded data length');
        }
        const slice = decompressed.subarray(offset, offset + sz);
        offset += sz;

        if (subCrcs && subCrcs[s] !== undefined && crc32(slice) !== subCrcs[s]) {
          throw new ConversionFailedError('7z substream CRC mismatch');
        }

        substreamPayloads.push(slice);
      }
    }
  }

  // Map substream payloads to files
  const files: SevenZipFile[] = [];
  let substreamIdx = 0;
  let totalExtractedSize = 0;

  for (let i = 0; i < filesInfo.numFiles; i++) {
    if (files.length >= ARCHIVE_SECURITY_LIMITS.MAX_FILES) {
      throw new DecompressionLimitError(
        `Archive bomb detected: file count exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_FILES}`
      );
    }

    const rawName = filesInfo.names[i] || `file_${i}`;
    const sanitizedName = sanitizeArchivePath(rawName);
    if (!sanitizedName) continue;

    const isEmptyStream = filesInfo.emptyStreams[i];
    let fileBuf: Buffer;

    if (isEmptyStream) {
      fileBuf = Buffer.alloc(0);
    } else {
      if (substreamIdx >= substreamPayloads.length) {
        throw new ConversionFailedError(`Missing stream for file '${sanitizedName}'`);
      }
      fileBuf = substreamPayloads[substreamIdx++];
    }

    totalExtractedSize += fileBuf.length;
    if (totalExtractedSize > ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
      throw new DecompressionLimitError(
        `Archive bomb detected: uncompressed size exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes`
      );
    }

    files.push({
      filename: sanitizedName,
      buffer: fileBuf,
    });
  }

  if (options.entries && options.entries.length > 0) {
    return files.filter((f) => matchArchiveGlob(f.filename, options.entries));
  }

  return files;
}
