import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertWithNative7z } from '../src/worker/engines';
import { LBZIP2_MAX_BLOCKS, bzip2BlockUnitsOfLevel, lbzip2MaxInputBytes } from '../src/lib/conversions/archive-lbzip2';
import { planNativeArchiveRoute } from '../src/lib/conversions/archive-stream-route';
import { SeededRandom, jsonRecords, runBytes, sha256Hex, zipfText } from './helpers/archive-corpus';
import { getOracleToolPath } from './helpers/differential-oracle';
import { buildManyEntriesTar, buildTarWithEntries, createHostileWorkspace, type HostileWorkspace } from './helpers/hostile-archives';
import { oracleTest } from './helpers/oracle-test';
import { createSevenZipSpy, type SevenZipSpy } from './helpers/seven-zip-spy';

/**
 * tar to tar.bz2 is written by `lbzip2` run as one sandboxed process on the vetted tar, not by 7-Zip. The outputs are read
 * by tools that are not the product's (`bzip2`, `7z`, `tar`), every entry is compared by SHA-256 with the source, the size is
 * held against `bzip2 -9`, and the command line lbzip2 receives is read from a wrapper that records it.
 */
const TOOLS = ['7z', 'tar', 'bzip2', 'lbzip2'] as const;
const HOSTILE_TOOLS = ['7z', 'bzip2', 'lbzip2', 'python3'] as const;
const TEST_TIMEOUT_MS = 180_000;
const MIB = 1024 * 1024;
const MTIME_SECONDS = 1_614_834_360;
const OTHER_MTIME_SECONDS = 1_700_000_000;
const PROCESS_START_WAIT_MS = 30_000;
const PROCESS_EXIT_WAIT_MS = 2000;
const POLL_MS = 25;
const BZIP2_BLOCK_UNIT_BYTES = 100_000;
/** The parity allowance on a compression ratio: the size may exceed the reference's by this share. */
const RATIO_TOLERANCE = 1.01;
/** The block size multiplier (the digit after `BZh`) each product level (0 to 9) must write. */
const BLOCK_UNITS_OF_PRODUCT_LEVEL = new Map([[0, 1], [1, 1], [2, 3], [3, 5], [4, 7], [5, 9], [6, 9], [7, 9], [8, 9], [9, 9]]);

interface Member {
  name: string;
  data: Buffer;
  mode: number;
  mtime: number;
}

const MEMBERS: Member[] = [
  { name: 'docs/readme.txt', data: zipfText(400_000, 61), mode: 0o640, mtime: MTIME_SECONDS },
  { name: 'docs/deep/records.jsonl', data: jsonRecords(500_000, 62), mode: 0o644, mtime: OTHER_MTIME_SECONDS },
  { name: 'docs/deep/blob.bin', data: Buffer.concat([runBytes(100_000, 63), new SeededRandom(63).bytes(200_000)]), mode: 0o755, mtime: MTIME_SECONDS },
  { name: 'empty.txt', data: Buffer.alloc(0), mode: 0o644, mtime: OTHER_MTIME_SECONDS },
];

let workDir = '';
let spy: SevenZipSpy;
let lbzip2Log = '';
let counter = 0;
const realLbzip2 = (): string => getOracleToolPath('lbzip2') as string;

function writeTool(name: string, body: string): string {
  const file = path.join(workDir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

/** A stand-in for lbzip2 that records its arguments and then runs the real one. */
function recordingLbzip2(): string {
  return writeTool(`lbzip2-spy-${counter++}.sh`, `echo "$*" >> '${lbzip2Log}'\nexec '${realLbzip2()}' "$@"`);
}

function lbzip2Calls(): string[] {
  return fs.existsSync(lbzip2Log) ? fs.readFileSync(lbzip2Log, 'utf8').split('\n').filter((line) => line !== '') : [];
}

function withLbzip2<T>(binary: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.LBZIP2_PATH;
  process.env.LBZIP2_PATH = binary;
  return run().finally(() => {
    if (previous === undefined) delete process.env.LBZIP2_PATH;
    else process.env.LBZIP2_PATH = previous;
  });
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

function tarOf(name: string, members: readonly Member[], extra: readonly string[] = []): Buffer {
  const root = path.join(workDir, `tree-${counter++}`);
  buildTree(root, members);
  for (const dir of extra) {
    fs.mkdirSync(path.join(root, dir));
    fs.utimesSync(path.join(root, dir), OTHER_MTIME_SECONDS, OTHER_MTIME_SECONDS);
  }
  const tarPath = path.join(workDir, name);
  const tops = [...new Set([...members.map((member) => member.name.split('/')[0]), ...extra])];
  execFileSync('tar', ['--format=ustar', '-cf', tarPath, '-C', root, ...tops], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  return fs.readFileSync(tarPath);
}

function writeOut(name: string, bytes: Buffer): string {
  const file = path.join(workDir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

async function bz2Of(tar: Buffer, options: Record<string, unknown> = {}, target = 'tar.bz2'): Promise<Buffer> {
  const result = await convertWithNative7z(tar, 'tar', target, options, 'source.tar');
  if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
  return result.buffer as Buffer;
}

/** The decompressed tar, by `bzip2` (not the product's decoder). */
function unbzip2(archive: string): Buffer {
  return execFileSync('bzip2', ['-dc', archive], { maxBuffer: 256 * MIB });
}

/** `mode size mtime-seconds name` for every entry of a tar, read by the system tar after extracting it. */
function extractedFacts(tar: Buffer, name: string): Map<string, { sha: string; mode: number; mtime: number }> {
  const dir = path.join(workDir, `extract-${name}-${counter++}`);
  fs.mkdirSync(dir);
  execFileSync('tar', ['-xpf', '-', '-C', dir], { input: tar });
  const facts = new Map<string, { sha: string; mode: number; mtime: number }>();
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const stat = fs.statSync(full);
        facts.set(path.relative(dir, full), { sha: sha256Hex(fs.readFileSync(full)), mode: stat.mode & 0o777, mtime: Math.floor(stat.mtimeMs / 1000) });
      }
    }
  };
  walk(dir);
  return facts;
}

function expectBzip2Members(archive: string, members: readonly Member[]): void {
  execFileSync('bzip2', ['-t', archive]);
  expect(execFileSync(getOracleToolPath('7z') as string, ['t', archive], { encoding: 'utf8' })).toContain('Everything is Ok');
  const facts = extractedFacts(unbzip2(archive), 'members');
  expect([...facts.keys()].sort()).toEqual(members.map((member) => member.name).sort());
  for (const member of members) {
    expect(facts.get(member.name), member.name).toEqual({ sha: sha256Hex(member.data), mode: member.mode, mtime: member.mtime });
  }
}

function referenceBzip2Bytes(tar: Buffer): number {
  return execFileSync('bzip2', ['-9', '-c'], { input: tar, maxBuffer: 256 * MIB }).length;
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-bzip2-'));
  lbzip2Log = path.join(workDir, 'lbzip2-calls.log');
  spy = createSevenZipSpy(workDir);
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  spy.reset();
  spy.install();
  fs.rmSync(lbzip2Log, { force: true });
});

afterEach(() => {
  spy.restore();
});

describe('tar to tar.bz2 by lbzip2', () => {
  oracleTest(
    'writes a bzip2 stream that bzip2 and 7-Zip read back to every entry with its mode and time, within the parity allowance of bzip2 -9, and starts no 7-Zip process',
    [...TOOLS],
    async () => {
      const tar = tarOf('fixture.tar', MEMBERS);
      const bz2 = await withLbzip2(recordingLbzip2(), () => bz2Of(tar));
      expectBzip2Members(writeOut('out.tar.bz2', bz2), MEMBERS);
      expect(lbzip2Calls()).toEqual([`-c -9 -n ${os.availableParallelism()}`]);
      expect(spy.calls(), 'a 7-Zip process was started').toHaveLength(0);
      expect(bz2.length).toBeLessThanOrEqual(referenceBzip2Bytes(tar) * RATIO_TOLERANCE);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'carries a folder that holds nothing and the names tbz2 and tbz take the same route',
    [...TOOLS],
    async () => {
      const tar = tarOf('with-folder.tar', MEMBERS.slice(0, 2), ['emptydir']);
      for (const target of ['tbz2', 'tbz']) {
        fs.rmSync(lbzip2Log, { force: true });
        const bz2 = await withLbzip2(recordingLbzip2(), () => bz2Of(tar, {}, target));
        const archive = writeOut(`folder-${target}.bz2`, bz2);
        execFileSync('bzip2', ['-t', archive]);
        const listed = execFileSync('tar', ['-tf', '-'], { input: unbzip2(archive), encoding: 'utf8' }).split('\n').filter((line) => line !== '');
        expect(listed.map((name) => name.replace(/\/$/, '')).sort(), target).toEqual(['docs', 'docs/deep', 'docs/deep/records.jsonl', 'docs/readme.txt', 'emptydir']);
        expect(lbzip2Calls(), target).toHaveLength(1);
      }
      expect(spy.calls()).toHaveLength(0);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'maps the product levels to the block sizes 7-Zip wrote and a smaller block is larger',
    [...TOOLS],
    async () => {
      // 150 kB fits the two-block bound of every level, down to level 1 (100 kB blocks).
      const members = [{ name: 'levels.bin', data: Buffer.concat([zipfText(90_000, 71), jsonRecords(60_000, 72)]), mode: 0o644, mtime: MTIME_SECONDS }];
      const tar = tarOf('levels.tar', members);
      const sizes = new Map<number, number>();
      for (const [product, units] of BLOCK_UNITS_OF_PRODUCT_LEVEL) {
        fs.rmSync(lbzip2Log, { force: true });
        const bz2 = await withLbzip2(recordingLbzip2(), () => bz2Of(tar, { compressionLevel: product }));
        expect(bz2.toString('latin1', 0, 4), `product level ${product}`).toBe(`BZh${units}`);
        expect(lbzip2Calls()[0].split(' ')[1], `product level ${product}`).toBe(`-${units}`);
        expectBzip2Members(writeOut(`level-${product}.tar.bz2`, bz2), members);
        sizes.set(product, bz2.length);
      }
      expect(sizes.get(1)).toBeGreaterThan(sizes.get(6) as number);
      expect(spy.calls()).toHaveLength(0);
    },
    TEST_TIMEOUT_MS
  );

  it('maps every product level to the block size units 7-Zip used', () => {
    for (const [product, units] of BLOCK_UNITS_OF_PRODUCT_LEVEL) expect(bzip2BlockUnitsOfLevel(product), `level ${product}`).toBe(units);
    expect(BZIP2_BLOCK_UNIT_BYTES * (BLOCK_UNITS_OF_PRODUCT_LEVEL.get(6) as number)).toBe(900_000);
  });

  oracleTest(
    'writes two blocks for a tar of two blocks and the stream reads back',
    [...TOOLS],
    async () => {
      const members = [{ name: 'two.bin', data: Buffer.concat([zipfText(900_000, 81), new SeededRandom(81).bytes(850_000)]), mode: 0o644, mtime: MTIME_SECONDS }];
      const tar = tarOf('two.tar', members);
      expect(tar.length).toBeLessThanOrEqual(lbzip2MaxInputBytes(6));
      const archive = writeOut('two.tar.bz2', await withLbzip2(recordingLbzip2(), () => bz2Of(tar)));
      expectBzip2Members(archive, members);
      // `bzip2 -tvv` reports every block it checks.
      const report = spawnSync('bzip2', ['-tvv', archive], { encoding: 'utf8' }).stderr;
      expect((report.match(/\[\d+: huff\+mtf/g) ?? []).length).toBe(2);
      expect(lbzip2Calls()).toHaveLength(1);
      expect(spy.calls()).toHaveLength(0);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    `a tar past ${LBZIP2_MAX_BLOCKS} blocks of its level is written by 7-Zip, which keeps the blocks of bzip2 -9 and runs them on all cores`,
    [...TOOLS],
    async () => {
      const members = [{ name: 'large.bin', data: Buffer.concat([zipfText(MIB, 91), new SeededRandom(91).bytes(MIB)]), mode: 0o644, mtime: MTIME_SECONDS }];
      const tar = tarOf('large.tar', members);
      expect(tar.length).toBeGreaterThan(lbzip2MaxInputBytes(6));
      const bz2 = await withLbzip2(recordingLbzip2(), () => bz2Of(tar));
      expectBzip2Members(writeOut('large.tar.bz2', bz2), members);
      expect(lbzip2Calls()).toEqual([]);
      expect(spy.calls().some((call) => call.includes('-tbzip2'))).toBe(true);
      expect(bz2.length).toBeLessThanOrEqual(referenceBzip2Bytes(tar) * RATIO_TOLERANCE);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'the bound follows the block size of the level: 300 kB is within two blocks at level 6 and past them at level 1',
    [...TOOLS],
    async () => {
      const members = [{ name: 'bound.bin', data: zipfText(300_000, 95), mode: 0o644, mtime: MTIME_SECONDS }];
      const tar = tarOf('bound.tar', members);
      await withLbzip2(recordingLbzip2(), () => bz2Of(tar, { compressionLevel: 6 }));
      expect(lbzip2Calls()).toHaveLength(1);
      expect(spy.calls()).toHaveLength(0);
      fs.rmSync(lbzip2Log, { force: true });
      const bz2 = await withLbzip2(recordingLbzip2(), () => bz2Of(tar, { compressionLevel: 1 }));
      expectBzip2Members(writeOut('bound-1.tar.bz2', bz2), members);
      expect(lbzip2Calls()).toEqual([]);
      expect(spy.calls().some((call) => call.includes('-tbzip2'))).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'falls back to 7-Zip, which still writes a valid tar.bz2, when lbzip2 is not installed',
    [...TOOLS],
    async () => {
      const bz2 = await withLbzip2(path.join(workDir, 'no-such-lbzip2'), () => bz2Of(tarOf('fallback.tar', MEMBERS)));
      expectBzip2Members(writeOut('fallback.tar.bz2', bz2), MEMBERS);
      expect(spy.calls().some((call) => call.includes('-tbzip2'))).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'falls back to 7-Zip when the lbzip2 process fails or hands back bytes that are not a bzip2 stream',
    [...TOOLS],
    async () => {
      const tar = tarOf('broken.tar', MEMBERS);
      const failing = writeTool('lbzip2-fails.sh', 'cat > /dev/null\nexit 3');
      const notBzip2 = writeTool('lbzip2-garbage.sh', "cat > /dev/null\nprintf 'this is not a bzip2 stream at all'");
      const wrongBlockSize = writeTool('lbzip2-wrong-block.sh', `exec '${realLbzip2()}' -c -1 -n 1`);
      for (const tool of [failing, notBzip2, wrongBlockSize]) {
        spy.reset();
        const bz2 = await withLbzip2(tool, () => bz2Of(tar));
        expectBzip2Members(writeOut(`broken-${path.basename(tool)}.tar.bz2`, bz2), MEMBERS);
        expect(spy.calls().some((call) => call.includes('-tbzip2')), path.basename(tool)).toBe(true);
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'stops the lbzip2 process when the request is aborted',
    [...TOOLS],
    async () => {
      const pidFile = path.join(workDir, 'sleeper.pid');
      const sleeper = writeTool('lbzip2-sleeps.sh', `echo $$ > '${pidFile}'\nexec sleep 60`);
      const controller = new AbortController();
      const tar = tarOf('abort.tar', MEMBERS);
      const pending = withLbzip2(sleeper, () => bz2Of(tar, { signal: controller.signal })).then(
        () => null,
        (error: unknown) => error
      );
      const startDeadline = Date.now() + PROCESS_START_WAIT_MS;
      while (!fs.existsSync(pidFile) && Date.now() < startDeadline) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      expect(fs.existsSync(pidFile), 'the lbzip2 process never started').toBe(true);
      const aborted = Date.now();
      controller.abort();
      const error = await pending;
      expect(error).toBeInstanceOf(Error);
      expect(Date.now() - aborted).toBeLessThan(PROCESS_EXIT_WAIT_MS);
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      const deadline = Date.now() + PROCESS_EXIT_WAIT_MS;
      let alive = true;
      while (alive && Date.now() < deadline) {
        try {
          process.kill(pid, 0);
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        } catch {
          alive = false;
        }
      }
      expect(alive, 'the lbzip2 process was left running').toBe(false);
    },
    TEST_TIMEOUT_MS
  );
});

describe('tar to tar.bz2 applies the extraction policy before lbzip2 runs', () => {
  let ws: HostileWorkspace;

  beforeAll(() => {
    ws = createHostileWorkspace();
  });

  afterAll(() => {
    ws.cleanup();
  });

  oracleTest(
    'a traversing name is refused with the typed error, nothing is written outside, no process is started',
    [...HOSTILE_TOOLS],
    async () => {
      const tar = fs.readFileSync(buildTarWithEntries(path.join(ws.fixturesDir, 'slip.tar'), [{ name: '../../../outside/pwned.txt', data: 'pwned' }]));
      const before = ws.snapshot();
      await ws.withTmpdir(async () => {
        await expect(withLbzip2(recordingLbzip2(), () => bz2Of(tar))).rejects.toMatchObject({ name: 'UnsafeArchiveError', reason: 'path-traversal' });
      });
      expect(ws.snapshot()).toEqual(before);
      expect(lbzip2Calls()).toEqual([]);
      expect(spy.calls()).toHaveLength(0);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a symlink member is refused, and with skipLinks it is left out and reported',
    [...HOSTILE_TOOLS],
    async () => {
      const tar = fs.readFileSync(
        buildTarWithEntries(path.join(ws.fixturesDir, 'link.tar'), [
          { name: 'ok.txt', data: 'fine' },
          { name: 'escape', kind: 'symlink', target: '/etc' },
        ])
      );
      await expect(withLbzip2(recordingLbzip2(), () => bz2Of(tar))).rejects.toMatchObject({ name: 'UnsafeArchiveError', reason: 'link-entry' });
      expect(lbzip2Calls()).toEqual([]);
      const result = await withLbzip2(recordingLbzip2(), () => convertWithNative7z(tar, 'tar', 'tar.bz2', { skipLinks: true }, 'link.tar'));
      if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
      expect(result.skippedLinks).toEqual(['escape']);
      const archive = writeOut('skip.tar.bz2', result.buffer as Buffer);
      expect(execFileSync('tar', ['-tf', '-'], { input: unbzip2(archive), encoding: 'utf8' }).trim()).toBe('ok.txt');
      expect(lbzip2Calls()).toHaveLength(1);
      expect(spy.calls()).toHaveLength(0);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a tar past the bound with more entries than the cap is refused by the 7-Zip route with the typed count error, and lbzip2 never runs',
    [...HOSTILE_TOOLS],
    async () => {
      const tar = fs.readFileSync(buildManyEntriesTar(path.join(ws.fixturesDir, 'many.tar'), 50_001));
      expect(tar.length).toBeGreaterThan(lbzip2MaxInputBytes(6));
      await expect(withLbzip2(recordingLbzip2(), () => bz2Of(tar))).rejects.toMatchObject({ name: 'UnsafeArchiveError', reason: 'entry-count' });
      expect(lbzip2Calls()).toEqual([]);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'with the overwrite policy the last of two entries for one path is kept',
    [...HOSTILE_TOOLS],
    async () => {
      const tar = fs.readFileSync(
        buildTarWithEntries(path.join(ws.fixturesDir, 'dup.tar'), [
          { name: 'same.txt', data: 'first' },
          { name: 'same.txt', data: 'second' },
        ])
      );
      const archive = writeOut('dup.tar.bz2', await withLbzip2(recordingLbzip2(), () => bz2Of(tar, { collisionPolicy: 'overwrite' })));
      const unpacked = unbzip2(archive);
      expect(execFileSync('tar', ['-tf', '-'], { input: unpacked, encoding: 'utf8' }).trim()).toBe('same.txt');
      expect(execFileSync('tar', ['-xOf', '-'], { input: unpacked, encoding: 'utf8' })).toBe('second');
    },
    TEST_TIMEOUT_MS
  );
});

describe('the route for tar to a bzip2 tarball', () => {
  const plain = {};

  it('is chosen for every name of the target and only from a tar', () => {
    for (const target of ['tar.bz2', 'tbz2', 'tbz']) expect(planNativeArchiveRoute('tar', target, plain), target).toEqual({ kind: 'tar-to-bzip2' });
    expect(planNativeArchiveRoute('zip', 'tar.bz2', plain)).toBeNull();
    expect(planNativeArchiveRoute('tar.gz', 'tar.bz2', plain)).toBeNull();
  });

  it('is not taken for a request the streaming routes cannot serve', () => {
    expect(planNativeArchiveRoute('tar', 'tar.bz2', { password: 'secret' })).toBeNull();
    expect(planNativeArchiveRoute('tar', 'tar.bz2', { zeroHeap: true })).toBeNull();
    expect(planNativeArchiveRoute('tar', 'tar.bz2', { entries: ['a.txt'] })).toBeNull();
    expect(planNativeArchiveRoute('tar', 'tar.bz2', { archiveParts: [Buffer.alloc(0)] })).toBeNull();
  });
});
