import crypto from 'node:crypto';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialsVault } from '../src/lib/storage/credentials-vault';

/**
 * The credentials vault in Redis: a listing is never short while the index is being built, one damaged record does not fail the
 * listing, the rotation of one user's credentials reads that user's index, and a credential that expired leaves the index.
 */
const REDIS_URL = process.env.REDIS_URL;
const MARKER = 'vault:index:complete';
const CREDENTIALS = { type: 's3' as const, bucket: 'b', accessKeyId: 'AKIAEXAMPLE0000000000', secretAccessKey: 'secret-access-key-0123456789abcdef' };

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!REDIS_URL)('the credentials vault listing in Redis', () => {
  let admin: Redis;
  let clients: Redis[];
  let alice: string;
  const keys: string[] = [];

  const indexKey = (user: string) => `vault:user:{${user}}`;
  const vaultOf = () => {
    const client = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    clients.push(client);
    return { client, vault: new CredentialsVault(client) };
  };

  beforeEach(() => {
    vi.stubEnv('STORAGE_VAULT_KEY', 'listing-vault-key-0123456789abcdef0123');
    alice = `vault-alice-${crypto.randomBytes(6).toString('hex')}`;
    admin = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    clients = [];
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (keys.length > 0) await admin.del(...keys);
    keys.length = 0;
    await admin.del(indexKey(alice), 'vault:index:lock');
    await admin.quit();
    await Promise.all(clients.map((client) => client.quit()));
  });

  async function store(vault: CredentialsVault, name: string, options?: { ttlSeconds?: number }): Promise<string> {
    const ref = await vault.store(alice, CREDENTIALS, { name, ...options });
    keys.push(`vault:cred:${ref}`);
    return ref;
  }

  it('lists the credentials of the user while another process is still indexing the vault, and not an empty index', async () => {
    const seed = vaultOf();
    const legacy = await store(seed.vault, 'legacy');
    await admin.del(indexKey(alice), MARKER);

    const indexing = vaultOf();
    let reachedScan: () => void = () => undefined;
    const scanning = new Promise<void>((resolve) => (reachedScan = resolve));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const realScan = indexing.client.scan.bind(indexing.client) as (...args: unknown[]) => Promise<[string, string[]]>;
    vi.spyOn(indexing.client, 'scan').mockImplementation((async (...args: unknown[]) => {
      reachedScan();
      await gate;
      return realScan(...args);
    }) as never);

    const first = indexing.vault.list(alice);
    await scanning;

    // A request on another process meets the pass half-way: it still lists the credential.
    const other = vaultOf();
    expect((await other.vault.list(alice)).map((summary) => summary.id)).toEqual([legacy]);

    release();
    expect((await first).map((summary) => summary.id)).toEqual([legacy]);
    expect(await admin.pttl(MARKER)).toBeGreaterThan(0);
    expect(await admin.exists('vault:index:lock')).toBe(0);
  });

  it('does not mark the index complete when the pass fails, and a later request indexes again', async () => {
    const seed = vaultOf();
    const legacy = await store(seed.vault, 'legacy');
    await admin.del(indexKey(alice), MARKER);

    const broken = vaultOf();
    vi.spyOn(broken.client, 'scan').mockRejectedValueOnce(new Error('connection lost'));
    await expect(broken.vault.list(alice)).rejects.toThrow('Credential storage is unavailable');
    expect(await admin.exists(MARKER)).toBe(0);
    expect(await admin.exists('vault:index:lock')).toBe(0);

    const again = vaultOf();
    expect((await again.vault.list(alice)).map((summary) => summary.id)).toEqual([legacy]);
    expect(await admin.pttl(MARKER)).toBeGreaterThan(0);
  });

  it('lists the other credentials when one stored record is damaged, and the erasure deletes the damaged one by the index', async () => {
    const { vault } = vaultOf();
    const good = [await store(vault, 'one'), await store(vault, 'two')];
    const damaged = `cred_${crypto.randomBytes(16).toString('hex')}`;
    keys.push(`vault:cred:${damaged}`);
    await admin.set(`vault:cred:${damaged}`, '{"id": truncated');
    await admin.sadd(indexKey(alice), damaged);
    // A damaged record stored before the index existed is met by the indexing pass.
    await admin.del(MARKER);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const fresh = vaultOf();
    expect((await fresh.vault.list(alice)).map((summary) => summary.id).sort()).toEqual([...good].sort());
    expect(error.mock.calls.flat().join(' ')).toContain(damaged);
    expect(error.mock.calls.flat().join(' ')).not.toContain('truncated');

    expect(await fresh.vault.listByUser(alice)).toEqual([...good, damaged].sort());
    expect(await fresh.vault.delete(damaged, alice)).toBe(true);
    expect(await admin.exists(`vault:cred:${damaged}`)).toBe(0);
    expect(await admin.sismember(indexKey(alice), damaged)).toBe(0);
  });

  it('does not delete a damaged record for a user whose index does not name it', async () => {
    const { vault } = vaultOf();
    const damaged = `cred_${crypto.randomBytes(16).toString('hex')}`;
    keys.push(`vault:cred:${damaged}`);
    await admin.set(`vault:cred:${damaged}`, 'not json');

    expect(await vault.delete(damaged, alice)).toBe(false);
    expect(await admin.exists(`vault:cred:${damaged}`)).toBe(1);
  });

  it('rotates the credentials of one user from their index, with no scan of the vault', async () => {
    // Sealed under a legacy secret (no vault key set), then read with the vault key set: the rotation reseals it under the vault key.
    vi.stubEnv('STORAGE_VAULT_KEY', '');
    vi.stubEnv('KEY_ENCRYPTION_KEY', '');
    vi.stubEnv('JWT_SECRET', 'legacy-jwt-secret-0123456789abcdef0123456789');
    const { client, vault } = vaultOf();
    const ref = await store(vault, 'legacy');
    await vault.list(alice);
    vi.stubEnv('STORAGE_VAULT_KEY', 'listing-vault-key-0123456789abcdef0123');
    const names: string[] = [];
    const prototype = Redis.prototype as unknown as { sendCommand: (this: unknown, command: { name: string }, ...rest: unknown[]) => unknown };
    const real = prototype.sendCommand;
    vi.spyOn(prototype, 'sendCommand').mockImplementation(function (this: unknown, command, ...rest) {
      if (this === client) names.push(command.name);
      return real.call(this, command, ...rest);
    });

    const rotated = await vault.rotate(alice);
    vi.restoreAllMocks();

    expect(rotated).toBe(true);
    expect(names).not.toContain('scan');
    expect(names).not.toContain('keys');
    expect(names.slice(0, 1)).toEqual(['smembers']);
    expect(await vault.get(ref, alice)).toEqual(CREDENTIALS);
    expect(await vault.rotate(alice)).toBe(false);
  });

  it('drops a credential that expired from the index when the user stores another, without a listing', async () => {
    const { vault } = vaultOf();
    const temporary = await store(vault, 'temporary', { ttlSeconds: 60 });
    // Redis removes the expired value by itself; the id stays in the index.
    await admin.del(`vault:cred:${temporary}`);
    expect(await admin.sismember(indexKey(alice), temporary)).toBe(1);

    const kept = await store(vault, 'kept');

    expect(await admin.smembers(indexKey(alice))).toEqual([kept]);
  });
});
