import { PAGE_LOOP_STAGE, pagedStageTimeoutMs, type JobDeadlined } from '../lib/conversions/job-time';
import { SandboxedTimeoutError } from './sandbox';

/** The time a loop over the pages of a document has left, as the loop's tasks ask for it before each page. */
export interface PageLoopBudget {
  /** The limit for the next process of the loop: the time the loop has left, held to `processMs`. Throws once the loop's limit has passed. */
  remainingMs(): number;
}

/**
 * The budget of a loop over `pages` pages that starts now: the limit the pages give it (`pagedStageTimeoutMs`) as a whole, and `processMs`,
 * the stage limit, for each process in it, so the sandbox limit of one process does not grow with the document.
 */
export function pageLoopBudget(options: ({ timeoutMs?: number } & JobDeadlined) | undefined, pages: number, processMs: number): PageLoopBudget {
  const limitMs = pagedStageTimeoutMs(options, pages, PAGE_LOOP_STAGE);
  const deadline = Date.now() + limitMs;
  return {
    remainingMs() {
      const left = deadline - Date.now();
      if (left <= 0) throw new SandboxedTimeoutError(limitMs);
      return Math.min(left, processMs);
    },
  };
}
