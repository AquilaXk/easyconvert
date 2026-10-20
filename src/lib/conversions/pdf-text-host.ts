import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setFlagsFromString } from 'node:v8';
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
 * A new thread costs the job that waits for it its start-up (loading pdfjs, then a cold engine: about 200 ms against
 * 5 ms for a document), which is a spike once in RECYCLE_AFTER_JOBS jobs. A thread that nears its retirement therefore
 * starts its replacement ahead (REPLACEMENT_LEAD_JOBS jobs before): the replacement reads a fixed page of this
 * repository once (pdf-text-warmup.ts), which loads pdfjs and its font data, and only then joins the pool; the old thread
 * is retired when the replacement is ready, or after RECYCLE_LIMIT_JOBS jobs. The replacement has read no user document,
 * so retiring the old thread still ends everything a document left in it; only the delay of starting a thread is hidden.
 *
 * Failures are typed by whose fault they are. A document that overruns the deadline, exhausts the thread's memory or
 * is rejected by the reader is a PdfTextGeometryError (400), or the typed error the thread names (an encrypted
 * document, a document with too many pages). A thread that cannot be started, dies on its own, or has no entry is
 * the service's: an EngineUnavailableError (503).
 */

/** V8 heap ceiling of an extraction thread. */
const THREAD_HEAP_LIMIT_MB = 1024;
const THREAD_YOUNG_LIMIT_MB = 64;
/**
 * Size of the old generation at which a new thread first collects it. V8 derives that from the thread's heap limit, and a
 * thread of 1 GB collected the old generation every 23 documents (13 full collections in 300 documents against 3 with the limit
 * at 4 GB), which made a document 15 percent slower. The flag is read when a thread's heap is made and is process-wide, so it is
 * set from before a text thread is created until that thread is online (its heap exists) and then set back to 0, which gives the
 * size V8 computes. A thread of another module started after that has the default; one started while a text thread is starting
 * (a few milliseconds) shares the threshold, which is harmless. It is a threshold, not a limit; the heap limit above is unchanged.
 */
const THREAD_INITIAL_OLD_SPACE_FLAG = '--initial-old-space-size=128';
const DEFAULT_INITIAL_OLD_SPACE_FLAG = '--initial-old-space-size=0';
/** Text threads that are created and not yet online; the threshold stays set while there is one. */
let startsAwaitingOnline = 0;

function holdInitialOldSpace(): void {
  if (startsAwaitingOnline++ === 0) setFlagsFromString(THREAD_INITIAL_OLD_SPACE_FLAG);
}

function releaseInitialOldSpace(): void {
  if (--startsAwaitingOnline === 0) setFlagsFromString(DEFAULT_INITIAL_OLD_SPACE_FLAG);
}
const WORKER_FILE = 'pdf-text-worker';
/** Name the unavailable-engine error carries. */
const ENGINE_NAME = 'pdf-text-thread';
/** Built at run time so the Next.js bundler does not follow it: only the source-mode thread needs tsx. */
const TSX_REGISTER_SPECIFIER = ['tsx', 'cjs', 'api'].join('/');
/** Most threads at once; further jobs wait for one. */
const MAX_POOL = 4;
/** A thread that has read this many documents is replaced, which bounds what a leak in the reader can accumulate. */
const RECYCLE_AFTER_JOBS = 100;
/** The replacement of a thread is started this many jobs before the thread is due, to be warm when it is. */
const REPLACEMENT_LEAD_JOBS = 20;
/** A thread whose replacement is still starting at RECYCLE_AFTER_JOBS reads on, but never beyond this many documents. */
const RECYCLE_LIMIT_JOBS = 2 * RECYCLE_AFTER_JOBS;
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
  /** The thread started to take over from this one; it has read no user document. */
  replacement: PooledThread | null;
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

/** Gives the threshold back when the thread's heap exists (it is online) or it never will be (it failed or ended). */
function releaseWhenHeapExists(worker: Worker): void {
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    releaseInitialOldSpace();
  };
  for (const event of ['online', 'error', 'exit'] as const) worker.once(event, release);
}

function startWorker(entry: WorkerEntry, warmUp: boolean): Worker {
  const options = { resourceLimits: { maxOldGenerationSizeMb: THREAD_HEAP_LIMIT_MB, maxYoungGenerationSizeMb: THREAD_YOUNG_LIMIT_MB }, workerData: { warmUp } };
  holdInitialOldSpace();
  let worker: Worker;
  try {
    // The bundle needs no loader: a thread inherits its parent's `--import`, and under the TypeScript loader of a development or
    // benchmark process the bundle's own modules would be loaded through it (450 ms to start instead of 125 ms).
    worker = entry.kind === 'compiled' ? new Worker(entry.file, { ...options, execArgv: [] }) : new Worker(entry.bootstrap, { eval: true, ...options });
  } catch (error) {
    releaseInitialOldSpace();
    throw new EngineUnavailableError(ENGINE_NAME, `the thread could not be started: ${error instanceof Error ? error.message : String(error)}`);
  }
  releaseWhenHeapExists(worker);
  return worker;
}

/** The error for a failure the thread reported through its `error` event. */
function threadFailure(error: Error & { code?: string }): Error {
  if (error.code === 'ERR_WORKER_OUT_OF_MEMORY') return new PdfTextGeometryError('PDF text extraction exceeded its memory limit.');
  return new EngineUnavailableError(ENGINE_NAME, `the thread failed: ${error.message}`);
}

const threads = new Set<PooledThread>();
const idleThreads: PooledThread[] = [];
/** Replacements that are still warming up: they take no job, and do not count against the pool limit. */
const warming = new Set<PooledThread>();
const queue: QueuedJob[] = [];

function retire(thread: PooledThread): void {
  if (thread.idleTimer) clearTimeout(thread.idleTimer);
  thread.idleTimer = null;
  threads.delete(thread);
  warming.delete(thread);
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

/** An idle thread must not keep the process alive, and is stopped after IDLE_MS without a job. */
function markIdle(thread: PooledThread): void {
  thread.worker.unref?.();
  thread.idleTimer = setTimeout(() => retire(thread), IDLE_MS);
  thread.idleTimer.unref?.();
}

/** Whether the replacement of `thread` is still starting, so that retiring the thread now would leave the next job a cold start. */
function awaitsReplacement(thread: PooledThread): boolean {
  const replacement = thread.replacement;
  return replacement !== null && threads.has(replacement) && warming.has(replacement);
}

/** Starts the thread that takes over from `thread`, unless one is on its way. A thread that cannot start is reported by the job that needs it. */
function startReplacement(thread: PooledThread): void {
  if (thread.replacement && threads.has(thread.replacement)) return;
  try {
    thread.replacement = createThread(true);
  } catch {
    thread.replacement = null;
  }
}

function release(thread: PooledThread): void {
  thread.jobs++;
  if (thread.jobs >= RECYCLE_AFTER_JOBS - REPLACEMENT_LEAD_JOBS) startReplacement(thread);
  const due = thread.jobs >= RECYCLE_LIMIT_JOBS || (thread.jobs >= RECYCLE_AFTER_JOBS && !awaitsReplacement(thread));
  if (due) {
    retire(thread);
  } else {
    markIdle(thread);
    idleThreads.push(thread);
  }
  startQueued();
}

/** A warm replacement joins the pool behind the idle threads, so the thread it replaces keeps the jobs until it is retired. */
function joinPool(thread: PooledThread): void {
  if (!threads.has(thread)) return;
  warming.delete(thread);
  markIdle(thread);
  idleThreads.unshift(thread);
  startQueued();
}

function createThread(replacement = false): PooledThread {
  const worker = startWorker(resolveWorkerEntry(), replacement);
  const thread: PooledThread = { worker, active: null, jobs: 0, idleTimer: null, replacement: null };
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
  if (replacement) {
    warming.add(thread);
    worker.unref?.();
    worker.once('message', () => joinPool(thread));
  }
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
    if (!thread && threads.size - warming.size < poolLimit()) {
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
