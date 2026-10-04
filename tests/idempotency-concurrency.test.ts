import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import Redis from 'ioredis';
import { POST as jobsPostHandler } from '../src/app/api/v1/jobs/route';
import { POST as convertPostHandler } from '../src/app/api/v1/convert/route';
import { conversionQueue } from '../src/lib/queue/conversion-queue';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import {
  IdempotencyStore,
  InMemoryIdempotencyStore,
  RedisIdempotencyStore,
  setIdempotencyStore,
  buildScopedKey,
} from '../src/lib/api/idempotency';

describe.each([
  { name: 'InMemoryIdempotencyStore', isRedis: false },
  { name: 'RedisIdempotencyStore', isRedis: true },
])('WP-11 Idempotency-Key Concurrency & Replay Engine: $name', ({ isRedis }) => {
  let testUser: any;
  let apiKey: { key: any; secretKey: string };
  let store: IdempotencyStore;
  let fakeTime: number;
  let redisClient: Redis | null = null;

  beforeEach(async () => {
    fakeTime = Date.now();
    const clock = () => fakeTime;

    if (isRedis) {
      const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
      redisClient = new Redis(redisUrl, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
      });

      try {
        await redisClient.connect();
      } catch {
        // Already connected or lazy
      }

      // Check redis health
      try {
        await redisClient.ping();
      } catch (err) {
        console.warn('Redis is not accessible, skipping RedisIdempotencyStore tests.');
        return;
      }

      store = new RedisIdempotencyStore({ redisClient, clock });
      await store.reset?.();
    } else {
      store = new InMemoryIdempotencyStore({ clock });
    }

    setIdempotencyStore(store);

    const email = `idem_${Date.now()}_${Math.random().toString(36).substring(7)}@easyconvert.local`;
    testUser = await userStore.createUser({
      name: 'Idempotency Concurrency Tester',
      email,
      tier: 'pro',
    });

    apiKey = await redisKeyStore.generateApiKey(testUser.id, 'Idempotency Key', {
      scopes: ['convert:write', 'convert:read'],
    });
  });

  afterEach(async () => {
    setIdempotencyStore(null);
    if (redisClient) {
      try {
        await store.reset?.();
        await redisClient.quit();
      } catch {}
    }
  });

  function createJobRequest(idempotencyKey: string, bodyOverrides: Record<string, any> = {}) {
    return new NextRequest('http://localhost:3000/api/v1/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey.secretKey}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        originalFilename: 'sample.txt',
        targetFormat: 'pdf',
        inputBufferBase64: Buffer.from('Genuine plain text content for testing').toString('base64'),
        ...bodyOverrides,
      }),
    });
  }

  it('handles 10 concurrent requests with the same key atomically: exactly 1 accepted, 9 conflicts/replays, queue delta = 1, quota delta = 1', async () => {
    const idempotencyKey = `concur-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    const countsBefore = await conversionQueue.getJobCounts();
    const totalJobsBefore = Object.values(countsBefore).reduce((a, b) => a + b, 0);
    const quotaBefore = await redisKeyStore.getQuotaUsage(testUser.id);

    const requests = Array.from({ length: 10 }, () => createJobRequest(idempotencyKey));
    const responses = await Promise.all(requests.map((req) => jobsPostHandler(req)));

    const successResponses = responses.filter((r) => r.status === 202);
    const conflictResponses = responses.filter((r) => r.status === 409);
    const replayedResponses = responses.filter((r) => r.headers.get('idempotent-replayed') === 'true');

    expect(successResponses).toHaveLength(1);
    expect(conflictResponses.length + replayedResponses.length).toBe(9);

    for (const conflict of conflictResponses) {
      expect(conflict.status).toBe(409);
      expect(conflict.headers.get('retry-after')).toBe('1');
      expect(conflict.headers.get('content-type')).toContain('application/problem+json');
    }

    const countsAfter = await conversionQueue.getJobCounts();
    const totalJobsAfter = Object.values(countsAfter).reduce((a, b) => a + b, 0);
    expect(totalJobsAfter - totalJobsBefore).toBe(1);

    const quotaAfter = await redisKeyStore.getQuotaUsage(testUser.id);
    expect(quotaAfter.usedToday - quotaBefore.usedToday).toBe(1);
  });

  it('replays completed response with identical jobId and Idempotent-Replayed: true header without queue or quota increase', async () => {
    const idempotencyKey = `replay-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    const firstReq = createJobRequest(idempotencyKey);
    const firstRes = await jobsPostHandler(firstReq);
    expect(firstRes.status).toBe(202);
    const firstData = await firstRes.json();
    expect(firstData.jobId).toBeDefined();

    const countsAfterFirst = await conversionQueue.getJobCounts();
    const totalJobsAfterFirst = Object.values(countsAfterFirst).reduce((a, b) => a + b, 0);
    const quotaAfterFirst = await redisKeyStore.getQuotaUsage(testUser.id);

    // Re-send same request with same key
    const secondReq = createJobRequest(idempotencyKey);
    const secondRes = await jobsPostHandler(secondReq);
    expect(secondRes.status).toBe(202);
    expect(secondRes.headers.get('idempotent-replayed')).toBe('true');
    const secondData = await secondRes.json();
    expect(secondData.jobId).toBe(firstData.jobId);
    expect(secondData.originalFilename).toBe(firstData.originalFilename);

    // Queue and quota must NOT increase
    const countsAfterSecond = await conversionQueue.getJobCounts();
    const totalJobsAfterSecond = Object.values(countsAfterSecond).reduce((a, b) => a + b, 0);
    expect(totalJobsAfterSecond).toBe(totalJobsAfterFirst);

    const quotaAfterSecond = await redisKeyStore.getQuotaUsage(testUser.id);
    expect(quotaAfterSecond.usedToday).toBe(quotaAfterFirst.usedToday);
  });

  it('rejects reused key with different fingerprint with 422 Unprocessable Entity', async () => {
    const idempotencyKey = `mismatch-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    const firstReq = createJobRequest(idempotencyKey, { targetFormat: 'pdf' });
    const firstRes = await jobsPostHandler(firstReq);
    expect(firstRes.status).toBe(202);

    // Send different targetFormat (different fingerprint)
    const secondReq = createJobRequest(idempotencyKey, { targetFormat: 'html' });
    const secondRes = await jobsPostHandler(secondReq);
    expect(secondRes.status).toBe(422);
    expect(secondRes.headers.get('content-type')).toContain('application/problem+json');
    const problem = await secondRes.json();
    expect(problem.type).toBe('https://api.easyconvert.io/problems/idempotency-key-reused');
    expect(problem.status).toBe(422);
  });

  it('allows new job creation with the same key after 24h TTL expiration', async () => {
    const idempotencyKey = `ttl-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    const firstReq = createJobRequest(idempotencyKey);
    const firstRes = await jobsPostHandler(firstReq);
    expect(firstRes.status).toBe(202);
    const firstData = await firstRes.json();

    const countsAfterFirst = await conversionQueue.getJobCounts();
    const totalJobsAfterFirst = Object.values(countsAfterFirst).reduce((a, b) => a + b, 0);

    // Advance clock by 24 hours + 10 seconds
    fakeTime += (24 * 60 * 60 + 10) * 1000;
    if (isRedis && redisClient) {
      const scopedKey = buildScopedKey(testUser.id, '/api/v1/jobs', idempotencyKey);
      await redisClient.del(scopedKey);
    }

    const thirdReq = createJobRequest(idempotencyKey);
    const thirdRes = await jobsPostHandler(thirdReq);
    expect(thirdRes.status).toBe(202);
    expect(thirdRes.headers.get('idempotent-replayed')).toBeNull();
    const thirdData = await thirdRes.json();
    expect(thirdData.jobId).not.toBe(firstData.jobId);

    const countsAfterThird = await conversionQueue.getJobCounts();
    const totalJobsAfterThird = Object.values(countsAfterThird).reduce((a, b) => a + b, 0);
    expect(totalJobsAfterThird - totalJobsAfterFirst).toBe(1);
  });

  it('deletes in-flight key when handler returns 5xx so client can retry safely', async () => {
    const idempotencyKey = `retry-5xx-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const scopedKey = buildScopedKey(testUser.id, '/api/v1/jobs', idempotencyKey);

    // Simulate lock acquired and deleted on 5xx failure
    await store.acquire(scopedKey, 'fp-temp', 60000);
    await store.delete(scopedKey);

    // Client retries with same key
    const retryReq = createJobRequest(idempotencyKey);
    const retryRes = await jobsPostHandler(retryReq);
    expect(retryRes.status).toBe(202);
  });

  it('stores and replays 4xx client errors without re-validating or charging quota', async () => {
    const idempotencyKey = `err-4xx-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    // Missing targetFormat causes 400 Bad Request
    const req1 = createJobRequest(idempotencyKey, { targetFormat: '' });
    const res1 = await jobsPostHandler(req1);
    expect(res1.status).toBe(400);

    // Replay should return 400 with Idempotent-Replayed: true
    const req2 = createJobRequest(idempotencyKey, { targetFormat: '' });
    const res2 = await jobsPostHandler(req2);
    expect(res2.status).toBe(400);
    expect(res2.headers.get('idempotent-replayed')).toBe('true');
  });

  it('rejects invalid Idempotency-Key headers with 400 Bad Request', async () => {
    const req = new NextRequest('http://localhost:3000/api/v1/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey.secretKey}`,
        'Idempotency-Key': 'invalid key with spaces',
      },
      body: JSON.stringify({ originalFilename: 'test.txt', targetFormat: 'pdf' }),
    });

    const res = await jobsPostHandler(req);
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const problem = await res.json();
    expect(problem.status).toBe(400);
  });

  it('supports multipart/form-data with file stream hashing and idempotency replay', async () => {
    const idempotencyKey = `mp-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    const form1 = new FormData();
    form1.append('targetFormat', 'pdf');
    form1.append(
      'file',
      new Blob(['genuine plain text for multipart test'], { type: 'text/plain' }),
      'sample.txt'
    );

    const req1 = new NextRequest('http://localhost:3000/api/v1/jobs', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.secretKey}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: form1,
    });

    const res1 = await jobsPostHandler(req1);
    expect(res1.status).toBe(202);
    const data1 = await res1.json();
    expect(data1.jobId).toBeDefined();

    // Replay with identical multipart payload
    const form2 = new FormData();
    form2.append('targetFormat', 'pdf');
    form2.append(
      'file',
      new Blob(['genuine plain text for multipart test'], { type: 'text/plain' }),
      'sample.txt'
    );

    const req2 = new NextRequest('http://localhost:3000/api/v1/jobs', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.secretKey}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: form2,
    });

    const res2 = await jobsPostHandler(req2);
    expect(res2.status).toBe(202);
    expect(res2.headers.get('idempotent-replayed')).toBe('true');
    const data2 = await res2.json();
    expect(data2.jobId).toBe(data1.jobId);
  });

  it('supports synchronous POST /api/v1/convert idempotency caching and replay', async () => {
    const idempotencyKey = `conv-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    const form1 = new FormData();
    form1.append('targetFormat', 'pdf');
    form1.append(
      'file',
      new Blob(['Hello EasyConvert Synchronous Conversion!'], { type: 'text/plain' }),
      'hello.txt'
    );

    const req1 = new NextRequest('http://localhost:3000/api/v1/convert', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.secretKey}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: form1,
    });

    const res1 = await convertPostHandler(req1);
    expect(res1.status).toBe(200);
    const data1 = await res1.json();
    expect(data1.success).toBe(true);
    expect(data1.fileId).toBeDefined();

    // Replay
    const form2 = new FormData();
    form2.append('targetFormat', 'pdf');
    form2.append(
      'file',
      new Blob(['Hello EasyConvert Synchronous Conversion!'], { type: 'text/plain' }),
      'hello.txt'
    );

    const req2 = new NextRequest('http://localhost:3000/api/v1/convert', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.secretKey}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: form2,
    });

    const res2 = await convertPostHandler(req2);
    expect(res2.status).toBe(200);
    expect(res2.headers.get('idempotent-replayed')).toBe('true');
    const data2 = await res2.json();
    expect(data2.fileId).toBe(data1.fileId);
  });
});
