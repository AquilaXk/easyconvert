import crypto from 'node:crypto';
import { MIN_PRODUCTION_SEALING_KEY_LENGTH, secretForms } from '../security/secret-forms';

const ENCRYPTION_PREFIX = 'enc:v1:';
const ENCRYPTION_PREFIX_V2 = 'enc:v2:';
const DEV_SECRET_KEY_SALT = 'easyconvert-dev-secret-key-salt';

function deriveKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

function hasEncryptedPrefix(value: string): boolean {
  return value.startsWith(ENCRYPTION_PREFIX) || value.startsWith(ENCRYPTION_PREFIX_V2);
}

interface MemoizedKeyMaterial {
  envSignature: string;
  sealingKey: Buffer | null;
  candidateKeys: Buffer[];
  hasSealingKey: boolean;
}

let memoizedKeys: MemoizedKeyMaterial | null = null;

function currentEnvSignature(): string {
  return [
    process.env.NODE_ENV ?? '',
    process.env.KEY_ENCRYPTION_KEY ?? '',
    process.env.KEY_HASH_PEPPER ?? '',
    process.env.KEY_HASH_PEPPER_PREVIOUS ?? '',
    process.env.JWT_SECRET ?? '',
  ].join('\0');
}

/** Raised when new data must be sealed but no valid `KEY_ENCRYPTION_KEY` is configured. Reads are unaffected. */
export class SecretEncryptionKeyMissingError extends Error {
  readonly code = 'SECRET_ENCRYPTION_KEY_MISSING';

  constructor() {
    super(
      `KEY_ENCRYPTION_KEY must be set (at least ${MIN_PRODUCTION_SEALING_KEY_LENGTH} characters) in production to encrypt new secrets; existing secrets still decrypt.`
    );
    this.name = 'SecretEncryptionKeyMissingError';
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

function getKeyMaterial(): MemoizedKeyMaterial {
  const envSignature = currentEnvSignature();
  if (memoizedKeys && memoizedKeys.envSignature === envSignature) {
    return memoizedKeys;
  }

  const sealingSecret = resolveSealingSecret();
  const sealingKey = sealingSecret !== null ? deriveKey(sealingSecret) : null;
  const secrets = [
    ...(sealingSecret === null ? [] : [sealingSecret]),
    ...secretForms(process.env.KEY_ENCRYPTION_KEY),
    ...secretForms(process.env.KEY_HASH_PEPPER),
    ...secretForms(process.env.KEY_HASH_PEPPER_PREVIOUS),
    ...secretForms(process.env.JWT_SECRET),
    ...(process.env.NODE_ENV !== 'production' ? [DEV_SECRET_KEY_SALT] : []),
  ];

  const seen = new Set<string>();
  const candidateKeys: Buffer[] = [];
  for (const secret of secrets) {
    const derived = deriveKey(secret);
    const hex = derived.toString('hex');
    if (!seen.has(hex)) {
      seen.add(hex);
      candidateKeys.push(derived);
    }
  }

  memoizedKeys = {
    envSignature,
    sealingKey,
    candidateKeys,
    hasSealingKey: sealingSecret !== null,
  };
  return memoizedKeys;
}

function getEncryptionKey(): Buffer {
  const { sealingKey } = getKeyMaterial();
  if (sealingKey === null) {
    throw new SecretEncryptionKeyMissingError();
  }
  return sealingKey;
}

export function getDecryptionCandidateKeys(): Buffer[] {
  return getKeyMaterial().candidateKeys;
}

function decryptWithCandidateKeys(cipherText: string, aad?: string): {
  plainText: string;
  sealedWithCurrentKey: boolean;
  canSeal: boolean;
} {
  const isV2 = cipherText.startsWith(ENCRYPTION_PREFIX_V2);
  if (isV2 && aad === undefined) {
    throw new Error('[SecretEncryption] AAD is required to decrypt enc:v2 payload.');
  }
  const prefixLength = isV2 ? ENCRYPTION_PREFIX_V2.length : ENCRYPTION_PREFIX.length;
  const payload = cipherText.substring(prefixLength);
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('[SecretEncryption] Malformed encrypted payload structure.');
  }

  const [ivB64, tagB64, encB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const enc = Buffer.from(encB64, 'base64');

  const { candidateKeys, hasSealingKey } = getKeyMaterial();
  let lastError: unknown;
  for (let i = 0; i < candidateKeys.length; i++) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', candidateKeys[i], iv);
      if (isV2 && aad !== undefined) {
        decipher.setAAD(Buffer.from(aad, 'utf8'));
      }
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
 * When `aad` is provided, writes AAD-bound `enc:v2:` format; otherwise preserves `enc:v1:`.
 */
export function encryptSecret(plainText: string | undefined, aad?: string): string | undefined {
  if (!plainText || hasEncryptedPrefix(plainText)) {
    return plainText;
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad !== undefined) {
    cipher.setAAD(Buffer.from(aad, 'utf8'));
  }
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const prefix = aad !== undefined ? ENCRYPTION_PREFIX_V2 : ENCRYPTION_PREFIX;

  return `${prefix}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Decrypts an AES-256-GCM encrypted secret. Gracefully returns plain-text for legacy values.
 */
export function decryptSecret(cipherText: string | undefined, aad?: string): string | undefined {
  if (!cipherText || !hasEncryptedPrefix(cipherText)) {
    return cipherText;
  }

  return decryptWithCandidateKeys(cipherText, aad).plainText;
}

/** True when the value is plain text or was sealed under a key other than the current sealing key. */
export function needsSecretReencryption(cipherText: string | undefined, aad?: string): boolean {
  if (!cipherText) {
    return false;
  }
  if (!hasEncryptedPrefix(cipherText)) {
    return true;
  }
  return !decryptWithCandidateKeys(cipherText, aad).sealedWithCurrentKey;
}

/**
 * Reads a stored secret and re-seals it under the current sealing key when it was sealed under an
 * older one. Without a valid sealing key (production with no usable `KEY_ENCRYPTION_KEY`) the value
 * is returned readable and unchanged, so a read path never fails because a write is not possible.
 */
export function reencryptSecretIfNeeded(cipherText: string | undefined, aad?: string): {
  plainText: string | undefined;
  cipherText: string | undefined;
  reencrypted: boolean;
} {
  if (!cipherText) {
    return { plainText: undefined, cipherText: undefined, reencrypted: false };
  }
  if (!hasEncryptedPrefix(cipherText)) {
    if (resolveSealingSecret() === null) {
      return { plainText: cipherText, cipherText, reencrypted: false };
    }
    return { plainText: cipherText, cipherText: encryptSecret(cipherText, aad), reencrypted: true };
  }
  const { plainText, sealedWithCurrentKey, canSeal } = decryptWithCandidateKeys(cipherText, aad);
  const needsAadUpgrade = aad !== undefined && cipherText.startsWith('enc:v1:');
  if ((sealedWithCurrentKey && !needsAadUpgrade) || !canSeal) {
    return { plainText, cipherText, reencrypted: false };
  }
  return { plainText, cipherText: encryptSecret(plainText, aad), reencrypted: true };
}
