import { describe, it, expect } from 'vitest';
import { encodeFlacStream } from '../src/lib/conversions/media-encoder';
import { oracleTest } from './helpers/oracle-test';
import {
  ffmpegDecodeRaw,
  ffprobeStream,
  flacCliDecodeRaw,
  flacCliDecodeWavData,
  leftJustifiedPcmBytes,
  flacCliTest,
  parseFlacStructure,
  pcmLittleEndianBytes,
  sha256Hex,
} from './helpers/flac-reference';
import { mulberry32, ramp, uniformNoise } from './helpers/audio-signals';

/**
 * Lossless round trip through the reference decoders: the decoded PCM must hash to the input.
 * `flac -d` and ffmpeg are independent implementations of RFC 9639.
 */

const RATE = 44100;
const BLOCK = 4096;
const FULL_SCALE_16 = 32767;

type Corpus = ReadonlyArray<readonly [string, (channels: number) => Int16Array]>;

function interleaved(frames: number, channels: number, sample: (i: number, c: number) => number): Int16Array {
  const out = new Int16Array(frames * channels);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) out[i * channels + c] = sample(i, c);
  }
  return out;
}

const SIGNALS: Corpus = [
  ['silence', (ch) => new Int16Array(3 * BLOCK * ch)],
  ['dc offset', (ch) => new Int16Array(2 * BLOCK * ch).fill(-777)],
  ['sine', (ch) => interleaved(3 * BLOCK + 17, ch, (i, c) => Math.round(12000 * Math.sin(i * 0.05 * (c + 1))))],
  ['full-scale square', (ch) => interleaved(BLOCK + 5, ch, (i) => ((i >> 4) & 1 ? FULL_SCALE_16 : -32768))],
  ['min/max alternation', (ch) => interleaved(BLOCK, ch, (i, c) => ((i + c) & 1 ? FULL_SCALE_16 : -32768))],
  ['white noise', (ch) => uniformNoise(11, 2 * BLOCK * ch, FULL_SCALE_16)],
  ['quiet noise', (ch) => uniformNoise(12, 2 * BLOCK * ch, 3)],
  ['impulse train', (ch) => interleaved(BLOCK + 1, ch, (i) => (i % 500 === 0 ? 30000 : 0))],
  ['ramp', (ch) => ramp(BLOCK + 300, ch)],
  ['scaled low bits', (ch) => ramp(BLOCK, ch).map((v) => v * 8)],
];

const SHORT_LENGTHS = [1, 2, 3, 4, 5, 15, 16, 17, 255, 256, 257, 4095, 4096, 4097];

describe('FLAC lossless round trip against reference decoders', () => {
  for (const channels of [1, 2]) {
    for (const [name, make] of SIGNALS) {
      oracleTest(`${name}, ${channels} ch: flac -t, flac -d and ffmpeg all reproduce the PCM`, ['flac', 'ffmpeg'], () => {
        const pcm = make(channels);
        const stream = encodeFlacStream(pcm, RATE, channels);
        const expected = sha256Hex(pcmLittleEndianBytes(pcm, 2));

        const tested = flacCliTest(stream);
        expect(tested.ok, tested.stderr.slice(0, 300)).toBe(true);
        expect(sha256Hex(flacCliDecodeRaw(stream))).toBe(expected);
        expect(sha256Hex(ffmpegDecodeRaw(stream, 's16le'))).toBe(expected);

        const parsed = parseFlacStructure(stream);
        expect(parsed.frames.every((f) => f.headerCrcOk && f.frameCrcOk)).toBe(true);
      });
    }
  }

  for (const channels of [1, 2]) {
    oracleTest(`stream lengths around block boundaries, ${channels} ch`, ['flac'], () => {
      const next = mulberry32(99);
      for (const frames of SHORT_LENGTHS) {
        const pcm = interleaved(frames, channels, (i) => Math.round(8000 * Math.sin(i * 0.3) + (next() - 0.5) * 200));
        const stream = encodeFlacStream(pcm, RATE, channels);
        const tested = flacCliTest(stream);
        expect(tested.ok, `${frames} frames: ${tested.stderr.slice(0, 200)}`).toBe(true);
        expect(sha256Hex(flacCliDecodeRaw(stream))).toBe(sha256Hex(pcmLittleEndianBytes(pcm, 2)));
      }
    });
  }

  oracleTest('ffprobe reads the sample rate, channels and length from STREAMINFO', ['ffprobe'], () => {
    const stream = encodeFlacStream(ramp(BLOCK + 99, 2), 48000, 2);
    expect(ffprobeStream(stream)).toEqual({ sampleRate: 48000, channels: 2, samples: BLOCK + 99 });
  });
});

/** `flac -d` writes raw PCM only for whole-byte sample sizes. */
const RAW_WRITABLE_SIZES: ReadonlySet<number> = new Set([8, 16, 24]);

describe('FLAC sample sizes', () => {
  const SIZES: ReadonlyArray<readonly [number, number]> = [
    [8, 1],
    [12, 2],
    [20, 3],
    [24, 3],
  ];

  function signal(bits: number, frames: number, channels: number): Int32Array {
    const next = mulberry32(bits);
    const peak = 2 ** (bits - 1) - 1;
    const out = new Int32Array(frames * channels);
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) {
        const tone = 0.6 * Math.sin(i * 0.02 * (c + 1)) + 0.3 * Math.sin(i * 0.31);
        out[i * channels + c] = Math.max(-peak - 1, Math.min(peak, Math.round(tone * peak * 0.8 + (next() - 0.5) * 8)));
      }
    }
    return out;
  }

  for (const [bits, bytes] of SIZES) {
    for (const channels of [1, 2]) {
      oracleTest(`${bits}-bit, ${channels} ch decodes bit-exactly with flac`, ['flac'], () => {
        const pcm = signal(bits, 2 * BLOCK + 123, channels);
        const stream = encodeFlacStream(pcm, RATE, channels, { bitsPerSample: bits });
        const parsed = parseFlacStructure(stream);
        expect(parsed.streamInfo.bitsPerSample).toBe(bits);
        const tested = flacCliTest(stream);
        expect(tested.ok, tested.stderr.slice(0, 300)).toBe(true);
        if (RAW_WRITABLE_SIZES.has(bits)) {
          expect(sha256Hex(flacCliDecodeRaw(stream))).toBe(sha256Hex(pcmLittleEndianBytes(pcm, bytes)));
        } else {
          expect(sha256Hex(flacCliDecodeWavData(stream))).toBe(sha256Hex(leftJustifiedPcmBytes(pcm, bits)));
        }
      });
    }
  }

  /**
   * Full-scale 24-bit material: the side channel needs 25 bits, and prediction on it must
   * leave the 32-bit fast path for the exact one without changing a sample.
   */
  oracleTest('24-bit full-scale square, noise and antiphase stereo decode bit-exactly', ['flac'], () => {
    const bits = 24;
    const peak = 2 ** (bits - 1) - 1;
    const frames = 2 * BLOCK + 77;
    const next = mulberry32(2024);
    const makers: ReadonlyArray<readonly [string, (i: number, c: number) => number]> = [
      ['square', (i) => ((i >> 5) & 1 ? peak : -peak - 1)],
      ['noise', () => Math.round((next() * 2 - 1) * peak)],
      ['antiphase', (i, c) => {
        const v = i % 64 < 32 ? peak : -peak - 1;
        return c === 0 ? v : -1 - v;
      }],
    ];
    for (const [name, make] of makers) {
      const pcm = new Int32Array(frames * 2);
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < 2; c++) pcm[i * 2 + c] = make(i, c);
      }
      const stream = encodeFlacStream(pcm, RATE, 2, { bitsPerSample: bits });
      const tested = flacCliTest(stream);
      expect(tested.ok, `${name}: ${tested.stderr.slice(0, 300)}`).toBe(true);
      expect(sha256Hex(flacCliDecodeRaw(stream)), name).toBe(sha256Hex(pcmLittleEndianBytes(pcm, 3)));
    }
  });

  it('rejects samples outside the declared sample size', () => {
    const tooLoud = new Int32Array([0, 200, -3]);
    expect(() => encodeFlacStream(tooLoud, RATE, 1, { bitsPerSample: 8 })).toThrow(/range/);
  });
});
