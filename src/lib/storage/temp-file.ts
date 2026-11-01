import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Semaphore } from '../workers/semaphore';
import { JOB_DEADLINE_CEILING_MS } from '../config/schema';
import { NotARegularFileError } from './errors';
import { resolveLocalStagingDir, resolveStorageDriver } from './storage-config';

/**
 * The temporary files of the local driver and what is left of them after a process stops: every file is written
 * beside its final name and renamed onto it (write-file-atomic, lib/index.js 182-269), and what a stopped process
 * leaves is recognised by its name and removed by age.
 */

/** Opens a new file and fails when one of that name exists. */
export const EXCLUSIVE_CREATE = 'wx';

const TEMP_NAME_RANDOM_BYTES = 6;
const TEMP_TAGS = ['tmp', 'comb'] as const;
type TempTag = (typeof TEMP_TAGS)[number];
/** How every name `uniqueTempPath` gives ends: the tag, the time it was given and the random part. */
const TEMP_NAME_ENDING = new RegExp(`\\.(?:${TEMP_TAGS.join('|')})\\.\\d+\\.[0-9a-f]{${TEMP_NAME_RANDOM_BYTES * 2}}$`);

/** A temporary file or lock nothing was written to for this long was left by a process that stopped mid-write. */
export const LEFTOVER_AGE_MS = 60 * 60 * 1000;
/** How often a writer that may be quiet for long touches its temporary file, well within LEFTOVER_AGE_MS. */
export const TEMP_REFRESH_MS = LEFTOVER_AGE_MS / 4;
/**
 * How long after the time in its name a job directory or a staged output of the local driver is removed: the longest
 * deadline a job may be given, and LEFTOVER_AGE_MS for the save that follows it. `deploy.sh sweep` waits as long.
 */
export const JOB_STAGING_MAX_AGE_MS = JOB_DEADLINE_CEILING_MS + LEFTOVER_AGE_MS;
/**
 * Copies across volumes that run at once. Each holds a thread of libuv's file system pool (four by default) for its whole
 * length, so two leave the other threads to the reads and writes of the jobs and requests.
 */
export const CONCURRENT_COPIES = 2;

const copySlots = new Semaphore(CONCURRENT_COPIES);
const reportedRemovalFailures = new Set<string>();
const STAGED_OUTPUT_PREFIX = 'easyconvert-out-';
/** The time a staged name was given at: `<prefix><epoch ms>-<random>`. */
const STAGED_NAME_TIME = /-(\d{13,})-/;
/** Words of lowercase letters and digits, each with a letter, each ended by a dash: no part of it reads as STAGED_NAME_TIME. */
const JOB_DIRECTORY_PREFIX = /^(?:[a-z0-9]*[a-z][a-z0-9]*-)+$/;

/**
 * A temporary path beside `finalPath` that no other writer picks: two requests that write the same part at once must
 * not write into, or remove, each other's file. `tag` says what is written there, such as a part or an assembled upload.
 */
export function uniqueTempPath(finalPath: string, tag: TempTag): string {
  return `${finalPath}.${tag}.${Date.now()}.${crypto.randomBytes(TEMP_NAME_RANDOM_BYTES).toString('hex')}`;
}

/** Whether `name` is one `uniqueTempPath` gives. */
export function isTempFileName(name: string): boolean {
  return TEMP_NAME_ENDING.test(name);
}

/** Writes `data` to a temporary file beside `finalPath`, flushes it and renames it into place; the temporary file is removed on failure. */
export function writeFileAtomicSync(finalPath: string, data: string | Uint8Array): void {
  const tempPath = uniqueTempPath(finalPath, 'tmp');
  let fd: number | undefined;
  try {
    fd = fs.openSync(tempPath, EXCLUSIVE_CREATE);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, finalPath);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

/**
 * Writes `data` to a new temporary file beside `finalPath` and flushes it, in libuv's thread pool, and returns its path
 * for the caller to rename into place. Nothing is left on failure.
 */
export async function writeFlushedTemp(finalPath: string, data: string | Uint8Array): Promise<string> {
  const tempPath = uniqueTempPath(finalPath, 'tmp');
  const handle = await fs.promises.open(tempPath, EXCLUSIVE_CREATE);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fs.promises.rm(tempPath, { force: true });
    throw error;
  }
  await handle.close();
  return tempPath;
}

/** `writeFileAtomicSync` off the event loop: the write and the flush run in the thread pool, then the rename and the directory flush. */
export async function writeFileAtomic(finalPath: string, data: string | Uint8Array): Promise<void> {
  const tempPath = await writeFlushedTemp(finalPath, data);
  try {
    await fs.promises.rename(tempPath, finalPath);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true });
    throw error;
  }
  await syncDirectory(path.dirname(finalPath));
}

/**
 * Flushes the entries of `directory`, so the renames made in it survive a power loss, not only a crash of the process.
 * Best effort: a file system that cannot flush a directory keeps what the renames did.
 */
export async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await fs.promises.open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // A directory that cannot be opened or flushed here (some file systems refuse) keeps its renames until the next flush.
  }
}

/** Refuses anything at `filePath` but a regular file, such as a link an engine left at its output path, with NotARegularFileError. */
export async function assertRegularFile(filePath: string): Promise<void> {
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile()) throw new NotARegularFileError(filePath, entryKind(stat));
}

/** The same check for a caller that cannot wait, such as a synchronous copy to a destination the request named. */
export function assertRegularFileSync(filePath: string): void {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile()) throw new NotARegularFileError(filePath, entryKind(stat));
}

function entryKind(stat: fs.Stats): string {
  if (stat.isSymbolicLink()) return 'symbolic link';
  return stat.isDirectory() ? 'directory' : 'special file';
}

/**
 * Touches `filePath` now and every TEMP_REFRESH_MS until the returned function is called, so a writer whose source is
 * quiet, or whose flush is long, keeps a file the sweep would otherwise take for abandoned. A failed touch is logged.
 */
export async function keepTouched(filePath: string): Promise<() => void> {
  const touch = async (): Promise<void> => {
    const now = new Date();
    await fs.promises.utimes(filePath, now, now).catch((error: unknown) => {
      console.warn(`Could not touch the temporary file "${filePath}"; a sweep may take it for abandoned an hour after its last write:`, error);
    });
  };
  await touch();
  const timer = setInterval(() => void touch(), TEMP_REFRESH_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** Flushes the file at `filePath` to disk and returns its size. */
export async function syncFile(filePath: string): Promise<number> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    await handle.sync();
    return (await handle.stat()).size;
  } finally {
    await handle.close();
  }
}

/**
 * Copies `sourcePath` to a temporary file beside `finalPath`, touches it, flushes it and checks its size, at most
 * CONCURRENT_COPIES at once; returns its path. The copy runs in libuv's thread pool, so the event loop keeps its heartbeat.
 * A `signal` that aborts ends the wait for a slot, or fails the copy once it is made. Nothing is left on failure.
 */
async function copyBeside(sourcePath: string, finalPath: string, signal?: AbortSignal): Promise<string> {
  return copySlots.run(async () => {
    const tempPath = uniqueTempPath(finalPath, 'tmp');
    let stopTouching = (): void => undefined;
    try {
      const expectedSize = (await fs.promises.stat(sourcePath)).size;
      await fs.promises.copyFile(sourcePath, tempPath, fs.constants.COPYFILE_EXCL);
      // A copy may keep the time of its source, which can be hours old.
      stopTouching = await keepTouched(tempPath);
      const copiedSize = await syncFile(tempPath);
      if (copiedSize !== expectedSize) {
        throw new Error(`Copy of "${sourcePath}" holds ${copiedSize} bytes, expected ${expectedSize}`);
      }
      signal?.throwIfAborted();
      return tempPath;
    } catch (error) {
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      stopTouching();
    }
  }, signal);
}

async function removeMovedSource(sourcePath: string, finalPath: string): Promise<void> {
  try {
    await fs.promises.rm(sourcePath, { force: true });
  } catch (error) {
    console.warn(`Could not remove "${sourcePath}" after storing it at "${finalPath}"`, error);
  }
}

/**
 * Puts the regular file at `sourcePath` at `finalPath` and leaves nothing at `sourcePath`. It is renamed when both are on
 * one volume; across volumes it is copied beside `finalPath` (see `copyBeside`) and renamed into place, so a reader never
 * sees half of it. An aborted `signal` stops it before the rename.
 */
export async function moveIntoPlace(sourcePath: string, finalPath: string, signal?: AbortSignal): Promise<void> {
  if (path.resolve(sourcePath) === path.resolve(finalPath)) return;
  await assertRegularFile(sourcePath);
  await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
  try {
    await fs.promises.rename(sourcePath, finalPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }
  const copy = await copyBeside(sourcePath, finalPath, signal);
  try {
    signal?.throwIfAborted();
    await fs.promises.rename(copy, finalPath);
  } catch (error) {
    await fs.promises.rm(copy, { force: true });
    throw error;
  }
  await removeMovedSource(sourcePath, finalPath);
}

/**
 * Brings the regular file at `sourcePath` to a temporary path beside `finalPath`, on its volume, and flushes it; returns
 * that path, for the caller to rename into place without an await. It is renamed there when both are on one volume,
 * else copied (see `copyBeside`) and the source removed. Its time is now, so the sweep does not take it for abandoned.
 */
export async function stageBeside(sourcePath: string, finalPath: string, signal?: AbortSignal): Promise<string> {
  await assertRegularFile(sourcePath);
  await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
  const tempPath = uniqueTempPath(finalPath, 'tmp');
  try {
    await fs.promises.rename(sourcePath, tempPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    const copy = await copyBeside(sourcePath, finalPath, signal);
    await removeMovedSource(sourcePath, finalPath);
    return copy;
  }
  try {
    const now = new Date();
    await fs.promises.utimes(tempPath, now, now);
    await syncFile(tempPath);
    return tempPath;
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true });
    throw error;
  }
}

/** Removes the leftover `target`. One that is gone already counts as removed; any other failure is logged once per path. */
export async function removeLeftover(target: string): Promise<boolean> {
  try {
    await fs.promises.rm(target, { recursive: true, force: true });
    reportedRemovalFailures.delete(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    if (!reportedRemovalFailures.has(target)) {
      reportedRemovalFailures.add(target);
      console.warn(`Could not remove the leftover "${target}"; every sweep tries again:`, error);
    }
    return false;
  }
}

/**
 * Removes the entries of `directory` whose name says they were created more than `maxAgeMs` before `now`, as
 * `createdAt` reads the name. A name it cannot read stays. Nothing is stat'ed: the name holds the time.
 */
export async function sweepByNameTime(
  directory: string,
  createdAt: (name: string) => number | undefined,
  maxAgeMs: number,
  now: number
): Promise<number> {
  let names: string[];
  try {
    names = await fs.promises.readdir(directory);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const created = createdAt(name);
    if (created === undefined || now - created <= maxAgeMs) continue;
    if (await removeLeftover(path.join(directory, name))) removed++;
  }
  return removed;
}

/** The directory jobs write in: the storage directory's staging folder for the local driver, so outputs are stored by a rename; else the temporary directory. */
function jobScratchRoot(): string {
  return resolveStorageDriver() === 'local' ? resolveLocalStagingDir() : os.tmpdir();
}

function ensuredJobScratchRoot(): string {
  const root = jobScratchRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

/**
 * A new directory of its own for one job, named with the time it was made (see `sweepStaleJobDirectories`). The prefix
 * is words of lowercase letters and digits ended by dashes, such as `easyconvert-7z-`, so the sweep reads the time.
 */
export function makeJobDirectory(prefix: string): string {
  if (!JOB_DIRECTORY_PREFIX.test(prefix)) throw new Error(`The job directory prefix "${prefix}" is not words of lowercase letters and digits ended by dashes`);
  return fs.mkdtempSync(path.join(ensuredJobScratchRoot(), `${prefix}${Date.now()}-`));
}

/** A path of the worker's own naming for a job's output, beside the job directories. */
export function stagedOutputPath(extension: string): string {
  return path.join(ensuredJobScratchRoot(), `${STAGED_OUTPUT_PREFIX}${Date.now()}-${crypto.randomUUID()}.${extension}`);
}

function stagedNameTime(name: string): number | undefined {
  const match = STAGED_NAME_TIME.exec(name);
  return match ? Number(match[1]) : undefined;
}

/** Removes the job directories and outputs of the local driver's staging folder that a stopped worker left, by the time in their names. */
export function sweepStaleJobDirectories(now: number = Date.now()): Promise<number> {
  return sweepByNameTime(resolveLocalStagingDir(), stagedNameTime, JOB_STAGING_MAX_AGE_MS, now);
}
