import { afterEach, describe, expect, it } from 'vitest';
import { resolveWebCodecsConfig, processWebCodecsConversion } from '../src/lib/edge/workers/webcodecs.worker';
import { EdgeUnsupportedError } from '../src/lib/edge/workers/worker-errors';
import { walkWebm } from './helpers/ebml-walker';
import { aacLcSpecificConfig } from './helpers/ffmpeg-media-fixtures';
import { ffprobeReport } from './helpers/ffprobe-json';
import { extractAvcC, listBoxes, payloadOf, readEsds, readFtyp, walkTracks, type IsoBox } from './helpers/iso-bmff-walker';
import { ffmpegTestVideoMp4, sineSamples, toArrayBuffer, wavFromSamples } from './helpers/media-lossy-oracle';
import { walkOggPages } from './helpers/ogg-walker';
import { oracleTest } from './helpers/oracle-test';
import { installFakeWebCodecs, type FakePlatform, type FakePlatformOptions } from './helpers/webcodecs-platform-fakes';

const RATE = 44100;
const CHANNELS = 2;
/** A raw AAC frame body and an Opus packet (TOC byte: CELT fullband, 20 ms, one frame) the fake encoders emit. */
const AAC_FRAME = Uint8Array.from([0x21, 0x10, 0x04, 0x60, 0x8c, 0x00]);
const OPUS_PACKET = Uint8Array.from([31 << 3, 0x01, 0x02, 0x03]);
const OPUS_HEAD = Uint8Array.from([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, CHANNELS, 0x38, 0x01, 0x44, 0xac, 0, 0, 0, 0, 0]);

function wavInput(): ArrayBuffer {
  return toArrayBuffer(wavFromSamples(sineSamples(RATE, CHANNELS, 1), RATE, CHANNELS));
}

describe('what the edge worker writes for each audio target', () => {
  let platform: FakePlatform | undefined;
  afterEach(() => {
    platform?.restore();
    platform = undefined;
  });

  function install(options: FakePlatformOptions): FakePlatform {
    platform = installFakeWebCodecs(options);
    return platform;
  }

  function convert(targetFormat: string, codec?: string) {
    return processWebCodecsConversion({ jobId: 'target', sourceFormat: 'wav', targetFormat, fileBuffer: wavInput(), options: { codec } });
  }

  const AAC_REPORT = {
    audioChunkBytes: AAC_FRAME,
    audioDecoderConfig: { codec: 'mp4a.40.2', description: aacLcSpecificConfig(RATE, CHANNELS), sampleRate: RATE, numberOfChannels: CHANNELS },
  };

  it('m4a is an ISO BMFF file with ftyp M4A and an esds, not a bare ADTS stream', async () => {
    const fakes = install(AAC_REPORT);

    const result = await convert('m4a');
    const bytes = new Uint8Array(result.buffer);

    expect(result.mimeType).toBe('audio/mp4');
    expect(readFtyp(bytes).majorBrand).toBe('M4A ');
    const track = walkTracks(bytes)[0];
    expect(track.handler).toBe('soun');
    expect(track.sampleCount).toBe(fakes.audioDataEncoded.length);
    const entry = track.entries[0];
    expect(entry.type).toBe('mp4a');
    expect(entry.children.map((child) => child.type)).toEqual(['esds']);
    const esds = readEsds(payloadOf(bytes, entry.children[0] as IsoBox));
    expect(esds.oti).toBe(0x40);
    expect(esds.asc).toEqual(aacLcSpecificConfig(RATE, CHANNELS));
    expect(ffprobeReport(bytes, 'm4a').streams[0]).toMatchObject({ codec_name: 'aac', profile: 'LC', channels: CHANNELS });
  });

  it('aac is an ADTS stream: a header from the encoder\'s own configuration before every frame', async () => {
    const fakes = install(AAC_REPORT);

    const result = await convert('aac');
    const bytes = new Uint8Array(result.buffer);

    expect(result.mimeType).toBe('audio/aac');
    const frames = fakes.audioDataEncoded.length;
    expect(bytes.byteLength).toBe(frames * (7 + AAC_FRAME.byteLength));
    for (let i = 0; i < frames; i++) {
      const at = i * (7 + AAC_FRAME.byteLength);
      const length = 7 + AAC_FRAME.byteLength;
      // 0xFFF1, LC | index 4 | channel config 2, 13-bit length, VBR buffer fullness
      expect([...bytes.subarray(at, at + 7)]).toEqual([0xff, 0xf1, 0x50, 0x80 | (length >> 11), (length >> 3) & 0xff, ((length & 7) << 5) | 0x1f, 0xfc]);
      expect([...bytes.subarray(at + 7, at + length)]).toEqual([...AAC_FRAME]);
    }
  });

  it('opus is an Ogg stream led by the encoder\'s OpusHead', async () => {
    const fakes = install({ audioChunkBytes: OPUS_PACKET, audioDecoderConfig: { codec: 'opus', description: OPUS_HEAD, sampleRate: RATE, numberOfChannels: CHANNELS } });

    const result = await convert('opus');
    const pages = walkOggPages(new Uint8Array(result.buffer));

    expect(result.mimeType).toBe('audio/ogg; codecs=opus');
    expect(pages.every((page) => page.crcValid)).toBe(true);
    expect(pages[0].packets[0]).toEqual(OPUS_HEAD);
    expect(pages).toHaveLength(2 + fakes.audioDataEncoded.length);
    // 960 samples per 20 ms packet, counted from zero; the pre-skip is the decoder's to drop (RFC 7845 4)
    expect(pages[2].granule).toBe(960n);
    expect(pages[pages.length - 1].granule).toBe(960n * BigInt(fakes.audioDataEncoded.length));
  });

  it('refuses a target whose encoder reported nothing the container needs', async () => {
    install({ audioChunkBytes: AAC_FRAME });

    for (const target of ['m4a', 'aac']) {
      const error = await convert(target).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EdgeUnsupportedError);
      expect((error as Error).message).toBe('The encoder reported no decoder configuration for mp4a.40.2, which the container needs.');
    }
  });

  it('refuses an Opus encoder that reported no OpusHead', async () => {
    install({ audioChunkBytes: OPUS_PACKET, audioDecoderConfig: { codec: 'opus', sampleRate: RATE, numberOfChannels: CHANNELS } });

    const error = await convert('opus').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect((error as Error).message).toBe(
      'Ogg Opus output: the encoder reported no OpusHead decoder configuration record; the server engine converts this file.'
    );
  });

  it('refuses a target it has no muxer for, including mov, and Ogg without Opus', async () => {
    install(AAC_REPORT);

    for (const target of ['mov', 'flac', 'mp3']) {
      const error = await convert(target).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EdgeUnsupportedError);
      expect((error as Error).message).toBe(
        `The edge WebCodecs worker has no muxer for the "${target}" target; the server engine converts it.`
      );
    }
    const ogg = await convert('ogg').catch((e: unknown) => e);
    expect(ogg).toBeInstanceOf(EdgeUnsupportedError);
    expect((ogg as Error).message).toContain('Ogg Vorbis encoding is not supported');
  });
});

describe('what the edge worker writes for each video target', () => {
  let platform: FakePlatform | undefined;
  afterEach(() => {
    platform?.restore();
    platform = undefined;
  });

  function convert(mp4: Buffer, targetFormat: string, codec?: string) {
    return processWebCodecsConversion({ jobId: 'video-target', sourceFormat: 'mp4', targetFormat, fileBuffer: toArrayBuffer(mp4), options: { codec } });
  }

  function source(): Buffer {
    return ffmpegTestVideoMp4({ width: 160, height: 120, fps: 25, seconds: 1, gop: 25, faststart: true });
  }

  oracleTest('webm gets the codec the encoder reported, as V_VP9', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = source();
    platform = installFakeWebCodecs({ decodedFrameSize: { width: 160, height: 120 }, videoDecoderConfig: { codec: 'vp09.00.10.08' } });

    const result = await convert(mp4, 'webm');
    const walked = walkWebm(new Uint8Array(result.buffer));

    expect(result.mimeType).toBe('video/webm');
    expect(walked.tracks).toHaveLength(1);
    expect(walked.tracks[0]).toMatchObject({ codecId: 'V_VP9', width: 160, height: 120 });
    expect(walked.blocks).toHaveLength(platform.encodedFrames.length);
    expect(platform.videoEncoderConfigures[0]).toMatchObject({ codec: 'vp09.00.10.08', width: 160, height: 120 });
  });

  oracleTest('mp4 carries the avcC of the encoder, not a built-in parameter set', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = source();
    const encoderAvcC = Uint8Array.from([1, 0x4d, 0x40, 0x1e, 0xff, 0xe1, 0, 5, 0x67, 0x4d, 0x40, 0x1e, 0x95, 1, 0, 3, 0x68, 0xee, 0x3c]);
    platform = installFakeWebCodecs({ decodedFrameSize: { width: 160, height: 120 }, videoDecoderConfig: { codec: 'avc1.4d401e', description: encoderAvcC } });

    const result = await convert(mp4, 'mp4');
    const bytes = new Uint8Array(result.buffer);

    expect(result.mimeType).toBe('video/mp4');
    expect(listBoxes(bytes).map((box) => box.type)).toEqual(['ftyp', 'moov', 'mdat']);
    const entry = walkTracks(bytes)[0].entries[0];
    expect(entry.type).toBe('avc1');
    expect(payloadOf(bytes, entry.children.find((box) => box.type === 'avcC') as IsoBox)).toEqual(encoderAvcC);
    // and not the source file's own: the output describes the encoder's stream
    expect(encoderAvcC).not.toEqual(extractAvcC(new Uint8Array(mp4)));
    expect(platform.videoEncoderConfigures[0]).toMatchObject({ avc: { format: 'avc' } });
  });

  oracleTest('refuses a codec the target container cannot carry, before any frame is decoded', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = source();
    platform = installFakeWebCodecs({ decodedFrameSize: { width: 160, height: 120 } });

    for (const [target, codec] of [['webm', 'h264'], ['webm', 'avc1.42001e'], ['mp4', 'vp8']] as const) {
      const error = await convert(mp4, target, codec).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(EdgeUnsupportedError);
      expect((error as Error).message).toContain('does not carry');
    }
    expect(platform.videoChunksDecoded).toHaveLength(0);
  });

  it('maps the videoCodec option names to WebCodecs codec strings', () => {
    expect(resolveWebCodecsConfig('webm', 'vp9').codec).toBe('vp09.00.10.08');
    expect(resolveWebCodecsConfig('mp4', 'h264').codec).toBe('avc1.4d002a');
    expect(resolveWebCodecsConfig('mp4', 'hevc').codec).toBe('hvc1.1.6.L93.B0');
    expect(resolveWebCodecsConfig('mp4', 'av1').codec).toBe('av01.0.04M.08');
    expect(resolveWebCodecsConfig('webm', 'vp8').codec).toBe('vp8');
  });

  oracleTest('refuses a resize that names only one dimension instead of stretching the picture', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = source();
    platform = installFakeWebCodecs({ decodedFrameSize: { width: 160, height: 120 } });

    const error = await processWebCodecsConversion({
      jobId: 'one-dimension',
      sourceFormat: 'mp4',
      targetFormat: 'mp4',
      fileBuffer: toArrayBuffer(mp4),
      options: { width: 80 },
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect((error as Error).message).toBe(
      'Resizing to one given dimension needs aspect-ratio handling the edge worker lacks; the server engine converts it.'
    );
    expect(platform.videoChunksDecoded).toHaveLength(0);
  });

  oracleTest('refuses an encoder that reported no decoder configuration for H.264', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = source();
    platform = installFakeWebCodecs({ decodedFrameSize: { width: 160, height: 120 } });

    const error = await convert(mp4, 'mp4').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect((error as Error).message).toBe('The encoder reported no decoder configuration for avc1.4d002a, which the container needs.');
  });

  oracleTest('refuses an H.264 encoder output for a webm target even when the codec was not requested', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = source();
    platform = installFakeWebCodecs({
      decodedFrameSize: { width: 160, height: 120 },
      videoDecoderConfig: { codec: 'avc1.4d401e', description: Uint8Array.from([1, 0x4d, 0x40, 0x1e]) },
    });

    const error = await convert(mp4, 'webm').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect((error as Error).message).toBe(
      'WebM output: avc1.4d401e is not a codec WebM carries (VP8, VP9 and AV1 are); the server engine converts this file.'
    );
  });
});
