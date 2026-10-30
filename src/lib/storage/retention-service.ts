import { getRetentionLedger } from './retention-ledger';
import {
  isDeleted,
  isRetainedKey,
  markGone,
  newRecord,
  reasonOf,
  recordServedRange,
  resolveRetentionPolicy,
  type RetentionReason,
} from './result-retention';

/** The part of a storage backend the retention rule needs. */
export interface DeletableStorage {
  deleteObject(key: string): boolean | Promise<boolean>;
}

const SWEEP_INTERVAL_MS = 60_000;
/** Results deleted per sweep; a backlog is cleared over the following sweeps. */
const SWEEP_BATCH = 500;

/** Starts the retention clock of a result that was just stored with `resolveRetentionPolicy().undeliveredTtlMs`. */
export async function registerResult(key: string): Promise<void> {
  if (!isRetainedKey(key)) return;
  const now = Date.now();
  const policy = resolveRetentionPolicy();
  await getRetentionLedger().update(key, (current) => current ?? newRecord(key, now, policy));
}

/** What a client can be told about a result: the job API reports it next to the result. */
export interface ResultAvailability {
  state: 'available' | 'deleted';
  /** Epoch ms after which the result is deleted; for an available result. */
  deleteAt?: number;
  deliveredAt?: number;
  /** Why a deleted result is gone. */
  reason?: RetentionReason;
}

/** The availability of the result stored under `key`; undefined when the retention rule keeps no record of it. */
export async function resultAvailability(key: string, now: number = Date.now()): Promise<ResultAvailability | undefined> {
  const record = await getRetentionLedger().get(key);
  if (!record) return undefined;
  if (isDeleted(record, now)) return { state: 'deleted', reason: reasonOf(record), deliveredAt: record.deliveredAt };
  return { state: 'available', deleteAt: record.deleteAt, deliveredAt: record.deliveredAt };
}

/** Whether the result stored under `key` was deleted by the retention rule (or must be treated as deleted now). */
export async function isResultDeleted(key: string, now: number = Date.now()): Promise<boolean> {
  const record = await getRetentionLedger().get(key);
  return record !== undefined && isDeleted(record, now);
}

/**
 * Records that bytes `[first, last]` of the result under `key` (of `size` bytes) were sent completely. The first
 * time the sent ranges cover the whole file, the result is delivered and its grace period starts.
 */
export async function recordServed(key: string, range: { first: number; last: number; size: number }): Promise<void> {
  if (!isRetainedKey(key)) return;
  const now = Date.now();
  const policy = resolveRetentionPolicy();
  await getRetentionLedger().update(key, (current) => recordServedRange(current ?? newRecord(key, now, policy), range, now, policy));
}

/** Deletes the object of `key` and keeps a record that says it is gone. */
export async function deleteResult(storage: DeletableStorage, key: string, now: number = Date.now()): Promise<void> {
  await storage.deleteObject(key);
  await getRetentionLedger().update(key, (current) => current && markGone(current, now));
}

/**
 * Deletes every result whose time has passed, and forgets the records of results gone for a day. One failing
 * delete is reported and retried by the next sweep; it does not stop the others.
 */
export async function sweepRetention(storage: DeletableStorage, now: number = Date.now()): Promise<number> {
  const ledger = getRetentionLedger();
  let deleted = 0;
  for (const key of await ledger.dueKeys(now, SWEEP_BATCH)) {
    try {
      await deleteResult(storage, key, now);
      deleted++;
    } catch (error) {
      console.warn(`[Retention] Could not delete the result "${key}"; the next sweep tries again:`, error);
    }
  }
  await ledger.pruneGone(now);
  return deleted;
}

let sweepTimer: NodeJS.Timeout | undefined;

/**
 * Sweeps now, which also cleans what became due while the process was down, and then every minute. Each web
 * instance and each worker runs it; deleting a result twice is harmless.
 */
export function startRetentionSweep(storage: DeletableStorage): void {
  if (sweepTimer) return;
  const run = (): void => {
    sweepRetention(storage).catch((error: unknown) => console.warn('[Retention] Sweep failed:', error));
  };
  run();
  sweepTimer = setInterval(run, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

export function stopRetentionSweep(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = undefined;
}
