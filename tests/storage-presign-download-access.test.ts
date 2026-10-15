import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { startS3StubServer, type S3StubServer } from './helpers/s3-stub-server';

/**
 * POST /api/storage/multipart?action=presign for downloads: a signed URL is the object, so it is
 * issued only when the caller provably owns the key, and it lives no longer than the download
 * window. Ownerless and unresolvable keys are refused like missing objects.
 */

const BUCKET = 'internal-objects';
const REGION = 'ap-seoul-1';
const ACCESS_KEY = 'AKIAOCIEXAMPLE0000001';
const SECRET = 'oci/Secret+Key/EXAMPLEKEY000000000000000';
const BASE_URL = 'http://localhost:3000';
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const DOWNLOAD_WINDOW_SECONDS = 900;
const SEVEN_DAYS_SECONDS = 604_800;
const TEST_TIMEOUT_MS = 30_000;
vi.setConfig({ testTimeout: TEST_TIMEOUT_MS });

describe('presigned download URLs are issued to the owner only', () => {
  let server: S3StubServer;

  beforeAll(async () => {
    server = await startS3StubServer({ bucket: BUCKET, credentials: { [ACCESS_KEY]: SECRET } });
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.objects.clear();
    server.requests.length = 0;
    vi.stubEnv('STORAGE_DRIVER', 'oci');
    vi.stubEnv('OCI_NAMESPACE', 'axyz123namespace');
    vi.stubEnv('OCI_REGION', REGION);
    vi.stubEnv('OCI_BUCKET', BUCKET);
    vi.stubEnv('OCI_ACCESS_KEY_ID', ACCESS_KEY);
    vi.stubEnv('OCI_SECRET_ACCESS_KEY', SECRET);
    vi.stubEnv('OCI_ENDPOINT', server.url);
    vi.stubEnv('STORAGE_SIGNING_SECRET', 'presign-access-test-signing-secret-01');
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
    const email = `${tag}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@presign-access.local`;
    const user = userStore.sanitizeUser(await userStore.createUser({ email, name: tag, tier: 'pro' }));
    return { user, cookie: { Cookie: `easyconvert_session=${createSessionToken(user)}` } };
  }

  async function presignDownload(cookie: Record<string, string>, body: Record<string, unknown>) {
    const { POST } = await import('../src/app/api/storage/multipart/route');
    return POST(
      new NextRequest(`${BASE_URL}/api/storage/multipart?action=presign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie },
        body: JSON.stringify({ type: 'download', ...body }),
      })
    );
  }

  it('refuses a job result whose owner cannot be proven because the job record is missing', async () => {
    const { cookie } = await loadUser('unresolved');
    const key = 'results/00000000-dead-beef-0000-000000000000/secret.pdf';
    const res = await presignDownload(cookie, { key });
    expect(res.status).toBe(HTTP_NOT_FOUND);
    expect((await res.json()).detail).toBe('Storage object not found.');
    expect(server.requests).toEqual([]);
  });

  it('refuses another user\'s conversion, an ownerless upload and an unclassified key alike', async () => {
    const owner = await loadUser('owner');
    const stranger = await loadUser('stranger');
    for (const key of [`conversions/${owner.user.id}/x.pdf`, 'uploads/1700000000000_scores.csv', 'misc/anything.bin']) {
      const res = await presignDownload(stranger.cookie, { key });
      expect(res.status).toBe(HTTP_NOT_FOUND);
      expect((await res.json()).detail).toBe('Storage object not found.');
    }
  });

  it('presigns the owner\'s own conversion for the download window when no expiry is asked for', async () => {
    const { user, cookie } = await loadUser('mine');
    const key = `conversions/${user.id}/mine.pdf`;
    const res = await presignDownload(cookie, { key });
    expect(res.status).toBe(HTTP_OK);
    const url = new URL((await res.json()).url);
    expect(url.pathname).toBe(`/${BUCKET}/${key}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(DOWNLOAD_WINDOW_SECONDS));
  });

  it('caps a longer requested expiry at the download window and keeps a shorter one', async () => {
    const { user, cookie } = await loadUser('expiry');
    const key = `conversions/${user.id}/expiry.pdf`;
    const capped = new URL((await (await presignDownload(cookie, { key, expiresInSeconds: SEVEN_DAYS_SECONDS })).json()).url);
    expect(capped.searchParams.get('X-Amz-Expires')).toBe(String(DOWNLOAD_WINDOW_SECONDS));
    const shorter = new URL((await (await presignDownload(cookie, { key, expiresInSeconds: 60 })).json()).url);
    expect(shorter.searchParams.get('X-Amz-Expires')).toBe('60');
  });

  it('presigns a finished job result for the user who submitted the job', async () => {
    const { user, cookie } = await loadUser('jobowner');
    const { conversionQueue } = await import('../src/lib/queue/conversion-queue');
    const job = await conversionQueue.add(
      'convert',
      { jobId: 'j', userId: user.id, sourceFormat: 'csv', targetFormat: 'json', originalFilename: 'a.csv', fileSize: 1, options: {} } as never
    );
    const key = `results/${job.id}/a.json`;
    const res = await presignDownload(cookie, { key });
    expect(res.status).toBe(HTTP_OK);
    expect(new URL((await res.json()).url).pathname).toBe(`/${BUCKET}/${key}`);

    const stranger = await loadUser('jobstranger');
    expect((await presignDownload(stranger.cookie, { key })).status).toBe(HTTP_NOT_FOUND);
  });
});
