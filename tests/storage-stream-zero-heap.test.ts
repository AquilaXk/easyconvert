import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { LocalFsStorage } from '../src/lib/storage/local-fs-storage';

describe('Phase 2-A: Async Stream-First Object Storage & Zero-Heap Local Filesystem', () => {
  let testStorageDir: string;
  let localStorage: LocalFsStorage;

  beforeEach(() => {
    testStorageDir = path.join(os.tmpdir(), `ec-storage-test-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(testStorageDir, { recursive: true });

    localStorage = new LocalFsStorage({
      storageDir: testStorageDir,
      signingSecret: 'secure-test-signing-secret-key-32b',
      defaultTtlSeconds: 3600,
    });
  });

  afterEach(() => {
    localStorage.stopGc();
    try {
      if (fs.existsSync(testStorageDir)) {
        fs.rmSync(testStorageDir, { recursive: true, force: true });
      }
    } catch {}
  });

  describe('LocalFsStorage Stream Operations', () => {
    it('stores and retrieves an object via stream without heap buffering', async () => {
      const sampleContent = 'EasyConvert Zero-Heap Streaming Storage Engine Verification';
      const key = 'test/stream-sample.txt';
      const stream = Readable.from(Buffer.from(sampleContent, 'utf-8'));

      const storedMeta = await localStorage.putStream(key, stream, {
        contentType: 'text/plain',
        filename: 'sample.txt',
        customMetadata: { origin: 'unit-test' },
      });

      expect(storedMeta.key).toBe(key);
      expect(storedMeta.size).toBe(Buffer.byteLength(sampleContent));
      expect(storedMeta.mimeType).toBe('text/plain');
      expect(storedMeta.filename).toBe('sample.txt');
      expect(storedMeta.etag).toMatch(/^"[a-f0-9]{64}"$/);

      // Verify file exists on disk
      const { binPath, metaPath } = localStorage.getPathsForKey(key);
      expect(fs.existsSync(binPath)).toBe(true);
      expect(fs.existsSync(metaPath)).toBe(true);

      // Verify streaming retrieval
      const readResult = await localStorage.getStream(key);
      expect(readResult).not.toBeNull();
      expect(readResult!.metadata.size).toBe(Buffer.byteLength(sampleContent));

      const chunks: Buffer[] = [];
      for await (const chunk of readResult!.stream) {
        chunks.push(Buffer.from(chunk));
      }
      const retrieved = Buffer.concat(chunks).toString('utf-8');
      expect(retrieved).toBe(sampleContent);
    });

    it('serves byte range streams with exact start and end offsets', async () => {
      // 26 characters: 'abcdefghijklmnopqrstuvwxyz'
      const alphabet = 'abcdefghijklmnopqrstuvwxyz';
      const key = 'test/alphabet.txt';
      await localStorage.putBuffer(key, Buffer.from(alphabet, 'ascii'), {
        contentType: 'text/plain',
      });

      // Range: bytes 0-4 ('abcde')
      const range1 = await localStorage.getStream(key, { start: 0, end: 4 });
      expect(range1).not.toBeNull();
      const chunks1: Buffer[] = [];
      for await (const chunk of range1!.stream) {
        chunks1.push(Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks1).toString('ascii')).toBe('abcde');

      // Range: bytes 10-14 ('klmno')
      const range2 = await localStorage.getStream(key, { start: 10, end: 14 });
      expect(range2).not.toBeNull();
      const chunks2: Buffer[] = [];
      for await (const chunk of range2!.stream) {
        chunks2.push(Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks2).toString('ascii')).toBe('klmno');

      // Range: bytes 20-25 ('uvwxyz')
      const range3 = await localStorage.getStream(key, { start: 20, end: 25 });
      expect(range3).not.toBeNull();
      const chunks3: Buffer[] = [];
      for await (const chunk of range3!.stream) {
        chunks3.push(Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks3).toString('ascii')).toBe('uvwxyz');
    });

    it('fails closed when requested range exceeds bounds', async () => {
      const key = 'test/bounds.bin';
      await localStorage.putBuffer(key, Buffer.from('12345', 'ascii'));

      await expect(localStorage.getStream(key, { start: 0, end: 10 })).rejects.toThrow(
        /Invalid byte range/
      );
      await expect(localStorage.getStream(key, { start: 3, end: 2 })).rejects.toThrow(
        /Invalid byte range/
      );
    });

    it('performs atomic multipart upload with contiguous part validation and cleanup', async () => {
      const key = 'multipart/large-artifact.bin';
      const session = await localStorage.createMultipart(key, {
        contentType: 'application/octet-stream',
        filename: 'artifact.bin',
      });

      expect(session.uploadId).toMatch(/^up_\d+_[a-f0-9]+/);
      expect(session.key).toBe(key);

      // Save 3 parts
      const part1Data = Buffer.from('CHUNK_PART_1_DATA_', 'ascii');
      const part2Data = Buffer.from('CHUNK_PART_2_DATA_', 'ascii');
      const part3Data = Buffer.from('CHUNK_PART_3_DATA', 'ascii');

      const part1 = await localStorage.savePartStream(session.uploadId, 1, Readable.from(part1Data));
      const part2 = await localStorage.savePartStream(session.uploadId, 2, Readable.from(part2Data));
      const part3 = await localStorage.savePartStream(session.uploadId, 3, Readable.from(part3Data));

      expect(part1.partNumber).toBe(1);
      expect(part1.size).toBe(part1Data.length);
      expect(part2.partNumber).toBe(2);
      expect(part2.size).toBe(part2Data.length);
      expect(part3.partNumber).toBe(3);
      expect(part3.size).toBe(part3Data.length);

      // Verify fail-closed when completing with missing part (e.g. part 1 and 3 without part 2)
      await expect(
        localStorage.completeMultipart(key, session.uploadId, [part1, part3])
      ).rejects.toThrow(/Multipart parts must be strictly contiguous/);

      // Complete successfully with all 3 parts
      const expectedTotal = part1Data.length + part2Data.length + part3Data.length;
      const completedMeta = await localStorage.completeMultipart(
        key,
        session.uploadId,
        [part2, part1, part3], // test sorting
        expectedTotal
      );

      expect(completedMeta.size).toBe(expectedTotal);
      expect(completedMeta.key).toBe(key);

      // Verify assembled file content
      const assembledBuffer = await localStorage.getBuffer(key);
      expect(assembledBuffer).not.toBeNull();
      const expectedFull = Buffer.concat([part1Data, part2Data, part3Data]);
      expect(assembledBuffer!.equals(expectedFull)).toBe(true);

      // Verify session directory was purged
      const sessionDir = path.join(testStorageDir, '.parts', session.uploadId);
      expect(fs.existsSync(sessionDir)).toBe(false);
    });

    it('purges session directory on abortMultipart', async () => {
      const key = 'aborted/session.dat';
      const session = await localStorage.createMultipart(key);
      await localStorage.savePartStream(session.uploadId, 1, Readable.from(Buffer.from('abort-test')));

      const sessionDir = path.join(testStorageDir, '.parts', session.uploadId);
      expect(fs.existsSync(sessionDir)).toBe(true);

      const aborted = await localStorage.abortMultipart(key, session.uploadId);
      expect(aborted).toBe(true);
      expect(fs.existsSync(sessionDir)).toBe(false);
    });

    it('generates and verifies HMAC presigned URLs with timing-safe signature checking', async () => {
      const key = 'secure/presigned-doc.pdf';
      const uploadId = 'up_98765';
      const partNumber = 1;

      const presigned = await localStorage.presignPart(key, uploadId, partNumber, 600);
      expect(presigned.method).toBe('PUT');
      expect(presigned.signature).toHaveLength(64);

      const isValid = localStorage.verifyPresignedSignature(
        'PUT',
        key,
        presigned.expiresAt,
        presigned.signature,
        uploadId,
        partNumber
      );
      expect(isValid).toBe(true);

      // Tampered key
      expect(
        localStorage.verifyPresignedSignature('PUT', 'tampered-key.pdf', presigned.expiresAt, presigned.signature, uploadId, partNumber)
      ).toBe(false);

      // Length mismatch
      expect(
        localStorage.verifyPresignedSignature('PUT', key, presigned.expiresAt, 'short-sig', uploadId, partNumber)
      ).toBe(false);

      // Expired timestamp
      expect(
        localStorage.verifyPresignedSignature('PUT', key, Math.floor(Date.now() / 1000) - 100, presigned.signature, uploadId, partNumber)
      ).toBe(false);
    });
  });
});
