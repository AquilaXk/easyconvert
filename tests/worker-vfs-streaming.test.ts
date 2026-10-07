import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { ociStorage, s3Storage, storageProvider, globalSharedObjects } from '../src/lib/storage';
import {
  executeWorkerConversion,
  resolveInputContext,
  assertNotSpoofedFileVfs,
  preserveOutput,
  createConversionResult,
} from '../src/worker/engines';
import { FileExtensionSpoofError } from '../src/lib/types';

describe('Phase 2: Zero-Heap VFS Streaming Pipeline for 2GB+ Payloads', () => {
  let tempDir: string;

  beforeEach(() => {
    globalSharedObjects.clear();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-test-'));
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  });

  describe('1. Storage Backend saveObjectFromFile Zero-Heap Persistence', () => {
    it('persists object directly from disk filePath without pre-allocating buffer in memory', async () => {
      const filePath = path.join(tempDir, 'sample_dataset.csv');
      const testContent = 'id,name,value\n1,alpha,100\n2,beta,200\n';
      fs.writeFileSync(filePath, testContent, 'utf-8');

      const storageKey = `datasets/sample_${Date.now()}.csv`;
      const stored = ociStorage.saveObjectFromFile!(
        storageKey,
        filePath,
        'text/csv',
        'sample_dataset.csv',
        3600 * 1000
      );

      expect(stored).toBeDefined();
      expect(stored.key).toContain(storageKey);
      expect(stored.filePath).toBe(filePath);
      expect(stored.size).toBe(Buffer.byteLength(testContent, 'utf-8'));
      expect(stored.etag).toMatch(/^"[a-f0-9]+"/);

      // Verify cross-backend retrieval via unified storageProvider
      const retrieved = await storageProvider.getObject(storageKey);
      expect(retrieved).toBeDefined();
      expect(retrieved?.filePath).toBe(filePath);
      expect(retrieved?.size).toBe(Buffer.byteLength(testContent, 'utf-8'));
      // Buffer accessed lazily
      expect(retrieved?.buffer.toString('utf-8')).toBe(testContent);
    });

    it('works identically in S3ObjectStorageService saveObjectFromFile', () => {
      const filePath = path.join(tempDir, 's3_payload.json');
      const jsonContent = JSON.stringify({ status: 'ok', items: [1, 2, 3] });
      fs.writeFileSync(filePath, jsonContent, 'utf-8');

      const key = `json_files/payload_${Date.now()}.json`;
      const s3Stored = s3Storage.saveObjectFromFile!(
        key,
        filePath,
        'application/json',
        's3_payload.json'
      );

      expect(s3Stored.filePath).toBe(filePath);
      expect(s3Stored.size).toBe(Buffer.byteLength(jsonContent, 'utf-8'));
      expect(s3Stored.buffer.toString('utf-8')).toBe(jsonContent);
    });
  });

  describe('2. Fail-Closed VFS Anti-Spoofing Header Sniffing', () => {
    it('allows valid text files on disk without memory bloat', () => {
      const txtPath = path.join(tempDir, 'valid.txt');
      fs.writeFileSync(txtPath, 'Valid plain text content for testing.');

      expect(() => {
        assertNotSpoofedFileVfs({ inputPath: txtPath }, 'txt', 'valid.txt');
      }).not.toThrow();
    });

    it('rejects spoofed ELF binary disguised as txt file on disk (fail-closed)', () => {
      const spoofPath = path.join(tempDir, 'fake.txt');
      // 0x7F 'E' 'L' 'F' header
      const elfHeader = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
      fs.writeFileSync(spoofPath, elfHeader);

      expect(() => {
        assertNotSpoofedFileVfs({ inputPath: spoofPath }, 'txt', 'fake.txt');
      }).toThrowError(FileExtensionSpoofError);
    });

    it('rejects spoofed PE/MZ Windows executable disguised as txt file on disk (fail-closed)', () => {
      const spoofPath = path.join(tempDir, 'malicious.txt');
      // 'M' 'Z' DOS header
      const mzHeader = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
      fs.writeFileSync(spoofPath, mzHeader);

      expect(() => {
        assertNotSpoofedFileVfs({ inputPath: spoofPath }, 'txt', 'malicious.txt');
      }).toThrowError(FileExtensionSpoofError);
    });
  });

  describe('3. Lazy 2GB+ Buffer Evaluation & RangeError Guard', () => {
    it('returns valid buffer for normal files under 2GB limit', () => {
      const outPath = path.join(tempDir, 'result.json');
      fs.writeFileSync(outPath, '{"result": true}');

      const result = createConversionResult(outPath, 'json', 'result', 'internal-fallback', 10);
      expect(result.filePath).toBe(outPath);
      expect(result.size).toBe(16);
      expect(result.buffer.toString('utf-8')).toBe('{"result": true}');
    });

    it('throws RangeError when accessing .buffer on files exceeding the 2GB V8 Buffer limit', () => {
      const dummyPath = path.join(tempDir, 'simulated_3gb.bin');
      fs.writeFileSync(dummyPath, 'header');

      // Mock statSync to simulate a 3GB (3,221,225,472 bytes) file on disk
      const originalStatSync = fs.statSync;
      const statSpy = (target: fs.PathLike, options?: any) => {
        if (target === dummyPath) {
          const realStat = originalStatSync(target, options);
          return {
            ...realStat,
            size: 3 * 1024 * 1024 * 1024, // 3GB
          } as fs.Stats;
        }
        return originalStatSync(target, options);
      };

      fs.statSync = statSpy as any;

      try {
        const result = createConversionResult(
          dummyPath,
          'bin',
          'simulated_3gb',
          'internal-fallback',
          25
        );

        expect(result.filePath).toBe(dummyPath);
        expect(result.size).toBe(3 * 1024 * 1024 * 1024);

        // Accessing result.buffer must fail-closed with RangeError rather than crashing V8 process
        expect(() => result.buffer).toThrowError(RangeError);
        expect(() => result.buffer).toThrowError(/exceeds 2GB V8 buffer limit/);
      } finally {
        fs.statSync = originalStatSync;
      }
    });
  });

  describe('4. VFS Zero-Heap Execution Pipeline in executeWorkerConversion', () => {
    it('processes WorkerVfsPayload inputPath and produces valid persisted output', async () => {
      const inputPath = path.join(tempDir, 'input.csv');
      const csvData = 'name,score\nAlice,95\nBob,88\nCharlie,92\n';
      fs.writeFileSync(inputPath, csvData);

      const targetPath = path.join(tempDir, 'custom_output.json');

      const result = await executeWorkerConversion(
        {
          inputPath,
          outputPath: targetPath,
        },
        'csv',
        'json',
        {},
        'test_scores.csv'
      );

      expect(result).toBeDefined();
      expect(result.filename).toBe('test_scores.json');
      expect(result.mimeType).toBe('application/json');
      expect(fs.existsSync(targetPath)).toBe(true);

      const parsed = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(3);
      expect(parsed[0].name).toBe('Alice');
    });

    it('resolves input context efficiently without copying when inputPath is provided', () => {
      const srcPath = path.join(tempDir, 'source.txt');
      fs.writeFileSync(srcPath, 'Hello VFS');

      const subTemp = path.join(tempDir, 'subtemp');
      fs.mkdirSync(subTemp);

      const resolved = resolveInputContext({ inputPath: srcPath }, 'txt', subTemp);
      expect(resolved.inputPath).toBe(srcPath);
      expect(resolved.isTemporary).toBe(false);
      // No extra file created in subtemp
      expect(fs.readdirSync(subTemp)).toHaveLength(0);
    });

    it('preserves output outside ephemeral sandbox before teardown cleanup', () => {
      const ephemeralDir = path.join(tempDir, 'ephemeral');
      fs.mkdirSync(ephemeralDir);
      const ephemeralOut = path.join(ephemeralDir, 'output.txt');
      fs.writeFileSync(ephemeralOut, 'Converted Content');

      const preserved = preserveOutput(ephemeralOut, 'txt', {});
      expect(fs.existsSync(preserved)).toBe(true);
      expect(fs.readFileSync(preserved, 'utf-8')).toBe('Converted Content');

      // Ephemeral dir can now be safely destroyed
      fs.rmSync(ephemeralDir, { recursive: true, force: true });
      expect(fs.existsSync(preserved)).toBe(true);

      // Clean up preserved
      try {
        fs.unlinkSync(preserved);
      } catch {}
    });
  });
});
