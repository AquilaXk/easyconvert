import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFfmpegArguments, buildTwoPassArguments } from '../src/lib/conversions/media-ffmpeg-args';
import { probeStreamLayout, resolveFfprobeBinary } from '../src/lib/conversions/media-ffprobe';
import { computeMediaTimeoutMs } from '../src/lib/conversions/media-job-limit';
import { vp9DeadlineFor } from '../src/lib/conversions/media-vp9-effort';
import { requireOracleTool } from './helpers/differential-oracle';
import { requireEncoders } from './helpers/ffmpeg-media-fixtures';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';
import { HAS_ZSCALE } from './helpers/zimg-oracle';
import { openMediaInput } from '../src/lib/conversions/media-process';

/**
 * How hard libvpx-vp9 works on a job. A job whose frames do not fit the media time limit at the good deadline (whose
 * cost does not fall with cpu-used, measured on the 30 s 1080p60 HDR10 clip of the real-world corpus: 62 s at cpu-used 2,
 * 64 s at 5) is encoded with the realtime deadline; every other job keeps the documented good deadline at cpu-used 2.
 * The expectations below are the sizes and lengths the measurements were made at, not the constants of the module.
 */

const skip = skipWithoutTools('ffmpeg', 'ffprobe');
const FIXTURE_TIMEOUT_MS = 120_000;
const FHD = { width: 1920, height: 1080 };
const UHD = { width: 3840, height: 2160 };
const HD = { width: 1280, height: 720 };
const SD = { width: 854, height: 480 };
/** The media time limit ceiling of a job without a tier or stage override. */
const DEFAULT_TIER_MAX_MS = 180_000;
const HDR_CLIP = 'jellyfin-1080p-hevc-hdr10-3m.mp4';
const HDR_CLIP_FRAMES = 1797;
const HDR_CLIP_SECONDS = 29.95;

describe('the deadline for a workload', () => {
  const cases: Array<{ name: string; width: number; height: number; fps: number; seconds: number; expected: 'good' | 'realtime' }> = [
    { name: 'a 1 s 160x120 clip', width: 160, height: 120, fps: 24, seconds: 1, expected: 'good' },
    { name: 'a 3 s 720p clip', ...HD, fps: 30, seconds: 3, expected: 'good' },
    { name: 'a 10 s 1080p clip at 30 fps', ...FHD, fps: 30, seconds: 10, expected: 'good' },
    { name: 'a 30 s 1080p clip at 30 fps', ...FHD, fps: 30, seconds: 30, expected: 'good' },
    { name: 'a 60 s 1080p clip at 30 fps', ...FHD, fps: 30, seconds: 60, expected: 'realtime' },
    { name: 'a 30 s 1080p clip at 60 fps', ...FHD, fps: 60, seconds: 30, expected: 'realtime' },
    { name: 'a 10 s 2160p clip at 24 fps', ...UHD, fps: 24, seconds: 10, expected: 'realtime' },
    { name: 'a 10 min 720p clip', ...HD, fps: 30, seconds: 600, expected: 'realtime' },
    { name: 'a 30 min 480p clip', ...SD, fps: 25, seconds: 1800, expected: 'realtime' },
  ];
  for (const row of cases) {
    it(`${row.name} is encoded with the ${row.expected} deadline`, () => {
      const frames = row.fps * row.seconds;
      expect(vp9DeadlineFor({ width: row.width, height: row.height, frames, durationSec: row.seconds, tierMaxMs: DEFAULT_TIER_MAX_MS })).toBe(row.expected);
    });
  }

  it('the HDR10 clip of the corpus (1,797 frames of 1080p in 29.95 s) is encoded with the realtime deadline', () => {
    expect(vp9DeadlineFor({ ...FHD, frames: HDR_CLIP_FRAMES, durationSec: HDR_CLIP_SECONDS, tierMaxMs: DEFAULT_TIER_MAX_MS })).toBe('realtime');
  });

  // 30 s of 1080p at 30 fps is 900 frames of 2,073,600 pixels: 1,866.24 megapixels, which at 14 megapixels per CPU
  // second on two cores is 66.651 s. The job's limit is min(ceiling, 3 x 30 + 60 = 150 s) and half of it is the allowance.
  const stageClip = { ...FHD, frames: 900, durationSec: 30 };

  it('a 30 s 1080p clip fits half of its 150 s limit (75 s allowance against 66.651 s) and keeps the good deadline', () => {
    expect(vp9DeadlineFor({ ...stageClip, tierMaxMs: DEFAULT_TIER_MAX_MS })).toBe('good');
  });

  it('the same clip under a 100 s stage limit has a 50 s allowance against 66.651 s and takes the realtime deadline', () => {
    expect(vp9DeadlineFor({ ...stageClip, tierMaxMs: 100_000 })).toBe('realtime');
  });

  it('the allowance is exactly half of the stage limit: 66.651 s fits a limit of 133.303 s but not one of 133.3 s', () => {
    expect(vp9DeadlineFor({ ...stageClip, tierMaxMs: 133_303 })).toBe('good');
    expect(vp9DeadlineFor({ ...stageClip, tierMaxMs: 133_300 })).toBe('realtime');
  });

  it('more frames of the same picture never return to the good deadline', () => {
    let seenRealtime = false;
    for (let seconds = 1; seconds <= 1200; seconds += 1) {
      const deadline = vp9DeadlineFor({ ...FHD, frames: 30 * seconds, durationSec: seconds, tierMaxMs: DEFAULT_TIER_MAX_MS });
      if (deadline === 'realtime') seenRealtime = true;
      expect(seenRealtime && deadline === 'good', `${seconds} s`).toBe(false);
    }
    expect(seenRealtime).toBe(true);
  });
});

/**
 * The slowest encode of each picture size among the clips of the real-world corpus, at the good deadline with cpu-used 2 and
 * the product's arguments, pinned to two cores (`taskset -c 0,1`, libvpx 1.14, FFmpeg 6.1.1, Ubuntu 24.04 arm64, Lima VM
 * `default`): megapixels encoded per wall second. The same clips scaled to other sizes are in the rows of their size (a
 * clip's cost per pixel falls with the picture size: the 1080p HDR10 clip gives 29.4, the same footage at 426x240 gives 9.8).
 */
const CORPUS_TWO_CORE_MEGAPIXELS_PER_SECOND: ReadonlyArray<readonly [string, number, number, number]> = [
  ['fate-lmlm4_cifat30fps.divx', 320, 240, 16.1],
  ['ffs-encoded.m4v', 352, 288, 10.4],
  ['wc-hummingbird-hlg-05.webm scaled', 426, 240, 9.8],
  ['ffs-p6040064a.mp4 scaled', 640, 360, 16.7],
  ['ffs-p6040064a.mp4', 640, 480, 16.9],
  ['ffs-p6040064a.mp4 scaled', 854, 480, 17.5],
  ['wc-urmia_lake_drought.webm', 720, 1080, 25.6],
  ['ffs-p6040064a.mp4 scaled', 1280, 720, 22.9],
  ['jellyfin-1080p-hevc-hdr10-3m.mp4', 1920, 1080, 29.4],
  ['wc-hummingbird-hlg-02.webm', 3840, 2160, 43.5],
];

describe('the deadline against the encode times measured on the corpus', () => {
  const CLIP_SECONDS = 60;
  const ENCODE_SHARE = 0.5;
  for (const [clip, width, height, measured] of CORPUS_TWO_CORE_MEGAPIXELS_PER_SECOND) {
    it(`takes the realtime deadline for ${width}x${height} frames that the slowest corpus clip (${clip}, ${measured} megapixels per second on two cores) would not finish in half of the limit`, () => {
      const allowanceSeconds = (computeMediaTimeoutMs(CLIP_SECONDS, DEFAULT_TIER_MAX_MS) / 1000) * ENCODE_SHARE;
      // Frames whose measured encode time is 1% past the allowance; the clip length of 60 s sets the limit.
      const frames = Math.ceil((1.01 * allowanceSeconds * measured * 1e6) / (width * height));
      expect(vp9DeadlineFor({ width, height, frames, durationSec: CLIP_SECONDS, tierMaxMs: DEFAULT_TIER_MAX_MS })).toBe('realtime');
    });
  }
});

let workDir: string;
beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp9-effort-'));
});
afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** A black H.264 picture of `size` at `rate` frames per second for `seconds`, as a plain MP4 (cheap to write: static content). */
function blackMp4(name: string, size: string, rate: number, seconds: number): string {
  requireEncoders('libx264');
  const out = path.join(workDir, name);
  execFileSync(
    requireOracleTool('ffmpeg'),
    ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:size=${size}:rate=${rate}:duration=${seconds}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', out],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  return out;
}

function flagValue(args: string[], flag: string): string {
  return args[args.indexOf(flag) + 1];
}

async function webmArgs(input: string, options: object = {}, target = 'webm'): Promise<string[]> {
  return await buildFfmpegArguments(openMediaInput(input, 'mp4'), `/tmp/out.${target}`, target, { disableHwaccel: true, ...options } as never, requireOracleTool('ffmpeg'));
}

describe.skipIf(skip)('the arguments of a VP9 encode', () => {
  it('give a 30 s 1080p60 clip the realtime deadline and a 3 s one of the same picture the good deadline', { timeout: FIXTURE_TIMEOUT_MS }, async () => {
    const long = await webmArgs(blackMp4('fhd60-30s.mp4', '1920x1080', 60, 30));
    expect(flagValue(long, '-deadline')).toBe('realtime');
    expect(flagValue(long, '-cpu-used')).toBe('5');
    expect(flagValue(long, '-row-mt')).toBe('1');
    expect(flagValue(long, '-tile-columns')).toBe('2');
    const short = await webmArgs(blackMp4('fhd60-3s.mp4', '1920x1080', 60, 3));
    expect(flagValue(short, '-deadline')).toBe('good');
    expect(flagValue(short, '-cpu-used')).toBe('2');
  });

  it('size the deadline against the stage limit of the job: a 30 s 1080p30 clip is good by default and realtime under a 100 s limit', { timeout: FIXTURE_TIMEOUT_MS }, async () => {
    const input = blackMp4('fhd30-30s-stage.mp4', '1920x1080', 30, 30);
    expect(flagValue(await webmArgs(input), '-deadline')).toBe('good');
    expect(flagValue(await webmArgs(input, { timeoutMs: 100_000 }), '-deadline')).toBe('realtime');
  });

  it('decide the same for VP9 in an MP4 or Matroska file', { timeout: FIXTURE_TIMEOUT_MS }, async () => {
    const input = blackMp4('fhd60-30s-b.mp4', '1920x1080', 60, 30);
    for (const target of ['mp4', 'mkv']) {
      const args = await webmArgs(input, { video: { codec: 'vp9' } }, target);
      expect(args[args.indexOf('-c:v') + 1], target).toBe('libvpx-vp9');
      expect(flagValue(args, '-deadline'), target).toBe('realtime');
    }
  });

  it('keep the good deadline when the request changes the size or the frame rate, and for the other codecs', { timeout: FIXTURE_TIMEOUT_MS }, async () => {
    const input = blackMp4('fhd60-30s-c.mp4', '1920x1080', 60, 30);
    expect(flagValue(await webmArgs(input, { video: { scale: { width: 1280, height: 720 } } }), '-deadline')).toBe('good');
    expect(flagValue(await webmArgs(input, { video: { fps: 24 } }), '-deadline')).toBe('good');
    expect(await webmArgs(input, { video: { codec: 'av1' } })).not.toContain('-deadline');
  });

  it('keep the good deadline for both passes of a two-pass encode, which the realtime deadline cannot do', { timeout: FIXTURE_TIMEOUT_MS }, async () => {
    const input = blackMp4('fhd60-30s-d.mp4', '1920x1080', 60, 30);
    const passes = await buildTwoPassArguments(
      openMediaInput(input, 'mp4'),
      '/tmp/out.webm',
      'webm',
      { disableHwaccel: true, video: { rateControl: { mode: 'vbr', bitrateK: 2000, twoPass: true } } } as never,
      requireOracleTool('ffmpeg'),
      'pass-log'
    );
    for (const args of passes) expect(flagValue(args, '-deadline')).toBe('good');
  });

  it('count the frames of a plain MP4 from its header, as ffprobe counts its packets', { timeout: FIXTURE_TIMEOUT_MS }, async () => {
    const input = blackMp4('fhd60-count.mp4', '1920x1080', 60, 5);
    const layout = await probeStreamLayout(openMediaInput(input, 'mp4'), resolveFfprobeBinary(undefined));
    const counted = execFileSync(
      requireOracleTool('ffprobe'),
      ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', input],
      { encoding: 'utf8' }
    );
    expect(layout.streams.find((stream) => stream.type === 'video')?.frameCount).toBe(Number(counted.trim()));
    expect(layout.streams.find((stream) => stream.type === 'video')?.frameCount).toBe(300);
    expect(layout.durationSec).toBeCloseTo(5, 1);
  });

  it.skipIf(skipUnless('ffmpeg with zscale and lutrgb', HAS_ZSCALE))(
    'give the HDR10 clip of the corpus the realtime deadline: the clip that ran into the 150 s limit',
    { timeout: FIXTURE_TIMEOUT_MS },
    async (ctx) => {
      const sample = await requireRealworldSample(ctx, HDR_CLIP);
      const args = await webmArgs(sample.path);
      expect(flagValue(args, '-deadline')).toBe('realtime');
      expect(flagValue(args, '-cpu-used')).toBe('5');
      expect(flagValue(args, '-pix_fmt')).toBe('yuv420p');
    }
  );
});
