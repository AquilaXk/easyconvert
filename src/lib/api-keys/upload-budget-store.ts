import type { Redis } from 'ioredis';
import { compareAndSetWithRetry } from '../redis/compare-and-set';
import type { UploadBudgetRecord } from './anonymous-upload-budget';

/**
 * Where the upload budgets of anonymous address buckets live (docs/policy-decisions.md, entry 137): in Redis beside the
 * quota counters, or in this process when the quota store has no Redis. A record is written whole: Redis takes it with
 * a compare-and-set, and this process changes it between two awaits, so concurrent requests never lose a change.
 */

/** Where the reservation of an upload session is: its address bucket and its entry there. */
export interface ReservationRef {
  bucket: string;
  reservation: string;
}

export interface BudgetStore {
  update(bucket: string, change: (current: UploadBudgetRecord | undefined) => UploadBudgetRecord | undefined): Promise<void>;
  link(uploadId: string, ref: ReservationRef, expiresAt: number): Promise<void>;
  lookup(uploadId: string): Promise<ReservationRef | undefined>;
}

/** A record outlives its last change by two days, so a new day is never read from an old record. */
export const RECORD_TTL_MS = 2 * 24 * 60 * 60 * 1000;
/** How often this process drops the records and links whose time has passed; reading one also drops it. */
const MEMORY_SWEEP_INTERVAL_MS = 60 * 1000;

interface Expiring<T> {
  value: T;
  expiresAt: number;
}

/** A map whose entries go when their time has passed: on a read of the entry, and in a sweep at most once a minute. */
class ExpiringMap<T> {
  private readonly entries = new Map<string, Expiring<T>>();
  private nextSweepAt = 0;

  get size(): number {
    return this.entries.size;
  }

  get(key: string, now: number): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt > now) return entry.value;
    this.entries.delete(key);
    return undefined;
  }

  set(key: string, value: T, expiresAt: number, now: number): void {
    this.entries.set(key, { value, expiresAt });
    if (now < this.nextSweepAt) return;
    this.nextSweepAt = now + MEMORY_SWEEP_INTERVAL_MS;
    for (const [entryKey, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(entryKey);
    }
  }
}

/** The budgets of one process, for a deployment without Redis. */
export class MemoryBudgetStore implements BudgetStore {
  private readonly records = new ExpiringMap<UploadBudgetRecord>();
  private readonly links = new ExpiringMap<ReservationRef>();

  /** The records and links held now, those past their time but not swept yet included. */
  get size(): number {
    return this.records.size + this.links.size;
  }

  async update(bucket: string, change: (current: UploadBudgetRecord | undefined) => UploadBudgetRecord | undefined): Promise<void> {
    const now = Date.now();
    const next = change(this.records.get(bucket, now));
    if (next) this.records.set(bucket, next, now + RECORD_TTL_MS, now);
  }

  async link(uploadId: string, ref: ReservationRef, expiresAt: number): Promise<void> {
    this.links.set(uploadId, ref, expiresAt, Date.now());
  }

  async lookup(uploadId: string): Promise<ReservationRef | undefined> {
    return this.links.get(uploadId, Date.now());
  }
}

const MAX_UPDATE_ATTEMPTS = 8;

const COMPARE_AND_SET_LUA = `
local current = redis.call('GET', KEYS[1])
if current == false then current = '' end
if current ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1
`;

function parseRecord(raw: string | null): UploadBudgetRecord | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as UploadBudgetRecord;
    return typeof parsed.day === 'string' && typeof parsed.bytes === 'number' && typeof parsed.open === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The budgets every web instance shares, beside the quota counters. */
export class RedisBudgetStore implements BudgetStore {
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
    await compareAndSetWithRetry<undefined>(
      async () => {
        const raw = await this.redis.get(key);
        const next = change(parseRecord(raw));
        if (!next) return { written: undefined };
        const written = await this.redis.eval(COMPARE_AND_SET_LUA, 1, key, raw ?? '', JSON.stringify(next), String(RECORD_TTL_MS));
        return written === 1 ? { written: undefined } : 'conflict';
      },
      { maxAttempts: MAX_UPDATE_ATTEMPTS, subject: 'The upload budget of a bucket' }
    );
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
