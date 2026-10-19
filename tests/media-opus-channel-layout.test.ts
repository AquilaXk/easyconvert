import { spawnSync } from 'node:child_process';
import { describe, expect } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import type { ConversionOptions } from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { requireEncoders, runFfmpeg, testPatternInput } from './helpers/ffmpeg-media-fixtures';
import { ORACLE_DECODE_MAX_BYTES, decodeAudioStream, probeFile, withMediaFile } from './helpers/ffmpeg-measure';
import { oracleTest } from './helpers/oracle-test';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';
import {
  CHANNEL_TONES_HZ,
  LAYOUT_5_0_SIDE,
  LAYOUT_5_1_BACK,
  LAYOUT_5_1_SIDE,
  LAYOUT_QUAD_SIDE,
  channelRms,
  toDecibels,
  toneAmplitude,
  toneWav,
  type ToneLayout,
} from './helpers/multichannel-tones';

/**
 * Opus in Ogg, WebM and Matroska stores more than two channels with channel mapping family 1 (RFC 7845 section 5.1.1.2),
 * which fixes the channel order of eight layouts: mono, stereo, 3.0, quad, 5.0, 5.1, 6.1 and 7.1 (the order of the Vorbis I
 * specification, whose surround channels are the rear pair). FFmpeg's encoder opens only those layouts, so a source in
 * 5.1(side) (AC-3, E-AC-3 and DTS surround channels sit at the sides) was refused with "Invalid channel layout 5.1(side) for
 * specified mapping family -1". The oracles are tones written one to a channel here and read back from a separate
 * ffmpeg decode of the output, and ffprobe's channel count and layout of the output.
 */

const skip = skipWithoutTools('ffmpeg', 'ffprobe');
const CONVERSION_TIMEOUT_MS = 240_000;
const SAMPLE_RATE = 48_000;
const TONE_SECONDS = 1;
const TONE_AMPLITUDE = 0.5;
/** Opus at its default bitrate keeps a sine within this of its level. */
const LEVEL_TOLERANCE_DB = 1.5;
/** A tone in a channel that was given another tone has fallen at least this far below the tones of its own. */
const LEAK_FLOOR_DB = -30;
const SOURCE_RMS_TOLERANCE_DB = 1.5;
const SAMPLE_FILE = 'samples-00001-2.mts';

/** The OpusHead fields of family 1 for a channel count (RFC 7845 section 5.1.1.2 and the table of the reference encoder). */
interface ChannelMapping {
  readonly streams: number;
  readonly coupled: number;
  readonly map: readonly number[];
}

const FAMILY_1_MAPPINGS: Readonly<Record<number, ChannelMapping>> = {
  4: { streams: 2, coupled: 2, map: [0, 1, 2, 3] },
  5: { streams: 3, coupled: 2, map: [0, 4, 1, 2, 3] },
  6: { streams: 4, coupled: 2, map: [0, 4, 1, 2, 3, 5] },
};
const OPUS_HEAD = Buffer.from('OpusHead', 'ascii');
const HEAD_CHANNELS_OFFSET = 9;
const HEAD_FAMILY_OFFSET = 18;
const HEAD_STREAMS_OFFSET = 19;
const HEAD_COUPLED_OFFSET = 20;
const HEAD_MAP_OFFSET = 21;

interface Expected {
  readonly source: ToneLayout;
  readonly channels: number;
  readonly layout: string;
  /** FFmpeg's decoder returns the channels of this layout in the order of the source (it does not for 5.0). */
  readonly decodesInSourceOrder: boolean;
}

/** The identification header of the Opus stream in a file, read from its bytes: Ogg carries it in the first page, WebM in the codec private data. */
function opusHeadOf(bytes: Buffer): { channels: number; family: number; streams: number; coupled: number; map: number[] } {
  const at = bytes.indexOf(OPUS_HEAD);
  expect(at, 'the file holds an OpusHead').toBeGreaterThanOrEqual(0);
  const channels = bytes[at + HEAD_CHANNELS_OFFSET];
  return {
    channels,
    family: bytes[at + HEAD_FAMILY_OFFSET],
    streams: bytes[at + HEAD_STREAMS_OFFSET],
    coupled: bytes[at + HEAD_COUPLED_OFFSET],
    map: [...bytes.subarray(at + HEAD_MAP_OFFSET, at + HEAD_MAP_OFFSET + channels)],
  };
}

/** The audio targets that write Opus: its own file, and Ogg with the codec asked for. */
const OPUS_TARGETS: ReadonlyArray<{ target: string; options: ConversionOptions; extension: string }> = [
  { target: 'opus', options: {}, extension: 'opus' },
  { target: 'ogg', options: { audio: { codec: 'opus' } }, extension: 'ogg' },
];

const CASES: readonly Expected[] = [
  { source: LAYOUT_5_1_SIDE, channels: 6, layout: '5.1', decodesInSourceOrder: true },
  { source: LAYOUT_5_0_SIDE, channels: 5, layout: '5.0', decodesInSourceOrder: false },
  { source: LAYOUT_QUAD_SIDE, channels: 4, layout: 'quad', decodesInSourceOrder: true },
  { source: LAYOUT_5_1_BACK, channels: 6, layout: '5.1', decodesInSourceOrder: true },
];

/** Asserts that channel k of the decoded output holds the tone of channel k of the source and none of the others at its level. */
function expectTonesInTheirChannels(pcm: Buffer, channels: number): void {
  for (let channel = 0; channel < channels; channel += 1) {
    const own = toneAmplitude(pcm, channels, channel, CHANNEL_TONES_HZ[channel], SAMPLE_RATE);
    expect(Math.abs(toDecibels(own / TONE_AMPLITUDE)), `channel ${channel} keeps its tone`).toBeLessThanOrEqual(LEVEL_TOLERANCE_DB);
    for (let other = 0; other < channels; other += 1) {
      if (other === channel) continue;
      const stray = toneAmplitude(pcm, channels, channel, CHANNEL_TONES_HZ[other], SAMPLE_RATE);
      expect(toDecibels(stray / own), `the tone of channel ${other} in channel ${channel}`).toBeLessThan(LEAK_FLOOR_DB);
    }
  }
}

/** Every channel of the first audio stream as the decoder returns it (s16le, no remix to a default layout), every decode error fatal. */
function decodeNative(file: string): Buffer {
  const run = spawnSync(requireOracleTool('ffmpeg'), ['-v', 'error', '-xerror', '-i', file, '-map', '0:a:0', '-f', 's16le', '-'], { maxBuffer: ORACLE_DECODE_MAX_BYTES });
  expect(run.status, String(run.stderr)).toBe(0);
  return run.stdout;
}

function audioStreamOf(bytes: Buffer, extension: string) {
  const streams = withMediaFile(bytes, extension, (file) => probeFile(requireOracleTool('ffprobe'), file).streams);
  return streams.find((stream) => stream.codec_type === 'audio');
}

function layoutOf(bytes: Buffer, extension: string): string | undefined {
  return withMediaFile(bytes, extension, (file) => {
    const stream = probeFile(requireOracleTool('ffprobe'), file).streams.find((candidate) => candidate.codec_type === 'audio') as
      | { channel_layout?: string }
      | undefined;
    return stream?.channel_layout;
  });
}

describe.skipIf(skip)('a surround source whose layout Opus mapping family 1 does not list', () => {
  for (const { source, channels, layout, decodesInSourceOrder } of CASES) {
    for (const { target, options, extension } of OPUS_TARGETS) {
      oracleTest(`${source.name} to ${target} keeps every channel in the ${layout} order`, ['ffmpeg', 'ffprobe'], async () => {
        requireEncoders('libopus');
        const input = toneWav(source, SAMPLE_RATE, TONE_SECONDS, TONE_AMPLITUDE);
        expect(layoutOf(input, 'wav'), 'the fixture is in the layout under test').toBe(source.name);
        const result = await dispatchConversion(input, 'wav', target, options, 'in.wav');
        const stream = audioStreamOf(result.buffer, extension);
        expect(stream?.codec_name).toBe('opus');
        expect(stream?.channels).toBe(channels);
        expect(layoutOf(result.buffer, extension)).toBe(layout);
        const head = opusHeadOf(result.buffer);
        expect({ channels: head.channels, family: head.family, ...FAMILY_1_MAPPINGS[channels] === undefined ? {} : { streams: head.streams, coupled: head.coupled, map: head.map } }).toEqual({
          channels,
          family: 1,
          ...FAMILY_1_MAPPINGS[channels],
        });
        const pcm = withMediaFile(result.buffer, extension, decodeNative);
        if (decodesInSourceOrder) expectTonesInTheirChannels(pcm, channels);
      }, CONVERSION_TIMEOUT_MS);
    }
  }

  oracleTest('5.1(side) AC-3 in Matroska to webm keeps every channel in the 5.1 order', ['ffmpeg', 'ffprobe'], async () => {
    requireEncoders('libopus', 'libvpx-vp9', 'ac3');
    const wav = toneWav(LAYOUT_5_1_SIDE, SAMPLE_RATE, TONE_SECONDS, TONE_AMPLITUDE);
    const source = withMediaFile(wav, 'wav', (file) =>
      runFfmpeg([...testPatternInput({ width: 160, height: 90, fps: 10, seconds: TONE_SECONDS }), '-i', file, '-c:v', 'mpeg4', '-c:a', 'ac3', '-b:a', '448k', '-shortest'], 'mkv')
    );
    expect(layoutOf(source, 'mkv'), 'the AC-3 stream is in 5.1(side)').toBe('5.1(side)');
    const result = await dispatchConversion(source, 'mkv', 'webm', {}, 'in.mkv');
    const stream = audioStreamOf(result.buffer, 'webm');
    expect(stream?.codec_name).toBe('opus');
    expect(stream?.channels).toBe(6);
    expect(layoutOf(result.buffer, 'webm')).toBe('5.1');
    const pcm = withMediaFile(result.buffer, 'webm', decodeNative);
    // AC-3 is lossy and does not keep a tone as exactly as Opus does: the order of the channels is what is judged.
    for (let channel = 0; channel < 6; channel += 1) {
      const own = toneAmplitude(pcm, 6, channel, CHANNEL_TONES_HZ[channel], SAMPLE_RATE);
      expect(own, `channel ${channel} holds its tone`).toBeGreaterThan(TONE_AMPLITUDE / 2);
    }
  }, CONVERSION_TIMEOUT_MS);

  oracleTest('a mono track beside a 5.1(side) track: only the surround track is relabelled, and each keeps its channels', ['ffmpeg', 'ffprobe'], async () => {
    requireEncoders('libopus', 'libvpx-vp9', 'ac3');
    const wav = toneWav(LAYOUT_5_1_SIDE, SAMPLE_RATE, TONE_SECONDS, TONE_AMPLITUDE);
    const source = withMediaFile(wav, 'wav', (file) =>
      runFfmpeg(
        [
          ...testPatternInput({ width: 160, height: 90, fps: 10, seconds: TONE_SECONDS }),
          '-f', 'lavfi', '-i', `sine=frequency=330:sample_rate=${SAMPLE_RATE}:duration=${TONE_SECONDS}`,
          '-i', file,
          '-map', '0:v', '-map', '1:a', '-map', '2:a',
          '-c:v', 'mpeg4', '-c:a:0', 'aac', '-c:a:1', 'ac3', '-b:a:1', '448k', '-shortest',
        ],
        'mkv'
      )
    );
    const result = await dispatchConversion(source, 'mkv', 'webm', {}, 'in.mkv');
    const audio = withMediaFile(result.buffer, 'webm', (file) => probeFile(requireOracleTool('ffprobe'), file).streams.filter((stream) => stream.codec_type === 'audio'));
    expect(audio.map((stream) => [stream.codec_name, stream.channels])).toEqual([['opus', 1], ['opus', 6]]);
    const surround = withMediaFile(result.buffer, 'webm', (file) => {
      const run = spawnSync(requireOracleTool('ffmpeg'), ['-v', 'error', '-xerror', '-i', file, '-map', '0:a:1', '-f', 's16le', '-'], { maxBuffer: ORACLE_DECODE_MAX_BYTES });
      expect(run.status, String(run.stderr)).toBe(0);
      return run.stdout;
    });
    for (let channel = 0; channel < 6; channel += 1) {
      expect(toneAmplitude(surround, 6, channel, CHANNEL_TONES_HZ[channel], SAMPLE_RATE), `surround channel ${channel} holds its tone`).toBeGreaterThan(TONE_AMPLITUDE / 2);
    }
  }, CONVERSION_TIMEOUT_MS);

  oracleTest(`the Blu-ray camcorder file ${SAMPLE_FILE} (AC-3 5.1(side)) to webm has its six channels at the level of the source`, ['ffmpeg', 'ffprobe'], async (ctx) => {
    requireEncoders('libopus', 'libvpx-vp9');
    const sample = await requireRealworldSample(ctx, SAMPLE_FILE);
    const ffmpeg = requireOracleTool('ffmpeg');
    const sourceStream = withMediaFile(sample.bytes, 'mts', (file) => probeFile(requireOracleTool('ffprobe'), file).streams.find((candidate) => candidate.codec_type === 'audio'));
    expect(sourceStream?.channels).toBe(6);
    const result = await dispatchConversion(sample.bytes, 'mts', 'webm', {}, SAMPLE_FILE);
    const stream = audioStreamOf(result.buffer, 'webm');
    expect(stream?.codec_name).toBe('opus');
    expect(stream?.channels).toBe(6);
    expect(layoutOf(result.buffer, 'webm')).toBe('5.1');
    const source = decodeAudioStream(ffmpeg, sample.path, SAMPLE_RATE, 6);
    const output = withMediaFile(result.buffer, 'webm', (file) => decodeAudioStream(ffmpeg, file, SAMPLE_RATE, 6));
    for (let channel = 0; channel < 6; channel += 1) {
      const wanted = channelRms(source.pcm, 6, channel);
      const got = channelRms(output.pcm, 6, channel);
      if (wanted < 1e-4) continue;
      expect(Math.abs(toDecibels(got / wanted)), `channel ${channel} level against the source`).toBeLessThanOrEqual(SOURCE_RMS_TOLERANCE_DB);
    }
  }, CONVERSION_TIMEOUT_MS);
});
