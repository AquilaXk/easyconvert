import { describe, expect } from 'vitest';
import { encodeFlacStream } from '../src/lib/conversions/media-encoder';
import { oracleTest } from './helpers/oracle-test';
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
 * Size against the reference encoder on speech and music rendered by ffmpeg (the speed check is in
 * flac-encoder-compression.perf.test.ts).
 * Sizes are compared with `flac -5` (the 3% budget) and `flac -8`; every stream must also
 * decode bit-exactly in both reference decoders.
 */

const RATE = 44100;
const MAX_SIZE_RATIO_VS_LEVEL_5 = 1.03;
const MAX_SIZE_RATIO_VS_LEVEL_8 = 1.08;
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

describe('FLAC compression against the reference encoder', () => {
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
  }
});
