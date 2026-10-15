import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { convertWithNative7z, executeWorkerConversion, type WorkerConversionResult } from '../src/worker/engines';
import { ConversionFailedError } from '../src/lib/types';
import { getOracleToolPath } from './helpers/differential-oracle';
import { withMissingBinary } from './helpers/native-tools';
import { oracleTest } from './helpers/oracle-test';
import {
  build7zFromStagedLinks,
  buildManyEntriesTar,
  buildManyEntriesZip,
  buildTarWithEntries,
  buildZeroBombZip,
  buildZipWithEntries,
  createHostileWorkspace,
  list7zEntryPaths,
  type HostileWorkspace,
} from './helpers/hostile-archives';

/** Real engine, CLI or large-input work: the 5 s default fails on a loaded CI shard without any regression; 60 s only stops a hang. */
const ENGINE_TEST_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: ENGINE_TEST_TIMEOUT_MS });

/**
 * Regression suite for the worker 7z route (GitHub issue #458). Every hostile archive is crafted by
 * an independent tool (7z, Python zipfile/tarfile, ln -s) and every test asserts both a typed error
 * and, from the filesystem, that nothing was written outside the extraction root.
 */

const TOOLS = ['7z', 'python3'] as const;
const SLOW_TEST_TIMEOUT_MS = 120_000;
/** Above the 500 MiB uncompressed-size cap; DEFLATE shrinks zeros to well under 1 MiB. */
const OVER_CAP_BOMB_MIB = 600;
/** The bomb must stay a tiny file, orders of magnitude below its uncompressed size. */
const MAX_BOMB_ARCHIVE_BYTES = 8 * 1024 * 1024;
/** Below the size cap yet far above the 100:1 ratio cap. */
const RATIO_BOMB_MIB = 3;
/** One above the 50,000-entry cap. */
const OVER_CAP_ENTRY_COUNT = 50_001;
const AT_CAP_ENTRY_COUNT = 50_000;
/** Generous bound for converting a 50,000-entry archive end to end (about 13 s measured). */
const ENTRY_CAP_HANG_GUARD_MS = 90_000;

interface Outcome {
  ok: boolean;
  value?: WorkerConversionResult | null;
  error?: unknown;
}

async function settle(promise: Promise<WorkerConversionResult | null>): Promise<Outcome> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error })
  );
}

async function expectRejection(
  promise: Promise<WorkerConversionResult | null>,
  expected: { name: string; reason?: string },
  messagePattern?: RegExp
): Promise<void> {
  const outcome = await settle(promise);
  if (outcome.ok) {
    throw new Error(
      `Expected ${expected.name} but the conversion completed with ${outcome.value === null ? 'null' : 'a result'}`
    );
  }
  expect(outcome.error).toBeInstanceOf(ConversionFailedError);
  expect(outcome.error).toMatchObject(expected);
  if (messagePattern) {
    expect((outcome.error as Error).message).toMatch(messagePattern);
  }
}

describe('worker 7z route extraction containment (#458)', () => {
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

  /** Converts through the worker route; `outputPath` asks the engine to persist the result there. */
  function convert(
    archivePath: string,
    src: string,
    tgt = 'tar',
    outputPath?: string
  ): Promise<WorkerConversionResult | null> {
    const inputBuffer = fs.readFileSync(archivePath);
    const input = outputPath ? { inputBuffer, outputPath } : inputBuffer;
    return ws.withTmpdir(() => convertWithNative7z(input, src, tgt, {}, path.basename(archivePath)));
  }

  describe('path traversal and absolute entries', () => {
    const TRAVERSAL_NAMES = [
      '../../evil.txt',
      '../../../outside/pwned.txt',
      'docs/../../../outside/pwned.txt',
      '..\\..\\..\\outside\\pwned.txt',
    ];

    for (const entryName of TRAVERSAL_NAMES) {
      oracleTest(`rejects the zip-slip entry ${JSON.stringify(entryName)} and writes nothing outside the root`, [...TOOLS], async () => {
        const zip = buildZipWithEntries(path.join(ws.fixturesDir, 'slip.zip'), [
          { name: entryName, data: 'pwned' },
          { name: 'ok.txt', data: 'fine' },
        ]);
        const before = ws.snapshot();

        await expectRejection(convert(zip, 'zip'), { name: 'UnsafeArchiveError', reason: 'path-traversal' });

        expect(ws.snapshot()).toEqual(before);
        expect(fs.readdirSync(ws.outsideDir)).toEqual(['canary.txt']);
      });
    }

    oracleTest('rejects a zip-slip entry inside a tar archive', [...TOOLS], async () => {
      const tar = buildTarWithEntries(path.join(ws.fixturesDir, 'slip.tar'), [
        { name: '../../../outside/pwned.txt', data: 'pwned' },
        { name: 'ok.txt', data: 'fine' },
      ]);
      const before = ws.snapshot();

      await expectRejection(convert(tar, 'tar'), { name: 'UnsafeArchiveError', reason: 'path-traversal' });

      expect(ws.snapshot()).toEqual(before);
    });

    oracleTest('rejects an absolute-path entry that targets a directory outside the root', [...TOOLS], async () => {
      const zip = buildZipWithEntries(path.join(ws.fixturesDir, 'abs.zip'), [
        { name: path.join(ws.outsideDir, 'abs-pwned.txt'), data: 'pwned' },
        { name: 'ok.txt', data: 'fine' },
      ]);
      const before = ws.snapshot();

      await expectRejection(convert(zip, 'zip'), { name: 'UnsafeArchiveError', reason: 'absolute-path' });

      expect(ws.snapshot()).toEqual(before);
      expect(fs.existsSync(path.join(ws.outsideDir, 'abs-pwned.txt'))).toBe(false);
    });

    oracleTest('rejects a drive-letter entry name', [...TOOLS], async () => {
      const zip = buildZipWithEntries(path.join(ws.fixturesDir, 'drive.zip'), [
        { name: 'C:/Windows/evil.txt', data: 'pwned' },
      ]);
      const before = ws.snapshot();

      await expectRejection(convert(zip, 'zip'), { name: 'UnsafeArchiveError', reason: 'absolute-path' });

      expect(ws.snapshot()).toEqual(before);
    });
  });

  describe('symlink and hardlink entries', () => {
    oracleTest('rejects a tar symlink pointing outside the root followed by a file written through it', [...TOOLS], async () => {
      const tar = buildTarWithEntries(path.join(ws.fixturesDir, 'through-link.tar'), [
        { name: 'link', kind: 'symlink', target: ws.outsideDir },
        { name: 'link/pwn.txt', data: 'pwned' },
        { name: 'ok.txt', data: 'fine' },
      ]);
      const before = ws.snapshot();

      await expectRejection(convert(tar, 'tar'), { name: 'UnsafeArchiveError', reason: 'link-entry' });

      expect(ws.snapshot()).toEqual(before);
      expect(fs.existsSync(path.join(ws.outsideDir, 'pwn.txt'))).toBe(false);
    });

    oracleTest('rejects a zip symlink pointing outside the root followed by a file written through it', [...TOOLS], async () => {
      const zip = buildZipWithEntries(path.join(ws.fixturesDir, 'through-link.zip'), [
        { name: 'link', mode: 0o120777, data: ws.outsideDir },
        { name: 'link/pwn.txt', data: 'pwned' },
      ]);
      const before = ws.snapshot();

      await expectRejection(convert(zip, 'zip'), { name: 'UnsafeArchiveError', reason: 'link-entry' });

      expect(ws.snapshot()).toEqual(before);
      expect(fs.existsSync(path.join(ws.outsideDir, 'pwn.txt'))).toBe(false);
    });

    oracleTest('rejects a 7z archive that stores a symlink to a directory outside the root', [...TOOLS], async () => {
      const archive = build7zFromStagedLinks(
        path.join(ws.fixturesDir, 'link.7z'),
        path.join(ws.fixturesDir, 'stage-escape'),
        [{ name: 'link', target: ws.outsideDir }],
        [{ name: 'f.txt', data: 'hello' }]
      );
      const before = ws.snapshot();

      await expectRejection(convert(archive, '7z'), { name: 'UnsafeArchiveError', reason: 'link-entry' });

      expect(ws.snapshot()).toEqual(before);
    });

    oracleTest('rejects a 7z archive whose symlink stays inside the root', [...TOOLS], async () => {
      const archive = build7zFromStagedLinks(
        path.join(ws.fixturesDir, 'inner-link.7z'),
        path.join(ws.fixturesDir, 'stage-inner'),
        [{ name: 'inner', target: 'f.txt' }],
        [{ name: 'f.txt', data: 'hello' }]
      );
      const before = ws.snapshot();

      await expectRejection(convert(archive, '7z'), { name: 'UnsafeArchiveError', reason: 'link-entry' });

      expect(ws.snapshot()).toEqual(before);
    });

    oracleTest('rejects a zip symlink whose target stays inside the root', [...TOOLS], async () => {
      const zip = buildZipWithEntries(path.join(ws.fixturesDir, 'inner-link.zip'), [
        { name: 'f.txt', data: 'hello' },
        { name: 'inner', mode: 0o120777, data: 'f.txt' },
      ]);
      const before = ws.snapshot();

      await expectRejection(convert(zip, 'zip'), { name: 'UnsafeArchiveError', reason: 'link-entry' });

      expect(ws.snapshot()).toEqual(before);
    });

    oracleTest('rejects a tar hardlink entry', [...TOOLS], async () => {
      const tar = buildTarWithEntries(path.join(ws.fixturesDir, 'hard.tar'), [
        { name: 'a.txt', data: 'data' },
        { name: 'h.txt', kind: 'hardlink', target: 'a.txt' },
      ]);
      const before = ws.snapshot();

      await expectRejection(convert(tar, 'tar'), { name: 'UnsafeArchiveError', reason: 'link-entry' });

      expect(ws.snapshot()).toEqual(before);
    });

    oracleTest('rejects a symlink inside a spanned (multi-volume) archive', [...TOOLS], async () => {
      const tarPath = buildTarWithEntries(path.join(ws.fixturesDir, 'spanned.tar'), [
        { name: 'link', kind: 'symlink', target: ws.outsideDir },
        { name: 'link/pwn.txt', data: 'pwned' },
      ]);
      const whole = fs.readFileSync(tarPath);
      const half = Math.ceil(whole.length / 2);
      const archiveParts = [
        { filename: 'spanned.tar.001', buffer: whole.subarray(0, half) },
        { filename: 'spanned.tar.002', buffer: whole.subarray(half) },
      ];
      const before = ws.snapshot();

      await expectRejection(
        ws.withTmpdir(() => convertWithNative7z(archiveParts[0].buffer, 'tar', 'zip', { archiveParts }, 'spanned.tar.001')),
        { name: 'UnsafeArchiveError', reason: 'link-entry' }
      );

      expect(ws.snapshot()).toEqual(before);
      expect(fs.existsSync(path.join(ws.outsideDir, 'pwn.txt'))).toBe(false);
    });
  });

  describe('decompression bombs', () => {
    oracleTest(
      'rejects a highly compressible archive over the uncompressed-size cap before extracting it',
      [...TOOLS],
      async () => {
        const zip = buildZeroBombZip(path.join(ws.fixturesDir, 'bomb.zip'), OVER_CAP_BOMB_MIB);
        expect(fs.statSync(zip).size).toBeLessThan(MAX_BOMB_ARCHIVE_BYTES);
        const before = ws.snapshot();

        await expectRejection(
          convert(zip, 'zip'),
          { name: 'UnsafeArchiveError', reason: 'uncompressed-size' },
          /Archive bomb detected: uncompressed size exceeds limit/
        );

        expect(ws.snapshot()).toEqual(before);
      },
      SLOW_TEST_TIMEOUT_MS
    );

    oracleTest('rejects an archive under the size cap whose compression ratio exceeds 100:1', [...TOOLS], async () => {
      const zip = buildZeroBombZip(path.join(ws.fixturesDir, 'ratio.zip'), RATIO_BOMB_MIB);
      const before = ws.snapshot();

      await expectRejection(
        convert(zip, 'zip'),
        { name: 'UnsafeArchiveError', reason: 'compression-ratio' },
        /Archive bomb detected: compression ratio .* exceeds 100:1 limit/
      );

      expect(ws.snapshot()).toEqual(before);
    });

    oracleTest('rejects an archive holding more entries than the file-count cap', [...TOOLS], async () => {
      const zip = buildManyEntriesZip(path.join(ws.fixturesDir, 'many.zip'), OVER_CAP_ENTRY_COUNT);
      const before = ws.snapshot();

      await expectRejection(
        convert(zip, 'zip'),
        { name: 'UnsafeArchiveError', reason: 'entry-count' },
        /Archive bomb detected: file count/
      );

      expect(ws.snapshot()).toEqual(before);
    });

    oracleTest('accepts an archive holding exactly the file-count cap', [...TOOLS], async () => {
      const zip = buildManyEntriesZip(path.join(ws.fixturesDir, 'at-cap.zip'), AT_CAP_ENTRY_COUNT);
      const outputPath = path.join(ws.fixturesDir, 'at-cap.tar');
      const started = performance.now();

      const result = await convert(zip, 'zip', 'tar', outputPath);

      expect(performance.now() - started).toBeLessThan(ENTRY_CAP_HANG_GUARD_MS);

      expect(result?.engineUsed).toBe('native-7z');
      const expectedNames = Array.from({ length: AT_CAP_ENTRY_COUNT }, (_, i) => `f${String(i).padStart(5, '0')}.txt`);
      expect(list7zEntryPaths(outputPath).sort()).toEqual(expectedNames);
    }, SLOW_TEST_TIMEOUT_MS);
  });

  describe('caller-supplied filenames', () => {
    function readSingleEntry(archivePath: string, entryName: string): string {
      const sevenZip = getOracleToolPath('7z');
      if (!sevenZip) throw new Error('7z is required to read the output archive');
      return execFileSync(sevenZip, ['x', '-so', archivePath, entryName], { encoding: 'utf-8', stdio: 'pipe' });
    }

    const SANITIZED_NAMES: Array<[string, string]> = [
      ['../../escape.txt', 'escape.txt'],
      ['../../../outside/escape.txt', 'escape.txt'],
      ['/etc/cron.d/escape.txt', 'escape.txt'],
      ['..\\..\\escape.txt', 'escape.txt'],
    ];

    for (const [supplied, leaf] of SANITIZED_NAMES) {
      oracleTest(`reduces the filename ${JSON.stringify(supplied)} to its basename inside the root`, [...TOOLS], async () => {
        const outputPath = path.join(ws.fixturesDir, 'result.zip');
        const before = ws.snapshot();

        const result = await ws.withTmpdir(() =>
          convertWithNative7z({ inputBuffer: Buffer.from('hello'), outputPath }, 'txt', 'zip', {}, supplied)
        );

        expect(result?.engineUsed).toBe('native-7z');
        expect(list7zEntryPaths(outputPath)).toEqual([leaf]);
        expect(readSingleEntry(outputPath, leaf)).toBe('hello');
        expect(ws.snapshot()).toEqual(before);
      });
    }

    for (const supplied of ['..', 'name\0with-nul.txt']) {
      oracleTest(`rejects the unusable filename ${JSON.stringify(supplied)}`, [...TOOLS], async () => {
        const before = ws.snapshot();

        await expectRejection(
          ws.withTmpdir(() => convertWithNative7z(Buffer.from('hello'), 'txt', 'zip', {}, supplied)),
          { name: 'UnsafeArchiveError', reason: 'unsafe-filename' }
        );

        expect(ws.snapshot()).toEqual(before);
      });
    }
  });

  describe('typed errors instead of a silent null', () => {
    oracleTest('throws a typed error for bytes that are not an archive', [...TOOLS], async () => {
      await expectRejection(
        ws.withTmpdir(() => convertWithNative7z(Buffer.from('this is not a zip archive'), 'zip', 'tar', {}, 'bad.zip')),
        { name: 'UnreadableArchiveError' },
        /could not read the archive/i
      );
    });

    oracleTest('throws a typed error for an archive without any entries', [...TOOLS], async () => {
      const emptyZip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');

      await expectRejection(
        ws.withTmpdir(() => convertWithNative7z(emptyZip, 'zip', 'tar', {}, 'empty.zip')),
        { name: 'ConversionFailedError' },
        /no files/i
      );
    });

    oracleTest('never falls through to the in-process engine for a hostile archive', [...TOOLS], async () => {
      const tar = buildTarWithEntries(path.join(ws.fixturesDir, 'dispatch.tar'), [
        { name: 'link', kind: 'symlink', target: ws.outsideDir },
        { name: 'link/pwn.txt', data: 'pwned' },
      ]);
      const input = fs.readFileSync(tar);
      const before = ws.snapshot();

      const outcome = await ws
        .withTmpdir(() => executeWorkerConversion(input, 'tar', 'zip', {}, 'dispatch.tar'))
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error })
        );

      if (outcome.ok) {
        throw new Error(`Expected a rejection but the worker produced output via ${outcome.value.engineUsed}`);
      }
      expect(outcome.error).toMatchObject({ name: 'UnsafeArchiveError', reason: 'link-entry' });
      expect(ws.snapshot()).toEqual(before);
    });
  });

  describe('benign archives still convert', () => {
    oracleTest('converts a nested zip to tar with its decoded content intact', [...TOOLS], async () => {
      const zip = buildZipWithEntries(path.join(ws.fixturesDir, 'benign.zip'), [
        { name: 'docs/readme.txt', data: 'read me' },
        { name: 'docs/deep/notes.txt', data: 'deep notes' },
        { name: 'top.txt', data: 'top level' },
      ]);
      const outputPath = path.join(ws.fixturesDir, 'benign.tar');

      const result = await convert(zip, 'zip', 'tar', outputPath);

      expect(result?.engineUsed).toBe('native-7z');
      const tarBinary = getOracleToolPath('tar');
      const listed = execFileSync(tarBinary ?? 'tar', ['-tf', outputPath], { encoding: 'utf-8' })
        .split('\n')
        .filter((line) => line.length > 0 && !line.endsWith('/'))
        .map((line) => line.replace(/^\.\//, ''))
        .sort();
      expect(listed).toEqual(['docs/deep/notes.txt', 'docs/readme.txt', 'top.txt']);
      const deep = execFileSync(tarBinary ?? 'tar', ['-xOf', outputPath, 'docs/deep/notes.txt'], { encoding: 'utf-8' });
      expect(deep).toBe('deep notes');
    });
  });

  describe('password validation', () => {
    for (const password of ['line\nbreak', 'carriage\rreturn', 'nul\0byte']) {
      it(`rejects the password ${JSON.stringify(password)} before touching 7z`, async () => {
        await expectRejection(
          convertWithNative7z(Buffer.from('hello'), 'txt', 'zip', { password }, 'hello.txt'),
          { name: 'ConversionFailedError' },
          /Archive password contains invalid newline or null characters\./
        );
      });
    }
  });

  describe('compressed tarballs list their inner tar', () => {
    const WRAPPED_SOURCES = ['tar.gz', 'tgz'] as const;

    for (const src of WRAPPED_SOURCES) {
      oracleTest(`rejects a symlink hidden inside a ${src} source`, [...TOOLS], async () => {
        const archive = buildTarWithEntries(path.join(ws.fixturesDir, `link.${src}`), [
          { name: 'ok.txt', data: 'fine' },
          { name: 'escape', kind: 'symlink', target: ws.outsideDir },
        ]);
        const before = ws.snapshot();

        await expectRejection(convert(archive, src, 'zip'), { name: 'UnsafeArchiveError', reason: 'link-entry' });

        expect(ws.snapshot()).toEqual(before);
      });

      oracleTest(`rejects a traversal entry hidden inside a ${src} source`, [...TOOLS], async () => {
        const archive = buildTarWithEntries(path.join(ws.fixturesDir, `slip.${src}`), [
          { name: '../../../outside/pwned.txt', data: 'pwned' },
        ]);
        const before = ws.snapshot();

        await expectRejection(convert(archive, src, 'zip'), { name: 'UnsafeArchiveError', reason: 'path-traversal' });

        expect(ws.snapshot()).toEqual(before);
      });
    }

    oracleTest('rejects a tar.gz whose inner tar holds more entries than the cap', [...TOOLS], async () => {
      const archive = buildManyEntriesTar(path.join(ws.fixturesDir, 'many.tar.gz'), OVER_CAP_ENTRY_COUNT);
      const before = ws.snapshot();

      await expectRejection(
        convert(archive, 'tar.gz', 'zip'),
        { name: 'UnsafeArchiveError', reason: 'entry-count' },
        /Archive bomb detected: file count/
      );

      expect(ws.snapshot()).toEqual(before);
    }, SLOW_TEST_TIMEOUT_MS);

    oracleTest('still converts a benign tar.gz and a gzip of a non-tar payload', [...TOOLS], async () => {
      const benign = buildTarWithEntries(path.join(ws.fixturesDir, 'benign.tar.gz'), [{ name: 'a.txt', data: 'alpha' }]);
      const benignOut = path.join(ws.fixturesDir, 'benign-out.zip');
      const plain = path.join(ws.fixturesDir, 'plain.txt.gz');
      fs.writeFileSync(plain, gzipSync(Buffer.from('plain text payload')));
      const plainOut = path.join(ws.fixturesDir, 'plain-out.zip');

      const benignResult = await convert(benign, 'tar.gz', 'zip', benignOut);
      const plainResult = await convert(plain, 'gz', 'zip', plainOut);

      expect(benignResult?.engineUsed).toBe('native-7z');
      expect(list7zEntryPaths(benignOut)).toHaveLength(1);
      expect(plainResult?.engineUsed).toBe('native-7z');
      expect(list7zEntryPaths(plainOut)).toHaveLength(1);
    });
  });

  describe('skipLinks opt-in', () => {
    function convertSkippingLinks(
      archivePath: string,
      src: string,
      outputPath: string
    ): Promise<WorkerConversionResult | null> {
      const input = { inputBuffer: fs.readFileSync(archivePath), outputPath };
      return ws.withTmpdir(() => convertWithNative7z(input, src, 'zip', { skipLinks: true }, path.basename(archivePath)));
    }

    oracleTest('leaves tar symlink and hardlink entries out and reports each name', [...TOOLS], async () => {
      const tar = buildTarWithEntries(path.join(ws.fixturesDir, 'links.tar'), [
        { name: 'ok.txt', data: 'fine' },
        { name: 'sym', kind: 'symlink', target: ws.outsideDir },
        { name: 'hard', kind: 'hardlink', target: 'ok.txt' },
      ]);
      const outputPath = path.join(ws.fixturesDir, 'links-out.zip');
      const before = ws.snapshot();

      const result = await convertSkippingLinks(tar, 'tar', outputPath);

      expect(result?.engineUsed).toBe('native-7z');
      expect(result?.skippedLinks).toEqual(['sym', 'hard']);
      expect(list7zEntryPaths(outputPath)).toEqual(['ok.txt']);
      expect(ws.snapshot()).toEqual(before);
    });

    oracleTest('leaves a 7z symlink out and reports it', [...TOOLS], async () => {
      const archive = build7zFromStagedLinks(
        path.join(ws.fixturesDir, 'skip.7z'),
        path.join(ws.fixturesDir, 'stage-skip'),
        [{ name: 'link', target: ws.outsideDir }],
        [{ name: 'f.txt', data: 'hello' }]
      );
      const outputPath = path.join(ws.fixturesDir, 'skip-out.zip');
      const before = ws.snapshot();

      const result = await convertSkippingLinks(archive, '7z', outputPath);

      expect(result?.skippedLinks).toEqual(['link']);
      expect(list7zEntryPaths(outputPath)).toEqual(['f.txt']);
      expect(ws.snapshot()).toEqual(before);
    });

    oracleTest('leaves a zip symlink out and reports it', [...TOOLS], async () => {
      const zip = buildZipWithEntries(path.join(ws.fixturesDir, 'skip.zip'), [
        { name: 'f.txt', data: 'hello' },
        { name: 'alias', mode: 0o120777, data: 'f.txt' },
      ]);
      const outputPath = path.join(ws.fixturesDir, 'skip-zip-out.zip');

      const result = await convertSkippingLinks(zip, 'zip', outputPath);

      expect(result?.skippedLinks).toEqual(['alias']);
      expect(list7zEntryPaths(outputPath)).toEqual(['f.txt']);
    });

    oracleTest('reports nothing when the archive has no links', [...TOOLS], async () => {
      const zip = buildZipWithEntries(path.join(ws.fixturesDir, 'nolinks.zip'), [{ name: 'f.txt', data: 'hello' }]);

      const result = await convertSkippingLinks(zip, 'zip', path.join(ws.fixturesDir, 'nolinks-out.zip'));

      expect(result?.skippedLinks).toBeUndefined();
    });

    oracleTest('still rejects when skipping would also drop an entry written through the link', [...TOOLS], async () => {
      const tar = buildTarWithEntries(path.join(ws.fixturesDir, 'through.tar'), [
        { name: 'link', kind: 'symlink', target: ws.outsideDir },
        { name: 'link/pwn.txt', data: 'pwned' },
      ]);
      const before = ws.snapshot();

      await expectRejection(
        ws.withTmpdir(() =>
          convertWithNative7z(fs.readFileSync(tar), 'tar', 'zip', { skipLinks: true }, 'through.tar')
        ),
        { name: 'UnsafeArchiveError', reason: 'link-entry' },
        /would also drop regular entries/
      );

      expect(ws.snapshot()).toEqual(before);
      expect(fs.existsSync(path.join(ws.outsideDir, 'pwn.txt'))).toBe(false);
    });

    oracleTest('refuses to skip a link whose name contains a wildcard', [...TOOLS], async () => {
      const tar = buildTarWithEntries(path.join(ws.fixturesDir, 'wild.tar'), [
        { name: 'ok.txt', data: 'fine' },
        { name: 'we*ird', kind: 'symlink', target: 'ok.txt' },
      ]);

      await expectRejection(
        ws.withTmpdir(() => convertWithNative7z(fs.readFileSync(tar), 'tar', 'zip', { skipLinks: true }, 'wild.tar')),
        { name: 'UnsafeArchiveError', reason: 'link-entry' },
        /wildcard/
      );
    });

    oracleTest('still rejects traversal entries when links are skipped', [...TOOLS], async () => {
      const zip = buildZipWithEntries(path.join(ws.fixturesDir, 'skip-slip.zip'), [
        { name: '../../evil.txt', data: 'x' },
        { name: 'alias', mode: 0o120777, data: 'x' },
      ]);

      await expectRejection(
        ws.withTmpdir(() => convertWithNative7z(fs.readFileSync(zip), 'zip', 'tar', { skipLinks: true }, 'skip-slip.zip')),
        { name: 'UnsafeArchiveError', reason: 'path-traversal' }
      );
    });

    oracleTest('reports skipped links through the worker dispatcher', [...TOOLS], async () => {
      const tar = buildTarWithEntries(path.join(ws.fixturesDir, 'dispatch-skip.tar'), [
        { name: 'ok.txt', data: 'fine' },
        { name: 'sym', kind: 'symlink', target: 'ok.txt' },
      ]);

      const result = await ws.withTmpdir(() =>
        executeWorkerConversion(fs.readFileSync(tar), 'tar', 'zip', { skipLinks: true }, 'dispatch-skip.tar')
      );

      expect(result.engineUsed).toBe('native-7z');
      expect(result.skippedLinks).toEqual(['sym']);
    });
  });

  describe('selective extraction', () => {
    oracleTest('packages only the entries the caller selected', [...TOOLS], async () => {
      const zip = buildZipWithEntries(path.join(ws.fixturesDir, 'select.zip'), [
        { name: 'a.txt', data: 'alpha' },
        { name: 'b.txt', data: 'bravo' },
        { name: 'c.txt', data: 'charlie' },
      ]);
      const outputPath = path.join(ws.fixturesDir, 'select.tar');
      const input = { inputBuffer: fs.readFileSync(zip), outputPath };

      const result = await ws.withTmpdir(() => convertWithNative7z(input, 'zip', 'tar', { entries: ['b.txt'] }, 'select.zip'));

      expect(result?.engineUsed).toBe('native-7z');
      expect(list7zEntryPaths(outputPath)).toEqual(['b.txt']);
    });
  });

  it('still reports an unavailable 7z binary as null rather than throwing', async () => {
    const result = await withMissingBinary('P7ZIP_PATH', () =>
      convertWithNative7z(Buffer.from('PK'), 'zip', 'tar', {}, 'x.zip')
    );

    expect(result).toBeNull();
  });
});
