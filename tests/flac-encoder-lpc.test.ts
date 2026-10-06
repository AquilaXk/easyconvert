import { describe, it, expect } from 'vitest';
import { encodeFlacStream } from '../src/lib/conversions/media-encoder';
import { oracleTest } from './helpers/oracle-test';
import {
  flacCliDecodeRaw,
  flacCliEncodedSize,
  flacCliTest,
  parseFlacStructure,
  pcmLittleEndianBytes,
  sha256Hex,
} from './helpers/flac-reference';
import { mulberry32 } from './helpers/audio-signals';

/**
 * Linear predictive coding (RFC 9639 section 9.2.6): the encoder must use LPC subframes of
 * order up to 12, keep every quantised coefficient within the format limits, and stay close
 * to the reference encoder's size.
 */

const RATE = 44100;
const BLOCK = 4096;
const MAX_LPC_ORDER = 12;
const MIN_PRECISION = 5;
const MAX_PRECISION = 15;
/** Size budget against the reference `flac -5`. */
const MAX_SIZE_RATIO_VS_LEVEL_5 = 1.03;

interface Tone {
  frequency: number;
  amplitude: number;
}

function tonesPlusNoise(
  frames: number,
  tones: ReadonlyArray<Tone>,
  noiseAmplitude: number,
  seed: number
): Int16Array {
  const next = mulberry32(seed);
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let v = (next() * 2 - 1) * noiseAmplitude;
    for (const tone of tones) v += tone.amplitude * Math.sin((2 * Math.PI * tone.frequency * i) / RATE);
    out[i] = Math.round(v);
  }
  return out;
}

const CHORD: ReadonlyArray<Tone> = [
  { frequency: 220, amplitude: 6000 },
  { frequency: 277.18, amplitude: 4000 },
  { frequency: 329.63, amplitude: 4000 },
  { frequency: 440, amplitude: 3000 },
  { frequency: 1318.5, amplitude: 1500 },
  { frequency: 3520, amplitude: 600 },
];

/** Mid and high partials: smooth-signal fixed predictors cannot follow these, LPC can. */
const HIGH_CHORD: ReadonlyArray<Tone> = [
  { frequency: 1800, amplitude: 9000 },
  { frequency: 4300, amplitude: 6000 },
  { frequency: 7100, amplitude: 3500 },
];

describe('FLAC LPC subframes', () => {
  it('uses LPC subframes with in-range coefficients for tonal audio', () => {
    const pcm = tonesPlusNoise(4 * BLOCK, CHORD, 6, 21);
    const parsed = parseFlacStructure(encodeFlacStream(pcm, RATE, 1));
    const lpc = parsed.frames.flatMap((f) => f.subframes).filter((s) => s.type === 'lpc');
    expect(lpc.length).toBe(parsed.frames.length);
    for (const sub of lpc) {
      expect(sub.order).toBeGreaterThanOrEqual(1);
      expect(sub.order).toBeLessThanOrEqual(MAX_LPC_ORDER);
      expect(sub.precision!).toBeGreaterThanOrEqual(MIN_PRECISION);
      expect(sub.precision!).toBeLessThanOrEqual(MAX_PRECISION);
      expect(sub.shift!).toBeGreaterThanOrEqual(0);
      const limit = 2 ** (sub.precision! - 1);
      expect(sub.coefficients!.every((c) => c >= -limit && c < limit)).toBe(true);
    }
  });

  it('selects a high order for a rich spectrum and a low order for an AR(2) process', () => {
    // A true second-order autoregressive process gains nothing from more than two taps.
    const next = mulberry32(23);
    const resonator = new Int16Array(4 * BLOCK);
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < resonator.length; i++) {
      const y = 1.6 * y1 - 0.8 * y2 + (next() * 2 - 1) * 300;
      resonator[i] = Math.round(y);
      y2 = y1;
      y1 = y;
    }
    const rich = parseFlacStructure(encodeFlacStream(tonesPlusNoise(4 * BLOCK, CHORD, 6, 22), RATE, 1));
    const simple = parseFlacStructure(encodeFlacStream(resonator, RATE, 1));
    const richOrders = rich.frames.map((f) => f.subframes[0].order);
    const simpleOrders = simple.frames.map((f) => f.subframes[0].order);
    expect(Math.max(...richOrders)).toBeGreaterThanOrEqual(8);
    expect(Math.max(...simpleOrders)).toBeLessThanOrEqual(4);
    expect(simple.frames.every((f) => f.subframes[0].type === 'lpc')).toBe(true);
  });

  it('keeps constant, silent and noisy blocks off the LPC path when cheaper', () => {
    const silence = parseFlacStructure(encodeFlacStream(new Int16Array(BLOCK), RATE, 1));
    expect(silence.frames[0].subframes[0].type).toBe('constant');
    const next = mulberry32(5);
    const noise = new Int16Array(BLOCK).map(() => Math.round((next() * 2 - 1) * 32767));
    expect(parseFlacStructure(encodeFlacStream(noise, RATE, 1)).frames[0].subframes[0].type).toBe('verbatim');
  });

  oracleTest('tonal mono audio is within 3% of flac -5 and decodes bit-exactly', ['flac'], () => {
    const pcm = tonesPlusNoise(10 * BLOCK, HIGH_CHORD, 6, 24);
    const stream = encodeFlacStream(pcm, RATE, 1);
    const pcmBytes = pcmLittleEndianBytes(pcm, 2);
    const reference = flacCliEncodedSize(pcmBytes, { level: 5, channels: 1, bitsPerSample: 16, sampleRate: RATE });
    expect(stream.length / reference).toBeLessThanOrEqual(MAX_SIZE_RATIO_VS_LEVEL_5);
    const tested = flacCliTest(stream);
    expect(tested.ok, tested.stderr.slice(0, 300)).toBe(true);
    expect(sha256Hex(flacCliDecodeRaw(stream))).toBe(sha256Hex(pcmBytes));
  });

  oracleTest('full-scale tones decode bit-exactly (coefficient and residual extremes)', ['flac'], () => {
    const loud = tonesPlusNoise(3 * BLOCK + 11, [{ frequency: 997, amplitude: 32767 }], 0, 1);
    const clipped = tonesPlusNoise(3 * BLOCK, [{ frequency: 313, amplitude: 60000 }], 0, 1).map((v) =>
      Math.max(-32768, Math.min(32767, v))
    );
    for (const pcm of [loud, clipped]) {
      const stream = encodeFlacStream(pcm, RATE, 1);
      expect(flacCliTest(stream).ok).toBe(true);
      expect(sha256Hex(flacCliDecodeRaw(stream))).toBe(sha256Hex(pcmLittleEndianBytes(pcm, 2)));
    }
  });

  oracleTest('24-bit tonal audio decodes bit-exactly', ['flac'], () => {
    const next = mulberry32(31);
    const frames = 3 * BLOCK + 99;
    const pcm = new Int32Array(frames);
    for (let i = 0; i < frames; i++) {
      pcm[i] = Math.round(
        3_000_000 * Math.sin(i * 0.031) + 1_500_000 * Math.sin(i * 0.173) + (next() - 0.5) * 40
      );
    }
    const stream = encodeFlacStream(pcm, 96000, 1, { bitsPerSample: 24 });
    const tested = flacCliTest(stream);
    expect(tested.ok, tested.stderr.slice(0, 300)).toBe(true);
    expect(sha256Hex(flacCliDecodeRaw(stream))).toBe(sha256Hex(pcmLittleEndianBytes(pcm, 3)));
    const parsed = parseFlacStructure(stream);
    expect(parsed.frames.some((f) => f.subframes[0].type === 'lpc')).toBe(true);
  });
});
