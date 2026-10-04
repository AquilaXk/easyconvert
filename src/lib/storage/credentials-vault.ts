import crypto from 'node:crypto';
import Redis from 'ioredis';

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

function getVaultMasterKey(): Buffer {
  const secret =
    process.env.STORAGE_VAULT_KEY ||
    process.env.KEY_ENCRYPTION_KEY ||
    process.env.JWT_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        '[CredentialsVault] FATAL: STORAGE_VAULT_KEY or JWT_SECRET is strictly required in production.'
      );
    }
    return crypto.createHash('sha256').update('easyconvert-dev-vault-master-key-salt').digest();
  }

  // Derive 32 bytes using HKDF
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

export class CredentialsVault {
  private readonly inMemoryStore = new Map<string, StoredCredentialEnvelope>();
  private readonly redisClient: Redis | null = null;
  private redisConnected = false;

  constructor(redisClient?: Redis) {
    if (redisClient) {
      this.redisClient = redisClient;
      this.redisConnected = true;
    } else if (process.env.REDIS_URL) {
      try {
        const client = new Redis(process.env.REDIS_URL, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
        });
        client.on('connect', () => {
          this.redisConnected = true;
        });
        client.on('error', () => {
          this.redisConnected = false;
        });
        client.connect().catch(() => {
          this.redisConnected = false;
        });
        this.redisClient = client;
      } catch {
        this.redisConnected = false;
      }
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

    // Persist in Redis if active
    if (this.redisClient && this.redisConnected) {
      try {
        const key = `${VAULT_PREFIX}${id}`;
        const serialized = JSON.stringify(envelope);
        if (options?.ttlSeconds) {
          await this.redisClient.setex(key, options.ttlSeconds, serialized);
        } else {
          await this.redisClient.set(key, serialized);
        }
      } catch (err) {
        console.warn('[CredentialsVault] Redis save failed, falling back to in-memory store:', err);
        this.inMemoryStore.set(id, envelope);
      }
    } else {
      this.inMemoryStore.set(id, envelope);
    }

    return id;
  }

  /**
   * Retrieves and decrypts customer storage credentials by reference.
   * Optionally enforces tenancy boundary by verifying matching userId.
   */
  async get(credentialRef: string, userId?: string): Promise<CustomerStorageCredentials | null> {
    if (!credentialRef?.startsWith('cred_')) {
      return null;
    }

    let envelope: StoredCredentialEnvelope | null = null;

    if (this.redisClient && this.redisConnected) {
      try {
        const serialized = await this.redisClient.get(`${VAULT_PREFIX}${credentialRef}`);
        if (serialized) {
          envelope = JSON.parse(serialized) as StoredCredentialEnvelope;
        }
      } catch {
        // Fall back to in-memory check
      }
    }

    envelope ??= this.inMemoryStore.get(credentialRef) || null;

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
      const masterKey = getVaultMasterKey();
      const iv = Buffer.from(envelope.iv, 'base64');
      const tag = Buffer.from(envelope.tag, 'base64');
      const encryptedData = Buffer.from(envelope.encryptedData, 'base64');

      const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, iv);
      decipher.setAAD(Buffer.from(envelope.id, 'utf-8'));
      decipher.setAuthTag(tag);

      const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
      const credentials = JSON.parse(decrypted.toString('utf-8')) as CustomerStorageCredentials;
      return credentials;
    } catch (err) {
      console.error(`[CredentialsVault] Failed to decrypt credential "${credentialRef}":`, err);
      throw new Error(`[CredentialsVault] Decryption failed or authentication tag mismatch`);
    }
  }

  /**
   * Deletes credentials by reference with optional tenancy check.
   */
  async delete(credentialRef: string, userId?: string): Promise<boolean> {
    if (!credentialRef?.startsWith('cred_')) {
      return false;
    }

    let envelope = this.inMemoryStore.get(credentialRef);
    if (!envelope && this.redisClient && this.redisConnected) {
      try {
        const raw = await this.redisClient.get(`${VAULT_PREFIX}${credentialRef}`);
        if (raw) {
          envelope = JSON.parse(raw);
        }
      } catch {
        // ignore
      }
    }

    if (envelope && userId && envelope.userId !== userId) {
      return false;
    }

    this.inMemoryStore.delete(credentialRef);

    if (this.redisClient && this.redisConnected) {
      try {
        await this.redisClient.del(`${VAULT_PREFIX}${credentialRef}`);
      } catch {
        // ignore
      }
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

    if (this.redisClient && this.redisConnected) {
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
      } catch {
        // Fall back to in-memory store
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
   * Clears in-memory storage (used for tests).
   */
  clear(): void {
    this.inMemoryStore.clear();
  }
}

export const credentialsVault = new CredentialsVault();
