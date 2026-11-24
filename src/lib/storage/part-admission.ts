import crypto from 'node:crypto';
import type Redis from 'ioredis';
import { redisKeyStore } from '../api-keys/redis-key-store';
import type { UploadedPart } from '../types';
import { PART_IN_FLIGHT_STATUS } from '../part-in-flight';
import type { MaybePromise } from './types';

/**
 * The parts of an upload session that are written at once (docs/policy-decisions.md, entries 137 & 322).
 *
 * A part is admitted only while the committed parts, the parts currently in flight, and its own length fit the
 * declared session size, and at most one attempt per part number may run at once (`503` with `Retry-After`).
 *
 * When backed by remote object storage (`storage.kind === 'remote'`), `committed` sizes and `inflight` reservations
 * live in two separate single-slot Redis hashes (`{mp:<digest>}:committed` and `{mp:<digest>}:inflight`) updated via
 * atomic Lua scripts so concurrent replicas never over-admit past `totalSize` and uncommitted reservations never
 * stick to `committed` after a smaller commit or failed stream.
 */

export interface PartStore {
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
  stored: Map<number, number>;
  onTheWay: Map<number, number>;
  usedAt: number;
  loaded: Promise<void>;
}

const HTTP_PAYLOAD_TOO_LARGE = 413;
const IDLE_LEDGER_MS = 60 * 60 * 1000;
const LEDGER_SWEEP_INTERVAL_MS = 60 * 1000;
const DISTRIBUTED_PART_LOCK_TTL_MS = 10 * 60 * 1000;
const DISTRIBUTED_LEDGER_TTL_SECONDS = 86_400;
const PART_IN_FLIGHT_DETAIL = 'This part is still being received from an earlier request. Send it again once that request ends.';

/**
 * KEYS[1] = `{mp:<digest>}:committed` (Hash: partNumber -> bytes)
 * KEYS[2] = `{mp:<digest>}:inflight`  (Hash: partNumber -> "<token>:<maxBytes>:<expiresAtMs>")
 * ARGV = [partNumber, hasDeclared("1"|"0"), declaredBytes, totalSize, maxPartBytes, token, nowMs, lockTtlMs, ledgerTtlSec]
 * Returns:
 *   { 1, maxBytes, otherStoredBytes } on admit
 *   { -503, 0, 0 } when partNumber is already in flight
 *   { -413, projectedOrZero, 0 } when budget is exceeded
 */
const ADMIT_REMOTE_PART_LUA = `
local committedKey = KEYS[1]
local inflightKey = KEYS[2]
local targetPart = ARGV[1]
local hasDeclared = ARGV[2] == '1'
local declaredBytes = tonumber(ARGV[3])
local totalSize = tonumber(ARGV[4])
local maxPartBytes = tonumber(ARGV[5])
local token = ARGV[6]
local nowMs = tonumber(ARGV[7])
local lockTtlMs = tonumber(ARGV[8])
local ledgerTtlSec = tonumber(ARGV[9])

local inflightRaw = redis.call('HGETALL', inflightKey)
local inflightByPart = {}
for i = 1, #inflightRaw, 2 do
  local p = inflightRaw[i]
  local val = inflightRaw[i + 1]
  local sep1 = string.find(val, ':', 1, true)
  local sep2 = sep1 and string.find(val, ':', sep1 + 1, true) or nil
  if sep1 and sep2 then
    local bytes = tonumber(string.sub(val, sep1 + 1, sep2 - 1)) or 0
    local exp = tonumber(string.sub(val, sep2 + 1)) or 0
    if exp > nowMs then
      inflightByPart[p] = bytes
    else
      redis.call('HDEL', inflightKey, p)
    end
  end
end

if inflightByPart[targetPart] ~= nil then
  return { -503, 0, 0 }
end

local committedRaw = redis.call('HGETALL', committedKey)
local committedByPart = {}
for i = 1, #committedRaw, 2 do
  committedByPart[committedRaw[i]] = tonumber(committedRaw[i + 1]) or 0
end

local otherPartsBound = 0
local otherStoredBytes = 0
for p, sz in pairs(committedByPart) do
  if p ~= targetPart then
    otherStoredBytes = otherStoredBytes + sz
    local inf = inflightByPart[p] or 0
    otherPartsBound = otherPartsBound + math.max(sz, inf)
  end
end
for p, inf in pairs(inflightByPart) do
  if p ~= targetPart and committedByPart[p] == nil then
    otherPartsBound = otherPartsBound + inf
  end
end

local bytes = hasDeclared and declaredBytes or math.min(maxPartBytes, totalSize - otherPartsBound)
if bytes <= 0 then
  return { -413, 0, 0 }
end
local projected = otherPartsBound + bytes
if projected > totalSize then
  return { -413, projected, 0 }
end

redis.call('HSET', inflightKey, targetPart, token .. ':' .. tostring(bytes) .. ':' .. tostring(nowMs + lockTtlMs))
redis.call('EXPIRE', inflightKey, ledgerTtlSec)
redis.call('EXPIRE', committedKey, ledgerTtlSec)
return { 1, bytes, otherStoredBytes }
`;

/**
 * KEYS[1] = `{mp:<digest>}:committed`
 * KEYS[2] = `{mp:<digest>}:inflight`
 * ARGV = [partNumber, token, hasCommitted("1"|"0"), committedBytes, ledgerTtlSec]
 */
const SETTLE_REMOTE_PART_LUA = `
local committedKey = KEYS[1]
local inflightKey = KEYS[2]
local targetPart = ARGV[1]
local token = ARGV[2]
local hasCommitted = ARGV[3] == '1'
local committedBytes = ARGV[4]
local ledgerTtlSec = tonumber(ARGV[5])

local cur = redis.call('HGET', inflightKey, targetPart)
if cur and string.sub(cur, 1, #token + 1) == (token .. ':') then
  redis.call('HDEL', inflightKey, targetPart)
end
if hasCommitted then
  redis.call('HSET', committedKey, targetPart, committedBytes)
  redis.call('EXPIRE', committedKey, ledgerTtlSec)
end
return 1
`;

function uploadSessionDigest(uploadId: string): string {
  return crypto.createHash('sha256').update(uploadId).digest('hex').slice(0, 32);
}

function distributedKeysOf(prefix: string, uploadId: string): { committedKey: string; inflightKey: string } {
  const tag = `{mp:${uploadSessionDigest(uploadId)}}`;
  return {
    committedKey: `${prefix}${tag}:committed`,
    inflightKey: `${prefix}${tag}:inflight`,
  };
}

function resolveDistributedRedis(storage: PartStore, override?: Redis | null): Redis | null {
  if (override !== undefined) return override;
  if ((storage as { kind?: string }).kind !== 'remote') return null;
  const client = redisKeyStore.getRedisClient();
  const status = (client as { status?: string } | null)?.status;
  if (status !== undefined && status !== 'ready') return null;
  return client;
}

const ledgers = new Map<string, SessionLedger>();
let nextSweepAt = 0;

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
  maxBytes: number;
  otherStoredBytes: number;
}

function sumBesides(sizes: ReadonlyMap<number, number>, partNumber: number): number {
  let bytes = 0;
  for (const [number, size] of sizes) if (number !== partNumber) bytes += size;
  return bytes;
}

function refusalForProjectedBytes(projectedBytes: number, totalSize: number): PartRefusedError {
  if (projectedBytes <= 0) {
    return new PartRefusedError(
      HTTP_PAYLOAD_TOO_LARGE,
      `The other parts of this upload already hold or are bringing the ${totalSize} bytes it declared.`
    );
  }
  return new PartRefusedError(
    HTTP_PAYLOAD_TOO_LARGE,
    `This part would bring the upload to ${projectedBytes} bytes, past the ${totalSize} bytes it declared.`
  );
}

function admitLocally(
  ledger: SessionLedger,
  partNumber: number,
  declaredBytes: number | undefined,
  totalSize: number,
  maxPartBytes: number
): PartAdmission | PartRefusedError {
  if (ledger.onTheWay.has(partNumber)) return new PartRefusedError(PART_IN_FLIGHT_STATUS, PART_IN_FLIGHT_DETAIL);
  const largest = new Map(ledger.stored);
  for (const [number, bytes] of ledger.onTheWay) largest.set(number, Math.max(largest.get(number) ?? 0, bytes));
  const otherPartsBound = sumBesides(largest, partNumber);
  const bytes = declaredBytes ?? Math.min(maxPartBytes, totalSize - otherPartsBound);
  if (bytes <= 0) return refusalForProjectedBytes(0, totalSize);
  const projectedBytes = otherPartsBound + bytes;
  if (projectedBytes > totalSize) return refusalForProjectedBytes(projectedBytes, totalSize);
  return { maxBytes: bytes, otherStoredBytes: sumBesides(ledger.stored, partNumber) };
}

export interface PartRequest {
  uploadId: string;
  partNumber: number;
  declaredBytes: number | undefined;
  totalSize: number;
  maxPartBytes: number;
  redisClient?: Redis | null;
}

async function seedRedisCommittedFromListParts(
  redis: Redis,
  committedKey: string,
  stored: ReadonlyMap<number, number>
): Promise<void> {
  if (stored.size === 0 || typeof (redis as { hsetnx?: unknown }).hsetnx !== 'function') return;
  await Promise.all(
    [...stored.entries()].map(([pn, sz]) => redis.hsetnx(committedKey, String(pn), String(sz)).catch(() => 0))
  );
}

export async function receivePart(storage: PartStore, request: PartRequest, body: ReadableStream<Uint8Array>): Promise<UploadedPart> {
  const { uploadId, partNumber, declaredBytes, totalSize, maxPartBytes } = request;
  const ledger = ledgerOf(storage, uploadId);
  await ledger.loaded;

  const redis = resolveDistributedRedis(storage, request.redisClient);
  if (redis && typeof (redis as { eval?: unknown }).eval === 'function') {
    if (ledger.onTheWay.has(partNumber)) throw new PartRefusedError(PART_IN_FLIGHT_STATUS, PART_IN_FLIGHT_DETAIL);
    const { committedKey, inflightKey } = distributedKeysOf(redisKeyStore.getPrefix(), uploadId);
    await seedRedisCommittedFromListParts(redis, committedKey, ledger.stored);

    const token = crypto.randomBytes(16).toString('hex');
    const rawReply = (await redis.eval(
      ADMIT_REMOTE_PART_LUA,
      2,
      committedKey,
      inflightKey,
      String(partNumber),
      declaredBytes === undefined ? '0' : '1',
      String(declaredBytes ?? 0),
      String(totalSize),
      String(maxPartBytes),
      token,
      String(Date.now()),
      String(DISTRIBUTED_PART_LOCK_TTL_MS),
      String(DISTRIBUTED_LEDGER_TTL_SECONDS)
    )) as [number, number, number];

    const [status, valueA, valueB] = rawReply;
    if (status === -503) throw new PartRefusedError(PART_IN_FLIGHT_STATUS, PART_IN_FLIGHT_DETAIL);
    if (status === -413) throw refusalForProjectedBytes(valueA, totalSize);

    const admission: PartAdmission = { maxBytes: Number(valueA), otherStoredBytes: Number(valueB) };
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
      await redis
        .eval(
          SETTLE_REMOTE_PART_LUA,
          2,
          committedKey,
          inflightKey,
          String(partNumber),
          token,
          committedSize === undefined ? '0' : '1',
          String(committedSize ?? 0),
          String(DISTRIBUTED_LEDGER_TTL_SECONDS)
        )
        .catch(() => undefined);
    }
  }

  const admission = admitLocally(ledger, partNumber, declaredBytes, totalSize, maxPartBytes);
  if (admission instanceof PartRefusedError) throw admission;
  ledger.onTheWay.set(partNumber, admission.maxBytes);
  try {
    const part = await storage.uploadPartStream(uploadId, partNumber, body, admission.maxBytes, totalSize, admission.otherStoredBytes);
    ledger.stored.set(partNumber, part.size);
    return part;
  } finally {
    ledger.onTheWay.delete(partNumber);
    ledger.usedAt = Date.now();
    sweepIdleLedgers(ledger.usedAt);
  }
}

export function forgetUploadParts(uploadId: string): void {
  ledgers.delete(uploadId);
  const redis = redisKeyStore.getRedisClient();
  const status = (redis as { status?: string } | null)?.status;
  if (redis && (status === undefined || status === 'ready') && typeof (redis as { del?: unknown }).del === 'function') {
    const { committedKey, inflightKey } = distributedKeysOf(redisKeyStore.getPrefix(), uploadId);
    void redis.del(committedKey, inflightKey).catch(() => undefined);
  }
}
