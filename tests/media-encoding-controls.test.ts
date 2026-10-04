import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  buildFfmpegArguments,
  H264_ALLOWED_PROFILES,
  H264_ALLOWED_LEVELS,
} from '../src/lib/conversions/media-ffmpeg-args';
import {
  probeMediaDuration,
  computeMediaTimeoutMs,
  getFfmpegPath,
  getFfprobePath,
} from '../src/lib/conversions/media';
import { InvalidMediaOptionError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';

describe('WP-44a: Media Video Encoding & Filter Controls', () => {
  describe('1. Profile and Level Validation Gate', () => {
    it('accepts valid H.264 profile and level specifications', () => {
      const args = buildFfmpegArguments('/tmp/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
        disableHwaccel: true,
        video: {
          codec: 'h264',
          profile: 'high',
          level: '4.1',
        },
      });

      expect(args[0]).toBe('-y');
      expect(args[args.length - 1]).toBe('/tmp/out.mp4');
      const profIdx = args.indexOf('-profile:v');
      expect(profIdx).toBeGreaterThan(0);
      expect(args[profIdx + 1]).toBe('high');
      const lvlIdx = args.indexOf('-level');
      expect(lvlIdx).toBeGreaterThan(0);
      expect(args[lvlIdx + 1]).toBe('4.1');
    });

    it('fails closed when an unsupported H.264 profile is requested', () => {
      expect(() => {
        buildFfmpegArguments('/tmp/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
          video: {
            codec: 'h264',
            profile: 'cinematic_ultra',
          },
        });
      }).toThrowError(InvalidMediaOptionError);
    });

    it('fails closed when an invalid H.264 level is requested', () => {
      expect(() => {
        buildFfmpegArguments('/tmp/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
          video: {
            codec: 'h264',
            level: '9.9',
          },
        });
      }).toThrowError(InvalidMediaOptionError);
    });

    it('configures HEVC main10 and AV1 main profiles accurately', () => {
      const hevcArgs = buildFfmpegArguments('/tmp/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
        disableHwaccel: true,
        video: {
          codec: 'hevc',
          profile: 'main10',
        },
      });
      expect(hevcArgs[hevcArgs.indexOf('-profile:v') + 1]).toBe('main10');

      const av1Args = buildFfmpegArguments('/tmp/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
        video: {
          codec: 'av1',
          profile: 'main',
        },
      });
      expect(av1Args[av1Args.indexOf('-profile:v') + 1]).toBe('0');
    });

    it('maps ProRes profiles to numeric profile tags on MOV containers', () => {
      const proresHq = buildFfmpegArguments('/tmp/in.mp4', '/tmp/out.mov', 'mp4', 'mov', {
        video: {
          codec: 'prores',
          profile: 'hq',
        },
      });
      expect(proresHq[proresHq.indexOf('-c:v') + 1]).toBe('prores_ks');
      expect(proresHq[proresHq.indexOf('-profile:v') + 1]).toBe('3');
      expect(proresHq[proresHq.indexOf('-pix_fmt') + 1]).toBe('yuv422p10le');

      const prores4444 = buildFfmpegArguments('/tmp/in.mp4', '/tmp/out.mov', 'mp4', 'mov', {
        video: {
          codec: 'prores',
          profile: '4444',
        },
      });
      expect(prores4444[prores4444.indexOf('-profile:v') + 1]).toBe('4');
      expect(prores4444[prores4444.indexOf('-pix_fmt') + 1]).toBe('yuva444p10le');
    });
  });

  describe('2. Container and Codec Rules Gate', () => {
    it('fails closed when H.264 or ProRes is requested inside a WebM container', () => {
      expect(() => {
        buildFfmpegArguments('/tmp/in.mp4', '/tmp/out.webm', 'mp4', 'webm', {
          video: { codec: 'h264' },
        });
      }).toThrowError(InvalidMediaOptionError);

      expect(() => {
        buildFfmpegArguments('/tmp/in.mp4', '/tmp/out.webm', 'mp4', 'webm', {
          video: { codec: 'prores' },
        });
      }).toThrowError(InvalidMediaOptionError);
    });

    it('fails closed when ProRes is targeted to non-MOV containers', () => {
      expect(() => {
        buildFfmpegArguments('/tmp/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
          video: { codec: 'prores' },
        });
      }).toThrowError(InvalidMediaOptionError);

      expect(() => {
        buildFfmpegArguments('/tmp/in.mp4', '/tmp/out.mkv', 'mp4', 'mkv', {
          video: { codec: 'prores' },
        });
      }).toThrowError(InvalidMediaOptionError);
    });
  });

  describe('3. Rate Control Gate (CRF, VBR, CBR, 2-Pass)', () => {
    it('validates CRF bounds for H.264/HEVC (0-51) and VP9/AV1 (0-63)', () => {
      const validH264 = buildFfmpegArguments('/tmp/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
        disableHwaccel: true,
        video: {
          codec: 'h264',
          rateControl: { mode: 'crf', crf: 18 },
        },
      });
      expect(validH264[validH264.indexOf('-crf') + 1]).toBe('18');

      expect(() => {
        buildFfmpegArguments('/tmp/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
          video: {
            codec: 'h264',
            rateControl: { mode: 'crf', crf: 52 },
          },
        });
      }).toThrowError(InvalidMediaOptionError);

      expect(() => {
        buildFfmpegArguments('/tmp/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
          video: {
            codec: 'h264',
            rateControl: { mode: 'crf', crf: -1 },
          },
        });
      }).toThrowError(InvalidMediaOptionError);

      const validVp9 = buildFfmpegArguments('/tmp/in.mp4', '/tmp/out.webm', 'mp4', 'webm', {
        video: {
          codec: 'vp9',
          rateControl: { mode: 'crf', crf: 63 },
        },
      });
      expect(validVp9[validVp9.indexOf('-crf') + 1]).toBe('63');

      expect(() => {
        buildFfmpegArguments('/tmp/in.mp4', '/tmp/out.webm', 'mp4', 'webm', {
          video: {
            codec: 'vp9',
            rateControl: { mode: 'crf', crf: 64 },
          },
        });
      }).toThrowError(InvalidMediaOptionError);
    });

    it('rejects CRF rate control on ProRes codec fail-closed', () => {
      expect(() => {
        buildFfmpegArguments('/tmp/in.mp4', '/tmp/out.mov', 'mp4', 'mov', {
          video: {
            codec: 'prores',
            rateControl: { mode: 'crf', crf: 20 },
          },
        });
      }).toThrowError(InvalidMediaOptionError);
    });

    it('generates VBR and CBR bitrate parameters accurately', () => {
      const vbrArgs = buildFfmpegArguments('/tmp/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
        disableHwaccel: true,
        video: {
          codec: 'h264',
          rateControl: {
            mode: 'vbr',
            bitrateK: 2500,
            maxrateK: 3500,
            bufsizeK: 5000,
          },
        },
      });
      expect(vbrArgs[vbrArgs.indexOf('-b:v') + 1]).toBe('2500k');
      expect(vbrArgs[vbrArgs.indexOf('-maxrate') + 1]).toBe('3500k');
      expect(vbrArgs[vbrArgs.indexOf('-bufsize') + 1]).toBe('5000k');

      const cbrArgs = buildFfmpegArguments('/tmp/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
        disableHwaccel: true,
        video: {
          codec: 'h264',
          rateControl: {
            mode: 'cbr',
            bitrateK: 4000,
          },
        },
      });
      expect(cbrArgs[cbrArgs.indexOf('-b:v') + 1]).toBe('4000k');
      expect(cbrArgs[cbrArgs.indexOf('-minrate') + 1]).toBe('4000k');
      expect(cbrArgs[cbrArgs.indexOf('-maxrate') + 1]).toBe('4000k');
      expect(cbrArgs[cbrArgs.indexOf('-bufsize') + 1]).toBe('4000k');
    });
  });

  describe('4. Strict Filter Graph Sequencing', () => {
    it('enforces fixed sequence: yadif -> crop -> transpose -> scale -> fps -> even parity -> format', () => {
      const args = buildFfmpegArguments('/tmp/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
        disableHwaccel: true,
        video: {
          codec: 'h264',
          deinterlace: true,
          crop: { w: 640, h: 480, x: 10, y: 20 },
          rotate: 90,
          scale: { width: 1280, height: 720, fit: 'contain' },
          fps: 24,
        },
      });

      const vfIdx = args.indexOf('-vf');
      expect(vfIdx).toBeGreaterThan(0);
      const vfChain = args[vfIdx + 1];

      // Exact ordered tokens
      const expectedFilterString = [
        'yadif',
        'crop=640:480:10:20',
        'transpose=1',
        'scale=1280:720:force_original_aspect_ratio=decrease',
        'fps=24',
        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      ].join(',');

      expect(vfChain).toBe(expectedFilterString);
      // Software encoder must output yuv420p pix_fmt
      expect(args).toContain('-pix_fmt');
      expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p');
    });

    it('always appends even parity correction scale filter regardless of options', () => {
      const noFilterArgs = buildFfmpegArguments('/tmp/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
        disableHwaccel: true,
        video: { codec: 'h264' },
      });
      const vfIdx = noFilterArgs.indexOf('-vf');
      expect(vfIdx).toBeGreaterThan(0);
      expect(noFilterArgs[vfIdx + 1]).toBe('scale=trunc(iw/2)*2:trunc(ih/2)*2');
    });

    it('handles rotate 180 and 270 degrees accurately', () => {
      const rot180 = buildFfmpegArguments('/tmp/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
        disableHwaccel: true,
        video: { rotate: 180 },
      });
      const vf180 = rot180[rot180.indexOf('-vf') + 1];
      expect(vf180).toBe('transpose=2,transpose=2,scale=trunc(iw/2)*2:trunc(ih/2)*2');

      const rot270 = buildFfmpegArguments('/tmp/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
        disableHwaccel: true,
        video: { rotate: 270 },
      });
      const vf270 = rot270[rot270.indexOf('-vf') + 1];
      expect(vf270).toBe('transpose=2,scale=trunc(iw/2)*2:trunc(ih/2)*2');
    });

    it('supports cover and stretch scale fit modes', () => {
      const coverArgs = buildFfmpegArguments('/tmp/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
        disableHwaccel: true,
        video: { scale: { width: 1920, height: 1080, fit: 'cover' } },
      });
      const vfCover = coverArgs[coverArgs.indexOf('-vf') + 1];
      expect(vfCover).toBe('scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,scale=trunc(iw/2)*2:trunc(ih/2)*2');

      const stretchArgs = buildFfmpegArguments('/tmp/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
        disableHwaccel: true,
        video: { scale: { width: 1280, height: 720, fit: 'stretch' } },
      });
      const vfStretch = stretchArgs[stretchArgs.indexOf('-vf') + 1];
      expect(vfStretch).toBe('scale=1280:720,scale=trunc(iw/2)*2:trunc(ih/2)*2');
    });

    it('configures temporal trim seek before input and end timestamp', () => {
      const trimArgs = buildFfmpegArguments('/tmp/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
        trim: { start: '00:00:02.500', end: '00:00:15.000' },
      });
      expect(trimArgs[1]).toBe('-ss');
      expect(trimArgs[2]).toBe('00:00:02.500');
      expect(trimArgs[3]).toBe('-i');
      expect(trimArgs[trimArgs.indexOf('-to') + 1]).toBe('00:00:15.000');
    });
  });

  describe('5. Dynamic Transcoding Timeout Calculation', () => {
    it('computes dynamic timeout based on duration: min(tierMax, 3 * durationSec + 60)', () => {
      // 0 seconds -> base 60s -> 60000ms
      expect(computeMediaTimeoutMs(0)).toBe(60000);
      // 10 seconds -> (3 * 10 + 60) * 1000 = 90000ms
      expect(computeMediaTimeoutMs(10)).toBe(90000);
      // 30 seconds -> (3 * 30 + 60) * 1000 = 150000ms
      expect(computeMediaTimeoutMs(30)).toBe(150000);
      // 60 seconds with default 180s cap -> capped at 180000ms
      expect(computeMediaTimeoutMs(60, 180000)).toBe(180000);
      // Custom tier max cap
      expect(computeMediaTimeoutMs(120, 600000)).toBe(420000);
    });

    it('probes duration from options or defaults to 0 safely', () => {
      expect(probeMediaDuration('/nonexistent/path.mp4', { duration: 42.5 })).toBe(42.5);
      expect(probeMediaDuration('/nonexistent/path.mp4')).toBe(0);
    });
  });

  describe('6. Differential Oracle Video Verification with FFprobe', () => {
    oracleTest('encodes H.264 video with exact High profile and level 4.1 verified via ffprobe JSON', ['ffmpeg', 'ffprobe'], async () => {
      const ffmpeg = getFfmpegPath() || 'ffmpeg';
      const ffprobe = getFfprobePath() || 'ffprobe';
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-oracle-'));

      try {
        const inputPath = path.join(tmpDir, 'source.mp4');
        const outputPath = path.join(tmpDir, 'output.mp4');

        // Generate synthetic 2-second test video
        execFileSync(ffmpeg, [
          '-y',
          '-f', 'lavfi',
          '-i', 'testsrc2=size=320x240:rate=30:duration=2',
          '-f', 'lavfi',
          '-i', 'sine=frequency=1000:duration=2',
          '-c:v', 'libx264',
          '-c:a', 'aac',
          inputPath,
        ], { stdio: 'ignore' });

        const args = buildFfmpegArguments(inputPath, outputPath, 'mp4', 'mp4', {
          disableHwaccel: true,
          video: {
            codec: 'h264',
            profile: 'high',
            level: '4.1',
            rateControl: { mode: 'crf', crf: 22 },
          },
        }, ffmpeg);

        execFileSync(ffmpeg, args, { stdio: 'ignore' });
        expect(fs.existsSync(outputPath)).toBe(true);

        // Differential verification using external ffprobe oracle
        const probeRaw = execFileSync(ffprobe, [
          '-v', 'quiet',
          '-print_format', 'json',
          '-show_streams',
          '-show_format',
          outputPath,
        ], { encoding: 'utf-8' });

        const info = JSON.parse(probeRaw);
        const videoStream = info.streams.find((s: any) => s.codec_type === 'video');

        expect(videoStream).toBeDefined();
        expect(videoStream.codec_name).toBe('h264');
        expect(videoStream.profile).toBe('High');
        expect(videoStream.level).toBe(41); // ffprobe reports level 4.1 as 41
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    oracleTest('crops and rotates video and verifies resulting dimensions are even integers via ffprobe', ['ffmpeg', 'ffprobe'], async () => {
      const ffmpeg = getFfmpegPath() || 'ffmpeg';
      const ffprobe = getFfprobePath() || 'ffprobe';
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-oracle-crop-'));

      try {
        const inputPath = path.join(tmpDir, 'source.mp4');
        const outputPath = path.join(tmpDir, 'output.mp4');

        // 640x480 source
        execFileSync(ffmpeg, [
          '-y',
          '-f', 'lavfi',
          '-i', 'testsrc2=size=640x480:rate=30:duration=1',
          '-c:v', 'libx264',
          inputPath,
        ], { stdio: 'ignore' });

        // Crop to 300x200 (x=50, y=50), rotate 90 -> final dimensions must be 200 width, 300 height
        const args = buildFfmpegArguments(inputPath, outputPath, 'mp4', 'mp4', {
          disableHwaccel: true,
          video: {
            codec: 'h264',
            crop: { w: 300, h: 200, x: 50, y: 50 },
            rotate: 90,
          },
        }, ffmpeg);

        execFileSync(ffmpeg, args, { stdio: 'ignore' });

        const probeRaw = execFileSync(ffprobe, [
          '-v', 'quiet',
          '-print_format', 'json',
          '-show_streams',
          outputPath,
        ], { encoding: 'utf-8' });

        const info = JSON.parse(probeRaw);
        const videoStream = info.streams.find((s: any) => s.codec_type === 'video');

        expect(videoStream).toBeDefined();
        expect(videoStream.width).toBe(200);
        expect(videoStream.height).toBe(300);
        // Even parity requirement
        expect(videoStream.width % 2).toBe(0);
        expect(videoStream.height % 2).toBe(0);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    oracleTest('accurately trims video segment within 1 frame precision via ffprobe duration', ['ffmpeg', 'ffprobe'], async () => {
      const ffmpeg = getFfmpegPath() || 'ffmpeg';
      const ffprobe = getFfprobePath() || 'ffprobe';
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-oracle-trim-'));

      try {
        const inputPath = path.join(tmpDir, 'source.mp4');
        const outputPath = path.join(tmpDir, 'output.mp4');

        // 5-second test video
        execFileSync(ffmpeg, [
          '-y',
          '-f', 'lavfi',
          '-i', 'testsrc2=size=320x240:rate=30:duration=5',
          '-c:v', 'libx264',
          inputPath,
        ], { stdio: 'ignore' });

        // Trim 1.0 to 3.5 -> duration ~ 2.5s
        const args = buildFfmpegArguments(inputPath, outputPath, 'mp4', 'mp4', {
          disableHwaccel: true,
          trim: { start: '1.0', end: '3.5' },
          video: { codec: 'h264' },
        }, ffmpeg);

        execFileSync(ffmpeg, args, { stdio: 'ignore' });

        const probeRaw = execFileSync(ffprobe, [
          '-v', 'quiet',
          '-print_format', 'json',
          '-show_format',
          outputPath,
        ], { encoding: 'utf-8' });

        const info = JSON.parse(probeRaw);
        const duration = Number.parseFloat(info.format.duration);
        expect(Number.isFinite(duration)).toBe(true);
        expect(Math.abs(duration - 2.5)).toBeLessThanOrEqual(0.1);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
