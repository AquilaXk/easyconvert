import { spawnSync } from 'node:child_process';
import { describe, expect } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { InvalidMediaOptionError, type ConversionOptions } from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { requireEncoders } from './helpers/ffmpeg-media-fixtures';
import { ORACLE_DECODE_MAX_BYTES, probeFile, withMediaFile } from './helpers/ffmpeg-measure';
import { oracleTest } from './helpers/oracle-test';
import { requireRealworldSample } from './helpers/realworld-sample';
import {
  CHANNEL_TONES_HZ,
  LAYOUT_5_1_SIDE,
  toDecibels,
  toneAmplitude,
  toneWav,
} from './helpers/multichannel-tones';

/**
 * Windows Media Audio Standard (the `wmav2` encoder) codes one or two channels. A source with more channels is brought down to
 * stereo, as the MP3 encoder brings a surround source down to stereo, instead of being refused for a property the caller never set. The mix is the ITU-R BS.775-3
 * downmix with the centre and the surround channels 3 dB down and the LFE left out, normalised so that the sum cannot clip:
 * left = 0.4142 FL + 0.2929 FC + 0.2929 SL (BS.775-3 section 4.1, gains 1, 1/sqrt 2, 1/sqrt 2 divided by 1 + 2/sqrt 2).
 * An explicit request for more channels than WMA codes stays an error. The oracles are tones written one to a channel
 * here and read from a separate decode of the output, and the downmix computed here from a separate decode of the source.
 */

const CONVERSION_TIMEOUT_MS = 240_000;
const SAMPLE_RATE = 48_000;
const TONE_SECONDS = 1;
const TONE_AMPLITUDE = 0.5;
const LEVEL_TOLERANCE_DB = 1.5;
const LEAK_FLOOR_DB = -25;
const FRONT_GAIN = 0.4142;
const CENTRE_AND_SURROUND_GAIN = 0.2929;
const SAMPLE_FILE = 'samples-00001-2.mts';
const BYTES_PER_SAMPLE = 2;
const DURATION_TOLERANCE_SECONDS = 0.15;

function decodeNative(file: string): Buffer {
  const run = spawnSync(requireOracleTool('ffmpeg'), ['-v', 'error', '-xerror', '-i', file, '-map', '0:a:0', '-f', 's16le', '-'], { maxBuffer: ORACLE_DECODE_MAX_BYTES });
  expect(run.status, String(run.stderr)).toBe(0);
  return run.stdout;
}

function audioStreamOf(bytes: Buffer, extension: string) {
  return withMediaFile(bytes, extension, (file) => probeFile(requireOracleTool('ffprobe'), file).streams.find((stream) => stream.codec_type === 'audio'));
}

function layoutOf(bytes: Buffer, extension: string): string | undefined {
  return withMediaFile(bytes, extension, (file) => {
    const stream = probeFile(requireOracleTool('ffprobe'), file).streams.find((candidate) => candidate.codec_type === 'audio') as { channel_layout?: string } | undefined;
    return stream?.channel_layout;
  });
}

describe('a source with more channels than the target codes', () => {
  oracleTest('5.1(side) to wma is written as stereo with the BS.775 mix of its channels', ['ffmpeg', 'ffprobe'], async () => {
    requireEncoders('wmav2');
    const input = toneWav(LAYOUT_5_1_SIDE, SAMPLE_RATE, TONE_SECONDS, TONE_AMPLITUDE);
    const result = await dispatchConversion(input, 'wav', 'wma', {}, 'in.wav');
    const stream = audioStreamOf(result.buffer, 'wma');
    expect(stream?.codec_name).toBe('wmav2');
    expect(stream?.channels).toBe(2);
    const pcm = withMediaFile(result.buffer, 'wma', decodeNative);
    const [fl, fr, fc, lfe, sl, sr] = CHANNEL_TONES_HZ;
    // Tone, side and gain of what each output channel is built from: left from FL, FC and SL; right from FR, FC and SR.
    const expectedMix: ReadonlyArray<readonly [number, ReadonlyArray<readonly [number, number]>]> = [
      [0, [[fl, FRONT_GAIN], [fc, CENTRE_AND_SURROUND_GAIN], [sl, CENTRE_AND_SURROUND_GAIN]]],
      [1, [[fr, FRONT_GAIN], [fc, CENTRE_AND_SURROUND_GAIN], [sr, CENTRE_AND_SURROUND_GAIN]]],
    ];
    for (const [channel, parts] of expectedMix) {
      for (const [tone, gain] of parts) {
        const level = toneAmplitude(pcm, 2, channel, tone, SAMPLE_RATE);
        expect(Math.abs(toDecibels(level / (TONE_AMPLITUDE * gain))), `${tone} Hz in output channel ${channel}`).toBeLessThanOrEqual(LEVEL_TOLERANCE_DB);
      }
      const own = toneAmplitude(pcm, 2, channel, parts[0][0], SAMPLE_RATE);
      const foreign = channel === 0 ? [fr, sr] : [fl, sl];
      for (const tone of [...foreign, lfe]) {
        expect(toDecibels(toneAmplitude(pcm, 2, channel, tone, SAMPLE_RATE) / own), `${tone} Hz in output channel ${channel}`).toBeLessThan(LEAK_FLOOR_DB);
      }
    }
  }, CONVERSION_TIMEOUT_MS);

  oracleTest(`${SAMPLE_FILE} (AC-3 5.1(side)) to wma is stereo, decodes without error and is as long as the source`, ['ffmpeg', 'ffprobe'], async (ctx) => {
    requireEncoders('wmav2');
    const sample = await requireRealworldSample(ctx, SAMPLE_FILE);
    const result = await dispatchConversion(sample.bytes, 'mts', 'wma', {}, SAMPLE_FILE);
    expect(audioStreamOf(result.buffer, 'wma')?.channels).toBe(2);
    const sourceFrames = decodeNative(sample.path).length / (6 * BYTES_PER_SAMPLE);
    const outputFrames = withMediaFile(result.buffer, 'wma', decodeNative).length / (2 * BYTES_PER_SAMPLE);
    expect(Math.abs(outputFrames - sourceFrames) / SAMPLE_RATE, 'length in seconds against the source').toBeLessThanOrEqual(DURATION_TOLERANCE_SECONDS);
  }, CONVERSION_TIMEOUT_MS);

  oracleTest('the BS.775 downmix asked for by name keeps the surround pair of a 5.1(side) source', ['ffmpeg', 'ffprobe'], async () => {
    const input = toneWav(LAYOUT_5_1_SIDE, SAMPLE_RATE, TONE_SECONDS, TONE_AMPLITUDE);
    const result = await dispatchConversion(input, 'wav', 'wav', { audio: { downmix: 'itu-r-bs775' } }, 'in.wav');
    const pcm = withMediaFile(result.buffer, 'wav', decodeNative);
    const [fl, fr, fc, , sl, sr] = CHANNEL_TONES_HZ;
    for (const [channel, tone, gain] of [[0, fl, FRONT_GAIN], [0, fc, CENTRE_AND_SURROUND_GAIN], [0, sl, CENTRE_AND_SURROUND_GAIN], [1, fr, FRONT_GAIN], [1, fc, CENTRE_AND_SURROUND_GAIN], [1, sr, CENTRE_AND_SURROUND_GAIN]] as const) {
      const level = toneAmplitude(pcm, 2, channel, tone, SAMPLE_RATE);
      expect(Math.abs(toDecibels(level / (TONE_AMPLITUDE * gain))), `${tone} Hz in output channel ${channel}`).toBeLessThanOrEqual(0.2);
    }
  }, CONVERSION_TIMEOUT_MS);

  oracleTest('an explicit request for more channels than wma codes is still refused, with the limit named', ['ffmpeg', 'ffprobe'], async () => {
    const input = toneWav(LAYOUT_5_1_SIDE, SAMPLE_RATE, TONE_SECONDS, TONE_AMPLITUDE);
    const refused = (options: ConversionOptions) => dispatchConversion(input, 'wav', 'wma', options, 'in.wav').catch((error: unknown) => error);
    const requests: ConversionOptions[] = [{ audio: { channels: 6 } }, { audioChannels: '5.1' }];
    for (const options of requests) {
      const error = await refused(options);
      expect(error).toBeInstanceOf(InvalidMediaOptionError);
      expect((error as Error).message).toBe("The 'wma' target supports at most 2 audio channels, but 6 would be written; request fewer channels or a downmix.");
    }
  }, CONVERSION_TIMEOUT_MS);
});
