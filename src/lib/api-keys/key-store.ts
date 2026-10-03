import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hmacSha256, sha256 } from '../auth/crypto';
import { redisUserStore } from '../auth/redis-user-store';
import type { User, UserTier } from '../auth/types';
import type { ApiKey, ApiKeyCreateOptions, ApiKeyCreateResult, QuotaUsage, UserConversionFile } from './types';
import { isIpAllowed } from './ip-utils';
import { globalSharedObjects } from '../storage/shared-store';
import { encryptSecret, decryptSecret } from './secret-encryption';
import type { ApiKeyRotateOptions, ApiKeyRotateResult, ApiKeyUpdateOptions } from './types';

const STORAGE_DIR = path.resolve(process.cwd(), '.easyconvert');
const KEYS_FILE = path.join(STORAGE_DIR, 'api-keys.json');
const USAGE_FILE = path.join(STORAGE_DIR, 'api-usage.json');
const FILES_FILE = path.join(STORAGE_DIR, 'user-files.json');

export const TIER_LIMITS: Record<UserTier, number> = {
  free: 25,
  pro: 500,
  enterprise: 10000,
};

const KEY_HASH_PEPPER_ENV = 'KEY_HASH_PEPPER';
let pepperWarningEmitted = false;

/**
 * Reads the server-side API key hash pepper at call time. Warns once when it is unset,
 * because unpeppered SHA-256 hashes let anyone holding the key file test guessed keys offline.
 */
function readKeyHashPepper(): string | undefined {
  const pepper = process.env[KEY_HASH_PEPPER_ENV];
  if (pepper) {
    return pepper;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `[KeyStore] FATAL: ${KEY_HASH_PEPPER_ENV} environment variable is required in production.`
    );
  }
  if (!pepperWarningEmitted) {
    pepperWarningEmitted = true;
    console.warn(
      `[KeyStore] ${KEY_HASH_PEPPER_ENV} is not set; API key hashes use unpeppered SHA-256. Set it to a long random secret.`
    );
  }
  return undefined;
}

/**
 * Hashes an API key secret for storage: HMAC-SHA256(pepper, secret) when a pepper is
 * configured, otherwise the legacy SHA-256(secret).
 */
export function hashApiKeySecret(secret: string): string {
  const pepper = readKeyHashPepper();
  if (pepper) {
    return hmacSha256(pepper, secret);
  }
  return sha256(secret);
}

export interface ApiKeyHashCandidates {
  /** Lookup order: the current (peppered when configured) hash first, then the legacy SHA-256. */
  hashes: string[];
  /** Hash a legacy-hashed key is migrated to after a successful verification, if different. */
  currentHash: string;
}

export function apiKeyHashCandidates(secret: string): ApiKeyHashCandidates {
  const currentHash = hashApiKeySecret(secret);
  const legacyHash = sha256(secret);
  if (currentHash === legacyHash) {
    return { hashes: [currentHash], currentHash };
  }
  return { hashes: [currentHash, legacyHash], currentHash };
}

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
    const keyHash = hashApiKeySecret(secretKey);
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
      webhookSecret: encryptSecret(options.webhookSecret),
      scopes: options.scopes,
    };

    this.keys.set(key.id, key);
    this.keyHashIndex.set(keyHash, key.id);
    this.persist();

    return {
      key: {
        ...key,
        webhookSecret: options.webhookSecret,
      },
      secretKey,
    };
  }

  private lookupKeyId(candidateHashes: readonly string[]): string | undefined {
    for (const keyHash of candidateHashes) {
      const keyId = this.keyHashIndex.get(keyHash);
      if (keyId) {
        return keyId;
      }
    }
    for (const key of this.keys.values()) {
      if (key.previousKeyHash && candidateHashes.includes(key.previousKeyHash)) {
        if (!key.graceExpiresAt || Date.now() <= key.graceExpiresAt) {
          return key.id;
        }
      }
    }
    return undefined;
  }

  private findOrReloadKeyId(candidateHashes: readonly string[]): string | undefined {
    let keyId = this.lookupKeyId(candidateHashes);
    if (!keyId && fs.existsSync(KEYS_FILE)) {
      try {
        const list: ApiKey[] = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf-8'));
        for (const k of list) {
          this.keys.set(k.id, k);
          this.keyHashIndex.set(k.keyHash, k.id);
        }
        keyId = this.lookupKeyId(candidateHashes);
      } catch {}
    }
    return keyId;
  }

  /**
   * Re-indexes a key verified through its legacy SHA-256 hash under the current (peppered) hash.
   */
  private migrateKeyHash(key: ApiKey, currentHash: string): void {
    if (key.keyHash === currentHash) {
      return;
    }
    this.keyHashIndex.delete(key.keyHash);
    key.keyHash = currentHash;
    this.keyHashIndex.set(currentHash, key.id);
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

    const candidates = apiKeyHashCandidates(secretKey.trim());
    const keyId = this.findOrReloadKeyId(candidates.hashes);
    if (!keyId) {
      return { valid: false, error: 'Invalid or non-existent API key' };
    }

    const key = this.keys.get(keyId);
    if (!key) {
      return { valid: false, error: 'Invalid or non-existent API key' };
    }

    if (key.previousKeyHash && candidates.hashes.includes(key.previousKeyHash)) {
      if (key.graceExpiresAt && Date.now() > key.graceExpiresAt) {
        return { valid: false, error: 'Previous API key has expired following key rotation' };
      }
    }

    const constraintError = this.validateKeyConstraints(key, clientIp);
    if (constraintError) {
      return { valid: false, error: constraintError };
    }

    const userRecord = await redisUserStore.findById(key.userId);
    if (!userRecord) {
      return { valid: false, error: 'User associated with API key not found' };
    }

    // Only migrate hash if verifying against current secret
    if (!key.previousKeyHash || !candidates.hashes.includes(key.previousKeyHash)) {
      this.migrateKeyHash(key, candidates.currentHash);
    }
    key.lastUsedAt = Date.now();
    this.persist();

    const decryptedKey: ApiKey = {
      ...key,
      webhookSecret: decryptSecret(key.webhookSecret),
    };

    return {
      valid: true,
      key: decryptedKey,
      user: redisUserStore.sanitizeUser(userRecord),
    };
  }

  public async listApiKeys(userId: string): Promise<ApiKey[]> {
    this.ensureInitialized();
    const result: ApiKey[] = [];
    for (const key of this.keys.values()) {
      if (key.userId === userId) {
        result.push({
          ...key,
          webhookSecret: decryptSecret(key.webhookSecret),
        });
      }
    }
    return result.sort((a, b) => b.createdAt - a.createdAt);
  }

  public async rotateApiKey(
    userId: string,
    keyId: string,
    options: ApiKeyRotateOptions = {}
  ): Promise<ApiKeyRotateResult | null> {
    this.ensureInitialized();
    const key = this.keys.get(keyId);
    if (!key || key.userId !== userId) {
      return null;
    }
    if (key.status !== 'active') {
      return null;
    }

    const rawRandom = crypto.randomBytes(24).toString('hex');
    const newSecretKey = `ec_live_${rawRandom}`;
    const newKeyHash = hashApiKeySecret(newSecretKey);
    const prefix = `${newSecretKey.substring(0, 12)}...`;

    const gracePeriodSeconds = Math.max(0, Math.min(options.gracePeriodSeconds ?? 3600, 7 * 24 * 3600));
    const graceExpiresAt = Date.now() + gracePeriodSeconds * 1000;

    key.previousKeyHash = key.keyHash;
    key.graceExpiresAt = graceExpiresAt;
    key.keyHash = newKeyHash;
    key.prefix = prefix;

    this.keyHashIndex.set(newKeyHash, key.id);
    this.persist();

    return {
      key: {
        ...key,
        webhookSecret: decryptSecret(key.webhookSecret),
      },
      newSecretKey,
      graceExpiresAt,
    };
  }

  public async updateApiKey(
    userId: string,
    keyId: string,
    updates: ApiKeyUpdateOptions
  ): Promise<ApiKey | null> {
    this.ensureInitialized();
    const key = this.keys.get(keyId);
    if (!key || key.userId !== userId || key.status !== 'active') {
      return null;
    }

    if (updates.name !== undefined) {
      key.name = updates.name.trim() || key.name;
    }
    if (updates.allowedIps !== undefined) {
      key.allowedIps = updates.allowedIps;
    }
    if (updates.webhookUrl !== undefined) {
      key.webhookUrl = updates.webhookUrl;
    }
    if (updates.webhookSecret !== undefined) {
      key.webhookSecret = encryptSecret(updates.webhookSecret);
    }
    if (updates.scopes !== undefined) {
      key.scopes = updates.scopes;
    }
    if (updates.expiresAt !== undefined) {
      key.expiresAt = updates.expiresAt;
    }

    this.persist();
    return {
      ...key,
      webhookSecret: decryptSecret(key.webhookSecret),
    };
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
    if (key.previousKeyHash) {
      this.keyHashIndex.delete(key.previousKeyHash);
    }
    this.persist();
    return true;
  }

  public markKeyExpiryNotified(keyId: string, timestamp: number): void {
    const k = this.keys.get(keyId);
    if (k) {
      k.lastExpiryNotifiedAt = timestamp;
      this.persist();
    }
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
