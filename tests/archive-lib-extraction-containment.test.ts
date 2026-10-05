import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  convertWithNative7z,
  extractWithSpannedStream7z,
  inspectArchive,
} from '../src/lib/conversions/archive';
import { ConversionFailedError } from '../src/lib/types';
import { GET as getOpenApiSpec } from '../src/app/api/openapi.json/route';
import { ConversionOptionsSchema } from '../src/lib/api/contracts/schemas';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import {
  build7zFromStagedLinks,
  build7zWithManyFiles,
  build7zZeroBomb,
  buildManyEntriesTar,
  buildManyEntriesZip,
  buildTarWithEntries,
  buildZeroBombZip,
  buildZipWithEntries,
  createHostileWorkspace,
  list7zEntryPaths,
  type HostileWorkspace,
} from './helpers/hostile-archives';

/**
 * Regression suite for the library-level 7z paths of issue #458: the synchronous convertWithNative7z,
 * extractWithSpannedStream7z and the 7z/RAR inspector. Each hostile archive is crafted by an
 * independent tool; each test asserts a typed error and, from the filesystem, that nothing was
 * written outside the extraction root.
 */

const TOOLS = ['7z', 'python3'] as const;
const SLOW_TEST_TIMEOUT_MS = 120_000;
const OVER_CAP_BOMB_MIB = 600;
const RATIO_BOMB_MIB = 3;
const OVER_CAP_ENTRY_COUNT = 50_001;

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected a typed rejection but the operation completed');
    },
    (error: unknown) => error
  );
}

function expectUnsafe(error: unknown, reason: string, messagePattern?: RegExp): void {
  expect(error).toBeInstanceOf(ConversionFailedError);
  expect(error).toMatchObject({ name: 'UnsafeArchiveError', reason });
  if (messagePattern) {
    expect((error as Error).message).toMatch(messagePattern);
  }
}

describe('library 7z paths containment (#458)', () => {
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

  describe('synchronous convertWithNative7z', () => {
    function convertSync(archivePath: string, src: string, tgt = 'zip', options = {}) {
      const input = fs.readFileSync(archivePath);
      return ws.withTmpdir(async () => convertWithNative7z(input, src, tgt, options, path.basename(archivePath)));
    }

    const HOSTILE_ZIPS: Array<[string, string, string]> = [
      ['a zip-slip entry', '../../../outside/pwned.txt', 'path-traversal'],
      ['a nested zip-slip entry', 'docs/../../../outside/pwned.txt', 'path-traversal'],
    ];

    for (const [label, entryName, reason] of HOSTILE_ZIPS) {
      oracleTest(`rejects ${label}`, [...TOOLS], async () => {
        const zip = buildZipWithEntries(path.join(ws.fixturesDir, 'slip.zip'), [
          { name: entryName, data: 'pwned' },
          { name: 'ok.txt', data: 'fine' },
        ]);
        const before = ws.snapshot();

        expectUnsafe(await rejection(convertSync(zip, 'zip')), reason);

        expect(ws.snapshot()).toEqual(before);
      });
    }

    oracleTest('rejects an absolute-path entry', [...TOOLS], async () => {
      const zip = buildZipWithEntries(path.join(ws.fixturesDir, 'abs.zip'), [
        { name: path.join(ws.outsideDir, 'abs-pwned.txt'), data: 'pwned' },
      ]);
      const before = ws.snapshot();

      expectUnsafe(await rejection(convertSync(zip, 'zip')), 'absolute-path');

      expect(ws.snapshot()).toEqual(before);
    });

    oracleTest('rejects a symlink written through, in tar and zip and 7z archives', [...TOOLS], async () => {
      const tar = buildTarWithEntries(path.join(ws.fixturesDir, 'link.tar'), [
        { name: 'link', kind: 'symlink', target: ws.outsideDir },
        { name: 'link/pwn.txt', data: 'pwned' },
      ]);
      const zip = buildZipWithEntries(path.join(ws.fixturesDir, 'link.zip'), [
        { name: 'link', mode: 0o120777, data: ws.outsideDir },
        { name: 'link/pwn.txt', data: 'pwned' },
      ]);
      const sevenZip = build7zFromStagedLinks(
        path.join(ws.fixturesDir, 'link.7z'),
        path.join(ws.fixturesDir, 'stage'),
        [{ name: 'link', target: ws.outsideDir }],
        [{ name: 'f.txt', data: 'hello' }]
      );
      const before = ws.snapshot();

      expectUnsafe(await rejection(convertSync(tar, 'tar')), 'link-entry');
      expectUnsafe(await rejection(convertSync(zip, 'zip')), 'link-entry');
      expectUnsafe(await rejection(convertSync(sevenZip, '7z')), 'link-entry');

      expect(ws.snapshot()).toEqual(before);
      expect(fs.existsSync(path.join(ws.outsideDir, 'pwn.txt'))).toBe(false);
    });

    oracleTest('rejects an in-root symlink and a hardlink', [...TOOLS], async () => {
      const inRoot = buildZipWithEntries(path.join(ws.fixturesDir, 'inner.zip'), [
        { name: 'f.txt', data: 'hello' },
        { name: 'inner', mode: 0o120777, data: 'f.txt' },
      ]);
      const hard = buildTarWithEntries(path.join(ws.fixturesDir, 'hard.tar'), [
        { name: 'a.txt', data: 'data' },
        { name: 'h.txt', kind: 'hardlink', target: 'a.txt' },
      ]);

      expectUnsafe(await rejection(convertSync(inRoot, 'zip')), 'link-entry');
      expectUnsafe(await rejection(convertSync(hard, 'tar')), 'link-entry');
    });

    oracleTest(
      'rejects a bomb over the uncompressed-size cap, a ratio bomb, and an entry-count bomb',
      [...TOOLS],
      async () => {
        const sizeBomb = buildZeroBombZip(path.join(ws.fixturesDir, 'size.zip'), OVER_CAP_BOMB_MIB);
        const ratioBomb = buildZeroBombZip(path.join(ws.fixturesDir, 'ratio.zip'), RATIO_BOMB_MIB);
        const countBomb = buildManyEntriesZip(path.join(ws.fixturesDir, 'count.zip'), OVER_CAP_ENTRY_COUNT);
        const before = ws.snapshot();

        expectUnsafe(await rejection(convertSync(sizeBomb, 'zip')), 'uncompressed-size', /Archive bomb detected: uncompressed size/);
        expectUnsafe(await rejection(convertSync(ratioBomb, 'zip')), 'compression-ratio', /compression ratio/);
        expectUnsafe(await rejection(convertSync(countBomb, 'zip')), 'entry-count', /file count/);

        expect(ws.snapshot()).toEqual(before);
      },
      SLOW_TEST_TIMEOUT_MS
    );

    oracleTest('reduces a hostile caller filename to its basename and rejects NUL', [...TOOLS], async () => {
      const outputPath = path.join(ws.fixturesDir, 'sanitized.zip');
      const before = ws.snapshot();

      const result = await ws.withTmpdir(async () =>
        convertWithNative7z(Buffer.from('hello'), 'txt', 'zip', {}, '../../../outside/escape.txt')
      );
      fs.writeFileSync(outputPath, result!.buffer);

      expect(list7zEntryPaths(outputPath)).toEqual(['escape.txt']);
      expect(ws.snapshot()).toEqual(before);
      expectUnsafe(
        await rejection(
          ws.withTmpdir(async () => convertWithNative7z(Buffer.from('hello'), 'txt', 'zip', {}, 'bad\0name.txt'))
        ),
        'unsafe-filename'
      );
    });

    for (const src of ['tar.gz', 'tgz'] as const) {
      oracleTest(`vets the tar unpacked from a ${src} source`, [...TOOLS], async () => {
        const hostile = buildTarWithEntries(path.join(ws.fixturesDir, `link.${src}`), [
          { name: 'link', kind: 'symlink', target: ws.outsideDir },
          { name: 'link/pwn.txt', data: 'pwned' },
        ]);
        const slip = buildTarWithEntries(path.join(ws.fixturesDir, `slip.${src}`), [
          { name: '../../../outside/pwned.txt', data: 'pwned' },
        ]);
        const before = ws.snapshot();

        expectUnsafe(await rejection(convertSync(hostile, src)), 'link-entry');
        expectUnsafe(await rejection(convertSync(slip, src)), 'path-traversal');

        expect(ws.snapshot()).toEqual(before);
      });
    }

    oracleTest('rejects an entry-count bomb hidden in the tar inside a tar.gz', [...TOOLS], async () => {
      const archive = buildManyEntriesTar(path.join(ws.fixturesDir, 'many.tar.gz'), OVER_CAP_ENTRY_COUNT);

      expectUnsafe(await rejection(convertSync(archive, 'tar.gz')), 'entry-count', /file count/);
    }, SLOW_TEST_TIMEOUT_MS);

    oracleTest('still unpacks a benign tar.gz into its files', [...TOOLS], async () => {
      const archive = buildTarWithEntries(path.join(ws.fixturesDir, 'benign.tar.gz'), [
        { name: 'a.txt', data: 'alpha' },
        { name: 'b.txt', data: 'bravo' },
      ]);
      const outputPath = path.join(ws.fixturesDir, 'benign.zip');

      const result = await convertSync(archive, 'tar.gz');
      fs.writeFileSync(outputPath, result!.buffer);

      expect(list7zEntryPaths(outputPath).sort()).toEqual(['a.txt', 'b.txt']);
      expect(result?.skippedLinks).toBeUndefined();
    });

    oracleTest('leaves links out and names them when skipLinks is set', [...TOOLS], async () => {
      const tar = buildTarWithEntries(path.join(ws.fixturesDir, 'skip.tar'), [
        { name: 'ok.txt', data: 'fine' },
        { name: 'sym', kind: 'symlink', target: ws.outsideDir },
      ]);
      const outputPath = path.join(ws.fixturesDir, 'skip.zip');
      const before = ws.snapshot();

      const result = await convertSync(tar, 'tar', 'zip', { skipLinks: true });
      fs.writeFileSync(outputPath, result!.buffer);

      expect(result?.skippedLinks).toEqual(['sym']);
      expect(list7zEntryPaths(outputPath)).toEqual(['ok.txt']);
      expect(ws.snapshot()).toEqual(before);
    });

    oracleTest('keeps the in-process hand-off for bytes 7-Zip cannot read', [...TOOLS], async () => {
      const result = await ws.withTmpdir(async () =>
        convertWithNative7z(Buffer.from('this is not a zip archive'), 'zip', 'tar', {}, 'bad.zip')
      );

      expect(result).toBeNull();
    });
  });

  describe('extractWithSpannedStream7z', () => {
    function splitInTwo(archivePath: string, baseName: string) {
      const whole = fs.readFileSync(archivePath);
      const half = Math.ceil(whole.length / 2);
      return [
        { filename: `${baseName}.001`, buffer: whole.subarray(0, half) },
        { filename: `${baseName}.002`, buffer: whole.subarray(half) },
      ];
    }

    function extractSpanned(parts: ReturnType<typeof splitInTwo>, options: { skipLinks?: boolean } = {}) {
      const extractDir = path.join(ws.fixturesDir, 'spanned-out');
      return ws.withTmpdir(() => extractWithSpannedStream7z(parts, extractDir, { timeoutMs: 30_000, ...options }));
    }

    oracleTest('rejects a symlink written through, a zip-slip entry, and absolute names', [...TOOLS], async () => {
      const linked = buildTarWithEntries(path.join(ws.fixturesDir, 'link.tar'), [
        { name: 'link', kind: 'symlink', target: ws.outsideDir },
        { name: 'link/pwn.txt', data: 'pwned' },
      ]);
      const slip = buildTarWithEntries(path.join(ws.fixturesDir, 'slip.tar'), [
        { name: '../../../outside/pwned.txt', data: 'pwned' },
      ]);
      const abs = buildTarWithEntries(path.join(ws.fixturesDir, 'abs.tar'), [
        { name: path.join(ws.outsideDir, 'abs-pwned.txt'), data: 'pwned' },
      ]);
      const before = ws.snapshot();

      expectUnsafe(await rejection(extractSpanned(splitInTwo(linked, 'link.tar'))), 'link-entry');
      expectUnsafe(await rejection(extractSpanned(splitInTwo(slip, 'slip.tar'))), 'path-traversal');
      expectUnsafe(await rejection(extractSpanned(splitInTwo(abs, 'abs.tar'))), 'absolute-path');

      expect(ws.snapshot()).toEqual(before);
      expect(fs.existsSync(path.join(ws.outsideDir, 'pwn.txt'))).toBe(false);
    });

    oracleTest('rejects a ratio bomb and an entry-count bomb', [...TOOLS], async () => {
      const ratioBomb = buildZeroBombZip(path.join(ws.fixturesDir, 'ratio.zip'), RATIO_BOMB_MIB);
      const countBomb = buildManyEntriesZip(path.join(ws.fixturesDir, 'count.zip'), OVER_CAP_ENTRY_COUNT);
      const before = ws.snapshot();

      expectUnsafe(await rejection(extractSpanned(splitInTwo(ratioBomb, 'ratio.zip'))), 'compression-ratio');
      expectUnsafe(await rejection(extractSpanned(splitInTwo(countBomb, 'count.zip'))), 'entry-count');

      expect(ws.snapshot()).toEqual(before);
    }, SLOW_TEST_TIMEOUT_MS);

    oracleTest('extracts a benign archive and leaves links out under skipLinks', [...TOOLS], async () => {
      const tar = buildTarWithEntries(path.join(ws.fixturesDir, 'mixed.tar'), [
        { name: 'ok.txt', data: 'fine' },
        { name: 'sym', kind: 'symlink', target: 'ok.txt' },
      ]);

      const result = await extractSpanned(splitInTwo(tar, 'mixed.tar'), { skipLinks: true });

      expect(result.extractedFiles).toEqual(['ok.txt']);
      expect(result.skippedLinks).toEqual(['sym']);
      expect(fs.readFileSync(path.join(ws.fixturesDir, 'spanned-out', 'ok.txt'), 'utf-8')).toBe('fine');
      expect(fs.existsSync(path.join(ws.fixturesDir, 'spanned-out', 'sym'))).toBe(false);
    });
  });

  describe('archive inspection through 7-Zip', () => {
    oracleTest('refuses to describe an archive that holds a symlink', [...TOOLS], async () => {
      const archive = build7zFromStagedLinks(
        path.join(ws.fixturesDir, 'link.7z'),
        path.join(ws.fixturesDir, 'stage'),
        [{ name: 'link', target: ws.outsideDir }],
        [{ name: 'f.txt', data: 'hello' }]
      );

      expectUnsafe(await rejection(inspectArchive(fs.readFileSync(archive), { filename: 'link.7z' })), 'link-entry');
    });

    oracleTest('refuses a decompression bomb and an entry flood', [...TOOLS], async () => {
      const bomb = build7zZeroBomb(path.join(ws.fixturesDir, 'bomb.7z'), path.join(ws.fixturesDir, 'stage-bomb'), OVER_CAP_BOMB_MIB);
      const flood = build7zWithManyFiles(path.join(ws.fixturesDir, 'flood.7z'), path.join(ws.fixturesDir, 'stage-flood'), OVER_CAP_ENTRY_COUNT);

      expectUnsafe(await rejection(inspectArchive(fs.readFileSync(bomb), { filename: 'bomb.7z' })), 'uncompressed-size');
      expectUnsafe(await rejection(inspectArchive(fs.readFileSync(flood), { filename: 'flood.7z' })), 'entry-count');
    }, SLOW_TEST_TIMEOUT_MS);

    oracleTest('still describes a benign 7z archive entry by entry', [...TOOLS], async () => {
      const archive = build7zFromStagedLinks(
        path.join(ws.fixturesDir, 'benign.7z'),
        path.join(ws.fixturesDir, 'stage-benign'),
        [],
        [
          { name: 'a.txt', data: 'alpha' },
          { name: 'b.txt', data: 'bravo!' },
        ]
      );

      const report = await inspectArchive(fs.readFileSync(archive), { filename: 'benign.7z' });

      expect(report.format).toBe('7z');
      expect(report.entries.map((entry) => [entry.name, entry.uncompressedSize]).sort()).toEqual([
        ['a.txt', 5],
        ['b.txt', 6],
      ]);
    });
  });

  describe('skipLinks option contract', () => {
    it('is a documented boolean conversion option, off by default', () => {
      expect(ConversionOptionsSchema.properties.skipLinks).toMatchObject({ type: 'boolean', default: false });
    });

    it('is published in the OpenAPI conversion options component', async () => {
      const spec = await (await getOpenApiSpec()).json();

      expect(spec.components.schemas.ConversionOptions.properties.skipLinks).toMatchObject({ type: 'boolean' });
    });
  });
});
