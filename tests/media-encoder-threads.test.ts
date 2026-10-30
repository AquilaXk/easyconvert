import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildFfmpegArguments, buildTwoPassArguments } from '../src/lib/conversions/media-ffmpeg-args';
import { softwareEncoderThreads } from '../src/lib/conversions/media-encoder-threads';
import { getOracleToolPath } from './helpers/differential-oracle';
import { requireEncoders } from './helpers/ffmpeg-media-fixtures';
import { measureSsimPsnr } from './helpers/ffmpeg-measure';
import { oracleTest } from './helpers/oracle-test';
import { openMediaInput } from '../src/lib/conversions/media-process';

/**
 * Threads of the software H.264 and H.265 encoders. Left to the encoders, x264 limits itself by the picture height
 * (a 240-line picture gets about half the threads the host offers) and x265 starts three frame threads on a
 * 12-core host; both leave cores idle on the clip sizes most jobs have. The count asked for here depends on the host
 * and the codec only, and the encoded picture is judged against the reference encoder run with its own defaults.
 */

const TEST_TIMEOUT_MS = 240_000;
const SIZE = '320x240';
const SECONDS = 1;
const CRF = 26;
const PSNR_TOLERANCE_DB = 0.1;
const SSIM_TOLERANCE = 0.001;
/** x264 wrote the same bytes at its own and at sixteen threads in every run measured (one byte apart in 214,896), so its row stays tight. */
const X264_BYTES_TOLERANCE = 0.01;
/**
 * x265 does not promise the same bytes at two frame-thread counts: now and then, more often on a loaded host, one frame
 * of a clip is written with another type or QP (4 s clip at six threads: 7 of 1920 runs differed; 2 s: 3 of 640; 8 s: 1 of 960;
 * a 1 s run on a CI runner came out 10% larger). How far one such frame moves the size or the PSNR falls with the length of the
 * clip: the largest gap to the reference at two threads was +14.6% and +0.6 dB at 2 s, +2.7% and -0.10 dB at 4 s, and
 * +0.26% and -0.02 dB at 8 s. At eight seconds five percent keeps a margin of three over the 1.4% the 4 s worst case halves
 * to, and stays under the 10% by which one step of CRF changes the size, so a drifted quality target still fails.
 */
const COMPARISON_SECONDS = 8;
const X265_BYTES_TOLERANCE = 0.05;

describe('the thread count asked of each software encoder', () => {
  it.each([
    // [cores, height, expected]: x264 limits itself to hostThreads = cores * 3 / 2 and to one thread per two macroblock rows.
    { cores: 12, height: 240, expected: 16 },
    { cores: 12, height: 480, expected: 16 },
    { cores: 12, height: 496, expected: 16 },
    { cores: 12, height: 504, expected: undefined },
    { cores: 12, height: 720, expected: undefined },
    { cores: 12, height: 1080, expected: undefined },
    { cores: 8, height: 240, expected: 12 },
    { cores: 4, height: 240, expected: undefined },
    { cores: 2, height: 144, expected: undefined },
    { cores: 64, height: 240, expected: 16 },
    { cores: 1, height: 240, expected: undefined },
  ])('x264 with $cores cores on $height lines: $expected', ({ cores, height, expected }) => {
    expect(softwareEncoderThreads('h264', { width: height * 2, height }, cores)).toBe(expected);
  });

  it('x264 takes the shorter side of the picture, which a display rotation may turn into its height', () => {
    expect(softwareEncoderThreads('h264', { width: 240, height: 1920 }, 12)).toBe(16);
    expect(softwareEncoderThreads('h264', { width: 1920, height: 1080 }, 12)).toBeUndefined();
  });

  it('x264 is left to choose when the picture is not known', () => {
    expect(softwareEncoderThreads('h264', undefined, 12)).toBeUndefined();
  });

  it.each([
    // Under four cores x265's own count (one) is already all the host can use; from four cores up the frame
    // threads keep the wavefronts of a short picture fed, so six are asked for on any host of four cores or more.
    { cores: 1, hevc: 1 },
    { cores: 2, hevc: 1 },
    { cores: 3, hevc: 1 },
    { cores: 4, hevc: 6 },
    { cores: 6, hevc: 6 },
    { cores: 8, hevc: 6 },
    { cores: 12, hevc: 6 },
    { cores: 16, hevc: 6 },
    { cores: 192, hevc: 6 },
  ])('x265 on a host with $cores cores: $hevc frame threads, whatever the picture', ({ cores, hevc }) => {
    expect(softwareEncoderThreads('hevc', undefined, cores)).toBe(hevc);
    expect(softwareEncoderThreads('hevc', { width: 3840, height: 2160 }, cores)).toBe(hevc);
  });

  it('asks nothing for a codec whose encoder sizes its own threads', () => {
    for (const codec of ['vp9', 'av1', 'prores']) {
      expect(softwareEncoderThreads(codec, { width: 320, height: 240 }, 12)).toBeUndefined();
    }
  });
});

/** A 320x240 clip made once for every test that needs a real input, and a longer one for the pictures compared against the reference encoder. */
let workDir: string;
let source: string;
let comparisonSource: string;

function tool(): string {
  const found = getOracleToolPath('ffmpeg');
  if (found === null) throw new Error('ffmpeg is not installed');
  return found;
}

function makeSource(file: string = source, seconds: number = SECONDS): void {
  if (fs.existsSync(file)) return;
  requireEncoders('libx264');
  execFileSync(tool(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${SIZE}:rate=24:duration=${seconds}`, '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', file], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-threads-'));
  source = path.join(workDir, 'source.mp4');
  comparisonSource = path.join(workDir, 'comparison-source.mp4');
});
afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('the arguments of a software encode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function build(codec: string, video: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): string[] {
    makeSource();
    return buildFfmpegArguments(openMediaInput(source, 'mp4'), path.join(workDir, 'out.mp4'), 'mp4', { disableHwaccel: true, video: { codec, ...video }, ...extra } as never, tool());
  }

  function threadsOf(args: string[]): string[] {
    return args.flatMap((arg, i) => (arg === '-threads' ? [args[i + 1]] : []));
  }

  oracleTest(
    'give x264 the threads of the host for a short picture, once, as an output option',
    ['ffmpeg'],
    () => {
      vi.spyOn(os, 'availableParallelism').mockReturnValue(12);
      const args = build('h264');
      expect(threadsOf(args)).toEqual(['16']);
      expect(args.indexOf('-threads')).toBeGreaterThan(args.indexOf('libx264'));
      expect(args.indexOf('-threads')).toBeGreaterThan(args.indexOf('-i'));
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'leave x264 to choose on a host with as many cores as it can use, and when a filter changes the size',
    ['ffmpeg'],
    () => {
      vi.spyOn(os, 'availableParallelism').mockReturnValue(4);
      expect(threadsOf(build('h264'))).toEqual([]);
      vi.spyOn(os, 'availableParallelism').mockReturnValue(12);
      expect(threadsOf(build('h264', { scale: { width: 160, height: 120 } }))).toEqual([]);
      expect(threadsOf(build('h264', {}, { aspectRatio: '1:1' }))).toEqual([]);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'give x265 its frame threads for a constant-quality encode',
    ['ffmpeg'],
    () => {
      for (const cores of [4, 12]) {
        vi.spyOn(os, 'availableParallelism').mockReturnValue(cores);
        expect(threadsOf(build('hevc', { rateControl: { mode: 'crf', crf: 28 } })), `${cores} cores`).toEqual(['6']);
        expect(threadsOf(build('hevc')), `${cores} cores`).toEqual(['6']);
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'leave both encoders to choose when a bitrate holds the rate, where more threads weaken the estimate',
    ['ffmpeg'],
    () => {
      vi.spyOn(os, 'availableParallelism').mockReturnValue(12);
      for (const codec of ['h264', 'hevc']) {
        expect(threadsOf(build(codec, { rateControl: { mode: 'vbr', bitrateK: 800 } }))).toEqual([]);
        expect(threadsOf(build(codec, { rateControl: { mode: 'crf', crf: 28, maxBitrateK: 900 } }))).toEqual([]);
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'add no thread option to a VP9 encode',
    ['ffmpeg'],
    () => {
      vi.spyOn(os, 'availableParallelism').mockReturnValue(12);
      expect(threadsOf(build('vp9'))).toEqual([]);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'add no thread option to either pass of a two-pass encode, whose passes must agree',
    ['ffmpeg'],
    () => {
      makeSource();
      vi.spyOn(os, 'availableParallelism').mockReturnValue(12);
      for (const codec of ['h264', 'hevc']) {
        const passes = buildTwoPassArguments(
          openMediaInput(source, 'mp4'), path.join(workDir, 'out.mp4'), 'mp4',
          { disableHwaccel: true, video: { codec, rateControl: { mode: 'vbr', bitrateK: 800, twoPass: true } } } as never,
          tool(), 'pass'
        );
        expect(passes).toHaveLength(2);
        for (const pass of passes) {
          expect(pass).toContain(codec === 'h264' ? 'libx264' : 'libx265');
          expect(threadsOf(pass)).toEqual([]);
        }
      }
    },
    TEST_TIMEOUT_MS
  );
});

describe('the threads the encoders really start', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Our arguments for `input`, run at info level so the encoder reports the thread counts it started. */
  function ourRun(codec: 'h264' | 'hevc', output: string, input: string = source): string {
    const args = buildFfmpegArguments(openMediaInput(input, 'mp4'), output, 'mp4', { disableHwaccel: true, video: { codec, rateControl: { mode: 'crf', crf: CRF } } }, tool());
    const run = spawnSync(tool(), ['-hide_banner', '-nostdin', '-loglevel', 'info', ...args], { encoding: 'utf8' });
    if (run.status !== 0) throw new Error(run.stderr);
    return run.stderr;
  }

  oracleTest(
    'x264 starts the threads asked for, and x265 starts that many frame threads',
    ['ffmpeg'],
    () => {
      requireEncoders('libx264', 'libx265');
      makeSource();
      // A host of 12 cores is assumed whatever this one is, so the counts asked for do not depend on the machine.
      vi.spyOn(os, 'availableParallelism').mockReturnValue(12);
      const x264Log = ourRun('h264', path.join(workDir, 'ours-h264.mp4'));
      expect(x264Log).toMatch(/ threads=16 lookahead_threads=\d+ /);
      const x265Log = ourRun('hevc', path.join(workDir, 'ours-hevc.mp4'));
      expect(x265Log).toMatch(/frame threads \/ pool features\s*: 6 \//);
    },
    TEST_TIMEOUT_MS
  );

  /** The decoded pictures of `ours` must be no worse against `input` than the reference's, and its size within `bytesTolerance`. */
  function expectPictureAndSizeOf(ours: string, reference: string, input: string, bytesTolerance: number): void {
    const oursQuality = measureSsimPsnr(tool(), ours, input);
    const referenceQuality = measureSsimPsnr(tool(), reference, input);
    expect(oursQuality.psnr).toBeGreaterThanOrEqual(referenceQuality.psnr - PSNR_TOLERANCE_DB);
    expect(oursQuality.ssim).toBeGreaterThanOrEqual(referenceQuality.ssim - SSIM_TOLERANCE);
    expect(Math.abs(fs.statSync(ours).size - fs.statSync(reference).size) / fs.statSync(reference).size).toBeLessThan(bytesTolerance);
  }

  oracleTest(
    'x265 at six frame threads gives the picture quality and size of the two it starts on a host of four cores',
    ['ffmpeg'],
    () => {
      requireEncoders('libx265');
      makeSource(comparisonSource, COMPARISON_SECONDS);
      vi.spyOn(os, 'availableParallelism').mockReturnValue(4);
      const ours = path.join(workDir, 'threads-ours.mp4');
      ourRun('hevc', ours, comparisonSource);
      const reference = path.join(workDir, 'threads-ref.mp4');
      execFileSync(
        tool(),
        ['-v', 'error', '-y', '-i', comparisonSource, '-c:v', 'libx265', '-preset', 'medium', '-x265-params', 'log-level=error', '-threads', '2', '-crf', String(CRF), '-pix_fmt', 'yuv420p', '-an', reference],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      );
      const framesOf = (file: string): number =>
        execFileSync(tool(), ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'framemd5', '-'], { encoding: 'utf8' })
          .split('\n')
          .filter((line) => line !== '' && !line.startsWith('#')).length;
      expect(framesOf(ours)).toBe(framesOf(reference));
      expect(framesOf(ours)).toBeGreaterThanOrEqual(COMPARISON_SECONDS * 24);
      // Not frame for frame: x265 does not promise the same bytes at two frame-thread counts, and on a busy host one frame in a
      // clip is now and then written with another type or QP (the md5 of the decoded frames then differs in that frame alone).
      // The clip is long enough that such a frame moves the size by a fraction of X265_BYTES_TOLERANCE, and the pictures are
      // judged against the source, the way the other encoder rows of this file are.
      expectPictureAndSizeOf(ours, reference, comparisonSource, X265_BYTES_TOLERANCE);
    },
    TEST_TIMEOUT_MS
  );

  for (const row of [
    { codec: 'h264' as const, reference: ['-c:v', 'libx264', '-preset', 'medium'], bytesTolerance: X264_BYTES_TOLERANCE },
    { codec: 'hevc' as const, reference: ['-c:v', 'libx265', '-preset', 'medium', '-x265-params', 'log-level=error'], bytesTolerance: X265_BYTES_TOLERANCE },
  ]) {
    oracleTest(
      `${row.codec}: the picture and size are the reference encoder's at its own thread defaults`,
      ['ffmpeg', 'ffprobe'],
      () => {
        requireEncoders('libx264', 'libx265');
        makeSource(comparisonSource, COMPARISON_SECONDS);
        vi.spyOn(os, 'availableParallelism').mockReturnValue(12);
        const ours = path.join(workDir, `quality-${row.codec}.mp4`);
        ourRun(row.codec, ours, comparisonSource);
        const reference = path.join(workDir, `quality-ref-${row.codec}.mp4`);
        execFileSync(tool(), ['-v', 'error', '-y', '-i', comparisonSource, ...row.reference, '-crf', String(CRF), '-pix_fmt', 'yuv420p', '-an', reference], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        expectPictureAndSizeOf(ours, reference, comparisonSource, row.bytesTolerance);
      },
      TEST_TIMEOUT_MS
    );
  }
});
