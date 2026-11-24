import crypto from 'node:crypto';
import Redis from 'ioredis';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as createKeyRoute } from '../src/app/api/keys/route';
import { DELETE as revokeKeyRoute } from '../src/app/api/keys/[id]/route';
import { ApiKeyLimitError, MAX_ACTIVE_API_KEYS } from '../src/lib/api-keys/types';
import { RedisKeyStore, redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { accountTaggedKeys } from '../src/lib/auth/erase-account-keys';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { createSessionToken } from '../src/lib/auth/session';
import { TERMS_VERSION } from '../src/lib/legal/documents';
import { clusterKeySlot } from './helpers/redis-cluster-slot';

/**
 * An account holds at most 20 active API keys (entry 296). Creation checks and updates the active-key index inside
 * `CREATE_API_KEY_LUA_SCRIPT` so concurrent requests across connections never pass 20 or roll each other back below 20,
 * revocations/deletions reclaim slots atomically, and pre-existing accounts without the index marker are synced once.
 */
const REDIS_URL = process.env.REDIS_URL;
// Hand-written from the brief: the number of active API keys an account holds.
const EXPECTED_LIMIT = 20;
const ORIGIN = 'http://localhost:3000';

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!REDIS_URL)('the active API key limit in Redis', () => {
  let admin: Redis;
  let clients: Redis[];
  let keyPrefix: string;
  let userId: string;

  const storeOf = (client: Redis, prefix = keyPrefix) => new RedisKeyStore({ keyPrefix: prefix, isolated: true, redisClient: client });

  beforeEach(() => {
    const suffix = crypto.randomBytes(6).toString('hex');
    keyPrefix = `keycap:{keys}:${suffix}:`;
    userId = `user-${suffix}`;
    admin = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    clients = Array.from({ length: 4 }, () => new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    redisKeyStore.setRedisClient(null);
    redisUserStore.setRedisClient(null);
    const keys = await admin.keys(`keycap:*${keyPrefix.split(':')[2]}*`);
    if (keys.length > 0) await admin.del(...keys);
    await Promise.all([admin, ...clients].map((client) => client.quit()));
  });

  it('refuses the 21st active key in Lua and writes nothing for it', async () => {
    expect(MAX_ACTIVE_API_KEYS).toBe(EXPECTED_LIMIT);
    const store = storeOf(clients[0]!);
    for (let i = 0; i < EXPECTED_LIMIT; i++) {
      await store.generateApiKey(userId, `k-${i}`);
    }

    const keysBefore = (await admin.keys(`${keyPrefix}*`)).sort();
    const hashesBefore = await admin.hlen(`${keyPrefix}apikey_hashes`);

    await expect(store.generateApiKey(userId, 'one-too-many')).rejects.toBeInstanceOf(ApiKeyLimitError);

    expect((await admin.keys(`${keyPrefix}*`)).sort()).toEqual(keysBefore);
    expect(await admin.hlen(`${keyPrefix}apikey_hashes`)).toBe(hashesBefore);
    expect(await admin.scard(`${keyPrefix}user_active_keys:${userId}`)).toBe(EXPECTED_LIMIT);
    expect(await admin.scard(`${keyPrefix}user_keys:${userId}`)).toBe(EXPECTED_LIMIT);
  });

  it('lets 60 concurrent creates across 4 Redis connections hit exactly 20 without overshooting or under-filling', async () => {
    const stores = clients.map((client) => storeOf(client));

    const outcomes = await Promise.allSettled(
      Array.from({ length: 60 }, (_, idx) => stores[idx % stores.length]!.generateApiKey(userId, `burst-${idx}`))
    );

    const created = outcomes.filter((o) => o.status === 'fulfilled');
    const refused = outcomes.filter((o) => o.status === 'rejected' && o.reason instanceof ApiKeyLimitError);
    expect(created).toHaveLength(EXPECTED_LIMIT);
    expect(refused).toHaveLength(60 - EXPECTED_LIMIT);
    expect(await admin.scard(`${keyPrefix}user_active_keys:${userId}`)).toBe(EXPECTED_LIMIT);
    expect(await admin.scard(`${keyPrefix}user_keys:${userId}`)).toBe(EXPECTED_LIMIT);
    expect((await stores[0]!.listApiKeys(userId)).filter((k) => k.status === 'active')).toHaveLength(EXPECTED_LIMIT);
  });

  it('reclaims active slots atomically on revokeApiKey and deleteApiKey while leaving revoked keys in user_keys', async () => {
    const store = storeOf(clients[0]!);
    const createdIds: string[] = [];
    for (let i = 0; i < EXPECTED_LIMIT; i++) {
      createdIds.push((await store.generateApiKey(userId, `k-${i}`)).key.id);
    }

    expect(await store.revokeApiKey(userId, createdIds[0]!)).toBe(true);
    expect(await store.revokeApiKey(userId, createdIds[1]!)).toBe(true);
    expect(await admin.scard(`${keyPrefix}user_active_keys:${userId}`)).toBe(EXPECTED_LIMIT - 2);
    expect(await admin.scard(`${keyPrefix}user_keys:${userId}`)).toBe(EXPECTED_LIMIT);

    const r1 = await store.generateApiKey(userId, 'replacement-1');
    const r2 = await store.generateApiKey(userId, 'replacement-2');
    await expect(store.generateApiKey(userId, 'over-limit')).rejects.toBeInstanceOf(ApiKeyLimitError);
    expect(await admin.scard(`${keyPrefix}user_active_keys:${userId}`)).toBe(EXPECTED_LIMIT);
    expect(await admin.scard(`${keyPrefix}user_keys:${userId}`)).toBe(EXPECTED_LIMIT + 2);

    expect(await store.deleteApiKey(userId, r1.key.id)).toBe(true);
    expect(await admin.scard(`${keyPrefix}user_active_keys:${userId}`)).toBe(EXPECTED_LIMIT - 1);
    const r3 = await store.generateApiKey(userId, 'replacement-3');
    expect(r3.key.id).not.toBe(r2.key.id);
    await expect(store.generateApiKey(userId, 'over-limit-again')).rejects.toBeInstanceOf(ApiKeyLimitError);
  });

  it('lazily syncs pre-existing unindexed user_keys without counting revoked keys or overshooting', async () => {
    const store = storeOf(clients[0]!);

    // Seed 19 active + 5 revoked keys directly in Redis without user_active_keys or user_active_keys_init.
    for (let i = 0; i < 24; i++) {
      const id = `legacy-${i}`;
      const status = i < 19 ? 'active' : 'revoked';
      const keyHash = crypto.createHash('sha256').update(`legacy-secret-${i}`).digest('hex');
      const record = {
        id,
        userId,
        name: id,
        prefix: 'ec_live_leg...',
        keyHash,
        createdAt: 1000 + i,
        status,
      };
      await admin.hset(`${keyPrefix}apikeys:${id}`, {
        id,
        userId,
        status,
        keyHash,
        previousKeyHash: '',
        data: JSON.stringify(record),
      });
      await admin.hset(`${keyPrefix}apikey_hashes`, keyHash, id);
      await admin.sadd(`${keyPrefix}user_keys:${userId}`, id);
    }

    // 20th active key is allowed after atomic sync; 21st is refused.
    const created20 = await store.generateApiKey(userId, 'twentieth');
    expect(created20.key.status).toBe('active');
    expect(await admin.get(`${keyPrefix}user_active_keys_init:${userId}`)).toBe('1');
    expect(await admin.scard(`${keyPrefix}user_active_keys:${userId}`)).toBe(EXPECTED_LIMIT);

    await expect(store.generateApiKey(userId, 'twenty-first')).rejects.toBeInstanceOf(ApiKeyLimitError);
    expect(await admin.scard(`${keyPrefix}user_keys:${userId}`)).toBe(25);
  });

  it('enforces the cap through POST /api/keys and DELETE /api/keys/[id] against real Redis and clears active index keys on erasure', async () => {
    const routePrefix = `keycap:{keys}:route-${crypto.randomBytes(4).toString('hex')}:`;
    const userStoreClient = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    const keyStoreClient = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    redisUserStore.setRedisClient(userStoreClient);
    redisKeyStore.setRedisClient(keyStoreClient);
    const createdKeysToClean: string[] = [];

    try {
      const user = redisUserStore.sanitizeUser(
        await redisUserStore.createUser({ email: `lua-route-${crypto.randomBytes(4).toString('hex')}@test.local`, name: 'Lua Route User' })
      );
      const cookie = `easyconvert_session=${createSessionToken(user)}`;
      const postReq = () =>
        new NextRequest(`${ORIGIN}/api/keys`, {
          method: 'POST',
          headers: { Origin: ORIGIN, Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ acceptedTermsVersion: TERMS_VERSION, name: 'route-key' }),
        });

      const burst = await Promise.all(Array.from({ length: EXPECTED_LIMIT + 10 }, () => createKeyRoute(postReq())));
      const created = burst.filter((r) => r.status === 200);
      const conflicted = burst.filter((r) => r.status === 409);
      expect(created).toHaveLength(EXPECTED_LIMIT);
      expect(conflicted).toHaveLength(10);
      for (const res of conflicted) {
        expect(await res.json()).toMatchObject({ success: false, code: 'key_limit_reached' });
      }

      const firstBody = (await created[0]!.json()) as { key: { id: string } };
      for (const res of created.slice(1)) {
        const body = (await res.json()) as { key: { id: string } };
        createdKeysToClean.push(body.key.id);
      }
      createdKeysToClean.push(firstBody.key.id);

      const delRes = await revokeKeyRoute(
        new NextRequest(`${ORIGIN}/api/keys/${firstBody.key.id}`, {
          method: 'DELETE',
          headers: { Origin: ORIGIN, Cookie: cookie },
        }),
        { params: Promise.resolve({ id: firstBody.key.id }) }
      );
      expect(delRes.status).toBe(200);

      const postAfterRevoke = await createKeyRoute(postReq());
      expect(postAfterRevoke.status).toBe(200);
      const postAfterBody = (await postAfterRevoke.json()) as { key: { id: string } };
      createdKeysToClean.push(postAfterBody.key.id);

      expect((await createKeyRoute(postReq())).status).toBe(409);

      const tagged = await accountTaggedKeys(user.id, { apiKeyIds: createdKeysToClean });
      const activePrefix = redisKeyStore.getPrefix();
      expect(tagged).toContain(`${activePrefix}user_active_keys:${user.id}`);
      expect(tagged).toContain(`${activePrefix}user_active_keys_init:${user.id}`);

      // Verify cluster slot alignment on real key names under a cluster prefix.
      const clusterKeys = [
        `${routePrefix}apikeys:k1`,
        `${routePrefix}apikey_hashes`,
        `${routePrefix}user_keys:${user.id}`,
        `${routePrefix}user_active_keys:${user.id}`,
        `${routePrefix}user_active_keys_init:${user.id}`,
        `${routePrefix}rate:apikey:k1`,
      ];
      expect(new Set(clusterKeys.map(clusterKeySlot)).size).toBe(1);

      if (tagged.length > 0) await admin.del(...tagged);
      await redisUserStore.deleteUser(user.id);
      expect(await admin.exists(`${activePrefix}user_active_keys:${user.id}`, `${activePrefix}user_active_keys_init:${user.id}`)).toBe(0);
    } finally {
      redisKeyStore.setRedisClient(null);
      redisUserStore.setRedisClient(null);
      await Promise.all([userStoreClient.quit(), keyStoreClient.quit()]);
    }
  });
});
