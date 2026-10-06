import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { EngineUnavailableError } from '../types';
import {
  PDF_TEXT_DEADLINE_ENV,
  PDF_TEXT_DEADLINE_MS,
  PdfTextGeometryError,
  type PdfTextJob,
  type PdfTextJobResult,
} from './pdf-text-types';

/**
 * Runs a PDF text job (see pdf-text-geometry.ts) on a worker thread with a wall-clock deadline, so a
 * document that makes pdfjs run for ever is stopped by terminating the thread rather than blocking the
 * process. The thread runs the bundled `pdf-text-worker.js` next to this module or under `dist/`,
 * otherwise the TypeScript source through tsx; with neither available the engine is reported unavailable
 * rather than reading the document in this thread without a deadline.
 *
 * Failures are typed by whose fault they are. A document that overruns the deadline, exhausts the thread's
 * memory or is rejected by the reader is a PdfTextGeometryError (400). A thread that cannot be started, dies
 * on its own, or has no entry is the service's: an EngineUnavailableError (503).
 */

/** V8 heap ceiling of the extraction thread. */
const THREAD_HEAP_LIMIT_MB = 1024;
const THREAD_YOUNG_LIMIT_MB = 64;
const WORKER_FILE = 'pdf-text-worker';
/** Name the unavailable-engine error carries. */
const ENGINE_NAME = 'pdf-text-thread';
/** Built at run time so the Next.js bundler does not follow it: only the source-mode thread needs tsx. */
const TSX_REGISTER_SPECIFIER = ['tsx', 'cjs', 'api'].join('/');

type WorkerEntry = { kind: 'compiled'; file: string } | { kind: 'source'; bootstrap: string };

interface WorkerReply {
  ok: boolean;
  result?: PdfTextJobResult;
  message?: string;
}

/** The deadline in milliseconds: the environment override when it is a positive integer, otherwise the default. */
export function pdfTextDeadlineMs(): number {
  const override = Number(process.env[PDF_TEXT_DEADLINE_ENV]);
  return Number.isInteger(override) && override > 0 ? override : PDF_TEXT_DEADLINE_MS;
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

function startWorker(entry: WorkerEntry, bytes: Uint8Array, job: PdfTextJob): Worker {
  const resourceLimits = { maxOldGenerationSizeMb: THREAD_HEAP_LIMIT_MB, maxYoungGenerationSizeMb: THREAD_YOUNG_LIMIT_MB };
  const options = { workerData: { bytes, job }, transferList: [bytes.buffer as ArrayBuffer], resourceLimits };
  try {
    if (entry.kind === 'compiled') return new Worker(entry.file, options);
    return new Worker(entry.bootstrap, { eval: true, ...options });
  } catch (error) {
    throw new EngineUnavailableError(ENGINE_NAME, `the thread could not be started: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The error for a failure the thread reported through its `error` event. */
function threadFailure(error: Error & { code?: string }): Error {
  if (error.code === 'ERR_WORKER_OUT_OF_MEMORY') return new PdfTextGeometryError('PDF text extraction exceeded its memory limit.');
  return new EngineUnavailableError(ENGINE_NAME, `the thread failed: ${error.message}`);
}

/** Settles with the thread's reply, its failure, or the deadline, whichever comes first, and stops the thread. */
function waitForWorker(worker: Worker, deadlineMs: number): Promise<PdfTextJobResult> {
  return new Promise<PdfTextJobResult>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      action();
    };
    const timer = setTimeout(
      () => finish(() => reject(new PdfTextGeometryError(`PDF text extraction exceeded its ${deadlineMs} ms limit.`))),
      deadlineMs
    );
    worker.once('message', (reply: WorkerReply) =>
      finish(() => {
        if (reply.ok && reply.result) resolve(reply.result);
        else reject(new PdfTextGeometryError(reply.message ?? 'PDF text extraction failed.'));
      })
    );
    worker.once('error', (error: Error & { code?: string }) => finish(() => reject(threadFailure(error))));
    worker.once('exit', (code) =>
      finish(() => reject(new EngineUnavailableError(ENGINE_NAME, `the thread exited without a result (code ${code})`)))
    );
  });
}

/**
 * @returns the job result.
 * @throws PdfTextGeometryError when the document is rejected, runs out of memory or exceeds the deadline.
 * @throws EngineUnavailableError when the thread cannot run: no entry exists, it cannot be started, or it dies.
 */
export function runPdfTextJobInThread(pdf: Buffer, job: PdfTextJob): Promise<PdfTextJobResult> {
  let worker: Worker;
  try {
    // A private copy: transferring the caller's (possibly pooled or shared) memory would detach it.
    const bytes = new Uint8Array(pdf.byteLength);
    bytes.set(pdf);
    worker = startWorker(resolveWorkerEntry(), bytes, job);
  } catch (error) {
    return Promise.reject(error);
  }
  return waitForWorker(worker, pdfTextDeadlineMs());
}
