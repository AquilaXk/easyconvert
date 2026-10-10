import os from 'node:os';
import sharp from 'sharp';

/**
 * Threads for the AV1 encoder inside the image library. Left alone, the library on glibc Linux without a replacement
 * allocator runs on one thread, to keep the heap from fragmenting, and the encoder takes that count from it: a 768 x 512
 * photograph took 45 ms to encode as AVIF on a 4-core machine where the reference encoder (all cores) took 31 ms, and a
 * 24-megapixel one 9.6 s against 2.9 s on 4 threads.
 *
 * The threads are leased for the length of an AVIF encode and not set for the process: the same threads made the WebP
 * encode of a 1024 x 640 interface 6 ms longer (27 ms to 33 ms) and gained nothing in JPEG, because the thread pool of a
 * picture this small costs more to start than it saves. Resident memory of a run of 4-megapixel conversions rose from
 * 483 MB to 934 MB on 4 threads (a 24-megapixel AVIF: 921 MB to 1011 MB), and the heap stays that size on glibc; a
 * deployment that wants the single-thread footprint back sets `VIPS_CONCURRENCY=1`.
 */

/** Most threads one encode uses: the bound the AVIF command-line encoder uses (beyond it a run gains about 10%). */
export const IMAGE_MAX_THREADS = 8;
export const IMAGE_THREADS_ENV = 'VIPS_CONCURRENCY';

/** Threads for `cores` available cores, or the operator's positive whole number in `VIPS_CONCURRENCY`. */
export function imageThreadsFor(cores: number, env: Readonly<Record<string, string | undefined>> = process.env): number {
  const requested = Number(env[IMAGE_THREADS_ENV]);
  if (Number.isInteger(requested) && requested > 0) return requested;
  return Math.max(1, Math.min(cores, IMAGE_MAX_THREADS));
}

/** Encodes in flight that hold the lease, and the thread count to go back to when the last of them ends. */
let leases = 0;
let restoreTo = 1;

/**
 * Runs `encode` with the image library on `imageThreadsFor` threads. The count is process-wide, so concurrent encodes
 * share one lease: the first sets it, the last puts back what was there before, whether they end or fail.
 */
export async function withImageThreads<T>(encode: () => Promise<T>): Promise<T> {
  if (leases === 0) {
    restoreTo = sharp.concurrency();
    sharp.concurrency(imageThreadsFor(os.availableParallelism()));
  }
  leases += 1;
  try {
    return await encode();
  } finally {
    leases -= 1;
    if (leases === 0) sharp.concurrency(restoreTo);
  }
}
