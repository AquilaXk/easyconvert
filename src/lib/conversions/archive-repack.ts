import { getMaxInMemoryBytes } from '../storage/errors';
import type { ArchiveCollisionPolicy } from '../types';
import {
  assertCollisionPolicy,
  assertNoFileDirectoryConflict,
  assertSafeArchiveListing,
  type ListedArchiveEntry,
} from './archive-extraction-safety';
import { hasRar4Marker, readStoredRar4 } from './archive-rar-stored';
import {
  DEFAULT_DIRECTORY_MODE,
  DEFAULT_FILE_MODE,
  LIMITS,
  MILLISECONDS_PER_SECOND,
  PERMISSION_BITS,
  TAR_END_OF_ARCHIVE,
  lastEntryPerPath,
  loadSource,
  pushFileMember,
  tarFromEntries,
  vetTarSource,
  type ArchiveSource,
  type StreamedArchive,
} from './archive-stream';
import {
  canonicalName,
  dosDateTimeMs,
  readZipDirectory,
  readZipEntries,
  zipDirectoryHasEncryptedEntry,
  type ZipArchiveEntry,
} from './archive-zip-reader';
import { buildTarEntryHeaders, isZipBufferEncrypted, readTarEntries, type TarEntry } from './archive';
import { NativeDeflateError, deflateRawWithLibdeflate, getLibdeflateGzipPath } from './archive-libdeflate';
import { crc32 } from './crc32';
import { DEFLATE_BLOCK_BYTES, deflateRawBlocks } from './deflate-blocks';
import { ZipWriter, type ZipDeflater, type ZipEntryInput } from './zip-writer';

/**
 * Archive conversions served in process, from a tar to a ZIP or a gzip file and from a ZIP or a stored
 * RAR to a tar. Each one reads the source in memory, applies the extraction policy to its listing before any entry is
 * decoded or written (names, links, entry counts, byte and ratio caps, collisions; the same checks the general
 * pipeline runs on 7-Zip's listing) and writes the target from the vetted entries, so no bytes of an untrusted
 * archive are passed through and nothing is extracted to a directory.
 *
 * Every function returns null when it cannot answer for the request completely: an input too large for memory, an
 * archive it does not read (encrypted, an unsupported method, damaged records, a compressed RAR), one that breaks a
 * policy, an empty result, a payload past the in-process deflate bound while `libdeflate-gzip` is missing or fails. The
 * caller then hands the request to the general pipeline, which re-reads the archive from the start and reports whatever
 * is wrong with its own typed errors. These routes only ever shorten a conversion that would have succeeded; they never
 * decide on a refusal.
 */

export interface RepackRequest {
  source: ArchiveSource;
  skipLinks?: boolean;
  collisionPolicy?: ArchiveCollisionPolicy;
  signal?: AbortSignal;
  /** Longest one `libdeflate-gzip` run may take. */
  timeoutMs?: number;
}

export interface PackRequest extends RepackRequest {
  /** Validated compression level, 0 to 9. */
  compressionLevel: number;
}

/**
 * Most bytes of file data a ZIP or gzip is deflated from in process. Above it the large entries are encoded by
 * `libdeflate-gzip` (archive-libdeflate.ts), or by 7-Zip when that is not installed. The platform's zlib hashes four bytes, so
 * on binary data without long repeats it writes up to 3.6 percent more than gzip -6 (docs/policy-decisions.md, entry 30);
 * the samples that show it are 5 MB and larger, and past a few megabytes the cost of starting a process is small against
 * its encode.
 */
export const IN_PROCESS_DEFLATE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Smallest entry that `libdeflate-gzip` encodes once the total is past {@link IN_PROCESS_DEFLATE_MAX_BYTES}: the size at
 * which the in-process path already cuts an entry into parallel blocks (deflate-blocks.ts). Smaller entries stay in process,
 * so a tree of many small files does not start a process each.
 */
const NATIVE_DEFLATE_MIN_ENTRY_BYTES = DEFLATE_BLOCK_BYTES;

const STORED_LEVEL = 0;
const UNIX_REGULAR_FILE = 0o100000;
const UNIX_DIRECTORY = 0o040000;

const GZIP_ID1 = 0x1f;
const GZIP_ID2 = 0x8b;
const GZIP_METHOD_DEFLATE = 8;
const GZIP_FLAG_NAME = 0x08;
const GZIP_OS_UNIX = 3;
const GZIP_XFL_BEST = 2;
const GZIP_XFL_FASTEST = 4;
const GZIP_FIXED_HEADER_BYTES = 10;
const GZIP_TRAILER_BYTES = 8;
const GZIP_MAX_LEVEL = 9;
const UINT32_MODULUS = 0x100000000;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** Regular files and directories of a vetted tar, once per path (the last wins, as on disk). */
function packableEntries(tar: Buffer): TarEntry[] {
  return lastEntryPerPath(readTarEntries(tar, { ignoreLinks: true })).filter((entry) => entry.type === 'file' || entry.type === 'directory');
}

function fileBytes(entries: readonly { type: string; buffer: Buffer }[]): number {
  let total = 0;
  for (const entry of entries) if (entry.type === 'file') total += entry.buffer.length;
  return total;
}

function parentFolders(filename: string): string[] {
  const parts = filename.split('/');
  const folders: string[] = [];
  let folder = '';
  for (let i = 0; i < parts.length - 1; i++) {
    folder += `${parts[i]}/`;
    folders.push(folder);
  }
  return folders;
}

/** ZIP entries for the tar's members, each folder (named or implied) once, ahead of what it holds. */
function* zipEntriesOf(entries: readonly TarEntry[], level: number): Generator<ZipEntryInput> {
  const emitted = new Set<string>();
  for (const entry of entries) {
    const mtime = new Date(entry.mtime * MILLISECONDS_PER_SECOND);
    for (const folder of parentFolders(entry.filename)) {
      if (emitted.has(folder)) continue;
      emitted.add(folder);
      yield { name: folder, mtime, mode: UNIX_DIRECTORY | DEFAULT_DIRECTORY_MODE };
    }
    const permissions = entry.mode & PERMISSION_BITS;
    if (entry.type === 'directory') {
      const folder = `${entry.filename}/`;
      if (emitted.has(folder)) continue;
      emitted.add(folder);
      yield { name: folder, mtime, mode: UNIX_DIRECTORY | permissions };
    } else {
      yield { name: entry.filename, data: entry.buffer, level, mtime, mode: UNIX_REGULAR_FILE | permissions };
    }
  }
}

/** Whether the request's payload is past the in-process bound, so that its deflate is `libdeflate-gzip`'s. */
function needsNativeDeflate(level: number, dataBytes: number): boolean {
  return level > STORED_LEVEL && dataBytes > IN_PROCESS_DEFLATE_MAX_BYTES;
}

/** Large entries to `libdeflate-gzip`, the rest through the in-process blocks. */
function deflaterFor(request: RepackRequest): ZipDeflater {
  return (data, level) =>
    data.length >= NATIVE_DEFLATE_MIN_ENTRY_BYTES
      ? deflateRawWithLibdeflate(data, level, { signal: request.signal, timeoutMs: request.timeoutMs })
      : deflateRawBlocks(data, level);
}

/**
 * tar to ZIP: the members are deflated in parallel blocks by the platform's zlib (deflate-blocks.ts; stored at level 0, and entries that
 * are compressed already are stored), with their modes and times, folders ahead of their members. When the file data is past
 * {@link IN_PROCESS_DEFLATE_MAX_BYTES} the large entries are deflated by `libdeflate-gzip`, one process each.
 */
export async function tarToZip(request: PackRequest): Promise<StreamedArchive | null> {
  const vetted = vetTarSource(request);
  if (vetted === null) return null;
  const entries = packableEntries(vetted.tar);
  if (entries.length === 0) return null;
  const native = needsNativeDeflate(request.compressionLevel, fileBytes(entries));
  if (native && getLibdeflateGzipPath() === null) return null;
  const segments: Uint8Array[] = [];
  const writer = new ZipWriter(
    (chunk) => {
      segments.push(chunk);
    },
    { defaultLevel: request.compressionLevel, deflate: native ? deflaterFor(request) : deflateRawBlocks }
  );
  try {
    for (const zipEntry of zipEntriesOf(entries, request.compressionLevel)) {
      request.signal?.throwIfAborted();
      await writer.addEntry(zipEntry);
    }
    await writer.finish();
  } catch (error) {
    if (error instanceof NativeDeflateError) return null;
    throw error;
  }
  return { segments, skippedLinks: vetted.skippedLinks };
}

function gzipHeader(level: number, name: string | undefined, mtimeSeconds: number): Buffer {
  const nameBytes = name === undefined ? Buffer.alloc(0) : Buffer.from(`${name}\0`, 'latin1');
  const header = Buffer.alloc(GZIP_FIXED_HEADER_BYTES + nameBytes.length);
  header[0] = GZIP_ID1;
  header[1] = GZIP_ID2;
  header[2] = GZIP_METHOD_DEFLATE;
  header[3] = name === undefined ? 0 : GZIP_FLAG_NAME;
  header.writeUInt32LE(mtimeSeconds, 4);
  if (level === GZIP_MAX_LEVEL) header[8] = GZIP_XFL_BEST;
  else if (level === 1) header[8] = GZIP_XFL_FASTEST;
  header[9] = GZIP_OS_UNIX;
  nameBytes.copy(header, GZIP_FIXED_HEADER_BYTES);
  return header;
}

function gzipTrailer(data: Buffer): Buffer {
  const trailer = Buffer.alloc(GZIP_TRAILER_BYTES);
  trailer.writeUInt32LE(crc32(data), 0);
  trailer.writeUInt32LE(data.length % UINT32_MODULUS, 4);
  return trailer;
}

/** The name the gzip header records: the file's own name when it is plain ASCII (the header's text is ISO 8859-1), else none. */
function gzipNameOf(filename: string): string | undefined {
  const leaf = filename.slice(filename.lastIndexOf('/') + 1);
  return PRINTABLE_ASCII.test(leaf) ? leaf : undefined;
}

/**
 * tar to gzip. A gzip file holds one stream, so only a tar of exactly one regular file is answered here; the file is
 * deflated (in parallel blocks by the platform's zlib, or by `libdeflate-gzip` past {@link IN_PROCESS_DEFLATE_MAX_BYTES})
 * and wrapped in a header that names it and carries its modification time (RFC 1952).
 */
export async function tarToGzip(request: PackRequest): Promise<StreamedArchive | null> {
  const vetted = vetTarSource(request);
  if (vetted === null) return null;
  const entries = packableEntries(vetted.tar);
  const [only] = entries;
  if (entries.length !== 1 || only.type !== 'file') return null;
  const data = only.buffer;
  const native = needsNativeDeflate(request.compressionLevel, data.length);
  if (native && getLibdeflateGzipPath() === null) return null;
  request.signal?.throwIfAborted();
  const deflate = native ? deflaterFor(request) : deflateRawBlocks;
  let deflated: Uint8Array;
  try {
    deflated = await deflate(data, request.compressionLevel);
  } catch (error) {
    if (error instanceof NativeDeflateError) return null;
    throw error;
  }
  const mtimeSeconds = Math.min(Math.max(Math.floor(only.mtime), 0), UINT32_MODULUS - 1);
  return {
    segments: [gzipHeader(request.compressionLevel, gzipNameOf(only.filename), mtimeSeconds), deflated, gzipTrailer(data)],
    skippedLinks: vetted.skippedLinks,
  };
}

function listedFrom(entry: { filename: string; isDirectory: boolean; sizeBytes: number; linkKind?: 'symlink' }): ListedArchiveEntry {
  return { path: entry.filename, isDirectory: entry.isDirectory, sizeBytes: entry.sizeBytes, linkKind: entry.linkKind ?? null, isSpecial: false };
}

interface TarMember {
  filename: string;
  isDirectory: boolean;
  data: Buffer;
  mode?: number;
  mtimeMs?: number;
}

/** A tar written from members whose paths and sizes have passed the policy: canonical headers, the end blocks, no mode bits beyond rwx. */
function tarFromMembers(members: readonly TarMember[]): Uint8Array[] {
  const segments: Uint8Array[] = [];
  for (const member of lastEntryPerPath([...members])) {
    const mtime = member.mtimeMs === undefined ? undefined : new Date(member.mtimeMs);
    if (member.isDirectory) {
      segments.push(buildTarEntryHeaders({ filename: member.filename, size: 0, directory: true, mode: member.mode ?? DEFAULT_DIRECTORY_MODE, mtime }));
    } else {
      pushFileMember(segments, member.filename, member.data, member.mode ?? DEFAULT_FILE_MODE, mtime);
    }
  }
  segments.push(TAR_END_OF_ARCHIVE);
  return segments;
}

/**
 * The members, once the same checks the general pipeline makes of a listing have passed: collisions under the request's
 * policy and a path used as both file and directory. Throws what those checks throw, for the caller to turn into a null.
 */
function assertMembersExtractable(members: readonly TarMember[], policy: ArchiveCollisionPolicy | undefined): void {
  const listing = members.map((member) => listedFrom({ filename: member.filename, isDirectory: member.isDirectory, sizeBytes: member.data.length }));
  assertCollisionPolicy(listing, policy);
  assertNoFileDirectoryConflict(listing);
}

/**
 * ZIP to tar: the central directory is read and checked against every local header, the entries are inflated in process
 * with the output of each capped at the size it declares and checked against its CRC-32, and a tar is written from them
 * with the modes and times the ZIP recorded. Encrypted archives, entries stored with another method than stored or
 * deflate, and anything that does not verify are left to the general pipeline.
 */
export async function zipToTar(request: RepackRequest): Promise<StreamedArchive | null> {
  const archive = loadSource(request.source);
  if (archive === null || isZipBufferEncrypted(archive)) return null;
  try {
    const directory = readZipDirectory(archive, LIMITS);
    if (zipDirectoryHasEncryptedEntry(directory)) return null;
    let declared = 0;
    for (const entry of directory.entries) declared += entry.uncompressedSize;
    if (declared > getMaxInMemoryBytes()) return null;
    request.signal?.throwIfAborted();
    let skippedLinks: string[] = [];
    const read = await readZipEntries(archive, directory, {
      limits: LIMITS,
      skipLinks: request.skipLinks,
      onSkippedLinks: (names) => {
        skippedLinks = names;
      },
      includeDirectories: true,
    });
    if (read.length === 0) return null;
    request.signal?.throwIfAborted();
    const members = read.map((entry: ZipArchiveEntry): TarMember => ({ filename: entry.filename, isDirectory: entry.isDirectory, data: entry.buffer, mode: entry.mode, mtimeMs: entry.mtimeMs }));
    assertMembersExtractable(members, request.collisionPolicy);
    return { segments: tarFromMembers(members), skippedLinks };
  } catch (error) {
    if (isAbort(error)) throw error;
    return null;
  }
}

/**
 * Stored RAR 4.x to tar. The entries of such an archive are in the file as they are, so the tar is written from them after
 * the policy has vetted the listing and every entry has matched its CRC-32. Any other RAR is left to the general pipeline.
 */
export function rarToTar(request: RepackRequest): StreamedArchive | null {
  const archive = loadSource(request.source);
  if (archive === null || !hasRar4Marker(archive)) return null;
  const read = readStoredRar4(archive, LIMITS.MAX_FILES);
  if (read === null || read.length === 0) return null;
  try {
    const listed = read.map((entry) =>
      listedFrom({ filename: entry.name, isDirectory: entry.isDirectory, sizeBytes: entry.data.length, linkKind: entry.isSymlink ? 'symlink' : undefined })
    );
    const { skippedLinks } = assertSafeArchiveListing(listed, archive.length, LIMITS, { skipLinks: request.skipLinks });
    const members: TarMember[] = [];
    for (const entry of read) {
      if (entry.isSymlink) continue; // vetted above: only reached when links are being skipped
      const filename = canonicalName(entry.name);
      if (filename === '') throw new Error('an entry has an empty name');
      members.push({ filename, isDirectory: entry.isDirectory, data: entry.data, mode: entry.mode, mtimeMs: dosDateTimeMs(entry.dosDateTime) });
    }
    if (members.length === 0) return null;
    assertMembersExtractable(members, request.collisionPolicy);
    return { segments: tarFromMembers(members), skippedLinks };
  } catch {
    return null;
  }
}

