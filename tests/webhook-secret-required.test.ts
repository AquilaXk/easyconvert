import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { NextRequest } from 'next/server';
import { POST as createKeyRoute } from '../src/app/api/keys/route';
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
});
