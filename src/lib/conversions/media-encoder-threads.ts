import os from 'node:os';

/**
 * Threads of the software H.264 and H.265 encoders.
 *
 * x264 starts one and a half threads per core and then limits that count to one thread per two macroblock rows, so
 * a picture shorter than 16 x 2 x (threads) lines leaves cores idle: a 240-line picture gets seven threads on a
 * 12-core host. x265 starts three frame threads on a host of eight to fifteen cores. On a short clip the idle cores
 * cost more time than the encoding. Where the encoder's own count is below what the host offers, the count asked for
 * here is the host's (x264: at most sixteen, above which it advises against threads) and for x265 half the cores up
 * to six. The picture is the encoder's own at any thread count: x265 writes the same bytes, x264 differs by about
 * one byte in ten thousand.
 */

/** Threads x264 starts per core (it uses integer arithmetic: cores * 3 / 2). */
const X264_THREADS_PER_CORE_NUMERATOR = 3;
const X264_THREADS_PER_CORE_DENOMINATOR = 2;
/** x264 warns against more threads than this when they are asked for. */
const X264_THREADS_ADVISED_MAX = 16;
/** Pixel rows in a macroblock row, and the rows x264 leaves to one thread. */
const MACROBLOCK_ROWS_PIXELS = 16;
const X264_ROWS_PER_THREAD = 2;
/** x265 frame threads past this share of the cores, or past six, only cost memory. */
const X265_CORES_PER_FRAME_THREAD = 2;
const X265_FRAME_THREADS_MAX = 6;

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
    return Math.min(X265_FRAME_THREADS_MAX, Math.max(1, Math.floor(cores / X265_CORES_PER_FRAME_THREAD)));
  }
  return undefined;
}
