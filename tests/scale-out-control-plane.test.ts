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
});
