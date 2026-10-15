import { describe, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { oracleTest } from './helpers/oracle-test';
import { getOracleToolPath } from './helpers/differential-oracle';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import {
  buildFfmpegArguments,
  probeHardwareAcceleration,
  resetHardwareAccelerationCache,
} from '../src/lib/conversions/media-ffmpeg-args';

/**
 * A host whose ffmpeg lists NVENC or VAAPI encoders but cannot open a hardware session (no GPU,
 * no driver) must not select them. Listing an encoder only proves it was compiled in, so the
 * capability probe opens a real one-shot session, and the worker retries once in software when a
 * hardware encoder still fails at runtime.
 */

const CLIP_SECONDS = 1;
const CLIP_FPS = 10;
const CLIP_WIDTH = 64;
const CLIP_HEIGHT = 48;
const TEST_TIMEOUT_MS = 120_000;
const HW_ERROR = 'Cannot load libcuda.so.1';

let workDir: string;
let sourceMp4: Buffer;

function run(bin: string, args: string[]): string {
  return execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString('utf-8');
}

interface Stub {
  bin: string;
  log: string;
}

/**
 * Stand-in ffmpeg whose `-encoders` listing adds real-format NVENC rows (with the D flag) and whose
 * runs selecting an NVENC encoder fail unless `nvencWorks` (then they exit 0 without output).
 * Everything else goes to the real ffmpeg.
 * `log` receives one line per run that selects a video encoder.
 */
function makeStub(name: string, nvencWorks: boolean): Stub {
  const real = getOracleToolPath('ffmpeg');
  if (!real) throw new Error('ffmpeg is required to build the stand-in encoder');
  const dir = path.join(workDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'ffmpeg');
  const log = path.join(dir, 'invocations.log');
  const nvencResult = nvencWorks ? 'exit 0' : `echo "[h264_nvenc] ${HW_ERROR}" >&2; exit 1`;
  const script = [
    '#!/bin/sh',
    `REAL="${real}"`,
    'for a in "$@"; do',
    '  case "$a" in',
    `    -encoders) "$REAL" "$@"; printf ' V....D h264_nvenc           NVIDIA NVENC H.264 encoder\\n V....D hevc_nvenc           NVIDIA NVENC hevc encoder\\n'; exit 0;;`,
    `    h264_nvenc|hevc_nvenc) echo "$a" >> "${log}"; ${nvencResult};;`,
    `    libx264) echo "libx264" >> "${log}";;`,
    '  esac',
    'done',
    'exec "$REAL" "$@"',
    '',
  ].join('\n');
  fs.writeFileSync(bin, script, { mode: 0o755 });
  return { bin, log };
}

function attempts(log: string): string[] {
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean) : [];
}

const savedFfmpegPath = process.env.FFMPEG_PATH;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-hw-session-'));
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

afterEach(() => {
  resetHardwareAccelerationCache();
  if (savedFfmpegPath === undefined) delete process.env.FFMPEG_PATH;
  else process.env.FFMPEG_PATH = savedFfmpegPath;
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('NVENC capability probe', () => {
  oracleTest('lists the encoder but does not enable nvenc when no session opens', ['ffmpeg'], () => {
    const { bin, log } = makeStub('probe-fails', false);
    const caps = probeHardwareAcceleration(bin);
    expect(caps.supportedEncoders.has('h264_nvenc')).toBe(true);
    expect(caps.nvenc).toBe(false);
    expect(attempts(log).length).toBeGreaterThan(0);
  });

  oracleTest('enables nvenc when a one-shot session opens, probing once per TTL', ['ffmpeg'], () => {
    const { bin, log } = makeStub('probe-works', true);
    const caps = probeHardwareAcceleration(bin);
    expect(caps.nvenc).toBe(true);
    const probes = attempts(log).length;
    expect(probeHardwareAcceleration(bin)).toBe(caps);
    expect(attempts(log)).toHaveLength(probes);
  });

  oracleTest('builds software H.264 arguments on a host that cannot open an NVENC session', ['ffmpeg'], () => {
    const { bin } = makeStub('args-sw', false);
    const args = buildFfmpegArguments('/nonexistent/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {}, bin);
    expect(args[args.indexOf('-c:v') + 1]).toBe('libx264');
  });
});

describe('worker transcode on a host that lists NVENC without a GPU', () => {
  oracleTest('converts mp4 to mp4 with libx264 through the dispatcher', ['ffmpeg', 'ffprobe'], async () => {
    const { bin, log } = makeStub('dispatch-nogpu', false);
    process.env.FFMPEG_PATH = bin;
    const result = await dispatchConversion(sourceMp4, 'mp4', 'mp4', {}, 'clip.mp4');

    const out = path.join(workDir, 'dispatched.mp4');
    fs.writeFileSync(out, result.buffer);
    const probe = JSON.parse(
      run(getOracleToolPath('ffprobe')!, [
        '-v', 'error', '-count_frames', '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name,width,height,nb_read_frames', '-of', 'json', out,
      ])
    ) as { streams: Array<{ codec_name: string; width: number; height: number; nb_read_frames: string }> };
    expect(probe.streams[0].codec_name).toBe('h264');
    expect(probe.streams[0].width).toBe(CLIP_WIDTH);
    expect(Number(probe.streams[0].nb_read_frames)).toBe(CLIP_FPS * CLIP_SECONDS);
    // The only NVENC run is the capability probe; the transcode itself used the software encoder.
    expect(attempts(log).at(-1)).toBe('libx264');
    expect(attempts(log).filter((entry) => entry === 'libx264')).toHaveLength(1);
  }, TEST_TIMEOUT_MS);
});

describe('worker software retry', () => {
  oracleTest('retries once in software for a hardware encoder that fails after a successful probe', ['ffmpeg'], async () => {
    // The probe session succeeds, then the real transcode fails once: the worker must retry in software.
    const real = getOracleToolPath('ffmpeg')!;
    const dir = path.join(workDir, 'flaky');
    fs.mkdirSync(dir, { recursive: true });
    const bin = path.join(dir, 'ffmpeg');
    const log = path.join(dir, 'invocations.log');
    const script = [
      '#!/bin/sh',
      `REAL="${real}"`,
      'PROBE=0',
      'for a in "$@"; do',
      '  case "$a" in',
      `    -encoders) "$REAL" "$@"; printf ' V....D h264_nvenc           NVIDIA NVENC H.264 encoder\\n'; exit 0;;`,
      '    lavfi) PROBE=1;;',
      '    h264_nvenc)',
      `      echo "h264_nvenc probe=$PROBE" >> "${log}"`,
      `      if [ "$PROBE" = 1 ]; then exit 0; fi`,
      `      echo "[h264_nvenc] ${HW_ERROR}" >&2; exit 1;;`,
      `    libx264) echo "libx264" >> "${log}";;`,
      '  esac',
      'done',
      'exec "$REAL" "$@"',
      '',
    ].join('\n');
    fs.writeFileSync(bin, script, { mode: 0o755 });
    process.env.FFMPEG_PATH = bin;

    const result = await dispatchConversion(sourceMp4, 'mp4', 'mkv', {}, 'clip.mp4');
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(attempts(log)).toEqual(['h264_nvenc probe=1', 'h264_nvenc probe=0', 'libx264']);
  }, TEST_TIMEOUT_MS);
});
