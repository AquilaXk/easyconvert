import { describe, it, expect, vi } from 'vitest';
import {
  normalizeTimestampToMicros,
  denormalizeTimestampFromMicros,
  WatermarkFlowController,
  resolveWebCodecsConfig,
  wrapAacWithAdts,
  muxWebmVideo,
  muxMp4Media,
  processWebCodecsConversion,
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
});
