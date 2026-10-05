import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertMedia } from '../src/lib/conversions/media';
import { decodeAudioBuffer } from '../src/lib/conversions/media-decoder';
import { encodeFlacStream } from '../src/lib/conversions/media-encoder';
import { ConversionFailedError, EngineUnavailableError } from '../src/lib/types';
import { getOracleToolPath } from './helpers/differential-oracle';
import {
  adtsStream,
  bestSnrDb,
  chirpSamples,
  decodeAudioWithFfmpeg,
  ffmpegDecodeRaw,
  probeStream,
  silentRawDataBlock,
  sineSamples,
  wavFromSamples,
  wavWithEncoding,
  withTempFile,
  type RawWavEncoding,
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
/** Reference FFmpeg encode, probe and SNR sweep per case; generous so a loaded CI host cannot flake. */
const FFMPEG_CASE_TIMEOUT_MS = 120_000;

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('conversion resolved but was expected to fail closed');
}

/**
 * Every target the in-process engine cannot produce faithfully, authored by hand rather than
 * derived from the module under test so a target silently dropped from its tables still fails here.
 */
const PURE_UNAVAILABLE_TARGETS = [
  'opus', 'ogg', 'vorbis', 'aac', 'm4a', 'mp4', 'mov', 'mp3', 'wma', 'webm', 'mkv', 'avi', 'adts',
  'wmv', 'flv', 'weba', '3gp', 'ogv', 'ac3', 'amr',
];

/** Minimal ISO BMFF ftyp box: a source whose bytes the pure decoder must never be asked to read. */
const MP4_STUB = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x14]),
  Buffer.from('ftypisom', 'ascii'),
  Buffer.from([0x00, 0x00, 0x02, 0x00]),
  Buffer.from('isom', 'ascii'),
]);

describe('targets the pure engine cannot produce fail closed without FFmpeg', () => {
  const wav = wavFromSamples(sineSamples(44100, 2, 0.5), 44100, 2);

  it.each(PURE_UNAVAILABLE_TARGETS)('rejects wav -> %s when the native engine is unavailable', async (target) => {
    const err = await captureError(convertMedia(wav, 'wav', target, { disableNativeEngine: true }, 'tone.wav'));
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect((err as EngineUnavailableError).engineName).toBe('ffmpeg');
    expect((err as EngineUnavailableError).message).toContain('Native FFmpeg engine is required');
    expect((err as EngineUnavailableError).message).toContain(target.toUpperCase());
  });

  it.each(PURE_UNAVAILABLE_TARGETS)('rejects mp4 -> %s before decoding the source', async (target) => {
    const err = await captureError(convertMedia(MP4_STUB, 'mp4', target, { disableNativeEngine: true }, 'clip.mp4'));
    expect(err).toBeInstanceOf(EngineUnavailableError);
    expect((err as EngineUnavailableError).engineName).toBe('ffmpeg');
  });

  it.each(PURE_UNAVAILABLE_TARGETS)(
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

describe('an undecodable source is a typed client error, never a bare Error', () => {
  it('rejects an mp4 source for a wav target with ConversionFailedError', async () => {
    const err = await captureError(convertMedia(MP4_STUB, 'mp4', 'wav', { disableNativeEngine: true }, 'clip.mp4'));
    expect(err).toBeInstanceOf(ConversionFailedError);
    expect((err as Error).name).toBe('ConversionFailedError');
    expect((err as Error).message).toContain('Unsupported audio format');
  });

  it.each([Buffer.alloc(0), Buffer.from('definitely not audio data'), MP4_STUB])(
    'decodeAudioBuffer throws ConversionFailedError for %#',
    (bytes) => {
      let thrown: unknown;
      try {
        decodeAudioBuffer(bytes);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ConversionFailedError);
      expect((thrown as Error).name).toBe('ConversionFailedError');
      expect((thrown as Error).message).toBe('Unsupported audio format: decoder unavailable');
    }
  );
});

describe('the pure WAV and FLAC path refuses sources it cannot reproduce faithfully', () => {
  const RATE = 44100;
  const unfaithfulSources: Array<{ label: string; build: () => Buffer }> = [
    { label: '6-channel 16-bit', build: () => wavFromSamples(chirpSamples(RATE, 6, 0.25), RATE, 6) },
    { label: '3-channel 16-bit', build: () => wavFromSamples(chirpSamples(RATE, 3, 0.25), RATE, 3) },
    ...(['s24', 'u8', 's32', 'f32', 'f64'] as RawWavEncoding[]).map((encoding) => ({
      label: `stereo ${encoding}`,
      build: () => wavWithEncoding(chirpSamples(RATE, 2, 0.25), RATE, 2, encoding),
    })),
  ];

  for (const target of ['wav', 'flac']) {
    it.each(unfaithfulSources)(`rejects $label wav -> ${target} instead of clamping or truncating`, async ({ build }) => {
      const err = await captureError(convertMedia(build(), 'wav', target, { disableNativeEngine: true }, 'src.wav'));
      expect(err).toBeInstanceOf(EngineUnavailableError);
      expect((err as EngineUnavailableError).engineName).toBe('ffmpeg');
      expect((err as EngineUnavailableError).message).toContain('faithfully');
    });
  }

  oracleTest(
    'rejects a 24-bit FLAC source authored by the reference encoder',
    ['ffmpeg'],
    async () => {
      const wav24 = wavWithEncoding(chirpSamples(RATE, 2, 0.25), RATE, 2, 's24');
      const flac24 = withTempFile(wav24, 'wav', (file) =>
        execFileSync(
          getOracleToolPath('ffmpeg') as string,
          ['-v', 'error', '-i', file, '-c:a', 'flac', '-sample_fmt', 's32', '-f', 'flac', '-'],
          { maxBuffer: 64 * 1024 * 1024 }
        )
      );
      expect(flac24.subarray(0, 4).toString('ascii')).toBe('fLaC');
      for (const target of ['wav', 'flac']) {
        const err = await captureError(convertMedia(flac24, 'flac', target, { disableNativeEngine: true }, 'src.flac'));
        expect(err).toBeInstanceOf(EngineUnavailableError);
      }
    },
    FFMPEG_CASE_TIMEOUT_MS
  );

  it.each([3, 6, 8])('encodeFlacStream throws on %i channels instead of clamping to stereo', (channels) => {
    const samples = chirpSamples(RATE, channels, 0.1);
    expect(() => encodeFlacStream(samples, RATE, channels)).toThrow(ConversionFailedError);
  });
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
        const source = chirpSamples(sampleRate, channels, 1);
        const wav = wavFromSamples(source, sampleRate, channels);
        const result = await convertMedia(wav, 'wav', 'aac', { allowPureLossyBitstream: true }, 'tone.wav');

        const stream = probeStream(result.buffer, 'aac', 'a');
        expect(stream.codec_name).toBe('aac');
        expect(Number(stream.sample_rate)).toBe(sampleRate);
        expect(Number(stream.channels)).toBe(channels);

        const decoded = decodeAudioWithFfmpeg(result.buffer, 'aac', sampleRate, channels);
        expect(bestSnrDb(source, decoded, channels)).toBeGreaterThanOrEqual(MIN_ROUNDTRIP_SNR_DB);
      },
      FFMPEG_CASE_TIMEOUT_MS
    );
  }

  const containerCases: Array<{ target: string; codec: string }> = [
    { target: 'm4a', codec: 'aac' },
    { target: 'mp4', codec: 'aac' },
    { target: 'mp3', codec: 'mp3' },
  ];
  for (const { target, codec } of containerCases) {
    for (const channels of [1, 2]) {
      oracleTest(
        `wav -> ${target} (x${channels}) is ${codec} and decodes back to the source chirp`,
        ['ffmpeg', 'ffprobe'],
        async () => {
          const source = chirpSamples(44100, channels, 1);
          const wav = wavFromSamples(source, 44100, channels);
          const result = await convertMedia(wav, 'wav', target, { allowPureLossyBitstream: true }, 'tone.wav');
          expect(probeStream(result.buffer, target, 'a').codec_name).toBe(codec);
          const decoded = decodeAudioWithFfmpeg(result.buffer, target, 44100, channels);
          expect(bestSnrDb(source, decoded, channels)).toBeGreaterThanOrEqual(MIN_ROUNDTRIP_SNR_DB);
        },
        FFMPEG_CASE_TIMEOUT_MS
      );
    }
  }

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
        expect(gray).toHaveLength(160 * 120);
        let sum = 0;
        for (const v of gray) sum += v;
        const mean = sum / gray.length;
        let variance = 0;
        for (const v of gray) variance += (v - mean) * (v - mean);
        expect(Math.sqrt(variance / gray.length)).toBeGreaterThan(MIN_FRAME_STDDEV);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    FFMPEG_CASE_TIMEOUT_MS
  );
});

describe('lossless pure paths stay faithful', () => {
  for (const channels of [1, 2]) {
    oracleTest(`wav -> flac without FFmpeg decodes bit-exact (x${channels})`, ['ffmpeg'], async () => {
      const source = chirpSamples(44100, channels, 0.5);
      const wav = wavFromSamples(source, 44100, channels);
      const result = await convertMedia(wav, 'wav', 'flac', { disableNativeEngine: true }, 'tone.wav');
      const decoded = decodeAudioWithFfmpeg(result.buffer, 'flac', 44100, channels);
      expect(decoded).toHaveLength(source.length);
      expect(Array.from(decoded)).toEqual(Array.from(source));
    }, FFMPEG_CASE_TIMEOUT_MS);

    oracleTest(`wav -> wav without FFmpeg decodes bit-exact (x${channels})`, ['ffmpeg'], async () => {
      const source = chirpSamples(44100, channels, 0.5);
      const wav = wavFromSamples(source, 44100, channels);
      const result = await convertMedia(wav, 'wav', 'wav', { disableNativeEngine: true }, 'tone.wav');
      const decoded = decodeAudioWithFfmpeg(result.buffer, 'wav', 44100, channels);
      expect(decoded).toHaveLength(source.length);
      expect(Array.from(decoded)).toEqual(Array.from(source));
    }, FFMPEG_CASE_TIMEOUT_MS);

    oracleTest(`flac -> wav without FFmpeg decodes bit-exact (x${channels})`, ['ffmpeg'], async () => {
      const source = chirpSamples(44100, channels, 0.5);
      const flac = withTempFile(wavFromSamples(source, 44100, channels), 'wav', (file) =>
        execFileSync(getOracleToolPath('ffmpeg') as string, ['-v', 'error', '-i', file, '-c:a', 'flac', '-f', 'flac', '-'], {
          maxBuffer: 64 * 1024 * 1024,
        })
      );
      const result = await convertMedia(flac, 'flac', 'wav', { disableNativeEngine: true }, 'tone.flac');
      const decoded = decodeAudioWithFfmpeg(result.buffer, 'wav', 44100, channels);
      expect(decoded).toHaveLength(source.length);
      expect(Array.from(decoded)).toEqual(Array.from(source));
    }, FFMPEG_CASE_TIMEOUT_MS);
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
        expect(decoded).toHaveLength(FIXTURE_FRAMES * SAMPLES_PER_AAC_FRAME * channels);
        expect(decoded.every((v) => v === 0)).toBe(true);
      }
    );
  }
});
