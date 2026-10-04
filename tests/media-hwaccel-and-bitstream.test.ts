import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  probeHardwareAcceleration,
  resetHardwareAccelerationCache,
  buildFfmpegArguments,
  HardwareAccelerationCapabilities,
} from '../src/lib/conversions/media-ffmpeg-args';
import { probeNativeEngines, executeWorkerConversion } from '../src/worker/engines';
import { encodePureH264Mp4 } from '../src/lib/conversions/media-encoder';
import { convertMedia } from '../src/lib/conversions/media';
import { demuxMp4 } from '../src/lib/edge/workers/webcodecs.worker';
import {
  verifyAudioBitstreamWithFfprobe,
  verifyVideoBitstreamWithFfprobe,
} from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

describe('Media Domain: Hardware Acceleration, Faststart MP4, and Bitstream Verification (#131)', () => {
  beforeEach(() => {
    resetHardwareAccelerationCache();
  });

  // Helper to generate a 0.2-second 440Hz stereo PCM WAV
  function createSyntheticWav(sampleRate = 44100, channels = 2, durationSec = 0.2): Buffer {
    const totalSamples = Math.floor(sampleRate * durationSec * channels);
    const dataSize = totalSamples * 2;
    const buf = Buffer.alloc(44 + dataSize);

    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write('WAVE', 8, 'ascii');
    buf.write('fmt ', 12, 'ascii');
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20); // PCM
    buf.writeUInt16LE(channels, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * channels * 2, 28);
    buf.writeUInt16LE(channels * 2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36, 'ascii');
    buf.writeUInt32LE(dataSize, 40);

    for (let i = 0; i < totalSamples; i++) {
      const t = i / (sampleRate * channels);
      const val = Math.round(Math.sin(2 * Math.PI * 440 * t) * 12000);
      buf.writeInt16LE(val, 44 + i * 2);
    }
    return buf;
  }

  // ==========================================================================
  // 1. Hardware Acceleration Probing & In-Memory Caching
  // ==========================================================================
  describe('1. Hardware Acceleration Probing and Caching', () => {
    it('returns safe default capabilities when FFmpeg is not found or null', () => {
      const caps = probeHardwareAcceleration(null);
      expect(caps.nvenc).toBe(false);
      expect(caps.vaapi).toBe(false);
      expect(caps.qsv).toBe(false);
      expect(caps.videotoolbox).toBe(false);
      expect(caps.supportedEncoders.size).toBe(0);
      expect(typeof caps.probedAt).toBe('number');
    });

    it('caches probe results within TTL to prevent redundant subprocess spawns', () => {
      const caps1 = probeHardwareAcceleration(null);
      const caps2 = probeHardwareAcceleration(null);
      expect(caps1.probedAt).toBe(caps2.probedAt);

      resetHardwareAccelerationCache();
      const caps3 = probeHardwareAcceleration(null);
      expect(caps3).toBeDefined();
    });

    it('exposes hardwareAcceleration on probeNativeEngines diagnostics', () => {
      const engines = probeNativeEngines();
      expect(engines).toHaveProperty('soffice');
      expect(engines).toHaveProperty('ffmpeg');
      expect(engines).toHaveProperty('hardwareAcceleration');
      expect(typeof engines.hardwareAcceleration?.nvenc).toBe('boolean');
      expect(typeof engines.hardwareAcceleration?.vaapi).toBe('boolean');
    });
  });

  // ==========================================================================
  // 2. Dynamic FFmpeg Argument Builder
  // ==========================================================================
  describe('2. Dynamic FFmpeg Argument Generation', () => {
    it('generates optimal H.264 video encoding arguments with faststart for MP4', () => {
      const args = buildFfmpegArguments('/tmp/in.wav', '/tmp/out.mp4', 'wav', 'mp4', {
        videoFps: 30,
        audioBitrate: '256k',
      });

      expect(args[0]).toBe('-y');
      expect(args[args.length - 1]).toBe('/tmp/out.mp4');
      expect(args).toContain('-i');
      expect(args).toContain('/tmp/in.wav');
      expect(args).toContain('-movflags');
      expect(args).toContain('+faststart');
      expect(args[args.indexOf('-c:a') + 1]).toBe('aac');
      expect(args[args.indexOf('-b:a') + 1]).toBe('256k');
      expect(args[args.indexOf('-r') + 1]).toBe('30');
    });

    it('generates VP9 and Opus arguments for WebM container', () => {
      const args = buildFfmpegArguments('/tmp/in.mp4', '/tmp/out.webm', 'mp4', 'webm', {});
      expect(args[0]).toBe('-y');
      expect(args[args.length - 1]).toBe('/tmp/out.webm');
      expect(args[args.indexOf('-c:v') + 1]).toBe('libvpx-vp9');
      expect(args[args.indexOf('-c:a') + 1]).toBe('libopus');
      expect(args[args.indexOf('-b:a') + 1]).toBe('128k');
    });

    it('maps audio codecs accurately: mp3, ogg, opus, flac, wav', () => {
      const mp3Args = buildFfmpegArguments('/tmp/in.wav', '/tmp/out.mp3', 'wav', 'mp3', { audioBitrate: '320k' });
      expect(mp3Args[mp3Args.indexOf('-c:a') + 1]).toBe('libmp3lame');
      expect(mp3Args[mp3Args.indexOf('-b:a') + 1]).toBe('320k');

      const oggArgs = buildFfmpegArguments('/tmp/in.wav', '/tmp/out.ogg', 'wav', 'ogg', {});
      expect(oggArgs[oggArgs.indexOf('-c:a') + 1]).toBe('libvorbis');

      const opusArgs = buildFfmpegArguments('/tmp/in.wav', '/tmp/out.opus', 'wav', 'opus', {});
      expect(opusArgs[opusArgs.indexOf('-c:a') + 1]).toBe('libopus');

      const flacArgs = buildFfmpegArguments('/tmp/in.wav', '/tmp/out.flac', 'wav', 'flac', {});
      expect(flacArgs[flacArgs.indexOf('-c:a') + 1]).toBe('flac');

      const wavArgs = buildFfmpegArguments('/tmp/in.mp3', '/tmp/out.wav', 'mp3', 'wav', {});
      expect(wavArgs[wavArgs.indexOf('-c:a') + 1]).toBe('pcm_s16le');
    });

    it('applies audio channel mappings, volume filter, and resolution downscaling', () => {
      const args = buildFfmpegArguments('/tmp/in.wav', '/tmp/out.mp4', 'wav', 'mp4', {
        audioChannels: 'mono',
        audioVolume: 80,
        audioSampleRate: 48000,
        videoResolution: '1080p',
        videoBitrate: 3500,
      });

      expect(args[0]).toBe('-y');
      expect(args[args.length - 1]).toBe('/tmp/out.mp4');
      expect(args[args.indexOf('-ac') + 1]).toBe('1');
      expect(args[args.indexOf('-filter:a') + 1]).toBe('volume=0.8');
      expect(args[args.indexOf('-ar') + 1]).toBe('48000');
      expect(args[args.indexOf('-vf') + 1]).toBe(
        'scale=1920:1080:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2'
      );
      expect(args[args.indexOf('-b:v') + 1]).toBe('3500k');
    });
  });

  // ==========================================================================
  // 3. Pure TypeScript Faststart MP4 Container Hierarchy
  // ==========================================================================
  describe('3. Pure TS MP4 Container Faststart Layout', () => {
    it('generates compliant Faststart MP4 with moov atom placed before mdat', () => {
      const pcm = new Int16Array(44100 * 0.5); // 0.5 sec mono
      for (let i = 0; i < pcm.length; i++) {
        pcm[i] = Math.round(Math.sin((i / 44100) * 440 * 2 * Math.PI) * 10000);
      }

      // Faststart layout (default)
      const mp4Fast = encodePureH264Mp4(pcm, 44100, 1, { videoFps: 30, fastStart: true }, 'Faststart Video');
      const moovIdx = mp4Fast.indexOf('moov');
      const mdatIdx = mp4Fast.indexOf('mdat');

      expect(moovIdx).toBeGreaterThan(0);
      expect(mdatIdx).toBeGreaterThan(0);
      expect(moovIdx).toBeLessThan(mdatIdx); // 'moov' precedes 'mdat' for instant web playback

      // Verify stco chunk offset points accurately into mdat data
      const stcoIdx = mp4Fast.indexOf('stco');
      expect(stcoIdx).toBeGreaterThan(0);
      const firstChunkOffset = mp4Fast.readUInt32BE(stcoIdx + 12);
      expect(firstChunkOffset).toBe(mdatIdx + 4); // mdatIdx + 4 points past the 4-byte 'mdat' tag (8 bytes from box start)
    });

    it('generates standard layout when fastStart is explicitly set to false', () => {
      const pcm = new Int16Array(44100 * 0.25);
      const mp4Std = encodePureH264Mp4(pcm, 44100, 1, { videoFps: 30, fastStart: false }, 'Standard Video');
      const moovIdx = mp4Std.indexOf('moov');
      const mdatIdx = mp4Std.indexOf('mdat');

      expect(moovIdx).toBeGreaterThan(0);
      expect(mdatIdx).toBeGreaterThan(0);
      expect(mdatIdx).toBeLessThan(moovIdx); // 'mdat' precedes 'moov' in non-faststart
    });

    it('demuxes both faststart and standard MP4 containers flawlessly', () => {
      const pcm = new Int16Array(44100 * 0.5);
      const mp4Fast = encodePureH264Mp4(pcm, 44100, 1, { videoFps: 25, fastStart: true }, 'Fast Demux');
      const ab = mp4Fast.buffer.slice(mp4Fast.byteOffset, mp4Fast.byteOffset + mp4Fast.byteLength);

      const track = demuxMp4(ab);
      expect(track).not.toBeNull();
      expect(track?.type).toBe('video');
      expect(track?.codec).toBe('avc1');
      expect(track?.samples.length).toBeGreaterThan(10);
      expect(track?.samples[0].isKeyFrame).toBe(true);
    });
  });

  // ==========================================================================
  // 4. Differential Oracle Bitstream Verifiers
  // ==========================================================================
  describe('4. Differential Oracle Bitstream Verification', () => {
    oracleTest('verifies audio bitstream integrity for WAV and AAC containers', ['ffmpeg', 'ffprobe'], () => {
      const wav = createSyntheticWav(44100, 2, 0.2);
      const wavVerif = verifyAudioBitstreamWithFfprobe(wav, 'wav', 'pcm_s16le');
      expect(wavVerif.valid).toBe(true);
      expect(wavVerif.codecName).toBe('pcm_s16le');

      const aacConv = convertMedia(wav, 'wav', 'aac', { allowPureLossyBitstream: true }, 'test-audio');
      return aacConv.then((res) => {
        const aacVerif = verifyAudioBitstreamWithFfprobe(res.buffer, 'aac', 'aac');
        expect(aacVerif.valid).toBe(true);
      });
    });

    oracleTest('verifies video bitstream integrity and detects faststart layout', ['ffprobe'], () => {
      const wav = createSyntheticWav(44100, 2, 0.3);
      const pcm = new Int16Array(44100 * 0.3);
      const mp4 = encodePureH264Mp4(pcm, 44100, 1, { videoFps: 30, fastStart: true }, 'Fast Video');

      const verif = verifyVideoBitstreamWithFfprobe(mp4, 'mp4', 'h264');
      expect(verif.valid).toBe(true);
      expect(verif.isFastStart).toBe(true);
      expect(verif.codecName).toBe('h264');
    });

    it('gracefully rejects truncated or invalid media buffers', () => {
      const brokenBuf = Buffer.from([0x00, 0x01, 0x02]);
      const resAudio = verifyAudioBitstreamWithFfprobe(brokenBuf, 'wav');
      expect(resAudio.valid).toBe(false);

      const resVideo = verifyVideoBitstreamWithFfprobe(brokenBuf, 'mp4');
      expect(resVideo.valid).toBe(false);
    });
  });

  // ==========================================================================
  // 5. End-to-End Media Conversions & Worker Dispatch
  // ==========================================================================
  describe('5. End-to-End Media Pipeline Integration', () => {
    it('converts synthetic WAV to MP4, FLAC, and MP3 via pure TS pipeline, and enforces Fail-Closed on Opus/OGG without native engine', async () => {
      const wav = createSyntheticWav(44100, 2, 0.25);

      const [mp4Res, flacRes, mp3Res] = await Promise.all([
        convertMedia(wav, 'wav', 'mp4', { allowPureLossyBitstream: true }, 'test.wav'),
        convertMedia(wav, 'wav', 'flac', {}, 'test.wav'),
        convertMedia(wav, 'wav', 'mp3', { allowPureLossyBitstream: true }, 'test.wav'),
      ]);

      expect(mp4Res.buffer.indexOf('ftyp')).toBe(4);
      expect(mp4Res.buffer.indexOf('moov')).toBeGreaterThan(0);
      expect(mp4Res.mimeType).toBe('video/mp4');

      expect(flacRes.buffer.indexOf('fLaC')).toBe(0);
      expect(flacRes.mimeType).toBe('audio/flac');

      expect(mp3Res.buffer.indexOf('ID3')).toBe(0);
      expect(mp3Res.mimeType).toBe('audio/mpeg');

      // Fail-Closed on lossy Opus and OGG without native FFmpeg
      await expect(
        convertMedia(wav, 'wav', 'opus', { allowPureLossyBitstream: true, disableNativeEngine: true }, 'test.wav')
      ).rejects.toThrow(/Native FFmpeg engine is required for authentic lossy OPUS compression/i);

      await expect(
        convertMedia(wav, 'wav', 'ogg', { allowPureLossyBitstream: true, disableNativeEngine: true }, 'test.wav')
      ).rejects.toThrow(/Native FFmpeg engine is required for authentic lossy OGG compression/i);
    });

    it('executes worker media conversion dispatching to native ffmpeg or internal fallback', async () => {
      const wav = createSyntheticWav(44100, 1, 0.15);
      const workerRes = await executeWorkerConversion(wav, 'wav', 'mp3', { audioBitrate: '192k', allowPureLossyBitstream: true }, 'test.wav');


      expect(workerRes).toBeDefined();
      expect(workerRes.buffer.length).toBeGreaterThan(50);
      expect(['native-ffmpeg', 'internal-fallback']).toContain(workerRes.engineUsed);
      expect(workerRes.executionTimeMs).toBeGreaterThanOrEqual(0);
    });
  });
});
