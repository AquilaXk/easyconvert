import { ZstdBlockEncoder, getZstdLevelParams } from './zstd-encoder';
import { ZSTD_BLOCK_SIZE_MAX } from './zstd-tables';

/**
 * Splitting one Zstandard frame into jobs. The greedy and lazy parsers of the levels below ZSTD_POOL_MIN_LEVEL read
 * only the data behind them, so an input of several blocks can be cut at block boundaries into jobs that are parsed
 * and entropy coded independently and then joined, in order, into one RFC 8878 frame (the technique of multi-threaded
 * `zstd -T`, where a job's history is an overlap with the data before it). The layout is a function of the input
 * length and the level alone, never of the number of threads or of where a job runs, so the frame is the same bytes
 * whether the jobs run one after another or on pool threads.
 *
 * A job starts without a repeat-offset history it can rely on (the decoder's repeat offsets there come from the job
 * before it), so its encoder begins with all three invalid and writes explicit offsets until it has real ones.
 * Entropy tables are never carried from one block to the next, so jobs need nothing else from each other.
 */

/** Levels from here on use the optimal parser, slow enough to hold the event loop for tens of milliseconds per slice. */
export const ZSTD_POOL_MIN_LEVEL = 10;
/** The input is cut into about this many jobs, so that the pool threads and the calling thread each get work. */
export const ZSTD_JOB_COUNT_TARGET = 4;
/** A job spans at least this many blocks: below it the cost of a job (tables, history) outweighs what it saves. */
export const ZSTD_JOB_BLOCKS_MIN = 2;
/** A job spans at most this many blocks (2 MiB), so that a long input still yields jobs short enough to schedule evenly. */
export const ZSTD_JOB_BLOCKS_MAX = 16;
/** How much of the data before a job its match finder indexes, so that matches reach across the cut. */
export const ZSTD_JOB_HISTORY_BYTES = ZSTD_BLOCK_SIZE_MAX;

export interface ZstdJob {
  /** First byte the job encodes; a multiple of the block size. */
  from: number;
  /** End of the job's bytes. */
  to: number;
  /** First byte of the history the job's matches may reach. */
  historyFrom: number;
}

/** The jobs of an input at a level, or null when it is one frame of one job (short input or a level of the optimal parser). */
export function planZstdJobs(inputLength: number, level: number): ZstdJob[] | null {
  if (level >= ZSTD_POOL_MIN_LEVEL) return null;
  const blocks = Math.ceil(inputLength / ZSTD_BLOCK_SIZE_MAX);
  if (blocks <= ZSTD_JOB_BLOCKS_MIN) return null;
  const jobBlocks = Math.min(ZSTD_JOB_BLOCKS_MAX, Math.max(ZSTD_JOB_BLOCKS_MIN, Math.ceil(blocks / ZSTD_JOB_COUNT_TARGET)));
  const jobBytes = jobBlocks * ZSTD_BLOCK_SIZE_MAX;
  const jobs: ZstdJob[] = [];
  for (let from = 0; from < inputLength; from += jobBytes) {
    jobs.push({ from, to: Math.min(from + jobBytes, inputLength), historyFrom: Math.max(0, from - ZSTD_JOB_HISTORY_BYTES) });
  }
  return jobs;
}

/** The window a frame of `inputLength` bytes at a level declares: single-segment (the content size) when it fits the level's window. */
export function zstdFrameWindow(inputLength: number, level: number): { windowLog: number; singleSegment: boolean; windowSize: number } {
  const { windowLog } = getZstdLevelParams(level);
  const declaredWindow = 2 ** windowLog;
  const singleSegment = inputLength <= declaredWindow;
  return { windowLog, singleSegment, windowSize: singleSegment ? inputLength : declaredWindow };
}

/** The compressed blocks of job `index` of `jobs`: the bytes that follow the previous job's, with the last-block flag on the final job only. */
export function encodeZstdJob(data: Uint8Array, level: number, jobs: readonly ZstdJob[], index: number): Uint8Array {
  const params = getZstdLevelParams(level);
  const { windowSize } = zstdFrameWindow(data.length, level);
  const job = jobs[index];
  const encoder = new ZstdBlockEncoder(data, params, windowSize, job.to, { historyFrom: job.historyFrom, firstJob: index === 0 });
  const encoded = encoder.encodeRange(job.from, job.to, index === jobs.length - 1, new Uint8Array(0), 0);
  return encoded.data.subarray(0, encoded.length);
}
