import crypto from 'node:crypto';
import type Redis from 'ioredis';
import { redisKeyStore } from '../api-keys/redis-key-store';
import type { UploadedPart } from '../types';
import { PART_IN_FLIGHT_STATUS } from '../part-in-flight';
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
  /** The size of each stored part, by part number; filled once `loaded` settles. */
  stored: Map<number, number>;
  /** The most bytes the attempt on the way of each part number may write. */
  onTheWay: Map<number, number>;
  usedAt: number;
  /** The one read of the stored parts of the session, which every request that comes first waits for. */
  loaded: Promise<void>;
}

const HTTP_PAYLOAD_TOO_LARGE = 413;
/** A ledger with no part on the way that was not used for this long is dropped; its next part reads the store again. */
const IDLE_LEDGER_MS = 60 * 60 * 1000;
const LEDGER_SWEEP_INTERVAL_MS = 60 * 1000;
const DISTRIBUTED_PART_LOCK_TTL_MS = 10 * 60 * 1000;
const DISTRIBUTED_LEDGER_TTL_SECONDS = 86_400;
const PART_IN_FLIGHT_DETAIL = 'This part is still being received from an earlier request. Send it again once that request ends.';

const RELEASE_INFLIGHT_PART_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

function uploadSessionDigest(uploadId: string): string {
  return crypto.createHash('sha256').update(uploadId).digest('hex').slice(0, 32);
}

function resolveDistributedRedis(storage: PartStore, override?: Redis | null): Redis | null {
  if (override !== undefined) return override;
  if ((storage as { kind?: string }).kind !== 'remote') return null;
  return redisKeyStore.getRedisClient();
}

const ledgers = new Map<string, SessionLedger>();
let nextSweepAt = 0;

/** A part this process refused before writing it: 413 when the session has no room for it, 503 when an earlier attempt of the same part is still being written. */
export class PartRefusedError extends Error {
  constructor(
    readonly statusCode: typeof HTTP_PAYLOAD_TOO_LARGE | typeof PART_IN_FLIGHT_STATUS,
    message: string
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

async function readStoredParts(storage: PartStore, uploadId: string, stored: Map<number, number>): Promise<void> {
  const parts = (await storage.getUploadedParts(uploadId)) ?? [];
  for (const part of parts) stored.set(part.partNumber, part.size);
}

/**
 * The ledger of a session, created by the first request that names it, which starts the one read of the stored parts
 * that all requests of the session wait for. Each request that names it counts as a use, so a ledger whose read is
 * still pending is not swept as idle while parts wait on it. A completion or an abort drops it (`forgetUploadParts`),
 * so a request that already holds it writes against a ledger nobody else sees and fails in the store; a read that
 * failed is not kept.
 */
function ledgerOf(storage: PartStore, uploadId: string): SessionLedger {
  const known = ledgers.get(uploadId);
  if (known) {
    known.usedAt = Date.now();
    return known;
  }
  const stored = new Map<number, number>();
  const ledger: SessionLedger = {
    stored,
    onTheWay: new Map(),
    usedAt: Date.now(),
    loaded: readStoredParts(storage, uploadId, stored).catch((error: unknown) => {
      if (ledgers.get(uploadId) === ledger) ledgers.delete(uploadId);
      throw error;
    }),
  };
  ledgers.set(uploadId, ledger);
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
  if (ledger.onTheWay.has(partNumber)) return new PartRefusedError(PART_IN_FLIGHT_STATUS, PART_IN_FLIGHT_DETAIL);
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

export interface PartRequest {
  uploadId: string;
  partNumber: number;
  /** The length the request declared in its Content-Length, when it declared one. */
  declaredBytes: number | undefined;
  /** The size the session declared when it opened. */
  totalSize: number;
  maxPartBytes: number;
  /** Optional distributed Redis client override for multi-replica admission tests. */
  redisClient?: Redis | null;
}

/**
 * Writes one part of a session through `storage`, admitted against the size the session declared together with every
 * part of it on the way. Throws PartRefusedError for a part the session has no room for (413) and a repeat of a part on the
 * way (503), coordinating across Web replicas via Redis when backed by remote object storage.
 */
export async function receivePart(storage: PartStore, request: PartRequest, body: ReadableStream<Uint8Array>): Promise<UploadedPart> {
  const { uploadId, partNumber, declaredBytes, totalSize, maxPartBytes } = request;
  const ledger = ledgerOf(storage, uploadId);
  await ledger.loaded;

  const redis = resolveDistributedRedis(storage, request.redisClient);
  const digest = redis ? uploadSessionDigest(uploadId) : '';
  const prefix = redis ? redisKeyStore.getPrefix() : '';
  const inflightKey = redis ? `${prefix}mp:inflight:${digest}:${partNumber}` : '';
  const sharedLedgerKey = redis ? `${prefix}mp:ledger:${digest}` : '';
  let lockToken: string | null = null;

  if (redis && typeof (redis as { hgetall?: unknown }).hgetall === 'function') {
    const sharedSizes = await redis.hgetall(sharedLedgerKey);
    for (const [partStr, bytesStr] of Object.entries(sharedSizes)) {
      const pn = Number(partStr);
      const sz = Number(bytesStr);
      if (Number.isInteger(pn) && pn > 0 && Number.isFinite(sz) && sz >= 0) {
        ledger.stored.set(pn, Math.max(ledger.stored.get(pn) ?? 0, sz));
      }
    }
  }

  const admission = admit(ledger, partNumber, declaredBytes, totalSize, maxPartBytes);
  if (admission instanceof PartRefusedError) throw admission;

  if (redis && typeof (redis as { set?: unknown }).set === 'function') {
    lockToken = crypto.randomBytes(16).toString('hex');
    const locked = await redis.set(inflightKey, lockToken, 'PX', DISTRIBUTED_PART_LOCK_TTL_MS, 'NX');
    if (locked !== 'OK') {
      throw new PartRefusedError(PART_IN_FLIGHT_STATUS, PART_IN_FLIGHT_DETAIL);
    }
    if (typeof (redis as { hset?: unknown }).hset === 'function') {
      await redis.hset(sharedLedgerKey, String(partNumber), String(admission.maxBytes));
      await redis.expire?.(sharedLedgerKey, DISTRIBUTED_LEDGER_TTL_SECONDS);
    }
  }

  ledger.onTheWay.set(partNumber, admission.maxBytes);
  let committedSize: number | undefined;
  try {
    const part = await storage.uploadPartStream(uploadId, partNumber, body, admission.maxBytes, totalSize, admission.otherStoredBytes);
    ledger.stored.set(partNumber, part.size);
    committedSize = part.size;
    return part;
  } finally {
    ledger.onTheWay.delete(partNumber);
    ledger.usedAt = Date.now();
    sweepIdleLedgers(ledger.usedAt);
    if (redis) {
      if (committedSize !== undefined && typeof (redis as { hset?: unknown }).hset === 'function') {
        await redis.hset(sharedLedgerKey, String(partNumber), String(committedSize)).catch(() => undefined);
      } else if (committedSize === undefined && typeof (redis as { hdel?: unknown }).hdel === 'function') {
        await redis.hdel(sharedLedgerKey, String(partNumber)).catch(() => undefined);
      }
      if (lockToken && typeof (redis as { eval?: unknown }).eval === 'function') {
        await redis.eval(RELEASE_INFLIGHT_PART_LUA, 1, inflightKey, lockToken).catch(() => undefined);
      }
    }
  }
}

/** Drops the ledger of a session that was completed or aborted. */
export function forgetUploadParts(uploadId: string): void {
  ledgers.delete(uploadId);
  const redis = redisKeyStore.getRedisClient();
  if (redis && typeof (redis as { del?: unknown }).del === 'function') {
    const sharedLedgerKey = `${redisKeyStore.getPrefix()}mp:ledger:${uploadSessionDigest(uploadId)}`;
    void redis.del(sharedLedgerKey).catch(() => undefined);
  }
}
