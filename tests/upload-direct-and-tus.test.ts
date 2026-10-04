import crypto from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as uploadsHandler } from '../src/app/api/v1/uploads/route';
import {
  OPTIONS as tusOptionsHandler,
  POST as tusPostHandler,
  HEAD as tusHeadHandler,
  PATCH as tusPatchHandler,
  DELETE as tusDeleteHandler,
} from '../src/app/api/v1/uploads/tus/[[...id]]/route';
import { POST as jobsPostHandler } from '../src/app/api/v1/jobs/route';
import { localFsStorage, storageProvider } from '../src/lib/storage';
import { tusEngine, parseTusMetadata, serializeTusMetadata } from '../src/lib/storage/tus-engine';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import type { User } from '../src/lib/auth/types';

const BASE_URL = 'http://localhost:3000';

function uniqueSuffix(): string {
  return `${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

async function createUser(label: string): Promise<User> {
  const email = `${label}_${uniqueSuffix()}@upload-test.local`;
  return userStore.sanitizeUser(await userStore.createUser({ email, name: label, tier: 'pro' }));
}

function sessionHeaders(user: User): Record<string, string> {
  return { Cookie: `easyconvert_session=${createSessionToken(user)}` };
}

async function apiKeyHeaders(user: User, scopes: string[] = ['convert:write']): Promise<Record<string, string>> {
  const key = await redisKeyStore.generateApiKey(user.id, `${user.name} key`, { scopes });
  return { Authorization: `Bearer ${key.secretKey}` };
}

function createStreamRequest(url: string, init: any): NextRequest {
  return new NextRequest(url, { ...init, duplex: 'half' } as any);
}

describe('Direct Multipart Upload API (/api/v1/uploads)', () => {
  let userA: User;

  beforeEach(async () => {
    userA = await createUser('uploader_a');
  });

  it('enforces authentication and required convert:write scope', async () => {
    // 1. Unauthenticated request
    const unauthReq = new NextRequest(`${BASE_URL}/api/v1/uploads?action=initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'test.mp4', totalSize: 10 * 1024 * 1024 }),
    });
    const unauthRes = await uploadsHandler(unauthReq);
    expect(unauthRes.status).toBe(401);

    // 2. Insufficient scope (convert:read only)
    const readHeaders = await apiKeyHeaders(userA, ['convert:read']);
    const readReq = new NextRequest(`${BASE_URL}/api/v1/uploads?action=initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...readHeaders },
      body: JSON.stringify({ filename: 'test.mp4', totalSize: 10 * 1024 * 1024 }),
    });
    const readRes = await uploadsHandler(readReq);
    expect(readRes.status).toBe(403);
  });

  it('validates initiate parameters and enforces size boundaries', async () => {
    const authHeaders = sessionHeaders(userA);

    // Missing filename
    const noFilenameReq = new NextRequest(`${BASE_URL}/api/v1/uploads?action=initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ totalSize: 1024 }),
    });
    const noFilenameRes = await uploadsHandler(noFilenameReq);
    expect(noFilenameRes.status).toBe(400);

    // Missing totalSize
    const noSizeReq = new NextRequest(`${BASE_URL}/api/v1/uploads?action=initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ filename: 'video.mp4' }),
    });
    const noSizeRes = await uploadsHandler(noSizeReq);
    expect(noSizeRes.status).toBe(400);

    // Exceeding 10 GiB ceiling
    const oversizeReq = new NextRequest(`${BASE_URL}/api/v1/uploads?action=initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ filename: 'huge.mp4', totalSize: 11 * 1024 * 1024 * 1024 }),
    });
    const oversizeRes = await uploadsHandler(oversizeReq);
    expect(oversizeRes.status).toBe(413);
  });

  it('completes direct multipart upload lifecycle: initiate -> upload parts -> complete -> verify content', async () => {
    const authHeaders = sessionHeaders(userA);
    const chunk1 = Buffer.from('FIRST_PART_DATA_CHUNKS_OF_STREAM_');
    const chunk2 = Buffer.from('SECOND_PART_DATA_CHUNKS_OF_STREAM_FINISH');
    const totalSize = chunk1.length + chunk2.length;

    // 1. Initiate
    const initReq = new NextRequest(`${BASE_URL}/api/v1/uploads?action=initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        filename: 'direct-upload-doc.txt',
        mimeType: 'text/plain',
        totalSize,
        partSize: chunk1.length,
      }),
    });
    const initRes = await uploadsHandler(initReq);
    expect(initRes.status).toBe(200);
    const initJson = await initRes.json();
    expect(initJson.success).toBe(true);
    expect(initJson.uploadId).toBeDefined();
    expect(initJson.key).toContain('direct-upload-doc.txt');
    expect(initJson.presignedUrls.length).toBeGreaterThan(0);

    const uploadId = initJson.uploadId;
    const storageKey = initJson.key;

    // 2. Upload part 1
    const part1Req = createStreamRequest(
      `${BASE_URL}/api/v1/uploads?action=part&uploadId=${uploadId}&partNumber=1`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', ...authHeaders },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(chunk1);
            controller.close();
          },
        }),
      }
    );
    const part1Res = await uploadsHandler(part1Req);
    expect(part1Res.status).toBe(200);
    const part1Json = await part1Res.json();
    expect(part1Json.success).toBe(true);
    expect(part1Json.part.partNumber).toBe(1);
    expect(part1Json.part.size).toBe(chunk1.length);
    const part1Etag = part1Json.part.etag;

    // 3. Upload part 2
    const part2Req = createStreamRequest(
      `${BASE_URL}/api/v1/uploads?action=part&uploadId=${uploadId}&partNumber=2`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', ...authHeaders },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(chunk2);
            controller.close();
          },
        }),
      }
    );
    const part2Res = await uploadsHandler(part2Req);
    expect(part2Res.status).toBe(200);
    const part2Json = await part2Res.json();
    expect(part2Json.success).toBe(true);
    expect(part2Json.part.partNumber).toBe(2);
    expect(part2Json.part.size).toBe(chunk2.length);
    const part2Etag = part2Json.part.etag;

    // 4. Complete multipart
    const completeReq = new NextRequest(`${BASE_URL}/api/v1/uploads?action=complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        uploadId,
        key: storageKey,
        parts: [
          { partNumber: 1, etag: part1Etag },
          { partNumber: 2, etag: part2Etag },
        ],
        expectedSize: totalSize,
      }),
    });
    const completeRes = await uploadsHandler(completeReq);
    expect(completeRes.status).toBe(200);
    const completeJson = await completeRes.json();
    expect(completeJson.success).toBe(true);
    expect(completeJson.key).toBe(storageKey);
    expect(completeJson.size).toBe(totalSize);

    // 5. Verify byte content in localFsStorage
    const storedStream = await localFsStorage.getStream(storageKey);
    const streamChunks: Buffer[] = [];
    for await (const piece of storedStream.stream) {
      streamChunks.push(Buffer.isBuffer(piece) ? piece : Buffer.from(piece));
    }
    const fullBuffer = Buffer.concat(streamChunks);
    expect(fullBuffer).toHaveLength(totalSize);
    expect(fullBuffer.toString('utf-8')).toBe(
      'FIRST_PART_DATA_CHUNKS_OF_STREAM_SECOND_PART_DATA_CHUNKS_OF_STREAM_FINISH'
    );
  });

  it('supports aborting multipart upload and cleans up temporary parts', async () => {
    const authHeaders = sessionHeaders(userA);
    const initReq = new NextRequest(`${BASE_URL}/api/v1/uploads?action=initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        filename: 'aborted-file.bin',
        totalSize: 1024 * 1024,
      }),
    });
    const initRes = await uploadsHandler(initReq);
    const initJson = await initRes.json();
    const { uploadId, key } = initJson;

    const abortReq = new NextRequest(`${BASE_URL}/api/v1/uploads?action=abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ uploadId, key }),
    });
    const abortRes = await uploadsHandler(abortReq);
    expect(abortRes.status).toBe(200);
    const abortJson = await abortRes.json();
    expect(abortJson.success).toBe(true);
    expect(abortJson.aborted).toBe(true);
  });
});

describe('TUS 1.0 Resumable Upload Protocol (/api/v1/uploads/tus)', () => {
  let userA: User;
  let userB: User;

  beforeEach(async () => {
    userA = await createUser('tus_user_a');
    userB = await createUser('tus_user_b');
  });

  it('responds to OPTIONS with complete TUS 1.0 extensions and capabilities', async () => {
    const res = await tusOptionsHandler();
    expect(res.status).toBe(204);
    expect(res.headers.get('Tus-Resumable')).toBe('1.0.0');
    expect(res.headers.get('Tus-Version')).toBe('1.0.0');
    expect(res.headers.get('Tus-Extension')).toContain('creation');
    expect(res.headers.get('Tus-Extension')).toContain('termination');
    expect(res.headers.get('Tus-Extension')).toContain('checksum');
    expect(res.headers.get('Tus-Extension')).toContain('expiration');
    expect(res.headers.get('Tus-Checksum-Algorithm')).toContain('sha256');
    expect(res.headers.get('Tus-Max-Size')).toBe(String(5 * 1024 * 1024 * 1024));
  });

  it('parses and serializes TUS metadata headers correctly', () => {
    const metaObj = {
      filename: 'document.pdf',
      filetype: 'application/pdf',
      customKey: 'customValue123',
    };
    const serialized = serializeTusMetadata(metaObj);
    const parsed = parseTusMetadata(serialized);
    expect(parsed.filename).toBe('document.pdf');
    expect(parsed.filetype).toBe('application/pdf');
    expect(parsed.customKey).toBe('customValue123');
  });

  it('enforces authentication on session creation (POST)', async () => {
    const unauthReq = new NextRequest(`${BASE_URL}/api/v1/uploads/tus`, {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': '1048576',
      },
    });
    const res = await tusPostHandler(unauthReq);
    expect(res.status).toBe(401);
  });

  it('rejects unsupported TUS version with 412 Precondition Failed', async () => {
    const authHeaders = sessionHeaders(userA);
    const badVersionReq = new NextRequest(`${BASE_URL}/api/v1/uploads/tus`, {
      method: 'POST',
      headers: {
        'Tus-Resumable': '0.2.1',
        'Upload-Length': '1048576',
        ...authHeaders,
      },
    });
    const res = await tusPostHandler(badVersionReq);
    expect(res.status).toBe(412);
  });

  it('validates Upload-Length boundaries', async () => {
    const authHeaders = sessionHeaders(userA);

    // Missing Upload-Length
    const noLengthReq = new NextRequest(`${BASE_URL}/api/v1/uploads/tus`, {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        ...authHeaders,
      },
    });
    const noLengthRes = await tusPostHandler(noLengthReq);
    expect(noLengthRes.status).toBe(400);

    // Exceeding 5 GiB limit
    const hugeReq = new NextRequest(`${BASE_URL}/api/v1/uploads/tus`, {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(6 * 1024 * 1024 * 1024),
        ...authHeaders,
      },
    });
    const hugeRes = await tusPostHandler(hugeReq);
    expect(hugeRes.status).toBe(413);
  });

  it('executes full resumable chunked upload with checksum verification and termination', async () => {
    const authHeaders = sessionHeaders(userA);
    const chunkA = Buffer.from('CHUNK_A_OF_RESUMABLE_TUS_STREAM_');
    const chunkB = Buffer.from('CHUNK_B_OF_RESUMABLE_TUS_STREAM_FINISHED');
    const fullPayload = Buffer.concat([chunkA, chunkB]);
    const totalLength = fullPayload.length;

    const metadataHeader = serializeTusMetadata({
      filename: 'tus-sample.txt',
      filetype: 'text/plain',
    });

    // 1. POST creation
    const postReq = new NextRequest(`${BASE_URL}/api/v1/uploads/tus`, {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': String(totalLength),
        'Upload-Metadata': metadataHeader,
        ...authHeaders,
      },
    });
    const postRes = await tusPostHandler(postReq);
    expect(postRes.status).toBe(201);
    const location = postRes.headers.get('Location');
    expect(location).toBeDefined();
    const sessionId = location!.split('/').pop()!;
    expect(sessionId).toMatch(/^tus_\d+_[a-f0-9]+$/);

    // 2. HEAD offset check before upload
    const headReq1 = new NextRequest(`${BASE_URL}${location}`, {
      method: 'HEAD',
      headers: { 'Tus-Resumable': '1.0.0', ...authHeaders },
    });
    const headRes1 = await tusHeadHandler(headReq1, { params: { id: [sessionId] } });
    expect(headRes1.status).toBe(200);
    expect(headRes1.headers.get('Upload-Offset')).toBe('0');
    expect(headRes1.headers.get('Upload-Length')).toBe(String(totalLength));

    // 3. PATCH chunk A with valid sha256 checksum
    const chunkASha256 = crypto.createHash('sha256').update(chunkA).digest('base64');
    const patchReqA = createStreamRequest(`${BASE_URL}${location}`, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': '0',
        'Upload-Checksum': `sha256 ${chunkASha256}`,
        ...authHeaders,
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(chunkA);
          controller.close();
        },
      }),
    });
    const patchResA = await tusPatchHandler(patchReqA, { params: { id: [sessionId] } });
    expect(patchResA.status).toBe(204);
    expect(patchResA.headers.get('Upload-Offset')).toBe(String(chunkA.length));

    // 4. Verify offset updated via HEAD
    const headReq2 = new NextRequest(`${BASE_URL}${location}`, {
      method: 'HEAD',
      headers: { 'Tus-Resumable': '1.0.0', ...authHeaders },
    });
    const headRes2 = await tusHeadHandler(headReq2, { params: { id: [sessionId] } });
    expect(headRes2.status).toBe(200);
    expect(headRes2.headers.get('Upload-Offset')).toBe(String(chunkA.length));

    // 5. Test offset mismatch rejection (409 Conflict)
    const badOffsetReq = createStreamRequest(`${BASE_URL}${location}`, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': '0', // Client incorrectly sends offset 0 instead of chunkA.length
        ...authHeaders,
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(chunkB);
          controller.close();
        },
      }),
    });
    const badOffsetRes = await tusPatchHandler(badOffsetReq, { params: { id: [sessionId] } });
    expect(badOffsetRes.status).toBe(409);
    expect(badOffsetRes.headers.get('Upload-Offset')).toBe(String(chunkA.length));

    // 6. Test checksum mismatch rejection (460 Checksum Mismatch) with rollback
    const fakeChecksum = crypto.createHash('sha256').update(Buffer.from('corrupt')).digest('base64');
    const badChecksumReq = createStreamRequest(`${BASE_URL}${location}`, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': String(chunkA.length),
        'Upload-Checksum': `sha256 ${fakeChecksum}`,
        ...authHeaders,
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(chunkB);
          controller.close();
        },
      }),
    });
    const badChecksumRes = await tusPatchHandler(badChecksumReq, { params: { id: [sessionId] } });
    expect(badChecksumRes.status).toBe(460);

    // Verify offset remained at chunkA.length (chunk was rolled back)
    const headRes3 = await tusHeadHandler(headReq2, { params: { id: [sessionId] } });
    expect(headRes3.headers.get('Upload-Offset')).toBe(String(chunkA.length));

    // 7. Resume & finish upload with valid chunk B and checksum
    const chunkBSha256 = crypto.createHash('sha256').update(chunkB).digest('base64');
    const patchReqB = createStreamRequest(`${BASE_URL}${location}`, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': String(chunkA.length),
        'Upload-Checksum': `sha256 ${chunkBSha256}`,
        ...authHeaders,
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(chunkB);
          controller.close();
        },
      }),
    });
    const patchResB = await tusPatchHandler(patchReqB, { params: { id: [sessionId] } });
    expect(patchResB.status).toBe(204);
    expect(patchResB.headers.get('Upload-Offset')).toBe(String(totalLength));
    const storageKey = patchResB.headers.get('X-Storage-Key');
    expect(storageKey).toBeDefined();
    expect(storageKey).toContain('tus-sample.txt');

    // 8. Verify completed storage content
    const storedStream = await localFsStorage.getStream(storageKey!);
    const chunks: Buffer[] = [];
    for await (const chunk of storedStream.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const storedBuf = Buffer.concat(chunks);
    expect(storedBuf.toString('utf-8')).toBe(fullPayload.toString('utf-8'));

    // 9. Terminate session via DELETE
    const delReq = new NextRequest(`${BASE_URL}${location}`, {
      method: 'DELETE',
      headers: { 'Tus-Resumable': '1.0.0', ...authHeaders },
    });
    const delRes = await tusDeleteHandler(delReq, { params: { id: [sessionId] } });
    expect(delRes.status).toBe(204);

    // Subsequent HEAD must return 404
    const headResAfterDel = await tusHeadHandler(headReq1, { params: { id: [sessionId] } });
    expect(headResAfterDel.status).toBe(404);
  });
});

describe('Job Ingestion Integration (POST /api/v1/jobs)', () => {
  let userA: User;
  let userB: User;

  beforeEach(async () => {
    userA = await createUser('job_user_a');
    userB = await createUser('job_user_b');
  });

  it('rejects inline base64 payloads exceeding 32 MiB with 413 Payload Too Large', async () => {
    const authHeaders = sessionHeaders(userA);
    // 33 MiB base64 payload
    const oversizeBytes = 33 * 1024 * 1024;
    const oversizeBase64 = 'A'.repeat(Math.ceil((oversizeBytes * 4) / 3));

    const req = new NextRequest(`${BASE_URL}/api/v1/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        originalFilename: 'huge.txt',
        targetFormat: 'pdf',
        inputBufferBase64: oversizeBase64,
      }),
    });
    const res = await jobsPostHandler(req);
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.detail).toContain('32 MiB');
  });

  it('accepts job referencing completed TUS uploadId and resolves storageKey seamlessly', async () => {
    const authHeaders = sessionHeaders(userA);
    const sampleCsv = 'colA,colB\nval1,val2\nval3,val4\n';
    const csvBuf = Buffer.from(sampleCsv, 'utf-8');

    // 1. Create and complete TUS session
    const tusSession = await tusEngine.createSession({
      uploadLength: csvBuf.length,
      metadataHeader: serializeTusMetadata({ filename: 'data.csv', filetype: 'text/csv' }),
      ownerUserId: userA.id,
    });

    await tusEngine.appendChunk(
      tusSession.id,
      0,
      new ReadableStream({
        start(controller) {
          controller.enqueue(csvBuf);
          controller.close();
        },
      })
    );

    // 2. Submit job referencing uploadId
    const jobReq = new NextRequest(`${BASE_URL}/api/v1/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        uploadId: tusSession.id,
        targetFormat: 'json',
      }),
    });
    const jobRes = await jobsPostHandler(jobReq);
    expect(jobRes.status).toBe(202);
    const jobJson = await jobRes.json();
    expect(jobJson.success).toBe(true);
    expect(jobJson.jobId).toBeDefined();
    expect(jobJson.sourceFormat).toBe('csv');
    expect(jobJson.targetFormat).toBe('json');
    expect(jobJson.originalFilename).toBe('data.csv');
  });

  it('rejects job referencing uncompleted TUS uploadId with 400', async () => {
    const authHeaders = sessionHeaders(userA);

    // Incomplete TUS session (declared 1000 bytes, 0 uploaded)
    const incompleteSession = await tusEngine.createSession({
      uploadLength: 1000,
      metadataHeader: serializeTusMetadata({ filename: 'pending.csv', filetype: 'text/csv' }),
      ownerUserId: userA.id,
    });

    const jobReq = new NextRequest(`${BASE_URL}/api/v1/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        uploadId: incompleteSession.id,
        targetFormat: 'json',
      }),
    });
    const jobRes = await jobsPostHandler(jobReq);
    expect(jobRes.status).toBe(400);
    const json = await jobRes.json();
    expect(json.detail).toContain('not completed yet');
  });

  it('enforces tenant boundary on TUS uploadId: userB cannot use userA uploadId (returns 404)', async () => {
    const userBHeaders = sessionHeaders(userB);
    const csvBuf = Buffer.from('sensitive,data\n1,2\n');

    // Completed session belonging to userA
    const sessionA = await tusEngine.createSession({
      uploadLength: csvBuf.length,
      metadataHeader: serializeTusMetadata({ filename: 'userA_secret.csv' }),
      ownerUserId: userA.id,
    });

    await tusEngine.appendChunk(
      sessionA.id,
      0,
      new ReadableStream({
        start(controller) {
          controller.enqueue(csvBuf);
          controller.close();
        },
      })
    );

    // UserB tries to access userA's completed uploadId
    const crossTenantReq = new NextRequest(`${BASE_URL}/api/v1/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...userBHeaders },
      body: JSON.stringify({
        uploadId: sessionA.id,
        targetFormat: 'json',
      }),
    });
    const crossTenantRes = await jobsPostHandler(crossTenantReq);
    expect(crossTenantRes.status).toBe(404);
  });
});
