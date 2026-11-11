import crypto from 'node:crypto';
import Redis from 'ioredis';
import { readyGatedRedis } from '../redis/when-ready';
import type { User, UserRecord } from './types';
import { failClosed } from './store-unavailable';

export interface RedisUserStoreOptions {
  redisHost?: string;
  redisPort?: number;
  redisUrl?: string;
  keyPrefix?: string;
  redisClient?: Redis;
}

/**
 * Enterprise Distributed Atomic Lua Scripts for User Records and Quotas.
 */
export const CREATE_USER_LUA_SCRIPT = `
-- KEYS[1]: email index key (e.g. easyconvert:{user}:emailIndex:user@example.com)
-- KEYS[2]: user record key (e.g. easyconvert:{user}:userId)
-- ARGV[1]: user ID
-- ARGV[2]: serialized user JSON
-- ARGV[3]: user key TTL in seconds (optional, 0 for infinite)
local exists = redis.call('EXISTS', KEYS[1])
if exists == 1 then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1])
if tonumber(ARGV[3]) > 0 then
  redis.call('SETEX', KEYS[2], tonumber(ARGV[3]), ARGV[2])
else
  redis.call('SET', KEYS[2], ARGV[2])
end
return 1
`;

export const UPDATE_USER_LUA_SCRIPT = `
-- KEYS[1]: user record key
-- ARGV[1]: serialized partial updates JSON
-- ARGV[2]: current timestamp
local raw = redis.call('GET', KEYS[1])
if not raw then
  return nil
end
local user = cjson.decode(raw)
local updates = cjson.decode(ARGV[1])
for k, v in pairs(updates) do
  user[k] = v
end
user["updatedAt"] = tonumber(ARGV[2])
local updatedRaw = cjson.encode(user)
redis.call('SET', KEYS[1], updatedRaw)
return updatedRaw
`;

export const RECORD_CONVERSION_LUA_SCRIPT = `
-- KEYS[1]: user record key
-- ARGV[1]: current timestamp
local raw = redis.call('GET', KEYS[1])
if not raw then
  return nil
end
local user = cjson.decode(raw)
local currentCount = tonumber(user["conversionsCount"]) or 0
user["conversionsCount"] = currentCount + 1
user["updatedAt"] = tonumber(ARGV[1])
local updatedRaw = cjson.encode(user)
redis.call('SET', KEYS[1], updatedRaw)
return updatedRaw
`;

export const RAISE_SESSION_VERSION_LUA = `
-- KEYS[1]: session version key; ARGV[1]: the version every issued token already carries at least
local current = tonumber(redis.call('GET', KEYS[1])) or 1
local base = math.max(current, tonumber(ARGV[1]))
local nextVersion = base + 1
redis.call('SET', KEYS[1], nextVersion)
return nextVersion
`;

/**
 * Enterprise Distributed User Store.
 * Supports Redis distributed cluster storage with atomic Lua operations. Without Redis it keeps accounts in this process's
 * memory (local development and tests). With a Redis client every step that fails throws AuthStoreUnavailableError and is
 * never answered from memory: a process-local copy would accept a revoked session or a stale session version.
 */
export class RedisUserStore {
  private readonly keyPrefix: string;
  private isConnectedToRedis = false;
  private redisClient: Redis | null = null;
  private readonly distributedUsers: Map<string, UserRecord> = new Map();
  private readonly distributedEmails: Map<string, string> = new Map();
  private readonly revokedJtis: Map<string, number> = new Map();
  private readonly userSessionVersions: Map<string, number> = new Map();

  constructor(options: RedisUserStoreOptions = {}) {
    const rawPrefix = options.keyPrefix || 'easyconvert:{user}:';
    if (!/\{[^}]+\}/.test(rawPrefix)) {
      if (rawPrefix.includes('user')) {
        this.keyPrefix = rawPrefix.replace(/user/g, '{user}');
      } else {
        this.keyPrefix = rawPrefix.endsWith(':') ? `${rawPrefix}{user}:` : `${rawPrefix}:{user}:`;
      }
    } else {
      this.keyPrefix = rawPrefix;
    }
    if (options.redisClient) {
      this.redisClient = options.redisClient;
      this.isConnectedToRedis = true;
    } else {
      const host = options.redisHost || process.env.REDIS_HOST;
      const url = options.redisUrl || process.env.REDIS_URL;
      const port =
        options.redisPort || (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379);

      const failFast = { enableOfflineQueue: false, maxRetriesPerRequest: 1 };
      try {
        if (url) {
          this.redisClient = readyGatedRedis(new Redis(url, failFast));
          this.isConnectedToRedis = true;
        } else if (host) {
          this.redisClient = readyGatedRedis(new Redis({ host, port, ...failFast }));
          this.isConnectedToRedis = true;
        }
      } catch {
        this.isConnectedToRedis = false;
      }
    }
  }

  public getKeyPrefix(): string {
    return this.keyPrefix;
  }

  public isDistributed(): boolean {
    return this.isConnectedToRedis;
  }

  public setDistributed(enabled: boolean): void {
    this.isConnectedToRedis = enabled;
  }

  public getRedisClient(): Redis | null {
    return this.redisClient;
  }

  public setRedisClient(client: Redis | null): void {
    this.redisClient = client;
    this.isConnectedToRedis = !!client;
  }

  public async ping(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    if (this.redisClient) {
      try {
        await this.redisClient.ping();
        return { ok: true, latencyMs: Date.now() - start };
      } catch {
        return { ok: false, latencyMs: Date.now() - start };
      }
    }
    return { ok: true, latencyMs: Date.now() - start };
  }

  private normalizeEmail(email: string): string {
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      throw new Error('Invalid email format: email must be a valid email string');
    }
    return email.toLowerCase().trim();
  }

  public sanitizeUser(record: UserRecord): User {
    const { passwordHash, salt, ...safeUser } = record;
    return safeUser;
  }

  public async findById(id: string): Promise<UserRecord | null> {
    if (!id || typeof id !== 'string') return null;

    if (this.redisClient) {
      try {
        const userKey = `${this.keyPrefix}${id}`;
        const raw = await this.redisClient.get(userKey);
        if (raw) return JSON.parse(raw);
        return null;
      } catch (err) {
        return failClosed('RedisUserStore', 'findById', err);
      }
    }

    return this.distributedUsers.get(id) || null;
  }

  public async findByEmail(email: string): Promise<UserRecord | null> {
    if (!email || typeof email !== 'string') return null;
    let normalized: string;
    try {
      normalized = this.normalizeEmail(email);
    } catch {
      return null;
    }

    if (this.redisClient) {
      let id: string | null;
      try {
        id = await this.redisClient.get(`${this.keyPrefix}emailIndex:${normalized}`);
      } catch (err) {
        return failClosed('RedisUserStore', 'findByEmail', err);
      }
      return id ? this.findById(id) : null;
    }

    const id = this.distributedEmails.get(normalized);
    return id ? this.distributedUsers.get(id) || null : null;
  }

  public async createUser(data: {
    email: string;
    name: string;
    avatarUrl?: string;
    tier?: 'free' | 'pro' | 'enterprise';
    provider?: 'email' | 'google';
    passwordHash?: string;
    salt?: string;
    acceptedTermsVersion?: string;
    /** True when the provider vouches for the address (Google sign-in); an email sign-up proves it by the mailed link. */
    emailVerified?: boolean;
  }): Promise<UserRecord> {
    const normalizedEmail = this.normalizeEmail(data.email);
    if (!data.name || typeof data.name !== 'string' || data.name.trim().length === 0) {
      throw new Error('Invalid name: name must be a non-empty string');
    }

    const now = Date.now();
    const userRecord: UserRecord = {
      id: crypto.randomUUID(),
      email: normalizedEmail,
      name: data.name.trim(),
      avatarUrl: data.avatarUrl,
      tier: data.tier || 'free',
      provider: data.provider || 'email',
      passwordHash: data.passwordHash,
      salt: data.salt,
      acceptedTermsVersion: data.acceptedTermsVersion,
      ...(data.emailVerified === undefined ? {} : { emailVerified: data.emailVerified }),
      createdAt: now,
      updatedAt: now,
    };

    if (this.redisClient) {
      const emailKey = `${this.keyPrefix}emailIndex:${normalizedEmail}`;
      const userKey = `${this.keyPrefix}${userRecord.id}`;
      try {
        const result = await this.redisClient.eval(
          CREATE_USER_LUA_SCRIPT,
          2,
          emailKey,
          userKey,
          userRecord.id,
          JSON.stringify(userRecord),
          0
        );
        if (Number(result) === 0) {
          throw new Error('A user with this email address already exists');
        }
        return userRecord;
      } catch (err: any) {
        if (err.message?.includes('already exists')) {
          throw err;
        }
        return failClosed('RedisUserStore', 'createUser', err);
      }
    }

    if (this.distributedEmails.has(normalizedEmail)) {
      throw new Error('A user with this email address already exists');
    }
    this.distributedUsers.set(userRecord.id, userRecord);
    this.distributedEmails.set(normalizedEmail, userRecord.id);
    return userRecord;
  }

  public async updateUser(
    id: string,
    updates: Partial<Omit<UserRecord, 'id' | 'email' | 'createdAt'>>
  ): Promise<UserRecord | null> {
    if (!id || typeof id !== 'string') return null;

    if (this.redisClient) {
      try {
        const userKey = `${this.keyPrefix}${id}`;
        const updatedRaw = await this.redisClient.eval(
          UPDATE_USER_LUA_SCRIPT,
          1,
          userKey,
          JSON.stringify(updates),
          String(Date.now())
        );
        if (!updatedRaw) return null;
        return JSON.parse(updatedRaw as string);
      } catch (err) {
        return failClosed('RedisUserStore', 'updateUser', err);
      }
    }

    const existing = this.distributedUsers.get(id);
    if (!existing) return null;
    const updated: UserRecord = {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
    };
    this.distributedUsers.set(id, updated);
    return updated;
  }

  public async updateTier(id: string, tier: 'free' | 'pro' | 'enterprise'): Promise<UserRecord | null> {
    return this.updateUser(id, { tier });
  }

  public async recordConversion(id: string): Promise<void> {
    if (!id || typeof id !== 'string') return;

    if (this.redisClient) {
      try {
        const userKey = `${this.keyPrefix}${id}`;
        await this.redisClient.eval(
          RECORD_CONVERSION_LUA_SCRIPT,
          1,
          userKey,
          String(Date.now())
        );
        return;
      } catch (err) {
        return failClosed('RedisUserStore', 'recordConversion', err);
      }
    }

    const user = await this.findById(id);
    if (user) {
      await this.updateUser(id, { conversionsCount: (user.conversionsCount || 0) + 1 });
    }
  }

  public async revokeJti(jti: string, ttlSeconds: number): Promise<void> {
    if (!jti) return;
    const safeTtl = Math.max(1, Math.floor(ttlSeconds));
    const expiresAt = Date.now() + safeTtl * 1000;

    if (this.redisClient) {
      try {
        const key = `${this.keyPrefix}revoked_jti:${jti}`;
        await this.redisClient.setex(key, safeTtl, '1');
      } catch (err) {
        return failClosed('RedisUserStore', 'revokeJti', err);
      }
    }

    this.revokedJtis.set(jti, expiresAt);
  }

  public async isJtiRevoked(jti: string): Promise<boolean> {
    if (!jti) return false;

    if (this.redisClient) {
      try {
        const key = `${this.keyPrefix}revoked_jti:${jti}`;
        const exists = await this.redisClient.exists(key);
        if (exists === 1) return true;
      } catch (err) {
        return failClosed('RedisUserStore', 'isJtiRevoked', err);
      }
    }

    const expiresAt = this.revokedJtis.get(jti);
    if (!expiresAt) return false;
    if (Date.now() > expiresAt) {
      this.revokedJtis.delete(jti);
      return false;
    }
    return true;
  }

  /**
   * Revokes every session of the account by raising its session version above the one any issued token carries (a token
   * names the version of the record when it was made, 1 for an account that never revoked). The counter starts from the
   * record's own version, so the first revocation also raises it: a plain INCR of an absent counter returns 1, which the
   * tokens of a new account already carry.
   */
  public async incrementSessionVersion(userId: string): Promise<number> {
    if (!userId) return 1;

    const record = await this.findById(userId);
    const floor = Math.max(record?.sessionVersion ?? 1, this.userSessionVersions.get(userId) ?? 1);
    let nextVersion = floor + 1;
    if (this.redisClient) {
      try {
        const key = `${this.keyPrefix}session_version:${userId}`;
        nextVersion = Number(await this.redisClient.eval(RAISE_SESSION_VERSION_LUA, 1, key, String(floor)));
      } catch (err) {
        return failClosed('RedisUserStore', 'incrementSessionVersion', err);
      }
    }

    this.userSessionVersions.set(userId, nextVersion);

    // Sync user record if it exists
    await this.updateUser(userId, { sessionVersion: nextVersion });
    return nextVersion;
  }

  public async getSessionVersion(userId: string): Promise<number> {
    if (!userId) return 1;

    if (this.redisClient) {
      try {
        const key = `${this.keyPrefix}session_version:${userId}`;
        const val = await this.redisClient.get(key);
        if (val) {
          return parseInt(val, 10) || 1;
        }
      } catch (err) {
        return failClosed('RedisUserStore', 'getSessionVersion', err);
      }
    }

    if (this.userSessionVersions.has(userId)) {
      return this.userSessionVersions.get(userId)!;
    }

    const user = await this.findById(userId);
    return user?.sessionVersion || 1;
  }

  /**
   * Removes the account `id`: its record, its email index and its session version. Its sessions stop working, since a
   * session is accepted only while its account's record exists. Returns false when there is no such account.
   */
  public async deleteUser(id: string): Promise<boolean> {
    const record = await this.findById(id);
    if (!record) return false;
    const email = this.normalizeEmail(record.email);
    if (this.redisClient) {
      await this.redisClient.del(`${this.keyPrefix}${id}`, `${this.keyPrefix}emailIndex:${email}`, `${this.keyPrefix}session_version:${id}`);
    }
    this.distributedUsers.delete(id);
    this.distributedEmails.delete(email);
    this.userSessionVersions.delete(id);
    return true;
  }

  public async close(): Promise<void> {
    if (this.redisClient) {
      try {
        await this.redisClient.quit();
      } catch {
        this.redisClient.disconnect();
      }
      this.redisClient = null;
      this.isConnectedToRedis = false;
    }
  }

  public resetStore(): void {
    this.distributedUsers.clear();
    this.distributedEmails.clear();
    this.revokedJtis.clear();
    this.userSessionVersions.clear();
  }
}

export const redisUserStore = new RedisUserStore();


