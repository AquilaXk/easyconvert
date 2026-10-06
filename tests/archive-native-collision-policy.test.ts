import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { convertWithNative7z as convertWithNative7zWorker } from '../src/worker/engines';
import { convertArchive, convertWithNative7z, extractZipArchive } from '../src/lib/conversions/archive';
import { ArchiveEntryCollisionError } from '../src/lib/types';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { resolveStdinPasswordSevenZip, type StdinPasswordSevenZip } from './helpers/stdin-password-7z';
import {
  buildEncryptedZip,
  buildTarWithEntries,
  createHostileWorkspace,
  list7zEntryPaths,
  patchZipEntryName,
  type HostileWorkspace,
} from './helpers/hostile-archives';

/**
 * The extraction collision policy must hold on the native 7-Zip path as it does in the in-process
 * readers: 'error' rejects duplicate entries, 'rename' yields name, name-1, ..., and 'overwrite'
 * keeps the last entry. Fixtures are written by Python's tarfile and read back with the 7z CLI.
 */

const TOOLS = ['7z', 'python3'] as const;
const PASSWORD = 'Collision-Pass-42';
const HTTP_UNPROCESSABLE = 422;
/** Targets the native 7-Zip engine packages. */
const NATIVE_TARGETS = ['zip', '7z', 'tar.gz', 'tar.bz2'] as const;

const DUPLICATE_ENTRIES = [
  { name: 'a.txt', data: 'one' },
  { name: 'docs/a.txt', data: 'nested' },
  { name: 'a.txt', data: 'two' },
  { name: 'a.txt', data: 'three' },
];

function readEntry(archivePath: string, entry: string): string {
  const sevenZip = getOracleToolPath('7z');
  if (!sevenZip) throw new Error('7z is required to read the output archive');
  return execFileSync(sevenZip, ['x', '-so', archivePath, entry], { encoding: 'utf-8', stdio: 'pipe' });
}

describe('extraction collision policy on the native 7z path', () => {
  const originalP7zipPath = process.env.P7ZIP_PATH;
  let sevenZip: StdinPasswordSevenZip | null = null;
  let ws: HostileWorkspace;

  beforeAll(() => {
    const hostBinary = getOracleToolPath('7z');
    if (hostBinary) {
      sevenZip = resolveStdinPasswordSevenZip(hostBinary);
      process.env.P7ZIP_PATH = sevenZip.binary;
    }
  });

  afterAll(() => {
    sevenZip?.cleanup();
    if (originalP7zipPath === undefined) {
      delete process.env.P7ZIP_PATH;
    } else {
      process.env.P7ZIP_PATH = originalP7zipPath;
    }
  });

  beforeEach(() => {
    ws = createHostileWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  function dispatch(tarPath: string, target: string, options: Record<string, unknown>, outputPath?: string) {
    const inputBuffer = fs.readFileSync(tarPath);
    const input = outputPath ? { inputBuffer, outputPath } : inputBuffer;
    return ws.withTmpdir(() => dispatchConversion(input, 'tar', target, options, path.basename(tarPath)));
  }

  describe("collisionPolicy 'error'", () => {
    for (const target of NATIVE_TARGETS) {
      oracleTest(`rejects a tar with duplicate entries when converting to ${target}`, [...TOOLS], async () => {
        const tar = buildTarWithEntries(path.join(ws.fixturesDir, 'dup.tar'), DUPLICATE_ENTRIES);
        const before = ws.snapshot();

        const outcome = await dispatch(tar, target, { collisionPolicy: 'error' }).then(
          () => null,
          (error: unknown) => error
        );

        expect(outcome).toBeInstanceOf(ArchiveEntryCollisionError);
        expect(outcome).toMatchObject({ status: HTTP_UNPROCESSABLE });
        expect((outcome as Error).message).toMatch(/collision detected for 'a\.txt' under collision policy 'error'/);
        expect(ws.snapshot()).toEqual(before);
      });
    }

    // The registry does not offer tar -> tar.xz through the dispatcher (reported separately), so the native
    // worker route is exercised directly for the xz container.
    oracleTest('rejects a tar with duplicate entries when the native worker packages tar.xz', [...TOOLS], async () => {
      const tar = buildTarWithEntries(path.join(ws.fixturesDir, 'dup.tar'), DUPLICATE_ENTRIES);

      const outcome = await ws
        .withTmpdir(() => convertWithNative7zWorker(fs.readFileSync(tar), 'tar', 'tar.xz', { collisionPolicy: 'error' }, 'dup.tar'))
        .then(
          () => null,
          (error: unknown) => error
        );

      expect(outcome).toBeInstanceOf(ArchiveEntryCollisionError);
      expect(outcome).toMatchObject({ status: HTTP_UNPROCESSABLE });
    });

    oracleTest('keeps rejecting duplicates for the in-process tar.zst target', [...TOOLS], async () => {
      const tar = buildTarWithEntries(path.join(ws.fixturesDir, 'dup.tar'), DUPLICATE_ENTRIES);

      const outcome = await dispatch(tar, 'tar.zst', { collisionPolicy: 'error' }).then(
        () => null,
        (error: unknown) => error
      );

      expect(outcome).toBeInstanceOf(ArchiveEntryCollisionError);
      expect(outcome).toMatchObject({ status: HTTP_UNPROCESSABLE });
    });

    oracleTest('rejects a file and a directory that share one path', [...TOOLS], async () => {
      const tar = buildTarWithEntries(path.join(ws.fixturesDir, 'filedir.tar'), [
        { name: 'd', data: 'file' },
        { name: 'd/', kind: 'directory' },
      ]);

      const outcome = await dispatch(tar, 'zip', { collisionPolicy: 'error' }).then(
        () => null,
        (error: unknown) => error
      );

      expect(outcome).toBeInstanceOf(ArchiveEntryCollisionError);
      expect((outcome as Error).message).toMatch(/collision detected for 'd' under collision policy 'error'/);
    });

    oracleTest('still converts an archive without duplicates natively', [...TOOLS], async () => {
      const tar = buildTarWithEntries(path.join(ws.fixturesDir, 'unique.tar'), [
        { name: 'a.txt', data: 'one' },
        { name: 'docs/a.txt', data: 'nested' },
      ]);
      const outputPath = path.join(ws.fixturesDir, 'unique.zip');

      const result = await dispatch(tar, 'zip', { collisionPolicy: 'error' }, outputPath);

      expect(result.engineUsed).toBe('native-7z');
      expect(readEntry(outputPath, 'a.txt')).toBe('one');
      expect(readEntry(outputPath, 'docs/a.txt')).toBe('nested');
    });
  });

  describe("collisionPolicy 'rename' (the default)", () => {
    for (const options of [{}, { collisionPolicy: 'rename' }]) {
      oracleTest(`keeps every duplicate under a numbered name with ${JSON.stringify(options)}`, [...TOOLS], async () => {
        const tar = buildTarWithEntries(path.join(ws.fixturesDir, 'dup.tar'), DUPLICATE_ENTRIES);
        const outputPath = path.join(ws.fixturesDir, 'renamed.zip');

        const result = await dispatch(tar, 'zip', options, outputPath);

        expect(result.fallbackChain?.[0]).toMatch(/^native-7z: .*a\.txt/);
        expect(list7zEntryPaths(outputPath).sort()).toEqual(['a-1.txt', 'a-2.txt', 'a.txt', 'docs', 'docs/a.txt']);
        expect(readEntry(outputPath, 'a.txt')).toBe('one');
        expect(readEntry(outputPath, 'a-1.txt')).toBe('two');
        expect(readEntry(outputPath, 'a-2.txt')).toBe('three');
        expect(readEntry(outputPath, 'docs/a.txt')).toBe('nested');
      });
    }

    oracleTest('is handed to the in-process engines by the library route instead of overwriting', [...TOOLS], async () => {
      const tar = buildTarWithEntries(path.join(ws.fixturesDir, 'dup.tar'), DUPLICATE_ENTRIES);
      const before = ws.snapshot();

      const result = await ws.withTmpdir(async () =>
        convertWithNative7z(fs.readFileSync(tar), 'tar', 'zip', {}, 'dup.tar')
      );

      expect(result).toBeNull();
      expect(ws.snapshot()).toEqual(before);
    });
  });

  describe("collisionPolicy 'overwrite'", () => {
    oracleTest('keeps the last duplicate and stays on the native engine', [...TOOLS], async () => {
      const tar = buildTarWithEntries(path.join(ws.fixturesDir, 'dup.tar'), DUPLICATE_ENTRIES);
      const outputPath = path.join(ws.fixturesDir, 'overwritten.zip');

      const result = await dispatch(tar, 'zip', { collisionPolicy: 'overwrite' }, outputPath);

      expect(result.engineUsed).toBe('native-7z');
      expect(list7zEntryPaths(outputPath).sort()).toEqual(['a.txt', 'docs', 'docs/a.txt']);
      expect(readEntry(outputPath, 'a.txt')).toBe('three');
    });
  });

  describe('encrypted ZIP with duplicate names', () => {
    function duplicateNamedEncryptedZip(): Buffer {
      const zipPath = path.join(ws.fixturesDir, 'dup-encrypted.zip');
      buildEncryptedZip(zipPath, path.join(ws.fixturesDir, 'stage-dup'), {
        password: PASSWORD,
        files: [
          { name: 'first.txt', data: 'first' },
          { name: 'other.txt', data: 'other' },
        ],
      });
      patchZipEntryName(zipPath, 'other.txt', 'first.txt');
      return fs.readFileSync(zipPath);
    }

    oracleTest("rejects duplicates under policy 'error'", [...TOOLS], async () => {
      const zip = duplicateNamedEncryptedZip();

      const outcome = await ws
        .withTmpdir(() => extractZipArchive(zip, { password: PASSWORD, collisionPolicy: 'error' }))
        .then(
          () => null,
          (error: unknown) => error
        );

      expect(outcome).toBeInstanceOf(ArchiveEntryCollisionError);
      expect((outcome as Error).message).toMatch(/collision detected for 'first\.txt'/);
    });

    oracleTest("explains that 'rename' cannot be honoured while decrypting", [...TOOLS], async () => {
      const zip = duplicateNamedEncryptedZip();

      const outcome = await ws
        .withTmpdir(() => extractZipArchive(zip, { password: PASSWORD }))
        .then(
          () => null,
          (error: unknown) => error
        );

      expect(outcome).toBeInstanceOf(ArchiveEntryCollisionError);
      expect((outcome as Error).message).toMatch(/collisionPolicy 'overwrite' or 'error'/);
    });

    for (const collisionPolicy of [undefined, 'error'] as const) {
      oracleTest(`keeps the collision type through convertArchive (policy ${collisionPolicy ?? 'default'})`, [...TOOLS], async () => {
        const zip = duplicateNamedEncryptedZip();

        const outcome = await ws
          .withTmpdir(() => convertArchive(zip, 'zip', '7z', { password: PASSWORD, collisionPolicy }, 'dup-encrypted.zip'))
          .then(
            () => null,
            (error: unknown) => error
          );

        expect(outcome).toBeInstanceOf(ArchiveEntryCollisionError);
        expect((outcome as ArchiveEntryCollisionError).status).toBe(422);
        expect((outcome as Error).message).toMatch(/first\.txt/);
      });
    }

    oracleTest("keeps one file per name under policy 'overwrite'", [...TOOLS], async () => {
      const zip = duplicateNamedEncryptedZip();

      const files = await ws.withTmpdir(() => extractZipArchive(zip, { password: PASSWORD, collisionPolicy: 'overwrite' }));

      expect(files.map((file) => file.filename)).toEqual(['first.txt']);
    });
  });
});
