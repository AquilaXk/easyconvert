import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import { redisKeyStore } from './redis-key-store';
import { clearKeysMatching } from '../redis/clear-keys';

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

/** Most endpoint records (rotations with an `endpointId`) one owner may hold; a rotation of an existing one is always allowed. */
export const MAX_ENDPOINT_SECRET_RECORDS_PER_OWNER = 25;
/** How long a record of an endpoint lives after its last rotation. Records of an API key end with the key and have no expiry. */
export const ENDPOINT_SECRET_RECORD_TTL_SECONDS = 90 * 24 * 60 * 60;
const HTTP_CONFLICT = 409;

export interface RotateSecretOptions {
  /**
   * Marks the target as an endpoint: its record expires after ENDPOINT_SECRET_RECORD_TTL_SECONDS, and a new one is refused with
   * WebhookEndpointLimitError while the owner already holds this many.
   */
  endpointLimit?: number;
}

export interface RotateSecretResult {
  newSecret: string;
  expiresAt: number;
  graceSeconds: number;
  previousExpiresAt?: number;
}

const HTTP_BAD_REQUEST = 400;

/** A webhook secret operation named no target (endpoint or API key). There is no shared default target. */
export class WebhookTargetRequiredError extends Error {
  readonly status = HTTP_BAD_REQUEST;

  constructor(message = 'A webhook target id is required: pass endpointId or apiKeyId.') {
    super(message);
    this.name = 'WebhookTargetRequiredError';
  }
}

/** The owner already holds the most endpoint records a rotation may create. */
export class WebhookEndpointLimitError extends Error {
  readonly status = HTTP_CONFLICT;

  constructor(readonly limit: number) {
    super(`At most ${limit} webhook endpoints can hold a signing secret. Rotate an existing endpoint or use an API key id.`);
    this.name = 'WebhookEndpointLimitError';
  }
}

/** The first candidate that is a non-blank string; throws WebhookTargetRequiredError when there is none. */
export function requireWebhookTargetId(...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate;
  }
  throw new WebhookTargetRequiredError();
}

export interface WebhookSecretStore {
  getSecretRecord(ownerUserId: string, targetId: string): Promise<WebhookSecretRecord | null>;
  setPrimarySecret(ownerUserId: string, targetId: string, secret: string): Promise<void>;
  /**
   * Stores `secret` as the primary secret of the target when it has no record yet, and answers whether it did. A record that
   * exists is never replaced, so a rotation that wrote one in the meantime keeps it.
   */
  seedPrimarySecretIfAbsent(ownerUserId: string, targetId: string, secret: string): Promise<boolean>;
  /** Atomic: concurrent rotations of one target each keep the secret they replace as the previous one in turn. */
  rotateSecret(
    ownerUserId: string,
    targetId: string,
    graceSeconds?: number,
    options?: RotateSecretOptions
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

/** The one place a record key is built, so no operation can reach a record without naming its target. */
function buildSecretStorageKey(ownerUserId: string, targetId: string): string {
  return `${secretKeyPrefix(ownerUserId)}${sanitizedTargetId(targetId)}`;
}

/** What every record key of the owner starts with. */
function secretKeyPrefix(ownerUserId: string): string {
  return `webhook:sec:{${ownerUserId.replace(/[{}]/g, '_')}}:`;
}

function sanitizedTargetId(targetId: string): string {
  return requireWebhookTargetId(targetId).replace(/[{}]/g, '_');
}

/** The set of the endpoint targets an owner holds a record for; same `{owner}` tag as the records, so one script reaches both. */
function buildEndpointIndexKey(ownerUserId: string): string {
  return `webhook:sec-endpoints:{${ownerUserId.replace(/[{}]/g, '_')}}`;
}

function clampGraceSeconds(graceSeconds: number): number {
  return Math.max(60, Math.min(graceSeconds, 604800));
}

/**
 * Rotates one record in a single step, so two concurrent rotations never both read the same primary and lose one grace secret.
 * KEYS[1] record, KEYS[2] endpoint index. ARGV: new encrypted primary, now, previous expiry, endpoint flag (1/0), endpoint limit,
 * record TTL seconds, record key prefix (with the owner tag), target id. Answers 0 when a new endpoint record would pass the
 * limit, 1 for a first record, 2 when it replaced one.
 */
export const ROTATE_WEBHOOK_SECRET_LUA = `
local raw = redis.call('GET', KEYS[1])
local existing = nil
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and type(decoded) == 'table' and decoded.primaryEncrypted then existing = decoded end
end
local isEndpoint = ARGV[4] == '1'
if isEndpoint and not existing then
  local live = 0
  for _, member in ipairs(redis.call('SMEMBERS', KEYS[2])) do
    if redis.call('EXISTS', ARGV[7] .. member) == 1 then
      live = live + 1
    else
      redis.call('SREM', KEYS[2], member)
    end
  end
  if live >= tonumber(ARGV[5]) then return 0 end
end
local now = tonumber(ARGV[2])
local record = { primaryEncrypted = ARGV[1], createdAt = now, rotatedAt = now }
if existing then
  record.createdAt = existing.createdAt or now
  record.previousEncrypted = existing.primaryEncrypted
  record.previousExpiresAt = tonumber(ARGV[3])
end
redis.call('SET', KEYS[1], cjson.encode(record))
if isEndpoint then
  redis.call('SADD', KEYS[2], ARGV[8])
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[6]))
  redis.call('EXPIRE', KEYS[2], tonumber(ARGV[6]))
end
if existing then return 2 end
return 1
`;

export class InMemoryWebhookSecretStore implements WebhookSecretStore {
  private readonly store = new Map<string, StoredWebhookSecretRecord>();
  /** The record keys of the endpoint targets of each owner (the Redis index set). */
  private readonly endpointIndex = new Map<string, Set<string>>();
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

  public async seedPrimarySecretIfAbsent(ownerUserId: string, targetId: string, secret: string): Promise<boolean> {
    const key = buildSecretStorageKey(ownerUserId, targetId);
    if (this.store.has(key)) return false;
    this.store.set(key, { primaryEncrypted: encryptWebhookSecret(secret), createdAt: this.clock() });
    return true;
  }

  public async rotateSecret(
    ownerUserId: string,
    targetId: string,
    graceSeconds: number = 86400,
    options: RotateSecretOptions = {}
  ): Promise<RotateSecretResult> {
    const clampedGrace = clampGraceSeconds(graceSeconds);
    const now = this.clock();
    const expiresAt = now + clampedGrace * 1000;
    const key = buildSecretStorageKey(ownerUserId, targetId);
    const existing = this.store.get(key);
    const indexKey = buildEndpointIndexKey(ownerUserId);
    const isEndpoint = options.endpointLimit !== undefined;
    if (isEndpoint && !existing && (this.endpointIndex.get(indexKey)?.size ?? 0) >= options.endpointLimit!) {
      throw new WebhookEndpointLimitError(options.endpointLimit!);
    }

    const newSecret = generateWebhookSecret();
    const newEncrypted = encryptWebhookSecret(newSecret);

    this.store.set(key, {
      primaryEncrypted: newEncrypted,
      previousEncrypted: existing?.primaryEncrypted,
      previousExpiresAt: existing ? expiresAt : undefined,
      createdAt: existing?.createdAt || now,
      rotatedAt: now,
    });
    if (isEndpoint) {
      const members = this.endpointIndex.get(indexKey) ?? new Set<string>();
      members.add(sanitizedTargetId(targetId));
      this.endpointIndex.set(indexKey, members);
    }

    return {
      newSecret,
      expiresAt,
      graceSeconds: clampedGrace,
      previousExpiresAt: existing ? expiresAt : undefined,
    };
  }

  public async deleteSecretRecord(ownerUserId: string, targetId: string): Promise<boolean> {
    const key = buildSecretStorageKey(ownerUserId, targetId);
    this.endpointIndex.get(buildEndpointIndexKey(ownerUserId))?.delete(sanitizedTargetId(targetId));
    return this.store.delete(key);
  }

  public reset(): Promise<void> {
    this.store.clear();
    this.endpointIndex.clear();
    return Promise.resolve();
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

  public async seedPrimarySecretIfAbsent(ownerUserId: string, targetId: string, secret: string): Promise<boolean> {
    const record: StoredWebhookSecretRecord = { primaryEncrypted: encryptWebhookSecret(secret), createdAt: this.clock() };
    return (await this.redis.set(buildSecretStorageKey(ownerUserId, targetId), JSON.stringify(record), 'NX')) === 'OK';
  }

  public async rotateSecret(
    ownerUserId: string,
    targetId: string,
    graceSeconds: number = 86400,
    options: RotateSecretOptions = {}
  ): Promise<RotateSecretResult> {
    const clampedGrace = clampGraceSeconds(graceSeconds);
    const now = this.clock();
    const expiresAt = now + clampedGrace * 1000;
    const key = buildSecretStorageKey(ownerUserId, targetId);
    const newSecret = generateWebhookSecret();
    const isEndpoint = options.endpointLimit !== undefined;

    const outcome = Number(
      await this.redis.eval(
        ROTATE_WEBHOOK_SECRET_LUA,
        2,
        key,
        buildEndpointIndexKey(ownerUserId),
        encryptWebhookSecret(newSecret),
        String(now),
        String(expiresAt),
        isEndpoint ? '1' : '0',
        String(options.endpointLimit ?? 0),
        String(ENDPOINT_SECRET_RECORD_TTL_SECONDS),
        secretKeyPrefix(ownerUserId),
        sanitizedTargetId(targetId)
      )
    );
    if (outcome === 0) throw new WebhookEndpointLimitError(options.endpointLimit!);

    return {
      newSecret,
      expiresAt,
      graceSeconds: clampedGrace,
      previousExpiresAt: outcome === 2 ? expiresAt : undefined,
    };
  }

  public async deleteSecretRecord(ownerUserId: string, targetId: string): Promise<boolean> {
    const key = buildSecretStorageKey(ownerUserId, targetId);
    await this.redis.srem(buildEndpointIndexKey(ownerUserId), sanitizedTargetId(targetId));
    const count = await this.redis.del(key);
    return count > 0;
  }

  public async reset(): Promise<void> {
    await clearKeysMatching(this.redis, ['webhook:sec:*', 'webhook:sec-endpoints:*']);
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
