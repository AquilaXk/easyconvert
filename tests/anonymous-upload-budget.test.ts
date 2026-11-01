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
import { getIdempotencyStore } from '../src/lib/api/idempotency';
import { mayPresignDownload, sweepRetention } from '../src/lib/storage/retention-service';
import {
  ANONYMOUS_DAILY_UPLOAD_BYTES,
  ANONYMOUS_OPEN_UPLOADS_MAX,
  OPEN_UPLOAD_IDLE_MS,
  closeUpload,
  reserveUpload,
  resumeUpload,
  type UploadBudgetRecord,
} from '../src/lib/api-keys/anonymous-upload-budget';
import { MemoryBudgetStore, RECORD_TTL_MS } from '../src/lib/api-keys/upload-budget-store';

const BASE_URL = 'http://localhost:3000';
const UNAVAILABLE_DETAIL = 'A service this upload needs is temporarily unavailable. Retry the request shortly.';
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const HOUR = 60 * 60 * 1000;
const DAY = '2026-11-01';
const NOW = Date.UTC(2026, 10, 1, 12);

const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
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

  function resumed(record: UploadBudgetRecord, id: string, now: number): UploadBudgetRecord {
    const result = resumeUpload(record, id, now, policy);
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

    record = resumed(record, 'a', later);
    record = resumed(record, 'b', later);
    expect(reserveUpload(record, request('c', MIB, later), policy)).toEqual({ refusal: 'open-uploads' });
  });

  it('opens an idle session again only while fewer than the most sessions are open', () => {
    let record = reserved(reserved(undefined, 'a', MIB), 'b', MIB);
    const later = NOW + HOUR + 1;
    record = reserved(reserved(record, 'c', MIB, later), 'd', MIB, later);

    expect(resumeUpload(record, 'a', later + 10, policy)).toEqual({ refusal: 'open-uploads' });
    expect('record' in resumeUpload(record, 'c', later + 10, policy)).toBe(true);
    record = closeUpload(record, 'c', 'completed');
    expect('record' in resumeUpload(record, 'a', later + 10, policy)).toBe(true);
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

function csv(length: number): Buffer {
  return Buffer.alloc(length, 'a');
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

  it('turns uploads without an account off while no proxy attributes requests, and says which setting turns them on', async () => {
    vi.stubEnv('TRUSTED_PROXIES', '');

    const res = await initiate({}, MIB);

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.type).toBe('https://api.easyconvert.io/problems/client-ip-trust-unconfigured');
    expect(body.detail).toContain('TRUSTED_PROXIES');
    expect((await initiate(await account(), MIB)).status).toBe(200);
  });

  it('refuses a session that declares no byte, which the budget could not count', async () => {
    const res = await initiate(from('203.0.113.60'), 0);
    expect(res.status).toBe(400);
    expect((await res.json()).detail).toBe('"totalSize" must be at least 1 byte.');
  });

  it('refuses a part of an idle session while as many others are open, and takes it once one ends', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    cleanups.push(() => {
      vi.useRealTimers();
    });
    const visitor = from('203.0.113.61');
    const idle = await (await initiate(visitor, MIB)).json();
    await initiate(visitor, MIB);
    vi.setSystemTime(NOW + OPEN_UPLOAD_IDLE_MS + 1);
    const third = await (await initiate(visitor, MIB)).json();
    await initiate(visitor, MIB);

    const refused = await multipartPost(part(idle.uploadId, csv(MIB), visitor));
    expect(refused.status).toBe(429);
    expect((await refused.json()).type).toBe('https://api.easyconvert.io/problems/upload-budget-exceeded');

    await multipartPost(multipart('abort', { uploadId: third.uploadId }, visitor));
    expect((await multipartPost(part(idle.uploadId, csv(MIB), visitor))).status).toBe(200);
  });
});

describe('a budget store that cannot be reached', () => {
  const down = () => {
    const fail = async () => {
      throw new Error('Connection is closed.');
    };
    vi.spyOn(redisKeyStore, 'getRedisClient').mockReturnValue({ get: fail, eval: fail, set: fail } as never);
  };

  it('does not refuse a part of an open session, whose bytes were reserved when it opened', async () => {
    const visitor = from('203.0.113.62');
    const { uploadId } = await (await initiate(visitor, 8)).json();
    down();

    const res = await multipartPost(part(uploadId, Buffer.from('a,b\n1,2\n'), visitor));

    expect(res.status).toBe(200);
    expect(s3Storage.getUploadedParts(uploadId)).toHaveLength(1);
  });

  it('answers an abort the store took, and the bytes come back when the reservation expires', async () => {
    const visitor = from('203.0.113.63');
    const { uploadId } = await (await initiate(visitor, 8)).json();
    down();

    const res = await multipartPost(multipart('abort', { uploadId }, visitor));

    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(s3Storage.getUploadSession(uploadId)).toBeUndefined();
  });

  it('answers a part, a completion and an abort that failed without an HTTP status with 503, worth sending again', async () => {
    const visitor = from('203.0.113.64');
    const { uploadId } = await (await initiate(visitor, 8)).json();
    vi.spyOn(s3Storage, 'uploadPartStream').mockRejectedValueOnce(new Error('disk went away at /var/lib/easyconvert/x'));
    vi.spyOn(s3Storage, 'abortMultipartUpload').mockImplementationOnce(() => {
      throw new Error('store unreachable');
    });

    const failedPart = await multipartPost(part(uploadId, Buffer.from('a,b\n1,2\n'), visitor));
    expect(failedPart.status).toBe(503);
    expect(failedPart.headers.get('retry-after')).toBe('5');
    expect((await failedPart.json()).detail).toBe(UNAVAILABLE_DETAIL);

    const failedAbort = await multipartPost(multipart('abort', { uploadId }, visitor));
    expect(failedAbort.status).toBe(503);
    expect((await failedAbort.json()).detail).toBe(UNAVAILABLE_DETAIL);
  });

  it('names no message of the store or the budget to the caller, only a fixed sentence', async () => {
    const visitor = from('203.0.113.69');
    const { uploadId } = await (await initiate(visitor, 8)).json();
    vi.spyOn(s3Storage, 'abortMultipartUpload').mockImplementationOnce(() => {
      throw new Error('connect ECONNREFUSED 10.0.0.7:6379');
    });

    const res = await multipartPost(multipart('abort', { uploadId }, visitor));

    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain('10.0.0.7');
  });

  it('answers a completion the store took with the stored file even when the budget cannot be closed', async () => {
    const visitor = from('203.0.113.70');
    const bytes = Buffer.from('a,b\n1,2\n');
    const { uploadId } = await (await initiate(visitor, bytes.length)).json();
    const { etag } = await (await multipartPost(part(uploadId, bytes, visitor))).json();
    down();

    const res = await multipartPost(multipart('complete', { uploadId, parts: [{ partNumber: 1, etag }] }, visitor));

    expect(res.status).toBe(200);
    const { key } = await res.json();
    cleanups.push(() => {
      s3Storage.deleteObject(key);
    });
    expect(await s3Storage.stat(key)).toMatchObject({ size: bytes.length });
  });

  it('answers a completion whose upload could not be recorded with a refusal not worth sending again, and the file is gone', async () => {
    const visitor = from('203.0.113.71');
    const bytes = Buffer.from('a,b\n1,2\n');
    const { uploadId } = await (await initiate(visitor, bytes.length)).json();
    const { etag } = await (await multipartPost(part(uploadId, bytes, visitor))).json();
    const ledger = getRetentionLedger();
    vi.spyOn(ledger, 'update').mockRejectedValueOnce(new Error('ledger down at /var/lib/easyconvert/retention'));
    const deleted = vi.spyOn(s3Storage, 'deleteObject');

    const res = await multipartPost(multipart('complete', { uploadId, parts: [{ partNumber: 1, etag }] }, visitor));

    expect(res.status).toBe(500);
    expect(res.headers.get('retry-after')).toBeNull();
    expect((await res.json()).detail).toBe('The upload could not be recorded, so it cannot be converted. Upload the file again.');
    expect(deleted).toHaveBeenCalledTimes(1);
    expect(await s3Storage.stat(deleted.mock.calls[0][0])).toBeNull();
  });

  it('gives the bytes back when an opening fails and so does the abort of its session, and answers with the error of the opening', async () => {
    const visitor = from('203.0.113.73');
    vi.spyOn(MemoryBudgetStore.prototype, 'link').mockRejectedValueOnce(new Error('link failed'));
    vi.spyOn(s3Storage, 'abortMultipartUpload').mockImplementationOnce(() => {
      throw new Error('abort failed');
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const failed = await initiate(visitor, MIB);

    expect(failed.status).toBe(500);
    expect(logged.mock.calls.find(([message]) => String(message).includes('initiate failed'))?.[1]).toMatchObject({ message: 'link failed' });
    expect((await initiate(visitor, MIB)).status).toBe(200);
    expect((await initiate(visitor, MIB)).status).toBe(200);
  });

  it('refuses to open an upload, since it cannot reserve the bytes', async () => {
    down();
    const res = await initiate(from('203.0.113.65'), MIB);
    expect(res.status).toBe(500);
  });
});

describe('the budgets of a process without Redis', () => {
  it('forgets a record and a link once their time has passed, also those nobody reads again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    cleanups.push(() => {
      vi.useRealTimers();
    });
    const store = new MemoryBudgetStore();
    await store.update('anon:a', () => ({ day: DAY, bytes: MIB, open: {} }));
    await store.link('up-a', { bucket: 'anon:a', reservation: 'r' }, NOW + HOUR);
    expect(store.size).toBe(2);

    vi.setSystemTime(NOW + RECORD_TTL_MS + 1);
    await store.update('anon:b', () => ({ day: DAY, bytes: MIB, open: {} }));
    await store.link('up-b', { bucket: 'anon:b', reservation: 'r' }, Date.now() + HOUR);

    expect(store.size).toBe(2);
    expect(await store.lookup('up-a')).toBeUndefined();
    let seen: UploadBudgetRecord | undefined = { day: DAY, bytes: 1, open: {} };
    await store.update('anon:a', (current) => {
      seen = current;
      return undefined;
    });
    expect(seen).toBeUndefined();
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

  it('keeps an account upload while a job reads it, and its owner can still get a signed link to it', async () => {
    const own = await account();
    const key = await completedUpload(own);
    await queueJob(key, own);

    const res = await multipartPost(multipart('discard', { key }, own));

    expect(res.status).toBe(409);
    expect(await storageProvider.stat(key)).toBeTruthy();
    expect(await mayPresignDownload(key)).toBe(true);
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

  it('refuses a key sent again with another body', async () => {
    const visitor = { ...from('203.0.113.59'), 'Idempotency-Key': crypto.randomUUID() };
    await initiate(visitor, MIB);

    const other = await initiate(visitor, 2 * MIB);

    expect(other.status).toBe(422);
    expect((await other.json()).type).toBe('https://api.easyconvert.io/problems/idempotency-key-reused');
  });

  it('answers a body that is not a JSON object like one without the fields, and keeps no key for it', async () => {
    const visitor = { ...from('203.0.113.60'), 'Idempotency-Key': crypto.randomUUID() };

    const first = await multipartPost(multipart('initiate', [1, 2, 3], visitor));
    const again = await initiate(visitor, MIB);

    expect(first.status).toBe(400);
    expect(again.status).toBe(200);
    expect(again.headers.get('idempotent-replayed')).toBeNull();
  });

  it('keeps the key of one address bucket from answering another with its upload', async () => {
    const idempotencyKey = 'static-key';
    const first = await (await initiate({ ...from('203.0.113.66'), 'Idempotency-Key': idempotencyKey }, MIB)).json();

    const other = await initiate({ ...from('198.51.100.66'), 'Idempotency-Key': idempotencyKey }, MIB);

    expect(other.status).toBe(200);
    expect(other.headers.get('idempotent-replayed')).toBeNull();
    expect((await other.json()).uploadId).not.toBe(first.uploadId);
  });

  it('answers a repeat of the start in the same address bucket with the same job, and another bucket with a job of its own', async () => {
    const visitor = from('2001:db8:9:1::1');
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
    const cancelLater = (jobId: string) =>
      cleanups.push(async () => {
        await queueJobDelete(new NextRequest(`${BASE_URL}/api/queue/jobs/${jobId}`, { method: 'DELETE' }), {
          params: Promise.resolve({ id: jobId }),
        });
      });

    const first = await (await send(visitor)).json();
    cancelLater(first.jobId);
    const repeat = await send(from('2001:db8:9:1::2'));
    expect(repeat.status).toBe(200);
    expect((await repeat.json()).jobId).toBe(first.jobId);

    const elsewhere = await (await send(from('2001:db8:9:2::1'))).json();
    cancelLater(elsewhere.jobId);
    expect(elsewhere.jobId).not.toBe(first.jobId);
  });

  it('answers a repeat of the start with the job even when that job used the last conversion of the day', async () => {
    vi.stubEnv('ANONYMOUS_DAILY_LIMIT', '1');
    const visitor = from('203.0.113.67');
    const key = await completedUpload(visitor);
    const idempotencyKey = crypto.randomUUID();
    const send = () =>
      queueJobsPost(
        new NextRequest(`${BASE_URL}/api/queue/jobs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey, ...visitor },
          body: JSON.stringify({ filename: 'a.csv', targetFormat: 'json', storageKey: key }),
        })
      );

    const first = await send();
    const firstBody = await first.json();
    expect(first.status, JSON.stringify(firstBody)).toBe(200);
    cleanups.push(async () => {
      await queueJobDelete(new NextRequest(`${BASE_URL}/api/queue/jobs/${firstBody.jobId}`, { method: 'DELETE' }), {
        params: Promise.resolve({ id: firstBody.jobId }),
      });
    });
    const repeat = await send();

    expect(repeat.status).toBe(200);
    expect((await repeat.json()).jobId).toBe(firstBody.jobId);
  });

  it('keeps the lock of an opening the idempotency store could not record, so a repeat is told to wait and opens no second session', async () => {
    const visitor = { ...from('203.0.113.161'), 'Idempotency-Key': crypto.randomUUID() };
    vi.spyOn(getIdempotencyStore(), 'complete').mockRejectedValueOnce(new Error('redis: connection reset'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const first = await initiate(visitor, MIB);
    const repeat = await initiate(visitor, MIB);

    expect(first.status).toBe(200);
    expect(repeat.status).toBe(409);
    expect((await repeat.json()).type).toBe('https://api.easyconvert.io/problems/idempotency-key-in-flight');
  });

  it('keeps the lock of a job start the idempotency store could not record, so a repeat queues no second job and reserves no second unit', async () => {
    const visitor = from('203.0.113.162');
    const key = await completedUpload(visitor);
    const idempotencyKey = crypto.randomUUID();
    vi.spyOn(getIdempotencyStore(), 'complete').mockRejectedValueOnce(new Error('redis: connection reset'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const send = () =>
      queueJobsPost(
        new NextRequest(`${BASE_URL}/api/queue/jobs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey, ...visitor },
          body: JSON.stringify({ filename: 'a.csv', targetFormat: 'json', storageKey: key }),
        })
      );

    const first = await send();
    const firstBody = await first.json();
    expect(first.status, JSON.stringify(firstBody)).toBe(200);
    cleanups.push(async () => {
      await queueJobDelete(new NextRequest(`${BASE_URL}/api/queue/jobs/${firstBody.jobId}`, { method: 'DELETE' }), {
        params: Promise.resolve({ id: firstBody.jobId }),
      });
    });
    const repeat = await send();

    expect(repeat.status).toBe(409);
    expect(repeat.headers.get('retry-after')).not.toBeNull();
  });

  it('answers a repeat of the completion with the file the first one stored', async () => {
    const visitor = from('203.0.113.68');
    const bytes = Buffer.from('a,b\n1,2\n');
    const { uploadId } = await (await initiate(visitor, bytes.length)).json();
    const { etag } = await (await multipartPost(part(uploadId, bytes, visitor))).json();
    const complete = () =>
      multipartPost(multipart('complete', { uploadId, parts: [{ partNumber: 1, etag }] }, { ...visitor, 'Idempotency-Key': `complete-${uploadId}` }));

    const first = await (await complete()).json();
    cleanups.push(() => {
      s3Storage.deleteObject(first.key);
    });
    const repeat = await complete();

    expect(repeat.status).toBe(200);
    expect((await repeat.json()).key).toBe(first.key);
  });

  it('answers a repeat of the completion from another address of the visitor with the file the first one stored', async () => {
    const bytes = Buffer.from('a,b\n1,2\n');
    const { uploadId } = await (await initiate(from('203.0.113.72'), bytes.length)).json();
    const { etag } = await (await multipartPost(part(uploadId, bytes, from('203.0.113.72')))).json();
    const complete = (address: string) =>
      multipartPost(multipart('complete', { uploadId, parts: [{ partNumber: 1, etag }] }, { ...from(address), 'Idempotency-Key': `moved-${uploadId}` }));

    const first = await (await complete('203.0.113.72')).json();
    cleanups.push(() => {
      s3Storage.deleteObject(first.key);
    });
    const repeat = await complete('198.51.100.72');

    expect(repeat.status).toBe(200);
    expect(repeat.headers.get('idempotent-replayed')).toBe('true');
    expect((await repeat.json()).key).toBe(first.key);
  });
});

describe('a completion the store took is final', () => {
  async function stagedUpload(address: string): Promise<{ visitor: Record<string, string>; uploadId: string; etag: string; bytes: Buffer }> {
    const visitor = from(address);
    const bytes = Buffer.from('a,b\n1,2\n');
    const { uploadId } = await (await initiate(visitor, bytes.length)).json();
    const { etag } = await (await multipartPost(part(uploadId, bytes, visitor))).json();
    return { visitor, uploadId, etag, bytes };
  }

  it('answers with the stored file when the idempotency store cannot keep the answer, and logs it', async () => {
    const { visitor, uploadId, etag } = await stagedUpload('203.0.113.81');
    vi.spyOn(getIdempotencyStore(), 'complete').mockRejectedValueOnce(new Error('redis: connection reset'));
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await multipartPost(
      multipart('complete', { uploadId, parts: [{ partNumber: 1, etag }] }, { ...visitor, 'Idempotency-Key': `lost-${uploadId}` })
    );

    expect(res.status).toBe(200);
    const { key } = await res.json();
    cleanups.push(() => {
      s3Storage.deleteObject(key);
    });
    expect(warned.mock.calls.some(([message]) => String(message).includes('idempotency'))).toBe(true);
  });

  it('answers a repeat of a completion the idempotency store could not record with the first answer, not with a missing session', async () => {
    const { visitor, uploadId, etag } = await stagedUpload('203.0.113.85');
    vi.spyOn(getIdempotencyStore(), 'complete').mockRejectedValueOnce(new Error('redis: connection reset'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const complete = () =>
      multipartPost(multipart('complete', { uploadId, parts: [{ partNumber: 1, etag }] }, { ...visitor, 'Idempotency-Key': `unrecorded-${uploadId}` }));

    const first = await complete();
    const firstBody = await first.json();
    cleanups.push(() => {
      s3Storage.deleteObject(firstBody.key);
    });
    const repeat = await complete();

    expect(first.status).toBe(200);
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual(firstBody);
  });

  it('answers a repeat of a completion with the first answer without an idempotency key, from the receipt of the completion', async () => {
    const { visitor, uploadId, etag } = await stagedUpload('203.0.113.87');
    const complete = () => multipartPost(multipart('complete', { uploadId, parts: [{ partNumber: 1, etag }] }, visitor));

    const first = await complete();
    const firstBody = await first.json();
    cleanups.push(() => {
      s3Storage.deleteObject(firstBody.key);
    });
    const repeat = await complete();

    expect(repeat.status).toBe(200);
    expect(repeat.headers.get('idempotent-replayed')).toBeNull();
    expect(await repeat.json()).toEqual(firstBody);
  });

  it('answers that repeat for an anonymous visitor at another address, and with a missing session for an account', async () => {
    const { visitor, uploadId, etag } = await stagedUpload('203.0.113.88');
    const complete = (headers: Record<string, string>) => multipartPost(multipart('complete', { uploadId, parts: [{ partNumber: 1, etag }] }, headers));
    const firstBody = await (await complete(visitor)).json();
    cleanups.push(() => {
      s3Storage.deleteObject(firstBody.key);
    });

    const moved = await complete(from('198.51.100.88'));
    const signedIn = await complete(await account());

    expect(moved.status).toBe(200);
    expect((await moved.json()).key).toBe(firstBody.key);
    expect(signedIn.status).toBe(404);
  });

  it('answers a repeat with a missing session once the stored file is gone', async () => {
    const { visitor, uploadId, etag } = await stagedUpload('203.0.113.89');
    const complete = () => multipartPost(multipart('complete', { uploadId, parts: [{ partNumber: 1, etag }] }, visitor));
    const { key } = await (await complete()).json();
    expect((await multipartPost(multipart('discard', { key }, visitor))).status).toBe(200);

    expect((await complete()).status).toBe(404);
  });

  it('answers the completion when the receipt cannot be kept, and logs it', async () => {
    const { visitor, uploadId, etag } = await stagedUpload('203.0.113.90');
    const ledger = getRetentionLedger();
    const update = ledger.update.bind(ledger);
    vi.spyOn(ledger, 'update').mockImplementation(async (key, change) => {
      if (key.startsWith('upload-completion/')) throw new Error('ledger down');
      return update(key, change);
    });
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await multipartPost(multipart('complete', { uploadId, parts: [{ partNumber: 1, etag }] }, visitor));
    const { key } = await res.json();
    cleanups.push(() => {
      s3Storage.deleteObject(key);
    });

    expect(res.status).toBe(200);
    expect(warned.mock.calls.some(([message]) => String(message).includes('receipt'))).toBe(true);
  });

  it('answers a completion whose record and whose cleanup both failed with the refusal, and logs the key it could not remove', async () => {
    const { visitor, uploadId, etag } = await stagedUpload('203.0.113.82');
    vi.spyOn(getRetentionLedger(), 'update').mockRejectedValueOnce(new Error('ledger down'));
    const deleted = vi.spyOn(s3Storage, 'deleteObject').mockRejectedValueOnce(new Error('store down at /var/data'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await multipartPost(multipart('complete', { uploadId, parts: [{ partNumber: 1, etag }] }, visitor));

    expect(res.status).toBe(500);
    expect((await res.json()).detail).toBe('The upload could not be recorded, so it cannot be converted. Upload the file again.');
    const key = deleted.mock.calls[0][0];
    expect(warned.mock.calls.some(([message]) => String(message).includes(key))).toBe(true);
    cleanups.push(() => {
      s3Storage.deleteObject(key);
    });
  });

  it('closes the budget of an upload whose assembled size is not the declared one', async () => {
    const { visitor, uploadId, etag, bytes } = await stagedUpload('203.0.113.83');
    vi.spyOn(s3Storage, 'completeMultipartUpload').mockImplementationOnce(() => ({
      location: '/api/storage/file/uploads%2Fmismatch.csv',
      key: 'uploads/mismatch.csv',
      size: bytes.length + 1,
      etag: '"e"',
    }));

    const res = await multipartPost(multipart('complete', { uploadId, parts: [{ partNumber: 1, etag }] }, visitor));

    expect(res.status).toBe(400);
    expect((await initiate(visitor, MIB)).status).toBe(200);
    expect((await initiate(visitor, MIB)).status).toBe(200);
  });

  it('answers the final 400 and closes the budget when the assembled upload is not the declared size and its removal fails, and logs the key', async () => {
    const { visitor, uploadId, etag, bytes } = await stagedUpload('203.0.113.86');
    vi.spyOn(s3Storage, 'completeMultipartUpload').mockImplementationOnce(() => ({
      location: '/api/storage/file/uploads%2Fmismatch-removal.csv',
      key: 'uploads/mismatch-removal.csv',
      size: bytes.length + 1,
      etag: '"e"',
    }));
    const removal = vi.spyOn(s3Storage, 'deleteObject').mockRejectedValueOnce(new Error('store down at /var/data'));
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await multipartPost(multipart('complete', { uploadId, parts: [{ partNumber: 1, etag }] }, visitor));

    expect(res.status).toBe(400);
    expect((await res.json()).detail).toContain('assembled upload holds');
    expect(removal).toHaveBeenCalledWith('uploads/mismatch-removal.csv');
    expect(warned.mock.calls.some(([message]) => String(message).includes('uploads/mismatch-removal.csv'))).toBe(true);
    expect((await initiate(visitor, MIB)).status).toBe(200);
    expect((await initiate(visitor, MIB)).status).toBe(200);
  });

  it('builds no idempotency scope from an upload id that is not an id', async () => {
    const visitor = from('203.0.113.84');
    const acquire = vi.spyOn(getIdempotencyStore(), 'acquire');

    for (const uploadId of ['x'.repeat(5000), 'up 1\n2']) {
      const res = await multipartPost(multipart('complete', { uploadId, parts: [] }, { ...visitor, 'Idempotency-Key': 'junk' }));
      expect(res.status).toBe(404);
    }
    expect(acquire).not.toHaveBeenCalled();
  });
});

describe('a job start reserves its conversion when it runs, and gives it back when no job is queued', () => {
  it('leaves the day untouched by a refused start', async () => {
    vi.stubEnv('ANONYMOUS_DAILY_LIMIT', '1');
    const visitor = from('203.0.113.69');
    const key = await completedUpload(visitor);
    const refused = await queueJobsPost(
      new NextRequest(`${BASE_URL}/api/queue/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...visitor },
        body: JSON.stringify({ filename: 'a.unknownformat', targetFormat: 'json', storageKey: key }),
      })
    );
    expect(refused.status).toBe(400);

    await queueJob(key, visitor);
  });
});

describe('a signed part link', () => {
  it('is not given for an upload without an account, whose parts go through the part action', async () => {
    const visitor = from('203.0.113.70');
    const { uploadId, key } = await (await initiate(visitor, MIB)).json();

    const res = await multipartPost(multipart('presign', { type: 'upload', key, uploadId, partNumber: 1 }, visitor));

    expect(res.status).toBe(403);
    expect((await res.json()).detail).toContain('action=chunk');
  });
});
