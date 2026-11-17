import type Redis from 'ioredis';
import { createConfiguredRedisClient, hasConfiguredRedis } from '../../redis/client-factory';
import type { IGraphScheduler } from './scheduler-types';
import { InMemoryGraphScheduler } from './in-memory-scheduler';
import { RedisGraphScheduler } from './redis-scheduler';

export * from './scheduler-types';
export * from './in-memory-scheduler';
export * from './redis-scheduler';
export * from './lua-scripts';

/** The client of the configured Redis (Standalone, Sentinel, or Cluster). */
function connectFromEnvironment(): Redis {
  return createConfiguredRedisClient({ maxRetriesPerRequest: 1, lazyConnect: true });
}

export function createGraphScheduler(options?: {
  distributed?: boolean;
  redisClient?: Redis;
  keyPrefix?: string;
}): IGraphScheduler {
  const shouldUseDistributed =
    options?.distributed ??
    Boolean(options?.redisClient || hasConfiguredRedis());

  if (shouldUseDistributed) {
    return new RedisGraphScheduler({
      redisClient: options?.redisClient || connectFromEnvironment(),
      keyPrefix: options?.keyPrefix,
    });
  }

  return new InMemoryGraphScheduler();
}

export const graphScheduler: IGraphScheduler = createGraphScheduler();
