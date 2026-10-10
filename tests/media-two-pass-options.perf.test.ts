import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';
import { requireEncoders } from './helpers/ffmpeg-media-fixtures';
import { listBoxes } from './helpers/iso-bmff-walker';
import { amplitudeSpectrum, toDb } from './helpers/audio-spectrum';
import { decodeAudioStream, measureSsimPsnr, probeFile, recordMetric } from './helpers/ffmpeg-measure';
import { VIDEO_MIN_SSIM } from './oracles/product/media-oracle';
import {
  buildFfmpegArguments,
  buildTwoPassArguments,
  isTwoPassRequested,
  resetHardwareAccelerationCache,
} from '../src/lib/conversions/media-ffmpeg-args';
import { MIN_PASS_TIMEOUT_MS, runTwoPass, TWO_PASS_LOG_PREFIX, twoPassBudgetMs } from '../src/lib/conversions/media-two-pass';
import { convertMedia } from '../src/lib/conversions/media';
import { ConversionOptionsSchema } from '../src/lib/api/contracts/schemas';
import { validateOrProblem } from '../src/lib/api/contracts/validate';
import { ConversionFailedError, InvalidMediaOptionError } from '../src/lib/types';

/**
 * Two-pass encoding, the output-side duration, fast start, aspect ratio, a real-signal downmix check and a
 * pixel check of burned-in subtitles. Oracles: ffprobe packets and stream data, an independent ISO BMFF box
 * walker, decoded pixels and an FFT of a decoded tone. Nothing is taken from the module under test.
 */

const ENCODE_TIMEOUT_MS = 240_000;
const SOURCE = '/nonexistent/in.mp4';
const OUT = '/tmp/out.mp4';

function ffmpeg(): string {
  return requireOracleTool('ffmpeg');
}
function ffprobe(): string {
  return requireOracleTool('ffprobe');
}

function after(list: string[], flag: string): string {
  return list[list.indexOf(flag) + 1];
}

async function withDir<T>(run: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'two-pass-options-'));
  try {
    return await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Entries of the temp directory that a pass log or its job directory would leave behind. */
function leftoverPassFiles(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('easyconvert_pass_') || name.startsWith(TWO_PASS_LOG_PREFIX));
}

/** Source with detail and noise, so a 1000 kbit/s target is neither trivial nor impossible. */
function noisyClip(dir: string, size: string, seconds: number, name = 'noisy.mp4'): string {
  requireEncoders('libx264');
  const out = path.join(dir, name);
  execFileSync(ffmpeg(), [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=25:duration=${seconds}`,
    '-vf', 'noise=alls=20:allf=t', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', out,
  ]);
  return out;
}

/** Video payload rate in kbit/s: the sum of the packet sizes over the clip duration. */
function videoKbps(file: string, seconds: number): number {
  const out = execFileSync(ffprobe(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=size', '-of', 'csv=p=0', file], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const bits = out.split('\n').filter((l) => l !== '').reduce((sum, l) => sum + Number(l.split(',')[0]) * 8, 0);
  return bits / seconds / 1000;
}

describe('two-pass arguments', () => {
  const vbr = (extra: object = {}, codec = 'h264') => ({
    disableHwaccel: true,
    video: { codec, rateControl: { mode: 'vbr', bitrateK: 1000, twoPass: true } },
    ...extra,
  });

  it('builds an analysing pass with no audio and a null sink, and an encode pass that reads its log', () => {
    const [pass1, pass2] = buildTwoPassArguments(SOURCE, OUT, 'mp4', 'mp4', vbr() as never, null, TWO_PASS_LOG_PREFIX);
    expect(pass1.slice(-3)).toEqual(['-f', 'null', os.devNull]);
    expect(after(pass1, '-pass')).toBe('1');
    expect(after(pass1, '-passlogfile')).toBe('ffpass');
    expect(pass1).toContain('-an');
    expect(pass1.indexOf('-c:a')).toBe(-1);
    expect(pass1.indexOf('-movflags')).toBe(-1);
    expect(pass1.indexOf(OUT)).toBe(-1);
    expect(after(pass1, '-b:v')).toBe('1000k');

    expect(after(pass2, '-pass')).toBe('2');
    expect(after(pass2, '-passlogfile')).toBe('ffpass');
    expect(pass2[pass2.length - 1]).toBe(OUT);
    expect(after(pass2, '-c:a')).toBe('aac');
    expect(after(pass2, '-b:v')).toBe('1000k');
    expect(after(pass2, '-movflags')).toBe('+faststart');
    // The passes encode the same picture: the same filter graph, encoder and rate.
    expect(after(pass1, '-vf')).toBe(after(pass2, '-vf'));
    expect(after(pass1, '-c:v')).toBe(after(pass2, '-c:v'));
  });

  it('gives x265 its pass and stats file as parameters and VP9 the ffmpeg pass options', () => {
    const [h1, h2] = buildTwoPassArguments(SOURCE, OUT, 'mp4', 'mp4', vbr({}, 'hevc') as never, null, TWO_PASS_LOG_PREFIX);
    expect(after(h1, '-x265-params')).toBe('pass=1:stats=ffpass');
    expect(after(h2, '-x265-params')).toBe('pass=2:stats=ffpass');
    expect(h1.indexOf('-pass')).toBe(-1);
    const [v1, v2] = buildTwoPassArguments(SOURCE, '/tmp/out.webm', 'mp4', 'webm', vbr({}, 'vp9') as never, null, TWO_PASS_LOG_PREFIX);
    expect([after(v1, '-pass'), after(v2, '-pass')]).toEqual(['1', '2']);
    expect(after(v1, '-c:v')).toBe('libvpx-vp9');
    expect(v1.indexOf('-crf')).toBe(-1);
  });

  it('is an InvalidMediaOptionError for a mode, codec or target with no rate-control pass', () => {
    const build = (options: object, tgt = 'mp4') => () =>
      buildTwoPassArguments(SOURCE, `/tmp/out.${tgt}`, 'mp4', tgt, options as never, null, TWO_PASS_LOG_PREFIX);
    const crf = { disableHwaccel: true, video: { codec: 'h264', rateControl: { mode: 'crf', crf: 23, twoPass: true } } };
    const cbr = { disableHwaccel: true, video: { codec: 'h264', rateControl: { mode: 'cbr', bitrateK: 1000, twoPass: true } } };
    expect(build(crf)).toThrow(InvalidMediaOptionError);
    expect(build(crf)).toThrow(/needs rateControl.mode 'vbr'/);
    expect(build(cbr)).toThrow(/needs rateControl.mode 'vbr'/);
    expect(build(vbr({}, 'av1'))).toThrow(/h264, hevc and vp9/);
    expect(build(vbr({}, 'prores'), 'mov')).toThrow(InvalidMediaOptionError);
    expect(build(vbr(), 'avi')).toThrow(InvalidMediaOptionError);
    expect(build(vbr(), 'mp3')).toThrow(/video targets/);
    expect(() => buildTwoPassArguments(SOURCE, OUT, 'mp4', 'mp4', { video: { rateControl: { mode: 'vbr', bitrateK: 1000 } } }, null, TWO_PASS_LOG_PREFIX)).toThrow(
      /without rateControl.twoPass/
    );
    expect(() => isTwoPassRequested({ video: { rateControl: { mode: 'vbr', bitrateK: 1000, twoPass: 'yes' as never } } })).toThrow(InvalidMediaOptionError);
    expect(() => buildTwoPassArguments(SOURCE, OUT, 'mp4', 'mp4', vbr() as never, null, '../escape')).toThrow(ConversionFailedError);
  });

  it('never runs a twoPass request as a single pass', () => {
    expect(() => buildFfmpegArguments(SOURCE, OUT, 'mp4', 'mp4', vbr() as never)).toThrow(/both passes/);
  });

  it('selects a software encoder for two-pass even on a host that offers a hardware one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-nvenc-'));
    try {
      const fake = path.join(dir, 'ffmpeg');
      // Lists the NVENC encoders and exits 0 for every other call, so the capability probe finds a working GPU.
      fs.writeFileSync(fake, '#!/bin/sh\ncase "$*" in\n  *-encoders*) echo " V....D libx264              libx264"; echo " V....D h264_nvenc           NVENC H.264";;\nesac\nexit 0\n');
      fs.chmodSync(fake, 0o755);
      resetHardwareAccelerationCache();
      const singlePass = buildFfmpegArguments(SOURCE, OUT, 'mp4', 'mp4', { video: { codec: 'h264', rateControl: { mode: 'vbr', bitrateK: 1000 } } }, fake);
      expect(after(singlePass, '-c:v')).toBe('h264_nvenc');
      const [pass1, pass2] = buildTwoPassArguments(
        SOURCE, OUT, 'mp4', 'mp4', { video: { codec: 'h264', rateControl: { mode: 'vbr', bitrateK: 1000, twoPass: true } } }, fake, TWO_PASS_LOG_PREFIX
      );
      expect([after(pass1, '-c:v'), after(pass2, '-c:v')]).toEqual(['libx264', 'libx264']);
    } finally {
      resetHardwareAccelerationCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts both passes against one budget, doubled, with a floor for the second', async () => {
    expect(twoPassBudgetMs(90_000)).toBe(180_000);
    const seen: Array<{ args: string[]; timeoutMs: number }> = [];
    let clock = 0;
    await runTwoPass([['one'], ['two']], 180_000, async (args, timeoutMs) => {
      seen.push({ args, timeoutMs });
      clock += 50_000;
    }, () => clock);
    expect(seen).toEqual([
      { args: ['one'], timeoutMs: 180_000 },
      { args: ['two'], timeoutMs: 130_000 },
    ]);
    // A spent budget leaves the second pass the floor, never zero or a negative limit.
    clock = 0;
    const spent: number[] = [];
    await runTwoPass([['one'], ['two']], 10_000, async (_args, timeoutMs) => {
      spent.push(timeoutMs);
      clock += 60_000;
    }, () => clock);
    expect(spent).toEqual([10_000, MIN_PASS_TIMEOUT_MS]);
    // A failed analysing pass stops the job before the encode.
    const ran: string[] = [];
    await expect(
      runTwoPass([['one'], ['two']], 1000, async (args) => {
        ran.push(args[0]);
        throw new Error('analysis failed');
      })
    ).rejects.toThrow('analysis failed');
    expect(ran).toEqual(['one']);
  });
});

describe('two-pass encoding (decoded output)', () => {
  const TARGET_KBPS = 1000;
  const CLIP_SECONDS = 20;
  /** The brief's acceptance band around the target rate. */
  const RATE_TOLERANCE = 0.1;
  /** Two-pass may score a hair under single pass on SSIM while spending its bits where they matter; 0.01 bounds that. */
  const SSIM_NO_WORSE_MARGIN = 0.01;
  /** A 1 Mbit/s encode of noise cannot reproduce the noise (measured SSIM 0.44); this floor only rejects garbage. */
  const NOISY_SOURCE_MIN_SSIM = 0.3;

  oracleTest(
    'two-pass VBR at 1000 kbit/s on a 20 s clip lands within 10% of the target and closer than single pass',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withDir(async (dir) => {
        const source = noisyClip(dir, '640x360', CLIP_SECONDS);
        const encode = async (twoPass: boolean) => {
          const result = await convertMedia(
            fs.readFileSync(source), 'mp4', 'mp4',
            { video: { codec: 'h264', rateControl: { mode: 'vbr', bitrateK: TARGET_KBPS, twoPass } } },
            'noisy.mp4'
          );
          const out = path.join(dir, twoPass ? 'two.mp4' : 'one.mp4');
          fs.writeFileSync(out, result.buffer);
          return out;
        };
        const before = leftoverPassFiles();
        const single = await encode(false);
        const double = await encode(true);
        const singleKbps = videoKbps(single, CLIP_SECONDS);
        const doubleKbps = videoKbps(double, CLIP_SECONDS);
        recordMetric('two-pass h264 1000 kbit/s: single-pass kbit/s', singleKbps);
        recordMetric('two-pass h264 1000 kbit/s: two-pass kbit/s', doubleKbps);
        expect(Math.abs(doubleKbps / TARGET_KBPS - 1)).toBeLessThanOrEqual(RATE_TOLERANCE);
        expect(Math.abs(doubleKbps - TARGET_KBPS)).toBeLessThan(Math.abs(singleKbps - TARGET_KBPS));
        // At the same bitrate the second pass is no worse than the first-and-only one. (The source is noise: at
        // 1 Mbit/s both score about 0.44 against it, so the comparison is between the two encodes, not a floor.)
        const singleSsim = measureSsimPsnr(ffmpeg(), single, source).ssim;
        const doubleSsim = measureSsimPsnr(ffmpeg(), double, source).ssim;
        recordMetric('two-pass h264 1000 kbit/s: single-pass ssim', singleSsim);
        recordMetric('two-pass h264 1000 kbit/s: two-pass ssim', doubleSsim);
        expect(doubleSsim).toBeGreaterThanOrEqual(singleSsim - SSIM_NO_WORSE_MARGIN);
        expect(doubleSsim).toBeGreaterThanOrEqual(NOISY_SOURCE_MIN_SSIM);
        // No pass log or job directory is left behind.
        expect(leftoverPassFiles()).toEqual(before);
        // The audio-less source stays audio-less, and both streams of the result decode.
        const probed = probeFile(ffprobe(), double);
        expect(probed.streams.map((s) => s.codec_type)).toEqual(['video']);
      });
    },
    ENCODE_TIMEOUT_MS
  );

  oracleTest(
    'two-pass at 1000 kbit/s on a clean 640x360 clip matches the source (SSIM) and still hits the rate',
    ['ffmpeg', 'ffprobe'],
    async () => {
      requireEncoders('libx264');
      await withDir(async (dir) => {
        const seconds = 6;
        const source = path.join(dir, 'clean.mp4');
        execFileSync(ffmpeg(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=25:duration=${seconds}`, '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', source]);
        const result = await convertMedia(
          fs.readFileSync(source), 'mp4', 'mp4',
          { video: { codec: 'h264', rateControl: { mode: 'vbr', bitrateK: TARGET_KBPS, twoPass: true } } },
          'clean.mp4'
        );
        const out = path.join(dir, 'clean_out.mp4');
        fs.writeFileSync(out, result.buffer);
        const measured = measureSsimPsnr(ffmpeg(), out, source);
        recordMetric('two-pass h264 1000 kbit/s on a clean clip: ssim', measured.ssim);
        recordMetric('two-pass h264 1000 kbit/s on a clean clip: psnr dB', measured.psnr);
        expect(measured.ssim).toBeGreaterThanOrEqual(VIDEO_MIN_SSIM);
        expect(Math.abs(videoKbps(out, seconds) / TARGET_KBPS - 1)).toBeLessThanOrEqual(RATE_TOLERANCE);
      });
    },
    ENCODE_TIMEOUT_MS
  );

  for (const { codec, target, tgt } of [
    { codec: 'hevc', target: 'x265', tgt: 'mp4' },
    { codec: 'vp9', target: 'libvpx-vp9', tgt: 'webm' },
  ]) {
    oracleTest(
      `two-pass ${target} reaches the target rate within 10% and leaves no pass log`,
      ['ffmpeg', 'ffprobe'],
      async () => {
        requireEncoders(codec === 'hevc' ? 'libx265' : 'libvpx-vp9');
        await withDir(async (dir) => {
          const seconds = 6;
          const source = noisyClip(dir, '640x360', seconds);
          const before = leftoverPassFiles();
          const result = await convertMedia(
            fs.readFileSync(source), 'mp4', tgt,
            { video: { codec, rateControl: { mode: 'vbr', bitrateK: TARGET_KBPS, twoPass: true } } } as never,
            'noisy.mp4'
          );
          const out = path.join(dir, `out.${tgt}`);
          fs.writeFileSync(out, result.buffer);
          const kbps = videoKbps(out, seconds);
          recordMetric(`two-pass ${target}: kbit/s against a ${TARGET_KBPS} target`, kbps);
          expect(Math.abs(kbps / TARGET_KBPS - 1)).toBeLessThanOrEqual(RATE_TOLERANCE);
          expect(leftoverPassFiles()).toEqual(before);
        });
      },
      ENCODE_TIMEOUT_MS
    );
  }

  oracleTest(
    'twoPass with a CRF rate or an AV1 target answers a typed 400-class error before any encode, and leaves nothing behind',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withDir(async (dir) => {
        const source = fs.readFileSync(noisyClip(dir, '160x90', 1));
        const before = leftoverPassFiles();
        const crf = await convertMedia(source, 'mp4', 'mp4', { video: { codec: 'h264', rateControl: { mode: 'crf', crf: 23, twoPass: true } } } as never, 'a.mp4').catch((e: unknown) => e);
        expect(crf).toBeInstanceOf(InvalidMediaOptionError);
        const av1 = await convertMedia(source, 'mp4', 'mp4', { video: { codec: 'av1', rateControl: { mode: 'vbr', bitrateK: 500, twoPass: true } } }, 'a.mp4').catch((e: unknown) => e);
        expect(av1).toBeInstanceOf(InvalidMediaOptionError);
        // A job that fails inside the job directory cleans it up as well: garbage input fails the first probe.
        const failed = await convertMedia(
          Buffer.from('not a media file at all'), 'mp4', 'mp4',
          { video: { codec: 'h264', rateControl: { mode: 'vbr', bitrateK: 500, twoPass: true } } }, 'bad.mp4'
        ).catch((e: unknown) => e);
        expect(failed).toBeInstanceOf(ConversionFailedError);
        expect(leftoverPassFiles()).toEqual(before);
      });
    },
    ENCODE_TIMEOUT_MS
  );
});

describe('duration, fast start and aspect ratio (arguments and schema)', () => {
  it('limits the output with -t after validating the value', () => {
    const a = buildFfmpegArguments(SOURCE, OUT, 'mp4', 'mp4', { disableHwaccel: true, duration: 5 });
    expect(after(a, '-t')).toBe('5');
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 86401, '5' as never]) {
      expect(() => buildFfmpegArguments(SOURCE, OUT, 'mp4', 'mp4', { disableHwaccel: true, duration: bad }), String(bad)).toThrow(InvalidMediaOptionError);
    }
  });

  it('defaults to +faststart for mp4, mov and m4a, omits it for false, and rejects true elsewhere', () => {
    expect(after(buildFfmpegArguments(SOURCE, OUT, 'mp4', 'mp4', { disableHwaccel: true }), '-movflags')).toBe('+faststart');
    expect(after(buildFfmpegArguments(SOURCE, '/tmp/o.mov', 'mp4', 'mov', { disableHwaccel: true, fastStart: true }), '-movflags')).toBe('+faststart');
    expect(buildFfmpegArguments(SOURCE, OUT, 'mp4', 'mp4', { disableHwaccel: true, fastStart: false }).indexOf('-movflags')).toBe(-1);
    expect(after(buildFfmpegArguments(SOURCE, '/tmp/o.m4a', 'wav', 'm4a', {}), '-movflags')).toBe('+faststart');
    expect(buildFfmpegArguments(SOURCE, '/tmp/o.m4a', 'wav', 'm4a', { fastStart: false }).indexOf('-movflags')).toBe(-1);
    for (const tgt of ['mkv', 'webm', 'avi', 'mp3']) {
      expect(() => buildFfmpegArguments(SOURCE, `/tmp/o.${tgt}`, 'mp4', tgt, { disableHwaccel: true, fastStart: true }), tgt).toThrow(/fastStart/);
      expect(() => buildFfmpegArguments(SOURCE, `/tmp/o.${tgt}`, 'mp4', tgt, { disableHwaccel: true, fastStart: false }), tgt).not.toThrow();
    }
    expect(() => buildFfmpegArguments(SOURCE, OUT, 'mp4', 'mp4', { fastStart: 'yes' as never })).toThrow(InvalidMediaOptionError);
  });

  it('sets the display ratio with setdar by default and reshapes with pad or crop on request', () => {
    const filters = (aspectRatio: unknown) => after(buildFfmpegArguments(SOURCE, OUT, 'mp4', 'mp4', { disableHwaccel: true, aspectRatio: aspectRatio as never }), '-vf');
    expect(filters('4:3')).toBe('scale=trunc(iw/2)*2:trunc(ih/2)*2,setdar=4/3');
    expect(filters({ ratio: '4:3', mode: 'dar' })).toBe('scale=trunc(iw/2)*2:trunc(ih/2)*2,setdar=4/3');
    expect(filters({ ratio: '4:3', mode: 'pad' })).toBe(
      "pad=w='max(iw\\,ceil(ih*4/3/2)*2)':h='max(ih\\,ceil(iw*3/4/2)*2)':x='(ow-iw)/2':y='(oh-ih)/2':color=black,setsar=1,scale=trunc(iw/2)*2:trunc(ih/2)*2"
    );
    expect(filters({ ratio: '1:1', mode: 'crop' })).toBe(
      "crop=w='min(iw\\,floor(ih*1/1/2)*2)':h='min(ih\\,floor(iw*1/1/2)*2)',setsar=1,scale=trunc(iw/2)*2:trunc(ih/2)*2"
    );
  });

  it('rejects ratios that are not W:H whole numbers, are zero, or are wider than 10:1', () => {
    for (const bad of ['wide', '16-9', '0:1', '1:0', '1:11', '11:1', '100000:1', ':3', { ratio: '4:3', mode: 'stretch' }, { mode: 'pad' }, 4]) {
      expect(
        () => buildFfmpegArguments(SOURCE, OUT, 'mp4', 'mp4', { disableHwaccel: true, aspectRatio: bad as never }),
        JSON.stringify(bad)
      ).toThrow(InvalidMediaOptionError);
    }
    expect(() => buildFfmpegArguments(SOURCE, '/tmp/o.mp3', 'wav', 'mp3', { aspectRatio: '4:3' })).toThrow(/video targets/);
  });

  it('is part of the request schema: duration, fastStart and aspectRatio are accepted with their ranges and reject bad values with 422', () => {
    const ok = (options: object) => validateOrProblem(ConversionOptionsSchema, options).ok;
    expect(ok({ duration: 5, fastStart: false, aspectRatio: '16:9' })).toBe(true);
    expect(ok({ aspectRatio: { ratio: '4:3', mode: 'pad' } })).toBe(true);
    for (const bad of [{ duration: 0 }, { duration: -3 }, { duration: 86401 }, { fastStart: 'yes' }, { aspectRatio: 'wide' }, { aspectRatio: { ratio: '4:3', mode: 'stretch' } }]) {
      const result = validateOrProblem(ConversionOptionsSchema, bad);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      if (result.ok) throw new Error(`schema accepted ${JSON.stringify(bad)}`);
      expect(result.problem.status).toBe(422);
    }
    const planned = ConversionOptionsSchema.properties as Record<string, Record<string, unknown>>;
    for (const key of ['duration', 'fastStart', 'aspectRatio']) {
      expect(planned[key]['x-easyconvert-status'], key).toBeUndefined();
    }
  });
});

describe('duration, fast start and aspect ratio (decoded output)', () => {
  const FPS = 25;
  const FRAME_SEC = 1 / FPS;
  const WIDTH = 320;
  const HEIGHT = 180;
  /** Limited-range black in 8-bit YUV. */
  const BLACK_LUMA = 16;
  const BLACK_TOLERANCE = 1;

  function clip(dir: string, seconds: number, name = 'clip.mp4'): string {
    requireEncoders('libx264');
    const out = path.join(dir, name);
    execFileSync(ffmpeg(), [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${seconds}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${seconds}`, '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out,
    ]);
    return out;
  }

  oracleTest(
    'duration 5 on a 20 s source writes 5.00 s, to within one frame, and rejects a duration longer than the input',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withDir(async (dir) => {
        const source = clip(dir, 20);
        const result = await convertMedia(fs.readFileSync(source), 'mp4', 'mp4', { duration: 5 }, 'clip.mp4');
        const out = path.join(dir, 'five.mp4');
        fs.writeFileSync(out, result.buffer);
        const probed = probeFile(ffprobe(), out);
        const video = probed.streams.find((s) => s.codec_type === 'video');
        recordMetric('duration 5 on 20 s: output container seconds', Number(probed.format.duration));
        expect(Math.abs(Number(video?.duration) - 5)).toBeLessThanOrEqual(FRAME_SEC);
        expect(Math.abs(Number(probed.format.duration) - 5)).toBeLessThanOrEqual(FRAME_SEC);
        expect(Number(video?.nb_frames)).toBe(5 * FPS);

        const tooLong = await convertMedia(fs.readFileSync(source), 'mp4', 'mp4', { duration: 21 }, 'clip.mp4').catch((e: unknown) => e);
        expect(tooLong).toBeInstanceOf(InvalidMediaOptionError);
        expect((tooLong as Error).message).toMatch(/Invalid duration 21: the input lasts 20\.\d+ seconds/);
        // The whole input is a valid duration.
        const whole = await convertMedia(fs.readFileSync(source), 'mp4', 'mp4', { duration: 20 }, 'clip.mp4');
        expect(whole.size).toBeGreaterThan(0);
      });
    },
    ENCODE_TIMEOUT_MS
  );

  oracleTest(
    'fastStart puts moov before mdat; false leaves mdat first (independent box walker)',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withDir(async (dir) => {
        const source = fs.readFileSync(clip(dir, 2));
        const order = (bytes: Buffer): string[] => listBoxes(bytes).map((b) => b.type).filter((t) => t === 'moov' || t === 'mdat');
        for (const options of [{}, { fastStart: true }]) {
          const result = await convertMedia(source, 'mp4', 'mp4', options, 'clip.mp4');
          expect(order(result.buffer), JSON.stringify(options)).toEqual(['moov', 'mdat']);
        }
        const slow = await convertMedia(source, 'mp4', 'mp4', { fastStart: false }, 'clip.mp4');
        expect(order(slow.buffer)).toEqual(['mdat', 'moov']);
        // Both decode to the same frames.
        const frames = (bytes: Buffer, name: string) => {
          const f = path.join(dir, name);
          fs.writeFileSync(f, bytes);
          return Number(probeFile(ffprobe(), f).streams.find((s) => s.codec_type === 'video')?.nb_frames);
        };
        expect(frames(slow.buffer, 'slow.mp4')).toBe(2 * FPS);
        const mkv = await convertMedia(source, 'mp4', 'mkv', { fastStart: true }, 'clip.mp4').catch((e: unknown) => e);
        expect(mkv).toBeInstanceOf(InvalidMediaOptionError);
      });
    },
    ENCODE_TIMEOUT_MS
  );

  /** Luma plane of frame `index` of `file`, one byte per pixel. */
  function luma(file: string, width: number, height: number, index = 10): Buffer {
    return execFileSync(
      ffmpeg(),
      ['-v', 'error', '-i', file, '-map', '0:v:0', '-vf', `select=eq(n\\,${index})`, '-fps_mode', 'passthrough', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'],
      { maxBuffer: 16 * 1024 * 1024 }
    ).subarray(0, width * height);
  }

  oracleTest(
    'aspectRatio 4:3 with pad on a 16:9 source: display ratio 4:3, uniform black bars, the source picture in the middle',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withDir(async (dir) => {
        const source = clip(dir, 2);
        const result = await convertMedia(
          fs.readFileSync(source), 'mp4', 'mp4',
          { aspectRatio: { ratio: '4:3', mode: 'pad' }, video: { codec: 'h264', rateControl: { mode: 'crf', crf: 0 } } },
          'clip.mp4'
        );
        const out = path.join(dir, 'padded.mp4');
        fs.writeFileSync(out, result.buffer);
        const video = probeFile(ffprobe(), out).streams.find((s) => s.codec_type === 'video');
        expect(video?.display_aspect_ratio ?? `${video?.width}:${video?.height}`).toBe('4:3');
        expect({ width: video?.width, height: video?.height }).toEqual({ width: WIDTH, height: 240 });
        expect(Number(video?.width) % 2).toBe(0);
        expect(Number(video?.height) % 2).toBe(0);

        // 320x180 padded to 320x240: 30 rows of bars above and below. Every bar pixel is black.
        const frame = luma(out, WIDTH, 240);
        const BAR_ROWS = 30;
        let worstBar = 0;
        for (let y = 0; y < 240; y++) {
          if (y >= BAR_ROWS && y < 240 - BAR_ROWS) continue;
          for (let x = 0; x < WIDTH; x++) worstBar = Math.max(worstBar, Math.abs(frame[y * WIDTH + x] - BLACK_LUMA));
        }
        recordMetric('pad bars: largest deviation from black luma', worstBar);
        expect(worstBar).toBeLessThanOrEqual(BLACK_TOLERANCE);
        // The middle is the source, unscaled: with a lossless encode the luma is identical to the source frame.
        const reference = luma(source, WIDTH, HEIGHT);
        const middle = frame.subarray(BAR_ROWS * WIDTH, (BAR_ROWS + HEIGHT) * WIDTH);
        expect(Buffer.compare(middle, reference)).toBe(0);
      });
    },
    ENCODE_TIMEOUT_MS
  );

  oracleTest(
    'aspectRatio 1:1 with crop keeps the centre of the picture; the default mode only changes the display ratio',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withDir(async (dir) => {
        const source = clip(dir, 2);
        const cropped = await convertMedia(
          fs.readFileSync(source), 'mp4', 'mp4',
          { aspectRatio: { ratio: '1:1', mode: 'crop' }, video: { codec: 'h264', rateControl: { mode: 'crf', crf: 0 } } },
          'clip.mp4'
        );
        const out = path.join(dir, 'cropped.mp4');
        fs.writeFileSync(out, cropped.buffer);
        const video = probeFile(ffprobe(), out).streams.find((s) => s.codec_type === 'video');
        expect({ width: video?.width, height: video?.height }).toEqual({ width: HEIGHT, height: HEIGHT });
        // Centred crop of 180 of 320 columns: from column 70.
        const frame = luma(out, HEIGHT, HEIGHT);
        const reference = luma(source, WIDTH, HEIGHT);
        let worst = 0;
        for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < HEIGHT; x++) worst = Math.max(worst, Math.abs(frame[y * HEIGHT + x] - reference[y * WIDTH + x + 70]));
        expect(worst).toBe(0);

        const dar = await convertMedia(fs.readFileSync(source), 'mp4', 'mp4', { aspectRatio: '4:3' }, 'clip.mp4');
        const darFile = path.join(dir, 'dar.mp4');
        fs.writeFileSync(darFile, dar.buffer);
        const darVideo = probeFile(ffprobe(), darFile).streams.find((s) => s.codec_type === 'video');
        expect(darVideo?.display_aspect_ratio).toBe('4:3');
        expect({ width: darVideo?.width, height: darVideo?.height }).toEqual({ width: WIDTH, height: HEIGHT });
        expect(measureSsimPsnr(ffmpeg(), darFile, source).ssim).toBeGreaterThanOrEqual(VIDEO_MIN_SSIM);
      });
    },
    ENCODE_TIMEOUT_MS
  );
});

describe('ITU-R BS.775 downmix on a real signal', () => {
  const RATE = 48000;
  const FFT_SIZE = 16384;
  const SKIP_SAMPLES = 8192;
  /** A frequency on an exact bin of the FFT, so a rectangular window has no leakage. */
  const hz = (bin: number) => (bin * RATE) / FFT_SIZE;
  /** FL, FR, FC, LFE, BL, BR: a different tone in each channel, on bins of their own. */
  const BINS = { fl: 150, fr: 189, fc: 225, lfe: 17, bl: 253, br: 300 };
  const AMPLITUDE_RATIO_TOLERANCE = 0.02;
  /** Separation: a tone that does not belong to a channel sits at least this far under the ones that do. */
  const MIN_SEPARATION_DB = 60;

  function fiveOne(dir: string): string {
    const out = path.join(dir, 'five_one.wav');
    const inputs = Object.values(BINS).flatMap((bin) => ['-f', 'lavfi', '-i', `sine=frequency=${hz(bin)}:sample_rate=${RATE}:duration=2`]);
    execFileSync(ffmpeg(), [
      '-v', 'error', '-y', ...inputs,
      '-filter_complex', '[0][1][2][3][4][5]amerge=inputs=6,aformat=channel_layouts=5.1[a]', '-map', '[a]', '-c:a', 'pcm_s16le', out,
    ]);
    return out;
  }

  oracleTest(
    'a 5.1 clip with a tone per channel folds to stereo with FC at 0.7071 of FL in both channels, and the LFE dropped',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withDir(async (dir) => {
        const source = fiveOne(dir);
        expect(probeFile(ffprobe(), source).streams[0].channels).toBe(6);
        const result = await convertMedia(fs.readFileSync(source), 'wav', 'wav', { audio: { downmix: 'itu-r-bs775' } }, 'five_one.wav');
        const out = path.join(dir, 'stereo.wav');
        fs.writeFileSync(out, result.buffer);
        const decoded = decodeAudioStream(ffmpeg(), out, RATE, 2);
        const channel = (c: number): Float64Array => {
          const samples = new Float64Array(decoded.samplesPerChannel);
          for (let i = 0; i < samples.length; i++) samples[i] = decoded.pcm.readInt16LE((i * 2 + c) * 2);
          return samples;
        };
        const left = amplitudeSpectrum(channel(0), SKIP_SAMPLES, FFT_SIZE);
        const right = amplitudeSpectrum(channel(1), SKIP_SAMPLES, FFT_SIZE);
        // The tones are lavfi sines (all the same amplitude), so the ratios are the matrix weights.
        const flInLeft = left[BINS.fl];
        const ratios = {
          fcInLeft: left[BINS.fc] / flInLeft,
          fcInRight: right[BINS.fc] / flInLeft,
          blInLeft: left[BINS.bl] / flInLeft,
          brInRight: right[BINS.br] / flInLeft,
          frInRight: right[BINS.fr] / flInLeft,
        };
        for (const [name, value] of Object.entries(ratios)) recordMetric(`downmix ${name} over FL in L`, value);
        const SQRT_HALF = Math.SQRT1_2;
        expect(Math.abs(ratios.fcInLeft - SQRT_HALF)).toBeLessThanOrEqual(AMPLITUDE_RATIO_TOLERANCE);
        expect(Math.abs(ratios.fcInRight - SQRT_HALF)).toBeLessThanOrEqual(AMPLITUDE_RATIO_TOLERANCE);
        expect(Math.abs(ratios.blInLeft - SQRT_HALF)).toBeLessThanOrEqual(AMPLITUDE_RATIO_TOLERANCE);
        expect(Math.abs(ratios.brInRight - SQRT_HALF)).toBeLessThanOrEqual(AMPLITUDE_RATIO_TOLERANCE);
        expect(Math.abs(ratios.frInRight - 1)).toBeLessThanOrEqual(AMPLITUDE_RATIO_TOLERANCE);
        // Channels stay apart: FL is not in R, FR and BR not in L; the LFE is in neither.
        const floor = toDb(flInLeft) - MIN_SEPARATION_DB;
        for (const [label, level] of [
          ['FL in R', right[BINS.fl]], ['FR in L', left[BINS.fr]], ['BR in L', left[BINS.br]], ['BL in R', right[BINS.bl]],
          ['LFE in L', left[BINS.lfe]], ['LFE in R', right[BINS.lfe]],
        ] as const) {
          expect(toDb(level), label).toBeLessThan(floor);
        }
      });
    },
    ENCODE_TIMEOUT_MS
  );
});

describe('burned-in subtitles change only their own region', () => {
  const WIDTH = 320;
  const HEIGHT = 180;
  const FPS = 25;
  const SAMPLE_FRAME = FPS;
  /** The cue is white text with an outline over coloured bars: the band it sits in differs by far more than this. */
  const MIN_BAND_MEAN_ABS_DIFF = 2;
  /** Outside the band the burned frame is the unburned frame, re-encoded losslessly: infinite PSNR, 40 dB is the floor. */
  const MIN_OUTSIDE_PSNR_DB = 40;

  function luma(file: string): Buffer {
    return execFileSync(
      ffmpeg(),
      ['-v', 'error', '-i', file, '-map', '0:v:0', '-vf', `select=eq(n\\,${SAMPLE_FRAME})`, '-fps_mode', 'passthrough', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'],
      { maxBuffer: 16 * 1024 * 1024 }
    ).subarray(0, WIDTH * HEIGHT);
  }

  oracleTest(
    'an external SRT burned into the picture changes the lower band and leaves the rest at PSNR 40 dB or better',
    ['ffmpeg', 'ffprobe'],
    async () => {
      requireEncoders('libx264');
      await withDir(async (dir) => {
        const source = path.join(dir, 'clip.mp4');
        execFileSync(ffmpeg(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=3`, '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', source]);
        const srt = path.join(dir, 'cue.srt');
        fs.writeFileSync(srt, '1\n00:00:00,500 --> 00:00:02,500\nBURNED IN CUE TEXT\n\n');
        const lossless = { codec: 'h264', rateControl: { mode: 'crf', crf: 0 } } as const;
        const plain = await convertMedia(fs.readFileSync(source), 'mp4', 'mp4', { video: lossless }, 'clip.mp4');
        const burned = await convertMedia(fs.readFileSync(source), 'mp4', 'mp4', { video: lossless, subtitles: { mode: 'burn', input: srt } }, 'clip.mp4');
        const plainFile = path.join(dir, 'plain.mp4');
        const burnedFile = path.join(dir, 'burned.mp4');
        fs.writeFileSync(plainFile, plain.buffer);
        fs.writeFileSync(burnedFile, burned.buffer);

        const a = luma(burnedFile);
        const b = luma(plainFile);
        const bandTop = Math.floor(HEIGHT * 0.75);
        let band = 0;
        let bandCount = 0;
        let outsideSq = 0;
        let outsideCount = 0;
        for (let y = 0; y < HEIGHT; y++) {
          for (let x = 0; x < WIDTH; x++) {
            const d = a[y * WIDTH + x] - b[y * WIDTH + x];
            if (y >= bandTop) {
              band += Math.abs(d);
              bandCount++;
            } else {
              outsideSq += d * d;
              outsideCount++;
            }
          }
        }
        const meanBand = band / bandCount;
        const psnr = outsideSq === 0 ? Infinity : 10 * Math.log10((255 * 255) / (outsideSq / outsideCount));
        recordMetric('burned SRT: mean absolute difference in the subtitle band', meanBand);
        recordMetric('burned SRT: PSNR outside the subtitle band (dB)', psnr);
        expect(meanBand).toBeGreaterThan(MIN_BAND_MEAN_ABS_DIFF);
        expect(psnr).toBeGreaterThanOrEqual(MIN_OUTSIDE_PSNR_DB);
        // Before the cue starts (frame 5, 0.2 s) the burned output is the unburned one, whole frame.
        const early = (file: string) =>
          execFileSync(ffmpeg(), ['-v', 'error', '-i', file, '-vf', 'select=eq(n\\,5)', '-fps_mode', 'passthrough', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], { maxBuffer: 16 * 1024 * 1024 });
        expect(Buffer.compare(early(burnedFile), early(plainFile))).toBe(0);
      });
    },
    ENCODE_TIMEOUT_MS
  );
});

it('keeps the request type free of a planned marker for the new options', () => {
  const properties = ConversionOptionsSchema.properties as Record<string, Record<string, unknown>>;
  expect(Object.keys(properties).filter((key) => properties[key]['x-easyconvert-status'] === 'planned')).toEqual([]);
});
