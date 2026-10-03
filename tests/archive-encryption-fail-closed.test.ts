import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  createZipArchive,
  create7zArchive,
  createTarArchive,
  convertArchive,
  convertWithNative7z,
} from '../src/lib/conversions/archive';
import {
  ArchiveEncryptionUnavailableError,
  UnsupportedOptionError,
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
  });
});

