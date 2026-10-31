import type { UploadedPart } from '../types';
import type { IStorageBackend } from './oci-storage';

/**
 * The parts of an upload session that are written at once (docs/policy-decisions.md, entry 137). Several requests may
 * carry parts of one session together, and each used to compare only the stored parts with the declared size, so six
 * parts on the way at once could all pass. Here every part on the way is counted: a part is admitted only while the
 * stored parts, the parts on the way and its own length fit the declared size, and it may then write at most that
 * length. The store sums the stored parts again when it commits one (s3-storage.ts), so a part that slipped past this
 * process is removed before it counts.
 *
 * The ledger of a session lives in this process and remembers the sizes of the parts it saw committed, so the store is
 * asked for its part list once per session and process (a ListParts call on an object store), not once per part.
 */

/** The store operations a part needs: its part list, and a bounded write of one part. */
export type PartStore = Required<Pick<IStorageBackend, 'getUploadedParts' | 'uploadPartStream'>>;

interface PartAttempt {
  partNumber: number;
  bytes: number;
}

interface SessionLedger {
  /** The size of each stored part, by part number. */
  stored: Map<number, number>;
  /** The parts on the way, by attempt, each with the most bytes it may write. */
  attempts: Map<number, PartAttempt>;
  usedAt: number;
}

const HTTP_PAYLOAD_TOO_LARGE = 413;
/** A ledger with no part on the way that was not used for this long is dropped; its next part reads the store again. */
const IDLE_LEDGER_MS = 60 * 60 * 1000;
const LEDGER_SWEEP_INTERVAL_MS = 60 * 1000;

const ledgers = new Map<string, SessionLedger>();
let nextAttemptId = 0;
let nextSweepAt = 0;

/** A part refused because the session would hold more than it declared once it lands. */
export class PartOverDeclaredSizeError extends Error {
  readonly statusCode = HTTP_PAYLOAD_TOO_LARGE;
}

function sweepIdleLedgers(now: number): void {
  if (now < nextSweepAt) return;
  nextSweepAt = now + LEDGER_SWEEP_INTERVAL_MS;
  for (const [uploadId, ledger] of ledgers) {
    if (ledger.attempts.size === 0 && now - ledger.usedAt > IDLE_LEDGER_MS) ledgers.delete(uploadId);
  }
}

async function ledgerOf(storage: PartStore, uploadId: string): Promise<SessionLedger> {
  const known = ledgers.get(uploadId);
  if (known) return known;
  const parts = (await storage.getUploadedParts(uploadId)) ?? [];
  // Another request may have read the store meanwhile; the first ledger is the one every request shares.
  const raced = ledgers.get(uploadId);
  if (raced) return raced;
  const ledger: SessionLedger = { stored: new Map(parts.map((part) => [part.partNumber, part.size])), attempts: new Map(), usedAt: Date.now() };
  ledgers.set(uploadId, ledger);
  return ledger;
}

/**
 * The most bytes each part number can end with: its stored size or the size of an attempt on the way, whichever is
 * larger, since any of them may be the one that lands last.
 */
function largestByPart(ledger: SessionLedger): Map<number, number> {
  const largest = new Map(ledger.stored);
  for (const attempt of ledger.attempts.values()) {
    largest.set(attempt.partNumber, Math.max(largest.get(attempt.partNumber) ?? 0, attempt.bytes));
  }
  return largest;
}

interface PartAdmission {
  /** The most bytes the part may write. */
  maxBytes: number;
  /** The bytes of the other stored parts. */
  otherStoredBytes: number;
}

/**
 * Admits a part of `declaredBytes` (unknown when the request named no length) as part `partNumber`, or says why the
 * session has no room for it. A part of unknown length may write what the other parts leave, up to `maxPartBytes`.
 */
function admit(
  ledger: SessionLedger,
  partNumber: number,
  declaredBytes: number | undefined,
  totalSize: number,
  maxPartBytes: number
): PartAdmission | { refusal: string } {
  const largest = largestByPart(ledger);
  let otherPartsBound = 0;
  for (const [number, bytes] of largest) if (number !== partNumber) otherPartsBound += bytes;
  const bytes = declaredBytes ?? Math.min(maxPartBytes, totalSize - otherPartsBound);
  if (bytes <= 0) return { refusal: `The other parts of this upload already hold or are bringing the ${totalSize} bytes it declared.` };
  const projectedBytes = otherPartsBound + Math.max(largest.get(partNumber) ?? 0, bytes);
  if (projectedBytes > totalSize) {
    return { refusal: `This part would bring the upload to ${projectedBytes} bytes, past the ${totalSize} bytes it declared.` };
  }
  let otherStoredBytes = 0;
  for (const [number, size] of ledger.stored) if (number !== partNumber) otherStoredBytes += size;
  return { maxBytes: bytes, otherStoredBytes };
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
 * part of it on the way. Throws PartOverDeclaredSizeError (status 413) for a part the session has no room for.
 */
export async function receivePart(storage: PartStore, request: PartRequest, body: ReadableStream<Uint8Array>): Promise<UploadedPart> {
  const { uploadId, partNumber, declaredBytes, totalSize, maxPartBytes } = request;
  const ledger = await ledgerOf(storage, uploadId);
  const admission = admit(ledger, partNumber, declaredBytes, totalSize, maxPartBytes);
  if ('refusal' in admission) throw new PartOverDeclaredSizeError(admission.refusal);
  const attemptId = nextAttemptId++;
  ledger.attempts.set(attemptId, { partNumber, bytes: admission.maxBytes });
  try {
    const part = await storage.uploadPartStream(uploadId, partNumber, body, admission.maxBytes, totalSize, admission.otherStoredBytes);
    ledger.stored.set(partNumber, part.size);
    return part;
  } finally {
    ledger.attempts.delete(attemptId);
    ledger.usedAt = Date.now();
    sweepIdleLedgers(ledger.usedAt);
  }
}

/** Drops the ledger of a session that was completed or aborted. */
export function forgetUploadParts(uploadId: string): void {
  ledgers.delete(uploadId);
}
