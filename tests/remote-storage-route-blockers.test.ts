import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { startS3StubServer, type S3StubServer, type StubRequestRecord } from './helpers/s3-stub-server';

/**
 * Final-review findings on the object-store routes, each driven against the signature-verifying
 * stub S3 server: storage outages on the remaining routes answer 503 without provider text and
 * settle the quota, an archive can be inspected only by the owner of its key, an upload that grew
 * between two listings is refused, presigned part URLs are short-lived, and caller mistakes are
 * 400s rather than 500s.
 */

const ROUTE_TEST_TIMEOUT_MS = 30_000;
vi.setConfig({ testTimeout: ROUTE_TEST_TIMEOUT_MS });

const BUCKET = 'internal-objects';
const REGION = 'ap-seoul-1';
const ACCESS_KEY = 'AKIAOCIEXAMPLE0000001';
const SECRET = 'oci/Secret+Key/EXAMPLEKEY000000000000000';
const SIGNING_SECRET = 'route-blockers-test-signing-secret-0001';
const BASE_URL = 'http://localhost:3000';
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAVAILABLE = 503;
const PROBLEM_JSON = 'application/problem+json';
const UNAVAILABLE_DETAIL = 'Object storage is temporarily unavailable. Retry the request shortly.';
const PROVIDER_DETAIL = ['SlowDown', 'AccessDenied', 'AKIAOCIEXAMPLE', 'S3 request failed', 'internal-objects', 'oci'];
const PART_URL_WINDOW_SECONDS = 900;
const SEVEN_DAYS_SECONDS = 604_800;
const MIB = 1024 * 1024;
const FREE_TIER_CAP_BYTES = 100 * MIB;

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
const CSV = Buffer.from('name,score\nAlice,100\nBob,95\n');

describe('object-store routes after the final review', () => {
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

  async function loadUser(tag: string, tier: 'free' | 'pro' = 'pro') {
    const { userStore } = await import('../src/lib/auth/user-store');
    const { createSessionToken } = await import('../src/lib/auth/session');
    const email = `${tag}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@route-blockers.local`;
    const user = userStore.sanitizeUser(await userStore.createUser({ email, name: tag, tier }));
    return { user, cookie: { Cookie: `easyconvert_session=${createSessionToken(user)}` } };
  }

  async function usedToday(userId: string): Promise<number> {
    const { redisKeyStore } = await import('../src/lib/api-keys/redis-key-store');
    return (await redisKeyStore.getQuotaUsage(userId)).usedToday;
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

  function csvForm(extra: Record<string, string> = {}): FormData {
    const form = new FormData();
    form.append('file', new File([CSV], 'scores.csv', { type: 'text/csv' }));
    form.append('targetFormat', 'json');
    for (const [name, value] of Object.entries(extra)) form.append(name, value);
    return form;
  }

  describe('storage outages on the remaining routes', () => {
    it('answers an upload to /api/queue/jobs that the store refuses with 503 and settles the quota', async () => {
      const { user, cookie } = await loadUser('qjobs');
      failStore((req) => req.method === 'POST' && req.query.has('uploads'), 503, 'SlowDown');
      const { POST } = await import('../src/app/api/queue/jobs/route');
      const res = await POST(new NextRequest(`${BASE_URL}/api/queue/jobs`, { method: 'POST', headers: cookie, body: csvForm() as never }));
      await expectUnavailable(res);
      expect(await usedToday(user.id)).toBe(0);
    });

    it('answers a synchronous conversion whose result cannot be stored with 503 and does not charge the quota', async () => {
      const { user, cookie } = await loadUser('convsync');
      failStore((req) => req.method === 'PUT', 503, 'SlowDown');
      const { POST } = await import('../src/app/api/v1/convert/route');
      const res = await POST(new NextRequest(`${BASE_URL}/api/v1/convert`, { method: 'POST', headers: cookie, body: csvForm() as never }));
      await expectUnavailable(res);
      expect(await usedToday(user.id)).toBe(0);
      expect(server.objects.size).toBe(0);
    });

    it('answers an asynchronous hand-off that the store refuses with 503 and does not charge the quota', async () => {
      const { user, cookie } = await loadUser('convasync');
      failStore((req) => req.method === 'POST' && req.query.has('uploads'), 403, 'AccessDenied');
      const { POST } = await import('../src/app/api/v1/convert/route');
      const res = await POST(
        new NextRequest(`${BASE_URL}/api/v1/convert`, { method: 'POST', headers: { ...cookie, Prefer: 'respond-async' }, body: csvForm() as never })
      );
      await expectUnavailable(res);
      expect(await usedToday(user.id)).toBe(0);
    });

    it('still charges the quota once for a conversion whose result was stored', async () => {
      const { user, cookie } = await loadUser('convok');
      const { POST } = await import('../src/app/api/v1/convert/route');
      const res = await POST(new NextRequest(`${BASE_URL}/api/v1/convert`, { method: 'POST', headers: cookie, body: csvForm() as never }));
      expect(res.status).toBe(HTTP_OK);
      expect(await usedToday(user.id)).toBe(1);
      expect([...server.objects.keys()]).toEqual([expect.stringMatching(new RegExp(`^conversions/${user.id}/\\d+_scores\\.json$`))]);
    });

    it('answers an archive inspection whose stored object cannot be read with 503', async () => {
      const { user, cookie } = await loadUser('inspect503');
      const storage = await import('../src/lib/storage');
      const key = `conversions/${user.id}/a.zip`;
      await storage.storageProvider.saveObject(key, Buffer.from('PK'), 'application/zip', 'a.zip', 3_600_000);
      failStore((req) => req.method === 'HEAD' || req.method === 'GET', 503, 'SlowDown');
      const { POST } = await import('../src/app/api/v1/archives/inspect/route');
      await expectUnavailable(await POST(jsonPost('/api/v1/archives/inspect', cookie, { storageKey: key })));
    });

    it('answers an abort that the store refuses with 503', async () => {
      const { cookie } = await loadUser('abort503');
      const { POST: initiate } = await import('../src/app/api/v1/uploads/direct/route');
      const init = await (
        await initiate(jsonPost('/api/v1/uploads/direct', cookie, { filename: 'doc.pdf', totalSize: PDF.length, mimeType: 'application/pdf' }))
      ).json();
      failStore((req) => req.method === 'DELETE', 503, 'SlowDown');
      const { DELETE } = await import('../src/app/api/v1/uploads/direct/[id]/route');
      const res = await DELETE(
        new NextRequest(`${BASE_URL}/api/v1/uploads/direct/${init.uploadId}`, { method: 'DELETE', headers: cookie }),
        { params: Promise.resolve({ id: init.uploadId }) }
      );
      await expectUnavailable(res);
    });
  });

  describe('archive inspection by storage key', () => {
    async function zipBytes(): Promise<Buffer> {
      const { createZipArchive } = await import('../src/lib/conversions');
      return (await createZipArchive([{ filename: 'inside.txt', buffer: Buffer.from('hello') }])).buffer;
    }

    it('inspects an archive the caller owns', async () => {
      const { user, cookie } = await loadUser('inspectown');
      const storage = await import('../src/lib/storage');
      const key = `conversions/${user.id}/mine.zip`;
      await storage.storageProvider.saveObject(key, await zipBytes(), 'application/zip', 'mine.zip', 3_600_000);
      const { POST } = await import('../src/app/api/v1/archives/inspect/route');
      const res = await POST(jsonPost('/api/v1/archives/inspect', cookie, { storageKey: key }));
      expect(res.status).toBe(HTTP_OK);
      expect((await res.json()).entries.map((entry: { name: string }) => entry.name)).toEqual(['inside.txt']);
    });

    it('answers another user\'s conversion, an ownerless upload and an unresolvable job result like a missing object and never reads them', async () => {
      const owner = await loadUser('inspectowner');
      const stranger = await loadUser('inspectstranger');
      const storage = await import('../src/lib/storage');
      const bytes = await zipBytes();
      const keys = [
        `conversions/${owner.user.id}/secret.zip`,
        `uploads/${Date.now()}_public.zip`,
        'results/00000000-dead-beef-0000-000000000000/out.zip',
      ];
      for (const key of keys) await storage.storageProvider.saveObject(key, bytes, 'application/zip', 'x.zip', 3_600_000);
      server.requests.length = 0;
      const { POST } = await import('../src/app/api/v1/archives/inspect/route');
      for (const key of keys) {
        const res = await POST(jsonPost('/api/v1/archives/inspect', stranger.cookie, { storageKey: key }));
        expect(res.status).toBe(HTTP_NOT_FOUND);
        expect((await res.json()).detail).toBe('Storage object not found.');
      }
      expect(server.requests.filter((req) => req.method === 'GET' || req.method === 'HEAD')).toEqual([]);
    });
  });

  describe('multipart complete', () => {
    const multipart = async (cookie: Record<string, string>, action: string, body: unknown) => {
      const { POST } = await import('../src/app/api/storage/multipart/route');
      return POST(jsonPost(`/api/storage/multipart?action=${action}`, cookie, body));
    };

    it('deletes an object that grew past the tier cap between the size check and the completion', async () => {
      const { cookie } = await loadUser('race', 'free');
      const init = await (await multipart(cookie, 'initiate', { filename: 'grow.bin', totalSize: 10 })).json();
      const { POST } = await import('../src/app/api/storage/multipart/route');
      const chunk = await POST(
        new NextRequest(`${BASE_URL}/api/storage/multipart?action=chunk&uploadId=${encodeURIComponent(init.uploadId)}&partNumber=1`, {
          method: 'POST',
          headers: cookie,
          body: Buffer.from('0123456789'),
          duplex: 'half',
        } as never)
      );
      expect(chunk.status).toBe(HTTP_OK);

      // A second part appears after the route has listed the session and before the backend lists it again.
      let listings = 0;
      server.faults.push({
        match: (req) => {
          if (req.method === 'GET' && req.query.has('uploadId')) {
            listings += 1;
            if (listings === 2) server.uploads.get(req.query.get('uploadId') as string)?.set(2, Buffer.alloc(FREE_TIER_CAP_BYTES + 1));
          }
          return false;
        },
        status: 500,
        times: Infinity,
      });

      const res = await multipart(cookie, 'complete', { uploadId: init.uploadId });
      expect(res.status).toBe(HTTP_BAD_REQUEST);
      expect((await res.json()).detail).toBe(
        `Completed upload size ${FREE_TIER_CAP_BYTES + 1 + 10} bytes exceeds maximum allowed upload size of ${FREE_TIER_CAP_BYTES} bytes for tier 'free'.`
      );
      expect(listings).toBe(2);
      expect(server.objects.size).toBe(0);
    });

    it('lets a download-sized upload within the cap complete', async () => {
      const { cookie } = await loadUser('within');
      const init = await (await multipart(cookie, 'initiate', { filename: 'ok.bin', totalSize: 4 })).json();
      const { POST } = await import('../src/app/api/storage/multipart/route');
      await POST(
        new NextRequest(`${BASE_URL}/api/storage/multipart?action=chunk&uploadId=${encodeURIComponent(init.uploadId)}&partNumber=1`, {
          method: 'POST',
          headers: cookie,
          body: Buffer.from('abcd'),
          duplex: 'half',
        } as never)
      );
      const res = await multipart(cookie, 'complete', { uploadId: init.uploadId });
      expect(res.status).toBe(HTTP_OK);
      expect(server.objects.get(init.key)?.body.toString()).toBe('abcd');
    });

    it('caps the expiry of a presigned part URL at the part window, whatever was asked for', async () => {
      const { cookie } = await loadUser('ttl');
      const init = await (await multipart(cookie, 'initiate', { filename: 'ttl.bin', totalSize: 4 })).json();
      const asked = async (expiresInSeconds?: number) => {
        const res = await multipart(cookie, 'presign', {
          type: 'upload',
          key: init.key,
          uploadId: init.uploadId,
          partNumber: 1,
          ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
        });
        expect(res.status).toBe(HTTP_OK);
        return new URL((await res.json()).url).searchParams.get('X-Amz-Expires');
      };
      expect(await asked(SEVEN_DAYS_SECONDS)).toBe(String(PART_URL_WINDOW_SECONDS));
      expect(await asked()).toBe(String(PART_URL_WINDOW_SECONDS));
      expect(await asked(60)).toBe('60');
    });

    it('answers a presign for a key the session does not own with 400 rather than 500', async () => {
      const { cookie, user } = await loadUser('wrongkey');
      const init = await (await multipart(cookie, 'initiate', { filename: 'k.bin', totalSize: 4 })).json();
      const res = await multipart(cookie, 'presign', {
        type: 'upload',
        key: `conversions/${user.id}/another-name.bin`,
        uploadId: init.uploadId,
        partNumber: 1,
      });
      expect(res.status).toBe(HTTP_BAD_REQUEST);
      expect((await res.json()).detail).toBe('Key does not belong to this multipart upload session.');
    });

    it('answers a complete of a session with no uploaded part with 400 rather than 500', async () => {
      const { cookie } = await loadUser('emptysession');
      const init = await (await multipart(cookie, 'initiate', { filename: 'e.bin', totalSize: 4 })).json();
      const res = await multipart(cookie, 'complete', { uploadId: init.uploadId });
      expect(res.status).toBe(HTTP_BAD_REQUEST);
      expect((await res.json()).detail).toBe(`Cannot complete empty multipart upload session: ${init.uploadId}`);
    });
  });

  describe('upload sessions without an owner', () => {
    /** A session opened by server-side code with no user, as the job routes do. */
    async function ownerlessSession() {
      const storage = await import('../src/lib/storage');
      const init = await storage.storageProvider.initiateMultipartUpload('doc.pdf', 'application/pdf', PDF.length);
      const part = await storage.storageProvider.uploadPart(init.uploadId, 1, PDF);
      return { init, part };
    }

    it('is not completable through the direct complete route by a user', async () => {
      const { cookie } = await loadUser('direct');
      const { init, part } = await ownerlessSession();
      const { POST } = await import('../src/app/api/v1/uploads/direct/complete/route');
      const res = await POST(jsonPost('/api/v1/uploads/direct/complete', cookie, { uploadId: init.uploadId, parts: [{ partNumber: 1, etag: part.etag }] }));
      expect(res.status).toBe(HTTP_NOT_FOUND);
      expect(server.objects.size).toBe(0);
    });

    it('is not completable through the uploads action route by a user', async () => {
      const { cookie } = await loadUser('action');
      const { init, part } = await ownerlessSession();
      const { POST } = await import('../src/app/api/v1/uploads/[[...id]]/route');
      const res = await POST(
        jsonPost('/api/v1/uploads?action=complete', cookie, { uploadId: init.uploadId, parts: [{ partNumber: 1, etag: part.etag }] }),
        { params: Promise.resolve({}) }
      );
      expect(res.status).toBe(HTTP_NOT_FOUND);
      expect(server.objects.size).toBe(0);
    });

    it('is not abortable through the direct abort route by a user', async () => {
      const { cookie } = await loadUser('abortless');
      const { init } = await ownerlessSession();
      const { DELETE } = await import('../src/app/api/v1/uploads/direct/[id]/route');
      const res = await DELETE(
        new NextRequest(`${BASE_URL}/api/v1/uploads/direct/${init.uploadId}`, { method: 'DELETE', headers: cookie }),
        { params: Promise.resolve({ id: init.uploadId }) }
      );
      expect(res.status).toBe(HTTP_NOT_FOUND);
      expect(server.uploads.size).toBe(1);
    });
  });
});
