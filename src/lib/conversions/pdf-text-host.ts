import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { EngineUnavailableError } from '../types';
import {
  PDF_TEXT_DEADLINE_ENV,
  PDF_TEXT_DEADLINE_MS,
  PdfTextGeometryError,
  pdfTextFailure,
  type PdfTextFailureKind,
  type PdfTextJob,
  type PdfTextJobResult,
} from './pdf-text-types';

/**
 * Runs a PDF text job (see pdf-text-geometry.ts) on a worker thread with a wall-clock deadline, so a document that
 * makes pdfjs run for ever is stopped by terminating the thread rather than blocking the process. The thread runs
 * the bundled `pdf-text-worker.js` next to this module or under `dist/`, otherwise the TypeScript source through
 * tsx; with neither available the engine is reported unavailable rather than reading the document in this thread
 * without a deadline.
 *
 * Threads are kept between jobs (up to POOL_LIMIT of them, one job at a time each) because loading pdfjs costs far
 * more than reading a page. A thread is retired after RECYCLE_AFTER_JOBS jobs, after IDLE_MS without work, and as
 * soon as a job overruns its deadline, runs it out of memory or kills it, so a hostile document never leaves a
 * damaged thread behind. An idle thread does not keep the process alive.
 *
 * Failures are typed by whose fault they are. A document that overruns the deadline, exhausts the thread's memory or
 * is rejected by the reader is a PdfTextGeometryError (400), or the typed error the thread names (an encrypted
 * document, a document with too many pages). A thread that cannot be started, dies on its own, or has no entry is
 * the service's: an EngineUnavailableError (503).
 */

/** V8 heap ceiling of an extraction thread. */
const THREAD_HEAP_LIMIT_MB = 1024;
const THREAD_YOUNG_LIMIT_MB = 64;
const WORKER_FILE = 'pdf-text-worker';
/** Name the unavailable-engine error carries. */
const ENGINE_NAME = 'pdf-text-thread';
/** Built at run time so the Next.js bundler does not follow it: only the source-mode thread needs tsx. */
const TSX_REGISTER_SPECIFIER = ['tsx', 'cjs', 'api'].join('/');
/** Most threads at once; further jobs wait for one. */
const MAX_POOL = 4;
/** A thread that has read this many documents is replaced, which bounds what a leak in the reader can accumulate. */
const RECYCLE_AFTER_JOBS = 100;
/** A thread idle this long is stopped. */
const IDLE_MS = 15_000;

type WorkerEntry = { kind: 'compiled'; file: string } | { kind: 'source'; bootstrap: string };

interface WorkerReply {
  ok: boolean;
  result?: PdfTextJobResult;
  message?: string;
  kind?: PdfTextFailureKind;
}

interface ActiveJob {
  resolve(result: PdfTextJobResult): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
}

interface PooledThread {
  worker: Worker;
  active: ActiveJob | null;
  jobs: number;
  idleTimer: NodeJS.Timeout | null;
}

interface QueuedJob {
  bytes: Uint8Array;
  job: PdfTextJob;
  resolve(result: PdfTextJobResult): void;
  reject(error: unknown): void;
}

/** The deadline in milliseconds: the environment override when it is a positive integer, otherwise the default. */
export function pdfTextDeadlineMs(): number {
  const override = Number(process.env[PDF_TEXT_DEADLINE_ENV]);
  return Number.isInteger(override) && override > 0 ? override : PDF_TEXT_DEADLINE_MS;
}

function poolLimit(): number {
  return Math.max(1, Math.min(MAX_POOL, os.availableParallelism()));
}

function resolveWorkerEntry(): WorkerEntry {
  const compiledCandidates = [path.join(__dirname, `${WORKER_FILE}.js`), path.join(process.cwd(), 'dist', `${WORKER_FILE}.js`)];
  const compiled = compiledCandidates.find((candidate) => fs.existsSync(candidate));
  if (compiled) return { kind: 'compiled', file: compiled };

  const sourceCandidates = [
    path.join(__dirname, `${WORKER_FILE}.ts`),
    path.join(process.cwd(), 'src', 'lib', 'conversions', `${WORKER_FILE}.ts`),
  ];
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
  throw new EngineUnavailableError(
    ENGINE_NAME,
    `build ${WORKER_FILE}.js with "npm run build:pdf-text-worker" or install the development dependencies`
  );
}

function startWorker(entry: WorkerEntry): Worker {
  const resourceLimits = { maxOldGenerationSizeMb: THREAD_HEAP_LIMIT_MB, maxYoungGenerationSizeMb: THREAD_YOUNG_LIMIT_MB };
  try {
    if (entry.kind === 'compiled') return new Worker(entry.file, { resourceLimits });
    return new Worker(entry.bootstrap, { eval: true, resourceLimits });
  } catch (error) {
    throw new EngineUnavailableError(ENGINE_NAME, `the thread could not be started: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The error for a failure the thread reported through its `error` event. */
function threadFailure(error: Error & { code?: string }): Error {
  if (error.code === 'ERR_WORKER_OUT_OF_MEMORY') return new PdfTextGeometryError('PDF text extraction exceeded its memory limit.');
  return new EngineUnavailableError(ENGINE_NAME, `the thread failed: ${error.message}`);
}

const threads = new Set<PooledThread>();
const idleThreads: PooledThread[] = [];
const queue: QueuedJob[] = [];

function retire(thread: PooledThread): void {
  if (thread.idleTimer) clearTimeout(thread.idleTimer);
  thread.idleTimer = null;
  threads.delete(thread);
  const at = idleThreads.indexOf(thread);
  if (at >= 0) idleThreads.splice(at, 1);
  void thread.worker.terminate();
}

function settle(thread: PooledThread, action: (job: ActiveJob) => void): void {
  const job = thread.active;
  if (!job) return;
  thread.active = null;
  clearTimeout(job.timer);
  action(job);
}

function release(thread: PooledThread): void {
  thread.jobs++;
  if (thread.jobs >= RECYCLE_AFTER_JOBS) {
    retire(thread);
  } else {
    // An idle thread must not keep the process alive.
    thread.worker.unref?.();
    thread.idleTimer = setTimeout(() => retire(thread), IDLE_MS);
    thread.idleTimer.unref?.();
    idleThreads.push(thread);
  }
  startQueued();
}

function createThread(): PooledThread {
  const worker = startWorker(resolveWorkerEntry());
  const thread: PooledThread = { worker, active: null, jobs: 0, idleTimer: null };
  worker.once('error', (error: Error & { code?: string }) => {
    const failure = threadFailure(error);
    retire(thread);
    settle(thread, (job) => job.reject(failure));
    startQueued();
  });
  worker.once('exit', (code) => {
    retire(thread);
    settle(thread, (job) => job.reject(new EngineUnavailableError(ENGINE_NAME, `the thread exited without a result (code ${code})`)));
    startQueued();
  });
  threads.add(thread);
  return thread;
}

function dispatch(thread: PooledThread, queued: QueuedJob): void {
  if (thread.idleTimer) clearTimeout(thread.idleTimer);
  thread.idleTimer = null;
  const deadlineMs = pdfTextDeadlineMs();
  const timer = setTimeout(() => {
    retire(thread);
    settle(thread, (job) => job.reject(new PdfTextGeometryError(`PDF text extraction exceeded its ${deadlineMs} ms limit.`)));
    startQueued();
  }, deadlineMs);
  thread.active = { resolve: queued.resolve, reject: queued.reject, timer };
  thread.worker.ref?.();
  thread.worker.once('message', (reply: WorkerReply) => {
    settle(thread, (job) => {
      if (reply.ok && reply.result) job.resolve(reply.result);
      else job.reject(pdfTextFailure(reply.kind, reply.message ?? 'PDF text extraction failed.'));
    });
    release(thread);
  });
  thread.worker.postMessage({ bytes: queued.bytes, job: queued.job }, [queued.bytes.buffer as ArrayBuffer]);
}

/** Starts as many waiting jobs as there are threads for. */
function startQueued(): void {
  while (queue.length > 0) {
    let thread = idleThreads.pop();
    if (!thread && threads.size < poolLimit()) {
      const next = queue[0];
      try {
        thread = createThread();
      } catch (error) {
        queue.shift();
        next.reject(error);
        continue;
      }
    }
    if (!thread) return;
    const queued = queue.shift() as QueuedJob;
    dispatch(thread, queued);
  }
}

/** Stops every thread, idle or busy; a busy thread's job fails. Used when the process shuts down and between tests. */
export function shutdownPdfTextThreads(): void {
  for (const thread of [...threads]) {
    retire(thread);
    settle(thread, (job) => job.reject(new EngineUnavailableError(ENGINE_NAME, 'the thread was stopped')));
  }
  for (const queued of queue.splice(0)) queued.reject(new EngineUnavailableError(ENGINE_NAME, 'the thread was stopped'));
}

/**
 * @returns the job result.
 * @throws PdfTextGeometryError when the document is rejected, runs out of memory or exceeds the deadline.
 * @throws EncryptedOfficeDocumentError when the document needs a password.
 * @throws PayloadLimitError when the document has more pages than can be read.
 * @throws EngineUnavailableError when the thread cannot run: no entry exists, it cannot be started, or it dies.
 */
export function runPdfTextJobInThread(pdf: Buffer, job: PdfTextJob): Promise<PdfTextJobResult> {
  // A private copy: transferring the caller's (possibly pooled or shared) memory would detach it.
  const bytes = new Uint8Array(pdf.byteLength);
  bytes.set(pdf);
  return new Promise<PdfTextJobResult>((resolve, reject) => {
    queue.push({ bytes, job, resolve, reject });
    startQueued();
  });
}
