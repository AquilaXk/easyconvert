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
const FIXTURE_SIZE = 10;
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

describe('/api/storage/file response headers (#249)', () => {
  it('marks owner downloads private, no-store, and nosniff', async () => {
    const alice = await createUser('dl_alice');
    const key = storeObject(`conversions/${alice.id}/${uniqueSuffix()}_result.txt`);

    const res = await download(key, sessionHeaders(alice));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('etag')).toBe(storageProvider.getObject(key)?.etag);
    expect(res.headers.get('content-length')).toBe(String(FIXTURE_SIZE));
    expect(res.headers.get('content-type')).toBe(MIME_TYPE);
  });

  it('marks anonymous capability downloads private and no-store as well', async () => {
    const job = await conversionQueue.add('convert', jobData(undefined));
    const key = storeObject(`results/${job.id}/result.json`);

    const res = await download(key);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('keeps a hidden object 404 out of shared caches', async () => {
    const alice = await createUser('dl_alice');
    const key = storeObject(`conversions/${alice.id}/${uniqueSuffix()}_result.txt`);

    const res = await download(key);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('strips CR, LF, and quotes from the Content-Disposition filename', async () => {
    const key = storeObject(`uploads/${uniqueSuffix()}_report.txt`, FIXTURE, 're"port\r\nX-Injected: 1.txt');

    const res = await download(key);
    expect(res.status).toBe(200);
    const disposition = res.headers.get('content-disposition');
    expect(disposition).toBe(`attachment; filename="reportX-Injected: 1.txt"; filename*=UTF-8''reportX-Injected%3A%201.txt`);
    expect(res.headers.get('x-injected')).toBeNull();
  });

  it('encodes non-ASCII filenames with an RFC 5987 filename* and an ASCII fallback', async () => {
    const filename = '변환 결과.pdf';
    const key = storeObject(`uploads/${uniqueSuffix()}_korean.pdf`, FIXTURE, filename);

    const res = await download(key);
    expect(res.status).toBe(200);
    const disposition = res.headers.get('content-disposition') ?? '';
    expect(disposition).toBe(
      `attachment; filename="__ __.pdf"; filename*=UTF-8''%EB%B3%80%ED%99%98%20%EA%B2%B0%EA%B3%BC.pdf`
    );
    const extValue = disposition.split("filename*=UTF-8''")[1];
    expect(decodeURIComponent(extValue)).toBe(filename);
  });

  it('drops lone UTF-16 surrogates instead of failing to encode the filename', async () => {
    const key = storeObject(`uploads/${uniqueSuffix()}_surrogate.txt`, FIXTURE, 'bad\ud800name.txt');

    const res = await download(key);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="badname.txt"; filename*=UTF-8''badname.txt`);
  });

  it("percent-encodes the characters RFC 5987 excludes from attr-char (' ( ) *)", async () => {
    const key = storeObject(`uploads/${uniqueSuffix()}_marks.txt`, FIXTURE, "a'b(c)*.txt");

    const res = await download(key);
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="a'b(c)*.txt"; filename*=UTF-8''a%27b%28c%29%2A.txt`
    );
  });
});


describe('/api/storage/file Range requests per RFC 9110 (#249)', () => {
  const partialCases: Array<{ range: string; body: string; contentRange: string }> = [
    { range: 'bytes=0-3', body: '0123', contentRange: 'bytes 0-3/10' },
    { range: 'bytes=-2', body: '89', contentRange: 'bytes 8-9/10' },
    { range: 'bytes=5-', body: '56789', contentRange: 'bytes 5-9/10' },
    { range: 'bytes=3-100', body: '3456789', contentRange: 'bytes 3-9/10' },
    { range: 'bytes=-100', body: '0123456789', contentRange: 'bytes 0-9/10' },
    { range: 'Bytes=2-2', body: '2', contentRange: 'bytes 2-2/10' },
  ];

  it.each(partialCases)('answers $range with 206 and exactly the requested bytes', async ({ range, body, contentRange }) => {
    const key = storeObject(`uploads/${uniqueSuffix()}_range.txt`);

    const res = await download(key, { Range: range });
    expect(res.status).toBe(206);
    const bytes = await bodyBytes(res);
    expect(bytes.toString('ascii')).toBe(body);
    const [, first, last] = /^bytes (\d+)-(\d+)\/10$/.exec(contentRange) ?? [];
    expect(bytes.toString('hex')).toBe(FIXTURE.subarray(Number(first), Number(last) + 1).toString('hex'));
    expect(res.headers.get('content-range')).toBe(contentRange);
    expect(res.headers.get('content-length')).toBe(String(body.length));
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
  });

  const unsatisfiableRanges = ['bytes=10-', 'bytes=abc', 'bytes=abc-', 'bytes=4-2', 'bytes=-0', 'bytes=', 'bytes=1-2-3', '=0-3'];

  it.each(unsatisfiableRanges)('rejects %s with 416 and Content-Range: bytes */10', async (range) => {
    const key = storeObject(`uploads/${uniqueSuffix()}_range.txt`);

    const res = await download(key, { Range: range });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */10');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  const ignoredRanges = ['bytes=0-1,3-4', 'items=0-3'];

  it.each(ignoredRanges)('ignores %s and returns the full 200 body', async (range) => {
    const key = storeObject(`uploads/${uniqueSuffix()}_range.txt`);

    const res = await download(key, { Range: range });
    expect(res.status).toBe(200);
    expect((await bodyBytes(res)).toString('hex')).toBe(FIXTURE.toString('hex'));
    expect(res.headers.get('content-range')).toBeNull();
    expect(res.headers.get('content-length')).toBe(String(FIXTURE_SIZE));
  });

  it('rejects an int-range on an empty object and serves a suffix range as the full empty body', async () => {
    const key = storeObject(`uploads/${uniqueSuffix()}_empty.txt`, Buffer.alloc(0));

    const intRangeRes = await download(key, { Range: 'bytes=0-' });
    expect(intRangeRes.status).toBe(416);
    expect(intRangeRes.headers.get('content-range')).toBe('bytes */0');

    const suffixRes = await download(key, { Range: 'bytes=-5' });
    expect(suffixRes.status).toBe(200);
    expect((await bodyBytes(suffixRes)).length).toBe(0);
    expect(suffixRes.headers.get('content-range')).toBeNull();
  });
});
