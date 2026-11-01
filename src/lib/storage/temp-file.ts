import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Semaphore } from '../workers/semaphore';
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
 * The longest an upload session or a job directory stays open, from the time in its name: a day, as the stale uploads
 * expiry of an object store server (24 h by default). Past it and LEFTOVER_AGE_MS, a sweep removes what is left.
 */
export const OPEN_WORK_TTL_MS = 24 * 60 * 60 * 1000;
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

/** Copies `sourcePath` to a temporary file beside `finalPath`, makes it durable, checks its size and renames it into place. */
async function copyIntoPlace(sourcePath: string, finalPath: string): Promise<void> {
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
    await fs.promises.rename(tempPath, finalPath);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    stopTouching();
  }
}

/**
 * Puts the file at `sourcePath` at `finalPath` and leaves nothing at `sourcePath`. It is renamed when both are on one
 * volume; across volumes it is copied beside `finalPath` and renamed into place, so a reader never sees half of it, at
 * most CONCURRENT_COPIES at once. The copy runs in libuv's thread pool, so the event loop keeps its heartbeat.
 */
export async function moveIntoPlace(sourcePath: string, finalPath: string): Promise<void> {
  if (path.resolve(sourcePath) === path.resolve(finalPath)) return;
  await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
  try {
    await fs.promises.rename(sourcePath, finalPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }
  await copySlots.run(() => copyIntoPlace(sourcePath, finalPath));
  try {
    await fs.promises.rm(sourcePath, { force: true });
  } catch (error) {
    console.warn(`Could not remove "${sourcePath}" after storing it at "${finalPath}"`, error);
  }
}

/** Removes the leftover `target`. One that is gone already counts as removed; any other failure is logged once per path. */
export function removeLeftover(target: string): boolean {
  try {
    fs.rmSync(target, { recursive: true, force: true });
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
export function sweepByNameTime(directory: string, createdAt: (name: string) => number | undefined, maxAgeMs: number, now: number): number {
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const created = createdAt(name);
    if (created === undefined || now - created <= maxAgeMs) continue;
    if (removeLeftover(path.join(directory, name))) removed++;
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

/** A new directory of its own for one job, named with the time it was made (see `sweepStaleJobDirectories`). */
export function makeJobDirectory(prefix: string): string {
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
export function sweepStaleJobDirectories(now: number = Date.now()): number {
  return sweepByNameTime(resolveLocalStagingDir(), stagedNameTime, OPEN_WORK_TTL_MS + LEFTOVER_AGE_MS, now);
}
