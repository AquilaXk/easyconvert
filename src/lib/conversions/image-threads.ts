import os from 'node:os';
import sharp from 'sharp';

/**
 * Threads for the AV1 encoder inside the image library. Left alone, the library on glibc Linux without a replacement
 * allocator runs on one thread, to keep the heap from fragmenting, and the encoder takes that count from it: a 768 x 512
 * photograph took 45 ms to encode as AVIF on a 4-core machine where the reference encoder (all cores) took 31 ms, and a
 * 24-megapixel one 9.6 s against 2.9 s on 4 threads.
 *
 * The threads are leased for the length of an AVIF encode of a photograph and not set for the process: the same threads
 * made the WebP encode of a 1024 x 640 interface 6 ms longer (27 ms to 33 ms) and gained nothing in JPEG, because the
 * thread pool of a picture this small costs more to start than it saves.
 *
 * Peak resident memory (Linux, 4 cores; 40 conversions of a 4-megapixel picture, one 24-megapixel AVIF), against the single
 * thread it had: with `MALLOC_ARENA_MAX=2` (docker-compose.yml sets it for the worker) 0.7 times and 1.1 times, with 8
 * threads of arenas of their own 1.5 times and 1.2 times, which is why a process that did not bound its heap leases two
 * threads.
 */

/** Most threads one encode uses: the bound the AVIF command-line encoder uses (beyond it a run gains about 10%). */
export const IMAGE_MAX_THREADS = 8;
export const IMAGE_THREADS_ENV = 'VIPS_CONCURRENCY';
/**
 * Memory limit per leased thread. A thread of the AV1 encoder holds about 30 MB of working set (24-megapixel AVIF: 788 MB
 * on one thread, 932 MB on four) and the allocator keeps up to twice that after the encode, so 256 MB of limit per thread
 * leaves a wide margin: a 1 GB container leases 4 threads, a 512 MB one leases 2.
 */
export const IMAGE_THREAD_MEMORY_BYTES = 256 * 1024 * 1024;
/** Threads the image library runs on outside an AVIF encode of a photograph. */
export const IMAGE_BASE_THREADS = 1;
export const MALLOC_ARENA_ENV = 'MALLOC_ARENA_MAX';
/**
 * Threads an encode may lease while the glibc heap is not bounded (`MALLOC_ARENA_MAX` unset): every thread then grows an
 * arena of its own, and 4 threads took a run of 4-megapixel conversions to 1.5 times its single-thread peak. Two threads
 * give most of the speed (a 768 x 512 photograph: 63 ms on one, 42 ms on two, 39 ms on four) at 1.1 times the peak.
 */
export const IMAGE_UNBOUNDED_HEAP_THREADS = 2;

type Env = Readonly<Record<string, string | undefined>>;

function requestedThreads(env: Env): number | null {
  const requested = Number(env[IMAGE_THREADS_ENV]);
  return Number.isInteger(requested) && requested > 0 ? requested : null;
}

/** Threads outside an encode: the operator's `VIPS_CONCURRENCY`, else one. */
export function baseImageThreads(env: Env = process.env): number {
  return requestedThreads(env) ?? IMAGE_BASE_THREADS;
}

/**
 * Threads for an AVIF encode of a photograph on `cores` cores under a memory limit of `memoryBytes`: the operator's
 * `VIPS_CONCURRENCY` when it is set, else the cores, at most `IMAGE_MAX_THREADS` (`IMAGE_UNBOUNDED_HEAP_THREADS` while the
 * heap is not bounded) and at most what the memory limit pays for.
 */
export function imageThreadsFor(cores: number, memoryBytes: number = Number.POSITIVE_INFINITY, env: Env = process.env): number {
  const requested = requestedThreads(env);
  if (requested !== null) return requested;
  const heapBound = env[MALLOC_ARENA_ENV] ? IMAGE_MAX_THREADS : IMAGE_UNBOUNDED_HEAP_THREADS;
  return Math.max(1, Math.min(cores, heapBound, Math.floor(memoryBytes / IMAGE_THREAD_MEMORY_BYTES)));
}

/** The memory this process may use: the container limit when there is one, else the machine's. */
export function memoryLimitBytes(): number {
  const constrained = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0;
  const total = os.totalmem();
  return constrained > 0 ? Math.min(constrained, total) : total;
}

/**
 * Pins the image library to its base thread count. Its own default is one thread on glibc Linux, but a deployment that
 * sets `MALLOC_ARENA_MAX` (the way to bound the heap the threads grow) lifts that default to one thread per core for every
 * operation, which made WebP slower; the count is therefore set here, not inherited.
 */
export function pinBaseImageThreads(): number {
  return sharp.concurrency(baseImageThreads());
}

/** Encodes in flight that hold the lease. */
let leases = 0;

/**
 * Runs `encode` with the image library on `imageThreadsFor` threads. The count is process-wide, so concurrent encodes
 * share one lease: the first sets it, the last puts the base count back, whether they end or fail.
 */
export async function withImageThreads<T>(encode: () => Promise<T>): Promise<T> {
  if (leases === 0) sharp.concurrency(imageThreadsFor(os.availableParallelism(), memoryLimitBytes()));
  leases += 1;
  try {
    return await encode();
  } finally {
    leases -= 1;
    if (leases === 0) sharp.concurrency(baseImageThreads());
  }
}
