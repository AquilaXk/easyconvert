import zlib from 'node:zlib';
import {
  ArchivePasswordRequiredError,
  CorruptStreamError,
  DecompressionLimitError,
  UnsupportedArchiveMethodError,
} from '../types';
import {
  assertSafeArchiveEntryName,
  assertSafeArchiveListing,
  UnsafeArchiveError,
  type ArchiveExtractionLimits,
  type ListedArchiveEntry,
} from './archive-extraction-safety';
import { crc32 } from './crc32';

/**
 * Reads a ZIP archive from its central directory (PKWARE APPNOTE 6.3.x) and fails closed. The central directory is
 * the one authority for names, sizes, methods and offsets; every local file header is then checked against it and
 * the entries' byte ranges are checked against each other, because the known ZIP attacks all rely on two readers
 * trusting different records:
 *
 *  - a name, method, flag or size that differs between the local header and the central directory;
 *  - several central records that share bytes (the "non-recursive" bomb), or data that runs into the next header;
 *  - a second end-of-central-directory record hidden in the comment, which makes two readers list different files;
 *  - ZIP64 fields that are saturated without an extra field, or that point outside the archive;
 *  - sizes that the data does not have (checked while inflating, with the output capped at the declared size).
 *
 * Names are validated, never repaired: a name that leaves the extraction root throws. Duplicate names are kept, each
 * with its own bytes, for the caller's collision policy. Symbolic links are refused or, on request, reported and
 * left out. Only stored (0) and deflated (8) entries are decoded; any other method is a 422, and an encrypted entry
 * asks for a password.
 */

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const ZIP64_END_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const DIGITAL_SIGNATURE_RECORD = 0x05054b50;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;
const ZIP64_END_FIXED_BYTES = 56;
const ZIP64_LOCATOR_BYTES = 20;
const MAX_END_COMMENT_BYTES = 0xffff;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;
const FLAG_CENTRAL_ENCRYPTED = 0x2000;
/** Flag bits that change how the data is read; the local and central copies must agree on them. */
const FLAGS_THAT_MUST_AGREE = FLAG_ENCRYPTED | FLAG_DESCRIPTOR | FLAG_STRONG_ENCRYPTION | FLAG_UTF8;
const ENCRYPTION_FLAGS = FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION | FLAG_CENTRAL_ENCRYPTED;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const METHOD_AES = 99;

const EXTRA_ZIP64 = 0x0001;
const EXTRA_UNICODE_PATH = 0x7075;
const EXTRA_HEADER_BYTES = 4;
const ZIP64_FIELD_BYTES = 8;

const UNIX_MODE_SHIFT = 16;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;
const DOS_DIRECTORY_ATTRIBUTE = 0x10;
const DIRECTORY_SUFFIX = '/';

const METHOD_NAMES = new Map<number, string>([
  [1, 'shrink'], [6, 'implode'], [9, 'deflate64'], [12, 'bzip2'], [14, 'LZMA'], [93, 'Zstandard'], [95, 'XZ'], [98, 'PPMd'],
]);

export interface ZipDirectoryEntry {
  /** Name bytes exactly as stored in the central directory. */
  rawName: Buffer;
  /** The name as text: UTF-8, or the Info-ZIP Unicode path field when it matches the stored name. */
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Offset of the local file header in the buffer (the central directory's offset shifted by any prefix). */
  localOffset: number;
  externalAttributes: number;
  isEncrypted: boolean;
}

export interface ZipDirectory {
  entries: ZipDirectoryEntry[];
  /** Offset of the first byte of the central directory; no entry's bytes may reach it. */
  directoryStart: number;
}

function malformed(detail: string): CorruptStreamError {
  return new CorruptStreamError(`Invalid ZIP archive: ${detail}`);
}

function toSafeNumber(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw malformed(`${what} does not fit in the archive`);
  return Number(value);
}

interface EndRecord {
  position: number;
  entryCount: number;
  directorySize: number;
  directoryOffset: number;
  usesZip64: boolean;
  /** Where the central directory must end: at the ZIP64 end record when there is one, else at the end record. */
  directoryEnd: number;
}

/** The one end-of-central-directory record of the archive; two candidates are ambiguous and refused. */
function findEndRecord(buf: Buffer): number {
  const windowStart = Math.max(0, buf.length - END_RECORD_BYTES - MAX_END_COMMENT_BYTES);
  const exact: number[] = [];
  const loose: number[] = [];
  let at = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]), buf.length - END_RECORD_BYTES);
  while (at >= windowStart) {
    const commentLength = buf.readUInt16LE(at + 20);
    const end = at + END_RECORD_BYTES + commentLength;
    if (end === buf.length) exact.push(at);
    else if (end < buf.length) loose.push(at);
    if (at === 0) break;
    at = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]), at - 1);
  }
  const candidates = exact.length > 0 ? exact : loose;
  if (candidates.length === 0) throw malformed('end of central directory record not found');
  if (candidates.length > 1) throw malformed('more than one end of central directory record; the archive is ambiguous');
  return candidates[0];
}

function readEndRecord(buf: Buffer): EndRecord {
  if (buf.length < END_RECORD_BYTES) throw malformed('the file is too small to be a ZIP archive');
  const position = findEndRecord(buf);
  const disk = buf.readUInt16LE(position + 4);
  const directoryDisk = buf.readUInt16LE(position + 6);
  let entryCount = buf.readUInt16LE(position + 10);
  const entriesOnDisk = buf.readUInt16LE(position + 8);
  let directorySize = buf.readUInt32LE(position + 12);
  let directoryOffset = buf.readUInt32LE(position + 16);
  const saturated = entryCount === MAX_U16 || entriesOnDisk === MAX_U16 || directorySize === MAX_U32 || directoryOffset === MAX_U32 || disk === MAX_U16 || directoryDisk === MAX_U16;
  let directoryEnd = position;

  const locatorAt = position - ZIP64_LOCATOR_BYTES;
  const hasLocator = locatorAt >= 0 && buf.readUInt32LE(locatorAt) === ZIP64_LOCATOR_SIGNATURE;
  if (saturated && !hasLocator) throw malformed('the end record is saturated but no ZIP64 end record locator precedes it');
  let zip64Disks = 0;
  if (hasLocator) {
    const recordOffset = toSafeNumber(buf.readBigUInt64LE(locatorAt + 8), 'the ZIP64 end record offset');
    const totalDisks = buf.readUInt32LE(locatorAt + 16);
    if (buf.readUInt32LE(locatorAt + 4) !== 0 || totalDisks > 1) throw new UnsupportedArchiveMethodError('Multi-disk ZIP archives are not supported.');
    // The record sits right before its locator; an archive with a prefix shifts the recorded offset by the prefix size.
    let recordAt = -1;
    for (const candidate of [recordOffset, locatorAt - ZIP64_END_FIXED_BYTES]) {
      if (candidate < 0 || candidate + ZIP64_END_FIXED_BYTES > locatorAt) continue;
      if (buf.readUInt32LE(candidate) !== ZIP64_END_SIGNATURE) continue;
      const recordSize = toSafeNumber(buf.readBigUInt64LE(candidate + 4), 'the ZIP64 end record size');
      if (candidate + 12 + recordSize === locatorAt) {
        recordAt = candidate;
        break;
      }
    }
    if (recordAt < 0) throw malformed('the ZIP64 end record is missing or does not end at its locator');
    zip64Disks = buf.readUInt32LE(recordAt + 16) | buf.readUInt32LE(recordAt + 20);
    const zip64Count = toSafeNumber(buf.readBigUInt64LE(recordAt + 32), 'the entry count');
    const zip64OnDisk = toSafeNumber(buf.readBigUInt64LE(recordAt + 24), 'the entry count');
    const zip64Size = toSafeNumber(buf.readBigUInt64LE(recordAt + 40), 'the central directory size');
    const zip64Offset = toSafeNumber(buf.readBigUInt64LE(recordAt + 48), 'the central directory offset');
    if (zip64OnDisk !== zip64Count) throw new UnsupportedArchiveMethodError('Multi-disk ZIP archives are not supported.');
    // A field the end record does not saturate must say the same as the ZIP64 record.
    if (entryCount !== MAX_U16 && entryCount !== zip64Count) throw malformed('the end records disagree on the entry count');
    if (directorySize !== MAX_U32 && directorySize !== zip64Size) throw malformed('the end records disagree on the central directory size');
    if (directoryOffset !== MAX_U32 && directoryOffset !== zip64Offset) throw malformed('the end records disagree on the central directory offset');
    entryCount = zip64Count;
    directorySize = zip64Size;
    directoryOffset = zip64Offset;
    directoryEnd = recordAt;
  } else if (entryCount !== entriesOnDisk) {
    throw new UnsupportedArchiveMethodError('Multi-disk ZIP archives are not supported.');
  }
  if (!hasLocator && (disk | directoryDisk) !== 0) throw new UnsupportedArchiveMethodError('Multi-disk ZIP archives are not supported.');
  if (hasLocator && (zip64Disks !== 0 || (disk !== 0 && disk !== MAX_U16) || (directoryDisk !== 0 && directoryDisk !== MAX_U16))) {
    throw new UnsupportedArchiveMethodError('Multi-disk ZIP archives are not supported.');
  }
  return { position, entryCount, directorySize, directoryOffset, usesZip64: hasLocator, directoryEnd };
}

interface ExtraField {
  id: number;
  start: number;
  end: number;
}

/** The extra fields of `buf[start, end)`, or null when the chain does not parse (a field overruns the block). */
function parseExtraFields(buf: Buffer, start: number, end: number): ExtraField[] | null {
  const fields: ExtraField[] = [];
  let pos = start;
  while (pos < end) {
    if (pos + EXTRA_HEADER_BYTES > end) return null;
    const size = buf.readUInt16LE(pos + 2);
    const bodyStart = pos + EXTRA_HEADER_BYTES;
    if (bodyStart + size > end) return null;
    fields.push({ id: buf.readUInt16LE(pos), start: bodyStart, end: bodyStart + size });
    pos = bodyStart + size;
  }
  return fields;
}

function zip64Field(fields: ExtraField[] | null, what: string): ExtraField {
  const matches = (fields ?? []).filter((field) => field.id === EXTRA_ZIP64);
  if (matches.length !== 1) throw malformed(`${what} is saturated but the ZIP64 extra field is ${matches.length === 0 ? 'missing' : 'repeated'}`);
  return matches[0];
}

/** The Info-ZIP Unicode path (0x7075) when its checksum matches the stored name bytes, else null. */
function unicodePathOf(buf: Buffer, fields: ExtraField[] | null, rawName: Buffer): string | null {
  const field = (fields ?? []).find((candidate) => candidate.id === EXTRA_UNICODE_PATH);
  if (!field || field.end - field.start < 5 || buf[field.start] !== 1) return null;
  if (buf.readUInt32LE(field.start + 1) !== crc32(rawName)) return null;
  return buf.toString('utf8', field.start + 5, field.end);
}

function parseCentralEntry(buf: Buffer, at: number, directoryEnd: number): { entry: ZipDirectoryEntry; next: number; storedOffset: number } {
  if (at + CENTRAL_HEADER_BYTES > directoryEnd || buf.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
    throw malformed('a central directory record is missing or damaged');
  }
  const flags = buf.readUInt16LE(at + 8);
  const method = buf.readUInt16LE(at + 10);
  const crc = buf.readUInt32LE(at + 16);
  let compressedSize = buf.readUInt32LE(at + 20);
  let uncompressedSize = buf.readUInt32LE(at + 24);
  const nameLength = buf.readUInt16LE(at + 28);
  const extraLength = buf.readUInt16LE(at + 30);
  const commentLength = buf.readUInt16LE(at + 32);
  let diskStart = buf.readUInt16LE(at + 34);
  const externalAttributes = buf.readUInt32LE(at + 38);
  let storedOffset = buf.readUInt32LE(at + 42);
  const nameStart = at + CENTRAL_HEADER_BYTES;
  const extraStart = nameStart + nameLength;
  const next = extraStart + extraLength + commentLength;
  if (next > directoryEnd) throw malformed('a central directory record runs past the directory');

  const fields = parseExtraFields(buf, extraStart, extraStart + extraLength);
  const needsZip64 = uncompressedSize === MAX_U32 || compressedSize === MAX_U32 || storedOffset === MAX_U32 || diskStart === MAX_U16;
  if (needsZip64) {
    const field = zip64Field(fields, 'a size or offset');
    let cursor = field.start;
    const take = (what: string): bigint => {
      if (cursor + ZIP64_FIELD_BYTES > field.end) throw malformed(`the ZIP64 extra field is too short for the ${what}`);
      const value = buf.readBigUInt64LE(cursor);
      cursor += ZIP64_FIELD_BYTES;
      return value;
    };
    if (uncompressedSize === MAX_U32) {
      const big = take('uncompressed size');
      // A size past what a JavaScript number holds is far over any cap; the caller turns it into a 413.
      uncompressedSize = big > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(big);
    }
    if (compressedSize === MAX_U32) compressedSize = toSafeNumber(take('compressed size'), 'the compressed size');
    if (storedOffset === MAX_U32) storedOffset = toSafeNumber(take('local header offset'), 'the local header offset');
    if (diskStart === MAX_U16) diskStart = Number(take('disk number') & 0xffffffffn);
  }
  if (diskStart !== 0) throw new UnsupportedArchiveMethodError('Multi-disk ZIP archives are not supported.');

  const rawName = Buffer.from(buf.subarray(nameStart, extraStart));
  let name = buf.toString('utf8', nameStart, extraStart);
  if ((flags & FLAG_UTF8) === 0) name = unicodePathOf(buf, fields, rawName) ?? name;
  const entry: ZipDirectoryEntry = {
    rawName,
    name,
    flags,
    method,
    crc,
    compressedSize,
    uncompressedSize,
    localOffset: storedOffset,
    externalAttributes,
    isEncrypted: (flags & ENCRYPTION_FLAGS) !== 0 || method === METHOD_AES,
  };
  return { entry, next, storedOffset };
}

/** Parses the end records and the central directory. Structure only: names and sizes are judged by the caller. */
export function readZipDirectory(buf: Buffer, limits: Pick<ArchiveExtractionLimits, 'MAX_FILES'>): ZipDirectory {
  const end = readEndRecord(buf);
  if (end.entryCount > limits.MAX_FILES) {
    throw new DecompressionLimitError(`Archive bomb detected: file count (${end.entryCount}) exceeds limit of ${limits.MAX_FILES}`);
  }
  if (end.directorySize > end.directoryEnd || end.entryCount * CENTRAL_HEADER_BYTES > end.directorySize) {
    throw malformed('the central directory does not fit the archive');
  }
  // The directory ends where the end records begin, so a prefix (a self-extractor stub) shows as a positive shift.
  const directoryStart = end.directoryEnd - end.directorySize;
  const shift = directoryStart - end.directoryOffset;
  if (shift < 0) throw malformed('the central directory offset lies beyond the directory');

  const entries: ZipDirectoryEntry[] = [];
  let at = directoryStart;
  for (let index = 0; index < end.entryCount; index++) {
    const parsed = parseCentralEntry(buf, at, end.directoryEnd);
    parsed.entry.localOffset = parsed.storedOffset + shift;
    entries.push(parsed.entry);
    at = parsed.next;
  }
  const rest = end.directoryEnd - at;
  if (rest !== 0 && (rest < 4 || buf.readUInt32LE(at) !== DIGITAL_SIGNATURE_RECORD)) {
    throw malformed('the central directory holds more data than the end record counts');
  }
  return { entries, directoryStart };
}

interface EntryData {
  start: number;
  end: number;
}

/** Checks the entry's local header against its central record and returns the byte range of its data. */
function locateEntryData(buf: Buffer, entry: ZipDirectoryEntry, directoryStart: number): EntryData & { headerStart: number } {
  const at = entry.localOffset;
  if (at + LOCAL_HEADER_BYTES > directoryStart || buf.readUInt32LE(at) !== LOCAL_SIGNATURE) {
    throw malformed(`the local header of '${entry.name}' is missing where the central directory places it`);
  }
  const flags = buf.readUInt16LE(at + 6);
  const method = buf.readUInt16LE(at + 8);
  const nameLength = buf.readUInt16LE(at + 26);
  const extraLength = buf.readUInt16LE(at + 28);
  const nameStart = at + LOCAL_HEADER_BYTES;
  const dataStart = nameStart + nameLength + extraLength;
  if (dataStart > directoryStart) throw malformed(`the local header of '${entry.name}' runs into the central directory`);
  if (nameLength !== entry.rawName.length || !buf.subarray(nameStart, nameStart + nameLength).equals(entry.rawName)) {
    throw malformed(`the local header of '${entry.name}' names a different file than the central directory`);
  }
  if (method !== entry.method) throw malformed(`the local header of '${entry.name}' uses a different compression method than the central directory`);
  if (((flags ^ entry.flags) & FLAGS_THAT_MUST_AGREE) !== 0) {
    throw malformed(`the local header of '${entry.name}' sets different flags than the central directory`);
  }
  if ((entry.flags & FLAG_DESCRIPTOR) === 0) {
    let localCompressed = buf.readUInt32LE(at + 18);
    let localUncompressed = buf.readUInt32LE(at + 22);
    if (localCompressed === MAX_U32 || localUncompressed === MAX_U32) {
      const fields = parseExtraFields(buf, nameStart + nameLength, dataStart);
      const field = zip64Field(fields, 'a local header size');
      let cursor = field.start;
      if (localUncompressed === MAX_U32 && cursor + ZIP64_FIELD_BYTES <= field.end) {
        localUncompressed = toSafeNumber(buf.readBigUInt64LE(cursor), 'the uncompressed size');
        cursor += ZIP64_FIELD_BYTES;
      }
      if (localCompressed === MAX_U32 && cursor + ZIP64_FIELD_BYTES <= field.end) {
        localCompressed = toSafeNumber(buf.readBigUInt64LE(cursor), 'the compressed size');
      }
    }
    if (buf.readUInt32LE(at + 14) !== entry.crc || localCompressed !== entry.compressedSize || localUncompressed !== entry.uncompressedSize) {
      throw malformed(`the local header of '${entry.name}' records a different checksum or size than the central directory`);
    }
  }
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > directoryStart) throw malformed(`the data of '${entry.name}' runs past the end of the archive's entries`);
  return { headerStart: at, start: dataStart, end: dataEnd };
}

/** Rejects ranges that share bytes, which is how one small payload is made to expand many times. */
function assertNoOverlap(ranges: Array<{ headerStart: number; end: number }>): void {
  const sorted = [...ranges].sort((a, b) => a.headerStart - b.headerStart);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].headerStart < sorted[i - 1].end) {
      throw malformed('entries overlap each other; the archive reuses bytes for more than one entry');
    }
  }
}

function listedEntryOf(entry: ZipDirectoryEntry): ListedArchiveEntry {
  const mode = (entry.externalAttributes >>> UNIX_MODE_SHIFT) & S_IFMT;
  const markedDirectory = (entry.externalAttributes & DOS_DIRECTORY_ATTRIBUTE) !== 0 || mode === S_IFDIR;
  return {
    path: entry.name,
    isDirectory: entry.name.endsWith(DIRECTORY_SUFFIX) || markedDirectory,
    sizeBytes: entry.uncompressedSize,
    linkKind: mode === S_IFLNK ? 'symlink' : null,
    // ZIP stores file data for every entry; a pipe or device mode bit (zip(1) records one for stdin) does not change what the entry is.
    isSpecial: false,
  };
}

/** Separator and dot normalisation of an accepted name: `\` becomes `/`, empty and `.` segments go. */
function canonicalName(name: string): string {
  const kept: string[] = [];
  for (const segment of name.split(/[\\/]/)) {
    if (segment !== '' && segment !== '.') kept.push(segment);
  }
  return kept.join('/');
}

async function inflateEntry(data: Buffer, entry: ZipDirectoryEntry): Promise<Buffer> {
  if (entry.method === METHOD_STORED) {
    if (data.length !== entry.uncompressedSize) {
      throw malformed(`'${entry.name}' is stored but its compressed size ${data.length} differs from its uncompressed size ${entry.uncompressedSize}`);
    }
    return Buffer.from(data);
  }
  const cap = Math.max(entry.uncompressedSize, 1);
  const output = await new Promise<Buffer>((resolve, reject) => {
    zlib.inflateRaw(data, { maxOutputLength: cap }, (error, result) => {
      if (!error) {
        resolve(result);
        return;
      }
      if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
        reject(malformed(`'${entry.name}' decodes to more than the ${entry.uncompressedSize} bytes it declares`));
        return;
      }
      reject(malformed(`'${entry.name}' is not a valid deflate stream: ${error.message}`));
    });
  });
  if (output.length !== entry.uncompressedSize) {
    throw malformed(`'${entry.name}' decodes to ${output.length} bytes but declares ${entry.uncompressedSize}`);
  }
  return output;
}

function assertDecodable(entry: ZipDirectoryEntry): void {
  if (entry.method === METHOD_STORED || entry.method === METHOD_DEFLATE) return;
  const known = METHOD_NAMES.get(entry.method);
  throw new UnsupportedArchiveMethodError(
    `ZIP entry '${entry.name}' uses compression method ${entry.method}${known ? ` (${known})` : ''}, which is not supported.`
  );
}

export interface ZipReadOptions {
  limits: ArchiveExtractionLimits;
  /** Which entries to return, by name; the rest are still checked but never inflated. */
  select?: (name: string) => boolean;
  /** Leave link entries out and report them through `onSkippedLinks` instead of refusing the archive. */
  skipLinks?: boolean;
  onSkippedLinks?: (names: string[]) => void;
}

export function zipDirectoryHasEncryptedEntry(directory: ZipDirectory): boolean {
  return directory.entries.some((entry) => entry.isEncrypted);
}

/**
 * The regular files of a ZIP archive in central directory order, duplicates included. Throws a UnsafeArchiveError
 * for a traversing or absolute name or a link, a CorruptStreamError (400) when the records disagree or the data does
 * not match them, a DecompressionLimitError (413) past the entry, byte or ratio caps, and an
 * UnsupportedArchiveMethodError (422) for a method that is not decoded.
 */
export async function readZipFiles(
  buf: Buffer,
  directory: ZipDirectory,
  options: ZipReadOptions
): Promise<{ filename: string; buffer: Buffer }[]> {
  const { limits } = options;
  const entries = directory.entries;
  if (zipDirectoryHasEncryptedEntry(directory)) {
    throw new ArchivePasswordRequiredError('ZIP archive is password protected. A password is required to extract.');
  }

  // Names, links and counts of every entry. The byte caps follow below for the selected entries only.
  const listing = entries.map(listedEntryOf);
  for (const listed of listing) assertSafeArchiveEntryName(listed.path);
  let skippedLinks: string[];
  try {
    skippedLinks = assertSafeArchiveListing(
      listing,
      buf.length,
      { ...limits, MAX_UNCOMPRESSED_SIZE: Number.MAX_SAFE_INTEGER, MAX_RATIO: Number.POSITIVE_INFINITY },
      { skipLinks: options.skipLinks }
    ).skippedLinks;
  } catch (error) {
    // The listing counts the directories an entry implies, so a deep path can pass the entry count and still fail it here.
    if (error instanceof UnsafeArchiveError && error.reason === 'entry-count') throw new DecompressionLimitError(error.message);
    throw error;
  }
  options.onSkippedLinks?.(skippedLinks);

  const ranges = entries.map((entry) => locateEntryData(buf, entry, directory.directoryStart));
  assertNoOverlap(ranges);

  const selected: Array<{ entry: ZipDirectoryEntry; data: EntryData; filename: string }> = [];
  let declaredTotal = 0;
  entries.forEach((entry, index) => {
    const listed = listing[index];
    if (listed.isDirectory || listed.linkKind !== null) return;
    const filename = canonicalName(entry.name);
    if (filename === '') throw new UnsafeArchiveError('invalid-entry-name', 'Archive contains an entry with an empty name or one holding NUL or a line break.');
    if (options.select && !options.select(filename)) return;
    assertDecodable(entry);
    declaredTotal += entry.uncompressedSize;
    if (declaredTotal > limits.MAX_UNCOMPRESSED_SIZE) {
      throw new DecompressionLimitError(
        `Archive bomb detected: uncompressed size exceeds limit of ${limits.MAX_UNCOMPRESSED_SIZE} bytes (${Math.round(limits.MAX_UNCOMPRESSED_SIZE / (1024 * 1024))}MB)`
      );
    }
    selected.push({ entry, data: ranges[index], filename });
  });
  if (buf.length > 0 && declaredTotal / buf.length > limits.MAX_RATIO) {
    throw new DecompressionLimitError(
      `Archive bomb detected: compression ratio (${(declaredTotal / buf.length).toFixed(1)}:1) exceeds ${limits.MAX_RATIO}:1 limit`
    );
  }

  const files: { filename: string; buffer: Buffer }[] = [];
  for (const { entry, data, filename } of selected) {
    const bytes = await inflateEntry(buf.subarray(data.start, data.end), entry);
    if (crc32(bytes) !== entry.crc) throw malformed(`'${entry.name}' does not match its CRC-32`);
    files.push({ filename, buffer: bytes });
  }
  return files;
}
