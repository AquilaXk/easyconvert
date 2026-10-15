import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convertMedia } from '../src/lib/conversions/media';
import { decodeAudioBuffer } from '../src/lib/conversions/media-decoder';
import { ConversionOptionsSchema } from '../src/lib/api/contracts/schemas';
import { GET as getOpenApiSpec } from '../src/app/api/openapi.json/route';
import { EngineUnavailableError } from '../src/lib/types';
import {
  adtsStream,
  decodeAudioWithFfmpeg,
  probeStream,
  silentRawDataBlock,
  sineSamples,
  wavFromSamples,
} from './helpers/media-lossy-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * Media paths that need FFmpeg or ffprobe answer EngineUnavailableError (HTTP 503) when the tool is
 * missing, never a 400 or 500, and no in-process AAC decoder or MP3 encoder exists to stand in.
 * The 503 paths need no external oracle (the contract is the error class); the paths FFmpeg serves
 * are checked against FFprobe and an FFmpeg decode of the real output.
 */

/** A path that never resolves to a binary: the tool counts as not installed. */
const MISSING_TOOL_PATH = '/nonexistent/easyconvert-missing-tool';
/** Triangular dither spans two least-significant bits either way; rounding adds none beyond that. */
const MAX_DITHER_SAMPLE = 2;
const FFMPEG_CASE_TIMEOUT_MS = 120_000;
const SAMPLE_RATE = 44100;
const AAC_FIXTURE_FRAMES = 4;
const SAMPLES_PER_AAC_FRAME = 1024;
/** First bytes of a random payload behind a valid ADTS header; the old decoder threw a bare Error on it. */
const CORRUPT_AAC_PAYLOAD = Buffer.from([0x13, 0x37, 0xca, 0xfe, 0xba, 0xbe, 0xde, 0xad, 0xbe, 0xef]);

const MP4_STUB = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x14]),
  Buffer.from('ftypisom', 'ascii'),
  Buffer.from([0x00, 0x00, 0x02, 0x00]),
  Buffer.from('isom', 'ascii'),
]);

function silentAdts(channels: 1 | 2): Buffer {
  const block = silentRawDataBlock(channels);
  return adtsStream(new Array(AAC_FIXTURE_FRAMES).fill(block), SAMPLE_RATE, channels);
}

function corruptAdts(): Buffer {
  return adtsStream([CORRUPT_AAC_PAYLOAD, CORRUPT_AAC_PAYLOAD], SAMPLE_RATE, 2);
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('conversion resolved but was expected to fail closed');
}

function captureSyncError(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  throw new Error('call returned but was expected to fail closed');
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
    { label: 'aac -> wav', run: (e) => e.convertMedia(silentAdts(2), 'aac', 'wav', {}, 'tone.aac') },
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

describe('no in-process AAC decoder: an AAC source needs FFmpeg', () => {
  const sources: Array<{ label: string; bytes: () => Buffer }> = [
    { label: 'a valid silent mono ADTS stream', bytes: () => silentAdts(1) },
    { label: 'a valid silent stereo ADTS stream', bytes: () => silentAdts(2) },
    { label: 'an ADTS stream with a corrupt payload', bytes: corruptAdts },
  ];

  for (const target of ['wav', 'flac']) {
    it.each(sources)(`aac -> ${target} of $label is a 503 before any decoding`, async ({ bytes }) => {
      const err = await captureError(convertMedia(bytes(), 'aac', target, { disableNativeEngine: true }, 'tone.aac'));
      expectEngineUnavailable(err, 'ffmpeg');
    });
  }

  it.each(['aac', 'adts', 'm4a'])('refuses the %s hint even when the bytes are not AAC at all', async (hint) => {
    const err = await captureError(
      convertMedia(Buffer.from('definitely not audio data'), hint, 'wav', { disableNativeEngine: true }, 'x.bin')
    );
    expectEngineUnavailable(err, 'ffmpeg');
  });

  it('decodeAudioBuffer refuses an ADTS stream recognised by its syncword', () => {
    expectEngineUnavailable(captureSyncError(() => decodeAudioBuffer(silentAdts(2))), 'ffmpeg');
  });

  it('decodeAudioBuffer refuses an ADTS stream behind an ID3v2 tag', () => {
    const id3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const err = captureSyncError(() => decodeAudioBuffer(Buffer.concat([id3, silentAdts(2)])));
    expectEngineUnavailable(err, 'ffmpeg');
  });

  it('the library index no longer exports the pure AAC decoder or MP3 encoder', async () => {
    const library = await import('../src/lib/conversions/index');
    const removed = ['decodeAdtsAac', 'encodePureMp3', 'decodeAacLcFramePayload'];
    expect(Object.keys(library).filter((name) => removed.includes(name))).toEqual([]);
  });

  for (const channels of [1, 2] as const) {
    oracleTest(
      `aac -> wav with FFmpeg is real PCM from FFmpeg (x${channels})`,
      ['ffmpeg', 'ffprobe'],
      async () => {
        const adts = silentAdts(channels);
        const result = await convertMedia(adts, 'aac', 'wav', {}, 'tone.aac');

        const stream = probeStream(result.buffer, 'wav', 'a');
        expect(stream.codec_name).toBe('pcm_s16le');
        expect(Number(stream.sample_rate)).toBe(SAMPLE_RATE);
        expect(Number(stream.channels)).toBe(channels);

        const decoded = decodeAudioWithFfmpeg(result.buffer, 'wav', SAMPLE_RATE, channels);
        expect(decoded).toHaveLength(AAC_FIXTURE_FRAMES * SAMPLES_PER_AAC_FRAME * channels);
        // The default 16-bit dither (triangular_hp) adds noise of at most the dither's own amplitude to silence.
        expect(decoded.every((sample) => Math.abs(sample) <= MAX_DITHER_SAMPLE)).toBe(true);

        // Without dither the decoded silence is exact.
        const undithered = await convertMedia(adts, 'aac', 'wav', { audio: { dither: 'none' } }, 'tone.aac');
        const exact = decodeAudioWithFfmpeg(undithered.buffer, 'wav', SAMPLE_RATE, channels);
        expect(exact).toHaveLength(AAC_FIXTURE_FRAMES * SAMPLES_PER_AAC_FRAME * channels);
        expect(exact.every((sample) => sample === 0)).toBe(true);
      },
      FFMPEG_CASE_TIMEOUT_MS
    );
  }
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

const RETIRED_OPTION = 'allowPureLossyBitstream';

describe('the retired allowPureLossyBitstream option', () => {
  it('is gone from the conversion options contract', () => {
    expect(Object.keys(ConversionOptionsSchema.properties).filter((name) => name === RETIRED_OPTION)).toEqual([]);
  });

  it('is gone from the published OpenAPI document', async () => {
    const spec = await (await getOpenApiSpec()).json();
    const published = Object.keys(spec.components.schemas.ConversionOptions.properties);
    expect(published.filter((name) => name === RETIRED_OPTION)).toEqual([]);
  });
});
