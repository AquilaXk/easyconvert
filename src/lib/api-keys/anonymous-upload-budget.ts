import crypto from 'node:crypto';
import { isAnonymousUserId, isUnattributedAnonymous } from '../auth/anonymous-identity';
import { formatBytes } from '../format-bytes';
import { PLAN_NAME, maxFileBytes, type Plan } from '../plan-limits';
import { getUtcDateKey } from './key-store';
import { redisKeyStore } from './redis-key-store';
import { MemoryBudgetStore, RedisBudgetStore, type BudgetStore } from './upload-budget-store';

/**
 * What a caller may bring onto the server each UTC day (docs/policy-decisions.md, entries 15 and 137). An anonymous
 * address bucket has at most ANONYMOUS_OPEN_UPLOADS_MAX upload sessions open at once, and ANONYMOUS_DAILY_UPLOAD_BYTES
 * for its uploads in parts and link imports together. An account has `dailyBudgetBytes` of its plan for link imports;
 * its uploads are not metered here, because each one opens only while the account has a conversion left and a job
 * slot. The declared size of an upload is reserved when the session opens, returned when it is aborted or its session
 * expires, and kept when it completes. A link import starts only while its day has bytes left, and the bytes it receives
 * are charged as they arrive, in batches of at most LINK_IMPORT_METER_BATCH_BYTES, so it stops once the day passes its
 * budget.
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
/**
 * The most bytes a link import receives before it charges them to its day, and so the most one running import can take its
 * day past the budget before it stops. The rule is rclone's `--max-transfer` accounting (MIT, commit f0cb5dd6): a transfer
 * is admitted while the running total is under the limit (`fs/operations/copy.go` lines 118 to 135), and one in flight stops
 * once the total passes it (`fs/accounting/accounting.go` lines 248 to 281). rclone keeps its total in memory and checks it
 * on every 1 MiB read; this total is a record in a shared store written by compare-and-set, so it is written once per batch.
 */
export const LINK_IMPORT_METER_BATCH_BYTES = 4 * 1024 * 1024;

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

/**
 * Why the byte budget refuses: too many uploads open at once, or the bytes of the day used already by what was received and
 * what open uploads reserved. A link import is refused only for the second.
 */
export type UploadRefusal = 'open-uploads' | 'daily-bytes';

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
): { record: UploadBudgetRecord } | { refusal: UploadRefusal } {
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
): { record: UploadBudgetRecord } | { refusal: UploadRefusal } {
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
 * `withLinkImportMeter`, and its uploads are bounded by its conversions and job slots.
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
): Promise<{ reservation: UploadReservation } | { refusal: UploadRefusal }> {
  if (!isMetered(callerUserId)) return { reservation: UNMETERED };
  const store = activeStore();
  const bucket = callerUserId;
  const id = crypto.randomBytes(RESERVATION_ID_BYTES).toString('hex');
  let refusal: UploadRefusal | undefined;
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
export async function resumeUploadReservation(uploadId: string): Promise<UploadRefusal | undefined> {
  let refusal: UploadRefusal | undefined;
  await changeReservation(uploadId, (record, id) => {
    const resumed = resumeUpload(record, id, Date.now());
    refusal = 'refusal' in resumed ? resumed.refusal : undefined;
    return 'refusal' in resumed ? undefined : resumed.record;
  });
  return refusal;
}

/** The record on `day` at `now` with `bytes` a link import received charged to it. */
export function chargeImport(record: UploadBudgetRecord | undefined, charge: { bytes: number; day: string; now: number }): UploadBudgetRecord {
  const current = currentRecord(record, charge.day, charge.now);
  return { ...current, bytes: current.bytes + charge.bytes };
}

/** A header value that is a length: decimal digits only, as RFC 9110 writes `Content-Length`, and a safe integer. */
const CONTENT_LENGTH = /^\d+$/;

/**
 * The length of the body a response declares, or undefined when it declares none the bytes read can be compared with. A
 * `Content-Length` counts the bytes as sent, so a body sent with a `Content-Encoding` other than `identity` declares its
 * compressed length, while the reader receives it decoded.
 */
export function declaredBodyBytes(headers: { get(name: string): string | null }): number | undefined {
  const encoding = headers.get('content-encoding')?.trim().toLowerCase();
  if (encoding && encoding !== 'identity') return undefined;
  const header = headers.get('content-length')?.trim();
  if (!header || !CONTENT_LENGTH.test(header)) return undefined;
  const length = Number(header);
  return Number.isSafeInteger(length) ? length : undefined;
}

/** Why a declared length is refused before a byte is read: past the import's read limit, or past what its day has left. */
export type DeclaredOverflow = { kind: 'too-large' } | { kind: 'larger-than-left'; leftBytes: number };

/** The refusal of a body that declares `declaredBytes`, by the read limit first and then by the day; undefined when it fits. */
export function declaredOverflow(declaredBytes: number | undefined, limits: { limitBytes: number; leftBytes: number }): DeclaredOverflow | undefined {
  if (declaredBytes === undefined) return undefined;
  if (declaredBytes > limits.limitBytes) return { kind: 'too-large' };
  if (declaredBytes > limits.leftBytes) return { kind: 'larger-than-left', leftBytes: limits.leftBytes };
  return undefined;
}

/** The bytes a link import running under its day's budget received, charged to the day as they arrive. */
export interface LinkImportMeter {
  /** What the owner's day had left when the import started: a declared length past it is refused before reading. */
  readonly leftBytes: number;
  /** The bytes received so far, charged or not. */
  readonly receivedBytes: number;
  /**
   * Counts `bytes` just received, and charges the batch once it holds LINK_IMPORT_METER_BATCH_BYTES. Answers false once the
   * day has passed its budget, so the import stops reading.
   */
  count(bytes: number): Promise<boolean>;
  /** Charges what is counted and not charged yet. Answers false when the day has then passed its budget. */
  charge(): Promise<boolean>;
}

/** A link import: whose day it charges, and on which plan. */
export interface LinkImportRequest {
  owner: string;
  plan: Plan;
}

/** The meter of a link import of `owner` whose day had `leftBytes` left of `dailyBytes`, charging `store`. */
function linkImportMeter(store: BudgetStore, owner: string, dailyBytes: number, leftBytes: number): LinkImportMeter {
  let receivedBytes = 0;
  let unchargedBytes = 0;
  const charge = async (): Promise<boolean> => {
    if (unchargedBytes === 0) return true;
    const bytes = unchargedBytes;
    unchargedBytes = 0;
    let dayBytes = 0;
    await store.update(owner, (current) => {
      const charged = chargeImport(current, { bytes, day: getUtcDateKey(), now: Date.now() });
      dayBytes = charged.bytes;
      return charged;
    });
    return dayBytes <= dailyBytes;
  };
  return {
    leftBytes,
    get receivedBytes() {
      return receivedBytes;
    },
    count: async (bytes) => {
      receivedBytes += bytes;
      unchargedBytes += bytes;
      return unchargedBytes >= LINK_IMPORT_METER_BATCH_BYTES ? charge() : true;
    },
    charge,
  };
}

/**
 * Runs `run` as a link import of `request.owner`, metered against the day's bytes of `request.plan`: refused as
 * `daily-bytes` before it starts when the day has nothing left, and charged what it received however it ends. A charge
 * that fails at the end is logged and never replaces the outcome of `run`.
 */
export async function withLinkImportMeter<T>(
  request: LinkImportRequest,
  run: (meter: LinkImportMeter) => Promise<T>
): Promise<{ result: T } | { refusal: 'daily-bytes' }> {
  const store = activeStore();
  const dailyBytes = dailyBudgetBytes(request.plan);
  let leftBytes = 0;
  await store.update(request.owner, (current) => {
    leftBytes = dailyBytes - currentRecord(current, getUtcDateKey(), Date.now()).bytes;
    return undefined;
  });
  if (leftBytes <= 0) return { refusal: 'daily-bytes' };
  const meter = linkImportMeter(store, request.owner, dailyBytes, leftBytes);
  try {
    return { result: await run(meter) };
  } finally {
    await meter.charge().catch((err: unknown) => {
      console.error(`[UploadBudget] The last bytes of a link import that received ${meter.receivedBytes} could not be charged to the daily budget:`, err);
    });
  }
}

/** The English sentence of a refusal of the budget of a caller of `plan`: what it may bring in, and when it may again. */
export function budgetRefusalDetail(refusal: UploadRefusal, plan: Plan): string {
  if (refusal === 'open-uploads') {
    return `Up to ${ANONYMOUS_OPEN_UPLOADS_MAX} uploads may be open at once without an account. Finish or cancel one, then try again.`;
  }
  return `${dailyAllowance(plan)} The limit resets at midnight UTC.`;
}

/** What a caller of `plan` may bring in each day, as the sentence of a refusal names it. */
function dailyAllowance(plan: Plan): string {
  const limit = formatBytes(dailyBudgetBytes(plan));
  return plan === 'anonymous'
    ? `Without an account, uploads and link imports may total ${limit} a day.`
    : `On the ${PLAN_NAME[plan]} plan, link imports may total ${limit} a day.`;
}

/** The English sentence of a link import stopped because the day of a caller of `plan` passed its budget while it read. */
export function dailyLimitReachedDetail(plan: Plan): string {
  return `${dailyAllowance(plan)} That limit was reached while this file was being read. The limit resets at midnight UTC.`;
}

/** The English sentence of a file larger than the `leftBytes` the day has left for link imports. */
export function largerThanLeftDetail(leftBytes: number): string {
  return `This file is larger than the ${formatBytes(leftBytes)} left today for link imports. The limit resets at midnight UTC.`;
}

/**
 * The bytes `callerUserId` has brought in today, open uploads included. Only the tests read it:
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
