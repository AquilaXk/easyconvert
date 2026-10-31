import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import { isAnonymousUserId, isUnattributedAnonymous } from '../auth/anonymous-identity';
import { getUtcDateKey } from './key-store';
import { redisKeyStore } from './redis-key-store';

/**
 * What one anonymous address bucket may write through uploads in parts (docs/policy-decisions.md, entry 137): at most
 * ANONYMOUS_OPEN_UPLOADS_MAX sessions open at once, and at most ANONYMOUS_DAILY_UPLOAD_BYTES declared per UTC day. The
 * declared size is reserved when the session opens, returned when it is aborted or its session expires, and kept when
 * it completes. Accounts are not metered here; their plan and quota already bound them.
 *
 * The state of a bucket is one record changed by the pure functions below and written whole with a compare-and-set,
 * in Redis beside the quota counters, or in this process when the quota store has no Redis.
 */

const GIB = 1024 * 1024 * 1024;

export const ANONYMOUS_OPEN_UPLOADS_MAX = 2;
export const ANONYMOUS_DAILY_UPLOAD_BYTES = 2 * GIB;
/** An open session that received no part for this long stops counting as open; its bytes stay reserved until it expires. */
export const OPEN_UPLOAD_IDLE_MS = 60 * 60 * 1000;

const RESERVATION_ID_BYTES = 12;
const MAX_UPDATE_ATTEMPTS = 8;

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

/** Reserves `bytes` for a new session `id`, or names the bound it would pass. */
export function reserveUpload(
  record: UploadBudgetRecord | undefined,
  request: { id: string; bytes: number; day: string; now: number; expiresAt: number },
  policy: BudgetPolicy = POLICY
): { record: UploadBudgetRecord } | { refusal: BudgetRefusal } {
  const current = currentRecord(record, request.day, request.now);
  const open = Object.values(current.open).filter((entry) => entry.idleUntil > request.now).length;
  if (open >= policy.maxOpenUploads) return { refusal: 'open-uploads' };
  if (current.bytes + request.bytes > policy.dailyBytes) return { refusal: 'daily-bytes' };
  const entry: OpenUpload = {
    bytes: request.bytes,
    day: request.day,
    idleUntil: Math.min(request.now + policy.idleMs, request.expiresAt),
    expiresAt: request.expiresAt,
  };
  return { record: { ...current, bytes: current.bytes + request.bytes, open: { ...current.open, [request.id]: entry } } };
}

/** The record after a part of session `id` arrived at `now`: it counts as open again for the idle time. */
export function touchUpload(record: UploadBudgetRecord, id: string, now: number, policy: BudgetPolicy = POLICY): UploadBudgetRecord {
  const entry = record.open[id];
  if (!entry) return record;
  return { ...record, open: { ...record.open, [id]: { ...entry, idleUntil: Math.min(now + policy.idleMs, entry.expiresAt) } } };
}

/** The record once session `id` ended: completed (its bytes stay charged) or aborted (they are returned). */
export function closeUpload(record: UploadBudgetRecord, id: string, outcome: 'completed' | 'aborted'): UploadBudgetRecord {
  return withoutUpload(record, id, outcome === 'aborted');
}

/** Where the reservation of an upload session is: its address bucket and its entry there. */
interface ReservationRef {
  bucket: string;
  reservation: string;
}

interface BudgetStore {
  update(bucket: string, change: (current: UploadBudgetRecord | undefined) => UploadBudgetRecord | undefined): Promise<void>;
  link(uploadId: string, ref: ReservationRef, expiresAt: number): Promise<void>;
  lookup(uploadId: string): Promise<ReservationRef | undefined>;
}

class MemoryBudgetStore implements BudgetStore {
  private readonly records = new Map<string, UploadBudgetRecord>();
  private readonly links = new Map<string, { ref: ReservationRef; expiresAt: number }>();

  async update(bucket: string, change: (current: UploadBudgetRecord | undefined) => UploadBudgetRecord | undefined): Promise<void> {
    const next = change(this.records.get(bucket));
    if (next) this.records.set(bucket, next);
  }

  async link(uploadId: string, ref: ReservationRef, expiresAt: number): Promise<void> {
    this.links.set(uploadId, { ref, expiresAt });
  }

  async lookup(uploadId: string): Promise<ReservationRef | undefined> {
    const linked = this.links.get(uploadId);
    if (!linked) return undefined;
    if (linked.expiresAt > Date.now()) return linked.ref;
    this.links.delete(uploadId);
    return undefined;
  }
}

const COMPARE_AND_SET_LUA = `
local current = redis.call('GET', KEYS[1])
if current == false then current = '' end
if current ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1
`;

/** A record outlives its last session by a day, so a new day is never read from an old record. */
const RECORD_TTL_MS = 2 * 24 * 60 * 60 * 1000;

function parseRecord(raw: string | null): UploadBudgetRecord | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as UploadBudgetRecord;
    return typeof parsed.day === 'string' && typeof parsed.bytes === 'number' && typeof parsed.open === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

class RedisBudgetStore implements BudgetStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string
  ) {}

  private recordKey(bucket: string): string {
    return `${this.prefix}upload-budget:{${bucket}}`;
  }

  private linkKey(uploadId: string): string {
    return `${this.prefix}upload-budget-link:${uploadId}`;
  }

  async update(bucket: string, change: (current: UploadBudgetRecord | undefined) => UploadBudgetRecord | undefined): Promise<void> {
    const key = this.recordKey(bucket);
    for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt++) {
      const raw = await this.redis.get(key);
      const next = change(parseRecord(raw));
      if (!next) return;
      const written = await this.redis.eval(COMPARE_AND_SET_LUA, 1, key, raw ?? '', JSON.stringify(next), String(RECORD_TTL_MS));
      if (written === 1) return;
    }
    throw new Error(`The upload budget of a bucket changed ${MAX_UPDATE_ATTEMPTS} times while it was being updated`);
  }

  async link(uploadId: string, ref: ReservationRef, expiresAt: number): Promise<void> {
    await this.redis.set(this.linkKey(uploadId), JSON.stringify(ref), 'PX', Math.max(1, expiresAt - Date.now()));
  }

  async lookup(uploadId: string): Promise<ReservationRef | undefined> {
    const raw = await this.redis.get(this.linkKey(uploadId));
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as ReservationRef;
    return typeof parsed.bucket === 'string' && typeof parsed.reservation === 'string' ? parsed : undefined;
  }
}

let memoryStore = new MemoryBudgetStore();

function activeStore(): BudgetStore {
  const redis = redisKeyStore.getRedisClient();
  return redis ? new RedisBudgetStore(redis, redisKeyStore.getPrefix()) : memoryStore;
}

/** Forgets every budget kept in this process. For tests. */
export function resetAnonymousUploadBudget(): void {
  memoryStore = new MemoryBudgetStore();
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

async function changeReservation(uploadId: string, change: (record: UploadBudgetRecord, id: string) => UploadBudgetRecord): Promise<void> {
  const store = activeStore();
  const ref = await store.lookup(uploadId);
  if (!ref) return;
  await store.update(ref.bucket, (current) => current && change(current, ref.reservation));
}

/** Notes that a part of the session `uploadId` arrived, which keeps it counted as open. A session that is not metered is left alone. */
export function noteUploadActivity(uploadId: string): Promise<void> {
  return changeReservation(uploadId, (record, id) => touchUpload(record, id, Date.now()));
}

/** Ends the reservation of the session `uploadId`: completed keeps its bytes charged, aborted returns them. */
export function endUploadReservation(uploadId: string, outcome: 'completed' | 'aborted'): Promise<void> {
  return changeReservation(uploadId, (record, id) => closeUpload(record, id, outcome));
}
