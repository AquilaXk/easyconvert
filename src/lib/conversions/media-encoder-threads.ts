import os from 'node:os';

/**
 * Threads of the software H.264 and H.265 encoders.
 *
 * x264 starts one and a half threads per core and then limits that count to one thread per two macroblock rows, so
 * a picture shorter than 16 x 2 x (threads) lines leaves cores idle: a 240-line picture gets seven threads on a
 * 12-core host. x265 starts two frame threads on a host of four to seven cores and three on eight to fifteen. Its
 * frame threads hide the wait of one frame for the rows of the one before it: a picture of a few CTU rows, which is
 * what most jobs have, cannot keep two or three frames in flight, so the encoder waits on itself and the cores idle
 * (a 320x240 clip took 474 ms at two threads and 390 ms at six, and 2.6 s against 2.4 s at 720 lines, on four
 * cores). Where the encoder's own count is below what the host offers, the count asked for here is the host's
 * (x264: at most sixteen, above which it advises against threads) and for x265 six on a host of four cores or more.
 * Three frame threads are never asked for: x265 does not write the same pictures at every run with three (two runs
 * in twenty-five differed), while at two, four, five, six and eight the decoded pictures are identical to each other.
 * The picture is the encoder's own at any thread count that is asked for: x265 decodes to the same frames, x264
 * differs by about one byte in ten thousand.
 */

/** Threads x264 starts per core (it uses integer arithmetic: cores * 3 / 2). */
const X264_THREADS_PER_CORE_NUMERATOR = 3;
const X264_THREADS_PER_CORE_DENOMINATOR = 2;
/** x264 warns against more threads than this when they are asked for. */
const X264_THREADS_ADVISED_MAX = 16;
/** Pixel rows in a macroblock row, and the rows x264 leaves to one thread. */
const MACROBLOCK_ROWS_PIXELS = 16;
const X264_ROWS_PER_THREAD = 2;
/** Fewest cores on which x265 is asked for more frame threads than its own count (below it, its one is enough). */
const X265_MIN_CORES_FOR_MORE_FRAME_THREADS = 4;
/** Frame threads asked of x265: past six the gain stops on a short picture, and each thread holds a frame's buffers. */
const X265_FRAME_THREADS = 6;
const X265_CORES_PER_FRAME_THREAD_BELOW_MINIMUM = 2;

export interface PictureSize {
  width: number;
  height: number;
}

/** Threads x264 starts for a picture of `height` lines on a host with `cores` cores when it is not told a count. */
function x264OwnThreads(cores: number, height: number): number {
  const hostThreads = Math.floor((cores * X264_THREADS_PER_CORE_NUMERATOR) / X264_THREADS_PER_CORE_DENOMINATOR);
  const rowLimit = Math.floor(Math.ceil(height / MACROBLOCK_ROWS_PIXELS) / X264_ROWS_PER_THREAD);
  return Math.max(1, Math.min(hostThreads, rowLimit));
}

/**
 * Threads to pass as `-threads` to the software encoder of `codec` for a picture of `picture` on a host with
 * `cores` cores, or undefined when the encoder's own choice is already as many as the host can use, when the
 * picture is not known, or for a codec whose encoder sizes its own threads (VP9 on tiles and rows, AV1, ProRes).
 */
export function softwareEncoderThreads(
  codec: string,
  picture: PictureSize | undefined,
  cores: number = os.availableParallelism()
): number | undefined {
  if (codec === 'h264') {
    if (picture === undefined) return undefined;
    const hostThreads = Math.floor((cores * X264_THREADS_PER_CORE_NUMERATOR) / X264_THREADS_PER_CORE_DENOMINATOR);
    const wanted = Math.min(X264_THREADS_ADVISED_MAX, hostThreads);
    // The shorter side bounds the height whichever way a display rotation turns the picture.
    return wanted > x264OwnThreads(cores, Math.min(picture.width, picture.height)) ? wanted : undefined;
  }
  if (codec === 'hevc') {
    if (cores < X265_MIN_CORES_FOR_MORE_FRAME_THREADS) {
      return Math.max(1, Math.floor(cores / X265_CORES_PER_FRAME_THREAD_BELOW_MINIMUM));
    }
    return X265_FRAME_THREADS;
  }
  return undefined;
}
