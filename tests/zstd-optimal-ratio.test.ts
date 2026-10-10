import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compressZstd, decompressZstd } from '../src/lib/conversions/zstd';
import { SeededRandom, jsonRecords, sourceText, zipfText } from './helpers/archive-corpus';
import { oracleTest } from './helpers/oracle-test';
import { expectNoHang } from './helpers/timing';

const MEGABYTE = 1024 * 1024;
const TEST_TIMEOUT_MS = 600_000;
const LEVELS = [16, 17, 18, 19] as const;
/** Level 19 may be this much larger than `zstd -19` (issue acceptance criterion: within 2%). */
const MAX_VS_REFERENCE = 1.02;
const WINDOW_BYTES = 8 * MEGABYTE;
const BLOCK_BYTES = 128 * 1024;
/** The repeat length of the periodic hostile input. */
const PERIOD = 3;
/** A level 19 pass over 16 MB takes seconds; a parser that goes quadratic on repeats needs hours. */
const HOSTILE_HANG_GUARD_MS = 120_000;

const CORPORA: ReadonlyArray<[string, () => Buffer]> = [
  ['English-like prose', () => zipfText(MEGABYTE, 497)],
  ['TypeScript-like source', () => sourceText(MEGABYTE, 498)],
  ['JSON records', () => jsonRecords(MEGABYTE, 499)],
];

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'zstd-optimal-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function referenceSize(data: Buffer, level: number): number {
  return execFileSync('zstd', [`-${level}`, '-q', '-c'], { input: data, maxBuffer: 64 * MEGABYTE }).length;
}

/** The reference decoder: `zstd -t` accepts the frame and `zstd -d` restores exactly the input. */
function expectReferenceRoundTrip(frame: Buffer, original: Buffer, label: string): void {
  withTempDir((dir) => {
    const file = join(dir, 'frame.zst');
    writeFileSync(file, frame);
    execFileSync('zstd', ['-t', '-q', file]);
    const restored = execFileSync('zstd', ['-d', '-q', '-c', file], { maxBuffer: 64 * MEGABYTE });
    expect(restored.length, label).toBe(original.length);
    expect(restored.equals(original), label).toBe(true);
  });
}

describe('zstd level 19 size against the reference encoder', () => {
  for (const [name, make] of CORPORA) {
    oracleTest(
      `stays within 2% of zstd -19 on 1 MB of ${name}`,
      ['zstd'],
      () => {
        const data = make();
        const ours = compressZstd(data, { level: 19 });
        expect(ours.length / referenceSize(data, 19)).toBeLessThanOrEqual(MAX_VS_REFERENCE);
        expectReferenceRoundTrip(ours, data, name);
      },
      TEST_TIMEOUT_MS
    );
  }

  oracleTest(
    'orders the sizes of levels 16-19 and decodes each one with zstd -d',
    ['zstd'],
    () => {
      for (const [name, make] of CORPORA) {
        const data = make().subarray(0, 400_000);
        let previous = Infinity;
        for (const level of LEVELS) {
          const frame = compressZstd(data, { level });
          expect(frame.length, `${name} at level ${level}`).toBeLessThanOrEqual(previous);
          previous = frame.length;
          expectReferenceRoundTrip(frame, data, `${name} at level ${level}`);
        }
      }
    },
    TEST_TIMEOUT_MS
  );
});

describe('zstd optimal parser validity', () => {
  const noise = new SeededRandom(11).bytes(200_000);
  /** Records at a fixed stride: almost every match is a repeat of the previous offset. */
  const strided = Buffer.alloc(150_000);
  for (let i = 0; i < strided.length; i++) strided[i] = i % 40 < 36 ? 0x40 + (i % 40) : (i * 7) & 0xff;
  const mixed = Buffer.concat([zipfText(60_000, 3), noise.subarray(0, 40_000), Buffer.alloc(30_000, 0x61), sourceText(60_000, 4)]);
  const cases: ReadonlyArray<[string, Buffer]> = [
    ['empty', Buffer.alloc(0)],
    ['one byte', Buffer.from([0x41])],
    ['three equal bytes', Buffer.from('aaa')],
    ['a short repeated phrase', Buffer.from('abcabcabcabcabcabcabc')],
    ['a fixed-stride record stream', strided],
    ['mixed text, noise and a run', mixed],
    ['noise', noise],
    ['a block boundary inside a repetition', Buffer.concat([zipfText(BLOCK_BYTES - 1, 5), zipfText(BLOCK_BYTES + 1, 5)])],
    ['exactly one block of text', zipfText(BLOCK_BYTES, 6)],
    ['one block and one byte', zipfText(BLOCK_BYTES + 1, 7)],
  ];

  // The optimal parser takes about a second to encode every case at every level, and two tests read the same frames: they
  // are encoded once, before those two tests, with the time limit the other encoding work of this file has, so that the test
  // that decodes them is measured on decoding (about 20 ms) and not on the load of the shard that runs it. The hook belongs to
  // this block alone: a failure to encode fails these two tests and leaves the fuzzed and window tests to run.
  describe('the frames of the cases at levels 16-19', () => {
    const frames = new Map<string, Buffer>();
    const frameKey = (name: string, level: number): string => `${name} at level ${level}`;
    beforeAll(() => {
      for (const [name, data] of cases) {
        for (const level of LEVELS) {
          try {
            frames.set(frameKey(name, level), compressZstd(data, { level }));
          } catch (error) {
            throw new Error(`encoding ${frameKey(name, level)} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
          }
        }
      }
    }, TEST_TIMEOUT_MS);
    const frameOf = (name: string, level: number): Buffer => {
      const frame = frames.get(frameKey(name, level));
      if (frame === undefined) throw new Error(`no frame was encoded for ${frameKey(name, level)}`);
      return frame;
    };

    oracleTest(
      'every frame passes zstd -t and decodes byte-exact with zstd -d at levels 16-19',
      ['zstd'],
      () => {
        for (const [name, data] of cases) {
          for (const level of LEVELS) expectReferenceRoundTrip(frameOf(name, level), data, frameKey(name, level));
        }
      },
      TEST_TIMEOUT_MS
    );

    it('decodes with this repository decoder at levels 16-19', () => {
      for (const [name, data] of cases) {
        for (const level of LEVELS) {
          const restored = decompressZstd(frameOf(name, level));
          expect(restored.equals(data), frameKey(name, level)).toBe(true);
        }
      }
    });
  });

  oracleTest(
    'fuzzed structured inputs decode with zstd -d at levels 16-19',
    ['zstd'],
    () => {
      const rng = new SeededRandom(2025);
      for (let i = 0; i < 24; i++) {
        const length = rng.below(90_000);
        const alphabet = 1 + rng.below(12);
        const stride = 1 + rng.below(64);
        const data = Buffer.alloc(length);
        for (let k = 0; k < length; k++) data[k] = rng.below(8) === 0 ? rng.below(alphabet) : (k % stride) % alphabet;
        const level = LEVELS[rng.below(LEVELS.length)];
        expectReferenceRoundTrip(compressZstd(data, { level }), data, `case ${i}: ${length} bytes, stride ${stride}, level ${level}`);
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'never matches beyond the declared window',
    ['zstd'],
    () => {
      // The input repeats its first 300 KB at a distance of 8.5 MiB, further than the 8 MiB window the frame declares.
      const head = new SeededRandom(21).bytes(WINDOW_BYTES + 512 * 1024);
      const data = Buffer.concat([head, head.subarray(0, 300_000)]);
      const frame = compressZstd(data, { level: 16 });
      expectReferenceRoundTrip(frame, data, 'repeat beyond the window');
      // Noise does not compress, so a legal frame is at least as large as its input; a match beyond the window would
      // have saved the whole repeated 300 KB.
      expect(frame.length).toBeGreaterThanOrEqual(data.length);
    },
    TEST_TIMEOUT_MS
  );
});

describe('zstd level 19 terminates on repetitive hostile input', () => {
  it('compresses 16 MB of zeros and of a period-3 pattern within the hang guard, restoring each input', async () => {
    // Whether it also stays within 2x the time of 16 MB of random bytes is checked by zstd-optimal-ratio.perf.test.ts.
    const size = 16 * MEGABYTE;
    const zeros = Buffer.alloc(size);
    const periodic = Buffer.alloc(size);
    for (let i = 0; i < size; i++) periodic[i] = 0x11 * ((i % PERIOD) + 1);
    for (const [name, hostile] of [
      ['zeros', zeros],
      ['period 3', periodic],
    ] as const) {
      const frame = await expectNoHang(name, () => compressZstd(hostile, { level: 19 }), HOSTILE_HANG_GUARD_MS);
      expect(decompressZstd(frame).equals(hostile), name).toBe(true);
      expect(frame.length, name).toBeLessThan(size / 1000);
    }
  }, TEST_TIMEOUT_MS);
});
