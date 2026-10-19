import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { EmptyAudioInputError } from '../types';
import { type FfprobePath, resolveFfprobeBinary } from './media-ffprobe';

/**
 * Why an FFmpeg run wrote zero bytes. A target format without a file header (ADTS, the `.aac` target) holds one frame
 * after another, so an input with no audio samples gives an empty file; that is a fact about the input and is refused
 * by name. Any other cause keeps the plain error of an empty output.
 */

const PROBE_TIMEOUT_MS = 30_000;
const PROBE_KILL_SIGNAL = 'SIGKILL';
const PROBE_MAX_BYTES = 64 * 1024;

/** Shape of the ffprobe stream list: a stream without a packet has no packet count at all. */
interface PacketCounts {
  streams?: Array<{ nb_read_packets?: unknown }>;
}

/** Audio packets of all audio streams of the file, or undefined when ffprobe cannot count them. */
function audioPacketCount(filePath: string, ffprobe: FfprobePath): number | undefined {
  try {
    const out = execFileSync(
      ffprobe,
      ['-v', 'error', '-count_packets', '-select_streams', 'a', '-show_entries', 'stream=nb_read_packets', '-of', 'json', filePath],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PROBE_TIMEOUT_MS, killSignal: PROBE_KILL_SIGNAL, maxBuffer: PROBE_MAX_BYTES },
    );
    const counts = (JSON.parse(out) as PacketCounts).streams ?? [];
    return counts.reduce((sum, stream) => sum + Number(stream.nb_read_packets ?? 0), 0);
  } catch {
    return undefined;
  }
}

/** The error for a run that wrote no bytes: the named refusal when the input holds an audio stream with no packet. */
export function emptyOutputError(inputPath: string, ffmpegBin: string, src: string, tgt: string): Error {
  if (audioPacketCount(inputPath, resolveFfprobeBinary(ffmpegBin)) === 0) return new EmptyAudioInputError(tgt);
  return new Error(`FFmpeg output is empty (0 bytes) for ${src} -> ${tgt}`);
}

/** Throws unless the run wrote a file with bytes in it. */
export function assertOutputWritten(outputPath: string, inputPath: string, ffmpegBin: string, src: string, tgt: string): void {
  if (!fs.existsSync(outputPath)) {
    throw new Error(`FFmpeg execution completed without producing expected output file "${outputPath}"`);
  }
  if (fs.statSync(outputPath).size === 0) throw emptyOutputError(inputPath, ffmpegBin, src, tgt);
}
