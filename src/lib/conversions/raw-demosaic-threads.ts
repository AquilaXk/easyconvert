import type { Worker } from 'node:worker_threads';
import { ConversionFailedError, CpuTaskTimeoutError } from '../types';
import { resolveCpuWorkerEntry, spawnCpuWorker, type WorkerEntry } from '../workers/cpu-pool';
import {
  DEMOSAIC_CONTROL_DONE,
  DEMOSAIC_CONTROL_ERROR_LENGTH,
  DEMOSAIC_CONTROL_FAILED,
  DEMOSAIC_CONTROL_LENGTH,
  DEMOSAIC_ERROR_TEXT_BYTES,
  recordDemosaicFailure,
  type DemosaicTilesPayload,
  type TileJob,
} from './raw-demosaic-tiles';

/**
 * Runs the tile rows of a demosaic frame on worker threads and waits for them. The demosaic functions are synchronous
 * (the RAW pipeline above them is, and runs on a worker thread of its own in production), so the caller blocks on a
 * shared counter with Atomics.wait while a dedicated non-blocking supervisor worker leases tile threads and monitors
 * their 'exit'/'error' events on a live event loop.
 */

/** Longest the caller waits for the tile threads before it gives up on them (a very large frame at a very slow rate). */
export const DEMOSAIC_THREADS_TIMEOUT_MS = 10 * 60 * 1000;
/** One wait on the counter; short enough to notice the deadline, long enough not to spin. */
const WAIT_SLICE_MS = 200;
const SUPERVISOR_TERMINATE_GRACE_MS = 50;
const INT32_BYTES = Int32Array.BYTES_PER_ELEMENT;

export interface DemosaicDispatchPayload {
  job: TileJob;
  count: number;
  control: Int32Array;
  errorText: Uint8Array;
  tileEntry: WorkerEntry;
}

interface InFlightDispatch {
  control: Int32Array;
  errorText: Uint8Array;
  count: number;
}

let supervisor: Worker | null = null;
let nextMessageId = 1;

// Supervisor-side state (used only inside the supervisor worker thread).
const idleTileWorkers = new Map<string, Worker[]>();
const idleDetach = new WeakMap<Worker, () => void>();
const inFlightDispatches = new Set<InFlightDispatch>();
let supervisorExitHookInstalled = false;

function entryCacheKey(entry: WorkerEntry): string {
  return entry.kind === 'compiled' ? `c:${entry.file}` : `s:${entry.bootstrap}`;
}

function installSupervisorExitHook(): void {
  if (supervisorExitHookInstalled) return;
  supervisorExitHookInstalled = true;
  process.once('exit', (code) => {
    for (const item of inFlightDispatches) {
      recordDemosaicFailure(item.control, item.errorText, `demosaic supervisor exited unexpectedly (code ${code})`);
      Atomics.store(item.control, DEMOSAIC_CONTROL_DONE, item.count);
      Atomics.notify(item.control, DEMOSAIC_CONTROL_DONE);
    }
    inFlightDispatches.clear();
  });
}

function pushIdleTileWorker(key: string, worker: Worker): void {
  let bucket = idleTileWorkers.get(key);
  if (!bucket) {
    bucket = [];
    idleTileWorkers.set(key, bucket);
  }
  const removeIdle = (): void => {
    const list = idleTileWorkers.get(key);
    if (!list) return;
    const idx = list.indexOf(worker);
    if (idx !== -1) list.splice(idx, 1);
  };
  worker.on('exit', removeIdle);
  worker.on('error', removeIdle);
  idleDetach.set(worker, () => {
    worker.off('exit', removeIdle);
    worker.off('error', removeIdle);
  });
  bucket.push(worker);
}

function leaseTileWorkers(entry: WorkerEntry, count: number): { key: string; leased: Worker[] } {
  const key = entryCacheKey(entry);
  const bucket = idleTileWorkers.get(key);
  const leased: Worker[] = [];
  while (leased.length < count && bucket && bucket.length > 0) {
    const existing = bucket.pop()!;
    idleDetach.get(existing)?.();
    idleDetach.delete(existing);
    if (existing.threadId >= 0) {
      leased.push(existing);
    }
  }
  while (leased.length < count) {
    leased.push(spawnCpuWorker(entry));
  }
  return { key, leased };
}

/** Runs on the non-blocking supervisor worker: leases exclusive tile workers, watches crashes, and returns healthy ones. */
export function dispatchDemosaicOnSupervisor(payload: DemosaicDispatchPayload): void {
  installSupervisorExitHook();
  const { job, count, control, errorText, tileEntry } = payload;
  const inFlight: InFlightDispatch = { control, errorText, count };
  inFlightDispatches.add(inFlight);

  let key = '';
  let leased: Worker[] = [];
  try {
    ({ key, leased } = leaseTileWorkers(tileEntry, count));
  } catch (err) {
    inFlightDispatches.delete(inFlight);
    recordDemosaicFailure(control, errorText, err instanceof Error ? err.message : String(err));
    Atomics.store(control, DEMOSAIC_CONTROL_DONE, count);
    Atomics.notify(control, DEMOSAIC_CONTROL_DONE);
    return;
  }

  let settled = false;
  const unhealthy = new Set<Worker>();
  const detachJobListeners: Array<() => void> = [];

  const finishDispatch = (terminateAll: boolean): void => {
    if (settled) return;
    settled = true;
    inFlightDispatches.delete(inFlight);
    for (const detach of detachJobListeners) detach();
    detachJobListeners.length = 0;
    for (const worker of leased) {
      if (terminateAll || unhealthy.has(worker) || worker.threadId < 0) {
        void worker.terminate();
      } else {
        pushIdleTileWorker(key, worker);
      }
    }
  };

  const failFromWorker = (worker: Worker, reason: string): void => {
    unhealthy.add(worker);
    if (settled) return;
    if (Atomics.load(control, DEMOSAIC_CONTROL_DONE) >= count) return;
    recordDemosaicFailure(control, errorText, reason);
    Atomics.store(control, DEMOSAIC_CONTROL_DONE, count);
    Atomics.notify(control, DEMOSAIC_CONTROL_DONE);
    finishDispatch(true);
  };

  for (const worker of leased) {
    const onExit = (code: number): void => {
      failFromWorker(worker, `tile worker exited unexpectedly (code ${code})`);
    };
    const onError = (err: Error): void => {
      failFromWorker(worker, `tile worker error: ${err.message}`);
    };
    worker.on('exit', onExit);
    worker.on('error', onError);
    detachJobListeners.push(() => {
      worker.off('exit', onExit);
      worker.off('error', onError);
    });
  }

  const monitorCompletion = (): void => {
    if (settled) return;
    const done = Atomics.load(control, DEMOSAIC_CONTROL_DONE);
    if (done >= count) {
      finishDispatch(false);
      return;
    }
    const waited = Atomics.waitAsync(control, DEMOSAIC_CONTROL_DONE, done);
    if (!waited.async) {
      monitorCompletion();
      return;
    }
    void waited.value.then(monitorCompletion);
  };

  for (let index = 0; index < leased.length; index++) {
    const worker = leased[index]!;
    const tilePayload: DemosaicTilesPayload = { job, firstRow: index, step: count, control, errorText };
    try {
      worker.postMessage({ id: nextMessageId++, kind: 'demosaicTiles', payload: tilePayload });
    } catch (err) {
      failFromWorker(worker, err instanceof Error ? err.message : String(err));
      return;
    }
  }

  monitorCompletion();
}

/** Terminates all idle tile workers owned by the supervisor thread. */
export function shutdownSupervisedTilePool(): void {
  for (const bucket of idleTileWorkers.values()) {
    for (const worker of bucket) {
      idleDetach.get(worker)?.();
      idleDetach.delete(worker);
      void worker.terminate();
    }
  }
  idleTileWorkers.clear();
}

function acquireSupervisor(entry: WorkerEntry): Worker {
  if (supervisor !== null && supervisor.threadId >= 0) return supervisor;
  const worker = spawnCpuWorker(entry);
  const forget = (): void => {
    if (supervisor === worker) supervisor = null;
  };
  worker.on('error', forget);
  worker.on('exit', forget);
  supervisor = worker;
  return worker;
}

function discardSupervisor(terminateNow: boolean): void {
  const doomed = supervisor;
  supervisor = null;
  if (!doomed) return;
  if (terminateNow) {
    void doomed.terminate();
    return;
  }
  try {
    doomed.postMessage({ id: nextMessageId++, kind: 'demosaicShutdown', payload: null });
  } catch {
    void doomed.terminate();
    return;
  }
  setTimeout(() => {
    void doomed.terminate();
  }, SUPERVISOR_TERMINATE_GRACE_MS).unref();
}

/**
 * Computes every tile row of `job` on `count` threads and returns when all are done. Throws a ConversionFailedError when a
 * thread failed or exited abruptly, a CpuTaskTimeoutError after DEMOSAIC_THREADS_TIMEOUT_MS, and the pool's
 * EngineUnavailableError when no thread entry exists on this deployment.
 */
export function runTilesOnThreads(job: TileJob, count: number, tileEntry?: WorkerEntry): void {
  const supervisorEntry = resolveCpuWorkerEntry();
  const control = new Int32Array(new SharedArrayBuffer(DEMOSAIC_CONTROL_LENGTH * INT32_BYTES));
  const errorText = new Uint8Array(new SharedArrayBuffer(DEMOSAIC_ERROR_TEXT_BYTES));
  const sup = acquireSupervisor(supervisorEntry);
  const dispatchPayload: DemosaicDispatchPayload = {
    job,
    count,
    control,
    errorText,
    tileEntry: tileEntry ?? supervisorEntry,
  };
  sup.postMessage({ id: nextMessageId++, kind: 'demosaicDispatch', payload: dispatchPayload });

  const deadline = Date.now() + DEMOSAIC_THREADS_TIMEOUT_MS;
  for (;;) {
    const done = Atomics.load(control, DEMOSAIC_CONTROL_DONE);
    if (done >= count) break;
    if (sup.threadId < 0) {
      discardSupervisor(true);
      recordDemosaicFailure(control, errorText, 'demosaic supervisor exited unexpectedly');
      break;
    }
    if (Date.now() >= deadline) {
      discardSupervisor(true);
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

/** Stops the supervisor and its pooled tile threads (tests and shutdown); a later frame starts new ones. */
export function shutdownDemosaicThreads(): void {
  discardSupervisor(false);
}
