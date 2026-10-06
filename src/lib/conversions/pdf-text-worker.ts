/**
 * Entry of the thread that reads a PDF's text and word geometry (see pdf-text-host.ts). It receives the
 * file bytes and the job, and posts back the result or the message of the typed error.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { analyzePdfPagesInProcess } from './pdf-text-geometry';
import { PdfTextGeometryError, type PdfTextJob } from './pdf-text-types';

interface Request {
  bytes: Uint8Array;
  job: PdfTextJob;
}

async function run(): Promise<void> {
  const { bytes, job } = workerData as Request;
  const port = parentPort;
  if (!port) return;
  try {
    const result = await analyzePdfPagesInProcess(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), job);
    port.postMessage({ ok: true, result });
  } catch (error) {
    const message = error instanceof PdfTextGeometryError ? error.message : `PDF text extraction failed: ${String(error)}`;
    port.postMessage({ ok: false, message });
  }
}

void run();
