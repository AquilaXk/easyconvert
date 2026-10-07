import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convertMedia } from '../src/lib/conversions/media';
import { EngineUnavailableError } from '../src/lib/types';
import {
  sineSamples,
  wavFromSamples,
} from './helpers/media-lossy-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * Media paths that need FFmpeg or ffprobe answer EngineUnavailableError (HTTP 503) when the tool is
 * missing, never a 400. The contract is the error class, so no external oracle is needed.
 */

/** A path that never resolves to a binary: the tool counts as not installed. */
const MISSING_TOOL_PATH = '/nonexistent/easyconvert-missing-tool';
const FFMPEG_CASE_TIMEOUT_MS = 120_000;
const SAMPLE_RATE = 44100;
const MP4_STUB = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x14]),
  Buffer.from('ftypisom', 'ascii'),
  Buffer.from([0x00, 0x00, 0x02, 0x00]),
  Buffer.from('isom', 'ascii'),
]);

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('conversion resolved but was expected to fail closed');
}

function expectEngineUnavailable(err: unknown, engineName: string): void {
  expect(err).toBeInstanceOf(EngineUnavailableError);
  expect((err as EngineUnavailableError).engineName).toBe(engineName);
}

const savedEnv = { ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH };

function restoreEnv(name: 'FFMPEG_PATH' | 'FFPROBE_PATH', value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restoreEnv('FFMPEG_PATH', savedEnv.ffmpeg);
  restoreEnv('FFPROBE_PATH', savedEnv.ffprobe);
  vi.resetModules();
});

describe('FFmpeg missing: every FFmpeg-only route answers EngineUnavailableError', () => {
  type Run = (engine: typeof import('../src/lib/conversions/media')) => Promise<unknown>;
  const wav = wavFromSamples(sineSamples(SAMPLE_RATE, 2, 0.25), SAMPLE_RATE, 2);

  const routes: Array<{ label: string; run: Run }> = [
    {
      label: 'thumbnail extraction',
      run: (e) => e.convertMedia(MP4_STUB, 'mp4', 'jpg', { thumbnail: { at: ['00:00:01.000'] } }, 'clip.mp4'),
    },
    {
      label: 'subtitle extraction',
      run: (e) => e.convertMedia(MP4_STUB, 'mkv', 'srt', { subtitles: { mode: 'extract' } }, 'clip.mkv'),
    },
    { label: 'HLS packaging by target', run: (e) => e.convertMedia(MP4_STUB, 'mp4', 'hls', {}, 'clip.mp4') },
    {
      label: 'DASH packaging by option',
      run: (e) => e.convertMedia(MP4_STUB, 'mp4', 'mp4', { packaging: { format: 'dash' } }, 'clip.mp4'),
    },
    {
      label: 'packageHlsDashMedia called directly',
      run: (e) => e.packageHlsDashMedia(MP4_STUB, 'mp4', { packaging: { format: 'hls' } }, 'clip'),
    },
    { label: 'useFfmpeg: true', run: (e) => e.convertMedia(wav, 'wav', 'wav', { useFfmpeg: true }, 'tone.wav') },
    { label: 'any -> mp3', run: (e) => e.convertMedia(wav, 'wav', 'mp3', {}, 'tone.wav') },
  ];

  beforeEach(() => {
    process.env.FFMPEG_PATH = MISSING_TOOL_PATH;
    vi.resetModules();
  });

  it.each(routes)('$label', async ({ run }) => {
    // The module caches the resolved FFmpeg path, so it is loaded fresh with the tool hidden.
    const engine = await import('../src/lib/conversions/media');
    const types = await import('../src/lib/types');
    const err = await captureError(run(engine));
    expect(err).toBeInstanceOf(types.EngineUnavailableError);
    expect((err as EngineUnavailableError).engineName).toBe('ffmpeg');
  });
});

describe('ffprobe missing while FFmpeg is present', () => {
  oracleTest(
    'a transcode that needs ffprobe answers EngineUnavailableError for ffprobe, not a 400',
    ['ffmpeg', 'ffprobe'],
    async () => {
      process.env.FFPROBE_PATH = MISSING_TOOL_PATH;
      const wav = wavFromSamples(sineSamples(SAMPLE_RATE, 2, 0.25), SAMPLE_RATE, 2);
      // The ITU-R BS.775 downmix inspects the input's channel count with ffprobe.
      const err = await captureError(
        convertMedia(wav, 'wav', 'flac', { audio: { downmix: 'itu-r-bs775' } }, 'tone.wav')
      );
      expectEngineUnavailable(err, 'ffprobe');
    },
    FFMPEG_CASE_TIMEOUT_MS
  );

  oracleTest(
    'useFfmpeg keeps the typed error when ffprobe is missing',
    ['ffmpeg', 'ffprobe'],
    async () => {
      process.env.FFPROBE_PATH = MISSING_TOOL_PATH;
      const wav = wavFromSamples(sineSamples(SAMPLE_RATE, 2, 0.25), SAMPLE_RATE, 2);
      const err = await captureError(
        convertMedia(wav, 'wav', 'flac', { useFfmpeg: true, audio: { downmix: 'itu-r-bs775' } }, 'tone.wav')
      );
      expectEngineUnavailable(err, 'ffprobe');
    },
    FFMPEG_CASE_TIMEOUT_MS
  );
});
