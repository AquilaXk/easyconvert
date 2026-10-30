import fs from 'node:fs';
import { readIntegerSetting } from './result-retention';

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

/** The block counts of `statfs` that the use is computed from. */
export interface DiskBlocks {
  readonly blocks: number;
  readonly bfree: number;
  readonly bavail: number;
}

/**
 * The use of a file system in percent, as `df` reports it: used blocks over the blocks an unprivileged process can
 * fill (used plus available), so the blocks reserved for root count as full.
 */
export function usedPercent({ blocks, bfree, bavail }: DiskBlocks): number {
  const used = blocks - bfree;
  const usable = used + bavail;
  return usable === 0 ? 0 : (used * PERCENT) / usable;
}

/** Measures the use of the file system that holds `directory`, in percent; undefined while the directory does not exist yet. */
export type DiskProbe = () => Promise<number | undefined>;

export function statfsProbe(directory: string): DiskProbe {
  return async () => {
    try {
      return usedPercent(await fs.promises.statfs(directory));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };
}
