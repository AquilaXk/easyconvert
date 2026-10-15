import { describe, expect, it } from 'vitest';
import { admittingLevels, levelCodecStrings, vp9CodecString, vp9LevelAdmitsPicture, type LevelFamily } from '../src/lib/edge/media/codec-levels';
import { EdgeUnsupportedError } from '../src/lib/edge/workers/worker-errors';
import { requireEncoders, runFfmpeg, testPatternInput } from './helpers/ffmpeg-media-fixtures';
import { ffprobeReport } from './helpers/ffprobe-json';
import { extractVpcC } from './helpers/iso-bmff-walker';
import { oracleTest } from './helpers/oracle-test';

function lowest(family: LevelFamily, width: number, height: number, framerate: number): number {
  return admittingLevels(family, { width, height, framerate })[0];
}

/**
 * The lowest level of each codec for well-known formats, as the level tables of the specifications give them:
 * H.264 Table A-1 (level_idc 10 x level), H.265 Table A.8 (general_level_idc 30 x level), VP9 Annex A (10 x level).
 */
const ANCHORS: Array<{ label: string; width: number; height: number; fps: number; h264: number; hevc: number; vp9: number }> = [
  { label: 'QCIF at 15 fps', width: 176, height: 144, fps: 15, h264: 10, hevc: 30, vp9: 10 },
  { label: 'CIF at 30 fps', width: 352, height: 288, fps: 30, h264: 13, hevc: 60, vp9: 20 },
  { label: '720p at 30 fps', width: 1280, height: 720, fps: 30, h264: 31, hevc: 93, vp9: 31 },
  { label: '720p at 60 fps', width: 1280, height: 720, fps: 60, h264: 32, hevc: 120, vp9: 40 },
  { label: '1080p at 30 fps', width: 1920, height: 1080, fps: 30, h264: 40, hevc: 120, vp9: 40 },
  { label: '1080p at 60 fps', width: 1920, height: 1080, fps: 60, h264: 42, hevc: 123, vp9: 41 },
  { label: '4K at 30 fps', width: 3840, height: 2160, fps: 30, h264: 51, hevc: 150, vp9: 50 },
  { label: '4K at 60 fps', width: 3840, height: 2160, fps: 60, h264: 52, hevc: 153, vp9: 51 },
];

describe('the lowest codec level that admits a picture size and frame rate', () => {
  it.each(ANCHORS)('$label: H.264 $h264, HEVC $hevc, VP9 $vp9', ({ width, height, fps, h264, hevc, vp9 }) => {
    expect(lowest('h264', width, height, fps)).toBe(h264);
    expect(lowest('hevc', width, height, fps)).toBe(hevc);
    expect(lowest('vp9', width, height, fps)).toBe(vp9);
  });

  it('lists every admitting level, lowest first, so an encoder that lacks the lowest can take the next', () => {
    expect(admittingLevels('h264', { width: 1920, height: 1080, framerate: 30 })).toEqual([40, 41, 42, 50, 51, 52, 60, 61, 62]);
    expect(admittingLevels('hevc', { width: 3840, height: 2160, framerate: 30 })).toEqual([150, 153, 156, 180, 183, 186]);
    expect(admittingLevels('vp9', { width: 1920, height: 1080, framerate: 30 })).toEqual([40, 41, 50, 51, 52, 60, 61, 62]);
  });

  it('applies the picture-width limit of Sqrt(MaxPicture * 8), not only the area', () => {
    // 8192x64 has the area of a 720p-class picture but is wider than the levels below 5 allow
    expect(lowest('h264', 8192, 64, 30)).toBe(51);
    expect(lowest('hevc', 8192, 64, 30)).toBe(150);
    expect(lowest('vp9', 8192, 64, 30)).toBe(50);
  });

  it('rounds the H.264 picture up to whole macroblocks', () => {
    // 1280x720 is exactly 3600 macroblocks (level 3.1); one more row of pixels needs a 46th macroblock row
    expect(lowest('h264', 1280, 721, 30)).toBe(32);
  });

  it('throws for a picture no level admits, and for a size or rate that is not a positive number', () => {
    const tooLarge = { width: 16384, height: 16384, framerate: 30 };
    for (const family of ['h264', 'hevc', 'vp9'] as const) {
      expect(() => admittingLevels(family, tooLarge)).toThrow(EdgeUnsupportedError);
    }
    expect(() => admittingLevels('h264', tooLarge)).toThrow(/No H\.264 level admits 16384x16384 at 30 frames per second/);
    expect(() => admittingLevels('vp9', { width: 1920, height: 1080, framerate: 100_000 })).toThrow(/No VP9 level admits/);
    expect(() => admittingLevels('h264', { width: 0, height: 1080, framerate: 30 })).toThrow(/frame size/);
    expect(() => admittingLevels('h264', { width: 1920, height: 1080, framerate: Number.NaN })).toThrow(/frame rate/);
    expect(() => admittingLevels('h264', { width: 1920, height: 1080, framerate: 0 })).toThrow(/frame rate/);
  });

  it('writes the codec strings of the requests: Main profile H.264, main-tier HEVC', () => {
    const demand = { width: 1920, height: 1080, framerate: 30 };
    expect(levelCodecStrings('h264', demand, {})[0]).toBe('avc1.4d0028');
    expect(levelCodecStrings('hevc', demand, {})[0]).toBe('hvc1.1.6.L120.B0');
    expect(levelCodecStrings('h264', { width: 640, height: 360, framerate: 25 }, {})[0]).toBe('avc1.4d001e');
  });

  it('tells the muxer whether a VP9 level holds a picture of this size', () => {
    expect(vp9LevelAdmitsPicture(10, 64, 48)).toBe(true);
    expect(vp9LevelAdmitsPicture(10, 1920, 1080)).toBe(false);
    expect(vp9LevelAdmitsPicture(40, 1920, 1080)).toBe(true);
    expect(vp9LevelAdmitsPicture(40, 8192, 64)).toBe(false);
    expect(vp9LevelAdmitsPicture(0, 64, 48)).toBe(false);
    expect(vp9LevelAdmitsPicture(25, 64, 48)).toBe(false);
  });
});

describe('the VP9 codec string of a source', () => {
  const BT709 = { primaries: 1, transfer: 1, matrix: 1, fullRange: false };

  it('takes the profile from bit depth and chroma, and states the source colour', () => {
    expect(vp9CodecString(31, { bitDepth: 8, chroma: 'yuv420', colour: BT709 })).toBe('vp09.00.31.08.01.01.01.01.00');
    expect(vp9CodecString(31, { bitDepth: 8, chroma: 'yuv444', colour: BT709 })).toBe('vp09.01.31.08.03.01.01.01.00');
    expect(vp9CodecString(31, { bitDepth: 8, chroma: 'yuv422' })).toBe('vp09.01.31.08.02.02.02.02.00');
    expect(vp9CodecString(31, { bitDepth: 10, chroma: 'yuv420', colour: { primaries: 9, transfer: 16, matrix: 9, fullRange: false } })).toBe(
      'vp09.02.31.10.01.09.16.09.00'
    );
    expect(vp9CodecString(31, { bitDepth: 12, chroma: 'yuv444', colour: { ...BT709, fullRange: true } })).toBe('vp09.03.31.12.03.01.01.01.01');
    expect(vp9CodecString(50, { bitDepth: 10, chroma: 'yuv422' })).toBe('vp09.03.50.10.02.02.02.02.00');
  });

  it('states unspecified colour (code point 2) when the source states none', () => {
    expect(vp9CodecString(10, { bitDepth: 8, chroma: 'yuv420' })).toBe('vp09.00.10.08.01.02.02.02.00');
  });

  it('throws when the source does not say what its pictures are, instead of assuming 8-bit 4:2:0', () => {
    expect(() => vp9CodecString(31, {})).toThrow(EdgeUnsupportedError);
    expect(() => vp9CodecString(31, { bitDepth: 8 })).toThrow(/does not state the bit depth and chroma layout/);
    expect(() => vp9CodecString(31, { chroma: 'yuv420' })).toThrow(/does not state the bit depth and chroma layout/);
  });

  it('throws for a bit depth VP9 has no profile for, and for a chroma layout vpcC cannot name', () => {
    expect(() => vp9CodecString(31, { bitDepth: 9, chroma: 'yuv420' })).toThrow(/no 9-bit profile/);
    expect(() => vp9CodecString(31, { bitDepth: 16, chroma: 'yuv420' })).toThrow(/no 16-bit profile/);
    expect(() => vp9CodecString(31, { bitDepth: 8, chroma: 'mono' })).toThrow(/cannot state mono pictures/);
    expect(() => vp9CodecString(31, { bitDepth: 8, chroma: 'yuv440' })).toThrow(/cannot state yuv440 pictures/);
  });
});

// ---------------------------------------------------------------------------------------------------
// The reference encoders choose levels from the same limits: they judge the table
// ---------------------------------------------------------------------------------------------------

/** Sizes and rates whose lowest level the reference encoders and the reference muxer settle the same way. */
const REFERENCE_CASES = [
  { width: 176, height: 144, fps: 15 },
  { width: 352, height: 288, fps: 30 },
  { width: 640, height: 480, fps: 30 },
  { width: 1280, height: 720, fps: 30 },
  { width: 1280, height: 720, fps: 60 },
  { width: 1920, height: 1080, fps: 30 },
  { width: 1920, height: 1080, fps: 60 },
  { width: 3840, height: 2160, fps: 30 },
];
const REFERENCE_TIMEOUT_MS = 60_000;
const VP9_ORACLE_MAX_FPS = 30;
const FRAMES_PER_CLIP = 0.4;

function levelOf(extension: string, width: number, height: number, fps: number, codecArgs: string[]): number {
  const clip = runFfmpeg([...testPatternInput({ width, height, fps, seconds: FRAMES_PER_CLIP }), ...codecArgs], extension);
  const level = ffprobeReport(new Uint8Array(clip), extension).streams[0].level;
  if (level === undefined) throw new Error('ffprobe reported no level');
  return level;
}

describe('the level table against the reference encoders', () => {
  for (const { width, height, fps } of REFERENCE_CASES) {
    const label = `${width}x${height} at ${fps} fps`;

    oracleTest(`H.264 ${label}: the level libx264 picks`, ['ffmpeg', 'ffprobe'], () => {
      requireEncoders('libx264');
      const reference = levelOf('mp4', width, height, fps, ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-bf', '0']);
      expect(lowest('h264', width, height, fps)).toBe(reference);
    }, REFERENCE_TIMEOUT_MS);

    oracleTest(`HEVC ${label}: the level libx265 picks`, ['ffmpeg', 'ffprobe'], () => {
      requireEncoders('libx265');
      const reference = levelOf('mp4', width, height, fps, ['-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=none']);
      expect(lowest('hevc', width, height, fps)).toBe(reference);
    }, REFERENCE_TIMEOUT_MS);

    // The reference muxer writes vpcC before it knows the clip's frame rate and does not follow it above 30 fps
    // (it gives 720p at 60 fps level 3.1, which holds 40 fps), so the VP9 oracle covers the rates it does follow.
    if (fps > VP9_ORACLE_MAX_FPS) continue;
    oracleTest(`VP9 ${label}: the level the reference muxer writes into vpcC`, ['ffmpeg', 'ffprobe'], () => {
      requireEncoders('libvpx-vp9');
      const clip = runFfmpeg(
        [
          ...testPatternInput({ width, height, fps, seconds: FRAMES_PER_CLIP }),
          '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-deadline', 'realtime', '-cpu-used', '8', '-auto-alt-ref', '0', '-f', 'mp4',
        ],
        'mp4'
      );
      // vpcC: version, flags(3), profile, level
      const VPCC_LEVEL_OFFSET = 5;
      expect(lowest('vp9', width, height, fps)).toBe(extractVpcC(new Uint8Array(clip))[VPCC_LEVEL_OFFSET]);
    }, REFERENCE_TIMEOUT_MS);
  }
});
