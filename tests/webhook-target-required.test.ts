import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import {
  InMemoryWebhookSecretStore,
  WebhookTargetRequiredError,
  getWebhookSecretStore,
  setWebhookSecretStore,
} from '../src/lib/api-keys/webhook-secret-store';
import { POST as rotateSecretRoute } from '../src/app/api/v1/webhooks/secrets/rotate/route';
import { userStore } from '../src/lib/auth/user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import type { User } from '../src/lib/auth/types';

/**
 * A webhook secret belongs to one target (an endpoint or an API key). Rotation and dispatch never
 * fall back to a shared "default" slot: a request without a target is a 400, and a dispatch that
 * names no target does not read any stored secret record, so an unrelated caller can neither
 * borrow nor extend another target's secret.
 */

const TARGET_URL = 'https://example.com/webhook-receiver';
const ROTATE_URL = 'http://localhost:3000/api/v1/webhooks/secrets/rotate';
const DEFAULT_SLOT = 'default';
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const GRACE_SECONDS = 3600;
const CALLER_SECRET = 'whsec_caller_supplied_secret_0123456789abcdef0123456789abcdef01234567';

describe('webhook target ids are explicit', () => {
  let user: User;
  let apiKey: string;
  let keyId: string;
  let received: Array<{ headers: Record<string, string>; body: string }>;

  beforeEach(async () => {
    received = [];
    vi.stubEnv('WEBHOOK_SECRET_KEK', 'test-enterprise-kek-32-byte-secret-key-1234');
    setWebhookSecretStore(new InMemoryWebhookSecretStore());
    user = await userStore.createUser({
      name: 'Webhook Target User',
      email: `webhook_target_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@test.com`,
      tier: 'pro',
    });
    const key = await redisKeyStore.generateApiKey(user.id, 'Webhook Target Key', { scopes: ['convert:write'] });
    apiKey = key.secretKey;
    keyId = key.key.id;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers as HeadersInit).forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      received.push({ headers, body: typeof init?.body === 'string' ? init.body : '' });
      return new Response('{}', { status: HTTP_OK });
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setWebhookSecretStore(null);
    await webhookDispatcher.clearDlq(user.id);
  });

  function rotate(body: Record<string, unknown>): Promise<Response> {
    return rotateSecretRoute(
      new NextRequest(ROTATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      })
    );
  }

  /** Puts a rotated secret (current and still-valid previous one) in the shared "default" slot. */
  async function seedDefaultSlot(): Promise<{ previous: string; current: string }> {
    const store = getWebhookSecretStore();
    const first = await store.rotateSecret(user.id, DEFAULT_SLOT, GRACE_SECONDS);
    const second = await store.rotateSecret(user.id, DEFAULT_SLOT, GRACE_SECONDS);
    return { previous: first.newSecret, current: second.newSecret };
  }

  function hmac(secret: string, deliveryId: string, timestamp: number, body: string): string {
    return crypto.createHmac('sha256', secret).update(`${deliveryId}.${timestamp}.${body}`).digest('base64');
  }

  describe('POST /api/v1/webhooks/secrets/rotate', () => {
    it.each([
      ['no target at all', {}],
      ['blank endpointId and apiKeyId', { endpointId: '', apiKeyId: '' }],
      ['whitespace-only endpointId', { endpointId: '   ' }],
    ])('answers 400 for %s and creates no secret record', async (_label, body) => {
      const res = await rotate(body);
      expect(res.status).toBe(HTTP_BAD_REQUEST);
      const problem = await res.json();
      expect(problem.status).toBe(HTTP_BAD_REQUEST);
      expect(problem.detail).toMatch(/endpointId|apiKeyId/);
      expect(problem).not.toHaveProperty('secret');
      expect(await getWebhookSecretStore().getSecretRecord(user.id, DEFAULT_SLOT)).toBeNull();
    });

    it('rotates the named endpoint and leaves the default slot empty', async () => {
      const res = await rotate({ endpointId: 'ep_billing' });
      expect(res.status).toBe(HTTP_OK);
      const { secret } = await res.json();
      expect((await getWebhookSecretStore().getSecretRecord(user.id, 'ep_billing'))?.primary).toBe(secret);
      expect(await getWebhookSecretStore().getSecretRecord(user.id, DEFAULT_SLOT)).toBeNull();
    });

    it('rotates the secret of the named API key', async () => {
      const res = await rotate({ apiKeyId: keyId });
      expect(res.status).toBe(HTTP_OK);
      const { secret } = await res.json();
      expect((await getWebhookSecretStore().getSecretRecord(user.id, keyId))?.primary).toBe(secret);
      expect(await getWebhookSecretStore().getSecretRecord(user.id, DEFAULT_SLOT)).toBeNull();
    });
  });

  describe('secret store', () => {
    it.each(['', '   '])('refuses target id %j with the typed error on every operation', async (targetId) => {
      const store = getWebhookSecretStore();
      const typed = { name: 'WebhookTargetRequiredError', status: HTTP_BAD_REQUEST };
      await expect(store.getSecretRecord(user.id, targetId)).rejects.toMatchObject(typed);
      await expect(store.setPrimarySecret(user.id, targetId, CALLER_SECRET)).rejects.toMatchObject(typed);
      await expect(store.rotateSecret(user.id, targetId, GRACE_SECONDS)).rejects.toMatchObject(typed);
      await expect(store.deleteSecretRecord(user.id, targetId)).rejects.toMatchObject(typed);
      expect(await store.getSecretRecord(user.id, DEFAULT_SLOT)).toBeNull();
    });

    it('carries HTTP status 400', () => {
      expect(new WebhookTargetRequiredError().status).toBe(HTTP_BAD_REQUEST);
    });
  });

  describe('WebhookDispatcher.dispatch', () => {
    it('does not borrow the default slot secret when the caller names no target and supplies no secret', async () => {
      await seedDefaultSlot();
      const result = await webhookDispatcher.dispatch(TARGET_URL, 'job.completed', { jobId: 'j1' }, '', {
        ownerUserId: user.id,
        skipDlq: true,
      });
      expect(result.success).toBe(false);
      expect(result.totalAttempts).toBe(0);
      expect(received).toHaveLength(0);
    });

    it('signs with the caller secret alone, not with a previous secret held in the default slot', async () => {
      const { previous, current } = await seedDefaultSlot();
      const result = await webhookDispatcher.dispatch(TARGET_URL, 'job.completed', { jobId: 'j2' }, CALLER_SECRET, {
        ownerUserId: user.id,
      });
      expect(result.success).toBe(true);
      expect(received).toHaveLength(1);

      const { headers, body } = received[0];
      const timestamp = Number.parseInt(headers['webhook-timestamp'], 10);
      const expected = `v1,${hmac(CALLER_SECRET, headers['webhook-id'], timestamp, body)}`;
      expect(headers['webhook-signature']).toBe(expected);
      expect(headers['webhook-signature']).not.toContain(hmac(previous, headers['webhook-id'], timestamp, body));
      expect(headers['webhook-signature']).not.toContain(hmac(current, headers['webhook-id'], timestamp, body));
    });

    it('never reads or creates the default slot', async () => {
      const store = getWebhookSecretStore();
      const read = vi.spyOn(store, 'getSecretRecord');
      await webhookDispatcher.dispatch(TARGET_URL, 'job.completed', { jobId: 'j3' }, CALLER_SECRET, { ownerUserId: user.id });
      expect(read).not.toHaveBeenCalled();
      expect(await store.getSecretRecord(user.id, DEFAULT_SLOT)).toBeNull();
    });

    it('uses the record of the explicit target, with its previous secret during the grace period', async () => {
      const store = getWebhookSecretStore();
      const first = await store.rotateSecret(user.id, 'ep_billing', GRACE_SECONDS);
      const second = await store.rotateSecret(user.id, 'ep_billing', GRACE_SECONDS);
      const result = await webhookDispatcher.dispatch(TARGET_URL, 'job.completed', { jobId: 'j4' }, second.newSecret, {
        ownerUserId: user.id,
        targetId: 'ep_billing',
      });
      expect(result.success).toBe(true);
      const { headers, body } = received[0];
      const timestamp = Number.parseInt(headers['webhook-timestamp'], 10);
      expect(headers['webhook-signature']).toBe(
        `v1,${hmac(second.newSecret, headers['webhook-id'], timestamp, body)} v1,${hmac(first.newSecret, headers['webhook-id'], timestamp, body)}`
      );
    });

    it('treats the owning API key id as an explicit target', async () => {
      const store = getWebhookSecretStore();
      const rotated = await store.rotateSecret(user.id, keyId, GRACE_SECONDS);
      const result = await webhookDispatcher.dispatch(TARGET_URL, 'key.expiring_soon', { keyId }, '', {
        ownerUserId: user.id,
        ownerKeyId: keyId,
      });
      expect(result.success).toBe(true);
      const { headers, body } = received[0];
      const timestamp = Number.parseInt(headers['webhook-timestamp'], 10);
      expect(headers['webhook-signature']).toBe(`v1,${hmac(rotated.newSecret, headers['webhook-id'], timestamp, body)}`);
    });

    it.each(['', '   '])('rejects a blank target id %j with the typed error instead of falling back', async (targetId) => {
      await seedDefaultSlot();
      await expect(
        webhookDispatcher.dispatch(TARGET_URL, 'job.completed', { jobId: 'j5' }, CALLER_SECRET, {
          ownerUserId: user.id,
          targetId,
        })
      ).rejects.toMatchObject({ name: 'WebhookTargetRequiredError', status: HTTP_BAD_REQUEST });
      expect(received).toHaveLength(0);
    });
  });
});
