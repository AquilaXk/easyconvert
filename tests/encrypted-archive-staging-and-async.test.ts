import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const syncSubprocessSpies = vi.hoisted(() => ({
  execFileSyncCalls: 0,
  spawnSyncCalls: 0,
  realSpawnSync: null as null | typeof import('node:child_process').spawnSync,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  syncSubprocessSpies.realSpawnSync = actual.spawnSync;
  const wrappedExecFileSync = ((...args: Parameters<typeof actual.execFileSync>) => {
    syncSubprocessSpies.execFileSyncCalls += 1;
    return actual.execFileSync(...args);
  }) as typeof actual.execFileSync;
  const wrappedSpawnSync = ((...args: Parameters<typeof actual.spawnSync>) => {
    syncSubprocessSpies.spawnSyncCalls += 1;
    return actual.spawnSync(...args);
  }) as typeof actual.spawnSync;
  return {
    ...actual,
    default: {
      ...actual,
      execFileSync: wrappedExecFileSync,
      spawnSync: wrappedSpawnSync,
    },
    execFileSync: wrappedExecFileSync,
    spawnSync: wrappedSpawnSync,
  };
});

import {
  convertArchive,
  create7zArchive,
  create7zArchiveAsync,
  createTarArchive,
  createZipArchive,
} from '../src/lib/conversions/archive';
import {
  createEncryptedArchiveVia7z,
  createEncryptedArchiveVia7zAsync,
  resolveEncryptedStagingEntries,
} from '../src/lib/conversions/archive-encrypted';
import { UnsafeArchiveError } from '../src/lib/conversions/archive-extraction-safety';
import { MAX_ENCRYPTED_ARCHIVE_ENTRIES } from '../src/lib/conversions/archive-password';
import { ArchiveEntryCollisionError, ConversionFailedError, PayloadLimitError } from '../src/lib/types';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

const TEST_TIMEOUT_MS = 60_000;
const PASSWORD = 'Staging-Password-2026!';
const ORACLE_ENV: NodeJS.ProcessEnv = { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' };

vi.setConfig({ testTimeout: TEST_TIMEOUT_MS });

function oracle7z(): string {
  const tool = getOracleToolPath('7z');
  if (!tool) throw new Error('7z CLI is required for encrypted archive verification');
  return tool;
}

function collectFiles(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...collectFiles(root, rel));
    else out.push(rel);
  }
  return out.sort();
}

function unpackWithOracle(archive: Buffer, extension: 'zip' | '7z', password: string): Map<string, Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-stage-oracle-'));
  try {
    const archivePath = path.join(dir, `archive.${extension}`);
    const outDir = path.join(dir, 'out');
    fs.writeFileSync(archivePath, archive);
    const run = (syncSubprocessSpies.realSpawnSync ?? spawnSync)(
      oracle7z(),
      ['x', '-y', `-o${outDir}`, `-p${password}`, archivePath],
      {
        encoding: 'utf-8',
        env: ORACLE_ENV,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    if (run.error) throw run.error;
    if (run.status !== 0) {
      throw new Error(`7z extract failed (${run.status}): ${run.stderr}${run.stdout}`);
    }
    return new Map(collectFiles(outDir).map((name) => [name, fs.readFileSync(path.join(outDir, name))]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function expectDecodedEntries(decoded: Map<string, Buffer>, expected: Array<[string, string]>): void {
  expect([...decoded.keys()].sort()).toEqual(expected.map(([name]) => name).sort());
  for (const [name, payload] of expected) {
    expect(decoded.get(name)?.toString('utf-8'), `payload mismatch for ${name}`).toBe(payload);
  }
}

function entry(filename: string, text: string): { filename: string; buffer: Buffer } {
  return { filename, buffer: Buffer.from(text, 'utf-8') };
}

describe('encrypted archive staging normalization, collision resolution, permissions, and async safety', () => {
  const originalP7zip = process.env.P7ZIP_PATH;

  beforeAll(async () => {
    const tool = getOracleToolPath('7z');
    if (tool) {
      process.env.P7ZIP_PATH = tool;
      // Warm up one-time process-sandbox probes before sync-subprocess spy assertions run.
      await createZipArchive([entry('warmup.txt', 'ok')], { password: PASSWORD }, 'warmup.zip');
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (originalP7zip === undefined) delete process.env.P7ZIP_PATH;
    else process.env.P7ZIP_PATH = originalP7zip;
  });

  describe('resolveEncryptedStagingEntries unit contract', () => {
    it('normalizes unsafe prefixes and separators before resolving exact collisions', () => {
      const inputs = [entry('../doc.txt', 'v1'), entry('dir/../doc.txt', 'v2')];
      expect(resolveEncryptedStagingEntries(inputs, 'rename').map((f) => [f.filename, f.buffer.toString('utf-8')])).toEqual([
        ['doc.txt', 'v1'],
        ['doc-1.txt', 'v2'],
      ]);
      expect(resolveEncryptedStagingEntries(inputs, 'overwrite').map((f) => [f.filename, f.buffer.toString('utf-8')])).toEqual([
        ['doc.txt', 'v2'],
      ]);
      expect(() => resolveEncryptedStagingEntries(inputs, 'error')).toThrow(ArchiveEntryCollisionError);

      const slashInputs = [entry('./sub//x.txt', 's1'), entry('sub\\\\x.txt', 's2')];
      expect(resolveEncryptedStagingEntries(slashInputs, 'rename').map((f) => [f.filename, f.buffer.toString('utf-8')])).toEqual([
        ['sub/x.txt', 's1'],
        ['sub/x-1.txt', 's2'],
      ]);
      expect(resolveEncryptedStagingEntries(slashInputs, 'overwrite').map((f) => [f.filename, f.buffer.toString('utf-8')])).toEqual([
        ['sub/x.txt', 's2'],
      ]);
      expect(() => resolveEncryptedStagingEntries(slashInputs, 'error')).toThrow(ArchiveEntryCollisionError);
    });

    it('resolves file-vs-ancestor-directory conflicts regardless of input order across all policies', () => {
      const fileFirst = [entry('a', 'file-a'), entry('a/b.txt', 'nested-b')];
      expect(resolveEncryptedStagingEntries(fileFirst, 'rename').map((f) => [f.filename, f.buffer.toString('utf-8')])).toEqual([
        ['a-1', 'file-a'],
        ['a/b.txt', 'nested-b'],
      ]);
      expect(resolveEncryptedStagingEntries(fileFirst, 'overwrite').map((f) => [f.filename, f.buffer.toString('utf-8')])).toEqual([
        ['a/b.txt', 'nested-b'],
      ]);
      expect(() => resolveEncryptedStagingEntries(fileFirst, 'error')).toThrow(ArchiveEntryCollisionError);

      const dirFirst = [entry('a/b.txt', 'nested-b'), entry('a', 'file-a')];
      expect(resolveEncryptedStagingEntries(dirFirst, 'rename').map((f) => [f.filename, f.buffer.toString('utf-8')])).toEqual([
        ['a/b.txt', 'nested-b'],
        ['a-1', 'file-a'],
      ]);
      expect(resolveEncryptedStagingEntries(dirFirst, 'overwrite').map((f) => [f.filename, f.buffer.toString('utf-8')])).toEqual([
        ['a', 'file-a'],
      ]);
      expect(() => resolveEncryptedStagingEntries(dirFirst, 'error')).toThrow(ArchiveEntryCollisionError);

      const nestedConflict = [entry('d/sub', 'sub-file'), entry('d/sub/c.txt', 'deep-c'), entry('d/keep.txt', 'keep')];
      expect(resolveEncryptedStagingEntries(nestedConflict, 'rename').map((f) => [f.filename, f.buffer.toString('utf-8')])).toEqual([
        ['d/sub-1', 'sub-file'],
        ['d/sub/c.txt', 'deep-c'],
        ['d/keep.txt', 'keep'],
      ]);
      expect(resolveEncryptedStagingEntries(nestedConflict, 'overwrite').map((f) => [f.filename, f.buffer.toString('utf-8')])).toEqual([
        ['d/sub/c.txt', 'deep-c'],
        ['d/keep.txt', 'keep'],
      ]);
    });

    it('handles multi-step overwrite chains and rename collision chains without quadratic work or double-renaming', () => {
      const overwriteChain = [
        entry('a', 'first-a'),
        entry('a/b.txt', 'child-b'),
        entry('a', 'last-a'),
      ];
      expect(resolveEncryptedStagingEntries(overwriteChain, 'overwrite').map((f) => [f.filename, f.buffer.toString('utf-8')])).toEqual([
        ['a', 'last-a'],
      ]);

      const renameChain = [
        entry('a', 'file-a'),
        entry('a-1', 'explicit-a1'),
        entry('a/b.txt', 'child-b'),
      ];
      const renamedOnce = resolveEncryptedStagingEntries(renameChain, 'rename');
      expect(renamedOnce.map((f) => [f.filename, f.buffer.toString('utf-8')])).toEqual([
        ['a-2', 'file-a'],
        ['a-1', 'explicit-a1'],
        ['a/b.txt', 'child-b'],
      ]);
      // Idempotent on second call (direct callers + archive.ts wrapper never double-rename).
      const renamedTwice = resolveEncryptedStagingEntries(renamedOnce, 'rename');
      expect(renamedTwice.map((f) => [f.filename, f.buffer.toString('utf-8')])).toEqual([
        ['a-2', 'file-a'],
        ['a-1', 'explicit-a1'],
        ['a/b.txt', 'child-b'],
      ]);
    });

    it('refuses invalid staging entry names with UnsafeArchiveError', () => {
      for (const badName of ['', '..', '.', './', 'a\0b.txt', 'a\u0001b.txt']) {
        expect(() => resolveEncryptedStagingEntries([entry(badName, 'x')], 'rename')).toThrow(UnsafeArchiveError);
      }
    });

    it('enforces MAX_FILES on final resolved entries without invoking 7z', async () => {
      const empty = Buffer.alloc(0);
      const overLimit = Array.from({ length: MAX_ENCRYPTED_ARCHIVE_ENTRIES + 1 }, (_, i) => ({
        filename: `f${i}.txt`,
        buffer: empty,
      }));
      syncSubprocessSpies.execFileSyncCalls = 0;
      syncSubprocessSpies.spawnSyncCalls = 0;
      await expect(createZipArchive(overLimit, { password: PASSWORD }, 'too-many.zip')).rejects.toThrow(PayloadLimitError);
      await expect(create7zArchiveAsync(overLimit, { password: PASSWORD }, 'too-many.7z')).rejects.toThrow(PayloadLimitError);
      expect(() => create7zArchive(overLimit, { password: PASSWORD }, 'too-many.7z')).toThrow(PayloadLimitError);
      await expect(
        createEncryptedArchiveVia7zAsync(overLimit, {
          p7z: '/nonexistent/7z',
          archiveName: 'too-many.7z',
          archiveType: '7z',
          mimeType: 'application/x-7z-compressed',
          password: PASSWORD,
        })
      ).rejects.toThrow(ConversionFailedError);
      expect(syncSubprocessSpies.execFileSyncCalls).toBe(0);
      expect(syncSubprocessSpies.spawnSyncCalls).toBe(0);

      // Overwrite collapsing duplicates below MAX_FILES still succeeds cleanly.
      const collapsedDuplicates = Array.from({ length: MAX_ENCRYPTED_ARCHIVE_ENTRIES + 5 }, () => entry('dup.txt', 'latest'));
      expect(resolveEncryptedStagingEntries(collapsedDuplicates, 'overwrite')).toHaveLength(1);
    });
  });

  describe('oracle verification of post-normalization and ancestor-prefix conflicts', () => {
    for (const target of ['zip', '7z'] as const) {
      const createEncrypted = async (
        files: { filename: string; buffer: Buffer }[],
        collisionPolicy: 'rename' | 'error' | 'overwrite'
      ) => {
        if (target === 'zip') {
          return createZipArchive(files, { password: PASSWORD, collisionPolicy }, 'out.zip');
        }
        return create7zArchiveAsync(files, { password: PASSWORD, collisionPolicy }, 'out.7z');
      };

      oracleTest(`post-normalization collisions in encrypted ${target} decrypt to expected entries under rename/error/overwrite`, ['7z'], async () => {
        const traversalDups = [entry('../doc.txt', 'first-doc'), entry('dir/../doc.txt', 'second-doc')];
        const renamedTraversal = await createEncrypted(traversalDups, 'rename');
        expectDecodedEntries(unpackWithOracle(renamedTraversal.buffer, target, PASSWORD), [
          ['doc.txt', 'first-doc'],
          ['doc-1.txt', 'second-doc'],
        ]);

        const overwrittenTraversal = await createEncrypted(traversalDups, 'overwrite');
        expectDecodedEntries(unpackWithOracle(overwrittenTraversal.buffer, target, PASSWORD), [
          ['doc.txt', 'second-doc'],
        ]);

        const traversalErr = await createEncrypted(traversalDups, 'error').then(
          () => null,
          (err: unknown) => err
        );
        expect(traversalErr).toBeInstanceOf(ArchiveEntryCollisionError);
        expect((traversalErr as ArchiveEntryCollisionError).status).toBe(422);

        const separatorDups = [entry('./sub//x.txt', 'slash-v1'), entry('sub\\\\x.txt', 'backslash-v2')];
        const renamedSep = await createEncrypted(separatorDups, 'rename');
        expectDecodedEntries(unpackWithOracle(renamedSep.buffer, target, PASSWORD), [
          ['sub/x.txt', 'slash-v1'],
          ['sub/x-1.txt', 'backslash-v2'],
        ]);

        const overwrittenSep = await createEncrypted(separatorDups, 'overwrite');
        expectDecodedEntries(unpackWithOracle(overwrittenSep.buffer, target, PASSWORD), [
          ['sub/x.txt', 'backslash-v2'],
        ]);

        await expect(createEncrypted(separatorDups, 'error')).rejects.toThrow(ArchiveEntryCollisionError);
      });

      oracleTest(`file-vs-ancestor-directory conflicts in encrypted ${target} decrypt cleanly under rename/error/overwrite`, ['7z'], async () => {
        const fileFirst = [entry('a', 'file-a'), entry('a/b.txt', 'child-b')];
        const dirFirst = [entry('a/b.txt', 'child-b'), entry('a', 'file-a')];
        const nested = [entry('d/sub', 'file-sub'), entry('d/sub/c.txt', 'nested-c')];

        expectDecodedEntries(unpackWithOracle((await createEncrypted(fileFirst, 'rename')).buffer, target, PASSWORD), [
          ['a-1', 'file-a'],
          ['a/b.txt', 'child-b'],
        ]);
        expectDecodedEntries(unpackWithOracle((await createEncrypted(dirFirst, 'rename')).buffer, target, PASSWORD), [
          ['a/b.txt', 'child-b'],
          ['a-1', 'file-a'],
        ]);
        expectDecodedEntries(unpackWithOracle((await createEncrypted(nested, 'rename')).buffer, target, PASSWORD), [
          ['d/sub-1', 'file-sub'],
          ['d/sub/c.txt', 'nested-c'],
        ]);

        expectDecodedEntries(unpackWithOracle((await createEncrypted(fileFirst, 'overwrite')).buffer, target, PASSWORD), [
          ['a/b.txt', 'child-b'],
        ]);
        expectDecodedEntries(unpackWithOracle((await createEncrypted(dirFirst, 'overwrite')).buffer, target, PASSWORD), [
          ['a', 'file-a'],
        ]);
        expectDecodedEntries(unpackWithOracle((await createEncrypted(nested, 'overwrite')).buffer, target, PASSWORD), [
          ['d/sub/c.txt', 'nested-c'],
        ]);

        await expect(createEncrypted(fileFirst, 'error')).rejects.toThrow(ArchiveEntryCollisionError);
        await expect(createEncrypted(dirFirst, 'error')).rejects.toThrow(ArchiveEntryCollisionError);
        await expect(createEncrypted(nested, 'error')).rejects.toThrow(ArchiveEntryCollisionError);
      });
    }

    oracleTest('direct createEncryptedArchiveVia7z and createEncryptedArchiveVia7zAsync enforce normalization and prefix rules', ['7z'], async () => {
      const p7z = oracle7z();
      const files = [entry('../doc.txt', 'one'), entry('dir/../doc.txt', 'two'), entry('d/sub', 'sub'), entry('d/sub/c.txt', 'c')];

      const asyncRes = await createEncryptedArchiveVia7zAsync(files, {
        p7z,
        archiveName: 'direct.7z',
        archiveType: '7z',
        mimeType: 'application/x-7z-compressed',
        password: PASSWORD,
      });
      expect(asyncRes?.filename).toBe('direct.7z');
      expectDecodedEntries(unpackWithOracle(asyncRes!.buffer, '7z', PASSWORD), [
        ['doc.txt', 'one'],
        ['doc-1.txt', 'two'],
        ['d/sub-1', 'sub'],
        ['d/sub/c.txt', 'c'],
      ]);

      const syncRes = createEncryptedArchiveVia7z(files, {
        p7z,
        archiveName: 'direct-sync.zip',
        archiveType: 'zip',
        mimeType: 'application/zip',
        password: PASSWORD,
        collisionPolicy: 'overwrite',
      });
      expect(syncRes?.filename).toBe('direct-sync.zip');
      expectDecodedEntries(unpackWithOracle(syncRes!.buffer, 'zip', PASSWORD), [
        ['doc.txt', 'two'],
        ['d/sub/c.txt', 'c'],
      ]);
    });
  });

  describe('atomic mkdtemp, 0o700/0o600 staging permissions, and cleanup guarantees', () => {
    function snapshotTreeModes(root: string): {
      dirs: Array<{ rel: string; mode: number }>;
      files: Array<{ rel: string; mode: number }>;
    } {
      const dirs: Array<{ rel: string; mode: number }> = [];
      const files: Array<{ rel: string; mode: number }> = [];
      const stack: Array<{ abs: string; rel: string }> = [{ abs: root, rel: '.' }];
      while (stack.length > 0) {
        const current = stack.pop()!;
        const stat = fs.lstatSync(current.abs);
        if (stat.isDirectory()) {
          dirs.push({ rel: current.rel, mode: stat.mode & 0o777 });
          for (const entryName of fs.readdirSync(current.abs)) {
            stack.push({
              abs: path.join(current.abs, entryName),
              rel: current.rel === '.' ? entryName : `${current.rel}/${entryName}`,
            });
          }
        } else if (stat.isFile()) {
          files.push({ rel: current.rel, mode: stat.mode & 0o777 });
        }
      }
      return { dirs, files };
    }

    oracleTest('creates atomic 0o700 workDir/stagingDir/subdirs and 0o600 staged files, then removes workDir on success, failure, and abort', ['7z'], async () => {
      const isolatedTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-perm-tmp-'));
      vi.spyOn(os, 'tmpdir').mockReturnValue(isolatedTmp);

      const stagedInput = [
        entry('top.txt', 'top'),
        entry('a/b/deep.txt', 'deep'),
      ];

      let observedWorkDir = '';
      let observedModes: ReturnType<typeof snapshotTreeModes> | null = null;
      const realAsyncRm = fs.promises.rm.bind(fs.promises);
      vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
        const targetStr = String(target);
        if (path.dirname(targetStr) === isolatedTmp && path.basename(targetStr).startsWith('easyconvert-7z-create-')) {
          observedWorkDir = targetStr;
          observedModes = snapshotTreeModes(targetStr);
        }
        return realAsyncRm(target, options);
      });

      const okRes = await create7zArchiveAsync(stagedInput, { password: PASSWORD }, 'perm.7z');
      expect(okRes.size).toBeGreaterThan(0);
      expect(path.basename(observedWorkDir)).toMatch(/^easyconvert-7z-create-\d+-/);
      expect(observedModes).not.toBeNull();
      expect(observedModes!.dirs.map((d) => d.rel).sort()).toEqual(['.', 'staging', 'staging/a', 'staging/a/b']);
      for (const dirEntry of observedModes!.dirs) {
        expect(dirEntry.mode, `dir ${dirEntry.rel} mode`).toBe(0o700);
      }
      const stagedFiles = observedModes!.files.filter((f) => f.rel.startsWith('staging/'));
      expect(stagedFiles.map((f) => f.rel).sort()).toEqual(['staging/a/b/deep.txt', 'staging/top.txt']);
      for (const fileEntry of stagedFiles) {
        expect(fileEntry.mode, `file ${fileEntry.rel} mode`).toBe(0o600);
      }
      expect(fs.existsSync(observedWorkDir)).toBe(false);
      expect(fs.readdirSync(isolatedTmp)).toEqual([]);

      // Encrypted ZIP path also uses atomic easyconvert-zip-create- workDir with 0o700 dirs and 0o600 files.
      let observedZipWorkDir = '';
      let observedZipModes: ReturnType<typeof snapshotTreeModes> | null = null;
      vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
        const targetStr = String(target);
        if (path.dirname(targetStr) === isolatedTmp && path.basename(targetStr).startsWith('easyconvert-zip-create-')) {
          observedZipWorkDir = targetStr;
          observedZipModes = snapshotTreeModes(targetStr);
        }
        return realAsyncRm(target, options);
      });
      const zipOkRes = await createZipArchive(stagedInput, { password: PASSWORD }, 'perm.zip');
      expect(zipOkRes.size).toBeGreaterThan(0);
      expect(path.basename(observedZipWorkDir)).toMatch(/^easyconvert-zip-create-\d+-/);
      expect(observedZipModes!.dirs.map((d) => d.rel).sort()).toEqual(['.', 'staging', 'staging/a', 'staging/a/b']);
      for (const dirEntry of observedZipModes!.dirs) {
        expect(dirEntry.mode, `zip dir ${dirEntry.rel} mode`).toBe(0o700);
      }
      for (const fileEntry of observedZipModes!.files.filter((f) => f.rel.startsWith('staging/'))) {
        expect(fileEntry.mode, `zip file ${fileEntry.rel} mode`).toBe(0o600);
      }
      expect(fs.existsSync(observedZipWorkDir)).toBe(false);

      // Sync path permissions check as well.
      let observedSyncWorkDir = '';
      let observedSyncModes: ReturnType<typeof snapshotTreeModes> | null = null;
      const realSyncRm = fs.rmSync.bind(fs);
      vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
        const targetStr = String(target);
        if (path.dirname(targetStr) === isolatedTmp && path.basename(targetStr).startsWith('easyconvert-7z-create-')) {
          observedSyncWorkDir = targetStr;
          observedSyncModes = snapshotTreeModes(targetStr);
        }
        return realSyncRm(target, options);
      });

      const syncRes = create7zArchive(stagedInput, { password: PASSWORD }, 'sync-perm.7z');
      expect(syncRes.size).toBeGreaterThan(0);
      expect(path.basename(observedSyncWorkDir)).toMatch(/^easyconvert-7z-create-\d+-/);
      for (const dirEntry of observedSyncModes!.dirs) {
        expect(dirEntry.mode, `sync dir ${dirEntry.rel} mode`).toBe(0o700);
      }
      for (const fileEntry of observedSyncModes!.files.filter((f) => f.rel.startsWith('staging/'))) {
        expect(fileEntry.mode, `sync file ${fileEntry.rel} mode`).toBe(0o600);
      }
      expect(fs.existsSync(observedSyncWorkDir)).toBe(false);

      // Failure cleanup check (non-existent p7z fails after workDir creation).
      await expect(
        createEncryptedArchiveVia7zAsync(stagedInput, {
          p7z: '/nonexistent/missing-7z',
          archiveName: 'fail.7z',
          archiveType: '7z',
          mimeType: 'application/x-7z-compressed',
          password: PASSWORD,
        })
      ).rejects.toThrow();
      expect(fs.readdirSync(isolatedTmp)).toEqual([]);

      // Abort cleanup check (abort triggered mid-staging after workDir creation).
      const controller = new AbortController();
      const realWriteFile = fs.promises.writeFile.bind(fs.promises);
      let writes = 0;
      vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data, options) => {
        writes += 1;
        if (writes === 1) controller.abort();
        return realWriteFile(file, data, options);
      });
      const manyFiles = Array.from({ length: 40 }, (_, i) => entry(`batch_${i}.txt`, `payload-${i}`));
      await expect(
        create7zArchiveAsync(manyFiles, { password: PASSWORD }, 'aborted.7z', { signal: controller.signal })
      ).rejects.toThrow();
      expect(fs.readdirSync(isolatedTmp)).toEqual([]);

      fs.rmSync(isolatedTmp, { recursive: true, force: true });
    });
  });

  describe('non-blocking async 7z creation and AbortSignal propagation', () => {
    oracleTest('executes zero synchronous subprocess calls while keeping event-loop heartbeats alive', ['7z'], async () => {
      const files = Array.from({ length: 64 }, (_, i) =>
        entry(`dir_${i % 4}/file_${i}.txt`, `non-blocking encrypted payload ${i}\n`.repeat(12))
      );
      const tarSource = createTarArchive([entry('a', 'file-a'), entry('a/b.txt', 'nested-b')]).buffer;

      // Positive control: synchronous create7zArchive does call execFileSync.
      syncSubprocessSpies.execFileSyncCalls = 0;
      syncSubprocessSpies.spawnSyncCalls = 0;
      create7zArchive(files.slice(0, 2), { password: PASSWORD }, 'control-sync.7z');
      expect(syncSubprocessSpies.execFileSyncCalls).toBeGreaterThan(0);
      syncSubprocessSpies.execFileSyncCalls = 0;
      syncSubprocessSpies.spawnSyncCalls = 0;

      for (const [label, run] of [
        ['createZipArchive', () => createZipArchive(files, { password: PASSWORD }, 'async.zip')],
        ['create7zArchiveAsync', () => create7zArchiveAsync(files, { password: PASSWORD }, 'async.7z')],
        ['convertArchive(tar -> 7z)', () => convertArchive(tarSource, 'tar', '7z', { password: PASSWORD }, 'bundle.tar')],
      ] as const) {
        let ticks = 0;
        const timer = setInterval(() => {
          ticks += 1;
        }, 1);
        try {
          const result = await run();
          expect(result.size, label).toBeGreaterThan(0);
          expect(ticks, `${label} heartbeat ticks`).toBeGreaterThan(0);
          expect(syncSubprocessSpies.execFileSyncCalls, `${label} execFileSync`).toBe(0);
          expect(syncSubprocessSpies.spawnSyncCalls, `${label} spawnSync`).toBe(0);
        } finally {
          clearInterval(timer);
        }
      }

      // Restore spies before calling oracle extraction.
      vi.restoreAllMocks();
      const converted = await convertArchive(tarSource, 'tar', '7z', { password: PASSWORD }, 'bundle.tar');
      expectDecodedEntries(unpackWithOracle(converted.buffer, '7z', PASSWORD), [
        ['a-1', 'file-a'],
        ['a/b.txt', 'nested-b'],
      ]);
    });

    oracleTest('convertArchive forwards options.signal to create7zArchiveAsync', ['7z'], async () => {
      const controller = new AbortController();
      controller.abort(new Error('caller cancelled'));
      const tarSource = createTarArchive([entry('item.txt', 'hello')]).buffer;

      await expect(
        convertArchive(tarSource, 'tar', '7z', { password: PASSWORD, signal: controller.signal }, 'cancelled.tar')
      ).rejects.toThrow('caller cancelled');

      const isolatedTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-convert-abort-tmp-'));
      vi.spyOn(os, 'tmpdir').mockReturnValue(isolatedTmp);
      const midFlightController = new AbortController();
      const realWriteFile = fs.promises.writeFile.bind(fs.promises);
      let written = 0;
      vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data, options) => {
        written += 1;
        if (written === 1) midFlightController.abort(new Error('aborted mid-staging'));
        return realWriteFile(file, data, options);
      });
      const multiTar = createTarArchive(
        Array.from({ length: 40 }, (_, i) => entry(`part_${i}.txt`, `payload-${i}`))
      ).buffer;
      await expect(
        convertArchive(multiTar, 'tar', '7z', { password: PASSWORD, signal: midFlightController.signal }, 'mid-abort.tar')
      ).rejects.toThrow('aborted mid-staging');
      expect(fs.readdirSync(isolatedTmp)).toEqual([]);
      fs.rmSync(isolatedTmp, { recursive: true, force: true });
    });
  });
});
