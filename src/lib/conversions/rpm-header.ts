import fs from 'node:fs';
import { UnreadableArchiveError, UnsafeArchiveError, type ArchiveExtractionLimits } from './archive-extraction-safety';

/**
 * The file table of an rpm, read from the package header.
 *
 * An rpm is a 96-byte lead, a signature header, the metadata header and the payload. Since rpm 4.12 the payload may be a
 * cpio with stripped headers (`07070X` plus a file index): it holds no names, modes or sizes, which only the metadata
 * header (RPMTAG_BASENAMES, DIRNAMES, DIRINDEXES, FILEMODES, FILESIZES, ...) carries, so 7-Zip lists such a package as empty.
 * This reader gives the table that names the entries of that payload. The layout is the one rpm itself reads
 * (lib/header.c, lib/rpmfi.c): a header is an intro (magic `8e ad e8 01`, 4 reserved bytes, the index entry count and the
 * data length, big-endian), `count` index entries of 16 bytes (tag, type, offset, count) and the data they point into.
 *
 * Everything is read from an untrusted upload, so every count, offset and length is bounded before it is used:
 *  - at most {@link MAX_RPM_HEADER_ENTRIES} index entries per header (the limit rpm applies, 65,535);
 *  - at most {@link MAX_RPM_HEADER_DATA_BYTES} bytes of header data (64 MiB; rpm accepts up to 256 MiB), and a header
 *    larger than the bytes left in the file is refused before any of it is read;
 *  - each value lies wholly inside the data region, and a string array has as many NUL-terminated strings as its count;
 *  - at most `limits.MAX_FILES` files (the entry-count cap of every archive; no table is read past that many rows), a path of at most {@link MAX_RPM_PATH_BYTES} bytes, and every
 *    per-file table as long as the list of names.
 * Nothing is recursive, and nothing a header says is trusted beyond these checks: names are only handed on, and go through
 * the same listing and vetting as the names of any other archive.
 */

const LEAD_BYTES = 96;
const LEAD_MAGIC = Buffer.from([0xed, 0xab, 0xee, 0xdb]);
const HEADER_MAGIC = Buffer.from([0x8e, 0xad, 0xe8, 0x01]);
const HEADER_INTRO_BYTES = 16;
const INDEX_ENTRY_BYTES = 16;
const SIGNATURE_ALIGNMENT = 8;

export const MAX_RPM_HEADER_ENTRIES = 0xffff;
export const MAX_RPM_HEADER_DATA_BYTES = 64 * 1024 * 1024;
/** The longest name a cpio entry of an rpm may have (the limit rpm reads a name with). */
export const MAX_RPM_PATH_BYTES = 4096;

const TYPE_INT16 = 3;
const TYPE_INT32 = 4;
const TYPE_INT64 = 5;
const TYPE_STRING = 6;
const TYPE_STRING_ARRAY = 8;
/** Bytes of one value of each integer type. */
const INTEGER_WIDTHS: ReadonlyMap<number, number> = new Map([
  [TYPE_INT16, 2],
  [TYPE_INT32, 4],
  [TYPE_INT64, 8],
]);

const TAG_FILESIZES = 1028;
const TAG_FILEMODES = 1030;
const TAG_FILEMTIMES = 1034;
const TAG_FILELINKTOS = 1036;
const TAG_FILEFLAGS = 1037;
const TAG_FILEDEVICES = 1095;
const TAG_FILEINODES = 1096;
const TAG_DIRINDEXES = 1116;
const TAG_BASENAMES = 1117;
const TAG_DIRNAMES = 1118;
const TAG_LONGFILESIZES = 5008;

/** File flag: the file is not in the package (`%ghost`). */
export const RPM_FILE_GHOST = 1 << 6;

export interface RpmFile {
  /** Absolute path as the package installs it (`/usr/bin/x`), as bytes: names are not necessarily UTF-8. */
  path: Buffer;
  mode: number;
  size: number;
  mtime: number;
  flags: number;
  /** Zero when the header gives none; a regular file with a nonzero inode and device may be one of several hard links. */
  inode: number;
  device: number;
  /** The target of a symbolic link (empty for anything else). */
  linkTarget: Buffer;
}

export interface RpmPackage {
  /** Byte offset of the payload (the end of the metadata header). */
  payloadOffset: number;
  /** The file table, built when asked for: a package whose payload is not stripped never needs it. */
  files: () => RpmFile[];
}

interface IndexEntry {
  type: number;
  offset: number;
  count: number;
}

interface HeaderBlob {
  entries: Map<number, IndexEntry>;
  data: Buffer;
  /** Offset in the file of the first byte after this header. */
  end: number;
}

function damaged(what: string): UnreadableArchiveError {
  return new UnreadableArchiveError(`Could not read the package: its header is damaged (${what}).`);
}

function readExact(fd: number, position: number, length: number, what: string): Buffer {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const read = fs.readSync(fd, buffer, done, length - done, position + done);
    if (read === 0) throw damaged(`${what} is cut short`);
    done += read;
  }
  return buffer;
}

function readHeader(fd: number, offset: number, fileSize: number, what: string): HeaderBlob {
  const intro = readExact(fd, offset, HEADER_INTRO_BYTES, `the ${what} header`);
  if (!intro.subarray(0, HEADER_MAGIC.length).equals(HEADER_MAGIC)) throw damaged(`the ${what} header has no magic number`);
  const entryCount = intro.readUInt32BE(8);
  const dataBytes = intro.readUInt32BE(12);
  if (entryCount > MAX_RPM_HEADER_ENTRIES) throw damaged(`the ${what} header has ${entryCount} index entries, more than ${MAX_RPM_HEADER_ENTRIES}`);
  if (dataBytes > MAX_RPM_HEADER_DATA_BYTES) throw damaged(`the ${what} header has ${dataBytes} bytes of data, more than ${MAX_RPM_HEADER_DATA_BYTES}`);
  const indexBytes = entryCount * INDEX_ENTRY_BYTES;
  const end = offset + HEADER_INTRO_BYTES + indexBytes + dataBytes;
  if (end > fileSize) throw damaged(`the ${what} header is longer than the file`);
  const body = readExact(fd, offset + HEADER_INTRO_BYTES, indexBytes + dataBytes, `the ${what} header`);
  const data = body.subarray(indexBytes);
  const entries = new Map<number, IndexEntry>();
  for (let i = 0; i < entryCount; i++) {
    const at = i * INDEX_ENTRY_BYTES;
    const entry = { type: body.readUInt32BE(at + 4), offset: body.readUInt32BE(at + 8), count: body.readUInt32BE(at + 12) };
    if (entry.offset > dataBytes) throw damaged(`an index entry of the ${what} header points outside its data`);
    if (!entries.has(body.readUInt32BE(at))) entries.set(body.readUInt32BE(at), entry);
  }
  return { entries, data, end };
}

function entryOf(blob: HeaderBlob, tag: number, types: readonly number[], what: string): IndexEntry | undefined {
  const entry = blob.entries.get(tag);
  if (entry === undefined) return undefined;
  if (!types.includes(entry.type)) throw damaged(`${what} has an unexpected type`);
  return entry;
}

/** The strings of an array tag as views of the header data; a count larger than the data could hold is refused first. */
function stringArray(blob: HeaderBlob, tag: number, what: string, maxCount: number): Buffer[] | undefined {
  const entry = entryOf(blob, tag, [TYPE_STRING, TYPE_STRING_ARRAY], what);
  if (entry === undefined) return undefined;
  if (entry.count > maxCount) throw tooManyFiles(entry.count, maxCount);
  if (entry.count > blob.data.length - entry.offset) throw damaged(`${what} lists more strings than the header holds`);
  const strings: Buffer[] = [];
  let at = entry.offset;
  for (let i = 0; i < entry.count; i++) {
    const end = blob.data.indexOf(0, at);
    if (end === -1) throw damaged(`${what} has a string with no end`);
    strings.push(blob.data.subarray(at, end));
    at = end + 1;
  }
  return strings;
}

/** The numbers of an integer tag; the whole array must lie inside the data. */
function numberArray(blob: HeaderBlob, tag: number, types: readonly number[], what: string, maxCount: number): number[] | undefined {
  const entry = entryOf(blob, tag, types, what);
  if (entry === undefined) return undefined;
  if (entry.count > maxCount) throw tooManyFiles(entry.count, maxCount);
  const width = INTEGER_WIDTHS.get(entry.type) as number;
  if (entry.count > Math.floor((blob.data.length - entry.offset) / width)) throw damaged(`${what} lists more values than the header holds`);
  const numbers: number[] = [];
  for (let i = 0; i < entry.count; i++) {
    const at = entry.offset + i * width;
    if (width === 2) numbers.push(blob.data.readUInt16BE(at));
    else if (width === 4) numbers.push(blob.data.readUInt32BE(at));
    else {
      const value = blob.data.readBigUInt64BE(at);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw damaged(`${what} holds a value too large to be a file size`);
      numbers.push(Number(value));
    }
  }
  return numbers;
}

/** A table with more rows than the archive entry cap allows is the same bomb as an archive with that many entries. */
function tooManyFiles(count: number, maxFiles: number): UnsafeArchiveError {
  return new UnsafeArchiveError('entry-count', `Archive bomb detected: file count (${count}) exceeds limit of ${maxFiles}`);
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw damaged(`${what} is missing`);
  return value;
}

function sameLength(count: number, values: readonly unknown[], what: string): void {
  if (values.length !== count) throw damaged(`${what} does not list one value per file`);
}

/** The path of each file: its directory (which ends in a slash) followed by its base name. */
function pathsOf(blob: HeaderBlob, limits: ArchiveExtractionLimits): Buffer[] {
  // A package that installs no files has no list of names at all (rpm reads that as zero files).
  const baseNames = stringArray(blob, TAG_BASENAMES, 'the list of base names', limits.MAX_FILES);
  if (baseNames === undefined) return [];
  const dirNames = required(stringArray(blob, TAG_DIRNAMES, 'the list of directory names', limits.MAX_FILES), 'the list of directory names');
  const dirIndexes = required(numberArray(blob, TAG_DIRINDEXES, [TYPE_INT32], 'the list of directory indexes', limits.MAX_FILES), 'the list of directory indexes');
  sameLength(baseNames.length, dirIndexes, 'the list of directory indexes');
  return baseNames.map((base, i) => {
    const dir = dirNames[dirIndexes[i]];
    if (dir === undefined) throw damaged('a directory index points outside the list of directory names');
    if (dir.length === 0 || dir[0] !== 0x2f) throw damaged('a directory name is not an absolute path');
    if (dir.length + base.length > MAX_RPM_PATH_BYTES) throw damaged(`a path is longer than ${MAX_RPM_PATH_BYTES} bytes`);
    return Buffer.concat([dir, base]);
  });
}

function fileTable(blob: HeaderBlob, limits: ArchiveExtractionLimits): RpmFile[] {
  const paths = pathsOf(blob, limits);
  if (paths.length === 0) return [];
  const count = paths.length;
  const max = limits.MAX_FILES;
  const modes = required(numberArray(blob, TAG_FILEMODES, [TYPE_INT16], 'the list of file modes', max), 'the list of file modes');
  const sizes =
    numberArray(blob, TAG_FILESIZES, [TYPE_INT32], 'the list of file sizes', max) ?? numberArray(blob, TAG_LONGFILESIZES, [TYPE_INT64], 'the list of file sizes', max);
  const times = required(numberArray(blob, TAG_FILEMTIMES, [TYPE_INT32], 'the list of file times', max), 'the list of file times');
  const flags = required(numberArray(blob, TAG_FILEFLAGS, [TYPE_INT32], 'the list of file flags', max), 'the list of file flags');
  const inodes = numberArray(blob, TAG_FILEINODES, [TYPE_INT32], 'the list of file inodes', max);
  const devices = numberArray(blob, TAG_FILEDEVICES, [TYPE_INT32], 'the list of file devices', max);
  const links = stringArray(blob, TAG_FILELINKTOS, 'the list of link targets', max);
  const fileSizes = required(sizes, 'the list of file sizes');
  for (const [values, what] of [
    [modes, 'the list of file modes'],
    [fileSizes, 'the list of file sizes'],
    [times, 'the list of file times'],
    [flags, 'the list of file flags'],
  ] as const) {
    sameLength(count, values, what);
  }
  for (const [values, what] of [
    [inodes, 'the list of file inodes'],
    [devices, 'the list of file devices'],
    [links, 'the list of link targets'],
  ] as const) {
    if (values !== undefined) sameLength(count, values, what);
  }
  return paths.map((path, i) => ({
    path,
    mode: modes[i],
    size: fileSizes[i],
    mtime: times[i],
    flags: flags[i],
    inode: inodes?.[i] ?? 0,
    device: devices?.[i] ?? 0,
    linkTarget: links?.[i] ?? Buffer.alloc(0),
  }));
}

/** Reads the headers of the rpm at `file`; see the module comment for the bounds. The file table is built by `files()`. */
export function readRpmPackage(file: string, limits: ArchiveExtractionLimits): RpmPackage {
  const fd = fs.openSync(file, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    if (!readExact(fd, 0, LEAD_MAGIC.length, 'the lead').equals(LEAD_MAGIC)) throw damaged('the file is not an rpm');
    const signature = readHeader(fd, LEAD_BYTES, fileSize, 'signature');
    const metadataAt = Math.ceil(signature.end / SIGNATURE_ALIGNMENT) * SIGNATURE_ALIGNMENT;
    const metadata = readHeader(fd, metadataAt, fileSize, 'metadata');
    return { payloadOffset: metadata.end, files: () => fileTable(metadata, limits) };
  } finally {
    fs.closeSync(fd);
  }
}
