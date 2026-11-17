import type Redis from 'ioredis';
import { deleteKeysClusterSafe, scanClusterSafe } from './cluster-ops';

/** The keys one SCAN step asks for, and the most one UNLINK names. */
const CLEAR_BATCH = 500;

/**
 * Deletes every key that matches one of `patterns`: the keys come from a SCAN a batch at a time (across all master
 * shards on `Redis.Cluster`), never from KEYS, and are unlinked safely without cross-slot errors.
 */
export async function clearKeysMatching(redis: Redis, patterns: readonly string[]): Promise<void> {
  for (const pattern of patterns) {
    for await (const keys of scanClusterSafe(redis, pattern, CLEAR_BATCH)) {
      await deleteKeysClusterSafe(redis, keys, { unlink: true, batchSize: CLEAR_BATCH });
    }
  }
}
