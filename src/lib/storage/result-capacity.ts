import fs from 'node:fs';
import path from 'node:path';
import { isHeld, isResultRecord, readIntegerSetting, type RetentionPolicy, type RetentionRecord } from './result-retention';

/**
 * Early deletion of results when the disk of the local storage driver runs full (docs/policy-decisions.md, entry
 * 125). Above RESULT_DISK_HIGH_PERCENT the sweep deletes results until the use is at or below
 * RESULT_DISK_LOW_PERCENT; above RESULT_DISK_REFUSE_PERCENT new uploads and conversions are refused. Object-store
 * drivers have no fixed size, so none of this applies to them.
 */

export const DISK_HIGH_VARIABLE = 'RESULT_DISK_HIGH_PERCENT';
export const DISK_LOW_VARIABLE = 'RESULT_DISK_LOW_PERCENT';
export const DISK_REFUSE_VARIABLE = 'RESULT_DISK_REFUSE_PERCENT';

const PERCENT = 100;
/**
 * Age before which an undelivered result is not deleted for space. A client polls its job and downloads the result
 * within seconds to minutes of its end; ten minutes keeps that path whole when the disk fills from something that
 * deleting results cannot free (uploads, spools), while results nobody fetched in that time still go first.
 */
export const CAPACITY_MIN_AGE_MS = 10 * 60 * 1000;

export interface CapacityPolicy {
  /** Use, in percent, above which results are deleted early. */
  readonly highPercent: number;
  /** Use, in percent, at or below which early deletion stops. */
  readonly lowPercent: number;
  /** Use, in percent, above which new uploads and conversions are refused. */
  readonly refusePercent: number;
}

type Env = Readonly<Record<string, string | undefined>>;

/** The three thresholds of `env`. They must rise strictly from low to high to refuse. */
export function resolveCapacityPolicy(env: Env = process.env): CapacityPolicy {
  const policy = {
    highPercent: readIntegerSetting(env, DISK_HIGH_VARIABLE),
    lowPercent: readIntegerSetting(env, DISK_LOW_VARIABLE),
    refusePercent: readIntegerSetting(env, DISK_REFUSE_VARIABLE),
  };
  if (policy.lowPercent >= policy.highPercent) throw new RangeError(`${DISK_LOW_VARIABLE} must be below ${DISK_HIGH_VARIABLE}`);
  if (policy.highPercent >= policy.refusePercent) throw new RangeError(`${DISK_HIGH_VARIABLE} must be below ${DISK_REFUSE_VARIABLE}`);
  return policy;
}

/** The block counts of `statfs` that the use is computed from, and the size of a block. */
export interface DiskBlocks {
  readonly blocks: number;
  readonly bfree: number;
  readonly bavail: number;
  readonly bsize?: number;
}

/** The size `statfs` and `stat` count blocks of allocation in (`st_blocks` is in 512-byte units). */
const STAT_BLOCK_BYTES = 512;

/**
 * The use of a file system in percent, as `df` reports it: used blocks over the blocks an unprivileged process can
 * fill (used plus available), so the blocks reserved for root count as full. `excludedBytes` are left out of both, as
 * if they were on another disk.
 */
export function usedPercent({ blocks, bfree, bavail, bsize }: DiskBlocks, excludedBytes = 0): number {
  const excluded = bsize ? excludedBytes / bsize : 0;
  const used = blocks - bfree - excluded;
  const usable = blocks - bfree + bavail - excluded;
  return usable <= 0 ? 0 : (Math.max(0, used) * PERCENT) / usable;
}

/** Measures the use of the fullest file system among some directories, in percent; undefined while none of them exists yet. */
export type DiskProbe = () => Promise<number | undefined>;

/** The device of `directory`, or undefined while it does not exist yet. */
async function deviceOf(directory: string): Promise<number | undefined> {
  try {
    return (await fs.promises.stat(directory)).dev;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** The bytes the files under `directory` take on disk; 0 while it does not exist. Files removed during the walk count as none. */
async function allocatedBytesUnder(directory: string): Promise<number> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directory, { recursive: true, withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const stat = await fs.promises.lstat(path.join(entry.parentPath, entry.name)).catch(() => undefined);
    if (stat) bytes += stat.blocks * STAT_BLOCK_BYTES;
  }
  return bytes;
}

/**
 * Measures the file systems that hold `directories` (the storage directory, where results live, and the temporary
 * directory, where uploads and conversions spool) and reports the fuller one. A file system that holds several of
 * them is measured once. The bytes under `excludedDirectories` (the parts of open uploads and the directories of
 * running jobs, which deleting results cannot free) are left out of the file system that holds them.
 */
export function diskUsageProbe(directories: readonly string[], excludedDirectories: readonly string[] = []): DiskProbe {
  return async () => {
    const byDevice = new Map<number, string>();
    for (const directory of directories) {
      const device = await deviceOf(directory);
      if (device !== undefined && !byDevice.has(device)) byDevice.set(device, directory);
    }
    if (byDevice.size === 0) return undefined;
    const excludedByDevice = new Map<number, number>();
    for (const directory of excludedDirectories) {
      const device = await deviceOf(directory);
      if (device !== undefined) excludedByDevice.set(device, (excludedByDevice.get(device) ?? 0) + (await allocatedBytesUnder(directory)));
    }
    const uses = await Promise.all(
      [...byDevice].map(async ([device, directory]) => usedPercent(await fs.promises.statfs(directory), excludedByDevice.get(device)))
    );
    return Math.max(...uses);
  };
}

/**
 * Whether the result of `record` may be deleted for space at `now`. Never an upload, or a result that is gone, held by a job,
 * waiting for the next try after a failed deletion, or undelivered and either younger than CAPACITY_MIN_AGE_MS or partly
 * sent (a client may resume it) within the undelivered time.
 */
export function isCapacityCandidate(record: RetentionRecord, now: number, policy: RetentionPolicy): boolean {
  if (!isResultRecord(record) || record.goneAt !== undefined || isHeld(record, now) || (record.retryAt ?? 0) > now) return false;
  if (record.deliveredAt !== undefined) return true;
  const recentlyServed = record.lastServedAt !== undefined && now - record.lastServedAt < policy.undeliveredTtlMs;
  return now - record.createdAt >= CAPACITY_MIN_AGE_MS && record.received.length === 0 && !recentlyServed;
}

/**
 * The results to delete when the disk runs full, in order: delivered results in their grace period, the earliest
 * delivery first, then undelivered results, the oldest first. Only results `isCapacityCandidate` allows are listed.
 */
export function capacityEvictionOrder(records: readonly RetentionRecord[], now: number, policy: RetentionPolicy): RetentionRecord[] {
  const candidates = records.filter((record) => isCapacityCandidate(record, now, policy));
  const delivered = candidates.filter((record) => record.deliveredAt !== undefined);
  const undelivered = candidates.filter((record) => record.deliveredAt === undefined);
  delivered.sort((a, b) => (a.deliveredAt as number) - (b.deliveredAt as number));
  undelivered.sort((a, b) => a.createdAt - b.createdAt);
  return [...delivered, ...undelivered];
}
