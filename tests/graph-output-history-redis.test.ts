import crypto from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe } from 'vitest';
import { itRecordsTheFinalOutputsOfACompletedGraph } from './helpers/graph-output-history-cases';
import { RedisGraphScheduler } from '../src/lib/queue/graph/redis-scheduler';

/**
 * The final outputs of a completed graph in the file history, with the Redis scheduler on a real Redis server. Runs when REDIS_URL
 * is set (CI `npm run test:redis`), like the other Redis suites.
 */
const REDIS_URL = process.env.REDIS_URL;

// skip-ok: mode selection. The shards run without REDIS_URL; the Redis-mode CI step (npm run test:redis) sets it and runs this file.
describe.skipIf(!REDIS_URL)('the final outputs of a completed graph in the file history, on a real Redis server', () => {
  let admin: Redis;
  const keyPrefix = `graph-history-${crypto.randomBytes(6).toString('hex')}:`;

  beforeAll(() => {
    admin = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
  });

  afterAll(async () => {
    const keys = await admin.keys(`${keyPrefix}*`);
    if (keys.length > 0) await admin.del(...keys);
    await admin.quit();
  });

  itRecordsTheFinalOutputsOfACompletedGraph(() => new RedisGraphScheduler({ redisClient: admin, keyPrefix, enqueueNode: async () => {}, cancelNode: async () => true }));
});
