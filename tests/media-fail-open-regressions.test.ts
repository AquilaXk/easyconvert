import { describe, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { oracleTest } from './helpers/oracle-test';
import { convertMedia, packageHlsDashMedia } from '../src/lib/conversions/media';

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

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-fail-open-'));
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
});
