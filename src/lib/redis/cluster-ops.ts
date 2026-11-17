import type Redis from 'ioredis';
import { whenReady } from './when-ready';

const SINGLE_KEY_DELETE_CONCURRENCY = 100;

export function isClusterRedis(client: unknown): boolean {
  if (!client || typeof client !== 'object') return false;
  return (
    Boolean((client as { isCluster?: unknown }).isCluster) ||
    typeof (client as { nodes?: unknown }).nodes === 'function'
  );
}

export function hasRedisHashTag(prefixOrKey: string): boolean {
  return /\{[^{}]+\}/.test(prefixOrKey);
}

/**
 * Iterates matching keys across every master shard when `client` is a `Redis.Cluster` instance,
 * or across the single node otherwise.
 */
export async function* scanClusterSafe(
  client: Redis,
  matchPattern: string,
  count = 200
): AsyncGenerator<string[]> {
  let targets: Redis[];
  if (typeof (client as unknown as { nodes?: unknown }).nodes === 'function') {
    await whenReady(client);
    targets = await Promise.resolve((client as unknown as { nodes(role: 'master'): Redis[] | Promise<Redis[]> }).nodes('master'));
  } else {
    targets = [client];
  }

  for (const node of targets) {
    let cursor = '0';
    do {
      const [next, keys] = await node.scan(cursor, 'MATCH', matchPattern, 'COUNT', count);
      cursor = next;
      if (keys.length > 0) {
        yield keys;
      }
    } while (cursor !== '0');
  }
}

export interface DeleteKeysOptions {
  unlink?: boolean;
  batchSize?: number;
}

/**
 * Deletes keys without triggering `CROSSSLOT` errors on `Redis.Cluster`:
 * - On Standalone / Sentinel clients: uses multi-key `DEL` / `UNLINK` in batches.
 * - On `Redis.Cluster`: dispatches single-key `DEL` / `UNLINK` per key so `ioredis` routes each key
 *   to its exact hash-slot master.
 */
export async function deleteKeysClusterSafe(
  client: {
    del(...keys: string[]): Promise<number>;
    unlink?(...keys: string[]): Promise<number>;
  },
  keys: readonly string[],
  options: DeleteKeysOptions = {}
): Promise<void> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return;

  const useUnlink = options.unlink === true && typeof client.unlink === 'function';
  const batchSize = options.batchSize ?? 500;

  if (!isClusterRedis(client)) {
    for (let at = 0; at < unique.length; at += batchSize) {
      const slice = unique.slice(at, at + batchSize);
      if (useUnlink) await client.unlink!(...slice);
      else await client.del(...slice);
    }
    return;
  }

  for (let at = 0; at < unique.length; at += SINGLE_KEY_DELETE_CONCURRENCY) {
    const slice = unique.slice(at, at + SINGLE_KEY_DELETE_CONCURRENCY);
    await Promise.all(slice.map((key) => (useUnlink ? client.unlink!(key) : client.del(key))));
  }
}
