import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compressZstd, decompressZstd } from '../src/lib/conversions/zstd';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { expectNoSlowerThanReference } from './helpers/timing';

/**
 * Throughput of the in-process Zstandard engine against the `zstd` command line on the benchmark's mixed corpus
 * (JSON records followed by PCM audio). The reference time includes starting the process, as it does in
 * `npm run bench:quality`: the claim is that the in-process engine reaches at least 0.8x of the tool's speed, i.e.
 * takes no more than 1.25x its time. Both sides run interleaved in this process and the best pass of each is kept,
 * so the ratio does not depend on how fast the runner is. A slow runner can opt out explicitly with
 * ARCHIVE_SKIP_TIMING=1; nothing skips silently in CI.
 */
// skip-ok: explicit opt-out (ARCHIVE_SKIP_TIMING=1) of the timing ratios on a slow shared runner, never set in CI.
const SKIP_TIMING = process.env.ARCHIVE_SKIP_TIMING === '1';
const TEST_TIMEOUT_MS = 180_000;
const MAX_TIME_RATIO = 1.25;
/**
 * Compression is held to a looser bound: the in-process level-3 match finder and sequence writer take about 1.7x to 2x
 * the time of the tool at the same level (the tool is native code and parses with a leaner two-table finder), down from
 * 2.9x before the sequence writer stopped using floating-point exponentiation and the finder inserted fewer positions.
 */
const MAX_COMPRESS_TIME_RATIO = 2.5;
const COMPARE_PASSES = 7;
const BENCH_CORPUS = path.resolve(__dirname, '..', 'bench', 'corpus');
const COMPARE_LEVEL = 3;

function mixedCorpus(): Buffer {
  return Buffer.concat([fs.readFileSync(path.join(BENCH_CORPUS, 'data', 'records.jsonl')), fs.readFileSync(path.join(BENCH_CORPUS, 'speech.wav'))]);
}

describe.skipIf(SKIP_TIMING)('Zstandard engine speed against the zstd command line', () => {
  oracleTest(
    'decompresses a level-3 stream in no more than 1.25x the time of `zstd -d`',
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
        () => execFileSync(zstd, ['-d', '-q', '-c', file], { maxBuffer: 1 << 26 }),
        () => decompressZstd(stream),
        { maxRatio: MAX_TIME_RATIO, passes: COMPARE_PASSES }
      );
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'compresses at level 3 in no more than 2.5x the time of `zstd -3`, to a stream `zstd -d` restores, within 1% of its size',
    ['zstd'],
    async () => {
      const zstd = getOracleToolPath('zstd')!;
      const original = mixedCorpus();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zstd-speed-'));
      const file = path.join(dir, 'mixed.bin');
      fs.writeFileSync(file, original);
      const ours = compressZstd(original, { level: COMPARE_LEVEL });
      expect(execFileSync(zstd, ['-d', '-q', '-c'], { input: ours, maxBuffer: 1 << 26 }).equals(original)).toBe(true);
      const reference = execFileSync(zstd, [`-${COMPARE_LEVEL}`, '-q', '-c', file], { maxBuffer: 1 << 26 });
      // The speed is not bought with ratio: the stream stays within 1% of what the tool writes at the same level.
      expect(ours.length).toBeLessThanOrEqual(reference.length * 1.01);
      await expectNoSlowerThanReference(
        'zstd compress level 3',
        () => execFileSync(zstd, [`-${COMPARE_LEVEL}`, '-q', '-c', file], { maxBuffer: 1 << 26 }),
        () => compressZstd(original, { level: COMPARE_LEVEL }),
        { maxRatio: MAX_COMPRESS_TIME_RATIO, passes: COMPARE_PASSES }
      );
    },
    TEST_TIMEOUT_MS
  );
});
