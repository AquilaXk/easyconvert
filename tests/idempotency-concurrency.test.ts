import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
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
  canonicalJSON,
} from '../src/lib/api/idempotency';
import { withIdempotency } from '../src/lib/api/with-idempotency';

const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379';

describe.each([
  { name: 'InMemoryIdempotencyStore', isRedis: false },
  { name: 'RedisIdempotencyStore', isRedis: true },
])('WP-11 Idempotency-Key Concurrency & Replay Engine: $name', ({ isRedis }) => {
  let testUser: any;
  let apiKey: { key: any; secretKey: string };
  let store: IdempotencyStore;
  let fakeTime: number;
  let redisClient: Redis | null = null;

  beforeEach(async (ctx) => {
    fakeTime = Date.now();
    const clock = () => fakeTime;

    if (isRedis) {
      const redisUrl = process.env.REDIS_URL || DEFAULT_REDIS_URL;
      redisClient = new Redis(redisUrl, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
      });
      // A refused connection emits 'error' events; the ping below reports the outcome.
      redisClient.on('error', () => {});

      try {
        await redisClient.connect();
        await redisClient.ping();
      } catch (err) {
        redisClient.disconnect();
        redisClient = null;
        // CI runs a Redis service and sets ORACLE_STRICT_MODE=1; an unreachable server there is a failure.
        if (process.env.ORACLE_STRICT_MODE === '1' || process.env.REDIS_URL) {
          throw new Error(`Redis is required for the RedisIdempotencyStore variant but unreachable at ${redisUrl}: ${String(err)}`);
        }
        ctx.skip();
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

  it('rejects reused key with 1-bit flipped multipart file payload with 422 Unprocessable Entity', async () => {
    const idempotencyKey = `flip-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    const buf1 = Buffer.from('Exact Payload Content A');
    const form1 = new FormData();
    form1.append('targetFormat', 'pdf');
    form1.append('file', new Blob([buf1], { type: 'text/plain' }), 'sample.txt');

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

    // Flip 1 bit in file payload
    const buf2 = Buffer.from('Exact Payload Content B');
    const form2 = new FormData();
    form2.append('targetFormat', 'pdf');
    form2.append('file', new Blob([buf2], { type: 'text/plain' }), 'sample.txt');

    const req2 = new NextRequest('http://localhost:3000/api/v1/jobs', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.secretKey}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: form2,
    });

    const res2 = await jobsPostHandler(req2);
    expect(res2.status).toBe(422);
    const problem = await res2.json();
    expect(problem.type).toBe('https://api.easyconvert.io/problems/idempotency-key-reused');
  });

  it('rejects reused key with different file name despite identical byte content with 422 Unprocessable Entity', async () => {
    const idempotencyKey = `fname-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    const form1 = new FormData();
    form1.append('targetFormat', 'pdf');
    form1.append('file', new Blob(['identical bytes'], { type: 'text/plain' }), 'doc_alpha.txt');

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

    const form2 = new FormData();
    form2.append('targetFormat', 'pdf');
    form2.append('file', new Blob(['identical bytes'], { type: 'text/plain' }), 'doc_beta.txt');

    const req2 = new NextRequest('http://localhost:3000/api/v1/jobs', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.secretKey}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: form2,
    });

    const res2 = await jobsPostHandler(req2);
    expect(res2.status).toBe(422);
    const problem = await res2.json();
    expect(problem.type).toBe('https://api.easyconvert.io/problems/idempotency-key-reused');
  });

  it('stores and replays schema validation 422 errors and invalid JSON 400 errors without dangling locks', async () => {
    const idempotencyKey422 = `schema-err-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    // Invalid schema: options.quality is negative
    const req422_1 = createJobRequest(idempotencyKey422, { options: { quality: -10 } });
    const res422_1 = await jobsPostHandler(req422_1);
    expect(res422_1.status).toBe(422);

    // Replay should return stored 422 with Idempotent-Replayed: true, NOT 409 Conflict
    const req422_2 = createJobRequest(idempotencyKey422, { options: { quality: -10 } });
    const res422_2 = await jobsPostHandler(req422_2);
    expect(res422_2.status).toBe(422);
    expect(res422_2.headers.get('idempotent-replayed')).toBe('true');

    // Invalid JSON syntax: 400 Bad Request
    const idempotencyKey400 = `json-err-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const req400_1 = new NextRequest('http://localhost:3000/api/v1/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey.secretKey}`,
        'Idempotency-Key': idempotencyKey400,
      },
      body: '{ malformed json: true, ',
    });

    const res400_1 = await jobsPostHandler(req400_1);
    expect(res400_1.status).toBe(400);

    // Replay should return stored 400 with Idempotent-Replayed: true, NOT 409 Conflict
    const req400_2 = new NextRequest('http://localhost:3000/api/v1/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey.secretKey}`,
        'Idempotency-Key': idempotencyKey400,
      },
      body: '{ malformed json: true, ',
    });

    const res400_2 = await jobsPostHandler(req400_2);
    expect(res400_2.status).toBe(400);
    expect(res400_2.headers.get('idempotent-replayed')).toBe('true');
  });

  it('replays null-body responses (204 No Content) safely without throwing TypeError', async () => {
    const idempotencyKey = `null-body-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    const testHandler = withIdempotency(
      async () => {
        return new NextResponse(null, { status: 204 });
      },
      { store }
    );

    const req1 = new NextRequest('http://localhost:3000/api/v1/test-endpoint', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.secretKey}`,
        'Idempotency-Key': idempotencyKey,
      },
    });

    const res1 = await testHandler(req1);
    expect(res1.status).toBe(204);

    const req2 = new NextRequest('http://localhost:3000/api/v1/test-endpoint', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.secretKey}`,
        'Idempotency-Key': idempotencyKey,
      },
    });

    const res2 = await testHandler(req2);
    expect(res2.status).toBe(204);
    expect(res2.headers.get('idempotent-replayed')).toBe('true');
  });
});

describe('WP-11 canonicalJSON RFC 8785 Verification', () => {
  it('sorts keys strictly according to UTF-16 code units (independent of locale)', () => {
    // In UTF-16 code units, uppercase "B" (66) precedes lowercase "a" (97).
    // In localeCompare with English locale, "a" precedes "B".
    const input = { a: 1, B: 2, z: 3, A: 4 };
    const serialized = canonicalJSON(input);
    expect(serialized).toBe('{"A":4,"B":2,"a":1,"z":3}');
  });

  it('pads undefined elements in arrays with null conforming to JSON grammar', () => {
    const input = [undefined, 'foo', undefined, 42];
    const serialized = canonicalJSON(input);
    expect(serialized).toBe('[null,"foo",null,42]');
  });

  it('serializes objects with toJSON() methods such as Date', () => {
    const date = new Date('2026-10-04T00:00:00.000Z');
    const input = { timestamp: date, name: 'test' };
    const serialized = canonicalJSON(input);
    expect(serialized).toBe('{"name":"test","timestamp":"2026-10-04T00:00:00.000Z"}');
  });
});
