import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { convertWithNativeFfmpeg } from '../src/worker/engines';
import { EmptyAudioInputError, UnprocessableMediaInputError, isUnprocessableInputError } from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { decodeAudioStream, probeFile, withMediaFile } from './helpers/ffmpeg-measure';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * A WAV file whose data chunk is empty has a header and no audio. ADTS, the file format of a `.aac` target, is a run of
 * frames that each carry their own header (ISO/IEC 14496-3, subpart 1, annex 1.A.2) and has no file header, so zero frames
 * are zero bytes: nothing a reader can recognise as AAC. The conversion is therefore refused with an answer that names
 * the real limit of the file. Containers that carry a stream of zero frames (MP4, MP3, FLAC) keep converting such a file
 * to a readable, empty file. The oracles are ffprobe's packet counts and RIFF layout read here, not the converter's own.
 */

const skip = skipWithoutTools('ffmpeg', 'ffprobe');
const CONVERSION_TIMEOUT_MS = 60_000;
const SAMPLE_RATE = 8000;
const TONE_SECONDS = 1;
const TONE_HZ = 440;
/** AAC priming and the last frame's padding: about two frames of 1,024 samples. */
const DURATION_TOLERANCE_SECONDS = 0.3;
const RIFF_HEADER_BYTES = 44;
const DATA_SIZE_OFFSET = 40;
const SAMPLE_FILE = 'kaitai-small.wav';

/** A mono 16-bit PCM WAV laid out as the RIFF/WAVE format describes it, around `samples`. */
function wav(samples: Int16Array): Buffer {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const header = Buffer.alloc(RIFF_HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(RIFF_HEADER_BYTES - 8 + data.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, DATA_SIZE_OFFSET);
  return Buffer.concat([header, data]);
}

function tone(): Int16Array {
  const samples = new Int16Array(SAMPLE_RATE * TONE_SECONDS);
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.round(12000 * Math.sin((2 * Math.PI * TONE_HZ * i) / SAMPLE_RATE));
  return samples;
}

/** Audio packets ffprobe reads from the file, summed over its audio streams (a stream without a packet states no count). */
function audioPackets(bytes: Buffer, extension: string): number {
  return withMediaFile(bytes, extension, (file) => {
    const run = spawnSync(
      requireOracleTool('ffprobe'),
      ['-v', 'error', '-count_packets', '-select_streams', 'a', '-show_entries', 'stream=nb_read_packets', '-of', 'json', file],
      { encoding: 'utf8' }
    );
    expect(run.status, run.stderr).toBe(0);
    const streams = (JSON.parse(run.stdout) as { streams: Array<{ nb_read_packets?: string }> }).streams;
    expect(streams.length, 'the file has an audio stream').toBeGreaterThan(0);
    return streams.reduce((sum, stream) => sum + Number(stream.nb_read_packets ?? 0), 0);
  });
}

function outcomeOf(bytes: Buffer, target: string): Promise<unknown> {
  return dispatchConversion(bytes, 'wav', target, {}, 'in.wav').then(
    (result) => result,
    (error: unknown) => error
  );
}

describe.skipIf(skip)('a WAV file with a header and no samples', () => {
  const empty = wav(new Int16Array(0));

  it('is empty by the oracles: a data chunk of zero bytes and no audio packet', () => {
    expect(empty.readUInt32LE(DATA_SIZE_OFFSET)).toBe(0);
    expect(empty.length).toBe(RIFF_HEADER_BYTES);
    expect(audioPackets(empty, 'wav')).toBe(0);
  });

  it('the corpus file kaitai-small.wav is such a file', { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
    const sample = await requireRealworldSample(ctx, SAMPLE_FILE);
    expect(sample.bytes.subarray(36, 40).toString('ascii')).toBe('data');
    expect(sample.bytes.readUInt32LE(DATA_SIZE_OFFSET)).toBe(0);
    expect(sample.bytes.length).toBe(RIFF_HEADER_BYTES);
    expect(audioPackets(sample.bytes, 'wav')).toBe(0);
  });

  it('is refused for aac with an answer that says the file holds no audio samples (HTTP 422)', { timeout: CONVERSION_TIMEOUT_MS }, async () => {
    const outcome = await outcomeOf(empty, 'aac');
    expect(outcome).toBeInstanceOf(EmptyAudioInputError);
    expect(outcome).toBeInstanceOf(UnprocessableMediaInputError);
    const refusal = outcome as EmptyAudioInputError;
    expect(refusal.status).toBe(422);
    expect(refusal.message).toMatch(/holds no audio samples/);
    expect(refusal.message).toMatch(/\.aac/);
    expect(isUnprocessableInputError(refusal)).toBe(true);
  });

  it('the corpus file is refused for aac the same way', { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
    const sample = await requireRealworldSample(ctx, SAMPLE_FILE);
    const outcome = await outcomeOf(sample.bytes, 'aac');
    expect(outcome).toBeInstanceOf(EmptyAudioInputError);
    expect((outcome as EmptyAudioInputError).status).toBe(422);
    expect((outcome as EmptyAudioInputError).message).toMatch(/holds no audio samples/);
  });

  it('is refused by the worker engine as well, which does not go through the in-process route', { timeout: CONVERSION_TIMEOUT_MS }, async () => {
    const outcome = await convertWithNativeFfmpeg(empty, 'wav', 'aac', { throwOnUnavailable: true }, 'in.wav').then(
      (result) => result,
      (error: unknown) => error
    );
    expect(outcome).toBeInstanceOf(EmptyAudioInputError);
    expect((outcome as EmptyAudioInputError).status).toBe(422);
    expect((outcome as EmptyAudioInputError).message).toMatch(/holds no audio samples/);
  });

  for (const [target, codec] of [
    ['flac', 'flac'],
    ['wav', 'pcm_s16le'],
  ] as const) {
    it(`still converts to ${target}: a file that carries a stream of zero frames and that ffprobe and ffmpeg read`, { timeout: CONVERSION_TIMEOUT_MS }, async () => {
      const outcome = await outcomeOf(empty, target);
      expect(outcome).toHaveProperty('buffer');
      const bytes = (outcome as { buffer: Buffer }).buffer;
      expect(bytes.length).toBeGreaterThan(0);
      const streams = withMediaFile(bytes, target, (file) => probeFile(requireOracleTool('ffprobe'), file).streams);
      expect(streams.map((stream) => stream.codec_name)).toEqual([codec]);
      const decoded = withMediaFile(bytes, target, (file) => decodeAudioStream(requireOracleTool('ffmpeg'), file, SAMPLE_RATE, 1));
      expect(decoded.samplesPerChannel).toBe(0);
    });
  }
});

describe.skipIf(skip)('a WAV file with samples', () => {
  it('still converts to aac: the refusal is for no samples, not for short or quiet files', { timeout: CONVERSION_TIMEOUT_MS }, async () => {
    const outcome = await outcomeOf(wav(tone()), 'aac');
    expect(outcome).toHaveProperty('buffer');
    const bytes = (outcome as { buffer: Buffer }).buffer;
    expect(audioPackets(bytes, 'aac')).toBeGreaterThan(0);
    const decoded = withMediaFile(bytes, 'aac', (file) => decodeAudioStream(requireOracleTool('ffmpeg'), file, SAMPLE_RATE, 1));
    expect(Math.abs(decoded.samplesPerChannel / SAMPLE_RATE - TONE_SECONDS)).toBeLessThanOrEqual(DURATION_TOLERANCE_SECONDS);
  });

  it('one sample is enough to convert', { timeout: CONVERSION_TIMEOUT_MS }, async () => {
    const outcome = await outcomeOf(wav(new Int16Array([1000])), 'aac');
    expect(outcome).toHaveProperty('buffer');
    expect(audioPackets((outcome as { buffer: Buffer }).buffer, 'aac')).toBeGreaterThan(0);
  });
});
