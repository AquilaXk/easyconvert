/**
 * Conversion of a file too large for one request (docs/policy-decisions.md, entry 137): the file goes to the server in
 * parts through /api/storage/multipart, a job converts the stored file, and the result is downloaded when the job ends.
 * The parts, the job and the result belong to this call: cancelling it, or any failure, closes the upload that is open
 * and cancels the job that is queued.
 */

import { ConversionOptions } from '../../types';
import { UPLOAD_PART_MAX_BYTES } from '../../plan-limits';
import type { CloudConversionResult } from './fallback-pipeline';

const MULTIPART_URL = '/api/storage/multipart';
const JOBS_URL = '/api/queue/jobs';

/** Where the item is: its bytes are on the way to the server, or the server is converting them. */
export type ResumableStage = 'uploading' | 'converting';

export interface ResumableHooks {
  onProgress: (progress: number) => void;
  onStage?: (stage: ResumableStage) => void;
  signal?: AbortSignal;
}

export interface ResumableTiming {
  /** Pause between two reads of the job. */
  pollIntervalMs: number;
  /** First pause before a request is sent again; each further attempt doubles it. */
  retryDelayMs: number;
  /** Longest the call waits for the job to end. */
  maxWaitMs: number;
}

export const DEFAULT_RESUMABLE_TIMING: ResumableTiming = {
  pollIntervalMs: 1000,
  retryDelayMs: 1000,
  maxWaitMs: 2 * 60 * 60 * 1000,
};

/** Progress shown while the parts go up, then while the server converts; the rest is the download. */
const UPLOAD_PROGRESS_END = 45;
const CONVERT_PROGRESS_END = 95;
const FULL_PROGRESS = 100;

const MAX_ATTEMPTS = 4;
const MAX_RETRY_AFTER_MS = 60_000;
/** Answers that say the request was not taken up: the rate limit, and a server that is busy. */
const NOT_TAKEN_STATUSES: ReadonlySet<number> = new Set([429, 503]);
/** Answers after which a request may or may not have been taken up: an edge or a server that failed while it ran. */
const UNKNOWN_STATUSES: ReadonlySet<number> = new Set([502, 504]);
const MS_PER_SECOND = 1000;

const FINISHED_JOB_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

interface PartReceipt {
  partNumber: number;
  etag: string;
}

/** What this call has created on the server, so a cancellation or a failure can close it. */
interface ServerState {
  uploadId?: string;
  uploadCompleted: boolean;
  jobId?: string;
  jobFinished: boolean;
}

type Body = Record<string, unknown>;

function abortError(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException('The conversion was cancelled.', 'AbortError');
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** How long to wait before sending again: the `Retry-After` of the answer when it has one, else a doubling delay. */
function retryDelayMs(res: Response | undefined, attempt: number, timing: ResumableTiming): number {
  const seconds = Number.parseInt(res?.headers.get('retry-after') ?? '', 10);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * MS_PER_SECOND, MAX_RETRY_AFTER_MS);
  return timing.retryDelayMs * 2 ** (attempt - 1);
}

/**
 * Sends a request, and sends it again after an answer that says it was not taken up. A request that gives the same result
 * when it is sent twice (`repeatable`: a part, a read, a download) is also sent again after a network error or an answer
 * that does not say whether it was taken up. The opening, the completion and the start of the job are not, since a second
 * one would leave a second session, fail on a closed one or run a second job. A cancellation is never sent again.
 */
async function sendWithRetry(
  send: () => Promise<Response>,
  signal: AbortSignal | undefined,
  timing: ResumableTiming,
  repeatable = false
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let res: Response | undefined;
    try {
      res = await send();
    } catch (err) {
      if (signal?.aborted || attempt === MAX_ATTEMPTS || !repeatable) throw err;
    }
    const sendAgain = res && (NOT_TAKEN_STATUSES.has(res.status) || (repeatable && UNKNOWN_STATUSES.has(res.status)));
    if (res && (!sendAgain || attempt === MAX_ATTEMPTS)) return res;
    await sleep(retryDelayMs(res, attempt, timing), signal);
  }
}

/** The JSON of an answer, or the sentence the server gave for a refusal. */
async function readBody(res: Response, action: string): Promise<Body> {
  const body = (await res.json().catch(() => ({}))) as Body;
  if (!res.ok) {
    const reason = [body.detail, body.error].find((text): text is string => typeof text === 'string');
    throw new Error(reason ?? `${action} failed (HTTP ${res.status}).`);
  }
  return body;
}

function postJson(url: string, payload: unknown, signal: AbortSignal | undefined): () => Promise<Response> {
  return () =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
}

function readString(body: Body, field: string, action: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value === '') throw new Error(`${action} gave no ${field}.`);
  return value;
}

async function openUpload(file: File, signal: AbortSignal | undefined, timing: ResumableTiming): Promise<Body> {
  const res = await sendWithRetry(
    postJson(
      `${MULTIPART_URL}?action=initiate`,
      {
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        totalSize: file.size,
        partSize: UPLOAD_PART_MAX_BYTES,
      },
      signal
    ),
    signal,
    timing
  );
  return readBody(res, 'Starting the upload');
}

async function sendPart(
  uploadId: string,
  partNumber: number,
  bytes: Blob,
  signal: AbortSignal | undefined,
  timing: ResumableTiming
): Promise<PartReceipt> {
  const query = `action=chunk&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`;
  const res = await sendWithRetry(
    () =>
      fetch(`${MULTIPART_URL}?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bytes,
        signal,
      }),
    signal,
    timing,
    true
  );
  const body = await readBody(res, `Uploading part ${partNumber}`);
  return { partNumber, etag: readString(body, 'etag', `Uploading part ${partNumber}`) };
}

async function uploadInParts(
  file: File,
  state: ServerState,
  hooks: ResumableHooks,
  timing: ResumableTiming
): Promise<string> {
  const opened = await openUpload(file, hooks.signal, timing);
  const uploadId = readString(opened, 'uploadId', 'Starting the upload');
  state.uploadId = uploadId;
  const partBytes = typeof opened.partSize === 'number' && opened.partSize > 0 ? opened.partSize : UPLOAD_PART_MAX_BYTES;

  const receipts: PartReceipt[] = [];
  for (let start = 0; start < file.size; start += partBytes) {
    receipts.push(await sendPart(uploadId, receipts.length + 1, file.slice(start, start + partBytes), hooks.signal, timing));
    hooks.onProgress(Math.round((Math.min(start + partBytes, file.size) / file.size) * UPLOAD_PROGRESS_END));
  }

  const completed = await readBody(
    await sendWithRetry(postJson(`${MULTIPART_URL}?action=complete`, { uploadId, parts: receipts }, hooks.signal), hooks.signal, timing),
    'Finishing the upload'
  );
  state.uploadCompleted = true;
  return readString(completed, 'key', 'Finishing the upload');
}

async function startJob(
  file: File,
  storageKey: string,
  targetFormat: string,
  options: ConversionOptions,
  signal: AbortSignal | undefined,
  timing: ResumableTiming
): Promise<string> {
  const res = await sendWithRetry(
    postJson(JOBS_URL, { filename: file.name, targetFormat, options, storageKey, fileSize: file.size }, signal),
    signal,
    timing
  );
  return readString(await readBody(res, 'Starting the conversion'), 'jobId', 'Starting the conversion');
}

/** Reads the job until it ends; returns the path of the result of a job that completed. */
async function waitForResult(
  jobId: string,
  state: ServerState,
  hooks: ResumableHooks,
  timing: ResumableTiming
): Promise<string> {
  const giveUpAt = Date.now() + timing.maxWaitMs;
  for (;;) {
    const res = await sendWithRetry(
      () => fetch(`${JOBS_URL}/${encodeURIComponent(jobId)}`, { cache: 'no-store', signal: hooks.signal }),
      hooks.signal,
      timing,
      true
    );
    const job = await readBody(res, 'Reading the conversion');
    const jobState = String(job.state);
    state.jobFinished = FINISHED_JOB_STATES.has(jobState);
    if (jobState === 'completed') {
      const result = (job.returnvalue ?? {}) as Body;
      return readString(result, 'downloadUrl', 'The conversion');
    }
    if (state.jobFinished) {
      throw new Error(typeof job.failedReason === 'string' && job.failedReason ? job.failedReason : 'The conversion failed.');
    }
    const jobProgress = typeof job.progress === 'number' ? Math.min(Math.max(job.progress, 0), FULL_PROGRESS) : 0;
    hooks.onProgress(Math.round(UPLOAD_PROGRESS_END + (jobProgress / FULL_PROGRESS) * (CONVERT_PROGRESS_END - UPLOAD_PROGRESS_END)));
    if (Date.now() >= giveUpAt) throw new Error('The conversion did not finish in time. Try again.');
    await sleep(timing.pollIntervalMs, hooks.signal);
  }
}

async function downloadResult(downloadUrl: string, signal: AbortSignal | undefined, timing: ResumableTiming): Promise<Blob> {
  const res = await sendWithRetry(() => fetch(downloadUrl, { signal }), signal, timing, true);
  if (!res.ok) await readBody(res, 'Downloading the result');
  return res.blob();
}

/** Closes what a cancelled or failed call left on the server. Nothing here can fail the call that is already failing. */
function releaseServerState(state: ServerState): void {
  const quiet = (request: Promise<unknown>) => void request.catch(() => undefined);
  if (state.uploadId && !state.uploadCompleted) {
    quiet(fetch(`${MULTIPART_URL}?action=abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId: state.uploadId }),
      keepalive: true,
    }));
  }
  if (state.jobId && !state.jobFinished) {
    quiet(fetch(`${JOBS_URL}/${encodeURIComponent(state.jobId)}`, { method: 'DELETE', keepalive: true }));
  }
}

/**
 * Converts `file` on the server without ever sending it in one request. Rejects with the cancellation reason when
 * `hooks.signal` aborts, and with the sentence of the server when a step is refused.
 */
export async function executeResumableCloudConversion(
  file: File,
  targetFormat: string,
  options: ConversionOptions,
  hooks: ResumableHooks,
  timing: ResumableTiming = DEFAULT_RESUMABLE_TIMING
): Promise<CloudConversionResult> {
  const state: ServerState = { uploadCompleted: false, jobFinished: false };
  try {
    hooks.onStage?.('uploading');
    const storageKey = await uploadInParts(file, state, hooks, timing);
    hooks.onStage?.('converting');
    state.jobId = await startJob(file, storageKey, targetFormat, options, hooks.signal, timing);
    const downloadUrl = await waitForResult(state.jobId, state, hooks, timing);
    const blob = await downloadResult(downloadUrl, hooks.signal, timing);
    hooks.onProgress(FULL_PROGRESS);
    return { blob, url: URL.createObjectURL(blob), size: blob.size };
  } catch (err) {
    releaseServerState(state);
    throw err;
  }
}
