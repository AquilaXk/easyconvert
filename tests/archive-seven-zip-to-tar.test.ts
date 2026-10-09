import { afterAll, afterEach, beforeAll, beforeEach, describe, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertWithNative7z } from '../src/worker/engines';
import { jsonRecords, runBytes, zipfText } from './helpers/archive-corpus';
import { getOracleToolPath } from './helpers/differential-oracle';
import { build7zEncrypted, build7zFromStagedLinks, build7zZeroBomb, createHostileWorkspace, type HostileWorkspace } from './helpers/hostile-archives';
import { oracleTest } from './helpers/oracle-test';
import { createSevenZipSpy, type SevenZipSpy } from './helpers/seven-zip-spy';

/**
 * 7z to tar streams the members out of one `7z x -so` call into the tar. The tar is read back with the system tar and
 * every name, mode, size, time and byte is compared with what 7-Zip itself lists for the archive (`7z l -slt`), so the
 * expectation comes from the other tool, not from the code under test. Nothing is extracted to a directory.
 */
const TOOLS = ['7z', 'tar'] as const;
const TEST_TIMEOUT_MS = 120_000;
const MTIME_SECONDS = 1_614_834_360;
const OTHER_MTIME_SECONDS = 1_700_000_000;
const OVER_CAP_BOMB_MIB = 600;

interface TreeFile {
  name: string;
  data: Buffer;
  mode: number;
  mtime: number;
}

const TREE_FILES: TreeFile[] = [
  { name: 'docs/readme.txt', data: zipfText(50_000, 31), mode: 0o640, mtime: MTIME_SECONDS },
  { name: 'docs/deep/records.jsonl', data: jsonRecords(30_000, 32), mode: 0o644, mtime: OTHER_MTIME_SECONDS },
  { name: 'docs/deep/blob.bin', data: runBytes(20_000, 33), mode: 0o755, mtime: MTIME_SECONDS },
  { name: 'empty.txt', data: Buffer.alloc(0), mode: 0o644, mtime: OTHER_MTIME_SECONDS },
  { name: 'zeros.bin', data: Buffer.alloc(4096), mode: 0o600, mtime: MTIME_SECONDS },
];
const TREE_DIRECTORIES = [
  { name: 'emptydir', mode: 0o750, mtime: OTHER_MTIME_SECONDS },
];

/** Switch sets that give 7-Zip's archive layouts a streamed extraction must cut up correctly. */
const LAYOUTS: Array<{ label: string; switches: string[] }> = [
  { label: 'solid LZMA2', switches: ['-ms=on'] },
  { label: 'one folder per file', switches: ['-ms=off'] },
  { label: 'stored, plain header', switches: ['-mx=0', '-mhc=off'] },
  { label: 'BCJ filter chain', switches: ['-m0=BCJ', '-m1=LZMA2', '-ms=on'] },
];

let workDir = '';
let spy: SevenZipSpy;
let treeDir = '';

function buildTree(): void {
  treeDir = path.join(workDir, 'tree');
  for (const file of TREE_FILES) {
    const target = path.join(treeDir, file.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.data);
    fs.chmodSync(target, file.mode);
  }
  for (const directory of TREE_DIRECTORIES) {
    const target = path.join(treeDir, directory.name);
    fs.mkdirSync(target, { recursive: true });
    fs.chmodSync(target, directory.mode);
  }
  for (const entry of [...TREE_FILES, ...TREE_DIRECTORIES]) {
    fs.utimesSync(path.join(treeDir, entry.name), entry.mtime, entry.mtime);
  }
}

function seven(args: string[], cwd: string): string {
  const bin = getOracleToolPath('7z');
  if (bin === null) throw new Error('7z is required');
  return execFileSync(bin, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

interface SevenZipEntry {
  path: string;
  size: number;
  isDirectory: boolean;
  mode: string;
  modifiedMs: number;
}

/** What 7-Zip says the archive holds, in the order it lists it. */
function sevenZipListing(archive: string): SevenZipEntry[] {
  const blocks = seven(['l', '-slt', '-ba', archive], workDir).split('\n\n').filter((block) => block.trim() !== '');
  return blocks.map((block) => {
    const fields = new Map<string, string>();
    for (const line of block.split('\n')) {
      const at = line.indexOf(' = ');
      if (at > 0) fields.set(line.slice(0, at), line.slice(at + 3));
    }
    const attributes = fields.get('Attributes') ?? '';
    const [flag, mode] = attributes.split(' ');
    // 7-Zip prints the time in the local zone.
    const modified = new Date((fields.get('Modified') ?? '').slice(0, 19).replace(' ', 'T')).getTime();
    return {
      path: fields.get('Path') ?? '',
      size: Number(fields.get('Size')),
      isDirectory: flag === 'D',
      mode,
      modifiedMs: modified,
    };
  });
}

interface TarEntry {
  name: string;
  mode: string;
}

/** The names and mode strings `tar -tvf` prints. The date and size columns differ between tar flavours, so they are read from the extracted tree. */
function tarListing(tar: Buffer, label: string): TarEntry[] {
  const file = path.join(workDir, `${label}.tar`);
  fs.writeFileSync(file, tar);
  return execFileSync('tar', ['-tvf', file], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      // The fixture names hold no spaces, so the name is the last column whatever form the date takes.
      const columns = line.trim().split(/\s+/);
      return { mode: columns[0], name: (columns.at(-1) as string).replace(/\/$/, '') };
    });
}

function extractTar(tar: Buffer, label: string): string {
  const file = path.join(workDir, `x-${label}.tar`);
  fs.writeFileSync(file, tar);
  const into = path.join(workDir, `x-${label}`);
  fs.mkdirSync(into, { recursive: true });
  execFileSync('tar', ['-xpf', file, '-C', into]);
  return into;
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seven-zip-to-tar-'));
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

describe('7z to tar keeps names, modes, sizes, times and bytes, from one stream-only 7-Zip call', () => {
  for (const layout of LAYOUTS) {
    oracleTest(
      `${layout.label}`,
      [...TOOLS],
      async () => {
        if (treeDir === '') buildTree();
        const archive = path.join(workDir, `layout-${layout.label.replace(/\W+/g, '-')}.7z`);
        seven(['a', '-t7z', '-y', ...layout.switches, archive, '.'], treeDir);
        const result = await convertWithNative7z(fs.readFileSync(archive), '7z', 'tar', {}, 'tree.7z');
        if (result === null) throw new Error('the native 7-Zip engine declined the conversion');

        const expected = sevenZipListing(archive);
        const listed = tarListing(result.buffer, `layout-${layout.label.replace(/\W+/g, '-')}`);
        expect(listed.map((entry) => entry.name)).toEqual(expected.map((entry) => entry.path));
        expect(listed.map((entry) => entry.mode)).toEqual(expected.map((entry) => entry.mode));

        const extracted = extractTar(result.buffer, layout.label.replace(/\W+/g, '-'));
        for (const entry of expected) {
          const stat = fs.statSync(path.join(extracted, entry.path));
          expect(stat.isDirectory(), entry.path).toBe(entry.isDirectory);
          expect(Math.round(stat.mtimeMs), entry.path).toBe(entry.modifiedMs);
          if (!entry.isDirectory) {
            expect(stat.size, entry.path).toBe(entry.size);
          }
        }
        for (const file of TREE_FILES) {
          expect(fs.readFileSync(path.join(extracted, file.name)).equals(file.data), file.name).toBe(true);
        }

        const calls = spy.calls();
        expect(calls).toHaveLength(1);
        expect(calls[0].slice(0, 3)).toEqual(['x', '-so', '-y']);
        expect(calls[0].some((argument) => argument.startsWith('-o'))).toBe(false);
      },
      TEST_TIMEOUT_MS
    );
  }

  oracleTest(
    'an archive of only directories and empty files needs no 7-Zip call at all',
    [...TOOLS],
    async () => {
      const emptyTree = path.join(workDir, 'empty-tree');
      fs.mkdirSync(path.join(emptyTree, 'a', 'b'), { recursive: true });
      fs.writeFileSync(path.join(emptyTree, 'a', 'nothing.txt'), '');
      const archive = path.join(workDir, 'only-empty.7z');
      seven(['a', '-t7z', '-y', archive, '.'], emptyTree);
      const result = await convertWithNative7z(fs.readFileSync(archive), '7z', 'tar', {}, 'only-empty.7z');
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
      expect(tarListing(result.buffer, 'only-empty').map((entry) => entry.name)).toEqual(sevenZipListing(archive).map((entry) => entry.path));
      expect(spy.calls()).toHaveLength(0);
    },
    TEST_TIMEOUT_MS
  );
});

describe('7z to tar applies the extraction policy to the streamed entries', () => {
  let ws: HostileWorkspace;

  beforeAll(() => {
    ws = createHostileWorkspace();
  });

  afterAll(() => {
    ws.cleanup();
  });

  oracleTest(
    'refuses a traversing name and an absolute name before 7-Zip is asked to extract anything',
    ['7z', 'tar'],
    async () => {
      const stage = path.join(ws.fixturesDir, 'slip-stage');
      fs.mkdirSync(path.join(stage, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(stage, 'evil.txt'), 'evil');
      const traversing = path.join(ws.fixturesDir, 'slip.7z');
      seven(['a', '-t7z', '-spf', '-y', traversing, '../evil.txt'], path.join(stage, 'sub'));
      expect(sevenZipListing(traversing).map((entry) => entry.path)).toContain('../evil.txt');
      const absolute = path.join(ws.fixturesDir, 'absolute.7z');
      seven(['a', '-t7z', '-spf', '-y', absolute, path.join(stage, 'evil.txt')], stage);

      const before = ws.snapshot();
      await ws.withTmpdir(async () => {
        await expect(convertWithNative7z(fs.readFileSync(traversing), '7z', 'tar', {}, 'slip.7z')).rejects.toMatchObject({
          name: 'UnsafeArchiveError',
          reason: 'path-traversal',
        });
        await expect(convertWithNative7z(fs.readFileSync(absolute), '7z', 'tar', {}, 'absolute.7z')).rejects.toMatchObject({
          name: 'UnsafeArchiveError',
          reason: 'absolute-path',
        });
      });
      expect(ws.snapshot()).toEqual(before);
      expect(spy.calls().filter((call) => call[0] === 'x')).toHaveLength(0);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'refuses a symlink member, and with skipLinks leaves it out and reports it',
    ['7z', 'tar'],
    async () => {
      const archive = build7zFromStagedLinks(
        path.join(ws.fixturesDir, 'link.7z'),
        path.join(ws.fixturesDir, 'link-stage'),
        [{ name: 'escape', target: '/etc' }],
        [{ name: 'ok.txt', data: 'fine' }]
      );
      await expect(convertWithNative7z(fs.readFileSync(archive), '7z', 'tar', {}, 'link.7z')).rejects.toMatchObject({
        name: 'UnsafeArchiveError',
        reason: 'link-entry',
      });

      const result = await convertWithNative7z(fs.readFileSync(archive), '7z', 'tar', { skipLinks: true }, 'link.7z');
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
      expect(result.skippedLinks).toEqual(['escape']);
      expect(tarListing(result.buffer, 'skip-links').map((entry) => entry.name)).toEqual(['ok.txt']);
      expect(fs.readFileSync(path.join(extractTar(result.buffer, 'skip-links'), 'ok.txt'), 'utf8')).toBe('fine');
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'refuses an archive that declares more than the size cap without extracting it',
    ['7z', 'tar'],
    async () => {
      const archive = build7zZeroBomb(path.join(ws.fixturesDir, 'bomb.7z'), path.join(ws.fixturesDir, 'bomb-stage'), OVER_CAP_BOMB_MIB);
      await expect(convertWithNative7z(fs.readFileSync(archive), '7z', 'tar', {}, 'bomb.7z')).rejects.toMatchObject({
        name: 'UnsafeArchiveError',
        reason: 'uncompressed-size',
      });
      expect(spy.calls().filter((call) => call[0] === 'x')).toHaveLength(0);
    },
    TEST_TIMEOUT_MS
  );
});

describe('7z to tar failure modes', () => {
  oracleTest(
    'a damaged data stream fails with the typed unreadable-archive error',
    [...TOOLS],
    async () => {
      if (treeDir === '') buildTree();
      const archive = path.join(workDir, 'damaged.7z');
      seven(['a', '-t7z', '-y', '-mx=0', archive, 'zeros.bin', 'docs/readme.txt'], treeDir);
      const bytes = fs.readFileSync(archive);
      bytes[200] ^= 0xff; // inside the stored data, well before the header at the end
      await expect(convertWithNative7z(bytes, '7z', 'tar', {}, 'damaged.7z')).rejects.toMatchObject({
        name: 'UnreadableArchiveError',
        message: expect.stringMatching(/^Could not read the archive: 7-Zip rejected/),
      });
    },
    TEST_TIMEOUT_MS
  );

  for (const encryptHeaders of [true, false]) {
    oracleTest(
      `an encrypted archive (${encryptHeaders ? 'names hidden' : 'names listed'}) is left to the general pipeline, which asks for the password`,
      ['7z', 'tar'],
      async () => {
        const label = encryptHeaders ? 'hidden' : 'listed';
        const archive = build7zEncrypted(
          path.join(workDir, `secret-${label}.7z`),
          path.join(workDir, `secret-stage-${label}`),
          'correct horse',
          [{ name: 'note.txt', data: 'plain words' }],
          encryptHeaders
        );
        await expect(convertWithNative7z(fs.readFileSync(archive), '7z', 'tar', {}, 'secret.7z')).rejects.toMatchObject({
          name: 'ArchivePasswordRequiredError',
        });
        expect(spy.calls().filter((call) => call[0] === 'x' && call.includes('-so'))).toHaveLength(0);
      },
      TEST_TIMEOUT_MS
    );
  }
});
