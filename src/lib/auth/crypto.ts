import crypto from 'node:crypto';

const PBKDF2_ITERATIONS = 100000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = 'sha512';

/**
 * Hashes a plain-text password using PBKDF2 with SHA-512.
 */
export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  if (!password || typeof password !== 'string') {
    throw new Error('Password must be a non-empty string');
  }

  const salt = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({
        hash: derivedKey.toString('hex'),
        salt,
      });
    });
  });
}

/**
 * Verifies a plain-text password against a stored PBKDF2 hash and salt using constant-time comparison.
 */
export async function verifyPassword(password: string, storedHash: string, salt: string): Promise<boolean> {
  if (!password || !storedHash || !salt) {
    return false;
  }

  return new Promise((resolve) => {
    crypto.pbkdf2(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST, (err, derivedKey) => {
      if (err) {
        resolve(false);
        return;
      }

      const inputBuffer = Buffer.from(derivedKey.toString('hex'), 'hex');
      const storedBuffer = Buffer.from(storedHash, 'hex');

      if (inputBuffer.length !== storedBuffer.length) {
        resolve(false);
        return;
      }

      resolve(crypto.timingSafeEqual(inputBuffer, storedBuffer));
    });
  });
}

/**
 * Generates a cryptographically secure random token.
 */
export function generateSecureToken(byteLength: number = 32): string {
  return crypto.randomBytes(byteLength).toString('hex');
}

/**
 * Computes a SHA-256 hash of a string.
 */
export function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Computes an HMAC-SHA256 (RFC 2104) of a string with the given secret key, as lowercase hex.
 */
export function hmacSha256(key: string, content: string): string {
  return crypto.createHmac('sha256', key).update(content).digest('hex');
}
