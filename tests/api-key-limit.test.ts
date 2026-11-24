import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type Redis from 'ioredis';
import { userStore } from '../src/lib/auth/user-store';
import { keyStore } from '../src/lib/api-keys/key-store';
import { RedisKeyStore, redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { ApiKeyLimitError } from '../src/lib/api-keys/types';
import { AuthStoreUnavailableError } from '../src/lib/auth/store-unavailable';
import { createSessionToken } from '../src/lib/auth/session';
import { POST as createKey } from '../src/app/api/keys/route';
import { DELETE as revokeKey } from '../src/app/api/keys/[id]/route';
import { TERMS_VERSION } from '../src/lib/legal/documents';
import { clusterKeySlot } from './helpers/redis-cluster-slot';

// Hand-written from the brief: an account holds at most 20 active keys.
const EXPECTED_LIMIT = 20;
const ORIGIN = 'http://localhost:3000';

async function accountCookie(email: string): Promise<{ cookie: string; id: string }> {
  const user = userStore.sanitizeUser((await userStore.findByEmail(email)) ?? (await userStore.createUser({ email, name: email })));
  return { cookie: `easyconvert_session=${createSessionToken(user)}`, id: user.id };
}

function request(path: string, cookie: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    method,
    headers: { Origin: ORIGIN, Cookie: cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const create = (cookie: string) => createKey(request('/api/keys', cookie, 'POST', { acceptedTermsVersion: TERMS_VERSION, name: 'k' }));
const activeKeys = async (id: string) => (await redisKeyStore.listApiKeys(id)).filter((key) => key.status === 'active');

beforeEach(() => {
  userStore.resetStore();
  keyStore.resetStore();
});
afterEach(() => vi.restoreAllMocks());

describe('the number of active API keys of an account', () => {
  it('stops at the limit with a coded 409, and the next key is not made', async () => {
    const { cookie, id } = await accountCookie('limit@example.com');
    for (let i = 0; i < EXPECTED_LIMIT; i++) expect((await create(cookie)).status).toBe(200);

    const refused = await create(cookie);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ success: false, code: 'key_limit_reached' });
    expect(await activeKeys(id)).toHaveLength(EXPECTED_LIMIT);
  });

  it('does not count a revoked key, so revoking one makes room for one', async () => {
    const { cookie, id } = await accountCookie('revoke@example.com');
    for (let i = 0; i < EXPECTED_LIMIT; i++) await create(cookie);
    const [first] = await activeKeys(id);
    expect((await revokeKey(request(`/api/keys/${first.id}`, cookie, 'DELETE'), { params: Promise.resolve({ id: first.id }) })).status).toBe(200);

    expect((await create(cookie)).status).toBe(200);
    expect((await create(cookie)).status).toBe(409);
  });

  it('counts the keys of one account only', async () => {
    const full = await accountCookie('full@example.com');
    for (let i = 0; i < EXPECTED_LIMIT; i++) await create(full.cookie);
    const other = await accountCookie('other@example.com');
    expect((await create(other.cookie)).status).toBe(200);
  });

  it('never lets requests sent at once pass the limit or leave fewer than the limit', async () => {
    const { cookie, id } = await accountCookie('burst@example.com');
    const responses = await Promise.all(Array.from({ length: EXPECTED_LIMIT * 2 }, () => create(cookie)));
    const created = responses.filter((res) => res.status === 200);
    const refused = responses.filter((res) => res.status === 409);
    expect(created).toHaveLength(EXPECTED_LIMIT);
    expect(refused).toHaveLength(EXPECTED_LIMIT);
    for (const res of refused) {
      expect(await res.json()).toMatchObject({ success: false, code: 'key_limit_reached' });
    }
    expect(await activeKeys(id)).toHaveLength(EXPECTED_LIMIT);
  });

  it('rejects non-positive or non-integer maxActiveKeys bounds fail-closed', async () => {
    const { id } = await accountCookie('bad-cap@example.com');
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const err = await redisKeyStore.generateApiKey(id, 'bad', { maxActiveKeys: bad }).catch((cause: unknown) => cause);
      expect(err).toBeInstanceOf(RangeError);
      expect((err as RangeError).message).toBe('maxActiveKeys must be a positive safe integer.');
    }
    expect(await activeKeys(id)).toHaveLength(0);
  });

  it('answers POST /api/keys with 503 Retry-After when Redis fails, not 409 key_limit_reached', async () => {
    const { cookie } = await accountCookie('outage@example.com');
    const brokenClient = new Proxy(
      {},
      {
        get: (_target, prop) => (prop === 'then' ? undefined : () => Promise.reject(new Error(`redis down: ${String(prop)}`))),
      }
    ) as unknown as Redis;
    redisKeyStore.setRedisClient(brokenClient);
    try {
      const res = await create(cookie);
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).not.toBeNull();
    } finally {
      redisKeyStore.setRedisClient(null);
    }
  });

  it('answers POST /api/keys with 503 Retry-After specifically when CREATE_API_KEY_LUA_SCRIPT eval fails', async () => {
    const { cookie, id } = await accountCookie('eval-outage@example.com');
    let createKeyEvalCalls = 0;
    const evalFailClient = {
      get: async () => null,
      hgetall: async () => ({}),
      smembers: async () => [],
      eval: async (script: string) => {
        if (!script.includes('user_active_keys')) return [0, 0];
        createKeyEvalCalls++;
        throw new Error('READONLY You can not write against a read only replica');
      },
    } as unknown as Redis;
    redisKeyStore.setRedisClient(evalFailClient);
    try {
      const res = await create(cookie);
      expect(createKeyEvalCalls).toBe(1);
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).not.toBeNull();
      expect((await res.json()).code).not.toBe('key_limit_reached');
    } finally {
      redisKeyStore.setRedisClient(null);
    }
    expect(await activeKeys(id)).toHaveLength(0);
  });

  it('enforces the cap in Redis fallback mode without calling Lua when cluster prefix lacks a hash tag', async () => {
    const hashes = new Map<string, Record<string, string>>();
    const sets = new Map<string, Set<string>>();
    const evalCalls: Array<{ script: string; numKeys: number }> = [];
    const multiKeyDelCalls: string[][] = [];
    const clusterNoTag = {
      isCluster: true,
      pipeline: () => {
        throw new Error('All keys in the pipeline should belong to the same slots allocation group');
      },
      eval: async (script: string, numKeys: number, ...args: unknown[]) => {
        evalCalls.push({ script, numKeys });
        if (numKeys > 1) {
          throw new Error('CROSSSLOT Keys in request do not hash to the same slot');
        }
        if (script.includes("return 'REVOKED'")) {
          const keyHashKey = String(args[0]);
          const ownerId = String(args[1]);
          const entry = hashes.get(keyHashKey);
          if (!entry) return 'MISSING';
          if (entry.userId && entry.userId !== ownerId) return 'FORBIDDEN';
          entry.status = 'revoked';
          return 'REVOKED';
        }
        return 'CREATED';
      },
      hset: async (key: string, fieldOrObj: Record<string, string> | string, val?: string) => {
        const entry = hashes.get(key) ?? {};
        if (typeof fieldOrObj === 'string') {
          entry[fieldOrObj] = String(val ?? '');
        } else {
          Object.assign(entry, fieldOrObj);
        }
        hashes.set(key, entry);
        return 1;
      },
      hgetall: async (key: string) => ({ ...(hashes.get(key) ?? {}) }),
      hdel: async (key: string, field: string) => {
        const entry = hashes.get(key);
        if (!entry || !(field in entry)) return 0;
        delete entry[field];
        return 1;
      },
      sadd: async (key: string, member: string) => {
        const set = sets.get(key) ?? new Set<string>();
        const added = set.has(member) ? 0 : 1;
        set.add(member);
        sets.set(key, set);
        return added;
      },
      srem: async (key: string, member: string) => {
        const set = sets.get(key);
        return set && set.delete(member) ? 1 : 0;
      },
      smembers: async (key: string) => [...(sets.get(key) ?? [])],
      del: async (...keys: string[]) => {
        if (keys.length > 1) {
          multiKeyDelCalls.push(keys);
          throw new Error('CROSSSLOT Keys in request do not hash to the same slot');
        }
        return hashes.delete(keys[0]!) ? 1 : 0;
      },
    } as unknown as Redis;

    const store = new RedisKeyStore({ keyPrefix: 'nohashtag:', isolated: true, redisClient: clusterNoTag });
    for (let i = 0; i < EXPECTED_LIMIT; i++) {
      await store.generateApiKey('u_notag', `k${i}`);
    }
    await expect(store.generateApiKey('u_notag', 'k20')).rejects.toBeInstanceOf(ApiKeyLimitError);
    expect(evalCalls).toHaveLength(0);
    expect(sets.get('nohashtag:user_active_keys:u_notag')?.size).toBe(EXPECTED_LIMIT);

    // listApiKeys must avoid pipeline() on Cluster and succeed across slots
    const listedBeforeRevoke = await store.listApiKeys('u_notag', { decryptSecrets: false });
    expect(listedBeforeRevoke).toHaveLength(EXPECTED_LIMIT);
    expect(listedBeforeRevoke.every((entry) => entry.status === 'active')).toBe(true);

    // revokeApiKey uses single-key Lua + srem on active index without multi-key eval
    const firstKeyId = listedBeforeRevoke[0]!.id;
    expect(await store.revokeApiKey('u_notag', firstKeyId)).toBe(true);
    expect(sets.get('nohashtag:user_active_keys:u_notag')?.size).toBe(EXPECTED_LIMIT - 1);
    const listedAfterRevoke = await store.listApiKeys('u_notag', { decryptSecrets: false });
    expect(listedAfterRevoke.find((entry) => entry.id === firstKeyId)?.status).toBe('revoked');

    const replacementAfterRevoke = await store.generateApiKey('u_notag', 'k_after_revoke');
    expect(replacementAfterRevoke.key.status).toBe('active');
    expect(sets.get('nohashtag:user_active_keys:u_notag')?.size).toBe(EXPECTED_LIMIT);

    // deleteApiKey falls back to single-key deletes and srem without calling multi-key Lua
    const secondKeyId = listedBeforeRevoke[1]!.id;
    expect(await store.deleteApiKey('u_notag', secondKeyId)).toBe(true);
    expect(multiKeyDelCalls).toHaveLength(0);
    expect(evalCalls.filter((call) => call.numKeys > 1)).toHaveLength(0);
    expect(sets.get('nohashtag:user_active_keys:u_notag')?.size).toBe(EXPECTED_LIMIT - 1);

    const replacementAfterDelete = await store.generateApiKey('u_notag', 'k_after_delete');
    expect(replacementAfterDelete.key.status).toBe('active');
    const finalList = await store.listApiKeys('u_notag', { decryptSecrets: false });
    expect(finalList.filter((entry) => entry.status === 'active')).toHaveLength(EXPECTED_LIMIT);
    expect(finalList.some((entry) => entry.id === secondKeyId)).toBe(false);
  });

  it('retries SYNC_ACTIVE_API_KEYS_LUA_SCRIPT when concurrent deleteApiKey causes RETRY before succeeding', async () => {
    let currentUserKeys = ['k_old_1', 'k_old_2'];
    let syncAttempts = 0;
    let createAttempts = 0;
    const syncRetryClient = {
      get: async () => null,
      hgetall: async () => ({}),
      smembers: async () => [...currentUserKeys],
      eval: async (script: string, numKeys: number, ...args: unknown[]) => {
        if (script.includes('NEEDS_SYNC')) {
          createAttempts += 1;
          return createAttempts === 1 ? 'NEEDS_SYNC' : 'CREATED';
        }
        if (script.includes("'SYNCED'")) {
          syncAttempts += 1;
          const passedIds = args.slice(numKeys).map(String);
          if (syncAttempts === 1) {
            expect(passedIds).toEqual(['k_old_1', 'k_old_2']);
            // Simulate concurrent deleteApiKey removing k_old_1 between smembers and eval
            currentUserKeys = ['k_old_2'];
            return 'RETRY';
          }
          expect(passedIds).toEqual(['k_old_2']);
          return 'SYNCED';
        }
        return 'OK';
      },
    } as unknown as Redis;

    const store = new RedisKeyStore({ keyPrefix: 'easyconvert:{keys}:', isolated: true, redisClient: syncRetryClient });
    const created = await store.generateApiKey('u_sync_retry', 'after-retry', { maxActiveKeys: EXPECTED_LIMIT });
    expect(syncAttempts).toBe(2);
    expect(createAttempts).toBe(2);
    expect(created.key.name).toBe('after-retry');
    expect(created.key.status).toBe('active');
  });

  it('fails closed with 503 Retry-After when SYNC_ACTIVE_API_KEYS_LUA_SCRIPT exhausts all 16 RETRY attempts', async () => {
    const { cookie, id } = await accountCookie('sync-exhaust@example.com');
    let syncEvalCalls = 0;
    const alwaysRetrySyncClient = {
      get: async () => null,
      hgetall: async () => ({}),
      smembers: async () => ['k_old'],
      eval: async (script: string) => {
        if (!script.includes('user_active_keys')) return [0, 0];
        if (script.includes('NEEDS_SYNC')) return 'NEEDS_SYNC';
        if (script.includes("'SYNCED'")) {
          syncEvalCalls += 1;
          return 'RETRY';
        }
        return 'OK';
      },
    } as unknown as Redis;

    redisKeyStore.setRedisClient(alwaysRetrySyncClient);
    try {
      const err = await redisKeyStore
        .generateApiKey(id, 'sync-exhausted', { maxActiveKeys: EXPECTED_LIMIT })
        .catch((cause: unknown) => cause);
      expect(err).toBeInstanceOf(AuthStoreUnavailableError);
      expect((err as AuthStoreUnavailableError).status).toBe(503);
      expect(syncEvalCalls).toBe(16);

      syncEvalCalls = 0;
      const res = await create(cookie);
      expect(syncEvalCalls).toBe(16);
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('5');
      expect(await res.json()).toMatchObject({ success: false });
    } finally {
      redisKeyStore.setRedisClient(null);
    }
  });

  it('places every key passed to CREATE, SYNC, REVOKE, and DELETE scripts in one Redis Cluster hash slot', async () => {
    const keySets: string[][] = [];
    let needsSync = true;
    const clusterClient = {
      isCluster: true,
      smembers: async () => ['k_old'],
      eval: async (_script: string, numKeys: number, ...args: unknown[]) => {
        const keys = args.slice(0, numKeys).map(String);
        keySets.push(keys);
        if (numKeys === 5 && args[6] === 'u_slot' && needsSync) {
          needsSync = false;
          return 'NEEDS_SYNC';
        }
        if (numKeys === 4) return 'SYNCED';
        if (numKeys === 2) return 'REVOKED';
        if (numKeys === 5 && args[5] === 'u_slot') return 'DELETED';
        return 'CREATED';
      },
    } as unknown as Redis;

    const store = new RedisKeyStore({ keyPrefix: 'easyconvert:{keys}:', isolated: true, redisClient: clusterClient });
    const created = await store.generateApiKey('u_slot', 'slot-key', { maxActiveKeys: EXPECTED_LIMIT });
    await store.revokeApiKey('u_slot', created.key.id);
    await store.deleteApiKey('u_slot', created.key.id);

    expect(keySets).toHaveLength(5);
    expect(keySets.map((keys) => keys.length)).toEqual([5, 4, 5, 2, 5]);
    for (const keys of keySets) {
      expect(new Set(keys.map(clusterKeySlot)).size).toBe(1);
    }
  });

  it('cleans up partial fallback Redis writes when an index update fails mid-creation', async () => {
    const deletedKeys: string[] = [];
    const hdelCalls: Array<[string, string]> = [];
    const sremCalls: Array<[string, string]> = [];
    const partialFailClient = {
      smembers: async () => [],
      hgetall: async () => ({}),
      hset: async (key: string) => {
        if (key.endsWith('apikey_hashes')) {
          throw new Error('simulated hash index write failure');
        }
        return 1;
      },
      sadd: async () => 1,
      hdel: async (key: string, field: string) => {
        hdelCalls.push([key, field]);
        return 1;
      },
      srem: async (key: string, member: string) => {
        sremCalls.push([key, member]);
        return 1;
      },
      del: async (key: string) => {
        deletedKeys.push(key);
        return 1;
      },
    } as unknown as Redis;

    const store = new RedisKeyStore({ keyPrefix: 'easyconvert:fallback:', isolated: true, redisClient: partialFailClient });
    await expect(store.generateApiKey('u_partial', 'broken-key', { maxActiveKeys: EXPECTED_LIMIT })).rejects.toBeInstanceOf(
      AuthStoreUnavailableError
    );

    expect(deletedKeys).toHaveLength(1);
    expect(deletedKeys[0]).toMatch(/^easyconvert:fallback:apikeys:/);
    expect(hdelCalls).toHaveLength(1);
    expect(hdelCalls[0][0]).toBe('easyconvert:fallback:apikey_hashes');
    expect(sremCalls.map(([k]) => k)).toEqual([
      'easyconvert:fallback:user_keys:u_partial',
      'easyconvert:fallback:user_active_keys:u_partial',
    ]);
  });
});
