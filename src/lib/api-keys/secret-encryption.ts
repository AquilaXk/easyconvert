import crypto from 'node:crypto';

const ENCRYPTION_PREFIX = 'enc:v1:';

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
    return crypto.createHash('sha256').update('easyconvert-dev-secret-key-salt').digest();
  }

  return crypto.createHash('sha256').update(secret).digest();
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

  const payload = cipherText.substring(ENCRYPTION_PREFIX.length);
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('[SecretEncryption] Malformed encrypted payload structure.');
  }

  const [ivB64, tagB64, encB64] = parts;
  const key = getEncryptionKey();
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const enc = Buffer.from(encB64, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(enc), decipher.final()]);
  return decrypted.toString('utf8');
}
