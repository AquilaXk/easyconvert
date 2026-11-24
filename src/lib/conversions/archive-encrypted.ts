import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConversionResult } from '../types';
import {
  executeSandboxedBinary,
  getSanitizedEnvironment,
  resolveSandboxedCommand,
  rethrowSandboxUnavailable,
} from '../security/process-sandbox';
import { readSandboxOutput, readSandboxOutputAsync } from '../security/sandbox-output';
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

export interface EncryptedArchiveParams {
  p7z: string;
  archiveName: string;
  archiveType: 'zip' | '7z';
  mimeType: string;
  password?: string;
  signal?: AbortSignal;
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

function newEncryptedArchiveDirs(archiveType: 'zip' | '7z'): { workDir: string; stagingDir: string } {
  const token = crypto.randomBytes(8).toString('hex');
  const workDir = path.join(os.tmpdir(), `easyconvert_${archiveType}_create_${Date.now()}_${token}`);
  return { workDir, stagingDir: path.join(workDir, 'staging') };
}

/** Synchronous encrypted archive creation kept for synchronous `create7zArchive`. */
export function createEncryptedArchiveVia7z(
  resolvedFiles: { filename: string; buffer: Buffer }[],
  params: EncryptedArchiveParams
): ConversionResult | null {
  const { p7z, archiveName, archiveType, mimeType, password } = params;
  if (!p7z || !password) return null;
  assertArchivePasswordSafe(password);
  if (archiveType === 'zip') assertZipPasswordSupported(password);

  const stagedNames = resolvedFiles.map((f) => encryptedStagedName(f.filename));
  assertEncryptedArchiveInputWithinLimits(stagedNames);
  const { workDir, stagingDir } = newEncryptedArchiveDirs(archiveType);
  fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(stagingDir, { recursive: true });
  try {
    for (const [i, f] of resolvedFiles.entries()) {
      const dest = path.join(stagingDir, stagedNames[i]!);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.buffer);
    }
    const outPath = path.join(workDir, archiveName);
    const extraArgs = encryptedArchiveArgs(archiveType);
    const resolved = resolveSandboxedCommand(p7z, ['a', '-y', ...extraArgs, outPath, '.'], {
      networkIsolated: true, workDir,
    });
    execFileSyncWithPasswordStdin(resolved.binary, resolved.args, {
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
  stagedNames: readonly string[],
  signal?: AbortSignal
): Promise<void> {
  const createdDirs = new Set<string>([stagingDir]);
  for (let start = 0; start < resolvedFiles.length; start += STAGING_WRITE_BATCH) {
    signal?.throwIfAborted();
    const end = Math.min(start + STAGING_WRITE_BATCH, resolvedFiles.length);
    const batch: Promise<void>[] = [];
    for (let i = start; i < end; i++) {
      const dest = path.join(stagingDir, stagedNames[i]!);
      const dir = path.dirname(dest);
      if (!createdDirs.has(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
        createdDirs.add(dir);
      }
      batch.push(fs.promises.writeFile(dest, resolvedFiles[i]!.buffer));
    }
    await Promise.all(batch);
  }
}

/** Async encrypted ZIP/7z creation running off the web event loop with `0o700` workDir isolation. */
export async function createEncryptedArchiveVia7zAsync(
  resolvedFiles: { filename: string; buffer: Buffer }[],
  params: EncryptedArchiveParams
): Promise<ConversionResult | null> {
  const { p7z, archiveName, archiveType, mimeType, password, signal } = params;
  if (!p7z || !password) return null;
  assertArchivePasswordSafe(password);
  if (archiveType === 'zip') assertZipPasswordSupported(password);

  const stagedNames = resolvedFiles.map((f) => encryptedStagedName(f.filename));
  assertEncryptedArchiveInputWithinLimits(stagedNames);
  const { workDir, stagingDir } = newEncryptedArchiveDirs(archiveType);
  await fs.promises.mkdir(workDir, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(stagingDir, { recursive: true });
  try {
    await stageEncryptedFilesAsync(stagingDir, resolvedFiles, stagedNames, signal);
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
