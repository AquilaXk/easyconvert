import { afterAll, afterEach, beforeAll, beforeEach, describe, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertWithNative7z } from '../src/worker/engines';
import { jsonRecords, runBytes, sha256Hex, zipfText } from './helpers/archive-corpus';
import { getOracleToolPath } from './helpers/differential-oracle';
import {
  buildEncryptedZip,
  buildManyEntriesZip,
  buildTarWithEntries,
  buildZeroBombZip,
  buildZipWithEntries,
  createHostileWorkspace,
  type HostileWorkspace,
} from './helpers/hostile-archives';
import { oracleTest } from './helpers/oracle-test';
import { buildStoredRar4 } from './helpers/rar4-stored';
import { createSevenZipSpy, type SevenZipSpy } from './helpers/seven-zip-spy';

/**
 * ZIP and stored RAR to tar, and gzip to tar, are read in process. The tar that comes back is unpacked by the system `tar`
 * and every member is compared with the bytes (and the mode and time) the source archive was made from by a tool that is
 * not the product's (`zip`, `7z`, `gzip`, and the independent RAR writer of the tests, checked by `unrar`). The refusals
 * (traversal, links, bombs, damage, encryption, collisions) are the general pipeline's: they must be the same typed
 * errors with or without the in-process route in front of it.
 */
const TOOLS = ['7z', 'tar', 'zip', 'unzip', 'zipinfo', 'gzip'] as const;
const TEST_TIMEOUT_MS = 180_000;
const MTIME_SECONDS = 1_614_834_360;
const OTHER_MTIME_SECONDS = 1_700_000_000;
const MIB = 1024 * 1024;
const OVER_CAP_BOMB_MIB = 600;
/** Past the 32 MiB output below which the ratio is not judged. */
const RATIO_BOMB_MIB = 40;
const OVER_CAP_ENTRY_COUNT = 50_001;

interface Member {
  name: string;
  data: Buffer;
  mode: number;
  mtime: number;
}

const MEMBERS: Member[] = [
  { name: 'docs/readme.txt', data: zipfText(60_000, 91), mode: 0o640, mtime: MTIME_SECONDS },
  { name: 'docs/deep/records.jsonl', data: jsonRecords(40_000, 92), mode: 0o644, mtime: OTHER_MTIME_SECONDS },
  { name: 'docs/deep/blob.bin', data: runBytes(20_000, 93), mode: 0o755, mtime: MTIME_SECONDS },
  { name: 'empty.txt', data: Buffer.alloc(0), mode: 0o644, mtime: OTHER_MTIME_SECONDS },
];

let workDir = '';
let spy: SevenZipSpy;
let treeDir = '';

function seven(args: string[], cwd: string): string {
  const bin = getOracleToolPath('7z');
  if (bin === null) throw new Error('7z is required');
  return execFileSync(bin, args, { cwd, encoding: 'utf8', maxBuffer: 256 * MIB });
}

function buildTree(): void {
  treeDir = path.join(workDir, 'tree');
  for (const member of MEMBERS) {
    const target = path.join(treeDir, member.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, member.data);
    fs.chmodSync(target, member.mode);
    fs.utimesSync(target, member.mtime, member.mtime);
  }
  fs.mkdirSync(path.join(treeDir, 'emptydir'));
  fs.chmodSync(path.join(treeDir, 'emptydir'), 0o750);
  fs.utimesSync(path.join(treeDir, 'emptydir'), OTHER_MTIME_SECONDS, OTHER_MTIME_SECONDS);
}

/** The tree as an archive written by `zip` (Info-ZIP, with its extended timestamps) or by 7-Zip. */
function buildZip(kind: 'info-zip' | '7z', extra: string[] = []): Buffer {
  if (treeDir === '') buildTree();
  const out = path.join(workDir, `source-${kind}-${extra.join('')}.zip`);
  fs.rmSync(out, { force: true });
  if (kind === 'info-zip') execFileSync('zip', ['-q', '-r', '-6', out, 'docs', 'empty.txt', 'emptydir', ...extra], { cwd: treeDir });
  else seven(['a', '-tzip', '-mx=6', '-y', ...extra, out, 'docs', 'empty.txt', 'emptydir'], treeDir);
  return fs.readFileSync(out);
}

function unpackTar(tar: Buffer, label: string): string {
  const root = path.join(workDir, `unpacked-${label}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(workDir, `${label}.tar`);
  fs.writeFileSync(file, tar);
  execFileSync('tar', ['-xf', file, '-C', root]);
  return root;
}

function tarModes(tar: Buffer, label: string): Map<string, string> {
  const file = path.join(workDir, `modes-${label}.tar`);
  fs.writeFileSync(file, tar);
  const modes = new Map<string, string>();
  for (const line of execFileSync('tar', ['-tvf', file], { encoding: 'utf8' }).split('\n').filter((entry) => entry !== '')) {
    const columns = line.trim().split(/\s+/);
    modes.set((columns.at(-1) as string).replace(/\/$/, ''), columns[0]);
  }
  return modes;
}

function expectMembers(root: string): void {
  for (const member of MEMBERS) {
    const file = path.join(root, member.name);
    expect(sha256Hex(fs.readFileSync(file)), member.name).toBe(sha256Hex(member.data));
    expect(fs.statSync(file).mode & 0o777, `${member.name} mode`).toBe(member.mode);
    expect(Math.floor(fs.statSync(file).mtimeMs / 1000), `${member.name} time`).toBe(member.mtime);
  }
}

function expectNoSevenZipCall(): void {
  expect(spy.calls(), 'a 7-Zip process was started').toHaveLength(0);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected a typed rejection but the operation completed');
    },
    (error: unknown) => error
  );
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inprocess-unpack-'));
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

describe('ZIP to tar in process', () => {
  for (const kind of ['info-zip', '7z'] as const) {
    oracleTest(
      `${kind}: every member keeps its bytes, mode and time, folders are kept, and no 7-Zip process starts`,
      [...TOOLS],
      async () => {
        const zip = buildZip(kind);
        const result = await convertWithNative7z(zip, 'zip', 'tar', {}, 'fixture.zip');
        if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
        const root = unpackTar(result.buffer, `zip-${kind}`);
        expectMembers(root);
        expect(fs.statSync(path.join(root, 'emptydir')).isDirectory()).toBe(true);
        expect(fs.statSync(path.join(root, 'emptydir')).mode & 0o777).toBe(0o750);
        const names = [...tarModes(result.buffer, `zip-${kind}`).keys()].sort();
        expect(names).toEqual(['docs', 'docs/deep', 'docs/deep/blob.bin', 'docs/deep/records.jsonl', 'docs/readme.txt', 'empty.txt', 'emptydir']);
        expectNoSevenZipCall();
      },
      TEST_TIMEOUT_MS
    );
  }

  oracleTest(
    'a ZIP with an entry stored with a method the in-process reader does not decode is served by 7-Zip, with the same bytes',
    [...TOOLS],
    async () => {
      const zip = buildZip('7z', ['-mm=BZip2']);
      expect(execFileSync('unzip', ['-v', writeFile('bzip2.zip', zip)], { encoding: 'utf8' })).toMatch(/BZip2/i);
      const result = await convertWithNative7z(zip, 'zip', 'tar', {}, 'bzip2.zip');
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
      const root = unpackTar(result.buffer, 'zip-bzip2');
      for (const member of MEMBERS) expect(sha256Hex(fs.readFileSync(path.join(root, member.name))), member.name).toBe(sha256Hex(member.data));
      expect(spy.calls().length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a ZIP larger than the sizes the tests use still reads each entry at its declared size and CRC',
    [...TOOLS],
    async () => {
      const dir = path.join(workDir, 'wide');
      fs.mkdirSync(dir, { recursive: true });
      const files = new Map<string, Buffer>();
      for (let i = 0; i < 40; i++) {
        const data = i % 2 === 0 ? zipfText(30_000 + i, 200 + i) : runBytes(9_000 + i, 300 + i);
        files.set(`f${i}.dat`, data);
        fs.writeFileSync(path.join(dir, `f${i}.dat`), data);
      }
      const out = path.join(workDir, 'wide.zip');
      execFileSync('zip', ['-q', '-6', out, ...files.keys()], { cwd: dir });
      const result = await convertWithNative7z(fs.readFileSync(out), 'zip', 'tar', {}, 'wide.zip');
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
      const root = unpackTar(result.buffer, 'wide');
      for (const [name, data] of files) expect(sha256Hex(fs.readFileSync(path.join(root, name))), name).toBe(sha256Hex(data));
      expectNoSevenZipCall();
    },
    TEST_TIMEOUT_MS
  );
});

function writeFile(name: string, bytes: Buffer): string {
  const file = path.join(workDir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

describe('stored RAR to tar in process', () => {
  const entries = [
    { name: 'notes.txt', data: zipfText(50_000, 401) },
    { name: 'data/values.csv', data: jsonRecords(30_000, 402) },
    { name: 'empty.bin', data: Buffer.alloc(0) },
  ];

  oracleTest(
    'every entry keeps its bytes, the input is one unrar accepts, and no 7-Zip process starts',
    ['7z', 'tar', 'unrar'],
    async () => {
      const rar = buildStoredRar4(entries);
      const file = writeFile('stored.rar', rar);
      expect(execFileSync('unrar', ['t', file], { encoding: 'utf8' })).toContain('All OK');
      const result = await convertWithNative7z(rar, 'rar', 'tar', {}, 'stored.rar');
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
      const root = unpackTar(result.buffer, 'rar');
      for (const entry of entries) {
        expect(sha256Hex(fs.readFileSync(path.join(root, entry.name))), entry.name).toBe(sha256Hex(entry.data));
        expect(sha256Hex(execFileSync('unrar', ['p', '-inul', file, entry.name], { maxBuffer: 64 * MIB })), `${entry.name} by unrar`).toBe(sha256Hex(entry.data));
      }
      expect(fs.statSync(path.join(root, 'notes.txt')).mode & 0o777).toBe(0o644);
      expectNoSevenZipCall();
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'an entry whose CRC-32 is wrong is not converted by the in-process reader; the general pipeline decides',
    ['7z', 'tar', 'unrar'],
    async () => {
      const damaged = Buffer.from(buildStoredRar4(entries));
      const at = damaged.indexOf(entries[0].data.subarray(0, 64));
      damaged[at + 10] ^= 0xff;
      await expect(convertWithNative7z(damaged, 'rar', 'tar', {}, 'damaged.rar')).rejects.toMatchObject({
        name: 'UnreadableArchiveError',
        message: "Could not read the archive: the data of 'notes.txt' is damaged (7-Zip reports a data error).",
      });
      expect(spy.calls().length, 'the damaged archive reached 7-Zip').toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a traversing name is refused with the typed error, whichever pipeline reads it',
    ['7z', 'tar'],
    async () => {
      const rar = buildStoredRar4([{ name: '../../escape.txt', data: Buffer.from('pwned') }]);
      await expect(convertWithNative7z(rar, 'rar', 'tar', {}, 'slip.rar')).rejects.toMatchObject({ name: 'UnsafeArchiveError' });
    },
    TEST_TIMEOUT_MS
  );
});

describe('gzip to tar in process: limits hold while the stream is decoded', () => {
  const gzip = (input: Buffer): Buffer => execFileSync('gzip', ['-6', '-c', '-n'], { input, maxBuffer: 1024 * MIB });

  oracleTest(
    'a bomb is cut off at the ratio cap with the typed error and no process',
    ['gzip', 'tar'],
    async () => {
      const bomb = execFileSync('sh', ['-c', 'head -c 400000000 /dev/zero | gzip -9 -c'], { maxBuffer: 64 * MIB });
      const error = await rejection(convertWithNative7z(bomb, 'gz', 'tar', {}, 'bomb.gz'));
      expect(error).toMatchObject({ name: 'UnsafeArchiveError', reason: 'compression-ratio' });
      expectNoSevenZipCall();
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a damaged stream and a cut stream are refused with the typed unreadable-archive error',
    ['gzip', 'tar'],
    async () => {
      const whole = gzip(zipfText(80_000, 411));
      const damaged = Buffer.from(whole);
      damaged[damaged.length >> 1] ^= 0xff;
      await expect(convertWithNative7z(damaged, 'gz', 'tar', {}, 'damaged.gz')).rejects.toMatchObject({ name: 'UnreadableArchiveError' });
      await expect(convertWithNative7z(whole.subarray(0, whole.length >> 1), 'gz', 'tar', {}, 'cut.gz')).rejects.toMatchObject({ name: 'UnreadableArchiveError' });
      expectNoSevenZipCall();
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'two gzip members in one file unpack as one stream, as gzip -d does',
    ['gzip', 'tar'],
    async () => {
      const first = zipfText(30_000, 421);
      const second = zipfText(20_000, 422);
      const joined = Buffer.concat([gzip(first), gzip(second)]);
      const result = await convertWithNative7z(joined, 'gz', 'tar', {}, 'joined.gz');
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
      const root = unpackTar(result.buffer, 'joined');
      expect(sha256Hex(fs.readFileSync(path.join(root, 'joined')))).toBe(sha256Hex(Buffer.concat([first, second])));
      expectNoSevenZipCall();
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a tar payload with a traversing name is refused after the in-process decode',
    ['gzip', 'python3'],
    async () => {
      const ws = createHostileWorkspace();
      try {
        const tar = fs.readFileSync(buildTarWithEntries(path.join(ws.fixturesDir, 'slip.tar'), [{ name: '../../../outside/pwned.txt', data: 'pwned' }]));
        await expect(convertWithNative7z(gzip(tar), 'tar.gz', 'tar', {}, 'slip.tar.gz')).rejects.toMatchObject({ name: 'UnsafeArchiveError', reason: 'path-traversal' });
        expectNoSevenZipCall();
      } finally {
        ws.cleanup();
      }
    },
    TEST_TIMEOUT_MS
  );
});

describe('ZIP to tar refusals are the same typed errors', () => {
  let ws: HostileWorkspace;

  beforeAll(() => {
    ws = createHostileWorkspace();
  });

  afterAll(() => {
    ws.cleanup();
  });

  oracleTest(
    'traversal, symlink, hard-linked-looking names and collisions are refused by name and reason',
    ['7z', 'python3'],
    async () => {
      const slip = buildZipWithEntries(path.join(ws.fixturesDir, 'slip.zip'), [{ name: '../../escape.txt', data: 'pwned' }]);
      const link = buildZipWithEntries(path.join(ws.fixturesDir, 'link.zip'), [
        { name: 'ok.txt', data: 'fine' },
        { name: 'escape', data: '/etc', mode: 0o120777 },
      ]);
      const dup = buildZipWithEntries(path.join(ws.fixturesDir, 'dup.zip'), [
        { name: 'same.txt', data: 'first' },
        { name: 'same.txt', data: 'second' },
      ]);
      const before = ws.snapshot();
      await ws.withTmpdir(async () => {
        expect(await rejection(convertWithNative7z(fs.readFileSync(slip), 'zip', 'tar', {}, 'slip.zip'))).toMatchObject({ name: 'UnsafeArchiveError', reason: 'path-traversal' });
        expect(await rejection(convertWithNative7z(fs.readFileSync(link), 'zip', 'tar', {}, 'link.zip'))).toMatchObject({ name: 'UnsafeArchiveError', reason: 'link-entry' });
        expect(await rejection(convertWithNative7z(fs.readFileSync(dup), 'zip', 'tar', {}, 'dup.zip'))).toMatchObject({ name: 'NativeRenameUnsupportedError' });
        expect(await rejection(convertWithNative7z(fs.readFileSync(dup), 'zip', 'tar', { collisionPolicy: 'error' }, 'dup.zip'))).toMatchObject({ name: 'ArchiveEntryCollisionError' });
      });
      expect(ws.snapshot()).toEqual(before);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'skipLinks leaves a link out and reports it, in process, and overwrite keeps the last of two entries',
    ['7z', 'python3', 'tar'],
    async () => {
      const link = buildZipWithEntries(path.join(ws.fixturesDir, 'link-skip.zip'), [
        { name: 'ok.txt', data: 'fine' },
        { name: 'escape', data: '/etc', mode: 0o120777 },
      ]);
      const skipped = await convertWithNative7z(fs.readFileSync(link), 'zip', 'tar', { skipLinks: true }, 'link.zip');
      if (skipped === null) throw new Error('the native 7-Zip engine declined the conversion');
      expect(skipped.skippedLinks).toEqual(['escape']);
      expect([...tarModes(skipped.buffer, 'skip').keys()]).toEqual(['ok.txt']);
      expectNoSevenZipCall();

      const dup = buildZipWithEntries(path.join(ws.fixturesDir, 'dup-over.zip'), [
        { name: 'same.txt', data: 'first' },
        { name: 'same.txt', data: 'second' },
      ]);
      const kept = await convertWithNative7z(fs.readFileSync(dup), 'zip', 'tar', { collisionPolicy: 'overwrite' }, 'dup.zip');
      if (kept === null) throw new Error('the native 7-Zip engine declined the conversion');
      expect(fs.readFileSync(path.join(unpackTar(kept.buffer, 'overwrite'), 'same.txt'), 'utf8')).toBe('second');
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'size, ratio and entry-count bombs are refused with the typed reasons',
    ['7z', 'python3'],
    async () => {
      const sizeBomb = buildZeroBombZip(path.join(ws.fixturesDir, 'size.zip'), OVER_CAP_BOMB_MIB);
      const ratioBomb = buildZeroBombZip(path.join(ws.fixturesDir, 'ratio.zip'), RATIO_BOMB_MIB);
      const countBomb = buildManyEntriesZip(path.join(ws.fixturesDir, 'count.zip'), OVER_CAP_ENTRY_COUNT);
      const before = ws.snapshot();
      expect(await rejection(convertWithNative7z(fs.readFileSync(sizeBomb), 'zip', 'tar', {}, 'size.zip'))).toMatchObject({ name: 'UnsafeArchiveError', reason: 'uncompressed-size' });
      expect(await rejection(convertWithNative7z(fs.readFileSync(ratioBomb), 'zip', 'tar', {}, 'ratio.zip'))).toMatchObject({ name: 'UnsafeArchiveError', reason: 'compression-ratio' });
      expect(await rejection(convertWithNative7z(fs.readFileSync(countBomb), 'zip', 'tar', {}, 'count.zip'))).toMatchObject({ name: 'UnsafeArchiveError', reason: 'entry-count' });
      expect(ws.snapshot()).toEqual(before);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a ZIP whose entry data no longer matches its CRC-32 is not converted',
    ['7z', 'python3', 'zip'],
    async () => {
      const stored = path.join(ws.fixturesDir, 'crc.zip');
      const dir = path.join(ws.fixturesDir, 'crc-src');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'a.txt'), 'abcdefghij'.repeat(100));
      execFileSync('zip', ['-q', '-0', stored, 'a.txt'], { cwd: dir });
      const bytes = Buffer.from(fs.readFileSync(stored));
      const at = bytes.indexOf('abcdefghij');
      bytes[at + 3] ^= 0x20;
      expect(await rejection(convertWithNative7z(bytes, 'zip', 'tar', {}, 'crc.zip'))).toMatchObject({ name: 'UnreadableArchiveError' });
      expect(spy.calls().length, 'the damaged archive reached 7-Zip').toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'an encrypted ZIP asks for the password, as before',
    ['7z', 'python3'],
    async () => {
      const encrypted = buildEncryptedZip(path.join(ws.fixturesDir, 'enc.zip'), path.join(ws.fixturesDir, 'enc-src'), { password: 'secret', files: [{ name: 'a.txt', data: 'hello' }] });
      expect(await rejection(convertWithNative7z(fs.readFileSync(encrypted), 'zip', 'tar', {}, 'enc.zip'))).toMatchObject({ name: 'ArchivePasswordRequiredError' });
    },
    TEST_TIMEOUT_MS
  );
});
