import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import {
  createVirtualSpannedStream,
  stitchMultiVolumeToDisk,
  stitchMultiVolumeArchive,
  splitArchive,
  validateAndSortSplitParts,
  VirtualSpannedStream,
  MultiVolumeBufferOverflowError,
  MAX_STITCH_BUFFER_SIZE,
  type VirtualSpannedPartSource,
  extractWithSpannedStream7z,
  get7zBinaryPath,
  createTarArchive,
} from '../src/lib/conversions/archive';
import { executeSandboxedBinary } from '../src/lib/security/process-sandbox';

describe('Archive Domain: Virtual Spanned Readable Stream (VFS Pipeline) (#173)', () => {
  // Helper to create temporary directory for file-based tests
  function createTempDir(): string {
    const tmp = path.join(os.tmpdir(), `vfs_test_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(tmp, { recursive: true });
    return tmp;
  }

  // 1. Bitstream Parity & Checksum Verification
  describe('1. Bitstream Parity & Checksum Verification', () => {
    it('preserves exact SHA-256 hash across in-memory multi-volume parts (.7z.001)', async () => {
      const originalPayload = crypto.randomBytes(256 * 1024); // 256KB
      const originalHash = crypto.createHash('sha256').update(originalPayload).digest('hex');

      const parts = splitArchive(originalPayload, 'archive.7z', 64 * 1024); // 4 parts of 64KB
      expect(parts.length).toBe(4);

      const { stream, metadata } = createVirtualSpannedStream(parts);
      expect(metadata.totalParts).toBe(4);
      expect(metadata.totalSizeBytes).toBe(256 * 1024);
      expect(metadata.format).toBe('7z');

      const hasher = crypto.createHash('sha256');
      let streamedBytes = 0;

      for await (const chunk of stream) {
        hasher.update(chunk);
        streamedBytes += chunk.length;
      }

      expect(streamedBytes).toBe(256 * 1024);
      expect(hasher.digest('hex')).toBe(originalHash);
    });

    it('preserves exact SHA-256 across disk-backed multi-volume parts (.part1.rar)', async () => {
      const tempDir = createTempDir();
      try {
        const originalPayload = crypto.randomBytes(300 * 1024); // 300KB
        const originalHash = crypto.createHash('sha256').update(originalPayload).digest('hex');

        const inMemoryParts = splitArchive(originalPayload, 'data.rar', 100 * 1024, 'rar');
        expect(inMemoryParts.length).toBe(3);

        const filePaths: string[] = [];
        for (const p of inMemoryParts) {
          const fp = path.join(tempDir, p.filename);
          fs.writeFileSync(fp, p.buffer);
          filePaths.push(fp);
        }

        const { stream, metadata } = createVirtualSpannedStream(filePaths);
        expect(metadata.format).toBe('rar');
        expect(metadata.totalParts).toBe(3);
        expect(metadata.totalSizeBytes).toBe(300 * 1024);

        const hasher = crypto.createHash('sha256');
        for await (const chunk of stream) {
          hasher.update(chunk);
        }

        expect(hasher.digest('hex')).toBe(originalHash);

        // Also test stitchMultiVolumeToDisk
        const stitchedOut = path.join(tempDir, 'stitched_data.rar');
        const stitchResult = await stitchMultiVolumeToDisk(filePaths, stitchedOut);
        expect(stitchResult.bytesWritten).toBe(300 * 1024);
        expect(fs.existsSync(stitchedOut)).toBe(true);

        const diskPayload = fs.readFileSync(stitchedOut);
        const diskHash = crypto.createHash('sha256').update(diskPayload).digest('hex');
        expect(diskHash).toBe(originalHash);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('preserves exact byte parity across zip (.z01), tar (.tar.001) and numeric schemes', async () => {
      const schemes: Array<{ ext: string; part1: string; part2: string; format: string }> = [
        { ext: 'zip', part1: 'bundle.z01', part2: 'bundle.z02', format: 'zip' },
        { ext: 'tar', part1: 'archive.tar.001', part2: 'archive.tar.002', format: 'tar' },
        { ext: 'bin', part1: 'dataset.bin.001', part2: 'dataset.bin.002', format: 'numeric' },
      ];

      for (const scheme of schemes) {
        const chunk1 = crypto.randomBytes(32 * 1024);
        const chunk2 = crypto.randomBytes(32 * 1024);
        const expectedHash = crypto
          .createHash('sha256')
          .update(Buffer.concat([chunk1, chunk2]))
          .digest('hex');

        const parts: VirtualSpannedPartSource[] = [
          { filename: scheme.part1, buffer: chunk1 },
          { filename: scheme.part2, buffer: chunk2 },
        ];

        const { stream, metadata } = createVirtualSpannedStream(parts);
        expect(metadata.format).toBe(scheme.format);
        expect(metadata.totalSizeBytes).toBe(64 * 1024);

        const hasher = crypto.createHash('sha256');
        for await (const chunk of stream) {
          hasher.update(chunk);
        }
        expect(hasher.digest('hex')).toBe(expectedHash);
      }
    });
  });

  // 2. Backpressure Flow Control with Slow Consumers
  describe('2. Backpressure Flow Control with Slow Consumers', () => {
    it('respects downstream backpressure without unbounded buffering', async () => {
      const chunkSize = 16 * 1024; // 16KB
      const partCount = 4;
      const parts: VirtualSpannedPartSource[] = [];

      for (let i = 1; i <= partCount; i++) {
        parts.push({
          filename: `stream.7z.${String(i).padStart(3, '0')}`,
          buffer: crypto.randomBytes(chunkSize),
        });
      }

      // Stream with small 8KB highWaterMark
      const { stream } = createVirtualSpannedStream(parts, { highWaterMark: 8 * 1024 });

      let writesCount = 0;
      let maxBufferObserved = 0;

      // Slow consumer with 10ms artificial delay per write
      const slowSink = new Writable({
        highWaterMark: 8 * 1024,
        write(chunk, encoding, callback) {
          writesCount++;
          maxBufferObserved = Math.max(maxBufferObserved, stream.readableLength);
          setTimeout(callback, 5);
        },
      });

      await pipeline(stream, slowSink);

      expect(writesCount).toBeGreaterThanOrEqual(partCount);
      // High water mark backpressure ensures stream buffer stays bounded
      expect(maxBufferObserved).toBeLessThanOrEqual(32 * 1024);
    });
  });

  // 3. Sequential File Descriptor Open/Close & Zero Leaks on .destroy()
  describe('3. Sequential File Descriptor Lifecycle & Leak Prevention', () => {
    it('opens file streams sequentially and closes previous FD before next opens', async () => {
      const tempDir = createTempDir();
      try {
        const filePaths: string[] = [];
        const openFiles = new Set<string>();
        const maxConcurrentOpen = { count: 0 };

        for (let i = 1; i <= 3; i++) {
          const fp = path.join(tempDir, `seq.7z.${String(i).padStart(3, '0')}`);
          fs.writeFileSync(fp, crypto.randomBytes(16 * 1024));
          filePaths.push(fp);
        }

        // Custom stream factory tracking open/close concurrency
        const trackedParts: VirtualSpannedPartSource[] = filePaths.map((fp) => ({
          filename: path.basename(fp),
          filePath: fp,
          createStream: () => {
            openFiles.add(fp);
            maxConcurrentOpen.count = Math.max(maxConcurrentOpen.count, openFiles.size);
            const readStream = fs.createReadStream(fp);
            readStream.on('close', () => {
              openFiles.delete(fp);
            });
            return readStream;
          },
        }));

        const { stream } = createVirtualSpannedStream(trackedParts);
        for await (const _ of stream) {
          // Consume stream
        }

        // Must never have more than 1 file descriptor open simultaneously
        expect(maxConcurrentOpen.count).toBe(1);
        expect(openFiles.size).toBe(0);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('cleans up resources immediately on stream.destroy() without dangling FDs', async () => {
      const tempDir = createTempDir();
      try {
        const filePaths: string[] = [];
        let destroyedFired = false;

        for (let i = 1; i <= 3; i++) {
          const fp = path.join(tempDir, `cancel.7z.${String(i).padStart(3, '0')}`);
          fs.writeFileSync(fp, crypto.randomBytes(64 * 1024));
          filePaths.push(fp);
        }

        const trackedParts: VirtualSpannedPartSource[] = filePaths.map((fp) => ({
          filename: path.basename(fp),
          filePath: fp,
          createStream: () => {
            const rs = fs.createReadStream(fp);
            rs.on('close', () => {
              destroyedFired = true;
            });
            return rs;
          },
        }));

        const { stream } = createVirtualSpannedStream(trackedParts);

        // Read exactly one chunk then destroy
        const iterator = stream[Symbol.asyncIterator]();
        const firstChunk = await iterator.next();
        expect(firstChunk.done).toBe(false);

        // Explicitly destroy stream early
        stream.destroy(new Error('Early cancellation'));

        // Wait a microtask tick for cleanup handlers to execute
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(stream.destroyed).toBe(true);
        expect(destroyedFired).toBe(true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('supports AbortSignal to cancel streaming cleanly', async () => {
      const controller = new AbortController();
      const parts: VirtualSpannedPartSource[] = [
        { filename: 'abort.7z.001', buffer: crypto.randomBytes(32 * 1024) },
        { filename: 'abort.7z.002', buffer: crypto.randomBytes(32 * 1024) },
      ];

      const { stream } = createVirtualSpannedStream(parts, { signal: controller.signal });

      let readBytes = 0;
      const readPromise = (async () => {
        for await (const chunk of stream) {
          readBytes += chunk.length;
          controller.abort(new Error('User cancelled conversion'));
        }
      })();

      await expect(readPromise).rejects.toThrow('User cancelled conversion');
      expect(stream.destroyed).toBe(true);
    });
  });

  // 4. Fail-Closed Validation
  describe('4. Fail-Closed Validation (Rejection Gates)', () => {
    it('throws Fail-Closed error when volume 1 is missing', () => {
      const parts = [
        { filename: 'data.7z.002', buffer: Buffer.from('chunk2') },
        { filename: 'data.7z.003', buffer: Buffer.from('chunk3') },
      ];
      expect(() => validateAndSortSplitParts(parts)).toThrow(
        /missing volume 1 \(starts at volume 2\)/
      );
      expect(() => createVirtualSpannedStream(parts)).toThrow(
        /missing volume 1 \(starts at volume 2\)/
      );
    });

    it('throws Fail-Closed error when there is a gap in volume sequence', () => {
      const parts = [
        { filename: 'archive.part1.rar', buffer: Buffer.from('chunk1') },
        { filename: 'archive.part3.rar', buffer: Buffer.from('chunk3') },
      ];
      expect(() => validateAndSortSplitParts(parts)).toThrow(
        /missing volume 2 \(found volume 3\)/
      );
    });

    it('throws Fail-Closed error when duplicate volume numbers are provided', () => {
      const parts = [
        { filename: 'backup.7z.001', buffer: Buffer.from('chunk1') },
        { filename: 'backup.7z.002', buffer: Buffer.from('chunk2-a') },
        { filename: 'backup.7z.002', buffer: Buffer.from('chunk2-b') },
      ];
      expect(() => validateAndSortSplitParts(parts)).toThrow(
        /Duplicate multi-volume archive part.*volume 2 provided multiple times/
      );
    });

    it('throws Fail-Closed error when parts have mismatched base archive names', () => {
      const parts = [
        { filename: 'project_a.7z.001', buffer: Buffer.from('chunk1') },
        { filename: 'project_b.7z.002', buffer: Buffer.from('chunk2') },
      ];
      expect(() => validateAndSortSplitParts(parts)).toThrow(
        /Mismatched multi-volume archives in batch.*project_a.7z.*vs.*project_b.7z/
      );
    });

    it('throws Fail-Closed error when disk file does not exist', () => {
      const nonExistentPath = path.join(os.tmpdir(), 'non_existent_file.7z.001');
      expect(() => validateAndSortSplitParts([nonExistentPath])).toThrow(
        /Split archive part file not found on disk/
      );
    });

    it('throws Fail-Closed error on empty part list or invalid filename pattern', () => {
      expect(() => validateAndSortSplitParts([])).toThrow(/Cannot process empty archive part list/);
      expect(() =>
        validateAndSortSplitParts([{ filename: 'not-split-file.txt', buffer: Buffer.from('data') }])
      ).toThrow(/Invalid multi-volume archive filename/);
    });
  });

  // 5. Large Virtual Spanned Stream Simulation (>4GB, O(1) Memory, Zero OOM)
  describe('5. Large Virtual Spanned Stream Simulation (>4GB, O(1) Memory)', () => {
    it('streams 5GB virtual archive without exceeding V8 heap or Buffer.constants.MAX_LENGTH', async () => {
      // 5 parts of 1GB each = 5GB total (5,368,709,120 bytes)
      // Exceeds Node.js 4GB Buffer.constants.MAX_LENGTH = 4,294,967,296
      const PART_SIZE = 1024 * 1024 * 1024; // 1GB
      const CHUNK_SIZE = 1024 * 1024; // 1MB chunks
      const PART_COUNT = 5;

      const largeVirtualParts: VirtualSpannedPartSource[] = [];

      for (let i = 1; i <= PART_COUNT; i++) {
        largeVirtualParts.push({
          filename: `giant_archive.7z.${String(i).padStart(3, '0')}`,
          sizeBytes: PART_SIZE,
          createStream: () => {
            let bytesYielded = 0;
            // Static repeating pattern chunk
            const sampleChunk = Buffer.alloc(CHUNK_SIZE, i & 0xff);

            return new Readable({
              read() {
                if (bytesYielded >= PART_SIZE) {
                  this.push(null);
                  return;
                }
                const toSend = Math.min(CHUNK_SIZE, PART_SIZE - bytesYielded);
                bytesYielded += toSend;
                this.push(sampleChunk.subarray(0, toSend));
              },
            });
          },
        });
      }

      const { stream, metadata } = createVirtualSpannedStream(largeVirtualParts, {
        highWaterMark: 128 * 1024,
      });

      expect(metadata.totalSizeBytes).toBe(PART_COUNT * PART_SIZE);

      const initialHeap = process.memoryUsage().heapUsed;
      let totalBytesStreamed = 0;
      let peakHeapGrowth = 0;

      // Null consumer sink simulating 7z stdin or fast network upload
      const nullSink = new Writable({
        highWaterMark: 128 * 1024,
        write(chunk, encoding, callback) {
          totalBytesStreamed += chunk.length;
          const currentHeap = process.memoryUsage().heapUsed;
          peakHeapGrowth = Math.max(peakHeapGrowth, currentHeap - initialHeap);
          callback();
        },
      });

      await pipeline(stream, nullSink);

      // Verify total streamed size strictly equals 5GB (exceeding 4GB Buffer limit)
      expect(totalBytesStreamed).toBe(PART_COUNT * PART_SIZE);

      // Memory assertion: Heap growth must remain bounded under 60MB throughout entire 5GB stream
      expect(peakHeapGrowth).toBeLessThan(60 * 1024 * 1024);
    });
  });

  // 6. Buffer Overflow Fail-Closed Guard in stitchMultiVolumeArchive
  describe('6. Fail-Closed Guard on In-Memory Stitching Limit (500MB)', () => {
    it('throws MultiVolumeBufferOverflowError when total size exceeds MAX_STITCH_BUFFER_SIZE', () => {
      // Simulate parts totaling 501MB using small mock buffer descriptors
      const part1Size = 260 * 1024 * 1024; // 260MB
      const part2Size = 250 * 1024 * 1024; // 250MB
      const totalSize = part1Size + part2Size; // 510MB > 500MB

      // Create sparse buffer representations using dummy buffer with overridden length
      const dummyBuf1 = Buffer.alloc(16);
      Object.defineProperty(dummyBuf1, 'length', { value: part1Size });

      const dummyBuf2 = Buffer.alloc(16);
      Object.defineProperty(dummyBuf2, 'length', { value: part2Size });

      const parts = [
        { filename: 'huge.7z.001', buffer: dummyBuf1 },
        { filename: 'huge.7z.002', buffer: dummyBuf2 },
      ];

      expect(() => stitchMultiVolumeArchive(parts)).toThrow(MultiVolumeBufferOverflowError);

      try {
        stitchMultiVolumeArchive(parts);
        expect.unreachable('Should have thrown MultiVolumeBufferOverflowError');
      } catch (err) {
        expect(err).toBeInstanceOf(MultiVolumeBufferOverflowError);
        const overflowErr = err as MultiVolumeBufferOverflowError;
        expect(overflowErr.code).toBe('ERR_MULTI_VOLUME_BUFFER_OVERFLOW');
        expect(overflowErr.totalBytes).toBe(totalSize);
        expect(overflowErr.limitBytes).toBe(MAX_STITCH_BUFFER_SIZE);
        expect(overflowErr.message).toContain('exceeds in-memory stitching limit (500MB)');
      }
    });

    it('allows in-memory stitching when total size is within safe limit', () => {
      const b1 = Buffer.from('Hello, ');
      const b2 = Buffer.from('World!');
      const parts = [
        { filename: 'message.7z.001', buffer: b1 },
        { filename: 'message.7z.002', buffer: b2 },
      ];

      const stitched = stitchMultiVolumeArchive(parts);
      expect(stitched.buffer.toString('utf-8')).toBe('Hello, World!');
      expect(stitched.baseFilename).toBe('message.7z');
      expect(stitched.format).toBe('7z');
      expect(stitched.totalParts).toBe(2);
    });
  });

  // 7. Native 7-Zip Stdin Streaming Verification
  describe('7. Native 7-Zip Stdin Streaming Integration', () => {
    const has7z = Boolean(get7zBinaryPath());

    it.skipIf(!has7z)('extracts multi-volume parts directly via 7-Zip stdin or disk spool', async () => {
      const tempDir = createTempDir();
      try {
        const extractDir = path.join(tempDir, 'out');
        const testFileContent = 'Multi-volume 7z authentic content for extraction verification.';

        // Create an authentic tar archive
        const testFiles = [
          {
            filename: 'hello.txt',
            buffer: Buffer.from(testFileContent),
          },
        ];
        const archive = createTarArchive(testFiles, {}, 'multi_test.tar');

        // Split authentic archive into sequential multi-volume parts (.tar.001, .tar.002)
        const parts = splitArchive(archive.buffer, 'multi_test.tar', Math.ceil(archive.buffer.length / 2));
        expect(parts.length).toBeGreaterThanOrEqual(2);

        // Execute extractWithSpannedStream7z
        const result = await extractWithSpannedStream7z(parts, extractDir, { timeoutMs: 15000 });
        expect(result.extractedFiles).toContain('hello.txt');

        const extractedPath = path.join(extractDir, 'hello.txt');
        expect(fs.existsSync(extractedPath)).toBe(true);
        const extractedContent = fs.readFileSync(extractedPath, 'utf-8');
        expect(extractedContent).toBe(testFileContent);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // 8. Progress Tracking & Zero-Byte Part Handling
  describe('8. Progress Tracking & Edge Cases', () => {
    it('invokes onProgress callback monotonically across multi-volume stream', async () => {
      const parts: VirtualSpannedPartSource[] = [
        { filename: 'prog.7z.001', buffer: crypto.randomBytes(32 * 1024) },
        { filename: 'prog.7z.002', buffer: crypto.randomBytes(32 * 1024) },
        { filename: 'prog.7z.003', buffer: crypto.randomBytes(32 * 1024) },
      ];

      const progressReports: number[] = [];
      const { stream } = createVirtualSpannedStream(parts, {
        highWaterMark: 16 * 1024,
        onProgress: (readBytes, totalBytes) => {
          progressReports.push(readBytes);
          expect(totalBytes).toBe(96 * 1024);
        },
      });

      for await (const _ of stream) {
        // Read
      }

      expect(progressReports.length).toBeGreaterThan(0);
      expect(progressReports[progressReports.length - 1]).toBe(96 * 1024);
      // Verify progress is non-decreasing
      for (let i = 1; i < progressReports.length; i++) {
        expect(progressReports[i]).toBeGreaterThanOrEqual(progressReports[i - 1]);
      }
    });

    it('handles 0-byte split parts seamlessly without stalling', async () => {
      const parts: VirtualSpannedPartSource[] = [
        { filename: 'zero.7z.001', buffer: Buffer.from('Part 1') },
        { filename: 'zero.7z.002', buffer: Buffer.alloc(0) }, // 0-byte part
        { filename: 'zero.7z.003', buffer: Buffer.from('Part 3') },
      ];

      const { stream } = createVirtualSpannedStream(parts);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      const fullText = Buffer.concat(chunks).toString('utf-8');
      expect(fullText).toBe('Part 1Part 3');
    });
  });

  // 9. Downstream Backpressure Flow Control with Small Parts
  describe('9. Backpressure Flow Control with Small Parts & Active Child Pausing', () => {
    it('bounds buffering and pauses part opening when downstream consumer is paused', async () => {
      const PART_COUNT = 20;
      const PART_SIZE = 2 * 1024; // 2KB each, total 40KB
      const parts: VirtualSpannedPartSource[] = [];

      for (let i = 1; i <= PART_COUNT; i++) {
        parts.push({
          filename: `backpressure.7z.${String(i).padStart(3, '0')}`,
          buffer: crypto.randomBytes(PART_SIZE),
        });
      }

      // High water mark 8KB
      const { stream } = createVirtualSpannedStream(parts, { highWaterMark: 8 * 1024 });

      // Read only 1KB then pause reading completely for 100ms
      const initialChunk = await new Promise<Buffer>((resolve) => {
        stream.once('readable', () => {
          const chunk = stream.read(1024);
          resolve(chunk);
        });
      });
      expect(initialChunk.length).toBe(1024);

      // Wait 100ms without reading any more data from stream
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Stream readableLength must remain bounded under 16KB (never buffering all 40KB)
      expect(stream.readableLength).toBeLessThanOrEqual(16 * 1024);

      // Drain remaining stream
      let drainedBytes = initialChunk.length;
      for await (const chunk of stream) {
        drainedBytes += chunk.length;
      }
      expect(drainedBytes).toBe(PART_COUNT * PART_SIZE);
    });
  });

  // 10. PKZIP Multi-Volume Split Archive (.z01, .z02, .zip) Parity & Splitting
  describe('10. PKZIP Multi-Volume Split Archive (.z01, .z02, .zip)', () => {
    it('correctly resolves terminal .zip volume, enforces ordering, and preserves SHA-256', async () => {
      const originalPayload = crypto.randomBytes(120 * 1024); // 120KB
      const originalHash = crypto.createHash('sha256').update(originalPayload).digest('hex');

      // Split into 3 parts using splitArchive with 'zip' scheme
      const parts = splitArchive(originalPayload, 'archive.zip', 40 * 1024, 'zip');
      expect(parts.length).toBe(3);
      expect(parts[0].filename).toBe('archive.z01');
      expect(parts[1].filename).toBe('archive.z02');
      expect(parts[2].filename).toBe('archive.zip'); // Terminal part

      // Validate parts sequence
      const { sortedParts, metadata } = validateAndSortSplitParts(parts);
      expect(metadata.format).toBe('zip');
      expect(metadata.totalParts).toBe(3);
      expect(sortedParts[0].info.partNumber).toBe(1);
      expect(sortedParts[1].info.partNumber).toBe(2);
      expect(sortedParts[2].info.partNumber).toBe(3);

      // Verify SHA-256 byte parity across stream
      const { stream } = createVirtualSpannedStream(parts);
      const hasher = crypto.createHash('sha256');
      for await (const chunk of stream) {
        hasher.update(chunk);
      }
      expect(hasher.digest('hex')).toBe(originalHash);

      // Verify in-memory stitch
      const stitched = stitchMultiVolumeArchive(parts);
      expect(crypto.createHash('sha256').update(stitched.buffer).digest('hex')).toBe(originalHash);
      expect(stitched.baseFilename).toBe('archive.zip');
      expect(stitched.format).toBe('zip');
    });

    it('rejects incomplete PKZIP split sets with missing volumes or duplicates', () => {
      // Missing volume 1: starts at z02
      expect(() =>
        validateAndSortSplitParts([
          { filename: 'pkg.z02', buffer: Buffer.from('part2') },
          { filename: 'pkg.zip', buffer: Buffer.from('part3') },
        ])
      ).toThrow(/missing volume 1/);

      // Missing intermediate volume: z01 and zip without z02
      expect(() =>
        validateAndSortSplitParts([
          { filename: 'pkg.z01', buffer: Buffer.from('part1') },
          { filename: 'pkg.z03', buffer: Buffer.from('part3') },
          { filename: 'pkg.zip', buffer: Buffer.from('part4') },
        ])
      ).toThrow(/missing volume 2/);

      // Duplicate terminal volume
      expect(() =>
        validateAndSortSplitParts([
          { filename: 'pkg.z01', buffer: Buffer.from('part1') },
          { filename: 'pkg.zip', buffer: Buffer.from('term1') },
          { filename: 'pkg.zip', buffer: Buffer.from('term2') },
        ])
      ).toThrow(/terminal volume provided multiple times/);
    });
  });

  // 11. Process Sandbox Stdin Error Handling & TDZ Guard
  describe('11. Process Sandbox Stdin Error Handling & Settlement Guard', () => {
    it('safely cleans up and rejects when stdin stream encounters an early error without TDZ crash', async () => {
      const failingStream = new Readable({
        read() {
          // Immediately emit error
          this.destroy(new Error('Simulated upstream stream network failure'));
        },
      });

      const catBin = fs.existsSync('/bin/cat') ? '/bin/cat' : '/usr/bin/cat';

      await expect(
        executeSandboxedBinary(catBin, [], {
          stdin: failingStream,
          timeoutMs: 2000,
        })
      ).rejects.toThrow('Simulated upstream stream network failure');
    });
  });
});
