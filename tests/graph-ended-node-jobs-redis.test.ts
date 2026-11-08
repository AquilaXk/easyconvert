import crypto from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, vi } from 'vitest';
import { itLeavesTheNodeJobsOfAnEndedGraphAlone } from './helpers/graph-ended-node-cases';
import { RedisGraphScheduler } from '../src/lib/queue/graph/redis-scheduler';
import { QueueUnavailableError } from '../src/lib/types';

/**
 * The node jobs of an ended graph on a real Redis server: the worker asks the Lua script of the store whether a node may run. Runs
 * when REDIS_URL is set (CI `npm run test:redis`), like the other Redis suites.
 */
const REDIS_URL = process.env.REDIS_URL;

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!REDIS_URL)('the node jobs of an ended graph, on a real Redis server', () => {
  let admin: Redis;
  const keyPrefix = `graph-ended-${crypto.randomBytes(6).toString('hex')}:`;

  beforeAll(() => {
    admin = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
  });

  afterAll(async () => {
    const keys = await admin.keys(`${keyPrefix}*`);
    if (keys.length > 0) await admin.del(...keys);
    await admin.quit();
  });

  itLeavesTheNodeJobsOfAnEndedGraphAlone({
    scheduler: () => {
      let stored = 0;
      let storeAtMost = Number.POSITIVE_INFINITY;
      let failures = 0;
      const tries = new Map<string, number>();
      const enqueueNode = async () => {
        if (stored >= storeAtMost) throw new QueueUnavailableError('light', 'the node job could not be stored');
        stored++;
      };
      const cancelNode = async (graphId: string, nodeId: string) => {
        const jobId = `${graphId}:${nodeId}`;
        const made = (tries.get(jobId) ?? 0) + 1;
        tries.set(jobId, made);
        if (made <= failures) throw new Error('the queue could not be reached');
        return true;
      };
      return {
        scheduler: new RedisGraphScheduler({ redisClient: admin, keyPrefix, enqueueNode, cancelNode }),
        refuseNodeJobsAfter: (count) => {
          storeAtMost = count;
        },
        failNodeJobCancels: (times) => {
          failures = times;
          return () => tries;
        },
      };
    },
  });
});
