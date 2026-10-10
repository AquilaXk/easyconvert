import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  ConversionFailedError,
  CorruptStreamError,
  CpuPoolOverloadedError,
  CpuTaskAbortedError,
  CpuTaskTimeoutError,
  DecompressionLimitError,
  EngineUnavailableError,
  PayloadLimitError,
  UnsupportedOptionError,
} from '../types';

/**
 * A bounded pool of worker threads for CPU-bound encoders, so that one large conversion cannot stall the event loop of
 * the web process or the queue worker (health checks, progress updates and uploads share that loop).
 *
 * Tasks are `{ kind, payload }` messages; the worker answers `{ id, ok, result | error }`. Work runs one task per
 * thread. A full queue is a typed 503, a caller's AbortSignal frees the thread at once (the thread is terminated and
 * replaced on demand), and a task past its time limit is terminated and fails with a typed error.
 */

/** Most threads the shared pool starts. */
export const CPU_POOL_MAX = 4;
/** Tasks that may wait for a free thread before further submissions are refused. */
export const CPU_POOL_QUEUE_MAX = 64;
/** A task running longer than this is terminated. */
export const CPU_POOL_TASK_TIMEOUT_MS = 10 * 60 * 1000;
/** Encoders handle inputs smaller than this on the calling thread: starting a task costs more than the work saves. */
export const CPU_POOL_MIN_BYTES = 256 * 1024;
/** The longest a single conversion may occupy the event loop (the budget the routed encoders are tested against). */
export const EVENT_LOOP_BLOCK_BUDGET_MS = 100;
/**
 * A thread that has had no task for this long is stopped, and the pool starts a new one when work comes. An idle thread
 * holds an isolate of tens of megabytes, which every child process the host starts afterwards pays for (fork copies the
 * page tables of everything mapped): a burst of encodes should not leave the process that much slower to start 7-Zip.
 */
export const CPU_POOL_IDLE_MS = 5000;
/** V8 heap ceiling of a pool thread; typed-array payloads live outside the heap and are bounded by their callers. */
const THREAD_HEAP_LIMIT_MB = 1024;
const THREAD_YOUNG_LIMIT_MB = 64;
const WORKER_FILE = 'cpu-worker';
/** Built at run time so the Next.js bundler does not follow it: only the source-mode thread needs tsx. */
const TSX_REGISTER_SPECIFIER = ['tsx', 'cjs', 'api'].join('/');

export type WorkerEntry = { kind: 'compiled'; file: string } | { kind: 'source'; bootstrap: string };

export interface CpuTaskOptions {
  signal?: AbortSignal;
  /** ArrayBuffers handed to the thread instead of copied; the caller must not use them afterwards. */
  transfer?: ArrayBuffer[];
  timeoutMs?: number;
}

export interface CpuPoolOptions {
  size?: number;
  /** Idle time after which a thread is stopped; 0 keeps threads for the life of the pool. */
  idleMs?: number;
  queueMax?: number;
  taskTimeoutMs?: number;
  /** Where the thread code lives; defaults to the bundled or source `cpu-worker` entry. */
  entry?: WorkerEntry | (() => WorkerEntry);
}

interface WorkerFailure {
  name: string;
  message: string;
  status?: number;
}

interface WorkerReply {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: WorkerFailure;
}

interface Task {
  id: number;
  kind: string;
  payload: unknown;
  transfer: ArrayBuffer[];
  timeoutMs: number;
  signal?: AbortSignal;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  onAbort?: () => void;
}

interface Slot {
  worker: Worker;
  task: Task | null;
  timer: NodeJS.Timeout | null;
  /** Stops the thread once it has been idle for the pool's idle time. */
  idleTimer: NodeJS.Timeout | null;
}

/** Typed errors that cross the thread boundary keep their class so that routes map them to the same status. */
const REHYDRATED_ERRORS: ReadonlyMap<string, new (message: string) => Error> = new Map<string, new (message: string) => Error>([
  ['CorruptStreamError', CorruptStreamError],
  ['UnsupportedOptionError', UnsupportedOptionError],
  ['PayloadLimitError', PayloadLimitError],
  ['DecompressionLimitError', DecompressionLimitError],
  ['ConversionFailedError', ConversionFailedError],
]);

function rehydrate(failure: WorkerFailure): Error {
  const Constructor = REHYDRATED_ERRORS.get(failure.name);
  if (Constructor) return new Constructor(failure.message);
  const error = new ConversionFailedError(failure.message);
  error.name = failure.name;
  if (failure.status !== undefined) (error as ConversionFailedError & { status?: number }).status = failure.status;
  return error;
}

/**
 * Finds the thread entry: the bundled `.js` next to this module (worker bundle) or under `dist/` (web server, whose own
 * bundle lives elsewhere), else the TypeScript source when tsx is installed. With neither, the pool is unavailable on
 * this deployment (503), not a bad input.
 */
export function resolveCpuWorkerEntry(): WorkerEntry {
  const compiledCandidates = [path.join(__dirname, `${WORKER_FILE}.js`), path.join(process.cwd(), 'dist', `${WORKER_FILE}.js`)];
  const compiled = compiledCandidates.find((candidate) => fs.existsSync(candidate));
  if (compiled) return { kind: 'compiled', file: compiled };

  const sourceCandidates = [path.join(__dirname, `${WORKER_FILE}.ts`), path.join(process.cwd(), 'src', 'lib', 'workers', `${WORKER_FILE}.ts`)];
  const source = sourceCandidates.find((candidate) => fs.existsSync(candidate));
  let tsxApi: string | null = null;
  try {
    tsxApi = createRequire(path.join(process.cwd(), 'package.json')).resolve(TSX_REGISTER_SPECIFIER);
  } catch {
    tsxApi = null;
  }
  if (source && tsxApi) {
    return { kind: 'source', bootstrap: `require(${JSON.stringify(tsxApi)}).register(); require(${JSON.stringify(source)});` };
  }
  throw new EngineUnavailableError('cpu-pool', `build ${WORKER_FILE}.js with "npm run build:cpu-worker" or install the development dependencies`);
}

/**
 * Starts one thread running the CPU task entry (bundled or from source). The thread does not keep the process alive. Used
 * by the pool and by callers that need a thread they can wait for synchronously.
 */
export function spawnCpuWorker(entry: WorkerEntry = resolveCpuWorkerEntry()): Worker {
  const resourceLimits = { maxOldGenerationSizeMb: THREAD_HEAP_LIMIT_MB, maxYoungGenerationSizeMb: THREAD_YOUNG_LIMIT_MB };
  const worker = entry.kind === 'compiled' ? new Worker(entry.file, { resourceLimits }) : new Worker(entry.bootstrap, { eval: true, resourceLimits });
  worker.unref();
  return worker;
}

function defaultPoolSize(): number {
  return Math.max(1, Math.min(os.availableParallelism() - 1, CPU_POOL_MAX));
}

export class CpuPool {
  private readonly size: number;
  private readonly queueMax: number;
  private readonly taskTimeoutMs: number;
  private readonly idleMs: number;
  private readonly entry: WorkerEntry | (() => WorkerEntry);
  private readonly slots: Slot[] = [];
  private readonly queue: Task[] = [];
  private nextId = 1;
  private closed = false;

  constructor(options: CpuPoolOptions = {}) {
    this.size = options.size ?? defaultPoolSize();
    this.queueMax = options.queueMax ?? CPU_POOL_QUEUE_MAX;
    this.taskTimeoutMs = options.taskTimeoutMs ?? CPU_POOL_TASK_TIMEOUT_MS;
    this.idleMs = options.idleMs ?? CPU_POOL_IDLE_MS;
    this.entry = options.entry ?? resolveCpuWorkerEntry;
  }

  /** The most threads this pool starts. */
  get threadLimit(): number {
    return this.size;
  }

  /** Threads running a task, and tasks waiting for one. */
  get stats(): { threads: number; busy: number; queued: number } {
    return { threads: this.slots.length, busy: this.slots.filter((slot) => slot.task !== null).length, queued: this.queue.length };
  }

  /**
   * Starts threads, without giving them work, until `count` of them (at most the pool's size) are running. A caller that
   * does not want to wait for a thread to start asks for them here and uses the pool from its next request on.
   */
  warm(count: number = this.size): void {
    if (this.closed) return;
    while (this.slots.length < Math.min(count, this.size)) {
      try {
        this.armIdle(this.startWorker());
      } catch {
        return;
      }
    }
  }

  submit<T>(kind: string, payload: unknown, options: CpuTaskOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new EngineUnavailableError('cpu-pool', 'the pool is shut down'));
    if (options.signal?.aborted) return Promise.reject(new CpuTaskAbortedError(kind));
    const idle = this.slots.some((slot) => slot.task === null) || this.slots.length < this.size;
    if (!idle && this.queue.length >= this.queueMax) return Promise.reject(new CpuPoolOverloadedError(this.queue.length, this.queueMax));
    return new Promise<T>((resolve, reject) => {
      const task: Task = {
        id: this.nextId++,
        kind,
        payload,
        transfer: options.transfer ?? [],
        timeoutMs: options.timeoutMs ?? this.taskTimeoutMs,
        signal: options.signal,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      if (options.signal) {
        task.onAbort = (): void => this.abort(task);
        options.signal.addEventListener('abort', task.onAbort, { once: true });
      }
      this.queue.push(task);
      this.dispatch();
    });
  }

  /** Terminates every thread and rejects every task that has not finished. */
  async shutdown(): Promise<void> {
    this.closed = true;
    const pending = this.queue.splice(0);
    for (const task of pending) this.settle(task, () => task.reject(new EngineUnavailableError('cpu-pool', 'the pool is shut down')));
    const slots = this.slots.splice(0);
    await Promise.all(
      slots.map(async (slot) => {
        if (slot.timer) clearTimeout(slot.timer);
        if (slot.idleTimer) clearTimeout(slot.idleTimer);
        if (slot.task) {
          const { task } = slot;
          slot.task = null;
          this.settle(task, () => task.reject(new EngineUnavailableError('cpu-pool', 'the pool is shut down')));
        }
        await slot.worker.terminate();
      })
    );
  }

  private settle(task: Task, action: () => void): void {
    if (task.onAbort && task.signal) task.signal.removeEventListener('abort', task.onAbort);
    action();
  }

  private abort(task: Task): void {
    const queuedAt = this.queue.indexOf(task);
    if (queuedAt >= 0) {
      this.queue.splice(queuedAt, 1);
      this.settle(task, () => task.reject(new CpuTaskAbortedError(task.kind)));
      return;
    }
    const slot = this.slots.find((candidate) => candidate.task === task);
    if (slot) this.retire(slot, () => task.reject(new CpuTaskAbortedError(task.kind)));
  }

  /** Stops a thread that is running `slot.task`, settles that task, and lets the pool start a fresh thread on demand. */
  private retire(slot: Slot, settleTask: () => void): void {
    const { task } = slot;
    if (slot.timer) clearTimeout(slot.timer);
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    slot.timer = null;
    slot.idleTimer = null;
    slot.task = null;
    const at = this.slots.indexOf(slot);
    if (at >= 0) this.slots.splice(at, 1);
    void slot.worker.terminate();
    if (task) this.settle(task, settleTask);
    this.dispatch();
  }

  private startWorker(): Slot {
    const worker = spawnCpuWorker(typeof this.entry === 'function' ? this.entry() : this.entry);
    const slot: Slot = { worker, task: null, timer: null, idleTimer: null };
    worker.on('message', (reply: WorkerReply) => this.onReply(slot, reply));
    worker.on('error', (error: Error & { code?: string }) => {
      if (slot.task) {
        const detail = error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? new PayloadLimitError(`The ${slot.task.kind} task exceeded its memory limit`) : error;
        const { task } = slot;
        this.retire(slot, () => task.reject(detail));
      }
    });
    worker.on('exit', (code) => {
      if (slot.task) {
        const { task } = slot;
        this.retire(slot, () => task.reject(new EngineUnavailableError('cpu-pool', `a worker thread exited unexpectedly (code ${code})`)));
      } else {
        const at = this.slots.indexOf(slot);
        if (at >= 0) this.slots.splice(at, 1);
      }
    });
    this.slots.push(slot);
    return slot;
  }

  private dispatch(): void {
    while (this.queue.length > 0) {
      let slot = this.slots.find((candidate) => candidate.task === null);
      if (!slot && this.slots.length < this.size) {
        try {
          slot = this.startWorker();
        } catch (error) {
          const task = this.queue.shift()!;
          this.settle(task, () => task.reject(error));
          continue;
        }
      }
      if (!slot) return;
      const task = this.queue.shift()!;
      this.run(slot, task);
    }
  }

  /** Arms the timer that stops an idle thread. */
  private armIdle(slot: Slot): void {
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    slot.idleTimer = null;
    if (this.idleMs <= 0) return;
    slot.idleTimer = setTimeout(() => {
      slot.idleTimer = null;
      if (slot.task === null) this.retire(slot, () => undefined);
    }, this.idleMs);
    slot.idleTimer.unref();
  }

  private run(slot: Slot, task: Task): void {
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    slot.idleTimer = null;
    slot.task = task;
    slot.timer = setTimeout(() => this.retire(slot, () => task.reject(new CpuTaskTimeoutError(task.kind, task.timeoutMs))), task.timeoutMs);
    slot.timer.unref();
    try {
      slot.worker.postMessage({ id: task.id, kind: task.kind, payload: task.payload }, task.transfer);
    } catch (error) {
      this.retire(slot, () => task.reject(error));
    }
  }

  private onReply(slot: Slot, reply: WorkerReply): void {
    const task = slot.task;
    if (!task || task.id !== reply.id) return;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.task = null;
    this.armIdle(slot);
    this.settle(task, () => (reply.ok ? task.resolve(reply.result) : task.reject(rehydrate(reply.error!))));
    this.dispatch();
  }
}

/** Lets the event loop run its pending timers and I/O before the caller continues. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Largest slice copied between two turns of the event loop: a few milliseconds of memcpy and page faults. */
const COPY_SLICE_BYTES = 4 * 1024 * 1024;

/**
 * A copy of `source` made a slice at a time, yielding to the event loop between slices, so that duplicating a large
 * array for a pool thread does not itself stall the loop. The copy gets its own ArrayBuffer (or the given one).
 */
export async function copyYielding<T extends Uint8Array | Uint16Array>(source: T, target?: T): Promise<T> {
  const copy = target ?? (new (source.constructor as new (length: number) => T)(source.length));
  const sliceLength = Math.max(1, Math.floor(COPY_SLICE_BYTES / source.BYTES_PER_ELEMENT));
  for (let at = 0; at < source.length; at += sliceLength) {
    copy.set(source.subarray(at, at + sliceLength) as never, at);
    if (at + sliceLength < source.length) await yieldToEventLoop();
  }
  return copy;
}

/** The bytes in memory every pool thread can read without a copy; an input that is already shared is returned as is. */
export async function shareBytes(source: Uint8Array): Promise<Uint8Array> {
  if (source.buffer instanceof SharedArrayBuffer) return source;
  return copyYielding<Uint8Array>(source, new Uint8Array(new SharedArrayBuffer(source.length)));
}

let sharedPool: CpuPool | null = null;

/** The process-wide pool the encoders submit to; started on first use. */
export function getCpuPool(): CpuPool {
  sharedPool ??= new CpuPool();
  return sharedPool;
}

/** Runs one task on the shared pool. */
export function runCpuTask<T>(kind: string, payload: unknown, options: CpuTaskOptions = {}): Promise<T> {
  return getCpuPool().submit<T>(kind, payload, options);
}

/** Stops the shared pool's threads (tests and graceful shutdown); a later task starts a new pool. */
export async function shutdownCpuPool(): Promise<void> {
  const pool = sharedPool;
  sharedPool = null;
  if (pool) await pool.shutdown();
}
