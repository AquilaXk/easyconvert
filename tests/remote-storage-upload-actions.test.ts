import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { startS3StubServer, type S3StubServer } from './helpers/s3-stub-server';

/**
 * The `?action=` multipart flow of /api/v1/uploads against an object store. Parts go straight to
 * the store, past this application, so the session must carry the declared size: part URLs exist
 * only for the declared parts, the assembled object must be exactly the declared size, and the key
 * is unique per upload and user.
 */

const BUCKET = 'internal-objects';
const REGION = 'ap-seoul-1';
const ACCESS_KEY = 'AKIAOCIEXAMPLE0000001';
const SECRET = 'oci/Secret+Key/EXAMPLEKEY000000000000000';
const BASE_URL = 'http://localhost:3000';
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const PART_URL_WINDOW_SECONDS = 900;
const MIB = 1024 * 1024;
const MIN_PART_BYTES = 5 * MIB;
const TEST_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: TEST_TIMEOUT_MS });

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');

describe('/api/v1/uploads multipart actions bind a session to its declared size', () => {
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
    vi.stubEnv('STORAGE_SIGNING_SECRET', 'upload-actions-test-signing-secret-01');
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
    const email = `${tag}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@upload-actions.local`;
    const user = userStore.sanitizeUser(await userStore.createUser({ email, name: tag, tier: 'pro' }));
    return { user, cookie: { Cookie: `easyconvert_session=${createSessionToken(user)}` } };
  }

  async function action(cookie: Record<string, string>, name: 'initiate' | 'complete' | 'abort', body: Record<string, unknown>) {
    const { POST } = await import('../src/app/api/v1/uploads/[[...id]]/route');
    return POST(
      new NextRequest(`${BASE_URL}/api/v1/uploads?action=${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({}) }
    );
  }

  const initiate = (cookie: Record<string, string>, body: Record<string, unknown>) => action(cookie, 'initiate', body);

  it('derives the part URLs from the declared size and gives them the short part window', async () => {
    const { cookie } = await loadUser('parts');
    const body = await (await initiate(cookie, { filename: 'big.bin', totalSize: MIN_PART_BYTES * 2 + 1, partSize: MIN_PART_BYTES })).json();
    expect(body.totalParts).toBe(3);
    expect(body.presignedUrls).toHaveLength(3);
    const urls = body.presignedUrls.map((entry: { url: string }) => new URL(entry.url));
    expect(urls.map((url: URL) => url.searchParams.get('partNumber'))).toEqual(['1', '2', '3']);
    for (const url of urls) {
      expect(url.searchParams.get('X-Amz-Expires')).toBe(String(PART_URL_WINDOW_SECONDS));
      expect(url.searchParams.get('uploadId')).not.toBeNull();
    }
  });

  it('gives each upload its own key, including the same filename from two users and from one user twice', async () => {
    const a = await loadUser('keysa');
    const b = await loadUser('keysb');
    const first = await (await initiate(a.cookie, { filename: 'report.pdf', totalSize: PDF.length })).json();
    const second = await (await initiate(a.cookie, { filename: 'report.pdf', totalSize: PDF.length })).json();
    const other = await (await initiate(b.cookie, { filename: 'report.pdf', totalSize: PDF.length })).json();
    expect(first.key).toMatch(new RegExp(`^conversions/${a.user.id}/\\d+_[0-9a-f]{16}_report\\.pdf$`));
    expect(new Set([first.key, second.key, other.key]).size).toBe(3);
  });

  it('refuses a complete whose assembled object is larger than the declared size, and deletes it', async () => {
    const { cookie } = await loadUser('oversize');
    const init = await (await initiate(cookie, { filename: 'doc.pdf', totalSize: PDF.length - 10 })).json();
    const put = await fetch(init.presignedUrls[0].url, { method: 'PUT', body: PDF });
    expect(put.status).toBe(HTTP_OK);
    const res = await action(cookie, 'complete', {
      uploadId: init.uploadId,
      key: init.key,
      parts: [{ partNumber: 1, etag: put.headers.get('etag') }],
    });
    expect(res.status).toBe(HTTP_BAD_REQUEST);
    expect((await res.json()).detail).toContain(`does not match the declared totalSize ${PDF.length - 10} bytes`);
    expect(server.objects.has(init.key)).toBe(false);
  });

  it('checks against the declared size even when the client sends a different expectedSize', async () => {
    const { cookie } = await loadUser('expected');
    const init = await (await initiate(cookie, { filename: 'doc.pdf', totalSize: PDF.length - 10 })).json();
    const put = await fetch(init.presignedUrls[0].url, { method: 'PUT', body: PDF });
    const res = await action(cookie, 'complete', {
      uploadId: init.uploadId,
      key: init.key,
      parts: [{ partNumber: 1, etag: put.headers.get('etag') }],
      expectedSize: PDF.length,
    });
    expect(res.status).toBe(HTTP_BAD_REQUEST);
    expect(server.objects.has(init.key)).toBe(false);
  });

  it('completes an upload of exactly the declared size', async () => {
    const { cookie } = await loadUser('exact');
    const init = await (await initiate(cookie, { filename: 'doc.pdf', mimeType: 'application/pdf', totalSize: PDF.length })).json();
    const put = await fetch(init.presignedUrls[0].url, { method: 'PUT', body: PDF });
    const res = await action(cookie, 'complete', { uploadId: init.uploadId, parts: [{ partNumber: 1, etag: put.headers.get('etag') }] });
    expect(res.status).toBe(HTTP_OK);
    const done = await res.json();
    expect(done).toMatchObject({ key: init.key, size: PDF.length });
    expect(server.objects.get(init.key)?.body.equals(PDF)).toBe(true);
  });

  it('answers a complete that names a different key than the session with a 400', async () => {
    const { cookie, user } = await loadUser('wrongkey');
    const init = await (await initiate(cookie, { filename: 'doc.pdf', totalSize: PDF.length })).json();
    const put = await fetch(init.presignedUrls[0].url, { method: 'PUT', body: PDF });
    const res = await action(cookie, 'complete', {
      uploadId: init.uploadId,
      key: `conversions/${user.id}/someone-elses-name.pdf`,
      parts: [{ partNumber: 1, etag: put.headers.get('etag') }],
    });
    expect(res.status).toBe(HTTP_BAD_REQUEST);
    expect(server.objects.size).toBe(0);
  });

  it('hides a session from other users on complete and abort', async () => {
    const owner = await loadUser('sessowner');
    const stranger = await loadUser('sessstranger');
    const init = await (await initiate(owner.cookie, { filename: 'doc.pdf', totalSize: PDF.length })).json();
    const put = await fetch(init.presignedUrls[0].url, { method: 'PUT', body: PDF });
    const parts = [{ partNumber: 1, etag: put.headers.get('etag') }];

    expect((await action(stranger.cookie, 'complete', { uploadId: init.uploadId, parts })).status).toBe(HTTP_NOT_FOUND);
    expect((await action(stranger.cookie, 'abort', { uploadId: init.uploadId })).status).toBe(HTTP_NOT_FOUND);
    expect(server.uploads.size).toBe(1);

    const aborted = await action(owner.cookie, 'abort', { uploadId: init.uploadId });
    expect(aborted.status).toBe(HTTP_OK);
    expect(await aborted.json()).toMatchObject({ success: true, aborted: true });
    expect(server.uploads.size).toBe(0);
  });

  it('refuses a forged or foreign upload id', async () => {
    const { cookie } = await loadUser('forged');
    const res = await action(cookie, 'complete', { uploadId: 'v1.e30.AAAA', key: 'uploads/x.bin', parts: [{ partNumber: 1, etag: 'x' }] });
    expect(res.status).toBe(HTTP_NOT_FOUND);
  });

  it('refuses to presign a part beyond the declared parts through the multipart route', async () => {
    const { cookie } = await loadUser('beyond');
    const init = await (await initiate(cookie, { filename: 'doc.pdf', totalSize: PDF.length })).json();
    const { POST } = await import('../src/app/api/storage/multipart/route');
    const presign = (partNumber: number) =>
      POST(
        new NextRequest(`${BASE_URL}/api/storage/multipart?action=presign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...cookie },
          body: JSON.stringify({ type: 'upload', key: init.key, uploadId: init.uploadId, partNumber }),
        })
      );
    expect((await presign(1)).status).toBe(HTTP_OK);
    for (const partNumber of [2, 0, 10_000]) {
      const res = await presign(partNumber);
      expect(res.status).toBe(HTTP_BAD_REQUEST);
      expect((await res.json()).detail).toContain('declared');
    }
  });
});
