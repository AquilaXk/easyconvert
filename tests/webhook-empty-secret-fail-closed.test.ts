import { describe, it, expect, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { validateApiAccess } from '../src/lib/api-keys/guard';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import type { User } from '../src/lib/auth/types';

// Public IPv4 literal: passes the SSRF pre-flight without a DNS round trip; fetch itself is mocked.
const PUBLIC_WEBHOOK_URL = 'https://93.184.215.14/hooks/empty-secret';
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

async function createUser(label: string): Promise<User> {
  const email = `${label}_${Date.now()}_${Math.random().toString(36).slice(2)}@empty-secret.test`;
  return userStore.sanitizeUser(await userStore.createUser({ email, name: label, tier: 'pro' }));
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers as HeadersInit).get(name);
}

describe('webhooks fail closed without a signing secret', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not send an event signed with an empty secret and dead-letters it', async () => {
    const owner = await createUser('empty');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok', { status: 200 }));

    const result = await webhookDispatcher.dispatch(PUBLIC_WEBHOOK_URL, 'job.completed', { jobId: 'job_empty' }, '', {
      maxRetries: 1,
      initialDelayMs: 1,
      ownerUserId: owner.id,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.totalAttempts).toBe(0);
    const entry = await webhookDispatcher.getDlqEntry(`dlq_${result.id}`, owner.id);
    expect(entry?.errorMessage).toBe('missing_webhook_secret');
    expect(entry?.event).toBe('job.completed');
    expect(entry?.payload).toEqual({ jobId: 'job_empty' });
  });

  it('does not send key.expiring_soon for a key without a webhook secret', async () => {
    const owner = await createUser('expiring');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok', { status: 200 }));
    const { key, secretKey } = await redisKeyStore.generateApiKey(owner.id, 'No Secret', {
      expiresAt: Date.now() + TWO_DAYS_MS,
      webhookUrl: PUBLIC_WEBHOOK_URL,
    });
    expect(key.webhookSecret ?? '').toBe('');

    const auth = await validateApiAccess(
      new NextRequest('http://localhost:3000/api/v1/jobs', { headers: { Authorization: `Bearer ${secretKey}` } }),
      0
    );
    expect(auth.authorized).toBe(true);

    // The notification is dispatched in the background; wait for its dead-letter entry.
    await vi.waitFor(async () => {
      const entries = await webhookDispatcher.getDlqEntries(owner.id);
      expect(entries.map((e) => [e.event, e.errorMessage])).toEqual([['key.expiring_soon', 'missing_webhook_secret']]);
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still delivers and signs events when a secret is present', async () => {
    const owner = await createUser('signed');
    const secret = 'whsec_independent_check';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok', { status: 200 }));

    const result = await webhookDispatcher.dispatch(PUBLIC_WEBHOOK_URL, 'job.completed', { jobId: 'job_signed' }, secret, {
      maxRetries: 1,
      initialDelayMs: 1,
      ownerUserId: owner.id,
    });

    expect(result.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0];
    const body = String(init?.body);
    const id = headerOf(init, 'Webhook-Id');
    const timestamp = headerOf(init, 'Webhook-Timestamp');
    // Independent Standard Webhooks v1 signature: base64(HMAC-SHA256(secret, id.timestamp.body)).
    const expected = crypto.createHmac('sha256', secret).update(`${id}.${timestamp}.${body}`).digest('base64');
    expect(headerOf(init, 'Webhook-Signature')).toBe(`v1,${expected}`);
  });
});
