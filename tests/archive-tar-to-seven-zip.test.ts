import { afterAll, afterEach, beforeAll, beforeEach, describe, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertWithNative7z } from '../src/worker/engines';
import { jsonRecords, runBytes, zipfText } from './helpers/archive-corpus';
import { getOracleToolPath } from './helpers/differential-oracle';
import { buildTarWithEntries, createHostileWorkspace, type HostileWorkspace } from './helpers/hostile-archives';
import { oracleTest } from './helpers/oracle-test';
import { createSevenZipSpy, type SevenZipSpy } from './helpers/seven-zip-spy';

/**
 * tar to 7z reads the tar in process and hands 7-Zip one staging tree to pack: no `7z l`, no `7z x`, no second copy of
 * the members. The 7z written is read back by 7-Zip itself (`7z l -slt`, `7z x`) and compared with what the system
 * `tar` says the input holds.
 */
const TOOLS = ['7z', 'tar'] as const;
const TEST_TIMEOUT_MS = 120_000;
const MTIME_SECONDS = 1_614_834_360;
const OTHER_MTIME_SECONDS = 1_700_000_000;

interface Member {
  name: string;
  data: Buffer;
  mode: number;
  mtime: number;
}

const MEMBERS: Member[] = [
  { name: 'docs/readme.txt', data: zipfText(50_000, 41), mode: 0o640, mtime: MTIME_SECONDS },
  { name: 'docs/deep/records.jsonl', data: jsonRecords(30_000, 42), mode: 0o644, mtime: OTHER_MTIME_SECONDS },
  { name: 'docs/deep/blob.bin', data: runBytes(20_000, 43), mode: 0o755, mtime: MTIME_SECONDS },
  { name: 'empty.txt', data: Buffer.alloc(0), mode: 0o644, mtime: OTHER_MTIME_SECONDS },
];

let workDir = '';
let spy: SevenZipSpy;
let fixtureTar: Buffer;

function seven(args: string[], cwd: string): string {
  const bin = getOracleToolPath('7z');
  if (bin === null) throw new Error('7z is required');
  return execFileSync(bin, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function buildFixtureTar(): Buffer {
  const tree = path.join(workDir, 'tree');
  for (const member of MEMBERS) {
    const target = path.join(tree, member.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, member.data);
    fs.chmodSync(target, member.mode);
    fs.utimesSync(target, member.mtime, member.mtime);
  }
  fs.mkdirSync(path.join(tree, 'emptydir'));
  fs.chmodSync(path.join(tree, 'emptydir'), 0o750);
  fs.utimesSync(path.join(tree, 'emptydir'), OTHER_MTIME_SECONDS, OTHER_MTIME_SECONDS);
  const tarPath = path.join(workDir, 'fixture.tar');
  execFileSync('tar', ['--format=ustar', '-cf', tarPath, '-C', tree, 'docs', 'empty.txt', 'emptydir'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  return fs.readFileSync(tarPath);
}

interface ListedEntry {
  path: string;
  size: number;
  isDirectory: boolean;
  mode: string;
  modifiedMs: number;
  encrypted: boolean;
}

function sevenZipListing(archive: string): ListedEntry[] {
  return seven(['l', '-slt', '-ba', archive], workDir)
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const fields = new Map<string, string>();
      for (const line of block.split('\n')) {
        const at = line.indexOf(' = ');
        if (at > 0) fields.set(line.slice(0, at), line.slice(at + 3));
      }
      const [flag, mode] = (fields.get('Attributes') ?? '').split(' ');
      return {
        path: fields.get('Path') ?? '',
        size: Number(fields.get('Size')),
        isDirectory: flag === 'D',
        mode,
        modifiedMs: new Date((fields.get('Modified') ?? '').slice(0, 19).replace(' ', 'T')).getTime(),
        encrypted: fields.get('Encrypted') === '+',
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}

function tarModeStrings(tar: Buffer): Map<string, string> {
  const file = path.join(workDir, `modes-${tar.length}.tar`);
  fs.writeFileSync(file, tar);
  const modes = new Map<string, string>();
  for (const line of execFileSync('tar', ['-tvf', file], { encoding: 'utf8' }).split('\n').filter((entry) => entry !== '')) {
    const columns = line.trim().split(/\s+/);
    modes.set((columns.at(-1) as string).replace(/\/$/, ''), columns[0]);
  }
  return modes;
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tar-to-seven-zip-'));
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

describe('tar to 7z packs the members in one 7-Zip call', () => {
  oracleTest(
    'keeps names, sizes, modes, times and bytes, and asks 7-Zip only to add the staged tree',
    [...TOOLS],
    async () => {
      fixtureTar ??= buildFixtureTar();
      const result = await convertWithNative7z(fixtureTar, 'tar', '7z', {}, 'fixture.tar');
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
      const archive = path.join(workDir, 'out.7z');
      fs.writeFileSync(archive, result.buffer);

      const listed = sevenZipListing(archive);
      const modes = tarModeStrings(fixtureTar);
      expect(listed.map((entry) => entry.path)).toEqual([...modes.keys()].sort());
      for (const entry of listed) {
        expect(entry.mode, entry.path).toBe(modes.get(entry.path));
        const member = MEMBERS.find((candidate) => candidate.name === entry.path);
        if (member) {
          expect(entry.size, entry.path).toBe(member.data.length);
          expect(entry.modifiedMs, entry.path).toBe(member.mtime * 1000);
        }
      }
      expect(listed.find((entry) => entry.path === 'emptydir')).toMatchObject({ isDirectory: true, modifiedMs: OTHER_MTIME_SECONDS * 1000 });

      const unpacked = path.join(workDir, 'out-unpacked');
      seven(['x', '-y', `-o${unpacked}`, archive], workDir);
      for (const member of MEMBERS) {
        expect(fs.readFileSync(path.join(unpacked, member.name)).equals(member.data), member.name).toBe(true);
      }

      const calls = spy.calls();
      expect(calls).toHaveLength(1);
      expect(calls[0].slice(0, 3)).toEqual(['a', '-y', '-t7z']);
      expect(calls[0].at(-1)).toBe('.');
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a member whose mode grants the owner nothing is still packed, with its bytes',
    ['7z', 'python3'],
    async () => {
      const tarPath = path.join(workDir, 'locked.tar');
      // tarfile writes the mode as given; the system tar could not read a file nobody may open.
      execFileSync('python3', [
        '-c',
        'import sys, tarfile, io\nwith tarfile.open(sys.argv[1], "w") as t:\n    info = tarfile.TarInfo("locked.txt")\n    info.mode = 0\n    info.size = 4\n    t.addfile(info, io.BytesIO(b"kept"))',
        tarPath,
      ]);
      const result = await convertWithNative7z(fs.readFileSync(tarPath), 'tar', '7z', {}, 'locked.tar');
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
      const archive = path.join(workDir, 'locked.7z');
      fs.writeFileSync(archive, result.buffer);
      expect(seven(['x', '-so', '-y', archive], workDir)).toBe('kept');
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a password still takes the general pipeline and the archive comes out encrypted',
    [...TOOLS],
    async () => {
      fixtureTar ??= buildFixtureTar();
      const result = await convertWithNative7z(fixtureTar, 'tar', '7z', { password: 'correct horse' }, 'fixture.tar');
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
      const archive = path.join(workDir, 'encrypted.7z');
      fs.writeFileSync(archive, result.buffer);
      expect(seven(['l', '-slt', '-ba', '-pcorrect horse', archive], workDir)).toContain('Encrypted = +');
      expect(spy.calls().some((call) => call[0] === 'l' || call[0] === 'x')).toBe(true);
    },
    TEST_TIMEOUT_MS
  );
});

describe('tar to 7z applies the extraction policy before anything is staged', () => {
  let ws: HostileWorkspace;

  beforeAll(() => {
    ws = createHostileWorkspace();
  });

  afterAll(() => {
    ws.cleanup();
  });

  oracleTest(
    'refuses a traversing name without calling 7-Zip, and writes nothing outside',
    ['7z', 'python3'],
    async () => {
      const tar = fs.readFileSync(buildTarWithEntries(path.join(ws.fixturesDir, 'slip.tar'), [{ name: '../../../outside/pwned.txt', data: 'pwned' }]));
      const before = ws.snapshot();
      await ws.withTmpdir(async () => {
        await expect(convertWithNative7z(tar, 'tar', '7z', {}, 'slip.tar')).rejects.toMatchObject({
          name: 'UnsafeArchiveError',
          reason: 'path-traversal',
        });
      });
      expect(ws.snapshot()).toEqual(before);
      expect(spy.calls()).toHaveLength(0);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'refuses a symlink member, and with skipLinks leaves it out and reports it',
    ['7z', 'python3'],
    async () => {
      const tar = fs.readFileSync(
        buildTarWithEntries(path.join(ws.fixturesDir, 'link.tar'), [
          { name: 'ok.txt', data: 'fine' },
          { name: 'escape', kind: 'symlink', target: '/etc' },
        ])
      );
      await expect(convertWithNative7z(tar, 'tar', '7z', {}, 'link.tar')).rejects.toMatchObject({
        name: 'UnsafeArchiveError',
        reason: 'link-entry',
      });
      const result = await convertWithNative7z(tar, 'tar', '7z', { skipLinks: true }, 'link.tar');
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
      expect(result.skippedLinks).toEqual(['escape']);
      const archive = path.join(workDir, 'skip-links.7z');
      fs.writeFileSync(archive, result.buffer);
      expect(sevenZipListing(archive).map((entry) => entry.path)).toEqual(['ok.txt']);
    },
    TEST_TIMEOUT_MS
  );
});
