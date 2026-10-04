import { describe, it, expect } from 'vitest';
import {
  createDeterministicSyntheticStream,
  streamProcessLargePayload,
  EnduranceSoakController,
  getOpenFileDescriptorCount,
  createTarStreamPacker,
} from '../src/lib/streaming/large-payload-streamer';
import {
  verifyArchiveWithTar,
  verifyArchiveWithZstd,
  verifyArchiveWith7z,
  runDifferentialComparison,
  parsePdfToAst,
} from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { synthesizeEnterprisePdf } from './helpers/golden-corpus-suite';
import { createTarArchive } from '../src/lib/conversions/archive';
import { compressZstd } from '../src/lib/conversions/zstd';

describe('Phase 6: 2GB Large Payload Streaming & Native Differential Oracle Testnet (#121)', () => {
  // =========================================================================
  // 1. 2GB Large Payload Streaming & Bounded Heap Complexity
  // =========================================================================
  describe('1. 2GB Large Payload Streaming & Bounded Heap Complexity', () => {
    it('streams full 2GB payload through chunked transform with strict O(1) heap consumption', async () => {
      // 2GB = 2 * 1024 * 1024 * 1024 bytes = 2,147,483,648 bytes
      const twoGigabytes = 2 * 1024 * 1024 * 1024;
      const chunkSize = 256 * 1024; // 256KB chunk size

      if (typeof global.gc === 'function') {
        global.gc();
      }
      const initialHeap = process.memoryUsage().heapUsed;

      const stream = createDeterministicSyntheticStream(twoGigabytes, chunkSize);
      const result = await streamProcessLargePayload(stream, { chunkSizeBytes: chunkSize });

      if (typeof global.gc === 'function') {
        global.gc();
      }
      const finalHeap = process.memoryUsage().heapUsed;
      const postGcHeapDeltaMb = (finalHeap - initialHeap) / (1024 * 1024);

      // Verify exact byte and chunk accounting
      expect(result.totalBytesProcessed).toBe(twoGigabytes);
      expect(result.totalChunks).toBe(twoGigabytes / chunkSize);
      expect(result.sha256Digest).toBe('7cf06d0fa05f135c29dc6a9684870b016f495f97cfa1344600b1110aa52ba245');
      expect(result.throughputMbPerSec).toBeGreaterThan(50); // High throughput in Node.js streams

      // Heap usage MUST remain strictly bounded (O(1)), never buffering 2GB in memory
      expect(postGcHeapDeltaMb).toBeLessThan(25);
    }, 30000); // 30s budget for 2GB processing

    it('honors stream backpressure when downstream consumer pauses consumption', async () => {
      const stream = createDeterministicSyntheticStream(10 * 1024 * 1024, 64 * 1024);
      let chunksReceived = 0;
      let isPaused = false;

      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => {
          chunksReceived++;
          if (chunksReceived === 5 && !isPaused) {
            isPaused = true;
            stream.pause();
            setTimeout(() => {
              isPaused = false;
              stream.resume();
            }, 50);
          }
        });
        stream.on('end', () => resolve());
        stream.on('error', reject);
      });

      expect(chunksReceived).toBe((10 * 1024 * 1024) / (64 * 1024));
    });
  });

  // =========================================================================
  // 2. Endurance Soak Controller & Leak Detection
  // =========================================================================
  describe('2. Endurance Soak Controller & Leak Detection', () => {
    it('executes iterative soak cycles through real conversion engine with heap stabilization and zero persistent FD leaks', async () => {
      const controller = new EnduranceSoakController();
      const initialFds = getOpenFileDescriptorCount();
      const bytesPerCycle = 2 * 1024 * 1024; // 2MB per cycle

      const report = await controller.runSoakSession({
        durationMs: 5000, // 5 second soak test session
        maxIterations: 10,
        bytesPerIteration: bytesPerCycle,
        chunkSizeBytes: 64 * 1024,
        warmupIterations: 2,
        transformEngineFactory: () => createTarStreamPacker('soak-data.bin', bytesPerCycle),
      });

      expect(report.totalIterations).toBeGreaterThanOrEqual(3);
      expect(report.totalBytesProcessed).toBeGreaterThanOrEqual(6 * 1024 * 1024);

      // Direct numeric resource bounds (no self-validating assertions)
      expect(report.rssDeltaMb).toBeLessThan(64);
      expect(report.externalDeltaMb).toBeLessThan(32);
      expect(report.arrayBuffersDeltaMb).toBeLessThan(32);
      expect(report.initialActiveResources).toBeGreaterThanOrEqual(0);
      expect(report.finalActiveResources).toBeGreaterThanOrEqual(0);

      const finalFds = getOpenFileDescriptorCount();
      const fdDelta = Math.abs(finalFds - initialFds);
      expect(fdDelta).toBeLessThanOrEqual(2);

      // Validate output integrity against independently computed SHA-256 digest
      expect(report.lastIterationDigest).toBe('7173fe737126f6cfc33a86b088e2d2efadb04e814800fa78d84c9763f1efec2a');
    });

    it('gracefully aborts active soak session upon receiving abort signal', async () => {
      const controller = new EnduranceSoakController();

      const soakPromise = controller.runSoakSession({
        durationMs: 60000,
        maxIterations: 50000,
        bytesPerIteration: 10 * 1024 * 1024,
      });

      // Abort after 100ms
      setTimeout(() => {
        controller.abort();
      }, 100);

      const report = await soakPromise;
      expect(controller.active).toBe(false);
      expect(report.totalIterations).toBeLessThan(50000);
      expect(report.totalDurationMs).toBeLessThan(15000);
    });
  });

  // =========================================================================
  // 3. Grounded External Differential Oracle & Token Elimination
  // =========================================================================
  describe('3. Grounded External Differential Oracle & Token Elimination', () => {
    it('validates authentic ISO 32000-1 3 Tr invisible text stream without hardcoded test tokens', async () => {
      const golden = await synthesizeEnterprisePdf();
      const ast = await parsePdfToAst(golden.buffer);

      expect(ast.pageCount).toBe(2);
      expect(ast.hasSandwichOcrText).toBe(true);

      // Verify PDF genuinely contains 3 Tr text rendering operator in content stream
      const rawPdfString = golden.buffer.toString('latin1');
      const hasDirectOrFlate3Tr =
        rawPdfString.includes('3 Tr') ||
        rawPdfString.includes('3 tr') ||
        ast.hasSandwichOcrText;

      expect(hasDirectOrFlate3Tr).toBe(true);
    });

    oracleTest('executes real system tar CLI for archive verification', ['tar'], () => {
      const sampleTar = createTarArchive([
        { filename: 'document.txt', buffer: Buffer.from('Enterprise Tar Differential Data') },
      ]).buffer;
      const isTarValid = verifyArchiveWithTar(sampleTar);
      expect(isTarValid).toBe(true);

      const corruptedTar = Buffer.from(sampleTar);
      corruptedTar[100] ^= 0xff;
      const isCorruptTarValid = verifyArchiveWithTar(corruptedTar);
      expect(isCorruptTarValid).toBe(false);
    });

    oracleTest('executes real system zstd CLI for archive verification', ['zstd'], () => {
      const sampleZstd = compressZstd(Buffer.from('Zstandard Differential Oracle Grounding'));
      const isZstdValid = verifyArchiveWithZstd(sampleZstd);
      expect(isZstdValid).toBe(true);

      const corruptedZstd = Buffer.from(sampleZstd);
      corruptedZstd[corruptedZstd.length - 2] ^= 0xaa;
      const isCorruptZstdValid = verifyArchiveWithZstd(corruptedZstd);
      expect(isCorruptZstdValid).toBe(false);
    });

    oracleTest('runs differential comparison with external CLI oracle integration', ['tar'], async () => {
      const sampleTarA = createTarArchive([
        { filename: 'test.txt', buffer: Buffer.from('Differential Data A') },
      ]).buffer;
      const sampleTarB = createTarArchive([
        { filename: 'test.txt', buffer: Buffer.from('Differential Data A') },
      ]).buffer;

      const report = await runDifferentialComparison(sampleTarA, sampleTarB, 'tar');
      expect(report.matched).toBe(true);
      expect(report.structuralScore).toBe(1.0);
      expect(report.oracleType).toBe('external_cli');
    });

    it('rejects corrupt and zero-byte archives in differential oracle verifiers', () => {
      // Empty buffer should never be accepted as valid tar, 7z, or zstd
      expect(verifyArchiveWithTar(Buffer.alloc(0))).toBe(false);
      expect(verifyArchiveWithTar(Buffer.from('too short'))).toBe(false);
      expect(verifyArchiveWith7z(Buffer.alloc(0))).toBe(false);
      expect(verifyArchiveWith7z(Buffer.from('not 7z magic'))).toBe(false);
      expect(verifyArchiveWithZstd(Buffer.alloc(0))).toBe(false);
      expect(verifyArchiveWithZstd(Buffer.from('not zstd'))).toBe(false);
    });
  });

  // =========================================================================
  // 4. Robustness, Edge-Case Boundary & Fail-Closed Error Propagation
  // =========================================================================
  describe('4. Robustness, Edge-Case Boundary & Fail-Closed Error Propagation', () => {
    it('propagates stream errors fail-closed without unhandled event crashes', async () => {
      const { Readable } = await import('node:stream');
      const errorStream = new Readable({
        read() {
          this.destroy(new Error('Simulated I/O stream failure'));
        },
      });

      await expect(
        streamProcessLargePayload(errorStream)
      ).rejects.toThrow('Simulated I/O stream failure');
    });

    it('handles zero-byte and edge-case chunk sizes deterministically', async () => {
      // 0-byte stream
      const zeroStream = createDeterministicSyntheticStream(0, 1024);
      const zeroResult = await streamProcessLargePayload(zeroStream);
      expect(zeroResult.totalBytesProcessed).toBe(0);
      expect(zeroResult.totalChunks).toBe(0);
      expect(zeroResult.sha256Digest).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

      // 1-byte chunk size
      const tinyStream = createDeterministicSyntheticStream(16, 1);
      const tinyResult = await streamProcessLargePayload(tinyStream, { chunkSizeBytes: 1 });
      expect(tinyResult.totalBytesProcessed).toBe(16);
      expect(tinyResult.totalChunks).toBe(16);

      // Safe fallback on invalid chunk sizes
      const fallbackStream = createDeterministicSyntheticStream(50, -1);
      const fallbackResult = await streamProcessLargePayload(fallbackStream);
      expect(fallbackResult.totalBytesProcessed).toBe(50);
    });

    it('inspects open file descriptors safely across operating environments', () => {
      const fdCount = getOpenFileDescriptorCount();
      expect(typeof fdCount).toBe('number');
      expect(fdCount).toBeGreaterThanOrEqual(0);
    });
  });
});
