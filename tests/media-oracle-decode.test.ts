import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool, verifyAudioBitstreamWithFfprobe, verifyVideoBitstreamWithFfprobe } from './helpers/differential-oracle';
import { requireEncoders, runFfmpeg } from './helpers/ffmpeg-media-fixtures';
import { listBoxes } from './helpers/iso-bmff-walker';
import { sineSamples, wavFromSamples } from './helpers/media-lossy-oracle';
import { MediaDecodeError, countStreams, probeFile, withMediaFile } from './helpers/ffmpeg-measure';
import {
  assertDecodedMedia,
  decodeMediaWithFfmpeg,
  MediaOracleAssertionError,
  LOSSY_AUDIO_MIN_SNR_DB,
} from './oracles/product/media-oracle';

/**
 * The media oracle must judge an output by decoding it. Every defect here keeps the container and the stream
 * headers intact, so a header probe still reports a healthy stream, and only a full decode tells the truth.
 */

const VIDEO_WIDTH = 160;
const VIDEO_HEIGHT = 120;
const VIDEO_FPS = 25;
const VIDEO_SECONDS = 2;
const VIDEO_FRAMES = VIDEO_FPS * VIDEO_SECONDS;
/** The brief's mutation: cut this share of the mdat payload. */
const MDAT_TRUNCATION_SHARE = 0.1;
const AUDIO_RATE = 44100;
const AUDIO_CHANNELS = 2;
const AUDIO_SECONDS = 1;
const WAV_HEADER_BYTES = 44;
const AAC_BITRATE = '128k';

/** The oracle fails a defective output with either a decode error or a violated expectation. */
class OracleFailure {
  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof MediaDecodeError || value instanceof MediaOracleAssertionError;
  }
}

/** 2 s of 160x120 25 fps H.264 with the moov box first, so a cut mdat leaves a parseable header. */
function faststartVideo(): Buffer {
  requireEncoders('libx264');
  return runFfmpeg(
    [
      '-f', 'lavfi', '-i', `testsrc2=size=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:rate=${VIDEO_FPS}:duration=${VIDEO_SECONDS}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '12', '-movflags', '+faststart',
    ],
    'mp4'
  );
}

/** `bytes` with the last `share` of its mdat payload removed. The mdat box is the last top-level box of a faststart file. */
function truncateMdat(bytes: Buffer, share: number): Buffer {
  const boxes = listBoxes(bytes);
  const mdat = boxes.find((box) => box.type === 'mdat');
  if (!mdat || mdat.end !== bytes.length) throw new Error('the fixture does not end with an mdat box');
  const cut = Math.floor((mdat.end - mdat.payloadStart) * share);
  return bytes.subarray(0, bytes.length - cut);
}

describe('media oracle decodes outputs instead of probing headers', () => {
  oracleTest('a video with 10% of its mdat cut still shows its stream to ffprobe but fails the decode oracle', ['ffmpeg', 'ffprobe'], () => {
    const intact = faststartVideo();
    const truncated = truncateMdat(intact, MDAT_TRUNCATION_SHARE);
    expect(truncated.length).toBeLessThan(intact.length);

    // Precondition of the regression: the header probe is blind to the cut.
    const probed = withMediaFile(truncated, 'mp4', (file) => probeFile(requireOracleTool('ffprobe'), file));
    expect(countStreams(probed).video).toBe(1);

    expect(verifyVideoBitstreamWithFfprobe(truncated, 'mp4', 'h264').valid).toBe(false);
    expect(() => assertDecodedMedia(truncated, 'mp4', 'video', { streams: { video: 1 }, video: { frameCount: VIDEO_FRAMES } })).toThrow(
      OracleFailure
    );

    const ok = verifyVideoBitstreamWithFfprobe(intact, 'mp4', 'h264');
    expect(ok.valid).toBe(true);
    expect(ok.frameCount).toBe(VIDEO_FRAMES);
    const decoded = assertDecodedMedia(intact, 'mp4', 'video', { streams: { video: 1 }, video: { frameCount: VIDEO_FRAMES } });
    expect(decoded.video?.frames.length).toBe(VIDEO_FRAMES * VIDEO_WIDTH * VIDEO_HEIGHT * 3);
  });

  oracleTest('a video whose mdat is replaced by zeros fails the similarity check against the source', ['ffmpeg', 'ffprobe'], () => {
    const source = faststartVideo();
    const boxes = listBoxes(source);
    const mdat = boxes.find((box) => box.type === 'mdat');
    if (!mdat) throw new Error('no mdat in the fixture');
    const zeroed = Buffer.from(source);
    zeroed.fill(0, mdat.payloadStart, mdat.end);

    expect(() =>
      assertDecodedMedia(zeroed, 'mp4', 'video', {
        streams: { video: 1 },
        video: { frameCount: VIDEO_FRAMES, reference: { bytes: source, extension: 'mp4' } },
      })
    ).toThrow(OracleFailure);
    expect(() =>
      assertDecodedMedia(source, 'mp4', 'video', {
        streams: { video: 1 },
        video: { frameCount: VIDEO_FRAMES, reference: { bytes: source, extension: 'mp4' } },
      })
    ).not.toThrow();
  });

  oracleTest('a WAV whose payload is zeroed after the header fails on SNR; the intact file is byte-equal to its source', ['ffmpeg', 'ffprobe'], () => {
    const source = sineSamples(AUDIO_RATE, AUDIO_CHANNELS, AUDIO_SECONDS);
    const wav = wavFromSamples(source, AUDIO_RATE, AUDIO_CHANNELS);
    const zeroed = Buffer.from(wav);
    zeroed.fill(0, WAV_HEADER_BYTES);

    // The header and stream parameters of the zeroed file are indistinguishable from the intact one.
    const probed = withMediaFile(zeroed, 'wav', (file) => probeFile(requireOracleTool('ffprobe'), file));
    expect(probed.streams[0].codec_name).toBe('pcm_s16le');
    expect(Number(probed.streams[0].sample_rate)).toBe(AUDIO_RATE);

    const expectation = {
      streams: { audio: 1 },
      audio: {
        sampleRate: AUDIO_RATE,
        channels: AUDIO_CHANNELS,
        samplesPerChannel: AUDIO_RATE * AUDIO_SECONDS,
        reference: source,
        lossless: true,
      },
    } as const;
    expect(() => assertDecodedMedia(zeroed, 'wav', 'audio', expectation)).toThrow(OracleFailure);
    expect(() => assertDecodedMedia(wav, 'wav', 'audio', expectation)).not.toThrow();

    const lossyExpectation = {
      streams: { audio: 1 },
      audio: {
        sampleRate: AUDIO_RATE,
        channels: AUDIO_CHANNELS,
        samplesPerChannel: AUDIO_RATE * AUDIO_SECONDS,
        reference: source,
        minSnrDb: LOSSY_AUDIO_MIN_SNR_DB.aac,
      },
    } as const;
    expect(() => assertDecodedMedia(zeroed, 'wav', 'audio', lossyExpectation)).toThrow(/SNR/);
  });

  oracleTest('lossy AAC passes the SNR gate and its zeroed mdat does not', ['ffmpeg', 'ffprobe'], () => {
    requireEncoders('aac');
    const source = sineSamples(AUDIO_RATE, AUDIO_CHANNELS, AUDIO_SECONDS);
    const wav = wavFromSamples(source, AUDIO_RATE, AUDIO_CHANNELS);
    const m4a = withMediaFile(wav, 'wav', (file) =>
      runFfmpeg(['-i', file, '-c:a', 'aac', '-b:a', AAC_BITRATE, '-movflags', '+faststart'], 'm4a')
    );
    const expectation = {
      streams: { audio: 1 },
      audio: {
        sampleRate: AUDIO_RATE,
        channels: AUDIO_CHANNELS,
        samplesPerChannel: AUDIO_RATE * AUDIO_SECONDS,
        toleranceSamples: 2304,
        reference: source,
        minSnrDb: LOSSY_AUDIO_MIN_SNR_DB.aac,
      },
    } as const;
    expect(() => assertDecodedMedia(m4a, 'm4a', 'audio', expectation)).not.toThrow();

    const mdat = listBoxes(m4a).find((box) => box.type === 'mdat');
    if (!mdat) throw new Error('no mdat in the AAC fixture');
    const zeroed = Buffer.from(m4a);
    zeroed.fill(0, mdat.payloadStart, mdat.end);
    expect(() => assertDecodedMedia(zeroed, 'm4a', 'audio', expectation)).toThrow(OracleFailure);
  });

  oracleTest('a WAV with a header and no samples has a stream for ffprobe but decodes to nothing', ['ffmpeg', 'ffprobe'], () => {
    const empty = wavFromSamples(new Int16Array(0), AUDIO_RATE, AUDIO_CHANNELS);
    const probed = withMediaFile(empty, 'wav', (file) => probeFile(requireOracleTool('ffprobe'), file));
    expect(countStreams(probed).audio).toBe(1);
    expect(() => decodeMediaWithFfmpeg(empty, 'wav', 'audio')).toThrow(MediaDecodeError);
    expect(verifyAudioBitstreamWithFfprobe(empty, 'wav').valid).toBe(false);
  });

  oracleTest('a file without a stream of the requested kind is rejected', ['ffmpeg', 'ffprobe'], () => {
    const wav = wavFromSamples(sineSamples(AUDIO_RATE, 1, 1), AUDIO_RATE, 1);
    expect(() => decodeMediaWithFfmpeg(wav, 'wav', 'video')).toThrow(MediaDecodeError);
  });
});

describe('the differential oracle has no verdict without a decode', () => {
  it('returns success only after decodeFileWithFfmpeg in both verifiers', () => {
    const source = fs.readFileSync(path.join(__dirname, 'helpers', 'differential-oracle.ts'), 'utf8');
    for (const name of ['verifyAudioBitstreamWithFfprobe', 'verifyVideoBitstreamWithFfprobe']) {
      const start = source.indexOf(`export function ${name}`);
      expect(start, name).toBeGreaterThan(-1);
      const next = source.indexOf('\nexport ', start + 1);
      const body = source.slice(start, next === -1 ? undefined : next);
      const firstSuccess = body.indexOf('valid: true');
      expect(firstSuccess, `${name} never reports success`).toBeGreaterThan(-1);
      const firstDecode = body.indexOf('decodeFileWithFfmpeg(');
      expect(firstDecode, `${name} decodes`).toBeGreaterThan(-1);
      expect(firstDecode, `${name} reports success before decoding`).toBeLessThan(firstSuccess);
    }
    const successes = source.match(/valid: true/g) ?? [];
    expect(successes).toHaveLength(2);
  });
});
