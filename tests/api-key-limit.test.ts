import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type Redis from 'ioredis';
import { userStore } from '../src/lib/auth/user-store';
import { keyStore } from '../src/lib/api-keys/key-store';
import { RedisKeyStore, redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { ApiKeyLimitError } from '../src/lib/api-keys/types';
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
    const evalCalls: string[] = [];
    const clusterNoTag = {
      isCluster: true,
      eval: async (script: string) => {
        evalCalls.push(script);
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
      sadd: async (key: string, member: string) => {
        const set = sets.get(key) ?? new Set<string>();
        set.add(member);
        sets.set(key, set);
        return 1;
      },
      smembers: async (key: string) => [...(sets.get(key) ?? [])],
    } as unknown as Redis;

    const store = new RedisKeyStore({ keyPrefix: 'nohashtag:', isolated: true, redisClient: clusterNoTag });
    for (let i = 0; i < EXPECTED_LIMIT; i++) {
      await store.generateApiKey('u_notag', `k${i}`);
    }
    await expect(store.generateApiKey('u_notag', 'k20')).rejects.toBeInstanceOf(ApiKeyLimitError);
    expect(evalCalls).toHaveLength(0);
    expect(sets.get('nohashtag:user_active_keys:u_notag')?.size).toBe(EXPECTED_LIMIT);
  });

  it('places every key passed to CREATE, SYNC, REVOKE, and DELETE scripts in one Redis Cluster hash slot', async () => {
    const keySets: string[][] = [];
    const clusterClient = {
      isCluster: true,
      smembers: async () => ['k_old'],
      eval: async (_script: string, numKeys: number, ...args: unknown[]) => {
        const keys = args.slice(0, numKeys).map(String);
        keySets.push(keys);
        if (keys.length === 5 && args[5] === 'sync-check') return 'NEEDS_SYNC';
        if (keys.length === 4) return 'SYNCED';
        if (keys.length === 2) return 'REVOKED';
        if (keys.length === 5 && numKeys === 5 && args[5] === 'u_slot') return 'DELETED';
        return 'CREATED';
      },
    } as unknown as Redis;

    const store = new RedisKeyStore({ keyPrefix: 'easyconvert:{keys}:', isolated: true, redisClient: clusterClient });
    const created = await store.generateApiKey('u_slot', 'slot-key');
    await store.revokeApiKey('u_slot', created.key.id);
    await store.deleteApiKey('u_slot', created.key.id);

    expect(keySets.length).toBeGreaterThanOrEqual(3);
    for (const keys of keySets) {
      expect(new Set(keys.map(clusterKeySlot)).size).toBe(1);
    }
  });
});
