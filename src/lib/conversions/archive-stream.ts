import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { ArchiveCollisionPolicy } from '../types';
import { SandboxedBufferLimitError, executeSandboxedBinary } from '../security/process-sandbox';
import { getMaxInMemoryBytes } from '../storage/errors';
import {
  ARCHIVE_SECURITY_LIMITS,
  buildTarEntryHeaders,
  listSevenZipEntries,
  listTarEntries,
  readTarEntries,
} from './archive';
import {
  type ListedArchiveEntry,
  UnreadableArchiveError,
  UnsafeArchiveError,
  assertCollisionPolicy,
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
 *    is cut off after the cap, not after it has been written out.
 *  - sevenZipToTar: the file table is read in process (header only), vetted by the extraction policy, and the members
 *    come out of one `7z x -so` call in table order, to be cut up by their stated sizes and checked by their CRC-32.
 *  - stageTarForSevenZip: the tar is read and vetted in process and written once into a staging tree for `7z a`.
 *
 * Every function returns null when the general pipeline must serve the request instead (an input too large to hold in
 * memory, an encrypted or undecodable header, an empty archive); the pipeline then reports whatever is wrong with the
 * input with its own typed errors.
 */

const LIMITS = ARCHIVE_SECURITY_LIMITS;
const TAR_BLOCK_BYTES = 512;
const TAR_END_OF_ARCHIVE = Buffer.alloc(2 * TAR_BLOCK_BYTES);
/** What 7-Zip may print to stderr on a run that succeeds; the stdout bound is exact and this is added on top. */
const STDERR_ALLOWANCE_BYTES = 64 * 1024;
const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIRECTORY_MODE = 0o755;
const PERMISSION_BITS = 0o7777;
const OWNER_READ_WRITE = 0o600;
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
  if (fs.statSync(source.filePath).size > getMaxInMemoryBytes()) return null;
  return fs.readFileSync(source.filePath);
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
  const segments: Uint8Array[] = [buildTarEntryHeaders({ filename: name, size: data.length }), data];
  pushPadding(segments, data.length);
  segments.push(TAR_END_OF_ARCHIVE);
  return segments;
}

/**
 * Whether the unpacked bytes are a tar the caller may be handed as it is. A tar is listed with the same policy an
 * extraction applies (traversal, links, devices, entry and size caps); a payload that merely looks like one by its
 * header checksum, and cannot be read as one, is an ordinary file.
 */
function isVettedTar(unpacked: Buffer, archiveBytes: number): boolean {
  const kind = classifyUnpacked(unpacked);
  if (kind === 'plain') return false;
  let listing: ListedArchiveEntry[];
  try {
    listing = listTarEntries(unpacked);
  } catch (err) {
    if (kind === 'maybe-tar') return false;
    throw new UnreadableArchiveError(
      `Could not read the archive: the tar inside it is malformed (${err instanceof Error ? err.message : String(err)}).`
    );
  }
  assertSafeArchiveListing(listing, archiveBytes, LIMITS);
  return true;
}

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
 * A single-stream compressor (xz, gzip, bzip2) to tar. The unpacked bytes are the tar when the payload is one;
 * otherwise a one-member tar is written around them, named after the source file.
 */
export async function streamToTar(request: StreamRunOptions & { compressor: StreamSource['compressor'] }): Promise<StreamedArchive> {
  const archiveBytes = sourceBytes(request.source);
  const cap = unpackedBytesCap(archiveBytes, LIMITS);
  const input = request.source.buffer === undefined ? [request.source.filePath as string] : ['-si'];
  const unpacked = await runSevenZip(request.p7zBin, ['x', '-so', '-y', `-t${request.compressor}`, ...input], {
    maxBuffer: cap + STDERR_ALLOWANCE_BYTES,
    timeoutMs: request.timeoutMs,
    stdin: request.source.buffer,
    signal: request.signal,
    onLimit: () => unpackedBytesCapError(archiveBytes, LIMITS),
  });
  if (unpacked.length > cap) throw unpackedBytesCapError(archiveBytes, LIMITS);
  if (isVettedTar(unpacked, archiveBytes)) return { segments: [unpacked], skippedLinks: [] };
  return { segments: wrapAsMember(memberNameFor(request.originalFilename), unpacked), skippedLinks: [] };
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

function unixModeOf(attributes: number | undefined): number | undefined {
  if (attributes === undefined || (attributes & ATTRIBUTE_UNIX_EXTENSION) === 0) return undefined;
  return (attributes >>> UNIX_MODE_SHIFT) & PERMISSION_BITS;
}

/**
 * Gives 7-Zip a file to read for the formats it cannot read from a pipe: the archive is written to a new file with an
 * unpredictable name (created exclusively, owner-only) and removed afterwards.
 */
async function withArchiveFile<T>(source: ArchiveSource, extension: string, operation: (archivePath: string) => Promise<T>): Promise<T> {
  if (source.filePath !== undefined) return operation(source.filePath);
  const archivePath = path.join(os.tmpdir(), `easyconvert-${crypto.randomUUID()}.${extension}`);
  fs.writeFileSync(archivePath, source.buffer as Buffer, { mode: OWNER_READ_WRITE, flag: 'wx' });
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
  let skippedLinks: string[];
  try {
    skippedLinks = assertSafeArchiveListing(listed, archive.length, LIMITS, { skipLinks: request.skipLinks }).skippedLinks;
    assertCollisionPolicy(listed, request.collisionPolicy);
  } catch (err) {
    throw toArchiveFailure(err, 'archive', 'list', LIMITS, false);
  }

  const streamBytes = files.reduce((sum, file) => sum + file.size, 0);
  const unpacked =
    streamBytes === 0
      ? Buffer.alloc(0)
      : await withArchiveFile(request.source, '7z', (archivePath) =>
          runSevenZip(request.p7zBin, ['x', '-so', '-y', archivePath], {
            maxBuffer: streamBytes + STDERR_ALLOWANCE_BYTES,
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
    // The owner keeps read access whatever mode the tar records, so the staging tree can be packed and removed.
    fs.chmodSync(target, (entry.mode & 0o777) | OWNER_READ_WRITE);
    fs.utimesSync(target, entry.mtime, entry.mtime);
  }
  // Deepest first: touching a child would otherwise change its parent's time again.
  for (const { dir, mode, mtime } of directories.reverse()) {
    fs.chmodSync(dir, (mode & 0o777) | OWNER_ALL);
    fs.utimesSync(dir, mtime, mtime);
  }
  return { stagingDir, entryCount: listing.length - skippedLinks.length, skippedLinks };
}
