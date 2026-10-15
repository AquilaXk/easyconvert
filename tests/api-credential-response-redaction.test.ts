import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import { GET as listKeysRoute, POST as createKeyRoute } from '../src/app/api/keys/route';
import { GET as listDlqRoute } from '../src/app/api/webhooks/dlq/route';
import { GET as getDlqItemRoute } from '../src/app/api/webhooks/dlq/[id]/route';
import type { User } from '../src/lib/auth/types';

const BASE_URL = 'http://localhost:3000';
const WEBHOOK_SECRET = 'whsec_redaction_probe_7f3a';
const PUBLIC_WEBHOOK_URL = 'https://93.184.215.14/hooks/easyconvert';

async function createUser(label: string): Promise<User> {
  const email = `${label}_${Date.now()}_${Math.random().toString(36).slice(2)}@redact.test`;
  return userStore.sanitizeUser(await userStore.createUser({ email, name: label, tier: 'pro' }));
}

function sessionRequest(user: User, pathName: string, init: { method?: string; body?: string } = {}): NextRequest {
  const headers: Record<string, string> = { Cookie: `easyconvert_session=${createSessionToken(user)}` };
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  return new NextRequest(`${BASE_URL}${pathName}`, { method: init.method ?? 'GET', headers, body: init.body });
}

/** Collects every property name in a JSON value, at any depth. */
function collectKeys(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, found);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      found.add(key);
      collectKeys(child, found);
    }
  }
  return found;
}

describe('Credential redaction in API responses (#242)', () => {
  let owner: User;

  beforeEach(async () => {
    owner = await createUser('redact_owner');
  });

  afterEach(async () => {
    await webhookDispatcher.clearDlq(owner.id);
  });

  it('never returns stored key hashes or webhook secrets when listing keys', async () => {
    await redisKeyStore.generateApiKey(owner.id, 'with webhook', {
      webhookUrl: PUBLIC_WEBHOOK_URL,
      webhookSecret: WEBHOOK_SECRET,
    });

    const res = await listKeysRoute(sessionRequest(owner, '/api/keys'));
    const text = await res.text();
    const body = JSON.parse(text);

    expect(res.status).toBe(200);
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0].name).toBe('with webhook');
    expect(body.keys[0].hasWebhookSecret).toBe(true);
    const fields = collectKeys(body);
    expect(fields.has('keyHash')).toBe(false);
    expect(fields.has('webhookSecret')).toBe(false);
    expect(text).not.toContain(WEBHOOK_SECRET);
  });

  it('returns the one-time secret but not the stored hash when creating a key', async () => {
    const res = await createKeyRoute(
      sessionRequest(owner, '/api/keys', {
        method: 'POST',
        body: JSON.stringify({ name: 'created', webhookUrl: PUBLIC_WEBHOOK_URL, webhookSecret: WEBHOOK_SECRET }),
      })
    );
    const text = await res.text();
    const body = JSON.parse(text);

    expect(res.status).toBe(200);
    expect(body.secretKey).toMatch(/^ec_live_[0-9a-f]{48}$/);
    expect(body.key.hasWebhookSecret).toBe(true);
    const fields = collectKeys(body.key);
    expect(fields.has('keyHash')).toBe(false);
    expect(fields.has('webhookSecret')).toBe(false);
    expect(text).not.toContain(WEBHOOK_SECRET);
  });

  it('never returns the webhook signing secret from DLQ list or item responses', async () => {
    const entryId = `dlq_redact_${Math.random().toString(36).slice(2)}`;
    await webhookDispatcher.saveToDlq({
      id: entryId,
      originalDeliveryId: `wh_${entryId}`,
      targetUrl: PUBLIC_WEBHOOK_URL,
      event: 'job.failed',
      payload: { jobId: entryId },
      secret: WEBHOOK_SECRET,
      failedAt: Date.now(),
      finalStatusCode: 500,
      errorMessage: 'Internal Server Error',
      retryCount: 3,
      status: 'failed',
      ownerUserId: owner.id,
    });

    const listRes = await listDlqRoute(sessionRequest(owner, '/api/webhooks/dlq'));
    const listText = await listRes.text();
    const listBody = JSON.parse(listText);
    expect(listRes.status).toBe(200);
    expect(listBody.entries.map((e: { id: string }) => e.id)).toEqual([entryId]);
    expect(collectKeys(listBody).has('secret')).toBe(false);
    expect(listText).not.toContain(WEBHOOK_SECRET);

    const itemRes = await getDlqItemRoute(sessionRequest(owner, `/api/webhooks/dlq/${entryId}`), {
      params: Promise.resolve({ id: entryId }),
    });
    const itemText = await itemRes.text();
    const itemBody = JSON.parse(itemText);
    expect(itemRes.status).toBe(200);
    expect(itemBody.entry.id).toBe(entryId);
    expect(itemBody.entry.targetUrl).toBe(PUBLIC_WEBHOOK_URL);
    expect(collectKeys(itemBody).has('secret')).toBe(false);
    expect(itemText).not.toContain(WEBHOOK_SECRET);
  });
});
