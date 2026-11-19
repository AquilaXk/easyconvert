import crypto from 'node:crypto';
import { extraIterations, mustUpdate } from './pbkdf2-upgrade';

/**
 * Iterations of a new hash: 210,000 for PBKDF2-HMAC-SHA512 (OWASP Password Storage Cheat Sheet, 2023, "PBKDF2": HMAC-SHA-512,
 * 210,000 iterations), where earlier releases used 100,000 and kept no note of it on the record.
 */
export const PBKDF2_ITERATIONS = 210_000;
/** The iterations of a hash whose record has none noted: every hash an earlier release stored. */
export const LEGACY_PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = 'sha512';

function derive(password: string, salt: string, iterations: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, iterations, PBKDF2_KEYLEN, PBKDF2_DIGEST, (err, derivedKey) => (err ? reject(err) : resolve(derivedKey)));
  });
}

/** The iterations a stored hash was made with: the one the record notes, else those of the earlier releases. */
export function iterationsOf(record: { passwordIterations?: number }): number {
  return record.passwordIterations ?? LEGACY_PBKDF2_ITERATIONS;
}

/** Whether a hash made with `iterations` is to be replaced by a current one when its owner signs in. */
export function passwordNeedsUpgrade(iterations: number): boolean {
  return mustUpdate(iterations, PBKDF2_ITERATIONS);
}

/**
 * Hashes a plain-text password using PBKDF2 with SHA-512 and the current iterations, which it returns for the record to note.
 */
export async function hashPassword(password: string): Promise<{ hash: string; salt: string; iterations: number }> {
  if (!password || typeof password !== 'string') {
    throw new Error('Password must be a non-empty string');
  }

  const salt = crypto.randomBytes(16).toString('hex');
  return { hash: (await derive(password, salt, PBKDF2_ITERATIONS)).toString('hex'), salt, iterations: PBKDF2_ITERATIONS };
}

/**
 * Verifies a plain-text password against a stored PBKDF2 hash and salt using constant-time comparison. `iterations` is what the hash was
 * made with (`iterationsOf(record)` for an account's hash, else the current ones, as for the dummy hash of an unknown address). A hash made with
 * fewer iterations is checked for the missing ones too, so that it takes as long as a current one and the time does not tell the two apart.
 */
export async function verifyPassword(password: string, storedHash: string, salt: string, iterations: number = PBKDF2_ITERATIONS): Promise<boolean> {
  if (!password || !storedHash || !salt) {
    return false;
  }

  let inputBuffer: Buffer;
  try {
    inputBuffer = await derive(password, salt, iterations);
    const extra = extraIterations(iterations, PBKDF2_ITERATIONS);
    if (extra > 0) await derive(password, salt, extra);
  } catch {
    return false;
  }
  const storedBuffer = Buffer.from(storedHash, 'hex');
  return inputBuffer.length === storedBuffer.length && crypto.timingSafeEqual(inputBuffer, storedBuffer);
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
