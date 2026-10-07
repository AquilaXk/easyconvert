import { afterEach, describe, expect, it } from 'vitest';
import { resolveWebCodecsConfig, processWebCodecsConversion } from '../src/lib/edge/workers/webcodecs.worker';
import { EdgeUnsupportedError } from '../src/lib/edge/workers/worker-errors';
import { walkWebm } from './helpers/ebml-walker';
import { aacLcSpecificConfig, requireEncoders, runFfmpeg, testPatternInput } from './helpers/ffmpeg-media-fixtures';
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
    // 8-bit 4:2:0 from the source's avcC, no colour stated, and level 1 for 160x120 at 25 fps
    expect(platform.videoEncoderConfigures[0]).toMatchObject({ codec: 'vp09.00.10.08.01.02.02.02.00', width: 160, height: 120 });
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

  it('derives the level only for codecs named by family or target, never for a string the request spelled out', () => {
    expect(resolveWebCodecsConfig('mp4', 'h264').deriveLevel).toBe('h264');
    expect(resolveWebCodecsConfig('mp4', 'hevc').deriveLevel).toBe('hevc');
    expect(resolveWebCodecsConfig('webm', 'vp9').deriveLevel).toBe('vp9');
    expect(resolveWebCodecsConfig('mp4').deriveLevel).toBe('h264');
    expect(resolveWebCodecsConfig('webm').deriveLevel).toBe('vp9');
    expect(resolveWebCodecsConfig('mp4', 'av1').deriveLevel).toBeUndefined();
    expect(resolveWebCodecsConfig('webm', 'vp8').deriveLevel).toBeUndefined();
    expect(resolveWebCodecsConfig('mp4', 'avc1.4d002a').deriveLevel).toBeUndefined();
    expect(resolveWebCodecsConfig('mp4', 'avc1.640028').codec).toBe('avc1.640028');
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
    // Level 1.1 (0x0b) is the lowest that holds 160x120 at 25 fps
    expect((error as Error).message).toBe('The encoder reported no decoder configuration for avc1.4d000b, which the container needs.');
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

describe('the colour of the source picture in the edge worker', () => {
  let platform: FakePlatform | undefined;
  afterEach(() => {
    platform?.restore();
    platform = undefined;
  });

  const ENCODER_AVCC = Uint8Array.from([1, 0x4d, 0x40, 0x1e, 0xff, 0xe1, 0, 5, 0x67, 0x4d, 0x40, 0x1e, 0x95, 1, 0, 3, 0x68, 0xee, 0x3c]);
  const SMPTE170M = ['-colorspace', 'smpte170m', '-color_primaries', 'smpte170m', '-color_trc', 'smpte170m', '-color_range', 'tv'];

  /** 1 s of 160x120 H.264 whose colr is whatever `colourArgs` ask the reference encoder to write. */
  function colourSource(colourArgs: string[]): Buffer {
    requireEncoders('libx264');
    return runFfmpeg(
      [...testPatternInput({ width: 160, height: 120, fps: 25, seconds: 1 }), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', ...colourArgs],
      'mp4'
    );
  }

  function convert(mp4: Buffer, targetFormat: string, options: Record<string, unknown> = {}) {
    return processWebCodecsConversion({ jobId: 'colour', sourceFormat: 'mp4', targetFormat, fileBuffer: toArrayBuffer(mp4), options });
  }

  const COLOUR_CASES = [
    {
      label: 'BT.601 limited range',
      args: SMPTE170M,
      probed: ['smpte170m', 'smpte170m', 'smpte170m', 'tv'],
      colorSpace: { primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: false },
    },
    {
      label: 'BT.2020 with PQ',
      args: ['-colorspace', 'bt2020nc', '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-color_range', 'tv'],
      probed: ['bt2020nc', 'bt2020', 'smpte2084', 'tv'],
      colorSpace: { primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl', fullRange: false },
    },
    {
      label: 'BT.2020 with HLG, full range',
      args: ['-colorspace', 'bt2020nc', '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-color_range', 'pc'],
      probed: ['bt2020nc', 'bt2020', 'arib-std-b67', 'pc'],
      colorSpace: { primaries: 'bt2020', transfer: 'hlg', matrix: 'bt2020-ncl', fullRange: true },
    },
  ];

  for (const { label, args, probed, colorSpace } of COLOUR_CASES) {
    oracleTest(`hands the decoder the colour space the file states: ${label}`, ['ffmpeg', 'ffprobe'], async () => {
      const mp4 = colourSource(args);
      const stream = ffprobeReport(new Uint8Array(mp4), 'mp4').streams[0];
      expect([stream.color_space, stream.color_primaries, stream.color_transfer, stream.color_range]).toEqual(probed);
      platform = installFakeWebCodecs({ decodedFrameSize: { width: 160, height: 120 }, videoDecoderConfig: { codec: 'avc1.4d401e', description: ENCODER_AVCC } });

      await convert(mp4, 'mp4');

      expect(platform.videoDecoderConfigures).toHaveLength(1);
      expect(platform.videoDecoderConfigures[0].colorSpace).toEqual(colorSpace);
    });
  }

  oracleTest('states no colour space to the decoder for a file that has none', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = colourSource([]);
    platform = installFakeWebCodecs({ decodedFrameSize: { width: 160, height: 120 }, videoDecoderConfig: { codec: 'avc1.4d401e', description: ENCODER_AVCC } });

    await convert(mp4, 'mp4');

    expect(Object.keys(platform.videoDecoderConfigures[0]).sort()).toEqual(['codec', 'description']);
  });

  oracleTest('refuses a colour code point WebCodecs has no name for, before decoding', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = colourSource(SMPTE170M);
    // ITU-T H.273 code point 22 (EBU Tech 3213), written over the primaries of the reference file's colr
    const EBU_TECH_3213 = 22;
    const colrAt = mp4.indexOf('colrnclx');
    expect(colrAt).toBeGreaterThan(0);
    mp4.writeUInt16BE(EBU_TECH_3213, colrAt + 'colrnclx'.length);
    platform = installFakeWebCodecs({ decodedFrameSize: { width: 160, height: 120 }, videoDecoderConfig: { codec: 'avc1.4d401e', description: ENCODER_AVCC } });

    const error = await convert(mp4, 'mp4').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect((error as Error).message).toBe(
      'The video states colour primaries code point 22, which WebCodecs has no name for; the server engine converts this file.'
    );
    expect(platform.videoChunksDecoded).toHaveLength(0);
  });

  oracleTest('writes the source colour into an MP4 output as an nclx colr', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = colourSource(SMPTE170M);
    platform = installFakeWebCodecs({ decodedFrameSize: { width: 160, height: 120 }, videoDecoderConfig: { codec: 'avc1.4d401e', description: ENCODER_AVCC } });

    const result = await convert(mp4, 'mp4');
    const bytes = new Uint8Array(result.buffer);

    const entry = walkTracks(bytes)[0].entries[0];
    const colr = entry.children.find((box) => box.type === 'colr') as IsoBox;
    // ISO/IEC 14496-12 12.1.5: 'nclx', primaries, transfer and matrix as 16 bits, then the range in the top bit
    expect(Array.from(payloadOf(bytes, colr))).toEqual([0x6e, 0x63, 0x6c, 0x78, 0, 6, 0, 6, 0, 6, 0]);
  });

  oracleTest('writes no colr for a source that states no colour', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = colourSource([]);
    platform = installFakeWebCodecs({ decodedFrameSize: { width: 160, height: 120 }, videoDecoderConfig: { codec: 'avc1.4d401e', description: ENCODER_AVCC } });

    const result = await convert(mp4, 'mp4');

    const entry = walkTracks(new Uint8Array(result.buffer))[0].entries[0];
    expect(entry.children.map((box) => box.type)).toEqual(['avcC']);
  });

  oracleTest('writes the source colour into a WebM output as a Colour element', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = colourSource(['-colorspace', 'bt2020nc', '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-color_range', 'pc']);
    platform = installFakeWebCodecs({ decodedFrameSize: { width: 160, height: 120 }, videoDecoderConfig: { codec: 'vp09.00.10.08' } });

    const result = await convert(mp4, 'webm');

    // Matroska Colour: H.273 code points, and Range 2 for full range
    expect(walkWebm(new Uint8Array(result.buffer)).tracks[0].colour).toEqual({ matrix: 9, range: 2, transfer: 18, primaries: 9 });
  });

  oracleTest('refuses a resize of a picture whose colour a canvas redraw would change', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = colourSource(SMPTE170M);
    platform = installFakeWebCodecs({ decodedFrameSize: { width: 160, height: 120 } });

    const error = await convert(mp4, 'mp4', { width: 80, height: 60 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect((error as Error).message).toBe(
      "Resizing video redraws it through a canvas, which cannot keep the video's colour description; the server engine converts it."
    );
  });

  oracleTest('lets a BT.709 limited-range picture on to the canvas check', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = colourSource(['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']);
    platform = installFakeWebCodecs({ decodedFrameSize: { width: 160, height: 120 } });

    const error = await convert(mp4, 'mp4', { width: 80, height: 60 }).catch((e: unknown) => e);

    expect((error as Error).message).toBe('Resizing video needs OffscreenCanvas, which this browser lacks.');
  });
});

describe('the codec level and profile the edge worker requests', () => {
  let platform: FakePlatform | undefined;
  afterEach(() => {
    platform?.restore();
    platform = undefined;
  });

  const ENCODER_AVCC = Uint8Array.from([1, 0x4d, 0x40, 0x1e, 0xff, 0xe1, 0, 5, 0x67, 0x4d, 0x40, 0x1e, 0x95, 1, 0, 3, 0x68, 0xee, 0x3c]);
  const HEVC_RECORD = Uint8Array.from([1, 1, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 0x78, 0xf0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0, 0, 0, 0]);

  /** A few frames of the given size, from the reference H.264 encoder, in the given pixel format. */
  function source(width: number, height: number, pixFmt = 'yuv420p', extraArgs: string[] = []): Buffer {
    requireEncoders('libx264');
    return runFfmpeg(
      [...testPatternInput({ width, height, fps: 25, seconds: 0.2 }), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', pixFmt, ...extraArgs],
      'mp4'
    );
  }

  function convert(mp4: Buffer, targetFormat: string, options: Record<string, unknown> = {}) {
    return processWebCodecsConversion({ jobId: 'level', sourceFormat: 'mp4', targetFormat, fileBuffer: toArrayBuffer(mp4), options });
  }

  const frame = (width: number, height: number) => ({ decodedFrameSize: { width, height } });
  const requestedCodecs = (): unknown[] => (platform as FakePlatform).videoEncoderConfigures.map((config) => config.codec);

  oracleTest('asks for the lowest H.264 level that admits the picture and frame rate', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = source(1920, 1080);
    platform = installFakeWebCodecs({ ...frame(1920, 1080), videoDecoderConfig: { codec: 'avc1.4d0028', description: ENCODER_AVCC } });

    await convert(mp4, 'mp4', { framerate: 30 });

    expect(requestedCodecs()).toEqual(['avc1.4d0028']);
  }, 30_000);

  oracleTest('asks for level 5.1 for 4K at 30 fps and 4.2 for 1080p at 60 fps', ['ffmpeg', 'ffprobe'], async () => {
    const small = source(1920, 1080);
    platform = installFakeWebCodecs({ ...frame(1920, 1080), videoDecoderConfig: { codec: 'avc1.4d002a', description: ENCODER_AVCC } });
    await convert(small, 'mp4', { framerate: 60 });
    expect(requestedCodecs()).toEqual(['avc1.4d002a']);
    platform.restore();

    const large = source(3840, 2160);
    platform = installFakeWebCodecs({ ...frame(3840, 2160), videoDecoderConfig: { codec: 'avc1.4d0033', description: ENCODER_AVCC } });
    await convert(large, 'mp4', { framerate: 30 });
    expect(requestedCodecs()).toEqual(['avc1.4d0033']);
  }, 60_000);

  oracleTest('asks for the HEVC level of the picture, main tier', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = source(1920, 1080);
    platform = installFakeWebCodecs({ ...frame(1920, 1080), videoDecoderConfig: { codec: 'hvc1.1.6.L120.B0', description: HEVC_RECORD } });

    await convert(mp4, 'mp4', { framerate: 30, codec: 'hevc' });

    expect(requestedCodecs()).toEqual(['hvc1.1.6.L120.B0']);
  }, 30_000);

  oracleTest('takes the next level up when the platform lacks the lowest one that admits the picture', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = source(1280, 720);
    platform = installFakeWebCodecs({ ...frame(1280, 720), videoDecoderConfig: { codec: 'avc1.4d0020', description: ENCODER_AVCC } });
    platform.unsupportedCodecs.add('avc1.4d001f');

    await convert(mp4, 'mp4', { framerate: 30 });

    // 720p at 30 fps needs level 3.1 (0x1f); the platform lacks it, so level 3.2 (0x20) is asked for, and only that
    expect(requestedCodecs()).toEqual(['avc1.4d0020']);
  }, 30_000);

  oracleTest('refuses when the platform supports none of the levels that admit the picture', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = source(1280, 720);
    platform = installFakeWebCodecs(frame(1280, 720));
    for (const level of [31, 32, 40, 41, 42, 50, 51, 52, 60, 61, 62]) platform.unsupportedCodecs.add(`avc1.4d00${level.toString(16)}`);

    const error = await convert(mp4, 'mp4', { framerate: 30 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect((error as Error).message).toBe(
      'VideoEncoder supports none of the 11 H.264 levels that admit 1280x720 at 30 frames per second (avc1.4d001f to avc1.4d003e) in this browser environment'
    );
    expect(platform.videoChunksDecoded).toHaveLength(0);
  }, 30_000);

  oracleTest('keeps the exact codec string a request names, level included', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = source(1920, 1080);
    platform = installFakeWebCodecs({ ...frame(1920, 1080), videoDecoderConfig: { codec: 'avc1.64001f', description: ENCODER_AVCC } });

    await convert(mp4, 'mp4', { framerate: 30, codec: 'avc1.64001f' });

    expect(requestedCodecs()).toEqual(['avc1.64001f']);
  }, 30_000);

  oracleTest('refuses a picture no level admits before decoding anything', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = source(160, 120);
    platform = installFakeWebCodecs(frame(160, 120));

    const error = await convert(mp4, 'mp4', { width: 16384, height: 16384, framerate: 30 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect((error as Error).message).toBe('No H.264 level admits 16384x16384 at 30 frames per second; the server engine converts it.');
    expect(platform.videoChunksDecoded).toHaveLength(0);
    expect(platform.videoEncoderConfigures).toHaveLength(0);
  }, 30_000);

  oracleTest('asks for the VP9 profile of the source: 4:4:4 is profile 1', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = source(160, 120, 'yuv444p', ['-profile:v', 'high444']);
    platform = installFakeWebCodecs(frame(160, 120));

    const result = await convert(mp4, 'mp4', { codec: 'vp9' });

    expect(requestedCodecs()).toEqual(['vp09.01.10.08.03.02.02.02.00']);
    // With no decoder configuration reported, the muxer's vpcC states what was requested: profile 1, level 10, 4:4:4
    const bytes = new Uint8Array(result.buffer);
    const entry = walkTracks(bytes)[0].entries[0];
    expect(Array.from(payloadOf(bytes, entry.children.find((box) => box.type === 'vpcC') as IsoBox))).toEqual([1, 0, 0, 0, 1, 10, 0x86, 2, 2, 2, 0, 0]);
  }, 30_000);

  oracleTest('asks for VP9 profile 2 for a 10-bit 4:2:0 source, with the colour the source states', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = source(160, 120, 'yuv420p10le', ['-colorspace', 'smpte170m', '-color_primaries', 'smpte170m', '-color_trc', 'smpte170m', '-color_range', 'tv']);
    platform = installFakeWebCodecs(frame(160, 120));

    const result = await convert(mp4, 'mp4', { codec: 'vp9' });

    expect(requestedCodecs()).toEqual(['vp09.02.10.10.01.06.06.06.00']);
    const bytes = new Uint8Array(result.buffer);
    const entry = walkTracks(bytes)[0].entries[0];
    expect(entry.children.map((box) => box.type)).toEqual(['vpcC', 'colr']);
    expect(Array.from(payloadOf(bytes, entry.children[0]))).toEqual([1, 0, 0, 0, 2, 10, 0xa2, 6, 6, 6, 0, 0]);
  }, 30_000);

  oracleTest('writes the VP9 level for the size of a 1080p source', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = source(1920, 1080);
    platform = installFakeWebCodecs(frame(1920, 1080));

    const result = await convert(mp4, 'mp4', { codec: 'vp9', framerate: 30 });

    expect(requestedCodecs()).toEqual(['vp09.00.40.08.01.02.02.02.00']);
    const bytes = new Uint8Array(result.buffer);
    const entry = walkTracks(bytes)[0].entries[0];
    expect(Array.from(payloadOf(bytes, entry.children[0]))[5]).toBe(40);
  }, 30_000);

  oracleTest('refuses VP9 for a source that does not state its bit depth and chroma, without assuming 8-bit 4:2:0', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = source(160, 120, 'yuv420p', ['-preset', 'medium', '-profile:v', 'high']);
    // profile_idc 99 is not a profile the edge can interpret: the avcC of this file states nothing about its pictures
    const avcCAt = mp4.indexOf('avcC');
    expect(mp4[avcCAt + 'avcC'.length + 1]).toBe(100);
    mp4[avcCAt + 'avcC'.length + 1] = 99;
    platform = installFakeWebCodecs(frame(160, 120));

    const error = await convert(mp4, 'webm').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect((error as Error).message).toBe(
      'The source does not state the bit depth and chroma layout of its pictures, which a VP9 profile needs; the server engine converts it.'
    );
    expect(platform.videoChunksDecoded).toHaveLength(0);
  }, 30_000);
});
