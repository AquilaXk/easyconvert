import { describe, expect, it } from 'vitest';
import { xxh64WasmSupported } from '../src/lib/conversions/wasm/xxh64';
import { computeZstdChecksum, FastStreamingXxHash64 } from '../src/lib/conversions/zstd';
import { SeededRandom } from './helpers/archive-corpus';
import { skipUnless } from './helpers/strict-skip';
import { expectNoSlowerThanReference } from './helpers/timing';

/**
 * Timing-ratio checks moved out of xxh64-wasm.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 */

// skip-ok: explicit opt-out (XXH64_SKIP_TIMING=1) of the speed ratio on a slow shared runner, never set in CI.
const SKIP_TIMING = process.env.XXH64_SKIP_TIMING === '1';
const TEST_TIMEOUT_MS = 180_000;
const MEGABYTE = 1024 * 1024;
const MIN_SPEEDUP = 4;

function scriptChecksum(data: Uint8Array): number {
  const hasher = new FastStreamingXxHash64();
  hasher.update(data);
  return hasher.digest();
}

describe.skipIf(SKIP_TIMING || skipUnless('WebAssembly', xxh64WasmSupported()))('WebAssembly XXH64 speed', () => {
  it(`hashes 8 MB at least ${MIN_SPEEDUP}x faster than the script implementation`, async () => {
    const data = new SeededRandom(2).bytes(8 * MEGABYTE);
    const expected = scriptChecksum(data);
    const measurement = await expectNoSlowerThanReference(
      'xxh64',
      () => scriptChecksum(data),
      () => computeZstdChecksum(data),
      { maxRatio: 1 / MIN_SPEEDUP, passes: 5 }
    );
    expect(measurement.largeResult).toBe(expected);
  }, TEST_TIMEOUT_MS);
});
