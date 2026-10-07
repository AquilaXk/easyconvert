/**
 * Running the two passes of a rate-controlled encode under one time budget. The process runner is passed
 * in, so the in-process engine and the worker each use their own sandbox and job directory.
 */

/** Prefix of the pass log files; they are written in the job's working directory, which the caller removes. */
export const TWO_PASS_LOG_PREFIX = 'ffpass';
/** Two passes cost about twice one encode, so the job's timeout budget is doubled and shared by both. */
export const TWO_PASS_TIMEOUT_FACTOR = 2;
/** The second pass is never given less than this, so a spent budget fails it by timeout instead of by a zero limit. */
export const MIN_PASS_TIMEOUT_MS = 1000;

export function twoPassBudgetMs(timeoutMs: number): number {
  return timeoutMs * TWO_PASS_TIMEOUT_FACTOR;
}

/** Runs ffmpeg with `args`, allowed `timeoutMs` to finish. */
export type PassRunner = (args: string[], timeoutMs: number) => Promise<unknown>;

/**
 * Runs the analysing pass and then the encode. The first gets the whole budget; the second gets what is left.
 * A failure in either pass propagates and the second never runs after a failed first.
 */
export async function runTwoPass(
  passes: readonly [string[], string[]],
  budgetMs: number,
  run: PassRunner,
  now: () => number = Date.now
): Promise<void> {
  const started = now();
  await run(passes[0], budgetMs);
  const remaining = Math.max(MIN_PASS_TIMEOUT_MS, budgetMs - (now() - started));
  await run(passes[1], remaining);
}
