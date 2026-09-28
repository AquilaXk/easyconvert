import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { User, UserRecord } from './types';

const STORAGE_DIR = path.resolve(process.cwd(), '.easyconvert');
const USERS_FILE = path.join(STORAGE_DIR, 'users.json');

export class UserStore {
  private readonly users: Map<string, UserRecord> = new Map();
  private readonly emailIndex: Map<string, string> = new Map();
  private initialized = false;

  private ensureInitialized() {
    if (this.initialized) return;
    this.initialized = true;

    try {
      if (fs.existsSync(USERS_FILE)) {
        const raw = fs.readFileSync(USERS_FILE, 'utf-8');
        const list: UserRecord[] = JSON.parse(raw);
        for (const item of list) {
          this.users.set(item.id, item);
          this.emailIndex.set(item.email.toLowerCase(), item.id);
        }
      }
    } catch {
      // In-memory fallback if file system access fails
    }
  }

  private persist() {
    try {
      if (!fs.existsSync(STORAGE_DIR)) {
        fs.mkdirSync(STORAGE_DIR, { recursive: true });
      }
      const list = Array.from(this.users.values());
      fs.writeFileSync(USERS_FILE, JSON.stringify(list, null, 2), 'utf-8');
    } catch {
      // Ignore write failures in memory-only/sandbox environments
    }
  }

  public sanitizeUser(record: UserRecord): User {
    const { passwordHash, salt, ...safeUser } = record;
    return safeUser;
  }

  public async findById(id: string): Promise<UserRecord | null> {
    this.ensureInitialized();
    return this.users.get(id) || null;
  }

  public async findByEmail(email: string): Promise<UserRecord | null> {
    this.ensureInitialized();
    const id = this.emailIndex.get(email.toLowerCase().trim());
    if (!id) return null;
    return this.users.get(id) || null;
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

    this.users.set(userRecord.id, userRecord);
    this.emailIndex.set(normalizedEmail, userRecord.id);
    this.persist();

    return userRecord;
  }

  public async updateUser(
    id: string,
    updates: Partial<Omit<UserRecord, 'id' | 'email' | 'createdAt'>>
  ): Promise<UserRecord | null> {
    this.ensureInitialized();
    const existing = this.users.get(id);
    if (!existing) return null;

    const updated: UserRecord = {
      ...existing,
      ...updates,
      updatedAt: Date.now(),
    };

    this.users.set(id, updated);
    this.persist();
    return updated;
  }

  public async updateTier(id: string, tier: 'free' | 'pro' | 'enterprise'): Promise<UserRecord | null> {
    return this.updateUser(id, { tier });
  }

  public async recordConversion(id: string): Promise<void> {
    const user = await this.findById(id);
    if (user) {
      await this.updateUser(id, { conversionsCount: (user.conversionsCount || 0) + 1 });
    }
  }

  public resetStore() {
    this.users.clear();
    this.emailIndex.clear();
    this.initialized = true;
    try {
      if (fs.existsSync(USERS_FILE)) {
        fs.unlinkSync(USERS_FILE);
      }
    } catch {
      // Ignore cleanup error
    }
  }
}

export const userStore = new UserStore();
