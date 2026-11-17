import os from 'node:os';
import { redisKeyStore } from '../api-keys/redis-key-store';

/**
 * Live queue-worker presence registry and Web execution mode helper.
 *
 * Workers refresh their presence in a Redis sorted set (`<prefix>workers:live`, score = epoch ms) on every
 * heartbeat tick and remove themselves when draining. Web replicas inspect this set to decide whether
 * `POST /api/tools/jobs` should hand off to the distributed worker fleet in `hybrid` mode and to fail closed
 * (`503`) if `WEB_EXECUTION_MODE=queue-only` has no reachable live worker.
 */

export type WebExecutionMode = 'hybrid' | 'queue-only';

const DEFAULT_WORKER_STALE_MS = 35_000;
const localLiveWorkers = new Set<string>();

export const CURRENT_WORKER_INSTANCE_ID = `${os.hostname()}:${process.pid}`;

export function resolveWebExecutionMode(
  env: Readonly<Record<string, string | undefined>> = process.env
): WebExecutionMode {
  return env.WEB_EXECUTION_MODE?.trim() === 'queue-only' ? 'queue-only' : 'hybrid';
}

export function isQueueOnlyWebMode(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return resolveWebExecutionMode(env) === 'queue-only';
}

function workerStaleWindowMs(): number {
  const parsed = Number(process.env.WORKER_HEARTBEAT_MAX_STALE_MS);
  return Number.isInteger(parsed) && parsed >= 5_000 ? parsed : DEFAULT_WORKER_STALE_MS;
}

function liveWorkersKey(): string {
  return `${redisKeyStore.getPrefix()}workers:live`;
}

export async function registerLiveWorkerHeartbeat(
  workerId: string = CURRENT_WORKER_INSTANCE_ID,
  now: number = Date.now()
): Promise<void> {
  localLiveWorkers.add(workerId);
  const redis = redisKeyStore.getRedisClient();
  if (!redis || typeof (redis as { zadd?: unknown }).zadd !== 'function') return;
  const staleMs = workerStaleWindowMs();
  const key = liveWorkersKey();
  try {
    await redis.zadd(key, String(now), workerId);
    if (typeof (redis as { zremrangebyscore?: unknown }).zremrangebyscore === 'function') {
      await redis.zremrangebyscore(key, '-inf', String(now - staleMs));
    }
    if (typeof (redis as { pexpire?: unknown }).pexpire === 'function') {
      await redis.pexpire(key, staleMs * 2);
    }
  } catch {
    // Non-fatal during transient Redis reconnect; local worker set still tracks in-process state.
  }
}

export async function unregisterLiveWorkerHeartbeat(
  workerId: string = CURRENT_WORKER_INSTANCE_ID
): Promise<void> {
  localLiveWorkers.delete(workerId);
  const redis = redisKeyStore.getRedisClient();
  if (!redis || typeof (redis as { zrem?: unknown }).zrem !== 'function') return;
  try {
    await redis.zrem(liveWorkersKey(), workerId);
  } catch {
    // Best-effort cleanup on shutdown.
  }
}

export async function hasLiveQueueWorker(now: number = Date.now()): Promise<boolean> {
  if (localLiveWorkers.size > 0 || process.env.EASYCONVERT_WORKER_ENABLED === 'true') {
    return true;
  }
  const redis = redisKeyStore.getRedisClient();
  if (!redis || typeof (redis as { zcount?: unknown }).zcount !== 'function') {
    return false;
  }
  const minScore = now - workerStaleWindowMs();
  const count = await redis.zcount(liveWorkersKey(), String(minScore), '+inf');
  return Number(count) > 0;
}

export function resetLocalLiveWorkersForTests(): void {
  localLiveWorkers.clear();
}
