import { recordEngineOutput } from '../engine-output';
import { SandboxedProcessError } from '../security/process-sandbox';

/** The short reasons for the failures of FFmpeg that the log tells apart, each with the line of the log that shows it. */
const FFMPEG_REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Unable to choose an output format/, 'the target container has no FFmpeg muxer'],
  [/Could not write header|incorrect codec parameters|Unsupported (?:audio|video) codec|Could not find tag for codec|Tag \S+ incompatible with output codec/, 'the target container cannot carry a stream of the input'],
  [/Error while opening encoder|is not valid for the \S+ codec/, 'the encoder cannot take the size, rate or channel layout of the stream'],
  [/Nothing was written into output file/, 'no stream could be written to the output'],
  [/Invalid data found when processing input/, 'the input is damaged or is not in the declared format'],
];

/**
 * What a failed FFmpeg run says to the caller: a short reason, never the log, whose banner names the build and its options. The
 * log goes to the server log. An error that is not a run of the program (our own text) is quoted as it is.
 */
export function ffmpegFailureReason(error: unknown): string {
  if (!(error instanceof SandboxedProcessError)) return error instanceof Error ? error.message : String(error);
  recordEngineOutput('ffmpeg', 'transcode', error.stderr);
  const known = FFMPEG_REASONS.find(([pattern]) => pattern.test(error.stderr));
  if (known) return `${known[1]}.`;
  return error.signal ? `FFmpeg was stopped by ${error.signal}.` : `FFmpeg exited with status ${error.exitCode}.`;
}
