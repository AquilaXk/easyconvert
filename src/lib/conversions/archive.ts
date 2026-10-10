import { stageTimeoutMs } from './job-time';
import { execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FORMAT_REGISTRY } from '../registry';
import zlib from 'node:zlib';
import {
  ConversionOptions,
  ConversionResult,
  ConversionFailedError,
  ArchiveEncryptionUnavailableError,
  UnsupportedOptionError,
  ArchiveCollisionPolicy,
  ArchiveEntryMetadata,
  ArchiveInspectResponse,
  ArchiveEncryptedHeaderError,
  ArchiveEntryCollisionError,
  ArchivePasswordRequiredError,
  EngineUnavailableError,
  CorruptStreamError,
  DecompressionLimitError,
  PayloadLimitError,
} from '../types';
import {
  type ListedArchiveEntry,
  NativeRenameUnsupportedError,
  UnreadableArchiveError,
  UnsafeArchiveError,
  assertListingResourceCaps,
  extractArchiveContained,
  extractArchiveContainedSync,
  hasTarMagic,
  inspectedKindOf,
  listingBufferLimit,
  parse7zTechnicalListing,
  stripSevenZipPasswordPrompt,
  cleanupDirectoryTree,
  sanitizeLeafFilename,
  summarizeInspectionSafety,
  ARCHIVE_RATIO_BASELINE_BYTES,
} from './archive-extraction-safety';
import { compressBzip2Async, decompressBzip2 } from './bzip2';
import { InflateBudget, inflateRawSalvage } from './bounded-inflate';
import { resolveArchiveCompressionLevel } from './archive-compression-level';
import { crc32 } from './crc32';
import { createZipBuffer, ZIP_DEFAULT_LEVEL, type ZipEntryInput } from './zip-writer';
import { decodeLzma, decodeLzma2 } from './lzma-decoder';
import { packXzStream, unpackXzStream } from './xz-format';
import { readZipDirectory, readZipFiles, zipDirectoryHasEncryptedEntry, type ZipDirectory } from './archive-zip-reader';
import { AesKeyCache, AesKeyMissingError, aesKeyRequestOf } from './archive-sevenzip-aes';
import { createSevenZipFolderDecoder } from './archive-sevenzip-coders';
import {
  classifySevenZipAttributes,
  collectSevenZipAesProperties,
  listSevenZipArchive,
  readSevenZipArchive,
  type SevenZipEntry,
  type SevenZipListing,
  type SevenZipReadLimits,
} from './sevenzip-reader';
import { compressZstd, compressZstdAsync, decompressZstd, exceedsZstdRatioGuard, parseZstdFrameHeader, ZSTD_MAGIC_LE } from './zstd';
import {
  compressLzma,
  compressLzma2,
  compressLzma2Async,
  compressLzmaAsync,
  type LzmaCompressOptions,
  type LzmaCompressResult,
} from './lzma-encoder';
import { CPU_POOL_MAX, CPU_POOL_MIN_BYTES, CPU_POOL_TASK_TIMEOUT_MS, getCpuPool } from '../workers/cpu-pool';
import {
  isSplitArchive,
  parseSplitArchivePart,
  stitchMultiVolumeArchive,
  splitArchive,
  type SplitArchivePartInfo,
  type StitchedArchiveResult,
  createVirtualSpannedStream,
  stitchMultiVolumeToDisk,
  VirtualSpannedStream,
  MultiVolumeBufferOverflowError,
  MAX_STITCH_BUFFER_SIZE,
  validateAndSortSplitParts,
  validateMultiVolumeSequence,
  type VirtualSpannedPartSource,
  type VirtualSpannedStreamOptions,
  type SpannedArchiveMetadata,
} from './archive-split';
import {
  executeSandboxedBinary,
  resolveSandboxedCommand,
  rethrowSandboxUnavailable,
  getSanitizedEnvironment,
} from '../security/process-sandbox';
import {
  SEVEN_ZIP_ASK_PASSWORD_SWITCH,
  archivePasswordError,
  archiveFailureStderr,
  assertArchivePasswordSafe,
  assertListingShowsEncryption,
  assertEncryptedArchiveInputWithinLimits,
  assertZipPasswordSupported,
  MAX_ENCRYPTION_LISTING_BYTES,
  SEVEN_ZIP_LISTING_TIMEOUT_MS,
  walkArchiveTreePaths,
  execFileSyncWithPasswordStdin,
  isArchivePasswordError,
  sevenZipCreatePasswordInput,
  sevenZipEncryptionCheckInput,
  sevenZipReadPasswordInput,
  isArchivePasswordFailure,
} from './archive-password';
import {
  compressWithZstdDict,
  decompressWithZstdDict,
  getPretrainedDictionary,
  DATA_DICTIONARY_JSON_CSV,
  OFFICE_XML_DICTIONARY,
  ZSTD_DICT_MAGIC,
  ZSTD_OFFICE_DICT_MAGIC,
  type ZstdDictOptions,
  ZstdDictionaryStreamCompressor,
  createZstdDictionaryTransformStream,
  type ZstdDictionaryStreamOptions,
} from './zstd-dict';

export {
  compressZstd,
  decompressZstd,
  compressLzma,
  compressLzma2,
  type LzmaCompressOptions,
  type LzmaCompressResult,
  isSplitArchive,
  parseSplitArchivePart,
  stitchMultiVolumeArchive,
  splitArchive,
  type SplitArchivePartInfo,
  type StitchedArchiveResult,
  createVirtualSpannedStream,
  stitchMultiVolumeToDisk,
  VirtualSpannedStream,
  MultiVolumeBufferOverflowError,
  MAX_STITCH_BUFFER_SIZE,
  validateAndSortSplitParts,
  validateMultiVolumeSequence,
  type VirtualSpannedPartSource,
  type VirtualSpannedStreamOptions,
  type SpannedArchiveMetadata,
  compressWithZstdDict,
  decompressWithZstdDict,
  getPretrainedDictionary,
  DATA_DICTIONARY_JSON_CSV,
  OFFICE_XML_DICTIONARY,
  ZSTD_DICT_MAGIC,
  ZSTD_OFFICE_DICT_MAGIC,
  type ZstdDictOptions,
  ZstdDictionaryStreamCompressor,
  createZstdDictionaryTransformStream,
  type ZstdDictionaryStreamOptions,
};

export { crc32 };

const PATH_SLASH_CHAR_CODE = 0x2f;

/** Strips trailing '/' characters in linear time (a regex would backtrack quadratically on slash runs). */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === PATH_SLASH_CHAR_CODE) end--;
  return value.slice(0, end);
}

/**
 * Resolves entry collisions for archive creation based on the chosen collision policy.
 * A directory entry ('d/') and a file ('d') collide because they name the same path.
 * - 'rename': appends a suffix (e.g., stem-1.ext, stem-2.ext) to conflicting files; directories keep
 *   their trailing slash ('d-1/').
 * - 'error': throws ArchiveEntryCollisionError on any duplicate relative path.
 * - 'overwrite': keeps the last occurrence of the conflicting entry.
 */
export function resolveArchiveEntryCollisions<T extends { filename: string; buffer: Buffer }>(
  files: T[],
  policy: ArchiveCollisionPolicy = 'rename'
): T[] {
  if (files.length <= 1) return [...files];
  if (policy === 'overwrite') return keepLastArchiveEntries(files);
  if (policy === 'error') return rejectDuplicateArchiveEntries(files);
  return renameDuplicateArchiveEntries(files);
}

function keepLastArchiveEntries<T extends { filename: string }>(files: T[]): T[] {
  const map = new Map<string, T>();
  for (const f of files) {
    const norm = f.filename.replace(/\\/g, '/');
    map.set(trimTrailingSlashes(norm), { ...f, filename: norm });
  }
  return Array.from(map.values());
}

function rejectDuplicateArchiveEntries<T extends { filename: string }>(files: T[]): T[] {
  const seen = new Set<string>();
  for (const f of files) {
    const norm = f.filename.replace(/\\/g, '/');
    const key = trimTrailingSlashes(norm);
    if (seen.has(key)) {
      throw new ArchiveEntryCollisionError(
        norm,
        `Archive entry collision detected for '${norm}' under collision policy 'error'.`
      );
    }
    seen.add(key);
  }
  return [...files];
}

/** Finds the first free `stem-N.ext` sibling of `key` (directories keep no extension) not yet in `seen`. */
function nextFreeArchiveEntryName(key: string, isDirectory: boolean, seen: Set<string>, nextSuffix: Map<string, number>): string {
  const ext = isDirectory ? '' : path.extname(key);
  const dir = path.dirname(key);
  const baseStem = path.basename(key, ext);
  const build = (n: number): string =>
    dir === '.' || dir === '' ? `${baseStem}-${n}${ext}` : `${dir}/${baseStem}-${n}${ext}`;

  let counter = nextSuffix.get(key) ?? 1;
  while (seen.has(build(counter))) counter++;
  nextSuffix.set(key, counter + 1);
  return build(counter);
}

function renameDuplicateArchiveEntries<T extends { filename: string }>(files: T[]): T[] {
  const seen = new Set<string>();
  // Next number to try per original name, so n duplicates cost O(n) rather than O(n^2) probing.
  const nextSuffix = new Map<string, number>();
  const result: T[] = [];

  for (const f of files) {
    const norm = f.filename.replace(/\\/g, '/');
    const key = trimTrailingSlashes(norm);
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ ...f, filename: norm });
      continue;
    }

    const isDirectory = key !== norm;
    const candidate = nextFreeArchiveEntryName(key, isDirectory, seen, nextSuffix);
    seen.add(candidate);
    result.push({ ...f, filename: isDirectory ? `${candidate}/` : candidate });
  }

  return result;
}

/**
 * Evaluates whether an archive entry path matches any of the provided glob patterns.
 * Supports exact paths, *, **, ?, and directory prefixes.
 */
export function matchArchiveGlob(filePath: string, patterns?: string[]): boolean {
  if (!patterns || patterns.length === 0) return true;
  const normalizedPath = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const baseName = path.basename(normalizedPath);

  for (const pattern of patterns) {
    if (!pattern) continue;
    const normPattern = pattern.replace(/\\/g, '/').replace(/^\/+/, '');

    if (normalizedPath === normPattern || baseName === normPattern) {
      return true;
    }

    const target = normPattern.includes('/') ? normalizedPath : baseName;

    const regexStr = '^' + normPattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '___GLOB_STAR_STAR___')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/___GLOB_STAR_STAR___/g, '.*') + '$';

    try {
      const regex = new RegExp(regexStr);
      if (regex.test(target) || regex.test(normalizedPath)) {
        return true;
      }
    } catch {}
  }

  return false;
}

/**
 * Lists a freshly created password-protected archive without its password and throws
 * ArchiveNotEncryptedError unless it is encrypted, so a plaintext archive is never returned.
 */
function assertCreatedArchiveEncrypted(p7z: string, archivePath: string, format: 'zip' | '7z', cwd: string): void {
  const resolved = resolveSandboxedCommand(p7z, ['l', '-slt', archivePath], { networkIsolated: true });
  let outcome: { listing?: string; failureOutput?: string };
  try {
    const out = execFileSyncWithPasswordStdin(resolved.binary, resolved.args, {
      cwd,
      env: getSanitizedEnvironment({}, true),
      timeout: SEVEN_ZIP_LISTING_TIMEOUT_MS,
      maxBuffer: MAX_ENCRYPTION_LISTING_BYTES,
      input: sevenZipEncryptionCheckInput(),
    });
    outcome = { listing: out.toString('utf-8') };
  } catch (err) {
    outcome = { failureOutput: archiveFailureStderr(err) };
  }
  assertListingShowsEncryption(format, outcome);
}

function createEncryptedArchiveVia7z(
  files: { filename: string; buffer: Buffer }[],
  archiveName: string,
  archiveType: 'zip' | '7z',
  mimeType: string,
  password?: string,
  collisionPolicy?: ArchiveCollisionPolicy
): ConversionResult | null {
  const p7z = get7zBinaryPath();
  if (!p7z || !password) return null;
  assertArchivePasswordSafe(password);
  if (archiveType === 'zip') assertZipPasswordSupported(password);

  const resolvedFiles = resolveArchiveEntryCollisions(files, collisionPolicy || 'rename');
  assertEncryptedArchiveInputWithinLimits(resolvedFiles.map((f) => sanitizeArchivePath(f.filename) || path.basename(f.filename)));
  const tmpDir = os.tmpdir();
  const token = crypto.randomBytes(8).toString('hex');
  const workDir = path.join(tmpDir, `easyconvert_${archiveType}_create_${Date.now()}_${token}`);
  const stagingDir = path.join(workDir, 'staging');
  fs.mkdirSync(stagingDir, { recursive: true });
  try {
    for (const f of resolvedFiles) {
      const safe = sanitizeArchivePath(f.filename) || path.basename(f.filename);
      const dest = path.join(stagingDir, safe);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.buffer);
    }
    const outPath = path.join(workDir, archiveName);
    const extraArgs = archiveType === '7z'
      ? ['-t7z', '-mhe=on', SEVEN_ZIP_ASK_PASSWORD_SWITCH]
      : ['-tzip', '-mem=AES256', SEVEN_ZIP_ASK_PASSWORD_SWITCH];
    const resolved = resolveSandboxedCommand(p7z, ['a', '-y', ...extraArgs, outPath, '.'], {
      networkIsolated: true,
    });
    execFileSyncWithPasswordStdin(resolved.binary, resolved.args, {
      cwd: stagingDir,
      env: getSanitizedEnvironment({}, true),
      timeout: 60000,
      input: sevenZipCreatePasswordInput(password),
    });
    assertCreatedArchiveEncrypted(p7z, outPath, archiveType, stagingDir);
    const content = fs.readFileSync(outPath);
    return {
      buffer: content,
      mimeType,
      filename: archiveName,
      size: content.length,
    };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

export async function createZipArchive(
  files: { filename: string; buffer: Buffer }[],
  options: ConversionOptions = {},
  archiveName = 'converted_files.zip'
): Promise<ConversionResult> {
  // Before the truthiness check below: a falsy non-string such as 0 must not silently skip encryption.
  assertArchivePasswordSafe(options.password);
  const resolvedFiles = resolveArchiveEntryCollisions(files, options.collisionPolicy || 'rename');
  if (options.password) {
    const p7z = get7zBinaryPath();
    if (!p7z) {
      throw new ArchiveEncryptionUnavailableError(
        'Archive encryption is unavailable: native 7z binary is required for encrypted ZIP archives.'
      );
    }
    const encRes = createEncryptedArchiveVia7z(
      resolvedFiles,
      archiveName,
      'zip',
      'application/zip',
      options.password,
      options.collisionPolicy
    );
    if (encRes) return encRes;
    throw new ArchiveEncryptionUnavailableError('Failed to create encrypted ZIP archive.');
  }

  if (resolvedFiles.length > ARCHIVE_SECURITY_LIMITS.MAX_FILES) {
    // The extractor refuses archives past this count, so the writer does not produce one.
    throw new PayloadLimitError(`ZIP archive would hold ${resolvedFiles.length} entries; the limit is ${ARCHIVE_SECURITY_LIMITS.MAX_FILES}.`);
  }
  const compressionLevel = resolveArchiveCompressionLevel(options.compressionLevel);
  const content = await createZipBuffer(zipEntriesWithFolders(resolvedFiles, compressionLevel));

  return {
    buffer: content,
    mimeType: 'application/zip',
    filename: archiveName,
    size: content.length,
  };
}

/**
 * Entries for the ZIP writer: every file, preceded the first time a folder is met by an entry for that folder, so that
 * extractors list the directory structure the way they did when the archive was assembled by JSZip.
 */
function* zipEntriesWithFolders(
  files: readonly { filename: string; buffer: Buffer }[],
  level: number
): Generator<ZipEntryInput> {
  const mtime = new Date();
  const emittedFolders = new Set<string>();
  for (const f of files) {
    const parts = f.filename.split('/');
    let folder = '';
    for (let i = 0; i < parts.length - 1; i++) {
      folder += `${parts[i]}/`;
      if (parts[i] !== '' && !emittedFolders.has(folder)) {
        emittedFolders.add(folder);
        yield { name: folder, mtime };
      }
    }
    if (f.filename.endsWith('/')) {
      if (!emittedFolders.has(f.filename)) {
        emittedFolders.add(f.filename);
        yield { name: f.filename, mtime };
      }
    } else {
      yield { name: f.filename, data: f.buffer, level, mtime };
    }
  }
}

/**
 * Decodes a .zst / .tar.zst payload. An explicit `zstdDict` option selects a pre-trained dictionary;
 * otherwise a frame that names one of the built-in dictionary ids is decoded with that dictionary.
 */
function decodeZstdArchivePayload(payload: Buffer, zstdDict: unknown): Buffer {
  if (zstdDict) {
    const dict =
      typeof zstdDict === 'string' && (zstdDict === 'office' || zstdDict === 'data')
        ? getPretrainedDictionary(zstdDict)
        : DATA_DICTIONARY_JSON_CSV;
    return decompressWithZstdDict(payload, dict);
  }
  if (payload.length >= ZSTD_MAGIC_LE.length + 1 && payload.subarray(0, ZSTD_MAGIC_LE.length).equals(ZSTD_MAGIC_LE)) {
    const { dictionaryId } = parseZstdFrameHeader(payload, 0);
    if (dictionaryId === ZSTD_DICT_MAGIC) return decompressWithZstdDict(payload, DATA_DICTIONARY_JSON_CSV);
    if (dictionaryId === ZSTD_OFFICE_DICT_MAGIC) return decompressWithZstdDict(payload, OFFICE_XML_DICTIONARY);
  }
  return decompressZstd(payload);
}

/** Longest one unrar extraction may run. */
const UNRAR_EXTRACT_TIMEOUT_MS = 30_000;

/** unrar restores the Unix mode stored in the archive; the owner needs these bits to read and remove the result. */
const EXTRACTED_DIRECTORY_MODE = 0o700;
const EXTRACTED_FILE_MODE = 0o600;

/**
 * Gives the owner access to everything an extraction wrote. An archive may store any mode, down to
 * no permission bits; unrar applies it, so a worker that is not root could neither read the entries
 * nor delete the directory. Walks iteratively and stops at the archive file-count limit.
 */
function makeExtractedTreeAccessible(root: string): void {
  const pending = [root];
  let visited = 0;
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    fs.chmodSync(dir, EXTRACTED_DIRECTORY_MODE);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      visited += 1;
      if (visited > ARCHIVE_SECURITY_LIMITS.MAX_FILES) {
        throw new DecompressionLimitError(`Archive bomb detected: file count exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_FILES}`);
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile()) fs.chmodSync(fullPath, EXTRACTED_FILE_MODE);
    }
  }
}

export const ARCHIVE_SECURITY_LIMITS = {
  MAX_FILES: 50_000,
  MAX_UNCOMPRESSED_SIZE: 500 * 1024 * 1024, // 500MB limit
  MAX_RATIO: 100, // 100:1 compression ratio
};

const PATH_DOT_CHAR_CODE = 0x2e;
const DRIVE_COLON_INDEX = 1;
const DRIVE_COLON_CHAR_CODE = 0x3a;
const BACKSLASH_CHAR = '\\';

/** True when the path may carry a drive prefix or backslash separators (needs the regex normalization). */
function hasWindowsPathSyntax(filename: string): boolean {
  return filename.charCodeAt(DRIVE_COLON_INDEX) === DRIVE_COLON_CHAR_CODE || filename.includes(BACKSLASH_CHAR);
}

/** Joins the '/'-separated components except empty, '.' and '..' ones, without allocating arrays. */
function joinSafePathSegments(filename: string): string {
  let joined = '';
  let start = 0;
  while (start <= filename.length) {
    const slash = filename.indexOf('/', start);
    const end = slash === -1 ? filename.length : slash;
    const length = end - start;
    const isDot = length === 1 && filename.charCodeAt(start) === PATH_DOT_CHAR_CODE;
    const isDotDot =
      length === 2 && filename.charCodeAt(start) === PATH_DOT_CHAR_CODE && filename.charCodeAt(start + 1) === PATH_DOT_CHAR_CODE;
    if (length > 0 && !isDot && !isDotDot) {
      const segment = filename.slice(start, end);
      joined = joined === '' ? segment : `${joined}/${segment}`;
    }
    start = end + 1;
  }
  return joined;
}

/**
 * Normalizes and validates archive entry paths against Zip-Slip traversal.
 * Strips Windows drive letters, converts backslashes, collapses /./ and /../ segments.
 * Returns null if the resulting path escapes the extraction root or is invalid.
 */
export function sanitizeArchivePath(filename: string): string | null {
  const normalized = hasWindowsPathSyntax(filename)
    ? filename
        .replace(/^[a-zA-Z]:[\\/]+/, '')
        .replace(/\\/g, '/')
        .split('/')
        .filter((part) => part !== '..' && part !== '.' && part.length > 0)
        .join('/')
    : joinSafePathSegments(filename);

  if (!normalized || normalized.startsWith('/') || normalized.includes('../')) {
    return null;
  }
  return normalized;
}

/**
 * Inspects PKZIP local file headers and central directory records for bit 0 or bit 6 encryption flags.
 */
export function isZipBufferEncrypted(buffer: Buffer): boolean {
  if (buffer.length < 30) return false;
  let pos = 0;
  while (pos + 30 <= buffer.length) {
    if (buffer[pos] === 0x50 && buffer[pos + 1] === 0x4b && buffer[pos + 2] === 0x03 && buffer[pos + 3] === 0x04) {
      const flags = buffer.readUInt16LE(pos + 6);
      if ((flags & 0x0041) !== 0) return true;
      const compSize = buffer.readUInt32LE(pos + 18);
      const fnLen = buffer.readUInt16LE(pos + 26);
      const extraLen = buffer.readUInt16LE(pos + 28);
      pos += 30 + fnLen + extraLen + compSize;
    } else {
      break;
    }
  }
  let cdPos = 0;
  while (cdPos + 46 <= buffer.length) {
    const nextCd = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), cdPos);
    if (nextCd === -1) break;
    const flags = buffer.readUInt16LE(nextCd + 8);
    if ((flags & 0x0041) !== 0) return true;
    const fnLen = buffer.readUInt16LE(nextCd + 28);
    const extraLen = buffer.readUInt16LE(nextCd + 30);
    const commentLen = buffer.readUInt16LE(nextCd + 32);
    cdPos = nextCd + 46 + fnLen + extraLen + commentLen;
  }
  return false;
}

export async function extractZipArchive(
  zipBuffer: Buffer,
  options: {
    password?: string;
    entries?: string[];
    /** Encrypted archives only: leave link entries out and report them through `onSkippedLinks`. */
    skipLinks?: boolean;
    onSkippedLinks?: (names: string[]) => void;
    collisionPolicy?: ArchiveCollisionPolicy;
  } = {}
): Promise<{ filename: string; buffer: Buffer }[]> {
  assertArchivePasswordSafe(options.password);

  // An archive with an encrypted central directory cannot be parsed here, so the header scan decides first; an entry
  // flagged encrypted only in the central directory (the authority) still sends the archive to the password path.
  let directory: ZipDirectory | undefined;
  let isEncrypted = isZipBufferEncrypted(zipBuffer);
  if (!isEncrypted) {
    directory = readZipDirectory(zipBuffer, ARCHIVE_SECURITY_LIMITS);
    isEncrypted = zipDirectoryHasEncryptedEntry(directory);
  }
  if (isEncrypted) {
    if (!options.password) {
      throw new ArchivePasswordRequiredError('ZIP archive is password protected. A password is required to extract.');
    }
    const p7z = get7zBinaryPath();
    if (p7z) {
      const tmpDir = os.tmpdir();
      const token = crypto.randomBytes(8).toString('hex');
      const workDir = path.join(tmpDir, `easyconvert_pw_${Date.now()}_${token}`);
      fs.mkdirSync(workDir, { recursive: true });
      try {
        const zipPath = path.join(workDir, 'archive.zip');
        fs.writeFileSync(zipPath, zipBuffer);
        const extractDir = path.join(workDir, 'out');
        fs.mkdirSync(extractDir, { recursive: true });

        // List, vet, extract and re-verify: traversal, link, entry-count, size and ratio violations
        // are rejected before or right after extraction, never silently followed.
        const tree = await extractArchiveContained({
          p7zBin: p7z,
          archivePath: zipPath,
          extractDir,
          cwd: workDir,
          timeoutMs: 60000,
          maxBuffer: ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE,
          limits: ARCHIVE_SECURITY_LIMITS,
          label: 'ZIP archive',
          password: options.password,
          skipLinks: options.skipLinks,
          collisionPolicy: options.collisionPolicy,
        }).catch((err: unknown) => {
          // Decryption has no other engine to hand duplicate entries to, so 'rename' cannot be honoured here.
          if (err instanceof NativeRenameUnsupportedError) {
            throw new ArchiveEntryCollisionError(
              err.reason,
              `${err.message}; use collisionPolicy 'overwrite' or 'error' for password-protected ZIP archives.`
            );
          }
          throw err;
        });
        options.onSkippedLinks?.(tree.skippedLinks);

        const results: { filename: string; buffer: Buffer }[] = [];
        for (const file of tree.files) {
          if (matchArchiveGlob(file.relPath, options.entries)) {
            results.push({ filename: file.relPath, buffer: fs.readFileSync(file.absPath) });
          }
        }
        return results;
      } finally {
        cleanupDirectoryTree(workDir);
      }
    } else {
      throw new ConversionFailedError('Cannot extract encrypted ZIP archive: 7-Zip binary not available.');
    }
  }

  const files = await readZipFiles(zipBuffer, directory ?? readZipDirectory(zipBuffer, ARCHIVE_SECURITY_LIMITS), {
    limits: ARCHIVE_SECURITY_LIMITS,
    select: (name) => matchArchiveGlob(name, options.entries),
    skipLinks: options.skipLinks,
    onSkippedLinks: options.onSkippedLinks,
  });
  return resolveArchiveEntryCollisions(files, options.collisionPolicy || 'rename');
}

// ---------------------------------------------------------------------------
// POSIX pax/ustar (IEEE 1003.1) TAR writer and reader
// ---------------------------------------------------------------------------

const TAR_BLOCK_SIZE = 512;
const TAR_OFFSET_NAME = 0;
const TAR_LENGTH_NAME = 100;
const TAR_OFFSET_MODE = 100;
const TAR_LENGTH_MODE = 8;
const TAR_OFFSET_UID = 108;
const TAR_OFFSET_GID = 116;
const TAR_LENGTH_ID = 8;
const TAR_OFFSET_SIZE = 124;
const TAR_LENGTH_SIZE = 12;
const TAR_OFFSET_MTIME = 136;
const TAR_LENGTH_MTIME = 12;
const TAR_OFFSET_CHECKSUM = 148;
const TAR_LENGTH_CHECKSUM = 8;
const TAR_OFFSET_TYPEFLAG = 156;
const TAR_OFFSET_LINKNAME = 157;
const TAR_LENGTH_LINKNAME = 100;
const TAR_OFFSET_MAGIC = 257;
const TAR_LENGTH_MAGIC = 6;
const TAR_OFFSET_VERSION = 263;
const TAR_LENGTH_VERSION = 2;
const TAR_OFFSET_DEVMAJOR = 329;
const TAR_OFFSET_DEVMINOR = 337;
const TAR_OFFSET_PREFIX = 345;
const TAR_LENGTH_PREFIX = 155;
const TAR_USTAR_MAGIC = 'ustar\0';
const TAR_USTAR_VERSION = '00';
const TAR_CHECKSUM_SPACE = 0x20;
const TAR_OCTAL_RADIX = 8;
/** Largest value of the 11-digit octal size/mtime fields (8 GiB - 1). */
const TAR_MAX_OCTAL_VALUE = 0o77777777777;
const TAR_BASE256_POSITIVE = 0x80;
const TAR_BASE256_NEGATIVE = 0xff;
const TAR_BITS_PER_BYTE = 8;
const TAR_BYTE_SIGN_BIT = 0x80;
const TAR_BYTE_RANGE = 0x100;
const TAR_UTF8_CONTINUATION_MASK = 0xc0;
const TAR_UTF8_CONTINUATION_BITS = 0x80;
const TAR_ASCII_LIMIT = 0x80;
const TAR_SLASH = 0x2f;
const TAR_MAX_EXTENDED_HEADER_SIZE = 1024 * 1024;
const TAR_PAX_HEADER_NAME_PREFIX = 'PaxHeaders.0/';
const TAR_DEFAULT_FILE_MODE = 0o644;
const TAR_DEFAULT_DIRECTORY_MODE = 0o755;
const TAR_PERMISSION_MASK = 0o7777;
const TAR_ZERO_DIGIT = '0';
const TAR_MS_PER_SECOND = 1000;
const TAR_MAX_PAX_NUMBER_DIGITS = 18;
const TAR_PAX_MAX_LENGTH_DIGITS = 15;
const TAR_PAX_NEWLINE = 0x0a;
const TAR_PAX_EQUALS = 0x3d;
/** A record is "<digits> <key>=<value>\n": at least a space, a one-byte key, '=' and a newline follow the digits. */
const TAR_PAX_MIN_RECORD_TAIL = 4;
const TAR_PAX_LENGTH_PATTERN = new RegExp(`^\\d{1,${TAR_PAX_MAX_LENGTH_DIGITS}}$`);
const TAR_PAX_INTEGER_PATTERN = new RegExp(`^\\d{1,${TAR_MAX_PAX_NUMBER_DIGITS}}$`);
const TAR_PAX_DECIMAL_PATTERN = /^-?\d{1,18}(\.\d{1,18})?$/;
/** Longest entry path or link target accepted (twice Linux PATH_MAX); bounds per-entry symlink checks. */
const TAR_MAX_PATH_LENGTH = 8192;
/** Deterministic default modification time (Unix epoch) used when the input carries no metadata. */
export const TAR_DEFAULT_MTIME_SECONDS = 0;

const TAR_TYPEFLAG_PAX_LOCAL = 'x';
const TAR_TYPEFLAG_PAX_GLOBAL = 'g';
const TAR_TYPEFLAG_GNU_LONGNAME = 'L';
const TAR_TYPEFLAG_GNU_LONGLINK = 'K';
const TAR_TYPEFLAG_HARDLINK = '1';
const TAR_TYPEFLAG_SYMLINK = '2';
const TAR_TYPEFLAG_DIRECTORY = '5';
/** GNU extensions that carry file content the reader cannot reconstruct, so they must not be skipped. */
const TAR_UNSUPPORTED_CONTENT_TYPEFLAGS = new Set(['S', 'M']);
/** Regular file typeflags: '0', NUL (pre-POSIX) and '7' (contiguous file, extracted as a regular file). */
const TAR_REGULAR_TYPEFLAGS = new Set([TAR_ZERO_DIGIT, '\0', '7']);
const TAR_EXTENSION_TYPEFLAGS = new Set([
  TAR_TYPEFLAG_PAX_LOCAL,
  TAR_TYPEFLAG_PAX_GLOBAL,
  TAR_TYPEFLAG_GNU_LONGNAME,
  TAR_TYPEFLAG_GNU_LONGLINK,
]);
/** POSIX reserves the uppercase letters A-Z for vendor extensions. */
const TAR_VENDOR_TYPEFLAG = /^[A-Z]$/;
const TAR_SPECIAL_TYPES = new Map<string, TarEntryType>([
  ['3', 'character-device'],
  ['4', 'block-device'],
  ['6', 'fifo'],
]);

export type TarEntryType =
  | 'file'
  | 'directory'
  | 'symlink'
  | 'hardlink'
  | 'character-device'
  | 'block-device'
  | 'fifo';

/** One entry as stored in a TAR archive. `filename` is sanitized; directories carry no trailing slash. */
export interface TarEntry {
  filename: string;
  type: TarEntryType;
  /**
   * Entry content: a view into the archive buffer for regular files, the shared content of the linked
   * file for hardlinks, and empty for everything else.
   */
  buffer: Buffer;
  /** Link target for `symlink` and `hardlink` entries. */
  linkTarget?: string;
  mode: number;
  uid: number;
  gid: number;
  /** Modification time in seconds since the epoch (fractional when a pax `mtime` record says so). */
  mtime: number;
}

export interface TarWriteInput {
  /** Entry path; a trailing slash marks a directory entry (typeflag 5, empty buffer). */
  filename: string;
  buffer: Buffer;
  /** Modification time recorded in the header; defaults to `TarWriteOptions.defaultMtime`. */
  mtime?: Date;
  /** Permission bits; defaults to 0644 for files and 0755 for directories. */
  mode?: number;
}

export interface TarWriteOptions {
  /** Modification time for entries without their own `mtime`. Defaults to the Unix epoch. */
  defaultMtime?: Date;
}

export interface TarEntryHeaderSpec {
  filename: string;
  /** Content size in bytes; values of 8 GiB and above are carried in a pax `size` record. */
  size: number | bigint;
  mtime?: Date;
  mode?: number;
  /** Whether the entry is a directory; when absent, a trailing slash in `filename` decides. A file never ends with a slash. */
  directory?: boolean;
}

function tarWriteError(message: string): ConversionFailedError {
  return new ConversionFailedError(`Cannot write TAR archive: ${message}`);
}

function tarReadError(message: string): ConversionFailedError {
  return new ConversionFailedError(`Invalid TAR archive: ${message}`);
}

function putTarOctal(header: Buffer, offset: number, width: number, value: number | bigint): void {
  const digits = value.toString(TAR_OCTAL_RADIX).padStart(width - 1, TAR_ZERO_DIGIT);
  header.write(`${digits}\0`, offset, width, 'ascii');
}

/** Builds one pax record `<len> <key>=<value>\n`, where len counts its own digits. */
function buildPaxRecord(key: string, value: string): Buffer {
  const body = Buffer.from(` ${key}=${value}\n`, 'utf8');
  let digits = 1;
  for (;;) {
    const total = body.length + digits;
    if (String(total).length === digits) {
      return Buffer.concat([Buffer.from(String(total), 'ascii'), body]);
    }
    digits++;
  }
}

function sealTarHeaderChecksum(header: Buffer): void {
  header.fill(TAR_CHECKSUM_SPACE, TAR_OFFSET_CHECKSUM, TAR_OFFSET_CHECKSUM + TAR_LENGTH_CHECKSUM);
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK_SIZE; i++) sum += header[i];
  const digits = sum.toString(TAR_OCTAL_RADIX).padStart(TAR_LENGTH_CHECKSUM - 2, TAR_ZERO_DIGIT);
  header.write(`${digits}\0 `, TAR_OFFSET_CHECKSUM, TAR_LENGTH_CHECKSUM, 'ascii');
}

interface TarHeaderFields {
  nameField: Buffer;
  prefixField: Buffer;
  mode: number;
  size: number | bigint;
  mtime: number;
  typeflag: string;
}

function buildTarHeaderBlock(fields: TarHeaderFields): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  fields.nameField.copy(header, TAR_OFFSET_NAME);
  putTarOctal(header, TAR_OFFSET_MODE, TAR_LENGTH_MODE, fields.mode);
  putTarOctal(header, TAR_OFFSET_UID, TAR_LENGTH_ID, 0);
  putTarOctal(header, TAR_OFFSET_GID, TAR_LENGTH_ID, 0);
  putTarOctal(header, TAR_OFFSET_SIZE, TAR_LENGTH_SIZE, fields.size);
  putTarOctal(header, TAR_OFFSET_MTIME, TAR_LENGTH_MTIME, fields.mtime);
  header.write(fields.typeflag, TAR_OFFSET_TYPEFLAG, 1, 'ascii');
  header.write(TAR_USTAR_MAGIC, TAR_OFFSET_MAGIC, TAR_LENGTH_MAGIC, 'ascii');
  header.write(TAR_USTAR_VERSION, TAR_OFFSET_VERSION, TAR_LENGTH_VERSION, 'ascii');
  putTarOctal(header, TAR_OFFSET_DEVMAJOR, TAR_LENGTH_MODE, 0);
  putTarOctal(header, TAR_OFFSET_DEVMINOR, TAR_LENGTH_MODE, 0);
  fields.prefixField.copy(header, TAR_OFFSET_PREFIX);
  sealTarHeaderChecksum(header);
  return header;
}

/** Cuts UTF-8 bytes to at most `limit` bytes without splitting a multi-byte sequence. */
function fitUtf8(bytes: Buffer, limit: number): Buffer {
  if (bytes.length <= limit) return bytes;
  let cut = limit;
  while (cut > 0 && (bytes[cut] & TAR_UTF8_CONTINUATION_MASK) === TAR_UTF8_CONTINUATION_BITS) cut--;
  return bytes.subarray(0, cut);
}

interface TarNamePlan {
  nameField: Buffer;
  prefixField: Buffer;
  /** Full path for a pax `path` record when the ustar fields cannot carry the name. */
  paxPath: string | null;
}

/**
 * Chooses how a path is stored: the ustar name/prefix split (prefix <= 155 bytes, name <= 100 bytes,
 * split at '/') when it fits and is pure ASCII, otherwise a pax `path` record plus a best-effort
 * shortened ustar name for readers that ignore pax headers.
 */
function planTarEntryName(fullPath: string): TarNamePlan {
  const bytes = Buffer.from(fullPath, 'utf8');
  const isAscii = bytes.every((b) => b < TAR_ASCII_LIMIT);
  const empty = Buffer.alloc(0);
  if (isAscii && bytes.length <= TAR_LENGTH_NAME) {
    return { nameField: bytes, prefixField: empty, paxPath: null };
  }
  if (isAscii) {
    for (let i = bytes.indexOf(TAR_SLASH); i !== -1; i = bytes.indexOf(TAR_SLASH, i + 1)) {
      const nameLength = bytes.length - i - 1;
      if (nameLength === 0 || i > TAR_LENGTH_PREFIX) break;
      if (nameLength <= TAR_LENGTH_NAME) {
        return { nameField: bytes.subarray(i + 1), prefixField: bytes.subarray(0, i), paxPath: null };
      }
    }
  }
  return { nameField: fitUtf8(bytes, TAR_LENGTH_NAME), prefixField: empty, paxPath: fullPath };
}

function tarPadding(length: number): number {
  return (TAR_BLOCK_SIZE - (length % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
}

function normalizeTarWriteName(filename: string, directory: boolean): string {
  if (filename.includes('\0')) throw tarWriteError('entry name contains a NUL byte');
  const trimmed = trimTrailingSlashes(filename);
  if (!trimmed) throw tarWriteError('entry name is empty');
  const fullPath = directory ? `${trimmed}/` : trimmed;
  if (fullPath.length > TAR_MAX_PATH_LENGTH) {
    throw tarWriteError(`entry name is longer than ${TAR_MAX_PATH_LENGTH} characters`);
  }
  return fullPath;
}

/**
 * Builds the header blocks of one entry: an optional pax `x` extension header (with its data)
 * followed by the ustar header. The caller appends the block-padded content.
 * @internal exported so oversized (>= 8 GiB) entries can be verified without allocating their body.
 */
export function buildTarEntryHeaders(spec: TarEntryHeaderSpec): Buffer {
  if (spec.directory === false && spec.filename.endsWith('/')) {
    throw tarWriteError(`file entry '${spec.filename}' ends with a slash, which names a directory`);
  }
  const directory = spec.directory ?? spec.filename.endsWith('/');
  const fullPath = normalizeTarWriteName(spec.filename, directory);
  const size = directory ? 0 : spec.size;
  if (typeof size === 'number' ? !Number.isSafeInteger(size) || size < 0 : size < 0n) {
    throw tarWriteError('entry size must be a non-negative integer');
  }
  const mtimeDate = spec.mtime ?? new Date(TAR_DEFAULT_MTIME_SECONDS * TAR_MS_PER_SECOND);
  if (Number.isNaN(mtimeDate.getTime())) throw tarWriteError(`invalid modification time for '${fullPath}'`);
  const mtimeSeconds = Math.floor(mtimeDate.getTime() / TAR_MS_PER_SECOND);
  const defaultMode = directory ? TAR_DEFAULT_DIRECTORY_MODE : TAR_DEFAULT_FILE_MODE;
  const mode = (spec.mode ?? defaultMode) & TAR_PERMISSION_MASK;

  const plan = planTarEntryName(fullPath);
  const records: Buffer[] = [];
  if (plan.paxPath !== null) records.push(buildPaxRecord('path', plan.paxPath));

  let ustarSize: number | bigint = size;
  if (BigInt(size) > BigInt(TAR_MAX_OCTAL_VALUE)) {
    records.push(buildPaxRecord('size', String(size)));
    ustarSize = TAR_MAX_OCTAL_VALUE;
  }
  let ustarMtime = mtimeSeconds;
  if (mtimeSeconds < 0 || mtimeSeconds > TAR_MAX_OCTAL_VALUE) {
    records.push(buildPaxRecord('mtime', String(mtimeSeconds)));
    ustarMtime = 0;
  }

  const entryHeader = buildTarHeaderBlock({
    nameField: plan.nameField,
    prefixField: plan.prefixField,
    mode,
    size: ustarSize,
    mtime: ustarMtime,
    typeflag: directory ? TAR_TYPEFLAG_DIRECTORY : TAR_ZERO_DIGIT,
  });
  if (records.length === 0) return entryHeader;

  const paxData = Buffer.concat(records);
  const baseName = trimTrailingSlashes(fullPath).split('/').pop() ?? '';
  const safeBase = baseName.replace(/[^A-Za-z0-9._-]/g, '_');
  const paxName = Buffer.from(`${TAR_PAX_HEADER_NAME_PREFIX}${safeBase}`, 'ascii');
  const paxHeader = buildTarHeaderBlock({
    nameField: fitUtf8(paxName, TAR_LENGTH_NAME),
    prefixField: Buffer.alloc(0),
    mode: TAR_DEFAULT_FILE_MODE,
    size: paxData.length,
    mtime: ustarMtime,
    typeflag: TAR_TYPEFLAG_PAX_LOCAL,
  });
  return Buffer.concat([paxHeader, paxData, Buffer.alloc(tarPadding(paxData.length)), entryHeader]);
}

export function createTarArchive(
  files: TarWriteInput[],
  options: ConversionOptions = {},
  archiveName = 'converted_files.tar',
  tarOptions: TarWriteOptions = {}
): ConversionResult {
  if (options.password) {
    throw new UnsupportedOptionError('TAR archives do not support password encryption.');
  }
  const resolvedFiles = resolveArchiveEntryCollisions(files, options.collisionPolicy || 'rename');
  const blocks: Buffer[] = [];

  for (const file of resolvedFiles) {
    const directory = file.filename.endsWith('/');
    if (directory && file.buffer.length > 0) {
      throw tarWriteError(`directory entry '${file.filename}' must not carry content`);
    }
    blocks.push(
      buildTarEntryHeaders({
        filename: file.filename,
        size: file.buffer.length,
        mtime: file.mtime ?? tarOptions.defaultMtime,
        mode: file.mode,
        directory,
      })
    );
    if (!directory) {
      blocks.push(file.buffer);
      const pad = tarPadding(file.buffer.length);
      if (pad > 0) blocks.push(Buffer.alloc(pad));
    }
  }

  // End of archive marker: two 512-byte zero blocks
  blocks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2));
  const buffer = Buffer.concat(blocks);

  return {
    buffer,
    mimeType: 'application/x-tar',
    filename: archiveName,
    size: buffer.length,
  };
}

const EMPTY_TAR_BODY = Buffer.alloc(0);
const TAR_OCTAL_DIGIT_MAX = 0x37; // '7'
const TAR_OCTAL_DIGIT_MIN = 0x30; // '0'
const TAR_NUL = 0;
const TAR_SIGN_BIT_SHIFT = 7;

/** True when every byte of `buf[start, end)` is zero; a non-zero block exits at its first byte. */
function isZeroTarRange(buf: Buffer, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

/** Decodes the NUL-terminated UTF-8 string stored in `buf[offset, offset + length)`. */
function readTarString(buf: Buffer, offset: number, length: number): string {
  const limit = offset + length;
  let end = offset;
  while (end < limit && buf[end] !== TAR_NUL) end++;
  return buf.toString('utf8', offset, end);
}

function readTarNumberField(
  buf: Buffer,
  offset: number,
  length: number,
  label: string,
  allowNegative = false
): number {
  if ((buf[offset] & TAR_BASE256_POSITIVE) !== 0) {
    return parseTarBase256(buf.subarray(offset, offset + length), label, allowNegative);
  }
  return parseTarOctal(buf, offset, length, label);
}

/** Decodes a base-256 (GNU/star extension) numeric field; the first byte carries the sign marker. */
function parseTarBase256(field: Buffer, label: string, allowNegative: boolean): number {
  let value = 0n;
  for (const byte of field) value = (value << BigInt(TAR_BITS_PER_BYTE)) | BigInt(byte);
  const bits = field.length * TAR_BITS_PER_BYTE;
  if (field[0] === TAR_BASE256_NEGATIVE) {
    value = BigInt.asIntN(bits, value);
  } else if (field[0] === TAR_BASE256_POSITIVE) {
    value &= (1n << BigInt(bits - 1)) - 1n;
  } else {
    throw tarReadError(`malformed base-256 ${label} field`);
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw tarReadError(`${label} value exceeds the supported range`);
  }
  if (value < 0n && !allowNegative) throw tarReadError(`negative ${label} field`);
  return Number(value);
}

function isTarFieldPadding(byte: number): boolean {
  return byte === TAR_CHECKSUM_SPACE || byte === TAR_NUL;
}

/**
 * Decodes an octal numeric field byte by byte: leading spaces/NULs are skipped, digits run to the
 * first space or NUL (anything after that terminator is ignored), and any other byte is malformed.
 */
function parseTarOctal(buf: Buffer, offset: number, length: number, label: string): number {
  const limit = offset + length;
  let pos = offset;
  while (pos < limit && isTarFieldPadding(buf[pos])) pos++;
  let value = 0;
  while (pos < limit && !isTarFieldPadding(buf[pos])) {
    const digit = buf[pos++];
    if (digit < TAR_OCTAL_DIGIT_MIN || digit > TAR_OCTAL_DIGIT_MAX) {
      throw tarReadError(`malformed octal ${label} field`);
    }
    value = value * TAR_OCTAL_RADIX + (digit - TAR_OCTAL_DIGIT_MIN);
  }
  return value;
}

const TAR_WORD_BYTES = 4;
const TAR_LANE_MASK = 0x00ff00ff;
const TAR_SIGN_LANE_MASK = 0x01010101;
const TAR_BYTE_MASK = 0xff;
const TAR_HALF_WORD_SHIFT = 16;
const TAR_HALF_WORD_MASK = 0xffff;
const TAR_BYTE_SHIFT = 8;
const TAR_BYTE_SHIFT_2 = 16;
const TAR_BYTE_SHIFT_3 = 24;
/** Block byte-sum and high-bit count travel together as `sum * TAR_SUM_PACK + highBits` (highBits < 512). */
const TAR_SUM_PACK = 1024;

/** Packs the unsigned byte sum and the count of bytes >= 0x80 of one header block (byte-wise path). */
function sumTarBlockBytes(buf: Buffer, base: number): number {
  let sum = 0;
  let high = 0;
  const blockEnd = base + TAR_BLOCK_SIZE;
  for (let i = base; i < blockEnd; i++) {
    const byte = buf[i];
    sum += byte;
    high += byte >>> TAR_SIGN_BIT_SHIFT;
  }
  return sum * TAR_SUM_PACK + high;
}

/** Same result as `sumTarBlockBytes`, reading aligned 32-bit words and summing four byte lanes at once. */
function sumTarBlockWords(words: Uint32Array, base: number): number {
  let evenLanes = 0;
  let oddLanes = 0;
  let highLanes = 0;
  const first = base / TAR_WORD_BYTES;
  const last = first + TAR_BLOCK_SIZE / TAR_WORD_BYTES;
  for (let k = first; k < last; k++) {
    const word = words[k];
    evenLanes += word & TAR_LANE_MASK;
    oddLanes += (word >>> TAR_BYTE_SHIFT) & TAR_LANE_MASK;
    highLanes += (word >>> TAR_SIGN_BIT_SHIFT) & TAR_SIGN_LANE_MASK;
  }
  const sum =
    (evenLanes & TAR_HALF_WORD_MASK) +
    (evenLanes >>> TAR_HALF_WORD_SHIFT) +
    (oddLanes & TAR_HALF_WORD_MASK) +
    (oddLanes >>> TAR_HALF_WORD_SHIFT);
  const high =
    (highLanes & TAR_BYTE_MASK) +
    ((highLanes >>> TAR_BYTE_SHIFT) & TAR_BYTE_MASK) +
    ((highLanes >>> TAR_BYTE_SHIFT_2) & TAR_BYTE_MASK) +
    (highLanes >>> TAR_BYTE_SHIFT_3);
  return sum * TAR_SUM_PACK + high;
}

/** Verifies the header checksum; `words` is a 32-bit view of `buf` when its start is 4-byte aligned. */
function verifyTarChecksum(buf: Buffer, words: Uint32Array | null, base: number, headerIndex: number): void {
  const stored = readTarNumberField(buf, base + TAR_OFFSET_CHECKSUM, TAR_LENGTH_CHECKSUM, 'checksum');
  const packed = words === null ? sumTarBlockBytes(buf, base) : sumTarBlockWords(words, base);
  let unsigned = Math.floor(packed / TAR_SUM_PACK);
  let negativeBytes = packed % TAR_SUM_PACK;
  // The checksum field itself counts as spaces: replace what was summed for it.
  for (let i = base + TAR_OFFSET_CHECKSUM; i < base + TAR_OFFSET_CHECKSUM + TAR_LENGTH_CHECKSUM; i++) {
    const byte = buf[i];
    unsigned += TAR_CHECKSUM_SPACE - byte;
    negativeBytes -= byte >>> TAR_SIGN_BIT_SHIFT;
  }
  // Historic implementations summed signed chars; POSIX specifies the unsigned sum.
  const signed = unsigned - negativeBytes * TAR_BYTE_RANGE;
  if (stored !== unsigned && stored !== signed) {
    throw tarReadError(
      `header checksum mismatch at header ${headerIndex} (stored ${stored}, computed ${unsigned})`
    );
  }
}

const PAX_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const ASCII_MAX_BYTE = 0x7f;

/** Decodes `data[start, end)` as strict UTF-8; pure-ASCII text skips the decoder and the slice copy. */
function decodePaxText(data: Buffer, start: number, end: number): string {
  for (let i = start; i < end; i++) {
    if (data[i] > ASCII_MAX_BYTE) return PAX_UTF8_DECODER.decode(data.subarray(start, end));
  }
  return data.toString('latin1', start, end);
}

/** Parses pax records `<len> <key>=<value>\n`; throws on any malformed length or encoding. */
function parsePaxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(TAR_CHECKSUM_SPACE, pos);
    const lengthText = space === -1 ? '' : data.toString('ascii', pos, space);
    if (!TAR_PAX_LENGTH_PATTERN.test(lengthText)) throw tarReadError('malformed pax record length');
    const length = Number(lengthText);
    const end = pos + length;
    if (
      end > data.length ||
      length < lengthText.length + TAR_PAX_MIN_RECORD_TAIL ||
      data[end - 1] !== TAR_PAX_NEWLINE
    ) {
      throw tarReadError('pax record length does not match its content');
    }
    const bodyStart = space + 1;
    const bodyEnd = end - 1;
    const equals = data.indexOf(TAR_PAX_EQUALS, bodyStart);
    if (equals <= bodyStart || equals >= bodyEnd) throw tarReadError('pax record has no key');
    try {
      records.set(decodePaxText(data, bodyStart, equals), decodePaxText(data, equals + 1, bodyEnd));
    } catch {
      throw tarReadError('pax record is not valid UTF-8');
    }
    pos = end;
  }
  return records;
}

function parsePaxInteger(value: string, key: string): number {
  if (!TAR_PAX_INTEGER_PATTERN.test(value)) throw tarReadError(`invalid pax ${key} record`);
  return Number(value);
}

function parsePaxDecimal(value: string, key: string): number {
  if (!TAR_PAX_DECIMAL_PATTERN.test(value)) throw tarReadError(`invalid pax ${key} record`);
  return Number(value);
}

/** Paths of symlink entries seen so far, indexed by length so ancestor checks stay cheap. */
class TarSymlinkIndex {
  private readonly paths = new Set<string>();
  private readonly lengths = new Set<number>();

  get size(): number {
    return this.paths.size;
  }

  add(path: string): void {
    this.paths.add(path);
    this.lengths.add(path.length);
  }

  hasStack(stack: string[], joinedLength: number): boolean {
    return this.lengths.has(joinedLength) && this.paths.has(stack.join('/'));
  }
}

/**
 * Resolves `tokens` lexically from the archive root and returns the normalized path. Throws when
 * the path climbs above the root or when any component that is not the last one is a symlink seen
 * earlier in the archive (a later entry would then be written through that link).
 */
function resolveTarPath(tokens: string[], symlinks: TarSymlinkIndex, describe: string): string {
  const stack: string[] = [];
  let joinedLength = 0; // length of stack.join('/')
  for (const token of tokens) {
    if (token === '' || token === '.') continue;
    if (symlinks.size > 0 && stack.length > 0 && symlinks.hasStack(stack, joinedLength)) {
      throw tarReadError(`${describe} passes through the symlink '${stack.join('/')}'`);
    }
    joinedLength = applyTarPathToken(stack, joinedLength, token, describe);
  }
  return stack.join('/');
}

/** Pushes or pops one path component and returns the updated length of `stack.join('/')`. */
function applyTarPathToken(stack: string[], joinedLength: number, token: string, describe: string): number {
  if (token === '..') {
    const top = stack.pop();
    if (top === undefined) throw tarReadError(`${describe} escapes the extraction root`);
    return stack.length === 0 ? 0 : joinedLength - top.length - 1;
  }
  const grown = stack.length === 0 ? joinedLength + token.length : joinedLength + token.length + 1;
  stack.push(token);
  return grown;
}

/** Validates a link target and returns the root-relative path it points to. */
function resolveTarLinkTarget(
  entryName: string,
  target: string,
  kind: 'symlink' | 'hardlink',
  symlinks: TarSymlinkIndex
): string {
  if (!target) throw tarReadError(`${kind} '${entryName}' has an empty target`);
  if (target.length > TAR_MAX_PATH_LENGTH) {
    throw tarReadError(`${kind} '${entryName}' has a target longer than ${TAR_MAX_PATH_LENGTH} characters`);
  }
  const unified = target.replace(/\\/g, '/');
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) {
    throw tarReadError(`${kind} '${entryName}' targets an absolute path and escapes the extraction root`);
  }
  const baseTokens = kind === 'symlink' ? entryName.split('/').slice(0, -1) : [];
  return resolveTarPath(
    [...baseTokens, ...unified.split('/')],
    symlinks,
    `${kind} '${entryName}' target '${target}'`
  );
}

function resolveTarEntryType(typeflag: string, rawName: string): TarEntryType | null {
  if (TAR_REGULAR_TYPEFLAGS.has(typeflag)) return rawName.endsWith('/') ? 'directory' : 'file';
  if (typeflag === TAR_TYPEFLAG_DIRECTORY) return 'directory';
  if (typeflag === TAR_TYPEFLAG_HARDLINK) return 'hardlink';
  if (typeflag === TAR_TYPEFLAG_SYMLINK) return 'symlink';
  return TAR_SPECIAL_TYPES.get(typeflag) ?? null;
}

const TAR_ENTRY_TYPEFLAGS = new Set([
  ...TAR_REGULAR_TYPEFLAGS,
  TAR_TYPEFLAG_DIRECTORY,
  TAR_TYPEFLAG_HARDLINK,
  TAR_TYPEFLAG_SYMLINK,
  ...TAR_SPECIAL_TYPES.keys(),
]);

function tarBombError(message: string): ConversionFailedError {
  return new ConversionFailedError(`Archive bomb detected: ${message}`);
}

/** Header-level values of one entry that a pax record may override, captured before the pending state resets. */
interface TarEntryContext {
  rawName: string;
  linkName: string;
  paxSize: string | undefined;
  paxMtime: string | undefined;
  paxUid: string | undefined;
  paxGid: string | undefined;
}

const EMPTY_TAR_BODY_SIZE = 0;

function readTarIdField(buf: Buffer, offset: number, label: 'uid' | 'gid', paxValue: string | undefined): number {
  if (paxValue === undefined) return readTarNumberField(buf, offset, TAR_LENGTH_ID, label);
  return parsePaxInteger(paxValue, label);
}

function readTarMtimeField(buf: Buffer, offset: number, paxValue: string | undefined): number {
  if (paxValue === undefined) {
    return readTarNumberField(buf, offset, TAR_LENGTH_MTIME, 'mtime', true);
  }
  return parsePaxDecimal(paxValue, 'mtime');
}

function assertTarEntryName(rawName: string, linkName: string, headerIndex: number): void {
  if (!rawName) throw tarReadError(`header ${headerIndex} has an empty entry name`);
  if (rawName.includes('\0') || linkName.includes('\0')) {
    throw tarReadError(`header ${headerIndex} has a NUL byte in its path or link target`);
  }
  if (rawName.length > TAR_MAX_PATH_LENGTH) {
    throw tarReadError(`header ${headerIndex} has a path longer than ${TAR_MAX_PATH_LENGTH} characters`);
  }
}

/** Decodes a GNU `L`/`K` payload: the NUL-terminated UTF-8 string it carries. */
function decodeGnuLongText(data: Buffer): string {
  const nul = data.indexOf(0);
  return (nul === -1 ? data : data.subarray(0, nul)).toString('utf8');
}

/**
 * Stateful single-pass TAR reader. Per-block work goes through methods (no per-block closures) and
 * entry bodies stay views into the source buffer.
 */
class TarReader {
  private readonly entries: TarEntry[] = [];
  private readonly globalPax = new Map<string, string>();
  private globalPaxBytes = 0;
  private localPax = new Map<string, string>();
  private pendingExtensionBytes = 0;
  private longName: string | null = null;
  private longLink: string | null = null;
  private readonly contentByName = new Map<string, Buffer>();
  private readonly symlinks = new TarSymlinkIndex();
  private offset = 0;
  private totalSize = 0;
  private headerIndex = 0;
  /** Offset of the header block that `processHeader` is decoding. */
  private headerStart = 0;

  /** 32-bit view for the checksum fast path; null when the buffer start is not word-aligned. */
  private readonly words: Uint32Array | null;

  /** In listing mode every entry is recorded as stored (raw name, declared size) and nothing is sanitized or resolved. */
  private readonly listing: ListedArchiveEntry[] | null;

  /** Link entries are reported as entries but their targets are neither resolved nor tracked (the caller leaves links out). */
  private readonly ignoreLinks: boolean;

  constructor(private readonly tarBuffer: Buffer, listing: ListedArchiveEntry[] | null = null, ignoreLinks = false) {
    this.listing = listing;
    this.ignoreLinks = ignoreLinks;
    const aligned = tarBuffer.byteOffset % TAR_WORD_BYTES === 0;
    this.words = aligned
      ? new Uint32Array(tarBuffer.buffer, tarBuffer.byteOffset, Math.floor(tarBuffer.length / TAR_WORD_BYTES))
      : null;
  }

  read(): TarEntry[] {
    while (this.offset < this.tarBuffer.length) {
      if (!this.nextHeader()) break;
      this.processHeader();
      // A listing past the entry cap is already refused by the policy; reading on would only grow it.
      if (this.listing !== null && this.listing.length > ARCHIVE_SECURITY_LIMITS.MAX_FILES) break;
    }
    if (this.localPax.size > 0 || this.longName !== null || this.longLink !== null) {
      throw tarReadError('extension header is not followed by an entry');
    }
    return this.entries;
  }

  /** Verifies the next header block and records its offset; false at the end of the archive. */
  private nextHeader(): boolean {
    const buf = this.tarBuffer;
    if (this.offset + TAR_BLOCK_SIZE > buf.length) {
      if (buf.subarray(this.offset).some((b) => b !== 0)) {
        throw tarReadError('truncated archive: partial header block');
      }
      return false;
    }
    const start = this.offset;
    this.headerIndex++;

    if (isZeroTarRange(buf, start, start + TAR_BLOCK_SIZE)) {
      const nextEnd = Math.min(start + 2 * TAR_BLOCK_SIZE, buf.length);
      if (isZeroTarRange(buf, start + TAR_BLOCK_SIZE, nextEnd)) return false;
      throw tarReadError('data found after a lone zero block');
    }
    this.offset += TAR_BLOCK_SIZE;
    this.headerStart = start;
    verifyTarChecksum(buf, this.words, start, this.headerIndex);
    return true;
  }

  private processHeader(): void {
    const base = this.headerStart;
    const typeflag = String.fromCharCode(this.tarBuffer[base + TAR_OFFSET_TYPEFLAG]);
    const headerSize = readTarNumberField(this.tarBuffer, base + TAR_OFFSET_SIZE, TAR_LENGTH_SIZE, 'size');

    if (TAR_EXTENSION_TYPEFLAGS.has(typeflag)) {
      this.readExtension(typeflag, headerSize);
      return;
    }
    if (TAR_UNSUPPORTED_CONTENT_TYPEFLAGS.has(typeflag)) {
      throw tarReadError(`typeflag '${typeflag}' (sparse or multi-volume content) is not supported`);
    }
    if (TAR_ENTRY_TYPEFLAGS.has(typeflag)) {
      this.emitEntry(typeflag, headerSize);
      return;
    }
    if (!TAR_VENDOR_TYPEFLAG.test(typeflag)) {
      throw tarReadError(`unsupported typeflag ${JSON.stringify(typeflag)}`);
    }
    this.takeBody(headerSize); // vendor extension: skip its payload, keep pending pax/GNU state
  }

  private takeBody(size: number): Buffer {
    const end = this.offset + size;
    const padded = end + tarPadding(size);
    if (padded > this.tarBuffer.length) {
      throw tarReadError(
        `truncated archive: entry body needs ${padded - this.offset} bytes (including block padding) but only ${Math.max(0, this.tarBuffer.length - this.offset)} remain`
      );
    }
    const body = this.tarBuffer.subarray(this.offset, end);
    this.offset = padded;
    return body;
  }

  private checkBomb(size: number): void {
    this.totalSize += size;
    if (this.totalSize > ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
      throw tarBombError(
        `uncompressed size exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes (500MB)`
      );
    }
  }

  // --- pax / GNU extension accumulation ---

  private setGlobalPax(key: string, value: string): void {
    const previous = this.globalPax.get(key);
    if (previous !== undefined) this.globalPaxBytes -= Buffer.byteLength(key) + Buffer.byteLength(previous);
    if (value === '') {
      this.globalPax.delete(key); // POSIX.1-2008: an empty value cancels the keyword
      return;
    }
    this.globalPaxBytes += Buffer.byteLength(key) + Buffer.byteLength(value);
    if (this.globalPaxBytes > TAR_MAX_EXTENDED_HEADER_SIZE) {
      throw tarReadError(`global pax records exceed ${TAR_MAX_EXTENDED_HEADER_SIZE} bytes`);
    }
    this.globalPax.set(key, value);
  }

  /** Local record wins; an empty local value cancels the keyword for this entry (POSIX.1-2008). */
  private pax(key: string): string | undefined {
    if (this.localPax.size === 0 && this.globalPax.size === 0) return undefined;
    const local = this.localPax.get(key);
    if (local !== undefined) return local === '' ? undefined : local;
    return this.globalPax.get(key);
  }

  private chargeExtensionBytes(headerSize: number): void {
    this.pendingExtensionBytes += headerSize;
    if (this.pendingExtensionBytes > TAR_MAX_EXTENDED_HEADER_SIZE) {
      throw tarReadError(
        `extension headers before one entry exceed ${TAR_MAX_EXTENDED_HEADER_SIZE} bytes in total`
      );
    }
  }

  private readExtension(typeflag: string, headerSize: number): void {
    const isGlobal = typeflag === TAR_TYPEFLAG_PAX_GLOBAL;
    if (headerSize > TAR_MAX_EXTENDED_HEADER_SIZE) {
      throw tarReadError(`extended header of ${headerSize} bytes exceeds the supported size`);
    }
    if (!isGlobal) this.chargeExtensionBytes(headerSize);
    const data = this.takeBody(headerSize);
    if (typeflag === TAR_TYPEFLAG_GNU_LONGNAME) {
      this.longName = decodeGnuLongText(data);
    } else if (typeflag === TAR_TYPEFLAG_GNU_LONGLINK) {
      this.longLink = decodeGnuLongText(data);
    } else {
      this.applyPaxRecords(data, isGlobal);
    }
  }

  private applyPaxRecords(data: Buffer, isGlobal: boolean): void {
    for (const [key, value] of parsePaxRecords(data)) {
      if (key.startsWith('GNU.sparse.')) throw tarReadError('sparse files are not supported');
      if (isGlobal) this.setGlobalPax(key, value);
      else this.localPax.set(key, value);
    }
  }

  // --- entry decoding and emission ---

  /** Captures the names and pax overrides for one entry and clears the pending extension state. */
  private consumeEntryContext(typeflag: string): TarEntryContext {
    const buf = this.tarBuffer;
    const base = this.headerStart;
    const magic = buf.toString('latin1', base + TAR_OFFSET_MAGIC, base + TAR_OFFSET_MAGIC + TAR_LENGTH_MAGIC);
    const prefix =
      magic === TAR_USTAR_MAGIC ? readTarString(buf, base + TAR_OFFSET_PREFIX, TAR_LENGTH_PREFIX) : '';
    const ustarName = readTarString(buf, base + TAR_OFFSET_NAME, TAR_LENGTH_NAME);
    const context: TarEntryContext = {
      rawName: this.pax('path') ?? this.longName ?? (prefix ? `${prefix}/${ustarName}` : ustarName),
      linkName: this.pax('linkpath') ?? this.longLink ?? this.headerLinkName(typeflag),
      paxSize: this.pax('size'),
      paxMtime: this.pax('mtime'),
      paxUid: this.pax('uid'),
      paxGid: this.pax('gid'),
    };
    if (this.localPax.size > 0) this.localPax = new Map();
    this.longName = null;
    this.longLink = null;
    this.pendingExtensionBytes = 0;
    return context;
  }

  /** The ustar link-name field only matters for link entries; other types skip decoding it. */
  private headerLinkName(typeflag: string): string {
    if (typeflag !== TAR_TYPEFLAG_HARDLINK && typeflag !== TAR_TYPEFLAG_SYMLINK) return '';
    return readTarString(this.tarBuffer, this.headerStart + TAR_OFFSET_LINKNAME, TAR_LENGTH_LINKNAME);
  }

  private entryBodySize(type: TarEntryType, headerSize: number, paxSize: string | undefined): number {
    // Only regular files own a body; directories, links and special files ignore the size field.
    if (type !== 'file') return EMPTY_TAR_BODY_SIZE;
    const bodySize = paxSize === undefined ? headerSize : parsePaxInteger(paxSize, 'size');
    this.checkBomb(bodySize);
    return bodySize;
  }

  /** Registers a link entry; returns the shared content for a hardlink, null for a symlink. */
  private registerLink(filename: string, linkName: string, type: 'symlink' | 'hardlink'): Buffer | null {
    const resolved = resolveTarLinkTarget(filename, linkName, type, this.symlinks);
    if (type === 'symlink') {
      this.symlinks.add(filename);
      return null;
    }
    const target = this.contentByName.get(resolved);
    if (!target) {
      throw tarReadError(`hardlink '${filename}' points to '${linkName}', which is not an earlier file entry`);
    }
    this.checkBomb(target.length);
    return target;
  }

  private emitEntry(typeflag: string, headerSize: number): void {
    const buf = this.tarBuffer;
    const base = this.headerStart;
    const context = this.consumeEntryContext(typeflag);
    const { rawName, linkName } = context;
    assertTarEntryName(rawName, linkName, this.headerIndex);
    const type = resolveTarEntryType(typeflag, rawName);
    if (type === null) throw tarReadError(`unsupported typeflag ${JSON.stringify(typeflag)}`);

    const bodySize = this.entryBodySize(type, headerSize, context.paxSize);
    if (this.entries.length >= ARCHIVE_SECURITY_LIMITS.MAX_FILES) {
      throw tarBombError(`file count exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_FILES}`);
    }
    let body = type === 'file' ? this.takeBody(bodySize) : EMPTY_TAR_BODY;

    if (this.listing !== null) {
      this.listing.push(listedTarEntry(rawName, type, bodySize));
      return;
    }
    const filename = sanitizeArchivePath(rawName);
    if (!filename) return;

    if (this.symlinks.size > 0) resolveTarPath(filename.split('/'), this.symlinks, `entry '${filename}'`);
    const isLink = type === 'symlink' || type === 'hardlink';
    if (isLink && !this.ignoreLinks) body = this.registerLink(filename, linkName, type) ?? body;
    if (type === 'file' || type === 'hardlink') this.contentByName.set(filename, body);

    this.entries.push({
      filename,
      type,
      buffer: body,
      linkTarget: isLink ? linkName : undefined,
      mode: readTarNumberField(buf, base + TAR_OFFSET_MODE, TAR_LENGTH_MODE, 'mode'),
      uid: readTarIdField(buf, base + TAR_OFFSET_UID, 'uid', context.paxUid),
      gid: readTarIdField(buf, base + TAR_OFFSET_GID, 'gid', context.paxGid),
      mtime: readTarMtimeField(buf, base + TAR_OFFSET_MTIME, context.paxMtime),
    });
  }
}

const TAR_SPECIAL_ENTRY_TYPES: ReadonlySet<TarEntryType> = new Set(['character-device', 'block-device', 'fifo']);

function listedTarEntry(rawName: string, type: TarEntryType, bodySize: number): ListedArchiveEntry {
  let linkKind: ListedArchiveEntry['linkKind'] = null;
  if (type === 'symlink' || type === 'hardlink') linkKind = type;
  return {
    path: rawName,
    isDirectory: type === 'directory',
    sizeBytes: bodySize,
    linkKind,
    isSpecial: TAR_SPECIAL_ENTRY_TYPES.has(type),
  };
}

/**
 * Lists every entry of a TAR archive as stored, for the extraction policy: the names are the raw header names (a
 * traversing or absolute name is reported, not repaired), sizes are the declared sizes, and links and device entries
 * are flagged. Header checksums, truncation and the size cap are checked exactly as `readTarEntries` checks them.
 */
export function listTarEntries(tarBuffer: Buffer): ListedArchiveEntry[] {
  const listing: ListedArchiveEntry[] = [];
  new TarReader(tarBuffer, listing).read();
  return listing;
}

/**
 * Reads every entry of a POSIX ustar/pax (and GNU long-name) TAR archive.
 *
 * Verifies each header checksum, honours typeflags `0`/NUL/`7` (file), `5` (directory), `1`/`2`
 * (links, contained in the root), `x`/`g` (pax local/global records), `L`/`K` (GNU long name/link),
 * decodes base-256 numbers, detects truncated bodies, and stops at two consecutive zero blocks.
 * Vendor-extension typeflags (A-Z) are skipped except the content-bearing GNU `S`/`M`; every other
 * unknown typeflag is rejected with a ConversionFailedError.
 *
 * Entry buffers are views into `tarBuffer` (no copy); a hardlink entry shares the buffer of the
 * earlier file it points to. Hardlink content counts against the same uncompressed-size budget as
 * regular files. Entries that would be written through an earlier symlink are rejected. With `ignoreLinks`, link
 * entries are returned without their targets being resolved or tracked, for a caller that leaves every link out.
 */
export function readTarEntries(tarBuffer: Buffer, options: { ignoreLinks?: boolean } = {}): TarEntry[] {
  return new TarReader(tarBuffer, null, options.ignoreLinks === true).read();
}

/**
 * Extracts the regular files of a TAR archive. A hardlink yields the content of the earlier file
 * it points to (counted against the uncompressed-size budget); directories, symlinks and
 * device/fifo entries carry no data and are not returned (use `readTarEntries` to inspect them).
 * Only the entries that are returned are copied out of `tarBuffer`.
 */
export function extractTarArchive(
  tarBuffer: Buffer,
  options: { entries?: string[] } = {}
): { filename: string; buffer: Buffer }[] {
  const files: { filename: string; buffer: Buffer }[] = [];
  const copies = new Map<Buffer, Buffer>();

  for (const entry of readTarEntries(tarBuffer)) {
    if (entry.type !== 'file' && entry.type !== 'hardlink') continue;
    if (!matchArchiveGlob(entry.filename, options.entries)) continue;
    let copy = copies.get(entry.buffer);
    if (!copy) {
      copy = Buffer.from(entry.buffer);
      copies.set(entry.buffer, copy);
    }
    files.push({ filename: entry.filename, buffer: copy });
  }

  return files;
}

export function createRarArchive(
  files: { filename: string; buffer: Buffer }[],
  _options: ConversionOptions = {},
  _archiveName = 'converted_files.rar'
): ConversionResult {
  if (Array.isArray(files)) {
    throw new ConversionFailedError(
      "Target archive format 'rar' creation is not supported. RAR archive creation has been removed per D8; please use ZIP, 7z, or TAR."
    );
  }
  throw new ConversionFailedError(
    "Target archive format 'rar' creation is not supported. RAR archive creation has been removed per D8; please use ZIP, 7z, or TAR."
  );
}

let resolvedUnrarPath: string | null = null;
export function getUnrarBinaryPath(): string | null {
  if (resolvedUnrarPath !== null) return resolvedUnrarPath || null;
  const envPath = process.env.UNRAR_PATH;
  if (envPath && fs.existsSync(envPath)) {
    resolvedUnrarPath = envPath;
    return envPath;
  }
  const fixedLocations = [
    '/usr/bin/unrar',
    '/usr/local/bin/unrar',
    '/opt/homebrew/bin/unrar',
    '/bin/unrar',
    '/usr/bin/rar',
  ];
  for (const loc of fixedLocations) {
    if (fs.existsSync(loc)) {
      resolvedUnrarPath = loc;
      return loc;
    }
  }
  const whichBins = ['/usr/bin/which', '/bin/which'];
  for (const whichBin of whichBins) {
    if (fs.existsSync(whichBin)) {
      try {
        const out = execFileSync(whichBin, ['unrar'], { stdio: 'pipe' }).toString().trim();
        if (out && fs.existsSync(out)) {
          resolvedUnrarPath = out;
          return out;
        }
      } catch {}
    }
  }
  resolvedUnrarPath = '';
  return null;
}

export function extractRarArchive(
  rarBuffer: Buffer,
  options: { password?: string; entries?: string[] } = {}
): { filename: string; buffer: Buffer }[] {
  if (!rarBuffer || rarBuffer.length < 14) {
    throw new CorruptStreamError('Invalid RAR archive: buffer too small');
  }

  const isRar4 =
    rarBuffer[0] === 0x52 &&
    rarBuffer[1] === 0x61 &&
    rarBuffer[2] === 0x72 &&
    rarBuffer[3] === 0x21 &&
    rarBuffer[4] === 0x1a &&
    rarBuffer[5] === 0x07 &&
    rarBuffer[6] === 0x00;

  const isRar5 =
    rarBuffer[0] === 0x52 &&
    rarBuffer[1] === 0x61 &&
    rarBuffer[2] === 0x72 &&
    rarBuffer[3] === 0x21 &&
    rarBuffer[4] === 0x1a &&
    rarBuffer[5] === 0x07 &&
    rarBuffer[6] === 0x01 &&
    rarBuffer[7] === 0x00;

  if (!isRar4 && !isRar5) {
    throw new CorruptStreamError('Invalid RAR archive: signature mismatch');
  }

  assertArchivePasswordSafe(options.password);

  // If unrar binary is available on the system, execute under defensive limits
  const unrarBin = getUnrarBinaryPath();
  if (unrarBin) {
    const tmpDir = os.tmpdir();
    const token = crypto.randomBytes(8).toString('hex');
    const tmpFile = path.join(tmpDir, `easyconvert_rar_${Date.now()}_${token}.rar`);
    const extractDir = path.join(tmpDir, `easyconvert_rar_out_${Date.now()}_${token}`);
    fs.writeFileSync(tmpFile, rarBuffer);
    fs.mkdirSync(extractDir, { recursive: true });

    try {
      const pwArgs = options.password ? ['-p'] : ['-p-'];
      try {
        // -idq keeps error text on stderr so a password failure can be told from other failures.
        const resolved = resolveSandboxedCommand(unrarBin, ['x', '-idq', '-y', ...pwArgs, tmpFile, extractDir], {
          networkIsolated: true,
        });
        const unrarOptions = {
          cwd: extractDir,
          env: getSanitizedEnvironment({}, true),
          timeout: UNRAR_EXTRACT_TIMEOUT_MS,
          maxBuffer: ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE,
        };
        if (options.password) {
          execFileSyncWithPasswordStdin(resolved.binary, resolved.args, {
            ...unrarOptions,
            input: Buffer.from(`${options.password}\n`, 'utf-8'),
          });
        } else {
          execFileSync(resolved.binary, resolved.args, unrarOptions);
        }
      } catch (err: any) {
        throw archivePasswordError(err, { password: options.password, label: 'RAR archive', tool: 'unrar' }) ?? err;
      }

      const extracted: { filename: string; buffer: Buffer }[] = [];
      let totalUncompressedSize = 0;

      function walkDir(dir: string, base: string) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relPath = base ? `${base}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            walkDir(fullPath, relPath);
          } else if (entry.isFile()) {
            if (extracted.length >= ARCHIVE_SECURITY_LIMITS.MAX_FILES) {
              throw new DecompressionLimitError(`Archive bomb detected: file count exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_FILES}`);
            }
            const buf = fs.readFileSync(fullPath);
            totalUncompressedSize += buf.length;
            if (totalUncompressedSize > ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
              throw new DecompressionLimitError(`Archive bomb detected: uncompressed size exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes (500MB)`);
            }
            if (rarBuffer.length > 0 && totalUncompressedSize / rarBuffer.length > ARCHIVE_SECURITY_LIMITS.MAX_RATIO) {
              throw new DecompressionLimitError(`Archive bomb detected: compression ratio exceeds ${ARCHIVE_SECURITY_LIMITS.MAX_RATIO}:1 limit`);
            }
            const sanitized = sanitizeArchivePath(relPath);
            if (sanitized && matchArchiveGlob(sanitized, options.entries)) {
              extracted.push({ filename: sanitized, buffer: buf });
            }
          }
        }
      }

      makeExtractedTreeAccessible(extractDir);
      walkDir(extractDir, '');
      return extracted;
    } catch (err) {
      if (err instanceof ConversionFailedError) {
        throw err;
      }
      if (err instanceof Error && err.message.includes('Archive bomb detected')) {
        throw err;
      }
      // If unrar execution failed on non-bomb error, fallback to stored extractor below
    } finally {
      try {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        if (fs.existsSync(extractDir)) {
          try {
            makeExtractedTreeAccessible(extractDir);
          } catch {
            // Best effort: the removal below runs either way.
          }
          fs.rmSync(extractDir, { recursive: true, force: true });
        }
      } catch {}
    }
  }

  // Pure TypeScript parser for stored RAR archives with fail-closed validation
  if (isRar5) {
    throw new ConversionFailedError('Unsupported RAR format: RAR5 compressed archives require unrar decompressor');
  }

  const files: { filename: string; buffer: Buffer }[] = [];
  let offset = 7;
  let totalUncompressedSize = 0;

  while (offset + 7 <= rarBuffer.length) {
    const headType = rarBuffer[offset + 2];
    const headSize = rarBuffer.readUInt16LE(offset + 5);
    if (headSize < 7 || offset + headSize > rarBuffer.length) break;

    if (headType === 0x7b) {
      // ENDARC_HEAD
      break;
    }

    if (headType === 0x74 && offset + 32 <= rarBuffer.length) {
      if (files.length >= ARCHIVE_SECURITY_LIMITS.MAX_FILES) {
        throw new DecompressionLimitError(`Archive bomb detected: file count exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_FILES}`);
      }

      const packSize = rarBuffer.readUInt32LE(offset + 7);
      const unpSize = rarBuffer.readUInt32LE(offset + 11);
      const fileCrc = rarBuffer.readUInt32LE(offset + 16);
      const method = rarBuffer[offset + 25];
      const nameSize = rarBuffer.readUInt16LE(offset + 26);

      if (unpSize > ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
        throw new DecompressionLimitError(
          `Archive bomb detected: uncompressed size exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes (500MB)`
        );
      }

      // Enforce fail-closed verification: Method 0x30 is STORE (uncompressed)
      // Methods 0x31..0x35 are compressed and MUST NOT be sliced as raw corrupt data!
      if (method !== 0x30) {
        throw new ConversionFailedError(
          `Unsupported RAR compression method (0x${method.toString(16)}): unrar binary is required for compressed RAR archives`
        );
      }

      if (offset + 32 + nameSize <= rarBuffer.length) {
        const filename = rarBuffer.toString('utf-8', offset + 32, offset + 32 + nameSize);
        const sanitizedName = sanitizeArchivePath(filename);
        const dataOffset = offset + headSize;

        if (dataOffset + packSize > rarBuffer.length) {
          throw new CorruptStreamError('Corrupted RAR archive: truncated file data');
        }

        const fileBuf = Buffer.from(rarBuffer.subarray(dataOffset, dataOffset + packSize));

        // Verify CRC32
        const computedCrc = crc32(fileBuf);
        if (computedCrc !== fileCrc) {
          throw new CorruptStreamError(`Corrupted RAR archive: CRC mismatch for ${filename} (expected 0x${fileCrc.toString(16)}, got 0x${computedCrc.toString(16)})`);
        }

        totalUncompressedSize += fileBuf.length;
        if (totalUncompressedSize > ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
          throw new DecompressionLimitError(`Archive bomb detected: uncompressed size exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes (500MB)`);
        }
        if (rarBuffer.length > 0 && totalUncompressedSize / rarBuffer.length > ARCHIVE_SECURITY_LIMITS.MAX_RATIO) {
          throw new DecompressionLimitError(`Archive bomb detected: compression ratio exceeds ${ARCHIVE_SECURITY_LIMITS.MAX_RATIO}:1 limit`);
        }

        if (sanitizedName && matchArchiveGlob(sanitizedName, options.entries)) {
          files.push({ filename: sanitizedName, buffer: fileBuf });
        }
      }
      offset += headSize + packSize;
    } else {
      offset += headSize;
    }
  }

  return files;
}

// ============================================================================
// Pure TypeScript LZMA & LZMA2 Decompression Engine (see lzma-decoder.ts)
// ============================================================================

export function decompressLzma(
  input: Buffer | Uint8Array,
  props: Buffer | Uint8Array,
  unpackSize: number
): Buffer {
  if (unpackSize === 0) {
    return Buffer.alloc(0);
  }
  const out = decodeLzma(input, props, unpackSize, ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE);
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

/** Decodes an LZMA2 stream; `unpackSize` is the size the container states, which the stream must produce. */
export function decompressLzma2(
  input: Buffer | Uint8Array,
  _props: Buffer | Uint8Array,
  unpackSize: number
): Buffer {
  const out = decodeLzma2(input, ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE, unpackSize);
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

// ==========================================
// Native XZ & 7-Zip Toolchain Resolvers
// ==========================================
let resolvedXzPath: string | null = null;
export function getXzBinaryPath(): string | null {
  if (resolvedXzPath !== null) return resolvedXzPath || null;
  const fixedLocations = [
    '/usr/bin/xz',
    '/usr/local/bin/xz',
    '/opt/homebrew/bin/xz',
  ];
  for (const loc of fixedLocations) {
    if (fs.existsSync(loc)) {
      resolvedXzPath = loc;
      return loc;
    }
  }
  const whichBins = ['/usr/bin/which', '/bin/which'];
  for (const whichBin of whichBins) {
    if (fs.existsSync(whichBin)) {
      try {
        const out = execFileSync(whichBin, ['xz'], { stdio: 'pipe' }).toString().trim();
        if (out && fs.existsSync(out)) {
          resolvedXzPath = out;
          return out;
        }
      } catch {}
    }
  }
  resolvedXzPath = '';
  return null;
}

/**
 * 7-Zip executable names, best first. `7zz` is what upstream 7-Zip and Homebrew install; Debian and
 * Ubuntu's `7zip` package installs `7z`, `7za` and `7zr` (`7zr` reads and writes 7z only). `7zz` is
 * preferred because the worker image ships only the pinned upstream build, and a modern `7zz` also
 * wins over a legacy `7z` that may sit on the same host.
 */
export const SEVEN_ZIP_BINARY_NAMES = ['7zz', '7z', '7za', '7zr'] as const;
/**
 * Debian and Ubuntu install the executables of the `7zip` package under `/usr/lib/7zip` and put a two-line shell script
 * of the same name in `/usr/bin` that only runs them; the executable is tried first, so a conversion does not start a
 * shell to start 7-Zip.
 */
const SEVEN_ZIP_BINARY_DIRECTORIES = ['/usr/lib/7zip', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'] as const;

/** Fixed install locations of every 7-Zip name, best name first. */
export const SEVEN_ZIP_BINARY_CANDIDATES: readonly string[] = SEVEN_ZIP_BINARY_NAMES.flatMap((name) =>
  SEVEN_ZIP_BINARY_DIRECTORIES.map((directory) => `${directory}/${name}`)
);

/** First 7-Zip executable among SEVEN_ZIP_BINARY_CANDIDATES, or null. */
export function findSevenZipBinary(exists: (candidate: string) => boolean = fs.existsSync): string | null {
  return SEVEN_ZIP_BINARY_CANDIDATES.find((candidate) => exists(candidate)) ?? null;
}

let resolved7zPath: string | null = null;
export function get7zBinaryPath(): string | null {
  const envOverride = process.env.P7ZIP_PATH ?? process.env.P7Z_PATH;
  if (envOverride !== undefined) {
    if (path.isAbsolute(envOverride) && fs.existsSync(envOverride)) {
      return envOverride;
    }
    return null;
  }
  if (resolved7zPath !== null) return resolved7zPath || null;
  const fixedLocation = findSevenZipBinary();
  if (fixedLocation) {
    resolved7zPath = fixedLocation;
    return fixedLocation;
  }
  const whichBins = ['/usr/bin/which', '/bin/which'];
  for (const whichBin of whichBins) {
    if (fs.existsSync(whichBin)) {
      for (const cmd of SEVEN_ZIP_BINARY_NAMES) {
        try {
          const out = execFileSync(whichBin, [cmd], { stdio: 'pipe' }).toString().trim();
          if (out && fs.existsSync(out)) {
            resolved7zPath = out;
            return out;
          }
        } catch {}
      }
    }
  }
  resolved7zPath = '';
  return null;
}

/**
 * Pure TypeScript .xz packager (The .xz File Format 1.1.0; see xz-format.ts).
 */
export function packXz(uncompressed: Buffer, options: ConversionOptions = {}): Buffer {
  return packXzStream(uncompressed, compressLzma2(uncompressed, { level: resolveArchiveCompressionLevel(options.compressionLevel) }));
}

/** `packXz` with the LZMA2 stream built on a pool thread, so a large input does not hold the event loop. */
export async function packXzAsync(
  uncompressed: Buffer,
  options: ConversionOptions = {},
  runtime: { signal?: AbortSignal } = {}
): Promise<Buffer> {
  return packXzStream(
    uncompressed,
    await compressLzma2Async(uncompressed, { level: resolveArchiveCompressionLevel(options.compressionLevel), signal: runtime.signal })
  );
}

/**
 * Pure TypeScript .xz unpacker: any number of blocks and streams, branch and Delta filters in front of LZMA2, every check verified.
 */
export function unpackXz(buf: Buffer): Buffer {
  return unpackXzStream(buf, ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE);
}

export function compressXz(inputBuffer: Buffer, options: ConversionOptions = {}): Buffer {
  const level = resolveArchiveCompressionLevel(options.compressionLevel);
  const xzBin = getXzBinaryPath();
  if (xzBin) {
    try {
      return execFileSync(xzBin, [`-${level}`, '-c', '-q'], {
        input: inputBuffer,
        maxBuffer: ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE,
      });
    } catch {}
  }
  return packXz(inputBuffer, options);
}

/**
 * `compressXz` that keeps the event loop free: the native `xz` runs as a sandboxed child process, the pure encoder on a
 * pool thread. A native run that fails falls back to the pure encoder, which writes a stream of its own; it never
 * returns a placeholder.
 */
export async function compressXzAsync(
  inputBuffer: Buffer,
  options: ConversionOptions = {},
  runtime: { signal?: AbortSignal } = {}
): Promise<Buffer> {
  const level = resolveArchiveCompressionLevel(options.compressionLevel);
  const xzBin = getXzBinaryPath();
  if (xzBin) {
    try {
      const run = await executeSandboxedBinary(xzBin, [`-${level}`, '-c', '-q'], {
        stdin: inputBuffer,
        maxBuffer: ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE,
        timeoutMs: CPU_POOL_TASK_TIMEOUT_MS,
        networkIsolated: true,
        signal: runtime.signal,
      });
      return run.stdout;
    } catch (err) {
      if (runtime.signal?.aborted) throw err;
    }
  }
  return packXzAsync(inputBuffer, options, runtime);
}

/**
 * Memory the native `xz` may use to decode: far above any preset (the largest, -9, needs 65 MiB), far below the
 * 1.5 GiB a header can announce. A stream that asks for more is decoded by the in-process reader, whose memory follows
 * the decoded output (capped below) and not the dictionary size.
 */
const NATIVE_XZ_MEMLIMIT_BYTES = 256 * 1024 * 1024;

/**
 * Decodes an .xz file. The native `xz` does the work when it is installed; when it cannot (it refused the stream, hit
 * the memory limit, or is an older build without a filter the file uses) the in-process reader decodes it or names
 * the defect with a typed error. Output past the byte cap is a 413 from either.
 */
export function decompressXz(inputBuffer: Buffer): Buffer {
  if (inputBuffer.length < 32) {
    throw new CorruptStreamError('Invalid XZ archive: buffer too small');
  }
  const xzBin = getXzBinaryPath();
  if (xzBin) {
    try {
      return execFileSync(xzBin, ['-d', '-c', '-q', `--memlimit-decompress=${NATIVE_XZ_MEMLIMIT_BYTES}`], {
        input: inputBuffer,
        maxBuffer: ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE,
        // Its diagnostics are captured, not inherited: the in-process reader names the defect.
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOBUFS') {
        throw new DecompressionLimitError(
          `Archive bomb detected: uncompressed size exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes (500MB)`
        );
      }
    }
  }
  return unpackXz(inputBuffer);
}

/** Names 7-Zip gives the intermediate tar when it unpacks a compressed tarball. */
const INTERMEDIATE_TAR_NAMES = new Set(['input.tar', 'input']);

export function convertWithNative7z(
  inputBuffer: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: ConversionOptions = {},
  originalFilename = 'file'
): ConversionResult | null {
  const tgt = targetFormat.toLowerCase();
  assertArchivePasswordSafe(options.password);

  if (options.password && tgt !== 'zip' && tgt !== '7z') {
    throw new UnsupportedOptionError(`Target archive format '${tgt}' does not support password encryption.`);
  }
  if (tgt === 'zip') assertZipPasswordSupported(options.password);

  const p7zBin = get7zBinaryPath();
  if (!p7zBin) {
    if (options.password) {
      throw new ArchiveEncryptionUnavailableError(
        'Archive encryption is unavailable: native 7z binary is required for encrypted archives.'
      );
    }
    return null;
  }

  // Delegate zstd dictionary-trained frames or custom zstd streams to authentic TS engine
  if (
    options.zstdDict ||
    sourceFormat.includes('zst') ||
    sourceFormat.includes('zstd') ||
    targetFormat.includes('zst') ||
    targetFormat.includes('zstd')
  ) {
    return null;
  }

  const src = sourceFormat.toLowerCase().trim();
  const baseName = originalFilename ? originalFilename.replace(/\.[^/.]+$/, '') : 'converted';

  const supportedExtract = new Set([
    'zip', '7z', 'rar', 'tar', 'gz', 'gzip', 'tgz', 'tar.gz',
    'bz2', 'bzip2', 'tbz2', 'tar.bz2', 'xz', 'txz', 'tar.xz',
  ]);

  const supportedTargets = new Set([
    '7z', 'zip', 'tar', 'tar.gz', 'tgz', 'tar.bz2', 'tbz2', 'tbz', 'tar.xz', 'txz',
  ]);

  if (!supportedTargets.has(tgt)) {
    return null;
  }

  const tmpDir = os.tmpdir();
  const token = crypto.randomBytes(8).toString('hex');
  const workDir = path.join(tmpDir, `easyconvert_7z_${Date.now()}_${token}`);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    const inputExt = src.startsWith('tar.') ? src : (src.includes('.') ? src.split('.').pop()! : src);
    const inputPath = path.join(workDir, `input.${inputExt}`);
    fs.writeFileSync(inputPath, inputBuffer);

    let extractDir = path.join(workDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });

    let skippedLinks: string[] = [];
    let entryCount: number;
    if (supportedExtract.has(src)) {
      // List, vet, extract and re-verify; unsafe or oversized archives throw before anything is packaged.
      const outerRequest = {
        p7zBin,
        archivePath: inputPath,
        extractDir,
        cwd: workDir,
        timeoutMs: 60000,
        maxBuffer: ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE,
        limits: ARCHIVE_SECURITY_LIMITS,
        label: `${src.toUpperCase()} archive`,
        password: options.password,
        skipLinks: options.skipLinks,
        collisionPolicy: options.collisionPolicy,
      };
      let tree = extractArchiveContainedSync(outerRequest);
      skippedLinks = tree.skippedLinks;

      // A compressed tarball (tar.gz, tar.bz2, tar.xz, tgz, ...) unpacks to one intermediate .tar, which is
      // listed, vetted and extracted as its own layer; its ratio is measured against the original upload.
      if (src.startsWith('tar.') || src === 'tgz' || src === 'tbz2' || src === 'tbz' || src === 'txz') {
        // gzip headers carry the original file name, so the unpacked tar is recognised by name or by content.
        const intermediate =
          tree.files.length === 1 && (INTERMEDIATE_TAR_NAMES.has(tree.files[0].relPath) || hasTarMagic(tree.files[0].absPath))
            ? tree.files[0]
            : null;
        if (intermediate) {
          const tarDir = path.join(workDir, 'extracted-tar');
          fs.mkdirSync(tarDir, { recursive: true });
          tree = extractArchiveContainedSync({
            ...outerRequest,
            archivePath: intermediate.absPath,
            extractDir: tarDir,
            password: undefined,
            ratioBaseBytes: inputBuffer.length,
          });
          skippedLinks = [...skippedLinks, ...tree.skippedLinks];
          extractDir = tarDir;
        }
      }
      entryCount = tree.entryCount;
    } else {
      // The caller-supplied name becomes a single path component inside the extraction root.
      const destPath = path.join(extractDir, sanitizeLeafFilename(originalFilename || `file.${src}`));
      fs.writeFileSync(destPath, inputBuffer);
      entryCount = 1;
    }

    if (entryCount === 0) return null;

    if (options.password && (tgt === 'zip' || tgt === '7z')) {
      assertEncryptedArchiveInputWithinLimits(walkArchiveTreePaths(extractDir));
    }
    const pwCreateArgs: string[] = [];
    if (options.password) {
      if (tgt === '7z') {
        pwCreateArgs.push('-mhe=on', SEVEN_ZIP_ASK_PASSWORD_SWITCH);
      } else if (tgt === 'zip') {
        pwCreateArgs.push('-mem=AES256', SEVEN_ZIP_ASK_PASSWORD_SWITCH);
      }
    }
    const pwCreateInput =
      options.password && (tgt === 'zip' || tgt === '7z')
        ? sevenZipCreatePasswordInput(options.password)
        : undefined;
    const outputPath = path.join(workDir, `output.${tgt}`);
    if (tgt === 'tar.gz' || tgt === 'tgz') {
      const tarPath = path.join(workDir, 'archive.tar');
      const rTar = resolveSandboxedCommand(p7zBin, ['a', '-y', '-ttar', tarPath, '.'], { networkIsolated: true });
      execFileSync(rTar.binary, rTar.args, { cwd: extractDir, env: getSanitizedEnvironment({}, true), timeout: 60000 });
      const rGz = resolveSandboxedCommand(p7zBin, ['a', '-y', '-tgzip', outputPath, tarPath], { networkIsolated: true });
      execFileSync(rGz.binary, rGz.args, { cwd: workDir, env: getSanitizedEnvironment({}, true), timeout: 60000 });
    } else if (tgt === 'tar.bz2' || tgt === 'tbz2' || tgt === 'tbz') {
      const tarPath = path.join(workDir, 'archive.tar');
      const rTar = resolveSandboxedCommand(p7zBin, ['a', '-y', '-ttar', tarPath, '.'], { networkIsolated: true });
      execFileSync(rTar.binary, rTar.args, { cwd: extractDir, env: getSanitizedEnvironment({}, true), timeout: 60000 });
      const rBz = resolveSandboxedCommand(p7zBin, ['a', '-y', '-tbzip2', outputPath, tarPath], { networkIsolated: true });
      execFileSync(rBz.binary, rBz.args, { cwd: workDir, env: getSanitizedEnvironment({}, true), timeout: 60000 });
    } else if (tgt === 'tar.xz' || tgt === 'txz') {
      const tarPath = path.join(workDir, 'archive.tar');
      const rTar = resolveSandboxedCommand(p7zBin, ['a', '-y', '-ttar', tarPath, '.'], { networkIsolated: true });
      execFileSync(rTar.binary, rTar.args, { cwd: extractDir, env: getSanitizedEnvironment({}, true), timeout: 60000 });
      const rXz = resolveSandboxedCommand(p7zBin, ['a', '-y', '-txz', outputPath, tarPath], { networkIsolated: true });
      execFileSync(rXz.binary, rXz.args, { cwd: workDir, env: getSanitizedEnvironment({}, true), timeout: 60000 });
    } else if (tgt === '7z' || tgt === 'zip' || tgt === 'tar') {
      const rCreate = resolveSandboxedCommand(p7zBin, ['a', '-y', `-t${tgt}`, ...pwCreateArgs, outputPath, '.'], { networkIsolated: true });
      const createOptions = { cwd: extractDir, env: getSanitizedEnvironment({}, true), timeout: 60000 };
      if (pwCreateInput) {
        execFileSyncWithPasswordStdin(rCreate.binary, rCreate.args, { ...createOptions, input: pwCreateInput });
      } else {
        execFileSync(rCreate.binary, rCreate.args, createOptions);
      }
      if (options.password && (tgt === 'zip' || tgt === '7z')) {
        assertCreatedArchiveEncrypted(p7zBin, outputPath, tgt, workDir);
      }
    } else {
      return null;
    }

    if (!fs.existsSync(outputPath)) return null;
    const outputBuffer = fs.readFileSync(outputPath);

    let mime = 'application/octet-stream';
    if (tgt === 'zip') mime = 'application/zip';
    else if (tgt === '7z') mime = 'application/x-7z-compressed';
    else if (tgt === 'tar') mime = 'application/x-tar';
    else if (tgt === 'tar.gz' || tgt === 'tgz') mime = 'application/gzip';
    else if (tgt === 'tar.bz2' || tgt === 'tbz2' || tgt === 'tbz') mime = 'application/x-bzip-compressed-tar';
    else if (tgt === 'tar.xz' || tgt === 'txz') mime = 'application/x-xz-compressed-tar';

    return {
      buffer: outputBuffer,
      mimeType: mime,
      filename: `${baseName}.${tgt}`,
      size: outputBuffer.length,
      ...(skippedLinks.length > 0 ? { skippedLinks } : {}),
    };
  } catch (err) {
    // A host that cannot sandbox 7-Zip refuses the request: the in-process engines are not a substitute for it.
    rethrowSandboxUnavailable(err);
    // A policy violation or bad password must surface; an archive 7-Zip cannot read may still be
    // handled by the in-process engines, which the null return hands the conversion to.
    if (err instanceof ConversionFailedError && !(err instanceof UnreadableArchiveError) && !(err instanceof EngineUnavailableError)) {
      throw err;
    }
    return null;
  } finally {
    cleanupDirectoryTree(workDir);
  }
}

/**
 * Extracts a multi-volume split archive with the 7-Zip CLI through the contained pipeline.
 * The parts are spooled to one seekable temporary file in O(1) memory (`stitchMultiVolumeToDisk`) so the
 * archive can be listed and vetted before anything is extracted; a zero-disk stdin stream cannot be listed first.
 * Unsafe, oversized or unreadable archives throw a typed error.
 */
export async function extractWithSpannedStream7z(
  parts: Array<string | VirtualSpannedPartSource | { filename: string; buffer: Buffer }>,
  extractDir: string,
  options: {
    timeoutMs?: number;
    maxBuffer?: number;
    password?: string;
    /** Leave link entries out of the extraction and report them instead of rejecting the archive. */
    skipLinks?: boolean;
    collisionPolicy?: ArchiveCollisionPolicy;
    signal?: AbortSignal;
  } = {}
): Promise<{
  extractedFiles: string[];
  totalBytes: number;
  baseFilename: string;
  /** Number of files and directories extracted. */
  entryCount: number;
  skippedLinks: string[];
}> {
  const p7zBin = get7zBinaryPath();
  if (!p7zBin) {
    throw new EngineUnavailableError('7-Zip', 'binary (7z/7za/7zr) not found on system');
  }

  const { sortedParts, metadata } = validateAndSortSplitParts(parts);
  const resolvedExtractDir = path.resolve(extractDir);
  if (!fs.existsSync(resolvedExtractDir)) {
    fs.mkdirSync(resolvedExtractDir, { recursive: true });
  }

  const typeSwitch = SPANNED_ARCHIVE_TYPE_SWITCHES[metadata.format];
  const uniqueSuffix = crypto.randomBytes(6).toString('hex');
  const tempDiskFile = path.join(os.tmpdir(), `spanned_stitch_${Date.now()}_${uniqueSuffix}`);
  try {
    await stitchMultiVolumeToDisk(sortedParts, tempDiskFile);
    const tree = await extractArchiveContained({
      p7zBin,
      archivePath: tempDiskFile,
      extractDir: resolvedExtractDir,
      cwd: resolvedExtractDir,
      timeoutMs: stageTimeoutMs(options, 60000),
      maxBuffer: options.maxBuffer ?? ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE,
      limits: ARCHIVE_SECURITY_LIMITS,
      label: 'archive',
      password: options.password,
      typeFlag: typeSwitch,
      skipLinks: options.skipLinks,
      collisionPolicy: options.collisionPolicy,
      signal: options.signal,
    });
    return {
      extractedFiles: tree.files.map((file) => file.relPath),
      totalBytes: tree.totalBytes,
      baseFilename: metadata.baseFilename,
      entryCount: tree.entryCount,
      skippedLinks: tree.skippedLinks,
    };
  } finally {
    try {
      if (fs.existsSync(tempDiskFile)) {
        fs.unlinkSync(tempDiskFile);
      }
    } catch {}
  }
}

/** 7z `-t` switches for the container types a multi-volume part list can resolve to. */
const SPANNED_ARCHIVE_TYPE_SWITCHES: Record<string, string | undefined> = {
  tar: '-ttar',
  zip: '-tzip',
  '7z': '-t7z',
  rar: '-trar',
};

export function write7zVarint(arr: number[], value: number): void {
  if (value < 0x80) {
    arr.push(value);
    return;
  }
  let extraBytes = 8;
  for (let i = 1; i <= 7; i++) {
    if (value < Math.pow(2, 7 * (i + 1))) {
      extraBytes = i;
      break;
    }
  }
  const firstByteMask = (0xff00 >> extraBytes) & 0xff;
  const highBits = Math.floor(value / Math.pow(2, extraBytes * 8)) & (0x7f >> extraBytes);
  arr.push(firstByteMask | highBits);
  let temp = value;
  for (let b = 0; b < extraBytes; b++) {
    arr.push(temp % 256);
    temp = Math.floor(temp / 256);
  }
}

export function read7zVarint(
  buf: Buffer | Uint8Array,
  offset: number
): { value: number; nextOffset: number } {
  if (offset >= buf.length) {
    return { value: 0, nextOffset: offset };
  }
  const firstByte = buf[offset++];
  let mask = 0x80;
  let value = 0;
  for (let i = 0; i < 8; i++) {
    if ((firstByte & mask) === 0) {
      const highPart = firstByte & (mask - 1);
      value += highPart * Math.pow(2, i * 8);
      return { value, nextOffset: offset };
    }
    if (offset >= buf.length) {
      return { value, nextOffset: offset };
    }
    value += buf[offset++] * Math.pow(2, i * 8);
    mask >>= 1;
  }
  return { value, nextOffset: offset };
}

// ============================================================================
// 7z Archive Creation with Authentic Compression
// ============================================================================

type SevenZipCoderType = 'lzma' | 'lzma2' | 'deflate' | 'copy';

/** What the archive writer needs to know before any stream is compressed: the streams, their sizes and checksums. */
interface SevenZipPlan {
  files: { filename: string; buffer: Buffer }[];
  coderType: SevenZipCoderType;
  compressionLevel: number;
  isSolid: boolean;
  /** One buffer per pack stream: the concatenation of all files when solid, otherwise one per file. */
  inputs: Buffer[];
  unpackSizes: number[];
  crcs: number[];
  solidCrc: number;
  totalUnpackSize: number;
  totalInputBytes: number;
}

interface SevenZipPackedStream {
  buffer: Buffer;
  props: Buffer;
}

/** The checks and the plan shared by the synchronous and the pool-backed writers; the encrypted path is complete here. */
function prepare7zArchive(
  files: { filename: string; buffer: Buffer }[],
  options: ConversionOptions,
  archiveName: string
): { encrypted: ConversionResult } | { plan: SevenZipPlan } {
  assertArchivePasswordSafe(options.password);
  const resolvedFiles = resolveArchiveEntryCollisions(files, options.collisionPolicy || 'rename');
  files = resolvedFiles;
  if (options.password) {
    const p7z = get7zBinaryPath();
    if (!p7z) {
      throw new ArchiveEncryptionUnavailableError(
        'Archive encryption is unavailable: native 7z binary is required for encrypted 7z archives.'
      );
    }
    const encRes = createEncryptedArchiveVia7z(
      resolvedFiles,
      archiveName,
      '7z',
      'application/x-7z-compressed',
      options.password,
      options.collisionPolicy
    );
    if (encRes) return { encrypted: encRes };
    throw new ArchiveEncryptionUnavailableError('Failed to create encrypted 7z archive.');
  }

  const compressionLevel = resolveArchiveCompressionLevel(options.compressionLevel);
  const isCompressed = compressionLevel > 0;

  let coderType: SevenZipCoderType;
  if (options.archiveCoder) {
    coderType = options.archiveCoder;
  } else if (!isCompressed) {
    coderType = 'copy';
  } else {
    coderType = 'lzma2';
  }

  const isSolid = Boolean(options.solid && files.length > 1);
  const unpackSizes: number[] = [];
  const crcs: number[] = [];
  let totalInputBytes = 0;
  for (const f of files) {
    unpackSizes.push(f.buffer.length);
    crcs.push(crc32(f.buffer));
    totalInputBytes += f.buffer.length;
  }

  let inputs: Buffer[];
  let solidCrc = 0;
  let totalUnpackSize = 0;
  if (isSolid) {
    const solidBuffer = Buffer.concat(files.map(f => f.buffer));
    totalUnpackSize = solidBuffer.length;
    solidCrc = crc32(solidBuffer);
    inputs = [solidBuffer];
  } else {
    inputs = files.map(f => f.buffer);
  }
  return {
    plan: { files, coderType, compressionLevel, isSolid, inputs, unpackSizes, crcs, solidCrc, totalUnpackSize, totalInputBytes },
  };
}

function pack7zStream(plan: SevenZipPlan, input: Buffer): SevenZipPackedStream {
  if (plan.coderType === 'lzma2') {
    const res = compressLzma2(input, { level: plan.compressionLevel });
    return { buffer: res.buffer, props: res.props };
  }
  if (plan.coderType === 'lzma') {
    const res = compressLzma(input, { level: plan.compressionLevel });
    return { buffer: res.buffer, props: res.props };
  }
  if (plan.coderType === 'deflate') {
    return { buffer: zlib.deflateRawSync(input, { level: plan.compressionLevel }), props: Buffer.alloc(0) };
  }
  return { buffer: input, props: Buffer.alloc(0) };
}

const deflateRawAsync = promisify(zlib.deflateRaw);

async function pack7zStreamAsync(plan: SevenZipPlan, input: Buffer, signal: AbortSignal | undefined): Promise<SevenZipPackedStream> {
  if (plan.coderType === 'lzma2') {
    const res = await compressLzma2Async(input, { level: plan.compressionLevel, signal });
    return { buffer: res.buffer, props: res.props };
  }
  if (plan.coderType === 'lzma') {
    const res = await compressLzmaAsync(input, { level: plan.compressionLevel, signal });
    return { buffer: res.buffer, props: res.props };
  }
  if (plan.coderType === 'deflate') {
    return { buffer: await deflateRawAsync(input, { level: plan.compressionLevel }), props: Buffer.alloc(0) };
  }
  return { buffer: input, props: Buffer.alloc(0) };
}

export function create7zArchive(
  files: { filename: string; buffer: Buffer }[],
  options: ConversionOptions = {},
  archiveName = 'converted_files.7z'
): ConversionResult {
  const prepared = prepare7zArchive(files, options, archiveName);
  if ('encrypted' in prepared) return prepared.encrypted;
  const { plan } = prepared;
  return assemble7zArchive(plan, plan.inputs.map((input) => pack7zStream(plan, input)), archiveName);
}

/** Input at or above this size goes to 7-Zip itself when it is installed: its encoder is faster than the pure one. */
const SEVEN_ZIP_NATIVE_MIN_BYTES = CPU_POOL_MIN_BYTES;

/**
 * Runs `7z a -t7z -m0=lzma2` over the staged files and returns the archive, or null when 7-Zip could not be run (the
 * caller then uses the pure writer). What 7-Zip wrote is checked before it is returned: `7z t` must pass and the
 * listing must name exactly the requested entries with their sizes; a mismatch throws.
 */
async function createNative7zArchive(plan: SevenZipPlan, p7z: string, signal: AbortSignal | undefined): Promise<Buffer | null> {
  const stagedNames = plan.files.map((f) => sanitizeArchivePath(f.filename));
  // A name the staging area would rewrite cannot be reproduced by 7-Zip; the pure writer stores names as given.
  if (stagedNames.some((name, i) => name !== plan.files[i].filename)) return null;
  const workDir = path.join(os.tmpdir(), `easyconvert_7z_native_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`);
  const stagingDir = path.join(workDir, 'staging');
  await fs.promises.mkdir(stagingDir, { recursive: true });
  try {
    for (const [i, f] of plan.files.entries()) {
      const dest = path.join(stagingDir, stagedNames[i]!);
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.writeFile(dest, f.buffer);
    }
    const outPath = path.join(workDir, 'native.7z');
    const run = (args: string[], cwd: string) =>
      executeSandboxedBinary(p7z, args, {
        cwd,
        timeoutMs: CPU_POOL_TASK_TIMEOUT_MS,
        maxBuffer: MAX_ENCRYPTION_LISTING_BYTES,
        networkIsolated: true,
        signal,
      });
    try {
      await run(
        [
          'a', '-y', '-bd', '-t7z', '-m0=lzma2', `-mx=${plan.compressionLevel}`,
          plan.isSolid ? '-ms=on' : '-ms=off', `-mmt=${CPU_POOL_MAX}`,
          // Timestamps would record when the staging files were written.
          '-mtm=off', '-mtc=off', '-mta=off',
          outPath, '.',
        ],
        stagingDir
      );
    } catch (err) {
      if (signal?.aborted) throw err;
      return null;
    }
    await run(['t', '-y', outPath], workDir);
    const listing = parse7zTechnicalListing(
      stripSevenZipPasswordPrompt((await run(['l', '-slt', '-ba', outPath], workDir)).stdout.toString('utf-8'))
    );
    const expected = new Map(plan.files.map((f) => [f.filename, f.buffer.length]));
    // 7-Zip also stores the directories that hold the files; any other entry is a surprise.
    const parents = new Set(plan.files.flatMap((f) => f.filename.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))));
    const fileEntries = listing.filter((e) => !e.isDirectory);
    const matches =
      fileEntries.length === expected.size &&
      fileEntries.every((e) => expected.get(e.path) === e.sizeBytes) &&
      listing.every((e) => !e.isDirectory || parents.has(e.path));
    if (!matches) {
      throw new ConversionFailedError('Native 7z archive creation produced an archive whose entries differ from the requested files.');
    }
    return await fs.promises.readFile(outPath);
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * `create7zArchive` that keeps the event loop free. With 7-Zip installed, input of SEVEN_ZIP_NATIVE_MIN_BYTES or more
 * with an LZMA2 coder is compressed by `7z a -t7z -m0=lzma2` in the sandbox (the result is tested with `7z t` and its
 * listing checked); otherwise the pure LZMA, LZMA2 and Deflate streams are built on pool threads. Both give an archive
 * the reference extractor reads. Encrypted archives take the same path as `create7zArchive`.
 */
export async function create7zArchiveAsync(
  files: { filename: string; buffer: Buffer }[],
  options: ConversionOptions = {},
  archiveName = 'converted_files.7z',
  runtime: { signal?: AbortSignal } = {}
): Promise<ConversionResult> {
  const prepared = prepare7zArchive(files, options, archiveName);
  if ('encrypted' in prepared) return prepared.encrypted;
  const { plan } = prepared;
  const p7z = plan.coderType === 'lzma2' ? get7zBinaryPath() : null;
  if (p7z && plan.totalInputBytes >= SEVEN_ZIP_NATIVE_MIN_BYTES) {
    const native = await createNative7zArchive(plan, p7z, runtime.signal);
    if (native) {
      return { buffer: native, mimeType: 'application/x-7z-compressed', filename: archiveName, size: native.length };
    }
  }
  const lanes = Math.max(2, getCpuPool().threadLimit * 2);
  const packed: SevenZipPackedStream[] = new Array(plan.inputs.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < plan.inputs.length) {
      const at = next++;
      packed[at] = await pack7zStreamAsync(plan, plan.inputs[at], runtime.signal);
    }
  };
  await Promise.all(Array.from({ length: Math.min(lanes, plan.inputs.length) }, () => lane()));
  return assemble7zArchive(plan, packed, archiveName);
}

function assemble7zArchive(plan: SevenZipPlan, packed: SevenZipPackedStream[], archiveName: string): ConversionResult {
  const { files, coderType, isSolid, unpackSizes, crcs, solidCrc, totalUnpackSize } = plan;
  const packBuffers = packed.map((p) => p.buffer);
  const packSizes = packed.map((p) => p.buffer.length);
  const fileProps = packed.map((p) => p.props);

  const packData = Buffer.concat(packBuffers);

  // Build NextHeader
  const nh: number[] = [];
  nh.push(0x01); // kHeader
  nh.push(0x04); // kMainStreamsInfo

  if (isSolid) {
    // kPackInfo
    nh.push(0x06); // kPackInfo
    nh.push(0x00); // packPos = 0
    write7zVarint(nh, 1); // numPackStreams = 1
    nh.push(0x09); // kSize
    write7zVarint(nh, packSizes[0]);
    nh.push(0x00); // kEnd (PackInfo)

    // kUnpackInfo
    nh.push(0x07); // kUnpackInfo
    nh.push(0x0b); // kFolder
    write7zVarint(nh, 1); // numFolders = 1
    nh.push(0x00); // external = 0
    nh.push(0x01); // numCoders = 1
    if (coderType === 'lzma2') {
      nh.push(0x21, 0x21, 0x01, 0x14);
    } else if (coderType === 'lzma') {
      const p = fileProps[0] && fileProps[0].length === 5 ? fileProps[0] : Buffer.from([0x5d, 0x00, 0x00, 0x01, 0x00]);
      nh.push(0x23, 0x03, 0x01, 0x01, 0x05, ...p);
    } else if (coderType === 'deflate') {
      nh.push(0x03, 0x04, 0x01, 0x08);
    } else {
      nh.push(0x01, 0x00);
    }

    nh.push(0x0c); // kCodersUnpackSize
    write7zVarint(nh, totalUnpackSize);

    nh.push(0x0a); // kCRC
    nh.push(0x01); // allAreDefined = 1
    nh.push(solidCrc & 0xff, (solidCrc >>> 8) & 0xff, (solidCrc >>> 16) & 0xff, (solidCrc >>> 24) & 0xff);
    nh.push(0x00); // kEnd (UnpackInfo)

    // kSubStreamsInfo
    nh.push(0x08); // kSubStreamsInfo
    nh.push(0x0d); // kNumUnpackStream
    write7zVarint(nh, files.length);

    nh.push(0x09); // kSize
    for (let i = 0; i < files.length - 1; i++) {
      write7zVarint(nh, unpackSizes[i]);
    }

    nh.push(0x0a); // kCRC
    nh.push(0x01); // allAreDefined = 1
    for (const c of crcs) {
      nh.push(c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, (c >>> 24) & 0xff);
    }
    nh.push(0x00); // kEnd (SubStreamsInfo)
    nh.push(0x00); // kEnd (MainStreamsInfo)
  } else {
    // kPackInfo
    nh.push(0x06); // kPackInfo
    nh.push(0x00); // packPos = 0
    write7zVarint(nh, files.length); // numPackStreams
    nh.push(0x09); // kSize
    for (const sz of packSizes) {
      write7zVarint(nh, sz);
    }
    nh.push(0x00); // kEnd (PackInfo)

    // kUnpackInfo
    nh.push(0x07); // kUnpackInfo
    nh.push(0x0b); // kFolder
    write7zVarint(nh, files.length); // numFolders
    nh.push(0x00); // external = 0
    for (let i = 0; i < files.length; i++) {
      nh.push(0x01); // numCoders = 1
      if (coderType === 'lzma2') {
        nh.push(0x21, 0x21, 0x01, 0x14);
      } else if (coderType === 'lzma') {
        const p = fileProps[i] && fileProps[i].length === 5 ? fileProps[i] : Buffer.from([0x5d, 0x00, 0x00, 0x01, 0x00]);
        nh.push(0x23, 0x03, 0x01, 0x01, 0x05, ...p);
      } else if (coderType === 'deflate') {
        nh.push(0x03, 0x04, 0x01, 0x08);
      } else {
        nh.push(0x01, 0x00);
      }
    }

    nh.push(0x0c); // kCodersUnpackSize
    for (const us of unpackSizes) {
      write7zVarint(nh, us);
    }

    nh.push(0x00); // kEnd (UnpackInfo)

    // kSubStreamsInfo: one stream per folder, with the file CRC where 7-Zip lists it
    nh.push(0x08); // kSubStreamsInfo
    nh.push(0x0a); // kCRC
    nh.push(0x01); // allAreDefined = 1
    for (const c of crcs) {
      nh.push(c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, (c >>> 24) & 0xff);
    }
    nh.push(0x00); // kEnd (SubStreamsInfo)
    nh.push(0x00); // kEnd (MainStreamsInfo)
  }

  // kFilesInfo
  nh.push(0x05); // kFilesInfo
  write7zVarint(nh, files.length); // numFiles
  nh.push(0x11); // kName (0x11 per standard 7z spec)

  const nameBufs: Buffer[] = [];
  for (const f of files) {
    nameBufs.push(Buffer.from(f.filename + '\0', 'utf16le'));
  }
  const allNames = Buffer.concat(nameBufs);
  write7zVarint(nh, allNames.length + 1);
  nh.push(0x00); // external = 0

  const nhPrefix = Buffer.from(nh);
  const nhBuffer = Buffer.concat([nhPrefix, allNames, Buffer.from([0x00, 0x00])]);

  const nextHeaderOffset = packData.length;
  const nextHeaderSize = nhBuffer.length;
  const nextHeaderCrc = crc32(nhBuffer);

  const startHeader = Buffer.alloc(32);
  startHeader.write('7z\xBC\xAF\x27\x1C', 0, 6, 'binary');
  startHeader.writeUInt8(0, 6);
  startHeader.writeUInt8(4, 7);
  startHeader.writeBigUInt64LE(BigInt(nextHeaderOffset), 12);
  startHeader.writeBigUInt64LE(BigInt(nextHeaderSize), 20);
  startHeader.writeUInt32LE(nextHeaderCrc, 28);

  const shCrc = crc32(startHeader.subarray(12, 32));
  startHeader.writeUInt32LE(shCrc, 8);

  const fullArchive = Buffer.concat([startHeader, packData, nhBuffer]);
  return {
    buffer: fullArchive,
    mimeType: 'application/x-7z-compressed',
    filename: archiveName,
    size: fullArchive.length,
  };
}

// ============================================================================
// 7z Archive Extraction with Authentic Decompression
// ============================================================================

/**
 * The file table of a 7z archive (names, sizes, checksums, times, attributes) read in process. Only the header is
 * decoded, so the cost does not grow with the archive; a header this engine cannot decode (an encrypted or filtered
 * header) throws, and the caller then lists the archive with 7-Zip itself.
 */
export function listSevenZipEntries(sevenZipBuffer: Buffer): SevenZipListing {
  return listSevenZipArchive(
    sevenZipBuffer,
    createSevenZipFolderDecoder({ maxOutputBytes: ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE }),
    sevenZipReadLimits()
  );
}

function sevenZipReadLimits(): SevenZipReadLimits {
  return {
    maxFiles: ARCHIVE_SECURITY_LIMITS.MAX_FILES,
    maxUncompressedBytes: ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE,
    maxRatio: ARCHIVE_SECURITY_LIMITS.MAX_RATIO,
  };
}

/**
 * Extracts the files of a 7z archive in process. A damaged, truncated or mislabelled archive throws a
 * CorruptStreamError; it never yields an empty or partial file list. Folders with filter chains (BCJ, BCJ2, Delta,
 * ARM, PPC, SPARC, IA-64) are decoded, and AES-256 folders are decrypted with `password`; a method the engine does
 * not decode is an UnsupportedArchiveMethodError. A symbolic link is never extracted: it fails the archive with an
 * UnsafeArchiveError, or with `skipLinks` is left out and reported through `onSkippedLinks`.
 */
export function extract7zArchive(sevenZipBuffer: Buffer, options: SevenZipExtractOptions = {}): { filename: string; buffer: Buffer }[] {
  const entries = readSevenZipArchive(
    sevenZipBuffer,
    createSevenZipFolderDecoder({ password: options.password, maxOutputBytes: ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE }),
    sevenZipReadLimits()
  );
  return selectSevenZipFiles(entries, options);
}

/** The header of an encrypted archive can be encoded at most this deep, and each level may need its own key. */
const SEVEN_ZIP_MAX_KEY_ROUNDS_OF_DISCOVERY = 8;

/**
 * `extract7zArchive` for an archive with a password: the AES keys are derived before any data is decoded, large
 * derivations on a pool thread (stopped by `options.signal`), so a big key derivation never blocks the event loop. The
 * header is read first to learn which keys the folders need; each distinct key is derived once for the whole archive.
 */
export async function extract7zArchiveAsync(
  sevenZipBuffer: Buffer,
  options: SevenZipExtractOptions & { signal?: AbortSignal } = {}
): Promise<{ filename: string; buffer: Buffer }[]> {
  const keys = new AesKeyCache(options.password);
  keys.deferred = true;
  const decoder = createSevenZipFolderDecoder({ password: options.password, maxOutputBytes: ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE, keys });
  const limits = sevenZipReadLimits();
  let properties: Buffer[] = [];
  for (let round = 0; ; round += 1) {
    try {
      properties = collectSevenZipAesProperties(sevenZipBuffer, decoder, limits);
      break;
    } catch (err) {
      // An encrypted header needs its own key before the folders' keys can be read from it.
      if (!(err instanceof AesKeyMissingError) || round >= SEVEN_ZIP_MAX_KEY_ROUNDS_OF_DISCOVERY) throw err;
      await keys.prepare([err.request], options.signal);
      if (!keys.has(err.request)) throw err;
    }
  }
  await keys.prepare(properties.map(aesKeyRequestOf), options.signal);
  keys.deferred = false;
  return selectSevenZipFiles(readSevenZipArchive(sevenZipBuffer, decoder, limits), options);
}

interface SevenZipExtractOptions {
  password?: string;
  entries?: string[];
  skipLinks?: boolean;
  onSkippedLinks?: (names: string[]) => void;
}

function selectSevenZipFiles(entries: SevenZipEntry[], options: SevenZipExtractOptions): { filename: string; buffer: Buffer }[] {
  const files: { filename: string; buffer: Buffer }[] = [];
  const skippedLinks: string[] = [];
  for (const entry of entries) {
    const kind = classifySevenZipAttributes(entry.attributes);
    if (kind.isSpecial) {
      throw new UnsafeArchiveError('special-entry', `Archive contains a device, FIFO or socket entry (${entry.name}), which is not extracted.`);
    }
    if (kind.isSymlink) {
      if (!options.skipLinks) {
        throw new UnsafeArchiveError('link-entry', 'Archive contains a symbolic or hard link entry, which is not extracted.');
      }
      skippedLinks.push(entry.name);
      continue;
    }
    const filename = sanitizeArchivePath(entry.name);
    if (filename) files.push({ filename, buffer: entry.data });
  }
  options.onSkippedLinks?.(skippedLinks);
  if (options.entries && options.entries.length > 0) {
    return files.filter((f) => matchArchiveGlob(f.filename, options.entries));
  }
  return files;
}

/**
 * Safely decompresses Gzip stream with real-time chunk-level threshold enforcement.
 * Eliminates upfront synchronous heap buffering to defend against gzip decompression bombs.
 */
export async function gunzipStreamingWithLimits(inputBuffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let destroyed = false;

    const cleanup = () => {
      chunks.length = 0;
    };

    gunzip.on('data', (chunk: Buffer) => {
      if (destroyed) return;
      totalBytes += chunk.length;

      // 1. Guard against absolute uncompressed size bomb
      if (totalBytes > ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
        destroyed = true;
        cleanup();
        gunzip.destroy();
        return reject(
          new DecompressionLimitError(
            `Archive bomb detected: uncompressed size exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes (500MB)`
          )
        );
      }

      // 2. Guard against compression ratio bomb (evaluated beyond 1MB threshold)
      if (
        inputBuffer.length > 0 &&
        totalBytes > ARCHIVE_RATIO_BASELINE_BYTES &&
        totalBytes / inputBuffer.length > ARCHIVE_SECURITY_LIMITS.MAX_RATIO
      ) {
        destroyed = true;
        cleanup();
        gunzip.destroy();
        return reject(
          new DecompressionLimitError(
            `Archive bomb detected: compression ratio exceeds ${ARCHIVE_SECURITY_LIMITS.MAX_RATIO}:1 limit`
          )
        );
      }

      chunks.push(chunk);
    });

    gunzip.on('end', () => {
      if (destroyed) return;
      // Final ratio check for smaller buffers
      if (
        inputBuffer.length > 0 &&
        totalBytes / inputBuffer.length > ARCHIVE_SECURITY_LIMITS.MAX_RATIO
      ) {
        cleanup();
        return reject(
          new DecompressionLimitError(
            `Archive bomb detected: compression ratio exceeds ${ARCHIVE_SECURITY_LIMITS.MAX_RATIO}:1 limit`
          )
        );
      }
      resolve(Buffer.concat(chunks));
    });

    gunzip.on('error', (err) => {
      if (!destroyed) {
        cleanup();
        reject(err);
      }
    });

    gunzip.end(inputBuffer);
  });
}

let resolvedZipPath: string | null = null;
export function getZipBinaryPath(): string | null {
  const envOverride = process.env.ZIP_PATH;
  if (envOverride !== undefined) {
    if (path.isAbsolute(envOverride) && fs.existsSync(envOverride)) {
      return envOverride;
    }
    return null;
  }
  if (resolvedZipPath !== null) return resolvedZipPath || null;
  const fixedLocations = [
    '/usr/bin/zip',
    '/usr/local/bin/zip',
    '/opt/homebrew/bin/zip',
    '/bin/zip',
  ];
  for (const loc of fixedLocations) {
    if (fs.existsSync(loc)) {
      resolvedZipPath = loc;
      return loc;
    }
  }
  return null;
}

/**
 * Repairs a damaged or truncated ZIP archive.
 * First attempts sandboxed `zip -FF <in> --out <out> -q -y`.
 * Falls back to pure TypeScript Local File Header scanner that salvages all valid entries
 * and rebuilds an intact Central Directory structure.
 */
export async function repairZipArchive(
  zipBuffer: Buffer,
  _options: ConversionOptions = {}
): Promise<Buffer> {
  const zipBin = getZipBinaryPath();
  if (zipBin) {
    const tmpDir = os.tmpdir();
    const token = crypto.randomBytes(8).toString('hex');
    const workDir = path.join(tmpDir, `easyconvert_zip_repair_${Date.now()}_${token}`);
    fs.mkdirSync(workDir, { recursive: true });
    try {
      const inPath = path.join(workDir, 'corrupt.zip');
      const outPath = path.join(workDir, 'repaired.zip');
      fs.writeFileSync(inPath, zipBuffer);

      const resolved = resolveSandboxedCommand(zipBin, [inPath, '-FF', '--out', outPath, '-q'], {
        networkIsolated: true,
      });
      try {
        const out = execFileSync(resolved.binary, resolved.args, {
          cwd: workDir,
          env: getSanitizedEnvironment({}, true),
          timeout: 60000,
          input: Buffer.from('y\ny\ny\ny\n'),
        });
        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 22) {
          const repaired = fs.readFileSync(outPath);
          try {
            if ((await extractZipArchive(repaired)).length > 0) {
              return repaired;
            }
          } catch {
            // Repaired zip is invalid or empty, fall through to pure TS recovery
          }
        }
      } catch {
        // Fall through to pure TS recovery
      }
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    }
  }

  // Pure TypeScript ZIP recovery:
  // Scans for Local File Header magic bytes (0x04034b50 / PK\x03\x04),
  // salvages recoverable uncompressed or deflated streams, and rebuilds Central Directory.
  const salvagedFiles: { filename: string; buffer: Buffer }[] = [];
  // The salvaged entries share the limits extraction applies: the size cap and the ratio to the damaged archive.
  const salvageBudget = new InflateBudget(
    Math.min(ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE, ARCHIVE_SECURITY_LIMITS.MAX_RATIO * zipBuffer.length)
  );
  const salvageDeflate = async (data: Buffer, entryName: string): Promise<Buffer | null> => {
    const salvage = await inflateRawSalvage(data, { label: `ZIP entry '${entryName}'`, budget: salvageBudget });
    return salvage.endedCleanly || salvage.data.length > 0 ? salvage.data : null;
  };
  let pos = 0;
  while (pos + 30 <= zipBuffer.length) {
    if (
      zipBuffer[pos] === 0x50 &&
      zipBuffer[pos + 1] === 0x4b &&
      zipBuffer[pos + 2] === 0x03 &&
      zipBuffer[pos + 3] === 0x04
    ) {
      try {
        const compMethod = zipBuffer.readUInt16LE(pos + 8);
        const compSize = zipBuffer.readUInt32LE(pos + 18);
        const uncompSize = zipBuffer.readUInt32LE(pos + 22);
        const nameLen = zipBuffer.readUInt16LE(pos + 26);
        const extraLen = zipBuffer.readUInt16LE(pos + 28);

        const dataStart = pos + 30 + nameLen + extraLen;
        if (pos + 30 + nameLen <= zipBuffer.length && dataStart <= zipBuffer.length) {
          const rawName = zipBuffer.toString('utf-8', pos + 30, pos + 30 + nameLen);
          const cleanName = sanitizeArchivePath(rawName) || path.basename(rawName);

          let rawChunk: Buffer | null = null;
          if (compSize > 0 && dataStart + compSize <= zipBuffer.length) {
            rawChunk = zipBuffer.subarray(dataStart, dataStart + compSize);
          } else {
            const nextPk = zipBuffer.indexOf(Buffer.from([0x50, 0x4b]), dataStart);
            const endSlice = nextPk !== -1 ? nextPk : zipBuffer.length;
            rawChunk = zipBuffer.subarray(dataStart, endSlice);
          }

          if (cleanName && rawChunk && rawChunk.length > 0) {
            let uncompressed: Buffer | null = null;
            if (compMethod === 0) {
              uncompressed = Buffer.from(rawChunk);
            } else if (compMethod === 8) {
              uncompressed = await salvageDeflate(rawChunk, cleanName);
            }
            if (uncompressed && (uncompSize === 0 || uncompressed.length === uncompSize || compSize === 0)) {
              salvagedFiles.push({ filename: cleanName, buffer: uncompressed });
              pos = dataStart + (compSize > 0 ? compSize : rawChunk.length);
              continue;
            }
          }
        }
      } catch (err) {
        if (err instanceof DecompressionLimitError) throw err;
      }
    }
    pos++;
  }

  if (salvagedFiles.length === 0) {
    throw new ConversionFailedError('ZIP archive repair failed: no recoverable file records found in buffer.');
  }

  return await createZipBuffer(zipEntriesWithFolders(salvagedFiles, ZIP_DEFAULT_LEVEL));
}

/** What the per-format inspectors return; `inspectArchive` adds the extractability report. */
type InspectionBody = Omit<ArchiveInspectResponse, 'extractable' | 'unextractableReasons'>;

const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_SYMLINK_TYPE = 0o120000;
const ZIP_UNIX_HOST = 3;
const ZIP_EXTERNAL_ATTR_MODE_SHIFT = 16;
const ZIP_VERSION_MADE_BY_HOST_SHIFT = 8;

function inspectZipBuffer(buffer: Buffer): InspectionBody {
  if (buffer.length < 22) {
    throw new ConversionFailedError('Invalid ZIP archive: buffer too small');
  }

  let eocdOffset = -1;
  const maxScan = Math.min(buffer.length, 65535 + 22);
  const startScan = buffer.length - maxScan;
  for (let i = buffer.length - 22; i >= startScan; i--) {
    if (
      buffer[i] === 0x50 &&
      buffer[i + 1] === 0x4b &&
      buffer[i + 2] === 0x05 &&
      buffer[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }

  const entries: ArchiveEntryMetadata[] = [];
  let isEncryptedArchive = false;

  if (eocdOffset !== -1) {
    let cdOffset = buffer.readUInt32LE(eocdOffset + 16);

    // Check for Zip64 EOCD locator (0x07064b50)
    if (eocdOffset >= 20) {
      const locPos = eocdOffset - 20;
      if (
        buffer[locPos] === 0x50 &&
        buffer[locPos + 1] === 0x4b &&
        buffer[locPos + 2] === 0x06 &&
        buffer[locPos + 3] === 0x07
      ) {
        const zip64EocdOffset = Number(buffer.readBigUInt64LE(locPos + 8));
        if (
          zip64EocdOffset + 56 <= buffer.length &&
          buffer[zip64EocdOffset] === 0x50 &&
          buffer[zip64EocdOffset + 1] === 0x4b &&
          buffer[zip64EocdOffset + 2] === 0x06 &&
          buffer[zip64EocdOffset + 3] === 0x06
        ) {
          cdOffset = Number(buffer.readBigUInt64LE(zip64EocdOffset + 48));
        }
      }
    }

    let pos = cdOffset;
    while (
      pos + 46 <= buffer.length &&
      buffer[pos] === 0x50 &&
      buffer[pos + 1] === 0x4b &&
      buffer[pos + 2] === 0x01 &&
      buffer[pos + 3] === 0x02
    ) {
      const flags = buffer.readUInt16LE(pos + 8);
      const isEncrypted = (flags & 1) !== 0;
      if (isEncrypted) isEncryptedArchive = true;

      const modTime = buffer.readUInt16LE(pos + 12);
      const modDate = buffer.readUInt16LE(pos + 14);
      const year = ((modDate >> 9) & 0x7f) + 1980;
      const month = Math.max(0, Math.min(11, ((modDate >> 5) & 0x0f) - 1));
      const day = Math.max(1, Math.min(31, modDate & 0x1f));
      const hour = Math.min(23, (modTime >> 11) & 0x1f);
      const min = Math.min(59, (modTime >> 5) & 0x3f);
      const sec = Math.min(59, (modTime & 0x1f) * 2);
      const modifiedAt = new Date(Date.UTC(year, month, day, hour, min, sec)).toISOString();

      const crc = buffer.readUInt32LE(pos + 16);
      const crc32Str = crc.toString(16).padStart(8, '0');
      let compSize = buffer.readUInt32LE(pos + 20);
      let uncompSize = buffer.readUInt32LE(pos + 24);
      const fnLen = buffer.readUInt16LE(pos + 28);
      const extraLen = buffer.readUInt16LE(pos + 30);
      const commentLen = buffer.readUInt16LE(pos + 32);

      const nameStart = pos + 46;
      const nameEnd = nameStart + fnLen;
      const rawName = nameEnd <= buffer.length ? buffer.toString('utf-8', nameStart, nameEnd) : 'unknown';

      if (extraLen > 0 && nameEnd + extraLen <= buffer.length) {
        let extraPos = nameEnd;
        while (extraPos + 4 <= nameEnd + extraLen) {
          const headerId = buffer.readUInt16LE(extraPos);
          const dataSize = buffer.readUInt16LE(extraPos + 2);
          if (headerId === 0x0001 && extraPos + 4 + dataSize <= nameEnd + extraLen) {
            let offsetInZip64 = extraPos + 4;
            if (uncompSize === 0xffffffff && offsetInZip64 + 8 <= extraPos + 4 + dataSize) {
              uncompSize = Number(buffer.readBigUInt64LE(offsetInZip64));
              offsetInZip64 += 8;
            }
            if (compSize === 0xffffffff && offsetInZip64 + 8 <= extraPos + 4 + dataSize) {
              compSize = Number(buffer.readBigUInt64LE(offsetInZip64));
            }
            break;
          }
          extraPos += 4 + dataSize;
        }
      }

      const externalAttributes = buffer.readUInt32LE(pos + 38);
      const isDirectory = rawName.endsWith('/') || (externalAttributes & 0x10) !== 0;
      const madeByHost = buffer.readUInt16LE(pos + 4) >>> ZIP_VERSION_MADE_BY_HOST_SHIFT;
      const unixFileType = (externalAttributes >>> ZIP_EXTERNAL_ATTR_MODE_SHIFT) & UNIX_FILE_TYPE_MASK;
      const isSymlink = madeByHost === ZIP_UNIX_HOST && unixFileType === UNIX_SYMLINK_TYPE;

      entries.push({
        name: rawName,
        uncompressedSize: uncompSize,
        compressedSize: compSize,
        isEncrypted,
        isDirectory,
        modifiedAt,
        crc32: crc32Str,
        ...(isSymlink ? { kind: 'symlink' as const } : {}),
      });

      pos += 46 + fnLen + extraLen + commentLen;
    }
  } else {
    let pos = 0;
    while (pos + 30 <= buffer.length) {
      if (
        buffer[pos] === 0x50 &&
        buffer[pos + 1] === 0x4b &&
        buffer[pos + 2] === 0x03 &&
        buffer[pos + 3] === 0x04
      ) {
        const flags = buffer.readUInt16LE(pos + 6);
        const isEncrypted = (flags & 1) !== 0;
        if (isEncrypted) isEncryptedArchive = true;
        const crc = buffer.readUInt32LE(pos + 14);
        const compSize = buffer.readUInt32LE(pos + 18);
        const uncompSize = buffer.readUInt32LE(pos + 22);
        const nameLen = buffer.readUInt16LE(pos + 26);
        const extraLen = buffer.readUInt16LE(pos + 28);
        const name = pos + 30 + nameLen <= buffer.length ? buffer.toString('utf-8', pos + 30, pos + 30 + nameLen) : 'unknown';
        entries.push({
          name,
          uncompressedSize: uncompSize,
          compressedSize: compSize,
          isEncrypted,
          isDirectory: name.endsWith('/'),
          crc32: crc.toString(16).padStart(8, '0'),
        });
        pos += 30 + nameLen + extraLen + compSize;
      } else {
        pos++;
      }
    }
  }

  let totalUncompressedBytes = 0;
  let totalCompressedBytes = 0;
  for (const e of entries) {
    totalUncompressedBytes += e.uncompressedSize;
    totalCompressedBytes += e.compressedSize || 0;
  }

  return {
    format: 'zip',
    totalEntries: entries.length,
    totalUncompressedBytes,
    totalCompressedBytes,
    isEncrypted: isEncryptedArchive,
    entries,
  };
}

function inspectTarBuffer(buffer: Buffer, format = 'tar'): InspectionBody {
  const entries: ArchiveEntryMetadata[] = [];
  let totalUncompressedBytes = 0;

  // readTarEntries applies pax/GNU long names, verifies checksums and enforces the bomb limits.
  for (const entry of readTarEntries(buffer)) {
    const isDirectory = entry.type === 'directory';
    const isFile = entry.type === 'file';
    const size = isFile ? entry.buffer.length : 0;
    entries.push({
      name: entry.filename,
      uncompressedSize: size,
      compressedSize: size,
      isEncrypted: false,
      isDirectory,
      modifiedAt: entry.mtime > 0 ? new Date(entry.mtime * 1000).toISOString() : undefined,
      crc32: isFile ? crc32(entry.buffer).toString(16).padStart(8, '0') : undefined,
    });
    totalUncompressedBytes += size;
  }

  return {
    format,
    totalEntries: entries.length,
    totalUncompressedBytes,
    totalCompressedBytes: totalUncompressedBytes,
    isEncrypted: false,
    entries,
  };
}

async function inspectArchiveVia7zCli(
  buffer: Buffer,
  format: '7z' | 'rar',
  p7z: string,
  password?: string
): Promise<InspectionBody> {
  const tmpDir = os.tmpdir();
  const token = crypto.randomBytes(8).toString('hex');
  const workDir = path.join(tmpDir, `easyconvert_${format}_inspect_${Date.now()}_${token}`);
  fs.mkdirSync(workDir, { recursive: true });
  try {
    const archivePath = path.join(workDir, `archive.${format}`);
    fs.writeFileSync(archivePath, buffer);

    // A password is answered on stdin (never in argv); without one, 7-Zip's prompt reads an empty answer.
    const resolved = resolveSandboxedCommand(p7z, ['l', '-slt', '-ba', archivePath], {
      networkIsolated: true,
    });

    let stdoutStr = '';
    try {
      const out = execFileSyncWithPasswordStdin(resolved.binary, resolved.args, {
        cwd: workDir,
        env: getSanitizedEnvironment({}, true),
        timeout: SEVEN_ZIP_LISTING_TIMEOUT_MS,
        input: sevenZipReadPasswordInput(password),
        maxBuffer: listingBufferLimit(ARCHIVE_SECURITY_LIMITS),
      });
      stdoutStr = out.toString('utf-8');
    } catch (err: any) {
      if (err?.code === 'ENOBUFS') {
        throw new UnsafeArchiveError(
          'entry-count',
          `Archive bomb detected: file count exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_FILES}`
        );
      }
      // Only 7-Zip's own stderr lines decide: stdout carries the prompt and entry names on every listing.
      if (isArchivePasswordFailure(archiveFailureStderr(err))) {
        throw new ArchiveEncryptedHeaderError('Archive header is encrypted and requires a password to inspect entries.');
      }
      throw new ConversionFailedError(`Failed to inspect ${format} archive: ${err.message}`);
    }

    // Inspection writes nothing and reports unsafe entries rather than refusing them. Only the resource caps,
    // which protect this service from an unbounded listing, still refuse.
    const listingText = stripSevenZipPasswordPrompt(stdoutStr);
    const listed = parse7zTechnicalListing(listingText);
    assertListingResourceCaps(listed, buffer.length, ARCHIVE_SECURITY_LIMITS);

    const entries: ArchiveEntryMetadata[] = [];
    const blocks = listingText.split(/\r?\n\r?\n/);
    let isArchiveEncrypted = false;

    for (const block of blocks) {
      if (!block.includes('Path = ') || block.includes('Listing archive:')) continue;
      const lines = block.split(/\r?\n/);
      const record: Record<string, string> = {};
      for (const line of lines) {
        const eq = line.indexOf(' = ');
        if (eq !== -1) {
          record[line.slice(0, eq).trim()] = line.slice(eq + 3).trim();
        }
      }
      if (!record.Path || record.Path === archivePath) continue;

      const uncompSize = record.Size ? parseInt(record.Size, 10) : 0;
      const compSize = record['Packed Size'] ? parseInt(record['Packed Size'], 10) : undefined;
      const isEnc = record.Encrypted === '+';
      if (isEnc) isArchiveEncrypted = true;
      const isDir = record.Folder === '+' || (record.Attributes && record.Attributes.includes('D')) || record.Path.endsWith('/');
      const modTime = record.Modified || undefined;
      const crcHex = record.CRC || undefined;

      // The name stays verbatim so a traversal or absolute path is visible to the caller; it is flagged, not followed.
      entries.push({
        name: record.Path,
        uncompressedSize: uncompSize,
        compressedSize: compSize,
        isEncrypted: isEnc,
        isDirectory: Boolean(isDir),
        modifiedAt: modTime,
        crc32: crcHex ? crcHex.toLowerCase() : undefined,
      });
    }

    // Both parsers read the same blocks, so they agree entry for entry; anything else is a listing we cannot trust.
    if (listed.length !== entries.length) {
      throw new UnsafeArchiveError('malformed-listing', 'Archive listing could not be matched entry for entry.');
    }
    listed.forEach((item, index) => {
      const kind = inspectedKindOf(item);
      if (kind !== undefined) entries[index].kind = kind;
    });

    let totalUncompressedBytes = 0;
    let totalCompressedBytes = 0;
    for (const e of entries) {
      totalUncompressedBytes += e.uncompressedSize;
      totalCompressedBytes += e.compressedSize || 0;
    }

    return {
      format,
      totalEntries: entries.length,
      totalUncompressedBytes,
      totalCompressedBytes,
      isEncrypted: isArchiveEncrypted,
      entries,
    };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

async function inspect7zBuffer(
  buffer: Buffer,
  password?: string
): Promise<InspectionBody> {
  const p7z = get7zBinaryPath();
  if (p7z) {
    return await inspectArchiveVia7zCli(buffer, '7z', p7z, password);
  }

  // Pure TS fallback for 7z inspection. With a password the in-process AES coder opens an encrypted header itself.
  if (buffer.length >= 32 && !password) {
    const nextHeaderOffset = Number(buffer.readBigUInt64LE(12));
    const nextHeaderSize = Number(buffer.readBigUInt64LE(20));
    const nhStart = 32 + nextHeaderOffset;
    if (nhStart + nextHeaderSize <= buffer.length) {
      const nh = buffer.subarray(nhStart, nhStart + nextHeaderSize);
      if (nh.length > 0 && nh[0] === 0x17) {
        for (let i = 0; i < nh.length - 4; i++) {
          if (nh[i] === 0x06 && nh[i + 1] === 0xf1 && nh[i + 2] === 0x07 && nh[i + 3] === 0x01) {
            throw new ArchiveEncryptedHeaderError('Archive header is encrypted and requires a password to inspect entries.');
          }
        }
      }
    }
  }

  const rawExtracted = await extract7zArchiveAsync(buffer, { password });
  const entries: ArchiveEntryMetadata[] = rawExtracted.map((f) => ({
    name: f.filename,
    uncompressedSize: f.buffer.length,
    compressedSize: f.buffer.length,
    isEncrypted: false,
    isDirectory: false,
    crc32: crc32(f.buffer).toString(16).padStart(8, '0'),
  }));

  const totalUncompressedBytes = entries.reduce((acc, e) => acc + e.uncompressedSize, 0);
  return {
    format: '7z',
    totalEntries: entries.length,
    totalUncompressedBytes,
    totalCompressedBytes: totalUncompressedBytes,
    isEncrypted: false,
    entries,
  };
}

async function inspectRarBuffer(
  buffer: Buffer,
  password?: string
): Promise<InspectionBody> {
  // Fast byte-level inspection for RAR header encryption (MHD_PASSWORD flag)
  if (buffer.length >= 14) {
    const isRar4 =
      buffer[0] === 0x52 &&
      buffer[1] === 0x61 &&
      buffer[2] === 0x72 &&
      buffer[3] === 0x21 &&
      buffer[4] === 0x1a &&
      buffer[5] === 0x07 &&
      buffer[6] === 0x00;
    if (isRar4) {
      const headType = buffer[9];
      const headFlags = buffer.readUInt16LE(10);
      if (headType === 0x73 && (headFlags & 0x0080) !== 0 && !password) {
        throw new ArchiveEncryptedHeaderError(
          'Archive header is encrypted and requires a password to inspect entries.'
        );
      }
    }
  }

  const p7z = get7zBinaryPath();
  if (p7z) {
    return await inspectArchiveVia7zCli(buffer, 'rar', p7z, password);
  }

  // Pure TS fallback for RAR inspection
  if (buffer.length < 14) {
    throw new ConversionFailedError('Invalid RAR archive: buffer too small');
  }

  let offset = 7;
  if (offset + 7 <= buffer.length) {
    const headType = buffer[offset + 2];
    const headFlags = buffer.readUInt16LE(offset + 3);
    const headSize = buffer.readUInt16LE(offset + 5);
    if (headType === 0x73) {
      if ((headFlags & 0x0080) !== 0) {
        throw new ArchiveEncryptedHeaderError('Archive header is encrypted and requires a password to inspect entries.');
      }
      offset += headSize;
    }
  }

  const entries: ArchiveEntryMetadata[] = [];
  let isArchiveEncrypted = false;

  while (offset + 7 <= buffer.length) {
    const headType = buffer[offset + 2];
    const headFlags = buffer.readUInt16LE(offset + 3);
    const headSize = buffer.readUInt16LE(offset + 5);
    if (headSize < 7 || offset + headSize > buffer.length) break;

    if (headType === 0x7b) {
      break;
    }

    if (headType === 0x74 && offset + 32 <= buffer.length) {
      const packSize = buffer.readUInt32LE(offset + 7);
      const unpSize = buffer.readUInt32LE(offset + 11);
      const fileCrc = buffer.readUInt32LE(offset + 16);
      const nameSize = buffer.readUInt16LE(offset + 26);
      const isEnc = (headFlags & 0x0004) !== 0;
      if (isEnc) isArchiveEncrypted = true;

      const nameStart = offset + 32;
      const rawName = nameStart + nameSize <= buffer.length
        ? buffer.toString('utf-8', nameStart, nameStart + nameSize)
        : 'unknown';

      entries.push({
        name: sanitizeArchivePath(rawName) || rawName,
        uncompressedSize: unpSize,
        compressedSize: packSize,
        isEncrypted: isEnc,
        isDirectory: rawName.endsWith('/'),
        crc32: fileCrc.toString(16).padStart(8, '0'),
      });

      offset += headSize + packSize;
    } else {
      offset += headSize;
    }
  }

  const totalUncompressedBytes = entries.reduce((acc, e) => acc + e.uncompressedSize, 0);
  const totalCompressedBytes = entries.reduce((acc, e) => acc + (e.compressedSize || 0), 0);

  return {
    format: 'rar',
    totalEntries: entries.length,
    totalUncompressedBytes,
    totalCompressedBytes,
    isEncrypted: isArchiveEncrypted,
    entries,
  };
}

/** Archive sources that are ZIP packages with another name: read with the ZIP reader. */
const ZIP_PACKAGE_SOURCES: ReadonlySet<string> = new Set(['jar', 'war', 'ear']);
const BZIP2_TAR_SOURCES: ReadonlySet<string> = new Set(['tar.bz2', 'tbz2', 'tbz', 'tar.bz']);
const BZIP2_SOURCES: ReadonlySet<string> = new Set([...BZIP2_TAR_SOURCES, 'bz2', 'bz']);
/** Archive sources only the native 7-Zip engine reads. */
const NATIVE_SEVEN_ZIP_SOURCES: ReadonlySet<string> = new Set([
  'arj', 'cab', 'cpio', 'deb', 'dmg', 'img', 'iso', 'lha', 'lzma', 'rpm', 'tar.z', 'tz', 'z',
]);

function unreadableArchiveSource(src: string): ConversionFailedError {
  if (NATIVE_SEVEN_ZIP_SOURCES.has(src)) {
    // A worker pool can be mixed: the queue retries an engine error on a worker that has 7-Zip.
    return new EngineUnavailableError('7-Zip', `reading .${src} archives needs the native 7-Zip engine`);
  }
  return new ConversionFailedError(`Cannot read .${src} archives: no engine reads this format.`);
}

/**
 * Describes an archive without extracting it. Unsafe entries are reported, not refused: links, absolute or
 * traversing names and duplicated paths come back as per-entry flags with `extractable: false` and the
 * reasons. Only resource caps (entry count, declared size, ratio) still reject, in the 7z/RAR listing.
 * Tar names are normalized by the tar reader, so traversal inside a tar is not visible here.
 */
export async function inspectArchive(
  archiveBuffer: Buffer,
  options: { filename?: string; password?: string } = {}
): Promise<ArchiveInspectResponse> {
  const body = await inspectArchiveEntries(archiveBuffer, options);
  const safety = summarizeInspectionSafety(body.entries);
  const entries = body.entries.map((entry, index) => {
    const flag = safety.flags[index];
    return {
      ...entry,
      ...(flag.kind !== undefined ? { kind: flag.kind } : {}),
      ...(flag.unsafePath ? { unsafePath: true } : {}),
      ...(flag.duplicate ? { duplicate: true } : {}),
    };
  });
  return { ...body, entries, extractable: safety.extractable, unextractableReasons: safety.unextractableReasons };
}

async function inspectArchiveEntries(
  archiveBuffer: Buffer,
  options: { filename?: string; password?: string } = {}
): Promise<InspectionBody> {
  if (!archiveBuffer || archiveBuffer.length === 0) {
    throw new ConversionFailedError('Archive buffer is empty.');
  }

  // 1. ZIP
  if (
    archiveBuffer.length >= 4 &&
    archiveBuffer[0] === 0x50 &&
    archiveBuffer[1] === 0x4b &&
    (archiveBuffer[2] === 0x03 || archiveBuffer[2] === 0x05 || archiveBuffer[2] === 0x07)
  ) {
    return inspectZipBuffer(archiveBuffer);
  }

  // 2. 7z
  if (
    archiveBuffer.length >= 6 &&
    archiveBuffer[0] === 0x37 &&
    archiveBuffer[1] === 0x7a &&
    archiveBuffer[2] === 0xbc &&
    archiveBuffer[3] === 0xaf &&
    archiveBuffer[4] === 0x27 &&
    archiveBuffer[5] === 0x1c
  ) {
    return await inspect7zBuffer(archiveBuffer, options.password);
  }

  // 3. RAR
  if (
    archiveBuffer.length >= 7 &&
    archiveBuffer[0] === 0x52 &&
    archiveBuffer[1] === 0x61 &&
    archiveBuffer[2] === 0x72 &&
    archiveBuffer[3] === 0x21 &&
    archiveBuffer[4] === 0x1a &&
    archiveBuffer[5] === 0x07
  ) {
    return await inspectRarBuffer(archiveBuffer, options.password);
  }

  // 4. Compressed TAR wrappers: GZ, BZ2, ZST, XZ
  if (archiveBuffer.length >= 2 && archiveBuffer[0] === 0x1f && archiveBuffer[1] === 0x8b) {
    try {
      const decompressed = await gunzipStreamingWithLimits(archiveBuffer);
      return inspectTarBuffer(decompressed, 'tar.gz');
    } catch (err) {
      if (err instanceof DecompressionLimitError) throw err;
      throw new ConversionFailedError('Failed to decompress gzip archive.');
    }
  }

  if (archiveBuffer.length >= 3 && archiveBuffer[0] === 0x42 && archiveBuffer[1] === 0x5a && archiveBuffer[2] === 0x68) {
    try {
      const decompressed = decompressBzip2(archiveBuffer, ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE);
      return inspectTarBuffer(decompressed, 'tar.bz2');
    } catch {
      throw new ConversionFailedError('Failed to decompress bzip2 archive.');
    }
  }

  if (archiveBuffer.length >= 4 && archiveBuffer.subarray(0, 4).equals(ZSTD_MAGIC_LE)) {
    try {
      const decompressed = decompressZstd(archiveBuffer);
      return inspectTarBuffer(decompressed, 'tar.zst');
    } catch (err) {
      // Typed decoder errors (bomb guard, malformed frame) already say what went wrong.
      if (err instanceof ConversionFailedError) throw err;
      throw new ConversionFailedError('Failed to decompress zstd archive.');
    }
  }

  // 5. TAR
  if (archiveBuffer.length >= 512) {
    const magic = archiveBuffer.toString('ascii', 257, 262);
    if (magic.startsWith('ustar') || options.filename?.endsWith('.tar')) {
      return inspectTarBuffer(archiveBuffer, 'tar');
    }
  }

  const hint = options.filename ? path.extname(options.filename).toLowerCase() : '';
  if (hint === '.zip') return inspectZipBuffer(archiveBuffer);
  if (hint === '.7z') return await inspect7zBuffer(archiveBuffer, options.password);
  if (hint === '.rar') return await inspectRarBuffer(archiveBuffer, options.password);
  if (hint === '.tar') return inspectTarBuffer(archiveBuffer, 'tar');

  throw new ConversionFailedError('Unsupported or unrecognized archive format for inspection.');
}

/**
 * A failure that already names what is wrong with the archive (a limit, an unsupported method, a password, a collision,
 * a malformed stream, an unsafe entry). It keeps its class, and with it the HTTP status the routes derive from it;
 * only an untyped error is wrapped with the file name.
 */
function isTypedArchiveFailure(err: unknown): err is ConversionFailedError {
  return err instanceof ConversionFailedError && err.constructor !== ConversionFailedError;
}

export async function convertArchive(
  inputBuffer: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: ConversionOptions = {},
  originalFilename: string
): Promise<ConversionResult> {
  let effectiveBuffer = inputBuffer;
  let effectiveSourceFormat = sourceFormat.toLowerCase();
  let effectiveFilename = originalFilename;

  // Stitch multi-volume archive parts if provided in options or if part sequence detected
  const multiParts = options.archiveParts;
  if (multiParts && Array.isArray(multiParts) && multiParts.length > 0) {
    const stitched = stitchMultiVolumeArchive(multiParts);
    effectiveBuffer = stitched.buffer;
    effectiveFilename = stitched.baseFilename;
    effectiveSourceFormat = stitched.format || effectiveSourceFormat;
  } else if (isSplitArchive(originalFilename)) {
    const stitched = stitchMultiVolumeArchive([{ filename: originalFilename, buffer: inputBuffer }]);
    effectiveBuffer = stitched.buffer;
    effectiveFilename = stitched.baseFilename;
    effectiveSourceFormat = stitched.format || effectiveSourceFormat;
  }

  const baseName = effectiveFilename.replace(/\.[^/.]+$/, '');
  const src = effectiveSourceFormat;
  const tgt = targetFormat.toLowerCase();

  if (options.repair) {
    if (src !== 'zip' && tgt !== 'zip') {
      throw new UnsupportedOptionError('Archive repair mode is only supported for ZIP archives.');
    }
    const repairedBuffer = await repairZipArchive(effectiveBuffer, options);
    return {
      buffer: repairedBuffer,
      mimeType: 'application/zip',
      filename: `${baseName}.zip`,
      size: repairedBuffer.length,
    };
  }

  assertArchivePasswordSafe(options.password);

  if (options.password && tgt !== 'zip' && tgt !== '7z') {
    throw new UnsupportedOptionError(`Target archive format '${tgt}' does not support password encryption.`);
  }

  // Attempt native 7-Zip acceleration hook if explicitly enabled in options
  if (options.useNative7z) {
    const native7zRes = convertWithNative7z(effectiveBuffer, src, tgt, options, effectiveFilename);
    if (native7zRes) {
      if (options.splitVolumeBytes && options.splitVolumeBytes > 0) {
        const parts = splitArchive(native7zRes.buffer, native7zRes.filename, options.splitVolumeBytes);
        return {
          ...native7zRes,
          parts,
        };
      }
      return native7zRes;
    }
  }

  // 1. Extract files from source if it is an archive
  let files: { filename: string; buffer: Buffer }[] = [];
  let skippedLinks: string[] = [];
  if (src === 'zip' || ZIP_PACKAGE_SOURCES.has(src)) {
    const hasZipMagic =
      effectiveBuffer.length >= 4 &&
      effectiveBuffer[0] === 0x50 &&
      effectiveBuffer[1] === 0x4b;
    try {
      files = await extractZipArchive(effectiveBuffer, {
        ...options,
        onSkippedLinks: (names) => {
          skippedLinks = names;
        },
      });
    } catch (err) {
      if (isTypedArchiveFailure(err)) throw err;
      throw new ConversionFailedError(
        `Failed to extract ZIP archive '${effectiveFilename}': ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else if (src === 'tar') {
    try {
      files = extractTarArchive(effectiveBuffer, options);
    } catch (err) {
      if (err instanceof ArchiveEntryCollisionError) throw err;
      throw new ConversionFailedError(
        `Failed to extract TAR archive '${effectiveFilename}': ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else if (src === 'gz' || src === 'tgz' || src === 'tar.gz') {
    try {
      const uncompressed = await gunzipStreamingWithLimits(effectiveBuffer);
      if (src === 'tgz' || src === 'tar.gz' || uncompressed.subarray(257, 262).toString('ascii') === 'ustar') {
        files = extractTarArchive(uncompressed, options);
      } else {
        files = [{ filename: baseName, buffer: uncompressed }];
      }
    } catch (err) {
      if (isTypedArchiveFailure(err)) throw err;
      throw new ConversionFailedError(
        `Failed to decompress GZIP archive '${effectiveFilename}': ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else if (BZIP2_SOURCES.has(src)) {
    try {
      const uncompressed = decompressBzip2(effectiveBuffer, ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE);
      if (uncompressed.length > ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
        throw new DecompressionLimitError(
          `Archive bomb detected: uncompressed size exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes (500MB)`
        );
      }
      if (effectiveBuffer.length > 0 && uncompressed.length / effectiveBuffer.length > ARCHIVE_SECURITY_LIMITS.MAX_RATIO) {
        throw new DecompressionLimitError(
          `Archive bomb detected: compression ratio exceeds ${ARCHIVE_SECURITY_LIMITS.MAX_RATIO}:1 limit`
        );
      }
      if (BZIP2_TAR_SOURCES.has(src) || uncompressed.subarray(257, 262).toString('ascii') === 'ustar') {
        files = extractTarArchive(uncompressed, options);
      } else {
        files = [{ filename: baseName, buffer: uncompressed }];
      }
    } catch (err) {
      if (isTypedArchiveFailure(err)) throw err;
      throw new ConversionFailedError(
        `Failed to decompress BZIP2 archive '${effectiveFilename}': ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else if (src === 'rar') {
    try {
      files = extractRarArchive(effectiveBuffer, options);
      if (options.entries && options.entries.length > 0) {
        files = files.filter((f) => matchArchiveGlob(f.filename, options.entries));
      }
    } catch (err: any) {
      if (isArchivePasswordError(err)) throw err;
      throw new ConversionFailedError(
        `Failed to extract RAR archive '${effectiveFilename}': ${err?.message || String(err)}`
      );
    }
  } else if (src === '7z' || src === 'tar.7z') {
    try {
      files = await extract7zArchiveAsync(effectiveBuffer, {
        ...options,
        onSkippedLinks: (names) => {
          skippedLinks = names;
        },
      });
    } catch (err: any) {
      // The typed failures (password, unsupported method, size limit, unsafe entry, corrupt stream) keep their class and status.
      if (err instanceof ConversionFailedError) throw err;
      throw new ConversionFailedError(
        `Failed to extract 7z archive '${effectiveFilename}': ${err?.message || String(err)}`
      );
    }
  } else if (src === 'zst' || src === 'zstd' || src === 'tar.zst') {
    let uncompressed: Buffer;
    try {
      uncompressed = decodeZstdArchivePayload(effectiveBuffer, options.zstdDict);
    } catch (err) {
      // Typed decoder errors (bomb guards, malformed frames) already say what went wrong.
      if (err instanceof ConversionFailedError) throw err;
      throw new ConversionFailedError(
        `Failed to decompress zstd archive: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (uncompressed.length > ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
      throw new DecompressionLimitError(
        `Archive bomb detected: uncompressed size exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes (500MB)`
      );
    }
    // Same rule as the decoder: the ratio only counts once the output is past the guard floor.
    if (exceedsZstdRatioGuard(uncompressed.length, effectiveBuffer.length)) {
      throw new DecompressionLimitError(
        `Archive bomb detected: compression ratio (${(uncompressed.length / effectiveBuffer.length).toFixed(1)}:1) exceeds ${ARCHIVE_SECURITY_LIMITS.MAX_RATIO}:1 limit`
      );
    }
    if (src === 'tar.zst' || uncompressed.subarray(257, 262).toString('ascii') === 'ustar') {
      files = extractTarArchive(uncompressed, options);
    } else {
      files = [{ filename: baseName, buffer: uncompressed }];
    }
  } else if (src === 'tar.xz' || src === 'txz' || src === 'xz') {
    try {
      const uncompressed = decompressXz(effectiveBuffer);
      if (uncompressed.length > ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
        throw new DecompressionLimitError(
          `Archive bomb detected: uncompressed size exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes (500MB)`
        );
      }
      if (effectiveBuffer.length > 0 && uncompressed.length / effectiveBuffer.length > ARCHIVE_SECURITY_LIMITS.MAX_RATIO) {
        throw new DecompressionLimitError(
          `Archive bomb detected: compression ratio exceeds ${ARCHIVE_SECURITY_LIMITS.MAX_RATIO}:1 limit`
        );
      }
      if (src === 'tar.xz' || src === 'txz' || uncompressed.subarray(257, 262).toString('ascii') === 'ustar') {
        files = extractTarArchive(uncompressed, options);
      } else {
        files = [{ filename: baseName, buffer: uncompressed }];
      }
    } catch (err) {
      if (isTypedArchiveFailure(err)) throw err;
      throw new ConversionFailedError(
        `Failed to decompress XZ archive '${effectiveFilename}': ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const ARCHIVE_CONTAINER_FORMATS = new Set([
    'zip',
    'tar',
    'gz',
    'tgz',
    'tar.gz',
    'bz2',
    'tar.bz2',
    'tbz',
    'tbz2',
    '7z',
    'tar.7z',
    'rar',
    'zst',
    'zstd',
    'tar.zst',
    'xz',
    'txz',
    'tar.xz',
    ...ZIP_PACKAGE_SOURCES,
    'tar.bz',
  ]);
  function isValidEmptyArchive(format: string, buffer: Buffer): boolean {
    if (format === 'zip') {
      return buffer.length >= 22 && buffer[0] === 0x50 && buffer[1] === 0x4b;
    }
    if (format === 'tar') {
      return buffer.length >= 512 && buffer.subarray(0, 512).every((b) => b === 0);
    }
    return false;
  }

  if (files.length === 0) {
    if (isValidEmptyArchive(src, effectiveBuffer)) {
      // Valid empty archive: retain files = [] so empty target archive is generated
    } else if (ARCHIVE_CONTAINER_FORMATS.has(src)) {
      throw new ConversionFailedError(
        `Failed to extract any files from source archive '${effectiveFilename}' (corrupt or invalid archive format)`
      );
    } else if (FORMAT_REGISTRY[src]?.category === 'archive') {
      // An archive this engine cannot read is never "converted" by packing the archive file into the target as one
      // entry. 7-Zip reads many of these formats (the native engine does); for the others nothing does.
      throw unreadableArchiveSource(src);
    } else {
      // A source that is not an archive (a document, an image) is packed into the target as the one file it is.
      files = [{ filename: effectiveFilename, buffer: effectiveBuffer }];
    }
  }

  let result: ConversionResult;

  // 2. Target TAR.GZ or TGZ
  if (tgt === 'tar.gz' || tgt === 'tgz') {
    const tarResult = createTarArchive(files, options, `${baseName}.tar`);
    const gzipped = zlib.gzipSync(tarResult.buffer, {
      level: resolveArchiveCompressionLevel(options.compressionLevel),
    });
    result = {
      buffer: gzipped,
      mimeType: 'application/gzip',
      filename: `${baseName}.${tgt}`,
      size: gzipped.length,
    };
  } else if (tgt === 'tar.bz2' || tgt === 'tbz2' || tgt === 'tbz') {
    // 3. Target TAR.BZ2 or TBZ2 or TBZ
    const tarResult = createTarArchive(files, options, `${baseName}.tar`);
    const bz2Buffer = await compressBzip2Async(tarResult.buffer);
    result = {
      buffer: bz2Buffer,
      mimeType: 'application/x-bzip-compressed-tar',
      filename: `${baseName}.${tgt}`,
      size: bz2Buffer.length,
    };
  } else if (tgt === 'bz2' || tgt === 'bz') {
    // 3.1 Target BZ2
    const rawToCompress = files.length === 1 ? files[0].buffer : effectiveBuffer;
    const bz2Buffer = await compressBzip2Async(rawToCompress);
    result = {
      buffer: bz2Buffer,
      mimeType: 'application/x-bzip2',
      filename: `${effectiveFilename}.${tgt}`,
      size: bz2Buffer.length,
    };
  } else if (tgt === '7z' || tgt === 'tar.7z') {
    // 4. Target 7Z
    result = await create7zArchiveAsync(files, options, `${baseName}.${tgt}`);
  } else if (tgt === 'rar') {
    // 5. Target RAR
    throw new ConversionFailedError(
      "Target archive format 'rar' creation is not supported. RAR archive creation has been removed per D8; please use ZIP, 7z, or TAR."
    );
  } else if (tgt === 'tar') {
    // 6. Target TAR
    result = createTarArchive(files, options, `${baseName}.tar`);
  } else if (tgt === 'gz') {
    // 7. Target GZ
    const rawToCompress = files.length === 1 ? files[0].buffer : effectiveBuffer;
    const gzipped = zlib.gzipSync(rawToCompress, {
      level: resolveArchiveCompressionLevel(options.compressionLevel),
    });
    result = {
      buffer: gzipped,
      mimeType: 'application/gzip',
      filename: `${effectiveFilename}.gz`,
      size: gzipped.length,
    };
  } else if (tgt === 'tar.zst') {
    // 7.1 Target TAR.ZST
    const tarResult = createTarArchive(files, options, `${baseName}.tar`);
    let zstdBuffer: Buffer;
    if (options.zstdDict) {
      const dict =
        typeof options.zstdDict === 'string' && (options.zstdDict === 'office' || options.zstdDict === 'data')
          ? getPretrainedDictionary(options.zstdDict)
          : DATA_DICTIONARY_JSON_CSV;
      zstdBuffer = compressWithZstdDict(tarResult.buffer, dict);
    } else {
      zstdBuffer = await compressZstdAsync(tarResult.buffer);
    }
    result = {
      buffer: zstdBuffer,
      mimeType: 'application/x-zstd-compressed-tar',
      filename: `${baseName}.${tgt}`,
      size: zstdBuffer.length,
    };
  } else if (tgt === 'zst' || tgt === 'zstd') {
    // 7.2 Target ZST / ZSTD
    const rawToCompress = files.length === 1 ? files[0].buffer : effectiveBuffer;
    let zstdBuffer: Buffer;
    if (options.zstdDict) {
      const dict =
        typeof options.zstdDict === 'string' && (options.zstdDict === 'office' || options.zstdDict === 'data')
          ? getPretrainedDictionary(options.zstdDict)
          : DATA_DICTIONARY_JSON_CSV;
      zstdBuffer = compressWithZstdDict(rawToCompress, dict);
    } else {
      zstdBuffer = await compressZstdAsync(rawToCompress);
    }
    result = {
      buffer: zstdBuffer,
      mimeType: 'application/zstd',
      filename: `${effectiveFilename}.${tgt}`,
      size: zstdBuffer.length,
    };
  } else if (tgt === 'tar.xz' || tgt === 'txz') {
    // 7.3 Target TAR.XZ / TXZ
    const tarResult = createTarArchive(files, options, `${baseName}.tar`);
    const xzBuffer = await compressXzAsync(tarResult.buffer, options);
    result = {
      buffer: xzBuffer,
      mimeType: 'application/x-xz-compressed-tar',
      filename: `${baseName}.${tgt}`,
      size: xzBuffer.length,
    };
  } else if (tgt === 'xz') {
    // 7.4 Target XZ
    const rawToCompress = files.length === 1 ? files[0].buffer : effectiveBuffer;
    const xzBuffer = await compressXzAsync(rawToCompress, options);
    result = {
      buffer: xzBuffer,
      mimeType: 'application/x-xz',
      filename: `${effectiveFilename}.${tgt}`,
      size: xzBuffer.length,
    };
  } else if (tgt === 'zip') {
    // 8. Target ZIP
    result = await createZipArchive(files, options, `${baseName}.zip`);
  } else {
    throw new ConversionFailedError(
      `Unsupported archive target format '${targetFormat}': foreign formats must not silently fall back to ZIP.`
    );
  }

  if (skippedLinks.length > 0) {
    result.skippedLinks = skippedLinks;
  }

  // 9. Split Archive Volume Generation (Multi-Volume)
  if (options.splitVolumeBytes && options.splitVolumeBytes > 0) {
    const parts = splitArchive(result.buffer, result.filename, options.splitVolumeBytes);
    return {
      ...result,
      parts,
    };
  }

  return result;
}

export async function convertToArchive(
  inputBuffer: Buffer,
  options: ConversionOptions = {},
  originalFilename: string
): Promise<ConversionResult> {
  const baseName = originalFilename.replace(/\.[^/.]+$/, '');
  return createZipArchive(
    [{ filename: originalFilename, buffer: inputBuffer }],
    options,
    `${baseName}.zip`
  );
}
