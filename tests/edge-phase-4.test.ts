import { describe, it, expect, vi } from 'vitest';
import {
  OPFS_CHUNK_SIZE,
  calculateChunkCount,
  OpfsStreamTransformer,
  processOpfsStreaming,
} from '../src/lib/edge/workers/opfs-vfs.worker';
import {
  createSessionId,
  parseSessionTimestamp,
  isSessionOrphaned,
  estimateStorageQuota,
  sweepOrphanedSessions,
  MAX_SESSION_AGE_MS,
  QUOTA_CRITICAL_RATIO,
} from '../src/lib/edge/opfs/storage-gc';
import { resolveConversionTier } from '../src/lib/edge/tier-router';
import { streamConvertWithOpfs } from '../src/lib/edge/pipelines/opfs-streaming-pipeline';

describe('Phase 4: OPFS Large File VFS Streaming Pipeline & Quota Garbage Collector (L3)', () => {
  describe('1. 4MB Chunk Calculations and Streaming Bounds', () => {
    it('accurately calculates chunk count for arbitrary file sizes', () => {
      expect(calculateChunkCount(0)).toBe(0);
      expect(calculateChunkCount(1024)).toBe(1);
      expect(calculateChunkCount(OPFS_CHUNK_SIZE)).toBe(1);
      expect(calculateChunkCount(OPFS_CHUNK_SIZE + 1)).toBe(2);
      // 100 MB = 25 chunks
      expect(calculateChunkCount(100 * 1024 * 1024)).toBe(25);
      // 500 MB = 125 chunks
      expect(calculateChunkCount(500 * 1024 * 1024)).toBe(125);
      // 2 GB (2048 MB) / 4 MB = 512 chunks
      expect(calculateChunkCount(2 * 1024 * 1024 * 1024)).toBe(512);
    });

    it('bounds peak chunk allocation strictly to 4MB chunk window', async () => {
      const transformer = new OpfsStreamTransformer(OPFS_CHUNK_SIZE);
      const totalVirtualBytes = 20 * 1024 * 1024; // 20 MB virtual stream

      const readSpy = vi.fn(async (_offset: number, size: number) => new Uint8Array(size));
      const writeSpy = vi.fn(async (_offset: number, _data: Uint8Array) => {});

      const processed = await transformer.transformChunked(
        totalVirtualBytes,
        readSpy,
        writeSpy
      );

      expect(processed).toBe(totalVirtualBytes);
      expect(readSpy).toHaveBeenCalledTimes(5); // 20MB / 4MB = 5 chunks
      expect(writeSpy).toHaveBeenCalledTimes(5);
      expect(transformer.peakMemoryUsage).toBe(OPFS_CHUNK_SIZE);
    });
  });

  describe('2. Session Path Isolation and Orphan Age Detection', () => {
    it('creates unique timestamped session IDs adhering to naming contract', () => {
      const id1 = createSessionId();
      const id2 = createSessionId();

      expect(id1).not.toBe(id2);
      expect(parseSessionTimestamp(id1)).toBeGreaterThan(0);
    });

    it('identifies fresh vs orphaned sessions based on 2-hour threshold', () => {
      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;
      const threeHoursAgo = now - 3 * 60 * 60 * 1000;

      const freshId = `${oneHourAgo}-abc-123`;
      const staleId = `${threeHoursAgo}-def-456`;
      const corruptId = `invalid-session-name`;

      expect(isSessionOrphaned(freshId, now, MAX_SESSION_AGE_MS)).toBe(false);
      expect(isSessionOrphaned(staleId, now, MAX_SESSION_AGE_MS)).toBe(true);
      expect(isSessionOrphaned(corruptId, now, MAX_SESSION_AGE_MS)).toBe(true);
    });
  });

  describe('3. Storage Quota Monitoring', () => {
    it('flags quota critical when storage usage exceeds 85%', async () => {
      const originalNavigator = globalThis.navigator;

      // Mock navigator.storage.estimate
      const mockNavigator = {
        storage: {
          estimate: vi.fn(async () => ({
            usage: 900 * 1024 * 1024,
            quota: 1000 * 1024 * 1024, // 90% used
          })),
        },
      } as any;

      Object.defineProperty(globalThis, 'navigator', {
        value: mockNavigator,
        configurable: true,
      });

      try {
        const info = await estimateStorageQuota();
        expect(info.percentUsed).toBe(90);
        expect(info.isQuotaCritical).toBe(true);
        expect(QUOTA_CRITICAL_RATIO).toBe(0.85);
      } finally {
        Object.defineProperty(globalThis, 'navigator', {
          value: originalNavigator,
          configurable: true,
        });
      }
    });

    it('returns false for critical quota under 85%', async () => {
      const originalNavigator = globalThis.navigator;

      const mockNavigator = {
        storage: {
          estimate: vi.fn(async () => ({
            usage: 200 * 1024 * 1024,
            quota: 1000 * 1024 * 1024, // 20% used
          })),
        },
      } as any;

      Object.defineProperty(globalThis, 'navigator', {
        value: mockNavigator,
        configurable: true,
      });

      try {
        const info = await estimateStorageQuota();
        expect(info.percentUsed).toBe(20);
        expect(info.isQuotaCritical).toBe(false);
      } finally {
        Object.defineProperty(globalThis, 'navigator', {
          value: originalNavigator,
          configurable: true,
        });
      }
    });
  });

  describe('4. Automated Storage GC Sweeper', () => {
    it('recursively removes orphaned directories while preserving fresh sessions', async () => {
      const now = Date.now();
      const freshTime = now - 30 * 60 * 1000; // 30 min old
      const staleTime1 = now - 150 * 60 * 1000; // 2.5 hours old
      const staleTime2 = now - 300 * 60 * 1000; // 5 hours old

      const removedEntries: string[] = [];

      const mockSessionsDir = {
        values: async function* () {
          yield { kind: 'directory', name: `${freshTime}-fresh-job` };
          yield { kind: 'directory', name: `${staleTime1}-stale-job-1` };
          yield { kind: 'directory', name: `${staleTime2}-stale-job-2` };
        },
        removeEntry: vi.fn(async (name: string) => {
          removedEntries.push(name);
        }),
      };

      const mockEasyconvertDir = {
        getDirectoryHandle: vi.fn(async (name: string) => {
          if (name === 'sessions') return mockSessionsDir;
          throw new Error('Not found');
        }),
      };

      const mockRootDir = {
        getDirectoryHandle: vi.fn(async (name: string) => {
          if (name === 'easyconvert') return mockEasyconvertDir;
          throw new Error('Not found');
        }),
      };

      const result = await sweepOrphanedSessions(mockRootDir, now, MAX_SESSION_AGE_MS);

      expect(result.sweptCount).toBe(2);
      expect(result.remainingCount).toBe(1);
      expect(removedEntries).toHaveLength(2);
      expect(removedEntries).toContain(`${staleTime1}-stale-job-1`);
      expect(removedEntries).toContain(`${staleTime2}-stale-job-2`);
      expect(removedEntries).not.toContain(`${freshTime}-fresh-job`);
    });
  });

  describe('5. OPFS Streaming Pipeline Execution', () => {
    it('executes in-process fallback with progress telemetry', async () => {
      const progressUpdates: number[] = [];
      const testBuffer = new Uint8Array(10 * 1024).buffer;

      const result = await processOpfsStreaming(
        {
          jobId: 'test-stream-job',
          sourceFormat: 'bin',
          targetFormat: 'bin',
          totalSize: testBuffer.byteLength,
        },
        testBuffer,
        (p) => progressUpdates.push(p)
      );

      expect(result.outputSize).toBe(testBuffer.byteLength);
      expect(progressUpdates.length).toBeGreaterThan(0);
      expect(progressUpdates[progressUpdates.length - 1]).toBe(100);
    });

    it('streams File/Blob via streamConvertWithOpfs controller', async () => {
      const dummyFile = new File([new Uint8Array(1024 * 64)], 'big-video.mp4', {
        type: 'video/mp4',
      });

      const res = await streamConvertWithOpfs(dummyFile, 'mp4', 'webm');
      expect(res.size).toBe(1024 * 64);
      expect(res.url).toBeDefined();
    });
  });

  describe('6. Tier Router Level 3 Routing', () => {
    it('routes files > 100MB to Tier L3 when OPFS is available', () => {
      const fileSize = 150 * 1024 * 1024; // 150 MB
      const res = resolveConversionTier('mp4', 'webm', fileSize, {}, { hasOpfsSyncAccess: true });

      expect(res.tier).toBe('L3');
      expect(res.tierName).toBe('Edge L3 (OPFS Stream)');
      expect(res.isClientEdge).toBe(true);
    });

    it('falls back to Tier L4 when file > 100MB but OPFS is unavailable in browser', () => {
      const fileSize = 150 * 1024 * 1024; // 150 MB
      const res = resolveConversionTier('mp4', 'webm', fileSize, {}, { hasOpfsSyncAccess: false });

      expect(res.tier).toBe('L4');
      expect(res.tierName).toBe('Cloud (Zero-Retention)');
      expect(res.isClientEdge).toBe(false);
    });
  });
});
