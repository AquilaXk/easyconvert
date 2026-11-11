import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as meRoute } from '../src/app/api/auth/me/route';
import { POST as logoutRoute } from '../src/app/api/auth/logout/route';
import { validateApiAccess } from '../src/lib/api-keys/guard';
import { RedisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { signJwt, DEFAULT_JWT_AUDIENCE, DEFAULT_JWT_ISSUER } from '../src/lib/auth/jwt';
import { RedisUserStore, redisUserStore } from '../src/lib/auth/redis-user-store';
import { createSessionToken, getSessionFromToken, SESSION_COOKIE_NAME } from '../src/lib/auth/session';
import { AuthStoreUnavailableError } from '../src/lib/auth/store-unavailable';

/**
 * With a Redis client, the stores that decide who a caller is answer only from Redis. A Redis that fails is a 503 (the
 * request is neither accepted nor refused as unknown), never an answer from this process's memory or from a file of
 * `.easyconvert`, which would still accept a deleted key, a revoked session or an old session version.
 */

const HTTP_UNAVAILABLE = 503;

/** A client whose every command fails, as a Redis that stopped answering. */
function brokenRedis(): Redis {
  return new Proxy({}, {
    get: (_target, property) => (property === 'then' ? undefined : () => Promise.reject(new Error(`redis down: ${String(property)}`))),
  }) as unknown as Redis;
}

/** A client that accepts every write and answers nothing: enough to see what a store writes elsewhere. */
function silentRedis(): Redis {
  return new Proxy({}, {
    get: (_target, property) => {
      if (property === 'then') return undefined;
      return () => (property === 'pipeline' ? { hgetall: () => undefined, exec: async () => [] } : Promise.resolve(property === 'smembers' ? [] : property === 'hgetall' ? {} : 1));
    },
  }) as unknown as Redis;
}

/** What a step that must refuse threw: the typed 503 error. */
async function refusal(step: Promise<unknown>): Promise<AuthStoreUnavailableError> {
  const outcome = await step.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
  if (!('error' in outcome)) throw new Error(`the step answered ${JSON.stringify(outcome.value)} instead of refusing`);
  expect(outcome.error).toBeInstanceOf(AuthStoreUnavailableError);
  return outcome.error as AuthStoreUnavailableError;
}

function uniqueEmail(): string {
  return `failclosed_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@test.com`;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  redisUserStore.setRedisClient(null);
  redisKeyStore.setRedisClient(null);
});

describe('the user store with a Redis client', () => {
  it.each([
    ['findById', (store: RedisUserStore, id: string) => store.findById(id)],
    ['findByEmail', (store: RedisUserStore) => store.findByEmail('someone@example.com')],
    ['createUser', (store: RedisUserStore) => store.createUser({ email: uniqueEmail(), name: 'New' })],
    ['updateUser', (store: RedisUserStore, id: string) => store.updateUser(id, { name: 'Renamed' })],
    ['recordConversion', (store: RedisUserStore, id: string) => store.recordConversion(id)],
    ['revokeJti', (store: RedisUserStore) => store.revokeJti('jti-1', 60)],
    ['isJtiRevoked', (store: RedisUserStore) => store.isJtiRevoked('jti-1')],
    ['incrementSessionVersion', (store: RedisUserStore, id: string) => store.incrementSessionVersion(id)],
    ['getSessionVersion', (store: RedisUserStore, id: string) => store.getSessionVersion(id)],
  ])('refuses %s when Redis fails, whatever this process holds in memory', async (_name, step) => {
    const store = new RedisUserStore();
    const user = await store.createUser({ email: uniqueEmail(), name: 'Memory user' });
    await store.revokeJti('jti-1', 60);
    store.setRedisClient(brokenRedis());

    expect((await refusal(step(store, user.id))).status).toBe(HTTP_UNAVAILABLE);
  });

  it('does not take a revoked session for a live one when the revocation list cannot be read', async () => {
    const store = new RedisUserStore();
    await store.revokeJti('jti-revoked', 60);
    store.setRedisClient(brokenRedis());

    expect((await refusal(store.isJtiRevoked('jti-revoked'))).status).toBe(HTTP_UNAVAILABLE);
  });
});

describe('a session token', () => {
  it('is refused when it carries no session version, whatever the version of the account', async () => {
    const user = await redisUserStore.createUser({ email: uniqueEmail(), name: 'Claimless' });
    const withoutClaim = signJwt({ sub: user.id, email: user.email, name: user.name, tier: user.tier }, { issuer: DEFAULT_JWT_ISSUER, audience: DEFAULT_JWT_AUDIENCE });
    const withClaim = createSessionToken(redisUserStore.sanitizeUser(user));

    expect(await getSessionFromToken(withoutClaim)).toBeNull();
    expect((await getSessionFromToken(withClaim))?.id).toBe(user.id);
  });

  it('is refused after a revocation of all sessions and still when the token has no claim', async () => {
    const user = await redisUserStore.createUser({ email: uniqueEmail(), name: 'Revoked' });
    const old = createSessionToken(redisUserStore.sanitizeUser(user));
    await redisUserStore.incrementSessionVersion(user.id);
    const withoutClaim = signJwt({ sub: user.id, email: user.email, name: user.name, tier: user.tier });

    expect(await getSessionFromToken(old)).toBeNull();
    expect(await getSessionFromToken(withoutClaim)).toBeNull();
  });

  it('is never accepted without the check when the store fails', async () => {
    const user = await redisUserStore.createUser({ email: uniqueEmail(), name: 'Offline' });
    const token = createSessionToken(redisUserStore.sanitizeUser(user));
    redisUserStore.setRedisClient(brokenRedis());

    expect((await refusal(getSessionFromToken(token))).status).toBe(HTTP_UNAVAILABLE);
  });
});

describe('the key store with a Redis client', () => {
  it('answers a verification it cannot make as unavailable, and does not accept a key that this process remembers', async () => {
    const store = new RedisKeyStore({ keyPrefix: `failclosed:${crypto.randomBytes(4).toString('hex')}:`, isolated: true });
    const user = await redisUserStore.createUser({ email: uniqueEmail(), name: 'Key owner' });
    const { secretKey } = await store.generateApiKey(user.id, 'Remembered key', { scopes: ['*'] });
    expect((await store.verifyApiKey(secretKey)).valid).toBe(true);
    store.setRedisClient(brokenRedis());

    const verification = await store.verifyApiKey(secretKey);

    expect(verification.valid).toBe(false);
    expect(verification.serviceUnavailable).toBe(true);
    expect(verification.key).toBeUndefined();
  });

  it.each([
    ['listApiKeys', (store: RedisKeyStore, userId: string) => store.listApiKeys(userId)],
    ['revokeApiKey', (store: RedisKeyStore, userId: string, keyId: string) => store.revokeApiKey(userId, keyId)],
    ['updateApiKey', (store: RedisKeyStore, userId: string, keyId: string) => store.updateApiKey(userId, keyId, { name: 'x' })],
    ['deleteApiKey', (store: RedisKeyStore, userId: string, keyId: string) => store.deleteApiKey(userId, keyId)],
    ['generateApiKey', (store: RedisKeyStore, userId: string) => store.generateApiKey(userId, 'never issued', {})],
  ])('refuses %s when Redis fails instead of changing only this process', async (_name, step) => {
    const store = new RedisKeyStore({ keyPrefix: `failclosed:${crypto.randomBytes(4).toString('hex')}:`, isolated: true });
    const user = await redisUserStore.createUser({ email: uniqueEmail(), name: 'Key owner' });
    const { key } = await store.generateApiKey(user.id, 'Remembered key', {});
    store.setRedisClient(brokenRedis());

    expect((await refusal(step(store, user.id, key.id))).status).toBe(HTTP_UNAVAILABLE);
  });

  it('does not issue a key that Redis did not store', async () => {
    const store = new RedisKeyStore({ keyPrefix: `failclosed:${crypto.randomBytes(4).toString('hex')}:`, isolated: true, redisClient: brokenRedis() });
    const user = await redisUserStore.createUser({ email: uniqueEmail(), name: 'Key owner' });

    expect((await refusal(store.generateApiKey(user.id, 'Local only', {}))).status).toBe(HTTP_UNAVAILABLE);
    expect(await store.listApiKeys(user.id).catch(() => 'unavailable')).toBe('unavailable');
  });

  it('writes no JSON mirror of keys, usage or files while Redis is the store', async () => {
    const dir = path.resolve(process.cwd(), '.easyconvert');
    const keysFile = path.join(dir, 'api-keys.json');
    const before = fs.existsSync(keysFile) ? fs.readFileSync(keysFile, 'utf-8') : null;
    const store = new RedisKeyStore({ keyPrefix: `failclosed:${crypto.randomBytes(4).toString('hex')}:`, isolated: true, redisClient: silentRedis() });
    const user = await redisUserStore.createUser({ email: uniqueEmail(), name: 'Mirror owner' });

    const { key } = await store.generateApiKey(user.id, 'No mirror', {});

    const after = fs.existsSync(keysFile) ? fs.readFileSync(keysFile, 'utf-8') : null;
    expect(after).toBe(before);
    expect(after ?? '').not.toContain(key.id);
  });
});

describe('a request while the account store is down', () => {
  async function apiKeyHeader(): Promise<string> {
    const user = await redisUserStore.createUser({ email: uniqueEmail(), name: 'Outage user' });
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'Outage key', { scopes: ['*'] });
    return secretKey;
  }

  it('answers 503 with Retry-After to a request with an API key, not an acceptance', async () => {
    const secretKey = await apiKeyHeader();
    redisKeyStore.setRedisClient(brokenRedis());

    const auth = await validateApiAccess(new Request('http://localhost/api/v1/jobs', { headers: { Authorization: `Bearer ${secretKey}` } }), { requiredUnits: 0 });

    expect(auth.authorized).toBe(false);
    expect(auth.status).toBe(HTTP_UNAVAILABLE);
    expect(auth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('answers 503 to a request with a session', async () => {
    const user = await redisUserStore.createUser({ email: uniqueEmail(), name: 'Session user' });
    const token = createSessionToken(redisUserStore.sanitizeUser(user));
    redisUserStore.setRedisClient(brokenRedis());

    const auth = await validateApiAccess(new Request('http://localhost/api/v1/jobs', { headers: { Authorization: `Bearer ${token}` } }), { requiredUnits: 0 });

    expect(auth.authorized).toBe(false);
    expect(auth.status).toBe(HTTP_UNAVAILABLE);
  });

  it('answers /api/auth/me with 503 and Retry-After, not as signed out', async () => {
    const user = await redisUserStore.createUser({ email: uniqueEmail(), name: 'Me user' });
    const token = createSessionToken(redisUserStore.sanitizeUser(user));
    redisUserStore.setRedisClient(brokenRedis());

    const res = await meRoute(new NextRequest('http://localhost/api/auth/me', { headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } }));

    expect(res.status).toBe(HTTP_UNAVAILABLE);
    expect(res.headers.get('retry-after')).not.toBeNull();
  });

  it('answers a sign-out whose revocation was not stored with 503, and keeps the cookie', async () => {
    const user = await redisUserStore.createUser({ email: uniqueEmail(), name: 'Logout user' });
    const token = createSessionToken(redisUserStore.sanitizeUser(user));
    redisUserStore.setRedisClient(brokenRedis());

    const res = await logoutRoute(new Request('http://localhost/api/auth/logout', { method: 'POST', headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } }));

    expect(res.status).toBe(HTTP_UNAVAILABLE);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
