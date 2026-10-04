import crypto from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  OPTIONS as tusOptionsHandler,
  POST as tusPostHandler,
  HEAD as tusHeadHandler,
  PATCH as tusPatchHandler,
  DELETE as tusDeleteHandler,
} from '../src/app/api/v1/uploads/[[...id]]/route';
import { localFsStorage } from '../src/lib/storage';
import { serializeTusMetadata, SessionLockManager, tusEngine } from '../src/lib/storage/tus-engine';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import type { ApiKeyScope } from '../src/lib/api-keys/types';
import type { User } from '../src/lib/auth/types';

const BASE_URL = 'http://localhost:3000';

function uniqueSuffix(): string {
  return `${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

async function createUser(label: string): Promise<User> {
  const email = `${label}_${uniqueSuffix()}@tus-protocol-test.local`;
  return userStore.sanitizeUser(await userStore.createUser({ email, name: label, tier: 'pro' }));
}

function sessionHeaders(user: User): Record<string, string> {
  return { Cookie: `easyconvert_session=${createSessionToken(user)}` };
}

async function apiKeyHeaders(user: User, scopes: ApiKeyScope[] = ['convert:write']): Promise<Record<string, string>> {
  const key = await redisKeyStore.generateApiKey(user.id, `${user.name} key`, { scopes });
  return { Authorization: `Bearer ${key.secretKey}` };
}

function createStreamRequest(url: string, init: any): NextRequest {
  return new NextRequest(url, { ...init, duplex: 'half' } as any);
}

function sha256Base64(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('base64');
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

describe('TUS 1.0 Protocol Rigorous Specification Compliance', () => {
  let userA: User;
  let userB: User;

  beforeEach(async () => {
    userA = await createUser('tus_spec_user_a');
    userB = await createUser('tus_spec_user_b');
  });

  it('advertises all required TUS 1.0 extensions and checksum capabilities via OPTIONS', async () => {
    const res = await tusOptionsHandler();
    expect(res.status).toBe(204);
    expect(res.headers.get('Tus-Resumable')).toBe('1.0.0');
    expect(res.headers.get('Tus-Version')).toBe('1.0.0');

    const extensions = res.headers.get('Tus-Extension') || '';
    expect(extensions).toContain('creation');
    expect(extensions).toContain('creation-with-upload');
    expect(extensions).toContain('termination');
    expect(extensions).toContain('expiration');
    expect(extensions).toContain('checksum');

    expect(res.headers.get('Tus-Checksum-Algorithm')).toContain('sha256');
    expect(res.headers.get('Tus-Max-Size')).toBe(String(5 * 1024 * 1024 * 1024));

    const exposed = res.headers.get('Access-Control-Expose-Headers') || '';
    expect(exposed).toContain('EasyConvert-Storage-Key');
    expect(exposed).toContain('X-Storage-Key');
    expect(exposed).toContain('Upload-Offset');
  });

  it('executes chunked upload with byte-for-byte SHA256 integrity match', async () => {
    const authHeaders = sessionHeaders(userA);

    // Create a 192 KiB deterministic payload across 3 chunks
    const chunk1 = crypto.randomBytes(64 * 1024);
    const chunk2 = crypto.randomBytes(48 * 1024);
    const chunk3 = crypto.randomBytes(80 * 1024);
    const fullPayload = Buffer.concat([chunk1, chunk2, chunk3]);
    const totalLength = fullPayload.length;
    const expectedSha256 = sha256Hex(fullPayload);

    const metadata = serializeTusMetadata({
      filename: 'dataset-sample.bin',
      filetype: 'application/octet-stream',
    });

    // 1. POST creation
    const postReq = new NextRequest(`${BASE_URL}/api/v1/uploads`, {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(totalLength),
        'Upload-Metadata': metadata,
        ...authHeaders,
      },
    });
    const postRes = await tusPostHandler(postReq);
    expect(postRes.status).toBe(201);
    const location = postRes.headers.get('Location');
    expect(location).toMatch(/^\/api\/v1\/uploads\/[a-zA-Z0-9_-]+$/);
    const sessionId = location!.split('/').pop()!;

    // 2. PATCH Chunk 1 (Offset 0)
    const patch1Req = createStreamRequest(`${BASE_URL}${location}`, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': '0',
        'Upload-Checksum': `sha256 ${sha256Base64(chunk1)}`,
        ...authHeaders,
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(chunk1);
          controller.close();
        },
      }),
    });
    const patch1Res = await tusPatchHandler(patch1Req, { params: { id: [sessionId] } });
    expect(patch1Res.status).toBe(204);
    expect(patch1Res.headers.get('Upload-Offset')).toBe(String(chunk1.length));

    // 3. HEAD to verify intermediate offset
    const headReq1 = new NextRequest(`${BASE_URL}${location}`, {
      method: 'HEAD',
      headers: { 'Tus-Resumable': '1.0.0', ...authHeaders },
    });
    const headRes1 = await tusHeadHandler(headReq1, { params: { id: [sessionId] } });
    expect(headRes1.status).toBe(200);
    expect(headRes1.headers.get('Upload-Offset')).toBe(String(chunk1.length));
    expect(headRes1.headers.get('Upload-Length')).toBe(String(totalLength));
    expect(headRes1.headers.get('Cache-Control')).toBe('no-store');

    // 4. PATCH Chunk 2 (Offset chunk1.length)
    const patch2Req = createStreamRequest(`${BASE_URL}${location}`, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': String(chunk1.length),
        'Upload-Checksum': `sha256 ${sha256Base64(chunk2)}`,
        ...authHeaders,
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(chunk2);
          controller.close();
        },
      }),
    });
    const patch2Res = await tusPatchHandler(patch2Req, { params: { id: [sessionId] } });
    expect(patch2Res.status).toBe(204);
    const offsetAfterChunk2 = chunk1.length + chunk2.length;
    expect(patch2Res.headers.get('Upload-Offset')).toBe(String(offsetAfterChunk2));

    // 5. PATCH Chunk 3 (Offset offsetAfterChunk2) -> Completes Upload
    const patch3Req = createStreamRequest(`${BASE_URL}${location}`, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': String(offsetAfterChunk2),
        'Upload-Checksum': `sha256 ${sha256Base64(chunk3)}`,
        ...authHeaders,
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(chunk3);
          controller.close();
        },
      }),
    });
    const patch3Res = await tusPatchHandler(patch3Req, { params: { id: [sessionId] } });
    expect(patch3Res.status).toBe(204);
    expect(patch3Res.headers.get('Upload-Offset')).toBe(String(totalLength));

    const storageKey = patch3Res.headers.get('EasyConvert-Storage-Key');
    expect(storageKey).toBeDefined();
    expect(storageKey).toContain(userA.id);
    expect(storageKey).toContain('dataset-sample.bin');
    expect(patch3Res.headers.get('X-Storage-Key')).toBe(storageKey);

    // 6. Byte-for-byte SHA256 verification from storage
    const stored = await localFsStorage.getStream(storageKey!);
    expect(stored).not.toBeNull();
    const downloadedChunks: Buffer[] = [];
    for await (const piece of stored!.stream) {
      downloadedChunks.push(Buffer.isBuffer(piece) ? piece : Buffer.from(piece));
    }
    const downloadedBuffer = Buffer.concat(downloadedChunks);
    expect(downloadedBuffer).toHaveLength(totalLength);
    expect(sha256Hex(downloadedBuffer)).toBe(expectedSha256);
  });

  it('handles abort via DELETE and resume from offset after simulated interruption', async () => {
    const authHeaders = sessionHeaders(userA);
    const chunkA = Buffer.from('RESUMABLE_STREAM_CHUNK_PART_ONE_');
    const chunkB = Buffer.from('RESUMABLE_STREAM_CHUNK_PART_TWO_');
    const totalLength = chunkA.length + chunkB.length;

    const postReq = new NextRequest(`${BASE_URL}/api/v1/uploads`, {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(totalLength),
        'Upload-Metadata': serializeTusMetadata({ filename: 'interruptible.txt' }),
        ...authHeaders,
      },
    });
    const postRes = await tusPostHandler(postReq);
    expect(postRes.status).toBe(201);
    const location = postRes.headers.get('Location')!;
    const sessionId = location.split('/').pop()!;

    // Upload first part
    const patch1Req = createStreamRequest(`${BASE_URL}${location}`, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': '0',
        ...authHeaders,
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(chunkA);
          controller.close();
        },
      }),
    });
    const patch1Res = await tusPatchHandler(patch1Req, { params: { id: [sessionId] } });
    expect(patch1Res.status).toBe(204);
    expect(patch1Res.headers.get('Upload-Offset')).toBe(String(chunkA.length));

    // Client resumes after reading offset from HEAD
    const headReq = new NextRequest(`${BASE_URL}${location}`, {
      method: 'HEAD',
      headers: { 'Tus-Resumable': '1.0.0', ...authHeaders },
    });
    const headRes = await tusHeadHandler(headReq, { params: { id: [sessionId] } });
    const currentOffset = Number(headRes.headers.get('Upload-Offset'));
    expect(currentOffset).toBe(chunkA.length);

    // Abort session via DELETE
    const delReq = new NextRequest(`${BASE_URL}${location}`, {
      method: 'DELETE',
      headers: { 'Tus-Resumable': '1.0.0', ...authHeaders },
    });
    const delRes = await tusDeleteHandler(delReq, { params: { id: [sessionId] } });
    expect(delRes.status).toBe(204);

    // After termination, HEAD must return 404
    const headAfterDelete = await tusHeadHandler(headReq, { params: { id: [sessionId] } });
    expect(headAfterDelete.status).toBe(404);
  });

  it('rejects checksum mismatch with 460 and truncates disk chunk via ftruncateSync', async () => {
    const authHeaders = sessionHeaders(userA);
    const chunkGood = Buffer.from('VALID_PREFIX_DATA_CHUNK_');
    const chunkCorrupt = Buffer.from('DATA_WITH_INVALID_HASH_');
    const totalLength = chunkGood.length + chunkCorrupt.length;

    const postReq = new NextRequest(`${BASE_URL}/api/v1/uploads`, {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(totalLength),
        'Upload-Metadata': serializeTusMetadata({ filename: 'checksum-test.txt' }),
        ...authHeaders,
      },
    });
    const postRes = await tusPostHandler(postReq);
    expect(postRes.status).toBe(201);
    const location = postRes.headers.get('Location')!;
    const sessionId = location.split('/').pop()!;

    // Upload first valid chunk
    const patch1Req = createStreamRequest(`${BASE_URL}${location}`, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': '0',
        ...authHeaders,
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(chunkGood);
          controller.close();
        },
      }),
    });
    await tusPatchHandler(patch1Req, { params: { id: [sessionId] } });

    // Send second chunk with mismatched checksum
    const badHash = sha256Base64(Buffer.from('mismatched-content-hash'));
    const patchBadReq = createStreamRequest(`${BASE_URL}${location}`, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': String(chunkGood.length),
        'Upload-Checksum': `sha256 ${badHash}`,
        ...authHeaders,
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(chunkCorrupt);
          controller.close();
        },
      }),
    });
    const patchBadRes = await tusPatchHandler(patchBadReq, { params: { id: [sessionId] } });
    expect(patchBadRes.status).toBe(460);

    // Verify disk truncation rollback: offset remains at chunkGood.length
    const headReq = new NextRequest(`${BASE_URL}${location}`, {
      method: 'HEAD',
      headers: { 'Tus-Resumable': '1.0.0', ...authHeaders },
    });
    const headRes = await tusHeadHandler(headReq, { params: { id: [sessionId] } });
    expect(headRes.headers.get('Upload-Offset')).toBe(String(chunkGood.length));

    // Send second chunk with valid checksum, which must succeed
    const goodHash = sha256Base64(chunkCorrupt);
    const patchGoodReq = createStreamRequest(`${BASE_URL}${location}`, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': String(chunkGood.length),
        'Upload-Checksum': `sha256 ${goodHash}`,
        ...authHeaders,
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(chunkCorrupt);
          controller.close();
        },
      }),
    });
    const patchGoodRes = await tusPatchHandler(patchGoodReq, { params: { id: [sessionId] } });
    expect(patchGoodRes.status).toBe(204);
    expect(patchGoodRes.headers.get('Upload-Offset')).toBe(String(totalLength));
  });

  it('rejects wrong offset with 409 Conflict indicating expected offset', async () => {
    const authHeaders = sessionHeaders(userA);
    const chunk = Buffer.from('CHUNK_DATA_FOR_OFFSET_TEST_');

    const postReq = new NextRequest(`${BASE_URL}/api/v1/uploads`, {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': '1000',
        'Upload-Metadata': serializeTusMetadata({ filename: 'offset-test.bin' }),
        ...authHeaders,
      },
    });
    const postRes = await tusPostHandler(postReq);
    const location = postRes.headers.get('Location')!;
    const sessionId = location.split('/').pop()!;

    // Send at offset 100 instead of 0
    const wrongOffsetReq = createStreamRequest(`${BASE_URL}${location}`, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': '100',
        ...authHeaders,
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      }),
    });
    const wrongOffsetRes = await tusPatchHandler(wrongOffsetReq, { params: { id: [sessionId] } });
    expect(wrongOffsetRes.status).toBe(409);
    expect(wrongOffsetRes.headers.get('Upload-Offset')).toBe('0');
  });

  it('enforces unauthorized access boundaries fail-closed (401 and 404)', async () => {
    // 1. Unauthenticated POST -> 401
    const unauthPost = new NextRequest(`${BASE_URL}/api/v1/uploads`, {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': '1000',
      },
    });
    const unauthPostRes = await tusPostHandler(unauthPost);
    expect(unauthPostRes.status).toBe(401);

    // 2. User A creates session
    const authAHeaders = sessionHeaders(userA);
    const postReq = new NextRequest(`${BASE_URL}/api/v1/uploads`, {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': '1000',
        'Upload-Metadata': serializeTusMetadata({ filename: 'private.bin' }),
        ...authAHeaders,
      },
    });
    const postRes = await tusPostHandler(postReq);
    const location = postRes.headers.get('Location')!;
    const sessionId = location.split('/').pop()!;

    // 3. User B attempts to access User A's session -> 404 Not Found (resource isolation)
    const authBHeaders = sessionHeaders(userB);

    const userBHead = new NextRequest(`${BASE_URL}${location}`, {
      method: 'HEAD',
      headers: { 'Tus-Resumable': '1.0.0', ...authBHeaders },
    });
    const userBHeadRes = await tusHeadHandler(userBHead, { params: { id: [sessionId] } });
    expect(userBHeadRes.status).toBe(404);

    const userBPatch = createStreamRequest(`${BASE_URL}${location}`, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': '0',
        ...authBHeaders,
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('attacker payload'));
          controller.close();
        },
      }),
    });
    const userBPatchRes = await tusPatchHandler(userBPatch, { params: { id: [sessionId] } });
    expect(userBPatchRes.status).toBe(404);

    const userBDelete = new NextRequest(`${BASE_URL}${location}`, {
      method: 'DELETE',
      headers: { 'Tus-Resumable': '1.0.0', ...authBHeaders },
    });
    const userBDeleteRes = await tusDeleteHandler(userBDelete, { params: { id: [sessionId] } });
    expect(userBDeleteRes.status).toBe(404);
  });

  it('supports creation-with-upload extension in single roundtrip', async () => {
    const authHeaders = sessionHeaders(userA);
    const payload = Buffer.from('SINGLE_REQUEST_CREATION_WITH_UPLOAD_PAYLOAD_DATA');
    const payloadSha256 = sha256Hex(payload);

    const postReq = createStreamRequest(`${BASE_URL}/api/v1/uploads`, {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(payload.length),
        'Upload-Metadata': serializeTusMetadata({ filename: 'single-shot.txt', filetype: 'text/plain' }),
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Checksum': `sha256 ${sha256Base64(payload)}`,
        ...authHeaders,
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(payload);
          controller.close();
        },
      }),
    });

    const postRes = await tusPostHandler(postReq);
    expect(postRes.status).toBe(201);
    expect(postRes.headers.get('Upload-Offset')).toBe(String(payload.length));
    const storageKey = postRes.headers.get('EasyConvert-Storage-Key');
    expect(storageKey).toMatch(new RegExp(`^conversions/${userA.id}/.+_single-shot\\.txt$`));

    // Verify stored content
    const stored = await localFsStorage.getStream(storageKey!);
    expect(stored).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const chunk of stored!.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(sha256Hex(Buffer.concat(chunks))).toBe(payloadSha256);
  });

  it('verifies magic bytes on completion and rejects spoofed files fail-closed', async () => {
    const authHeaders = sessionHeaders(userA);
    // Declared as PNG, but content is invalid arbitrary text (spoofed)
    const spoofedContent = Buffer.from('THIS IS NOT A VALID PNG IMAGE HEADER AT ALL 12345');

    const postReq = new NextRequest(`${BASE_URL}/api/v1/uploads`, {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(spoofedContent.length),
        'Upload-Metadata': serializeTusMetadata({ filename: 'spoofed.png', filetype: 'image/png' }),
        ...authHeaders,
      },
    });
    const postRes = await tusPostHandler(postReq);
    expect(postRes.status).toBe(201);
    const location = postRes.headers.get('Location')!;
    const sessionId = location.split('/').pop()!;

    // Completing with spoofed PNG payload must fail magic byte check
    const patchReq = createStreamRequest(`${BASE_URL}${location}`, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': '0',
        ...authHeaders,
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(spoofedContent);
          controller.close();
        },
      }),
    });

    const patchRes = await tusPatchHandler(patchReq, { params: { id: [sessionId] } });
    expect(patchRes.status).toBe(400);
    const problem = await patchRes.json();
    expect(problem.detail || problem.message || '').toContain('spoofing rejected');
  });

  it('serializes concurrent PATCH requests to the same session and rejects conflicting offsets with 409 Conflict without data corruption', async () => {
    const authHeaders = sessionHeaders(userA);
    const chunkA = Buffer.alloc(1024, 0x41); // 'A'
    const chunkB = Buffer.alloc(1024, 0x42); // 'B'
    const totalLength = 2048;

    const postReq = new NextRequest(`${BASE_URL}/api/v1/uploads`, {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(totalLength),
        'Upload-Metadata': serializeTusMetadata({ filename: 'concurrency-race.bin' }),
        ...authHeaders,
      },
    });
    const postRes = await tusPostHandler(postReq);
    expect(postRes.status).toBe(201);
    const location = postRes.headers.get('Location')!;
    const sessionId = location.split('/').pop()!;

    // Send two concurrent PATCH requests with identical offset 0
    const req1 = createStreamRequest(`${BASE_URL}${location}`, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': '0',
        ...authHeaders,
      },
      body: new ReadableStream({
        async start(controller) {
          controller.enqueue(chunkA.subarray(0, 512));
          await new Promise((r) => setTimeout(r, 20));
          controller.enqueue(chunkA.subarray(512));
          controller.close();
        },
      }),
    });

    const req2 = createStreamRequest(`${BASE_URL}${location}`, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': '0',
        ...authHeaders,
      },
      body: new ReadableStream({
        async start(controller) {
          controller.enqueue(chunkB.subarray(0, 512));
          await new Promise((r) => setTimeout(r, 20));
          controller.enqueue(chunkB.subarray(512));
          controller.close();
        },
      }),
    });

    const [res1, res2] = await Promise.all([
      tusPatchHandler(req1, { params: { id: [sessionId] } }),
      tusPatchHandler(req2, { params: { id: [sessionId] } }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    // One must succeed with 204, and the other must be rejected with 409 Conflict
    expect(statuses).toEqual([204, 409]);

    const conflictRes = res1.status === 409 ? res1 : res2;
    expect(conflictRes.headers.get('Upload-Offset')).toBe('1024');

    // Confirm that disk file is exactly 1024 bytes (NOT interleaved or corrupted 2048 bytes)
    const headReq = new NextRequest(`${BASE_URL}${location}`, {
      method: 'HEAD',
      headers: { 'Tus-Resumable': '1.0.0', ...authHeaders },
    });
    const headRes = await tusHeadHandler(headReq, { params: { id: [sessionId] } });
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get('Upload-Offset')).toBe('1024');
  });

  it('enforces Tus-Resumable: 1.0.0 precondition check on HEAD, PATCH, and DELETE with 412 Precondition Failed', async () => {
    const authHeaders = sessionHeaders(userA);

    const postReq = new NextRequest(`${BASE_URL}/api/v1/uploads`, {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': '1024',
        'Upload-Metadata': serializeTusMetadata({ filename: 'precondition.bin' }),
        ...authHeaders,
      },
    });
    const postRes = await tusPostHandler(postReq);
    expect(postRes.status).toBe(201);
    const location = postRes.headers.get('Location')!;
    const sessionId = location.split('/').pop()!;

    // 1. HEAD with invalid version 2.0.0
    const headBad = new NextRequest(`${BASE_URL}${location}`, {
      method: 'HEAD',
      headers: { 'Tus-Resumable': '2.0.0', ...authHeaders },
    });
    const headBadRes = await tusHeadHandler(headBad, { params: { id: [sessionId] } });
    expect(headBadRes.status).toBe(412);
    expect(headBadRes.headers.get('Tus-Version')).toBe('1.0.0');

    // 2. PATCH with invalid version 0.2.1
    const patchBad = createStreamRequest(`${BASE_URL}${location}`, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '0.2.1',
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': '0',
        ...authHeaders,
      },
      body: new ReadableStream({
        start(c) {
          c.enqueue(Buffer.from('test'));
          c.close();
        },
      }),
    });
    const patchBadRes = await tusPatchHandler(patchBad, { params: { id: [sessionId] } });
    expect(patchBadRes.status).toBe(412);
    expect(patchBadRes.headers.get('Tus-Version')).toBe('1.0.0');

    // 3. DELETE with invalid version 3.0.0
    const deleteBad = new NextRequest(`${BASE_URL}${location}`, {
      method: 'DELETE',
      headers: { 'Tus-Resumable': '3.0.0', ...authHeaders },
    });
    const deleteBadRes = await tusDeleteHandler(deleteBad, { params: { id: [sessionId] } });
    expect(deleteBadRes.status).toBe(412);
    expect(deleteBadRes.headers.get('Tus-Version')).toBe('1.0.0');
  });

  it('rejects malformed Upload-Checksum headers and unsupported algorithms fail-closed with 400 Bad Request', async () => {
    const authHeaders = sessionHeaders(userA);
    const chunk = Buffer.from('TEST_PAYLOAD');

    const postReq = new NextRequest(`${BASE_URL}/api/v1/uploads`, {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(chunk.length),
        'Upload-Metadata': serializeTusMetadata({ filename: 'checksum-error.bin' }),
        ...authHeaders,
      },
    });
    const postRes = await tusPostHandler(postReq);
    expect(postRes.status).toBe(201);
    const location = postRes.headers.get('Location')!;
    const sessionId = location.split('/').pop()!;

    // 1. Malformed header (missing space separator) -> 400 Bad Request
    const badFormatReq = createStreamRequest(`${BASE_URL}${location}`, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': '0',
        'Upload-Checksum': 'invalid-no-space-separator',
        ...authHeaders,
      },
      body: new ReadableStream({
        start(c) {
          c.enqueue(chunk);
          c.close();
        },
      }),
    });
    const badFormatRes = await tusPatchHandler(badFormatReq, { params: { id: [sessionId] } });
    expect(badFormatRes.status).toBe(400);
    expect(badFormatRes.headers.get('Tus-Resumable')).toBe('1.0.0');

    // 2. Unsupported algorithm (e.g. md5) -> 400 Bad Request
    const md5Digest = crypto.createHash('md5').update(chunk).digest('base64');
    const unsupportedAlgoReq = createStreamRequest(`${BASE_URL}${location}`, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': '0',
        'Upload-Checksum': `md5 ${md5Digest}`,
        ...authHeaders,
      },
      body: new ReadableStream({
        start(c) {
          c.enqueue(chunk);
          c.close();
        },
      }),
    });
    const unsupportedAlgoRes = await tusPatchHandler(unsupportedAlgoReq, { params: { id: [sessionId] } });
    expect(unsupportedAlgoRes.status).toBe(400);
    const errPayload = await unsupportedAlgoRes.json();
    expect(errPayload.detail).toContain('Unsupported checksum algorithm "md5"');
  });

  it('aborts and truncates streaming immediately when uploaded bytes exceed declared Upload-Length mid-stream', async () => {
    const authHeaders = sessionHeaders(userA);
    const declaredLimit = 256;
    const oversizedPayload = crypto.randomBytes(1024); // 4x over declared length

    const postReq = new NextRequest(`${BASE_URL}/api/v1/uploads`, {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(declaredLimit),
        'Upload-Metadata': serializeTusMetadata({ filename: 'stream-overflow.bin' }),
        ...authHeaders,
      },
    });
    const postRes = await tusPostHandler(postReq);
    expect(postRes.status).toBe(201);
    const location = postRes.headers.get('Location')!;
    const sessionId = location.split('/').pop()!;

    // Stream oversized payload into PATCH
    const patchReq = createStreamRequest(`${BASE_URL}${location}`, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': '0',
        ...authHeaders,
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(oversizedPayload);
          controller.close();
        },
      }),
    });

    const patchRes = await tusPatchHandler(patchReq, { params: { id: [sessionId] } });
    expect(patchRes.status).toBe(400);
    const errBody = await patchRes.json();
    expect(errBody.detail).toContain('exceed declared Upload-Length');

    // Confirm session offset was rolled back to 0
    const headReq = new NextRequest(`${BASE_URL}${location}`, {
      method: 'HEAD',
      headers: { 'Tus-Resumable': '1.0.0', ...authHeaders },
    });
    const headRes = await tusHeadHandler(headReq, { params: { id: [sessionId] } });
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get('Upload-Offset')).toBe('0');
  });

  it('validates magic bytes for extensionless uploads with valid MIME type metadata', async () => {
    const authHeaders = sessionHeaders(userA);
    // Real minimal valid PNG file bytes
    const validPng = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR header
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
      0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
      0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
      0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d,
      0xb0, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
      0x44, 0xae, 0x42, 0x60, 0x82,
    ]);

    // Filename 'avatar-image' has no extension, but filetype is 'image/png'
    const postReq = new NextRequest(`${BASE_URL}/api/v1/uploads`, {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(validPng.length),
        'Upload-Metadata': serializeTusMetadata({
          filename: 'avatar-image',
          filetype: 'image/png',
        }),
        ...authHeaders,
      },
    });
    const postRes = await tusPostHandler(postReq);
    expect(postRes.status).toBe(201);
    const location = postRes.headers.get('Location')!;
    const sessionId = location.split('/').pop()!;

    const patchReq = createStreamRequest(`${BASE_URL}${location}`, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': '0',
        ...authHeaders,
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(validPng);
          controller.close();
        },
      }),
    });

    const patchRes = await tusPatchHandler(patchReq, { params: { id: [sessionId] } });
    expect(patchRes.status).toBe(204);
    expect(patchRes.headers.get('Upload-Offset')).toBe(String(validPng.length));
    const finalStorageKey = patchRes.headers.get('EasyConvert-Storage-Key');
    expect(finalStorageKey).toBe(`conversions/${userA.id}/${sessionId}_avatar-image`);
  });

  describe('SessionLockManager', () => {
    it('serializes operations and cleans up lock map entries without leaking memory', async () => {
      const lockManager = new SessionLockManager();
      const executionOrder: number[] = [];

      const p1 = lockManager.runExclusive('session-leak-check', async () => {
        await new Promise((r) => setTimeout(r, 20));
        executionOrder.push(1);
        return 'first';
      });

      const p2 = lockManager.runExclusive('session-leak-check', async () => {
        executionOrder.push(2);
        return 'second';
      });

      expect(lockManager.activeLockCount).toBe(1);

      const [res1, res2] = await Promise.all([p1, p2]);
      expect(res1).toBe('first');
      expect(res2).toBe('second');
      expect(executionOrder).toEqual([1, 2]);

      // Lock entry must be deleted after all chained tasks finish
      expect(lockManager.activeLockCount).toBe(0);
    });

    it('cleans up lock map entries even when an exclusive task rejects', async () => {
      const lockManager = new SessionLockManager();

      await expect(
        lockManager.runExclusive('session-err-check', async () => {
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');

      expect(lockManager.activeLockCount).toBe(0);
    });
  });
});
