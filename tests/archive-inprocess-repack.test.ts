import { afterAll, afterEach, beforeAll, beforeEach, describe, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertWithNative7z } from '../src/worker/engines';
import { IN_PROCESS_DEFLATE_MAX_BYTES } from '../src/lib/conversions/archive-repack';
import { jsonRecords, runBytes, sha256Hex, zipfText } from './helpers/archive-corpus';
import { getOracleToolPath } from './helpers/differential-oracle';
import { buildManyEntriesTar, buildTarWithEntries, createHostileWorkspace, type HostileWorkspace } from './helpers/hostile-archives';
import { oracleTest } from './helpers/oracle-test';
import { createSevenZipSpy, type SevenZipSpy } from './helpers/seven-zip-spy';

/**
 * tar to ZIP and tar to gzip are packed in process from the vetted tar: no 7-Zip call, no staging tree. The outputs are
 * read back by tools that are not the product's (`unzip`, `zipinfo`, `7z`, `gzip`, `tar`), every member is compared with
 * the bytes it was made from, and the size is held against the standard tool at the same level (`zip -6`, `gzip -6`).
 */
const TOOLS = ['7z', 'tar', 'zip', 'unzip', 'zipinfo', 'gzip'] as const;
const TEST_TIMEOUT_MS = 180_000;
const MTIME_SECONDS = 1_614_834_360;
const OTHER_MTIME_SECONDS = 1_700_000_000;
/** The size allowance of the parity gate for a compression ratio (bench/rows.ts). */
const RATIO_TOLERANCE = 1.01;
const MIB = 1024 * 1024;

interface Member {
  name: string;
  data: Buffer;
  mode: number;
  mtime: number;
}

const MEMBERS: Member[] = [
  { name: 'docs/readme.txt', data: zipfText(60_000, 51), mode: 0o640, mtime: MTIME_SECONDS },
  { name: 'docs/deep/records.jsonl', data: jsonRecords(40_000, 52), mode: 0o644, mtime: OTHER_MTIME_SECONDS },
  { name: 'docs/deep/blob.bin', data: runBytes(20_000, 53), mode: 0o755, mtime: MTIME_SECONDS },
  { name: 'empty.txt', data: Buffer.alloc(0), mode: 0o644, mtime: OTHER_MTIME_SECONDS },
];

let workDir = '';
let spy: SevenZipSpy;
let treeDir = '';
let fixtureTar: Buffer;

function seven(args: string[], cwd: string): string {
  const bin = getOracleToolPath('7z');
  if (bin === null) throw new Error('7z is required');
  return execFileSync(bin, args, { cwd, encoding: 'utf8', maxBuffer: 256 * MIB });
}

function buildTree(root: string, members: readonly Member[]): void {
  for (const member of members) {
    const target = path.join(root, member.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, member.data);
    fs.chmodSync(target, member.mode);
    fs.utimesSync(target, member.mtime, member.mtime);
  }
}

function tarOf(root: string, entries: string[], name: string): Buffer {
  const tarPath = path.join(workDir, name);
  execFileSync('tar', ['--format=ustar', '-cf', tarPath, '-C', root, ...entries], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  return fs.readFileSync(tarPath);
}

function buildFixtureTar(): Buffer {
  treeDir = path.join(workDir, 'tree');
  buildTree(treeDir, MEMBERS);
  fs.mkdirSync(path.join(treeDir, 'emptydir'));
  fs.chmodSync(path.join(treeDir, 'emptydir'), 0o750);
  fs.utimesSync(path.join(treeDir, 'emptydir'), OTHER_MTIME_SECONDS, OTHER_MTIME_SECONDS);
  return tarOf(treeDir, ['docs', 'empty.txt', 'emptydir'], 'fixture.tar');
}

/** Mode string and path of every entry as `zipinfo` prints them, directories without their slash. */
function zipModes(archive: string): Map<string, string> {
  const modes = new Map<string, string>();
  for (const line of execFileSync('zipinfo', [archive], { encoding: 'utf8' }).split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 9 || !/^[-d]/.test(columns[0])) continue;
    modes.set((columns.at(-1) as string).replace(/\/$/, ''), columns[0]);
  }
  return modes;
}

function tarModes(tar: Buffer): Map<string, string> {
  const file = path.join(workDir, `modes-${tar.length}.tar`);
  fs.writeFileSync(file, tar);
  const modes = new Map<string, string>();
  for (const line of execFileSync('tar', ['-tvf', file], { encoding: 'utf8' }).split('\n').filter((entry) => entry !== '')) {
    const columns = line.trim().split(/\s+/);
    modes.set((columns.at(-1) as string).replace(/\/$/, ''), columns[0]);
  }
  return modes;
}

function sevenZipTimes(archive: string): Map<string, number> {
  const times = new Map<string, number>();
  for (const block of seven(['l', '-slt', '-ba', archive], workDir).split('\n\n')) {
    const fields = new Map<string, string>();
    for (const line of block.split('\n')) {
      const at = line.indexOf(' = ');
      if (at > 0) fields.set(line.slice(0, at), line.slice(at + 3));
    }
    const modified = fields.get('Modified');
    if (fields.has('Path') && modified) times.set(fields.get('Path') as string, new Date(modified.slice(0, 19).replace(' ', 'T')).getTime());
  }
  return times;
}

function writeOut(name: string, bytes: Buffer): string {
  const file = path.join(workDir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

function expectNoSevenZipCall(): void {
  expect(spy.calls(), 'a 7-Zip process was started').toHaveLength(0);
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inprocess-repack-'));
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

describe('tar to ZIP in process', () => {
  oracleTest(
    'writes a ZIP that unzip, zipinfo and 7-Zip accept, with every member, mode and time, and starts no 7-Zip process',
    [...TOOLS],
    async () => {
      fixtureTar ??= buildFixtureTar();
      const result = await convertWithNative7z(fixtureTar, 'tar', 'zip', {}, 'fixture.tar');
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
      const archive = writeOut('out.zip', result.buffer);

      expect(execFileSync('unzip', ['-t', archive], { encoding: 'utf8' })).toContain('No errors detected');
      expect(seven(['t', archive], workDir)).toContain('Everything is Ok');

      const unpacked = path.join(workDir, 'out-unzipped');
      execFileSync('unzip', ['-q', archive, '-d', unpacked]);
      for (const member of MEMBERS) {
        const bytes = fs.readFileSync(path.join(unpacked, member.name));
        expect(sha256Hex(bytes), member.name).toBe(sha256Hex(member.data));
      }
      expect(fs.statSync(path.join(unpacked, 'emptydir')).isDirectory()).toBe(true);

      const modes = tarModes(fixtureTar);
      const zipped = zipModes(archive);
      expect([...zipped.keys()].sort()).toEqual([...modes.keys()].sort());
      for (const [name, mode] of modes) expect(zipped.get(name), name).toBe(mode);

      const times = sevenZipTimes(archive);
      for (const member of MEMBERS) expect(times.get(member.name), member.name).toBe(member.mtime * 1000);
      expectNoSevenZipCall();
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'is no larger than zip -6 on compressible data and honours the requested level',
    [...TOOLS],
    async () => {
      const root = path.join(workDir, 'ratio-tree');
      const members: Member[] = [
        { name: 'a.txt', data: zipfText(400_000, 61), mode: 0o644, mtime: MTIME_SECONDS },
        { name: 'b.jsonl', data: jsonRecords(300_000, 62), mode: 0o644, mtime: MTIME_SECONDS },
      ];
      buildTree(root, members);
      const tar = tarOf(root, ['a.txt', 'b.jsonl'], 'ratio.tar');
      const reference = path.join(workDir, 'reference.zip');
      execFileSync('zip', ['-q', '-6', '-X', reference, 'a.txt', 'b.jsonl'], { cwd: root });

      const defaultLevel = await convertWithNative7z(tar, 'tar', 'zip', {}, 'ratio.tar');
      const fastest = await convertWithNative7z(tar, 'tar', 'zip', { compressionLevel: 1 }, 'ratio.tar');
      const stored = await convertWithNative7z(tar, 'tar', 'zip', { compressionLevel: 0 }, 'ratio.tar');
      if (defaultLevel === null || fastest === null || stored === null) throw new Error('the native 7-Zip engine declined the conversion');

      expect(defaultLevel.buffer.length).toBeLessThanOrEqual(fs.statSync(reference).size * RATIO_TOLERANCE);
      expect(fastest.buffer.length).toBeGreaterThan(defaultLevel.buffer.length);
      expect(stored.buffer.length).toBeGreaterThan(members[0].data.length + members[1].data.length);
      const storedArchive = writeOut('stored.zip', stored.buffer);
      expect(execFileSync('unzip', ['-v', storedArchive], { encoding: 'utf8' })).toMatch(/Stored/);
      expect(execFileSync('unzip', ['-v', storedArchive], { encoding: 'utf8' })).not.toMatch(/Defl/);
      for (const [label, produced] of [['default', defaultLevel], ['level 1', fastest], ['stored', stored]] as const) {
        const archive = writeOut(`level-${label.replace(' ', '')}.zip`, produced.buffer);
        expect(execFileSync('unzip', ['-t', archive], { encoding: 'utf8' }), label).toContain('No errors detected');
        expect(sha256Hex(execFileSync('unzip', ['-p', archive, 'a.txt'], { maxBuffer: 64 * MIB })), label).toBe(sha256Hex(members[0].data));
      }
      expectNoSevenZipCall();
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'leaves a payload past the in-process deflate bound to 7-Zip, which still writes a valid ZIP',
    [...TOOLS],
    async () => {
      const root = path.join(workDir, 'big-tree');
      const big = zipfText(IN_PROCESS_DEFLATE_MAX_BYTES + MIB, 71);
      buildTree(root, [{ name: 'big.txt', data: big, mode: 0o644, mtime: MTIME_SECONDS }]);
      const result = await convertWithNative7z(tarOf(root, ['big.txt'], 'big.tar'), 'tar', 'zip', {}, 'big.tar');
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
      const archive = writeOut('big.zip', result.buffer);
      expect(execFileSync('unzip', ['-t', archive], { encoding: 'utf8' })).toContain('No errors detected');
      expect(sha256Hex(execFileSync('unzip', ['-p', archive, 'big.txt'], { maxBuffer: 64 * MIB }))).toBe(sha256Hex(big));
      expect(spy.calls().some((call) => call.includes('a'))).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a password still takes the general pipeline and the ZIP comes out encrypted',
    [...TOOLS],
    async () => {
      fixtureTar ??= buildFixtureTar();
      const result = await convertWithNative7z(fixtureTar, 'tar', 'zip', { password: 'correct horse' }, 'fixture.tar');
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
      const archive = writeOut('encrypted.zip', result.buffer);
      expect(seven(['l', '-slt', '-ba', '-pcorrect horse', archive], workDir)).toContain('Encrypted = +');
      expect(spy.calls().some((call) => call[0] === 'a')).toBe(true);
    },
    TEST_TIMEOUT_MS
  );
});

describe('tar to gzip in process', () => {
  oracleTest(
    'writes a gzip file that gzip accepts, holding the member, its name and its time, and starts no 7-Zip process',
    [...TOOLS],
    async () => {
      const root = path.join(workDir, 'gz-tree');
      const data = Buffer.concat([zipfText(300_000, 81), jsonRecords(200_000, 82)]);
      buildTree(root, [{ name: 'notes.txt', data, mode: 0o644, mtime: MTIME_SECONDS }]);
      const tar = tarOf(root, ['notes.txt'], 'gz.tar');
      const result = await convertWithNative7z(tar, 'tar', 'gz', {}, 'gz.tar');
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
      const archive = writeOut('out.gz', result.buffer);

      execFileSync('gzip', ['-t', archive]);
      expect(sha256Hex(execFileSync('gzip', ['-d', '-c', archive], { maxBuffer: 64 * MIB }))).toBe(sha256Hex(data));
      // RFC 1952: FLG.FNAME set, MTIME in bytes 4..7, the name follows the 10-byte header.
      expect(result.buffer[3] & 0x08).toBe(0x08);
      expect(result.buffer.readUInt32LE(4)).toBe(MTIME_SECONDS);
      expect(result.buffer.toString('latin1', 10, 10 + 'notes.txt'.length + 1)).toBe('notes.txt\0');
      // A second oracle: gzip -N restores the name and time recorded in the header.
      const restored = path.join(workDir, 'restored');
      fs.mkdirSync(restored, { recursive: true });
      fs.copyFileSync(archive, path.join(restored, 'renamed.gz'));
      execFileSync('gzip', ['-d', '-N', path.join(restored, 'renamed.gz')]);
      expect(fs.readFileSync(path.join(restored, 'notes.txt')).equals(data)).toBe(true);
      expect(Math.floor(fs.statSync(path.join(restored, 'notes.txt')).mtimeMs / 1000)).toBe(MTIME_SECONDS);

      const reference = execFileSync('gzip', ['-6', '-n', '-c', path.join(root, 'notes.txt')], { maxBuffer: 64 * MIB });
      expect(result.buffer.length).toBeLessThanOrEqual(reference.length * RATIO_TOLERANCE);
      expectNoSevenZipCall();
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a tar of several members is not a single stream: 7-Zip is asked and refuses it, as before',
    [...TOOLS],
    async () => {
      fixtureTar ??= buildFixtureTar();
      await expect(convertWithNative7z(fixtureTar, 'tar', 'gz', {}, 'fixture.tar')).rejects.toMatchObject({
        name: 'ConversionFailedError',
        message: expect.stringMatching(/7-Zip failed to create the gz archive/),
      });
      expect(spy.calls().some((call) => call.includes('-tgzip'))).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'stored level writes stored deflate blocks that gzip reads back',
    [...TOOLS],
    async () => {
      const root = path.join(workDir, 'gz-stored');
      const data = zipfText(100_000, 83);
      buildTree(root, [{ name: 'plain.txt', data, mode: 0o644, mtime: MTIME_SECONDS }]);
      const result = await convertWithNative7z(tarOf(root, ['plain.txt'], 'stored.tar'), 'tar', 'gz', { compressionLevel: 0 }, 'stored.tar');
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
      const archive = writeOut('stored.gz', result.buffer);
      expect(result.buffer.length).toBeGreaterThan(data.length);
      expect(sha256Hex(execFileSync('gzip', ['-d', '-c', archive], { maxBuffer: 64 * MIB }))).toBe(sha256Hex(data));
      expectNoSevenZipCall();
    },
    TEST_TIMEOUT_MS
  );
});

describe('the in-process packers apply the extraction policy first', () => {
  let ws: HostileWorkspace;

  beforeAll(() => {
    ws = createHostileWorkspace();
  });

  afterAll(() => {
    ws.cleanup();
  });

  for (const target of ['zip', 'gz'] as const) {
    oracleTest(
      `tar to ${target}: a traversing name is refused with the typed error, nothing is written outside, no process is started`,
      ['7z', 'python3'],
      async () => {
        const tar = fs.readFileSync(buildTarWithEntries(path.join(ws.fixturesDir, `slip-${target}.tar`), [{ name: '../../../outside/pwned.txt', data: 'pwned' }]));
        const before = ws.snapshot();
        await ws.withTmpdir(async () => {
          await expect(convertWithNative7z(tar, 'tar', target, {}, 'slip.tar')).rejects.toMatchObject({ name: 'UnsafeArchiveError', reason: 'path-traversal' });
        });
        expect(ws.snapshot()).toEqual(before);
        expectNoSevenZipCall();
      },
      TEST_TIMEOUT_MS
    );

    oracleTest(
      `tar to ${target}: a symlink member is refused`,
      ['7z', 'python3'],
      async () => {
        const tar = fs.readFileSync(
          buildTarWithEntries(path.join(ws.fixturesDir, `link-${target}.tar`), [
            { name: 'ok.txt', data: 'fine' },
            { name: 'escape', kind: 'symlink', target: '/etc' },
          ])
        );
        await expect(convertWithNative7z(tar, 'tar', target, {}, 'link.tar')).rejects.toMatchObject({ name: 'UnsafeArchiveError', reason: 'link-entry' });
        expectNoSevenZipCall();
      },
      TEST_TIMEOUT_MS
    );

    oracleTest(
      `tar to ${target}: more entries than the cap are refused with the typed count error`,
      ['7z', 'python3'],
      async () => {
        const tar = fs.readFileSync(buildManyEntriesTar(path.join(ws.fixturesDir, `many-${target}.tar`), 50_001));
        await expect(convertWithNative7z(tar, 'tar', target, {}, 'many.tar')).rejects.toMatchObject({ name: 'UnsafeArchiveError', reason: 'entry-count' });
        expectNoSevenZipCall();
      },
      TEST_TIMEOUT_MS
    );
  }

  oracleTest(
    'tar to zip with skipLinks leaves the link out and reports it',
    ['7z', 'python3', 'unzip'],
    async () => {
      const tar = fs.readFileSync(
        buildTarWithEntries(path.join(ws.fixturesDir, 'skip.tar'), [
          { name: 'ok.txt', data: 'fine' },
          { name: 'escape', kind: 'symlink', target: '/etc' },
        ])
      );
      const result = await convertWithNative7z(tar, 'tar', 'zip', { skipLinks: true }, 'skip.tar');
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
      expect(result.skippedLinks).toEqual(['escape']);
      expect(execFileSync('unzip', ['-Z1', writeOut('skip.zip', result.buffer)], { encoding: 'utf8' }).trim()).toBe('ok.txt');
      expectNoSevenZipCall();
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'tar to zip with the overwrite policy keeps the last of two entries for one path',
    ['7z', 'python3', 'unzip'],
    async () => {
      const tar = fs.readFileSync(
        buildTarWithEntries(path.join(ws.fixturesDir, 'dup.tar'), [
          { name: 'same.txt', data: 'first' },
          { name: 'same.txt', data: 'second' },
        ])
      );
      const result = await convertWithNative7z(tar, 'tar', 'zip', { collisionPolicy: 'overwrite' }, 'dup.tar');
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
      const archive = writeOut('dup.zip', result.buffer);
      expect(execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim()).toBe('same.txt');
      expect(execFileSync('unzip', ['-p', archive, 'same.txt'], { encoding: 'utf8' })).toBe('second');
      expectNoSevenZipCall();
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'tar to zip with the default policy still hands duplicate paths to an engine that can rename',
    ['7z', 'python3'],
    async () => {
      const tar = fs.readFileSync(
        buildTarWithEntries(path.join(ws.fixturesDir, 'dup-rename.tar'), [
          { name: 'same.txt', data: 'first' },
          { name: 'same.txt', data: 'second' },
        ])
      );
      await expect(convertWithNative7z(tar, 'tar', 'zip', {}, 'dup-rename.tar')).rejects.toMatchObject({ name: 'NativeRenameUnsupportedError' });
    },
    TEST_TIMEOUT_MS
  );
});
