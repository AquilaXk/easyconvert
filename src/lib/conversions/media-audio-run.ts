import type { ConversionOptions } from '../types';
import { chooseResampler, parseLoudnormMeasurement, resolveLoudnessTarget } from './media-audio-quality';
import {
  buildLoudnessMeasureArguments,
  probeAudioSampleRate,
  resolveFfprobeBinary,
  type LoudnessStage,
} from './media-ffmpeg-args';
import type { MediaInput } from './media-process';

/**
 * Runs the measuring pass of a loudness request and describes the audio choices a conversion made. The
 * process runner is passed in, so the in-process engine and the worker each use their own sandbox.
 */

/** Runs ffmpeg with the arguments and returns what it wrote to stderr (the loudnorm report). */
export type FfmpegStderrRunner = (args: string[]) => Promise<{ stderr: Buffer }>;

export interface LoudnessPassInput {
  input: MediaInput;
  tgt: string;
  options: ConversionOptions;
  ffmpegBin: string;
  run: FfmpegStderrRunner;
}

/**
 * The `apply` stage for the encode when `audio.loudness` is set: it analyses the audio the conversion will
 * write (trim, channel layout and filters included) and returns its measurement. Undefined when no
 * normalisation was requested.
 */
export async function measureLoudnessStage(pass: LoudnessPassInput): Promise<LoudnessStage | undefined> {
  if (!pass.options.audio?.loudness) return undefined;
  const args = buildLoudnessMeasureArguments(pass.input, pass.tgt, pass.options, pass.ffmpegBin);
  const { stderr } = await pass.run(args);
  const track = typeof pass.options.audio.track === 'number' ? pass.options.audio.track : 0;
  const sampleRate = probeAudioSampleRate(pass.input, resolveFfprobeBinary(pass.ffmpegBin), track);
  return { kind: 'apply', measurement: parseLoudnormMeasurement(stderr.toString('utf-8'), sampleRate) };
}

/**
 * Facts about the audio processing for the result metadata: the resampler used (and why it is not soxr when
 * the build lacks it) and, for a normalised file, the target and what the measuring pass found.
 */
export function describeAudioProcessing(
  options: ConversionOptions,
  ffmpegBin: string,
  stage: LoudnessStage | undefined
): Record<string, unknown> {
  const choice = chooseResampler(options.audio?.resampler, ffmpegBin);
  const metadata: Record<string, unknown> = { resampler: choice.resampler };
  if (choice.fallbackReason) metadata.resamplerFallbackReason = choice.fallbackReason;
  if (stage?.kind === 'apply' && options.audio?.loudness) {
    metadata.loudness = {
      target: resolveLoudnessTarget(options.audio.loudness),
      measuredIntegratedLufs: stage.measurement.inputI,
      measuredTruePeakDbtp: stage.measurement.inputTp,
      measuredLoudnessRangeLu: stage.measurement.inputLra,
    };
  }
  return metadata;
}
