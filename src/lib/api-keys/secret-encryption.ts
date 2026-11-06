import crypto from 'node:crypto';
import { MIN_PRODUCTION_SEALING_KEY_LENGTH, secretForms } from '../security/secret-forms';

const ENCRYPTION_PREFIX = 'enc:v1:';
const DEV_SECRET_KEY_SALT = 'easyconvert-dev-secret-key-salt';

function deriveKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

/** Raised when new data must be sealed but no valid `KEY_ENCRYPTION_KEY` is configured. Reads are unaffected. */
export class SecretEncryptionKeyRequiredError extends Error {
  readonly code = 'SECRET_ENCRYPTION_KEY_REQUIRED';

  constructor() {
    super(
      `KEY_ENCRYPTION_KEY must be set (at least ${MIN_PRODUCTION_SEALING_KEY_LENGTH} characters) in production to encrypt new secrets; existing secrets still decrypt.`
    );
    this.name = 'SecretEncryptionKeyRequiredError';
  }
}

/** The secret new data is sealed under, or null when production has no valid `KEY_ENCRYPTION_KEY`. */
function resolveSealingSecret(): string | null {
  const kek = process.env.KEY_ENCRYPTION_KEY?.trim();
  if (process.env.NODE_ENV === 'production') {
    return kek && kek.length >= MIN_PRODUCTION_SEALING_KEY_LENGTH ? kek : null;
  }
  return (
    kek ||
    process.env.KEY_HASH_PEPPER?.trim() ||
    process.env.JWT_SECRET?.trim() ||
    DEV_SECRET_KEY_SALT
  );
}

function getEncryptionKey(): Buffer {
  const secret = resolveSealingSecret();
  if (secret === null) {
    throw new SecretEncryptionKeyRequiredError();
  }
  return deriveKey(secret);
}

/**
 * Every key a stored value may have been sealed under, the sealing key first when one is valid.
 * Built from the secrets that are set, whatever their length, so a missing or short
 * `KEY_ENCRYPTION_KEY` never stops a read.
 */
function buildDecryptionCandidates(): { keys: Buffer[]; hasSealingKey: boolean } {
  const sealingSecret = resolveSealingSecret();
  const secrets = [
    ...(sealingSecret === null ? [] : [sealingSecret]),
    ...secretForms(process.env.KEY_ENCRYPTION_KEY),
    ...secretForms(process.env.KEY_HASH_PEPPER),
    ...secretForms(process.env.KEY_HASH_PEPPER_PREVIOUS),
    ...secretForms(process.env.JWT_SECRET),
    ...(process.env.NODE_ENV !== 'production' ? [DEV_SECRET_KEY_SALT] : []),
  ];

  const seen = new Set<string>();
  const keys: Buffer[] = [];
  for (const secret of secrets) {
    const derived = deriveKey(secret);
    const hex = derived.toString('hex');
    if (!seen.has(hex)) {
      seen.add(hex);
      keys.push(derived);
    }
  }
  return { keys, hasSealingKey: sealingSecret !== null };
}

export function getDecryptionCandidateKeys(): Buffer[] {
  return buildDecryptionCandidates().keys;
}

function decryptWithCandidateKeys(cipherText: string): {
  plainText: string;
  sealedWithCurrentKey: boolean;
  canSeal: boolean;
} {
  const payload = cipherText.substring(ENCRYPTION_PREFIX.length);
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('[SecretEncryption] Malformed encrypted payload structure.');
  }

  const [ivB64, tagB64, encB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const enc = Buffer.from(encB64, 'base64');

  const { keys: candidateKeys, hasSealingKey } = buildDecryptionCandidates();
  let lastError: unknown;
  for (let i = 0; i < candidateKeys.length; i++) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', candidateKeys[i], iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(enc), decipher.final()]);
      return { plainText: decrypted.toString('utf8'), sealedWithCurrentKey: hasSealingKey && i === 0, canSeal: hasSealingKey };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('[SecretEncryption] No decryption key is configured.');
}

/**
 * Encrypts a plain-text secret at rest using AES-256-GCM authenticated envelope encryption.
 */
export function encryptSecret(plainText: string | undefined): string | undefined {
  if (!plainText || plainText.startsWith(ENCRYPTION_PREFIX)) {
    return plainText;
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${ENCRYPTION_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Decrypts an AES-256-GCM encrypted secret. Gracefully returns plain-text for legacy values.
 */
export function decryptSecret(cipherText: string | undefined): string | undefined {
  if (!cipherText || !cipherText.startsWith(ENCRYPTION_PREFIX)) {
    return cipherText;
  }

  return decryptWithCandidateKeys(cipherText).plainText;
}

/** True when the value is plain text or was sealed under a key other than the current sealing key. */
export function needsSecretReencryption(cipherText: string | undefined): boolean {
  if (!cipherText) {
    return false;
  }
  if (!cipherText.startsWith(ENCRYPTION_PREFIX)) {
    return true;
  }
  return !decryptWithCandidateKeys(cipherText).sealedWithCurrentKey;
}

/**
 * Reads a stored secret and re-seals it under the current sealing key when it was sealed under an
 * older one. Without a valid sealing key (production with no usable `KEY_ENCRYPTION_KEY`) the value
 * is returned readable and unchanged, so a read path never fails because a write is not possible.
 */
export function reencryptSecretIfNeeded(cipherText: string | undefined): {
  plainText: string | undefined;
  cipherText: string | undefined;
  reencrypted: boolean;
} {
  if (!cipherText) {
    return { plainText: undefined, cipherText: undefined, reencrypted: false };
  }
  if (!cipherText.startsWith(ENCRYPTION_PREFIX)) {
    if (resolveSealingSecret() === null) {
      return { plainText: cipherText, cipherText, reencrypted: false };
    }
    return { plainText: cipherText, cipherText: encryptSecret(cipherText), reencrypted: true };
  }
  const { plainText, sealedWithCurrentKey, canSeal } = decryptWithCandidateKeys(cipherText);
  if (sealedWithCurrentKey || !canSeal) {
    return { plainText, cipherText, reencrypted: false };
  }
  return { plainText, cipherText: encryptSecret(plainText), reencrypted: true };
}
