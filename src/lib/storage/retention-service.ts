import os from 'node:os';
import { StorageNotFoundError } from './adapters/adapter-interface';
import { classifyStorageKey } from './key-namespace';
import type { IStorageBackend } from './oci-storage';
import { getRetentionLedger } from './retention-ledger';
import {
  capacityEvictionOrder,
  diskUsageProbe,
  isCapacityCandidate,
  resolveCapacityPolicy,
  type DiskProbe,
} from './result-capacity';
import {
  holdRecord,
  isDeleted,
  isRetainedKey,
  markGone,
  newRecord,
  reasonOf,
  recordServedRange,
  releaseHold,
  reopenAfterFailedDelete,
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
/** Longest one sweep may take before the next one may start; every ledger command has its own shorter timeout. */
const SWEEP_TIMEOUT_MS = 50_000;
/** Results deleted per sweep; a backlog is cleared over the following sweeps. */
const SWEEP_BATCH = 500;
/**
 * How long one answer to "may new files come in" holds in this process. The answer measures the disk and may run an
 * early deletion, which reads every record; every request in between gets the same answer without either.
 */
export const CAPACITY_CHECK_TTL_MS = 5_000;
/**
 * Deletions in a row that did not lower the use of the disk after which an early deletion stops: whatever fills
 * the disk is not results (uploads, a spool, files still open), and deleting more results would not free it.
 */
const MAX_FUTILE_DELETIONS = 3;
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
 * Holds the result under `key` for the job `holder`, which reads it as its input: the sweep and an early deletion
 * for space leave it alone until `releaseResultHold` or JOB_INPUT_HOLD_MAX_MS. Returns false when the result was
 * deleted before the hold could be taken, so the job must not be queued. A key the rule does not track, or a ledger
 * that cannot be reached, holds nothing and returns true.
 */
export async function holdResultForJob(key: string, holder: string, now: number = Date.now()): Promise<boolean> {
  if (!isRetainedKey(key)) return true;
  let tracked = false;
  try {
    const held = await getRetentionLedger().update(key, (current) => {
      tracked = current !== undefined;
      return current && holdRecord(current, holder, now);
    });
    return held !== undefined || !tracked;
  } catch (error) {
    console.warn(`[Retention] Could not hold "${key}" for the job ${holder}; it keeps its own deletion time:`, error);
    return true;
  }
}

/** Ends the hold of the job `holder` on the result under `key`, when it ended. Safe to call again or for a key without one. */
export async function releaseResultHold(key: string, holder: string): Promise<void> {
  if (!isRetainedKey(key)) return;
  try {
    await getRetentionLedger().update(key, (current) => current && releaseHold(current, holder));
  } catch (error) {
    console.warn(`[Retention] Could not end the hold of the job ${holder} on "${key}"; it ends by itself:`, error);
  }
}

/** The provider named by the not-found error of an input the retention rule deleted before its job was queued. */
const RETENTION_PROVIDER = 'retention';

/**
 * Runs `start`, which queues the job `holder`, while its input `key` is held for it, so that neither the sweep nor an
 * early deletion for space removes a result the job reads before it ends (its end calls `releaseResultHold`). When
 * the input was deleted after it was authorized, nothing is queued and a StorageNotFoundError is thrown, which the
 * routes answer like a missing object. A failed `start` gives the hold up again.
 */
export async function withInputHeld<T>(key: string | undefined, holder: string, start: () => Promise<T>): Promise<T> {
  if (key === undefined) return start();
  if (!(await holdResultForJob(key, holder))) throw new StorageNotFoundError(key, RETENTION_PROVIDER);
  try {
    return await start();
  } catch (error) {
    await releaseResultHold(key, holder);
    throw error;
  }
}

/**
 * Deletes the result under `key` when its record still allows it: for `capacity`, when `isCapacityCandidate` holds;
 * otherwise when it is due. The record is marked gone first, in the same atomic change that checks it, so a job that
 * holds the result in the meantime keeps it. When the object cannot be deleted, the record is reopened for a later
 * sweep. Returns whether this call deleted it; a key without a record has its object deleted and leaves the sweep.
 */
export async function deleteResult(
  storage: DeletableStorage,
  key: string,
  now: number = Date.now(),
  reason?: 'capacity'
): Promise<boolean> {
  const ledger = getRetentionLedger();
  const policy = resolveRetentionPolicy();
  const mayDelete = (record: RetentionRecord): boolean =>
    reason === 'capacity' ? isCapacityCandidate(record, now, policy) : record.goneAt === undefined && isDeleted(record, now);
  let tracked = false;
  const marked = await ledger.update(key, (current) => {
    tracked = current !== undefined;
    return current && mayDelete(current) ? markGone(current, now, reason) : undefined;
  });
  if (!tracked) {
    await storage.deleteObject(key);
    await ledger.forget(key);
    return false;
  }
  if (!marked) return false;
  try {
    await storage.deleteObject(key);
  } catch (error) {
    await ledger.update(key, (current) => current && reopenAfterFailedDelete(current, now)).catch((reopenError: unknown) => {
      console.warn(`[Retention] Could not reopen "${key}" for a later sweep after its deletion failed:`, reopenError);
    });
    throw error;
  }
  return true;
}

/**
 * Deletes every result whose time has passed, and forgets the records of results gone for a day. A delete that
 * fails is reported and tried again after a pause, behind the keys that are due by then, so it cannot block them.
 */
export async function sweepRetention(storage: DeletableStorage, now: number = Date.now()): Promise<number> {
  let deleted = 0;
  for (const key of await getRetentionLedger().collectDue(now, SWEEP_BATCH)) {
    try {
      if (await deleteResult(storage, key, now)) deleted++;
    } catch (error) {
      console.warn(`[Retention] Could not delete the result "${key}"; trying again later:`, error);
    }
  }
  return deleted;
}

let diskProbeOverride: DiskProbe | undefined;
let admission: { measuredAt: number; admits: Promise<boolean> } | undefined;

/** Replaces the measurement of the disk; `undefined` measures the directories again. Forgets the last admission. For tests. */
export function setDiskProbe(probe: DiskProbe | undefined): void {
  diskProbeOverride = probe;
  admission = undefined;
}

/** How full the disks of `storage` and of the temporary files are; undefined for an object store, which has no fixed size. */
function diskProbeFor(storage: SweptStorage): DiskProbe | undefined {
  if (storage.kind !== 'local') return undefined;
  return diskProbeOverride ?? diskUsageProbe([resolveLocalStorageDir(), os.tmpdir()]);
}

/**
 * Deletes results before their time while the disk is above RESULT_DISK_HIGH_PERCENT, in the order of
 * `capacityEvictionOrder`, until it is at or below RESULT_DISK_LOW_PERCENT or MAX_FUTILE_DELETIONS deletions in a
 * row did not lower it. Returns how many were deleted.
 */
export async function evictForCapacity(storage: SweptStorage, now: number = Date.now()): Promise<number> {
  const probe = diskProbeFor(storage);
  if (!probe) return 0;
  const capacity = resolveCapacityPolicy();
  let used = await probe();
  if (used === undefined || used <= capacity.highPercent) return 0;
  const candidates = capacityEvictionOrder(await getRetentionLedger().liveRecords(), now, resolveRetentionPolicy());
  let deleted = 0;
  let futile = 0;
  for (const record of candidates) {
    if (used <= capacity.lowPercent || futile >= MAX_FUTILE_DELETIONS) break;
    try {
      if (!(await deleteResult(storage, record.key, now, 'capacity'))) continue;
    } catch (error) {
      console.warn(`[Retention] Could not delete "${record.key}" to free disk space:`, error);
      continue;
    }
    deleted++;
    console.warn(`[Retention] Deleted "${record.key}" early: the disk was ${used.toFixed(1)}% full, above ${capacity.highPercent}%`);
    const after = await probe();
    if (after === undefined) break;
    futile = after < used ? 0 : futile + 1;
    used = after;
  }
  if (futile >= MAX_FUTILE_DELETIONS) {
    console.warn(`[Retention] Stopped deleting results early: ${futile} deletions in a row did not lower the use of the disk (${used.toFixed(1)}%)`);
  } else if (used > capacity.lowPercent) {
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
 * Above RESULT_DISK_REFUSE_PERCENT the early deletion runs first, and the answer is no only when the disk is still
 * above it afterwards. A disk that cannot be measured, or an early deletion that fails, lets the files in: only a
 * full disk that the deletion ran on refuses.
 */
async function measureAdmission(storage: SweptStorage, probe: DiskProbe): Promise<boolean> {
  try {
    const { refusePercent } = resolveCapacityPolicy();
    const used = await probe();
    if (used === undefined || used <= refusePercent) return true;
    await evictForCapacityOnce(storage);
    const after = await probe();
    return after === undefined || after <= refusePercent;
  } catch (error) {
    console.warn('[Retention] Could not measure the disk or delete results to free it; new files are let in:', error);
    return true;
  }
}

/**
 * Whether `storage` can take a new upload or conversion (see `measureAdmission`). The answer is measured at most
 * once per CAPACITY_CHECK_TTL_MS in this process. An object store always can.
 */
export function admitsNewFiles(storage: SweptStorage): Promise<boolean> {
  const probe = diskProbeFor(storage);
  if (!probe) return Promise.resolve(true);
  const now = Date.now();
  if (!admission || now - admission.measuredAt >= CAPACITY_CHECK_TTL_MS) {
    admission = { measuredAt: now, admits: measureAdmission(storage, probe) };
  }
  return admission.admits;
}

let sweepTimer: NodeJS.Timeout | undefined;
let sweepInFlight: Promise<void> | undefined;

/** One sweep: the results whose time has passed, then early deletions while the disk is too full. Rejects after SWEEP_TIMEOUT_MS. */
function runSweep(storage: SweptStorage): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`The sweep took longer than ${SWEEP_TIMEOUT_MS} ms`)), SWEEP_TIMEOUT_MS);
    timer.unref();
  });
  const sweep = (async () => {
    await sweepRetention(storage);
    await evictForCapacityOnce(storage);
  })();
  return Promise.race([sweep, timeout]).finally(() => clearTimeout(timer));
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
