import { afterAll, afterEach, beforeAll, beforeEach, describe, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertWithNative7z } from '../src/worker/engines';
import { IN_PROCESS_DEFLATE_MAX_BYTES } from '../src/lib/conversions/archive-repack';
import { DEFLATE_BLOCK_BYTES } from '../src/lib/conversions/deflate-blocks';
import { SeededRandom, jsonRecords, sha256Hex, zipfText } from './helpers/archive-corpus';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { createSevenZipSpy, type SevenZipSpy } from './helpers/seven-zip-spy';

/**
 * tar to ZIP and tar to gzip past the in-process deflate bound are encoded by `libdeflate-gzip` run as one process per large
 * entry, not by 7-Zip. The outputs are read by tools that are not the product's (`gzip`, `unzip`, `zipinfo`, `7z`), every
 * entry is compared by SHA-256, the size is held against `gzip -6` / `zip -6`, and the command line libdeflate receives is
 * read from a wrapper that records it.
 */
const TOOLS = ['7z', 'tar', 'zip', 'unzip', 'zipinfo', 'gzip', 'libdeflate-gzip'] as const;
const TEST_TIMEOUT_MS = 240_000;
const MIB = 1024 * 1024;
const MTIME_SECONDS = 1_614_834_360;
const PROCESS_START_WAIT_MS = 30_000;
const PROCESS_EXIT_WAIT_MS = 2000;
const POLL_MS = 25;
/** What each product level (1 to 9) must ask libdeflate for. */
const LIBDEFLATE_LEVEL_OF_PRODUCT_LEVEL = new Map([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 7], [7, 9], [8, 10], [9, 12]]);

let workDir = '';
let sevenZipSpy: SevenZipSpy;
let libdeflateLog = '';
let counter = 0;
const realLibdeflate = (): string => getOracleToolPath('libdeflate-gzip') as string;

/** Text, source-like records and incompressible bytes in one buffer past the in-process bound. */
function mixedPayload(seed: number): Buffer {
  return Buffer.concat([zipfText(3 * MIB, seed), new SeededRandom(seed).bytes(MIB + MIB / 2), jsonRecords(MIB + MIB / 4, seed + 1)]);
}

function writeTool(name: string, body: string): string {
  const file = path.join(workDir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

/** A stand-in for libdeflate-gzip that records its arguments and then runs the real one. */
function recordingLibdeflate(): string {
  return writeTool(`libdeflate-spy-${counter++}.sh`, `echo "$*" >> '${libdeflateLog}'\nexec '${realLibdeflate()}' "$@"`);
}

function libdeflateCalls(): string[] {
  return fs.existsSync(libdeflateLog) ? fs.readFileSync(libdeflateLog, 'utf8').split('\n').filter((line) => line !== '') : [];
}

function tarOf(name: string, members: ReadonlyArray<{ name: string; data: Buffer }>): Buffer {
  const root = path.join(workDir, `tree-${counter++}`);
  for (const member of members) {
    const target = path.join(root, member.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, member.data);
    fs.utimesSync(target, MTIME_SECONDS, MTIME_SECONDS);
  }
  const tarPath = path.join(workDir, name);
  execFileSync('tar', ['--format=ustar', '-cf', tarPath, '-C', root, ...members.map((member) => member.name)], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  return fs.readFileSync(tarPath);
}

function writeOut(name: string, bytes: Buffer): string {
  const file = path.join(workDir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

function referenceZipBytes(name: string, members: ReadonlyArray<{ name: string; data: Buffer }>): number {
  const root = path.join(workDir, `zip-ref-${counter++}`);
  for (const member of members) {
    fs.mkdirSync(path.dirname(path.join(root, member.name)), { recursive: true });
    fs.writeFileSync(path.join(root, member.name), member.data);
  }
  const archive = path.join(workDir, name);
  execFileSync('zip', ['-q', '-6', '-X', archive, ...members.map((member) => member.name)], { cwd: root });
  return fs.statSync(archive).size;
}

function expectZipMembers(archive: string, members: ReadonlyArray<{ name: string; data: Buffer }>): void {
  expect(execFileSync('unzip', ['-t', archive], { encoding: 'utf8' })).toContain('No errors detected');
  expect(execFileSync(getOracleToolPath('7z') as string, ['t', archive], { encoding: 'utf8' })).toContain('Everything is Ok');
  expect(execFileSync('zipinfo', ['-1', archive], { encoding: 'utf8' }).split('\n').filter((line) => line !== '')).toEqual(members.map((member) => member.name));
  for (const member of members) {
    expect(sha256Hex(execFileSync('unzip', ['-p', archive, member.name], { maxBuffer: 256 * MIB })), member.name).toBe(sha256Hex(member.data));
  }
}

async function zipOf(tar: Buffer, options: Record<string, unknown> = {}): Promise<Buffer> {
  const result = await convertWithNative7z(tar, 'tar', 'zip', options, 'big.tar');
  if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
  return result.buffer as Buffer;
}

async function gzipOf(tar: Buffer, options: Record<string, unknown> = {}): Promise<Buffer> {
  const result = await convertWithNative7z(tar, 'tar', 'gz', options, 'big.tar');
  if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
  return result.buffer as Buffer;
}

function withLibdeflate<T>(binary: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.LIBDEFLATE_GZIP_PATH;
  process.env.LIBDEFLATE_GZIP_PATH = binary;
  return run().finally(() => {
    if (previous === undefined) delete process.env.LIBDEFLATE_GZIP_PATH;
    else process.env.LIBDEFLATE_GZIP_PATH = previous;
  });
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-deflate-'));
  libdeflateLog = path.join(workDir, 'libdeflate-calls.log');
  sevenZipSpy = createSevenZipSpy(workDir);
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  sevenZipSpy.reset();
  sevenZipSpy.install();
  fs.rmSync(libdeflateLog, { force: true });
});

afterEach(() => {
  sevenZipSpy.restore();
});

describe('tar to ZIP past the in-process bound', () => {
  oracleTest(
    'encodes the large entry with libdeflate at the level of the default, no larger than zip -6, and starts no 7-Zip process',
    [...TOOLS],
    async () => {
      const members = [{ name: 'big.bin', data: mixedPayload(71) }];
      expect(members[0].data.length).toBeGreaterThan(IN_PROCESS_DEFLATE_MAX_BYTES);
      const archive = writeOut('big.zip', await withLibdeflate(recordingLibdeflate(), async () => zipOf(tarOf('big.tar', members))));
      expectZipMembers(archive, members);
      expect(libdeflateCalls()).toEqual(['-7']);
      expect(sevenZipSpy.calls(), 'a 7-Zip process was started').toHaveLength(0);
      expect(fs.statSync(archive).size).toBeLessThanOrEqual(referenceZipBytes('reference.zip', members));
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'runs one process per large entry and keeps the small entries in process',
    [...TOOLS],
    async () => {
      const members = [
        { name: 'docs/a.txt', data: zipfText(2 * MIB + MIB / 2, 81) },
        { name: 'docs/b.bin', data: Buffer.concat([zipfText(MIB / 2, 82), new SeededRandom(82).bytes(MIB)]) },
        { name: 'docs/small.txt', data: jsonRecords(10_000, 83) },
        { name: 'tiny.txt', data: Buffer.from('tiny') },
      ];
      const archive = writeOut('multi.zip', await withLibdeflate(recordingLibdeflate(), async () => zipOf(tarOf('multi.tar', members))));
      const listed = execFileSync('zipinfo', ['-1', archive], { encoding: 'utf8' }).split('\n').filter((line) => line !== '');
      expect(listed).toEqual(['docs/', ...members.map((member) => member.name)]);
      expect(execFileSync('unzip', ['-t', archive], { encoding: 'utf8' })).toContain('No errors detected');
      for (const member of members) {
        expect(sha256Hex(execFileSync('unzip', ['-p', archive, member.name], { maxBuffer: 256 * MIB })), member.name).toBe(sha256Hex(member.data));
      }
      expect(libdeflateCalls()).toEqual(['-7', '-7']);
      expect(sevenZipSpy.calls()).toHaveLength(0);
      expect(fs.statSync(archive).size).toBeLessThanOrEqual(referenceZipBytes('multi-reference.zip', members));
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'starts no libdeflate process for a tar within the in-process bound, even with an entry of a native size',
    [...TOOLS],
    async () => {
      const members = [{ name: 'within.txt', data: zipfText(MIB, 121) }];
      expect(members[0].data.length).toBeLessThanOrEqual(IN_PROCESS_DEFLATE_MAX_BYTES);
      expect(members[0].data.length).toBeGreaterThanOrEqual(DEFLATE_BLOCK_BYTES);
      const tar = tarOf('within.tar', members);
      const zip = await withLibdeflate(recordingLibdeflate(), async () => zipOf(tar));
      expectZipMembers(writeOut('within.zip', zip), members);
      const gz = await withLibdeflate(recordingLibdeflate(), async () => gzipOf(tar));
      expect(sha256Hex(execFileSync('gzip', ['-dc'], { input: gz, maxBuffer: 16 * MIB }))).toBe(sha256Hex(members[0].data));
      expect(libdeflateCalls()).toEqual([]);
      expect(sevenZipSpy.calls()).toHaveLength(0);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'maps the product levels to the libdeflate levels, writes stored entries without a process at level 0, and a higher level is no larger',
    [...TOOLS],
    async () => {
      const members = [{ name: 'levels.bin', data: mixedPayload(91) }];
      const tar = tarOf('levels.tar', members);
      const sizes = new Map<number, number>();
      for (const [product, libdeflate] of LIBDEFLATE_LEVEL_OF_PRODUCT_LEVEL) {
        fs.rmSync(libdeflateLog, { force: true });
        const zip = await withLibdeflate(recordingLibdeflate(), async () => zipOf(tar, { compressionLevel: product }));
        expect(libdeflateCalls(), `product level ${product}`).toEqual([`-${libdeflate}`]);
        expectZipMembers(writeOut(`level-${product}.zip`, zip), members);
        sizes.set(product, zip.length);
      }
      expect(sizes.get(1)).toBeGreaterThan(sizes.get(6) as number);
      expect(sizes.get(9)).toBeLessThan(sizes.get(6) as number);
      fs.rmSync(libdeflateLog, { force: true });
      const stored = await withLibdeflate(recordingLibdeflate(), async () => zipOf(tar, { compressionLevel: 0 }));
      expect(libdeflateCalls()).toEqual([]);
      expect(execFileSync('unzip', ['-v', writeOut('stored.zip', stored)], { encoding: 'utf8' })).not.toMatch(/Defl/);
      expect(sevenZipSpy.calls()).toHaveLength(0);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'falls back to 7-Zip, which still writes a valid ZIP, when libdeflate-gzip is not installed',
    [...TOOLS],
    async () => {
      const members = [{ name: 'big.bin', data: mixedPayload(101) }];
      const zip = await withLibdeflate(path.join(workDir, 'no-such-libdeflate-gzip'), async () => zipOf(tarOf('fallback.tar', members)));
      expectZipMembers(writeOut('fallback.zip', zip), members);
      expect(sevenZipSpy.calls().some((call) => call.includes('a'))).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'falls back to 7-Zip when the libdeflate process fails or hands back a stream that does not verify',
    [...TOOLS],
    async () => {
      const members = [{ name: 'big.bin', data: mixedPayload(111) }];
      const tar = tarOf('broken.tar', members);
      const failing = writeTool('libdeflate-fails.sh', 'cat > /dev/null\nexit 3');
      // The real stream with the last byte of its CRC-32 trailer changed: the framing is intact, the checksum is not.
      const corrupting = writeTool(
        'libdeflate-corrupts.sh',
        `'${realLibdeflate()}' "$@" > '${path.join(workDir, 'corrupt.out')}'\nsize=$(wc -c < '${path.join(workDir, 'corrupt.out')}')\nhead -c $((size - 5)) '${path.join(workDir, 'corrupt.out')}'\nprintf '\\377'\ntail -c 4 '${path.join(workDir, 'corrupt.out')}'`
      );
      for (const tool of [failing, corrupting]) {
        sevenZipSpy.reset();
        const zip = await withLibdeflate(tool, async () => zipOf(tar));
        expectZipMembers(writeOut(`broken-${path.basename(tool)}.zip`, zip), members);
        expect(sevenZipSpy.calls().some((call) => call.includes('a')), path.basename(tool)).toBe(true);
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'stops the libdeflate process when the request is aborted',
    [...TOOLS],
    async () => {
      const pidFile = path.join(workDir, 'sleeper.pid');
      const sleeper = writeTool('libdeflate-sleeps.sh', `echo $$ > '${pidFile}'\nexec sleep 60`);
      const controller = new AbortController();
      const tar = tarOf('abort.tar', [{ name: 'big.bin', data: mixedPayload(121) }]);
      const pending = withLibdeflate(sleeper, async () => zipOf(tar, { signal: controller.signal })).then(
        () => null,
        (error: unknown) => error
      );
      const startDeadline = Date.now() + PROCESS_START_WAIT_MS;
      while (!fs.existsSync(pidFile) && Date.now() < startDeadline) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      expect(fs.existsSync(pidFile), 'the libdeflate process never started').toBe(true);
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
      expect(alive, 'the libdeflate process was left running').toBe(false);
    },
    TEST_TIMEOUT_MS
  );
});

describe('tar to gzip past the in-process bound', () => {
  oracleTest(
    'writes a gzip file gzip accepts, with the member name and time in the header, no larger than gzip -6, and starts no 7-Zip process',
    [...TOOLS],
    async () => {
      const data = mixedPayload(131);
      const root = path.join(workDir, 'gz-source');
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, 'notes.txt'), data);
      const gz = await withLibdeflate(recordingLibdeflate(), async () => gzipOf(tarOf('gz.tar', [{ name: 'notes.txt', data }])));
      const archive = writeOut('out.gz', gz);
      execFileSync('gzip', ['-t', archive]);
      expect(sha256Hex(execFileSync('gzip', ['-d', '-c', archive], { maxBuffer: 256 * MIB }))).toBe(sha256Hex(data));
      // RFC 1952: FLG.FNAME set, MTIME in bytes 4..7, OS Unix, the name follows the 10-byte header.
      expect(gz[3] & 0x08).toBe(0x08);
      expect(gz.readUInt32LE(4)).toBe(MTIME_SECONDS);
      expect(gz[9]).toBe(3);
      expect(gz.toString('latin1', 10, 10 + 'notes.txt'.length + 1)).toBe('notes.txt\0');
      const restored = path.join(workDir, 'gz-restored');
      fs.mkdirSync(restored, { recursive: true });
      fs.copyFileSync(archive, path.join(restored, 'renamed.gz'));
      execFileSync('gzip', ['-d', '-N', path.join(restored, 'renamed.gz')]);
      expect(sha256Hex(fs.readFileSync(path.join(restored, 'notes.txt')))).toBe(sha256Hex(data));
      expect(Math.floor(fs.statSync(path.join(restored, 'notes.txt')).mtimeMs / 1000)).toBe(MTIME_SECONDS);
      expect(libdeflateCalls()).toEqual(['-7']);
      expect(sevenZipSpy.calls(), 'a 7-Zip process was started').toHaveLength(0);
      const reference = execFileSync('gzip', ['-6', '-n', '-c', path.join(root, 'notes.txt')], { maxBuffer: 256 * MIB });
      expect(gz.length).toBeLessThanOrEqual(reference.length);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'maps the product levels to the libdeflate levels and sets the header hint for the fastest and the best level',
    [...TOOLS],
    async () => {
      const data = mixedPayload(141);
      const tar = tarOf('gz-levels.tar', [{ name: 'levels.bin', data }]);
      for (const [product, libdeflate] of LIBDEFLATE_LEVEL_OF_PRODUCT_LEVEL) {
        fs.rmSync(libdeflateLog, { force: true });
        const gz = await withLibdeflate(recordingLibdeflate(), async () => gzipOf(tar, { compressionLevel: product }));
        expect(libdeflateCalls(), `product level ${product}`).toEqual([`-${libdeflate}`]);
        const archive = writeOut(`gz-level-${product}.gz`, gz);
        execFileSync('gzip', ['-t', archive]);
        expect(sha256Hex(execFileSync('gzip', ['-d', '-c', archive], { maxBuffer: 256 * MIB })), `product level ${product}`).toBe(sha256Hex(data));
        const expectedHint = { 1: 4, 9: 2 }[product as 1 | 9] ?? 0;
        expect(gz[8], `XFL at product level ${product}`).toBe(expectedHint);
      }
      expect(sevenZipSpy.calls()).toHaveLength(0);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'falls back to 7-Zip, which still writes a valid gzip file, when libdeflate-gzip is not installed',
    [...TOOLS],
    async () => {
      const data = mixedPayload(151);
      const gz = await withLibdeflate(path.join(workDir, 'no-such-libdeflate-gzip'), async () => gzipOf(tarOf('gz-fallback.tar', [{ name: 'notes.txt', data }])));
      const archive = writeOut('fallback.gz', gz);
      execFileSync('gzip', ['-t', archive]);
      expect(sha256Hex(execFileSync('gzip', ['-d', '-c', archive], { maxBuffer: 256 * MIB }))).toBe(sha256Hex(data));
      expect(sevenZipSpy.calls().some((call) => call.includes('-tgzip'))).toBe(true);
    },
    TEST_TIMEOUT_MS
  );
});
