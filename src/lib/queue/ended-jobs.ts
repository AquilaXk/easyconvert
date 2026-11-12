import type Redis from 'ioredis';
import { pipelineReplies } from '../redis/pipeline-replies';
import { deadLetterKeys, trimDeadLettersBefore } from './dead-letters';
import { REMOVE_DEAD_LETTERS_LUA_SCRIPT, REMOVE_JOB_DEAD_LETTERS_LUA_SCRIPT, REMOVE_JOB_LUA_SCRIPT, REPLACE_ENDED_JOB_DATA_LUA_SCRIPT } from './lua-scripts';
import { ownerOf } from './stored-job';

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

function isFinishedBy(finishedOnRaw: string | null, threshold: number): boolean {
  const finishedOn = Number(finishedOnRaw || 0);
  return finishedOn > 0 && finishedOn <= threshold;
}

async function deleteEndedJob(
  client: Redis,
  keys: QueueKeySpace,
  stateKey: string,
  id: string,
  userId: string | undefined
): Promise<void> {
  await client.srem(stateKey, id);
  await client.del(keys.jobKey(id));
  if (userId) await client.zrem(keys.userJobsKey(userId), id);
}

/** The ids of the set one SSCAN call asks for, and so how many jobs are read in one pipeline. */
const ENDED_SCAN_COUNT = 500;

/** What a pass over the ended jobs of one state found: the ids it removed, and the finish time of the oldest job it left. */
export interface EndedScan {
  removed: string[];
  /**
   * When the oldest job that stays finished, or Infinity when none stays; undefined when the pass stopped at `limit` before it had
   * seen every job. No job of the state can have aged out before this time plus the age, so a caller may skip the passes until then.
   */
  oldestKeptFinishedOn: number | undefined;
}

async function removeSetEntriesBefore(
  client: Redis,
  keys: QueueKeySpace,
  stateKey: string,
  threshold: number,
  limit: number
): Promise<EndedScan> {
  const removed: string[] = [];
  let oldest = Number.POSITIVE_INFINITY;
  let cursor = '0';
  do {
    // The set is read a chunk at a time, so a long set is never held whole, and a pass that reaches `limit` stops there.
    const [next, scanned] = await client.sscan(stateKey, cursor, 'COUNT', String(ENDED_SCAN_COUNT));
    cursor = next;
    // SSCAN may name an id twice.
    for (const { id, finishedOnRaw, dataRaw } of await readEndedFields(client, keys, [...new Set(scanned)])) {
      if (finishedOnRaw === null && dataRaw === null && (await client.exists(keys.jobKey(id))) === 0) {
        await client.srem(stateKey, id);
      } else if (removed.length < limit && isFinishedBy(finishedOnRaw, threshold)) {
        await deleteEndedJob(client, keys, stateKey, id, ownerOf(parsedData(dataRaw)));
        removed.push(id);
      } else if (Number(finishedOnRaw) > 0) {
        oldest = Math.min(oldest, Number(finishedOnRaw));
      }
    }
    if (cursor !== '0' && removed.length >= limit) return { removed, oldestKeptFinishedOn: undefined };
  } while (cursor !== '0');
  return { removed, oldestKeptFinishedOn: oldest };
}

/**
 * Removes up to `limit` jobs of the set `stateKey` that ended at or before `threshold`, with their entry in the index of
 * their user, and answers them with the finish time of the oldest job left; with `trimDeadLetters`, also the dead letters
 * recorded by then (BullMQ Queue.clean).
 */
export async function scanEndedBefore(
  client: Redis,
  keys: QueueKeySpace,
  stateKey: string,
  threshold: number,
  limit: number,
  trimDeadLetters: boolean
): Promise<EndedScan> {
  const scan: EndedScan = limit > 0 ? await removeSetEntriesBefore(client, keys, stateKey, threshold, limit) : { removed: [], oldestKeptFinishedOn: undefined };
  if (trimDeadLetters) await trimDeadLettersBefore(client, keys.dlqKey, threshold);
  return scan;
}

/** `scanEndedBefore`, answering only the ids it removed. */
export async function removeEndedBefore(
  client: Redis,
  keys: QueueKeySpace,
  stateKey: string,
  threshold: number,
  limit: number,
  trimDeadLetters: boolean
): Promise<string[]> {
  return (await scanEndedBefore(client, keys, stateKey, threshold, limit, trimDeadLetters)).removed;
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
    await deleteEndedJob(client, keys, stateKey, job.id, job.userId);
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

/**
 * Removes job `id` from every state and from its user's index unless it is active (BullMQ removeJob-2.lua); whether it did. With `removeDlq`
 * it also removes the job's dead letters, by the ids in the set of the job (and from the list of the earlier layout while that holds letters).
 */
export async function removeStoredJob(client: Redis, keys: QueueKeySpace, id: string, removeDlq: boolean = false): Promise<boolean> {
  const userJobsKey = keys.userJobsKey(ownerOf(parsedData(await client.hget(keys.jobKey(id), 'data'))));
  const scriptKeys = removeDlq ? [keys.jobKey(id), ...keys.stateKeys, userJobsKey, keys.dlqKey] : [keys.jobKey(id), ...keys.stateKeys, userJobsKey];
  return Number(await client.eval(REMOVE_JOB_LUA_SCRIPT, scriptKeys.length, ...scriptKeys, id)) === 1;
}

/** The ids of one pipeline that `forgetUserJobs` sends: the jobs it reads or removes together, and the dead letters it checks or removes together. */
const FORGET_BATCH = 500;

/**
 * Removes the jobs of `ids` (a batch of `userId`'s index) that the caller processed, and drops the ids whose job is gone or is
 * another user's from the index. Answers the ids that stay in the index, in index order, and the ids of the jobs whose dead letters the
 * job script clears: a job that is not active (the script answers 1 for it) and one it does not know (it answers 0, like an active one).
 */
async function removeProcessedJobs(
  client: Redis,
  keys: QueueKeySpace,
  userId: string,
  ids: readonly string[],
  processed: ReadonlySet<string>
): Promise<{ left: string[]; cleared: string[] }> {
  const index = keys.userJobsKey(userId);
  const read = client.pipeline();
  for (const id of ids) read.hmget(keys.jobKey(id), 'data', 'state');
  const rows = (await pipelineReplies(read)) as [string | null, string | null][];
  const foreign: string[] = [];
  const staying = new Set<string>();
  const toRemove: { id: string; unknownState: boolean }[] = [];
  ids.forEach((id, at) => {
    if (ownerOf(parsedData(rows[at][0])) !== userId) foreign.push(id);
    else if (processed.has(id)) toRemove.push({ id, unknownState: rows[at][1] === null });
    else staying.add(id);
  });
  const removal = client.pipeline();
  if (foreign.length > 0) removal.zrem(index, ...foreign);
  for (const { id } of toRemove) removal.eval(REMOVE_JOB_LUA_SCRIPT, keys.stateKeys.length + 2, keys.jobKey(id), ...keys.stateKeys, index, id);
  const answers = (await pipelineReplies(removal)).slice(foreign.length > 0 ? 1 : 0);
  const cleared: string[] = [];
  toRemove.forEach(({ id, unknownState }, at) => {
    if (Number(answers[at]) === 1 || unknownState) cleared.push(id);
    if (Number(answers[at]) !== 1) staying.add(id);
  });
  return { left: ids.filter((id) => staying.has(id)), cleared };
}

/**
 * Removes the jobs of `userId` in the queue that `keys` names that the caller has processed (cancelled and listed: `processed`), with
 * their dead letters, and the dead letters of jobs that are gone already (a letter carries the user id in its data). An id of the
 * index whose job is gone, or whose data names another user (a damaged index), only leaves the index. A job that is not in
 * `processed` (beyond the caller's window, or queued since) is left whole, and so is a processed job that is still active: their ids are
 * answered, and the index stays while any is left.
 *
 * The jobs are read and removed a batch at a time (two round trips per batch). The job script is not given the dead-letter key: the
 * letters go in the one pass below, which reads the letters of the user by the set of their ids, removes those of the removed jobs by the
 * sets of their jobs, and reads the list of the earlier layout in one command, not in pages, while it holds letters (a page walk is not
 * atomic, so a letter could be skipped when another run trims or removes letters between two pages, and an erasure must not leave one).
 */
export async function forgetUserJobs(client: Redis, keys: QueueKeySpace, userId: string, processed: ReadonlySet<string>): Promise<string[]> {
  const index = keys.userJobsKey(userId);
  const left: string[] = [];
  const clearedJobIds = new Set<string>();
  const ids = await client.zrange(index, '0', '-1');
  for (let at = 0; at < ids.length; at += FORGET_BATCH) {
    const batch = await removeProcessedJobs(client, keys, userId, ids.slice(at, at + FORGET_BATCH), processed);
    left.push(...batch.left);
    for (const id of batch.cleared) clearedJobIds.add(id);
  }
  await removeDeadLetters(client, keys, userId, processed, clearedJobIds);
  if (left.length === 0) await client.del(index);
  return left;
}

/** A letter that an erasure looks at: how to remove it (its id, or its text when it is in the list of the earlier layout), its job, and whether it names the user. */
interface DeadLetterCandidate {
  ref: string;
  jobId: string;
  owned: boolean;
}

/**
 * The references among `candidates` that go: the letters of a cleared job (the job was removed by this run), the letters of `userId` for a
 * job in `processed`, and the letters of `userId` for a job that is gone.
 */
async function doomedLetters(
  client: Redis,
  keys: QueueKeySpace,
  processed: ReadonlySet<string>,
  clearedJobIds: ReadonlySet<string>,
  candidates: readonly DeadLetterCandidate[]
): Promise<string[]> {
  const doomed = new Set<string>();
  const unsure: DeadLetterCandidate[] = [];
  for (const candidate of candidates) {
    if (clearedJobIds.has(candidate.jobId) || (candidate.owned && processed.has(candidate.jobId))) doomed.add(candidate.ref);
    else if (candidate.owned) unsure.push(candidate);
  }
  for (let at = 0; at < unsure.length; at += FORGET_BATCH) {
    const batch = unsure.slice(at, at + FORGET_BATCH);
    const check = client.pipeline();
    for (const { jobId } of batch) check.exists(keys.jobKey(jobId));
    const exists = await pipelineReplies(check);
    batch.forEach(({ ref }, position) => {
      if (Number(exists[position]) === 0) doomed.add(ref);
    });
  }
  return [...doomed];
}

/** Removes from the list of the earlier layout the letters that `doomedLetters` picks; a no-op once the migration has emptied the list. */
async function removeListedLetters(client: Redis, keys: QueueKeySpace, userId: string, processed: ReadonlySet<string>, clearedJobIds: ReadonlySet<string>): Promise<void> {
  if ((await client.llen(keys.dlqKey)) === 0) return;
  const candidates = (await client.lrange(keys.dlqKey, 0, -1)).map((raw) => {
    const letter = parsedData(raw) as { jobId?: string; data?: unknown } | undefined;
    return { ref: raw, jobId: letter?.jobId ?? '', owned: ownerOf(letter?.data) === userId };
  });
  const doomed = await doomedLetters(client, keys, processed, clearedJobIds, candidates);
  for (let at = 0; at < doomed.length; at += FORGET_BATCH) {
    const removal = client.pipeline();
    for (const raw of doomed.slice(at, at + FORGET_BATCH)) removal.lrem(keys.dlqKey, 0, raw);
    await pipelineReplies(removal);
  }
}

/**
 * Removes the letters of the cleared jobs (by the set of each job), and those of `userId` that `doomedLetters` picks (by the set of the
 * user's letters, whose job is a field of the letter hash: no letter is read). An id of the user's set whose letter is gone leaves the set
 * and the order set.
 */
async function removeIndexedLetters(client: Redis, keys: QueueKeySpace, userId: string, processed: ReadonlySet<string>, clearedJobIds: ReadonlySet<string>): Promise<void> {
  const { letterPrefix, byUserPrefix } = deadLetterKeys(keys.dlqKey);
  const userKey = `${byUserPrefix}${userId}`;
  const cleared = [...clearedJobIds];
  for (let at = 0; at < cleared.length; at += FORGET_BATCH) {
    await client.eval(REMOVE_JOB_DEAD_LETTERS_LUA_SCRIPT, 1, keys.dlqKey, ...cleared.slice(at, at + FORGET_BATCH));
  }
  const ids = await client.smembers(userKey);
  const candidates: DeadLetterCandidate[] = [];
  const stale: string[] = [];
  for (let at = 0; at < ids.length; at += FORGET_BATCH) {
    const batch = ids.slice(at, at + FORGET_BATCH);
    const read = client.pipeline();
    for (const id of batch) read.hget(`${letterPrefix}${id}`, 'job');
    const jobIds = (await pipelineReplies(read)) as (string | null)[];
    batch.forEach((id, position) => {
      const jobId = jobIds[position];
      if (jobId === null) stale.push(id);
      else candidates.push({ ref: id, jobId, owned: true });
    });
  }
  const gone = [...stale, ...(await doomedLetters(client, keys, processed, clearedJobIds, candidates))];
  for (let at = 0; at < gone.length; at += FORGET_BATCH) {
    const batch = gone.slice(at, at + FORGET_BATCH);
    await client.eval(REMOVE_DEAD_LETTERS_LUA_SCRIPT, 1, keys.dlqKey, ...batch);
    await client.srem(userKey, ...batch);
  }
}

/**
 * Removes from the dead letters those of the jobs in `clearedJobIds`, those of `userId` for a job in `processed`, and those of `userId`
 * for a job that is gone. The list of the earlier layout goes first, then the indexed letters: the migration moves a letter from the list
 * to the index in one step and never back, so a letter is in the list when the first pass reads it or in the index when the second does,
 * whichever of the two it is in when a migration runs alongside.
 */
async function removeDeadLetters(client: Redis, keys: QueueKeySpace, userId: string, processed: ReadonlySet<string>, clearedJobIds: ReadonlySet<string>): Promise<void> {
  await removeListedLetters(client, keys, userId, processed, clearedJobIds);
  await removeIndexedLetters(client, keys, userId, processed, clearedJobIds);
}

/**
 * Removes the jobs of one ended state that are past their age, but only when one can have aged out: a pass reads the whole set, so
 * one at every job end would read it again for each job (quadratic over a busy queue). A pass records when its oldest job ages out and
 * none runs before then (a job ends when it finishes, so the one that ends now ages out last, except one that reports an earlier
 * `finishedOn`, which moves the time up). The dead letters are trimmed at every end: they are written apart from the job.
 */
export class AgedEndedRemoval {
  private readonly dueAt = new Map<string, number>();

  async run(client: Redis, keys: QueueKeySpace, stateKey: string, state: 'completed' | 'failed', graceMs: number, finishedOn: number | undefined): Promise<void> {
    const memo = `${state}:${graceMs}`;
    const now = Date.now();
    const recorded = this.dueAt.get(memo);
    const due = recorded !== undefined && finishedOn !== undefined ? Math.min(recorded, finishedOn + graceMs) : recorded;
    if (due !== undefined && now < due) {
      this.dueAt.set(memo, due);
      if (state === 'failed') await scanEndedBefore(client, keys, stateKey, now - graceMs, 0, true);
      return;
    }
    const { oldestKeptFinishedOn } = await scanEndedBefore(client, keys, stateKey, now - graceMs, Number.POSITIVE_INFINITY, state === 'failed');
    if (oldestKeptFinishedOn === undefined) this.dueAt.delete(memo);
    else this.dueAt.set(memo, Math.min(oldestKeptFinishedOn, now) + graceMs);
  }
}
