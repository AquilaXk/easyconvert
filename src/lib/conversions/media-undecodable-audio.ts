import { runFfprobe } from './media-process';

/**
 * Finds the audio streams of a file that cannot be decoded at all. ffprobe reports a stream's sample rate from the first
 * frame it decodes while it analyses the start of the file, so a stream without one is a suspect; the suspect is then tried
 * on its first packets, in a process of its own, and is undecodable when none of them gives a frame. The probe reads a bounded
 * number of packets and its answer is only used when it ran to the end: a probe that fails or times out leaves the stream alone.
 */

/** Packets of a suspect stream that are decoded. FFmpeg gives up on a stream when two thirds of its packets are invalid. */
export const UNDECODABLE_PROBE_PACKETS = 32;
/** Suspects that are tried; a file with more streams than this without a sample rate is left to the conversion to refuse. */
const MAX_SUSPECTS_TRIED = 8;
const PROBE_TIMEOUT_MS = 10_000;
/** One `pts` per line for at most UNDECODABLE_PROBE_PACKETS frames. */
const PROBE_MAX_BYTES = 64 * 1024;

/** True when ffprobe ran and decoded no frame from the first packets of stream `index`. */
function decodesNothing(ffprobe: string, filePath: string, index: number): boolean {
  const run = runFfprobe(
    ffprobe,
    ['-v', 'quiet', '-select_streams', String(index), '-show_entries', 'frame=pts', '-of', 'csv=p=0', '-read_intervals', `%+#${UNDECODABLE_PROBE_PACKETS}`],
    filePath,
    { timeoutMs: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BYTES }
  );
  return run.ok && run.stdout.trim() === '';
}

/** The indexes among `suspects` (absolute stream indexes of audio streams without a sample rate) that decode nothing. */
export function findUndecodableAudio(ffprobe: string, filePath: string, suspects: readonly number[]): Set<number> {
  return new Set(suspects.slice(0, MAX_SUSPECTS_TRIED).filter((index) => decodesNothing(ffprobe, filePath, index)));
}
