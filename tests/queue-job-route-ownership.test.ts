import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { conversionQueue } from '../src/lib/queue/conversion-queue';
import { Queue, DistributedBullMQAdapter } from '../src/lib/queue/bullmq-engine';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import { GET as getQueueJobRoute, DELETE as cancelQueueJobRoute } from '../src/app/api/queue/jobs/[id]/route';
import type { User } from '../src/lib/auth/types';
import type { ConversionJobData } from '../src/lib/types';

const BASE_URL = 'http://localhost:3000';
// `job_<epoch ms>_<128-bit random as 32 lowercase hex chars>`
const JOB_ID_PATTERN = /^job_\d{13}_[0-9a-f]{32}$/;

async function createUser(label: string): Promise<User> {
  const email = `${label}_${Date.now()}_${Math.random().toString(36).slice(2)}@queue.test`;
  return userStore.sanitizeUser(await userStore.createUser({ email, name: label, tier: 'pro' }));
}

function jobData(userId?: string): ConversionJobData {
  return {
    jobId: '',
    originalFilename: 'owner-check.csv',
    sourceFormat: 'csv',
    targetFormat: 'json',
    fileSize: 12,
    options: {},
    inputBufferBase64: Buffer.from('a,b\n1,2').toString('base64'),
    userId,
  };
}

function sessionRequest(user: User, pathName: string, method = 'GET'): NextRequest {
  return new NextRequest(`${BASE_URL}${pathName}`, {
    method,
    headers: { Cookie: `easyconvert_session=${createSessionToken(user)}` },
  });
}

function anonymousRequest(pathName: string, method = 'GET'): NextRequest {
  return new NextRequest(`${BASE_URL}${pathName}`, { method });
}

describe('Legacy /api/queue/jobs/[id] owner access (#242)', () => {
  let alice: User;
  let bob: User;
  let aliceJobId: string;
  let anonymousJobId: string;

  beforeEach(async () => {
    alice = await createUser('queue_alice');
    bob = await createUser('queue_bob');
    aliceJobId = (await conversionQueue.add('convert', jobData(alice.id))).id;
    anonymousJobId = (await conversionQueue.add('convert', jobData(undefined))).id;
  });

  it('hides an owned job from other users and anonymous callers on GET (JSON and SSE)', async () => {
    const pathName = `/api/queue/jobs/${aliceJobId}`;
    const params = { params: { id: aliceJobId } };

    expect((await getQueueJobRoute(sessionRequest(bob, pathName), params)).status).toBe(404);
    expect((await getQueueJobRoute(anonymousRequest(pathName), params)).status).toBe(404);

    const bobKey = await redisKeyStore.generateApiKey(bob.id, 'Bob admin', { scopes: ['*'] });
    const bobKeyReq = new NextRequest(`${BASE_URL}${pathName}`, { headers: { Authorization: `Bearer ${bobKey.secretKey}` } });
    expect((await getQueueJobRoute(bobKeyReq, params)).status).toBe(404);

    const sseRes = await getQueueJobRoute(anonymousRequest(`${pathName}?stream=true`), params);
    expect(sseRes.status).toBe(404);
    expect(sseRes.headers.get('content-type')).not.toBe('text/event-stream');
  });

  it('serves an owned job to its owner via session and via a convert:read key', async () => {
    const pathName = `/api/queue/jobs/${aliceJobId}`;
    const params = { params: { id: aliceJobId } };

    const sessionRes = await getQueueJobRoute(sessionRequest(alice, pathName), params);
    expect(sessionRes.status).toBe(200);
    const sessionBody = await sessionRes.json();
    expect(sessionBody.id).toBe(aliceJobId);
    expect(sessionBody.data.originalFilename).toBe('owner-check.csv');

    const readKey = await redisKeyStore.generateApiKey(alice.id, 'Alice read', { scopes: ['convert:read'] });
    const keyRes = await getQueueJobRoute(
      new NextRequest(`${BASE_URL}${pathName}`, { headers: { Authorization: `Bearer ${readKey.secretKey}` } }),
      params
    );
    expect(keyRes.status).toBe(200);
    expect((await keyRes.json()).id).toBe(aliceJobId);
  });

  it('blocks cancellation of an owned job by others and lets the owner cancel it', async () => {
    const pathName = `/api/queue/jobs/${aliceJobId}`;
    const params = { params: { id: aliceJobId } };

    expect((await cancelQueueJobRoute(sessionRequest(bob, pathName, 'DELETE'), params)).status).toBe(404);
    expect((await cancelQueueJobRoute(anonymousRequest(pathName, 'DELETE'), params)).status).toBe(404);
    expect((await conversionQueue.getJob(aliceJobId))?.state).toBe('waiting');

    const aliceReadKey = await redisKeyStore.generateApiKey(alice.id, 'Alice read', { scopes: ['convert:read'] });
    const readOnlyCancel = await cancelQueueJobRoute(
      new NextRequest(`${BASE_URL}${pathName}`, { method: 'DELETE', headers: { Authorization: `Bearer ${aliceReadKey.secretKey}` } }),
      params
    );
    expect(readOnlyCancel.status).toBe(403);
    expect((await conversionQueue.getJob(aliceJobId))?.state).toBe('waiting');

    const ownerRes = await cancelQueueJobRoute(sessionRequest(alice, pathName, 'DELETE'), params);
    expect(ownerRes.status).toBe(200);
    expect((await conversionQueue.getJob(aliceJobId))?.state).toBe('cancelled');
  });

  it('keeps capability-URL access for anonymous jobs', async () => {
    const pathName = `/api/queue/jobs/${anonymousJobId}`;
    const res = await getQueueJobRoute(anonymousRequest(pathName), { params: { id: anonymousJobId } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(anonymousJobId);
    expect(body.data.sourceFormat).toBe('csv');
  });

  describe('job id entropy', () => {
    it('uses 128 random bits in in-memory queue job ids', async () => {
      const queue = new Queue<ConversionJobData, unknown>('entropy-memory');
      const ids = await Promise.all([1, 2, 3].map(() => queue.add('convert', jobData(undefined)).then((j) => j.id)));
      for (const id of ids) {
        expect(id).toMatch(JOB_ID_PATTERN);
      }
      expect(new Set(ids.map((id) => id.split('_')[2])).size).toBe(ids.length);
    });

    it('uses 128 random bits in distributed queue job ids', async () => {
      const writtenKeys: string[] = [];
      const recordingRedis = {
        hset: async (key: string) => {
          writtenKeys.push(key);
          return 1;
        },
        rpush: async () => 1,
        publish: async () => 1,
      };
      const adapter = new DistributedBullMQAdapter<ConversionJobData, unknown>('entropy-distributed', {
        redisClient: recordingRedis as never,
        keyPrefix: 'entropytest:',
      });

      const job = await adapter.add('convert', jobData(undefined));
      expect(job.id).toMatch(JOB_ID_PATTERN);
      expect(writtenKeys).toContain(`entropytest:{entropy-distributed}:job:${job.id}`);
    });
  });
});
