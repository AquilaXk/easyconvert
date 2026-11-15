import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import * as storageFileRoute from '../src/app/api/storage/file/[...key]/route';
import { conversionQueue } from '../src/lib/queue/conversion-queue';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import { storageProvider } from '../src/lib/storage';
import { saveRetainedResult, eraseOwnedFile, resultAvailability } from '../src/lib/storage/retention-service';
import { releaseStoredResultUrl } from '../src/hooks/useClientQueue';

const ORIGIN = 'http://localhost:3000';

describe('immediate server-side deletion of stored outputs (anonymous and signed-in)', () => {
  const cleanupKeys: string[] = [];

  beforeEach(() => {
    redisKeyStore.resetStore();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const key of cleanupKeys.splice(0)) {
      await eraseOwnedFile(storageProvider, key).catch(() => undefined);
    }
  });

  it('allows an anonymous caller holding the capability URL to DELETE a completed job output immediately, after which GET is 404/410', async () => {
    const jobId = `job_anon_${crypto.randomUUID()}`;
    const key = `results/${jobId}/converted.webp`;
    cleanupKeys.push(key);

    await saveRetainedResult(storageProvider, key, Buffer.from('RIFF....WEBPVP8 '), 'image/webp', 'converted.webp');
    vi.spyOn(conversionQueue, 'getJob').mockImplementation(async (id: string) =>
      id === jobId ? ({ id: jobId, data: { userId: 'anon:203.0.113.10' } } as never) : null
    );

    const getBefore = await storageFileRoute.GET(
      new NextRequest(`${ORIGIN}/api/storage/file/${key}`, { method: 'GET' }),
      { params: Promise.resolve({ key: key.split('/') }) }
    );
    expect(getBefore.status).toBe(200);

    const del = (storageFileRoute as Record<string, unknown>).DELETE as typeof storageFileRoute.GET | undefined;
    expect(typeof del).toBe('function');
    const delRes = await del!(
      new NextRequest(`${ORIGIN}/api/storage/file/${key}`, { method: 'DELETE', headers: { Origin: ORIGIN } }),
      { params: Promise.resolve({ key: key.split('/') }) }
    );
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toMatchObject({ success: true });
    expect(await storageProvider.stat(key)).toBeNull();
    expect(await resultAvailability(key)).toBeUndefined();

    const getAfter = await storageFileRoute.GET(
      new NextRequest(`${ORIGIN}/api/storage/file/${key}`, { method: 'GET' }),
      { params: Promise.resolve({ key: key.split('/') }) }
    );
    expect(getAfter.status).toBe(404);
  });

  it('allows the signed-in owner to DELETE their stored conversion output and removes its file-history entry, while refusing non-owners with 404', async () => {
    const owner = userStore.sanitizeUser(
      await userStore.createUser({ email: `owner_${crypto.randomUUID()}@delete.test`, name: 'Owner', tier: 'free', emailVerified: true })
    );
    const stranger = userStore.sanitizeUser(
      await userStore.createUser({ email: `stranger_${crypto.randomUUID()}@delete.test`, name: 'Stranger', tier: 'free', emailVerified: true })
    );
    const key = `conversions/${owner.id}/1700000000_report.pdf`;
    cleanupKeys.push(key);

    await saveRetainedResult(storageProvider, key, Buffer.from('%PDF-1.7 test'), 'application/pdf', 'report.pdf');
    await redisKeyStore.recordUserFile({
      userId: owner.id,
      fileName: 'report.pdf',
      fromFormat: 'docx',
      toFormat: 'pdf',
      size: 13,
      downloadUrl: `/api/storage/file/${key}`,
      storageKey: key,
    });
    expect(await redisKeyStore.listUserFiles(owner.id)).toHaveLength(1);

    const del = (storageFileRoute as Record<string, unknown>).DELETE as typeof storageFileRoute.GET;
    const anonAttempt = await del(
      new NextRequest(`${ORIGIN}/api/storage/file/${key}`, { method: 'DELETE', headers: { Origin: ORIGIN } }),
      { params: Promise.resolve({ key: key.split('/') }) }
    );
    expect(anonAttempt.status).toBe(404);
    expect(await storageProvider.stat(key)).not.toBeNull();

    const strangerAttempt = await del(
      new NextRequest(`${ORIGIN}/api/storage/file/${key}`, {
        method: 'DELETE',
        headers: { Origin: ORIGIN, Cookie: `easyconvert_session=${createSessionToken(stranger)}` },
      }),
      { params: Promise.resolve({ key: key.split('/') }) }
    );
    expect(strangerAttempt.status).toBe(404);
    expect(await storageProvider.stat(key)).not.toBeNull();

    const ownerAttempt = await del(
      new NextRequest(`${ORIGIN}/api/storage/file/${key}`, {
        method: 'DELETE',
        headers: { Origin: ORIGIN, Cookie: `easyconvert_session=${createSessionToken(owner)}` },
      }),
      { params: Promise.resolve({ key: key.split('/') }) }
    );
    expect(ownerAttempt.status).toBe(200);
    expect(await storageProvider.stat(key)).toBeNull();
    expect(await redisKeyStore.listUserFiles(owner.id)).toHaveLength(0);
  });

  it('refuses unknown namespaces and path traversal on DELETE with 404', async () => {
    const del = (storageFileRoute as Record<string, unknown>).DELETE as typeof storageFileRoute.GET;
    for (const bad of ['internal/secret.txt', 'results/../etc/passwd']) {
      const res = await del(
        new NextRequest(`${ORIGIN}/api/storage/file/${bad}`, { method: 'DELETE', headers: { Origin: ORIGIN } }),
        { params: Promise.resolve({ key: bad.split('/') }) }
      );
      expect(res.status).toBe(404);
    }
  });

  it('dispatches keepalive DELETE from useClientQueue when releasing a server-stored resultUrl and ignores blob URLs', () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    releaseStoredResultUrl(undefined);
    releaseStoredResultUrl('blob:http://localhost:3000/abc-123');
    expect(fetchSpy).not.toHaveBeenCalled();

    releaseStoredResultUrl('/api/storage/file/results/job_123/out.webp');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('/api/storage/file/results/job_123/out.webp', {
      method: 'DELETE',
      keepalive: true,
    });
  });
});
