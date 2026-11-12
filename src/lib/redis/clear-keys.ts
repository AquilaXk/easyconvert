import type Redis from 'ioredis';

/** The keys one SCAN step asks for, and the most one UNLINK names. */
const CLEAR_BATCH = 500;

/**
 * Deletes every key that matches one of `patterns`: the keys come from a SCAN a batch at a time, never from KEYS (which blocks the
 * server for the whole keyspace), and go in one UNLINK per batch. A key created while it runs may stay.
 */
export async function clearKeysMatching(redis: Redis, patterns: readonly string[]): Promise<void> {
  for (const pattern of patterns) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', CLEAR_BATCH);
      cursor = next;
      // SCAN may name a key twice, and a batch may be empty.
      if (keys.length > 0) await redis.unlink(...new Set(keys));
    } while (cursor !== '0');
  }
}
