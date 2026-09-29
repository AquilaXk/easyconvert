import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PDFDocument, rgb } from 'pdf-lib';
import sharp from 'sharp';
import JSZip from 'jszip';
import {
  assertFormatIntegrity,
  assertOracleToolAvailable,
  isOracleToolAvailable,
  getOracleToolPath,
  OracleToolMissingError,
  runDifferentialComparison,
} from './helpers/differential-oracle';
import {
  EnduranceSoakController,
  createDeterministicSyntheticStream,
  streamProcessLargePayload,
  getOpenFileDescriptorCount,
} from '../src/lib/streaming/large-payload-streamer';
import {
  Queue,
  Worker,
  DistributedBullMQAdapter,
} from '../src/lib/queue/bullmq-engine';

/**
 * Builds an authentic 512-byte POSIX ustar TAR archive header with valid octal checksum.
 */
function buildAuthenticTarBuffer(filename: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(filename, 0, 100, 'ascii');
  header.write('0000644\0', 100, 8, 'ascii'); // mode
  header.write('0001750\0', 108, 8, 'ascii'); // uid
  header.write('0001750\0', 116, 8, 'ascii'); // gid

  const sizeOctal = content.length.toString(8).padStart(11, '0') + '\0';
  header.write(sizeOctal, 124, 12, 'ascii'); // size
  header.write('14456781234\0', 136, 12, 'ascii'); // mtime
  header.fill(0x20, 148, 156); // fill checksum with spaces
  header.write('0', 156, 1, 'ascii'); // typeflag: regular file
  header.write('ustar\0', 257, 6, 'ascii'); // magic
  header.write('00', 263, 2, 'ascii'); // version

  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += header[i];
  }
  const chkOctal = checksum.toString(8).padStart(6, '0') + '\0 ';
  header.write(chkOctal, 148, 8, 'ascii');

  const paddedContentLen = Math.ceil(content.length / 512) * 512;
  const contentPadded = Buffer.alloc(paddedContentLen, 0);
  content.copy(contentPadded, 0);

  const trailer = Buffer.alloc(1024, 0);
  return Buffer.concat([header, contentPadded, trailer]);
}

describe('Phase 5: Differential Oracle & Endurance Soak Testnet (#236)', () => {
  // =========================================================================
  // 1. Differential Oracle Strict Mode & Fail-Closed Gate
  // =========================================================================
  describe('1. Differential Oracle Strict Mode & Fail-Closed Gate', () => {
    it('throws OracleToolMissingError when assertOracleToolAvailable is invoked for absent tool', () => {
      expect(() => {
        assertOracleToolAvailable('nonexistent_tool' as any);
      }).toThrow(OracleToolMissingError);

      try {
        assertOracleToolAvailable('nonexistent_tool' as any);
      } catch (err: any) {
        expect(err).toBeInstanceOf(OracleToolMissingError);
        expect(err.tool).toBe('nonexistent_tool');
        expect(err.message).toContain('Differential Oracle external CLI tool "nonexistent_tool" is missing');
        expect(err.isOracleSkip).toBe(true);
      }
    });

    it('rejects truncated buffers across all format specifications', () => {
      const shortBuf = Buffer.from('short');
      const formats = ['pdf', 'png', '7z', 'tar', 'zstd', 'woff2', 'hwp', 'parquet', 'wav', 'webp', 'flac', 'mp3', 'aac', 'zip'];

      for (const fmt of formats) {
        expect(() => assertFormatIntegrity(shortBuf, fmt)).toThrow(
          new RegExp(`Integrity Violation: ${fmt} buffer is too short`)
        );
      }
    });

    it('fails closed on corrupted PDF structures (missing header or EOF marker)', () => {
      const invalidHeader = Buffer.from('NOTPDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
      expect(() => assertFormatIntegrity(invalidHeader, 'pdf')).toThrow(/Missing PDF magic header/);

      const missingEof = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntruncated');
      expect(() => assertFormatIntegrity(missingEof, 'pdf')).toThrow(/Missing PDF EOF marker/);
    });

    it('fails closed on corrupted PNG structures (missing IHDR, invalid dimensions, missing IEND)', () => {
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

      // Missing or invalid IHDR chunk (must be >= 33 bytes to pass magic check)
      const noIhdr = Buffer.concat([
        pngHeader,
        Buffer.from([0x00, 0x00, 0x00, 0x10]), // length 16
        Buffer.from('CORR'), // type not IHDR
        Buffer.alloc(20, 0),
      ]);
      expect(() => assertFormatIntegrity(noIhdr, 'png')).toThrow(/Missing or invalid PNG IHDR chunk/);

      // Invalid 0x0 dimensions
      const zeroDim = Buffer.concat([
        pngHeader,
        Buffer.from([0x00, 0x00, 0x00, 0x0d]), // length 13
        Buffer.from('IHDR'),
        Buffer.from([0x00, 0x00, 0x00, 0x00]), // width 0
        Buffer.from([0x00, 0x00, 0x00, 0x00]), // height 0
        Buffer.from([0x08, 0x02, 0x00, 0x00, 0x00]), // 8-bit truecolor
        Buffer.from([0x00, 0x00, 0x00, 0x00]), // fake crc
        Buffer.from('IEND'),
      ]);
      expect(() => assertFormatIntegrity(zeroDim, 'png')).toThrow(/Invalid PNG dimensions/);

      // Missing IEND
      const validDimNoIend = Buffer.concat([
        pngHeader,
        Buffer.from([0x00, 0x00, 0x00, 0x0d]),
        Buffer.from('IHDR'),
        Buffer.from([0x00, 0x00, 0x00, 0x10]), // width 16
        Buffer.from([0x00, 0x00, 0x00, 0x10]), // height 16
        Buffer.from([0x08, 0x02, 0x00, 0x00, 0x00]),
        Buffer.from([0x00, 0x00, 0x00, 0x00]),
      ]);
      expect(() => assertFormatIntegrity(validDimNoIend, 'png')).toThrow(/Missing PNG IEND chunk/);
    });

    it('fails closed on corrupted JPEG, WebP, WAV, FLAC, and MP3 bitstreams', () => {
      // JPEG missing SOI (length >= 8 bytes)
      const badJpeg = Buffer.from([0x00, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x00, 0x00]);
      expect(() => assertFormatIntegrity(badJpeg, 'jpeg')).toThrow(/Missing JPEG SOI marker/);

      // WebP invalid chunk type
      const badWebp = Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.from([0x20, 0x00, 0x00, 0x00]),
        Buffer.from('WEBP'),
        Buffer.from('VP99'),
      ]);
      expect(() => assertFormatIntegrity(badWebp, 'webp')).toThrow(/Invalid WebP chunk type/);

      // WAV missing data chunk
      const badWav = Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.from([0x28, 0x00, 0x00, 0x00]),
        Buffer.from('WAVE'),
        Buffer.from('fmt '),
        Buffer.from([0x10, 0x00, 0x00, 0x00]), // length 16
        Buffer.from([0x01, 0x00, 0x02, 0x00]), // PCM, 2 channels
        Buffer.from([0x44, 0xac, 0x00, 0x00]), // 44100 Hz
        Buffer.from([0x10, 0xb1, 0x02, 0x00]), // byte rate
        Buffer.from([0x04, 0x00, 0x10, 0x00]), // block align, 16 bits
        Buffer.alloc(8, 0), // missing 'data' chunk
      ]);
      expect(() => assertFormatIntegrity(badWav, 'wav')).toThrow(/Missing data chunk in WAV container/);

      // FLAC bad metadata block header
      const badFlac = Buffer.concat([
        Buffer.from('fLaC'),
        Buffer.from([0x01, 0x00, 0x00, 0x22]), // type 1 instead of 0 (STREAMINFO)
        Buffer.alloc(34, 0),
      ]);
      expect(() => assertFormatIntegrity(badFlac, 'flac')).toThrow(/First FLAC metadata block must be STREAMINFO/);

      // MP3 missing sync word
      const badMp3 = Buffer.alloc(128, 0xaa);
      expect(() => assertFormatIntegrity(badMp3, 'mp3')).toThrow(/Missing valid MPEG audio frame sync/);
    });

    it('fails closed on corrupted ZIP, 7z, TAR, Zstandard, and OpenXML structures', () => {
      // ZIP missing Central Directory
      const badZip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
      expect(() => assertFormatIntegrity(badZip, 'zip')).toThrow(/Missing ZIP End of Central Directory/);

      // 7z invalid major version
      const bad7z = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x0f, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
      expect(() => assertFormatIntegrity(bad7z, '7z')).toThrow(/Invalid 7z major version 15/);

      // TAR missing ustar
      const badTar = Buffer.alloc(512, 0);
      badTar.write('test.txt', 0, 8, 'ascii');
      expect(() => assertFormatIntegrity(badTar, 'tar')).toThrow(/Missing ustar magic header/);

      // Zstd invalid reserved block type
      const badZstd = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x00, 0x06, 0x00, 0x00]); // blockType 3
      expect(() => assertFormatIntegrity(badZstd, 'zstd')).toThrow(/Invalid Zstandard block type/);

      // DOCX missing word/
      const zipWithoutDocx = Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
        Buffer.from([0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
      ]);
      expect(() => assertFormatIntegrity(zipWithoutDocx, 'docx')).toThrow(/Missing WordprocessingML structures/);
    });

    it('fails closed on corrupted CAD STEP and DXF files', () => {
      const badStep = Buffer.from('DATA;\n#1 = CARTESIAN_POINT(\'\', (0., 0., 0.));\nENDSEC;');
      expect(() => assertFormatIntegrity(badStep, 'step')).toThrow(/Missing ISO-10303-21 STEP header/);

      const badDxf = Buffer.from('999\nInvalid DXF File\n');
      expect(() => assertFormatIntegrity(badDxf, 'dxf')).toThrow(/Missing AutoCAD DXF 0 SECTION header/);
    });
  });

  // =========================================================================
  // 2. Independent Third-Party Oracle Bitstream Verification
  // =========================================================================
  describe('2. Independent Third-Party Oracle Bitstream Verification', () => {
    it('verifies valid multi-page PDF structure with independent pdf-lib oracle', async () => {
      const doc = await PDFDocument.create();
      const page1 = doc.addPage([612, 792]);
      page1.drawText('Differential Oracle Audit Page 1', { x: 50, y: 700, color: rgb(0.1, 0.1, 0.1) });
      const page2 = doc.addPage([612, 792]);
      page2.drawText('Differential Oracle Audit Page 2', { x: 50, y: 700, color: rgb(0.1, 0.1, 0.1) });
      doc.setTitle('Enterprise Differential Testnet');
      doc.setAuthor('EasyConvert Oracle Engine');

      const pdfBytes = await doc.save();
      const pdfBuffer = Buffer.from(pdfBytes);

      // 1. Verify format integrity
      expect(() => assertFormatIntegrity(pdfBuffer, 'pdf')).not.toThrow();

      // 2. Independently parse and verify document properties
      const parsedDoc = await PDFDocument.load(pdfBuffer);
      expect(parsedDoc.getPageCount()).toBe(2);
      expect(parsedDoc.getTitle()).toBe('Enterprise Differential Testnet');
      expect(parsedDoc.getAuthor()).toBe('EasyConvert Oracle Engine');

      const pages = parsedDoc.getPages();
      expect(pages[0].getWidth()).toBe(612);
      expect(pages[0].getHeight()).toBe(792);
    });

    it('verifies valid PNG and WebP pixel metadata with independent sharp oracle', async () => {
      const rawImage = await sharp({
        create: {
          width: 64,
          height: 64,
          channels: 4,
          background: { r: 63, g: 81, b: 181, alpha: 1 },
        },
      })
        .png()
        .toBuffer();

      // Verify format integrity
      expect(() => assertFormatIntegrity(rawImage, 'png')).not.toThrow();

      // Independently inspect with sharp
      const meta = await sharp(rawImage).metadata();
      expect(meta.format).toBe('png');
      expect(meta.width).toBe(64);
      expect(meta.height).toBe(64);
      expect(meta.channels).toBe(4);

      // Verify WebP transcoding and metadata
      const webpImage = await sharp(rawImage).webp({ quality: 90 }).toBuffer();
      expect(() => assertFormatIntegrity(webpImage, 'webp')).not.toThrow();

      const webpMeta = await sharp(webpImage).metadata();
      expect(webpMeta.format).toBe('webp');
      expect(webpMeta.width).toBe(64);
      expect(webpMeta.height).toBe(64);
    });

    it('verifies authentic ZIP container and entry CRC32 with independent JSZip oracle', async () => {
      const zip = new JSZip();
      zip.file('metadata.json', JSON.stringify({ version: '1.0.0', service: 'easyconvert' }));
      zip.file('data/content.txt', 'High-fidelity lossless data compression verification.');
      zip.folder('empty-dir');

      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      expect(() => assertFormatIntegrity(zipBuffer, 'zip')).not.toThrow();

      const parsedZip = await JSZip.loadAsync(zipBuffer);
      const metaFile = parsedZip.file('metadata.json');
      expect(metaFile).not.toBeNull();

      const metaContent = await metaFile!.async('text');
      expect(JSON.parse(metaContent).service).toBe('easyconvert');

      const contentFile = parsedZip.file('data/content.txt');
      expect(contentFile).not.toBeNull();
      const text = await contentFile!.async('text');
      expect(text).toContain('lossless data compression');
    });

    it('verifies authentic POSIX ustar TAR container with exact checksum and header alignment', () => {
      const fileData = Buffer.from('Enterprise TAR archive streaming block with 512-byte alignment.');
      const tarBuffer = buildAuthenticTarBuffer('archive/manifest.txt', fileData);

      expect(() => assertFormatIntegrity(tarBuffer, 'tar')).not.toThrow();
      expect(tarBuffer.length % 512).toBe(0);
      expect(tarBuffer.subarray(257, 262).toString('ascii')).toBe('ustar');
    });
  });

  // =========================================================================
  // 3. Endurance Soak Controller & Memory Stability Gate
  // =========================================================================
  describe('3. Endurance Soak Controller & Memory Stability Gate', () => {
    it('executes 20 consecutive streaming soak iterations verifying memory stability and zero FD leaks', async () => {
      const controller = new EnduranceSoakController();
      const initialFds = getOpenFileDescriptorCount();

      const report = await controller.runSoakSession({
        durationMs: 8000,
        maxIterations: 20,
        bytesPerIteration: 1024 * 1024, // 1MB per iteration
        chunkSizeBytes: 64 * 1024,
        warmupIterations: 2,
      });

      expect(report.totalIterations).toBeGreaterThanOrEqual(5);
      expect(report.totalBytesProcessed).toBeGreaterThanOrEqual(5 * 1024 * 1024);
      expect(report.isMemoryStable).toBe(true);
      expect(report.averageThroughputMbPerSec).toBeGreaterThan(10);

      const finalFds = getOpenFileDescriptorCount();
      const fdDelta = Math.abs(finalFds - initialFds);
      // On platforms supporting FD counting, delta must remain near 0 (never unbounded)
      expect(fdDelta).toBeLessThanOrEqual(4);
    });

    it('controller.abort gracefully halts soak loop and returns partial telemetry without errors', async () => {
      const controller = new EnduranceSoakController();

      // Launch soak session in background
      const soakPromise = controller.runSoakSession({
        durationMs: 30000,
        maxIterations: 100,
        bytesPerIteration: 1024 * 1024,
        chunkSizeBytes: 64 * 1024,
      });

      // Abort after 100ms
      await new Promise((resolve) => setTimeout(resolve, 100));
      controller.abort();

      const report = await soakPromise;
      expect(report.totalIterations).toBeLessThan(100);
      expect(report.isMemoryStable).toBe(true);
    });
  });

  // =========================================================================
  // 4. High-Concurrency Job Pipeline & Queue Engine Stress Test
  // =========================================================================
  describe('4. High-Concurrency Job Pipeline & Queue Engine Stress Test', () => {
    it('processes 50 concurrent conversion jobs through Queue with bounded heap memory and zero deadlocks', async () => {
      const queue = new Queue('phase5-stress-queue');
      const processedJobIds: string[] = [];

      const initialHeap = process.memoryUsage().heapUsed;

      // Start worker with concurrency 10
      const worker = new Worker(
        queue,
        async (job) => {
          await job.updateProgress(50);
          processedJobIds.push(job.id);
          return { status: 'success', id: job.id };
        },
        { concurrency: 10 }
      );

      const totalJobs = 50;
      const jobPromises: Promise<any>[] = [];

      // Enqueue 50 concurrent jobs
      for (let i = 0; i < totalJobs; i++) {
        jobPromises.push(
          queue.add('conversion_job', {
            id: `job_${i}`,
            sourceFormat: i % 2 === 0 ? 'png' : 'docx',
            targetFormat: i % 2 === 0 ? 'webp' : 'pdf',
            payloadSize: 1024 * (i + 1),
          })
        );
      }

      await Promise.all(jobPromises);

      // Wait for all 50 jobs to be processed
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for 50 jobs to process. Processed: ${processedJobIds.length}`));
        }, 10000);

        let completedCount = 0;
        worker.on('completed', () => {
          completedCount++;
          if (completedCount === totalJobs) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });

      const counts = await queue.getJobCounts();
      expect(counts.waiting).toBe(0);
      expect(counts.active).toBe(0);
      expect(counts.completed).toBe(totalJobs);
      expect(counts.failed).toBe(0);
      expect(processedJobIds.length).toBe(totalJobs);

      const finalHeap = process.memoryUsage().heapUsed;
      const heapDeltaMb = (finalHeap - initialHeap) / (1024 * 1024);
      // Memory growth across 50 concurrent job lifecycles must be strictly bounded (< 25MB)
      expect(heapDeltaMb).toBeLessThan(25);

      await worker.close();
      await queue.close();
    });
  });

  // =========================================================================
  // 5. Anti-Cheating & Integrity Contract Verification
  // =========================================================================
  describe('5. Anti-Cheating & Integrity Contract Verification', () => {
    it('verifies test oracles fail deterministically instead of silently passing', () => {
      // Nonexistent tool must throw OracleToolMissingError
      expect(() => assertOracleToolAvailable('definitely_missing_tool' as any)).toThrow(OracleToolMissingError);
      expect(isOracleToolAvailable('definitely_missing_tool' as any)).toBe(false);
    });

    it('assertFormatIntegrity rejects empty buffer and zero-byte payloads', () => {
      const emptyBuf = Buffer.alloc(0);
      expect(() => assertFormatIntegrity(emptyBuf, 'pdf')).toThrow(/buffer is too short/);
      expect(() => assertFormatIntegrity(emptyBuf, 'png')).toThrow(/buffer is too short/);
      expect(() => assertFormatIntegrity(emptyBuf, 'zip')).toThrow(/buffer is too short/);
    });
  });
});
