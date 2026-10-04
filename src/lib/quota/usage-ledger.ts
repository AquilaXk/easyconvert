import type Redis from 'ioredis';
import type { ResourceClass } from './pricing';
import { redisKeyStore } from '../api-keys/redis-key-store';

export type UsageLedgerStatus = 'completed' | 'failed' | 'cancelled';

export interface UsageLedgerEntry {
  jobId: string;
  nodeId: string;
  units: number;
  resourceClass: ResourceClass;
  bytesIn: number;
  bytesOut: number;
  durationMs: number;
  timestamp: number;
  status: UsageLedgerStatus;
}

export interface UsageLedgerQueryResult {
  items: UsageLedgerEntry[];
  totalUnits: number;
  count: number;
}

export interface UsageQueryOptions {
  from?: number;
  to?: number;
  limit?: number;
}

export interface UsageLedger {
  recordUsage(userId: string, entry: UsageLedgerEntry): Promise<{ recorded: boolean; entry: UsageLedgerEntry }>;
  queryUsage(userId: string, options?: UsageQueryOptions): Promise<UsageLedgerQueryResult>;
  reset(): Promise<void>;
}

const IDEMP_TTL_SECONDS = 7 * 86400; // 7 days retention for deduplication
const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 200;

export class InMemoryUsageLedger implements UsageLedger {
  private readonly store = new Map<string, UsageLedgerEntry[]>();
  private readonly idempKeys = new Set<string>();

  public recordUsage(
    userId: string,
    entry: UsageLedgerEntry
  ): Promise<{ recorded: boolean; entry: UsageLedgerEntry }> {
    const idempKey = `${userId}:${entry.jobId}:${entry.nodeId}`;
    if (this.idempKeys.has(idempKey)) {
      // Find existing entry
      const list = this.store.get(userId) ?? [];
      const existing = list.find((e) => e.jobId === entry.jobId && e.nodeId === entry.nodeId);
      return Promise.resolve({ recorded: false, entry: existing ?? entry });
    }

    this.idempKeys.add(idempKey);
    const list = this.store.get(userId) ?? [];
    list.push(entry);
    this.store.set(userId, list);

    return Promise.resolve({ recorded: true, entry });
  }

  public queryUsage(
    userId: string,
    options?: UsageQueryOptions
  ): Promise<UsageLedgerQueryResult> {
    const all = this.store.get(userId) ?? [];
    const from = options?.from ?? 0;
    const to = options?.to ?? Number.MAX_SAFE_INTEGER;
    const limit = Math.min(MAX_QUERY_LIMIT, Math.max(1, options?.limit ?? DEFAULT_QUERY_LIMIT));

    const filtered = all.filter((item) => item.timestamp >= from && item.timestamp <= to);
    // Sort descending by timestamp
    filtered.sort((a, b) => b.timestamp - a.timestamp);

    const paginated = filtered.slice(0, limit);
    const totalUnits = paginated.reduce((sum, item) => sum + item.units, 0);

    return Promise.resolve({
      items: paginated,
      totalUnits,
      count: paginated.length,
    });
  }

  public reset(): Promise<void> {
    this.store.clear();
    this.idempKeys.clear();
    return Promise.resolve();
  }
}

export class RedisUsageLedger implements UsageLedger {
  private readonly redis: Redis;
  private readonly prefix: string;

  constructor(options: { redisClient: Redis; prefix?: string }) {
    this.redis = options.redisClient;
    this.prefix = options.prefix ?? 'easyconvert:';
  }

  private buildStreamKey(userId: string): string {
    return `${this.prefix}usage:{${userId}}`;
  }

  private buildIdempKey(userId: string, jobId: string, nodeId: string): string {
    return `${this.prefix}usage:idemp:{${userId}}:${jobId}:${nodeId}`;
  }

  public async recordUsage(
    userId: string,
    entry: UsageLedgerEntry
  ): Promise<{ recorded: boolean; entry: UsageLedgerEntry }> {
    const idempKey = this.buildIdempKey(userId, entry.jobId, entry.nodeId);
    const streamKey = this.buildStreamKey(userId);

    // Atomically claim idempotency key
    const claimed = await this.redis.set(idempKey, JSON.stringify(entry), 'EX', IDEMP_TTL_SECONDS, 'NX');
    if (!claimed) {
      const cached = await this.redis.get(idempKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as UsageLedgerEntry;
          return { recorded: false, entry: parsed };
        } catch {
          // Fall through
        }
      }
      return { recorded: false, entry };
    }

    // Append to Redis Stream
    await this.redis.xadd(
      streamKey,
      '*',
      'jobId',
      entry.jobId,
      'nodeId',
      entry.nodeId,
      'units',
      entry.units.toString(),
      'class',
      entry.resourceClass,
      'bytesIn',
      entry.bytesIn.toString(),
      'bytesOut',
      entry.bytesOut.toString(),
      'durationMs',
      entry.durationMs.toString(),
      'timestamp',
      entry.timestamp.toString(),
      'status',
      entry.status
    );

    return { recorded: true, entry };
  }

  public async queryUsage(
    userId: string,
    options?: UsageQueryOptions
  ): Promise<UsageLedgerQueryResult> {
    const streamKey = this.buildStreamKey(userId);
    const fromMs = options?.from !== undefined ? options.from : '-';
    const toMs = options?.to !== undefined ? options.to : '+';
    const limit = Math.min(MAX_QUERY_LIMIT, Math.max(1, options?.limit ?? DEFAULT_QUERY_LIMIT));

    // Read descending with XREVRANGE
    const raw = await this.redis.xrevrange(streamKey, toMs.toString(), fromMs.toString(), 'COUNT', limit);
    const items: UsageLedgerEntry[] = [];

    for (const [, fields] of raw) {
      const parsed = parseStreamFields(fields);
      if (parsed) {
        items.push(parsed);
      }
    }

    const totalUnits = items.reduce((sum, item) => sum + item.units, 0);

    return {
      items,
      totalUnits,
      count: items.length,
    };
  }

  public async reset(): Promise<void> {
    // For testnet cleanup
    const keys = await this.redis.keys(`${this.prefix}usage:*`);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }
}

function parseStreamFields(fields: string[]): UsageLedgerEntry | null {
  const map = new Map<string, string>();
  for (let i = 0; i < fields.length; i += 2) {
    map.set(fields[i], fields[i + 1]);
  }

  const jobId = map.get('jobId');
  const nodeId = map.get('nodeId');
  const unitsStr = map.get('units');
  const resourceClass = (map.get('class') ?? 'light') as ResourceClass;
  const bytesInStr = map.get('bytesIn');
  const bytesOutStr = map.get('bytesOut');
  const durationMsStr = map.get('durationMs');
  const timestampStr = map.get('timestamp');
  const status = (map.get('status') ?? 'completed') as UsageLedgerStatus;

  if (!jobId || !nodeId || unitsStr === undefined || timestampStr === undefined) {
    return null;
  }

  return {
    jobId,
    nodeId,
    units: Number.parseInt(unitsStr, 10) || 0,
    resourceClass,
    bytesIn: Number.parseInt(bytesInStr ?? '0', 10) || 0,
    bytesOut: Number.parseInt(bytesOutStr ?? '0', 10) || 0,
    durationMs: Number.parseInt(durationMsStr ?? '0', 10) || 0,
    timestamp: Number.parseInt(timestampStr, 10) || Date.now(),
    status,
  };
}

let activeUsageLedger: UsageLedger | null = null;

export function getUsageLedger(): UsageLedger {
  if (activeUsageLedger) return activeUsageLedger;

  const redis = redisKeyStore.getRedisClient();
  if (redis) {
    activeUsageLedger = new RedisUsageLedger({ redisClient: redis, prefix: redisKeyStore.getPrefix() });
  } else {
    activeUsageLedger = new InMemoryUsageLedger();
  }

  return activeUsageLedger;
}

export function setUsageLedger(ledger: UsageLedger | null): void {
  activeUsageLedger = ledger;
}
