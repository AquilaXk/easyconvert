import { describe, it, expect } from 'vitest';
import { encodeFlacStream } from '../src/lib/conversions/media-encoder';
import { oracleTest } from './helpers/oracle-test';
import {
  flacCliTest,
  parseFlacStructure,
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
