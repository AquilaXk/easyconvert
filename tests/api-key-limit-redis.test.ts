import crypto from 'node:crypto';
import Redis from 'ioredis';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as createKeyRoute } from '../src/app/api/keys/route';
import { DELETE as revokeKeyRoute } from '../src/app/api/keys/[id]/route';
import { ApiKeyLimitError, MAX_ACTIVE_API_KEYS } from '../src/lib/api-keys/types';
import { RedisKeyStore, redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { setWebhookSecretStore } from '../src/lib/api-keys/webhook-secret-store';
import { AuthStoreUnavailableError } from '../src/lib/auth/store-unavailable';
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
    const routeKeyStore = new RedisKeyStore({ keyPrefix: routePrefix, isolated: true, redisClient: keyStoreClient });
    redisUserStore.setRedisClient(userStoreClient);
    redisKeyStore.setRedisClient(keyStoreClient);
    vi.spyOn(redisKeyStore, 'getPrefix').mockReturnValue(routePrefix);
    vi.spyOn(redisKeyStore, 'getRedisClient').mockReturnValue(keyStoreClient);
    vi.spyOn(redisKeyStore, 'generateApiKey').mockImplementation((...args) => routeKeyStore.generateApiKey(...args));
    vi.spyOn(redisKeyStore, 'revokeApiKey').mockImplementation((...args) => routeKeyStore.revokeApiKey(...args));
    vi.spyOn(redisKeyStore, 'deleteApiKey').mockImplementation((...args) => routeKeyStore.deleteApiKey(...args));
    vi.spyOn(redisKeyStore, 'listApiKeys').mockImplementation((...args) => routeKeyStore.listApiKeys(...args));
    vi.spyOn(redisKeyStore, 'listUserFiles').mockImplementation((...args) => routeKeyStore.listUserFiles(...args));
    vi.spyOn(redisKeyStore, 'withCreditTier').mockImplementation((...args) => routeKeyStore.withCreditTier(...args));

    const createdKeysToClean: string[] = [];
    const createdHashesToClean: string[] = [];
    let createdUserId: string | null = null;

    try {
      const user = redisUserStore.sanitizeUser(
        await redisUserStore.createUser({ email: `lua-route-${crypto.randomBytes(4).toString('hex')}@test.local`, name: 'Lua Route User' })
      );
      createdUserId = user.id;
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

      const listed = await routeKeyStore.listApiKeys(user.id, { decryptSecrets: false });
      for (const entry of listed) {
        if (entry.keyHash) createdHashesToClean.push(entry.keyHash);
      }
      expect(await admin.hlen(`${routePrefix}apikey_hashes`)).toBe(EXPECTED_LIMIT + 1);
      expect(await admin.exists(`easyconvert:user_active_keys:${user.id}`)).toBe(0);

      const tagged = await accountTaggedKeys(user.id, { apiKeyIds: createdKeysToClean });
      const activePrefix = redisKeyStore.getPrefix();
      expect(activePrefix).toBe(routePrefix);
      expect(tagged).toContain(`${routePrefix}user_active_keys:${user.id}`);
      expect(tagged).toContain(`${routePrefix}user_active_keys_init:${user.id}`);

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
      if (createdHashesToClean.length > 0) await admin.hdel(`${routePrefix}apikey_hashes`, ...createdHashesToClean);
      await admin.del(`${routePrefix}apikey_hashes`);
      await redisUserStore.deleteUser(user.id);
      createdUserId = null;
      expect(await admin.exists(`${routePrefix}user_active_keys:${user.id}`, `${routePrefix}user_active_keys_init:${user.id}`)).toBe(0);
      expect(await admin.keys(`${routePrefix}*`)).toEqual([]);
    } finally {
      const leftover = await admin.keys(`${routePrefix}*`);
      if (leftover.length > 0) await admin.del(...leftover);
      if (createdUserId) {
        await redisUserStore.deleteUser(createdUserId).catch(() => undefined);
      }
      setWebhookSecretStore(null);
      redisKeyStore.setRedisClient(null);
      redisUserStore.setRedisClient(null);
      await Promise.all([userStoreClient.quit(), keyStoreClient.quit()]);
    }
  });

  async function seedLegacyUnindexedKeys(activeCount: number, revokedCount: number): Promise<void> {
    const total = activeCount + revokedCount;
    for (let i = 0; i < total; i++) {
      const id = `legacy-${i}`;
      const status = i < activeCount ? 'active' : 'revoked';
      const keyHash = crypto.createHash('sha256').update(`legacy-adv-secret-${keyPrefix}-${i}`).digest('hex');
      const record = {
        id,
        userId,
        name: id,
        prefix: 'ec_live_adv...',
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
  }

  it('handles 40 concurrent creates across 4 clients racing revokeApiKey during legacy backfill', async () => {
    await seedLegacyUnindexedKeys(19, 5);
    const stores = clients.map((client) => storeOf(client));

    const createPromises = Array.from({ length: 40 }, (_, i) =>
      stores[i % stores.length]!.generateApiKey(userId, `race-${i}`)
    );
    const revokePromise = stores[0]!.revokeApiKey(userId, 'legacy-0');
    const [createSettled, revokeSettled] = await Promise.all([
      Promise.allSettled(createPromises),
      revokePromise,
    ]);

    expect(revokeSettled).toBe(true);
    const succeeded = createSettled.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<RedisKeyStore['generateApiKey']>>> => r.status === 'fulfilled');
    const rejected = createSettled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    expect(succeeded.length).toBeLessThanOrEqual(2);
    expect(rejected).toHaveLength(40 - succeeded.length);
    for (const err of rejected) {
      expect(err.reason).toBeInstanceOf(ApiKeyLimitError);
    }

    expect(await admin.get(`${keyPrefix}user_active_keys_init:${userId}`)).toBe('1');
    const activeMembers = await admin.smembers(`${keyPrefix}user_active_keys:${userId}`);
    expect(activeMembers.length).toBeLessThanOrEqual(EXPECTED_LIMIT);
    expect(activeMembers).not.toContain('legacy-0');
    for (let i = 19; i < 24; i++) {
      expect(activeMembers).not.toContain(`legacy-${i}`);
    }

    const listed = await stores[1]!.listApiKeys(userId, { decryptSecrets: false });
    const listedActiveIds = listed.filter((k) => k.status === 'active').map((k) => k.id).sort();
    expect([...activeMembers].sort()).toEqual(listedActiveIds);

    // Fill any single slot reclaimed if revoke happened after initial cap, then verify strict 20 cap.
    if (listedActiveIds.length === EXPECTED_LIMIT - 1) {
      await stores[2]!.generateApiKey(userId, 'fill-reclaimed-slot');
    }
    expect(await admin.scard(`${keyPrefix}user_active_keys:${userId}`)).toBe(EXPECTED_LIMIT);
    await expect(stores[3]!.generateApiKey(userId, 'past-cap')).rejects.toBeInstanceOf(ApiKeyLimitError);
  });

  it('allows full 20 active keys across concurrent burst on legacy account with 25 revoked keys', async () => {
    await seedLegacyUnindexedKeys(0, 25);
    const stores = clients.map((client) => storeOf(client));

    const settled = await Promise.allSettled(
      Array.from({ length: 25 }, (_, i) => stores[i % stores.length]!.generateApiKey(userId, `fresh-${i}`))
    );
    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    expect(fulfilled).toHaveLength(EXPECTED_LIMIT);
    expect(rejected).toHaveLength(5);
    for (const err of rejected) {
      expect(err.reason).toBeInstanceOf(ApiKeyLimitError);
    }
    expect(await admin.get(`${keyPrefix}user_active_keys_init:${userId}`)).toBe('1');
    expect(await admin.scard(`${keyPrefix}user_active_keys:${userId}`)).toBe(EXPECTED_LIMIT);
    expect(await admin.scard(`${keyPrefix}user_keys:${userId}`)).toBe(45);
  });

  it('recovers from SYNC RETRY in real Redis Lua when deleteApiKey mutates user_keys mid-sync', async () => {
    await seedLegacyUnindexedKeys(19, 5);
    const store0 = storeOf(clients[0]!);
    const store1 = storeOf(clients[1]!);

    const origSmembers = clients[0]!.smembers.bind(clients[0]!);
    let smembersCalls = 0;
    vi.spyOn(clients[0]!, 'smembers').mockImplementation(async (key) => {
      smembersCalls += 1;
      const members = await origSmembers(key);
      if (smembersCalls === 1 && String(key) === `${keyPrefix}user_keys:${userId}`) {
        // Delete legacy-0 after smembers snapshots 24 keys so SYNC_ACTIVE_API_KEYS_LUA_SCRIPT sees SCARD 23 != 24 and returns RETRY.
        expect(await store1.deleteApiKey(userId, 'legacy-0')).toBe(true);
      }
      return members;
    });

    const created = await store0.generateApiKey(userId, 'after-delete-sync-retry');
    expect(smembersCalls).toBe(2);
    expect(created.key.status).toBe('active');
    expect(await admin.get(`${keyPrefix}user_active_keys_init:${userId}`)).toBe('1');
    expect(await admin.scard(`${keyPrefix}user_active_keys:${userId}`)).toBe(EXPECTED_LIMIT - 1);
    expect(await admin.sismember(`${keyPrefix}user_active_keys:${userId}`, 'legacy-0')).toBe(0);

    await store0.generateApiKey(userId, 'fill-twentieth');
    await expect(store0.generateApiKey(userId, 'over-cap')).rejects.toBeInstanceOf(ApiKeyLimitError);
  });

  it('fails closed with 503 AuthStoreUnavailableError against real Redis when SYNC exhausts all 16 RETRY attempts', async () => {
    await seedLegacyUnindexedKeys(2, 0);
    const store0 = storeOf(clients[0]!);
    let smembersCalls = 0;
    vi.spyOn(clients[0]!, 'smembers').mockImplementation(async (key) => {
      if (String(key) === `${keyPrefix}user_keys:${userId}`) {
        smembersCalls += 1;
        // Return stale 1-key snapshot while real user_keys holds 2 keys so SYNC Lua returns RETRY every attempt.
        return ['legacy-0'];
      }
      return [];
    });

    const err = await store0.generateApiKey(userId, 'never-created').catch((cause: unknown) => cause);
    expect(err).toBeInstanceOf(AuthStoreUnavailableError);
    expect((err as AuthStoreUnavailableError).status).toBe(503);
    expect(smembersCalls).toBe(16);
    expect(await admin.exists(`${keyPrefix}user_active_keys_init:${userId}`)).toBe(0);
    expect(await admin.scard(`${keyPrefix}user_keys:${userId}`)).toBe(2);
  });
});
