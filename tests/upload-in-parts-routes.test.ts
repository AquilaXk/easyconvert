import crypto from 'node:crypto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as convertPost } from '../src/app/api/convert/route';
import { POST as batchPost } from '../src/app/api/convert/batch/route';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { POST as inspectPost } from '../src/app/api/v1/archives/inspect/route';
import { POST as multipartPost } from '../src/app/api/storage/multipart/route';
import { POST as v1JobsPost } from '../src/app/api/v1/jobs/route';
import { POST as queueJobsPost } from '../src/app/api/queue/jobs/route';
import { GET as queueJobGet, DELETE as queueJobDelete } from '../src/app/api/queue/jobs/[id]/route';
import { GET as storageFileGet } from '../src/app/api/storage/file/[...key]/route';
import { storageProvider } from '../src/lib/storage';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import type { User } from '../src/lib/auth/types';
import {
  PLAN_MAX_FILE_BYTES,
  SINGLE_REQUEST_BODY_MAX_BYTES,
  SINGLE_REQUEST_FILE_MAX_BYTES,
  UPLOAD_PART_MAX_BYTES,
} from '../src/lib/plan-limits';

const BASE_URL = 'http://localhost:3000';
const MIB = 1024 * 1024;
const PAYLOAD_TOO_LARGE = 413;
const PART_BYTES = 5 * MIB;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function createUser(): Promise<User> {
  const email = `parts_${Date.now()}_${crypto.randomBytes(6).toString('hex')}@upload-parts.test`;
  return userStore.sanitizeUser(await userStore.createUser({ email, name: 'parts', tier: 'free' }));
}

async function sessionHeaders(): Promise<Record<string, string>> {
  return { Cookie: `easyconvert_session=${createSessionToken(await createUser())}` };
}

function declaring(path: string, bytes: number): NextRequest {
  return new NextRequest(`${BASE_URL}${path}`, { method: 'POST', headers: { 'content-length': String(bytes) } });
}

describe('a route that takes a body whole refuses one past a single request before it reads it', () => {
  const ROUTES = [
    ['/api/convert', convertPost],
    ['/api/convert/batch', batchPost],
    ['/api/v1/convert', v1ConvertPost],
    ['/api/v1/archives/inspect', inspectPost],
    ['/api/v1/jobs', v1JobsPost],
    ['/api/queue/jobs', queueJobsPost],
  ] as const;

  it.each(ROUTES)('%s answers 413 with the way to send the file in parts', async (path, post) => {
    const res = await post(declaring(path, SINGLE_REQUEST_BODY_MAX_BYTES + 1));

    expect(res.status).toBe(PAYLOAD_TOO_LARGE);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = await res.json();
    expect(body).toMatchObject({ status: PAYLOAD_TOO_LARGE, title: 'Payload Too Large', success: false, instance: path });
    expect(body.maxRequestBytes).toBe(SINGLE_REQUEST_BODY_MAX_BYTES);
    expect(body.detail).toContain('64 MB');
    expect(body.detail).toContain('/api/storage/multipart');
    expect(body.detail).toContain('/api/v1/uploads');
    expect(body.detail).toContain('/api/queue/jobs');
  });

  it.each(ROUTES)('%s does not refuse a body of exactly the single request limit on its size', async (path, post) => {
    const res = await post(declaring(path, SINGLE_REQUEST_BODY_MAX_BYTES));

    expect(res.status).not.toBe(PAYLOAD_TOO_LARGE);
  });

  it('keeps the file of a single request and its framing under the 100 MB the edge in front of the host takes', () => {
    expect(SINGLE_REQUEST_BODY_MAX_BYTES).toBe(SINGLE_REQUEST_FILE_MAX_BYTES + MIB);
    expect(SINGLE_REQUEST_BODY_MAX_BYTES).toBeLessThan(100_000_000);
    expect(UPLOAD_PART_MAX_BYTES).toBeLessThanOrEqual(SINGLE_REQUEST_BODY_MAX_BYTES);
  });
});

describe('a file over a single request goes up in parts and is converted by a job, for a visitor without an account', () => {
  function multipart(action: string, body: unknown, headers: Record<string, string> = {}, extraQuery = ''): NextRequest {
    return new NextRequest(`${BASE_URL}/api/storage/multipart?action=${action}${extraQuery}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }

  function part(uploadId: string, partNumber: number, bytes: Buffer, headers: Record<string, string> = {}): NextRequest {
    return new NextRequest(
      `${BASE_URL}/api/storage/multipart?action=chunk&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...headers }, body: new Uint8Array(bytes) }
    );
  }

  function csvBytes(length: number): Buffer {
    const row = 'a,b,c\n';
    return Buffer.from(row.repeat(Math.ceil(length / row.length))).subarray(0, length);
  }

  async function uploadInTwoParts(headers: Record<string, string>): Promise<{ uploadId: string; key: string; total: number }> {
    const first = csvBytes(PART_BYTES);
    const second = csvBytes(1024);
    const total = first.length + second.length;
    const opened = await multipartPost(
      multipart('initiate', { filename: 'large.csv', mimeType: 'text/csv', totalSize: total, partSize: PART_BYTES }, headers)
    );
    expect(opened.status).toBe(200);
    const { uploadId, key, partSize } = await opened.json();
    expect(partSize).toBe(PART_BYTES);
    cleanups.push(() => {
      s3Storage.abortMultipartUpload(uploadId);
      s3Storage.deleteObject(key);
    });

    const receipts = [];
    for (const [index, bytes] of [first, second].entries()) {
      const stored = await multipartPost(part(uploadId, index + 1, bytes, headers));
      expect(stored.status).toBe(200);
      const body = await stored.json();
      expect(body).toMatchObject({ success: true, partNumber: index + 1, size: bytes.length });
      receipts.push({ partNumber: body.partNumber, etag: body.etag });
    }

    const done = await multipartPost(multipart('complete', { uploadId, parts: receipts }, headers));
    expect(done.status).toBe(200);
    const completed = await done.json();
    expect(completed).toMatchObject({ success: true, size: total });
    return { uploadId, key: completed.key, total };
  }

  it('opens the upload, takes the parts, completes it and queues a job that the visitor reads by its id', async () => {
    const { key, total } = await uploadInTwoParts({});

    const queued = await queueJobsPost(
      new NextRequest(`${BASE_URL}/api/queue/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'large.csv', targetFormat: 'json', storageKey: key, fileSize: total }),
      })
    );
    expect(queued.status).toBe(200);
    const { jobId } = await queued.json();
    expect(jobId).toMatch(/^job_/);

    const read = await queueJobGet(new NextRequest(`${BASE_URL}/api/queue/jobs/${jobId}`), { params: Promise.resolve({ id: jobId }) });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ success: true, id: jobId, data: { originalFilename: 'large.csv', targetFormat: 'json' } });

    const cancelled = await queueJobDelete(new NextRequest(`${BASE_URL}/api/queue/jobs/${jobId}`, { method: 'DELETE' }), {
      params: Promise.resolve({ id: jobId }),
    });
    expect(cancelled.status).toBe(200);
  });

  it('lets the visitor download the result of an anonymous job by its key, as a capability', async () => {
    const queued = await queueJobsPost(
      new NextRequest(`${BASE_URL}/api/queue/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: 'tiny.csv',
          targetFormat: 'json',
          inputBufferBase64: Buffer.from('a,b\n1,2\n').toString('base64'),
          fileSize: 8,
        }),
      })
    );
    const { jobId } = await queued.json();
    const ownedKey = `results/${jobId}/large.json`;
    storageProvider.saveObject(ownedKey, Buffer.from('[]'), 'application/json', 'large.json', 60_000);
    cleanups.push(() => {
      storageProvider.deleteObject(ownedKey);
    });

    const res = await storageFileGet(new NextRequest(`${BASE_URL}/api/storage/file/${encodeURIComponent(ownedKey)}`), {
      params: Promise.resolve({ key: ownedKey.split('/') }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('[]');
  });

  it('keeps the upload of a visitor from a signed-in caller, and the upload of an account from the visitor', async () => {
    const own = await sessionHeaders();
    const opened = await multipartPost(multipart('initiate', { filename: 'mine.csv', totalSize: 100 }, own));
    const { uploadId } = await opened.json();
    cleanups.push(() => {
      s3Storage.abortMultipartUpload(uploadId);
    });

    const visitorPart = await multipartPost(part(uploadId, 1, csvBytes(100)));
    expect(visitorPart.status).toBe(404);

    const otherAccount = await sessionHeaders();
    const otherAbort = await multipartPost(multipart('abort', { uploadId }, otherAccount));
    expect(otherAbort.status).toBe(404);

    const ownAbort = await multipartPost(multipart('abort', { uploadId }, own));
    expect(await ownAbort.json()).toEqual({ success: true });
  });

  it('refuses an upload past the limit of the visitor before opening a session', async () => {
    const res = await multipartPost(
      multipart('initiate', { filename: 'huge.bin', totalSize: PLAN_MAX_FILE_BYTES.anonymous + 1 })
    );

    expect(res.status).toBe(PAYLOAD_TOO_LARGE);
    expect((await res.json()).detail).toContain('limit for anonymous use');
  });

  it.each([
    ['below the smallest part of an object store', PART_BYTES - 1],
    ['above the largest part', UPLOAD_PART_MAX_BYTES + 1],
    ['not an integer', 6.5 * MIB + 0.5],
  ])('refuses a part size %s', async (_label, partSize) => {
    const res = await multipartPost(multipart('initiate', { filename: 'a.csv', totalSize: 100 * MIB, partSize }));

    expect(res.status).toBe(400);
    expect((await res.json()).detail).toContain('"partSize" must be an integer from');
  });

  it('refuses a part over the largest part before it reads the body', async () => {
    const opened = await multipartPost(multipart('initiate', { filename: 'a.csv', totalSize: 200 * MIB }));
    const { uploadId } = await opened.json();
    cleanups.push(() => {
      s3Storage.abortMultipartUpload(uploadId);
    });

    const res = await multipartPost(part(uploadId, 1, csvBytes(10), { 'content-length': String(UPLOAD_PART_MAX_BYTES + 1) }));

    expect(res.status).toBe(PAYLOAD_TOO_LARGE);
    expect((await res.json()).detail).toContain('Part size exceeds');
  });
});

describe('/api/v1/jobs holds every stored file of a graph to the plan limit', () => {
  async function storedUpload(owner: User, label: string): Promise<string> {
    const key = `uploads/${owner.id}/${label}_${crypto.randomBytes(4).toString('hex')}.csv`;
    storageProvider.saveObject(key, Buffer.from('a,b\n1,2\n'), 'text/csv', `${label}.csv`, 60_000);
    cleanups.push(() => {
      storageProvider.deleteObject(key);
    });
    return key;
  }

  it('refuses a graph whose second import.upload node reads a file over the limit, with the top-level file inside it', async () => {
    const user = await createUser();
    const small = await storedUpload(user, 'small');
    const large = await storedUpload(user, 'large');
    const realStat = storageProvider.stat.bind(storageProvider);
    vi.spyOn(storageProvider, 'stat').mockImplementation(async (key: string) => {
      const found = await realStat(key);
      return key === large && found ? { ...found, size: PLAN_MAX_FILE_BYTES.free + 1 } : found;
    });

    const res = await v1JobsPost(
      new NextRequest(`${BASE_URL}/api/v1/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `easyconvert_session=${createSessionToken(user)}` },
        body: JSON.stringify({
          storageKey: small,
          filename: 'small.csv',
          graph: {
            nodes: {
              a: { op: 'import.upload', storageKey: small },
              b: { op: 'import.upload', storageKey: large },
              c: { op: 'convert', input: 'a', targetFormat: 'json' },
              out: { op: 'export.internal', input: 'c' },
            },
          },
        }),
      })
    );

    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(PAYLOAD_TOO_LARGE);
    expect(body.title).toBe('Payload Too Large');
    expect(body.detail).toMatch(/exceeds the 1 GB limit for the free plan\. Pro allows files up to 5 GB\./);
  });
});
