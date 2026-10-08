import { describe, expect, it } from 'vitest';
import { encodeFlacStream } from '../src/lib/conversions/media-encoder';
import { oracleTest } from './helpers/oracle-test';
import { expectNoSlowerThanReference } from './helpers/timing';
import {
  ffmpegDecodeRaw,
  flacCliDecodeRaw,
  flacCliEncodedSize,
  flacCliTest,
  generateMusicStereo,
  generateSpeechMono,
  metaflacMd5,
  pcmLittleEndianBytes,
  sha256Hex,
} from './helpers/flac-reference';
import crypto from 'node:crypto';

/**
 * Size and speed against the reference encoder on speech and music rendered by ffmpeg.
 * Sizes are compared with `flac -5` (the 3% budget) and `flac -8`; every stream must also
 * decode bit-exactly in both reference decoders.
 */

const RATE = 44100;
const MAX_SIZE_RATIO_VS_LEVEL_5 = 1.03;
const MAX_SIZE_RATIO_VS_LEVEL_8 = 1.08;
// Regression ceiling, not a benchmark. The reference unit is ten plain passes over the samples (a sum of squares):
// a pass takes about a millisecond for speech, too short to time alone. The encoder costs 3.5 to 4.6 units on a
// quiet machine and the encoder it replaced (2.8 MB/s against about 17 MB/s) 21 to 27, so the bound of 15 keeps
// headroom for shared CI runners while a fall back to the old path fails.
const MAX_ENCODE_COST_PER_REFERENCE_UNIT = 15;
const REFERENCE_PASSES = 10;
const THROUGHPUT_RUNS = 5;
const FLAC_MAGIC = 'fLaC';

/** The reference unit of work the encoder's cost is expressed in: REFERENCE_PASSES plain passes over the samples. */
function referenceUnit(pcm: Int16Array): number {
  let sum = 0;
  for (let pass = 0; pass < REFERENCE_PASSES; pass++) {
    for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  }
  return sum;
}
const TEST_TIMEOUT_MS = 120_000;

interface Signal {
  name: string;
  channels: number;
  make: () => Int16Array;
}

const SIGNALS: ReadonlyArray<Signal> = [
  { name: 'stereo music', channels: 2, make: generateMusicStereo },
  { name: 'mono speech', channels: 1, make: generateSpeechMono },
];

describe('FLAC compression and speed against the reference encoder', () => {
  for (const signal of SIGNALS) {
    oracleTest(
      `${signal.name}: within 3% of flac -5, decodes bit-exactly`,
      ['flac', 'metaflac', 'ffmpeg'],
      () => {
        const pcm = signal.make();
        const pcmBytes = pcmLittleEndianBytes(pcm, 2);
        const stream = encodeFlacStream(pcm, RATE, signal.channels);
        const options = { channels: signal.channels, bitsPerSample: 16, sampleRate: RATE };
        const level5 = flacCliEncodedSize(pcmBytes, { level: 5, ...options });
        const level8 = flacCliEncodedSize(pcmBytes, { level: 8, ...options });
        expect(stream.length / level5).toBeLessThanOrEqual(MAX_SIZE_RATIO_VS_LEVEL_5);
        expect(stream.length / level8).toBeLessThanOrEqual(MAX_SIZE_RATIO_VS_LEVEL_8);

        const tested = flacCliTest(stream);
        expect(tested.ok, tested.stderr.slice(0, 300)).toBe(true);
        const expected = sha256Hex(pcmBytes);
        expect(sha256Hex(flacCliDecodeRaw(stream))).toBe(expected);
        expect(sha256Hex(ffmpegDecodeRaw(stream, 's16le'))).toBe(expected);
        expect(metaflacMd5(stream)).toBe(crypto.createHash('md5').update(pcmBytes).digest('hex'));
      },
      TEST_TIMEOUT_MS
    );

    it(
      `${signal.name}: encodes within ${MAX_ENCODE_COST_PER_REFERENCE_UNIT}x the cost of ten scalar passes over the PCM`,
      async () => {
        // Speed is judged against this machine, not a fixed MB/s: the encoder is timed against plain passes over
        // the same samples, interleaved and best of N (tests/helpers/timing.ts); see the constants above.
        const pcm = signal.make();
        const { largeResult: stream } = await expectNoSlowerThanReference(
          `${signal.name} FLAC encode`,
          () => referenceUnit(pcm),
          () => encodeFlacStream(pcm, RATE, signal.channels),
          { maxRatio: MAX_ENCODE_COST_PER_REFERENCE_UNIT, passes: THROUGHPUT_RUNS }
        );
        expect(stream.subarray(0, FLAC_MAGIC.length).toString('latin1')).toBe(FLAC_MAGIC);
      },
      TEST_TIMEOUT_MS
    );
  }
});
