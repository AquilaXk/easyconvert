import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sha256 } from '../auth/crypto';
import { userStore } from '../auth/user-store';
import type { User, UserTier } from '../auth/types';
import type { ApiKey, ApiKeyCreateResult, QuotaUsage, UserConversionFile } from './types';

const STORAGE_DIR = path.resolve(process.cwd(), '.easyconvert');
const KEYS_FILE = path.join(STORAGE_DIR, 'api-keys.json');
const USAGE_FILE = path.join(STORAGE_DIR, 'api-usage.json');
const FILES_FILE = path.join(STORAGE_DIR, 'user-files.json');

export const TIER_LIMITS: Record<UserTier, number> = {
  free: 25,
  pro: 500,
  enterprise: 10000,
};

function getUtcDateKey(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getNextMidnightUtc(): number {
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return tomorrow.getTime();
}

class KeyStore {
  private keys: Map<string, ApiKey> = new Map();
  private keyHashIndex: Map<string, string> = new Map(); // hash -> keyId
  private dailyUsage: Map<string, number> = new Map(); // userId:YYYY-MM-DD -> count
  private userFiles: Map<string, UserConversionFile> = new Map(); // fileId -> file
  private initialized = false;

  private ensureInitialized() {
    if (this.initialized) return;
    this.initialized = true;

    try {
      if (fs.existsSync(KEYS_FILE)) {
        const list: ApiKey[] = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf-8'));
        for (const k of list) {
          this.keys.set(k.id, k);
          this.keyHashIndex.set(k.keyHash, k.id);
        }
      }

      if (fs.existsSync(USAGE_FILE)) {
        const usageObj: Record<string, number> = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'));
        for (const [key, val] of Object.entries(usageObj)) {
          this.dailyUsage.set(key, val);
        }
      }

      if (fs.existsSync(FILES_FILE)) {
        const filesList: UserConversionFile[] = JSON.parse(fs.readFileSync(FILES_FILE, 'utf-8'));
        for (const f of filesList) {
          this.userFiles.set(f.id, f);
        }
      }
    } catch {
      // In-memory fallback
    }
  }

  private persist() {
    try {
      if (!fs.existsSync(STORAGE_DIR)) {
        fs.mkdirSync(STORAGE_DIR, { recursive: true });
      }

      fs.writeFileSync(KEYS_FILE, JSON.stringify(Array.from(this.keys.values()), null, 2), 'utf-8');

      const usageObj: Record<string, number> = {};
      for (const [key, val] of this.dailyUsage.entries()) {
        usageObj[key] = val;
      }
      fs.writeFileSync(USAGE_FILE, JSON.stringify(usageObj, null, 2), 'utf-8');

      fs.writeFileSync(FILES_FILE, JSON.stringify(Array.from(this.userFiles.values()), null, 2), 'utf-8');
    } catch {
      // Ignore in sandbox/read-only
    }
  }

  public async generateApiKey(userId: string, name: string): Promise<ApiKeyCreateResult> {
    this.ensureInitialized();

    const rawRandom = crypto.randomBytes(24).toString('hex');
    const secretKey = `ec_live_${rawRandom}`;
    const keyHash = sha256(secretKey);
    const prefix = `${secretKey.substring(0, 12)}...`;

    const key: ApiKey = {
      id: crypto.randomUUID(),
      userId,
      name: name.trim() || 'Default API Key',
      prefix,
      keyHash,
      createdAt: Date.now(),
      status: 'active',
    };

    this.keys.set(key.id, key);
    this.keyHashIndex.set(keyHash, key.id);
    this.persist();

    return {
      key,
      secretKey,
    };
  }

  public async verifyApiKey(secretKey: string): Promise<{ valid: boolean; key?: ApiKey; user?: User }> {
    this.ensureInitialized();

    if (!secretKey || typeof secretKey !== 'string') {
      return { valid: false };
    }

    const keyHash = sha256(secretKey.trim());
    const keyId = this.keyHashIndex.get(keyHash);
    if (!keyId) {
      return { valid: false };
    }

    const key = this.keys.get(keyId);
    if (!key || key.status !== 'active') {
      return { valid: false };
    }

    const userRecord = await userStore.findById(key.userId);
    if (!userRecord) {
      return { valid: false };
    }

    // Update last used timestamp
    key.lastUsedAt = Date.now();
    this.persist();

    return {
      valid: true,
      key,
      user: userStore.sanitizeUser(userRecord),
    };
  }

  public async listApiKeys(userId: string): Promise<ApiKey[]> {
    this.ensureInitialized();
    const result: ApiKey[] = [];
    for (const key of this.keys.values()) {
      if (key.userId === userId) {
        result.push(key);
      }
    }
    return result.sort((a, b) => b.createdAt - a.createdAt);
  }

  public async revokeApiKey(userId: string, keyId: string): Promise<boolean> {
    this.ensureInitialized();
    const key = this.keys.get(keyId);
    if (!key || key.userId !== userId) {
      return false;
    }

    key.status = 'revoked';
    this.persist();
    return true;
  }

  public async getQuotaUsage(userId: string): Promise<QuotaUsage> {
    this.ensureInitialized();

    const user = await userStore.findById(userId);
    const tier: UserTier = user?.tier || 'free';
    const dailyLimit = TIER_LIMITS[tier];

    const dateKey = `${userId}:${getUtcDateKey()}`;
    const usedToday = this.dailyUsage.get(dateKey) || 0;
    const remaining = Math.max(0, dailyLimit - usedToday);
    const resetAt = getNextMidnightUtc();

    return {
      tier,
      dailyLimit,
      usedToday,
      remaining,
      resetAt,
    };
  }

  public async recordUsage(userId: string, units: number = 1): Promise<{ allowed: boolean; remaining: number }> {
    this.ensureInitialized();

    const quota = await this.getQuotaUsage(userId);
    if (quota.usedToday + units > quota.dailyLimit) {
      return {
        allowed: false,
        remaining: quota.remaining,
      };
    }

    const dateKey = `${userId}:${getUtcDateKey()}`;
    const newUsed = quota.usedToday + units;
    this.dailyUsage.set(dateKey, newUsed);
    this.persist();

    return {
      allowed: true,
      remaining: Math.max(0, quota.dailyLimit - newUsed),
    };
  }

  public async recordUserFile(data: {
    userId: string;
    fileName: string;
    fromFormat: string;
    toFormat: string;
    size: number;
    downloadUrl: string;
  }): Promise<UserConversionFile> {
    this.ensureInitialized();

    const now = Date.now();
    const file: UserConversionFile = {
      id: crypto.randomUUID(),
      userId: data.userId,
      fileName: data.fileName,
      fromFormat: data.fromFormat,
      toFormat: data.toFormat,
      size: data.size,
      downloadUrl: data.downloadUrl,
      createdAt: now,
      expiresAt: now + 3600 * 1000, // 1 hour lifetime
    };

    this.userFiles.set(file.id, file);
    this.persist();
    return file;
  }

  public async listUserFiles(userId: string): Promise<UserConversionFile[]> {
    this.ensureInitialized();
    const now = Date.now();
    const result: UserConversionFile[] = [];

    for (const [id, file] of this.userFiles.entries()) {
      if (file.userId === userId) {
        if (file.expiresAt < now) {
          // File has expired; prune it
          this.userFiles.delete(id);
        } else {
          result.push(file);
        }
      }
    }

    return result.sort((a, b) => b.createdAt - a.createdAt);
  }

  public async deleteUserFile(userId: string, fileId: string): Promise<boolean> {
    this.ensureInitialized();
    const file = this.userFiles.get(fileId);
    if (!file || file.userId !== userId) {
      return false;
    }
    this.userFiles.delete(fileId);
    this.persist();
    return true;
  }

  public resetStore() {
    this.keys.clear();
    this.keyHashIndex.clear();
    this.dailyUsage.clear();
    this.userFiles.clear();
    this.initialized = true;

    try {
      if (fs.existsSync(KEYS_FILE)) fs.unlinkSync(KEYS_FILE);
      if (fs.existsSync(USAGE_FILE)) fs.unlinkSync(USAGE_FILE);
      if (fs.existsSync(FILES_FILE)) fs.unlinkSync(FILES_FILE);
    } catch {
      // Ignore
    }
  }
}

export const keyStore = new KeyStore();
