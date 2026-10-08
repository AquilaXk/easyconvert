import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ARCHIVE_SECURITY_LIMITS,
  convertArchive,
  convertWithNative7z,
  extractWithSpannedStream7z,
  resolveArchiveEntryCollisions,
} from '../src/lib/conversions/archive';
import { convertWithNative7z as convertWithNative7zWorker, type WorkerConversionResult } from '../src/worker/engines';
import {
  assertExtractionContained,
  assertSafeArchiveListing,
  findEntryCollision,
  parse7zTechnicalListing,
  removeDirectoryTree,
  type ListedArchiveEntry,
} from '../src/lib/conversions/archive-extraction-safety';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import {
  build7zEncrypted,
  buildCompressedFile,
  buildDeepTar,
  buildManyEntriesTar,
  buildTarWithEntries,
  buildZipWithEntries,
  createHostileWorkspace,
  list7zEntryPaths,
  type HostileWorkspace,
} from './helpers/hostile-archives';
import { expectLinearOnInputs, SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';

/** Real engine, CLI or large-input work: the 5 s default fails on a loaded CI shard without any regression; 60 s only stops a hang. */
const ENGINE_TEST_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: ENGINE_TEST_TIMEOUT_MS });

/**
 * Regression suite for the adversarial review of PR #499: wrapper-format listings, directory sizes,
 * forged listing fields, deep nesting, quadratic renaming and the smaller hardening items.
 */

const TOOLS = ['7z', 'python3'] as const;
const SLOW_TEST_TIMEOUT_MS = 120_000;
const MIB = 1024 * 1024;
/** Depth that used to cost 19 s in the walk and leak the sandbox when removal overflowed the stack. */
const HOSTILE_DEPTH = 1000;
/** Hang guard only: the depth walk used to cost 19 s; it now takes milliseconds. */
const DEPTH_HANG_GUARD_MS = 10_000;
const DUPLICATE_COUNT = 50_000;

function file(entryPath: string, sizeBytes: number | null = 1): ListedArchiveEntry {
  return { path: entryPath, isDirectory: false, sizeBytes, linkKind: null, isSpecial: false };
}

function reasonOf(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    return (error as { reason?: string }).reason ?? `no reason: ${(error as Error).message}`;
  }
  return 'completed';
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected a typed rejection but the operation completed');
    },
    (error: unknown) => error
  );
}

function readEntry(archivePath: string, entry: string): string {
  const sevenZip = getOracleToolPath('7z');
  if (!sevenZip) throw new Error('7z is required');
  return execFileSync(sevenZip, ['x', '-so', archivePath, entry], { encoding: 'utf-8', stdio: 'pipe' });
}

describe('PR #499 review blockers', () => {
  const originalP7zipPath = process.env.P7ZIP_PATH;
  let ws: HostileWorkspace;

  beforeAll(() => {
    const sevenZip = getOracleToolPath('7z');
    if (sevenZip) {
      process.env.P7ZIP_PATH = sevenZip;
    }
  });

  afterAll(() => {
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

  function worker(archivePath: string, src: string, tgt = 'zip', outputPath?: string): Promise<WorkerConversionResult | null> {
    const inputBuffer = fs.readFileSync(archivePath);
    const input = outputPath ? { inputBuffer, outputPath } : inputBuffer;
    return ws.withTmpdir(() => convertWithNative7zWorker(input, src, tgt, {}, path.basename(archivePath)));
  }

  function lib(archivePath: string, src: string, tgt = 'zip') {
    const input = fs.readFileSync(archivePath);
    return ws.withTmpdir(async () => convertWithNative7z(input, src, tgt, {}, path.basename(archivePath)));
  }

  describe('1. single-stream wrapper formats list without a Path', () => {
    const PLAIN_SOURCES = ['bz2', 'xz'] as const;
    const TAR_SOURCES = ['tar.bz2', 'tar.xz', 'tbz2', 'txz'] as const;

    for (const src of PLAIN_SOURCES) {
      oracleTest(`converts a plain .${src} file on the worker and library routes`, [...TOOLS], async () => {
        const source = buildCompressedFile(path.join(ws.fixturesDir, `plain.txt.${src}`), 'wrapped payload');
        const workerOut = path.join(ws.fixturesDir, 'worker.zip');

        const workerResult = await worker(source, src, 'zip', workerOut);
        const libResult = await lib(source, src);
        const libOut = path.join(ws.fixturesDir, 'lib.zip');
        fs.writeFileSync(libOut, libResult!.buffer);

        expect(workerResult?.engineUsed).toBe('native-7z');
        expect(list7zEntryPaths(workerOut)).toHaveLength(1);
        expect(readEntry(workerOut, list7zEntryPaths(workerOut)[0])).toBe('wrapped payload');
        expect(list7zEntryPaths(libOut)).toHaveLength(1);
        expect(readEntry(libOut, list7zEntryPaths(libOut)[0])).toBe('wrapped payload');
      });
    }

    for (const src of TAR_SOURCES) {
      const suffix = src;
      oracleTest(`vets the tar inside a .${src} source on both routes`, [...TOOLS], async () => {
        const hostile = buildTarWithEntries(path.join(ws.fixturesDir, `link.${suffix}`), [
          { name: 'escape', kind: 'symlink', target: ws.outsideDir },
          { name: 'ok.txt', data: 'fine' },
        ]);
        const before = ws.snapshot();

        expect(await rejection(worker(hostile, src))).toMatchObject({ name: 'UnsafeArchiveError', reason: 'link-entry' });
        expect(await rejection(lib(hostile, src))).toMatchObject({ name: 'UnsafeArchiveError', reason: 'link-entry' });
        expect(ws.snapshot()).toEqual(before);
      });

      oracleTest(`still converts a benign .${src} tarball`, [...TOOLS], async () => {
        const benign = buildTarWithEntries(path.join(ws.fixturesDir, `ok.${suffix}`), [{ name: 'a.txt', data: 'alpha' }]);
        const workerOut = path.join(ws.fixturesDir, 'ok-worker.zip');

        const workerResult = await worker(benign, src, 'zip', workerOut);
        const libResult = await lib(benign, src);

        expect(workerResult?.engineUsed).toBe('native-7z');
        expect(list7zEntryPaths(workerOut)).toHaveLength(1);
        expect(libResult).not.toBeNull();
      });
    }

    it('reads a Path-less single block as the payload only when told the wrapper name', () => {
      const listing = 'Size = 6\nPacked Size = 64\nMethod = LZMA2:23 CRC64\n';

      expect(parse7zTechnicalListing(listing, { payloadName: 'input' })).toEqual([
        { path: 'input', isDirectory: false, sizeBytes: 6, linkKind: null, isSpecial: false, wrapperPayload: true },
      ]);
      expect(reasonOf(() => parse7zTechnicalListing(listing))).toBe('malformed-listing');
      expect(reasonOf(() => parse7zTechnicalListing('Size = 1\n\nSize = 2\n', { payloadName: 'input' }))).toBe(
        'malformed-listing'
      );
    });

    it('accepts a wrapper payload of unknown size but still rejects an unknown size elsewhere', () => {
      const payload = parse7zTechnicalListing('Size = \nPacked Size = \n', { payloadName: 'input' });

      expect(assertSafeArchiveListing(payload, 100, ARCHIVE_SECURITY_LIMITS)).toMatchObject({ entryCount: 1, totalBytes: 0 });
      expect(reasonOf(() => assertSafeArchiveListing([file('a', null)], 100, ARCHIVE_SECURITY_LIMITS))).toBe('malformed-listing');
    });
  });

  describe('2. directory entries are accounted for', () => {
    it('rejects a directory entry that declares data', () => {
      const directory: ListedArchiveEntry = { ...file('d', 100), isDirectory: true };

      expect(reasonOf(() => assertSafeArchiveListing([directory], 1_000, ARCHIVE_SECURITY_LIMITS))).toBe('malformed-listing');
    });

    it('counts a directory entry size toward the total cap before rejecting', () => {
      const directory: ListedArchiveEntry = { ...file('d', 600 * MIB), isDirectory: true };

      expect(reasonOf(() => assertSafeArchiveListing([directory], 600 * MIB, ARCHIVE_SECURITY_LIMITS))).toMatch(
        /uncompressed-size|malformed-listing/
      );
    });

    oracleTest('rejects a zip whose directory entry carries data, on both routes', [...TOOLS], async () => {
      const zip = buildZipWithEntries(path.join(ws.fixturesDir, 'dirdata.zip'), [
        { name: 'd/', mode: 0o040755, data: 'X'.repeat(100) },
        { name: 'ok.txt', data: 'fine' },
      ]);
      const before = ws.snapshot();

      expect(await rejection(worker(zip, 'zip'))).toMatchObject({ name: 'UnsafeArchiveError', reason: 'malformed-listing' });
      expect(await rejection(lib(zip, 'zip'))).toMatchObject({ name: 'UnsafeArchiveError', reason: 'malformed-listing' });
      expect(ws.snapshot()).toEqual(before);
    });
  });

  describe('3. listing fields cannot be forged with line breaks', () => {
    it('rejects a block that repeats a key (p7zip 16.02 prints raw newlines in comments)', () => {
      const forged =
        'Path = ln\nSize = 21\nAttributes =  lrwxrwxrwx\nComment = x\nAttributes =  -rw-r--r--\nCRC = E2C8EC86\n';

      expect(reasonOf(() => parse7zTechnicalListing(forged))).toBe('malformed-listing');
    });

    it('rejects a name that smuggles in its own Size and Folder fields', () => {
      const forgedName = 'Path = a\nSize = 1\nFolder = +\nSize = 5000\nFolder = -\n';

      expect(reasonOf(() => parse7zTechnicalListing(forgedName))).toBe('malformed-listing');
    });

    it('rejects a garbled line inside a block', () => {
      expect(reasonOf(() => parse7zTechnicalListing('Path = a\nsecond comment line\nSize = 1\n'))).toBe('malformed-listing');
    });

    it('rejects a block split off by a blank line inside a name', () => {
      const split = 'Path = a\n\nPath = z\nSize = 1\n';

      expect(reasonOf(() => assertSafeArchiveListing(parse7zTechnicalListing(split), 100, ARCHIVE_SECURITY_LIMITS))).toBe(
        'malformed-listing'
      );
    });

    it('keeps accepting ordinary listings and CR, U+2028 or U+2029 inside names', () => {
      const listing = 'Path = a b\rc d\nSize = 3\nAttributes = A -rw-r--r--\n';

      expect(parse7zTechnicalListing(listing)).toEqual([
        { path: 'a b\rc d', isDirectory: false, sizeBytes: 3, linkKind: null, isSpecial: false },
      ]);
    });

    oracleTest('refuses a zip symlink hidden behind a multi-line comment', [...TOOLS], async () => {
      const zip = buildZipWithEntries(path.join(ws.fixturesDir, 'hide.zip'), [
        { name: 'ln', mode: 0o120777, data: ws.outsideDir, comment: 'x\nAttributes =  -rw-r--r--' },
        { name: 'ok.txt', data: 'fine' },
      ]);
      const before = ws.snapshot();

      const error = await rejection(worker(zip, 'zip'));

      expect((error as { reason?: string }).reason).toMatch(/link-entry|malformed-listing/);
      expect(ws.snapshot()).toEqual(before);
    });
  });

  describe('4. deep nesting is bounded and cleaned up', () => {
    oracleTest('rejects a 1000-deep path in the listing, fast, without leaking the sandbox', [...TOOLS], async () => {
      const tar = buildDeepTar(path.join(ws.fixturesDir, 'deep.tar'), HOSTILE_DEPTH);
      const before = ws.snapshot();
      const started = performance.now();

      const workerError = await rejection(worker(tar, 'tar'));
      const libError = await rejection(lib(tar, 'tar'));

      expect(performance.now() - started).toBeLessThan(DEPTH_HANG_GUARD_MS);
      expect(workerError).toMatchObject({ name: 'UnsafeArchiveError', reason: 'path-depth' });
      expect(libError).toMatchObject({ name: 'UnsafeArchiveError', reason: 'path-depth' });
      expect(ws.snapshot()).toEqual(before);
    }, SLOW_TEST_TIMEOUT_MS);

    it('rejects a deeper-than-256 listing entry and accepts exactly 256 segments', () => {
      const atLimit = `${'d/'.repeat(255)}leaf`;

      expect(atLimit.split('/')).toHaveLength(256);
      expect(assertSafeArchiveListing([file(atLimit)], 100, ARCHIVE_SECURITY_LIMITS).entryCount).toBe(1);
      expect(reasonOf(() => assertSafeArchiveListing([file(`d/${atLimit}`)], 100, ARCHIVE_SECURITY_LIMITS))).toBe('path-depth');
    });

    it('stops a walk at the depth limit instead of descending without bound', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-depth-'));
      try {
        fs.mkdirSync(path.join(root, ...Array.from({ length: 300 }, () => 'd')), { recursive: true });
        const started = performance.now();

        expect(reasonOf(() => assertExtractionContained(root, 1_000, ARCHIVE_SECURITY_LIMITS))).toBe('path-depth');
        expect(performance.now() - started).toBeLessThan(DEPTH_HANG_GUARD_MS);
      } finally {
        removeDirectoryTree(root);
      }
    });

    it('removes a tree deeper than the recursive remover can handle', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-remove-'));
      const levels = 1900;
      // 2-character components keep the absolute path within PATH_MAX.
      const current = path.join(root, ...Array.from({ length: levels }, () => 'd'));
      fs.mkdirSync(current, { recursive: true });
      fs.writeFileSync(path.join(current, 'leaf.txt'), 'x');

      removeDirectoryTree(root);

      expect(fs.existsSync(root)).toBe(false);
    });
  });

  describe('5. renaming duplicates is linear', () => {
    it('renames 50,000 identical names in linear time with the same numbering as before', async () => {
      const duplicates = (count: number) => Array.from({ length: count }, () => ({ filename: 'a.txt', buffer: Buffer.alloc(0) }));
      const { largeResult: renamed } = await expectLinearOnInputs(
        'resolveArchiveEntryCollisions',
        (files: Array<{ filename: string; buffer: Buffer }>) => resolveArchiveEntryCollisions(files, 'rename'),
        { small: duplicates(DUPLICATE_COUNT / SCALING_FACTOR), large: duplicates(DUPLICATE_COUNT) }
      );

      expect(renamed.map((f) => f.filename).slice(0, 4)).toEqual(['a.txt', 'a-1.txt', 'a-2.txt', 'a-3.txt']);
      expect(renamed[DUPLICATE_COUNT - 1].filename).toBe(`a-${DUPLICATE_COUNT - 1}.txt`);
      expect(new Set(renamed.map((f) => f.filename)).size).toBe(DUPLICATE_COUNT);
    }, SCALING_TEST_TIMEOUT_MS);

    it('still steps over names the archive really contains', () => {
      const names = ['a.txt', 'a-1.txt', 'a.txt', 'a.txt', 'dir/a.txt', 'dir/a.txt'];

      const renamed = resolveArchiveEntryCollisions(
        names.map((filename) => ({ filename, buffer: Buffer.alloc(0) })),
        'rename'
      );

      expect(renamed.map((f) => f.filename)).toEqual(['a.txt', 'a-1.txt', 'a-2.txt', 'a-3.txt', 'dir/a.txt', 'dir/a-1.txt']);
    });
  });

  describe('6. collisions ignore dot and empty segments', () => {
    it('treats a, ./a, d//b and d/./b as the same paths', () => {
      expect(findEntryCollision([file('a'), file('./a')])).toBe('a');
      expect(findEntryCollision([file('d/b'), file('d//b')])).toBe('d/b');
      expect(findEntryCollision([file('d/b'), file('d/./b')])).toBe('d/b');
      expect(findEntryCollision([file('d/b'), file('d/c')])).toBeNull();
    });
  });

  describe('7. the entry filter is validated', () => {
    for (const bad of ['evil\0pattern', 'two\nlines', 'carriage\rreturn']) {
      oracleTest(`rejects the filter ${JSON.stringify(bad)}`, [...TOOLS], async () => {
        const zip = buildZipWithEntries(path.join(ws.fixturesDir, 'f.zip'), [{ name: 'a.txt', data: 'a' }]);
        const input = { inputBuffer: fs.readFileSync(zip) };

        const error = await rejection(
          ws.withTmpdir(() => convertWithNative7zWorker(input, 'zip', 'tar', { entries: [bad] }, 'f.zip'))
        );

        expect(error).toMatchObject({ name: 'UnsafeArchiveError', reason: 'invalid-entry-filter' });
      });
    }

    oracleTest('rejects a filter list that would overflow the command line', [...TOOLS], async () => {
      const zip = buildZipWithEntries(path.join(ws.fixturesDir, 'f.zip'), [{ name: 'a.txt', data: 'a' }]);
      const input = { inputBuffer: fs.readFileSync(zip) };
      const tooMany = Array.from({ length: 5_000 }, (_, i) => `pattern-${i}`);
      const tooLong = ['x'.repeat(200_000)];

      for (const entries of [tooMany, tooLong]) {
        const error = await rejection(
          ws.withTmpdir(() => convertWithNative7zWorker(input, 'zip', 'tar', { entries }, 'f.zip'))
        );
        expect(error).toMatchObject({ name: 'UnsafeArchiveError', reason: 'invalid-entry-filter' });
      }
    });
  });

  describe('8. spanned temp names do not use archive metadata', () => {
    oracleTest('extracts parts whose base name is longer than a file name may be', [...TOOLS], async () => {
      const tar = buildTarWithEntries(path.join(ws.fixturesDir, 'a.tar'), [{ name: 'ok.txt', data: 'fine' }]);
      const whole = fs.readFileSync(tar);
      const half = Math.ceil(whole.length / 2);
      const base = `${'n'.repeat(240)}.tar`;
      const parts = [
        { filename: `${base}.001`, buffer: whole.subarray(0, half) },
        { filename: `${base}.002`, buffer: whole.subarray(half) },
      ];
      const extractDir = path.join(ws.fixturesDir, 'spanned-out');

      const result = await ws.withTmpdir(() => extractWithSpannedStream7z(parts, extractDir, { timeoutMs: 30_000 }));

      expect(result.extractedFiles).toEqual(['ok.txt']);
      expect(fs.readFileSync(path.join(extractDir, 'ok.txt'), 'utf-8')).toBe('fine');
    });
  });

  describe('9. a missing password is reported as such', () => {
    oracleTest('names the missing password for an archive with encrypted headers', [...TOOLS], async () => {
      const archive = build7zEncrypted(
        path.join(ws.fixturesDir, 'he.7z'),
        path.join(ws.fixturesDir, 'stage-he'),
        'Secret-Pass-1',
        [{ name: 'a.txt', data: 'alpha' }],
        true
      );

      const error = await rejection(worker(archive, '7z'));

      expect(error).toMatchObject({ name: 'ArchivePasswordRequiredError' });
      expect((error as Error).message).toMatch(/password/i);
    });
  });

  describe('11. the entry cap is inclusive everywhere', () => {
    oracleTest('accepts exactly 50,000 tar entries in-process and rejects 50,001', [...TOOLS], async () => {
      const atCap = buildManyEntriesTar(path.join(ws.fixturesDir, 'at-cap.tar'), 50_000);
      const overCap = buildManyEntriesTar(path.join(ws.fixturesDir, 'over-cap.tar'), 50_001);

      const accepted = await convertArchive(fs.readFileSync(atCap), 'tar', 'zip', {}, 'at-cap.tar');
      const rejected = await rejection(convertArchive(fs.readFileSync(overCap), 'tar', 'zip', {}, 'over-cap.tar'));

      expect(accepted.filename).toBe('at-cap.zip');
      expect((rejected as Error).message).toMatch(/file count exceeds limit of 50000/);
    }, SLOW_TEST_TIMEOUT_MS);
  });
});
