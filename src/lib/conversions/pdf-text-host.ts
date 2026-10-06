import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
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
 * otherwise the TypeScript source through tsx; with neither available `null` is returned and the caller
 * reads the document in this thread.
 */

/** V8 heap ceiling of the extraction thread. */
const THREAD_HEAP_LIMIT_MB = 1024;
const THREAD_YOUNG_LIMIT_MB = 64;
const WORKER_FILE = 'pdf-text-worker';
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

function resolveWorkerEntry(): WorkerEntry | null {
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
  return null;
}

let warnedNoWorker = false;

/**
 * @returns the job result, or null when no worker thread entry exists on this deployment.
 * @throws PdfTextGeometryError when the job fails, runs out of memory or exceeds the deadline.
 */
export function runPdfTextJobInThread(pdf: Buffer, job: PdfTextJob): Promise<PdfTextJobResult | null> {
  const entry = resolveWorkerEntry();
  if (!entry) {
    if (!warnedNoWorker) {
      warnedNoWorker = true;
      console.warn('[pdf-text] no worker thread entry found (build pdf-text-worker.js with "npm run build:pdf-text-worker"); reading in-process without a deadline');
    }
    return Promise.resolve(null);
  }
  const deadlineMs = pdfTextDeadlineMs();
  // A private copy: transferring the caller's (possibly pooled or shared) memory would detach it.
  const bytes = new Uint8Array(pdf.byteLength);
  bytes.set(pdf);
  const resourceLimits = { maxOldGenerationSizeMb: THREAD_HEAP_LIMIT_MB, maxYoungGenerationSizeMb: THREAD_YOUNG_LIMIT_MB };
  const workerData = { bytes, job };
  const worker =
    entry.kind === 'compiled'
      ? new Worker(entry.file, { workerData, transferList: [bytes.buffer], resourceLimits })
      : new Worker(entry.bootstrap, { eval: true, workerData, transferList: [bytes.buffer], resourceLimits });

  return new Promise<PdfTextJobResult | null>((resolve, reject) => {
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
    worker.once('error', (error: Error & { code?: string }) =>
      finish(() => {
        if (error.code === 'ERR_WORKER_OUT_OF_MEMORY') {
          reject(new PdfTextGeometryError('PDF text extraction exceeded its memory limit.'));
        } else {
          reject(new PdfTextGeometryError(`PDF text extraction failed: ${error.message}`));
        }
      })
    );
    worker.once('exit', (code) =>
      finish(() => reject(new PdfTextGeometryError(`PDF text extraction thread exited unexpectedly (code ${code}).`)))
    );
  });
}
