import { describe, it } from 'vitest';
import { resampleInterleavedInt16 } from '../src/lib/conversions/audio-resampler';
import { macKernelSupported } from '../src/lib/conversions/wasm/resampler-mac';
import { SeededRandom } from './helpers/archive-corpus';
import { skipUnless } from './helpers/strict-skip';
import { expectNoSlowerThanReference } from './helpers/timing';

/**
 * Timing-ratio checks moved out of audio-resampler-simd.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 */

// skip-ok: explicit opt-out (RESAMPLER_SKIP_TIMING=1) of the speed-up ratio on a slow shared runner, never set in CI.
const SKIP_TIMING = process.env.RESAMPLER_SKIP_TIMING === '1';
const TEST_TIMEOUT_MS = 180_000;
const SECONDS = 3;
/** The SIMD path must be at least this many times faster than the scalar path (the scalar loops reach about 7 M samples/s, the target is 20 M). */
const MIN_SPEEDUP = 2;
const INT16_SPAN = 12000;
const NOISE_SPAN = 4096;
const SINE_PERIOD_FRAMES = 77;

function signal(frames: number, channels: number, seed: number): Int16Array {
  const rng = new SeededRandom(seed);
  const out = new Int16Array(frames * channels);
  for (let i = 0; i < out.length; i++) {
    const frame = Math.floor(i / channels);
    out[i] = Math.round(INT16_SPAN * Math.sin((2 * Math.PI * frame) / SINE_PERIOD_FRAMES) + rng.below(NOISE_SPAN) - NOISE_SPAN / 2);
  }
  return out;
}

describe.skipIf(SKIP_TIMING || skipUnless('WebAssembly SIMD', macKernelSupported()))('SIMD kernel speed', () => {
  it(`is at least ${MIN_SPEEDUP}x faster than the scalar loops on 44.1 -> 48 kHz stereo`, async () => {
    const data = signal(44_100 * SECONDS, 2, 5);
    await expectNoSlowerThanReference(
      'SIMD against scalar',
      () => resampleInterleavedInt16(data, 44_100, 48_000, 2, { kernel: 'scalar' }),
      () => resampleInterleavedInt16(data, 44_100, 48_000, 2, { kernel: 'simd' }),
      { maxRatio: 1 / MIN_SPEEDUP, passes: 5 }
    );
  }, TEST_TIMEOUT_MS);
});
