import type Redis from 'ioredis';
import { REMOVE_JOB_LUA_SCRIPT, REPLACE_ENDED_JOB_DATA_LUA_SCRIPT, TRIM_DEAD_LETTERS_LUA_SCRIPT } from './lua-scripts';

/**
 * Which ended jobs a queue keeps, as BullMQ's KeepJobs (src/interfaces/keep-jobs.ts): those that ended at most `age`
 * seconds ago, and at most the `count` newest. When a job ends with this option, the ended jobs of its state that fall
 * outside it are removed (BullMQ moveToFinished-14.lua and includes/removeJobsByMaxAge.lua). The removal runs only when a
 * job ends, so a queue that goes quiet keeps its last jobs until `clean` runs.
 */
export interface KeepJobs {
  age?: number;
  count?: number;
}

/** `removeOnComplete` or `removeOnFail` as a KeepJobs: `true` keeps none, a number keeps that many, unset keeps all (BullMQ Scripts.getKeepJobs). */
export function keepJobsOf(remove: boolean | number | KeepJobs | undefined): KeepJobs {
  if (typeof remove === 'object') return remove;
  if (typeof remove === 'number') return { count: remove };
  return { count: remove ? 0 : -1 };
}

/** `data` as the stored copy of an ended job keeps it: without the keys of `removeDataOnFinish`. */
export function finishedData<T>(data: T, removeDataOnFinish: readonly string[] | undefined): T {
  if (!removeDataOnFinish?.length || typeof data !== 'object' || data === null) return data;
  return Object.fromEntries(Object.entries(data).filter(([key]) => !removeDataOnFinish.includes(key))) as T;
}

/** The `userId` of job data, or undefined. */
export function ownerOf(data: unknown): string | undefined {
  const userId = typeof data === 'object' && data !== null ? (data as { userId?: unknown }).userId : undefined;
  return typeof userId === 'string' && userId !== '' ? userId : undefined;
}

function parsedData(text: string | null): unknown {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

/** The keys of one Redis queue that the steps below read and write. */
export interface QueueKeySpace {
  jobKey(id: string): string;
  userJobsKey(userId: string | undefined): string;
  dlqKey: string;
  /** Waiting, delayed, active, completed, failed and cancelled, in this order. */
  stateKeys: readonly [string, string, string, string, string, string];
}

async function readEndedFields(
  client: Redis,
  keys: QueueKeySpace,
  ids: readonly string[]
): Promise<{ id: string; finishedOnRaw: string | null; dataRaw: string | null }[]> {
  if (ids.length === 0) return [];
  if (typeof client.pipeline === 'function') {
    const pipeline = client.pipeline();
    for (const id of ids) pipeline.hmget(keys.jobKey(id), 'finishedOn', 'data');
    const results = (await pipeline.exec()) ?? [];
    return ids.map((id, index) => {
      const [err, row] = results[index] ?? [];
      if (err) throw err;
      const [finishedOnRaw = null, dataRaw = null] = Array.isArray(row) ? (row as (string | null)[]) : [];
      return { id, finishedOnRaw, dataRaw };
    });
  }
  return Promise.all(
    ids.map(async (id) => {
      const [finishedOnRaw = null, dataRaw = null] = await client.hmget(keys.jobKey(id), 'finishedOn', 'data');
      return { id, finishedOnRaw, dataRaw };
    })
  );
}

/**
 * Removes up to `limit` jobs of the set `stateKey` that ended at or before `threshold`, with their entry in the index of
 * their user, and answers their ids; with `trimDeadLetters`, also the dead letters recorded by then (BullMQ Queue.clean).
 */
export async function removeEndedBefore(
  client: Redis,
  keys: QueueKeySpace,
  stateKey: string,
  threshold: number,
  limit: number,
  trimDeadLetters: boolean
): Promise<string[]> {
  const removed: string[] = [];
  if (limit > 0) {
    const ids = await client.smembers(stateKey);
    for (const { id, finishedOnRaw, dataRaw } of await readEndedFields(client, keys, ids)) {
      const jobKey = keys.jobKey(id);
      if (finishedOnRaw === null && dataRaw === null && (await client.exists(jobKey)) === 0) {
        await client.srem(stateKey, id);
        continue;
      }
      if (removed.length >= limit) continue;
      const finishedOn = Number(finishedOnRaw || 0);
      if (finishedOn <= 0 || finishedOn > threshold) continue;
      const userId = ownerOf(parsedData(dataRaw));
      await client.srem(stateKey, id);
      await client.del(jobKey);
      if (userId) await client.zrem(keys.userJobsKey(userId), id);
      removed.push(id);
    }
  }
  if (trimDeadLetters) await client.eval(TRIM_DEAD_LETTERS_LUA_SCRIPT, 1, keys.dlqKey, String(threshold));
  return removed;
}

/** Removes the jobs of the set `stateKey` beyond the `count` that ended last, with their entry in their user's index. */
export async function keepNewestEnded(client: Redis, keys: QueueKeySpace, stateKey: string, count: number): Promise<void> {
  const ids = await client.smembers(stateKey);
  if (ids.length <= count) return;
  const ended = (await readEndedFields(client, keys, ids)).map(({ id, finishedOnRaw, dataRaw }) => ({
    id,
    finishedOn: Number(finishedOnRaw || 0),
    userId: ownerOf(parsedData(dataRaw)),
  }));
  ended.sort((a, b) => b.finishedOn - a.finishedOn);
  for (const job of ended.slice(count)) {
    await client.srem(stateKey, job.id);
    await client.del(keys.jobKey(job.id));
    if (job.userId) await client.zrem(keys.userJobsKey(job.userId), job.id);
  }
}

/**
 * Drops the keys of `removeDataOnFinish` from the stored data of the ended job `id`. The stored data is read again rather
 * than taken from the attempt, whose copy the processor may have changed.
 */
export async function dropEndedData(client: Redis, keys: QueueKeySpace, id: string, removeDataOnFinish: readonly string[] | undefined): Promise<void> {
  if (!removeDataOnFinish?.length) return;
  const stored = parsedData(await client.hget(keys.jobKey(id), 'data'));
  if (typeof stored !== 'object' || stored === null || !removeDataOnFinish.some((key) => key in stored)) return;
  await client.eval(REPLACE_ENDED_JOB_DATA_LUA_SCRIPT, 1, keys.jobKey(id), JSON.stringify(finishedData(stored, removeDataOnFinish)));
}

/** Removes job `id` from every state and from its user's index unless it is active (BullMQ removeJob-2.lua); whether it did. */
export async function removeStoredJob(client: Redis, keys: QueueKeySpace, id: string, removeDlq: boolean = false): Promise<boolean> {
  const userJobsKey = keys.userJobsKey(ownerOf(parsedData(await client.hget(keys.jobKey(id), 'data'))));
  const scriptKeys = removeDlq
    ? [keys.jobKey(id), ...keys.stateKeys, userJobsKey, keys.dlqKey]
    : [keys.jobKey(id), ...keys.stateKeys, userJobsKey];
  return Number(await client.eval(REMOVE_JOB_LUA_SCRIPT, scriptKeys.length, ...scriptKeys, id)) === 1;
}
