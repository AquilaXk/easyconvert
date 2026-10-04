import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import {
  WebhookDispatcher,
  webhookDispatcher,
  classifyWebhookStatus,
  computeRetryDelay,
  WEBHOOK_RETRY_SCHEDULE_MS,
  type WebhookEvent,
} from '../src/lib/api-keys/webhook-dispatcher';
import {
  InMemoryWebhookSecretStore,
  getWebhookSecretStore,
  setWebhookSecretStore,
  encryptWebhookSecret,
  decryptWebhookSecret,
  getWebhookKek,
  generateWebhookSecret,
} from '../src/lib/api-keys/webhook-secret-store';
import { POST as rotateSecretRoute } from '../src/app/api/v1/webhooks/secrets/rotate/route';
import { userStore } from '../src/lib/auth/user-store';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import type { User } from '../src/lib/auth/types';

describe('WP-12 Enterprise Webhooks: Rotating Secrets, Multi-Signature Headers & Durable Retries', () => {
  const TARGET_URL = 'https://example.com/webhook-receiver';
  let receivedRequests: Array<{
    headers: Record<string, string>;
    body: string;
  }> = [];
  let testUser: User;
  let testApiKey: string;
  let testKeyId: string;
  let originalKek: string | undefined;

  beforeEach(async () => {
    receivedRequests = [];
    originalKek = process.env.WEBHOOK_SECRET_KEK;
    process.env.WEBHOOK_SECRET_KEK = 'test-enterprise-kek-32-byte-secret-key-1234';

    // Fresh in-memory secret store for isolated test execution
    setWebhookSecretStore(new InMemoryWebhookSecretStore());

    testUser = await userStore.createUser({
      name: 'Webhook Enterprise User',
      email: `webhook_ent_${Date.now()}_${Math.random().toString(36).substring(7)}@test.com`,
      tier: 'pro',
    });

    const keyResult = await redisKeyStore.generateApiKey(testUser.id, 'Webhook Test Key', {
      scopes: ['convert:write', 'convert:read'],
    });
    testApiKey = keyResult.secretKey;
    testKeyId = keyResult.key.id;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalKek !== undefined) {
      process.env.WEBHOOK_SECRET_KEK = originalKek;
    } else {
      delete process.env.WEBHOOK_SECRET_KEK;
    }
    setWebhookSecretStore(null);
    await webhookDispatcher.clearDlq(testUser.id);
  });

  function mockFetchWithHandler(
    handler: (url: string, init?: RequestInit) => Response | Promise<Response>
  ) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init: any) => {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      const rawHeaders = init?.headers || {};
      const headers: Record<string, string> = {};
      if (rawHeaders instanceof Headers) {
        rawHeaders.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(rawHeaders)) {
        for (const [k, v] of rawHeaders) {
          headers[k.toLowerCase()] = v;
        }
      } else {
        for (const [k, v] of Object.entries(rawHeaders)) {
          headers[k.toLowerCase()] = String(v);
        }
      }

      const body = typeof init?.body === 'string' ? init.body : '';
      receivedRequests.push({ headers, body });
      return handler(url, init);
    });
  }

  // Independent differential oracle: computes HMAC independently in test without calling production code
  function independentStandardHmac(deliveryId: string, timestamp: number, body: string, secret: string): string {
    const stringToSign = `${deliveryId}.${timestamp}.${body}`;
    return crypto.createHmac('sha256', secret).update(stringToSign).digest('base64');
  }

  function independentLegacyHmac(timestamp: number, body: string, secret: string): string {
    const stringToSign = `${timestamp}.${body}`;
    return crypto.createHmac('sha256', secret).update(stringToSign).digest('hex');
  }

  describe('1. Envelope Encryption of Secrets (AES-256-GCM with WEBHOOK_SECRET_KEK)', () => {
    it('generates random enterprise webhook secrets prefixed with whsec_ and 64 hex chars', () => {
      const secret = generateWebhookSecret();
      expect(secret).toMatch(/^whsec_[a-f0-9]{64}$/);
    });

    it('encrypts secret with AES-256-GCM envelope prefix enc:wh:v1:', () => {
      const plainSecret = 'whsec_fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
      const cipherText = encryptWebhookSecret(plainSecret);

      expect(cipherText.startsWith('enc:wh:v1:')).toBe(true);
      const parts = cipherText.replace('enc:wh:v1:', '').split(':');
      expect(parts).toHaveLength(3); // iv, tag, ciphertext
      expect(Buffer.from(parts[0], 'base64')).toHaveLength(12); // 96-bit IV
      expect(Buffer.from(parts[1], 'base64')).toHaveLength(16); // 128-bit GCM Auth Tag
    });

    it('accurately decrypts encrypted secret and fails closed upon tampering with ciphertext or auth tag', () => {
      const plainSecret = 'whsec_11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff';
      const cipherText = encryptWebhookSecret(plainSecret);
      const decrypted = decryptWebhookSecret(cipherText);
      expect(decrypted).toBe(plainSecret);

      // Tampered tag must fail closed
      const parts = cipherText.replace('enc:wh:v1:', '').split(':');
      const tamperedTag = Buffer.from(parts[1], 'base64');
      tamperedTag[0] ^= 0xff; // flip bits
      const tamperedCipher = `enc:wh:v1:${parts[0]}:${tamperedTag.toString('base64')}:${parts[2]}`;

      expect(() => decryptWebhookSecret(tamperedCipher)).toThrow();
    });

    it('fails closed in production if WEBHOOK_SECRET_KEK is missing', () => {
      delete process.env.WEBHOOK_SECRET_KEK;
      const originalEnv = process.env.NODE_ENV;
      try {
        (process.env as any).NODE_ENV = 'production';
        expect(() => getWebhookKek()).toThrow(/WEBHOOK_SECRET_KEK environment variable is required in production/);
      } finally {
        (process.env as any).NODE_ENV = originalEnv;
        process.env.WEBHOOK_SECRET_KEK = 'test-enterprise-kek-32-byte-secret-key-1234';
      }
    });
  });

  describe('2. Multi-Signature Emission & Independent Differential Oracle', () => {
    it('emits standard Webhook-Id, Webhook-Timestamp, Webhook-Signature and legacy headers matching independent HMAC oracle', async () => {
      mockFetchWithHandler(() => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));

      const secret = 'whsec_primary_secret_0123456789abcdef0123456789abcdef0123456789abcdef01';
      const event: WebhookEvent = 'conversion.completed';
      const payloadData = { jobId: 'job_sample_42', format: 'pdf', bytes: 1048576 };

      const result = await webhookDispatcher.dispatch(TARGET_URL, event, payloadData, secret, {
        ownerUserId: testUser.id,
      });

      expect(result.success).toBe(true);
      expect(result.totalAttempts).toBe(1);
      expect(receivedRequests).toHaveLength(1);

      const req = receivedRequests[0];
      const deliveryId = req.headers['webhook-id'] as string;
      const timestampStr = req.headers['webhook-timestamp'] as string;
      const signatureHeader = req.headers['webhook-signature'] as string;

      expect(deliveryId).toBe(result.id);
      expect(typeof deliveryId).toBe('string');
      expect(deliveryId.startsWith('wh_')).toBe(true);

      const timestamp = parseInt(timestampStr, 10);
      expect(Number.isFinite(timestamp)).toBe(true);

      // Verify independent differential HMAC oracle for standard Webhook-Signature
      const expectedStandardHmac = independentStandardHmac(deliveryId, timestamp, req.body, secret);
      expect(signatureHeader).toBe(`v1,${expectedStandardHmac}`);

      // Verify legacy backward-compatible headers
      const legacyDelivery = req.headers['x-easyconvert-delivery'] as string;
      const legacyTimestamp = req.headers['x-easyconvert-timestamp'] as string;
      const legacySignature = req.headers['x-easyconvert-signature'] as string;
      const legacySignatureSha256 = req.headers['x-signature-sha256'] as string;

      expect(legacyDelivery).toBe(deliveryId);
      expect(legacyTimestamp).toBe(timestampStr);

      const expectedLegacyHmac = independentLegacyHmac(timestamp, req.body, secret);
      expect(legacySignature).toBe(`sha256=${expectedLegacyHmac}`);
      expect(legacySignatureSha256).toBe(expectedLegacyHmac);

      // Verify dispatcher static verification helpers
      expect(
        WebhookDispatcher.verifyStandardSignature(
          deliveryId,
          timestamp,
          req.body,
          signatureHeader,
          secret
        )
      ).toBe(true);

      expect(
        WebhookDispatcher.verifyStandardSignature(
          deliveryId,
          timestamp,
          req.body,
          signatureHeader,
          'wrong-secret'
        )
      ).toBe(false);
    });
  });

  describe('3. Dual-Signature Emission During Active Rotation Grace Period', () => {
    it('emits both primary and previous signatures during grace period and transitions to single signature upon expiration', async () => {
      mockFetchWithHandler(() => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));

      const store = getWebhookSecretStore();
      const initialSecret = generateWebhookSecret();
      await store.setPrimarySecret(testUser.id, 'endpoint-alpha', initialSecret);

      // Rotate secret with 3600 seconds grace period
      const rotation = await store.rotateSecret(testUser.id, 'endpoint-alpha', 3600);
      const newSecret = rotation.newSecret;
      expect(newSecret).not.toBe(initialSecret);
      expect(rotation.previousExpiresAt).toBeDefined();

      const event: WebhookEvent = 'job.completed';
      const payloadData = { jobId: 'job_rotation_1', pages: 12 };

      // Dispatch webhook during active grace period
      const result = await webhookDispatcher.dispatch(TARGET_URL, event, payloadData, newSecret, {
        ownerUserId: testUser.id,
        targetId: 'endpoint-alpha',
      });

      expect(result.success).toBe(true);
      expect(receivedRequests).toHaveLength(1);

      const req = receivedRequests[0];
      const deliveryId = req.headers['webhook-id'] as string;
      const timestamp = parseInt(req.headers['webhook-timestamp'] as string, 10);
      const signatureHeader = req.headers['webhook-signature'] as string;

      // Independent differential HMAC oracle for BOTH primary and previous
      const expectedPrimaryHmac = independentStandardHmac(deliveryId, timestamp, req.body, newSecret);
      const expectedPreviousHmac = independentStandardHmac(deliveryId, timestamp, req.body, initialSecret);

      // Webhook-Signature must contain BOTH signatures separated by space: v1,<primary> v1,<previous>
      expect(signatureHeader).toBe(`v1,${expectedPrimaryHmac} v1,${expectedPreviousHmac}`);

      // Verify that recipient can verify using EITHER primary OR previous secret
      expect(
        WebhookDispatcher.verifyStandardSignature(
          deliveryId,
          timestamp,
          req.body,
          signatureHeader,
          newSecret
        )
      ).toBe(true);

      expect(
        WebhookDispatcher.verifyStandardSignature(
          deliveryId,
          timestamp,
          req.body,
          signatureHeader,
          initialSecret
        )
      ).toBe(true);

      expect(
        WebhookDispatcher.verifyStandardSignatureWithDualSecrets(
          deliveryId,
          timestamp,
          req.body,
          signatureHeader,
          newSecret,
          initialSecret
        )
      ).toBe(true);

      // Now simulate expired grace period
      receivedRequests.length = 0;
      await webhookDispatcher.dispatch(TARGET_URL, event, payloadData, newSecret, {
        ownerUserId: testUser.id,
        targetId: 'endpoint-alpha',
        previousSecret: initialSecret,
        previousExpiresAt: Date.now() - 5000, // Expired 5 seconds ago
      });

      expect(receivedRequests).toHaveLength(1);
      const expiredReq = receivedRequests[0];
      const expiredSigHeader = expiredReq.headers['webhook-signature'] as string;

      // Expired previous signature must be omitted, emitting ONLY the primary signature
      expect(expiredSigHeader).toBe(`v1,${independentStandardHmac(expiredReq.headers['webhook-id'] as string, parseInt(expiredReq.headers['webhook-timestamp'] as string, 10), expiredReq.body, newSecret)}`);
      expect(expiredSigHeader).not.toContain(expectedPreviousHmac);
    });
  });

  describe('4. Status Classification & Fail-Closed DLQ Rules', () => {
    it('classifies 2xx, 410, 4xx, 5xx, and network errors correctly', () => {
      expect(classifyWebhookStatus(200)).toBe('success');
      expect(classifyWebhookStatus(204)).toBe('success');
      expect(classifyWebhookStatus(410)).toBe('deactivate');
      expect(classifyWebhookStatus(400)).toBe('dlq_immediate');
      expect(classifyWebhookStatus(401)).toBe('dlq_immediate');
      expect(classifyWebhookStatus(403)).toBe('dlq_immediate');
      expect(classifyWebhookStatus(404)).toBe('dlq_immediate');
      expect(classifyWebhookStatus(422)).toBe('dlq_immediate');
      expect(classifyWebhookStatus(408)).toBe('retry');
      expect(classifyWebhookStatus(429)).toBe('retry');
      expect(classifyWebhookStatus(500)).toBe('retry');
      expect(classifyWebhookStatus(502)).toBe('retry');
      expect(classifyWebhookStatus(503)).toBe('retry');
      expect(classifyWebhookStatus(undefined, 'ECONNRESET')).toBe('retry');
      expect(classifyWebhookStatus(undefined, 'SSRF blocked: host is restricted')).toBe('dlq_immediate');
    });

    it('immediately halts and does NOT populate DLQ on HTTP 410 Gone (permanent deactivation)', async () => {
      mockFetchWithHandler(() => new Response(JSON.stringify({ error: 'Endpoint permanently deleted' }), { status: 410 }));

      const result = await webhookDispatcher.dispatch(
        TARGET_URL,
        'job.failed',
        { reason: 'test' },
        'secret_123',
        {
          maxRetries: 3,
          initialDelayMs: 5,
          ownerUserId: testUser.id,
        }
      );

      expect(result.success).toBe(false);
      expect(result.finalStatusCode).toBe(410);
      expect(result.totalAttempts).toBe(1); // Aborts immediately without retrying

      // Must NOT save to DLQ when permanently deactivated
      const dlqEntries = await webhookDispatcher.getDlqEntries(testUser.id);
      expect(dlqEntries).toHaveLength(0);
    });

    it('immediately transfers to DLQ without wasteful retries on HTTP 400 Bad Request', async () => {
      mockFetchWithHandler(() => new Response(JSON.stringify({ error: 'Client rejected schema' }), { status: 400 }));

      const result = await webhookDispatcher.dispatch(
        TARGET_URL,
        'job.failed',
        { test: 'data' },
        'secret_123',
        {
          maxRetries: 3,
          initialDelayMs: 5,
          ownerUserId: testUser.id,
        }
      );

      expect(result.success).toBe(false);
      expect(result.finalStatusCode).toBe(400);
      expect(result.totalAttempts).toBe(1); // Fast-fail without retrying 400

      // Immediately stored in DLQ
      const dlqEntries = await webhookDispatcher.getDlqEntries(testUser.id);
      expect(dlqEntries).toHaveLength(1);
      expect(dlqEntries[0].finalStatusCode).toBe(400);
      expect(dlqEntries[0].status).toBe('failed');
      expect(dlqEntries[0].originalDeliveryId).toBe(result.id);
    });

    it('honors HTTP Retry-After header and full-jitter calculation', () => {
      // Numeric seconds in Retry-After
      const headersSeconds = new Headers({ 'retry-after': '12' });
      const delaySeconds = computeRetryDelay(1, headersSeconds);
      expect(delaySeconds).toBe(12000);

      // Clamped to 1000ms minimum and 86400000ms maximum
      const headersZero = new Headers({ 'retry-after': '0' });
      expect(computeRetryDelay(1, headersZero)).toBe(1000);

      const headersHuge = new Headers({ 'retry-after': '99999999' });
      expect(computeRetryDelay(1, headersHuge)).toBe(86400000);

      // Default exponential schedule intervals with random jitter
      for (let attempt = 1; attempt <= 6; attempt++) {
        const delay = computeRetryDelay(attempt);
        const maxInterval = WEBHOOK_RETRY_SCHEDULE_MS[attempt - 1];
        expect(delay).toBeGreaterThanOrEqual(1000);
        expect(delay).toBeLessThanOrEqual(maxInterval);
      }
    });

    it('preserves original deliveryId upon manual DLQ replay to ensure recipient deduplication', async () => {
      let requestCount = 0;
      mockFetchWithHandler(() => {
        requestCount++;
        if (requestCount === 1) {
          return new Response(JSON.stringify({ error: 'Temporary server failure' }), { status: 500 });
        }
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      });

      const initialResult = await webhookDispatcher.dispatch(
        TARGET_URL,
        'job.completed',
        { invoiceId: 'inv_12345' },
        'secret_replay_test',
        {
          maxRetries: 1,
          ownerUserId: testUser.id,
        }
      );

      expect(initialResult.success).toBe(false);
      const dlqEntries = await webhookDispatcher.getDlqEntries(testUser.id);
      expect(dlqEntries).toHaveLength(1);
      const dlqItem = dlqEntries[0];

      // Replay the DLQ entry
      const replayResult = await webhookDispatcher.replayDlq(dlqItem.id, testUser.id);
      expect(replayResult).not.toBeNull();
      expect(replayResult!.success).toBe(true);

      // Check the HTTP requests received by server: both must share the EXACT SAME Webhook-Id
      expect(receivedRequests).toHaveLength(2);
      const firstWebhookId = receivedRequests[0].headers['webhook-id'];
      const secondWebhookId = receivedRequests[1].headers['webhook-id'];

      expect(firstWebhookId).toBe(initialResult.id);
      expect(secondWebhookId).toBe(initialResult.id);
      expect(firstWebhookId).toBe(secondWebhookId);
    });
  });

  describe('5. Programmatic Secret Rotation API (POST /api/v1/webhooks/secrets/rotate)', () => {
    it('rejects unauthenticated request with 401 Problem Details', async () => {
      const req = new NextRequest('http://localhost:3000/api/v1/webhooks/secrets/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ graceSeconds: 3600 }),
      });

      const res = await rotateSecretRoute(req);
      expect(res.status).toBe(401);
      const problem = await res.json();
      expect(problem.status).toBe(401);
      expect(problem.title).toBe('Unauthorized');
    });

    it('rejects invalid graceSeconds (<60s) with 422 Problem Details conforming to JSON Schema SSOT', async () => {
      const req = new NextRequest('http://localhost:3000/api/v1/webhooks/secrets/rotate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${testApiKey}`,
        },
        body: JSON.stringify({ graceSeconds: 30 }), // Min is 60s
      });

      const res = await rotateSecretRoute(req);
      expect(res.status).toBe(422);
      const problem = await res.json();
      expect(problem.status).toBe(422);
      expect(problem.title).toBe('Unprocessable Entity');
      expect(problem.invalidParams).toBeDefined();
      expect(problem.invalidParams[0].name).toBe('graceSeconds');
    });

    it('successfully rotates webhook secret and returns whsec_ prefixed secret with grace period', async () => {
      const req1 = new NextRequest('http://localhost:3000/api/v1/webhooks/secrets/rotate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${testApiKey}`,
        },
        body: JSON.stringify({
          endpointId: 'ep_billing',
          apiKeyId: testKeyId,
          graceSeconds: 7200,
        }),
      });

      const res1 = await rotateSecretRoute(req1);
      expect(res1.status).toBe(200);
      const json1 = await res1.json();

      expect(json1.success).toBe(true);
      expect(json1.secret).toMatch(/^whsec_[a-f0-9]{64}$/);
      expect(json1.graceSeconds).toBe(7200);
      expect(json1.expiresAt).toBeGreaterThan(Date.now());
      expect(json1.previousExpiresAt).toBeUndefined(); // First rotation has no prior secret

      // Second consecutive rotation: prior secret becomes previous with active grace period
      const req2 = new NextRequest('http://localhost:3000/api/v1/webhooks/secrets/rotate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${testApiKey}`,
        },
        body: JSON.stringify({
          endpointId: 'ep_billing',
          apiKeyId: testKeyId,
          graceSeconds: 7200,
        }),
      });

      const res2 = await rotateSecretRoute(req2);
      expect(res2.status).toBe(200);
      const json2 = await res2.json();

      expect(json2.success).toBe(true);
      expect(json2.secret).toMatch(/^whsec_[a-f0-9]{64}$/);
      expect(json2.secret).not.toBe(json1.secret);
      expect(json2.previousExpiresAt).toBeGreaterThan(Date.now());

      // Verify record stored in enterprise WebhookSecretStore
      const record = await getWebhookSecretStore().getSecretRecord(testUser.id, 'ep_billing');
      expect(record).not.toBeNull();
      expect(record!.primary).toBe(json2.secret);
      expect(record!.previous).toBe(json1.secret);
      expect(record!.previousExpiresAt).toBe(json2.previousExpiresAt);
    });
  });
});
