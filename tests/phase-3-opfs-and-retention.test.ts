import { describe, it, expect, vi } from 'vitest';
import {
  OPFS_CHUNK_SIZE,
  calculateChunkCount,
  OpfsStreamTransformer,
  resolveChunkTransformer,
  processOpfsStreaming,
} from '../src/lib/edge/workers/opfs-vfs.worker';
import {
  createSessionId,
  destroySessionImmediately,
  registerZeroRetentionLifecycleHooks,
} from '../src/lib/edge/opfs/storage-gc';
import { streamConvertWithOpfs } from '../src/lib/edge/pipelines/opfs-streaming-pipeline';
import {
  Queue,
  Worker,
  createQueueEngine,
  DistributedBullMQAdapter,
  IQueueEngine,
} from '../src/lib/queue/bullmq-engine';
import {
  ociStorage,
  s3Storage,
  getStorageBackend,
  S3CompatibleStorageBackend,
  IStorageBackend,
} from '../src/lib/storage/s3-storage';

describe('Phase 3: OPFS Streaming VFS, Immediate Zero-Retention Disposal & Distributed Interfaces', () => {
  describe('1. Level 3 OPFS Streaming VFS Chunk Transcoders', () => {
    it('accurately resolves and executes Audio PCM Endianness swap (pcm -> pcm_be)', async () => {
      const transformer = resolveChunkTransformer('pcm', 'pcm_be');
      // Little-endian 16-bit samples: [0x12, 0x34, 0x56, 0x78]
      const input = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
      const transformed = await transformer(input, 0, input.length);

      // Big-endian swapped: [0x34, 0x12, 0x78, 0x56]
      expect(transformed).toEqual(new Uint8Array([0x34, 0x12, 0x78, 0x56]));
    });

    it('accurately resolves and executes Audio 16-bit signed to 8-bit unsigned PCM (pcm -> pcm_u8)', async () => {
      const transformer = resolveChunkTransformer('pcm', 'pcm_u8');
      // 2 samples: 0 (silence) and 32767 (max positive) in 16-bit little endian
      const buf = new ArrayBuffer(4);
      const view = new DataView(buf);
      view.setInt16(0, 0, true); // silence -> ~128 unsigned
      view.setInt16(2, 32767, true); // max -> 255 unsigned

      const transformed = await transformer(new Uint8Array(buf), 0, 4);
      expect(transformed.length).toBe(2);
      expect(transformed[0]).toBe(128);
      expect(transformed[1]).toBe(255);
    });

    it('transforms CSV to TSV while strictly preserving commas within quoted cells', async () => {
      const transformer = resolveChunkTransformer('csv', 'tsv');
      const csvData = 'id,name,notes\n1,"Doe, John",Engineer\n2,"Smith, Alice",Scientist';
      const input = new TextEncoder().encode(csvData);
      const transformed = await transformer(input, 0, input.length);
      const tsvText = new TextDecoder().decode(transformed);

      expect(tsvText).toContain('id\tname\tnotes');
      expect(tsvText).toContain('1\t"Doe, John"\tEngineer');
      expect(tsvText).toContain('2\t"Smith, Alice"\tScientist');
    });

    it('preserves CSV quoted string state across multiple sequential streaming chunk boundaries', async () => {
      const transformer = resolveChunkTransformer('csv', 'tsv');
      // Chunk 1 ends inside a quoted field: '"Doe, '
      const chunk1Str = 'id,name,role\n101,"Doe, ';
      // Chunk 2 continues and closes the quoted field: 'Jane",Manager\n'
      const chunk2Str = 'Jane",Manager\n';

      const res1 = await transformer(new TextEncoder().encode(chunk1Str), 0, chunk1Str.length + chunk2Str.length);
      const res2 = await transformer(new TextEncoder().encode(chunk2Str), chunk1Str.length, chunk1Str.length + chunk2Str.length);

      const combinedText = new TextDecoder().decode(res1) + new TextDecoder().decode(res2);
      expect(combinedText).toContain('id\tname\trole');
      // The comma inside "Doe, Jane" MUST NOT be converted to tab
      expect(combinedText).toContain('101\t"Doe, Jane"\tManager');
    });

    it('handles odd-length byte chunks without sample misalignment or data corruption in PCM streaming', async () => {
      const transformer = resolveChunkTransformer('pcm', 'pcm_be');
      // 3 bytes in chunk 1 (1.5 samples), 3 bytes in chunk 2 (1.5 samples) -> 3 complete samples
      // Samples in LE: [0x11, 0x22], [0x33, 0x44], [0x55, 0x66]
      const chunk1 = new Uint8Array([0x11, 0x22, 0x33]); // 0x33 is first half of sample 2
      const chunk2 = new Uint8Array([0x44, 0x55, 0x66]); // 0x44 completes sample 2, [0x55, 0x66] is sample 3

      const out1 = await transformer(chunk1, 0, 6);
      const out2 = await transformer(chunk2, 3, 6);

      // Expected swapped BE: [0x22, 0x11], [0x44, 0x33], [0x66, 0x55]
      const combined = new Uint8Array(out1.length + out2.length);
      combined.set(out1, 0);
      combined.set(out2, out1.length);

      expect(combined).toEqual(new Uint8Array([0x22, 0x11, 0x44, 0x33, 0x66, 0x55]));
    });

    it('transforms raw RGBA stream to fixed-point Grayscale preserving Alpha channel', async () => {
      const transformer = resolveChunkTransformer('rgba', 'grayscale');
      // 2 pixels: Pure Red (255, 0, 0, 255), Pure Green (0, 255, 0, 200)
      const input = new Uint8Array([
        255, 0, 0, 255,
        0, 255, 0, 200,
      ]);
      const transformed = await transformer(input, 0, input.length);

      // Pixel 1: (77 * 255) >> 8 = 76
      expect(transformed[0]).toBe(76);
      expect(transformed[1]).toBe(76);
      expect(transformed[2]).toBe(76);
      expect(transformed[3]).toBe(255);

      // Pixel 2: (150 * 255) >> 8 = 149
      expect(transformed[4]).toBe(149);
      expect(transformed[5]).toBe(149);
      expect(transformed[6]).toBe(149);
      expect(transformed[7]).toBe(200); // Alpha preserved
    });

    it('supports custom chunk transformers via options and bounds peak memory usage', async () => {
      const customFn = vi.fn((chunk: Uint8Array) => {
        const out = new Uint8Array(chunk.length);
        out.fill(0xaa);
        return out;
      });

      const transformer = new OpfsStreamTransformer(1024);
      const readSpy = vi.fn(async (_offset: number, size: number) => new Uint8Array(size));
      const chunksWritten: Uint8Array[] = [];
      const writeSpy = vi.fn(async (_offset: number, data: Uint8Array) => {
        chunksWritten.push(data);
      });

      const totalSize = 4096;
      const totalWritten = await transformer.transformChunked(
        totalSize,
        readSpy,
        writeSpy,
        undefined,
        customFn
      );

      expect(totalWritten).toBe(totalSize);
      expect(customFn).toHaveBeenCalledTimes(4); // 4096 / 1024 = 4 chunks
      expect(chunksWritten[0][0]).toBe(0xaa);
      expect(transformer.peakMemoryUsage).toBe(1024);
    });

    it('executes processOpfsStreaming through chunk transformer fallback on ArrayBuffer', async () => {
      const input = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const res = await processOpfsStreaming(
        {
          jobId: 'test-job-fallback',
          sourceFormat: 'bin',
          targetFormat: 'invert',
          totalSize: input.byteLength,
        },
        input.buffer
      );

      expect(res.outputSize).toBe(input.byteLength);
      expect(res.buffer).toBeDefined();
      const outView = new Uint8Array(res.buffer!);
      expect(outView[0]).toBe(1 ^ 0xff);
      expect(outView[7]).toBe(8 ^ 0xff);
    });
  });

  describe('2. Zero-Retention Immediate Physical Disk Disposal', () => {
    it('safely attempts physical session directory deletion via destroySessionImmediately', async () => {
      const sessionId = createSessionId();
      // In environment without navigator.storage, it fails closed gracefully and returns false
      const result = await destroySessionImmediately(sessionId);
      expect(typeof result).toBe('boolean');
    });

    it('correctly executes destroySessionImmediately when mock OPFS root is provided', async () => {
      const removeEntrySpy = vi.fn(async () => {});
      const mockSessionsDir = {
        removeEntry: removeEntrySpy,
      };
      const mockEasyconvertDir = {
        getDirectoryHandle: vi.fn(async () => mockSessionsDir),
      };
      const mockRootDir = {
        getDirectoryHandle: vi.fn(async () => mockEasyconvertDir),
      };

      const result = await destroySessionImmediately('session-mock-123', mockRootDir);
      expect(result).toBe(true);
      expect(removeEntrySpy).toHaveBeenCalledWith('session-mock-123', { recursive: true });
    });

    it('registers and triggers lifecycle unloader hooks for zero-retention cleanup', () => {
      const activeSessions = new Set<string>(['session-alpha', 'session-beta']);
      const listeners: Record<string, Function> = {};

      const mockTarget = {
        addEventListener: vi.fn((event: string, fn: Function) => {
          listeners[event] = fn;
        }),
        removeEventListener: vi.fn((event: string) => {
          delete listeners[event];
        }),
      };

      const originalWindow = globalThis.window;
      (globalThis as any).window = mockTarget;

      try {
        const unregister = registerZeroRetentionLifecycleHooks(activeSessions);
        expect(mockTarget.addEventListener).toHaveBeenCalledWith('beforeunload', expect.any(Function));
        expect(mockTarget.addEventListener).toHaveBeenCalledWith('pagehide', expect.any(Function));

        // Simulate beforeunload event
        listeners['beforeunload']();
        expect(activeSessions.size).toBe(0);

        unregister();
        expect(mockTarget.removeEventListener).toHaveBeenCalledWith('beforeunload', expect.any(Function));
        expect(mockTarget.removeEventListener).toHaveBeenCalledWith('pagehide', expect.any(Function));
      } finally {
        (globalThis as any).window = originalWindow;
      }
    });

    it('provides destroy() callback on streamConvertWithOpfs for immediate zero-retention disposal', async () => {
      const testContent = 'Zero-retention streaming test buffer';
      const file = new File([testContent], 'test.txt', { type: 'text/plain' });

      const result = await streamConvertWithOpfs(file, 'txt', 'txt');
      expect(result.sessionId).toBeDefined();
      expect(typeof result.destroy).toBe('function');

      // Immediate physical disposal trigger
      const destroyed = await result.destroy();
      expect(typeof destroyed).toBe('boolean');
    });

    it('rejects path traversal attempts in destroySessionImmediately for security', async () => {
      expect(await destroySessionImmediately('../../../etc')).toBe(false);
      expect(await destroySessionImmediately('..')).toBe(false);
      expect(await destroySessionImmediately('sessions/../malicious')).toBe(false);
      expect(await destroySessionImmediately('sub\\dir')).toBe(false);
    });
  });

  describe('3. Distributed Infrastructure Interface Abstractions', () => {
    it('validates IQueueEngine contract on Queue and DistributedBullMQAdapter', async () => {
      const inMemoryQueue: IQueueEngine<{ msg: string }, string> = createQueueEngine('in-mem-test', {
        distributed: false,
      });
      expect(inMemoryQueue.isDistributed).toBe(false);

      const distributedQueue: IQueueEngine<{ msg: string }, string> = createQueueEngine('dist-test', {
        distributed: true,
      });
      expect(distributedQueue.isDistributed).toBe(true);
      expect(distributedQueue).toBeInstanceOf(DistributedBullMQAdapter);

      const job = await distributedQueue.add('task', { msg: 'hello' });
      expect(job.id).toBeDefined();
      expect(job.state).toBe('waiting');

      const counts = await distributedQueue.getJobCounts();
      expect(counts.waiting).toBe(1);

      await inMemoryQueue.close();
      await distributedQueue.close();
    });

    it('processes jobs via Worker through IQueueEngine interface', async () => {
      const queue = createQueueEngine<{ val: number }, number>('worker-engine-test');
      const processedVals: number[] = [];

      const worker = new Worker(
        queue,
        async (job) => {
          processedVals.push(job.data.val);
          return job.data.val * 3;
        },
        { concurrency: 2 }
      );

      const completionPromise = new Promise((resolve) => {
        let count = 0;
        worker.on('completed', () => {
          count++;
          if (count === 2) resolve(true);
        });
      });

      const job1 = await queue.add('calc', { val: 5 });
      const job2 = await queue.add('calc', { val: 10 });

      await completionPromise;

      expect(job1.state).toBe('completed');
      expect(job1.returnvalue).toBe(15);
      expect(job2.state).toBe('completed');
      expect(job2.returnvalue).toBe(30);

      await worker.close();
      await queue.close();
    });

    it('validates IStorageBackend interface across OCI and S3-Compatible providers', async () => {
      const ociBackend: IStorageBackend = getStorageBackend('oci');
      const s3Backend: IStorageBackend = getStorageBackend('s3');

      expect(ociBackend.providerName).toBe('oci');
      expect(s3Backend.providerName).toBe('s3-compatible');
      expect(s3Backend).toBeInstanceOf(S3CompatibleStorageBackend);

      // Verify interface compatibility
      const buffer = Buffer.from('Storage backend interface validation payload');
      const stored = await s3Backend.saveObject('test/interface-key.txt', buffer, 'text/plain', 'test.txt');

      expect(stored.key).toContain('interface-key.txt');
      expect(stored.size).toBe(buffer.length);

      const retrieved = await s3Backend.getObject(stored.key);
      expect(retrieved).toBeDefined();
      expect(retrieved?.buffer.toString('utf-8')).toBe('Storage backend interface validation payload');

      const deleted = await s3Backend.deleteObject(stored.key);
      expect(deleted).toBe(true);
      expect(await s3Backend.getObject(stored.key)).toBeUndefined();
    });

    it('clears all pending delay timers when Queue.close() is invoked to prevent event loop leaks', async () => {
      const queue = new Queue<{ id: number }>('timer-cleanup-test');
      await queue.add('delayed-1', { id: 1 }, { delay: 60000 });
      await queue.add('delayed-2', { id: 2 }, { delay: 120000 });

      const counts = await queue.getJobCounts();
      expect(counts.delayed).toBe(2);

      // Closing queue must clear internal timers
      await queue.close();
      expect(queue.listenerCount('waiting')).toBe(0);
    });
  });
});
