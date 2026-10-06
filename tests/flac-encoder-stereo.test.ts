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
 * Stereo decorrelation (RFC 9639 section 9.1.3): per frame the encoder picks the cheapest of
 * independent, left/side, side/right and mid/side channel assignment.
 */

const RATE = 44100;
const BLOCK = 4096;
const INDEPENDENT = 1;
const LEFT_SIDE = 8;
const SIDE_RIGHT = 9;
const MID_SIDE = 10;
const LOUD = 2000;
const QUARTER_DIVISOR = 4;
const SMALL_NOISE = 8;
const SIDE_BITS_EXTRA = 1;
/** Size budget against the reference `flac -5`. */
const MAX_SIZE_RATIO_VS_LEVEL_5 = 1.03;
/** Identical channels cost about one channel; allow slack over the ideal 0.5. */
const MAX_CORRELATED_SIZE_RATIO = 0.65;

function interleave(left: Int32Array, right: Int32Array): Int16Array {
  const out = new Int16Array(left.length * 2);
  for (let i = 0; i < left.length; i++) {
    out[2 * i] = left[i];
    out[2 * i + 1] = right[i];
  }
  return out;
}

function noise(seed: number, count: number, amplitude: number): Int32Array {
  const next = mulberry32(seed);
  const out = new Int32Array(count);
  for (let i = 0; i < count; i++) out[i] = Math.round((next() * 2 - 1) * amplitude);
  return out;
}

function assignment(pcm: Int16Array): number {
  return parseFlacStructure(encodeFlacStream(pcm, RATE, 2)).frames[0].channelAssignment;
}

describe('FLAC stereo channel assignment', () => {
  oracleTest('uncorrelated equal-level channels cost no more than flac -5', ['flac'], () => {
    // Rotating two independent noises is a tie in theory; the choice must not cost bits.
    const pcm = interleave(noise(1, 3 * BLOCK, LOUD), noise(2, 3 * BLOCK, LOUD));
    const reference = flacCliEncodedSize(pcmLittleEndianBytes(pcm, 2), {
      level: 5,
      channels: 2,
      bitsPerSample: 16,
      sampleRate: RATE,
    });
    expect(encodeFlacStream(pcm, RATE, 2).length / reference).toBeLessThanOrEqual(MAX_SIZE_RATIO_VS_LEVEL_5);
  });

  it('uses mid/side when both channels share a loud component', () => {
    // L = s + a, R = s - a with s louder than a: the mid channel is exactly s, so mid/side
    // beats left/side and side/right by about 0.16 bit per sample.
    const s = noise(3, BLOCK, LOUD);
    const a = noise(4, BLOCK, LOUD / 2);
    const left = s.map((v, i) => v + a[i]);
    const right = s.map((v, i) => v - a[i]);
    expect(assignment(interleave(left, right))).toBe(MID_SIDE);
  });

  it('uses side/right when the right channel is the quiet copy of the left', () => {
    const left = noise(5, BLOCK, LOUD);
    const small = noise(6, BLOCK, SMALL_NOISE);
    const right = left.map((v, i) => Math.round(v / QUARTER_DIVISOR) + small[i]);
    expect(assignment(interleave(left, right))).toBe(SIDE_RIGHT);
  });

  it('uses left/side when the left channel is the quiet copy of the right', () => {
    const right = noise(7, BLOCK, LOUD);
    const small = noise(8, BLOCK, SMALL_NOISE);
    const left = right.map((v, i) => Math.round(v / QUARTER_DIVISOR) + small[i]);
    expect(assignment(interleave(left, right))).toBe(LEFT_SIDE);
  });

  it('codes identical channels as one signal plus a constant side channel', () => {
    const mono = noise(9, BLOCK, LOUD);
    const parsed = parseFlacStructure(encodeFlacStream(interleave(mono, mono), RATE, 2));
    const frame = parsed.frames[0];
    expect([LEFT_SIDE, SIDE_RIGHT, MID_SIDE]).toContain(frame.channelAssignment);
    expect(frame.subframes.filter((s) => s.type === 'constant').length).toBe(1);
  });

  it('gives the side channel one extra bit of sample width', () => {
    const mono = noise(10, BLOCK, LOUD);
    const small = noise(11, BLOCK, SMALL_NOISE);
    const parsed = parseFlacStructure(encodeFlacStream(interleave(mono, mono.map((v, i) => v + small[i])), RATE, 2));
    const frame = parsed.frames[0];
    expect(frame.channelAssignment).not.toBe(INDEPENDENT);
    const side = frame.channelAssignment === SIDE_RIGHT ? frame.subframes[0] : frame.subframes[1];
    const other = frame.channelAssignment === SIDE_RIGHT ? frame.subframes[1] : frame.subframes[0];
    expect(side.bitsPerSample + side.wastedBits).toBe(other.bitsPerSample + other.wastedBits + SIDE_BITS_EXTRA);
  });

  it('shrinks a correlated stereo block well below the independent coding', () => {
    const mono = noise(12, 4 * BLOCK, LOUD);
    const copy = interleave(mono, mono);
    const independent = encodeFlacStream(interleave(mono, noise(13, 4 * BLOCK, LOUD)), RATE, 2);
    expect(encodeFlacStream(copy, RATE, 2).length).toBeLessThan(independent.length * MAX_CORRELATED_SIZE_RATIO);
  });
});

describe('FLAC stereo decorrelation is lossless at the extremes', () => {
  const EXTREMES: ReadonlyArray<readonly [string, number, number]> = [
    ['full-scale opposite channels', 32767, -32768],
    ['full-scale equal channels', -32768, -32768],
    ['odd sums (mid rounding)', 12345, -12000],
    ['one channel silent', 30000, 0],
  ];

  for (const [name, l, r] of EXTREMES) {
    oracleTest(`16-bit ${name}`, ['flac'], () => {
      const frames = 2 * BLOCK + 3;
      const next = mulberry32(77);
      const pcm = new Int16Array(frames * 2);
      for (let i = 0; i < frames; i++) {
        const jitter = (next() < 0.5 ? 0 : 1) * (i % 7);
        pcm[2 * i] = Math.max(-32768, Math.min(32767, l - Math.sign(l) * jitter));
        pcm[2 * i + 1] = Math.max(-32768, Math.min(32767, r - Math.sign(r) * jitter));
      }
      const stream = encodeFlacStream(pcm, RATE, 2);
      const tested = flacCliTest(stream);
      expect(tested.ok, tested.stderr.slice(0, 300)).toBe(true);
      expect(sha256Hex(flacCliDecodeRaw(stream))).toBe(sha256Hex(pcmLittleEndianBytes(pcm, 2)));
    });
  }

  oracleTest('24-bit stereo extremes: side channel needs 25 bits', ['flac'], () => {
    const frames = BLOCK + 17;
    const pcm = new Int32Array(frames * 2);
    const next = mulberry32(5);
    for (let i = 0; i < frames; i++) {
      pcm[2 * i] = 8388607 - Math.floor(next() * 3);
      pcm[2 * i + 1] = -8388608 + Math.floor(next() * 3);
    }
    const stream = encodeFlacStream(pcm, 96000, 2, { bitsPerSample: 24 });
    const tested = flacCliTest(stream);
    expect(tested.ok, tested.stderr.slice(0, 300)).toBe(true);
    expect(sha256Hex(flacCliDecodeRaw(stream))).toBe(sha256Hex(pcmLittleEndianBytes(pcm, 3)));
  });
});

describe('FLAC stereo tail blocks do not inherit analysis from the previous block', () => {
  const SHORT_TAIL_LIMIT = 32;

  function tonalStereo(frames: number): Int16Array {
    const out = new Int16Array(frames * 2);
    for (let i = 0; i < frames; i++) {
      out[2 * i] = Math.round(9000 * Math.sin(i * 0.071) + 2500 * Math.sin(i * 0.43));
      out[2 * i + 1] = Math.round(7000 * Math.sin(i * 0.071 + 0.5) + 2000 * Math.sin(i * 0.29));
    }
    return out;
  }

  for (let tail = 1; tail < SHORT_TAIL_LIMIT; tail++) {
    oracleTest(`4096 + ${tail} frames: tail coded as if alone, flac -t passes`, ['flac'], () => {
      const pcm = tonalStereo(BLOCK + tail);
      const stream = encodeFlacStream(pcm, RATE, 2);
      const tested = flacCliTest(stream);
      expect(tested.ok, tested.stderr.slice(0, 300)).toBe(true);

      const parsed = parseFlacStructure(stream);
      const lastFrame = parsed.frames[parsed.frames.length - 1];
      const alone = parseFlacStructure(encodeFlacStream(pcm.slice(BLOCK * 2), RATE, 2)).frames[0];
      expect(lastFrame.blockSize).toBe(tail);
      expect(lastFrame.channelAssignment).toBe(alone.channelAssignment);
      expect(lastFrame.subframes.map((sub) => [sub.type, sub.order])).toEqual(
        alone.subframes.map((sub) => [sub.type, sub.order])
      );
    });
  }
});
