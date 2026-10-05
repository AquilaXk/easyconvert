import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { conversionQueue } from '../src/lib/queue/conversion-queue';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import { GET as listQueueJobsRoute } from '../src/app/api/queue/jobs/route';
import { POST as v1ConvertRoute } from '../src/app/api/v1/convert/route';
import { API_KEY_BURST_LIMITS } from '../src/lib/api-keys/guard';
import type { User } from '../src/lib/auth/types';
import type { ConversionJobData } from '../src/lib/types';

const BASE_URL = 'http://localhost:3000';
// Independently authored expectations (RFC 9457 problem type URIs used by this API).
const RATE_LIMITED_TYPE = 'https://api.easyconvert.io/problems/rate-limited';
const QUOTA_EXCEEDED_TYPE = 'https://api.easyconvert.io/problems/quota-exceeded';

async function createUser(label: string, tier: 'free' | 'pro' = 'pro'): Promise<User> {
  const email = `${label}_${Date.now()}_${Math.random().toString(36).slice(2)}@followup.test`;
  return userStore.sanitizeUser(await userStore.createUser({ email, name: label, tier }));
}

function jobData(userId: string | undefined, filename: string): ConversionJobData {
  return {
    jobId: '',
    originalFilename: filename,
    sourceFormat: 'csv',
    targetFormat: 'json',
    fileSize: 7,
    options: {},
    inputBufferBase64: Buffer.from('a,b\n1,2').toString('base64'),
    userId,
  };
}

function sessionRequest(user: User, pathName: string): NextRequest {
  return new NextRequest(`${BASE_URL}${pathName}`, {
    headers: { Cookie: `easyconvert_session=${createSessionToken(user)}` },
  });
}

describe('PR #246 review follow-ups', () => {
  describe('GET /api/queue/jobs does not leak other callers jobs', () => {
    let alice: User;
    let bob: User;
    let aliceJobId: string;
    let bobJobId: string;
    let anonymousJobId: string;

    beforeEach(async () => {
      alice = await createUser('list_alice');
      bob = await createUser('list_bob');
      aliceJobId = (await conversionQueue.add('convert', jobData(alice.id, 'alice.csv'))).id;
      bobJobId = (await conversionQueue.add('convert', jobData(bob.id, 'bob.csv'))).id;
      anonymousJobId = (await conversionQueue.add('convert', jobData(undefined, 'anon.csv'))).id;
    });

    it('rejects anonymous callers with 401 and returns no job ids', async () => {
      const res = await listQueueJobsRoute(new NextRequest(`${BASE_URL}/api/queue/jobs`));
      const text = await res.text();
      expect(res.status).toBe(401);
      expect(text).not.toContain(aliceJobId);
      expect(text).not.toContain(bobJobId);
      expect(text).not.toContain(anonymousJobId);
    });

    it('lists only the caller own jobs for a signed-in user', async () => {
      const res = await listQueueJobsRoute(sessionRequest(alice, '/api/queue/jobs'));
      const body = await res.json();
      const ids: string[] = body.jobs.map((j: { id: string }) => j.id);
      expect(res.status).toBe(200);
      expect(ids).toContain(aliceJobId);
      expect(ids).not.toContain(bobJobId);
      expect(ids).not.toContain(anonymousJobId);
      expect(body.jobs.every((j: { originalFilename: string }) => j.originalFilename === 'alice.csv')).toBe(true);
    });

    it('lists only the key owner jobs for a convert:read API key', async () => {
      const key = await redisKeyStore.generateApiKey(bob.id, 'bob read', { scopes: ['convert:read'] });
      const res = await listQueueJobsRoute(
        new NextRequest(`${BASE_URL}/api/queue/jobs`, { headers: { Authorization: `Bearer ${key.secretKey}` } })
      );
      const body = await res.json();
      const ids: string[] = body.jobs.map((j: { id: string }) => j.id);
      expect(res.status).toBe(200);
      expect(ids).toContain(bobJobId);
      expect(ids).not.toContain(aliceJobId);
      expect(ids).not.toContain(anonymousJobId);
    });

    it('rejects an unknown status filter with 400', async () => {
      const res = await listQueueJobsRoute(sessionRequest(alice, '/api/queue/jobs?status=everything'));
      expect(res.status).toBe(400);
    });
  });

  describe('burst 429 uses a distinct problem type', () => {
    const BURST_ATTEMPT_FACTOR = 3;

    it('labels a per-key burst rejection as rate-limited, not quota-exceeded', async () => {
      const user = await createUser('burst_type', 'free');
      const key = await redisKeyStore.generateApiKey(user.id, 'burst', { scopes: ['convert:write'] });
      const capacity = API_KEY_BURST_LIMITS.free.capacity;

      // The bucket refills while requests run, so a slow runner can need more than capacity + 1 calls.
      const maxAttempts = capacity * BURST_ATTEMPT_FACTOR;
      let last: Response | undefined;
      for (let i = 0; i < maxAttempts && last?.status !== 429; i++) {
        const formData = new FormData();
        formData.append('file', new File(['a,b\n1,2'], 'burst.csv', { type: 'text/csv' }));
        formData.append('targetFormat', 'json');
        last = await v1ConvertRoute(
          new NextRequest(`${BASE_URL}/api/v1/convert`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key.secretKey}` },
            body: formData,
          })
        );
      }

      expect(last?.status).toBe(429);
      const body = await last!.json();
      expect(body.type).toBe(RATE_LIMITED_TYPE);
      expect(body.type).not.toBe(QUOTA_EXCEEDED_TYPE);
      expect(Number(last!.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    });
  });

  describe('ownerless DLQ entries are purged', () => {
    let owner: User;

    beforeEach(async () => {
      owner = await createUser('dlq_purge');
    });

    afterEach(async () => {
      await webhookDispatcher.clearDlq(owner.id);
    });

    it('removes entries without an owner (and their signing secrets) on the next scan', async () => {
      const suffix = Math.random().toString(36).slice(2);
      const legacyId = `dlq_legacy_purge_${suffix}`;
      const ownedId = `dlq_owned_keep_${suffix}`;
      const base = {
        targetUrl: 'https://93.184.215.14/hooks/easyconvert',
        event: 'job.failed',
        payload: { jobId: suffix },
        failedAt: Date.now(),
        retryCount: 3,
        status: 'failed' as const,
      };
      await webhookDispatcher.saveToDlq({ ...base, id: legacyId, originalDeliveryId: `wh_${legacyId}`, secret: 'legacy_secret' });
      await webhookDispatcher.saveToDlq({
        ...base,
        id: ownedId,
        originalDeliveryId: `wh_${ownedId}`,
        secret: 'owned_secret',
        ownerUserId: owner.id,
      });

      const listed = (await webhookDispatcher.getDlqEntries(owner.id)).map((e) => e.id);
      expect(listed).toEqual([ownedId]);

      // White-box check of the in-memory store (no Redis in this suite): the legacy record is gone.
      const store = (webhookDispatcher as unknown as { inMemoryDlq: Map<string, { secret: string }> }).inMemoryDlq;
      expect(store.has(legacyId)).toBe(false);
      expect(store.get(ownedId)?.secret).toBe('owned_secret');
    });
  });
});
