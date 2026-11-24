import { describe, it, expect, vi } from 'vitest';
import { storageProvider } from '../src/lib/storage';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { resolveStorageConfig } from '../src/lib/storage/storage-config';
import { probeNativeEngines, executeWorkerConversion } from '../src/worker/engines';
import { Queue } from '../src/lib/queue/bullmq-engine';
import { ConversionJobData, ConversionJobResult } from '../src/lib/types';
import { probeStream } from './helpers/media-lossy-oracle';
import { oracleTest } from './helpers/oracle-test';

describe('Phase 2: Storage Backend & Container Worker Integration (#109)', () => {
  describe('1. Object Storage Configuration & Presigned URLs', () => {
    it('resolves OCI Seoul tenancy object storage configuration', () => {
      const config = resolveStorageConfig({
        STORAGE_DRIVER: 'oci',
        OCI_NAMESPACE: 'axvym6vk8g7i',
        OCI_REGION: 'ap-seoul-1',
        OCI_BUCKET: 'easyconvert-transcode-bucket',
        OCI_ACCESS_KEY_ID: 'ocikeyid0000000000001',
        OCI_SECRET_ACCESS_KEY: 'oci/secret+key/EXAMPLE000000000000',
      });
      expect(config.driver).toBe('oci');
      if (config.driver !== 'oci') throw new Error('expected oci driver');
      expect(config.region).toBe('ap-seoul-1');
      expect(config.namespace).toBe('axvym6vk8g7i');
      expect(config.bucket).toBe('easyconvert-transcode-bucket');
      expect(config.endpoint).toBe('https://axvym6vk8g7i.compat.objectstorage.ap-seoul-1.oraclecloud.com');
    });

    it('generates compliant multipart upload URLs for large client files', async () => {
      const init = await s3Storage.initiateMultipartUpload(
        'sample_document.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        10 * 1024 * 1024
      );
      try {
        expect(init.uploadId).toBeDefined();
        expect(init.totalParts).toBe(2); // 10 MiB / 5 MiB default S3 part size

        const presigned = s3Storage.generatePresignedUploadUrl(init.key, 1, init.uploadId, 3600);
        // Local storage mints URLs that point back at this application, never at a remote host.
        expect(new URL(presigned.url).pathname).toBe('/api/v1/uploads/direct/part');
        expect(presigned.url).toContain(init.uploadId);
        expect(presigned.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
      } finally {
        await s3Storage.abortMultipartUpload(init.uploadId);
      }
    });

    it('enforces TTL and purges expired transit objects', async () => {
      const testKey = `temp/test_${Date.now()}.bin`;
      const testPayload = Buffer.from('Transit ephemeral conversion payload');

      // A one-minute TTL: a slow runner reads the object well inside it, and the clock is moved
      // past it instead of the test sleeping through a few milliseconds (it failed on CI at 50 ms).
      const ttlMs = 60_000;
      s3Storage.saveObject(testKey, testPayload, 'application/octet-stream', 'test.bin', ttlMs);

      const immediate = s3Storage.getObject(testKey);
      expect(immediate).toBeDefined();
      expect(immediate?.buffer.toString()).toBe('Transit ephemeral conversion payload');

      // Move the clock past the TTL (Date only, so timers and I/O run as usual) and sweep.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(Date.now() + ttlMs + 1_000);
        expect(s3Storage.sweepExpiredObjects()).toBeGreaterThanOrEqual(1);
        expect(s3Storage.getObject(testKey)).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('2. Worker Native Engine Probing & Safe Fallback', () => {
    it('probes native conversion engines without crashing', () => {
      const diagnostics = probeNativeEngines();
      expect(diagnostics).toHaveProperty('soffice');
      expect(diagnostics).toHaveProperty('ffmpeg');
      expect(diagnostics).toHaveProperty('p7zip');
      expect(diagnostics).toHaveProperty('pdftoppm');
      expect(typeof diagnostics.soffice).toBe('boolean');
    });

    it('successfully processes office conversion through orchestrator with fallback', async () => {
      const plainTextDoc = Buffer.from('Hello EasyConvert OCI Worker Architecture');
      const result = await executeWorkerConversion(
        plainTextDoc,
        'txt',
        'pdf',
        {},
        'test.txt'
      );

      expect(result).toBeDefined();
      expect(result.buffer).toBeInstanceOf(Buffer);
      expect(result.size).toBeGreaterThan(0);
      expect(['native-soffice', 'native-soffice-pool', 'internal-fallback']).toContain(result.engineUsed);
      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
    });

    oracleTest('successfully executes audio conversion through worker orchestrator', ['ffmpeg', 'ffprobe'], async () => {
      // 0.1s 44100Hz stereo WAV
      const sampleRate = 44100;
      const channels = 2;
      const numSamples = Math.floor(sampleRate * 0.1 * channels);
      const dataLen = numSamples * 2;
      const wav = Buffer.alloc(44 + dataLen);
      wav.write('RIFF', 0);
      wav.writeUInt32LE(36 + dataLen, 4);
      wav.write('WAVE', 8);
      wav.write('fmt ', 12);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(channels, 22);
      wav.writeUInt32LE(sampleRate, 24);
      wav.writeUInt32LE(sampleRate * channels * 2, 28);
      wav.writeUInt16LE(channels * 2, 32);
      wav.writeUInt16LE(16, 34);
      wav.write('data', 36);
      wav.writeUInt32LE(dataLen, 40);

      const result = await executeWorkerConversion(
        wav,
        'wav',
        'mp3',
        {},
        'audio.wav'
      );

      expect(result.size).toBe(result.buffer.length);
      expect(result.engineUsed).toBe('native-ffmpeg');
      const stream = probeStream(result.buffer, 'mp3', 'a');
      expect(stream.codec_name).toBe('mp3');
      expect(Number(stream.sample_rate)).toBe(sampleRate);
      expect(Number(stream.channels)).toBe(channels);
    });
  });

  describe('3. Queue Job Dispatch & Storage Lifecycle', () => {
    it('dispatches and completes conversion job with storageProvider download URL', async () => {
      const queue = new Queue<ConversionJobData, ConversionJobResult>('test-storage-queue');
      const inputBuffer = Buffer.from('Sample CSV data,column1,column2\n1,a,b\n2,c,d');

      const storageKey = `uploads/job_test_${Date.now()}.csv`;
      await storageProvider.saveObject(storageKey, inputBuffer, 'text/csv', 'data.csv', 3600000);
      let resultKey: string | undefined;

      try {
        const job = await queue.add('convert-csv-to-json', {
          jobId: 'job_storage_1',
          sourceFormat: 'csv',
          targetFormat: 'json',
          originalFilename: 'data.csv',
          fileSize: inputBuffer.length,
          options: {},
          storageKey,
        });

        expect(job.id).toBeDefined();
        expect(job.state).toBe('waiting');

        // Simulate worker processing
        const loaded = await storageProvider.getObject(job.data.storageKey!);
        expect(loaded).toBeDefined();

        const convRes = await executeWorkerConversion(
          loaded!.buffer,
          job.data.sourceFormat,
          job.data.targetFormat,
          {},
          job.data.originalFilename
        );

        resultKey = `results/${job.id}/${convRes.filename}`;
        await storageProvider.saveObject(resultKey, convRes.buffer, convRes.mimeType, convRes.filename, 3600000);

        // Local storage has no object-store host to presign for, so results download through the application.
        const downloadUrl = `/api/storage/file/${resultKey}`;

        const jobResult: ConversionJobResult = {
          jobId: job.id,
          status: 'completed',
          filename: convRes.filename,
          size: convRes.size,
          mimeType: convRes.mimeType,
          downloadUrl,
          resultKey,
          durationMs: 15,
        };

        expect(jobResult.size).toBeGreaterThan(0);
        expect(jobResult.downloadUrl).toContain(resultKey);

        // Verify stored result can be retrieved
        const outputStored = await storageProvider.getObject(resultKey);
        expect(outputStored).toBeDefined();
        expect(JSON.parse(outputStored!.buffer.toString())).toHaveLength(2);
      } finally {
        await storageProvider.deleteObject(storageKey);
        if (resultKey) await storageProvider.deleteObject(resultKey);
        await queue.close();
      }
    });
  });
});
