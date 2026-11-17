import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationError, parseConfig } from '../src/lib/config';
import {
  parseHostPortEndpoints,
  resolveRedisMode,
} from '../src/lib/redis/client-factory';
import {
  resetLocalSweepLocksForTests,
  withRedisLeaderLock,
} from '../src/lib/redis/leader-lock';
import {
  hasLiveQueueWorker,
  isQueueOnlyWebMode,
  registerLiveWorkerHeartbeat,
  resetLocalLiveWorkersForTests,
  unregisterLiveWorkerHeartbeat,
} from '../src/lib/queue/worker-presence';
import {
  startConversionWorker,
  stopConversionWorker,
} from '../src/lib/queue/conversion-queue';
import { dispatchSyncRouteConversion } from '../src/lib/queue/wait-for-job';
import {
  TUS_REMOTE_PART_BYTES,
  TusEngine,
  setTusSessionStore,
  type TusSession,
  type TusSessionStore,
} from '../src/lib/storage/tus-engine';
import * as selectedStorage from '../src/lib/storage/selected-storage';
import { executeResumableCloudConversion, type ResumableTiming } from '../src/lib/edge/pipelines/resumable-cloud-pipeline';
import { POST as postToolJob } from '../src/app/api/tools/jobs/route';
import { GET as getToolJobRoute, DELETE as deleteToolJobRoute } from '../src/app/api/tools/jobs/[id]/route';
import { typedFailureOf } from '../src/lib/types';

class SharedMemoryTusStore implements TusSessionStore {
  private readonly sessions = new Map<string, TusSession>();
  private readonly tails = new Map<string, Buffer>();

  async saveSession(session: TusSession): Promise<void> {
    this.sessions.set(session.id, structuredClone(session));
  }

  async getSession(id: string): Promise<TusSession | null> {
    const found = this.sessions.get(id);
    return found ? structuredClone(found) : null;
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.sessions.delete(id);
  }

  async syncStagedBytes(id: string, binPath: string, _prev: number, newOffset: number): Promise<void> {
    const bytes = await fs.promises.readFile(binPath);
    this.tails.set(id, Buffer.from(bytes.subarray(0, newOffset)));
  }

  async replaceStagedTailBytes(id: string, tail: Buffer): Promise<void> {
    this.tails.set(id, Buffer.from(tail));
  }

  async hydrateStagedFile(id: string, binPath: string, expectedOffset: number): Promise<number> {
    const tail = this.tails.get(id);
    if (!tail || tail.length < expectedOffset) return tail?.length ?? 0;
    await fs.promises.mkdir(path.dirname(binPath), { recursive: true });
    const slice = tail.subarray(0, expectedOffset);
    await fs.promises.writeFile(binPath, slice);
    return slice.length;
  }

  async deleteStagedBytes(id: string): Promise<void> {
    this.tails.delete(id);
  }

  stagedByteCount(id: string): number {
    return this.tails.get(id)?.length ?? 0;
  }
}

describe('Scale-Out Web control plane, S3-native TUS, leader locks, and Redis HA config', () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    setTusSessionStore(null);
    resetLocalSweepLocksForTests();
    resetLocalLiveWorkersForTests();
    await stopConversionWorker();
  });

  it('validates Redis standalone, sentinel, and cluster configuration fail-closed', () => {
    expect(parseHostPortEndpoints('sentinel-a:26379, [::1]:26380', 'REDIS_SENTINELS')).toEqual([
      { host: 'sentinel-a', port: 26379 },
      { host: '::1', port: 26380 },
    ]);
    expect(() => parseHostPortEndpoints('bad-endpoint', 'REDIS_SENTINELS')).toThrow(/Invalid endpoint/);
    expect(resolveRedisMode({ REDIS_MODE: 'sentinel' })).toBe('sentinel');
    expect(resolveRedisMode({ REDIS_MODE: 'cluster' })).toBe('cluster');

    expect(() => parseConfig({ REDIS_MODE: 'sentinel', REDIS_SENTINELS: '127.0.0.1:26379' })).toThrow(
      ConfigurationError
    );
    expect(() => parseConfig({ REDIS_MODE: 'cluster' })).toThrow(ConfigurationError);
    expect(() => parseConfig({ REDIS_MODE: 'standalone', REDIS_CLUSTER_NODES: '127.0.0.1:6379' })).toThrow(
      ConfigurationError
    );

    const validSentinel = parseConfig({
      REDIS_MODE: 'sentinel',
      REDIS_SENTINELS: '10.0.0.1:26379,10.0.0.2:26379',
      REDIS_SENTINEL_NAME: 'mymaster',
      WEB_EXECUTION_MODE: 'queue-only',
    });
    expect(validSentinel.REDIS_MODE).toBe('sentinel');
    expect(validSentinel.WEB_EXECUTION_MODE).toBe('queue-only');
  });

  it('elects a single sweep leader during holdAfterSuccessMs and releases immediately on error', async () => {
    let executions = 0;
    const [r1, r2] = await Promise.all([
      withRedisLeaderLock('test-sweep', 5000, 5000, async () => {
        executions += 1;
        await new Promise((r) => setTimeout(r, 20));
      }),
      withRedisLeaderLock('test-sweep', 5000, 5000, async () => {
        executions += 1;
      }),
    ]);
    expect([r1, r2].sort()).toEqual([false, true]);
    expect(executions).toBe(1);

    // Still held during post-completion hold window.
    const skipped = await withRedisLeaderLock('test-sweep', 5000, 5000, async () => {
      executions += 1;
    });
    expect(skipped).toBe(false);
    expect(executions).toBe(1);

    // A failing leader releases its lock immediately so the next replica can retry.
    await expect(
      withRedisLeaderLock('failing-sweep', 5000, 5000, async () => {
        throw new Error('transient sweep error');
      })
    ).rejects.toThrow('transient sweep error');

    let recovered = false;
    const retried = await withRedisLeaderLock('failing-sweep', 5000, 5000, async () => {
      recovered = true;
    });
    expect(retried).toBe(true);
    expect(recovered).toBe(true);
  });

  it('enforces queue-only fail-closed 503 without a worker and executes through the queue once a worker is live', async () => {
    vi.stubEnv('WEB_EXECUTION_MODE', 'queue-only');
    expect(isQueueOnlyWebMode()).toBe(true);
    expect(await hasLiveQueueWorker()).toBe(false);

    const png1x1 = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );

    const noWorkerErr = await dispatchSyncRouteConversion({
      inputBuffer: png1x1,
      sourceFormat: 'png',
      targetFormat: 'bmp',
      options: {},
      originalFilename: 'pixel.png',
      userId: 'anon_scale_test',
      tier: 'free',
    }).catch((err: unknown) => err);
    expect((noWorkerErr as Error)?.name).toBe('QueueUnavailableError');
    expect(typedFailureOf(noWorkerErr)?.status).toBe(503);

    startConversionWorker({ concurrency: 2 });
    expect(await hasLiveQueueWorker()).toBe(true);

    const converted = await dispatchSyncRouteConversion({
      inputBuffer: png1x1,
      sourceFormat: 'png',
      targetFormat: 'bmp',
      options: {},
      originalFilename: 'pixel.png',
      userId: 'anon_scale_test',
      tier: 'free',
    });
    expect(converted.buffer.subarray(0, 2).toString('latin1')).toBe('BM');
    expect(converted.size).toBeGreaterThan(26);
  });

  it('dispatches /api/tools/jobs to the worker queue when a worker is live and supports DELETE cancellation', async () => {
    await registerLiveWorkerHeartbeat('test-worker-1');
    startConversionWorker({ concurrency: 2 });

    const form = new FormData();
    form.set('tool', 'archive-create');
    form.set('options', JSON.stringify({ format: 'zip' }));
    form.append('files', new File([Buffer.from('hello scale-out queue')], 'note.txt', { type: 'text/plain' }));

    const postReq = new NextRequest('http://localhost:3000/api/tools/jobs', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.77' },
      body: form,
    });
    const postRes = await postToolJob(postReq);
    expect(postRes.status).toBe(201);
    const created = (await postRes.json()) as { id: string; status: string };
    expect(created.status).toBe('queued');

    await vi.waitFor(async () => {
      const pollReq = new NextRequest(`http://localhost:3000/api/tools/jobs/${created.id}`, {
        method: 'GET',
        headers: { 'x-forwarded-for': '203.0.113.77' },
      });
      const pollRes = await getToolJobRoute(pollReq, { params: Promise.resolve({ id: created.id }) });
      const body = (await pollRes.json()) as { status: string; result?: { size: number } };
      expect(body.status).toBe('completed');
      expect(body.result?.size).toBeGreaterThan(20);
    }, { timeout: 10_000 });

    const delReq = new NextRequest(`http://localhost:3000/api/tools/jobs/${created.id}`, {
      method: 'DELETE',
      headers: { 'x-forwarded-for': '203.0.113.77' },
    });
    const delRes = await deleteToolJobRoute(delReq, { params: Promise.resolve({ id: created.id }) });
    expect(delRes.status).toBe(200);
    await unregisterLiveWorkerHeartbeat('test-worker-1');
  });

  it('streams >8 MiB remote TUS uploads directly as S3 multipart parts across two independent Web replicas', async () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-tus-repA-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-tus-repB-'));
    const sharedStore = new SharedMemoryTusStore();
    setTusSessionStore(sharedStore);

    const uploadedParts: Array<{ partNumber: number; size: number; bytes: Buffer }> = [];
    let completedPartsCount = 0;

    const fakeRemoteBackend = {
      ...selectedStorage.storageProvider,
      kind: 'remote' as const,
      providerName: 's3',
      initiateMultipartUpload: vi.fn(async (filename: string, _mime: string, _size: number) => ({
        uploadId: 'mp_remote_token_1',
        key: `uploads/user1/mp_${filename}`,
        partSize: TUS_REMOTE_PART_BYTES,
        totalParts: 3,
        expiresAt: Date.now() + 3600_000,
      })),
      uploadPart: vi.fn(async (_uploadId: string, partNumber: number, buf: Buffer) => {
        const copy = Buffer.from(buf);
        uploadedParts.push({ partNumber, size: copy.length, bytes: copy });
        return { partNumber, etag: `"etag-${partNumber}"`, size: copy.length };
      }),
      completeMultipartUpload: vi.fn(async (_uploadId: string, parts?: Array<{ partNumber: number }>) => {
        completedPartsCount = parts?.length ?? 0;
        return {
          location: '/api/storage/file/uploads%2Fuser1%2Fmp_doc.bin',
          key: 'uploads/user1/mp_doc.bin',
          size: uploadedParts.reduce((s, p) => s + p.size, 0),
          etag: '"final-etag"',
        };
      }),
      abortMultipartUpload: vi.fn(async () => true),
      stat: vi.fn(async () => ({
        size: 17 * 1024 * 1024,
        etag: '"final-etag"',
        mimeType: 'application/octet-stream',
        filename: 'large.bin',
      })),
    };

    vi.spyOn(selectedStorage, 'storageProvider', 'get').mockReturnValue(fakeRemoteBackend as never);

    try {
      const replicaA = new TusEngine({ tusDir: dirA });
      const replicaB = new TusEngine({ tusDir: dirB });

      const totalLength = 17 * 1024 * 1024; // 17 MiB = 2 * 8 MiB + 1 MiB
      const chunk1 = Buffer.alloc(9 * 1024 * 1024, 0x41); // 9 MiB -> flushes 8 MiB Part 1, keeps 1 MiB tail
      const chunk2 = Buffer.alloc(8 * 1024 * 1024, 0x42); // 8 MiB on Replica B -> flushes 8 MiB Part 2 + 1 MiB Part 3

      const metadata = `filename ${Buffer.from('large.bin').toString('base64')},filetype ${Buffer.from('application/octet-stream').toString('base64')}`;
      const session = await replicaA.createSession({
        uploadLength: totalLength,
        metadataHeader: metadata,
        ownerUserId: 'user1',
      });
      expect(session.remoteUploadId).toBe('mp_remote_token_1');

      const r1 = await replicaA.appendChunk(session.id, 0, Readable.from([chunk1]));
      expect(r1.isComplete).toBe(false);
      expect(r1.newOffset).toBe(9 * 1024 * 1024);
      // Part 1 (8 MiB) was flushed directly to S3; shared Redis tail holds ONLY the remaining 1 MiB!
      expect(uploadedParts.map((p) => ({ partNumber: p.partNumber, size: p.size }))).toEqual([
        { partNumber: 1, size: TUS_REMOTE_PART_BYTES },
      ]);
      expect(sharedStore.stagedByteCount(session.id)).toBe(1024 * 1024);

      // Replica B has zero local files initially, hydrates ONLY the 1 MiB tail, and completes the 17 MiB upload!
      const r2 = await replicaB.appendChunk(session.id, 9 * 1024 * 1024, Readable.from([chunk2]));
      expect(r2.isComplete).toBe(true);
      expect(r2.newOffset).toBe(totalLength);
      expect(completedPartsCount).toBe(3);
      expect(uploadedParts.map((p) => ({ partNumber: p.partNumber, size: p.size }))).toEqual([
        { partNumber: 1, size: 8 * 1024 * 1024 },
        { partNumber: 2, size: 8 * 1024 * 1024 },
        { partNumber: 3, size: 1 * 1024 * 1024 },
      ]);
      expect(sharedStore.stagedByteCount(session.id)).toBe(0);
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('uploads workbench parts directly via presigned PUT URLs and falls back to action=chunk when ETag CORS is absent', async () => {
    const fastTiming: ResumableTiming = {
      pollIntervalMs: 0,
      retryDelayMs: 0,
      maxWaitMs: 10_000,
      partInFlightWaitMs: 1_000,
    };

    const makeTwoPartFile = () => {
      const f = new File([new Uint8Array(16)], 'archive.bin', { type: 'application/octet-stream' });
      Object.defineProperty(f, 'size', { value: 10 * 1024 * 1024 });
      Object.defineProperty(f, 'slice', {
        value: (start: number, end: number) => new Blob([`slice:${start}:${end}`]),
      });
      return f;
    };

    // Case 1: Direct presigned PUT succeeds and exposes ETag -> zero action=chunk calls!
    const directCalls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      directCalls.push(`${method} ${url}`);
      if (url.includes('action=initiate')) {
        return new Response(
          JSON.stringify({
            success: true,
            uploadId: 'up_direct_1',
            key: 'uploads/u1/archive.bin',
            partSize: 5 * 1024 * 1024,
            totalParts: 2,
            presignedPartUrls: {
              '1': 'https://s3.example.test/bucket/uploads/u1/archive.bin?partNumber=1',
              '2': 'https://s3.example.test/bucket/uploads/u1/archive.bin?partNumber=2',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.startsWith('https://s3.example.test/') && method === 'PUT') {
        const pn = new URL(url).searchParams.get('partNumber');
        return new Response(null, { status: 200, headers: { ETag: `"direct-etag-${pn}"` } });
      }
      if (url.includes('action=complete')) {
        const parsed = JSON.parse(String(init.body)) as { parts: Array<{ partNumber: number; etag: string }> };
        expect(parsed.parts).toEqual([
          { partNumber: 1, etag: '"direct-etag-1"' },
          { partNumber: 2, etag: '"direct-etag-2"' },
        ]);
        return new Response(JSON.stringify({ success: true, key: 'uploads/u1/archive.bin', size: 10 * 1024 * 1024 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === '/api/queue/jobs' && method === 'POST') {
        return new Response(JSON.stringify({ success: true, jobId: 'job_direct_1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === '/api/queue/jobs/job_direct_1' && method === 'GET') {
        return new Response(
          JSON.stringify({
            success: true,
            id: 'job_direct_1',
            state: 'completed',
            progress: 100,
            returnvalue: { downloadUrl: '/api/storage/file/results%2Fjob_direct_1%2Fout.zip', size: 12 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.startsWith('/api/storage/file/')) return new Response('converted-ok');
      throw new Error(`Unexpected call: ${method} ${url}`);
    });

    const directRes = await executeResumableCloudConversion(
      makeTwoPartFile(),
      'zip',
      {},
      { onProgress: () => undefined },
      fastTiming
    );
    expect(directRes.size).toBe(12);
    expect(directCalls.some((c) => c.includes('action=chunk'))).toBe(false);
    expect(directCalls.filter((c) => c.startsWith('PUT https://s3.example.test/'))).toHaveLength(2);

    // Case 2: Missing CORS ETag on Part 1 -> falls back to action=chunk for Part 1 AND disables direct PUT for Part 2!
    const fallbackCalls: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      fallbackCalls.push(`${method} ${url}`);
      if (url.includes('action=initiate')) {
        return new Response(
          JSON.stringify({
            success: true,
            uploadId: 'up_fallback_1',
            key: 'uploads/u1/archive.bin',
            partSize: 5 * 1024 * 1024,
            totalParts: 2,
            presignedPartUrls: {
              '1': 'https://s3.example.test/bucket/uploads/u1/archive.bin?partNumber=1',
              '2': 'https://s3.example.test/bucket/uploads/u1/archive.bin?partNumber=2',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.startsWith('https://s3.example.test/') && method === 'PUT') {
        // Bucket CORS omits Access-Control-Expose-Headers: ETag
        return new Response(null, { status: 200 });
      }
      if (url.includes('action=chunk')) {
        const pn = Number(new URL(url, 'http://localhost').searchParams.get('partNumber'));
        return new Response(JSON.stringify({ success: true, partNumber: pn, etag: `"chunk-etag-${pn}"`, size: 5 * 1024 * 1024 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('action=complete')) {
        return new Response(JSON.stringify({ success: true, key: 'uploads/u1/archive.bin', size: 10 * 1024 * 1024 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === '/api/queue/jobs' && method === 'POST') {
        return new Response(JSON.stringify({ success: true, jobId: 'job_fb_1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === '/api/queue/jobs/job_fb_1' && method === 'GET') {
        return new Response(
          JSON.stringify({
            success: true,
            id: 'job_fb_1',
            state: 'completed',
            progress: 100,
            returnvalue: { downloadUrl: '/api/storage/file/results%2Fjob_fb_1%2Fout.zip', size: 12 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.startsWith('/api/storage/file/')) return new Response('converted-ok');
      throw new Error(`Unexpected call: ${method} ${url}`);
    });

    await executeResumableCloudConversion(
      makeTwoPartFile(),
      'zip',
      {},
      { onProgress: () => undefined },
      fastTiming
    );
    expect(fallbackCalls.filter((c) => c.startsWith('PUT https://s3.example.test/'))).toHaveLength(1);
    expect(fallbackCalls.filter((c) => c.includes('action=chunk'))).toHaveLength(2);
  });

  it('pre-signs part upload URLs at multipart initiation only for authenticated users on remote object storage', async () => {
    vi.resetModules();
    const actualStorage = await vi.importActual<typeof import('../src/lib/storage')>('../src/lib/storage');
    const { RemoteStorageBackend } = await import('../src/lib/storage/remote-storage-backend');
    const remoteBackend = new RemoteStorageBackend(
      {
        providerName: 's3',
        createMultipartUpload: vi.fn(async () => 's3_raw_upload_1'),
        abortMultipartUpload: vi.fn(async () => true),
        presignUploadPartUrl: vi.fn((key: string, uploadId: string, partNumber: number) => ({
          url: `https://s3.example.test/bucket/${key}?uploadId=${uploadId}&partNumber=${partNumber}`,
          expiresAt: Date.now() + 900_000,
          signature: `sig-${partNumber}`,
        })),
      } as never,
      { signingSecret: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }
    );
    vi.doMock('@/lib/storage', () => ({
      ...actualStorage,
      storageProvider: remoteBackend,
    }));

    const apiGuardMod = await import('../src/lib/api-keys/guard');
    const { POST: isolatedMultipartPost } = await import('../src/app/api/storage/multipart/route');

    // Authenticated user -> receives presignedPartUrls computed from real RemoteStorageBackend
    vi.spyOn(apiGuardMod, 'validateApiAccess').mockResolvedValueOnce({
      authorized: true,
      user: {
        id: 'usr_authenticated_1',
        email: 'scale@example.test',
        name: 'Scale User',
        tier: 'paid',
        provider: 'email',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });
    const authReq = new NextRequest('http://localhost:3000/api/storage/multipart?action=initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'file.bin', totalSize: 10 * 1024 * 1024, partSize: 5 * 1024 * 1024 }),
    });
    const authRes = await isolatedMultipartPost(authReq);
    expect(authRes.status).toBe(200);
    const authBody = (await authRes.json()) as {
      key: string;
      presignedPartUrls?: Record<string, string>;
    };
    expect(authBody.presignedPartUrls).toEqual({
      '1': `https://s3.example.test/bucket/${authBody.key}?uploadId=s3_raw_upload_1&partNumber=1`,
      '2': `https://s3.example.test/bucket/${authBody.key}?uploadId=s3_raw_upload_1&partNumber=2`,
    });

    // Anonymous caller -> receives NO presignedPartUrls (enforced through action=chunk)
    vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
    vi.spyOn(apiGuardMod, 'validateApiAccess').mockRestore();
    const anonReq = new NextRequest('http://localhost:3000/api/storage/multipart?action=initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.88' },
      body: JSON.stringify({ filename: 'anon.bin', totalSize: 10 * 1024 * 1024, partSize: 5 * 1024 * 1024 }),
    });
    const anonBody = (await (await isolatedMultipartPost(anonReq)).json()) as {
      success: boolean;
      presignedPartUrls?: Record<string, string>;
    };
    expect(anonBody.success).toBe(true);
    expect(anonBody.presignedPartUrls).toBeUndefined();
    vi.doUnmock('@/lib/storage');
  });
});
