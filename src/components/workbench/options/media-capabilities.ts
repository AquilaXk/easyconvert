import { AudioCodec, ConversionOptions } from '@/lib/types';

type VideoCodecOption = NonNullable<ConversionOptions['videoCodec']>;
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
