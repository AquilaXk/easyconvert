import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AUTH_TOKEN_TTL_SECONDS,
  consumeAuthToken,
  deleteAuthTokensOfUser,
  issueAuthToken,
} from '../src/lib/auth/auth-email-token-store';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { createSessionToken, getSessionFromRequest, revokeAllUserSessions, SESSION_COOKIE_NAME } from '../src/lib/auth/session';
import { TERMS_VERSION } from '../src/lib/legal/documents';

/**
 * The mailed-link tokens and the revocation of sessions against a real Redis: the atomic scripts, the lifetimes and what
 * is stored. Run by `npm run test:redis`; the in-memory behaviour has its own tests (tests/password-reset.test.ts).
 */

const created: string[] = [];

async function account() {
  const record = await redisUserStore.createUser({ email: `tokens_${crypto.randomUUID()}@redis.test`, name: 'Tokens', acceptedTermsVersion: TERMS_VERSION });
  created.push(record.id);
  return { userId: record.id, email: record.email, record };
}

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!process.env.REDIS_URL)('mailed-link tokens in Redis', () => {
  beforeAll(() => {
    vi.stubEnv('KEY_HASH_PEPPER', 'redis-fixture-pepper-0123456789abcdef0123456789abcdef');
  });

  afterAll(async () => {
    for (const userId of created) {
      await deleteAuthTokensOfUser(userId);
      await redisUserStore.deleteUser(userId);
    }
    vi.unstubAllEnvs();
  });

  it('keeps the lifetimes: 10 minutes for a reset, 24 hours for a verification', async () => {
    const { userId, email } = await account();
    const client = redisUserStore.getRedisClient()!;
    await issueAuthToken('reset', { userId, email });
    await issueAuthToken('verify', { userId, email });
    const prefix = redisUserStore.getKeyPrefix();
    for (const purpose of ['reset', 'verify'] as const) {
      const hash = (await client.get(`${prefix}auth_token_user:${purpose}:${userId}`))!;
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      const ttl = await client.ttl(`${prefix}auth_token:${purpose}:${hash}`);
      expect(ttl).toBeGreaterThan(AUTH_TOKEN_TTL_SECONDS[purpose] - 5);
      expect(ttl).toBeLessThanOrEqual(AUTH_TOKEN_TTL_SECONDS[purpose]);
      expect(await client.ttl(`${prefix}auth_token_user:${purpose}:${userId}`)).toBeLessThanOrEqual(AUTH_TOKEN_TTL_SECONDS[purpose]);
    }
  });

  it('stores a hash and never the token', async () => {
    const { userId, email } = await account();
    const client = redisUserStore.getRedisClient()!;
    const token = await issueAuthToken('reset', { userId, email });
    const hash = (await client.get(`${redisUserStore.getKeyPrefix()}auth_token_user:reset:${userId}`))!;
    expect(hash).not.toContain(token);
    const stored = (await client.get(`${redisUserStore.getKeyPrefix()}auth_token:reset:${hash}`))!;
    expect(stored).not.toContain(token);
    expect(JSON.parse(stored)).toEqual({ userId, email });
    // The hash is under the pepper: the same token hashes to another value without it.
    expect(hash).not.toBe(crypto.createHash('sha256').update(`easyconvert:auth-token:v1:reset:${token}`).digest('hex'));
  });

  it('lets exactly one of many simultaneous uses of a token through', async () => {
    const { userId, email } = await account();
    const token = await issueAuthToken('reset', { userId, email });
    const outcomes = await Promise.all(Array.from({ length: 25 }, () => consumeAuthToken('reset', token)));
    expect(outcomes.filter((outcome) => outcome !== null)).toEqual([{ userId, email }]);
    expect(await consumeAuthToken('reset', token)).toBeNull();
  });

  it('replaces the token of the account on a new request, and drops its pointer when it is used', async () => {
    const { userId, email } = await account();
    const client = redisUserStore.getRedisClient()!;
    const older = await issueAuthToken('reset', { userId, email });
    const newer = await issueAuthToken('reset', { userId, email });
    expect(await consumeAuthToken('reset', older)).toBeNull();
    expect(await consumeAuthToken('reset', newer)).toEqual({ userId, email });
    expect(await client.exists(`${redisUserStore.getKeyPrefix()}auth_token_user:reset:${userId}`)).toBe(0);
  });

  it('does not let a reset token do the work of a verification token', async () => {
    const { userId, email } = await account();
    const token = await issueAuthToken('reset', { userId, email });
    expect(await consumeAuthToken('verify', token)).toBeNull();
    expect(await consumeAuthToken('reset', token)).not.toBeNull();
  });

  it('accepts a token hashed under the previous pepper during a rotation', async () => {
    const { userId, email } = await account();
    const token = await issueAuthToken('reset', { userId, email });
    vi.stubEnv('KEY_HASH_PEPPER_PREVIOUS', process.env.KEY_HASH_PEPPER!);
    vi.stubEnv('KEY_HASH_PEPPER', 'rotated-fixture-pepper-0123456789abcdef0123456789abcdef');
    expect(await consumeAuthToken('reset', token)).toEqual({ userId, email });
    vi.stubEnv('KEY_HASH_PEPPER_PREVIOUS', '');
    vi.stubEnv('KEY_HASH_PEPPER', 'redis-fixture-pepper-0123456789abcdef0123456789abcdef');
  });

  it('deletes every token of an account for its erasure', async () => {
    const { userId, email } = await account();
    const reset = await issueAuthToken('reset', { userId, email });
    const verify = await issueAuthToken('verify', { userId, email });
    await deleteAuthTokensOfUser(userId);
    expect(await consumeAuthToken('reset', reset)).toBeNull();
    expect(await consumeAuthToken('verify', verify)).toBeNull();
    const client = redisUserStore.getRedisClient()!;
    expect(await client.keys(`${redisUserStore.getKeyPrefix()}auth_token_user:*:${userId}`)).toEqual([]);
  });

  it('ends the sessions of an account the first time they are revoked, as well as the second', async () => {
    const { userId, record } = await account();
    const cookieOf = (user: typeof record) => ({ headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken(redisUserStore.sanitizeUser(user))}` } });
    const first = new Request('http://localhost:3000/', cookieOf(record));
    expect(await getSessionFromRequest(first)).not.toBeNull();

    await revokeAllUserSessions(userId);
    expect(await getSessionFromRequest(first)).toBeNull();

    const second = new Request('http://localhost:3000/', cookieOf((await redisUserStore.findById(userId))!));
    expect(await getSessionFromRequest(second)).not.toBeNull();
    await revokeAllUserSessions(userId);
    expect(await getSessionFromRequest(second)).toBeNull();
  });
});
