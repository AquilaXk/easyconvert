import crypto from 'node:crypto';
import Redis from 'ioredis';

export type IdempotencyStatus = 'in_flight' | 'completed';

export interface StoredResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  isBase64?: boolean;
}

export interface IdempotencyRecord {
  status: IdempotencyStatus;
  fingerprint: string;
  createdAt: number;
  response?: StoredResponse;
}

export type AcquireResult =
  | { status: 'acquired' }
  | { status: 'in_flight'; retryAfterSeconds: number }
  | { status: 'completed'; response: StoredResponse }
  | { status: 'mismatched_fingerprint' };

export interface IdempotencyStore {
  acquire(scopedKey: string, fingerprint: string, lockTtlMs?: number): Promise<AcquireResult>;
  complete(scopedKey: string, fingerprint: string, response: StoredResponse, ttlMs?: number): Promise<boolean>;
  delete(scopedKey: string): Promise<boolean>;
  renewLock?(scopedKey: string, ttlMs?: number): Promise<boolean>;
  getRecord?(scopedKey: string): Promise<IdempotencyRecord | null>;
  reset?(): Promise<void> | void;
}

/**
 * Deterministically serializes an arbitrary JSON-compatible value with sorted object keys
 * conforming to RFC 8785 JSON Canonicalization Scheme principles.
 */
export function canonicalJSON(val: unknown): string {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return '[' + val.map((item) => canonicalJSON(item)).join(',') + ']';
  }
  const obj = val as Record<string, unknown>;
  const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
  const pairs: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined) {
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
  fileStreamSha256: string = ''
): string {
  const normalizedMethod = method.toUpperCase();
  const normalizedRoute = normalizeRoutePath(route);
  const canonicalBody = canonicalJSON(bodyWithoutFile ?? {});
  const payload = `${normalizedMethod}:${normalizedRoute}:${canonicalBody}:${fileStreamSha256}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Constructs the scoped Redis/Store key:
 * idem:{userId}:{route}:{key}
 */
export function buildScopedKey(userId: string, route: string, idempotencyKey: string): string {
  const normalizedRoute = normalizeRoutePath(route);
  return `idem:{${userId}}:${normalizedRoute}:${idempotencyKey}`;
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
  local record = { status = "in_flight", fingerprint = ARGV[1], createdAt = tonumber(ARGV[3]) }
  redis.call('SET', KEYS[1], cjson.encode(record), 'PX', tonumber(ARGV[2]))
  return { "ACQUIRED" }
end
local parsed = cjson.decode(current)
if parsed.fingerprint ~= ARGV[1] then
  return { "MISMATCH" }
end
if parsed.status == "in_flight" then
  return { "IN_FLIGHT", "1" }
elseif parsed.status == "completed" then
  return { "COMPLETED", current }
else
  return { "UNKNOWN" }
end
`;

export const COMPLETE_IDEMPOTENCY_LUA_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current then
  local parsed = cjson.decode(current)
  if parsed.fingerprint ~= ARGV[1] then
    return { "MISMATCH" }
  end
end
local record = {
  status = "completed",
  fingerprint = ARGV[1],
  createdAt = tonumber(ARGV[4]),
  response = cjson.decode(ARGV[2])
}
redis.call('SET', KEYS[1], cjson.encode(record), 'PX', tonumber(ARGV[3]))
return { "OK" }
`;

export const RENEW_LOCK_LUA_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current then
  local parsed = cjson.decode(current)
  if parsed.status == "in_flight" then
    return redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]))
  end
end
return 0
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

  public acquire(scopedKey: string, fingerprint: string, lockTtlMs: number = 60000): Promise<AcquireResult> {
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
          return Promise.resolve({ status: 'in_flight', retryAfterSeconds: 1 });
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
      },
      expiresAt: now + lockTtlMs,
    });

    return Promise.resolve({ status: 'acquired' });
  }

  public complete(
    scopedKey: string,
    fingerprint: string,
    response: StoredResponse,
    ttlMs: number = 86400000
  ): Promise<boolean> {
    const now = this.clock();
    const existing = this.records.get(scopedKey);
    if (existing && existing.expiresAt > now && existing.record.fingerprint !== fingerprint) {
      return Promise.resolve(false);
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

  public delete(scopedKey: string): Promise<boolean> {
    return Promise.resolve(this.records.delete(scopedKey));
  }

  public renewLock(scopedKey: string, ttlMs: number = 60000): Promise<boolean> {
    const now = this.clock();
    const existing = this.records.get(scopedKey);
    if (existing && existing.expiresAt > now && existing.record.status === 'in_flight') {
      existing.expiresAt = now + ttlMs;
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
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
    } else {
      const url = options?.redisUrl || process.env.REDIS_URL;
      const host = options?.redisHost || process.env.REDIS_HOST || '127.0.0.1';
      const port = options?.redisPort || (process.env.REDIS_PORT ? Number.parseInt(process.env.REDIS_PORT, 10) : 6379);
      if (url) {
        this.redis = new Redis(url, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1 });
      } else {
        this.redis = new Redis({ host, port, lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 1 });
      }
    }
  }

  public getClient(): Redis {
    return this.redis;
  }

  public setClock(clock: () => number) {
    this.clock = clock;
  }

  public async acquire(scopedKey: string, fingerprint: string, lockTtlMs: number = 60000): Promise<AcquireResult> {
    const now = this.clock();
    const res = (await this.redis.eval(
      ACQUIRE_IDEMPOTENCY_LUA_SCRIPT,
      1,
      scopedKey,
      fingerprint,
      lockTtlMs.toString(),
      now.toString()
    )) as [string, string?];

    const status = res[0];
    if (status === 'ACQUIRED') {
      return { status: 'acquired' };
    }
    if (status === 'IN_FLIGHT') {
      return { status: 'in_flight', retryAfterSeconds: res[1] ? Number.parseInt(res[1], 10) : 1 };
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
    ttlMs: number = 86400000
  ): Promise<boolean> {
    const now = this.clock();
    const serializedResponse = JSON.stringify(response);
    const res = (await this.redis.eval(
      COMPLETE_IDEMPOTENCY_LUA_SCRIPT,
      1,
      scopedKey,
      fingerprint,
      serializedResponse,
      ttlMs.toString(),
      now.toString()
    )) as [string];

    return res[0] === 'OK';
  }

  public async delete(scopedKey: string): Promise<boolean> {
    const deleted = await this.redis.del(scopedKey);
    return deleted > 0;
  }

  public async renewLock(scopedKey: string, ttlMs: number = 60000): Promise<boolean> {
    const res = (await this.redis.eval(
      RENEW_LOCK_LUA_SCRIPT,
      1,
      scopedKey,
      ttlMs.toString()
    )) as number;
    return res === 1;
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
    const keys = await this.redis.keys('idem:*');
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }
}

let activeStore: IdempotencyStore | null = null;

export function getIdempotencyStore(): IdempotencyStore {
  if (!activeStore) {
    if (process.env.REDIS_URL || process.env.REDIS_HOST) {
      try {
        activeStore = new RedisIdempotencyStore();
      } catch {
        activeStore = new InMemoryIdempotencyStore();
      }
    } else {
      activeStore = new InMemoryIdempotencyStore();
    }
  }
  return activeStore;
}

export function setIdempotencyStore(store: IdempotencyStore | null): void {
  activeStore = store;
}
