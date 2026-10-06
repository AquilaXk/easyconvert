import type { Worker as TesseractWorker } from 'tesseract.js';
import { OcrEngineUnavailableError } from '../types';

/** Workers kept per language set. Each holds a WebAssembly heap of roughly 100-300 MB. */
export const OCR_POOL_MAX_WORKERS_PER_KEY = 2;
/** Workers kept across all language sets; the least recently idle one is evicted for another set. */
export const OCR_POOL_MAX_WORKERS_TOTAL = 4;
/** An idle worker is terminated after this long without a job. */
export const OCR_POOL_IDLE_TTL_MS = 60_000;
/** Jobs allowed to queue for a free worker before further requests are rejected. */
export const OCR_POOL_MAX_WAITERS = 64;
/** A worker is replaced after this many jobs to bound WebAssembly heap growth. */
export const OCR_POOL_MAX_JOBS_PER_WORKER = 100;
/** A job that has not finished in this time is failed and its worker discarded. */
export const OCR_POOL_JOB_TIMEOUT_MS = 120_000;

export type OcrRecognizeResult = Awaited<ReturnType<TesseractWorker['recognize']>>;
export type OcrRecognizeFn = TesseractWorker['recognize'];

/** The subset of a Tesseract worker the pool relies on. */
export interface OcrPooledWorker {
  setParameters(params: Record<string, string>): Promise<unknown>;
  recognize: OcrRecognizeFn;
  terminate(): Promise<unknown>;
  /** The underlying thread, when available; it is ref'd only while a job runs. */
  worker?: { ref?: () => void; unref?: () => void };
}

/** Set by the worker's error handler; a failed worker is never handed out again. */
export interface OcrWorkerHealth {
  failed: boolean;
}

export interface OcrWorkerSpec {
  /** Tesseract language set, e.g. `eng` or `eng+deu`. */
  langs: string;
  langPath: string;
  gzip: boolean;
  engineMode: number;
  /** Applied to the worker before every job so settings never leak between requests. */
  parameters: Record<string, string>;
}

export interface OcrWorkerPoolOptions {
  maxWorkersPerKey?: number;
  maxWorkersTotal?: number;
  idleTtlMs?: number;
  maxWaiters?: number;
  maxJobsPerWorker?: number;
  jobTimeoutMs?: number;
}

interface PoolEntry {
  key: string;
  worker: OcrPooledWorker;
  health: OcrWorkerHealth;
  jobs: number;
  busy: boolean;
  idleTimer: NodeJS.Timeout | null;
  abort: ((reason: Error) => void) | null;
}

function keyFor(spec: OcrWorkerSpec): string {
  return JSON.stringify([spec.langs, spec.langPath, spec.gzip, spec.engineMode]);
}

/**
 * Bounded pool of Tesseract workers, one set per language configuration. Jobs only see a
 * `recognize` function: parameters come from the spec and are re-applied before every job, so no
 * request can change another request's settings. A worker that fails, times out or hangs is
 * terminated and replaced lazily.
 */
export class OcrWorkerPool {
  readonly limits: Required<OcrWorkerPoolOptions>;
  private readonly entries = new Set<PoolEntry>();
  private readonly creating = new Map<string, number>();
  private waiters: Array<() => void> = [];
  private closing = false;

  constructor(options: OcrWorkerPoolOptions = {}) {
    this.limits = {
      maxWorkersPerKey: options.maxWorkersPerKey ?? OCR_POOL_MAX_WORKERS_PER_KEY,
      maxWorkersTotal: options.maxWorkersTotal ?? OCR_POOL_MAX_WORKERS_TOTAL,
      idleTtlMs: options.idleTtlMs ?? OCR_POOL_IDLE_TTL_MS,
      maxWaiters: options.maxWaiters ?? OCR_POOL_MAX_WAITERS,
      maxJobsPerWorker: options.maxJobsPerWorker ?? OCR_POOL_MAX_JOBS_PER_WORKER,
      jobTimeoutMs: options.jobTimeoutMs ?? OCR_POOL_JOB_TIMEOUT_MS,
    };
  }

  /** Live workers, including those still starting. */
  get size(): number {
    let starting = 0;
    for (const count of this.creating.values()) starting += count;
    return this.entries.size + starting;
  }

  /** Starts one worker. Overridable seam: tests wrap or replace it to count creations. */
  async createWorker(spec: OcrWorkerSpec, health: OcrWorkerHealth): Promise<OcrPooledWorker> {
    const Tesseract = await import('tesseract.js');
    const worker = await Tesseract.createWorker(spec.langs, spec.engineMode, {
      langPath: spec.langPath,
      cacheMethod: 'none',
      gzip: spec.gzip,
      // A worker failure already rejects the pending job; without a handler it is also rethrown
      // from the message listener as an uncaught exception. The pool retires the worker instead.
      errorHandler: () => {
        health.failed = true;
      },
    });
    return worker as unknown as OcrPooledWorker;
  }

  async run<T>(spec: OcrWorkerSpec, job: (recognize: OcrRecognizeFn) => Promise<T>): Promise<T> {
    const entry = await this.acquire(spec);
    if (!this.entries.has(entry)) {
      // A shutdown retired the worker between hand-out and start.
      throw new OcrEngineUnavailableError('The OCR worker pool was shut down.');
    }
    let aborted: ((reason: Error) => void) | null = null;
    const interrupted = new Promise<never>((_, reject) => {
      aborted = reject;
    });
    entry.abort = aborted;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new OcrEngineUnavailableError(`OCR job exceeded ${this.limits.jobTimeoutMs} ms.`)),
        this.limits.jobTimeoutMs
      );
    });
    try {
      const outcome = await Promise.race([this.execute(entry, spec, job), interrupted, timedOut]);
      this.release(entry);
      return outcome;
    } catch (err) {
      await this.discard(entry);
      throw err;
    } finally {
      clearTimeout(timer);
      entry.abort = null;
    }
  }

  /** Terminates every worker, fails queued and running jobs, and leaves the pool reusable. */
  async shutdown(): Promise<void> {
    this.closing = true;
    try {
      const shutdownError = new OcrEngineUnavailableError('The OCR worker pool was shut down.');
      const woken = this.waiters;
      this.waiters = [];
      for (const wake of woken) wake();
      const live = [...this.entries];
      for (const entry of live) entry.abort?.(shutdownError);
      await Promise.all(live.map((entry) => this.discard(entry)));
      // Workers still starting are terminated by acquire() once creation settles.
      while (this.creating.size > 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    } finally {
      this.closing = false;
    }
  }

  private async execute<T>(
    entry: PoolEntry,
    spec: OcrWorkerSpec,
    job: (recognize: OcrRecognizeFn) => Promise<T>
  ): Promise<T> {
    await entry.worker.setParameters(spec.parameters);
    return job((image, options, output, jobId) => entry.worker.recognize(image, options, output, jobId));
  }

  private async acquire(spec: OcrWorkerSpec): Promise<PoolEntry> {
    const key = keyFor(spec);
    let queued = false;
    for (;;) {
      if (this.closing) {
        throw new OcrEngineUnavailableError('The OCR worker pool is shutting down.');
      }
      const idle = this.takeIdle(key);
      if (idle) return idle;

      if (this.countFor(key) < this.limits.maxWorkersPerKey) {
        if (this.size >= this.limits.maxWorkersTotal) {
          const victim = this.findIdleOtherKey(key);
          if (victim) await this.discard(victim);
        }
        if (this.size < this.limits.maxWorkersTotal) {
          return this.startEntry(key, spec);
        }
      }

      if (!queued && this.waiters.length >= this.limits.maxWaiters) {
        throw new OcrEngineUnavailableError(
          `OCR is saturated: ${this.limits.maxWaiters} jobs are already waiting for a worker.`
        );
      }
      queued = true;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private async startEntry(key: string, spec: OcrWorkerSpec): Promise<PoolEntry> {
    this.creating.set(key, (this.creating.get(key) ?? 0) + 1);
    const health: OcrWorkerHealth = { failed: false };
    try {
      const worker = await this.createWorker(spec, health);
      const entry: PoolEntry = { key, worker, health, jobs: 0, busy: true, idleTimer: null, abort: null };
      if (this.closing) {
        await this.terminateQuietly(worker);
        throw new OcrEngineUnavailableError('The OCR worker pool is shutting down.');
      }
      this.entries.add(entry);
      entry.worker.worker?.ref?.();
      return entry;
    } finally {
      const remaining = (this.creating.get(key) ?? 1) - 1;
      if (remaining > 0) this.creating.set(key, remaining);
      else this.creating.delete(key);
      this.wake();
    }
  }

  private takeIdle(key: string): PoolEntry | undefined {
    for (const entry of this.entries) {
      if (entry.key !== key || entry.busy) continue;
      if (entry.health.failed) {
        void this.discard(entry);
        continue;
      }
      this.clearIdleTimer(entry);
      entry.busy = true;
      entry.worker.worker?.ref?.();
      return entry;
    }
    return undefined;
  }

  private findIdleOtherKey(key: string): PoolEntry | undefined {
    for (const entry of this.entries) {
      if (entry.key !== key && !entry.busy) return entry;
    }
    return undefined;
  }

  private countFor(key: string): number {
    let count = this.creating.get(key) ?? 0;
    for (const entry of this.entries) {
      if (entry.key === key) count++;
    }
    return count;
  }

  private release(entry: PoolEntry): void {
    entry.jobs++;
    if (entry.health.failed || entry.jobs >= this.limits.maxJobsPerWorker || this.closing) {
      void this.discard(entry);
      return;
    }
    entry.busy = false;
    // An idle thread must not keep the process alive.
    entry.worker.worker?.unref?.();
    this.clearIdleTimer(entry);
    entry.idleTimer = setTimeout(() => void this.discard(entry), this.limits.idleTtlMs);
    entry.idleTimer.unref();
    this.wake();
  }

  private async discard(entry: PoolEntry): Promise<void> {
    this.clearIdleTimer(entry);
    const known = this.entries.delete(entry);
    if (known) await this.terminateQuietly(entry.worker);
    this.wake();
  }

  private async terminateQuietly(worker: OcrPooledWorker): Promise<void> {
    try {
      await worker.terminate();
    } catch {
      // The worker is already gone; nothing else holds it.
    }
  }

  private clearIdleTimer(entry: PoolEntry): void {
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  private wake(): void {
    const woken = this.waiters;
    this.waiters = [];
    for (const resolve of woken) resolve();
  }
}

let sharedPool: OcrWorkerPool | null = null;

/** Process-wide pool used by `performOcr`. */
export function getSharedOcrWorkerPool(): OcrWorkerPool {
  sharedPool ??= new OcrWorkerPool();
  return sharedPool;
}

/** Terminates every pooled worker. Safe to call repeatedly; the pool restarts workers on demand. */
export async function shutdownSharedOcrWorkerPool(): Promise<void> {
  if (sharedPool) await sharedPool.shutdown();
}
