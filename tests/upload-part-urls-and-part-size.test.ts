import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as uploadsHandler } from '../src/app/api/v1/uploads/[[...id]]/route';
import { POST as directPostHandler } from '../src/app/api/v1/uploads/direct/route';
import { PUT as directPartPutHandler } from '../src/app/api/v1/uploads/direct/part/route';
import { DELETE as directDeleteHandler } from '../src/app/api/v1/uploads/direct/[id]/route';
import { LOCAL_DIRECT_PART_PATH } from '../src/lib/storage/storage-config';
import { MAX_PREGENERATED_PART_URLS } from '../src/lib/storage/presign-limits';
import { localFsStorage, storageProvider } from '../src/lib/storage';
import { endUploadReservation } from '../src/lib/api-keys/anonymous-upload-budget';
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

describe('the part size and initial presigned part URL cap of POST /api/v1/uploads/direct', () => {
  let headers: Record<string, string>;
  const openedUploads: string[] = [];

  beforeEach(async () => {
    ({ headers } = await signedIn('partsize'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const uploadId of openedUploads.splice(0)) {
      await directDeleteHandler(new NextRequest(`${BASE_URL}/api/v1/uploads/direct/${uploadId}`, { method: 'DELETE', headers }), {
        params: Promise.resolve({ id: uploadId }),
      }).catch(() => undefined);
      await endUploadReservation(uploadId, 'aborted').catch(() => undefined);
    }
  });

  const initiate = async (body: Record<string, unknown>) => {
    const res = await directPostHandler(post('/api/v1/uploads/direct', headers, { filename: 'big.bin', ...body }));
    if (res.status === 200) {
      const cloned = (await res.clone().json()) as { uploadId?: string };
      if (cloned.uploadId) openedUploads.push(cloned.uploadId);
    }
    return res;
  };

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

  it('caps initial presigned part URLs at 100 while preserving totalParts and letting parts > 100 presign via ?action=presign', async () => {
    expect(MAX_PREGENERATED_PART_URLS).toBe(100);
    const presignSpy = vi.spyOn(storageProvider, 'generatePresignedUploadPartUrl');

    const res = await initiate({ totalSize: 600 * MIB, partSize: EXPECTED_MIN_PART_BYTES });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      uploadId: string;
      key: string;
      partSize: number;
      totalParts: number;
      parts: Array<{ partNumber: number; uploadUrl: string; expiresAt: number }>;
    };

    expect(body.totalParts).toBe(120);
    expect(body.parts).toHaveLength(100);
    expect(body.parts.map((part) => part.partNumber)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(presignSpy).toHaveBeenCalledTimes(100);

    // Remaining parts past 100 can be signed on demand via POST /api/v1/uploads?action=presign and uploaded to /api/v1/uploads/direct/part.
    const tailPresign = await uploadsHandler(
      post('/api/v1/uploads?action=presign', headers, { uploadId: body.uploadId, key: body.key, partNumber: 120 }),
      { params: Promise.resolve({}) }
    );
    expect(tailPresign.status).toBe(200);
    const tailPresignJson = (await tailPresign.json()) as { success: boolean; url: string };
    expect(tailPresignJson.success).toBe(true);
    const tailUrl = new URL(tailPresignJson.url);
    expect(tailUrl.searchParams.get('partNumber')).toBe('120');

    const tailPut = await directPartPutHandler(putPart(tailPresignJson.url, Buffer.from('PART_120_BYTES')));
    expect(tailPut.status).toBe(200);
    expect(await tailPut.json()).toMatchObject({ success: true, partNumber: 120 });

    // Another user cannot presign parts for this direct upload session.
    const stranger = await signedIn('stranger');
    const forbiddenPresign = await uploadsHandler(
      post('/api/v1/uploads?action=presign', stranger.headers, { uploadId: body.uploadId, key: body.key, partNumber: 101 }),
      { params: Promise.resolve({}) }
    );
    expect(forbiddenPresign.status).toBe(404);
  });

  it('caps a 10 GiB (2048-part) direct upload initiation at 100 presigned URLs', async () => {
    const presignSpy = vi.spyOn(storageProvider, 'generatePresignedUploadPartUrl');
    const res = await initiate({ totalSize: 10 * 1024 * MIB, partSize: EXPECTED_MIN_PART_BYTES });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totalParts: number; parts: Array<{ partNumber: number }> };
    expect(body.totalParts).toBe(2048);
    expect(body.parts).toHaveLength(100);
    expect(presignSpy).toHaveBeenCalledTimes(100);
  });

  it('preserves full initial parts at totalParts 99 and 100, and caps at 100 when totalParts is 101', async () => {
    const presignSpy = vi.spyOn(storageProvider, 'generatePresignedUploadPartUrl');

    for (const [totalParts, expectedInitialCount] of [
      [99, 99],
      [100, 100],
      [101, 100],
    ] as const) {
      presignSpy.mockClear();
      const res = await initiate({
        totalSize: totalParts * EXPECTED_MIN_PART_BYTES,
        partSize: EXPECTED_MIN_PART_BYTES,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        totalParts: number;
        parts: Array<{ partNumber: number }>;
      };
      expect(body.totalParts).toBe(totalParts);
      expect(body.parts).toHaveLength(expectedInitialCount);
      expect(body.parts.map((part) => part.partNumber)).toEqual(
        Array.from({ length: expectedInitialCount }, (_, idx) => idx + 1)
      );
      expect(presignSpy).toHaveBeenCalledTimes(expectedInitialCount);
    }
  });
});
