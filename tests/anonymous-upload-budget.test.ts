import crypto from 'node:crypto';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as multipartPost } from '../src/app/api/storage/multipart/route';
import { POST as queueJobsPost } from '../src/app/api/queue/jobs/route';
import { DELETE as queueJobDelete } from '../src/app/api/queue/jobs/[id]/route';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { storageProvider } from '../src/lib/storage';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { getRetentionLedger } from '../src/lib/storage/retention-ledger';
import { sweepRetention } from '../src/lib/storage/retention-service';
import {
  ANONYMOUS_DAILY_UPLOAD_BYTES,
  ANONYMOUS_OPEN_UPLOADS_MAX,
  OPEN_UPLOAD_IDLE_MS,
  closeUpload,
  reserveUpload,
  resetAnonymousUploadBudget,
  touchUpload,
  type UploadBudgetRecord,
} from '../src/lib/api-keys/anonymous-upload-budget';

const BASE_URL = 'http://localhost:3000';
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const HOUR = 60 * 60 * 1000;
const DAY = '2026-11-01';
const NOW = Date.UTC(2026, 10, 1, 12);

const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
  resetAnonymousUploadBudget();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('the upload budget of an address bucket', () => {
  const policy = { maxOpenUploads: 2, dailyBytes: 2 * GIB, idleMs: HOUR };
  const request = (id: string, bytes: number, now = NOW) => ({ id, bytes, day: DAY, now, expiresAt: now + 24 * HOUR });

  function reserved(record: UploadBudgetRecord | undefined, id: string, bytes: number, now = NOW): UploadBudgetRecord {
    const result = reserveUpload(record, request(id, bytes, now), policy);
    if ('refusal' in result) throw new Error(`refused: ${result.refusal}`);
    return result.record;
  }

  it('keeps launch values that let a visitor send two files at the 1 GiB limit a day, two at a time', () => {
    expect(ANONYMOUS_OPEN_UPLOADS_MAX).toBe(2);
    expect(ANONYMOUS_DAILY_UPLOAD_BYTES).toBe(2 * GIB);
    expect(OPEN_UPLOAD_IDLE_MS).toBe(HOUR);
  });

  it('refuses a third open session and makes room when one ends', () => {
    let record = reserved(reserved(undefined, 'a', MIB), 'b', MIB);
    expect(reserveUpload(record, request('c', MIB), policy)).toEqual({ refusal: 'open-uploads' });
    record = closeUpload(record, 'a', 'completed');
    expect('record' in reserveUpload(record, request('c', MIB), policy)).toBe(true);
  });

  it('refuses a session past the bytes of the day, and returns the bytes of an aborted one but not of a completed one', () => {
    let record = reserved(undefined, 'a', 1.5 * GIB);
    expect(reserveUpload(record, request('b', 0.6 * GIB), policy)).toEqual({ refusal: 'daily-bytes' });
    expect('record' in reserveUpload(record, request('b', 0.5 * GIB), policy)).toBe(true);

    const completed = closeUpload(record, 'a', 'completed');
    expect(completed.bytes).toBe(1.5 * GIB);
    expect(reserveUpload(completed, request('b', 0.6 * GIB), policy)).toEqual({ refusal: 'daily-bytes' });

    record = closeUpload(record, 'a', 'aborted');
    expect(record.bytes).toBe(0);
  });

  it('stops counting an idle session as open while its bytes stay reserved, and a part makes it open again', () => {
    let record = reserved(reserved(undefined, 'a', GIB), 'b', 0.5 * GIB);
    const later = NOW + HOUR + 1;
    expect('record' in reserveUpload(record, request('c', 0.5 * GIB, later), policy)).toBe(true);
    expect(reserveUpload(record, request('c', 0.6 * GIB, later), policy)).toEqual({ refusal: 'daily-bytes' });

    record = touchUpload(record, 'a', later, policy);
    record = touchUpload(record, 'b', later, policy);
    expect(reserveUpload(record, request('c', MIB, later), policy)).toEqual({ refusal: 'open-uploads' });
  });

  it('returns the bytes of a session that expired without an end, and starts a new day at zero', () => {
    const record = reserved(undefined, 'a', 2 * GIB);
    const expired = reserveUpload(record, request('b', GIB, NOW + 24 * HOUR), policy);
    expect('record' in expired && expired.record.bytes).toBe(GIB);

    const nextDay = reserveUpload(record, { ...request('b', 2 * GIB, NOW + 2 * HOUR), day: '2026-11-02' }, policy);
    expect('record' in nextDay && nextDay.record.bytes).toBe(2 * GIB);
  });

  it('never returns bytes charged to an earlier day to a new one', () => {
    const record = reserved(undefined, 'a', GIB);
    const result = reserveUpload(record, { ...request('b', MIB, NOW + HOUR), day: '2026-11-02' }, policy);
    if ('refusal' in result) throw new Error('refused');
    expect(closeUpload(result.record, 'a', 'aborted').bytes).toBe(MIB);
  });
});

function from(address: string): Record<string, string> {
  return { 'x-forwarded-for': address };
}

async function account(): Promise<Record<string, string>> {
  const email = `budget_${Date.now()}_${crypto.randomBytes(6).toString('hex')}@budget.test`;
  const user = userStore.sanitizeUser(await userStore.createUser({ email, name: 'budget', tier: 'free' }));
  return { Cookie: `easyconvert_session=${createSessionToken(user)}` };
}

function multipart(action: string, body: unknown, headers: Record<string, string>): NextRequest {
  return new NextRequest(`${BASE_URL}/api/storage/multipart?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function initiate(headers: Record<string, string>, totalSize: number): Promise<Response> {
  const res = await multipartPost(multipart('initiate', { filename: 'big.csv', totalSize }, headers));
  if (res.status === 200) {
    const { uploadId } = await res.clone().json();
    cleanups.push(() => {
      s3Storage.abortMultipartUpload(uploadId);
    });
  }
  return res;
}

function part(uploadId: string, bytes: Buffer, headers: Record<string, string>): NextRequest {
  return new NextRequest(`${BASE_URL}/api/storage/multipart?action=chunk&uploadId=${encodeURIComponent(uploadId)}&partNumber=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...headers },
    body: new Uint8Array(bytes),
  });
}

/** A completed one-part upload of a CSV. */
async function completedUpload(headers: Record<string, string>): Promise<string> {
  const bytes = Buffer.from('a,b\n1,2\n');
  const opened = await initiate(headers, bytes.length);
  const { uploadId } = await opened.json();
  const stored = await multipartPost(part(uploadId, bytes, headers));
  const { etag } = await stored.json();
  const done = await multipartPost(multipart('complete', { uploadId, parts: [{ partNumber: 1, etag }] }, headers));
  const { key } = await done.json();
  cleanups.push(() => {
    s3Storage.deleteObject(key);
  });
  return key;
}

async function queueJob(storageKey: string, headers: Record<string, string>): Promise<string> {
  const res = await queueJobsPost(
    new NextRequest(`${BASE_URL}/api/queue/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ filename: 'a.csv', targetFormat: 'json', storageKey }),
    })
  );
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(200);
  cleanups.push(async () => {
    await queueJobDelete(new NextRequest(`${BASE_URL}/api/queue/jobs/${body.jobId}`, { method: 'DELETE' }), {
      params: Promise.resolve({ id: body.jobId }),
    });
  });
  return body.jobId;
}

describe('a visitor opens at most two uploads at once and declares at most 2 GiB a day', () => {
  it('refuses a third open upload with a sentence that says how to go on, and takes one again after an abort', async () => {
    const visitor = from('203.0.113.50');
    const first = await initiate(visitor, MIB);
    await initiate(visitor, MIB);

    const third = await initiate(visitor, MIB);
    expect(third.status).toBe(429);
    const refusal = await third.json();
    expect(refusal.type).toBe('https://api.easyconvert.io/problems/upload-budget-exceeded');
    expect(refusal.detail).toBe('Up to 2 uploads may be open at once without an account. Finish or cancel one, then try again.');

    const { uploadId } = await first.json();
    expect((await multipartPost(multipart('abort', { uploadId }, visitor))).status).toBe(200);
    expect((await initiate(visitor, MIB)).status).toBe(200);
  });

  it('refuses an upload past the bytes of the day once the open ones went idle, and an abort gives them back', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    cleanups.push(() => {
      vi.useRealTimers();
    });
    const visitor = from('203.0.113.51');
    const first = await initiate(visitor, GIB);
    expect((await initiate(visitor, GIB)).status).toBe(200);
    vi.setSystemTime(Date.now() + OPEN_UPLOAD_IDLE_MS + 1);

    const over = await initiate(visitor, MIB);
    expect(over.status).toBe(429);
    expect((await over.json()).detail).toBe('Without an account, uploads may total 2 GiB a day. The limit resets at midnight UTC.');

    const { uploadId } = await first.json();
    await multipartPost(multipart('abort', { uploadId }, visitor));
    expect((await initiate(visitor, MIB)).status).toBe(200);
  });

  it('counts the bucket of the address, so an address change is the same visitor and a new bucket is another', async () => {
    await initiate(from('2001:db8:5:6::1'), MIB);
    await initiate(from('2001:db8:5:6::2'), MIB);
    expect((await initiate(from('2001:db8:5:6::3'), MIB)).status).toBe(429);
    expect((await initiate(from('2001:db8:5:7::1'), MIB)).status).toBe(200);
  });

  it('does not meter an account', async () => {
    const own = await account();
    for (let i = 0; i < 3; i++) expect((await initiate(own, GIB)).status).toBe(200);
  });

  it('does not meter the shared identity of requests no proxy attributes', async () => {
    vi.stubEnv('TRUSTED_PROXIES', '');
    for (let i = 0; i < 3; i++) expect((await initiate({}, MIB)).status).toBe(200);
  });
});

describe('an upload opens only when a job could start for the caller', () => {
  it('refuses the upload when the daily conversions are used up', async () => {
    vi.spyOn(redisKeyStore, 'getQuotaUsage').mockResolvedValue({ tier: 'free', dailyLimit: 10, usedToday: 10, remaining: 0, resetAt: 0 });

    const res = await initiate(from('203.0.113.52'), MIB);

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.type).toBe('https://api.easyconvert.io/problems/quota-exceeded');
    expect(body.detail).toBe('The daily limit of 10 conversions is used up. It resets at midnight UTC.');
  });

  it('refuses the upload while as many conversions are in progress as the plan allows', async () => {
    vi.stubEnv('CONVERSION_CONCURRENCY_FREE', '1');
    const visitor = from('203.0.113.53');
    const key = await completedUpload(visitor);
    await queueJob(key, visitor);

    const res = await initiate(visitor, MIB);

    expect(res.status).toBe(429);
    expect((await res.json()).type).toBe('https://api.easyconvert.io/problems/concurrency-limit');
  });
});

describe('a completed upload nobody converts does not stay', () => {
  it('is deleted by the sweep an hour after it was completed', async () => {
    const key = await completedUpload(from('203.0.113.54'));
    const record = await getRetentionLedger().get(key);
    expect(record?.deleteAt).toBeGreaterThan(Date.now() + HOUR - 60_000);
    expect(record?.deleteAt).toBeLessThanOrEqual(Date.now() + HOUR);

    await sweepRetention(storageProvider, Date.now() + HOUR - 60_000);
    expect(await storageProvider.stat(key)).toBeTruthy();
    await sweepRetention(storageProvider, Date.now() + HOUR + 1);
    expect(await storageProvider.stat(key)).toBeFalsy();
  });

  it('is deleted at once by the visitor that gave it up, from any address, and is then gone', async () => {
    const key = await completedUpload(from('203.0.113.55'));

    const res = await multipartPost(multipart('discard', { key }, from('198.51.100.55')));

    expect(res.status).toBe(200);
    expect(await storageProvider.stat(key)).toBeFalsy();
    expect((await multipartPost(multipart('discard', { key }, from('203.0.113.55')))).status).toBe(404);
  });

  it('is not deleted while a job reads it', async () => {
    const visitor = from('203.0.113.56');
    const key = await completedUpload(visitor);
    await queueJob(key, visitor);

    const res = await multipartPost(multipart('discard', { key }, visitor));

    expect(res.status).toBe(409);
    expect(await storageProvider.stat(key)).toBeTruthy();
  });

  it('keeps an account upload from everyone but its owner', async () => {
    const own = await account();
    const key = await completedUpload(own);
    expect(key).toMatch(/^conversions\//);

    expect((await multipartPost(multipart('discard', { key }, await account()))).status).toBe(404);
    expect((await multipartPost(multipart('discard', { key }, from('203.0.113.57')))).status).toBe(404);
    expect((await multipartPost(multipart('discard', { key }, own))).status).toBe(200);
  });
});

describe('an Idempotency-Key makes opening an upload and starting a job safe to send again', () => {
  it('answers a repeat of the opening with the same session and reserves its budget once', async () => {
    const visitor = { ...from('203.0.113.58'), 'Idempotency-Key': crypto.randomUUID() };
    const first = await (await initiate(visitor, MIB)).json();
    const repeat = await initiate(visitor, MIB);

    expect(repeat.headers.get('idempotent-replayed')).toBe('true');
    expect((await repeat.json()).uploadId).toBe(first.uploadId);
    expect((await initiate(from('203.0.113.58'), MIB)).status).toBe(200);
  });

  it('answers a repeat of the start with the same job, from another address too', async () => {
    const visitor = from('203.0.113.59');
    const key = await completedUpload(visitor);
    const idempotencyKey = crypto.randomUUID();
    const send = (headers: Record<string, string>) =>
      queueJobsPost(
        new NextRequest(`${BASE_URL}/api/queue/jobs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey, ...headers },
          body: JSON.stringify({ filename: 'a.csv', targetFormat: 'json', storageKey: key }),
        })
      );

    const first = await (await send(visitor)).json();
    cleanups.push(async () => {
      await queueJobDelete(new NextRequest(`${BASE_URL}/api/queue/jobs/${first.jobId}`, { method: 'DELETE' }), {
        params: Promise.resolve({ id: first.jobId }),
      });
    });
    const repeat = await send(from('198.51.100.59'));

    expect(repeat.status).toBe(200);
    expect((await repeat.json()).jobId).toBe(first.jobId);
  });
});
