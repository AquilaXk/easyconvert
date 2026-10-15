import crypto from 'node:crypto';

/**
 * Sealing of bearer secrets (signed URLs, request headers) that travel inside queued job data.
 *
 * Wire format: `sealed:v1:<kid>:<nonce>:<tag>:<ciphertext>`, nonce, tag and ciphertext base64, kid hex.
 * AES-256-GCM with a random 96-bit nonce and the job id as additional authenticated data, so a blob
 * copied into another job (or tampered with) fails authentication instead of decrypting. The key is
 * derived with HKDF-SHA256 from the dedicated `JOB_SECRET_KEK`; no other secret of the deployment is
 * ever reused. `kid` names the key (a short hash of the derived key) so a rotated key produces a
 * typed "unknown key" error instead of a bare authentication failure, and `JOB_SECRET_KEK_PREVIOUS`
 * keeps blobs sealed under the old key readable during a rotation.
 */

export const JOB_SECRET_KEK_ENV = 'JOB_SECRET_KEK';
export const JOB_SECRET_KEK_PREVIOUS_ENV = 'JOB_SECRET_KEK_PREVIOUS';
export const SEALED_PREFIX = 'sealed:v1:';

const FORMAT_TAG = 'sealed';
const FORMAT_VERSION = 'v1';
const SEALED_PART_COUNT = 6;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
/** Shortest KEK accepted in production, in UTF-8 bytes. */
const MIN_KEK_BYTES = 32;
const KID_HEX_LENGTH = 12;
const KID_PATTERN = /^[0-9a-f]{12}$/;
const VERSION_PATTERN = /^v[0-9]{1,6}$/;
const BASE64_BYTES_PER_GROUP = 3;
const BASE64_CHARS_PER_GROUP = 4;
/** Room for the prefix, the key id, the nonce, the tag and the separators around the ciphertext. */
const SEALED_BLOB_OVERHEAD_LENGTH = 160;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const HKDF_SALT = 'easyconvert-job-seal-salt';
const HKDF_INFO = 'easyconvert-job-secret-seal-v1';
const KID_LABEL = 'easyconvert-job-secret-kid-v1';
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
  | 'UNKNOWN_KEY'
  | 'AUTHENTICATION_FAILED'
  | 'UNSEALED_SECRET';

/**
 * A secret could not be sealed or opened. Messages are fixed text: they never carry plaintext,
 * ciphertext, key material, or any part of the (possibly attacker-supplied) blob.
 */
export class SecretSealError extends Error {
  constructor(
    readonly code: SecretSealErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'SecretSealError';
  }
}

interface SealingKey {
  kid: string;
  key: Buffer;
}

interface SealingKeys {
  current: SealingKey;
  previous?: SealingKey;
}

function deriveSealingKey(secret: string): SealingKey {
  const key = Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from(HKDF_SALT, 'utf8'), Buffer.from(HKDF_INFO, 'utf8'), KEY_BYTES)
  );
  const kid = crypto
    .createHash('sha256')
    .update(Buffer.concat([Buffer.from(KID_LABEL, 'utf8'), key]))
    .digest('hex')
    .slice(0, KID_HEX_LENGTH);
  return { kid, key };
}

/** The configured KEK, or undefined when unset. In production it must be long enough and carry no stray whitespace. */
function readKek(name: string, production: boolean): string | undefined {
  const value = process.env[name];
  if (!value) {
    return undefined;
  }
  if (production && (value !== value.trim() || Buffer.byteLength(value, 'utf8') < MIN_KEK_BYTES)) {
    throw new SealingKeyConfigError(
      'MALFORMED',
      `[JobSecretSeal] ${name} must be at least ${MIN_KEK_BYTES} bytes without surrounding whitespace.`
    );
  }
  return value;
}

let cachedKeys: { fingerprint: string; keys: SealingKeys } | null = null;

function sealingKeys(): SealingKeys {
  const production = process.env.NODE_ENV === 'production';
  let current = readKek(JOB_SECRET_KEK_ENV, production);
  if (current === undefined) {
    if (production) {
      throw new SealingKeyConfigError(
        'MISSING',
        `[JobSecretSeal] FATAL: ${JOB_SECRET_KEK_ENV} (a random secret of at least ${MIN_KEK_BYTES} bytes) is required in production.`
      );
    }
    current = DEV_SEALING_SECRET;
  }
  const previous = readKek(JOB_SECRET_KEK_PREVIOUS_ENV, production);
  const fingerprint = `${current}\u0000${previous ?? ''}`;
  if (cachedKeys?.fingerprint !== fingerprint) {
    cachedKeys = {
      fingerprint,
      keys: { current: deriveSealingKey(current), previous: previous === undefined ? undefined : deriveSealingKey(previous) },
    };
  }
  return cachedKeys.keys;
}

/** Throws a SealingKeyConfigError unless a usable sealing key is configured. Call at process startup. */
export function assertSealingKeyConfigured(): void {
  sealingKeys();
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
  const { kid, key } = sealingKeys().current;
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  return [
    FORMAT_TAG,
    FORMAT_VERSION,
    kid,
    nonce.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

function malformedBlob(): SecretSealError {
  return new SecretSealError('MALFORMED_BLOB', '[JobSecretSeal] Sealed secret is malformed.');
}

function decodeBase64Part(part: string): Buffer {
  if (!BASE64_PATTERN.test(part)) {
    throw malformedBlob();
  }
  return Buffer.from(part, 'base64');
}

/**
 * Opens a blob sealed for `jobId`. Any failure (wrong job, tampering, unknown key, malformed input)
 * throws a SecretSealError; the input is never returned as if it were the plaintext.
 */
export function unsealJobSecret(sealed: string, jobId: string): string {
  const aad = requireJobId(jobId);
  if (typeof sealed !== 'string' || sealed.length > MAX_SEALED_BLOB_LENGTH) {
    throw malformedBlob();
  }
  const parts = sealed.split(':');
  if (parts[0] !== FORMAT_TAG || !VERSION_PATTERN.test(parts[1] ?? '')) {
    throw malformedBlob();
  }
  if (parts[1] !== FORMAT_VERSION) {
    throw new SecretSealError('UNSUPPORTED_VERSION', '[JobSecretSeal] Unsupported sealed secret version.');
  }
  if (parts.length !== SEALED_PART_COUNT || !KID_PATTERN.test(parts[2])) {
    throw malformedBlob();
  }
  const nonce = decodeBase64Part(parts[3]);
  const tag = decodeBase64Part(parts[4]);
  const ciphertext = decodeBase64Part(parts[5]);
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
    throw malformedBlob();
  }
  const keys = sealingKeys();
  const sealingKey = [keys.current, keys.previous].find((candidate) => candidate?.kid === parts[2]);
  if (!sealingKey) {
    throw new SecretSealError('UNKNOWN_KEY', '[JobSecretSeal] Sealed secret was sealed under a key that is not configured.');
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', sealingKey.key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretSealError('AUTHENTICATION_FAILED', '[JobSecretSeal] Sealed secret failed authentication (wrong job or tampered data).');
  }
}
