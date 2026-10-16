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

/**
 * Threads a JPEG pipeline leases. A second thread lets the conversion of the 16-bit samples (the reduction to 8 bits, the dropped alpha
 * plane) overlap the JPEG encoder: the JPEG stage of a 1024 x 640 interface went from 4.2 ms to 3.7 ms and of a 640 x 640 grey drawing from 3.7 ms to 3.6 ms, with the
 * same bytes. A WebP pipeline does not take the lease: its encode of a colour picture or of a grey photograph got 2 to 16% slower on two threads
 * (a 768 x 512 photograph 17.3 ms to 20.3 ms), and only a grey drawing with an alpha plane gained. More threads make the pipeline of a
 * picture this small slower, as the lease of a photograph in AVIF says above; two is the count `IMAGE_UNBOUNDED_HEAP_THREADS` allows while
 * the heap is not bounded.
 */
export const IMAGE_PIPELINE_THREADS = 2;

/**
 * Threads for a JPEG pipeline: `IMAGE_PIPELINE_THREADS` where the cores, the heap and the memory limit allow them (see
 * `imageThreadsFor`), never fewer than the base count, which an operator's `VIPS_CONCURRENCY` sets for every operation.
 */
export function pipelineThreadsFor(cores: number, memoryBytes: number = Number.POSITIVE_INFINITY, env: Env = process.env): number {
  return Math.max(baseImageThreads(env), Math.min(IMAGE_PIPELINE_THREADS, imageThreadsFor(cores, memoryBytes, env)));
}

/** Encodes in flight that hold the lease, and the largest count any of them asked for. */
let leases = 0;
let leasedThreads = 0;

/**
 * Runs `encode` with the image library on `threads` threads (`imageThreadsFor` unless the caller names a count). The count is process-wide,
 * so concurrent encodes share it: a lease that asks for more raises it for all, the last to end puts the base count back, whether they
 * end or fail.
 */
export async function withImageThreads<T>(encode: () => Promise<T>, threads: number = imageThreadsFor(os.availableParallelism(), memoryLimitBytes())): Promise<T> {
  if (threads > leasedThreads) {
    sharp.concurrency(threads);
    leasedThreads = threads;
  }
  leases += 1;
  try {
    return await encode();
  } finally {
    leases -= 1;
    if (leases === 0) {
      leasedThreads = 0;
      sharp.concurrency(baseImageThreads());
    }
  }
}

/** `withImageThreads` for the pipeline of a JPEG encode. */
export function withPipelineThreads<T>(encode: () => Promise<T>): Promise<T> {
  return withImageThreads(encode, pipelineThreadsFor(os.availableParallelism(), memoryLimitBytes()));
}
