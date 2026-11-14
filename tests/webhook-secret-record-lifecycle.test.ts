import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { DELETE as revokeKeyRoute, PATCH as patchKeyRoute } from '../src/app/api/keys/[id]/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { getWebhookSecretStore } from '../src/lib/api-keys/webhook-secret-store';
import { createSessionToken } from '../src/lib/auth/session';
import { userStore } from '../src/lib/auth/user-store';

/**
 * The rotated secret of a key's webhook is read for every delivery of the key and wins over the secret the key holds. It ends with the
 * key and with the address it signed for: a record left behind would sign for the next address set on the key.
 */

const ORIGIN = 'http://localhost:3000';
const ROTATED = 'whsec_rotated_secret_that_must_not_outlive_the_key';

async function ownerWithRotatedKey() {
  const user = await userStore.createUser({
    name: 'Lifecycle Owner',
    email: `lifecycle_${Date.now()}_${Math.random().toString(36).slice(2)}@example.com`,
    tier: 'paid',
  });
  const { key } = await redisKeyStore.generateApiKey(user.id, 'Hooked', {
    scopes: ['convert:write'],
    webhookUrl: 'https://example.com/hook',
    webhookSecret: 'initial_secret',
  });
  await getWebhookSecretStore().setPrimarySecret(user.id, key.id, ROTATED);
  const cookie = `easyconvert_session=${createSessionToken(user)}`;
  return { user, keyId: key.id, cookie, params: { params: Promise.resolve({ id: key.id }) } };
}

describe('the webhook secret record of an API key', () => {
  it('is deleted when the key is revoked', async () => {
    const { user, keyId, cookie, params } = await ownerWithRotatedKey();
    expect(await getWebhookSecretStore().getSecretRecord(user.id, keyId)).not.toBeNull();

    const res = await revokeKeyRoute(new NextRequest(`${ORIGIN}/api/keys/${keyId}`, { method: 'DELETE', headers: { Cookie: cookie } }), params);

    expect(res.status).toBe(200);
    expect(await getWebhookSecretStore().getSecretRecord(user.id, keyId)).toBeNull();
  });

  it('is deleted when the address of the key is cleared', async () => {
    const { user, keyId, cookie, params } = await ownerWithRotatedKey();

    const res = await patchKeyRoute(
      new NextRequest(`${ORIGIN}/api/keys/${keyId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ webhookUrl: '', webhookSecret: '' }),
      }),
      params
    );

    expect(res.status).toBe(200);
    expect(await getWebhookSecretStore().getSecretRecord(user.id, keyId)).toBeNull();
  });

  it('stays while the key keeps its address', async () => {
    const { user, keyId, cookie, params } = await ownerWithRotatedKey();

    const res = await patchKeyRoute(
      new NextRequest(`${ORIGIN}/api/keys/${keyId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name: 'Renamed' }) }),
      params
    );

    expect(res.status).toBe(200);
    expect((await getWebhookSecretStore().getSecretRecord(user.id, keyId))?.primary).toBe(ROTATED);
  });
});

describe('the Redis client of the graph scheduler', () => {
  it('connects to REDIS_HOST and REDIS_PORT when REDIS_URL is not set', async () => {
    vi.resetModules();
    const schedulers: Array<{ redisClient: { args: unknown[] } }> = [];
    vi.doMock('ioredis', () => ({
      default: class FakeRedis {
        constructor(readonly args: unknown[]) {
          this.args = args;
        }
      },
    }));
    vi.doMock('../src/lib/queue/graph/redis-scheduler', () => ({
      RedisGraphScheduler: class {
        constructor(options: { redisClient: { args: unknown[] } }) {
          schedulers.push(options);
        }
      },
    }));
    vi.stubEnv('REDIS_URL', '');
    vi.stubEnv('REDIS_HOST', 'redis.internal');
    vi.stubEnv('REDIS_PORT', '6390');

    try {
      const { createGraphScheduler } = await import('../src/lib/queue/graph/scheduler');
      createGraphScheduler({ distributed: true });

      expect(schedulers.at(-1)?.redisClient.args).toMatchObject({ host: 'redis.internal', port: 6390 });
    } finally {
      vi.doUnmock('ioredis');
      vi.doUnmock('../src/lib/queue/graph/redis-scheduler');
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
