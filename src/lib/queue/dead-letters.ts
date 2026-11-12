import type Redis from 'ioredis';
import type { DlqEntry } from './bullmq-engine';
import {
  ADD_DEAD_LETTER_LUA_SCRIPT,
  MIGRATE_DEAD_LETTERS_LUA_SCRIPT,
  PURGE_DEAD_LETTERS_LUA_SCRIPT,
  TRIM_DEAD_LETTERS_LUA_SCRIPT,
} from './lua-scripts';
import { ownerOf } from './stored-job';

/**
 * The keys of the dead letters of a queue, all derived from the key of the list (`dlqKey`) so they share its hash tag. A letter is a hash
 * of its own under an id (`letterPrefix + id`: `raw`, and `job` and `user` when something can look it up), the ids are scored by the time of
 * the letter in a sorted set (`order`), and a set of ids per job (`byJobPrefix + jobId`) and per user (`byUserPrefix + userId`) finds the
 * letters to remove without reading the others (docs/policy-decisions.md, entry 265). The list at `dlqKey` is the store of the letters
 * written before that layout: it is read while it holds letters, and `migrateDeadLetters` empties it.
 */
export interface DeadLetterKeys {
  letterPrefix: string;
  byJobPrefix: string;
  byUserPrefix: string;
  order: string;
}

export function deadLetterKeys(dlqKey: string): DeadLetterKeys {
  return { letterPrefix: `${dlqKey}:letter:`, byJobPrefix: `${dlqKey}:by-job:`, byUserPrefix: `${dlqKey}:by-user:`, order: `${dlqKey}:order` };
}

/** The most letters one trim step removes and one migration step moves; a step is one Lua call, so it bounds how long Redis is held. */
const TRIM_STEP = 1000;
const MIGRATE_STEP = 500;
/** A page of the listing of the letters. */
const READ_PAGE = 500;

/** What a script needs to index a letter: its job id and its user ('' for none) and its time. A text that is not an object has none, and the time 0 (the oldest). */
interface LetterFields {
  jobId: string;
  userId: string;
  timestamp: number;
}

function fieldsOf(letter: unknown): LetterFields {
  if (typeof letter !== 'object' || letter === null) return { jobId: '', userId: '', timestamp: 0 };
  const { jobId, data, timestamp } = letter as { jobId?: unknown; data?: unknown; timestamp?: unknown };
  const time = typeof timestamp === 'string' ? Number(timestamp) : timestamp;
  return { jobId: typeof jobId === 'string' ? jobId : '', userId: ownerOf(data) ?? '', timestamp: typeof time === 'number' && Number.isFinite(time) ? time : 0 };
}

function parseLetter(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Stores a letter and indexes it in one step. */
export async function addDeadLetter(client: Redis, dlqKey: string, entry: DlqEntry): Promise<void> {
  const { jobId, userId, timestamp } = fieldsOf(entry);
  await client.eval(ADD_DEAD_LETTER_LUA_SCRIPT, 1, dlqKey, JSON.stringify(entry), String(timestamp), jobId, userId);
}

/** Removes every letter, of both layouts; answers how many there were. */
export async function purgeDeadLetters(client: Redis, dlqKey: string): Promise<number> {
  return Number(await client.eval(PURGE_DEAD_LETTERS_LUA_SCRIPT, 1, dlqKey));
}

/** Removes the letters recorded at or before `cutoff` (milliseconds), a bounded step at a time. */
export async function trimDeadLettersBefore(client: Redis, dlqKey: string, cutoff: number): Promise<void> {
  let removed: number;
  do removed = Number(await client.eval(TRIM_DEAD_LETTERS_LUA_SCRIPT, 1, dlqKey, String(cutoff), String(TRIM_STEP)));
  while (removed >= TRIM_STEP);
}

/** What `migrateDeadLetters` found in the list of the earlier layout, and how many letters it moved. */
export interface DeadLetterMigration {
  /** Letters in the list when the run began. */
  letters: number;
  /** Of those, the letters that a job or a user can find. */
  indexed: number;
  /** Letters that neither a job nor a user can find: they keep their time and age out. */
  unindexed: number;
  /** Letters that are not JSON: they are moved with the time 0, so the first trim after the move removes them, as it removed them in the list. */
  unreadable: number;
  moved: number;
  applied: boolean;
}

/**
 * Moves the letters of the list of the earlier layout to the new one, a bounded batch at a time, oldest first, and answers what it found.
 * Without `apply` it only counts. Each step takes the head of the list and moves what it still finds there (`MIGRATE_DEAD_LETTERS_LUA_SCRIPT`),
 * so a run that stops resumes where it stopped, a second run moves nothing, a letter that another process removes meanwhile is not moved,
 * and one that an older build appends meanwhile is moved by the next run. The letters are read and parsed here, so one that Lua cannot decode
 * is moved like any other. Run it once every worker of an older build is gone.
 */
export async function migrateDeadLetters(client: Redis, dlqKey: string, apply: boolean): Promise<DeadLetterMigration> {
  const found: DeadLetterMigration = { letters: await client.llen(dlqKey), indexed: 0, unindexed: 0, unreadable: 0, moved: 0, applied: apply };
  const count = (raws: readonly string[]): void => {
    for (const raw of raws) {
      const parsed = parseLetter(raw);
      const { jobId, userId } = fieldsOf(parsed);
      if (parsed === undefined) found.unreadable += 1;
      if (jobId === '' && userId === '') found.unindexed += 1;
      else found.indexed += 1;
    }
  };
  if (!apply) {
    for (let at = 0; at < found.letters; at += READ_PAGE) count(await client.lrange(dlqKey, at, at + READ_PAGE - 1));
    return found;
  }
  let idle = 0;
  for (;;) {
    const raws = await client.lrange(dlqKey, 0, MIGRATE_STEP - 1);
    if (raws.length === 0) return found;
    count(raws);
    const args = raws.flatMap((raw) => {
      const { jobId, userId, timestamp } = fieldsOf(parseLetter(raw));
      return [raw, String(timestamp), jobId, userId];
    });
    const moved = Number(await client.eval(MIGRATE_DEAD_LETTERS_LUA_SCRIPT, 1, dlqKey, ...args));
    found.moved += moved;
    // A whole batch that is not moved was removed by someone else, or is a text that does not come back from Redis as it went in.
    idle = moved === 0 ? idle + 1 : 0;
    if (idle === 3) throw new Error(`Dead letter migration stopped: ${raws.length} letters at the head of ${dlqKey} could not be moved.`);
  }
}

/** The letter of a text: a text that is not JSON comes back as a letter whose reason is the text. */
function entryOf<T>(raw: string): DlqEntry<T> {
  const parsed = parseLetter(raw);
  if (parsed !== undefined) return parsed as DlqEntry<T>;
  return { jobId: '', name: '', data: {} as T, failedReason: raw, attemptsMade: 0, timestamp: 0, stacktrace: [] };
}

/** The letters, oldest first: those of the list of the earlier layout, then the others by their time, a page of ids and one round trip for its letters at a time. */
export async function readDeadLetters<T>(client: Redis, dlqKey: string): Promise<DlqEntry<T>[]> {
  const { letterPrefix, order } = deadLetterKeys(dlqKey);
  const letters = (await client.lrange(dlqKey, 0, -1)).map((raw) => entryOf<T>(raw));
  for (let at = 0; ; at += READ_PAGE) {
    const ids = await client.zrange(order, String(at), String(at + READ_PAGE - 1));
    const read = client.pipeline();
    for (const id of ids) read.hget(`${letterPrefix}${id}`, 'raw');
    for (const [error, raw] of (await read.exec()) ?? []) {
      if (error) throw error;
      if (typeof raw === 'string') letters.push(entryOf<T>(raw));
    }
    if (ids.length < READ_PAGE) return letters;
  }
}
