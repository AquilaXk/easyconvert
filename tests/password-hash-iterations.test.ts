import crypto from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as loginHandler } from '../src/app/api/auth/login/route';
import { POST as registerHandler } from '../src/app/api/auth/register/route';
import { LEGACY_PBKDF2_ITERATIONS, PBKDF2_ITERATIONS, hashPassword, verifyPassword } from '../src/lib/auth/crypto';
import { resetLoginRateLimiterStore } from '../src/lib/auth/login-rate-limiter';
import { RedisUserStore, redisUserStore } from '../src/lib/auth/redis-user-store';
import { TERMS_VERSION } from '../src/lib/legal/documents';

/**
 * Passwords are hashed with PBKDF2-HMAC-SHA512 at 210,000 iterations (the OWASP Password Storage Cheat Sheet figure). A hash made
 * with the 100,000 of the earlier releases (no `passwordIterations` on the record) still signs in, is replaced by a current one when
 * its owner signs in, and costs as much to check as a current one until then. Rules after Django's PBKDF2PasswordHasher (NOTICE).
 */
const OWASP_PBKDF2_SHA512_ITERATIONS = 210_000;
const OLD_ITERATIONS = 100_000;
const PASSWORD = 'Correct-Horse-Battery-9';

/** The hash an earlier release stored: 100,000 iterations, nothing on the record to say so. */
function legacyHash(password: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  return { hash: crypto.pbkdf2Sync(password, salt, OLD_ITERATIONS, 64, 'sha512').toString('hex'), salt };
}

function login(email: string, password: string): Promise<Response> {
  return loginHandler(
    new NextRequest('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  resetLoginRateLimiterStore();
});

describe('the number of iterations', () => {
  it('is the OWASP figure for PBKDF2-HMAC-SHA512, and the earlier one is named', () => {
    expect(PBKDF2_ITERATIONS).toBe(OWASP_PBKDF2_SHA512_ITERATIONS);
    expect(LEGACY_PBKDF2_ITERATIONS).toBe(OLD_ITERATIONS);
  });

  it('hashes with it and says so', async () => {
    const spy = vi.spyOn(crypto, 'pbkdf2');
    const { hash, salt, iterations } = await hashPassword(PASSWORD);
    expect(iterations).toBe(OWASP_PBKDF2_SHA512_ITERATIONS);
    expect(spy.mock.calls.map((call) => call[2])).toEqual([OWASP_PBKDF2_SHA512_ITERATIONS]);
    expect(await verifyPassword(PASSWORD, hash, salt, iterations)).toBe(true);
    expect(await verifyPassword('Wrong-Password-1', hash, salt, iterations)).toBe(false);
  });

  it('checks a hash of the earlier release with its own iterations and runs the missing ones too, so that it costs as much as a current one', async () => {
    const { hash, salt } = legacyHash(PASSWORD);
    const spy = vi.spyOn(crypto, 'pbkdf2');
    expect(await verifyPassword(PASSWORD, hash, salt, OLD_ITERATIONS)).toBe(true);
    expect(spy.mock.calls.map((call) => call[2])).toEqual([OLD_ITERATIONS, OWASP_PBKDF2_SHA512_ITERATIONS - OLD_ITERATIONS]);
    spy.mockClear();
    expect(await verifyPassword('Wrong-Password-1', hash, salt, OLD_ITERATIONS)).toBe(false);
    expect(spy.mock.calls.map((call) => (call[2] as number))).toEqual([OLD_ITERATIONS, OWASP_PBKDF2_SHA512_ITERATIONS - OLD_ITERATIONS]);
  });
});

describe('sign-in with a hash of the earlier release', () => {
  beforeEach(() => redisUserStore.resetStore());

  async function legacyAccount(): Promise<{ email: string; id: string }> {
    const email = `legacy_${crypto.randomBytes(6).toString('hex')}@iterations.test`;
    const { hash, salt } = legacyHash(PASSWORD);
    const record = await redisUserStore.createUser({ email, name: 'Legacy', tier: 'free', provider: 'email', passwordHash: hash, salt, emailVerified: true });
    return { email, id: record.id };
  }

  it('signs in and replaces the hash by one with the current iterations', async () => {
    const { email, id } = await legacyAccount();
    const before = await redisUserStore.findById(id);
    expect(before?.passwordIterations).toBeUndefined();

    const response = await login(email, PASSWORD);
    expect(response.status).toBe(200);

    const after = await redisUserStore.findById(id);
    expect(after?.passwordIterations).toBe(OWASP_PBKDF2_SHA512_ITERATIONS);
    expect(after?.passwordHash).not.toBe(before?.passwordHash);
    expect(await verifyPassword(PASSWORD, after!.passwordHash!, after!.salt!, after!.passwordIterations)).toBe(true);
    expect((await login(email, PASSWORD)).status).toBe(200);
  });

  it('does not replace the hash when the password is wrong', async () => {
    const { email, id } = await legacyAccount();
    const before = await redisUserStore.findById(id);
    expect((await login(email, 'Wrong-Password-1')).status).toBe(401);
    expect(await redisUserStore.findById(id)).toMatchObject({ passwordHash: before?.passwordHash, salt: before?.salt });
  });

  it('keeps a password changed while the sign-in derived its new hash', async () => {
    const { id } = await legacyAccount();
    const stale = await redisUserStore.findById(id);
    const changed = await hashPassword('Changed-Meanwhile-7');
    await redisUserStore.updateUser(id, { passwordHash: changed.hash, salt: changed.salt, passwordIterations: changed.iterations });
    const replaced = await redisUserStore.replacePasswordHash(id, stale!.passwordHash!, { passwordHash: 'x'.repeat(128), salt: 'y'.repeat(32), passwordIterations: PBKDF2_ITERATIONS });
    expect(replaced).toBe(false);
    expect(await redisUserStore.findById(id)).toMatchObject({ passwordHash: changed.hash, salt: changed.salt });
  });

  it('records the iterations of a new account at registration', async () => {
    const email = `fresh_${crypto.randomBytes(6).toString('hex')}@iterations.test`;
    const response = await registerHandler(
      new NextRequest('http://localhost:3000/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD, name: 'Fresh', acceptedTermsVersion: TERMS_VERSION }),
      })
    );
    expect(response.status).toBeLessThan(300);
    const record = await redisUserStore.findByEmail(email);
    expect(record?.passwordIterations).toBe(OWASP_PBKDF2_SHA512_ITERATIONS);
    expect(await verifyPassword(PASSWORD, record!.passwordHash!, record!.salt!, record!.passwordIterations)).toBe(true);
  });
});

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!process.env.REDIS_URL)('the compare-and-set of a replaced hash on a real Redis server', () => {
  let client: Redis;
  let store: RedisUserStore;
  beforeAll(() => {
    client = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: 1 });
    store = new RedisUserStore({ redisClient: client, keyPrefix: `iterations-${crypto.randomBytes(4).toString('hex')}:{user}:` });
  });
  afterAll(async () => {
    await client.quit();
  });

  it('replaces the hash it was given and refuses one that has changed', async () => {
    const { hash, salt } = legacyHash(PASSWORD);
    const record = await store.createUser({ email: `cas_${crypto.randomBytes(4).toString('hex')}@iterations.test`, name: 'Cas', passwordHash: hash, salt });
    const next = await hashPassword(PASSWORD);
    expect(await store.replacePasswordHash(record.id, 'not-the-hash', { passwordHash: next.hash, salt: next.salt, passwordIterations: next.iterations })).toBe(false);
    expect((await store.findById(record.id))?.passwordHash).toBe(hash);
    expect(await store.replacePasswordHash(record.id, hash, { passwordHash: next.hash, salt: next.salt, passwordIterations: next.iterations })).toBe(true);
    expect(await store.findById(record.id)).toMatchObject({ passwordHash: next.hash, salt: next.salt, passwordIterations: OWASP_PBKDF2_SHA512_ITERATIONS });
    expect(await store.replacePasswordHash('missing-user', hash, { passwordHash: next.hash, salt: next.salt, passwordIterations: next.iterations })).toBe(false);
  });
});
