import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  convertArchive,
  convertWithNative7z,
  create7zArchive,
  createZipArchive,
  extractRarArchive,
  extractWithSpannedStream7z,
  extractZipArchive,
  get7zBinaryPath,
  inspectArchive,
} from '../src/lib/conversions/archive';
import {
  ENCRYPTION_LISTING_BYTES_PER_ENTRY,
  MAX_ARCHIVE_PASSWORD_BYTES,
  MAX_ENCRYPTED_ARCHIVE_ENTRIES,
  MAX_ENCRYPTION_LISTING_BYTES,
  MAX_ZIP_PASSWORD_BYTES,
  assertEncryptedArchiveInputWithinLimits,
  assertArchivePasswordSafe,
  assertListingShowsEncryption,
  assertZipPasswordSupported,
  execFileSyncWithPasswordStdin,
  isArchivePasswordFailure,
  sevenZipCreatePasswordInput,
  sevenZipReadPasswordInput,
} from '../src/lib/conversions/archive-password';
import { convertWithNative7z as convertWithWorker7z } from '../src/worker/engines';
import { NextRequest } from 'next/server';
import { POST as convertRoute } from '../src/app/api/convert/route';
import {
  ArchiveEncryptedHeaderError,
  ArchiveNotEncryptedError,
  ArchivePasswordRequiredError,
  ConversionFailedError,
  InvalidArchivePasswordError,
  UnsupportedOptionError,
} from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { OracleToolMissingError, getOracleToolPath } from './helpers/differential-oracle';
import { buildStoredRar4 } from './helpers/rar4-stored';
import { buildEncryptedRar5 } from './helpers/rar5-encrypted';

/**
 * Archive passwords reach 7-Zip on stdin, never in argv (issue #490). Every test here runs the real
 * 7z binary the engines resolve (override with P7ZIP_PATH to run another build, for example
 * p7zip 16.02). Fixtures are written, and results verified, by the `7z` and `unrar` CLIs found on
 * PATH with the password in their own argv, so the engine never judges its own output.
 */

const PASSWORD = 'Correct-Horse-Battery-1';
const WRONG_PASSWORD = 'not-the-password';

interface PlainFile {
  name: string;
  data: Buffer;
}

/** Incompressible bytes from a fixed LCG, so multi-volume fixtures split at predictable sizes. */
function pseudoRandomBytes(length: number): Buffer {
  const out = Buffer.alloc(length);
  let state = 0x2545f491;
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

const PLAIN_FILES: readonly PlainFile[] = [
  { name: 'notes.txt', data: Buffer.from('confidential notes\nsecond line\n', 'utf-8') },
  { name: 'nested/data.bin', data: pseudoRandomBytes(3000) },
];

function withTempDir<T>(work: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'archive-password-'));
  try {
    return work(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writePlainTree(root: string): void {
  for (const file of PLAIN_FILES) {
    const target = path.join(root, file.name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.data);
  }
}

type FixtureKind = 'zip-aes256' | 'zip-zipcrypto' | '7z-encrypted-header' | '7z-encrypted-data';

const FIXTURES: Record<FixtureKind, { extension: 'zip' | '7z'; flags: string[] }> = {
  'zip-aes256': { extension: 'zip', flags: ['-tzip', '-mem=AES256'] },
  'zip-zipcrypto': { extension: 'zip', flags: ['-tzip', '-mem=ZipCrypto'] },
  '7z-encrypted-header': { extension: '7z', flags: ['-t7z', '-mhe=on'] },
  '7z-encrypted-data': { extension: '7z', flags: ['-t7z'] },
};
const ZIP_KINDS: FixtureKind[] = ['zip-aes256', 'zip-zipcrypto'];
const ALL_KINDS = Object.keys(FIXTURES) as FixtureKind[];

/** The engines run 7-Zip under C.UTF-8; the reference CLI must read a UTF-8 argv password the same way. */
const ORACLE_ENV: NodeJS.ProcessEnv = { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };

function oracle7z(): string {
  const tool = getOracleToolPath('7z');
  if (!tool) throw new Error('7z oracle missing');
  return tool;
}

/** Encrypts PLAIN_FILES with the reference `7z` CLI, password in its argv. */
function buildFixture(kind: FixtureKind, password: string, extraFlags: string[] = []): Buffer {
  return withTempDir((dir) => {
    const source = path.join(dir, 'src');
    writePlainTree(source);
    const archive = path.join(dir, `fixture.${FIXTURES[kind].extension}`);
    execFileSync(oracle7z(), ['a', '-y', ...FIXTURES[kind].flags, ...extraFlags, `-p${password}`, archive, '.'], {
      cwd: source,
      env: ORACLE_ENV,
      stdio: 'pipe',
    });
    return readFileSync(archive);
  });
}

function listFiles(root: string, prefix = ''): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) names.push(...listFiles(root, relative));
    else names.push(relative);
  }
  return names.sort();
}

/** Unpacks an archive with the reference `7z` CLI, password in its argv, and returns name -> bytes. */
function unpackWithOracle(archive: Buffer, extension: string, password: string | undefined): Map<string, Buffer> {
  return withTempDir((dir) => {
    const file = path.join(dir, `unpack.${extension}`);
    const out = path.join(dir, 'out');
    writeFileSync(file, archive);
    // Without a password the prompt gets an empty line, so a protected archive reports "Wrong password".
    execFileSync(oracle7z(), ['x', '-y', `-o${out}`, ...(password === undefined ? [] : [`-p${password}`]), file], {
      env: ORACLE_ENV,
      ...(password === undefined ? { input: '\n' } : {}),
      stdio: password === undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    });
    return new Map(listFiles(out).map((name) => [name, readFileSync(path.join(out, name))]));
  });
}

function expectPlainFiles(actual: Map<string, Buffer>, expected: readonly PlainFile[] = PLAIN_FILES): void {
  expect([...actual.keys()].sort()).toEqual(expected.map((file) => file.name).sort());
  for (const file of expected) {
    expect(actual.get(file.name)?.equals(file.data), `${file.name} differs from its plaintext`).toBe(true);
  }
}

function expectFilesMatch(files: { filename: string; buffer: Buffer }[], expected: readonly PlainFile[] = PLAIN_FILES): void {
  expectPlainFiles(new Map(files.map((file) => [file.filename, file.buffer])), expected);
}

/** An unencrypted ZIP of PLAIN_FILES written by the reference CLI. */
function buildPlainZip(): Buffer {
  return withTempDir((dir) => {
    const source = path.join(dir, 'src');
    writePlainTree(source);
    const out = path.join(dir, 'plain.zip');
    execFileSync(oracle7z(), ['a', '-y', '-tzip', out, '.'], { cwd: source, stdio: 'pipe' });
    return readFileSync(out);
  });
}

/** The reference CLI's complaint when it cannot open the archive with this password, else null. */
function oracleOpenFailure(archive: Buffer, extension: string, password: string | undefined): string | null {
  try {
    unpackWithOracle(archive, extension, password);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const ORACLE_PASSWORD_COMPLAINT = /Wrong password|encrypted/i;

/** Reads the `Encrypted` and `Method` fields the reference CLI reports for every entry. */
function oracleListing(archive: Buffer, extension: string, password: string): string {
  return withTempDir((dir) => {
    const file = path.join(dir, `listing.${extension}`);
    writeFileSync(file, archive);
    return execFileSync(oracle7z(), ['l', '-slt', `-p${password}`, file], {
      encoding: 'utf-8',
      env: ORACLE_ENV,
      stdio: 'pipe',
      maxBuffer: MAX_ENCRYPTION_LISTING_BYTES,
    });
  });
}

/** Formats a 7-Zip build lists with `7z i`: a RAR reader shows up as a "Rar" or "Rar5" row. */
const RAR_FORMAT_ROW = /^\s*(?:\d+\s+)?\S+\s+Rar5?\s/m;

/**
 * Throws OracleToolMissingError (an explicit skip, a failure under ORACLE_STRICT_MODE=1) when the
 * given 7-Zip build cannot read RAR archives, as some distribution builds cannot.
 */
function requireSevenZipRarCodec(binary: string): void {
  const formats = execFileSync(binary, ['i'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (!RAR_FORMAT_ROW.test(formats)) {
    throw new OracleToolMissingError('7z (RAR codec)', `${binary} lists no Rar format, so it cannot read RAR archives.`);
  }
}

describe('archive password delivery to the real 7z binary', () => {
  const originalP7zipPath = process.env.P7ZIP_PATH;
  afterEach(() => {
    if (originalP7zipPath === undefined) delete process.env.P7ZIP_PATH;
    else process.env.P7ZIP_PATH = originalP7zipPath;
  });

  describe('extraction', () => {
    for (const kind of ZIP_KINDS) {
      oracleTest(`extractZipArchive: ${kind} extracts with the right password`, ['7z'], async () => {
        const zip = buildFixture(kind, PASSWORD);
        expectFilesMatch(await extractZipArchive(zip, { password: PASSWORD }));
      });

      oracleTest(`extractZipArchive: ${kind} rejects a wrong password with InvalidArchivePasswordError`, ['7z'], async () => {
        const zip = buildFixture(kind, PASSWORD);
        await expect(extractZipArchive(zip, { password: WRONG_PASSWORD })).rejects.toThrow(InvalidArchivePasswordError);
      });

      oracleTest(`extractZipArchive: ${kind} without a password throws ArchivePasswordRequiredError`, ['7z'], async () => {
        const zip = buildFixture(kind, PASSWORD);
        await expect(extractZipArchive(zip, {})).rejects.toThrow(ArchivePasswordRequiredError);
      });
    }

    for (const kind of ALL_KINDS) {
      const extension = FIXTURES[kind].extension;

      oracleTest(`convertWithNative7z: ${kind} converts to zip with the right password`, ['7z'], async () => {
        const archive = buildFixture(kind, PASSWORD);
        const result = convertWithNative7z(archive, extension, 'zip', { password: PASSWORD }, `in.${extension}`);
        expect(result).not.toBeNull();
        // The one password option also encrypts the converted ZIP, so the oracle needs it to read the result.
        expectPlainFiles(unpackWithOracle(result!.buffer, 'zip', PASSWORD));
      });

      oracleTest(`convertWithNative7z: ${kind} rejects a wrong password with InvalidArchivePasswordError`, ['7z'], async () => {
        const archive = buildFixture(kind, PASSWORD);
        expect(() => convertWithNative7z(archive, extension, 'zip', { password: WRONG_PASSWORD }, `in.${extension}`)).toThrow(
          InvalidArchivePasswordError
        );
      });

      oracleTest(`convertWithNative7z: ${kind} without a password throws ArchivePasswordRequiredError`, ['7z'], async () => {
        const archive = buildFixture(kind, PASSWORD);
        expect(() => convertWithNative7z(archive, extension, 'zip', {}, `in.${extension}`)).toThrow(
          ArchivePasswordRequiredError
        );
      });

      oracleTest(`worker convertWithNative7z: ${kind} converts to zip with the right password`, ['7z'], async () => {
        const archive = buildFixture(kind, PASSWORD);
        const result = await convertWithWorker7z(archive, extension, 'zip', { password: PASSWORD, throwOnUnavailable: true }, `in.${extension}`);
        expect(result?.engineUsed).toBe('native-7z');
        expectPlainFiles(unpackWithOracle(result!.buffer, 'zip', PASSWORD));
      });

      oracleTest(`worker convertWithNative7z: ${kind} rejects a wrong password with InvalidArchivePasswordError`, ['7z'], async () => {
        const archive = buildFixture(kind, PASSWORD);
        await expect(
          convertWithWorker7z(archive, extension, 'zip', { password: WRONG_PASSWORD, throwOnUnavailable: true }, `in.${extension}`)
        ).rejects.toThrow(InvalidArchivePasswordError);
      });

      oracleTest(`worker convertWithNative7z: ${kind} without a password throws ArchivePasswordRequiredError`, ['7z'], async () => {
        const archive = buildFixture(kind, PASSWORD);
        await expect(
          convertWithWorker7z(archive, extension, 'zip', { throwOnUnavailable: true }, `in.${extension}`)
        ).rejects.toThrow(ArchivePasswordRequiredError);
      });
    }

    oracleTest('worker convertWithNative7z: a wrong password fails closed even when unavailability is not thrown', ['7z'], async () => {
      const archive = buildFixture('zip-aes256', PASSWORD);
      await expect(convertWithWorker7z(archive, 'zip', '7z', { password: WRONG_PASSWORD }, 'in.zip')).rejects.toThrow(InvalidArchivePasswordError);
    });

    oracleTest('convertArchive keeps the typed password error for a native 7z source', ['7z'], async () => {
      const archive = buildFixture('7z-encrypted-header', PASSWORD);
      await expect(
        convertArchive(archive, '7z', 'zip', { password: WRONG_PASSWORD, useNative7z: true }, 'in.7z')
      ).rejects.toThrow(InvalidArchivePasswordError);
      const converted = await convertArchive(archive, '7z', 'zip', { password: PASSWORD, useNative7z: true }, 'in.7z');
      expectPlainFiles(unpackWithOracle(converted.buffer, 'zip', PASSWORD));
    });

    oracleTest('convertArchive keeps the typed password error for an encrypted zip source', ['7z'], async () => {
      const archive = buildFixture('zip-zipcrypto', PASSWORD);
      await expect(convertArchive(archive, 'zip', '7z', { password: WRONG_PASSWORD }, 'in.zip')).rejects.toThrow(InvalidArchivePasswordError);
      await expect(convertArchive(archive, 'zip', 'tar', {}, 'in.zip')).rejects.toThrow(ArchivePasswordRequiredError);
    });

    oracleTest('a password given for an unencrypted archive is ignored and extraction still succeeds', ['7z'], async () => {
      const plain = buildPlainZip();
      expectPlainFiles(
        unpackWithOracle(convertWithNative7z(plain, 'zip', '7z', { password: PASSWORD }, 'plain.zip')!.buffer, '7z', PASSWORD)
      );
    });

    oracleTest('extractWithSpannedStream7z decrypts an encrypted multi-volume 7z', ['7z'], async () => {
      const volumeFlag = '-v1k';
      const parts = withTempDir((dir) => {
        const source = path.join(dir, 'src');
        writePlainTree(source);
        execFileSync(oracle7z(), ['a', '-y', '-t7z', '-mhe=on', volumeFlag, `-p${PASSWORD}`, path.join(dir, 'split.7z'), '.'], {
          cwd: source,
          stdio: 'pipe',
        });
        return readdirSync(dir)
          .filter((name) => name.startsWith('split.7z.'))
          .sort()
          .map((name) => ({ filename: name, buffer: readFileSync(path.join(dir, name)) }));
      });
      expect(parts.length).toBeGreaterThan(1);

      const extractTo = mkdtempSync(path.join(os.tmpdir(), 'archive-password-span-'));
      try {
        await expect(
          extractWithSpannedStream7z(parts, path.join(extractTo, 'wrong'), { password: WRONG_PASSWORD })
        ).rejects.toThrow(InvalidArchivePasswordError);
        await expect(extractWithSpannedStream7z(parts, path.join(extractTo, 'none'), {})).rejects.toThrow(ArchivePasswordRequiredError);
        const good = path.join(extractTo, 'good');
        await extractWithSpannedStream7z(parts, good, { password: PASSWORD });
        expectPlainFiles(new Map(listFiles(good).map((name) => [name, readFileSync(path.join(good, name))])));
      } finally {
        rmSync(extractTo, { recursive: true, force: true });
      }
    });

    oracleTest('inspectArchive lists an encrypted-header 7z with the right password only', ['7z'], async () => {
      const archive = buildFixture('7z-encrypted-header', PASSWORD);
      const listed = await inspectArchive(archive, { filename: 'in.7z', password: PASSWORD });
      const listedFiles = listed.entries.filter((entry) => !entry.isDirectory);
      expect(listedFiles.map((entry) => entry.name).sort()).toEqual(PLAIN_FILES.map((file) => file.name).sort());
      expect(listedFiles.find((entry) => entry.name === 'nested/data.bin')?.uncompressedSize).toBe(PLAIN_FILES[1].data.length);
      await expect(inspectArchive(archive, { filename: 'in.7z' })).rejects.toThrow(ArchiveEncryptedHeaderError);
      await expect(inspectArchive(archive, { filename: 'in.7z', password: WRONG_PASSWORD })).rejects.toThrow(ArchiveEncryptedHeaderError);
    });
  });

  describe('RAR codec requirement', () => {
    it('reports a 7-Zip build without a RAR reader as a missing tool instead of a null result', () => {
      withTempDir((dir) => {
        const noRar = path.join(dir, '7z-no-rar.sh');
        // Format table of a build that reads 7z and zip only, in the layout of `7z i`.
        writeFileSync(
          noRar,
          "#!/bin/sh\ncat <<'EOF'\nFormats:\n0  ...F..................  7z       7z\n0  ...F..................  zip      zip jar\nEOF\n"
        );
        chmodSync(noRar, 0o755);
        let failure: unknown;
        try {
          requireSevenZipRarCodec(noRar);
        } catch (err) {
          failure = err;
        }
        expect(failure).toBeInstanceOf(OracleToolMissingError);
        expect((failure as OracleToolMissingError).tool).toBe('7z (RAR codec)');
      });
    });
  });

  describe('RAR extraction', () => {
    const RAR_FILES: readonly PlainFile[] = [
      { name: 'secret.txt', data: Buffer.from('rar payload bytes: 0123456789abcdef!!\n', 'utf-8') },
      { name: 'second.csv', data: Buffer.from('id,value\n1,alpha\n2,beta\n', 'utf-8') },
    ];
    const encryptedRar = (): Buffer => buildStoredRar4(RAR_FILES, { password: PASSWORD });

    oracleTest('the encrypted RAR fixture is accepted by unrar with the password and refused without it', ['unrar'], async () => {
      const unrar = getOracleToolPath('unrar')!;
      withTempDir((dir) => {
        const file = path.join(dir, 'fixture.rar');
        writeFileSync(file, encryptedRar());
        expect(execFileSync(unrar, ['t', `-p${PASSWORD}`, file], { encoding: 'utf-8' })).toContain('All OK');
        for (const entry of RAR_FILES) {
          expect(execFileSync(unrar, ['p', '-inul', `-p${PASSWORD}`, file, entry.name]).equals(entry.data)).toBe(true);
        }
        expect(() => execFileSync(unrar, ['t', '-p-', file], { stdio: 'pipe' })).toThrow();
      });
    });

    oracleTest('extractRarArchive decrypts with the right password', ['unrar'], async () => {
      expectFilesMatch(extractRarArchive(encryptedRar(), { password: PASSWORD }), RAR_FILES);
    });

    oracleTest('extractRarArchive rejects a wrong password with InvalidArchivePasswordError', ['unrar'], async () => {
      expect(() => extractRarArchive(encryptedRar(), { password: WRONG_PASSWORD })).toThrow(InvalidArchivePasswordError);
    });

    oracleTest('extractRarArchive without a password throws ArchivePasswordRequiredError', ['unrar'], async () => {
      expect(() => extractRarArchive(encryptedRar(), {})).toThrow(ArchivePasswordRequiredError);
    });

    oracleTest('7z reads the encrypted RAR with the right password and types both failures', ['7z', 'unrar'], async () => {
      requireSevenZipRarCodec(get7zBinaryPath()!);
      const rar = encryptedRar();
      const converted = convertWithNative7z(rar, 'rar', 'zip', { password: PASSWORD }, 'in.rar');
      if (!converted) throw new Error('convertWithNative7z returned no archive for an encrypted RAR with the right password');
      expectPlainFiles(unpackWithOracle(converted.buffer, 'zip', PASSWORD), RAR_FILES);
      expect(() => convertWithNative7z(rar, 'rar', 'zip', { password: WRONG_PASSWORD }, 'in.rar')).toThrow(
        InvalidArchivePasswordError
      );
      expect(() => convertWithNative7z(rar, 'rar', 'zip', {}, 'in.rar')).toThrow(ArchivePasswordRequiredError);
    });
  });

  describe('RAR5 extraction', () => {
    const RAR5_FILES: readonly PlainFile[] = [
      { name: 'secret.txt', data: Buffer.from('rar5 payload bytes: 0123456789abcdef\n', 'utf-8') },
      { name: 'second.csv', data: Buffer.from('id,value\n1,alpha\n2,beta\n', 'utf-8') },
    ];
    /** unrar exits with 11 (RARX_BADPWD) when the password does not decrypt the archive. */
    const UNRAR_BAD_PASSWORD_STATUS = 11;
    /** Unix st_mode values (host OS Unix) with no owner read permission: no access, write-only. */
    const NON_READABLE_UNIX_MODES = [0o100000, 0o100200] as const;
    const VARIANTS = [
      { label: 'encrypted data', headerEncrypted: false },
      { label: 'encrypted headers', headerEncrypted: true },
    ] as const;

    for (const variant of VARIANTS) {
      const encryptedRar5 = (): Buffer => buildEncryptedRar5(RAR5_FILES, { password: PASSWORD, headerEncrypted: variant.headerEncrypted });

      oracleTest(`the RAR5 fixture with ${variant.label} is accepted by unrar with the password only`, ['unrar'], async () => {
        const unrar = getOracleToolPath('unrar')!;
        withTempDir((dir) => {
          const file = path.join(dir, 'fixture.rar');
          writeFileSync(file, encryptedRar5());
          expect(execFileSync(unrar, ['t', `-p${PASSWORD}`, file], { encoding: 'utf-8' })).toContain('All OK');
          for (const entry of RAR5_FILES) {
            expect(execFileSync(unrar, ['p', '-inul', `-p${PASSWORD}`, file, entry.name]).equals(entry.data), entry.name).toBe(true);
          }
          const wrong = spawnSync(unrar, ['t', `-p${WRONG_PASSWORD}`, file], { encoding: 'utf-8' });
          expect(wrong.status).toBe(UNRAR_BAD_PASSWORD_STATUS);
          expect(wrong.stdout + wrong.stderr).toMatch(/Incorrect password|password is incorrect/);
          expect(spawnSync(unrar, ['t', '-p-', file], { encoding: 'utf-8' }).status).toBe(UNRAR_BAD_PASSWORD_STATUS);
        });
      });

      oracleTest(`extractRarArchive decrypts RAR5 ${variant.label} with the right password`, ['unrar'], async () => {
        expectFilesMatch(extractRarArchive(encryptedRar5(), { password: PASSWORD }), RAR5_FILES);
      });

      oracleTest(`extractRarArchive reads RAR5 ${variant.label} entries whose stored Unix mode forbids reading`, ['unrar'], async () => {
        // root reads any file, so only a non-root user (the worker, the CI runner) can show the failure.
        if (process.getuid?.() === 0) throw new OracleToolMissingError('non-root user', 'root ignores file modes, so unreadable extracted entries go unnoticed');
        for (const fileAttributes of NON_READABLE_UNIX_MODES) {
          const archive = buildEncryptedRar5(RAR5_FILES, { password: PASSWORD, headerEncrypted: variant.headerEncrypted, fileAttributes });
          expectFilesMatch(extractRarArchive(archive, { password: PASSWORD }), RAR5_FILES);
        }
      });

      oracleTest(`extractRarArchive rejects a wrong password for RAR5 ${variant.label} with InvalidArchivePasswordError`, ['unrar'], async () => {
        expect(() => extractRarArchive(encryptedRar5(), { password: WRONG_PASSWORD })).toThrow(InvalidArchivePasswordError);
      });

      oracleTest(`extractRarArchive without a password throws ArchivePasswordRequiredError for RAR5 ${variant.label}`, ['unrar'], async () => {
        expect(() => extractRarArchive(encryptedRar5(), {})).toThrow(ArchivePasswordRequiredError);
      });

      oracleTest(`convertArchive keeps the typed password errors for RAR5 ${variant.label}`, ['unrar'], async () => {
        const rar = encryptedRar5();
        await expect(convertArchive(rar, 'rar', 'zip', { password: WRONG_PASSWORD }, 'in.rar')).rejects.toThrow(InvalidArchivePasswordError);
        await expect(convertArchive(rar, 'rar', 'zip', {}, 'in.rar')).rejects.toThrow(ArchivePasswordRequiredError);
        const converted = await convertArchive(rar, 'rar', 'zip', { password: PASSWORD }, 'in.rar');
        expectPlainFiles(unpackWithOracle(converted.buffer, 'zip', PASSWORD), RAR5_FILES);
      });

      oracleTest(`convertWithNative7z types both password failures for RAR5 ${variant.label}`, ['7z', 'unrar'], async () => {
        requireSevenZipRarCodec(get7zBinaryPath()!);
        const rar = encryptedRar5();
        expect(() => convertWithNative7z(rar, 'rar', 'zip', { password: WRONG_PASSWORD }, 'in.rar')).toThrow(InvalidArchivePasswordError);
        expect(() => convertWithNative7z(rar, 'rar', 'zip', {}, 'in.rar')).toThrow(ArchivePasswordRequiredError);
      });
    }
  });

  describe('creation', () => {
    const TRICKY_PASSWORDS: Record<string, string> = {
      plain: PASSWORD,
      'inner and trailing spaces': '  spaced  out  ',
      'quotes, backslash, dollar and backtick': 'a"b\'c\\d$HOME`e',
      'leading dash': '-p-secret',
      'long (1000 bytes)': 'L'.repeat(1000),
    };

    for (const [label, password] of Object.entries(TRICKY_PASSWORDS)) {
      oracleTest(`create7zArchive encrypts file data and names under the reference CLI (${label})`, ['7z'], async () => {
        const result = create7zArchive(
          PLAIN_FILES.map((file) => ({ filename: file.name, buffer: file.data })),
          { password },
          'out.7z'
        );
        expectPlainFiles(unpackWithOracle(result.buffer, '7z', password));
        expect(oracleOpenFailure(result.buffer, '7z', undefined), 'archive opens without its password').toMatch(ORACLE_PASSWORD_COMPLAINT);
        expect(oracleOpenFailure(result.buffer, '7z', WRONG_PASSWORD), 'archive opens with a wrong password').toMatch(ORACLE_PASSWORD_COMPLAINT);
        expect(oracleListing(result.buffer, '7z', password)).toMatch(/Method = .*7zAES/);
      });
    }

    // ZIP AES-256 limits the password to 99 bytes.
    for (const [label, password] of Object.entries(TRICKY_PASSWORDS).filter(([, value]) => value.length <= 99)) {
      oracleTest(`createZipArchive encrypts every entry with AES-256 (${label})`, ['7z'], async () => {
        const result = await createZipArchive(
          PLAIN_FILES.map((file) => ({ filename: file.name, buffer: file.data })),
          { password },
          'out.zip'
        );
        expectPlainFiles(unpackWithOracle(result.buffer, 'zip', password));
        expect(oracleOpenFailure(result.buffer, 'zip', undefined), 'archive opens without its password').toMatch(ORACLE_PASSWORD_COMPLAINT);
        expect(oracleOpenFailure(result.buffer, 'zip', WRONG_PASSWORD), 'archive opens with a wrong password').toMatch(ORACLE_PASSWORD_COMPLAINT);
        const listing = oracleListing(result.buffer, 'zip', password);
        expect(listing.match(/Encrypted = \+/g)?.length).toBe(PLAIN_FILES.length);
        expect(listing).toMatch(/Method = AES-256/);
      });
    }

    oracleTest('a UTF-8 password round-trips between the engine and the reference CLI', ['7z'], async () => {
      const password = 'pässwörd-日本語';
      const created = create7zArchive(
        PLAIN_FILES.map((file) => ({ filename: file.name, buffer: file.data })),
        { password },
        'utf8.7z'
      );
      expectPlainFiles(unpackWithOracle(created.buffer, '7z', password));
      const extracted = convertWithNative7z(buildFixture('7z-encrypted-data', password), '7z', '7z', { password }, 'utf8.7z');
      expectPlainFiles(unpackWithOracle(extracted!.buffer, '7z', password));
    });

    oracleTest('a ZIP target refuses passwords 7-Zip cannot apply instead of failing inside the child', ['7z'], async () => {
      const files = PLAIN_FILES.map((file) => ({ filename: file.name, buffer: file.data }));
      const unsupported = ['pässwörd-日本語', 'x'.repeat(MAX_ZIP_PASSWORD_BYTES + 1)];
      for (const password of unsupported) {
        await expect(createZipArchive(files, { password }, 'out.zip')).rejects.toThrow(UnsupportedOptionError);
        expect(() => convertWithNative7z(buildPlainZip(), 'zip', 'zip', { password }, 'in.zip')).toThrow(UnsupportedOptionError);
        await expect(
          convertWithWorker7z(buildPlainZip(), 'zip', 'zip', { password, throwOnUnavailable: true }, 'in.zip')
        ).rejects.toThrow(UnsupportedOptionError);
      }
      // The longest accepted password still produces an archive the reference CLI opens.
      const longest = 'z'.repeat(MAX_ZIP_PASSWORD_BYTES);
      const accepted = await createZipArchive(files, { password: longest }, 'out.zip');
      expectPlainFiles(unpackWithOracle(accepted.buffer, 'zip', longest));
    });

    for (const target of ['zip', '7z'] as const) {
      oracleTest(`worker convertWithNative7z encrypts a ${target} target`, ['7z'], async () => {
        const source = buildPlainZip();
        const result = await convertWithWorker7z(source, 'zip', target, { password: 'Target-Password-9', throwOnUnavailable: true }, 'in.zip');
        expectPlainFiles(unpackWithOracle(result!.buffer, target, 'Target-Password-9'));
        expect(oracleOpenFailure(result!.buffer, target, undefined), 'target opens without its password').toMatch(ORACLE_PASSWORD_COMPLAINT);
      });

      oracleTest(`lib convertWithNative7z encrypts a ${target} target`, ['7z'], async () => {
        const source = buildPlainZip();
        const result = convertWithNative7z(source, 'zip', target, { password: 'Target-Password-9' }, 'in.zip');
        expectPlainFiles(unpackWithOracle(result!.buffer, target, 'Target-Password-9'));
        expect(oracleOpenFailure(result!.buffer, target, undefined), 'target opens without its password').toMatch(ORACLE_PASSWORD_COMPLAINT);
      });
    }
  });

  describe('encryption verification', () => {
    /** A 7-Zip that ignores the password prompt: the wrapper drops the bare -p switch before running the real binary. */
    function installPromptIgnoringWrapper(dir: string): void {
      const real = get7zBinaryPath();
      if (!real) throw new Error('7z binary missing');
      const wrapper = path.join(dir, '7z-ignores-prompt.sh');
      writeFileSync(
        wrapper,
        `#!/bin/sh\nfor arg in "$@"; do\n  shift\n  [ "$arg" = "-p" ] || set -- "$@" "$arg"\ndone\nexec '${real}' "$@"\n`
      );
      chmodSync(wrapper, 0o755);
      process.env.P7ZIP_PATH = wrapper;
    }

    /** Like the prompt-ignoring wrapper, but every listing dies with an error that has nothing to do with passwords. */
    function installPromptIgnoringFailingListingWrapper(dir: string): void {
      const real = get7zBinaryPath();
      if (!real) throw new Error('7z binary missing');
      const wrapper = path.join(dir, '7z-fails-listing.sh');
      writeFileSync(
        wrapper,
        `#!/bin/sh\ncase "$1" in\n  l) echo "ERROR: disk exploded" >&2; exit 2 ;;\nesac\nfor arg in "$@"; do\n  shift\n  [ "$arg" = "-p" ] || set -- "$@" "$arg"\ndone\nexec '${real}' "$@"\n`
      );
      chmodSync(wrapper, 0o755);
      process.env.P7ZIP_PATH = wrapper;
    }

    const FILES = PLAIN_FILES.map((file) => ({ filename: file.name, buffer: file.data }));

    oracleTest('an archive named after the password message is not taken for an encrypted one when its listing fails', ['7z'], async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'archive-password-named-'));
      try {
        installPromptIgnoringFailingListingWrapper(dir);
        // The wrapper writes a plaintext archive and its listing then fails for an unrelated reason. The
        // failed command line contains the archive path, which the caller controls.
        for (const archiveName of ['wrong password.7z', 'Cannot open encrypted archive.7z']) {
          let failure: unknown;
          try {
            create7zArchive(FILES, { password: PASSWORD }, archiveName);
          } catch (err) {
            failure = err;
          }
          expect(failure, `${archiveName} was returned`).toBeInstanceOf(ConversionFailedError);
          expect((failure as Error).message, archiveName).toBe('Could not verify that the archive is encrypted.');
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    oracleTest('a CRC error in an entry named "Wrong password" is not reported as a password error', ['7z'], async () => {
      const content = Buffer.from('stored bytes that will be damaged on disk\n', 'utf-8');
      for (const entryName of ['Wrong password.txt', 'plain-name.txt']) {
        const damaged = withTempDir((dir) => {
          writeFileSync(path.join(dir, entryName), content);
          const archive = path.join(dir, 'crc.zip');
          execFileSync(oracle7z(), ['a', '-y', '-tzip', '-mx0', archive, entryName], { cwd: dir, stdio: 'pipe' });
          const bytes = readFileSync(archive);
          const at = bytes.indexOf(content);
          expect(at, 'stored data located in the zip').toBeGreaterThan(0);
          bytes[at] ^= 0xff;
          return bytes;
        });
        // The reference CLI itself calls this a CRC failure on an unencrypted entry, not a password problem.
        const oracleFailure = oracleOpenFailure(damaged, 'zip', undefined) ?? '';
        expect(oracleFailure, `${entryName} oracle verdict`).toMatch(/CRC Failed/);
        for (const options of [{}, { password: PASSWORD }]) {
          const label = `${entryName} ${JSON.stringify(options)}`;
          // The lib engine turns an untyped 7z failure into null so the caller falls back to the TS engine.
          let libFailure: unknown;
          let libResult: unknown;
          try {
            libResult = convertWithNative7z(damaged, 'zip', '7z', options, 'crc.zip');
          } catch (err) {
            libFailure = err;
          }
          expect(libFailure, `lib ${label}`).not.toBeInstanceOf(ArchivePasswordRequiredError);
          expect(libFailure, `lib ${label}`).not.toBeInstanceOf(InvalidArchivePasswordError);
          expect(libResult ?? null, `lib ${label} returned an archive`).toBeNull();

          let workerFailure: unknown;
          try {
            await convertWithWorker7z(damaged, 'zip', '7z', { ...options, throwOnUnavailable: true }, 'crc.zip');
          } catch (err) {
            workerFailure = err;
          }
          expect(workerFailure, `worker ${label} did not fail`).toBeInstanceOf(Error);
          expect(workerFailure, `worker ${label}`).not.toBeInstanceOf(ArchivePasswordRequiredError);
          expect(workerFailure, `worker ${label}`).not.toBeInstanceOf(InvalidArchivePasswordError);
        }
      }
    });

    oracleTest('piping a password into a 7-Zip that never reads it does not fail the run (EPIPE)', ['7z'], async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'archive-password-epipe-'));
      try {
        installPromptIgnoringWrapper(dir);
        writeFileSync(path.join(dir, 'a.txt'), 'x');
        const attempts = 100;
        for (let i = 0; i < attempts; i += 1) {
          const archive = path.join(dir, `ignored-${i}.zip`);
          execFileSyncWithPasswordStdin(process.env.P7ZIP_PATH!, ['a', '-y', '-tzip', '-mem=AES256', '-p', archive, 'a.txt'], {
            cwd: dir,
            input: sevenZipCreatePasswordInput(PASSWORD),
          });
          expect(readFileSync(archive).subarray(0, 2).toString('latin1'), `archive ${i} starts with the ZIP signature`).toBe('PK');
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    oracleTest('a 7-Zip that ignores the prompt never yields a plaintext archive from any creation path', ['7z'], async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'archive-password-ignored-'));
      try {
        installPromptIgnoringWrapper(dir);
        // Control: the wrapper really does produce a plaintext archive, which the reference CLI lists as unencrypted.
        const plainZip = path.join(dir, 'control.zip');
        // The wrapper never reads stdin, so Node may report the unread write as EPIPE; the helper tolerates that.
        execFileSyncWithPasswordStdin(process.env.P7ZIP_PATH!, ['a', '-y', '-tzip', '-mem=AES256', '-p', plainZip, '.'], {
          cwd: dir,
          input: sevenZipCreatePasswordInput(PASSWORD),
        });
        const controlListing = execFileSync(oracle7z(), ['l', '-slt', plainZip], { env: ORACLE_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf-8');
        expect(controlListing).toMatch(/Encrypted = -/);
        expect(controlListing).not.toMatch(/Encrypted = \+/);

        const zipFromPlain = buildPlainZip();
        const attempts: Array<[string, () => unknown]> = [
          ['createZipArchive', () => createZipArchive(FILES, { password: PASSWORD }, 'out.zip')],
          ['create7zArchive', () => create7zArchive(FILES, { password: PASSWORD }, 'out.7z')],
          ['lib convertWithNative7z to zip', () => convertWithNative7z(zipFromPlain, 'zip', 'zip', { password: PASSWORD }, 'in.zip')],
          ['lib convertWithNative7z to 7z', () => convertWithNative7z(zipFromPlain, 'zip', '7z', { password: PASSWORD }, 'in.zip')],
          ['worker convertWithNative7z to zip', () => convertWithWorker7z(zipFromPlain, 'zip', 'zip', { password: PASSWORD }, 'in.zip')],
          ['worker convertWithNative7z to 7z', () => convertWithWorker7z(zipFromPlain, 'zip', '7z', { password: PASSWORD, throwOnUnavailable: true }, 'in.zip')],
        ];
        for (const [label, attempt] of attempts) {
          let failure: unknown;
          try {
            await attempt();
          } catch (err) {
            failure = err;
          }
          expect(failure, `${label} returned an archive`).toBeInstanceOf(ArchiveNotEncryptedError);
          expect((failure as Error).message, label).toBe('Archive was written without encryption.');
          expect(failure, label).toBeInstanceOf(ConversionFailedError);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    oracleTest('the real 7z passes verification: every created archive is encrypted per the reference CLI', ['7z'], async () => {
      const zip = await createZipArchive(FILES, { password: PASSWORD }, 'out.zip');
      const sevenZ = create7zArchive(FILES, { password: PASSWORD }, 'out.7z');
      expect(oracleListing(zip.buffer, 'zip', PASSWORD)).toMatch(/Encrypted = \+/);
      expect(oracleOpenFailure(sevenZ.buffer, '7z', undefined)).toMatch(ORACLE_PASSWORD_COMPLAINT);
    });

    describe('listing rules (listings captured from the reference CLI, 7-Zip 23.01 and p7zip 16.02)', () => {
      const ZIP_AES_LISTING = [
        'Path = a.txt', 'Folder = -', 'Size = 3', 'Encrypted = +', 'Method = AES-256 Store', '',
        'Path = empty.txt', 'Folder = -', 'Size = 0', 'Encrypted = +', 'Method = AES-256 Store', '',
        'Path = sub', 'Folder = +', 'Size = 0', 'Encrypted = -', 'Method = Store', '',
        'Path = sub/b.txt', 'Folder = -', 'Size = 3', 'Encrypted = +', 'Method = AES-256 Deflate', '',
      ].join('\n');
      const withListing = (entries: string): string => `Path = out.zip\nType = zip\n\n----------\n${entries}`;
      const UNVERIFIED = 'Could not verify that the archive is encrypted.';

      it('accepts a ZIP whose every file entry is encrypted, folders and empty files included', () => {
        expect(assertListingShowsEncryption('zip', { listing: withListing(ZIP_AES_LISTING) })).toEqual({
          protection: 'entries',
          encryptedEntries: 3,
        });
      });

      it('accepts the listing of an empty ZIP, which has nothing to encrypt', () => {
        // Captured from `7z l -slt` on a 22-byte archive without entries.
        const emptyListing = '--\nPath = /tmp/e.zip\nType = zip\nPhysical Size = 22\n\n----------\n';
        expect(assertListingShowsEncryption('zip', { listing: emptyListing })).toEqual({ protection: 'entries', encryptedEntries: 0 });
      });

      it('refuses to call a listing it cannot parse encrypted', () => {
        const unparseable = [
          '',
          'Everything is Ok\n',
          // No entries separator at all.
          'Path = out.zip\nType = zip\nPhysical Size = 22\n',
          // A separator followed by text that holds no entry.
          'Path = out.zip\nType = zip\n\n----------\nunexpected output format\n',
          // Entries that lost their Path field.
          withListing('Folder = -\nSize = 3\nEncrypted = -\n\n'),
        ];
        for (const listing of unparseable) {
          expect(() => assertListingShowsEncryption('zip', { listing }), JSON.stringify(listing)).toThrow(UNVERIFIED);
        }
      });

      it('requires AES-256 on every ZIP file entry, not just an Encrypted flag', () => {
        for (const method of ['ZipCrypto Store', 'AES-128 Store', 'AES-192 Deflate', 'Store']) {
          const weak = ZIP_AES_LISTING.replace('Method = AES-256 Deflate', `Method = ${method}`);
          expect(weak).not.toBe(ZIP_AES_LISTING);
          expect(() => assertListingShowsEncryption('zip', { listing: withListing(weak) }), method).toThrow(ArchiveNotEncryptedError);
        }
        const noMethod = ZIP_AES_LISTING.replace('Method = AES-256 Deflate\n', '');
        expect(() => assertListingShowsEncryption('zip', { listing: withListing(noMethod) })).toThrow(ArchiveNotEncryptedError);
      });

      oracleTest('judges the real listings of the reference CLI: AES-256 passes, ZipCrypto does not', ['7z'], async () => {
        const aes = oracleListing(buildFixture('zip-aes256', PASSWORD), 'zip', PASSWORD);
        expect(aes).toMatch(/Method = AES-256/);
        expect(assertListingShowsEncryption('zip', { listing: aes })).toEqual({ protection: 'entries', encryptedEntries: PLAIN_FILES.length });
        const zipCrypto = oracleListing(buildFixture('zip-zipcrypto', PASSWORD), 'zip', PASSWORD);
        expect(zipCrypto).toMatch(/Encrypted = \+/);
        expect(() => assertListingShowsEncryption('zip', { listing: zipCrypto })).toThrow(ArchiveNotEncryptedError);
      });

      it('rejects a ZIP with one plaintext file entry', () => {
        const mixed = ZIP_AES_LISTING.replace(
          'Size = 3\nEncrypted = +\nMethod = AES-256 Store\n\nPath = empty.txt',
          'Size = 3\nEncrypted = -\nMethod = Store\n\nPath = empty.txt'
        );
        expect(mixed).not.toBe(ZIP_AES_LISTING);
        expect(() => assertListingShowsEncryption('zip', { listing: withListing(mixed) })).toThrow(ArchiveNotEncryptedError);
      });

      it('rejects a 7z whose header lists without a password, even when its data is encrypted', () => {
        const dataOnly = ['Path = sub', 'Size = 0', 'Encrypted = -', '', 'Path = a.txt', 'Size = 3', 'Encrypted = +', ''].join('\n');
        expect(() => assertListingShowsEncryption('7z', { listing: withListing(dataOnly) })).toThrow(ArchiveNotEncryptedError);
      });

      it('accepts a 7z whose header needs the password, in both wordings of the tool', () => {
        for (const failureOutput of [
          'ERROR: h.7z : Cannot open encrypted archive. Wrong password?',
          'ERROR: h.7z : Can not open encrypted archive. Wrong password?',
        ]) {
          expect(assertListingShowsEncryption('7z', { failureOutput })).toEqual({ protection: 'header', encryptedEntries: 0 });
        }
      });

      it('reads only the tool\'s own password complaints on stderr, never an entry name that repeats them', () => {
        for (const failureOutput of [
          'ERROR: CRC Failed : Wrong password.txt',
          'ERROR: Unsupported Method : Cannot open encrypted archive. Wrong password?.txt',
          'ERROR: disk exploded',
          'WARNING: Wrong password in the middle',
        ]) {
          expect(() => assertListingShowsEncryption('7z', { failureOutput }), failureOutput).toThrow(
            'Could not verify that the archive is encrypted.'
          );
        }
      });

      it('accepts the two-line wording of the header failure printed by extraction and test runs', () => {
        const failureOutput = 'ERROR: /work/h.7z\nCannot open encrypted archive. Wrong password?\n';
        expect(assertListingShowsEncryption('7z', { failureOutput })).toEqual({ protection: 'header', encryptedEntries: 0 });
      });

      it('fails closed when the listing breaks for a reason other than the password', () => {
        expect(() => assertListingShowsEncryption('7z', { failureOutput: 'ERROR: Unexpected end of archive' })).toThrow(ConversionFailedError);
        expect(() => assertListingShowsEncryption('zip', { failureOutput: 'Break signaled' })).toThrow(ConversionFailedError);
      });
    });
  });

  describe('entry limits of encrypted archives', () => {
    const EMPTY = Buffer.alloc(0);
    const NAME_BYTES = 255;
    /** Unique entry name of exactly NAME_BYTES bytes. */
    const longName = (index: number): string => `${String(index).padStart(6, '0')}${'n'.repeat(NAME_BYTES - 6)}`;
    const LONG_RUN_TIMEOUT_MS = 300_000;

    /** Records every 7z invocation, one first argument per line, then runs the real binary. */
    function installCallLog(dir: string): string {
      const real = get7zBinaryPath();
      if (!real) throw new Error('7z binary missing');
      const log = path.join(dir, 'calls.log');
      writeFileSync(log, '');
      const wrapper = path.join(dir, '7z-call-log.sh');
      writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${log}'\nexec '${real}' "$@"\n`);
      chmodSync(wrapper, 0o755);
      process.env.P7ZIP_PATH = wrapper;
      return log;
    }

    const calledCommands = (log: string): string[] => readFileSync(log, 'utf-8').split('\n').filter(Boolean);

    it('derives the listing cap from the entry limit so a full archive of long names verifies', () => {
      expect(MAX_ENCRYPTED_ARCHIVE_ENTRIES).toBe(50_000);
      expect(MAX_ENCRYPTION_LISTING_BYTES).toBe(MAX_ENCRYPTED_ARCHIVE_ENTRIES * ENCRYPTION_LISTING_BYTES_PER_ENTRY);
      // `7z l -slt` prints about 330 bytes of fields per entry plus its path; 255-byte names fit in 1 KiB.
      expect(ENCRYPTION_LISTING_BYTES_PER_ENTRY).toBeGreaterThanOrEqual(2 * NAME_BYTES + 330);
    });

    it('counts entries and their listing size before any archive is written', () => {
      const names = (count: number, name = 'f.txt'): string[] => Array.from({ length: count }, () => name);
      expect(() => assertEncryptedArchiveInputWithinLimits(names(MAX_ENCRYPTED_ARCHIVE_ENTRIES + 1))).toThrow(
        `Encrypted archives support at most ${MAX_ENCRYPTED_ARCHIVE_ENTRIES} entries.`
      );
      expect(() => assertEncryptedArchiveInputWithinLimits(names(MAX_ENCRYPTED_ARCHIVE_ENTRIES))).not.toThrow(ConversionFailedError);
      // Deep paths make each listing block bigger than the per-entry allowance.
      const deep = 'd/'.repeat(1900);
      expect(() => assertEncryptedArchiveInputWithinLimits(names(MAX_ENCRYPTED_ARCHIVE_ENTRIES, deep))).toThrow(
        /listing would exceed/
      );
    });

    oracleTest('creation refuses more entries than the limit before 7-Zip runs', ['7z'], async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'archive-password-limit-'));
      try {
        const log = installCallLog(dir);
        const files = Array.from({ length: MAX_ENCRYPTED_ARCHIVE_ENTRIES + 1 }, (_, i) => ({ filename: `f${i}.txt`, buffer: EMPTY }));
        await expect(createZipArchive(files, { password: PASSWORD }, 'out.zip')).rejects.toThrow(ConversionFailedError);
        expect(() => create7zArchive(files, { password: PASSWORD }, 'out.7z')).toThrow(ConversionFailedError);
        expect(calledCommands(log), '7-Zip was started').toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, LONG_RUN_TIMEOUT_MS);

    oracleTest('a conversion with more source entries than the limit is refused before the archive is written', ['7z'], async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'archive-password-limit-'));
      try {
        const source = path.join(dir, 'src');
        mkdirSync(source);
        for (let i = 0; i <= MAX_ENCRYPTED_ARCHIVE_ENTRIES; i += 1) writeFileSync(path.join(source, `f${i}.txt`), '');
        execFileSync(oracle7z(), ['a', '-y', '-tzip', path.join(dir, 'many.zip'), '.'], { cwd: source, stdio: 'pipe' });
        const many = readFileSync(path.join(dir, 'many.zip'));
        const log = installCallLog(dir);
        for (const target of ['zip', '7z'] as const) {
          expect(() => convertWithNative7z(many, 'zip', target, { password: PASSWORD }, 'many.zip'), `lib ${target}`).toThrow(
            `Encrypted archives support at most ${MAX_ENCRYPTED_ARCHIVE_ENTRIES} entries.`
          );
          await expect(
            convertWithWorker7z(many, 'zip', target, { password: PASSWORD, throwOnUnavailable: true }, 'many.zip'),
            `worker ${target}`
          ).rejects.toThrow(`Encrypted archives support at most ${MAX_ENCRYPTED_ARCHIVE_ENTRIES} entries.`);
        }
        // Only the four extractions ran; no creation (`a`) or verification listing (`l`) started.
        expect(calledCommands(log)).toEqual(['x', 'x', 'x', 'x']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, LONG_RUN_TIMEOUT_MS);

    oracleTest('the largest allowed archive of 255-byte names is created and verified', ['7z'], async () => {
      const files = Array.from({ length: MAX_ENCRYPTED_ARCHIVE_ENTRIES }, (_, i) => ({ filename: longName(i), buffer: EMPTY }));
      const created = await createZipArchive(files, { password: PASSWORD }, 'full.zip');
      const listing = oracleListing(created.buffer, 'zip', PASSWORD);
      expect(listing.match(/^Path = /gm)?.length, 'entries listed by the reference CLI').toBe(MAX_ENCRYPTED_ARCHIVE_ENTRIES + 1);
      expect(listing.match(/^Encrypted = \+/gm)?.length).toBe(MAX_ENCRYPTED_ARCHIVE_ENTRIES);
    }, LONG_RUN_TIMEOUT_MS);
  });

  describe('stdin hand-off', () => {
    oracleTest('an unread password never fails a run that succeeded (EPIPE on an unencrypted archive)', ['7z'], async () => {
      const plain = buildPlainZip();
      const sevenZip = get7zBinaryPath()!;
      const attempts = 200;
      withTempDir((dir) => {
        const archive = path.join(dir, 'plain.zip');
        writeFileSync(archive, plain);
        let succeeded = 0;
        for (let i = 0; i < attempts; i += 1) {
          // Node reports EPIPE in roughly 6% of these runs when 7z exits without reading stdin.
          const out = execFileSyncWithPasswordStdin(sevenZip, ['t', '-y', archive], {
            input: sevenZipReadPasswordInput(PASSWORD),
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          if (out.toString('utf-8').includes('Everything is Ok')) succeeded += 1;
        }
        expect(succeeded).toBe(attempts);
      });
    });
  });

  describe('argv', () => {
    /**
     * Wraps the real 7z in a shell script that appends every argument it receives to a log, one call
     * per record, and then execs the real binary with stdin untouched. The engines must still
     * decrypt through it, and the log must never show the password.
     */
    function installRecordingWrapper(dir: string): string {
      const real = get7zBinaryPath();
      if (!real) throw new Error('7z binary missing');
      const log = path.join(dir, 'argv.log');
      const wrapper = path.join(dir, '7z-recorder.sh');
      writeFileSync(
        wrapper,
        `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg" >> '${log}'; done\nprintf -- '--end-of-call--\\n' >> '${log}'\nexec '${real}' "$@"\n`
      );
      chmodSync(wrapper, 0o755);
      process.env.P7ZIP_PATH = wrapper;
      return log;
    }

    function recordedCalls(log: string): string[][] {
      return readFileSync(log, 'utf-8')
        .split('--end-of-call--\n')
        .filter((record) => record.length > 0)
        .map((record) => record.split('\n').filter((arg) => arg.length > 0));
    }

    async function withTempDirAsync(work: (dir: string) => Promise<void>): Promise<void> {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'archive-password-argv-'));
      try {
        await work(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    oracleTest('extraction and listing never carry the password or a -p switch', ['7z'], async () => {
      const zip = buildFixture('zip-aes256', PASSWORD);
      const sevenZ = buildFixture('7z-encrypted-header', PASSWORD);
      await withTempDirAsync(async (dir) => {
        const log = installRecordingWrapper(dir);
        expectFilesMatch(await extractZipArchive(zip, { password: PASSWORD }));
        convertWithNative7z(sevenZ, '7z', 'zip', { password: PASSWORD }, 'in.7z');
        await convertWithWorker7z(sevenZ, '7z', 'zip', { password: PASSWORD, throwOnUnavailable: true }, 'in.7z');
        const listed = await inspectArchive(sevenZ, { filename: 'in.7z', password: PASSWORD });
        expect(listed.entries.length).toBeGreaterThan(0);

        const calls = recordedCalls(log);
        const reads = calls.filter((args) => args[0] === 'x' || args[0] === 'l');
        // Three extractions, one inspect listing and the encryption checks of the two converted zips.
        expect(reads.map((args) => args[0]).sort()).toEqual(['l', 'l', 'l', 'x', 'x', 'x']);
        for (const args of reads) {
          expect(args.filter((arg) => arg.startsWith('-p')), `switches in: ${args.join(' ')}`).toEqual([]);
        }
        for (const args of calls) {
          expect(args.some((arg) => arg.includes(PASSWORD)), `password in: ${args.join(' ')}`).toBe(false);
        }
      });
    });

    oracleTest('creation passes only the bare -p switch, so the password stays out of argv', ['7z'], async () => {
      await withTempDirAsync(async (dir) => {
        const log = installRecordingWrapper(dir);
        const files = PLAIN_FILES.map((file) => ({ filename: file.name, buffer: file.data }));
        const zip = await createZipArchive(files, { password: PASSWORD }, 'out.zip');
        const sevenZ = create7zArchive(files, { password: PASSWORD }, 'out.7z');
        const converted = await convertWithWorker7z(buildPlainZip(), 'zip', '7z', { password: PASSWORD, throwOnUnavailable: true }, 'in.zip');
        expectPlainFiles(unpackWithOracle(zip.buffer, 'zip', PASSWORD));
        expectPlainFiles(unpackWithOracle(sevenZ.buffer, '7z', PASSWORD));
        expectPlainFiles(unpackWithOracle(converted!.buffer, '7z', PASSWORD));

        const calls = recordedCalls(log);
        const creations = calls.filter((args) => args[0] === 'a');
        expect(creations.length).toBe(3);
        for (const args of creations) {
          expect(args.filter((arg) => arg.startsWith('-p')), `switches in: ${args.join(' ')}`).toEqual(['-p']);
        }
        for (const args of calls) {
          expect(args.some((arg) => arg.includes(PASSWORD)), `password in: ${args.join(' ')}`).toBe(false);
        }
      });
    });
  });

  describe('password failure classification', () => {
    it('treats an entry name that embeds the header complaint as a data error, not a password failure', () => {
      const forged = [
        'ERROR: CRC Failed : x : Cannot open encrypted archive. Wrong password?',
        'ERROR: Unsupported Method : zz : Cannot open encrypted archive. Wrong password?',
      ];
      for (const line of forged) {
        expect(isArchivePasswordFailure(line)).toBe(false);
      }
    });

    it('still recognizes the header complaint 7-Zip prints for a wrong password', () => {
      const genuine = [
        'ERROR: /path/a.7z : Cannot open encrypted archive. Wrong password?',
        'Cannot open encrypted archive. Wrong password?',
      ];
      for (const line of genuine) {
        expect(isArchivePasswordFailure(line)).toBe(true);
      }
    });
  });

  describe('password validation', () => {
    it('rejects line breaks and NUL, which would end the password early or answer a later prompt', () => {
      for (const password of ['a\nb', 'a\rb', 'a\0b', 'tail\n']) {
        expect(() => assertArchivePasswordSafe(password)).toThrow(/invalid newline or null characters/);
      }
    });

    it('bounds the password length in UTF-8 bytes', () => {
      const atLimit = sevenZipReadPasswordInput('x'.repeat(MAX_ARCHIVE_PASSWORD_BYTES));
      expect(atLimit.length).toBe(MAX_ARCHIVE_PASSWORD_BYTES + 1);
      expect(atLimit.at(-1)).toBe(0x0a);
      expect(() => assertArchivePasswordSafe('x'.repeat(MAX_ARCHIVE_PASSWORD_BYTES + 1))).toThrow(ConversionFailedError);
      // 342 three-byte characters are 1026 bytes: the limit counts bytes, not characters.
      expect(() => assertArchivePasswordSafe('日'.repeat(342))).toThrow(/byte limit/);
    });

    it('answers an extraction prompt with an empty line when there is no password, and a creation prompt twice', () => {
      expect(sevenZipReadPasswordInput(undefined).toString('utf-8')).toBe('\n');
      expect(sevenZipReadPasswordInput('pw').toString('utf-8')).toBe('pw\n');
      expect(sevenZipCreatePasswordInput('pw').toString('utf-8')).toBe('pw\npw\n');
    });

    it('rejects a password that is not a string with a typed error instead of a TypeError', async () => {
      for (const password of [12345, 0, true, false, {}, [], ['pw'], { toString: () => 'pw' }]) {
        let failure: unknown;
        try {
          assertArchivePasswordSafe(password as unknown as string);
        } catch (err) {
          failure = err;
        }
        expect(failure, `${JSON.stringify(password)} was accepted`).toBeInstanceOf(ConversionFailedError);
        expect((failure as Error).message, JSON.stringify(password)).toBe('Archive password must be a string.');
      }
      // A falsy non-string must not silently produce an unprotected archive either.
      const files = PLAIN_FILES.map((file) => ({ filename: file.name, buffer: file.data }));
      for (const password of [0, false]) {
        const options = { password: password as unknown as string };
        await expect(createZipArchive(files, options, 'out.zip')).rejects.toThrow('Archive password must be a string.');
        expect(() => create7zArchive(files, options, 'out.7z')).toThrow('Archive password must be a string.');
      }
      // Absent and empty mean "no password" and stay valid.
      expect(sevenZipReadPasswordInput(undefined).toString('utf-8')).toBe('\n');
      expect(sevenZipReadPasswordInput('').toString('utf-8')).toBe('\n');
    });

    it('answers a non-string password on the legacy /api/convert route with HTTP 400', async () => {
      const zip = withTempDir((dir) => {
        writeFileSync(path.join(dir, 'a.txt'), 'x');
        execFileSync('7z', ['a', '-y', '-tzip', path.join(dir, 'in.zip'), 'a.txt'], { cwd: dir, stdio: 'pipe' });
        return readFileSync(path.join(dir, 'in.zip'));
      });
      for (const password of [12345, true, { nested: 'pw' }, ['pw']]) {
        const form = new FormData();
        form.append('file', new File([new Uint8Array(zip)], 'in.zip', { type: 'application/zip' }));
        form.append('targetFormat', '7z');
        form.append('options', JSON.stringify({ password }));
        const res = await convertRoute(new NextRequest('http://localhost/api/convert', { method: 'POST', body: form }));
        const body = await res.json();
        expect(res.status, `${JSON.stringify(password)} -> ${JSON.stringify(body)}`).toBe(400);
        expect(body.error).toBe('Archive password must be a string.');
      }
    });

    it('rejects lone surrogates, which UTF-8 would silently turn into U+FFFD', () => {
      for (const password of ['\ud800', 'ab\udc00cd', 'x\ud83d', '\ude00\ud83d']) {
        expect(() => assertArchivePasswordSafe(password), JSON.stringify(password)).toThrow(
          'Archive password contains an unpaired surrogate and cannot be encoded as UTF-8.'
        );
      }
      // A surrogate pair is a real character and is sent as its four UTF-8 bytes.
      expect([...sevenZipReadPasswordInput('\u{1F600}')]).toEqual([0xf0, 0x9f, 0x98, 0x80, 0x0a]);
    });

    it('rejects ASCII control characters in a ZIP password, which 7-Zip fails with E_INVALIDARG', () => {
      const BLOCKED_BY_LINE_RULE = new Set([0x0a, 0x0d]);
      const FIRST_PRINTABLE = 0x20;
      for (let code = 1; code < FIRST_PRINTABLE; code += 1) {
        if (BLOCKED_BY_LINE_RULE.has(code)) continue;
        const password = `a${String.fromCharCode(code)}b`;
        expect(() => assertZipPasswordSupported(password), `0x${code.toString(16)}`).toThrow(UnsupportedOptionError);
      }
    });

    oracleTest('a ZIP target refuses a tab in the password on every creation path', ['7z'], async () => {
      const files = PLAIN_FILES.map((file) => ({ filename: file.name, buffer: file.data }));
      const password = 'tab\there';
      await expect(createZipArchive(files, { password }, 'out.zip')).rejects.toThrow(UnsupportedOptionError);
      expect(() => convertWithNative7z(buildPlainZip(), 'zip', 'zip', { password }, 'in.zip')).toThrow(UnsupportedOptionError);
      await expect(convertWithWorker7z(buildPlainZip(), 'zip', 'zip', { password, throwOnUnavailable: true }, 'in.zip')).rejects.toThrow(
        UnsupportedOptionError
      );
      await expect(convertArchive(buildPlainZip(), 'zip', 'zip', { password }, 'in.zip')).rejects.toThrow(UnsupportedOptionError);
      // A 7z target takes the same password.
      expectPlainFiles(unpackWithOracle(create7zArchive(files, { password }, 'out.7z').buffer, '7z', password));
    });

    oracleTest('a ZIP target still accepts the printable ASCII edge cases 7-Zip accepts (space, tilde, DEL)', ['7z'], async () => {
      const files = PLAIN_FILES.map((file) => ({ filename: file.name, buffer: file.data }));
      for (const password of ['a b', 'a~b', 'a\u007fb']) {
        const created = await createZipArchive(files, { password }, 'edge.zip');
        expectPlainFiles(unpackWithOracle(created.buffer, 'zip', password));
      }
    });

    it('applies the same validation before any archive is read', async () => {
      await expect(extractZipArchive(Buffer.alloc(64), { password: 'bad\npassword' })).rejects.toThrow(
        /invalid newline or null characters/
      );
    });
  });
});
