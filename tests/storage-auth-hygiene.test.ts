import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { processNodeJob, type ConversionEnginePort, type EngineResult } from '../src/lib/queue/node-processor';
import type { Job } from '../src/lib/queue/bullmq-engine';
import type { ConversionJobData } from '../src/lib/types';
import type { IStorageBackend, StoredObject } from '../src/lib/storage/types';
import { sweepWorkerSandboxDirs } from '../src/worker/sandbox-sweep';
import { JOB_STAGING_MAX_AGE_MS } from '../src/lib/storage/temp-file';
import { LocalFsStorage, localFsStorage } from '../src/lib/storage/local-fs-storage';
import { serializeTusMetadata, TusEngine } from '../src/lib/storage/tus-engine';
import { POST as jobsPostHandler } from '../src/app/api/v1/jobs/route';
import * as multipartBodyMod from '../src/lib/api/multipart-body';
import { PUT as directPartPutHandler } from '../src/app/api/v1/uploads/direct/part/route';
import { POST as uploadsPostHandler } from '../src/app/api/v1/uploads/[[...id]]/route';
import { POST as directInitHandler } from '../src/app/api/v1/uploads/direct/route';
import { POST as loginHandler } from '../src/app/api/auth/login/route';
import JSZip from 'jszip';
import { officeInputBytes } from '../src/worker/libreoffice-pool';
import {
  AzureBlobStorageAdapter,
  GcsStorageAdapter,
  StorageAdapterError,
  WebDavStorageAdapter,
} from '../src/lib/storage/adapters';
import { ADAPTER_RESPONSE_TIMEOUT_MS, adapterDispatcher } from '../src/lib/storage/adapters/http-guard';
import { presignSigV4QueryUrl } from '../src/lib/storage/sigv4-presigner';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { LOCAL_DIRECT_PART_PATH, LOCAL_EMULATION_REGION } from '../src/lib/storage/storage-config';
import { middleware } from '../src/middleware';
import { RedisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { createSessionToken, SESSION_COOKIE_NAME } from '../src/lib/auth/session';
import { AuthStoreUnavailableError } from '../src/lib/auth/store-unavailable';
import {
  checkLoginRateLimit,
  consumeMailLinkRateLimit,
  consumeRegistrationRateLimit,
  recordFailedLogin,
  resetLoginRateLimiterStore,
} from '../src/lib/auth/login-rate-limiter';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeFakeJob(id: string, data: Partial<ConversionJobData>): Job<ConversionJobData> {
  return {
    id,
    name: 'convert',
    data: {
      jobId: id,
      fileSize: 0,
      options: {},
      originalFilename: 'input.bin',
      sourceFormat: 'bin',
      targetFormat: 'bin',
      ...data,
    },
    opts: { attempts: 1, backoff: { type: 'fixed', delay: 0 } },
    attemptsMade: 1,
    timestamp: Date.now(),
    progress: 0,
    logs: [],
    signal: AbortSignal.timeout(60_000),
    updateProgress: async () => {},
    log: async () => {},
  } as unknown as Job<ConversionJobData>;
}

describe('Batch 2: Storage Lifecycle, Adapter SSRF/Credential Guards & Auth Hygiene', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    redisUserStore.resetStore();
    resetLoginRateLimiterStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('LOW-01: Unconditional worker temp-file cleanup & staged output sweep', () => {
    it('deletes intermediate stage files when a non-aborted multi-stage pipeline fails', async () => {
      const scratch = makeTempDir('ec-low01-fail-');
      tempDirs.push(scratch);
      const stage1Path = path.join(scratch, 'easyconvert-out-stage1.png');
      fs.writeFileSync(stage1Path, Buffer.from('stage1-bytes'));

      let calls = 0;
      const engine: ConversionEnginePort = {
        name: 'mock-pipeline-engine',
        async convert(): Promise<EngineResult> {
          calls++;
          if (calls === 1) {
            return {
              buffer: Buffer.alloc(0),
              filePath: stage1Path,
              size: 12,
              mimeType: 'image/png',
              filename: 'stage1.png',
            };
          }
          throw new Error('Stage 2 exploded without abort');
        },
      };

      const job = makeFakeJob(`job-low01-fail-${crypto.randomUUID()}`, {
        inputBufferBase64: Buffer.from('hello').toString('base64'),
        sourceFormat: 'svg',
        targetFormat: 'webp',
        originalFilename: 'in.svg',
        tasks: [
          { name: 's1', operation: 'convert', targetFormat: 'png' },
          { name: 's2', operation: 'convert', targetFormat: 'webp' },
        ],
      });

      await expect(processNodeJob(job, engine)).rejects.toThrow('Stage 2 exploded without abort');
      expect(fs.existsSync(stage1Path)).toBe(false);
    });

    it('deletes staged finalResult.filePath after remote-style saveObjectFromFile streams it without moving', async () => {
      const scratch = makeTempDir('ec-low01-ok-');
      tempDirs.push(scratch);
      const stagedOut = path.join(scratch, `easyconvert-out-${Date.now()}-final.txt`);
      fs.writeFileSync(stagedOut, Buffer.from('converted-output'));

      const engine: ConversionEnginePort = {
        name: 'mock-file-engine',
        async convert(): Promise<EngineResult> {
          return {
            buffer: Buffer.alloc(0),
            filePath: stagedOut,
            size: 16,
            mimeType: 'text/plain',
            filename: 'out.txt',
          };
        },
      };

      const remoteLikeStorage = {
        providerName: 'remote-mock',
        kind: 'remote' as const,
        async saveObjectFromFile(key: string, filePath: string, mimeType: string, filename: string): Promise<StoredObject> {
          const uploadedBytes = await fs.promises.readFile(filePath);
          const now = Date.now();
          return {
            key,
            filename,
            mimeType,
            buffer: uploadedBytes,
            size: uploadedBytes.length,
            etag: '"remote-etag"',
            uploadedAt: now,
            expiresAt: now + 60_000,
          };
        },
      } as unknown as IStorageBackend;

      const job = makeFakeJob(`job-low01-ok-${crypto.randomUUID()}`, {
        inputBufferBase64: Buffer.from('src').toString('base64'),
        sourceFormat: 'md',
        targetFormat: 'txt',
        originalFilename: 'in.md',
      });

      const res = await processNodeJob(job, engine, remoteLikeStorage);
      expect(res.status).toBe('completed');
      expect(fs.existsSync(stagedOut)).toBe(false);
    });

    it('sweeps stale easyconvert-out-* files in tmpRoot while keeping fresh ones', async () => {
      const tmpRoot = makeTempDir('ec-low01-sweep-');
      tempDirs.push(tmpRoot);
      const now = Date.now();
      const staleTs = now - JOB_STAGING_MAX_AGE_MS - 60_000;
      const freshTs = now - 5_000;

      const staleOut = path.join(tmpRoot, `easyconvert-out-${staleTs}-${crypto.randomUUID()}.pdf`);
      const freshOut = path.join(tmpRoot, `easyconvert-out-${freshTs}-${crypto.randomUUID()}.pdf`);
      fs.writeFileSync(staleOut, 'old');
      fs.writeFileSync(freshOut, 'new');

      const removed = sweepWorkerSandboxDirs({ directory: tmpRoot, now });
      expect(removed).toEqual([path.basename(staleOut)]);
      expect(fs.existsSync(staleOut)).toBe(false);
      expect(fs.existsSync(freshOut)).toBe(true);
    });
  });

  describe('LOW-02: Async collision-free TUS finalization', () => {
    it('mints distinct ETags for two TUS sessions finalized in the same millisecond without sync copyFileSync', async () => {
      const tusDir = makeTempDir('ec-low02-tus-');
      tempDirs.push(tusDir);
      const copySyncSpy = vi.spyOn(fs, 'copyFileSync');
      const engine = new TusEngine({ tusDir });

      const user = redisUserStore.sanitizeUser(
        await redisUserStore.createUser({ email: `tus_${crypto.randomUUID()}@example.com`, name: 'TUS', tier: 'paid' })
      );

      const s1 = await engine.createSession({
        uploadLength: 4,
        metadataHeader: serializeTusMetadata({ filename: 'a.bin', filetype: 'application/octet-stream' }),
        ownerUserId: user.id,
      });
      const s2 = await engine.createSession({
        uploadLength: 4,
        metadataHeader: serializeTusMetadata({ filename: 'b.bin', filetype: 'application/octet-stream' }),
        ownerUserId: user.id,
      });

      const fixedNow = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(fixedNow);

      await engine.appendChunk(s1.id, 0, Readable.from([Buffer.from('aaaa')]));
      await engine.appendChunk(s2.id, 0, Readable.from([Buffer.from('bbbb')]));

      expect(copySyncSpy).not.toHaveBeenCalled();
      const head1 = await localFsStorage.head(s1.key);
      const head2 = await localFsStorage.head(s2.key);
      expect(head1).not.toBeNull();
      expect(head2).not.toBeNull();
      expect(head1!.etag).not.toBe(head2!.etag);
    });
  });

  describe('LOW-03: Single-pass multipart parsing with Idempotency-Key on POST /api/v1/jobs', () => {
    it('parses multipart FormData once when Idempotency-Key is supplied and rejects conflicting payload reuse', async () => {
      const user = redisUserStore.sanitizeUser(
        await redisUserStore.createUser({
          email: `idem_${crypto.randomUUID()}@example.com`,
          name: 'Idem',
          tier: 'paid',
          emailVerified: true,
        })
      );
      const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken(user)}`;
      const idemKey = `idem-low03-${crypto.randomUUID()}`;

      const formDataSpy = vi.spyOn(Request.prototype, 'formData');
      const readSpy = vi.spyOn(multipartBodyMod, 'readMultipartForm');
      const form1 = new FormData();
      form1.set('file', new File([Buffer.from('hello world\n')], 'note.txt', { type: 'text/plain' }));
      form1.set('targetFormat', 'md');

      const req1 = new NextRequest('http://localhost:3000/api/v1/jobs', {
        method: 'POST',
        headers: { Cookie: cookie, 'Idempotency-Key': idemKey },
        body: form1,
      });
      const bodyReaderSpy = vi.spyOn(req1.body!, 'getReader');

      const res1 = await jobsPostHandler(req1);
      expect(res1.status).toBe(202);
      expect(formDataSpy).not.toHaveBeenCalled();
      expect(bodyReaderSpy).toHaveBeenCalledTimes(1);
      expect(readSpy).toHaveBeenCalledTimes(2);

      // Replaying same Idempotency-Key with different file bytes must return 422 conflict
      const form2 = new FormData();
      form2.set('file', new File([Buffer.from('different bytes\n')], 'note.txt', { type: 'text/plain' }));
      form2.set('targetFormat', 'md');
      const req2 = new NextRequest('http://localhost:3000/api/v1/jobs', {
        method: 'POST',
        headers: { Cookie: cookie, 'Idempotency-Key': idemKey },
        body: form2,
      });
      const res2 = await jobsPostHandler(req2);
      expect(res2.status).toBe(422);
    });
  });

  describe('LOW-04: Tail-only ZIP uncompressed size scan & cached async LocalFsStorage sweep', () => {
    it('computes officeInputBytes from ZIP central directory without fs.readFileSync of full archive', async () => {
      const dir = makeTempDir('ec-low04-zip-');
      tempDirs.push(dir);
      const payloadA = Buffer.alloc(64 * 1024, 0x41);
      const payloadB = Buffer.alloc(96 * 1024, 0x42);
      const zip = new JSZip();
      zip.file('word/document.xml', payloadA, { compression: 'DEFLATE' });
      zip.file('word/styles.xml', payloadB, { compression: 'DEFLATE' });
      const zipBytes = await zip.generateAsync({ type: 'nodebuffer' });
      const zipPath = path.join(dir, 'sample.docx');
      fs.writeFileSync(zipPath, zipBytes);

      const readFileSyncSpy = vi.spyOn(fs, 'readFileSync');
      const computed = officeInputBytes(zipPath);
      expect(readFileSyncSpy).not.toHaveBeenCalled();
      expect(computed).toBe(payloadA.length + payloadB.length);
    });

    it('sweeps expired LocalFsStorage objects asynchronously without re-reading unexpired .meta.json on repeat sweeps', async () => {
      const storageDir = makeTempDir('ec-low04-lfs-');
      tempDirs.push(storageDir);
      const store = new LocalFsStorage({ storageDir });
      store.stopGc();

      const now = Date.now();
      await store.putBuffer('expired-key', Buffer.from('old'), {
        contentType: 'text/plain',
        filename: 'old.txt',
        ttlSeconds: 1,
      });
      await store.putBuffer('live-key', Buffer.from('live'), {
        contentType: 'text/plain',
        filename: 'live.txt',
        ttlSeconds: 3600,
      });

      const readSyncSpy = vi.spyOn(fs, 'readFileSync');
      const swept1 = await store.sweepExpiredObjects(now + 5_000);
      expect(swept1).toBe(1);
      expect(readSyncSpy).not.toHaveBeenCalled();
      expect(await store.head('expired-key')).toBeNull();
      expect(await store.head('live-key')).not.toBeNull();

      const asyncReadSpy = vi.spyOn(fs.promises, 'readFile');
      const swept2 = await store.sweepExpiredObjects(now + 6_000);
      expect(swept2).toBe(0);
      expect(asyncReadSpy).not.toHaveBeenCalled();
    });
  });

  describe('SEC-05: BYOS endpoint URL hygiene, GCS token host pinning & bodyTimeout', () => {
    it('rejects query, fragment, and userinfo on WebDAV, Azure customEndpoint, and GCS endpoint without echoing secrets', () => {
      expect(() =>
        new WebDavStorageAdapter({
          type: 'webdav',
          url: 'https://dav-user:TopSecretPass99@dav.example.com/remote.php/dav',
          username: 'u',
          password: 'p',
        })
      ).toThrow(StorageAdapterError);

      try {
        new WebDavStorageAdapter({
          type: 'webdav',
          url: 'https://dav.example.com/dav?token=SuperSecretQuery',
          username: 'u',
          password: 'p',
        });
        expect.unreachable('Expected StorageAdapterError');
      } catch (err) {
        expect(err).toBeInstanceOf(StorageAdapterError);
        expect((err as Error).message).not.toContain('SuperSecretQuery');
      }

      expect(() =>
        new AzureBlobStorageAdapter({
          type: 'azure-blob',
          storageAccount: 'acct',
          containerName: 'ctr',
          sasToken: 'sv=2022-11-02&sig=abc',
          customEndpoint: 'https://acct.blob.core.windows.net#frag',
        })
      ).toThrow(StorageAdapterError);

      expect(() =>
        new GcsStorageAdapter({
          type: 'gcs',
          bucket: 'bkt',
          endpoint: 'https://storage.googleapis.com?alt=media',
        })
      ).toThrow(StorageAdapterError);
    });

    it('refuses GCS service-account credentials on non-Google endpoints and configures bodyTimeout', async () => {
      expect(() =>
        new GcsStorageAdapter({
          type: 'gcs',
          bucket: 'bkt',
          clientEmail: 'sa@proj.iam.gserviceaccount.com',
          privateKey: '-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----',
          endpoint: 'https://evil-collector.example.com',
        })
      ).toThrow(StorageAdapterError);

      const agent = adapterDispatcher('https://storage.googleapis.com');
      try {
        expect(ADAPTER_RESPONSE_TIMEOUT_MS).toBeGreaterThan(0);
        expect(typeof agent.destroy).toBe('function');
      } finally {
        await agent.destroy();
      }
    });
  });

  describe('SEC-06: SigV4 accessKeyId/duplicate-param checks & strict positive TUS Upload-Length', () => {
    it('refuses SigV4 part URLs signed with an unexpected accessKeyId or duplicate query parameters', async () => {
      const user = redisUserStore.sanitizeUser(
        await redisUserStore.createUser({
          email: `sigv4_${crypto.randomUUID()}@example.com`,
          name: 'SigV4',
          tier: 'paid',
          emailVerified: true,
        })
      );
      const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken(user)}`;
      const initRes = await directInitHandler(
        new NextRequest('http://localhost:3000/api/v1/uploads/direct', {
          method: 'POST',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: 'part.bin', mimeType: 'application/octet-stream', totalSize: 16 }),
        })
      );
      expect(initRes.status).toBe(200);
      const session = await initRes.json();

      // Signed with valid secretAccessKey, but wrong accessKeyId
      const wrongKeyPresign = presignSigV4QueryUrl({
        method: 'PUT',
        url: `http://localhost:3000${LOCAL_DIRECT_PART_PATH}`,
        queryParams: { uploadId: session.uploadId, partNumber: 1, key: session.key },
        credentials: {
          accessKeyId: 'wrong-access-key-id',
          secretAccessKey: s3Storage.getSigningSecret(),
          region: LOCAL_EMULATION_REGION,
          service: 's3',
        },
        expiresInSeconds: 300,
      });

      const wrongKeyRes = await directPartPutHandler(
        new NextRequest(wrongKeyPresign.url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '4' },
          body: Buffer.from('abcd'),
        })
      );
      expect(wrongKeyRes.status).toBe(403);

      // Duplicate parameter smuggling on legitimate presigned URL
      const validUrl = `${session.parts[0].uploadUrl}&partNumber=2`;
      const dupRes = await directPartPutHandler(
        new NextRequest(validUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '4' },
          body: Buffer.from('abcd'),
        })
      );
      expect([400, 403]).toContain(dupRes.status);
    });

    it('rejects zero-byte and non-digits Upload-Length on POST /api/v1/uploads', async () => {
      const user = redisUserStore.sanitizeUser(
        await redisUserStore.createUser({
          email: `tuslen_${crypto.randomUUID()}@example.com`,
          name: 'TusLen',
          tier: 'paid',
          emailVerified: true,
        })
      );
      const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken(user)}`;

      for (const badLen of ['0', '16bytes']) {
        const res = await uploadsPostHandler(
          new NextRequest('http://localhost:3000/api/v1/uploads', {
            method: 'POST',
            headers: {
              Cookie: cookie,
              'Tus-Resumable': '1.0.0',
              'Upload-Length': badLen,
            },
          }),
          { params: Promise.resolve({}) }
        );
        expect(res.status).toBe(400);
      }
    });
  });

  describe('SEC-07: Production APP_ORIGIN CSRF pinning, atomic RedisKeyStore Lua, fail-closed login rate limiter', () => {
    it('rejects forged Host/Origin mismatch when APP_ORIGIN is configured in production', async () => {
      const prevEnv = process.env.NODE_ENV;
      const prevOrigin = process.env.APP_ORIGIN;
      const prevSecret = process.env.JWT_SECRET;
      const prevTrusted = process.env.TRUSTED_PROXIES;
      try {
        (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
        process.env.APP_ORIGIN = 'https://app.easyconvert.example';
        process.env.JWT_SECRET = 'prod-csrf-test-secret-with-32-chars!!';
        process.env.TRUSTED_PROXIES = 'none';

        const req = new NextRequest('https://evil.example/api/keys', {
          method: 'POST',
          headers: {
            host: 'evil.example',
            origin: 'https://evil.example',
            cookie: `${SESSION_COOKIE_NAME}=some-session-cookie`,
          },
        });

        const res = await middleware(req);
        expect(res.status).toBe(403);
      } finally {
        (process.env as Record<string, string | undefined>).NODE_ENV = prevEnv;
        if (prevOrigin === undefined) delete process.env.APP_ORIGIN;
        else process.env.APP_ORIGIN = prevOrigin;
        if (prevSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = prevSecret;
        if (prevTrusted === undefined) delete process.env.TRUSTED_PROXIES;
        else process.env.TRUSTED_PROXIES = prevTrusted;
      }
    });

    it('uses atomic Lua eval in RedisKeyStore.generateApiKey and deleteApiKey when Redis supports eval', async () => {
      const store = new RedisKeyStore();
      const evalCalls: Array<{ script: string; numKeys: number; args: unknown[] }> = [];
      const mockRedis = {
        eval: vi.fn(async (script: string, numKeys: number, ...args: unknown[]) => {
          evalCalls.push({ script, numKeys, args });
          return script.includes("'DELETED'") ? 'DELETED' : 'CREATED';
        }),
        hset: vi.fn(async () => 1),
        hdel: vi.fn(async () => 1),
        sadd: vi.fn(async () => 1),
        srem: vi.fn(async () => 1),
        del: vi.fn(async () => 1),
        hgetall: vi.fn(async () => ({})),
      };
      store.setRedisClient(mockRedis as never);

      const created = await store.generateApiKey('usr_atomic_1', 'Atomic Key');
      expect(evalCalls.length).toBe(1);
      expect(mockRedis.hset).not.toHaveBeenCalled();

      const deleted = await store.deleteApiKey('usr_atomic_1', created.key.id);
      expect(deleted).toBe(true);
      expect(evalCalls.length).toBe(2);
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('fails closed with AuthStoreUnavailableError (HTTP 503) when configured Redis fails in login-rate-limiter', async () => {
      const brokenRedis = {
        get: vi.fn(async () => {
          throw new Error('ECONNRESET');
        }),
        ttl: vi.fn(async () => {
          throw new Error('ECONNRESET');
        }),
        pipeline: vi.fn(() => ({
          set: () => {},
          incr: () => {},
          ttl: () => {},
          exec: async () => {
            throw new Error('ECONNRESET');
          },
        })),
        del: vi.fn(async () => {
          throw new Error('ECONNRESET');
        }),
      };

      redisUserStore.setRedisClient(brokenRedis as never);
      try {
        await expect(checkLoginRateLimit('198.51.100.10', 'alice@example.com')).rejects.toThrow(
          AuthStoreUnavailableError
        );
        await expect(recordFailedLogin('198.51.100.10', 'alice@example.com')).rejects.toThrow(
          AuthStoreUnavailableError
        );
        await expect(consumeRegistrationRateLimit('198.51.100.10')).rejects.toThrow(AuthStoreUnavailableError);
        await expect(consumeMailLinkRateLimit('reset-request', '198.51.100.10', 'alice@example.com')).rejects.toThrow(
          AuthStoreUnavailableError
        );

        const loginRes = await loginHandler(
          new NextRequest('http://localhost:3000/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '198.51.100.10' },
            body: JSON.stringify({ email: 'alice@example.com', password: 'Password123!' }),
          })
        );
        expect(loginRes.status).toBe(503);
      } finally {
        redisUserStore.setRedisClient(null);
      }
    });
  });
});
