import { describe, it, expect, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { POST as multipartPost } from '../src/app/api/storage/multipart/route';
import { GET as downloadRoute } from '../src/app/api/storage/file/[...key]/route';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { resolveObjectOwnership, mayUseStorageKeyAsJobInput, STORAGE_OBJECT_NOT_FOUND } from '../src/lib/api-keys/owner-access';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import type { User } from '../src/lib/auth/types';

const BASE_URL = 'http://localhost:3000';
const createdKeys: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of createdKeys.splice(0)) {
    s3Storage.deleteObject(key);
  }
});

function uniqueSuffix(): string {
  return `${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

async function createUser(label: string, tier: 'free' | 'pro' | 'enterprise' = 'pro'): Promise<User> {
  const email = `${label}_${uniqueSuffix()}@upload-auth.test`;
  return userStore.sanitizeUser(await userStore.createUser({ email, name: label, tier }));
}

function sessionHeaders(user: User, extraHeaders: Record<string, string> = {}): Record<string, string> {
  return {
    Cookie: `easyconvert_session=${createSessionToken(user)}`,
    ...extraHeaders,
  };
}

describe('Security: Multipart Upload Authentication and Ownership Guard', () => {
  it('(a) rejects unauthenticated initiate, chunk, and complete requests with 401', async () => {
    // 1. initiate
    const initReq = new NextRequest(`${BASE_URL}/api/storage/multipart?action=initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'test.dat', totalSize: 1024 }),
    });
    const initRes = await multipartPost(initReq);
    expect(initRes.status).toBe(401);
    const initJson = await initRes.json();
    expect(initJson.status).toBe(401);
    expect(initJson.detail).toContain('Authentication required');

    // 2. chunk
    const chunkReq = new NextRequest(`${BASE_URL}/api/storage/multipart?action=chunk`, {
      method: 'POST',
      headers: {
        'x-upload-id': 'up_fake_123',
        'x-part-number': '1',
      },
      body: Buffer.from('chunk data'),
    });
    const chunkRes = await multipartPost(chunkReq);
    expect(chunkRes.status).toBe(401);

    // 3. complete
    const completeReq = new NextRequest(`${BASE_URL}/api/storage/multipart?action=complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId: 'up_fake_123', parts: [] }),
    });
    const completeRes = await multipartPost(completeReq);
    expect(completeRes.status).toBe(401);

    // 4. abort
    const abortReq = new NextRequest(`${BASE_URL}/api/storage/multipart?action=abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId: 'up_fake_123' }),
    });
    const abortRes = await multipartPost(abortReq);
    expect(abortRes.status).toBe(401);
  });

  it('(b) answers a chunk upload from user B with 404 when using user A uploadId', async () => {
    const alice = await createUser('alice');
    const bob = await createUser('bob');

    // Alice initiates upload
    const initReq = new NextRequest(`${BASE_URL}/api/storage/multipart?action=initiate`, {
      method: 'POST',
      headers: sessionHeaders(alice, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ filename: 'alice-doc.pdf', mimeType: 'application/pdf', totalSize: 2048 }),
    });
    const initRes = await multipartPost(initReq);
    expect(initRes.status).toBe(200);
    const initJson = await initRes.json();
    const uploadId = initJson.uploadId;
    expect(typeof uploadId).toBe('string');

    // Bob attempts to upload chunk with Alice's uploadId
    const bobChunkReq = new NextRequest(`${BASE_URL}/api/storage/multipart?action=chunk`, {
      method: 'POST',
      headers: sessionHeaders(bob, {
        'x-upload-id': uploadId,
        'x-part-number': '1',
      }),
      body: Buffer.from('malicious chunk data'),
    });
    const bobChunkRes = await multipartPost(bobChunkReq);
    expect(bobChunkRes.status).toBe(404);
    const bobJson = await bobChunkRes.json();
    expect(bobJson.detail).toBe(STORAGE_OBJECT_NOT_FOUND);

    // Bob attempts to complete Alice's upload
    const bobCompleteReq = new NextRequest(`${BASE_URL}/api/storage/multipart?action=complete`, {
      method: 'POST',
      headers: sessionHeaders(bob, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ uploadId, parts: [] }),
    });
    const bobCompleteRes = await multipartPost(bobCompleteReq);
    expect(bobCompleteRes.status).toBe(404);
    expect((await bobCompleteRes.json()).detail).toBe(STORAGE_OBJECT_NOT_FOUND);

    // Clean up
    s3Storage.abortMultipartUpload(uploadId);
  });

  it('(c) rejects parts exceeding 64 MiB with 413, and rejects totalSize exceeding tier limit with 413', async () => {
    const alice = await createUser('alice_size', 'free');

    // 1. totalSize exceeds free tier limit (100 MiB)
    const overTierReq = new NextRequest(`${BASE_URL}/api/storage/multipart?action=initiate`, {
      method: 'POST',
      headers: sessionHeaders(alice, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        filename: 'huge-archive.zip',
        mimeType: 'application/zip',
        totalSize: 101 * 1024 * 1024, // 101 MiB > 100 MiB free tier
      }),
    });
    const overTierRes = await multipartPost(overTierReq);
    expect(overTierRes.status).toBe(413);
    const overTierJson = await overTierRes.json();
    expect(overTierJson.status).toBe(413);
    expect(overTierJson.detail).toContain('exceeds maximum allowed upload size');

    // 2. Part size exceeds 64 MiB
    const validInitReq = new NextRequest(`${BASE_URL}/api/storage/multipart?action=initiate`, {
      method: 'POST',
      headers: sessionHeaders(alice, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        filename: 'data.bin',
        mimeType: 'application/octet-stream',
        totalSize: 50 * 1024 * 1024,
      }),
    });
    const validInitRes = await multipartPost(validInitReq);
    expect(validInitRes.status).toBe(200);
    const { uploadId } = await validInitRes.json();

    // 64 MiB + 1 byte payload check via Content-Length header
    const overPartBytes = 64 * 1024 * 1024 + 1;
    const overPartReq = new NextRequest(`${BASE_URL}/api/storage/multipart?action=chunk`, {
      method: 'POST',
      headers: sessionHeaders(alice, {
        'x-upload-id': uploadId,
        'x-part-number': '1',
        'content-length': String(overPartBytes),
      }),
      body: Buffer.from('oversized-chunk-header-test'),
    });
    const overPartRes = await multipartPost(overPartReq);
    expect(overPartRes.status).toBe(413);
    const overPartJson = await overPartRes.json();
    expect(overPartJson.status).toBe(413);
    expect(overPartJson.detail).toContain('exceeds maximum allowed part size');

    s3Storage.abortMultipartUpload(uploadId);
  });

  it('(d) ensures normal multipart flow registers completed object in user namespace owned by user A', async () => {
    const alice = await createUser('alice_flow');
    const bob = await createUser('bob_flow');

    // 1. Initiate upload as Alice
    const payloadBytes = Buffer.from('AUTHENTIC_PAYLOAD_CHUNK_FOR_ALICE');
    const initReq = new NextRequest(`${BASE_URL}/api/storage/multipart?action=initiate`, {
      method: 'POST',
      headers: sessionHeaders(alice, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        filename: 'alice_presentation.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        totalSize: payloadBytes.length,
      }),
    });
    const initRes = await multipartPost(initReq);
    expect(initRes.status).toBe(200);
    const { uploadId, key } = await initRes.json();
    expect(key).toContain(`conversions/${alice.id}/`);

    // 2. Upload part 1 as Alice
    const chunkReq = new NextRequest(`${BASE_URL}/api/storage/multipart?action=chunk`, {
      method: 'POST',
      headers: sessionHeaders(alice, {
        'x-upload-id': uploadId,
        'x-part-number': '1',
      }),
      body: payloadBytes,
    });
    const chunkRes = await multipartPost(chunkReq);
    expect(chunkRes.status).toBe(200);
    const { etag } = await chunkRes.json();
    expect(etag).toMatch(/^"[a-f0-9]{32}"$/);

    // 3. Complete upload as Alice
    const completeReq = new NextRequest(`${BASE_URL}/api/storage/multipart?action=complete`, {
      method: 'POST',
      headers: sessionHeaders(alice, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        uploadId,
        parts: [{ partNumber: 1, etag }],
      }),
    });
    const completeRes = await multipartPost(completeReq);
    expect(completeRes.status).toBe(200);
    const completeJson = await completeRes.json();
    expect(completeJson.success).toBe(true);
    const completedKey = completeJson.key;
    createdKeys.push(completedKey);

    // 4. Assert ownership: resolveObjectOwnership(completedKey) returns ownerUserId = Alice
    const ownership = await resolveObjectOwnership(completedKey);
    expect(ownership.resolved).toBe(true);
    expect((ownership as { resolved: true; ownerUserId: string }).ownerUserId).toBe(alice.id);

    // 5. Download route: Bob gets 404
    const encodedKey = encodeURIComponent(completedKey);
    const bobDownloadReq = new NextRequest(`${BASE_URL}/api/storage/file/${encodedKey}`, {
      headers: sessionHeaders(bob),
    });
    const bobDownloadRes = await downloadRoute(bobDownloadReq, { params: { key: [encodedKey] } });
    expect(bobDownloadRes.status).toBe(404);

    // 6. Download route: Alice gets 200 with matching bytes
    const aliceDownloadReq = new NextRequest(`${BASE_URL}/api/storage/file/${encodedKey}`, {
      headers: sessionHeaders(alice),
    });
    const aliceDownloadRes = await downloadRoute(aliceDownloadReq, { params: { key: [encodedKey] } });
    expect(aliceDownloadRes.status).toBe(200);
    const downloadedBuf = Buffer.from(await aliceDownloadRes.arrayBuffer());
    expect(downloadedBuf.toString('utf8')).toBe(payloadBytes.toString('utf8'));

    // 7. Job input check: Alice is permitted, Bob is rejected
    expect(await mayUseStorageKeyAsJobInput(completedKey, alice.id)).toBe(true);
    expect(await mayUseStorageKeyAsJobInput(completedKey, bob.id)).toBe(false);
  });

  it('(e) rejects non-finite totalSize at initiate and cumulative bytes exceeding tier limit', async () => {
    const alice = await createUser('alice_limits', 'free');

    // 1. Rejects NaN / non-finite totalSize
    const nanReq = new NextRequest(`${BASE_URL}/api/storage/multipart?action=initiate`, {
      method: 'POST',
      headers: sessionHeaders(alice, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ filename: 'test.bin', totalSize: NaN }),
    });
    const nanRes = await multipartPost(nanReq);
    expect(nanRes.status).toBe(400);

    // 2. Reject cumulative bytes exceeding tier limit
    // For free tier (100 MiB), initiate a valid large session (e.g. 90 MiB)
    const largeInitReq = new NextRequest(`${BASE_URL}/api/storage/multipart?action=initiate`, {
      method: 'POST',
      headers: sessionHeaders(alice, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ filename: 'large_stream.bin', totalSize: 90 * 1024 * 1024 }),
    });
    const largeInitRes = await multipartPost(largeInitReq);
    expect(largeInitRes.status).toBe(200);
    const largeSession = await largeInitRes.json();

    // Upload part 1: 60 MiB
    const part1Buf = Buffer.alloc(60 * 1024 * 1024, 0xaa);
    const part1Req = new NextRequest(`${BASE_URL}/api/storage/multipart?action=chunk`, {
      method: 'POST',
      headers: sessionHeaders(alice, {
        'x-upload-id': largeSession.uploadId,
        'x-part-number': '1',
      }),
      body: part1Buf,
    });
    const part1Res = await multipartPost(part1Req);
    expect(part1Res.status).toBe(200);

    // Upload part 2: 50 MiB (60 + 50 = 110 MiB > 100 MiB free tier limit)
    // Check via Content-Length header or body size
    const part2Req = new NextRequest(`${BASE_URL}/api/storage/multipart?action=chunk`, {
      method: 'POST',
      headers: sessionHeaders(alice, {
        'x-upload-id': largeSession.uploadId,
        'x-part-number': '2',
        'content-length': String(50 * 1024 * 1024),
      }),
      body: Buffer.from('mock content length probe'),
    });
    const part2Res = await multipartPost(part2Req);
    expect(part2Res.status).toBe(413);
    const part2Json = await part2Res.json();
    expect(part2Json.detail).toContain('exceeds maximum allowed size');

    s3Storage.abortMultipartUpload(largeSession.uploadId);
  });

  it('(f) validates parts on complete: rejects empty parts, missing parts, and mismatched ETags with 400', async () => {
    const alice = await createUser('alice_part_val');

    // Initiate upload
    const initReq = new NextRequest(`${BASE_URL}/api/storage/multipart?action=initiate`, {
      method: 'POST',
      headers: sessionHeaders(alice, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ filename: 'multi-part.bin', totalSize: 2048 }),
    });
    const initRes = await multipartPost(initReq);
    expect(initRes.status).toBe(200);
    const { uploadId } = await initRes.json();

    // Upload part 1
    const chunk1Req = new NextRequest(`${BASE_URL}/api/storage/multipart?action=chunk`, {
      method: 'POST',
      headers: sessionHeaders(alice, {
        'x-upload-id': uploadId,
        'x-part-number': '1',
      }),
      body: Buffer.from('part-1-content'),
    });
    const chunk1Res = await multipartPost(chunk1Req);
    expect(chunk1Res.status).toBe(200);
    const { etag: etag1 } = await chunk1Res.json();

    // 1. Rejects empty parts array with 400
    const emptyPartsReq = new NextRequest(`${BASE_URL}/api/storage/multipart?action=complete`, {
      method: 'POST',
      headers: sessionHeaders(alice, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ uploadId, parts: [] }),
    });
    const emptyPartsRes = await multipartPost(emptyPartsReq);
    expect(emptyPartsRes.status).toBe(400);
    expect((await emptyPartsRes.json()).detail).toContain('Missing or empty "parts" array');

    // 2. Rejects missing part number (part 2 was never uploaded) with 400
    const missingPartReq = new NextRequest(`${BASE_URL}/api/storage/multipart?action=complete`, {
      method: 'POST',
      headers: sessionHeaders(alice, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        uploadId,
        parts: [{ partNumber: 2, etag: '"00000000000000000000000000000000"' }],
      }),
    });
    const missingPartRes = await multipartPost(missingPartReq);
    expect(missingPartRes.status).toBe(400);
    expect((await missingPartRes.json()).detail).toContain('Missing part number 2');

    // 3. Rejects mismatched ETag for part 1 with 400
    const wrongEtagReq = new NextRequest(`${BASE_URL}/api/storage/multipart?action=complete`, {
      method: 'POST',
      headers: sessionHeaders(alice, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        uploadId,
        parts: [{ partNumber: 1, etag: '"tampered_etag_value_00000000000"' }],
      }),
    });
    const wrongEtagRes = await multipartPost(wrongEtagReq);
    expect(wrongEtagRes.status).toBe(400);
    expect((await wrongEtagRes.json()).detail).toContain('ETag mismatch');

    // 4. Direct low-level s3Storage validation asserts fail-closed
    expect(() => s3Storage.completeMultipartUpload(uploadId, [])).toThrow(/zero parts/i);
    expect(() =>
      s3Storage.completeMultipartUpload(uploadId, [{ partNumber: 99 }])
    ).toThrow(/Missing part number 99/i);
    expect(() =>
      s3Storage.completeMultipartUpload(uploadId, [{ partNumber: 1, etag: '"bad"' }])
    ).toThrow(/ETag mismatch/i);

    // 5. Valid complete with correct parts succeeds
    const validCompleteReq = new NextRequest(`${BASE_URL}/api/storage/multipart?action=complete`, {
      method: 'POST',
      headers: sessionHeaders(alice, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        uploadId,
        parts: [{ partNumber: 1, etag: etag1 }],
      }),
    });
    const validCompleteRes = await multipartPost(validCompleteReq);
    expect(validCompleteRes.status).toBe(200);
    const validJson = await validCompleteRes.json();
    expect(validJson.success).toBe(true);
    createdKeys.push(validJson.key);
  });
});
