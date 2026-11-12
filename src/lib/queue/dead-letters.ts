import type Redis from 'ioredis';
import type { DlqEntry } from './bullmq-engine';
import { ADD_DEAD_LETTER_LUA_SCRIPT, BACKFILL_DEAD_LETTER_INDEX_LUA_SCRIPT, PURGE_DEAD_LETTERS_LUA_SCRIPT } from './lua-scripts';

/**
 * The keys of the index of the dead-letter list, all derived from its key so they share its hash tag: a set of the raw letters of each
 * job (`jobPrefix + jobId`), a set of the ids of the jobs of each user that have a letter (`userPrefix + userId`), and the flag that
 * says the index covers every letter of the list, and a set of the letters that the Lua scripts cannot decode (`unparsed`: a lone
 * surrogate escape, nesting past a thousand levels), which the process reads and parses itself. Letters written before the index existed
 * are not in it, and an older build writes letters without it, so only `backfillDeadLetterIndex` sets the flag; a removal that must be
 * complete reads the whole list while the flag is absent.
 */
export interface DeadLetterKeys {
  jobPrefix: string;
  userPrefix: string;
  unparsed: string;
  coveredFlag: string;
}

export function deadLetterKeys(dlqKey: string): DeadLetterKeys {
  return { jobPrefix: `${dlqKey}:job:`, userPrefix: `${dlqKey}:user:`, unparsed: `${dlqKey}:unparsed`, coveredFlag: `${dlqKey}:indexed` };
}

/** The keys a dead-letter script takes after the list: the two prefixes and the set of undecodable letters. */
export function indexKeysOf(dlqKey: string): [string, string, string] {
  const keys = deadLetterKeys(dlqKey);
  return [keys.jobPrefix, keys.userPrefix, keys.unparsed];
}

/** Appends a letter (its JSON) to the dead-letter list and to its index in one step. */
export async function addDeadLetter(client: Redis, dlqKey: string, raw: string): Promise<void> {
  await client.eval(ADD_DEAD_LETTER_LUA_SCRIPT, 4, dlqKey, ...indexKeysOf(dlqKey), raw);
}

/** Empties the dead-letter list and its index; answers how many letters the list held. */
export async function purgeDeadLetters(client: Redis, dlqKey: string): Promise<number> {
  return Number(await client.eval(PURGE_DEAD_LETTERS_LUA_SCRIPT, 4, dlqKey, ...indexKeysOf(dlqKey)));
}

/** What `backfillDeadLetterIndex` found: the letters of the list, those it indexes (or would) by job, those only the process can read, and whether the index covered the list already. */
export interface DeadLetterBackfill {
  letters: number;
  indexable: number;
  unparsed: number;
  alreadyCovered: boolean;
  applied: boolean;
}

/**
 * Indexes the letters that are in the dead-letter list and not in its index (everything written before the index existed) and sets the
 * flag, in one step; without `apply` it only counts. Nothing runs it by itself, and nothing else sets the flag: until it runs, every
 * removal reads the whole list. Run it once every worker of an older build is gone, since such a worker writes letters without the index.
 */
export async function backfillDeadLetterIndex(client: Redis, dlqKey: string, apply: boolean): Promise<DeadLetterBackfill> {
  const [letters, indexable, covered, unparsed] = (await client.eval(
    BACKFILL_DEAD_LETTER_INDEX_LUA_SCRIPT,
    5,
    dlqKey,
    ...indexKeysOf(dlqKey),
    deadLetterKeys(dlqKey).coveredFlag,
    apply ? '1' : '0'
  )) as [number, number, number, number];
  return { letters: Number(letters), indexable: Number(indexable), unparsed: Number(unparsed), alreadyCovered: Number(covered) === 1, applied: apply && Number(covered) !== 1 };
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
