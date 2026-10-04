import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  createZipArchive,
  create7zArchive,
  createTarArchive,
  createRarArchive,
  convertArchive,
  convertWithNative7z,
} from '../src/lib/conversions/archive';
import {
  ArchiveEncryptionUnavailableError,
  UnsupportedOptionError,
  ConversionFailedError,
} from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { getOracleToolPath } from './helpers/differential-oracle';

describe('Archive Encryption Fail-Closed Verification', () => {
  const origP7zipPath = process.env.P7ZIP_PATH;
  const origP7zPath = process.env.P7Z_PATH;

  afterEach(() => {
    if (origP7zipPath !== undefined) {
      process.env.P7ZIP_PATH = origP7zipPath;
    } else {
      delete process.env.P7ZIP_PATH;
    }
    if (origP7zPath !== undefined) {
      process.env.P7Z_PATH = origP7zPath;
    } else {
      delete process.env.P7Z_PATH;
    }
  });

  describe('1. Fail-closed when 7z is unavailable for password protection', () => {
    beforeEach(() => {
      process.env.P7ZIP_PATH = '/opt/nonexistent/7z/binary';
      delete process.env.P7Z_PATH;
    });

    it('createZipArchive throws ArchiveEncryptionUnavailableError when password is provided and 7z is absent', async () => {
      const files = [{ filename: 'secret.txt', buffer: Buffer.from('confidential data', 'utf-8') }];
      await expect(
        createZipArchive(files, { password: 'TopSecretPassword123!' }, 'vault.zip')
      ).rejects.toThrow(ArchiveEncryptionUnavailableError);
    });

    it('create7zArchive throws ArchiveEncryptionUnavailableError when password is provided and 7z is absent', () => {
      const files = [{ filename: 'secret.txt', buffer: Buffer.from('confidential data', 'utf-8') }];
      expect(() =>
        create7zArchive(files, { password: 'TopSecretPassword123!' }, 'vault.7z')
      ).toThrow(ArchiveEncryptionUnavailableError);
    });

    it('convertWithNative7z throws ArchiveEncryptionUnavailableError when password is provided and 7z is absent', () => {
      const input = Buffer.from('some archive content', 'utf-8');
      expect(() =>
        convertWithNative7z(input, 'zip', '7z', { password: 'Password123' }, 'test.zip')
      ).toThrow(ArchiveEncryptionUnavailableError);
    });
  });

  describe('2. Fail-closed on TAR family with password protection', () => {
    it('createTarArchive throws UnsupportedOptionError when password is provided', () => {
      const files = [{ filename: 'file.txt', buffer: Buffer.from('data', 'utf-8') }];
      expect(() =>
        createTarArchive(files, { password: 'password' }, 'archive.tar')
      ).toThrow(UnsupportedOptionError);
    });

    it('convertArchive throws UnsupportedOptionError when password is provided for tar targets', async () => {
      const input = Buffer.from('content', 'utf-8');
      const tarTargets = ['tar', 'tar.gz', 'tgz', 'tar.bz2', 'tar.xz', 'txz'];

      for (const tgt of tarTargets) {
        await expect(
          convertArchive(input, 'zip', tgt, { password: 'password' }, 'file.zip')
        ).rejects.toThrow(UnsupportedOptionError);
      }
    });

    it('convertWithNative7z throws UnsupportedOptionError when password is provided for tar targets', () => {
      const input = Buffer.from('content', 'utf-8');
      expect(() =>
        convertWithNative7z(input, 'zip', 'tar.gz', { password: 'password' }, 'file.zip')
      ).toThrow(UnsupportedOptionError);
    });

    it('createRarArchive throws ConversionFailedError per D8 (RAR creation removed)', () => {
      const files = [{ filename: 'file.txt', buffer: Buffer.from('data', 'utf-8') }];
      expect(() =>
        createRarArchive(files, { password: 'password' }, 'archive.rar')
      ).toThrow(ConversionFailedError);
    });

    it('convertArchive fails closed when password is provided for non-encryptable archive formats (rar, gz, bz2, xz, zst)', async () => {
      const input = Buffer.from('content', 'utf-8');
      const nonEncryptableTargets = ['gz', 'bz2', 'xz', 'zst'];

      for (const tgt of nonEncryptableTargets) {
        await expect(
          convertArchive(input, 'zip', tgt, { password: 'password' }, 'file.zip')
        ).rejects.toThrow(UnsupportedOptionError);
      }

      await expect(
        convertArchive(input, 'zip', 'rar', { password: 'password' }, 'file.zip')
      ).rejects.toThrow(ConversionFailedError);
    });

    it('convertArchive fails closed when extracting corrupt or invalid ZIP archive', async () => {
      const corruptZip = Buffer.from('this is not a valid zip archive file', 'utf-8');
      await expect(
        convertArchive(corruptZip, 'zip', 'tar', {}, 'corrupt.zip')
      ).rejects.toThrow(ConversionFailedError);
    });

    it('convertArchive handles valid empty zip archive and creates empty target', async () => {
      const emptyZip = (await createZipArchive([])).buffer;
      const res = await convertArchive(emptyZip, 'zip', 'tar', {}, 'empty.zip');
      expect(res.mimeType).toBe('application/x-tar');
      expect(res.filename).toBe('empty.tar');
      expect(res.buffer.length).toBe(1024);
      expect(res.buffer.every((b) => b === 0)).toBe(true);
    });

    it('convertArchive rejects truncated PK header with length < 22 fail-closed', async () => {
      const truncated = Buffer.from('PK\x03\x04short');
      await expect(
        convertArchive(truncated, 'zip', 'tar', {}, 'truncated.zip')
      ).rejects.toThrow(ConversionFailedError);
    });

    it('convertArchive handles valid empty tar archive and creates empty target', async () => {
      const emptyTar = createTarArchive([]).buffer;
      const res = await convertArchive(emptyTar, 'tar', 'zip', {}, 'empty.tar');
      expect(res.mimeType).toBe('application/zip');
      expect(res.filename).toBe('empty.zip');
      expect(res.buffer.length).toBe(22);
    });

    it('convertArchive rejects non-zip container format starting with PK bytes fail-closed when empty', async () => {
      const fakeRarWithPk = Buffer.alloc(30);
      fakeRarWithPk[0] = 0x50;
      fakeRarWithPk[1] = 0x4b;
      await expect(
        convertArchive(fakeRarWithPk, 'rar', 'zip', {}, 'corrupt.rar')
      ).rejects.toThrow(ConversionFailedError);
    });
  });

  describe('3. Native 7z header encryption and AES-256 inspection via Oracle CLI', () => {
    oracleTest('7z archive created with password uses header encryption (-mhe=on)', ['7z'], async () => {
      const p7z = getOracleToolPath('7z')!;
      process.env.P7ZIP_PATH = p7z;

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-7z-test-'));
      try {
        const files = [{ filename: 'sensitive.txt', buffer: Buffer.from('Classified Payload', 'utf-8') }];
        const res = create7zArchive(files, { password: 'CorrectPassword456' }, 'encrypted.7z');

        const archivePath = path.join(tmpDir, 'encrypted.7z');
        fs.writeFileSync(archivePath, res.buffer);

        // Attempting to list contents with wrong password or empty password MUST fail to read file list
        let listFailedWithWrongPassword = false;
        try {
          execFileSync(p7z, ['l', '-pWrongPassword', archivePath], { stdio: 'pipe' });
        } catch {
          listFailedWithWrongPassword = true;
        }
        expect(listFailedWithWrongPassword).toBe(true);

        // Listing with correct password succeeds and reveals the file name
        const listOut = execFileSync(p7z, ['l', '-pCorrectPassword456', archivePath], {
          encoding: 'utf-8',
        });
        expect(listOut).toContain('sensitive.txt');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    oracleTest('zip archive created with password uses AES-256 encryption (-mem=AES256)', ['7z'], async () => {
      const p7z = getOracleToolPath('7z')!;
      process.env.P7ZIP_PATH = p7z;

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-zip-test-'));
      try {
        const files = [{ filename: 'document.txt', buffer: Buffer.from('Financial Report', 'utf-8') }];
        const res = await createZipArchive(files, { password: 'ZipPassword789' }, 'secure.zip');

        const archivePath = path.join(tmpDir, 'secure.zip');
        fs.writeFileSync(archivePath, res.buffer);

        // 7z technical listing: 7z l -slt -pZipPassword789 secure.zip
        const sltOut = execFileSync(p7z, ['l', '-slt', '-pZipPassword789', archivePath], {
          encoding: 'utf-8',
        });
        expect(sltOut).toMatch(/Method = (?:.*AES-256|AES256)/i);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
