import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { CredentialsVault, CredentialsVaultPersistenceError, credentialsVault } from '../src/lib/storage/credentials-vault';
import { POST as credentialsPost, GET as credentialsGet } from '../src/app/api/v1/storage/credentials/route';
import { DELETE as credentialDelete } from '../src/app/api/v1/storage/credentials/[id]/route';
import { userStore } from '../src/lib/auth/user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { S3_DEV_ENDPOINT_ALLOWLIST_ENV } from '../src/lib/storage';

/**
 * Regression tests for issue #483: the vault kept credentials in process memory when the Redis
 * save failed, so a "saved" credential vanished on the next instance or restart, and reads and
 * deletes answered from (or reported success against) that memory when Redis was down.
 */

const VAULT_KEY_PREFIX = 'vault:cred:';
const HTTP_CREATED = 201;
const HTTP_UNAVAILABLE = 503;
const CREDENTIALS = {
  type: 's3' as const,
  bucket: 'customer-bucket',
  accessKeyId: 'AKIACUSTOMEREXAMPLE1',
  secretAccessKey: 'customer/Secret+EXAMPLEKEY000000000000',
};

/** A Redis that keeps strings in a map and can be switched off, like the part of ioredis the vault uses. */
function fakeRedis() {
  const data = new Map<string, string>();
  const state = { down: false };
  const guard = <T>(value: () => T): Promise<T> =>
    state.down ? Promise.reject(new Error('redis down')) : Promise.resolve(value());
  const client = {
    set: (key: string, value: string) => guard(() => (data.set(key, value), 'OK')),
    setex: (key: string, _ttl: number, value: string) => guard(() => (data.set(key, value), 'OK')),
    get: (key: string) => guard(() => data.get(key) ?? null),
    del: (key: string) => guard(() => (data.delete(key) ? 1 : 0)),
    keys: (pattern: string) => guard(() => [...data.keys()].filter((key) => key.startsWith(pattern.replace('*', '')))),
  };
  return { client, data, state };
}

function memoryCopies(vault: CredentialsVault): number {
  return (vault as unknown as { inMemoryStore: Map<string, unknown> }).inMemoryStore.size;
}

describe('Credentials vault persistence (#483)', () => {
  beforeEach(() => {
    vi.stubEnv('STORAGE_VAULT_KEY', 'regression-vault-key-0123456789abcdef');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('with a shared Redis', () => {
    it('saves into Redis only, and a second instance lists and reads the credential', async () => {
      const redis = fakeRedis();
      const writer = new CredentialsVault(redis.client as never);
      const reader = new CredentialsVault(redis.client as never);

      const ref = await writer.store('user_1', CREDENTIALS, { name: 'primary' });
      expect(ref).toMatch(/^cred_[0-9a-f]{32}$/);
      expect(memoryCopies(writer)).toBe(0);
      expect([...redis.data.keys()]).toEqual([`${VAULT_KEY_PREFIX}${ref}`]);
      expect(redis.data.get(`${VAULT_KEY_PREFIX}${ref}`)).not.toContain(CREDENTIALS.secretAccessKey);

      expect(await reader.list('user_1')).toEqual([
        { id: ref, userId: 'user_1', providerType: 's3', name: 'primary', createdAt: expect.any(Number), expiresAt: undefined },
      ]);
      expect(await reader.list('user_2')).toEqual([]);
      expect(await reader.get(ref, 'user_1')).toEqual(CREDENTIALS);
      expect(await reader.get(ref, 'user_2')).toBeNull();
    });

    it('throws when the Redis save fails instead of keeping the credentials in memory', async () => {
      const redis = fakeRedis();
      redis.state.down = true;
      const vault = new CredentialsVault(redis.client as never);

      await expect(vault.store('user_1', CREDENTIALS)).rejects.toThrow(CredentialsVaultPersistenceError);
      await expect(vault.store('user_1', CREDENTIALS, { ttlSeconds: 60 })).rejects.toThrow(CredentialsVaultPersistenceError);
      expect(memoryCopies(vault)).toBe(0);
      expect(redis.data.size).toBe(0);

      redis.state.down = false;
      expect(await new CredentialsVault(redis.client as never).list('user_1')).toEqual([]);
    });

    it('fails a read, a list and a delete with the typed error while Redis is down, never answering from memory', async () => {
      const redis = fakeRedis();
      const vault = new CredentialsVault(redis.client as never);
      const ref = await vault.store('user_1', CREDENTIALS);
      // A stale in-process copy must never stand in for the shared store.
      (vault as unknown as { inMemoryStore: Map<string, unknown> }).inMemoryStore.set(ref, {
        id: ref,
        userId: 'user_1',
        providerType: 's3',
        iv: '',
        tag: '',
        encryptedData: '',
        createdAt: 1,
      });
      redis.state.down = true;

      await expect(vault.get(ref, 'user_1')).rejects.toThrow(CredentialsVaultPersistenceError);
      await expect(vault.list('user_1')).rejects.toThrow(CredentialsVaultPersistenceError);
      await expect(vault.delete(ref, 'user_1')).rejects.toThrow(CredentialsVaultPersistenceError);

      redis.state.down = false;
      expect(redis.data.has(`${VAULT_KEY_PREFIX}${ref}`)).toBe(true);
      expect(await vault.delete(ref, 'user_1')).toBe(true);
      expect(redis.data.size).toBe(0);
      expect(await vault.get(ref, 'user_1')).toBeNull();
    });

    it('does not delete another user\'s credential', async () => {
      const redis = fakeRedis();
      const vault = new CredentialsVault(redis.client as never);
      const ref = await vault.store('user_1', CREDENTIALS);
      expect(await vault.delete(ref, 'user_2')).toBe(false);
      expect(redis.data.has(`${VAULT_KEY_PREFIX}${ref}`)).toBe(true);
    });
  });

  describe('without Redis (local development and tests)', () => {
    it('keeps credentials in process memory', async () => {
      const vault = new CredentialsVault();
      const ref = await vault.store('user_1', CREDENTIALS, { name: 'local' });
      expect(memoryCopies(vault)).toBe(1);
      expect((await vault.list('user_1')).map((summary) => summary.id)).toEqual([ref]);
      expect(await vault.get(ref, 'user_1')).toEqual(CREDENTIALS);
      expect(await vault.delete(ref, 'user_1')).toBe(true);
      expect(await vault.list('user_1')).toEqual([]);
    });
  });

  describe('credential routes', () => {
    let authHeaders: Record<string, string>;
    let userId: string;

    beforeEach(async () => {
      const user = await userStore.createUser({
        email: `vault503_${Date.now()}_${Math.random().toString(36).slice(2)}@vault.test`,
        name: 'vault503',
        tier: 'pro',
      });
      userId = user.id;
      const { secretKey } = await redisKeyStore.generateApiKey(userId, 'vault503', { scopes: ['convert:write', 'convert:read'] });
      authHeaders = { Authorization: `Bearer ${secretKey}` };
    });

    async function expectUnavailable(res: Response) {
      expect(res.status).toBe(HTTP_UNAVAILABLE);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      const body = await res.json();
      expect(body).toMatchObject({ status: HTTP_UNAVAILABLE, title: 'Service Unavailable' });
      expect(body.detail).toMatch(/^Credential storage is unavailable; the (credentials were not saved|request was not completed)\.$/);
      expect(JSON.stringify(body)).not.toContain('redis down');
    }

    const down = () => new CredentialsVaultPersistenceError({ cause: new Error('redis down') });

    it('answers a save that Redis refused with 503', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv(S3_DEV_ENDPOINT_ALLOWLIST_ENV, '127.0.0.1:9000');
      vi.spyOn(credentialsVault, 'store').mockRejectedValue(down());
      const res = await credentialsPost(
        new NextRequest('http://localhost:3000/api/v1/storage/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({ providerType: 's3', credentials: { ...CREDENTIALS, endpoint: 'http://127.0.0.1:9000' } }),
        })
      );
      expect(res.status).not.toBe(HTTP_CREATED);
      await expectUnavailable(res);
    });

    it('answers a list that Redis refused with 503', async () => {
      vi.spyOn(credentialsVault, 'list').mockRejectedValue(down());
      await expectUnavailable(
        await credentialsGet(new NextRequest('http://localhost:3000/api/v1/storage/credentials', { headers: authHeaders }))
      );
    });

    it('answers a delete that Redis refused with 503 rather than 204', async () => {
      vi.spyOn(credentialsVault, 'delete').mockRejectedValue(down());
      const ref = `cred_${'a'.repeat(32)}`;
      await expectUnavailable(
        await credentialDelete(
          new NextRequest(`http://localhost:3000/api/v1/storage/credentials/${ref}`, { method: 'DELETE', headers: authHeaders }),
          { params: { id: ref } }
        )
      );
    });
  });
});
