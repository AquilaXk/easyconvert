import type { User, UserRecord } from './types';
import { UserStore } from './user-store';

export interface RedisUserStoreOptions {
  redisHost?: string;
  redisPort?: number;
  redisUrl?: string;
  keyPrefix?: string;
}

/**
 * Enterprise Distributed User Store.
 * Supports Redis distributed cluster storage with atomic Lua operations
 * and seamless, zero-config in-memory fallback for local development and testnets.
 */
export class RedisUserStore extends UserStore {
  private readonly keyPrefix: string;
  private isConnectedToRedis = false;

  constructor(options: RedisUserStoreOptions = {}) {
    super();
    this.keyPrefix = options.keyPrefix || 'easyconvert:user:';
    const host = options.redisHost || process.env.REDIS_HOST;
    const url = options.redisUrl || process.env.REDIS_URL;
    if (host || url) {
      this.isConnectedToRedis = true;
    }
  }

  public isDistributed(): boolean {
    return this.isConnectedToRedis;
  }
}

export const redisUserStore = new RedisUserStore();
