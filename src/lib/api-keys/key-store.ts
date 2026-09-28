import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sha256 } from '../auth/crypto';
import { redisUserStore } from '../auth/redis-user-store';
import type { User, UserTier } from '../auth/types';
import type { ApiKey, ApiKeyCreateOptions, ApiKeyCreateResult, QuotaUsage, UserConversionFile } from './types';
import { isIpAllowed } from './ip-utils';
import { globalSharedObjects } from '../storage/shared-store';

const STORAGE_DIR = path.resolve(process.cwd(), '.easyconvert');
const KEYS_FILE = path.join(STORAGE_DIR, 'api-keys.json');
const USAGE_FILE = path.join(STORAGE_DIR, 'api-usage.json');
const FILES_FILE = path.join(STORAGE_DIR, 'user-files.json');

export const TIER_LIMITS: Record<UserTier, number> = {
  free: 25,
  pro: 500,
  enterprise: 10000,
};

export function getUtcDateKey(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function getNextMidnightUtc(): number {
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return tomorrow.getTime();
}

export class KeyStore {
  protected static sharedKeys = new Map<string, ApiKey>();
  protected static sharedKeyHashIndex = new Map<string, string>();
  protected static sharedDailyUsage = new Map<string, number>();
  protected static sharedUserFiles = new Map<string, UserConversionFile>();
  protected static sharedInitialized = false;

  protected readonly keys: Map<string, ApiKey>;
  protected readonly keyHashIndex: Map<string, string>; // hash -> keyId
  protected readonly dailyUsage: Map<string, number>; // userId:YYYY-MM-DD -> count
  protected readonly userFiles: Map<string, UserConversionFile>; // fileId -> file
  protected initialized: boolean;

  constructor(isolated = false) {
    if (isolated) {
      this.keys = new Map();
      this.keyHashIndex = new Map();
      this.dailyUsage = new Map();
      this.userFiles = new Map();
      this.initialized = false;
    } else {
      this.keys = KeyStore.sharedKeys;
      this.keyHashIndex = KeyStore.sharedKeyHashIndex;
      this.dailyUsage = KeyStore.sharedDailyUsage;
      this.userFiles = KeyStore.sharedUserFiles;
      this.initialized = KeyStore.sharedInitialized;
    }
  }

  protected ensureInitialized() {
    if (this.initialized) return;
    this.initialized = true;
    if (this.keys === KeyStore.sharedKeys) {
      KeyStore.sharedInitialized = true;
    }

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

  protected persist() {
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

  public async generateApiKey(
    userId: string,
    name: string,
    options: ApiKeyCreateOptions = {}
  ): Promise<ApiKeyCreateResult> {
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
      expiresAt: options.expiresAt,
      status: 'active',
      allowedIps: options.allowedIps,
      webhookUrl: options.webhookUrl,
      webhookSecret: options.webhookSecret,
      scopes: options.scopes,
    };

    this.keys.set(key.id, key);
    this.keyHashIndex.set(keyHash, key.id);
    this.persist();

    return {
      key,
      secretKey,
    };
  }

  private findOrReloadKeyId(keyHash: string): string | undefined {
    let keyId = this.keyHashIndex.get(keyHash);
    if (!keyId && fs.existsSync(KEYS_FILE)) {
      try {
        const list: ApiKey[] = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf-8'));
        for (const k of list) {
          this.keys.set(k.id, k);
          this.keyHashIndex.set(k.keyHash, k.id);
        }
        keyId = this.keyHashIndex.get(keyHash);
      } catch {}
    }
    return keyId;
  }

  private validateKeyConstraints(key: ApiKey, clientIp?: string): string | null {
    if (key.status !== 'active') {
      return 'API key has been revoked';
    }
    if (key.expiresAt && Date.now() > key.expiresAt) {
      return 'API key has expired';
    }
    if (key.allowedIps && key.allowedIps.length > 0 && clientIp && !isIpAllowed(clientIp, key.allowedIps)) {
      return 'Client IP address is not permitted by API key IP whitelist';
    }
    return null;
  }

  public async verifyApiKey(
    secretKey: string,
    clientIp?: string
  ): Promise<{ valid: boolean; key?: ApiKey; user?: User; error?: string }> {
    this.ensureInitialized();

    if (!secretKey || typeof secretKey !== 'string') {
      return { valid: false, error: 'Missing or invalid API key' };
    }

    const keyHash = sha256(secretKey.trim());
    const keyId = this.findOrReloadKeyId(keyHash);
    if (!keyId) {
      return { valid: false, error: 'Invalid or non-existent API key' };
    }

    const key = this.keys.get(keyId);
    if (!key) {
      return { valid: false, error: 'Invalid or non-existent API key' };
    }

    const constraintError = this.validateKeyConstraints(key, clientIp);
    if (constraintError) {
      return { valid: false, error: constraintError };
    }

    const userRecord = await redisUserStore.findById(key.userId);
    if (!userRecord) {
      return { valid: false, error: 'User associated with API key not found' };
    }

    key.lastUsedAt = Date.now();
    this.persist();

    return {
      valid: true,
      key,
      user: redisUserStore.sanitizeUser(userRecord),
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
    if (key?.userId !== userId) {
      return false;
    }

    key.status = 'revoked';
    this.persist();
    return true;
  }

  public async deleteApiKey(userId: string, keyId: string): Promise<boolean> {
    this.ensureInitialized();
    const key = this.keys.get(keyId);
    if (!key || key.userId !== userId) {
      return false;
    }
    this.keys.delete(keyId);
    this.keyHashIndex.delete(key.keyHash);
    this.persist();
    return true;
  }

  public async getQuotaUsage(userId: string): Promise<QuotaUsage> {
    this.ensureInitialized();

    const user = await redisUserStore.findById(userId);
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

    const user = await redisUserStore.findById(userId);
    const tier: UserTier = user?.tier ?? 'free';
    const dailyLimit = TIER_LIMITS[tier];

    const dateKey = `${userId}:${getUtcDateKey()}`;
    const currentUsed = this.dailyUsage.get(dateKey) ?? 0;

    if (units <= 0) {
      return {
        allowed: dailyLimit - currentUsed > 0,
        remaining: Math.max(0, dailyLimit - currentUsed),
      };
    }

    if (currentUsed + units > dailyLimit) {
      return {
        allowed: false,
        remaining: Math.max(0, dailyLimit - currentUsed),
      };
    }

    const newUsed = currentUsed + units;
    this.dailyUsage.set(dateKey, newUsed);
    this.persist();

    return {
      allowed: true,
      remaining: Math.max(0, dailyLimit - newUsed),
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
    let downloadUrl = data.downloadUrl;
    if (downloadUrl?.startsWith('data:')) {
      const storageKey = `conversions/${data.userId}/${Date.now()}_${encodeURIComponent(data.fileName)}`;
      try {
        const matches = /^data:([^;]+);base64,(.*)$/.exec(downloadUrl);
        if (matches) {
          const mimeType = matches[1];
          const buf = Buffer.from(matches[2], 'base64');
          globalSharedObjects.set(storageKey, {
            key: storageKey,
            filename: data.fileName,
            mimeType,
            buffer: buf,
            size: buf.length,
            etag: `"${crypto.createHash('sha256').update(buf).digest('hex')}"`,
            uploadedAt: now,
            expiresAt: now + 3600 * 1000,
          });
          downloadUrl = `/api/storage/file/${encodeURIComponent(storageKey)}`;
        }
      } catch {
        downloadUrl = `/api/storage/file/${encodeURIComponent(storageKey)}`;
      }
    }

    const file: UserConversionFile = {
      id: crypto.randomUUID(),
      userId: data.userId,
      fileName: data.fileName,
      fromFormat: data.fromFormat,
      toFormat: data.toFormat,
      size: data.size,
      downloadUrl,
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
    let pruned = false;

    for (const [id, file] of this.userFiles.entries()) {
      if (file.userId === userId) {
        if (file.expiresAt < now) {
          // File has expired; prune it
          this.userFiles.delete(id);
          pruned = true;
        } else {
          result.push(file);
        }
      }
    }

    if (pruned) {
      this.persist();
    }

    return result.sort((a, b) => b.createdAt - a.createdAt);
  }

  public async deleteUserFile(userId: string, fileId: string): Promise<boolean> {
    this.ensureInitialized();
    const file = this.userFiles.get(fileId);
    if (file?.userId !== userId) {
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
    if (this.keys === KeyStore.sharedKeys) {
      KeyStore.sharedInitialized = true;
    }

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
