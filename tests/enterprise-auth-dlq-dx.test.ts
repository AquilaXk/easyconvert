import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { validateApiAccess, extractClientIp } from '../src/lib/api-keys/guard';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { userStore } from '../src/lib/auth/user-store';
import { GET as getOpenApiSpec } from '../src/app/api/openapi.json/route';
import { GET as getDlqList, DELETE as clearDlqList } from '../src/app/api/webhooks/dlq/route';
import { GET as getDlqItem, DELETE as deleteDlqItem } from '../src/app/api/webhooks/dlq/[id]/route';
import { POST as replayDlqItem } from '../src/app/api/webhooks/dlq/[id]/replay/route';
import { POST as createKeyRoute, GET as listKeysRoute } from '../src/app/api/keys/route';
import { DELETE as deleteKeyRoute } from '../src/app/api/keys/[id]/route';
import { GET as getKeyUsageRoute } from '../src/app/api/keys/usage/route';
import { EasyConvertClient } from '../sdk/typescript/src/client';
import { createSessionToken } from '../src/lib/auth/session';
import type { ApiKeyScope, WebhookDlqEntry } from '../src/lib/api-keys/types';

describe('Enterprise Auth, Distributed Quotas, DLQ & SDK Parity', () => {
  let testUser: { id: string; email: string; name: string; tier: 'free' | 'pro' | 'enterprise' };
  let sessionCookie: string;

  beforeEach(async () => {
    redisKeyStore.resetStore();
    await webhookDispatcher.clearDlq();
    webhookDispatcher.clearHistory();

    const email = `dev_${Date.now()}_${Math.random().toString(36).substring(7)}@example.com`;
    const created = await userStore.createUser({
      email,
      name: 'Enterprise Test Developer',
      tier: 'pro',
      passwordHash: 'dummy_hash',
      salt: 'dummy_salt',
    });
    testUser = { id: created.id, email: created.email, name: created.name, tier: 'pro' };
    const token = createSessionToken(testUser as any);
    sessionCookie = `easyconvert_session=${token}`;
  });

  afterEach(async () => {
    redisKeyStore.resetStore();
    await webhookDispatcher.clearDlq();
    vi.restoreAllMocks();
  });

  describe('1. Distributed Quota Metering & Guard Migration', () => {
    it('guard.ts strictly references redisKeyStore without local keyStore inconsistency', () => {
      const guardPath = path.resolve(__dirname, '../src/lib/api-keys/guard.ts');
      const guardContent = fs.readFileSync(guardPath, 'utf-8');

      expect(guardContent).not.toMatch(/from\s+['"]\.\/key-store['"]/);
      expect(guardContent).toContain('redisKeyStore');
      expect(guardContent).toContain('redisKeyStore.recordUsage');
      expect(guardContent).toContain('redisKeyStore.getQuotaUsage');
    });

    it('enforces atomic 2-phase quota reservation, commit, and rollback via redisKeyStore', async () => {
      const quotaBefore = await redisKeyStore.getQuotaUsage(testUser.id);
      expect(quotaBefore.remaining).toBe(500);

      // Phase 1: Reserve 10 units
      const res = await redisKeyStore.reserveQuota(testUser.id, 10);
      expect(res.allowed).toBe(true);
      expect(res.reservationId).toBeDefined();
      expect(res.remaining).toBe(490);

      const reservation = redisKeyStore.getReservation(res.reservationId!);
      expect(reservation?.status).toBe('reserved');
      expect(reservation?.units).toBe(10);

      // Phase 2a: Commit reservation
      const committed = await redisKeyStore.commitQuota(res.reservationId!);
      expect(committed).toBe(true);
      expect(redisKeyStore.getReservation(res.reservationId!)).toBeUndefined();

      const quotaAfterCommit = await redisKeyStore.getQuotaUsage(testUser.id);
      expect(quotaAfterCommit.remaining).toBe(490);

      // Phase 2b: Reserve and Rollback
      const res2 = await redisKeyStore.reserveQuota(testUser.id, 5);
      expect(res2.allowed).toBe(true);
      expect(res2.remaining).toBe(485);

      const rolledBack = await redisKeyStore.rollbackQuota(res2.reservationId!);
      expect(rolledBack).toBe(true);

      const quotaAfterRollback = await redisKeyStore.getQuotaUsage(testUser.id);
      expect(quotaAfterRollback.remaining).toBe(490);
    });

    it('enforces quota exhaustion when daily tier limit is exceeded', async () => {
      // Free tier user (limit 25)
      const freeUser = await userStore.createUser({
        email: `free_${Date.now()}@example.com`,
        name: 'Free User',
        tier: 'free',
      });

      const keyResult = await redisKeyStore.generateApiKey(freeUser.id, 'Free Key');
      const req = new Request('https://easyconvert.app/api/v1/convert', {
        headers: { Authorization: `Bearer ${keyResult.secretKey}` },
      });

      // Reserve 25 units
      const fillRes = await redisKeyStore.recordUsage(freeUser.id, 25);
      expect(fillRes.allowed).toBe(true);
      expect(fillRes.remaining).toBe(0);

      // 26th unit must be rejected by validateApiAccess
      const auth = await validateApiAccess(req, 1);
      expect(auth.authorized).toBe(false);
      expect(auth.status).toBe(429);
      expect(auth.error).toContain('Daily conversion quota exceeded');
    });

    it('permits 0-unit read requests (file download, job tracking) even when daily quota is exhausted', async () => {
      const freeUser = await userStore.createUser({
        email: `free_read_${Date.now()}@example.com`,
        name: 'Free User 2',
        tier: 'free',
      });

      const keyResult = await redisKeyStore.generateApiKey(freeUser.id, 'Free Key Exhausted');
      // Exhaust all 25 units
      await redisKeyStore.recordUsage(freeUser.id, 25);
      const usage = await redisKeyStore.getQuotaUsage(freeUser.id);
      expect(usage.remaining).toBe(0);

      // 0-unit request (e.g. storage download / file inspection) must succeed
      const readReq = new Request('https://easyconvert.app/api/account/files', {
        headers: { Authorization: `Bearer ${keyResult.secretKey}` },
      });
      const auth = await validateApiAccess(readReq, 0, 'storage:download');
      expect(auth.authorized).toBe(true);
      expect(auth.user?.id).toBe(freeUser.id);
    });
  });

  describe('2. Webhook Dead Letter Queue (DLQ) & Replay Engine', () => {
    it('captures failed webhook delivery in DLQ after retry attempts are exhausted', async () => {
      // Mock fetch to simulate failing endpoint (HTTP 500)
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response('Internal Webhook Endpoint Error', { status: 500 });
      });

      const targetUrl = 'https://mock.webhook.sink/callback';
      const secret = 'test_webhook_secret_key';
      const payloadData = { jobId: 'job_test_123', status: 'completed' };

      const result = await webhookDispatcher.dispatch(
        targetUrl,
        'job.completed',
        payloadData,
        secret,
        { maxRetries: 3, initialDelayMs: 10, timeoutMs: 500 }
      );

      expect(result.success).toBe(false);
      expect(result.totalAttempts).toBe(3);
      expect(result.finalStatusCode).toBe(500);

      // Verify delivery is preserved in DLQ
      const dlqEntries = await webhookDispatcher.getDlqEntries();
      expect(dlqEntries.length).toBeGreaterThanOrEqual(1);

      const entry = dlqEntries.find((e) => e.targetUrl === targetUrl);
      expect(entry).toBeDefined();
      expect(entry!.status).toBe('failed');
      expect(entry!.event).toBe('job.completed');
      expect(entry!.finalStatusCode).toBe(500);
      expect(entry!.retryCount).toBe(3);
      expect(entry!.secret).toBe(secret);
      expect(entry!.payload).toBeDefined();

      fetchSpy.mockRestore();
    });

    it('successfully replays a dead-lettered webhook with fresh HMAC signature and updates status', async () => {
      // First, simulate failure to populate DLQ
      let attemptsCount = 0;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        attemptsCount++;
        if (attemptsCount <= 3) {
          return new Response('Server Error', { status: 502 });
        }
        // Succeed on replay
        return new Response(JSON.stringify({ received: true }), { status: 200 });
      });

      const targetUrl = 'https://mock.webhook.sink/replay-test';
      const secret = 'replay_secret_456';
      await webhookDispatcher.dispatch(
        targetUrl,
        'conversion.completed',
        { fileId: 'file_999', format: 'pdf' },
        secret,
        { maxRetries: 3, initialDelayMs: 10 }
      );

      const dlqEntries = await webhookDispatcher.getDlqEntries();
      const failedEntry = dlqEntries.find((e) => e.targetUrl === targetUrl);
      expect(failedEntry).toBeDefined();
      expect(failedEntry!.status).toBe('failed');

      // Now replay DLQ entry
      const replayResult = await webhookDispatcher.replayDlq(failedEntry!.id);
      expect(replayResult).not.toBeNull();
      expect(replayResult!.success).toBe(true);

      const updatedEntry = await webhookDispatcher.getDlqEntry(failedEntry!.id);
      expect(updatedEntry).not.toBeNull();
      expect(updatedEntry!.status).toBe('replayed');
      expect(updatedEntry!.replayedAt).toBeDefined();
      expect(updatedEntry!.finalStatusCode).toBe(200);

      fetchSpy.mockRestore();
    });

    it('allows clearing and deleting individual DLQ entries', async () => {
      const mockEntry: WebhookDlqEntry = {
        id: 'dlq_custom_to_delete',
        originalDeliveryId: 'wh_test_del',
        targetUrl: 'https://example.com/webhook',
        event: 'job.failed',
        payload: { error: 'Timeout' },
        secret: 'sec',
        failedAt: Date.now(),
        retryCount: 3,
        status: 'failed',
      };

      await webhookDispatcher.saveToDlq(mockEntry);
      let entry = await webhookDispatcher.getDlqEntry('dlq_custom_to_delete');
      expect(entry).not.toBeNull();

      const deleted = await webhookDispatcher.deleteDlqEntry('dlq_custom_to_delete');
      expect(deleted).toBe(true);

      entry = await webhookDispatcher.getDlqEntry('dlq_custom_to_delete');
      expect(entry).toBeNull();

      await webhookDispatcher.saveToDlq(mockEntry);
      await webhookDispatcher.clearDlq();
      const all = await webhookDispatcher.getDlqEntries();
      expect(all).toHaveLength(0);
    });

    it('failed replay does not duplicate entries in the Dead Letter Queue', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response('Permanent Webhook Failure', { status: 503 });
      });

      const targetUrl = 'https://mock.webhook.sink/duplicate-test';
      const secret = 'dup_sec';
      await webhookDispatcher.dispatch(
        targetUrl,
        'job.failed',
        { reason: 'Crash' },
        secret,
        { maxRetries: 2, initialDelayMs: 5 }
      );

      const dlqBefore = await webhookDispatcher.getDlqEntries();
      const initialEntry = dlqBefore.find((e) => e.targetUrl === targetUrl);
      expect(initialEntry).toBeDefined();
      const countBefore = dlqBefore.length;

      // Replay again (which fails with 503)
      const replayResult = await webhookDispatcher.replayDlq(initialEntry!.id);
      expect(replayResult?.success).toBe(false);

      const dlqAfter = await webhookDispatcher.getDlqEntries();
      expect(dlqAfter).toHaveLength(countBefore); // Must NOT duplicate!

      const updatedEntry = await webhookDispatcher.getDlqEntry(initialEntry!.id);
      expect(updatedEntry?.status).toBe('failed');
      expect(updatedEntry?.retryCount).toBeGreaterThan(2);

      fetchSpy.mockRestore();
    });
  });

  describe('3. Granular RBAC Scopes & Key Expiration Lifecycle', () => {
    it('restricts API access based on granular RBAC scopes', async () => {
      // Key with only convert:read scope
      const readOnlyResult = await redisKeyStore.generateApiKey(testUser.id, 'Read Only Key', {
        scopes: ['convert:read'],
      });

      const writeReq = new Request('https://easyconvert.app/api/v1/convert', {
        headers: { Authorization: `Bearer ${readOnlyResult.secretKey}` },
      });

      // convert:write must be rejected with 403 Forbidden
      const authWrite = await validateApiAccess(writeReq, 0, 'convert:write');
      expect(authWrite.authorized).toBe(false);
      expect(authWrite.status).toBe(403);
      expect(authWrite.error).toContain("API key lacks required scope 'convert:write'");

      // convert:read must be authorized
      const authRead = await validateApiAccess(writeReq, 0, 'convert:read');
      expect(authRead.authorized).toBe(true);
      expect(authRead.apiKey?.scopes).toEqual(['convert:read']);
    });

    it('allows wildcard (*) scope for all permissions', async () => {
      const adminKeyResult = await redisKeyStore.generateApiKey(testUser.id, 'Admin Key', {
        scopes: ['*'],
      });

      const req = new Request('https://easyconvert.app/api/v1/convert', {
        headers: { Authorization: `Bearer ${adminKeyResult.secretKey}` },
      });

      expect((await validateApiAccess(req, 0, 'convert:write')).authorized).toBe(true);
      expect((await validateApiAccess(req, 0, 'convert:read')).authorized).toBe(true);
      expect((await validateApiAccess(req, 0, 'storage:download')).authorized).toBe(true);
    });

    it('rejects expired API keys with 401 Unauthorized', async () => {
      const pastTime = Date.now() - 1000;
      const expiredKeyResult = await redisKeyStore.generateApiKey(testUser.id, 'Expired Key', {
        expiresAt: pastTime,
      });

      const req = new Request('https://easyconvert.app/api/v1/convert', {
        headers: { Authorization: `Bearer ${expiredKeyResult.secretKey}` },
      });

      const auth = await validateApiAccess(req, 0);
      expect(auth.authorized).toBe(false);
      expect(auth.status).toBe(401);
      expect(auth.error).toContain('API key has expired');
    });

    it('permits active API keys with future expiration dates', async () => {
      const futureTime = Date.now() + 30 * 24 * 60 * 60 * 1000;
      const activeKeyResult = await redisKeyStore.generateApiKey(testUser.id, 'Active 30d Key', {
        expiresAt: futureTime,
      });

      const req = new Request('https://easyconvert.app/api/v1/convert', {
        headers: { Authorization: `Bearer ${activeKeyResult.secretKey}` },
      });

      const auth = await validateApiAccess(req, 0);
      expect(auth.authorized).toBe(true);
      expect(auth.apiKey?.expiresAt).toBe(futureTime);
    });

    it('dispatches key.expiring_soon webhook event when key is within 7 days of expiration', async () => {
      const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
      const expiringSoon = Date.now() + threeDaysMs;

      let dispatchedEvent: string | null = null;
      let dispatchedData: any = null;

      vi.spyOn(webhookDispatcher, 'dispatch').mockImplementation(async (_url, event, data) => {
        dispatchedEvent = event;
        dispatchedData = data;
        return {
          id: 'wh_mock',
          url: _url,
          event: event as any,
          success: true,
          totalAttempts: 1,
          durationMs: 10,
          attempts: [],
        };
      });

      const keyResult = await redisKeyStore.generateApiKey(testUser.id, 'Expiring Soon Key', {
        expiresAt: expiringSoon,
        webhookUrl: 'https://webhook.site/test-expiry',
        webhookSecret: 'exp_sec',
      });

      const req = new Request('https://easyconvert.app/api/v1/convert', {
        headers: { Authorization: `Bearer ${keyResult.secretKey}` },
      });

      const auth = await validateApiAccess(req, 0);
      expect(auth.authorized).toBe(true);

      expect(dispatchedEvent).toBe('key.expiring_soon');
      expect(dispatchedData).toBeDefined();
      expect(dispatchedData.keyId).toBe(keyResult.key.id);
      expect(dispatchedData.daysRemaining).toBeLessThanOrEqual(7);
    });

    it('throttles key.expiring_soon webhook notifications to at most once per 24 hours', async () => {
      const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
      const expiringSoon = Date.now() + threeDaysMs;
      let dispatchCount = 0;

      vi.spyOn(webhookDispatcher, 'dispatch').mockImplementation(async (_url, event) => {
        if (event === 'key.expiring_soon') dispatchCount++;
        return {
          id: 'wh_mock',
          url: _url,
          event: event as any,
          success: true,
          totalAttempts: 1,
          durationMs: 5,
          attempts: [],
        };
      });

      const keyResult = await redisKeyStore.generateApiKey(testUser.id, 'Throttled Key', {
        expiresAt: expiringSoon,
        webhookUrl: 'https://webhook.site/throttled',
        webhookSecret: 'sec',
      });

      const req = new Request('https://easyconvert.app/api/v1/convert', {
        headers: { Authorization: `Bearer ${keyResult.secretKey}` },
      });

      // Make 5 consecutive API requests with the expiring key
      for (let i = 0; i < 5; i++) {
        const auth = await validateApiAccess(req, 0);
        expect(auth.authorized).toBe(true);
      }

      // Must have dispatched exactly ONCE due to 24h throttling
      expect(dispatchCount).toBe(1);
    });
  });

  describe('4. REST Management API Endpoints', () => {
    it('creates API key with custom scopes and expiresAt timestamp via /api/keys', async () => {
      const futureTime = Date.now() + 60 * 86400 * 1000;
      const req = new Request('https://easyconvert.app/api/keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: sessionCookie,
        },
        body: JSON.stringify({
          name: 'Microservice Worker Key',
          scopes: ['convert:write', 'storage:download'],
          expiresAt: futureTime,
        }),
      });

      const res = await createKeyRoute(req as any);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.key.name).toBe('Microservice Worker Key');
      expect(json.key.scopes).toEqual(['convert:write', 'storage:download']);
      expect(json.key.expiresAt).toBe(futureTime);
      expect(json.secretKey).toMatch(/^ec_live_/);
    });

    it('interacts with /api/webhooks/dlq and /api/webhooks/dlq/:id endpoints', async () => {
      // Populate DLQ entry
      const testEntry: WebhookDlqEntry = {
        id: 'dlq_route_test_1',
        originalDeliveryId: 'wh_route_1',
        targetUrl: 'https://destination.test/dlq',
        event: 'job.failed',
        payload: { failure: 'Connect ECONNREFUSED' },
        secret: 'sec_route',
        failedAt: Date.now(),
        finalStatusCode: 504,
        errorMessage: 'Gateway Timeout',
        retryCount: 3,
        status: 'failed',
      };
      await webhookDispatcher.saveToDlq(testEntry);

      // GET /api/webhooks/dlq
      const listReq = new Request('https://easyconvert.app/api/webhooks/dlq', {
        headers: { Cookie: sessionCookie },
      });
      const listRes = await getDlqList(listReq as any);
      const listJson = await listRes.json();
      expect(listJson.success).toBe(true);
      expect(listJson.total).toBeGreaterThanOrEqual(1);

      // GET /api/webhooks/dlq/:id
      const itemReq = new Request('https://easyconvert.app/api/webhooks/dlq/dlq_route_test_1', {
        headers: { Cookie: sessionCookie },
      });
      const itemRes = await getDlqItem(itemReq as any, { params: { id: 'dlq_route_test_1' } });
      const itemJson = await itemRes.json();
      expect(itemJson.success).toBe(true);
      expect(itemJson.entry.id).toBe('dlq_route_test_1');

      // DELETE /api/webhooks/dlq/:id
      const delRes = await deleteDlqItem(itemReq as any, { params: { id: 'dlq_route_test_1' } });
      const delJson = await delRes.json();
      expect(delJson.success).toBe(true);

      const notFoundRes = await getDlqItem(itemReq as any, { params: { id: 'dlq_route_test_1' } });
      expect(notFoundRes.status).toBe(404);
    });

    it('authenticates /api/keys, /api/keys/[id], and /api/keys/usage using Bearer API keys', async () => {
      // Create admin key with wildcard scope
      const adminKeyResult = await redisKeyStore.generateApiKey(testUser.id, 'Admin Master Key', {
        scopes: ['*'],
      });

      // GET /api/keys using API Key
      const listReq = new Request('https://easyconvert.app/api/keys', {
        headers: { Authorization: `Bearer ${adminKeyResult.secretKey}` },
      });
      const listRes = await listKeysRoute(listReq as any);
      expect(listRes.status).toBe(200);
      const listJson = await listRes.json();
      expect(listJson.success).toBe(true);
      expect(listJson.keys.length).toBeGreaterThanOrEqual(1);

      // GET /api/keys/usage using API Key
      const usageReq = new Request('https://easyconvert.app/api/keys/usage', {
        headers: { Authorization: `Bearer ${adminKeyResult.secretKey}` },
      });
      const usageRes = await getKeyUsageRoute(usageReq as any);
      expect(usageRes.status).toBe(200);
      const usageJson = await usageRes.json();
      expect(usageJson.success).toBe(true);
      expect(usageJson.usage.tier).toBe('pro');
      expect(usageJson.usage.dailyLimit).toBe(500);

      // POST /api/keys using Admin API Key
      const createReq = new Request('https://easyconvert.app/api/keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminKeyResult.secretKey}`,
        },
        body: JSON.stringify({
          name: 'Child Key Generated via SDK',
          scopes: ['convert:read'],
          expiresAt: Date.now() + 86400000,
        }),
      });
      const createRes = await createKeyRoute(createReq as any);
      expect(createRes.status).toBe(200);
      const createJson = await createRes.json();
      expect(createJson.success).toBe(true);
      expect(createJson.key.name).toBe('Child Key Generated via SDK');

      // DELETE /api/keys/[id] using Admin API Key
      const deleteReq = new Request(`https://easyconvert.app/api/keys/${createJson.key.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminKeyResult.secretKey}` },
      });
      const deleteRes = await deleteKeyRoute(deleteReq as any, { params: Promise.resolve({ id: createJson.key.id }) });
      expect(deleteRes.status).toBe(200);
      const deleteJson = await deleteRes.json();
      expect(deleteJson.success).toBe(true);
    });

    it('rejects key creation and revocation when API key lacks admin wildcard (*) scope', async () => {
      // Key with only convert:read scope
      const restrictedKey = await redisKeyStore.generateApiKey(testUser.id, 'Restricted Worker Key', {
        scopes: ['convert:read'],
      });

      const createReq = new Request('https://easyconvert.app/api/keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${restrictedKey.secretKey}`,
        },
        body: JSON.stringify({ name: 'Privilege Escalation Attempt' }),
      });
      const createRes = await createKeyRoute(createReq as any);
      expect(createRes.status).toBe(403);
      const createJson = await createRes.json();
      expect(createJson.error).toContain('Forbidden');

      const deleteReq = new Request('https://easyconvert.app/api/keys/dummy_id', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${restrictedKey.secretKey}` },
      });
      const deleteRes = await deleteKeyRoute(deleteReq as any, { params: { id: 'dummy_id' } });
      expect(deleteRes.status).toBe(403);
    });

    it('rejects past expiresAt and filters invalid scopes on /api/keys POST', async () => {
      // Past expiresAt
      const pastReq = new Request('https://easyconvert.app/api/keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: sessionCookie,
        },
        body: JSON.stringify({
          name: 'Invalid Past Key',
          expiresAt: Date.now() - 5000,
        }),
      });
      const pastRes = await createKeyRoute(pastReq as any);
      expect(pastRes.status).toBe(400);
      const pastJson = await pastRes.json();
      expect(pastJson.error).toContain('expiresAt must be a timestamp in the future');

      // Invalid scopes filtered out
      const invalidScopeReq = new Request('https://easyconvert.app/api/keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: sessionCookie,
        },
        body: JSON.stringify({
          name: 'Sanitized Scope Key',
          scopes: ['convert:read', 'invalid:scope', 1234],
        }),
      });
      const scopeRes = await createKeyRoute(invalidScopeReq as any);
      expect(scopeRes.status).toBe(200);
      const scopeJson = await scopeRes.json();
      expect(scopeJson.key.scopes).toEqual(['convert:read']);
    });
  });

  describe('5. OpenAPI 3.1.0 Specification & Client SDK Generation', () => {
    it('serves updated OpenAPI 3.1.0 spec with DLQ routes, scopes, and schemas', async () => {
      const res = await getOpenApiSpec();
      expect(res.status).toBe(200);

      const spec = await res.json();
      expect(spec.openapi).toBe('3.1.0');
      expect(spec.paths['/api/webhooks/dlq']).toBeDefined();
      expect(spec.paths['/api/webhooks/dlq/{id}']).toBeDefined();
      expect(spec.paths['/api/webhooks/dlq/{id}/replay']).toBeDefined();
      expect(spec.paths['/api/keys/{id}']).toBeDefined();
      expect(spec.paths['/api/keys/usage']).toBeDefined();
      expect(spec.components.schemas.WebhookDlqEntry).toBeDefined();
      expect(spec.components.schemas.QuotaUsage).toBeDefined();

      // Verify security scope references
      const convertPost = spec.paths['/api/v1/convert'].post;
      expect(convertPost.security).toEqual([
        { ApiKeyAuth: ['convert:write'] },
        { BearerAuth: ['convert:write'] },
      ]);
    });

    it('verifies generated TypeScript SDK and Python SDK client structures', () => {
      const tsClientPath = path.resolve(__dirname, '../sdk/typescript/src/client.ts');
      const pyClientPath = path.resolve(__dirname, '../sdk/python/easyconvert/client.py');

      expect(fs.existsSync(tsClientPath)).toBe(true);
      expect(fs.existsSync(pyClientPath)).toBe(true);

      const tsContent = fs.readFileSync(tsClientPath, 'utf-8');
      expect(tsContent).toContain('export class EasyConvertClient');
      expect(tsContent).toContain('convert(');
      expect(tsContent).toContain('createJob(');
      expect(tsContent).toContain('getDlqEntries(');
      expect(tsContent).toContain('replayDlq(');
      expect(tsContent).toContain('getQuotaUsage(');

      const pyContent = fs.readFileSync(pyClientPath, 'utf-8');
      expect(pyContent).toContain('class EasyConvertClient');
      expect(pyContent).toContain('def convert(');
      expect(pyContent).toContain('def create_job(');
      expect(pyContent).toContain('def replay_dlq(');
      expect(pyContent).toContain('def get_quota_usage(');
    });

    it('verifies TypeScript SDK client methods for quota and key management', async () => {
      const client = new EasyConvertClient({
        apiKey: 'ec_live_test_dummy_key_1234567890',
        baseUrl: 'https://api.test',
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        const u = url.toString();
        if (u.includes('/api/keys/usage')) {
          return new Response(JSON.stringify({
            success: true,
            usage: { tier: 'pro', dailyLimit: 500, usedToday: 10, remaining: 490, resetAt: 12345678 },
          }));
        }
        if (u.includes('/api/keys')) {
          return new Response(JSON.stringify({
            success: true,
            keys: [{ id: 'key_1', name: 'Test Key' }],
          }));
        }
        return new Response('Not found', { status: 404 });
      });

      const quota = await client.getQuotaUsage();
      expect(quota.tier).toBe('pro');
      expect(quota.remaining).toBe(490);

      const keys = await client.listApiKeys();
      expect(keys).toHaveLength(1);
      expect(keys[0].id).toBe('key_1');

      fetchSpy.mockRestore();
    });
  });
});
