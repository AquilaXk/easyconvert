import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  AudioResampleError,
  describeResamplerPlan,
  resampleInterleavedInt16,
  resamplePlanarFloat,
  type ResampleKernelUsed,
  type ResampleQuality,
  type ResampleReport,
} from '../src/lib/conversions/audio-resampler';
import { macKernelSupported } from '../src/lib/conversions/wasm/resampler-mac';
import { SeededRandom } from './helpers/archive-corpus';
import { skipUnless } from './helpers/strict-skip';
import { expectNoSlowerThanReference } from './helpers/timing';

/**
 * The WebAssembly SIMD multiply-accumulate kernels of the polyphase resampler against the scalar TypeScript loops they
 * replace. Both paths are forced through the `kernel` option (no environment switch). The scalar path is the reference:
 * the SIMD path accumulates in the same order, so its samples are identical, not merely close.
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

function planar(frames: number, channels: number, seed: number): Float32Array[] {
  const interleaved = signal(frames, channels, seed);
  return Array.from({ length: channels }, (_, c) => Float32Array.from({ length: frames }, (_, i) => interleaved[i * channels + c] / 32768));
}

const RATE_PAIRS: ReadonlyArray<[number, number]> = [
  [44_100, 48_000],
  [48_000, 44_100],
  [16_000, 48_000],
  [22_050, 44_100],
  [96_000, 44_100],
  [8_000, 48_000],
  [44_100, 16_000],
];

describe.skipIf(skipUnless('WebAssembly SIMD', macKernelSupported()))('SIMD kernels match the scalar path', () => {
  for (const channels of [1, 2]) {
    for (const quality of ['standard', 'high'] as ResampleQuality[]) {
      it(`gives identical 16-bit samples for ${channels} channel(s) at ${quality} quality over ${RATE_PAIRS.length} rate pairs`, () => {
        const mismatches: string[] = [];
        for (const [src, tgt] of RATE_PAIRS) {
          const data = signal(Math.round(src * 0.6) + 37, channels, src + tgt);
          const scalarReport: ResampleReport = {};
          const simdReport: ResampleReport = {};
          const scalar = resampleInterleavedInt16(data, src, tgt, channels, { quality, kernel: 'scalar', report: scalarReport });
          const simd = resampleInterleavedInt16(data, src, tgt, channels, { quality, kernel: 'simd', report: simdReport });
          const same = scalar.length === simd.length && scalar.every((value, index) => value === simd[index]);
          if (!same) mismatches.push(`${src}->${tgt}`);
          expect(scalarReport.kernel).toBe('scalar');
          expect(simdReport.kernel).toBe('simd-f64x2');
        }
        expect(mismatches).toEqual([]);
      });
    }
  }

  it('gives identical float samples (the planar entry point) for stereo', () => {
    for (const [src, tgt] of RATE_PAIRS) {
      const data = planar(Math.round(src * 0.4) + 11, 2, src);
      const scalar = resamplePlanarFloat(data, src, tgt, { outputBitDepth: 'float', kernel: 'scalar' });
      const simd = resamplePlanarFloat(data, src, tgt, { outputBitDepth: 'float', kernel: 'simd' });
      for (let c = 0; c < 2; c++) {
        expect(Array.from(simd[c]), `${src}->${tgt} channel ${c}`).toEqual(Array.from(scalar[c]));
      }
    }
  });

  it('reports the SIMD kernel by default for mono and stereo and the scalar loops for three channels', () => {
    const reports = [1, 2, 3].map((channels) => {
      const report: ResampleReport = {};
      resampleInterleavedInt16(signal(5000, channels, channels), 44_100, 48_000, channels, { report });
      return report.kernel;
    });
    expect(reports).toEqual<ResampleKernelUsed[]>(['simd-f64x2', 'simd-f64x2', 'scalar']);
  });

  it('refuses a forced SIMD request for a stage the kernels do not cover', () => {
    expect(() => resampleInterleavedInt16(signal(5000, 3, 1), 44_100, 48_000, 3, { kernel: 'simd' })).toThrow(AudioResampleError);
    // A ratio with no exact polyphase table is interpolated between rows, which the kernels do not handle either.
    expect(describeResamplerPlan(44_100, 47_999).mode).toBe('interpolated');
    expect(() => resampleInterleavedInt16(signal(5000, 2, 2), 44_100, 47_999, 2, { kernel: 'simd' })).toThrow(AudioResampleError);
    const report: ResampleReport = {};
    resampleInterleavedInt16(signal(5000, 2, 2), 44_100, 47_999, 2, { report });
    expect(report.kernel).toBe('scalar');
  });
});

describe('kernel option', () => {
  it('rejects an unknown kernel name', () => {
    const options = { kernel: 'gpu' } as unknown as { kernel: 'auto' };
    expect(() => resampleInterleavedInt16(signal(100, 1, 3), 44_100, 48_000, 1, options)).toThrow(/Unsupported resampler kernel gpu/);
  });

  it('falls back to the scalar loops, with the same samples, in a runtime without WebAssembly', () => {
    const child = path.join(__dirname, 'helpers', 'resampler-no-wasm-child.cts');
    const output = execFileSync(process.execPath, ['--no-expose-wasm', '-r', 'tsx/cjs', child], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
    const result = JSON.parse(output.trim().split('\n').pop() ?? '{}') as Record<string, unknown>;
    expect(result).toEqual({ webassembly: 'undefined', supported: false, kernel: 'scalar', sameSamples: true, forced: 'AudioResampleError' });
  }, TEST_TIMEOUT_MS);
});

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
