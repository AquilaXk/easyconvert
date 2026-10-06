import { describe, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { oracleTest } from './helpers/oracle-test';
import { getOracleToolPath } from './helpers/differential-oracle';

/**
 * A hardware encoder that is advertised but fails at runtime (driver, device, session) must
 * trigger exactly one software retry. A failing retry reports the original hardware error, and
 * failures that did not involve a hardware encoder are never retried.
 */

const CLIP_SECONDS = 1;
const CLIP_FPS = 10;
const CLIP_WIDTH = 64;
const CLIP_HEIGHT = 48;
const TEST_TIMEOUT_MS = 120_000;
const HW_ERROR = 'Cannot load libcuda.so.1';
const SW_ERROR = 'software encoder exploded';

let workDir: string;
let sourceMp4: Buffer;

function run(bin: string, args: string[]): string {
  return execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString('utf-8');
}

/**
 * Stand-in ffmpeg that advertises h264_nvenc and fails every run that selects it. Runs that
 * select libx264 fail too when `failSoftware`; all other runs are handed to the real ffmpeg.
 */
function makeFfmpeg(name: string, failSoftware: boolean): { bin: string; log: string } {
  const real = getOracleToolPath('ffmpeg');
  if (!real) {
    throw new Error('ffmpeg is required to build the stand-in encoder');
  }
  const dir = path.join(workDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'ffmpeg');
  const log = path.join(dir, 'invocations.log');
  const softwareResult = failSoftware ? `echo "${SW_ERROR}" >&2; exit 1` : ':';
  const script = [
    '#!/bin/sh',
    'for a in "$@"; do',
    '  case "$a" in',
    "    -encoders) printf ' V..... h264_nvenc  NVIDIA NVENC H.264\\n'; exit 0;;",
    `    h264_nvenc) echo "h264_nvenc" >> "${log}"; echo "[h264_nvenc] ${HW_ERROR}" >&2; exit 1;;`,
    `    libx264) echo "libx264" >> "${log}"; ${softwareResult};;`,
    '  esac',
    'done',
    `exec "${real}" "$@"`,
    '',
  ].join('\n');
  fs.writeFileSync(bin, script, { mode: 0o755 });
  return { bin, log };
}

function attempts(log: string): string[] {
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean) : [];
}

async function loadConverter(ffmpegBin: string): Promise<typeof import('../src/lib/conversions/media')> {
  // The converter caches the ffmpeg path and the hardware probe per module instance.
  vi.resetModules();
  process.env.FFMPEG_PATH = ffmpegBin;
  return import('../src/lib/conversions/media');
}

const savedFfmpegPath = process.env.FFMPEG_PATH;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-hw-retry-'));
  const ffmpeg = getOracleToolPath('ffmpeg');
  if (!ffmpeg) return;
  const clip = path.join(workDir, 'source.mp4');
  run(ffmpeg, [
    '-v', 'error', '-y', '-f', 'lavfi',
    '-i', `testsrc=size=${CLIP_WIDTH}x${CLIP_HEIGHT}:rate=${CLIP_FPS}:duration=${CLIP_SECONDS}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clip,
  ]);
  sourceMp4 = fs.readFileSync(clip);
});

afterAll(() => {
  if (savedFfmpegPath === undefined) delete process.env.FFMPEG_PATH;
  else process.env.FFMPEG_PATH = savedFfmpegPath;
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.resetModules();
});

describe('hardware encoder runtime failure', () => {
  oracleTest('retries once with the software encoder and produces a decodable file', ['ffmpeg', 'ffprobe'], async () => {
    const { bin, log } = makeFfmpeg('retry-ok', false);
    const { convertMedia } = await loadConverter(bin);
    const result = await convertMedia(sourceMp4, 'mp4', 'mkv', {}, 'clip');

    expect(attempts(log)).toEqual(['h264_nvenc', 'libx264']);
    const out = path.join(workDir, 'retry-ok.mkv');
    fs.writeFileSync(out, result.buffer);
    const ffprobe = getOracleToolPath('ffprobe');
    if (!ffprobe) {
      throw new Error('ffprobe is required to read back the converted video');
    }
    const probe = JSON.parse(
      run(ffprobe, [
        '-v', 'error', '-count_frames', '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name,width,height,nb_read_frames', '-of', 'json', out,
      ])
    ) as { streams: Array<{ codec_name: string; width: number; height: number; nb_read_frames: string }> };
    expect(probe.streams[0].codec_name).toBe('h264');
    expect(probe.streams[0].width).toBe(CLIP_WIDTH);
    expect(probe.streams[0].height).toBe(CLIP_HEIGHT);
    expect(Number(probe.streams[0].nb_read_frames)).toBe(CLIP_FPS * CLIP_SECONDS);
  }, TEST_TIMEOUT_MS);

  oracleTest('fails closed with the original hardware error when the software retry also fails', ['ffmpeg', 'ffprobe'], async () => {
    const { bin, log } = makeFfmpeg('retry-fails', true);
    const { convertMedia } = await loadConverter(bin);
    await expect(convertMedia(sourceMp4, 'mp4', 'mkv', {}, 'clip')).rejects.toThrow(HW_ERROR);
    expect(attempts(log)).toEqual(['h264_nvenc', 'libx264']);
  }, TEST_TIMEOUT_MS);

  oracleTest('does not retry when no hardware encoder was selected', ['ffmpeg', 'ffprobe'], async () => {
    const { bin, log } = makeFfmpeg('no-retry', true);
    const { convertMedia } = await loadConverter(bin);
    await expect(
      convertMedia(sourceMp4, 'mp4', 'mkv', { disableHwaccel: true }, 'clip')
    ).rejects.toThrow(SW_ERROR);
    expect(attempts(log)).toEqual(['libx264']);
  }, TEST_TIMEOUT_MS);
});
