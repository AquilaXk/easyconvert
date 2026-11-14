import type { Redis } from 'ioredis';
import { compareAndSetWithRetry } from '../redis/compare-and-set';
import type { Plan } from '../plan-limits';
import type { UploadBudgetRecord } from './anonymous-upload-budget';

/**
 * Where the byte budgets of callers live (docs/policy-decisions.md, entries 15 and 137), for the uploads and link imports
 * of anonymous address buckets and the link imports of accounts: in Redis beside the quota counters, or in this process
 * when the quota store has no Redis. A record is written whole: Redis takes it with a compare-and-set, and this process
 * changes it between two awaits, so concurrent requests never lose a change.
 */

/** Where the reservation of an upload session is: its bucket (an address, or an account's open uploads) and its entry there, and the plan whose policy governs it (absent: anonymous). */
export interface ReservationRef {
  bucket: string;
  reservation: string;
  plan?: Plan;
}

export interface BudgetStore {
  read(bucket: string): Promise<UploadBudgetRecord | undefined>;
  update(bucket: string, change: (current: UploadBudgetRecord | undefined) => UploadBudgetRecord | undefined): Promise<void>;
  link(uploadId: string, ref: ReservationRef, expiresAt: number): Promise<void>;
  lookup(uploadId: string): Promise<ReservationRef | undefined>;
  unlink?(uploadId: string, bucket?: string): Promise<void>;
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

  delete(key: string): void {
    this.entries.delete(key);
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

  async read(bucket: string): Promise<UploadBudgetRecord | undefined> {
    return this.records.get(bucket, Date.now());
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

  async unlink(uploadId: string): Promise<void> {
    this.links.delete(uploadId);
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

  private bucketLinksKey(bucket: string): string {
    return `${this.prefix}upload-budget-links:{${bucket}}`;
  }

  async read(bucket: string): Promise<UploadBudgetRecord | undefined> {
    return parseRecord(await this.redis.get(this.recordKey(bucket)));
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
    const ttlMs = Math.max(1, expiresAt - Date.now());
    await this.redis.set(this.linkKey(uploadId), JSON.stringify(ref), 'PX', ttlMs);
    const linksClient = this.redis as unknown as Partial<{
      sadd(key: string, ...members: string[]): Promise<number>;
      pexpire(key: string, ms: number): Promise<number>;
    }>;
    if (typeof linksClient.sadd === 'function') {
      const linksKey = this.bucketLinksKey(ref.bucket);
      await linksClient.sadd(linksKey, uploadId);
      if (typeof linksClient.pexpire === 'function') {
        await linksClient.pexpire(linksKey, Math.max(ttlMs, RECORD_TTL_MS));
      }
    }
  }

  async lookup(uploadId: string): Promise<ReservationRef | undefined> {
    const raw = await this.redis.get(this.linkKey(uploadId));
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as ReservationRef;
    return typeof parsed.bucket === 'string' && typeof parsed.reservation === 'string' ? parsed : undefined;
  }

  async unlink(uploadId: string, bucket?: string): Promise<void> {
    const linksClient = this.redis as unknown as Partial<{
      del(...keys: string[]): Promise<number>;
      srem(key: string, ...members: string[]): Promise<number>;
    }>;
    if (typeof linksClient.del === 'function') {
      await linksClient.del(this.linkKey(uploadId));
    }
    if (bucket && typeof linksClient.srem === 'function') {
      await linksClient.srem(this.bucketLinksKey(bucket), uploadId);
    }
  }
}
