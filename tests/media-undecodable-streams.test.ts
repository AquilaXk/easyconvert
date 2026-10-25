import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { convertWithNativeFfmpeg } from '../src/worker/engines';
import { UnprocessableMediaInputError, UnsupportedMediaCodecError } from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { runFfmpeg } from './helpers/ffmpeg-media-fixtures';
import { MediaDecodeError, decodeAudioStream, probeFile, withMediaFile } from './helpers/ffmpeg-measure';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * Streams that the installed FFmpeg cannot decode, in real files. A conversion either decodes the whole stream or is refused
 * with an error that names the stream or the codec: it never writes a truncated output (an xHE-AAC clip decoded for a quarter
 * of its length by FFmpeg 7.1 and exited with status 0) and never fails with a page of decoder log. The oracle for "can be
 * decoded" is a separate ffmpeg run over the same file with -xerror, which a decoder that gives up on any packet fails.
 */

const skip = skipWithoutTools('ffmpeg', 'ffprobe');
const CONVERSION_TIMEOUT_MS = 180_000;
const SAMPLE_RATE = 48_000;
const STEREO = 2;
const BYTES_PER_SAMPLE = 2;
const PCM16_FULL_SCALE = 32768;
const XHE_AAC_SECONDS = 1;
const DURATION_TOLERANCE_SECONDS = 0.1;
const MIN_RMS_DB = -50;
/** Longest error message that counts as an explanation and not as a dump of the decoder log. */
const MAX_MESSAGE_CHARS = 500;
const CORRUPTED_BYTES = 24;
const CORRUPTION_POSITION = 0.6;
const TONE = 'sine=frequency=440:sample_rate=48000:duration=0.3';
/** Two tones as two inputs. */
const TWO_TONES = ['-f', 'lavfi', '-i', TONE, '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=0.3'];
/** Changes every byte of a stream's packets, header included: nothing of it decodes, and its sample rate is not stated. */
const NOISE_FILTER = 'noise=amount=1';

/** Whether a separate ffmpeg decodes audio stream 0 of the file from start to end without a decode error. */
function oracleDecodesFully(file: string): boolean {
  try {
    decodeAudioStream(requireOracleTool('ffmpeg'), file, SAMPLE_RATE, STEREO);
    return true;
  } catch (error) {
    if (error instanceof MediaDecodeError) return false;
    throw error;
  }
}

function decodedFacts(bytes: Buffer, extension: string): { seconds: number; rmsDb: number } {
  return withMediaFile(bytes, extension, (file) => {
    const pcm = decodeAudioStream(requireOracleTool('ffmpeg'), file, SAMPLE_RATE, STEREO).pcm;
    const frames = pcm.length / (STEREO * BYTES_PER_SAMPLE);
    let energy = 0;
    for (let i = 0; i < pcm.length; i += BYTES_PER_SAMPLE) energy += (pcm.readInt16LE(i) / PCM16_FULL_SCALE) ** 2;
    return { seconds: frames / SAMPLE_RATE, rmsDb: 10 * Math.log10(energy / (pcm.length / BYTES_PER_SAMPLE)) };
  });
}

describe.skipIf(skip)('streams the installed FFmpeg cannot decode', () => {
  describe('an xHE-AAC clip of one second', () => {
    for (const target of ['flac', 'wav', 'mp3', 'aac', 'ogg', 'opus']) {
      it(`to ${target} is converted whole when this FFmpeg decodes it whole, and refused by name otherwise`, { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
        const sample = await requireRealworldSample(ctx, 'fate-xhe_target_level.m4a');
        const decodable = oracleDecodesFully(sample.path);
        const outcome = await dispatchConversion(sample.bytes, 'm4a', target, {}, 'xhe.m4a').then(
          (result) => result,
          (error: unknown) => error
        );
        if (decodable) {
          expect(outcome, 'a decodable stream is converted').toHaveProperty('buffer');
          const facts = decodedFacts((outcome as { buffer: Buffer }).buffer, target);
          expect(Math.abs(facts.seconds - XHE_AAC_SECONDS)).toBeLessThanOrEqual(DURATION_TOLERANCE_SECONDS);
          expect(facts.rmsDb).toBeGreaterThan(MIN_RMS_DB);
          return;
        }
        expect(outcome, 'an undecodable stream is refused, not converted to a truncated file').toBeInstanceOf(UnsupportedMediaCodecError);
        const refusal = outcome as UnsupportedMediaCodecError;
        expect(refusal.message).toMatch(/FFmpeg/);
        expect(refusal.message).toMatch(/decod/i);
        expect(refusal.message.length).toBeLessThan(MAX_MESSAGE_CHARS);
        expect(refusal.codec).toMatch(/xHE-AAC|aac/i);
      });
    }
  });

  describe('a Blu-ray transport stream whose audio stream is not decodable', () => {
    /** Frames the first video stream of a file decodes to, counted by a separate ffprobe. */
    function videoFrames(file: string): number {
      const run = spawnSync(requireOracleTool('ffprobe'), ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file], { encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      // ffprobe lists a stream of a transport stream again under its program.
      return Number(run.stdout.split('\n').find((line) => line.trim() !== ''));
    }

    /** Frames of stream `index` that a separate ffprobe decodes from the first 32 packets. */
    function framesDecoded(bytes: Buffer, index: number): number {
      return withMediaFile(bytes, 'ts', (file) => {
        const run = spawnSync(requireOracleTool('ffprobe'), ['-v', 'quiet', '-select_streams', String(index), '-show_entries', 'frame=pts', '-of', 'csv=p=0', '-read_intervals', '%+#32', file], { encoding: 'utf8' });
        expect(run.status).toBe(0);
        return run.stdout.split('\n').filter((line) => line !== '').length;
      });
    }

    for (const target of ['mp4', 'mkv', 'mov', 'webm', 'avi']) {
      it(`${target} is converted without the audio stream, which is listed as undecodable, after the oracle confirms that no packet of it decodes`, { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
        const sample = await requireRealworldSample(ctx, 'ffs-01200.m2ts');
        expect(oracleDecodesFully(sample.path)).toBe(false);
        const video = spawnSync(requireOracleTool('ffmpeg'), ['-v', 'error', '-xerror', '-i', sample.path, '-map', '0:v:0', '-f', 'null', '-'], { encoding: 'utf8' });
        expect(video.status, 'the video stream alone decodes without error').toBe(0);
        const audioFrames = spawnSync(requireOracleTool('ffprobe'), ['-v', 'quiet', '-select_streams', 'a:0', '-show_entries', 'frame=pts', '-of', 'csv=p=0', sample.path], { encoding: 'utf8' });
        expect(audioFrames.stdout.trim(), 'a separate ffprobe decodes no frame of the audio stream').toBe('');

        const result = await dispatchConversion(sample.bytes, 'm2ts', target, {}, 'ffs-01200.m2ts');
        const dropped = (result.metadata as { droppedStreams?: unknown[] } | undefined)?.droppedStreams;
        expect(dropped).toEqual([{ index: 1, kind: 'audio', codec: 'aac', reason: 'undecodable' }]);
        expect(Object.keys((dropped as object[])[0]).sort(), 'only the contract fields: no path, no decoder log').toEqual(['codec', 'index', 'kind', 'reason']);
        const extension = target === 'webm' ? 'webm' : target;
        withMediaFile(result.buffer, extension, (file) => {
          const streams = probeFile(requireOracleTool('ffprobe'), file).streams;
          expect(streams.map((stream) => stream.codec_type)).toEqual(['video']);
          const decode = spawnSync(requireOracleTool('ffmpeg'), ['-v', 'error', '-xerror', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
          expect(decode.status, decode.stderr).toBe(0);
          expect(videoFrames(file), 'every frame of the source video is in the output').toBe(videoFrames(sample.path));
        });
      });
    }

    it('is converted by the worker engine too, with the same list', { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
      const sample = await requireRealworldSample(ctx, 'ffs-01200.m2ts');
      const result = (await convertWithNativeFfmpeg(sample.bytes, 'm2ts', 'mp4', { throwOnUnavailable: true }, 'ffs-01200.m2ts'))!;
      expect(result.metadata?.droppedStreams).toEqual([{ index: 1, kind: 'audio', codec: 'aac', reason: 'undecodable' }]);
      withMediaFile(result.buffer, 'mp4', (file) => {
        expect(probeFile(requireOracleTool('ffprobe'), file).streams.map((stream) => stream.codec_type)).toEqual(['video']);
      });
    });

    it('keeps the audio track that decodes beside one that does not, and lists only the other', { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
      const sample = await requireRealworldSample(ctx, 'ffs-01200.m2ts');
      const mixed = runFfmpeg(['-i', sample.path, ...TWO_TONES, '-map', '0:v', '-map', '1:a', '-map', '2:a', '-c:v', 'copy', '-c:a', 'aac', '-bsf:a:1', NOISE_FILTER], 'ts');
      const source = withMediaFile(mixed, 'ts', (file) => probeFile(requireOracleTool('ffprobe'), file).streams.filter((stream) => stream.codec_type === 'audio'));
      expect(source.length, 'the file holds two audio streams').toBe(2);
      expect(framesDecoded(mixed, source[0].index), 'a separate ffprobe decodes the first audio stream').toBeGreaterThan(0);
      expect(framesDecoded(mixed, source[1].index), 'and no frame of the second').toBe(0);
      const result = await dispatchConversion(mixed, 'ts', 'mp4', {}, 'mixed.ts');
      expect((result.metadata as { droppedStreams?: unknown[] }).droppedStreams).toEqual([{ index: source[1].index, kind: 'audio', codec: 'aac', reason: 'undecodable' }]);
      withMediaFile(result.buffer, 'mp4', (file) => {
        expect(probeFile(requireOracleTool('ffprobe'), file).streams.map((stream) => stream.codec_type)).toEqual(['video', 'audio']);
        expect(decodeAudioStream(requireOracleTool('ffmpeg'), file, SAMPLE_RATE, STEREO).samplesPerChannel).toBeGreaterThan(0);
      });
    });

    for (const target of ['mp3', 'flac']) {
      it(`${target}, where the audio is the content, is refused with the stream named`, { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
        const sample = await requireRealworldSample(ctx, 'ffs-01200.m2ts');
        const error = await dispatchConversion(sample.bytes, 'm2ts', target, {}, 'ffs-01200.m2ts').catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(UnprocessableMediaInputError);
        const message = (error as Error).message;
        expect(message).toMatch(/audio stream #1/);
        expect(message).toMatch(/aac/);
        expect(message.length).toBeLessThan(MAX_MESSAGE_CHARS);
      });
    }

    it('mp4 is refused when the undecodable audio stream is the one asked for', { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
      const sample = await requireRealworldSample(ctx, 'ffs-01200.m2ts');
      const error = await dispatchConversion(sample.bytes, 'm2ts', 'mp4', { audio: { track: 0 } }, 'ffs-01200.m2ts').catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UnprocessableMediaInputError);
      expect((error as Error).message).toMatch(/audio stream #1/);
    });

    it('mp4 is refused when the file holds no picture, only the undecodable audio stream', { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
      const sample = await requireRealworldSample(ctx, 'ffs-01200.m2ts');
      expect(sample.bytes.length).toBeGreaterThan(0);
      const audioOnly = runFfmpeg(['-f', 'lavfi', '-i', TONE, '-c:a', 'aac', '-bsf:a', NOISE_FILTER], 'ts');
      expect(framesDecoded(audioOnly, 0), 'a separate ffprobe decodes no frame of it').toBe(0);
      const error = await dispatchConversion(audioOnly, 'ts', 'mp4', {}, 'audio-only.ts').catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UnprocessableMediaInputError);
      expect((error as Error).message.length).toBeLessThan(MAX_MESSAGE_CHARS);
    });
  });

  describe('the same transport stream converted to an audio target that probes the sample rate first', () => {
    it('wma is refused by the same typed error, not with the probe output', { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
      const sample = await requireRealworldSample(ctx, 'ffs-01200.m2ts');
      const error = await dispatchConversion(sample.bytes, 'm2ts', 'wma', {}, 'ffs-01200.m2ts').catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(UnprocessableMediaInputError);
      expect((error as Error).message).toMatch(/audio stream a:0 cannot be decoded/);
      expect((error as Error).message.length).toBeLessThan(MAX_MESSAGE_CHARS);
    });
  });

  describe('a stream with a few damaged packets', () => {
    it('is still converted, with damage skipped, as it was before', { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
      const sample = await requireRealworldSample(ctx, 'fate-tones_afconvert_44100_stereo_aac_lc.m4a');
      const damaged = Buffer.from(sample.bytes);
      damaged.fill(0xff, Math.floor(damaged.length * CORRUPTION_POSITION), Math.floor(damaged.length * CORRUPTION_POSITION) + CORRUPTED_BYTES);
      const sourceSeconds = Number(probeFile(requireOracleTool('ffprobe'), sample.path).format.duration);
      const result = await dispatchConversion(damaged, 'm4a', 'wav', {}, 'damaged.m4a');
      const facts = decodedFacts(result.buffer, 'wav');
      expect(Math.abs(facts.seconds - sourceSeconds)).toBeLessThanOrEqual(DURATION_TOLERANCE_SECONDS);
      expect(facts.rmsDb).toBeGreaterThan(MIN_RMS_DB);
    });
  });
});
