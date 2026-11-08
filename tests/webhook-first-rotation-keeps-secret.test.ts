import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as rotateSecretRoute } from '../src/app/api/v1/webhooks/secrets/rotate/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { InMemoryWebhookSecretStore, getWebhookSecretStore, setWebhookSecretStore } from '../src/lib/api-keys/webhook-secret-store';
import { userStore } from '../src/lib/auth/user-store';
import type { User } from '../src/lib/auth/types';

/**
 * A key that has a webhook secret but no rotation record signs with that secret. The first rotation therefore keeps it as the
 * previous secret for the grace period, so a receiver that has not yet taken the new one still verifies the deliveries.
 */

const WEBHOOK_URL = 'https://93.184.215.14/hook';
const OLD_SECRET = 'whsec_old_secret_of_the_key_0123456789';

let user: User;

beforeEach(async () => {
  setWebhookSecretStore(new InMemoryWebhookSecretStore());
  user = await userStore.createUser({ name: 'First rotation', email: `first_rotation_${Date.now()}_${Math.random().toString(36).slice(2)}@test.com`, tier: 'pro' });
});

afterEach(() => setWebhookSecretStore(null));

async function rotate(secretKey: string, body: Record<string, unknown>) {
  const res = await rotateSecretRoute(
    new NextRequest('http://localhost:3000/api/v1/webhooks/secrets/rotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secretKey}` },
      body: JSON.stringify(body),
    })
  );
  return { status: res.status, json: await res.json() };
}

async function keyWith(webhookSecret: string | undefined) {
  return redisKeyStore.generateApiKey(user.id, 'Rotated key', {
    scopes: ['convert:write', 'convert:read'],
    ...(webhookSecret ? { webhookUrl: WEBHOOK_URL, webhookSecret } : {}),
  });
}

describe('the first rotation of the secret of an API key', () => {
  it('keeps the secret the key signs with as the previous one for the grace period', async () => {
    const { key, secretKey } = await keyWith(OLD_SECRET);

    const first = await rotate(secretKey, { apiKeyId: key.id, graceSeconds: 3600 });

    expect(first.status).toBe(200);
    expect(first.json.previousExpiresAt).toBe(first.json.expiresAt);
    const record = await getWebhookSecretStore().getSecretRecord(user.id, key.id);
    expect(record?.primary).toBe(first.json.secret);
    expect(record?.previous).toBe(OLD_SECRET);
    expect(record?.previousExpiresAt).toBe(first.json.expiresAt);
  });

  it('keeps the secret of the second rotation as before: the first one\'s secret is the previous one', async () => {
    const { key, secretKey } = await keyWith(OLD_SECRET);

    const first = await rotate(secretKey, { apiKeyId: key.id });
    const second = await rotate(secretKey, { apiKeyId: key.id });

    const record = await getWebhookSecretStore().getSecretRecord(user.id, key.id);
    expect(record?.primary).toBe(second.json.secret);
    expect(record?.previous).toBe(first.json.secret);
  });

  it('has no previous secret for a key without a webhook secret', async () => {
    const { key, secretKey } = await keyWith(undefined);

    const first = await rotate(secretKey, { apiKeyId: key.id });

    expect(first.json.previousExpiresAt).toBeUndefined();
    expect((await getWebhookSecretStore().getSecretRecord(user.id, key.id))?.previous).toBeUndefined();
  });

  it('does not copy the secret of the key into the record of an endpoint', async () => {
    const { key, secretKey } = await keyWith(OLD_SECRET);

    const first = await rotate(secretKey, { endpointId: 'ep_billing', apiKeyId: key.id });

    expect(first.json.previousExpiresAt).toBeUndefined();
    expect((await getWebhookSecretStore().getSecretRecord(user.id, 'ep_billing'))?.previous).toBeUndefined();
  });

  it('never replaces the record a concurrent rotation wrote between the check and the seeding', async () => {
    const { key, secretKey } = await keyWith(OLD_SECRET);
    const store = getWebhookSecretStore();
    const settled = await store.rotateSecret(user.id, key.id, 3600);

    const seeded = await store.seedPrimarySecretIfAbsent(user.id, key.id, OLD_SECRET);
    const second = await rotate(secretKey, { apiKeyId: key.id });

    expect(seeded).toBe(false);
    expect((await store.getSecretRecord(user.id, key.id))?.previous).toBe(settled.newSecret);
    expect(second.json.previousExpiresAt).toBeGreaterThan(Date.now());
  });
});
