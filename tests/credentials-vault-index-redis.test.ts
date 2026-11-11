import crypto from 'node:crypto';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialsVault } from '../src/lib/storage/credentials-vault';

/**
 * The credentials of a user are listed from a set of their ids, so a request reads the user's credentials and not the vault of every
 * user (no KEYS, no SCAN). Credentials stored before the index, or by a process that does not keep it, are indexed by one pass
 * over the vault, which repeats daily. Like the other Redis suites it runs when REDIS_URL is set; each case uses users of its own.
 */
const REDIS_URL = process.env.REDIS_URL;
const MARKER = 'vault:index:complete';
const CREDENTIALS = { type: 's3' as const, bucket: 'b', accessKeyId: 'AKIAEXAMPLE0000000000', secretAccessKey: 'secret-access-key-0123456789abcdef' };

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!REDIS_URL)('the per-user index of the credentials vault in Redis', () => {
  let admin: Redis;
  let client: Redis;
  let vault: CredentialsVault;
  let alice: string;
  let bob: string;
  const stored: string[] = [];

  const indexKey = (user: string) => `vault:user:{${user}}`;
  const store = async (user: string, name: string, options?: { ttlSeconds?: number }) => {
    const ref = await vault.store(user, CREDENTIALS, { name, ...options });
    stored.push(ref);
    return ref;
  };
  const ids = async (user: string) => (await vault.list(user)).map((summary) => summary.id);

  beforeEach(() => {
    vi.stubEnv('STORAGE_VAULT_KEY', 'index-vault-key-0123456789abcdef0123');
    const suffix = crypto.randomBytes(6).toString('hex');
    alice = `vault-alice-${suffix}`;
    bob = `vault-bob-${suffix}`;
    admin = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    client = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    vault = new CredentialsVault(client);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (stored.length > 0) await admin.del(...stored.map((ref) => `vault:cred:${ref}`));
    stored.length = 0;
    await admin.del(indexKey(alice), indexKey(bob));
    await admin.quit();
    await client.quit();
  });

  it('lists the credentials of one user, never those of another, reading no key of the vault but those of the user', async () => {
    const mine = [await store(alice, 'a1'), await store(alice, 'a2'), await store(alice, 'a3')];
    const others = [await store(bob, 'b1'), await store(bob, 'b2')];
    await ids(alice);
    const names: string[] = [];
    const prototype = Redis.prototype as unknown as { sendCommand: (this: unknown, command: { name: string }, ...rest: unknown[]) => unknown };
    const real = prototype.sendCommand;
    vi.spyOn(prototype, 'sendCommand').mockImplementation(function (this: unknown, command, ...rest) {
      names.push(command.name);
      return real.call(this, command, ...rest);
    });

    expect((await ids(alice)).sort()).toEqual([...mine].sort());
    vi.restoreAllMocks();

    expect(names).toEqual(['smembers', 'mget']);
    expect((await ids(bob)).sort()).toEqual([...others].sort());
    expect(await ids(`vault-nobody-${alice}`)).toEqual([]);
  });

  it('indexes credentials stored before the index existed, those of every user, once the daily marker is gone', async () => {
    const legacy = async (user: string) => {
      const ref = await store(user, 'seed');
      await admin.del(indexKey(user));
      return ref;
    };
    const aliceLegacy = await legacy(alice);
    const bobLegacy = await legacy(bob);
    await admin.del(MARKER);

    expect(await ids(alice)).toEqual([aliceLegacy]);
    expect(await ids(bob)).toEqual([bobLegacy]);
    expect(await admin.pttl(MARKER)).toBeGreaterThan(0);
  });

  it('does not list an id the index names for another user, and drops it from the index', async () => {
    const bobs = await store(bob, 'b1');
    await admin.sadd(indexKey(alice), bobs);

    expect(await ids(alice)).toEqual([]);
    expect(await admin.sismember(indexKey(alice), bobs)).toBe(0);
    expect(await vault.get(bobs, alice)).toBeNull();
    expect(await ids(bob)).toEqual([bobs]);
  });

  it('drops an id whose credential is gone or expired, and removes the id when the credential is deleted', async () => {
    const kept = await store(alice, 'kept');
    const gone = await store(alice, 'gone');
    const removed = await store(alice, 'removed');
    await admin.del(`vault:cred:${gone}`);
    expect(await vault.delete(removed, alice)).toBe(true);

    expect(await admin.sismember(indexKey(alice), removed)).toBe(0);
    expect(await ids(alice)).toEqual([kept]);
    expect(await admin.sismember(indexKey(alice), gone)).toBe(0);
  });

  it('keeps an index key that `erase-account` finds by the user tag', async () => {
    await store(alice, 'a1');

    expect(await admin.keys(`*{${alice}}*`)).toEqual([indexKey(alice)]);
  });

  it('lists through a client that has not finished connecting, as the first request after a start does', async () => {
    const { readyGatedRedis } = await import('../src/lib/redis/when-ready');
    const fresh = readyGatedRedis(new Redis(REDIS_URL as string, { enableOfflineQueue: false, maxRetriesPerRequest: 1 }));
    const early = new CredentialsVault(fresh);

    const ref = await early.store(alice, CREDENTIALS, { name: 'early' });
    stored.push(ref);

    expect(await admin.sismember(indexKey(alice), ref)).toBe(1);
    expect((await early.list(alice)).map((summary) => summary.id)).toEqual([ref]);
    await fresh.quit();
  });
});
