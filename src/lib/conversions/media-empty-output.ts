import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { EmptyAudioInputError } from '../types';
import { FFPROBE_TIMEOUT_MS, type FfprobePath, resolveFfprobeBinary } from './media-ffprobe';

/**
 * Why an FFmpeg run wrote an empty or unreadable file. A target format without a file header (ADTS, the `.aac` target)
 * holds one frame after another, so an input with no audio samples gives an empty file. For `.m4a`, `.mp3`, `.opus` and
 * `.ogg` FFmpeg writes a few hundred bytes (a movie box without a track, a tag without a frame, or stream headers
 * without an audio page) that no reader opens, and no valid empty file of those formats comes out of FFmpeg. Both are
 * facts about the input and are refused by name. Any other cause keeps the plain error of an empty output.
 */

/** Targets that get a file nothing opens from an input without samples. */
const UNREADABLE_WHEN_EMPTY_TARGETS: ReadonlySet<string> = new Set(['m4a', 'mp3', 'opus', 'ogg']);
/**
 * Output size under which one of those targets is looked at: such an empty output is 135 to 261 bytes, or 2.6 KB with
 * Vorbis headers. The size only decides whether the input is probed (a larger file is never probed); the answer comes
 * from the input's packets, so a small real file is not refused.
 */
const SMALL_OUTPUT_BYTES = 8 * 1024;

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

/**
 * The error for an output of `size` bytes, or undefined when it needs none: an empty output, or a small output of a target
 * that holds nothing readable for an input without samples (the one probe is made only then).
 */
export function outputSizeError(size: number, inputPath: string, ffmpegBin: string, src: string, tgt: string): Error | undefined {
  if (size === 0) return emptyOutputError(inputPath, ffmpegBin, src, tgt);
  const mayBeUnreadable = size < SMALL_OUTPUT_BYTES && UNREADABLE_WHEN_EMPTY_TARGETS.has(tgt);
  if (mayBeUnreadable && audioPacketsAtStart(inputPath, resolveFfprobeBinary(ffmpegBin)) === 0) return new EmptyAudioInputError(tgt);
  return undefined;
}

/** Throws unless the run wrote a file with bytes in it. */
export function assertOutputWritten(outputPath: string, inputPath: string, ffmpegBin: string, src: string, tgt: string): void {
  if (!fs.existsSync(outputPath)) {
    throw new Error(`FFmpeg execution completed without producing expected output file "${outputPath}"`);
  }
  const failure = outputSizeError(fs.statSync(outputPath).size, inputPath, ffmpegBin, src, tgt);
  if (failure) throw failure;
}
