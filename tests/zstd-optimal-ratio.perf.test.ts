import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { compressZstd, decompressZstd } from '../src/lib/conversions/zstd';
import { SeededRandom, zipfText } from './helpers/archive-corpus';
import { oracleTest } from './helpers/oracle-test';
import { expectNoSlowerThanReference } from './helpers/timing';

/**
 * Timing-ratio checks moved out of zstd-optimal-ratio.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 */

// skip-ok: explicit opt-out (ARCHIVE_SKIP_TIMING=1) of the timing ratios on a slow shared runner, never set in CI.
const SKIP_TIMING = process.env.ARCHIVE_SKIP_TIMING === '1';
const MEGABYTE = 1024 * 1024;
const TEST_TIMEOUT_MS = 600_000;
/** Level 19 may take this many times the time of `zstd -19` on 1 MB (the reference runs native code). */
const MAX_TIME_VS_REFERENCE = 5;
/** Hostile inputs may take this many times what random data of the same size takes (issue acceptance criterion). */
const HOSTILE_TIME_BOUND = 2;
const PERIOD = 3;

describe.skipIf(SKIP_TIMING)('zstd level 19 time', () => {
  oracleTest(
    'takes no more than 5x the time of zstd -19 on 1 MB of English-like prose',
    ['zstd'],
    async () => {
      const data = zipfText(MEGABYTE, 497);
      await expectNoSlowerThanReference(
        'zstd level 19',
        () => execFileSync('zstd', ['-19', '-q', '-c'], { input: data, maxBuffer: 64 * MEGABYTE }),
        () => compressZstd(data, { level: 19 }),
        { maxRatio: MAX_TIME_VS_REFERENCE, passes: 3 }
      );
    },
    TEST_TIMEOUT_MS
  );

  it(
    'compresses 16 MB of zeros and of a period-3 pattern within 2x of 16 MB of random bytes',
    async () => {
      const size = 16 * MEGABYTE;
      const random = new SeededRandom(7).bytes(size);
      const zeros = Buffer.alloc(size);
      const periodic = Buffer.alloc(size);
      for (let i = 0; i < size; i++) periodic[i] = 0x11 * ((i % PERIOD) + 1);
      for (const [name, hostile] of [
        ['zeros', zeros],
        ['period 3', periodic],
      ] as const) {
        const measurement = await expectNoSlowerThanReference(
          name,
          () => compressZstd(random, { level: 19 }),
          () => compressZstd(hostile, { level: 19 }),
          { maxRatio: HOSTILE_TIME_BOUND, passes: 1 }
        );
        const frame = measurement.largeResult as Buffer;
        expect(decompressZstd(frame).equals(hostile), name).toBe(true);
        expect(frame.length, name).toBeLessThan(size / 1000);
      }
    },
    TEST_TIMEOUT_MS
  );
});
