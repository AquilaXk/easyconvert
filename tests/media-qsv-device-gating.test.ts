import { describe, expect, beforeAll, afterAll, afterEach, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { oracleTest } from './helpers/oracle-test';
import { getOracleToolPath } from './helpers/differential-oracle';
import { convertFile } from '../src/lib/conversions';
import {
  probeHardwareAcceleration,
  resetHardwareAccelerationCache,
} from '../src/lib/conversions/media-ffmpeg-args';

/**
 * Hosts whose ffmpeg lists h264_qsv but have no Intel device used to fail every default H.264
 * transcode with "Error creating a MFX session". QSV is only usable when a DRM render node
 * exists and an encoder session can actually be opened.
 */

const FRAME_WIDTH = 64;
const FRAME_HEIGHT = 48;
const GIF_FPS = 5;
const GIF_SECONDS = 1;
const TEST_TIMEOUT_MS = 120_000;
const VIDEO_TARGETS = ['mp4', 'mkv', 'mov'] as const;
const STILL_FRAME_COUNT = 1;

let workDir: string;

function run(bin: string, args: string[]): string {
  return execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).toString('utf-8');
}

interface VideoStream {
  codec_name: string;
  width: number;
  height: number;
  nb_read_frames: string;
}

/** Reads the first video stream back with ffprobe, decoding every frame to count them. */
function probeVideo(file: string): VideoStream {
  const ffprobe = getOracleToolPath('ffprobe');
  if (!ffprobe) {
    throw new Error('ffprobe is required to read back the converted video');
  }
  const json = JSON.parse(
    run(ffprobe, [
      '-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,width,height,nb_read_frames', '-of', 'json', file,
    ])
  ) as { streams: VideoStream[] };
  expect(json.streams).toHaveLength(1);
  return json.streams[0];
}

/** Stand-in ffmpeg that lists h264_qsv and opens a QSV session only when `sessionWorks`. */
function makeQsvFfmpeg(name: string, sessionWorks: boolean): { bin: string; log: string } {
  const dir = path.join(workDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'ffmpeg');
  const log = path.join(dir, 'invocations.log');
  const sessionResult = sessionWorks ? 'exit 0' : 'echo "Error creating a MFX session: -9" >&2; exit 1';
  const script = [
    '#!/bin/sh',
    `echo "$@" >> "${log}"`,
    'for a in "$@"; do',
    '  case "$a" in',
    "    -encoders) printf ' V..... h264_qsv  H.264 (Intel Quick Sync Video)\\n'; exit 0;;",
    `    h264_qsv) ${sessionResult};;`,
    '  esac',
    'done',
    'exit 0',
    '',
  ].join('\n');
  fs.writeFileSync(bin, script, { mode: 0o755 });
  return { bin, log };
}

function qsvSessionAttempts(log: string): number {
  if (!fs.existsSync(log)) return 0;
  return fs.readFileSync(log, 'utf-8').split('\n').filter((line) => line.includes('h264_qsv')).length;
}

function makeDrmDir(name: string, nodes: string[]): string {
  const dir = path.join(workDir, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const node of nodes) fs.writeFileSync(path.join(dir, node), '');
  return dir;
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-qsv-gating-'));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

afterEach(() => {
  resetHardwareAccelerationCache();
});

describe('QSV capability probe', () => {
  const noPosixShell = process.platform === 'win32';

  it.skipIf(noPosixShell)('does not enable qsv when the host has no DRM render node', () => {
    const { bin, log } = makeQsvFfmpeg('no-node', true);
    const caps = probeHardwareAcceleration(bin, { drmDir: makeDrmDir('drm-empty', []) });
    expect(caps.supportedEncoders.has('h264_qsv')).toBe(true);
    expect(caps.qsv).toBe(false);
    // Without a device there is nothing to open a session against, so no session is attempted.
    expect(qsvSessionAttempts(log)).toBe(0);
  });

  it.skipIf(noPosixShell)('does not treat a legacy card node as a QSV render node', () => {
    const { bin } = makeQsvFfmpeg('card-only', true);
    const caps = probeHardwareAcceleration(bin, { drmDir: makeDrmDir('drm-card', ['card0']) });
    expect(caps.qsv).toBe(false);
  });

  it.skipIf(noPosixShell)('does not enable qsv when a render node exists but the QSV session cannot be created', () => {
    const { bin, log } = makeQsvFfmpeg('session-fails', false);
    const caps = probeHardwareAcceleration(bin, { drmDir: makeDrmDir('drm-broken', ['renderD128']) });
    expect(caps.qsv).toBe(false);
    expect(qsvSessionAttempts(log)).toBe(1);
  });

  it.skipIf(noPosixShell)('enables qsv when a render node exists and an encoder session opens, probing once per TTL', () => {
    const { bin, log } = makeQsvFfmpeg('session-works', true);
    const drmDir = makeDrmDir('drm-ok', ['renderD129']);
    const caps = probeHardwareAcceleration(bin, { drmDir });
    expect(caps.qsv).toBe(true);
    expect(probeHardwareAcceleration(bin, { drmDir })).toBe(caps);
    expect(qsvSessionAttempts(log)).toBe(1);
  });
});

describe('default H.264 transcodes of animated and still image sources', () => {
  let gif: Buffer;
  let gifSourceFrames = 0;
  let webp: Buffer;

  beforeAll(async () => {
    const ffmpeg = getOracleToolPath('ffmpeg');
    const ffprobe = getOracleToolPath('ffprobe');
    if (!ffmpeg || !ffprobe) return;
    // The animated GIF comes from ffmpeg's lavfi test source, independent of the code under test.
    const gifPath = path.join(workDir, 'source.gif');
    run(ffmpeg, [
      '-v', 'error', '-y', '-f', 'lavfi',
      '-i', `testsrc=size=${FRAME_WIDTH}x${FRAME_HEIGHT}:rate=${GIF_FPS}:duration=${GIF_SECONDS}`,
      '-f', 'gif', gifPath,
    ]);
    gif = fs.readFileSync(gifPath);
    gifSourceFrames = Number(probeVideo(gifPath).nb_read_frames);
    webp = await sharp({
      create: { width: FRAME_WIDTH, height: FRAME_HEIGHT, channels: 3, background: { r: 200, g: 40, b: 40 } },
    })
      .webp()
      .toBuffer();
  });

  for (const target of VIDEO_TARGETS) {
    oracleTest(`converts an animated gif to ${target} with default options`, ['ffmpeg', 'ffprobe'], async () => {
      expect(gifSourceFrames).toBe(GIF_FPS * GIF_SECONDS);
      const result = await convertFile(gif, 'gif', target, {}, 'anim.gif');
      const out = path.join(workDir, `anim.${target}`);
      fs.writeFileSync(out, result.buffer);
      const video = probeVideo(out);
      expect(video.codec_name).toBe('h264');
      expect(video.width).toBe(FRAME_WIDTH);
      expect(video.height).toBe(FRAME_HEIGHT);
      expect(Number(video.nb_read_frames)).toBeGreaterThanOrEqual(gifSourceFrames);
    }, TEST_TIMEOUT_MS);

    oracleTest(`converts a still webp to ${target} with default options`, ['ffmpeg', 'ffprobe'], async () => {
      const result = await convertFile(webp, 'webp', target, {}, 'still.webp');
      const out = path.join(workDir, `still.${target}`);
      fs.writeFileSync(out, result.buffer);
      const video = probeVideo(out);
      expect(video.codec_name).toBe('h264');
      expect(video.width).toBe(FRAME_WIDTH);
      expect(video.height).toBe(FRAME_HEIGHT);
      expect(Number(video.nb_read_frames)).toBeGreaterThanOrEqual(STILL_FRAME_COUNT);
    }, TEST_TIMEOUT_MS);
  }
});
