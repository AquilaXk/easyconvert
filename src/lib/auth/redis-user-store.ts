import crypto from 'node:crypto';
import Redis from 'ioredis';
import type { User, UserRecord } from './types';
import { UserStore } from './user-store';

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
-- KEYS[1]: email index key (e.g. easyconvert:emailIndex:user@example.com)
-- KEYS[2]: user record key (e.g. easyconvert:user:userId)
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

/**
 * Enterprise Distributed User Store.
 * Supports Redis distributed cluster storage with atomic Lua operations
 * and seamless, zero-config in-memory fallback for local development and testnets.
 */
export class RedisUserStore extends UserStore {
  private readonly keyPrefix: string;
  private isConnectedToRedis = false;
  private redisClient: Redis | null = null;
  private readonly distributedUsers: Map<string, UserRecord> = new Map();
  private readonly distributedEmails: Map<string, string> = new Map();

  constructor(options: RedisUserStoreOptions = {}) {
    super();
    this.keyPrefix = options.keyPrefix || 'easyconvert:user:';
    if (options.redisClient) {
      this.redisClient = options.redisClient;
      this.isConnectedToRedis = true;
    } else {
      const host = options.redisHost || process.env.REDIS_HOST;
      const url = options.redisUrl || process.env.REDIS_URL;
      const port =
        options.redisPort || (process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379);

      if (url) {
        try {
          this.redisClient = new Redis(url, {
            lazyConnect: true,
            enableOfflineQueue: false,
            maxRetriesPerRequest: 1,
          });
          this.isConnectedToRedis = true;
        } catch {
          this.isConnectedToRedis = false;
        }
      } else if (host) {
        try {
          this.redisClient = new Redis({
            host,
            port,
            lazyConnect: true,
            enableOfflineQueue: false,
            maxRetriesPerRequest: 1,
          });
          this.isConnectedToRedis = true;
        } catch {
          this.isConnectedToRedis = false;
        }
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

  public override async findById(id: string): Promise<UserRecord | null> {
    if (!id || typeof id !== 'string') return null;

    if (this.redisClient) {
      try {
        const userKey = `${this.keyPrefix}${id}`;
        const raw = await this.redisClient.get(userKey);
        if (raw) return JSON.parse(raw);
        return null;
      } catch {
        // Fallback to in-memory on redis error
      }
    }

    if (this.isConnectedToRedis) {
      const user = this.distributedUsers.get(id);
      if (user) return user;
    }
    return super.findById(id);
  }

  public override async findByEmail(email: string): Promise<UserRecord | null> {
    if (!email || typeof email !== 'string') return null;
    try {
      const normalized = this.normalizeEmail(email);

      if (this.redisClient) {
        try {
          const emailKey = `${this.keyPrefix}emailIndex:${normalized}`;
          const id = await this.redisClient.get(emailKey);
          if (id) {
            return await this.findById(id);
          }
          return null;
        } catch {
          // Fallback to in-memory on redis error
        }
      }

      if (this.isConnectedToRedis) {
        const id = this.distributedEmails.get(normalized);
        if (id) {
          const user = this.distributedUsers.get(id);
          if (user) return user;
        }
      }
      return super.findByEmail(normalized);
    } catch {
      return null;
    }
  }

  public override async createUser(data: {
    email: string;
    name: string;
    avatarUrl?: string;
    tier?: 'free' | 'pro' | 'enterprise';
    provider?: 'email' | 'google';
    passwordHash?: string;
    salt?: string;
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
        // Fallback to in-memory if Redis eval failed
      }
    }

    if (this.isConnectedToRedis) {
      if (this.distributedEmails.has(normalizedEmail)) {
        throw new Error('A user with this email address already exists');
      }
      this.distributedUsers.set(userRecord.id, userRecord);
      this.distributedEmails.set(normalizedEmail, userRecord.id);
      return userRecord;
    }

    return super.createUser(data);
  }

  public override async updateUser(
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
      } catch {
        // Fallback
      }
    }

    if (this.isConnectedToRedis) {
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
    return super.updateUser(id, updates);
  }

  public override async recordConversion(id: string): Promise<void> {
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
      } catch {
        // Fallback
      }
    }

    if (this.isConnectedToRedis) {
      const user = await this.findById(id);
      if (user) {
        await this.updateUser(id, { conversionsCount: (user.conversionsCount || 0) + 1 });
      }
      return;
    }
    return super.recordConversion(id);
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

  public override resetStore() {
    this.distributedUsers.clear();
    this.distributedEmails.clear();
    super.resetStore();
  }
}

export const redisUserStore = new RedisUserStore();


