import { afterEach, describe, expect, it } from 'vitest';
import { convertWithWebCodecs } from '../src/lib/edge/pipelines/webcodecs-pipeline';
import { EdgeUnsupportedError } from '../src/lib/edge/workers/worker-errors';
import type { ConversionOptions } from '../src/lib/types';
import { aacLcSpecificConfig, requireEncoders, runFfmpeg, testPatternInput } from './helpers/ffmpeg-media-fixtures';
import { sineSamples, toArrayBuffer, wavFromSamples } from './helpers/media-lossy-oracle';
import { oracleTest } from './helpers/oracle-test';
import { installFakeWebCodecs, type FakePlatform } from './helpers/webcodecs-platform-fakes';

const RATE = 44100;
const CHANNELS = 2;
const AAC_REPORT = {
  audioDecoderConfig: { codec: 'mp4a.40.2', description: aacLcSpecificConfig(RATE, CHANNELS), sampleRate: RATE, numberOfChannels: CHANNELS },
};

describe('the options the edge pipeline passes to the worker', () => {
  let platform: FakePlatform | undefined;
  afterEach(() => {
    platform?.restore();
    platform = undefined;
  });

  function wavFile(): File {
    return new File([toArrayBuffer(wavFromSamples(sineSamples(RATE, CHANNELS, 1), RATE, CHANNELS))], 'input.wav', { type: 'audio/wav' });
  }

  async function refusal(options: ConversionOptions): Promise<Error> {
    platform = installFakeWebCodecs(AAC_REPORT);
    const error = await convertWithWebCodecs(wavFile(), 'wav', 'aac', options).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    // Nothing was set up for a conversion that was refused
    expect(platform.audioEncoderConfigures).toHaveLength(0);
    expect(platform.audioChunksDecoded).toHaveLength(0);
    return error as Error;
  }

  // One entry per option the worker has no way to apply, with a value that asks for something
  const UNSUPPORTED: Array<[string, ConversionOptions]> = [
    ['videoFps', { videoFps: 30 }],
    ['videoResolution', { videoResolution: '720p' }],
    ['trim', { trim: { start: '00:00:01' } }],
    ['video', { video: { crop: { w: 10, h: 10, x: 0, y: 0 } } }],
    ['video', { video: { rotate: 90 } }],
    ['video', { video: { scale: { width: 100 } } }],
    ['video', { video: { fps: 24 } }],
    ['audio', { audio: { codec: 'opus' } }],
    ['audioVolume', { audioVolume: 150 }],
    ['subtitles', { subtitles: { mode: 'burn', input: 'subs.srt' } }],
    ['thumbnail', { thumbnail: { at: ['00:00:01'] } }],
    ['packaging', { packaging: { format: 'hls' } }],
    ['duration', { duration: 5 }],
    ['aspectRatio', { aspectRatio: '4:3' }],
    ['useFfmpeg', { useFfmpeg: true }],
    ['fastStart', { fastStart: true }],
    ['disableHwaccel', { disableHwaccel: true }],
  ];

  it.each(UNSUPPORTED)('refuses the %s option, which the edge path does not apply, instead of dropping it', async (name, options) => {
    const error = await refusal(options);

    expect(error.message).toBe(`The edge worker does not apply the ${name} option; the server engine converts it.`);
  });

  it('names every option it does not apply, in a fixed order', async () => {
    const error = await refusal({ videoFps: 30, trim: { end: '5' }, audioVolume: 80 });

    expect(error.message).toBe('The edge worker does not apply the audioVolume, trim, videoFps options; the server engine converts it.');
  });

  it('refuses an option it does not know, which a caller outside the type system could set', async () => {
    const error = await refusal({ sharpen: 3 } as unknown as ConversionOptions);

    expect(error.message).toBe('The edge worker does not apply the sharpen option; the server engine converts it.');
  });

  it('accepts the defaults every queue item carries and the off state of a flag', async () => {
    platform = installFakeWebCodecs(AAC_REPORT);
    const options: ConversionOptions = {
      quality: 85, fit: 'contain', stripMetadata: false, orientation: 'portrait', delimiter: ',', compressionLevel: 6,
      useFfmpeg: false, disableHwaccel: false, clientEdgeMode: true, timeoutMs: 60_000,
    };

    const result = await convertWithWebCodecs(wavFile(), 'wav', 'aac', options);

    expect(result.mimeType).toBe('audio/aac');
  });

  it('passes the audio options it applies to the encoder: bitrate in bits per second, rate and channels', async () => {
    platform = installFakeWebCodecs(AAC_REPORT);

    await convertWithWebCodecs(wavFile(), 'wav', 'aac', { audioBitrate: '96k', audioSampleRate: RATE, audioChannels: 'stereo' });

    expect(platform.audioEncoderConfigures[0]).toMatchObject({ codec: 'mp4a.40.2', bitrate: 96_000, sampleRate: RATE, numberOfChannels: CHANNELS });
  });

  it.each(['fast', '', '128', 'k', '0k', '-64k', '128kbps', '1e3k', '12345k', ' 96k'])(
    'refuses the audio bitrate %j instead of reading it as NaN and taking the default',
    async (bitrate) => {
      const error = await refusal({ audioBitrate: bitrate as ConversionOptions['audioBitrate'] });

      expect(error.message).toBe(`The edge worker cannot use audioBitrate ${JSON.stringify(bitrate)}; the server engine converts it.`);
    }
  );

  it('refuses an audio bitrate that is not a string', async () => {
    const error = await refusal({ audioBitrate: 128 as unknown as ConversionOptions['audioBitrate'] });

    expect(error.message).toBe('The edge worker cannot use audioBitrate 128; the server engine converts it.');
  });

  it.each([
    ['videoBitrate', Number.NaN],
    ['videoBitrate', 0],
    ['videoBitrate', -5],
    ['videoBitrate', Number.POSITIVE_INFINITY],
    ['width', 0],
    ['width', -1],
    ['width', 1.5],
    ['width', Number.NaN],
    ['height', 0],
    ['audioSampleRate', Number.NaN],
    ['audioSampleRate', 0],
  ])('refuses %s of %s, which no encoder can be configured with', async (name, value) => {
    const error = await refusal({ [name]: value } as ConversionOptions);

    expect(error.message).toBe(`The edge worker cannot use ${name} ${String(value)}; the server engine converts it.`);
  });

  it('refuses a resize whose fit the edge cannot apply, because it stretches the picture', async () => {
    const error = await refusal({ width: 640, height: 360, fit: 'contain' });

    expect(error.message).toBe('The edge worker stretches a resized picture and does not apply fit "contain"; the server engine converts it.');
  });

  oracleTest('passes the video options it applies to the encoder', ['ffmpeg', 'ffprobe'], async () => {
    requireEncoders('libx264');
    const mp4 = runFfmpeg(
      [...testPatternInput({ width: 160, height: 120, fps: 25, seconds: 0.2 }), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'],
      'mp4'
    );
    // The fake decoder already yields pictures of the size asked for, so the resize needs no canvas
    platform = installFakeWebCodecs({
      decodedFrameSize: { width: 80, height: 60 },
      videoDecoderConfig: { codec: 'avc1.4d000b', description: Uint8Array.from([1, 0x4d, 0x40, 0x0b, 0xff, 0xe1, 0, 4, 0x67, 0x4d, 0x40, 0x0b, 1, 0, 2, 0x68, 0xee]) },
    });

    await convertWithWebCodecs(new File([toArrayBuffer(mp4)], 'in.mp4'), 'mp4', 'mp4', {
      width: 80, height: 60, fit: 'fill', videoBitrate: 500_000, videoCodec: 'h264',
    });

    expect(platform.videoEncoderConfigures[0]).toMatchObject({ width: 80, height: 60, bitrate: 500_000 });
    expect(String(platform.videoEncoderConfigures[0].codec)).toMatch(/^avc1\.4d00[0-9a-f]{2}$/);
  }, 30_000);
});
