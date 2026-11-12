import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ConversionFailedError,
  ConversionOptions,
  EngineUnavailableError,
  InvalidMediaOptionError,
  AudioCodec,
  VideoRateControl,
} from '../types';
import { probeHardwareAcceleration, probeSupportedEncoders, type HardwareAccelerationCapabilities } from './media-hw-probe';
import { resolveVideoCodec, type VideoCodecName } from './media-video-codec';
import {
  PASS_LOG_PREFIX_PATTERN,
  aspectReshapeFilter,
  assertTwoPassSupported,
  isTwoPassRequested,
  resolveAspectRatio,
  resolveFastStart,
  resolveOutputDuration,
  twoPassEncoderArgs,
  type AspectPlan,
  type TwoPassStage,
} from './media-ffmpeg-container-args';
import { assertChannelLimits, planAudioChannels } from './media-audio-channels';
import {
  assertEncoderAvailable,
  AudioTargetSpec,
  isAudioOnlyTarget,
  NoAudioStreamError,
  resampleRateFor,
  resolveAudioTargetSpec,
  VORBIS_DEFAULT_QUALITY,
} from './media-audio-targets';
import {
  FfprobePath,
  type StreamLayout,
  firstVideoStream,
  layoutColorTransfer,
  probeStreamLayout,
  probeAudioChannels,
  probeAudioSampleRate,
  probeAudioStreamCount,
  probeVideoColorTransfer,
  resolveFfprobeBinary,
} from './media-ffprobe';
import { DEFAULT_TONE_MAP, TONE_MAP_MODES } from './hdr-tonemap';
import { escapeFfmpegFilterPath } from './media-filter-escape';
import { pictureOf, softwareEncoderThreads } from './media-encoder-threads';
import { type Vp9Deadline, vp9DeadlineOfInput, vp9SpeedArgs } from './media-vp9-effort';
import type { LayoutStream } from './mp4-layout';
import { addWavPacketSize, readWavInputFacts } from './media-wav-input';
import { type MediaInput, mediaInputArgs, openMediaInput } from './media-process';
import { SDR_COLOUR_ARGS, type VideoToneMapPlan, assertZscaleAvailable, planVideoToneMap, probeVideoMaxLightLevel } from './media-hdr';
import {
  chooseResampler,
  LoudnessMeasurement,
  loudnormApplyFilter,
  loudnormMeasureFilter,
  resampleFilter,
  resamplePrecisionFor,
  resolveDither,
  resolveLoudnessTarget,
} from './media-audio-quality';
import {
  BITMAP_SUBTITLE_CODECS,
  CHAPTER_CONTAINERS,
  planStreamMapping,
  StreamMapPlan,
  VARIABLE_FRAME_RATE_CONTAINERS,
  VideoContainer,
} from './media-stream-plan';

export {
  probeAudioChannels,
  probeAudioSampleRate,
  probeAudioStreamCount,
  probeVideoColorTransfer,
  resolveFfprobeBinary,
};
export type { FfprobePath };
export { isTwoPassRequested } from './media-ffmpeg-container-args';
export type { TwoPassStage } from './media-ffmpeg-container-args';
export {
  probeHardwareAcceleration,
  probeSupportedEncoders,
  resetHardwareAccelerationCache,
  usesHardwareVideoEncoder,
} from './media-hw-probe';
export type { HardwareAccelerationCapabilities, HardwareProbeEnvironment } from './media-hw-probe';
export {
  DEFAULT_PACKAGING_LADDER,
  MAX_LADDER_RUNGS,
  PACKAGING_AUDIO_ENCODERS,
  PACKAGING_VIDEO_ENCODERS,
  buildHlsDashArguments,
  probePackagingSource,
} from './media-ffmpeg-packaging-args';
export type { PackagingSource } from './media-ffmpeg-packaging-args';

export const AUDIO_CODEC_MAP: Record<AudioCodec, string> = {
  aac: 'aac',
  mp3: 'libmp3lame',
  opus: 'libopus',
  flac: 'flac',
  vorbis: 'libvorbis',
  pcm_s16le: 'pcm_s16le',
};

/** Decimals of the input start offset passed to ffmpeg: microseconds, the precision of its timeline. */
const CHAPTER_OFFSET_DECIMALS = 6;

/** Transfer characteristics of HDR video (SMPTE ST 2084 PQ and ARIB STD-B67 HLG). */
const HDR_TRANSFERS: ReadonlySet<string> = new Set(['smpte2084', 'arib-std-b67']);
/** Profiles that encode 10-bit samples; every other software profile encodes 8-bit 4:2:0. */
const TEN_BIT_PROFILES: ReadonlySet<string> = new Set(['main10', 'high10']);
const TEN_BIT_PIX_FMT = 'yuv420p10le';
const EIGHT_BIT_PIX_FMT = 'yuv420p';

export const H264_ALLOWED_PROFILES = new Set(['baseline', 'main', 'high', 'high10']);
export const H264_ALLOWED_LEVELS = new Set([
  '3.0', '3.1', '3.2', '4.0', '4.1', '4.2', '5.0', '5.1', '5.2',
  '30', '31', '32', '40', '41', '42', '50', '51', '52',
]);
export const HEVC_ALLOWED_PROFILES = new Set(['main', 'main10']);
export const AV1_ALLOWED_PROFILES = new Set(['main', '0']);

/** x264 and x265 presets a caller may name; `placebo` is left out because its cost is unbounded for a service. */
export const X26X_PRESETS: ReadonlySet<string> = new Set([
  'ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow',
]);
/** Quality/speed balance of x264 and x265 when the caller names no preset. */
export const X26X_DEFAULT_PRESET = 'medium';
/** SVT-AV1 preset: 0 is the slowest and best, 13 the fastest; 8 keeps near real-time speed with good quality. */
export const SVT_AV1_DEFAULT_PRESET = 8;
export const SVT_AV1_PRESET_RANGE = { min: 0, max: 13 } as const;
/** Buffer of a capped-CRF encode over its peak rate: two seconds of video at the cap. */
const CAPPED_CRF_BUFSIZE_FACTOR = 2;
/** Deinterlace only the frames flagged interlaced, one progressive frame per field. */
const DEINTERLACE_FILTER = 'bwdif=mode=send_field:deint=interlaced';
const SVT_AV1_ENCODER = 'libsvtav1';
const VP9_DEFAULT_CRF = 30;
const AV1_DEFAULT_CRF = 32;
const SVT_AV1_PRESET_PATTERN = /^\d{1,2}$/;

/** x264/x265 preset: the caller's, if it is on the allow-list, otherwise the default. */
function resolveX26xPreset(requested: string | undefined): string {
  if (requested === undefined) return X26X_DEFAULT_PRESET;
  if (!X26X_PRESETS.has(requested)) {
    throw new InvalidMediaOptionError(`Invalid x264/x265 preset '${requested}'. Allowed: ${[...X26X_PRESETS].join(', ')}.`);
  }
  return requested;
}

/** SVT-AV1 preset: an integer 0 to 13 given as the request's preset, otherwise the default. */
function resolveSvtAv1Preset(requested: string | undefined): string {
  if (requested === undefined) return String(SVT_AV1_DEFAULT_PRESET);
  const value = Number(requested);
  if (!SVT_AV1_PRESET_PATTERN.test(requested) || value < SVT_AV1_PRESET_RANGE.min || value > SVT_AV1_PRESET_RANGE.max) {
    throw new InvalidMediaOptionError(
      `Invalid AV1 preset '${requested}'. Allowed: an integer from ${SVT_AV1_PRESET_RANGE.min} (slowest) to ${SVT_AV1_PRESET_RANGE.max}.`
    );
  }
  return requested;
}

/** SVT-AV1 writes every AV1 target; a build without it answers 503 instead of failing mid-encode. */
function assertSvtAv1Available(ffmpegBin: string | null | undefined): void {
  if (!ffmpegBin) return;
  const supported = probeSupportedEncoders(ffmpegBin);
  if (supported.size > 0 && !supported.has(SVT_AV1_ENCODER)) {
    throw new EngineUnavailableError('ffmpeg', `this build has no '${SVT_AV1_ENCODER}' encoder, so AV1 video cannot be written`);
  }
}

/** Peak bitrate cap of a constant-quality encode in kbit/s, validated; undefined when the caller set none. */
function crfCapKbps(rateControl: VideoRateControl | undefined): number | undefined {
  if (rateControl?.mode !== 'crf' || rateControl.maxBitrateK === undefined) return undefined;
  const cap = rateControl.maxBitrateK;
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) {
    throw new InvalidMediaOptionError(`Invalid maxBitrateK ${String(cap)}. Must be a positive number of kbit/s.`);
  }
  return Math.ceil(cap);
}

/** Peak-rate arguments of a capped-CRF encode; empty when the caller set no cap. */
function cappedCrfArgs(rateControl: VideoRateControl | undefined): string[] {
  const maxrate = crfCapKbps(rateControl);
  return maxrate === undefined ? [] : ['-maxrate', `${maxrate}k`, '-bufsize', `${maxrate * CAPPED_CRF_BUFSIZE_FACTOR}k`];
}

/** libvpx-vp9 encoder and its speed settings; constant quality unless a bitrate follows. */
function vp9Args(rateControl: VideoRateControl | undefined, deadline: Vp9Deadline): string[] {
  const args = ['-c:v', 'libvpx-vp9', ...vp9SpeedArgs(deadline)];
  if (rateControl?.mode === 'crf') {
    // With a cap this is constrained quality: the quality target plus a ceiling on the bitrate.
    const cap = crfCapKbps(rateControl);
    args.push('-crf', String(rateControl.crf), '-b:v', cap === undefined ? '0' : `${cap}k`);
  } else if (!rateControl) {
    args.push('-crf', String(VP9_DEFAULT_CRF), '-b:v', '0');
  }
  return args;
}

/** SVT-AV1 encoder at the chosen preset; constant quality unless a bitrate follows. */
function svtAv1Args(rateControl: VideoRateControl | undefined, preset: string | undefined, profile: string | undefined): string[] {
  const args = ['-c:v', SVT_AV1_ENCODER, '-preset', resolveSvtAv1Preset(preset)];
  if (rateControl?.mode === 'crf') {
    args.push('-crf', String(rateControl.crf));
  } else if (!rateControl) {
    args.push('-crf', String(AV1_DEFAULT_CRF));
  }
  if (profile) {
    args.push('-profile:v', '0');
  }
  return args;
}

/** Bitrate controls shared by every video container: VBR, CBR, the capped CRF peak and the legacy videoBitrate. */
/**
 * MPEG-4 Part 2 (Xvid-compatible) constant quantiser for the avi target: 2-3 is the visually transparent
 * range of this codec; 3 keeps files moderate.
 */
const MPEG4_DEFAULT_QSCALE = 3;
/** Rate-distortion macroblock decisions, trellis quantisation, four motion vectors and AC prediction. */
const MPEG4_QUALITY_ARGS: readonly string[] = ['-mbd', 'rd', '-trellis', '2', '-flags', '+mv4+aic'];

function bitrateControlArgs(rateControl: VideoRateControl | undefined, options: ConversionOptions, codec: string): string[] {
  const args: string[] = [];
  if (rateControl?.mode === 'vbr') {
    args.push('-b:v', `${rateControl.bitrateK}k`);
    if (rateControl.maxrateK) args.push('-maxrate', `${rateControl.maxrateK}k`);
    if (rateControl.bufsizeK) args.push('-bufsize', `${rateControl.bufsizeK}k`);
  } else if (rateControl?.mode === 'cbr') {
    args.push(
      '-b:v', `${rateControl.bitrateK}k`,
      '-minrate', `${rateControl.bitrateK}k`,
      '-maxrate', `${rateControl.bitrateK}k`,
      '-bufsize', `${rateControl.bitrateK}k`
    );
  } else if (rateControl?.mode === 'crf') {
    // VP9 states its cap as the ceiling of constrained quality (see vp9Args); the others take -maxrate.
    if (codec !== 'vp9') args.push(...cappedCrfArgs(rateControl));
  } else if (typeof options.videoBitrate === 'number' && Number.isFinite(options.videoBitrate) && options.videoBitrate > 0) {
    args.push('-b:v', `${Math.floor(options.videoBitrate)}k`);
  }
  return args;
}

/** Codec of an external soft subtitle track when no input stream decided it: text containers convert, others copy. */
const SOFT_SUBTITLE_CODEC_BY_CONTAINER: Readonly<Record<string, string>> = {
  mp4: 'mov_text',
  mov: 'mov_text',
  webm: 'webvtt',
};
/** Forces 16-bit samples, so the dithered reduction happens in the resampler that carries the dither setting. */
const SIXTEEN_BIT_FORMAT_FILTER = 'aformat=sample_fmts=s16';
/** Highest output frame rate a request may name. */
const MAX_OUTPUT_FPS = 240;
/** Output label of the filter graph that overlays a bitmap subtitle onto the picture. */
const BURN_GRAPH_OUTPUT = '[vout]';
/** Re-encoded audio starts at zero, with the first-sample drift corrected, so audio and video stay in step. */
const AUDIO_SYNC_FILTER = 'aresample=async=1:first_pts=0';

/** True when the request names an output frame rate (`video.fps` or the legacy `videoFps`). */
function hasRequestedFrameRate(options: ConversionOptions): boolean {
  return options.video?.fps !== undefined || options.videoFps !== undefined;
}

function assertSampleRateLimits(tgt: string, spec: AudioTargetSpec, sampleRate: number | undefined): void {
  if (sampleRate === undefined) return;
  if (spec.fixedSampleRate !== undefined && sampleRate !== spec.fixedSampleRate) {
    throw new InvalidMediaOptionError(
      `The '${tgt}' target only supports a ${spec.fixedSampleRate} Hz sample rate, but ${sampleRate} Hz was requested.`
    );
  }
  if (spec.allowedSampleRates && !spec.allowedSampleRates.includes(sampleRate)) {
    throw new InvalidMediaOptionError(
      `The '${tgt}' target supports the sample rates ${spec.allowedSampleRates.join(', ')} Hz, but ${sampleRate} Hz was requested.`
    );
  }
  if (spec.maxSampleRate !== undefined && sampleRate > spec.maxSampleRate) {
    throw new InvalidMediaOptionError(
      `The '${tgt}' target supports sample rates up to ${spec.maxSampleRate} Hz, but ${sampleRate} Hz was requested.`
    );
  }
}

/**
 * Rejects a sample rate or channel count that the target's encoder cannot honour, before ffmpeg
 * runs. The limits describe the target's own encoder, so they apply unless the caller swaps the codec.
 */
async function assertEncoderLimits(
  tgt: string,
  spec: AudioTargetSpec,
  options: ConversionOptions,
  input: MediaInput,
  ffmpegBin?: string | null
): Promise<void> {
  assertSampleRateLimits(tgt, spec, options.audio?.sampleRate ?? options.audioSampleRate);
  await assertChannelLimits(tgt, spec, options, input, ffmpegBin);
}

/**
 * Output arguments that keep exactly one audio stream: every other stream class is dropped and the
 * selected audio stream (the first by default) is mapped explicitly. An input without that stream
 * throws instead of producing an empty or video-carrying file.
 */
async function audioOnlyStreamArgs(
  tgt: string,
  input: MediaInput,
  options: ConversionOptions,
  ffmpegBin?: string | null
): Promise<string[]> {
  const track = options.audio?.track;
  if (track === 'all') {
    throw new InvalidMediaOptionError(`The '${tgt}' target holds a single audio stream; audio.track 'all' is not supported.`);
  }
  const index = track ?? 0;
  if (!Number.isInteger(index) || index < 0) {
    throw new InvalidMediaOptionError('Audio track index must be a non-negative integer.');
  }
  if (fs.existsSync(input.path)) {
    const available = await probeAudioStreamCount(input, resolveFfprobeBinary(ffmpegBin), options.signal);
    if (available === 0) {
      throw new NoAudioStreamError(`The input has no audio stream, so it cannot be converted to '${tgt}'.`);
    }
    if (index >= available) {
      throw new InvalidMediaOptionError(
        `Audio track ${index} does not exist; the input has ${available} audio stream(s).`
      );
    }
  }
  return ['-vn', '-sn', '-dn', '-map', `0:a:${index}`];
}

/**
 * Stage of the two-pass loudness normalisation: `measure` builds the arguments of the analysing pass (no
 * output file), `apply` builds the encode with the measured values.
 */
export type LoudnessStage = { kind: 'measure' } | { kind: 'apply'; measurement: LoudnessMeasurement };

/** Arguments of the loudness measuring pass: the audio of the conversion through loudnorm, to a null sink. */
export async function buildLoudnessMeasureArguments(
  input: MediaInput,
  tgt: string,
  options: ConversionOptions,
  ffmpegBin?: string | null
): Promise<string[]> {
  return buildFfmpegArguments(input, '', tgt, options, ffmpegBin, undefined, { kind: 'measure' });
}

/**
 * Arguments of a two-pass VBR encode: the analysing pass (video only, to a null sink) and the encode that
 * reads its statistics. Both read and write the pass log `logPrefix` in the process's working directory, so
 * the caller runs them in a job directory it removes afterwards. A request that is not two-pass is rejected.
 */
export async function buildTwoPassArguments(
  input: MediaInput,
  outputPath: string,
  tgt: string,
  options: ConversionOptions,
  ffmpegBin: string | null | undefined,
  logPrefix: string,
  loudnessStage?: LoudnessStage
): Promise<[string[], string[]]> {
  if (!isTwoPassRequested(options)) {
    throw new InvalidMediaOptionError('Two-pass arguments were requested without rateControl.twoPass.');
  }
  const build = (pass: 1 | 2) =>
    buildFfmpegArguments(input, outputPath, tgt, options, ffmpegBin, undefined, loudnessStage, { pass, logPrefix });
  return [await build(1), await build(2)];
}

/** The request one argument build serves and the three lists it fills in order: global options, inputs and outputs. */
interface BuildContext {
  input: MediaInput;
  tgt: string;
  options: ConversionOptions;
  ffmpegBin?: string | null;
  loudnessStage?: LoudnessStage;
  passStage?: TwoPassStage;
  globalArgs: string[];
  inputArgs: string[];
  outputArgs: string[];
}

/** What the stream mapping decided, for the video and audio stages that follow. */
interface StreamMapping {
  inputLayout: StreamLayout | undefined;
  burnRequested: boolean;
  burnBitmapStream: LayoutStream | undefined;
  streamPlan: StreamMapPlan | undefined;
  audioOnlyMapArgs: string[];
}

/** What the video stage needs from the checks and decisions made before it. */
interface VideoStageInput {
  aspect: AspectPlan | undefined;
  fastStart: boolean;
  twoPass: boolean;
  mapping: StreamMapping;
}

type HardwareEncoderKind = 'nvenc' | 'vaapi' | 'videotoolbox' | 'qsv';

/** The video codec, its gates passed, and the facts the filter graph and the encoder arguments both read. */
interface VideoPlan {
  codec: VideoCodecName;
  rateControl: VideoRateControl | undefined;
  tenBit: boolean;
  hdrToSdr: VideoToneMapPlan | undefined;
  hardware: HardwareEncoderKind | undefined;
  driDevice: string | null;
  sourcePicture: ReturnType<typeof firstVideoStream>;
  unscaledPicture: ReturnType<typeof pictureOf>;
  vp9Deadline: Vp9Deadline;
}

const VIDEO_TARGETS: ReadonlySet<string> = new Set(['mp4', 'mkv', 'avi', 'mov', 'webm']);
const SOFT_SUBTITLE_TARGETS: ReadonlySet<string> = new Set(['mp4', 'mov', 'mkv', 'webm']);
const HARDWARE_ENCODER_TARGETS: ReadonlySet<string> = new Set(['mp4', 'mov', 'mkv']);
const DRI_DEVICES = ['/dev/dri/renderD128', '/dev/dri/card0'] as const;
const VIDEO_RESOLUTION_SIZES: Record<string, string> = {
  '4k': '3840:2160',
  '1080p': '1920:1080',
  '720p': '1280:720',
  '480p': '854:480',
  '360p': '640:360',
};
const PRORES_PROFILE_NUMBERS: Record<string, string> = {
  proxy: '0',
  '0': '0',
  lt: '1',
  '1': '1',
  standard: '2',
  '2': '2',
  hq: '3',
  '3': '3',
  '4444': '4',
  '4': '4',
};
const DEFAULT_PRORES_PROFILE = '3';
const MIN_AUDIO_SAMPLE_RATE = 8000;
const MAX_AUDIO_SAMPLE_RATE = 192000;
const MAX_AUDIO_VOLUME_PERCENT = 200;

/**
 * Builds optimized, compliant FFmpeg argument array with hardware acceleration,
 * strict filter graph ordering, rate control, and profile/level validation.
 *
 * An `audio.loudness` request needs a `loudnessStage`: the measuring pass (see buildLoudnessMeasureArguments)
 * and then this call with the measurement, so a normalisation is never applied from invented numbers.
 */
export async function buildFfmpegArguments(
  input: MediaInput,
  outputPath: string,
  tgt: string,
  options: ConversionOptions = {},
  ffmpegBin?: string | null,
  overrideTimestamp?: string,
  loudnessStage?: LoudnessStage,
  passStage?: TwoPassStage
): Promise<string[]> {
  const ctx: BuildContext = { input, tgt, options, ffmpegBin, loudnessStage, passStage, globalArgs: ['-y'], inputArgs: [], outputArgs: [] };
  if (options.thumbnail) return thumbnailArguments(ctx, outputPath, overrideTimestamp);
  if (options.subtitles?.mode === 'extract') return subtitleExtractionArguments(ctx, outputPath);
  return await transcodeArguments(ctx, outputPath);
}

/** A single frame image. */
function thumbnailArguments(ctx: BuildContext, outputPath: string, overrideTimestamp: string | undefined): string[] {
  const { input, tgt, options, globalArgs, inputArgs, outputArgs } = ctx;
  const timestamp = overrideTimestamp || options.thumbnail?.at?.[0] || '00:00:01.000';
  if (options.thumbnail?.accurate) {
    inputArgs.push(...mediaInputArgs(input));
    outputArgs.push('-ss', timestamp);
  } else {
    inputArgs.push('-ss', timestamp, ...mediaInputArgs(input));
  }

  const videoFilters: string[] = [];
  if (options.thumbnail?.width && options.thumbnail.width > 0) {
    videoFilters.push(`scale=${options.thumbnail.width}:-2`);
  }
  videoFilters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
  outputArgs.push('-vf', videoFilters.join(','));

  outputArgs.push('-frames:v', '1', '-an');
  const imgCodec = (tgt === 'png' || options.thumbnail?.format === 'png') ? 'png' : 'mjpeg';
  outputArgs.push('-c:v', imgCodec);

  return [...globalArgs, ...inputArgs, ...outputArgs, outputPath];
}

function subtitleFormatOf(tgt: string): string {
  if (tgt === 'vtt') return 'vtt';
  return tgt === 'ass' ? 'ass' : 'srt';
}

function subtitleCodecOf(format: string): string {
  if (format === 'vtt') return 'webvtt';
  return format === 'ass' ? 'ass' : 'srt';
}

/** The subtitle stream demuxed on its own. */
function subtitleExtractionArguments(ctx: BuildContext, outputPath: string): string[] {
  const { input, tgt, options, globalArgs, inputArgs, outputArgs } = ctx;
  addTrimInputArgs(ctx);
  inputArgs.push(...mediaInputArgs(input));

  outputArgs.push('-vn', '-an');
  const sIdx = typeof options.subtitles?.streamIndex === 'number' ? options.subtitles.streamIndex : 0;
  if (sIdx < 0) {
    throw new InvalidMediaOptionError('Subtitle stream index must be non-negative.');
  }
  outputArgs.push('-map', `0:s:${sIdx}`);

  const subFmt = options.subtitles?.format || subtitleFormatOf(tgt);
  outputArgs.push('-c:s', subtitleCodecOf(subFmt));

  return [...globalArgs, ...inputArgs, ...outputArgs, outputPath];
}

function addTrimInputArgs(ctx: BuildContext): void {
  const { options, inputArgs } = ctx;
  if (options.trim?.start) {
    inputArgs.push('-ss', options.trim.start);
  }
  if (options.trim?.end) {
    inputArgs.push('-to', options.trim.end);
  }
}

/** The standard video or audio transcode. */
async function transcodeArguments(ctx: BuildContext, outputPath: string): Promise<string[]> {
  const { input, tgt, options, ffmpegBin, passStage, globalArgs, inputArgs, outputArgs } = ctx;
  const wav = addTranscodeInputArgs(ctx);

  const isVideo = VIDEO_TARGETS.has(tgt);
  const audioSpec = isAudioOnlyTarget(tgt) ? resolveAudioTargetSpec(tgt) : undefined;

  const twoPass = isTwoPassRequested(options);
  assertTwoPassRequest(ctx, isVideo, twoPass);
  const outputDuration = await resolveOutputDuration(options, input, ffmpegBin);
  if (outputDuration !== undefined) {
    outputArgs.push('-t', String(outputDuration));
  }
  const fastStart = resolveFastStart(options, tgt, tgt === 'mp4' || tgt === 'mov' || audioSpec?.muxer === 'ipod');
  const aspect = resolveAspectRatio(options.aspectRatio);
  assertRequestsFitTarget(ctx, isVideo, audioSpec, aspect);

  // The spec's limits describe its own encoder; a caller-selected different codec has other limits.
  const specEncoderInUse =
    audioSpec !== undefined && (!options.audio?.codec || AUDIO_CODEC_MAP[options.audio.codec] === audioSpec.encoder);
  if (audioSpec && specEncoderInUse) {
    await assertEncoderLimits(tgt, audioSpec, options, input, ffmpegBin);
  }

  const mapping = await addStreamMapping(ctx, isVideo, audioSpec);
  addSoftSubtitleCodecArgs(ctx, mapping.streamPlan);

  if (isVideo) {
    await addVideoArguments(ctx, { aspect, fastStart, twoPass, mapping });
  }

  // The analysing pass writes its statistics and no media: no audio, no subtitles, a null sink.
  if (passStage?.pass === 1) {
    addVariableFrameRateTiming(ctx, isVideo);
    return [...globalArgs, ...inputArgs, ...outputArgs, '-an', '-sn', '-dn', '-f', 'null', os.devNull];
  }

  // Timing: keep the source's own frame timestamps (variable frame rate) unless a rate was requested,
  // in which case the fps filter has already produced a constant rate.
  addVariableFrameRateTiming(ctx, isVideo);

  const measureArguments = await addAudioArguments(ctx, { isVideo, audioSpec, specEncoderInUse, mapping });
  if (measureArguments) return measureArguments;

  if (audioSpec?.muxer === 'ipod' && fastStart) {
    outputArgs.push('-movflags', '+faststart');
  }

  addWavPacketSize(inputArgs, wav, options, outputArgs, ffmpegBin);
  return [...globalArgs, ...inputArgs, ...outputArgs, outputPath];
}

/** Trim, the input itself and the external subtitle file of a soft subtitle request; returns the WAV facts of the input. */
function addTranscodeInputArgs(ctx: BuildContext): ReturnType<typeof readWavInputFacts> {
  const { input, tgt, options, inputArgs } = ctx;
  addTrimInputArgs(ctx);
  const wav = readWavInputFacts(tgt, input.path, inputArgs);
  inputArgs.push(...mediaInputArgs(input));

  if (options.subtitles?.mode === 'soft') {
    if (!options.subtitles.input) {
      throw new InvalidMediaOptionError("Subtitle 'soft' mode adds an external subtitle file, which a request cannot supply; burn a subtitle stream of the input with 'burn' and streamIndex instead.");
    }
    const subtitleFile = options.subtitles.input;
    inputArgs.push(...mediaInputArgs(openMediaInput(subtitleFile, path.extname(subtitleFile).slice(1))));
  }
  return wav;
}

function assertTwoPassRequest(ctx: BuildContext, isVideo: boolean, twoPass: boolean): void {
  const { tgt, passStage } = ctx;
  if (twoPass && !isVideo) {
    throw new InvalidMediaOptionError(`twoPass applies to video targets; '${tgt}' is not one.`);
  }
  if (twoPass && !passStage) {
    throw new ConversionFailedError('A twoPass request needs both passes; build the arguments with buildTwoPassArguments.');
  }
  if (passStage && !PASS_LOG_PREFIX_PATTERN.test(passStage.logPrefix)) {
    throw new ConversionFailedError(`Invalid pass log prefix "${passStage.logPrefix}".`);
  }
}

/** Refuses the aspect ratio, subtitle and audio codec requests the target container cannot carry. */
function assertRequestsFitTarget(ctx: BuildContext, isVideo: boolean, audioSpec: AudioTargetSpec | undefined, aspect: AspectPlan | undefined): void {
  const { tgt, options } = ctx;
  if (aspect && !isVideo) {
    throw new InvalidMediaOptionError(`aspectRatio applies to video targets; '${tgt}' is not one.`);
  }

  if (options.subtitles?.mode === 'burn' && !isVideo) {
    throw new InvalidMediaOptionError("Subtitle 'burn' mode is only supported for video targets.");
  }
  if (options.subtitles?.mode === 'soft' && !SOFT_SUBTITLE_TARGETS.has(tgt)) {
    throw new InvalidMediaOptionError(`Container '${tgt}' does not support soft subtitle embedding.`);
  }

  // Audio codec validation and container compatibility gates
  if (options.audio?.codec) {
    assertAudioCodecFitsTarget(tgt, options.audio.codec, audioSpec);
  }
}

function assertAudioCodecFitsTarget(tgt: string, ac: AudioCodec, audioSpec: AudioTargetSpec | undefined): void {
  if (!AUDIO_CODEC_MAP[ac]) {
    throw new InvalidMediaOptionError(`Unsupported audio codec '${ac}'.`);
  }
  if (tgt === 'webm' && ac !== 'opus' && ac !== 'vorbis') {
    throw new InvalidMediaOptionError(
      `WebM container only supports 'opus' or 'vorbis' audio codecs, but '${ac}' was requested.`
    );
  }
  if (tgt === 'ogg' && ac !== 'opus' && ac !== 'vorbis' && ac !== 'flac') {
    throw new InvalidMediaOptionError(
      `Ogg container only supports 'opus', 'vorbis', or 'flac' audio codecs, but '${ac}' was requested.`
    );
  }
  if ((tgt === 'mp4' || tgt === 'mov') && ac === 'vorbis') {
    throw new InvalidMediaOptionError("MP4/MOV container does not support 'vorbis' audio codec.");
  }
  if (audioSpec && !audioSpec.userCodecs.includes(ac)) {
    throw new InvalidMediaOptionError(`The '${tgt}' target does not support the '${ac}' audio codec.`);
  }
}

// Stream mapping
// The input is probed so every audio track, every subtitle the container can carry and (for mkv) the
// attachments are mapped explicitly, instead of ffmpeg's one-audio, one-subtitle default selection.
// A missing input file (argument-only callers) keeps the earlier selection rules.
async function addStreamMapping(ctx: BuildContext, isVideo: boolean, audioSpec: AudioTargetSpec | undefined): Promise<StreamMapping> {
  const { input, tgt, options, ffmpegBin, outputArgs } = ctx;
  const inputLayout =
    !audioSpec && isVideo && fs.existsSync(input.path)
      ? await probeStreamLayout(input, resolveFfprobeBinary(ffmpegBin), options.signal)
      : undefined;
  const inputStreams = inputLayout?.streams;
  const burnRequested = options.subtitles?.mode === 'burn';
  const burnSubtitleStream = selectBurnSubtitleStream(options, inputStreams);
  const burnBitmapStream =
    burnSubtitleStream && BITMAP_SUBTITLE_CODECS.has(burnSubtitleStream.codecName) ? burnSubtitleStream : undefined;
  let streamPlan: StreamMapPlan | undefined;
  let audioOnlyMapArgs: string[] = [];
  if (audioSpec) {
    audioOnlyMapArgs = await audioOnlyStreamArgs(tgt, input, options, ffmpegBin);
    outputArgs.push(...audioOnlyMapArgs);
  } else if (inputStreams) {
    streamPlan = addPlannedStreamMaps(ctx, { inputLayout, inputStreams, burnRequested, burnBitmapStream });
  } else if (options.subtitles?.mode === 'soft') {
    outputArgs.push('-map', '0:v');
    if (!addAudioTrackMap(outputArgs, options.audio?.track)) {
      outputArgs.push('-map', '0:a?');
    }
    outputArgs.push('-map', '1:0');
  } else if (options.audio?.track !== undefined) {
    if (isVideo) {
      outputArgs.push('-map', '0:v:0');
    }
    addAudioTrackMap(outputArgs, options.audio.track);
  }
  return { inputLayout, burnRequested, burnBitmapStream, streamPlan, audioOnlyMapArgs };
}

/** The subtitle stream a burn request draws from the input itself; undefined when the request names an external file or none. */
function selectBurnSubtitleStream(options: ConversionOptions, inputStreams: readonly LayoutStream[] | undefined): LayoutStream | undefined {
  const embeddedBurn = options.subtitles?.mode === 'burn' && !options.subtitles.input;
  if (embeddedBurn && !inputStreams) {
    throw new InvalidMediaOptionError("Subtitle 'burn' mode needs a video input with a subtitle stream.");
  }
  if (!embeddedBurn || !inputStreams) return undefined;
  const subtitleStreams = inputStreams.filter((stream) => stream.type === 'subtitle');
  const wanted = options.subtitles?.streamIndex ?? 0;
  if (!Number.isInteger(wanted) || wanted < 0 || wanted >= subtitleStreams.length) {
    throw new InvalidMediaOptionError(
      `Subtitle 'burn' mode needs an input with subtitle stream ${wanted}; the input has ${subtitleStreams.length}.`
    );
  }
  return subtitleStreams[wanted];
}

/** Maps the audio tracks a request chose; false when it named none. */
function addAudioTrackMap(outputArgs: string[], track: number | 'all' | undefined): boolean {
  if (track === 'all') {
    outputArgs.push('-map', '0:a');
    return true;
  }
  if (typeof track === 'number') {
    if (track < 0) {
      throw new InvalidMediaOptionError('Audio track index must be non-negative.');
    }
    outputArgs.push('-map', `0:a:${track}`);
    return true;
  }
  return false;
}

/** `-map` operands, soft subtitle input, chapters and handler names of a probed input. */
function addPlannedStreamMaps(
  ctx: BuildContext,
  probed: { inputLayout: StreamLayout | undefined; inputStreams: LayoutStream[]; burnRequested: boolean; burnBitmapStream: LayoutStream | undefined }
): StreamMapPlan {
  const { tgt, options, passStage, outputArgs } = ctx;
  const { inputLayout, burnBitmapStream } = probed;
  const chapters = inputLayout?.chapters;
  const streamPlan = planStreamMapping({
    streams: probed.inputStreams,
    container: tgt as VideoContainer,
    audioTrack: options.audio?.track,
    burnSubtitles: probed.burnRequested,
    hasChapters: chapters !== undefined,
  });
  // The analysing pass of a two-pass encode reads the picture only.
  const analysisOnly = passStage?.pass === 1;
  for (const operand of streamPlan.maps) {
    // A bitmap subtitle is overlaid by a filter graph, whose output replaces the stored video stream.
    const isVideoOperand = streamPlan.videoIndex !== undefined && operand === `0:${streamPlan.videoIndex}`;
    if (analysisOnly && !isVideoOperand) continue;
    outputArgs.push('-map', burnBitmapStream && isVideoOperand ? BURN_GRAPH_OUTPUT : operand);
  }
  if (options.subtitles?.mode === 'soft' && !analysisOnly) {
    outputArgs.push('-map', '1:0');
  }
  if (CHAPTER_CONTAINERS.has(tgt) && !analysisOnly) {
    addChapterArgs(ctx, chapters);
  }
  for (const { outputIndex, name } of analysisOnly ? [] : streamPlan.handlerNames) {
    outputArgs.push(`-metadata:s:${outputIndex}`, `handler_name=${name}`);
  }
  return streamPlan;
}

function addChapterArgs(ctx: BuildContext, chapters: StreamLayout['chapters']): void {
  const { input, options, inputArgs, outputArgs } = ctx;
  let chapterInput = 0;
  if (chapters !== undefined && chapters.startTimeSec < 0) {
    // A track that starts before zero (AAC encoder delay) makes ffmpeg move the chapters later by that
    // amount, while the picture keeps its place. The chapters are read through a second open of the input
    // that is offset back by the start, which leaves each chapter on the frame it marked.
    chapterInput = inputArgs.filter((arg) => arg === '-i').length;
    inputArgs.push('-itsoffset', chapters.startTimeSec.toFixed(CHAPTER_OFFSET_DECIMALS));
    if (options.trim?.start) inputArgs.push('-ss', options.trim.start);
    inputArgs.push(...mediaInputArgs(input));
  }
  outputArgs.push('-map_metadata', '0', '-map_chapters', String(chapterInput));
}

/** The subtitle codecs of the output; the analysing pass of a two-pass encode writes none. */
function addSoftSubtitleCodecArgs(ctx: BuildContext, streamPlan: StreamMapPlan | undefined): void {
  const { tgt, options, passStage, outputArgs } = ctx;
  if (streamPlan?.subtitleCodec && passStage?.pass !== 1) {
    outputArgs.push('-c:s', streamPlan.subtitleCodec);
  }
  if (options.subtitles?.mode === 'soft' && passStage?.pass !== 1) {
    // For mp4, mov and webm the plan above already set the one codec every subtitle track is written with.
    const codecSetByPlan = Boolean(streamPlan?.subtitleCodec) && tgt !== 'mkv';
    if (tgt === 'mkv') {
      // Only the external track is converted; embedded tracks stay as they are (`-c:s copy` above).
      const externalTrack = streamPlan ? `:${streamPlan.subtitleCount}` : '';
      outputArgs.push(`-c:s${externalTrack}`, options.subtitles.format === 'ass' ? 'ass' : 'srt');
    } else if (!codecSetByPlan) {
      outputArgs.push('-c:s', SOFT_SUBTITLE_CODEC_BY_CONTAINER[tgt] ?? 'copy');
    }
  }
}

function addVariableFrameRateTiming(ctx: BuildContext, isVideo: boolean): void {
  if (isVideo && !hasRequestedFrameRate(ctx.options) && VARIABLE_FRAME_RATE_CONTAINERS.has(ctx.tgt)) {
    ctx.outputArgs.push('-fps_mode', 'passthrough');
  }
}

// ---- Video ----

async function addVideoArguments(ctx: BuildContext, stage: VideoStageInput): Promise<void> {
  const plan = await planVideo(ctx, stage);
  addVideoFilterArgs(ctx, plan, stage);
  addVideoEncoderArgs(ctx, plan, stage);
  if (ctx.passStage) {
    ctx.outputArgs.push(...twoPassEncoderArgs(ctx.passStage, plan.codec));
  }
}

/** Runs the video gates in their order and decides the encoder path and the picture facts. */
async function planVideo(ctx: BuildContext, stage: VideoStageInput): Promise<VideoPlan> {
  const { tgt, options, ffmpegBin } = ctx;
  const driDevice = DRI_DEVICES.find((device) => fs.existsSync(device)) ?? null;

  const videoOpts = options.video;
  const codec = resolveVideoCodec(videoOpts?.codec || options.videoCodec || (tgt === 'webm' ? 'vp9' : 'h264'));
  assertVideoContainerGate(tgt, codec);
  assertVideoProfileAndLevel(codec, videoOpts);
  const rateControl = videoOpts?.rateControl;
  assertCrfRange(codec, rateControl);

  // Bit Depth and HDR Gate (before encoder selection, independent of available hardware)
  // Hardware encoders receive no -profile:v and may only accept 8-bit surfaces (VAAPI uploads
  // nv12, h264_qsv takes nv12), so a 10-bit profile always takes the software encoder path.
  const tenBit = TEN_BIT_PROFILES.has((videoOpts?.profile || '').toLowerCase());
  const hdrToSdr = await planHdrToSdr(ctx, codec, tenBit, stage.mapping.inputLayout);

  // Two-pass needs the software encoders' pass logs, so it never selects a hardware encoder.
  const hardware = !options.disableHwaccel && !tenBit && !stage.twoPass && HARDWARE_ENCODER_TARGETS.has(tgt)
    ? chooseHardwareEncoder(probeHardwareAcceleration(ffmpegBin), codec, driDevice)
    : undefined;

  if (stage.twoPass) {
    assertTwoPassSupported(options, tgt, codec);
  }

  // The picture the encoder receives when no filter below changes its size; undefined when one may.
  const { aspect, mapping } = stage;
  const sizeUntouched = !videoOpts?.crop && !videoOpts?.scale && !aspect && !options.videoResolution && !mapping.burnBitmapStream;
  const sourcePicture = mapping.inputLayout ? firstVideoStream(mapping.inputLayout.streams) : undefined;
  const unscaledPicture = sizeUntouched ? pictureOf(sourcePicture) : undefined;
  const vp9Deadline = vp9DeadlineOfInput({ codec, picture: unscaledPicture, layout: mapping.inputLayout, twoPass: stage.twoPass, rateRequested: hasRequestedFrameRate(options), options });
  return { codec, rateControl, tenBit, hdrToSdr, hardware, driDevice, sourcePicture, unscaledPicture, vp9Deadline };
}

function assertVideoContainerGate(tgt: string, codec: VideoCodecName): void {
  if (tgt === 'webm' && codec !== 'vp9' && codec !== 'av1') {
    throw new InvalidMediaOptionError(
      `WebM container only supports 'vp9' or 'av1' video codecs, but '${codec}' was requested.`
    );
  }
  if (codec === 'prores' && tgt !== 'mov') {
    throw new InvalidMediaOptionError(
      `ProRes video codec is only supported in 'mov' container, but '${tgt}' was requested.`
    );
  }
}

/** Profile and Level Validation Gate */
function assertVideoProfileAndLevel(codec: VideoCodecName, videoOpts: ConversionOptions['video']): void {
  if (codec === 'h264') {
    if (videoOpts?.profile && !H264_ALLOWED_PROFILES.has(videoOpts.profile.toLowerCase())) {
      throw new InvalidMediaOptionError(
        `Invalid H.264 profile '${videoOpts.profile}'. Allowed profiles: ${Array.from(H264_ALLOWED_PROFILES).join(', ')}.`
      );
    }
    if (videoOpts?.level && !H264_ALLOWED_LEVELS.has(videoOpts.level.toLowerCase())) {
      throw new InvalidMediaOptionError(
        `Invalid H.264 level '${videoOpts.level}'. Allowed levels: 3.0 to 5.2.`
      );
    }
  } else if (codec === 'hevc') {
    if (videoOpts?.profile && !HEVC_ALLOWED_PROFILES.has(videoOpts.profile.toLowerCase())) {
      throw new InvalidMediaOptionError(
        `Invalid HEVC profile '${videoOpts.profile}'. Allowed profiles: ${Array.from(HEVC_ALLOWED_PROFILES).join(', ')}.`
      );
    }
  } else if (codec === 'av1') {
    if (videoOpts?.profile && !AV1_ALLOWED_PROFILES.has(videoOpts.profile.toLowerCase())) {
      throw new InvalidMediaOptionError(
        `Invalid AV1 profile '${videoOpts.profile}'. Allowed profiles: main.`
      );
    }
  }
}

/** Rate Control Validation Gate */
function assertCrfRange(codec: VideoCodecName, rateControl: VideoRateControl | undefined): void {
  if (rateControl?.mode !== 'crf') return;
  const crf = rateControl.crf;
  if (codec === 'h264' || codec === 'hevc') {
    if (typeof crf !== 'number' || !Number.isFinite(crf) || crf < 0 || crf > 51) {
      throw new InvalidMediaOptionError(
        `CRF for ${codec.toUpperCase()} must be between 0 and 51, received ${crf}.`
      );
    }
  } else if (codec === 'vp9' || codec === 'av1') {
    if (typeof crf !== 'number' || !Number.isFinite(crf) || crf < 0 || crf > 63) {
      throw new InvalidMediaOptionError(
        `CRF for ${codec.toUpperCase()} must be between 0 and 63, received ${crf}.`
      );
    }
  } else if (codec === 'prores') {
    throw new InvalidMediaOptionError('CRF rate control is not supported for ProRes codec.');
  }
}

/**
 * PQ/HLG samples squeezed into 8 bits unchanged would corrupt the picture: they are tone mapped to SDR, or
 * refused when the request asks to keep HDR.
 */
async function planHdrToSdr(
  ctx: BuildContext,
  codec: VideoCodecName,
  tenBit: boolean,
  inputLayout: StreamLayout | undefined
): Promise<VideoToneMapPlan | undefined> {
  const { input, options, ffmpegBin } = ctx;
  const toneMapMode = options.toneMap ?? DEFAULT_TONE_MAP;
  if (!(TONE_MAP_MODES as readonly string[]).includes(toneMapMode)) {
    throw new InvalidMediaOptionError(`toneMap "${String(toneMapMode)}" is not supported; use one of ${TONE_MAP_MODES.join(', ')}.`);
  }
  if (tenBit || codec === 'prores' || inputLayout === undefined) return undefined;
  const transfer = layoutColorTransfer(inputLayout);
  if (!HDR_TRANSFERS.has(transfer)) return undefined;
  if (toneMapMode === 'none') {
    throw new InvalidMediaOptionError(
      `HDR input (transfer "${transfer}") needs a 10-bit profile such as hevc main10 when toneMap is "none"; 8-bit output without tone mapping is not supported.`
    );
  }
  assertZscaleAvailable(ffmpegBin);
  return planVideoToneMap(transfer, toneMapMode, await probeVideoMaxLightLevel(input, resolveFfprobeBinary(ffmpegBin), options.signal));
}

/** The first hardware encoder of the codec the host can open a session on, in the order NVENC, VAAPI, VideoToolbox, QSV. */
function chooseHardwareEncoder(
  hw: HardwareAccelerationCapabilities,
  codec: VideoCodecName,
  driDevice: string | null
): HardwareEncoderKind | undefined {
  if (codec !== 'h264' && codec !== 'hevc') return undefined;
  const hasEncoder = (kind: HardwareEncoderKind) => hw.supportedEncoders.has(`${codec}_${kind}`);
  if (hw.nvenc && hasEncoder('nvenc')) return 'nvenc';
  if (hw.vaapi && driDevice && hasEncoder('vaapi')) return 'vaapi';
  if (hw.videotoolbox && hasEncoder('videotoolbox')) return 'videotoolbox';
  if (codec === 'h264' && hw.qsv && hasEncoder('qsv')) return 'qsv';
  return undefined;
}

function rotateFilter(rot: number): string | undefined {
  if (rot === 90) return 'transpose=1';
  if (rot === 180) return 'transpose=2,transpose=2';
  if (rot === 270) return 'transpose=2';
  if (rot !== 0) {
    throw new InvalidMediaOptionError(`Invalid rotate angle ${rot}. Allowed values: 0, 90, 180, 270.`);
  }
  return undefined;
}

function scaleFilter(options: ConversionOptions): string | undefined {
  const scale = options.video?.scale;
  if (scale) {
    const { width, height, fit } = scale;
    const w = width && width > 0 ? width : -1;
    const h = height && height > 0 ? height : -1;
    if (fit === 'cover' && width && height) {
      return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
    }
    if (fit === 'stretch') {
      return `scale=${w}:${h}`;
    }
    return `scale=${w}:${h}:force_original_aspect_ratio=decrease`;
  }
  if (options.videoResolution && options.videoResolution !== 'original' && VIDEO_RESOLUTION_SIZES[options.videoResolution]) {
    return `scale=${VIDEO_RESOLUTION_SIZES[options.videoResolution]}:force_original_aspect_ratio=decrease`;
  }
  return undefined;
}

/** One control only: the fps filter. The output option -r is never emitted next to it. */
function fpsFilter(options: ConversionOptions): string | undefined {
  const requestedFps = options.video?.fps ?? options.videoFps;
  if (requestedFps === undefined) return undefined;
  if (typeof requestedFps !== 'number' || !Number.isFinite(requestedFps) || requestedFps <= 0 || requestedFps > MAX_OUTPUT_FPS) {
    throw new InvalidMediaOptionError(`Invalid frame rate ${requestedFps}. Allowed: more than 0 and at most ${MAX_OUTPUT_FPS}.`);
  }
  return `fps=${requestedFps}`;
}

/** An external subtitle file, or a text subtitle stream of the input itself (`si` counts subtitle streams). */
function burnSubtitlesFilter(ctx: BuildContext): string {
  const { input, options } = ctx;
  const source = options.subtitles?.input ?? input.path;
  const stream = options.subtitles?.input ? '' : `:si=${options.subtitles?.streamIndex ?? 0}`;
  return `subtitles=filename=${escapeFfmpegFilterPath(source)}${stream}`;
}

/**
 * Even dimension normalization (ALWAYS LAST filter before format). A picture the header gives an even
 * size, and nothing above resizes, is already even: the filter would only add a stage to the graph.
 * A stream with a crop (container clean aperture or frame cropping) decodes to a smaller picture than it is stored at.
 */
function needsEvenDimensionFilter(plan: VideoPlan): boolean {
  const { unscaledPicture, sourcePicture } = plan;
  const alreadyEven =
    unscaledPicture !== undefined &&
    sourcePicture?.cropped !== true &&
    unscaledPicture.width % 2 === 0 &&
    unscaledPicture.height % 2 === 0;
  return !alreadyEven;
}

/**
 * Strict filter graph: bwdif -> crop -> transpose -> scale -> aspect -> fps -> HDR to SDR -> subtitles (burn)
 * -> even parity correction -> display aspect ratio -> VAAPI upload.
 */
function videoFilterChain(ctx: BuildContext, plan: VideoPlan, stage: VideoStageInput): string[] {
  const { options } = ctx;
  const videoOpts = options.video;
  const videoFilters: string[] = [];
  const add = (filter: string | undefined) => {
    if (filter !== undefined) videoFilters.push(filter);
  };

  if (videoOpts?.deinterlace) {
    videoFilters.push(DEINTERLACE_FILTER);
  }
  if (videoOpts?.crop) {
    const { w, h, x, y } = videoOpts.crop;
    videoFilters.push(`crop=${w}:${h}:${x}:${y}`);
  }
  if (typeof videoOpts?.rotate === 'number') {
    add(rotateFilter(videoOpts.rotate));
  }
  add(scaleFilter(options));
  // Aspect ratio by padding or cropping (the default mode only sets the display ratio, below)
  const reshape = stage.aspect ? aspectReshapeFilter(stage.aspect) : undefined;
  if (reshape) {
    videoFilters.push(reshape);
  }
  add(fpsFilter(options));
  // HDR to SDR after the geometry filters so fewer pixels go through the 16-bit chain, before any burn-in
  add(plan.hdrToSdr?.filter);
  if (stage.mapping.burnRequested && !stage.mapping.burnBitmapStream) {
    videoFilters.push(burnSubtitlesFilter(ctx));
  }
  if (needsEvenDimensionFilter(plan)) {
    videoFilters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
  }
  // Display aspect ratio without touching the pixels
  if (stage.aspect?.mode === 'dar') {
    videoFilters.push(`setdar=${stage.aspect.num}/${stage.aspect.den}`);
  }
  // Format upload (for VAAPI)
  if (plan.hardware === 'vaapi') {
    videoFilters.push('format=nv12,hwupload');
  }
  return videoFilters;
}

function addVideoFilterArgs(ctx: BuildContext, plan: VideoPlan, stage: VideoStageInput): void {
  const { outputArgs } = ctx;
  const videoFilters = videoFilterChain(ctx, plan, stage);
  const { streamPlan, burnBitmapStream } = stage.mapping;
  if (burnBitmapStream && streamPlan?.videoIndex !== undefined) {
    // Picture subtitles are overlaid at the source size, before any crop or scale moves the picture.
    outputArgs.push(
      '-filter_complex',
      `[0:${streamPlan.videoIndex}][0:${burnBitmapStream.index}]overlay=format=auto:eof_action=pass,${videoFilters.join(',')}${BURN_GRAPH_OUTPUT}`
    );
  } else if (videoFilters.length > 0) {
    outputArgs.push('-vf', videoFilters.join(','));
  }

  // Software pixel format (exclude VAAPI which uses hwupload, and ProRes which has custom 10-bit format)
  if (plan.hardware !== 'vaapi' && plan.codec !== 'prores') {
    outputArgs.push('-pix_fmt', plan.tenBit ? TEN_BIT_PIX_FMT : EIGHT_BIT_PIX_FMT);
  }
  // The SDR rendition says so in its stream tags and the encoders' VUI, on every encoder path.
  if (plan.hdrToSdr) {
    outputArgs.push(...SDR_COLOUR_ARGS);
  }
}

/** Video Encoder Selection and Arguments */
function addVideoEncoderArgs(ctx: BuildContext, plan: VideoPlan, stage: VideoStageInput): void {
  const { tgt, options, passStage, outputArgs } = ctx;
  const { codec, rateControl } = plan;
  if (tgt === 'mp4' || tgt === 'mov' || tgt === 'mkv') {
    addMp4FamilyEncoderArgs(ctx, plan);
    outputArgs.push(...bitrateControlArgs(rateControl, options, codec));

    if ((tgt === 'mp4' || tgt === 'mov') && stage.fastStart && passStage?.pass !== 1) {
      outputArgs.push('-movflags', '+faststart');
    }
  } else if (tgt === 'webm') {
    addWebmEncoderArgs(ctx, plan);
    outputArgs.push(...bitrateControlArgs(rateControl, options, codec));
  } else if (tgt === 'avi') {
    // The MP3 encoder's priming gives the audio a negative start; shifting every stream to make it
    // non-negative moves the video by one frame in AVI (a frame lost at 0.04 s). Keep the timestamps.
    outputArgs.push('-c:v', 'mpeg4', '-vtag', 'XVID', ...MPEG4_QUALITY_ARGS, '-avoid_negative_ts', 'disabled');
    const rateArgs = bitrateControlArgs(rateControl, options, 'mpeg4');
    // Without a requested rate, constant quality instead of the encoder's 200 kbit/s default.
    outputArgs.push(...(rateArgs.length > 0 ? rateArgs : ['-q:v', String(MPEG4_DEFAULT_QSCALE)]));
  }
}

function addMp4FamilyEncoderArgs(ctx: BuildContext, plan: VideoPlan): void {
  const { options, ffmpegBin, outputArgs } = ctx;
  const { codec, rateControl } = plan;
  const videoOpts = options.video;
  if (codec === 'h264' || codec === 'hevc') {
    addH26xEncoderArgs(ctx, plan);
  } else if (codec === 'vp9') {
    outputArgs.push(...vp9Args(rateControl, plan.vp9Deadline));
  } else if (codec === 'av1') {
    assertSvtAv1Available(ffmpegBin);
    outputArgs.push(...svtAv1Args(rateControl, videoOpts?.preset, videoOpts?.profile));
  } else if (codec === 'prores') {
    outputArgs.push('-c:v', 'prores_ks');
    const p = videoOpts?.profile?.toLowerCase();
    const prof = p && PRORES_PROFILE_NUMBERS[p] ? PRORES_PROFILE_NUMBERS[p] : DEFAULT_PRORES_PROFILE;
    outputArgs.push(
      '-profile:v', prof,
      '-pix_fmt', prof === '4' ? 'yuva444p10le' : 'yuv422p10le'
    );
  }
}

function addWebmEncoderArgs(ctx: BuildContext, plan: VideoPlan): void {
  const { options, ffmpegBin, outputArgs } = ctx;
  const videoOpts = options.video;
  if (plan.codec === 'av1') {
    assertSvtAv1Available(ffmpegBin);
    outputArgs.push(...svtAv1Args(plan.rateControl, videoOpts?.preset, videoOpts?.profile));
  } else {
    outputArgs.push(...vp9Args(plan.rateControl, plan.vp9Deadline));
  }
}

/** H.264 and HEVC: the hardware encoder the plan chose, else the software one. */
function addH26xEncoderArgs(ctx: BuildContext, plan: VideoPlan): void {
  const { options, globalArgs, outputArgs } = ctx;
  const { codec, rateControl, hardware, driDevice } = plan;
  const videoOpts = options.video;
  const isH264 = codec === 'h264';
  const defaultCrf = isH264 ? '23' : '26';
  const defaultVaapiQp = isH264 ? '24' : '26';
  const crfVal = rateControl?.mode === 'crf' ? String(rateControl.crf) : defaultCrf;

  if (hardware === 'nvenc') {
    outputArgs.push('-c:v', `${codec}_nvenc`, '-preset', videoOpts?.preset || 'p4');
    if (rateControl?.mode === 'crf' || !rateControl) {
      outputArgs.push('-cq', crfVal);
    }
  } else if (hardware === 'vaapi' && driDevice) {
    globalArgs.push('-vaapi_device', driDevice);
    outputArgs.push('-filter_hw_device', driDevice, '-c:v', `${codec}_vaapi`);
    if (rateControl?.mode === 'crf') {
      outputArgs.push('-qp', String(rateControl.crf));
    } else if (!rateControl) {
      outputArgs.push('-qp', defaultVaapiQp);
    }
  } else if (hardware === 'videotoolbox') {
    outputArgs.push('-c:v', `${codec}_videotoolbox`);
    if (rateControl?.mode === 'crf') {
      outputArgs.push('-q:v', String(Math.max(1, Math.min(100, Math.round(100 - rateControl.crf * 1.5)))));
    } else if (!rateControl) {
      outputArgs.push('-q:v', '65');
    }
  } else if (isH264 && hardware === 'qsv') {
    outputArgs.push('-c:v', 'h264_qsv');
    if (rateControl?.mode === 'crf' || !rateControl) {
      outputArgs.push('-global_quality', crfVal);
    }
  } else {
    addSoftwareH26xArgs(ctx, plan, crfVal);
  }
}

function addSoftwareH26xArgs(ctx: BuildContext, plan: VideoPlan, crfVal: string): void {
  const { options, passStage, outputArgs } = ctx;
  const { codec, rateControl } = plan;
  const videoOpts = options.video;
  outputArgs.push('-c:v', codec === 'h264' ? 'libx264' : 'libx265', '-preset', resolveX26xPreset(videoOpts?.preset));
  if (rateControl?.mode === 'crf' || !rateControl) {
    outputArgs.push('-crf', crfVal);
  }
  if (videoOpts?.profile) {
    outputArgs.push('-profile:v', videoOpts.profile.toLowerCase());
  }
  if (codec === 'h264' && videoOpts?.level) {
    outputArgs.push('-level', videoOpts.level);
  }
  // Both passes of a two-pass encode must agree, and an encode held to a bitrate estimates its rate worse
  // with more threads; neither is given a count.
  const unconstrained = bitrateControlArgs(rateControl, options, codec).length === 0;
  const threads = passStage || !unconstrained ? undefined : softwareEncoderThreads(codec, plan.unscaledPicture);
  if (threads !== undefined) {
    outputArgs.push('-threads', String(threads));
  }
}

// ---- Audio ----

/** What the audio stage needs from the checks and decisions made before it. */
interface AudioStageInput {
  isVideo: boolean;
  audioSpec: AudioTargetSpec | undefined;
  specEncoderInUse: boolean;
  mapping: StreamMapping;
}

function resolveAudioEncoder(ctx: BuildContext, stage: AudioStageInput): string {
  const { tgt, options } = ctx;
  if (options.audio?.codec) {
    return AUDIO_CODEC_MAP[options.audio.codec];
  }
  if (stage.isVideo) {
    if (tgt === 'webm') return 'libopus';
    return tgt === 'avi' ? 'libmp3lame' : 'aac';
  }
  return stage.audioSpec ? stage.audioSpec.encoder : 'aac';
}

/**
 * The audio encoder, bitrate, format, filters and loudness handling. Returns the complete arguments of the
 * loudness measuring pass when that is what was asked for; undefined when the encode arguments were filled in.
 */
async function addAudioArguments(ctx: BuildContext, stage: AudioStageInput): Promise<string[] | undefined> {
  const { tgt, options, ffmpegBin, outputArgs } = ctx;
  const { isVideo, audioSpec } = stage;
  const resolvedAudioCodec = resolveAudioEncoder(ctx, stage);

  if (audioSpec && ffmpegBin) {
    assertEncoderAvailable(tgt, resolvedAudioCodec, probeSupportedEncoders(ffmpegBin));
  }

  outputArgs.push('-c:a', resolvedAudioCodec);
  if (audioSpec) {
    outputArgs.push('-f', audioSpec.muxer);
  }
  addAudioBitrateArgs(ctx, stage, resolvedAudioCodec);

  // Audio filters and ITU-R BS.775 downmix
  const audioFilters: string[] = [];
  /** `-ac` and `-ar`: shared by the encode and the loudness measuring pass, which must see the same audio. */
  const audioFormatArgs: string[] = [];
  if (isVideo) {
    // The audio is re-encoded: start it at zero and fill or trim leading gaps so it stays in step with the picture.
    audioFilters.push(AUDIO_SYNC_FILTER);
  }
  const channelPlan = await planAudioChannels(audioSpec, stage.specEncoderInUse, options, ctx.input, ffmpegBin);
  audioFilters.push(...channelPlan.filters);
  audioFormatArgs.push(...channelPlan.args);
  audioFormatArgs.push(...(await audioSampleRateArgs(ctx, stage)));
  outputArgs.push(...audioFormatArgs);

  const volumeFilter = audioVolumeFilter(options);
  if (volumeFilter !== undefined) {
    audioFilters.push(volumeFilter);
  }

  const loudness = addLoudnessFilter(ctx, stage, audioFormatArgs, audioFilters);
  if (loudness.measureArguments) return loudness.measureArguments;
  addResampleFilters(ctx, { audioFormatArgs, audioFilters, resolvedAudioCodec, loudnessRate: loudness.rate });

  if (audioFilters.length > 0) {
    outputArgs.push('-filter:a', audioFilters.join(','));
  }
  return undefined;
}

function addAudioBitrateArgs(ctx: BuildContext, stage: AudioStageInput, resolvedAudioCodec: string): void {
  const { tgt, options, outputArgs } = ctx;
  const { audioSpec } = stage;
  if (typeof options.audio?.bitrateK === 'number') {
    if (!Number.isFinite(options.audio.bitrateK) || options.audio.bitrateK <= 0) {
      throw new InvalidMediaOptionError(`Invalid audio bitrate: ${options.audio.bitrateK}k`);
    }
    outputArgs.push('-b:a', `${Math.floor(options.audio.bitrateK)}k`);
  } else if (options.audioBitrate && /^\d+[kK]?$/.test(options.audioBitrate)) {
    outputArgs.push('-b:a', options.audioBitrate.toLowerCase().endsWith('k') ? options.audioBitrate : `${options.audioBitrate}k`);
  } else if (audioSpec && stage.specEncoderInUse) {
    if (audioSpec.defaultBitrate !== undefined) {
      outputArgs.push('-b:a', audioSpec.defaultBitrate);
    } else if (audioSpec.defaultQuality !== undefined) {
      outputArgs.push('-q:a', audioSpec.defaultQuality);
    }
  } else if (audioSpec && resolvedAudioCodec === 'libvorbis') {
    // A caller-selected Vorbis codec on another container (webm) needs the same rate-safe default.
    outputArgs.push('-q:a', VORBIS_DEFAULT_QUALITY);
  } else if (resolvedAudioCodec !== 'flac' && resolvedAudioCodec !== 'pcm_s16le') {
    if (tgt === 'webm' || resolvedAudioCodec === 'libopus') {
      outputArgs.push('-b:a', '128k');
    } else {
      outputArgs.push('-b:a', '192k');
    }
  }
}

/** `-ar`: the spec's fixed rate, the request's rate, or for a spec encoder the rate the input already keeps or is brought to. */
async function audioSampleRateArgs(ctx: BuildContext, stage: AudioStageInput): Promise<string[]> {
  const { input, options, ffmpegBin } = ctx;
  const { audioSpec, specEncoderInUse } = stage;
  if (audioSpec?.fixedSampleRate !== undefined) {
    return ['-ar', String(audioSpec.fixedSampleRate)];
  }
  if (typeof options.audio?.sampleRate === 'number') {
    if (!Number.isFinite(options.audio.sampleRate) || options.audio.sampleRate < MIN_AUDIO_SAMPLE_RATE || options.audio.sampleRate > MAX_AUDIO_SAMPLE_RATE) {
      throw new InvalidMediaOptionError(`Invalid audio sample rate: ${options.audio.sampleRate}. Allowed range: 8000 to 192000 Hz.`);
    }
    return ['-ar', String(options.audio.sampleRate)];
  }
  if (typeof options.audioSampleRate === 'number' && Number.isFinite(options.audioSampleRate) && options.audioSampleRate >= MIN_AUDIO_SAMPLE_RATE && options.audioSampleRate <= MAX_AUDIO_SAMPLE_RATE) {
    return ['-ar', String(options.audioSampleRate)];
  }
  if (audioSpec && specEncoderInUse && (audioSpec.allowedSampleRates || audioSpec.maxSampleRate) && fs.existsSync(input.path)) {
    // The caller set no rate: an input the encoder codes natively keeps its rate (a forced rate makes libopus
    // code a band the signal does not have), and one it cannot code is brought into its supported set.
    const track = typeof options.audio?.track === 'number' ? options.audio.track : 0;
    const resampleRate = resampleRateFor(audioSpec, await probeAudioSampleRate(input, resolveFfprobeBinary(ffmpegBin), track, options.signal));
    return resampleRate === undefined ? [] : ['-ar', String(resampleRate)];
  }
  if (audioSpec?.defaultSampleRate !== undefined && specEncoderInUse) {
    return ['-ar', String(audioSpec.defaultSampleRate)];
  }
  return [];
}

function audioVolumeFilter(options: ConversionOptions): string | undefined {
  if (typeof options.audio?.volume === 'number') {
    if (!Number.isFinite(options.audio.volume) || options.audio.volume < 0 || options.audio.volume > MAX_AUDIO_VOLUME_PERCENT) {
      throw new InvalidMediaOptionError(`Invalid audio volume: ${options.audio.volume}. Allowed range: 0 to 200%.`);
    }
    return options.audio.volume !== 100 ? `volume=${options.audio.volume / 100}` : undefined;
  }
  if (typeof options.audioVolume === 'number' && Number.isFinite(options.audioVolume) && options.audioVolume >= 0 && options.audioVolume <= MAX_AUDIO_VOLUME_PERCENT && options.audioVolume !== 100) {
    return `volume=${options.audioVolume / 100}`;
  }
  return undefined;
}

/**
 * Loudness normalisation (two passes). The measuring pass returns its complete arguments; the encode gets the
 * loudnorm filter and the measured sample rate, which the output is brought back to after loudnorm's 192 kHz.
 */
function addLoudnessFilter(
  ctx: BuildContext,
  stage: AudioStageInput,
  audioFormatArgs: string[],
  audioFilters: string[]
): { measureArguments?: string[]; rate?: number } {
  const { options, loudnessStage, globalArgs, inputArgs } = ctx;
  const { audioSpec } = stage;
  const loudnessTarget = options.audio?.loudness ? resolveLoudnessTarget(options.audio.loudness) : undefined;
  if (!loudnessTarget) return {};
  if (!loudnessStage) {
    throw new ConversionFailedError('Loudness normalisation needs its measuring pass before the encode; no measurement was given.');
  }
  const audioMaps = audioSpec ? undefined : stage.mapping.streamPlan?.audioMaps;
  if (!audioSpec && (audioMaps === undefined || audioMaps.length !== 1)) {
    throw new InvalidMediaOptionError(
      audioMaps === undefined
        ? 'Loudness normalisation needs an input file to measure.'
        : `Loudness normalisation measures one audio track; this conversion maps ${audioMaps.length}. Select one with audio.track.`
    );
  }
  if (loudnessStage.kind === 'measure') {
    const mapArgs = audioSpec ? stage.mapping.audioOnlyMapArgs : ['-vn', '-sn', '-dn', '-map', (audioMaps as string[])[0]];
    return {
      measureArguments: [
        ...globalArgs,
        ...inputArgs,
        ...mapArgs,
        ...audioFormatArgs,
        '-af', [...audioFilters, loudnormMeasureFilter(loudnessTarget)].join(','),
        '-f', 'null', '-',
      ],
    };
  }
  audioFilters.push(loudnormApplyFilter(loudnessTarget, loudnessStage.measurement));
  return { rate: loudnessStage.measurement.sampleRate };
}

/** The final resample with the chosen resampler and 16-bit dither. */
function addResampleFilters(
  ctx: BuildContext,
  audio: { audioFormatArgs: string[]; audioFilters: string[]; resolvedAudioCodec: string; loudnessRate: number | undefined }
): void {
  const { options, ffmpegBin } = ctx;
  const { audioFormatArgs, audioFilters, resolvedAudioCodec, loudnessRate } = audio;
  const requestedRate = audioFormatArgs.includes('-ar') ? Number(audioFormatArgs[audioFormatArgs.indexOf('-ar') + 1]) : undefined;
  const finalRate = requestedRate ?? loudnessRate;
  const dither = resolveDither(options.audio?.dither, resolvedAudioCodec);
  const resampler = chooseResampler(options.audio?.resampler, ffmpegBin);
  const precision = resamplePrecisionFor(resolvedAudioCodec, loudnessRate === undefined && options.audio?.resampler === undefined);
  if (precision !== undefined && finalRate !== undefined && (resampler.resampler === 'soxr' || dither !== undefined || loudnessRate !== undefined)) {
    audioFilters.push(resampleFilter(finalRate, resampler, dither, precision));
  } else if (dither !== undefined) {
    audioFilters.push(`aresample=dither_method=${dither}`);
  }
  if (dither !== undefined) {
    audioFilters.push(SIXTEEN_BIT_FORMAT_FILTER);
  }
}

