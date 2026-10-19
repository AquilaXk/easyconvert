/**
 * Entry of the thread that reads a PDF's text and word geometry (see pdf-text-host.ts). The thread stays up between
 * jobs so that pdfjs is loaded once: each message carries the file bytes and the job, and is answered with the
 * result or the message and kind of the typed error. Jobs run one at a time on a thread.
 *
 * A thread started as the replacement of one about to be retired is told so (`workerData.warmUp`): it reads the fixed
 * page of pdf-text-warmup.ts once, which loads pdfjs and its font data, then reports `{ ready: true }`; the host gives
 * it user documents only after that.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { ConversionFailedError } from '../types';
import { analyzePdfPagesInProcess } from './pdf-text-geometry';
import { pdfTextFailureKindOf, type PdfTextJob } from './pdf-text-types';
import { warmupPdf } from './pdf-text-warmup';

/** The job the host sends for a text conversion; the warm-up runs the same code. */
const WARMUP_JOB: PdfTextJob = { geometry: 'none', content: true };

interface Request {
  bytes: Uint8Array;
  job: PdfTextJob;
}

async function run({ bytes, job }: Request): Promise<void> {
  const port = parentPort;
  if (!port) return;
  try {
    const result = await analyzePdfPagesInProcess(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), job);
    port.postMessage({ ok: true, result });
  } catch (error) {
    const message = error instanceof ConversionFailedError ? error.message : `PDF text extraction failed: ${String(error)}`;
    port.postMessage({ ok: false, message, kind: pdfTextFailureKindOf(error) });
  }
}

parentPort?.on('message', (request: Request) => {
  void run(request);
});

async function warmUp(): Promise<void> {
  await analyzePdfPagesInProcess(Buffer.from(warmupPdf()), WARMUP_JOB);
  parentPort?.postMessage({ ready: true });
}

if ((workerData as { warmUp?: boolean } | null)?.warmUp === true) void warmUp();
