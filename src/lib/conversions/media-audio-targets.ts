import { AudioCodec, ConversionFailedError } from '../types';

/**
 * How one audio-only registry target is written by FFmpeg. Every audio target id advertised by
 * `FORMAT_REGISTRY` is listed either in `AUDIO_TARGET_SPECS` (encodable) or in
 * `UNENCODABLE_AUDIO_TARGETS` (no FFmpeg encoder exists), so a target can never fall through to a
 * default codec that would write a different format than the one the user asked for.
 */
export interface AudioTargetSpec {
  /** FFmpeg encoder name, checked against `ffmpeg -encoders` before the conversion starts. */
  readonly encoder: string;
  /** FFmpeg muxer passed as `-f`; the output extension alone does not name it for every target. */
  readonly muxer: string;
  /** `-b:a` value for lossy encoders (`192k` or plain bits per second); absent for PCM and lossless. */
  readonly defaultBitrate?: string;
  /**
   * `-q:a` value for encoders whose fixed default bitrate fails on low sample rates or mono input
   * (libvorbis rejects 192 kbit/s for 32 kHz mono); used instead of a bitrate when none is requested.
   */
  readonly defaultQuality?: string;
  /** `audio.codec` values a caller may select for this target; any other value is rejected. */
  readonly userCodecs: readonly AudioCodec[];
  /** The encoder only accepts this sample rate (Hz); a conflicting request is rejected. */
  readonly fixedSampleRate?: number;
  /** The encoder only accepts this channel count; a conflicting request is rejected. */
  readonly fixedChannels?: number;
}

const LOSSY_DEFAULT_BITRATE = '192k';
const OPUS_DEFAULT_BITRATE = '128k';
/** AMR-NB top mode (MR122), the highest-quality rate of the 8 kHz narrowband codec. */
const AMR_NB_DEFAULT_BITRATE = '12200';
const AMR_NB_SAMPLE_RATE_HZ = 8000;
const MONO = 1;

const VORBIS_DEFAULT_QUALITY = '5';

const VORBIS_OGG: AudioTargetSpec = {
  encoder: 'libvorbis',
  muxer: 'ogg',
  defaultQuality: VORBIS_DEFAULT_QUALITY,
  userCodecs: ['vorbis', 'opus', 'flac'],
};

const AAC_IPOD: AudioTargetSpec = {
  encoder: 'aac',
  muxer: 'ipod',
  defaultBitrate: LOSSY_DEFAULT_BITRATE,
  userCodecs: ['aac'],
};

const PCM_BE_AIFF: AudioTargetSpec = { encoder: 'pcm_s16be', muxer: 'aiff', userCodecs: [] };

export const AUDIO_TARGET_SPECS: Readonly<Record<string, AudioTargetSpec>> = {
  mp3: { encoder: 'libmp3lame', muxer: 'mp3', defaultBitrate: LOSSY_DEFAULT_BITRATE, userCodecs: ['mp3'] },
  aac: { encoder: 'aac', muxer: 'adts', defaultBitrate: LOSSY_DEFAULT_BITRATE, userCodecs: ['aac'] },
  m4a: AAC_IPOD,
  m4b: AAC_IPOD,
  ogg: VORBIS_OGG,
  oga: VORBIS_OGG,
  opus: { encoder: 'libopus', muxer: 'opus', defaultBitrate: OPUS_DEFAULT_BITRATE, userCodecs: ['opus'] },
  weba: { encoder: 'libopus', muxer: 'webm', defaultBitrate: OPUS_DEFAULT_BITRATE, userCodecs: ['opus', 'vorbis'] },
  flac: { encoder: 'flac', muxer: 'flac', userCodecs: ['flac'] },
  wav: { encoder: 'pcm_s16le', muxer: 'wav', userCodecs: ['pcm_s16le'] },
  aiff: PCM_BE_AIFF,
  aif: PCM_BE_AIFF,
  // The AIFF muxer writes a FORM/AIFC container (little-endian "sowt" samples) for pcm_s16le.
  aifc: { encoder: 'pcm_s16le', muxer: 'aiff', userCodecs: [] },
  alac: { encoder: 'alac', muxer: 'ipod', userCodecs: [] },
  au: { encoder: 'pcm_s16be', muxer: 'au', userCodecs: [] },
  caf: { encoder: 'pcm_s16le', muxer: 'caf', userCodecs: [] },
  voc: { encoder: 'pcm_s16le', muxer: 'voc', userCodecs: [] },
  ac3: { encoder: 'ac3', muxer: 'ac3', defaultBitrate: LOSSY_DEFAULT_BITRATE, userCodecs: [] },
  wma: { encoder: 'wmav2', muxer: 'asf', defaultBitrate: LOSSY_DEFAULT_BITRATE, userCodecs: [] },
  amr: {
    encoder: 'libopencore_amrnb',
    muxer: 'amr',
    defaultBitrate: AMR_NB_DEFAULT_BITRATE,
    userCodecs: [],
    fixedSampleRate: AMR_NB_SAMPLE_RATE_HZ,
    fixedChannels: MONO,
  },
};

/** Advertised audio targets for which FFmpeg has no encoder at all, with the reason. */
export const UNENCODABLE_AUDIO_TARGETS: Readonly<Record<string, string>> = {
  dss: 'FFmpeg can decode Digital Speech Standard but has no DSS encoder or muxer',
};

/** True for every audio-only target: the output must hold exactly one audio stream and nothing else. */
export function isAudioOnlyTarget(target: string): boolean {
  return Object.hasOwn(AUDIO_TARGET_SPECS, target) || Object.hasOwn(UNENCODABLE_AUDIO_TARGETS, target);
}

/** The input has no audio stream (or not the requested one), so an audio-only target cannot be produced. */
export class NoAudioStreamError extends ConversionFailedError {
  constructor(message: string) {
    super(message);
    this.name = 'NoAudioStreamError';
  }
}

/** Resolves the encoding spec of an audio-only target, failing closed when none can be written. */
export function resolveAudioTargetSpec(target: string): AudioTargetSpec {
  const unencodable = Object.hasOwn(UNENCODABLE_AUDIO_TARGETS, target) ? UNENCODABLE_AUDIO_TARGETS[target] : undefined;
  if (unencodable !== undefined) {
    throw new ConversionFailedError(`Cannot write '${target}' audio: ${unencodable}.`);
  }
  if (!Object.hasOwn(AUDIO_TARGET_SPECS, target)) {
    throw new ConversionFailedError(`'${target}' is not a known audio target.`);
  }
  return AUDIO_TARGET_SPECS[target];
}

/**
 * Fails closed when the FFmpeg build lacks the encoder. An empty encoder listing means the binary
 * could not be probed at all; the conversion itself then reports the failure.
 */
export function assertEncoderAvailable(target: string, encoder: string, supportedEncoders: ReadonlySet<string>): void {
  if (supportedEncoders.size === 0 || supportedEncoders.has(encoder)) {
    return;
  }
  throw new ConversionFailedError(
    `Cannot write '${target}' audio: this FFmpeg build has no '${encoder}' encoder.`
  );
}
