/**
 * Entry of the thread that reads a PDF's text and word geometry (see pdf-text-host.ts). The thread stays up between
 * jobs so that pdfjs is loaded once: each message carries the file bytes and the job, and is answered with the
 * result or the message and kind of the typed error. Jobs run one at a time on a thread.
 */
import { parentPort } from 'node:worker_threads';
import { ConversionFailedError } from '../types';
import { analyzePdfPagesInProcess } from './pdf-text-geometry';
import { pdfTextFailureKindOf, type PdfTextJob } from './pdf-text-types';

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
