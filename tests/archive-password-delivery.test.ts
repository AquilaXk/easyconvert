import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
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
  MAX_ARCHIVE_PASSWORD_BYTES,
  MAX_ZIP_PASSWORD_BYTES,
  assertArchivePasswordSafe,
  execFileSyncWithPasswordStdin,
  sevenZipCreatePasswordInput,
  sevenZipReadPasswordInput,
} from '../src/lib/conversions/archive-password';
import { convertWithNative7z as convertWithWorker7z } from '../src/worker/engines';
import {
  ArchiveEncryptedHeaderError,
  ArchivePasswordRequiredError,
  ConversionFailedError,
  InvalidArchivePasswordError,
  UnsupportedOptionError,
} from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { getOracleToolPath } from './helpers/differential-oracle';
import { buildStoredRar4 } from './helpers/rar4-stored';

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
    return execFileSync(oracle7z(), ['l', '-slt', `-p${password}`, file], { encoding: 'utf-8', env: ORACLE_ENV, stdio: 'pipe' });
  });
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
      const rar = encryptedRar();
      const converted = convertWithNative7z(rar, 'rar', 'zip', { password: PASSWORD }, 'in.rar');
      expectPlainFiles(unpackWithOracle(converted!.buffer, 'zip', PASSWORD), RAR_FILES);
      expect(() => convertWithNative7z(rar, 'rar', 'zip', { password: WRONG_PASSWORD }, 'in.rar')).toThrow(
        InvalidArchivePasswordError
      );
      expect(() => convertWithNative7z(rar, 'rar', 'zip', {}, 'in.rar')).toThrow(ArchivePasswordRequiredError);
    });
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
        // Two extractions, two conversions' extractions and one listing went through the wrapper.
        expect(reads.map((args) => args[0]).sort()).toEqual(['l', 'x', 'x', 'x']);
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

    it('applies the same validation before any archive is read', async () => {
      await expect(extractZipArchive(Buffer.alloc(64), { password: 'bad\npassword' })).rejects.toThrow(
        /invalid newline or null characters/
      );
    });
  });
});
