import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { EmptyAudioInputError } from '../types';
import { FFPROBE_TIMEOUT_MS, type FfprobePath, resolveFfprobeBinary } from './media-ffprobe';

/**
 * Why an FFmpeg run wrote zero bytes. A target format without a file header (ADTS, the `.aac` target) holds one frame
 * after another, so an input with no audio samples gives an empty file; that is a fact about the input and is refused
 * by name. Any other cause keeps the plain error of an empty output.
 */

const PROBE_KILL_SIGNAL = 'SIGKILL';
const PROBE_MAX_BYTES = 64 * 1024;
/** `%+#1` reads from the start up to one packet, so a probe costs the same for a 1 KB file and a 500 MB one. */
const READ_FIRST_PACKET = '%+#1';

/** Shape of the ffprobe report: the audio streams, and the packets read from the start of the file. */
interface FirstPacketReport {
  streams?: unknown[];
  packets?: unknown[];
}

/**
 * Audio packets ffprobe reads from the start of the file, at most one, or undefined when the file has no audio stream
 * or ffprobe cannot read it. Zero means an audio stream with no packet in it.
 */
export function audioPacketsAtStart(filePath: string, ffprobe: FfprobePath): number | undefined {
  try {
    const out = execFileSync(
      ffprobe,
      ['-v', 'error', '-select_streams', 'a', '-read_intervals', READ_FIRST_PACKET, '-show_entries', 'stream=index:packet=stream_index', '-of', 'json', filePath],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: FFPROBE_TIMEOUT_MS, killSignal: PROBE_KILL_SIGNAL, maxBuffer: PROBE_MAX_BYTES },
    );
    const report = JSON.parse(out) as FirstPacketReport;
    if ((report.streams ?? []).length === 0) return undefined;
    return (report.packets ?? []).length;
  } catch {
    return undefined;
  }
}

/** The error for a run that wrote no bytes: the named refusal when the input holds an audio stream with no packet. */
export function emptyOutputError(inputPath: string, ffmpegBin: string, src: string, tgt: string): Error {
  if (audioPacketsAtStart(inputPath, resolveFfprobeBinary(ffmpegBin)) === 0) return new EmptyAudioInputError(tgt);
  return new Error(`FFmpeg output is empty (0 bytes) for ${src} -> ${tgt}`);
}

/** Throws unless the run wrote a file with bytes in it. */
export function assertOutputWritten(outputPath: string, inputPath: string, ffmpegBin: string, src: string, tgt: string): void {
  if (!fs.existsSync(outputPath)) {
    throw new Error(`FFmpeg execution completed without producing expected output file "${outputPath}"`);
  }
  if (fs.statSync(outputPath).size === 0) throw emptyOutputError(inputPath, ffmpegBin, src, tgt);
}