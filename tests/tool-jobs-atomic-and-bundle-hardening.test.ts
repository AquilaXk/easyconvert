import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { PDFDocument } from 'pdf-lib';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST as toolJobsPost } from '../src/app/api/tools/jobs/route';
import { DELETE as toolJobDelete, GET as toolJobGet } from '../src/app/api/tools/jobs/[id]/route';
import { DELETE as v1JobDelete, GET as v1JobGet } from '../src/app/api/v1/jobs/[id]/route';
import { POST as bundlePost } from '../src/app/api/storage/bundle/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { SMALL_REQUEST_BODY_MAX_BYTES } from '../src/lib/api/request-body-limit';
import { SINGLE_REQUEST_BODY_MAX_BYTES } from '../src/lib/plan-limits';
import { TERMS_VERSION } from '../src/lib/legal/documents';
import { JobCancelledError, type Job } from '../src/lib/queue/bullmq-engine';
import * as concurrencyLimitMod from '../src/lib/queue/concurrency-limit';
import { conversionQueue } from '../src/lib/queue/conversion-queue';
import { graphScheduler } from '../src/lib/queue/graph';
import { sealGraph } from '../src/lib/queue/graph/node-jobs';
import { storageProvider } from '../src/lib/storage';
import { getRetentionLedger } from '../src/lib/storage/retention-ledger';
import * as retentionMod from '../src/lib/storage/retention-service';
import type { IStorageBackend, StoredObject } from '../src/lib/storage/types';
import { processQueuedToolJob } from '../src/lib/tools/queued-tool-runner';
import {
  attachToolJobInputs,
  cancelToolJob,
  completeToolJob,
  deleteToolJob,
  failToolJob,
  getToolJob,
  saveToolJob,
  startToolJob,
  toolResultStorageKeys,
  type ToolJobState,
} from '../src/lib/tools/tool-job-store';
import * as toolJobStoreMod from '../src/lib/tools/tool-job-store';
import * as enqueueMod from '../src/lib/queue/enqueue';
import {
  registerLiveWorkerHeartbeat,
  resetLocalLiveWorkersForTests,
  unregisterLiveWorkerHeartbeat,
} from '../src/lib/queue/worker-presence';
import * as webToolsMod from '../src/lib/tools/web-tools';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

const BASE_URL = 'http://localhost:3000';
const createdJobIds: string[] = [];
const createdStorageKeys: string[] = [];
const createdQueueJobIds: string[] = [];
const tempDirs: string[] = [];

async function makePdfBytes(): Promise<Uint8Array<ArrayBuffer>> {
  const doc = await PDFDocument.create();
  doc.addPage([120, 120]);
  const saved = await doc.save();
  const copy = new Uint8Array(new ArrayBuffer(saved.byteLength));
  copy.set(saved);
  return copy;
}

async function makeUserWithKey(options: {
  tier?: 'free' | 'paid';
  scopes?: Array<'convert:read' | 'convert:write' | 'storage:download' | '*'>;
  expiresAt?: number;
} = {}) {
  const suffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const user = await redisUserStore.createUser({
    email: `p109_${suffix}@example.test`,
    name: `P109 User ${suffix}`,
    tier: options.tier ?? 'paid',
    emailVerified: true,
    acceptedTermsVersion: TERMS_VERSION,
  });
  const key = await redisKeyStore.generateApiKey(user.id, `key_${suffix}`, {
    scopes: options.scopes ?? ['convert:read', 'convert:write', 'storage:download'],
    expiresAt: options.expiresAt,
  });
  return { user, secretKey: key.secretKey, keyId: key.key.id };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetLocalLiveWorkersForTests();
  redisKeyStore.resetStore();
  for (const jobId of createdJobIds.splice(0)) {
    await deleteToolJob(jobId).catch(() => undefined);
  }
  for (const qJobId of createdQueueJobIds.splice(0)) {
    await conversionQueue.remove(qJobId).catch(() => undefined);
  }
  for (const key of createdStorageKeys.splice(0)) {
    await storageProvider.deleteObject(key);
    await getRetentionLedger().forget(key).catch(() => undefined);
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('P1-09: atomic tool job transitions and request/bundle hardening', () => {
  describe('1. Atomic tool job transitions against cancellation', () => {
    it('enforces state transition guards locally and prevents terminal state overwrites', async () => {
      const queuedId = `tool_guard_q_${crypto.randomUUID()}`;
      createdJobIds.push(queuedId);
      await saveToolJob({
        id: queuedId,
        userId: 'user_1',
        tool: 'merge',
        status: 'queued',
        progress: 0,
        createdAt: Date.now(),
      });

      const cancelled = await cancelToolJob(queuedId);
      expect(cancelled?.status).toBe('cancelled');
      expect(await cancelToolJob(queuedId)).toMatchObject({ id: queuedId, status: 'cancelled' });
      expect(await attachToolJobInputs(queuedId, ['uploads/user_1/a.pdf'])).toBe(false);
      expect(await startToolJob(queuedId, 25)).toBe(false);
      expect(await completeToolJob(queuedId, { kind: 'file', file: { name: 'out.pdf', size: 5, url: '/x' } })).toBe(false);
      expect(await failToolJob(queuedId, 'late failure')).toBe(false);
      expect((await getToolJob(queuedId))?.status).toBe('cancelled');

      const completedId = `tool_guard_c_${crypto.randomUUID()}`;
      createdJobIds.push(completedId);
      await saveToolJob({
        id: completedId,
        userId: 'user_1',
        tool: 'merge',
        status: 'completed',
        progress: 100,
        result: { kind: 'file', file: { name: 'done.pdf', size: 12, key: 'conversions/user_1/done.pdf', url: '/done' } },
        createdAt: Date.now(),
      });
      const afterCompletedCancel = await cancelToolJob(completedId);
      expect(afterCompletedCancel?.status).toBe('completed');
      expect((await getToolJob(completedId))?.status).toBe('completed');

      const failedId = `tool_guard_f_${crypto.randomUUID()}`;
      createdJobIds.push(failedId);
      await saveToolJob({
        id: failedId,
        userId: 'user_1',
        tool: 'merge',
        status: 'failed',
        progress: 25,
        error: 'corrupt pdf',
        createdAt: Date.now(),
      });
      const afterFailedCancel = await cancelToolJob(failedId);
      expect(afterFailedCancel).toMatchObject({ status: 'failed', error: 'corrupt pdf' });
      expect(await cancelToolJob(`missing_${crypto.randomUUID()}`)).toBeNull();
    });

    it('discards stored output and rolls back quota when local tool job is cancelled right before completion', async () => {
      const { user, secretKey } = await makeUserWithKey({ tier: 'paid' });
      const quotaBefore = (await redisKeyStore.getQuotaUsage(user.id)).usedToday;
      const pdfBytes = await makePdfBytes();

      let markStarted!: () => void;
      const runStarted = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let finishTool!: (val: webToolsMod.WebToolOutput) => void;
      const toolOutputPromise = new Promise<webToolsMod.WebToolOutput>((resolve) => {
        finishTool = resolve;
      });

      vi.spyOn(webToolsMod, 'runWebTool').mockImplementation((async () => {
        markStarted();
        return toolOutputPromise;
      }) as typeof webToolsMod.runWebTool);

      const form = new FormData();
      form.set('tool', 'merge');
      form.append('files', new File([pdfBytes], 'a.pdf', { type: 'application/pdf' }));
      form.append('files', new File([pdfBytes], 'b.pdf', { type: 'application/pdf' }));

      const createRes = await toolJobsPost(
        new NextRequest(`${BASE_URL}/api/tools/jobs`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${secretKey}` },
          body: form,
        })
      );
      expect(createRes.status).toBe(201);
      const { id: jobId } = (await createRes.json()) as { id: string };
      createdJobIds.push(jobId);

      await runStarted;

      // Cancel right as saveRetainedResult finishes storing output, simulating an in-flight race
      // between storeToolOutput and completeToolJob even if runWebTool ignored AbortSignal.
      const savedKeys: string[] = [];
      const origSaveRetained = retentionMod.saveRetainedResult;
      let triggeredCancel = false;
      vi.spyOn(retentionMod, 'saveRetainedResult').mockImplementation(async (storage, key, buffer, mime, filename) => {
        savedKeys.push(key);
        createdStorageKeys.push(key);
        await origSaveRetained(storage, key, buffer, mime, filename);
        if (!triggeredCancel) {
          triggeredCancel = true;
          const delRes = await toolJobDelete(
            new NextRequest(`${BASE_URL}/api/tools/jobs/${jobId}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${secretKey}` },
            }),
            { params: Promise.resolve({ id: jobId }) }
          );
          expect(delRes.status).toBe(200);
        }
      });

      finishTool(webToolsMod.fileOutput('ignored-abort.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n')));

      await vi.waitFor(async () => {
        expect(savedKeys.length).toBe(1);
        expect(await storageProvider.stat(savedKeys[0])).toBeNull();
      });

      const getRes = await toolJobGet(
        new NextRequest(`${BASE_URL}/api/tools/jobs/${jobId}`, {
          headers: { Authorization: `Bearer ${secretKey}` },
        }),
        { params: Promise.resolve({ id: jobId }) }
      );
      expect(getRes.status).toBe(200);
      expect(await getRes.json()).toMatchObject({ success: true, id: jobId, status: 'cancelled' });
      expect((await getToolJob(jobId))?.result).toBeUndefined();
      expect((await redisKeyStore.getQuotaUsage(user.id)).usedToday).toBe(quotaBefore);
    });

    it('erases output and throws JobCancelledError when queued tool job is cancelled during storeQueuedToolOutput, and captures buffers before release', async () => {
      const jobId = `tool_queued_race_${crypto.randomUUID()}`;
      const userId = `user_race_${crypto.randomBytes(4).toString('hex')}`;
      createdJobIds.push(jobId);

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p109-tool-release-'));
      tempDirs.push(tempDir);
      const backingPath = path.join(tempDir, 'input.pdf');
      const pdfBytes = Buffer.from(await makePdfBytes());
      fs.writeFileSync(backingPath, pdfBytes);

      const inputKey = `uploads/${userId}/staged_in.pdf`;
      let releasedCount = 0;
      const wrappedStorage = new Proxy(storageProvider, {
        get(target, prop, receiver) {
          if (prop === 'getObject') {
            return async (key: string): Promise<StoredObject | undefined> => {
              if (key === inputKey) {
                return {
                  key,
                  filename: 'a.pdf',
                  mimeType: 'application/pdf',
                  size: pdfBytes.length,
                  etag: 'etag-in',
                  uploadedAt: Date.now(),
                  expiresAt: Date.now() + 60_000,
                  filePath: backingPath,
                  get buffer(): Buffer {
                    if (!fs.existsSync(backingPath)) {
                      throw new Error('Backing file was released before buffer was read!');
                    }
                    return fs.readFileSync(backingPath);
                  },
                  release: async () => {
                    releasedCount += 1;
                    fs.rmSync(backingPath, { force: true });
                  },
                };
              }
              return target.getObject(key);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });

      await saveToolJob({
        id: jobId,
        userId,
        tool: 'merge',
        status: 'queued',
        progress: 0,
        inputKeys: [inputKey],
        createdAt: Date.now(),
      });

      let observedInputLen = 0;
      vi.spyOn(webToolsMod, 'runWebTool').mockImplementation(async (_tool, files) => {
        observedInputLen = files[0].buffer.length;
        return webToolsMod.fileOutput('merged.pdf', 'application/pdf', Buffer.from('%PDF-1.4\nmerged'));
      });

      const storedResultKeys: string[] = [];
      const origSaveRetained = retentionMod.saveRetainedResult;
      vi.spyOn(retentionMod, 'saveRetainedResult').mockImplementation(async (targetStorage, key, buffer, mime, filename) => {
        storedResultKeys.push(key);
        createdStorageKeys.push(key);
        await origSaveRetained(targetStorage, key, buffer, mime, filename);
        // Simulate concurrent cancellation arriving right after output upload, before completeToolJob
        await cancelToolJob(jobId);
      });

      const fakeJob = {
        id: jobId,
        data: {
          jobId,
          originalFilename: 'merge',
          sourceFormat: 'pdf',
          targetFormat: 'pdf',
          fileSize: pdfBytes.length,
          options: {},
          userId,
          toolJob: {
            tool: 'merge',
            options: {},
            storedRefs: [
              { key: inputKey, name: 'a.pdf' },
              { key: inputKey, name: 'b.pdf' },
            ],
            cleanupUploadKeys: [inputKey],
          },
        },
        signal: new AbortController().signal,
      } as unknown as Job<ConversionJobData, ConversionJobResult>;

      await expect(processQueuedToolJob(fakeJob, wrappedStorage)).rejects.toBeInstanceOf(JobCancelledError);
      expect(observedInputLen).toBe(pdfBytes.length);
      expect(releasedCount).toBe(2);
      expect(storedResultKeys.length).toBe(1);
      expect(await storageProvider.stat(storedResultKeys[0])).toBeNull();
      const persisted = await getToolJob(jobId);
      expect(persisted?.status).toBe('cancelled');
      expect(toolResultStorageKeys(persisted?.result)).toEqual([]);
    });

    it('refuses queued tool job enqueue when cancelled before attachToolJobInputs and cleans staged inputs without charging quota', async () => {
      const { user, secretKey } = await makeUserWithKey({ tier: 'paid' });
      const quotaBefore = (await redisKeyStore.getQuotaUsage(user.id)).usedToday;
      const pdfBytes = await makePdfBytes();

      const workerId = `p109-worker-${crypto.randomBytes(4).toString('hex')}`;
      await registerLiveWorkerHeartbeat(workerId);
      const handOffSpy = vi.spyOn(enqueueMod, 'handOffConversionJob');
      const stagedSaveSpy = vi.spyOn(storageProvider, 'saveObject');

      const origSaveToolJob = toolJobStoreMod.saveToolJob;
      let createdId = '';
      vi.spyOn(toolJobStoreMod, 'saveToolJob').mockImplementation(async (state) => {
        createdId = state.id;
        createdJobIds.push(state.id);
        await origSaveToolJob(state);
        await cancelToolJob(state.id);
      });

      try {
        const form = new FormData();
        form.set('tool', 'merge');
        form.append('files', new File([pdfBytes], 'a.pdf', { type: 'application/pdf' }));
        form.append('files', new File([pdfBytes], 'b.pdf', { type: 'application/pdf' }));

        const res = await toolJobsPost(
          new NextRequest(`${BASE_URL}/api/tools/jobs`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${secretKey}` },
            body: form,
          })
        );
        expect(res.status).toBe(500);
        expect(handOffSpy).not.toHaveBeenCalled();
        expect(createdId).not.toBe('');
        expect(stagedSaveSpy.mock.calls.length).toBe(2);
        for (const call of stagedSaveSpy.mock.calls) {
          expect(await storageProvider.stat(String(call[0]))).toBeNull();
        }
        const persisted = await getToolJob(createdId);
        expect(persisted?.status).toBe('cancelled');
        expect((await redisKeyStore.getQuotaUsage(user.id)).usedToday).toBe(quotaBefore);
      } finally {
        await unregisterLiveWorkerHeartbeat(workerId).catch(() => undefined);
      }
    });
  });

  describe('2. POST /api/tools/jobs wrapped in withinSingleRequest', () => {
    it('rejects oversized declared Content-Length with 413 and malformed Content-Length with 400 before auth or body read', async () => {
      const textSpy = vi.fn(async () => '{}');

      const oversizedReq = new NextRequest(`${BASE_URL}/api/tools/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(SINGLE_REQUEST_BODY_MAX_BYTES + 1),
        },
      });
      Object.defineProperty(oversizedReq, 'text', { value: textSpy });
      const res413 = await toolJobsPost(oversizedReq);
      expect(res413.status).toBe(413);
      expect(res413.headers.get('content-type')).toContain('application/problem+json');
      const body413 = (await res413.json()) as { status: number; maxRequestBytes: number };
      expect(body413.status).toBe(413);
      expect(body413.maxRequestBytes).toBe(SINGLE_REQUEST_BODY_MAX_BYTES);
      expect(textSpy).not.toHaveBeenCalled();

      const malformedReq = new NextRequest(`${BASE_URL}/api/tools/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': 'not-a-number',
        },
      });
      const res400 = await toolJobsPost(malformedReq);
      expect(res400.status).toBe(400);
      expect(res400.headers.get('content-type')).toContain('application/problem+json');
    });
  });

  describe('3. GET and DELETE /api/v1/jobs/[id] return 404 on foreign jobs', () => {
    it('returns 404 for foreign single queue jobs and foreign graph jobs while keeping 403 for missing scope', async () => {
      const alice = await makeUserWithKey({ scopes: ['convert:read', 'convert:write'] });
      const bob = await makeUserWithKey({ scopes: ['convert:read', 'convert:write'] });
      const aliceReadOnly = await makeUserWithKey({ scopes: ['convert:read'] });
      const aliceWriteOnly = await makeUserWithKey({ scopes: ['convert:write'] });

      const queueJobId = `job_v1_foreign_${crypto.randomBytes(6).toString('hex')}`;
      createdQueueJobIds.push(queueJobId);
      await conversionQueue.add('convert', {
        jobId: queueJobId,
        userId: alice.user.id,
        originalFilename: 'secret.csv',
        sourceFormat: 'csv',
        targetFormat: 'json',
        fileSize: 16,
        options: {},
      });

      const bobGetQueue = await v1JobGet(
        new NextRequest(`${BASE_URL}/api/v1/jobs/${queueJobId}`, {
          headers: { Authorization: `Bearer ${bob.secretKey}` },
        }),
        { params: Promise.resolve({ id: queueJobId }) }
      );
      expect(bobGetQueue.status).toBe(404);
      expect((await bobGetQueue.json()).detail).toContain('not found');

      const bobDeleteQueue = await v1JobDelete(
        new NextRequest(`${BASE_URL}/api/v1/jobs/${queueJobId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${bob.secretKey}` },
        }),
        { params: Promise.resolve({ id: queueJobId }) }
      );
      expect(bobDeleteQueue.status).toBe(404);
      expect((await bobDeleteQueue.json()).detail).toContain('not found');
      expect((await conversionQueue.getJob(queueJobId))?.state).not.toBe('cancelled');

      const graphId = `graph_v1_foreign_${crypto.randomBytes(6).toString('hex')}`;
      await graphScheduler.initGraph(
        graphId,
        sealGraph(graphId, {
          nodes: {
            n1: { op: 'import.upload', storageKey: 'uploads/alice.csv' },
          },
        }),
        { ownerUserId: alice.user.id }
      );

      const bobGetGraph = await v1JobGet(
        new NextRequest(`${BASE_URL}/api/v1/jobs/${graphId}`, {
          headers: { Authorization: `Bearer ${bob.secretKey}` },
        }),
        { params: Promise.resolve({ id: graphId }) }
      );
      expect(bobGetGraph.status).toBe(404);
      expect((await bobGetGraph.json()).detail).toContain('not found');

      const bobDeleteGraph = await v1JobDelete(
        new NextRequest(`${BASE_URL}/api/v1/jobs/${graphId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${bob.secretKey}` },
        }),
        { params: Promise.resolve({ id: graphId }) }
      );
      expect(bobDeleteGraph.status).toBe(404);
      expect((await bobDeleteGraph.json()).detail).toContain('not found');
      expect((await graphScheduler.getGraphState(graphId))?.status).toBe('running');

      const missingReadScope = await v1JobGet(
        new NextRequest(`${BASE_URL}/api/v1/jobs/${queueJobId}`, {
          headers: { Authorization: `Bearer ${aliceWriteOnly.secretKey}` },
        }),
        { params: Promise.resolve({ id: queueJobId }) }
      );
      expect(missingReadScope.status).toBe(403);

      const missingWriteScope = await v1JobDelete(
        new NextRequest(`${BASE_URL}/api/v1/jobs/${queueJobId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${aliceReadOnly.secretKey}` },
        }),
        { params: Promise.resolve({ id: queueJobId }) }
      );
      expect(missingWriteScope.status).toBe(403);
    });
  });

  describe('4. POST /api/storage/bundle hardening', () => {
    it('rejects JSON bodies exceeding SMALL_REQUEST_BODY_MAX_BYTES with 413 and malformed JSON with 400 with Cache-Control private, no-store', async () => {
      const oversizedPayload = JSON.stringify({
        files: [{ key: 'uploads/test.txt', name: 'test.txt' }],
        archiveName: 'a'.repeat(SMALL_REQUEST_BODY_MAX_BYTES + 32),
      });
      const res = await bundlePost(
        new NextRequest(`${BASE_URL}/api/storage/bundle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: oversizedPayload,
        })
      );
      expect(res.status).toBe(413);
      expect(res.headers.get('cache-control')).toBe('private, no-store');

      const textSpy = vi.fn(async () => '{}');
      const declaredOversizedReq = new NextRequest(`${BASE_URL}/api/storage/bundle`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(SMALL_REQUEST_BODY_MAX_BYTES + 1),
        },
      });
      Object.defineProperty(declaredOversizedReq, 'text', { value: textSpy });
      const declaredRes = await bundlePost(declaredOversizedReq);
      expect(declaredRes.status).toBe(413);
      expect(declaredRes.headers.get('cache-control')).toBe('private, no-store');
      expect(textSpy).not.toHaveBeenCalled();

      const malformedRes = await bundlePost(
        new NextRequest(`${BASE_URL}/api/storage/bundle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{not-valid-json',
        })
      );
      expect(malformedRes.status).toBe(400);
      expect(malformedRes.headers.get('cache-control')).toBe('private, no-store');
    });

    it('rejects invalid, expired, and insufficient-scope API keys immediately without falling back to anonymous capability access', async () => {
      const capKey = `uploads/cap_${crypto.randomBytes(4).toString('hex')}.txt`;
      createdStorageKeys.push(capKey);
      await storageProvider.saveObject(capKey, Buffer.from('capability data'), 'text/plain', 'cap.txt');

      const slotSpy = vi.spyOn(concurrencyLimitMod, 'acquireSyncSlot');
      const expired = await makeUserWithKey({
        scopes: ['storage:download'],
        expiresAt: Date.now() - 10_000,
      });
      const readOnly = await makeUserWithKey({
        scopes: ['convert:read'],
      });

      const cases: Array<{ label: string; headers: Record<string, string>; expectedStatus: number }> = [
        {
          label: 'invalid ec_live key',
          headers: { Authorization: 'Bearer ec_live_not_a_real_key_123456' },
          expectedStatus: 401,
        },
        {
          label: 'non-ec_live bearer token',
          headers: { Authorization: 'Bearer invalid-opaque-token' },
          expectedStatus: 401,
        },
        {
          label: 'invalid x-api-key',
          headers: { 'x-api-key': 'bad-key-value' },
          expectedStatus: 401,
        },
        {
          label: 'expired API key',
          headers: { Authorization: `Bearer ${expired.secretKey}` },
          expectedStatus: 401,
        },
        {
          label: 'API key missing storage:download scope',
          headers: { Authorization: `Bearer ${readOnly.secretKey}` },
          expectedStatus: 403,
        },
      ];

      for (const c of cases) {
        const res = await bundlePost(
          new NextRequest(`${BASE_URL}/api/storage/bundle`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...c.headers },
            body: JSON.stringify({ files: [{ key: capKey, name: 'cap.txt' }] }),
          })
        );
        expect(res.status, c.label).toBe(c.expectedStatus);
        expect(res.headers.get('cache-control'), c.label).toBe('private, no-store');
      }
      expect(slotSpy).not.toHaveBeenCalled();
    });

    it('enforces anonymous burst rate limiting before acquiring a sync slot', async () => {
      vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
      vi.stubEnv('ANONYMOUS_BURST_CAPACITY', '2');
      vi.stubEnv('ANONYMOUS_BURST_REFILL_RATE', '0');

      const capKey = `uploads/anon_burst_${crypto.randomBytes(4).toString('hex')}.txt`;
      createdStorageKeys.push(capKey);
      await storageProvider.saveObject(capKey, Buffer.from('burst ok'), 'text/plain', 'burst.txt');

      const slotSpy = vi.spyOn(concurrencyLimitMod, 'acquireSyncSlot');
      const clientIp = '203.0.113.88';
      const sendAnon = () =>
        bundlePost(
          new NextRequest(`${BASE_URL}/api/storage/bundle`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp },
            body: JSON.stringify({ files: [{ key: capKey, name: 'burst.txt' }] }),
          })
        );

      const first = await sendAnon();
      expect(first.status).toBe(200);
      await first.arrayBuffer();

      const second = await sendAnon();
      expect(second.status).toBe(200);
      await second.arrayBuffer();

      slotSpy.mockClear();
      const third = await sendAnon();
      expect(third.status).toBe(429);
      expect(third.headers.get('cache-control')).toBe('private, no-store');
      expect(third.headers.get('retry-after')).not.toBeNull();
      expect(Number(third.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect(slotSpy).not.toHaveBeenCalled();
    });

    it('deletes expired retained results via deleteResult and answers 410 to owner and 404 to strangers', async () => {
      const owner = await makeUserWithKey({ scopes: ['storage:download'] });
      const stranger = await makeUserWithKey({ scopes: ['storage:download'] });
      const expiredKey = `conversions/${owner.user.id}/expired_${crypto.randomBytes(4).toString('hex')}.txt`;
      createdStorageKeys.push(expiredKey);

      await retentionMod.saveRetainedResult(storageProvider, expiredKey, Buffer.from('expired-body'), 'text/plain', 'expired.txt');
      // Mark the record deleted while the object still exists in storage (pre-sweep)
      await getRetentionLedger().update(expiredKey, (rec) =>
        rec ? { ...rec, deleteAt: Date.now() - 60_000 } : undefined
      );
      expect(await storageProvider.stat(expiredKey)).not.toBeNull();

      // Stranger must still receive 404 without probing or deleting
      const strangerRes = await bundlePost(
        new NextRequest(`${BASE_URL}/api/storage/bundle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${stranger.secretKey}` },
          body: JSON.stringify({ files: [{ key: expiredKey, name: 'expired.txt' }] }),
        })
      );
      expect(strangerRes.status).toBe(404);
      expect(await storageProvider.stat(expiredKey)).not.toBeNull();

      // Owner triggers deleteResult cleanup and receives 410 Gone
      const deleteSpy = vi.spyOn(retentionMod, 'deleteResult');
      const ownerRes = await bundlePost(
        new NextRequest(`${BASE_URL}/api/storage/bundle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.secretKey}` },
          body: JSON.stringify({ files: [{ key: expiredKey, name: 'expired.txt' }] }),
        })
      );
      expect(ownerRes.status).toBe(410);
      expect(ownerRes.headers.get('cache-control')).toBe('private, no-store');
      expect(deleteSpy).toHaveBeenCalledWith(storageProvider, expiredKey);
      expect(await storageProvider.stat(expiredKey)).toBeNull();
    });

    it('aborts slow bundle streams past the wall-clock deadline, destroys upstream streams, and releases the sync slot', async () => {
      vi.stubEnv('JOB_DEADLINE_BASE_MS_FREE', '40');
      vi.stubEnv('SYNC_DEADLINE_MAX_MS', '40');

      const caller = await makeUserWithKey({ tier: 'free', scopes: ['storage:download'] });
      const slowKey = `conversions/${caller.user.id}/slow_${crypto.randomBytes(4).toString('hex')}.bin`;
      createdStorageKeys.push(slowKey);

      const payloadSize = 1024;
      vi.spyOn(storageProvider, 'stat').mockResolvedValue({
        size: payloadSize,
        mimeType: 'application/octet-stream',
        filename: 'slow.bin',
        etag: 'etag-slow',
      });
      vi.spyOn(retentionMod, 'resultAvailability').mockResolvedValue({ state: 'available' });
      const recordServedSpy = vi.spyOn(retentionMod, 'recordServed').mockResolvedValue();

      let destroyed = false;
      vi.spyOn(storageProvider, 'openReadStream').mockImplementation(async () => {
        const pt = new PassThrough();
        const origDestroy = pt.destroy.bind(pt);
        pt.destroy = ((...args: unknown[]) => {
          destroyed = true;
          return origDestroy(...(args as [Error?]));
        }) as typeof pt.destroy;
        pt.write(Buffer.from('partial-only'));
        return pt as never;
      });

      const releaseSpy = vi.fn();
      vi.spyOn(concurrencyLimitMod, 'acquireSyncSlot').mockResolvedValue({
        granted: true,
        release: releaseSpy,
      });

      const res = await bundlePost(
        new NextRequest(`${BASE_URL}/api/storage/bundle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${caller.secretKey}` },
          body: JSON.stringify({ files: [{ key: slowKey, name: 'slow.bin' }] }),
        })
      );
      expect(res.status).toBe(200);

      const reader = res.body!.getReader();
      await reader.read();

      await expect(
        (async () => {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
          }
        })()
      ).rejects.toMatchObject({ name: 'JobTimeoutError' });

      expect(destroyed).toBe(true);
      expect(releaseSpy).toHaveBeenCalledTimes(1);
      expect(recordServedSpy).not.toHaveBeenCalled();
    });
  });
});

void (undefined as unknown as ToolJobState);
