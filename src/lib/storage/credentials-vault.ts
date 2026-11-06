import crypto from 'node:crypto';
import Redis from 'ioredis';
import { readyGatedRedis } from '../redis/when-ready';
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
export class VaultKeyRequiredError extends Error {
  readonly code = 'VAULT_KEY_REQUIRED';

  constructor() {
    super(
      `STORAGE_VAULT_KEY must be set (at least ${MIN_PRODUCTION_SEALING_KEY_LENGTH} characters) in production to store credentials; stored credentials can still be read.`
    );
    this.name = 'VaultKeyRequiredError';
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
    throw new VaultKeyRequiredError();
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
        const key = `${VAULT_PREFIX}${id}`;
        const serialized = JSON.stringify(envelope);
        if (options?.ttlSeconds) {
          await this.redisClient.setex(key, options.ttlSeconds, serialized);
        } else {
          await this.redisClient.set(key, serialized);
        }
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
      const refs = await this.listByUser(credentialRefOrUserId);
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
   * Deletes credentials by reference with optional tenancy check.
   */
  async delete(credentialRef: string, userId?: string): Promise<boolean> {
    if (!credentialRef?.startsWith('cred_')) {
      return false;
    }

    const envelope = this.redisClient
      ? await this.readEnvelope(this.redisClient, credentialRef)
      : this.inMemoryStore.get(credentialRef);

    if (envelope && userId && envelope.userId !== userId) {
      return false;
    }

    if (this.redisClient) {
      try {
        await this.redisClient.del(`${VAULT_PREFIX}${credentialRef}`);
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
        const keys = await this.redisClient.keys(`${VAULT_PREFIX}*`);
        for (const k of keys) {
          const raw = await this.redisClient.get(k);
          if (raw) {
            const envelope = JSON.parse(raw) as StoredCredentialEnvelope;
            if (envelope.userId === userId && (!envelope.expiresAt || now <= envelope.expiresAt)) {
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
        }
        return results;
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

  private async redisIdsOfUser(redis: Redis, userId: string): Promise<string[]> {
    try {
      const ids = new Set<string>();
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${VAULT_PREFIX}*`, 'COUNT', 500);
        for (const key of keys) {
          const raw = await redis.get(key);
          if (!raw) continue;
          const envelope = JSON.parse(raw) as StoredCredentialEnvelope;
          if (envelope.userId === userId) ids.add(envelope.id);
        }
        cursor = next;
      } while (cursor !== '0');
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
