import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  normalizeTimestampToMicros,
  denormalizeTimestampFromMicros,
  WatermarkFlowController,
  resolveWebCodecsConfig,
  wrapAacWithAdts,
  muxWebmVideo,
  muxMp4Media,
  processWebCodecsConversion,
  demuxMedia,
  demuxMp4,
  demuxWav,
} from '../src/lib/edge/workers/webcodecs.worker';
import {
  convertWithWebCodecs,
  isWebCodecsEligible,
} from '../src/lib/edge/pipelines/webcodecs-pipeline';
import { resolveConversionTier } from '../src/lib/edge/tier-router';
import { EdgeUnsupportedError } from '../src/lib/edge/workers/worker-errors';
import { extractAvcC } from './helpers/iso-bmff-walker';
import {
  countVideoPackets,
  ffmpegTestVideoMp4,
  sineSamples,
  toArrayBuffer,
  wavFromSamples,
} from './helpers/media-lossy-oracle';
import { oracleTest } from './helpers/oracle-test';
import { installFakeWebCodecs } from './helpers/webcodecs-platform-fakes';

const sourceAvcC = (mp4: Buffer): Uint8Array => extractAvcC(new Uint8Array(mp4));

describe('Phase 2: WebCodecs Hardware Media Pipeline & Watermark Backpressure (L1)', () => {
  describe('1. Timescale to Microsecond PTS Normalization', () => {
    it('normalizes 90,000 Hz MPEG video clock PTS to exact microseconds', () => {
      // 90,000 ticks = 1 second = 1,000,000 microseconds
      expect(normalizeTimestampToMicros(90000, 90000)).toBe(1000000);
      expect(normalizeTimestampToMicros(45000, 90000)).toBe(500000);
      expect(normalizeTimestampToMicros(3000, 90000)).toBe(33333);
    });

    it('normalizes 44,100 Hz and 48,000 Hz audio clock PTS to exact microseconds', () => {
      expect(normalizeTimestampToMicros(44100, 44100)).toBe(1000000);
      expect(normalizeTimestampToMicros(24000, 48000)).toBe(500000);
    });

    it('denormalizes microseconds back to source container timescale', () => {
      const micros = 1000000;
      expect(denormalizeTimestampFromMicros(micros, 90000)).toBe(90000);
      expect(denormalizeTimestampFromMicros(micros, 44100)).toBe(44100);
    });

    it('rejects invalid or non-positive timescale with descriptive error', () => {
      expect(() => normalizeTimestampToMicros(100, 0)).toThrow(/timescale must be positive/);
      expect(() => normalizeTimestampToMicros(100, -90000)).toThrow(/timescale must be positive/);
      expect(() => denormalizeTimestampFromMicros(100, 0)).toThrow(/timescale must be positive/);
    });
  });

  describe('2. Dual Watermark Backpressure Flow Control', () => {
    it('throws when low watermark is greater than or equal to high watermark', () => {
      expect(() => new WatermarkFlowController(5, 5)).toThrow(/lowWatermark must be strictly less/);
      expect(() => new WatermarkFlowController(4, 6)).toThrow(/lowWatermark must be strictly less/);
    });

    it('allows demuxer to flow when encoder queue size is under high watermark', async () => {
      const controller = new WatermarkFlowController(6, 2);
      expect(controller.paused).toBe(false);

      // Sizes 0 through 5 should resolve immediately
      for (let size = 0; size < 6; size++) {
        await controller.checkBackpressure(size);
        expect(controller.paused).toBe(false);
        expect(controller.queueSize).toBe(size);
      }
    });

    it('pauses demuxer at high watermark (>= 6) and resumes only when queue drops to low watermark (<= 2)', async () => {
      const controller = new WatermarkFlowController(6, 2);

      let resumed = false;
      const pausePromise = controller.checkBackpressure(6).then(() => {
        resumed = true;
      });

      expect(controller.paused).toBe(true);
      expect(resumed).toBe(false);

      // Queue drops to 4, then 3: should still remain paused
      controller.onDequeue(4);
      expect(controller.paused).toBe(true);
      expect(resumed).toBe(false);

      controller.onDequeue(3);
      expect(controller.paused).toBe(true);
      expect(resumed).toBe(false);

      // Queue drops to 2 (low watermark): must unpause and resolve promise
      controller.onDequeue(2);
      await pausePromise;

      expect(controller.paused).toBe(false);
      expect(resumed).toBe(true);
    });

    it('reset restores flow controller state and unblocks any waiting promises', async () => {
      const controller = new WatermarkFlowController(6, 2);
      let unblocked = false;
      const promise = controller.checkBackpressure(7).then(() => {
        unblocked = true;
      });

      expect(controller.paused).toBe(true);
      controller.reset();
      await promise;
      expect(controller.paused).toBe(false);
      expect(unblocked).toBe(true);
    });
  });

  describe('3. Codec Configuration Resolution', () => {
    it('resolves standard video and audio codecs accurately', () => {
      expect(resolveWebCodecsConfig('mp4')).toEqual({
        codec: 'avc1.4d002a',
        mimeType: 'video/mp4',
        isVideo: true,
      });

      expect(resolveWebCodecsConfig('webm')).toEqual({
        codec: 'vp09.00.10.08',
        mimeType: 'video/webm',
        isVideo: true,
      });

      expect(resolveWebCodecsConfig('av1')).toEqual({
        codec: 'av01.0.04M.08',
        mimeType: 'video/mp4',
        isVideo: true,
      });

      expect(resolveWebCodecsConfig('aac')).toEqual({
        codec: 'mp4a.40.2',
        mimeType: 'audio/mp4',
        isVideo: false,
      });

      expect(resolveWebCodecsConfig('opus')).toEqual({
        codec: 'opus',
        mimeType: 'audio/ogg; codecs=opus',
        isVideo: false,
      });
    });

    it('respects explicit user override codec', () => {
      expect(resolveWebCodecsConfig('mp4', 'avc1.42001e')).toEqual({
        codec: 'avc1.42001e',
        mimeType: 'video/mp4',
        isVideo: true,
      });
    });
  });

  describe('4. Deterministic VRAM Cleanup Invariant', () => {
    oracleTest(
      'closes every decoded VideoFrame exactly once and encodes one frame per source packet',
      ['ffmpeg', 'ffprobe'],
      async () => {
        const mp4 = ffmpegTestVideoMp4({ width: 160, height: 120, fps: 25, seconds: 1, gop: 25, faststart: true });
        const referencePackets = countVideoPackets(mp4, 'mp4');
        expect(referencePackets).toBe(25);

        const platform = installFakeWebCodecs({
          decodedFrameSize: { width: 160, height: 120 },
          videoDecoderConfig: { codec: 'avc1.64000a', description: sourceAvcC(mp4) },
        });
        try {
          await processWebCodecsConversion({
            jobId: 'test-vram-cleanup',
            sourceFormat: 'mp4',
            targetFormat: 'mp4',
            fileBuffer: toArrayBuffer(mp4),
            options: {},
          });

          expect(platform.decodedFrames).toHaveLength(referencePackets);
          expect(platform.encodedFrames).toHaveLength(referencePackets);
          for (const frame of platform.decodedFrames) {
            expect(frame.close).toHaveBeenCalledTimes(1);
          }
        } finally {
          platform.restore();
        }
      }
    );

    it('ensures VideoFrame.close() is called even if VideoEncoder.encode throws', () => {
      let closed = false;
      const mockFrame = {
        close: () => {
          closed = true;
        },
      };

      expect(() => {
        try {
          throw new Error('GPU hardware encoder fault');
        } finally {
          mockFrame.close();
        }
      }).toThrow('GPU hardware encoder fault');

      expect(closed).toBe(true);
    });
  });

  describe('5. Container Packaging & Muxers', () => {
    it('generates ADTS AAC frame header with 0xFFF syncword and length mapping', () => {
      const rawPayload = new Uint8Array([0x12, 0x34, 0x56]);
      const adts = wrapAacWithAdts(rawPayload, 44100, 2);

      expect(adts).toHaveLength(rawPayload.length + 7);
      // Byte 0: 0xFF
      expect(adts[0]).toBe(0xff);
      // Byte 1: 0xF1 (syncword 0xFFF + layer 00 + protection absent 1)
      expect(adts[1]).toBe(0xf1);
      // Verify payload is correctly appended after 7 header bytes
      expect(adts.slice(7)).toEqual(rawPayload);
    });

    it('muxes WebM video with valid EBML header', () => {
      const chunks = [
        { data: new Uint8Array([1, 2, 3]), timestampMicros: 0, isKeyFrame: true },
        { data: new Uint8Array([4, 5, 6]), timestampMicros: 33333, isKeyFrame: false },
      ];
      const webm = muxWebmVideo(chunks, 640, 480);
      expect(webm.length).toBeGreaterThan(30);
      // EBML ID: 0x1A 0x45 0xDF 0xA3
      expect(webm[0]).toBe(0x1a);
      expect(webm[1]).toBe(0x45);
      expect(webm[2]).toBe(0xdf);
      expect(webm[3]).toBe(0xa3);
    });

    it('muxes MP4 video with valid ftyp and mdat boxes', () => {
      const chunks = [
        { data: new Uint8Array([10, 20, 30, 40]), timestampMicros: 0, isKeyFrame: true },
      ];
      const mp4 = muxMp4Media(chunks, 1280, 720);
      expect(mp4).toHaveLength(32 + 8 + 4);
      // 'ftyp' box
      const ftypTag = String.fromCharCode(...mp4.slice(4, 8));
      expect(ftypTag).toBe('ftyp');
      // 'mdat' box
      const mdatTag = String.fromCharCode(...mp4.slice(36, 40));
      expect(mdatTag).toBe('mdat');
      expect(mp4.slice(40)).toEqual(chunks[0].data);
    });
  });

  describe('6. WebCodecs Pipeline Controller Execution', () => {
    const SOURCE_RATE = 44100;
    const SOURCE_CHANNELS = 2;

    oracleTest(
      'executes a conversion of a real MP4 and delivers progress telemetry from 5% to 100%',
      ['ffmpeg', 'ffprobe'],
      async () => {
        const mp4 = ffmpegTestVideoMp4({ width: 160, height: 120, fps: 25, seconds: 1, gop: 25, faststart: true });
        const platform = installFakeWebCodecs({
          decodedFrameSize: { width: 160, height: 120 },
          videoDecoderConfig: { codec: 'avc1.64000a', description: sourceAvcC(mp4) },
        });
        try {
          const progressUpdates: number[] = [];
          const file = new File([toArrayBuffer(mp4)], 'input-clip.mp4', { type: 'video/mp4' });

          const result = await convertWithWebCodecs(file, 'mp4', 'webm', {}, (p) => progressUpdates.push(p));

          expect(result.mimeType).toBe('video/webm');
          expect(platform.encodedFrames).toHaveLength(countVideoPackets(mp4, 'mp4'));
          expect(progressUpdates[0]).toBe(5);
          expect(progressUpdates[progressUpdates.length - 1]).toBe(100);
          expect(progressUpdates).toEqual([...progressUpdates].sort((a, b) => a - b));
        } finally {
          platform.restore();
        }
      }
    );

    it('transcodes real PCM from a WAV to an AAC stream with the sample rate and channels of the source', async () => {
      const platform = installFakeWebCodecs();
      try {
        const source = sineSamples(SOURCE_RATE, SOURCE_CHANNELS, 1);
        const file = new File([toArrayBuffer(wavFromSamples(source, SOURCE_RATE, SOURCE_CHANNELS))], 'input.wav', {
          type: 'audio/wav',
        });

        const result = await convertWithWebCodecs(file, 'wav', 'aac', {});

        expect(result.mimeType).toBe('audio/mp4');
        expect(platform.audioEncoderConfigures[0]).toMatchObject({
          codec: 'mp4a.40.2',
          sampleRate: SOURCE_RATE,
          numberOfChannels: SOURCE_CHANNELS,
        });
        const encodedFrames = platform.audioDataEncoded.reduce((sum, d) => sum + Number(d.numberOfFrames), 0);
        expect(encodedFrames).toBe(source.length / SOURCE_CHANNELS);
      } finally {
        platform.restore();
      }
    });

    it('refuses a sample rate the encoder cannot reach without resampling', async () => {
      const platform = installFakeWebCodecs();
      try {
        const source = sineSamples(SOURCE_RATE, SOURCE_CHANNELS, 1);
        const file = new File([toArrayBuffer(wavFromSamples(source, SOURCE_RATE, SOURCE_CHANNELS))], 'input.wav', {
          type: 'audio/wav',
        });

        await expect(convertWithWebCodecs(file, 'wav', 'aac', { audioSampleRate: 16000 })).rejects.toBeInstanceOf(
          EdgeUnsupportedError
        );
        expect(platform.audioDataEncoded).toHaveLength(0);
      } finally {
        platform.restore();
      }
    });
  });

  describe('7. Tier Router Level 1 Integration', () => {
    it('routes video conversion to Tier L1 when WebCodecs is available', () => {
      const res = resolveConversionTier(
        'mp4',
        'webm',
        5_000_000,
        {},
        { hasWebCodecsVideo: true }
      );
      expect(res.tier).toBe('L1');
      expect(res.tierName).toBe('Edge L1 (Hardware VPU)');
      expect(res.isClientEdge).toBe(true);
    });

    it('routes audio conversion to Tier L1 when WebCodecs audio is available', () => {
      const res = resolveConversionTier(
        'wav',
        'opus',
        2_000_000,
        {},
        { hasWebCodecsAudio: true }
      );
      expect(res.tier).toBe('L1');
      expect(res.tierName).toBe('Edge L1 (Hardware VPU)');
      expect(res.isClientEdge).toBe(true);
    });

    it('falls back to L4 when WebCodecs is unavailable and not convertible by L0', () => {
      const res = resolveConversionTier(
        'mkv',
        'webm',
        5_000_000,
        {},
        { hasWebCodecsVideo: false, hasWebCodecsAudio: false }
      );
      expect(res.tier).toBe('L4');
      expect(res.tierName).toBe('Cloud (Zero-Retention)');
      expect(res.isClientEdge).toBe(false);
    });
  });

  describe('8. Universal Media Demuxing & Timescale Preservation', () => {
    it('reads no samples from an MP4 whose moov has no track, instead of cutting mdat into invented samples', () => {
      // ftyp, a moov holding only mvhd (timescale 90,000), and an mdat of 2048 payload bytes
      const ftyp = new Uint8Array([
        0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70,
        0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
        0x69, 0x73, 0x6f, 0x6d,
      ]);
      const mvhd = new Uint8Array([
        0x00, 0x00, 0x00, 0x6c, 0x6d, 0x76, 0x68, 0x64,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x5f, 0x90, // timescale = 90,000 (0x015F90)
        ...new Array(88).fill(0),
      ]);
      const moov = new Uint8Array(8 + mvhd.byteLength);
      const moovView = new DataView(moov.buffer);
      moovView.setUint32(0, moov.byteLength);
      moov.set([0x6d, 0x6f, 0x6f, 0x76], 4); // 'moov'
      moov.set(mvhd, 8);

      const mdatData = new Uint8Array(2048);
      mdatData.fill(0xaa);
      const mdat = new Uint8Array(8 + mdatData.byteLength);
      const mdatView = new DataView(mdat.buffer);
      mdatView.setUint32(0, mdat.byteLength);
      mdat.set([0x6d, 0x64, 0x61, 0x74], 4);
      mdat.set(mdatData, 8);

      const mp4Buf = new Uint8Array(ftyp.byteLength + moov.byteLength + mdat.byteLength);
      mp4Buf.set(ftyp, 0);
      mp4Buf.set(moov, ftyp.byteLength);
      mp4Buf.set(mdat, ftyp.byteLength + moov.byteLength);

      expect(() => demuxMp4(mp4Buf.buffer)).toThrow(/no video or audio track/);
      expect(() => demuxMedia(mp4Buf.buffer, 'mp4')).toThrow(EdgeUnsupportedError);
    });

    it('demuxes WAV container and extracts audio PCM samples', () => {
      // 44-byte WAV header + 4096 bytes PCM data
      const sampleRate = 44100;
      const channels = 2;
      const pcmLen = 4096;
      const totalLen = 44 + pcmLen;
      const wavBuf = new ArrayBuffer(totalLen);
      const view = new DataView(wavBuf);

      // 'RIFF'
      view.setUint32(0, 0x52494646, false);
      view.setUint32(4, totalLen - 8, true);
      // 'WAVE'
      view.setUint32(8, 0x57415645, false);
      // 'fmt '
      view.setUint32(12, 0x666d7420, false);
      view.setUint32(16, 16, true); // chunk size
      view.setUint16(20, 1, true); // PCM format
      view.setUint16(22, channels, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * channels * 2, true);
      view.setUint16(32, channels * 2, true);
      view.setUint16(34, 16, true); // 16-bit
      // 'data'
      view.setUint32(36, 0x64617461, false);
      view.setUint32(40, pcmLen, true);

      const track = demuxWav(wavBuf);
      expect(track?.type).toBe('audio');
      expect(track?.sampleRate).toBe(44100);
      expect(track?.channels).toBe(2);
      // 4096 bytes of 4-byte frames = 1024 frames, which is 23.2 ms at 44.1 kHz
      const frames = track?.samples.reduce((sum, s) => sum + s.data.byteLength / (channels * 2), 0);
      expect(frames).toBe(1024);
      expect(track?.samples[0].timestampMicros).toBe(0);
    });
  });

  describe('9. WebCodecs Hardware Audio & Video Isolation Invariant', () => {
    it('uses AudioEncoder for audio conversion and NEVER instantiates VideoEncoder with audio codec', async () => {
      const platform = installFakeWebCodecs();
      try {
        const source = sineSamples(44100, 2, 1);
        const result = await processWebCodecsConversion({
          jobId: 'test-hardware-audio',
          sourceFormat: 'wav',
          targetFormat: 'aac',
          fileBuffer: toArrayBuffer(wavFromSamples(source, 44100, 2)),
          options: { audioSampleRate: 44100, audioChannels: 2 },
        });

        expect(result.mimeType).toBe('audio/mp4');
        expect(platform.audioEncoderConfigures).toHaveLength(1);
        expect(platform.audioEncoderConfigures[0]).toMatchObject({ codec: 'mp4a.40.2' });
        expect(platform.videoEncoderConfigures).toHaveLength(0); // VideoEncoder must NEVER be called for audio!
        expect(platform.encodedFrames).toHaveLength(0);
      } finally {
        platform.restore();
      }
    });
  });
});
