import os from 'node:os';
import { StorageNotFoundError } from './adapters/adapter-interface';
import { classifyStorageKey, isUploadKey } from './key-namespace';
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
  endUploadUse,
  holdRecord,
  isDeleted,
  isHoldableKey,
  isRetainedKey,
  keptUntil,
  markGone,
  newRecord,
  newUploadRecord,
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
export type SweptStorage = DeletableStorage & Partial<Pick<IStorageBackend, 'kind' | 'extendExpiry'>>;

/** A storage backend that can store a result, and remove it again when it cannot be registered. */
export type ResultStorage = Pick<IStorageBackend, 'saveObject' | 'deleteObject'>;

const SWEEP_INTERVAL_MS = 60_000;
/** How long a sweep may run before it is reported as slow; the next one starts only when it ends. */
const SLOW_SWEEP_WARNING_MS = 50_000;
/** Results deleted per sweep; a backlog is cleared over the following sweeps. */
const SWEEP_BATCH = 500;
/**
 * How long one answer to "may new files come in" holds in this process. The answer measures the disk and may run an
 * early deletion, which reads every record; every request in between gets the same answer without either.
 */
export const CAPACITY_CHECK_TTL_MS = 5_000;
/**
 * Deletions of one early-deletion pass after which it stops when the use of the disk is still not lower than when the
 * pass began: whatever fills the disk is not results (uploads, a spool, files still open), and deleting more of them
 * would not free it. A pass is judged as a whole, because one result can free less than a step of the measurement and
 * writes that arrive in between hide the drop of any single deletion.
 */
export const FUTILE_PASS_DELETIONS = 20;
/** Deletions that failed in a row after which an early-deletion pass stops: the store is down or refusing, and each try may take the timeout. */
export const FAILURES_IN_A_ROW = 3;
/**
 * How long after a pass that lowered nothing (no result to delete, every deletion failed, or the use stayed as high)
 * the next early deletion waits, unless the use of the disk moved by FUTILE_USE_CHANGE_PERCENT or more by then.
 * Without it every request and every sweep of every process would read all records and try again for nothing.
 */
export const FUTILE_PAUSE_MS = 5 * 60 * 1000;
const FUTILE_USE_CHANGE_PERCENT = 1;
/**
 * Results in a row whose object was already gone after which an early-deletion pass stops: the records and the store
 * disagree widely (another process is deleting them, or the store was cleared), so the next pass starts from what is
 * left. Each such result is marked gone, which is right for it, but costs a ledger write and a store call for nothing
 * the disk can see. The disk is measured again after each one, because that other process may have freed it.
 */
export const MISSING_IN_A_ROW = 10;
/** How long a measurement of the disk or a deletion in the store may take before it counts as failed. */
export const STORAGE_CALL_TIMEOUT_MS = 30_000;
/** Attempts to reopen a record whose object could not be deleted, with a pause that doubles from REOPEN_BACKOFF_MS. */
const REOPEN_ATTEMPTS = 3;
const REOPEN_BACKOFF_MS = 100;
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
  /** Epoch ms of the record's own deletion time; for an available result. A job that still reads the result postpones the deletion until it ends. */
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

let heldStorage: Pick<IStorageBackend, 'extendExpiry'> | undefined;
let missingExtensionReported = false;

/**
 * Names the storage whose objects a hold keeps alive (see `holdResultForJob`). The web server and the worker bind the
 * one they sweep when they start the sweep; `undefined` unbinds it.
 */
export function bindRetentionStorage(storage: Pick<IStorageBackend, 'extendExpiry'> | undefined): void {
  heldStorage = storage;
  missingExtensionReported = false;
}

/**
 * Raises the lifetime the object under `key` was stored with to `until`, so that the storage does not remove it under
 * the job that holds it. Says so when it could not: the object keeps the lifetime it was stored with, and the
 * record alone keeps the result until then.
 */
async function extendObjectLifetime(key: string, until: number): Promise<void> {
  if (!heldStorage?.extendExpiry) {
    if (!missingExtensionReported) {
      missingExtensionReported = true;
      console.warn('[Retention] No bound storage can extend the lifetime of an object; a held file keeps the lifetime it was stored with');
    }
    return;
  }
  try {
    if (!(await heldStorage.extendExpiry(key, until))) {
      console.warn(`[Retention] Could not extend the lifetime of "${key}" for the job that holds it; it keeps the one it was stored with`);
    }
  } catch (error) {
    console.warn(`[Retention] Could not extend the lifetime of "${key}" for the job that holds it; it keeps the one it was stored with:`, error);
  }
}

/**
 * Holds the file under `key` for the job `holder`, which reads it as its input: an earlier result that the sweep and
 * an early deletion for space leave alone, or an upload that is not deleted while another job may still read it. The
 * hold lasts until `releaseResultHold` or JOB_INPUT_HOLD_MAX_MS, and the object's own lifetime in storage is raised
 * to the end of the hold, so that the storage does not remove it under the job. Returns false when the file was
 * deleted before the hold could be taken, so the job must not be queued. A key the rule does not track, or a ledger
 * that cannot be reached, holds nothing and returns true.
 */
export async function holdResultForJob(key: string, holder: string, now: number = Date.now()): Promise<boolean> {
  if (!isHoldableKey(key)) return true;
  let tracked = false;
  try {
    const held = await getRetentionLedger().update(key, (current) => {
      tracked = current !== undefined;
      const base = current ?? (isUploadKey(key) ? newUploadRecord(key, now) : undefined);
      return base && holdRecord(base, holder, now);
    });
    if (held) await extendObjectLifetime(key, keptUntil(held));
    return held !== undefined || !tracked;
  } catch (error) {
    console.warn(`[Retention] Could not hold "${key}" for the job ${holder}; it keeps its own deletion time:`, error);
    return true;
  }
}

/**
 * Ends the hold of the job `holder` on the file under `key`, because the job ended. An upload that no other job holds
 * is deleted by the sweep after the grace period (`endUploadUse`); an earlier result keeps its own deletion time.
 * Safe to call again or for a key without a hold. An upload that was never held keeps its own lifetime.
 */
export async function releaseResultHold(key: string, holder: string): Promise<void> {
  if (!isHoldableKey(key)) return;
  const policy = resolveRetentionPolicy();
  const now = Date.now();
  await changeHold(key, holder, (current) => (isUploadKey(key) ? endUploadUse(current, holder, now, policy) : releaseHold(current, holder)));
}

/** Gives up the hold of `holder` on `key` without the job having run: the file keeps the deletion time it had. */
async function giveUpHold(key: string, holder: string): Promise<void> {
  if (!isHoldableKey(key)) return;
  await changeHold(key, holder, (current) => releaseHold(current, holder));
}

async function changeHold(key: string, holder: string, change: (current: RetentionRecord) => RetentionRecord | undefined): Promise<void> {
  try {
    await getRetentionLedger().update(key, (current) => current && change(current));
  } catch (error) {
    console.warn(`[Retention] Could not end the hold of the job ${holder} on "${key}"; it ends by itself:`, error);
  }
}

/** The provider named by the not-found error of an input the retention rule deleted before its job was queued. */
const RETENTION_PROVIDER = 'retention';

/**
 * Runs `start`, which queues the job `holder`, while its input `key` is held for it, so that neither the sweep nor an
 * early deletion for space removes a result the job reads, and no other job's end deletes an upload it reads, before
 * it ends (its end calls `releaseResultHold`). When the input was deleted after it was authorized, nothing is queued
 * and a StorageNotFoundError is thrown, which the routes answer like a missing object. A failed `start` gives the
 * hold up again and leaves the file as it was.
 */
export async function withInputHeld<T>(key: string | undefined, holder: string, start: () => Promise<T>): Promise<T> {
  if (key === undefined) return start();
  if (!(await holdResultForJob(key, holder))) throw new StorageNotFoundError(key, RETENTION_PROVIDER);
  try {
    return await start();
  } catch (error) {
    await giveUpHold(key, holder);
    throw error;
  }
}

/**
 * Whether a missing object is worth a warning when its deletion runs: not for a result that expires, whose object
 * leaves storage at the same time through the lifetime it was stored with.
 */
function expectsObject(record: RetentionRecord | undefined, key: string, reason: 'capacity' | undefined): boolean {
  return reason === 'capacity' || isUploadKey(key) || record?.deliveredAt !== undefined;
}

/** `call`, which fails when it takes longer than STORAGE_CALL_TIMEOUT_MS, so that one hung store call cannot stop every deletion of the process. */
function bounded<T>(what: string, call: () => T | Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${STORAGE_CALL_TIMEOUT_MS} ms`)), STORAGE_CALL_TIMEOUT_MS);
    timer.unref();
  });
  return Promise.race([Promise.resolve().then(call), expired]).finally(() => clearTimeout(timer));
}

/** Deletes the object under `key`, warns when there was none although the deletion was due early, and returns whether there was one. */
async function removeObject(storage: DeletableStorage, key: string, expected: boolean): Promise<boolean> {
  const found = await bounded(`Deleting "${key}"`, () => storage.deleteObject(key));
  if (!found && expected) {
    console.warn(`[Retention] Deleting "${key}" found no object`);
  }
  return found;
}

/** Reopens the record of `key` after the deletion of its object failed, again after a pause when the ledger fails too. */
async function reopenAfterDeleteFailure(key: string, now: number): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await getRetentionLedger().update(key, (current) => current && reopenAfterFailedDelete(current, now));
      return;
    } catch (error) {
      if (attempt >= REOPEN_ATTEMPTS) {
        console.warn(`[Retention] Could not reopen "${key}" for a later sweep after its deletion failed; its storage lifetime removes it:`, error);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, REOPEN_BACKOFF_MS * 2 ** (attempt - 1)));
    }
  }
}

/** What a deletion did: removed the object, found its record due but no object, or left everything as it was. */
type DeleteOutcome = 'removed' | 'missing' | 'skipped';

async function deleteRecordedResult(
  storage: DeletableStorage,
  key: string,
  now: number,
  reason: 'capacity' | undefined
): Promise<DeleteOutcome> {
  const ledger = getRetentionLedger();
  const policy = resolveRetentionPolicy();
  const mayDelete = (record: RetentionRecord): boolean =>
    reason === 'capacity' ? isCapacityCandidate(record, now, policy) : record.goneAt === undefined && isDeleted(record, now);
  let tracked: RetentionRecord | undefined;
  const marked = await ledger.update(key, (current) => {
    tracked = current;
    return current && mayDelete(current) ? markGone(current, now, reason) : undefined;
  });
  if (!tracked) {
    await removeObject(storage, key, isUploadKey(key));
    await ledger.forget(key);
    return 'skipped';
  }
  if (!marked) return 'skipped';
  let found: boolean;
  try {
    found = await removeObject(storage, key, expectsObject(tracked, key, reason));
  } catch (error) {
    await reopenAfterDeleteFailure(key, now);
    throw error;
  }
  if (isUploadKey(key)) {
    await ledger.forget(key).catch((forgetError: unknown) => {
      console.warn(`[Retention] Could not forget the record of the deleted upload "${key}":`, forgetError);
    });
  }
  return found ? 'removed' : 'missing';
}

/**
 * Deletes the result under `key` when its record still allows it: for `capacity`, when `isCapacityCandidate` holds;
 * otherwise when it is due. The record is marked gone first, in the same atomic change that checks it, so a job that
 * holds the result in the meantime keeps it. When the object cannot be deleted, the record is reopened for a later
 * sweep, which is tried again if the ledger fails; a process that stops between the mark and the deletion leaves a
 * gone record with its object, which only the lifetime the object was stored with removes. A deleted upload's record
 * is forgotten, because nobody asks for it afterwards. Returns whether this call took the result out of service,
 * also when its object was already gone; a key without a record has its object deleted and leaves the sweep.
 */
export async function deleteResult(
  storage: DeletableStorage,
  key: string,
  now: number = Date.now(),
  reason?: 'capacity'
): Promise<boolean> {
  return (await deleteRecordedResult(storage, key, now, reason)) !== 'skipped';
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

/** The two measurements of a local storage disk: where results live, and that disk together with the temporary directory. */
interface DiskProbes {
  /** The disk that deleting results can free: the only one early deletion looks at. */
  readonly storage: DiskProbe;
  /** The fuller of the storage disk and the temporary disk, where uploads and conversions spool: what admission looks at. */
  readonly admission: DiskProbe;
}

let diskProbeOverride: DiskProbes | undefined;
let admission: { measuredAt: number; admits: Promise<boolean> } | undefined;
let futilePass: { at: number; used: number } | undefined;

/**
 * Replaces the measurement of the disk (and of the admission, when it differs); `undefined` measures the directories
 * again. Forgets the last admission and the last futile pass. For tests.
 */
export function setDiskProbe(probe: DiskProbe | undefined, admissionProbe: DiskProbe | undefined = probe): void {
  diskProbeOverride = probe && admissionProbe ? { storage: probe, admission: admissionProbe } : undefined;
  admission = undefined;
  futilePass = undefined;
}

/** How full the disks of `storage` are; undefined for an object store, which has no fixed size. */
function diskProbesFor(storage: SweptStorage): DiskProbes | undefined {
  if (storage.kind !== 'local') return undefined;
  const storageDir = resolveLocalStorageDir();
  return diskProbeOverride ?? { storage: diskUsageProbe([storageDir]), admission: diskUsageProbe([storageDir, os.tmpdir()]) };
}

/**
 * Deletes results before their time while the disk is above RESULT_DISK_HIGH_PERCENT, in the order of
 * `capacityEvictionOrder`, until it is at or below RESULT_DISK_LOW_PERCENT. Only the disk of the storage directory
 * counts: a full temporary directory is not freed by deleting results. A result that a job claimed in the meantime is
 * skipped. A result whose object is already gone counts as no deletion, but the disk is measured again after it,
 * because the process that removed the object may have freed it. The pass stops when FAILURES_IN_A_ROW deletions
 * failed in a row, when MISSING_IN_A_ROW objects in a row were gone, or when FUTILE_PASS_DELETIONS results are gone
 * and the use is still not lower than at the start. A pass that deleted nothing or lowered nothing pauses early
 * deletion for FUTILE_PAUSE_MS, unless the use moved by then. Returns how many were deleted.
 */
export async function evictForCapacity(storage: SweptStorage, now: number = Date.now()): Promise<number> {
  const probe = diskProbesFor(storage)?.storage;
  if (!probe) return 0;
  const measure = (): Promise<number | undefined> => bounded('Measuring the disk', probe);
  const capacity = resolveCapacityPolicy();
  const startUsed = await measure();
  if (startUsed === undefined) return 0;
  if (startUsed <= capacity.highPercent) {
    futilePass = undefined;
    return 0;
  }
  if (futilePass && now - futilePass.at < FUTILE_PAUSE_MS && Math.abs(startUsed - futilePass.used) < FUTILE_USE_CHANGE_PERCENT) return 0;
  futilePass = undefined;
  const candidates = capacityEvictionOrder(await getRetentionLedger().liveRecords(), now, resolveRetentionPolicy());
  let used = startUsed;
  let deleted = 0;
  let failedInARow = 0;
  let missingInARow = 0;
  for (const record of candidates) {
    if (used <= capacity.lowPercent || failedInARow >= FAILURES_IN_A_ROW || missingInARow >= MISSING_IN_A_ROW) break;
    if (deleted >= FUTILE_PASS_DELETIONS && used >= startUsed) break;
    let outcome: DeleteOutcome;
    try {
      outcome = await deleteRecordedResult(storage, record.key, now, 'capacity');
      failedInARow = 0;
    } catch (error) {
      failedInARow++;
      console.warn(`[Retention] Could not delete "${record.key}" to free disk space:`, error);
      continue;
    }
    if (outcome === 'skipped') continue;
    if (outcome === 'removed') {
      deleted++;
      missingInARow = 0;
      console.warn(`[Retention] Deleted "${record.key}" early: the disk was ${used.toFixed(1)}% full, above ${capacity.highPercent}%`);
    } else {
      missingInARow++;
    }
    const after = await measure();
    if (after === undefined) return deleted;
    used = after;
  }
  // A run of records whose object was already gone marked them gone, so the next pass starts past them: no pause for it.
  // Space freed by another process (no deletion here, use lower) is not futile either.
  if (used >= startUsed && missingInARow < MISSING_IN_A_ROW) {
    futilePass = { at: now, used };
    console.warn(
      `[Retention] Stopped deleting results early: ${deleted} deleted and the disk is ${used.toFixed(1)}% full, not lower than the ${startUsed.toFixed(1)}% it began at`
    );
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
    const used = await bounded('Measuring the disk', probe);
    if (used === undefined || used <= refusePercent) return true;
    await evictForCapacityOnce(storage);
    const after = await bounded('Measuring the disk', probe);
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
  const probe = diskProbesFor(storage)?.admission;
  if (!probe) return Promise.resolve(true);
  const now = Date.now();
  if (!admission || now - admission.measuredAt >= CAPACITY_CHECK_TTL_MS) {
    admission = { measuredAt: now, admits: measureAdmission(storage, probe) };
  }
  return admission.admits;
}

let sweepTimer: NodeJS.Timeout | undefined;
let sweepInFlight: Promise<void> | undefined;

/** One sweep: the results whose time has passed, then early deletions while the disk is too full. Warns once when it runs long. */
function runSweep(storage: SweptStorage): Promise<void> {
  const slow = setTimeout(() => {
    console.warn(`[Retention] The sweep has run for ${SLOW_SWEEP_WARNING_MS} ms; the next one starts when it ends`);
  }, SLOW_SWEEP_WARNING_MS);
  slow.unref();
  return (async () => {
    await sweepRetention(storage);
    await evictForCapacityOnce(storage);
  })().finally(() => clearTimeout(slow));
}

/**
 * Sweeps now, which also cleans what became due while the process was down, and then every minute. Each web
 * instance and each worker runs it; deleting a result twice is harmless. A sweep that is still running when the
 * next one is due is not started twice.
 */
export function startRetentionSweep(storage: SweptStorage): void {
  if (sweepTimer) return;
  bindRetentionStorage(storage);
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
