import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { NextRequest } from 'next/server';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { validateApiAccess } from '../src/lib/api-keys/guard';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { attachJobLifecycleListeners } from '../src/lib/queue/conversion-queue';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import { GET as listDlqRoute, DELETE as clearDlqRoute } from '../src/app/api/webhooks/dlq/route';
import { GET as getDlqItemRoute, DELETE as deleteDlqItemRoute } from '../src/app/api/webhooks/dlq/[id]/route';
import { POST as replayDlqRoute } from '../src/app/api/webhooks/dlq/[id]/replay/route';
import type { User } from '../src/lib/auth/types';
import type { WebhookDlqEntry } from '../src/lib/api-keys/types';

const BASE_URL = 'http://localhost:3000';
// Public IPv4 literal: passes the SSRF pre-flight without a DNS round trip; fetch itself is mocked.
const PUBLIC_WEBHOOK_URL = 'https://93.184.215.14/hooks/easyconvert';

async function createUser(label: string): Promise<User> {
  const email = `${label}_${Date.now()}_${Math.random().toString(36).slice(2)}@dlq.test`;
  return userStore.sanitizeUser(await userStore.createUser({ email, name: label, tier: 'pro' }));
}

function sessionRequest(user: User, pathName: string, method = 'GET'): NextRequest {
  return new NextRequest(`${BASE_URL}${pathName}`, {
    method,
    headers: { Cookie: `easyconvert_session=${createSessionToken(user)}` },
  });
}

function keyRequest(secretKey: string, pathName: string, method = 'GET'): NextRequest {
  return new NextRequest(`${BASE_URL}${pathName}`, {
    method,
    headers: { Authorization: `Bearer ${secretKey}` },
  });
}

function dlqEntry(id: string, ownerUserId: string | undefined): WebhookDlqEntry {
  return {
    id,
    originalDeliveryId: `wh_${id}`,
    targetUrl: PUBLIC_WEBHOOK_URL,
    event: 'job.failed',
    payload: { jobId: id },
    secret: `secret_${id}`,
    failedAt: Date.now(),
    finalStatusCode: 500,
    errorMessage: 'Internal Server Error',
    retryCount: 3,
    status: 'failed',
    ownerUserId,
  };
}

describe('Webhook DLQ owner scoping (#242)', () => {
  let alice: User;
  let bob: User;
  let aliceEntryId: string;
  let bobEntryId: string;
  let legacyEntryId: string;

  beforeEach(async () => {
    alice = await createUser('dlq_alice');
    bob = await createUser('dlq_bob');
    const suffix = Math.random().toString(36).slice(2);
    aliceEntryId = `dlq_alice_${suffix}`;
    bobEntryId = `dlq_bob_${suffix}`;
    legacyEntryId = `dlq_legacy_${suffix}`;
    await webhookDispatcher.saveToDlq(dlqEntry(aliceEntryId, alice.id));
    await webhookDispatcher.saveToDlq(dlqEntry(bobEntryId, bob.id));
    await webhookDispatcher.saveToDlq(dlqEntry(legacyEntryId, undefined));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await webhookDispatcher.clearDlq(alice.id);
    await webhookDispatcher.clearDlq(bob.id);
  });

  describe('dispatcher API', () => {
    it('lists and reads only the owner entries; legacy entries are visible to nobody', async () => {
      const aliceIds = (await webhookDispatcher.getDlqEntries(alice.id)).map((e) => e.id);
      expect(aliceIds).toContain(aliceEntryId);
      expect(aliceIds).not.toContain(bobEntryId);
      expect(aliceIds).not.toContain(legacyEntryId);

      expect((await webhookDispatcher.getDlqEntry(aliceEntryId, alice.id))?.ownerUserId).toBe(alice.id);
      expect(await webhookDispatcher.getDlqEntry(aliceEntryId, bob.id)).toBeNull();
      expect(await webhookDispatcher.getDlqEntry(legacyEntryId, alice.id)).toBeNull();
      expect(await webhookDispatcher.getDlqEntry(aliceEntryId, '')).toBeNull();
    });

    it('delete, clear, and replay never touch another owner entries', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok', { status: 200 }));

      expect(await webhookDispatcher.deleteDlqEntry(aliceEntryId, bob.id)).toBe(false);
      expect(await webhookDispatcher.replayDlq(aliceEntryId, bob.id)).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();

      await webhookDispatcher.clearDlq(bob.id);
      expect((await webhookDispatcher.getDlqEntries(bob.id)).map((e) => e.id)).toEqual([]);
      expect((await webhookDispatcher.getDlqEntry(aliceEntryId, alice.id))?.status).toBe('failed');
    });

    it('records the owner on entries created by a failed dispatch', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('down', { status: 503 }));
      const result = await webhookDispatcher.dispatch(PUBLIC_WEBHOOK_URL, 'job.failed', { jobId: 'j1' }, 'sec', {
        maxRetries: 1,
        initialDelayMs: 1,
        ownerUserId: alice.id,
        ownerKeyId: 'key_alice_1',
      });
      expect(result.success).toBe(false);

      const stored = await webhookDispatcher.getDlqEntry(`dlq_${result.id}`, alice.id);
      expect(stored?.ownerUserId).toBe(alice.id);
      expect(stored?.ownerKeyId).toBe('key_alice_1');
      expect(stored?.finalStatusCode).toBe(503);
      expect(await webhookDispatcher.getDlqEntry(`dlq_${result.id}`, bob.id)).toBeNull();
    });
  });

  describe('owner capture at the dispatch call sites', () => {
    it('passes the key owner and key id for key.expiring_soon notifications', async () => {
      const dispatchSpy = vi.spyOn(webhookDispatcher, 'dispatch').mockResolvedValue({
        id: 'wh_spy', url: PUBLIC_WEBHOOK_URL, event: 'key.expiring_soon', success: true, totalAttempts: 1, durationMs: 1, attempts: [],
      });
      const { key, secretKey } = await redisKeyStore.generateApiKey(alice.id, 'Expiring', {
        expiresAt: Date.now() + 2 * 24 * 60 * 60 * 1000,
        webhookUrl: PUBLIC_WEBHOOK_URL,
        webhookSecret: 'exp',
      });

      const auth = await validateApiAccess(keyRequest(secretKey, '/api/v1/jobs'), 0);
      expect(auth.authorized).toBe(true);
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      const [, event, , , options] = dispatchSpy.mock.calls[0];
      expect(event).toBe('key.expiring_soon');
      expect(options).toMatchObject({ ownerUserId: alice.id, ownerKeyId: key.id });
    });

    it('passes the job owner for queue lifecycle webhooks', async () => {
      const dispatchSpy = vi.spyOn(webhookDispatcher, 'dispatch').mockResolvedValue({
        id: 'wh_spy', url: PUBLIC_WEBHOOK_URL, event: 'job.failed', success: true, totalAttempts: 1, durationMs: 1, attempts: [],
      });
      const fakeWorker = new EventEmitter();
      attachJobLifecycleListeners(fakeWorker as unknown as Parameters<typeof attachJobLifecycleListeners>[0]);

      const job = {
        id: 'job_owner_test',
        data: { userId: bob.id, webhookUrl: PUBLIC_WEBHOOK_URL, webhookSecret: 'job-sec', originalFilename: 'a.csv' },
      };
      fakeWorker.emit('failed', job, new Error('boom'));
      fakeWorker.emit('completed', job, { jobId: 'job_owner_test', status: 'completed' });

      await vi.waitFor(() => expect(dispatchSpy).toHaveBeenCalledTimes(2));
      const events = dispatchSpy.mock.calls.map((call) => call[1]).sort();
      expect(events).toEqual(['job.completed', 'job.failed']);
      for (const call of dispatchSpy.mock.calls) {
        expect(call[4]).toMatchObject({ ownerUserId: bob.id });
      }
    });
  });

  describe('routes', () => {
    it('GET /api/webhooks/dlq returns only the caller entries (session and API key)', async () => {
      const sessionRes = await listDlqRoute(sessionRequest(bob, '/api/webhooks/dlq'));
      expect(sessionRes.status).toBe(200);
      const sessionIds = (await sessionRes.json()).entries.map((e: WebhookDlqEntry) => e.id);
      expect(sessionIds).toContain(bobEntryId);
      expect(sessionIds).not.toContain(aliceEntryId);
      expect(sessionIds).not.toContain(legacyEntryId);

      const bobKey = await redisKeyStore.generateApiKey(bob.id, 'Bob admin', { scopes: ['*'] });
      const keyRes = await listDlqRoute(keyRequest(bobKey.secretKey, '/api/webhooks/dlq'));
      expect(keyRes.status).toBe(200);
      const keyIds = (await keyRes.json()).entries.map((e: WebhookDlqEntry) => e.id);
      expect(keyIds).toContain(bobEntryId);
      expect(keyIds).not.toContain(aliceEntryId);
    });

    it('returns 404 (not 403) when another owner reads, deletes, or replays an entry', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok', { status: 200 }));
      const itemPath = `/api/webhooks/dlq/${aliceEntryId}`;
      const params = { params: { id: aliceEntryId } };

      expect((await getDlqItemRoute(sessionRequest(bob, itemPath), params)).status).toBe(404);
      expect((await deleteDlqItemRoute(sessionRequest(bob, itemPath, 'DELETE'), params)).status).toBe(404);
      expect((await replayDlqRoute(sessionRequest(bob, `${itemPath}/replay`, 'POST'), params)).status).toBe(404);

      const bobKey = await redisKeyStore.generateApiKey(bob.id, 'Bob admin', { scopes: ['*'] });
      expect((await replayDlqRoute(keyRequest(bobKey.secretKey, `${itemPath}/replay`, 'POST'), params)).status).toBe(404);
      expect((await deleteDlqItemRoute(keyRequest(bobKey.secretKey, itemPath, 'DELETE'), params)).status).toBe(404);
      expect(fetchSpy).not.toHaveBeenCalled();

      const clearRes = await clearDlqRoute(sessionRequest(bob, '/api/webhooks/dlq', 'DELETE'));
      expect(clearRes.status).toBe(200);

      const aliceView = await getDlqItemRoute(sessionRequest(alice, itemPath), params);
      expect(aliceView.status).toBe(200);
      expect((await aliceView.json()).entry.status).toBe('failed');
    });

    it('lets the owner replay and delete their own entry', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('ok', { status: 200 }));
      const itemPath = `/api/webhooks/dlq/${aliceEntryId}`;
      const params = { params: { id: aliceEntryId } };

      const replayRes = await replayDlqRoute(sessionRequest(alice, `${itemPath}/replay`, 'POST'), params);
      expect(replayRes.status).toBe(200);
      const replayBody = await replayRes.json();
      expect(replayBody.success).toBe(true);
      expect(replayBody.statusCode).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(String(fetchSpy.mock.calls[0][0])).toBe(PUBLIC_WEBHOOK_URL);

      const deleteRes = await deleteDlqItemRoute(sessionRequest(alice, itemPath, 'DELETE'), params);
      expect(deleteRes.status).toBe(200);
      expect(await webhookDispatcher.getDlqEntry(aliceEntryId, alice.id)).toBeNull();
    });
  });
});
