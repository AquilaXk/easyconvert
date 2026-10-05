import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { EngineUnavailableError, RawDecodeError } from '../lib/types';

export interface InProcessDecoded {
  width: number;
  height: number;
  rgb16: Uint16Array;
}

export const RAW_DECODE_THREAD_TIMEOUT_MS = 120_000;
/** V8 heap ceiling of the decode thread; pixel buffers are bounded separately by the per-format pixel caps. */
const THREAD_HEAP_LIMIT_MB = 512;
const THREAD_YOUNG_LIMIT_MB = 64;
const WORKER_FILE = 'raw-decode-worker';
/** Built at run time so the Next.js bundler does not follow it: only the source-mode thread needs tsx. */
const TSX_REGISTER_SPECIFIER = ['tsx', 'cjs', 'api'].join('/');

interface WorkerReply {
  ok: boolean;
  width?: number;
  height?: number;
  rgb16?: Uint16Array;
  kind?: 'raw' | 'other';
  message?: string;
  unrecognized?: boolean;
}

type WorkerEntry = { kind: 'compiled'; file: string } | { kind: 'source'; bootstrap: string };

/**
 * Finds the decode thread entry: the bundled `.js` next to this module (worker bundle) or under `dist/`
 * (web server, whose own bundle lives elsewhere), else the TypeScript source when tsx is installed.
 * With neither, the in-process decoder is unavailable on this deployment (503), not a bad input.
 */
function resolveWorkerEntry(): WorkerEntry {
  const compiledCandidates = [
    path.join(__dirname, `${WORKER_FILE}.js`),
    path.join(process.cwd(), 'dist', `${WORKER_FILE}.js`),
  ];
  const compiled = compiledCandidates.find((candidate) => fs.existsSync(candidate));
  if (compiled) return { kind: 'compiled', file: compiled };

  const sourceCandidates = [
    path.join(__dirname, `${WORKER_FILE}.ts`),
    path.join(process.cwd(), 'src', 'worker', `${WORKER_FILE}.ts`),
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
    'raw-decode-thread',
    `build ${WORKER_FILE}.js with "npm run build:raw-worker" or install the development dependencies`
  );
}

/**
 * Decodes a Sigma X3F or Raspberry Pi RAW file on a worker thread so the event loop stays free.
 * The thread runs the bundled `.js` next to this module when present, otherwise the TypeScript
 * source through tsx. It is terminated on timeout or abort, and its heap is limited.
 */
export function decodeRawInThread(
  format: 'x3f' | 'raw',
  file: Buffer,
  timeoutMs: number = RAW_DECODE_THREAD_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<InProcessDecoded> {
  // A private copy: transferring the caller's (possibly pooled or shared) memory would detach it.
  const bytes = new Uint8Array(file.byteLength);
  bytes.set(file);
  const resourceLimits = { maxOldGenerationSizeMb: THREAD_HEAP_LIMIT_MB, maxYoungGenerationSizeMb: THREAD_YOUNG_LIMIT_MB };
  const workerData = { format, bytes };
  let entry: WorkerEntry;
  try {
    entry = resolveWorkerEntry();
  } catch (err) {
    return Promise.reject(err);
  }
  const worker = entry.kind === 'compiled'
    ? new Worker(entry.file, { workerData, transferList: [bytes.buffer], resourceLimits })
    : new Worker(entry.bootstrap, { eval: true, workerData, transferList: [bytes.buffer], resourceLimits });

  return new Promise<InProcessDecoded>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      action();
    };
    const timer = setTimeout(
      () => finish(() => reject(new RawDecodeError(`The .${format} decode exceeded its ${timeoutMs} ms time limit`))),
      timeoutMs
    );
    const onAbort = () => finish(() => reject(new RawDecodeError(`The .${format} decode was cancelled`)));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    worker.once('message', (reply: WorkerReply) =>
      finish(() => {
        if (reply.ok && reply.rgb16 && reply.width && reply.height) {
          resolve({ width: reply.width, height: reply.height, rgb16: reply.rgb16 });
        } else if (reply.kind === 'raw') {
          reject(new RawDecodeError(reply.message ?? 'RAW decode failed', reply.unrecognized === true));
        } else {
          reject(new Error(reply.message ?? 'RAW decode thread failed'));
        }
      })
    );
    worker.once('error', (error: Error & { code?: string }) =>
      finish(() => {
        if (error.code === 'ERR_WORKER_OUT_OF_MEMORY') {
          reject(new RawDecodeError(`The .${format} decode exceeded its memory limit`));
        } else {
          reject(error);
        }
      })
    );
    worker.once('exit', (code) =>
      finish(() => reject(new RawDecodeError(`The .${format} decode thread exited unexpectedly (code ${code})`)))
    );
  });
}
