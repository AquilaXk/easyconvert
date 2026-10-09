import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTarEntryHeaders } from '../src/lib/conversions/archive';
import { convertWithNative7z } from '../src/worker/engines';
import { getOracleToolPath } from './helpers/differential-oracle';
import { hostileTarMember, pythonTarEntries, pythonTarMember } from './helpers/hostile-tar';
import { oracleTest } from './helpers/oracle-test';
import { ATTRIBUTE_ARCHIVE, ATTRIBUTE_DIRECTORY, craftSevenZip, S_IFDIR, S_IFLNK, S_IFREG, unixAttributes } from './helpers/seven-zip-craft';
import { createSevenZipSpy, type SevenZipSpy } from './helpers/seven-zip-spy';

/**
 * 7z to tar writes the members 7-Zip would extract. These archives are written byte by byte, because 7-Zip itself
 * would not produce them: a file named like a directory, a symlink that declares gigabytes, a setuid mode. Each is
 * first listed by 7-Zip (what the header says) and the tar is read back with Python's tarfile (what a second
 * reader finds).
 */
const TOOLS = ['7z', 'python3'] as const;
const TEST_TIMEOUT_MS = 120_000;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const SYMLINK_ATTRIBUTES = unixAttributes(S_IFLNK | 0o777, 0x20);

let workDir = '';
let spy: SevenZipSpy;

function sevenZipFields(archive: Buffer, label: string): Map<string, string>[] {
  const file = path.join(workDir, `${label}.7z`);
  fs.writeFileSync(file, archive);
  const bin = getOracleToolPath('7z') as string;
  return execFileSync(bin, ['l', '-slt', '-ba', file], { encoding: 'utf8' })
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => new Map(block.split('\n').flatMap((line) => (line.includes(' = ') ? [[line.slice(0, line.indexOf(' = ')), line.slice(line.indexOf(' = ') + 3)] as [string, string]] : []))));
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seven-zip-hostile-'));
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

describe('a file member whose name ends in a path separator', () => {
  for (const [label, name] of [
    ['slash', 'x/'],
    ['backslash', 'x\\'],
  ] as const) {
    oracleTest(
      `named with a trailing ${label} is refused, so its bytes cannot become tar headers`,
      [...TOOLS],
      async () => {
        const smuggled = hostileTarMember({ name: 'evil.txt' }, Buffer.from('pwned'));
        const archive = craftSevenZip([{ name: 'ok.txt', data: Buffer.from('fine') }, { name, data: smuggled }]);
        const listed = sevenZipFields(archive, `trailing-${label}`);
        expect(listed.map((fields) => [fields.get('Path'), fields.get('Attributes')?.startsWith('A')])).toEqual([
          ['ok.txt', true],
          [name, true],
        ]);

        await expect(convertWithNative7z(archive, '7z', 'tar', {}, 'trailing.7z')).rejects.toMatchObject({
          name: 'UnsafeArchiveError',
          reason: 'invalid-entry-name',
        });
        expect(spy.calls().filter((call) => call[0] === 'x')).toHaveLength(0);
      },
      TEST_TIMEOUT_MS
    );
  }

  oracleTest(
    'does not disturb a directory member named with a trailing slash',
    [...TOOLS],
    async () => {
      const archive = craftSevenZip([{ name: 'docs/', directory: true }, { name: 'docs/a.txt', data: Buffer.from('alpha') }]);
      const result = await convertWithNative7z(archive, '7z', 'tar', {}, 'dirs.7z');
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
      expect(pythonTarEntries(result.buffer).map((entry) => [entry.name, entry.type])).toEqual([
        ['docs', '5'],
        ['docs/a.txt', '0'],
      ]);
      expect(pythonTarMember(result.buffer, 'docs/a.txt').toString()).toBe('alpha');
    },
    TEST_TIMEOUT_MS
  );

  it('cannot be written as a file by the tar header builder', () => {
    expect(() => buildTarEntryHeaders({ filename: 'x/', size: 5, directory: false })).toThrow(/ends with a slash/);
    expect(buildTarEntryHeaders({ filename: 'x/', size: 0 }).subarray(156, 157).toString()).toBe('5');
  });
});

describe('a link member that declares data', () => {
  /** 7-Zip stores a symlink as a member whose data is the target, and `7z x -so` writes that data to the pipe like any file's. */
  function archiveWithLink(declaredSize: number): Buffer {
    return craftSevenZip([
      { name: 'ok.txt', data: Buffer.from('fine') },
      { name: 'link', data: Buffer.from('target'), declaredSize, attributes: SYMLINK_ATTRIBUTES },
    ]);
  }

  oracleTest(
    'counts toward the compression-ratio cap even when links are skipped, before 7-Zip is asked to stream anything',
    [...TOOLS],
    async () => {
      const archive = archiveWithLink(400 * MIB);
      expect(sevenZipFields(archive, 'link-ratio').map((fields) => [fields.get('Path'), fields.get('Size')])).toEqual([
        ['ok.txt', '4'],
        ['link', String(400 * MIB)],
      ]);
      await expect(convertWithNative7z(archive, '7z', 'tar', { skipLinks: true }, 'link-ratio.7z')).rejects.toMatchObject({
        name: 'UnsafeArchiveError',
        reason: 'compression-ratio',
      });
      expect(spy.calls().filter((call) => call[0] === 'x')).toHaveLength(0);
    },
    TEST_TIMEOUT_MS
  );

  for (const gibibytes of [2, 3]) {
    oracleTest(
      `counts toward the size cap when it declares ${gibibytes} GiB: a typed error, not a RangeError from a buffer that large`,
      [...TOOLS],
      async () => {
        const archive = archiveWithLink(gibibytes * GIB);
        const outcome = await convertWithNative7z(archive, '7z', 'tar', { skipLinks: true }, 'link-size.7z').then(
          () => null,
          (error: unknown) => error
        );
        expect(outcome).toBeInstanceOf(Error);
        expect(outcome).not.toBeInstanceOf(RangeError);
        expect(outcome).toMatchObject({ name: 'UnsafeArchiveError', reason: 'uncompressed-size' });
        expect(spy.calls().filter((call) => call[0] === 'x')).toHaveLength(0);
      },
      TEST_TIMEOUT_MS
    );
  }
});

describe('a member with mode bits beyond rwx', () => {
  oracleTest(
    'is written to the tar with the rwx bits only: no setuid, setgid or sticky bit reaches a tar that may be extracted as root',
    [...TOOLS],
    async () => {
      const archive = craftSevenZip([
        { name: 'bin', directory: true, attributes: unixAttributes(S_IFDIR | 0o1777, ATTRIBUTE_DIRECTORY) },
        { name: 'bin/suid', data: Buffer.from('#!/bin/sh\n'), attributes: unixAttributes(S_IFREG | 0o4755, ATTRIBUTE_ARCHIVE) },
        { name: 'bin/sgid', data: Buffer.from('#!/bin/sh\n'), attributes: unixAttributes(S_IFREG | 0o2750, ATTRIBUTE_ARCHIVE) },
        { name: 'bin/plain', data: Buffer.from('x'), attributes: unixAttributes(S_IFREG | 0o640, ATTRIBUTE_ARCHIVE) },
      ]);
      // 7-Zip reports the dangerous modes the header carries.
      expect(sevenZipFields(archive, 'modes').map((fields) => fields.get('Attributes'))).toEqual(['D drwxrwxrwt', 'A -rwsr-xr-x', 'A -rwxr-s---', 'A -rw-r-----']);

      const result = await convertWithNative7z(archive, '7z', 'tar', {}, 'modes.7z');
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');

      expect(pythonTarEntries(result.buffer).map((entry) => [entry.name, entry.mode.toString(8)])).toEqual([
        ['bin', '777'],
        ['bin/suid', '755'],
        ['bin/sgid', '750'],
        ['bin/plain', '640'],
      ]);
    },
    TEST_TIMEOUT_MS
  );
});

describe('a 7z archive read from a file', () => {
  /** Two stored archives that list identically (same names, sizes, layout) but hold different bytes. */
  function twinArchives(): { original: string; swapped: string } {
    const stage = path.join(workDir, 'twin-stage');
    fs.mkdirSync(stage, { recursive: true });
    const bin = getOracleToolPath('7z') as string;
    const build = (label: string, fill: string): string => {
      fs.writeFileSync(path.join(stage, 'a.txt'), fill.repeat(4096));
      const archive = path.join(workDir, `twin-${label}.7z`);
      fs.rmSync(archive, { force: true });
      execFileSync(bin, ['a', '-t7z', '-mx=0', '-mhc=off', '-y', archive, 'a.txt'], { cwd: stage, stdio: 'ignore' });
      return archive;
    };
    return { original: build('original', 'A'), swapped: build('swapped', 'B') };
  }

  oracleTest(
    'is read once: the tar holds the bytes that were vetted, even when the file changes before 7-Zip starts',
    [...TOOLS],
    async () => {
      const { original, swapped } = twinArchives();
      const input = path.join(workDir, 'input.7z');
      fs.copyFileSync(original, input);
      // The moment before 7-Zip opens its input, the file is replaced by another archive with the same table.
      spy.beforeRealRun(`cp '${swapped}' '${input}'`);

      const result = await convertWithNative7z({ inputPath: input }, '7z', 'tar', {}, 'input.7z');
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');

      expect(pythonTarMember(result.buffer, 'a.txt').toString()).toBe('A'.repeat(4096));
      const [call] = spy.calls();
      expect(call).not.toContain(input);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'leaves no copy of the archive behind',
    [...TOOLS],
    async () => {
      const { original } = twinArchives();
      const before = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('easyconvert-') && name.endsWith('.7z'));
      await convertWithNative7z({ inputPath: original }, '7z', 'tar', {}, 'input.7z');
      expect(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('easyconvert-') && name.endsWith('.7z'))).toEqual(before);
    },
    TEST_TIMEOUT_MS
  );
});
