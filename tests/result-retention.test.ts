import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Redis from 'ioredis';
import { Readable } from 'node:stream';
import { NextRequest } from 'next/server';
import { GET as downloadRoute } from '../src/app/api/storage/file/[...key]/route';
import { GET as filesRoute } from '../src/app/api/account/files/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { GET as jobRoute } from '../src/app/api/v1/jobs/[id]/route';
import { storageProvider } from '../src/lib/storage';
import {
  FileRetentionLedger,
  RedisRetentionLedger,
  setRetentionLedger,
  type RetentionLedger,
} from '../src/lib/storage/retention-ledger';
import {
  holdResultForJob,
  releaseResultHold,
  recordServed,
  registerResult,
  resultAvailability,
  saveRetainedResult,
  sweepRetention,
} from '../src/lib/storage/retention-service';
import { mayUseStorageKeyAsJobInput } from '../src/lib/api-keys/owner-access';
import {
  JOB_INPUT_HOLD_MAX_MS,
  addInterval,
  coversWholeObject,
  newRecord,
  recordServedRange,
  resolveRetentionPolicy,
  MAX_RECEIVED_RANGES,
} from '../src/lib/storage/result-retention';
import { conversionQueue, processConversionJob } from '../src/lib/queue/conversion-queue';
import { Queue } from '../src/lib/queue/bullmq-engine';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';
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
const SLOW_CHUNK_BYTES = 64 * 1024;
const SLOW_CHUNK_DELAY_MS = 50;

/** `bytes` in chunks that arrive one by one, like a body streamed from an object store. */
function slowSource(bytes: Buffer): Readable {
  async function* chunks() {
    for (let offset = 0; offset < bytes.length; offset += SLOW_CHUNK_BYTES) {
      await new Promise((resolve) => setTimeout(resolve, SLOW_CHUNK_DELAY_MS));
      yield bytes.subarray(offset, offset + SLOW_CHUNK_BYTES);
    }
  }
  return Readable.from(chunks());
}

/** A ledger whose store cannot be reached: Redis down, or the ledger directory unreadable. */
function unreachableLedger(): RetentionLedger {
  const unreachable = async (): Promise<never> => {
    throw new Error('retention ledger unreachable');
  };
  return { get: unreachable, update: unreachable, forget: unreachable, collectDue: unreachable, liveRecords: unreachable };
}

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

  it('does not count a download whose client left while the next chunk was still on its way', async () => {
    const user = await createUser('pending-cancel');
    const key = await storeResult(user, LARGE_BYTES);
    vi.spyOn(storageProvider, 'openReadStream').mockImplementation(() => slowSource(LARGE_BYTES) as never);

    const res = await download(key, asUser(user));
    const reader = res.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const pending = reader.read();
    await new Promise((resolve) => setTimeout(resolve, SLOW_CHUNK_DELAY_MS / 2));
    await reader.cancel(new Error('client went away'));
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 3 * SLOW_CHUNK_DELAY_MS));

    expect((await ledger().get(key))?.deliveredAt).toBeUndefined();
  });

  it('adds what a cancelled download sent to a resumed download of the rest', async () => {
    const user = await createUser('resumed');
    const key = await storeResult(user, LARGE_BYTES);
    const headers = asUser(user);

    const cut = await download(key, headers);
    const reader = cut.body!.getReader();
    let received = 0;
    for (let i = 0; i < 2; i++) received += (await reader.read()).value!.byteLength;
    await reader.cancel();
    expect((await ledger().get(key))?.deliveredAt).toBeUndefined();

    const rest = await download(key, { ...headers, Range: `bytes=${received}-` });
    expect(rest.status).toBe(206);
    expect(Buffer.concat([LARGE_BYTES.subarray(0, received), await bodyBytes(rest)])).toEqual(LARGE_BYTES);
    expect((await ledger().get(key))?.deliveredAt).toBeTypeOf('number');
  });

  it('tells a buffering proxy not to buffer a file, so the end of the body is the end of the delivery', async () => {
    const user = await createUser('proxy');
    const key = await storeResult(user);
    const res = await download(key, asUser(user));
    expect(res.headers.get('X-Accel-Buffering')).toBe('no');
    await bodyBytes(res);
  });

  it('removes a stored result again when its record cannot be written, so no object is left that no sweep finds', async () => {
    const user = await createUser('unregistered');
    const key = `conversions/${user.id}/${Date.now()}_unregistered.bin`;
    storedKeys.push(key);
    setRetentionLedger(unreachableLedger());

    await expect(saveRetainedResult(storageProvider, key, TEN_BYTES, MIME_TYPE, 'r.bin')).rejects.toThrow('unreachable');
    expect(storageProvider.getObject(key)).toBeUndefined();
  });

  it('removes a job result again when the worker cannot write its record', async () => {
    setRetentionLedger(unreachableLedger());
    const upload = `uploads/unregistered-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.csv`;
    await storageProvider.saveObject(upload, Buffer.from('name,score\nAlice,100\n'), 'text/csv', 'scores.csv');
    storedKeys.push(upload);
    const saved: string[] = [];
    const save = storageProvider.saveObject.bind(storageProvider);
    vi.spyOn(storageProvider, 'saveObject').mockImplementation((key, ...rest) => (saved.push(key), save(key, ...rest)));
    const queue = new Queue<ConversionJobData, ConversionJobResult>('retention-unregistered');
    const data = { jobId: '', originalFilename: 'scores.csv', sourceFormat: 'csv', targetFormat: 'json', fileSize: 22, options: {}, storageKey: upload };
    const job = await queue.add('convert', data as ConversionJobData);

    await expect(processConversionJob(job)).rejects.toThrow('unreachable');
    const resultKeys = saved.filter((key) => key.startsWith(`results/${job.id}/`));
    expect(resultKeys).toHaveLength(1);
    expect(storageProvider.getObject(resultKeys[0])).toBeUndefined();
    await queue.close();
  });

  it('serves a result from storage when its record cannot be read, and leaves the retention state out', async () => {
    const user = await createUser('ledger-down');
    const key = await storeResult(user);
    const downloadUrl = `/api/storage/file/${encodeURIComponent(key)}`;
    await redisKeyStore.recordUserFile({ userId: user.id, fileName: 'result.bin', fromFormat: 'csv', toFormat: 'json', size: 10, downloadUrl, storageKey: key });
    setRetentionLedger(unreachableLedger());
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await download(key, asUser(user));
    expect(res.status).toBe(200);
    expect(await bodyBytes(res)).toEqual(TEN_BYTES);
    expect(await resultAvailability(key)).toBeUndefined();
    const files = await filesRoute(new NextRequest(`${BASE_URL}/api/account/files`, { headers: asUser(user) }));
    expect(files.status).toBe(200);
    expect((await files.json()).files.map((file: { downloadUrl: string }) => file.downloadUrl)).toContain(downloadUrl);
  });

  it('serves a file the retention rule does not cover without reading the ledger', async () => {
    const key = `uploads/retention-unread-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.bin`;
    await storageProvider.saveObject(key, TEN_BYTES, MIME_TYPE, 'in.bin', POLICY.undeliveredTtlMs);
    storedKeys.push(key);
    const get = vi.fn(async () => {
      throw new Error('retention ledger unreachable');
    });
    setRetentionLedger({ ...unreachableLedger(), get });

    const res = await download(key, {});
    expect(res.status).toBe(200);
    expect(await bodyBytes(res)).toEqual(TEN_BYTES);
    expect(get).not.toHaveBeenCalled();
  });

  it('answers 410 for a result whose time has passed even when deleting it right then fails', async () => {
    const user = await createUser('lazy-delete-fails');
    const key = await storeResult(user);
    await bodyBytes(await download(key, asUser(user)));
    vi.spyOn(storageProvider, 'deleteObject').mockImplementation(() => {
      throw new Error('storage unreachable');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + POLICY.deliveredGraceMs + SECOND_MS);
    expect((await download(key, asUser(user))).status).toBe(410);
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
    await redisKeyStore.recordUserFile({ userId: user.id, fileName: 'result.bin', fromFormat: 'csv', toFormat: 'json', size: 10, downloadUrl, storageKey: key });
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

describe('the file ledger shared by the web server and the workers', () => {
  let ledgerDir: string;
  const deleted: string[] = [];
  const storage = { deleteObject: async (key: string) => (deleted.push(key), true) };

  beforeEach(() => {
    ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-ledger-'));
    setRetentionLedger(new FileRetentionLedger(ledgerDir));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    deleted.length = 0;
    setRetentionLedger(undefined);
    fs.rmSync(ledgerDir, { recursive: true, force: true });
  });

  const newKey = () => `conversions/ledger-user/${Date.now()}_${crypto.randomBytes(4).toString('hex')}.bin`;

  it('keeps every range when two processes record pieces of one file at the same moment', async () => {
    const key = newKey();
    await registerResult(key);
    const processes = [new FileRetentionLedger(ledgerDir), new FileRetentionLedger(ledgerDir)];
    const now = Date.now();
    await Promise.all(
      Array.from({ length: 10 }, (_, offset) =>
        processes[offset % 2].update(key, (current) => current && recordServedRange(current, { first: offset, last: offset, size: 10 }, now, POLICY))
      )
    );
    expect((await processes[0].get(key))?.received).toEqual([[0, 9]]);
    expect((await processes[1].get(key))?.deliveredAt).toBe(now);
  });

  it('moves a result whose deletion failed behind the others instead of retrying it first on every sweep', async () => {
    const poison = newKey();
    const fresh = newKey();
    await registerResult(poison);
    await registerResult(fresh);
    const failing = {
      deleteObject: async (key: string) => {
        if (key === poison) throw new Error('object store refused');
        return storage.deleteObject(key);
      },
    };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const due = Date.now() + POLICY.undeliveredTtlMs + SECOND_MS;

    expect(await sweepRetention(failing, due)).toBe(1);
    expect(deleted).toEqual([fresh]);
    expect(await sweepRetention(failing, due + SECOND_MS)).toBe(0);
    expect(deleted).toEqual([fresh]);
    expect(await resultAvailability(poison, due)).toMatchObject({ state: 'deleted' });
  });

  it('removes the leftovers of a write that stopped half-way once they are an hour old', async () => {
    await registerResult(newKey());
    const directory = path.join(ledgerDir, '.retention');
    const stale = path.join(directory, 'record.json.0123456789ab.tmp');
    const recent = path.join(directory, 'record.json.ba9876543210.tmp');
    fs.writeFileSync(stale, '{');
    fs.writeFileSync(recent, '{');
    const twoHoursAgo = new Date(Date.now() - 2 * ONE_HOUR_MS);
    fs.utimesSync(stale, twoHoursAgo, twoHoursAgo);

    await sweepRetention(storage);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
  });

  it('does not remove the lock of the next writer after its own lock was broken as stale', async () => {
    const key = newKey();
    await registerResult(key);
    const lockFile = path.join(ledgerDir, '.retention', `${crypto.createHash('sha256').update(key).digest('hex')}.json.lock`);
    const writers = [new FileRetentionLedger(ledgerDir), new FileRetentionLedger(ledgerDir)];
    const realWriteFile = fs.promises.writeFile.bind(fs.promises);
    let signalSecondWriting!: () => void;
    const secondWriting = new Promise<void>((resolve) => {
      signalSecondWriting = resolve;
    });
    let firstDone!: Promise<unknown>;
    let secondDone: Promise<unknown> | undefined;
    let lockKeptForSecond: boolean | undefined;
    let recordWrites = 0;
    vi.spyOn(fs.promises, 'writeFile').mockImplementation((async (file: string, data: string, options: unknown) => {
      if (!String(file).endsWith('.tmp')) return realWriteFile(file, data, options as BufferEncoding);
      recordWrites++;
      if (recordWrites === 1) {
        const longAgo = new Date(Date.now() - 2 * 60 * SECOND_MS);
        fs.utimesSync(lockFile, longAgo, longAgo);
        secondDone = writers[1].update(key, (current) => current && { ...current, size: 2 });
        await secondWriting;
      } else {
        signalSecondWriting();
        await firstDone;
        lockKeptForSecond = fs.existsSync(lockFile);
      }
      return realWriteFile(file, data, options as BufferEncoding);
    }) as unknown as typeof fs.promises.writeFile);

    firstDone = writers[0].update(key, (current) => current && { ...current, size: 1 });
    await firstDone;
    await secondDone;

    expect(lockKeptForSecond).toBe(true);
    expect((await writers[0].get(key))?.size).toBe(2);
  });

  it('lists every live record for an early deletion, not only the first files of the directory', async () => {
    const keys = Array.from({ length: 12 }, () => newKey());
    for (const key of keys) await registerResult(key);
    const live = await new FileRetentionLedger(ledgerDir).liveRecords();
    expect(live.map((record) => record.key).sort()).toEqual([...keys].sort());
  });

  async function storeOwnResult(label: string): Promise<{ owner: User; key: string }> {
    const owner = await userStore.sanitizeUser(
      await userStore.createUser({ email: `${label}_${Date.now()}@retention.test`, name: label, tier: 'pro' })
    );
    const key = `conversions/${owner.id}/${Date.now()}_${label}.bin`;
    await storageProvider.saveObject(key, TEN_BYTES, MIME_TYPE, `${label}.bin`);
    await registerResult(key);
    await recordServed(key, { first: 0, last: 9, size: 10 });
    return { owner, key };
  }

  it('keeps a result that a job reads as its input until that job ends, also past the undelivered time', async () => {
    const { owner, key } = await storeOwnResult('chain');
    expect(await holdResultForJob(key, 'job-1')).toBe(true);
    expect(await holdResultForJob(key, 'job-2')).toBe(true);

    const afterUndelivered = Date.now() + POLICY.undeliveredTtlMs + SECOND_MS;
    expect(await sweepRetention(storageProvider, afterUndelivered)).toBe(0);
    await releaseResultHold(key, 'job-1');
    expect(await sweepRetention(storageProvider, afterUndelivered)).toBe(0);
    expect(await mayUseStorageKeyAsJobInput(key, owner.id)).toBe(true);

    await releaseResultHold(key, 'job-2');
    expect(await sweepRetention(storageProvider, afterUndelivered)).toBe(1);
    expect(storageProvider.getObject(key)).toBeUndefined();
    expect(await holdResultForJob(key, 'job-3')).toBe(false);
    expect(await mayUseStorageKeyAsJobInput(key, owner.id)).toBe(false);
  });

  it('ends the hold of a job that never reported back once the longest hold has passed', async () => {
    const { key } = await storeOwnResult('lost');
    expect(await holdResultForJob(key, 'job-lost')).toBe(true);
    expect(await sweepRetention(storageProvider, Date.now() + JOB_INPUT_HOLD_MAX_MS - SECOND_MS)).toBe(0);
    expect(await sweepRetention(storageProvider, Date.now() + JOB_INPUT_HOLD_MAX_MS + SECOND_MS)).toBe(1);
  });
});

/** A port on this host that nothing listens on. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('the Redis ledger while Redis cannot be reached', () => {
  const PARALLEL_CALLS = 50;
  const CONNECT_WAIT_MS = 2_000;
  const FAIL_FAST_MS = 300;

  it('fails every call after one short wait, then at once, without piling up listeners', async () => {
    const redis = new Redis(`redis://127.0.0.1:${await closedPort()}`, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
    redis.on('error', () => undefined);
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(warning.name);
    process.on('warning', onWarning);
    const ledger = new RedisRetentionLedger(redis);
    const reads = () => Promise.allSettled(Array.from({ length: PARALLEL_CALLS }, (_, i) => ledger.get(`conversions/outage/f${i}`)));
    try {
      let start = Date.now();
      const first = await reads();
      const firstMs = Date.now() - start;
      start = Date.now();
      const second = await reads();
      const secondMs = Date.now() - start;
      await new Promise((resolve) => setImmediate(resolve));

      expect([...first, ...second].every((result) => result.status === 'rejected')).toBe(true);
      expect(firstMs).toBeLessThan(CONNECT_WAIT_MS + FAIL_FAST_MS);
      expect(secondMs).toBeLessThan(FAIL_FAST_MS);
      expect(warnings).not.toContain('MaxListenersExceededWarning');
    } finally {
      process.off('warning', onWarning);
      redis.disconnect();
    }
  });
});
