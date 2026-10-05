import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { ARCHIVE_SECURITY_LIMITS, convertWithNative7z } from '../src/lib/conversions/archive';
import { convertWithNative7z as convertWithNative7zWorker } from '../src/worker/engines';
import {
  assertExtractionContained,
  assertSafeArchiveListing,
  parse7zTechnicalListing,
  removeDirectoryTree,
  cleanupDirectoryTree,
  type ListedArchiveEntry,
} from '../src/lib/conversions/archive-extraction-safety';
import { ArchiveEntryCollisionError, ConversionFailedError } from '../src/lib/types';
import { POST as convertV1 } from '../src/app/api/v1/convert/route';
import { POST as convertLegacy } from '../src/app/api/convert/route';
import { keyStore } from '../src/lib/api-keys/key-store';
import { userStore } from '../src/lib/auth/user-store';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import {
  buildFanZip,
  buildTarWithEntries,
  buildZipWithEntries,
  createHostileWorkspace,
  type HostileWorkspace,
} from './helpers/hostile-archives';

const LINEAR_PROBE_SMALL = 12_250;
const LINEAR_PROBE_LARGE = 49_000;
const MAX_LINEAR_GROWTH = 8;
const LINEAR_PROBE_CEILING_MS = 10_000;

/** Second review round of PR #499: implied directories, listing-key whitelist, collision status, remover root. */

const TOOLS = ['7z', 'python3'] as const;
const HTTP_UNPROCESSABLE = 422;
const FAN_ENTRIES = 300;
/** 'd/' repeated, plus the fan prefix and the leaf, stays within the 256-level depth limit. */
const FAN_DEPTH = 253;
const FAN_TIME_BUDGET_MS = 20_000;
const SLOW_TEST_TIMEOUT_MS = 600_000;

function entry(entryPath: string, isDirectory = false): ListedArchiveEntry {
  return { path: entryPath, isDirectory, sizeBytes: isDirectory ? 0 : 1, linkKind: null, isSpecial: false };
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

describe('NEW-1: implied directories count toward the entry cap', () => {
  const small = { MAX_FILES: 3, MAX_UNCOMPRESSED_SIZE: 1_000_000, MAX_RATIO: 1_000_000 };

  it('counts the directories a path implies, not just the listed entry', () => {
    expect(assertSafeArchiveListing([entry('a/b/c')], 1_000, small).entryCount).toBe(1);
    expect(reasonOf(() => assertSafeArchiveListing([entry('a/b/c/d')], 1_000, small))).toBe('entry-count');
  });

  it('counts a shared ancestor once', () => {
    const four = { ...small, MAX_FILES: 4 };

    expect(assertSafeArchiveListing([entry('a/b/1'), entry('a/b/2')], 1_000, four).entryCount).toBe(2);
    expect(reasonOf(() => assertSafeArchiveListing([entry('a/b/1'), entry('a/b/2')], 1_000, small))).toBe('entry-count');
  });

  it('does not double count a listed directory that is also implied', () => {
    expect(assertSafeArchiveListing([entry('a', true), entry('a/b', true), entry('a/b/c')], 1_000, small).entryCount).toBe(3);
  });

  it('treats ./a/b and a//b/ as the same occupied paths', () => {
    expect(assertSafeArchiveListing([entry('./a/b'), entry('a//b/', true)], 1_000, small).entryCount).toBe(2);
  });

  it('rejects 300 entries that each imply 254 directories, quickly', () => {
    const entries = Array.from({ length: FAN_ENTRIES }, (_, i) => entry(`${i}/${'d/'.repeat(FAN_DEPTH)}f`));
    const started = performance.now();

    const reason = reasonOf(() => assertSafeArchiveListing(entries, 1_000_000, ARCHIVE_SECURITY_LIMITS));

    expect(reason).toBe('entry-count');
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('accounts 49,000 deep entries under one prefix in linear time', () => {
    const shared = 'p/'.repeat(100);
    const timeListing = (count: number): { ms: number; entryCount: number } => {
      const entries = Array.from({ length: count }, (_, i) => entry(`${shared}${i}`));
      const started = performance.now();
      const verdict = assertSafeArchiveListing(entries, 1_000_000, ARCHIVE_SECURITY_LIMITS);
      return { ms: performance.now() - started, entryCount: verdict.entryCount };
    };

    timeListing(LINEAR_PROBE_SMALL);
    const small = timeListing(LINEAR_PROBE_SMALL);
    const large = timeListing(LINEAR_PROBE_LARGE);

    expect(small.entryCount).toBe(LINEAR_PROBE_SMALL);
    expect(large.entryCount).toBe(LINEAR_PROBE_LARGE);
    // 4x the entries: linear work grows about 4x, the old quadratic accounting about 16x.
    expect(large.ms / Math.max(small.ms, 1)).toBeLessThan(MAX_LINEAR_GROWTH);
    expect(large.ms).toBeLessThan(LINEAR_PROBE_CEILING_MS);
  });

  it('makes the post-extraction walk count directories against the same cap', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-dirs-'));
    try {
      fs.mkdirSync(path.join(root, 'a', 'b', 'c', 'd', 'e', 'f'), { recursive: true });
      const five = { MAX_FILES: 5, MAX_UNCOMPRESSED_SIZE: 1_000_000, MAX_RATIO: 1_000_000 };

      expect(reasonOf(() => assertExtractionContained(root, 1_000, five))).toBe('entry-count');
      expect(assertExtractionContained(root, 1_000, { ...five, MAX_FILES: 6 }).entryCount).toBe(6);
    } finally {
      removeDirectoryTree(root);
    }
  });

  describe('through the conversion routes', () => {
    const originalP7zipPath = process.env.P7ZIP_PATH;
    let ws: HostileWorkspace;

    beforeAll(() => {
      const sevenZip = getOracleToolPath('7z');
      if (sevenZip) process.env.P7ZIP_PATH = sevenZip;
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

    oracleTest(
      'rejects a 300-entry fan that would create about 76,000 directories, before extracting',
      [...TOOLS],
      async () => {
        const zip = buildFanZip(path.join(ws.fixturesDir, 'fan300.zip'), FAN_ENTRIES, FAN_DEPTH);
        const input = fs.readFileSync(zip);
        const before = ws.snapshot();
        const started = performance.now();

        const workerError = await rejection(
          ws.withTmpdir(() => convertWithNative7zWorker(input, 'zip', 'tar', {}, 'fan300.zip'))
        );
        const libError = await rejection(ws.withTmpdir(async () => convertWithNative7z(input, 'zip', 'tar', {}, 'fan300.zip')));

        expect(workerError).toMatchObject({ name: 'UnsafeArchiveError', reason: 'entry-count' });
        expect(libError).toMatchObject({ name: 'UnsafeArchiveError', reason: 'entry-count' });
        expect(performance.now() - started).toBeLessThan(FAN_TIME_BUDGET_MS);
        expect(ws.snapshot()).toEqual(before);
      },
      SLOW_TEST_TIMEOUT_MS
    );
  });
});

describe('A: only known listing keys are accepted, and names carry no line breaks', () => {
  it('rejects a block with a key outside the known set (p7zip 16.02 block splitting)', () => {
    const split = 'Path = x\nSize = 0\nFoo = bar\n\nPath = harmless\nSize = 1\n';

    expect(reasonOf(() => parse7zTechnicalListing(split))).toBe('malformed-listing');
    expect(reasonOf(() => parse7zTechnicalListing('Path = a\nSize = 1\nZ = 9\n'))).toBe('malformed-listing');
  });

  it('accepts every key 7-Zip 16.02, 21.07, 22.01 and 23.01 print for real archives', () => {
    const keys = [
      'Path', 'Folder', 'Size', 'Packed Size', 'Modified', 'Created', 'Accessed', 'Attributes', 'Encrypted',
      'Comment', 'CRC', 'Method', 'Block', 'Characteristics', 'Host OS', 'Version', 'Volume Index', 'Offset',
      'Link', 'Hard Link', 'Symbolic Link', 'User', 'Group', 'User ID', 'Group ID', 'Mode', 'iNode', 'Links',
      'Solid', 'Short Name', 'Alternate Stream', 'Alternate Streams', 'NT Security', 'SHA-1', 'Checksum',
      'Device Major', 'Device Minor', 'Dev Major', 'Dev Minor', 'Stream ID', 'Commented', 'Split Before',
      'Split After',
    ];
    const listing = `${keys.map((key) => `${key} = ${key === 'Path' ? 'a' : '1'}`).join('\n')}\n`;

    expect(parse7zTechnicalListing(listing)).toHaveLength(1);
  });

  for (const name of ['line\nbreak', 'carriage\rreturn']) {
    it(`rejects the entry name ${JSON.stringify(name)} on every 7-Zip version`, () => {
      expect(reasonOf(() => assertSafeArchiveListing([entry(name)], 1_000, ARCHIVE_SECURITY_LIMITS))).toBe(
        'invalid-entry-name'
      );
    });
  }

  describe('crafted archives', () => {
    const originalP7zipPath = process.env.P7ZIP_PATH;
    let ws: HostileWorkspace;

    beforeAll(() => {
      const sevenZip = getOracleToolPath('7z');
      if (sevenZip) process.env.P7ZIP_PATH = sevenZip;
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

    const FORGED_NAME = 'x\nSize = 0\nFoo = bar\n\nPath = harmless';

    for (const kind of ['zip', 'tar'] as const) {
      oracleTest(`never lets a forged ${kind} name smuggle fields into the listing`, [...TOOLS], async () => {
        const archive =
          kind === 'zip'
            ? buildZipWithEntries(path.join(ws.fixturesDir, 'split.zip'), [{ name: FORGED_NAME, data: 'x' }])
            : buildTarWithEntries(path.join(ws.fixturesDir, 'split.tar'), [{ name: FORGED_NAME, data: 'x' }]);
        const before = ws.snapshot();

        const outcome = await ws
          .withTmpdir(() =>
            convertWithNative7zWorker(
              { inputBuffer: fs.readFileSync(archive), outputPath: path.join(ws.fixturesDir, 'out.zip') },
              kind,
              'zip',
              {},
              `split.${kind}`
            )
          )
          .then(
            () => 'converted',
            (error: unknown) => (error as { reason?: string }).reason ?? 'untyped'
          );

        // Builds that rewrite line breaks see an ordinary odd name; builds that print them are rejected.
        expect(['converted', 'malformed-listing', 'invalid-entry-name']).toContain(outcome);
        expect(ws.snapshot()).toEqual(before);
      });
    }
  });
});

describe('C: collisions are typed and answered with 422', () => {
  it('is a ConversionFailedError that keeps its status and entry name', () => {
    const error = new ArchiveEntryCollisionError('a.txt');

    expect(error).toBeInstanceOf(ConversionFailedError);
    expect(error.status).toBe(HTTP_UNPROCESSABLE);
    expect(error.entryName).toBe('a.txt');
    expect(error.name).toBe('ArchiveEntryCollisionError');
  });

  describe('through the HTTP routes', () => {
    const originalP7zipPath = process.env.P7ZIP_PATH;
    let ws: HostileWorkspace;

    beforeAll(() => {
      const sevenZip = getOracleToolPath('7z');
      if (sevenZip) process.env.P7ZIP_PATH = sevenZip;
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

    function duplicateTarForm(): FormData {
      const tar = buildTarWithEntries(path.join(ws.fixturesDir, 'dup.tar'), [
        { name: 'a.txt', data: 'one' },
        { name: 'a.txt', data: 'two' },
      ]);
      const form = new FormData();
      form.append('file', new File([new Uint8Array(fs.readFileSync(tar))], 'dup.tar'));
      form.append('targetFormat', 'zip');
      form.append('options', JSON.stringify({ collisionPolicy: 'error' }));
      return form;
    }

    oracleTest('/api/convert answers 422', [...TOOLS], async () => {
      const response = await convertLegacy(
        new NextRequest('http://localhost:3000/api/convert', { method: 'POST', body: duplicateTarForm() })
      );
      const body = await response.json();

      expect(response.status).toBe(HTTP_UNPROCESSABLE);
      expect(body.error).toMatch(/collision detected for 'a\.txt'/);
    });

    oracleTest('/api/v1/convert answers 422', [...TOOLS], async () => {
      const user = userStore.sanitizeUser(
        await userStore.createUser({ email: `collide_${Date.now()}@test.local`, name: 'Collider', tier: 'pro' })
      );
      const { secretKey } = await keyStore.generateApiKey(user.id, 'collision key');

      const response = await convertV1(
        new NextRequest('http://localhost:3000/api/v1/convert', {
          method: 'POST',
          headers: { Authorization: `Bearer ${secretKey}` },
          body: duplicateTarForm(),
        })
      );
      const body = await response.json();

      expect(response.status).toBe(HTTP_UNPROCESSABLE);
      expect(body.detail).toMatch(/collision detected for 'a\.txt'/);
    });
  });
});

describe('F: the tree remover refuses a symlink root', () => {
  let base: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-rm-root-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    removeDirectoryTree(base);
  });

  it('throws a typed error and leaves the link target untouched', () => {
    const target = path.join(base, 'target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');
    const link = path.join(base, 'link');
    fs.symlinkSync(target, link);

    expect(reasonOf(() => removeDirectoryTree(link))).toBe('link-entry');
    expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf-8')).toBe('keep');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('logs instead of throwing from the best-effort cleanup, and still keeps the target', () => {
    const target = path.join(base, 'target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');
    const link = path.join(base, 'link');
    fs.symlinkSync(target, link);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    cleanupDirectoryTree(link);

    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0][0])).toContain('failed to remove temporary directory');
    expect(fs.existsSync(path.join(target, 'keep.txt'))).toBe(true);
  });

  it('still removes an ordinary tree, links inside it included', () => {
    const tree = path.join(base, 'tree');
    fs.mkdirSync(path.join(tree, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'sub', 'f.txt'), 'x');
    fs.symlinkSync(base, path.join(tree, 'back'));

    removeDirectoryTree(tree);

    expect(fs.existsSync(tree)).toBe(false);
    expect(fs.existsSync(base)).toBe(true);
  });
});
