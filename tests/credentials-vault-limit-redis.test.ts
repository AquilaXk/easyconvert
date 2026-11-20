import crypto from 'node:crypto';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialsVault, CredentialsVaultLimitError } from '../src/lib/storage/credentials-vault';
import { MAX_STORAGE_CREDENTIALS_PER_ACCOUNT } from '../src/lib/api/field-limits';

/**
 * An account holds at most 20 saved credentials (entry 372). The check and the write are one Lua script, so saves sent at once
 * (here from several connections, as several web instances send them) never pass the limit. Like the other Redis suites it runs
 * when REDIS_URL is set; each case uses users of its own.
 */
const REDIS_URL = process.env.REDIS_URL;
// Hand-written from the brief: the number of active API keys an account holds.
const EXPECTED_LIMIT = 20;
const CREDENTIALS = { type: 's3' as const, bucket: 'b', accessKeyId: 'AKIAEXAMPLE0000000000', secretAccessKey: 'secret-access-key-0123456789abcdef' };

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!REDIS_URL)('the limit of saved credentials in Redis', () => {
  let admin: Redis;
  let clients: Redis[];
  let user: string;
  const indexKey = () => `vault:user:{${user}}`;
  const vaultOf = (client: Redis) => new CredentialsVault(client);

  beforeEach(() => {
    vi.stubEnv('STORAGE_VAULT_KEY', 'limit-redis-vault-key-0123456789abcdef');
    user = `vault-limit-${crypto.randomBytes(6).toString('hex')}`;
    admin = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    clients = Array.from({ length: 4 }, () => new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 }));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    const ids = await admin.smembers(indexKey());
    if (ids.length > 0) await admin.del(...ids.map((id) => `vault:cred:${id}`));
    await admin.del(indexKey());
    await Promise.all([admin, ...clients].map((client) => client.quit()));
  });

  it('refuses the 21st save and writes nothing for it', async () => {
    const vault = vaultOf(clients[0]);
    for (let i = 0; i < EXPECTED_LIMIT; i++) await vault.store(user, CREDENTIALS, { name: `c${i}` });
    const keysBefore = await admin.keys('vault:cred:*');

    await expect(vault.store(user, CREDENTIALS, { name: 'one too many' })).rejects.toBeInstanceOf(CredentialsVaultLimitError);

    expect(await admin.scard(indexKey())).toBe(EXPECTED_LIMIT);
    expect((await admin.keys('vault:cred:*')).sort()).toEqual(keysBefore.sort());
    expect(await vault.list(user)).toHaveLength(EXPECTED_LIMIT);
  });

  it('lets 60 saves sent at once from 4 connections reach the limit and never pass it', async () => {
    const vaults = clients.map(vaultOf);

    const outcomes = await Promise.allSettled(Array.from({ length: 60 }, (_, i) => vaults[i % vaults.length].store(user, CREDENTIALS, { name: `r${i}` })));

    const saved = outcomes.filter((outcome): outcome is PromiseFulfilledResult<string> => outcome.status === 'fulfilled');
    expect(saved).toHaveLength(EXPECTED_LIMIT);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected' && outcome.reason instanceof CredentialsVaultLimitError)).toHaveLength(60 - EXPECTED_LIMIT);
    expect(await admin.scard(indexKey())).toBe(EXPECTED_LIMIT);
    expect((await vaults[0].list(user)).map((summary) => summary.id).sort()).toEqual(saved.map((outcome) => outcome.value).sort());
  });

  it('gives the lifetime to the credential key in the same step as the index entry', async () => {
    const ref = await vaultOf(clients[0]).store(user, CREDENTIALS, { ttlSeconds: 3600 });

    const ttl = await admin.ttl(`vault:cred:${ref}`);
    expect(ttl).toBeGreaterThan(3500);
    expect(ttl).toBeLessThanOrEqual(3600);
    expect(await admin.sismember(indexKey(), ref)).toBe(1);
  });

  it('does not count a credential whose key has expired, and drops its id from the index', async () => {
    const vault = vaultOf(clients[0]);
    const refs: string[] = [];
    for (let i = 0; i < EXPECTED_LIMIT; i++) refs.push(await vault.store(user, CREDENTIALS, { ttlSeconds: 60 }));
    await admin.del(...refs.slice(0, 3).map((ref) => `vault:cred:${ref}`));

    const fresh = await Promise.all([vault.store(user, CREDENTIALS), vault.store(user, CREDENTIALS), vault.store(user, CREDENTIALS)]);

    await expect(vault.store(user, CREDENTIALS)).rejects.toBeInstanceOf(CredentialsVaultLimitError);
    expect((await admin.smembers(indexKey())).sort()).toEqual([...refs.slice(3), ...fresh].sort());
  });

  it('counts the credentials of one account only', async () => {
    const vault = vaultOf(clients[0]);
    const other = `${user}-other`;
    for (let i = 0; i < EXPECTED_LIMIT; i++) await vault.store(user, CREDENTIALS);

    const ref = await vault.store(other, CREDENTIALS);

    expect(ref).toMatch(/^cred_/);
    await admin.del(`vault:cred:${ref}`, `vault:user:{${other}}`);
  });

  it('refuses nothing and saves nothing when Redis does not answer, as a persistence error', async () => {
    const down = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 0, lazyConnect: true });
    clients.push(down);
    vi.spyOn(down, 'eval').mockRejectedValue(new Error('connection lost'));

    await expect(vaultOf(down).store(user, CREDENTIALS)).rejects.toMatchObject({ code: 'CREDENTIALS_VAULT_UNAVAILABLE' });
    expect(await admin.scard(indexKey())).toBe(0);
  });
});
