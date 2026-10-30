import { CONFIG_SCHEMA, ConfigRuleError, parseKind } from '../config/schema';
import { classifyStorageKey } from './key-namespace';

/**
 * Delete-on-delivery retention of conversion results (docs/policy-decisions.md, "Results are deleted
 * after delivery"). A result lives until `deleteAt`:
 *
 * - until RESULT_UNDELIVERED_TTL_SECONDS after it is stored, when nobody downloads it completely;
 * - until RESULT_DELIVERED_GRACE_SECONDS after the first complete delivery, which is one response that sent
 *   the whole body or ranges that together cover every byte. A download that stops early is no delivery.
 *
 * This module is the pure part: the policy, the byte-range bookkeeping and the state transitions of one
 * record. The stores that keep the records and the sweep that deletes the objects are in retention-ledger.ts
 * and retention-service.ts.
 */

export const UNDELIVERED_TTL_VARIABLE = 'RESULT_UNDELIVERED_TTL_SECONDS';
export const DELIVERED_GRACE_VARIABLE = 'RESULT_DELIVERED_GRACE_SECONDS';

const MS_PER_SECOND = 1000;
/** How long the record of a deleted result is kept so that its download can answer 410 instead of 404. */
export const GONE_RECORD_MS = 24 * 60 * 60 * 1000;
/**
 * Most disjoint byte ranges a record remembers. A client that fetches a file in more pieces than this and out
 * of order is never counted as having received it completely, so the file simply expires after the undelivered
 * time instead.
 */
export const MAX_RECEIVED_RANGES = 32;

export interface RetentionPolicy {
  readonly undeliveredTtlMs: number;
  readonly deliveredGraceMs: number;
}

type Env = Readonly<Record<string, string | undefined>>;

/** The integer setting `name` of `env`, or its schema default when unset. A malformed value is a RangeError naming the variable and its rule. */
export function readIntegerSetting(env: Env, name: string): number {
  const spec = CONFIG_SCHEMA.find((candidate) => candidate.name === name);
  if (!spec || spec.kind.type !== 'integer' || typeof spec.default !== 'number') {
    throw new Error(`${name} is not an integer setting with a default in the configuration schema`);
  }
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return spec.default;
  try {
    return parseKind(spec.kind, raw, { production: false }) as number;
  } catch (error) {
    if (error instanceof ConfigRuleError) throw new RangeError(`${name} ${error.rule}`);
    throw error;
  }
}

/** The retention settings of `env`. A set value that is malformed is an error and never falls back to a default. */
export function resolveRetentionPolicy(env: Env = process.env): RetentionPolicy {
  return {
    undeliveredTtlMs: readIntegerSetting(env, UNDELIVERED_TTL_VARIABLE) * MS_PER_SECOND,
    deliveredGraceMs: readIntegerSetting(env, DELIVERED_GRACE_VARIABLE) * MS_PER_SECOND,
  };
}

/** Inclusive byte offsets, `[first, last]`. */
export type ByteInterval = readonly [first: number, last: number];

export interface RetentionRecord {
  key: string;
  size?: number;
  createdAt: number;
  /** When the sweep deletes the object. */
  deleteAt: number;
  /** Byte ranges that were sent completely, sorted and not touching each other. */
  received: ByteInterval[];
  deliveredAt?: number;
  goneAt?: number;
  /** Set when the result was deleted before its time because the disk ran full. */
  goneReason?: 'capacity';
  /** A queued or running job reads this result as its input until then. */
  heldUntil?: number;
  /** A sweep could not delete the object; the next attempt waits until then, so the key does not block the others. */
  retryAt?: number;
}

export type RetentionReason = 'delivered' | 'expired' | 'capacity';

/** How long a sweep waits before it tries again to delete an object whose deletion failed. */
export const FAILED_DELETE_RETRY_MS = 5 * 60 * 1000;

/** Whether results under `key` follow the retention rule: job results and a user's synchronous outputs. */
export function isRetainedKey(key: string): boolean {
  const { namespace } = classifyStorageKey(key);
  return namespace === 'job-result' || namespace === 'user-conversion';
}

export function newRecord(key: string, now: number, policy: RetentionPolicy): RetentionRecord {
  return { key, createdAt: now, deleteAt: now + policy.undeliveredTtlMs, received: [] };
}

/** `intervals` with `[first, last]` added; ranges that overlap or touch become one. Undefined when it would exceed MAX_RECEIVED_RANGES. */
export function addInterval(intervals: readonly ByteInterval[], first: number, last: number): ByteInterval[] | undefined {
  const merged: ByteInterval[] = [];
  let start = first;
  let end = last;
  for (const [a, b] of intervals) {
    if (b + 1 < start) {
      merged.push([a, b]);
    } else if (a > end + 1) {
      merged.push([start, end]);
      start = a;
      end = b;
    } else {
      start = Math.min(start, a);
      end = Math.max(end, b);
    }
  }
  merged.push([start, end]);
  return merged.length > MAX_RECEIVED_RANGES ? undefined : merged;
}

export function coversWholeObject(intervals: readonly ByteInterval[], size: number): boolean {
  if (size === 0) return true;
  return intervals.length === 1 && intervals[0][0] === 0 && intervals[0][1] >= size - 1;
}

/**
 * The record after a response sent bytes `[first, last]` of an object of `size` bytes completely. The first
 * time the sent ranges cover the whole object it is delivered, and the object is deleted after the grace period
 * unless the undelivered time ends sooner.
 */
export function recordServedRange(
  record: RetentionRecord,
  range: { first: number; last: number; size: number },
  now: number,
  policy: RetentionPolicy
): RetentionRecord {
  if (record.goneAt !== undefined || record.deliveredAt !== undefined) return record;
  const received = addInterval(record.received, range.first, range.last);
  if (!received) return record;
  const next: RetentionRecord = { ...record, size: range.size, received };
  if (coversWholeObject(received, range.size)) {
    next.deliveredAt = now;
    next.deleteAt = Math.max(Math.min(record.deleteAt, now + policy.deliveredGraceMs), record.heldUntil ?? 0);
  }
  return next;
}

export function markGone(record: RetentionRecord, now: number, reason?: 'capacity'): RetentionRecord {
  if (record.goneAt !== undefined) return record;
  return reason === undefined ? { ...record, goneAt: now } : { ...record, goneAt: now, goneReason: reason };
}

/** The record while a job that reads the result as its input may still run, until `until`: it is neither swept nor deleted for space before then. */
export function holdRecord(record: RetentionRecord, until: number): RetentionRecord {
  if (record.goneAt !== undefined) return record;
  const heldUntil = Math.max(record.heldUntil ?? 0, until);
  return { ...record, heldUntil, deleteAt: Math.max(record.deleteAt, heldUntil) };
}

/** The record after a failed deletion: the sweep tries again after FAILED_DELETE_RETRY_MS. */
export function deferDeletion(record: RetentionRecord, now: number): RetentionRecord {
  return record.goneAt === undefined ? { ...record, retryAt: now + FAILED_DELETE_RETRY_MS } : record;
}

/** When the sweep picks the record up: at `deleteAt`, or later after a failed deletion. */
export function sweepAt(record: RetentionRecord): number {
  return Math.max(record.deleteAt, record.retryAt ?? 0);
}

/** Whether the sweep deletes the object of `record` at `now`. */
export function isSweepDue(record: RetentionRecord, now: number): boolean {
  return record.goneAt === undefined && sweepAt(record) <= now;
}

/** Whether the object of `record` must no longer be served at `now`. */
export function isDeleted(record: RetentionRecord, now: number): boolean {
  return record.goneAt !== undefined || record.deleteAt <= now;
}

export function reasonOf(record: RetentionRecord): RetentionReason {
  if (record.goneReason !== undefined) return record.goneReason;
  return record.deliveredAt === undefined ? 'expired' : 'delivered';
}

/**
 * The results to delete when the disk runs full, in order: delivered results in their grace period, the earliest
 * delivery first, then undelivered results, the oldest first. A result already gone, or held by a queued or running
 * job, is never in the list.
 */
export function capacityEvictionOrder(records: readonly RetentionRecord[], now: number): RetentionRecord[] {
  const live = records.filter((record) => record.goneAt === undefined && !((record.heldUntil ?? 0) > now));
  const delivered = live.filter((record) => record.deliveredAt !== undefined);
  const undelivered = live.filter((record) => record.deliveredAt === undefined);
  delivered.sort((a, b) => (a.deliveredAt as number) - (b.deliveredAt as number));
  undelivered.sort((a, b) => a.createdAt - b.createdAt);
  return [...delivered, ...undelivered];
}
