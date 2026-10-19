import fs from 'node:fs';
import { UnreadableArchiveError } from './archive-extraction-safety';
import { printableEntryName } from './archive-refusal-reasons';
import { RPM_FILE_GHOST, type RpmFile } from './rpm-header';

/**
 * Writes the payload of an rpm that uses stripped cpio headers as the ordinary cpio (`newc`) the rest of the package route
 * reads.
 *
 * A stripped payload (rpm 4.12 and later, lib/cpio.c and lib/rpmfi.c) is, per file, the magic `07070X`, the index of the
 * file in the package header as 8 hex digits, padding to 4 bytes, and the file's content, padded to 4 bytes; a standard
 * `TRAILER!!!` entry ends it. Which entries carry content is decided by the header, as rpm decides it: a regular file has its
 * size in bytes unless it is one of several hard links (regular files that share a device and an inode, not ghosts), where
 * only the last of the set carries them; a symbolic link has the length of its target in bytes (the target text itself is
 * taken from the header); every other entry has none, and a ghost is not in the payload at all.
 *
 * The cpio written names each file `.<path>` from the header, gives the links of one set the same inode number and the
 * set's size as link count, and puts the content on the last link, which is how a package's own cpio stores them.
 *
 * Bounds: the payload is read in 64 KiB pieces and written as it is read; the stream is walked once with no recursion; an
 * index may appear once and must be below the file count; a content size larger than the bytes left is refused; every file
 * of the package that is not a ghost must appear; and the size of everything written is reported to `charge`, which refuses
 * past the package's byte budget, so a header of many long paths cannot grow the output past what a package may unpack to.
 */

const STRIPPED_MAGIC = '07070X';
const NEWC_MAGIC = '070701';
const NEWC_CRC_MAGIC = '070702';
const MAGIC_BYTES = 6;
const HEX_FIELD_BYTES = 8;
const NEWC_FIELD_COUNT = 13;
const NEWC_HEADER_BYTES = MAGIC_BYTES + NEWC_FIELD_COUNT * HEX_FIELD_BYTES;
/** Zero-based position of the name size among the 13 fields of a `newc` header. */
const NEWC_NAME_SIZE_FIELD = 11;
const ALIGNMENT = 4;
const TRAILER = 'TRAILER!!!';
const COPY_CHUNK_BYTES = 64 * 1024;
const HEX_PATTERN = /^[0-9a-fA-F]{8}$/;
/** The largest value of a `newc` field, and so of a file size: 8 hex digits. */
const NEWC_FIELD_MAX = 0xffffffff;

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

export interface StrippedPayloadRequest {
  files: readonly RpmFile[];
  /** The decompressed stripped payload. */
  source: string;
  /** Where to write the cpio. */
  output: string;
  /** Counts bytes written against the package's budget; throws past it. */
  charge: (bytes: number) => void;
}

function damaged(what: string): UnreadableArchiveError {
  return new UnreadableArchiveError(`Could not read the package: its payload is damaged (${what}).`);
}

const alignUp = (position: number): number => Math.ceil(position / ALIGNMENT) * ALIGNMENT;
const typeOf = (file: RpmFile): number => file.mode & S_IFMT;
/** The path of a file for a message: it comes from an untrusted header, so control characters and length are dealt with. */
const named = (file: RpmFile): string => printableEntryName(file.path.toString('utf8'));
const hex = (value: number): string => value.toString(16).toUpperCase().padStart(HEX_FIELD_BYTES, '0');

/** The regular files that share a device and a nonzero inode, as lists of indexes in ascending order; singletons are not sets. */
function hardLinkSets(files: readonly RpmFile[]): Map<number, number[]> {
  const byIdentity = new Map<string, number[]>();
  files.forEach((file, index) => {
    if (typeOf(file) !== S_IFREG || (file.flags & RPM_FILE_GHOST) !== 0 || file.inode === 0) return;
    const key = `${file.device}:${file.inode}`;
    const members = byIdentity.get(key);
    if (members === undefined) byIdentity.set(key, [index]);
    else members.push(index);
  });
  const setOf = new Map<number, number[]>();
  for (const members of byIdentity.values()) {
    if (members.length > 1) for (const member of members) setOf.set(member, members);
  }
  return setOf;
}

class PayloadReader {
  constructor(private readonly fd: number, readonly length: number) {}

  /** `length` bytes at `position`; the stream ending first is a damaged payload. */
  read(position: number, length: number, what: string): Buffer {
    if (position + length > this.length) throw damaged(`${what} is cut short`);
    const buffer = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const read = fs.readSync(this.fd, buffer, done, length - done, position + done);
      if (read === 0) throw damaged(`${what} is cut short`);
      done += read;
    }
    return buffer;
  }
}

class CpioWriter {
  constructor(
    private readonly fd: number,
    private readonly charge: (bytes: number) => void
  ) {}

  write(buffer: Buffer): void {
    this.charge(buffer.length);
    fs.writeSync(this.fd, buffer);
  }

  /** One `newc` header, the name and its padding. */
  header(fields: { ino: number; mode: number; nlink: number; mtime: number; size: number; name: Buffer }): void {
    const nameWithNul = Buffer.concat([fields.name, Buffer.from([0])]);
    const values = [fields.ino, fields.mode, 0, 0, fields.nlink, fields.mtime, fields.size, 0, 0, 0, 0, nameWithNul.length, 0];
    const head = Buffer.from(`${NEWC_MAGIC}${values.map(hex).join('')}`, 'latin1');
    this.write(Buffer.concat([head, nameWithNul, Buffer.alloc(alignUp(head.length + nameWithNul.length) - head.length - nameWithNul.length)]));
  }

  pad(dataBytes: number): void {
    this.write(Buffer.alloc(alignUp(dataBytes) - dataBytes));
  }
}

interface Entry {
  index: number;
  /** Position of the first content byte in the stripped stream. */
  contentAt: number;
  /** Bytes of content the stripped stream holds for the entry. */
  contentBytes: number;
}

/** What the stripped stream holds for the file: the bytes of content it carries, as rpm decides it (see the module comment). */
function contentBytesOf(files: readonly RpmFile[], sets: Map<number, number[]>, index: number): number {
  const file = files[index];
  if ((file.flags & RPM_FILE_GHOST) !== 0) return 0;
  if (typeOf(file) === S_IFLNK) return file.size;
  if (typeOf(file) !== S_IFREG) return 0;
  const set = sets.get(index);
  return set !== undefined && set[set.length - 1] !== index ? 0 : file.size;
}

/** Reads the next entry of the stripped stream at `position`, or null at the trailer. Returns where the next entry starts. */
function nextEntry(reader: PayloadReader, files: readonly RpmFile[], sets: Map<number, number[]>, position: number): { entry: Entry | null; next: number } {
  const start = alignUp(position);
  const magic = reader.read(start, MAGIC_BYTES, 'an entry header').toString('latin1');
  if (magic === NEWC_MAGIC || magic === NEWC_CRC_MAGIC) {
    const header = reader.read(start + MAGIC_BYTES, NEWC_HEADER_BYTES - MAGIC_BYTES, 'the trailer');
    const sizeField = header.toString('latin1', NEWC_NAME_SIZE_FIELD * HEX_FIELD_BYTES, (NEWC_NAME_SIZE_FIELD + 1) * HEX_FIELD_BYTES);
    if (!HEX_PATTERN.test(sizeField) || parseInt(sizeField, 16) !== TRAILER.length + 1) throw damaged('an entry with a full header follows the stripped ones');
    const name = reader.read(start + NEWC_HEADER_BYTES, TRAILER.length + 1, 'the trailer').toString('latin1', 0, TRAILER.length);
    if (name !== TRAILER) throw damaged('an entry with a full header follows the stripped ones');
    return { entry: null, next: reader.length };
  }
  if (magic !== STRIPPED_MAGIC) throw damaged('an entry header has an unknown magic number');
  const indexField = reader.read(start + MAGIC_BYTES, HEX_FIELD_BYTES, 'an entry header').toString('latin1');
  if (!HEX_PATTERN.test(indexField)) throw damaged('an entry header has no file index');
  const index = parseInt(indexField, 16);
  if (index === NEWC_FIELD_MAX) return { entry: null, next: reader.length };
  if (index >= files.length) throw damaged('an entry names a file the package does not list');
  const contentAt = alignUp(start + MAGIC_BYTES + HEX_FIELD_BYTES);
  const contentBytes = contentBytesOf(files, sets, index);
  if (contentAt + contentBytes > reader.length) throw damaged(`the content of ${named(files[index])} is cut short`);
  return { entry: { index, contentAt, contentBytes }, next: contentAt + contentBytes };
}

function copyContent(reader: PayloadReader, writer: CpioWriter, entry: Entry): void {
  for (let done = 0; done < entry.contentBytes; done += COPY_CHUNK_BYTES) {
    writer.write(reader.read(entry.contentAt + done, Math.min(COPY_CHUNK_BYTES, entry.contentBytes - done), 'file content'));
  }
}

/**
 * Converts the stripped payload in `request.source` into a cpio at `request.output`. Throws a typed
 * {@link UnreadableArchiveError} for a payload that does not match the package header.
 */
export function strippedPayloadToCpio(request: StrippedPayloadRequest): void {
  const { files } = request;
  const sets = hardLinkSets(files);
  const seen = new Set<number>();
  const emittedInSet = new Map<number[], number>();
  const sourceFd = fs.openSync(request.source, 'r');
  const outputFd = fs.openSync(request.output, 'w');
  try {
    const reader = new PayloadReader(sourceFd, fs.fstatSync(sourceFd).size);
    const writer = new CpioWriter(outputFd, request.charge);
    let position = 0;
    for (;;) {
      const { entry, next } = nextEntry(reader, files, sets, position);
      position = next;
      if (entry === null) break;
      if (seen.has(entry.index)) throw damaged('a file appears twice');
      seen.add(entry.index);
      const file = files[entry.index];
      if ((file.flags & RPM_FILE_GHOST) !== 0) continue;
      const set = sets.get(entry.index);
      const emitted = set === undefined ? 0 : (emittedInSet.get(set) ?? 0);
      if (set !== undefined) emittedInSet.set(set, emitted + 1);
      if (set !== undefined && entry.contentBytes > 0 && emitted !== set.length - 1) {
        throw damaged('the content of a set of hard links does not come after every link');
      }
      const isLink = typeOf(file) === S_IFLNK;
      if (isLink && file.linkTarget.length === 0) throw damaged(`the link ${named(file)} has no target`);
      const size = isLink ? file.linkTarget.length : entry.contentBytes;
      if (size > NEWC_FIELD_MAX) throw damaged(`${named(file)} is larger than a cpio can hold`);
      writer.header({
        ino: (set === undefined ? entry.index : set[0]) + 1,
        mode: file.mode,
        nlink: set === undefined ? 1 : set.length,
        mtime: file.mtime,
        size,
        name: Buffer.concat([Buffer.from('.'), file.path]),
      });
      if (isLink) writer.write(file.linkTarget);
      else copyContent(reader, writer, entry);
      writer.pad(size);
    }
    const missing = files.findIndex((file, index) => (file.flags & RPM_FILE_GHOST) === 0 && !seen.has(index));
    if (missing !== -1) throw damaged(`${named(files[missing])} is missing`);
    writer.header({ ino: 0, mode: 0, nlink: 1, mtime: 0, size: 0, name: Buffer.from(TRAILER) });
  } finally {
    fs.closeSync(sourceFd);
    fs.closeSync(outputFd);
  }
}
