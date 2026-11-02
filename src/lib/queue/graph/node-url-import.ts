import path from 'node:path';
import { Readable, Transform, pipeline } from 'node:stream';
import type { Job } from '../bullmq-engine';
import type { IStorageBackend } from '../../storage/oci-storage';
import { ConversionFailedError, ImportBudgetExceededError, type ConversionJobData, type ConversionJobResult } from '../../types';
import { safeFetch } from '../../security/safe-fetch';
import { redactUrl } from '../../security/redact';
import { dailyBudgetBytes, withLinkImportHold, type LinkImportHold, type LinkImportRefusal } from '../../api-keys/anonymous-upload-budget';
import { maxFileBytes, planOfCaller, type Plan } from '../../plan-limits';
import { formatBytes } from '../../format-bytes';
import { tierForOwner } from '../page-cap';
import { jobDeadlineAt } from '../job-deadline';
import { graphNodeJobId } from './node-jobs';

/**
 * A graph `import.url` node that found the rest of its owner's day held by other link imports still running. They give
 * back what they do not read once they end, so this says nothing about the node, and the queue tries it again.
 */
export class ImportBytesHeldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportBytesHeldError';
  }
}

const INTERMEDIATE_TTL_MS = 24 * 60 * 60 * 1000;
/** Largest body an import.url node accepts; override with GRAPH_URL_IMPORT_MAX_BYTES. */
const DEFAULT_URL_IMPORT_MAX_BYTES = 5 * 1024 * 1024 * 1024;

function urlImportMaxBytes(): number {
  const configured = Number(process.env.GRAPH_URL_IMPORT_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_URL_IMPORT_MAX_BYTES;
}

/** The failure of a node whose import the day's byte budget of its owner refused, worded for the refusal. */
function refusalFailure(refusal: LinkImportRefusal, plan: Plan): Error {
  const limit = formatBytes(dailyBudgetBytes(plan));
  if (refusal === 'held') {
    return new ImportBytesHeldError(`Other link imports that are still running hold the rest of today's ${limit} for link imports, so this one could not start yet.`);
  }
  return new ImportBudgetExceededError(`Link imports may total ${limit} a day, and today's are used up. The limit resets at midnight UTC.`);
}

/**
 * Imports the link of an import.url node under the daily byte budget of the graph's owner, as `/api/fetch-url` imports one
 * (docs/policy-decisions.md, entry 15): it holds one file at the plan's limit (or the bytes left that day when fewer) until
 * the node's deadline, reads no more than it holds, and is charged the bytes it received however it ends. The hold is the
 * node job's, so the retry of an attempt that crashed replaces the hold that attempt left.
 */
export async function importUrlWithinBudget(
  job: Job<ConversionJobData, ConversionJobResult>,
  storage: IStorageBackend,
  url: string,
  headers: Record<string, string> | undefined
): Promise<string> {
  const { graphId, graphNodeId: nodeId, userId: owner } = job.data;
  const deadlineAt = jobDeadlineAt(job);
  if (!graphId || !nodeId || !owner || deadlineAt === undefined) {
    throw new ConversionFailedError(`Import node "${nodeId}" has no owner and deadline, so its bytes cannot be held against a daily budget.`);
  }
  const plan = planOfCaller({ id: owner, tier: await tierForOwner(owner) });
  const limitBytes = Math.min(urlImportMaxBytes(), maxFileBytes(plan));
  const imported = await withLinkImportHold(owner, plan, deadlineAt - Date.now(), limitBytes, graphNodeJobId(graphId, nodeId), (hold) =>
    importUrlArtifact({ storage, graphId, nodeId, url, headers, signal: job.signal, hold })
  );
  if ('refusal' in imported) throw refusalFailure(imported.refusal, plan);
  return imported.result;
}

/**
 * The failure of a body larger than `hold`, by the length it declared or, without one, as it streamed: past the import
 * limit, or past the rest of the day when that was less.
 */
function tooLarge(url: string, hold: LinkImportHold, declaredBytes?: number): Error {
  const size = declaredBytes === undefined ? 'exceeds' : `is ${declaredBytes} bytes, above`;
  return hold.cappedByDay
    ? new ImportBudgetExceededError(`Remote file at ${redactUrl(url)} ${size} the ${hold.maxBytes} bytes left today for link imports`)
    : new ConversionFailedError(`Remote file at ${redactUrl(url)} ${size} the ${hold.maxBytes}-byte import limit`);
}

/** Streams a public URL into intermediate storage, refusing internal targets and bodies past its hold, counting what it read. */
async function importUrlArtifact(request: {
  storage: IStorageBackend;
  graphId: string;
  nodeId: string;
  url: string;
  headers: Record<string, string> | undefined;
  signal: AbortSignal;
  hold: LinkImportHold;
}): Promise<string> {
  const { storage, graphId, nodeId, url, headers, signal, hold } = request;
  const response = await safeFetch(url, { headers, signal });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new ConversionFailedError(`Failed to fetch URL ${redactUrl(url)}: HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > hold.maxBytes) {
    await response.body.cancel();
    throw tooLarge(url, hold, declared);
  }

  const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hold.receivedBytes += chunk.length;
      if (hold.receivedBytes > hold.maxBytes) {
        done(tooLarge(url, hold));
        return;
      }
      done(null, chunk);
    },
  });
  // pipeline forwards a source error (remote reset, abort) to the limiter that storage consumes,
  // and destroys the source, cancelling the download, when the limiter fails. Storage observes
  // every failure through the limiter's 'error' event, so the callback has nothing left to do.
  const limited = pipeline(source, limiter, () => undefined);

  const urlName = path.basename(new URL(url).pathname);
  const filename = urlName && urlName !== '/' ? urlName : `${nodeId}.bin`;
  const key = `intermediate/${graphId}/${nodeId}/${filename}`;
  const mimeType = response.headers.get('content-type') || 'application/octet-stream';
  await storage.saveObjectFromStream(key, limited, { filename, mimeType }, INTERMEDIATE_TTL_MS);
  return key;
}
