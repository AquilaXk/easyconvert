import crypto from 'node:crypto';
import { isAnonymousUserId, isUnattributedAnonymous } from '../auth/anonymous-identity';
import { URL_IMPORT_MAX_BYTES, maxFileBytes, type Plan } from '../plan-limits';
import { getUtcDateKey } from './key-store';
import { redisKeyStore } from './redis-key-store';
import { MemoryBudgetStore, RedisBudgetStore, type BudgetStore } from './upload-budget-store';

/**
 * What a caller may bring onto the server each UTC day (docs/policy-decisions.md, entries 15 and 137). An anonymous
 * address bucket has at most ANONYMOUS_OPEN_UPLOADS_MAX upload sessions open at once, and ANONYMOUS_DAILY_UPLOAD_BYTES
 * for its uploads in parts and link imports together. An account has `dailyBudgetBytes` of its plan for link imports;
 * its uploads are not metered here, because each one opens only while the account has a conversion left and a job
 * slot. The declared size of an upload is reserved when the session opens, returned when it is aborted or its session
 * expires, and kept when it completes. A link import holds what it may still read (the import limit, or the bytes left
 * that day when fewer) when it starts, and is charged the bytes it received once it has ended.
 *
 * The state of a bucket is one record changed by the pure functions below and written whole by its store
 * (upload-budget-store.ts): in Redis beside the quota counters, or in this process when the quota store has no Redis.
 */

/** Files at the plan's file size limit a caller may bring in each day: two, the size entry 137 gave the anonymous budget. */
const DAILY_FILES_AT_PLAN_LIMIT = 2;

/** The bytes a caller of `plan` may bring in each UTC day: two files at the plan's limit (2 GiB free, 10 GiB Pro, 20 GiB Enterprise). */
export function dailyBudgetBytes(plan: Plan): number {
  return DAILY_FILES_AT_PLAN_LIMIT * maxFileBytes(plan);
}

export const ANONYMOUS_OPEN_UPLOADS_MAX = 2;
export const ANONYMOUS_DAILY_UPLOAD_BYTES = dailyBudgetBytes('anonymous');
/** An open session that received no part for this long stops counting as open; its bytes stay reserved until it expires. */
export const OPEN_UPLOAD_IDLE_MS = 60 * 60 * 1000;
/** How long the hold of a link import outlives the import's deadline: a cut-off import stops reading within it. */
export const LINK_IMPORT_HOLD_GRACE_MS = 60 * 1000;

const RESERVATION_ID_BYTES = 12;

interface OpenUpload {
  bytes: number;
  /** The UTC day the bytes were charged to; they are returned only to that day. */
  day: string;
  idleUntil: number;
  expiresAt: number;
}

export interface UploadBudgetRecord {
  day: string;
  bytes: number;
  open: Record<string, OpenUpload>;
}

export type BudgetRefusal = 'open-uploads' | 'daily-bytes';

interface BudgetPolicy {
  maxOpenUploads: number;
  dailyBytes: number;
  idleMs: number;
}

const POLICY: BudgetPolicy = {
  maxOpenUploads: ANONYMOUS_OPEN_UPLOADS_MAX,
  dailyBytes: ANONYMOUS_DAILY_UPLOAD_BYTES,
  idleMs: OPEN_UPLOAD_IDLE_MS,
};

function emptyRecord(day: string): UploadBudgetRecord {
  return { day, bytes: 0, open: {} };
}

/** The record without the bytes of `id`, returned to the day when they were charged to it. */
function withoutUpload(record: UploadBudgetRecord, id: string, refund: boolean): UploadBudgetRecord {
  const entry = record.open[id];
  if (!entry) return record;
  const open = { ...record.open };
  delete open[id];
  const returned = refund && entry.day === record.day ? entry.bytes : 0;
  return { ...record, bytes: Math.max(0, record.bytes - returned), open };
}

/** The record on `day` at `now`: a new day starts at zero bytes, and sessions past their expiry return their bytes. */
function currentRecord(record: UploadBudgetRecord | undefined, day: string, now: number): UploadBudgetRecord {
  let current = record && record.day === day ? record : { ...emptyRecord(day), open: record?.open ?? {} };
  for (const [id, entry] of Object.entries(current.open)) {
    if (entry.expiresAt <= now) current = withoutUpload(current, id, true);
  }
  return current;
}

/** The sessions of `record` that count as open at `now`: those that received a part within the idle time. */
function openCount(record: UploadBudgetRecord, now: number): number {
  return Object.values(record.open).filter((entry) => entry.idleUntil > now).length;
}

/** Reserves `bytes` for a new session `id`, or names the bound it would pass. */
export function reserveUpload(
  record: UploadBudgetRecord | undefined,
  request: { id: string; bytes: number; day: string; now: number; expiresAt: number },
  policy: BudgetPolicy = POLICY
): { record: UploadBudgetRecord } | { refusal: BudgetRefusal } {
  const current = currentRecord(record, request.day, request.now);
  if (openCount(current, request.now) >= policy.maxOpenUploads) return { refusal: 'open-uploads' };
  if (current.bytes + request.bytes > policy.dailyBytes) return { refusal: 'daily-bytes' };
  const entry: OpenUpload = {
    bytes: request.bytes,
    day: request.day,
    idleUntil: Math.min(request.now + policy.idleMs, request.expiresAt),
    expiresAt: request.expiresAt,
  };
  return { record: { ...current, bytes: current.bytes + request.bytes, open: { ...current.open, [request.id]: entry } } };
}

/**
 * The record after a part of session `id` arrived at `now`: it counts as open again for the idle time. A session that
 * went idle is opened again only while fewer than the most open sessions are open, else the part is refused.
 */
export function resumeUpload(
  record: UploadBudgetRecord,
  id: string,
  now: number,
  policy: BudgetPolicy = POLICY
): { record: UploadBudgetRecord } | { refusal: BudgetRefusal } {
  const entry = record.open[id];
  if (!entry) return { record };
  if (entry.idleUntil <= now && openCount(record, now) >= policy.maxOpenUploads) return { refusal: 'open-uploads' };
  return { record: { ...record, open: { ...record.open, [id]: { ...entry, idleUntil: Math.min(now + policy.idleMs, entry.expiresAt) } } } };
}

/** The record once session `id` ended: completed (its bytes stay charged) or aborted (they are returned). */
export function closeUpload(record: UploadBudgetRecord, id: string, outcome: 'completed' | 'aborted'): UploadBudgetRecord {
  return withoutUpload(record, id, outcome === 'aborted');
}

const memoryStore = new MemoryBudgetStore();

function activeStore(): BudgetStore {
  const redis = redisKeyStore.getRedisClient();
  return redis ? new RedisBudgetStore(redis, redisKeyStore.getPrefix()) : memoryStore;
}

/**
 * Whether uploads of `callerUserId` are metered: an anonymous caller attributed to an address. The shared identity of
 * unattributed callers is refused uploads and link imports before it gets here; an account's link imports are metered by
 * `reserveLinkImport`, and its uploads are bounded by its conversions and job slots.
 */
function isMetered(callerUserId: string): boolean {
  return isAnonymousUserId(callerUserId) && !isUnattributedAnonymous(callerUserId);
}

/** A reservation taken before the session exists; `bind` names the session it holds, `release` gives it up. */
export interface UploadReservation {
  bind(uploadId: string, expiresAt: number): Promise<void>;
  release(): Promise<void>;
}

const UNMETERED: UploadReservation = { bind: async () => undefined, release: async () => undefined };

/**
 * Reserves the declared `bytes` of a new session of `callerUserId`, or names the bound it would pass. The entry counts
 * until `provisionalExpiresAt` until the session is bound with its own expiry.
 */
export async function reserveAnonymousUpload(
  callerUserId: string,
  bytes: number,
  provisionalExpiresAt: number
): Promise<{ reservation: UploadReservation } | { refusal: BudgetRefusal }> {
  if (!isMetered(callerUserId)) return { reservation: UNMETERED };
  const store = activeStore();
  const bucket = callerUserId;
  const id = crypto.randomBytes(RESERVATION_ID_BYTES).toString('hex');
  let refusal: BudgetRefusal | undefined;
  await store.update(bucket, (current) => {
    const now = Date.now();
    const result = reserveUpload(current, { id, bytes, day: getUtcDateKey(), now, expiresAt: provisionalExpiresAt });
    if ('refusal' in result) {
      refusal = result.refusal;
      return undefined;
    }
    refusal = undefined;
    return result.record;
  });
  if (refusal) return { refusal };
  return {
    reservation: {
      bind: async (uploadId, expiresAt) => {
        await store.update(bucket, (current) => {
          const entry = current?.open[id];
          return entry && current ? { ...current, open: { ...current.open, [id]: { ...entry, expiresAt, idleUntil: Math.min(entry.idleUntil, expiresAt) } } } : undefined;
        });
        await store.link(uploadId, { bucket, reservation: id }, expiresAt);
      },
      release: () => store.update(bucket, (current) => current && closeUpload(current, id, 'aborted')),
    },
  };
}

/** Applies `change` to the reservation of the session `uploadId`; undefined from `change` writes nothing. */
async function changeReservation(
  uploadId: string,
  change: (record: UploadBudgetRecord, id: string) => UploadBudgetRecord | undefined
): Promise<void> {
  const store = activeStore();
  const ref = await store.lookup(uploadId);
  if (!ref) return;
  await store.update(ref.bucket, (current) => current && change(current, ref.reservation));
}

/**
 * Notes that a part of the session `uploadId` is arriving, which keeps it counted as open, or names the bound that
 * refuses it: an idle session past the most open ones. A session that is not metered is left alone.
 */
export async function resumeUploadReservation(uploadId: string): Promise<BudgetRefusal | undefined> {
  let refusal: BudgetRefusal | undefined;
  await changeReservation(uploadId, (record, id) => {
    const resumed = resumeUpload(record, id, Date.now());
    refusal = 'refusal' in resumed ? resumed.refusal : undefined;
    return 'refusal' in resumed ? undefined : resumed.record;
  });
  return refusal;
}

/**
 * Holds `bytes` of the day for link import `id` until `expiresAt`. A hold never counts as an open upload: it is idle from
 * the start, since the import holds a conversion slot instead.
 */
export function holdImport(
  record: UploadBudgetRecord | undefined,
  hold: { id: string; bytes: number; day: string; now: number; expiresAt: number }
): UploadBudgetRecord {
  const current = currentRecord(record, hold.day, hold.now);
  const entry: OpenUpload = { bytes: hold.bytes, day: hold.day, idleUntil: hold.now, expiresAt: hold.expiresAt };
  return { ...current, bytes: current.bytes + hold.bytes, open: { ...current.open, [hold.id]: entry } };
}

/**
 * The record on `day` once link import `id` ended having received `receivedBytes`, whether it succeeded, was too large,
 * failed or was cut off: its hold goes back to the day it was charged to, and the bytes received are charged to `day`,
 * also when the hold expired or was charged to an earlier day.
 */
export function settleImport(
  record: UploadBudgetRecord | undefined,
  settled: { id: string; receivedBytes: number; day: string; now: number }
): UploadBudgetRecord {
  const released = withoutUpload(currentRecord(record, settled.day, settled.now), settled.id, true);
  return { ...released, bytes: released.bytes + settled.receivedBytes };
}

/** A link import's hold on the day's bytes, taken when it starts. */
export interface LinkImportReservation {
  /** Charges the bytes the import received in place of its hold, once it has ended; a second settle changes nothing. */
  settle(receivedBytes: number): Promise<void>;
}

/**
 * Takes the hold of a link import of `callerUserId` on the day's bytes of `plan`: the import limit, or the bytes left
 * when fewer, so imports running at once cannot pass the budget together. Refused once the day has no byte left. The
 * hold lasts the import's `deadlineMs` and LINK_IMPORT_HOLD_GRACE_MS more; one whose process died returns its bytes then.
 */
export async function reserveLinkImport(
  callerUserId: string,
  plan: Plan,
  deadlineMs: number
): Promise<{ reservation: LinkImportReservation } | { refusal: BudgetRefusal }> {
  const store = activeStore();
  const id = crypto.randomBytes(RESERVATION_ID_BYTES).toString('hex');
  let refusal: BudgetRefusal | undefined;
  await store.update(callerUserId, (current) => {
    const now = Date.now();
    const day = getUtcDateKey();
    const left = dailyBudgetBytes(plan) - currentRecord(current, day, now).bytes;
    refusal = left > 0 ? undefined : 'daily-bytes';
    if (refusal) return undefined;
    return holdImport(current, { id, bytes: Math.min(URL_IMPORT_MAX_BYTES, left), day, now, expiresAt: now + deadlineMs + LINK_IMPORT_HOLD_GRACE_MS });
  });
  if (refusal) return { refusal };
  let settled = false;
  return {
    reservation: {
      settle: async (receivedBytes) => {
        if (settled) return;
        settled = true;
        await store.update(callerUserId, (current) => settleImport(current, { id, receivedBytes, day: getUtcDateKey(), now: Date.now() }));
      },
    },
  };
}

/**
 * The bytes `callerUserId` has brought in today, holds of link imports still running included. Only the tests read it:
 * the record is written whole by its store, so this is the one read that shows what a bucket was charged.
 */
export async function bytesBroughtInToday(callerUserId: string): Promise<number> {
  let bytes = 0;
  await activeStore().update(callerUserId, (current) => {
    bytes = currentRecord(current, getUtcDateKey(), Date.now()).bytes;
    return undefined;
  });
  return bytes;
}

/** Ends the reservation of the session `uploadId`: completed keeps its bytes charged, aborted returns them. */
export function endUploadReservation(uploadId: string, outcome: 'completed' | 'aborted'): Promise<void> {
  return changeReservation(uploadId, (record, id) => closeUpload(record, id, outcome));
}
