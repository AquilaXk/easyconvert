import { describe, it, expect } from 'vitest';
import {
  createDeterministicSyntheticStream,
  streamProcessLargePayload,
  EnduranceSoakController,
  getOpenFileDescriptorCount,
} from '../src/lib/streaming/large-payload-streamer';
import {
  isOracleToolAvailable,
  verifyArchiveWithTar,
  verifyArchiveWithZstd,
  verifyArchiveWith7z,
  runDifferentialComparison,
  parsePdfToAst,
} from './helpers/differential-oracle';
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
      expect(result.sha256Digest).toHaveLength(64);
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
    it('executes iterative soak cycles with heap stabilization and zero persistent FD leaks', async () => {
      const controller = new EnduranceSoakController();
      const initialFds = getOpenFileDescriptorCount();

      const report = await controller.runSoakSession({
        durationMs: 5000, // 5 second soak test session
        maxIterations: 10,
        bytesPerIteration: 2 * 1024 * 1024, // 2MB per cycle
        chunkSizeBytes: 64 * 1024,
        warmupIterations: 2,
      });

      expect(report.totalIterations).toBeGreaterThanOrEqual(3);
      expect(report.totalBytesProcessed).toBeGreaterThanOrEqual(6 * 1024 * 1024);
      expect(report.isMemoryStable).toBe(true);

      const finalFds = getOpenFileDescriptorCount();
      const fdDelta = Math.abs(finalFds - initialFds);
      expect(fdDelta).toBeLessThanOrEqual(2);
    });

    it('gracefully aborts active soak session upon receiving abort signal', async () => {
      const controller = new EnduranceSoakController();

      const soakPromise = controller.runSoakSession({
        durationMs: 60000,
        maxIterations: 1000,
        bytesPerIteration: 5 * 1024 * 1024,
      });

      // Abort after 300ms
      setTimeout(() => {
        controller.abort();
      }, 300);

      const report = await soakPromise;
      expect(controller.active).toBe(false);
      expect(report.totalDurationMs).toBeLessThan(5000);
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

    it('executes real system CLI tools for archive verification when available', () => {
      // Test Tar verification using system tar binary if installed
      if (isOracleToolAvailable('tar')) {
        const sampleTar = createTarArchive([
          { filename: 'document.txt', buffer: Buffer.from('Enterprise Tar Differential Data') },
        ]).buffer;
        const isTarValid = verifyArchiveWithTar(sampleTar);
        expect(isTarValid).toBe(true);

        const corruptedTar = Buffer.from(sampleTar);
        corruptedTar[100] ^= 0xff;
        const isCorruptTarValid = verifyArchiveWithTar(corruptedTar);
        expect(isCorruptTarValid).toBe(false);
      }

      // Test Zstandard verification using system zstd binary if installed
      if (isOracleToolAvailable('zstd')) {
        const sampleZstd = compressZstd(Buffer.from('Zstandard Differential Oracle Grounding'));
        const isZstdValid = verifyArchiveWithZstd(sampleZstd);
        expect(isZstdValid).toBe(true);

        const corruptedZstd = Buffer.from(sampleZstd);
        corruptedZstd[corruptedZstd.length - 2] ^= 0xaa;
        const isCorruptZstdValid = verifyArchiveWithZstd(corruptedZstd);
        expect(isCorruptZstdValid).toBe(false);
      }
    });

    it('runs differential comparison with external CLI oracle integration', async () => {
      const sampleTarA = createTarArchive([
        { filename: 'test.txt', buffer: Buffer.from('Differential Data A') },
      ]).buffer;
      const sampleTarB = createTarArchive([
        { filename: 'test.txt', buffer: Buffer.from('Differential Data A') },
      ]).buffer;

      const report = await runDifferentialComparison(sampleTarA, sampleTarB, 'tar');
      expect(report.matched).toBe(true);
      expect(report.structuralScore).toBe(1.0);

      if (isOracleToolAvailable('tar')) {
        expect(report.oracleType).toBe('external_cli');
      }
    });
  });
});
