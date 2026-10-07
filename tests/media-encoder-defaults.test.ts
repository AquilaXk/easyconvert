import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';
import { requireEncoders } from './helpers/ffmpeg-media-fixtures';
import { quantisationReport } from './helpers/audio-signals';
import { measureLoudness, measureSsimPsnr, probeFile, recordMetric } from './helpers/ffmpeg-measure';
import { VIDEO_MIN_SSIM } from './oracles/product/media-oracle';
import { sineSamples, wavFromSamples } from './helpers/media-lossy-oracle';
import {
  buildFfmpegArguments,
  buildLoudnessMeasureArguments,
  resetHardwareAccelerationCache,
  SVT_AV1_DEFAULT_PRESET,
  VP9_SPEED_ARGS,
  X26X_DEFAULT_PRESET,
  X26X_PRESETS,
  type LoudnessStage,
} from '../src/lib/conversions/media-ffmpeg-args';
import {
  LOUDNORM_DEFAULTS,
  LOUDNESS_PRESETS,
  LoudnessMeasurementError,
  chooseResampler,
  loudnormApplyFilter,
  loudnormMeasureFilter,
  parseLoudnormMeasurement,
  resolveLoudnessTarget,
} from '../src/lib/conversions/media-audio-quality';
import { describeAudioProcessing } from '../src/lib/conversions/media-audio-run';
import { convertMedia } from '../src/lib/conversions/media';
import { EngineUnavailableError, InvalidMediaOptionError } from '../src/lib/types';

/**
 * Encoder defaults and loudness normalisation. Argument tests read the exact ffmpeg arguments; output tests
 * judge the encoded files by decoding them: ebur128 for loudness, ssim against the source for pictures, idet
 * for combing, and an FFT of a -90 dBFS tone for dither. Nothing is taken from the module under test.
 */

const ENCODE_TIMEOUT_MS = 180_000;
const SOURCE = '/nonexistent/in.mp4';
const OUT = '/tmp/out.mp4';

function args(options: object, tgt = 'mp4'): string[] {
  return buildFfmpegArguments(SOURCE, `/tmp/out.${tgt}`, 'mp4', tgt, { disableHwaccel: true, ...options } as never);
}
function after(list: string[], flag: string): string {
  return list[list.indexOf(flag) + 1];
}

describe('x264, x265, VP9 and AV1 defaults (arguments)', () => {
  it('encodes H.264 and HEVC at preset medium unless the caller names another from the allow-list', () => {
    expect(X26X_DEFAULT_PRESET).toBe('medium');
    expect(after(args({ video: { codec: 'h264' } }), '-preset')).toBe('medium');
    expect(after(args({ video: { codec: 'hevc' } }), '-preset')).toBe('medium');
    expect(after(args({ video: { codec: 'h264', preset: 'slow' } }), '-preset')).toBe('slow');
    expect([...X26X_PRESETS]).not.toContain('placebo');
    expect(() => args({ video: { codec: 'h264', preset: 'placebo' } })).toThrow(InvalidMediaOptionError);
    expect(() => args({ video: { codec: 'h264', preset: 'fast; rm -rf /' } })).toThrow(/Invalid x264\/x265 preset/);
  });

  it('gives VP9 row multithreading, the good deadline, cpu-used 2 and tile columns in every container', () => {
    expect(VP9_SPEED_ARGS).toEqual(['-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-tile-columns', '2']);
    for (const [tgt, video] of [
      ['mp4', { codec: 'vp9' }],
      ['mkv', { codec: 'vp9' }],
      ['webm', { codec: 'vp9' }],
      ['webm', {}],
    ] as const) {
      const a = args({ video }, tgt);
      expect(a[a.indexOf('-c:v') + 1], tgt).toBe('libvpx-vp9');
      expect(after(a, '-row-mt')).toBe('1');
      expect(after(a, '-deadline')).toBe('good');
      expect(after(a, '-cpu-used')).toBe('2');
      expect(after(a, '-tile-columns')).toBe('2');
    }
  });

  it('writes AV1 with SVT-AV1 at preset 8 in every container, never libaom', () => {
    expect(SVT_AV1_DEFAULT_PRESET).toBe(8);
    for (const tgt of ['mp4', 'mkv', 'webm']) {
      const a = args({ video: { codec: 'av1' } }, tgt);
      expect(a[a.indexOf('-c:v') + 1], tgt).toBe('libsvtav1');
      expect(after(a, '-preset'), tgt).toBe('8');
      expect(a).not.toContain('libaom-av1');
      expect(after(a, '-crf')).toBe('32');
    }
    expect(after(args({ video: { codec: 'av1', preset: '5' } }), '-preset')).toBe('5');
    expect(() => args({ video: { codec: 'av1', preset: '14' } })).toThrow(InvalidMediaOptionError);
    expect(() => args({ video: { codec: 'av1', preset: 'slow' } })).toThrow(InvalidMediaOptionError);
  });

  it('answers 503 when the ffmpeg build has no SVT-AV1 encoder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-ffmpeg-'));
    try {
      const fake = path.join(dir, 'ffmpeg');
      fs.writeFileSync(fake, '#!/bin/sh\ncase "$*" in\n  *-encoders*) echo " V....D libx264              libx264 H.264"; echo " V....D libaom-av1           libaom AV1";;\nesac\n');
      fs.chmodSync(fake, 0o755);
      resetHardwareAccelerationCache();
      const build = () => buildFfmpegArguments(SOURCE, OUT, 'mp4', 'mp4', { disableHwaccel: true, video: { codec: 'av1' } }, fake);
      expect(build).toThrow(EngineUnavailableError);
      expect(build).toThrow(/libsvtav1/);
      // H.264 on the same build is untouched.
      expect(() => buildFfmpegArguments(SOURCE, OUT, 'mp4', 'mp4', { disableHwaccel: true, video: { codec: 'h264' } }, fake)).not.toThrow();
    } finally {
      resetHardwareAccelerationCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caps a CRF encode only when the caller sets maxBitrateK, with a buffer of twice the cap', () => {
    const capped = args({ video: { codec: 'h264', rateControl: { mode: 'crf', crf: 23, maxBitrateK: 3000 } } });
    expect(after(capped, '-crf')).toBe('23');
    expect(after(capped, '-maxrate')).toBe('3000k');
    expect(after(capped, '-bufsize')).toBe('6000k');
    for (const video of [{ codec: 'h264' }, { codec: 'hevc' }, { codec: 'av1' }, { codec: 'h264', rateControl: { mode: 'crf', crf: 23 } }]) {
      const a = args({ video });
      expect(a.indexOf('-maxrate'), JSON.stringify(video)).toBe(-1);
      expect(a.indexOf('-bufsize'), JSON.stringify(video)).toBe(-1);
    }
    const av1 = args({ video: { codec: 'av1', rateControl: { mode: 'crf', crf: 30, maxBitrateK: 2000 } } });
    expect([after(av1, '-crf'), after(av1, '-maxrate'), after(av1, '-bufsize')]).toEqual(['30', '2000k', '4000k']);
    // VP9 states the cap as the ceiling of constrained quality.
    const vp9 = args({ video: { codec: 'vp9', rateControl: { mode: 'crf', crf: 31, maxBitrateK: 1500 } } }, 'webm');
    expect([after(vp9, '-crf'), after(vp9, '-b:v')]).toEqual(['31', '1500k']);
    for (const maxBitrateK of [0, -5, Number.NaN]) {
      expect(() => args({ video: { codec: 'h264', rateControl: { mode: 'crf', crf: 23, maxBitrateK } } })).toThrow(InvalidMediaOptionError);
    }
  });

  it('deinterlaces with bwdif, one frame per field, only for frames flagged interlaced', () => {
    const a = args({ video: { codec: 'h264', deinterlace: true } });
    expect(after(a, '-vf').startsWith('bwdif=mode=send_field:deint=interlaced,')).toBe(true);
    expect(after(a, '-vf')).not.toContain('yadif');
  });
});

describe('loudness normalisation (arguments and report parsing)', () => {
  const measurement = { inputI: -30.14, inputTp: -22.8, inputLra: 0.7, inputThresh: -40.61, targetOffset: 0.1, sampleRate: 48000 };
  const apply: LoudnessStage = { kind: 'apply', measurement };

  it('defaults to EBU R128 -23 LUFS, -1 dBTP, 7 LU and offers named streaming targets', () => {
    expect(LOUDNORM_DEFAULTS).toEqual({ integrated: -23, truePeak: -1, lra: 7 });
    expect(resolveLoudnessTarget({})).toEqual({ integrated: -23, truePeak: -1, lra: 7 });
    expect(resolveLoudnessTarget({ preset: 'streaming' }).integrated).toBe(-14);
    expect(resolveLoudnessTarget({ preset: 'podcast' }).integrated).toBe(-16);
    expect(resolveLoudnessTarget({ preset: 'streaming', integrated: -16 })).toEqual({ integrated: -16, truePeak: -1, lra: 11 });
    expect(Object.keys(LOUDNESS_PRESETS)).toEqual(['ebu-r128', 'streaming', 'podcast']);
  });

  it('rejects targets outside I -70..-5 LUFS, TP -9..0 dBTP and LRA 1..50 LU', () => {
    for (const bad of [{ integrated: -71 }, { integrated: -4 }, { truePeak: 0.5 }, { truePeak: -10 }, { lra: 0.5 }, { lra: 51 }, { integrated: Number.NaN }]) {
      expect(() => resolveLoudnessTarget(bad), JSON.stringify(bad)).toThrow(InvalidMediaOptionError);
    }
    expect(() => resolveLoudnessTarget({ preset: 'loud' as never })).toThrow(/Unknown loudness preset/);
    for (const edge of [{ integrated: -70 }, { integrated: -5 }, { truePeak: -9 }, { truePeak: 0 }, { lra: 1 }, { lra: 50 }]) {
      expect(() => resolveLoudnessTarget(edge), JSON.stringify(edge)).not.toThrow();
    }
  });

  it('builds the measuring filter and the linear applying filter from the report', () => {
    expect(loudnormMeasureFilter(LOUDNORM_DEFAULTS)).toBe('loudnorm=I=-23:TP=-1:LRA=7:print_format=json');
    expect(loudnormApplyFilter(LOUDNORM_DEFAULTS, measurement)).toBe(
      'loudnorm=I=-23:TP=-1:LRA=7:measured_I=-30.14:measured_TP=-22.8:measured_LRA=0.7:measured_thresh=-40.61:offset=0.1:linear=true:print_format=summary'
    );
  });

  it('parses the loudnorm JSON report and fails closed on a missing key, silence or noise', () => {
    const report = `[Parsed_loudnorm_0 @ 0x1] \n{\n\t"input_i" : "-30.14",\n\t"input_tp" : "-22.80",\n\t"input_lra" : "0.70",\n\t"input_thresh" : "-40.61",\n\t"output_i" : "-23.50",\n\t"target_offset" : "0.50"\n}\n`;
    expect(parseLoudnormMeasurement(report, 48000)).toEqual({
      inputI: -30.14, inputTp: -22.8, inputLra: 0.7, inputThresh: -40.61, targetOffset: 0.5, sampleRate: 48000,
    });
    expect(() => parseLoudnormMeasurement('no report here', 48000)).toThrow(LoudnessMeasurementError);
    expect(() => parseLoudnormMeasurement(report.replace('"input_tp" : "-22.80",', ''), 48000)).toThrow(/input_tp/);
    expect(() => parseLoudnormMeasurement(report.replace('"-30.14"', '"-inf"'), 48000)).toThrow(/silent/);
    expect(() => parseLoudnormMeasurement('{ "input_i" : "x", broken', 48000)).toThrow(LoudnessMeasurementError);
  });

  it('refuses to encode a loudness request without a measurement and measures exactly one audio track', () => {
    const options = { audio: { loudness: {} } };
    expect(() => buildFfmpegArguments(SOURCE, '/tmp/out.wav', 'wav', 'wav', options as never)).toThrow(/measuring pass/);
    // Without an input to inspect, a video target cannot say which track to measure.
    expect(() => buildFfmpegArguments(SOURCE, OUT, 'wav', 'mp4', options as never, null, undefined, apply)).toThrow(/needs an input file/);
  });

  it('builds the audio-only measuring pass: same map and format arguments, loudnorm at the target, null sink', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loud-args-'));
    try {
      const wav = path.join(dir, 'in.wav');
      fs.writeFileSync(wav, wavFromSamples(sineSamples(48000, 1, 1), 48000, 1));
      const measure = buildLoudnessMeasureArguments(wav, 'wav', 'flac', { audio: { loudness: { preset: 'streaming' }, volume: 50 } });
      expect(measure.slice(-3)).toEqual(['-f', 'null', '-']);
      expect(after(measure, '-af')).toBe('volume=0.5,loudnorm=I=-14:TP=-1:LRA=11:print_format=json');
      expect(measure).toContain('-vn');
      expect(measure).not.toContain('-c:a');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resampler and dither (arguments)', () => {
  it('uses soxr at precision 28 for a rate change when the build has it, and reports the reason when it does not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-soxr-'));
    try {
      const withSoxr = path.join(dir, 'ffmpeg-soxr');
      const without = path.join(dir, 'ffmpeg-plain');
      fs.writeFileSync(withSoxr, '#!/bin/sh\ncase "$*" in\n  *-version*) echo "configuration: --enable-gpl --enable-libsoxr";;\nesac\n');
      fs.writeFileSync(without, '#!/bin/sh\ncase "$*" in\n  *-version*) echo "configuration: --enable-gpl";;\nesac\n');
      fs.chmodSync(withSoxr, 0o755);
      fs.chmodSync(without, 0o755);

      expect(chooseResampler(undefined, withSoxr)).toEqual({ resampler: 'soxr' });
      const fallback = chooseResampler(undefined, without);
      expect(fallback.resampler).toBe('swr');
      expect(fallback.fallbackReason).toMatch(/no libsoxr/);
      expect(chooseResampler('swr', withSoxr)).toEqual({ resampler: 'swr' });
      // An explicit soxr never degrades silently.
      expect(() => chooseResampler('soxr', without)).toThrow(EngineUnavailableError);
      expect(() => chooseResampler('sinc' as never, withSoxr)).toThrow(InvalidMediaOptionError);

      const a = buildFfmpegArguments(SOURCE, '/tmp/out.mp4', 'mp4', 'mp4', { disableHwaccel: true, audio: { sampleRate: 22050 } }, withSoxr);
      expect(after(a, '-filter:a')).toBe('aresample=async=1:first_pts=0,aresample=22050:resampler=soxr:precision=28');
      expect(after(a, '-ar')).toBe('22050');
      const b = buildFfmpegArguments(SOURCE, '/tmp/out.mp4', 'mp4', 'mp4', { disableHwaccel: true, audio: { sampleRate: 22050 } }, without);
      expect(after(b, '-filter:a')).toBe('aresample=async=1:first_pts=0');
      expect(describeAudioProcessing({}, without, undefined)).toEqual({
        resampler: 'swr',
        resamplerFallbackReason: 'this ffmpeg build has no libsoxr; the default swresample resampler was used',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dithers the reduction to 16-bit PCM with triangular_hp by default and rejects dither for other codecs', () => {
    const wav = buildFfmpegArguments(SOURCE, '/tmp/out.wav', 'wav', 'wav', {});
    expect(after(wav, '-filter:a')).toBe('aresample=dither_method=triangular_hp,aformat=sample_fmts=s16');
    const plain = buildFfmpegArguments(SOURCE, '/tmp/out.wav', 'wav', 'wav', { audio: { dither: 'triangular' } });
    expect(after(plain, '-filter:a')).toBe('aresample=dither_method=triangular,aformat=sample_fmts=s16');
    expect(() => buildFfmpegArguments(SOURCE, '/tmp/out.wav', 'wav', 'wav', { audio: { dither: 'gaussian' as never } })).toThrow(InvalidMediaOptionError);
    expect(() => buildFfmpegArguments(SOURCE, OUT, 'mp4', 'mp4', { disableHwaccel: true, audio: { codec: 'aac', dither: 'triangular_hp' } })).toThrow(
      /16-bit PCM output only/
    );
  });
});

function ffmpeg(): string {
  return requireOracleTool('ffmpeg');
}

function withDir<T>(run: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encoder-defaults-'));
  return Promise.resolve(run(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

describe('loudness normalisation (decoded output)', () => {
  /** Tolerance of the integrated loudness around the target, in LU. The measurement itself is only that exact. */
  const LOUDNESS_TOLERANCE_LU = 0.5;
  /** True-peak ceiling the default target sets; a lossless output must stay below it. */
  const CEILING_DBTP = -1.0;
  /** An AAC or MP3 encode can overshoot the ceiling by its own quantisation: allow 0.5 dB, measured below. */
  const LOSSY_CEILING_MARGIN_DB = 0.5;
  const SOURCE_RATE = 48000;
  const SOURCE_SECONDS = 12;

  /** Two tones with a slow level wobble: a steady, music-like signal whose peak stays well under full scale. */
  function sourceAt(dir: string, lufs: number): string {
    const base = path.join(dir, 'base.wav');
    execFileSync(ffmpeg(), [
      '-v', 'error', '-y', '-f', 'lavfi', '-i',
      `aevalsrc=exprs='0.5*sin(2*PI*440*t)*(0.75+0.25*sin(2*PI*0.5*t))+0.25*sin(2*PI*1500*t)':s=${SOURCE_RATE}:d=${SOURCE_SECONDS}`,
      '-c:a', 'pcm_s16le', base,
    ]);
    const gain = lufs - measureLoudness(ffmpeg(), base).integrated;
    const out = path.join(dir, `source_${lufs}.wav`);
    execFileSync(ffmpeg(), ['-v', 'error', '-y', '-i', base, '-af', `volume=${gain}dB`, '-c:a', 'pcm_f32le', out]);
    return out;
  }

  for (const sourceLufs of [-30, -10]) {
    for (const target of ['wav', 'flac'] as const) {
      oracleTest(
        `a ${sourceLufs} LUFS source normalised to the default target reads -23 LUFS +-0.5 LU with true peak at or under -1 dBTP (${target})`,
        ['ffmpeg', 'ffprobe'],
        async () => {
          await withDir(async (dir) => {
            const source = sourceAt(dir, sourceLufs);
            // The oracle first: the source really is at the stated loudness.
            expect(Math.abs(measureLoudness(ffmpeg(), source).integrated - sourceLufs)).toBeLessThanOrEqual(0.1);
            const result = await convertMedia(fs.readFileSync(source), 'wav', target, { audio: { loudness: {} } }, 'source.wav');
            const out = path.join(dir, `out.${target}`);
            fs.writeFileSync(out, result.buffer);
            const loudness = measureLoudness(ffmpeg(), out);
            recordMetric(`loudness: ${sourceLufs} LUFS source to ${target}, integrated LUFS`, loudness.integrated);
            recordMetric(`loudness: ${sourceLufs} LUFS source to ${target}, true peak dBTP`, loudness.truePeak);
            expect(Math.abs(loudness.integrated - LOUDNORM_DEFAULTS.integrated)).toBeLessThanOrEqual(LOUDNESS_TOLERANCE_LU);
            expect(loudness.truePeak).toBeLessThanOrEqual(CEILING_DBTP);
            // The output keeps the source rate and length: loudnorm's 192 kHz internal rate does not leak out.
            const stream = probeFile(requireOracleTool('ffprobe'), out).streams[0];
            expect(Number(stream.sample_rate)).toBe(SOURCE_RATE);
            expect(Math.abs(Number(probeFile(requireOracleTool('ffprobe'), out).format.duration) - SOURCE_SECONDS)).toBeLessThanOrEqual(0.05);
            expect(result.metadata).toMatchObject({
              resampler: 'soxr',
              loudness: { target: { integrated: -23, truePeak: -1, lra: 7 } },
            });
          });
        },
        ENCODE_TIMEOUT_MS
      );
    }
  }

  oracleTest(
    'the streaming preset reaches -14 LUFS, and an explicit target overrides the preset',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withDir(async (dir) => {
        const source = fs.readFileSync(sourceAt(dir, -30));
        for (const { loudness, expected } of [
          { loudness: { preset: 'streaming' as const }, expected: -14 },
          { loudness: { preset: 'streaming' as const, integrated: -16 }, expected: -16 },
        ]) {
          const result = await convertMedia(source, 'wav', 'wav', { audio: { loudness } }, 'source.wav');
          const out = path.join(dir, `out_${expected}.wav`);
          fs.writeFileSync(out, result.buffer);
          const measured = measureLoudness(ffmpeg(), out);
          recordMetric(`loudness: streaming preset target ${expected} LUFS, measured`, measured.integrated);
          expect(Math.abs(measured.integrated - expected)).toBeLessThanOrEqual(LOUDNESS_TOLERANCE_LU);
          expect(measured.truePeak).toBeLessThanOrEqual(CEILING_DBTP);
        }
      });
    },
    ENCODE_TIMEOUT_MS
  );

  oracleTest(
    'lossy AAC and MP3 outputs keep the loudness target and stay within the ceiling margin of the lossy encode',
    ['ffmpeg', 'ffprobe'],
    async () => {
      requireEncoders('aac', 'libmp3lame');
      await withDir(async (dir) => {
        const source = fs.readFileSync(sourceAt(dir, -10));
        for (const target of ['m4a', 'mp3'] as const) {
          const result = await convertMedia(source, 'wav', target, { audio: { loudness: {} } }, 'source.wav');
          const out = path.join(dir, `out.${target}`);
          fs.writeFileSync(out, result.buffer);
          const loudness = measureLoudness(ffmpeg(), out);
          recordMetric(`loudness: -10 LUFS source to ${target}, integrated LUFS`, loudness.integrated);
          recordMetric(`loudness: -10 LUFS source to ${target}, true peak dBTP`, loudness.truePeak);
          expect(Math.abs(loudness.integrated - LOUDNORM_DEFAULTS.integrated), target).toBeLessThanOrEqual(LOUDNESS_TOLERANCE_LU);
          expect(loudness.truePeak, target).toBeLessThanOrEqual(CEILING_DBTP + LOSSY_CEILING_MARGIN_DB);
        }
      });
    },
    ENCODE_TIMEOUT_MS
  );

  oracleTest(
    'a video keeps its picture while its one audio track is normalised; a two-track source asks for a track',
    ['ffmpeg', 'ffprobe'],
    async () => {
      requireEncoders('libx264', 'aac');
      await withDir(async (dir) => {
        const tone = sourceAt(dir, -30);
        const video = path.join(dir, 'video.mp4');
        execFileSync(ffmpeg(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25:duration=12', '-i', tone, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
        const result = await convertMedia(fs.readFileSync(video), 'mp4', 'mp4', { audio: { loudness: {} } }, 'video.mp4');
        const out = path.join(dir, 'out.mp4');
        fs.writeFileSync(out, result.buffer);
        const loudness = measureLoudness(ffmpeg(), out);
        expect(Math.abs(loudness.integrated - LOUDNORM_DEFAULTS.integrated)).toBeLessThanOrEqual(LOUDNESS_TOLERANCE_LU);
        expect(measureSsimPsnr(ffmpeg(), out, video).ssim).toBeGreaterThanOrEqual(VIDEO_MIN_SSIM);

        const twoTracks = path.join(dir, 'two.mkv');
        execFileSync(ffmpeg(), ['-v', 'error', '-y', '-i', video, '-i', tone, '-map', '0:v', '-map', '0:a', '-map', '1:a', '-c', 'copy', twoTracks]);
        const error = await convertMedia(fs.readFileSync(twoTracks), 'mkv', 'mp4', { audio: { loudness: {} } }, 'two.mkv').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(InvalidMediaOptionError);
        expect((error as Error).message).toMatch(/one audio track; this conversion maps 2/);
        const chosen = await convertMedia(fs.readFileSync(twoTracks), 'mkv', 'mp4', { audio: { track: 1, loudness: {} } }, 'two.mkv');
        const chosenFile = path.join(dir, 'chosen.mp4');
        fs.writeFileSync(chosenFile, chosen.buffer);
        expect(Math.abs(measureLoudness(ffmpeg(), chosenFile).integrated - LOUDNORM_DEFAULTS.integrated)).toBeLessThanOrEqual(LOUDNESS_TOLERANCE_LU);
      });
    },
    ENCODE_TIMEOUT_MS
  );

  oracleTest(
    'digital silence cannot be normalised and is a typed measurement error',
    ['ffmpeg', 'ffprobe'],
    async () => {
      await withDir(async (dir) => {
        const silence = path.join(dir, 'silence.wav');
        execFileSync(ffmpeg(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '3', '-c:a', 'pcm_s16le', silence]);
        const error = await convertMedia(fs.readFileSync(silence), 'wav', 'wav', { audio: { loudness: {} } }, 'silence.wav').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(LoudnessMeasurementError);
        expect((error as Error).message).toMatch(/no usable input_i \(-inf\).*silent or too short/);
      });
    },
    ENCODE_TIMEOUT_MS
  );
});

describe('16-bit dither (decoded output)', () => {
  const RATE = 48000;
  const FFT_SIZE = 16384;
  const TONE_BIN = 341;
  const TONE_HZ = (TONE_BIN * RATE) / FFT_SIZE;
  const TONE_DBFS = -90;
  /** The level the tone is read back at, within the resolution of one 16384-point bin pair. */
  const TONE_TOLERANCE_DB = 0.3;
  /**
   * TPDF dither of 1 LSB peak-to-peak each side has variance 1/6 LSB^2; rounding adds 1/12. Their sum, 1/4 LSB^2,
   * is the noise power of a TPDF-dithered 16-bit quantiser (measured 0.245 to 0.246).
   */
  const TPDF_NOISE_POWER_LSB2 = 0.25;
  const NOISE_POWER_TOLERANCE = 0.03;
  /** White noise has a peak bin about 10 to 12 dB over its mean; a spur from distortion stands out far more (measured 34 dB). */
  const NOISE_PEAK_TO_MEAN_MAX_DB = 20;
  const SPUR_PEAK_TO_MEAN_MIN_DB = 25;
  /** triangular_hp tilts the noise toward high frequencies (measured +5.6 dB); plain triangular is flat. */
  const HP_TILT_MIN_DB = 3;
  const FLAT_TILT_MAX_DB = 1;
  const SKIP_SAMPLES = 4096;

  async function quantised(dir: string, dither: string | undefined) {
    const src = path.join(dir, 'tone.wav');
    if (!fs.existsSync(src)) {
      execFileSync(ffmpeg(), [
        '-v', 'error', '-y', '-f', 'lavfi', '-i',
        `aevalsrc=exprs='pow(10,${TONE_DBFS}/20)*sin(2*PI*${TONE_HZ}*t)':s=${RATE}:d=2`, '-c:a', 'pcm_f32le', src,
      ]);
    }
    const result = await convertMedia(fs.readFileSync(src), 'wav', 'wav', dither ? { audio: { dither: dither as never } } : {}, 'tone.wav');
    const pcm = result.buffer.subarray(44);
    const samples = new Float64Array(pcm.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2);
    return quantisationReport(samples, SKIP_SAMPLES, FFT_SIZE, TONE_BIN);
  }

  oracleTest(
    'the default triangular_hp dither keeps the -90 dBFS tone and turns quantisation into TPDF-level, tilted, spur-free noise',
    ['ffmpeg'],
    async () => {
      await withDir(async (dir) => {
        const report = await quantised(dir, undefined);
        recordMetric('dither triangular_hp: tone dBFS', report.toneDbfs);
        recordMetric('dither triangular_hp: noise power LSB^2', report.noisePowerLsb2);
        recordMetric('dither triangular_hp: peak-to-mean dB', report.peakToMeanDb);
        recordMetric('dither triangular_hp: high over low dB', report.highOverLowDb);
        expect(Math.abs(report.toneDbfs - TONE_DBFS)).toBeLessThanOrEqual(TONE_TOLERANCE_DB);
        expect(Math.abs(report.noisePowerLsb2 - TPDF_NOISE_POWER_LSB2)).toBeLessThanOrEqual(NOISE_POWER_TOLERANCE);
        expect(report.peakToMeanDb).toBeLessThanOrEqual(NOISE_PEAK_TO_MEAN_MAX_DB);
        expect(report.highOverLowDb).toBeGreaterThanOrEqual(HP_TILT_MIN_DB);
      });
    },
    ENCODE_TIMEOUT_MS
  );

  oracleTest(
    'plain triangular dither is flat TPDF noise, and without dither the same tone is distorted into discrete spurs',
    ['ffmpeg'],
    async () => {
      await withDir(async (dir) => {
        const flat = await quantised(dir, 'triangular');
        expect(Math.abs(flat.toneDbfs - TONE_DBFS)).toBeLessThanOrEqual(TONE_TOLERANCE_DB);
        expect(Math.abs(flat.noisePowerLsb2 - TPDF_NOISE_POWER_LSB2)).toBeLessThanOrEqual(NOISE_POWER_TOLERANCE);
        expect(flat.peakToMeanDb).toBeLessThanOrEqual(NOISE_PEAK_TO_MEAN_MAX_DB);
        expect(Math.abs(flat.highOverLowDb)).toBeLessThanOrEqual(FLAT_TILT_MAX_DB);

        const none = await quantised(dir, 'none');
        recordMetric('no dither: peak-to-mean dB', none.peakToMeanDb);
        // The control proves the oracle can see distortion: undithered rounding of a one-LSB tone has harmonic spurs.
        expect(none.peakToMeanDb).toBeGreaterThanOrEqual(SPUR_PEAK_TO_MEAN_MIN_DB);
      });
    },
    ENCODE_TIMEOUT_MS
  );
});

describe('picture quality at the new defaults (decoded output)', () => {
  const DEFAULT_H264_MIN_SSIM = 0.98;
  /**
   * AV1 and VP9 at their default constant-quality settings (crf 32 and 30) on a detailed synthetic pattern score
   * above this against the source (measured 0.96 to 0.99); a broken encode scores far below.
   */
  const MODERN_CODEC_MIN_SSIM = 0.95;

  function clip(dir: string, size: string, seconds: number, extra: string[] = []): string {
    const out = path.join(dir, `clip_${size}_${seconds}.mp4`);
    execFileSync(ffmpeg(), [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=25:duration=${seconds}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '12', ...extra, out,
    ]);
    return out;
  }

  oracleTest(
    'default H.264 (preset medium) reaches SSIM 0.98 against the source, and the encode time is recorded',
    ['ffmpeg', 'ffprobe'],
    async () => {
      requireEncoders('libx264');
      await withDir(async (dir) => {
        const source = clip(dir, '1280x720', 3);
        const started = Date.now();
        const result = await convertMedia(fs.readFileSync(source), 'mp4', 'mp4', { disableHwaccel: true }, 'clip.mp4');
        const elapsed = Date.now() - started;
        const out = path.join(dir, 'out.mp4');
        fs.writeFileSync(out, result.buffer);
        const measured = measureSsimPsnr(ffmpeg(), out, source);
        recordMetric('h264 medium 720p 3 s: encode ms', elapsed);
        recordMetric('h264 medium 720p 3 s: ssim', measured.ssim);
        recordMetric('h264 medium 720p 3 s: psnr dB', measured.psnr);
        expect(measured.ssim).toBeGreaterThanOrEqual(DEFAULT_H264_MIN_SSIM);
        const stream = probeFile(requireOracleTool('ffprobe'), out).streams.find((s) => s.codec_type === 'video');
        expect(stream?.codec_name).toBe('h264');
      });
    },
    ENCODE_TIMEOUT_MS
  );

  oracleTest(
    'AV1 is written by SVT-AV1, finishes a 10 s 720p clip inside the media timeout, and matches the source',
    ['ffmpeg', 'ffprobe'],
    async () => {
      requireEncoders('libsvtav1', 'libx264');
      await withDir(async (dir) => {
        const source = clip(dir, '1280x720', 10);
        const timeoutMs = 90_000; // computeMediaTimeoutMs(10): 3 * 10 + 60 seconds
        const started = Date.now();
        const result = await convertMedia(fs.readFileSync(source), 'mp4', 'webm', { video: { codec: 'av1' }, timeoutMs }, 'clip.mp4');
        const elapsed = Date.now() - started;
        const out = path.join(dir, 'out.webm');
        fs.writeFileSync(out, result.buffer);
        recordMetric('svt-av1 preset 8 720p 10 s: encode ms', elapsed);
        expect(elapsed).toBeLessThan(timeoutMs);
        const probed = probeFile(requireOracleTool('ffprobe'), out);
        const video = probed.streams.find((s) => s.codec_type === 'video');
        expect(video?.codec_name).toBe('av1');
        expect(video?.tags?.ENCODER ?? probed.format.tags?.ENCODER ?? '').toMatch(/libsvtav1/);
        const measured = measureSsimPsnr(ffmpeg(), out, source);
        recordMetric('svt-av1 preset 8 720p 10 s: ssim', measured.ssim);
        expect(measured.ssim).toBeGreaterThanOrEqual(MODERN_CODEC_MIN_SSIM);
      });
    },
    ENCODE_TIMEOUT_MS
  );

  oracleTest(
    'VP9 with the speed settings matches the source',
    ['ffmpeg', 'ffprobe'],
    async () => {
      requireEncoders('libvpx-vp9', 'libx264');
      await withDir(async (dir) => {
        const source = clip(dir, '1280x720', 3);
        const started = Date.now();
        const result = await convertMedia(fs.readFileSync(source), 'mp4', 'webm', { video: { codec: 'vp9' } }, 'clip.mp4');
        const elapsed = Date.now() - started;
        const out = path.join(dir, 'out.webm');
        fs.writeFileSync(out, result.buffer);
        const measured = measureSsimPsnr(ffmpeg(), out, source);
        recordMetric('vp9 good cpu-used 2 row-mt 720p 3 s: encode ms', elapsed);
        recordMetric('vp9 good cpu-used 2 row-mt 720p 3 s: ssim', measured.ssim);
        expect(measured.ssim).toBeGreaterThanOrEqual(MODERN_CODEC_MIN_SSIM);
      });
    },
    ENCODE_TIMEOUT_MS
  );

  oracleTest(
    'a capped CRF encode stays inside the buffer model of its cap, and the uncapped encode of the same clip does not',
    ['ffmpeg', 'ffprobe'],
    async () => {
      requireEncoders('libx264');
      await withDir(async (dir) => {
        const SECONDS = 4;
        const source = clip(dir, '640x360', SECONDS);
        const CAP_K = 400;
        // Bits that fit in a clip under a leaky bucket of rate CAP and buffer 2 x CAP (a 2 s buffer): the cap's
        // bits over the whole clip, plus the buffer. A slack of 3% covers the rounding of frame sizes.
        const VBV_SLACK = 1.03;
        const allowedBits = (CAP_K * 1000 * SECONDS + CAP_K * 2 * 1000) * VBV_SLACK;
        const payloadBits = (bytes: Buffer, name: string): number => {
          const f = path.join(dir, `${name}.mp4`);
          fs.writeFileSync(f, bytes);
          const out = execFileSync(
            requireOracleTool('ffprobe'),
            ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=size', '-of', 'csv=p=0', f],
            { encoding: 'utf8' }
          );
          return out.split('\n').filter((l) => l !== '').reduce((sum, l) => sum + Number(l.split(',')[0]) * 8, 0);
        };
        const capped = await convertMedia(
          fs.readFileSync(source), 'mp4', 'mp4',
          { disableHwaccel: true, video: { codec: 'h264', rateControl: { mode: 'crf', crf: 20, maxBitrateK: CAP_K } } }, 'clip.mp4'
        );
        const uncapped = await convertMedia(
          fs.readFileSync(source), 'mp4', 'mp4',
          { disableHwaccel: true, video: { codec: 'h264', rateControl: { mode: 'crf', crf: 20 } } }, 'clip.mp4'
        );
        const cappedBits = payloadBits(capped.buffer, 'capped');
        const uncappedBits = payloadBits(uncapped.buffer, 'uncapped');
        recordMetric('capped crf: capped video kbit/s', cappedBits / SECONDS / 1000);
        recordMetric('capped crf: uncapped video kbit/s', uncappedBits / SECONDS / 1000);
        expect(cappedBits).toBeLessThanOrEqual(allowedBits);
        expect(uncappedBits).toBeGreaterThan(allowedBits);
      });
    },
    ENCODE_TIMEOUT_MS
  );
});

describe('deinterlacing (decoded output)', () => {
  const RATE_PROGRESSIVE = 50;
  const SECONDS = 2;
  /**
   * idet judges a frame from its neighbours, so its verdict on the first frames of a clip is not reliable (its
   * multi-frame detector calls the first five of this clip "tff" before it has history). The first frames are
   * skipped; every frame after them must be progressive and none interlaced.
   */
  const WARMUP_FRAMES = 10;
  const MIN_PROGRESSIVE_SHARE = 0.99;
  const MAX_INTERLACED_SHARE_AFTER = 0;
  const MIN_INTERLACED_SHARE_BEFORE = 0.9;

  function idet(file: string): { progressive: number; interlaced: number } {
    const run = spawnSync(ffmpeg(), ['-hide_banner', '-nostats', '-i', file, '-map', '0:v:0', '-vf', `select=gte(n\\,${WARMUP_FRAMES}),idet`, '-f', 'null', '-'], { encoding: 'utf8' });
    // ffmpeg configures the filter graph twice and the first instance sees no frames, so the last summary counts.
    const summaries = [...run.stderr.matchAll(/Multi frame detection: TFF:\s*(\d+) BFF:\s*(\d+) Progressive:\s*(\d+) Undetermined:\s*(\d+)/g)];
    const last = summaries[summaries.length - 1];
    if (!last) throw new Error(`idet printed no summary: ${run.stderr.slice(-300)}`);
    const [tff, bff, progressive, undetermined] = last.slice(1).map(Number);
    const total = tff + bff + progressive + undetermined;
    return { progressive: progressive / total, interlaced: (tff + bff) / total };
  }

  oracleTest(
    'an interlaced source is progressive after deinterlace (idet), one frame per field, and combing stays without it',
    ['ffmpeg', 'ffprobe'],
    async () => {
      requireEncoders('libx264');
      await withDir(async (dir) => {
        const source = path.join(dir, 'interlaced.mp4');
        // 50 progressive frames per second woven into 25 interlaced frames per second, top field first.
        execFileSync(ffmpeg(), [
          '-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=${RATE_PROGRESSIVE}:duration=${SECONDS}`,
          '-vf', 'interlace=scan=tff', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-flags', '+ilme+ildct', '-x264-params', 'tff=1', source,
        ]);
        const before = idet(source);
        recordMetric('idet before deinterlace: interlaced share', before.interlaced);
        expect(before.interlaced).toBeGreaterThanOrEqual(MIN_INTERLACED_SHARE_BEFORE);

        const kept = await convertMedia(fs.readFileSync(source), 'mp4', 'mp4', { disableHwaccel: true }, 'interlaced.mp4');
        const keptFile = path.join(dir, 'kept.mp4');
        fs.writeFileSync(keptFile, kept.buffer);

        const result = await convertMedia(fs.readFileSync(source), 'mp4', 'mp4', { disableHwaccel: true, video: { codec: 'h264', deinterlace: true } }, 'interlaced.mp4');
        const out = path.join(dir, 'progressive.mp4');
        fs.writeFileSync(out, result.buffer);
        const after = idet(out);
        recordMetric('idet after deinterlace: progressive share', after.progressive);
        expect(after.progressive).toBeGreaterThanOrEqual(MIN_PROGRESSIVE_SHARE);
        expect(after.interlaced).toBeLessThanOrEqual(MAX_INTERLACED_SHARE_AFTER);
        // send_field: one frame for each field, so 50 progressive frames per second out of 25 interlaced in.
        const frames = Number(
          execFileSync(requireOracleTool('ffprobe'), ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', out], { encoding: 'utf8' }).trim()
        );
        expect(frames).toBe(RATE_PROGRESSIVE * SECONDS);
        // The control: without the option the combing stays, so the oracle above can tell the difference.
        expect(idet(keptFile).progressive).toBeLessThan(after.progressive);
      });
    },
    ENCODE_TIMEOUT_MS
  );
});
