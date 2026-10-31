import type { NextResponse } from 'next/server';
import { createProblemDetailsResponse } from '../api/problem-details';
import { parseContentLength } from '../api/request-body-limit';
import { STORAGE_RETRY_AFTER_SECONDS, storageErrorResponse } from '../api/storage-error-response';
import type { UploadedPart } from '../types';
import type { MaybePromise } from './oci-storage';

/**
 * The parts of an upload session that are written at once (docs/policy-decisions.md, entry 137). Several requests may
 * carry parts of one session together, and each used to compare only the stored parts with the declared size, so six
 * parts on the way at once could all pass. Here every part on the way is counted: a part is admitted only while the
 * stored parts, the parts on the way and its own length fit the declared size, and it may then write at most that
 * length. One attempt of a part number writes at a time; a repeat while it runs is refused with 503 and `Retry-After`,
 * so a part number holds at most one temporary file.
 * The store sums the stored parts again when it commits one (s3-storage.ts, local-fs-storage.ts), so a part that slipped
 * past this process is removed before it counts.
 *
 * The ledger of a session lives in this process and remembers the sizes of the parts it saw committed, so the store is
 * asked for its part list once per session and process (a ListParts call on an object store), not once per part. Parts
 * that reach an object store through a signed part link (accounts only: an anonymous session gets none) never pass
 * here; for them the bound is `complete`, which assembles only parts that hold exactly the declared size.
 */

/** The store operations a part needs: the sizes of its stored parts, and a bounded write of one part. */
export interface PartStore {
  /** The stored parts of the session, in any order; undefined when the session is unknown. */
  getUploadedParts(uploadId: string): MaybePromise<ReadonlyArray<{ partNumber: number; size: number }> | undefined>;
  uploadPartStream(
    uploadId: string,
    partNumber: number,
    stream: ReadableStream<Uint8Array>,
    maxPartBytes: number,
    maxTotalBytes: number,
    currentSessionBytes: number
  ): Promise<UploadedPart>;
}

interface SessionLedger {
  /** The size of each stored part, by part number. */
  stored: Map<number, number>;
  /** The most bytes the attempt on the way of each part number may write. */
  onTheWay: Map<number, number>;
  usedAt: number;
}

const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_SERVICE_UNAVAILABLE = 503;
/** A ledger with no part on the way that was not used for this long is dropped; its next part reads the store again. */
const IDLE_LEDGER_MS = 60 * 60 * 1000;
const LEDGER_SWEEP_INTERVAL_MS = 60 * 1000;
/**
 * The longest wait for the next bytes of a part: the default `client_body_timeout` of nginx, which times the gap between
 * two reads of a request body, not the whole body, and answers 408 when it passes.
 */
export const PART_IDLE_TIMEOUT_MS = 60 * 1000;

/** The detail of a failure worth sending again; the error, which can name a host or a path, stays in the server log. */
export const UPLOAD_UNAVAILABLE_DETAIL = 'A service this upload needs is temporarily unavailable. Retry the request shortly.';
const PART_IN_FLIGHT_DETAIL = 'This part is still being received from an earlier request. Send it again once that request ends.';
const PART_IDLE_DETAIL = `No bytes of this part arrived for ${PART_IDLE_TIMEOUT_MS / 1000} seconds, so the part was dropped. Send it again.`;

const ledgers = new Map<string, SessionLedger>();
let nextSweepAt = 0;
/** Counts the ledgers dropped by a completion or an abort, so a part list read across one is not kept. */
let forgetCount = 0;

/** A part this process refused before or while writing it: the HTTP status says why, `retryAfterSeconds` when to send it again. */
export class PartRefusedError extends Error {
  constructor(
    readonly statusCode: typeof HTTP_REQUEST_TIMEOUT | typeof HTTP_PAYLOAD_TOO_LARGE | typeof HTTP_SERVICE_UNAVAILABLE,
    message: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
  }
}

function sweepIdleLedgers(now: number): void {
  if (now < nextSweepAt) return;
  nextSweepAt = now + LEDGER_SWEEP_INTERVAL_MS;
  for (const [uploadId, ledger] of ledgers) {
    if (ledger.onTheWay.size === 0 && now - ledger.usedAt > IDLE_LEDGER_MS) ledgers.delete(uploadId);
  }
}

async function ledgerOf(storage: PartStore, uploadId: string): Promise<SessionLedger> {
  const known = ledgers.get(uploadId);
  if (known) return known;
  const forgetsBefore = forgetCount;
  const parts = (await storage.getUploadedParts(uploadId)) ?? [];
  // Another request may have read the store meanwhile; the first ledger is the one every request shares.
  const raced = ledgers.get(uploadId);
  if (raced) return raced;
  const ledger: SessionLedger = { stored: new Map(parts.map((part) => [part.partNumber, part.size])), onTheWay: new Map(), usedAt: Date.now() };
  // A session completed or aborted while its parts were read must not get its ledger back; this part's write then fails in the store.
  if (forgetCount === forgetsBefore) ledgers.set(uploadId, ledger);
  return ledger;
}

interface PartAdmission {
  /** The most bytes the part may write. */
  maxBytes: number;
  /** The bytes of the other stored parts. */
  otherStoredBytes: number;
}

function sumBesides(sizes: ReadonlyMap<number, number>, partNumber: number): number {
  let bytes = 0;
  for (const [number, size] of sizes) if (number !== partNumber) bytes += size;
  return bytes;
}

/**
 * Admits a part of `declaredBytes` (unknown when the request named no length) as part `partNumber`, or says why it is
 * refused. A part of unknown length may write what the other parts leave, up to `maxPartBytes`. Each other part number
 * counts with its stored size or the size of its attempt on the way, whichever is larger, since either may land last.
 */
function admit(ledger: SessionLedger, partNumber: number, declaredBytes: number | undefined, totalSize: number, maxPartBytes: number): PartAdmission | PartRefusedError {
  if (ledger.onTheWay.has(partNumber)) return new PartRefusedError(HTTP_SERVICE_UNAVAILABLE, PART_IN_FLIGHT_DETAIL, STORAGE_RETRY_AFTER_SECONDS);
  const largest = new Map(ledger.stored);
  for (const [number, bytes] of ledger.onTheWay) largest.set(number, Math.max(largest.get(number) ?? 0, bytes));
  const otherPartsBound = sumBesides(largest, partNumber);
  const bytes = declaredBytes ?? Math.min(maxPartBytes, totalSize - otherPartsBound);
  if (bytes <= 0) {
    return new PartRefusedError(HTTP_PAYLOAD_TOO_LARGE, `The other parts of this upload already hold or are bringing the ${totalSize} bytes it declared.`);
  }
  const projectedBytes = otherPartsBound + bytes;
  if (projectedBytes > totalSize) {
    return new PartRefusedError(HTTP_PAYLOAD_TOO_LARGE, `This part would bring the upload to ${projectedBytes} bytes, past the ${totalSize} bytes it declared.`);
  }
  return { maxBytes: bytes, otherStoredBytes: sumBesides(ledger.stored, partNumber) };
}

/**
 * The body of a part that errors once no bytes arrived for `idleMs`, so a body that stops arriving cannot hold its part
 * number and its share of the declared size. Behind the middleware the framework hands a route the body only once it
 * ended (next/dist/server/body-streams.js, `finalize`), and a client that disconnects fails the request before the route
 * runs; this bounds the read wherever a route gets the body as it arrives.
 */
function endingWhenIdle(body: ReadableStream<Uint8Array>, idleMs: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PartRefusedError(HTTP_REQUEST_TIMEOUT, PART_IDLE_DETAIL)), idleMs);
      });
      try {
        const chunk = await Promise.race([reader.read(), idle]);
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      } catch (error) {
        reader.cancel(error).catch(() => undefined);
        controller.error(error);
      } finally {
        clearTimeout(timer);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

export interface PartRequest {
  uploadId: string;
  partNumber: number;
  /** The length the request declared in its Content-Length, when it declared one. */
  declaredBytes: number | undefined;
  /** The size the session declared when it opened. */
  totalSize: number;
  maxPartBytes: number;
}

/**
 * Writes one part of a session through `storage`, admitted against the size the session declared together with every
 * part of it on the way. Throws PartRefusedError for a part the session has no room for (413), a repeat of a part on the
 * way (503) and a body that stopped arriving (408).
 */
export async function receivePart(storage: PartStore, request: PartRequest, body: ReadableStream<Uint8Array>): Promise<UploadedPart> {
  const { uploadId, partNumber, declaredBytes, totalSize, maxPartBytes } = request;
  const ledger = await ledgerOf(storage, uploadId);
  const admission = admit(ledger, partNumber, declaredBytes, totalSize, maxPartBytes);
  if (admission instanceof PartRefusedError) throw admission;
  ledger.onTheWay.set(partNumber, admission.maxBytes);
  try {
    const part = await storage.uploadPartStream(
      uploadId,
      partNumber,
      endingWhenIdle(body, PART_IDLE_TIMEOUT_MS),
      admission.maxBytes,
      totalSize,
      admission.otherStoredBytes
    );
    ledger.stored.set(partNumber, part.size);
    return part;
  } finally {
    ledger.onTheWay.delete(partNumber);
    ledger.usedAt = Date.now();
    sweepIdleLedgers(ledger.usedAt);
  }
}

/** Drops the ledger of a session that was completed or aborted. */
export function forgetUploadParts(uploadId: string): void {
  forgetCount += 1;
  ledgers.delete(uploadId);
}

/** The length a part request declared, when its Content-Length is a whole number of bytes (the route refused any other). */
export function declaredPartBytes(headers: Pick<Headers, 'get'>): number | undefined {
  const declared = parseContentLength(headers.get('content-length'));
  return declared.kind === 'bytes' ? declared.bytes : undefined;
}

/** The message of `error` when it names no path, else `fallback`: a path on this host stays in the server log. */
function messageWithoutPath(error: unknown, fallback: string): string {
  return error instanceof Error && error.message && !error.message.includes('/') && !error.message.includes('\\') ? error.message : fallback;
}

/**
 * The answer to a part that could not be written: the problem of a storage error, the status a refusal or a bound of the
 * store gave the error, or else 503 with `Retry-After`, since the store could not be reached and the part is worth
 * sending again.
 */
export function partFailureResponse(error: unknown, instanceUri: string, extraHeaders: Record<string, string> = {}): NextResponse {
  const storageProblem = storageErrorResponse(error, instanceUri, extraHeaders);
  if (storageProblem) return storageProblem;
  if (error instanceof PartRefusedError) {
    const headers = error.retryAfterSeconds === undefined ? extraHeaders : { 'Retry-After': String(error.retryAfterSeconds), ...extraHeaders };
    const title = error.statusCode === HTTP_REQUEST_TIMEOUT ? 'Request Timeout' : undefined;
    return createProblemDetailsResponse(error.statusCode, error.message, instanceUri, title, undefined, headers);
  }
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === 'number') {
    return createProblemDetailsResponse(status, messageWithoutPath(error, 'The part could not be stored.'), instanceUri, undefined, undefined, extraHeaders);
  }
  console.error('[parts] A part could not be written:', error);
  return createProblemDetailsResponse(HTTP_SERVICE_UNAVAILABLE, UPLOAD_UNAVAILABLE_DETAIL, instanceUri, undefined, undefined, {
    'Retry-After': String(STORAGE_RETRY_AFTER_SECONDS),
    ...extraHeaders,
  });
}
