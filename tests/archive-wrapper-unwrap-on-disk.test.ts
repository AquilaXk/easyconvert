import { afterAll, afterEach, beforeAll, beforeEach, describe, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertWithNative7z } from '../src/worker/engines';
import { UnsafeArchiveError } from '../src/lib/conversions/archive-extraction-safety';
import { jsonRecords, runBytes, zipfText } from './helpers/archive-corpus';
import { oracleTest } from './helpers/oracle-test';
import { createSevenZipSpy, type SevenZipSpy } from './helpers/seven-zip-spy';
import { buildTarWithEntries } from './helpers/hostile-archives';

/**
 * A compressed tar converted to tar yields the members of the tar inside it, whichever route serves the request:
 * the streamed route, which reads the unpacked tar in memory, or the on-disk pipeline (a zero-heap request, or an
 * output past the in-memory budget), which extracts into a directory. The members are listed by the system tar, an
 * independent reader, and the two routes are compared on one input. A compressed file that is not a tar is one
 * member named after the source without its last extension.
 */
const TOOLS = ['7z', 'tar', 'xz', 'gzip', 'bzip2'] as const;
const TEST_TIMEOUT_MS = 120_000;
/** Under the unpacked size of the fixture (about 130 KB), so the streamed route hands the request to the on-disk pipeline. */
const SMALL_BUDGET_BYTES = 64 * 1024;
const FIXED_MTIME = '202103040506';

interface Wrapper {
  /** Registry names a compressed tar goes by, and the one non-tar name used for a plain stream. */
  tarball: string;
  plain: string;
  compress: (input: Buffer) => Buffer;
}

const WRAPPERS: Wrapper[] = [
  { tarball: 'tar.xz', plain: 'xz', compress: (input) => execFileSync('xz', ['-6', '-c'], { input }) },
  { tarball: 'tgz', plain: 'gz', compress: (input) => execFileSync('gzip', ['-6', '-c', '-n'], { input }) },
  { tarball: 'tbz2', plain: 'bz2', compress: (input) => execFileSync('bzip2', ['-9', '-c'], { input }) },
];

let workDir = '';
let spy: SevenZipSpy;
let fixture: { tar: Buffer; files: Map<string, Buffer> };
let previousBudget: string | undefined;

function buildFixture(): { tar: Buffer; files: Map<string, Buffer> } {
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

function listTar(tar: Buffer, label: string): string {
  const file = path.join(workDir, `${label}.tar`);
  fs.writeFileSync(file, tar);
  return execFileSync('tar', ['-tvf', file], { encoding: 'utf8' });
}

/** Mode and name of every member, as the system tar prints them (owner and date columns differ between a tar and its rewrite). */
function modesAndNames(tar: Buffer, label: string): string[] {
  return listTar(tar, label)
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const columns = line.trim().split(/\s+/);
      return `${columns[0]} ${columns.at(-1)}`;
    });
}

function names(tar: Buffer, label: string): string[] {
  const file = path.join(workDir, `names-${label}.tar`);
  fs.writeFileSync(file, tar);
  return execFileSync('tar', ['-tf', file], { encoding: 'utf8' }).split('\n').filter((line) => line !== '');
}

function member(tar: Buffer, name: string): Buffer {
  const file = path.join(workDir, `member-${name.replaceAll('/', '_')}.tar`);
  fs.writeFileSync(file, tar);
  return execFileSync('tar', ['-xOf', file, name], { maxBuffer: 1 << 30 });
}

async function convert(input: Buffer, source: string, filename: string, options: { zeroHeap?: boolean } = {}): Promise<Buffer> {
  const result = await convertWithNative7z(input, source, 'tar', options, filename);
  if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
  return result.buffer ?? fs.readFileSync(result.filePath as string);
}

function extractsToDirectory(call: string[]): boolean {
  return call[0] === 'x' && call.some((argument) => argument.startsWith('-o'));
}

function streamsToPipe(call: string[]): boolean {
  return call[0] === 'x' && call.includes('-so');
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrapper-unwrap-'));
  spy = createSevenZipSpy(workDir);
  fixture = buildFixture();
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  spy.reset();
  spy.install();
  previousBudget = process.env.MAX_IN_MEMORY_BYTES;
});

afterEach(() => {
  spy.restore();
  if (previousBudget === undefined) delete process.env.MAX_IN_MEMORY_BYTES;
  else process.env.MAX_IN_MEMORY_BYTES = previousBudget;
});

describe('on-disk route: a compressed tar comes back as the tar inside it', () => {
  for (const wrapper of WRAPPERS) {
    oracleTest(
      `${wrapper.tarball} to tar with zeroHeap lists the original tar's members, modes and bytes`,
      [...TOOLS],
      async () => {
        const output = await convert(wrapper.compress(fixture.tar), wrapper.tarball, `fixture.${wrapper.tarball}`, { zeroHeap: true });

        expect(spy.calls().some(extractsToDirectory), 'served by the on-disk pipeline').toBe(true);
        expect(spy.calls().some(streamsToPipe), 'not by the streamed route').toBe(false);
        expect(modesAndNames(output, `disk-${wrapper.tarball}`)).toEqual(modesAndNames(fixture.tar, `orig-${wrapper.tarball}`));
        for (const [name, data] of fixture.files) {
          expect(member(output, name).equals(data), name).toBe(true);
        }
      },
      TEST_TIMEOUT_MS
    );

    oracleTest(
      `${wrapper.tarball} to tar past the in-memory budget lists the original tar's members`,
      [...TOOLS],
      async () => {
        process.env.MAX_IN_MEMORY_BYTES = String(SMALL_BUDGET_BYTES);
        const output = await convert(wrapper.compress(fixture.tar), wrapper.tarball, `fixture.${wrapper.tarball}`);

        expect(spy.calls().some(extractsToDirectory), 'served by the on-disk pipeline').toBe(true);
        expect(modesAndNames(output, `budget-${wrapper.tarball}`)).toEqual(modesAndNames(fixture.tar, `budget-orig-${wrapper.tarball}`));
      },
      TEST_TIMEOUT_MS
    );
  }

  oracleTest(
    'the streamed and the on-disk route give the same member list for the same input',
    [...TOOLS],
    async () => {
      for (const wrapper of WRAPPERS) {
        const input = wrapper.compress(fixture.tar);
        const streamed = await convert(input, wrapper.tarball, `fixture.${wrapper.tarball}`);
        const onDisk = await convert(input, wrapper.tarball, `fixture.${wrapper.tarball}`, { zeroHeap: true });
        expect(modesAndNames(onDisk, `same-disk-${wrapper.tarball}`), wrapper.tarball).toEqual(modesAndNames(streamed, `same-stream-${wrapper.tarball}`));
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a compressed tar converted to zip holds the inner members, not the tar as one file',
    [...TOOLS],
    async () => {
      const input = WRAPPERS[0].compress(fixture.tar);
      const result = await convertWithNative7z(input, 'tar.xz', 'zip', {}, 'fixture.tar.xz');
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
      const zip = path.join(workDir, 'to-zip.zip');
      fs.writeFileSync(zip, result.buffer ?? fs.readFileSync(result.filePath as string));
      const listed = execFileSync('7z', ['l', '-slt', '-ba', zip], { encoding: 'utf8' })
        .split('\n')
        .filter((line) => line.startsWith('Path = '))
        .map((line) => line.slice('Path = '.length))
        .sort();
      expect(listed).toEqual(['docs', 'docs/a.txt', 'docs/b.bin', 'docs/deep', 'docs/deep/records.jsonl', 'empty.txt']);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a payload tar holding a symlink is refused on the on-disk route, as it is on the streamed route',
    [...TOOLS],
    async () => {
      const withLink = fs.readFileSync(
        buildTarWithEntries(path.join(workDir, 'link.xz'), [
          { name: 'ok.txt', data: 'fine' },
          { name: 'escape', kind: 'symlink', target: '/etc' },
        ])
      );
      for (const options of [{}, { zeroHeap: true }]) {
        await expect(convertWithNative7z(withLink, 'xz', 'tar', options, 'link.tar.xz'), JSON.stringify(options)).rejects.toBeInstanceOf(UnsafeArchiveError);
      }
    },
    TEST_TIMEOUT_MS
  );
});

describe('on-disk route: a compressed file that is not a tar is one member named after the source', () => {
  for (const wrapper of WRAPPERS) {
    oracleTest(
      `${wrapper.plain} holding a text file becomes a tar with that file as 'notes'`,
      [...TOOLS],
      async () => {
        const payload = zipfText(150_000, 21);
        const output = await convert(wrapper.compress(payload), wrapper.plain, `notes.${wrapper.plain}`, { zeroHeap: true });

        expect(names(output, `plain-disk-${wrapper.plain}`)).toEqual(['notes']);
        expect(member(output, 'notes').equals(payload)).toBe(true);
        const streamed = await convert(wrapper.compress(payload), wrapper.plain, `notes.${wrapper.plain}`);
        expect(names(streamed, `plain-stream-${wrapper.plain}`)).toEqual(['notes']);
      },
      TEST_TIMEOUT_MS
    );
  }

  oracleTest(
    'the member keeps every extension but the last',
    [...TOOLS],
    async () => {
      const payload = zipfText(5_000, 22);
      const output = await convert(WRAPPERS[0].compress(payload), 'xz', 'data.csv.xz', { zeroHeap: true });
      expect(names(output, 'multi-extension')).toEqual(['data.csv']);
      expect(member(output, 'data.csv').equals(payload)).toBe(true);
    },
    TEST_TIMEOUT_MS
  );
});
