import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  NativeRenameUnsupportedError,
  UnsafeArchiveError,
  assertArchivePasswordSafe,
  assertCollisionPolicy,
  assertExclusionExact,
  assertExtractionContained,
  assertSafeArchiveListing,
  findEntryCollision,
  parse7zTechnicalListing,
  sanitizeLeafFilename,
  type ListedArchiveEntry,
} from '../src/lib/conversions/archive-extraction-safety';
import { ArchiveEntryCollisionError, ConversionFailedError, EngineUnavailableError } from '../src/lib/types';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import {
  build7zFromStagedLinks,
  buildTarWithEntries,
  buildZipWithEntries,
  createHostileWorkspace,
  type HostileWorkspace,
} from './helpers/hostile-archives';

/** Real engine, CLI or large-input work: the 5 s default fails on a loaded CI shard without any regression; 60 s only stops a hang. */
const ENGINE_TEST_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: ENGINE_TEST_TIMEOUT_MS });

/**
 * Unit coverage for the shared extraction-safety primitives. The thresholds below are written out
 * independently of the production constants (50,000 entries, 500 MiB, 100:1), so a drift in either
 * side fails a test. Listing fixtures are parsed from the real 7z CLI's output.
 */

const LIMITS = { MAX_FILES: 50_000, MAX_UNCOMPRESSED_SIZE: 500 * 1024 * 1024, MAX_RATIO: 100 };
const MIB = 1024 * 1024;
/** Hang guard only: walking 50,000 entries takes seconds; a quadratic walk takes minutes. */
const WALK_HANG_GUARD_MS = 30_000;

function file(entryPath: string, sizeBytes: number | null = 1): ListedArchiveEntry {
  return { path: entryPath, isDirectory: false, sizeBytes, linkKind: null, isSpecial: false };
}

function directory(entryPath: string): ListedArchiveEntry {
  return { path: entryPath, isDirectory: true, sizeBytes: 0, linkKind: null, isSpecial: false };
}

function unsafeReason(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(UnsafeArchiveError);
    expect(error).toBeInstanceOf(ConversionFailedError);
    return (error as UnsafeArchiveError).reason;
  }
  throw new Error('Expected an UnsafeArchiveError but the operation completed');
}

/** The name of the error an operation throws, or null when it completes. */
function thrownName(operation: () => unknown): string | null {
  try {
    operation();
    return null;
  } catch (error) {
    return error instanceof Error ? error.name : String(error);
  }
}

function list7z(archivePath: string): string {
  const sevenZip = getOracleToolPath('7z');
  if (!sevenZip) throw new Error('7z is required');
  return execFileSync(sevenZip, ['l', '-slt', '-ba', archivePath], { encoding: 'utf-8', stdio: 'pipe' });
}

describe('parse7zTechnicalListing against the real 7z CLI', () => {
  let ws: HostileWorkspace;

  beforeEach(() => {
    ws = createHostileWorkspace();
  });

  afterEach(() => {
    ws.cleanup();
  });

  oracleTest('classifies zip directories, files and unix symlinks', ['7z', 'python3'], () => {
    const zip = buildZipWithEntries(path.join(ws.fixturesDir, 'mixed.zip'), [
      { name: 'docs/', mode: 0o040755 },
      { name: 'docs/a.txt', data: 'hello' },
      { name: 'link', mode: 0o120777, data: 'docs/a.txt' },
    ]);

    const entries = parse7zTechnicalListing(list7z(zip));

    expect(entries).toEqual([
      { path: 'docs', isDirectory: true, sizeBytes: 0, linkKind: null, isSpecial: false },
      { path: 'docs/a.txt', isDirectory: false, sizeBytes: 5, linkKind: null, isSpecial: false },
      { path: 'link', isDirectory: false, sizeBytes: 10, linkKind: 'symlink', isSpecial: false },
    ]);
  });

  oracleTest('reports tar symlink, hardlink and FIFO entries', ['7z', 'python3'], () => {
    const tar = buildTarWithEntries(path.join(ws.fixturesDir, 'links.tar'), [
      { name: 'a.txt', data: 'data' },
      { name: 'sym', kind: 'symlink', target: 'a.txt' },
      { name: 'hard', kind: 'hardlink', target: 'a.txt' },
      { name: 'pipe', kind: 'fifo' },
    ]);

    const byPath = new Map(parse7zTechnicalListing(list7z(tar)).map((entry) => [entry.path, entry]));

    expect(byPath.get('a.txt')).toMatchObject({ linkKind: null, isSpecial: false, sizeBytes: 4 });
    expect(byPath.get('sym')).toMatchObject({ linkKind: 'symlink' });
    expect(byPath.get('hard')).toMatchObject({ linkKind: 'hardlink' });
    expect(byPath.get('pipe')).toMatchObject({ isSpecial: true });
  });

  oracleTest('reports a symlink stored in a 7z archive', ['7z', 'python3'], () => {
    const archive = build7zFromStagedLinks(
      path.join(ws.fixturesDir, 'link.7z'),
      path.join(ws.fixturesDir, 'stage'),
      [{ name: 'inner', target: 'f.txt' }],
      [{ name: 'f.txt', data: 'hello' }]
    );

    const byPath = new Map(parse7zTechnicalListing(list7z(archive)).map((entry) => [entry.path, entry]));

    expect(byPath.get('f.txt')).toMatchObject({ linkKind: null, sizeBytes: 5 });
    expect(byPath.get('inner')).toMatchObject({ linkKind: 'symlink' });
  });

  oracleTest('keeps hostile names verbatim so the policy can reject them', ['7z', 'python3'], () => {
    const zip = buildZipWithEntries(path.join(ws.fixturesDir, 'names.zip'), [
      { name: '../../evil.txt', data: 'x' },
      { name: '/abs/evil.txt', data: 'x' },
    ]);

    expect(parse7zTechnicalListing(list7z(zip)).map((entry) => entry.path)).toEqual(['../../evil.txt', '/abs/evil.txt']);
  });

  it('returns no entries for an empty listing', () => {
    expect(parse7zTechnicalListing('')).toEqual([]);
  });

  it('decodes a unix symlink written as a hex attribute', () => {
    const listing = 'Path = hexlink\nSize = 4\nAttributes = V A1FF0000\n';

    expect(parse7zTechnicalListing(listing)).toEqual([
      { path: 'hexlink', isDirectory: false, sizeBytes: 4, linkKind: 'symlink', isSpecial: false },
    ]);
  });

  it('treats a Windows reparse point attribute as a link', () => {
    const listing = 'Path = junction\nSize = 0\nAttributes = DL\n';

    expect(parse7zTechnicalListing(listing)[0]).toMatchObject({ path: 'junction', linkKind: 'symlink', isDirectory: true });
  });

  it('fails closed on a line that is not a key/value pair', () => {
    expect(unsafeReason(() => parse7zTechnicalListing('Path = a\nthis is not a field\n'))).toBe('malformed-listing');
  });

  it('fails closed on an entry without a path', () => {
    expect(unsafeReason(() => parse7zTechnicalListing('Size = 3\nAttributes = A\n'))).toBe('malformed-listing');
  });
});

describe('assertSafeArchiveListing', () => {
  it('accepts exactly the entry-count cap and rejects one more', () => {
    const atCap = Array.from({ length: 50_000 }, (_, i) => file(`f${i}.txt`));
    expect(assertSafeArchiveListing(atCap, 50_000, LIMITS)).toEqual({
      entryCount: 50_000,
      totalBytes: 50_000,
      skippedLinks: [],
    });

    const overCap = [...atCap, file('one-more.txt')];
    expect(unsafeReason(() => assertSafeArchiveListing(overCap, 50_000, LIMITS))).toBe('entry-count');
  });

  it('counts directories toward the entry cap', () => {
    const dirs = Array.from({ length: 50_001 }, (_, i) => directory(`d${i}`));

    expect(unsafeReason(() => assertSafeArchiveListing(dirs, 1000, LIMITS))).toBe('entry-count');
  });

  it('accepts exactly the uncompressed-size cap and rejects one more byte', () => {
    const archiveBytes = 500 * MIB; // 1:1, so only the size cap can fire
    expect(assertSafeArchiveListing([file('a.bin', 500 * MIB)], archiveBytes, LIMITS).totalBytes).toBe(500 * MIB);

    expect(unsafeReason(() => assertSafeArchiveListing([file('a.bin', 500 * MIB + 1)], archiveBytes, LIMITS))).toBe(
      'uncompressed-size'
    );
  });

  it('sums sizes across entries', () => {
    const entries = [file('a', 300 * MIB), file('b', 201 * MIB)];

    expect(unsafeReason(() => assertSafeArchiveListing(entries, 501 * MIB, LIMITS))).toBe('uncompressed-size');
  });

  it('accepts exactly 100:1 and rejects anything above it', () => {
    expect(assertSafeArchiveListing([file('a', 100_000)], 1000, LIMITS).totalBytes).toBe(100_000);

    expect(unsafeReason(() => assertSafeArchiveListing([file('a', 100_001)], 1000, LIMITS))).toBe('compression-ratio');
  });

  it('rejects a file entry whose size the listing does not state', () => {
    expect(unsafeReason(() => assertSafeArchiveListing([file('a', null)], 1000, LIMITS))).toBe('malformed-listing');
  });

  it('ignores the size of directory entries', () => {
    expect(assertSafeArchiveListing([directory('d'), file('d/a', 10)], 1000, LIMITS)).toEqual({
      entryCount: 2,
      totalBytes: 10,
      skippedLinks: [],
    });
  });

  const REJECTED_NAMES: Array<[string, string]> = [
    ['../evil', 'path-traversal'],
    ['a/../../evil', 'path-traversal'],
    ['a/b/..', 'path-traversal'],
    ['..\\evil', 'path-traversal'],
    ['a\\..\\..\\evil', 'path-traversal'],
    ['/etc/passwd', 'absolute-path'],
    ['\\windows\\evil', 'absolute-path'],
    ['C:\\Windows\\evil', 'absolute-path'],
    ['c:/evil', 'absolute-path'],
    ['', 'invalid-entry-name'],
    ['bad\0name', 'invalid-entry-name'],
  ];

  for (const [name, reason] of REJECTED_NAMES) {
    it(`rejects the entry name ${JSON.stringify(name)} as ${reason}`, () => {
      expect(unsafeReason(() => assertSafeArchiveListing([file(name)], 1000, LIMITS))).toBe(reason);
    });
  }

  for (const name of ['a..b/c.txt', '..hidden', 'dir/..hidden', 'a/./b', 'dir//file', 'name with spaces.txt', 'ünïcode/日本語.txt']) {
    it(`accepts the entry name ${JSON.stringify(name)}`, () => {
      expect(assertSafeArchiveListing([file(name)], 1000, LIMITS).entryCount).toBe(1);
    });
  }

  it('rejects link and special entries before looking at sizes', () => {
    const symlink: ListedArchiveEntry = { ...file('l'), linkKind: 'symlink' };
    const hardlink: ListedArchiveEntry = { ...file('h'), linkKind: 'hardlink' };
    const fifo: ListedArchiveEntry = { ...file('p'), isSpecial: true };

    expect(unsafeReason(() => assertSafeArchiveListing([symlink], 1000, LIMITS))).toBe('link-entry');
    expect(unsafeReason(() => assertSafeArchiveListing([hardlink], 1000, LIMITS))).toBe('link-entry');
    expect(unsafeReason(() => assertSafeArchiveListing([fifo], 1000, LIMITS))).toBe('special-entry');
  });
});

describe('assertSafeArchiveListing with skipLinks', () => {
  const symlink = (entryPath: string): ListedArchiveEntry => ({ ...file(entryPath, 10), linkKind: 'symlink' });
  const hardlink = (entryPath: string): ListedArchiveEntry => ({ ...file(entryPath, 0), linkKind: 'hardlink' });

  it('lets link entries pass, names them in listing order, and leaves their size out of the total', () => {
    const entries = [file('a.txt', 5), symlink('s'), hardlink('h'), file('b.txt', 7)];

    expect(assertSafeArchiveListing(entries, 100, LIMITS, { skipLinks: true })).toEqual({
      entryCount: 4,
      totalBytes: 12,
      skippedLinks: ['s', 'h'],
    });
  });

  it('rejects the same listing without the option', () => {
    expect(unsafeReason(() => assertSafeArchiveListing([symlink('s')], 100, LIMITS))).toBe('link-entry');
  });

  it('still rejects traversal and special entries', () => {
    expect(unsafeReason(() => assertSafeArchiveListing([symlink('../s')], 100, LIMITS, { skipLinks: true }))).toBe(
      'path-traversal'
    );
    const fifo: ListedArchiveEntry = { ...file('p'), isSpecial: true };
    expect(unsafeReason(() => assertSafeArchiveListing([fifo], 100, LIMITS, { skipLinks: true }))).toBe('special-entry');
  });

  it('refuses to skip a link whose name holds an exclusion wildcard', () => {
    expect(unsafeReason(() => assertSafeArchiveListing([symlink('we*ird')], 100, LIMITS, { skipLinks: true }))).toBe(
      'link-entry'
    );
    expect(unsafeReason(() => assertSafeArchiveListing([symlink('q?')], 100, LIMITS, { skipLinks: true }))).toBe('link-entry');
  });

  it('refuses to skip a link that shares its path with a regular entry', () => {
    const entries = [file('same', 3), symlink('same')];

    expect(unsafeReason(() => assertSafeArchiveListing(entries, 100, LIMITS, { skipLinks: true }))).toBe('link-entry');
  });
});

describe('assertExclusionExact', () => {
  it('accepts a filtered listing that lost only the links', () => {
    const full = [file('a'), { ...file('s'), linkKind: 'symlink' as const }, file('b')];

    expect(thrownName(() => assertExclusionExact(full, [file('a'), file('b')]))).toBeNull();
  });

  it('rejects a filtered listing that also lost a regular entry', () => {
    const full = [file('a'), { ...file('s'), linkKind: 'symlink' as const }, file('s/inner')];

    expect(unsafeReason(() => assertExclusionExact(full, [file('a')]))).toBe('link-entry');
  });

  it('rejects a filtered listing that kept a link', () => {
    const full = [file('a'), { ...file('s'), linkKind: 'symlink' as const }];

    expect(unsafeReason(() => assertExclusionExact(full, [file('a'), file('s')]))).toBe('link-entry');
  });
});

describe('entry collisions', () => {
  it('finds no collision among distinct paths', () => {
    expect(findEntryCollision([file('a'), file('b'), file('dir/a')])).toBeNull();
  });

  it('finds the first path that two entries share', () => {
    expect(findEntryCollision([file('x'), file('a.txt'), file('a.txt')])).toBe('a.txt');
    expect(findEntryCollision([file('x'), file('a.txt'), file('y'), file('a.txt'), file('x')])).toBe('x');
  });

  it('treats a directory entry and a file with the same path as one collision', () => {
    expect(findEntryCollision([directory('d/'), file('d')])).toBe('d');
    expect(findEntryCollision([file('d'), directory('d')])).toBe('d');
  });

  it('does not count repeated directory entries, nor link entries that are being skipped', () => {
    expect(findEntryCollision([directory('d'), directory('d/')])).toBeNull();
    expect(findEntryCollision([file('a'), { ...file('a'), linkKind: 'symlink' }])).toBeNull();
  });

  it("rejects under 'error' with the collision error (HTTP 422) naming the path", () => {
    try {
      assertCollisionPolicy([file('a.txt'), file('a.txt')], 'error');
      throw new Error('expected a collision error');
    } catch (error) {
      expect(error).toBeInstanceOf(ArchiveEntryCollisionError);
      expect((error as ArchiveEntryCollisionError).status).toBe(422);
      expect((error as Error).message).toBe("Archive entry collision detected for 'a.txt' under collision policy 'error'.");
    }
  });

  it("hands duplicates to another engine under 'rename', which is also the default", () => {
    for (const policy of ['rename', undefined] as const) {
      try {
        assertCollisionPolicy([file('a.txt'), file('a.txt')], policy);
        throw new Error('expected the native engine to decline');
      } catch (error) {
        expect(error).toBeInstanceOf(NativeRenameUnsupportedError);
        expect(error).toBeInstanceOf(EngineUnavailableError);
        expect(error).toMatchObject({ engineName: '7z' });
      }
    }
  });

  it("accepts duplicates under 'overwrite' and accepts any policy without duplicates", () => {
    expect(thrownName(() => assertCollisionPolicy([file('a.txt'), file('a.txt')], 'overwrite'))).toBeNull();
    for (const policy of ['rename', 'error', 'overwrite'] as const) {
      expect(thrownName(() => assertCollisionPolicy([file('a'), file('b')], policy))).toBeNull();
    }
  });
});

describe('assertArchivePasswordSafe', () => {
  for (const password of ['a\nb', 'a\rb', 'a\0b']) {
    it(`rejects ${JSON.stringify(password)}`, () => {
      expect(() => assertArchivePasswordSafe(password)).toThrow('Archive password contains invalid newline or null characters.');
    });
  }

  it('accepts ordinary passwords and the absence of one', () => {
    expect(thrownName(() => assertArchivePasswordSafe('correct horse battery staple ünï'))).toBeNull();
    expect(thrownName(() => assertArchivePasswordSafe(undefined))).toBeNull();
  });
});

describe('sanitizeLeafFilename', () => {
  const CASES: Array<[string, string]> = [
    ['report.pdf', 'report.pdf'],
    ['../../escape.txt', 'escape.txt'],
    ['/etc/cron.d/job', 'job'],
    ['dir/sub/file.tar.gz', 'file.tar.gz'],
    ['..\\..\\win.txt', 'win.txt'],
    ['C:\\Users\\me\\doc.txt', 'doc.txt'],
    ['trailing/', 'trailing'],
    ['..hidden', '..hidden'],
    ['日本語.txt', '日本語.txt'],
  ];

  for (const [input, expected] of CASES) {
    it(`reduces ${JSON.stringify(input)} to ${JSON.stringify(expected)}`, () => {
      expect(sanitizeLeafFilename(input)).toBe(expected);
    });
  }

  for (const input of ['', '.', '..', '/', 'a/..', 'bad\0name', `${'x'.repeat(256)}.txt`]) {
    it(`rejects ${JSON.stringify(input.length > 40 ? `${input.slice(0, 10)}...(${input.length} chars)` : input)}`, () => {
      expect(unsafeReason(() => sanitizeLeafFilename(input))).toBe('unsafe-filename');
    });
  }
});

describe('assertExtractionContained', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-contained-'));
    root = path.join(base, 'root');
    outside = path.join(base, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside secret');
  });

  afterEach(() => {
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
  });

  it('returns every regular file with its relative path and size', () => {
    fs.mkdirSync(path.join(root, 'docs', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(root, 'top.txt'), 'top');
    fs.writeFileSync(path.join(root, 'docs', 'a.txt'), 'alpha');
    fs.writeFileSync(path.join(root, 'docs', 'deep', 'b.txt'), 'bravo!');

    const tree = assertExtractionContained(root, 1000, LIMITS);

    expect(tree.files.map((f) => [f.relPath, f.sizeBytes])).toEqual([
      ['docs/a.txt', 5],
      ['docs/deep/b.txt', 6],
      ['top.txt', 3],
    ]);
    expect(tree.entryCount).toBe(5);
    expect(tree.totalBytes).toBe(14);
    expect(fs.readFileSync(tree.files[1].absPath, 'utf-8')).toBe('bravo!');
  });

  it('rejects a symlink to a file outside the root without reading through it', () => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'));

    expect(unsafeReason(() => assertExtractionContained(root, 1000, LIMITS))).toBe('link-entry');
  });

  it('rejects a symlink to a directory outside the root without descending into it', () => {
    fs.symlinkSync(outside, path.join(root, 'out'));

    expect(unsafeReason(() => assertExtractionContained(root, 1000, LIMITS))).toBe('link-entry');
  });

  it('rejects a symlink that stays inside the root', () => {
    fs.writeFileSync(path.join(root, 'real.txt'), 'real');
    fs.symlinkSync('real.txt', path.join(root, 'alias.txt'));

    expect(unsafeReason(() => assertExtractionContained(root, 1000, LIMITS))).toBe('link-entry');
  });

  it('rejects a dangling symlink', () => {
    fs.symlinkSync('does-not-exist', path.join(root, 'dangling'));

    expect(unsafeReason(() => assertExtractionContained(root, 1000, LIMITS))).toBe('link-entry');
  });

  it('rejects a hard link', () => {
    fs.writeFileSync(path.join(root, 'real.txt'), 'real');
    fs.linkSync(path.join(root, 'real.txt'), path.join(root, 'hard.txt'));

    expect(unsafeReason(() => assertExtractionContained(root, 1000, LIMITS))).toBe('link-entry');
  });

  it.skipIf(!fs.existsSync('/usr/bin/mkfifo'))('rejects a FIFO', () => {
    execFileSync('/usr/bin/mkfifo', [path.join(root, 'pipe')]);

    expect(unsafeReason(() => assertExtractionContained(root, 1000, LIMITS))).toBe('special-entry');
  });

  it('rejects more entries than the cap', () => {
    for (let i = 0; i < 50_001; i++) {
      fs.writeFileSync(path.join(root, `f${i}.txt`), 'x');
    }

    expect(unsafeReason(() => assertExtractionContained(root, 50_001, LIMITS))).toBe('entry-count');
  });

  it('rejects output over the size cap even when the listing claimed less', () => {
    const big = path.join(root, 'big.bin');
    fs.closeSync(fs.openSync(big, 'w'));
    fs.truncateSync(big, 500 * MIB + 1);

    expect(unsafeReason(() => assertExtractionContained(root, 500 * MIB, LIMITS))).toBe('uncompressed-size');
  });

  it('rejects output whose size is more than 100 times the archive', () => {
    const sparse = path.join(root, 'sparse.bin');
    fs.closeSync(fs.openSync(sparse, 'w'));
    fs.truncateSync(sparse, MIB);

    expect(unsafeReason(() => assertExtractionContained(root, 1000, LIMITS))).toBe('compression-ratio');
  });

  it('accepts exactly the entry cap of files within a reasonable time', () => {
    const fanOut = 100;
    for (let dir = 0; dir < fanOut; dir++) {
      const dirPath = path.join(root, `d${dir}`);
      fs.mkdirSync(dirPath);
      for (let i = 0; i < 499; i++) {
        fs.writeFileSync(path.join(dirPath, `f${i}`), '');
      }
    }
    // 100 directories + 100 * 499 files = 50,000 entries, the cap.
    const started = performance.now();

    const tree = assertExtractionContained(root, 50_000, LIMITS);

    expect(performance.now() - started).toBeLessThan(WALK_HANG_GUARD_MS);
    expect(tree.entryCount).toBe(50_000);
    expect(tree.files).toHaveLength(49_900);
  }, 60_000);

  it('accepts a root reached through a symlinked parent', () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'a');
    const viaLink = path.join(path.dirname(root), 'via-link');
    fs.symlinkSync(root, viaLink);

    expect(assertExtractionContained(viaLink, 1000, LIMITS).files.map((f) => f.relPath)).toEqual(['a.txt']);
  });
});
