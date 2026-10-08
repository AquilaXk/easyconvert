import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  ArchiveEntryCollisionError,
  ArchivePasswordRequiredError,
  ConversionFailedError,
  EngineUnavailableError,
  InvalidArchivePasswordError,
  type ArchiveCollisionPolicy,
} from '../types';
import {
  executeSandboxedBinary,
  getSanitizedEnvironment,
  resolveSandboxedCommand,
  SandboxedBufferLimitError,
  SandboxedProcessError,
} from '../security/process-sandbox';
import {
  archiveFailureStderr,
  assertArchivePasswordSafe,
  execFileSyncWithPasswordStdin,
  isArchivePasswordFailure,
  sevenZipReadPasswordInput,
} from './archive-password';

export { assertArchivePasswordSafe };

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
  | 'unsafe-filename'
  | 'path-depth'
  | 'invalid-entry-filter';

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
  /** The single stream of a wrapper format (gz, bz2, xz, ...), whose size 7-Zip may not state. */
  wrapperPayload?: boolean;
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

/** `[^\n]` rather than `.`: CR, U+2028 and U+2029 are legal in names and `.` would not match them. */
const LISTING_FIELD_PATTERN = /^([^\n]+?) =(?: ([^\n]*))?$/;
const DECIMAL_PATTERN = /^\d+$/;
const UNIX_SYMLINK_MODE = /^l[-rwxsStT]{9}$/;
const UNIX_DIRECTORY_MODE = /^d[-rwxsStT]{9}$/;
const UNIX_SPECIAL_MODE = /^[cbps][-rwxsStT]{9}$/;
/** 7-Zip prints Windows attribute bits as these letters; `L` is FILE_ATTRIBUTE_REPARSE_POINT. */
const WINDOWS_ATTRIBUTE_LETTERS = /^[RHS8DAdNTsLCOIEV]+$/;
/** Unix mode in the high 16 bits, printed as hex when 7-Zip cannot render it as `rwx`. */
const HEX_ATTRIBUTE = /^[0-9A-F]{8}$/;
const DRIVE_LETTER_PREFIX = /^[A-Za-z]:/;
/** With no password supplied, 7-Zip prompts for one and aborts when stdin is closed ("Break signaled", exit 255). */
const PASSWORD_PROMPT_ABORT_PATTERN = /^(?:Break signaled|Enter password.*)$/m;
/**
 * The prompt 7-Zip prints on stdout before reading a password from stdin; it is not part of a listing.
 * p7zip and 7-Zip up to 23.01 print "Enter password (will not be echoed):", 7-Zip 26.01 "Enter password:".
 */
const SEVEN_ZIP_PASSWORD_PROMPT = /^Enter password(?: \(will not be echoed\))?:/gm;

/** Removes 7-Zip's password prompt from a listing, which it prints whenever it reads the answer from stdin. */
export function stripSevenZipPasswordPrompt(stdout: string): string {
  return stdout.replace(SEVEN_ZIP_PASSWORD_PROMPT, '');
}

/**
 * Every `-slt` key 7-Zip 16.02, 21.07, 22.01 and 23.01 print for the archives in the test corpus and for the
 * real source containers in tests/fixtures/archive-sources (ISO, UDF, CAB, ARJ, LZH, RPM, DEB, CPIO, WIM, DMG,
 * HFS+, ext4, FAT, VHD, CHM, SquashFS, MSI, NSIS, Z, LZMA; 'Metadata Changed' comes from UDF and HFS+, 'Copy Link' from RAR5), plus
 * the remaining per-item property names 7-Zip defines. A key outside this set can only come from a forged value
 * (p7zip 16.02 prints raw line breaks), so the listing is rejected.
 */
const KNOWN_LISTING_KEYS = new Set([
  'Path', 'Name', 'Extension', 'Folder', 'Size', 'Packed Size', 'Modified', 'Created', 'Accessed', 'Attributes',
  'Encrypted', 'Comment', 'CRC', 'Method', 'Block', 'Solid', 'Anti', 'Characteristics', 'Host OS', 'Version',
  'Volume Index', 'Offset', 'Position', 'Split Before', 'Split After', 'Dictionary Size', 'File System',
  'Link', 'Hard Link', 'Symbolic Link', 'Copy Link', 'Links', 'iNode', 'Mode', 'User', 'Group', 'User ID', 'Group ID',
  'Device Major', 'Device Minor', 'Dev Major', 'Dev Minor', 'Short Name', 'Alternate Stream', 'Alternate Streams',
  'NT Security', 'Stream ID', 'Checksum', 'SHA-1', 'SHA-256', 'BLAKE2sp', 'MD5', 'XXH64', 'Commented', 'Deleted',
  'Path Prefix', 'Local Name', 'Provider', 'Aux', 'Tree', 'Type', 'Metadata Changed',
]);

/** Deepest entry path (in segments) an archive may contain or an extraction may produce. */
export const MAX_ENTRY_PATH_DEPTH = 256;
const MAX_ENTRY_FILTER_PATTERNS = 1_000;
const MAX_ENTRY_FILTER_TOTAL_BYTES = 64 * 1024;
const ENTRY_FILTER_FORBIDDEN_CHARACTERS = /[\0\r\n]/;
/** NUL, and CR/LF: line breaks in names are how listing fields get forged, and newer builds rewrite them anyway. */
const ENTRY_NAME_FORBIDDEN_CHARACTERS = /[\0\r\n]/;
/** Single-stream wrapper extensions and the suffix 7-Zip's output name gets ("tgz" unpacks to "<name>.tar"). */
const WRAPPER_EXTENSION_SUFFIXES = new Map<string, string>([
  ['gz', ''],
  ['bz2', ''],
  ['xz', ''],
  ['lzma', ''],
  ['zst', ''],
  ['z', ''],
  ['tgz', '.tar'],
  ['tbz2', '.tar'],
  ['tbz', '.tar'],
  ['txz', '.tar'],
]);

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

function buildListedEntry(fields: Map<string, string>, payloadName?: string): ListedArchiveEntry {
  const entryPath = fields.get('Path') ?? payloadName;
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
    ...(fields.has('Path') ? {} : { wrapperPayload: true }),
  };
}

export interface ListingParseOptions {
  /**
   * Single-stream wrapper formats (gz, bz2, xz, ...) list their one payload without a `Path`. When the
   * listing is exactly one such block, it is that payload and takes this name. Otherwise a block
   * without a path is malformed.
   */
  payloadName?: string;
}

/**
 * Parses `7z l -slt -ba` output. Anything that is not `Key = Value` fails closed, and so does a block
 * that repeats a key. Some 7-Zip builds (p7zip 16.02) print raw line breaks from names, comments and
 * link targets, so a hostile value can carry fake `Key = Value` lines; the repeated key it forges (the
 * real field is always printed too) is what exposes it. Newer builds rewrite the line breaks.
 */
export function parse7zTechnicalListing(stdout: string, options: ListingParseOptions = {}): ListedArchiveEntry[] {
  const blocks: Array<Map<string, string>> = [];
  let fields = new Map<string, string>();
  const flush = (): void => {
    if (fields.size > 0) {
      blocks.push(fields);
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
    if (!KNOWN_LISTING_KEYS.has(match[1])) {
      throw new UnsafeArchiveError('malformed-listing', 'Archive listing contains an unknown field.');
    }
    if (fields.has(match[1])) {
      throw new UnsafeArchiveError('malformed-listing', 'Archive listing repeats a field within one entry.');
    }
    fields.set(match[1], match[2] ?? '');
  }
  flush();

  const isWrapperPayload = options.payloadName !== undefined && blocks.length === 1 && !blocks[0].has('Path');
  return blocks.map((block) => buildListedEntry(block, isWrapperPayload ? options.payloadName : undefined));
}

/** Why an entry name cannot be extracted under the root, or null when it is a plain relative path. */
function entryPathProblem(rawPath: string): 'path-traversal' | 'absolute-path' | 'invalid-entry-name' | null {
  if (rawPath === '' || ENTRY_NAME_FORBIDDEN_CHARACTERS.test(rawPath)) {
    return 'invalid-entry-name';
  }
  const normalized = rawPath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || DRIVE_LETTER_PREFIX.test(normalized)) {
    return 'absolute-path';
  }
  if (normalized.split('/').includes('..')) {
    return 'path-traversal';
  }
  return null;
}

const PATH_SEPARATOR_PATTERN = /[\\/]/;

/** Number of path components, ignoring empty and `.` segments. */
function entryPathDepth(rawPath: string): number {
  let depth = 0;
  for (const segment of rawPath.split(PATH_SEPARATOR_PATTERN)) {
    if (segment !== '' && segment !== '.') depth++;
  }
  return depth;
}

/**
 * Records the path an entry occupies and every ancestor directory it implies. Each recorded path already
 * has all its ancestors recorded, so climbing stops at the first one present: linear overall.
 */
function occupyPath(occupied: Set<string>, rawPath: string): void {
  const key = normalizeEntryKey(rawPath);
  if (key === '') return;
  occupied.add(key);
  for (let slash = key.lastIndexOf('/'); slash > 0; slash = key.lastIndexOf('/', slash - 1)) {
    const parent = key.slice(0, slash);
    if (occupied.has(parent)) break;
    occupied.add(parent);
  }
}

function assertSafeEntryPath(rawPath: string): void {
  const problem = entryPathProblem(rawPath);
  if (problem === 'invalid-entry-name') {
    throw new UnsafeArchiveError('invalid-entry-name', 'Archive contains an entry with an empty name or one holding NUL or a line break.');
  }
  if (problem === 'absolute-path') {
    throw new UnsafeArchiveError('absolute-path', 'Archive contains an entry with an absolute path.');
  }
  if (problem === 'path-traversal') {
    throw new UnsafeArchiveError('path-traversal', 'Archive contains an entry that escapes the extraction directory.');
  }
  if (entryPathDepth(rawPath) > MAX_ENTRY_PATH_DEPTH) {
    throw new UnsafeArchiveError('path-depth', `Archive contains an entry nested deeper than ${MAX_ENTRY_PATH_DEPTH} levels.`);
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
  // Unique paths the extraction will create: listed entries plus the directories they imply. An entry
  // such as `N/d/d/.../f` is one listing line but creates a directory per level.
  const occupied = new Set<string>();
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
    occupyPath(occupied, entry.path);
    if (occupied.size > limits.MAX_FILES) {
      throw entryCountError(occupied.size, limits);
    }
    if (entry.sizeBytes === null) {
      // A wrapper's stream size may be unstated; RLIMIT_FSIZE and the post-extraction walk bound it.
      if (entry.isDirectory || entry.wrapperPayload) continue;
      throw new UnsafeArchiveError('malformed-listing', 'Archive listing is missing a valid size for a file entry.');
    }
    if (!Number.isSafeInteger(entry.sizeBytes)) {
      throw new UnsafeArchiveError('malformed-listing', 'Archive listing is missing a valid size for a file entry.');
    }
    // Every non-link entry counts, directories included: a patched header can make a "directory" carry data.
    totalBytes += entry.sizeBytes;
    if (totalBytes > limits.MAX_UNCOMPRESSED_SIZE) {
      throw sizeError(limits);
    }
    if (entry.isDirectory && entry.sizeBytes > 0) {
      throw new UnsafeArchiveError('malformed-listing', 'Archive directory entry declares file data.');
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

/**
 * The path an entry occupies once extracted: separators unified, and empty and `.` segments dropped,
 * so `a`, `./a`, `a/` and `d//b` / `d/./b` compare equal. Linear in the name length.
 */
function normalizeEntryKey(name: string): string {
  const kept: string[] = [];
  for (const segment of name.split(PATH_SEPARATOR_PATTERN)) {
    if (segment !== '' && segment !== '.') kept.push(segment);
  }
  return kept.join('/');
}

/**
 * The first path two extracted entries would share, or null. A directory entry ('d/') and a file ('d')
 * name the same path; two directory entries for one path do not collide. One pass, linear in the entries.
 */
export function findEntryCollision(entries: ListedArchiveEntry[]): string | null {
  const seen = new Map<string, { count: number; hasNonDirectory: boolean }>();
  for (const entry of entries) {
    if (entry.linkKind !== null) continue;
    const normalized = normalizeEntryKey(entry.path);
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
 * special file, and enforces the caps and the depth limit on what was actually written (the listing
 * is only what the archive claimed). The root is resolved once; every entry is reached by joining
 * names onto it, and since `lstat` shows no link below it, nothing can lead outside. A per-entry
 * `realpath` would re-resolve the whole path each time and make the walk cubic in the nesting depth.
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
  const pending: Array<{ abs: string; rel: string; depth: number }> = [{ abs: realRoot, rel: '', depth: 0 }];

  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const depth = next.depth + 1;
    if (depth > MAX_ENTRY_PATH_DEPTH) {
      throw new UnsafeArchiveError('path-depth', `Extraction produced a path nested deeper than ${MAX_ENTRY_PATH_DEPTH} levels.`);
    }
    for (const name of fs.readdirSync(next.abs)) {
      const abs = path.join(next.abs, name);
      const rel = next.rel === '' ? name : `${next.rel}/${name}`;
      const stat = fs.lstatSync(abs);

      if (stat.isSymbolicLink()) {
        throw new UnsafeArchiveError('link-entry', 'Extraction produced a symbolic link, which is not allowed.');
      }
      if (!isInside(realRoot, abs)) {
        throw new UnsafeArchiveError('escaped-root', 'Extraction produced an entry outside the extraction directory.');
      }

      entryCount++;
      if (entryCount > limits.MAX_FILES) {
        throw entryCountError(entryCount, limits);
      }

      if (stat.isDirectory()) {
        pending.push({ abs, rel, depth });
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
  files.sort((x, y) => (x.relPath < y.relPath ? -1 : 1));
  return { files, entryCount, totalBytes, skippedLinks: [] };
}

/**
 * Deletes a directory tree without recursion: `fs.rmSync` recurses once per level and overflows the
 * stack on trees nested a few thousand levels deep. Links are removed, never followed. Throws when
 * something cannot be removed.
 */
export function removeDirectoryTree(root: string): void {
  if (fs.lstatSync(root).isSymbolicLink()) {
    throw new UnsafeArchiveError('link-entry', 'Refusing to remove a directory tree through a symbolic link.');
  }
  const directories: string[] = [];
  const pending = [root];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    directories.push(next);
    for (const entry of fs.readdirSync(next, { withFileTypes: true })) {
      const abs = path.join(next, entry.name);
      if (entry.isDirectory()) {
        pending.push(abs);
      } else {
        fs.unlinkSync(abs);
      }
    }
  }
  for (let i = directories.length - 1; i >= 0; i--) {
    fs.rmdirSync(directories[i]);
  }
}

/** Best-effort cleanup for `finally` blocks: never masks the real error, but a failure is logged, not swallowed. */
export function cleanupDirectoryTree(root: string): void {
  if (!fs.existsSync(root)) return;
  try {
    removeDirectoryTree(root);
  } catch (err) {
    console.error(`[archive] failed to remove temporary directory ${root}:`, err);
  }
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

/** The password travels on 7z's stdin (never argv); `assertArchivePasswordSafe` refuses anything that could answer a further prompt. */
function passwordArgs(request: ContainedExtractionRequest): { args: string[]; stdin: Buffer | undefined } {
  assertArchivePasswordSafe(request.password);
  if (!request.password) {
    return { args: [], stdin: undefined };
  }
  // No switch on reads: 7-Zip prompts on its own when an entry or header is encrypted and reads the answer here.
  return { args: [], stdin: sevenZipReadPasswordInput(request.password) };
}

/**
 * Selective-extraction patterns travel as command-line arguments, so they are bounded in count and total
 * size (the OS caps the argument block) and must not carry NUL or line breaks.
 */
export function assertEntryFilterSafe(patterns: string[] | undefined): void {
  if (patterns === undefined) return;
  if (patterns.length > MAX_ENTRY_FILTER_PATTERNS) {
    throw new UnsafeArchiveError('invalid-entry-filter', `At most ${MAX_ENTRY_FILTER_PATTERNS} entry patterns are accepted.`);
  }
  let totalBytes = 0;
  for (const pattern of patterns) {
    if (pattern === '' || ENTRY_FILTER_FORBIDDEN_CHARACTERS.test(pattern)) {
      throw new UnsafeArchiveError('invalid-entry-filter', 'Entry patterns must be non-empty and free of NUL and line breaks.');
    }
    totalBytes += Buffer.byteLength(pattern);
    if (totalBytes > MAX_ENTRY_FILTER_TOTAL_BYTES) {
      throw new UnsafeArchiveError('invalid-entry-filter', 'The entry patterns are too long.');
    }
  }
}

function includeArgs(request: ContainedExtractionRequest): string[] {
  return (request.includePatterns ?? []).map((pattern) => `-i!${pattern}`);
}

/** The name 7-Zip gives the payload of a single-stream wrapper (`input.bz2` unpacks to `input`), if the file is one. */
function wrapperPayloadName(archivePath: string): string | undefined {
  const base = path.basename(archivePath);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const suffix = WRAPPER_EXTENSION_SUFFIXES.get(base.slice(dot + 1).toLowerCase());
  return suffix === undefined ? undefined : `${base.slice(0, dot)}${suffix}`;
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
function toArchiveFailure(
  err: unknown,
  label: string,
  phase: 'list' | 'extract',
  limits: ArchiveExtractionLimits,
  hasPassword: boolean
): unknown {
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
  // Only the tool's own stderr lines decide: an entry name or the command line may contain the same words.
  const stderr = archiveFailureStderr(err);
  const passwordFailure = isArchivePasswordFailure(stderr) || (!hasPassword && PASSWORD_PROMPT_ABORT_PATTERN.test(stderr));
  if (passwordFailure) {
    return hasPassword
      ? new InvalidArchivePasswordError(`Invalid password for encrypted ${label}.`)
      : new ArchivePasswordRequiredError(`The ${label} is password protected. A password is required to extract.`);
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
  return parse7zTechnicalListing(stripSevenZipPasswordPrompt(result.stdout.toString('utf-8')), { payloadName: wrapperPayloadName(target.archivePath) });
}

/**
 * Runs a synchronous 7-Zip step. With a password answer, the run goes through `execFileSyncWithPasswordStdin`:
 * detached (setsid), so p7zip's prompt reads the pipe rather than a controlling terminal, and tolerant of the
 * EPIPE Node reports when 7-Zip exits successfully without reading stdin (nothing encrypted at that step).
 */
function runSevenZipSync(
  binary: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; input: Buffer | undefined }
): Buffer {
  const { input, ...rest } = options;
  if (input) return execFileSyncWithPasswordStdin(binary, args, { ...rest, input });
  return execFileSync(binary, args, { ...rest, stdio: ['pipe', 'pipe', 'pipe'] });
}

function listArchiveSync(request: ContainedExtractionRequest, target: ListTarget, exclude: string[]): ListedArchiveEntry[] {
  const { args, stdin } = listArgs(request, target, exclude);
  const resolved = resolveSandboxedCommand(request.p7zBin, args, { networkIsolated: true });
  const stdout = runSevenZipSync(resolved.binary, resolved.args, {
    cwd: request.cwd,
    env: getSanitizedEnvironment({}, true),
    timeout: request.timeoutMs,
    maxBuffer: listingBufferLimit(request.limits),
    input: stdin,
  });
  return parse7zTechnicalListing(stripSevenZipPasswordPrompt(stdout.toString('utf-8')), { payloadName: wrapperPayloadName(target.archivePath) });
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

const TAR_CHECKSUM_OFFSET = 148;
const TAR_CHECKSUM_BYTES = 8;
const TAR_OCTAL_RADIX = 8;
const SPACE = 0x20;
const NUL = 0;
const ASCII_ZERO = 0x30;
const ASCII_SEVEN = 0x37;
const SIGN_BIT = 0x80;
const BYTE_RANGE = 0x100;

/**
 * Whether the first 512-byte block of `filePath` is a tar header: the checksum field holds an octal number equal to
 * the sum of the block's bytes with that field read as spaces (the POSIX rule, summed as unsigned or as signed bytes).
 * This is the test 7-Zip applies before it opens a file as a tar, so a file that fails it cannot be listed as one, and
 * a v7 tar without the `ustar` magic passes it. An empty file, a short file or a missing file is not a tar header.
 */
export function hasTarHeaderChecksum(filePath: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(TAR_HEADER_BYTES);
    if (fs.readSync(fd, header, 0, TAR_HEADER_BYTES, 0) !== TAR_HEADER_BYTES) return false;
    let stored = 0;
    let digits = 0;
    let at = TAR_CHECKSUM_OFFSET;
    const fieldEnd = TAR_CHECKSUM_OFFSET + TAR_CHECKSUM_BYTES;
    while (at < fieldEnd && (header[at] === SPACE || header[at] === NUL)) at++;
    while (at < fieldEnd && header[at] >= ASCII_ZERO && header[at] <= ASCII_SEVEN) {
      stored = stored * TAR_OCTAL_RADIX + (header[at] - ASCII_ZERO);
      digits++;
      at++;
    }
    if (digits === 0) return false;
    let unsigned = 0;
    let signed = 0;
    for (let i = 0; i < TAR_HEADER_BYTES; i++) {
      const inField = i >= TAR_CHECKSUM_OFFSET && i < fieldEnd;
      const byte = inField ? SPACE : header[i];
      unsigned += byte;
      signed += byte >= SIGN_BIT ? byte - BYTE_RANGE : byte;
    }
    return stored === unsigned || stored === signed;
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
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
  // 7-Zip opens a file as a tar only when its first block is a tar header; any other payload has nothing to vet.
  if (!isTar && !hasTarHeaderChecksum(candidate.absPath)) return;
  try {
    const inner = await listArchive(request, { archivePath: candidate.absPath, typeFlag: '-ttar' }, []);
    // The inner tar is repackaged as a whole, so its links cannot be skipped selectively.
    assertSafeArchiveListing(inner, ratioBytes, request.limits);
  } catch (err) {
    const failure = toArchiveFailure(err, request.label, 'list', request.limits, Boolean(request.password));
    if (failure instanceof UnreadableArchiveError && !isTar) return;
    throw failure;
  }
}

/**
 * Lists, vets, extracts and re-verifies an archive. Resolves with the contained output tree, or
 * rejects with a typed error; nothing is written before the listing has passed the policy.
 */
export async function extractArchiveContained(request: ContainedExtractionRequest): Promise<ContainedTree> {
  assertEntryFilterSafe(request.includePatterns);
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
    throw toArchiveFailure(err, request.label, 'list', request.limits, Boolean(request.password));
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
    throw toArchiveFailure(err, request.label, 'extract', request.limits, Boolean(request.password));
  }

  const tree = withSkippedLinks(assertExtractionContained(request.extractDir, ratioBytes, request.limits), skippedLinks);

  if (request.validateNestedTar) {
    await vetNestedTar(request, tree, ratioBytes);
  }
  return tree;
}

/** Synchronous twin of {@link extractArchiveContained} for the library's synchronous conversion path. */
export function extractArchiveContainedSync(request: ContainedExtractionRequest): ContainedTree {
  assertEntryFilterSafe(request.includePatterns);
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
    throw toArchiveFailure(err, request.label, 'list', request.limits, Boolean(request.password));
  }

  try {
    const { args, stdin } = extractArgs(request, exclude);
    const resolved = resolveSandboxedCommand(request.p7zBin, args, {
      networkIsolated: true,
      maxFileSize: request.limits.MAX_UNCOMPRESSED_SIZE,
    });
    runSevenZipSync(resolved.binary, resolved.args, {
      cwd: request.cwd,
      env: getSanitizedEnvironment({}, true),
      timeout: request.timeoutMs,
      maxBuffer: request.maxBuffer,
      input: stdin,
    });
  } catch (err) {
    throw toArchiveFailure(err, request.label, 'extract', request.limits, Boolean(request.password));
  }

  return withSkippedLinks(assertExtractionContained(request.extractDir, ratioBytes, request.limits), skippedLinks);
}

/**
 * Resource caps only (entry count, declared total size, ratio): the checks that protect the server
 * itself. Inspection enforces these and reports everything else; entries without a size are skipped.
 */
export function assertListingResourceCaps(
  entries: ListedArchiveEntry[],
  archiveBytes: number,
  limits: ArchiveExtractionLimits
): void {
  if (entries.length > limits.MAX_FILES) {
    throw entryCountError(entries.length, limits);
  }
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.linkKind === null && entry.sizeBytes !== null && Number.isSafeInteger(entry.sizeBytes)) {
      totalBytes += entry.sizeBytes;
      if (totalBytes > limits.MAX_UNCOMPRESSED_SIZE) {
        throw sizeError(limits);
      }
    }
  }
  assertWithinSizeAndRatio(totalBytes, archiveBytes, limits);
}

export type InspectedEntryKind = 'symlink' | 'hardlink' | 'special';

/** The inspection kind of a listed entry: a link, a device/FIFO/socket, or undefined for files and directories. */
export function inspectedKindOf(entry: ListedArchiveEntry): InspectedEntryKind | undefined {
  if (entry.linkKind !== null) return entry.linkKind;
  return entry.isSpecial ? 'special' : undefined;
}

export interface InspectionEntryInput {
  name: string;
  isDirectory: boolean;
  kind?: InspectedEntryKind;
}

export interface InspectionEntryFlags {
  kind?: InspectedEntryKind;
  unsafePath?: true;
  duplicate?: true;
}

export interface InspectionSafety {
  extractable: boolean;
  /** One line per category that blocks extraction, with a count and the first offending name. */
  unextractableReasons: string[];
  /** Per-entry flags, in the order of the input entries. */
  flags: InspectionEntryFlags[];
}

/**
 * Classifies the entries of an inspected archive for reporting. Nothing here follows or resolves a name:
 * names are only compared and pattern-checked. Linear in the number of entries.
 */
export function summarizeInspectionSafety(entries: InspectionEntryInput[]): InspectionSafety {
  const groups = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    const key = normalizeEntryKey(entry.name);
    const group = groups.get(key);
    if (group) {
      group.push(index);
    } else {
      groups.set(key, [index]);
    }
  });

  const flags: InspectionEntryFlags[] = entries.map((entry) => {
    const flag: InspectionEntryFlags = {};
    if (entry.kind !== undefined) flag.kind = entry.kind;
    if (entryPathProblem(entry.name) !== null) flag.unsafePath = true;
    return flag;
  });

  const duplicatePaths: string[] = [];
  for (const [key, indexes] of groups) {
    if (indexes.length > 1 && indexes.some((index) => !entries[index].isDirectory)) {
      duplicatePaths.push(key);
      for (const index of indexes) flags[index].duplicate = true;
    }
  }

  const reasons: string[] = [];
  const describe = (label: string, matching: number[]): void => {
    if (matching.length > 0) {
      reasons.push(`${label}: ${matching.length} (first: '${entries[matching[0]].name}')`);
    }
  };
  const indexesWhere = (predicate: (flag: InspectionEntryFlags) => boolean): number[] =>
    flags.flatMap((flag, index) => (predicate(flag) ? [index] : []));

  describe('symbolic or hard link entries', indexesWhere((flag) => flag.kind === 'symlink' || flag.kind === 'hardlink'));
  describe('device, FIFO or socket entries', indexesWhere((flag) => flag.kind === 'special'));
  describe('entries with an absolute, traversal or invalid path', indexesWhere((flag) => flag.unsafePath === true));
  if (duplicatePaths.length > 0) {
    reasons.push(`duplicated paths: ${duplicatePaths.length} (first: '${duplicatePaths[0]}')`);
  }

  return { extractable: reasons.length === 0, unextractableReasons: reasons, flags };
}
