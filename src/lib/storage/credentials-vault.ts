import crypto from 'node:crypto';
import Redis from 'ioredis';
import { pipelineReplies } from '../redis/pipeline-replies';
import { readyGatedRedis, whenReady } from '../redis/when-ready';
import { MIN_PRODUCTION_SEALING_KEY_LENGTH, secretForms } from '../security/secret-forms';

export type StorageProviderType =
  | 's3'
  | 'gcs'
  | 'azure-blob'
  | 'sftp'
  | 'webdav'
  | 'http';

export interface S3Credentials {
  type: 's3';
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  endpoint?: string;
  sessionToken?: string;
  forcePathStyle?: boolean;
}

export interface GcsCredentials {
  type: 'gcs';
  bucket: string;
  projectId?: string;
  clientEmail?: string;
  privateKey?: string;
  serviceAccountKeyJson?: string;
  endpoint?: string;
}

export interface AzureBlobCredentials {
  type: 'azure-blob';
  storageAccount: string;
  containerName: string;
  accountKey?: string;
  sasToken?: string;
  connectionString?: string;
  customEndpoint?: string;
}

export interface SftpCredentials {
  type: 'sftp';
  host: string;
  username: string;
  port?: number;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /** A `known_hosts` line or a public key (ssh-ed25519, ecdsa-sha2-nistp256/384/521, ssh-rsa) the server must show; absent means trust on first use. */
  hostKey?: string;
  basePath?: string;
}

export interface WebDavCredentials {
  type: 'webdav';
  url: string;
  username?: string;
  password?: string;
  basePath?: string;
}

export interface HttpCredentials {
  type: 'http';
  url?: string;
  headers?: Record<string, string>;
  bearerToken?: string;
}

export type CustomerStorageCredentials =
  | S3Credentials
  | GcsCredentials
  | AzureBlobCredentials
  | SftpCredentials
  | WebDavCredentials
  | HttpCredentials;

export interface CredentialSummary {
  id: string;
  userId: string;
  providerType: StorageProviderType;
  name?: string;
  createdAt: number;
  expiresAt?: number;
}

interface StoredCredentialEnvelope {
  id: string;
  userId: string;
  providerType: StorageProviderType;
  name?: string;
  iv: string; // base64
  tag: string; // base64
  encryptedData: string; // base64
  createdAt: number;
  expiresAt?: number;
}

const VAULT_PREFIX = 'vault:cred:';
/**
 * The ids of one user's credentials, a set per user (`vault:user:{<userId>}`, the tag the account's other keys carry, so
 * `erase-account` finds it), so a request lists the credentials of its user and does not read the vault of every user.
 */
const USER_INDEX_PREFIX = 'vault:user:';
/**
 * Set (with a lifetime) while the index is known to hold every credential. Whoever finds it missing indexes the whole vault with one
 * SCAN pass, so credentials written before the index existed, or by a process that does not maintain it, are listed within a day.
 */
const USER_INDEX_MARKER = 'vault:index:complete';
/**
 * Held (with a short lifetime, so a process that dies releases it) by the process that indexes the vault. The marker above is set
 * only when the pass has finished, so a request that finds the pass running lists by scanning the vault and never reads a half-built index.
 */
const USER_INDEX_LOCK = 'vault:index:lock';
const USER_INDEX_LOCK_MS = 10 * 60 * 1000;
const USER_INDEX_REFRESH_MS = 24 * 60 * 60 * 1000;
/** A process asks again whether the index is complete after this long. */
const USER_INDEX_CHECK_MS = 60 * 60 * 1000;
const SCAN_BATCH = 500;

function userIndexKey(userId: string): string {
  return `${USER_INDEX_PREFIX}{${userId.replace(/[{}]/g, '_')}}`;
}

/** The envelope a stored value holds, or undefined when it is not one: a damaged record is logged by its id and left out. */
function parseEnvelope(raw: string, id?: string): StoredCredentialEnvelope | undefined {
  try {
    const envelope = JSON.parse(raw) as Partial<StoredCredentialEnvelope> | null;
    if (envelope && typeof envelope.id === 'string' && typeof envelope.userId === 'string') return envelope as StoredCredentialEnvelope;
  } catch {
    // Reported below.
  }
  console.error(`[CredentialsVault] A stored credential${id ? ` "${id}"` : ''} is damaged and was left out.`);
  return undefined;
}

/**
 * The shared credential store could not be reached. With Redis configured it is the only store:
 * credentials are not kept in process memory instead (a copy other instances cannot see would pass
 * for saved and then vanish on the next request or restart), and a read, list or delete never
 * falls back to such a copy or reports success it could not confirm.
 */
export class CredentialsVaultPersistenceError extends Error {
  readonly code = 'CREDENTIALS_VAULT_UNAVAILABLE';

  constructor(options?: { cause?: unknown; saving?: boolean }) {
    super(
      options?.saving === false
        ? 'Credential storage is unavailable; the request was not completed.'
        : 'Credential storage is unavailable; the credentials were not saved.'
    );
    this.name = 'CredentialsVaultPersistenceError';
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

function deriveVaultKey(secret: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf-8'),
      Buffer.from('easyconvert-storage-salt', 'utf-8'),
      Buffer.from('easyconvert-storage-vault-v1', 'utf-8'),
      32
    )
  );
}

/** Raised when credentials must be sealed but no valid `STORAGE_VAULT_KEY` is configured. Reads are unaffected. */
export class VaultKeyMissingError extends Error {
  readonly code = 'VAULT_KEY_MISSING';

  constructor() {
    super(
      `STORAGE_VAULT_KEY must be set (at least ${MIN_PRODUCTION_SEALING_KEY_LENGTH} characters) in production to store credentials; stored credentials can still be read.`
    );
    this.name = 'VaultKeyMissingError';
  }
}

const DEV_VAULT_MASTER_KEY_SALT = 'easyconvert-dev-vault-master-key-salt';

function deriveDevVaultKey(): Buffer {
  return crypto.createHash('sha256').update(DEV_VAULT_MASTER_KEY_SALT).digest();
}

/** The key new credentials are sealed under, or null when production has no valid `STORAGE_VAULT_KEY`. */
function resolveVaultSealingKey(): Buffer | null {
  const vaultKey = process.env.STORAGE_VAULT_KEY?.trim();
  if (process.env.NODE_ENV === 'production') {
    return vaultKey && vaultKey.length >= MIN_PRODUCTION_SEALING_KEY_LENGTH ? deriveVaultKey(vaultKey) : null;
  }

  const secret = vaultKey || process.env.KEY_ENCRYPTION_KEY?.trim() || process.env.JWT_SECRET?.trim();
  return secret ? deriveVaultKey(secret) : deriveDevVaultKey();
}

function getVaultMasterKey(): Buffer {
  const key = resolveVaultSealingKey();
  if (key === null) {
    throw new VaultKeyMissingError();
  }
  return key;
}

/**
 * Every key a stored record may have been sealed under, the sealing key first when one is valid.
 * Built from the secrets that are set, whatever their length, so a missing or short
 * `STORAGE_VAULT_KEY` never stops a read.
 */
function buildVaultDecryptionCandidates(): { keys: Buffer[]; hasSealingKey: boolean } {
  const sealingKey = resolveVaultSealingKey();
  const derived: Buffer[] = [
    ...(sealingKey === null ? [] : [sealingKey]),
    ...[process.env.STORAGE_VAULT_KEY, process.env.KEY_ENCRYPTION_KEY, process.env.JWT_SECRET]
      .flatMap(secretForms)
      .map(deriveVaultKey),
    ...(process.env.NODE_ENV !== 'production' ? [deriveDevVaultKey()] : []),
  ];

  const seen = new Set<string>();
  const keys: Buffer[] = [];
  for (const key of derived) {
    const hex = key.toString('hex');
    if (!seen.has(hex)) {
      seen.add(hex);
      keys.push(key);
    }
  }
  return { keys, hasSealingKey: sealingKey !== null };
}

export function getVaultDecryptionCandidateKeys(): Buffer[] {
  return buildVaultDecryptionCandidates().keys;
}

function decryptEnvelopeWithCandidateKeys(envelope: StoredCredentialEnvelope): {
  credentials: CustomerStorageCredentials;
  sealedWithCurrentKey: boolean;
} {
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const encryptedData = Buffer.from(envelope.encryptedData, 'base64');
  const { keys: candidateKeys, hasSealingKey } = buildVaultDecryptionCandidates();
  let lastError: unknown;

  for (let i = 0; i < candidateKeys.length; i++) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', candidateKeys[i], iv);
      decipher.setAAD(Buffer.from(envelope.id, 'utf-8'));
      decipher.setAuthTag(tag);

      const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
      const credentials = JSON.parse(decrypted.toString('utf-8')) as CustomerStorageCredentials;
      return { credentials, sealedWithCurrentKey: hasSealingKey && i === 0 };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('[CredentialsVault] No decryption key is configured.');
}

export class CredentialsVault {
  private readonly inMemoryStore = new Map<string, StoredCredentialEnvelope>();
  private readonly redisClient: Redis | null = null;
  private userIndexCheckedUntil = 0;

  constructor(redisClient?: Redis) {
    if (redisClient) {
      this.redisClient = redisClient;
    } else if (process.env.REDIS_URL) {
      // Failures surface on the operation that needs Redis (as a CredentialsVaultPersistenceError).
      this.redisClient = readyGatedRedis(
        new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false })
      );
    }
  }

  /**
   * Encrypts and securely registers customer storage credentials.
   * Returns an opaque reference string starting with "cred_".
   */
  async store(
    userId: string,
    credentials: CustomerStorageCredentials,
    options?: { name?: string; ttlSeconds?: number }
  ): Promise<string> {
    if (!userId || typeof userId !== 'string') {
      throw new Error('[CredentialsVault] userId is required to associate credentials');
    }
    if (!credentials?.type) {
      throw new Error('[CredentialsVault] Invalid credentials payload: missing provider type');
    }
    if (
      options?.ttlSeconds !== undefined &&
      (typeof options.ttlSeconds !== 'number' ||
        !Number.isInteger(options.ttlSeconds) ||
        options.ttlSeconds < 60 ||
        options.ttlSeconds > 90 * 86400)
    ) {
      throw new Error('[CredentialsVault] Invalid ttlSeconds: must be an integer between 60 and 7776000');
    }

    const id = `cred_${crypto.randomBytes(16).toString('hex')}`;
    const plainText = JSON.stringify(credentials);
    const masterKey = getVaultMasterKey();
    const iv = crypto.randomBytes(12);

    const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
    cipher.setAAD(Buffer.from(id, 'utf-8'));

    const encrypted = Buffer.concat([cipher.update(plainText, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const now = Date.now();
    const expiresAt = options?.ttlSeconds ? now + options.ttlSeconds * 1000 : undefined;

    const envelope: StoredCredentialEnvelope = {
      id,
      userId,
      providerType: credentials.type,
      name: options?.name,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      encryptedData: encrypted.toString('base64'),
      createdAt: now,
      expiresAt,
    };

    if (this.redisClient) {
      // A configured Redis is the only store: if the write fails, the save fails.
      try {
        await whenReady(this.redisClient);
        const serialized = JSON.stringify(envelope);
        // The index first: an id without a credential is dropped by the next listing, a credential without an id would never be listed.
        const pipeline = this.redisClient.pipeline().sadd(userIndexKey(userId), id);
        if (options?.ttlSeconds) pipeline.setex(`${VAULT_PREFIX}${id}`, options.ttlSeconds, serialized);
        else pipeline.set(`${VAULT_PREFIX}${id}`, serialized);
        await pipelineReplies(pipeline);
        await this.dropExpiredFromIndex(this.redisClient, userId);
      } catch (err) {
        console.error('[CredentialsVault] Redis save failed:', err);
        throw new CredentialsVaultPersistenceError({ cause: err });
      }
    } else {
      // No Redis configured (local development and tests): single-process memory.
      this.inMemoryStore.set(id, envelope);
    }

    return id;
  }

  /** The stored envelope, or null when none exists; an unreachable or unreadable store is a typed error. */
  private async readEnvelope(redis: Redis, credentialRef: string): Promise<StoredCredentialEnvelope | null> {
    try {
      const serialized = await redis.get(`${VAULT_PREFIX}${credentialRef}`);
      return serialized ? (JSON.parse(serialized) as StoredCredentialEnvelope) : null;
    } catch (err) {
      console.error('[CredentialsVault] Redis read failed:', err);
      throw new CredentialsVaultPersistenceError({ cause: err, saving: false });
    }
  }

  /**
   * Retrieves and decrypts customer storage credentials by reference.
   * Optionally enforces tenancy boundary by verifying matching userId.
   */
  async get(credentialRef: string, userId?: string): Promise<CustomerStorageCredentials | null> {
    if (!credentialRef?.startsWith('cred_')) {
      return null;
    }

    const envelope = this.redisClient
      ? await this.readEnvelope(this.redisClient, credentialRef)
      : (this.inMemoryStore.get(credentialRef) ?? null);

    if (!envelope) {
      return null;
    }

    // Expiration check
    if (envelope.expiresAt && Date.now() > envelope.expiresAt) {
      await this.delete(credentialRef);
      return null;
    }

    // Tenancy isolation boundary
    if (userId && envelope.userId !== userId) {
      return null;
    }

    try {
      return decryptEnvelopeWithCandidateKeys(envelope).credentials;
    } catch (err) {
      console.error(`[CredentialsVault] Failed to decrypt credential "${credentialRef}":`, err);
      throw new Error(`[CredentialsVault] Decryption failed or authentication tag mismatch`);
    }
  }

  /**
   * Re-encrypts credentials that were encrypted under a legacy fallback key so they use
   * the primary `STORAGE_VAULT_KEY`. Accepts either a single `cred_...` reference or a `userId`/`tenantId`.
   */
  async rotate(credentialRefOrUserId: string, userId?: string): Promise<boolean> {
    if (!credentialRefOrUserId) return false;
    if (!credentialRefOrUserId.startsWith('cred_')) {
      const refs = await this.idsForRotation(credentialRefOrUserId);
      let rotatedAny = false;
      for (const ref of refs) {
        if (await this.rotateEnvelope(ref, credentialRefOrUserId)) {
          rotatedAny = true;
        }
      }
      return rotatedAny;
    }
    return this.rotateEnvelope(credentialRefOrUserId, userId);
  }

  /** The credentials of one user to rotate: their index when it is complete (not a scan of every user's credentials), else a scan. */
  private async idsForRotation(userId: string): Promise<string[]> {
    const redis = this.redisClient;
    if (!redis) return this.listByUser(userId);
    try {
      const ids = (await this.ensureUserIndex(redis)) ? await redis.smembers(userIndexKey(userId)) : await this.scanIdsOfUser(redis, userId);
      return ids.sort((a, b) => a.localeCompare(b));
    } catch (err) {
      console.error('[CredentialsVault] Redis rotate listing failed:', err);
      throw new CredentialsVaultPersistenceError({ cause: err, saving: false });
    }
  }

  private async rotateEnvelope(credentialRef: string, userId?: string): Promise<boolean> {
    const envelope = this.redisClient
      ? await this.readEnvelope(this.redisClient, credentialRef)
      : (this.inMemoryStore.get(credentialRef) ?? null);

    if (!envelope) return false;
    if (envelope.expiresAt && Date.now() > envelope.expiresAt) {
      await this.delete(credentialRef);
      return false;
    }
    if (userId && envelope.userId !== userId) return false;

    const masterKey = getVaultMasterKey();
    const { credentials, sealedWithCurrentKey } = decryptEnvelopeWithCandidateKeys(envelope);
    if (sealedWithCurrentKey) return false;

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
    cipher.setAAD(Buffer.from(envelope.id, 'utf-8'));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const updated: StoredCredentialEnvelope = {
      ...envelope,
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      encryptedData: encrypted.toString('base64'),
    };

    if (this.redisClient) {
      try {
        const key = `${VAULT_PREFIX}${envelope.id}`;
        const serialized = JSON.stringify(updated);
        if (envelope.expiresAt) {
          const remainingTtl = Math.max(1, Math.ceil((envelope.expiresAt - Date.now()) / 1000));
          await this.redisClient.setex(key, remainingTtl, serialized);
        } else {
          await this.redisClient.set(key, serialized);
        }
      } catch (err) {
        console.error('[CredentialsVault] Redis rotate save failed:', err);
        throw new CredentialsVaultPersistenceError({ cause: err });
      }
    } else {
      this.inMemoryStore.set(envelope.id, updated);
    }

    return true;
  }

  /**
   * A stored value that is not a credential (a damaged record) is deleted when the index of `userId` names it, which is the only
   * proof it was theirs, so the erasure of an account leaves nothing of theirs behind; for anyone else it stays. A readable or absent
   * record is the caller's to handle ('readable').
   */
  private async deleteUnreadable(redis: Redis, credentialRef: string, userId?: string): Promise<'deleted' | 'kept' | 'readable'> {
    try {
      const raw = await redis.get(`${VAULT_PREFIX}${credentialRef}`);
      if (raw === null || this.isEnvelope(raw)) return 'readable';
      if (!userId || (await redis.sismember(userIndexKey(userId), credentialRef)) !== 1) return 'kept';
      await pipelineReplies(redis.pipeline().del(`${VAULT_PREFIX}${credentialRef}`).srem(userIndexKey(userId), credentialRef));
      return 'deleted';
    } catch (err) {
      console.error('[CredentialsVault] Redis delete failed:', err);
      throw new CredentialsVaultPersistenceError({ cause: err, saving: false });
    }
  }

  private isEnvelope(raw: string): boolean {
    try {
      const envelope = JSON.parse(raw) as { id?: unknown; userId?: unknown } | null;
      return typeof envelope?.id === 'string' && typeof envelope.userId === 'string';
    } catch {
      return false;
    }
  }

  /**
   * Deletes credentials by reference with optional tenancy check.
   */
  async delete(credentialRef: string, userId?: string): Promise<boolean> {
    if (!credentialRef?.startsWith('cred_')) {
      return false;
    }

    if (this.redisClient) {
      const unreadable = await this.deleteUnreadable(this.redisClient, credentialRef, userId);
      if (unreadable !== 'readable') return unreadable === 'deleted';
    }

    const envelope = this.redisClient
      ? await this.readEnvelope(this.redisClient, credentialRef)
      : this.inMemoryStore.get(credentialRef);

    if (!envelope) {
      return false;
    }

    if (userId && envelope.userId !== userId) {
      return false;
    }

    if (this.redisClient) {
      try {
        await whenReady(this.redisClient);
        // The credential first, then its place in the index: an id left behind is dropped by the next listing.
        await pipelineReplies(this.redisClient.pipeline().del(`${VAULT_PREFIX}${credentialRef}`).srem(userIndexKey(envelope.userId), credentialRef));
      } catch (err) {
        console.error('[CredentialsVault] Redis delete failed:', err);
        throw new CredentialsVaultPersistenceError({ cause: err, saving: false });
      }
    } else {
      this.inMemoryStore.delete(credentialRef);
    }

    return true;
  }

  /**
   * Lists non-sensitive credential summaries for a specific user.
   */
  async list(userId: string): Promise<CredentialSummary[]> {
    if (!userId) return [];

    const results: CredentialSummary[] = [];
    const now = Date.now();

    if (this.redisClient) {
      try {
        return await this.listFromIndex(this.redisClient, userId, now);
      } catch (err) {
        console.error('[CredentialsVault] Redis list failed:', err);
        throw new CredentialsVaultPersistenceError({ cause: err, saving: false });
      }
    }

    for (const envelope of this.inMemoryStore.values()) {
      if (envelope.userId === userId) {
        if (envelope.expiresAt && now > envelope.expiresAt) {
          continue;
        }
        results.push({
          id: envelope.id,
          userId: envelope.userId,
          providerType: envelope.providerType,
          name: envelope.name,
          createdAt: envelope.createdAt,
          expiresAt: envelope.expiresAt,
        });
      }
    }

    return results;
  }

  /**
   * The summaries of the credentials of `userId`: from the index and the credentials themselves, not the vault of every user, once
   * the index is known to be complete; while a process is still building it, from a scan of the vault, so a listing is never short.
   */
  private async listFromIndex(redis: Redis, userId: string, now: number): Promise<CredentialSummary[]> {
    const key = userIndexKey(userId);
    const complete = await this.ensureUserIndex(redis);
    const ids = complete ? await redis.smembers(key) : await this.scanIdsOfUser(redis, userId);
    if (ids.length === 0) return [];
    const raws = await redis.mget(ids.map((id) => `${VAULT_PREFIX}${id}`));
    const results: CredentialSummary[] = [];
    const stale: string[] = [];
    raws.forEach((raw, position) => {
      if (!raw) {
        stale.push(ids[position]);
        return;
      }
      // A damaged record is left out of the listing and stays where it is: the erasure of the account deletes it by the index.
      const envelope = parseEnvelope(raw, ids[position]);
      if (!envelope) return;
      // A credential that expired or was deleted, or one the index names for the wrong user, leaves the index.
      if (envelope.userId !== userId) {
        stale.push(ids[position]);
      } else if (!envelope.expiresAt || now <= envelope.expiresAt) {
        results.push({
          id: envelope.id,
          userId: envelope.userId,
          providerType: envelope.providerType,
          name: envelope.name,
          createdAt: envelope.createdAt,
          expiresAt: envelope.expiresAt,
        });
      }
    });
    if (complete && stale.length > 0) await redis.srem(key, ...stale).catch(() => undefined);
    return results.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  /** The ids in the index of `userId` whose credential has expired or is gone leave it, so a user who never lists does not keep them. */
  private async dropExpiredFromIndex(redis: Redis, userId: string): Promise<void> {
    try {
      const key = userIndexKey(userId);
      const ids = await redis.smembers(key);
      if (ids.length === 0) return;
      const pipeline = redis.pipeline();
      for (const id of ids) pipeline.exists(`${VAULT_PREFIX}${id}`);
      const replies = (await pipelineReplies(pipeline)) as number[];
      const stale = ids.filter((_, position) => Number(replies[position]) === 0);
      if (stale.length > 0) await redis.srem(key, ...stale);
    } catch (err) {
      // The listing drops them as well; a credential that was saved is never failed for this.
      console.warn('[CredentialsVault] Could not drop the expired credentials from the index:', err);
    }
  }

  /**
   * Whether the index holds every credential of the vault, indexing the vault first when no process has done it within the last
   * day. The marker is set when the pass has finished, never before; a request that finds another process running the pass gets
   * false and lists by scan.
   */
  private async ensureUserIndex(redis: Redis): Promise<boolean> {
    if (Date.now() < this.userIndexCheckedUntil) return true;
    if ((await redis.exists(USER_INDEX_MARKER)) === 1) {
      this.userIndexCheckedUntil = Date.now() + USER_INDEX_CHECK_MS;
      return true;
    }
    if ((await redis.set(USER_INDEX_LOCK, '1', 'PX', USER_INDEX_LOCK_MS, 'NX')) !== 'OK') return false;
    try {
      await this.indexVault(redis);
      await redis.set(USER_INDEX_MARKER, '1', 'PX', USER_INDEX_REFRESH_MS);
    } finally {
      await redis.del(USER_INDEX_LOCK).catch(() => undefined);
    }
    this.userIndexCheckedUntil = Date.now() + USER_INDEX_CHECK_MS;
    return true;
  }

  private async indexVault(redis: Redis): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${VAULT_PREFIX}*`, 'COUNT', SCAN_BATCH);
      cursor = next;
      if (keys.length === 0) continue;
      const pipeline = redis.pipeline();
      for (const raw of await redis.mget(keys)) {
        const envelope = raw ? parseEnvelope(raw) : undefined;
        if (envelope) pipeline.sadd(userIndexKey(envelope.userId), envelope.id);
      }
      if (pipeline.length > 0) await pipelineReplies(pipeline);
    } while (cursor !== '0');
  }

  /** The ids of the credentials of `userId` by a scan of the whole vault, which needs no index. */
  private async scanIdsOfUser(redis: Redis, userId: string): Promise<string[]> {
    const ids = new Set<string>();
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${VAULT_PREFIX}*`, 'COUNT', SCAN_BATCH);
      cursor = next;
      if (keys.length === 0) continue;
      const raws = typeof redis.mget === 'function' ? await redis.mget(...keys) : await Promise.all(keys.map((key) => redis.get(key)));
      for (const raw of raws) {
        const envelope = raw ? parseEnvelope(raw) : undefined;
        if (envelope?.userId === userId) ids.add(envelope.id);
      }
    } while (cursor !== '0');
    return [...ids];
  }

  async listByUser(userId: string): Promise<string[]> {
    if (!userId) return [];
    if (this.redisClient) {
      return this.redisIdsOfUser(this.redisClient, userId);
    }
    const ids: string[] = [];
    for (const envelope of this.inMemoryStore.values()) {
      if (envelope.userId === userId) {
        ids.push(envelope.id);
      }
    }
    return ids.sort((a, b) => a.localeCompare(b));
  }

  /**
   * The ids of the credentials of `userId` for an erasure, which never depends on the index being complete: those found by scanning
   * the vault, and those the index names that still exist (a damaged record names no user, only the index finds it).
   */
  private async redisIdsOfUser(redis: Redis, userId: string): Promise<string[]> {
    try {
      const ids = new Set(await this.scanIdsOfUser(redis, userId));
      const indexed = await redis.smembers(userIndexKey(userId));
      if (indexed.length > 0) {
        const pipeline = redis.pipeline();
        for (const id of indexed) pipeline.exists(`${VAULT_PREFIX}${id}`);
        const replies = (await pipelineReplies(pipeline)) as number[];
        indexed.forEach((id, position) => {
          if (Number(replies[position]) === 1) ids.add(id);
        });
      }
      return [...ids].sort((a, b) => a.localeCompare(b));
    } catch (err) {
      console.error('[CredentialsVault] Redis listByUser failed:', err);
      throw new CredentialsVaultPersistenceError({ cause: err, saving: false });
    }
  }

  /**
   * Clears in-memory storage (used for tests).
   */
  clear(): void {
    this.inMemoryStore.clear();
  }
}

export const credentialsVault = new CredentialsVault();
