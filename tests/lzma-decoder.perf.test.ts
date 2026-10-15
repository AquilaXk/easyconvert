import { execFileSync } from 'node:child_process';
import { describe, expect } from 'vitest';
import { unpackXz } from '../src/lib/conversions/archive';
import { jsonRecords, proseText, SeededRandom } from './helpers/archive-corpus';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { expectNoSlowerThanReference } from './helpers/timing';

/**
 * Timing-ratio checks of the pure LZMA2 decoder against the reference `xz -d`. They compare wall times and need a quiet
 * machine, so they run in the nightly performance workflow (`npx vitest run --no-file-parallelism .perf.test.ts`) and
 * not in the PR gate.
 */

// skip-ok: explicit opt-out (ARCHIVE_SKIP_TIMING=1) of the timing ratios on a slow shared runner, never set in CI.
const SKIP_TIMING = process.env.ARCHIVE_SKIP_TIMING === '1';
const TEST_TIMEOUT_MS = 120_000;
/**
 * The reference pays for starting a process (a few milliseconds) and pipes its output; the pure decoder runs in
 * process. With the range coder registers in uint32 doubles and the model constants read through the module loader's
 * getters, the decoder took 6 times the reference on this input under vitest; it now takes about 1.4 times, and the
 * bound sits between the two.
 */
const MAX_RATIO_TO_REFERENCE = 1.8;

describe.skipIf(SKIP_TIMING)('pure LZMA2 decoding speed', () => {
  oracleTest(
    'decodes an xz -6 stream of text, records and noise in under 1.8 times the time of xz -d',
    ['xz'],
    async () => {
      const xz = getOracleToolPath('xz')!;
      const original = Buffer.concat([proseText(500_000, 81), jsonRecords(500_000, 82), new SeededRandom(83).bytes(250_000)]);
      const stream = execFileSync(xz, ['-6', '-c'], { input: original, maxBuffer: 1 << 28 });
      const measurement = await expectNoSlowerThanReference(
        'pure LZMA2 decode against xz -d',
        () => execFileSync(xz, ['-d', '-c'], { input: stream, maxBuffer: 1 << 28 }),
        () => unpackXz(stream),
        { maxRatio: MAX_RATIO_TO_REFERENCE }
      );
      expect(measurement.largeResult.equals(original)).toBe(true);
    },
    TEST_TIMEOUT_MS
  );
});
