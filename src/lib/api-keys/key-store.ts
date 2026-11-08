import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hmacSha256, sha256 } from '../auth/crypto';
import { redisUserStore } from '../auth/redis-user-store';
import { isAnonymousUserId } from '../auth/anonymous-identity';
import type { User, UserTier } from '../auth/types';
import type { ApiKey, ApiKeyCreateOptions, ApiKeyCreateResult, QuotaUsage, UserConversionFile } from './types';
import { isIpAllowed } from './ip-utils';
import { TIER_LIMITS, getAnonymousDailyLimit } from '../plan-limits';
import { globalSharedObjects } from '../storage/shared-store';
import { resolveRetentionPolicy } from '../storage/result-retention';
import { encryptSecret, decryptSecret, reencryptSecretIfNeeded } from './secret-encryption';
import { InvalidWebhookConfigError, resolveEffectiveWebhook } from '../security/ssrf';
import type { ApiKeyRotateOptions, ApiKeyRotateResult, ApiKeyUpdateOptions } from './types';

const MODULE_STORAGE_DIR = path.resolve(process.cwd(), '.easyconvert');

function resolveStorageDir(): string {
  if ('mock' in process.cwd) {
    return path.resolve(process.cwd(), '.easyconvert');
  }
  return MODULE_STORAGE_DIR;
}

export { TIER_LIMITS, getAnonymousDailyLimit };

const KEY_HASH_PEPPER_ENV = 'KEY_HASH_PEPPER';
const KEY_HASH_PEPPER_PREVIOUS_ENV = 'KEY_HASH_PEPPER_PREVIOUS';
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
  hashes: string[];
  currentHash: string;
}

export function apiKeyHashCandidates(secret: string): ApiKeyHashCandidates {
  const currentHash = hashApiKeySecret(secret);
  const candidates: string[] = [currentHash];
  const previousPepper = process.env[KEY_HASH_PEPPER_PREVIOUS_ENV];
  if (previousPepper) {
    candidates.push(hmacSha256(previousPepper, secret));
  }
  candidates.push(sha256(secret));
  return { hashes: Array.from(new Set(candidates)), currentHash };
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
  protected static sharedTokenBuckets = new Map<string, { tokens: number; lastRefill: number }>();
  protected static sharedInitialized = false;

  protected readonly keys: Map<string, ApiKey>;
  protected readonly keyHashIndex: Map<string, string>; // hash -> keyId
  protected readonly dailyUsage: Map<string, number>; // userId:YYYY-MM-DD -> count
  protected readonly userFiles: Map<string, UserConversionFile>; // fileId -> file
  protected readonly tokenBuckets: Map<string, { tokens: number; lastRefill: number }>;
  protected initialized: boolean;
  private readonly storageDir: string;
  private readonly keysFile: string;
  private readonly usageFile: string;
  private readonly filesFile: string;

  constructor(isolated = false) {
    this.storageDir = resolveStorageDir();
    this.keysFile = path.join(this.storageDir, 'api-keys.json');
    this.usageFile = path.join(this.storageDir, 'api-usage.json');
    this.filesFile = path.join(this.storageDir, 'user-files.json');
    if (isolated) {
      this.keys = new Map();
      this.keyHashIndex = new Map();
      this.dailyUsage = new Map();
      this.userFiles = new Map();
      this.tokenBuckets = new Map();
      this.initialized = false;
    } else {
      this.keys = KeyStore.sharedKeys;
      this.keyHashIndex = KeyStore.sharedKeyHashIndex;
      this.dailyUsage = KeyStore.sharedDailyUsage;
      this.userFiles = KeyStore.sharedUserFiles;
      this.tokenBuckets = KeyStore.sharedTokenBuckets;
      this.initialized = KeyStore.sharedInitialized;
    }
  }

  protected upsertKeyInMemory(key: ApiKey): void {
    const existing = this.keys.get(key.id);
    if (existing) {
      this.keyHashIndex.delete(existing.keyHash);
      if (existing.previousKeyHash) {
        this.keyHashIndex.delete(existing.previousKeyHash);
      }
    }
    this.keys.set(key.id, key);
    this.keyHashIndex.set(key.keyHash, key.id);
    if (key.previousKeyHash) {
      this.keyHashIndex.set(key.previousKeyHash, key.id);
    }
  }

  protected reloadKeysFromDisk(): void {
    if (!fs.existsSync(this.keysFile)) return;
    const list: ApiKey[] = JSON.parse(fs.readFileSync(this.keysFile, 'utf-8'));
    for (const k of list) {
      this.upsertKeyInMemory(k);
    }
  }

  protected ensureInitialized() {
    if (this.initialized) return;
    this.initialized = true;
    if (this.keys === KeyStore.sharedKeys) {
      KeyStore.sharedInitialized = true;
    }

    try {
      this.reloadKeysFromDisk();

      if (fs.existsSync(this.usageFile)) {
        const usageObj: Record<string, number> = JSON.parse(fs.readFileSync(this.usageFile, 'utf-8'));
        for (const [key, val] of Object.entries(usageObj)) {
          this.dailyUsage.set(key, val);
        }
      }

      if (fs.existsSync(this.filesFile)) {
        const filesList: UserConversionFile[] = JSON.parse(fs.readFileSync(this.filesFile, 'utf-8'));
        for (const f of filesList) {
          this.userFiles.set(f.id, f);
        }
      }
    } catch {}
  }

  protected persist() {
    this.ensureInitialized();
    try {
      if (!fs.existsSync(this.storageDir)) {
        fs.mkdirSync(this.storageDir, { recursive: true });
      }

      fs.writeFileSync(this.keysFile, JSON.stringify(Array.from(this.keys.values()), null, 2), 'utf-8');

      const usageObj: Record<string, number> = {};
      for (const [key, val] of this.dailyUsage.entries()) {
        usageObj[key] = val;
      }
      fs.writeFileSync(this.usageFile, JSON.stringify(usageObj, null, 2), 'utf-8');

      fs.writeFileSync(this.filesFile, JSON.stringify(Array.from(this.userFiles.values()), null, 2), 'utf-8');
    } catch {}
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
      acceptedTermsVersion: options.acceptedTermsVersion,
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
    if (!keyId && fs.existsSync(this.keysFile)) {
      try {
        this.reloadKeysFromDisk();
        keyId = this.lookupKeyId(candidateHashes);
      } catch {}
    }
    return keyId;
  }

  protected reencryptWebhookSecret(key: ApiKey): boolean {
    if (!key.webhookSecret) {
      return false;
    }
    const { cipherText, reencrypted } = reencryptSecretIfNeeded(key.webhookSecret);
    if (reencrypted) {
      key.webhookSecret = cipherText;
      return true;
    }
    return false;
  }

  protected migrateKeyHash(key: ApiKey, currentHash: string): boolean {
    const secretMigrated = this.reencryptWebhookSecret(key);
    if (key.keyHash === currentHash) {
      return secretMigrated;
    }
    if (key.keyHash !== key.previousKeyHash) {
      this.keyHashIndex.delete(key.keyHash);
    }
    key.keyHash = currentHash;
    this.keyHashIndex.set(currentHash, key.id);
    return true;
  }

  protected migratePreviousKeyHash(key: ApiKey, currentHash: string): boolean {
    const secretMigrated = this.reencryptWebhookSecret(key);
    if (!key.previousKeyHash || key.previousKeyHash === currentHash) {
      return secretMigrated;
    }
    if (key.previousKeyHash !== key.keyHash) {
      this.keyHashIndex.delete(key.previousKeyHash);
    }
    key.previousKeyHash = currentHash;
    this.keyHashIndex.set(currentHash, key.id);
    return true;
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

    const matchedCurrentKey = candidates.hashes.includes(key.keyHash);
    const matchedPreviousKey =
      !matchedCurrentKey && Boolean(key.previousKeyHash && candidates.hashes.includes(key.previousKeyHash));
    if (!matchedCurrentKey && !matchedPreviousKey) {
      return { valid: false, error: 'Invalid or non-existent API key' };
    }
    if (matchedPreviousKey) {
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

    if (matchedPreviousKey) {
      this.migratePreviousKeyHash(key, candidates.currentHash);
    } else {
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

    const plainWebhookSecret = key.webhookSecret
      ? reencryptSecretIfNeeded(key.webhookSecret)
      : { plainText: undefined, cipherText: undefined, reencrypted: false };
    if (plainWebhookSecret.reencrypted) {
      key.webhookSecret = plainWebhookSecret.cipherText;
    }

    const rawRandom = crypto.randomBytes(24).toString('hex');
    const newSecretKey = `ec_live_${rawRandom}`;
    const newKeyHash = hashApiKeySecret(newSecretKey);
    const prefix = `${newSecretKey.substring(0, 12)}...`;

    const gracePeriodSeconds = Math.max(0, Math.min(options.gracePeriodSeconds ?? 3600, 7 * 24 * 3600));
    const graceExpiresAt = Date.now() + gracePeriodSeconds * 1000;

    const outgoingPreviousHash = key.previousKeyHash;
    if (outgoingPreviousHash && outgoingPreviousHash !== key.keyHash && outgoingPreviousHash !== newKeyHash) {
      this.keyHashIndex.delete(outgoingPreviousHash);
    }
    key.previousKeyHash = key.keyHash;
    key.graceExpiresAt = graceExpiresAt;
    key.keyHash = newKeyHash;
    key.prefix = prefix;

    this.keyHashIndex.set(key.previousKeyHash, key.id);
    this.keyHashIndex.set(newKeyHash, key.id);
    this.persist();

    return {
      key: {
        ...key,
        webhookSecret: plainWebhookSecret.plainText,
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

    const nextWebhookUrl = updates.webhookUrl !== undefined ? updates.webhookUrl.trim() : undefined;
    const nextWebhookSecret = updates.webhookSecret !== undefined ? updates.webhookSecret.trim() : undefined;

    if (nextWebhookUrl !== undefined || nextWebhookSecret !== undefined) {
      const effectiveUrl = nextWebhookUrl !== undefined ? (nextWebhookUrl || undefined) : key.webhookUrl;
      const effectiveSecret =
        nextWebhookSecret !== undefined
          ? (nextWebhookSecret || undefined)
          : decryptSecret(key.webhookSecret);
      const resolved = resolveEffectiveWebhook(undefined, undefined, effectiveUrl, effectiveSecret);
      if (resolved.error) {
        throw new InvalidWebhookConfigError(resolved.error);
      }
    }

    if (updates.name !== undefined) {
      key.name = updates.name.trim() || key.name;
    }
    if (updates.allowedIps !== undefined) {
      key.allowedIps = updates.allowedIps;
    }
    if (nextWebhookUrl !== undefined) {
      key.webhookUrl = nextWebhookUrl || undefined;
    }
    if (nextWebhookSecret !== undefined) {
      key.webhookSecret = nextWebhookSecret ? encryptSecret(nextWebhookSecret) : undefined;
    } else {
      this.reencryptWebhookSecret(key);
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
    this.tokenBuckets.delete(`apikey:${keyId}`);
    this.persist();
    return true;
  }

  public markKeyExpiryNotified(keyId: string, timestamp: number): void {
    this.ensureInitialized();
    const k = this.keys.get(keyId);
    if (k) {
      k.lastExpiryNotifiedAt = timestamp;
      this.persist();
    }
  }

  public async getQuotaUsage(userId: string): Promise<QuotaUsage> {
    this.ensureInitialized();

    const isAnonymous = isAnonymousUserId(userId);
    const user = isAnonymous ? null : await redisUserStore.findById(userId);
    const tier: UserTier = user?.tier || 'free';
    const dailyLimit = isAnonymous ? getAnonymousDailyLimit() : TIER_LIMITS[tier];

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

    const isAnonymous = isAnonymousUserId(userId);
    const user = isAnonymous ? null : await redisUserStore.findById(userId);
    const tier: UserTier = user?.tier ?? 'free';
    const dailyLimit = isAnonymous ? getAnonymousDailyLimit() : TIER_LIMITS[tier];

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
    storageKey?: string;
    ttlMs?: number;
  }): Promise<UserConversionFile> {
    this.ensureInitialized();

    const now = Date.now();
    let downloadUrl = data.downloadUrl;
    let storageKey = data.storageKey;
    if (downloadUrl?.startsWith('data:')) {
      storageKey = `conversions/${data.userId}/${Date.now()}_${encodeURIComponent(data.fileName)}`;
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
      storageKey,
      createdAt: now,
      expiresAt: now + (data.ttlMs ?? resolveRetentionPolicy().undeliveredTtlMs),
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

  /** The record of the file `fileId` when it is `userId`'s own, else undefined. */
  public async findUserFile(userId: string, fileId: string): Promise<UserConversionFile | undefined> {
    this.ensureInitialized();
    const file = this.userFiles.get(fileId);
    return file?.userId === userId ? file : undefined;
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

  /** Removes the daily conversion counts and file listings of `userId` kept in this process, and answers how many it removed. */
  public forgetUsage(userId: string): number {
    this.ensureInitialized();
    const owned = [...this.dailyUsage.keys()].filter((dateKey) => dateKey.startsWith(`${userId}:`));
    owned.forEach((dateKey) => this.dailyUsage.delete(dateKey));
    const ownedFiles = [...this.userFiles.entries()].filter(([, file]) => file.userId === userId);
    for (const [id, file] of ownedFiles) {
      if (file.storageKey) globalSharedObjects.delete(file.storageKey);
      this.userFiles.delete(id);
    }
    const removed = owned.length + ownedFiles.length;
    if (removed > 0) this.persist();
    return removed;
  }

  public resetStore() {
    this.keys.clear();
    this.keyHashIndex.clear();
    this.dailyUsage.clear();
    this.userFiles.clear();
    this.tokenBuckets.clear();
    this.initialized = true;
    if (this.keys === KeyStore.sharedKeys) {
      KeyStore.sharedInitialized = true;
    }

    try {
      if (fs.existsSync(this.keysFile)) fs.unlinkSync(this.keysFile);
      if (fs.existsSync(this.usageFile)) fs.unlinkSync(this.usageFile);
      if (fs.existsSync(this.filesFile)) fs.unlinkSync(this.filesFile);
    } catch {}
  }
}

export const keyStore = new KeyStore();
