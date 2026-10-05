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
import { convertMedia } from '../src/lib/conversions/media';
import { EngineUnavailableError } from '../src/lib/types';
import { demuxMp4 } from '../src/lib/edge/workers/webcodecs.worker';
import {
  verifyAudioBitstreamWithFfprobe,
  verifyVideoBitstreamWithFfprobe,
} from './helpers/differential-oracle';
import {
  bestSnrDb,
  decodeAudioWithFfmpeg,
  ffmpegTestVideoMp4,
  probeStream,
  sineSamples,
  topLevelBoxTypes,
  toArrayBuffer,
  wavFromSamples,
} from './helpers/media-lossy-oracle';
import { oracleTest } from './helpers/oracle-test';

const MIN_ROUNDTRIP_SNR_DB = 25;

describe('Media Domain: Hardware Acceleration, Faststart MP4, and Bitstream Verification (#131)', () => {
  beforeEach(() => {
    resetHardwareAccelerationCache();
  });

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
  // 3. Faststart MP4 Container Hierarchy (reference-authored fixtures)
  // ==========================================================================
  describe('3. MP4 Container Faststart Layout', () => {
    oracleTest('demuxes a faststart MP4 whose moov box precedes mdat', ['ffmpeg', 'ffprobe'], () => {
      const mp4 = ffmpegTestVideoMp4({ width: 160, height: 120, fps: 25, seconds: 1, gop: 25, faststart: true });
      const boxes = topLevelBoxTypes(mp4);
      expect(boxes.indexOf('moov')).toBeGreaterThan(-1);
      expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'));

      const track = demuxMp4(toArrayBuffer(mp4));
      expect(track?.type).toBe('video');
      expect(track?.codec).toBe('avc1');
      expect(track?.samples.length).toBe(25);
      expect(track?.samples[0].isKeyFrame).toBe(true);
    });

    oracleTest('demuxes a standard-layout MP4 whose mdat precedes moov', ['ffmpeg', 'ffprobe'], () => {
      const mp4 = ffmpegTestVideoMp4({ width: 160, height: 120, fps: 25, seconds: 1, gop: 25, faststart: false });
      const boxes = topLevelBoxTypes(mp4);
      expect(boxes.indexOf('mdat')).toBeGreaterThan(-1);
      expect(boxes.indexOf('mdat')).toBeLessThan(boxes.indexOf('moov'));

      const track = demuxMp4(toArrayBuffer(mp4));
      expect(track?.type).toBe('video');
      expect(track?.samples.length).toBe(25);
    });
  });

  // ==========================================================================
  // 4. Differential Oracle Bitstream Verifiers
  // ==========================================================================
  describe('4. Differential Oracle Bitstream Verification', () => {
    oracleTest('decodes WAV and AAC outputs with the reference decoder', ['ffmpeg', 'ffprobe'], async () => {
      const source = sineSamples(44100, 2, 1);
      const wav = wavFromSamples(source, 44100, 2);
      const wavStream = probeStream(wav, 'wav', 'a');
      expect(wavStream.codec_name).toBe('pcm_s16le');
      expect(Number(wavStream.channels)).toBe(2);

      const aacConv = await convertMedia(wav, 'wav', 'aac', { allowPureLossyBitstream: true }, 'test-audio');
      const aacStream = probeStream(aacConv.buffer, 'aac', 'a');
      expect(aacStream.codec_name).toBe('aac');
      expect(Number(aacStream.sample_rate)).toBe(44100);
      expect(bestSnrDb(source, decodeAudioWithFfmpeg(aacConv.buffer, 'aac', 44100, 2), 2)).toBeGreaterThanOrEqual(
        MIN_ROUNDTRIP_SNR_DB
      );
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
    oracleTest('converts WAV to FLAC bit-exactly without the native engine', ['ffmpeg'], async () => {
      const source = sineSamples(44100, 2, 0.25);
      const wav = wavFromSamples(source, 44100, 2);

      const flacRes = await convertMedia(wav, 'wav', 'flac', { disableNativeEngine: true }, 'test.wav');
      expect(flacRes.buffer.indexOf('fLaC')).toBe(0);
      expect(flacRes.mimeType).toBe('audio/flac');
      expect(Array.from(decodeAudioWithFfmpeg(flacRes.buffer, 'flac', 44100, 2))).toEqual(Array.from(source));
    });

    it('fails closed with EngineUnavailableError on every lossy target without the native engine', async () => {
      const wav = wavFromSamples(sineSamples(44100, 2, 0.25), 44100, 2);

      for (const target of ['mp4', 'mp3', 'aac', 'opus', 'ogg']) {
        const error = await convertMedia(
          wav,
          'wav',
          target,
          { allowPureLossyBitstream: true, disableNativeEngine: true },
          'test.wav'
        ).catch((err: unknown) => err);
        expect(error).toBeInstanceOf(EngineUnavailableError);
        expect((error as EngineUnavailableError).engineName).toBe('ffmpeg');
        expect((error as EngineUnavailableError).message).toMatch(
          new RegExp(`Native FFmpeg engine is required for authentic lossy ${target.toUpperCase()} compression`, 'i')
        );
      }
    });

    oracleTest('dispatches worker media conversion to native ffmpeg', ['ffmpeg', 'ffprobe'], async () => {
      const wav = wavFromSamples(sineSamples(44100, 1, 1), 44100, 1);
      const workerRes = await executeWorkerConversion(wav, 'wav', 'mp3', { audioBitrate: '192k' }, 'test.wav');

      expect(workerRes.engineUsed).toBe('native-ffmpeg');
      expect(probeStream(workerRes.buffer, 'mp3', 'a').codec_name).toBe('mp3');
      expect(workerRes.executionTimeMs).toBeGreaterThanOrEqual(0);
    });
  });
});
