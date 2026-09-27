import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  Queue,
  Worker,
  Job,
  DistributedBullMQAdapter,
  createQueueEngine,
  calculateBackoffWithJitter,
  subscribeToJobTelemetry,
  DlqEntry,
} from '../src/lib/queue/bullmq-engine';
import {
  OciObjectStorageService,
  S3CompatibleStorageBackend,
  ociStorage,
} from '../src/lib/storage/oci-storage';
import { POST as multipartPost } from '../src/app/api/storage/multipart/route';
import { NextRequest } from 'next/server';

describe('Phase 5: Distributed Queue Engine, DLQ & Chunk Streaming Storage', () => {
  describe('1. Backoff with Jitter Calculations', () => {
    it('computes exponential backoff bounded by maxDelayMs with randomized jitter', () => {
      const baseDelay = 500;
      const maxDelay = 4000;

      for (let attempt = 1; attempt <= 6; attempt++) {
        const delay = calculateBackoffWithJitter(attempt, baseDelay, maxDelay);
        expect(delay).toBeGreaterThanOrEqual(10);
        expect(delay).toBeLessThanOrEqual(maxDelay);
      }

      // Upper attempt should never exceed maxDelay
      const lateDelay = calculateBackoffWithJitter(10, baseDelay, maxDelay);
      expect(lateDelay).toBeLessThanOrEqual(maxDelay);
    });

    it('generates distributed random values across multiple calls for same attempt', () => {
      const samples = Array.from({ length: 15 }, () => calculateBackoffWithJitter(3, 1000, 10000));
      const allIdentical = samples.every((v) => v === samples[0]);
      expect(allIdentical).toBe(false);
    });
  });

  describe('2. Queue Engine, Worker, and DLQ Lifecycle', () => {
    let queue: Queue;

    beforeEach(() => {
      queue = new Queue('test-phase5-queue');
    });

    afterEach(async () => {
      await queue.close();
    });

    it('creates jobs, transitions states, and updates progress and logs', async () => {
      const job = await queue.add('test-task', { foo: 'bar' });
      expect(job.id).toBeDefined();
      expect(job.name).toBe('test-task');
      expect(job.state).toBe('waiting');

      await job.updateProgress(50);
      expect(job.progress).toBe(50);

      await job.log('Processing step 1 completed');
      expect(job.logs).toHaveLength(1);
      expect(job.logs[0]).toContain('Processing step 1 completed');
    });

    it('supports manual and automatic eviction to Dead-Letter Queue (DLQ)', async () => {
      const job = await queue.add('failing-task', { test: true }, { attempts: 1 });
      const dlqEvents: DlqEntry[] = [];
      queue.on('dlq', (entry) => dlqEvents.push(entry));

      await queue.moveToDlq(job, 'Simulated critical parser error');

      const dlqEntries = await queue.getDlqEntries();
      expect(dlqEntries).toHaveLength(1);
      expect(dlqEntries[0].jobId).toBe(job.id);
      expect(dlqEntries[0].failedReason).toBe('Simulated critical parser error');
      expect(dlqEvents).toHaveLength(1);

      const purgedCount = await queue.purgeDlq();
      expect(purgedCount).toBe(1);

      const emptyDlq = await queue.getDlqEntries();
      expect(emptyDlq).toHaveLength(0);
    });

    it('Worker executes jobs and automatically pushes exhausted jobs to DLQ', async () => {
      const dlqPromise = new Promise<DlqEntry>((resolve) => {
        queue.on('dlq', (entry) => resolve(entry));
      });

      const worker = new Worker(
        queue,
        async () => {
          throw new Error('Fatal transcoding exception');
        },
        { concurrency: 1 }
      );

      await queue.add('job-to-fail', { file: 'corrupt.bin' }, { attempts: 1 });

      const dlqEntry = await dlqPromise;
      expect(dlqEntry).toBeDefined();
      expect(dlqEntry.name).toBe('job-to-fail');
      expect(dlqEntry.failedReason).toBe('Fatal transcoding exception');

      await worker.close();
    });

    it('Worker retries with backoff until attempts are exhausted', async () => {
      let callCount = 0;
      const worker = new Worker(
        queue,
        async () => {
          callCount++;
          if (callCount < 2) {
            throw new Error('Temporary network timeout');
          }
          return { success: true };
        },
        { concurrency: 1 }
      );

      const job = await queue.add('retryable-job', {}, {
        attempts: 2,
        backoff: { type: 'fixed', delay: 20 },
      });

      await new Promise<void>((resolve) => {
        worker.on('completed', (j) => {
          if (j.id === job.id) resolve();
        });
      });

      expect(callCount).toBe(2);
      expect(job.state).toBe('completed');
      expect(job.returnvalue).toEqual({ success: true });

      await worker.close();
    });
  });

  describe('3. DistributedBullMQAdapter & Factory', () => {
    it('initializes distributed adapter and responds to ping', async () => {
      const adapter = new DistributedBullMQAdapter('cluster-queue');
      const pingResult = await adapter.ping();

      expect(pingResult.ok).toBe(true);
      expect(pingResult.latencyMs).toBeGreaterThanOrEqual(0);

      const job = await adapter.add('cluster-job', { data: 123 });
      expect(job.id).toBeDefined();

      const dlqEntries = await adapter.getDlqEntries();
      expect(dlqEntries).toEqual([]);

      await adapter.close();
    });

    it('createQueueEngine instantiates appropriate engine based on environment options', () => {
      const localQueue = createQueueEngine('local-q', { distributed: false });
      expect(localQueue.isDistributed).toBe(false);

      const distQueue = createQueueEngine('dist-q', { distributed: true });
      expect(distQueue.isDistributed).toBe(true);
    });
  });

  describe('4. SSE Telemetry Streaming', () => {
    it('subscribes to job telemetry events and unsubscribes cleanly', async () => {
      const queue = new Queue('telemetry-queue');
      const job = await queue.add('telemetry-task', {});

      const events: any[] = [];
      const unsubscribe = subscribeToJobTelemetry(queue, job.id, (event) => {
        events.push(event);
      });

      await job.updateProgress(25);
      await job.updateProgress(75);

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        event: 'progress',
        data: { jobId: job.id, progress: 25, state: 'waiting' },
      });
      expect(events[1]).toEqual({
        event: 'progress',
        data: { jobId: job.id, progress: 75, state: 'waiting' },
      });

      unsubscribe();

      await job.updateProgress(100);
      expect(events).toHaveLength(2); // No new events after unsubscription

      await queue.close();
    });
  });

  describe('5. OCI / S3 Presigned URL Generation and Verification', () => {
    const oci = new OciObjectStorageService();
    const s3 = new S3CompatibleStorageBackend();

    afterEach(() => {
      oci.stopGc();
      s3.stopGc();
    });

    it('generates secure presigned upload URLs with HMAC signature', () => {
      const key = 'uploads/test-key-123.dat';
      const uploadId = 'test-upload-id';
      const partNumber = 1;

      const presigned = oci.generatePresignedUploadUrl(key, partNumber, uploadId, 3600);
      expect(presigned.url).toContain(key);
      expect(presigned.url).toContain(uploadId);
      expect(presigned.url).toContain('partNumber=1');
      expect(presigned.signature).toBeDefined();

      const isValid = oci.verifyPresignedSignature(
        'PUT',
        key,
        presigned.expiresAt,
        presigned.signature,
        uploadId,
        partNumber
      );
      expect(isValid).toBe(true);
    });

    it('generates secure presigned download URLs with HMAC signature', () => {
      const key = 'results/output-file.pdf';
      const presigned = s3.generatePresignedDownloadUrl(key, 1800);

      expect(presigned.url).toContain(key);
      expect(presigned.url).toContain('signature=');

      const isValid = s3.verifyPresignedSignature(
        'GET',
        key,
        presigned.expiresAt,
        presigned.signature
      );
      expect(isValid).toBe(true);
    });

    it('fails closed when signature is tampered or expired', () => {
      const key = 'secure/contract.docx';
      const presigned = oci.generatePresignedDownloadUrl(key, 3600);

      // Tampered signature
      const tampered = '0'.repeat(64);
      expect(oci.verifyPresignedSignature('GET', key, presigned.expiresAt, tampered)).toBe(false);

      // Expired timestamp
      const expiredTimestamp = Math.floor(Date.now() / 1000) - 100;
      expect(oci.verifyPresignedSignature('GET', key, expiredTimestamp, presigned.signature)).toBe(false);
    });
  });

  describe('6. Multipart Route Presigned Endpoint', () => {
    it('handles action=presign for chunk upload', async () => {
      const req = new NextRequest('http://localhost:3000/api/storage/multipart?action=presign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'upload',
          key: 'n/test_ns/b/test_bucket/o/chunk_001.bin',
          uploadId: 'up_test_999',
          partNumber: 1,
          expiresInSeconds: 600,
        }),
      });

      const res = await multipartPost(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.url).toBeDefined();
      expect(json.signature).toBeDefined();
      expect(json.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('handles action=presign for download', async () => {
      const req = new NextRequest('http://localhost:3000/api/storage/multipart?action=presign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'download',
          key: 'n/test_ns/b/test_bucket/o/converted.pdf',
          expiresInSeconds: 1200,
        }),
      });

      const res = await multipartPost(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.url).toBeDefined();
      expect(json.signature).toBeDefined();
    });

    it('rejects presign request with missing required parameters with HTTP 400', async () => {
      const req = new NextRequest('http://localhost:3000/api/storage/multipart?action=presign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'upload',
          // Missing key, uploadId, and partNumber
        }),
      });

      const res = await multipartPost(req);
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain('Missing required "key"');
    });
  });
});
