import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { GET as downloadRoute } from '../src/app/api/storage/file/[...key]/route';
import { POST as directUploadRoute } from '../src/app/api/v1/uploads/direct/route';
import { POST as tusUploadRoute } from '../src/app/api/v1/uploads/[[...id]]/route';
import { POST as convertRoute } from '../src/app/api/convert/route';
import { parseConfig } from '../src/lib/config';
import { storageProvider } from '../src/lib/storage';
import { diskUsageProbe, resolveCapacityPolicy, usedPercent } from '../src/lib/storage/result-capacity';
import { FileRetentionLedger, setRetentionLedger } from '../src/lib/storage/retention-ledger';
import {
  CAPACITY_CHECK_TTL_MS,
  evictForCapacity,
  holdResultForJob,
  recordServed,
  registerResult,
  resultAvailability,
  setDiskProbe,
} from '../src/lib/storage/retention-service';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import type { User } from '../src/lib/auth/types';

/**
 * Early deletion of results when the disk of the local driver runs full: above RESULT_DISK_HIGH_PERCENT (85) the
 * results go, delivered ones first, until the use is at or below RESULT_DISK_LOW_PERCENT (80); above
 * RESULT_DISK_REFUSE_PERCENT (95) new uploads and conversions are refused. The disk is a counter here: every
 * deleted result frees a fixed share of it.
 */

const BASE_URL = 'http://localhost:3000';
const MIME_TYPE = 'application/octet-stream';
const BODY = Buffer.from('0123456789', 'ascii');
const PERCENT_PER_RESULT = 4;
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HTTP_UNAUTHORIZED = 401;

/** A disk whose use drops by PERCENT_PER_RESULT for every object deleted from storage. */
function fakeDisk(startPercent: number) {
  const disk = { used: startPercent, deleted: [] as string[] };
  const remove = storageProvider.deleteObject.bind(storageProvider);
  vi.spyOn(storageProvider, 'deleteObject').mockImplementation((key: string) => {
    disk.deleted.push(key);
    disk.used -= PERCENT_PER_RESULT;
    return remove(key);
  });
  setDiskProbe(async () => disk.used);
  return disk;
}

describe('the disk thresholds', () => {
  it('default to 85, 80 and 95 percent', () => {
    expect(resolveCapacityPolicy({})).toEqual({ highPercent: 85, lowPercent: 80, refusePercent: 95 });
  });

  it.each([
    [{ RESULT_DISK_LOW_PERCENT: '85' }, 'RESULT_DISK_LOW_PERCENT'],
    [{ RESULT_DISK_HIGH_PERCENT: '95' }, 'RESULT_DISK_HIGH_PERCENT'],
    [{ RESULT_DISK_REFUSE_PERCENT: '100' }, 'RESULT_DISK_REFUSE_PERCENT'],
  ])('refuse %o at start-up', (env, variable) => {
    expect(() => resolveCapacityPolicy(env)).toThrow(new RegExp(`^${variable} `));
    expect(() => parseConfig(env)).toThrow(new RegExp(`${variable}: must`));
  });

  it('measure the use as df does, counting the blocks reserved for root as full', () => {
    expect(usedPercent({ blocks: 100, bfree: 20, bavail: 15 })).toBeCloseTo((80 * 100) / 95);
  });
});

describe('the disk measurement', () => {
  let storageDir: string;
  let tempDir: string;

  beforeEach(() => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-probe-storage-'));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-probe-temp-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(storageDir, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** statfs answers with the blocks of `percentOf(directory)` percent used. */
  function fakeStatfs(percentOf: (directory: string) => number) {
    return vi.spyOn(fs.promises, 'statfs').mockImplementation((async (directory: fs.PathLike) => {
      const used = percentOf(String(directory));
      return { blocks: 100, bfree: 100 - used, bavail: 100 - used };
    }) as unknown as typeof fs.promises.statfs);
  }

  it('reports the fuller of the storage directory and the temporary directory when they are on different disks', async () => {
    fakeStatfs((directory) => (directory === tempDir ? 92 : 50));
    const realStat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (target: fs.PathLike) => {
      const stats = await realStat(target);
      return Object.assign(stats, { dev: String(target) === tempDir ? 2 : 1 });
    }) as unknown as typeof fs.promises.stat);

    expect(await diskUsageProbe([storageDir, tempDir])()).toBe(92);
  });

  it('measures a disk once when both directories are on it', async () => {
    const statfs = fakeStatfs(() => 70);
    expect(await diskUsageProbe([storageDir, tempDir])()).toBe(70);
    expect(statfs).toHaveBeenCalledTimes(1);
  });
});

describe('early deletion when the disk runs full', () => {
  let ledgerDir: string;
  const storedKeys: string[] = [];

  beforeEach(() => {
    ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-capacity-'));
    setRetentionLedger(new FileRetentionLedger(ledgerDir));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setDiskProbe(undefined);
    setRetentionLedger(undefined);
    fs.rmSync(ledgerDir, { recursive: true, force: true });
    for (const key of storedKeys.splice(0)) storageProvider.deleteObject(key);
  });

  async function createUser(label: string): Promise<User> {
    const email = `${label}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@capacity.test`;
    return userStore.sanitizeUser(await userStore.createUser({ email, name: label, tier: 'pro' }));
  }

  /** Stores and registers a result at `at`; delivered at `deliveredAt` when given. */
  async function storeResult(user: User, label: string, at: number, deliveredAt?: number): Promise<string> {
    const key = `conversions/${user.id}/${label}_${crypto.randomBytes(4).toString('hex')}.bin`;
    await storageProvider.saveObject(key, BODY, MIME_TYPE, `${label}.bin`);
    storedKeys.push(key);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at);
    await registerResult(key);
    if (deliveredAt !== undefined) {
      vi.setSystemTime(deliveredAt);
      await recordServed(key, { first: 0, last: BODY.length - 1, size: BODY.length });
    }
    vi.useRealTimers();
    return key;
  }

  it('deletes delivered results first, the earliest delivery first, then the oldest undelivered, and stops at 80%', async () => {
    const user = await createUser('order');
    const now = Date.now();
    const newestUndelivered = await storeResult(user, 'newest', now - 20 * MINUTE_MS);
    const oldestUndelivered = await storeResult(user, 'oldest', now - 50 * MINUTE_MS);
    const laterDelivery = await storeResult(user, 'later', now - 55 * MINUTE_MS, now - 5 * SECOND_MS);
    const earlierDelivery = await storeResult(user, 'earlier', now - 30 * MINUTE_MS, now - 20 * SECOND_MS);
    const disk = fakeDisk(90);

    expect(await evictForCapacity(storageProvider, now)).toBe(3);

    expect(disk.deleted).toEqual([earlierDelivery, laterDelivery, oldestUndelivered]);
    expect(disk.used).toBe(78);
    expect(storageProvider.getObject(newestUndelivered)).toBeDefined();
  });

  it('does nothing at or below 85%', async () => {
    const user = await createUser('calm');
    await storeResult(user, 'kept', Date.now());
    const disk = fakeDisk(85);
    expect(await evictForCapacity(storageProvider)).toBe(0);
    expect(disk.deleted).toEqual([]);
  });

  it('never deletes a result that a queued or running job reads as its input', async () => {
    const user = await createUser('held');
    const now = Date.now();
    const input = await storeResult(user, 'input', now - 50 * MINUTE_MS, now - 50 * SECOND_MS);
    const other = await storeResult(user, 'other', now - 40 * MINUTE_MS);
    expect(await holdResultForJob(input, 'job-held', now)).toBe(true);
    const disk = fakeDisk(99);

    expect(await evictForCapacity(storageProvider, now)).toBe(1);
    expect(disk.deleted).toEqual([other]);
    expect(storageProvider.getObject(input)).toBeDefined();
  });

  it('answers the owner of a result deleted for space with 410 and the reason', async () => {
    const user = await createUser('reason');
    const key = await storeResult(user, 'evicted', Date.now() - 20 * MINUTE_MS);
    fakeDisk(90);
    await evictForCapacity(storageProvider);

    const encodedKey = encodeURIComponent(key);
    const req = new NextRequest(`${BASE_URL}/api/storage/file/${encodedKey}`, {
      headers: { Cookie: `easyconvert_session=${createSessionToken(user)}` },
    });
    const res = await downloadRoute(req, { params: Promise.resolve({ key: [encodedKey] }) });
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ success: false, reason: 'capacity', error: expect.stringMatching(/disk space/) });
    expect(await resultAvailability(key)).toMatchObject({ state: 'deleted', reason: 'capacity' });
  });

  it('refuses new uploads and conversions with 503 and Retry-After while the disk stays above 95%', async () => {
    const disk = fakeDisk(97);

    const upload = await directUploadRoute(new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, { method: 'POST' }));
    expect(upload.status).toBe(503);
    expect(upload.headers.get('Retry-After')).toBe('60');
    expect(await upload.json()).toMatchObject({ status: 503, title: 'Storage Full' });

    const convert = await convertRoute(new NextRequest(`${BASE_URL}/api/convert`, { method: 'POST' }));
    expect(convert.status).toBe(503);
    expect(disk.deleted).toEqual([]);
  });

  it('admits an upload when deleting results early brought the disk back under 95%', async () => {
    const user = await createUser('freed');
    await storeResult(user, 'a', Date.now() - 30 * MINUTE_MS);
    await storeResult(user, 'b', Date.now() - 20 * MINUTE_MS);
    const disk = fakeDisk(97);

    const upload = await directUploadRoute(new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, { method: 'POST' }));
    expect(upload.status).not.toBe(503);
    expect(disk.deleted).toHaveLength(2);
    expect(disk.used).toBe(89);
  });

  function download(user: User, key: string, range: string): Promise<Response> {
    const encodedKey = encodeURIComponent(key);
    const req = new NextRequest(`${BASE_URL}/api/storage/file/${encodedKey}`, {
      headers: { Cookie: `easyconvert_session=${createSessionToken(user)}`, Range: range },
    });
    return downloadRoute(req, { params: Promise.resolve({ key: [encodedKey] }) });
  }

  function tusPost(query: string): Promise<Response> {
    return tusUploadRoute(new NextRequest(`${BASE_URL}/api/v1/uploads${query}`, { method: 'POST' }), {
      params: Promise.resolve({ id: undefined }),
    });
  }

  it('lets new files in when the disk cannot be measured', async () => {
    setDiskProbe(undefined);
    const denied = Object.assign(new Error('EACCES: permission denied, statfs'), { code: 'EACCES', syscall: 'statfs' });
    vi.spyOn(fs.promises, 'statfs').mockRejectedValue(denied);

    const upload = await directUploadRoute(new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, { method: 'POST' }));
    expect(upload.status).toBe(HTTP_UNAUTHORIZED);
  });

  it('lets new files in at 97% when the records of the results cannot be read', async () => {
    const ledger = new FileRetentionLedger(ledgerDir);
    vi.spyOn(ledger, 'liveRecords').mockRejectedValue(new Error('retention ledger unreachable'));
    setRetentionLedger(ledger);
    fakeDisk(97);

    const upload = await directUploadRoute(new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, { method: 'POST' }));
    expect(upload.status).toBe(HTTP_UNAUTHORIZED);
  });

  it('measures the disk and looks for results to delete at most once per five seconds, however many requests arrive', async () => {
    const ledger = new FileRetentionLedger(ledgerDir);
    const scans = vi.spyOn(ledger, 'liveRecords');
    setRetentionLedger(ledger);
    fakeDisk(97);
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const upload = () => directUploadRoute(new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, { method: 'POST' }));

    const burst = await Promise.all(Array.from({ length: 10 }, upload));
    for (let i = 0; i < 5; i++) burst.push(await upload());
    expect(burst.map((res) => res.status)).toEqual(Array(15).fill(503));
    expect(scans).toHaveBeenCalledTimes(1);

    vi.setSystemTime(start + CAPACITY_CHECK_TTL_MS);
    expect((await upload()).status).toBe(503);
    expect(scans).toHaveBeenCalledTimes(2);
  });

  it('keeps a result whose download stopped half-way, so that resuming it still works', async () => {
    const user = await createUser('resume');
    const now = Date.now();
    const halfServed = await storeResult(user, 'half', now - 30 * MINUTE_MS);
    const untouched = await storeResult(user, 'untouched', now - 20 * MINUTE_MS);
    const first = await download(user, halfServed, 'bytes=0-4');
    expect(first.status).toBe(206);
    expect(Buffer.from(await first.arrayBuffer()).toString('ascii')).toBe('01234');
    const disk = fakeDisk(90);

    await evictForCapacity(storageProvider);

    expect(disk.deleted).toEqual([untouched]);
    const resumed = await download(user, halfServed, 'bytes=5-');
    expect(resumed.status).toBe(206);
    expect(Buffer.from(await resumed.arrayBuffer()).toString('ascii')).toBe('56789');
  });

  it('stops after three deletions in a row that did not lower the use of the disk', async () => {
    const user = await createUser('futile');
    const now = Date.now();
    for (let i = 0; i < 6; i++) await storeResult(user, `full${i}`, now - (50 - i) * MINUTE_MS);
    const disk = fakeDisk(90);
    vi.spyOn(storageProvider, 'deleteObject').mockImplementation((key: string) => {
      disk.deleted.push(key);
      return true;
    });

    expect(await evictForCapacity(storageProvider, now)).toBe(3);
    expect(disk.deleted).toHaveLength(3);
  });

  it('leaves undelivered results younger than ten minutes alone', async () => {
    const user = await createUser('young');
    const now = Date.now();
    const old = await storeResult(user, 'old', now - 11 * MINUTE_MS);
    const young = await storeResult(user, 'young', now - 9 * MINUTE_MS);
    const disk = fakeDisk(99);

    expect(await evictForCapacity(storageProvider, now)).toBe(1);
    expect(disk.deleted).toEqual([old]);
    expect(storageProvider.getObject(young)).toBeDefined();
  });

  it('does not delete a result that a job claims while the deletion runs', async () => {
    const user = await createUser('claimed');
    const now = Date.now();
    const keys: string[] = [];
    for (let i = 0; i < 3; i++) keys.push(await storeResult(user, `c${i}`, now - (40 - i) * MINUTE_MS));
    const disk = fakeDisk(90);
    let probes = 0;
    setDiskProbe(async () => {
      probes++;
      if (probes === 2) expect(await holdResultForJob(keys[1], 'job-claim')).toBe(true);
      return disk.used;
    });

    await evictForCapacity(storageProvider, now);

    expect(disk.deleted).not.toContain(keys[1]);
    expect(await resultAvailability(keys[1])).toMatchObject({ state: 'available' });
  });

  it('lets a running tus upload send parts, finish or abort while the disk is full, and refuses only a new one', async () => {
    fakeDisk(97);
    expect((await tusPost('?action=abort')).status).toBe(HTTP_UNAUTHORIZED);
    expect((await tusPost('?action=complete')).status).toBe(HTTP_UNAUTHORIZED);
    expect((await tusPost('?action=part')).status).toBe(HTTP_UNAUTHORIZED);
    expect((await tusPost('?action=initiate')).status).toBe(503);
    expect((await tusPost('')).status).toBe(503);
  });
});
