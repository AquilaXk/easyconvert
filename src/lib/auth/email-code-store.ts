import crypto from 'node:crypto';
import { pepperedHashes, sameDigest, sha256 } from './crypto';
import { redisUserStore } from './redis-user-store';

/**
 * The six-digit code that a mail carries to prove an address: to make an account (`signup`, before any account exists) or
 * to sign in to a password account whose address was never verified (`login`).
 *
 * The shape follows the email OTP of better-auth (MIT) and the OTP of supabase/auth (MIT); see docs/licensing.md, 2.24.
 * The code is random digits from the system generator, valid 10 minutes, and wrong guesses are counted: after
 * `EMAIL_CODE_MAX_ATTEMPTS` the code is burned. Only a keyed hash is stored (HMAC-SHA256 under `KEY_HASH_PEPPER`, bound to
 * the purpose and the address, as supabase binds its hash to the address), because a six-digit code is guessable from a plain
 * hash in a millisecond. A guess is counted before it is compared, and a right code is deleted in the step that decides it, so
 * parallel guesses are all counted and one right code is used once. Per address and purpose only the newest code is live.
 */

export type EmailCodePurpose = 'signup' | 'login';

export const EMAIL_CODE_TTL_SECONDS = 10 * 60;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
const CODE_DIGITS = 6;
const CODE_SHAPE = /^\d{6}$/;
const HASH_LABEL = 'easyconvert:email-code:v1:';

interface MemoryCode {
  hash: string;
  attempts: number;
  expiresAt: number;
}

const memoryCodes = new Map<string, MemoryCode>();

// KEYS[1]: the code's hash key; ARGV[1]: guesses allowed. Counts the guess and answers the stored hash, or nil when there is no
// code or its guesses are used up (which also deletes it).
const GUESS_LUA = `
local hash = redis.call('HGET', KEYS[1], 'h')
if not hash then return nil end
local attempts = redis.call('HINCRBY', KEYS[1], 'a', 1)
if attempts > tonumber(ARGV[1]) then
  redis.call('DEL', KEYS[1])
  return nil
end
return hash
`;

// KEYS[1]: the code's hash key; ARGV[1]: the hash, ARGV[2]: seconds to live. Replaces any earlier code in one step.
const ISSUE_LUA = `
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'h', ARGV[1], 'a', 0)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
return 1
`;

const normalize = (email: string) => email.trim().toLowerCase();
const codeKey = (purpose: EmailCodePurpose, email: string) =>
  `${redisUserStore.getKeyPrefix()}email_code:${purpose}:${sha256(normalize(email))}`;
const hashesOf = (purpose: EmailCodePurpose, email: string, code: string) =>
  pepperedHashes(`${HASH_LABEL}${purpose}:${normalize(email)}:${code}`);

/** Whether `value` has the shape of a code this store issues: exactly six digits. */
export function isEmailCodeShape(value: unknown): value is string {
  return typeof value === 'string' && CODE_SHAPE.test(value);
}

/** Makes the code for the address and returns it, replacing any earlier one; this is the only time the code exists in the clear. */
export async function issueEmailCode(purpose: EmailCodePurpose, email: string): Promise<string> {
  const code = String(crypto.randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
  const [hash] = hashesOf(purpose, email, code);
  const key = codeKey(purpose, email);
  const redis = redisUserStore.getRedisClient();
  if (redis) {
    await redis.eval(ISSUE_LUA, 1, key, hash, String(EMAIL_CODE_TTL_SECONDS));
    return code;
  }
  memoryCodes.set(key, { hash, attempts: 0, expiresAt: Date.now() + EMAIL_CODE_TTL_SECONDS * 1000 });
  return code;
}

async function storedHash(key: string): Promise<string | null> {
  const redis = redisUserStore.getRedisClient();
  if (redis) {
    const hash = await redis.eval(GUESS_LUA, 1, key, String(EMAIL_CODE_MAX_ATTEMPTS));
    return typeof hash === 'string' ? hash : null;
  }
  const entry = memoryCodes.get(key);
  if (!entry || Date.now() >= entry.expiresAt) {
    memoryCodes.delete(key);
    return null;
  }
  entry.attempts++;
  if (entry.attempts > EMAIL_CODE_MAX_ATTEMPTS) {
    memoryCodes.delete(key);
    return null;
  }
  return entry.hash;
}

async function takeCode(key: string): Promise<boolean> {
  const redis = redisUserStore.getRedisClient();
  if (redis) return (await redis.del(key)) === 1;
  return memoryCodes.delete(key);
}

/**
 * Whether `code` is the live code of the address for the purpose. A right code is used up; a wrong one, of any shape, counts as
 * a guess against the code. A missing, expired, burned or already used code answers false like a wrong one.
 */
export async function verifyEmailCode(purpose: EmailCodePurpose, email: string, code: string): Promise<boolean> {
  const key = codeKey(purpose, email);
  // Hashed before the lookup, so the work of an answer does not tell a missing code from a wrong one.
  const candidates = hashesOf(purpose, email, code);
  const stored = await storedHash(key);
  if (stored === null) return false;
  let match = false;
  for (const candidate of candidates) match = sameDigest(candidate, stored) || match;
  return match && (await takeCode(key));
}

/** Forgets every in-memory code; for tests. */
export function resetEmailCodeMemory(): void {
  memoryCodes.clear();
}
