import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { UnprocessableMediaInputError, UnsupportedMediaCodecError } from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
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
    for (const target of ['flac', 'wav', 'mp3', 'aac']) {
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
    for (const target of ['mp4', 'mkv', 'mov']) {
      it(`${target} is refused with the stream named, after the oracle confirms that no packet of it decodes`, { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
        const sample = await requireRealworldSample(ctx, 'ffs-01200.m2ts');
        expect(oracleDecodesFully(sample.path)).toBe(false);
        const video = spawnSync(requireOracleTool('ffmpeg'), ['-v', 'error', '-xerror', '-i', sample.path, '-map', '0:v:0', '-f', 'null', '-'], { encoding: 'utf8' });
        expect(video.status, 'the video stream alone decodes without error').toBe(0);

        const error = await dispatchConversion(sample.bytes, 'm2ts', target, {}, 'ffs-01200.m2ts').catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(UnprocessableMediaInputError);
        const message = (error as Error).message;
        expect(message).toMatch(/audio stream #1/);
        expect(message).toMatch(/aac/);
        expect(message.length).toBeLessThan(MAX_MESSAGE_CHARS);
      });
    }
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
