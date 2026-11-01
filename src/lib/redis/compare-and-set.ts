import crypto from 'node:crypto';

/**
 * The loop around a Redis compare-and-set: read a value, compute the next one, and write it only while the stored value
 * is still the one read. A refused write means another instance wrote in between, so the next attempt waits a random
 * time up to a base that doubles per attempt, which spreads racing writers out, and the loop gives up after a bound.
 */

/** The outcome of one attempt: what it wrote, or `conflict` when another writer changed the value since it was read. */
export type CompareAndSetAttempt<T> = { written: T } | 'conflict';

export interface CompareAndSetPolicy {
  maxAttempts: number;
  /** What is being updated, for the error after the last attempt, such as "The retention record". */
  subject: string;
}

const BACKOFF_BASE_MS = 2;
const BACKOFF_MAX_MS = 100;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `attempt` until it writes, waiting a random backoff after each conflict; throws after `policy.maxAttempts` conflicts. */
export async function compareAndSetWithRetry<T>(attempt: () => Promise<CompareAndSetAttempt<T>>, policy: CompareAndSetPolicy): Promise<T> {
  for (let tries = 0; tries < policy.maxAttempts; tries++) {
    const outcome = await attempt();
    if (outcome !== 'conflict') return outcome.written;
    await sleep(crypto.randomInt(Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** tries) + 1));
  }
  throw new Error(`${policy.subject} changed ${policy.maxAttempts} times while it was being updated`);
}
