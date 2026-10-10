import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  encodeOpusContainer,
  encodeOggContainer,
  packageAuthenticOpusPages,
  computeOggCrc,
  convertMedia,
  ConversionFailedError,
} from '../src/lib/conversions/media';
import { resolveConversionTier } from '../src/lib/edge/tier-router';
import {
  muxOggOpus,
  createOggPageTyped,
  resolveWebCodecsConfig,
} from '../src/lib/edge/workers/webcodecs.worker';
import { EdgeUnsupportedError } from '../src/lib/edge/workers/worker-errors';
import { walkOggPages } from './helpers/ogg-walker';

describe('Media Spec Conformance & Hardware Acceleration (#179)', () => {
  // ==========================================================================
  // 1. RFC 7845 Ogg Opus & RFC 3533 Container Specification Conformance
  // ==========================================================================
  describe('1. RFC 7845 Ogg Opus & RFC 3533 Spec Conformance', () => {
    it('packages authentic discrete Opus packets into valid Ogg pages with monotonic granule positions', () => {
      const packets = [
        Buffer.from([0xc4, 0x11, 0x22, 0x33]), // 20ms stereo frame 1
        Buffer.from([0xc4, 0x44, 0x55, 0x66]), // 20ms stereo frame 2
        Buffer.from([0xc4, 0x77, 0x88, 0x99]), // 20ms stereo frame 3
      ];

      const pages = packageAuthenticOpusPages(packets, 2, 3, 0x4f505553);
      expect(pages).toHaveLength(3);

      // Verify page headers
      expect(pages[0].toString('ascii', 0, 4)).toBe('OggS');
      expect(pages[0][5]).toBe(0x00); // not BOS, not EOS
      expect(pages[0].readBigInt64LE(6)).toBe(960n); // 960 samples @ 48kHz
      expect(pages[0].readUInt32LE(14)).toBe(0x4f505553);
      expect(pages[0].readUInt32LE(18)).toBe(3); // seq 3
      const crc0 = pages[0].readUInt32LE(22);
      expect(crc0).not.toBe(0);
      const page0Copy = Buffer.from(pages[0]);
      page0Copy.writeUInt32LE(0, 22);
      expect(crc0).toBe(computeOggCrc(page0Copy));

      expect(pages[1].readBigInt64LE(6)).toBe(1920n); // 960 * 2
      expect(pages[1].readUInt32LE(18)).toBe(4);
      expect(pages[1][5]).toBe(0x00);

      expect(pages[2].readBigInt64LE(6)).toBe(2880n); // 960 * 3
      expect(pages[2].readUInt32LE(18)).toBe(5);
      expect(pages[2][5]).toBe(0x04); // EOS flag on last page
      const crc2 = pages[2].readUInt32LE(22);
      expect(crc2).not.toBe(0);
      const page2Copy = Buffer.from(pages[2]);
      page2Copy.writeUInt32LE(0, 22);
      expect(crc2).toBe(computeOggCrc(page2Copy));
    });

    it('creates RFC 7845 compliant container stream with OpusHead, OpusTags, and discrete audio pages', () => {
      const packets = [
        Buffer.from([0xc4, 0xaa, 0xbb, 0xcc]),
        Buffer.from([0xc4, 0xdd, 0xee, 0xff]),
      ];

      const oggOpus = encodeOpusContainer(packets, 48000, 2, 'My Song');
      expect(oggOpus.toString('ascii', 0, 4)).toBe('OggS');

      // Page 1: OpusHead
      const headIdx = oggOpus.indexOf('OpusHead');
      expect(headIdx).toBe(28);
      expect(oggOpus.readUInt8(headIdx + 8)).toBe(1); // Version 1
      expect(oggOpus.readUInt8(headIdx + 9)).toBe(2); // 2 channels
      expect(oggOpus.readUInt16LE(headIdx + 10)).toBe(384); // Pre-skip 384
      expect(oggOpus.readUInt32LE(headIdx + 12)).toBe(48000); // 48kHz
      expect(oggOpus.readInt16LE(headIdx + 16)).toBe(0); // 0 dB gain
      expect(oggOpus.readUInt8(headIdx + 18)).toBe(0); // mapping family 0

      // Page 2: OpusTags
      const tagsIdx = oggOpus.indexOf('OpusTags');
      expect(tagsIdx).toBeGreaterThan(headIdx);
      expect(oggOpus.indexOf('EasyConvert Engine')).toBeGreaterThan(tagsIdx);
      expect(oggOpus.indexOf('TITLE=My Song')).toBeGreaterThan(tagsIdx);
    });

    it('enforces strict Fail-Closed on raw PCM Int16Array in encodeOpusContainer and encodeOggContainer', () => {
      const rawPcm = new Int16Array(960 * 2);

      expect(() => encodeOpusContainer(rawPcm, 48000, 2)).toThrow(
        /Authentic Opus bitstream encoder is required.*Fail-Closed/i
      );

      expect(() => encodeOggContainer(rawPcm, 44100, 2)).toThrow(
        /Authentic Vorbis bitstream encoder is required.*Fail-Closed/i
      );
    });

    it('enforces strict Fail-Closed on convertMedia for opus and ogg without native FFmpeg engine', async () => {
      const wavHeader = Buffer.alloc(44);
      wavHeader.write('RIFF', 0);
      wavHeader.writeUInt32LE(36, 4);
      wavHeader.write('WAVE', 8);
      wavHeader.write('fmt ', 12);
      wavHeader.writeUInt32LE(16, 16);
      wavHeader.writeUInt16LE(1, 20); // PCM
      wavHeader.writeUInt16LE(2, 22); // Stereo
      wavHeader.writeUInt32LE(48000, 24);
      wavHeader.writeUInt32LE(192000, 28);
      wavHeader.writeUInt16LE(4, 32);
      wavHeader.writeUInt16LE(16, 34);
      wavHeader.write('data', 36);
      wavHeader.writeUInt32LE(0, 40);

      await expect(
        convertMedia(wavHeader, 'wav', 'opus', { disableNativeEngine: true }, 'audio.wav')
      ).rejects.toThrow(ConversionFailedError);

      await expect(
        convertMedia(wavHeader, 'wav', 'ogg', { disableNativeEngine: true }, 'audio.wav')
      ).rejects.toThrow(ConversionFailedError);

      await expect(
        convertMedia(wavHeader, 'wav', 'vorbis', { disableNativeEngine: true }, 'audio.wav')
      ).rejects.toThrow(ConversionFailedError);
    });
  });

  // ==========================================================================
  // 2. WebCodecs Client-Edge Ogg Opus Muxer
  // ==========================================================================
  describe('2. WebCodecs Client-Edge Ogg Opus Muxer (TypedArray Muxer)', () => {
    // The muxer's output is checked against ffprobe and ffmpeg in edge-media-mux.test.ts

    it('writes Ogg pages whose RFC 3533 checksum an independent reader accepts', () => {
      const payload = new Uint8Array([0xc0, 0x01, 0x02]);
      const page = createOggPageTyped(payload, 0x00, 960n, 3, 0x4f505553);

      const [read] = walkOggPages(page);
      expect(read.crcValid).toBe(true);
      expect(read).toMatchObject({ flags: 0, granule: 960n, sequence: 3, serial: 0x4f505553 });
      expect(read.packets).toEqual([payload]);
    });

    it('lets a one-bit change of a page be seen by the checksum', () => {
      const page = createOggPageTyped(new Uint8Array([0xc0, 0x01, 0x02]), 0x00, 960n, 3, 0x4f505553);
      page[page.length - 1] ^= 0x01;

      expect(walkOggPages(page)[0].crcValid).toBe(false);
    });

    it('splits a packet longer than 255 bytes into laced segments that end with a short one', () => {
      const payload = new Uint8Array(510).fill(7);
      const page = createOggPageTyped(payload, 0x00, 0n, 0, 1);

      // 510 = 255 + 255, so the packet needs a closing zero-length segment: [255, 255, 0]
      expect([...page.subarray(26, 30)]).toEqual([3, 255, 255, 0]);
      expect(walkOggPages(page)[0].packets).toEqual([payload]);
    });

    it('does not fabricate a page for an empty stream: it refuses', () => {
      const head = new Uint8Array([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0]);

      expect(() => muxOggOpus([], head)).toThrow(EdgeUnsupportedError);
    });
  });

  // ==========================================================================
  // 3. Tier Router Audio vs Video WebCodecs Routing
  // ==========================================================================
  describe('3. Tier Router Audio vs Video WebCodecs Routing', () => {
    it('routes opus to L1 when WebCodecs Audio is supported', () => {
      const res = resolveConversionTier('wav', 'opus', 5000, {}, {
        hasWebCodecsAudio: true,
        supportedAudioEncoders: ['opus', 'mp4a.40.2'],
      });
      expect(res.tier).toBe('L1');
      expect(res.isClientEdge).toBe(true);
      expect(res.reason).toContain('WebCodecs AudioEncoder hardware Opus');
    });

    it('routes opus to L4 when WebCodecs Audio is unsupported or absent', () => {
      const res = resolveConversionTier('wav', 'opus', 5000, {}, {
        hasWebCodecsAudio: false,
        hasWebCodecsVideo: true, // Video exists, but Audio does not!
      });
      expect(res.tier).toBe('L4');
      expect(res.isClientEdge).toBe(false);
      expect(res.reason).toContain('Opus encoding requires WebCodecs AudioEncoder or native cloud worker engine');
    });

    it('routes aac to L1 when WebCodecs Audio supports mp4a.40.2', () => {
      const res = resolveConversionTier('wav', 'aac', 5000, {}, {
        hasWebCodecsAudio: true,
        supportedAudioEncoders: ['mp4a.40.2'],
      });
      expect(res.tier).toBe('L1');
      expect(res.isClientEdge).toBe(true);
    });

    it('always routes ogg and vorbis to L4 (WebCodecs does not support Vorbis)', () => {
      const resOgg = resolveConversionTier('wav', 'ogg', 5000, {}, {
        hasWebCodecsAudio: true,
        hasWebCodecsVideo: true,
        supportedAudioEncoders: ['opus', 'mp4a.40.2'],
      });
      expect(resOgg.tier).toBe('L4');
      expect(resOgg.isClientEdge).toBe(false);

      const resVorbis = resolveConversionTier('wav', 'vorbis', 5000, {}, {
        hasWebCodecsAudio: true,
        hasWebCodecsVideo: true,
      });
      expect(resVorbis.tier).toBe('L4');
      expect(resVorbis.isClientEdge).toBe(false);
    });

    it('routes video formats (mp4, webm) to L1 only when hasWebCodecsVideo is true', () => {
      const resVideo = resolveConversionTier('mov', 'mp4', 5000, {}, {
        hasWebCodecsVideo: true,
        hasWebCodecsAudio: false,
      });
      expect(resVideo.tier).toBe('L1');

      const resVideoNoCodecs = resolveConversionTier('mov', 'mp4', 5000, {}, {
        hasWebCodecsVideo: false,
        hasWebCodecsAudio: true, // Only audio is supported
      });
      expect(resVideoNoCodecs.tier).toBe('L4');

      // The edge worker has no AVI demuxer, so AVI goes to the server tier even where WebCodecs exists
      const resAvi = resolveConversionTier('avi', 'mp4', 5000, {}, {
        hasWebCodecsVideo: true,
        hasWebCodecsAudio: false,
      });
      expect(resAvi.tier).toBe('L4');
      expect(resAvi.isClientEdge).toBe(false);
    });
  });

  // ==========================================================================
  // 4. Hardware Acceleration (VAAPI / NVENC / QSV) Configuration Verification
  // ==========================================================================
  describe('4. Hardware Acceleration (VAAPI / /dev/dri) Worker Configuration', () => {
    it('verifies Dockerfile.worker installs VAAPI and Mesa driver packages', () => {
      const dockerfilePath = path.resolve(__dirname, '../Dockerfile.worker');
      const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf-8');

      expect(dockerfileContent.length).toBeGreaterThan(1000);
      expect(dockerfileContent).toContain('libva-drm2');
      expect(dockerfileContent).toContain('mesa-va-drivers');
      expect(dockerfileContent).toContain('intel-media-va-driver');
      expect(dockerfileContent).toContain('vainfo');
    });

    it('verifies Dockerfile.worker assigns user easyconvert to video and render groups', () => {
      const dockerfilePath = path.resolve(__dirname, '../Dockerfile.worker');
      const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf-8');

      expect(dockerfileContent).toMatch(/groupadd.*video/);
      expect(dockerfileContent).toMatch(/groupadd.*render/);
      expect(dockerfileContent).toMatch(/useradd.*-G video,render/);
    });

    it('verifies docker-compose.yml exposes /dev/dri device mapping to worker service', () => {
      const composePath = path.resolve(__dirname, '../docker-compose.yml');
      const composeContent = fs.readFileSync(composePath, 'utf-8');

      expect(composeContent.length).toBeGreaterThan(100);
      expect(composeContent).toContain('/dev/dri:/dev/dri');
    });

    it('enforces fail-closed behavior when Ogg Vorbis is requested on WebCodecs and allows authentic Opus', () => {
      // 1. Generic .ogg without explicit opus codec must fail-closed on WebCodecs
      expect(() => resolveWebCodecsConfig('ogg')).toThrow(
        'Ogg Vorbis encoding is not supported by WebCodecs hardware encoder'
      );

      // 2. Explicit opus userCodec on .ogg target succeeds with audio/ogg; codecs=opus
      const oggOpus = resolveWebCodecsConfig('ogg', 'opus');
      expect(oggOpus.codec).toBe('opus');
      expect(oggOpus.mimeType).toBe('audio/ogg; codecs=opus');
      expect(oggOpus.isVideo).toBe(false);

      // 3. Direct .opus target succeeds with audio/ogg; codecs=opus
      const directOpus = resolveWebCodecsConfig('opus');
      expect(directOpus.codec).toBe('opus');
      expect(directOpus.mimeType).toBe('audio/ogg; codecs=opus');
      expect(directOpus.isVideo).toBe(false);
    });
  });
});
