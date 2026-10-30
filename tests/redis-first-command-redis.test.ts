import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RedisIdempotencyStore } from '../src/lib/api/idempotency';
import { RedisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { RedisUserStore } from '../src/lib/auth/redis-user-store';
import { CredentialsVault } from '../src/lib/storage/credentials-vault';
import { RedisTusSessionStore, type TusSession } from '../src/lib/storage/tus-engine';

/**
 * A store built from the environment connects on its own, and its Redis client has no offline queue, so a command
 * sent before the connection is ready is refused. Each case builds a store and sends the first command at once, the
 * way the first request after a web server starts does, and reads the outcome back through a separate connection.
 * Runs only when REDIS_URL is set, like the other Redis suites.
 */
const REDIS_URL = process.env.REDIS_URL;
const SESSION_TTL_MS = 60_000;

function uniqueId(label: string): string {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!REDIS_URL)('first Redis command after construction', () => {
  let probe: Redis;
  const closers: Array<() => Promise<unknown> | unknown> = [];

  beforeAll(() => {
    probe = new Redis(REDIS_URL as string);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (closers.length > 0) await closers.pop()?.();
  });

  afterAll(async () => {
    await probe.quit();
  });

  it('lets a new key store answer its first rate-limit call', async () => {
    const store = new RedisKeyStore({ redisUrl: REDIS_URL, keyPrefix: `${uniqueId('rl')}:`, isolated: true });
    closers.push(() => store.close());

    const result = await store.checkTokenBucketRateLimit(uniqueId('client'));

    expect(result.serviceUnavailable).toBeUndefined();
    expect(result.allowed).toBe(true);
  });

  it('lets a new key store list the keys of a user on its first call', async () => {
    const store = new RedisKeyStore({ redisUrl: REDIS_URL, keyPrefix: `${uniqueId('keys')}:`, isolated: true });
    closers.push(() => store.close());
    const userId = uniqueId('user');

    const created = await store.generateApiKey(userId, 'first call');
    const listed = await store.listApiKeys(userId);

    expect(listed.map((key) => key.id)).toContain(created.key.id);
    expect(await probe.smembers(`${store.getPrefix()}user_keys:${userId}`)).toContain(created.key.id);
  });

  it('lets a new user store write a revoked token to Redis on its first call', async () => {
    const store = new RedisUserStore({ redisUrl: REDIS_URL, keyPrefix: `${uniqueId('users')}:{user}:` });
    closers.push(() => store.close());
    const jti = uniqueId('jti');

    await store.revokeJti(jti, 60);

    expect(await probe.exists(`${store.getKeyPrefix()}revoked_jti:${jti}`)).toBe(1);
  });

  it('lets a new idempotency store acquire a key on its first call', async () => {
    const store = new RedisIdempotencyStore({ redisUrl: REDIS_URL });
    closers.push(() => store.getClient().quit());

    const result = await store.acquire(uniqueId('idem'), 'fingerprint');

    expect(result.status).toBe('acquired');
  });

  it('lets a new tus session store save a session on its first call', async () => {
    vi.stubEnv('REDIS_URL', REDIS_URL as string);
    const store = new RedisTusSessionStore();
    const now = Date.now();
    const session: TusSession = {
      id: uniqueId('tus'),
      uploadLength: 1,
      uploadOffset: 0,
      metadata: '',
      parsedMetadata: {},
      key: 'uploads/first-call',
      filename: 'first-call.txt',
      mimeType: 'text/plain',
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      completed: false,
    };
    closers.push(() => store.deleteSession(session.id));

    await store.saveSession(session);

    expect(await probe.exists(`tus:session:${session.id}`)).toBe(1);
  });

  it('lets a new credentials vault save credentials on its first call', async () => {
    vi.stubEnv('REDIS_URL', REDIS_URL as string);
    const vault = new CredentialsVault();
    const userId = uniqueId('vault-user');

    const ref = await vault.store(userId, {
      type: 's3',
      bucket: 'customer-bucket',
      accessKeyId: 'AKIACUSTOMEREXAMPLE1',
      secretAccessKey: 'customer/Secret+EXAMPLEKEY000000000000',
    });
    closers.push(() => vault.delete(ref, userId));

    expect(await probe.exists(`vault:cred:${ref}`)).toBe(1);
  });
});
