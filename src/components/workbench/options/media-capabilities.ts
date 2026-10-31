import { AudioCodec, ConversionOptions } from '@/lib/types';

type VideoCodecOption = NonNullable<ConversionOptions['videoCodec']>;
type VideoEncoding = NonNullable<ConversionOptions['video']>;
type NestedVideoCodec = NonNullable<VideoEncoding['codec']>;
type VideoRateControlOption = NonNullable<VideoEncoding['rateControl']>;
type AudioSampleRateOption = NonNullable<ConversionOptions['audioSampleRate']>;
type AudioChannelOption = NonNullable<ConversionOptions['audioChannels']>;

export const FFMPEG_VIDEO_CONTAINERS: ReadonlySet<string> = new Set([
  'mp4',
  'mov',
  'mkv',
  'webm',
  'avi',
]);

const FULL_VIDEO_CODECS: ReadonlyArray<VideoCodecOption> = ['h264', 'hevc', 'vp9', 'av1'];
const WEBM_VIDEO_CODECS: ReadonlyArray<VideoCodecOption> = ['vp9', 'av1'];

export const VIDEO_CODECS_BY_TARGET: Readonly<Record<string, ReadonlyArray<VideoCodecOption>>> = {
  webm: WEBM_VIDEO_CODECS,
  mp4: FULL_VIDEO_CODECS,
  mov: FULL_VIDEO_CODECS,
  mkv: FULL_VIDEO_CODECS,
};

export function resolveAllowedVideoCodecs(
  targetFormat: string
): ReadonlyArray<NonNullable<ConversionOptions['videoCodec']>> {
  const tgt = targetFormat.toLowerCase();
  return Object.hasOwn(VIDEO_CODECS_BY_TARGET, tgt) ? VIDEO_CODECS_BY_TARGET[tgt] : [];
}

const ALLOWED_VIDEO_PROFILES_BY_CODEC: Readonly<Record<NestedVideoCodec, ReadonlySet<string>>> = {
  h264: new Set(['baseline', 'main', 'high', 'high10']),
  hevc: new Set(['main', 'main10']),
  vp9: new Set(),
  av1: new Set(['main', '0']),
  prores: new Set(['proxy', '0', 'lt', '1', 'standard', '2', 'hq', '3', '4444', '4']),
};

const H264_ALLOWED_LEVELS: ReadonlySet<string> = new Set([
  '3.0',
  '3.1',
  '3.2',
  '4.0',
  '4.1',
  '4.2',
  '5.0',
  '5.1',
  '5.2',
  '30',
  '31',
  '32',
  '40',
  '41',
  '42',
  '50',
  '51',
  '52',
]);

const X26X_PRESETS: ReadonlySet<string> = new Set([
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow',
]);

const TWO_PASS_CODECS: ReadonlySet<NestedVideoCodec> = new Set(['h264', 'hevc', 'vp9']);
const SVT_AV1_PRESET_PATTERN = /^\d{1,2}$/;
const CODEC_SENSITIVE_VIDEO_KEYS: ReadonlySet<string> = new Set([
  'codec',
  'profile',
  'level',
  'preset',
  'rateControl',
  'scale',
]);

function pickAllowedCodec<T extends string>(
  requested: T | undefined,
  allowed: ReadonlyArray<T>
): T | undefined {
  return requested && allowed.includes(requested) ? requested : undefined;
}

function wasRejectedCodec(requested: string | undefined, accepted: string | undefined): boolean {
  return requested !== undefined && accepted === undefined;
}

function isValidVideoPreset(preset: string, codec: NestedVideoCodec): boolean {
  if (codec === 'h264' || codec === 'hevc') return X26X_PRESETS.has(preset);
  if (codec === 'av1') {
    const num = Number(preset);
    return SVT_AV1_PRESET_PATTERN.test(preset) && num >= 0 && num <= 13;
  }
  return false;
}

function isValidVideoCrf(crf: number, tgt: string, codec: NestedVideoCodec): boolean {
  if (codec === 'prores') return false;
  if (tgt === 'avi') return true;
  if (!Number.isFinite(crf) || crf < 0) return false;
  return codec === 'h264' || codec === 'hevc' ? crf <= 51 : crf <= 63;
}

function omitTwoPass(rateControl: VideoRateControlOption): VideoRateControlOption {
  const next = { ...rateControl } as VideoRateControlOption & { twoPass?: unknown };
  delete next.twoPass;
  return next;
}

function sanitizeVideoRateControl(
  rateControl: VideoEncoding['rateControl'],
  tgt: string,
  codec: NestedVideoCodec
): VideoEncoding['rateControl'] {
  if (!rateControl) return undefined;
  if (rateControl.mode === 'crf') {
    return isValidVideoCrf(rateControl.crf, tgt, codec) ? rateControl : undefined;
  }
  if (rateControl.mode === 'vbr' && rateControl.twoPass !== undefined) {
    return tgt === 'avi' || !TWO_PASS_CODECS.has(codec) ? omitTwoPass(rateControl) : rateControl;
  }
  if (rateControl.mode !== 'vbr' && 'twoPass' in rateControl) {
    return omitTwoPass(rateControl);
  }
  return rateControl;
}

function sanitizeVideoScale(scale: VideoEncoding['scale']): VideoEncoding['scale'] {
  const sw = scale?.width;
  const sh = scale?.height;
  const hasW = Boolean(sw && sw > 0);
  const hasH = Boolean(sh && sh > 0);
  if (!hasW && !hasH) return undefined;
  return {
    ...(hasW ? { width: sw } : {}),
    ...(hasH ? { height: sh } : {}),
    fit: scale?.fit ?? 'contain',
  };
}

function copyExtraVideoFields(video: VideoEncoding): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(video)) {
    if (val !== undefined && !CODEC_SENSITIVE_VIDEO_KEYS.has(key)) clean[key] = val;
  }
  return clean;
}

function applySanitizedCodecFields(
  clean: Record<string, unknown>,
  video: VideoEncoding,
  effectiveCodec: NestedVideoCodec,
  nextNestedCodec: NestedVideoCodec | undefined
): void {
  if (nextNestedCodec) clean.codec = nextNestedCodec;
  if (
    video.profile &&
    ALLOWED_VIDEO_PROFILES_BY_CODEC[effectiveCodec].has(video.profile.toLowerCase())
  ) {
    clean.profile = video.profile;
  }
  if (effectiveCodec === 'h264' && video.level && H264_ALLOWED_LEVELS.has(video.level.toLowerCase())) {
    clean.level = video.level;
  }
  if (video.preset && isValidVideoPreset(video.preset, effectiveCodec)) {
    clean.preset = video.preset;
  }
}

interface VideoCodecContext {
  tgt: string;
  nextVideoCodec: VideoCodecOption | undefined;
  nextNestedCodec: NestedVideoCodec | undefined;
  effectiveCodec: NestedVideoCodec;
  dropCodecContext: boolean;
}

function resolveVideoCodecContext(
  options: Pick<ConversionOptions, 'videoCodec' | 'video'>,
  tgt: string
): VideoCodecContext {
  const allowedVCodecs = resolveAllowedVideoCodecs(tgt);
  const allowedNested: ReadonlyArray<NestedVideoCodec> =
    tgt === 'mov' ? [...allowedVCodecs, 'prores'] : allowedVCodecs;
  const rawNested = options.video?.codec;
  const nextVideoCodec = pickAllowedCodec(options.videoCodec, allowedVCodecs);
  const nextNestedCodec = pickAllowedCodec(rawNested, allowedNested);
  const defaultCodec: NestedVideoCodec = tgt === 'webm' ? 'vp9' : 'h264';
  const effectiveCodec = nextNestedCodec ?? nextVideoCodec ?? defaultCodec;
  const dropCodecContext =
    allowedVCodecs.length === 0 ||
    wasRejectedCodec(options.videoCodec, nextVideoCodec) ||
    wasRejectedCodec(rawNested, nextNestedCodec);
  return { tgt, nextVideoCodec, nextNestedCodec, effectiveCodec, dropCodecContext };
}

export type VideoTargetOptionsSlice = Pick<ConversionOptions, 'videoCodec' | 'videoFps' | 'video'>;

export function sanitizeVideoOptionsForTarget(
  options: VideoTargetOptionsSlice,
  targetFormat: string
): VideoTargetOptionsSlice {
  const ctx = resolveVideoCodecContext(options, targetFormat.toLowerCase());
  const result: VideoTargetOptionsSlice = {};
  if (ctx.nextVideoCodec) result.videoCodec = ctx.nextVideoCodec;
  if (options.videoFps !== undefined) result.videoFps = options.videoFps;
  if (!options.video) return result;

  const clean = copyExtraVideoFields(options.video);
  if (!ctx.dropCodecContext) {
    applySanitizedCodecFields(clean, options.video, ctx.effectiveCodec, ctx.nextNestedCodec);
  }
  const cleanRate = sanitizeVideoRateControl(options.video.rateControl, ctx.tgt, ctx.effectiveCodec);
  if (cleanRate) clean.rateControl = cleanRate;
  const cleanScale = sanitizeVideoScale(options.video.scale);
  if (cleanScale) clean.scale = cleanScale;
  if (Object.keys(clean).length > 0) result.video = clean as VideoEncoding;
  return result;
}

export const AUDIO_CODECS_BY_TARGET: Readonly<Record<string, ReadonlyArray<AudioCodec>>> = {
  webm: ['opus', 'vorbis'],
  weba: ['opus', 'vorbis'],
  ogg: ['vorbis', 'opus', 'flac'],
  oga: ['vorbis', 'opus', 'flac'],
  mp4: ['aac', 'mp3', 'opus', 'flac'],
  mov: ['aac', 'mp3', 'pcm_s16le'],
  mkv: ['aac', 'mp3', 'opus', 'flac', 'vorbis', 'pcm_s16le'],
  avi: ['mp3', 'aac', 'pcm_s16le'],
};

export const LOSSLESS_AUDIO_TARGETS: ReadonlySet<string> = new Set([
  'wav',
  'flac',
  'aiff',
  'aif',
  'aifc',
  'alac',
  'au',
  'caf',
  'voc',
  'pcm',
]);

const DEFAULT_EFFECTIVE_AUDIO_CODEC: Readonly<Record<string, AudioCodec>> = {
  opus: 'opus',
  weba: 'opus',
  webm: 'opus',
  mp3: 'mp3',
  avi: 'mp3',
  flac: 'flac',
};

const ALL_SAMPLE_RATES: ReadonlyArray<AudioSampleRateOption> = [16000, 22050, 32000, 44100, 48000];
const OPUS_SAMPLE_RATES: ReadonlyArray<AudioSampleRateOption> = [16000, 48000];
const AC3_SAMPLE_RATES: ReadonlyArray<AudioSampleRateOption> = [32000, 44100, 48000];
const VOC_SAMPLE_RATES: ReadonlyArray<AudioSampleRateOption> = [16000, 22050, 32000, 44100];

const ALL_AUDIO_CHANNELS: ReadonlyArray<AudioChannelOption> = ['mono', 'stereo', '5.1', '7.1'];
const STEREO_MAX_CHANNELS: ReadonlyArray<AudioChannelOption> = ['mono', 'stereo'];
const AC3_AUDIO_CHANNELS: ReadonlyArray<AudioChannelOption> = ['mono', 'stereo', '5.1'];
const STEREO_MAX_TARGETS: ReadonlySet<string> = new Set(['mp3', 'wma', 'voc']);

export function isLosslessAudioTarget(targetFormat: string): boolean {
  return LOSSLESS_AUDIO_TARGETS.has(targetFormat.toLowerCase());
}

export function resolveEffectiveAudioCodec(
  tgt: string,
  selectedCodec?: AudioCodec
): AudioCodec | undefined {
  const allowed = Object.hasOwn(AUDIO_CODECS_BY_TARGET, tgt) ? AUDIO_CODECS_BY_TARGET[tgt] : [];
  if (selectedCodec && allowed.includes(selectedCodec)) return selectedCodec;
  if (Object.hasOwn(DEFAULT_EFFECTIVE_AUDIO_CODEC, tgt)) return DEFAULT_EFFECTIVE_AUDIO_CODEC[tgt];
  if (LOSSLESS_AUDIO_TARGETS.has(tgt)) return 'pcm_s16le';
  return undefined;
}

function resolveAllowedSampleRates(
  tgt: string,
  effectiveCodec: AudioCodec | undefined,
  isFixedNarrowband: boolean
): ReadonlyArray<AudioSampleRateOption> {
  if (isFixedNarrowband) return [];
  if (effectiveCodec === 'opus') return OPUS_SAMPLE_RATES;
  if (tgt === 'ac3') return AC3_SAMPLE_RATES;
  if (tgt === 'voc') return VOC_SAMPLE_RATES;
  return ALL_SAMPLE_RATES;
}

function resolveAllowedChannels(
  tgt: string,
  effectiveCodec: AudioCodec | undefined,
  isFixedNarrowband: boolean
): ReadonlyArray<AudioChannelOption> {
  if (isFixedNarrowband) return [];
  if (STEREO_MAX_TARGETS.has(tgt) || effectiveCodec === 'mp3') return STEREO_MAX_CHANNELS;
  if (tgt === 'ac3') return AC3_AUDIO_CHANNELS;
  return ALL_AUDIO_CHANNELS;
}

export interface AudioCapabilities {
  allowedCodecs: ReadonlyArray<AudioCodec>;
  effectiveCodec: AudioCodec | undefined;
  isFixedNarrowband: boolean;
  canConfigureBitrate: boolean;
  allowedSampleRates: ReadonlyArray<AudioSampleRateOption>;
  allowedChannels: ReadonlyArray<AudioChannelOption>;
}

export function resolveAudioCapabilities(
  targetFormat: string,
  selectedCodec?: AudioCodec
): AudioCapabilities {
  const tgt = targetFormat.toLowerCase();
  const allowedCodecs = Object.hasOwn(AUDIO_CODECS_BY_TARGET, tgt) ? AUDIO_CODECS_BY_TARGET[tgt] : [];
  const effectiveCodec = resolveEffectiveAudioCodec(tgt, selectedCodec);
  const isFixedNarrowband = tgt === 'amr' || tgt === 'dss';
  const canConfigureBitrate =
    !isFixedNarrowband &&
    !LOSSLESS_AUDIO_TARGETS.has(tgt) &&
    effectiveCodec !== 'flac' &&
    effectiveCodec !== 'pcm_s16le';

  return {
    allowedCodecs,
    effectiveCodec,
    isFixedNarrowband,
    canConfigureBitrate,
    allowedSampleRates: resolveAllowedSampleRates(tgt, effectiveCodec, isFixedNarrowband),
    allowedChannels: resolveAllowedChannels(tgt, effectiveCodec, isFixedNarrowband),
  };
}
