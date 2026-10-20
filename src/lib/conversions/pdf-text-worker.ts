/**
 * Entry of the thread that reads a PDF's text and word geometry (see pdf-text-host.ts). The thread stays up between
 * jobs so that pdfjs is loaded once: each message carries the file bytes and the job, and is answered with the
 * result or the message and kind of the typed error. Jobs run one at a time on a thread.
 *
 * A thread started as the replacement of one about to be retired is told so (`workerData.warmUp`): it reads the fixed
 * document of pdf-text-warmup.ts several times, which loads pdfjs and its font data and warms the reader's code, then loads the image reader when `workerData.images`
 * (the document has no image to load it for) and reports `{ ready: true }`; the host gives it user documents only after that.
 */
import * as nodeModule from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import { ConversionFailedError } from '../types';
import { analyzePdfPagesInProcess } from './pdf-text-geometry';
import { pdfTextFailureKindOf, type PdfTextJob } from './pdf-text-types';
import { preloadImageReader } from './pdf-text-images';
import { WARMUP_READS, warmupPdf } from './pdf-text-warmup';

interface ThreadStart {
  warmUp?: boolean;
  images?: boolean;
  /** Where the threads of this bundle keep the V8 code cache of pdfjs and its worker module (see pdf-text-host.ts); none for a thread that runs the source. */
  compileCacheDir?: string | null;
}

const start = workerData as ThreadStart | null;
// The next thread compiles neither module (about a quarter of a start-up). The installed type definitions predate
// `enableCompileCache` (Node 22.8; the engines field requires 24). It returns a status instead of throwing: a directory that
// cannot be written leaves the thread without the cache.
if (start?.compileCacheDir) (nodeModule as typeof nodeModule & { enableCompileCache(directory: string): unknown }).enableCompileCache(start.compileCacheDir);

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

async function warmUp(images: boolean): Promise<void> {
  const pdf = Buffer.from(warmupPdf());
  for (let read = 0; read < WARMUP_READS; read++) await analyzePdfPagesInProcess(pdf, WARMUP_JOB);
  if (images) await preloadImageReader();
  parentPort?.postMessage({ ready: true });
}

if (start?.warmUp === true) void warmUp(start.images === true);
