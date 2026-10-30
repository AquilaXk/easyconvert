import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { GET as downloadRoute } from '../src/app/api/storage/file/[...key]/route';
import { GET as filesRoute } from '../src/app/api/account/files/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { GET as jobRoute } from '../src/app/api/v1/jobs/[id]/route';
import { storageProvider } from '../src/lib/storage';
import { FileRetentionLedger, setRetentionLedger } from '../src/lib/storage/retention-ledger';
import { registerResult, resultAvailability, sweepRetention } from '../src/lib/storage/retention-service';
import {
  addInterval,
  coversWholeObject,
  newRecord,
  recordServedRange,
  resolveRetentionPolicy,
  MAX_RECEIVED_RANGES,
} from '../src/lib/storage/result-retention';
import { conversionQueue } from '../src/lib/queue/conversion-queue';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import type { User } from '../src/lib/auth/types';

const BASE_URL = 'http://localhost:3000';
const SECOND_MS = 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const POLICY = resolveRetentionPolicy({});
const MIME_TYPE = 'application/octet-stream';
// Ten ASCII digits: every byte value equals its offset, so a range reads as a literal.
const TEN_BYTES = Buffer.from('0123456789', 'ascii');
// Several chunks of 64 KiB, so a download can stop between chunks.
const LARGE_BYTES = crypto.randomBytes(512 * 1024);

describe('the retention policy', () => {
  it('keeps an unfetched result for an hour and a delivered one for ten minutes', () => {
    expect(POLICY).toEqual({ undeliveredTtlMs: ONE_HOUR_MS, deliveredGraceMs: 10 * 60 * SECOND_MS });
  });

  it('reads both times from the environment in seconds', () => {
    expect(resolveRetentionPolicy({ RESULT_UNDELIVERED_TTL_SECONDS: '900', RESULT_DELIVERED_GRACE_SECONDS: '30' })).toEqual({
      undeliveredTtlMs: 900 * SECOND_MS,
      deliveredGraceMs: 30 * SECOND_MS,
    });
  });

  it('treats a blank value as unset', () => {
    expect(resolveRetentionPolicy({ RESULT_UNDELIVERED_TTL_SECONDS: ' ', RESULT_DELIVERED_GRACE_SECONDS: '' })).toEqual(POLICY);
  });

  it.each([
    ['RESULT_UNDELIVERED_TTL_SECONDS', 'soon'],
    ['RESULT_UNDELIVERED_TTL_SECONDS', '59'],
    ['RESULT_UNDELIVERED_TTL_SECONDS', '86401'],
    ['RESULT_DELIVERED_GRACE_SECONDS', '0'],
    ['RESULT_DELIVERED_GRACE_SECONDS', '3601'],
    ['RESULT_DELIVERED_GRACE_SECONDS', '-5'],
  ])('refuses %s=%s instead of falling back to the default', (name, value) => {
    expect(() => resolveRetentionPolicy({ [name]: value })).toThrow(new RegExp(`^${name} `));
  });
});

describe('byte ranges that were sent', () => {
  it('joins ranges that overlap or touch, in any order of arrival', () => {
    const tail = addInterval([], 5, 9)!;
    expect(addInterval(tail, 0, 4)).toEqual([[0, 9]]);
    expect(addInterval(tail, 0, 2)).toEqual([
      [0, 2],
      [5, 9],
    ]);
    expect(addInterval(addInterval(tail, 0, 2)!, 3, 4)).toEqual([[0, 9]]);
  });

  it('recognises a whole object only from one range that starts at zero and reaches the last byte', () => {
    expect(coversWholeObject([[0, 9]], 10)).toBe(true);
    expect(coversWholeObject([[0, 8]], 10)).toBe(false);
    expect(coversWholeObject([[1, 9]], 10)).toBe(false);
    expect(coversWholeObject([], 0)).toBe(true);
  });

  it('stops remembering after too many separate pieces, so such a file is never counted as delivered', () => {
    let pieces = [] as ReturnType<typeof addInterval>;
    for (let i = 0; i < MAX_RECEIVED_RANGES; i++) pieces = addInterval(pieces!, i * 10, i * 10 + 4);
    expect(pieces).toHaveLength(MAX_RECEIVED_RANGES);
    expect(addInterval(pieces!, MAX_RECEIVED_RANGES * 10, MAX_RECEIVED_RANGES * 10 + 4)).toBeUndefined();
  });
});

describe('the record of one result', () => {
  const NOW = 1_000_000;

  it('is deleted after the undelivered time when nothing was sent', () => {
    expect(newRecord('results/j/a.pdf', NOW, POLICY).deleteAt).toBe(NOW + ONE_HOUR_MS);
  });

  it('is delivered when two ranges together cover the file, and then goes after the grace period', () => {
    const fresh = newRecord('results/j/a.pdf', NOW, POLICY);
    const head = recordServedRange(fresh, { first: 0, last: 4, size: 10 }, NOW + 1, POLICY);
    expect(head.deliveredAt).toBeUndefined();
    expect(head.deleteAt).toBe(NOW + ONE_HOUR_MS);
    const done = recordServedRange(head, { first: 5, last: 9, size: 10 }, NOW + 2, POLICY);
    expect(done.deliveredAt).toBe(NOW + 2);
    expect(done.deleteAt).toBe(NOW + 2 + POLICY.deliveredGraceMs);
  });

  it('does not move the deletion time again on a later delivery', () => {
    const fresh = newRecord('results/j/a.pdf', NOW, POLICY);
    const first = recordServedRange(fresh, { first: 0, last: 9, size: 10 }, NOW + 1, POLICY);
    const second = recordServedRange(first, { first: 0, last: 9, size: 10 }, NOW + 5 * SECOND_MS, POLICY);
    expect(second.deleteAt).toBe(first.deleteAt);
  });

  it('never keeps a result longer than the undelivered time because of the grace period', () => {
    const nearlyDue = { ...newRecord('results/j/a.pdf', NOW, POLICY), deleteAt: NOW + 5 * SECOND_MS };
    expect(recordServedRange(nearlyDue, { first: 0, last: 9, size: 10 }, NOW + 1, POLICY).deleteAt).toBe(NOW + 5 * SECOND_MS);
  });
});

describe('delete on delivery through the download route and the sweep', () => {
  let ledgerDir: string;
  const storedKeys: string[] = [];

  beforeEach(() => {
    ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-retention-'));
    setRetentionLedger(new FileRetentionLedger(ledgerDir));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setRetentionLedger(undefined);
    fs.rmSync(ledgerDir, { recursive: true, force: true });
    for (const key of storedKeys.splice(0)) storageProvider.deleteObject(key);
  });

  async function createUser(label: string): Promise<User> {
    const email = `${label}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@retention.test`;
    return userStore.sanitizeUser(await userStore.createUser({ email, name: label, tier: 'pro' }));
  }

  function asUser(user: User): Record<string, string> {
    return { Cookie: `easyconvert_session=${createSessionToken(user)}` };
  }

  async function storeResult(user: User, body: Buffer = TEN_BYTES): Promise<string> {
    const key = `conversions/${user.id}/${Date.now()}_${crypto.randomBytes(4).toString('hex')}_result.bin`;
    await storageProvider.saveObject(key, body, MIME_TYPE, 'result.bin', POLICY.undeliveredTtlMs);
    await registerResult(key);
    storedKeys.push(key);
    return key;
  }

  function download(key: string, headers: Record<string, string>): Promise<Response> {
    const encodedKey = encodeURIComponent(key);
    const req = new NextRequest(`${BASE_URL}/api/storage/file/${encodedKey}`, { headers });
    return downloadRoute(req, { params: Promise.resolve({ key: [encodedKey] }) });
  }

  async function bodyBytes(res: Response): Promise<Buffer> {
    return Buffer.from(await res.arrayBuffer());
  }

  const ledger = () => new FileRetentionLedger(ledgerDir);

  it('serves a second click inside the grace period and answers 410 after it, also before the sweep ran', async () => {
    const user = await createUser('second-click');
    const key = await storeResult(user);
    const headers = asUser(user);

    const first = await download(key, headers);
    expect(first.status).toBe(200);
    expect(await bodyBytes(first)).toEqual(TEN_BYTES);
    expect((await ledger().get(key))?.deliveredAt).toBeTypeOf('number');

    const second = await download(key, headers);
    expect(second.status).toBe(200);
    expect(await bodyBytes(second)).toEqual(TEN_BYTES);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + POLICY.deliveredGraceMs + SECOND_MS);
    const late = await download(key, headers);
    expect(late.status).toBe(410);
    expect(await late.json()).toMatchObject({ success: false });
    expect(storageProvider.getObject(key)).toBeUndefined();
  });

  it('keeps answering 410 to the owner and 404 to anyone else once the sweep deleted the object', async () => {
    const owner = await createUser('swept-owner');
    const stranger = await createUser('swept-stranger');
    const key = await storeResult(owner);
    await bodyBytes(await download(key, asUser(owner)));

    const afterGrace = Date.now() + POLICY.deliveredGraceMs + SECOND_MS;
    expect(await sweepRetention(storageProvider, afterGrace)).toBe(1);
    expect(storageProvider.getObject(key)).toBeUndefined();

    expect((await download(key, asUser(owner))).status).toBe(410);
    expect((await download(key, asUser(stranger))).status).toBe(404);
    expect((await download(key, {})).status).toBe(404);
    expect(await resultAvailability(key, afterGrace)).toMatchObject({ state: 'deleted', reason: 'delivered' });
  });

  it('does not count a download that stopped early as a delivery', async () => {
    const user = await createUser('dropped');
    const key = await storeResult(user, LARGE_BYTES);
    const headers = asUser(user);

    const dropped = await download(key, headers);
    expect(dropped.status).toBe(200);
    const reader = dropped.body!.getReader();
    const firstChunk = await reader.read();
    expect(firstChunk.done).toBe(false);
    await reader.cancel();

    expect((await ledger().get(key))?.deliveredAt).toBeUndefined();
    expect(await sweepRetention(storageProvider, Date.now() + POLICY.deliveredGraceMs + SECOND_MS)).toBe(0);
    const retry = await download(key, headers);
    expect(retry.status).toBe(200);
    expect(await bodyBytes(retry)).toEqual(LARGE_BYTES);
  });

  it('counts ranges that together cover the file as a delivery, and a tail alone as none', async () => {
    const user = await createUser('ranges');
    const headers = asUser(user);
    const tailOnly = await storeResult(user);
    const tail = await download(tailOnly, { ...headers, Range: 'bytes=5-' });
    expect(tail.status).toBe(206);
    expect(await bodyBytes(tail)).toEqual(TEN_BYTES.subarray(5));
    expect((await ledger().get(tailOnly))?.deliveredAt).toBeUndefined();

    const resumed = await storeResult(user);
    const head = await download(resumed, { ...headers, Range: 'bytes=0-4' });
    expect(await bodyBytes(head)).toEqual(TEN_BYTES.subarray(0, 5));
    expect((await ledger().get(resumed))?.deliveredAt).toBeUndefined();
    const rest = await download(resumed, { ...headers, Range: 'bytes=5-' });
    expect(await bodyBytes(rest)).toEqual(TEN_BYTES.subarray(5));
    expect((await ledger().get(resumed))?.deliveredAt).toBeTypeOf('number');
  });

  it('deletes a result nobody downloaded after the undelivered time and answers 410 to its owner', async () => {
    const owner = await createUser('unfetched-owner');
    const stranger = await createUser('unfetched-stranger');
    const key = await storeResult(owner);

    expect(await sweepRetention(storageProvider, Date.now() + POLICY.undeliveredTtlMs - SECOND_MS)).toBe(0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + POLICY.undeliveredTtlMs + SECOND_MS);

    expect((await download(key, asUser(owner))).status).toBe(410);
    expect((await download(key, asUser(stranger))).status).toBe(404);
    expect(await resultAvailability(key)).toMatchObject({ state: 'deleted', reason: 'expired' });
  });

  it('cleans a result whose time passed while the server was down at the next sweep', async () => {
    const user = await createUser('restart');
    const key = await storeResult(user);
    const past = Date.now() - SECOND_MS;
    await ledger().update(key, (current) => current && { ...current, deliveredAt: past - SECOND_MS, deleteAt: past });

    setRetentionLedger(new FileRetentionLedger(ledgerDir));
    expect(await sweepRetention(storageProvider)).toBe(1);
    expect(storageProvider.getObject(key)).toBeUndefined();
  });

  it('leaves an upload alone: it has no owner and is deleted with its job', async () => {
    const key = `uploads/retention-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.bin`;
    await storageProvider.saveObject(key, TEN_BYTES, MIME_TYPE, 'in.bin', POLICY.undeliveredTtlMs);
    storedKeys.push(key);
    await registerResult(key);
    expect(await ledger().get(key)).toBeUndefined();

    expect(await bodyBytes(await download(key, {}))).toEqual(TEN_BYTES);
    expect(await ledger().get(key)).toBeUndefined();
  });

  it('tells in the job record that the file is gone', async () => {
    const user = await createUser('job-record');
    const resultKey = await storeResult(user);
    const job = {
      id: `retention-job-${crypto.randomBytes(4).toString('hex')}`,
      state: 'completed',
      data: { userId: user.id, sourceFormat: 'csv', targetFormat: 'json' },
      returnvalue: { jobId: 'x', status: 'completed', resultKey, downloadUrl: '', filename: 'result.bin', mimeType: MIME_TYPE, size: 10, durationMs: 1 },
      timestamp: Date.now(),
    };
    vi.spyOn(conversionQueue, 'getJob').mockResolvedValue(job as never);
    const read = async () => {
      const req = new NextRequest(`${BASE_URL}/api/v1/jobs/${job.id}`, { headers: asUser(user) });
      return (await jobRoute(req, { params: Promise.resolve({ id: job.id }) })).json();
    };

    expect((await read()).retention).toMatchObject({ state: 'available' });
    await bodyBytes(await download(resultKey, asUser(user)));
    expect((await read()).retention).toMatchObject({ state: 'available', deliveredAt: expect.any(Number) });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + POLICY.deliveredGraceMs + SECOND_MS);
    expect((await read()).retention).toMatchObject({ state: 'deleted', reason: 'delivered' });
  });

  it('lists a file of the account until the retention rule deletes it, counting down to that time', async () => {
    const user = await createUser('account-files');
    const key = await storeResult(user);
    const downloadUrl = `/api/storage/file/${encodeURIComponent(key)}`;
    await redisKeyStore.recordUserFile({ userId: user.id, fileName: 'result.bin', fromFormat: 'csv', toFormat: 'json', size: 10, downloadUrl });
    const list = async () => {
      const res = await filesRoute(new NextRequest(`${BASE_URL}/api/account/files`, { headers: asUser(user) }));
      return (await res.json()).files as Array<{ downloadUrl: string; remainingSeconds: number }>;
    };

    expect((await list())[0].remainingSeconds).toBeGreaterThan(POLICY.deliveredGraceMs / SECOND_MS);
    await bodyBytes(await download(key, asUser(user)));
    const afterDelivery = (await list())[0];
    expect(afterDelivery.downloadUrl).toBe(downloadUrl);
    expect(afterDelivery.remainingSeconds).toBeLessThanOrEqual(POLICY.deliveredGraceMs / SECOND_MS);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + POLICY.deliveredGraceMs + SECOND_MS);
    expect(await list()).toEqual([]);
  });
});
