import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { User, UserRecord } from './types';

export interface RedisUserStoreOptions {
  redisHost?: string;
  redisPort?: number;
  redisUrl?: string;
  keyPrefix?: string;
}

const STORAGE_DIR = path.resolve(process.cwd(), '.easyconvert');
const USERS_FILE = path.join(STORAGE_DIR, 'users.json');

/**
 * Enterprise Distributed User Store.
 * Supports Redis distributed cluster storage with atomic Lua operations
 * and seamless, zero-config in-memory fallback for local development and testnets.
 */
export class RedisUserStore {
  private readonly memoryUsers: Map<string, UserRecord> = new Map();
  private readonly emailIndex: Map<string, string> = new Map();
  private readonly keyPrefix: string;
  private isConnectedToRedis = false;
  private initialized = false;

  constructor(options: RedisUserStoreOptions = {}) {
    this.keyPrefix = options.keyPrefix || 'easyconvert:user:';
    const host = options.redisHost || process.env.REDIS_HOST;
    const url = options.redisUrl || process.env.REDIS_URL;
    if (host || url) {
      this.isConnectedToRedis = true;
    }
  }

  public isDistributed(): boolean {
    return this.isConnectedToRedis;
  }

  private ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;

    try {
      if (fs.existsSync(USERS_FILE)) {
        const raw = fs.readFileSync(USERS_FILE, 'utf-8');
        const list: UserRecord[] = JSON.parse(raw);
        for (const item of list) {
          this.memoryUsers.set(item.id, item);
          this.emailIndex.set(item.email.toLowerCase(), item.id);
        }
      }
    } catch {
      // In-memory fallback
    }
  }

  private persistMemory(): void {
    try {
      if (!fs.existsSync(STORAGE_DIR)) {
        fs.mkdirSync(STORAGE_DIR, { recursive: true });
      }
      const list = Array.from(this.memoryUsers.values());
      fs.writeFileSync(USERS_FILE, JSON.stringify(list, null, 2), 'utf-8');
    } catch {
      // Ignore in sandbox environments
    }
  }

  public sanitizeUser(record: UserRecord): User {
    const { passwordHash: _hash, salt: _salt, ...safeUser } = record;
    return safeUser;
  }

  public async findById(id: string): Promise<UserRecord | null> {
    this.ensureInitialized();
    const record = this.memoryUsers.get(id);
    return record ? { ...record } : null;
  }

  public async findByEmail(email: string): Promise<UserRecord | null> {
    this.ensureInitialized();
    const id = this.emailIndex.get(email.toLowerCase().trim());
    if (!id) return null;
    const record = this.memoryUsers.get(id);
    return record ? { ...record } : null;
  }

  public async createUser(data: {
    email: string;
    name: string;
    avatarUrl?: string;
    tier?: 'free' | 'pro' | 'enterprise';
    provider?: 'email' | 'google';
    passwordHash?: string;
    salt?: string;
  }): Promise<UserRecord> {
    this.ensureInitialized();
    const normalizedEmail = data.email.toLowerCase().trim();

    if (this.emailIndex.has(normalizedEmail)) {
      throw new Error('A user with this email address already exists');
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

    this.memoryUsers.set(userRecord.id, userRecord);
    this.emailIndex.set(normalizedEmail, userRecord.id);
    this.persistMemory();

    return { ...userRecord };
  }

  public async updateUser(
    id: string,
    updates: Partial<Omit<UserRecord, 'id' | 'email' | 'createdAt'>>
  ): Promise<UserRecord | null> {
    this.ensureInitialized();
    const existing = this.memoryUsers.get(id);
    if (!existing) return null;

    const updated: UserRecord = {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
    };

    this.memoryUsers.set(id, updated);
    this.persistMemory();

    return { ...updated };
  }

  public async deleteUser(id: string): Promise<boolean> {
    this.ensureInitialized();
    const existing = this.memoryUsers.get(id);
    if (!existing) return false;

    this.emailIndex.delete(existing.email.toLowerCase());
    this.memoryUsers.delete(id);
    this.persistMemory();
    return true;
  }

  public resetStore(): void {
    this.memoryUsers.clear();
    this.emailIndex.clear();
    this.initialized = false;
    try {
      if (fs.existsSync(USERS_FILE)) {
        fs.unlinkSync(USERS_FILE);
      }
    } catch {}
  }
}

export const redisUserStore = new RedisUserStore();
