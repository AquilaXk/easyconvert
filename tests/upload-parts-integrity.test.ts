import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as multipartPost } from '../src/app/api/storage/multipart/route';
import { POST as v1UploadsPost } from '../src/app/api/v1/uploads/[[...id]]/route';
import { POST as directPost } from '../src/app/api/v1/uploads/direct/route';
import { PUT as directPartPut } from '../src/app/api/v1/uploads/direct/part/route';
import { POST as queueJobsPost } from '../src/app/api/queue/jobs/route';
import { S3ObjectStorageService, s3Storage } from '../src/lib/storage/s3-storage';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import { INLINE_JOB_PAYLOAD_MAX_BYTES, UPLOAD_PART_MAX_BYTES } from '../src/lib/plan-limits';

const BASE_URL = 'http://localhost:3000';
const MIB = 1024 * 1024;
const PART_BYTES = 5 * MIB;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function account(): Promise<Record<string, string>> {
  const email = `parts_${Date.now()}_${crypto.randomBytes(6).toString('hex')}@integrity.test`;
  const user = userStore.sanitizeUser(await userStore.createUser({ email, name: 'parts', tier: 'free' }));
  return { Cookie: `easyconvert_session=${createSessionToken(user)}` };
}

function multipart(action: string, body: unknown): NextRequest {
  return new NextRequest(`${BASE_URL}/api/storage/multipart?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function part(uploadId: string, partNumber: number, bytes: Buffer, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(
    `${BASE_URL}/api/storage/multipart?action=chunk&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`,
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...headers }, body: new Uint8Array(bytes) }
  );
}

function bytesOf(length: number, fill: string): Buffer {
  return Buffer.alloc(length, fill);
}

/** An upload of two parts, 5 MiB and 1 KiB, stored and not completed. */
async function storedParts(): Promise<{ uploadId: string; key: string; receipts: Array<{ partNumber: number; etag: string }> }> {
  const sizes = [PART_BYTES, 1024];
  const opened = await multipartPost(multipart('initiate', { filename: 'a.csv', totalSize: sizes[0] + sizes[1], partSize: PART_BYTES }));
  const { uploadId, key } = await opened.json();
  cleanups.push(() => {
    s3Storage.abortMultipartUpload(uploadId);
    s3Storage.deleteObject(key);
  });
  const receipts = [];
  for (const [index, size] of sizes.entries()) {
    const stored = await multipartPost(part(uploadId, index + 1, bytesOf(size, 'a')));
    receipts.push({ partNumber: index + 1, etag: (await stored.json()).etag });
  }
  return { uploadId, key, receipts };
}

describe('complete assembles only parts numbered from 1 without gaps, holding exactly the declared size', () => {
  it.each([
    ['a part listed twice', (r: Array<{ partNumber: number; etag: string }>) => [r[0], r[0]]],
    ['a missing part', (r: Array<{ partNumber: number; etag: string }>) => [r[1]]],
    ['parts out of order', (r: Array<{ partNumber: number; etag: string }>) => [r[1], r[0]]],
  ])('refuses %s and leaves the session open', async (_label, pick) => {
    const { uploadId, receipts } = await storedParts();

    const res = await multipartPost(multipart('complete', { uploadId, parts: pick(receipts) }));

    expect(res.status).toBe(400);
    expect((await res.json()).detail).toMatch(/numbered 1, 2, 3|bytes, but the upload declared/);
    expect(s3Storage.getUploadSession(uploadId)).toBeDefined();
  });

  it('refuses parts that hold less than the declared size, listed or not', async () => {
    const opened = await multipartPost(multipart('initiate', { filename: 'a.csv', totalSize: 4096 }));
    const { uploadId } = await opened.json();
    cleanups.push(() => {
      s3Storage.abortMultipartUpload(uploadId);
    });
    const stored = await multipartPost(part(uploadId, 1, bytesOf(1000, 'b')));
    const { etag } = await stored.json();

    for (const body of [{ uploadId, parts: [{ partNumber: 1, etag }] }, { uploadId }]) {
      const res = await multipartPost(multipart('complete', body));
      expect(res.status).toBe(400);
      expect((await res.json()).detail).toBe('The parts hold 1000 bytes, but the upload declared 4096 bytes.');
    }
  });

  it('refuses a part that would carry the stored bytes past the declared size', async () => {
    const opened = await multipartPost(multipart('initiate', { filename: 'a.csv', totalSize: 1000 }));
    const { uploadId } = await opened.json();
    cleanups.push(() => {
      s3Storage.abortMultipartUpload(uploadId);
    });

    const res = await multipartPost(part(uploadId, 1, bytesOf(1001, 'c')));

    expect(res.status).toBe(413);
    expect(s3Storage.getUploadedParts(uploadId)).toEqual([]);
  });

  it('completes parts 1 and 2 in order at exactly the declared size', async () => {
    const { uploadId, key, receipts } = await storedParts();

    const res = await multipartPost(multipart('complete', { uploadId, parts: receipts }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ key, size: PART_BYTES + 1024 });
  });
});

describe('two writers of one part never share a temporary file', () => {
  function slowStream(fill: string, chunks: number, chunkBytes: number): Readable {
    let sent = 0;
    return new Readable({
      read() {
        if (sent === chunks) {
          this.push(null);
          return;
        }
        sent += 1;
        setImmediate(() => this.push(Buffer.alloc(chunkBytes, fill)));
      },
    });
  }

  it('keeps the stored part equal to the etag it reports and leaves no temporary file', async () => {
    const baseUploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parts-race-'));
    const storage = new S3ObjectStorageService({ baseUploadDir, signingSecret: 'race-secret' });
    cleanups.push(() => {
      storage.stopGc();
      fs.rmSync(baseUploadDir, { recursive: true, force: true });
    });
    const { uploadId } = storage.initiateMultipartUpload('race.bin', 'application/octet-stream', 2 * MIB, 'user_race', PART_BYTES);

    const [first, second] = await Promise.allSettled([
      storage.uploadPartStream(uploadId, 1, slowStream('x', 32, 32 * 1024)),
      storage.uploadPartStream(uploadId, 1, slowStream('y', 32, 32 * 1024)),
    ]);
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('fulfilled');

    const [stored] = storage.getUploadedParts(uploadId) ?? [];
    const sessionDir = path.join(baseUploadDir, uploadId);
    const onDisk = fs.readFileSync(path.join(sessionDir, 'part-1.bin'));
    expect(onDisk.length).toBe(MIB);
    expect(new Set(onDisk).size).toBe(1);
    expect(stored.etag).toBe(`"${crypto.createHash('sha256').update(onDisk).digest('hex').slice(0, 32)}"`);
    expect(fs.readdirSync(sessionDir).filter((name) => name.includes('.tmp'))).toEqual([]);
    storage.abortMultipartUpload(uploadId);
  });
});

describe('every part route refuses a malformed or oversize Content-Length before it reads the part', () => {
  it.each([
    ['not a number', 'abc', 400],
    ['a number with a suffix', '12x', 400],
    ['over the largest part', String(UPLOAD_PART_MAX_BYTES + 1), 413],
  ])('/api/storage/multipart answers %s', async (_label, length, status) => {
    const opened = await multipartPost(multipart('initiate', { filename: 'a.csv', totalSize: 200 * MIB }));
    const { uploadId } = await opened.json();
    cleanups.push(() => {
      s3Storage.abortMultipartUpload(uploadId);
    });

    const res = await multipartPost(part(uploadId, 1, bytesOf(10, 'd'), { 'content-length': length }));

    expect(res.status).toBe(status);
  });

  it.each([
    ['not a number', 'abc', 400],
    ['over the largest part', String(UPLOAD_PART_MAX_BYTES + 1), 413],
  ])('/api/v1/uploads parts answer %s', async (_label, length, status) => {
    const res = await v1UploadsPost(
      new NextRequest(`${BASE_URL}/api/v1/uploads?action=part&uploadId=up_1&partNumber=1`, {
        method: 'POST',
        headers: { ...(await account()), 'content-length': length },
        body: new Uint8Array(10),
      }),
      { params: Promise.resolve({ id: undefined }) }
    );
    expect(res.status).toBe(status);
  });

  it.each([
    ['not a number', 'abc', 400],
    ['over the largest part', String(UPLOAD_PART_MAX_BYTES + 1), 413],
  ])('/api/v1/uploads/direct/part answers %s', async (_label, length, status) => {
    const res = await directPartPut(
      new NextRequest(`${BASE_URL}/api/v1/uploads/direct/part?uploadId=up_1&partNumber=1`, {
        method: 'PUT',
        headers: { 'content-length': length },
        body: new Uint8Array(10),
      })
    );
    expect(res.status).toBe(status);
  });
});

describe('the part size an upload route chooses is at most what one request carries', () => {
  it.each([
    ['/api/v1/uploads', (req: NextRequest) => v1UploadsPost(req, { params: Promise.resolve({ id: undefined }) }), '/api/v1/uploads?action=initiate'],
    ['/api/v1/uploads/direct', (req: NextRequest) => directPost(req), '/api/v1/uploads/direct'],
  ])('%s caps a requested part of 1 GiB at 64 MiB', async (_label, post, url) => {
    const res = await post(
      new NextRequest(`${BASE_URL}${url}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await account()) },
        body: JSON.stringify({ filename: 'big.csv', totalSize: 512 * MIB, partSize: 1024 * MIB }),
      })
    );
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.partSize).toBe(UPLOAD_PART_MAX_BYTES);
    expect(body.totalParts).toBe(8);
  });
});

describe('/api/queue/jobs takes at most 32 MiB of file inside the request, as /api/v1/jobs does', () => {
  it('refuses inline base64 that decodes past 32 MiB', async () => {
    const res = await queueJobsPost(
      new NextRequest(`${BASE_URL}/api/queue/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'a.csv', targetFormat: 'json', inputBufferBase64: 'A'.repeat(Math.ceil(((INLINE_JOB_PAYLOAD_MAX_BYTES + 3) * 4) / 3)) }),
      })
    );
    expect(res.status).toBe(413);
    expect((await res.json()).detail).toContain('at most 32 MiB');
  });

  it('refuses a form file past 32 MiB before it is stored', async () => {
    const form = new FormData();
    form.append('file', new File([new Uint8Array(INLINE_JOB_PAYLOAD_MAX_BYTES + 1)], 'a.csv', { type: 'text/csv' }));
    form.append('targetFormat', 'json');

    const res = await queueJobsPost(new NextRequest(`${BASE_URL}/api/queue/jobs`, { method: 'POST', body: form }));

    expect(res.status).toBe(413);
  });
});
