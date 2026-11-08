import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { POST as v1JobsPost } from '../src/app/api/v1/jobs/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { InMemoryIdempotencyStore, setIdempotencyStore } from '../src/lib/api/idempotency';
import { createSessionToken } from '../src/lib/auth/session';
import { userStore } from '../src/lib/auth/user-store';
import { storageProvider } from '../src/lib/storage';

/**
 * An `Idempotency-Key` keeps the answer of a request that did its work and nothing else: a refusal (a quota that is
 * spent for now, a file that is not stored yet) does not stop the same request from succeeding when the cause is gone.
 */

const CSV = Buffer.from('name,score\nAlice,100\n');
let store: InMemoryIdempotencyStore;
let cookie: Record<string, string>;
let userId: string;

beforeEach(async () => {
  store = new InMemoryIdempotencyStore();
  setIdempotencyStore(store);
  const email = `idem_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@idempotency.test`;
  const user = userStore.sanitizeUser(await userStore.createUser({ email, name: 'Idem', tier: 'pro' }));
  userId = user.id;
  cookie = { Cookie: `easyconvert_session=${createSessionToken(user)}` };
});

afterEach(() => {
  vi.restoreAllMocks();
  setIdempotencyStore(null);
});

function jobRequest(key: string, storageKey: string): NextRequest {
  return new NextRequest('http://localhost/api/v1/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, ...cookie },
    body: JSON.stringify({ originalFilename: 'scores.csv', sourceFormat: 'csv', targetFormat: 'json', storageKey }),
  });
}

function convertRequest(key: string): NextRequest {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(CSV)], 'scores.csv', { type: 'text/csv' }));
  form.append('targetFormat', 'json');
  return new NextRequest('http://localhost/api/v1/convert', { method: 'POST', headers: { 'Idempotency-Key': key, ...cookie }, body: form });
}

/** Spends the conversions of the day, and returns what gives them back. */
async function spendTheDay(): Promise<() => void> {
  const { remaining } = await redisKeyStore.getQuotaUsage(userId);
  expect((await redisKeyStore.deductQuota(userId, remaining)).allowed).toBe(true);
  return () => redisKeyStore.resetStore();
}

describe('POST /api/v1/jobs under an Idempotency-Key', () => {
  it('does not keep the 404 of a file that is not stored yet, so the same request succeeds once it is', async () => {
    const key = `job-${crypto.randomUUID()}`;
    const storageKey = `uploads/idem-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.csv`;

    const refused = await v1JobsPost(jobRequest(key, storageKey));
    expect(refused.status).toBe(404);

    await storageProvider.saveObject(storageKey, CSV, 'text/csv', 'scores.csv');
    try {
      const accepted = await v1JobsPost(jobRequest(key, storageKey));
      expect(accepted.status).toBe(202);
      expect(accepted.headers.get('idempotent-replayed')).toBeNull();
    } finally {
      await storageProvider.deleteObject(storageKey);
    }
  });

  it('does not keep the 429 of a spent quota, so the same request succeeds once there is a conversion left', async () => {
    const key = `job-${crypto.randomUUID()}`;
    const storageKey = `uploads/idem-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.csv`;
    await storageProvider.saveObject(storageKey, CSV, 'text/csv', 'scores.csv');
    try {
      const giveBack = await spendTheDay();
      const refused = await v1JobsPost(jobRequest(key, storageKey));
      expect(refused.status).toBe(429);
      giveBack();

      const accepted = await v1JobsPost(jobRequest(key, storageKey));
      expect(accepted.status).toBe(202);
      expect(accepted.headers.get('idempotent-replayed')).toBeNull();
    } finally {
      await storageProvider.deleteObject(storageKey);
    }
  });

  it('keeps the answer of the job it queued and replays it', async () => {
    const key = `job-${crypto.randomUUID()}`;
    const storageKey = `uploads/idem-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.csv`;
    await storageProvider.saveObject(storageKey, CSV, 'text/csv', 'scores.csv');
    try {
      const first = await v1JobsPost(jobRequest(key, storageKey));
      expect(first.status).toBe(202);
      const jobId = (await first.json()).jobId;

      const repeat = await v1JobsPost(jobRequest(key, storageKey));
      expect(repeat.status).toBe(202);
      expect(repeat.headers.get('idempotent-replayed')).toBe('true');
      expect((await repeat.json()).jobId).toBe(jobId);
    } finally {
      await storageProvider.deleteObject(storageKey);
    }
  });

  it('answers the queued job with 202 when the idempotency store cannot record the answer, instead of a 500 the client would retry', async () => {
    const key = `job-${crypto.randomUUID()}`;
    const storageKey = `uploads/idem-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.csv`;
    await storageProvider.saveObject(storageKey, CSV, 'text/csv', 'scores.csv');
    vi.spyOn(store, 'complete').mockRejectedValue(new Error('redis unreachable'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const accepted = await v1JobsPost(jobRequest(key, storageKey));
      expect(accepted.status).toBe(202);
      expect((await accepted.json()).jobId).toBeTypeOf('string');
    } finally {
      await storageProvider.deleteObject(storageKey);
    }
  });
});

describe('POST /api/v1/convert under an Idempotency-Key', () => {
  it('does not keep the 429 of a spent quota, so the same request succeeds once there is a conversion left', async () => {
    const key = `convert-${crypto.randomUUID()}`;
    const giveBack = await spendTheDay();
    const refused = await v1ConvertPost(convertRequest(key));
    expect(refused.status).toBe(429);
    giveBack();

    const converted = await v1ConvertPost(convertRequest(key));
    expect(converted.status, await converted.clone().text().then((t) => t.slice(0, 200))).toBe(200);
    expect(converted.headers.get('idempotent-replayed')).toBeNull();
  });
});
