/**
 * Conversion of a file too large for one request (docs/policy-decisions.md, entry 137): the file goes to the server in
 * parts through /api/storage/multipart, a job converts the stored file, and the browser saves the result from its URL
 * when the job ends, so the result never has to fit in memory. The parts, the job and the upload belong to this call:
 * cancelling it, or any failure, closes whatever of them exists on the server.
 */

import { ConversionOptions } from '../../types';
import { UPLOAD_PART_MAX_BYTES } from '../../plan-limits';

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

const DEFAULT_RESUMABLE_TIMING: ResumableTiming = {
  pollIntervalMs: 1000,
  retryDelayMs: 1000,
  maxWaitMs: 2 * 60 * 60 * 1000,
};

/** Progress shown while the parts go up; the rest is the conversion on the server. */
const UPLOAD_PROGRESS_END = 45;
const FULL_PROGRESS = 100;

const MAX_ATTEMPTS = 4;
const MAX_RETRY_AFTER_MS = 60_000;
/** Answers that say the request was not taken up: the rate limit, and a server that is busy. */
const NOT_TAKEN_STATUSES: ReadonlySet<number> = new Set([429, 503]);
/** Answers after which a request may or may not have been taken up: an edge or a server that failed while it ran. */
const UNKNOWN_STATUSES: ReadonlySet<number> = new Set([502, 504]);
/** The answer to a repeat of a request with an idempotency key while the first one still runs. */
const IN_FLIGHT_STATUS = 409;
/** Refusals of the rate-limit status that last until the next day: the daily quota and the upload budget of a visitor. */
const FINAL_REFUSAL_TYPES: ReadonlySet<string> = new Set([
  'https://api.easyconvert.io/problems/quota-exceeded',
  'https://api.easyconvert.io/problems/upload-budget-exceeded',
]);
const MS_PER_SECOND = 1000;

const FINISHED_JOB_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

/** The result the browser saves: the URL of the converted file on the server and its size. */
export interface ResumableConversionResult {
  url: string;
  size: number;
}

interface PartReceipt {
  partNumber: number;
  etag: string;
}

type Body = Record<string, unknown>;

/** A request that creates something on the server, sent with an idempotency key so it can be repeated and asked again. */
interface CreationRequest {
  url: string;
  payload: Body;
  idempotencyKey: string;
}

/** What exists on the server at each point of the call, so a cancellation or a failure closes exactly that. */
type ServerStage =
  | { kind: 'none' }
  | { kind: 'opening'; request: CreationRequest }
  | { kind: 'uploading'; uploadId: string }
  | { kind: 'stored'; storageKey: string }
  | { kind: 'starting'; storageKey: string; request: CreationRequest }
  | { kind: 'queued'; jobId: string }
  | { kind: 'finished' };

interface CallState {
  stage: ServerStage;
}

/**
 * How a request may be sent again. `once`: only after an answer that says it was not taken up. `repeatable`: also after
 * a network error or an answer that does not say, since sending it twice gives the same result (a part, a read).
 * `idempotent`: as repeatable, and after the 409 of a repeat that met the first one still running, since the server
 * answers a repeat of its idempotency key with the first answer.
 */
type SendPolicy = 'once' | 'repeatable' | 'idempotent';

function abortError(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException('The conversion was cancelled.', 'AbortError');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
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

/** Whether a refusal holds until the next day, so sending the request again cannot change it: the quota or the upload budget. */
async function isFinalRefusal(res: Response): Promise<boolean> {
  const body = (await res.clone().json().catch(() => ({}))) as Body;
  return typeof body.type === 'string' && FINAL_REFUSAL_TYPES.has(body.type);
}

async function shouldSendAgain(res: Response, policy: SendPolicy): Promise<boolean> {
  if (NOT_TAKEN_STATUSES.has(res.status)) return !(await isFinalRefusal(res));
  if (policy !== 'once' && UNKNOWN_STATUSES.has(res.status)) return true;
  return policy === 'idempotent' && res.status === IN_FLIGHT_STATUS;
}

/** Sends a request, and sends it again as its policy allows, at most MAX_ATTEMPTS times. A cancellation is never sent again. */
async function sendWithRetry(
  send: () => Promise<Response>,
  signal: AbortSignal | undefined,
  timing: ResumableTiming,
  policy: SendPolicy
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let res: Response | undefined;
    try {
      res = await send();
    } catch (err) {
      if (signal?.aborted || attempt === MAX_ATTEMPTS || policy === 'once') throw err;
    }
    if (res && (attempt === MAX_ATTEMPTS || !(await shouldSendAgain(res, policy)))) return res;
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

function postJson(url: string, payload: unknown, init: { signal?: AbortSignal; idempotencyKey?: string; keepalive?: boolean } = {}): () => Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  return () => fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: init.signal, keepalive: init.keepalive });
}

function readString(body: Body, field: string, action: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value === '') throw new Error(`${action} gave no ${field}.`);
  return value;
}

function creationRequest(url: string, payload: Body): CreationRequest {
  return { url, payload, idempotencyKey: crypto.randomUUID() };
}

/** Whether an answer says what the request did: anything but an edge failure or a repeat that met the first one running. */
function settlesOutcome(res: Response): boolean {
  return !UNKNOWN_STATUSES.has(res.status) && res.status !== IN_FLIGHT_STATUS;
}

/**
 * Sends a creation request and waits for its answer even when the call is cancelled meanwhile, so that what it created
 * is known and can be closed; a cancellation stops only the waits between attempts. `onRefused` runs when the server
 * answered that it created nothing.
 */
async function create(
  request: CreationRequest,
  action: string,
  hooks: ResumableHooks,
  timing: ResumableTiming,
  onRefused: () => void
): Promise<Body> {
  const res = await sendWithRetry(postJson(request.url, request.payload, { idempotencyKey: request.idempotencyKey }), hooks.signal, timing, 'idempotent');
  if (!res.ok && settlesOutcome(res)) onRefused();
  return readBody(res, action);
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
    'repeatable'
  );
  const body = await readBody(res, `Uploading part ${partNumber}`);
  return { partNumber, etag: readString(body, 'etag', `Uploading part ${partNumber}`) };
}

async function uploadInParts(file: File, call: CallState, hooks: ResumableHooks, timing: ResumableTiming): Promise<string> {
  const { signal } = hooks;
  throwIfAborted(signal);
  const opening = creationRequest(`${MULTIPART_URL}?action=initiate`, {
    filename: file.name,
    mimeType: file.type || 'application/octet-stream',
    totalSize: file.size,
    partSize: UPLOAD_PART_MAX_BYTES,
  });
  call.stage = { kind: 'opening', request: opening };
  const opened = await create(opening, 'Starting the upload', hooks, timing, () => {
    call.stage = { kind: 'none' };
  });
  const uploadId = readString(opened, 'uploadId', 'Starting the upload');
  call.stage = { kind: 'uploading', uploadId };
  throwIfAborted(signal);
  const partBytes = typeof opened.partSize === 'number' && opened.partSize > 0 ? opened.partSize : UPLOAD_PART_MAX_BYTES;

  const receipts: PartReceipt[] = [];
  for (let start = 0; start < file.size; start += partBytes) {
    receipts.push(await sendPart(uploadId, receipts.length + 1, file.slice(start, start + partBytes), signal, timing));
    hooks.onProgress(Math.round((Math.min(start + partBytes, file.size) / file.size) * UPLOAD_PROGRESS_END));
  }

  // The completion is not cut short by a cancellation: its answer names the stored file, which is then given up.
  const completed = await readBody(
    await sendWithRetry(postJson(`${MULTIPART_URL}?action=complete`, { uploadId, parts: receipts }), signal, timing, 'once'),
    'Finishing the upload'
  );
  const storageKey = readString(completed, 'key', 'Finishing the upload');
  call.stage = { kind: 'stored', storageKey };
  throwIfAborted(signal);
  return storageKey;
}

/** The conversion a job is started for: the stored file and what to make of it. */
interface JobOrder {
  file: File;
  storageKey: string;
  targetFormat: string;
  options: ConversionOptions;
}

async function startJob(
  { file, storageKey, targetFormat, options }: JobOrder,
  call: CallState,
  hooks: ResumableHooks,
  timing: ResumableTiming
): Promise<string> {
  const starting = creationRequest(JOBS_URL, { filename: file.name, targetFormat, options, storageKey, fileSize: file.size });
  call.stage = { kind: 'starting', storageKey, request: starting };
  const started = await create(starting, 'Starting the conversion', hooks, timing, () => {
    call.stage = { kind: 'stored', storageKey };
  });
  const jobId = readString(started, 'jobId', 'Starting the conversion');
  call.stage = { kind: 'queued', jobId };
  throwIfAborted(hooks.signal);
  return jobId;
}

/** Reads the job until it ends; returns the result of a job that completed. */
async function waitForResult(jobId: string, call: CallState, hooks: ResumableHooks, timing: ResumableTiming): Promise<ResumableConversionResult> {
  const giveUpAt = Date.now() + timing.maxWaitMs;
  for (;;) {
    const res = await sendWithRetry(
      () => fetch(`${JOBS_URL}/${encodeURIComponent(jobId)}`, { cache: 'no-store', signal: hooks.signal }),
      hooks.signal,
      timing,
      'repeatable'
    );
    const job = await readBody(res, 'Reading the conversion');
    const jobState = String(job.state);
    if (FINISHED_JOB_STATES.has(jobState)) call.stage = { kind: 'finished' };
    if (jobState === 'completed') {
      const result = (job.returnvalue ?? {}) as Body;
      return { url: readString(result, 'downloadUrl', 'The conversion'), size: typeof result.size === 'number' ? result.size : 0 };
    }
    if (call.stage.kind === 'finished') {
      throw new Error(typeof job.failedReason === 'string' && job.failedReason ? job.failedReason : 'The conversion failed.');
    }
    const jobProgress = typeof job.progress === 'number' ? Math.min(Math.max(job.progress, 0), FULL_PROGRESS) : 0;
    hooks.onProgress(Math.round(UPLOAD_PROGRESS_END + (jobProgress / FULL_PROGRESS) * (FULL_PROGRESS - UPLOAD_PROGRESS_END)));
    if (Date.now() >= giveUpAt) throw new Error('The conversion did not finish in time. Try again.');
    await sleep(timing.pollIntervalMs, hooks.signal);
  }
}

/** A request that closes something, sent so that it outlives the page; nothing here can fail the call that is already failing. */
function sendQuietly(request: Promise<unknown>): Promise<void> {
  return request.then(
    () => undefined,
    () => undefined
  );
}

function abortUpload(uploadId: string): Promise<void> {
  return sendQuietly(postJson(`${MULTIPART_URL}?action=abort`, { uploadId }, { keepalive: true })());
}

function discardUpload(storageKey: string): Promise<void> {
  return sendQuietly(postJson(`${MULTIPART_URL}?action=discard`, { key: storageKey }, { keepalive: true })());
}

function cancelJob(jobId: string): Promise<void> {
  return sendQuietly(fetch(`${JOBS_URL}/${encodeURIComponent(jobId)}`, { method: 'DELETE', keepalive: true }));
}

/** Asks again with the idempotency key what a creation request whose answer was lost made: the server repeats its answer. */
async function askAgain(request: CreationRequest, field: string): Promise<string | undefined> {
  try {
    const res = await postJson(request.url, request.payload, { idempotencyKey: request.idempotencyKey, keepalive: true })();
    const body = (await res.json().catch(() => ({}))) as Body;
    return res.ok && typeof body[field] === 'string' ? (body[field] as string) : undefined;
  } catch {
    return undefined;
  }
}

/** Closes what a cancelled or failed call left on the server. */
async function releaseServerState(stage: ServerStage): Promise<void> {
  switch (stage.kind) {
    case 'opening': {
      const uploadId = await askAgain(stage.request, 'uploadId');
      if (uploadId) await abortUpload(uploadId);
      return;
    }
    case 'uploading':
      return abortUpload(stage.uploadId);
    case 'stored':
      return discardUpload(stage.storageKey);
    case 'starting': {
      const jobId = await askAgain(stage.request, 'jobId');
      return jobId ? cancelJob(jobId) : discardUpload(stage.storageKey);
    }
    case 'queued':
      return cancelJob(stage.jobId);
    case 'none':
    case 'finished':
      return;
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
): Promise<ResumableConversionResult> {
  const call: CallState = { stage: { kind: 'none' } };
  try {
    hooks.onStage?.('uploading');
    const storageKey = await uploadInParts(file, call, hooks, timing);
    hooks.onStage?.('converting');
    const jobId = await startJob({ file, storageKey, targetFormat, options }, call, hooks, timing);
    const result = await waitForResult(jobId, call, hooks, timing);
    hooks.onProgress(FULL_PROGRESS);
    return result;
  } catch (err) {
    void releaseServerState(call.stage);
    throw err;
  }
}
