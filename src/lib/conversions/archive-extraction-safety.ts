import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  ArchiveEntryCollisionError,
  ConversionFailedError,
  EngineUnavailableError,
  type ArchiveCollisionPolicy,
} from '../types';
import {
  executeSandboxedBinary,
  getSanitizedEnvironment,
  resolveSandboxedCommand,
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
 *     With `skipLinks`, link entries are instead excluded from extraction and reported; they are
 *     never skipped silently.
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
  /** Link entries left out of the extraction because the caller opted in with `skipLinks`. */
  skippedLinks: string[];
}

/** The archive is damaged or in a format 7-Zip cannot read (as opposed to a policy violation). */
export class UnreadableArchiveError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableArchiveError';
  }
}

/**
 * 7-Zip extraction cannot keep two entries that share a path, so the 'rename' policy (the default)
 * is not honourable natively. Callers with another engine (the in-process readers) fall back to it.
 */
export class NativeRenameUnsupportedError extends EngineUnavailableError {
  constructor(entryPath: string) {
    super('7z', `entry '${entryPath}' appears more than once and 7-Zip extraction cannot rename duplicate entries`);
    this.name = 'NativeRenameUnsupportedError';
  }
}

export interface ListingVerdict {
  entryCount: number;
  totalBytes: number;
  /** Paths of link entries that `skipLinks` allowed past the policy; empty otherwise. */
  skippedLinks: string[];
}

const BYTES_PER_MB = 1024 * 1024;
/** `7z l -slt` prints roughly 300 bytes of fields per entry; this budget leaves room for long names. */
const LISTING_BYTES_PER_ENTRY = 1024;
const LISTING_BUFFER_SLACK_BYTES = BYTES_PER_MB;
/** 7-Zip wildcard characters; a link name containing one cannot be excluded with an exact `-x!` pattern. */
const EXCLUDE_WILDCARD_PATTERN = /[*?]/;
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

/** Output bound for a listing that may hold at most `limits.MAX_FILES` entries. */
export function listingBufferLimit(limits: ArchiveExtractionLimits): number {
  return (limits.MAX_FILES + 1) * LISTING_BYTES_PER_ENTRY + LISTING_BUFFER_SLACK_BYTES;
}

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

export interface ListingPolicyOptions {
  /** Let link entries pass (reported in `skippedLinks`) instead of rejecting the archive. */
  skipLinks?: boolean;
}

/**
 * Enforces the extraction policy on a listing before anything is written to disk.
 * Counts every listed entry (directories included) so empty-directory floods are bounded too.
 * One pass over the entries, so the cost is linear in the entry count.
 */
export function assertSafeArchiveListing(
  entries: ListedArchiveEntry[],
  archiveBytes: number,
  limits: ArchiveExtractionLimits,
  policy: ListingPolicyOptions = {}
): ListingVerdict {
  if (entries.length > limits.MAX_FILES) {
    throw entryCountError(entries.length, limits);
  }
  let totalBytes = 0;
  const skippedLinks: string[] = [];
  for (const entry of entries) {
    assertSafeEntryPath(entry.path);
    if (entry.linkKind !== null) {
      if (!policy.skipLinks) {
        throw new UnsafeArchiveError('link-entry', 'Archive contains a symbolic or hard link entry, which is not extracted.');
      }
      if (EXCLUDE_WILDCARD_PATTERN.test(entry.path)) {
        throw new UnsafeArchiveError('link-entry', 'A link entry name contains a wildcard and cannot be skipped safely.');
      }
      skippedLinks.push(entry.path);
      continue;
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
  if (skippedLinks.length > 0) {
    // An exclusion pattern removes every entry with that path, so a regular entry sharing a link's path
    // would be dropped without being reported.
    const linkPaths = new Set(skippedLinks);
    const shared = entries.some((entry) => entry.linkKind === null && linkPaths.has(entry.path));
    if (shared) {
      throw new UnsafeArchiveError('link-entry', 'A link entry shares its path with another entry and cannot be skipped safely.');
    }
  }
  assertWithinSizeAndRatio(totalBytes, archiveBytes, limits);
  return { entryCount: entries.length, totalBytes, skippedLinks };
}

const PATH_SLASH_CHAR_CODE = 0x2f;

/** Strips trailing '/' characters in linear time. */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === PATH_SLASH_CHAR_CODE) end--;
  return value.slice(0, end);
}

/**
 * The first path two extracted entries would share, or null. A directory entry ('d/') and a file ('d')
 * name the same path; two directory entries for one path do not collide. One pass, linear in the entries.
 */
export function findEntryCollision(entries: ListedArchiveEntry[]): string | null {
  const seen = new Map<string, { count: number; hasNonDirectory: boolean }>();
  for (const entry of entries) {
    if (entry.linkKind !== null) continue;
    const normalized = trimTrailingSlashes(entry.path.replace(/\\/g, '/'));
    const state = seen.get(normalized);
    if (state) {
      state.count++;
      state.hasNonDirectory = state.hasNonDirectory || !entry.isDirectory;
    } else {
      seen.set(normalized, { count: 1, hasNonDirectory: !entry.isDirectory });
    }
  }
  for (const [normalized, state] of seen) {
    if (state.count > 1 && state.hasNonDirectory) return normalized;
  }
  return null;
}

/**
 * Applies the extraction collision policy to a vetted listing, before anything is written.
 * 'overwrite' keeps the last entry (what 7-Zip does); 'error' rejects; 'rename' hands the archive to an
 * engine that can rename.
 */
export function assertCollisionPolicy(entries: ListedArchiveEntry[], policy: ArchiveCollisionPolicy = 'rename'): void {
  if (policy === 'overwrite') return;
  const collision = findEntryCollision(entries);
  if (collision === null) return;
  if (policy === 'error') {
    throw new ArchiveEntryCollisionError(
      collision,
      `Archive entry collision detected for '${collision}' under collision policy 'error'.`
    );
  }
  throw new NativeRenameUnsupportedError(collision);
}

/**
 * After excluding link entries, the listing must lose exactly those entries and nothing else:
 * proof that the exclusion patterns did not silently drop regular files.
 */
export function assertExclusionExact(full: ListedArchiveEntry[], filtered: ListedArchiveEntry[]): void {
  const balance = new Map<string, number>();
  for (const entry of full) {
    if (entry.linkKind === null) {
      balance.set(entry.path, (balance.get(entry.path) ?? 0) + 1);
    }
  }
  for (const entry of filtered) {
    balance.set(entry.path, (balance.get(entry.path) ?? 0) - 1);
  }
  for (const remaining of balance.values()) {
    if (remaining !== 0) {
      throw new UnsafeArchiveError(
        'link-entry',
        'Skipping link entries would also drop regular entries, so the archive was rejected.'
      );
    }
  }
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
  return { files, entryCount, totalBytes, skippedLinks: [] };
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
  /**
   * Divisor for the compression-ratio cap when the archive is a layer inside a larger input, such as
   * the tar inside a .tar.gz: the ratio is then measured against the original upload.
   */
  ratioBaseBytes?: number;
  /** Opt in to leaving link entries out of the extraction (reported in `skippedLinks`) instead of rejecting. */
  skipLinks?: boolean;
  /** What to do when two entries share a path. Defaults to 'rename', which native extraction hands to another engine. */
  collisionPolicy?: ArchiveCollisionPolicy;
  /**
   * The archive is a compression wrapper (gz, bz2, xz, ...). When it unpacks to a single `.tar`, that
   * tar is listed and vetted too, because the caller repackages it without extracting it.
   */
  validateNestedTar?: boolean;
  signal?: AbortSignal;
}

const PASSWORD_FORBIDDEN_CHARACTERS = /[\r\n\0]/;

/** The password travels on 7z's stdin, so a line break or NUL could answer further prompts. */
export function assertArchivePasswordSafe(password: string | undefined): void {
  if (password && PASSWORD_FORBIDDEN_CHARACTERS.test(password)) {
    throw new ConversionFailedError('Archive password contains invalid newline or null characters.');
  }
}

function passwordArgs(request: ContainedExtractionRequest): { args: string[]; stdin: Buffer | undefined } {
  assertArchivePasswordSafe(request.password);
  if (!request.password) {
    return { args: [], stdin: undefined };
  }
  return { args: ['-p'], stdin: Buffer.from(`${request.password}\n`) };
}

function includeArgs(request: ContainedExtractionRequest): string[] {
  return (request.includePatterns ?? []).map((pattern) => `-i!${pattern}`);
}

function typeArgs(request: ContainedExtractionRequest): string[] {
  return request.typeFlag ? [request.typeFlag] : [];
}

interface RunFailure {
  kind: 'buffer' | 'process';
  exitCode: number | null;
  text: string;
}

interface SpawnSyncFailure extends Error {
  code?: string;
  status?: number | null;
  signal?: string | null;
  stderr?: Buffer | string;
  stdout?: Buffer | string;
}

/** Normalizes the failure shapes of the async sandbox executor and of execFileSync. */
function classifyRunFailure(err: unknown): RunFailure | null {
  if (err instanceof SandboxedBufferLimitError) {
    return { kind: 'buffer', exitCode: null, text: '' };
  }
  if (err instanceof SandboxedProcessError) {
    return { kind: 'process', exitCode: err.exitCode, text: `${err.message}\n${err.stderr}` };
  }
  if (err instanceof Error) {
    const failure = err as SpawnSyncFailure;
    if (failure.code === 'ENOBUFS' || failure.signal === 'SIGXFSZ') {
      return { kind: 'buffer', exitCode: null, text: '' };
    }
    if (typeof failure.status === 'number') {
      return {
        kind: 'process',
        exitCode: failure.status,
        text: `${failure.message}\n${failure.stderr?.toString() ?? ''}\n${failure.stdout?.toString() ?? ''}`,
      };
    }
  }
  return null;
}

/**
 * Maps a failed 7z run to a typed error. Policy errors pass through; infrastructure failures
 * (timeouts, aborts, memory limits) keep their own types so callers can tell them apart.
 */
function toArchiveFailure(err: unknown, label: string, phase: 'list' | 'extract', limits: ArchiveExtractionLimits): unknown {
  // The collision error carries a numeric `status` like a child-process failure, so match it explicitly.
  if (err instanceof ConversionFailedError || err instanceof ArchiveEntryCollisionError) {
    return err;
  }
  const failure = classifyRunFailure(err);
  if (failure === null) {
    return err;
  }
  if (failure.kind === 'buffer') {
    return phase === 'list' ? entryCountError(null, limits) : sizeError(limits);
  }
  if (PASSWORD_FAILURE_PATTERN.test(failure.text)) {
    return new ConversionFailedError(`Invalid password for encrypted ${label}.`);
  }
  return new UnreadableArchiveError(
    `Could not read the archive: 7-Zip rejected the ${label} as malformed or unsupported (exit code ${failure.exitCode ?? 'unknown'}).`
  );
}

interface ListTarget {
  archivePath: string;
  typeFlag?: string;
  includePatterns?: string[];
  password?: string;
}

function listArgs(request: ContainedExtractionRequest, target: ListTarget, exclude: string[]): { args: string[]; stdin: Buffer | undefined } {
  const pw = passwordArgs({ ...request, password: target.password });
  const include = (target.includePatterns ?? []).map((pattern) => `-i!${pattern}`);
  return {
    args: ['l', '-slt', '-ba', ...(target.typeFlag ? [target.typeFlag] : []), ...pw.args, ...include, ...exclude, target.archivePath],
    stdin: pw.stdin,
  };
}

function extractArgs(request: ContainedExtractionRequest, exclude: string[]): { args: string[]; stdin: Buffer | undefined } {
  const pw = passwordArgs(request);
  return {
    args: [
      'x',
      '-y',
      ...typeArgs(request),
      ...pw.args,
      `-o${request.extractDir}`,
      request.archivePath,
      ...includeArgs(request),
      ...exclude,
    ],
    stdin: pw.stdin,
  };
}

function requestTarget(request: ContainedExtractionRequest): ListTarget {
  return {
    archivePath: request.archivePath,
    typeFlag: request.typeFlag,
    includePatterns: request.includePatterns,
    password: request.password,
  };
}

async function listArchive(request: ContainedExtractionRequest, target: ListTarget, exclude: string[]): Promise<ListedArchiveEntry[]> {
  const { args, stdin } = listArgs(request, target, exclude);
  const result = await executeSandboxedBinary(request.p7zBin, args, {
    cwd: request.cwd,
    timeoutMs: request.timeoutMs,
    maxBuffer: listingBufferLimit(request.limits),
    networkIsolated: true,
    stdin,
    signal: request.signal,
  });
  return parse7zTechnicalListing(result.stdout.toString('utf-8'));
}

function listArchiveSync(request: ContainedExtractionRequest, target: ListTarget, exclude: string[]): ListedArchiveEntry[] {
  const { args, stdin } = listArgs(request, target, exclude);
  const resolved = resolveSandboxedCommand(request.p7zBin, args, { networkIsolated: true });
  const stdout = execFileSync(resolved.binary, resolved.args, {
    cwd: request.cwd,
    env: getSanitizedEnvironment({}, true),
    timeout: request.timeoutMs,
    maxBuffer: listingBufferLimit(request.limits),
    input: stdin,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return parse7zTechnicalListing(stdout.toString('utf-8'));
}

function excludeArgsFor(skippedLinks: string[]): string[] {
  return skippedLinks.map((linkPath) => `-x!${linkPath}`);
}

/** Vets a listing and, when links are being skipped, returns the exclusion patterns plus the verdict. */
function vetListing(
  request: ContainedExtractionRequest,
  listing: ListedArchiveEntry[],
  ratioBytes: number
): ListingVerdict {
  return assertSafeArchiveListing(listing, ratioBytes, request.limits, { skipLinks: request.skipLinks });
}

function withSkippedLinks(tree: ContainedTree, skippedLinks: string[]): ContainedTree {
  return { ...tree, skippedLinks };
}

const TAR_MAGIC_OFFSET = 257;
const TAR_MAGIC = 'ustar';
const TAR_HEADER_BYTES = 512;

/** POSIX and GNU tars carry `ustar` in their first header; compression wrappers do not rename the inner file reliably. */
export function hasTarMagic(filePath: string): boolean {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(TAR_HEADER_BYTES);
    const read = fs.readSync(fd, header, 0, TAR_HEADER_BYTES, 0);
    return read === TAR_HEADER_BYTES && header.toString('latin1', TAR_MAGIC_OFFSET, TAR_MAGIC_OFFSET + TAR_MAGIC.length) === TAR_MAGIC;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * A compression wrapper that unpacks to one file may hold a tar the caller repackages unopened. List it so
 * links and traversal names inside it are seen. A payload that is not a tar is left alone; a tar that
 * cannot be read fails closed.
 */
async function vetNestedTar(request: ContainedExtractionRequest, tree: ContainedTree, ratioBytes: number): Promise<void> {
  if (tree.files.length !== 1) return;
  const candidate = tree.files[0];
  const isTar = hasTarMagic(candidate.absPath);
  try {
    const inner = await listArchive(request, { archivePath: candidate.absPath, typeFlag: '-ttar' }, []);
    // The inner tar is repackaged as a whole, so its links cannot be skipped selectively.
    assertSafeArchiveListing(inner, ratioBytes, request.limits);
  } catch (err) {
    const failure = toArchiveFailure(err, request.label, 'list', request.limits);
    if (failure instanceof UnreadableArchiveError && !isTar) return;
    throw failure;
  }
}

/**
 * Lists, vets, extracts and re-verifies an archive. Resolves with the contained output tree, or
 * rejects with a typed error; nothing is written before the listing has passed the policy.
 */
export async function extractArchiveContained(request: ContainedExtractionRequest): Promise<ContainedTree> {
  // stat, not lstat: the input archive is trusted storage, and its real size is the ratio's divisor.
  const archiveBytes = fs.statSync(request.archivePath).size;
  const ratioBytes = request.ratioBaseBytes ?? archiveBytes;
  let skippedLinks: string[] = [];
  let exclude: string[] = [];

  try {
    const listing = await listArchive(request, requestTarget(request), []);
    skippedLinks = vetListing(request, listing, ratioBytes).skippedLinks;
    if (skippedLinks.length > 0) {
      exclude = excludeArgsFor(skippedLinks);
      assertExclusionExact(listing, await listArchive(request, requestTarget(request), exclude));
    }
    assertCollisionPolicy(listing, request.collisionPolicy);
  } catch (err) {
    throw toArchiveFailure(err, request.label, 'list', request.limits);
  }

  try {
    const { args, stdin } = extractArgs(request, exclude);
    await executeSandboxedBinary(request.p7zBin, args, {
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
      maxBuffer: request.maxBuffer,
      // Second bound for archives whose headers understate a file: no single file may pass the total cap.
      maxFileSize: request.limits.MAX_UNCOMPRESSED_SIZE,
      networkIsolated: true,
      stdin,
      signal: request.signal,
    });
  } catch (err) {
    throw toArchiveFailure(err, request.label, 'extract', request.limits);
  }

  const tree = withSkippedLinks(assertExtractionContained(request.extractDir, ratioBytes, request.limits), skippedLinks);

  if (request.validateNestedTar) {
    await vetNestedTar(request, tree, ratioBytes);
  }
  return tree;
}

/** Synchronous twin of {@link extractArchiveContained} for the library's synchronous conversion path. */
export function extractArchiveContainedSync(request: ContainedExtractionRequest): ContainedTree {
  const archiveBytes = fs.statSync(request.archivePath).size;
  const ratioBytes = request.ratioBaseBytes ?? archiveBytes;
  let skippedLinks: string[] = [];
  let exclude: string[] = [];

  try {
    const listing = listArchiveSync(request, requestTarget(request), []);
    skippedLinks = vetListing(request, listing, ratioBytes).skippedLinks;
    if (skippedLinks.length > 0) {
      exclude = excludeArgsFor(skippedLinks);
      assertExclusionExact(listing, listArchiveSync(request, requestTarget(request), exclude));
    }
    assertCollisionPolicy(listing, request.collisionPolicy);
  } catch (err) {
    throw toArchiveFailure(err, request.label, 'list', request.limits);
  }

  try {
    const { args, stdin } = extractArgs(request, exclude);
    const resolved = resolveSandboxedCommand(request.p7zBin, args, {
      networkIsolated: true,
      maxFileSize: request.limits.MAX_UNCOMPRESSED_SIZE,
    });
    execFileSync(resolved.binary, resolved.args, {
      cwd: request.cwd,
      env: getSanitizedEnvironment({}, true),
      timeout: request.timeoutMs,
      maxBuffer: request.maxBuffer,
      input: stdin,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw toArchiveFailure(err, request.label, 'extract', request.limits);
  }

  return withSkippedLinks(assertExtractionContained(request.extractDir, ratioBytes, request.limits), skippedLinks);
}
