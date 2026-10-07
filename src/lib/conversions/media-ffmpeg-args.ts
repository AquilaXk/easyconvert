import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ConversionFailedError,
  ConversionOptions,
  EngineUnavailableError,
  InvalidMediaOptionError,
  AudioCodec,
  MediaLadderRung,
  MediaPackagingOptions,
  MediaPackagingFormat,
} from '../types';
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
  probeAudioChannels,
  probeAudioSampleRate,
  probeAudioStreamCount,
  probeVideoColorTransfer,
  resolveFfprobeBinary,
  probeVideoGeometry,
  VideoGeometry,
} from './media-ffprobe';
import {
  capLadderToSource,
  forcedKeyframeExpression,
  keyframeIntervalFrames,
  resolveSegmentType,
  rungRateCaps,
  MIN_RUNG_BITRATE_K,
} from './media-packaging';

export {
  probeAudioChannels,
  probeAudioSampleRate,
  probeAudioStreamCount,
  probeVideoColorTransfer,
  resolveFfprobeBinary,
};
export type { FfprobePath };

export interface HardwareAccelerationCapabilities {
  nvenc: boolean;
  vaapi: boolean;
  qsv: boolean;
  videotoolbox: boolean;
  supportedEncoders: Set<string>;
  probedAt: number;
}

export const AUDIO_CODEC_MAP: Record<AudioCodec, string> = {
  aac: 'aac',
  mp3: 'libmp3lame',
  opus: 'libopus',
  flac: 'flac',
  vorbis: 'libvorbis',
  pcm_s16le: 'pcm_s16le',
};

/**
 * Escapes file paths for safe inclusion in FFmpeg filter graph strings (e.g. subtitles filter).
 */
export function escapeFfmpegFilterPath(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "'\\\\''");
}

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

/**
 * Probe results per ffmpeg binary (and DRM directory). The probe runs synchronously, so a long
 * lifetime keeps it off the request path; the worker warms it at startup.
 */
const hwCapabilityCache = new Map<string, HardwareAccelerationCapabilities>();
const PROBE_CACHE_TTL_MS = 10 * 60 * 1000;
/** A child that ignores SIGTERM must not outlive its probe timeout. */
const PROBE_KILL_SIGNAL = 'SIGKILL';
const ENCODER_LIST_TIMEOUT_MS = 3000;
/** Directory that holds the DRM nodes Intel Quick Sync needs. */
const DRM_DEVICE_DIR = '/dev/dri';
const DRM_RENDER_NODE = /^renderD\d+$/;
/** Opening a hardware session is quick on a working device; a hung driver must not stall conversions. */
const HW_SESSION_PROBE_TIMEOUT_MS = 5000;
const HW_PROBE_FRAME_SIZE = '256x256';
const QSV_ENCODERS = ['h264_qsv', 'hevc_qsv'];
const NVENC_ENCODERS = ['h264_nvenc', 'hevc_nvenc'];
const VAAPI_ENCODERS = ['h264_vaapi', 'hevc_vaapi'];
const VAAPI_DEVICES = ['/dev/dri/renderD128', '/dev/dri/card0'];
const VAAPI_UPLOAD_FILTER = 'format=nv12,hwupload';
/**
 * One `ffmpeg -encoders` row: a type letter (V, A, S) and five capability flags (F, S, X, B, D or
 * a dot), then the encoder name. Most encoders carry the D (direct rendering) flag.
 */
const ENCODER_LISTING_LINE = /^\s*[VAS][.FSXBD]{5}\s+([a-zA-Z0-9_-]+)/;
const HARDWARE_ENCODER_NAME = /_(nvenc|vaapi|qsv|videotoolbox)$/;

/** Test seam for the host facts the probe reads. */
export interface HardwareProbeEnvironment {
  /** Directory scanned for DRM render nodes; defaults to /dev/dri. */
  drmDir?: string;
}

function hasDrmRenderNode(drmDir: string): boolean {
  try {
    return fs.readdirSync(drmDir).some((entry) => DRM_RENDER_NODE.test(entry));
  } catch {
    return false;
  }
}

/**
 * Encodes one black frame with a hardware encoder to a null sink. Listing an encoder only proves
 * it was compiled in; a session can still fail (no device, missing driver or libcuda), so this
 * decides whether the encoder may be selected.
 */
function canOpenEncoderSession(
  ffmpegPath: string,
  encoder: string,
  deviceArgs: readonly string[] = [],
  filter?: string
): boolean {
  try {
    execFileSync(
      ffmpegPath,
      [
        '-hide_banner', '-v', 'error', ...deviceArgs,
        '-f', 'lavfi', '-i', `color=c=black:s=${HW_PROBE_FRAME_SIZE}:r=1:d=1`,
        ...(filter ? ['-vf', filter] : []),
        '-frames:v', '1', '-c:v', encoder, '-f', 'null', '-',
      ],
      { stdio: 'ignore', timeout: HW_SESSION_PROBE_TIMEOUT_MS, killSignal: PROBE_KILL_SIGNAL }
    );
    return true;
  } catch {
    return false;
  }
}

/** True when the ffmpeg arguments select a hardware video encoder (nvenc, vaapi, qsv, videotoolbox). */
export function usesHardwareVideoEncoder(args: readonly string[]): boolean {
  const idx = args.indexOf('-c:v');
  return idx >= 0 && idx + 1 < args.length && HARDWARE_ENCODER_NAME.test(args[idx + 1]);
}

export function resetHardwareAccelerationCache(): void {
  hwCapabilityCache.clear();
}

/**
 * Dynamically probes FFmpeg binary for hardware-accelerated video encoders.
 * Caches results in-memory with a 10-minute TTL to avoid redundant CLI executions.
 */
export function probeHardwareAcceleration(
  ffmpegPath?: string | null,
  env: HardwareProbeEnvironment = {}
): HardwareAccelerationCapabilities {
  const now = Date.now();
  const cacheKey = `${ffmpegPath ?? ''}\0${env.drmDir ?? ''}`;
  const cached = hwCapabilityCache.get(cacheKey);
  if (cached && now - cached.probedAt < PROBE_CACHE_TTL_MS) {
    return cached;
  }

  const defaultCaps: HardwareAccelerationCapabilities = {
    nvenc: false,
    vaapi: false,
    qsv: false,
    videotoolbox: false,
    supportedEncoders: new Set<string>(),
    probedAt: now,
  };

  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    // Not cached: a binary installed later must be seen at once, and this check costs one stat.
    return defaultCaps;
  }

  try {
    const output = execFileSync(ffmpegPath, ['-hide_banner', '-encoders'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: ENCODER_LIST_TIMEOUT_MS,
      killSignal: PROBE_KILL_SIGNAL,
    });

    const supported = new Set<string>();
    const lines = output.split('\n');
    for (const line of lines) {
      const match = line.match(ENCODER_LISTING_LINE);
      if (match) {
        supported.add(match[1]);
      }
    }

    const vaapiDevice = VAAPI_DEVICES.find((device) => fs.existsSync(device));
    const isDarwin = process.platform === 'darwin';
    // QSV needs a DRM render node and a session that really opens, not just a compiled-in encoder.
    const qsvEncoder = QSV_ENCODERS.find((enc) => supported.has(enc));
    const qsv =
      qsvEncoder !== undefined &&
      hasDrmRenderNode(env.drmDir ?? DRM_DEVICE_DIR) &&
      canOpenEncoderSession(ffmpegPath, qsvEncoder);
    // NVENC and VAAPI are also only usable when a session really opens (no GPU, no driver, no libcuda).
    const nvencEncoder = NVENC_ENCODERS.find((enc) => supported.has(enc));
    const nvenc = nvencEncoder !== undefined && canOpenEncoderSession(ffmpegPath, nvencEncoder);
    const vaapiEncoder = VAAPI_ENCODERS.find((enc) => supported.has(enc));
    const vaapi =
      vaapiEncoder !== undefined &&
      vaapiDevice !== undefined &&
      canOpenEncoderSession(ffmpegPath, vaapiEncoder, ['-vaapi_device', vaapiDevice], VAAPI_UPLOAD_FILTER);

    const caps: HardwareAccelerationCapabilities = {
      nvenc,
      vaapi,
      qsv,
      videotoolbox: isDarwin && (supported.has('h264_videotoolbox') || supported.has('hevc_videotoolbox')),
      supportedEncoders: supported,
      probedAt: now,
    };

    hwCapabilityCache.set(cacheKey, caps);
    return caps;
  } catch {
    hwCapabilityCache.set(cacheKey, defaultCaps);
    return defaultCaps;
  }
}

const VIDEO_CODECS: ReadonlySet<string> = new Set(['h264', 'hevc', 'vp9', 'av1', 'prores']);
/** Spellings accepted for a codec; h265 is the common name of hevc. */
const VIDEO_CODEC_ALIASES: Readonly<Record<string, string>> = { h265: 'hevc' };

type VideoCodecName = 'h264' | 'hevc' | 'vp9' | 'av1' | 'prores';

/** Normalizes a requested video codec, rejecting any name this builder cannot encode. */
function resolveVideoCodec(requested: string): VideoCodecName {
  const name = Object.hasOwn(VIDEO_CODEC_ALIASES, requested) ? VIDEO_CODEC_ALIASES[requested] : requested;
  if (!VIDEO_CODECS.has(name)) {
    throw new InvalidMediaOptionError(
      `Unsupported video codec '${requested}'. Allowed: ${[...VIDEO_CODECS].join(', ')} (h265 is accepted as hevc).`
    );
  }
  return name as VideoCodecName;
}

const CHANNELS_BY_LAYOUT_NAME: Readonly<Record<string, number>> = { mono: 1, stereo: 2, '5.1': 6, '7.1': 8 };
const DOWNMIX_CHANNELS = 2;

/** Channel count the caller asked for, in the same precedence the encoder arguments use. */
function requestedChannelCount(options: ConversionOptions): number | undefined {
  if (options.audio?.downmix === 'itu-r-bs775') return DOWNMIX_CHANNELS;
  if (options.audio?.channels) return options.audio.channels;
  if (options.audioChannels && Object.hasOwn(CHANNELS_BY_LAYOUT_NAME, options.audioChannels)) {
    return CHANNELS_BY_LAYOUT_NAME[options.audioChannels];
  }
  return undefined;
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

function assertFixedChannels(tgt: string, spec: AudioTargetSpec, channels: number | undefined): void {
  if (spec.fixedChannels !== undefined && channels !== undefined && channels !== spec.fixedChannels) {
    throw new InvalidMediaOptionError(
      `The '${tgt}' target only supports ${spec.fixedChannels} audio channel(s), but ${channels} were requested.`
    );
  }
}

/** Requested channel count, or the selected input track's own count when the caller set none. */
function channelsToWrite(options: ConversionOptions, inputPath: string, ffmpegBin?: string | null): number | undefined {
  const requested = requestedChannelCount(options);
  if (requested !== undefined || !fs.existsSync(inputPath)) return requested;
  const track = typeof options.audio?.track === 'number' ? options.audio.track : 0;
  return probeAudioChannels(inputPath, resolveFfprobeBinary(ffmpegBin), track);
}

function assertMaxChannels(
  tgt: string,
  spec: AudioTargetSpec,
  options: ConversionOptions,
  inputPath: string,
  ffmpegBin?: string | null
): void {
  if (spec.maxChannels === undefined) return;
  const channels = channelsToWrite(options, inputPath, ffmpegBin);
  if (channels !== undefined && channels > spec.maxChannels) {
    throw new InvalidMediaOptionError(
      `The '${tgt}' target supports at most ${spec.maxChannels} audio channels, but ${channels} would be written; request fewer channels or a downmix.`
    );
  }
}

/**
 * Rejects a sample rate or channel count that the target's encoder cannot honour, before ffmpeg
 * runs. The limits describe the target's own encoder, so they apply unless the caller swaps the codec.
 */
function assertEncoderLimits(
  tgt: string,
  spec: AudioTargetSpec,
  options: ConversionOptions,
  inputPath: string,
  ffmpegBin?: string | null
): void {
  assertSampleRateLimits(tgt, spec, options.audio?.sampleRate ?? options.audioSampleRate);
  assertFixedChannels(tgt, spec, requestedChannelCount(options));
  assertMaxChannels(tgt, spec, options, inputPath, ffmpegBin);
}

/**
 * Output arguments that keep exactly one audio stream: every other stream class is dropped and the
 * selected audio stream (the first by default) is mapped explicitly. An input without that stream
 * throws instead of producing an empty or video-carrying file.
 */
function audioOnlyStreamArgs(
  tgt: string,
  inputPath: string,
  options: ConversionOptions,
  ffmpegBin?: string | null
): string[] {
  const track = options.audio?.track;
  if (track === 'all') {
    throw new InvalidMediaOptionError(`The '${tgt}' target holds a single audio stream; audio.track 'all' is not supported.`);
  }
  const index = track ?? 0;
  if (!Number.isInteger(index) || index < 0) {
    throw new InvalidMediaOptionError('Audio track index must be a non-negative integer.');
  }
  if (fs.existsSync(inputPath)) {
    const available = probeAudioStreamCount(inputPath, resolveFfprobeBinary(ffmpegBin));
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
 * Builds optimized, compliant FFmpeg argument array with hardware acceleration,
 * strict filter graph ordering, rate control, and profile/level validation.
 */
export function buildFfmpegArguments(
  inputPath: string,
  outputPath: string,
  src: string,
  tgt: string,
  options: ConversionOptions = {},
  ffmpegBin?: string | null,
  overrideTimestamp?: string
): string[] {
  const globalArgs: string[] = ['-y'];
  const inputArgs: string[] = [];
  const outputArgs: string[] = [];

  // Thumbnail branch: produce a single frame image
  const isThumbnail = Boolean(options.thumbnail) || (['jpg', 'jpeg', 'png'].includes(tgt) && Boolean(options.thumbnail));
  if (isThumbnail) {
    const timestamp = overrideTimestamp || options.thumbnail?.at?.[0] || '00:00:01.000';
    if (options.thumbnail?.accurate) {
      inputArgs.push('-i', inputPath);
      outputArgs.push('-ss', timestamp);
    } else {
      inputArgs.push('-ss', timestamp, '-i', inputPath);
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

  // Subtitle extraction branch: demux subtitle stream directly
  if (options.subtitles?.mode === 'extract') {
    if (options.trim?.start) {
      inputArgs.push('-ss', options.trim.start);
    }
    if (options.trim?.end) {
      inputArgs.push('-to', options.trim.end);
    }
    inputArgs.push('-i', inputPath);

    outputArgs.push('-vn', '-an');
    const sIdx = typeof options.subtitles.streamIndex === 'number' ? options.subtitles.streamIndex : 0;
    if (sIdx < 0) {
      throw new InvalidMediaOptionError('Subtitle stream index must be non-negative.');
    }
    outputArgs.push('-map', `0:s:${sIdx}`);

    const subFmt = options.subtitles.format || (tgt === 'vtt' ? 'vtt' : tgt === 'ass' ? 'ass' : 'srt');
    const subCodec = subFmt === 'vtt' ? 'webvtt' : subFmt === 'ass' ? 'ass' : 'srt';
    outputArgs.push('-c:s', subCodec);

    return [...globalArgs, ...inputArgs, ...outputArgs, outputPath];
  }

  // Standard video/audio transcoding branch
  if (options.trim?.start) {
    inputArgs.push('-ss', options.trim.start);
  }
  if (options.trim?.end) {
    inputArgs.push('-to', options.trim.end);
  }
  inputArgs.push('-i', inputPath);

  if (options.subtitles?.mode === 'soft') {
    if (!options.subtitles.input) {
      throw new InvalidMediaOptionError("Subtitle 'soft' mode requires an input subtitle file path.");
    }
    inputArgs.push('-i', options.subtitles.input);
  }

  const isVideo = ['mp4', 'mkv', 'avi', 'mov', 'webm'].includes(tgt);
  const audioSpec = isAudioOnlyTarget(tgt) ? resolveAudioTargetSpec(tgt) : undefined;

  if (options.subtitles?.mode === 'burn' && !isVideo) {
    throw new InvalidMediaOptionError("Subtitle 'burn' mode is only supported for video targets.");
  }
  if (options.subtitles?.mode === 'soft' && !['mp4', 'mov', 'mkv', 'webm'].includes(tgt)) {
    throw new InvalidMediaOptionError(`Container '${tgt}' does not support soft subtitle embedding.`);
  }

  // Audio codec validation and container compatibility gates
  if (options.audio?.codec) {
    const ac = options.audio.codec;
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
  // The spec's limits describe its own encoder; a caller-selected different codec has other limits.
  const specEncoderInUse =
    audioSpec !== undefined && (!options.audio?.codec || AUDIO_CODEC_MAP[options.audio.codec] === audioSpec.encoder);
  if (audioSpec && specEncoderInUse) {
    assertEncoderLimits(tgt, audioSpec, options, inputPath, ffmpegBin);
  }

  // Stream mapping
  if (audioSpec) {
    outputArgs.push(...audioOnlyStreamArgs(tgt, inputPath, options, ffmpegBin));
  } else if (options.subtitles?.mode === 'soft') {
    outputArgs.push('-map', '0:v');
    if (options.audio?.track === 'all') {
      outputArgs.push('-map', '0:a');
    } else if (typeof options.audio?.track === 'number') {
      if (options.audio.track < 0) {
        throw new InvalidMediaOptionError('Audio track index must be non-negative.');
      }
      outputArgs.push('-map', `0:a:${options.audio.track}`);
    } else {
      outputArgs.push('-map', '0:a?');
    }
    outputArgs.push('-map', '1:0');
  } else if (options.audio?.track !== undefined) {
    if (isVideo) {
      outputArgs.push('-map', '0:v:0');
    }
    if (options.audio.track === 'all') {
      outputArgs.push('-map', '0:a');
    } else if (typeof options.audio.track === 'number') {
      if (options.audio.track < 0) {
        throw new InvalidMediaOptionError('Audio track index must be non-negative.');
      }
      outputArgs.push('-map', `0:a:${options.audio.track}`);
    }
  }

  if (options.subtitles?.mode === 'soft') {
    if (tgt === 'mp4' || tgt === 'mov') {
      outputArgs.push('-c:s', 'mov_text');
    } else if (tgt === 'webm') {
      outputArgs.push('-c:s', 'webvtt');
    } else if (tgt === 'mkv') {
      outputArgs.push('-c:s', options.subtitles.format === 'ass' ? 'ass' : 'srt');
    } else {
      outputArgs.push('-c:s', 'copy');
    }
  }

  if (isVideo) {
    const hw = probeHardwareAcceleration(ffmpegBin);
    const disableHw = Boolean(options.disableHwaccel);
    const driDev = fs.existsSync('/dev/dri/renderD128')
      ? '/dev/dri/renderD128'
      : fs.existsSync('/dev/dri/card0')
      ? '/dev/dri/card0'
      : null;

    const videoOpts = options.video;
    const codec = resolveVideoCodec(videoOpts?.codec || options.videoCodec || (tgt === 'webm' ? 'vp9' : 'h264'));

    // 1. Container Compatibility Gate
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

    // 2. Profile and Level Validation Gate
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

    // 3. Rate Control Validation Gate
    const rateControl = videoOpts?.rateControl;
    if (rateControl?.mode === 'crf') {
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

    // 4. Bit Depth and HDR Gate (before encoder selection, independent of available hardware)
    // Hardware encoders receive no -profile:v and may only accept 8-bit surfaces (VAAPI uploads
    // nv12, h264_qsv takes nv12), so a 10-bit profile always takes the software encoder path.
    const tenBit = TEN_BIT_PROFILES.has((videoOpts?.profile || '').toLowerCase());
    if (!tenBit && codec !== 'prores' && fs.existsSync(inputPath)) {
      // Squeezing PQ/HLG samples into 8-bit without tone mapping corrupts the picture.
      const transfer = probeVideoColorTransfer(inputPath, resolveFfprobeBinary(ffmpegBin));
      if (HDR_TRANSFERS.has(transfer)) {
        throw new InvalidMediaOptionError(
          `HDR input (transfer "${transfer}") needs a 10-bit profile such as hevc main10; 8-bit output without tone mapping is not supported.`
        );
      }
    }

    // 5. Determine Hardware Acceleration Usage
    let isVaapi = false;
    let isNvenc = false;
    let isVideotoolbox = false;
    let isQsv = false;

    if (!disableHw && !tenBit && (tgt === 'mp4' || tgt === 'mov' || tgt === 'mkv')) {
      if (codec === 'h264') {
        if (hw.nvenc && hw.supportedEncoders.has('h264_nvenc')) isNvenc = true;
        else if (hw.vaapi && driDev && hw.supportedEncoders.has('h264_vaapi')) isVaapi = true;
        else if (hw.videotoolbox && hw.supportedEncoders.has('h264_videotoolbox')) isVideotoolbox = true;
        else if (hw.qsv && hw.supportedEncoders.has('h264_qsv')) isQsv = true;
      } else if (codec === 'hevc') {
        if (hw.nvenc && hw.supportedEncoders.has('hevc_nvenc')) isNvenc = true;
        else if (hw.vaapi && driDev && hw.supportedEncoders.has('hevc_vaapi')) isVaapi = true;
        else if (hw.videotoolbox && hw.supportedEncoders.has('hevc_videotoolbox')) isVideotoolbox = true;
      }
    }

    // 2-pass on hardware acceleration rejection
    if (rateControl?.mode === 'vbr' && rateControl.twoPass && (isVaapi || isNvenc || isVideotoolbox || isQsv)) {
      throw new InvalidMediaOptionError('Hardware accelerated video encoders do not support 2-pass encoding.');
    }

    // 6. Strict Filter Graph Construction
    // Sequence: yadif -> crop -> transpose -> scale -> fps -> subtitles (burn) -> even parity correction -> format
    const videoFilters: string[] = [];

    // Stage 1: yadif (deinterlace)
    if (videoOpts?.deinterlace) {
      videoFilters.push('yadif');
    }

    // Stage 2: crop
    if (videoOpts?.crop) {
      const { w, h, x, y } = videoOpts.crop;
      videoFilters.push(`crop=${w}:${h}:${x}:${y}`);
    }

    // Stage 3: transpose (rotation)
    if (typeof videoOpts?.rotate === 'number') {
      const rot = videoOpts.rotate;
      if (rot === 90) {
        videoFilters.push('transpose=1');
      } else if (rot === 180) {
        videoFilters.push('transpose=2,transpose=2');
      } else if (rot === 270) {
        videoFilters.push('transpose=2');
      } else if (rot !== 0) {
        throw new InvalidMediaOptionError(`Invalid rotate angle ${rot}. Allowed values: 0, 90, 180, 270.`);
      }
    }

    // Stage 4: scale
    if (videoOpts?.scale) {
      const { width, height, fit } = videoOpts.scale;
      const w = width && width > 0 ? width : -1;
      const h = height && height > 0 ? height : -1;
      if (fit === 'cover' && width && height) {
        videoFilters.push(`scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${width}:${height}`);
      } else if (fit === 'stretch') {
        videoFilters.push(`scale=${w}:${h}`);
      } else {
        videoFilters.push(`scale=${w}:${h}:force_original_aspect_ratio=decrease`);
      }
    } else if (options.videoResolution && options.videoResolution !== 'original') {
      const resMap: Record<string, string> = {
        '4k': '3840:2160',
        '1080p': '1920:1080',
        '720p': '1280:720',
        '480p': '854:480',
        '360p': '640:360',
      };
      if (resMap[options.videoResolution]) {
        videoFilters.push(`scale=${resMap[options.videoResolution]}:force_original_aspect_ratio=decrease`);
      }
    }

    // Stage 5: fps
    if (typeof videoOpts?.fps === 'number' && Number.isFinite(videoOpts.fps) && videoOpts.fps > 0 && videoOpts.fps <= 240) {
      videoFilters.push(`fps=${videoOpts.fps}`);
    }

    // Stage 6: subtitles burn (prior to even dimension normalization)
    if (options.subtitles?.mode === 'burn') {
      if (!options.subtitles.input) {
        throw new InvalidMediaOptionError("Subtitle 'burn' mode requires an input subtitle file path.");
      }
      videoFilters.push(`subtitles='${escapeFfmpegFilterPath(options.subtitles.input)}'`);
    }

    // Stage 7: Even dimension normalization (ALWAYS LAST filter before format)
    videoFilters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');

    // Stage 8: Format upload (for VAAPI)
    if (isVaapi) {
      videoFilters.push('format=nv12,hwupload');
    }

    if (videoFilters.length > 0) {
      outputArgs.push('-vf', videoFilters.join(','));
    }

    // Software pixel format (exclude VAAPI which uses hwupload, and ProRes which has custom 10-bit format)
    if (!isVaapi && codec !== 'prores') {
      outputArgs.push('-pix_fmt', tenBit ? TEN_BIT_PIX_FMT : EIGHT_BIT_PIX_FMT);
    }

    // 7. Video Encoder Selection and Arguments
    if (tgt === 'mp4' || tgt === 'mov' || tgt === 'mkv') {
      if (codec === 'h264' || codec === 'hevc') {
        const isH264 = codec === 'h264';
        const defaultCrf = isH264 ? '23' : '26';
        const defaultVaapiQp = isH264 ? '24' : '26';
        const swLib = isH264 ? 'libx264' : 'libx265';
        const crfVal = rateControl?.mode === 'crf' ? String(rateControl.crf) : defaultCrf;

        if (isNvenc) {
          outputArgs.push('-c:v', `${codec}_nvenc`, '-preset', videoOpts?.preset || 'p4');
          if (rateControl?.mode === 'crf' || !rateControl) {
            outputArgs.push('-cq', crfVal);
          }
        } else if (isVaapi && driDev) {
          globalArgs.push('-vaapi_device', driDev);
          outputArgs.push('-filter_hw_device', driDev, '-c:v', `${codec}_vaapi`);
          if (rateControl?.mode === 'crf') {
            outputArgs.push('-qp', String(rateControl.crf));
          } else if (!rateControl) {
            outputArgs.push('-qp', defaultVaapiQp);
          }
        } else if (isVideotoolbox) {
          outputArgs.push('-c:v', `${codec}_videotoolbox`);
          if (rateControl?.mode === 'crf') {
            outputArgs.push('-q:v', String(Math.max(1, Math.min(100, Math.round(100 - rateControl.crf * 1.5)))));
          } else if (!rateControl) {
            outputArgs.push('-q:v', '65');
          }
        } else if (isH264 && isQsv) {
          outputArgs.push('-c:v', 'h264_qsv');
          if (rateControl?.mode === 'crf' || !rateControl) {
            outputArgs.push('-global_quality', crfVal);
          }
        } else {
          outputArgs.push('-c:v', swLib, '-preset', videoOpts?.preset || 'fast');
          if (rateControl?.mode === 'crf' || !rateControl) {
            outputArgs.push('-crf', crfVal);
          }
          if (videoOpts?.profile) {
            outputArgs.push('-profile:v', videoOpts.profile.toLowerCase());
          }
          if (isH264 && videoOpts?.level) {
            outputArgs.push('-level', videoOpts.level);
          }
        }
      } else if (codec === 'vp9') {
        outputArgs.push('-c:v', 'libvpx-vp9');
        if (rateControl?.mode === 'crf') {
          outputArgs.push('-crf', String(rateControl.crf), '-b:v', '0');
        } else if (!rateControl) {
          outputArgs.push('-crf', '30', '-b:v', '0');
        }
      } else if (codec === 'av1') {
        outputArgs.push('-c:v', 'libaom-av1');
        if (rateControl?.mode === 'crf') {
          outputArgs.push('-crf', String(rateControl.crf), '-b:v', '0');
        } else if (!rateControl) {
          outputArgs.push('-crf', '32', '-b:v', '0');
        }
        if (videoOpts?.profile) {
          outputArgs.push('-profile:v', '0');
        }
      } else if (codec === 'prores') {
        outputArgs.push('-c:v', 'prores_ks');
        const proresProfileMap: Record<string, string> = {
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
        const p = videoOpts?.profile?.toLowerCase();
        const prof = p && proresProfileMap[p] ? proresProfileMap[p] : '3';
        outputArgs.push(
          '-profile:v', prof,
          '-pix_fmt', prof === '4' ? 'yuva444p10le' : 'yuv422p10le'
        );
      }

      // Bitrate rate control (VBR / CBR / legacy)
      if (rateControl?.mode === 'vbr') {
        outputArgs.push('-b:v', `${rateControl.bitrateK}k`);
        if (rateControl.maxrateK) outputArgs.push('-maxrate', `${rateControl.maxrateK}k`);
        if (rateControl.bufsizeK) outputArgs.push('-bufsize', `${rateControl.bufsizeK}k`);
      } else if (rateControl?.mode === 'cbr') {
        outputArgs.push(
          '-b:v', `${rateControl.bitrateK}k`,
          '-minrate', `${rateControl.bitrateK}k`,
          '-maxrate', `${rateControl.bitrateK}k`,
          '-bufsize', `${rateControl.bitrateK}k`
        );
      } else if (typeof options.videoBitrate === 'number' && Number.isFinite(options.videoBitrate) && options.videoBitrate > 0) {
        outputArgs.push('-b:v', `${Math.floor(options.videoBitrate)}k`);
      }

      if (typeof options.videoFps === 'number' && Number.isFinite(options.videoFps) && options.videoFps > 0 && options.videoFps <= 240) {
        outputArgs.push('-r', options.videoFps.toString());
      }

      if (tgt === 'mp4' || tgt === 'mov') {
        outputArgs.push('-movflags', '+faststart');
      }
    } else if (tgt === 'webm') {
      if (codec === 'av1') {
        outputArgs.push('-c:v', 'libaom-av1');
        if (rateControl?.mode === 'crf') {
          outputArgs.push('-crf', String(rateControl.crf), '-b:v', '0');
        } else {
          outputArgs.push('-crf', '32', '-b:v', '0');
        }
      } else {
        outputArgs.push('-c:v', 'libvpx-vp9');
        if (rateControl?.mode === 'crf') {
          outputArgs.push('-crf', String(rateControl.crf), '-b:v', '0');
        } else {
          outputArgs.push('-crf', '30', '-b:v', '0');
        }
      }
      if (rateControl?.mode === 'vbr') {
        outputArgs.push('-b:v', `${rateControl.bitrateK}k`);
      } else if (rateControl?.mode === 'cbr') {
        outputArgs.push('-b:v', `${rateControl.bitrateK}k`, '-minrate', `${rateControl.bitrateK}k`, '-maxrate', `${rateControl.bitrateK}k`);
      } else if (typeof options.videoBitrate === 'number' && Number.isFinite(options.videoBitrate) && options.videoBitrate > 0) {
        outputArgs.push('-b:v', `${Math.floor(options.videoBitrate)}k`);
      }
    } else if (tgt === 'avi') {
      outputArgs.push('-c:v', 'mpeg4', '-vtag', 'XVID');
    }
  }

  // Unified Audio Encoding & Filter Configuration
  let resolvedAudioCodec: string;
  if (options.audio?.codec) {
    resolvedAudioCodec = AUDIO_CODEC_MAP[options.audio.codec];
  } else if (isVideo) {
    if (tgt === 'webm') {
      resolvedAudioCodec = 'libopus';
    } else if (tgt === 'avi') {
      resolvedAudioCodec = 'libmp3lame';
    } else {
      resolvedAudioCodec = 'aac';
    }
  } else if (audioSpec) {
    resolvedAudioCodec = audioSpec.encoder;
  } else {
    resolvedAudioCodec = 'aac';
  }

  if (audioSpec && ffmpegBin) {
    assertEncoderAvailable(tgt, resolvedAudioCodec, probeHardwareAcceleration(ffmpegBin).supportedEncoders);
  }

  outputArgs.push('-c:a', resolvedAudioCodec);
  if (audioSpec) {
    outputArgs.push('-f', audioSpec.muxer);
  }

  // Audio bitrate
  if (typeof options.audio?.bitrateK === 'number') {
    if (!Number.isFinite(options.audio.bitrateK) || options.audio.bitrateK <= 0) {
      throw new InvalidMediaOptionError(`Invalid audio bitrate: ${options.audio.bitrateK}k`);
    }
    outputArgs.push('-b:a', `${Math.floor(options.audio.bitrateK)}k`);
  } else if (options.audioBitrate && /^\d+[kK]?$/.test(options.audioBitrate)) {
    outputArgs.push('-b:a', options.audioBitrate.toLowerCase().endsWith('k') ? options.audioBitrate : `${options.audioBitrate}k`);
  } else if (audioSpec && specEncoderInUse) {
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

  // Audio filters and ITU-R BS.775 downmix
  const audioFilters: string[] = [];
  if (audioSpec?.fixedChannels !== undefined) {
    outputArgs.push('-ac', String(audioSpec.fixedChannels));
  } else if (options.audio?.downmix === 'itu-r-bs775') {
    const is71 =
      options.audio.channels === 8 ||
      options.audioChannels === '7.1' ||
      (fs.existsSync(inputPath) && probeAudioChannels(inputPath, resolveFfprobeBinary(ffmpegBin)) === 8);
    if (is71) {
      audioFilters.push('pan=stereo|FL=0.3204*FL+0.2265*FC+0.2265*BL+0.2265*SL|FR=0.3204*FR+0.2265*FC+0.2265*BR+0.2265*SR');
    } else {
      audioFilters.push('pan=stereo|FL=0.4142*FL+0.2929*FC+0.2929*BL|FR=0.4142*FR+0.2929*FC+0.2929*BR');
    }
    outputArgs.push('-ac', '2');
  } else if (options.audio?.channels) {
    if (![1, 2, 6, 8].includes(options.audio.channels)) {
      throw new InvalidMediaOptionError(`Invalid audio channels: ${options.audio.channels}. Allowed: 1, 2, 6, 8.`);
    }
    outputArgs.push('-ac', String(options.audio.channels));
  } else if (options.audioChannels && ['mono', 'stereo', '5.1', '7.1'].includes(options.audioChannels)) {
    const chMap: Record<string, string> = { mono: '1', stereo: '2', '5.1': '6', '7.1': '8' };
    outputArgs.push('-ac', chMap[options.audioChannels]);
  }

  // Audio sample rate
  if (audioSpec?.fixedSampleRate !== undefined) {
    outputArgs.push('-ar', String(audioSpec.fixedSampleRate));
  } else if (typeof options.audio?.sampleRate === 'number') {
    if (!Number.isFinite(options.audio.sampleRate) || options.audio.sampleRate < 8000 || options.audio.sampleRate > 192000) {
      throw new InvalidMediaOptionError(`Invalid audio sample rate: ${options.audio.sampleRate}. Allowed range: 8000 to 192000 Hz.`);
    }
    outputArgs.push('-ar', String(options.audio.sampleRate));
  } else if (typeof options.audioSampleRate === 'number' && Number.isFinite(options.audioSampleRate) && options.audioSampleRate >= 8000 && options.audioSampleRate <= 192000) {
    outputArgs.push('-ar', String(options.audioSampleRate));
  } else if (audioSpec?.defaultSampleRate !== undefined && specEncoderInUse) {
    outputArgs.push('-ar', String(audioSpec.defaultSampleRate));
  } else if (audioSpec && specEncoderInUse && (audioSpec.allowedSampleRates || audioSpec.maxSampleRate) && fs.existsSync(inputPath)) {
    // The caller set no rate: bring an input the encoder cannot code into its supported set.
    const track = typeof options.audio?.track === 'number' ? options.audio.track : 0;
    const resampleRate = resampleRateFor(audioSpec, probeAudioSampleRate(inputPath, resolveFfprobeBinary(ffmpegBin), track));
    if (resampleRate !== undefined) {
      outputArgs.push('-ar', String(resampleRate));
    }
  }

  // Audio volume
  if (typeof options.audio?.volume === 'number') {
    if (!Number.isFinite(options.audio.volume) || options.audio.volume < 0 || options.audio.volume > 200) {
      throw new InvalidMediaOptionError(`Invalid audio volume: ${options.audio.volume}. Allowed range: 0 to 200%.`);
    }
    if (options.audio.volume !== 100) {
      audioFilters.push(`volume=${options.audio.volume / 100}`);
    }
  } else if (typeof options.audioVolume === 'number' && Number.isFinite(options.audioVolume) && options.audioVolume >= 0 && options.audioVolume <= 200 && options.audioVolume !== 100) {
    audioFilters.push(`volume=${options.audioVolume / 100}`);
  }

  if (audioFilters.length > 0) {
    outputArgs.push('-filter:a', audioFilters.join(','));
  }

  if (audioSpec?.muxer === 'ipod') {
    outputArgs.push('-movflags', '+faststart');
  }

  return [...globalArgs, ...inputArgs, ...outputArgs, outputPath];
}

export const DEFAULT_PACKAGING_LADDER: readonly MediaLadderRung[] = [
  { height: 1080, bitrateK: 4500, audioBitrateK: 192 },
  { height: 720, bitrateK: 2500, audioBitrateK: 128 },
  { height: 480, bitrateK: 1000, audioBitrateK: 96 },
] as const;

export const PACKAGING_VIDEO_ENCODERS: Record<string, string> = {
  h264: 'libx264',
  hevc: 'libx265',
  vp9: 'libvpx-vp9',
  av1: 'libsvtav1',
};

export const PACKAGING_AUDIO_ENCODERS: Record<string, string> = {
  aac: 'aac',
  opus: 'libopus',
};

const DEFAULT_SEGMENT_SECONDS = 4;
const MIN_SEGMENT_SECONDS = 2;
const MAX_SEGMENT_SECONDS = 10;
const MIN_RUNG_HEIGHT = 144;
const MAX_RUNG_HEIGHT = 4320;
const MAX_RUNG_BITRATE_K = 50_000;
const MAX_RUNG_FPS = 240;
const MIN_RUNG_AUDIO_BITRATE_K = 16;
const MAX_RUNG_AUDIO_BITRATE_K = 1024;
/** Audio bitrate of the first, second and later rungs when the ladder gives none. */
const DEFAULT_RUNG_AUDIO_BITRATE_K = [192, 128, 96] as const;
const TS_SEGMENT_PATTERN = 'stream_%v_%03d.ts';
const FMP4_SEGMENT_PATTERN = 'stream_%v_%03d.m4s';
const FMP4_INIT_PATTERN = 'init_%v.mp4';
const PACKAGING_PIX_FMT = 'yuv420p';
const HEVC_PACKAGING_TAG = 'hvc1';

/** What packaging needs to know about the input before it plans a ladder. */
export interface PackagingSource {
  geometry: VideoGeometry;
  hasAudio: boolean;
}

/** Probes the first video stream (exact frame rate, displayed size, duration) and whether the input has audio. */
export function probePackagingSource(inputPath: string, ffmpegBin?: string | null): PackagingSource {
  const ffprobe = resolveFfprobeBinary(ffmpegBin);
  return {
    geometry: probeVideoGeometry(inputPath, ffprobe),
    hasAudio: probeAudioChannels(inputPath, ffprobe) > 0,
  };
}

function validateLadder(ladder: readonly MediaLadderRung[]): void {
  if (!Array.isArray(ladder) || ladder.length === 0) {
    throw new InvalidMediaOptionError('Packaging ladder must be a non-empty array of rungs.');
  }
  const seenHeights = new Set<number>();
  for (const rung of ladder) {
    if (typeof rung.height !== 'number' || !Number.isInteger(rung.height) || rung.height < MIN_RUNG_HEIGHT || rung.height > MAX_RUNG_HEIGHT) {
      throw new InvalidMediaOptionError(
        `Invalid ladder rung height: ${rung.height}. Must be an integer between ${MIN_RUNG_HEIGHT} and ${MAX_RUNG_HEIGHT}.`
      );
    }
    if (rung.height % 2 !== 0) {
      throw new InvalidMediaOptionError(`Invalid ladder rung height: ${rung.height}. 4:2:0 video needs an even height.`);
    }
    if (seenHeights.has(rung.height)) {
      throw new InvalidMediaOptionError(`Duplicate ladder rung height ${rung.height}; each rung names its playlist by height.`);
    }
    seenHeights.add(rung.height);
    if (typeof rung.bitrateK !== 'number' || !Number.isInteger(rung.bitrateK) || rung.bitrateK < MIN_RUNG_BITRATE_K || rung.bitrateK > MAX_RUNG_BITRATE_K) {
      throw new InvalidMediaOptionError(
        `Invalid ladder rung bitrateK: ${rung.bitrateK}. Must be an integer between ${MIN_RUNG_BITRATE_K} and ${MAX_RUNG_BITRATE_K}.`
      );
    }
    if (rung.fps !== undefined && (typeof rung.fps !== 'number' || !Number.isFinite(rung.fps) || rung.fps <= 0 || rung.fps > MAX_RUNG_FPS)) {
      throw new InvalidMediaOptionError(`Invalid ladder rung fps: ${rung.fps}. Must be a number between 1 and ${MAX_RUNG_FPS}.`);
    }
    if (
      rung.audioBitrateK !== undefined &&
      (typeof rung.audioBitrateK !== 'number' ||
        !Number.isInteger(rung.audioBitrateK) ||
        rung.audioBitrateK < MIN_RUNG_AUDIO_BITRATE_K ||
        rung.audioBitrateK > MAX_RUNG_AUDIO_BITRATE_K)
    ) {
      throw new InvalidMediaOptionError(
        `Invalid ladder rung audioBitrateK: ${rung.audioBitrateK}. Must be an integer between ${MIN_RUNG_AUDIO_BITRATE_K} and ${MAX_RUNG_AUDIO_BITRATE_K}.`
      );
    }
  }
}

/**
 * Encoder arguments that put an IDR frame at every segment boundary on every rung: the GOP spans one
 * segment, a keyframe is forced at each boundary time, and scene-cut keyframes are off so no keyframe
 * lands elsewhere and the rungs cut at the same instants (RFC 8216, section 6.2.3).
 */
function segmentKeyframeArgs(codec: string, rungIndex: number, gopFrames: number, segmentSeconds: number): string[] {
  const at = (option: string) => `${option}:v:${rungIndex}`;
  const common = [at('-g'), String(gopFrames), at('-force_key_frames'), forcedKeyframeExpression(segmentSeconds)];
  switch (codec) {
    case 'libx264':
      return [...common, at('-keyint_min'), String(gopFrames), at('-sc_threshold'), '0', at('-forced-idr'), '1'];
    case 'libx265':
      return [
        ...common,
        at('-keyint_min'), String(gopFrames),
        at('-forced-idr'), '1',
        at('-x265-params'), 'scenecut=0:open-gop=0',
      ];
    case 'libsvtav1':
      return [...common, at('-svtav1-params'), 'scd=0'];
    default:
      return [...common, at('-keyint_min'), String(gopFrames)];
  }
}

/**
 * Builds FFmpeg command-line arguments for multi-bitrate ABR packaging (HLS and MPEG-DASH).
 *
 * `source` is what was probed from the input (exact frame rate, displayed size, audio presence); when it is
 * left out the input file is probed here. The ladder is cut to what the source can fill and every rung
 * gets a capped peak rate, so the declared BANDWIDTH holds.
 */
export function buildHlsDashArguments(
  inputPath: string,
  outputDir: string,
  packaging: MediaPackagingOptions,
  ffmpegBin?: string | null,
  source?: PackagingSource
): string[] {
  if (!packaging || !packaging.format) {
    throw new InvalidMediaOptionError('Packaging format is required ("hls" or "dash").');
  }

  const format = packaging.format.toLowerCase();
  if (format !== 'hls' && format !== 'dash') {
    throw new InvalidMediaOptionError(
      `Unsupported packaging format "${packaging.format}". Allowed: "hls", "dash".`
    );
  }

  let segmentSeconds = DEFAULT_SEGMENT_SECONDS;
  if (packaging.segmentSeconds !== undefined) {
    if (
      typeof packaging.segmentSeconds !== 'number' ||
      !Number.isInteger(packaging.segmentSeconds) ||
      packaging.segmentSeconds < MIN_SEGMENT_SECONDS ||
      packaging.segmentSeconds > MAX_SEGMENT_SECONDS
    ) {
      throw new InvalidMediaOptionError(
        `Invalid segmentSeconds: ${packaging.segmentSeconds}. Allowed range: ${MIN_SEGMENT_SECONDS} to ${MAX_SEGMENT_SECONDS} seconds integer.`
      );
    }
    segmentSeconds = packaging.segmentSeconds;
  }
  const segmentType = resolveSegmentType(packaging.segmentType, format);

  const requestedLadder: readonly MediaLadderRung[] = packaging.ladder ?? DEFAULT_PACKAGING_LADDER;
  validateLadder(requestedLadder);

  // Video codec
  const videoCodecKey = resolveVideoCodec((packaging.videoCodec || 'h264').toLowerCase());
  const vEncoder = PACKAGING_VIDEO_ENCODERS[videoCodecKey];
  if (!vEncoder) {
    throw new InvalidMediaOptionError(
      `Unsupported video codec "${packaging.videoCodec}". Allowed: h264, hevc (h265), vp9, av1.`
    );
  }

  // Audio codec
  const audioCodecKey = (packaging.audioCodec || 'aac').toLowerCase();
  const aEncoder = PACKAGING_AUDIO_ENCODERS[audioCodecKey];
  if (!aEncoder) {
    throw new InvalidMediaOptionError(
      `Unsupported audio codec "${packaging.audioCodec}". Allowed: aac, opus.`
    );
  }

  const probed = source ?? probePackagingSource(inputPath, ffmpegBin);
  const ladder = capLadderToSource(requestedLadder, probed.geometry);
  const hasAudio = probed.hasAudio;
  const { fpsNum, fpsDen } = probed.geometry;

  const globalArgs: string[] = ['-y', '-loglevel', 'error'];
  const inputArgs: string[] = ['-i', inputPath];

  // Construct filter_complex
  const filterParts: string[] = [];

  // Video split & scale
  const vSplitOuts = ladder.map((_, i) => `[v_in${i}]`).join('');
  filterParts.push(`[0:v]split=${ladder.length}${vSplitOuts}`);
  for (let i = 0; i < ladder.length; i++) {
    const rung = ladder[i];
    const fpsFilter = rung.fps ? `,fps=${rung.fps}` : '';
    filterParts.push(`[v_in${i}]scale=w=-2:h=${rung.height}${fpsFilter}[v_out${i}]`);
  }

  // Audio split
  if (hasAudio) {
    const aSplitOuts = ladder.map((_, i) => `[a_out${i}]`).join('');
    filterParts.push(`[0:a]asplit=${ladder.length}${aSplitOuts}`);
  }

  const complexFilter = filterParts.join('; ');
  const streamArgs: string[] = ['-filter_complex', complexFilter];

  // Map each rung
  for (let i = 0; i < ladder.length; i++) {
    const rung = ladder[i];
    const caps = rungRateCaps(rung.bitrateK);
    streamArgs.push(
      '-map', `[v_out${i}]`,
      `-c:v:${i}`, vEncoder,
      `-b:v:${i}`, `${rung.bitrateK}k`,
      `-maxrate:v:${i}`, `${caps.maxrateK}k`,
      `-bufsize:v:${i}`, `${caps.bufsizeK}k`,
      `-pix_fmt:v:${i}`, PACKAGING_PIX_FMT
    );
    if (videoCodecKey === 'hevc') {
      streamArgs.push(`-tag:v:${i}`, HEVC_PACKAGING_TAG);
    }

    // The rung's own rate when it names one, otherwise the source's exact rational rate.
    const gopFrames = rung.fps
      ? keyframeIntervalFrames(rung.fps, 1, segmentSeconds)
      : keyframeIntervalFrames(fpsNum, fpsDen, segmentSeconds);
    streamArgs.push(...segmentKeyframeArgs(vEncoder, i, gopFrames, segmentSeconds));

    if (hasAudio) {
      const audioBitrate = rung.audioBitrateK || DEFAULT_RUNG_AUDIO_BITRATE_K[Math.min(i, DEFAULT_RUNG_AUDIO_BITRATE_K.length - 1)];
      streamArgs.push(
        '-map', `[a_out${i}]`,
        `-c:a:${i}`, aEncoder,
        `-b:a:${i}`, `${audioBitrate}k`
      );
    }
  }

  if (format === 'hls') {
    const masterPlaylist = packaging.masterPlaylistName || 'master.m3u8';
    const varStreamMap = ladder
      .map((rung, i) => {
        const streamName = `${rung.height}p`;
        return hasAudio ? `v:${i},a:${i},name:${streamName}` : `v:${i},name:${streamName}`;
      })
      .join(' ');

    // ffmpeg expands %v in the init name only when there are several variants; with one it keeps the
    // literal "%v", so a single rung names its init section directly.
    const initName = ladder.length === 1 ? `init_${ladder[0].height}p.mp4` : FMP4_INIT_PATTERN;
    const segmentArgs =
      segmentType === 'fmp4'
        ? [
            '-hls_segment_type', 'fmp4',
            '-hls_fmp4_init_filename', initName,
            '-hls_segment_filename', path.join(outputDir, FMP4_SEGMENT_PATTERN),
          ]
        : ['-hls_segment_filename', path.join(outputDir, TS_SEGMENT_PATTERN)];

    const hlsArgs: string[] = [
      '-f', 'hls',
      '-hls_time', String(segmentSeconds),
      '-hls_playlist_type', 'vod',
      '-hls_flags', 'independent_segments',
      '-master_pl_name', masterPlaylist,
      ...segmentArgs,
      '-var_stream_map', varStreamMap,
      path.join(outputDir, 'stream_%v.m3u8'),
    ];

    return [...globalArgs, ...inputArgs, ...streamArgs, ...hlsArgs];
  } else {
    // DASH
    const manifestName = packaging.masterPlaylistName || 'manifest.mpd';
    const adaptationSets = hasAudio
      ? 'id=0,streams=v id=1,streams=a'
      : 'id=0,streams=v';

    const dashArgs: string[] = [
      '-f', 'dash',
      '-seg_duration', String(segmentSeconds),
      '-use_template', '1',
      '-use_timeline', '1',
      '-init_seg_name', 'init_$RepresentationID$.m4s',
      '-media_seg_name', 'chunk_$RepresentationID$_$Number%05d$.m4s',
      '-adaptation_sets', adaptationSets,
      path.join(outputDir, manifestName),
    ];

    return [...globalArgs, ...inputArgs, ...streamArgs, ...dashArgs];
  }
}
