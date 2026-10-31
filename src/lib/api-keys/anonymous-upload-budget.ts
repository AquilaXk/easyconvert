import crypto from 'node:crypto';
import { isAnonymousUserId, isUnattributedAnonymous } from '../auth/anonymous-identity';
import { getUtcDateKey } from './key-store';
import { redisKeyStore } from './redis-key-store';
import { MemoryBudgetStore, RedisBudgetStore, type BudgetStore } from './upload-budget-store';

/**
 * What one anonymous address bucket may write through uploads in parts (docs/policy-decisions.md, entry 137): at most
 * ANONYMOUS_OPEN_UPLOADS_MAX sessions open at once, and at most ANONYMOUS_DAILY_UPLOAD_BYTES declared per UTC day. The
 * declared size is reserved when the session opens, returned when it is aborted or its session expires, and kept when
 * it completes. Accounts are not metered here; their plan and quota already bound them.
 *
 * The state of a bucket is one record changed by the pure functions below and written whole by its store
 * (upload-budget-store.ts): in Redis beside the quota counters, or in this process when the quota store has no Redis.
 */

const GIB = 1024 * 1024 * 1024;

export const ANONYMOUS_OPEN_UPLOADS_MAX = 2;
export const ANONYMOUS_DAILY_UPLOAD_BYTES = 2 * GIB;
/** An open session that received no part for this long stops counting as open; its bytes stay reserved until it expires. */
export const OPEN_UPLOAD_IDLE_MS = 60 * 60 * 1000;

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

/** Whether uploads of `callerUserId` are metered: an anonymous caller attributed to an address. */
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

/** Ends the reservation of the session `uploadId`: completed keeps its bytes charged, aborted returns them. */
export function endUploadReservation(uploadId: string, outcome: 'completed' | 'aborted'): Promise<void> {
  return changeReservation(uploadId, (record, id) => closeUpload(record, id, outcome));
}
