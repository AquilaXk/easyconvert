import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NextRequest } from 'next/server';
import {
  createZipArchive,
  extractZipArchive,
  createTarArchive,
  extractTarArchive,
  create7zArchive,
  extract7zArchive,
  createRarArchive,
  extractRarArchive,
  convertArchive,
  inspectArchive,
  repairZipArchive,
  resolveArchiveEntryCollisions,
  matchArchiveGlob,
  buildSyntheticStoredRarBuffer,
  validateMultiVolumeSequence,
  stitchMultiVolumeArchive,
  splitArchive,
} from '../src/lib/conversions';
import {
  ArchiveEntryCollisionError,
  ArchiveEncryptedHeaderError,
  MissingVolumeError,
  ConversionFailedError,
  UnsupportedOptionError,
} from '../src/lib/types';
import { POST as inspectArchiveRoute } from '../src/app/api/v1/archives/inspect/route';
import { storageProvider } from '../src/lib/storage';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { oracleTest } from './helpers/oracle-test';
import type { User } from '../src/lib/auth/types';

describe('WP-45: Archive Creation, Selective Extraction, Inspection, and Multi-Volume Handling', () => {
  const sha256 = (b: Buffer | Uint8Array): string =>
    crypto.createHash('sha256').update(b).digest('hex');

  let testUser: User;
  let sessionToken: string;

  beforeEach(async () => {
    const email = `archiver_${Date.now()}_${Math.random().toString(36).slice(2)}@test.local`;
    testUser = userStore.sanitizeUser(
      await userStore.createUser({ email, name: 'Archive Tester', tier: 'pro' })
    );
    sessionToken = createSessionToken(testUser);
  });

  // ==========================================================================
  // 1. Entry Collision Policies (rename, error, overwrite)
  // ==========================================================================
  describe('1. Archive Entry Collision Resolution Policies', () => {
    const collidingFiles = [
      { filename: 'report.txt', buffer: Buffer.from('First report v1') },
      { filename: 'report.txt', buffer: Buffer.from('Second report v2') },
      { filename: 'report.txt', buffer: Buffer.from('Third report v3') },
      { filename: 'docs/spec.pdf', buffer: Buffer.from('First spec') },
      { filename: 'docs/spec.pdf', buffer: Buffer.from('Second spec') },
      { filename: 'unique.json', buffer: Buffer.from('{"id": 1}') },
    ];

    it('resolves duplicate entries using "rename" by appending sequential suffixes', () => {
      const resolved = resolveArchiveEntryCollisions(collidingFiles, 'rename');
      expect(resolved.map((r) => r.filename)).toEqual([
        'report.txt',
        'report-1.txt',
        'report-2.txt',
        'docs/spec.pdf',
        'docs/spec-1.pdf',
        'unique.json',
      ]);
      expect(resolved[0].buffer.toString('utf-8')).toBe('First report v1');
      expect(resolved[1].buffer.toString('utf-8')).toBe('Second report v2');
      expect(resolved[2].buffer.toString('utf-8')).toBe('Third report v3');
      expect(resolved[3].buffer.toString('utf-8')).toBe('First spec');
      expect(resolved[4].buffer.toString('utf-8')).toBe('Second spec');
    });

    it('reports the colliding entry name and an exact message under collisionPolicy "error"', () => {
      const duplicates = [
        { filename: 'a.txt', buffer: Buffer.from('1') },
        { filename: 'a.txt', buffer: Buffer.from('2') },
      ];
      let caught: unknown;
      try {
        resolveArchiveEntryCollisions(duplicates, 'error');
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ArchiveEntryCollisionError);
      const collision = caught as ArchiveEntryCollisionError;
      expect(collision.entryName).toBe('a.txt');
      expect(collision.message).toBe(
        "Archive entry collision detected for 'a.txt' under collision policy 'error'."
      );
    });

    it('throws ArchiveEntryCollisionError under collisionPolicy "error"', () => {
      expect(() => resolveArchiveEntryCollisions(collidingFiles, 'error')).toThrow(
        ArchiveEntryCollisionError
      );

      // Unique files should not throw
      const uniqueFiles = [
        { filename: 'a.txt', buffer: Buffer.from('a') },
        { filename: 'b.txt', buffer: Buffer.from('b') },
      ];
      expect(resolveArchiveEntryCollisions(uniqueFiles, 'error')).toHaveLength(2);
    });

    it('keeps the last occurrence under collisionPolicy "overwrite"', () => {
      const resolved = resolveArchiveEntryCollisions(collidingFiles, 'overwrite');
      expect(resolved.map((r) => r.filename)).toEqual(['report.txt', 'docs/spec.pdf', 'unique.json']);
      expect(resolved[0].buffer.toString('utf-8')).toBe('Third report v3');
      expect(resolved[1].buffer.toString('utf-8')).toBe('Second spec');
    });

    it('applies collision policy across ZIP, TAR, and 7z creation', async () => {
      // 1. ZIP with rename
      const zipRes = await createZipArchive(collidingFiles, { collisionPolicy: 'rename' });
      const extractedZip = await extractZipArchive(zipRes.buffer);
      const zipFilenames = extractedZip.map((f) => f.filename);
      expect(zipFilenames).toContain('report.txt');
      expect(zipFilenames).toContain('report-1.txt');
      expect(zipFilenames).toContain('report-2.txt');

      // 2. TAR with error
      expect(() => createTarArchive(collidingFiles, { collisionPolicy: 'error' })).toThrow(
        ArchiveEntryCollisionError
      );

      // 3. 7z with overwrite
      const sevenZipRes = create7zArchive(collidingFiles, { collisionPolicy: 'overwrite' });
      const extracted7z = extract7zArchive(sevenZipRes.buffer);
      expect(extracted7z).toHaveLength(3);
      const reportEntry = extracted7z.find((f) => f.filename === 'report.txt');
      expect(reportEntry).toBeDefined();
      expect(reportEntry!.buffer.toString('utf-8')).toBe('Third report v3');
    });
  });

  // ==========================================================================
  // 2. Glob-Based Selective Extraction (entries: string[])
  // ==========================================================================
  describe('2. Glob-Based Selective Extraction', () => {
    it('matches glob patterns with matchArchiveGlob', () => {
      expect(matchArchiveGlob('src/index.ts', ['src/*.ts'])).toBe(true);
      expect(matchArchiveGlob('src/lib/utils.ts', ['src/*.ts'])).toBe(false);
      expect(matchArchiveGlob('src/lib/utils.ts', ['src/**/*.ts'])).toBe(true);
      expect(matchArchiveGlob('README.md', ['*.md'])).toBe(true);
      expect(matchArchiveGlob('deep/nested/path/config.json', ['**/*.json'])).toBe(true);
      expect(matchArchiveGlob('test.png', ['*.jpg', '*.png'])).toBe(true);
      expect(matchArchiveGlob('test.gif', ['*.jpg', '*.png'])).toBe(false);
    });

    it('selectively extracts matching entries in ZIP, TAR, and 7z', async () => {
      const files = [
        { filename: 'docs/readme.txt', buffer: Buffer.from('Readme contents') },
        { filename: 'docs/guide.pdf', buffer: Buffer.from('PDF guide content') },
        { filename: 'images/logo.png', buffer: Buffer.from('PNG logo data') },
        { filename: 'src/main.js', buffer: Buffer.from('console.log("hello");') },
        { filename: 'src/utils.js', buffer: Buffer.from('export const x = 1;') },
      ];

      // 1. ZIP selective extraction
      const zipRes = await createZipArchive(files);
      const zipOnlyDocs = await extractZipArchive(zipRes.buffer, { entries: ['docs/**'] });
      expect(zipOnlyDocs.map((f) => f.filename).sort()).toEqual(['docs/guide.pdf', 'docs/readme.txt']);

      // 2. TAR selective extraction
      const tarRes = createTarArchive(files);
      const tarOnlyJs = extractTarArchive(tarRes.buffer, { entries: ['*.js', '**/*.js'] });
      expect(tarOnlyJs.map((f) => f.filename).sort()).toEqual(['src/main.js', 'src/utils.js']);

      // 3. 7z selective extraction
      const sevenZipRes = create7zArchive(files);
      const sevenZipSingle = extract7zArchive(sevenZipRes.buffer, { entries: ['images/logo.png'] });
      expect(sevenZipSingle).toHaveLength(1);
      expect(sevenZipSingle[0].filename).toBe('images/logo.png');
      expect(sevenZipSingle[0].buffer.toString('utf-8')).toBe('PNG logo data');
    });
  });

  // ==========================================================================
  // 3. Fast Archive Inspection (inspectArchive)
  // ==========================================================================
  describe('3. Fast Archive Inspection', () => {
    it('inspects ZIP archives via Central Directory parsing without full inflation', async () => {
      const files = [
        { filename: 'alpha.txt', buffer: Buffer.from('Alpha data content') },
        { filename: 'sub/beta.json', buffer: Buffer.from('{"key": "value"}') },
      ];
      const zipRes = await createZipArchive(files);
      const info = await inspectArchive(zipRes.buffer, { filename: 'test.zip' });

      expect(info.format).toBe('zip');
      expect(info.totalEntries).toBe(3);
      expect(info.isEncrypted).toBe(false);
      expect(info.totalUncompressedBytes).toBe(
        'Alpha data content'.length + '{"key": "value"}'.length
      );
      expect(info.totalCompressedBytes).toBeGreaterThan(0);
      const nonDirEntries = info.entries.filter((e) => !e.isDirectory);
      expect(nonDirEntries.map((e) => e.name).sort()).toEqual(['alpha.txt', 'sub/beta.json']);
      expect(nonDirEntries[0].crc32).toMatch(/^[0-9a-f]{8}$/);
      expect(nonDirEntries[0].isDirectory).toBe(false);
    });

    it('inspects TAR archives parsing standard UStar headers', async () => {
      const files = [
        { filename: 'file1.txt', buffer: Buffer.from('First TAR file') },
        { filename: 'file2.txt', buffer: Buffer.from('Second TAR file with more content') },
      ];
      const tarRes = createTarArchive(files);
      const info = await inspectArchive(tarRes.buffer, { filename: 'test.tar' });

      expect(info.format).toBe('tar');
      expect(info.totalEntries).toBe(2);
      expect(info.isEncrypted).toBe(false);
      expect(info.totalUncompressedBytes).toBe(
        'First TAR file'.length + 'Second TAR file with more content'.length
      );
      expect(info.entries.map((e) => e.name)).toEqual(['file1.txt', 'file2.txt']);
    });

    it('inspects 7z archives and detects uncompressed structure and entry counts', async () => {
      const files = [
        { filename: 'data1.bin', buffer: Buffer.from([0x01, 0x02, 0x03, 0x04]) },
        { filename: 'data2.bin', buffer: Buffer.from([0x05, 0x06, 0x07, 0x08]) },
      ];
      const sevenZipRes = create7zArchive(files);
      const info = await inspectArchive(sevenZipRes.buffer, { filename: 'test.7z' });

      expect(info.format).toBe('7z');
      expect(info.totalEntries).toBe(2);
      expect(info.isEncrypted).toBe(false);
      expect(info.totalUncompressedBytes).toBe(8);
      expect(info.entries.map((e) => e.name)).toEqual(['data1.bin', 'data2.bin']);
    });

    it('inspects synthetic stored RAR archives and parses headers accurately', async () => {
      const files = [
        { filename: 'rar1.txt', buffer: Buffer.from('RAR file entry 1') },
        { filename: 'rar2.txt', buffer: Buffer.from('RAR file entry 2') },
      ];
      const rarBuffer = buildSyntheticStoredRarBuffer(files);
      const info = await inspectArchive(rarBuffer, { filename: 'sample.rar' });

      expect(info.format).toBe('rar');
      expect(info.totalEntries).toBe(2);
      expect(info.isEncrypted).toBe(false);
      expect(info.totalUncompressedBytes).toBe(
        'RAR file entry 1'.length + 'RAR file entry 2'.length
      );
      expect(info.entries.map((e) => e.name)).toEqual(['rar1.txt', 'rar2.txt']);
    });

    it('throws ArchiveEncryptedHeaderError when inspecting encrypted RAR/7z headers without password', async () => {
      // Build a synthetic RAR buffer with MHD_PASSWORD flag (0x0080) in the main archive header
      const marker = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
      const mainHead = Buffer.alloc(13);
      mainHead.writeUInt16LE(0x1234, 0); // CRC placeholder
      mainHead.writeUInt8(0x73, 2); // HEAD_TYPE (MAIN_HEAD)
      mainHead.writeUInt16LE(0x0080, 3); // HEAD_FLAGS: MHD_PASSWORD
      mainHead.writeUInt16LE(13, 5); // HEAD_SIZE
      const encRar = Buffer.concat([marker, mainHead]);

      await expect(inspectArchive(encRar, { filename: 'encrypted.rar' })).rejects.toThrow(
        ArchiveEncryptedHeaderError
      );
    });
  });

  // ==========================================================================
  // 4. Archive Inspection HTTP Endpoint (POST /api/v1/archives/inspect)
  // ==========================================================================
  describe('4. Archive Inspection HTTP Endpoint', () => {
    it('inspects archive from multipart/form-data request', async () => {
      const files = [{ filename: 'upload.txt', buffer: Buffer.from('Multipart upload content') }];
      const zipRes = await createZipArchive(files);

      const formData = new FormData();
      formData.append('file', new Blob([new Uint8Array(zipRes.buffer)], { type: 'application/zip' }), 'sample.zip');

      const req = new NextRequest('http://localhost:3000/api/v1/archives/inspect', {
        method: 'POST',
        headers: {
          Cookie: `easyconvert_session=${sessionToken}`,
        },
        body: formData,
      });

      const res = await inspectArchiveRoute(req);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.format).toBe('zip');
      expect(body.totalEntries).toBe(1);
      expect(body.entries[0].name).toBe('upload.txt');
    });

    it('inspects archive from JSON request with storageKey', async () => {
      const files = [{ filename: 'stored.txt', buffer: Buffer.from('Stored archive test') }];
      const zipRes = await createZipArchive(files);

      const storageKey = `test_inspect_${Date.now()}`;
      storageProvider.saveObject(storageKey, zipRes.buffer, 'application/zip', 'archive.zip', 3600000);

      const req = new NextRequest('http://localhost:3000/api/v1/archives/inspect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `easyconvert_session=${sessionToken}`,
        },
        body: JSON.stringify({ storageKey }),
      });

      const res = await inspectArchiveRoute(req);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.format).toBe('zip');
      expect(body.totalEntries).toBe(1);
      expect(body.entries[0].name).toBe('stored.txt');
    });

    it('returns RFC 9457 422 problem details when archive header is encrypted', async () => {
      const marker = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
      const mainHead = Buffer.alloc(13);
      mainHead.writeUInt16LE(0x1234, 0);
      mainHead.writeUInt8(0x73, 2);
      mainHead.writeUInt16LE(0x0080, 3); // MHD_PASSWORD
      mainHead.writeUInt16LE(13, 5);
      const encRar = Buffer.concat([marker, mainHead]);

      const req = new NextRequest('http://localhost:3000/api/v1/archives/inspect?filename=locked.rar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          Cookie: `easyconvert_session=${sessionToken}`,
        },
        body: encRar,
      });

      const res = await inspectArchiveRoute(req);
      expect(res.status).toBe(422);

      const body = await res.json();
      expect(body.type).toBe('https://api.easyconvert.io/problems/archive-encrypted-header');
      expect(body.title).toBe('Archive Header Encrypted');
    });

    it('rejects unauthenticated requests with 401', async () => {
      const req = new NextRequest('http://localhost:3000/api/v1/archives/inspect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
        },
        body: Buffer.from('dummy'),
      });

      const res = await inspectArchiveRoute(req);
      expect(res.status).toBe(401);
    });
  });

  // ==========================================================================
  // 5. Multi-Volume Handling & MissingVolumeError
  // ==========================================================================
  describe('5. Multi-Volume Handling and Sequence Validation', () => {
    it('throws MissingVolumeError with exact missing volume name on missing volume 1', () => {
      const partNames = ['bundle.part2.rar', 'bundle.part3.rar'];
      expect(() => validateMultiVolumeSequence(partNames)).toThrow(MissingVolumeError);
      expect(() => validateMultiVolumeSequence(partNames)).toThrow(/bundle\.part1\.rar/);
    });

    it('throws MissingVolumeError on gaps in sequential parts', () => {
      const partNames = ['backup.7z.001', 'backup.7z.003'];
      expect(() => validateMultiVolumeSequence(partNames)).toThrow(MissingVolumeError);
      expect(() => validateMultiVolumeSequence(partNames)).toThrow(/backup\.7z\.002/);
    });

    it('successfully validates and sorts multi-volume sequences', () => {
      const unsorted = ['data.part3.rar', 'data.part1.rar', 'data.part2.rar'];
      const sorted = validateMultiVolumeSequence(unsorted);
      expect(sorted.sortedParts.map((s) => s.info.partNumber)).toEqual([1, 2, 3]);
    });
  });

  // ==========================================================================
  // 6. ZIP Repair Mode (repair: true)
  // ==========================================================================
  describe('6. ZIP Repair Mode', () => {
    it('repairs damaged/truncated ZIP archives by salvaging Local File Headers', async () => {
      const files = [
        { filename: 'healthy1.txt', buffer: Buffer.from('Healthy data payload 1') },
        { filename: 'healthy2.txt', buffer: Buffer.from('Healthy data payload 2') },
      ];
      const validZip = await createZipArchive(files);

      // Truncate the ZIP archive at the end of the file data (cutting off Central Directory and EOCD)
      // Find position of the Central Directory signature: 0x50, 0x4b, 0x01, 0x02
      const cdIdx = validZip.buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      expect(cdIdx).toBeGreaterThan(0);

      const truncatedZip = validZip.buffer.subarray(0, cdIdx);

      // Standard extraction fails because Central Directory is completely missing
      await expect(extractZipArchive(truncatedZip)).rejects.toThrow();

      // Repair mode salvages all entries and reconstructs intact ZIP
      const repaired = await repairZipArchive(truncatedZip);
      expect(repaired.length).toBeGreaterThan(0);

      const salvaged = await extractZipArchive(repaired);
      expect(salvaged).toHaveLength(2);
      expect(salvaged.map((s) => s.filename).sort()).toEqual(['healthy1.txt', 'healthy2.txt']);
      expect(salvaged.find((s) => s.filename === 'healthy1.txt')!.buffer.toString('utf-8')).toBe(
        'Healthy data payload 1'
      );
    });

    it('rejects repair option on non-ZIP archive formats with UnsupportedOptionError', async () => {
      const buffer = Buffer.from('dummy data');
      await expect(
        convertArchive(buffer, 'tar', 'tar', { repair: true }, 'test.tar')
      ).rejects.toThrow(UnsupportedOptionError);
    });
  });

  // ==========================================================================
  // 7. Design Decision D8: Fail-Closed RAR Creation Elimination
  // ==========================================================================
  describe('7. Design Decision D8: Permanent RAR Creation Removal', () => {
    it('throws ConversionFailedError fail-closed when attempting to create RAR archives', async () => {
      const files = [{ filename: 'test.txt', buffer: Buffer.from('data') }];
      expect(() => createRarArchive(files)).toThrow(ConversionFailedError);

      await expect(
        convertArchive(Buffer.from('sample content'), 'txt', 'rar', {}, 'test.txt')
      ).rejects.toThrow(ConversionFailedError);
    });

    it('verifies "rar" is completely absent from targetFormats across all registry entries', () => {
      let totalFormatsChecked = 0;
      for (const format of Object.values(FORMAT_REGISTRY)) {
        expect(format.targetFormats).not.toContain('rar');
        totalFormatsChecked++;
      }
      expect(totalFormatsChecked).toBe(Object.keys(FORMAT_REGISTRY).length);
    });

    it('preserves full extraction support for RAR archives', () => {
      const files = [{ filename: 'extracted.txt', buffer: Buffer.from('Stored rar content') }];
      const rarBuffer = buildSyntheticStoredRarBuffer(files);
      const extracted = extractRarArchive(rarBuffer);
      expect(extracted).toHaveLength(1);
      expect(extracted[0].filename).toBe('extracted.txt');
      expect(extracted[0].buffer.toString('utf-8')).toBe('Stored rar content');
    });
  });

  // ==========================================================================
  // 8. Differential Oracle Validation (tar -tvf, 7z l)
  // ==========================================================================
  describe('8. Differential Oracle Inspection Validation', () => {
    it('verifies TAR archive generation structure with system tar CLI', () => {
      const files = [
        { filename: 'oracle_sample.txt', buffer: Buffer.from('Oracle verification payload') },
        { filename: 'nested/dir/item.json', buffer: Buffer.from('{"verified": true}') },
      ];
      const tarRes = createTarArchive(files);

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tar-oracle-'));
      const tarPath = path.join(tmpDir, 'test.tar');
      try {
        fs.writeFileSync(tarPath, tarRes.buffer);
        const output = execFileSync('/usr/bin/tar', ['-tvf', tarPath], {
          encoding: 'utf-8',
        });
        expect(output).toContain('oracle_sample.txt');
        expect(output).toContain('nested/dir/item.json');
        const lines = output.trim().split('\n').filter((l) => l.trim().length > 0);
        expect(lines.length).toBe(2);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    oracleTest('verifies 7z archive structure with 7z l CLI', ['7z'], () => {
      const files = [
        { filename: 'fileA.txt', buffer: Buffer.from('Alpha 7z data') },
        { filename: 'fileB.txt', buffer: Buffer.from('Beta 7z data') },
      ];
      const res = create7zArchive(files);

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '7z-oracle-'));
      const archivePath = path.join(tmpDir, 'test.7z');
      try {
        fs.writeFileSync(archivePath, res.buffer);
        const out = execFileSync('7z', ['l', archivePath], { encoding: 'utf-8' });
        expect(out).toContain('fileA.txt');
        expect(out).toContain('fileB.txt');
        const matchFiles = out.match(/file[AB]\.txt/g) || [];
        expect(matchFiles.length).toBe(2);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
