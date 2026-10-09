import { afterAll, afterEach, beforeAll, beforeEach, describe, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertWithNative7z } from '../src/worker/engines';
import { ARCHIVE_COMPRESSION_LEVEL_DEFAULT } from '../src/lib/conversions/archive-compression-level';
import { zipfText } from './helpers/archive-corpus';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { createSevenZipSpy, type SevenZipSpy } from './helpers/seven-zip-spy';

/**
 * The worker's native route hands `compressionLevel` to 7-Zip as `-mx`. What 7-Zip was asked is read from the spy's
 * recorded argument list; what it produced is read back by 7-Zip itself (`7z x`) and compared by size.
 */
const TOOLS = ['7z', 'tar'] as const;
const TEST_TIMEOUT_MS = 120_000;
const PAYLOAD = zipfText(300_000, 7);

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
  fs.mkdirSync(tree, { recursive: true });
  fs.writeFileSync(path.join(tree, 'text.txt'), PAYLOAD);
  const tarPath = path.join(workDir, 'fixture.tar');
  execFileSync('tar', ['--format=ustar', '-cf', tarPath, '-C', tree, 'text.txt'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  return fs.readFileSync(tarPath);
}

async function convert(target: string, options: Record<string, unknown>): Promise<Buffer> {
  fixtureTar ??= buildFixtureTar();
  spy.reset();
  const result = await convertWithNative7z(fixtureTar, 'tar', target, options, 'fixture.tar');
  if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
  return result.buffer;
}

function packCall(): string[] {
  const calls = spy.calls().filter((call) => call[0] === 'a');
  expect(calls).toHaveLength(1);
  return calls[0];
}

function mxOf(call: string[]): string[] {
  return call.filter((arg) => arg.startsWith('-mx'));
}

function extracted(archive: Buffer, name: string): Buffer {
  const file = path.join(workDir, name);
  fs.writeFileSync(file, archive);
  const out = path.join(workDir, `${name}-unpacked`);
  seven(['x', '-y', `-o${out}`, file], workDir);
  return fs.readFileSync(path.join(out, 'text.txt'));
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-level-'));
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

describe('the native route passes compressionLevel to 7-Zip', () => {
  oracleTest(
    'tar to 7z at level 1 and 9 runs 7z a with -mx=1 / -mx=9, differs in size, and extracts byte-identically',
    [...TOOLS],
    async () => {
      const fast = await convert('7z', { compressionLevel: 1 });
      expect(mxOf(packCall())).toEqual(['-mx=1']);
      const best = await convert('7z', { compressionLevel: 9 });
      expect(mxOf(packCall())).toEqual(['-mx=9']);
      expect(best.length).toBeLessThan(fast.length);
      expect(extracted(fast, 'fast.7z').equals(PAYLOAD)).toBe(true);
      expect(extracted(best, 'best.7z').equals(PAYLOAD)).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'level 0 stores the data (archive larger than the payload)',
    [...TOOLS],
    async () => {
      const stored = await convert('7z', { compressionLevel: 0 });
      expect(mxOf(packCall())).toEqual(['-mx=0']);
      expect(stored.length).toBeGreaterThan(PAYLOAD.length);
      expect(extracted(stored, 'stored.7z').equals(PAYLOAD)).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'an absent option runs at the default level',
    [...TOOLS],
    async () => {
      const implicit = await convert('7z', {});
      expect(mxOf(packCall())).toEqual([`-mx=${ARCHIVE_COMPRESSION_LEVEL_DEFAULT}`]);
      const explicit = await convert('7z', { compressionLevel: ARCHIVE_COMPRESSION_LEVEL_DEFAULT });
      expect(implicit.equals(explicit)).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'tar to zip honours the level',
    [...TOOLS],
    async () => {
      const stored = await convert('zip', { compressionLevel: 0 });
      expect(mxOf(packCall())).toEqual(['-mx=0']);
      const best = await convert('zip', { compressionLevel: 9 });
      expect(mxOf(packCall())).toEqual(['-mx=9']);
      expect(best.length).toBeLessThan(stored.length);
      expect(extracted(best, 'best.zip').equals(PAYLOAD)).toBe(true);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'tar to tar.gz honours the level on the compression step',
    [...TOOLS],
    async () => {
      const fast = await convert('tar.gz', { compressionLevel: 1 });
      const gzipCall = spy.calls().find((call) => call.includes('-tgzip'));
      expect(gzipCall && mxOf(gzipCall)).toEqual(['-mx=1']);
      const best = await convert('tar.gz', { compressionLevel: 9 });
      expect(best.length).toBeLessThan(fast.length);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'an out-of-range or non-integer level is refused as a typed option error and 7-Zip is never run',
    [...TOOLS],
    async () => {
      fixtureTar ??= buildFixtureTar();
      for (const compressionLevel of [10, -1, 4.5, '5']) {
        await expect(
          convertWithNative7z(fixtureTar, 'tar', '7z', { compressionLevel } as never, 'fixture.tar')
        ).rejects.toMatchObject({ name: 'UnsupportedOptionError' });
      }
      expect(spy.calls()).toEqual([]);
    },
    TEST_TIMEOUT_MS
  );
});
