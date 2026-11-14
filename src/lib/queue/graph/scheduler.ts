import Redis from 'ioredis';
import type { IGraphScheduler } from './scheduler-types';
import { InMemoryGraphScheduler } from './in-memory-scheduler';
import { RedisGraphScheduler } from './redis-scheduler';

export * from './scheduler-types';
export * from './in-memory-scheduler';
export * from './redis-scheduler';
export * from './lua-scripts';

/** The client of the configured Redis, like the other stores: REDIS_URL, else REDIS_HOST with REDIS_PORT, else the local one. */
function connectFromEnvironment(): Redis {
  const failFast = { maxRetriesPerRequest: 1, lazyConnect: true };
  const url = process.env.REDIS_URL;
  if (url) return new Redis(url, failFast);
  return new Redis({ host: process.env.REDIS_HOST || '127.0.0.1', port: Number(process.env.REDIS_PORT || 6379), ...failFast });
}

export function createGraphScheduler(options?: {
  distributed?: boolean;
  redisClient?: Redis;
  keyPrefix?: string;
}): IGraphScheduler {
  const shouldUseDistributed =
    options?.distributed ??
    Boolean(options?.redisClient || process.env.REDIS_URL || process.env.REDIS_HOST);

  if (shouldUseDistributed) {
    return new RedisGraphScheduler({
      redisClient: options?.redisClient || connectFromEnvironment(),
      keyPrefix: options?.keyPrefix,
    });
  }

  return new InMemoryGraphScheduler();
}

export const graphScheduler: IGraphScheduler = createGraphScheduler();
