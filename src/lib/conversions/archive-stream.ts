import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { ConversionFailedError, type ArchiveCollisionPolicy } from '../types';
import { SandboxedBufferLimitError, executeSandboxedBinary } from '../security/process-sandbox';
import { getMaxInMemoryBytes } from '../storage/errors';
import {
  ARCHIVE_SECURITY_LIMITS,
  buildTarEntryHeaders,
  listSevenZipEntries,
  listTarEntries,
  readTarEntries,
  type TarEntry,
} from './archive';
import {
  type ListedArchiveEntry,
  UnreadableArchiveError,
  UnsafeArchiveError,
  assertCollisionPolicy,
  assertNoFileDirectoryConflict,
  assertSafeArchiveListing,
  cleanupDirectoryTree,
  sanitizeLeafFilename,
  toArchiveFailure,
  unpackedBytesCap,
  unpackedBytesCapError,
} from './archive-extraction-safety';
import { classifyUnpacked, type StreamSource } from './archive-stream-route';

/**
 * Archive-to-archive conversions that never extract to a directory (routing: archive-stream-route.ts).
 *
 *  - streamToTar: `7z x -so` writes the unpacked stream to a pipe; the byte count is bounded while it flows, so a bomb
 *    is cut off after the cap, not after it has been written out. A payload tar is read with this module's reader,
 *    vetted, and written again from its entries; the bytes of an untrusted archive are never handed on as they are.
 *  - sevenZipToTar: the file table is read in process (header only), vetted by the extraction policy, and the members
 *    come out of one `7z x -so` call in table order, to be cut up by their stated sizes and checked by their CRC-32.
 *  - stageTarForSevenZip: the tar is read and vetted in process and written once into a staging tree for `7z a`.
 *
 * Every function returns null when the general pipeline must serve the request instead (an input or output too large
 * to hold in memory under MAX_IN_MEMORY_BYTES, an encrypted or undecodable header, an empty archive); the pipeline then
 * reports whatever is wrong with the input with its own typed errors.
 */

const LIMITS = ARCHIVE_SECURITY_LIMITS;
const TAR_BLOCK_BYTES = 512;
const TAR_END_OF_ARCHIVE = Buffer.alloc(2 * TAR_BLOCK_BYTES);
/** What 7-Zip may print to stderr on a run that succeeds; the stdout bound is exact and this is added on top. */
const STDERR_ALLOWANCE_BYTES = 64 * 1024;
const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIRECTORY_MODE = 0o755;
/** Only the rwx bits of an untrusted mode are carried over: setuid, setgid and sticky never reach a tar or a 7z. */
const PERMISSION_BITS = 0o777;
const TAR_SIZE_FIELD_OFFSET = 124;
const TAR_SIZE_FIELD_BYTES = 12;
const TAR_OCTAL_RADIX = 8;
const MILLISECONDS_PER_SECOND = 1000;
const ARCHIVE_BOMB_MARKER = 'Archive bomb detected';
const OWNER_READ_WRITE = 0o600;
/** What 7-Zip needs of the owner to pack a staged member: read a file, read and search a directory. */
const OWNER_READ = 0o400;
const OWNER_READ_SEARCH = 0o500;
const OWNER_ALL = 0o700;

/** 7z attribute word: Windows bits, with the Unix mode in the high half when the extension bit is set. */
const ATTRIBUTE_DIRECTORY = 0x10;
const ATTRIBUTE_REPARSE_POINT = 0x400;
const ATTRIBUTE_UNIX_EXTENSION = 0x8000;
const UNIX_MODE_SHIFT = 16;
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const SPECIAL_FILE_TYPES: ReadonlySet<number> = new Set([0o020000, 0o060000, 0o010000, 0o140000]);

/** The archive to convert: held in memory, or a file the caller owns. */
export interface ArchiveSource {
  buffer?: Buffer;
  filePath?: string;
}

export interface StreamRunOptions {
  p7zBin: string;
  source: ArchiveSource;
  /** The caller's file name; the name of the one member when a stream that is not a tar is wrapped. */
  originalFilename: string;
  timeoutMs: number;
  skipLinks?: boolean;
  collisionPolicy?: ArchiveCollisionPolicy;
  signal?: AbortSignal;
}

/** The converted tar, as the byte ranges to write in order. */
export interface StreamedArchive {
  segments: Uint8Array[];
  skippedLinks: string[];
}

function sourceBytes(source: ArchiveSource): number {
  if (source.buffer !== undefined) return source.buffer.length;
  if (source.filePath !== undefined) return fs.statSync(source.filePath).size;
  throw new UnreadableArchiveError('The conversion received no archive to read.');
}

/** The whole archive in memory, or null when it is too large to hold there. */
function loadSource(source: ArchiveSource): Buffer | null {
  if (source.buffer !== undefined) return source.buffer;
  if (source.filePath === undefined) return null;
  // One descriptor for the size check and the read, so a file replaced in between cannot be read past the bound.
  const fd = fs.openSync(source.filePath, 'r');
  try {
    if (fs.fstatSync(fd).size > getMaxInMemoryBytes()) return null;
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function blockPadding(length: number): number {
  return (TAR_BLOCK_BYTES - (length % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
}

function pushPadding(segments: Uint8Array[], length: number): void {
  const padding = blockPadding(length);
  if (padding > 0) segments.push(TAR_END_OF_ARCHIVE.subarray(0, padding));
}

function memberNameFor(originalFilename: string): string {
  const stem = (originalFilename || 'file').replace(/\.[^/.]+$/, '');
  return sanitizeLeafFilename(stem === '' ? 'file' : stem);
}

/** A tar around one member: its header, the bytes, block padding and the end-of-archive marker. */
function wrapAsMember(name: string, data: Buffer): Uint8Array[] {
  const segments: Uint8Array[] = [];
  pushFileMember(segments, name, data, DEFAULT_FILE_MODE, undefined);
  segments.push(TAR_END_OF_ARCHIVE);
  return segments;
}

/** The header of a file entry must state exactly the number of bytes the caller is about to write after it. */
function assertHeaderDeclaresSize(header: Buffer, size: number): void {
  const field = header.subarray(header.length - TAR_BLOCK_BYTES + TAR_SIZE_FIELD_OFFSET, header.length - TAR_BLOCK_BYTES + TAR_SIZE_FIELD_OFFSET + TAR_SIZE_FIELD_BYTES);
  const declared = Number.parseInt(field.toString('ascii'), TAR_OCTAL_RADIX);
  if (declared !== size) {
    throw new ConversionFailedError(`Cannot write TAR archive: the header of a member declares ${declared} bytes where ${size} follow.`);
  }
}

/** A regular file as a header, its bytes and block padding. */
function pushFileMember(segments: Uint8Array[], name: string, data: Uint8Array, mode: number, mtime: Date | undefined): void {
  const header = buildTarEntryHeaders({ filename: name, size: data.length, directory: false, mode, mtime });
  assertHeaderDeclaresSize(header, data.length);
  segments.push(header, data);
  pushPadding(segments, data.length);
}

/** The entry that stays when a path is stored twice: the last one, which is what an extraction leaves on disk. */
function lastEntryPerPath(entries: TarEntry[]): TarEntry[] {
  const lastIndex = new Map<string, number>();
  entries.forEach((entry, index) => lastIndex.set(entry.filename, index));
  return entries.filter((entry, index) => lastIndex.get(entry.filename) === index);
}

/** A new tar written from vetted entries: canonical headers, no trailing data, no mode bits beyond rwx. */
function tarFromEntries(entries: TarEntry[]): Uint8Array[] {
  const segments: Uint8Array[] = [];
  for (const entry of lastEntryPerPath(entries)) {
    if (entry.type === 'symlink' || entry.type === 'hardlink') continue; // vetted: only reached when links are being skipped
    const mode = entry.mode & PERMISSION_BITS;
    const mtime = new Date(entry.mtime * MILLISECONDS_PER_SECOND);
    if (entry.type === 'directory') {
      segments.push(buildTarEntryHeaders({ filename: entry.filename, size: 0, directory: true, mode, mtime }));
    } else if (entry.type === 'file') {
      pushFileMember(segments, entry.filename, entry.buffer, mode, mtime);
    } else {
      throw new UnsafeArchiveError('special-entry', 'Archive contains a device, FIFO or socket entry.');
    }
  }
  segments.push(TAR_END_OF_ARCHIVE);
  return segments;
}

interface TarPolicyRequest {
  skipLinks?: boolean;
  collisionPolicy?: ArchiveCollisionPolicy;
}

/** A tar that cannot be read is unreadable; one that trips the reader's size or count guard stays the bomb it is. */
function unreadableTarError(err: unknown): Error {
  if (err instanceof Error && err.message.includes(ARCHIVE_BOMB_MARKER)) return err;
  return new UnreadableArchiveError(
    `Could not read the archive: the tar inside it is malformed (${err instanceof Error ? err.message : String(err)}).`
  );
}

/**
 * Reads a tar payload with this module's own reader and vets its entries with the full extraction policy (names,
 * links under `skipLinks`, devices, entry and size caps, collisions). What the reader did not read (data after the
 * end-of-archive blocks, bytes a different reader would interpret differently) is not in the result.
 */
function readVettedPayloadTar(tar: Buffer, archiveBytes: number, request: TarPolicyRequest): { entries: TarEntry[]; skippedLinks: string[] } {
  let listing: ListedArchiveEntry[];
  try {
    listing = listTarEntries(tar);
  } catch (err) {
    throw unreadableTarError(err);
  }
  let skippedLinks: string[];
  try {
    skippedLinks = assertSafeArchiveListing(listing, archiveBytes, LIMITS, { skipLinks: request.skipLinks }).skippedLinks;
    assertCollisionPolicy(listing, request.collisionPolicy);
  } catch (err) {
    throw toArchiveFailure(err, 'archive', 'list', LIMITS, false);
  }
  try {
    return { entries: readTarEntries(tar, { ignoreLinks: true }), skippedLinks };
  } catch (err) {
    throw unreadableTarError(err);
  }
}

/** The unpacked bytes are within the archive caps but would not fit the in-process budget: the disk pipeline serves the request. */
class ExceedsMemoryBudget extends Error {}

async function runSevenZip(
  p7zBin: string,
  args: string[],
  options: { maxBuffer: number; timeoutMs: number; stdin?: Buffer; signal?: AbortSignal; onLimit: () => Error }
): Promise<Buffer> {
  try {
    const run = await executeSandboxedBinary(p7zBin, args, {
      timeoutMs: options.timeoutMs,
      maxBuffer: options.maxBuffer,
      networkIsolated: true,
      stdin: options.stdin,
      signal: options.signal,
    });
    return run.stdout;
  } catch (err) {
    if (err instanceof SandboxedBufferLimitError) throw options.onLimit();
    throw toArchiveFailure(err, 'archive', 'extract', LIMITS, false);
  }
}

/**
 * A single-stream compressor (xz, gzip, bzip2) to tar. A payload that is a tar is read, vetted with the request's
 * policy and written again from its entries; otherwise a one-member tar is written around the bytes, named after the
 * source file.
 */
export async function streamToTar(request: StreamRunOptions & { compressor: StreamSource['compressor'] }): Promise<StreamedArchive | null> {
  const archiveBytes = sourceBytes(request.source);
  const cap = unpackedBytesCap(archiveBytes, LIMITS);
  // The output is held in memory, so it is bounded by the in-process budget as well as by the archive caps.
  const memoryBound = getMaxInMemoryBytes();
  const bound = Math.min(cap, memoryBound);
  const input = request.source.buffer === undefined ? [request.source.filePath as string] : ['-si'];
  let unpacked: Buffer;
  try {
    unpacked = await runSevenZip(request.p7zBin, ['x', '-so', '-y', `-t${request.compressor}`, ...input], {
      maxBuffer: bound + STDERR_ALLOWANCE_BYTES,
      timeoutMs: request.timeoutMs,
      stdin: request.source.buffer,
      signal: request.signal,
      onLimit: () => (memoryBound < cap ? new ExceedsMemoryBudget() : unpackedBytesCapError(archiveBytes, LIMITS)),
    });
  } catch (err) {
    if (err instanceof ExceedsMemoryBudget) return null;
    throw err;
  }
  if (unpacked.length > cap) throw unpackedBytesCapError(archiveBytes, LIMITS);
  // A first block that passes the tar header test makes the payload a tar, and one that then fails to read is damaged.
  if (classifyUnpacked(unpacked) === 'plain') {
    return { segments: wrapAsMember(memberNameFor(request.originalFilename), unpacked), skippedLinks: [] };
  }
  const { entries, skippedLinks } = readVettedPayloadTar(unpacked, archiveBytes, request);
  return { segments: tarFromEntries(entries), skippedLinks };
}

function toListedEntry(file: ReturnType<typeof listSevenZipEntries>['files'][number]): ListedArchiveEntry {
  const attributes = file.attributes ?? 0;
  const unixType = (attributes & ATTRIBUTE_UNIX_EXTENSION) !== 0 ? ((attributes >>> UNIX_MODE_SHIFT) & S_IFMT) : 0;
  const isSymlink = unixType === S_IFLNK || (attributes & ATTRIBUTE_REPARSE_POINT) !== 0;
  return {
    path: file.name,
    isDirectory: file.isDirectory || (attributes & ATTRIBUTE_DIRECTORY) !== 0 || unixType === S_IFDIR,
    sizeBytes: file.size,
    linkKind: isSymlink ? 'symlink' : null,
    isSpecial: SPECIAL_FILE_TYPES.has(unixType),
  };
}

/** The Unix rwx bits a 7z member records; setuid, setgid and sticky are dropped, as a root-owned tar must not carry them. */
function unixModeOf(attributes: number | undefined): number | undefined {
  if (attributes === undefined || (attributes & ATTRIBUTE_UNIX_EXTENSION) === 0) return undefined;
  return (attributes >>> UNIX_MODE_SHIFT) & PERMISSION_BITS;
}

/**
 * Gives 7-Zip a file to read for the formats it cannot read from a pipe. The archive is written to a new file with an
 * unpredictable name (created exclusively, owner-only) and removed afterwards. It is always the bytes that were parsed
 * and vetted, also when they came from a caller's file: that file is read once, so it cannot change between the
 * vetting and 7-Zip opening it.
 */
async function withArchiveFile<T>(archive: Buffer, extension: string, operation: (archivePath: string) => Promise<T>): Promise<T> {
  const archivePath = path.join(os.tmpdir(), `easyconvert-${crypto.randomUUID()}.${extension}`);
  fs.writeFileSync(archivePath, archive, { mode: OWNER_READ_WRITE, flag: 'wx' });
  try {
    return await operation(archivePath);
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
}

/**
 * 7z to tar. Returns null for an archive whose header cannot be read in process (encrypted, or coded with a method
 * only 7-Zip decodes) and for an input too large to hold in memory.
 */
export async function sevenZipToTar(request: StreamRunOptions): Promise<StreamedArchive | null> {
  const archive = loadSource(request.source);
  if (archive === null) return null;
  let files: ReturnType<typeof listSevenZipEntries>['files'];
  try {
    const listing = listSevenZipEntries(archive);
    if (listing.encrypted) return null;
    files = listing.files;
  } catch {
    return null;
  }
  if (files.length === 0) return null;

  const listed = files.map(toListedEntry);
  // 7-Zip streams the data of every member, a skipped link's included, so every size counts toward the caps.
  let skippedLinks: string[];
  let streamBytes: number;
  try {
    const verdict = assertSafeArchiveListing(listed, archive.length, LIMITS, { skipLinks: request.skipLinks, countLinkBytes: true });
    skippedLinks = verdict.skippedLinks;
    streamBytes = verdict.totalBytes;
    assertCollisionPolicy(listed, request.collisionPolicy);
  } catch (err) {
    throw toArchiveFailure(err, 'archive', 'list', LIMITS, false);
  }
  if (streamBytes > getMaxInMemoryBytes()) return null; // within the caps, but not for memory: the disk pipeline serves it
  const cap = unpackedBytesCap(archive.length, LIMITS);
  const unpacked =
    streamBytes === 0
      ? Buffer.alloc(0)
      : await withArchiveFile(archive, '7z', (archivePath) =>
          runSevenZip(request.p7zBin, ['x', '-so', '-y', archivePath], {
            maxBuffer: Math.min(streamBytes, cap) + STDERR_ALLOWANCE_BYTES,
            timeoutMs: request.timeoutMs,
            signal: request.signal,
            onLimit: () => new UnreadableArchiveError('Could not read the archive: 7-Zip produced more data than the archive header declares.'),
          })
        );
  if (unpacked.length !== streamBytes) {
    throw new UnreadableArchiveError(
      `Could not read the archive: 7-Zip produced ${unpacked.length} bytes where the archive header declares ${streamBytes}.`
    );
  }

  const segments: Uint8Array[] = [];
  let offset = 0;
  files.forEach((file, index) => {
    const data = unpacked.subarray(offset, offset + file.size);
    offset += file.size;
    if (file.crc !== undefined && zlib.crc32(data) !== file.crc) {
      throw new UnreadableArchiveError('Could not read the archive: a member does not match its stored CRC-32.');
    }
    if (listed[index].linkKind !== null) return; // vetted above: only reached when links are being skipped
    const name = file.name.replace(/\\/g, '/');
    const mtime = file.mtimeMs === undefined ? undefined : new Date(file.mtimeMs);
    if (listed[index].isDirectory) {
      segments.push(buildTarEntryHeaders({ filename: name, size: 0, directory: true, mode: unixModeOf(file.attributes) ?? DEFAULT_DIRECTORY_MODE, mtime }));
      return;
    }
    segments.push(buildTarEntryHeaders({ filename: name, size: data.length, mode: unixModeOf(file.attributes) ?? DEFAULT_FILE_MODE, mtime }), data);
    pushPadding(segments, data.length);
  });
  segments.push(TAR_END_OF_ARCHIVE);
  return { segments, skippedLinks };
}

export interface StagedTar {
  /** The tree to hand to `7z a`: the tar's members with their modes and modification times. */
  stagingDir: string;
  entryCount: number;
  skippedLinks: string[];
  /** Gives the owner back write access to every staged directory, so the tree can be removed after packing. */
  release: () => void;
}

export interface StageTarOptions {
  source: ArchiveSource;
  /** An existing private directory; the staging tree is created inside it. */
  workDir: string;
  skipLinks?: boolean;
  collisionPolicy?: ArchiveCollisionPolicy;
}

function assertInside(root: string, candidate: string): void {
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw new UnsafeArchiveError('escaped-root', 'A tar entry would be written outside the staging directory.');
  }
}

/**
 * Writes the members of a tar into a fresh staging tree, after the tar has passed the extraction policy. Returns null
 * for an input too large to hold in memory, an unreadable tar and a tar with nothing in it.
 */
export function stageTarForSevenZip(options: StageTarOptions): StagedTar | null {
  const tar = loadSource(options.source);
  if (tar === null) return null;
  let listing: ListedArchiveEntry[];
  try {
    listing = listTarEntries(tar);
  } catch {
    return null;
  }
  if (listing.length === 0) return null;

  let skippedLinks: string[];
  try {
    skippedLinks = assertSafeArchiveListing(listing, tar.length, LIMITS, { skipLinks: options.skipLinks }).skippedLinks;
    assertCollisionPolicy(listing, options.collisionPolicy);
    assertNoFileDirectoryConflict(listing);
  } catch (err) {
    throw toArchiveFailure(err, 'archive', 'list', LIMITS, false);
  }

  const stagingDir = path.join(options.workDir, `staged-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(stagingDir, { mode: OWNER_ALL });
  const directories: { dir: string; mode: number; mtime: number }[] = [];
  for (const entry of readTarEntries(tar, { ignoreLinks: true })) {
    if (entry.type === 'symlink' || entry.type === 'hardlink') continue; // vetted above: only reached when links are being skipped
    const target = path.join(stagingDir, ...entry.filename.split('/'));
    assertInside(stagingDir, target);
    if (entry.type === 'directory') {
      fs.mkdirSync(target, { recursive: true, mode: DEFAULT_DIRECTORY_MODE });
      directories.push({ dir: target, mode: entry.mode, mtime: entry.mtime });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: DEFAULT_DIRECTORY_MODE });
    fs.writeFileSync(target, entry.buffer);
    // 7-Zip stores the mode it finds on disk. The tar's rwx bits are kept as they are, except that the owner always
    // keeps read access (a file nobody may read cannot be packed), so such a member is stored with owner read.
    fs.chmodSync(target, (entry.mode & PERMISSION_BITS) | OWNER_READ);
    fs.utimesSync(target, entry.mtime, entry.mtime);
  }
  // Deepest first: touching a child would otherwise change its parent's time again. A directory keeps its mode
  // except for owner read and search, which 7-Zip needs to list it; `release` gives write access back for removal.
  const staged = directories.reverse();
  for (const { dir, mode, mtime } of staged) {
    fs.chmodSync(dir, (mode & PERMISSION_BITS) | OWNER_READ_SEARCH);
    fs.utimesSync(dir, mtime, mtime);
  }
  const release = (): void => {
    for (const { dir } of staged) fs.chmodSync(dir, OWNER_ALL);
  };
  return { stagingDir, entryCount: listing.length - skippedLinks.length, skippedLinks, release };
}
