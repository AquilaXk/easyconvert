import { classifyStorageKey } from './key-namespace';
import type { IStorageBackend } from './oci-storage';
import { getRetentionLedger } from './retention-ledger';
import { resolveCapacityPolicy, statfsProbe, type DiskProbe } from './result-capacity';
import {
  capacityEvictionOrder,
  deferDeletion,
  holdRecord,
  isDeleted,
  isRetainedKey,
  markGone,
  newRecord,
  reasonOf,
  recordServedRange,
  resolveRetentionPolicy,
  type RetentionReason,
  type RetentionRecord,
} from './result-retention';
import { resolveLocalStorageDir } from './storage-config';

/** The part of a storage backend the retention rule needs. */
export interface DeletableStorage {
  deleteObject(key: string): boolean | Promise<boolean>;
}

/** A storage backend the sweep runs on; a `local` one keeps its objects on this host's disk. */
export type SweptStorage = DeletableStorage & Partial<Pick<IStorageBackend, 'kind'>>;

/** A storage backend that can store a result, and remove it again when it cannot be registered. */
export type ResultStorage = Pick<IStorageBackend, 'saveObject' | 'deleteObject'>;

const SWEEP_INTERVAL_MS = 60_000;
/** Results deleted per sweep; a backlog is cleared over the following sweeps. */
const SWEEP_BATCH = 500;
/** Most records one early deletion for space considers; a later sweep continues if the disk is still full. */
const CAPACITY_SCAN_LIMIT = 5_000;
/** What a refused upload is told to wait: one sweep, which deletes results when the disk is full. */
export const STORAGE_FULL_RETRY_AFTER_SECONDS = SWEEP_INTERVAL_MS / 1000;

/**
 * Starts the retention clock of a result that was just stored with `resolveRetentionPolicy().undeliveredTtlMs`
 * as its lifetime. A result is only deleted on schedule when it was registered.
 */
export async function registerResult(key: string): Promise<void> {
  if (!isRetainedKey(key)) return;
  const now = Date.now();
  const policy = resolveRetentionPolicy();
  await getRetentionLedger().update(key, (current) => current ?? newRecord(key, now, policy));
}

/**
 * Registers a result that was just stored. When the record cannot be written the object is removed again, because
 * no sweep would ever find it, and the error is rethrown: the job or request fails instead of leaving a file behind.
 */
export async function registerStoredResult(storage: Pick<IStorageBackend, 'deleteObject'>, key: string): Promise<void> {
  try {
    await registerResult(key);
  } catch (error) {
    try {
      await storage.deleteObject(key);
    } catch (cleanupError) {
      console.warn(`[Retention] Could not remove the unregistered result "${key}":`, cleanupError);
    }
    throw error;
  }
}

/** Stores a result that lives for the undelivered time and registers it, so that the sweep and the download route know it. */
export async function saveRetainedResult(
  storage: ResultStorage,
  key: string,
  buffer: Buffer,
  mimeType: string,
  filename: string
): Promise<void> {
  await storage.saveObject(key, buffer, mimeType, filename, resolveRetentionPolicy().undeliveredTtlMs);
  await registerStoredResult(storage, key);
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

/**
 * The record of a retained result, or undefined when the rule does not cover `key` or the ledger cannot be read.
 * An unreadable ledger leaves the state unknown: the result is served from storage while it is there, and its
 * sweep happens once the ledger is back.
 */
async function readRecord(key: string): Promise<RetentionRecord | undefined> {
  if (!isRetainedKey(key)) return undefined;
  try {
    return await getRetentionLedger().get(key);
  } catch (error) {
    console.warn(`[Retention] Could not read the record of "${key}"; serving it from storage:`, error);
    return undefined;
  }
}

/** The availability of the result stored under `key`; undefined when no record of it can be read. */
export async function resultAvailability(key: string, now: number = Date.now()): Promise<ResultAvailability | undefined> {
  const record = await readRecord(key);
  if (!record) return undefined;
  if (isDeleted(record, now)) return { state: 'deleted', reason: reasonOf(record), deliveredAt: record.deliveredAt };
  return { state: 'available', deleteAt: record.deleteAt, deliveredAt: record.deliveredAt };
}

/** Whether the result stored under `key` was deleted by the retention rule (or must be treated as deleted now). */
export async function isResultDeleted(key: string, now: number = Date.now()): Promise<boolean> {
  const record = await readRecord(key);
  return record !== undefined && isDeleted(record, now);
}

/**
 * Whether a signed download link may be issued for `key`. Never for a result the rule tracks: the bucket would
 * answer the client, so the delivery could not be recorded and the result would not be deleted after it. A job
 * result always is one; a user's conversion is one when it has a record, and is treated as one while the ledger
 * cannot be read.
 */
export async function mayPresignDownload(key: string): Promise<boolean> {
  if (!isRetainedKey(key)) return true;
  if (classifyStorageKey(key).namespace === 'job-result') return false;
  try {
    return (await getRetentionLedger().get(key)) === undefined;
  } catch (error) {
    console.warn(`[Retention] Could not read the record of "${key}"; refusing a signed link for it:`, error);
    return false;
  }
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

/**
 * Keeps a result that a queued job reads as its input for the undelivered time from now: the sweep and an early
 * deletion for space leave it alone until then.
 */
export async function holdResultForJob(key: string, now: number = Date.now()): Promise<void> {
  if (!isRetainedKey(key)) return;
  const until = now + resolveRetentionPolicy().undeliveredTtlMs;
  try {
    await getRetentionLedger().update(key, (current) => current && holdRecord(current, until));
  } catch (error) {
    console.warn(`[Retention] Could not hold "${key}" for the job that reads it; it keeps its own deletion time:`, error);
  }
}

/**
 * Deletes the object of `key` and keeps a record that says it is gone, with `reason` when it went early. Returns
 * whether a record was marked; a key without a record is only taken out of the sweep.
 */
export async function deleteResult(
  storage: DeletableStorage,
  key: string,
  now: number = Date.now(),
  reason?: 'capacity'
): Promise<boolean> {
  await storage.deleteObject(key);
  const ledger = getRetentionLedger();
  const gone = await ledger.update(key, (current) => current && markGone(current, now, reason));
  if (gone) return true;
  await ledger.forget(key);
  return false;
}

/**
 * Deletes every result whose time has passed, and forgets the records of results gone for a day. A delete that
 * fails is reported and tried again after a pause, behind the keys that are due by then, so it cannot block them.
 */
export async function sweepRetention(storage: DeletableStorage, now: number = Date.now()): Promise<number> {
  const ledger = getRetentionLedger();
  let deleted = 0;
  for (const key of await ledger.collectDue(now, SWEEP_BATCH)) {
    try {
      if (await deleteResult(storage, key, now)) deleted++;
    } catch (error) {
      console.warn(`[Retention] Could not delete the result "${key}"; trying again later:`, error);
      await ledger.update(key, (current) => current && deferDeletion(current, now)).catch((deferError: unknown) => {
        console.warn(`[Retention] Could not postpone the deletion of "${key}":`, deferError);
      });
    }
  }
  return deleted;
}

let diskProbeOverride: DiskProbe | undefined;

/** Replaces the measurement of the disk; `undefined` measures the storage directory again. For tests. */
export function setDiskProbe(probe: DiskProbe | undefined): void {
  diskProbeOverride = probe;
}

/** How full the disk of `storage` is; undefined for an object store, which has no fixed size. */
function diskProbeFor(storage: SweptStorage): DiskProbe | undefined {
  if (storage.kind !== 'local') return undefined;
  return diskProbeOverride ?? statfsProbe(resolveLocalStorageDir());
}

/**
 * Deletes results before their time while the disk is above RESULT_DISK_HIGH_PERCENT, in the order of
 * `capacityEvictionOrder`, until it is at or below RESULT_DISK_LOW_PERCENT. Returns how many were deleted.
 */
export async function evictForCapacity(storage: SweptStorage, now: number = Date.now()): Promise<number> {
  const probe = diskProbeFor(storage);
  if (!probe) return 0;
  const policy = resolveCapacityPolicy();
  let used = await probe();
  if (used === undefined || used <= policy.highPercent) return 0;
  const candidates = capacityEvictionOrder(await getRetentionLedger().liveRecords(CAPACITY_SCAN_LIMIT), now);
  let deleted = 0;
  for (const record of candidates) {
    if (used <= policy.lowPercent) break;
    try {
      if (await deleteResult(storage, record.key, now, 'capacity')) {
        deleted++;
        console.warn(`[Retention] Deleted "${record.key}" early: the disk was ${used.toFixed(1)}% full, above ${policy.highPercent}%`);
      }
    } catch (error) {
      console.warn(`[Retention] Could not delete "${record.key}" to free disk space:`, error);
    }
    used = (await probe()) ?? 0;
  }
  if (used > policy.lowPercent) {
    console.warn(`[Retention] The disk is still ${used.toFixed(1)}% full after deleting ${deleted} result(s); nothing else may be deleted`);
  }
  return deleted;
}

let capacityRun: Promise<number> | undefined;

/** One early deletion at a time in this process; a caller that arrives while one runs waits for it. */
function evictForCapacityOnce(storage: SweptStorage): Promise<number> {
  capacityRun ??= evictForCapacity(storage).finally(() => {
    capacityRun = undefined;
  });
  return capacityRun;
}

/**
 * Whether `storage` can take a new upload or conversion. Above RESULT_DISK_REFUSE_PERCENT the early deletion runs
 * first, and the answer is no only when the disk is still above it afterwards. An object store always can.
 */
export async function admitsNewFiles(storage: SweptStorage): Promise<boolean> {
  const probe = diskProbeFor(storage);
  if (!probe) return true;
  const { refusePercent } = resolveCapacityPolicy();
  const used = await probe();
  if (used === undefined || used <= refusePercent) return true;
  await evictForCapacityOnce(storage);
  return ((await probe()) ?? 0) <= refusePercent;
}

let sweepTimer: NodeJS.Timeout | undefined;
let sweepInFlight: Promise<void> | undefined;

/** One sweep: the results whose time has passed, then early deletions while the disk is too full. */
async function runSweep(storage: SweptStorage): Promise<void> {
  await getRetentionLedger().ready();
  await sweepRetention(storage);
  await evictForCapacityOnce(storage);
}

/**
 * Sweeps now, which also cleans what became due while the process was down, and then every minute. Each web
 * instance and each worker runs it; deleting a result twice is harmless. A sweep that is still running when the
 * next one is due is not started twice.
 */
export function startRetentionSweep(storage: SweptStorage): void {
  if (sweepTimer) return;
  const run = (): void => {
    if (sweepInFlight) return;
    sweepInFlight = runSweep(storage)
      .catch((error: unknown) => console.warn('[Retention] Sweep failed:', error))
      .finally(() => {
        sweepInFlight = undefined;
      });
  };
  run();
  sweepTimer = setInterval(run, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

export function stopRetentionSweep(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = undefined;
}
