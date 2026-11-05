import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { NextRequest } from 'next/server';
import { POST as createKeyRoute } from '../src/app/api/keys/route';
import { PATCH as patchKeyRoute } from '../src/app/api/keys/[id]/route';
import { POST as jobsRoute } from '../src/app/api/v1/jobs/route';
import { POST as convertRoute } from '../src/app/api/v1/convert/route';
import { attachJobLifecycleListeners } from '../src/lib/queue/conversion-queue';
import { Queue, Worker } from '../src/lib/queue/bullmq-engine';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import type { User } from '../src/lib/auth/types';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';
import { TERMS_VERSION } from '../src/lib/legal/documents';

describe('Security: Webhook secret enforcement', () => {
  let testUser: User;
  let sessionToken: string;

  beforeEach(async () => {
    testUser = await userStore.createUser({
      name: 'Webhook Tester',
      email: `webhook_tester_${Date.now()}_${Math.random().toString(36).substring(7)}@test.com`,
      tier: 'pro',
    });
    sessionToken = createSessionToken(testUser);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await webhookDispatcher.clearDlq(testUser.id);
  });

  it('rejects API key creation when webhookUrl is provided without webhookSecret with 400', async () => {
    const reqWithoutSecret = new NextRequest('http://localhost:3000/api/keys', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `easyconvert_session=${sessionToken}`,
      },
      body: JSON.stringify({
        acceptedTermsVersion: TERMS_VERSION,
        name: 'Insecure Key',
        webhookUrl: 'https://example.com/webhook',
      }),
    });

    const resWithoutSecret = await createKeyRoute(reqWithoutSecret);
    expect(resWithoutSecret.status).toBe(400);
    const jsonWithoutSecret = await resWithoutSecret.json();
    expect(jsonWithoutSecret.success).toBe(false);
    expect(jsonWithoutSecret.error).toBe('webhookSecret is required when webhookUrl is provided.');

    // Creating with webhookSecret succeeds
    const reqWithSecret = new NextRequest('http://localhost:3000/api/keys', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `easyconvert_session=${sessionToken}`,
      },
      body: JSON.stringify({
        acceptedTermsVersion: TERMS_VERSION,
        name: 'Secure Key',
        webhookUrl: 'https://example.com/webhook',
        webhookSecret: 'my_super_secret_value',
      }),
    });

    const resWithSecret = await createKeyRoute(reqWithSecret);
    expect(resWithSecret.status).toBe(200);
    const jsonWithSecret = await resWithSecret.json();
    expect(jsonWithSecret.success).toBe(true);
    expect(jsonWithSecret.key.hasWebhookSecret).toBe(true);
  });

  it('rejects POST /api/v1/jobs with 400 when webhookUrl is supplied without webhookSecret in JSON', async () => {
    const keyResult = await redisKeyStore.generateApiKey(testUser.id, 'Job Submitter Key', {
      scopes: ['convert:write'],
    });

    const req = new NextRequest('http://localhost:3000/api/v1/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${keyResult.secretKey}`,
      },
      body: JSON.stringify({
        filename: 'document.txt',
        targetFormat: 'pdf',
        inputBufferBase64: Buffer.from('Hello EasyConvert').toString('base64'),
        webhookUrl: 'https://example.com/webhook-receiver',
      }),
    });

    const res = await jobsRoute(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.status).toBe(400);
    expect(json.detail).toBe('webhookSecret is required when webhookUrl is provided.');
  });

  it('rejects POST /api/v1/jobs with 400 when webhookUrl is supplied without webhookSecret in FormData', async () => {
    const keyResult = await redisKeyStore.generateApiKey(testUser.id, 'Job Submitter Key 2', {
      scopes: ['convert:write'],
    });

    const formData = new FormData();
    const fileBlob = new Blob(['sample content'], { type: 'text/plain' });
    formData.append('file', fileBlob, 'sample.txt');
    formData.append('targetFormat', 'pdf');
    formData.append('webhookUrl', 'https://example.com/webhook-receiver');

    const req = new NextRequest('http://localhost:3000/api/v1/jobs', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${keyResult.secretKey}`,
      },
      body: formData,
    });

    const res = await jobsRoute(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.status).toBe(400);
    expect(json.detail).toBe('webhookSecret is required when webhookUrl is provided.');
  });

  it('accepts POST /api/v1/jobs with 202 when both webhookUrl and webhookSecret are provided', async () => {
    const keyResult = await redisKeyStore.generateApiKey(testUser.id, 'Job Submitter Key Valid Webhook', {
      scopes: ['convert:write'],
    });

    const req = new NextRequest('http://localhost:3000/api/v1/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${keyResult.secretKey}`,
      },
      body: JSON.stringify({
        filename: 'document.txt',
        targetFormat: 'pdf',
        inputBufferBase64: Buffer.from('Hello EasyConvert Valid Webhook').toString('base64'),
        webhookUrl: 'https://example.com/webhook-receiver',
        webhookSecret: 'valid_secret_123',
      }),
    });

    const res = await jobsRoute(req);
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.jobId).toBeDefined();
  });

  it('accepts POST /api/v1/jobs with 202 when no webhookUrl is provided', async () => {
    const keyResult = await redisKeyStore.generateApiKey(testUser.id, 'Job Submitter Key No Webhook', {
      scopes: ['convert:write'],
    });

    const req = new NextRequest('http://localhost:3000/api/v1/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${keyResult.secretKey}`,
      },
      body: JSON.stringify({
        filename: 'document.txt',
        targetFormat: 'pdf',
        inputBufferBase64: Buffer.from('Hello EasyConvert No Webhook').toString('base64'),
      }),
    });

    const res = await jobsRoute(req);
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.jobId).toBeDefined();
  });

  it('rejects POST /api/v1/convert with 400 when webhookUrl is supplied without webhookSecret in FormData', async () => {
    const keyResult = await redisKeyStore.generateApiKey(testUser.id, 'Convert Submitter Key', {
      scopes: ['convert:write'],
    });

    const formData = new FormData();
    const fileBlob = new Blob(['sample content'], { type: 'text/plain' });
    formData.append('file', fileBlob, 'sample.txt');
    formData.append('targetFormat', 'pdf');
    formData.append('webhookUrl', 'https://example.com/webhook-receiver');

    const req = new NextRequest('http://localhost:3000/api/v1/convert', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${keyResult.secretKey}`,
        prefer: 'respond-async',
      },
      body: formData,
    });

    const res = await convertRoute(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.status).toBe(400);
    expect(json.detail).toBe('webhookSecret is required when webhookUrl is provided.');
  });

  it('skips dispatching secretless webhooks in queue lifecycle, logs warning, and writes to DLQ with zero HTTP traffic', async () => {
    let serverHitCount = 0;
    const server = http.createServer((_req, res) => {
      serverHitCount++;
      res.writeHead(200);
      res.end('ok');
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start test HTTP server');
    }
    const webhookTargetUrl = `http://127.0.0.1:${address.port}/webhook`;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const queueName = `test-secretless-queue-${Date.now()}`;
    const testQueue = new Queue<ConversionJobData, ConversionJobResult>(queueName);
    const testWorker = new Worker<ConversionJobData, ConversionJobResult>(
      testQueue,
      async (job) => {
        return {
          jobId: job.id,
          status: 'completed',
          resultKey: 'results/test/result.pdf',
          filename: 'result.pdf',
          mimeType: 'application/pdf',
          size: 100,
          durationMs: 42,
          downloadUrl: '/api/download/test',
        };
      },
      { concurrency: 1 }
    );

    attachJobLifecycleListeners(testWorker);

    try {
      const completionPromise = new Promise<void>((resolve) => {
        testWorker.on('completed', () => resolve());
      });

      // Submit job without webhookSecret
      await testQueue.add('convert', {
        jobId: '',
        originalFilename: 'test.txt',
        sourceFormat: 'txt',
        targetFormat: 'pdf',
        fileSize: 100,
        options: {},
        webhookUrl: webhookTargetUrl,
        userId: testUser.id,
      });

      await completionPromise;

      // Allow microtasks to settle
      await new Promise((resolve) => setTimeout(resolve, 50));

      // 1. Zero HTTP requests reached the server
      expect(serverHitCount).toBe(0);

      // 2. Warning logged
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipping webhook dispatch for job')
      );

      // 3. Recorded to DLQ
      const dlqEntries = await webhookDispatcher.getDlqEntries(testUser.id);
      expect(dlqEntries.length).toBeGreaterThanOrEqual(1);
      const entry = dlqEntries.find((e) => e.targetUrl === webhookTargetUrl);
      expect(entry).toBeDefined();
      expect(entry?.errorMessage).toBe('missing_webhook_secret');
      expect(entry?.status).toBe('failed');
    } finally {
      await testWorker.close();
      await testQueue.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects private, loopback, or non-http(s) webhookUrl at key creation, key update, and job submission', async () => {
    const badUrls = [
      'http://127.0.0.1:8080/hook',
      'http://169.254.169.254/latest/meta-data/',
      'ftp://example.com/hook',
      'https://user:pass@example.com/hook',
    ];

    for (const badUrl of badUrls) {
      const createRes = await createKeyRoute(
        new NextRequest('http://localhost:3000/api/keys', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: `easyconvert_session=${sessionToken}`,
          },
          body: JSON.stringify({
            acceptedTermsVersion: TERMS_VERSION,
            name: 'SSRF Key',
            webhookUrl: badUrl,
            webhookSecret: 'secret_123',
          }),
        })
      );
      expect(createRes.status, badUrl).toBe(400);
      const createJson = await createRes.json();
      expect(createJson.code, badUrl).toBe('invalid_key_settings');
    }

    const validKey = await redisKeyStore.generateApiKey(testUser.id, 'Updatable Key', {
      scopes: ['convert:write'],
    });

    const patchRes = await patchKeyRoute(
      new NextRequest(`http://localhost:3000/api/keys/${validKey.key.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `easyconvert_session=${sessionToken}`,
        },
        body: JSON.stringify({
          webhookUrl: 'http://127.0.0.1:9000/internal',
          webhookSecret: 'secret_123',
        }),
      }),
      { params: Promise.resolve({ id: validKey.key.id }) }
    );
    expect(patchRes.status).toBe(400);

    const patchMissingSecretRes = await patchKeyRoute(
      new NextRequest(`http://localhost:3000/api/keys/${validKey.key.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `easyconvert_session=${sessionToken}`,
        },
        body: JSON.stringify({
          webhookUrl: 'https://example.com/hook',
        }),
      }),
      { params: Promise.resolve({ id: validKey.key.id }) }
    );
    expect(patchMissingSecretRes.status).toBe(400);

    const patchValidRes = await patchKeyRoute(
      new NextRequest(`http://localhost:3000/api/keys/${validKey.key.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `easyconvert_session=${sessionToken}`,
        },
        body: JSON.stringify({
          webhookUrl: 'https://example.com/hook',
          webhookSecret: 'secret_123',
        }),
      }),
      { params: Promise.resolve({ id: validKey.key.id }) }
    );
    expect(patchValidRes.status).toBe(200);

    const patchClearSecretOnlyRes = await patchKeyRoute(
      new NextRequest(`http://localhost:3000/api/keys/${validKey.key.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `easyconvert_session=${sessionToken}`,
        },
        body: JSON.stringify({
          webhookSecret: '',
        }),
      }),
      { params: Promise.resolve({ id: validKey.key.id }) }
    );
    expect(patchClearSecretOnlyRes.status).toBe(400);

    const jobRes = await jobsRoute(
      new NextRequest('http://localhost:3000/api/v1/jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${validKey.secretKey}`,
        },
        body: JSON.stringify({
          filename: 'document.txt',
          targetFormat: 'pdf',
          inputBufferBase64: Buffer.from('Hello').toString('base64'),
          webhookUrl: 'http://127.0.0.1:9000/internal',
          webhookSecret: 'secret_123',
        }),
      })
    );
    expect(jobRes.status).toBe(400);

    const formData = new FormData();
    formData.append('file', new Blob(['sample content'], { type: 'text/plain' }), 'sample.txt');
    formData.append('targetFormat', 'pdf');
    formData.append('webhookUrl', 'http://169.254.169.254/latest/meta-data/');
    formData.append('webhookSecret', 'secret_123');

    const convertRes = await convertRoute(
      new NextRequest('http://localhost:3000/api/v1/convert', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${validKey.secretKey}`,
          prefer: 'respond-async',
        },
        body: formData,
      })
    );
    expect(convertRes.status).toBe(400);
  });

  it('refuses to follow 3xx webhook redirects and routes redirect responses immediately to DLQ', async () => {
    let fetchCalls = 0;
    let passedInit: RequestInit | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      fetchCalls++;
      passedInit = init;
      return new Response('redirecting', {
        status: 302,
        headers: { location: 'http://127.0.0.1:8080/internal-admin' },
      });
    });

    const result = await webhookDispatcher.dispatch(
      'https://93.184.215.14/webhook',
      'job.completed',
      { jobId: 'job_redirect_test' },
      'webhook_secret_xyz',
      { ownerUserId: testUser.id, maxRetries: 3 }
    );

    expect(passedInit?.redirect).toBe('manual');
    expect(fetchCalls).toBe(1);
    expect(result.success).toBe(false);
    expect(result.finalStatusCode).toBe(302);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].error).toContain('Webhook redirect (302) is not followed.');

    const dlqEntries = await webhookDispatcher.getDlqEntries(testUser.id);
    const dlqEntry = dlqEntries.find((e) => e.originalDeliveryId === result.id);
    expect(dlqEntry).toBeDefined();
    expect(dlqEntry?.finalStatusCode).toBe(302);
  });
});
