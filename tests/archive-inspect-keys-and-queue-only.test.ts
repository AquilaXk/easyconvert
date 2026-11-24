import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as inspectRoute } from '../src/app/api/v1/archives/inspect/route';
import * as conversions from '../src/lib/conversions';
import * as ownerAccess from '../src/lib/api-keys/owner-access';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { createSessionToken } from '../src/lib/auth/session';
import { userStore } from '../src/lib/auth/user-store';
import type { User } from '../src/lib/auth/types';
import { SINGLE_REQUEST_FILE_MAX_BYTES } from '../src/lib/plan-limits';
import { Worker, type Job } from '../src/lib/queue/bullmq-engine';
import { processConversionJob, resourceQueues } from '../src/lib/queue/conversion-queue';
import { graphScheduler } from '../src/lib/queue/graph';
import { sealGraph } from '../src/lib/queue/graph/node-jobs';
import { processQueuedArchiveInspection } from '../src/lib/queue/node-processor';
import { dispatchSyncArchiveInspection } from '../src/lib/queue/wait-for-job';
import * as workerPresence from '../src/lib/queue/worker-presence';
import { PROBLEM_TYPE_BASE } from '../src/lib/refusal-codes';
import { storageProvider } from '../src/lib/storage';
import { FileRetentionLedger, setRetentionLedger } from '../src/lib/storage/retention-ledger';
import { deleteResult, registerResult } from '../src/lib/storage/retention-service';
import {
  ArchiveEncryptedHeaderError,
  ConversionFailedError,
  EngineMissingError,
  MissingVolumeError,
  QueueUnavailableError,
  type ConversionJobData,
  type ConversionJobResult,
} from '../src/lib/types';
import { restoreIsolatedRetentionLedger } from './helpers/isolated-retention-ledger';

const ROUTE_URL = 'http://localhost:3000/api/v1/archives/inspect';
const ONE_HOUR_MS = 3_600_000;
const NOT_FOUND_DETAIL = ownerAccess.STORAGE_OBJECT_NOT_FOUND;

async function buildZipBuffer(entries: Array<{ name: string; text: string }>): Promise<Buffer> {
  const zip = new JSZip();
  for (const entry of entries) {
    zip.file(entry.name, entry.text);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

function buildEncryptedHeaderRar(): Buffer {
  const marker = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
  const mainHead = Buffer.alloc(13);
  mainHead.writeUInt16LE(0x1234, 0);
  mainHead.writeUInt8(0x73, 2);
  mainHead.writeUInt16LE(0x0080, 3);
  mainHead.writeUInt16LE(13, 5);
  return Buffer.concat([marker, mainHead]);
}

async function makeUser(label: string): Promise<{ user: User; headers: Record<string, string> }> {
  const email = `${label}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@inspect-p108.test`;
  const user = userStore.sanitizeUser(await userStore.createUser({ email, name: label, tier: 'paid', emailVerified: true }));
  return {
    user,
    headers: { Cookie: `easyconvert_session=${createSessionToken(user)}` },
  };
}

function postInspectJson(headers: Record<string, string>, payload: unknown): Promise<Response> {
  return inspectRoute(
    new NextRequest(ROUTE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    })
  );
}

describe('P1-08: POST /api/v1/archives/inspect key authorization, object release, and queue-only worker dispatch', () => {
  const createdKeys: string[] = [];
  const openWorkers: Worker<ConversionJobData, ConversionJobResult>[] = [];
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.stubEnv('JOB_SECRET_SEAL_KEY', 'p108-archive-inspect-secret-seal-key-0001');
  });

  afterEach(async () => {
    while (openWorkers.length > 0) {
      await openWorkers.pop()!.close();
    }
    for (const key of createdKeys.splice(0)) {
      await Promise.resolve(storageProvider.deleteObject(key)).catch(() => undefined);
    }
    restoreIsolatedRetentionLedger();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    workerPresence.resetLocalLiveWorkersForTests();
  });

  async function saveStoredObject(key: string, buffer: Buffer, filename = 'archive.zip'): Promise<string> {
    await storageProvider.saveObject(key, buffer, 'application/zip', filename, ONE_HOUR_MS);
    createdKeys.push(key);
    return key;
  }

  describe('storage key authorization matching mayUseStorageKeyAsJobInput', () => {
    it('allows capability uploads/... keys for both uploader and another caller holding the key', async () => {
      const alice = await makeUser('cap_alice');
      const bob = await makeUser('cap_bob');
      const zipBytes = await buildZipBuffer([{ name: 'hello.txt', text: 'world' }]);
      const key = await saveStoredObject(`uploads/${Date.now()}_${crypto.randomBytes(4).toString('hex')}_cap.zip`, zipBytes, 'cap.zip');

      const aliceRes = await postInspectJson(alice.headers, { storageKey: key });
      expect(aliceRes.status).toBe(200);
      const aliceBody = await aliceRes.json();
      expect(aliceBody.format).toBe('zip');
      expect(aliceBody.entries.map((entry: { name: string }) => entry.name)).toEqual(['hello.txt']);

      const bobRes = await postInspectJson(bob.headers, { storageKey: key });
      expect(bobRes.status).toBe(200);
      const bobBody = await bobRes.json();
      expect(bobBody.format).toBe('zip');
      expect(bobBody.entries.map((entry: { name: string }) => entry.name)).toEqual(['hello.txt']);
    });

    it('allows owned intermediate/<graphId>/... keys and rejects foreign, cancelled, failed, foreign-owned, and other-namespace keys with 404', async () => {
      const alice = await makeUser('inter_alice');
      const bob = await makeUser('inter_bob');
      const zipBytes = await buildZipBuffer([{ name: 'node.txt', text: 'node' }]);

      const ownedGraphId = `graph_ok_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      await graphScheduler.initGraph(
        ownedGraphId,
        sealGraph(ownedGraphId, {
          nodes: {
            upload: { op: 'import.upload', storageKey: 'uploads/src.zip' },
            conv: { op: 'convert', input: 'upload', targetFormat: 'zip' },
          },
        }),
        { ownerUserId: alice.user.id }
      );
      const ownedInterKey = await saveStoredObject(`intermediate/${ownedGraphId}/conv/out.zip`, zipBytes);

      const okRes = await postInspectJson(alice.headers, { storageKey: ownedInterKey });
      expect(okRes.status).toBe(200);
      expect((await okRes.json()).entries.map((entry: { name: string }) => entry.name)).toEqual(['node.txt']);

      // Foreign caller on owned intermediate key -> 404
      const foreignInterRes = await postInspectJson(bob.headers, { storageKey: ownedInterKey });
      expect(foreignInterRes.status).toBe(404);
      expect((await foreignInterRes.json()).detail).toBe(NOT_FOUND_DETAIL);

      // Cancelled graph intermediate key -> 404 even for owner
      const cancelledGraphId = `graph_cancel_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      await graphScheduler.initGraph(
        cancelledGraphId,
        sealGraph(cancelledGraphId, {
          nodes: {
            upload: { op: 'import.upload', storageKey: 'uploads/src.zip' },
            conv: { op: 'convert', input: 'upload', targetFormat: 'zip' },
          },
        }),
        { ownerUserId: alice.user.id }
      );
      const cancelledInterKey = await saveStoredObject(`intermediate/${cancelledGraphId}/conv/out.zip`, zipBytes);
      await graphScheduler.cancelGraph(cancelledGraphId, 'cancelled for test');

      const cancelledRes = await postInspectJson(alice.headers, { storageKey: cancelledInterKey });
      expect(cancelledRes.status).toBe(404);
      expect((await cancelledRes.json()).detail).toBe(NOT_FOUND_DETAIL);

      // Failed graph intermediate key -> 404 even for owner
      const failedGraphId = `graph_fail_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      await graphScheduler.initGraph(
        failedGraphId,
        sealGraph(failedGraphId, {
          nodes: {
            upload: { op: 'import.upload', storageKey: 'uploads/src.zip' },
            conv: { op: 'convert', input: 'upload', targetFormat: 'zip' },
          },
        }),
        { ownerUserId: alice.user.id }
      );
      const failedInterKey = await saveStoredObject(`intermediate/${failedGraphId}/conv/out.zip`, zipBytes);
      await graphScheduler.onNodeFailed(failedGraphId, 'upload', 'boom');

      const failedRes = await postInspectJson(alice.headers, { storageKey: failedInterKey });
      expect(failedRes.status).toBe(404);
      expect((await failedRes.json()).detail).toBe(NOT_FOUND_DETAIL);

      // Foreign conversions/<other>/..., foreign uploads/<other>/..., and 'other' namespace -> 404
      const foreignConvKey = await saveStoredObject(`conversions/${alice.user.id}/secret.zip`, zipBytes);
      const foreignUserUploadKey = await saveStoredObject(`uploads/${alice.user.id}/staged.zip`, zipBytes);
      const otherNamespaceKey = await saveStoredObject('custom/outside.zip', zipBytes);
      const traversalKey = `uploads/../${foreignConvKey}`;

      for (const forbiddenKey of [foreignConvKey, foreignUserUploadKey, otherNamespaceKey, traversalKey]) {
        const res = await postInspectJson(bob.headers, { storageKey: forbiddenKey });
        expect(res.status, forbiddenKey).toBe(404);
        expect((await res.json()).detail, forbiddenKey).toBe(NOT_FOUND_DETAIL);
      }
    });

    it('returns 404 for a deleted retained result key', async () => {
      const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-inspect-retention-'));
      tempDirs.push(ledgerDir);
      setRetentionLedger(new FileRetentionLedger(ledgerDir));

      const alice = await makeUser('deleted_res');
      const zipBytes = await buildZipBuffer([{ name: 'gone.txt', text: 'bye' }]);
      const key = await saveStoredObject(`conversions/${alice.user.id}/${Date.now()}_retained.zip`, zipBytes);
      await registerResult(key);

      // Mark deleted past TTL so isResultDeleted returns true
      await deleteResult(storageProvider, key, Date.now() + 7 * 24 * 60 * 60 * 1000);

      const res = await postInspectJson(alice.headers, { storageKey: key });
      expect(res.status).toBe(404);
      expect((await res.json()).detail).toBe(NOT_FOUND_DETAIL);
    });
  });

  describe('deterministic stored.release() cleanup in hybrid mode', () => {
    it('calls stored.release() on both 200 success and 422 inspection failure', async () => {
      vi.stubEnv('WEB_EXECUTION_MODE', 'hybrid');
      const alice = await makeUser('release_check');

      // 1. 200 success
      const okBytes = await buildZipBuffer([{ name: 'ok.txt', text: 'content' }]);
      const okKey = await saveStoredObject(`uploads/${Date.now()}_release_ok.zip`, okBytes, 'ok.zip');
      const okRelease = vi.fn(async () => undefined);
      const origGetObject = storageProvider.getObject.bind(storageProvider);
      const getObjectSpy = vi.spyOn(storageProvider, 'getObject').mockImplementation(async (k: string) => {
        const obj = await origGetObject(k);
        if (!obj) return undefined;
        return {
          ...obj,
          buffer: obj.buffer,
          release: k === okKey ? okRelease : async () => undefined,
        };
      });

      const okRes = await postInspectJson(alice.headers, { storageKey: okKey });
      expect(okRes.status).toBe(200);
      expect(okRelease).toHaveBeenCalledTimes(1);

      // 2. 422 failure (encrypted header RAR)
      const encBytes = buildEncryptedHeaderRar();
      const failKey = await saveStoredObject(`uploads/${Date.now()}_release_fail.rar`, encBytes, 'locked.rar');
      const failRelease = vi.fn(async () => undefined);
      getObjectSpy.mockImplementation(async (k: string) => {
        const obj = await origGetObject(k);
        if (!obj) return undefined;
        return {
          ...obj,
          buffer: obj.buffer,
          release: k === failKey ? failRelease : async () => undefined,
        };
      });

      const failRes = await postInspectJson(alice.headers, { storageKey: failKey });
      expect(failRes.status).toBe(422);
      expect(failRelease).toHaveBeenCalledTimes(1);
    });
  });

  describe('WEB_EXECUTION_MODE=queue-only behavior', () => {
    it('fails closed with 503 when no live worker exists without calling local inspectArchive', async () => {
      vi.stubEnv('WEB_EXECUTION_MODE', 'queue-only');
      vi.spyOn(workerPresence, 'hasLiveQueueWorker').mockResolvedValue(false);
      const inspectSpy = vi.spyOn(conversions, 'inspectArchive');
      const alice = await makeUser('qo_no_worker');

      const zipBytes = await buildZipBuffer([{ name: 'item.txt', text: 'data' }]);
      const key = await saveStoredObject(`uploads/${Date.now()}_no_worker.zip`, zipBytes, 'no_worker.zip');

      const res = await postInspectJson(alice.headers, { storageKey: key });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.type).toBe(`${PROBLEM_TYPE_BASE}service-unavailable`);
      expect(inspectSpy).not.toHaveBeenCalled();

      // Also verify direct helper throws QueueUnavailableError
      await expect(
        dispatchSyncArchiveInspection({
          archiveBuffer: zipBytes,
          inputBytes: zipBytes.length,
          filename: 'no_worker.zip',
          userId: alice.user.id,
          tier: 'paid',
        })
      ).rejects.toBeInstanceOf(QueueUnavailableError);
      expect(inspectSpy).not.toHaveBeenCalled();
    });

    it('dispatches { storageKey } to worker without calling web getObject, preserves storageKey, seals password, and skips job history', async () => {
      vi.stubEnv('WEB_EXECUTION_MODE', 'queue-only');
      vi.spyOn(workerPresence, 'hasLiveQueueWorker').mockResolvedValue(true);
      const alice = await makeUser('qo_storage_key');

      const zipBytes = await buildZipBuffer([{ name: 'packed.txt', text: 'inside zip' }]);
      const key = await saveStoredObject(`uploads/${Date.now()}_qo.zip`, zipBytes, 'qo.zip');

      let capturedJobData: ConversionJobData | undefined;
      const origAdd = resourceQueues.cpu.add.bind(resourceQueues.cpu);
      vi.spyOn(resourceQueues.cpu, 'add').mockImplementation(async (name, data, opts) => {
        capturedJobData = data;
        return origAdd(name, data, opts);
      });

      const recordFileSpy = vi.spyOn(redisKeyStore, 'recordUserFile');
      // On local S3Storage, stat() reads objects map via this.getObject(), so stub stat() cleanly to isolate direct getObject() calls.
      const statSpy = vi.spyOn(storageProvider, 'stat').mockResolvedValue({
        size: zipBytes.length,
        etag: '"qo"',
        mimeType: 'application/zip',
        filename: 'qo.zip',
      });
      const getObjectSpy = vi.spyOn(storageProvider, 'getObject');

      // Run a real worker backed by processConversionJob -> processNodeJob -> processQueuedArchiveInspection
      const worker = new Worker<ConversionJobData, ConversionJobResult>(
        [resourceQueues.cpu],
        processConversionJob,
        { concurrency: 1 }
      );
      openWorkers.push(worker);

      const res = await postInspectJson(alice.headers, {
        storageKey: key,
        filename: 'custom-name.zip',
        password: 'top-secret-password',
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.format).toBe('zip');
      expect(body.entries.map((entry: { name: string }) => entry.name)).toEqual(['packed.txt']);

      // Web checked stat once and did not call getObject: only the worker called getObject once
      expect(statSpy).toHaveBeenCalledTimes(1);
      expect(getObjectSpy).toHaveBeenCalledTimes(1);
      expect(getObjectSpy).toHaveBeenCalledWith(key);
      statSpy.mockRestore();

      // Password was sealed before writing to queue, never plaintext
      expect(capturedJobData?.archiveInspect?.storageKey).toBe(key);
      expect(capturedJobData?.archiveInspect?.filename).toBe('custom-name.zip');
      expect(capturedJobData?.transientSyncWait).toBe(true);
      const queuedOptions = capturedJobData?.archiveInspect?.options as Record<string, unknown> | undefined;
      expect(queuedOptions?.password).toBeUndefined();
      expect(typeof queuedOptions?.sealedPassword).toBe('string');
      expect(JSON.stringify(capturedJobData)).not.toContain('top-secret-password');

      // Caller's storageKey was preserved in storage
      expect(await storageProvider.stat(key)).not.toBeNull();

      // Archive inspections never appear in user conversion history
      expect(recordFileSpy).not.toHaveBeenCalled();
    });

    it('stages multipart/raw bytes in queue-only mode, cleans up staged tempInputKey, and passes sealed password to worker', async () => {
      vi.stubEnv('WEB_EXECUTION_MODE', 'queue-only');
      vi.spyOn(workerPresence, 'hasLiveQueueWorker').mockResolvedValue(true);
      const alice = await makeUser('qo_multipart');
      const zipBytes = await buildZipBuffer([{ name: 'upload-entry.txt', text: 'hello' }]);

      let stagedKeySeen: string | undefined;
      let workerSawPassword: string | undefined;
      const worker = new Worker<ConversionJobData, ConversionJobResult>(
        [resourceQueues.cpu],
        async (job: Job<ConversionJobData, ConversionJobResult>) => {
          stagedKeySeen = job.data.archiveInspect?.storageKey;
          expect(stagedKeySeen).toMatch(/^uploads\//);
          const stored = await storageProvider.getObject(stagedKeySeen!);
          expect(stored?.buffer.equals(zipBytes)).toBe(true);
          const { openPasswordOption } = await import('../src/lib/queue/option-secrets');
          const opened = openPasswordOption(job.data.archiveInspect?.options ?? {}, job.id);
          workerSawPassword = opened.password;
          return processQueuedArchiveInspection(job, storageProvider);
        },
        { concurrency: 1 }
      );
      openWorkers.push(worker);

      const form = new FormData();
      form.append('file', new File([new Uint8Array(zipBytes)], 'uploaded.zip', { type: 'application/zip' }));
      form.append('password', 'multipart-secret');

      const res = await inspectRoute(
        new NextRequest(ROUTE_URL, {
          method: 'POST',
          headers: alice.headers,
          body: form,
        })
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries.map((entry: { name: string }) => entry.name)).toEqual(['upload-entry.txt']);
      expect(workerSawPassword).toBe('multipart-secret');

      // Staged temporary input key must be cleaned up by settleQueueOnlyCleanup
      expect(stagedKeySeen).toBeTruthy();
      expect(await storageProvider.stat(stagedKeySeen!)).toBeNull();
    });

    it('preserves 422 for ArchiveEncryptedHeaderError, MissingVolumeError, and ConversionFailedError, and 503 for EngineMissingError', async () => {
      vi.stubEnv('WEB_EXECUTION_MODE', 'queue-only');
      vi.spyOn(workerPresence, 'hasLiveQueueWorker').mockResolvedValue(true);
      const alice = await makeUser('qo_errors');
      const zipBytes = await buildZipBuffer([{ name: 'dummy.txt', text: 'x' }]);
      const key = await saveStoredObject(`uploads/${Date.now()}_err.zip`, zipBytes, 'err.zip');

      const scenarios = [
        {
          name: 'ArchiveEncryptedHeaderError',
          create: () => new ArchiveEncryptedHeaderError('Header encrypted; supply password'),
          expectedStatus: 422,
          expectedType: `${PROBLEM_TYPE_BASE}archive-encrypted-header`,
          expectedTitle: 'Archive Header Encrypted',
        },
        {
          name: 'MissingVolumeError',
          create: () => new MissingVolumeError('bundle.part2.rar'),
          expectedStatus: 422,
          expectedType: `${PROBLEM_TYPE_BASE}missing-archive-volume`,
          expectedTitle: 'Missing Archive Volume',
        },
        {
          name: 'ConversionFailedError',
          create: () => new ConversionFailedError('Unsupported or unrecognized archive format for inspection.'),
          expectedStatus: 422,
          expectedType: `${PROBLEM_TYPE_BASE}invalid-archive`,
          expectedTitle: 'Invalid Archive',
        },
        {
          name: 'EngineMissingError',
          create: () => new EngineMissingError('7z binary not installed at /usr/bin/7z'),
          expectedStatus: 503,
          expectedType: `${PROBLEM_TYPE_BASE}engine-unavailable`,
          expectedTitle: 'Engine Unavailable',
        },
      ];

      for (const scenario of scenarios) {
        const worker = new Worker<ConversionJobData, ConversionJobResult>(
          [resourceQueues.cpu],
          async () => {
            throw scenario.create();
          },
          { concurrency: 1 }
        );
        openWorkers.push(worker);

        const res = await postInspectJson(alice.headers, { storageKey: key });
        await openWorkers.pop()!.close();

        expect(res.status, scenario.name).toBe(scenario.expectedStatus);
        const body = await res.json();
        expect(body.type, scenario.name).toBe(scenario.expectedType);
        expect(body.title, scenario.name).toBe(scenario.expectedTitle);
        if (scenario.expectedStatus === 503) {
          expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
          expect(body.detail).not.toContain('/usr/bin/7z');
        }
      }

      // Server fault (>= 500) must answer 500 without leaking worker internal paths or collapsing to 422
      const crashWorker = new Worker<ConversionJobData, ConversionJobResult>(
        [resourceQueues.cpu],
        async () => {
          throw new Error('crash reading /tmp/worker-scratch/secret.zip');
        },
        { concurrency: 1 }
      );
      openWorkers.push(crashWorker);
      const crashRes = await postInspectJson(alice.headers, { storageKey: key });
      await openWorkers.pop()!.close();
      expect(crashRes.status).toBe(500);
      const crashBody = await crashRes.json();
      expect(crashBody.detail).toBe('Failed to inspect archive.');
      expect(JSON.stringify(crashBody)).not.toContain('/tmp/worker-scratch');

      // ConversionFailedError carrying numeric status >= 500 must also answer 500 rather than 422
      const faultWorker = new Worker<ConversionJobData, ConversionJobResult>(
        [resourceQueues.cpu],
        async () => {
          const fault = new ConversionFailedError('worker state corruption');
          (fault as { status?: number }).status = 500;
          throw fault;
        },
        { concurrency: 1 }
      );
      openWorkers.push(faultWorker);
      const faultRes = await postInspectJson(alice.headers, { storageKey: key });
      await openWorkers.pop()!.close();
      expect(faultRes.status).toBe(500);
      expect((await faultRes.json()).detail).toBe('Failed to inspect archive.');
    });

    it('rejects oversized multipart uploads lazily before buffering fileEntry.arrayBuffer()', async () => {
      const alice = await makeUser('lazy_multipart_413');
      const arrayBufferSpy = vi.fn(async () => new ArrayBuffer(0));
      const oversizedFile = new File([new Uint8Array(1)], 'huge.zip', { type: 'application/zip' });
      Object.defineProperty(oversizedFile, 'size', { value: SINGLE_REQUEST_FILE_MAX_BYTES + 1 });
      oversizedFile.arrayBuffer = arrayBufferSpy;

      const fakeForm = new FormData();
      vi.spyOn(fakeForm, 'get').mockImplementation((name: string) => (name === 'file' ? oversizedFile : null));

      const req = new NextRequest(ROUTE_URL, {
        method: 'POST',
        headers: {
          ...alice.headers,
          'Content-Type': 'multipart/form-data; boundary=lazy-test',
        },
      });
      Object.defineProperty(req, 'formData', { value: vi.fn(async () => fakeForm) });

      const res = await inspectRoute(req);
      expect(res.status).toBe(413);
      expect(arrayBufferSpy).not.toHaveBeenCalled();
    });

    it('never runs local inspectArchive or web getObject when dispatching { storageKey } to a remote worker', async () => {
      vi.stubEnv('WEB_EXECUTION_MODE', 'queue-only');
      vi.spyOn(workerPresence, 'hasLiveQueueWorker').mockResolvedValue(true);
      const alice = await makeUser('qo_web_isolation');
      const zipBytes = await buildZipBuffer([{ name: 'remote.txt', text: 'ok' }]);
      const key = await saveStoredObject(`uploads/${Date.now()}_isolation.zip`, zipBytes, 'isolation.zip');

      const statSpy = vi.spyOn(storageProvider, 'stat').mockResolvedValue({
        size: zipBytes.length,
        etag: '"iso"',
        mimeType: 'application/zip',
        filename: 'isolation.zip',
      });
      const getObjectSpy = vi.spyOn(storageProvider, 'getObject');
      const inspectSpy = vi.spyOn(conversions, 'inspectArchive');

      const worker = new Worker<ConversionJobData, ConversionJobResult>(
        [resourceQueues.cpu],
        async (job) => ({
          jobId: job.id,
          status: 'completed',
          resultKey: '',
          downloadUrl: '',
          filename: 'isolation.zip',
          mimeType: 'application/json',
          size: zipBytes.length,
          durationMs: 1,
          archiveInspection: {
            format: 'zip',
            totalEntries: 1,
            totalUncompressedBytes: 2,
            totalCompressedBytes: 2,
            isEncrypted: false,
            entries: [{ name: 'remote.txt', uncompressedSize: 2, isEncrypted: false, isDirectory: false }],
            extractable: true,
            unextractableReasons: [],
          },
        }),
        { concurrency: 1 }
      );
      openWorkers.push(worker);

      const res = await postInspectJson(alice.headers, { storageKey: key });
      expect(res.status).toBe(200);
      expect(statSpy).toHaveBeenCalledTimes(1);
      expect(getObjectSpy).not.toHaveBeenCalled();
      expect(inspectSpy).not.toHaveBeenCalled();
    });

    it('processQueuedArchiveInspection releases scoped stored object even when inspectArchive fails', async () => {
      const alice = await makeUser('worker_release');
      const encBytes = buildEncryptedHeaderRar();
      const key = await saveStoredObject(`uploads/${Date.now()}_worker_rel.rar`, encBytes, 'locked.rar');

      const releaseSpy = vi.fn(async () => undefined);
      const origGetObject = storageProvider.getObject.bind(storageProvider);
      const customStorage = {
        ...storageProvider,
        getObject: vi.fn(async (k: string) => {
          const obj = await origGetObject(k);
          if (!obj) return undefined;
          return { ...obj, buffer: obj.buffer, release: releaseSpy };
        }),
      };

      const fakeJob = {
        id: 'job_worker_rel_1',
        data: {
          jobId: 'job_worker_rel_1',
          originalFilename: 'locked.rar',
          sourceFormat: 'zip',
          targetFormat: 'zip',
          fileSize: encBytes.length,
          options: {},
          userId: alice.user.id,
          archiveInspect: { storageKey: key, filename: 'locked.rar' },
        },
      } as Job<ConversionJobData, ConversionJobResult>;

      await expect(processQueuedArchiveInspection(fakeJob, customStorage as never)).rejects.toThrow(
        ArchiveEncryptedHeaderError
      );
      expect(releaseSpy).toHaveBeenCalledTimes(1);
    });
  });
});
