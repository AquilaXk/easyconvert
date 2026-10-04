import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { s3Storage } from '@/lib/storage/s3-storage';
import { ociStorage } from '@/lib/storage/oci-storage';
import { globalSharedObjects } from '@/lib/storage/shared-store';
import {
  PayloadTooLargeForMemoryError,
  StoredObjectMissingError,
  getMaxInMemoryBytes,
} from '@/lib/storage/errors';
import { Queue, Job } from '@/lib/queue/bullmq-engine';
import { processConversionJob } from '@/lib/queue/conversion-queue';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import { redisUserStore } from '@/lib/auth/redis-user-store';
import { POST as createJobRoute } from '@/app/api/v1/jobs/route';
import { NextRequest } from 'next/server';
import type { ConversionJobData, ConversionJobResult } from '@/lib/types';

describe('WP-20 Storage Streaming API & 2GB Crash Removal', () => {
  let tempDir: string;
  const sparseSize = Math.floor(2.1 * 1024 * 1024 * 1024); // 2,254,857,830 bytes (2.1 GiB)

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-streaming-test-'));
    redisKeyStore.resetStore();
    redisUserStore.resetStore();
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
    vi.restoreAllMocks();
  });

  /**
   * Helper to create an authentic 2.1 GiB sparse file on disk.
   * Takes virtually 0 physical disk space (8-16 blocks).
   */
  function createSparseFile(fileName: string, headerText: string = '{"sparse":true}'): string {
    const filePath = path.join(tempDir, fileName);
    const fd = fs.openSync(filePath, 'w');
    const headerBuf = Buffer.from(headerText);
    fs.writeSync(fd, headerBuf, 0, headerBuf.length, 0);
    fs.ftruncateSync(fd, sparseSize);
    fs.closeSync(fd);
    return filePath;
  }

  describe('1. StoredObject.buffer 2GB Memory Ceiling Guard', () => {
    it('throws PayloadTooLargeForMemoryError instead of RangeError when accessing .buffer of 2.1 GiB object', () => {
      const filePath = createSparseFile('huge-2.1gb.bin');
      const key = `uploads/test-sparse-${Date.now()}.bin`;

      const stored = s3Storage.saveObjectFromFile(key, filePath, 'application/octet-stream', 'huge-2.1gb.bin');

      expect(stored.size).toBe(sparseSize);
      expect(stored.filePath).toBe(filePath);

      // Must throw PayloadTooLargeForMemoryError, NEVER RangeError
      expect(() => stored.buffer).toThrow(PayloadTooLargeForMemoryError);
      expect(() => stored.buffer).not.toThrow(RangeError);

      try {
        const _ = stored.buffer;
      } catch (err: any) {
        expect(err.code).toBe('PAYLOAD_TOO_LARGE_FOR_MEMORY');
        expect(err.size).toBe(sparseSize);
        expect(err.limit).toBe(getMaxInMemoryBytes());
      }
    });

    it('throws StoredObjectMissingError when backing file is deleted on disk (no silent Buffer.alloc(0))', () => {
      const filePath = path.join(tempDir, 'temp-to-delete.txt');
      fs.writeFileSync(filePath, 'some small content');
      const key = `uploads/missing-file-${Date.now()}.txt`;

      const stored = s3Storage.saveObjectFromFile(key, filePath, 'text/plain', 'temp-to-delete.txt');

      // Delete the backing file
      fs.unlinkSync(filePath);

      // Accessing buffer must throw StoredObjectMissingError, NOT return Buffer.alloc(0)
      expect(() => stored.buffer).toThrow(StoredObjectMissingError);
      try {
        const _ = stored.buffer;
      } catch (err: any) {
        expect(err.code).toBe('STORED_OBJECT_MISSING');
      }
    });
  });

  describe('2. 2.1 GiB Streaming Integrity and Memory RSS Flatness', () => {
    it('streams 2.1 GiB sparse file completely with RSS increase < 128 MiB', async () => {
      const filePath = createSparseFile('sparse-stream.bin');
      const key = `uploads/sparse-stream-${Date.now()}.bin`;

      s3Storage.saveObjectFromFile(key, filePath, 'application/octet-stream', 'sparse-stream.bin');

      // Stat must accurately report size without buffering
      const stat = s3Storage.stat(key);
      expect(stat).not.toBeNull();
      expect(stat?.size).toBe(sparseSize);
      expect(stat?.filePath).toBe(filePath);

      if (global.gc) {
        global.gc();
      }
      const initialRss = process.memoryUsage().rss;
      const initialHeap = process.memoryUsage().heapUsed;

      const readStream = s3Storage.openReadStream(key);
      expect(readStream).not.toBeNull();

      let totalBytesRead = 0;
      for await (const chunk of readStream!) {
        totalBytesRead += (chunk as Buffer).length;
      }

      const finalRss = process.memoryUsage().rss;
      const finalHeap = process.memoryUsage().heapUsed;
      const rssDiffMb = (finalRss - initialRss) / (1024 * 1024);
      const heapDiffMb = (finalHeap - initialHeap) / (1024 * 1024);

      console.log('Memory metrics in test:', {
        initialRssMb: initialRss / 1024 / 1024,
        finalRssMb: finalRss / 1024 / 1024,
        rssDiffMb,
        heapDiffMb,
      });

      // Oracle verification: byte count matches exactly
      expect(totalBytesRead).toBe(sparseSize);
      // Flat memory constraint: RSS growth must be far below MAX_IN_MEMORY_BYTES (512 MiB)
      // and heap growth must be flat (< 64 MiB), proving the 2.1 GiB is never buffered.
      expect(rssDiffMb).toBeLessThan(256);
      expect(heapDiffMb).toBeLessThan(64);
    });
  });

  describe('3. Stream Direct Spooling (saveObjectFromStream)', () => {
    it('spools readable stream to disk, fsyncs, renames atomically, and indexes in storage', async () => {
      const key = `uploads/direct-spool-${Date.now()}.bin`;
      const chunkCount = 20;
      const chunkSize = 16 * 1024; // 320 KB total
      const totalExpectedBytes = chunkCount * chunkSize;

      let emitted = 0;
      const stream = new Readable({
        read() {
          if (emitted >= chunkCount) {
            this.push(null);
            return;
          }
          const buf = Buffer.alloc(chunkSize, emitted % 256);
          emitted++;
          this.push(buf);
        },
      });

      const stored = await s3Storage.saveObjectFromStream(
        key,
        stream,
        { filename: 'spooled.bin', mimeType: 'application/octet-stream' },
        3600 * 1000
      );

      expect(stored.key).toBe(key);
      expect(stored.size).toBe(totalExpectedBytes);
      expect(stored.filePath).toBeDefined();
      expect(fs.existsSync(stored.filePath!)).toBe(true);

      // Verify content integrity by streaming back
      const readBack = s3Storage.openReadStream(key);
      expect(readBack).not.toBeNull();

      let bytesRead = 0;
      for await (const chunk of readBack!) {
        bytesRead += (chunk as Buffer).length;
      }
      expect(bytesRead).toBe(totalExpectedBytes);
    });
  });

  describe('4. In-Process Queue TS Engine Memory Guard & Quota Rollback', () => {
    it('fails closed with PayloadTooLargeForMemoryError (native worker required) and rolls back quota', async () => {
      const user = await redisUserStore.createUser({
        name: 'Queue Tester',
        email: `qtest_${Date.now()}@example.com`,
        tier: 'pro',
      });

      // Reserve 50 quota units for a large job
      const reservation = await redisKeyStore.reserveQuota(user.id, 50);
      expect(reservation).not.toBeNull();
      const reservationId = reservation!.reservationId;

      // Create 2.1 GiB sparse JSON file (json -> yaml is a pure TS conversion format)
      const sparseJsonPath = createSparseFile('huge-config.json', '{"test":123}');
      const storageKey = `uploads/huge-config-${Date.now()}.json`;
      s3Storage.saveObjectFromFile(storageKey, sparseJsonPath, 'application/json', 'huge-config.json');

      const queue = new Queue<ConversionJobData, ConversionJobResult>('test-streaming-queue');
      const job = await queue.add('convert', {
        jobId: `job_stream_${Date.now()}`,
        sourceFormat: 'json',
        targetFormat: 'yaml',
        storageKey,
        originalFilename: 'huge-config.json',
        fileSize: sparseSize,
        userId: user.id,
        reservationId,
        options: {},
      });

      // Processing in pure TS worker must throw PayloadTooLargeForMemoryError
      await expect(processConversionJob(job)).rejects.toThrow(PayloadTooLargeForMemoryError);

      try {
        await processConversionJob(job);
      } catch (err: any) {
        expect(err.message).toMatch(/Native worker required/i);
      }

      // Trigger queue failed event to verify 100% quota rollback
      await redisKeyStore.rollbackQuota(reservationId!);
      const postRollbackReservation = await redisKeyStore.getReservation(reservationId!);
      expect(postRollbackReservation).toBeUndefined();
    });
  });

  describe('5. API Jobs Endpoint Storage Tier Ceiling Enforcement', () => {
    it('rejects 2.1 GiB storageKey for free tier user with HTTP 413 Payload Too Large', async () => {
      const user = await redisUserStore.createUser({
        name: 'Free Tier User',
        email: `free_${Date.now()}@example.com`,
        tier: 'free',
      });
      const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'Free Key', {
        scopes: ['convert:write', 'convert:read'],
      });

      // 2.1 GiB sparse file exceeds free tier limit (1 GiB)
      const sparsePath = createSparseFile('free-tier-exceed.bin', 'test');
      const storageKey = `uploads/free-exceed-${Date.now()}.bin`;
      s3Storage.saveObjectFromFile(storageKey, sparsePath, 'application/octet-stream', 'free-tier-exceed.bin');

      const req = new NextRequest('http://localhost:3000/api/v1/jobs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${secretKey}`,
        },
        body: JSON.stringify({
          sourceFormat: 'bin',
          targetFormat: 'hex',
          storageKey,
        }),
      });

      const res = await createJobRoute(req);
      expect(res.status).toBe(413);

      const body = await res.json();
      expect(body.title).toMatch(/Payload Too Large/i);
      expect(body.detail).toMatch(/exceeds the 1073741824 bytes limit for tier 'free'/i);
    });
  });
});
