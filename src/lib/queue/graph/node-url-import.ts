import path from 'node:path';
import { Readable, Transform, pipeline } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Job } from '../bullmq-engine';
import type { IStorageBackend } from '../../storage/oci-storage';
import { ConversionFailedError, ImportBudgetExceededError, type ConversionJobData, type ConversionJobResult } from '../../types';
import type { ConversionRefusalCode } from '../../refusal-codes';
import { safeFetch } from '../../security/safe-fetch';
import { redactUrl } from '../../security/redact';
import {
  HELD_IMPORT_RETRY_AFTER_MS,
  budgetRefusalDetail,
  importOverflow,
  largerThanLeftDetail,
  withLinkImportHold,
  type LinkImportHold,
  type LinkImportRefusal,
  type LinkImportRequest,
} from '../../api-keys/anonymous-upload-budget';
import { maxFileBytes, planOfCaller, type Plan } from '../../plan-limits';
import { tierForOwner } from '../page-cap';
import { jobDeadlineAt } from '../job-deadline';
import { graphNodeJobId } from './node-jobs';

/**
 * A graph `import.url` node whose owner's day stayed held by other link imports and open uploads until the node's
 * deadline. They give back what they do not take once they end, so this says nothing about the file or the day. The node
 * waited for them already, so another attempt would only meet its deadline.
 */
export class ImportBytesHeldError extends ConversionFailedError {
  readonly refusalCode: ConversionRefusalCode = 'import_budget_held';
  readonly status = 429;
  constructor(message: string) {
    super(message);
    this.name = 'ImportBytesHeldError';
  }
}

const INTERMEDIATE_TTL_MS = 24 * 60 * 60 * 1000;
/** Largest body an import.url node accepts; override with GRAPH_URL_IMPORT_MAX_BYTES. */
const DEFAULT_URL_IMPORT_MAX_BYTES = 5 * 1024 * 1024 * 1024;
/** The longest a node waits between two tries of a held import; the wait doubles from HELD_IMPORT_RETRY_AFTER_MS up to it. */
const HELD_IMPORT_MAX_WAIT_MS = 60 * 1000;
/** The time a waiting node keeps before its deadline, so it ends as held and not as timed out. */
const HELD_IMPORT_DEADLINE_MARGIN_MS = 1000;

function urlImportMaxBytes(): number {
  const configured = Number(process.env.GRAPH_URL_IMPORT_MAX_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_URL_IMPORT_MAX_BYTES;
}

/** The failure of a node whose import the day's byte budget of its owner refused, in the words of the budget. */
function refusalFailure(refusal: LinkImportRefusal, plan: Plan): Error {
  const detail = budgetRefusalDetail(refusal, plan);
  return refusal === 'held' ? new ImportBytesHeldError(detail) : new ImportBudgetExceededError(detail);
}

/**
 * Imports the link of an import.url node under the daily byte budget of the graph's owner, as `/api/fetch-url` imports one
 * (docs/policy-decisions.md, entry 15): it holds one file at the plan's limit (or the bytes left that day when fewer) until
 * the node's deadline, reads no more than it holds, and is charged the bytes it received however it ends. The hold is the
 * node job's, so the retry of an attempt that crashed replaces the hold that attempt left. While other imports and open
 * uploads hold what the file needs, the node waits for them in this attempt, from HELD_IMPORT_RETRY_AFTER_MS doubling up to
 * HELD_IMPORT_MAX_WAIT_MS, and fails with `import_budget_held` once the next wait would reach its deadline.
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
  const holdId = graphNodeJobId(graphId, nodeId);
  for (let waitMs = HELD_IMPORT_RETRY_AFTER_MS; ; waitMs = Math.min(2 * waitMs, HELD_IMPORT_MAX_WAIT_MS)) {
    try {
      const request: LinkImportRequest = { owner, plan, deadlineMs: deadlineAt - Date.now(), limitBytes, holdId };
      const imported = await withLinkImportHold(request, (hold) =>
        importUrlArtifact({ storage, graphId, nodeId, url, headers, signal: job.signal, hold, plan })
      );
      if ('refusal' in imported) throw refusalFailure(imported.refusal, plan);
      return imported.result;
    } catch (err) {
      if (!(err instanceof ImportBytesHeldError)) throw err;
      const nextWaitMs = Math.min(waitMs, deadlineAt - Date.now() - HELD_IMPORT_DEADLINE_MARGIN_MS);
      if (nextWaitMs <= 0) throw err;
      await job.log(`Node "${nodeId}" waits ${nextWaitMs} ms for the link imports and uploads that hold the rest of its owner's day.`);
      await sleep(nextWaitMs, undefined, { signal: job.signal });
    }
  }
}

/** The length a response declares, or undefined when it declares none it can be held to. */
function declaredLength(response: Response): number | undefined {
  const header = response.headers.get('content-length');
  const length = header === null ? Number.NaN : Number(header);
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined;
}

/**
 * The failure of a body larger than `hold`, by the length it declared or, without one, by the hold it passed
 * (`importOverflow`): past the import limit, larger than the day has left, or held by other transfers until they end.
 */
function overflowFailure(url: string, hold: LinkImportHold, plan: Plan, declaredBytes?: number): Error {
  const overflow = importOverflow(hold, declaredBytes);
  switch (overflow.kind) {
    case 'too-large': {
      const size = declaredBytes === undefined ? 'exceeds' : `is ${declaredBytes} bytes, above`;
      return new ConversionFailedError(`Remote file at ${redactUrl(url)} ${size} the ${hold.limitBytes}-byte import limit`);
    }
    case 'larger-than-left':
      return new ImportBudgetExceededError(largerThanLeftDetail(overflow.leftBytes));
    case 'held':
      return refusalFailure('held', plan);
  }
}

/**
 * Streams a public URL into intermediate storage, refusing internal targets and bodies past its hold, counting what it read.
 * A body that declares a length below the hold lowers the hold to it, and is held to it.
 */
async function importUrlArtifact(request: {
  storage: IStorageBackend;
  graphId: string;
  nodeId: string;
  url: string;
  headers: Record<string, string> | undefined;
  signal: AbortSignal;
  hold: LinkImportHold;
  plan: Plan;
}): Promise<string> {
  const { storage, graphId, nodeId, url, headers, signal, hold, plan } = request;
  const response = await safeFetch(url, { headers, signal });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new ConversionFailedError(`Failed to fetch URL ${redactUrl(url)}: HTTP ${response.status}`);
  }
  const declared = declaredLength(response);
  if (declared !== undefined && declared > hold.held.bytes) {
    await response.body.cancel();
    throw overflowFailure(url, hold, plan, declared);
  }
  if (declared !== undefined && declared < hold.held.bytes) await hold.shrinkTo(declared);
  const maxBytes = declared ?? hold.held.bytes;

  const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hold.receivedBytes += chunk.length;
      if (hold.receivedBytes <= maxBytes) {
        done(null, chunk);
        return;
      }
      done(
        declared === undefined
          ? overflowFailure(url, hold, plan)
          : new ConversionFailedError(`Remote file at ${redactUrl(url)} sent more than the ${declared} bytes it declared`)
      );
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
