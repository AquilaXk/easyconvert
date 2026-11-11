import type Redis from 'ioredis';
import { whenReady } from '../redis/when-ready';
import type { WebhookDlqEntry } from './types';

/**
 * Where the webhook dead letters live. Redis holds each entry once, as JSON in the hash `HASH` (id -> entry), and three kinds of
 * sorted set that index it by the time it failed, so a request reads the page it shows and never the whole queue:
 *
 * - `HASH:owner:{<userId>}`: the ids of one user's entries. The `{<userId>}` tag keeps the account's keys in one cluster slot,
 *   and `erase-account` finds the set with the rest of them. It expires a day after the last entry it could hold.
 * - `HASH:expiry`: the ids of every entry, so the retention sweep reads only the entries whose time has passed.
 * - `HASH:ownerless`: the ids of entries recorded without an owner, which no caller can reach and which are purged.
 *
 * The hash and the sets are separate keys, so a write is a pipeline, not a script: the sets are written first and removed last (the client may not be connected yet, and a pipeline does not wait for it, so each call waits first),
 * which can leave an id in a set without an entry (the listing that meets it drops it) and never an entry nobody can list. An
 * entry written without its index (by an older build) is found by `reconcile`, which runs when the hash holds more entries than
 * the expiry set. Without Redis, or when it does not answer, the entries stay in `memory`.
 */
const HASH = 'easyconvert:webhook:dlq';
const EXPIRY_INDEX = `${HASH}:expiry`;
const OWNERLESS_INDEX = `${HASH}:ownerless`;
const BATCH = 500;
const OWNER_INDEX_SLACK_MS = 24 * 60 * 60 * 1000;
/** Entries a listing returns when the caller names no page size, and the most it returns. */
export const DLQ_PAGE_DEFAULT = 100;
export const DLQ_PAGE_MAX = 500;
/** A reconcile reads the whole hash; a process starts one at most this often. */
const RECONCILE_MIN_INTERVAL_MS = 10_000;

export interface DlqPage {
  entries: WebhookDlqEntry[];
  /** Entries the owner has in all (not expired, unless the page includes them), of which `entries` is a page. */
  total: number;
}

export interface DlqPageOptions {
  includeExpired?: boolean;
  limit?: number;
  offset?: number;
}

function ownerIndex(ownerUserId: string): string {
  return `${HASH}:owner:{${ownerUserId.replace(/[{}]/g, '_')}}`;
}

function parseEntry(raw: string | null | undefined): WebhookDlqEntry | undefined {
  if (!raw) return undefined;
  try {
    const entry = JSON.parse(raw) as Partial<WebhookDlqEntry> | null;
    return entry && typeof entry.id === 'string' && typeof entry.failedAt === 'number' ? (entry as WebhookDlqEntry) : undefined;
  } catch {
    return undefined;
  }
}

/** The replies of a pipeline, or the first error of one of its commands. */
async function replies(pipeline: ReturnType<Redis['pipeline']>): Promise<unknown[]> {
  const results = (await pipeline.exec()) ?? [];
  for (const [error] of results) if (error) throw error;
  return results.map(([, reply]) => reply);
}

function groupByOwner(entries: readonly Pick<WebhookDlqEntry, 'id' | 'ownerUserId'>[]): { owned: Map<string, string[]>; ownerless: string[] } {
  const owned = new Map<string, string[]>();
  const ownerless: string[] = [];
  for (const entry of entries) {
    if (!entry.ownerUserId) ownerless.push(entry.id);
    else owned.set(entry.ownerUserId, [...(owned.get(entry.ownerUserId) ?? []), entry.id]);
  }
  return { owned, ownerless };
}

export class WebhookDlqStore {
  private reconciling: Promise<void> | undefined;
  private lastReconcileAt = 0;

  constructor(
    private readonly memory: Map<string, WebhookDlqEntry>,
    private readonly client: () => Redis | null,
    private readonly retentionMs: number
  ) {}

  private isExpired(entry: WebhookDlqEntry, now: number): boolean {
    return !(entry.failedAt > now - this.retentionMs);
  }

  async put(entry: WebhookDlqEntry): Promise<void> {
    const redis = this.client();
    if (redis) {
      try {
        await whenReady(redis);
        const pipeline = redis.pipeline().zadd(EXPIRY_INDEX, entry.failedAt, entry.id);
        if (entry.ownerUserId) {
          const key = ownerIndex(entry.ownerUserId);
          pipeline.zadd(key, entry.failedAt, entry.id).pexpire(key, this.retentionMs + OWNER_INDEX_SLACK_MS);
        } else {
          pipeline.zadd(OWNERLESS_INDEX, entry.failedAt, entry.id);
        }
        await replies(pipeline.hset(HASH, entry.id, JSON.stringify(entry)));
        return;
      } catch {
        // Fallback to in-memory
      }
    }
    this.memory.set(entry.id, entry);
  }

  /** The stored entry, expired or not, or null. */
  async get(id: string): Promise<WebhookDlqEntry | null> {
    const redis = this.client();
    if (redis) {
      try {
        const entry = parseEntry(await redis.hget(HASH, id));
        if (entry) return entry;
      } catch {
        // Fallback to in-memory
      }
    }
    return this.memory.get(id) ?? null;
  }

  /** A page of the entries `ownerUserId` owns, newest first. It also purges the entries recorded without an owner. */
  async page(ownerUserId: string, options: DlqPageOptions = {}, now: number = Date.now()): Promise<DlqPage> {
    const limit = Math.min(DLQ_PAGE_MAX, Math.max(1, Math.floor(options.limit ?? DLQ_PAGE_DEFAULT)));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const redis = this.client();
    if (redis) {
      try {
        await whenReady(redis);
        return await this.redisPage(redis, ownerUserId, { includeExpired: options.includeExpired === true, limit, offset }, now);
      } catch {
        // Fallback to in-memory
      }
    }
    return this.memoryPage(ownerUserId, { includeExpired: options.includeExpired === true, limit, offset }, now);
  }

  private async redisPage(
    redis: Redis,
    ownerUserId: string,
    page: Required<DlqPageOptions>,
    now: number,
    reconciled = false
  ): Promise<DlqPage> {
    const key = ownerIndex(ownerUserId);
    const minScore = page.includeExpired ? '-inf' : `(${now - this.retentionMs}`;
    const [ids, total, ownerless, stored, indexed] = (await replies(
      redis
        .pipeline()
        .zrevrangebyscore(key, '+inf', minScore, 'LIMIT', page.offset, page.limit)
        .zcount(key, minScore, '+inf')
        .zrange(OWNERLESS_INDEX, '0', String(BATCH - 1))
        .hlen(HASH)
        .zcard(EXPIRY_INDEX)
    )) as [string[], number, string[], number, number];
    if (ownerless.length > 0) await this.purgeOwnerless(redis, ownerless);
    if (!reconciled && stored > indexed) {
      await this.reconcile(redis);
      return this.redisPage(redis, ownerUserId, page, now, true);
    }
    if (!ownerUserId || ids.length === 0) return { entries: [], total: ownerUserId ? total : 0 };

    const raws = await redis.hmget(HASH, ...ids);
    const entries: WebhookDlqEntry[] = [];
    const gone: string[] = [];
    const strays: string[] = [];
    raws.forEach((raw, position) => {
      const entry = parseEntry(raw);
      if (!entry) gone.push(ids[position]);
      else if (entry.ownerUserId !== ownerUserId) strays.push(ids[position]);
      else if (page.includeExpired || !this.isExpired(entry, now)) entries.push(entry);
    });
    // An id whose entry is gone (removed by another process) leaves the index; one the entry says another user owns leaves this user's.
    if (gone.length + strays.length > 0) {
      const prune = redis.pipeline().zrem(key, ...gone, ...strays);
      if (gone.length > 0) prune.zrem(EXPIRY_INDEX, ...gone);
      await replies(prune).catch(() => undefined);
    }
    return { entries, total };
  }

  private memoryPage(ownerUserId: string, page: Required<DlqPageOptions>, now: number): DlqPage {
    this.purgeMemoryOwnerless();
    const owned = Array.from(this.memory.values())
      .filter((entry) => Boolean(ownerUserId) && entry.ownerUserId === ownerUserId && (page.includeExpired || !this.isExpired(entry, now)))
      .sort((a, b) => b.failedAt - a.failedAt);
    return { entries: owned.slice(page.offset, page.offset + page.limit), total: owned.length };
  }

  private purgeMemoryOwnerless(): void {
    for (const [id, entry] of this.memory) if (!entry.ownerUserId) this.memory.delete(id);
  }

  /** Removes the entries from the hash and from every index; answers whether any entry was there. */
  async remove(entries: readonly Pick<WebhookDlqEntry, 'id' | 'ownerUserId'>[]): Promise<boolean> {
    if (entries.length === 0) return false;
    let removed = false;
    const redis = this.client();
    if (redis) {
      try {
        await whenReady(redis);
        const ids = entries.map((entry) => entry.id);
        const { owned } = groupByOwner(entries);
        const pipeline = redis.pipeline().hdel(HASH, ...ids).zrem(EXPIRY_INDEX, ...ids).zrem(OWNERLESS_INDEX, ...ids);
        for (const [owner, ownerIds] of owned) pipeline.zrem(ownerIndex(owner), ...ownerIds);
        removed = Number((await replies(pipeline))[0]) > 0;
      } catch {
        // Fallback
      }
    }
    for (const entry of entries) if (this.memory.delete(entry.id)) removed = true;
    return removed;
  }

  /** Removes every entry `ownerUserId` owns (expired ones too), in batches, and the entries recorded without an owner. */
  async clear(ownerUserId: string): Promise<void> {
    const redis = this.client();
    if (redis) {
      try {
        await whenReady(redis);
        await this.reconcileIfDrifted(redis);
        await this.clearIndexed(redis, ownerUserId);
        await this.purgeAllOwnerless(redis);
      } catch {
        // Fallback
      }
    }
    for (const [id, entry] of this.memory) if (!entry.ownerUserId || entry.ownerUserId === ownerUserId) this.memory.delete(id);
  }

  private async clearIndexed(redis: Redis, ownerUserId: string): Promise<void> {
    const key = ownerIndex(ownerUserId);
    for (;;) {
      const ids = await redis.zrange(key, '0', String(BATCH - 1));
      if (ids.length === 0) return;
      const raws = await redis.hmget(HASH, ...ids);
      // Only an entry that names this owner (or one nobody can read) leaves the hash; the ids all leave the index, which ends the loop.
      const doomed = ids.filter((_, position) => {
        const entry = parseEntry(raws[position]);
        return !entry || entry.ownerUserId === ownerUserId;
      });
      const pipeline = redis.pipeline().zrem(key, ...ids).zrem(EXPIRY_INDEX, ...doomed);
      if (doomed.length > 0) pipeline.hdel(HASH, ...doomed);
      await replies(pipeline);
    }
  }

  /** Removes the entries whose retention has passed, and answers how many it removed. */
  async purgeExpired(now: number = Date.now()): Promise<number> {
    let removed = 0;
    const redis = this.client();
    if (redis) {
      try {
        await whenReady(redis);
        await this.reconcileIfDrifted(redis);
        removed += await this.purgeExpiredIndexed(redis, now);
        await this.purgeAllOwnerless(redis);
      } catch {
        // Fallback
      }
    }
    for (const [id, entry] of this.memory) {
      if (this.isExpired(entry, now) && this.memory.delete(id)) removed += 1;
    }
    return removed;
  }

  private async purgeExpiredIndexed(redis: Redis, now: number): Promise<number> {
    let removed = 0;
    for (;;) {
      const ids = await redis.zrangebyscore(EXPIRY_INDEX, '-inf', now - this.retentionMs, 'LIMIT', 0, BATCH);
      if (ids.length === 0) return removed;
      const raws = await redis.hmget(HASH, ...ids);
      const doomed: Pick<WebhookDlqEntry, 'id' | 'ownerUserId'>[] = [];
      const rescored = redis.pipeline();
      raws.forEach((raw, position) => {
        const entry = parseEntry(raw);
        // The index scored an entry older than it is: it is not expired, so it stays and takes its own time.
        if (entry && !this.isExpired(entry, now)) rescored.zadd(EXPIRY_INDEX, entry.failedAt, entry.id);
        else doomed.push({ id: ids[position], ownerUserId: entry?.ownerUserId });
      });
      await replies(rescored);
      if (doomed.length > 0) {
        const { owned } = groupByOwner(doomed);
        const doomedIds = doomed.map((entry) => entry.id);
        const pipeline = redis.pipeline().hdel(HASH, ...doomedIds).zrem(EXPIRY_INDEX, ...doomedIds);
        for (const [owner, ownerIds] of owned) pipeline.zrem(ownerIndex(owner), ...ownerIds);
        removed += Number((await replies(pipeline))[0]);
      }
    }
  }

  /**
   * Deletes entries recorded before owners were tracked (or for anonymous jobs). No API caller can reach them, so keeping them
   * would only retain their signing secrets indefinitely.
   */
  private async purgeOwnerless(redis: Redis, ids: readonly string[]): Promise<void> {
    await replies(redis.pipeline().hdel(HASH, ...ids).zrem(OWNERLESS_INDEX, ...ids).zrem(EXPIRY_INDEX, ...ids));
    console.warn(`[WebhookDispatcher] Purged ${ids.length} DLQ entries without an owner.`);
  }

  private async purgeAllOwnerless(redis: Redis): Promise<void> {
    for (;;) {
      const ids = await redis.zrange(OWNERLESS_INDEX, '0', String(BATCH - 1));
      if (ids.length === 0) return;
      await this.purgeOwnerless(redis, ids);
    }
  }

  private async reconcileIfDrifted(redis: Redis): Promise<void> {
    const [stored, indexed] = (await replies(redis.pipeline().hlen(HASH).zcard(EXPIRY_INDEX))) as [number, number];
    if (stored > indexed) await this.reconcile(redis);
  }

  /** Indexes every entry of the hash that has no place in the indexes yet, and drops the ones nobody can read. One pass at a time. */
  private reconcile(redis: Redis): Promise<void> {
    if (this.reconciling) return this.reconciling;
    if (Date.now() - this.lastReconcileAt < RECONCILE_MIN_INTERVAL_MS) return Promise.resolve();
    this.reconciling = this.reindex(redis).finally(() => {
      this.lastReconcileAt = Date.now();
      this.reconciling = undefined;
    });
    return this.reconciling;
  }

  private async reindex(redis: Redis): Promise<void> {
    let cursor = '0';
    do {
      const [next, flat] = await redis.hscan(HASH, cursor, 'COUNT', String(BATCH));
      cursor = next;
      const pipeline = redis.pipeline();
      const owners = new Set<string>();
      for (let at = 0; at + 1 < flat.length; at += 2) {
        const entry = parseEntry(flat[at + 1]);
        if (!entry) {
          pipeline.hdel(HASH, flat[at]);
          continue;
        }
        pipeline.zadd(EXPIRY_INDEX, entry.failedAt, entry.id);
        if (entry.ownerUserId) {
          pipeline.zadd(ownerIndex(entry.ownerUserId), entry.failedAt, entry.id);
          owners.add(entry.ownerUserId);
        } else {
          pipeline.zadd(OWNERLESS_INDEX, entry.failedAt, entry.id);
        }
      }
      for (const owner of owners) pipeline.pexpire(ownerIndex(owner), this.retentionMs + OWNER_INDEX_SLACK_MS);
      if (pipeline.length > 0) await replies(pipeline);
    } while (cursor !== '0');
  }
}
