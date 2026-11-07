/**
 * A verdict that is computed once at a time and reused for a few seconds, for the checks that spend real work (a readiness
 * probe set, the deploy's smoke conversion) and are polled by callers that must not multiply it.
 *
 * Callers that come while a run is going share it. The outcome of a run, a failure included, is reused for `ttlMs` after the
 * verdict settled. The run holds the place until its work has settled, which can be later than its verdict (a conversion that
 * ignores its deadline's abort): the next run does not start on top of work still going, so callers meanwhile get the verdict
 * the run already gave.
 */

/** A run: the verdict callers get, and the work behind it when that outlives the verdict. */
export interface VerdictRun<T> {
  verdict: Promise<T>;
  /** Settles when the work has ended, whatever the outcome; the verdict itself when absent. */
  settled?: Promise<unknown>;
}

export interface VerdictMemo<T> {
  /** The current verdict: a run in progress, one whose outcome is still fresh, or a new run. */
  get(): Promise<T>;
  /** Forgets the verdict, so the next call starts a run; for tests. */
  reset(): void;
}

interface Entry<T> {
  verdict: Promise<T>;
  working: boolean;
  expiresAt: number;
}

export function memoizeVerdict<T>(ttlMs: number, run: () => VerdictRun<T>): VerdictMemo<T> {
  let entry: Entry<T> | undefined;
  return {
    get() {
      if (entry && (entry.working || Date.now() < entry.expiresAt)) return entry.verdict;
      const { verdict, settled = verdict } = run();
      const current: Entry<T> = { verdict, working: true, expiresAt: Number.POSITIVE_INFINITY };
      const fresh = () => {
        current.expiresAt = Date.now() + ttlMs;
      };
      const done = () => {
        current.working = false;
      };
      verdict.then(fresh, fresh);
      settled.then(done, done);
      entry = current;
      return verdict;
    },
    reset() {
      entry = undefined;
    },
  };
}
