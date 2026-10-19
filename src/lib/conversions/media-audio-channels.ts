import fs from 'node:fs';
import { ConversionOptions, InvalidMediaOptionError } from '../types';
import type { AudioTargetSpec } from './media-audio-targets';
import { probeAudioChannels, resolveFfprobeBinary } from './media-ffprobe';

/**
 * The channel layout of an audio encode: which channel counts a target's encoder codes, the ITU-R BS.775 downmix a caller can ask
 * for, and the mix a source wider than the encoder gets. The plan is `-ac` arguments and audio filters, in that order of precedence.
 */

const CHANNELS_BY_LAYOUT_NAME: Readonly<Record<string, number>> = { mono: 1, stereo: 2, '5.1': 6, '7.1': 8 };
const DOWNMIX_CHANNELS = 2;
const ALLOWED_CHANNEL_COUNTS = [1, 2, 6, 8];
const SEVEN_ONE_CHANNELS = 8;
/** ITU-R BS.775-3 stereo mix, normalised so that the sum of a row is 1: the centre and the surround channels 3 dB down, the LFE left out. */
const BS775_SEVEN_ONE = 'pan=stereo|FL=0.3204*FL+0.2265*FC+0.2265*BL+0.2265*SL|FR=0.3204*FR+0.2265*FC+0.2265*BR+0.2265*SR';
/** The surround pair is channels 4 and 5 of a 5.1 mix whether it sits at the back (AAC) or at the sides (AC-3, DTS); naming BL and BR would drop it from the latter. */
const BS775_FIVE_ONE = 'pan=stereo|FL=0.4142*c0+0.2929*c2+0.2929*c4|FR=0.4142*c1+0.2929*c2+0.2929*c5';

export interface AudioChannelPlan {
  /** `-ac` arguments. */
  args: string[];
  /** Audio filters, in the order they run. */
  filters: string[];
}

/** Channel count the caller asked for, in the same precedence the encoder arguments use. */
export function requestedChannelCount(options: ConversionOptions): number | undefined {
  if (options.audio?.downmix === 'itu-r-bs775') return DOWNMIX_CHANNELS;
  if (options.audio?.channels) return options.audio.channels;
  if (options.audioChannels && Object.hasOwn(CHANNELS_BY_LAYOUT_NAME, options.audioChannels)) {
    return CHANNELS_BY_LAYOUT_NAME[options.audioChannels];
  }
  return undefined;
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
  // A source wider than the encoder is mixed down by the target's own layout (see implicitDownmixFilter); without one it is refused.
  const channels = spec.downmixLayout !== undefined ? requestedChannelCount(options) : channelsToWrite(options, inputPath, ffmpegBin);
  if (channels !== undefined && channels > spec.maxChannels) {
    throw new InvalidMediaOptionError(
      `The '${tgt}' target supports at most ${spec.maxChannels} audio channels, but ${channels} would be written; request fewer channels or a downmix.`
    );
  }
}

/** Rejects a channel count that the target's encoder cannot honour, before ffmpeg runs. */
export function assertChannelLimits(
  tgt: string,
  spec: AudioTargetSpec,
  options: ConversionOptions,
  inputPath: string,
  ffmpegBin?: string | null
): void {
  assertFixedChannels(tgt, spec, requestedChannelCount(options));
  assertMaxChannels(tgt, spec, options, inputPath, ffmpegBin);
}

/**
 * The filter that brings the selected input track down to the target's `downmixLayout`, when the caller named no channel count
 * and the track holds more channels than the encoder codes (a 5.1 film track for WMA, which codes two); undefined when
 * nothing needs mixing. A target with no downmix layout refuses such a track instead. The matrix is FFmpeg's ITU-R BS.775 mix
 * (the centre and the surround channels 3 dB down, the LFE left out) with its normalisation stated: WMA takes floating-point
 * samples, for which FFmpeg would otherwise leave the mix unnormalised, 7 dB louder than the same mix for the 16-bit encoders
 * (MP3) and over full scale for loud content.
 */
function implicitDownmixFilter(
  spec: AudioTargetSpec,
  options: ConversionOptions,
  inputPath: string,
  ffmpegBin?: string | null
): string | undefined {
  if (spec.maxChannels === undefined || spec.downmixLayout === undefined || requestedChannelCount(options) !== undefined) return undefined;
  const channels = channelsToWrite(options, inputPath, ffmpegBin);
  if (channels === undefined || channels <= spec.maxChannels) return undefined;
  return `aresample=ochl=${spec.downmixLayout}:rematrix_maxval=1.0`;
}

function bs775Filter(options: ConversionOptions, inputPath: string, ffmpegBin?: string | null): string {
  const sevenOne =
    options.audio?.channels === SEVEN_ONE_CHANNELS ||
    options.audioChannels === '7.1' ||
    (fs.existsSync(inputPath) && probeAudioChannels(inputPath, resolveFfprobeBinary(ffmpegBin)) === SEVEN_ONE_CHANNELS);
  return sevenOne ? BS775_SEVEN_ONE : BS775_FIVE_ONE;
}

/**
 * The `-ac` arguments and audio filters that give the output its channels: the target's fixed count, else the BS.775 downmix the
 * caller asked for, else the count or layout the caller named, else the mix of a source wider than the encoder.
 */
export function planAudioChannels(
  spec: AudioTargetSpec | undefined,
  specEncoderInUse: boolean,
  options: ConversionOptions,
  inputPath: string,
  ffmpegBin?: string | null
): AudioChannelPlan {
  if (spec?.fixedChannels !== undefined) return { args: ['-ac', String(spec.fixedChannels)], filters: [] };
  if (options.audio?.downmix === 'itu-r-bs775') {
    return { args: ['-ac', String(DOWNMIX_CHANNELS)], filters: [bs775Filter(options, inputPath, ffmpegBin)] };
  }
  if (options.audio?.channels) {
    if (!ALLOWED_CHANNEL_COUNTS.includes(options.audio.channels)) {
      throw new InvalidMediaOptionError(`Invalid audio channels: ${options.audio.channels}. Allowed: 1, 2, 6, 8.`);
    }
    return { args: ['-ac', String(options.audio.channels)], filters: [] };
  }
  if (options.audioChannels && Object.hasOwn(CHANNELS_BY_LAYOUT_NAME, options.audioChannels)) {
    return { args: ['-ac', String(CHANNELS_BY_LAYOUT_NAME[options.audioChannels])], filters: [] };
  }
  const mix = spec && specEncoderInUse ? implicitDownmixFilter(spec, options, inputPath, ffmpegBin) : undefined;
  return { args: [], filters: mix === undefined ? [] : [mix] };
}
