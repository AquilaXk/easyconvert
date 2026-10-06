import { describe, it, expect } from 'vitest';
import {
  AudioResampleError,
  MAX_RESAMPLE_OUTPUT_BYTES,
  resamplePlanarFloat,
  resampleInterleavedInt16,
} from '../src/lib/conversions/audio-resampler';
import { synthesizeTones } from './helpers/audio-spectrum';

/**
 * Resource limits, the equal-rate path and edge behaviour of the multi-stage pipeline. Expected
 * values come from closed-form signals and shift invariance, not from the module.
 */

const INT16_BYTES = 2;
const FLOAT32_BYTES = 4;
const MAX_RATIO_FRAMES = 64;
const DC_LEVEL = 1000;

const SLOW_TEST_TIMEOUT_MS = 120_000;

describe('scratch memory scales with channels and cascade depth', () => {
  // Combinations that used to be rejected although every parameter is in range.
  it.each([
    { channels: 8, inRate: 64000, outRate: 1000 },
    { channels: 16, inRate: 48000, outRate: 1000 },
    { channels: 32, inRate: 24000, outRate: 1000 },
    { channels: 16, inRate: 768000, outRate: 12797 },
    { channels: 32, inRate: 768000, outRate: 12797 },
  ])('resamples $channels channels $inRate -> $outRate and preserves a DC level', ({ channels, inRate, outRate }) => {
    const frames = Math.round(inRate * 0.4);
    const pcm = new Int16Array(frames * channels).fill(DC_LEVEL);
    const out = resampleInterleavedInt16(pcm, inRate, outRate, channels);
    const outFrames = Math.floor((frames * outRate) / inRate);
    expect(out.length).toBe(outFrames * channels);
    // Away from the zero-padded edges every channel holds the DC level (+-1 LSB of dither).
    const guard = Math.ceil(outFrames * 0.3);
    for (let frame = guard; frame < outFrames - guard; frame++) {
      for (let c = 0; c < channels; c++) {
        expect(Math.abs(out[frame * channels + c] - DC_LEVEL)).toBeLessThanOrEqual(1);
      }
    }
  }, SLOW_TEST_TIMEOUT_MS);
});

describe('output size limit', () => {
  it('rejects an int16 result above the byte limit before allocating it', () => {
    const frames = MAX_RESAMPLE_OUTPUT_BYTES / INT16_BYTES / MAX_RATIO_FRAMES + 1;
    const pcm = new Int16Array(frames);
    expect(() => resampleInterleavedInt16(pcm, 1000, 64000, 1)).toThrow(AudioResampleError);
    expect(() => resampleInterleavedInt16(pcm, 1000, 64000, 1)).toThrow(/exceeds the .* byte limit/);
  });

  it('counts four bytes per float output sample', () => {
    const frames = MAX_RESAMPLE_OUTPUT_BYTES / FLOAT32_BYTES / MAX_RATIO_FRAMES + 1;
    const plane = new Float32Array(frames);
    expect(() => resamplePlanarFloat([plane], 1000, 64000)).toThrow(/exceeds the .* byte limit/);
  });

  it('is a half-gigabyte limit', () => {
    expect(MAX_RESAMPLE_OUTPUT_BYTES).toBe(512 * 1024 * 1024);
  });
});

describe('equal rates', () => {
  const wave = Int16Array.from({ length: 4000 }, (_, i) => Math.round(Math.sin(i / 11) * 20000));

  it('returns a new array holding the same 16-bit samples', () => {
    const out = resampleInterleavedInt16(wave, 44100, 44100, 2);
    expect(out).not.toBe(wave);
    expect(Array.from(out)).toEqual(Array.from(wave));
  });

  it('quantises 8-bit output to the 8-bit grid with dither, deterministically', () => {
    const eightBitStep = 256;
    const a = resampleInterleavedInt16(wave, 44100, 44100, 2, { outputBitDepth: 8 });
    const b = resampleInterleavedInt16(wave, 44100, 44100, 2, { outputBitDepth: 8 });
    expect(a).not.toBe(wave);
    expect(Array.from(a)).toEqual(Array.from(b));
    let changed = 0;
    for (let i = 0; i < a.length; i++) {
      expect(Math.abs(a[i] % eightBitStep)).toBe(0);
      // Within one dithered 8-bit step of the source.
      expect(Math.abs(a[i] - wave[i])).toBeLessThanOrEqual(2 * eightBitStep);
      if (a[i] !== wave[i]) changed++;
    }
    expect(changed).toBeGreaterThan(wave.length * 0.9);
  });

  it.each([8, 16] as const)('quantises planar float to the %i-bit grid and copies instead of aliasing', (bits) => {
    const plane = Float32Array.from({ length: 3000 }, (_, i) => Math.sin(i / 7) * 0.7);
    const lsb = 2 ** (1 - bits);
    const [out] = resamplePlanarFloat([plane], 48000, 48000, { outputBitDepth: bits });
    expect(out).not.toBe(plane);
    for (let i = 0; i < out.length; i++) {
      expect(Math.abs(Math.round(out[i] / lsb) - out[i] / lsb)).toBeLessThan(1e-3);
      expect(Math.abs(out[i] - plane[i])).toBeLessThanOrEqual(1.5 * lsb);
    }
  });

  it.each(['float', 24, 32] as const)('copies planar float untouched for %s output', (depth) => {
    const plane = Float32Array.from({ length: 500 }, (_, i) => Math.sin(i / 9) * 0.3);
    const [out] = resamplePlanarFloat([plane], 48000, 48000, { outputBitDepth: depth });
    expect(out).not.toBe(plane);
    expect(Array.from(out)).toEqual(Array.from(plane));
  });
});

describe('cascade edges equal the zero-extended signal', () => {
  // Shift invariance: resampling x must equal resampling [0 x 0] over x's span, so no stage may
  // truncate its output at the signal edge. The pad is a whole second, a multiple of every
  // stage's decimation, so the shift is a whole number of output frames.
  const SIGNAL_SECONDS = 0.3;
  const EDGE_TOLERANCE = 1e-5;

  it.each([
    { inRate: 96000, outRate: 44100 },
    { inRate: 44100, outRate: 96000 },
    { inRate: 192000, outRate: 48000 },
    { inRate: 48000, outRate: 16000 },
    { inRate: 16000, outRate: 48000 },
    { inRate: 44100, outRate: 48000 },
  ])('$inRate -> $outRate matches the padded result at both edges', ({ inRate, outRate }) => {
    const frames = Math.round(inRate * SIGNAL_SECONDS);
    const body = Float32Array.from(
      synthesizeTones(
        [
          { freq: 440, amp: 0.4, phase: 0.9 },
          { freq: 1900, amp: 0.3, phase: 2.1 },
        ],
        inRate,
        frames
      )
    );
    const padded = new Float32Array(frames + 2 * inRate);
    padded.set(body, inRate);

    const [plain] = resamplePlanarFloat([body], inRate, outRate);
    const [wide] = resamplePlanarFloat([padded], inRate, outRate);
    expect(plain.length).toBe(Math.floor((frames * outRate) / inRate));
    let worst = 0;
    for (let i = 0; i < plain.length; i++) worst = Math.max(worst, Math.abs(plain[i] - wide[outRate + i]));
    expect(worst, `max edge deviation ${worst.toExponential(2)}`).toBeLessThan(EDGE_TOLERANCE);
  });
});
