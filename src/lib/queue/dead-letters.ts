import type Redis from 'ioredis';
import type { DlqEntry } from './bullmq-engine';
import { ADD_DEAD_LETTER_LUA_SCRIPT, BACKFILL_DEAD_LETTER_INDEX_LUA_SCRIPT, PURGE_DEAD_LETTERS_LUA_SCRIPT } from './lua-scripts';

/**
 * The keys of the index of the dead-letter list, all derived from its key so they share its hash tag: a set of the raw letters of each
 * job (`jobPrefix + jobId`), a set of the ids of the jobs of each user that have a letter (`userPrefix + userId`), and the flag that
 * says the index covers every letter of the list. Letters written before the index existed are not in it and the flag is not set until
 * `backfillDeadLetterIndex` runs (or the list is empty), so a removal that must be complete reads the list while the flag is absent.
 */
export interface DeadLetterKeys {
  jobPrefix: string;
  userPrefix: string;
  coveredFlag: string;
}

export function deadLetterKeys(dlqKey: string): DeadLetterKeys {
  return { jobPrefix: `${dlqKey}:job:`, userPrefix: `${dlqKey}:user:`, coveredFlag: `${dlqKey}:indexed` };
}

/** The keys a dead-letter script takes after the list: the two prefixes and the flag. */
export function indexKeysOf(dlqKey: string): [string, string, string] {
  const keys = deadLetterKeys(dlqKey);
  return [keys.jobPrefix, keys.userPrefix, keys.coveredFlag];
}

/** Appends a letter (its JSON) to the dead-letter list and to its index in one step. */
export async function addDeadLetter(client: Redis, dlqKey: string, raw: string): Promise<void> {
  await client.eval(ADD_DEAD_LETTER_LUA_SCRIPT, 4, dlqKey, ...indexKeysOf(dlqKey), raw);
}

/** Empties the dead-letter list and its index; answers how many letters the list held. */
export async function purgeDeadLetters(client: Redis, dlqKey: string): Promise<number> {
  return Number(await client.eval(PURGE_DEAD_LETTERS_LUA_SCRIPT, 4, dlqKey, ...indexKeysOf(dlqKey)));
}

/** What `backfillDeadLetterIndex` found: the letters of the list, those it indexes (or would), and whether the index covered the list already. */
export interface DeadLetterBackfill {
  letters: number;
  indexable: number;
  alreadyCovered: boolean;
  applied: boolean;
}

/**
 * Indexes the letters that are in the dead-letter list and not in its index (everything written before the index existed) and sets the
 * flag, in one step; without `apply` it only counts. Nothing runs it by itself: the index covers a list that was empty when the first
 * letter was added, and a list that holds older letters is read in full by every removal until this runs.
 */
export async function backfillDeadLetterIndex(client: Redis, dlqKey: string, apply: boolean): Promise<DeadLetterBackfill> {
  const [letters, indexable, covered] = (await client.eval(BACKFILL_DEAD_LETTER_INDEX_LUA_SCRIPT, 4, dlqKey, ...indexKeysOf(dlqKey), apply ? '1' : '0')) as [number, number, number];
  return { letters: Number(letters), indexable: Number(indexable), alreadyCovered: Number(covered) === 1, applied: apply && Number(covered) !== 1 };
}

/** The letters of the dead-letter list, oldest first; a letter that is not JSON comes back as a letter whose reason is its text. */
export async function readDeadLetters<T>(client: Redis, dlqKey: string): Promise<DlqEntry<T>[]> {
  return (await client.lrange(dlqKey, 0, -1)).map((raw) => {
    try {
      return JSON.parse(raw) as DlqEntry<T>;
    } catch {
      return { jobId: '', name: '', data: {} as T, failedReason: raw, attemptsMade: 0, timestamp: 0, stacktrace: [] };
    }
  });
}
