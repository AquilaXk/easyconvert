import { describe, it, expect, beforeEach } from 'vitest';
import { s3Storage, ociStorage, storageProvider, globalSharedObjects } from '../src/lib/storage';
import { keyStore } from '../src/lib/api-keys/key-store';
import { StreamingHashAndMetricsTransform } from '../src/lib/streaming/large-payload-streamer';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

describe('Phase 1: Storage Architecture & Streaming Unification (#139)', () => {
  beforeEach(() => {
    globalSharedObjects.clear();
  });

  describe('1. Unified SSOT Storage Provider Interface', () => {
    it('shares object state between S3 and OCI storage backends without split-brain', () => {
      const testKey = `test-shared-${Date.now()}.txt`;
      const content = Buffer.from('Enterprise unified storage content');

      // Save via S3 backend
      s3Storage.saveObject(testKey, content, 'text/plain', 'test.txt', 3600 * 1000);

      // Verify retrieval via OCI backend
      const retrievedViaOci = ociStorage.getObject(testKey);
      expect(retrievedViaOci).toBeDefined();
      expect(retrievedViaOci?.buffer.toString('utf-8')).toBe('Enterprise unified storage content');
      expect(retrievedViaOci?.size).toBe(content.length);

      // Verify retrieval via unified storageProvider
      const retrievedViaProvider = storageProvider.getObject(testKey);
      expect(retrievedViaProvider).toBeDefined();
      expect(retrievedViaProvider?.buffer.toString('utf-8')).toBe('Enterprise unified storage content');
    });

    it('makes S3 multipart upload output immediately accessible to OCI worker', () => {
      const filename = 'large_payload.bin';
      const fileData = crypto.randomBytes(64 * 1024);

      // S3 Multipart Upload
      const init = s3Storage.initiateMultipartUpload(filename, 'application/octet-stream', fileData.length);
      s3Storage.uploadPart(init.uploadId, 1, fileData);
      const completed = s3Storage.completeMultipartUpload(init.uploadId);

      // OCI Worker retrieves by completed.key
      const workerFound = ociStorage.getObject(completed.key);
      expect(workerFound).toBeDefined();
      expect(workerFound?.size).toBe(fileData.length);
      expect(workerFound?.buffer.equals(fileData)).toBe(true);
    });

    it('makes OCI worker output immediately retrievable via S3 storage and download route', () => {
      const resultKey = `results/job_123/output.pdf`;
      const resultData = Buffer.from('%PDF-1.4 mock conversion output %%EOF');

      // OCI worker saves output
      ociStorage.saveObject(resultKey, resultData, 'application/pdf', 'output.pdf', 3600 * 1000);

      // S3 download route gets object
      const s3Found = s3Storage.getObject(resultKey);
      expect(s3Found).toBeDefined();
      expect(s3Found?.buffer.toString()).toContain('%PDF-1.4');
    });
  });

  describe('2. Elimination of Base64 Data URI in user-files.json', () => {
    it('sanitizes data URIs in recordUserFile to prevent RAM and disk JSON bloat', async () => {
      const mockUserId = `usr_${Date.now()}`;
      const mockPayload = Buffer.from('Converted Spreadsheet Output');
      const base64Data = mockPayload.toString('base64');
      const dataUri = `data:text/csv;base64,${base64Data}`;

      const recorded = await keyStore.recordUserFile({
        userId: mockUserId,
        fileName: 'result.csv',
        fromFormat: 'xlsx',
        toFormat: 'csv',
        size: mockPayload.length,
        downloadUrl: dataUri,
      });

      // The recorded downloadUrl must be an endpoint URL, NOT a data: URI
      expect(recorded.downloadUrl.startsWith('data:')).toBe(false);
      expect(recorded.downloadUrl).toContain('/api/storage/file/');

      // The file content should be stored in globalSharedObjects
      const files = await keyStore.listUserFiles(mockUserId);
      expect(files.length).toBeGreaterThan(0);
      const userFile = files.find((f) => f.id === recorded.id);
      expect(userFile).toBeDefined();
      expect(userFile?.downloadUrl.startsWith('data:')).toBe(false);
    });
  });

  describe('3. Unified Streaming Pipeline Integration', () => {
    it('processes chunked streams with StreamingHashAndMetricsTransform accurately', async () => {
      const testData = Buffer.from('Streaming pipeline test data with high throughput');
      const expectedDigest = crypto.createHash('sha256').update(testData).digest('hex');

      const transform = new StreamingHashAndMetricsTransform();
      const readable = Readable.from([testData]);

      await new Promise<void>((resolve, reject) => {
        readable.pipe(transform)
          .on('finish', () => resolve())
          .on('error', reject);
      });

      const metrics = transform.getMetrics();
      expect(metrics.totalBytes).toBe(testData.length);
      expect(metrics.digest).toBe(expectedDigest);
    });
  });
});
