import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  CredentialsVault,
  CredentialsVaultLimitError,
  credentialsVault,
} from '../src/lib/storage/credentials-vault';
import { MAX_STORAGE_CREDENTIALS_PER_ACCOUNT } from '../src/lib/api/field-limits';
import { POST as credentialsPost } from '../src/app/api/v1/storage/credentials/route';
import { DELETE as credentialDelete } from '../src/app/api/v1/storage/credentials/[id]/route';
import { userStore } from '../src/lib/auth/user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { S3_DEV_ENDPOINT_ALLOWLIST_ENV } from '../src/lib/storage';
import { fakeVaultRedis } from './helpers/fake-vault-redis';

/**
 * An account holds at most 20 saved storage credentials, the same number as its active API keys (entry 372). The 21st save is
 * refused with a coded 409 and nothing is written; an expired or deleted credential makes room.
 */

// Hand-written from the brief: the number of API keys an account holds.
const EXPECTED_LIMIT = 20;
const CREDENTIALS = { type: 's3' as const, bucket: 'b', accessKeyId: 'AKIAEXAMPLE0000000000', secretAccessKey: 'secret-access-key-0123456789abcdef' };

beforeEach(() => vi.stubEnv('STORAGE_VAULT_KEY', 'limit-vault-key-0123456789abcdef012345'));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  credentialsVault.clear();
});

describe('the limit', () => {
  it('is 20, the cap of active API keys', () => {
    expect(MAX_STORAGE_CREDENTIALS_PER_ACCOUNT).toBe(EXPECTED_LIMIT);
  });
});

describe.each([
  ['in memory', () => ({ vault: new CredentialsVault(), written: () => 0 })],
  [
    'in a shared store',
    () => {
      const redis = fakeVaultRedis();
      return { vault: new CredentialsVault(redis.client as never), written: () => redis.data.size, redis };
    },
  ],
  [
    'in a shared store of a cluster',
    () => {
      const redis = fakeVaultRedis();
      return { vault: new CredentialsVault({ ...redis.client, isCluster: true } as never), written: () => redis.data.size, redis };
    },
  ],
])('the credentials of one account %s', (_where, make) => {
  it('stop at the limit with a typed error, and the next credential is not written', async () => {
    const { vault, written } = make();
    for (let i = 0; i < EXPECTED_LIMIT; i++) await vault.store('u1', CREDENTIALS, { name: `c${i}` });
    const before = written();

    await expect(vault.store('u1', CREDENTIALS, { name: 'one too many' })).rejects.toBeInstanceOf(CredentialsVaultLimitError);

    expect(written()).toBe(before);
    expect(await vault.list('u1')).toHaveLength(EXPECTED_LIMIT);
  });

  it('are counted per account', async () => {
    const { vault } = make();
    for (let i = 0; i < EXPECTED_LIMIT; i++) await vault.store('full', CREDENTIALS);

    await expect(vault.store('other', CREDENTIALS)).resolves.toMatch(/^cred_/);
  });

  it('make room for one when one is deleted', async () => {
    const { vault } = make();
    const refs: string[] = [];
    for (let i = 0; i < EXPECTED_LIMIT; i++) refs.push(await vault.store('u1', CREDENTIALS));
    expect(await vault.delete(refs[0], 'u1')).toBe(true);

    await expect(vault.store('u1', CREDENTIALS)).resolves.toMatch(/^cred_/);
    await expect(vault.store('u1', CREDENTIALS)).rejects.toBeInstanceOf(CredentialsVaultLimitError);
  });

  it('let requests sent at once reach the limit and never pass it', async () => {
    const { vault } = make();

    const outcomes = await Promise.allSettled(Array.from({ length: EXPECTED_LIMIT + 15 }, () => vault.store('u1', CREDENTIALS)));

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(EXPECTED_LIMIT);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected' && outcome.reason instanceof CredentialsVaultLimitError)).toHaveLength(15);
    expect(await vault.list('u1')).toHaveLength(EXPECTED_LIMIT);
  });
});

describe('an expired credential', () => {
  const expireOnPurpose = async (vault: CredentialsVault) => {
    const realNow = Date.now();
    const past = vi.spyOn(Date, 'now').mockReturnValue(realNow - 120_000);
    for (let i = 0; i < EXPECTED_LIMIT; i++) await vault.store('u1', CREDENTIALS, { ttlSeconds: 60 });
    past.mockRestore();
  };

  it('is not counted in memory', async () => {
    const vault = new CredentialsVault();
    await expireOnPurpose(vault);

    await expect(vault.store('u1', CREDENTIALS)).resolves.toMatch(/^cred_/);
  });

  it('is not counted in a shared store, which dropped the key while the index still names the id', async () => {
    const redis = fakeVaultRedis();
    const vault = new CredentialsVault(redis.client as never);
    await expireOnPurpose(vault);
    redis.data.clear();

    await expect(vault.store('u1', CREDENTIALS)).resolves.toMatch(/^cred_/);
    expect(redis.sets.get('vault:user:{u1}')?.size).toBe(1);
  });
});

describe('a save the shared store cannot reach', () => {
  it('stays a persistence error, not a limit error', async () => {
    const redis = fakeVaultRedis();
    redis.state.down = true;

    await expect(new CredentialsVault(redis.client as never).store('u1', CREDENTIALS)).rejects.toMatchObject({ code: 'CREDENTIALS_VAULT_UNAVAILABLE' });
  });

  it('takes its id back out of the index when the credential could not be written (cluster path)', async () => {
    const redis = fakeVaultRedis();
    const setFails = { ...redis.client, isCluster: true, set: () => Promise.reject(new Error('write failed')) };

    await expect(new CredentialsVault(setFails as never).store('u1', CREDENTIALS)).rejects.toMatchObject({ code: 'CREDENTIALS_VAULT_UNAVAILABLE' });

    expect(redis.sets.get('vault:user:{u1}')?.size ?? 0).toBe(0);
  });
});

describe('POST /api/v1/storage/credentials at the limit', () => {
  let authHeaders: Record<string, string>;
  const post = (name: string) =>
    credentialsPost(
      new NextRequest('http://localhost:3000/api/v1/storage/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ providerType: 's3', credentials: { ...CREDENTIALS, bucket: 'limit-bucket', endpoint: 'http://127.0.0.1:9000' }, name }),
      })
    );

  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv(S3_DEV_ENDPOINT_ALLOWLIST_ENV, '127.0.0.1:9000');
    const user = await userStore.createUser({ email: `credlimit_${Date.now()}_${Math.random().toString(36).slice(2)}@vault.test`, name: 'credlimit', tier: 'paid' });
    const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'credlimit', { scopes: ['convert:write', 'convert:read'] });
    authHeaders = { Authorization: `Bearer ${secretKey}` };
  });

  it('answers 409 with the code, the problem type and no stored credential, and a delete makes room', async () => {
    let first = '';
    for (let i = 0; i < EXPECTED_LIMIT; i++) {
      const created = await post(`c${i}`);
      expect(created.status, JSON.stringify(await created.clone().json())).toBe(201);
      if (i === 0) first = (await created.json()).credentialRef;
    }

    const refused = await post('one too many');
    expect(refused.status).toBe(409);
    expect(refused.headers.get('content-type')).toContain('application/problem+json');
    expect(await refused.json()).toMatchObject({
      status: 409,
      code: 'storage_credential_limit_reached',
      type: 'https://convert.aquilaxk.site/api-docs/errors#byos-credential-limit',
      success: false,
    });

    const removed = await credentialDelete(
      new NextRequest(`http://localhost:3000/api/v1/storage/credentials/${first}`, { method: 'DELETE', headers: authHeaders }),
      { params: Promise.resolve({ id: first }) }
    );
    expect(removed.status).toBe(204);
    expect((await post('after delete')).status).toBe(201);
  });
});
