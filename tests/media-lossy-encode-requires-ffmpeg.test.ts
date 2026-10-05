import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertMedia, LOSSY_PSYCHOACOUSTIC_FORMATS } from '../src/lib/conversions/media';
import { ConversionFailedError, EngineUnavailableError } from '../src/lib/types';
import { getOracleToolPath } from './helpers/differential-oracle';
import {
  adtsStream,
  bestSnrDb,
  decodeAudioWithFfmpeg,
  ffmpegDecodeRaw,
  probeStream,
  silentRawDataBlock,
  sineSamples,
  wavFromSamples,
} from './helpers/media-lossy-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * Regression suite for the removed in-process lossy encoders. Without FFmpeg a lossy encode must
 * raise EngineUnavailableError (HTTP 503); with FFmpeg the bytes must come from FFmpeg and decode
 * back to the source signal, never to flat or synthesized content. The oracle is the FFmpeg and
 * FFprobe command line tools, independent of the module under test.
 */

const MIN_ROUNDTRIP_SNR_DB = 25;
const MIN_FRAME_STDDEV = 20;

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('conversion resolved but was expected to fail closed');
}

const LOSSY_ENCODE_TARGETS = [...LOSSY_PSYCHOACOUSTIC_FORMATS, 'adts'];

describe('lossy encodes without FFmpeg fail closed with EngineUnavailableError', () => {
  const wav = wavFromSamples(sineSamples(44100, 2, 0.5), 44100, 2);

  it.each(LOSSY_ENCODE_TARGETS)('rejects wav -> %s when the native engine is unavailable', async (target) => {
    const err = await captureError(convertMedia(wav, 'wav', target, { disableNativeEngine: true }, 'tone.wav'));
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect((err as EngineUnavailableError).engineName).toBe('ffmpeg');
    expect((err as EngineUnavailableError).message).toContain(`lossy ${target.toUpperCase()} compression`);
  });

  it.each(LOSSY_ENCODE_TARGETS)(
    'ignores the allowPureLossyBitstream opt-in for wav -> %s',
    async (target) => {
      const err = await captureError(
        convertMedia(wav, 'wav', target, { disableNativeEngine: true, allowPureLossyBitstream: true }, 'tone.wav')
      );
      expect(err).toBeInstanceOf(EngineUnavailableError);
      expect(err).toBeInstanceOf(ConversionFailedError);
      expect((err as EngineUnavailableError).engineName).toBe('ffmpeg');
    }
  );
});

describe('lossy encodes with FFmpeg come from FFmpeg and decode back to the source', () => {
  const cases: Array<{ sampleRate: number; channels: number }> = [
    { sampleRate: 44100, channels: 1 },
    { sampleRate: 44100, channels: 2 },
    { sampleRate: 48000, channels: 2 },
    { sampleRate: 22050, channels: 1 },
  ];

  for (const { sampleRate, channels } of cases) {
    oracleTest(
      `wav -> aac at ${sampleRate} Hz x${channels} keeps SNR >= ${MIN_ROUNDTRIP_SNR_DB} dB even when the pure opt-in is set`,
      ['ffmpeg', 'ffprobe'],
      async () => {
        const source = sineSamples(sampleRate, channels, 1);
        const wav = wavFromSamples(source, sampleRate, channels);
        const result = await convertMedia(wav, 'wav', 'aac', { allowPureLossyBitstream: true }, 'tone.wav');

        const stream = probeStream(result.buffer, 'aac', 'a');
        expect(stream.codec_name).toBe('aac');
        expect(Number(stream.sample_rate)).toBe(sampleRate);
        expect(Number(stream.channels)).toBe(channels);

        const decoded = decodeAudioWithFfmpeg(result.buffer, 'aac', sampleRate, channels);
        expect(bestSnrDb(source, decoded, channels)).toBeGreaterThanOrEqual(MIN_ROUNDTRIP_SNR_DB);
      }
    );
  }

  oracleTest('wav -> m4a, mp4 and mp3 decode back to the source tone', ['ffmpeg', 'ffprobe'], async () => {
    const source = sineSamples(44100, 1, 1);
    const wav = wavFromSamples(source, 44100, 1);
    const expectedCodec: Record<string, string> = { m4a: 'aac', mp4: 'aac', mp3: 'mp3' };
    for (const target of Object.keys(expectedCodec)) {
      const result = await convertMedia(wav, 'wav', target, { allowPureLossyBitstream: true }, 'tone.wav');
      expect(probeStream(result.buffer, target, 'a').codec_name).toBe(expectedCodec[target]);
      const decoded = decodeAudioWithFfmpeg(result.buffer, target, 44100, 1);
      expect(bestSnrDb(source, decoded, 1)).toBeGreaterThanOrEqual(MIN_ROUNDTRIP_SNR_DB);
    }
  });

  oracleTest(
    'video re-encode never returns frames that decode flat',
    ['ffmpeg', 'ffprobe'],
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-lossy-src-'));
      try {
        const sourcePath = path.join(dir, 'source.mp4');
        execFileSync(getOracleToolPath('ffmpeg') as string, [
          '-v', 'error', '-y',
          '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1',
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
          sourcePath,
        ]);
        const source = fs.readFileSync(sourcePath);

        const result = await convertMedia(source, 'mp4', 'mp4', { allowPureLossyBitstream: true }, 'source.mp4');

        const video = probeStream(result.buffer, 'mp4', 'v');
        expect(video.codec_name).toBe('h264');
        expect(Number(video.width)).toBe(160);
        expect(Number(video.height)).toBe(120);

        const gray = ffmpegDecodeRaw(result.buffer, 'mp4', ['-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray']);
        expect(gray.length).toBe(160 * 120);
        let sum = 0;
        for (const v of gray) sum += v;
        const mean = sum / gray.length;
        let variance = 0;
        for (const v of gray) variance += (v - mean) * (v - mean);
        expect(Math.sqrt(variance / gray.length)).toBeGreaterThan(MIN_FRAME_STDDEV);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});

describe('lossless pure paths stay faithful', () => {
  for (const channels of [1, 2]) {
    oracleTest(`wav -> flac without FFmpeg decodes bit-exact (x${channels})`, ['ffmpeg'], async () => {
      const source = sineSamples(44100, channels, 0.5);
      const wav = wavFromSamples(source, 44100, channels);
      const result = await convertMedia(wav, 'wav', 'flac', { disableNativeEngine: true }, 'tone.wav');
      const decoded = decodeAudioWithFfmpeg(result.buffer, 'flac', 44100, channels);
      expect(decoded.length).toBe(source.length);
      expect(Array.from(decoded)).toEqual(Array.from(source));
    });
  }
});

describe('hand-authored AAC fixtures are valid for the reference decoder', () => {
  const FIXTURE_FRAMES = 4;
  const SAMPLES_PER_AAC_FRAME = 1024;

  for (const channels of [1, 2] as const) {
    oracleTest(
      `silent ADTS fixture (x${channels}) decodes to ${FIXTURE_FRAMES} frames of silence`,
      ['ffmpeg', 'ffprobe'],
      () => {
        const block = silentRawDataBlock(channels);
        const stream = adtsStream(new Array(FIXTURE_FRAMES).fill(block), 44100, channels);

        const info = probeStream(stream, 'aac', 'a');
        expect(info.codec_name).toBe('aac');
        expect(Number(info.sample_rate)).toBe(44100);
        expect(Number(info.channels)).toBe(channels);

        const decoded = decodeAudioWithFfmpeg(stream, 'aac', 44100, channels);
        expect(decoded.length).toBe(FIXTURE_FRAMES * SAMPLES_PER_AAC_FRAME * channels);
        expect(decoded.every((v) => v === 0)).toBe(true);
      }
    );
  }
});
