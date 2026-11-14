import type Redis from 'ioredis';
import { pipelineReplies } from '../redis/pipeline-replies';
import type { JobCounts, JobState } from './bullmq-engine';
import { OLDEST_WAITING_SINCE_LUA_SCRIPT } from './lua-scripts';
import { userByStateKeys } from './user-job-list';

export interface QueueStateKeys {
  waitingKey: string;
  delayedKey: string;
  activeKey: string;
  completedKey: string;
  failedKey: string;
  cancelledKey: string;
}

async function readLegacyWaitingList(
  redis: Redis,
  waitingKey: string,
  rethrowUnlessWrongType: (err: unknown) => void
): Promise<string[]> {
  if (typeof redis.lrange !== 'function') return [];
  try {
    return (await redis.lrange(waitingKey, 0, -1)) || [];
  } catch (err) {
    rethrowUnlessWrongType(err);
    return [];
  }
}

async function readLegacyWaitingCount(
  redis: Redis,
  waitingKey: string,
  rethrowUnlessWrongType: (err: unknown) => void
): Promise<number> {
  if (typeof redis.llen !== 'function') return 0;
  try {
    const count = await redis.llen(waitingKey);
    return typeof count === 'number' && !Number.isNaN(count) ? count : 0;
  } catch (err) {
    rethrowUnlessWrongType(err);
    return 0;
  }
}

function enqueueStateRead(pipe: ReturnType<Redis['pipeline']>, keys: QueueStateKeys, type: JobState): boolean {
  if (type === 'waiting') pipe.zrange(keys.waitingKey, '0', '-1');
  else if (type === 'delayed') pipe.zrange(keys.delayedKey, '0', '-1');
  else if (type === 'active') pipe.smembers(keys.activeKey);
  else if (type === 'completed') pipe.smembers(keys.completedKey);
  else if (type === 'failed') pipe.smembers(keys.failedKey);
  else if (type === 'cancelled') pipe.smembers(keys.cancelledKey);
  else return false;
  return true;
}

async function readIdsForTypeSequential(
  redis: Redis,
  keys: QueueStateKeys,
  type: JobState,
  rethrowUnlessWrongType: (err: unknown) => void
): Promise<string[]> {
  if (type === 'waiting') {
    let list: string[] = [];
    if (typeof redis.zrange === 'function') {
      try {
        list = await redis.zrange(keys.waitingKey, '0', '-1');
      } catch (err) {
        rethrowUnlessWrongType(err);
      }
    }
    if (list.length === 0) {
      const legacy = await readLegacyWaitingList(redis, keys.waitingKey, rethrowUnlessWrongType);
      if (legacy.length > 0) list = legacy;
    }
    return list;
  }
  if (type === 'delayed') return (await redis.zrange(keys.delayedKey, '0', '-1')) || [];
  if (type === 'active') return (await redis.smembers(keys.activeKey)) || [];
  if (type === 'completed') return (await redis.smembers(keys.completedKey)) || [];
  if (type === 'failed') return (await redis.smembers(keys.failedKey)) || [];
  if (type === 'cancelled') return (await redis.smembers(keys.cancelledKey)) || [];
  return [];
}

/** Collects unique job IDs across requested queue state collections in one Redis pipeline (falling back when unpipelined). */
export async function collectQueueJobIds(
  redis: Redis,
  keys: QueueStateKeys,
  types: JobState[],
  rethrowUnlessWrongType: (err: unknown) => void
): Promise<string[]> {
  const requested = [...new Set(types)];
  if (requested.length === 0) return [];

  if (typeof (redis as { pipeline?: unknown }).pipeline === 'function') {
    const pipe = redis.pipeline();
    const dispatched: JobState[] = [];
    for (const type of requested) {
      if (enqueueStateRead(pipe, keys, type)) dispatched.push(type);
    }
    const results = dispatched.length > 0 ? ((await pipe.exec()) ?? []) : [];
    const lists: string[][] = [];
    for (let i = 0; i < dispatched.length; i++) {
      const [err, val] = results[i] ?? [];
      if (dispatched[i] === 'waiting') {
        if (err) {
          rethrowUnlessWrongType(err);
          lists.push(await readLegacyWaitingList(redis, keys.waitingKey, rethrowUnlessWrongType));
        } else {
          lists.push(Array.isArray(val) ? (val as string[]) : []);
        }
      } else {
        if (err) throw err;
        lists.push(Array.isArray(val) ? (val as string[]) : []);
      }
    }
    return Array.from(new Set(lists.flat()));
  }

  const lists = await Promise.all(
    requested.map((type) => readIdsForTypeSequential(redis, keys, type, rethrowUnlessWrongType))
  );
  return Array.from(new Set(lists.flat()));
}

/** Reads all six queue state cardinalities in a single Redis pipeline, tolerating legacy LIST waiting keys. */
export async function readQueueJobCounts(
  redis: Redis,
  keys: QueueStateKeys,
  rethrowUnlessWrongType: (err: unknown) => void
): Promise<JobCounts> {
  if (typeof (redis as { pipeline?: unknown }).pipeline === 'function') {
    const pipe = redis.pipeline();
    pipe.zcard(keys.waitingKey);
    pipe.scard(keys.activeKey);
    pipe.scard(keys.completedKey);
    pipe.scard(keys.failedKey);
    pipe.zcard(keys.delayedKey);
    pipe.scard(keys.cancelledKey);
    const results = (await pipe.exec()) ?? [];
    const waitingErr = results[0]?.[0];
    let waiting = Number(results[0]?.[1]) || 0;
    if (waitingErr) {
      rethrowUnlessWrongType(waitingErr);
      waiting = await readLegacyWaitingCount(redis, keys.waitingKey, rethrowUnlessWrongType);
    }
    const restErr = results.slice(1).find(([err]) => Boolean(err))?.[0];
    if (restErr) throw restErr;
    return {
      waiting,
      active: Number(results[1]?.[1]) || 0,
      completed: Number(results[2]?.[1]) || 0,
      failed: Number(results[3]?.[1]) || 0,
      delayed: Number(results[4]?.[1]) || 0,
      cancelled: Number(results[5]?.[1]) || 0,
    };
  }

  let waiting = 0;
  let fellBack = false;
  if (typeof redis.zcard === 'function') {
    try {
      const count = await redis.zcard(keys.waitingKey);
      if (typeof count === 'number' && !Number.isNaN(count)) waiting = count;
    } catch (err) {
      rethrowUnlessWrongType(err);
      fellBack = true;
    }
  } else {
    fellBack = true;
  }
  if (fellBack) waiting = await readLegacyWaitingCount(redis, keys.waitingKey, rethrowUnlessWrongType);

  const [active, completed, failed, delayed, cancelled] = await Promise.all([
    redis.scard(keys.activeKey),
    redis.scard(keys.completedKey),
    redis.scard(keys.failedKey),
    redis.zcard(keys.delayedKey),
    redis.scard(keys.cancelledKey),
  ]);
  return {
    waiting,
    active: active || 0,
    completed: completed || 0,
    failed: failed || 0,
    delayed: delayed || 0,
    cancelled: cancelled || 0,
  };
}

/** Computes oldest waiting timestamp in a single Lua eval across priority bands (with test-double zrangebyscore fallback). */
export async function readOldestWaitingSince(
  redis: Redis,
  waitingKey: string,
  priorityScoreBand: number,
  maxWaitingBands: number,
  rethrowUnlessWrongType: (err: unknown) => void
): Promise<number | undefined> {
  const now = Date.now();
  if (typeof redis.eval === 'function') {
    const longestWait = await redis.eval(
      OLDEST_WAITING_SINCE_LUA_SCRIPT,
      1,
      waitingKey,
      String(now),
      String(priorityScoreBand),
      String(maxWaitingBands)
    );
    return longestWait === null || longestWait === undefined ? undefined : now - Number(longestWait);
  }

  let longestWait: number | undefined;
  let from = '-inf';
  for (let band = 0; band < maxWaitingBands; band++) {
    let head: string[] = [];
    try {
      head = await redis.zrangebyscore(waitingKey, from, '+inf', 'WITHSCORES', 'LIMIT', 0, 1);
    } catch (err) {
      rethrowUnlessWrongType(err);
    }
    if (head.length < 2) break;
    const score = Number(head[1]);
    const wait = (((now % priorityScoreBand) - (score % priorityScoreBand)) + priorityScoreBand) % priorityScoreBand;
    longestWait = Math.max(longestWait ?? 0, wait);
    from = String((Math.floor(score / priorityScoreBand) + 1) * priorityScoreBand);
  }
  return longestWait === undefined ? undefined : now - longestWait;
}

/** Removes a job ID from a user's main `user_jobs` ZSET and every `by_state` secondary ZSET. */
export async function removeFromUserIndices(client: Redis, userJobsKey: string, jobId: string): Promise<void> {
  const byState = userByStateKeys(userJobsKey);
  if (typeof (client as { pipeline?: unknown }).pipeline === 'function') {
    const pipe = client.pipeline();
    pipe.zrem(userJobsKey, jobId);
    for (const bk of byState) pipe.zrem(bk, jobId);
    await pipelineReplies(pipe);
    return;
  }
  await client.zrem(userJobsKey, jobId);
  for (const bk of byState) await client.zrem(bk, jobId);
}
