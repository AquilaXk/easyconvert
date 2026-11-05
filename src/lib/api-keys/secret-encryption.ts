import crypto from 'node:crypto';

const ENCRYPTION_PREFIX = 'enc:v1:';
const DEV_SECRET_KEY_SALT = 'easyconvert-dev-secret-key-salt';

function deriveKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

function getEncryptionKey(): Buffer {
  const secret =
    process.env.KEY_ENCRYPTION_KEY ||
    process.env.KEY_HASH_PEPPER ||
    process.env.JWT_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        '[SecretEncryption] FATAL: KEY_ENCRYPTION_KEY, KEY_HASH_PEPPER, or JWT_SECRET is required in production.'
      );
    }
    return deriveKey(DEV_SECRET_KEY_SALT);
  }

  return deriveKey(secret);
}

export function getDecryptionCandidateKeys(): Buffer[] {
  const primary = getEncryptionKey();
  const seen = new Set<string>([primary.toString('hex')]);
  const keys: Buffer[] = [primary];

  const rawSecrets = [
    process.env.KEY_ENCRYPTION_KEY,
    process.env.KEY_HASH_PEPPER,
    process.env.KEY_HASH_PEPPER_PREVIOUS,
    process.env.JWT_SECRET,
    process.env.NODE_ENV !== 'production' ? DEV_SECRET_KEY_SALT : undefined,
  ];

  for (const raw of rawSecrets) {
    if (!raw) continue;
    const derived = deriveKey(raw);
    const hex = derived.toString('hex');
    if (!seen.has(hex)) {
      seen.add(hex);
      keys.push(derived);
    }
  }

  return keys;
}

function decryptWithCandidateKeys(cipherText: string): { plainText: string; keyIndex: number } {
  const payload = cipherText.substring(ENCRYPTION_PREFIX.length);
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('[SecretEncryption] Malformed encrypted payload structure.');
  }

  const [ivB64, tagB64, encB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const enc = Buffer.from(encB64, 'base64');

  const candidateKeys = getDecryptionCandidateKeys();
  let lastError: unknown;
  for (let i = 0; i < candidateKeys.length; i++) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', candidateKeys[i], iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(enc), decipher.final()]);
      return { plainText: decrypted.toString('utf8'), keyIndex: i };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
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

export function reencryptSecretIfNeeded(cipherText: string | undefined): {
  plainText: string | undefined;
  cipherText: string | undefined;
  reencrypted: boolean;
} {
  if (!cipherText) {
    return { plainText: undefined, cipherText: undefined, reencrypted: false };
  }
  if (!cipherText.startsWith(ENCRYPTION_PREFIX)) {
    return { plainText: cipherText, cipherText: encryptSecret(cipherText), reencrypted: true };
  }
  const { plainText, keyIndex } = decryptWithCandidateKeys(cipherText);
  if (keyIndex === 0) {
    return { plainText, cipherText, reencrypted: false };
  }
  return { plainText, cipherText: encryptSecret(plainText), reencrypted: true };
}
