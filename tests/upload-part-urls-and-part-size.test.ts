import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as uploadsHandler } from '../src/app/api/v1/uploads/[[...id]]/route';
import { POST as directPostHandler } from '../src/app/api/v1/uploads/direct/route';
import { PUT as directPartPutHandler } from '../src/app/api/v1/uploads/direct/part/route';
import { LOCAL_DIRECT_PART_PATH } from '../src/lib/storage/storage-config';
import { localFsStorage } from '../src/lib/storage';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import type { User } from '../src/lib/auth/types';

const BASE_URL = 'http://localhost:3000';
const MIB = 1024 * 1024;
// Hand-written from the brief: the part size S3 and the object stores of the other drivers take as the smallest of a part that is not the last.
const EXPECTED_MIN_PART_BYTES = 5 * MIB;

async function signedIn(label: string): Promise<{ user: User; headers: Record<string, string> }> {
  const email = `${label}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@parts.test`;
  const user = userStore.sanitizeUser(await userStore.createUser({ email, name: label, tier: 'paid' }));
  return { user, headers: { Cookie: `easyconvert_session=${createSessionToken(user)}` } };
}

function post(path: string, headers: Record<string, string>, body: unknown): NextRequest {
  return new NextRequest(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function putPart(url: string, body: Buffer): NextRequest {
  return new NextRequest(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    }),
    duplex: 'half',
  } as never);
}

describe('part URLs of an upload opened on /api/v1/uploads with the local driver', () => {
  let headers: Record<string, string>;

  beforeEach(async () => {
    ({ headers } = await signedIn('presign'));
  });

  it('point at the route that takes parts with PUT, and that route takes them: initiate, PUT the part, complete', async () => {
    const content = Buffer.from('PART_URLS_OF_THE_LOCAL_DRIVER_REACH_THE_PUT_ROUTE');
    const init = await uploadsHandler(post('/api/v1/uploads?action=initiate', headers, { filename: 'local-presign.txt', mimeType: 'text/plain', totalSize: content.length }), {
      params: Promise.resolve({}),
    });
    expect(init.status).toBe(200);
    const initiated = await init.json();
    const presigned = initiated.presignedUrls[0] as { url: string; method: string };
    expect(presigned.method).toBe('PUT');
    expect(new URL(presigned.url).pathname).toBe(LOCAL_DIRECT_PART_PATH);

    const part = await directPartPutHandler(putPart(presigned.url, content));
    expect(part.status).toBe(200);
    const stored = await part.json();

    const complete = await uploadsHandler(post('/api/v1/uploads?action=complete', headers, { uploadId: initiated.uploadId, parts: [{ partNumber: 1, etag: stored.etag }], expectedSize: content.length }), {
      params: Promise.resolve({}),
    });
    expect(complete.status).toBe(200);
    const completed = await complete.json();
    expect(completed.size).toBe(content.length);
    const object = await localFsStorage.getStream(completed.key);
    const bytes: Buffer[] = [];
    for await (const piece of object!.stream) bytes.push(Buffer.from(piece));
    expect(Buffer.concat(bytes)).toEqual(content);
  });

  it('are refused by the part route when the part number or the key was changed', async () => {
    const content = Buffer.from('SIGNED_FOR_ONE_PART');
    const init = await uploadsHandler(post('/api/v1/uploads?action=initiate', headers, { filename: 'signed.txt', mimeType: 'text/plain', totalSize: content.length }), {
      params: Promise.resolve({}),
    });
    const { url } = (await init.json()).presignedUrls[0] as { url: string };
    const moved = new URL(url);
    moved.searchParams.set('partNumber', '2');
    expect((await directPartPutHandler(putPart(moved.toString(), content))).status).toBe(403);
  });
});

describe('the part size of POST /api/v1/uploads/direct', () => {
  let headers: Record<string, string>;

  beforeEach(async () => {
    ({ headers } = await signedIn('partsize'));
  });

  const initiate = (body: Record<string, unknown>) => directPostHandler(post('/api/v1/uploads/direct', headers, { filename: 'big.bin', ...body }));

  it('refuses a part size under 5 MiB for a file of more than one part', async () => {
    const res = await initiate({ totalSize: 20 * MIB, partSize: MIB });
    expect(res.status).toBe(400);
    expect((await res.json()).detail).toContain('5 MiB');
  });

  it('takes the smallest size, 5 MiB, and tells how many parts that makes', async () => {
    const res = await initiate({ totalSize: 12 * MIB, partSize: EXPECTED_MIN_PART_BYTES });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ partSize: EXPECTED_MIN_PART_BYTES, totalParts: 3 });
  });

  it('takes a part size under 5 MiB when the file fits in that one part, the last part of the file', async () => {
    const res = await initiate({ totalSize: 3 * MIB, partSize: 3 * MIB });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ partSize: 3 * MIB, totalParts: 1 });
  });

  it('takes a file without a part size, as before', async () => {
    const res = await initiate({ totalSize: 12 * MIB });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ partSize: EXPECTED_MIN_PART_BYTES, totalParts: 3 });
  });
});
