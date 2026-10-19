import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { convertWithNativeFfmpeg } from '../src/worker/engines';
import type { ConversionOptions } from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { requireEncoders } from './helpers/ffmpeg-media-fixtures';
import { decodeAudioStream, probeFile, withMediaFile } from './helpers/ffmpeg-measure';
import { oracleTest } from './helpers/oracle-test';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * A WAV file of a few samples (1 to 17) converted to the targets whose encoders have a minimum block: FLAC (a FLAC block
 * holds 16 samples or more, except the last) and Vorbis. FFmpeg 9.0 opens its FLAC encoder with the size of the first frame it
 * gets, so a stream shorter than 16 samples made it stop with "invalid block size" and write nothing: `.flac`, and `.ogg` with
 * `audio.codec: "flac"`. Builds 6.1 and 7.1 take the same stream. The `.ogg` default is Vorbis, whose encoder takes one sample.
 * The oracles are ffprobe's stream facts and a separate ffmpeg decode with -xerror, compared with the samples written into
 * the WAV here, not with anything the converter reports.
 */

const skip = skipWithoutTools('ffmpeg', 'ffprobe');
const CONVERSION_TIMEOUT_MS = 60_000;
const SAMPLE_RATE = 48_000;
const BYTES_PER_SAMPLE = 2;
const RIFF_HEADER_BYTES = 44;
/** Stream lengths around the FLAC minimum block of 16 samples: below it, at it and just above it. */
const SHORT_LENGTHS = [1, 2, 15, 16, 17] as const;
const WORKER_LENGTH = 1;

/** Mono 16-bit samples that differ from one another and from zero, so a dropped or repeated sample is visible. */
function samples(count: number): Int16Array {
  return Int16Array.from({ length: count }, (_, i) => 1000 + 37 * i);
}

/** A mono 16-bit PCM WAV laid out as RIFF/WAVE describes it, around `data`. */
function wav(data: Int16Array): Buffer {
  const body = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const header = Buffer.alloc(RIFF_HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(RIFF_HEADER_BYTES - 8 + body.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(body.length, 40);
  return Buffer.concat([header, body]);
}

function pcmBytes(data: Int16Array): Buffer {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** The streams ffprobe lists in the file; it throws when ffprobe cannot open the file. */
function streamsOf(bytes: Buffer, extension: string) {
  return withMediaFile(bytes, extension, (file) => probeFile(requireOracleTool('ffprobe'), file).streams);
}

/** What a separate ffmpeg decodes from the file, with every decode error fatal. */
function decodedOf(bytes: Buffer, extension: string) {
  return withMediaFile(bytes, extension, (file) => decodeAudioStream(requireOracleTool('ffmpeg'), file, SAMPLE_RATE, 1));
}

describe.skipIf(skip)('a WAV file of fewer than 17 samples', () => {
  const lossless: Array<{ label: string; target: string; extension: string; options: ConversionOptions }> = [
    { label: 'flac', target: 'flac', extension: 'flac', options: {} },
    { label: 'ogg with FLAC audio', target: 'ogg', extension: 'ogg', options: { audio: { codec: 'flac' } } },
  ];

  for (const { label, target, extension, options } of lossless) {
    for (const count of SHORT_LENGTHS) {
      it(`converts to ${label} with all ${count} sample(s) kept and a file that ffprobe and ffmpeg read`, { timeout: CONVERSION_TIMEOUT_MS }, async () => {
        const input = samples(count);
        const result = await dispatchConversion(wav(input), 'wav', target, options, 'in.wav');
        const streams = streamsOf(result.buffer, extension);
        expect(streams.map((stream) => stream.codec_name)).toEqual(['flac']);
        const decoded = decodedOf(result.buffer, extension);
        expect(decoded.samplesPerChannel).toBe(count);
        expect(decoded.pcm.equals(pcmBytes(input))).toBe(true);
      });
    }
  }

  it('is converted to flac by the worker engine too, with its sample kept', { timeout: CONVERSION_TIMEOUT_MS }, async () => {
    const input = samples(WORKER_LENGTH);
    const result = await convertWithNativeFfmpeg(wav(input), 'wav', 'flac', { throwOnUnavailable: true }, 'in.wav');
    const decoded = decodedOf(result.buffer, 'flac');
    expect(decoded.samplesPerChannel).toBe(WORKER_LENGTH);
    expect(decoded.pcm.equals(pcmBytes(input))).toBe(true);
  });

  for (const count of SHORT_LENGTHS) {
    oracleTest(`converts to ogg (Vorbis, the default) with a stream of ${count} sample(s) that ffprobe and ffmpeg read`, ['ffmpeg', 'ffprobe'], async () => {
      requireEncoders('libvorbis');
      const result = await dispatchConversion(wav(samples(count)), 'wav', 'ogg', {}, 'in.wav');
      const streams = streamsOf(result.buffer, 'ogg');
      expect(streams.map((stream) => stream.codec_name)).toEqual(['vorbis']);
      expect(Number(streams[0].duration_ts), 'the last Ogg page states the length of the input').toBe(count);
      expect(decodedOf(result.buffer, 'ogg').samplesPerChannel).toBeGreaterThanOrEqual(count);
    }, CONVERSION_TIMEOUT_MS);
  }
});
