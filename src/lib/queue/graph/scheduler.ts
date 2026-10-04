import Redis from 'ioredis';
import type { IGraphScheduler } from './scheduler-types';
import { InMemoryGraphScheduler } from './in-memory-scheduler';
import { RedisGraphScheduler } from './redis-scheduler';

export * from './scheduler-types';
export * from './in-memory-scheduler';
export * from './redis-scheduler';
export * from './lua-scripts';

export function createGraphScheduler(options?: {
  distributed?: boolean;
  redisClient?: Redis;
  keyPrefix?: string;
}): IGraphScheduler {
  const shouldUseDistributed =
    options?.distributed ??
    Boolean(options?.redisClient || process.env.REDIS_URL || process.env.REDIS_HOST);

  if (shouldUseDistributed) {
    const client =
      options?.redisClient ||
      new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
        maxRetriesPerRequest: 1,
        lazyConnect: true,
      });
    return new RedisGraphScheduler({
      redisClient: client,
      keyPrefix: options?.keyPrefix,
    });
  }

  return new InMemoryGraphScheduler();
}

export const graphScheduler: IGraphScheduler = createGraphScheduler();
