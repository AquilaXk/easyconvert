import crypto from 'node:crypto';
import Redis from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INDEX_USER_GRAPH_LUA_SCRIPT, MAX_INDEXED_GRAPHS_PER_USER, RedisGraphScheduler } from '../src/lib/queue/graph';
import { sealGraph } from '../src/lib/queue/graph/node-jobs';
import { endedJobRetentionMs } from '../src/lib/queue/enqueue';
import { JOB_DEADLINE_CEILING_MS } from '../src/lib/config/schema';

/**
 * The graphs of a user are listed from a sorted set of their ids, scored by creation time, that lives as long as the state of a
 * graph can: the list reads it once, then the graphs it names, and never scans the keys. Like the other Redis suites it runs when
 * REDIS_URL is set.
 */
const REDIS_URL = process.env.REDIS_URL;

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!REDIS_URL)('the per-user index of graphs in Redis', () => {
  let keyPrefix: string;
  let client: Redis;
  let scheduler: RedisGraphScheduler;
  let userId: string;

  beforeEach(() => {
    keyPrefix = `graph-index-${crypto.randomBytes(6).toString('hex')}:`;
    userId = `user-${crypto.randomUUID()}`;
    client = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    // The nodes are not queued: only the state of the graphs is under test.
    scheduler = new RedisGraphScheduler({ redisClient: client, keyPrefix, enqueueNode: async () => undefined, cancelNode: async () => true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const keys = await client.keys(`${keyPrefix}*`);
    if (keys.length > 0) await client.del(...keys);
    await client.quit();
  });

  const index = () => `${keyPrefix}user_graphs:{${userId}}`;

  async function start(owner: string | undefined, createdAt: number, name = 'in.csv'): Promise<string> {
    const graphId = `job_${createdAt}_${crypto.randomBytes(5).toString('hex')}`;
    await scheduler.initGraph(graphId, sealGraph(graphId, { nodes: { upload: { op: 'import.upload', storageKey: `conversions/${owner}/${name}` } } }), {
      ownerUserId: owner,
      originalFilename: name,
      createdAt,
    });
    return graphId;
  }

  it('indexes a graph under its owner when it starts, scored by its creation time', async () => {
    const now = Date.now();
    const graphId = await start(userId, now - 5);

    expect(await client.zrange(index(), '0', '-1', 'WITHSCORES')).toEqual([graphId, String(now - 5)]);
  });

  it('lists the newest graphs of the user first, never those of another user, and reads the index once', async () => {
    const now = Date.now();
    const first = await start(userId, now - 30);
    const third = await start(userId, now - 10);
    const second = await start(userId, now - 20);
    await start(`user-${crypto.randomUUID()}`, now - 15);
    const scan = vi.spyOn(client, 'scan');
    const indexReads = vi.spyOn(client, 'zrevrange');

    const listed = await scheduler.listGraphsOfUser(userId, 2);

    expect(listed.map((graph) => graph.graphId)).toEqual([third, second]);
    expect((await scheduler.listGraphsOfUser(userId, 10)).map((graph) => graph.graphId)).toEqual([third, second, first]);
    expect(indexReads).toHaveBeenCalledTimes(2);
    expect(scan).not.toHaveBeenCalled();
  });

  it('fills a page that a status filter thins from the next graphs of the same index read', async () => {
    const now = Date.now();
    const old = await start(userId, now - 40);
    const cancelled = await Promise.all([30, 20, 10].map((age) => start(userId, now - age)));
    for (const graphId of cancelled) await scheduler.cancelGraph(graphId);
    const indexReads = vi.spyOn(client, 'zrevrange');

    const listed = await scheduler.listGraphsOfUser(userId, 1, ['running']);

    expect(listed.map((graph) => graph.graphId)).toEqual([old]);
    expect(indexReads).toHaveBeenCalledTimes(1);
  });

  it('drops a graph whose state expired from the index instead of listing it', async () => {
    const now = Date.now();
    const kept = await start(userId, now - 10);
    const expired = await start(userId, now - 20);
    await client.del(...(await client.keys(`${keyPrefix}graph:{${expired}}*`)));

    expect((await scheduler.listGraphsOfUser(userId, 10)).map((graph) => graph.graphId)).toEqual([kept]);
    expect(await client.zrange(index(), '0', '-1')).toEqual([kept]);
  });

  it('keeps the index as long as a graph state can live, and removes the graphs older than that when a graph is added', async () => {
    const now = Date.now();
    const lifetime = endedJobRetentionMs() + JOB_DEADLINE_CEILING_MS;
    const stale = await start(userId, now - lifetime - 60_000);
    const fresh = await start(userId, now);

    expect(await client.zrange(index(), '0', '-1')).toEqual([fresh]);
    expect(stale).not.toBe(fresh);
    const ttl = await client.pttl(index());
    expect(ttl).toBeGreaterThan(lifetime - 5_000);
    expect(ttl).toBeLessThanOrEqual(lifetime);
  });

  it('keeps at most the cap, the oldest leaving first', async () => {
    const now = Date.now();
    const add = (graphId: string, createdAt: number) =>
      client.eval(INDEX_USER_GRAPH_LUA_SCRIPT, 1, index(), graphId, String(createdAt), String(now), String(60_000), '3');

    for (const [n, graphId] of ['g1', 'g2', 'g3', 'g4'].entries()) await add(graphId, now - 10 + n);
    await add('g2', now + 99);

    expect(await client.zrange(index(), '0', '-1')).toEqual(['g2', 'g3', 'g4']);
    expect(await client.zscore(index(), 'g2')).toBe(String(now - 9));
    expect(MAX_INDEXED_GRAPHS_PER_USER).toBe(1000);
  });

  it('does not index a graph that has no account owner', async () => {
    await start(undefined, Date.now());
    await start('anon:203.0.113', Date.now());

    expect(await client.keys(`${keyPrefix}user_graphs:*`)).toEqual([]);
  });

  it('indexes the graph again when its start is recovered after a failure that came after it was stored', async () => {
    const now = Date.now();
    const graphId = await start(userId, now);
    await client.del(index());

    await scheduler.recoverStart(graphId);

    expect(await client.zrange(index(), '0', '-1')).toEqual([graphId]);
  });
});
