import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { encodeFlacStream } from '../src/lib/conversions/media-encoder';
import {
  FlacInputError,
  FlacInternalError,
  assertFlacFrameFitsBuffer,
} from '../src/lib/conversions/flac-encoder';
import { ConversionFailedError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import {
  flacCliTest,
  metaflacMd5,
  parseFlacStructure,
  pcmLittleEndianBytes,
} from './helpers/flac-reference';

/** RFC 9639 section 9.1.2: 4-bit sample rate codes with a table entry. */
const HEADER_SAMPLE_RATE_CODES: ReadonlyArray<readonly [number, number]> = [
  [8000, 4],
  [16000, 5],
  [22050, 6],
  [24000, 7],
  [32000, 8],
  [44100, 9],
  [48000, 10],
  [96000, 11],
];
/**
 * RFC 9639 section 9.1.2: rates without a table entry are written after the header as kHz
 * (code 12), Hz (13) or tens of Hz (14); a rate none of them can hold uses code 0 and lives
 * only in STREAMINFO, which is outside the streamable subset.
 */
const TRAILING_SAMPLE_RATE_CODES: ReadonlyArray<readonly [number, number]> = [
  [12000, 12],
  [11025, 13],
  [100010, 14],
  [700001, 0],
];
const SAMPLES_PER_FRAME = 4096;
/** Frame numbers of 2048 and above need a 3-byte UTF-8 coded number. */
const FRAMES_BEYOND_TWO_BYTE_NUMBERS = 2100;

function ramp(frames: number, channels: number): Int16Array {
  const out = new Int16Array(frames * channels);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      out[i * channels + c] = ((i * 37 + c * 11) % 2001) - 1000;
    }
  }
  return out;
}

describe('FLAC frame headers follow RFC 9639', () => {
  it.each(HEADER_SAMPLE_RATE_CODES)(
    'writes the table sample rate code for %i Hz',
    (rate, expectedCode) => {
      const stream = encodeFlacStream(ramp(1000, 1), rate, 1);
      const parsed = parseFlacStructure(stream);
      expect(parsed.frames[0].sampleRateCode).toBe(expectedCode);
      expect(parsed.frames[0].headerCrcOk).toBe(true);
      expect(parsed.streamInfo.sampleRate).toBe(rate);
    }
  );

  it.each(TRAILING_SAMPLE_RATE_CODES)('writes sample rate code %i Hz -> %i', (rate, expectedCode) => {
    const stream = encodeFlacStream(ramp(1000, 1), rate, 1);
    const parsed = parseFlacStructure(stream);
    expect(parsed.frames[0].sampleRateCode).toBe(expectedCode);
    expect(parsed.frames[0].headerCrcOk).toBe(true);
    expect(parsed.streamInfo.sampleRate).toBe(rate);
  });

  oracleTest('every sample rate code passes the reference decoder', ['flac'], () => {
    for (const [rate] of [...HEADER_SAMPLE_RATE_CODES, ...TRAILING_SAMPLE_RATE_CODES]) {
      const tested = flacCliTest(encodeFlacStream(ramp(5000, 1), rate, 1));
      expect(tested.ok, `${rate} Hz: ${tested.stderr.slice(0, 200)}`).toBe(true);
    }
  });

  it('codes frame numbers past 2047 as multi-byte UTF-8 numbers', () => {
    const frames = FRAMES_BEYOND_TWO_BYTE_NUMBERS * SAMPLES_PER_FRAME + 10;
    const stream = encodeFlacStream(new Int16Array(frames), 44100, 1);
    const parsed = parseFlacStructure(stream);
    expect(parsed.frames.length).toBe(FRAMES_BEYOND_TWO_BYTE_NUMBERS + 1);
    expect(parsed.frames.map((f) => f.codedNumber)).toEqual(
      Array.from({ length: FRAMES_BEYOND_TWO_BYTE_NUMBERS + 1 }, (_, i) => i)
    );
    expect(parsed.frames.every((f) => f.headerCrcOk && f.frameCrcOk)).toBe(true);
  });

  oracleTest('flac -t accepts a stream with more than 2048 frames', ['flac'], () => {
    const frames = FRAMES_BEYOND_TWO_BYTE_NUMBERS * SAMPLES_PER_FRAME + 10;
    const stream = encodeFlacStream(new Int16Array(frames), 44100, 1);
    const result = flacCliTest(stream);
    expect(result.ok, result.stderr.slice(0, 300)).toBe(true);
  });
});

describe('FLAC STREAMINFO is exact', () => {
  const CASES: ReadonlyArray<readonly [string, number, number]> = [
    ['mono, one short block', 1, 300],
    ['stereo, several blocks with a short tail', 2, 3 * SAMPLES_PER_FRAME + 123],
    ['mono, exact block multiple', 1, 2 * SAMPLES_PER_FRAME],
  ];

  it.each(CASES)('records the MD5 of the little-endian PCM (%s)', (_name, channels, frames) => {
    const pcm = ramp(frames, channels);
    const expected = crypto.createHash('md5').update(pcmLittleEndianBytes(pcm, 2)).digest('hex');
    const parsed = parseFlacStructure(encodeFlacStream(pcm, 44100, channels));
    expect(parsed.streamInfo.md5).toBe(expected);
  });

  it.each(CASES)('records exact frame and block size bounds (%s)', (_name, channels, frames) => {
    const parsed = parseFlacStructure(encodeFlacStream(ramp(frames, channels), 44100, channels));
    const sizes = parsed.frames.map((f) => f.size);
    const blocks = parsed.frames.map((f) => f.blockSize);
    expect(parsed.streamInfo.minFrameSize).toBe(Math.min(...sizes));
    expect(parsed.streamInfo.maxFrameSize).toBe(Math.max(...sizes));
    expect(parsed.streamInfo.maxBlockSize).toBe(Math.max(...blocks));
    const nonLast = blocks.slice(0, -1);
    const expectedMin = nonLast.length > 0 ? Math.min(...nonLast) : blocks[0];
    expect(parsed.streamInfo.minBlockSize).toBe(expectedMin);
    expect(parsed.streamInfo.totalSamples).toBe(frames);
  });

  oracleTest('metaflac reads the same MD5 and flac -t verifies it', ['flac', 'metaflac'], () => {
    const pcm = ramp(2 * SAMPLES_PER_FRAME + 77, 2);
    const stream = encodeFlacStream(pcm, 44100, 2);
    const expected = crypto.createHash('md5').update(pcmLittleEndianBytes(pcm, 2)).digest('hex');
    expect(metaflacMd5(stream)).toBe(expected);
    const result = flacCliTest(stream);
    expect(result.ok, result.stderr.slice(0, 300)).toBe(true);

    // Negative control: the oracle really checks the signature when it is present.
    const tampered = Buffer.from(stream);
    const MD5_OFFSET = 42 - 16;
    tampered[MD5_OFFSET] ^= 0xff;
    expect(flacCliTest(tampered).ok).toBe(false);
  });
});

describe('FLAC encoder fails closed on unsupported input', () => {
  it.each([0, 3, 6, 8, -1, 1.5, Number.NaN])('rejects %s channels with a typed error', (channels) => {
    expect(() => encodeFlacStream(new Int16Array(24), 44100, channels)).toThrow(FlacInputError);
  });

  it.each([0, -44100, 44100.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 20])(
    'rejects sample rate %s',
    (rate) => {
      expect(() => encodeFlacStream(ramp(100, 1), rate, 1)).toThrow(FlacInputError);
    }
  );

  it.each([0, 7, 15, 32, 64])('rejects %i bits per sample', (bitsPerSample) => {
    expect(() => encodeFlacStream(ramp(100, 1), 44100, 1, { bitsPerSample })).toThrow(FlacInputError);
  });

  it('rejects interleaved data that is not a whole number of frames', () => {
    expect(() => encodeFlacStream(new Int16Array(101), 44100, 2)).toThrow(FlacInputError);
  });

  it('errors are ConversionFailedError so the API maps them to HTTP 400', () => {
    try {
      encodeFlacStream(new Int16Array(24), 44100, 3);
      expect.unreachable('encoder must throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConversionFailedError);
      expect((err as Error).name).toBe('FlacInputError');
      expect((err as Error).message).toMatch(/3 channels/);
    }
  });

  it('still encodes the supported combinations', () => {
    const parsed = parseFlacStructure(encodeFlacStream(ramp(100, 2), 192000, 2, { bitsPerSample: 16 }));
    expect(parsed.streamInfo.sampleRate).toBe(192000);
    expect(parsed.streamInfo.channels).toBe(2);
    expect(parsed.streamInfo.bitsPerSample).toBe(16);
  });
});

describe('FLAC encoder internal invariants', () => {
  it('reports a frame that overran its buffer as an internal error, not a client error', () => {
    try {
      assertFlacFrameFitsBuffer(101, 100);
      expect.unreachable('guard must throw');
    } catch (err) {
      expect(err).toBeInstanceOf(FlacInternalError);
      expect(err).not.toBeInstanceOf(ConversionFailedError);
      expect((err as Error).name).toBe('FlacInternalError');
      expect((err as Error).message).toMatch(/101 bytes.*100/);
    }
    expect(() => assertFlacFrameFitsBuffer(100, 100)).not.toThrow();
  });
});
