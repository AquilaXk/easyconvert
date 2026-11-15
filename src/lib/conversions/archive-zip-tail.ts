import fs from 'node:fs';
import { DecompressionLimitError, UnsupportedArchiveMethodError } from '../types';
import { UnsafeArchiveError } from './archive-extraction-safety';

const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE_BYTES = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const ZIP64_END_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const DIGITAL_SIGNATURE_RECORD = 0x05054b50;

const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;
const MAX_END_COMMENT_BYTES = 0xffff;
const ZIP64_LOCATOR_BYTES = 20;
const ZIP64_END_FIXED_BYTES = 56;
const EXTRA_HEADER_BYTES = 4;
const EXTRA_ZIP64 = 0x0001;
const MAX_U32 = 0xffffffff;

/** Cap on central-directory bytes read into memory when inspecting declared uncompressed sizes. */
const MAX_TAIL_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;
const INITIAL_TAIL_WINDOW_BYTES =
  END_RECORD_BYTES + MAX_END_COMMENT_BYTES + ZIP64_LOCATOR_BYTES + ZIP64_END_FIXED_BYTES + 4096;

interface TailWindow {
  fd: number;
  tail: Buffer;
  tailOffset: number;
}

interface DirectoryBounds {
  entryCount: number;
  directorySize: number;
  directoryStart: number;
}

function malformed(message: string): UnsafeArchiveError {
  return new UnsafeArchiveError('malformed-listing', message);
}

function readExactSlice(fd: number, offset: number, length: number): Buffer {
  const out = Buffer.allocUnsafe(length);
  let readTotal = 0;
  while (readTotal < length) {
    const n = fs.readSync(fd, out, readTotal, length - readTotal, offset + readTotal);
    if (n <= 0) {
      throw malformed('Unexpected end of ZIP file while reading central directory');
    }
    readTotal += n;
  }
  return out;
}

function readWindowedSlice(win: TailWindow, fileOffset: number, length: number): Buffer {
  if (fileOffset >= win.tailOffset) {
    const relStart = fileOffset - win.tailOffset;
    return win.tail.subarray(relStart, relStart + length);
  }
  return readExactSlice(win.fd, fileOffset, length);
}

function toSafeNum(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw malformed(`Malformed ZIP archive: ${label} exceeds safe integer range`);
  }
  return Number(value);
}

function readZip64UncompressedSize(buf: Buffer, extraStart: number, extraEnd: number): number {
  let pos = extraStart;
  while (pos + EXTRA_HEADER_BYTES <= extraEnd) {
    const id = buf.readUInt16LE(pos);
    const size = buf.readUInt16LE(pos + 2);
    const bodyStart = pos + EXTRA_HEADER_BYTES;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > extraEnd) {
      throw malformed('Malformed ZIP archive: central directory extra field overruns entry');
    }
    if (id === EXTRA_ZIP64) {
      if (size < 8) {
        throw malformed('Malformed ZIP archive: truncated ZIP64 extended size field');
      }
      const big = buf.readBigUInt64LE(bodyStart);
      return big > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(big);
    }
    pos = bodyEnd;
  }
  throw malformed('Malformed ZIP archive: saturated uncompressed size without ZIP64 extra field');
}

function isPlausibleEocd(tail: Buffer, tailFileOffset: number, pos: number): boolean {
  if (pos >= ZIP64_LOCATOR_BYTES && tail.readUInt32LE(pos - ZIP64_LOCATOR_BYTES) === ZIP64_LOCATOR_SIGNATURE) {
    return true;
  }
  const entries = tail.readUInt16LE(pos + 10);
  const size = tail.readUInt32LE(pos + 12);
  if (size === 0) return entries === 0;
  if (entries === 0 || size > tailFileOffset + pos) return false;
  return pos >= size ? tail.readUInt32LE(pos - size) === CENTRAL_SIGNATURE : true;
}

function locateEocdInTail(tail: Buffer, tailFileOffset: number): number {
  const minPos = Math.max(0, tail.length - END_RECORD_BYTES - MAX_END_COMMENT_BYTES);
  const candidates: Array<{ pos: number; end: number }> = [];
  let at = tail.lastIndexOf(END_SIGNATURE_BYTES, tail.length - END_RECORD_BYTES);
  while (at >= minPos) {
    const end = at + END_RECORD_BYTES + tail.readUInt16LE(at + 20);
    if (end <= tail.length) candidates.push({ pos: at, end });
    if (at === 0) break;
    at = tail.lastIndexOf(END_SIGNATURE_BYTES, at - 1);
  }
  if (candidates.length === 0) {
    throw malformed('Malformed ZIP archive: end of central directory record not found');
  }
  candidates.reverse();
  const plausible = candidates.filter(({ pos }) => isPlausibleEocd(tail, tailFileOffset, pos));
  const pool = plausible.length > 0 ? plausible : candidates;
  let reach = -1;
  for (const c of pool) {
    if (c.pos < reach) {
      throw malformed('Malformed ZIP archive: ambiguous end of central directory records');
    }
    reach = Math.max(reach, c.end);
  }
  const ending = pool.filter((c) => c.end === tail.length);
  return (ending.length > 0 ? ending[ending.length - 1] : pool[pool.length - 1]).pos;
}

function resolveZip64DirectoryBounds(
  win: TailWindow,
  locatorBuf: Buffer,
  locatorFileOffset: number
): { entryCount: number; directorySize: number; directoryEnd: number } {
  if (locatorBuf.readUInt32LE(4) !== 0 || locatorBuf.readUInt32LE(16) > 1) {
    throw new UnsupportedArchiveMethodError('Multi-disk ZIP archives are not supported.');
  }
  const declaredRecordOffset = toSafeNum(locatorBuf.readBigUInt64LE(8), 'ZIP64 end record offset');
  let zip64Buf: Buffer | null = null;
  let zip64FileOffset = -1;
  for (const candidate of [declaredRecordOffset, locatorFileOffset - ZIP64_END_FIXED_BYTES]) {
    if (candidate < 0 || candidate + ZIP64_END_FIXED_BYTES > locatorFileOffset) continue;
    const hdr = readWindowedSlice(win, candidate, ZIP64_END_FIXED_BYTES);
    if (hdr.readUInt32LE(0) !== ZIP64_END_SIGNATURE) continue;
    const recordSize = toSafeNum(hdr.readBigUInt64LE(4), 'ZIP64 end record size');
    if (candidate + 12 + recordSize === locatorFileOffset) {
      zip64Buf = hdr;
      zip64FileOffset = candidate;
      break;
    }
  }
  if (!zip64Buf || zip64FileOffset < 0) {
    throw malformed('Malformed ZIP archive: missing ZIP64 end record');
  }
  if ((zip64Buf.readUInt32LE(16) | zip64Buf.readUInt32LE(20)) !== 0) {
    throw new UnsupportedArchiveMethodError('Multi-disk ZIP archives are not supported.');
  }
  const zip64OnDisk = toSafeNum(zip64Buf.readBigUInt64LE(24), 'ZIP64 entry count');
  const zip64Count = toSafeNum(zip64Buf.readBigUInt64LE(32), 'ZIP64 entry count');
  if (zip64OnDisk !== zip64Count) {
    throw new UnsupportedArchiveMethodError('Multi-disk ZIP archives are not supported.');
  }
  return {
    entryCount: zip64Count,
    directorySize: toSafeNum(zip64Buf.readBigUInt64LE(40), 'ZIP64 central directory size'),
    directoryEnd: zip64FileOffset,
  };
}

function readCentralDirectoryBounds(win: TailWindow, eocdInTail: number, maxFiles: number): DirectoryBounds {
  const eocdFileOffset = win.tailOffset + eocdInTail;
  const disk = win.tail.readUInt16LE(eocdInTail + 4);
  const dirDisk = win.tail.readUInt16LE(eocdInTail + 6);
  const entriesOnDisk = win.tail.readUInt16LE(eocdInTail + 8);
  let entryCount = win.tail.readUInt16LE(eocdInTail + 10);
  let directorySize = win.tail.readUInt32LE(eocdInTail + 12);
  let directoryEnd = eocdFileOffset;

  const locatorFileOffset = eocdFileOffset - ZIP64_LOCATOR_BYTES;
  const locatorBuf = locatorFileOffset >= 0 ? readWindowedSlice(win, locatorFileOffset, ZIP64_LOCATOR_BYTES) : null;
  if (locatorBuf !== null && locatorBuf.readUInt32LE(0) === ZIP64_LOCATOR_SIGNATURE) {
    const zip64Bounds = resolveZip64DirectoryBounds(win, locatorBuf, locatorFileOffset);
    entryCount = zip64Bounds.entryCount;
    directorySize = zip64Bounds.directorySize;
    directoryEnd = zip64Bounds.directoryEnd;
  } else if (entryCount !== entriesOnDisk || (disk | dirDisk) !== 0) {
    throw new UnsupportedArchiveMethodError('Multi-disk ZIP archives are not supported.');
  }

  if (entryCount > maxFiles) {
    throw new DecompressionLimitError(`Archive bomb detected: file count (${entryCount}) exceeds limit of ${maxFiles}`);
  }
  if (directorySize > MAX_TAIL_CENTRAL_DIRECTORY_BYTES) {
    throw new DecompressionLimitError(
      `Archive central directory (${directorySize} bytes) exceeds limit of ${MAX_TAIL_CENTRAL_DIRECTORY_BYTES}`
    );
  }
  if (directorySize > directoryEnd || entryCount * CENTRAL_HEADER_BYTES > directorySize) {
    throw malformed('Malformed ZIP archive: central directory exceeds archive bounds');
  }
  return {
    entryCount,
    directorySize,
    directoryStart: directoryEnd - directorySize,
  };
}

function sumCentralDirectoryUncompressedSizes(dirBuf: Buffer, entryCount: number, directorySize: number): number {
  let totalUncompressed = 0;
  let at = 0;
  for (let i = 0; i < entryCount; i++) {
    if (at + CENTRAL_HEADER_BYTES > directorySize || dirBuf.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
      throw malformed('Malformed ZIP archive: damaged central directory entry');
    }
    let uncompressedSize = dirBuf.readUInt32LE(at + 24);
    const nameLen = dirBuf.readUInt16LE(at + 28);
    const extraLen = dirBuf.readUInt16LE(at + 30);
    const commentLen = dirBuf.readUInt16LE(at + 32);
    const extraStart = at + CENTRAL_HEADER_BYTES + nameLen;
    const next = extraStart + extraLen + commentLen;
    if (next > directorySize) {
      throw malformed('Malformed ZIP archive: central directory entry overruns directory');
    }
    if (uncompressedSize === MAX_U32) {
      uncompressedSize = readZip64UncompressedSize(dirBuf, extraStart, extraStart + extraLen);
    }
    totalUncompressed += uncompressedSize;
    at = next;
  }
  const rest = directorySize - at;
  if (rest !== 0 && (rest < 4 || dirBuf.readUInt32LE(at) !== DIGITAL_SIGNATURE_RECORD)) {
    throw malformed('Malformed ZIP archive: trailing bytes in central directory');
  }
  return totalUncompressed;
}

/**
 * Sums the uncompressed byte sizes declared in a ZIP archive's Central Directory by reading only the tail EOCD and
 * Central Directory slices from `filePath`, avoiding full-file heap allocation for multi-hundred-MB OOXML/ODF packages.
 */
export function readZipUncompressedTotalFromFile(
  filePath: string,
  fileBytes: number,
  maxFiles: number = Number.MAX_SAFE_INTEGER
): number {
  if (fileBytes < END_RECORD_BYTES) {
    throw malformed('Malformed ZIP archive: file is smaller than EOCD record');
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const tailLen = Math.min(fileBytes, INITIAL_TAIL_WINDOW_BYTES);
    const tailOffset = fileBytes - tailLen;
    const tail = readExactSlice(fd, tailOffset, tailLen);
    const win: TailWindow = { fd, tail, tailOffset };
    const eocdInTail = locateEocdInTail(tail, tailOffset);
    const bounds = readCentralDirectoryBounds(win, eocdInTail, maxFiles);
    const dirBuf = readWindowedSlice(win, bounds.directoryStart, bounds.directorySize);
    return sumCentralDirectoryUncompressedSizes(dirBuf, bounds.entryCount, bounds.directorySize);
  } finally {
    fs.closeSync(fd);
  }
}
