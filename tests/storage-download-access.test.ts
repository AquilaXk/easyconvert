import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { GET as downloadRoute } from '../src/app/api/storage/file/[...key]/route';
import { storageProvider } from '../src/lib/storage';
import { conversionQueue } from '../src/lib/queue/conversion-queue';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import type { User } from '../src/lib/auth/types';
import type { ConversionJobData } from '../src/lib/types';

const BASE_URL = 'http://localhost:3000';
const ONE_HOUR_MS = 60 * 60 * 1000;
// Ten ASCII digits: every byte value equals its offset, so expected slices are readable literals.
const FIXTURE = Buffer.from('0123456789', 'ascii');
const MIME_TYPE = 'text/plain';

const createdKeys: string[] = [];

afterEach(() => {
  for (const key of createdKeys.splice(0)) {
    storageProvider.deleteObject(key);
  }
});

function uniqueSuffix(): string {
  return `${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

async function createUser(label: string): Promise<User> {
  const email = `${label}_${uniqueSuffix()}@storage-download.test`;
  return userStore.sanitizeUser(await userStore.createUser({ email, name: label, tier: 'pro' }));
}

function storeObject(key: string, buffer: Buffer = FIXTURE, filename = 'result.txt'): string {
  storageProvider.saveObject(key, buffer, MIME_TYPE, filename, ONE_HOUR_MS);
  createdKeys.push(key);
  return key;
}

function jobData(userId?: string): ConversionJobData {
  return {
    jobId: '',
    originalFilename: 'owner-check.csv',
    sourceFormat: 'csv',
    targetFormat: 'json',
    fileSize: 7,
    options: {},
    inputBufferBase64: Buffer.from('a,b\n1,2').toString('base64'),
    userId,
  };
}

/** Calls the real route the way a client follows a `downloadUrl` (`/api/storage/file/<encodeURIComponent(key)>`). */
function download(key: string, headers: Record<string, string> = {}): Promise<Response> {
  const encodedKey = encodeURIComponent(key);
  const req = new NextRequest(`${BASE_URL}/api/storage/file/${encodedKey}`, { headers });
  return downloadRoute(req, { params: { key: [encodedKey] } });
}

function sessionHeaders(user: User): Record<string, string> {
  return { Cookie: `easyconvert_session=${createSessionToken(user)}` };
}

function bearerHeaders(secretKey: string): Record<string, string> {
  return { Authorization: `Bearer ${secretKey}` };
}

async function bodyBytes(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

function notFoundBody(key: string): { success: false; error: string } {
  return { success: false, error: `Object not found for key: "${key}"` };
}

describe('/api/storage/file owner access (#249)', () => {
  it('serves a conversions/<userId> object to its owner session with the exact bytes', async () => {
    const alice = await createUser('dl_alice');
    const key = storeObject(`conversions/${alice.id}/${uniqueSuffix()}_result.txt`);

    const res = await download(key, sessionHeaders(alice));
    expect(res.status).toBe(200);
    expect((await bodyBytes(res)).toString('hex')).toBe(FIXTURE.toString('hex'));
  });

  it('answers other users and anonymous callers with the missing-object 404 body', async () => {
    const alice = await createUser('dl_alice');
    const bob = await createUser('dl_bob');
    const key = storeObject(`conversions/${alice.id}/${uniqueSuffix()}_result.txt`);

    const bobRes = await download(key, sessionHeaders(bob));
    expect(bobRes.status).toBe(404);
    expect(await bobRes.json()).toEqual(notFoundBody(key));

    const anonymousRes = await download(key);
    expect(anonymousRes.status).toBe(404);
    expect(await anonymousRes.json()).toEqual(notFoundBody(key));

    const bobAdminKey = await redisKeyStore.generateApiKey(bob.id, 'Bob admin', { scopes: ['*'] });
    const bobKeyRes = await download(key, bearerHeaders(bobAdminKey.secretKey));
    expect(bobKeyRes.status).toBe(404);
    expect(await bobKeyRes.json()).toEqual(notFoundBody(key));

    const missingKey = `conversions/${alice.id}/${uniqueSuffix()}_never-stored.txt`;
    const missingRes = await download(missingKey, sessionHeaders(alice));
    expect(missingRes.status).toBe(404);
    expect(await missingRes.json()).toEqual(notFoundBody(missingKey));
  });

  it('requires the storage:download scope on the owner API key', async () => {
    const alice = await createUser('dl_alice');
    const key = storeObject(`conversions/${alice.id}/${uniqueSuffix()}_result.txt`);

    const readKey = await redisKeyStore.generateApiKey(alice.id, 'Alice read', { scopes: ['convert:read'] });
    const readRes = await download(key, bearerHeaders(readKey.secretKey));
    expect(readRes.status).toBe(403);
    expect((await readRes.json()).error).toBe("Forbidden: API key lacks required scope 'storage:download'");

    const downloadKey = await redisKeyStore.generateApiKey(alice.id, 'Alice download', { scopes: ['storage:download'] });
    const downloadRes = await download(key, bearerHeaders(downloadKey.secretKey));
    expect(downloadRes.status).toBe(200);
    expect((await bodyBytes(downloadRes)).toString('hex')).toBe(FIXTURE.toString('hex'));
  });

  it('applies the job owner to results/<jobId> objects', async () => {
    const alice = await createUser('dl_alice');
    const bob = await createUser('dl_bob');
    const job = await conversionQueue.add('convert', jobData(alice.id));
    const key = storeObject(`results/${job.id}/result.json`);

    const ownerRes = await download(key, sessionHeaders(alice));
    expect(ownerRes.status).toBe(200);
    expect((await bodyBytes(ownerRes)).toString('hex')).toBe(FIXTURE.toString('hex'));

    const bobRes = await download(key, sessionHeaders(bob));
    expect(bobRes.status).toBe(404);
    expect(await bobRes.json()).toEqual(notFoundBody(key));

    const anonymousRes = await download(key);
    expect(anonymousRes.status).toBe(404);
    expect(await anonymousRes.json()).toEqual(notFoundBody(key));
  });

  it('keeps capability-URL access for anonymous job results', async () => {
    const job = await conversionQueue.add('convert', jobData(undefined));
    const key = storeObject(`results/${job.id}/result.json`);

    const res = await download(key);
    expect(res.status).toBe(200);
    expect((await bodyBytes(res)).toString('hex')).toBe(FIXTURE.toString('hex'));
  });

  it('keeps capability-URL access for results whose job record no longer exists', async () => {
    const key = storeObject(`results/job_0_${crypto.randomBytes(16).toString('hex')}/result.json`);

    const res = await download(key);
    expect(res.status).toBe(200);
    expect((await bodyBytes(res)).toString('hex')).toBe(FIXTURE.toString('hex'));
  });
});
