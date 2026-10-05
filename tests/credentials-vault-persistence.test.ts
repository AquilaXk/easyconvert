import { describe, it, expect, vi, afterEach } from 'vitest';
import { CredentialsVault, CredentialsVaultPersistenceError } from '../src/lib/storage/credentials-vault';

/**
 * Regression test for issue #483: the vault kept credentials in process memory when the Redis
 * save failed, so a "saved" credential vanished on the next instance or restart.
 */

describe('Credentials vault persistence (#483)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('credentials vault', () => {
    it('throws when the Redis save fails instead of keeping the credentials in memory', async () => {
      const failingRedis = {
        set: () => Promise.reject(new Error('redis down')),
        setex: () => Promise.reject(new Error('redis down')),
        get: () => Promise.resolve(null),
        del: () => Promise.resolve(0),
        keys: () => Promise.resolve([]),
      };
      vi.stubEnv('STORAGE_VAULT_KEY', 'regression-vault-key-0123456789abcdef');
      const vault = new CredentialsVault(failingRedis as never);
      const credentials = {
        type: 's3' as const,
        bucket: 'customer-bucket',
        accessKeyId: 'AKIACUSTOMEREXAMPLE1',
        secretAccessKey: 'customer/Secret+EXAMPLEKEY000000000000',
      };

      await expect(vault.store('user_1', credentials)).rejects.toThrow(CredentialsVaultPersistenceError);
      await expect(vault.store('user_1', credentials, { ttlSeconds: 60 })).rejects.toThrow(
        CredentialsVaultPersistenceError
      );
      // Nothing was kept in process memory either.
      expect(await vault.list('user_1')).toEqual([]);
    });
  });
});
