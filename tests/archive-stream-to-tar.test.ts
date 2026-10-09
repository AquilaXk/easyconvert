import { afterAll, afterEach, beforeAll, beforeEach, describe, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertFile } from '../src/lib/conversions';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { convertWithNative7z } from '../src/worker/engines';
import { UnsafeArchiveError } from '../src/lib/conversions/archive-extraction-safety';
import { jsonRecords, runBytes, zipfText } from './helpers/archive-corpus';
import { oracleTest } from './helpers/oracle-test';
import { buildTarWithEntries } from './helpers/hostile-archives';
import { createSevenZipSpy, type SevenZipSpy } from './helpers/seven-zip-spy';

/**
 * Converting a compressed tar (or a compressed single file) to tar is stream decompression. A payload that is a tar is
 * read, vetted and written again with the same members, and a payload that is not a tar is written into a one-member
 * tar. Nothing is extracted to a directory: the number and shape of the 7-Zip calls is read from a recording wrapper,
 * and the tar is read back with the system tar, an independent reader.
 */
const TOOLS = ['7z', 'tar', 'xz', 'gzip', 'bzip2', 'zstd'] as const;
const TEST_TIMEOUT_MS = 120_000;
/** Zeros that xz packs to about 20 KB: far over the 100:1 ratio cap and over the point where the cap cuts the stream. */
const BOMB_UNPACKED_MIB = 400;
const MIB = 1024 * 1024;
const FIXED_MTIME = '202103040506';

interface Compressor {
  /** Registry names the same stream goes by. */
  sources: string[];
  /** The type switch 7-Zip is expected to be given for it. */
  sevenZipType: string;
  compress: (input: Buffer) => Buffer;
}

const COMPRESSORS: Compressor[] = [
  { sources: ['xz', 'txz', 'tar.xz'], sevenZipType: '-txz', compress: (input) => execFileSync('xz', ['-6', '-c'], { input }) },
  { sources: ['gz', 'tgz', 'tar.gz'], sevenZipType: '-tgzip', compress: (input) => execFileSync('gzip', ['-6', '-c', '-n'], { input }) },
  { sources: ['bz2', 'tbz2', 'tar.bz2'], sevenZipType: '-tbzip2', compress: (input) => execFileSync('bzip2', ['-9', '-c'], { input }) },
];

let workDir = '';
let spy: SevenZipSpy;
let tarFixture: { tar: Buffer; files: Map<string, Buffer> };

function buildTarFixture(): { tar: Buffer; files: Map<string, Buffer> } {
  const sourceDir = path.join(workDir, 'tree');
  fs.mkdirSync(path.join(sourceDir, 'docs', 'deep'), { recursive: true });
  const files = new Map<string, Buffer>([
    ['docs/a.txt', zipfText(60_000, 11)],
    ['docs/deep/records.jsonl', jsonRecords(40_000, 12)],
    ['docs/b.bin', runBytes(30_000, 13)],
    ['empty.txt', Buffer.alloc(0)],
  ]);
  for (const [name, data] of files) fs.writeFileSync(path.join(sourceDir, name), data);
  fs.chmodSync(path.join(sourceDir, 'docs/a.txt'), 0o640);
  fs.chmodSync(path.join(sourceDir, 'docs/b.bin'), 0o755);
  for (const name of [...files.keys(), 'docs/deep', 'docs']) {
    execFileSync('touch', ['-t', FIXED_MTIME, path.join(sourceDir, name)]);
  }
  const tarPath = path.join(workDir, 'fixture.tar');
  execFileSync('tar', ['--format=ustar', '-cf', tarPath, '-C', sourceDir, 'docs', 'empty.txt'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  return { tar: fs.readFileSync(tarPath), files };
}

/** Mode string and name of every member, as the system tar prints them (owner and date columns differ between a tar and its rewrite). */
function tarModesAndNames(tar: Buffer, label: string): string[] {
  const file = path.join(workDir, `${label}.tar`);
  fs.writeFileSync(file, tar);
  return execFileSync('tar', ['-tvf', file], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const columns = line.trim().split(/\s+/);
      return `${columns[0]} ${columns.at(-1)}`;
    });
}

function tarMember(tar: Buffer, member: string): Buffer {
  const file = path.join(workDir, `member-${path.basename(member)}.tar`);
  fs.writeFileSync(file, tar);
  return execFileSync('tar', ['-xOf', file, member], { maxBuffer: 1 << 30 });
}

function tarNames(tar: Buffer, label: string): string[] {
  const file = path.join(workDir, `names-${label}.tar`);
  fs.writeFileSync(file, tar);
  return execFileSync('tar', ['-tf', file], { encoding: 'utf8' }).split('\n').filter((line) => line !== '');
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-to-tar-'));
  spy = createSevenZipSpy(workDir);
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  spy.reset();
  spy.install();
});

afterEach(() => {
  spy.restore();
});

describe('native route: a compressed tar comes back as a tar with the same members', () => {
  for (const compressor of COMPRESSORS) {
    for (const source of compressor.sources) {
      oracleTest(
        `${source} to tar returns a tar with the payload's members, modes and bytes, from one stream-only 7-Zip call`,
        [...TOOLS],
        async () => {
          tarFixture ??= buildTarFixture();
          const { tar, files } = tarFixture;
          const result = await convertWithNative7z(compressor.compress(tar), source, 'tar', {}, `fixture.${source}`);
          if (result === null) throw new Error('the native 7-Zip engine declined the conversion');

          expect(tarModesAndNames(result.buffer, `native-${source}`)).toEqual(tarModesAndNames(tar, `original-${source}`));
          for (const [name, data] of files) {
            expect(tarMember(result.buffer, name).equals(data)).toBe(true);
          }

          const calls = spy.calls();
          expect(calls).toHaveLength(1);
          const [call] = calls;
          expect(call.slice(0, 3)).toEqual(['x', '-so', '-y']);
          expect(call).toContain(compressor.sevenZipType);
          expect(call.some((argument) => argument.startsWith('-o'))).toBe(false);
          expect(call).not.toContain('a');
          expect(call).not.toContain('l');
        },
        TEST_TIMEOUT_MS
      );
    }
  }

  oracleTest(
    'a tar file input is read in place: the 7-Zip call names the file, not a copy',
    [...TOOLS],
    async () => {
      tarFixture ??= buildTarFixture();
      const archive = path.join(workDir, 'on-disk.tar.xz');
      fs.writeFileSync(archive, COMPRESSORS[0].compress(tarFixture.tar));
      const result = await convertWithNative7z({ inputPath: archive }, 'tar.xz', 'tar', {}, 'on-disk.tar.xz');
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
      expect(tarModesAndNames(result.buffer, 'on-disk')).toEqual(tarModesAndNames(tarFixture.tar, 'on-disk-original'));
      for (const [name, data] of tarFixture.files) {
        expect(tarMember(result.buffer, name).equals(data), name).toBe(true);
      }
      const [call] = spy.calls();
      expect(call).toContain(archive);
    },
    TEST_TIMEOUT_MS
  );
});

describe('native route: a payload that is not a tar is wrapped in a one-member tar', () => {
  for (const compressor of COMPRESSORS) {
    oracleTest(
      `${compressor.sources[0]} holding a text file becomes a tar with that file, named after the source`,
      [...TOOLS],
      async () => {
        const payload = zipfText(150_000, 21);
        const source = compressor.sources[0];
        const result = await convertWithNative7z(compressor.compress(payload), source, 'tar', {}, `notes.${source}`);
        if (result === null) throw new Error('the native 7-Zip engine declined the conversion');

        expect(tarNames(result.buffer, `plain-${source}`)).toEqual(['notes']);
        expect(tarMember(result.buffer, 'notes').equals(payload)).toBe(true);
        expect(spy.calls()).toHaveLength(1);
      },
      TEST_TIMEOUT_MS
    );
  }

  oracleTest(
    'an empty payload becomes a tar with one empty member',
    [...TOOLS],
    async () => {
      const result = await convertWithNative7z(COMPRESSORS[0].compress(Buffer.alloc(0)), 'xz', 'tar', {}, 'nothing.xz');
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
      expect(tarNames(result.buffer, 'empty')).toEqual(['nothing']);
      expect(tarMember(result.buffer, 'nothing')).toHaveLength(0);
    },
    TEST_TIMEOUT_MS
  );
});

describe('native route: limits apply to the stream while it flows', () => {
  oracleTest(
    'a decompression bomb fails with the typed ratio error and 7-Zip is stopped before it finishes',
    [...TOOLS],
    async () => {
      const bomb = execFileSync('sh', ['-c', `head -c ${BOMB_UNPACKED_MIB * MIB} /dev/zero | xz -1 -c`], { maxBuffer: 64 * MIB });
      expect(bomb.length).toBeLessThan(MIB);

      const outcome = await convertWithNative7z(bomb, 'xz', 'tar', {}, 'bomb.xz').then(
        () => null,
        (error: unknown) => error
      );

      expect(outcome).toBeInstanceOf(UnsafeArchiveError);
      expect(outcome).toMatchObject({ reason: 'compression-ratio' });
      expect(spy.calls()).toHaveLength(1);
      // The wrapper writes its exit status only if the real 7-Zip returned; a killed group never gets there.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(spy.completedCalls()).toBe(0);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a stream that is not valid xz fails with the typed unreadable-archive error',
    [...TOOLS],
    async () => {
      const damaged = Buffer.from(COMPRESSORS[0].compress(zipfText(50_000, 22)));
      damaged[damaged.length >> 1] ^= 0xff;
      await expect(convertWithNative7z(damaged, 'xz', 'tar', {}, 'damaged.xz')).rejects.toMatchObject({
        name: 'UnreadableArchiveError',
        message: expect.stringMatching(/^Could not read the archive: 7-Zip rejected/),
      });
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a payload tar holding a symlink is refused, and so is one holding a traversing name',
    ['7z', 'python3'],
    async () => {
      const withLink = fs.readFileSync(
        buildTarWithEntries(path.join(workDir, 'link.xz'), [
          { name: 'ok.txt', data: 'fine' },
          { name: 'escape', kind: 'symlink', target: '/etc' },
        ])
      );
      await expect(convertWithNative7z(withLink, 'xz', 'tar', {}, 'link.tar.xz')).rejects.toMatchObject({
        name: 'UnsafeArchiveError',
        reason: 'link-entry',
      });

      const withSlip = fs.readFileSync(
        buildTarWithEntries(path.join(workDir, 'slip.xz'), [{ name: '../../../outside/pwned.txt', data: 'pwned' }])
      );
      await expect(convertWithNative7z(withSlip, 'xz', 'tar', {}, 'slip.tar.xz')).rejects.toMatchObject({
        name: 'UnsafeArchiveError',
        reason: 'path-traversal',
      });
    },
    TEST_TIMEOUT_MS
  );
});

describe('in-process route: the same results without any 7-Zip call', () => {
  for (const compressor of COMPRESSORS) {
    oracleTest(
      `${compressor.sources[0]} to tar returns the payload's files with their bytes`,
      [...TOOLS],
      async () => {
        tarFixture ??= buildTarFixture();
        const result = await convertFile(compressor.compress(tarFixture.tar), compressor.sources[0], 'tar', {}, `fixture.${compressor.sources[0]}`);
        for (const [name, data] of tarFixture.files) {
          expect(tarMember(result.buffer, name).equals(data), name).toBe(true);
        }
        expect(tarNames(result.buffer, `inproc-${compressor.sources[0]}`).filter((name) => !name.endsWith('/')).sort()).toEqual([...tarFixture.files.keys()].sort());
        expect(spy.calls()).toHaveLength(0);
      },
      TEST_TIMEOUT_MS
    );
  }

  oracleTest(
    'zst to tar returns the payload files with their bytes through the dispatcher, with no 7-Zip call',
    [...TOOLS],
    async () => {
      tarFixture ??= buildTarFixture();
      const zst = execFileSync('zstd', ['-3', '-q', '-c'], { input: tarFixture.tar });
      const result = await dispatchConversion(zst, 'zst', 'tar', {}, 'fixture.tar.zst');
      for (const [name, data] of tarFixture.files) {
        expect(tarMember(result.buffer, name).equals(data), name).toBe(true);
      }
      expect(spy.calls()).toHaveLength(0);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a payload that is not a tar is wrapped as one member named after the source',
    [...TOOLS],
    async () => {
      const payload = zipfText(80_000, 23);
      const zst = execFileSync('zstd', ['-3', '-q', '-c'], { input: payload });
      for (const [bytes, source] of [
        [COMPRESSORS[0].compress(payload), 'xz'],
        [COMPRESSORS[1].compress(payload), 'gz'],
        [COMPRESSORS[2].compress(payload), 'bz2'],
        [zst, 'zst'],
      ] as const) {
        const result = await convertFile(bytes, source, 'tar', {}, `notes.${source}`);
        expect(tarNames(result.buffer, `inproc-plain-${source}`), source).toEqual(['notes']);
        expect(tarMember(result.buffer, 'notes').equals(payload), source).toBe(true);
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'keeps rebuilding the tar when the request selects entries',
    [...TOOLS],
    async () => {
      tarFixture ??= buildTarFixture();
      const result = await convertFile(
        COMPRESSORS[0].compress(tarFixture.tar),
        'xz',
        'tar',
        { entries: ['docs/a.txt'] },
        'fixture.tar.xz'
      );
      expect(tarNames(result.buffer, 'selected')).toEqual(['docs/a.txt']);
    },
    TEST_TIMEOUT_MS
  );
});
