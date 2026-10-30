import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { GET as downloadRoute } from '../src/app/api/storage/file/[...key]/route';
import { POST as directUploadRoute } from '../src/app/api/v1/uploads/direct/route';
import { POST as convertRoute } from '../src/app/api/convert/route';
import { parseConfig } from '../src/lib/config';
import { storageProvider } from '../src/lib/storage';
import { resolveCapacityPolicy, usedPercent } from '../src/lib/storage/result-capacity';
import { FileRetentionLedger, setRetentionLedger } from '../src/lib/storage/retention-ledger';
import {
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
    const newestUndelivered = await storeResult(user, 'newest', now - 10 * SECOND_MS);
    const oldestUndelivered = await storeResult(user, 'oldest', now - 50 * SECOND_MS);
    const laterDelivery = await storeResult(user, 'later', now - 60 * SECOND_MS, now - 5 * SECOND_MS);
    const earlierDelivery = await storeResult(user, 'earlier', now - 30 * SECOND_MS, now - 20 * SECOND_MS);
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
    const input = await storeResult(user, 'input', now - 60 * SECOND_MS, now - 50 * SECOND_MS);
    const other = await storeResult(user, 'other', now - 40 * SECOND_MS);
    await holdResultForJob(input, now);
    const disk = fakeDisk(99);

    expect(await evictForCapacity(storageProvider, now)).toBe(1);
    expect(disk.deleted).toEqual([other]);
    expect(storageProvider.getObject(input)).toBeDefined();
  });

  it('answers the owner of a result deleted for space with 410 and the reason', async () => {
    const user = await createUser('reason');
    const key = await storeResult(user, 'evicted', Date.now() - SECOND_MS);
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
    await storeResult(user, 'a', Date.now() - 3 * SECOND_MS);
    await storeResult(user, 'b', Date.now() - 2 * SECOND_MS);
    const disk = fakeDisk(97);

    const upload = await directUploadRoute(new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, { method: 'POST' }));
    expect(upload.status).not.toBe(503);
    expect(disk.deleted).toHaveLength(2);
    expect(disk.used).toBe(89);
  });
});
