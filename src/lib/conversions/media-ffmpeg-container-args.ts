import fs from 'node:fs';
import { ConversionOptions, InvalidMediaOptionError } from '../types';
import { probeInputDuration, resolveFfprobeBinary } from './media-ffprobe';
import { type MediaInput } from './media-process';

/** One pass of a two-pass encode: the pass number and the prefix of the pass log files. */
export interface TwoPassStage {
  pass: 1 | 2;
  /** File name prefix of the pass logs; written in the job's working directory, which is removed afterwards. */
  logPrefix: string;
}

/** Codecs with an encoder that writes and reads a rate-control pass log through ffmpeg (SVT-AV1 does not). */
const TWO_PASS_CODECS: ReadonlySet<string> = new Set(['h264', 'hevc', 'vp9']);
/** A pass log prefix goes into `-passlogfile` and x265's colon-separated parameter list: no separators or spaces. */
export const PASS_LOG_PREFIX_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** Longest an output may be asked to run: one day. */
const MAX_OUTPUT_DURATION_SEC = 86_400;
/** A requested duration may exceed the probed one by this much: container durations are rounded. */
const DURATION_EPSILON_SEC = 0.001;
/** Terms of an aspect ratio, and the widest ratio padding or cropping may produce (bounds the padded frame). */
const MAX_ASPECT_TERM = 10_000;
const MAX_ASPECT_RATIO = 10;
const ASPECT_RATIO_PATTERN = /^(\d{1,5}):(\d{1,5})$/;

/** True when the request asks for a two-pass VBR encode; such a request must be built with buildTwoPassArguments. */
export function isTwoPassRequested(options: ConversionOptions): boolean {
  const twoPass = (options.video?.rateControl as { twoPass?: unknown } | undefined)?.twoPass;
  if (twoPass === undefined || twoPass === false) return false;
  if (twoPass !== true) {
    throw new InvalidMediaOptionError(`Invalid twoPass ${JSON.stringify(twoPass)}. Must be true or false.`);
  }
  return true;
}

/** Pass-specific encoder arguments: x265 takes its pass and stats file as parameters, the others as ffmpeg options. */
export function twoPassEncoderArgs(stage: TwoPassStage, codec: string): string[] {
  if (codec === 'hevc') {
    return ['-x265-params', `pass=${stage.pass}:stats=${stage.logPrefix}`];
  }
  return ['-pass', String(stage.pass), '-passlogfile', stage.logPrefix];
}

export function assertTwoPassSupported(options: ConversionOptions, tgt: string, codec: string): void {
  const rateControl = options.video?.rateControl;
  if (rateControl?.mode !== 'vbr') {
    throw new InvalidMediaOptionError(`twoPass needs rateControl.mode 'vbr' with a bitrate; mode '${rateControl?.mode ?? 'unset'}' has no target rate to reach.`);
  }
  if (!TWO_PASS_CODECS.has(codec)) {
    throw new InvalidMediaOptionError(
      `twoPass is available for h264, hevc and vp9; '${codec}' has no rate-control pass through ffmpeg (SVT-AV1 and ProRes ignore -pass).`
    );
  }
  if (tgt === 'avi') {
    throw new InvalidMediaOptionError("twoPass is not available for the 'avi' target.");
  }
}

/** The output length cap in seconds, checked against the input when it can be read. */
export async function resolveOutputDuration(options: ConversionOptions, input: MediaInput, ffmpegBin?: string | null): Promise<number | undefined> {
  const duration = options.duration;
  if (duration === undefined) return undefined;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > MAX_OUTPUT_DURATION_SEC) {
    throw new InvalidMediaOptionError(`Invalid duration ${String(duration)}. Must be more than 0 and at most ${MAX_OUTPUT_DURATION_SEC} seconds.`);
  }
  if (fs.existsSync(input.path)) {
    const sourceDuration = await probeInputDuration(input, resolveFfprobeBinary(ffmpegBin), options.signal);
    if (duration > sourceDuration + DURATION_EPSILON_SEC) {
      throw new InvalidMediaOptionError(`Invalid duration ${duration}: the input lasts ${sourceDuration.toFixed(3)} seconds.`);
    }
  }
  return duration;
}

/** `+faststart` (moov before mdat) is the default for mp4, mov and m4a; `false` omits it and `true` elsewhere is an error. */
export function resolveFastStart(options: ConversionOptions, tgt: string, capable: boolean): boolean {
  const requested = options.fastStart;
  if (requested === undefined) return capable;
  if (typeof requested !== 'boolean') {
    throw new InvalidMediaOptionError(`Invalid fastStart ${JSON.stringify(requested)}. Must be true or false.`);
  }
  if (requested && !capable) {
    throw new InvalidMediaOptionError(`fastStart applies to mp4, mov and m4a output; the '${tgt}' target has no moov box to move.`);
  }
  return requested;
}

export interface AspectPlan {
  num: number;
  den: number;
  mode: 'dar' | 'pad' | 'crop';
}

export function resolveAspectRatio(requested: ConversionOptions['aspectRatio']): AspectPlan | undefined {
  if (requested === undefined) return undefined;
  const ratio = typeof requested === 'string' ? requested : requested?.ratio;
  const mode = typeof requested === 'string' ? 'dar' : (requested?.mode ?? 'dar');
  const match = typeof ratio === 'string' ? ASPECT_RATIO_PATTERN.exec(ratio) : null;
  if (!match) {
    throw new InvalidMediaOptionError(`Invalid aspectRatio ${JSON.stringify(requested)}. Use W:H with whole numbers, e.g. "16:9".`);
  }
  const num = Number(match[1]);
  const den = Number(match[2]);
  if (num < 1 || den < 1 || num > MAX_ASPECT_TERM || den > MAX_ASPECT_TERM || num / den > MAX_ASPECT_RATIO || den / num > MAX_ASPECT_RATIO) {
    throw new InvalidMediaOptionError(`Invalid aspectRatio ${num}:${den}. Each term is 1 to ${MAX_ASPECT_TERM} and the ratio at most ${MAX_ASPECT_RATIO}:1.`);
  }
  if (mode !== 'dar' && mode !== 'pad' && mode !== 'crop') {
    throw new InvalidMediaOptionError(`Invalid aspectRatio mode ${JSON.stringify(mode)}. Allowed: dar, pad, crop.`);
  }
  return { num, den, mode };
}

/**
 * Filters that reshape the picture to the ratio, keeping even sizes (4:2:0 needs them): pad adds black bars
 * to the smaller side, crop removes from the larger one, both centred. Each ends with a square pixel aspect, so
 * the displayed ratio is the frame's own width over height.
 */
export function aspectReshapeFilter(plan: AspectPlan): string | undefined {
  const { num, den } = plan;
  if (plan.mode === 'pad') {
    return (
      `pad=w='max(iw\\,ceil(ih*${num}/${den}/2)*2)':h='max(ih\\,ceil(iw*${den}/${num}/2)*2)'` +
      ":x='(ow-iw)/2':y='(oh-ih)/2':color=black,setsar=1"
    );
  }
  if (plan.mode === 'crop') {
    return `crop=w='min(iw\\,floor(ih*${num}/${den}/2)*2)':h='min(ih\\,floor(iw*${den}/${num}/2)*2)',setsar=1`;
  }
  return undefined;
}
