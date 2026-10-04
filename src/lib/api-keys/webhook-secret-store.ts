import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import { redisKeyStore } from './redis-key-store';

export interface WebhookSecretRecord {
  primary: string;
  previous?: string;
  previousExpiresAt?: number;
  createdAt: number;
  rotatedAt?: number;
}

export interface StoredWebhookSecretRecord {
  primaryEncrypted: string;
  previousEncrypted?: string;
  previousExpiresAt?: number;
  createdAt: number;
  rotatedAt?: number;
}

export interface RotateSecretResult {
  newSecret: string;
  expiresAt: number;
  graceSeconds: number;
  previousExpiresAt?: number;
}

export interface WebhookSecretStore {
  getSecretRecord(ownerUserId: string, targetId: string): Promise<WebhookSecretRecord | null>;
  setPrimarySecret(ownerUserId: string, targetId: string, secret: string): Promise<void>;
  rotateSecret(
    ownerUserId: string,
    targetId: string,
    graceSeconds?: number
  ): Promise<RotateSecretResult>;
  deleteSecretRecord(ownerUserId: string, targetId: string): Promise<boolean>;
  reset(): Promise<void>;
}

const ENCRYPTION_PREFIX = 'enc:wh:v1:';
let kekWarningEmitted = false;

export function getWebhookKek(): Buffer {
  const kek = process.env.WEBHOOK_SECRET_KEK;
  if (!kek) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        '[WebhookSecretStore] FATAL: WEBHOOK_SECRET_KEK environment variable is required in production.'
      );
    }
    if (!kekWarningEmitted) {
      kekWarningEmitted = true;
      console.warn(
        '[WebhookSecretStore] WEBHOOK_SECRET_KEK is not set; using development fallback key.'
      );
    }
    return crypto.createHash('sha256').update('easyconvert-dev-webhook-kek-salt').digest();
  }
  return crypto.createHash('sha256').update(kek).digest();
}

/**
 * Encrypts a webhook secret with AES-256-GCM envelope encryption.
 */
export function encryptWebhookSecret(plainSecret: string): string {
  if (plainSecret.startsWith(ENCRYPTION_PREFIX)) {
    return plainSecret;
  }
  const key = getWebhookKek();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainSecret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${ENCRYPTION_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Decrypts an AES-256-GCM encrypted webhook secret.
 */
export function decryptWebhookSecret(cipherText: string): string {
  if (!cipherText.startsWith(ENCRYPTION_PREFIX)) {
    return cipherText;
  }
  const payload = cipherText.substring(ENCRYPTION_PREFIX.length);
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('[WebhookSecretStore] Malformed encrypted payload structure.');
  }

  const [ivB64, tagB64, encB64] = parts;
  const key = getWebhookKek();
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const enc = Buffer.from(encB64, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(enc), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Generates an enterprise-grade random webhook secret prefixed with `whsec_`.
 */
export function generateWebhookSecret(): string {
  return `whsec_${crypto.randomBytes(32).toString('hex')}`;
}

function buildSecretStorageKey(ownerUserId: string, targetId: string): string {
  const sanitizedUser = ownerUserId.replace(/[{}]/g, '_');
  const sanitizedTarget = targetId.replace(/[{}]/g, '_');
  return `webhook:sec:{${sanitizedUser}}:${sanitizedTarget}`;
}

export class InMemoryWebhookSecretStore implements WebhookSecretStore {
  private readonly store = new Map<string, StoredWebhookSecretRecord>();
  private readonly clock: () => number;

  constructor(options?: { clock?: () => number }) {
    this.clock = options?.clock || (() => Date.now());
  }

  public async getSecretRecord(
    ownerUserId: string,
    targetId: string
  ): Promise<WebhookSecretRecord | null> {
    const key = buildSecretStorageKey(ownerUserId, targetId);
    const stored = this.store.get(key);
    if (!stored) return null;

    const primary = decryptWebhookSecret(stored.primaryEncrypted);
    let previous: string | undefined;
    if (stored.previousEncrypted) {
      previous = decryptWebhookSecret(stored.previousEncrypted);
    }

    return {
      primary,
      previous,
      previousExpiresAt: stored.previousExpiresAt,
      createdAt: stored.createdAt,
      rotatedAt: stored.rotatedAt,
    };
  }

  public async setPrimarySecret(
    ownerUserId: string,
    targetId: string,
    secret: string
  ): Promise<void> {
    const key = buildSecretStorageKey(ownerUserId, targetId);
    const primaryEncrypted = encryptWebhookSecret(secret);
    const existing = this.store.get(key);
    const now = this.clock();

    this.store.set(key, {
      primaryEncrypted,
      createdAt: existing?.createdAt || now,
      rotatedAt: existing?.rotatedAt,
    });
  }

  public async rotateSecret(
    ownerUserId: string,
    targetId: string,
    graceSeconds: number = 86400
  ): Promise<RotateSecretResult> {
    const clampedGrace = Math.max(60, Math.min(graceSeconds, 604800));
    const now = this.clock();
    const expiresAt = now + clampedGrace * 1000;
    const key = buildSecretStorageKey(ownerUserId, targetId);
    const existing = this.store.get(key);

    const newSecret = generateWebhookSecret();
    const newEncrypted = encryptWebhookSecret(newSecret);

    this.store.set(key, {
      primaryEncrypted: newEncrypted,
      previousEncrypted: existing?.primaryEncrypted,
      previousExpiresAt: existing ? expiresAt : undefined,
      createdAt: existing?.createdAt || now,
      rotatedAt: now,
    });

    return {
      newSecret,
      expiresAt,
      graceSeconds: clampedGrace,
      previousExpiresAt: existing ? expiresAt : undefined,
    };
  }

  public async deleteSecretRecord(ownerUserId: string, targetId: string): Promise<boolean> {
    const key = buildSecretStorageKey(ownerUserId, targetId);
    return this.store.delete(key);
  }

  public async reset(): Promise<void> {
    this.store.clear();
  }
}

export class RedisWebhookSecretStore implements WebhookSecretStore {
  private readonly redis: Redis;
  private readonly clock: () => number;

  constructor(options: { redisClient: Redis; clock?: () => number }) {
    this.redis = options.redisClient;
    this.clock = options.clock || (() => Date.now());
  }

  public async getSecretRecord(
    ownerUserId: string,
    targetId: string
  ): Promise<WebhookSecretRecord | null> {
    const key = buildSecretStorageKey(ownerUserId, targetId);
    const raw = await this.redis.get(key);
    if (!raw) return null;

    try {
      const stored = JSON.parse(raw) as StoredWebhookSecretRecord;
      const primary = decryptWebhookSecret(stored.primaryEncrypted);
      let previous: string | undefined;
      if (stored.previousEncrypted) {
        previous = decryptWebhookSecret(stored.previousEncrypted);
      }

      return {
        primary,
        previous,
        previousExpiresAt: stored.previousExpiresAt,
        createdAt: stored.createdAt,
        rotatedAt: stored.rotatedAt,
      };
    } catch {
      return null;
    }
  }

  public async setPrimarySecret(
    ownerUserId: string,
    targetId: string,
    secret: string
  ): Promise<void> {
    const key = buildSecretStorageKey(ownerUserId, targetId);
    const primaryEncrypted = encryptWebhookSecret(secret);
    const existingRaw = await this.redis.get(key);
    let existing: StoredWebhookSecretRecord | undefined;
    if (existingRaw) {
      try {
        existing = JSON.parse(existingRaw);
      } catch {}
    }
    const now = this.clock();

    const record: StoredWebhookSecretRecord = {
      primaryEncrypted,
      createdAt: existing?.createdAt || now,
      rotatedAt: existing?.rotatedAt,
    };

    await this.redis.set(key, JSON.stringify(record));
  }

  public async rotateSecret(
    ownerUserId: string,
    targetId: string,
    graceSeconds: number = 86400
  ): Promise<RotateSecretResult> {
    const clampedGrace = Math.max(60, Math.min(graceSeconds, 604800));
    const now = this.clock();
    const expiresAt = now + clampedGrace * 1000;
    const key = buildSecretStorageKey(ownerUserId, targetId);

    const existingRaw = await this.redis.get(key);
    let existing: StoredWebhookSecretRecord | undefined;
    if (existingRaw) {
      try {
        existing = JSON.parse(existingRaw);
      } catch {}
    }

    const newSecret = generateWebhookSecret();
    const newEncrypted = encryptWebhookSecret(newSecret);

    const record: StoredWebhookSecretRecord = {
      primaryEncrypted: newEncrypted,
      previousEncrypted: existing?.primaryEncrypted,
      previousExpiresAt: existing ? expiresAt : undefined,
      createdAt: existing?.createdAt || now,
      rotatedAt: now,
    };

    await this.redis.set(key, JSON.stringify(record));

    return {
      newSecret,
      expiresAt,
      graceSeconds: clampedGrace,
      previousExpiresAt: existing ? expiresAt : undefined,
    };
  }

  public async deleteSecretRecord(ownerUserId: string, targetId: string): Promise<boolean> {
    const key = buildSecretStorageKey(ownerUserId, targetId);
    const count = await this.redis.del(key);
    return count > 0;
  }

  public async reset(): Promise<void> {
    const keys = await this.redis.keys('webhook:sec:*');
    if (keys.length > 0) {
      await Promise.all(keys.map((k) => this.redis.del(k)));
    }
  }
}

let activeWebhookSecretStore: WebhookSecretStore | null = null;

export function getWebhookSecretStore(): WebhookSecretStore {
  if (activeWebhookSecretStore) {
    return activeWebhookSecretStore;
  }
  const redisClient = redisKeyStore.getRedisClient();
  if (redisClient) {
    activeWebhookSecretStore = new RedisWebhookSecretStore({ redisClient });
  } else {
    activeWebhookSecretStore = new InMemoryWebhookSecretStore();
  }
  return activeWebhookSecretStore;
}

export function setWebhookSecretStore(store: WebhookSecretStore | null): void {
  activeWebhookSecretStore = store;
}
