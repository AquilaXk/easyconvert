import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Redis from 'ioredis';
import { GONE_RECORD_MS, type RetentionRecord } from './result-retention';
import { resolveLocalStorageDir } from './storage-config';

/**
 * Where the retention records of results live, shared by every web instance and worker of a deployment:
 * Redis when REDIS_URL or REDIS_HOST is set (the queue needs it too, so any scaled-out deployment has it), the
 * storage directory otherwise (one host, API and workers sharing EASYCONVERT_STORAGE_DIR). Both survive a
 * restart, so a result whose time has passed is deleted by the next sweep.
 *
 * A change reads the record, applies a pure function and writes it back. Two instances that finish serving the
 * same file in the same instant can lose one range; the file is then counted as delivered a moment later or, at
 * worst, expires after the undelivered time. Neither keeps a file longer than that time.
 */
export interface RetentionLedger {
  get(key: string): Promise<RetentionRecord | undefined>;
  /** Stores what `change` returns for the record of `key` (undefined deletes nothing and stores nothing). */
  update(
    key: string,
    change: (current: RetentionRecord | undefined) => RetentionRecord | undefined
  ): Promise<RetentionRecord | undefined>;
  /** Keys whose object must be deleted by `now`, oldest first. */
  dueKeys(now: number, limit: number): Promise<string[]>;
  /** Removes the records of results deleted longer ago than GONE_RECORD_MS; returns how many. */
  pruneGone(now: number): Promise<number>;
}

const RECORD_SUFFIX = '.json';
const TEMP_SUFFIX = '.tmp';
const TEMP_RANDOM_BYTES = 6;
const LEDGER_DIRECTORY = '.retention';

function isRetentionRecord(value: unknown): value is RetentionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<RetentionRecord>;
  return typeof record.key === 'string' && typeof record.deleteAt === 'number' && Array.isArray(record.received);
}

function parseRecord(raw: string): RetentionRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRetentionRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** One small file per result under `<storage dir>/.retention`, replaced atomically. */
export class FileRetentionLedger implements RetentionLedger {
  private readonly directory: string;

  constructor(storageDir: string = resolveLocalStorageDir()) {
    this.directory = path.join(storageDir, LEDGER_DIRECTORY);
  }

  private pathFor(key: string): string {
    return path.join(this.directory, `${crypto.createHash('sha256').update(key).digest('hex')}${RECORD_SUFFIX}`);
  }

  private async readFile(file: string): Promise<RetentionRecord | undefined> {
    try {
      return parseRecord(await fs.promises.readFile(file, 'utf-8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async get(key: string): Promise<RetentionRecord | undefined> {
    return this.readFile(this.pathFor(key));
  }

  async update(
    key: string,
    change: (current: RetentionRecord | undefined) => RetentionRecord | undefined
  ): Promise<RetentionRecord | undefined> {
    const file = this.pathFor(key);
    const next = change(await this.readFile(file));
    if (!next) return undefined;
    await fs.promises.mkdir(this.directory, { recursive: true });
    const temp = `${file}.${crypto.randomBytes(TEMP_RANDOM_BYTES).toString('hex')}${TEMP_SUFFIX}`;
    await fs.promises.writeFile(temp, JSON.stringify(next), 'utf-8');
    await fs.promises.rename(temp, file);
    return next;
  }

  private async listRecords(): Promise<RetentionRecord[]> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records = await Promise.all(
      names.filter((name) => name.endsWith(RECORD_SUFFIX)).map((name) => this.readFile(path.join(this.directory, name)))
    );
    return records.filter((record): record is RetentionRecord => record !== undefined);
  }

  async dueKeys(now: number, limit: number): Promise<string[]> {
    return (await this.listRecords())
      .filter((record) => record.goneAt === undefined && record.deleteAt <= now)
      .sort((a, b) => a.deleteAt - b.deleteAt)
      .slice(0, limit)
      .map((record) => record.key);
  }

  async pruneGone(now: number): Promise<number> {
    const expired = (await this.listRecords()).filter(
      (record) => record.goneAt !== undefined && record.goneAt + GONE_RECORD_MS <= now
    );
    await Promise.all(expired.map((record) => fs.promises.rm(this.pathFor(record.key), { force: true })));
    return expired.length;
  }
}

const REDIS_RECORD_PREFIX = 'retention:record:';
const REDIS_DUE_SET = 'retention:due';

/** A record per key with a Redis expiry, and a sorted set of the keys still to delete, scored by `deleteAt`. */
export class RedisRetentionLedger implements RetentionLedger {
  constructor(private readonly redis: Redis) {}

  async get(key: string): Promise<RetentionRecord | undefined> {
    const raw = await this.redis.get(`${REDIS_RECORD_PREFIX}${key}`);
    return raw === null ? undefined : parseRecord(raw);
  }

  async update(
    key: string,
    change: (current: RetentionRecord | undefined) => RetentionRecord | undefined
  ): Promise<RetentionRecord | undefined> {
    const next = change(await this.get(key));
    if (!next) return undefined;
    const keepUntil = (next.goneAt ?? next.deleteAt) + GONE_RECORD_MS;
    const pipeline = this.redis.multi();
    pipeline.set(`${REDIS_RECORD_PREFIX}${key}`, JSON.stringify(next), 'PX', Math.max(1, keepUntil - Date.now()));
    if (next.goneAt === undefined) {
      pipeline.zadd(REDIS_DUE_SET, next.deleteAt, key);
    } else {
      pipeline.zrem(REDIS_DUE_SET, key);
    }
    await pipeline.exec();
    return next;
  }

  async dueKeys(now: number, limit: number): Promise<string[]> {
    return this.redis.zrangebyscore(REDIS_DUE_SET, '-inf', now, 'LIMIT', 0, limit);
  }

  /** Redis expires the records itself. */
  async pruneGone(): Promise<number> {
    return 0;
  }
}

let activeLedger: RetentionLedger | undefined;

function createRedis(): Redis {
  const url = process.env.REDIS_URL;
  if (url) return new Redis(url, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
  return new Redis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT || 6379),
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
  });
}

export function getRetentionLedger(): RetentionLedger {
  activeLedger ??= process.env.REDIS_URL || process.env.REDIS_HOST ? new RedisRetentionLedger(createRedis()) : new FileRetentionLedger();
  return activeLedger;
}

/** Replaces the ledger; `undefined` makes the next use select one from the environment. For tests. */
export function setRetentionLedger(ledger: RetentionLedger | undefined): void {
  activeLedger = ledger;
}
