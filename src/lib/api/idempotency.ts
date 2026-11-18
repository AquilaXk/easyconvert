import crypto from 'node:crypto';
import Redis from 'ioredis';
import { createConfiguredRedisClient, hasConfiguredRedis } from '../redis/client-factory';
import { readyGatedRedis } from '../redis/when-ready';
import { clearKeysMatching } from '../redis/clear-keys';

export type IdempotencyStatus = 'in_flight' | 'completed';

export interface StoredResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  isBase64?: boolean;
  /**
   * Set when the answer was too large to keep (`IDEMPOTENCY_MAX_STORED_BODY_BYTES`): the size of the body in bytes, which the record
   * does not hold (`body` is empty). A repeat is told so in place of the answer.
   */
  omittedBodyBytes?: number;
}

export interface IdempotencyRecord {
  status: IdempotencyStatus;
  fingerprint: string;
  createdAt: number;
  response?: StoredResponse;
  /**
   * The random value of the run that took the lock; only that run releases it (the compare-and-delete of the Redis lock
   * pattern). A record an older build wrote has none, so no run releases or keeps it and it ends with its time.
   */
  lockToken?: string;
  /** Set on a lock that stays until it ends because the answer could not be recorded. */
  kept?: boolean;
}

/**
 * What a repeat that meets a lock is told, whether the run still goes or its lock was kept: a browser sends the repeat
 * again after this wait, at most four times, so a longer wait would land it after the lock ended and run the action again.
 */
export const IN_FLIGHT_RETRY_AFTER_SECONDS = 1;

export type AcquireResult =
  | { status: 'acquired' }
  | { status: 'in_flight'; retryAfterSeconds: number }
  | { status: 'completed'; response: StoredResponse }
  | { status: 'mismatched_fingerprint' };

export interface IdempotencyStore {
  /**
   * Takes the lock of `scopedKey` for `lockTtlMs` under `lockToken`, or says what holds it: a repeat that meets a lock,
   * whether the run is still going or its lock was kept, is told to ask again in a second.
   */
  acquire(scopedKey: string, fingerprint: string, lockTtlMs: number, lockToken: string): Promise<AcquireResult>;
  complete(
    scopedKey: string,
    fingerprint: string,
    response: StoredResponse,
    ttlMs?: number,
    lockToken?: string
  ): Promise<boolean>;
  /**
   * Extends the in-flight lock lease while holding the matching `lockToken`.
   */
  extendLock?(scopedKey: string, lockToken: string, ttlMs: number): Promise<boolean>;
  /**
   * Removes the lock of `scopedKey` only while it is still the lock taken with `lockToken`, in one step: a run whose
   * lock ended and was taken again by a later run cannot remove the later run's lock, and a recorded answer is never removed.
   */
  releaseLock(scopedKey: string, lockToken: string): Promise<boolean>;
  /**
   * Marks the lock taken with `lockToken` as kept: it stays until its time ends, and a repeat that meets it is turned
   * away like one that meets a running request. A repeat sent after the lock ended runs the action again.
   */
  keepLock(scopedKey: string, lockToken: string): Promise<boolean>;
  getRecord?(scopedKey: string): Promise<IdempotencyRecord | null>;
  reset?(): Promise<void> | void;
}

/** Orders strings by UTF-16 code unit, independent of locale, so fingerprints stay byte-stable. */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Deterministically serializes an arbitrary JSON-compatible value with sorted object keys
 * conforming to RFC 8785 JSON Canonicalization Scheme principles.
 */
export function canonicalJSON(val: unknown): string {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (typeof (val as any).toJSON === 'function') {
    return canonicalJSON((val as any).toJSON());
  }
  if (Array.isArray(val)) {
    return (
      '[' +
      val
        .map((item) =>
          item === undefined || typeof item === 'symbol' || typeof item === 'function'
            ? 'null'
            : canonicalJSON(item)
        )
        .join(',') +
      ']'
    );
  }
  const obj = val as Record<string, unknown>;
  const keys = Object.keys(obj).sort(compareCodeUnits);
  const pairs: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && typeof v !== 'symbol' && typeof v !== 'function') {
      pairs.push(`${JSON.stringify(k)}:${canonicalJSON(v)}`);
    }
  }
  return '{' + pairs.join(',') + '}';
}

/**
 * Normalizes route path by trimming trailing slashes without regex backtracking.
 */
function normalizeRoutePath(route: string): string {
  let end = route.length;
  while (end > 1 && route.charCodeAt(end - 1) === 47 /* '/' */) {
    end--;
  }
  return route.substring(0, end) || '/';
}

/**
 * Incrementally streams and computes SHA-256 hex digest without loading the entire
 * payload into contiguous heap memory.
 */
export async function hashStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const hash = crypto.createHash('sha256');
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) hash.update(value);
  }
  return hash.digest('hex');
}

/**
 * Computes the canonical request fingerprint:
 * sha256(method + route + canonicalJSON(body without file) + sha256(file stream))
 */
export function computeFingerprint(
  method: string,
  route: string,
  bodyWithoutFile: unknown,
  fileStreamSha256: string = '',
  rawResponse: boolean = false
): string {
  const normalizedMethod = method.toUpperCase();
  const normalizedRoute = normalizeRoutePath(route);
  const canonicalBody = canonicalJSON(bodyWithoutFile ?? {});
  // The way the answer is asked for is part of the request: the raw bytes and the JSON of one conversion are different answers.
  // A request for JSON adds nothing, so the fingerprints that were recorded before this flag existed still match.
  const payload = `${normalizedMethod}:${normalizedRoute}:${canonicalBody}:${fileStreamSha256}${rawResponse ? ':raw' : ''}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/** Whether the request asks for the bytes of a result in place of a JSON answer: `Accept: application/octet-stream` or `?raw=true`. */
export function wantsRawResponse(req: Request): boolean {
  if (req.headers.get('accept') === 'application/octet-stream') return true;
  try {
    return new URL(req.url).searchParams.get('raw') === 'true';
  } catch {
    return false;
  }
}

/**
 * Constructs the scoped Redis/Store key:
 * idem:{userId}:{route}:{key}
 */
export function buildScopedKey(userId: string, route: string, idempotencyKey: string): string {
  const sanitizedUserId = userId.replace(/[{}]/g, '_');
  const normalizedRoute = normalizeRoutePath(route);
  return `idem:{${sanitizedUserId}}:${normalizedRoute}:${idempotencyKey}`;
}

/**
 * Validates whether the provided Idempotency-Key satisfies the 1-255 printable ASCII requirement.
 */
export function isValidIdempotencyKey(key: unknown): key is string {
  if (typeof key !== 'string') return false;
  if (key.length < 1 || key.length > 255) return false;
  return /^[\x21-\x7E]+$/.test(key);
}

export const ACQUIRE_IDEMPOTENCY_LUA_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then
  local record = { status = "in_flight", fingerprint = ARGV[1], createdAt = tonumber(ARGV[3]), lockToken = ARGV[4] }
  redis.call('SET', KEYS[1], cjson.encode(record), 'PX', tonumber(ARGV[2]))
  return { "ACQUIRED" }
end
local ok, parsed = pcall(cjson.decode, current)
if not ok or not parsed or not parsed.fingerprint then
  return { "MISMATCH" }
end
if parsed.fingerprint ~= ARGV[1] then
  return { "MISMATCH" }
end
if parsed.status == "in_flight" then
  return { "IN_FLIGHT" }
elseif parsed.status == "completed" then
  return { "COMPLETED", current }
else
  return { "UNKNOWN" }
end
`;

export const COMPLETE_IDEMPOTENCY_LUA_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current then
  local ok, parsed = pcall(cjson.decode, current)
  if ok and parsed then
    if parsed.fingerprint and parsed.fingerprint ~= ARGV[1] then
      return { "MISMATCH" }
    end
    local token = ARGV[4]
    if token and token ~= '' then
      if parsed.status == "completed" then
        return { "MISMATCH" }
      elseif parsed.status == "in_flight" and parsed.lockToken and parsed.lockToken ~= token then
        return { "LOCK_LOST" }
      end
    end
  end
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', tonumber(ARGV[3]))
return { "OK" }
`;

export const EXTEND_LOCK_LUA_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local ok, parsed = pcall(cjson.decode, current)
if ok and parsed and parsed.status == "in_flight" and parsed.lockToken == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return 0
`;

/** The compare-and-delete of the Redis lock pattern, on the token the record carries: only an in-flight record of this run goes. */
export const RELEASE_LOCK_LUA_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local ok, parsed = pcall(cjson.decode, current)
if ok and parsed and parsed.status == "in_flight" and parsed.lockToken == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export const KEEP_LOCK_LUA_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local ok, parsed = pcall(cjson.decode, current)
if not (ok and parsed and parsed.status == "in_flight" and parsed.lockToken == ARGV[1]) then return 0 end
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then return 0 end
parsed.kept = true
redis.call('SET', KEYS[1], cjson.encode(parsed), 'PX', ttl)
return 1
`;

export interface InMemoryIdempotencyStoreOptions {
  clock?: () => number;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, { record: IdempotencyRecord; expiresAt: number }>();
  private clock: () => number;

  constructor(options?: InMemoryIdempotencyStoreOptions) {
    this.clock = options?.clock || (() => Date.now());
  }

  public setClock(clock: () => number) {
    this.clock = clock;
  }

  public acquire(scopedKey: string, fingerprint: string, lockTtlMs: number, lockToken: string): Promise<AcquireResult> {
    const now = this.clock();
    const existing = this.records.get(scopedKey);

    if (existing) {
      if (existing.expiresAt <= now) {
        this.records.delete(scopedKey);
      } else {
        if (existing.record.fingerprint !== fingerprint) {
          return Promise.resolve({ status: 'mismatched_fingerprint' });
        }
        if (existing.record.status === 'in_flight') {
          return Promise.resolve({ status: 'in_flight', retryAfterSeconds: IN_FLIGHT_RETRY_AFTER_SECONDS });
        }
        if (existing.record.status === 'completed' && existing.record.response) {
          return Promise.resolve({ status: 'completed', response: existing.record.response });
        }
      }
    }

    this.records.set(scopedKey, {
      record: {
        status: 'in_flight',
        fingerprint,
        createdAt: now,
        lockToken,
      },
      expiresAt: now + lockTtlMs,
    });

    return Promise.resolve({ status: 'acquired' });
  }

  public complete(
    scopedKey: string,
    fingerprint: string,
    response: StoredResponse,
    ttlMs: number = 86400000,
    lockToken?: string
  ): Promise<boolean> {
    const now = this.clock();
    const existing = this.records.get(scopedKey);
    if (existing && existing.expiresAt > now) {
      if (existing.record.fingerprint !== fingerprint) {
        return Promise.resolve(false);
      }
      if (lockToken) {
        if (existing.record.status === 'completed') {
          return Promise.resolve(false);
        }
        if (
          existing.record.status === 'in_flight' &&
          existing.record.lockToken &&
          existing.record.lockToken !== lockToken
        ) {
          return Promise.resolve(false);
        }
      }
    }

    this.records.set(scopedKey, {
      record: {
        status: 'completed',
        fingerprint,
        createdAt: now,
        response,
      },
      expiresAt: now + ttlMs,
    });
    return Promise.resolve(true);
  }

  private lockOf(scopedKey: string, lockToken: string): { record: IdempotencyRecord; expiresAt: number } | undefined {
    const existing = this.records.get(scopedKey);
    const live = existing && existing.expiresAt > this.clock() && existing.record.status === 'in_flight' && existing.record.lockToken === lockToken;
    return live ? existing : undefined;
  }

  public extendLock(scopedKey: string, lockToken: string, ttlMs: number): Promise<boolean> {
    const lock = this.lockOf(scopedKey, lockToken);
    if (!lock) return Promise.resolve(false);
    lock.expiresAt = this.clock() + ttlMs;
    return Promise.resolve(true);
  }

  public releaseLock(scopedKey: string, lockToken: string): Promise<boolean> {
    return Promise.resolve(this.lockOf(scopedKey, lockToken) !== undefined && this.records.delete(scopedKey));
  }

  public keepLock(scopedKey: string, lockToken: string): Promise<boolean> {
    const lock = this.lockOf(scopedKey, lockToken);
    if (lock) lock.record.kept = true;
    return Promise.resolve(lock !== undefined);
  }

  public getRecord(scopedKey: string): Promise<IdempotencyRecord | null> {
    const now = this.clock();
    const existing = this.records.get(scopedKey);
    if (!existing || existing.expiresAt <= now) {
      return Promise.resolve(null);
    }
    return Promise.resolve(existing.record);
  }

  public reset(): void {
    this.records.clear();
  }
}

export interface RedisIdempotencyStoreOptions {
  redisClient?: Redis;
  redisUrl?: string;
  redisHost?: string;
  redisPort?: number;
  clock?: () => number;
}

export class RedisIdempotencyStore implements IdempotencyStore {
  private readonly redis: Redis;
  private clock: () => number;

  constructor(options?: RedisIdempotencyStoreOptions) {
    this.clock = options?.clock || (() => Date.now());
    if (options?.redisClient) {
      this.redis = options.redisClient;
    } else if (options?.redisUrl) {
      this.redis = readyGatedRedis(new Redis(options.redisUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 1 }));
    } else if (options?.redisHost) {
      const port = options.redisPort || (process.env.REDIS_PORT ? Number.parseInt(process.env.REDIS_PORT, 10) : 6379);
      this.redis = readyGatedRedis(new Redis({ host: options.redisHost, port, enableOfflineQueue: false, maxRetriesPerRequest: 1 }));
    } else {
      this.redis = readyGatedRedis(createConfiguredRedisClient({ enableOfflineQueue: false, maxRetriesPerRequest: 1 }));
    }
  }

  public getClient(): Redis {
    return this.redis;
  }

  public setClock(clock: () => number) {
    this.clock = clock;
  }

  public async acquire(scopedKey: string, fingerprint: string, lockTtlMs: number, lockToken: string): Promise<AcquireResult> {
    const now = this.clock();
    const res = (await this.redis.eval(
      ACQUIRE_IDEMPOTENCY_LUA_SCRIPT,
      1,
      scopedKey,
      fingerprint,
      lockTtlMs.toString(),
      now.toString(),
      lockToken
    )) as [string, string?];

    const status = res[0];
    if (status === 'ACQUIRED') {
      return { status: 'acquired' };
    }
    if (status === 'IN_FLIGHT') {
      return { status: 'in_flight', retryAfterSeconds: IN_FLIGHT_RETRY_AFTER_SECONDS };
    }
    if (status === 'MISMATCH') {
      return { status: 'mismatched_fingerprint' };
    }
    if (status === 'COMPLETED' && res[1]) {
      const parsed = JSON.parse(res[1]) as IdempotencyRecord;
      if (parsed.response) {
        return { status: 'completed', response: parsed.response };
      }
    }
    throw new Error(`Unexpected idempotency acquire result from Redis: ${status}`);
  }

  public async complete(
    scopedKey: string,
    fingerprint: string,
    response: StoredResponse,
    ttlMs: number = 86400000,
    lockToken?: string
  ): Promise<boolean> {
    const now = this.clock();
    const record: IdempotencyRecord = {
      status: 'completed',
      fingerprint,
      createdAt: now,
      response,
    };
    const serializedRecord = JSON.stringify(record);
    const res = (await this.redis.eval(
      COMPLETE_IDEMPOTENCY_LUA_SCRIPT,
      1,
      scopedKey,
      fingerprint,
      serializedRecord,
      ttlMs.toString(),
      lockToken ?? ''
    )) as [string];

    return res[0] === 'OK';
  }

  public async extendLock(scopedKey: string, lockToken: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.eval(EXTEND_LOCK_LUA_SCRIPT, 1, scopedKey, lockToken, ttlMs.toString())) === 1;
  }

  public async releaseLock(scopedKey: string, lockToken: string): Promise<boolean> {
    return (await this.redis.eval(RELEASE_LOCK_LUA_SCRIPT, 1, scopedKey, lockToken)) === 1;
  }

  public async keepLock(scopedKey: string, lockToken: string): Promise<boolean> {
    return (await this.redis.eval(KEEP_LOCK_LUA_SCRIPT, 1, scopedKey, lockToken)) === 1;
  }

  public async getRecord(scopedKey: string): Promise<IdempotencyRecord | null> {
    const str = await this.redis.get(scopedKey);
    if (!str) return null;
    try {
      return JSON.parse(str) as IdempotencyRecord;
    } catch {
      return null;
    }
  }

  public async reset(): Promise<void> {
    await clearKeysMatching(this.redis, ['idem:*']);
  }
}

let activeStore: IdempotencyStore | null = null;

export function getIdempotencyStore(): IdempotencyStore {
  if (!activeStore) {
    activeStore = hasConfiguredRedis() ? new RedisIdempotencyStore() : new InMemoryIdempotencyStore();
  }
  return activeStore;
}

export function setIdempotencyStore(store: IdempotencyStore | null): void {
  activeStore = store;
}
