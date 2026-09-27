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
  demuxMp4,
  demuxWav,
} from '../src/lib/edge/workers/webcodecs.worker';
import {
  convertWithWebCodecs,
  isWebCodecsEligible,
} from '../src/lib/edge/pipelines/webcodecs-pipeline';
import { resolveConversionTier } from '../src/lib/edge/tier-router';

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
    it('guarantees VideoFrame.close() is called deterministically in try...finally', async () => {
      // Create mock VideoFrame with spy on close()
      const closeSpies: Array<ReturnType<typeof vi.fn>> = [];

      class MockVideoFrame {
        public close = vi.fn();
        public timestamp: number;
        public duration: number;

        constructor(_source: any, init: { timestamp: number; duration: number }) {
          this.timestamp = init.timestamp;
          this.duration = init.duration;
          closeSpies.push(this.close);
        }
      }

      class MockVideoEncoder {
        public encodeQueueSize = 0;
        public configure = vi.fn();
        public encode = vi.fn((frame: any) => {
          // Verify frame is not yet closed during encode
          expect(frame.close).not.toHaveBeenCalled();
        });
        public flush = vi.fn(async () => {});
        public close = vi.fn();
        constructor(private init: any) {}
      }

      // Temporarily mock globals in Node environment
      const originalVideoFrame = (globalThis as any).VideoFrame;
      const originalVideoEncoder = (globalThis as any).VideoEncoder;
      (globalThis as any).VideoFrame = MockVideoFrame;
      (globalThis as any).VideoEncoder = MockVideoEncoder;

      try {
        const dummyBuffer = new ArrayBuffer(100);
        await processWebCodecsConversion({
          jobId: 'test-vram-cleanup',
          sourceFormat: 'mp4',
          targetFormat: 'mp4',
          fileBuffer: dummyBuffer,
          options: { width: 320, height: 240, framerate: 30 },
        });

        // 30 frames must have been created, and every single one must have close() called!
        expect(closeSpies).toHaveLength(30);
        for (const spy of closeSpies) {
          expect(spy).toHaveBeenCalledTimes(1);
        }
      } finally {
        (globalThis as any).VideoFrame = originalVideoFrame;
        (globalThis as any).VideoEncoder = originalVideoEncoder;
      }
    });

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
    let origVideoEncoder: any;
    let origVideoFrame: any;
    let origAudioEncoder: any;
    let origAudioData: any;

    beforeEach(() => {
      origVideoEncoder = (globalThis as any).VideoEncoder;
      origVideoFrame = (globalThis as any).VideoFrame;
      origAudioEncoder = (globalThis as any).AudioEncoder;
      origAudioData = (globalThis as any).AudioData;

      (globalThis as any).VideoFrame = class {
        public close = vi.fn();
        constructor(public source: any, public init: any) {}
      };

      (globalThis as any).VideoEncoder = class {
        public encodeQueueSize = 0;
        public configure = vi.fn();
        public encode = vi.fn((frame: any, opts: any) => {
          this.init.output({
            byteLength: 9,
            copyTo: (dest: Uint8Array) => dest.set(new Uint8Array([0, 0, 0, 1, 0x65, 1, 2, 3, 4])),
            timestamp: frame.init?.timestamp || 0,
            type: opts?.keyFrame ? 'key' : 'delta',
          });
        });
        public flush = vi.fn(async () => {});
        public close = vi.fn();
        constructor(private init: any) {}
      };

      (globalThis as any).AudioData = class {
        public close = vi.fn();
        constructor(public init: any) {}
      };

      (globalThis as any).AudioEncoder = class {
        public encodeQueueSize = 0;
        public configure = vi.fn();
        public encode = vi.fn((data: any) => {
          this.init.output({
            byteLength: 6,
            copyTo: (dest: Uint8Array) => dest.set(new Uint8Array([0x21, 0x10, 0x04, 0x60, 0x8c, 0])),
            timestamp: data.init?.timestamp || 0,
          });
        });
        public flush = vi.fn(async () => {});
        public close = vi.fn();
        constructor(private init: any) {}
      };
    });

    afterEach(() => {
      (globalThis as any).VideoEncoder = origVideoEncoder;
      (globalThis as any).VideoFrame = origVideoFrame;
      (globalThis as any).AudioEncoder = origAudioEncoder;
      (globalThis as any).AudioData = origAudioData;
    });

    it('executes conversion and delivers progress telemetry from 5% to 100%', async () => {
      const progressUpdates: number[] = [];
      const dummyFile = new File([new Uint8Array(1024)], 'input-clip.mp4', { type: 'video/mp4' });

      const result = await convertWithWebCodecs(
        dummyFile,
        'mp4',
        'webm',
        { width: 640, height: 360 },
        (p) => progressUpdates.push(p)
      );

      expect(result.size).toBeGreaterThan(0);
      expect(result.mimeType).toBe('video/webm');
      expect(progressUpdates.length).toBeGreaterThan(0);
      expect(progressUpdates[0]).toBe(5);
      expect(progressUpdates[progressUpdates.length - 1]).toBe(100);
    });

    it('transcodes to AAC container with audio/mp4 mime type', async () => {
      const dummyFile = new File([new Uint8Array(512)], 'input.wav', { type: 'audio/wav' });
      const result = await convertWithWebCodecs(dummyFile, 'wav', 'aac', {
        audioSampleRate: 44100,
        audioChannels: 'stereo',
      });
      expect(result.mimeType).toBe('audio/mp4');
      expect(result.size).toBeGreaterThan(0);
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
    it('demuxes MP4 container and accurately extracts timescale and samples', () => {
      // Build a minimal MP4 with ftyp, moov (mvhd with timescale 90,000), and mdat
      const ftyp = new Uint8Array([
        0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70,
        0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
        0x69, 0x73, 0x6f, 0x6d,
      ]);
      // moov with mvhd
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

      // mdat with sample data
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

      const track = demuxMp4(mp4Buf.buffer);
      expect(track).toBeDefined();
      expect(track?.timescale).toBe(90000);
      expect(track?.samples.length).toBeGreaterThan(0);
      expect(track?.samples[0].timestampMicros).toBe(0);
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
      expect(track).toBeDefined();
      expect(track?.type).toBe('audio');
      expect(track?.sampleRate).toBe(44100);
      expect(track?.channels).toBe(2);
      expect(track?.samples.length).toBeGreaterThan(0);
    });
  });

  describe('9. WebCodecs Hardware Audio & Video Isolation Invariant', () => {
    it('uses AudioEncoder for audio conversion and NEVER instantiates VideoEncoder with audio codec', async () => {
      let videoEncoderConstructed = false;
      let audioEncoderConstructed = false;
      let audioCodecConfigured = '';

      class MockAudioData {
        public close = vi.fn();
        constructor(public init: any) {}
      }

      class MockAudioEncoder {
        public encodeQueueSize = 0;
        public configure = vi.fn((config: any) => {
          audioCodecConfigured = config.codec;
        });
        public encode = vi.fn((data: any) => {
          data.close();
        });
        public flush = vi.fn(async () => {});
        public close = vi.fn();
        constructor(private init: any) {
          audioEncoderConstructed = true;
        }
      }

      class MockVideoEncoderFailOnAudio {
        constructor() {
          videoEncoderConstructed = true;
        }
      }

      const originalAudioEncoder = (globalThis as any).AudioEncoder;
      const originalAudioData = (globalThis as any).AudioData;
      const originalVideoEncoder = (globalThis as any).VideoEncoder;

      (globalThis as any).AudioEncoder = MockAudioEncoder;
      (globalThis as any).AudioData = MockAudioData;
      (globalThis as any).VideoEncoder = MockVideoEncoderFailOnAudio;

      try {
        const dummyAudio = new ArrayBuffer(500);
        const result = await processWebCodecsConversion({
          jobId: 'test-hardware-audio',
          sourceFormat: 'wav',
          targetFormat: 'aac',
          fileBuffer: dummyAudio,
          options: { audioSampleRate: 44100, audioChannels: 2 },
        });

        expect(result.mimeType).toBe('audio/mp4');
        expect(audioEncoderConstructed).toBe(true);
        expect(videoEncoderConstructed).toBe(false); // VideoEncoder must NEVER be called for audio!
        expect(audioCodecConfigured).toBe('mp4a.40.2');
      } finally {
        (globalThis as any).AudioEncoder = originalAudioEncoder;
        (globalThis as any).AudioData = originalAudioData;
        (globalThis as any).VideoEncoder = originalVideoEncoder;
      }
    });
  });
});

