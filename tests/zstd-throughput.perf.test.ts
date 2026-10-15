import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compressZstd, compressZstdAsync, decompressZstd } from '../src/lib/conversions/zstd';
import { getOracleToolPath } from './helpers/differential-oracle';
import { shutdownCpuPool } from '../src/lib/workers/cpu-pool';
import { oracleTest } from './helpers/oracle-test';
import { expectNoSlowerThanReference } from './helpers/timing';

/**
 * Throughput of the in-process Zstandard engine against the `zstd` command line on the benchmark's mixed corpus
 * (JSON records followed by PCM audio). The reference time includes starting the process, as it does in
 * `npm run bench:quality`: the target is that the in-process engine reaches at least 0.8x of the tool's speed, i.e.
 * takes no more than 1.25x its time (MAX_TIME_RATIO says what the CI runner holds). Both sides run interleaved in
 * this process and the best pass of each is kept, so the ratio does not depend on how fast the runner is. A slow runner can opt out explicitly with
 * ARCHIVE_SKIP_TIMING=1; nothing skips silently in CI.
 */
// skip-ok: explicit opt-out (ARCHIVE_SKIP_TIMING=1) of the timing ratios on a slow shared runner, never set in CI.
const SKIP_TIMING = process.env.ARCHIVE_SKIP_TIMING === '1';
const TEST_TIMEOUT_MS = 180_000;
/**
 * Decompression: the engine takes about 0.7x the time of the tool locally. It took 1.36x on the CI runner before the
 * Huffman literals were read through a 32-bit container and short copies went by words, and the bound was 1.6; it is the
 * 1.25x target again.
 */
const MAX_TIME_RATIO = 1.25;
/**
 * Compression is held to 1.5x: the product compresses a frame of the fast levels in jobs on the pool threads and the
 * calling thread (zstd-jobs.ts), which takes about the time of the tool locally (the tool is native code and parses with
 * a leaner two-table finder; one thread of ours takes 2.5x to 3x as long). The synchronous encoder runs the same jobs one
 * after another and is not what the conversion calls.
 */
const MAX_COMPRESS_TIME_RATIO = 1.5;
const COMPARE_PASSES = 7;
/**
 * One run of either side takes 5 ms to 30 ms on the mixed corpus, where scheduler noise alone moves the ratio by
 * 10%. Each timed sample repeats the work this many times, so a sample lasts 100 ms or more.
 */
const RUNS_PER_SAMPLE = 20;
const BENCH_CORPUS = path.resolve(__dirname, '..', 'bench', 'corpus');
const COMPARE_LEVEL = 3;

function repeated(run: () => unknown): () => void {
  return () => {
    for (let i = 0; i < RUNS_PER_SAMPLE; i++) run();
  };
}

function repeatedAsync(run: () => Promise<unknown>): () => Promise<void> {
  return async () => {
    for (let i = 0; i < RUNS_PER_SAMPLE; i++) await run();
  };
}

function mixedCorpus(): Buffer {
  return Buffer.concat([fs.readFileSync(path.join(BENCH_CORPUS, 'data', 'records.jsonl')), fs.readFileSync(path.join(BENCH_CORPUS, 'speech.wav'))]);
}

afterAll(async () => {
  await shutdownCpuPool();
});

describe.skipIf(SKIP_TIMING)('Zstandard engine speed against the zstd command line', () => {
  oracleTest(
    `decompresses a level-3 stream in no more than ${MAX_TIME_RATIO}x the time of \`zstd -d\``,
    ['zstd'],
    async () => {
      const zstd = getOracleToolPath('zstd')!;
      const original = mixedCorpus();
      const stream = execFileSync(zstd, [`-${COMPARE_LEVEL}`, '-q', '-c'], { input: original, maxBuffer: 1 << 26 });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zstd-speed-'));
      const file = path.join(dir, 'mixed.zst');
      fs.writeFileSync(file, stream);
      expect(decompressZstd(stream).equals(original)).toBe(true);
      await expectNoSlowerThanReference(
        'zstd decompress',
        repeated(() => execFileSync(zstd, ['-d', '-q', '-c', file], { maxBuffer: 1 << 26 })),
        repeated(() => decompressZstd(stream)),
        { maxRatio: MAX_TIME_RATIO, passes: COMPARE_PASSES }
      );
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    `compresses at level 3 in no more than ${MAX_COMPRESS_TIME_RATIO}x the time of \`zstd -3\`, to a stream \`zstd -d\` restores, within 1% of its size`,
    ['zstd'],
    async () => {
      const zstd = getOracleToolPath('zstd')!;
      const original = mixedCorpus();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zstd-speed-'));
      const file = path.join(dir, 'mixed.bin');
      fs.writeFileSync(file, original);
      const ours = await compressZstdAsync(original, { level: COMPARE_LEVEL });
      expect(ours.equals(compressZstd(original, { level: COMPARE_LEVEL }))).toBe(true);
      expect(execFileSync(zstd, ['-d', '-q', '-c'], { input: ours, maxBuffer: 1 << 26 }).equals(original)).toBe(true);
      const reference = execFileSync(zstd, [`-${COMPARE_LEVEL}`, '-q', '-c', file], { maxBuffer: 1 << 26 });
      // The speed is not bought with ratio: the stream stays within 1% of what the tool writes at the same level.
      expect(ours.length).toBeLessThanOrEqual(reference.length * 1.01);
      await expectNoSlowerThanReference(
        'zstd compress level 3',
        repeated(() => execFileSync(zstd, [`-${COMPARE_LEVEL}`, '-q', '-c', file], { maxBuffer: 1 << 26 })),
        repeatedAsync(() => compressZstdAsync(original, { level: COMPARE_LEVEL })),
        { maxRatio: MAX_COMPRESS_TIME_RATIO, passes: COMPARE_PASSES }
      );
    },
    TEST_TIMEOUT_MS
  );
});
