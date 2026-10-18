import {
  executeSandboxedBinary,
  SandboxedProcessError,
  type SandboxedExecutionOptions,
  type SandboxedExecutionResult,
} from '../security/process-sandbox';
import { explainFfmpegFailure, partialDecodeIn } from './media-decode-failures';

/**
 * Runs ffmpeg for a transcode in the sandbox. A run that fails because a stream cannot be decoded is reported as the typed
 * error that names the stream or the codec, and a run that exits with status 0 after its decoder skipped packets for a coding
 * tool FFmpeg lacks is refused: its output holds only a part of the stream. Every other failure is passed on unchanged.
 */
export async function runFfmpegTranscode(
  ffmpegBin: string,
  args: string[],
  options: SandboxedExecutionOptions
): Promise<SandboxedExecutionResult> {
  let result: SandboxedExecutionResult;
  try {
    result = await executeSandboxedBinary(ffmpegBin, args, options);
  } catch (error) {
    throw (error instanceof SandboxedProcessError ? explainFfmpegFailure(error.stderr) : undefined) ?? error;
  }
  const refusal = partialDecodeIn(result.stderr.toString('utf8'));
  if (refusal !== undefined) throw refusal;
  return result;
}
