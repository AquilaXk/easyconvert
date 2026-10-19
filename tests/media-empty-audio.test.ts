import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { convertWithNativeFfmpeg } from '../src/worker/engines';
import { audioPacketsAtStart, emptyOutputError } from '../src/lib/conversions/media-empty-output';
import { resolveFfprobeBinary } from '../src/lib/conversions/media-ffprobe';
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

describe.skipIf(skip)('the probe that tells an empty input from another cause of an empty output', () => {
  const LONG_SECONDS = 120;
  /** More audio packets than a probe that reads the start could return: a 120 s stereo file holds thousands. */
  const MANY_PACKETS = 1000;
  let workDir: string;
  let ffprobe: ReturnType<typeof resolveFfprobeBinary>;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-audio-probe-'));
    ffprobe = resolveFfprobeBinary(requireOracleTool('ffmpeg'));
  });
  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function generate(name: string, args: string[]): string {
    const out = path.join(workDir, name);
    const run = spawnSync(requireOracleTool('ffmpeg'), ['-v', 'error', '-y', ...args, out], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    return out;
  }

  it('gives the plain empty-output error, not the named refusal, for a file with no audio stream', () => {
    const videoOnly = generate('video-only.mkv', ['-f', 'lavfi', '-i', 'color=c=black:size=64x64:rate=5:duration=1', '-c:v', 'ffv1']);
    expect(audioPacketsAtStart(videoOnly, ffprobe)).toBeUndefined();
    const error = emptyOutputError(videoOnly, requireOracleTool('ffmpeg'), 'mkv', 'aac');
    expect(error).not.toBeInstanceOf(EmptyAudioInputError);
    expect(error.message).toBe('FFmpeg output is empty (0 bytes) for mkv -> aac');
  });

  it('reads one packet of a long file: ffprobe counts thousands in it, the probe stops at the first', () => {
    const long = generate('long.wav', ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${LONG_SECONDS}`, '-ac', '2', '-c:a', 'pcm_s16le']);
    const counted = spawnSync(
      requireOracleTool('ffprobe'),
      ['-v', 'error', '-count_packets', '-select_streams', 'a', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', long],
      { encoding: 'utf8' }
    );
    expect(Number(counted.stdout.trim())).toBeGreaterThan(MANY_PACKETS);
    expect(audioPacketsAtStart(long, ffprobe)).toBe(1);
    expect(emptyOutputError(long, requireOracleTool('ffmpeg'), 'wav', 'aac')).not.toBeInstanceOf(EmptyAudioInputError);
  });

  it('reports zero packets for an audio stream with none', () => {
    const emptyFile = path.join(workDir, 'empty.wav');
    fs.writeFileSync(emptyFile, wav(new Int16Array(0)));
    expect(audioPacketsAtStart(emptyFile, ffprobe)).toBe(0);
  });
});
