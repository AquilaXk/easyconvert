import type { Worker } from 'node:worker_threads';
import { ConversionFailedError, CpuTaskTimeoutError } from '../types';
import { spawnCpuWorker } from '../workers/cpu-pool';
import {
  DEMOSAIC_CONTROL_DONE,
  DEMOSAIC_CONTROL_ERROR_LENGTH,
  DEMOSAIC_CONTROL_FAILED,
  DEMOSAIC_CONTROL_LENGTH,
  DEMOSAIC_ERROR_TEXT_BYTES,
  type DemosaicTilesPayload,
  type TileJob,
} from './raw-demosaic-tiles';

/**
 * Runs the tile rows of a demosaic frame on worker threads and waits for them. The demosaic functions are synchronous
 * (the RAW pipeline above them is, and runs on a worker thread of its own in production), so the caller blocks on a
 * shared counter with Atomics.wait while the tile threads work, instead of returning to an event loop.
 *
 * Tiles are independent, and each thread takes the rows r with r mod threads equal to its index: the split depends only
 * on the thread count, never on timing. The sensor samples, the output buffers and the whole-frame planes are shared
 * memory (SharedArrayBuffer) that the threads read and write in place; nothing is copied back.
 */

/** Longest the caller waits for the tile threads before it gives up on them (a very large frame at a very slow rate). */
export const DEMOSAIC_THREADS_TIMEOUT_MS = 10 * 60 * 1000;
/** One wait on the counter; short enough to notice the deadline, long enough not to spin. */
const WAIT_SLICE_MS = 200;
const INT32_BYTES = Int32Array.BYTES_PER_ELEMENT;

let threads: Worker[] = [];
let nextMessageId = 1;

/**
 * Threads are kept between frames (starting one costs tens of milliseconds). They never keep the process alive: they are
 * unreferenced and no message listener is attached (a tile task sends no reply; the counter in shared memory is the signal).
 */
function acquireThreads(count: number): Worker[] {
  while (threads.length < count) {
    const thread = spawnCpuWorker();
    const forget = (): void => {
      threads = threads.filter((candidate) => candidate !== thread);
    };
    thread.on('error', forget);
    thread.on('exit', forget);
    threads.push(thread);
  }
  return threads.slice(0, count);
}

function discardThreads(): void {
  const doomed = threads;
  threads = [];
  for (const thread of doomed) void thread.terminate();
}

/**
 * Computes every tile row of `job` on `count` threads and returns when all are done. Throws a ConversionFailedError when a
 * thread failed, a CpuTaskTimeoutError after DEMOSAIC_THREADS_TIMEOUT_MS, and the pool's EngineUnavailableError when no
 * thread entry exists on this deployment.
 */
export function runTilesOnThreads(job: TileJob, count: number): void {
  const control = new Int32Array(new SharedArrayBuffer(DEMOSAIC_CONTROL_LENGTH * INT32_BYTES));
  const errorText = new Uint8Array(new SharedArrayBuffer(DEMOSAIC_ERROR_TEXT_BYTES));
  const workers = acquireThreads(count);
  workers.forEach((thread, index) => {
    const payload: DemosaicTilesPayload = { job, firstRow: index, step: count, control, errorText };
    thread.postMessage({ id: nextMessageId++, kind: 'demosaicTiles', payload });
  });

  const deadline = Date.now() + DEMOSAIC_THREADS_TIMEOUT_MS;
  for (;;) {
    const done = Atomics.load(control, DEMOSAIC_CONTROL_DONE);
    if (done >= count) break;
    if (Date.now() >= deadline) {
      discardThreads();
      throw new CpuTaskTimeoutError('demosaicTiles', DEMOSAIC_THREADS_TIMEOUT_MS);
    }
    Atomics.wait(control, DEMOSAIC_CONTROL_DONE, done, WAIT_SLICE_MS);
  }
  if (Atomics.load(control, DEMOSAIC_CONTROL_FAILED) > 0) {
    const length = Atomics.load(control, DEMOSAIC_CONTROL_ERROR_LENGTH);
    const message = new TextDecoder().decode(errorText.slice(0, length));
    throw new ConversionFailedError(`A demosaic tile thread failed: ${message}`);
  }
}

/** Stops the kept threads (tests and shutdown); a later frame starts new ones. */
export function shutdownDemosaicThreads(): void {
  discardThreads();
}
