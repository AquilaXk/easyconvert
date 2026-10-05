import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { S3ObjectClient } from '../src/lib/storage/s3-object-client';
import { RemoteStorageBackend } from '../src/lib/storage/remote-storage-backend';
import { Queue } from '../src/lib/queue/bullmq-engine';
import { nativeEngine, processNodeJob } from '../src/lib/queue/node-processor';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';
import { startS3StubServer, type S3StubServer } from './helpers/s3-stub-server';

/**
 * STORAGE_DRIVER=oci end to end: the API routes, resumable uploads and the job processor run
 * against the signature-verifying stub S3 server, and nothing may reach local disk or process
 * memory. The route modules are loaded fresh under the OCI environment, exactly as a deployment
 * loads them.
 */

const BUCKET = 'internal-objects';
const REGION = 'ap-seoul-1';
const ACCESS_KEY = 'AKIAOCIEXAMPLE0000001';
const SECRET = 'oci/Secret+Key/EXAMPLEKEY000000000000000';
const SIGNING_SECRET = 'remote-wiring-test-signing-secret-0001';
const BASE_URL = 'http://localhost:3000';
const HTTP_OK = 200;

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb0, 0x00, 0x00, 0x00,
  0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

describe('STORAGE_DRIVER=oci wires every storage path to the object store', () => {
  let server: S3StubServer;

  beforeAll(async () => {
    server = await startS3StubServer({ bucket: BUCKET, credentials: { [ACCESS_KEY]: SECRET } });
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.objects.clear();
    server.uploads.clear();
    server.requests.length = 0;
    server.faults.length = 0;
    vi.stubEnv('STORAGE_DRIVER', 'oci');
    vi.stubEnv('OCI_NAMESPACE', 'axyz123namespace');
    vi.stubEnv('OCI_REGION', REGION);
    vi.stubEnv('OCI_BUCKET', BUCKET);
    vi.stubEnv('OCI_ACCESS_KEY_ID', ACCESS_KEY);
    vi.stubEnv('OCI_SECRET_ACCESS_KEY', SECRET);
    vi.stubEnv('OCI_ENDPOINT', server.url);
    vi.stubEnv('STORAGE_SIGNING_SECRET', SIGNING_SECRET);
    vi.stubEnv('APP_URL', BASE_URL);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadApp() {
    const storage = await import('../src/lib/storage');
    const { userStore } = await import('../src/lib/auth/user-store');
    const { createSessionToken } = await import('../src/lib/auth/session');
    const email = `wiring_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@remote-storage.local`;
    const user = userStore.sanitizeUser(await userStore.createUser({ email, name: 'wiring', tier: 'pro' }));
    const cookie = { Cookie: `easyconvert_session=${createSessionToken(user)}` };
    return { storage, user, cookie };
  }

  it('selects the object store for both storage interfaces', async () => {
    const { storage } = await loadApp();
    expect(storage.storageConfig).toMatchObject({
      driver: 'oci',
      endpoint: server.url,
      bucket: BUCKET,
      namespace: 'axyz123namespace',
    });
    expect(storage.storageProvider.kind).toBe('remote');
    expect(storage.storageProvider).toBeInstanceOf(storage.RemoteStorageBackend);
    expect(storage.objectStorage).toBeInstanceOf(storage.S3CompatibleStorage);
    expect(storage.defaultStorage).toBe(storage.storageProvider);
  });

  describe('direct multipart uploads', () => {
    async function initiate(cookie: Record<string, string>, body: Record<string, unknown>) {
      const { POST } = await import('../src/app/api/v1/uploads/direct/route');
      return POST(
        new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...cookie },
          body: JSON.stringify(body),
        })
      );
    }

    async function complete(cookie: Record<string, string>, body: Record<string, unknown>) {
      const { POST } = await import('../src/app/api/v1/uploads/direct/complete/route');
      return POST(
        new NextRequest(`${BASE_URL}/api/v1/uploads/direct/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...cookie },
          body: JSON.stringify(body),
        })
      );
    }

    it('hands the client object-store part URLs, then verifies and completes the assembled object', async () => {
      const { cookie, user } = await loadApp();
      const initRes = await initiate(cookie, { filename: 'doc.pdf', totalSize: PDF.length, partSize: PDF.length });
      expect(initRes.status).toBe(HTTP_OK);
      const init = await initRes.json();

      expect(init.key).toMatch(new RegExp(`^conversions/${user.id}/\\d+_[0-9a-f]{16}_doc\\.pdf$`));
      const partUrl = new URL(init.parts[0].uploadUrl);
      expect(partUrl.origin).toBe(server.url);
      expect(partUrl.pathname).toBe(`/${BUCKET}/${init.key}`);
      expect(partUrl.searchParams.get('X-Amz-Credential')?.startsWith(`${ACCESS_KEY}/`)).toBe(true);

      // The browser PUTs the part to the object store, not to the application.
      const put = await fetch(init.parts[0].uploadUrl, { method: 'PUT', body: PDF });
      expect(put.status).toBe(HTTP_OK);
      const etag = put.headers.get('etag') as string;

      const done = await complete(cookie, { uploadId: init.uploadId, parts: [{ partNumber: 1, etag }] });
      expect(done.status).toBe(HTTP_OK);
      const result = await done.json();
      expect(result).toMatchObject({ key: init.key, storageKey: init.key, size: PDF.length });
      expect(server.objects.get(init.key)?.body.equals(PDF)).toBe(true);
      for (const request of server.requests) expect(request.auth.ok).toBe(true);
    });

    it('purges an assembled object whose bytes do not match the declared format', async () => {
      const { cookie } = await loadApp();
      const init = await (await initiate(cookie, { filename: 'fake.pdf', totalSize: PNG.length, partSize: PNG.length })).json();
      const put = await fetch(init.parts[0].uploadUrl, { method: 'PUT', body: PNG });
      const res = await complete(cookie, { uploadId: init.uploadId, parts: [{ partNumber: 1, etag: put.headers.get('etag') }] });
      expect(res.status).toBe(422);
      expect((await res.json()).detail).toContain('File spoofing rejected');
      expect(server.objects.has(init.key)).toBe(false);
    });

    it('purges an assembled object whose size differs from the declared totalSize', async () => {
      const { cookie } = await loadApp();
      const init = await (await initiate(cookie, { filename: 'doc.pdf', totalSize: PDF.length + 100, partSize: PDF.length + 100 })).json();
      const put = await fetch(init.parts[0].uploadUrl, { method: 'PUT', body: PDF });
      const res = await complete(cookie, { uploadId: init.uploadId, parts: [{ partNumber: 1, etag: put.headers.get('etag') }] });
      expect(res.status).toBe(400);
      expect((await res.json()).detail).toContain('does not match the declared totalSize');
      expect(server.objects.has(init.key)).toBe(false);
    });

    it('answers an unknown format with a typed 400 and purges the object', async () => {
      const { cookie } = await loadApp();
      const init = await (await initiate(cookie, { filename: 'no-extension', totalSize: PDF.length, partSize: PDF.length })).json();
      const put = await fetch(init.parts[0].uploadUrl, { method: 'PUT', body: PDF });
      const res = await complete(cookie, { uploadId: init.uploadId, parts: [{ partNumber: 1, etag: put.headers.get('etag') }] });
      expect(res.status).toBe(400);
      expect((await res.json()).type).toBe('https://api.easyconvert.io/problems/unknown-format');
      expect(server.objects.has(init.key)).toBe(false);
    });

    it('hides another user\'s upload session and refuses parts sent through the application', async () => {
      const { cookie } = await loadApp();
      const init = await (await initiate(cookie, { filename: 'doc.pdf', totalSize: PDF.length, partSize: PDF.length })).json();

      const { userStore } = await import('../src/lib/auth/user-store');
      const { createSessionToken } = await import('../src/lib/auth/session');
      const stranger = userStore.sanitizeUser(
        await userStore.createUser({ email: `stranger_${Date.now()}@remote-storage.local`, name: 'stranger', tier: 'pro' })
      );
      const strangerCookie = { Cookie: `easyconvert_session=${createSessionToken(stranger)}` };
      const res = await complete(strangerCookie, { uploadId: init.uploadId, parts: [{ partNumber: 1, etag: '"x"' }] });
      expect(res.status).toBe(404);

      const { PUT } = await import('../src/app/api/v1/uploads/direct/part/route');
      const partRes = await PUT(
        new NextRequest(`${BASE_URL}/api/v1/uploads/direct/part?uploadId=${encodeURIComponent(init.uploadId)}&partNumber=1`, {
          method: 'PUT',
          body: PDF,
          duplex: 'half',
        } as never)
      );
      expect(partRes.status).toBe(404);
      expect((await partRes.json()).detail).toContain('directly to the object store');
    });

    it('aborts a session through the DELETE route', async () => {
      const { cookie } = await loadApp();
      const init = await (await initiate(cookie, { filename: 'doc.pdf', totalSize: PDF.length, partSize: PDF.length })).json();
      expect(server.uploads.size).toBe(1);
      const { DELETE } = await import('../src/app/api/v1/uploads/direct/[id]/route');
      const res = await DELETE(
        new NextRequest(`${BASE_URL}/api/v1/uploads/direct/${init.uploadId}`, { method: 'DELETE', headers: cookie }),
        { params: { id: init.uploadId } }
      );
      expect(res.status).toBe(204);
      expect(server.uploads.size).toBe(0);
    });
  });

  describe('resumable (tus) uploads', () => {
    it('stores a finished upload in the object store and serves it back through the download route', async () => {
      const { cookie, user, storage } = await loadApp();
      const { serializeTusMetadata } = await import('../src/lib/storage/tus-engine');
      const { POST, PATCH } = await import('../src/app/api/v1/uploads/[[...id]]/route');

      const created = await POST(
        new NextRequest(`${BASE_URL}/api/v1/uploads`, {
          method: 'POST',
          headers: {
            'Tus-Resumable': '1.0.0',
            'Upload-Length': String(PNG.length),
            'Upload-Metadata': serializeTusMetadata({ filename: 'pic.png', filetype: 'image/png' }),
            ...cookie,
          },
        })
      );
      expect(created.status).toBe(201);
      const sessionId = created.headers.get('Location')!.split('/').pop()!;

      const patched = await PATCH(
        new NextRequest(`${BASE_URL}/api/v1/uploads/${sessionId}`, {
          method: 'PATCH',
          headers: {
            'Tus-Resumable': '1.0.0',
            'Content-Type': 'application/offset+octet-stream',
            'Upload-Offset': '0',
            ...cookie,
          },
          body: PNG,
          duplex: 'half',
        } as never),
        { params: { id: [sessionId] } }
      );
      expect(patched.status).toBe(204);
      const key = patched.headers.get('EasyConvert-Storage-Key') as string;
      expect(key).toBe(`conversions/${user.id}/${sessionId}_pic.png`);

      const onServer = server.objects.get(key)!;
      expect(onServer.body.equals(PNG)).toBe(true);
      expect(onServer.contentType).toBe('image/png');
      expect(onServer.metadata?.filename).toBe('pic.png');
      const put = server.requests.find((r) => r.method === 'PUT' && r.key === key)!;
      expect(put.headers['content-length']).toBe(String(PNG.length));

      // The job side finds the same object through the storage provider.
      const stat = await storage.storageProvider.stat(key);
      expect(stat).toMatchObject({ size: PNG.length, mimeType: 'image/png', filename: 'pic.png' });

      const { GET } = await import('../src/app/api/storage/file/[...key]/route');
      const download = await GET(
        new NextRequest(`${BASE_URL}/api/storage/file/${encodeURIComponent(key)}`, { headers: cookie }),
        { params: { key: key.split('/') } }
      );
      expect(download.status).toBe(HTTP_OK);
      expect(download.headers.get('Content-Type')).toBe('image/png');
      expect(Buffer.from(await download.arrayBuffer()).equals(PNG)).toBe(true);

      const ranged = await GET(
        new NextRequest(`${BASE_URL}/api/storage/file/${encodeURIComponent(key)}`, { headers: { ...cookie, Range: 'bytes=0-7' } }),
        { params: { key: key.split('/') } }
      );
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get('Content-Range')).toBe(`bytes 0-7/${PNG.length}`);
      expect(Buffer.from(await ranged.arrayBuffer()).equals(PNG.subarray(0, 8))).toBe(true);
    });

    it('rewinds the final chunk when the object store refuses the upload, so the client can resend it', async () => {
      const { cookie, user } = await loadApp();
      const { serializeTusMetadata } = await import('../src/lib/storage/tus-engine');
      const { POST, PATCH, HEAD } = await import('../src/app/api/v1/uploads/[[...id]]/route');
      const created = await POST(
        new NextRequest(`${BASE_URL}/api/v1/uploads`, {
          method: 'POST',
          headers: {
            'Tus-Resumable': '1.0.0',
            'Upload-Length': String(PNG.length),
            'Upload-Metadata': serializeTusMetadata({ filename: 'retry.png', filetype: 'image/png' }),
            ...cookie,
          },
        })
      );
      const sessionId = created.headers.get('Location')!.split('/').pop()!;
      const patch = () =>
        PATCH(
          new NextRequest(`${BASE_URL}/api/v1/uploads/${sessionId}`, {
            method: 'PATCH',
            headers: { 'Tus-Resumable': '1.0.0', 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0', ...cookie },
            body: PNG,
            duplex: 'half',
          } as never),
          { params: { id: [sessionId] } }
        );

      server.faults.push({ match: (req) => req.method === 'PUT', status: 503, code: 'SlowDown', times: Infinity });
      const failed = await patch();
      expect(failed.status).toBe(503);
      expect(failed.headers.get('Content-Type')).toBe('application/problem+json');
      expect(failed.headers.get('EasyConvert-Storage-Key')).toBeNull();
      expect([...server.objects.keys()]).toEqual([]);

      const head = await HEAD(
        new NextRequest(`${BASE_URL}/api/v1/uploads/${sessionId}`, { method: 'HEAD', headers: { 'Tus-Resumable': '1.0.0', ...cookie } }),
        { params: { id: [sessionId] } }
      );
      expect(head.headers.get('Upload-Offset')).toBe('0');

      server.faults.length = 0;
      const retried = await patch();
      expect(retried.status).toBe(204);
      expect(server.objects.get(`conversions/${user.id}/${sessionId}_retry.png`)?.body.equals(PNG)).toBe(true);
    });

    it('refuses the final chunk with a typed 400 when no format can be determined and stores nothing', async () => {
      const { cookie } = await loadApp();
      const { serializeTusMetadata } = await import('../src/lib/storage/tus-engine');
      const { POST, PATCH } = await import('../src/app/api/v1/uploads/[[...id]]/route');
      const created = await POST(
        new NextRequest(`${BASE_URL}/api/v1/uploads`, {
          method: 'POST',
          headers: {
            'Tus-Resumable': '1.0.0',
            'Upload-Length': String(PDF.length),
            'Upload-Metadata': serializeTusMetadata({ filename: 'no-extension' }),
            ...cookie,
          },
        })
      );
      const sessionId = created.headers.get('Location')!.split('/').pop()!;
      const patched = await PATCH(
        new NextRequest(`${BASE_URL}/api/v1/uploads/${sessionId}`, {
          method: 'PATCH',
          headers: { 'Tus-Resumable': '1.0.0', 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0', ...cookie },
          body: PDF,
          duplex: 'half',
        } as never),
        { params: { id: [sessionId] } }
      );
      expect(patched.status).toBe(400);
      expect([...server.objects.keys()]).toEqual([]);
    });
  });

  describe('multipart upload actions of the uploads route', () => {
    it('presigns object-store part URLs and refuses to receive parts itself', async () => {
      const { cookie } = await loadApp();
      const { POST } = await import('../src/app/api/v1/uploads/[[...id]]/route');
      const initRes = await POST(
        new NextRequest(`${BASE_URL}/api/v1/uploads?action=initiate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...cookie },
          body: JSON.stringify({ filename: 'report.pdf', mimeType: 'application/pdf', totalSize: PDF.length }),
        })
      );
      expect(initRes.status).toBe(HTTP_OK);
      const init = await initRes.json();
      expect(new URL(init.presignedUrls[0].url).origin).toBe(server.url);

      const put = await fetch(init.presignedUrls[0].url, { method: 'PUT', body: PDF });
      expect(put.status).toBe(HTTP_OK);
      const completeRes = await POST(
        new NextRequest(`${BASE_URL}/api/v1/uploads?action=complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...cookie },
          body: JSON.stringify({
            uploadId: init.uploadId,
            key: init.key,
            parts: [{ partNumber: 1, etag: put.headers.get('etag') }],
            expectedSize: PDF.length,
          }),
        })
      );
      expect(completeRes.status).toBe(HTTP_OK);
      expect(server.objects.get(init.key)?.body.equals(PDF)).toBe(true);

      const partRes = await POST(
        new NextRequest(`${BASE_URL}/api/v1/uploads?action=part&uploadId=${init.uploadId}&partNumber=1`, {
          method: 'POST',
          headers: cookie,
          body: PDF,
          duplex: 'half',
        } as never)
      );
      expect(partRes.status).toBe(404);
    });
  });

  describe('job submission and queue processing', () => {
    const CSV_INPUT = 'name,score\nAlice,100\nBob,95\n';

    async function loadJobApp() {
      const app = await loadApp();
      const { redisKeyStore } = await import('../src/lib/api-keys/redis-key-store');
      const { POST } = await import('../src/app/api/v1/jobs/route');
      const queueModule = await import('../src/lib/queue/conversion-queue');
      const bullmq = await import('../src/lib/queue/bullmq-engine');
      const key = await redisKeyStore.generateApiKey(app.user.id, 'wiring write', { scopes: ['convert:write'] });
      const submit = (storageKey: string, originalFilename: string) =>
        POST(
          new NextRequest(`${BASE_URL}/api/v1/jobs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.secretKey}` },
            body: JSON.stringify({ originalFilename, targetFormat: 'json', storageKey }),
          })
        );
      return { ...app, submit, queueModule, bullmq };
    }

    it('runs a submitted job from an object-store input to a presigned result and removes the upload', async () => {
      const { storage, submit, queueModule, bullmq } = await loadJobApp();
      const inputKey = `uploads/${Date.now()}_scores.csv`;
      await storage.storageProvider.saveObject(inputKey, Buffer.from(CSV_INPUT), 'text/csv', 'scores.csv', 3_600_000);

      const res = await submit(inputKey, 'scores.csv');
      expect(res.status).toBe(202);
      const { jobId } = await res.json();
      expect((await queueModule.conversionQueue.getJob(jobId))?.data.storageKey).toBe(inputKey);

      const worker = new bullmq.Worker(queueModule.conversionQueue, queueModule.processConversionJob, { concurrency: 1 });
      queueModule.attachInputCleanupOnCompletion(worker);
      const result = await new Promise<ConversionJobResult>((resolve, reject) => {
        worker.on('completed', (job: { id: string }, value: ConversionJobResult) => {
          if (job.id === jobId) resolve(value);
        });
        worker.on('failed', (job: { id: string }, err: Error) => {
          if (job.id === jobId) reject(err);
        });
      });
      await worker.close();

      const rows = JSON.parse(server.objects.get(result.resultKey)!.body.toString('utf-8'));
      expect(rows).toEqual([
        { name: 'Alice', score: '100' },
        { name: 'Bob', score: '95' },
      ]);
      const downloaded = await fetch(result.downloadUrl);
      expect(downloaded.status).toBe(HTTP_OK);
      expect(JSON.parse(await downloaded.text())).toEqual(rows);

      // The completed job's upload is deleted from the object store.
      await vi.waitFor(() => expect(server.objects.has(inputKey)).toBe(false));
    });

    it('rejects a stored object whose first bytes do not match its extension, reading only its header', async () => {
      const { storage, submit } = await loadJobApp();
      const fakeKey = `uploads/${Date.now()}_fake.pdf`;
      await storage.storageProvider.saveObject(fakeKey, PNG, 'application/pdf', 'fake.pdf', 3_600_000);
      server.requests.length = 0;

      const res = await submit(fakeKey, 'fake.pdf');
      expect(res.status).toBe(400);
      expect((await res.json()).title).toBe('File Spoofing Detected');
      const reads = server.requests.filter((r) => r.method === 'GET' && r.key === fakeKey);
      expect(reads).toHaveLength(1);
      expect(reads[0].headers.range).toBe(`bytes=0-${PNG.length - 1}`);
    });

    it('answers a key that names no stored object with the not-found response', async () => {
      const { submit } = await loadJobApp();
      const res = await submit(`uploads/${Date.now()}_missing.csv`, 'missing.csv');
      expect(res.status).toBe(404);
    });
  });

  describe('multipart route (/api/storage/multipart)', () => {
    async function call(cookie: Record<string, string>, action: string, body: unknown) {
      const { POST } = await import('../src/app/api/storage/multipart/route');
      return POST(
        new NextRequest(`${BASE_URL}/api/storage/multipart?action=${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...cookie },
          body: JSON.stringify(body),
        })
      );
    }

    it('initiates, receives a chunk, and completes entirely on the object store', async () => {
      const { cookie, user } = await loadApp();
      const initRes = await call(cookie, 'initiate', { filename: 'chunky.bin', mimeType: 'application/octet-stream', totalSize: 11 });
      expect(initRes.status).toBe(HTTP_OK);
      const init = await initRes.json();
      expect(init.key).toMatch(new RegExp(`^conversions/${user.id}/`));

      const { POST } = await import('../src/app/api/storage/multipart/route');
      const chunkRes = await POST(
        new NextRequest(`${BASE_URL}/api/storage/multipart?action=chunk&uploadId=${encodeURIComponent(init.uploadId)}&partNumber=1`, {
          method: 'POST',
          headers: cookie,
          body: Buffer.from('hello world'),
          duplex: 'half',
        } as never)
      );
      expect(chunkRes.status).toBe(HTTP_OK);
      const chunk = await chunkRes.json();
      expect(chunk).toMatchObject({ success: true, partNumber: 1, size: 11 });

      const doneRes = await call(cookie, 'complete', { uploadId: init.uploadId, parts: [{ partNumber: 1, etag: chunk.etag }] });
      expect(doneRes.status).toBe(HTTP_OK);
      expect(await doneRes.json()).toMatchObject({ success: true, key: init.key, size: 11 });
      expect(server.objects.get(init.key)?.body.toString()).toBe('hello world');
    });

    it('hides a session from other users on every action', async () => {
      const { cookie } = await loadApp();
      const init = await (await call(cookie, 'initiate', { filename: 'chunky.bin', totalSize: 11 })).json();

      const { userStore } = await import('../src/lib/auth/user-store');
      const { createSessionToken } = await import('../src/lib/auth/session');
      const stranger = userStore.sanitizeUser(
        await userStore.createUser({ email: `stranger_${Date.now()}@remote-storage.local`, name: 'stranger', tier: 'pro' })
      );
      const other = { Cookie: `easyconvert_session=${createSessionToken(stranger)}` };

      expect((await call(other, 'complete', { uploadId: init.uploadId })).status).toBe(404);
      expect((await call(other, 'abort', { uploadId: init.uploadId })).status).toBe(404);
      expect((await call(other, 'presign', { type: 'upload', key: init.key, uploadId: init.uploadId, partNumber: 1 })).status).toBe(404);
      expect(server.uploads.size).toBe(1);

      expect((await call(cookie, 'abort', { uploadId: init.uploadId })).status).toBe(HTTP_OK);
      expect(server.uploads.size).toBe(0);
    });

    it('presigns upload and download URLs on the object store with the real credentials', async () => {
      const { cookie, user } = await loadApp();
      const init = await (await call(cookie, 'initiate', { filename: 'chunky.bin', totalSize: 4 })).json();

      const upload = await (await call(cookie, 'presign', { type: 'upload', key: init.key, uploadId: init.uploadId, partNumber: 1 })).json();
      expect(new URL(upload.url).origin).toBe(server.url);
      const put = await fetch(upload.url, { method: 'PUT', body: Buffer.from('abcd') });
      expect(put.status).toBe(HTTP_OK);
      const doneRes = await call(cookie, 'complete', { uploadId: init.uploadId, parts: [{ partNumber: 1, etag: put.headers.get('etag') }] });
      expect(doneRes.status).toBe(HTTP_OK);

      const download = await (await call(cookie, 'presign', { type: 'download', key: init.key })).json();
      expect(new URL(download.url).searchParams.get('X-Amz-Credential')?.startsWith(`${ACCESS_KEY}/`)).toBe(true);
      expect(await (await fetch(download.url)).text()).toBe('abcd');

      // Another user's key is answered like a missing object.
      const foreign = await call(cookie, 'presign', { type: 'download', key: `conversions/${user.id}x/other.bin` });
      expect(foreign.status).toBe(404);
    });
  });

  describe('queue stats', () => {
    it('reports that an object store has no cheap session or object count instead of inventing one', async () => {
      await loadApp();
      const { GET } = await import('../src/app/api/queue/stats/route');
      const body = await (await GET()).json();
      expect(body.storage).toEqual({ activeUploadSessions: null, storedObjects: null });
    });
  });

  describe('job processing', () => {
    function makeBackend(): RemoteStorageBackend {
      return new RemoteStorageBackend(
        new S3ObjectClient({
          endpoint: server.url,
          region: REGION,
          bucket: BUCKET,
          accessKeyId: ACCESS_KEY,
          secretAccessKey: SECRET,
          providerName: 'oci',
          retryBaseDelayMs: 0,
        }),
        { signingSecret: SIGNING_SECRET }
      );
    }

    it('reads the input from the object store, writes the result there, and returns a presigned download URL', async () => {
      const backend = makeBackend();
      const csv = 'id,name,role\n101,Ada Lovelace,Mathematician\n102,Alan Turing,Computer Scientist\n';
      await backend.saveObject('uploads/users.csv', Buffer.from(csv), 'text/csv', 'users.csv');

      const queue = new Queue<ConversionJobData, ConversionJobResult>('remote-storage-wiring-queue');
      const job = await queue.add('convert', {
        jobId: 'job_remote_1',
        sourceFormat: 'csv',
        targetFormat: 'json',
        originalFilename: 'users.csv',
        fileSize: csv.length,
        storageKey: 'uploads/users.csv',
        options: {},
      });
      const result = await processNodeJob(job, nativeEngine, backend);
      await queue.close();

      expect(result.status).toBe('completed');
      expect(result.resultKey).toBe(`results/${job.id}/${result.filename}`);
      const stored = server.objects.get(result.resultKey);
      expect(stored).toBeDefined();
      const rows = JSON.parse(stored!.body.toString('utf-8')) as Array<Record<string, string>>;
      expect(rows).toEqual([
        { id: '101', name: 'Ada Lovelace', role: 'Mathematician' },
        { id: '102', name: 'Alan Turing', role: 'Computer Scientist' },
      ]);

      // The URL in the job result is a real presigned object-store URL: a plain HTTP client gets the result.
      const downloadUrl = new URL(result.downloadUrl);
      expect(downloadUrl.origin).toBe(server.url);
      expect(downloadUrl.searchParams.get('X-Amz-Credential')?.startsWith(`${ACCESS_KEY}/`)).toBe(true);
      const res = await fetch(result.downloadUrl);
      expect(res.status).toBe(HTTP_OK);
      expect(Buffer.from(await res.arrayBuffer()).equals(stored!.body)).toBe(true);
      expect(result.size).toBe(stored!.body.length);
    });

    it('reports a missing input object as a failed job instead of reading anything else', async () => {
      const backend = makeBackend();
      const queue = new Queue<ConversionJobData, ConversionJobResult>('remote-storage-wiring-queue-2');
      const job = await queue.add('convert', {
        jobId: 'job_remote_2',
        sourceFormat: 'csv',
        targetFormat: 'json',
        originalFilename: 'missing.csv',
        fileSize: 1,
        storageKey: 'uploads/missing.csv',
        options: {},
      });
      await expect(processNodeJob(job, nativeEngine, backend)).rejects.toThrow('Storage object not found for key: "uploads/missing.csv"');
      await queue.close();
    });
  });

  describe('startup', () => {
    it('fails closed in production when the oci driver lacks credentials', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('OCI_ACCESS_KEY_ID', '');
      vi.stubEnv('OCI_SECRET_ACCESS_KEY', '');
      vi.stubEnv('AWS_ACCESS_KEY_ID', '');
      vi.stubEnv('AWS_SECRET_ACCESS_KEY', '');
      vi.resetModules();
      const error = await import('../src/lib/storage/selected-storage').catch((e: unknown) => e);
      expect(error).toMatchObject({ name: 'StorageConfigError', missing: ['OCI_ACCESS_KEY_ID', 'OCI_SECRET_ACCESS_KEY'] });
    });

    it('fails closed in production when the driver is not chosen, instead of falling back to local disk', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('STORAGE_DRIVER', '');
      vi.resetModules();
      const error = await import('../src/lib/storage/selected-storage').catch((e: unknown) => e);
      expect(error).toMatchObject({ name: 'StorageConfigError', missing: ['STORAGE_DRIVER'] });
    });

    it('fails closed when a remote driver has no signing secret for its upload tokens', async () => {
      vi.stubEnv('STORAGE_SIGNING_SECRET', '');
      vi.stubEnv('S3_SIGNING_SECRET', '');
      vi.stubEnv('OCI_SIGNING_SECRET', '');
      vi.resetModules();
      const error = await import('../src/lib/storage/selected-storage').catch((e: unknown) => e);
      expect(error).toMatchObject({ name: 'StorageConfigError', missing: ['STORAGE_SIGNING_SECRET'] });
    });

    it('keeps local disk for STORAGE_DRIVER=local, in production too when it is chosen explicitly', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('STORAGE_DRIVER', 'local');
      vi.stubEnv('OCI_ACCESS_KEY_ID', '');
      vi.resetModules();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const selected = await import('../src/lib/storage/selected-storage');
      expect(selected.storageConfig).toEqual({ driver: 'local' });
      expect(selected.storageProvider.kind).toBe('local');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('STORAGE_DRIVER=local'));
      warn.mockRestore();
    });
  });
});
