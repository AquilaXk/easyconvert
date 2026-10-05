import crypto from 'node:crypto';

/**
 * Sealing of bearer secrets (signed URLs, request headers) that travel inside queued job data.
 *
 * Wire format: `sealed:v1:<nonce>:<tag>:<ciphertext>`, each part base64. AES-256-GCM with a random
 * 96-bit nonce and the job id as additional authenticated data, so a blob copied into another job
 * (or tampered with) fails authentication instead of decrypting. The key is derived with
 * HKDF-SHA256 from `JOB_SECRET_KEK`, falling back to the existing vault and encryption key
 * configuration, under its own salt and info so no other component's key is ever reused.
 */

export const JOB_SECRET_KEK_ENV = 'JOB_SECRET_KEK';
export const SEALED_PREFIX = 'sealed:v1:';

const FORMAT_TAG = 'sealed';
const FORMAT_VERSION = 'v1';
const SEALED_PART_COUNT = 5;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/** Shortest JOB_SECRET_KEK accepted in production (a 32-byte value as 64 hex characters, or longer). */
const MIN_KEK_LENGTH = 32;
const BASE64_BYTES_PER_GROUP = 3;
const BASE64_CHARS_PER_GROUP = 4;
/** Room for the prefix, the nonce, the tag and the separators around the ciphertext. */
const SEALED_BLOB_OVERHEAD_LENGTH = 128;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const HKDF_SALT = 'easyconvert-job-seal-salt';
const HKDF_INFO = 'easyconvert-job-secret-seal-v1';
/** Local development key, used only outside production when no key is configured. */
const DEV_SEALING_SECRET = 'easyconvert-dev-job-secret-sealing-key';

/** Largest plaintext one blob seals; a signed URL plus headers is far smaller. */
export const MAX_SEALED_PLAINTEXT_BYTES = 64 * 1024;
/** Longest blob `unsealJobSecret` decodes. */
export const MAX_SEALED_BLOB_LENGTH =
  Math.ceil(MAX_SEALED_PLAINTEXT_BYTES / BASE64_BYTES_PER_GROUP) * BASE64_CHARS_PER_GROUP + SEALED_BLOB_OVERHEAD_LENGTH;

/** The sealing key is missing or malformed. Thrown at startup and on every seal attempt in production. */
export class SealingKeyConfigError extends Error {
  constructor(
    readonly code: 'MISSING' | 'MALFORMED',
    message: string
  ) {
    super(message);
    this.name = 'SealingKeyConfigError';
  }
}

export type SecretSealErrorCode =
  | 'INVALID_JOB_ID'
  | 'EMPTY_PLAINTEXT'
  | 'PLAINTEXT_TOO_LARGE'
  | 'MALFORMED_BLOB'
  | 'UNSUPPORTED_VERSION'
  | 'AUTHENTICATION_FAILED';

/** A secret could not be sealed or opened. Messages never carry plaintext, ciphertext or key material. */
export class SecretSealError extends Error {
  constructor(
    readonly code: SecretSealErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'SecretSealError';
  }
}

function resolveSealingSecret(): string {
  const production = process.env.NODE_ENV === 'production';
  const kek = process.env[JOB_SECRET_KEK_ENV];
  if (kek) {
    if (production && (kek !== kek.trim() || kek.length < MIN_KEK_LENGTH)) {
      throw new SealingKeyConfigError(
        'MALFORMED',
        `[JobSecretSeal] ${JOB_SECRET_KEK_ENV} must be at least ${MIN_KEK_LENGTH} characters without surrounding whitespace.`
      );
    }
    return kek;
  }
  const existing = process.env.STORAGE_VAULT_KEY || process.env.KEY_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (existing) {
    return existing;
  }
  if (production) {
    throw new SealingKeyConfigError(
      'MISSING',
      `[JobSecretSeal] FATAL: ${JOB_SECRET_KEK_ENV} (or STORAGE_VAULT_KEY, KEY_ENCRYPTION_KEY, JWT_SECRET) is required in production.`
    );
  }
  return DEV_SEALING_SECRET;
}

let cachedKey: { secret: string; key: Buffer } | null = null;

function sealingKey(): Buffer {
  const secret = resolveSealingSecret();
  if (cachedKey?.secret !== secret) {
    const key = Buffer.from(
      crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from(HKDF_SALT, 'utf8'), Buffer.from(HKDF_INFO, 'utf8'), KEY_BYTES)
    );
    cachedKey = { secret, key };
  }
  return cachedKey.key;
}

/** Throws a SealingKeyConfigError unless a usable sealing key is configured. Call at process startup. */
export function assertSealingKeyConfigured(): void {
  sealingKey();
}

function requireJobId(jobId: string): Buffer {
  if (typeof jobId !== 'string' || jobId.length === 0) {
    throw new SecretSealError('INVALID_JOB_ID', '[JobSecretSeal] A job id is required to bind the sealed secret.');
  }
  return Buffer.from(jobId, 'utf8');
}

/** Seals `plaintext` for the job `jobId`. The blob opens only under the same job id and key. */
export function sealJobSecret(plaintext: string, jobId: string): string {
  const aad = requireJobId(jobId);
  const data = Buffer.from(plaintext, 'utf8');
  if (data.length === 0) {
    throw new SecretSealError('EMPTY_PLAINTEXT', '[JobSecretSeal] Nothing to seal.');
  }
  if (data.length > MAX_SEALED_PLAINTEXT_BYTES) {
    throw new SecretSealError(
      'PLAINTEXT_TOO_LARGE',
      `[JobSecretSeal] Secret is larger than the ${MAX_SEALED_PLAINTEXT_BYTES}-byte limit.`
    );
  }
  const key = sealingKey();
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  return [FORMAT_TAG, FORMAT_VERSION, nonce.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}

function decodeBase64Part(part: string): Buffer {
  if (!BASE64_PATTERN.test(part)) {
    throw new SecretSealError('MALFORMED_BLOB', '[JobSecretSeal] Sealed secret is malformed.');
  }
  return Buffer.from(part, 'base64');
}

/**
 * Opens a blob sealed for `jobId`. Any failure (wrong job, tampering, wrong key, malformed input)
 * throws a SecretSealError; the input is never returned as if it were the plaintext.
 */
export function unsealJobSecret(sealed: string, jobId: string): string {
  const aad = requireJobId(jobId);
  if (typeof sealed !== 'string' || sealed.length > MAX_SEALED_BLOB_LENGTH) {
    throw new SecretSealError('MALFORMED_BLOB', '[JobSecretSeal] Sealed secret is malformed.');
  }
  const parts = sealed.split(':');
  if (parts[0] !== FORMAT_TAG || !/^v\d+$/.test(parts[1] ?? '')) {
    throw new SecretSealError('MALFORMED_BLOB', '[JobSecretSeal] Sealed secret is malformed.');
  }
  if (parts[1] !== FORMAT_VERSION) {
    throw new SecretSealError('UNSUPPORTED_VERSION', `[JobSecretSeal] Unsupported sealed secret version "${parts[1]}".`);
  }
  if (parts.length !== SEALED_PART_COUNT) {
    throw new SecretSealError('MALFORMED_BLOB', '[JobSecretSeal] Sealed secret is malformed.');
  }
  const nonce = decodeBase64Part(parts[2]);
  const tag = decodeBase64Part(parts[3]);
  const ciphertext = decodeBase64Part(parts[4]);
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretSealError('MALFORMED_BLOB', '[JobSecretSeal] Sealed secret is malformed.');
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', sealingKey(), nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (err) {
    if (err instanceof SealingKeyConfigError) {
      throw err;
    }
    throw new SecretSealError('AUTHENTICATION_FAILED', '[JobSecretSeal] Sealed secret failed authentication (wrong job, key or tampered data).');
  }
}
