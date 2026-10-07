import { crc32 } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trimAudioDataStart } from '../src/lib/edge/media/audio-trim';
import { OrderedWorkQueue } from '../src/lib/edge/media/ordered-work-queue';
import { processWebCodecsConversion } from '../src/lib/edge/workers/webcodecs.worker';
import { EdgeUnsupportedError } from '../src/lib/edge/workers/worker-errors';
import { aacLcSpecificConfig, h264AacMp4 } from './helpers/ffmpeg-media-fixtures';
import { ffprobeReport, type FfprobePacket } from './helpers/ffprobe-json';
import { extractAvcC } from './helpers/iso-bmff-walker';
import { oracleTest } from './helpers/oracle-test';
import { installFakeWebCodecs, type FakeEncodedChunkRecord, type FakePlatform } from './helpers/webcodecs-platform-fakes';

const MICROS = 1_000_000;
const ONE_MICRO = 1;
const AAC_FRAME_SAMPLES = 1024;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function crcLabel(bytes: Uint8Array): string {
  return `CRC32:${crc32(bytes).toString(16).padStart(8, '0')}`;
}

/** The chunks handed to a decoder must be the reference packets: bytes, time, duration and key flag. */
function expectChunksMatchPackets(chunks: FakeEncodedChunkRecord[], packets: FfprobePacket[]): void {
  expect(chunks).toHaveLength(packets.length);
  packets.forEach((packet, index) => {
    const chunk = chunks[index];
    expect(crcLabel(chunk.data)).toBe(packet.data_hash);
    expect(Math.abs(chunk.timestamp - Math.round(Number(packet.pts_time) * MICROS))).toBeLessThanOrEqual(ONE_MICRO);
    expect(chunk.type).toBe(packet.flags.startsWith('K') ? 'key' : 'delta');
    expect(Math.abs((chunk.duration ?? Number.NaN) - Math.round(Number(packet.duration_time) * MICROS))).toBeLessThanOrEqual(ONE_MICRO);
  });
}

describe('OrderedWorkQueue', () => {
  it('runs items one at a time in arrival order even when later items would finish first', async () => {
    const queue = new OrderedWorkQueue();
    const finished: number[] = [];
    let running = 0;
    let maxRunning = 0;
    const delays = [30, 1, 15, 0, 8];
    delays.forEach((delay, index) => {
      queue.push(
        async () => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          await new Promise((resolve) => setTimeout(resolve, delay));
          finished.push(index);
          running--;
        },
        () => undefined
      );
    });

    await queue.drain();

    expect(finished).toEqual([0, 1, 2, 3, 4]);
    expect(maxRunning).toBe(1);
    expect(queue.pending).toBe(0);
  });

  it('waits until fewer items than the limit are pending', async () => {
    const queue = new OrderedWorkQueue();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    queue.push(() => gate, () => undefined);
    queue.push(async () => undefined, () => undefined);

    let passed = false;
    const waiting = queue.waitBelow(2).then(() => {
      passed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(passed).toBe(false);

    release();
    await waiting;
    expect(passed).toBe(true);
  });

  it('keeps the first failure, skips the work behind it but still lets it release what it holds', async () => {
    const queue = new OrderedWorkQueue();
    const events: string[] = [];
    queue.push(async () => {
      events.push('ran 0');
    }, () => events.push('skipped 0'));
    queue.push(async () => {
      throw new Error('encoder fault');
    }, () => events.push('skipped 1'));
    queue.push(async () => {
      events.push('ran 2');
    }, () => events.push('skipped 2'));

    await expect(queue.drain()).rejects.toThrow('encoder fault');

    expect(events).toEqual(['ran 0', 'skipped 2']);
    expect(() => queue.throwIfFailed()).toThrow('encoder fault');
  });

  it('wakes a waiter with the failure instead of leaving it waiting', async () => {
    const queue = new OrderedWorkQueue();
    queue.push(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      throw new Error('decoder fault');
    }, () => undefined);

    await expect(queue.waitBelow(1)).rejects.toThrow('decoder fault');
  });
});

describe('trimAudioDataStart', () => {
  const RATE = 48000;
  const CHANNELS = 2;
  const FRAMES = 1024;

  function sourceData(timestamp: number) {
    const platform = installFakeWebCodecs();
    const AudioDataClass = (globalThis as unknown as { AudioData: new (init: object) => never }).AudioData;
    const interleaved = Float32Array.from({ length: FRAMES * CHANNELS }, (_, index) => index / (FRAMES * CHANNELS));
    const data = new AudioDataClass({
      format: 'f32',
      sampleRate: RATE,
      numberOfFrames: FRAMES,
      numberOfChannels: CHANNELS,
      timestamp,
      data: interleaved,
    });
    return { platform, data, interleaved, AudioDataClass };
  }

  it('returns the data untouched when it starts at or after zero', () => {
    const { platform, data, AudioDataClass } = sourceData(0);
    try {
      expect(trimAudioDataStart(data, AudioDataClass)).toBe(data);
    } finally {
      platform.restore();
    }
  });

  it('drops data that lies entirely before zero and closes it', () => {
    // 1024 frames at 48 kHz last 21333 us; starting at -21334 us the whole block precedes zero
    const { platform, data, AudioDataClass } = sourceData(-21334);
    try {
      expect(trimAudioDataStart(data, AudioDataClass)).toBeNull();
      expect((data as { close: { mock: { calls: unknown[] } } }).close.mock.calls).toHaveLength(1);
    } finally {
      platform.restore();
    }
  });

  it('cuts the frames before zero and keeps the rest, planar, starting at zero', () => {
    // -1000 us at 48 kHz is exactly 48 frames
    const { platform, data, interleaved, AudioDataClass } = sourceData(-1000);
    try {
      const trimmed = trimAudioDataStart(data, AudioDataClass) as unknown as {
        init: { format: string; numberOfFrames: number; timestamp: number; data: Float32Array };
      };

      const kept = FRAMES - 48;
      expect(trimmed.init.format).toBe('f32-planar');
      expect(trimmed.init.numberOfFrames).toBe(kept);
      expect(trimmed.init.timestamp).toBe(0);
      const expected = new Float32Array(kept * CHANNELS);
      for (let channel = 0; channel < CHANNELS; channel++) {
        for (let frame = 0; frame < kept; frame++) {
          expected[channel * kept + frame] = interleaved[(48 + frame) * CHANNELS + channel];
        }
      }
      expect(trimmed.init.data).toEqual(expected);
      expect((data as { close: { mock: { calls: unknown[] } } }).close.mock.calls).toHaveLength(1);
    } finally {
      platform.restore();
    }
  });
});

describe('compressed audio is decoded before it is encoded', () => {
  let platform: FakePlatform | undefined;

  afterEach(() => {
    platform?.restore();
    platform = undefined;
    vi.restoreAllMocks();
  });

  function fakesFor(mp4: Buffer, overrides: Parameters<typeof installFakeWebCodecs>[0] = {}): FakePlatform {
    const report = ffprobeReport(new Uint8Array(mp4), 'mp4');
    const video = report.streams.find((s) => s.codec_type === 'video');
    const audio = report.streams.find((s) => s.codec_type === 'audio');
    // The AAC encoder describes what it encoded: the rate the decoder produced and the source's channels
    const encodedRate = overrides.decodedAudioSampleRate ?? Number(audio?.sample_rate);
    const encodedChannels = audio?.channels as number;
    platform = installFakeWebCodecs({
      decodedFrameSize: { width: video?.width ?? 0, height: video?.height ?? 0 },
      decodedAudioFramesPerChunk: AAC_FRAME_SAMPLES,
      videoDecoderConfig: { codec: 'avc1.64000d', description: extractAvcC(new Uint8Array(mp4)) },
      audioDecoderConfig: {
        codec: 'mp4a.40.2',
        sampleRate: encodedRate,
        numberOfChannels: encodedChannels,
        description: aacLcSpecificConfig(encodedRate, encodedChannels),
      },
      ...overrides,
    });
    return platform;
  }

  async function convert(mp4: Buffer, options: Parameters<typeof processWebCodecsConversion>[0]['options'] = {}) {
    return processWebCodecsConversion({
      jobId: 'decode-test',
      sourceFormat: 'mp4',
      targetFormat: 'mp4',
      fileBuffer: toArrayBuffer(mp4),
      options,
    });
  }

  oracleTest('hands the AAC packets of the file to AudioDecoder with the configuration of its stream', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = h264AacMp4();
    const report = ffprobeReport(new Uint8Array(mp4), 'mp4');
    const audio = report.streams.find((s) => s.codec_type === 'audio');
    if (!audio) throw new Error('fixture has no audio stream');
    const fakes = fakesFor(mp4);

    await convert(mp4);

    expect(fakes.audioDecoderConfigures).toHaveLength(1);
    const { description, ...rest } = fakes.audioDecoderConfigures[0] as { description: Uint8Array };
    expect(rest).toEqual({
      codec: 'mp4a.40.2',
      sampleRate: Number(audio.sample_rate),
      numberOfChannels: audio.channels,
    });
    // The whole AudioSpecificConfig of the stream: the LC header the reference's profile, rate and channels
    // imply, plus whatever extension bytes the encoder appended (the reference reports the full length)
    expect(description.byteLength).toBe(audio.extradata_size);
    expect(description.subarray(0, 2)).toEqual(aacLcSpecificConfig(Number(audio.sample_rate), audio.channels as number));
    expectChunksMatchPackets(
      fakes.audioChunksDecoded,
      report.packets.filter((packet) => packet.stream_index === audio.index)
    );
  });

  oracleTest('encodes the decoded audio, without the priming before time zero', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = h264AacMp4();
    const report = ffprobeReport(new Uint8Array(mp4), 'mp4');
    const audio = report.streams.find((s) => s.codec_type === 'audio');
    const packets = report.packets.filter((packet) => packet.stream_index === audio?.index);
    const fakes = fakesFor(mp4);
    // The reference puts the first AAC packet before zero: it is encoder delay, hidden by the edit list
    expect(Number(packets[0].pts_time)).toBeLessThan(0);

    await convert(mp4);

    expect(fakes.audioEncoderConfigures).toHaveLength(1);
    expect(fakes.audioEncoderConfigures[0]).toMatchObject({
      codec: 'mp4a.40.2',
      sampleRate: Number(audio?.sample_rate),
      numberOfChannels: audio?.channels,
      aac: { format: 'aac' },
    });
    expect(fakes.audioDataEncoded).toHaveLength(packets.length - 1);
    expect(fakes.audioDataEncoded.every((encoded) => Number(encoded.timestamp) >= 0)).toBe(true);
    const encodedFrames = fakes.audioDataEncoded.reduce((sum, encoded) => sum + Number(encoded.numberOfFrames), 0);
    expect(encodedFrames).toBe((packets.length - 1) * AAC_FRAME_SAMPLES);
    expect(fakes.audioDataClosers.every((close) => close.mock.calls.length === 1)).toBe(true);
  });

  oracleTest('configures the encoder with what the decoder produced, not what the file declared', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = h264AacMp4();
    const fakes = fakesFor(mp4, { decodedAudioSampleRate: 88200 });

    await convert(mp4);

    expect(fakes.audioEncoderConfigures[0]).toMatchObject({ sampleRate: 88200 });
  });

  oracleTest('refuses to resample: a requested rate the decoded audio does not have', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = h264AacMp4();
    const fakes = fakesFor(mp4);

    const error = await convert(mp4, { audioSampleRate: 16000 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect((error as Error).message).toContain('16000');
    expect(fakes.audioEncoderConfigures).toHaveLength(0);
    expect(fakes.audioDataEncoded).toHaveLength(0);
    expect(fakes.audioDataClosers.every((close) => close.mock.calls.length === 1)).toBe(true);
  });

  oracleTest('refuses to mix channels: a requested count the decoded audio does not have', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = h264AacMp4();
    fakesFor(mp4);

    const error = await convert(mp4, { audioChannels: 2 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect((error as Error).message).toBe('Changing 1 audio channels to 2 is not available at the edge.');
  });

  oracleTest('throws when the platform has no AudioDecoder', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = h264AacMp4();
    const fakes = fakesFor(mp4);
    delete (globalThis as Record<string, unknown>).AudioDecoder;

    const error = await convert(mp4).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect((error as Error).message).toContain('AudioDecoder');
    expect(fakes.audioEncoderConfigures).toHaveLength(0);
  });

  oracleTest('throws when the AudioDecoder rejects the stream configuration', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = h264AacMp4();
    const fakes = fakesFor(mp4);
    const decoderClass = (globalThis as unknown as { AudioDecoder: { isConfigSupported: ReturnType<typeof vi.fn> } }).AudioDecoder;
    decoderClass.isConfigSupported.mockResolvedValueOnce({ supported: false });

    const error = await convert(mp4).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect((error as Error).message).toContain('mp4a.40.2');
    expect(fakes.audioChunksDecoded).toHaveLength(0);
    expect(fakes.audioEncoderConfigures).toHaveLength(0);
  });

  oracleTest('throws when the AudioEncoder cannot encode the decoded configuration', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = h264AacMp4();
    const fakes = fakesFor(mp4);
    const encoderClass = (globalThis as unknown as { AudioEncoder: { isConfigSupported: ReturnType<typeof vi.fn> } }).AudioEncoder;
    encoderClass.isConfigSupported.mockResolvedValueOnce({ supported: false });

    const error = await convert(mp4).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect((error as Error).message).toContain('AudioEncoder');
    expect(fakes.audioEncoderConfigures).toHaveLength(0);
    expect(fakes.audioDataEncoded).toHaveLength(0);
  });
});

describe('video is decoded and encoded frame for frame', () => {
  let platform: FakePlatform | undefined;

  afterEach(() => {
    platform?.restore();
    platform = undefined;
  });

  oracleTest('feeds VideoDecoder the reference packets with the stream configuration, and the encoder frames in presentation order', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = h264AacMp4();
    const report = ffprobeReport(new Uint8Array(mp4), 'mp4');
    const video = report.streams.find((s) => s.codec_type === 'video');
    if (!video) throw new Error('fixture has no video stream');
    const packets = report.packets.filter((packet) => packet.stream_index === video.index);
    platform = installFakeWebCodecs({
      decodedFrameSize: { width: video.width as number, height: video.height as number },
      decodedAudioFramesPerChunk: AAC_FRAME_SAMPLES,
      asyncVideoEncoder: true,
      videoDecoderConfig: { codec: 'avc1.64000d', description: extractAvcC(new Uint8Array(mp4)) },
      audioDecoderConfig: { codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 1, description: aacLcSpecificConfig(44100, 1) },
    });

    await processWebCodecsConversion({
      jobId: 'video-decode',
      sourceFormat: 'mp4',
      targetFormat: 'mp4',
      fileBuffer: toArrayBuffer(mp4),
      options: {},
    });

    expect(platform.videoDecoderConfigures).toEqual([
      { codec: expect.stringMatching(/^avc1\.[0-9a-f]{6}$/), description: extractAvcC(new Uint8Array(mp4)) },
    ]);
    expectChunksMatchPackets(platform.videoChunksDecoded, packets);
    expect(platform.videoEncoderConfigures).toHaveLength(1);
    expect(platform.videoEncoderConfigures[0]).toMatchObject({ width: video.width, height: video.height, avc: { format: 'avc' } });
    expect(platform.videoEncoderConfigures[0].framerate).toBeCloseTo(25, 6);

    // The B-frame stream decodes out of order; the encoder must still see every frame once, in display order
    const encodedTimestamps = platform.encodedFrames.map((frame) => frame.timestamp);
    expect(encodedTimestamps).toHaveLength(packets.length);
    expect(encodedTimestamps).toEqual([...encodedTimestamps].sort((a, b) => a - b));
    expect(new Set(encodedTimestamps).size).toBe(packets.length);
    for (const frame of platform.decodedFrames) {
      expect(frame.close).toHaveBeenCalledTimes(1);
    }
  });

  oracleTest('throws EdgeUnsupportedError when VideoDecoder rejects the stream configuration', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = h264AacMp4();
    platform = installFakeWebCodecs({ decodedFrameSize: { width: 320, height: 240 } });
    const decoderClass = (globalThis as unknown as { VideoDecoder: { isConfigSupported: ReturnType<typeof vi.fn> } }).VideoDecoder;
    decoderClass.isConfigSupported.mockResolvedValueOnce({ supported: false });

    const error = await processWebCodecsConversion({
      jobId: 'video-decoder-unsupported',
      sourceFormat: 'mp4',
      targetFormat: 'mp4',
      fileBuffer: toArrayBuffer(mp4),
      options: {},
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect((error as Error).message).toContain('VideoDecoder');
    expect(platform.videoChunksDecoded).toHaveLength(0);
    expect(platform.videoEncoderConfigures).toHaveLength(0);
  });

  oracleTest('throws EdgeUnsupportedError when VideoEncoder cannot encode the target configuration', ['ffmpeg', 'ffprobe'], async () => {
    const mp4 = h264AacMp4();
    platform = installFakeWebCodecs({ decodedFrameSize: { width: 320, height: 240 } });
    const encoderClass = (globalThis as unknown as { VideoEncoder: { isConfigSupported: ReturnType<typeof vi.fn> } }).VideoEncoder;
    encoderClass.isConfigSupported.mockResolvedValueOnce({ supported: false });

    const error = await processWebCodecsConversion({
      jobId: 'video-encoder-unsupported',
      sourceFormat: 'mp4',
      targetFormat: 'mp4',
      fileBuffer: toArrayBuffer(mp4),
      options: {},
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect((error as Error).message).toContain('VideoEncoder');
    expect(platform.videoChunksDecoded).toHaveLength(0);
  });
});
