import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Redis from 'ioredis';
import { mapWithConcurrency } from '../conversions/ocr-page-batch';
import { GONE_RECORD_MS, isSweepDue, sweepAt, type RetentionRecord } from './result-retention';
import { resolveLocalStorageDir } from './storage-config';

/**
 * Where the retention records of results live, shared by every web instance and worker of a deployment:
 * Redis when REDIS_URL or REDIS_HOST is set (the queue needs it too, so any scaled-out deployment has it), the
 * storage directory otherwise (one host, API and workers sharing EASYCONVERT_STORAGE_DIR). Both survive a
 * restart, so a result whose time has passed is deleted by the next sweep.
 *
 * A change reads the record, applies a pure function and writes the result atomically: two instances that serve
 * the same file at once both keep their ranges.
 */
export interface RetentionLedger {
  get(key: string): Promise<RetentionRecord | undefined>;
  /** Stores what `change` returns for the record of `key` (undefined stores nothing). Atomic per key. */
  update(
    key: string,
    change: (current: RetentionRecord | undefined) => RetentionRecord | undefined
  ): Promise<RetentionRecord | undefined>;
  /** Removes the record of `key` and its place in the sweep. */
  forget(key: string): Promise<void>;
  /**
   * One pass of the sweep: the keys whose object must be deleted by `now`, oldest first, at most `limit`. The same
   * pass forgets records of results deleted longer ago than GONE_RECORD_MS and leftovers of interrupted writes.
   */
  collectDue(now: number, limit: number): Promise<string[]>;
  /**
   * Every record of a result not deleted yet, for early deletion when the disk runs full. All of them: the order of
   * that deletion is not the order of either store, so a limit taken first would pick the wrong results.
   */
  liveRecords(): Promise<RetentionRecord[]>;
}

const RECORD_SUFFIX = '.json';
const TEMP_SUFFIX = '.tmp';
const LOCK_SUFFIX = '.lock';
const TEMP_RANDOM_BYTES = 6;
const LEDGER_DIRECTORY = '.retention';
/** Record files read at once by a scan of the file ledger. */
const SCAN_CONCURRENCY = 32;
/** A temporary file or lock older than this was left by a process that stopped mid-write. */
const LEFTOVER_AGE_MS = 60 * 60 * 1000;
/** A lock held longer than this belongs to a process that stopped; an update takes milliseconds. */
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 10;
const LOCK_WAIT_MS = 10_000;

const randomSuffix = (): string => crypto.randomBytes(TEMP_RANDOM_BYTES).toString('hex');

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

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function isGoneLongAgo(record: RetentionRecord, now: number): boolean {
  return record.goneAt !== undefined && record.goneAt + GONE_RECORD_MS <= now;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs the work for one key after the work queued before it for the same key, in this process. */
class KeyedSerializer {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(work, work);
    const tail = result.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

/**
 * One small file per result under `<storage dir>/.retention`, replaced atomically. An update holds a lock file
 * next to the record, so the web server and the workers sharing the directory never interleave on one record.
 */
export class FileRetentionLedger implements RetentionLedger {
  private readonly directory: string;
  private readonly serializer = new KeyedSerializer();

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
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
  }

  async get(key: string): Promise<RetentionRecord | undefined> {
    return this.readFile(this.pathFor(key));
  }

  /** Takes the lock file `lock`, which holds a token of this holder, and returns the token. */
  private async acquireLock(lock: string): Promise<string> {
    const token = randomSuffix();
    const giveUpAt = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        await fs.promises.writeFile(lock, token, { flag: 'wx' });
        return token;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
      const stat = await fs.promises.stat(lock).catch(() => undefined);
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await this.breakStaleLock(lock);
        continue;
      }
      if (Date.now() > giveUpAt) throw new Error(`Timed out after ${LOCK_WAIT_MS} ms waiting for a retention record lock`);
      await delay(LOCK_RETRY_MS);
    }
  }

  /**
   * Moves a lock left by a holder that stopped out of the way. The rename is atomic, so of several writers that found
   * it stale one moves it; when what it moved turns out to be a lock taken just now, it is put back unless another
   * writer took the lock meanwhile.
   */
  private async breakStaleLock(lock: string): Promise<void> {
    const moved = `${lock}.${randomSuffix()}${TEMP_SUFFIX}`;
    try {
      await fs.promises.rename(lock, moved);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw error;
    }
    const stat = await fs.promises.stat(moved);
    if (Date.now() - stat.mtimeMs <= LOCK_STALE_MS) await fs.promises.link(moved, lock).catch(() => undefined);
    await fs.promises.rm(moved, { force: true });
  }

  /** Removes `lock` only while it still holds `token`: a lock broken as stale may belong to another writer by now. */
  private async releaseLock(lock: string, token: string): Promise<void> {
    const holder = await fs.promises.readFile(lock, 'utf-8').catch(() => undefined);
    if (holder === token) await fs.promises.rm(lock, { force: true });
  }

  private async withLock<T>(key: string, work: (file: string) => Promise<T>): Promise<T> {
    return this.serializer.run(key, async () => {
      const file = this.pathFor(key);
      await fs.promises.mkdir(this.directory, { recursive: true });
      const lock = `${file}${LOCK_SUFFIX}`;
      const token = await this.acquireLock(lock);
      try {
        return await work(file);
      } finally {
        await this.releaseLock(lock, token);
      }
    });
  }

  async update(
    key: string,
    change: (current: RetentionRecord | undefined) => RetentionRecord | undefined
  ): Promise<RetentionRecord | undefined> {
    return this.withLock(key, async (file) => {
      const next = change(await this.readFile(file));
      if (!next) return undefined;
      const temp = `${file}.${randomSuffix()}${TEMP_SUFFIX}`;
      await fs.promises.writeFile(temp, JSON.stringify(next), 'utf-8');
      await fs.promises.rename(temp, file);
      return next;
    });
  }

  async forget(key: string): Promise<void> {
    await this.withLock(key, (file) => fs.promises.rm(file, { force: true }));
  }

  private async listNames(): Promise<string[]> {
    try {
      return await fs.promises.readdir(this.directory);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
  }

  private async scan(): Promise<{ records: RetentionRecord[]; leftovers: string[] }> {
    const names = await this.listNames();
    const records = await mapWithConcurrency(
      names.filter((name) => name.endsWith(RECORD_SUFFIX)),
      SCAN_CONCURRENCY,
      (name) => this.readFile(path.join(this.directory, name))
    );
    return {
      records: records.filter((record): record is RetentionRecord => record !== undefined),
      leftovers: names.filter((name) => name.endsWith(TEMP_SUFFIX) || name.endsWith(LOCK_SUFFIX)),
    };
  }

  private async removeOldLeftovers(names: readonly string[], now: number): Promise<void> {
    await mapWithConcurrency(names, SCAN_CONCURRENCY, async (name) => {
      const file = path.join(this.directory, name);
      const stat = await fs.promises.stat(file).catch(() => undefined);
      if (stat && now - stat.mtimeMs > LEFTOVER_AGE_MS) await fs.promises.rm(file, { force: true });
    });
  }

  async collectDue(now: number, limit: number): Promise<string[]> {
    const { records, leftovers } = await this.scan();
    await mapWithConcurrency(
      records.filter((record) => isGoneLongAgo(record, now)),
      SCAN_CONCURRENCY,
      (record) => fs.promises.rm(this.pathFor(record.key), { force: true })
    );
    await this.removeOldLeftovers(leftovers, now);
    return records
      .filter((record) => isSweepDue(record, now))
      .sort((a, b) => sweepAt(a) - sweepAt(b))
      .slice(0, limit)
      .map((record) => record.key);
  }

  async liveRecords(): Promise<RetentionRecord[]> {
    const { records } = await this.scan();
    return records.filter((record) => record.goneAt === undefined);
  }
}

/** Namespace of the retention keys in a Redis that the queue and the key store share. */
export const RETENTION_REDIS_PREFIX = 'easyconvert:retention:';
const REDIS_RECORD_PREFIX = `${RETENTION_REDIS_PREFIX}record:`;
const REDIS_DUE_SET = `${RETENTION_REDIS_PREFIX}due`;
/** Attempts of a compare-and-set before an update gives up; each failed one means another instance just wrote. */
const MAX_UPDATE_ATTEMPTS = 16;
/** A failed compare-and-set waits a random time up to this base doubled per attempt, so racing writers spread out. */
const CAS_BACKOFF_BASE_MS = 2;
const CAS_BACKOFF_MAX_MS = 100;
const MGET_BATCH = 100;
/** Longest a ledger operation waits for the connection; ioredis's first reconnect attempts fall inside it. */
const CONNECT_WAIT_MS = 2_000;
/** After a wait for the connection ran out, operations fail at once for this long instead of each waiting again. */
const UNREACHABLE_HOLD_MS = 5_000;
/** Longest one Redis command may take; a command that hangs fails instead of stopping the sweep. */
const REDIS_COMMAND_TIMEOUT_MS = 5_000;

/**
 * Writes a record only when it still holds what the caller read (`ARGV[1]`, empty for none), and keeps the due set
 * in step: `ARGV[4]` is the due score, empty to leave the set.
 */
const COMPARE_AND_SET_LUA = `
local current = redis.call('GET', KEYS[1])
if current == false then current = '' end
if current ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
if ARGV[4] == '' then
  redis.call('ZREM', KEYS[2], ARGV[5])
else
  redis.call('ZADD', KEYS[2], ARGV[4], ARGV[5])
end
return 1
`;

/** A record per key with a Redis expiry, and a sorted set of the keys still to delete, scored by when the sweep takes them. */
export class RedisRetentionLedger implements RetentionLedger {
  private connectionWait: Promise<void> | undefined;
  private unreachableUntil = 0;

  constructor(private readonly redis: Redis) {}

  /**
   * Resolves when the connection is ready, or after CONNECT_WAIT_MS. The client has no offline queue, so a command
   * sent before then fails at once; this lets the first commands after a start wait for the connection. All callers
   * share one wait, and once a wait ran out the next ones for UNREACHABLE_HOLD_MS do not wait, so an outage fails
   * every call quickly.
   */
  private whenConnected(): Promise<void> {
    if (this.redis.status === 'ready' || Date.now() < this.unreachableUntil) return Promise.resolve();
    this.connectionWait ??= new Promise<void>((resolve) => {
      const finish = (connected: boolean): void => {
        clearTimeout(timer);
        this.redis.off('ready', onReady);
        this.connectionWait = undefined;
        if (!connected) this.unreachableUntil = Date.now() + UNREACHABLE_HOLD_MS;
        resolve();
      };
      const onReady = (): void => finish(true);
      const timer = setTimeout(() => finish(false), CONNECT_WAIT_MS);
      this.redis.once('ready', onReady);
    });
    return this.connectionWait;
  }

  private recordKey(key: string): string {
    return `${REDIS_RECORD_PREFIX}${key}`;
  }

  async get(key: string): Promise<RetentionRecord | undefined> {
    await this.whenConnected();
    const raw = await this.redis.get(this.recordKey(key));
    return raw === null ? undefined : parseRecord(raw);
  }

  async update(
    key: string,
    change: (current: RetentionRecord | undefined) => RetentionRecord | undefined
  ): Promise<RetentionRecord | undefined> {
    await this.whenConnected();
    for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt++) {
      const raw = await this.redis.get(this.recordKey(key));
      const next = change(raw === null ? undefined : parseRecord(raw));
      if (!next) return undefined;
      const keepUntil = (next.goneAt ?? sweepAt(next)) + GONE_RECORD_MS;
      const written = await this.redis.eval(
        COMPARE_AND_SET_LUA,
        2,
        this.recordKey(key),
        REDIS_DUE_SET,
        raw ?? '',
        JSON.stringify(next),
        String(Math.max(1, keepUntil - Date.now())),
        next.goneAt === undefined ? String(sweepAt(next)) : '',
        key
      );
      if (written === 1) return next;
      await delay(Math.random() * Math.min(CAS_BACKOFF_MAX_MS, CAS_BACKOFF_BASE_MS * 2 ** attempt));
    }
    throw new Error(`The retention record changed ${MAX_UPDATE_ATTEMPTS} times while it was being updated`);
  }

  async forget(key: string): Promise<void> {
    await this.whenConnected();
    await this.redis.multi().del(this.recordKey(key)).zrem(REDIS_DUE_SET, key).exec();
  }

  /** Redis expires the records of deleted results itself. */
  async collectDue(now: number, limit: number): Promise<string[]> {
    await this.whenConnected();
    return this.redis.zrangebyscore(REDIS_DUE_SET, '-inf', now, 'LIMIT', 0, limit);
  }

  /** The due set holds exactly the keys of results not deleted yet. */
  async liveRecords(): Promise<RetentionRecord[]> {
    await this.whenConnected();
    const keys = await this.redis.zrange(REDIS_DUE_SET, '0', '-1');
    const records: RetentionRecord[] = [];
    for (let start = 0; start < keys.length; start += MGET_BATCH) {
      const raws = await this.redis.mget(keys.slice(start, start + MGET_BATCH).map((key) => this.recordKey(key)));
      for (const raw of raws) {
        const record = raw === null ? undefined : parseRecord(raw);
        if (record && record.goneAt === undefined) records.push(record);
      }
    }
    return records;
  }
}

let activeLedger: RetentionLedger | undefined;

function createRedis(): Redis {
  const options = { maxRetriesPerRequest: 2, enableOfflineQueue: false, commandTimeout: REDIS_COMMAND_TIMEOUT_MS };
  const url = process.env.REDIS_URL;
  if (url) return new Redis(url, options);
  return new Redis({ ...options, host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT || 6379) });
}

export function getRetentionLedger(): RetentionLedger {
  activeLedger ??= process.env.REDIS_URL || process.env.REDIS_HOST ? new RedisRetentionLedger(createRedis()) : new FileRetentionLedger();
  return activeLedger;
}

/** Replaces the ledger; `undefined` makes the next use select one from the environment. For tests. */
export function setRetentionLedger(ledger: RetentionLedger | undefined): void {
  activeLedger = ledger;
}
