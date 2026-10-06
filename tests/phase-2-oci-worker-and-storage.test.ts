import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ociStorage, OciObjectStorageService } from '../src/lib/storage/oci-storage';
import { probeNativeEngines, executeWorkerConversion } from '../src/worker/engines';
import { Queue, Job } from '../src/lib/queue/bullmq-engine';
import { ConversionJobData, ConversionJobResult } from '../src/lib/types';
import { probeStream } from './helpers/media-lossy-oracle';
import { oracleTest } from './helpers/oracle-test';

describe('Phase 2: OCI Storage Backend & Container Worker Integration (#109)', () => {
  describe('1. OCI Object Storage Configuration & Presigned URLs', () => {
    it('synchronizes default configuration with active OCI Seoul tenancy', () => {
      const storage = new OciObjectStorageService();
      expect(storage.config.region).toBe('ap-seoul-1');
      expect(storage.config.namespace).toBe('axvym6vk8g7i');
      expect(storage.config.bucketName).toBe('easyconvert-transcode-bucket');
      expect(storage.config.endpoint).toContain('ap-seoul-1.oraclecloud.com');
    });

    it('generates compliant multipart upload URLs for large client files', () => {
      const init = ociStorage.initiateMultipartUpload('sample_document.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 10 * 1024 * 1024);
      expect(init.uploadId).toBeDefined();
      expect(init.totalParts).toBe(10); // 10MB / 1MB (dynamic part sizing for <= 50MB)

      if (typeof ociStorage.generatePresignedUploadUrl === 'function') {
        const presigned = ociStorage.generatePresignedUploadUrl(init.key, 1, init.uploadId, 3600);
        expect(presigned.url).toContain('https://');
        expect(presigned.url).toContain(init.uploadId);
        expect(presigned.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
      }
    });

    it('enforces 1-hour TTL and cryptographically purges expired transit objects', async () => {
      const testKey = `temp/test_${Date.now()}.bin`;
      const testPayload = Buffer.from('Transit ephemeral conversion payload');

      // Save with 50ms TTL for testing expiration
      ociStorage.saveObject(testKey, testPayload, 'application/octet-stream', 'test.bin', 50);

      const immediate = ociStorage.getObject(testKey);
      expect(immediate).toBeDefined();
      expect(immediate?.buffer.toString()).toBe('Transit ephemeral conversion payload');

      // Wait for expiration
      await new Promise((r) => setTimeout(r, 60));
      (ociStorage as any).sweepExpiredObjects();

      const expired = ociStorage.getObject(testKey);
      expect(expired).toBeUndefined();
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

  describe('3. Queue Job Dispatch & OCI Storage Lifecycle', () => {
    it('dispatches and completes conversion job with OCI storage download URL', async () => {
      const queue = new Queue<ConversionJobData, ConversionJobResult>('test-oci-queue');
      const inputBuffer = Buffer.from('Sample CSV data,column1,column2\n1,a,b\n2,c,d');

      const storageKey = `uploads/job_test_${Date.now()}.csv`;
      ociStorage.saveObject(storageKey, inputBuffer, 'text/csv', 'data.csv', 3600000);

      const job = await queue.add('convert-csv-to-json', {
        sourceFormat: 'csv',
        targetFormat: 'json',
        originalFilename: 'data.csv',
        storageKey,
      });

      expect(job.id).toBeDefined();
      expect(job.state).toBe('waiting');

      // Simulate worker processing
      const loaded = ociStorage.getObject(job.data.storageKey!);
      expect(loaded).toBeDefined();

      const convRes = await executeWorkerConversion(
        loaded!.buffer,
        job.data.sourceFormat,
        job.data.targetFormat,
        {},
        job.data.originalFilename
      );

      const resultKey = `results/${job.id}/${convRes.filename}`;
      ociStorage.saveObject(resultKey, convRes.buffer, convRes.mimeType, convRes.filename, 3600000);

      let downloadUrl = `/api/storage/file/${resultKey}`;
      if (typeof ociStorage.generatePresignedDownloadUrl === 'function') {
        downloadUrl = ociStorage.generatePresignedDownloadUrl(resultKey, 3600).url;
      }

      const jobResult: ConversionJobResult = {
        jobId: job.id,
        filename: convRes.filename,
        size: convRes.size,
        mimeType: convRes.mimeType,
        downloadUrl,
        storageKey: resultKey,
        convertedAt: new Date().toISOString(),
        processingTimeMs: 15,
      };

      expect(jobResult.size).toBeGreaterThan(0);
      expect(jobResult.downloadUrl).toContain(resultKey);

      // Verify stored result can be retrieved
      const outputStored = ociStorage.getObject(resultKey);
      expect(outputStored).toBeDefined();
      expect(JSON.parse(outputStored!.buffer.toString())).toHaveLength(2);

      await queue.close();
    });
  });
});
