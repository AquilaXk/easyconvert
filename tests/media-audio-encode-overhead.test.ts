import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { measureLoudnessStage } from '../src/lib/conversions/media-audio-run';
import { buildFfmpegArguments, resetHardwareAccelerationCache } from '../src/lib/conversions/media-ffmpeg-args';
import { probeAudioChannels, probeAudioSampleRate } from '../src/lib/conversions/media-ffprobe';
import { ConversionFailedError } from '../src/lib/types';
import { convertWithNativeFfmpeg } from '../src/worker/engines';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { craftWav, int16Bytes, sineSamples } from './helpers/wav-craft';

/**
 * What an audio encode costs besides the encoder. A WAVE source describes itself in its header, so a conversion
 * needs no ffprobe for it and no stream analysis before the encoder starts; the encoded audio must still be the
 * audio the reference encoder writes at the same settings. The oracles are ffprobe for stream parameters and the
 * reference encoder, driven directly, for the decoded samples; the process counts come from recording wrappers
 * around the real binaries, not from the code under test.
 */

const TEST_TIMEOUT_MS = 180_000;
const MISSING_FFPROBE = '/nonexistent/ffprobe';
/** Encoder priming and padding add up to a few frames of the coded rate to the stored duration. */
const DURATION_TOLERANCE_S = 0.15;
const TONE_FREQUENCIES_HZ = [330, 1250] as const;
const TONE_AMPLITUDE = 9000;
const NOT_MONO = 2;

let workDir: string;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-audio-overhead-'));
});
afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** A WAVE file of a two-tone signal, so the encoders have something to code. */
function writeWav(name: string, rate: number, channels: number, seconds: number): string {
  const frames = Math.round(rate * seconds);
  const low = sineSamples(frames, channels, rate, TONE_FREQUENCIES_HZ[0], TONE_AMPLITUDE);
  const high = sineSamples(frames, channels, rate, TONE_FREQUENCIES_HZ[1], TONE_AMPLITUDE);
  const mixed = new Int16Array(low.length);
  for (let i = 0; i < mixed.length; i++) mixed[i] = Math.round((low[i] + high[i]) / 2);
  const file = path.join(workDir, name);
  fs.writeFileSync(file, craftWav({ sampleRate: rate, channels, bitsPerSample: 16, data: int16Bytes(mixed) }));
  return file;
}

function tool(name: 'ffmpeg' | 'ffprobe'): string {
  const found = getOracleToolPath(name);
  if (found === null) throw new Error(`${name} is not installed`);
  return found;
}

function argAfter(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

/**
 * A directory holding wrappers named `ffmpeg` and `ffprobe` that append every invocation to a log and then run the
 * real binary. Used as the sibling pair the engine resolves, it records exactly the processes a conversion starts.
 */
function recordingBinaries(label: string): { ffmpeg: string; calls: () => { tool: string; args: string[] }[] } {
  const dir = path.join(workDir, `wrappers-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(log, '');
  for (const name of ['ffmpeg', 'ffprobe'] as const) {
    const script = `#!/bin/sh\nprintf '%s' "${name}" >> '${log}'\nfor a in "$@"; do printf '\\t%s' "$a" >> '${log}'; done\nprintf '\\n' >> '${log}'\nexec '${tool(name)}' "$@"\n`;
    fs.writeFileSync(path.join(dir, name), script, { mode: 0o755 });
  }
  return {
    ffmpeg: path.join(dir, 'ffmpeg'),
    calls: () =>
      fs
        .readFileSync(log, 'utf-8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => {
          const [name, ...args] = line.split('\t');
          return { tool: name, args };
        }),
  };
}

describe('a WAVE source is described by its header', () => {
  const CASES = [
    { name: 'mono 8 kHz', rate: 8000, channels: 1 },
    { name: 'stereo 44.1 kHz', rate: 44_100, channels: 2 },
    { name: 'stereo 48 kHz', rate: 48_000, channels: 2 },
    { name: 'mono 22.05 kHz', rate: 22_050, channels: 1 },
  ] as const;

  it.each(CASES)('reads the rate and channels of $name without starting ffprobe', ({ name, rate, channels }) => {
    const file = writeWav(`probe-${rate}-${channels}.wav`, rate, channels, 0.2);
    expect(probeAudioSampleRate(file, MISSING_FFPROBE as never), name).toBe(rate);
    expect(probeAudioChannels(file, MISSING_FFPROBE as never), name).toBe(channels);
  });

  it('reports no stream for a track a WAVE file does not have', () => {
    const file = writeWav('probe-track.wav', 16_000, 1, 0.2);
    expect(probeAudioSampleRate(file, MISSING_FFPROBE as never, 1)).toBe(0);
    expect(probeAudioChannels(file, MISSING_FFPROBE as never, 1)).toBe(0);
  });

  it('still asks ffprobe for what the header reader cannot answer exactly', () => {
    const compressed = path.join(workDir, 'adpcm.wav');
    fs.writeFileSync(compressed, craftWav({ sampleRate: 8000, channels: 1, bitsPerSample: 16, formatTag: 2, data: new Uint8Array(2000) }));
    expect(() => probeAudioSampleRate(compressed, MISSING_FFPROBE as never)).toThrow(ConversionFailedError);
    expect(() => probeAudioChannels(path.join(workDir, 'absent.wav'), MISSING_FFPROBE as never)).toThrow(ConversionFailedError);
  });

  oracleTest(
    'agrees with ffprobe on every case',
    ['ffprobe'],
    () => {
      for (const { name, rate, channels } of CASES) {
        const file = writeWav(`oracle-${rate}-${channels}.wav`, rate, channels, 0.2);
        const reported = execFileSync(
          tool('ffprobe'),
          ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,channels', '-of', 'csv=p=0', file],
          { encoding: 'utf-8' }
        ).trim();
        expect(reported, name).toBe(`${rate},${channels}`);
        expect(probeAudioSampleRate(file, tool('ffprobe') as never), name).toBe(rate);
        expect(probeAudioChannels(file, tool('ffprobe') as never), name).toBe(channels);
      }
    },
    TEST_TIMEOUT_MS
  );
});

describe('the arguments of a WAVE to audio encode', () => {
  /** A sibling pair of ffmpeg and ffprobe whose ffprobe records that it ran; ffmpeg itself is never started. */
  function probeSpy(label: string): { ffmpeg: string; probeRuns: () => number } {
    const dir = path.join(workDir, `spy-${label}`);
    fs.mkdirSync(dir, { recursive: true });
    const marker = path.join(dir, 'ffprobe-ran');
    fs.writeFileSync(path.join(dir, 'ffprobe'), `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`, { mode: 0o755 });
    return { ffmpeg: path.join(dir, 'ffmpeg'), probeRuns: () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf-8').split('\n').length - 1 : 0) };
  }

  it('feeds libopus a 48 kHz source as it is: no rate argument and no resampling filter', () => {
    const spy = probeSpy('opus48');
    const input = writeWav('opus-48k.wav', 48_000, NOT_MONO, 0.3);
    const args = buildFfmpegArguments(input, path.join(workDir, 'o.opus'), 'wav', 'opus', {}, spy.ffmpeg);
    expect(argAfter(args, '-c:a')).toBe('libopus');
    expect(args).not.toContain('-ar');
    expect(args).not.toContain('-filter:a');
    expect(spy.probeRuns()).toBe(0);
  });

  it('resamples a 44.1 kHz source to the one rate libopus codes above it, and starts no ffprobe to find out', () => {
    const spy = probeSpy('opus44');
    const input = writeWav('opus-44k.wav', 44_100, NOT_MONO, 0.3);
    const args = buildFfmpegArguments(input, path.join(workDir, 'o.opus'), 'wav', 'opus', {}, spy.ffmpeg);
    expect(argAfter(args, '-ar')).toBe('48000');
    expect(args).not.toContain('-filter:a');
    expect(spy.probeRuns()).toBe(0);
  });

  it.each(['aac', 'm4a', 'opus', 'flac', 'mp3', 'ogg', 'weba', 'wav'])(
    'reads a header-described WAVE input with a minimal probe for the %s target',
    (target) => {
      const input = writeWav(`probe-args-${target}.wav`, 44_100, NOT_MONO, 0.3);
      const args = buildFfmpegArguments(input, path.join(workDir, `o.${target}`), 'wav', target, {}, null);
      const at = args.indexOf('-i');
      expect(args.slice(at - 2, at + 2)).toEqual(['-probesize', '32', '-i', input]);
    }
  );

  it('keeps the input probing when the header cannot describe the input', () => {
    const adpcm = path.join(workDir, 'probe-args-adpcm.wav');
    fs.writeFileSync(adpcm, craftWav({ sampleRate: 8000, channels: 1, bitsPerSample: 16, formatTag: 2, data: new Uint8Array(2000) }));
    const compressed = buildFfmpegArguments(adpcm, path.join(workDir, 'o.opus'), 'wav', 'opus', { audio: { sampleRate: 16_000 } }, null);
    expect(compressed.slice(0, compressed.indexOf('-i') + 2)).toEqual(['-y', '-i', adpcm]);
    const missing = path.join(workDir, 'absent.wav');
    const absent = buildFfmpegArguments(missing, path.join(workDir, 'o.aac'), 'wav', 'aac', {}, null);
    expect(absent.slice(0, absent.indexOf('-i') + 2)).toEqual(['-y', '-i', missing]);
  });

  it('keeps the input probing for a video target', () => {
    const input = writeWav('probe-args-video.wav', 44_100, NOT_MONO, 0.3);
    const args = buildFfmpegArguments(input, path.join(workDir, 'o.mp4'), 'wav', 'mp4', { disableHwaccel: true }, null);
    expect(args.slice(0, args.indexOf('-i') + 2)).toEqual(['-y', '-i', input]);
  });
});

describe('loudness is measured only when it is asked for', () => {
  const LOUDNORM_REPORT =
    '{ "input_i" : "-23.50", "input_tp" : "-6.10", "input_lra" : "4.20", "input_thresh" : "-33.90", "output_i" : "-16.00", "output_tp" : "-1.50", "output_lra" : "3.50", "output_thresh" : "-26.40", "normalization_type" : "dynamic", "target_offset" : "0.00" }';

  it('starts no measuring pass for a plain encode', async () => {
    const input = writeWav('loud-none.wav', 44_100, NOT_MONO, 0.3);
    const runs: string[][] = [];
    const stage = await measureLoudnessStage({
      inputPath: input,
      src: 'wav',
      tgt: 'opus',
      options: { audio: { bitrateK: 64 } },
      ffmpegBin: '/nonexistent/ffmpeg',
      run: async (args) => {
        runs.push(args);
        return { stderr: Buffer.from('') };
      },
    });
    expect(stage).toBeUndefined();
    expect(runs).toEqual([]);
  });

  it('runs one measuring pass over exactly the audio the encode writes when normalisation is requested', async () => {
    const input = writeWav('loud-on.wav', 44_100, NOT_MONO, 0.3);
    const runs: string[][] = [];
    const stage = await measureLoudnessStage({
      inputPath: input,
      src: 'wav',
      tgt: 'opus',
      options: { audio: { bitrateK: 64, loudness: { preset: 'podcast' } } },
      ffmpegBin: MISSING_FFPROBE.replace('ffprobe', 'ffmpeg'),
      run: async (args) => {
        runs.push(args);
        return { stderr: Buffer.from(LOUDNORM_REPORT) };
      },
    });
    expect(runs).toHaveLength(1);
    expect(argAfter(runs[0], '-ar')).toBe('48000');
    expect(argAfter(runs[0], '-af')).toMatch(/^loudnorm=.*print_format=json$/);
    expect(runs[0].slice(-3)).toEqual(['-f', 'null', '-']);
    expect(stage).toEqual({
      kind: 'apply',
      measurement: { inputI: -23.5, inputTp: -6.1, inputLra: 4.2, inputThresh: -33.9, targetOffset: 0, sampleRate: 44_100 },
    });
  });
});

describe('an audio conversion asks which encoders exist and opens no hardware session', () => {
  /**
   * A sibling pair whose ffmpeg lists a hardware video encoder on top of the real list and logs every call. The
   * Ubuntu build lists them all, so a hardware session probe would start another ffmpeg there; no host needs one
   * to write audio.
   */
  function hardwareListingBinaries(label: string): { ffmpeg: string; calls: () => string[] } {
    const dir = path.join(workDir, `hw-listing-${label}`);
    fs.mkdirSync(dir, { recursive: true });
    const log = path.join(dir, 'calls.log');
    fs.writeFileSync(log, '');
    const real = tool('ffmpeg');
    const script = `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase " $* " in\n  *" -encoders "*) '${real}' "$@"; printf ' V....D h264_nvenc NVIDIA NVENC H.264 encoder\\n'; exit 0;;\nesac\nexec '${real}' "$@"\n`;
    fs.writeFileSync(path.join(dir, 'ffmpeg'), script, { mode: 0o755 });
    return {
      ffmpeg: path.join(dir, 'ffmpeg'),
      calls: () => fs.readFileSync(log, 'utf-8').split('\n').filter((line) => line !== ''),
    };
  }

  oracleTest(
    'lists the encoders once per binary and starts no ffmpeg that reads an input',
    ['ffmpeg', 'ffprobe'],
    () => {
      resetHardwareAccelerationCache();
      const input = writeWav('hw-listing.wav', 44_100, 2, 0.2);
      const binaries = hardwareListingBinaries('opus');
      for (let conversion = 0; conversion < 3; conversion++) {
        const args = buildFfmpegArguments(input, path.join(workDir, `hw-listing-${conversion}.opus`), 'wav', 'opus', { audio: { bitrateK: 64 } }, binaries.ffmpeg);
        expect(args).toContain('libopus');
      }
      const calls = binaries.calls();
      expect(calls.filter((call) => call.includes('-encoders'))).toHaveLength(1);
      expect(calls.filter((call) => /(^| )-i /.test(call))).toEqual([]);
      resetHardwareAccelerationCache();
    },
    TEST_TIMEOUT_MS
  );
});

describe('the engine starts one process for a WAVE to Opus or AAC conversion', () => {
  const previousFfmpeg = process.env.FFMPEG_PATH;
  afterAll(() => {
    if (previousFfmpeg === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = previousFfmpeg;
  });

  const ROWS = [
    { target: 'opus', codec: 'opus', rate: 44_100, channels: 2, expectedRate: '48000', expectedCodec: 'opus' },
    { target: 'opus', codec: 'opus', rate: 48_000, channels: 2, expectedRate: '48000', expectedCodec: 'opus' },
    // libopus codes 16 kHz natively, and ffprobe reports every Opus stream at the 48 kHz of the decoder output.
    { target: 'opus', codec: 'opus', rate: 16_000, channels: 1, expectedRate: '48000', expectedCodec: 'opus' },
    { target: 'aac', codec: 'aac', rate: 44_100, channels: 2, expectedRate: '44100', expectedCodec: 'aac' },
    { target: 'aac', codec: 'aac', rate: 16_000, channels: 1, expectedRate: '16000', expectedCodec: 'aac' },
  ] as const;

  for (const row of ROWS) {
    oracleTest(
      `${row.rate} Hz x${row.channels} to ${row.target}: no ffprobe, one ffmpeg conversion, the reference stream parameters`,
      ['ffmpeg', 'ffprobe'],
      async () => {
        const input = writeWav(`engine-${row.target}-${row.rate}.wav`, row.rate, row.channels, 1);
        const recorder = recordingBinaries(`${row.target}-${row.rate}`);
        process.env.FFMPEG_PATH = recorder.ffmpeg;
        const result = await convertWithNativeFfmpeg(
          fs.readFileSync(input),
          'wav',
          row.target,
          { audio: { codec: row.codec, bitrateK: 64 }, throwOnUnavailable: true },
          'in.wav'
        );
        if (result === null || result.filePath === undefined) throw new Error('the engine returned no output file');
        const written = result.filePath;

        const calls = recorder.calls();
        const probes = calls.filter((call) => call.tool === 'ffprobe');
        const conversions = calls.filter((call) => call.tool === 'ffmpeg' && call.args.includes('-i'));
        expect(probes.map((call) => call.args.join(' '))).toEqual([]);
        expect(conversions).toHaveLength(1);
        expect(conversions[0].args).toContain(row.expectedCodec === 'opus' ? 'libopus' : 'aac');

        const stream = JSON.parse(
          execFileSync(tool('ffprobe'), ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels:format=duration', '-of', 'json', written], {
            encoding: 'utf-8',
          })
        ) as { streams: { codec_name: string; sample_rate: string; channels: number }[]; format: { duration: string } };
        expect(stream.streams).toHaveLength(1);
        expect(stream.streams[0].codec_name).toBe(row.expectedCodec);
        expect(stream.streams[0].sample_rate).toBe(row.expectedRate);
        expect(stream.streams[0].channels).toBe(row.channels);
        expect(Math.abs(Number(stream.format.duration) - 1)).toBeLessThan(DURATION_TOLERANCE_S);
        fs.rmSync(written, { force: true });
      },
      TEST_TIMEOUT_MS
    );
  }
});

describe('a minimal input probe leaves the encoded audio as the reference encoder writes it', () => {
  const TARGETS = [
    { target: 'aac', referenceArgs: ['-c:a', 'aac', '-f', 'adts', '-b:a', '64k'] },
    { target: 'm4a', referenceArgs: ['-c:a', 'aac', '-f', 'ipod', '-b:a', '64k'] },
    { target: 'opus', referenceArgs: ['-c:a', 'libopus', '-f', 'opus', '-b:a', '64k'] },
    { target: 'mp3', referenceArgs: ['-c:a', 'libmp3lame', '-f', 'mp3', '-b:a', '64k'] },
  ] as const;

  function run(args: string[]): void {
    execFileSync(tool('ffmpeg'), ['-hide_banner', '-nostdin', '-v', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  /** Whether this ffmpeg build was configured with libsoxr (Debian and Ubuntu builds are; Homebrew's is not). */
  function hasSoxr(): boolean {
    return execFileSync(tool('ffmpeg'), ['-hide_banner', '-buildconf'], { encoding: 'utf-8' }).includes('--enable-libsoxr');
  }

  /** MD5 of the decoded 16-bit samples, which is what a listener hears. */
  function decodedMd5(file: string): string {
    const out = execFileSync(tool('ffmpeg'), ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-f', 's16le', '-c:a', 'pcm_s16le', '-f', 'md5', '-'], {
      encoding: 'utf-8',
    });
    return out.trim();
  }

  function streamFacts(file: string): string {
    return execFileSync(
      tool('ffprobe'),
      ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,channels,bit_rate,duration_ts:format=duration', '-of', 'json', file],
      { encoding: 'utf-8' }
    );
  }

  for (const { target, referenceArgs } of TARGETS) {
    for (const [rate, channels] of [
      [44_100, 2],
      [16_000, 1],
    ] as const) {
      oracleTest(
        `${target} from ${rate} Hz x${channels} decodes to the samples of the reference encode and carries its stream parameters`,
        ['ffmpeg', 'ffprobe'],
        () => {
          const input = writeWav(`same-${target}-${rate}.wav`, rate, channels, 2);
          const ours = path.join(workDir, `same-ours-${rate}.${target}`);
          const minimal = buildFfmpegArguments(input, ours, 'wav', target, { audio: { bitrateK: 64 } }, tool('ffmpeg'));
          expect(minimal).toContain('-probesize');
          run(minimal);

          const reference = path.join(workDir, `same-ref-${rate}.${target}`);
          // libopus codes 48 kHz, so a 44.1 kHz source is resampled. The reference resamples as the quality default
          // documents for a lossy encoder: soxr at 16 bits of precision, else swresample.
          const resampleTo48k = hasSoxr() ? ['-ar', '48000', '-filter:a', 'aresample=48000:resampler=soxr:precision=16'] : ['-ar', '48000'];
          const referenceRate = target === 'opus' && rate === 44_100 ? resampleTo48k : [];
          run(['-y', '-i', input, '-vn', '-map_metadata', '-1', ...referenceArgs, ...referenceRate, reference]);

          expect(decodedMd5(ours)).toBe(decodedMd5(reference));
          expect(streamFacts(ours)).toBe(streamFacts(reference));
        },
        TEST_TIMEOUT_MS
      );
    }
  }
});

describe('the encoded file is handed over, not copied', () => {
  const previousFfmpeg = process.env.FFMPEG_PATH;
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(() => {
    if (previousFfmpeg === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = previousFfmpeg;
  });

  /** Duration and codec of a written file, from ffprobe. */
  function describeFile(file: string): { codec: string; seconds: number } {
    const probed = JSON.parse(
      execFileSync(tool('ffprobe'), ['-v', 'error', '-show_entries', 'stream=codec_name:format=duration', '-of', 'json', file], { encoding: 'utf-8' })
    ) as { streams: { codec_name: string }[]; format: { duration: string } };
    return { codec: probed.streams[0].codec_name, seconds: Number(probed.format.duration) };
  }

  oracleTest(
    'an output nobody named a place for is moved out of the job directory with no second write of its bytes',
    ['ffmpeg', 'ffprobe'],
    async () => {
      const input = writeWav('handoff.wav', 44_100, NOT_MONO, 1);
      const copies = vi.spyOn(fs, 'copyFileSync');
      const result = await convertWithNativeFfmpeg(fs.readFileSync(input), 'wav', 'opus', { audio: { codec: 'opus', bitrateK: 64 }, throwOnUnavailable: true }, 'in.wav');
      if (result === null || result.filePath === undefined) throw new Error('the engine returned no output file');
      expect(copies).not.toHaveBeenCalled();
      expect(describeFile(result.filePath).codec).toBe('opus');
      expect(Math.abs(describeFile(result.filePath).seconds - 1)).toBeLessThan(DURATION_TOLERANCE_S);
      expect(result.size).toBe(fs.statSync(result.filePath).size);
      fs.rmSync(result.filePath, { force: true });
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'an output the caller named a path for is written there, and the file already at that path is replaced',
    ['ffmpeg', 'ffprobe'],
    async () => {
      const input = writeWav('handoff-named.wav', 44_100, NOT_MONO, 1);
      const wanted = path.join(workDir, 'named-output.opus');
      fs.writeFileSync(wanted, 'stale');
      const result = await convertWithNativeFfmpeg(
        fs.readFileSync(input), 'wav', 'opus', { audio: { codec: 'opus', bitrateK: 64 }, throwOnUnavailable: true, outputPath: wanted } as never, 'in.wav'
      );
      expect(result?.filePath).toBe(wanted);
      expect(describeFile(wanted).codec).toBe('opus');
    },
    TEST_TIMEOUT_MS
  );
});
