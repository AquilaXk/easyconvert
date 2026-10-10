import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertArchive } from '../src/lib/conversions/archive';
import { ConversionFailedError, CorruptStreamError, DecompressionLimitError } from '../src/lib/types';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { expectNoHangOnInput } from './helpers/timing';

/**
 * A gzip, bzip2 or zstd source that is a bomb or malformed keeps the class, and so the HTTP status, of the decoder's
 * failure through convertArchive: 413 for a limit, 400 for a damaged stream. Each bomb is 600 MiB of zeros packed by
 * the reference tool, which also confirms (`-t`) that the fixture is a valid stream.
 */

const MIB = 1024 * 1024;
const BOMB_BYTES = 600 * MIB;
const TIMEOUT_MS = 180_000;

let workDir = '';
let zeros = '';

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'single-stream-typed-'));
  zeros = path.join(workDir, 'zeros.bin');
  const out = fs.openSync(zeros, 'w');
  execFileSync('head', ['-c', String(BOMB_BYTES), '/dev/zero'], { stdio: ['ignore', out, 'inherit'] });
  fs.closeSync(out);
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('the archive was accepted');
}

function pack(tool: string, args: string[]): Buffer {
  const result = spawnSync(getOracleToolPath(tool as 'gzip') as string, [...args, '-c', zeros], { maxBuffer: 64 * MIB });
  expect(result.status).toBe(0);
  return result.stdout;
}

function assertValid(tool: string, stream: Buffer): void {
  const verdict = tool === 'zstd' ? ['-t', '-q'] : ['-t'];
  expect(spawnSync(getOracleToolPath(tool as 'gzip') as string, verdict, { input: stream }).status).toBe(0);
}

describe('decompression bombs answer 413 through convertArchive', () => {
  const cases: Array<[string, string, string[], string]> = [
    ['gzip', 'gzip', ['-9'], 'gz'],
    ['bzip2', 'bzip2', ['-9'], 'bz2'],
    ['zstd', 'zstd', ['-19', '-q', '--long=27'], 'zst'],
  ];
  for (const [label, tool, args, extension] of cases) {
    oracleTest(
      `${label}: 600 MiB of zeros`,
      [tool as 'gzip'],
      async () => {
        const stream = pack(tool, args);
        assertValid(tool, stream);
        const { largeResult } = await expectNoHangOnInput(
          `${label} bomb`,
          (input: Buffer) => failureOf(() => convertArchive(input, extension, 'tar', {}, `zeros.${extension}`)),
          stream,
          60_000
        );
        expect(largeResult).toBeInstanceOf(DecompressionLimitError);
        expect((largeResult as { status?: number }).status).toBe(413);
        expect((largeResult as Error).message).toMatch(/bomb detected|exceeds the (decoder size )?limit/);
      },
      TIMEOUT_MS
    );
  }
});

describe('a damaged stream keeps its 400', () => {
  oracleTest(
    'bzip2 cut in the middle is a CorruptStreamError',
    ['bzip2'],
    async () => {
      const text = Buffer.from('typed bzip2 failure\n'.repeat(5000));
      const whole = execFileSync(getOracleToolPath('bzip2') as string, ['-c'], { input: text });
      const cut = whole.subarray(0, Math.floor(whole.length / 2));
      expect(spawnSync(getOracleToolPath('bzip2') as string, ['-t'], { input: cut }).status).not.toBe(0);
      const error = await failureOf(() => convertArchive(cut, 'bz2', 'tar', {}, 'cut.bz2'));
      expect(error).toBeInstanceOf(CorruptStreamError);
      expect((error as { status?: number }).status).toBe(400);
    }
  );

  oracleTest(
    'gzip with a damaged body is refused as a 400 conversion failure',
    ['gzip'],
    async () => {
      const text = Buffer.from('typed gzip failure\n'.repeat(5000));
      const whole = execFileSync(getOracleToolPath('gzip') as string, ['-c'], { input: text });
      const damaged = Buffer.from(whole);
      damaged[Math.floor(damaged.length / 2)] ^= 0xff;
      expect(spawnSync(getOracleToolPath('gzip') as string, ['-t'], { input: damaged }).status).not.toBe(0);
      const error = await failureOf(() => convertArchive(damaged, 'gz', 'tar', {}, 'damaged.gz'));
      expect(error).toBeInstanceOf(ConversionFailedError);
      expect((error as Error).message).toMatch(/^Failed to decompress GZIP archive 'damaged\.gz'/);
    }
  );

  it('a zstd decoder refusal keeps its own message and answers 400', async () => {
    const error = await failureOf(() => convertArchive(Buffer.from('not a zstd frame at all, just text'), 'zst', 'tar', {}, 'text.zst'));
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect((error as { status?: number }).status).toBeUndefined();
    expect((error as Error).message).toMatch(/^Invalid Zstandard magic signature/);
  });
});
