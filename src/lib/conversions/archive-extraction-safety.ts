import fs from 'node:fs';
import path from 'node:path';
import { ConversionFailedError } from '../types';
import {
  executeSandboxedBinary,
  SandboxedBufferLimitError,
  SandboxedProcessError,
} from '../security/process-sandbox';

/**
 * Contained extraction of untrusted archives through the 7-Zip CLI.
 *
 * 7-Zip recreates stored symbolic links on extraction (the `-snl` switch only affects archive
 * creation) and, depending on the build, either neutralizes or honours `..` and absolute entry
 * names. None of that is safe to depend on, so every extraction follows the same contract:
 *
 *  1. List the archive first (`7z l -slt -ba`) and reject traversal, absolute, link and special
 *     entries, plus anything over the entry-count, uncompressed-size or compression-ratio caps.
 *  2. Extract only archives that passed, with a per-file size rlimit as a second bound.
 *  3. Walk the output with `lstat`, `realpath`-check every entry against the extraction root,
 *     reject any link, and re-enforce the caps on what was actually written.
 */

export type UnsafeArchiveReason =
  | 'path-traversal'
  | 'absolute-path'
  | 'invalid-entry-name'
  | 'link-entry'
  | 'special-entry'
  | 'escaped-root'
  | 'entry-count'
  | 'uncompressed-size'
  | 'compression-ratio'
  | 'malformed-listing'
  | 'unsafe-filename';

/** An archive or filename that violates the extraction policy. Surfaces as HTTP 400 at the API. */
export class UnsafeArchiveError extends ConversionFailedError {
  readonly reason: UnsafeArchiveReason;

  constructor(reason: UnsafeArchiveReason, message: string) {
    super(message);
    this.name = 'UnsafeArchiveError';
    this.reason = reason;
  }
}

/** Structurally identical to ARCHIVE_SECURITY_LIMITS so callers pass that constant directly. */
export interface ArchiveExtractionLimits {
  MAX_FILES: number;
  MAX_UNCOMPRESSED_SIZE: number;
  MAX_RATIO: number;
}

export interface ListedArchiveEntry {
  path: string;
  isDirectory: boolean;
  /** Declared uncompressed size, or null when the listing carries none. */
  sizeBytes: number | null;
  linkKind: 'symlink' | 'hardlink' | null;
  /** A device, FIFO or socket entry. */
  isSpecial: boolean;
}

export interface ExtractedFile {
  /** Forward-slash path relative to the extraction root. */
  relPath: string;
  absPath: string;
  sizeBytes: number;
}

export interface ContainedTree {
  files: ExtractedFile[];
  /** Files plus directories found below the root. */
  entryCount: number;
  totalBytes: number;
}

const BYTES_PER_MB = 1024 * 1024;
/** A listing of MAX_FILES entries is well under 1 MiB; anything near this is an entry-count bomb. */
const LISTING_MAX_BUFFER_BYTES = 16 * BYTES_PER_MB;
const MAX_LEAF_FILENAME_BYTES = 255;
const UNIX_MODE_SHIFT = 16;

const LISTING_FIELD_PATTERN = /^(.+?) =(?: (.*))?$/;
const DECIMAL_PATTERN = /^\d+$/;
const UNIX_SYMLINK_MODE = /^l[-rwxsStT]{9}$/;
const UNIX_DIRECTORY_MODE = /^d[-rwxsStT]{9}$/;
const UNIX_SPECIAL_MODE = /^[cbps][-rwxsStT]{9}$/;
/** 7-Zip prints Windows attribute bits as these letters; `L` is FILE_ATTRIBUTE_REPARSE_POINT. */
const WINDOWS_ATTRIBUTE_LETTERS = /^[RHS8DAdNTsLCOIEV]+$/;
/** Unix mode in the high 16 bits, printed as hex when 7-Zip cannot render it as `rwx`. */
const HEX_ATTRIBUTE = /^[0-9A-F]{8}$/;
const DRIVE_LETTER_PREFIX = /^[A-Za-z]:/;
const PASSWORD_FAILURE_PATTERN = /Wrong password|Can not open encrypted|Data Error/i;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const SPECIAL_FILE_TYPES = new Set([0o020000, 0o060000, 0o010000, 0o140000]);

function describeLimitMb(limits: ArchiveExtractionLimits): string {
  return `${limits.MAX_UNCOMPRESSED_SIZE} bytes (${Math.round(limits.MAX_UNCOMPRESSED_SIZE / BYTES_PER_MB)}MB)`;
}

/** `count` is null when only the cap, not the exact count, is known (the listing overflowed its buffer). */
function entryCountError(count: number | null, limits: ArchiveExtractionLimits): UnsafeArchiveError {
  const observed = count === null ? '' : ` (${count})`;
  return new UnsafeArchiveError(
    'entry-count',
    `Archive bomb detected: file count${observed} exceeds limit of ${limits.MAX_FILES}`
  );
}

function sizeError(limits: ArchiveExtractionLimits): UnsafeArchiveError {
  return new UnsafeArchiveError(
    'uncompressed-size',
    `Archive bomb detected: uncompressed size exceeds limit of ${describeLimitMb(limits)}`
  );
}

function ratioError(totalBytes: number, archiveBytes: number, limits: ArchiveExtractionLimits): UnsafeArchiveError {
  return new UnsafeArchiveError(
    'compression-ratio',
    `Archive bomb detected: compression ratio (${(totalBytes / archiveBytes).toFixed(1)}:1) exceeds ${limits.MAX_RATIO}:1 limit`
  );
}

function assertWithinSizeAndRatio(totalBytes: number, archiveBytes: number, limits: ArchiveExtractionLimits): void {
  if (totalBytes > limits.MAX_UNCOMPRESSED_SIZE) {
    throw sizeError(limits);
  }
  if (archiveBytes > 0 && totalBytes / archiveBytes > limits.MAX_RATIO) {
    throw ratioError(totalBytes, archiveBytes, limits);
  }
}

interface AttributeClassification {
  isDirectory: boolean;
  isSymlink: boolean;
  isSpecial: boolean;
}

function classifyAttributeToken(token: string, into: AttributeClassification): void {
  if (UNIX_SYMLINK_MODE.test(token)) {
    into.isSymlink = true;
  } else if (UNIX_DIRECTORY_MODE.test(token)) {
    into.isDirectory = true;
  } else if (UNIX_SPECIAL_MODE.test(token)) {
    into.isSpecial = true;
  } else if (HEX_ATTRIBUTE.test(token)) {
    const fileType = (Number.parseInt(token, 16) >>> UNIX_MODE_SHIFT) & S_IFMT;
    if (fileType === S_IFLNK) {
      into.isSymlink = true;
    } else if (fileType === S_IFDIR) {
      into.isDirectory = true;
    } else if (SPECIAL_FILE_TYPES.has(fileType)) {
      into.isSpecial = true;
    }
  } else if (WINDOWS_ATTRIBUTE_LETTERS.test(token)) {
    if (token.includes('D')) into.isDirectory = true;
    if (token.includes('L')) into.isSymlink = true;
  }
}

function buildListedEntry(fields: Map<string, string>): ListedArchiveEntry {
  const entryPath = fields.get('Path');
  if (entryPath === undefined) {
    throw new UnsafeArchiveError('malformed-listing', 'Archive listing contains an entry without a path.');
  }
  const classification: AttributeClassification = {
    isDirectory: fields.get('Folder') === '+',
    isSymlink: false,
    isSpecial: false,
  };
  for (const key of ['Attributes', 'Mode']) {
    for (const token of (fields.get(key) ?? '').split(/\s+/)) {
      if (token) classifyAttributeToken(token, classification);
    }
  }

  const symbolicTarget = fields.get('Symbolic Link') ?? '';
  const hardTarget = fields.get('Hard Link') ?? '';
  let linkKind: ListedArchiveEntry['linkKind'] = null;
  if (classification.isSymlink || symbolicTarget !== '') {
    linkKind = 'symlink';
  } else if (hardTarget !== '') {
    linkKind = 'hardlink';
  }

  const rawSize = fields.get('Size') ?? '';
  return {
    path: entryPath,
    isDirectory: classification.isDirectory,
    sizeBytes: DECIMAL_PATTERN.test(rawSize) ? Number(rawSize) : null,
    linkKind,
    isSpecial: classification.isSpecial,
  };
}

/**
 * Parses `7z l -slt -ba` output. 7-Zip rewrites line breaks inside entry names, so a hostile name
 * cannot forge fields or entry boundaries. Anything that is not `Key = Value` fails closed.
 */
export function parse7zTechnicalListing(stdout: string): ListedArchiveEntry[] {
  const entries: ListedArchiveEntry[] = [];
  let fields = new Map<string, string>();
  const flush = (): void => {
    if (fields.size > 0) {
      entries.push(buildListedEntry(fields));
      fields = new Map<string, string>();
    }
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (line === '') {
      flush();
      continue;
    }
    const match = LISTING_FIELD_PATTERN.exec(line);
    if (!match) {
      throw new UnsafeArchiveError('malformed-listing', 'Archive listing contains an unrecognized line.');
    }
    fields.set(match[1], match[2] ?? '');
  }
  flush();
  return entries;
}

function assertSafeEntryPath(rawPath: string): void {
  if (rawPath === '' || rawPath.includes('\0')) {
    throw new UnsafeArchiveError('invalid-entry-name', 'Archive contains an entry with an empty or NUL-containing name.');
  }
  const normalized = rawPath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || DRIVE_LETTER_PREFIX.test(normalized)) {
    throw new UnsafeArchiveError('absolute-path', 'Archive contains an entry with an absolute path.');
  }
  if (normalized.split('/').includes('..')) {
    throw new UnsafeArchiveError('path-traversal', 'Archive contains an entry that escapes the extraction directory.');
  }
}

/**
 * Enforces the extraction policy on a listing before anything is written to disk.
 * Counts every listed entry (directories included) so empty-directory floods are bounded too.
 */
export function assertSafeArchiveListing(
  entries: ListedArchiveEntry[],
  archiveBytes: number,
  limits: ArchiveExtractionLimits
): { entryCount: number; totalBytes: number } {
  if (entries.length > limits.MAX_FILES) {
    throw entryCountError(entries.length, limits);
  }
  let totalBytes = 0;
  for (const entry of entries) {
    assertSafeEntryPath(entry.path);
    if (entry.linkKind !== null) {
      throw new UnsafeArchiveError('link-entry', 'Archive contains a symbolic or hard link entry, which is not extracted.');
    }
    if (entry.isSpecial) {
      throw new UnsafeArchiveError('special-entry', 'Archive contains a device, FIFO or socket entry.');
    }
    if (entry.isDirectory) continue;
    if (entry.sizeBytes === null || !Number.isSafeInteger(entry.sizeBytes)) {
      throw new UnsafeArchiveError('malformed-listing', 'Archive listing is missing a valid size for a file entry.');
    }
    totalBytes += entry.sizeBytes;
    if (totalBytes > limits.MAX_UNCOMPRESSED_SIZE) {
      throw sizeError(limits);
    }
  }
  assertWithinSizeAndRatio(totalBytes, archiveBytes, limits);
  return { entryCount: entries.length, totalBytes };
}

function isInside(realRoot: string, candidate: string): boolean {
  return candidate === realRoot || candidate.startsWith(realRoot + path.sep);
}

/**
 * Walks an extraction root with `lstat` (never following links), rejects any symlink, hard link or
 * special file, `realpath`-checks every entry against the root, and enforces the caps on what was
 * actually written (the listing is only what the archive claimed).
 */
export function assertExtractionContained(
  root: string,
  archiveBytes: number,
  limits: ArchiveExtractionLimits
): ContainedTree {
  const realRoot = fs.realpathSync(root);
  const files: ExtractedFile[] = [];
  let entryCount = 0;
  let totalBytes = 0;
  const pending: Array<{ abs: string; rel: string }> = [{ abs: root, rel: '' }];

  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const name of fs.readdirSync(next.abs)) {
      const abs = path.join(next.abs, name);
      const rel = next.rel === '' ? name : `${next.rel}/${name}`;
      const stat = fs.lstatSync(abs);

      if (stat.isSymbolicLink()) {
        throw new UnsafeArchiveError('link-entry', 'Extraction produced a symbolic link, which is not allowed.');
      }
      if (!isInside(realRoot, fs.realpathSync(abs))) {
        throw new UnsafeArchiveError('escaped-root', 'Extraction produced an entry outside the extraction directory.');
      }

      entryCount++;
      if (entryCount > limits.MAX_FILES) {
        throw entryCountError(entryCount, limits);
      }

      if (stat.isDirectory()) {
        pending.push({ abs, rel });
      } else if (stat.isFile()) {
        if (stat.nlink > 1) {
          throw new UnsafeArchiveError('link-entry', 'Extraction produced a hard link, which is not allowed.');
        }
        totalBytes += stat.size;
        if (totalBytes > limits.MAX_UNCOMPRESSED_SIZE) {
          throw sizeError(limits);
        }
        files.push({ relPath: rel, absPath: abs, sizeBytes: stat.size });
      } else {
        throw new UnsafeArchiveError('special-entry', 'Extraction produced a device, FIFO or socket entry.');
      }
    }
  }

  assertWithinSizeAndRatio(totalBytes, archiveBytes, limits);
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : 1));
  return { files, entryCount, totalBytes };
}

/**
 * Reduces a caller-supplied filename to a single safe path component: directories and drive
 * prefixes (either separator style) are dropped. Names that cannot name a file (NUL, empty, `.`,
 * `..`, or longer than a filesystem component) fail closed.
 */
export function sanitizeLeafFilename(name: string): string {
  if (name.includes('\0')) {
    throw new UnsafeArchiveError('unsafe-filename', 'Filename contains a NUL byte.');
  }
  const leaf = path.posix.basename(name.replace(/\\/g, '/'));
  if (leaf === '' || leaf === '.' || leaf === '..') {
    throw new UnsafeArchiveError('unsafe-filename', 'Filename does not name a file.');
  }
  if (Buffer.byteLength(leaf) > MAX_LEAF_FILENAME_BYTES) {
    throw new UnsafeArchiveError('unsafe-filename', 'Filename is too long.');
  }
  return leaf;
}

export interface ContainedExtractionRequest {
  p7zBin: string;
  archivePath: string;
  extractDir: string;
  /** Working directory for the 7z processes. */
  cwd: string;
  timeoutMs: number;
  /** Bound on 7z stdout/stderr for the extraction step (the listing has its own bound). */
  maxBuffer: number;
  limits: ArchiveExtractionLimits;
  /** Names the archive in error messages, e.g. `ZIP archive`. */
  label: string;
  password?: string;
  /** A 7z `-t<type>` switch for archives whose type cannot be detected from the file. */
  typeFlag?: string;
  /** Selective extraction patterns, passed to both the listing and the extraction as `-i!`. */
  includePatterns?: string[];
  signal?: AbortSignal;
}

function passwordArgs(request: ContainedExtractionRequest): { args: string[]; stdin: Buffer | undefined } {
  if (!request.password) {
    return { args: [], stdin: undefined };
  }
  return { args: ['-p'], stdin: Buffer.from(`${request.password}\n`) };
}

function includeArgs(request: ContainedExtractionRequest): string[] {
  return (request.includePatterns ?? []).map((pattern) => `-i!${pattern}`);
}

/**
 * Maps a failed 7z run to a typed error. Policy errors pass through; infrastructure failures
 * (timeouts, aborts, memory limits) keep their own types so callers can tell them apart.
 */
function toArchiveFailure(err: unknown, label: string, phase: 'list' | 'extract', limits: ArchiveExtractionLimits): unknown {
  if (err instanceof ConversionFailedError) {
    return err;
  }
  if (err instanceof SandboxedBufferLimitError) {
    return phase === 'list' ? entryCountError(null, limits) : sizeError(limits);
  }
  if (err instanceof SandboxedProcessError) {
    if (PASSWORD_FAILURE_PATTERN.test(`${err.message}\n${err.stderr}`)) {
      return new ConversionFailedError(`Invalid password for encrypted ${label}.`);
    }
    return new ConversionFailedError(
      `Could not read the archive: 7-Zip rejected the ${label} as malformed or unsupported (exit code ${err.exitCode ?? 'unknown'}).`
    );
  }
  return err;
}

async function listArchive(request: ContainedExtractionRequest): Promise<ListedArchiveEntry[]> {
  const { args: pwArgs, stdin } = passwordArgs(request);
  const result = await executeSandboxedBinary(
    request.p7zBin,
    [
      'l',
      '-slt',
      '-ba',
      ...(request.typeFlag ? [request.typeFlag] : []),
      ...pwArgs,
      ...includeArgs(request),
      request.archivePath,
    ],
    {
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
      maxBuffer: LISTING_MAX_BUFFER_BYTES,
      networkIsolated: true,
      stdin,
      signal: request.signal,
    }
  );
  return parse7zTechnicalListing(result.stdout.toString('utf-8'));
}

/**
 * Lists, vets, extracts and re-verifies an archive. Resolves with the contained output tree, or
 * rejects with a typed error; nothing is written before the listing has passed the policy.
 */
export async function extractArchiveContained(request: ContainedExtractionRequest): Promise<ContainedTree> {
  // stat, not lstat: the input archive is trusted storage, and its real size is the ratio's divisor.
  const archiveBytes = fs.statSync(request.archivePath).size;

  try {
    const listing = await listArchive(request);
    assertSafeArchiveListing(listing, archiveBytes, request.limits);
  } catch (err) {
    throw toArchiveFailure(err, request.label, 'list', request.limits);
  }

  try {
    const { args: pwArgs, stdin } = passwordArgs(request);
    await executeSandboxedBinary(
      request.p7zBin,
      [
        'x',
        '-y',
        ...(request.typeFlag ? [request.typeFlag] : []),
        ...pwArgs,
        `-o${request.extractDir}`,
        request.archivePath,
        ...includeArgs(request),
      ],
      {
        cwd: request.cwd,
        timeoutMs: request.timeoutMs,
        maxBuffer: request.maxBuffer,
        // Second bound for archives whose headers understate a file: no single file may pass the total cap.
        maxFileSize: request.limits.MAX_UNCOMPRESSED_SIZE,
        networkIsolated: true,
        stdin,
        signal: request.signal,
      }
    );
  } catch (err) {
    throw toArchiveFailure(err, request.label, 'extract', request.limits);
  }

  return assertExtractionContained(request.extractDir, archiveBytes, request.limits);
}
