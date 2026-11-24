import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ArchiveEntryCollisionError,
  type ArchiveCollisionPolicy,
  type ConversionResult,
} from '../types';
import {
  executeSandboxedBinary,
  getSanitizedEnvironment,
  resolveSandboxedCommand,
  rethrowSandboxUnavailable,
} from '../security/process-sandbox';
import { readSandboxOutput, readSandboxOutputAsync } from '../security/sandbox-output';
import { quotedEntryName, UnsafeArchiveError } from './archive-extraction-safety';
import { encryptedStagedName } from './archive-entry-path';
import {
  MAX_ENCRYPTION_LISTING_BYTES,
  SEVEN_ZIP_ASK_PASSWORD_SWITCH,
  SEVEN_ZIP_LISTING_TIMEOUT_MS,
  archiveFailureStderr,
  assertArchivePasswordSafe,
  assertEncryptedArchiveInputWithinLimits,
  assertListingShowsEncryption,
  assertZipPasswordSupported,
  execFileSyncWithPasswordStdin,
  sevenZipCreatePasswordInput,
  sevenZipEncryptionCheckInput,
} from './archive-password';

const ENCRYPTED_ARCHIVE_CREATE_TIMEOUT_MS = 60_000;
const STAGING_WRITE_BATCH = 32;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export interface EncryptedArchiveParams {
  p7z: string;
  archiveName: string;
  archiveType: 'zip' | '7z';
  mimeType: string;
  password?: string;
  collisionPolicy?: ArchiveCollisionPolicy;
  signal?: AbortSignal;
}

function normalizeEncryptedEntries<T extends { filename: string; buffer: Buffer }>(files: readonly T[]): T[] {
  return files.map((file) => {
    const filename = encryptedStagedName(file.filename);
    if (filename === '.') {
      throw new UnsafeArchiveError(
        'invalid-entry-name',
        `Archive contains an entry with an invalid staging name ('${quotedEntryName(file.filename)}').`
      );
    }
    return { ...file, filename };
  });
}

function rejectEncryptedEntryCollisions<T extends { filename: string; buffer: Buffer }>(entries: T[]): T[] {
  const seenFiles = new Set<string>();
  const dirOwners = new Map<string, string>();
  for (const entry of entries) {
    const entryPath = entry.filename;
    if (seenFiles.has(entryPath)) {
      throw new ArchiveEntryCollisionError(
        entryPath,
        `Archive entry collision detected for '${entryPath}' under collision policy 'error'.`
      );
    }
    const existingChild = dirOwners.get(entryPath);
    if (existingChild !== undefined) {
      throw new ArchiveEntryCollisionError(
        entryPath,
        `Archive entry collision detected for '${entryPath}' (conflicts with '${existingChild}') under collision policy 'error'.`
      );
    }
    for (let slash = entryPath.indexOf('/'); slash !== -1; slash = entryPath.indexOf('/', slash + 1)) {
      const ancestor = entryPath.slice(0, slash);
      if (seenFiles.has(ancestor)) {
        throw new ArchiveEntryCollisionError(
          entryPath,
          `Archive entry collision detected for '${entryPath}' (conflicts with '${ancestor}') under collision policy 'error'.`
        );
      }
      if (!dirOwners.has(ancestor)) dirOwners.set(ancestor, entryPath);
    }
    seenFiles.add(entryPath);
  }
  return entries;
}

function purgeDirectorySubtree<T>(
  dir: string,
  files: Map<string, T>,
  dirChildren: Map<string, Set<string>>
): void {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const children = dirChildren.get(current);
    if (!children) continue;
    dirChildren.delete(current);
    for (const child of children) {
      files.delete(child);
      if (dirChildren.has(child)) stack.push(child);
    }
  }
}

function registerEntryAncestors(entryPath: string, dirChildren: Map<string, Set<string>>): void {
  let prev = entryPath;
  for (let slash = entryPath.lastIndexOf('/'); slash > 0; slash = entryPath.lastIndexOf('/', slash - 1)) {
    const parent = entryPath.slice(0, slash);
    let children = dirChildren.get(parent);
    if (children?.has(prev)) break;
    if (!children) {
      children = new Set<string>();
      dirChildren.set(parent, children);
    }
    children.add(prev);
    prev = parent;
  }
}

function overwriteEncryptedEntryCollisions<T extends { filename: string; buffer: Buffer }>(entries: T[]): T[] {
  const files = new Map<string, T>();
  const dirChildren = new Map<string, Set<string>>();

  for (const entry of entries) {
    const entryPath = entry.filename;
    if (dirChildren.has(entryPath)) {
      purgeDirectorySubtree(entryPath, files, dirChildren);
    }
    for (let slash = entryPath.indexOf('/'); slash !== -1; slash = entryPath.indexOf('/', slash + 1)) {
      files.delete(entryPath.slice(0, slash));
    }
    registerEntryAncestors(entryPath, dirChildren);
    files.set(entryPath, entry);
  }

  return Array.from(files.values());
}

function nextFreeEncryptedName(
  entryPath: string,
  reserved: Set<string>,
  nextSuffix: Map<string, number>
): string {
  const ext = path.posix.extname(entryPath);
  const dir = path.posix.dirname(entryPath);
  const baseStem = path.posix.basename(entryPath, ext);
  const prefix = dir === '.' || dir === '' ? '' : `${dir}/`;
  let counter = nextSuffix.get(entryPath) ?? 1;
  let candidate = `${prefix}${baseStem}-${counter}${ext}`;
  while (reserved.has(candidate)) {
    counter++;
    candidate = `${prefix}${baseStem}-${counter}${ext}`;
  }
  nextSuffix.set(entryPath, counter + 1);
  return candidate;
}

function renameEncryptedEntryCollisions<T extends { filename: string; buffer: Buffer }>(entries: T[]): T[] {
  const requiredDirs = new Set<string>();
  const reserved = new Set<string>();
  for (const entry of entries) {
    const entryPath = entry.filename;
    reserved.add(entryPath);
    for (let slash = entryPath.lastIndexOf('/'); slash > 0; slash = entryPath.lastIndexOf('/', slash - 1)) {
      const parent = entryPath.slice(0, slash);
      if (requiredDirs.has(parent)) break;
      requiredDirs.add(parent);
      reserved.add(parent);
    }
  }

  const assigned = new Set<string>();
  const nextSuffix = new Map<string, number>();
  const result: T[] = [];

  for (const entry of entries) {
    const entryPath = entry.filename;
    if (!requiredDirs.has(entryPath) && !assigned.has(entryPath)) {
      assigned.add(entryPath);
      result.push(entry);
      continue;
    }
    const candidate = nextFreeEncryptedName(entryPath, reserved, nextSuffix);
    reserved.add(candidate);
    assigned.add(candidate);
    result.push({ ...entry, filename: candidate });
  }

  return result;
}

/**
 * Normalizes uploaded filenames first via `encryptedStagedName`, then resolves exact-path and
 * POSIX file-vs-ancestor-directory prefix conflicts under `collisionPolicy` in O(N * depth).
 */
export function resolveEncryptedStagingEntries<T extends { filename: string; buffer: Buffer }>(
  files: readonly T[],
  collisionPolicy: ArchiveCollisionPolicy = 'rename'
): T[] {
  const normalized = normalizeEncryptedEntries(files);
  if (collisionPolicy === 'error') return rejectEncryptedEntryCollisions(normalized);
  if (collisionPolicy === 'overwrite') return overwriteEncryptedEntryCollisions(normalized);
  return renameEncryptedEntryCollisions(normalized);
}

/**
 * Lists a freshly created password-protected archive without its password and throws
 * ArchiveNotEncryptedError unless it is encrypted, so a plaintext archive is never returned.
 */
export function assertCreatedArchiveEncrypted(p7z: string, archivePath: string, format: 'zip' | '7z', cwd: string): void {
  const resolved = resolveSandboxedCommand(p7z, ['l', '-slt', archivePath], { networkIsolated: true, workDir: cwd, readDirs: [archivePath] });
  let outcome: { listing?: string; failureOutput?: string };
  try {
    const out = execFileSyncWithPasswordStdin(resolved.binary, resolved.args, {
      cwd,
      env: getSanitizedEnvironment({}, true, cwd),
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

/**
 * Async counterpart of `assertCreatedArchiveEncrypted` that keeps the web event loop free via `executeSandboxedBinary`.
 */
export async function assertCreatedArchiveEncryptedAsync(
  p7z: string,
  archivePath: string,
  format: 'zip' | '7z',
  cwd: string,
  workDir: string,
  signal?: AbortSignal
): Promise<void> {
  let outcome: { listing?: string; failureOutput?: string };
  try {
    const res = await executeSandboxedBinary(p7z, ['l', '-slt', archivePath], {
      cwd,
      workDir,
      readDirs: [archivePath],
      networkIsolated: true,
      timeoutMs: SEVEN_ZIP_LISTING_TIMEOUT_MS,
      maxBuffer: MAX_ENCRYPTION_LISTING_BYTES,
      stdin: sevenZipEncryptionCheckInput(),
      signal,
    });
    outcome = { listing: res.stdout.toString('utf-8') };
  } catch (err) {
    rethrowSandboxUnavailable(err);
    if (signal?.aborted) throw err;
    outcome = { failureOutput: archiveFailureStderr(err) };
  }
  assertListingShowsEncryption(format, outcome);
}

function encryptedArchiveArgs(archiveType: 'zip' | '7z'): string[] {
  return archiveType === '7z'
    ? ['-t7z', '-mhe=on', SEVEN_ZIP_ASK_PASSWORD_SWITCH]
    : ['-tzip', '-mem=AES256', SEVEN_ZIP_ASK_PASSWORD_SWITCH];
}

function createWorkDirsSync(archiveType: 'zip' | '7z'): { workDir: string; stagingDir: string } {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `easyconvert-${archiveType}-create-${Date.now()}-`));
  try {
    fs.chmodSync(workDir, PRIVATE_DIRECTORY_MODE);
    const stagingDir = path.join(workDir, 'staging');
    fs.mkdirSync(stagingDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    fs.chmodSync(stagingDir, PRIVATE_DIRECTORY_MODE);
    return { workDir, stagingDir };
  } catch (err) {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    throw err;
  }
}

async function createWorkDirsAsync(archiveType: 'zip' | '7z'): Promise<{ workDir: string; stagingDir: string }> {
  const workDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), `easyconvert-${archiveType}-create-${Date.now()}-`)
  );
  try {
    await fs.promises.chmod(workDir, PRIVATE_DIRECTORY_MODE);
    const stagingDir = path.join(workDir, 'staging');
    await fs.promises.mkdir(stagingDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await fs.promises.chmod(stagingDir, PRIVATE_DIRECTORY_MODE);
    return { workDir, stagingDir };
  } catch (err) {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

function ensureStagingDirSync(stagingDir: string, stagedName: string, createdDirs: Set<string>): void {
  const relDir = path.posix.dirname(stagedName);
  if (relDir === '.' || relDir === '') return;
  if (createdDirs.has(path.join(stagingDir, relDir))) return;
  let current = stagingDir;
  let start = 0;
  while (start <= relDir.length) {
    const slash = relDir.indexOf('/', start);
    const end = slash === -1 ? relDir.length : slash;
    if (end > start) {
      current = path.join(current, relDir.slice(start, end));
      if (!createdDirs.has(current)) {
        fs.mkdirSync(current, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
        fs.chmodSync(current, PRIVATE_DIRECTORY_MODE);
        createdDirs.add(current);
      }
    }
    start = end + 1;
  }
}

async function ensureStagingDirAsync(stagingDir: string, stagedName: string, createdDirs: Set<string>): Promise<void> {
  const relDir = path.posix.dirname(stagedName);
  if (relDir === '.' || relDir === '') return;
  if (createdDirs.has(path.join(stagingDir, relDir))) return;
  let current = stagingDir;
  let start = 0;
  while (start <= relDir.length) {
    const slash = relDir.indexOf('/', start);
    const end = slash === -1 ? relDir.length : slash;
    if (end > start) {
      current = path.join(current, relDir.slice(start, end));
      if (!createdDirs.has(current)) {
        await fs.promises.mkdir(current, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
        await fs.promises.chmod(current, PRIVATE_DIRECTORY_MODE);
        createdDirs.add(current);
      }
    }
    start = end + 1;
  }
}

function stageEncryptedFilesSync(
  stagingDir: string,
  resolvedFiles: readonly { filename: string; buffer: Buffer }[]
): void {
  const createdDirs = new Set<string>([stagingDir]);
  for (const file of resolvedFiles) {
    ensureStagingDirSync(stagingDir, file.filename, createdDirs);
    const dest = path.join(stagingDir, file.filename);
    fs.writeFileSync(dest, file.buffer, { mode: PRIVATE_FILE_MODE });
  }
}

/** Synchronous encrypted archive creation kept for synchronous `create7zArchive`. */
export function createEncryptedArchiveVia7z(
  resolvedFiles: { filename: string; buffer: Buffer }[],
  params: EncryptedArchiveParams
): ConversionResult | null {
  const { p7z, archiveName, archiveType, mimeType, password, collisionPolicy } = params;
  if (!p7z || !password) return null;
  assertArchivePasswordSafe(password);
  if (archiveType === 'zip') assertZipPasswordSupported(password);

  const resolved = resolveEncryptedStagingEntries(resolvedFiles, collisionPolicy ?? 'rename');
  const stagedNames = resolved.map((f) => f.filename);
  assertEncryptedArchiveInputWithinLimits(stagedNames);
  const { workDir, stagingDir } = createWorkDirsSync(archiveType);
  try {
    stageEncryptedFilesSync(stagingDir, resolved);
    const outPath = path.join(workDir, archiveName);
    const extraArgs = encryptedArchiveArgs(archiveType);
    const resolvedCmd = resolveSandboxedCommand(p7z, ['a', '-y', ...extraArgs, outPath, '.'], {
      networkIsolated: true, workDir,
    });
    execFileSyncWithPasswordStdin(resolvedCmd.binary, resolvedCmd.args, {
      cwd: stagingDir,
      env: getSanitizedEnvironment({}, true, workDir),
      timeout: ENCRYPTED_ARCHIVE_CREATE_TIMEOUT_MS,
      input: sevenZipCreatePasswordInput(password),
    });
    assertCreatedArchiveEncrypted(p7z, outPath, archiveType, stagingDir);
    const content = readSandboxOutput(outPath);
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

async function stageEncryptedFilesAsync(
  stagingDir: string,
  resolvedFiles: readonly { filename: string; buffer: Buffer }[],
  signal?: AbortSignal
): Promise<void> {
  const createdDirs = new Set<string>([stagingDir]);
  for (let start = 0; start < resolvedFiles.length; start += STAGING_WRITE_BATCH) {
    signal?.throwIfAborted();
    const end = Math.min(start + STAGING_WRITE_BATCH, resolvedFiles.length);
    const batch: Promise<void>[] = [];
    for (let i = start; i < end; i++) {
      const file = resolvedFiles[i]!;
      await ensureStagingDirAsync(stagingDir, file.filename, createdDirs);
      const dest = path.join(stagingDir, file.filename);
      batch.push(fs.promises.writeFile(dest, file.buffer, { mode: PRIVATE_FILE_MODE }));
    }
    await Promise.all(batch);
  }
}

/** Async encrypted ZIP/7z creation running off the web event loop with `0o700` workDir isolation. */
export async function createEncryptedArchiveVia7zAsync(
  resolvedFiles: { filename: string; buffer: Buffer }[],
  params: EncryptedArchiveParams
): Promise<ConversionResult | null> {
  const { p7z, archiveName, archiveType, mimeType, password, collisionPolicy, signal } = params;
  if (!p7z || !password) return null;
  assertArchivePasswordSafe(password);
  if (archiveType === 'zip') assertZipPasswordSupported(password);

  const resolved = resolveEncryptedStagingEntries(resolvedFiles, collisionPolicy ?? 'rename');
  const stagedNames = resolved.map((f) => f.filename);
  assertEncryptedArchiveInputWithinLimits(stagedNames);
  signal?.throwIfAborted();
  const { workDir, stagingDir } = await createWorkDirsAsync(archiveType);
  try {
    await stageEncryptedFilesAsync(stagingDir, resolved, signal);
    signal?.throwIfAborted();
    const outPath = path.join(workDir, archiveName);
    const extraArgs = encryptedArchiveArgs(archiveType);
    await executeSandboxedBinary(p7z, ['a', '-y', ...extraArgs, outPath, '.'], {
      cwd: stagingDir,
      workDir,
      networkIsolated: true,
      timeoutMs: ENCRYPTED_ARCHIVE_CREATE_TIMEOUT_MS,
      stdin: sevenZipCreatePasswordInput(password),
      signal,
    });
    await assertCreatedArchiveEncryptedAsync(p7z, outPath, archiveType, stagingDir, workDir, signal);
    const content = await readSandboxOutputAsync(outPath);
    return {
      buffer: content,
      mimeType,
      filename: archiveName,
      size: content.length,
    };
  } finally {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
