import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as rotateSecretRoute } from '../src/app/api/v1/webhooks/secrets/rotate/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import {
  ENDPOINT_SECRET_RECORD_TTL_SECONDS,
  InMemoryWebhookSecretStore,
  MAX_ENDPOINT_SECRET_RECORDS_PER_OWNER,
  RedisWebhookSecretStore,
  WebhookEndpointLimitError,
  getWebhookSecretStore,
  setWebhookSecretStore,
} from '../src/lib/api-keys/webhook-secret-store';
import { createSessionToken } from '../src/lib/auth/session';
import { userStore } from '../src/lib/auth/user-store';
import type { User } from '../src/lib/auth/types';

/**
 * A rotation answers the new signing secret in plaintext, so it is limited to what the caller may already act as: a session
 * or an admin (`*`) key rotates any secret of the account, any other key only its own. A named key must be an active key of the
 * caller's account (an unknown id and another account's id answer alike), the endpoint records of an owner are bounded, and a
 * rotation is one atomic step.
 */

const ROTATE_URL = 'http://localhost:3000/api/v1/webhooks/secrets/rotate';
const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const KEK = 'test-enterprise-kek-32-byte-secret-key-1234';

let owner: User;
let other: User;

function uniqueEmail(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@test.com`;
}

beforeEach(async () => {
  vi.stubEnv('WEBHOOK_SECRET_KEK', KEK);
  setWebhookSecretStore(new InMemoryWebhookSecretStore());
  owner = await userStore.createUser({ name: 'Rotation owner', email: uniqueEmail('rot_owner'), tier: 'pro' });
  other = await userStore.createUser({ name: 'Rotation other', email: uniqueEmail('rot_other'), tier: 'pro' });
});

afterEach(() => {
  setWebhookSecretStore(null);
  vi.unstubAllEnvs();
});

async function rotateAs(credential: { bearer: string } | { sessionOf: User }, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if ('bearer' in credential) headers.Authorization = `Bearer ${credential.bearer}`;
  else headers.Authorization = `Bearer ${createSessionToken(credential.sessionOf)}`;
  const res = await rotateSecretRoute(new NextRequest(ROTATE_URL, { method: 'POST', headers, body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
}

describe('who may rotate which secret', () => {
  it('refuses a low-privilege key that names another key of its account, and leaves that key\'s secret alone', async () => {
    const admin = await redisKeyStore.generateApiKey(owner.id, 'Admin key', { scopes: ['*'] });
    const low = await redisKeyStore.generateApiKey(owner.id, 'Low key', { scopes: ['convert:write'] });

    const res = await rotateAs({ bearer: low.secretKey }, { apiKeyId: admin.key.id });

    expect(res.status).toBe(HTTP_FORBIDDEN);
    expect(res.json.secret).toBeUndefined();
    expect(await getWebhookSecretStore().getSecretRecord(owner.id, admin.key.id)).toBeNull();
  });

  it('lets a key rotate its own secret', async () => {
    const low = await redisKeyStore.generateApiKey(owner.id, 'Low key', { scopes: ['convert:write'] });

    const res = await rotateAs({ bearer: low.secretKey }, { apiKeyId: low.key.id });

    expect(res.status).toBe(HTTP_OK);
    expect(String(res.json.secret)).toMatch(/^whsec_[a-f0-9]{64}$/);
  });

  it('refuses a low-privilege key an endpoint target, even together with its own id', async () => {
    const low = await redisKeyStore.generateApiKey(owner.id, 'Low key', { scopes: ['convert:write'] });

    const res = await rotateAs({ bearer: low.secretKey }, { endpointId: 'ep_billing', apiKeyId: low.key.id });

    expect(res.status).toBe(HTTP_FORBIDDEN);
    expect(await getWebhookSecretStore().getSecretRecord(owner.id, 'ep_billing')).toBeNull();
  });

  it('lets an admin key rotate another key of the account and an endpoint', async () => {
    const admin = await redisKeyStore.generateApiKey(owner.id, 'Admin key', { scopes: ['*'] });
    const low = await redisKeyStore.generateApiKey(owner.id, 'Low key', { scopes: ['convert:write'] });

    expect((await rotateAs({ bearer: admin.secretKey }, { apiKeyId: low.key.id })).status).toBe(HTTP_OK);
    expect((await rotateAs({ bearer: admin.secretKey }, { endpointId: 'ep_billing' })).status).toBe(HTTP_OK);
  });

  it('lets a signed-in session rotate any key of its account', async () => {
    const low = await redisKeyStore.generateApiKey(owner.id, 'Low key', { scopes: ['convert:write'] });

    const res = await rotateAs({ sessionOf: owner }, { apiKeyId: low.key.id });

    expect(res.status).toBe(HTTP_OK);
  });
});

describe('what a named key must be', () => {
  it('answers 404 for an unknown key id and creates no record', async () => {
    const admin = await redisKeyStore.generateApiKey(owner.id, 'Admin key', { scopes: ['*'] });
    const missing = crypto.randomUUID();

    const res = await rotateAs({ bearer: admin.secretKey }, { apiKeyId: missing });

    expect(res.status).toBe(HTTP_NOT_FOUND);
    expect(await getWebhookSecretStore().getSecretRecord(owner.id, missing)).toBeNull();
  });

  it('answers 404 for the key of another account, as for an unknown one', async () => {
    const admin = await redisKeyStore.generateApiKey(owner.id, 'Admin key', { scopes: ['*'] });
    const foreign = await redisKeyStore.generateApiKey(other.id, 'Foreign key', { scopes: ['*'] });

    const res = await rotateAs({ bearer: admin.secretKey }, { apiKeyId: foreign.key.id });

    expect(res.status).toBe(HTTP_NOT_FOUND);
    expect(await getWebhookSecretStore().getSecretRecord(owner.id, foreign.key.id)).toBeNull();
    expect(await getWebhookSecretStore().getSecretRecord(other.id, foreign.key.id)).toBeNull();
  });

  it('answers 404 for a revoked key', async () => {
    const admin = await redisKeyStore.generateApiKey(owner.id, 'Admin key', { scopes: ['*'] });
    const old = await redisKeyStore.generateApiKey(owner.id, 'Old key', { scopes: ['convert:write'] });
    await redisKeyStore.revokeApiKey(owner.id, old.key.id);

    expect((await rotateAs({ bearer: admin.secretKey }, { apiKeyId: old.key.id })).status).toBe(HTTP_NOT_FOUND);
  });

  it('does not let an endpoint rotation rewrite the secret of the key named beside it', async () => {
    const admin = await redisKeyStore.generateApiKey(owner.id, 'Admin key', { scopes: ['*'], webhookUrl: 'https://93.184.215.14/hook', webhookSecret: 'whsec_the_secret_of_the_key_0123456789' });

    const res = await rotateAs({ bearer: admin.secretKey }, { endpointId: 'ep_billing', apiKeyId: admin.key.id });

    expect(res.status).toBe(HTTP_OK);
    const stored = (await redisKeyStore.listApiKeys(owner.id)).find((key) => key.id === admin.key.id);
    expect(stored?.webhookSecret).toBe('whsec_the_secret_of_the_key_0123456789');
  });
});

describe('the endpoint records of one owner', () => {
  it('holds at most MAX_ENDPOINT_SECRET_RECORDS_PER_OWNER, refuses the next with 409 and still rotates an existing one', async () => {
    const admin = await redisKeyStore.generateApiKey(owner.id, 'Admin key', { scopes: ['*'] });
    for (let index = 0; index < MAX_ENDPOINT_SECRET_RECORDS_PER_OWNER; index += 1) {
      expect((await rotateAs({ bearer: admin.secretKey }, { endpointId: `ep_${index}` })).status).toBe(HTTP_OK);
    }

    const refused = await rotateAs({ bearer: admin.secretKey }, { endpointId: 'ep_one_too_many' });
    const again = await rotateAs({ bearer: admin.secretKey }, { endpointId: 'ep_0' });

    expect(refused.status).toBe(HTTP_CONFLICT);
    expect(await getWebhookSecretStore().getSecretRecord(owner.id, 'ep_one_too_many')).toBeNull();
    expect(again.status).toBe(HTTP_OK);
  });

  it('counts per owner and frees a slot when a record is deleted', async () => {
    const store = getWebhookSecretStore();
    for (let index = 0; index < MAX_ENDPOINT_SECRET_RECORDS_PER_OWNER; index += 1) {
      await store.rotateSecret(owner.id, `ep_${index}`, 60, { endpointLimit: MAX_ENDPOINT_SECRET_RECORDS_PER_OWNER });
    }

    await expect(store.rotateSecret(owner.id, 'ep_new', 60, { endpointLimit: MAX_ENDPOINT_SECRET_RECORDS_PER_OWNER })).rejects.toBeInstanceOf(WebhookEndpointLimitError);
    const forOther = await store.rotateSecret(other.id, 'ep_new', 60, { endpointLimit: MAX_ENDPOINT_SECRET_RECORDS_PER_OWNER });
    expect((await store.getSecretRecord(other.id, 'ep_new'))?.primary).toBe(forOther.newSecret);
    await store.deleteSecretRecord(owner.id, 'ep_3');
    const afterDelete = await store.rotateSecret(owner.id, 'ep_new', 60, { endpointLimit: MAX_ENDPOINT_SECRET_RECORDS_PER_OWNER });
    expect((await store.getSecretRecord(owner.id, 'ep_new'))?.primary).toBe(afterDelete.newSecret);
  });
});

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!process.env.REDIS_URL)('rotation in Redis', () => {
  const ownerId = `rot_redis_${crypto.randomBytes(6).toString('hex')}`;
  let store: RedisWebhookSecretStore;

  beforeEach(() => {
    const client = redisKeyStore.getRedisClient();
    if (!client) throw new Error('REDIS_URL is set but the key store has no Redis client');
    store = new RedisWebhookSecretStore({ redisClient: client });
  });

  afterEach(async () => {
    const client = redisKeyStore.getRedisClient();
    const keys = await client!.keys(`webhook:sec*{${ownerId}}*`);
    if (keys.length > 0) await client!.del(...keys);
  });

  it('keeps every secret a concurrent rotation replaces as the previous one of the next', async () => {
    const trials = 20;
    for (let trial = 0; trial < trials; trial += 1) {
      const target = `key_${trial}`;
      const first = await store.rotateSecret(ownerId, target, 3600);

      const [a, b] = await Promise.all([store.rotateSecret(ownerId, target, 3600), store.rotateSecret(ownerId, target, 3600)]);

      const record = await store.getSecretRecord(ownerId, target);
      const winner = record?.primary === a.newSecret ? b : a;
      expect([a.newSecret, b.newSecret]).toContain(record?.primary);
      // The loser of the race was the primary for a moment: it is the previous one, not the secret both read.
      expect(record?.previous).toBe(winner.newSecret);
      expect(record?.previous).not.toBe(first.newSecret);
    }
  });

  it('gives an endpoint record a lifetime and indexes it, and gives an API key record none', async () => {
    const client = redisKeyStore.getRedisClient()!;
    await store.rotateSecret(ownerId, 'ep_billing', 60, { endpointLimit: MAX_ENDPOINT_SECRET_RECORDS_PER_OWNER });
    await store.rotateSecret(ownerId, 'key_forever', 60);

    const endpointTtl = await client.ttl(`webhook:sec:{${ownerId}}:ep_billing`);
    expect(endpointTtl).toBeGreaterThan(ENDPOINT_SECRET_RECORD_TTL_SECONDS - 60);
    expect(endpointTtl).toBeLessThanOrEqual(ENDPOINT_SECRET_RECORD_TTL_SECONDS);
    expect(await client.ttl(`webhook:sec:{${ownerId}}:key_forever`)).toBe(-1);
    expect(await client.smembers(`webhook:sec-endpoints:{${ownerId}}`)).toEqual(['ep_billing']);
  });

  it('refuses a new endpoint record past the limit and prunes the ones that expired', async () => {
    const client = redisKeyStore.getRedisClient()!;
    for (let index = 0; index < 3; index += 1) await store.rotateSecret(ownerId, `ep_${index}`, 60, { endpointLimit: 3 });

    await expect(store.rotateSecret(ownerId, 'ep_extra', 60, { endpointLimit: 3 })).rejects.toBeInstanceOf(WebhookEndpointLimitError);
    await client.del(`webhook:sec:{${ownerId}}:ep_1`);
    const created = await store.rotateSecret(ownerId, 'ep_extra', 60, { endpointLimit: 3 });
    expect(created.newSecret).toMatch(/^whsec_[a-f0-9]{64}$/);
    expect((await store.getSecretRecord(ownerId, 'ep_extra'))?.primary).toBe(created.newSecret);
  });
});
