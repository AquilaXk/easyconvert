import { describe, expect, beforeAll, afterAll, afterEach, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { oracleTest } from './helpers/oracle-test';
import { getOracleToolPath } from './helpers/differential-oracle';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { convertMedia } from '../src/lib/conversions/media';
import {
  AUDIO_TARGET_SPECS,
  NoAudioStreamError,
  UNENCODABLE_AUDIO_TARGETS,
} from '../src/lib/conversions/media-audio-targets';
import {
  buildFfmpegArguments,
  probeHardwareAcceleration,
  resetHardwareAccelerationCache,
} from '../src/lib/conversions/media-ffmpeg-args';
import { ConversionFailedError, EngineUnavailableError, InvalidMediaOptionError } from '../src/lib/types';

/**
 * Audio-only targets must write exactly one audio stream in the codec and container the target
 * names. Expected codecs below are authored by hand from the container specifications and the
 * ffprobe codec names; they are not read from the module under test. Inputs come from ffmpeg lavfi
 * sources and every output is read back with ffprobe and decoded with ffmpeg.
 */

const SAMPLE_RATE = 48000;
const CLIP_SECONDS = 0.5;
const TONE_HZ = 440;
const SECOND_TONE_HZ = 880;
const LOW_SAMPLE_RATE = 32000;
const PCM_BYTES_PER_SAMPLE = 2;
/** Lossless targets must decode back to the source with at least this signal-to-noise ratio. */
const MIN_LOSSLESS_SNR_DB = 60;
/** A different tone must not reach the SNR a correct track selection gets. */
const MAX_WRONG_TRACK_SNR_DB = 20;
/** The lavfi sine peaks at 1/8 of full scale, so its RMS in 16-bit steps is about 2900. */
const MIN_TONE_RMS = 1000;
const MAX_LOSSY_RMS_RATIO = 1.5;
const MIN_LOSSY_RMS_RATIO = 0.5;
const FFMPEG_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 120_000;

interface ExpectedAudioTarget {
  /** ffprobe codec_name of the single output stream. */
  codec: string;
  /** ffmpeg encoder name the target needs; the target fails closed when the build lacks it. */
  encoder: string;
  /** Lossless targets decode back to the source; lossy ones are compared by duration. */
  lossless: boolean;
  /** Codec frame length in samples: the duration tolerance of a lossy target. */
  frameSamples?: number;
  /** Frames of tolerance; raw ADTS has no edit list, so its encoder priming frame stays in the stream. */
  toleranceFrames?: number;
  /** Fixed output sample rate (Hz) and channel count for narrowband targets. */
  fixedSampleRate?: number;
  fixedChannels?: number;
}

const MP3_FRAME_SAMPLES = 1152;
const AAC_FRAME_SAMPLES = 1024;
const VORBIS_FRAME_SAMPLES = 2048;
const OPUS_FRAME_SAMPLES = 960;
const WMA_FRAME_SAMPLES = 2048;
const AC3_FRAME_SAMPLES = 1536;
const AMR_FRAME_SAMPLES = 160;
const AMR_SAMPLE_RATE = 8000;

const EXPECTED: Readonly<Record<string, ExpectedAudioTarget>> = {
  mp3: { codec: 'mp3', encoder: 'libmp3lame', lossless: false, frameSamples: MP3_FRAME_SAMPLES },
  aac: { codec: 'aac', encoder: 'aac', lossless: false, frameSamples: AAC_FRAME_SAMPLES, toleranceFrames: 2 },
  m4a: { codec: 'aac', encoder: 'aac', lossless: false, frameSamples: AAC_FRAME_SAMPLES },
  m4b: { codec: 'aac', encoder: 'aac', lossless: false, frameSamples: AAC_FRAME_SAMPLES },
  ogg: { codec: 'vorbis', encoder: 'libvorbis', lossless: false, frameSamples: VORBIS_FRAME_SAMPLES },
  oga: { codec: 'vorbis', encoder: 'libvorbis', lossless: false, frameSamples: VORBIS_FRAME_SAMPLES },
  opus: { codec: 'opus', encoder: 'libopus', lossless: false, frameSamples: OPUS_FRAME_SAMPLES },
  weba: { codec: 'opus', encoder: 'libopus', lossless: false, frameSamples: OPUS_FRAME_SAMPLES },
  wma: { codec: 'wmav2', encoder: 'wmav2', lossless: false, frameSamples: WMA_FRAME_SAMPLES },
  ac3: { codec: 'ac3', encoder: 'ac3', lossless: false, frameSamples: AC3_FRAME_SAMPLES },
  amr: {
    codec: 'amr_nb',
    encoder: 'libopencore_amrnb',
    lossless: false,
    frameSamples: AMR_FRAME_SAMPLES,
    fixedSampleRate: AMR_SAMPLE_RATE,
    fixedChannels: 1,
  },
  flac: { codec: 'flac', encoder: 'flac', lossless: true },
  alac: { codec: 'alac', encoder: 'alac', lossless: true },
  wav: { codec: 'pcm_s16le', encoder: 'pcm_s16le', lossless: true },
  aiff: { codec: 'pcm_s16be', encoder: 'pcm_s16be', lossless: true },
  aif: { codec: 'pcm_s16be', encoder: 'pcm_s16be', lossless: true },
  au: { codec: 'pcm_s16be', encoder: 'pcm_s16be', lossless: true },
  aifc: { codec: 'pcm_s16le', encoder: 'pcm_s16le', lossless: true },
  caf: { codec: 'pcm_s16le', encoder: 'pcm_s16le', lossless: true },
  voc: { codec: 'pcm_s16le', encoder: 'pcm_s16le', lossless: true },
};

/** ffmpeg encoder names expected in the argument list, and the muxer that names the container. */
const EXPECTED_MUXER: Readonly<Record<string, string>> = {
  mp3: 'mp3',
  aac: 'adts',
  m4a: 'ipod',
  m4b: 'ipod',
  ogg: 'ogg',
  oga: 'ogg',
  opus: 'opus',
  weba: 'webm',
  wma: 'asf',
  ac3: 'ac3',
  amr: 'amr',
  flac: 'flac',
  alac: 'ipod',
  wav: 'wav',
  aiff: 'aiff',
  aif: 'aiff',
  au: 'au',
  aifc: 'aiff',
  caf: 'caf',
  voc: 'voc',
};

/** ffprobe format_name of each target's container, authored from the container specifications. */
const MOV_FORMAT = 'mov,mp4,m4a,3gp,3g2,mj2';
const EXPECTED_FORMAT: Readonly<Record<string, string>> = {
  mp3: 'mp3',
  aac: 'aac',
  m4a: MOV_FORMAT,
  m4b: MOV_FORMAT,
  alac: MOV_FORMAT,
  ogg: 'ogg',
  oga: 'ogg',
  opus: 'ogg',
  weba: 'matroska,webm',
  wma: 'asf',
  ac3: 'ac3',
  amr: 'amr',
  flac: 'flac',
  wav: 'wav',
  aiff: 'aiff',
  aif: 'aiff',
  aifc: 'aiff',
  au: 'au',
  caf: 'caf',
  voc: 'voc',
};
/** Bytes 8..12 of a FORM file: AIFF for aiff and aif, AIFC (compressed, little-endian "sowt") for aifc. */
const FORM_TYPE_OFFSET = 8;
const FORM_TYPE_LENGTH = 4;
const EXPECTED_FORM_TYPE: Readonly<Record<string, string>> = { aiff: 'AIFF', aif: 'AIFF', aifc: 'AIFC' };

const IDS = Object.keys(EXPECTED);

let workDir: string;
let ffmpegEncoders: Set<string> | null = null;

function ffmpeg(args: string[]): Buffer {
  return execFileSync(getOracleToolPath('ffmpeg')!, ['-v', 'error', '-y', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: FFMPEG_TIMEOUT_MS,
  });
}

interface ProbedStream {
  codec_type: string;
  codec_name: string;
  sample_rate?: string;
  channels?: number;
}

function ffprobeStreams(file: string): ProbedStream[] {
  const out = execFileSync(getOracleToolPath('ffprobe')!, ['-v', 'error', '-show_streams', '-of', 'json', file], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: FFMPEG_TIMEOUT_MS,
  }).toString('utf-8');
  return (JSON.parse(out) as { streams: ProbedStream[] }).streams;
}

function ffprobeFormatName(file: string): string {
  return execFileSync(getOracleToolPath('ffprobe')!, ['-v', 'error', '-show_entries', 'format=format_name', '-of', 'default=noprint_wrappers=1:nokey=1', file], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: FFMPEG_TIMEOUT_MS,
  })
    .toString('utf-8')
    .trim();
}

/** Whether the ffmpeg under test lists an encoder, read from `ffmpeg -encoders` independently of the code under test. */
function ffmpegHasEncoder(encoder: string): boolean {
  if (ffmpegEncoders === null) {
    const listing = execFileSync(getOracleToolPath('ffmpeg')!, ['-hide_banner', '-encoders'], { timeout: FFMPEG_TIMEOUT_MS }).toString('utf-8');
    ffmpegEncoders = new Set<string>();
    for (const line of listing.split('\n')) {
      const match = /^\s*[VAS][A-Za-z.]{5}\s+(\S+)/.exec(line);
      if (match) ffmpegEncoders.add(match[1]);
    }
  }
  return ffmpegEncoders.has(encoder);
}

/** Decodes one audio stream of a file to mono s16le samples at its own sample rate. */
function decodePcm(file: string, trackIndex = 0): { samples: Int16Array; sampleRate: number } {
  const stream = ffprobeStreams(file).filter((s) => s.codec_type === 'audio')[trackIndex];
  const sampleRate = Number(stream.sample_rate);
  const raw = ffmpeg(['-i', file, '-map', `0:a:${trackIndex}`, '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', '-']);
  const samples = new Int16Array(raw.length / PCM_BYTES_PER_SAMPLE);
  for (let i = 0; i < samples.length; i++) samples[i] = raw.readInt16LE(i * PCM_BYTES_PER_SAMPLE);
  return { samples, sampleRate };
}

function rms(samples: Int16Array): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

/** Signal-to-noise ratio in dB of `decoded` against `reference`; Infinity for identical samples. */
function snrDb(reference: Int16Array, decoded: Int16Array): number {
  expect(decoded).toHaveLength(reference.length);
  let signal = 0;
  let noise = 0;
  for (let i = 0; i < reference.length; i++) {
    signal += reference[i] * reference[i];
    const diff = reference[i] - decoded[i];
    noise += diff * diff;
  }
  return noise === 0 ? Infinity : 10 * Math.log10(signal / noise);
}

function sineSource(frequency: number): string[] {
  return ['-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=${SAMPLE_RATE}:duration=${CLIP_SECONDS}`];
}

const VIDEO_SOURCE = ['-f', 'lavfi', '-i', `testsrc2=size=160x120:rate=25:duration=${CLIP_SECONDS}`];

const inputs = new Map<string, string>();

/** Builds a lazily created input; the lavfi tools are only needed once a test actually runs. */
function input(name: string, build: (file: string) => void): string {
  let file = inputs.get(name);
  if (file === undefined) {
    file = path.join(workDir, name);
    build(file);
    inputs.set(name, file);
  }
  return file;
}

/** Video plus a lossless PCM tone: the output of a PCM target must equal this tone exactly. */
function videoWithAudio(): string {
  return input('av.mkv', (file) =>
    ffmpeg([...VIDEO_SOURCE, ...sineSource(TONE_HZ), '-c:v', 'mpeg4', '-c:a', 'pcm_s16le', '-shortest', file])
  );
}

/** Audio-only AAC elementary stream (ADTS), the "aac -> aiff" source of the report. */
function aacOnly(): string {
  return input('tone.aac', (file) => ffmpeg([...sineSource(TONE_HZ), '-c:a', 'aac', '-f', 'adts', file]));
}

/** Video plus two audio tracks (440 Hz, then 880 Hz). */
function twoTrackVideo(): string {
  return input('two-track.mkv', (file) =>
    ffmpeg([
      ...VIDEO_SOURCE, ...sineSource(TONE_HZ), ...sineSource(SECOND_TONE_HZ),
      '-map', '0:v', '-map', '1:a', '-map', '2:a',
      '-c:v', 'mpeg4', '-c:a', 'pcm_s16le', '-shortest', file,
    ])
  );
}

/** Narrowband mono speech-like input: fixed default bitrates that suit music can fail on it. */
function lowRateMono(): string {
  return input('low-rate.wav', (file) =>
    ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=${TONE_HZ}:sample_rate=${LOW_SAMPLE_RATE}:duration=${CLIP_SECONDS}`, '-ac', '1', file])
  );
}

/** Video only, no audio stream. */
function silentVideo(): string {
  return input('silent.mp4', (file) => ffmpeg([...VIDEO_SOURCE, '-c:v', 'mpeg4', '-an', file]));
}

let outputCounter = 0;

async function convertToFile(file: string, src: string, tgt: string, options = {}): Promise<string> {
  const result = await convertMedia(fs.readFileSync(file), src, tgt, options, 'clip');
  outputCounter += 1;
  const out = path.join(workDir, `out-${outputCounter}.${tgt}`);
  fs.writeFileSync(out, result.buffer);
  return out;
}

/** Lists the encoders of a stand-in ffmpeg whose `-encoders` output lacks the given encoder. */
function makeFfmpegWithout(name: string, missing: string): string {
  const dir = path.join(workDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'ffmpeg');
  const lines = Object.values(EXPECTED)
    .map((spec) => spec.encoder)
    .filter((encoder) => encoder !== missing)
    .map((encoder) => ` A....D ${encoder}  audio encoder`);
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "${lines.join('\n')}"\n`, { mode: 0o755 });
  return bin;
}

function argAfter(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-audio-targets-'));
});

afterEach(() => {
  resetHardwareAccelerationCache();
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('audio target table', () => {
  const advertisedAudioTargets = [
    ...new Set(
      Object.values(FORMAT_REGISTRY).flatMap((def) =>
        def.targetFormats.filter((target) => FORMAT_REGISTRY[target]?.category === 'audio')
      )
    ),
  ].sort();

  it('covers every audio id any registry entry advertises as a target', () => {
    const covered = new Set([...Object.keys(AUDIO_TARGET_SPECS), ...Object.keys(UNENCODABLE_AUDIO_TARGETS)]);
    expect(advertisedAudioTargets.filter((id) => !covered.has(id))).toEqual([]);
  });

  it('has a hand-authored expectation for every advertised audio target except the unencodable one', () => {
    const unencodable = Object.keys(UNENCODABLE_AUDIO_TARGETS);
    expect(unencodable).toEqual(['dss']);
    expect(advertisedAudioTargets.filter((id) => !IDS.includes(id) && !unencodable.includes(id))).toEqual([]);
    expect(IDS.filter((id) => !(id in AUDIO_TARGET_SPECS))).toEqual([]);
  });
});

describe('encoder capability probe', () => {
  it('reads encoder rows that carry the direct-rendering flag', () => {
    // Rows copied from the format of `ffmpeg -encoders`: nearly every encoder ends in the D flag.
    const dir = path.join(workDir, 'listing');
    fs.mkdirSync(dir, { recursive: true });
    const bin = path.join(dir, 'ffmpeg');
    const rows = [' V....D h264_nvenc NVIDIA NVENC H.264', ' A....D libmp3lame libmp3lame MP3', ' A..X.. opus experimental', ' S..... srt SubRip'];
    fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "Encoders:\n ------\n${rows.join('\n')}"\n`, { mode: 0o755 });
    const encoders = probeHardwareAcceleration(bin).supportedEncoders;
    expect([...encoders].sort()).toEqual(['h264_nvenc', 'libmp3lame', 'opus', 'srt']);
  });

  oracleTest('lists every audio encoder the installed ffmpeg reports', ['ffmpeg'], () => {
    const encoders = probeHardwareAcceleration(getOracleToolPath('ffmpeg')).supportedEncoders;
    const reported = IDS.map((id) => EXPECTED[id].encoder).filter((encoder) => ffmpegHasEncoder(encoder));
    expect(reported.length).toBeGreaterThan(0);
    expect(reported.filter((encoder) => !encoders.has(encoder))).toEqual([]);
  });
});

describe('audio-only argument construction', () => {
  it.each(IDS)('%s maps one audio stream and drops video, subtitles and data', (id) => {
    const args = buildFfmpegArguments('/nonexistent/in.mkv', `/tmp/out.${id}`, 'mkv', id, { disableHwaccel: true });
    expect(args).toEqual(expect.arrayContaining(['-vn', '-sn', '-dn']));
    const mapIdx = args.indexOf('-map');
    expect(args.slice(mapIdx, mapIdx + 2)).toEqual(['-map', '0:a:0']);
    expect(args.filter((a) => a === '-map')).toHaveLength(1);
    expect(argAfter(args, '-c:a')).toBe(EXPECTED[id].encoder);
    expect(argAfter(args, '-f')).toBe(EXPECTED_MUXER[id]);
  });

  it('selects the requested audio track', () => {
    const args = buildFfmpegArguments('/nonexistent/in.mkv', '/tmp/out.flac', 'mkv', 'flac', { audio: { track: 2 } });
    expect(argAfter(args, '-map')).toBe('0:a:2');
  });

  it('rejects a track selection an audio-only file cannot hold', () => {
    expect(() =>
      buildFfmpegArguments('/nonexistent/in.mkv', '/tmp/out.flac', 'mkv', 'flac', { audio: { track: 'all' } })
    ).toThrow(InvalidMediaOptionError);
    expect(() =>
      buildFfmpegArguments('/nonexistent/in.mkv', '/tmp/out.flac', 'mkv', 'flac', { audio: { track: -1 } })
    ).toThrow(InvalidMediaOptionError);
  });

  it('rejects an audio codec the target container cannot carry', () => {
    expect(() =>
      buildFfmpegArguments('/nonexistent/in.mkv', '/tmp/out.mp3', 'mkv', 'mp3', { audio: { codec: 'flac' } })
    ).toThrow(InvalidMediaOptionError);
    const ogg = buildFfmpegArguments('/nonexistent/in.mkv', '/tmp/out.ogg', 'mkv', 'ogg', { audio: { codec: 'opus' } });
    expect(argAfter(ogg, '-c:a')).toBe('libopus');
  });

  it('keeps lossless targets free of a default bitrate and lossy ones on an explicit rate', () => {
    expect(buildFfmpegArguments('/nonexistent/in.mkv', '/tmp/o.aiff', 'mkv', 'aiff', {})).not.toContain('-b:a');
    expect(argAfter(buildFfmpegArguments('/nonexistent/in.mkv', '/tmp/o.ac3', 'mkv', 'ac3', {}), '-b:a')).toBe('192k');
    expect(argAfter(buildFfmpegArguments('/nonexistent/in.mkv', '/tmp/o.opus', 'mkv', 'opus', {}), '-b:a')).toBe('128k');
  });

  it('pins AMR to 8 kHz mono and rejects a conflicting request', () => {
    const args = buildFfmpegArguments('/nonexistent/in.mkv', '/tmp/o.amr', 'mkv', 'amr', {});
    expect(argAfter(args, '-ar')).toBe('8000');
    expect(argAfter(args, '-ac')).toBe('1');
    expect(() =>
      buildFfmpegArguments('/nonexistent/in.mkv', '/tmp/o.amr', 'mkv', 'amr', { audio: { sampleRate: 44100 } })
    ).toThrow(InvalidMediaOptionError);
    expect(() =>
      buildFfmpegArguments('/nonexistent/in.mkv', '/tmp/o.amr', 'mkv', 'amr', { audio: { channels: 2 } })
    ).toThrow(InvalidMediaOptionError);
  });

  it('fails closed with an EngineUnavailableError (503, not 400) when the FFmpeg build lacks the encoder', () => {
    const bin = makeFfmpegWithout('no-wmav2', 'wmav2');
    const attempt = () => buildFfmpegArguments('/nonexistent/in.mkv', '/tmp/o.wma', 'mkv', 'wma', {}, bin);
    expect(attempt).toThrow(EngineUnavailableError);
    expect(attempt).toThrow(/no 'wmav2' encoder/);
    // The same stand-in still encodes a target whose encoder it lists.
    resetHardwareAccelerationCache();
    expect(argAfter(buildFfmpegArguments('/nonexistent/in.mkv', '/tmp/o.mp3', 'mkv', 'mp3', {}, bin), '-c:a')).toBe('libmp3lame');
  });

  it('fails closed for an advertised audio target FFmpeg cannot encode at all', () => {
    const attempt = () => buildFfmpegArguments('/nonexistent/in.dss', '/tmp/o.dss', 'dss', 'dss', {});
    expect(attempt).toThrow(ConversionFailedError);
    expect(attempt).toThrow(/dss/);
  });
});

describe('audio-only conversions decoded with ffmpeg', () => {
  for (const id of IDS) {
    const expected = EXPECTED[id];

    for (const [label, source, src] of [
      ['video with audio', videoWithAudio, 'mkv'],
      ['audio-only AAC', aacOnly, 'aac'],
    ] as const) {
      oracleTest(`${label} -> ${id} yields one ${expected.codec} audio stream`, ['ffmpeg', 'ffprobe'], async () => {
        const inputFile = source();
        if (!ffmpegHasEncoder(expected.encoder)) {
          // No substitute codec: a build without the encoder rejects the target.
          await expect(convertMedia(fs.readFileSync(inputFile), src, id, {}, 'clip')).rejects.toThrow(EngineUnavailableError);
          await expect(convertMedia(fs.readFileSync(inputFile), src, id, {}, 'clip')).rejects.toThrow(expected.encoder);
          return;
        }

        const out = await convertToFile(inputFile, src, id);
        const streams = ffprobeStreams(out);
        expect(streams.map((s) => `${s.codec_type}:${s.codec_name}`)).toEqual([`audio:${expected.codec}`]);
        expect(ffprobeFormatName(out)).toBe(EXPECTED_FORMAT[id]);
        const formType = EXPECTED_FORM_TYPE[id];
        if (formType) {
          expect(fs.readFileSync(out).toString('latin1', FORM_TYPE_OFFSET, FORM_TYPE_OFFSET + FORM_TYPE_LENGTH)).toBe(formType);
        }
        if (expected.fixedSampleRate !== undefined) expect(Number(streams[0].sample_rate)).toBe(expected.fixedSampleRate);
        if (expected.fixedChannels !== undefined) expect(streams[0].channels).toBe(expected.fixedChannels);

        const reference = decodePcm(inputFile);
        const decoded = decodePcm(out);
        expect(rms(reference.samples)).toBeGreaterThan(MIN_TONE_RMS);
        if (expected.lossless) {
          expect(decoded.sampleRate).toBe(reference.sampleRate);
          expect(snrDb(reference.samples, decoded.samples)).toBeGreaterThanOrEqual(MIN_LOSSLESS_SNR_DB);
          return;
        }

        const decodedSeconds = decoded.samples.length / decoded.sampleRate;
        const frameSeconds = (expected.frameSamples! * (expected.toleranceFrames ?? 1)) / decoded.sampleRate;
        expect(Math.abs(decodedSeconds - reference.samples.length / reference.sampleRate)).toBeLessThanOrEqual(frameSeconds);
        const ratio = rms(decoded.samples) / rms(reference.samples);
        expect(ratio).toBeGreaterThan(MIN_LOSSY_RMS_RATIO);
        expect(ratio).toBeLessThan(MAX_LOSSY_RMS_RATIO);
      }, TEST_TIMEOUT_MS);
    }
  }
});

describe('narrowband mono input', () => {
  for (const id of IDS) {
    const expected = EXPECTED[id];
    oracleTest(`32 kHz mono WAV -> ${id} encodes with the target codec`, ['ffmpeg', 'ffprobe'], async () => {
      const source = lowRateMono();
      if (!ffmpegHasEncoder(expected.encoder)) {
        await expect(convertMedia(fs.readFileSync(source), 'wav', id, {}, 'clip')).rejects.toThrow(EngineUnavailableError);
        return;
      }
      const out = await convertToFile(source, 'wav', id);
      const streams = ffprobeStreams(out);
      expect(streams.map((s) => `${s.codec_type}:${s.codec_name}`)).toEqual([`audio:${expected.codec}`]);
      expect(ffprobeFormatName(out)).toBe(EXPECTED_FORMAT[id]);
    }, TEST_TIMEOUT_MS);
  }
});

/** Eight silent channels except one tone: wider than AC-3 and WMA can write. */
function sevenPointOne(): string {
  return input('seven-one.wav', (file) => {
    const silent = `anullsrc=channel_layout=mono:sample_rate=${SAMPLE_RATE}`;
    const tone = `sine=frequency=${TONE_HZ}:sample_rate=${SAMPLE_RATE}`;
    ffmpeg([
      ...[silent, silent, silent, silent, silent, silent, tone, silent].flatMap((src) => ['-f', 'lavfi', '-t', String(CLIP_SECONDS), '-i', src]),
      '-filter_complex', 'join=inputs=8:channel_layout=7.1', '-c:a', 'pcm_s16le', file,
    ]);
  });
}

describe('explicit codec equal to the target default', () => {
  for (const id of ['ogg', 'oga', 'weba']) {
    oracleTest(`32 kHz mono WAV -> ${id} with audio.codec vorbis encodes with libvorbis`, ['ffmpeg', 'ffprobe'], async () => {
      const source = lowRateMono();
      const out = await convertToFile(source, 'wav', id, { audio: { codec: 'vorbis' } });
      expect(ffprobeStreams(out).map((s) => s.codec_name)).toEqual(['vorbis']);
      expect(ffprobeFormatName(out)).toBe(EXPECTED_FORMAT[id]);
    }, TEST_TIMEOUT_MS);
  }

  it('gives an explicit default codec the same quality-based default as an implicit one', () => {
    const implicit = buildFfmpegArguments('/nonexistent/in.wav', '/tmp/o.ogg', 'wav', 'ogg', {});
    const explicit = buildFfmpegArguments('/nonexistent/in.wav', '/tmp/o.ogg', 'wav', 'ogg', { audio: { codec: 'vorbis' } });
    expect(argAfter(explicit, '-q:a')).toBe(argAfter(implicit, '-q:a'));
    expect(argAfter(explicit, '-q:a')).toBeDefined();
    expect(explicit).not.toContain('-b:a');
  });

  it('accepts the target own PCM codec for aifc, caf and voc', () => {
    for (const id of ['aifc', 'caf', 'voc']) {
      const args = buildFfmpegArguments('/nonexistent/in.wav', `/tmp/o.${id}`, 'wav', id, { audio: { codec: 'pcm_s16le' } });
      expect(argAfter(args, '-c:a')).toBe('pcm_s16le');
      expect(args).not.toContain('-b:a');
    }
  });
});

describe('encoder format limits are rejected before ffmpeg runs', () => {
  const build = (id: string, options: Parameters<typeof buildFfmpegArguments>[4], input = '/nonexistent/in.wav') =>
    buildFfmpegArguments(input, `/tmp/o.${id}`, 'wav', id, options);

  it('limits Opus to the rates libopus codes and defaults to 48 kHz', () => {
    for (const id of ['opus', 'weba']) {
      expect(() => build(id, { audio: { sampleRate: 44100 } })).toThrow(InvalidMediaOptionError);
      expect(() => build(id, { audioSampleRate: 32000 })).toThrow(InvalidMediaOptionError);
      expect(argAfter(build(id, { audio: { sampleRate: 16000 } }), '-ar')).toBe('16000');
      expect(argAfter(build(id, {}), '-ar')).toBe('48000');
    }
  });

  it('limits AC-3 to 32, 44.1 and 48 kHz and at most six channels', () => {
    expect(() => build('ac3', { audio: { sampleRate: 22050 } })).toThrow(InvalidMediaOptionError);
    expect(() => build('ac3', { audio: { sampleRate: 96000 } })).toThrow(InvalidMediaOptionError);
    expect(() => build('ac3', { audio: { channels: 8 } })).toThrow(InvalidMediaOptionError);
    expect(() => build('ac3', { audioChannels: '7.1' })).toThrow(InvalidMediaOptionError);
    expect(argAfter(build('ac3', { audio: { sampleRate: 44100, channels: 6 } }), '-ac')).toBe('6');
  });

  it('limits WMA to stereo and 48 kHz', () => {
    expect(() => build('wma', { audio: { channels: 6 } })).toThrow(InvalidMediaOptionError);
    expect(() => build('wma', { audioChannels: '5.1' })).toThrow(InvalidMediaOptionError);
    expect(() => build('wma', { audio: { sampleRate: 96000 } })).toThrow(InvalidMediaOptionError);
    expect(argAfter(build('wma', { audio: { channels: 2, sampleRate: 44100 } }), '-ac')).toBe('2');
  });

  oracleTest('rejects an 8-channel input for AC-3 and WMA unless it is downmixed', ['ffmpeg', 'ffprobe'], async () => {
    const source = sevenPointOne();
    for (const id of ['ac3', 'wma']) {
      expect(() => build(id, {}, source)).toThrow(InvalidMediaOptionError);
      await expect(convertMedia(fs.readFileSync(source), 'wav', id, {}, 'wide')).rejects.toThrow(InvalidMediaOptionError);
      const downmixed = await convertToFile(source, 'wav', id, { audio: { channels: 2 } });
      expect(ffprobeStreams(downmixed)[0].channels).toBe(2);
    }
  }, TEST_TIMEOUT_MS);

  oracleTest('writes Opus at 48 kHz from a 44.1 kHz input and rejects an explicit 44.1 kHz request', ['ffmpeg', 'ffprobe'], async () => {
    const source = input('cd-rate.wav', (file) =>
      ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=${TONE_HZ}:sample_rate=44100:duration=${CLIP_SECONDS}`, file])
    );
    const out = await convertToFile(source, 'wav', 'opus');
    expect(Number(ffprobeStreams(out)[0].sample_rate)).toBe(SAMPLE_RATE);
    await expect(convertMedia(fs.readFileSync(source), 'wav', 'opus', { audio: { sampleRate: 44100 } }, 'cd')).rejects.toThrow(
      InvalidMediaOptionError
    );
  }, TEST_TIMEOUT_MS);
});

/** A mono tone at an arbitrary sample rate, for inputs outside an encoder's supported set. */
function toneAtRate(rate: number): string {
  return input(`tone-${rate}.wav`, (file) =>
    ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=${TONE_HZ}:sample_rate=${rate}:duration=${CLIP_SECONDS}`, '-ac', '1', file])
  );
}

describe('inputs outside the encoder sample rate set', () => {
  const HIGH_RATE = 96000;
  const WMA_MAX_RATE = 48000;
  const LOW_RATE = 22050;
  const AC3_LOWEST_RATE = 32000;

  oracleTest('resamples a 96 kHz input to 48 kHz for WMA and AC-3', ['ffmpeg', 'ffprobe'], async () => {
    const source = toneAtRate(HIGH_RATE);
    for (const id of ['wma', 'ac3']) {
      const out = await convertToFile(source, 'wav', id);
      const stream = ffprobeStreams(out)[0];
      expect(stream.codec_name).toBe(EXPECTED[id].codec);
      expect(Number(stream.sample_rate)).toBe(WMA_MAX_RATE);
      const decoded = decodePcm(out);
      expect(rms(decoded.samples)).toBeGreaterThan(MIN_TONE_RMS);
      expect(Math.abs(decoded.samples.length / decoded.sampleRate - CLIP_SECONDS)).toBeLessThanOrEqual(
        EXPECTED[id].frameSamples! / decoded.sampleRate
      );
    }
  }, TEST_TIMEOUT_MS);

  oracleTest('resamples a 22.05 kHz input up to the lowest AC-3 rate and keeps a supported WMA rate', ['ffmpeg', 'ffprobe'], async () => {
    const source = toneAtRate(LOW_RATE);
    expect(Number(ffprobeStreams(await convertToFile(source, 'wav', 'ac3'))[0].sample_rate)).toBe(AC3_LOWEST_RATE);
    expect(Number(ffprobeStreams(await convertToFile(source, 'wav', 'wma'))[0].sample_rate)).toBe(LOW_RATE);
  }, TEST_TIMEOUT_MS);

  oracleTest('emits the resample rate only when the input rate is unsupported and the caller set none', ['ffmpeg', 'ffprobe'], () => {
    const high = toneAtRate(HIGH_RATE);
    const build = (file: string, id: string, options = {}) =>
      buildFfmpegArguments(file, path.join(workDir, `o.${id}`), 'wav', id, options, getOracleToolPath('ffmpeg'));
    expect(argAfter(build(high, 'wma'), '-ar')).toBe(String(WMA_MAX_RATE));
    expect(argAfter(build(high, 'ac3'), '-ar')).toBe(String(WMA_MAX_RATE));
    expect(argAfter(build(toneAtRate(LOW_RATE), 'wma'), '-ar')).toBeUndefined();
    expect(argAfter(build(high, 'wma', { audio: { sampleRate: 44100 } }), '-ar')).toBe('44100');
    expect(argAfter(build(high, 'flac'), '-ar')).toBeUndefined();
  });
});

describe('audio stream selection', () => {
  oracleTest('maps the first audio stream by default and the requested one on demand', ['ffmpeg', 'ffprobe'], async () => {
    const source = twoTrackVideo();
    const first = decodePcm(source, 0);
    const second = decodePcm(source, 1);
    expect(snrDb(first.samples, second.samples)).toBeLessThan(MAX_WRONG_TRACK_SNR_DB);

    const byDefault = decodePcm(await convertToFile(source, 'mkv', 'flac'));
    expect(snrDb(first.samples, byDefault.samples)).toBeGreaterThanOrEqual(MIN_LOSSLESS_SNR_DB);

    const selected = decodePcm(await convertToFile(source, 'mkv', 'flac', { audio: { track: 1 } }));
    expect(snrDb(second.samples, selected.samples)).toBeGreaterThanOrEqual(MIN_LOSSLESS_SNR_DB);
    expect(snrDb(first.samples, selected.samples)).toBeLessThan(MAX_WRONG_TRACK_SNR_DB);
  }, TEST_TIMEOUT_MS);

  oracleTest('rejects a track the input does not have', ['ffmpeg', 'ffprobe'], () => {
    const source = videoWithAudio();
    expect(() =>
      buildFfmpegArguments(source, path.join(workDir, 'o.flac'), 'mkv', 'flac', { audio: { track: 1 } }, getOracleToolPath('ffmpeg'))
    ).toThrow(InvalidMediaOptionError);
  });

  oracleTest('throws a typed error for an input without audio', ['ffmpeg', 'ffprobe'], async () => {
    const source = silentVideo();
    for (const id of ['m4a', 'ogg', 'wma', 'aiff']) {
      expect(() =>
        buildFfmpegArguments(source, path.join(workDir, `o.${id}`), 'mp4', id, {}, getOracleToolPath('ffmpeg'))
      ).toThrow(NoAudioStreamError);
      // The conversion entry point surfaces it as a ConversionFailedError (HTTP 400), never an empty file.
      const attempt = convertMedia(fs.readFileSync(source), 'mp4', id, {}, 'silent');
      await expect(attempt).rejects.toThrow(ConversionFailedError);
      await expect(attempt).rejects.toThrow(/no audio stream/);
    }
  }, TEST_TIMEOUT_MS);
});

describe('video codec aliases', () => {
  oracleTest('videoCodec h265 writes a real HEVC stream', ['ffmpeg', 'ffprobe'], async () => {
    const encoders = execFileSync(getOracleToolPath('ffmpeg')!, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    if (!/\blibx265\b/.test(encoders)) {
      throw new Error('The installed ffmpeg has no libx265 encoder, which the h265 alias requires.');
    }
    const source = input('h265-source.mp4', (file) => ffmpeg([...VIDEO_SOURCE, '-c:v', 'mpeg4', '-an', file]));
    const out = await convertToFile(source, 'mp4', 'mp4', { disableHwaccel: true, videoCodec: 'h265' });
    const videoCodecs = ffprobeStreams(out)
      .filter((s) => s.codec_type === 'video')
      .map((s) => s.codec_name);
    expect(videoCodecs).toEqual(['hevc']);
  }, TEST_TIMEOUT_MS);
});
