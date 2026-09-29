import crypto from 'node:crypto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as submitLegacyJob } from '../src/app/api/queue/jobs/route';
import { POST as submitV1Job } from '../src/app/api/v1/jobs/route';
import { conversionQueue } from '../src/lib/queue/conversion-queue';
import { storageProvider } from '../src/lib/storage';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import type { User } from '../src/lib/auth/types';
import type { ConversionJobData } from '../src/lib/types';

const BASE_URL = 'http://localhost:3000';
const ONE_HOUR_MS = 60 * 60 * 1000;
const CSV_INPUT = 'name,score\nAlice,100\nBob,95\n';
const NOT_FOUND_DETAIL = 'Storage object not found.';

const createdKeys: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of createdKeys.splice(0)) {
    storageProvider.deleteObject(key);
  }
});

function uniqueSuffix(): string {
  return `${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

async function createUser(label: string): Promise<User> {
  const email = `${label}_${uniqueSuffix()}@job-input-keys.test`;
  return userStore.sanitizeUser(await userStore.createUser({ email, name: label, tier: 'pro' }));
}

function storeCsv(key: string): string {
  storageProvider.saveObject(key, Buffer.from(CSV_INPUT, 'utf-8'), 'text/csv', 'scores.csv', ONE_HOUR_MS);
  createdKeys.push(key);
  return key;
}

function storedText(key: string): string | undefined {
  return storageProvider.getObject(key)?.buffer.toString('utf-8');
}

function victimJobData(userId: string): ConversionJobData {
  return {
    jobId: '',
    originalFilename: 'scores.csv',
    sourceFormat: 'csv',
    targetFormat: 'json',
    fileSize: CSV_INPUT.length,
    options: {},
    inputBufferBase64: Buffer.from(CSV_INPUT, 'utf-8').toString('base64'),
    userId,
  };
}

function legacySubmit(storageKey: string): Promise<Response> {
  return submitLegacyJob(
    new NextRequest(`${BASE_URL}/api/queue/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'scores.csv', targetFormat: 'json', storageKey }),
    })
  );
}

function v1Submit(storageKey: string, authHeaders: Record<string, string>): Promise<Response> {
  return submitV1Job(
    new NextRequest(`${BASE_URL}/api/v1/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ originalFilename: 'scores.csv', targetFormat: 'json', storageKey }),
    })
  );
}

function sessionHeaders(user: User): Record<string, string> {
  return { Cookie: `easyconvert_session=${createSessionToken(user)}` };
}

async function writeKeyHeaders(user: User): Promise<Record<string, string>> {
  const key = await redisKeyStore.generateApiKey(user.id, `${user.name} write`, { scopes: ['convert:write'] });
  return { Authorization: `Bearer ${key.secretKey}` };
}

describe('job submission authorizes caller-supplied storage keys (#249)', () => {
  it('rejects anonymous legacy submissions of another user\'s outputs without enqueueing', async () => {
    const alice = await createUser('input_alice');
    const aliceJob = await conversionQueue.add('convert', victimJobData(alice.id));
    const conversionKey = storeCsv(`conversions/${alice.id}/${uniqueSuffix()}_scores.csv`);
    const resultKey = storeCsv(`results/${aliceJob.id}/scores.csv`);
    const countsBefore = await conversionQueue.getJobCounts();
    const addSpy = vi.spyOn(conversionQueue, 'add');

    for (const key of [conversionKey, resultKey]) {
      const res = await legacySubmit(key);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ success: false, error: NOT_FOUND_DETAIL });
      expect(storedText(key)).toBe(CSV_INPUT);
    }
    expect(addSpy).toHaveBeenCalledTimes(0);
    expect(await conversionQueue.getJobCounts()).toEqual(countsBefore);
  });

  it('rejects another user\'s v1 submissions by API key and by session, rolling back the quota', async () => {
    const alice = await createUser('input_alice');
    const bob = await createUser('input_bob');
    const aliceJob = await conversionQueue.add('convert', victimJobData(alice.id));
    const conversionKey = storeCsv(`conversions/${alice.id}/${uniqueSuffix()}_scores.csv`);
    const resultKey = storeCsv(`results/${aliceJob.id}/scores.csv`);
    const bobKeyHeaders = await writeKeyHeaders(bob);
    const usedBefore = (await redisKeyStore.getQuotaUsage(bob.id)).usedToday;
    const countsBefore = await conversionQueue.getJobCounts();
    const addSpy = vi.spyOn(conversionQueue, 'add');

    for (const key of [conversionKey, resultKey]) {
      for (const authHeaders of [bobKeyHeaders, sessionHeaders(bob)]) {
        const res = await v1Submit(key, authHeaders);
        expect(res.status).toBe(404);
        expect(res.headers.get('content-type')).toBe('application/problem+json');
        const body = await res.json();
        expect(body.status).toBe(404);
        expect(body.title).toBe('Not Found');
        expect(body.detail).toBe(NOT_FOUND_DETAIL);
        expect(storedText(key)).toBe(CSV_INPUT);
      }
    }
    expect(addSpy).toHaveBeenCalledTimes(0);
    expect(await conversionQueue.getJobCounts()).toEqual(countsBefore);
    expect((await redisKeyStore.getQuotaUsage(bob.id)).usedToday).toBe(usedBefore);
  });

  it('rejects a job result whose job cannot be read, even for a signed-in caller', async () => {
    const bob = await createUser('input_bob');
    const orphanKey = storeCsv(`results/job_0_${crypto.randomBytes(16).toString('hex')}/scores.csv`);

    const res = await v1Submit(orphanKey, sessionHeaders(bob));
    expect(res.status).toBe(404);
    expect((await res.json()).detail).toBe(NOT_FOUND_DETAIL);
  });

  it('answers a nonexistent key with the same 404 body as a key the caller does not own', async () => {
    const alice = await createUser('input_alice');
    const bob = await createUser('input_bob');
    const bobKeyHeaders = await writeKeyHeaders(bob);
    const notOwnedKey = storeCsv(`conversions/${alice.id}/${uniqueSuffix()}_scores.csv`);
    const missingKey = `uploads/${uniqueSuffix()}_never-stored.csv`;

    const notOwnedV1 = await v1Submit(notOwnedKey, bobKeyHeaders);
    const missingV1 = await v1Submit(missingKey, bobKeyHeaders);
    expect(missingV1.status).toBe(404);
    expect(await missingV1.json()).toEqual(await notOwnedV1.json());

    const notOwnedLegacy = await legacySubmit(notOwnedKey);
    const missingLegacy = await legacySubmit(missingKey);
    expect(missingLegacy.status).toBe(404);
    expect(await missingLegacy.json()).toEqual(await notOwnedLegacy.json());
  });

  it('accepts the owner chaining their own conversions/ and results/ outputs', async () => {
    const alice = await createUser('input_alice');
    const aliceJob = await conversionQueue.add('convert', victimJobData(alice.id));
    const aliceKeyHeaders = await writeKeyHeaders(alice);

    for (const key of [
      storeCsv(`conversions/${alice.id}/${uniqueSuffix()}_scores.csv`),
      storeCsv(`results/${aliceJob.id}/scores.csv`),
    ]) {
      const res = await v1Submit(key, aliceKeyHeaders);
      expect(res.status).toBe(202);
      const body = await res.json();
      const queued = await conversionQueue.getJob(body.jobId);
      expect(queued?.data.storageKey).toBe(key);
      expect(queued?.data.userId).toBe(alice.id);
    }
  });

  it('accepts uploads/ keys from any caller, including anonymous legacy callers', async () => {
    const bob = await createUser('input_bob');
    const uploadKey = storeCsv(`uploads/${uniqueSuffix()}_scores.csv`);

    const legacyRes = await legacySubmit(uploadKey);
    expect(legacyRes.status).toBe(200);
    const legacyBody = await legacyRes.json();
    expect((await conversionQueue.getJob(legacyBody.jobId))?.data.storageKey).toBe(uploadKey);

    const v1Res = await v1Submit(uploadKey, await writeKeyHeaders(bob));
    expect(v1Res.status).toBe(202);
    const v1Body = await v1Res.json();
    expect((await conversionQueue.getJob(v1Body.jobId))?.data.storageKey).toBe(uploadKey);
  });
});
