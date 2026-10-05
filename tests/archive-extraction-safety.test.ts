import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  UnsafeArchiveError,
  assertExtractionContained,
  assertSafeArchiveListing,
  parse7zTechnicalListing,
  sanitizeLeafFilename,
  type ListedArchiveEntry,
} from '../src/lib/conversions/archive-extraction-safety';
import { ConversionFailedError } from '../src/lib/types';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import {
  build7zFromStagedLinks,
  buildTarWithEntries,
  buildZipWithEntries,
  createHostileWorkspace,
  type HostileWorkspace,
} from './helpers/hostile-archives';

/**
 * Unit coverage for the shared extraction-safety primitives. The thresholds below are written out
 * independently of the production constants (1000 entries, 500 MiB, 100:1), so a drift in either
 * side fails a test. Listing fixtures are parsed from the real 7z CLI's output.
 */

const LIMITS = { MAX_FILES: 1000, MAX_UNCOMPRESSED_SIZE: 500 * 1024 * 1024, MAX_RATIO: 100 };
const MIB = 1024 * 1024;

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
    const atCap = Array.from({ length: 1000 }, (_, i) => file(`f${i}.txt`));
    expect(assertSafeArchiveListing(atCap, 1000, LIMITS)).toEqual({ entryCount: 1000, totalBytes: 1000 });

    const overCap = [...atCap, file('one-more.txt')];
    expect(unsafeReason(() => assertSafeArchiveListing(overCap, 1000, LIMITS))).toBe('entry-count');
  });

  it('counts directories toward the entry cap', () => {
    const dirs = Array.from({ length: 1001 }, (_, i) => directory(`d${i}`));

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
    for (let i = 0; i < 1001; i++) {
      fs.writeFileSync(path.join(root, `f${i}.txt`), 'x');
    }

    expect(unsafeReason(() => assertExtractionContained(root, 1000, LIMITS))).toBe('entry-count');
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

  it('accepts a root reached through a symlinked parent', () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'a');
    const viaLink = path.join(path.dirname(root), 'via-link');
    fs.symlinkSync(root, viaLink);

    expect(assertExtractionContained(viaLink, 1000, LIMITS).files.map((f) => f.relPath)).toEqual(['a.txt']);
  });
});
