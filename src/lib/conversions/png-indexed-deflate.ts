import zlib from 'node:zlib';
import { deflateRawWithLibdeflate, NativeDeflateError } from './archive-libdeflate';
import { zlibFrame, zlibInBlocks } from './deflate-blocks';

/**
 * The deflate stream of the rows of an indexed PNG that the worker writes itself (`writeIndexedPng`). The rows are palette indices behind a
 * filter byte of 0, and two kinds of picture need two deflaters (Linux arm64, the 55 pictures of entry 232; entry 258 has the table):
 *
 * - A graphic (a screenshot, line art, a picture with transparency: flat areas and repeats) is long runs of matches. zlib level 9 in parallel
 *   blocks ({@link zlibInBlocks}) takes 8 to 90 ms of one thread for 0.4 to 2 megapixels and a third of that on four, while libdeflate's
 *   near-optimal levels (11 and 12) take 3 to 6 times as long for 7 to 9 percent fewer bytes, which is more than the reference's whole run.
 * - A photograph is dithered noise, where a near-optimal parse is cheap (libdeflate level 10: 20 ms for 0.4 megapixels, three times zlib level 9
 *   on four threads) and writes 3 to 12 percent fewer bytes than zlib 9. Levels 11 and 12 save 0.1 percent more on it.
 *
 * Which kind a picture is shows in a sample of its rows: zlib level 1 shrinks the sample of a graphic to 1.5 to 13 percent and that of a
 * photograph to 38 percent or more. A worker without `libdeflate-gzip`, a run that fails or one that is slower than a photograph allows (a
 * picture that looks like noise at three places and is not) writes the rows with zlib level 6 in blocks, 7 percent larger than libdeflate 10.
 */

/** A sample of the rows is this many bytes at the start, the middle and the end of the picture; a picture of up to three samples is judged whole. */
const SAMPLE_BYTES = 64 * 1024;
const SAMPLE_SPOTS = [0, 0.5, 1];
/** The sample of a photograph shrinks to 38 percent or more at zlib level 1 (38 of 38 pictures), that of a graphic to 13.1 percent or less (17 of 17). */
const NOISE_RATIO = 0.3;
const SAMPLE_LEVEL = 1;
const GRAPHIC_LEVEL = 9;
/** Blocks of 128 KiB: the rows of a graphic of 0.4 to 2 megapixels then fill four threads, at the same bytes (-0.4 percent of 256 KiB) in 25 percent less time. */
const BLOCK_BYTES = 128 * 1024;
const NOISE_FALLBACK_LEVEL = 6;
/** The product level whose libdeflate level is 10 (see `archive-libdeflate.ts`). */
const LIBDEFLATE_10_PRODUCT_LEVEL = 8;
/** libdeflate level 10 runs at 13 MB/s or more on noise; a run slower than 4 MB/s (plus a second) is stopped and the rows are written by zlib. */
const LIBDEFLATE_BASE_TIMEOUT_MS = 1000;
const LIBDEFLATE_MIN_BYTES_PER_MS = 4000;

function sampleOf(rows: Uint8Array): Uint8Array {
  if (rows.length <= SAMPLE_BYTES * SAMPLE_SPOTS.length) return rows;
  return Buffer.concat(
    SAMPLE_SPOTS.map((spot) => {
      const start = Math.floor((rows.length - SAMPLE_BYTES) * spot);
      return rows.subarray(start, start + SAMPLE_BYTES);
    })
  );
}

/** Whether the rows are noise-like (a photograph), by the zlib level 1 ratio of a sample. */
export function looksLikeNoise(rows: Uint8Array): boolean {
  const sample = sampleOf(rows);
  return zlib.deflateRawSync(sample, { level: SAMPLE_LEVEL }).length >= sample.length * NOISE_RATIO;
}

/** The zlib stream of the rows: libdeflate level 10 for noise-like rows, zlib level 9 for the others. */
export async function deflateIndexedRows(rows: Uint8Array, signal?: AbortSignal): Promise<Buffer> {
  if (!looksLikeNoise(rows)) return zlibInBlocks(rows, GRAPHIC_LEVEL, BLOCK_BYTES);
  try {
    const deflated = await deflateRawWithLibdeflate(rows, LIBDEFLATE_10_PRODUCT_LEVEL, {
      signal,
      timeoutMs: LIBDEFLATE_BASE_TIMEOUT_MS + rows.length / LIBDEFLATE_MIN_BYTES_PER_MS,
    });
    return zlibFrame(deflated, rows, GRAPHIC_LEVEL);
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof NativeDeflateError)) throw error;
    return zlibInBlocks(rows, NOISE_FALLBACK_LEVEL, BLOCK_BYTES);
  }
}
