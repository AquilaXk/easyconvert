import { describe, expect, beforeAll, afterAll, afterEach, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { oracleTest } from './helpers/oracle-test';
import { getOracleToolPath } from './helpers/differential-oracle';
import { convertMedia, packageHlsDashMedia } from '../src/lib/conversions/media';
import { buildFfmpegArguments, resetHardwareAccelerationCache } from '../src/lib/conversions/media-ffmpeg-args';
import { InvalidMediaOptionError } from '../src/lib/types';

/**
 * Regression tests for media fail-open defects. Inputs are generated with ffmpeg lavfi sources;
 * every check reads the produced files back with ffprobe or decodes them with ffmpeg.
 */

const SAMPLE_RATE = 48000;
const TONE_HZ = 1000;
const CLIP_SECONDS = 2;
const PCM_BYTES_PER_SAMPLE = 2;
const PCM_FULL_SCALE = 32768;
/** RMS (relative to full scale) below which a channel counts as silent. */
const SILENCE_RMS = 1e-4;
/** RMS above which a channel clearly carries the generated tone (lavfi sine peaks at 1/8 full scale). */
const AUDIBLE_RMS = 0.01;
/** Render nodes whose presence lets the encoder pick VAAPI. */
const DRI_RENDER_NODES = ['/dev/dri/renderD128', '/dev/dri/card0'];
const HDR_ERROR = /HDR/;

let workDir: string;

function run(bin: string, args: string[]): Buffer {
  return execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function ffprobeJson(file: string): { streams: Record<string, unknown>[] } {
  return JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file]).toString('utf-8'));
}

/** Decodes the first audio stream to interleaved s16le stereo and returns each channel's RMS. */
function stereoRms(file: string): [number, number] {
  const pcm = run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 's16le', '-ac', '2', '-ar', String(SAMPLE_RATE), '-']);
  const sums = [0, 0];
  const frames = Math.floor(pcm.length / (PCM_BYTES_PER_SAMPLE * 2));
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < 2; ch++) {
      const v = pcm.readInt16LE((i * 2 + ch) * PCM_BYTES_PER_SAMPLE) / PCM_FULL_SCALE;
      sums[ch] += v * v;
    }
  }
  return [Math.sqrt(sums[0] / frames), Math.sqrt(sums[1] / frames)];
}

/** Encodes a PQ-tagged BT.2020 10-bit H.264 clip, the shape of a typical HDR10 source. */
function makeHdrInput(name: string): string {
  const input = path.join(workDir, name);
  run('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=25:duration=${CLIP_SECONDS}`,
    '-c:v', 'libx264', '-profile:v', 'high10', '-pix_fmt', 'yuv420p10le',
    '-color_trc', 'smpte2084', '-color_primaries', 'bt2020', '-colorspace', 'bt2020nc',
    input,
  ]);
  const video = ffprobeJson(input).streams.find((s) => s.codec_type === 'video')!;
  expect(video.color_transfer).toBe('smpte2084');
  return input;
}

/**
 * Builds an ffmpeg stand-in whose `-encoders` listing advertises the given hardware encoders, so the
 * argument builder's encoder probe selects a hardware path on a machine without that hardware.
 * The real ffprobe is linked beside it because the builder resolves ffprobe as ffmpeg's sibling.
 */
function makeHardwareFfmpeg(name: string, encoders: string[]): string {
  const dir = path.join(workDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'ffmpeg');
  const listing = encoders.map((enc) => ` V..... ${enc}  hardware encoder`).join('\n');
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "${listing}"\n`, { mode: 0o755 });
  fs.symlinkSync(getOracleToolPath('ffprobe')!, path.join(dir, 'ffprobe'));
  return bin;
}

/** Value that follows `flag` in an ffmpeg argument list. */
function argAfter(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-fail-open-'));
});

afterEach(() => {
  // Hardware probes are cached; never leak a stand-in's capabilities into another test.
  resetHardwareAccelerationCache();
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('media fail-open regressions', () => {
  oracleTest('keeps the audio track in every HLS rendition of a clip that has audio', ['ffmpeg', 'ffprobe'], async () => {
    const input = path.join(workDir, 'av.mp4');
    run('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=25:duration=${CLIP_SECONDS}`,
      '-f', 'lavfi', '-i', `sine=frequency=${TONE_HZ}:sample_rate=${SAMPLE_RATE}:duration=${CLIP_SECONDS}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', input,
    ]);

    const result = await packageHlsDashMedia(
      fs.readFileSync(input),
      'mp4',
      { packaging: { format: 'hls', segmentSeconds: 2, ladder: [{ height: 240, bitrateK: 400 }] } },
      'av'
    );

    const zip = await JSZip.loadAsync(result.buffer);
    const files = Object.keys(zip.files).filter((f) => !zip.files[f].dir);
    const segments = files.filter((f) => /\.(ts|m4s)$/.test(f)).sort();
    const variantPlaylists = files.filter((f) => f.endsWith('.m3u8') && f !== 'master.m3u8');
    expect(variantPlaylists).toHaveLength(1);
    const playlist = await zip.file(variantPlaylists[0])!.async('string');
    // Every media segment listed in the playlist is present in the bundle.
    expect(playlist.match(/^#EXTINF:/gm)?.length).toBe(segments.length);

    const segmentPath = path.join(workDir, path.basename(segments[0]));
    fs.writeFileSync(segmentPath, await zip.file(segments[0])!.async('nodebuffer'));
    const streams = ffprobeJson(segmentPath)
      .streams.map((s) => `${s.codec_type}:${s.codec_name}`)
      .sort();
    expect(streams).toEqual(['audio:aac', 'video:h264']);
    // The packaged audio carries the source tone rather than a silent track.
    const [left] = stereoRms(segmentPath);
    expect(left).toBeGreaterThan(AUDIBLE_RMS);
  }, 120_000);

  oracleTest('applies the 7.1 downmix matrix to an 8-channel input detected by probing', ['ffmpeg', 'ffprobe'], async () => {
    // Only the side-left channel carries signal; the 5.1 matrix has no SL term and would drop it.
    const input = path.join(workDir, 'side-left.wav');
    const silent = `anullsrc=channel_layout=mono:sample_rate=${SAMPLE_RATE}`;
    const tone = `sine=frequency=${TONE_HZ}:sample_rate=${SAMPLE_RATE}`;
    run('ffmpeg', [
      '-v', 'error', '-y',
      ...[silent, silent, silent, silent, silent, silent, tone, silent].flatMap((src) => ['-f', 'lavfi', '-t', String(CLIP_SECONDS), '-i', src]),
      '-filter_complex', 'join=inputs=8:channel_layout=7.1',
      '-c:a', 'pcm_s16le', input,
    ]);
    expect(ffprobeJson(input).streams[0].channels).toBe(8);

    const result = await convertMedia(fs.readFileSync(input), 'wav', 'wav', { audio: { downmix: 'itu-r-bs775' } }, 'side-left');
    const output = path.join(workDir, 'downmix.wav');
    fs.writeFileSync(output, result.buffer);

    const outStream = ffprobeJson(output).streams[0];
    expect(outStream.channels).toBe(2);
    const [left, right] = stereoRms(output);
    expect(left).toBeGreaterThan(SILENCE_RMS);
    expect(right).toBeLessThan(SILENCE_RMS);
  }, 120_000);

  oracleTest('encodes HEVC main10 with a 10-bit pixel format', ['ffmpeg', 'ffprobe'], async () => {
    const input = path.join(workDir, 'gradient.mp4');
    run('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=25:duration=${CLIP_SECONDS}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input,
    ]);

    const result = await convertMedia(
      fs.readFileSync(input),
      'mp4',
      'mp4',
      { disableHwaccel: true, video: { codec: 'hevc', profile: 'main10' } },
      'gradient'
    );
    const output = path.join(workDir, 'main10.mp4');
    fs.writeFileSync(output, result.buffer);

    const video = ffprobeJson(output).streams.find((s) => s.codec_type === 'video')!;
    expect(video.codec_name).toBe('hevc');
    expect(video.profile).toBe('Main 10');
    expect(video.pix_fmt).toBe('yuv420p10le');
  }, 120_000);

  oracleTest('rejects HDR input for an 8-bit target instead of writing untonemapped 8-bit video', ['ffmpeg', 'ffprobe'], async () => {
    const inputPath = makeHdrInput('hdr-reject.mp4');
    const input = fs.readFileSync(inputPath);
    for (const video of [{ codec: 'h264' as const }, { codec: 'hevc' as const, profile: 'main' }]) {
      const build = () =>
        buildFfmpegArguments(inputPath, path.join(workDir, 'hdr-reject-out.mp4'), 'mp4', 'mp4', { disableHwaccel: true, video });
      expect(build).toThrow(InvalidMediaOptionError);
      expect(build).toThrow(HDR_ERROR);

      // The explicit native path surfaces the typed option error unchanged.
      const attempt = convertMedia(input, 'mp4', 'mp4', { useFfmpeg: true, disableHwaccel: true, video }, 'hdr-reject');
      await expect(attempt).rejects.toBeInstanceOf(InvalidMediaOptionError);
      await expect(attempt).rejects.toThrow(HDR_ERROR);

      // The default native path keeps the option error type too, so the API answers 400.
      const defaultAttempt = convertMedia(input, 'mp4', 'mp4', { disableHwaccel: true, video }, 'hdr-reject-default');
      await expect(defaultAttempt).rejects.toBeInstanceOf(InvalidMediaOptionError);
      await expect(defaultAttempt).rejects.toThrow(HDR_ERROR);
    }
  }, 120_000);

  oracleTest('keeps HDR input 10-bit PQ when encoding H.264 high10', ['ffmpeg', 'ffprobe'], async () => {
    const input = makeHdrInput('hdr-high10-in.mp4');
    const result = await convertMedia(
      fs.readFileSync(input),
      'mp4',
      'mp4',
      { video: { codec: 'h264', profile: 'high10' } },
      'hdr-high10'
    );
    const output = path.join(workDir, 'hdr-high10-out.mp4');
    fs.writeFileSync(output, result.buffer);

    const video = ffprobeJson(output).streams.find((s) => s.codec_type === 'video')!;
    expect(video.codec_name).toBe('h264');
    expect(video.profile).toBe('High 10');
    expect(video.pix_fmt).toBe('yuv420p10le');
    expect(video.color_transfer).toBe('smpte2084');
  }, 120_000);

  oracleTest('rejects HDR input for an 8-bit target when a hardware encoder is advertised', ['ffmpeg', 'ffprobe'], () => {
    const input = makeHdrInput('hdr-hw-reject.mp4');
    const cases: Array<{ encoders: string[]; codec: 'h264' | 'hevc' }> = [
      { encoders: ['h264_nvenc', 'hevc_nvenc'], codec: 'h264' },
      { encoders: ['h264_nvenc', 'hevc_nvenc'], codec: 'hevc' },
      { encoders: ['h264_qsv'], codec: 'h264' },
    ];
    for (const [i, { encoders, codec }] of cases.entries()) {
      resetHardwareAccelerationCache();
      const fakeFfmpeg = makeHardwareFfmpeg(`hw-reject-${i}`, encoders);
      const build = () =>
        buildFfmpegArguments(input, path.join(workDir, `hw-reject-${i}.mp4`), 'mp4', 'mp4', { video: { codec } }, fakeFfmpeg);
      expect(build).toThrow(InvalidMediaOptionError);
      expect(build).toThrow(HDR_ERROR);
    }
  }, 120_000);

  oracleTest('encodes a 10-bit profile in software even when a hardware encoder is advertised', ['ffmpeg', 'ffprobe'], () => {
    const input = makeHdrInput('hdr-hw-tenbit.mp4');
    const cases: Array<{ encoders: string[]; codec: 'h264' | 'hevc'; profile: string; probeProfile: string }> = [
      { encoders: ['h264_nvenc', 'hevc_nvenc'], codec: 'h264', profile: 'high10', probeProfile: 'High 10' },
      { encoders: ['h264_qsv'], codec: 'h264', profile: 'high10', probeProfile: 'High 10' },
      { encoders: ['h264_nvenc', 'hevc_nvenc'], codec: 'hevc', profile: 'main10', probeProfile: 'Main 10' },
    ];
    for (const [i, { encoders, codec, profile, probeProfile }] of cases.entries()) {
      resetHardwareAccelerationCache();
      const fakeFfmpeg = makeHardwareFfmpeg(`hw-tenbit-${i}`, encoders);
      const output = path.join(workDir, `hw-tenbit-${i}.mp4`);
      const args = buildFfmpegArguments(input, output, 'mp4', 'mp4', { video: { codec, profile } }, fakeFfmpeg);

      // Hardware encoders here receive no -profile:v and may only take 8-bit surfaces.
      for (const enc of encoders) {
        expect(args).not.toContain(enc);
      }
      expect(args.join(' ')).not.toContain('nv12');
      expect(argAfter(args, '-profile:v')).toBe(profile);
      expect(argAfter(args, '-pix_fmt')).toBe('yuv420p10le');

      // Run the generated arguments through the real ffmpeg and read the result back.
      run('ffmpeg', ['-v', 'error', ...args]);
      const video = ffprobeJson(output).streams.find((s) => s.codec_type === 'video')!;
      expect(video.codec_name).toBe(codec);
      expect(video.profile).toBe(probeProfile);
      expect(video.pix_fmt).toBe('yuv420p10le');
      expect(video.color_transfer).toBe('smpte2084');
    }
  }, 240_000);

  const hasDri = DRI_RENDER_NODES.some((node) => fs.existsSync(node));
  // skip-ok: hardware capability: the VAAPI path exists only on a host with a DRM render node.
  it.skipIf(!hasDri)('never routes HDR input through the 8-bit VAAPI upload path', () => {
    const ffmpeg = getOracleToolPath('ffmpeg');
    if (!ffmpeg) {
      throw new Error('ffmpeg is required for the VAAPI regression on a host with a DRI render node');
    }
    const input = makeHdrInput('hdr-vaapi.mp4');
    const fakeFfmpeg = makeHardwareFfmpeg('hw-vaapi', ['h264_vaapi', 'hevc_vaapi']);
    const build8 = () =>
      buildFfmpegArguments(input, path.join(workDir, 'vaapi-8.mp4'), 'mp4', 'mp4', { video: { codec: 'hevc' } }, fakeFfmpeg);
    expect(build8).toThrow(HDR_ERROR);

    resetHardwareAccelerationCache();
    const args = buildFfmpegArguments(
      input, path.join(workDir, 'vaapi-10.mp4'), 'mp4', 'mp4', { video: { codec: 'hevc', profile: 'main10' } }, fakeFfmpeg
    );
    expect(args).not.toContain('hevc_vaapi');
    expect(args.join(' ')).not.toContain('format=nv12,hwupload');
    expect(argAfter(args, '-pix_fmt')).toBe('yuv420p10le');
  });
});
