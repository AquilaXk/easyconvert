import crypto from 'node:crypto';
import { hmacSha256, sha256 } from './crypto';
import { redisUserStore } from './redis-user-store';

/**
 * Single-use tokens that a mail carries: the password reset link (valid 10 minutes) and the email verification link
 * (valid 24 hours). Only a hash is stored, as for API key secrets: HMAC-SHA256 under `KEY_HASH_PEPPER` (the previous
 * pepper still verifies during a rotation), so a copy of the store cannot be turned into a working link. The token is 256
 * random bits, so the hash needs no slow function.
 *
 * Per account and purpose only the newest token is valid: issuing replaces the previous one. Using a token deletes it in
 * the same atomic step that reads it, so two requests with one token cannot both succeed.
 */

export type AuthTokenPurpose = 'reset' | 'verify';

export const AUTH_TOKEN_TTL_SECONDS: Readonly<Record<AuthTokenPurpose, number>> = {
  reset: 10 * 60,
  verify: 24 * 60 * 60,
};

const PURPOSES = Object.keys(AUTH_TOKEN_TTL_SECONDS) as AuthTokenPurpose[];
const TOKEN_BYTES = 32;
/** 32 bytes as unpadded base64url. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const HASH_LABEL = 'easyconvert:auth-token:v1:';

export interface AuthTokenSubject {
  userId: string;
  email: string;
}

interface MemoryToken extends AuthTokenSubject {
  expiresAt: number;
}

const ISSUE_LUA = `
-- KEYS[1]: token key, KEYS[2]: the account's pointer to its newest token
-- ARGV[1]: payload JSON, ARGV[2]: ttl seconds, ARGV[3]: token hash, ARGV[4]: token key prefix
local old = redis.call('GET', KEYS[2])
if old then redis.call('DEL', ARGV[4] .. old) end
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
redis.call('SET', KEYS[2], ARGV[3], 'EX', tonumber(ARGV[2]))
return 1
`;

const CONSUME_LUA = `
-- KEYS[1]: token key; ARGV[1]: pointer key prefix, ARGV[2]: token hash
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
redis.call('DEL', KEYS[1])
local data = cjson.decode(raw)
local pointer = ARGV[1] .. data['userId']
if redis.call('GET', pointer) == ARGV[2] then redis.call('DEL', pointer) end
return raw
`;

const memoryTokens = new Map<string, MemoryToken>();
const memoryPointers = new Map<string, string>();

function pepperHashes(purpose: AuthTokenPurpose, token: string): string[] {
  const material = `${HASH_LABEL}${purpose}:${token}`;
  const pepper = process.env.KEY_HASH_PEPPER;
  if (!pepper) {
    if (process.env.NODE_ENV === 'production') throw new Error('KEY_HASH_PEPPER is required in production');
    return [sha256(material)];
  }
  const hashes = [hmacSha256(pepper, material)];
  const previous = process.env.KEY_HASH_PEPPER_PREVIOUS;
  if (previous) hashes.push(hmacSha256(previous, material));
  return hashes;
}

const tokenKey = (purpose: AuthTokenPurpose, hash: string) => `${redisUserStore.getKeyPrefix()}auth_token:${purpose}:${hash}`;
const pointerKey = (purpose: AuthTokenPurpose, userId: string) =>
  `${redisUserStore.getKeyPrefix()}auth_token_user:${purpose}:${userId}`;

/** Whether `value` has the shape of a token this store issues; anything else cannot be one. */
export function isAuthTokenShape(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_SHAPE.test(value);
}

/** Makes a token for the account and returns it; this is the only time the token exists in the clear. */
export async function issueAuthToken(purpose: AuthTokenPurpose, subject: AuthTokenSubject): Promise<string> {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const [hash] = pepperHashes(purpose, token);
  const ttl = AUTH_TOKEN_TTL_SECONDS[purpose];
  const redis = redisUserStore.getRedisClient();
  if (redis) {
    await redis.eval(
      ISSUE_LUA,
      2,
      tokenKey(purpose, hash),
      pointerKey(purpose, subject.userId),
      JSON.stringify(subject),
      String(ttl),
      hash,
      tokenKey(purpose, '')
    );
    return token;
  }
  const pointer = pointerKey(purpose, subject.userId);
  const old = memoryPointers.get(pointer);
  if (old) memoryTokens.delete(tokenKey(purpose, old));
  memoryTokens.set(tokenKey(purpose, hash), { ...subject, expiresAt: Date.now() + ttl * 1000 });
  memoryPointers.set(pointer, hash);
  return token;
}

function parseSubject(raw: string): AuthTokenSubject | null {
  try {
    const data = JSON.parse(raw) as Partial<AuthTokenSubject>;
    return typeof data.userId === 'string' && typeof data.email === 'string' ? { userId: data.userId, email: data.email } : null;
  } catch {
    return null;
  }
}

async function consumeHash(purpose: AuthTokenPurpose, hash: string): Promise<AuthTokenSubject | null> {
  const redis = redisUserStore.getRedisClient();
  if (redis) {
    const raw = await redis.eval(CONSUME_LUA, 1, tokenKey(purpose, hash), pointerKey(purpose, ''), hash);
    return typeof raw === 'string' ? parseSubject(raw) : null;
  }
  const key = tokenKey(purpose, hash);
  const entry = memoryTokens.get(key);
  if (!entry) return null;
  memoryTokens.delete(key);
  if (memoryPointers.get(pointerKey(purpose, entry.userId)) === hash) memoryPointers.delete(pointerKey(purpose, entry.userId));
  return Date.now() < entry.expiresAt ? { userId: entry.userId, email: entry.email } : null;
}

/** Uses up the token: the account it was issued for, or null when it is unknown, used or expired. A token works once. */
export async function consumeAuthToken(purpose: AuthTokenPurpose, token: string): Promise<AuthTokenSubject | null> {
  if (!isAuthTokenShape(token)) return null;
  for (const hash of pepperHashes(purpose, token)) {
    const subject = await consumeHash(purpose, hash);
    if (subject) return subject;
  }
  return null;
}

/** Deletes every token of the account, for the erasure of the account. */
export async function deleteAuthTokensOfUser(userId: string): Promise<void> {
  const redis = redisUserStore.getRedisClient();
  for (const purpose of PURPOSES) {
    const pointer = pointerKey(purpose, userId);
    if (redis) {
      const hash = await redis.get(pointer);
      await redis.del(...(hash ? [tokenKey(purpose, hash), pointer] : [pointer]));
    }
    const hash = memoryPointers.get(pointer);
    if (hash) memoryTokens.delete(tokenKey(purpose, hash));
    memoryPointers.delete(pointer);
  }
}

/** Forgets every in-memory token; for tests. */
export function resetAuthTokenMemory(): void {
  memoryTokens.clear();
  memoryPointers.clear();
}
