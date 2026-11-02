import path from 'node:path';
import { Readable, Transform, pipeline, type TransformCallback } from 'node:stream';
import type { Job } from '../bullmq-engine';
import type { IStorageBackend } from '../../storage/oci-storage';
import { ConversionFailedError, ImportBudgetExceededError, type ConversionJobData, type ConversionJobResult } from '../../types';
import { safeFetch } from '../../security/safe-fetch';
import { redactUrl } from '../../security/redact';
import {
  budgetRefusalDetail,
  dailyLimitReachedDetail,
  declaredBodyBytes,
  largerThanLeftDetail,
  withLinkImportMeter,
  type DeclaredOverflow,
  type LinkImportMeter,
  type MeterVerdict,
} from '../../api-keys/anonymous-upload-budget';
import { maxFileBytes, planOfCaller, type Plan } from '../../plan-limits';
import { tierForOwner } from '../page-cap';
import { nodeOutputKey } from './node-jobs';

const INTERMEDIATE_TTL_MS = 24 * 60 * 60 * 1000;
/** Largest body an import.url node accepts; override with GRAPH_URL_IMPORT_MAX_BYTES. */
const DEFAULT_URL_IMPORT_MAX_BYTES = 5 * 1024 * 1024 * 1024;

function urlImportMaxBytes(): number {
  const configured = Number(process.env.GRAPH_URL_IMPORT_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_URL_IMPORT_MAX_BYTES;
}

/**
 * Imports the link of an import.url node under the daily byte budget of the graph's owner, as `/api/fetch-url` imports one
 * (docs/policy-decisions.md, entry 15): it starts only while the owner's day has bytes left, reads at most one file at the
 * smaller of its read limit and the plan's file size limit, and charges the bytes it receives as they arrive, stopping once
 * the day passes its budget. Each refusal of the budget fails the node with `import_budget_exceeded`, final for the day. A
 * retried attempt reads the file again and is charged again for what it reads.
 */
export async function importUrlWithinBudget(
  job: Job<ConversionJobData, ConversionJobResult>,
  storage: IStorageBackend,
  url: string,
  headers: Record<string, string> | undefined
): Promise<string> {
  const { graphId, graphNodeId: nodeId, userId: owner } = job.data;
  if (!graphId || !nodeId || !owner) {
    throw new ConversionFailedError(`Import node "${nodeId}" has no owner, so its bytes cannot be charged to a daily budget.`);
  }
  const plan = planOfCaller({ id: owner, tier: await tierForOwner(owner) });
  const limitBytes = Math.min(urlImportMaxBytes(), maxFileBytes(plan));
  const imported = await withLinkImportMeter({ owner, plan, limitBytes }, (meter) =>
    importUrlArtifact({ storage, graphId, nodeId, url, headers, signal: job.signal, meter, limitBytes, plan })
  );
  if ('refusal' in imported) throw new ImportBudgetExceededError(budgetRefusalDetail(imported.refusal, plan));
  return imported.result;
}

/** The failure of a body past the `limitBytes` an import.url node reads, by the length it declared when it declared one. */
function tooLarge(url: string, limitBytes: number, declaredBytes?: number): ConversionFailedError {
  const size = declaredBytes === undefined ? 'exceeds' : `is ${declaredBytes} bytes, above`;
  return new ConversionFailedError(`Remote file at ${redactUrl(url)} ${size} the ${limitBytes}-byte import limit`);
}

/** The failure of a body whose declared length is past the import limit, or past what the owner's day has left. */
function declaredFailure(url: string, overflow: DeclaredOverflow, limitBytes: number, declaredBytes: number | undefined): Error {
  return overflow.kind === 'too-large' ? tooLarge(url, limitBytes, declaredBytes) : new ImportBudgetExceededError(largerThanLeftDetail(overflow.leftBytes));
}

/**
 * Streams a public URL into intermediate storage, refusing internal targets, a declared length past the import limit or the
 * day, and a body that passes the import limit or takes the owner's day past its budget while it is read. The error that
 * stopped the stream is the one the node fails with, also when the storage backend wraps the stream's error in its own.
 */
async function importUrlArtifact(request: {
  storage: IStorageBackend;
  graphId: string;
  nodeId: string;
  url: string;
  headers: Record<string, string> | undefined;
  signal: AbortSignal;
  meter: LinkImportMeter;
  limitBytes: number;
  plan: Plan;
}): Promise<string> {
  const { storage, graphId, nodeId, url, headers, signal, meter, limitBytes, plan } = request;
  const response = await safeFetch(url, { headers, signal });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new ConversionFailedError(`Failed to fetch URL ${redactUrl(url)}: HTTP ${response.status}`);
  }
  const declared = declaredBodyBytes(response.headers);
  const overflow = meter.declared(declared);
  if (overflow) {
    await response.body.cancel();
    throw declaredFailure(url, overflow, limitBytes, declared);
  }

  let stop: Error | undefined;
  const stopWith = (error: Error, done: TransformCallback) => {
    stop = error;
    done(error);
  };
  const stopped = (verdict: Exclude<MeterVerdict, 'ok'>): Error =>
    verdict === 'too-large' ? tooLarge(url, limitBytes) : new ImportBudgetExceededError(dailyLimitReachedDetail(plan));
  const metered = new Transform({
    transform(chunk: Buffer, _enc, done) {
      meter.count(chunk.length).then((verdict) => (verdict === 'ok' ? done(null, chunk) : stopWith(stopped(verdict), done)), done);
    },
    flush(done) {
      meter.charge().then((verdict) => (verdict === 'ok' ? done() : stopWith(stopped(verdict), done)), done);
    },
  });
  // pipeline forwards a source error (remote reset, abort) to the meter that storage consumes, and destroys the source,
  // cancelling the download, when the meter fails. Storage observes every failure through the meter's 'error' event, so the
  // callback has nothing left to do.
  const limited = pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), metered, () => undefined);

  const urlName = path.basename(new URL(url).pathname);
  const filename = urlName && urlName !== '/' ? urlName : `${nodeId}.bin`;
  const key = nodeOutputKey('intermediate', graphId, nodeId, 0, filename);
  const mimeType = response.headers.get('content-type') || 'application/octet-stream';
  try {
    await storage.saveObjectFromStream(key, limited, { filename, mimeType }, INTERMEDIATE_TTL_MS);
  } catch (err) {
    throw stop ?? err;
  }
  return key;
}
