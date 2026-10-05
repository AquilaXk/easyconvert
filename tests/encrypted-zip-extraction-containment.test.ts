import { afterAll, afterEach, beforeAll, beforeEach, describe, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { extractZipArchive } from '../src/lib/conversions/archive';
import { ConversionFailedError } from '../src/lib/types';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { resolveStdinPasswordSevenZip, type StdinPasswordSevenZip } from './helpers/stdin-password-7z';
import {
  buildEncryptedZip,
  createHostileWorkspace,
  patchZipEntryName,
  type HostileWorkspace,
} from './helpers/hostile-archives';

/**
 * Regression suite for the encrypted-ZIP extraction path (GitHub issue #458). Fixtures are AES-256
 * ZIPs written by 7z; hostile entry names are patched in at identical byte length because 7z itself
 * refuses to write them. Each test asserts a typed error and, from the filesystem, that nothing
 * was written outside the extraction root.
 */

const TOOLS = ['7z'] as const;
const PASSWORD = 'Correct-Horse-Battery-9';
const SLOW_TEST_TIMEOUT_MS = 120_000;
/** Above the 500 MiB uncompressed-size cap; DEFLATE shrinks zeros to well under 1 MiB. */
const OVER_CAP_BOMB_MIB = 600;
/** The bomb must stay a tiny file, orders of magnitude below its uncompressed size. */
const MAX_BOMB_ARCHIVE_BYTES = 8 * 1024 * 1024;
const RATIO_BOMB_MIB = 3;
const OVER_CAP_ENTRY_COUNT = 1001;
const AT_CAP_ENTRY_COUNT = 1000;

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected the encrypted ZIP to be rejected, but extraction completed');
    },
    (error: unknown) => error
  );
}

describe('encrypted ZIP extraction containment (#458)', () => {
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

  function extract(zipPath: string, options: { password?: string; entries?: string[] } = { password: PASSWORD }) {
    const zipBuffer = fs.readFileSync(zipPath);
    return ws.withTmpdir(() => extractZipArchive(zipBuffer, options));
  }

  oracleTest('rejects a zip-slip entry and writes nothing outside the extraction root', [...TOOLS], async () => {
    const zipPath = path.join(ws.fixturesDir, 'slip.zip');
    buildEncryptedZip(zipPath, path.join(ws.fixturesDir, 'stage-slip'), {
      password: PASSWORD,
      files: [
        { name: 'XXXXXXXXXevil.txt', data: 'pwned' },
        { name: 'ok.txt', data: 'fine' },
      ],
    });
    // From <tmp>/<work>/out, three levels up is the workspace root, outside the extraction root.
    patchZipEntryName(zipPath, 'XXXXXXXXX', '../../../');
    const before = ws.snapshot();

    const error = await rejection(extract(zipPath));

    expect(error).toBeInstanceOf(ConversionFailedError);
    expect(error).toMatchObject({ name: 'UnsafeArchiveError', reason: 'path-traversal' });
    expect(ws.snapshot()).toEqual(before);
    expect(fs.existsSync(path.join(ws.root, 'evil.txt'))).toBe(false);
    expect(fs.readdirSync(ws.outsideDir)).toEqual(['canary.txt']);
  });

  oracleTest('rejects an absolute-path entry that targets a directory outside the root', [...TOOLS], async () => {
    const target = path.join(ws.outsideDir, 'abs-pwned.txt');
    const placeholder = 'Q'.repeat(Buffer.byteLength(target));
    const zipPath = path.join(ws.fixturesDir, 'abs.zip');
    buildEncryptedZip(zipPath, path.join(ws.fixturesDir, 'stage-abs'), {
      password: PASSWORD,
      files: [
        { name: placeholder, data: 'pwned' },
        { name: 'ok.txt', data: 'fine' },
      ],
    });
    patchZipEntryName(zipPath, placeholder, target);
    const before = ws.snapshot();

    const error = await rejection(extract(zipPath));

    expect(error).toBeInstanceOf(ConversionFailedError);
    expect(error).toMatchObject({ name: 'UnsafeArchiveError', reason: 'absolute-path' });
    expect(ws.snapshot()).toEqual(before);
    expect(fs.existsSync(target)).toBe(false);
  });

  oracleTest('rejects a symlink entry instead of following it with stat', [...TOOLS], async () => {
    const zipPath = path.join(ws.fixturesDir, 'link.zip');
    buildEncryptedZip(zipPath, path.join(ws.fixturesDir, 'stage-link'), {
      password: PASSWORD,
      files: [{ name: 'real.txt', data: 'real content' }],
      links: [{ name: 'alias.txt', target: 'real.txt' }],
    });
    const before = ws.snapshot();

    const error = await rejection(extract(zipPath));

    expect(error).toBeInstanceOf(ConversionFailedError);
    expect(error).toMatchObject({ name: 'UnsafeArchiveError', reason: 'link-entry' });
    expect(ws.snapshot()).toEqual(before);
  });

  oracleTest('rejects a symlink that points outside the root', [...TOOLS], async () => {
    const zipPath = path.join(ws.fixturesDir, 'escape-link.zip');
    buildEncryptedZip(zipPath, path.join(ws.fixturesDir, 'stage-escape-link'), {
      password: PASSWORD,
      files: [{ name: 'real.txt', data: 'real content' }],
      links: [{ name: 'escape', target: ws.outsideDir }],
    });
    const before = ws.snapshot();

    const error = await rejection(extract(zipPath));

    expect(error).toMatchObject({ name: 'UnsafeArchiveError', reason: 'link-entry' });
    expect(ws.snapshot()).toEqual(before);
  });

  oracleTest(
    'rejects an archive over the uncompressed-size cap before extracting it',
    [...TOOLS],
    async () => {
      const zipPath = path.join(ws.fixturesDir, 'bomb.zip');
      buildEncryptedZip(zipPath, path.join(ws.fixturesDir, 'stage-bomb'), {
        password: PASSWORD,
        zeroFileMib: OVER_CAP_BOMB_MIB,
      });
      expect(fs.statSync(zipPath).size).toBeLessThan(MAX_BOMB_ARCHIVE_BYTES);
      const before = ws.snapshot();

      const error = await rejection(extract(zipPath));

      expect(error).toBeInstanceOf(ConversionFailedError);
      expect(error).toMatchObject({ name: 'UnsafeArchiveError', reason: 'uncompressed-size' });
      expect((error as Error).message).toMatch(/Archive bomb detected: uncompressed size exceeds limit/);
      expect(ws.snapshot()).toEqual(before);
    },
    SLOW_TEST_TIMEOUT_MS
  );

  oracleTest('rejects an archive under the size cap whose compression ratio exceeds 100:1', [...TOOLS], async () => {
    const zipPath = path.join(ws.fixturesDir, 'ratio.zip');
    buildEncryptedZip(zipPath, path.join(ws.fixturesDir, 'stage-ratio'), {
      password: PASSWORD,
      zeroFileMib: RATIO_BOMB_MIB,
    });
    const before = ws.snapshot();

    const error = await rejection(extract(zipPath));

    expect(error).toMatchObject({ name: 'UnsafeArchiveError', reason: 'compression-ratio' });
    expect((error as Error).message).toMatch(/Archive bomb detected: compression ratio .* exceeds 100:1 limit/);
    expect(ws.snapshot()).toEqual(before);
  });

  oracleTest('rejects an archive holding more entries than the file-count cap', [...TOOLS], async () => {
    const zipPath = path.join(ws.fixturesDir, 'many.zip');
    buildEncryptedZip(zipPath, path.join(ws.fixturesDir, 'stage-many'), {
      password: PASSWORD,
      manyFiles: OVER_CAP_ENTRY_COUNT,
    });
    const before = ws.snapshot();

    const error = await rejection(extract(zipPath));

    expect(error).toMatchObject({ name: 'UnsafeArchiveError', reason: 'entry-count' });
    expect((error as Error).message).toMatch(/Archive bomb detected: file count/);
    expect(ws.snapshot()).toEqual(before);
  }, SLOW_TEST_TIMEOUT_MS);

  oracleTest('extracts an encrypted archive holding exactly the file-count cap', [...TOOLS], async () => {
    const zipPath = path.join(ws.fixturesDir, 'at-cap.zip');
    buildEncryptedZip(zipPath, path.join(ws.fixturesDir, 'stage-at-cap'), {
      password: PASSWORD,
      manyFiles: AT_CAP_ENTRY_COUNT,
    });

    const files = await extract(zipPath);

    expect(files).toHaveLength(AT_CAP_ENTRY_COUNT);
    expect(files.every((file) => file.buffer.toString('utf-8') === 'x')).toBe(true);
  }, SLOW_TEST_TIMEOUT_MS);

  oracleTest('still decrypts a benign archive and returns the decoded content', [...TOOLS], async () => {
    const zipPath = path.join(ws.fixturesDir, 'benign.zip');
    buildEncryptedZip(zipPath, path.join(ws.fixturesDir, 'stage-benign'), {
      password: PASSWORD,
      files: [
        { name: 'secret.txt', data: 'top secret' },
        { name: 'notes.md', data: '# notes' },
      ],
    });

    const files = await extract(zipPath);

    const byName = new Map(files.map((file) => [file.filename, file.buffer.toString('utf-8')]));
    expect(byName).toEqual(
      new Map([
        ['secret.txt', 'top secret'],
        ['notes.md', '# notes'],
      ])
    );
  });

  oracleTest('keeps honouring the entry filter after extraction', [...TOOLS], async () => {
    const zipPath = path.join(ws.fixturesDir, 'filter.zip');
    buildEncryptedZip(zipPath, path.join(ws.fixturesDir, 'stage-filter'), {
      password: PASSWORD,
      files: [
        { name: 'keep.txt', data: 'keep' },
        { name: 'drop.md', data: 'drop' },
      ],
    });

    const files = await extract(zipPath, { password: PASSWORD, entries: ['*.txt'] });

    expect(files.map((file) => file.filename)).toEqual(['keep.txt']);
  });

  oracleTest('still reports a wrong password as a typed error', [...TOOLS], async () => {
    const zipPath = path.join(ws.fixturesDir, 'wrong-password.zip');
    buildEncryptedZip(zipPath, path.join(ws.fixturesDir, 'stage-wrong-password'), {
      password: PASSWORD,
      files: [{ name: 'secret.txt', data: 'top secret' }],
    });

    const error = await rejection(extract(zipPath, { password: 'not-the-password' }));

    expect(error).toBeInstanceOf(ConversionFailedError);
    expect((error as Error).message).toBe('Invalid password for encrypted ZIP archive.');
  });
});
