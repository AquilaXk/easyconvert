import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { startS3StubServer, type S3StubServer, type StubRequestRecord } from './helpers/s3-stub-server';

/**
 * STORAGE_DRIVER=oci with a failing object store: every route that touches storage answers an
 * unavailable store with a 503 problem document that names no provider detail, and bad caller
 * input with a typed 400. The routes load fresh under the OCI environment, as in a deployment.
 */

/** A failing store is retried with backoff before the route answers, and the first test loads the whole app. */
const ROUTE_TEST_TIMEOUT_MS = 30_000;
vi.setConfig({ testTimeout: ROUTE_TEST_TIMEOUT_MS });

const BUCKET = 'internal-objects';
const REGION = 'ap-seoul-1';
const ACCESS_KEY = 'AKIAOCIEXAMPLE0000001';
const SECRET = 'oci/Secret+Key/EXAMPLEKEY000000000000000';
const SIGNING_SECRET = 'route-errors-test-signing-secret-0001';
const BASE_URL = 'http://localhost:3000';
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAVAILABLE = 503;
const PROBLEM_JSON = 'application/problem+json';
const UNAVAILABLE_DETAIL = 'Object storage is temporarily unavailable. Retry the request shortly.';
const PROVIDER_DETAIL = ['SlowDown', 'AccessDenied', 'AKIAOCIEXAMPLE', 'S3 request failed', 'internal-objects'];

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb0, 0x00, 0x00, 0x00,
  0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

describe('STORAGE_DRIVER=oci answers storage failures with typed problem documents', () => {
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

  async function loadUser(tag: string) {
    const { userStore } = await import('../src/lib/auth/user-store');
    const { createSessionToken } = await import('../src/lib/auth/session');
    const email = `${tag}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@route-errors.local`;
    const user = userStore.sanitizeUser(await userStore.createUser({ email, name: tag, tier: 'pro' }));
    return { user, cookie: { Cookie: `easyconvert_session=${createSessionToken(user)}` } };
  }

  function failStore(match: (req: StubRequestRecord) => boolean, status: number, code: string) {
    server.faults.push({ match, status, code, times: Infinity });
  }

  async function expectUnavailable(res: Response) {
    expect(res.status).toBe(HTTP_UNAVAILABLE);
    expect(res.headers.get('Content-Type')).toBe(PROBLEM_JSON);
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    const body = await res.json();
    expect(body.detail).toBe(UNAVAILABLE_DETAIL);
    const text = JSON.stringify(body);
    for (const leaked of PROVIDER_DETAIL) expect(text).not.toContain(leaked);
  }

  const jsonPost = (url: string, cookie: Record<string, string>, body: unknown) =>
    new NextRequest(`${BASE_URL}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie },
      body: JSON.stringify(body),
    });

  describe('reads', () => {
    it('answers a download whose HEAD fails with 503', async () => {
      const { user, cookie } = await loadUser('dl');
      const storage = await import('../src/lib/storage');
      const key = `conversions/${user.id}/o.pdf`;
      await storage.storageProvider.saveObject(key, PDF, 'application/pdf', 'o.pdf', 3_600_000);
      failStore((req) => req.method === 'HEAD', 503, 'SlowDown');
      const { GET } = await import('../src/app/api/storage/file/[...key]/route');
      const res = await GET(new NextRequest(`${BASE_URL}/api/storage/file/${encodeURIComponent(key)}`, { headers: cookie }), {
        params: { key: [key] },
      });
      await expectUnavailable(res);
    });

    it('answers a job submission whose storage stat fails with 503 instead of "object unavailable"', async () => {
      const { user } = await loadUser('job');
      const storage = await import('../src/lib/storage');
      const { redisKeyStore } = await import('../src/lib/api-keys/redis-key-store');
      const key = `uploads/${Date.now()}_o.csv`;
      await storage.storageProvider.saveObject(key, Buffer.from('a,b\n1,2\n'), 'text/csv', 'o.csv', 3_600_000);
      const apiKey = await redisKeyStore.generateApiKey(user.id, 'route errors', { scopes: ['convert:write'] });
      failStore((req) => req.method === 'HEAD', 503, 'SlowDown');
      const { POST } = await import('../src/app/api/v1/jobs/route');
      const res = await POST(
        new NextRequest(`${BASE_URL}/api/v1/jobs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey.secretKey}` },
          body: JSON.stringify({ originalFilename: 'o.csv', targetFormat: 'json', storageKey: key }),
        })
      );
      await expectUnavailable(res);
    });
  });

  describe('direct multipart uploads', () => {
    const initBody = { filename: 'doc.pdf', totalSize: PDF.length, partSize: PDF.length, mimeType: 'application/pdf' };

    for (const [status, code] of [
      [503, 'SlowDown'],
      [403, 'AccessDenied'],
    ] as const) {
      it(`answers an initiate that the store fails with ${status} ${code} as 503`, async () => {
        const { cookie } = await loadUser('init');
        failStore((req) => req.method === 'POST' && req.query.has('uploads'), status, code);
        const { POST } = await import('../src/app/api/v1/uploads/direct/route');
        await expectUnavailable(await POST(jsonPost('/api/v1/uploads/direct', cookie, initBody)));
      });
    }

    it('answers a complete whose ListParts fails as 503', async () => {
      const { cookie } = await loadUser('complete');
      const { POST: initiate } = await import('../src/app/api/v1/uploads/direct/route');
      const { POST: complete } = await import('../src/app/api/v1/uploads/direct/complete/route');
      const init = await (await initiate(jsonPost('/api/v1/uploads/direct', cookie, initBody))).json();
      const put = await fetch(init.parts[0].uploadUrl, { method: 'PUT', body: PDF });
      failStore((req) => req.method === 'GET' && req.query.has('uploadId'), 503, 'SlowDown');
      const res = await complete(
        jsonPost('/api/v1/uploads/direct/complete', cookie, { uploadId: init.uploadId, parts: [{ partNumber: 1, etag: put.headers.get('etag') }] })
      );
      await expectUnavailable(res);
    });

    it('answers an invalid content type with 400 rather than a storage error', async () => {
      const { cookie } = await loadUser('mime');
      const { POST } = await import('../src/app/api/v1/uploads/direct/route');
      const res = await POST(jsonPost('/api/v1/uploads/direct', cookie, { ...initBody, mimeType: 'application/pdfé' }));
      expect(res.status).toBe(HTTP_BAD_REQUEST);
      expect((await res.json()).detail).toContain('printable ASCII content type');
    });
  });

  describe('multipart route', () => {
    const post = async (cookie: Record<string, string>, action: string, body: unknown) => {
      const { POST } = await import('../src/app/api/storage/multipart/route');
      return POST(jsonPost(`/api/storage/multipart?action=${action}`, cookie, body));
    };

    it('answers an initiate that the store fails as 503', async () => {
      const { cookie } = await loadUser('minit');
      failStore((req) => req.method === 'POST' && req.query.has('uploads'), 503, 'SlowDown');
      await expectUnavailable(await post(cookie, 'initiate', { filename: 'a.pdf', totalSize: 10, mimeType: 'application/pdf' }));
    });

    it('answers a chunk that the store fails as 503', async () => {
      const { cookie } = await loadUser('mchunk');
      const init = await (await post(cookie, 'initiate', { filename: 'a.pdf', totalSize: PDF.length, mimeType: 'application/pdf' })).json();
      failStore((req) => req.method === 'PUT', 503, 'SlowDown');
      const { POST } = await import('../src/app/api/storage/multipart/route');
      const res = await POST(
        new NextRequest(`${BASE_URL}/api/storage/multipart?action=chunk&uploadId=${encodeURIComponent(init.uploadId)}&partNumber=1`, {
          method: 'POST',
          headers: cookie,
          body: PDF,
          duplex: 'half',
        } as never)
      );
      await expectUnavailable(res);
    });

    it('answers a filename with an unpaired surrogate with a typed 400', async () => {
      const { cookie } = await loadUser('msurr');
      const res = await post(cookie, 'initiate', { filename: '\ud800.pdf', totalSize: 10, mimeType: 'application/pdf' });
      expect(res.status).toBe(HTTP_BAD_REQUEST);
      expect(res.headers.get('Content-Type')).toBe(PROBLEM_JSON);
      expect((await res.json()).detail).toContain('valid Unicode');
    });

    describe('presign input', () => {
      const cases: Array<[string, unknown]> = [
        ['an unpaired surrogate key', { type: 'download', key: '\ud800' }],
        ['a non-string key', { type: 'download', key: { x: 1 } }],
        ['a key with a ".." segment', { type: 'download', key: 'a/../b' }],
        ['a non-numeric expiry', { type: 'download', key: 'conversions/x/ok.pdf', expiresInSeconds: 'abc' }],
        ['a fractional expiry', { type: 'download', key: 'conversions/x/ok.pdf', expiresInSeconds: 1.5 }],
        ['an expiry beyond seven days', { type: 'download', key: 'conversions/x/ok.pdf', expiresInSeconds: 99_999_999 }],
        ['a zero expiry', { type: 'download', key: 'conversions/x/ok.pdf', expiresInSeconds: 0 }],
      ];
      for (const [label, body] of cases) {
        it(`answers ${label} with a typed 400 before any URL is built`, async () => {
          const { cookie } = await loadUser('presign');
          const res = await post(cookie, 'presign', body);
          expect(res.status).toBe(HTTP_BAD_REQUEST);
          expect(res.headers.get('Content-Type')).toBe(PROBLEM_JSON);
          expect(server.requests).toEqual([]);
        });
      }
    });
  });

  describe('resumable (tus) uploads', () => {
    async function createSession(cookie: Record<string, string>, length: number, extraHeaders: Record<string, string> = {}, body?: Buffer) {
      const { serializeTusMetadata } = await import('../src/lib/storage/tus-engine');
      const { POST } = await import('../src/app/api/v1/uploads/[[...id]]/route');
      return POST(
        new NextRequest(`${BASE_URL}/api/v1/uploads`, {
          method: 'POST',
          headers: {
            'Tus-Resumable': '1.0.0',
            'Upload-Length': String(length),
            'Upload-Metadata': serializeTusMetadata({ filename: 'pic.png', filetype: 'image/png' }),
            ...extraHeaders,
            ...cookie,
          },
          body,
          duplex: 'half',
        } as never)
      );
    }

    it('answers a final PATCH chunk that the store fails as 503 and keeps the session resumable', async () => {
      const { cookie } = await loadUser('tus');
      const created = await createSession(cookie, PNG.length);
      const sessionId = created.headers.get('Location')!.split('/').pop()!;
      failStore((req) => req.method === 'PUT', 503, 'SlowDown');
      const { PATCH } = await import('../src/app/api/v1/uploads/[[...id]]/route');
      const res = await PATCH(
        new NextRequest(`${BASE_URL}/api/v1/uploads/${sessionId}`, {
          method: 'PATCH',
          headers: { 'Tus-Resumable': '1.0.0', 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0', ...cookie },
          body: PNG,
          duplex: 'half',
        } as never),
        { params: { id: [sessionId] } }
      );
      await expectUnavailable(res);
      expect(res.headers.get('Tus-Resumable')).toBe('1.0.0');
    });

    it('answers a creation-with-upload whose store write fails as 503', async () => {
      const { cookie } = await loadUser('tuscreate');
      failStore((req) => req.method === 'PUT', 503, 'SlowDown');
      const res = await createSession(cookie, PNG.length, { 'Content-Type': 'application/offset+octet-stream' }, PNG);
      await expectUnavailable(res);
      expect(res.headers.get('Tus-Resumable')).toBe('1.0.0');
    });
  });
});
