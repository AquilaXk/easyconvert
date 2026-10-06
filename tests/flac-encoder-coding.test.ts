import { describe, it, expect } from 'vitest';
import { encodeFlacStream } from '../src/lib/conversions/media-encoder';
import { parseFlacStructure } from './helpers/flac-reference';
import { ramp, uniformNoise } from './helpers/audio-signals';

/**
 * Subframe selection and partitioned Rice coding (RFC 9639 sections 9.2 and 9.2.7), observed
 * through an independent bit-level parser of the encoder output.
 */

const BLOCK = 4096;
const SUBFRAME_HEADER_BITS = 8;
const PCM16_BITS = 16;
const PARABOLA_CURVATURE = 0.0015;
const WASTED_LOW_BITS = 4;
const QUIET_AMPLITUDE = 8;
const LOUD_AMPLITUDE = 6000;
const TEN_BIT_AMPLITUDE = 511;
const FULL_SCALE = 32767;

describe('FLAC subframe selection', () => {
  it('codes digital silence and DC as constant subframes', () => {
    const silence = parseFlacStructure(encodeFlacStream(new Int16Array(BLOCK), 44100, 1));
    expect(silence.frames[0].subframes[0].type).toBe('constant');
    expect(silence.frames[0].subframes[0].bits).toBe(SUBFRAME_HEADER_BITS + PCM16_BITS);

    const dc = new Int16Array(BLOCK).fill(-1234);
    const parsed = parseFlacStructure(encodeFlacStream(dc, 44100, 1));
    expect(parsed.frames[0].subframes[0].type).toBe('constant');
  });

  it('picks the fixed order that matches the signal polynomial', () => {
    const parabola = new Int16Array(BLOCK);
    for (let i = 0; i < parabola.length; i++) parabola[i] = Math.round(i * i * PARABOLA_CURVATURE);
    const sub = parseFlacStructure(encodeFlacStream(parabola, 44100, 1)).frames[0].subframes[0];
    expect(sub.type).toBe('fixed');
    expect(sub.order).toBe(2);
  });

  it('falls back to verbatim when prediction cannot beat raw samples', () => {
    const noise = uniformNoise(5, BLOCK, FULL_SCALE);
    const sub = parseFlacStructure(encodeFlacStream(noise, 44100, 1)).frames[0].subframes[0];
    expect(sub.type).toBe('verbatim');
    expect(sub.bits).toBe(SUBFRAME_HEADER_BITS + PCM16_BITS * BLOCK);
  });

  it('removes wasted low bits shared by every sample', () => {
    const scaled = ramp(BLOCK, 1).map((v) => v * (1 << WASTED_LOW_BITS));
    const sub = parseFlacStructure(encodeFlacStream(scaled, 44100, 1)).frames[0].subframes[0];
    expect(sub.wastedBits).toBe(WASTED_LOW_BITS);
    expect(sub.bitsPerSample).toBe(PCM16_BITS - WASTED_LOW_BITS);
  });
});

describe('FLAC partitioned Rice coding', () => {
  it('uses several partitions with distinct parameters for a non-stationary block', () => {
    const block = new Int16Array(BLOCK);
    block.set(uniformNoise(1, BLOCK / 2, QUIET_AMPLITUDE), 0);
    block.set(uniformNoise(2, BLOCK / 2, LOUD_AMPLITUDE), BLOCK / 2);
    const sub = parseFlacStructure(encodeFlacStream(block, 44100, 1)).frames[0].subframes[0];
    expect(sub.residual!.partitionOrder).toBeGreaterThanOrEqual(1);
    expect(sub.residual!.parameters.length).toBe(1 << sub.residual!.partitionOrder);
    expect(new Set(sub.residual!.parameters).size).toBeGreaterThan(1);
  });

  it('uses an escape partition when raw residual width beats Rice coding', () => {
    // 10-bit uniform noise: Rice costs about 10.5 bits per sample, an escape partition 10.
    const block = uniformNoise(3, BLOCK, TEN_BIT_AMPLITUDE);
    const sub = parseFlacStructure(encodeFlacStream(block, 44100, 1)).frames[0].subframes[0];
    expect(sub.type).toBe('fixed');
    expect(sub.residual!.escapeWidths.length).toBeGreaterThan(0);
    expect(sub.residual!.escapeWidths.every((w) => w >= 9 && w <= 11)).toBe(true);
    expect(sub.bits).toBeLessThan(11 * BLOCK);
  });
});

describe('FLAC verbatim fallback is checked against exact sizes', () => {
  const FRAMES = 3 * BLOCK;
  const AMPLITUDES = [32767, 32000, 30000, 24000, 16000, 12000, 8000];

  it.each(AMPLITUDES)('no stereo subframe exceeds its verbatim size (noise at +-%i)', (amplitude) => {
    const left = uniformNoise(amplitude, FRAMES, amplitude);
    const right = uniformNoise(amplitude + 1, FRAMES, amplitude);
    const pcm = new Int16Array(FRAMES * 2);
    for (let i = 0; i < FRAMES; i++) {
      pcm[2 * i] = left[i];
      pcm[2 * i + 1] = right[i];
    }
    const parsed = parseFlacStructure(encodeFlacStream(pcm, 44100, 2));
    for (const frame of parsed.frames) {
      for (const sub of frame.subframes) {
        const verbatimBits = SUBFRAME_HEADER_BITS + sub.wastedBits + frame.blockSize * sub.bitsPerSample;
        expect(sub.bits).toBeLessThanOrEqual(verbatimBits);
      }
    }
  });
});
